import { MAP_CELLS, MAP_SIZE } from './constants.ts';
import { makeNoise2, makeRng, type Rng } from './rng.ts';

// Procedural mission map. One seed gives one valley: mountains all round, rolling hills and rocky
// ridges inside, a frozen creek, forest with clearings, and a winding route from the insertion
// point on one edge to the extraction pad on the opposite one, past a few outposts.
// Server and clients run this with the same seed and get the same map.

export type MapObjectKind = 'tree' | 'deadTree' | 'log' | 'rock' | 'cabin' | 'tower' | 'wall' | 'pad';

export interface MapObject {
  id: number; // fixed, from generation order
  kind: MapObjectKind;
  x: number;
  y: number; // ground height at the object's base
  z: number;
  rotY: number;
  size: [number, number, number]; // full extents (w, h, d)
}

export interface Point {
  x: number;
  z: number;
}

export interface Spawn extends Point {
  rotY: number; // 0 faces -z
}

/** A clearing with buildings: where the enemy will be. */
export interface Outpost extends Point {
  r: number;
}

/** Ground type per height-grid vertex, for colouring. */
export const SURFACE = { snow: 0, rock: 1, ice: 2 } as const;

export interface GameMap {
  seed: number;
  size: number; // m per side
  cells: number; // grid cells per side; heights has (cells+1)^2 entries
  heights: Float32Array; // row-major: heights[iz * (cells+1) + ix]
  surface: Uint8Array; // SURFACE per height vertex
  objects: MapObject[];
  start: Spawn; // insertion: where the squad begins
  extract: Point; // extraction pad: where the mission ends
  route: Point[]; // the rough way through, start to extract (for placing things, never shown)
  outposts: Outpost[];
  spawns: Spawn[]; // four side by side at the start
  heightAt(x: number, z: number): number;
}

const RIM = 70; // m of mountains along each edge
const INSET = 28; // m inside the mountains where start and extract sit
const CREEK_HALF = 5; // m: flat ice either side of the creek's line
const CREEK_DEPTH = 2.2;
const TREE_CELL = 4.6; // m: one tree candidate per cell (jittered)
const START_R = 12; // clearing radii
const EXTRACT_R = 16;

export function generateMap(seed: number): GameMap {
  const rng = makeRng(seed);
  const noise = makeNoise2(seed);
  const half = MAP_SIZE / 2, inner = half - RIM - INSET;

  // --- Start, extract and the route between them ---
  // Opposite edges, each somewhere along its side.
  const side = rng.int(0, 3);
  const onSide = (s: number, along: number): Point => {
    const a = along * inner;
    return [{ x: a, z: -inner }, { x: inner, z: a }, { x: a, z: inner }, { x: -inner, z: a }][s];
  };
  const startPt = onSide(side, rng.range(-0.6, 0.6));
  const extract = onSide((side + 2) % 4, rng.range(-0.6, 0.6));
  const dx = extract.x - startPt.x, dz = extract.z - startPt.z, len = Math.hypot(dx, dz);
  const along = { x: dx / len, z: dz / len }, perp = { x: -dz / len, z: dx / len };
  const controls: Point[] = [startPt];
  const N = 6;
  for (let i = 1; i <= N; i++) {
    const t = i / (N + 1), off = rng.range(-1, 1) * 110 * Math.sin(Math.PI * t);
    controls.push(clampIn({ x: startPt.x + dx * t + perp.x * off, z: startPt.z + dz * t + perp.z * off }, inner));
  }
  controls.push(extract);
  const route = spline(controls, 8);
  const toRoute = segmentsDistance(route);

  // --- Frozen creek: crosses the route once, running edge to edge, meandering ---
  const cross = route[Math.floor(route.length * rng.range(0.35, 0.65))];
  const creekCtl: Point[] = [];
  for (let i = -4; i <= 4; i++) {
    const w = (i / 4) * half * 1.2, wobble = rng.range(-35, 35);
    creekCtl.push({ x: cross.x + perp.x * w + along.x * wobble, z: cross.z + perp.z * w + along.z * wobble });
  }
  const toCreek = segmentsDistance(spline(creekCtl, 6));
  /** 1 on the valley floor, fading to 0 up in the mountains. */
  const inValley = (x: number, z: number) => 1 - smoothstep(half - RIM, half - RIM * 0.6, Math.max(Math.abs(x), Math.abs(z)));

  // --- Outposts along the route, off to one side ---
  const outposts: Outpost[] = [];
  const count = rng.int(3, 4);
  for (let i = 0; i < count; i++) {
    // Spread over the route from about 40% on: the first stretch from the insertion point is quiet.
    const t = 0.36 + (0.52 * (i + 0.5)) / count + rng.range(-0.04, 0.04);
    const p = route[Math.floor(t * (route.length - 1))];
    const off = rng.range(22, 50) * (rng.next() < 0.5 ? -1 : 1);
    const r = rng.range(16, 23);
    // Off to one side of the route, kept out of the creek: of a few tries, the first that's clear
    // (or else the driest).
    let best: Outpost | null = null;
    for (const [k, slide] of [[1, 0], [-1, 0], [1, 40], [-1, 40], [1, -40], [-1, -40]]) {
      const o = { ...clampIn({ x: p.x + perp.x * off * k + along.x * slide, z: p.z + perp.z * off * k + along.z * slide }, inner), r };
      if (!best || toCreek(o.x, o.z) > toCreek(best.x, best.z)) best = o;
      if (toCreek(o.x, o.z) >= r + 15) break;
    }
    outposts.push(best!);
  }
  const clearings: Array<Point & { r: number }> = [{ ...startPt, r: START_R }, { ...extract, r: EXTRACT_R }, ...outposts];

  // --- Heights ---
  const n = MAP_CELLS + 1, step = MAP_SIZE / MAP_CELLS;
  const heights = new Float32Array(n * n);
  const rawHeight = (x: number, z: number) => {
    let h = (noise(x / 220 + 10, z / 220 + 10, 4) - 0.5) * 30; // rolling hills
    // Rocky ridges where the mask allows, kept off the route so there is always a way through.
    const ridge = 1 - Math.abs(2 * noise(x / 130 + 50, z / 130 + 50, 3) - 1);
    const mask = smoothstep(0.4, 0.62, noise(x / 300 + 90, z / 300 + 90, 2));
    h += ridge ** 3 * 28 * mask * smoothstep(14, 70, toRoute(x, z));
    // Mountains all round: the map's edge.
    const e = Math.max(Math.abs(x), Math.abs(z));
    if (e > half - RIM) {
      const k = (e - (half - RIM)) / RIM;
      h += k * k * 70 + k * (noise(x / 25, z / 25, 3) - 0.5) * 24;
    }
    // The creek: a flat-bottomed channel, starting where it comes out of the mountains.
    const c = toCreek(x, z);
    if (c < CREEK_HALF + 10) h -= CREEK_DEPTH * (1 - smoothstep(CREEK_HALF, CREEK_HALF + 10, c)) * inValley(x, z);
    return h;
  };
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) heights[iz * n + ix] = rawHeight(-half + ix * step, -half + iz * step);
  // Clearings sit on level ground: blend toward the height at their centre.
  for (const c of clearings) {
    const ch = rawHeight(c.x, c.z);
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const d = Math.hypot(-half + ix * step - c.x, -half + iz * step - c.z);
        if (d > c.r + 25) continue;
        const t = smoothstep(c.r, c.r + 25, d), i = iz * n + ix;
        heights[i] = ch + (heights[i] - ch) * t;
      }
    }
  }

  const heightAt = (x: number, z: number) => {
    const fx = clamp((x + half) / step, 0, MAP_CELLS - 1e-6);
    const fz = clamp((z + half) / step, 0, MAP_CELLS - 1e-6);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h00 = heights[iz * n + ix], h10 = heights[iz * n + ix + 1];
    const h01 = heights[(iz + 1) * n + ix], h11 = heights[(iz + 1) * n + ix + 1];
    // Exactly on the flat triangles everyone draws and walks on (each cell is split along its
    // (1,0)-(0,1) diagonal, as in world.ts and Rapier's heightfield), so a crest that hides you on
    // screen hides you from the enemy too.
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  };
  /** Rise over run at a point. */
  const slopeAt = (x: number, z: number) => {
    const e = 1.5;
    return Math.hypot(heightAt(x + e, z) - heightAt(x - e, z), heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  };

  const surface = new Uint8Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = -half + ix * step, z = -half + iz * step;
      surface[iz * n + ix] = toCreek(x, z) < CREEK_HALF && inValley(x, z) > 0.5 ? SURFACE.ice : slopeAt(x, z) > 0.75 ? SURFACE.rock : SURFACE.snow;
    }
  }

  // --- Objects ---
  const objects: MapObject[] = [];
  const add = (kind: MapObjectKind, x: number, z: number, rotY: number, size: [number, number, number]) => {
    objects.push({ id: objects.length, kind, x, y: heightAt(x, z), z, rotY, size });
  };
  const inClearing = (x: number, z: number, pad = 0) => clearings.some((c) => Math.hypot(x - c.x, z - c.z) < c.r + pad);
  const inBounds = (x: number, z: number, pad: number) => Math.abs(x) < half - pad && Math.abs(z) < half - pad;

  add('pad', extract.x, extract.z, Math.atan2(-dx, -dz), [10, 0.25, 10]);
  for (const o of outposts) buildOutpost(o, rng, add, Math.atan2(startPt.x - o.x, startPt.z - o.z));

  // Rocks: scattered, preferring steep ground, sometimes in clusters.
  for (let i = 0; i < 170; i++) {
    const x = rng.range(-half + 20, half - 20), z = rng.range(-half + 20, half - 20);
    if (inClearing(x, z, 6) || toCreek(x, z) < CREEK_HALF + 2) continue;
    if (slopeAt(x, z) < 0.3 && rng.next() > 0.35) continue;
    const s = rng.range(1.6, 6);
    add('rock', x, z, rng.range(0, Math.PI * 2), [s * rng.range(1, 1.6), s * rng.range(0.6, 1.1), s]);
    for (let k = rng.int(0, 3); k > 0; k--) {
      const cx = x + rng.range(-s, s) * 1.4, cz = z + rng.range(-s, s) * 1.4, cs = s * rng.range(0.3, 0.6);
      if (!inClearing(cx, cz, 6)) add('rock', cx, cz, rng.range(0, Math.PI * 2), [cs * 1.3, cs * 0.8, cs]);
    }
  }

  // Forest: a density field gives thick woods and open snowfields; a thinner trail along the route.
  const forest = (x: number, z: number) => noise(x / 110 + 200, z / 110 + 200, 4);
  for (let gz = -half; gz < half; gz += TREE_CELL) {
    for (let gx = -half; gx < half; gx += TREE_CELL) {
      // Draw every number up front so a skipped cell doesn't shift the rest of the map.
      const x = gx + rng.range(0.1, 0.9) * TREE_CELL, z = gz + rng.range(0.1, 0.9) * TREE_CELL;
      const roll = rng.next(), hRoll = rng.next(), kindRoll = rng.next(), rot = rng.next();
      if (!inBounds(x, z, 8) || inClearing(x, z, 3) || toCreek(x, z) < CREEK_HALF + 1.5) continue;
      let p = smoothstep(0.36, 0.62, forest(x, z)) * 0.88 + 0.03;
      if (toRoute(x, z) < 5) p *= 0.3;
      if (slopeAt(x, z) > 0.9) p *= 0.15;
      if (Math.max(Math.abs(x), Math.abs(z)) > half - RIM * 0.4) p *= 0.4; // thin out high on the mountains
      if (roll > p) continue;
      const h = 7 + hRoll * 7;
      if (kindRoll < 0.04) add('deadTree', x, z, rot * Math.PI * 2, [0.5, h * 0.8, 0.5]);
      else add('tree', x, z, rot * Math.PI * 2, [h * (0.2 + kindRoll * 0.07), h, h * 0.24]);
    }
  }

  // Fallen logs in the woods: cover you can lie behind.
  for (let i = 0; i < 90; i++) {
    const x = rng.range(-half + RIM, half - RIM), z = rng.range(-half + RIM, half - RIM);
    const rot = rng.range(0, Math.PI), r = rng.range(0.3, 0.45), l = rng.range(4, 7.5);
    if (forest(x, z) < 0.45 || inClearing(x, z, 4) || toCreek(x, z) < CREEK_HALF + 2 || slopeAt(x, z) > 0.5) continue;
    add('log', x, z, rot, [l, r * 2, r * 2]);
  }

  // --- Spawns ---
  const toward = route[Math.min(3, route.length - 1)];
  const facing = Math.atan2(-(toward.x - startPt.x), -(toward.z - startPt.z));
  const start: Spawn = { ...startPt, rotY: facing };
  const spawns: Spawn[] = [];
  const right = { x: Math.cos(facing), z: -Math.sin(facing) };
  for (const off of [-1.5, 1.5, -4.5, 4.5]) spawns.push({ x: startPt.x + right.x * off, z: startPt.z + right.z * off, rotY: facing });
  // Keep spawns clear of objects.
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (o.kind !== 'pad' && spawns.some((s) => Math.hypot(s.x - o.x, s.z - o.z) < 4 + Math.max(o.size[0], o.size[2]) / 2)) objects.splice(i, 1);
  }
  objects.forEach((o, i) => (o.id = i));

  return { seed, size: MAP_SIZE, cells: MAP_CELLS, heights, surface, objects, start, extract, route, outposts, spawns, heightAt };
}

/** Cabins round the middle, maybe a watchtower, sandbag walls facing out. */
function buildOutpost(
  o: Outpost, rng: Rng,
  add: (kind: MapObjectKind, x: number, z: number, rotY: number, size: [number, number, number]) => void,
  faceStart: number,
) {
  const placed: Array<Point & { r: number }> = [];
  const free = (x: number, z: number, r: number) => placed.every((p) => Math.hypot(p.x - x, p.z - z) > p.r + r);
  const cabins = rng.int(1, 3);
  for (let i = 0, made = 0; i < cabins * 4 && made < cabins; i++) {
    const a = rng.range(0, Math.PI * 2), d = rng.range(0, o.r * 0.45);
    const x = o.x + Math.cos(a) * d, z = o.z + Math.sin(a) * d;
    const w = rng.range(6, 9), dd = rng.range(5, 7), h = rng.range(3, 3.8);
    const turn = rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]) + rng.range(-0.2, 0.2);
    if (!free(x, z, Math.max(w, dd) / 2 + 1.5)) continue;
    placed.push({ x, z, r: Math.max(w, dd) / 2 + 1.5 });
    add('cabin', x, z, faceStart + turn, [w, h, dd]);
    made++;
  }
  if (rng.next() < 0.7) {
    for (let i = 0; i < 8; i++) {
      const a = rng.range(0, Math.PI * 2), d = o.r * rng.range(0.55, 0.8), h = rng.range(6, 8), rot = rng.range(0, Math.PI);
      const x = o.x + Math.cos(a) * d, z = o.z + Math.sin(a) * d;
      if (!free(x, z, 3)) continue;
      placed.push({ x, z, r: 3 });
      add('tower', x, z, rot, [3.2, h, 3.2]);
      break;
    }
  }
  // Sandbag walls on the rim of the clearing, broadside to the outside.
  const walls = rng.int(3, 6);
  for (let i = 0, made = 0; i < walls * 3 && made < walls; i++) {
    const a = rng.range(0, Math.PI * 2), d = o.r * rng.range(0.75, 0.95), w = rng.range(2.5, 4);
    const x = o.x + Math.cos(a) * d, z = o.z + Math.sin(a) * d;
    if (!free(x, z, 2)) continue;
    placed.push({ x, z, r: 2 });
    add('wall', x, z, Math.atan2(x - o.x, z - o.z), [w, 0.9, 0.7]);
    made++;
  }
}

/** Catmull-Rom through the points, sampled about every `spacing` m. */
function spline(pts: Point[], spacing: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const steps = Math.max(1, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / spacing));
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Distance from a point to a polyline, through a coarse grid so many queries stay fast. */
function segmentsDistance(line: Point[]) {
  const CELL = 40, REACH = 80; // beyond REACH the exact distance doesn't matter to anyone
  const grid = new Map<string, number[]>();
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    const x0 = Math.floor((Math.min(a.x, b.x) - REACH) / CELL), x1 = Math.floor((Math.max(a.x, b.x) + REACH) / CELL);
    const z0 = Math.floor((Math.min(a.z, b.z) - REACH) / CELL), z1 = Math.floor((Math.max(a.z, b.z) + REACH) / CELL);
    for (let gx = x0; gx <= x1; gx++) {
      for (let gz = z0; gz <= z1; gz++) {
        const k = `${gx},${gz}`;
        let list = grid.get(k);
        if (!list) grid.set(k, (list = []));
        list.push(i);
      }
    }
  }
  return (x: number, z: number) => {
    const list = grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!list) return REACH;
    let best = REACH;
    for (const i of list) best = Math.min(best, distToSegment(x, z, line[i].x, line[i].z, line[i + 1].x, line[i + 1].z));
    return best;
  };
}

function clampIn(p: Point, lim: number): Point {
  return { x: clamp(p.x, -lim, lim), z: clamp(p.z, -lim, lim) };
}
function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
function smoothstep(a: number, b: number, v: number) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? clamp(((px - ax) * dx + (pz - az) * dz) / l2, 0, 1) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
