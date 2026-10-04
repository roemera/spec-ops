import { MAP_CELLS, MAP_SIZE } from './constants.ts';
import { makeNoise2, makeRng } from './rng.ts';

export type MapObjectKind = 'rock' | 'building' | 'silo' | 'tree' | 'fence' | 'wall';

export interface MapObject {
  id: number; // fixed, from generation order; used by `break` messages
  kind: MapObjectKind;
  x: number;
  y: number; // ground height at the object's base
  z: number;
  rotY: number;
  size: [number, number, number]; // full extents (w, h, d)
  destructible: boolean;
}

export interface Spawn {
  x: number;
  z: number;
  rotY: number;
}

export interface GameMap {
  seed: number;
  size: number; // m per side
  cells: number; // grid cells per side; heights has (cells+1)^2 entries
  heights: Float32Array; // row-major: heights[iz * (cells+1) + ix]
  objects: MapObject[];
  spawns: Spawn[];
  heightAt(x: number, z: number): number;
}

// The layout was designed for a 1000 m map and scales with MAP_SIZE:
// positions scale by K, feature sizes (hills, farm yard, patches) by R so slopes stay about as steep.
const K = MAP_SIZE / 1000;
const R = Math.sqrt(K);
const FARM = { x: 120 * K, z: -120 * K, r: 70 * R };
const RIDGE = { ax: -330 * K, az: 140 * K, bx: 260 * K, bz: 300 * K, width: 28 * R, height: 24 * R };
const RIM = Math.max(40, 60 * K); // m of rising ground along the edge

export function generateMap(seed: number): GameMap {
  const rng = makeRng(seed);
  const noise = makeNoise2(seed);
  const n = MAP_CELLS + 1;
  const step = MAP_SIZE / MAP_CELLS;
  const half = MAP_SIZE / 2;
  const heights = new Float32Array(n * n);

  const rawHeight = (x: number, z: number) => {
    let h = (26 * noise(x / (260 * R) + 10, z / (260 * R) + 10, 4) - 13) * R;
    // Rock ridge: a raised band along a segment.
    const d = distToSegment(x, z, RIDGE.ax, RIDGE.az, RIDGE.bx, RIDGE.bz);
    h += RIDGE.height * Math.exp(-((d / RIDGE.width) ** 2)) * (0.6 + 0.8 * noise(x / (40 * R), z / (40 * R), 2));
    // Raise the rim so the map reads as a bowl.
    const edge = Math.max(Math.abs(x), Math.abs(z));
    if (edge > half - RIM) h += ((edge - (half - RIM)) / RIM) ** 2 * 35 * R;
    return h;
  };

  // Farm sits on flat ground: blend toward the height at its centre.
  const farmH = rawHeight(FARM.x, FARM.z);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = -half + ix * step, z = -half + iz * step;
      let h = rawHeight(x, z);
      const fd = Math.hypot(x - FARM.x, z - FARM.z);
      const t = clamp01((fd - FARM.r) / (40 * R));
      h = farmH + (h - farmH) * t * t * (3 - 2 * t);
      heights[iz * n + ix] = h;
    }
  }

  const heightAt = (x: number, z: number) => {
    const fx = clamp((x + half) / step, 0, MAP_CELLS - 1e-6);
    const fz = clamp((z + half) / step, 0, MAP_CELLS - 1e-6);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h00 = heights[iz * n + ix], h10 = heights[iz * n + ix + 1];
    const h01 = heights[(iz + 1) * n + ix], h11 = heights[(iz + 1) * n + ix + 1];
    return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz;
  };

  const objects: MapObject[] = [];
  const add = (kind: MapObjectKind, x: number, z: number, rotY: number, size: [number, number, number], destructible: boolean) => {
    objects.push({ id: objects.length, kind, x, y: heightAt(x, z), z, rotY, size, destructible });
  };
  const inFarm = (x: number, z: number, pad = 0) => Math.hypot(x - FARM.x, z - FARM.z) < FARM.r + pad;
  const inBounds = (x: number, z: number, pad: number) => Math.abs(x) < half - pad && Math.abs(z) < half - pad;

  // Farm buildings.
  const farmRot = rng.range(-0.3, 0.3);
  const local = (lx: number, lz: number) => {
    const c = Math.cos(farmRot), s = Math.sin(farmRot);
    return [FARM.x + R * (lx * c + lz * s), FARM.z + R * (-lx * s + lz * c)] as const;
  };
  const farmBuildings: Array<[number, number, number, number, number]> = [
    [-18, -10, 16, 9, 11], // barn
    [14, -14, 10, 6, 8], // house
    [12, 16, 8, 4, 6], // shed
    [-20, 18, 12, 5, 7], // workshop
  ];
  for (const [lx, lz, w, h, d] of farmBuildings) {
    const [x, z] = local(lx, lz);
    add('building', x, z, farmRot, [w, h, d], false);
  }
  {
    const [x, z] = local(-2, -26);
    add('silo', x, z, 0, [6, 14, 6], false);
  }
  // Fence rectangle around the farm, with gaps for gates.
  // Fence positions go through local(), which scales by R; segments stay 4 m long.
  const fw = 44, fd = 36, seg = 4 / R;
  for (let i = -fw; i < fw; i += seg) {
    if (Math.abs(i + seg / 2) < 6 / R) continue; // gate
    for (const side of [-fd, fd]) {
      const [x, z] = local(i + seg / 2, side);
      add('fence', x, z, farmRot, [4, 1.2, 0.2], true);
    }
  }
  for (let i = -fd; i < fd; i += seg) {
    if (Math.abs(i + seg / 2) < 6 / R) continue;
    for (const side of [-fw, fw]) {
      const [x, z] = local(side, i + seg / 2);
      add('fence', x, z, farmRot + Math.PI / 2, [4, 1.2, 0.2], true);
    }
  }

  // Rocks: scattered, denser along the ridge.
  // Cover scales with the map's width (not area), so a small map stays cluttered.
  const rockCount = Math.round(70 * K), ridgeRocks = Math.round(30 * K);
  for (let i = 0; i < rockCount; i++) {
    let x: number, z: number;
    if (i < ridgeRocks) {
      const t = rng.next();
      x = RIDGE.ax + (RIDGE.bx - RIDGE.ax) * t + rng.range(-30, 30) * R;
      z = RIDGE.az + (RIDGE.bz - RIDGE.az) * t + rng.range(-30, 30) * R;
    } else {
      x = rng.range(-half + RIM, half - RIM);
      z = rng.range(-half + RIM, half - RIM);
    }
    if (inFarm(x, z, 15)) continue;
    const s = rng.range(2, 7);
    add('rock', x, z, rng.range(0, Math.PI * 2), [s * rng.range(1, 1.8), s * rng.range(0.6, 1.2), s], false);
  }

  // Tree patches.
  const patches = Math.max(3, Math.round(7 * K + 1));
  for (let p = 0; p < patches; p++) {
    const cx = rng.range(-half + RIM + 20, half - RIM - 20), cz = rng.range(-half + RIM + 20, half - RIM - 20);
    if (inFarm(cx, cz, 50 * R)) continue;
    const count = Math.round(rng.int(12, 24) * R);
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2), r = 32 * R * Math.sqrt(rng.next());
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (!inBounds(x, z, RIM)) continue;
      const h = rng.range(6, 11);
      add('tree', x, z, rng.range(0, Math.PI * 2), [h * 0.35, h, h * 0.35], true);
    }
  }

  // Small walls: some near the farm, some in the open.
  for (let i = 0; i < 14; i++) {
    const near = i < 6;
    const a = rng.range(0, Math.PI * 2);
    const x = near ? FARM.x + Math.cos(a) * rng.range(55, 75) * R : rng.range(-half + RIM, half - RIM);
    const z = near ? FARM.z + Math.sin(a) * rng.range(55, 75) * R : rng.range(-half + RIM, half - RIM);
    add('wall', x, z, rng.range(0, Math.PI), [6, 2, 0.6], true);
  }

  // Spawns: 8 on an outer ring, 4 inside, all facing the centre.
  const spawns: Spawn[] = [];
  const ring = (count: number, radius: number, offset: number) => {
    for (let i = 0; i < count; i++) {
      const a = offset + (i / count) * Math.PI * 2;
      const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
      // Forward is -z; face the map centre.
      spawns.push({ x, z, rotY: Math.atan2(x, z) });
    }
  };
  ring(8, 360 * K, 0.2);
  ring(4, 170 * K, 0.9);
  // No spawning in the farm yard.
  for (let i = spawns.length - 1; i >= 0; i--) if (inFarm(spawns[i].x, spawns[i].z, 15)) spawns.splice(i, 1);
  // Keep spawns clear of objects.
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i];
    if (spawns.some((s) => Math.hypot(s.x - o.x, s.z - o.z) < 12)) objects.splice(i, 1);
  }
  objects.forEach((o, i) => (o.id = i));

  return { seed, size: MAP_SIZE, cells: MAP_CELLS, heights, objects, spawns, heightAt };
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp01(v: number) {
  return clamp(v, 0, 1);
}
function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number) {
  const dx = bx - ax, dz = bz - az;
  const t = clamp01(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
