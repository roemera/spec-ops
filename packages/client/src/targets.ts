import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { MAP_SIZE, RESPAWN_DELAY, type GameMap, type Spawn } from '@skeleton-crew/shared';
import { TankSim } from './sim/tank';
import { buildTankModel, TRACK_TEXTURE_LENGTH, type TankModel } from './models/tank';
import type { Audio, Loop } from './audio';
import type { Fx } from './fx';

// Practice tanks for offline shooting (milestone 2). They sit still, except one that drives in circles.

export interface Target {
  sim: TankSim;
  model: TankModel;
  spawn: Spawn;
  engine: Loop;
  deadFor: number; // >0 while destroyed, counting down to respawn
}

const WRECK = new THREE.MeshLambertMaterial({ color: 0x110011 });

export class Targets {
  readonly list: Target[] = [];

  constructor(
    private physics: RAPIER.World,
    private scene: THREE.Scene,
    private map: GameMap,
    from: Spawn,
    private audio: Audio,
    private fx: Fx,
  ) {
    // Fan of targets ahead of the player's spawn, at increasing range.
    const fwd = new THREE.Vector2(-Math.sin(from.rotY), -Math.cos(from.rotY));
    const right = new THREE.Vector2(-fwd.y, fwd.x);
    // Range scales with the map (designed at 1000 m), so the targets stay on it.
    const k = MAP_SIZE / 1000;
    const placements: Array<[number, number, number]> = [
      [Math.max(50, 120 * k), -25 * k, 1.2], // range m, sideways m, facing offset (rad): side-on
      [Math.max(80, 220 * k), 40 * k, 0],
      [320 * k, -60 * k, Math.PI], // facing away: rear shots
      [450 * k, 20 * k, 0.6],
    ];
    const eyeY = map.heightAt(from.x, from.z) + 2.5;
    for (const [range, side, face] of placements) {
      // Slide the target sideways until the spawn can see it over the terrain.
      let best = { x: 0, z: 0 };
      const lim = MAP_SIZE / 2 - 45; // stay inside the rim
      for (const shift of [0, 15, -15, 30, -30, 45, -45, 60, -60]) {
        const x = Math.max(-lim, Math.min(lim, from.x + fwd.x * range + right.x * (side + shift)));
        const z = Math.max(-lim, Math.min(lim, from.z + fwd.y * range + right.y * (side + shift)));
        best = { x, z };
        if (this.visible(from.x, eyeY, from.z, x, map.heightAt(x, z) + 1.2, z)) break;
      }
      this.add({ x: best.x, z: best.z, rotY: from.rotY + Math.PI + face });
    }
    // The second target drives slowly in circles: a moving target and a moving engine sound.
    const mover = this.list[1].sim;
    mover.throttleIdx = 3; // 1/4
    mover.steer = 0.5;
  }

  /** Line of sight over the terrain, sampled every 5 m. */
  private visible(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    const n = Math.ceil(Math.hypot(bx - ax, bz - az) / 5);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      if (this.map.heightAt(ax + (bx - ax) * t, az + (bz - az) * t) > ay + (by - ay) * t) return false;
    }
    return true;
  }

  private add(spawn: Spawn) {
    const sim = new TankSim(this.physics, spawn, this.map.heightAt(spawn.x, spawn.z));
    const model = buildTankModel();
    this.scene.add(model.root);
    const engine = this.audio.loop('engine', new THREE.Vector3(spawn.x, 0, spawn.z));
    engine.setVolume(0.8);
    this.list.push({ sim, model, spawn, engine, deadFor: 0 });
  }

  /** Find the target a collider belongs to. */
  find(collider: RAPIER.Collider): { target: Target; role: 'hull' | 'turret' | 'barrel' } | null {
    for (const target of this.list) {
      const role = target.sim.roleOf(collider);
      if (role) return { target, role };
    }
    return null;
  }

  destroy(t: Target) {
    t.deadFor = RESPAWN_DELAY;
    t.engine.setVolume(0);
    t.sim.throttleIdx = 2;
    t.sim.steer = 0;
    t.model.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.userData.mat ??= o.material;
        o.material = WRECK;
      }
    });
    const p = t.sim.body.translation();
    this.fx.fire(new THREE.Vector3(p.x, p.y + 1.2, p.z), RESPAWN_DELAY);
  }

  private respawn(t: Target) {
    const s = t.spawn;
    const y = this.map.heightAt(s.x, s.z) + 2.2;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), s.rotY);
    t.sim.body.setTranslation({ x: s.x, y, z: s.z }, true);
    t.sim.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    t.sim.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    t.sim.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    t.sim.damage.reset();
    t.model.root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.userData.mat) o.material = o.userData.mat;
    });
    t.engine.setVolume(0.8);
    if (t === this.list[1]) {
      t.sim.throttleIdx = 3;
      t.sim.steer = 0.5;
    }
  }

  step(dt: number) {
    for (const t of this.list) t.sim.step(dt);
  }

  update(dt: number) {
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
    for (const t of this.list) {
      if (t.deadFor > 0) {
        t.deadFor -= dt;
        if (t.deadFor <= 0) this.respawn(t);
      }
      t.sim.pose(pos, quat);
      t.model.root.position.copy(pos);
      t.model.root.quaternion.copy(quat);
      t.model.turret.rotation.y = t.sim.turretYaw;
      t.model.gun.rotation.x = t.sim.gunPitch;
      t.model.trackMaps[0].offset.y += (t.sim.trackSpeed[0] * dt) / TRACK_TEXTURE_LENGTH;
      t.model.trackMaps[1].offset.y += (t.sim.trackSpeed[1] * dt) / TRACK_TEXTURE_LENGTH;
      t.engine.setPosition(pos);
      if (t.deadFor <= 0) t.engine.setRate(0.6 + Math.abs(t.sim.speed) / 12);
    }
  }
}
