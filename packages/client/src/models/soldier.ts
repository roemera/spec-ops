import * as THREE from 'three';
import type { HitZone, Stance } from '@spec-ops/shared';
import { boxUV, textures } from '../render/textures';
import { buildRifle } from './rifle';
import { mergeChildren } from '../render/merge';

// A low poly soldier: the uniform in one colour (with a cloth texture), dark kit over it (helmet,
// goggles, vest and pouches, pack, boots, gloves). Origin at the feet, facing -z.
// Joints are groups; pose() sets them from a stance blend, the aim pitch and how far and fast it walks.
//
// The gait: running is only a few more steps a second than walking, but much longer strides
// (see strideFor). Each knee folds as its leg
// swings through, the hips dip at every footfall, and running leans the body in and lowers the gun.

const THIGH = 0.45;
const SHIN = 0.48;

/** Joint angles and heights for one stance. Angles in rad, +x rotation tips -y toward -z. */
interface Pose {
  hipY: number;
  hipsX: number; // whole body tilt (prone lies it forward)
  torsoX: number; // lean
  thigh: number;
  knee: number;
}

const POSES: Record<Stance, Pose> = {
  stand: { hipY: 0.95, hipsX: 0, torsoX: 0, thigh: 0, knee: 0 },
  crouch: { hipY: 0.62, hipsX: 0, torsoX: -0.3, thigh: 1.25, knee: -1.25 },
  prone: { hipY: 0.17, hipsX: -Math.PI / 2, torsoX: 0, thigh: 0, knee: 0 },
};

/**
 * Footsteps per second at a given speed (m/s): about 1.7 at a patrol walk, 2.3 at a run, 2.7 at a
 * flat-out sprint. Everyone's legs, footstep sounds and rifle bob use it.
 */
export function cadence(speed: number) {
  return Math.min(2.8, 1.4 + 0.22 * speed);
}
/** Metres per footstep at a given speed: what the cadence leaves to stride length. */
export function strideFor(speed: number) {
  return Math.max(0.5, speed / cadence(speed));
}

export interface SoldierModel {
  root: THREE.Group;
  /**
   * `walked` is the total distance moved (m), `speed` the current speed (m/s).
   * Returns true when a foot comes down (play a footstep).
   */
  pose(stance: Stance, pitch: number, walked: number, speed: number, dt: number): boolean;
  /** The end of the rifle barrel, and the group it points down (-z): where the laser comes from. */
  muzzle: THREE.Object3D;
  aim: THREE.Object3D;
  /** Ray test against the body parts (world space). Call after the root's world matrix is current. */
  hitTest(origin: THREE.Vector3, dir: THREE.Vector3, len: number): { t: number; zone: HitZone } | null;
  /** The meshes that make up the body, for effects (shatter) and colour swaps. */
  parts: THREE.Mesh[];
}

let gearMats: { webbing: THREE.Material; helmet: THREE.Material; boot: THREE.Material; glove: THREE.Material; goggles: THREE.Material } | null = null;
/** Kit shared by every soldier: dark webbing, helmet, boots, gloves, goggles. */
function gear() {
  const cloth = textures().cloth;
  return (gearMats ??= {
    webbing: new THREE.MeshLambertMaterial({ color: 0x4a4d48, map: cloth }),
    helmet: new THREE.MeshLambertMaterial({ color: 0x5a5f62, map: textures().metal }),
    boot: new THREE.MeshLambertMaterial({ color: 0x2a2826, map: cloth }),
    glove: new THREE.MeshLambertMaterial({ color: 0x2b2a28, map: cloth }),
    goggles: new THREE.MeshLambertMaterial({ color: 0x111518, emissive: 0x0b1820 }),
  });
}

export function buildSoldier(color: number): SoldierModel {
  // The uniform carries the colour (enemies recolour it with their mood); the kit stays dark.
  const mat = new THREE.MeshLambertMaterial({ color, map: textures().cloth });
  const kit = gear();
  const root = new THREE.Group();
  const parts: THREE.Mesh[] = [];
  const hit = new Map<THREE.Mesh, { zone: HitZone; half: THREE.Vector3 }>();

  /** A body part: drawn with `geo`, hit-tested as a box of half extents `half`. */
  const part = (geo: THREE.BufferGeometry, parent: THREE.Object3D, x: number, y: number, z: number, zone: HitZone, half: THREE.Vector3, material: THREE.Material = mat) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    parts.push(m);
    hit.set(m, { zone, half });
    return m;
  };
  const box = (w: number, h: number, d: number, parent: THREE.Object3D, x: number, y: number, z: number, zone: HitZone) =>
    part(boxUV(new THREE.BoxGeometry(w, h, d), 0.4), parent, x, y, z, zone, new THREE.Vector3(w / 2, h / 2, d / 2));
  /** A rounded limb part (capsule) standing in for a w x h x d box. */
  const limb = (w: number, h: number, d: number, parent: THREE.Object3D, x: number, y: number, z: number, zone: HitZone) => {
    const r = Math.min(w, d) / 2;
    return part(new THREE.CapsuleGeometry(r, Math.max(0.01, h - r * 2), 4, 10), parent, x, y, z, zone, new THREE.Vector3(w / 2, h / 2, d / 2));
  };
  /** Kit: drawn only, not hit-tested (bullets go by the body parts under it). */
  const deco = (geo: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  const kitBox = (w: number, h: number, d: number, material: THREE.Material, parent: THREE.Object3D, x: number, y: number, z: number) =>
    deco(boxUV(new THREE.BoxGeometry(w, h, d), 0.3), material, parent, x, y, z);

  const hips = new THREE.Group();
  root.add(hips);
  box(0.36, 0.2, 0.22, hips, 0, 0.02, 0, 'body'); // pelvis
  kitBox(0.38, 0.06, 0.24, kit.webbing, hips, 0, 0.1, 0); // belt
  kitBox(0.08, 0.1, 0.06, kit.webbing, hips, 0.15, 0.05, -0.1); // belt pouch

  const torso = new THREE.Group();
  hips.add(torso);
  box(0.44, 0.5, 0.26, torso, 0, 0.36, 0, 'body'); // chest
  // Vest with magazine pouches, a pack on the back with a bedroll on top.
  kitBox(0.46, 0.32, 0.29, kit.webbing, torso, 0, 0.4, 0);
  for (const px of [-0.12, 0, 0.12]) kitBox(0.1, 0.12, 0.06, kit.webbing, torso, px, 0.33, -0.17);
  kitBox(0.32, 0.36, 0.16, kit.webbing, torso, 0, 0.42, 0.21);
  deco(new THREE.CylinderGeometry(0.07, 0.07, 0.36, 10).rotateZ(Math.PI / 2), kit.boot, torso, 0, 0.66, 0.21);
  const neck = new THREE.Group();
  neck.position.y = 0.66;
  torso.add(neck);
  // Head in a balaclava, a helmet over it, goggles pushed up on the front.
  part(new THREE.SphereGeometry(0.13, 14, 10), neck, 0, 0.08, 0, 'head', new THREE.Vector3(0.12, 0.13, 0.12));
  deco(new THREE.SphereGeometry(0.155, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), kit.helmet, neck, 0, 0.1, 0.005).scale.set(1, 0.85, 1.05);
  deco(new THREE.CylinderGeometry(0.16, 0.165, 0.025, 14), kit.helmet, neck, 0, 0.1, 0.005);
  kitBox(0.17, 0.045, 0.04, kit.goggles, neck, 0, 0.14, -0.13);

  // Arms and rifle pivot together at the shoulders, so the gun follows the aim.
  const aim = new THREE.Group();
  aim.position.y = 0.52;
  torso.add(aim);
  const rifle = buildRifle();
  rifle.root.position.set(0.12, -0.02, -0.45);
  rifle.root.traverse((o) => (o.castShadow = true));
  aim.add(rifle.root);
  const arm = (from: THREE.Vector3, to: THREE.Vector3) => {
    const d = to.clone().sub(from);
    const m = limb(0.11, d.length(), 0.11, aim, 0, 0, 0, 'limb');
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    deco(new THREE.SphereGeometry(0.05, 10, 8), kit.glove, aim, to.x, to.y, to.z);
  };
  arm(new THREE.Vector3(0.22, 0, 0), new THREE.Vector3(0.12, -0.09, -0.38)); // right hand on the grip
  arm(new THREE.Vector3(-0.22, 0, 0), new THREE.Vector3(0.1, -0.05, -0.66)); // left under the fore-end

  const legs = [-1, 1].map((side) => {
    const thigh = new THREE.Group();
    thigh.position.x = side * 0.1;
    hips.add(thigh);
    limb(0.15, THIGH, 0.17, thigh, 0, -THIGH / 2, 0, 'limb');
    kitBox(0.08, 0.1, 0.05, kit.webbing, thigh, side * 0.07, -THIGH * 0.45, 0); // leg pocket
    const knee = new THREE.Group();
    knee.position.y = -THIGH;
    thigh.add(knee);
    limb(0.13, SHIN, 0.15, knee, 0, -SHIN / 2, 0, 'limb');
    kitBox(0.12, 0.1, 0.05, kit.webbing, knee, 0, -0.04, -0.08); // knee pad
    part(boxUV(new THREE.BoxGeometry(0.14, 0.12, 0.28), 0.3), knee, 0, -SHIN + 0.03, -0.05, 'limb', new THREE.Vector3(0.065, 0.04, 0.13), kit.boot); // boot
    return { thigh, knee };
  });

  // Fold the kit into one mesh per material on each joint (the hit-tested parts stay separate).
  const keep = new Set<THREE.Object3D>(parts);
  root.traverse((o) => o instanceof THREE.Group && o !== rifle.root && mergeChildren(o, keep));

  const cur: Pose = { ...POSES.stand };
  const inv = new THREE.Matrix4(), o = new THREE.Vector3(), d = new THREE.Vector3();
  let phase = 0, lastWalked = NaN, smoothSpeed = 0;

  return {
    root,
    parts,
    muzzle: rifle.muzzle,
    aim,
    pose(stance, pitch, walked, speed, dt) {
      // Ease toward the stance so changes read as movement, not a pop.
      const target = POSES[stance], k = 1 - Math.exp(-dt * 12);
      for (const key of Object.keys(cur) as Array<keyof Pose>) cur[key] += (target[key] - cur[key]) * k;
      smoothSpeed += (speed - smoothSpeed) * (1 - Math.exp(-dt * 6));
      const sp = smoothSpeed;
      const gait = Math.min(1, sp / 1.1); // 0 standing still .. 1 walking
      const run = Math.max(0, Math.min(1, (sp - 2.2) / 2)); // 0 walking .. 1 running
      // Phase: half a cycle per footstep.
      const stride = strideFor(sp);
      const step = Number.isNaN(lastWalked) ? 0 : Math.max(0, Math.min(3, walked - lastWalked));
      lastWalked = walked;
      const before = Math.floor(phase / Math.PI);
      phase += (step / stride) * Math.PI;
      const footDown = Math.floor(phase / Math.PI) !== before;

      const prone = stance === 'prone';
      const amp = prone ? gait * 0.3 : gait;
      // Hips dip as each foot takes the weight; running leans in and lowers the gun.
      hips.position.y = cur.hipY - (prone ? 0 : (0.025 + 0.035 * run) * gait * (0.5 + 0.5 * Math.cos(2 * phase)));
      hips.rotation.x = cur.hipsX;
      hips.rotation.z = prone ? Math.sin(phase) * 0.12 * gait : 0; // crawling: a wriggle
      torso.rotation.x = cur.torsoX - (prone ? 0 : 0.22 * run);
      torso.rotation.y = prone ? 0 : -Math.sin(phase) * (0.06 + 0.06 * run) * gait; // shoulders counter the hips
      const upright = -(cur.hipsX + cur.torsoX); // undo the body tilt for the head and the gun
      aim.rotation.x = upright + pitch - 0.35 * run;
      neck.rotation.x = upright + pitch * 0.6 + 0.15 * run;
      // Swing the thighs far enough to cover the stride (a leg is about 0.93 m), plus a run's extra fold.
      const swing = Math.max(0.25, Math.min(0.85, Math.asin(Math.min(0.95, (stride * 0.5) / 0.93)) * 0.8)), fold = 0.55 + 0.55 * run;
      legs.forEach(({ thigh, knee }, i) => {
        const p = phase + i * Math.PI;
        thigh.rotation.x = cur.thigh + Math.sin(p) * swing * amp;
        // The knee folds while the leg swings through (peaking just as it passes under the body)
        // and gives a little as the foot lands.
        knee.rotation.x = cur.knee - (Math.max(0, Math.cos(p - 0.35)) * fold + 0.08) * amp;
      });
      return footDown && gait > 0.3;
    },
    hitTest(origin, dir, len) {
      let best: { t: number; zone: HitZone } | null = null;
      for (const [mesh, { zone, half }] of hit) {
        inv.copy(mesh.matrixWorld).invert();
        o.copy(origin).applyMatrix4(inv);
        d.copy(dir).transformDirection(inv); // parts aren't scaled, so distances carry over
        const t = rayBox(o, d, half);
        if (t !== null && t <= len && (!best || t < best.t)) best = { t, zone };
      }
      return best;
    },
  };
}

/** Ray vs axis-aligned box centred on the origin: distance to entry, or null. */
function rayBox(o: THREE.Vector3, d: THREE.Vector3, half: THREE.Vector3): number | null {
  let tMin = 0, tMax = Infinity;
  for (const k of ['x', 'y', 'z'] as const) {
    if (Math.abs(d[k]) < 1e-9) {
      if (Math.abs(o[k]) > half[k]) return null;
      continue;
    }
    let t1 = (-half[k] - o[k]) / d[k], t2 = (half[k] - o[k]) / d[k];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  return tMin;
}
