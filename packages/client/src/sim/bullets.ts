import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BULLET_LIFETIME, GRAVITY, type HitZone } from '@spec-ops/shared';

export interface Bullet {
  id: number;
  start: THREE.Vector3; // where the trail starts (the muzzle you see)
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  owner: RAPIER.RigidBody | undefined;
  life: number;
  visual: boolean; // another player's bullet: drawn here, its owner reports hits
}

/** A soldier the bullet hit: whoever `probe` found, how far along the step, which zone. */
export interface SoldierHit {
  t: number;
  target: number;
  zone: HitZone;
}

/**
 * Rifle bullets with drop. Each step sweeps a ray: soldiers come from `probe` (they have no
 * colliders), everything else from Rapier. The nearer hit wins.
 */
export class Bullets {
  readonly live: Bullet[] = [];
  private nextId = 1;

  constructor(
    private world: RAPIER.World,
    private probe: (origin: THREE.Vector3, dir: THREE.Vector3, len: number) => SoldierHit | null,
    private onHitSoldier: (b: Bullet, hit: SoldierHit, point: THREE.Vector3, dir: THREE.Vector3) => void,
    private onImpact: (b: Bullet, point: THREE.Vector3, normal: THREE.Vector3) => void,
  ) {}

  spawn(start: THREE.Vector3, pos: THREE.Vector3, vel: THREE.Vector3, owner: RAPIER.RigidBody | undefined, visual = false): Bullet {
    const b = { id: this.nextId++, start: start.clone(), pos: pos.clone(), vel: vel.clone(), owner, life: BULLET_LIFETIME, visual };
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
      const hit = this.world.castRayAndGetNormal(new RAPIER.Ray(b.pos, dir), len, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, b.owner);
      const wall = hit ? hit.timeOfImpact : Infinity;
      const soldier = this.probe(b.pos, dir, len);
      if (soldier && soldier.t < wall) {
        b.pos.addScaledVector(dir, soldier.t);
        this.onHitSoldier(b, soldier, b.pos.clone(), dir);
        this.live.splice(i, 1);
      } else if (hit) {
        b.pos.addScaledVector(dir, wall);
        this.onImpact(b, b.pos.clone(), new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z));
        this.live.splice(i, 1);
      } else if (b.life <= 0) this.live.splice(i, 1);
      else b.pos.copy(next);
    }
  }
}
