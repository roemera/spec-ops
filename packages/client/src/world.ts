import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FOG_FAR, FOG_NEAR, SHADOW_RANGE, SURFACE, type GameMap, type MapObject, type Rng, type Weather, makeRng } from '@spec-ops/shared';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { PAL } from './render/palette';
import { boxUV, textures } from './render/textures';
import { mergeWorld } from './render/merge';

const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.3).normalize();
const SHADOW_MAP = 2048;
const CHUNK = 80; // m: trees are instanced per square of this size, so off-screen squares are skipped
const SMOKE_PUFFS = 24;
const SMOKE_RISE = 4.5; // m/s: a column about 70 m tall, over the treetops from across the valley
const SMOKE_LIFE = 15; // s per puff

// Unit shapes, base at y = 0, scaled per instance.
const TRUNK = new THREE.CylinderGeometry(0.6, 1, 1, 8).translate(0, 0.5, 0);
const CONE = new THREE.ConeGeometry(1, 1, 10).translate(0, 0.5, 0);
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
  private props: THREE.Group[] = [];

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
    this.mergeProps();
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

  /**
   * Snow, bare rock where it's steep, ice on the creek: one textured mesh each. Lighting is smooth
   * across the ground (normals from the height grid), the texture is projected per triangle along
   * its steepest axis so cliffs don't smear.
   */
  private buildTerrain() {
    const { cells, size, heights, surface } = this.map;
    const n = cells + 1, step = size / cells, half = size / 2;
    const tex = textures();
    // Smooth vertex normals straight from the grid.
    const vn = new Float32Array(n * n * 3);
    const h = (ix: number, iz: number) => heights[Math.min(n - 1, Math.max(0, iz)) * n + Math.min(n - 1, Math.max(0, ix))];
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const nx = h(ix - 1, iz) - h(ix + 1, iz), nz = h(ix, iz - 1) - h(ix, iz + 1), ny = 2 * step;
        const l = Math.hypot(nx, ny, nz), i = (iz * n + ix) * 3;
        vn[i] = nx / l;
        vn[i + 1] = ny / l;
        vn[i + 2] = nz / l;
      }
    }
    const kinds = {
      snow: { pos: [] as number[], nrm: [] as number[], uv: [] as number[], tile: 7, map: tex.snow, color: PAL.snow },
      rock: { pos: [] as number[], nrm: [] as number[], uv: [] as number[], tile: 6, map: tex.rock, color: PAL.cliff },
      ice: { pos: [] as number[], nrm: [] as number[], uv: [] as number[], tile: 14, map: tex.snow, color: PAL.ice },
    };
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const ab = new THREE.Vector3(), ac = new THREE.Vector3(), fn = new THREE.Vector3();
    const vtx = (i: number, out: THREE.Vector3) => out.set(-half + (i % n) * step, heights[i], -half + Math.floor(i / n) * step);
    const tri = (i0: number, i1: number, i2: number) => {
      vtx(i0, a);
      vtx(i1, b);
      vtx(i2, c);
      fn.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a)).normalize();
      const ice = [i0, i1, i2].filter((i) => surface[i] === SURFACE.ice).length >= 2;
      const k = ice ? kinds.ice : Math.abs(fn.y) < 0.8 ? kinds.rock : kinds.snow;
      // Project along the face's main axis: ground from above, cliffs from the side.
      const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
      for (const [v, i] of [[a, i0], [b, i1], [c, i2]] as const) {
        k.pos.push(v.x, v.y, v.z);
        k.nrm.push(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]);
        const [u, w] = ay >= ax && ay >= az ? [v.x, v.z] : ax >= az ? [v.z, v.y] : [v.x, v.y];
        k.uv.push(u / k.tile, w / k.tile);
      }
    };
    for (let iz = 0; iz < cells; iz++) {
      for (let ix = 0; ix < cells; ix++) {
        const i = iz * n + ix;
        tri(i, i + n, i + 1);
        tri(i + 1, i + n, i + n + 1);
      }
    }
    for (const k of Object.values(kinds)) {
      if (!k.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(k.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(k.nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(k.uv, 2));
      const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: k.color, map: k.map }));
      ground.receiveShadow = true;
      this.scene.add(ground);
    }

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

  /** A shared textured material per (texture, colour), for the props. */
  private mats = new Map<string, THREE.MeshLambertMaterial>();
  private mat(name: keyof ReturnType<typeof textures> | null, color: number, extra: THREE.MeshLambertMaterialParameters = {}) {
    const key = `${name}:${color}:${JSON.stringify(Object.keys(extra))}`;
    let m = this.mats.get(key);
    if (!m) this.mats.set(key, (m = new THREE.MeshLambertMaterial({ color, map: name ? textures()[name] : null, ...extra })));
    return m;
  }

  private buildObject(o: MapObject) {
    const [w, h, d] = o.size;
    if (o.kind === 'tree' || o.kind === 'deadTree') return this.addTree(o);
    const group = new THREE.Group();
    group.position.set(o.x, o.y, o.z);
    group.rotation.y = o.rotY;
    const mesh = (geo: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(geo, material);
      m.position.set(x, y, z);
      m.castShadow = m.receiveShadow = true;
      group.add(m);
      return m;
    };
    /** A textured box (texture `tile` m per repeat), optionally solid. */
    const box = (bw: number, bh: number, bd: number, material: THREE.Material, x: number, y: number, z: number, collide = true, tile = 2.5) => {
      const m = mesh(boxUV(new THREE.BoxGeometry(bw, bh, bd), tile, new THREE.Vector3(x, y, z)), material, x, y, z);
      if (collide) this.solid(o, RAPIER.ColliderDesc.cuboid(bw / 2, bh / 2, bd / 2), new THREE.Vector3(x, y, z));
      return m;
    };
    /** A box turned about z (or x) by `angle`, not solid: braces, roof slabs. */
    const slab = (bw: number, bh: number, bd: number, material: THREE.Material, x: number, y: number, z: number, rz: number, rx = 0, tile = 2.5) => {
      const m = mesh(boxUV(new THREE.BoxGeometry(bw, bh, bd), tile), material, x, y, z);
      m.rotation.set(rx, 0, rz);
      return m;
    };
    const planks = this.mat('planks', 0xffffff), darkWood = this.mat('planks', 0x8a7d70), roofMetal = this.mat('metalRoof', 0xffffff);
    const snowMat = this.mat('snow', PAL.snow), glass = this.mat(null, 0x2a3440), stone = this.mat('rock', 0xb8b4ae);

    switch (o.kind) {
      case 'rock': {
        const geo = boulder(makeRng(o.id + 1000));
        geo.scale(w / 2, h / 2, d / 2);
        geo.computeVertexNormals();
        boxUV(geo, 2.2);
        // Snow settles on the tops: faces that look up are white, the rest bare rock.
        const nrm = geo.attributes.normal, col = new Float32Array(nrm.count * 3);
        const snowC = new THREE.Color(PAL.snow), rockC = new THREE.Color(PAL.rock);
        for (let i = 0; i < nrm.count; i += 3) {
          const c = nrm.getY(i) > 0.72 ? snowC : rockC;
          for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (i + k) * 3);
        }
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        mesh(geo, this.mat('rock', 0xffffff, { vertexColors: true }), 0, h * 0.25, 0); // half buried
        this.solid(o, RAPIER.ColliderDesc.convexHull(geo.attributes.position.array as Float32Array)!, new THREE.Vector3(0, h * 0.25, 0));
        break;
      }
      case 'log': {
        // Lying along local x, a little sunk into the snow: bark round the side, pale cut ends.
        const r = h / 2;
        mesh(new THREE.CylinderGeometry(r, r * 1.1, w, 10, 1, true).rotateZ(Math.PI / 2), this.mat('bark', 0xffffff), 0, r * 0.8, 0);
        for (const s of [-1, 1]) {
          const end = new THREE.CircleGeometry(s < 0 ? r * 1.1 : r, 10).rotateY((s * Math.PI) / 2);
          mesh(boxUV(end, 0.6), this.mat('planks', 0xd8c4a8), (s * w) / 2, r * 0.8, 0);
        }
        // A line of snow along the top.
        mesh(new THREE.BoxGeometry(w * 0.95, r * 0.25, r * 1.1), snowMat, 0, r * 1.75, 0);
        const lying = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
        this.solid(o, RAPIER.ColliderDesc.cylinder(w / 2, r), new THREE.Vector3(0, r * 0.8, 0), lying);
        break;
      }
      case 'cabin': {
        // A plank hut on a stone footing: corner posts, a door and windows with frames, gable ends,
        // a corrugated roof carrying snow, and a stone chimney.
        box(w + 0.2, 0.35, d + 0.2, stone, 0, 0.1, 0, false, 2);
        box(w, h, d, planks, 0, h / 2, 0);
        for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(0.22, h, 0.22, darkWood, (cx * w) / 2, h / 2, (cz * d) / 2, false);
        // Door (front, -z) in a frame, with a step.
        const doorX = w * 0.2;
        box(1.3, 2.3, 0.08, darkWood, doorX, 1.15, -d / 2 - 0.04, false);
        box(1.05, 2.05, 0.1, this.mat('planks', 0x6e5a48), doorX, 1.05, -d / 2 - 0.07, false, 1.2);
        box(1.6, 0.2, 0.6, stone, doorX, 0.1, -d / 2 - 0.35, false, 2);
        // Windows: side walls and the back, glass in a pale frame.
        const windows: Array<[number, number, number]> = [[-1, 0, Math.PI / 2], [1, 0, -Math.PI / 2], [0, 1, Math.PI]];
        for (const [sx, sz, rot] of windows) {
          const wx = (sx * w) / 2, wz = (sz * d) / 2;
          const frame = mesh(boxUV(new THREE.BoxGeometry(1.4, 1.1, 0.1), 1), this.mat('planks', 0xe6ded2), wx, h * 0.58, wz);
          frame.rotation.y = rot;
          const pane = mesh(new THREE.BoxGeometry(1.15, 0.85, 0.12), glass, wx, h * 0.58, wz);
          pane.rotation.y = rot;
          const bar = mesh(new THREE.BoxGeometry(0.06, 0.85, 0.14), this.mat('planks', 0xe6ded2), wx, h * 0.58, wz);
          bar.rotation.y = rot;
        }
        // Gable and roof: the ridge runs front to back.
        const rise = h * 0.45, overhang = 0.45;
        const gable = new THREE.CylinderGeometry(1, 1, d, 3, 1).rotateX(-Math.PI / 2);
        gable.scale(w / 1.732, rise / 1.5, 1).translate(0, rise / 2 - rise / 6 - 0.0, 0);
        gable.computeVertexNormals();
        mesh(boxUV(gable, 2.5), planks, 0, h + rise / 6 + 0.0, 0);
        const half = w / 2 + overhang, ang = Math.atan2(rise, w / 2), len = half / Math.cos(ang);
        for (const s of [-1, 1]) {
          const cx = (s * half) / 2, cy = h + rise / 2 - (overhang * Math.tan(ang)) / 2;
          slab(len, 0.12, d + overhang * 2, roofMetal, cx, cy, 0, -s * ang, 0, 3);
          // Snow on the roof: a thinner slab just above, short of the edges.
          slab(len * 0.92, 0.12, d + overhang * 1.4, snowMat, cx - s * 0.02, cy + 0.11 / Math.cos(ang), 0, -s * ang, 0, 4);
        }
        // Chimney through the back of the roof.
        const chx = -w * 0.22, chz = d * 0.25, chy = h + rise * (1 - Math.abs(chx) / (w / 2));
        box(0.7, rise + 1.2, 0.7, stone, chx, chy - rise / 2 + 0.3, chz, false, 1.6);
        box(0.85, 0.15, 0.85, stone, chx, chy + 0.95, chz, false, 1.6);
        break;
      }
      case 'tower': {
        // Four timber legs with cross bracing, a ladder, a planked platform with walls, a tin roof.
        const leg = w / 2 - 0.2, legMat = this.mat('bark', 0xc8b8a8);
        for (const [lx, lz] of [[-leg, -leg], [leg, -leg], [-leg, leg], [leg, leg]]) {
          box(0.25, h, 0.25, legMat, lx, h / 2, lz, true, 1.5);
          box(0.15, 2.2, 0.15, legMat, lx, h + 1.1, lz, false, 1.5);
        }
        // X braces on every side, in two tiers.
        const span = leg * 2, tier = h / 2, braceLen = Math.hypot(span, tier), braceAng = Math.atan2(tier, span);
        for (let t = 0; t < 2; t++) {
          const y = tier * (t + 0.5);
          for (const s of [-1, 1]) {
            for (const dir of [-1, 1]) {
              slab(braceLen, 0.1, 0.08, legMat, 0, y, s * leg, dir * braceAng, 0, 1.5);
              const b = slab(braceLen, 0.1, 0.08, legMat, s * leg, y, 0, dir * braceAng, 0, 1.5);
              b.rotation.set(0, Math.PI / 2, dir * braceAng, 'YXZ');
            }
          }
        }
        // Ladder up the front.
        for (const sx of [-0.25, 0.25]) box(0.07, h + 1, 0.07, legMat, sx, (h + 1) / 2, -leg - 0.35, false, 1);
        for (let y = 0.4; y < h + 0.8; y += 0.4) box(0.5, 0.05, 0.05, legMat, 0, y, -leg - 0.35, false, 1);
        box(w, 0.3, w, darkWood, 0, h, 0, true, 2);
        for (const s of [-1, 1]) {
          box(w, 1, 0.1, planks, 0, h + 0.65, (s * w) / 2, true, 2);
          box(0.1, 1, w, planks, (s * w) / 2, h + 0.65, 0, true, 2);
        }
        const roof = new THREE.ConeGeometry(w * 0.85, 1.4, 4).rotateY(Math.PI / 4);
        roof.computeVertexNormals();
        mesh(boxUV(roof, 2), roofMetal, 0, h + 2.9, 0);
        const snowCap = new THREE.ConeGeometry(w * 0.8, 1.3, 4).rotateY(Math.PI / 4);
        mesh(boxUV(snowCap, 3), snowMat, 0, h + 3.08, 0);
        break;
      }
      case 'wall': {
        // Sandbags: a row of fat rounded bags with a second row on top, offset by half a bag.
        const bags = Math.max(2, Math.round(w / 0.7)), bw = w / bags, r = h * 0.22;
        const bag = new THREE.CapsuleGeometry(r, Math.max(0.05, bw - r * 2), 3, 8).rotateZ(Math.PI / 2).scale(1, 1, d / (r * 2));
        const burlap = this.mat('burlap', 0xffffff);
        for (let i = 0; i < bags; i++) mesh(bag, burlap, -w / 2 + bw * (i + 0.5), r, 0).rotation.y = (i % 3 - 1) * 0.04;
        for (let i = 0; i < bags - 1; i++) mesh(bag, burlap, -w / 2 + bw * (i + 1), r * 3, 0).rotation.y = (i % 2 - 0.5) * 0.06;
        this.solid(o, RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2), new THREE.Vector3(0, h / 2, 0));
        break;
      }
      case 'pad': {
        // Extraction: a concrete landing pad with a painted H, and orange smoke rising off it.
        box(w, h, d, this.mat('concrete', 0x8a9097), 0, h / 2, 0, true, 4);
        const paint = this.mat('concrete', 0xf3f5f7);
        box(0.8, 0.05, 4.5, paint, -1.4, h + 0.02, 0, false, 4);
        box(0.8, 0.05, 4.5, paint, 1.4, h + 0.02, 0, false, 4);
        box(2.0, 0.05, 0.8, paint, 0, h + 0.02, 0, false, 4);
        box(0.3, 0.5, 0.3, this.mat('metal', PAL.gun), w / 2 - 1, h + 0.25, d / 2 - 1, false, 1); // the smoke grenade
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
    this.props.push(group);
  }

  /** Every prop piece merged into one mesh per material per chunk: thousands of pieces, few draw calls. */
  private mergeProps() {
    const meshes: THREE.Mesh[] = [];
    for (const g of this.props) g.traverse((o) => o instanceof THREE.Mesh && meshes.push(o));
    const chunkOf = (m: THREE.Mesh) => {
      const p = m.getWorldPosition(new THREE.Vector3());
      return `${Math.floor(p.x / CHUNK)},${Math.floor(p.z / CHUNK)}`;
    };
    for (const m of mergeWorld(meshes, chunkOf)) this.scene.add(m);
    for (const g of this.props) g.removeFromParent();
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
      this.trunkColliders(o, [[0, h * 0.5, 0.19], [h * 0.5, h, 0.14]]);
      return;
    }
    // Bare trunk up to about a third of the height: you can see (and shoot) under the branches.
    chunk.trunks.push(m(-0.3, 0.28, h * 0.45 + 0.3)); // sunk a little so slopes don't show a gap
    for (let i = 0; i < 3; i++) {
      const y = h * (0.36 + i * 0.19), r = w * (1 - i * 0.27);
      chunk.cones.push(m(y, r, h * 0.4));
      // The branches as a sensor: bullets and bodies pass through (they skip sensors), but an enemy
      // laser stops in them. A little inside the drawn cone, so a beam grazing the tips gets by.
      this.physics.createCollider(RAPIER.ColliderDesc.cone(h * 0.2, r * 0.85).setSensor(true).setTranslation(o.x, o.y + y + h * 0.2, o.z));
    }
    // The visible trunk tapers and stops under the branches; above that only a thin core, hidden in them.
    this.trunkColliders(o, [[0, h * 0.22, 0.23], [h * 0.22, h * 0.45, 0.18], [h * 0.45, h, 0.12]]);
  }

  /** Stacked cylinders (from, to, radius above the base) that follow a tapering trunk, so shots
   * only stop on bark you can see. */
  private trunkColliders(o: MapObject, parts: Array<[number, number, number]>) {
    for (const [y0, y1, r] of parts) {
      this.physics.createCollider(RAPIER.ColliderDesc.cylinder((y1 - y0) / 2, r).setTranslation(o.x, o.y + (y0 + y1) / 2, o.z));
    }
  }

  private buildTrees() {
    // Bark and needles carry their own colour; the needle texture repeats round each cone.
    const bark = new THREE.MeshLambertMaterial({ map: textures().bark });
    const needleMap = textures().needles.clone();
    needleMap.repeat.set(3, 1.5);
    const needles = new THREE.MeshLambertMaterial({ map: needleMap });
    const add = (geo: THREE.BufferGeometry, material: THREE.Material, list: THREE.Matrix4[]) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(geo, material, list.length);
      list.forEach((mat, i) => im.setMatrixAt(i, mat));
      im.castShadow = im.receiveShadow = true;
      im.computeBoundingSphere();
      this.scene.add(im);
    };
    for (const c of this.chunks.values()) {
      add(TRUNK, bark, c.trunks);
      add(CONE, needles, c.cones);
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

/**
 * A closed, faceted boulder about 2 units across: an icosphere with its shared corners welded (so
 * faces can't tear apart), shaped by a few broad bulges and dents, some per-corner roughness, a few
 * flat cleaved faces, and a flattened base that sits in the snow.
 */
function boulder(rng: Rng): THREE.BufferGeometry {
  const base = new THREE.IcosahedronGeometry(1, 1);
  base.deleteAttribute('normal');
  base.deleteAttribute('uv');
  const geo = mergeVertices(base);
  const bumps = Array.from({ length: 5 }, () => ({
    dir: new THREE.Vector3(rng.range(-1, 1), rng.range(-0.6, 1), rng.range(-1, 1)).normalize(),
    k: rng.range(-0.22, 0.3),
  }));
  // A few cleaved faces: everything beyond a plane is pressed flat onto it.
  const cuts = Array.from({ length: 3 }, () => ({
    n: new THREE.Vector3(rng.range(-1, 1), rng.range(-0.2, 1), rng.range(-1, 1)).normalize(),
    at: rng.range(0.6, 0.85),
  }));
  const p = geo.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    let r = 1 + rng.range(-0.1, 0.1);
    for (const b of bumps) r += b.k * Math.max(0, v.dot(b.dir)) ** 2;
    v.multiplyScalar(r);
    for (const c of cuts) {
      const over = v.dot(c.n) - c.at;
      if (over > 0) v.addScaledVector(c.n, -over);
    }
    if (v.y < -0.35) v.y = -0.35 + (v.y + 0.35) * 0.25; // flat underneath
    p.setXYZ(i, v.x, v.y, v.z);
  }
  // Back to separate faces so flat shading gives every facet its own crisp tone.
  const out = geo.toNonIndexed();
  out.computeVertexNormals();
  return out;
}
