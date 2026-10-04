import { PLAYER_HEALTH } from './constants.ts';

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

/** One soldier's health. The server owns it; it only comes back from medkits (and a revive). */
export class Health {
  readonly max: number;
  health: number;

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
    return { zone, damage, health: this.health, killed: this.dead };
  }

  /** A medkit: up to `amount` back, never over the maximum. Returns what it actually gave. */
  heal(amount: number): number {
    const before = this.health;
    this.health = Math.min(this.max, this.health + amount);
    return this.health - before;
  }

  reset() {
    this.health = this.max;
  }
}
