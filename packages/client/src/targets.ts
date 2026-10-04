import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Health, MAP_SIZE, RESPAWN_DELAY, type GameMap, type HitZone, type Spawn, type Stance } from '@spec-ops/shared';
import { buildSoldier, type SoldierModel } from './models/soldier';
import { PAL } from './render/palette';

// Practice range (offline): red soldiers at increasing range ahead of the spawn, in every stance.
// One walks back and forth. Stand-ins for the AI to come.

const PATROL_SPEED = 1.4; // m/s
const PATROL_LENGTH = 14; // m

export interface Target {
  model: SoldierModel;
  health: Health;
  stance: Stance;
  home: THREE.Vector3;
  yaw: number;
  patrol: THREE.Vector3 | null; // unit direction it walks along, or null if it stands still
  walked: number;
  deadFor: number; // >0 while dead, counting down to respawn
}

export class Targets {
  readonly list: Target[] = [];
  private time = 0;

  constructor(private scene: THREE.Scene, private map: GameMap, private physics: RAPIER.World, from: Spawn) {
    const fwd = new THREE.Vector2(-Math.sin(from.rotY), -Math.cos(from.rotY));
    const right = new THREE.Vector2(-fwd.y, fwd.x);
    const placements: Array<[number, number, Stance, boolean]> = [
      [45, -6, 'stand', false], // range m, sideways m, stance, patrols
      [90, 10, 'stand', true],
      [140, -14, 'crouch', false],
      [200, 8, 'prone', false],
      [260, -20, 'stand', false],
    ];
    physics.step(); // ray casts only see colliders once the world has stepped
    const eyeY = map.heightAt(from.x, from.z) + 1.65;
    const lim = MAP_SIZE / 2 - 30; // stay inside the rim
    for (const [range, side, stance, patrols] of placements) {
      // Slide sideways until the spawn can see it past the terrain, trees and walls.
      let best = { x: 0, z: 0 };
      for (const shift of [0, 6, -6, 12, -12, 20, -20, 30, -30, 45, -45]) {
        const x = Math.max(-lim, Math.min(lim, from.x + fwd.x * range + right.x * (side + shift)));
        const z = Math.max(-lim, Math.min(lim, from.z + fwd.y * range + right.y * (side + shift)));
        best = { x, z };
        if (this.visible(from.x, eyeY, from.z, x, map.heightAt(x, z) + (stance === 'prone' ? 0.3 : 1), z)) break;
      }
      const home = new THREE.Vector3(best.x, map.heightAt(best.x, best.z), best.z);
      const yaw = Math.atan2(-(from.x - best.x), -(from.z - best.z)); // face the spawn
      const model = buildSoldier(PAL.enemy);
      this.scene.add(model.root);
      this.list.push({
        model, health: new Health(), stance, home, yaw,
        patrol: patrols ? new THREE.Vector3(right.x, 0, right.y) : null,
        walked: 0, deadFor: 0,
      });
    }
    this.update(1); // settle into pose
  }

  /** Clear line of sight: nothing solid (ground, trees, walls) between the two points. */
  private visible(ax: number, ay: number, az: number, bx: number, by: number, bz: number) {
    const dir = { x: bx - ax, y: by - ay, z: bz - az };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    const ray = new RAPIER.Ray({ x: ax, y: ay, z: az }, { x: dir.x / len, y: dir.y / len, z: dir.z / len });
    return !this.physics.castRay(ray, len - 0.5, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
  }

  /** Which living target (and body part) a bullet step hits first. */
  hitTest(origin: THREE.Vector3, dir: THREE.Vector3, len: number): { target: Target; t: number; zone: HitZone } | null {
    let best: { target: Target; t: number; zone: HitZone } | null = null;
    for (const target of this.list) {
      if (target.deadFor > 0) continue;
      const h = target.model.hitTest(origin, dir, len);
      if (h && (!best || h.t < best.t)) best = { target, ...h };
    }
    return best;
  }

  kill(t: Target) {
    t.deadFor = RESPAWN_DELAY;
    t.model.root.visible = false;
  }

  update(dt: number) {
    this.time += dt;
    for (const t of this.list) {
      if (t.deadFor > 0) {
        t.deadFor -= dt;
        if (t.deadFor > 0) continue;
        t.health.reset();
        t.model.root.visible = true;
      }
      let amount = 0, yaw = t.yaw;
      const p = t.model.root.position.copy(t.home);
      if (t.patrol) {
        // Walk out and back along the patrol line, turning at each end.
        t.walked += PATROL_SPEED * dt;
        const leg = t.walked % (PATROL_LENGTH * 2), out = leg < PATROL_LENGTH;
        const along = out ? leg : PATROL_LENGTH * 2 - leg;
        p.addScaledVector(t.patrol, along - PATROL_LENGTH / 2);
        const dir = out ? t.patrol : t.patrol.clone().negate();
        yaw = Math.atan2(-dir.x, -dir.z);
        amount = 1;
      }
      p.y = this.map.heightAt(p.x, p.z);
      t.model.root.rotation.y = yaw;
      // Idle: a slow look around so they don't read as statues.
      const pitch = t.patrol ? 0 : Math.sin(this.time * 0.4 + p.x) * 0.08;
      t.model.pose(t.stance, pitch, (t.walked / 0.75) * Math.PI, amount, dt);
      t.model.root.updateMatrixWorld(true);
    }
  }
}
