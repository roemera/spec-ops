import { TANK_HEALTH } from './constants.ts';

// Where a shell hits decides the damage and which part it can break (design doc, Damage table).

export type Part = 'tracks' | 'engine' | 'turretRing' | 'gun' | 'optics';
// 'man': a machine-gun bullet hit the commander sticking out of the hatch.
export type HitZone = 'front' | 'side' | 'rear' | 'turret' | 'barrel' | 'top' | 'man';

export interface ZoneRule {
  damage: number;
  part: Part | null;
  chance: number; // 0..1 chance to break the part
}

export const HIT_ZONES: Record<HitZone, ZoneRule> = {
  front: { damage: 50, part: null, chance: 0 }, // 2 shots
  side: { damage: 100, part: 'tracks', chance: 0.5 }, // 1 shot
  rear: { damage: 50, part: 'engine', chance: 0.5 }, // 2 shots
  turret: { damage: 25, part: 'turretRing', chance: 0.4 },
  barrel: { damage: 10, part: 'gun', chance: 1 },
  top: { damage: 40, part: 'optics', chance: 0.5 },
  man: { damage: 34, part: null, chance: 0 }, // 3 machine-gun hits
};

export const REPAIR_TIME: Record<Part, number> = {
  tracks: 10,
  engine: 15,
  turretRing: 10,
  gun: 12,
  optics: 8,
};

export const ZONE_LABEL: Record<HitZone, string> = {
  front: 'FRONT HULL',
  side: 'SIDE HULL',
  rear: 'REAR HULL',
  turret: 'TURRET',
  barrel: 'GUN BARREL',
  top: 'TOP',
  man: 'MACHINE GUN',
};

export const PART_LABEL: Record<Part, string> = {
  tracks: 'TRACKS',
  engine: 'ENGINE',
  turretRing: 'TURRET RING',
  gun: 'GUN',
  optics: 'OPTICS',
};

/**
 * Classify a hull hit from the surface normal in the hull's local frame (forward is -z).
 * A face pointing up is a top hit; otherwise the dominant horizontal axis decides.
 */
export function hullZone(nx: number, ny: number, nz: number): HitZone {
  if (ny > 0.7) return 'top';
  if (Math.abs(nz) >= Math.abs(nx)) return nz < 0 ? 'front' : 'rear';
  return 'side';
}

export interface HitResult {
  zone: HitZone;
  damage: number;
  broke: Part | null;
  health: number;
  destroyed: boolean;
}

/** Health and broken parts of one tank. The server owns this from milestone 4; offline the client does. */
export class TankDamage {
  health = TANK_HEALTH;
  /** Seconds until each broken part repairs itself; absent = working. */
  broken = new Map<Part, number>();

  get destroyed() {
    return this.health <= 0;
  }
  isBroken(part: Part) {
    return this.broken.has(part);
  }

  /** Apply a hit. `roll` is a 0..1 random number (passed in so callers control randomness). */
  applyHit(zone: HitZone, roll: number): HitResult {
    const rule = HIT_ZONES[zone];
    this.health = Math.max(0, this.health - rule.damage);
    let broke: Part | null = null;
    if (rule.part && roll < rule.chance) {
      broke = rule.part;
      this.broken.set(broke, REPAIR_TIME[broke]);
    }
    return { zone, damage: rule.damage, broke, health: this.health, destroyed: this.destroyed };
  }

  breakPart(part: Part) {
    this.broken.set(part, REPAIR_TIME[part]);
  }

  /** Parts repair themselves over time. Returns parts that were repaired this tick. */
  update(dt: number): Part[] {
    const repaired: Part[] = [];
    for (const [part, t] of this.broken) {
      if (t - dt <= 0) {
        this.broken.delete(part);
        repaired.push(part);
      } else this.broken.set(part, t - dt);
    }
    return repaired;
  }

  reset() {
    this.health = TANK_HEALTH;
    this.broken.clear();
  }
}
