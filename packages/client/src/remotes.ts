import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { INTERP_DELAY, type TankState } from '@spec-ops/shared';
import { TankSim } from './sim/tank';
import { buildTankModel, MAN_CENTER, MAN_HALF, TRACK_TEXTURE_LENGTH, type TankModel } from './models/tank';
import type { Audio, Loop } from './audio';

// Other players' tanks: drawn INTERP_DELAY in the past, smoothed between the last two updates.

interface Snap {
  t: number; // local receive time, s
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  turretYaw: number;
  gunPitch: number;
}

const MAX_EXTRAPOLATE = 0.25; // s: keep moving a tank whose updates stopped, but not for long

export interface Remote {
  id: number;
  sim: TankSim;
  model: TankModel;
  engine: Loop;
  snaps: Snap[];
  dead: boolean;
}

const WRECK = new THREE.MeshLambertMaterial({ color: 0x110011 });

export class Remotes {
  readonly byId = new Map<number, Remote>();

  constructor(private physics: RAPIER.World, private scene: THREE.Scene, private audio: Audio) {}

  receive(s: TankState, now: number) {
    let r = this.byId.get(s.id);
    if (!r) r = this.add(s);
    r.snaps.push({
      t: now,
      pos: new THREE.Vector3(...s.pos),
      quat: new THREE.Quaternion(...s.quat),
      vel: new THREE.Vector3(...s.vel),
      turretYaw: s.turretYaw,
      gunPitch: s.gunPitch,
    });
    if (r.snaps.length > 30) r.snaps.shift();
  }

  private add(s: TankState): Remote {
    const sim = new TankSim(this.physics, { x: s.pos[0], z: s.pos[2], rotY: 0 }, s.pos[1] - 2.2, true);
    const model = buildTankModel();
    this.scene.add(model.root);
    const engine = this.audio.loop('engine', new THREE.Vector3(...s.pos));
    const r: Remote = { id: s.id, sim, model, engine, snaps: [], dead: false };
    this.byId.set(s.id, r);
    return r;
  }

  remove(id: number) {
    const r = this.byId.get(id);
    if (!r) return;
    this.scene.remove(r.model.root);
    this.physics.removeRigidBody(r.sim.body);
    r.engine.stop();
    this.byId.delete(id);
  }

  clear() {
    for (const id of [...this.byId.keys()]) this.remove(id);
  }

  /** Destroyed: black wreck, engine off, until `respawn`. */
  kill(id: number) {
    const r = this.byId.get(id);
    if (!r) return;
    r.dead = true;
    r.engine.setVolume(0);
    r.model.man.visible = false;
    r.model.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.userData.mat ??= o.material;
        o.material = WRECK;
      }
    });
  }

  /** Back from the dead at a new spawn: drop old positions so it doesn't slide across the map. */
  respawn(id: number) {
    const r = this.byId.get(id);
    if (!r) return;
    r.dead = false;
    r.snaps.length = 0;
    r.engine.setVolume(1);
    r.model.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.userData.mat) o.material = o.userData.mat;
    });
  }

  /** World position of a remote tank's hatch (the commander's chest). */
  hatchPos(r: Remote, out = new THREE.Vector3()) {
    return r.model.man.localToWorld(out.copy(MAN_CENTER));
  }

  /**
   * Machine-gun check: does the segment from `origin` along `dir` (length `len`) hit any lookout
   * sticking out of a hatch? Returns the nearest hit.
   */
  hitMan(origin: THREE.Vector3, dir: THREE.Vector3, len: number): { remote: Remote; t: number } | null {
    let best: { remote: Remote; t: number } | null = null;
    const inv = new THREE.Matrix4(), o = new THREE.Vector3(), d = new THREE.Vector3();
    for (const r of this.byId.values()) {
      if (!r.model.man.visible) continue;
      r.model.man.updateWorldMatrix(true, false);
      inv.copy(r.model.man.matrixWorld).invert();
      o.copy(origin).applyMatrix4(inv).sub(MAN_CENTER);
      d.copy(dir).transformDirection(inv); // unit length; the man isn't scaled
      const t = rayBox(o, d, MAN_HALF);
      if (t !== null && t <= len && (!best || t < best.t)) best = { remote: r, t };
    }
    return best;
  }

  /** Find the remote tank a collider belongs to. */
  find(collider: RAPIER.Collider) {
    for (const r of this.byId.values()) {
      const role = r.sim.roleOf(collider);
      if (role) return { remote: r, role };
    }
    return null;
  }

  /** Pose every remote tank for render time `now - INTERP_DELAY`. Call once per frame, before physics. */
  update(now: number, dt: number) {
    const t = now - INTERP_DELAY;
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
    for (const r of this.byId.values()) {
      const s = r.snaps;
      if (s.length === 0) continue;
      while (s.length > 2 && s[1].t <= t) s.shift(); // keep the pair around t
      let yaw: number, pitch: number, speed: number;
      if (s.length >= 2 && t >= s[0].t && t <= s[1].t) {
        const k = (t - s[0].t) / Math.max(1e-6, s[1].t - s[0].t);
        pos.lerpVectors(s[0].pos, s[1].pos, k);
        quat.slerpQuaternions(s[0].quat, s[1].quat, k);
        yaw = lerpAngle(s[0].turretYaw, s[1].turretYaw, k);
        pitch = s[0].gunPitch + (s[1].gunPitch - s[0].gunPitch) * k;
        speed = s[1].vel.length();
      } else {
        // Before the first update or past the newest: hold, or coast a little on its velocity.
        const last = t < s[0].t ? s[0] : s[s.length - 1];
        const ahead = Math.min(MAX_EXTRAPOLATE, Math.max(0, t - last.t));
        pos.copy(last.pos).addScaledVector(last.vel, ahead);
        quat.copy(last.quat);
        yaw = last.turretYaw;
        pitch = last.gunPitch;
        speed = last.vel.length();
      }
      r.sim.body.setNextKinematicTranslation(pos);
      r.sim.body.setNextKinematicRotation(quat);
      r.sim.setTurret(yaw, pitch);
      r.model.root.position.copy(pos);
      r.model.root.quaternion.copy(quat);
      r.model.turret.rotation.y = yaw;
      r.model.gun.rotation.x = pitch;
      // The commander is always out of the hatch.
      r.model.man.visible = !r.dead;
      // Cursed but cheap: both tracks scroll at hull speed.
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
      const v = s[s.length - 1].vel.dot(fwd);
      for (const m of r.model.trackMaps) m.offset.y += (v * dt) / TRACK_TEXTURE_LENGTH;
      r.engine.setPosition(pos);
      r.engine.setRate(0.6 + speed / 12);
    }
  }
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

function lerpAngle(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
