import type { GameMap } from './mapgen.ts';

// The map's solid things as simple shapes, for enemy eyes and feet. The server has no physics engine,
// so line of sight and "don't walk through trees" come from here (the client uses it for the AI too).
// Shapes match what world.ts draws closely enough: trunks are cylinders, branches a soft cylinder you
// can half see through, rocks spheres, cabins and walls boxes, logs capsules.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

type Shape =
  | { k: 'cyl'; x: number; z: number; r: number; y0: number; y1: number; soft: boolean; move: boolean }
  | { k: 'sphere'; x: number; y: number; z: number; r: number; move: boolean }
  | { k: 'box'; x: number; z: number; y0: number; y1: number; hx: number; hz: number; cos: number; sin: number; move: boolean }
  | { k: 'capsule'; a: Vec3; b: Vec3; r: number; move: boolean };

const CELL = 8; // m
const TERRAIN_STEP = 1; // m between ground checks along a sight line (terrain facets are 3.2 m)

export class Obstacles {
  private shapes: Shape[] = [];
  private grid = new Map<number, number[]>();
  private mark: Uint32Array;
  private stamp = 0;
  private half: number;
  private map: GameMap;
  private foliage: number; // visibility left after one pine's branches

  constructor(map: GameMap, foliage: number) {
    this.map = map;
    this.foliage = foliage;
    this.half = map.size / 2;
    for (const o of map.objects) {
      const [w, h, d] = o.size;
      const cos = Math.cos(o.rotY), sin = Math.sin(o.rotY);
      switch (o.kind) {
        case 'tree':
          this.add({ k: 'cyl', x: o.x, z: o.z, r: 0.2, y0: o.y - 1, y1: o.y + h, soft: false, move: true }); // the trunk, as drawn
          this.add({ k: 'cyl', x: o.x, z: o.z, r: w * 0.55, y0: o.y + h * 0.36, y1: o.y + h * 0.9, soft: true, move: false });
          break;
        case 'shrub':
          this.add({ k: 'cyl', x: o.x, z: o.z, r: w * 0.42, y0: o.y - 0.2, y1: o.y + h * 0.9, soft: true, move: false });
          break;
        case 'deadTree':
          this.add({ k: 'cyl', x: o.x, z: o.z, r: 0.17, y0: o.y - 1, y1: o.y + h, soft: false, move: true });
          break;
        case 'rock':
          this.add({ k: 'sphere', x: o.x, y: o.y + h * 0.25, z: o.z, r: Math.min(w, h, d) * 0.45, move: true });
          break;
        case 'log': {
          const r = h / 2, y = o.y + r * 0.8;
          const ex = (cos * w) / 2, ez = (-sin * w) / 2; // local x axis, turned
          this.add({ k: 'capsule', a: { x: o.x - ex, y, z: o.z - ez }, b: { x: o.x + ex, y, z: o.z + ez }, r, move: true });
          break;
        }
        case 'cabin':
          this.add({ k: 'box', x: o.x, z: o.z, y0: o.y - 1, y1: o.y + h * 1.4, hx: w / 2, hz: d / 2, cos, sin, move: true });
          break;
        case 'wall':
          this.add({ k: 'box', x: o.x, z: o.z, y0: o.y - 1, y1: o.y + h, hx: w / 2, hz: d / 2, cos, sin, move: true });
          break;
        case 'tower': {
          // Legs you walk between; the platform and its rail block sight.
          const leg = w / 2 - 0.2;
          for (const [lx, lz] of [[-leg, -leg], [leg, -leg], [-leg, leg], [leg, leg]]) {
            this.add({ k: 'cyl', x: o.x + lx * cos + lz * sin, z: o.z - lx * sin + lz * cos, r: 0.2, y0: o.y - 1, y1: o.y + h, soft: false, move: true });
          }
          this.add({ k: 'box', x: o.x, z: o.z, y0: o.y + h - 0.15, y1: o.y + h + 1.15, hx: w / 2, hz: w / 2, cos, sin, move: false });
          break;
        }
        case 'pad':
          break;
      }
    }
    this.mark = new Uint32Array(this.shapes.length);
  }

  private add(s: Shape) {
    const i = this.shapes.length;
    this.shapes.push(s);
    let x0: number, x1: number, z0: number, z1: number;
    if (s.k === 'capsule') {
      x0 = Math.min(s.a.x, s.b.x) - s.r; x1 = Math.max(s.a.x, s.b.x) + s.r;
      z0 = Math.min(s.a.z, s.b.z) - s.r; z1 = Math.max(s.a.z, s.b.z) + s.r;
    } else {
      const r = s.k === 'box' ? Math.hypot(s.hx, s.hz) : s.r;
      x0 = s.x - r; x1 = s.x + r; z0 = s.z - r; z1 = s.z + r;
    }
    for (let gx = this.cell(x0); gx <= this.cell(x1); gx++) {
      for (let gz = this.cell(z0); gz <= this.cell(z1); gz++) {
        const k = gx * 4096 + gz;
        let list = this.grid.get(k);
        if (!list) this.grid.set(k, (list = []));
        list.push(i);
      }
    }
  }

  private cell(v: number) {
    return Math.floor((v + this.half) / CELL);
  }

  /** Shapes in the cells a 2D segment passes through, each once. */
  private along(ax: number, az: number, bx: number, bz: number, pad: number, out: Shape[]) {
    this.stamp++;
    out.length = 0;
    const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(len / (CELL / 4)));
    for (let i = 0; i <= n; i++) {
      const x = ax + ((bx - ax) * i) / n, z = az + ((bz - az) * i) / n;
      for (let gx = this.cell(x - pad); gx <= this.cell(x + pad); gx++) {
        for (let gz = this.cell(z - pad); gz <= this.cell(z + pad); gz++) {
          const list = this.grid.get(gx * 4096 + gz);
          if (!list) continue;
          for (const si of list) {
            if (this.mark[si] === this.stamp) continue;
            this.mark[si] = this.stamp;
            out.push(this.shapes[si]);
          }
        }
      }
    }
    return out;
  }
  private scratch: Shape[] = [];

  /**
   * How well `b` can be seen from `a`: 0 if the ground or anything solid is in the way, otherwise
   * 1 reduced for each pine's branches the line passes through.
   */
  see(a: Vec3, b: Vec3): number {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const flat = Math.hypot(dx, dz);
    // Ground first: cheapest and most often the answer at range.
    const n = Math.ceil(flat / TERRAIN_STEP);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (a.y + dy * t < this.map.heightAt(a.x + dx * t, a.z + dz * t)) return 0;
    }
    let vis = 1;
    // A little padding so shapes in cells the line only clips at a corner are still checked.
    for (const s of this.along(a.x, a.z, b.x, b.z, 1, this.scratch)) {
      if (!crosses(s, a, dx, dy, dz)) continue;
      if (s.k === 'cyl' && s.soft) {
        vis *= this.foliage;
        if (vis < 0.05) return 0;
      } else return 0;
    }
    return vis;
  }

  /** Move a walker of radius `r` at (x, z) out of anything solid. Returns the corrected position. */
  push(x: number, z: number, r: number): { x: number; z: number } {
    for (const s of this.along(x, z, x, z, r, this.scratch)) {
      if (!s.move) continue;
      if (s.k === 'cyl' || s.k === 'sphere') {
        const ox = x - s.x, oz = z - s.z, d = Math.hypot(ox, oz), min = s.r + r;
        if (d < min && d > 1e-6) {
          x = s.x + (ox / d) * min;
          z = s.z + (oz / d) * min;
        }
      } else if (s.k === 'box') {
        // Into the box's frame, push out through the nearest side, back out.
        const wx = x - s.x, wz = z - s.z;
        let lx = wx * s.cos - wz * s.sin, lz = wx * s.sin + wz * s.cos;
        const px = s.hx + r - Math.abs(lx), pz = s.hz + r - Math.abs(lz);
        if (px > 0 && pz > 0) {
          if (px < pz) lx += Math.sign(lx || 1) * px;
          else lz += Math.sign(lz || 1) * pz;
          x = s.x + lx * s.cos + lz * s.sin;
          z = s.z - lx * s.sin + lz * s.cos;
        }
      } else {
        const ex = s.b.x - s.a.x, ez = s.b.z - s.a.z, l2 = ex * ex + ez * ez;
        const t = Math.max(0, Math.min(1, ((x - s.a.x) * ex + (z - s.a.z) * ez) / l2));
        const cx = s.a.x + ex * t, cz = s.a.z + ez * t;
        const ox = x - cx, oz = z - cz, d = Math.hypot(ox, oz), min = s.r + r;
        if (d < min && d > 1e-6) {
          x = cx + (ox / d) * min;
          z = cz + (oz / d) * min;
        }
      }
    }
    return { x, z };
  }
}

/** Does the segment a + t*(dx,dy,dz), t in [0,1], pass through the shape? */
function crosses(s: Shape, a: Vec3, dx: number, dy: number, dz: number): boolean {
  switch (s.k) {
    case 'cyl': {
      const span = circleSpan(a.x - s.x, a.z - s.z, dx, dz, s.r);
      if (!span) return false;
      const ya = a.y + dy * span[0], yb = a.y + dy * span[1];
      return Math.max(ya, yb) >= s.y0 && Math.min(ya, yb) <= s.y1;
    }
    case 'sphere': {
      const ox = a.x - s.x, oy = a.y - s.y, oz = a.z - s.z;
      const A = dx * dx + dy * dy + dz * dz, B = 2 * (ox * dx + oy * dy + oz * dz), C = ox * ox + oy * oy + oz * oz - s.r * s.r;
      const disc = B * B - 4 * A * C;
      if (disc < 0) return false;
      const q = Math.sqrt(disc), t0 = (-B - q) / (2 * A), t1 = (-B + q) / (2 * A);
      return t1 >= 0 && t0 <= 1;
    }
    case 'box': {
      // Segment into the box's frame, then slabs on x, z and the height range.
      const wx = a.x - s.x, wz = a.z - s.z;
      const o = [wx * s.cos - wz * s.sin, a.y - (s.y0 + s.y1) / 2, wx * s.sin + wz * s.cos];
      const d = [dx * s.cos - dz * s.sin, dy, dx * s.sin + dz * s.cos];
      const h = [s.hx, (s.y1 - s.y0) / 2, s.hz];
      let t0 = 0, t1 = 1;
      for (let i = 0; i < 3; i++) {
        if (Math.abs(d[i]) < 1e-9) {
          if (Math.abs(o[i]) > h[i]) return false;
          continue;
        }
        let u = (-h[i] - o[i]) / d[i], v = (h[i] - o[i]) / d[i];
        if (u > v) [u, v] = [v, u];
        t0 = Math.max(t0, u);
        t1 = Math.min(t1, v);
        if (t0 > t1) return false;
      }
      return true;
    }
    case 'capsule':
      return segSegDist(a, { x: a.x + dx, y: a.y + dy, z: a.z + dz }, s.a, s.b) < s.r;
  }
}

/** Where a 2D segment o + t*d (t in [0,1]) is inside a circle at the origin: [t0, t1], or null. */
function circleSpan(ox: number, oz: number, dx: number, dz: number, r: number): [number, number] | null {
  const A = dx * dx + dz * dz, B = 2 * (ox * dx + oz * dz), C = ox * ox + oz * oz - r * r;
  if (A < 1e-12) return C <= 0 ? [0, 1] : null;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const q = Math.sqrt(disc);
  const t0 = Math.max(0, (-B - q) / (2 * A)), t1 = Math.min(1, (-B + q) / (2 * A));
  return t0 <= t1 ? [t0, t1] : null;
}

/** Shortest distance between segments p1-q1 and p2-q2. */
function segSegDist(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): number {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a < 1e-9 && e < 1e-9) return Math.sqrt(dot(r, r));
  if (a < 1e-9) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r);
    if (e < 1e-9) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2), denom = a * e - b * b;
      s = denom > 1e-9 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const c1 = { x: p1.x + d1.x * s, y: p1.y + d1.y * s, z: p1.z + d1.z * s };
  const c2 = { x: p2.x + d2.x * t, y: p2.y + d2.y * t, z: p2.z + d2.z * t };
  const w = sub(c1, c2);
  return Math.sqrt(dot(w, w));
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
