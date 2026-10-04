import * as THREE from 'three';
import type { Pickup } from '@spec-ops/shared';
import { boxUV, textures } from './render/textures';

// Ammo boxes and medkits lying in the snow: at the bases (by a hut door) and beside the dead.
// Walk over one to take it; the server says who got it, and it's gone for everyone.

let mats: Record<'olive' | 'metal' | 'white' | 'red' | 'stencil', THREE.Material> | null = null;
function materials() {
  const t = textures();
  return (mats ??= {
    olive: new THREE.MeshLambertMaterial({ color: 0x5b6342, map: t.metal }),
    metal: new THREE.MeshLambertMaterial({ color: 0x3a3f45, map: t.metal }),
    white: new THREE.MeshLambertMaterial({ color: 0xe8e6e0, map: t.cloth }),
    red: new THREE.MeshLambertMaterial({ color: 0xc81e1a }),
    stencil: new THREE.MeshLambertMaterial({ color: 0xd9c24a }),
  });
}

function box(w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) {
  const m = new THREE.Mesh(boxUV(new THREE.BoxGeometry(w, h, d), 0.3), mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** A steel ammo can: olive, a carry handle and a latch, a yellow stencil band. */
function ammoCan() {
  const m = materials(), g = new THREE.Group();
  box(0.42, 0.22, 0.2, m.olive, 0, 0.11, 0, g);
  box(0.43, 0.03, 0.21, m.metal, 0, 0.235, 0, g); // lid
  box(0.16, 0.025, 0.03, m.metal, 0, 0.26, 0, g); // handle
  box(0.04, 0.08, 0.02, m.metal, 0.17, 0.2, -0.105, g); // latch
  box(0.3, 0.03, 0.005, m.stencil, -0.02, 0.12, -0.102, g); // stencil band
  return g;
}

/** A medkit: a white canvas case with a red cross on the lid and the front. */
function medkit() {
  const m = materials(), g = new THREE.Group();
  box(0.36, 0.14, 0.24, m.white, 0, 0.07, 0, g);
  box(0.14, 0.005, 0.04, m.red, 0, 0.143, 0, g);
  box(0.04, 0.005, 0.14, m.red, 0, 0.143, 0, g);
  box(0.09, 0.03, 0.005, m.red, 0, 0.07, -0.121, g);
  box(0.03, 0.09, 0.005, m.red, 0, 0.07, -0.121, g);
  box(0.12, 0.02, 0.03, m.metal, 0, 0.15, 0.08, g); // handle
  return g;
}

export class Pickups {
  readonly byId = new Map<number, { pickup: Pickup; model: THREE.Group }>();

  constructor(private scene: THREE.Scene) {}

  /** Replace everything (mission start, or joining one under way). */
  set(list: Pickup[]) {
    this.clear();
    for (const p of list) this.add(p);
  }

  add(p: Pickup) {
    if (this.byId.has(p.id)) return;
    const model = p.kind === 'ammo' ? ammoCan() : medkit();
    model.position.set(...p.pos);
    model.rotation.y = (p.id * 2.39996) % (Math.PI * 2); // each lies at its own angle
    this.scene.add(model);
    this.byId.set(p.id, { pickup: p, model });
  }

  remove(id: number) {
    const e = this.byId.get(id);
    if (!e) return;
    this.scene.remove(e.model);
    this.byId.delete(id);
  }

  clear() {
    for (const id of [...this.byId.keys()]) this.remove(id);
  }

  /** Pickups within `range` m of (x, z) on the flat. */
  *near(x: number, z: number, range: number): Iterable<Pickup> {
    for (const { pickup } of this.byId.values()) {
      if (Math.hypot(pickup.pos[0] - x, pickup.pos[2] - z) <= range) yield pickup;
    }
  }
}
