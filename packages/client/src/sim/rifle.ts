import { BOLT_TIME, MAG_SIZE, RELOAD_TIME, SPARE_MAGS } from '@spec-ops/shared';

export type RifleEvent = 'bolted' | 'reloaded' | null;

/** Bolt-action rifle: a magazine, spare rounds, a bolt to work after every shot, magazine swaps. */
export class Rifle {
  mag = MAG_SIZE;
  spare = MAG_SIZE * SPARE_MAGS;
  /** s left working the bolt (after a shot) or swapping the magazine. */
  boltLeft = 0;
  reloadLeft = 0;

  get ready() {
    return this.mag > 0 && this.boltLeft <= 0 && this.reloadLeft <= 0;
  }
  get reloading() {
    return this.reloadLeft > 0;
  }
  /** 0..1 progress of whatever is busy (bolt or reload); 1 when idle. */
  get busyProgress() {
    if (this.reloadLeft > 0) return 1 - this.reloadLeft / RELOAD_TIME;
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
    this.reloadLeft = RELOAD_TIME;
    return true;
  }

  update(dt: number): RifleEvent {
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft > 0) return null;
      // Rounds left in the old magazine go back in the pouch (no tactical-reload penalty).
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

  reset() {
    this.mag = MAG_SIZE;
    this.spare = MAG_SIZE * SPARE_MAGS;
    this.boltLeft = this.reloadLeft = 0;
  }
}
