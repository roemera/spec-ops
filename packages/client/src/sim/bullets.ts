import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GRAVITY, MG_LIFETIME } from '@spec-ops/shared';

/** Bullets: member of group 5; hit solid things (not sensors, not debris). */
const BULLET_GROUPS = 0x0010_fffd;

export interface Bullet {
  id: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  owner: RAPIER.RigidBody | undefined;
  life: number;
  visual: boolean; // another player's bullet: drawn here, its owner reports hits
}

/**
 * Machine-gun bullets. They stop on terrain, rocks, buildings and tanks without hurting them;
 * `probe` checks for a lookout in the way (that's all bullets can hurt).
 */
export class Bullets {
  readonly live: Bullet[] = [];
  private nextId = 1;

  constructor(
    private world: RAPIER.World,
    private probe: (origin: THREE.Vector3, dir: THREE.Vector3, len: number) => { t: number; target: number } | null,
    private onHitMan: (b: Bullet, target: number, point: THREE.Vector3) => void,
    private onImpact: (b: Bullet, point: THREE.Vector3) => void,
  ) {}

  spawn(pos: THREE.Vector3, vel: THREE.Vector3, owner: RAPIER.RigidBody | undefined, visual = false): Bullet {
    const b = { id: this.nextId++, pos: pos.clone(), vel: vel.clone(), owner, life: MG_LIFETIME, visual };
    this.live.push(b);
    return b;
  }

  step(dt: number) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const b = this.live[i];
      b.life -= dt;
      const next = b.pos.clone().addScaledVector(b.vel, dt);
      next.y -= 0.5 * GRAVITY * dt * dt;
      b.vel.y -= GRAVITY * dt;
      const seg = next.clone().sub(b.pos), len = seg.length(), dir = seg.divideScalar(len);
      const ray = new RAPIER.Ray(b.pos, dir);
      const hit = this.world.castRay(ray, len, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, BULLET_GROUPS, undefined, b.owner);
      const wall = hit ? hit.timeOfImpact : Infinity;
      const man = this.probe(b.pos, dir, len);
      if (man && man.t < wall) {
        this.onHitMan(b, man.target, b.pos.clone().addScaledVector(dir, man.t));
        this.live.splice(i, 1);
      } else if (hit) {
        this.onImpact(b, b.pos.clone().addScaledVector(dir, wall));
        this.live.splice(i, 1);
      } else if (b.life <= 0) this.live.splice(i, 1);
      else b.pos.copy(next);
    }
  }
}
