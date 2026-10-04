import { RELOAD_TIME } from '@skeleton-crew/shared';

/** The cannon reloads itself RELOAD_TIME after every shot. Unlimited shells. */
export class Gun {
  private reloadLeft = 0; // you spawn loaded

  get ready() {
    return this.reloadLeft <= 0;
  }
  /** 0..1 progress of the current reload (1 = loaded). */
  get reloadProgress() {
    return 1 - this.reloadLeft / RELOAD_TIME;
  }

  /** Returns true if a shell was fired. */
  fire(): boolean {
    if (!this.ready) return false;
    this.reloadLeft = RELOAD_TIME;
    return true;
  }

  /** Returns true on the frame the reload finishes. */
  update(dt: number): boolean {
    if (this.reloadLeft <= 0) return false;
    this.reloadLeft -= dt;
    return this.reloadLeft <= 0;
  }

  reset() {
    this.reloadLeft = 0;
  }
}
