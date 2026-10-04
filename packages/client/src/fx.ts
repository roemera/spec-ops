import * as THREE from 'three';

// Cheap, loud effects. Animation is quantised to 12 steps per second so it stutters.

const STEP = 1 / 12;
// No fog on effects: the acid-green fog turned yellow flashes green. Fire is red, smoke is black.
const basic = (color: number) => new THREE.MeshBasicMaterial({ color, fog: false });
const MAT = {
  flash: basic(0xff1a00), // hits
  muzzle: basic(0xffffff), // firing
  hot: basic(0xff6a00),
  smoke: basic(0x0a0006),
  smokeLight: basic(0x1a1a1a),
  tracer: basic(0xff3a1a),
  bullet: basic(0xffd000),
  dust: basic(0x4a3a2a),
  fire: basic(0xff3000),
};
const SPHERE = new THREE.IcosahedronGeometry(1, 0);
const CONE = new THREE.ConeGeometry(0.6, 1.6, 5);

interface Effect {
  obj: THREE.Object3D;
  age: number;
  life: number;
  tick: (e: Effect, t: number) => void; // t = quantised age
}

export class Fx {
  private effects: Effect[] = [];
  private tracers = new Map<number, THREE.Mesh>();
  private bulletTracers = new Map<number, THREE.Mesh>();
  private static BULLET_GEO = new THREE.BoxGeometry(0.08, 0.08, 2.5);

  /** Small yellow streaks for machine-gun bullets. */
  syncBulletTracers(bullets: ReadonlyArray<{ id: number; pos: THREE.Vector3; vel: THREE.Vector3 }>) {
    const seen = new Set<number>();
    for (const b of bullets) {
      seen.add(b.id);
      let m = this.bulletTracers.get(b.id);
      if (!m) {
        m = new THREE.Mesh(Fx.BULLET_GEO, MAT.bullet);
        this.bulletTracers.set(b.id, m);
        this.scene.add(m);
      }
      m.position.copy(b.pos);
      m.lookAt(b.pos.clone().add(b.vel));
    }
    for (const [id, m] of this.bulletTracers) {
      if (seen.has(id)) continue;
      this.scene.remove(m);
      this.bulletTracers.delete(id);
    }
  }

  /** A bullet hit something hard: a tiny dark puff. Hitting a person: a red one. */
  puff(pos: THREE.Vector3, blood = false) {
    const p = new THREE.Mesh(SPHERE, blood ? MAT.flash : MAT.dust);
    p.position.copy(pos);
    this.add(p, 0.3, (e, t) => e.obj.scale.setScalar(0.25 + t * 1.5));
  }

  constructor(private scene: THREE.Scene) {}

  explosion(pos: THREE.Vector3, size = 1) {
    const flash = new THREE.Mesh(SPHERE, MAT.flash);
    flash.position.copy(pos);
    this.add(flash, 0.35, (e, t) => e.obj.scale.setScalar(size * (1 + t * 14)));
    // A short orange fireball, then black smoke that hangs around.
    for (let i = 0; i < 6; i++) {
      const fireball = i < 2;
      const puff = new THREE.Mesh(SPHERE, fireball ? MAT.hot : MAT.smoke);
      const drift = new THREE.Vector3(Math.random() - 0.5, 0.8 + Math.random(), Math.random() - 0.5).multiplyScalar(2.5 * size);
      puff.position.copy(pos);
      this.add(puff, fireball ? 0.45 : 1.8 + Math.random(), (e, t) => {
        e.obj.position.copy(pos).addScaledVector(drift, t);
        e.obj.scale.setScalar(size * (1 + t * 2.5) * Math.max(0, 1 - t / e.life));
        e.obj.rotation.set(t * 3, t * 2, 0);
      });
    }
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3) {
    const flash = new THREE.Mesh(SPHERE, MAT.muzzle);
    flash.position.copy(pos).addScaledVector(dir, 1);
    this.add(flash, 0.15, (e, t) => e.obj.scale.set(1.2, 1.2, 1.2).multiplyScalar(1 + t * 8));
    // Smoke blows off to the sides quickly so the gunner can see the shell land.
    const side = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
    for (let i = 0; i < 4; i++) {
      const puff = new THREE.Mesh(SPHERE, MAT.smokeLight);
      const at = pos.clone().addScaledVector(dir, 0.5);
      const drift = side.clone().multiplyScalar(i % 2 ? 9 : -9).add(new THREE.Vector3(0, 3, 0));
      this.add(puff, 0.6, (e, t) => {
        e.obj.position.copy(at).addScaledVector(drift, t);
        e.obj.scale.setScalar((0.4 + t * 1.5) * Math.max(0, 1 - t / e.life));
      });
    }
  }

  /** A burning wreck: flickering fire cones above a point, until `life` runs out. */
  fire(pos: THREE.Vector3, life: number) {
    for (let i = 0; i < 4; i++) {
      const cone = new THREE.Mesh(CONE, i % 2 ? MAT.fire : MAT.flash);
      const off = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(2);
      this.add(cone, life, (e, t) => {
        e.obj.position.copy(pos).add(off);
        const flick = 0.7 + 0.5 * Math.abs(Math.sin(t * 9 + i * 2));
        e.obj.scale.set(1, flick * 1.4, 1);
        e.obj.position.y += flick * 0.8;
      });
    }
  }

  /** Draw tracers for live shells; remove tracers for shells that are gone. */
  syncTracers(shells: ReadonlyArray<{ id: number; pos: THREE.Vector3; vel: THREE.Vector3 }>) {
    const seen = new Set<number>();
    for (const s of shells) {
      seen.add(s.id);
      let m = this.tracers.get(s.id);
      if (!m) {
        m = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 7), MAT.tracer);
        this.tracers.set(s.id, m);
        this.scene.add(m);
      }
      m.position.copy(s.pos);
      m.lookAt(s.pos.clone().add(s.vel));
    }
    for (const [id, m] of this.tracers) {
      if (seen.has(id)) continue;
      this.scene.remove(m);
      m.geometry.dispose();
      this.tracers.delete(id);
    }
  }

  private add(obj: THREE.Object3D, life: number, tick: Effect['tick']) {
    this.scene.add(obj);
    const e = { obj, age: 0, life, tick };
    tick(e, 0);
    this.effects.push(e);
  }

  update(dt: number) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      const before = Math.floor(e.age / STEP);
      e.age += dt;
      if (e.age >= e.life) {
        this.scene.remove(e.obj);
        this.effects.splice(i, 1);
        continue;
      }
      if (Math.floor(e.age / STEP) !== before) e.tick(e, Math.floor(e.age / STEP) * STEP);
    }
  }
}
