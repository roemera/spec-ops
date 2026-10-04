import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GRAVITY, SHELL_LIFETIME } from '@spec-ops/shared';

/** Shells: member of group 4, hit everything except debris (group 2). */
const SHELL_GROUPS = 0x0008_fffd;
const MAX_PASS_THROUGH = 4;

export interface ShellHit {
  collider: RAPIER.Collider;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  dir: THREE.Vector3; // shell travel direction at impact
}

/** What the game decides a hit does: stop the shell, or let it carry on (fences, trees). */
export type HitOutcome = 'stop' | 'pass';

export interface Shell {
  id: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  owner: RAPIER.RigidBody | undefined;
  life: number;
  /** Another player's shell: drawn and exploded here, but only its owner reports hits. */
  visual: boolean;
}

export class Shells {
  readonly live: Shell[] = [];
  private nextId = 1;

  constructor(private world: RAPIER.World, private onHit: (shell: Shell, hit: ShellHit) => HitOutcome) {}

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, owner: RAPIER.RigidBody | undefined, visual = false): Shell {
    const s = { id: this.nextId++, pos: pos.clone(), vel: vel.clone(), owner, life: SHELL_LIFETIME, visual };
    this.live.push(s);
    return s;
  }

  step(dt: number) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const s = this.live[i];
      s.life -= dt;
      const next = s.pos.clone().addScaledVector(s.vel, dt);
      next.y -= 0.5 * GRAVITY * dt * dt;
      s.vel.y -= GRAVITY * dt;
      if (s.life <= 0 || this.trace(s, next)) {
        this.live.splice(i, 1);
        continue;
      }
      s.pos.copy(next);
    }
  }

  /** Sweep the shell from its position to `next`. Returns true if it stopped. */
  private trace(s: Shell, next: THREE.Vector3): boolean {
    const passed = new Set<number>();
    const seg = next.clone().sub(s.pos);
    const len = seg.length();
    if (len < 1e-6) return false;
    const dir = seg.divideScalar(len);
    const ray = new RAPIER.Ray({ x: s.pos.x, y: s.pos.y, z: s.pos.z }, { x: dir.x, y: dir.y, z: dir.z });
    for (let k = 0; k < MAX_PASS_THROUGH; k++) {
      const hit = this.world.castRayAndGetNormal(ray, len, true, undefined, SHELL_GROUPS, undefined, s.owner, (c) => !passed.has(c.handle));
      if (!hit) return false;
      const point = new THREE.Vector3(s.pos.x + dir.x * hit.timeOfImpact, s.pos.y + dir.y * hit.timeOfImpact, s.pos.z + dir.z * hit.timeOfImpact);
      const outcome = this.onHit(s, {
        collider: hit.collider,
        point,
        normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
        dir: dir.clone(),
      });
      if (outcome === 'stop') {
        s.pos.copy(point);
        return true;
      }
      passed.add(hit.collider.handle);
    }
    return false;
  }
}
