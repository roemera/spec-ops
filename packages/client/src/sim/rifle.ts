import { ACTIVE_RELOAD, BOLT_TIME, MAG_SIZE, MAX_SPARE, RELOAD_GOOD_FINISH, RELOAD_JAM, RELOAD_TIME, START_SPARE } from '@spec-ops/shared';

export type RifleEvent = 'bolted' | 'reloaded' | null;
export type ActiveResult = 'perfect' | 'good' | 'jam';

/**
 * Bolt-action rifle: a magazine, spare rounds, a bolt to work after every shot, magazine swaps.
 * Spare rounds run out; more come from pickups. Reloads are active: press R again in the sweet spot
 * to finish early, miss and it jams.
 */
export class Rifle {
  mag = MAG_SIZE;
  spare = START_SPARE;
  /** s left working the bolt (after a shot) or swapping the magazine. */
  boltLeft = 0;
  reloadLeft = 0;
  /** Elapsed s of the current reload, and how long it will take in all (longer after a jam). */
  reloadT = 0;
  reloadTotal = RELOAD_TIME;
  /** This reload's second press, once made. */
  active: ActiveResult | null = null;

  get ready() {
    return this.mag > 0 && this.boltLeft <= 0 && this.reloadLeft <= 0;
  }
  get reloading() {
    return this.reloadLeft > 0;
  }
  /** 0..1 progress of whatever is busy (bolt or reload); 1 when idle. */
  get busyProgress() {
    if (this.reloadLeft > 0) return this.reloadT / this.reloadTotal;
    if (this.boltLeft > 0) return 1 - this.boltLeft / BOLT_TIME;
    return 1;
  }

  /** Returns true if a round was fired. */
  fire(): boolean {
    if (!this.ready) return false;
    this.mag--;
    if (this.mag > 0) this.boltLeft = BOLT_TIME;
    return true;
  }

  /** Start a magazine swap if it would help. Returns true if one started. */
  reload(): boolean {
    if (this.reloadLeft > 0 || this.mag >= MAG_SIZE || this.spare <= 0) return false;
    this.boltLeft = 0;
    this.reloadLeft = this.reloadTotal = RELOAD_TIME;
    this.reloadT = 0;
    this.active = null;
    return true;
  }

  /** The second R press during a reload: how well it was timed (null if it doesn't count). */
  activeReload(): ActiveResult | null {
    if (this.reloadLeft <= 0 || this.active) return null;
    const k = this.reloadT / RELOAD_TIME;
    const within = (z: readonly [number, number]) => k >= z[0] && k <= z[1];
    if (within(ACTIVE_RELOAD.perfect)) {
      this.active = 'perfect';
      this.reloadLeft = 1e-6; // in on the next update
    } else if (within(ACTIVE_RELOAD.good)) {
      this.active = 'good';
      this.reloadLeft = Math.min(this.reloadLeft, RELOAD_GOOD_FINISH);
    } else {
      this.active = 'jam';
      this.reloadLeft += RELOAD_JAM;
    }
    this.reloadTotal = this.reloadT + this.reloadLeft;
    return this.active;
  }

  update(dt: number): RifleEvent {
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      this.reloadT += dt;
      if (this.reloadLeft > 0) return null;
      // Rounds left in the old magazine go back in the pouch.
      const take = Math.min(MAG_SIZE - this.mag, this.spare);
      this.mag += take;
      this.spare -= take;
      return 'reloaded';
    }
    if (this.boltLeft > 0) {
      this.boltLeft -= dt;
      if (this.boltLeft <= 0) return 'bolted';
    }
    return null;
  }

  /** Rounds from a pickup. Returns how many it took (the pouches hold MAX_SPARE). */
  addSpare(n: number) {
    const take = Math.max(0, Math.min(n, MAX_SPARE - this.spare));
    this.spare += take;
    return take;
  }

  reset() {
    this.mag = MAG_SIZE;
    this.spare = START_SPARE;
    this.boltLeft = this.reloadLeft = this.reloadT = 0;
    this.active = null;
  }
}
