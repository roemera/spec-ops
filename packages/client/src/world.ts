import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { DESTRUCT_SPEED, FOG_FAR, FOG_NEAR, type GameMap, type MapObject, makeRng } from '@spec-ops/shared';
import { tex } from './render/textures';
import { wobble } from './render/pipeline';

export const SKY = 0x6ef7ff;
export const FOG = 0xc8ff3c;

const lambert = (map: THREE.Texture, extra: THREE.MeshLambertMaterialParameters = {}) =>
  wobble(new THREE.MeshLambertMaterial({ map, flatShading: true, ...extra }));

interface Breakable {
  obj: MapObject;
  mesh: THREE.Object3D;
  desc: RAPIER.ColliderDesc; // kept to rebuild the collider when the map resets
  collider: RAPIER.Collider;
  broken: boolean;
}

interface Debris {
  mesh: THREE.Mesh;
  body: RAPIER.RigidBody;
  life: number;
}

/** Builds the generated map into a Three.js scene and a Rapier world. */
export class World {
  readonly scene = new THREE.Scene();
  readonly breakables = new Map<number, Breakable>(); // by sensor collider handle
  readonly breakablesById = new Map<number, Breakable>(); // by map object id (what the network uses)
  /** Called when something here (our tank, a shell) breaks an object, so it can be sent to the server. */
  onBreak: (id: number) => void = () => {};
  private debris: Debris[] = [];
  private trees: THREE.Object3D[] = [];
  private time = 0;

  constructor(readonly map: GameMap, readonly physics: RAPIER.World) {
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(FOG, FOG_NEAR, FOG_FAR);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a5a, 1.6));
    const sun = new THREE.DirectionalLight(0xfff27a, 2.2);
    sun.position.set(0.4, 1, 0.25);
    this.scene.add(sun);

    this.buildTerrain();
    this.buildBounds();
    for (const o of map.objects) this.buildObject(o);
  }

  private buildTerrain() {
    const { cells, size, heights } = this.map;
    const n = cells + 1, step = size / cells, half = size / 2;
    const pos = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), col = new Float32Array(n * n * 3);
    // Height bands tint the grass: shades of green, darker low, lighter high.
    const bands = [new THREE.Color(0xb8d8a0), new THREE.Color(0xd8f0c0), new THREE.Color(0xf0fff0), new THREE.Color(0xffffff)];
    const c = new THREE.Color();
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const i = iz * n + ix;
        pos.set([-half + ix * step, heights[i], -half + iz * step], i * 3);
        uv.set([ix * 0.6, iz * 0.6], i * 2);
        const band = Math.max(0, Math.min(bands.length - 1, Math.floor((heights[i] + 12) / 10)));
        c.copy(bands[band]);
        col.set([c.r, c.g, c.b], i * 3);
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
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    this.scene.add(new THREE.Mesh(geo, lambert(tex.grass(), { vertexColors: true })));

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

    switch (o.kind) {
      case 'rock': {
        const geo = new THREE.IcosahedronGeometry(1, 0);
        const rng = makeRng(o.id + 1000);
        const p = geo.attributes.position;
        for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * rng.range(0.7, 1.2), p.getY(i) * rng.range(0.7, 1.2), p.getZ(i) * rng.range(0.7, 1.2));
        geo.scale(w / 2, h / 2, d / 2);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, lambert(tex.rock()));
        mesh.position.y = h * 0.25; // half buried
        group.add(mesh);
        desc = RAPIER.ColliderDesc.convexHull(geo.attributes.position.array as Float32Array)!.setTranslation(o.x, o.y + h * 0.25, o.z);
        break;
      }
      case 'building': {
        const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lambert(tex.building()));
        body.position.y = h / 2;
        const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 1, 0.8, d + 1), lambert(tex.roof()));
        roof.position.y = h + 0.4;
        group.add(body, roof);
        desc = RAPIER.ColliderDesc.cuboid(w / 2, h / 2 + 0.4, d / 2).setTranslation(o.x, o.y + h / 2, o.z);
        break;
      }
      case 'silo': {
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(w / 2, w / 2, h, 8), lambert(tex.hazard()));
        mesh.position.y = h / 2;
        const cap = new THREE.Mesh(new THREE.ConeGeometry(w / 2 + 0.4, 3, 8), lambert(tex.roof()));
        cap.position.y = h + 1.5;
        group.add(mesh, cap);
        desc = RAPIER.ColliderDesc.cylinder(h / 2, w / 2).setTranslation(o.x, o.y + h / 2, o.z);
        break;
      }
      case 'tree': {
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, h * 0.4, 5), lambert(tex.bark()));
        trunk.position.y = h * 0.2;
        const crown = new THREE.Mesh(new THREE.ConeGeometry(w, h * 0.75, 6), lambert(tex.leaves()));
        crown.position.y = h * 0.6;
        group.add(trunk, crown);
        this.trees.push(group);
        desc = RAPIER.ColliderDesc.cylinder(h / 2, 0.6).setTranslation(o.x, o.y + h / 2, o.z);
        break;
      }
      case 'fence': {
        const mat = lambert(tex.fence());
        const rail = new THREE.Mesh(new THREE.BoxGeometry(w, 0.15, d), mat);
        rail.position.y = h * 0.8;
        const rail2 = rail.clone();
        rail2.position.y = h * 0.4;
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.2, h, 0.2), mat);
        post.position.set(-w / 2, h / 2, 0);
        group.add(rail, rail2, post);
        desc = RAPIER.ColliderDesc.cuboid(w / 2, h / 2, 0.3).setTranslation(o.x, o.y + h / 2, o.z);
        break;
      }
      case 'wall': {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), lambert(tex.brick()));
        mesh.position.y = h / 2;
        group.add(mesh);
        desc = RAPIER.ColliderDesc.cuboid(w / 2, h / 2, d / 2).setTranslation(o.x, o.y + h / 2, o.z);
        break;
      }
    }
    desc.setRotation(rot);
    // Breakable objects are sensors: tanks drive through them and break them (no snag on contact).
    if (o.destructible) desc.setSensor(true);
    const collider = this.physics.createCollider(desc);
    this.scene.add(group);
    if (o.destructible) {
      const b = { obj: o, mesh: group, desc, collider, broken: false };
      this.breakables.set(collider.handle, b);
      this.breakablesById.set(o.id, b);
    }
  }

  /** Break objects a fast enough tank is touching. */
  checkBreaks(tankCollider: RAPIER.Collider, tankSpeed: number) {
    if (tankSpeed < DESTRUCT_SPEED) return;
    this.physics.intersectionPairsWith(tankCollider, (other) => {
      const b = this.breakables.get(other.handle);
      if (b && !b.broken) {
        this.breakObject(b, tankCollider.parent()!.linvel());
        this.onBreak(b.obj.id);
      }
    });
  }

  /** A shell hit a collider. If it is a breakable object, break it and return it. */
  shellHit(handle: number, dir: THREE.Vector3): MapObject | null {
    const b = this.breakables.get(handle);
    if (!b || b.broken) return null;
    this.breakObject(b, { x: dir.x * 8, y: 0, z: dir.z * 8 });
    this.onBreak(b.obj.id);
    return b.obj;
  }

  /** Someone else broke it (from the server). `debris: false` for objects broken before we joined. */
  breakById(id: number, debris = true) {
    const b = this.breakablesById.get(id);
    if (b && !b.broken) this.breakObject(b, { x: 0, y: 0, z: 0 }, debris);
  }

  /** New match: everything stands again. */
  resetBreakables() {
    for (const b of this.breakablesById.values()) {
      if (!b.broken) continue;
      this.breakables.delete(b.collider.handle);
      b.collider = this.physics.createCollider(b.desc);
      this.breakables.set(b.collider.handle, b);
      b.mesh.visible = true;
      b.broken = false;
    }
  }

  private breakObject(b: Breakable, push: RAPIER.Vector, debris = true) {
    b.broken = true;
    b.mesh.visible = false;
    this.physics.removeCollider(b.collider, false);
    if (!debris) return;
    const [w, h, d] = b.obj.size;
    const rng = makeRng(b.obj.id + 5000);
    const sourceMat = (b.mesh.children[b.mesh.children.length - 1] as THREE.Mesh).material as THREE.Material;
    for (let i = 0; i < 4; i++) {
      const sx = Math.max(0.3, w / 3), sy = Math.max(0.3, h / 3), sz = Math.max(0.3, d * 0.8);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), sourceMat);
      const body = this.physics.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(b.obj.x + rng.range(-1, 1), b.obj.y + h * rng.range(0.2, 0.8), b.obj.z + rng.range(-1, 1))
          .setLinvel(push.x * 0.8 + rng.range(-2, 2), rng.range(2, 5), push.z * 0.8 + rng.range(-2, 2))
          .setAngvel({ x: rng.range(-4, 4), y: rng.range(-4, 4), z: rng.range(-4, 4) }),
      );
      // Debris collides with the ground but not with tanks (membership group 2, filter: ground only).
      this.physics.createCollider(
        RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2).setDensity(80).setCollisionGroups(0x0002_0001),
        body,
      );
      this.scene.add(mesh);
      this.debris.push({ mesh, body, life: 10 });
    }
  }

  update(dt: number) {
    this.time += dt;
    // Garish sway, quantised to 12 steps per second so it stutters.
    const t = Math.floor(this.time * 12) / 12;
    for (const tree of this.trees) {
      tree.rotation.z = Math.sin(t * 1.7 + tree.position.x * 0.13) * 0.04;
    }
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.life -= dt;
      if (d.life <= 0) {
        this.scene.remove(d.mesh);
        d.mesh.geometry.dispose();
        this.physics.removeRigidBody(d.body);
        this.debris.splice(i, 1);
        continue;
      }
      const p = d.body.translation(), q = d.body.rotation();
      d.mesh.position.set(p.x, p.y, p.z);
      d.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
  }
}
