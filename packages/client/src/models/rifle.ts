import * as THREE from 'three';
import { PAL, flat } from '../render/palette';

// Bolt-action sniper rifle, forward is -z, origin at the grip. About 1.15 m long.

export interface RifleModel {
  root: THREE.Group;
  muzzle: THREE.Object3D; // at the end of the barrel
  bolt: THREE.Mesh; // the handle, animated when cycling
}

export function buildRifle(color: number = PAL.gun): RifleModel {
  const mat = flat(color);
  const root = new THREE.Group();
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    root.add(m);
    return m;
  };
  const tube = (r1: number, r2: number, len: number, y: number, z: number) => {
    const g = new THREE.CylinderGeometry(r1, r2, len, 8);
    g.rotateX(Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(0, y, z);
    root.add(m);
    return m;
  };

  box(0.055, 0.13, 0.32, 0, -0.02, 0.33); // stock
  box(0.05, 0.06, 0.1, 0, 0.04, 0.22); // cheek rest
  box(0.045, 0.1, 0.05, 0, -0.07, 0.07).rotation.x = -0.35; // grip
  box(0.065, 0.075, 0.42, 0, 0.0, -0.08); // receiver and fore-end
  box(0.04, 0.09, 0.07, 0, -0.075, -0.02); // magazine
  tube(0.013, 0.016, 0.55, 0.01, -0.55); // barrel
  tube(0.022, 0.022, 0.08, 0.01, -0.84); // muzzle brake
  tube(0.024, 0.024, 0.3, 0.085, -0.06); // scope tube
  tube(0.034, 0.026, 0.07, 0.085, -0.23); // objective bell
  tube(0.03, 0.024, 0.06, 0.085, 0.11); // eyepiece
  box(0.02, 0.04, 0.02, 0, 0.05, -0.12); // scope mounts
  box(0.02, 0.04, 0.02, 0, 0.05, 0.02);
  const bolt = box(0.07, 0.02, 0.02, 0.05, 0.02, 0.08);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0.01, -0.9);
  root.add(muzzle);
  return { root, muzzle, bolt };
}
