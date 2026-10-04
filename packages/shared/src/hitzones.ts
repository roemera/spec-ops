import { PLAYER_HEALTH, REGEN_DELAY, REGEN_RATE } from './constants.ts';

// Where a bullet hits a soldier decides the damage. A rifle round to the head or body kills.

export type HitZone = 'head' | 'body' | 'limb';

export const ZONE_DAMAGE: Record<HitZone, number> = {
  head: 200,
  body: 100,
  limb: 55, // two limb hits kill
};

export const ZONE_LABEL: Record<HitZone, string> = {
  head: 'HEADSHOT',
  body: 'BODY',
  limb: 'LIMB',
};

export interface HitResult {
  zone: HitZone;
  damage: number;
  health: number;
  killed: boolean;
}

/** One soldier's health. The server owns it online; offline the client does. */
export class Health {
  readonly max: number;
  health: number;
  sinceHit = Infinity; // s since the last hit, for regeneration

  constructor(max = PLAYER_HEALTH) {
    this.max = this.health = max;
  }

  get dead() {
    return this.health <= 0;
  }

  /** `scale` < 1 for weaker guns (enemy rifles). */
  applyHit(zone: HitZone, scale = 1): HitResult {
    const damage = Math.round(ZONE_DAMAGE[zone] * scale);
    this.health = Math.max(0, this.health - damage);
    this.sinceHit = 0;
    return { zone, damage, health: this.health, killed: this.dead };
  }

  /** Players heal after a while without being hit. Returns true if health changed. */
  regen(dt: number): boolean {
    this.sinceHit += dt;
    if (this.dead || this.health >= this.max || this.sinceHit < REGEN_DELAY) return false;
    this.health = Math.min(this.max, this.health + REGEN_RATE * dt);
    return true;
  }

  reset() {
    this.health = this.max;
    this.sinceHit = Infinity;
  }
}
