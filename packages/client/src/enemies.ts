import * as THREE from 'three';
import { AI_HZ, STANCES, type AiState, type EnemyView, type HitZone, type Stance } from '@spec-ops/shared';
import { buildSoldier, type SoldierModel } from './models/soldier';
import { PAL } from './render/palette';
import type { Audio } from './audio';
import type { Fx } from './fx';
import type { LaserSource } from './render/lasers';

// The enemy, as the server reports it (AI_HZ): drawn a little in the past and smoothed between
// updates. Their state is never shown on screen; you hear it: a "huh?" when one gets suspicious,
// a shout when one spots you.

const DELAY = 1.5 / AI_HZ; // s behind the newest update, so there are always two to blend

interface Snap {
  t: number;
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
}

export interface Enemy {
  id: number;
  model: SoldierModel;
  snaps: Snap[];
  stance: Stance;
  state: AiState;
  locked: boolean; // aimed in on someone: the laser holds steady
  dead: boolean;
  walked: number;
  speed: number;
}

export class Enemies {
  readonly byId = new Map<number, Enemy>();

  constructor(private scene: THREE.Scene, private audio: Audio, private fx: Fx) {}

  receive(list: EnemyView[], now: number) {
    for (const v of list) {
      let e = this.byId.get(v.id);
      if (!e) {
        if (v.dead) continue; // died before we got here: nothing to draw
        e = this.add(v);
      }
      if (v.dead && !e.dead) this.kill(v.id, new THREE.Vector3()); // missed the enemyDown message
      if (e.dead) continue;
      if (v.state !== e.state) this.changed(e, v.state);
      e.stance = v.stance;
      e.locked = v.locked;
      e.snaps.push({ t: now, pos: new THREE.Vector3(v.pos.x, v.pos.y, v.pos.z), yaw: v.yaw, pitch: v.pitch });
      if (e.snaps.length > 20) e.snaps.shift();
    }
  }

  /** A new match: everyone is back. */
  clear() {
    for (const e of this.byId.values()) this.scene.remove(e.model.root);
    this.byId.clear();
  }

  private add(v: EnemyView): Enemy {
    const model = buildSoldier(PAL.enemy);
    model.root.position.set(v.pos.x, v.pos.y, v.pos.z);
    model.root.rotation.y = v.yaw;
    this.scene.add(model.root);
    const e: Enemy = { id: v.id, model, snaps: [], stance: v.stance, state: v.state, locked: false, dead: false, walked: 0, speed: 0 };
    this.byId.set(v.id, e);
    return e;
  }

  /** What you hear when an enemy's mood changes. */
  private changed(e: Enemy, state: AiState) {
    const at = e.model.root.position.clone().setY(e.model.root.position.y + 1.6);
    if (state === 'alert') this.audio.play('shout', { pos: at, volume: 1.4, rate: 0.9 + Math.random() * 0.2 });
    else if (state === 'suspicious' && e.state === 'patrol') this.audio.play('huh', { pos: at, rate: 0.9 + Math.random() * 0.2 });
    e.state = state;
  }

  /** Killed: the body shatters along the bullet's direction. */
  kill(id: number, dir: THREE.Vector3) {
    const e = this.byId.get(id);
    if (!e || e.dead) return;
    e.dead = true;
    e.model.root.visible = false;
    this.fx.shatter(e.model.parts, dir, PAL.enemy);
    this.audio.play('shatter', { pos: e.model.root.position.clone().setY(e.model.root.position.y + 1) });
  }

  /** Every living enemy's laser: where its rifle is and which way it points. */
  *lasers(): Iterable<LaserSource> {
    for (const e of this.byId.values()) {
      if (e.dead || e.snaps.length === 0) continue;
      yield { id: e.id, muzzle: e.model.muzzle, aim: e.model.aim, state: e.state, locked: e.locked };
    }
  }

  /** Which living enemy (and body part) a bullet step from `origin` along `dir` hits first. */
  hitTest(origin: THREE.Vector3, dir: THREE.Vector3, len: number): { enemy: Enemy; t: number; zone: HitZone } | null {
    let best: { enemy: Enemy; t: number; zone: HitZone } | null = null;
    const v = new THREE.Vector3();
    for (const e of this.byId.values()) {
      if (e.dead) continue;
      // Cheap reject: the step doesn't pass near this soldier.
      v.copy(e.model.root.position).sub(origin);
      const t = Math.max(0, Math.min(len, v.dot(dir)));
      if (v.addScaledVector(dir, -t).length() > 2.5) continue;
      const h = e.model.hitTest(origin, dir, len);
      if (h && (!best || h.t < best.t)) best = { enemy: e, ...h };
    }
    return best;
  }

  update(now: number, dt: number) {
    const t = now - DELAY, pos = new THREE.Vector3();
    for (const e of this.byId.values()) {
      const s = e.snaps;
      if (e.dead || s.length === 0) continue;
      while (s.length > 2 && s[1].t <= t) s.shift();
      let yaw: number, pitch: number;
      if (s.length >= 2 && t >= s[0].t && t <= s[1].t) {
        const k = (t - s[0].t) / Math.max(1e-6, s[1].t - s[0].t);
        pos.lerpVectors(s[0].pos, s[1].pos, k);
        yaw = lerpAngle(s[0].yaw, s[1].yaw, k);
        pitch = s[0].pitch + (s[1].pitch - s[0].pitch) * k;
      } else {
        const last = t < s[0].t ? s[0] : s[s.length - 1];
        pos.copy(last.pos);
        yaw = last.yaw;
        pitch = last.pitch;
      }
      const root = e.model.root;
      const moved = Math.hypot(pos.x - root.position.x, pos.z - root.position.z);
      e.speed += ((dt > 0 ? moved / dt : 0) - e.speed) * Math.min(1, dt * 8);
      if (moved < 3) e.walked += moved;
      root.position.copy(pos);
      root.rotation.y = yaw;
      // Footsteps when a foot comes down: their boots in the snow, so you can hear a patrol coming.
      if (e.model.pose(e.stance, pitch, e.walked, e.speed, dt)) {
        const volume = e.speed > 2.5 ? 0.3 : 0.16; // soft: a patrol close by, not a parade
        this.audio.play('step', { pos: pos.clone().setY(pos.y + STANCES[e.stance].height * 0.1), volume, rate: 0.85 + Math.random() * 0.2 });
      }
      root.updateMatrixWorld(true); // hit tests this frame use the new pose
    }
  }
}

function lerpAngle(a: number, b: number, k: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
