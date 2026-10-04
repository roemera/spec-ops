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

/** One soldier's health. The server owns it online; offline the client does. */
export class Health {
  health = PLAYER_HEALTH;

  get dead() {
    return this.health <= 0;
  }

  applyHit(zone: HitZone): HitResult {
    const damage = ZONE_DAMAGE[zone];
    this.health = Math.max(0, this.health - damage);
    return { zone, damage, health: this.health, killed: this.dead };
  }

  reset() {
    this.health = PLAYER_HEALTH;
  }
}
