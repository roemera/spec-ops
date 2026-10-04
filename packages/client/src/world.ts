import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FOG_FAR, FOG_NEAR, SHADOW_RANGE, SURFACE, type GameMap, type MapObject, type Weather, makeRng } from '@spec-ops/shared';
import { PAL, flatShared } from './render/palette';

const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.3).normalize();
const SHADOW_MAP = 2048;
const CHUNK = 80; // m: trees are instanced per square of this size, so off-screen squares are skipped
const SMOKE_PUFFS = 24;
const SMOKE_RISE = 4.5; // m/s: a column about 70 m tall, over the treetops from across the valley
const SMOKE_LIFE = 15; // s per puff

// Unit shapes, base at y = 0, scaled per instance.
const TRUNK = new THREE.CylinderGeometry(0.6, 1, 1, 6).translate(0, 0.5, 0);
const CONE = new THREE.ConeGeometry(1, 1, 7).translate(0, 0.5, 0);
const PUFF = new THREE.IcosahedronGeometry(1, 1);

interface TreeChunk {
  trunks: THREE.Matrix4[];
  cones: THREE.Matrix4[];
}

/** Builds the generated map into a Three.js scene and a Rapier world. */
export class World {
  readonly scene = new THREE.Scene();
  private sun: THREE.DirectionalLight;
  private chunks = new Map<string, TreeChunk>();
  private smoke: Array<{ mesh: THREE.Mesh; mat: THREE.MeshLambertMaterial; age: number }> = [];
  private smokeBase = new THREE.Vector3();

  constructor(readonly map: GameMap, readonly physics: RAPIER.World, weather: Weather) {
    this.scene.background = new THREE.Color(PAL.horizon);
    // Heavy snow closes the fog in (the enemy's view range shrinks by the same factor).
    this.scene.fog = new THREE.Fog(PAL.horizon, FOG_NEAR * weather.visibility, FOG_FAR * weather.visibility);
    this.scene.add(new THREE.HemisphereLight(0xffffff, PAL.snowShade, 1.5));
    this.sun = new THREE.DirectionalLight(0xfffaf0, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -SHADOW_RANGE;
    cam.right = cam.top = SHADOW_RANGE;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 3; // soft edges
    this.scene.add(this.sun, this.sun.target);

    this.buildSky();
    this.buildTerrain();
    this.buildBounds();
    for (const o of map.objects) this.buildObject(o);
    this.buildTrees();
  }

  /** A big dome with a vertical gradient: pale at the horizon (where the fog is), bluer overhead. */
  private buildSky() {
    const geo = new THREE.SphereGeometry(900, 24, 12);
    const top = new THREE.Color(PAL.skyTop), bottom = new THREE.Color(PAL.horizon), c = new THREE.Color();
    const p = geo.attributes.position, col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const k = Math.max(0, p.getY(i) / 900) ** 0.6;
      c.copy(bottom).lerp(top, k);
      col.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    sky.onBeforeRender = (_r, _s, camera) => sky.position.copy(camera.position);
    this.scene.add(sky);
  }

  /** One colour per triangle: snow, bare rock where it's steep, ice on the creek. */
  private buildTerrain() {
    const { cells, size, heights, surface } = this.map;
    const n = cells + 1, step = size / cells, half = size / 2;
    const pos = new Float32Array(cells * cells * 6 * 3), col = new Float32Array(cells * cells * 6 * 3);
    const colors = { snow: new THREE.Color(PAL.snow), rock: new THREE.Color(PAL.cliff), ice: new THREE.Color(PAL.ice) };
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3();
    const vtx = (i: number, out: THREE.Vector3) => out.set(-half + (i % n) * step, heights[i], -half + Math.floor(i / n) * step);
    let k = 0;
    const tri = (i0: number, i1: number, i2: number) => {
      vtx(i0, a);
      vtx(i1, b);
      vtx(i2, c);
      const ny = Math.abs(ab.subVectors(b, a).cross(ac.subVectors(c, a)).normalize().y);
      const ice = [i0, i1, i2].filter((i) => surface[i] === SURFACE.ice).length >= 2;
      const color = ice ? colors.ice : ny < 0.8 ? colors.rock : colors.snow;
      for (const v of [a, b, c]) {
        pos.set([v.x, v.y, v.z], k * 3);
        col.set([color.r, color.g, color.b], k * 3);
        k++;
      }
    };
    for (let iz = 0; iz < cells; iz++) {
      for (let ix = 0; ix < cells; ix++) {
        const i = iz * n + ix;
        tri(i, i + n, i + 1);
        tri(i + 1, i + n, i + n + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Rapier wants column-major heights: index = iz + ix * n.
    const colMajor = new Float32Array(n * n);
    for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) colMajor[iz + ix * n] = heights[iz * n + ix];
    this.physics.createCollider(
      RAPIER.ColliderDesc.heightfield(cells, cells, colMajor, { x: size, y: 1, z: size }).setFriction(0.8),
    );
  }

  private buildBounds() {
    const half = this.map.size / 2;
    for (const [x, z, hx, hz] of [
      [0, -half, half, 2],
      [0, half, half, 2],
      [-half, 0, 2, half],
      [half, 0, 2, half],
    ]) {
      this.physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, 300, hz).setTranslation(x, 0, z));
    }
  }

  /** A fixed collider, placed in the object's frame (local offset, turned with the object). */
  private solid(o: MapObject, desc: RAPIER.ColliderDesc, local = new THREE.Vector3(), extra?: THREE.Quaternion) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), o.rotY);
    const p = local.clone().applyQuaternion(q).add(new THREE.Vector3(o.x, o.y, o.z));
    if (extra) q.multiply(extra);
    this.physics.createCollider(desc.setTranslation(p.x, p.y, p.z).setRotation(q));
  }

  private buildObject(o: MapObject) {
    const [w, h, d] = o.size;
    if (o.kind === 'tree' || o.kind === 'deadTree') return this.addTree(o);
    const group = new THREE.Group();
    group.position.set(o.x, o.y, o.z);
    group.rotation.y = o.rotY;
    const mesh = (geo: THREE.BufferGeometry, color: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, flatShared(color));
      m.position.set(x, y, z);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
      return m;
    };
    const box = (bw: number, bh: number, bd: number, color: number, x: number, y: number, z: number, collide = true) => {
      mesh(new THREE.BoxGeometry(bw, bh, bd), color, x, y, z);
      if (collide) this.solid(o, RAPIER.ColliderDesc.cuboid(bw / 2, bh / 2, bd / 2), new THREE.Vector3(x, y, z));
    };

    switch (o.kind) {
      case 'rock': {
        const geo = new THREE.IcosahedronGeometry(1, 0);
        const rng = makeRng(o.id + 1000);
        const p = geo.attributes.position;
        for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * rng.range(0.7, 1.2), p.getY(i) * rng.range(0.7, 1.2), p.getZ(i) * rng.range(0.7, 1.2));
        geo.scale(w / 2, h / 2, d / 2);
        geo.computeVertexNormals();
        mesh(geo, PAL.rock, 0, h * 0.25, 0); // half buried
        this.solid(o, RAPIER.ColliderDesc.convexHull(geo.attributes.position.array as Float32Array)!, new THREE.Vector3(0, h * 0.25, 0));
        break;
      }
      case 'log': {
        // Lying along local x, a little sunk into the snow.
        const r = h / 2;
        mesh(new THREE.CylinderGeometry(r, r * 1.1, w, 7).rotateZ(Math.PI / 2), PAL.trunk, 0, r * 0.8, 0);
        const lying = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
        this.solid(o, RAPIER.ColliderDesc.cylinder(w / 2, r), new THREE.Vector3(0, r * 0.8, 0), lying);
        break;
      }
      case 'cabin': {
        box(w, h, d, PAL.wall, 0, h / 2, 0);
        // Pitched roof: a stretched triangular prism, dark so it reads against the snow.
        const roof = new THREE.CylinderGeometry(1, 1, d + 0.8, 3, 1).rotateX(-Math.PI / 2); // apex up
        roof.scale((w + 0.8) / 1.73, h * 0.45, 1);
        mesh(roof, PAL.roof, 0, h + h * 0.22, 0);
        box(1.1, 2.1, 0.1, PAL.roof, w * 0.2, 1.05, -d / 2 - 0.05, false); // door
        for (const sx of [-1, 1]) box(0.1, 0.9, 1.2, PAL.roof, (sx * w) / 2 + sx * 0.05, h * 0.6, 0, false); // windows
        break;
      }
      case 'tower': {
        // Four legs, a platform with a low rail, a little roof on posts.
        const leg = w / 2 - 0.2;
        for (const [lx, lz] of [[-leg, -leg], [leg, -leg], [-leg, leg], [leg, leg]]) {
          box(0.25, h, 0.25, PAL.fence, lx, h / 2, lz);
          box(0.15, 2.2, 0.15, PAL.fence, lx, h + 1.1, lz, false);
        }
        box(w, 0.3, w, PAL.fence, 0, h, 0);
        for (const s of [-1, 1]) {
          box(w, 1, 0.1, PAL.wall, 0, h + 0.65, (s * w) / 2);
          box(0.1, 1, w, PAL.wall, (s * w) / 2, h + 0.65, 0);
        }
        mesh(new THREE.ConeGeometry(w * 0.8, 1.4, 4).rotateY(Math.PI / 4), PAL.roof, 0, h + 2.9, 0);
        break;
      }
      case 'wall': {
        // Sandbags: a row of fat rounded bags with a second row on top, offset by half a bag.
        const bags = Math.max(2, Math.round(w / 0.7)), bw = w / bags, r = h * 0.22;
        const bag = new THREE.CapsuleGeometry(r, Math.max(0.05, bw - r * 2), 2, 6).rotateZ(Math.PI / 2).scale(1, 1, d / (r * 2));
        for (let i = 0; i < bags; i++) mesh(bag, PAL.wall, -w / 2 + bw * (i + 0.5), r, 0);
        for (let i = 0; i < bags - 1; i++) mesh(bag, PAL.wall, -w / 2 + bw * (i + 1), r * 3, 0);
        this.solid(o, RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2), new THREE.Vector3(0, h / 2, 0));
        break;
      }
      case 'pad': {
        // Extraction: a dark landing pad with a white H, and orange smoke rising off it.
        box(w, h, d, PAL.roof, 0, h / 2, 0);
        box(0.8, 0.05, 4.5, PAL.snow, -1.4, h + 0.02, 0, false);
        box(0.8, 0.05, 4.5, PAL.snow, 1.4, h + 0.02, 0, false);
        box(2.0, 0.05, 0.8, PAL.snow, 0, h + 0.02, 0, false);
        box(0.3, 0.5, 0.3, PAL.gun, w / 2 - 1, h + 0.25, d / 2 - 1, false); // the smoke grenade
        this.smokeBase.set(w / 2 - 1, h + 0.5, d / 2 - 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), o.rotY).add(new THREE.Vector3(o.x, o.y, o.z));
        for (let i = 0; i < SMOKE_PUFFS; i++) {
          // No fog on the smoke: it is how you find the pad from across the valley.
          const mat = new THREE.MeshLambertMaterial({ color: PAL.signal, flatShading: true, transparent: true, depthWrite: false, fog: false });
          const m = new THREE.Mesh(PUFF, mat);
          this.scene.add(m);
          this.smoke.push({ mesh: m, mat, age: (i / SMOKE_PUFFS) * SMOKE_LIFE });
        }
        break;
      }
    }
    this.scene.add(group);
  }

  /** Trees go into per-chunk instance lists (drawn in buildTrees); their colliders are made now. */
  private addTree(o: MapObject) {
    const [w, h] = o.size;
    const key = `${Math.floor(o.x / CHUNK)},${Math.floor(o.z / CHUNK)}`;
    let chunk = this.chunks.get(key);
    if (!chunk) this.chunks.set(key, (chunk = { trunks: [], cones: [] }));
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), o.rotY);
    const m = (y: number, sxz: number, sy: number) =>
      new THREE.Matrix4().compose(new THREE.Vector3(o.x, o.y + y, o.z), q, new THREE.Vector3(sxz, sy, sxz));
    if (o.kind === 'deadTree') {
      chunk.trunks.push(m(-0.3, 0.22, h + 0.3));
      this.physics.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, 0.25).setTranslation(o.x, o.y + h / 2, o.z));
      return;
    }
    // Bare trunk up to about a third of the height: you can see (and shoot) under the branches.
    chunk.trunks.push(m(-0.3, 0.28, h * 0.45 + 0.3)); // sunk a little so slopes don't show a gap
    for (let i = 0; i < 3; i++) chunk.cones.push(m(h * (0.36 + i * 0.19), w * (1 - i * 0.27), h * 0.4));
    this.physics.createCollider(RAPIER.ColliderDesc.cylinder(h / 2, 0.35).setTranslation(o.x, o.y + h / 2, o.z));
  }

  private buildTrees() {
    const add = (geo: THREE.BufferGeometry, color: number, list: THREE.Matrix4[]) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, flatShared(color), list.length);
      list.forEach((mat, i) => im.setMatrixAt(i, mat));
      im.castShadow = im.receiveShadow = true;
      im.computeBoundingSphere();
      this.scene.add(im);
    };
    for (const c of this.chunks.values()) {
      add(TRUNK, PAL.trunk, c.trunks);
      add(CONE, PAL.pine, c.cones);
    }
  }

  /** `wind` (m/s) bends the extraction smoke over: another way to read it. */
  update(dt: number, wind: { x: number; z: number }) {
    for (const s of this.smoke) {
      s.age = (s.age + dt) % SMOKE_LIFE;
      const k = s.age / SMOKE_LIFE;
      // Rises, swells and leans further downwind the older it gets.
      s.mesh.position.copy(this.smokeBase).add(new THREE.Vector3(wind.x * s.age * k, s.age * SMOKE_RISE, wind.z * s.age * k));
      s.mesh.scale.setScalar(0.6 + k * 7);
      s.mesh.rotation.set(s.age * 0.3, s.age * 0.2, 0);
      s.mat.opacity = 0.85 * Math.min(1, s.age * 3) * (1 - k);
    }
  }

  /** Keep the sharp-shadow area centred on the viewer, snapped to shadow texels so edges don't crawl. */
  followShadow(center: THREE.Vector3) {
    const texel = (SHADOW_RANGE * 2) / SHADOW_MAP;
    const c = center.clone();
    c.x = Math.round(c.x / texel) * texel;
    c.z = Math.round(c.z / texel) * texel;
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(SUN_DIR, 200);
  }
}
