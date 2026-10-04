import * as THREE from 'three';
import { PAL } from '../render/palette';
import { boxUV, textures } from '../render/textures';
import { mergeChildren } from '../render/merge';

// Bolt-action sniper rifle, forward is -z, origin at the grip. About 1.15 m long: a wooden stock
// and fore-end, a blued receiver, barrel and scope.

export interface RifleModel {
  root: THREE.Group;
  muzzle: THREE.Object3D; // at the end of the barrel
  bolt: THREE.Object3D; // the handle, animated when cycling
}

let mats: { wood: THREE.Material; metal: THREE.Material; dark: THREE.Material; glass: THREE.Material } | null = null;
function materials() {
  return (mats ??= {
    wood: new THREE.MeshLambertMaterial({ map: textures().wood }),
    metal: new THREE.MeshLambertMaterial({ color: 0x3a3f45, map: textures().metal }),
    dark: new THREE.MeshLambertMaterial({ color: PAL.gun, map: textures().metal }),
    glass: new THREE.MeshLambertMaterial({ color: 0x0d1418, emissive: 0x0a1a24 }),
  });
}

export function buildRifle(): RifleModel {
  const m = materials();
  const root = new THREE.Group();
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, parent: THREE.Object3D = root) => {
    const mesh = new THREE.Mesh(boxUV(new THREE.BoxGeometry(w, h, d), 0.18), mat);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };
  const tube = (r1: number, r2: number, len: number, y: number, z: number, mat: THREE.Material, x = 0) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 14).rotateX(Math.PI / 2), mat);
    mesh.position.set(x, y, z);
    root.add(mesh);
    return mesh;
  };

  // Stock and fore-end: each one carved piece, a side profile (z, y) extruded across and bevelled.
  const carve = (profile: Array<[number, number]>, width: number) => {
    const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: width - 0.012, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 4 });
    geo.translate(0, 0, -(width - 0.012) / 2).rotateY(-Math.PI / 2); // profile x -> world z, extrusion -> world x
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(boxUV(geo, 0.18), m.wood);
    root.add(mesh);
  };
  // Butt with a raised comb for the cheek, a slim wrist dropping into a pistol grip.
  carve([
    [0.05, 0.0], [0.1, 0.02], [0.22, 0.035], [0.27, 0.065], [0.4, 0.07], [0.485, 0.05],
    [0.49, -0.09], [0.4, -0.095], [0.25, -0.05], [0.15, -0.032], [0.115, -0.05],
    [0.1, -0.12], [0.06, -0.128], [0.055, -0.07], [0.04, -0.035], [0.035, 0.0],
  ], 0.05);
  box(0.054, 0.142, 0.012, 0, -0.02, 0.495, m.dark); // butt plate
  // Fore-end under the barrel, tapering to a rounded tip.
  carve([
    [-0.02, 0.012], [-0.47, 0.012], [-0.492, 0.0], [-0.49, -0.025], [-0.44, -0.04], [-0.1, -0.05], [-0.02, -0.042],
  ], 0.056);
  // Receiver, trigger guard, magazine.
  box(0.05, 0.05, 0.24, 0, 0.025, -0.02, m.metal);
  box(0.012, 0.012, 0.09, 0, -0.06, 0.02, m.dark);
  box(0.04, 0.07, 0.07, 0, -0.065, -0.05, m.dark);
  // Barrel, muzzle brake.
  tube(0.012, 0.016, 0.6, 0.02, -0.5, m.metal);
  tube(0.02, 0.02, 0.07, 0.02, -0.83, m.dark);
  // Scope: rings, tube, bells, turrets, a glint of glass at each end.
  tube(0.021, 0.021, 0.3, 0.09, -0.06, m.dark);
  tube(0.033, 0.024, 0.08, 0.09, -0.24, m.dark);
  tube(0.029, 0.022, 0.07, 0.09, 0.12, m.dark);
  tube(0.026, 0.026, 0.004, 0.09, -0.281, m.glass);
  tube(0.024, 0.024, 0.004, 0.09, 0.156, m.glass);
  for (const z of [-0.13, 0.03]) box(0.03, 0.05, 0.022, 0, 0.06, z, m.dark);
  const turret = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.03, 10), m.dark);
  turret.position.set(0, 0.125, -0.05);
  root.add(turret);
  const side = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.03, 10).rotateZ(Math.PI / 2), m.dark);
  side.position.set(0.035, 0.09, -0.05);
  root.add(side);
  // Bolt handle with a round knob, pivoting on the receiver.
  const bolt = new THREE.Group();
  bolt.position.set(0.02, 0.03, 0.08); // main.ts slides it back from z 0.08 when cycling
  root.add(bolt);
  box(0.06, 0.012, 0.012, 0.03, 0, 0, m.metal, bolt);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), m.metal);
  knob.position.set(0.062, 0, 0);
  bolt.add(knob);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.02, -0.87);
  root.add(muzzle);
  mergeChildren(root);
  mergeChildren(bolt);
  return { root, muzzle, bolt };
}

/**
 * First-person arms: gloved hands on the grip and under the fore-end, sleeves running back out of
 * view. Added to the viewmodel rifle so they move with it.
 */
export function addViewArms(rifle: RifleModel, sleeve: number) {
  const cloth = new THREE.MeshLambertMaterial({ color: sleeve, map: textures().cloth });
  const glove = new THREE.MeshLambertMaterial({ color: 0x2b2a28, map: textures().cloth });
  const limb = (from: THREE.Vector3, to: THREE.Vector3, r: number) => {
    const d = to.clone().sub(from);
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, d.length(), 4, 12), cloth);
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    rifle.root.add(m);
  };
  const hand = (at: THREE.Vector3, rx: number, rz: number) => {
    const m = new THREE.Mesh(boxUV(new THREE.BoxGeometry(0.075, 0.085, 0.1), 0.2), glove);
    m.position.copy(at);
    m.rotation.set(rx, 0, rz);
    rifle.root.add(m);
    // Fingers wrapped round: a rounded bar on the far side.
    const f = new THREE.Mesh(new THREE.CapsuleGeometry(0.02, 0.05, 3, 8).rotateZ(Math.PI / 2), glove);
    f.position.set(at.x - 0.035, at.y + 0.01, at.z - 0.01);
    f.rotation.set(rx, 0, rz);
    rifle.root.add(f);
  };
  // Right: hand round the grip, forearm back and down to the right.
  hand(new THREE.Vector3(0.012, -0.085, 0.085), -0.35, 0.1);
  limb(new THREE.Vector3(0.03, -0.12, 0.13), new THREE.Vector3(0.17, -0.3, 0.55), 0.045);
  // Left: hand cupping the fore-end, forearm back and down to the left.
  hand(new THREE.Vector3(-0.01, -0.06, -0.3), 0.1, -0.25);
  limb(new THREE.Vector3(-0.03, -0.1, -0.26), new THREE.Vector3(-0.26, -0.42, 0.1), 0.045);
  mergeChildren(rifle.root);
}
