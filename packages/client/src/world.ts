import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FOG_FAR, FOG_NEAR, SHADOW_RANGE, type GameMap, type MapObject, makeRng } from '@spec-ops/shared';
import { PAL, flat } from './render/palette';

const SUN_DIR = new THREE.Vector3(0.45, 0.8, 0.3).normalize();
const SHADOW_MAP = 2048;

/** Builds the generated map into a Three.js scene and a Rapier world. */
export class World {
  readonly scene = new THREE.Scene();
  private sun: THREE.DirectionalLight;

  constructor(readonly map: GameMap, readonly physics: RAPIER.World) {
    this.scene.background = new THREE.Color(PAL.horizon);
    this.scene.fog = new THREE.Fog(PAL.horizon, FOG_NEAR, FOG_FAR);
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

  private buildTerrain() {
    const { cells, size, heights } = this.map;
    const n = cells + 1, step = size / cells, half = size / 2;
    const pos = new Float32Array(n * n * 3);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        pos.set([-half + ix * step, heights[i], -half + iz * step], i * 3);
      }
    }
    const index: number[] = [];
    for (let iz = 0; iz < cells; iz++) {
      for (let ix = 0; ix < cells; ix++) {
        const a = iz * n + ix, b = a + 1, c = a + n, d = c + 1;
        index.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    const ground = new THREE.Mesh(geo, flat(PAL.snow));
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
      this.physics.createCollider(RAPIER.ColliderDesc.cuboid(hx, 200, hz).setTranslation(x, 0, z));
    }
  }

  private buildObject(o: MapObject) {
    const [w, h, d] = o.size;
    const group = new THREE.Group();
    group.position.set(o.x, o.y, o.z);
    group.rotation.y = o.rotY;
    const rot = new THREE.Quaternion().setFromEuler(group.rotation);
    let desc: RAPIER.ColliderDesc;
    const mesh = (geo: THREE.BufferGeometry, color: number, y: number) => {
      const m = new THREE.Mesh(geo, flat(color));
      m.position.y = y;
      m.castShadow = m.receiveShadow = true;
      group.add(m);
      return m;
    };

    switch (o.kind) {
      case 'rock': {
        const geo = new THREE.IcosahedronGeometry(1, 0);
        const rng = makeRng(o.id + 1000);
        const p = geo.attributes.position;
        for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * rng.range(0.7, 1.2), p.getY(i) * rng.range(0.7, 1.2), p.getZ(i) * rng.range(0.7, 1.2));
        geo.scale(w / 2, h / 2, d / 2);
        geo.computeVertexNormals();
        mesh(geo, PAL.rock, h * 0.25); // half buried
        desc = RAPIER.ColliderDesc.convexHull(geo.attributes.position.array as Float32Array)!.setTranslation(o.x, o.y + h * 0.25, o.z);
        break;
      }
      case 'building': {
        mesh(new THREE.BoxGeometry(w, h, d), PAL.wall, h / 2);
        // Pitched roof: a stretched triangular prism, dark so it reads against the snow.
        const roof = new THREE.CylinderGeometry(1, 1, d + 1, 3, 1);
        roof.rotateX(-Math.PI / 2); // apex up
        roof.scale((w + 1) / 1.73, h * 0.35, 1);
        mesh(roof, PAL.roof, h + h * 0.17);
        desc = RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setTranslation(o.x, o.y + h / 2, o.z);
        break;
      }
      case 'silo': {
        mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 10), PAL.wall, h / 2);
        mesh(new THREE.ConeGeometry(w / 2 + 0.4, 3, 10), PAL.roof, h + 1.5);
        desc = RAPIER.ColliderDesc.cylinder(h / 2, w / 2).setTranslation(o.x, o.y + h / 2, o.z);
        break;
      }
      case 'tree': {
        // Pine: a dark trunk and three stacked cones.
        mesh(new THREE.CylinderGeometry(0.18, 0.3, h * 0.35, 6), PAL.trunk, h * 0.175);
        for (let i = 0; i < 3; i++) {
          const r = w * (1 - i * 0.25), ch = h * 0.42;
          mesh(new THREE.ConeGeometry(r, ch, 7), PAL.pine, h * (0.35 + i * 0.2) + ch / 2 - h * 0.05);
        }
        desc = RAPIER.ColliderDesc.cylinder(h / 2, 0.35).setTranslation(o.x, o.y + h / 2, o.z);
        break;
      }
      case 'fence': {
        const rail = new THREE.BoxGeometry(w, 0.12, d);
        mesh(rail, PAL.fence, h * 0.8);
        mesh(rail, PAL.fence, h * 0.4);
        const post = mesh(new THREE.BoxGeometry(0.16, h, 0.16), PAL.fence, h / 2);
        post.position.x = -w / 2;
        desc = RAPIER.ColliderDesc.cuboid(w / 2, h / 2, 0.1).setTranslation(o.x, o.y + h / 2, o.z);
        break;
      }
      case 'wall': {
        mesh(new THREE.BoxGeometry(w, h, d), PAL.wall, h / 2);
        desc = RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setTranslation(o.x, o.y + h / 2, o.z);
        break;
      }
    }
    desc.setRotation(rot);
    this.physics.createCollider(desc);
    this.scene.add(group);
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
