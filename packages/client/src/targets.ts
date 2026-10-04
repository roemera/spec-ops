import * as THREE from 'three';
import { Health, RESPAWN_DELAY, makeRng, type GameMap, type HitZone, type Stance } from '@spec-ops/shared';
import { buildSoldier, type SoldierModel } from './models/soldier';
import { PAL } from './render/palette';

// Practice (offline): red soldiers posted at the map's outposts, one patrolling each, sometimes one
// up the watchtower. They don't fight back yet: stand-ins for the AI to come.

const PATROL_SPEED = 1.4; // m/s
const PATROL_LENGTH = 14; // m

export interface Target {
  model: SoldierModel;
  health: Health;
  stance: Stance;
  home: THREE.Vector3;
  yaw: number;
  patrol: THREE.Vector3 | null; // unit direction it walks along, or null if it stays put
  walked: number;
  deadFor: number; // >0 while dead, counting down to respawn
}

export class Targets {
  readonly list: Target[] = [];
  private time = 0;

  constructor(private scene: THREE.Scene, private map: GameMap) {
    const rng = makeRng(map.seed + 7);
    const solids = map.objects.filter((o) => o.kind === 'cabin' || o.kind === 'tower' || o.kind === 'wall');
    const blocked = (x: number, z: number) => solids.some((o) => Math.hypot(o.x - x, o.z - z) < Math.max(o.size[0], o.size[2]) / 2 + 1);
    const start = map.start;
    for (const post of map.outposts) {
      const facing = Math.atan2(-(start.x - post.x), -(start.z - post.z)); // toward where you come from
      // Someone up the tower, if there is one.
      const tower = solids.find((o) => o.kind === 'tower' && Math.hypot(o.x - post.x, o.z - post.z) < post.r + 2);
      if (tower && rng.next() < 0.7) this.add(new THREE.Vector3(tower.x, tower.y + tower.size[1] + 0.15, tower.z), facing + rng.range(-0.6, 0.6), 'stand', null);
      // Guards on the ground.
      for (let i = 0, made = 0, want = rng.int(2, 3); i < 20 && made < want; i++) {
        const a = rng.range(0, Math.PI * 2), d = rng.range(2, post.r * 0.75);
        const x = post.x + Math.cos(a) * d, z = post.z + Math.sin(a) * d;
        const stance: Stance = rng.next() < 0.25 ? 'crouch' : 'stand', turn = rng.range(-1, 1);
        if (blocked(x, z)) continue;
        this.add(new THREE.Vector3(x, map.heightAt(x, z), z), facing + turn, stance, null);
        made++;
      }
      // A patrol across the clearing.
      const a = rng.range(0, Math.PI);
      this.add(new THREE.Vector3(post.x, map.heightAt(post.x, post.z), post.z), 0, 'stand', new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    this.update(1); // settle into pose
  }

  private add(home: THREE.Vector3, yaw: number, stance: Stance, patrol: THREE.Vector3 | null) {
    const model = buildSoldier(PAL.enemy);
    this.scene.add(model.root);
    this.list.push({ model, health: new Health(), stance, home, yaw, patrol, walked: 0, deadFor: 0 });
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
        p.y = this.map.heightAt(p.x, p.z);
        const dir = out ? t.patrol : t.patrol.clone().negate();
        yaw = Math.atan2(-dir.x, -dir.z);
        amount = 1;
      } else yaw += Math.sin(this.time * 0.25 + p.z) * 0.5; // a slow look around so they don't read as statues
      t.model.root.rotation.y = yaw;
      const pitch = t.patrol ? 0 : Math.sin(this.time * 0.4 + p.x) * 0.08;
      t.model.pose(t.stance, pitch, (t.walked / 0.75) * Math.PI, amount, dt);
      t.model.root.updateMatrixWorld(true);
    }
  }
}
