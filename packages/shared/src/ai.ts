import {
  DETECT_DECAY, DETECT_RATE, ENEMY_ACCURACY, ENEMY_AIM_TIME, ENEMY_FIRE_INTERVAL, ENEMY_FIRE_RANGE, ENEMY_HEALTH,
  ENEMY_ID_BASE, ENEMY_RUN, ENEMY_WALK, HEAR_SHOT, HEAR_STEPS, SHOUT_RANGE, STANCES, STANCE_SEEN, SUSPICIOUS_AT,
  VIEW_HALF_ANGLE, VIEW_RANGE, type Stance,
} from './constants.ts';
import { Health, type HitResult, type HitZone } from './hitzones.ts';
import type { GameMap, Point } from './mapgen.ts';
import type { Obstacles, Vec3 } from './obstacles.ts';
import { makeRng } from './rng.ts';

// Enemy soldiers. Runs on the server online and in the browser offline, at AI_HZ.
//
// patrol     walking a route or standing a post, looking around
// suspicious saw or heard something: stops, turns to it, after a moment walks over to look
// search     goes to where you were (or the gunshot came from) and looks around, then gives up
// alert      knows where you are: shouts (nearby enemies come searching), takes a knee, shoots;
//            loses you behind cover, runs to where you were last seen

export type AiState = 'patrol' | 'suspicious' | 'search' | 'alert';
export const AI_STATES: AiState[] = ['patrol', 'suspicious', 'search', 'alert'];

/** What the AI needs to know about a player. */
export interface PlayerView {
  id: number;
  pos: Vec3; // feet
  vel: Vec3;
  stance: Stance;
  alive: boolean;
}

/** An enemy fired. `hit` was decided when it fired; the bullet you see is for show. */
export interface EnemyShot {
  enemy: number;
  from: Vec3;
  to: Vec3;
  hit: { player: number; zone: HitZone } | null;
}

/** What clients draw. */
export interface EnemyView {
  id: number;
  locked: boolean; // aim settled on someone: about to fire well (the laser holds steady)
  stance: Stance;
  state: AiState;
  dead: boolean;
  pos: Vec3;
  yaw: number;
  pitch: number;
}

interface Enemy {
  id: number;
  pos: Vec3;
  yaw: number;
  pitch: number;
  stance: Stance;
  state: AiState;
  stateT: number; // s in this state
  health: Health;
  dead: boolean;
  home: { x: number; z: number; yaw: number; stance: Stance };
  fixed: boolean; // up a watchtower: turns but doesn't walk
  path: Point[] | null; // patrol waypoints, walked in a loop
  pathIdx: number;
  meter: Map<number, number>; // detection per player, 0..1
  lastKnown: Vec3 | null;
  target: number | null; // player id when alert
  aimT: number; // s of keeping the target in sight
  fireCd: number;
  lostT: number; // s since the target was last in sight
  arrivedT: number; // s spent looking around at a search point
  fightStance: Stance;
  locked: boolean; // in sight and aimed in: the next shots are the dangerous ones
  phase: number; // per-enemy offset for idle looking around
}

const RADIUS = 0.35; // m, for walking round things
const TURN_RATE = 5; // rad/s
const SEARCH_LOOK = 10; // s looking around at a search point before giving up
const KILL_WITNESS = 45; // m: enemies this close who see a friend killed go on alert
const LOSE_TARGET = 15; // s out of sight before an alert enemy goes back to searching
const BOUNDS = 40; // m inside the map edge they stay

export class EnemyAi {
  enemies: Enemy[] = [];
  private map: GameMap;
  private obstacles: Obstacles;
  private viewRange: number;
  private time = 0;

  /** `visibility` (0..1, from the weather) shortens how far they can see in heavy snow. */
  constructor(map: GameMap, obstacles: Obstacles, visibility = 1) {
    this.map = map;
    this.obstacles = obstacles;
    this.viewRange = VIEW_RANGE * visibility;
    this.reset();
  }

  /** Everyone back at their posts, alive and calm (a new match). */
  reset() {
    this.enemies = plan(this.map, this.obstacles);
  }

  views(): EnemyView[] {
    return this.enemies.map((e) => ({ id: e.id, locked: e.state === 'alert' && e.locked, stance: e.stance, state: e.state, dead: e.dead, pos: { ...e.pos }, yaw: e.yaw, pitch: e.pitch }));
  }

  step(dt: number, players: PlayerView[]): EnemyShot[] {
    this.time += dt;
    const shots: EnemyShot[] = [];
    for (const e of this.enemies) {
      if (e.dead) continue;
      e.stateT += dt;
      this.perceive(e, players, dt);
      switch (e.state) {
        case 'patrol':
          this.patrol(e, dt);
          break;
        case 'suspicious':
          this.suspicious(e, dt);
          break;
        case 'search':
          this.search(e, dt);
          break;
        case 'alert': {
          const shot = this.fight(e, players, dt);
          if (shot) shots.push(shot);
          break;
        }
      }
    }
    return shots;
  }

  /** A player fired: everyone in earshot turns toward it; the near ones come looking. */
  heardShot(playerId: number, pos: Vec3) {
    for (const e of this.enemies) {
      if (e.dead || e.state === 'alert') continue;
      const d = Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z);
      if (d > HEAR_SHOT) continue;
      e.meter.set(playerId, Math.max(e.meter.get(playerId) ?? 0, d < 80 ? 0.8 : 0.5));
      e.lastKnown = fuzz(pos, d * 0.1, this.map);
      this.setState(e, d < 130 ? 'search' : 'suspicious');
    }
  }

  /** A player's bullet hit enemy `id`. Returns the result, or null if there's no such living enemy. */
  damage(id: number, zone: HitZone, shooterId: number, shooterPos: Vec3): HitResult | null {
    const e = this.enemies.find((x) => x.id === id);
    if (!e || e.dead) return null;
    const res = e.health.applyHit(zone);
    if (res.killed) {
      e.dead = true;
      // Anyone near who saw it go down (or right next to it) goes on full alert against the shooter,
      // with only a rough idea where the shot came from; their shouts bring the rest looking.
      const chest = { x: e.pos.x, y: e.pos.y + 1, z: e.pos.z };
      for (const o of this.enemies) {
        if (o.dead || o === e || o.state === 'alert') continue;
        const d = Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z);
        if (d > KILL_WITNESS || (d > 12 && this.obstacles.see(eye(o), chest) === 0)) continue;
        o.meter.set(shooterId, 1);
        this.alert(o, shooterId, fuzz(shooterPos, 20, this.map));
        // They don't know where the shot came from yet: slower to fire and to settle their aim
        // than one who spotted you, so a sniper who ducks after a kill has a moment.
        o.fireCd = rand(2, 3.5);
        o.aimT = -1;
      }
    } else {
      e.meter.set(shooterId, 1);
      this.alert(e, shooterId, fuzz(shooterPos, 4, this.map));
    }
    return res;
  }

  /** An enemy by id (for tests and the server). */
  get(id: number) {
    return this.enemies.find((e) => e.id === id) ?? null;
  }

  // --- Senses ---

  private perceive(e: Enemy, players: PlayerView[], dt: number) {
    const from = eye(e);
    const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
    let best: PlayerView | null = null, bestM = 0;
    for (const p of players) {
      let m = e.meter.get(p.id) ?? 0;
      if (!p.alive) {
        e.meter.set(p.id, 0);
        continue;
      }
      const dx = p.pos.x - e.pos.x, dz = p.pos.z - e.pos.z, dist = Math.hypot(dx, dz);
      const speed = Math.hypot(p.vel.x, p.vel.z);
      let rate = 0;
      if (dist < this.viewRange) {
        const angle = Math.acos(Math.max(-1, Math.min(1, (dx * fx + dz * fz) / Math.max(dist, 1e-6))));
        if (angle < VIEW_HALF_ANGLE || dist < 3) {
          const vis = Math.max(this.obstacles.see(from, chestOf(p)), this.obstacles.see(from, headOf(p)));
          if (vis > 0) {
            const distF = Math.max(0, 1 - (dist - 12) / (this.viewRange - 12)) ** 2.2; // far away takes a lot longer
            const fovF = angle < 0.6 ? 1 : 0.45;
            const moveF = speed > 4 ? 1.6 : speed > 0.5 ? 1 : 0.4; // keeping still is the best camouflage
            rate = DETECT_RATE * Math.min(1, distF) * fovF * moveF * STANCE_SEEN[p.stance] * vis;
            if (e.state === 'alert' && e.target === p.id) rate *= 4; // already knows where to look
          }
        }
      }
      // Footsteps: louder standing, much louder sprinting.
      const hear = HEAR_STEPS[p.stance] * (speed > 4 ? 2 : 1);
      const heard = speed > 0.5 && dist < hear;
      if (rate > 0) m += rate * dt;
      else if (!heard) m -= DETECT_DECAY * dt;
      if (heard) m = Math.max(m, SUSPICIOUS_AT + 0.05);
      m = Math.max(0, Math.min(1, m));
      e.meter.set(p.id, m);
      if ((rate > 0 || heard) && m >= SUSPICIOUS_AT) e.lastKnown = heard && rate === 0 ? fuzz(p.pos, 2, this.map) : { ...p.pos };
      if (m > bestM) [best, bestM] = [p, m];
    }
    if (!best) return;
    if (bestM >= 1 && e.state !== 'alert') this.alert(e, best.id, { ...best.pos });
    else if (bestM >= SUSPICIOUS_AT && e.state === 'patrol') this.setState(e, 'suspicious');
  }

  /** Alert: lock on, and shout so everyone near comes looking. */
  private alert(e: Enemy, playerId: number, at: Vec3) {
    const was = e.state;
    this.setState(e, 'alert');
    e.target = playerId;
    e.lastKnown = at;
    e.aimT = 0;
    e.lostT = 0;
    e.fireCd = rand(0.9, 1.7); // reaction time: you hear the shout before the first shot
    if (was === 'alert') return;
    for (const o of this.enemies) {
      if (o === e || o.dead || o.state === 'alert') continue;
      if (Math.hypot(o.pos.x - e.pos.x, o.pos.z - e.pos.z) > SHOUT_RANGE) continue;
      o.meter.set(playerId, Math.max(o.meter.get(playerId) ?? 0, 0.75));
      o.lastKnown = fuzz(at, 6, this.map);
      this.setState(o, 'search');
    }
  }

  private setState(e: Enemy, s: AiState) {
    if (e.state === s) return;
    e.state = s;
    e.stateT = 0;
    e.arrivedT = 0;
    if (s !== 'alert') e.target = null;
    if (s === 'alert') e.fightStance = e.fixed || Math.random() < 0.5 ? 'stand' : 'crouch';
  }

  // --- Behaviours ---

  private patrol(e: Enemy, dt: number) {
    e.stance = e.home.stance;
    e.pitch *= 0.9;
    if (e.path) {
      const wp = e.path[e.pathIdx];
      if (this.walk(e, wp.x, wp.z, ENEMY_WALK, dt) < 1.5) e.pathIdx = (e.pathIdx + 1) % e.path.length;
      return;
    }
    if (!e.fixed && this.walk(e, e.home.x, e.home.z, ENEMY_WALK, dt) > 1.2) return;
    this.turn(e, e.home.yaw + Math.sin(this.time * 0.25 + e.phase) * 0.7, dt);
  }

  private suspicious(e: Enemy, dt: number) {
    const lk = e.lastKnown;
    if (!lk) return this.setState(e, 'patrol');
    // Stop and look, sweeping the gun (and its laser) back and forth over where it came from;
    // after a moment, walk over carefully.
    const scan = e.stateT * 0.8 + e.phase; // a slow, deliberate sweep
    if (e.stateT < 2.5 || e.fixed) this.face(e, lk, dt, Math.sin(scan) * 0.3, Math.sin(scan * 0.7) * 0.04);
    else if (this.walk(e, lk.x, lk.z, ENEMY_WALK, dt) < 4) this.setState(e, 'search');
    if (e.stateT > 3 && maxMeter(e) < 0.1) this.setState(e, 'patrol');
  }

  private search(e: Enemy, dt: number) {
    const lk = e.lastKnown;
    if (!lk) return this.setState(e, 'patrol');
    e.stance = 'stand';
    if (!e.fixed && e.arrivedT === 0 && this.walk(e, lk.x, lk.z, ENEMY_RUN * 0.7, dt) > 3) return;
    // There (or stuck up a tower): look around, then give up.
    e.arrivedT += dt;
    this.turn(e, Math.atan2(-(lk.x - e.pos.x), -(lk.z - e.pos.z)) + Math.sin(e.arrivedT * 0.8) * 1.4, dt);
    e.pitch = Math.sin(e.arrivedT * 0.7 + e.phase) * 0.05;
    if (e.arrivedT > SEARCH_LOOK) {
      e.lastKnown = null;
      for (const k of e.meter.keys()) e.meter.set(k, Math.min(e.meter.get(k)!, SUSPICIOUS_AT * 0.5));
      this.setState(e, 'patrol');
    }
  }

  private fight(e: Enemy, players: PlayerView[], dt: number): EnemyShot | null {
    const p = players.find((x) => x.id === e.target);
    if (!p || !p.alive) {
      this.setState(e, e.lastKnown ? 'search' : 'patrol');
      return null;
    }
    const from = eye(e), chest = chestOf(p);
    const d = Math.hypot(p.pos.x - e.pos.x, p.pos.z - e.pos.z);
    const vis = Math.max(this.obstacles.see(from, chest), this.obstacles.see(from, headOf(p)));
    if (vis > 0.3 && d < ENEMY_FIRE_RANGE) { // a pine's branches between you are enough to hold their fire
      // In sight: take a knee (or not), aim, fire.
      e.lastKnown = { ...p.pos };
      e.lostT = 0;
      e.stance = e.fightStance;
      // The aim wanders onto you and settles: a steady laser means the next shot will likely hit.
      const aim = Math.min(1, e.aimT / ENEMY_AIM_TIME), wob = 1 - aim, t = this.time * 1.4 + e.phase;
      this.face(e, chest, dt, wob * 0.06 * Math.sin(t), wob * 0.03 * Math.sin(t * 1.3));
      e.locked = aim > 0.55;
      e.aimT += dt;
      e.fireCd -= dt;
      if (e.fireCd > 0) return null;
      e.fireCd = rand(ENEMY_FIRE_INTERVAL[0], ENEMY_FIRE_INTERVAL[1]);
      return this.shoot(e, p, vis, d);
    }
    // Lost sight: run to where they were.
    e.locked = false;
    e.aimT = Math.max(0, e.aimT - dt * 2);
    e.lostT += dt;
    const lk = e.lastKnown ?? p.pos;
    if (e.fixed) this.face(e, lk, dt);
    else {
      e.stance = 'stand';
      if (this.walk(e, lk.x, lk.z, ENEMY_RUN, dt) < 4) {
        this.setState(e, 'search');
        e.arrivedT = 0.01; // already there: start looking around
      }
    }
    if (e.lostT > LOSE_TARGET) this.setState(e, 'search');
    return null;
  }

  private shoot(e: Enemy, p: PlayerView, vis: number, d: number): EnemyShot {
    const aim = Math.max(0, Math.min(1, e.aimT / ENEMY_AIM_TIME));
    const distF = Math.max(0.08, Math.min(1, 1 - d / (ENEMY_FIRE_RANGE * 1.1)));
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const moveF = speed > 4 ? 0.45 : speed > 0.5 ? 0.7 : 1;
    const size = p.stance === 'stand' ? 1 : p.stance === 'crouch' ? 0.75 : 0.5;
    const chance = ENEMY_ACCURACY * (0.25 + 0.75 * aim) * distF * moveF * size * Math.min(1, vis * 1.3);
    const from = eye(e);
    const dir = norm({ x: p.pos.x - from.x, y: 0, z: p.pos.z - from.z });
    from.x += dir.x * 0.6;
    from.z += dir.z * 0.6;
    const to = chestOf(p);
    if (Math.random() < chance) {
      const r = Math.random();
      return { enemy: e.id, from, to, hit: { player: p.id, zone: r < 0.12 ? 'head' : r < 0.6 ? 'body' : 'limb' } };
    }
    // A miss: somewhere around you, close enough to hear it crack past.
    const side = { x: -dir.z, z: dir.x }, off = rand(0.7, 2.5) * (Math.random() < 0.5 ? -1 : 1);
    to.x += side.x * off;
    to.z += side.z * off;
    to.y += rand(-0.8, 1.5);
    return { enemy: e.id, from, to, hit: null };
  }

  // --- Moving ---

  /** Step toward (x, z) at `speed`, walking round obstacles. Returns the distance left. */
  private walk(e: Enemy, x: number, z: number, speed: number, dt: number) {
    const dx = x - e.pos.x, dz = z - e.pos.z, dist = Math.hypot(dx, dz);
    if (dist < 0.05) return 0;
    const step = Math.min(speed * dt, dist);
    let nx = e.pos.x + (dx / dist) * step, nz = e.pos.z + (dz / dist) * step;
    // Blocked head-on? Lean sideways so the push slides us round instead of pinning us.
    const pushed = this.obstacles.push(nx, nz, RADIUS);
    if (Math.hypot(pushed.x - e.pos.x, pushed.z - e.pos.z) < step * 0.3) {
      const s = e.phase > Math.PI ? 1 : -1;
      nx = e.pos.x + (-dz / dist) * step * s;
      nz = e.pos.z + (dx / dist) * step * s;
    }
    const p = this.obstacles.push(nx, nz, RADIUS), lim = this.map.size / 2 - BOUNDS;
    e.pos.x = Math.max(-lim, Math.min(lim, p.x));
    e.pos.z = Math.max(-lim, Math.min(lim, p.z));
    e.pos.y = this.map.heightAt(e.pos.x, e.pos.z);
    this.turn(e, Math.atan2(-dx, -dz), dt);
    return dist - step;
  }

  /** Look (and point the gun) at a point, off by `yawOff` / `pitchOff` rad (scanning, unsteady aim). */
  private face(e: Enemy, at: Vec3, dt: number, yawOff = 0, pitchOff = 0) {
    const dx = at.x - e.pos.x, dz = at.z - e.pos.z;
    this.turn(e, Math.atan2(-dx, -dz) + yawOff, dt);
    const from = eye(e);
    e.pitch = Math.atan2(at.y - from.y, Math.max(1, Math.hypot(dx, dz))) + pitchOff;
  }

  private turn(e: Enemy, yaw: number, dt: number) {
    let d = yaw - e.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    e.yaw += Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, d));
  }
}

// --- Placing the enemy: guards at every outpost, a patrol round each, roamers along the route ---

function plan(map: GameMap, obstacles: Obstacles): Enemy[] {
  const rng = makeRng(map.seed + 7);
  const out: Enemy[] = [];
  const solids = map.objects.filter((o) => o.kind === 'cabin' || o.kind === 'tower' || o.kind === 'wall');
  const blocked = (x: number, z: number) => solids.some((o) => Math.hypot(o.x - x, o.z - z) < Math.max(o.size[0], o.size[2]) / 2 + 1);
  const add = (x: number, y: number, z: number, yaw: number, stance: Stance, opts: { fixed?: boolean; path?: Point[] } = {}) => {
    out.push({
      id: ENEMY_ID_BASE + out.length,
      pos: { x, y, z }, yaw, pitch: 0, stance, state: 'patrol', stateT: 0,
      health: new Health(ENEMY_HEALTH), dead: false,
      home: { x, z, yaw, stance }, fixed: opts.fixed ?? false, path: opts.path ?? null, pathIdx: 0,
      meter: new Map(), lastKnown: null, target: null, aimT: 0, fireCd: 0, lostT: 0, arrivedT: 0,
      fightStance: 'stand', locked: false, phase: rng.range(0, Math.PI * 2),
    });
  };
  const start = map.start;
  for (const post of map.outposts) {
    const facing = Math.atan2(-(start.x - post.x), -(start.z - post.z)); // toward where you come from
    const tower = solids.find((o) => o.kind === 'tower' && Math.hypot(o.x - post.x, o.z - post.z) < post.r + 2);
    if (tower && rng.next() < 0.9) add(tower.x, tower.y + tower.size[1] + 0.15, tower.z, facing + rng.range(-0.6, 0.6), 'stand', { fixed: true });
    for (let i = 0, made = 0, want = rng.int(3, 5); i < 30 && made < want; i++) {
      const a = rng.range(0, Math.PI * 2), d = rng.range(2, post.r * 0.75);
      const x = post.x + Math.cos(a) * d, z = post.z + Math.sin(a) * d;
      const stance: Stance = rng.next() < 0.25 ? 'crouch' : 'stand', turn = rng.range(-1, 1);
      if (blocked(x, z)) continue;
      add(x, map.heightAt(x, z), z, facing + turn, stance);
      made++;
    }
    // Patrols round the edge of the clearing: one, sometimes a second going the other way.
    const a0 = rng.range(0, Math.PI * 2);
    const loop: Point[] = [];
    for (let k = 0; k < 6; k++) {
      const a = a0 + (k / 6) * Math.PI * 2;
      loop.push(obstacles.push(post.x + Math.cos(a) * post.r * 0.9, post.z + Math.sin(a) * post.r * 0.9, RADIUS + 0.5));
    }
    add(loop[0].x, map.heightAt(loop[0].x, loop[0].z), loop[0].z, 0, 'stand', { path: loop });
    if (rng.next() < 0.5) {
      const back = [...loop].reverse();
      add(back[2].x, map.heightAt(back[2].x, back[2].z), back[2].z, 0, 'stand', { path: back });
    }
  }
  // Roamers walking the route between outposts, there and back (none near the insertion point).
  const r = map.route;
  for (const [t0, t1] of [[0.4, 0.58], [0.58, 0.76], [0.76, 0.92]]) {
    const i0 = Math.floor(t0 * (r.length - 1)), i1 = Math.floor(t1 * (r.length - 1));
    const there: Point[] = [];
    for (let i = i0; i <= i1; i += 4) there.push(obstacles.push(r[i].x, r[i].z, RADIUS + 0.5));
    const path = [...there, ...there.slice(1, -1).reverse()];
    for (const startIdx of [0, 2]) {
      const p = path[startIdx % path.length];
      add(p.x, map.heightAt(p.x, p.z), p.z, 0, 'stand', { path });
      out[out.length - 1].pathIdx = (startIdx + 1) % path.length;
    }
  }
  // Sentry pairs posted off the route, watching back the way you come.
  for (let k = 0; k < 5; k++) {
    const i = Math.floor((0.45 + 0.1 * k + rng.range(-0.03, 0.03)) * (r.length - 1));
    const a = r[i], b = r[Math.min(r.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1, side = rng.next() < 0.5 ? -1 : 1, off = rng.range(15, 40);
    const px = a.x + (-(b.z - a.z) / len) * off * side, pz = a.z + ((b.x - a.x) / len) * off * side;
    const back = Math.atan2(-(r[0].x - px), -(r[0].z - pz)) + rng.range(-0.5, 0.5);
    for (const dx of [-1.5, 1.5]) {
      const p = obstacles.push(px + dx, pz, RADIUS + 0.5);
      add(p.x, map.heightAt(p.x, p.z), p.z, back + dx * 0.3, rng.next() < 0.4 ? 'crouch' : 'stand');
    }
  }
  return out;
}

function eye(e: Enemy): Vec3 {
  return { x: e.pos.x, y: e.pos.y + STANCES[e.stance].eye, z: e.pos.z };
}
function chestOf(p: PlayerView): Vec3 {
  return { x: p.pos.x, y: p.pos.y + STANCES[p.stance].height * 0.6, z: p.pos.z };
}
function headOf(p: PlayerView): Vec3 {
  return { x: p.pos.x, y: p.pos.y + STANCES[p.stance].eye, z: p.pos.z };
}
function maxMeter(e: Enemy) {
  let m = 0;
  for (const v of e.meter.values()) m = Math.max(m, v);
  return m;
}
/** A point near `p`, off by up to `err` m (where they think a sound came from). */
function fuzz(p: Vec3, err: number, map: GameMap): Vec3 {
  const x = p.x + (Math.random() - 0.5) * 2 * err, z = p.z + (Math.random() - 0.5) * 2 * err;
  return { x, y: map.heightAt(x, z), z };
}
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function rand(lo: number, hi: number) {
  return lo + Math.random() * (hi - lo);
}
