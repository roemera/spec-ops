import * as THREE from 'three';
import type { HitZone, Stance } from '@spec-ops/shared';
import { flat } from '../render/palette';
import { buildRifle } from './rifle';

// A low poly soldier, one colour, faceless. Origin at the feet, facing -z.
// Joints are groups; pose() sets them from a stance blend, the aim pitch and how far and fast it walks.
//
// The gait: strides lengthen with speed (so legs don't spin at a run), each knee folds as its leg
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

export function buildSoldier(color: number): SoldierModel {
  const mat = flat(color);
  const root = new THREE.Group();
  const parts: THREE.Mesh[] = [];
  const hit = new Map<THREE.Mesh, { zone: HitZone; half: THREE.Vector3 }>();

  const part = (geo: THREE.BufferGeometry, parent: THREE.Object3D, x: number, y: number, z: number, zone: HitZone, half: THREE.Vector3) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    parent.add(m);
    parts.push(m);
    hit.set(m, { zone, half });
    return m;
  };
  const box = (w: number, h: number, d: number, parent: THREE.Object3D, x: number, y: number, z: number, zone: HitZone) =>
    part(new THREE.BoxGeometry(w, h, d), parent, x, y, z, zone, new THREE.Vector3(w / 2, h / 2, d / 2));

  const hips = new THREE.Group();
  root.add(hips);
  box(0.36, 0.2, 0.22, hips, 0, 0.02, 0, 'body'); // pelvis

  const torso = new THREE.Group();
  hips.add(torso);
  box(0.44, 0.5, 0.26, torso, 0, 0.36, 0, 'body'); // chest
  const neck = new THREE.Group();
  neck.position.y = 0.66;
  torso.add(neck);
  part(new THREE.IcosahedronGeometry(0.13, 1), neck, 0, 0.08, 0, 'head', new THREE.Vector3(0.12, 0.13, 0.12));

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
    const m = box(0.11, d.length(), 0.11, aim, 0, 0, 0, 'limb');
    m.position.copy(from).add(to).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  };
  arm(new THREE.Vector3(0.22, 0, 0), new THREE.Vector3(0.12, -0.09, -0.38)); // right hand on the grip
  arm(new THREE.Vector3(-0.22, 0, 0), new THREE.Vector3(0.1, -0.05, -0.66)); // left under the fore-end

  const legs = [-1, 1].map((side) => {
    const thigh = new THREE.Group();
    thigh.position.x = side * 0.1;
    hips.add(thigh);
    box(0.15, THIGH, 0.17, thigh, 0, -THIGH / 2, 0, 'limb');
    const knee = new THREE.Group();
    knee.position.y = -THIGH;
    thigh.add(knee);
    box(0.13, SHIN, 0.15, knee, 0, -SHIN / 2, 0, 'limb');
    box(0.13, 0.08, 0.26, knee, 0, -SHIN + 0.02, -0.05, 'limb'); // boot
    return { thigh, knee };
  });

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
      // Phase: half a cycle per stride; strides get longer the faster you go.
      const stride = 0.55 + 0.28 * sp;
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
      const swing = 0.32 + 0.3 * run, fold = 0.55 + 0.55 * run;
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
