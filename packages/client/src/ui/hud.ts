import { PART_LABEL, RENDER_HEIGHT as H, RENDER_WIDTH as W, TANK_HEALTH, type Score } from '@skeleton-crew/shared';
import type { TankSim } from '../sim/tank';
import type { Gun } from '../sim/gun';
import { accuracy } from './menu';
import { drawText } from './font';

// Garish palette.
const C = {
  pink: '#ff4fd8',
  pinkDark: '#a3127f',
  lime: '#b6ff00',
  yellow: '#ffe600',
  cyan: '#00ffe1',
  red: '#ff1f3d',
  black: '#14001a',
  white: '#ffffff',
  purple: '#5b0fa8',
};

const THROTTLE_LABEL = ['R FULL', 'R 1/2', 'STOP', '1/4', '1/2', 'FULL'];

export interface HudState {
  tank: TankSim;
  time: number;
  locked: boolean;
  everLocked: boolean; // the full instructions show only until the first time you climb in
  sighting: boolean; // right mouse held: looking down the gun sight
  fovDeg: number; // vertical fov of the current view
  viewHeading: number; // degrees, where the camera looks (0 = north)
  gunMark: [number, number] | null; // where the gun points, in HUD pixels (head-out view)
  gun: Gun;
  message: { text: string; color: string } | null; // short-lived feedback ("HIT SIDE HULL")
  scores: Score[] | null; // shown while Tab is held (online only)
  myId: number;
  dead: { killer: string; zone: string; respawnIn: number } | null;
  protectedFor: number; // s of spawn protection left
  hurt: number; // 0..1 red flash after being hit
  subtitle: string | null; // the crew's gibberish
}

export const HUD_COLORS = C;

export class Hud {
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = W;
    canvas.height = H;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
  }

  draw(s: HudState) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    if (s.dead) {
      this.drawDead(s);
    } else {
      if (s.sighting) this.drawSight(s);
      else this.drawHeadOut(s);
      this.drawDamage(s);
      this.drawDashboard(s);
      this.drawReload(s);
      if (s.hurt > 0) {
        ctx.fillStyle = `rgba(255,31,61,${(0.6 * s.hurt).toFixed(2)})`;
        for (const [x, y, w, h] of [[0, 0, W, 8], [0, H - 8, W, 8], [0, 0, 8, H], [W - 8, 0, 8, H]]) ctx.fillRect(x, y, w, h);
      }
      if (s.protectedFor > 0) {
        ctx.fillStyle = C.black;
        ctx.fillRect(176, 18, 128, 11);
        drawText(ctx, `SPAWN PROTECTION ${Math.ceil(s.protectedFor)}S`, 240, 21, C.cyan, 1, 'center');
      }
      if (s.message) {
        const w = s.message.text.length * 4 + 6;
        ctx.fillStyle = C.black;
        ctx.fillRect(240 - w / 2, 210, w, 11);
        drawText(ctx, s.message.text, 240, 213, s.message.color, 1, 'center');
      }
      if (s.subtitle) {
        const w = s.subtitle.length * 4 + 6;
        ctx.fillStyle = C.black;
        ctx.fillRect(240 - w / 2, 224, w, 10);
        drawText(ctx, s.subtitle, 240, 226, C.white, 1, 'center');
      }
    }
    if (s.scores) this.drawScores(s.scores, s.myId);
    if (!s.locked) {
      if (s.everLocked) this.drawGrabMouse();
      else this.drawClickToPlay();
    }
  }

  /** Head out of the hatch: compass, where you look, where the gun points. */
  private drawHeadOut(s: HudState) {
    const ctx = this.ctx;
    // Compass strip
    ctx.fillStyle = C.black;
    ctx.fillRect(140, 4, 200, 12);
    const names: Record<number, string> = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    for (let hdg = 0; hdg < 360; hdg += 5) {
      const diff = ((hdg - s.viewHeading + 540) % 360) - 180;
      if (Math.abs(diff) > 96) continue;
      const x = Math.round(240 + diff);
      if (names[hdg] !== undefined) drawText(ctx, names[hdg], x, 7, C.yellow, 1, 'center');
      else if (hdg % 15 === 0) {
        ctx.fillStyle = C.lime;
        ctx.fillRect(x, 9, 1, 3);
      }
    }
    // Where you look: a small dot.
    ctx.fillStyle = C.black;
    ctx.fillRect(239, 134, 3, 3);
    ctx.fillStyle = C.white;
    ctx.fillRect(240, 135, 1, 1);
    // Where the gun points (the turret lags your gaze at 24 deg/s): a ring.
    if (s.gunMark) {
      const [gx, gy] = s.gunMark.map(Math.round);
      ctx.strokeStyle = s.gun.ready ? C.lime : C.red;
      ctx.lineWidth = 1;
      ctx.strokeRect(gx - 5, gy - 5, 11, 11);
      ctx.fillStyle = C.black;
      ctx.fillRect(gx, gy - 2, 1, 5);
      ctx.fillRect(gx - 2, gy, 5, 1);
    }
  }

  /** Right mouse: down the gun sight. A round sight, everything else black. */
  private drawSight(s: HudState) {
    const ctx = this.ctx;
    const cx = W / 2, cy = H / 2 - 6, r = 112;
    ctx.fillStyle = C.black;
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
    ctx.fill();
    ctx.strokeStyle = C.lime;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    // Reticle: chevron + stadia line + range ticks for shell drop. Dark, to read on bright ground.
    ctx.fillStyle = C.black;
    ctx.fillRect(cx - 60, cy, 50, 1);
    ctx.fillRect(cx + 10, cy, 50, 1);
    for (let i = 0; i < 6; i++) {
      ctx.fillRect(cx - i, cy + i, 1, 1);
      ctx.fillRect(cx + i, cy + i, 1, 1);
    }
    const pxPerRad = H / ((s.fovDeg * Math.PI) / 180);
    for (const m of [100, 200, 300, 400]) {
      const drop = (9.81 * m) / (2 * 600 * 600); // small-angle shell drop, rad
      ctx.fillRect(cx - 3, Math.round(cy + drop * pxPerRad) + 8, 7, 1);
    }
    if (s.tank.isBroken('optics')) this.drawStatic(cx - r, cy - r, r * 2, r * 2, s.time);
  }

  /** Bottom left: what your levers are set to, speed, and the controls. */
  private drawDashboard(s: HudState) {
    const ctx = this.ctx;
    const t = s.tank;
    ctx.fillStyle = C.black;
    ctx.fillRect(4, H - 30, 150, 26);
    const steer = t.steer === 0 ? '--' : (t.steer < 0 ? '<' : '>').repeat(Math.round(Math.abs(t.steer) * 4));
    drawText(ctx, `THR ${THROTTLE_LABEL[t.throttleIdx]}  STR ${steer}`, 8, H - 26, C.cyan);
    const kmh = Math.round(Math.abs(t.speed) * 3.6);
    drawText(ctx, `${String(kmh).padStart(2, '0')} KM/H`, 8, H - 17, C.lime);
    if (t.brake) drawText(ctx, 'BRAKE', 60, H - 17, C.red);
    if (t.grounded < 0.3) drawText(ctx, 'AIRBORNE?!', 92, H - 17, C.red);
    drawText(ctx, 'W/S A/D X SPACE', 8, H - 9, C.purple);
  }

  /** Bottom centre: the gun reloads itself. */
  private drawReload(s: HudState) {
    const ctx = this.ctx;
    const g = s.gun, broken = s.tank.isBroken('gun');
    const x = 190, y = H - 14, w = 100;
    ctx.fillStyle = C.black;
    ctx.fillRect(x - 2, y - 11, w + 4, 21);
    const [label, color] = broken ? ['GUN BROKEN', C.red] : g.ready ? ['READY', C.lime] : ['RELOADING', C.yellow];
    drawText(ctx, label, x + w / 2, y - 8, color, 1, 'center');
    ctx.fillStyle = C.purple;
    ctx.fillRect(x, y, w, 4);
    ctx.fillStyle = g.ready && !broken ? C.lime : C.yellow;
    ctx.fillRect(x, y, Math.round(w * g.reloadProgress), 4);
    drawText(ctx, 'LMB CANNON  MMB MG  RMB SIGHT', 472, H - 9, C.purple, 1, 'right');
  }

  /** Broken optics: snow over the sight. */
  private drawStatic(x: number, y: number, w: number, h: number, time: number) {
    const ctx = this.ctx;
    let seed = Math.floor(time * 12) * 7919;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < (w * h) / 6; i++) {
      ctx.fillStyle = rnd() < 0.5 ? C.white : C.black;
      ctx.fillRect(x + Math.floor(rnd() * w), y + Math.floor(rnd() * h), 2, 1);
    }
  }

  /** Health and broken parts: warning lights. */
  private drawDamage(s: HudState) {
    const ctx = this.ctx;
    const d = s.tank.damage;
    ctx.fillStyle = C.black;
    ctx.fillRect(4, 4, 74, 9 + d.broken.size * 9);
    ctx.fillStyle = C.purple;
    ctx.fillRect(6, 6, 70, 5);
    ctx.fillStyle = d.health > 50 ? C.lime : d.health > 25 ? C.yellow : C.red;
    ctx.fillRect(6, 6, Math.round((70 * d.health) / TANK_HEALTH), 5);
    let y = 14;
    const blink = Math.floor(s.time * 4) % 2 === 0;
    for (const [part, t] of d.broken) {
      drawText(ctx, `${PART_LABEL[part]} ${Math.ceil(t)}S`, 6, y, blink ? C.red : C.yellow);
      y += 9;
    }
  }

  /** Dead: a cursed screen. Stuttering red noise, a skull made of text, the killer's name. */
  private drawDead(s: HudState) {
    const ctx = this.ctx;
    const d = s.dead!;
    const f = Math.floor(s.time * 8);
    // Translucent, so the death camera shows through.
    ctx.fillStyle = f % 2 ? 'rgba(58,0,8,0.55)' : 'rgba(20,0,26,0.45)';
    ctx.fillRect(0, 0, W, H);
    let seed = f * 9973;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 400; i++) {
      ctx.fillStyle = rnd() < 0.5 ? C.red : C.pinkDark;
      ctx.fillRect(Math.floor(rnd() * W), Math.floor(rnd() * H), 3, 1);
    }
    const jx = (f % 3) - 1, jy = ((f * 7) % 3) - 1;
    const skull = ['  ######  ', ' ######## ', '## #### ##', '##########', ' ### ## ###', '  ######  ', '  # # # # '];
    skull.forEach((row, i) => drawText(ctx, row.replace(/#/g, '*'), 240 + jx, 40 + i * 8 + jy, C.white, 1, 'center'));
    drawText(ctx, 'YOU DIED', 240 + jx, 110 + jy, C.yellow, 4, 'center');
    drawText(ctx, `KILLED BY ${d.killer}`, 240, 140, C.pink, 2, 'center');
    drawText(ctx, `(${d.zone})`, 240, 156, C.white, 1, 'center');
    drawText(ctx, `CRAWLING OUT OF A NEW TANK IN ${Math.max(0, Math.ceil(d.respawnIn))}`, 240, 176, C.lime, 1, 'center');
  }

  /** Tab: kills, deaths, accuracy. */
  private drawScores(scores: Score[], myId: number) {
    const ctx = this.ctx;
    const h = 28 + scores.length * 12;
    ctx.fillStyle = C.black;
    ctx.fillRect(120, 40, 240, h);
    ctx.fillStyle = C.yellow;
    ctx.fillRect(120, 40, 240, 2);
    drawText(ctx, 'TANK', 130, 48, C.yellow);
    drawText(ctx, 'KILLS  DEATHS  HIT', 350, 48, C.yellow, 1, 'right');
    scores.forEach((sc, i) => {
      const y = 62 + i * 12;
      const color = sc.id === myId ? C.lime : C.white;
      drawText(ctx, sc.name, 130, y, color);
      drawText(ctx, `${String(sc.kills).padStart(5)}  ${String(sc.deaths).padStart(6)}  ${accuracy(sc).padStart(4)}`, 350, y, color, 1, 'right');
    });
  }

  /** After the first time: a small strip, not the whole instructions panel. */
  private drawGrabMouse() {
    const ctx = this.ctx;
    ctx.fillStyle = C.black;
    ctx.fillRect(150, 30, 180, 11);
    drawText(ctx, 'CLICK TO GRAB THE MOUSE', 240, 33, C.yellow, 1, 'center');
  }

  private drawClickToPlay() {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(20,0,26,0.85)';
    ctx.fillRect(40, 40, 400, 110);
    drawText(ctx, 'SKELETON CREW', 240, 52, C.pink, 3, 'center');
    drawText(ctx, 'CLICK TO CLIMB IN', 240, 80, C.lime, 2, 'center');
    const help = [
      'MOUSE LOOK - THE TURRET FOLLOWS YOUR GAZE',
      'LMB CANNON (RELOADS ITSELF)  MMB MACHINE GUN  RMB GUN SIGHT',
      'W/S THROTTLE  A/D STEER  X CENTRE  SPACE BRAKE  TAB SCORES',
    ];
    help.forEach((line, i) => drawText(ctx, line, 240, 104 + i * 10, C.yellow, 1, 'center'));
  }
}
