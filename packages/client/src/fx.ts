import * as THREE from 'three';
import { GRAVITY } from '@spec-ops/shared';
import { PAL, flat } from './render/palette';

// Clean, short effects: bullet trails that linger and fade, puffs of snow, and soldiers that
// shatter into shards when they die. Smooth motion, no stutter.

const TRAIL_FADE = 0.6; // s a trail lingers after its bullet stops
const TRAIL_MAX = 150; // m of trail behind a bullet
const SHARD = new THREE.TetrahedronGeometry(0.09, 0);
const PUFF = new THREE.IcosahedronGeometry(1, 0);

interface Trail {
  line: THREE.Line;
  mat: THREE.LineBasicMaterial;
  fade: number; // >0 once its bullet is gone: seconds left
}

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  age: number;
  life: number;
  gravity: number;
  grow: number; // scale change per second (puffs grow, shards don't)
  baseScale: number;
}

export class Fx {
  private trails = new Map<number, Trail>();
  private fading: Trail[] = [];
  private particles: Particle[] = [];
  private flashes: Array<{ obj: THREE.Object3D; life: number }> = [];

  constructor(private scene: THREE.Scene, private groundAt: (x: number, z: number) => number) {}

  /** Draw a line from each bullet's muzzle to where it is now; fade out lines of bullets that stopped. */
  syncTrails(bullets: ReadonlyArray<{ id: number; start: THREE.Vector3; pos: THREE.Vector3 }>) {
    const seen = new Set<number>();
    for (const b of bullets) {
      seen.add(b.id);
      let tr = this.trails.get(b.id);
      if (!tr) {
        const mat = new THREE.LineBasicMaterial({ color: PAL.trail, transparent: true, opacity: 0.7 });
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([b.start, b.pos]), mat);
        line.frustumCulled = false;
        tr = { line, mat, fade: 0 };
        this.trails.set(b.id, tr);
        this.scene.add(tr.line);
      }
      this.setTrail(tr, b.start, b.pos);
    }
    for (const [id, tr] of this.trails) {
      if (seen.has(id)) continue;
      this.trails.delete(id);
      tr.fade = TRAIL_FADE;
      this.fading.push(tr);
    }
  }

  /** A stopped bullet's trail ends where it hit (the last sync may be one step short). */
  endTrail(id: number, at: THREE.Vector3) {
    const tr = this.trails.get(id);
    if (!tr) return;
    const p = tr.line.geometry.attributes.position as THREE.BufferAttribute;
    this.setTrail(tr, new THREE.Vector3(p.getX(0), p.getY(0), p.getZ(0)), at);
  }

  private setTrail(tr: Trail, start: THREE.Vector3, end: THREE.Vector3) {
    const from = start.distanceTo(end) > TRAIL_MAX ? end.clone().addScaledVector(start.clone().sub(end).normalize(), TRAIL_MAX) : start;
    const p = tr.line.geometry.attributes.position as THREE.BufferAttribute;
    p.setXYZ(0, from.x, from.y, from.z);
    p.setXYZ(1, end.x, end.y, end.z);
    p.needsUpdate = true;
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, scene = this.scene) {
    const m = new THREE.Mesh(PUFF, new THREE.MeshBasicMaterial({ color: PAL.flash, fog: false }));
    m.position.copy(pos).addScaledVector(dir, 0.08);
    m.scale.set(0.07, 0.07, 0.07);
    scene.add(m);
    this.flashes.push({ obj: m, life: 0.05 });
  }

  /** A bullet hit snow, rock or wood: a soft puff, coloured like what it hit. */
  impact(pos: THREE.Vector3, normal: THREE.Vector3, color: number = PAL.snow) {
    for (let i = 0; i < 4; i++) {
      const vel = normal.clone().multiplyScalar(1.5 + Math.random()).add(rand(0.8));
      this.particle(PUFF, flat(color, { transparent: true }), pos, vel, 0.6, 0.6, 0.12, 0.5);
    }
  }

  /** A soldier hit but standing: a little red burst. */
  wound(pos: THREE.Vector3, dir: THREE.Vector3, color: number) {
    const mat = flat(color);
    for (let i = 0; i < 6; i++) {
      const vel = dir.clone().multiplyScalar(2 + Math.random() * 2).add(rand(1.5));
      this.particle(SHARD, mat, pos, vel, 0.5, 1, 1, 0);
    }
  }

  /** A soldier dies: every body part bursts into shards that fly with the bullet and settle on the snow. */
  shatter(parts: THREE.Mesh[], dir: THREE.Vector3, color: number) {
    const mat = flat(color);
    const p = new THREE.Vector3();
    for (const part of parts) {
      part.getWorldPosition(p);
      for (let i = 0; i < 7; i++) {
        const vel = dir.clone().multiplyScalar(2 + Math.random() * 4).add(rand(2.5)).add(new THREE.Vector3(0, 1.5, 0));
        this.particle(SHARD, mat, p.clone().add(rand(0.12)), vel, 2.5 + Math.random(), 1, 1 + Math.random(), 0);
      }
    }
  }

  private particle(geo: THREE.BufferGeometry, mat: THREE.Material, pos: THREE.Vector3, vel: THREE.Vector3, life: number, gravity: number, scale: number, grow: number) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(scale);
    mesh.rotation.set(Math.random() * 6, Math.random() * 6, 0);
    mesh.castShadow = geo === SHARD;
    this.scene.add(mesh);
    this.particles.push({ mesh, vel, spin: rand(12), age: 0, life, gravity, grow, baseScale: scale });
  }

  update(dt: number) {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        f.obj.removeFromParent();
        ((f.obj as THREE.Mesh).material as THREE.Material).dispose();
        this.flashes.splice(i, 1);
      }
    }
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const tr = this.fading[i];
      tr.fade -= dt;
      tr.mat.opacity = 0.7 * Math.max(0, tr.fade / TRAIL_FADE);
      if (tr.fade <= 0) {
        this.scene.remove(tr.line);
        tr.line.geometry.dispose();
        tr.mat.dispose();
        this.fading.splice(i, 1);
      }
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) {
        this.scene.remove(p.mesh);
        if (p.grow) (p.mesh.material as THREE.Material).dispose(); // each puff has its own (it fades)
        this.particles.splice(i, 1);
        continue;
      }
      const m = p.mesh;
      p.vel.y -= GRAVITY * p.gravity * dt;
      m.position.addScaledVector(p.vel, dt);
      const ground = this.groundAt(m.position.x, m.position.z);
      if (m.position.y < ground) {
        // Land and stay: shards lie on the snow until they fade.
        m.position.y = ground;
        p.vel.set(0, 0, 0);
        p.spin.set(0, 0, 0);
      } else {
        m.rotation.x += p.spin.x * dt;
        m.rotation.y += p.spin.y * dt;
      }
      const k = p.age / p.life;
      if (p.grow) {
        m.scale.setScalar(p.baseScale * (1 + p.grow * p.age * 8));
        (m.material as THREE.MeshLambertMaterial).opacity = 1 - k;
      } else if (k > 0.7) m.scale.setScalar(p.baseScale * (1 - k) / 0.3); // shrink away at the end
    }
  }
}

function rand(s: number) {
  return new THREE.Vector3((Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s);
}
