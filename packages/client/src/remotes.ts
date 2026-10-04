import * as THREE from 'three';
import { INTERP_DELAY, STANCES, type Life, type SoldierState, type Stance } from '@spec-ops/shared';
import { buildSoldier, type SoldierModel } from './models/soldier';
import { PAL } from './render/palette';
import type { Audio } from './audio';

// Other players (your squad): drawn INTERP_DELAY in the past, smoothed between the last two updates.
// Bullets pass through them: there is no friendly fire.

interface Snap {
  t: number; // local receive time, s
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  stance: Stance;
}

const MAX_EXTRAPOLATE = 0.25; // s: keep moving someone whose updates stopped, but not for long
const STRIDE = 0.75; // m per footstep (and per half walk cycle)

export interface Remote {
  id: number;
  model: SoldierModel;
  snaps: Snap[];
  life: Life;
  stance: Stance;
  walked: number; // m, drives footsteps and the walk cycle
  nextStep: number;
}

export class Remotes {
  readonly byId = new Map<number, Remote>();

  constructor(private scene: THREE.Scene, private audio: Audio) {}

  receive(s: SoldierState, now: number) {
    let r = this.byId.get(s.id);
    if (!r) r = this.add(s);
    r.snaps.push({ t: now, pos: new THREE.Vector3(...s.pos), vel: new THREE.Vector3(...s.vel), yaw: s.yaw, pitch: s.pitch, stance: s.stance });
    if (r.snaps.length > 30) r.snaps.shift();
  }

  private add(s: SoldierState): Remote {
    const model = buildSoldier(PAL.friend);
    model.root.position.set(...s.pos);
    this.scene.add(model.root);
    const r: Remote = { id: s.id, model, snaps: [], life: 'up', stance: s.stance, walked: 0, nextStep: STRIDE };
    this.byId.set(s.id, r);
    return r;
  }

  remove(id: number) {
    const r = this.byId.get(id);
    if (!r) return;
    this.scene.remove(r.model.root);
    this.byId.delete(id);
  }

  /** Up, down (lying in the snow, rolled on one side) or out (the body is gone; the caller shatters it). */
  setLife(id: number, life: Life) {
    const r = this.byId.get(id);
    if (!r) return;
    r.life = life;
    r.model.root.visible = life !== 'dead';
  }

  /** Pose every remote for render time `now - INTERP_DELAY`. */
  update(now: number, dt: number) {
    const t = now - INTERP_DELAY;
    const pos = new THREE.Vector3();
    for (const r of this.byId.values()) {
      const s = r.snaps;
      if (s.length === 0 || r.life === 'dead') continue;
      while (s.length > 2 && s[1].t <= t) s.shift(); // keep the pair around t
      let yaw: number, pitch: number;
      if (s.length >= 2 && t >= s[0].t && t <= s[1].t) {
        const k = (t - s[0].t) / Math.max(1e-6, s[1].t - s[0].t);
        pos.lerpVectors(s[0].pos, s[1].pos, k);
        yaw = lerpAngle(s[0].yaw, s[1].yaw, k);
        pitch = s[0].pitch + (s[1].pitch - s[0].pitch) * k;
      } else {
        // Before the first update or past the newest: hold, or coast a little on its velocity.
        const last = t < s[0].t ? s[0] : s[s.length - 1];
        const ahead = Math.min(MAX_EXTRAPOLATE, Math.max(0, t - last.t));
        pos.copy(last.pos).addScaledVector(last.vel, ahead);
        yaw = last.yaw;
        pitch = last.pitch;
      }
      const newest = s[s.length - 1];
      r.stance = newest.stance;
      const moved = Math.hypot(pos.x - r.model.root.position.x, pos.z - r.model.root.position.z);
      if (moved < 3) r.walked += moved; // not a respawn jump
      r.model.root.position.copy(pos);
      r.model.root.rotation.y = yaw;
      r.model.root.rotation.z = r.life === 'down' ? 0.9 : 0; // down: rolled onto one side
      const speed = Math.hypot(newest.vel.x, newest.vel.z);
      r.model.pose(r.stance, pitch, (r.walked / STRIDE) * Math.PI, Math.min(1, speed / 2), dt);
      // Footsteps: quieter crouched, almost silent prone.
      if (r.walked >= r.nextStep) {
        r.nextStep = r.walked + STRIDE;
        const volume = r.stance === 'stand' ? (speed > 4 ? 1.2 : 0.8) : r.stance === 'crouch' ? 0.35 : 0.12;
        this.audio.play('step', { pos: pos.clone().setY(pos.y + STANCES[r.stance].height * 0.1), volume, rate: 0.9 + Math.random() * 0.2 });
      }
      r.model.root.updateMatrixWorld(true); // hit tests this frame use the new pose
    }
  }
}

function lerpAngle(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
