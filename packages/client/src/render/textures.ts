import * as THREE from 'three';
import { makeRng } from '@spec-ops/shared';

// Procedural surface textures, drawn once into small canvases at startup: a step toward Half-Life 1
// style surfaces (bilinear, mipmapped, a little grain and wear) without any asset files. Most are
// near-white detail meant to be multiplied by a material colour, so the palette (and the enemies'
// mood colours) still decide the look; a few carry their own colour (bark, needles, wood).

const ANISOTROPY = 8;

/** Tileable value noise with octaves, on [0,1)^2. */
function tileNoise(seed: number) {
  const rng = makeRng(seed);
  const N = 256, perm = new Uint8Array(N), val = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    perm[i] = i;
    val[i] = rng.next();
  }
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  const wrap = (i: number, p: number) => ((i % p) + p) % p;
  const lattice = (x: number, y: number, px: number, py: number) => val[perm[(perm[wrap(x, px) & 255] + wrap(y, py)) & 255]];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  /** One octave with `px` x `py` lattice cells over the tile (different counts stretch it into grain). */
  const one = (u: number, v: number, px: number, py: number) => {
    const x = u * px, y = v * py, ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
    const a = lattice(ix, iy, px, py), b = lattice(ix + 1, iy, px, py), c = lattice(ix, iy + 1, px, py), d = lattice(ix + 1, iy + 1, px, py);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  /** fbm in 0..1, starting at `px` x `py` cells across the tile, doubling each octave. */
  return (u: number, v: number, px: number, py = px, octaves = 4) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0, k = 1; o < octaves; o++, k *= 2) {
      sum += amp * one(u, v, px * k, py * k);
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

type Pixel = (u: number, v: number, x: number, y: number) => [number, number, number];

function make(size: number, pixel: Pixel, colorSpace: THREE.ColorSpace = THREE.SRGBColorSpace): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x / size, y / size, x, y);
      const i = (y * size + x) * 4;
      img.data[i] = clamp255(r);
      img.data[i + 1] = clamp255(g);
      img.data[i + 2] = clamp255(b);
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = colorSpace;
  t.anisotropy = ANISOTROPY;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const grey = (v: number): [number, number, number] => [v * 255, v * 255, v * 255];

let cache: ReturnType<typeof build> | null = null;
/** All the textures, built on first use. */
export function textures() {
  return (cache ??= build());
}

function build() {
  const n = tileNoise(11), n2 = tileNoise(23), n3 = tileNoise(37);
  const grain = makeRng(5);
  const fine = () => grain.next() - 0.5;

  // Snow: broad soft drifts, faint wind ripples, fine grain, a few glints. Near white.
  const snow = make(256, (u, v) => {
    const drift = n(u, v, 4) - 0.5;
    const ripple = Math.sin((v + 0.08 * n2(u, v, 3)) * Math.PI * 2 * 9) * 0.5 + 0.5;
    let k = 0.94 + drift * 0.09 + ripple * 0.025 + fine() * 0.03;
    if (grain.next() < 0.004) k = 1.08;
    return [k * 248, k * 251, k * 255];
  });

  // Rock: mottled, blotchy grey with lichen-dark patches, faint strata and a few short cracks.
  const rock = make(256, (u, v) => {
    const m = n(u, v, 5), blot = n3(u, v, 3), s = n2(u, v, 2, 20);
    const crackMask = n2(u, v, 3) > 0.62;
    const crack = crackMask && Math.abs(n3(u, v, 7) - 0.5) < 0.012 ? 0.6 : 1;
    const k = (0.5 + m * 0.42 + (s - 0.5) * 0.1 - Math.max(0, blot - 0.62) * 0.6 + fine() * 0.07) * crack;
    return grey(Math.min(1, k));
  });

  // Bark: dark brown-grey, deep vertical furrows, a few cross cracks.
  const bark = make(128, (u, v) => {
    const furrow = n(u, v, 16, 2, 3);
    const cross = Math.abs(n2(u, v, 4, 24) - 0.5) < 0.03 ? 0.7 : 1;
    const k = (0.55 + furrow * 0.7 + fine() * 0.08) * cross;
    return [78 * k, 64 * k, 54 * k];
  });

  // Pine needles: dark green-blue with lighter and darker tufts, and a dusting of snow that
  // thickens into soft clumps.
  const needles = make(128, (u, v) => {
    const tuft = n(u, v, 8), strand = n2(u, v, 32, 8, 2);
    const k = 0.7 + tuft * 0.45 + (strand - 0.5) * 0.35 + fine() * 0.1;
    const green = [40 * k, 62 * k, 58 * k];
    const snowy = Math.max(0, Math.min(1, (n3(u, v, 8) - 0.6) * 5)) * (0.75 + fine() * 0.4);
    return [0, 1, 2].map((i) => green[i] + ([214, 222, 230][i] - green[i]) * snowy) as [number, number, number];
  });

  // Planks: horizontal weathered boards with grain and dark seams.
  const planks = make(128, (u, v) => {
    const board = Math.floor(v * 8), inBoard = (v * 8) % 1;
    const seam = inBoard < 0.07 ? 0.45 : inBoard > 0.95 ? 0.75 : 1;
    const g = n(u, v, 2, 32, 3); // long grain along u
    const tone = 0.85 + ((board * 37) % 7) * 0.025;
    const knot = Math.hypot(((u * 3 + board * 0.37) % 1) - 0.5, (inBoard - 0.5) * 0.4) < 0.04 ? 0.7 : 1;
    const k = (0.75 + g * 0.35 + fine() * 0.05) * seam * tone * knot;
    return [168 * k, 152 * k, 134 * k];
  });

  // Corrugated metal roofing: ribs, streaks of wear.
  const metalRoof = make(128, (u, v) => {
    const rib = 0.8 + 0.2 * Math.sin(u * Math.PI * 2 * 12);
    const streak = n(u, v, 32, 2, 3);
    const k = rib * (0.8 + streak * 0.3) + fine() * 0.04;
    return [74 * k, 80 * k, 86 * k];
  });

  // Burlap (sandbags): a coarse weave.
  const burlap = make(64, (u, v, x, y) => {
    const weave = ((x >> 1) + (y >> 1)) % 2 ? 0.92 : 1.04;
    const k = weave * (0.85 + n(u, v, 4) * 0.25) + fine() * 0.06;
    return [176 * k, 166 * k, 140 * k];
  });

  // Uniform cloth: a fine weave and a little dirt, near white (tinted by the material colour).
  const cloth = make(64, (u, v, x, y) => {
    const weave = (x + y) % 2 ? 0.95 : 1;
    const k = weave * (0.86 + n(u, v, 4) * 0.16) + fine() * 0.04;
    return grey(k);
  });

  // Gun metal: brushed, near white (tinted dark).
  const metal = make(64, (u, v) => grey(0.8 + n(u, v, 2, 16, 2) * 0.3 + fine() * 0.05));

  // Rifle stock wood: warm grain.
  const wood = make(128, (u, v) => {
    const g = n(u, v, 2, 24, 3), ring = 0.5 + 0.5 * Math.sin((v * 40 + g * 6) * Math.PI);
    const k = 0.75 + ring * 0.2 + g * 0.15 + fine() * 0.04;
    return [110 * k, 72 * k, 44 * k];
  });

  // Concrete: speckled grey with stains.
  const concrete = make(128, (u, v) => {
    const stain = n(u, v, 3);
    const k = 0.78 + stain * 0.22 + fine() * 0.12;
    return grey(k);
  });

  return { snow, rock, bark, needles, planks, metalRoof, burlap, cloth, metal, wood, concrete };
}

/**
 * Give a geometry world-scaled UVs by projecting each vertex along the axis its normal points
 * most (box mapping): textures keep the same size on every face and object, `scale` m per repeat.
 * Works on any geometry with normals (compute them first).
 */
export function boxUV(geo: THREE.BufferGeometry, scale: number, offset = new THREE.Vector3()) {
  const p = geo.attributes.position, nrm = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + offset.x, y = p.getY(i) + offset.y, z = p.getZ(i) + offset.z;
    const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
    let u: number, v: number;
    if (ay >= ax && ay >= az) [u, v] = [x, z];
    else if (ax >= az) [u, v] = [z, y];
    else [u, v] = [x, y];
    uv[i * 2] = u / scale;
    uv[i * 2 + 1] = v / scale;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}
