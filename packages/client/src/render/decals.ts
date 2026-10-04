import * as THREE from 'three';
import { SURFACE, type GameMap } from '@spec-ops/shared';

// Marks on the ground: boot prints in the snow (everyone's: you can read where a patrol went) and
// blood pools under the fallen. Each kind is one instanced mesh with a ring buffer, so old marks
// are reused. Prints fill in with snow over time: their tint fades to white (heavier snow, faster).

const PRINTS = 2500;
const POOLS = 120;
const PRINT_LIFE = [150, 50]; // s a print lasts in no snow .. heavy snow

function printTexture() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  // A boot sole: the ball of the foot and the heel, soft edged, in shadowy blue.
  ctx.filter = 'blur(1.5px)';
  ctx.fillStyle = 'rgba(105,125,155,0.85)';
  ctx.beginPath();
  ctx.ellipse(16, 21, 10, 17, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(16, 50, 8, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tread bars.
  ctx.fillStyle = 'rgba(90,110,140,0.5)';
  for (let y = 9; y < 38; y += 6) ctx.fillRect(8, y, 16, 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function poolTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.filter = 'blur(2px)';
  ctx.fillStyle = 'rgba(92,8,10,0.85)';
  // A splat: a few overlapping blobs.
  for (const [x, y, r] of [[32, 32, 18], [22, 28, 10], [42, 36, 11], [30, 44, 9], [38, 22, 8]]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Ring {
  mesh: THREE.InstancedMesh;
  next: number;
  born: Float32Array;
  size: Float32Array; // full size of each mark (m)
  fade: THREE.InstancedBufferAttribute; // 0..1 opacity of each mark
}

export class Decals {
  private prints: Ring;
  private pools: Ring;
  private lastFade = 0;
  private readonly printLife: number;

  constructor(scene: THREE.Scene, private map: GameMap, snow: number) {
    this.printLife = PRINT_LIFE[0] + (PRINT_LIFE[1] - PRINT_LIFE[0]) * snow;
    const ring = (geo: THREE.BufferGeometry, map: THREE.Texture, count: number): Ring => {
      const fade = new THREE.InstancedBufferAttribute(new Float32Array(count).fill(1), 1);
      geo.setAttribute('fade', fade);
      const mat = new THREE.MeshLambertMaterial({
        map, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      });
      // Per-mark opacity, from the instanced 'fade' attribute.
      mat.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float fade;\nvarying float vFade;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFade = fade;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vFade;')
          .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vFade;');
      };
      const mesh = new THREE.InstancedMesh(geo, mat, count);
      mesh.count = 0;
      mesh.frustumCulled = false; // spread over the whole map
      mesh.receiveShadow = true;
      scene.add(mesh);
      return { mesh, next: 0, born: new Float32Array(count), size: new Float32Array(count), fade };
    };
    this.prints = ring(new THREE.PlaneGeometry(0.15, 0.32).rotateX(-Math.PI / 2), printTexture(), PRINTS);
    this.pools = ring(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), poolTexture(), POOLS);
  }

  /** A boot print at (x, z): `yaw` the way the soldier faces (0 = -z), `side` -1 left foot, 1 right. */
  print(x: number, z: number, yaw: number, side: number, now: number) {
    x += Math.cos(yaw) * 0.12 * side;
    z -= Math.sin(yaw) * 0.12 * side;
    if (this.onSnow(x, z)) this.place(this.prints, x, z, yaw, 1, now);
  }

  /** A pool of blood under a body: starts small and spreads to `size` m over a few seconds. */
  pool(x: number, z: number, size: number, now: number) {
    this.place(this.pools, x, z, Math.random() * Math.PI * 2, size, now);
  }

  /** Everything gone (a new mission). */
  clear() {
    for (const r of [this.prints, this.pools]) {
      r.mesh.count = 0;
      r.next = 0;
    }
  }

  update(now: number) {
    if (now - this.lastFade < 0.25) return;
    this.lastFade = now;
    // Prints fill in with snow: fading out over the last half of their life.
    const r = this.prints;
    for (let i = 0; i < r.mesh.count; i++) {
      const k = (now - r.born[i]) / this.printLife;
      r.fade.setX(i, Math.max(0, Math.min(1, 2 - 2 * k)));
    }
    r.fade.needsUpdate = true;
    // Pools spread.
    const p = this.pools;
    let grew = false;
    for (let i = 0; i < p.mesh.count; i++) {
      const age = now - p.born[i];
      if (age > 5) continue;
      p.mesh.getMatrixAt(i, M);
      M.decompose(T, Q, S);
      const s = p.size[i] * (0.2 + 0.8 * Math.min(1, age / 5) ** 0.6);
      p.mesh.setMatrixAt(i, M.compose(T, Q, S.set(s, 1, s)));
      grew = true;
    }
    if (grew) p.mesh.instanceMatrix.needsUpdate = true;
  }

  private place(r: Ring, x: number, z: number, yaw: number, size: number, now: number) {
    const y = this.map.heightAt(x, z);
    // Lie flat on the slope: tilt to the ground's normal, then turn to face the way.
    const e = 0.3;
    N.set(this.map.heightAt(x - e, z) - this.map.heightAt(x + e, z), 2 * e, this.map.heightAt(x, z - e) - this.map.heightAt(x, z + e)).normalize();
    Q.setFromUnitVectors(UP, N).multiply(Q2.setFromAxisAngle(UP, yaw));
    const i = r.next, s = r === this.pools ? size * 0.2 : size;
    r.mesh.setMatrixAt(i, M.compose(T.set(x, y + 0.015, z), Q, S.set(s, 1, s)));
    r.born[i] = now;
    r.size[i] = size;
    r.fade.setX(i, 1);
    r.fade.needsUpdate = true;
    r.next = (i + 1) % r.born.length;
    r.mesh.count = Math.max(r.mesh.count, i + 1);
    r.mesh.instanceMatrix.needsUpdate = true;
  }

  private onSnow(x: number, z: number) {
    const m = this.map, n = m.cells + 1, step = m.size / m.cells;
    const ix = Math.round((x + m.size / 2) / step), iz = Math.round((z + m.size / 2) / step);
    if (ix < 0 || iz < 0 || ix >= n || iz >= n) return false;
    return m.surface[iz * n + ix] === SURFACE.snow;
  }
}

const M = new THREE.Matrix4(), T = new THREE.Vector3(), Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion();
const S = new THREE.Vector3(), N = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
