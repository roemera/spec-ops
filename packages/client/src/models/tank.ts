import * as THREE from 'three';
import { BARREL_LENGTH, HULL_HALF } from '@skeleton-crew/shared';
import { GUN_OFFSET, TURRET_OFFSET } from '../sim/tank';
import { tex } from '../render/textures';
import { wobble } from '../render/pipeline';

/** Metres of track covered by one copy of the track texture (4 tread links). */
export const TRACK_TEXTURE_LENGTH = 1.4;

/** The lookout's hitbox, in the man group's frame: centre and half extents (m). */
export const MAN_CENTER = new THREE.Vector3(0, 0.55, 0);
export const MAN_HALF = new THREE.Vector3(0.38, 0.6, 0.3);

export interface TankModel {
  root: THREE.Group; // hull frame: origin at hull centre, forward -z
  turret: THREE.Group; // rotates about y
  gun: THREE.Group; // pivot at the mantlet, rotates about x
  trackMaps: [THREE.Texture, THREE.Texture]; // left, right (scrolled by track speed)
  man: THREE.Group; // the lookout sticking out of the hatch (hidden unless that seat is taken)
}

const plain = (color: number) => new THREE.MeshLambertMaterial({ color, flatShading: true });

/** A little blocky man, waist-up, as if standing in the hatch. */
function buildMan(): THREE.Group {
  const man = new THREE.Group();
  const skin = plain(0xffc8a0), shirt = plain(0x2a2a2a), helmet = plain(0xff00b4);
  const part = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    man.add(m);
    return m;
  };
  part(0.55, 0.6, 0.35, shirt, 0, 0.3, 0); // torso
  part(0.32, 0.32, 0.32, skin, 0, 0.78, 0); // head
  part(0.4, 0.14, 0.4, helmet, 0, 0.98, 0); // helmet
  part(0.14, 0.45, 0.14, shirt, -0.36, 0.38, -0.05).rotation.z = 0.5; // arms, waving a bit
  part(0.14, 0.45, 0.14, shirt, 0.36, 0.38, -0.05).rotation.z = -0.5;
  man.visible = false;
  return man;
}


const mat = (map: THREE.Texture) => wobble(new THREE.MeshLambertMaterial({ map, flatShading: true }));

export function buildTankModel(): TankModel {
  const root = new THREE.Group();
  const { x: hx, y: hy, z: hz } = HULL_HALF;

  const hullMat = mat(tex.hull());
  const hull = new THREE.Mesh(new THREE.BoxGeometry(hx * 2 - 0.6, hy * 2, hz * 2), hullMat);
  const glacis = new THREE.Mesh(new THREE.BoxGeometry(hx * 2 - 0.6, 0.25, 1.6), mat(tex.hazard()));
  glacis.position.set(0, hy - 0.1, -hz + 0.5);
  glacis.rotation.x = 0.45;
  root.add(hull, glacis);

  const trackMaps: THREE.Texture[] = [];
  for (const side of [-1, 1]) {
    const map = tex.track();
    trackMaps.push(map);
    const geo = new THREE.BoxGeometry(0.75, 1.1, hz * 2 + 0.3);
    // Texture v follows the track's length on every face, so the tread lines run across it.
    const pos = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) + pos.getY(i), pos.getZ(i) / TRACK_TEXTURE_LENGTH);
    const track = new THREE.Mesh(geo, mat(map));
    track.position.set(side * (hx - 0.3), -hy - 0.15, 0);
    root.add(track);
  }

  const turret = new THREE.Group();
  turret.position.copy(TURRET_OFFSET);
  const turretMat = mat(tex.turret());
  const turretBox = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 2.8), turretMat);
  const hatch = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.2, 6), mat(tex.hazard()));
  hatch.position.set(0.5, 0.55, 0.4);
  turret.add(turretBox, hatch);
  const man = buildMan();
  man.position.set(0.5, 0.6, 0.4); // stands in the hatch
  turret.add(man);

  const gun = new THREE.Group();
  gun.position.copy(GUN_OFFSET);
  const mantlet = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.6, 0.5), turretMat);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, BARREL_LENGTH, 6), mat(tex.hazard()));
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = -BARREL_LENGTH / 2;
  gun.add(mantlet, barrel);
  turret.add(gun);
  root.add(turret);

  return { root, turret, gun, trackMaps: trackMaps as [THREE.Texture, THREE.Texture], man };
}
