// Keyboard + mouse. Key presses are queued as events (levers step once per press);
// held keys and mouse motion are polled each frame.

export class Input {
  private held = new Set<string>();
  private pressed: string[] = [];
  mouseDX = 0;
  mouseDY = 0;
  mouseButtons = new Set<number>();
  mouseX = 0; // canvas pixels (low-res space), for the loader cursor
  mouseY = 0;
  clicks: Array<{ x: number; y: number; button: number; locked: boolean }> = []; // locked: was the mouse captured when clicked
  everLocked = false;

  constructor(private target: HTMLElement, private toLowRes: (cx: number, cy: number) => [number, number]) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (!e.repeat) this.pressed.push(e.code);
      this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
    window.addEventListener('mousemove', (e) => {
      if (this.locked) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
      [this.mouseX, this.mouseY] = this.toLowRes(e.clientX, e.clientY);
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // middle button: machine gun, not autoscroll
      this.mouseButtons.add(e.button);
      const [x, y] = this.toLowRes(e.clientX, e.clientY);
      this.clicks.push({ x, y, button: e.button, locked: this.locked });
    });
    window.addEventListener('mouseup', (e) => this.mouseButtons.delete(e.button));
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      if (this.locked) this.everLocked = true;
    });
  }

  get locked() {
    return document.pointerLockElement === this.target;
  }
  lock() {
    if (!this.locked) this.target.requestPointerLock()?.catch?.(() => {});
  }
  unlock() {
    if (this.locked) document.exitPointerLock();
  }

  isHeld(code: string) {
    return this.held.has(code);
  }
  /** Key presses since the last call. */
  takePresses() {
    const p = this.pressed;
    this.pressed = [];
    return p;
  }
  takeMouse() {
    const d = [this.mouseDX, this.mouseDY];
    this.mouseDX = this.mouseDY = 0;
    return d;
  }
  takeClicks() {
    const c = this.clicks;
    this.clicks = [];
    return c;
  }
}
