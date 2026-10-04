import * as THREE from 'three';
import type { HitZone, Stance } from '@spec-ops/shared';
import { flat } from '../render/palette';
import { buildRifle } from './rifle';

// A low poly soldier, one colour, faceless. Origin at the feet, facing -z.
// Joints are groups; pose() sets them from a stance blend, the aim pitch and a walk phase.

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
  /** `phase` advances with distance walked; `amount` 0..1 is how much the legs swing. */
  pose(stance: Stance, pitch: number, phase: number, amount: number, dt: number): void;
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

  return {
    root,
    parts,
    pose(stance, pitch, phase, amount, dt) {
      // Ease toward the stance so changes read as movement, not a pop.
      const target = POSES[stance], k = 1 - Math.exp(-dt * 12);
      for (const key of Object.keys(cur) as Array<keyof Pose>) cur[key] += (target[key] - cur[key]) * k;
      hips.position.y = cur.hipY;
      hips.rotation.x = cur.hipsX;
      torso.rotation.x = cur.torsoX;
      const upright = -(cur.hipsX + cur.torsoX); // undo the body tilt for the head and the gun
      aim.rotation.x = upright + pitch;
      neck.rotation.x = upright + pitch * 0.6;
      // Walk: legs swing in opposite phase; each knee bends while its foot swings forward.
      const amp = stance === 'prone' ? amount * 0.25 : amount;
      legs.forEach(({ thigh, knee }, i) => {
        const p = phase + i * Math.PI;
        thigh.rotation.x = cur.thigh + Math.sin(p) * 0.45 * amp;
        knee.rotation.x = cur.knee - Math.max(0, Math.cos(p)) * 0.7 * amp;
      });
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
