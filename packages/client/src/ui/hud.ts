import { ACTIVE_RELOAD, BULLET_SPEED, GRAVITY, PLAYER_HEALTH, type Score, type Stance } from '@spec-ops/shared';
import { accuracy } from './menu';

// Full-resolution HUD on a 2D canvas over the 3D view. Minimal and flat: dark ink on the bright
// snow, red for danger and kills, white only inside the black scope.

export const HUD_COLORS = {
  ink: '#1b1f23',
  inkSoft: 'rgba(27,31,35,0.55)',
  red: '#e3221a',
  white: '#ffffff',
  paper: 'rgba(245,247,249,0.92)',
  signal: '#ff7a1a', // the objective
} as const;
const C = HUD_COLORS;

const FONT = 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
const STANCE_LABEL: Record<Stance, string> = { stand: 'STANDING', crouch: 'CROUCHED', prone: 'PRONE' };

export interface HudState {
  time: number;
  locked: boolean;
  everLocked: boolean; // the full instructions show only until the first time you click in
  scoped: boolean; // looking through the scope (fully raised)
  fovDeg: number; // vertical fov of the current view
  spreadRad: number; // hip-fire cone half-angle, drawn as the crosshair gap
  viewHeading: number; // degrees, where the camera looks (0 = north)
  health: number;
  stance: Stance;
  mag: number;
  active: 'perfect' | 'good' | 'jam' | null; // this reload's second R press, once made
  busy: 'bolt' | 'reload' | null;
  busyProgress: number; // 0..1
  breath: number; // 0..1 of held breath left
  holding: boolean; // holding breath right now
  hitMarker: { age: number; kill: boolean } | null;
  message: { text: string; color: string } | null;
  scores: Score[] | null; // shown while Tab is held (online only)
  myId: number;
  down: { by: string; zone: string; bleedOut: number; help: boolean; out: boolean } | null; // help: a teammate is still up
  revive: { name: string; progress: number } | null; // next to a downed teammate
  protectedFor: number; // s of spawn protection left
  hurt: number; // 0..1 red flash after being hit
}

export class Hud {
  private ctx: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(width: number, height: number) {
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.w = width;
    this.h = height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private text(s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'left', weight = 600) {
    const ctx = this.ctx;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = `${Math.round(size * 0.08)}px`;
    ctx.fillStyle = color;
    // A soft halo in the opposite tone keeps text readable over both snow and dark pines.
    const dark = color === C.ink || color === C.inkSoft || color === '#000';
    ctx.shadowColor = dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 4;
    ctx.fillText(s, x, y);
    ctx.shadowBlur = 0;
  }

  draw(s: HudState) {
    const { ctx, w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (s.down) this.drawDown(s);
    else {
      if (s.scoped) this.drawScope(s);
      else this.drawCrosshair(s);
      this.drawHitMarker(s);
      this.drawCompass(s);
      this.drawStatus(s);
      this.drawAmmo(s);
      if (s.revive) this.drawRevive(s);
      // Red edges: a hard flash when hit, fading, over a steady glow while badly hurt.
      const low = Math.max(0, 1 - s.health / (PLAYER_HEALTH * 0.6)); // from 60% health down
      const edge = Math.min(0.9, 0.8 * s.hurt ** 0.7 + 0.45 * low);
      if (edge > 0) {
        const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * (0.25 - 0.1 * s.hurt), w / 2, h / 2, Math.max(w, h) * 0.7);
        g.addColorStop(0, 'rgba(227,34,26,0)');
        g.addColorStop(1, `rgba(227,34,26,${edge.toFixed(2)})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      if (s.hurt > 0.6) {
        ctx.fillStyle = `rgba(227,34,26,${(0.6 * (s.hurt - 0.6)).toFixed(2)})`; // the whole screen, for an instant
        ctx.fillRect(0, 0, w, h);
      }
      if (s.protectedFor > 0) this.text(`SPAWN PROTECTION ${Math.ceil(s.protectedFor)}`, w / 2, 64, 13, s.scoped ? C.white : C.ink, 'center');
      if (s.message) this.text(s.message.text, w / 2, h * 0.64, 16, s.scoped && s.message.color === C.ink ? C.white : s.message.color, 'center', 700);
    }
    if (s.scores) this.drawScores(s.scores, s.myId);
    if (!s.locked) {
      if (s.everLocked) this.drawGrabMouse();
      else this.drawClickToPlay();
    }
  }

  /** Hip fire: four ticks around a dot, opened up by the spread. */
  private drawCrosshair(s: HudState) {
    const { ctx, w, h } = this;
    const cx = w / 2, cy = h / 2;
    const gap = 4 + Math.tan(s.spreadRad) * (h / 2) / Math.tan(((s.fovDeg / 2) * Math.PI) / 180);
    ctx.fillStyle = C.ink;
    ctx.fillRect(cx - 1, cy - 1, 2, 2);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = cx + dx * gap, y = cy + dy * gap;
      if (dx) ctx.fillRect(dx > 0 ? x : x - 8, y - 1, 8, 2);
      else ctx.fillRect(x - 1, dy > 0 ? y : y - 8, 2, 8);
    }
  }

  /** Through the scope: black all round, thin crosshair, heavy posts, bullet-drop marks below centre. */
  private drawScope(s: HudState) {
    const { ctx, w, h } = this;
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.46;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
    ctx.fill();
    // Soft dark edge inside the tube.
    const g = ctx.createRadialGradient(cx, cy, r * 0.82, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#000';
    ctx.fillRect(cx - r, cy - 0.5, r * 2, 1);
    ctx.fillRect(cx - 0.5, cy - r, 1, r * 2);
    const post = r * 0.62;
    ctx.fillRect(cx - r, cy - 2, r - post, 4);
    ctx.fillRect(cx + post, cy - 2, r - post, 4);
    ctx.fillRect(cx - 2, cy + post, 4, r - post);
    ctx.fillRect(cx - 2, cy - r, 4, r - post);

    // Drop marks: where to put a target at 200/300/400 m (the scope is zeroed at 100 m).
    const pxPerRad = h / ((s.fovDeg * Math.PI) / 180);
    const drop = (m: number) => (GRAVITY * m) / (2 * BULLET_SPEED * BULLET_SPEED);
    for (const m of [200, 300, 400]) {
      const y = cy + (drop(m) - drop(100)) * pxPerRad, half = m === 300 ? 9 : 5;
      ctx.fillRect(cx - half, y - 0.5, half * 2, 1);
      if (m !== 200) this.text(String(m), cx + half + 4, y, 9, '#000', 'left', 700);
    }

    // Held breath: a thin bar under the scope.
    const bw = 120, bx = cx - bw / 2, by = cy + r + 22;
    if (by < h - 10) {
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(bx, by, bw, 3);
      ctx.fillStyle = s.breath < 0.25 ? C.red : C.white;
      ctx.fillRect(bx, by, bw * s.breath, 3);
      this.text(s.holding ? 'HOLDING BREATH' : 'SHIFT  HOLD BREATH', cx, by + 14, 11, 'rgba(255,255,255,0.7)', 'center');
    }
  }

  private drawHitMarker(s: HudState) {
    if (!s.hitMarker || s.hitMarker.age > 0.35) return;
    const { ctx, w, h } = this;
    const cx = w / 2, cy = h / 2, a = 1 - s.hitMarker.age / 0.35;
    ctx.strokeStyle = s.hitMarker.kill ? `rgba(227,34,26,${a})` : s.scoped ? `rgba(255,255,255,${a})` : `rgba(27,31,35,${a})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      ctx.moveTo(cx + dx * 7, cy + dy * 7);
      ctx.lineTo(cx + dx * 14, cy + dy * 14);
    }
    ctx.stroke();
  }

  /** A thin compass strip at the top. Directions only: no markers for anyone. */
  private drawCompass(s: HudState) {
    const { ctx, w } = this;
    const cx = w / 2, y = 26, span = 90, pxPerDeg = 2.4;
    const ink = s.scoped ? 'rgba(255,255,255,0.8)' : C.inkSoft;
    const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    ctx.fillStyle = ink;
    for (let hdg = 0; hdg < 360; hdg += 5) {
      const diff = ((hdg - s.viewHeading + 540) % 360) - 180;
      if (Math.abs(diff) > span) continue;
      const x = cx + diff * pxPerDeg;
      if (names[hdg]) this.text(names[hdg], x, y, 12, ink, 'center', 700);
      else {
        ctx.fillStyle = ink;
        ctx.fillRect(x - 0.5, y - (hdg % 15 ? 2 : 4), 1, hdg % 15 ? 4 : 8);
      }
    }
    this.text(String(Math.round(s.viewHeading) % 360).padStart(3, '0'), cx, y + 18, 11, ink, 'center');
  }

  /** Bottom left: health and stance. */
  private drawStatus(s: HudState) {
    const { ctx, h } = this;
    const ink = s.scoped ? C.white : C.ink;
    const x = 28, y = h - 40, bw = 160;
    ctx.fillStyle = s.scoped ? 'rgba(255,255,255,0.25)' : 'rgba(27,31,35,0.18)';
    ctx.fillRect(x, y, bw, 4);
    ctx.fillStyle = s.health > 40 ? ink : C.red;
    ctx.fillRect(x, y, (bw * s.health) / PLAYER_HEALTH, 4);
    this.text(STANCE_LABEL[s.stance], x, y - 14, 12, ink, 'left', 700);
  }

  /** Bottom right: rounds in the magazine (ammo is unlimited), and what the rifle is doing. */
  private drawAmmo(s: HudState) {
    const { ctx, w, h } = this;
    const ink = s.scoped ? C.white : C.ink;
    const x = w - 28, y = h - 62;
    this.text(String(s.mag), x, y - 2, 30, s.mag === 0 ? C.red : ink, 'right', 700);
    if (s.busy === 'reload') this.drawReload(s);
    else if (s.busy) {
      const bw = 90;
      ctx.fillStyle = s.scoped ? 'rgba(255,255,255,0.25)' : 'rgba(27,31,35,0.18)';
      ctx.fillRect(x - bw, y + 22, bw, 3);
      ctx.fillStyle = ink;
      ctx.fillRect(x - bw, y + 22, bw * s.busyProgress, 3);
      this.text('BOLT', x - bw, y + 34, 10, ink, 'left', 700);
    } else if (s.mag === 0) this.text('R  RELOAD', x, y + 26, 11, C.red, 'right', 700);
  }

  /**
   * The active reload, under the crosshair (the rifle swings across the bottom right while
   * reloading): a needle crossing the good zone, with the perfect zone in red. Press R on it.
   */
  private drawReload(s: HudState) {
    const { ctx, w, h } = this;
    const bw = 180, bh = 6, x = w / 2 - bw / 2, y = h / 2 + 70;
    ctx.fillStyle = 'rgba(243,245,247,0.8)';
    ctx.fillRect(x - 14, y - 10, bw + 28, bh + 34);
    ctx.fillStyle = 'rgba(27,31,35,0.18)';
    ctx.fillRect(x, y, bw, bh);
    const k = Math.min(1, s.busyProgress);
    if (!s.active) {
      const zone = (z: readonly [number, number], color: string) => {
        ctx.fillStyle = color;
        ctx.fillRect(x + bw * z[0], y - 2, bw * (z[1] - z[0]), bh + 4);
      };
      zone(ACTIVE_RELOAD.good, 'rgba(27,31,35,0.4)');
      zone(ACTIVE_RELOAD.perfect, C.red);
    }
    ctx.fillStyle = s.active === 'jam' ? C.red : C.ink;
    ctx.fillRect(x, y + 1, bw * k, bh - 2);
    if (!s.active) ctx.fillRect(x + bw * k - 1, y - 5, 2, bh + 10); // the needle
    const label = s.active === 'jam' ? 'JAMMED' : s.active === 'perfect' ? 'PERFECT' : s.active === 'good' ? 'FAST' : 'RELOAD  ·  R ON THE RED';
    this.text(label, w / 2, y + 20, 10, s.active === 'jam' ? C.red : C.ink, 'center', 700);
  }

  /** Down: bleeding out, waiting for a teammate. Out: waiting for the mission to end. */
  private drawDown(s: HudState) {
    const { ctx, w, h } = this;
    const d = s.down!;
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(245,247,249,0.35)');
    g.addColorStop(1, d.out ? 'rgba(245,247,249,0.8)' : 'rgba(227,34,26,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const y = h * 0.38;
    if (d.out) {
      this.text('OUT', w / 2, y, 64, C.ink, 'center', 800);
      this.text('YOU BLED OUT  ·  WAITING FOR THE SQUAD', w / 2, y + 52, 15, C.ink, 'center');
      return;
    }
    this.text('DOWN', w / 2, y, 64, C.red, 'center', 800);
    this.text(`HIT BY ${d.by}  ·  ${d.zone}`, w / 2, y + 52, 15, C.ink, 'center');
    this.text(`BLEEDING OUT  ${Math.max(0, Math.ceil(d.bleedOut))}`, w / 2, y + 82, 20, C.red, 'center', 800);
    this.text(d.help ? 'A TEAMMATE CAN GET YOU UP: STAY PUT' : 'NOBODY LEFT STANDING TO GET YOU UP', w / 2, y + 112, 13, C.inkSoft, 'center');
  }

  /** Next to a downed teammate: hold E. */
  private drawRevive(s: HudState) {
    const { ctx, w, h } = this;
    const r = s.revive!, y = h * 0.55, bw = 160;
    this.text(r.progress > 0 ? `GETTING ${r.name} UP` : `HOLD E  ·  REVIVE ${r.name}`, w / 2, y, 14, s.scoped ? C.white : C.ink, 'center', 700);
    ctx.fillStyle = 'rgba(27,31,35,0.18)';
    ctx.fillRect(w / 2 - bw / 2, y + 14, bw, 4);
    ctx.fillStyle = C.red;
    ctx.fillRect(w / 2 - bw / 2, y + 14, bw * r.progress, 4);
  }

  /** Tab: kills, deaths, accuracy. */
  private drawScores(scores: Score[], myId: number) {
    const { ctx, w } = this;
    const bw = 420, x = w / 2 - bw / 2, y = 90, rowH = 26;
    ctx.fillStyle = C.paper;
    ctx.fillRect(x, y, bw, 50 + scores.length * rowH);
    const cols: Array<[string, (s: Score) => string, number]> = [
      ['KILLS', (s) => String(s.kills), 250],
      ['REVIVES', (s) => String(s.revives), 170],
      ['DOWNS', (s) => String(s.downs), 95],
      ['HIT', accuracy, 20],
    ];
    this.text('SOLDIER', x + 20, y + 22, 11, C.inkSoft, 'left', 700);
    for (const [label, , right] of cols) this.text(label, x + bw - right, y + 22, 11, C.inkSoft, 'right', 700);
    scores.forEach((sc, i) => {
      const ry = y + 50 + i * rowH;
      const color = sc.id === myId ? C.red : C.ink;
      this.text(sc.name, x + 20, ry, 14, color);
      for (const [, value, right] of cols) this.text(value(sc), x + bw - right, ry, 14, color, 'right');
    });
  }

  /** After the first time: a small strip, not the whole instructions panel. */
  private drawGrabMouse() {
    this.text('CLICK TO PLAY', this.w / 2, 70, 14, C.ink, 'center', 700);
  }

  private drawClickToPlay() {
    const { ctx, w, h } = this;
    const bw = 460, bh = 320, x = w / 2 - bw / 2, y = h / 2 - bh / 2;
    ctx.fillStyle = C.paper;
    ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = C.red;
    ctx.fillRect(x, y, bw, 4);
    this.text('SPEC OPS', w / 2, y + 44, 30, C.ink, 'center', 800);
    this.text('CLICK TO PLAY', w / 2, y + 80, 14, C.red, 'center', 700);
    const help: Array<[string, string]> = [
      ['WASD', 'MOVE'],
      ['SHIFT', 'SPRINT  /  HOLD BREATH (SCOPED)'],
      ['SPACE', 'JUMP'],
      ['C  /  Z', 'CROUCH  /  PRONE'],
      ['RIGHT MOUSE', 'SCOPE'],
      ['LEFT MOUSE', 'FIRE'],
      ['R', 'RELOAD'],
      ['E (HOLD)', 'REVIVE A TEAMMATE'],
      ['TAB', 'SCORES'],
    ];
    help.forEach(([k, v], i) => {
      const ry = y + 118 + i * 21;
      this.text(k, w / 2 - 12, ry, 12, C.ink, 'right', 700);
      this.text(v, w / 2 + 12, ry, 12, C.inkSoft, 'left', 600);
    });
  }
}
