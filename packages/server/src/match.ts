import {
  BLEED_OUT, BULLET_SPEED, COUNTDOWN_SECONDS, WIND_DRIFT, weatherFor, windAt, ENEMY_DAMAGE, ENEMY_ID_BASE, EXTRACT_RADIUS, EnemyAi, FOLIAGE_SEE, GRAVITY,
  Health, MAX_PLAYERS, Obstacles, RESULTS_TIME, REVIVE_HEALTH, REVIVE_RANGE, SPAWN_PROTECTION, encodeEnemies, generateMap,
  type ClientMsg, type EnemyShot, type GameMap, type HitZone, type Life, type Phase, type PlayerInfo, type PlayerView,
  type Score, type ServerMsg, type SoldierState,
} from '@spec-ops/shared';

export interface Player {
  id: number;
  name: string;
  ready: boolean;
  state: SoldierState | null; // last reported position, stance and velocity
  send(msg: ServerMsg): void;
  sendBinary(data: ArrayBuffer): void;
  // Combat (the server owns health and life; clients report their own bullets' hits)
  health: Health;
  life: Life;
  downAt: number; // ms timestamp of going down (bleeds out BLEED_OUT later)
  protectedUntil: number; // ms timestamp: hits before this are ignored (spawn protection)
  kills: number;
  downs: number;
  revives: number;
  shots: number;
  hits: number;
  hitShots: Set<number>; // shots already counted as hits (accuracy counts each shot once)
}

type Fire = Extract<ClientMsg, { t: 'fire' }>;
type Hit = Extract<ClientMsg, { t: 'hit' }>;

/**
 * Players, the lobby and the co-op mission. Pure logic: no sockets, so it is easy to test.
 * The server owns the enemy (it runs the AI in tick) and decides when the mission is over:
 * success when everyone still standing is on the extraction pad, failure when nobody is.
 * Each mission gets a new map unless the seed was fixed in the config.
 */
export class Match {
  readonly players = new Map<number, Player>();
  phase: Phase = 'lobby';
  countdown = 0;
  seed: number;
  private fixedSeed: number; // 0: a new random map every mission
  private map: GameMap;
  private ai: EnemyAi;
  private startedAt = 0; // ms
  private nextShot = 1; // ids for enemy bullets
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private resultsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(seed: number) {
    this.fixedSeed = seed;
    this.seed = seed || randomSeed();
    this.map = generateMap(this.seed);
    this.ai = this.newAi();
  }

  private newAi() {
    return new EnemyAi(this.map, new Obstacles(this.map, FOLIAGE_SEE), weatherFor(this.seed).visibility);
  }

  /** Seconds into the mission (0 outside one): drives the wind's gusts, the same on every client. */
  private missionTime() {
    return this.phase === 'live' ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  get full() {
    return this.players.size >= MAX_PLAYERS;
  }

  /** Lowest free id from 1. */
  private freeId() {
    for (let id = 1; ; id++) if (!this.players.has(id)) return id;
  }

  join(name: string, send: Player['send'], sendBinary: Player['sendBinary']): Player {
    const p: Player = {
      id: this.freeId(), name: name.slice(0, 16) || 'SOLDIER', ready: false, state: null, send, sendBinary,
      health: new Health(), life: 'up', downAt: 0, protectedUntil: Date.now() + SPAWN_PROTECTION * 1000,
      kills: 0, downs: 0, revives: 0, shots: 0, hits: 0, hitShots: new Set(),
    };
    this.players.set(p.id, p);
    p.send({ t: 'welcome', id: p.id, seed: this.seed, players: this.list(), phase: this.phase, spawn: this.pickSpawn(p.id), time: this.missionTime() });
    this.broadcastLobby();
    return p;
  }

  leave(id: number) {
    if (!this.players.delete(id)) return;
    this.broadcast({ t: 'left', id });
    if (this.players.size === 0) return this.toLobby();
    this.broadcastLobby();
    this.maybeCountdown();
    if (this.phase === 'live') this.checkMissionEnd();
  }

  setReady(id: number, ready: boolean) {
    const p = this.players.get(id);
    if (!p || this.phase !== 'lobby') return;
    p.ready = ready;
    this.broadcastLobby();
    this.maybeCountdown();
  }

  /** Anyone pressed START NOW, or the host typed `start`: go even if not everyone is ready. */
  forceStart() {
    if (this.phase === 'lobby' && this.players.size > 0) this.startCountdown();
  }

  /** Everyone ready: count down. */
  private maybeCountdown() {
    const all = [...this.players.values()];
    if (this.phase === 'lobby' && all.length > 0 && all.every((p) => p.ready)) this.startCountdown();
  }

  private startCountdown() {
    this.phase = 'countdown';
    this.countdown = COUNTDOWN_SECONDS;
    this.broadcastLobby();
    this.countdownTimer = setInterval(() => {
      this.countdown--;
      if (this.countdown > 0) this.broadcastLobby();
      else this.goLive();
    }, 1000);
  }

  private goLive() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.phase = 'live';
    this.startedAt = Date.now();
    this.ai.reset();
    for (const p of this.players.values()) {
      this.resetCombat(p);
      p.send({ t: 'spawn', spawn: this.pickSpawn(p.id) });
    }
    console.log(`[mission] started: ${this.players.size} players, map ${this.seed}`);
    this.broadcastLobby();
  }

  /** Back to the lobby, with the next mission's map ready (clients rejoin to load it). */
  private toLobby() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.resultsTimer) clearTimeout(this.resultsTimer);
    this.countdownTimer = this.resultsTimer = null;
    this.phase = 'lobby';
    for (const p of this.players.values()) p.ready = false;
    if (!this.fixedSeed) {
      this.seed = randomSeed();
      this.map = generateMap(this.seed);
      this.ai = this.newAi();
    }
  }

  private resetCombat(p: Player) {
    Object.assign(p, { life: 'up', protectedUntil: Date.now() + SPAWN_PROTECTION * 1000, kills: 0, downs: 0, revives: 0, shots: 0, hits: 0 });
    p.health.reset();
    p.hitShots.clear();
  }

  // --- Combat ---

  /** A player fired: count it, let the enemy hear it, show the shot to everyone else. */
  fire(from: Player, msg: Fire) {
    if (this.phase !== 'live' || from.life !== 'up') return;
    from.shots++;
    this.ai.heardShot(from.id, { x: msg.pos[0], y: msg.pos[1], z: msg.pos[2] });
    for (const p of this.players.values()) {
      if (p !== from) p.send({ t: 'fire', from: from.id, shot: msg.shot, pos: msg.pos, vel: msg.vel });
    }
  }

  /** The shooter's client says its bullet hit an enemy. (Players can't hurt each other.) */
  hit(from: Player, msg: Hit) {
    if (msg.target < ENEMY_ID_BASE || this.phase !== 'live' || from.life !== 'up') return;
    const at = from.state?.pos ?? msg.point;
    const res = this.ai.damage(msg.target, msg.zone, from.id, { x: at[0], y: at[1], z: at[2] });
    if (!res) return;
    if (!from.hitShots.has(msg.shot)) {
      from.hitShots.add(msg.shot);
      from.hits++;
    }
    if (!res.killed) return;
    from.kills++;
    this.broadcast({ t: 'enemyDown', id: msg.target, killer: from.id, zone: msg.zone, dir: msg.dir, scores: this.scores() });
  }

  /** A player held E next to a downed teammate long enough. Trusted, but they must be close. */
  revive(from: Player, targetId: number) {
    const t = this.players.get(targetId);
    if (this.phase !== 'live' || from.life !== 'up' || !t || t.life !== 'down' || !from.state || !t.state) return;
    const [ax, , az] = from.state.pos, [bx, , bz] = t.state.pos;
    if (Math.hypot(ax - bx, az - bz) > REVIVE_RANGE + 1.5) return; // a little slack for lag
    t.life = 'up';
    t.health.reset();
    t.health.health = REVIVE_HEALTH;
    t.health.sinceHit = 0;
    from.revives++;
    console.log(`[revive] ${from.name} got ${t.name} up`);
    this.broadcast({ t: 'revived', id: t.id, by: from.id, health: REVIVE_HEALTH, scores: this.scores() });
    this.broadcastLobby();
  }

  /** One AI step: the enemy looks, moves and shoots; players heal or bleed out; the mission may end. */
  tick(dt: number) {
    if (this.phase !== 'live') return;
    const now = Date.now();
    const views: PlayerView[] = [];
    for (const p of this.players.values()) {
      if (p.life === 'up') p.health.regen(dt);
      if (p.life === 'down' && now - p.downAt > BLEED_OUT * 1000) {
        p.life = 'dead';
        console.log(`[mission] ${p.name} bled out`);
        this.broadcast({ t: 'bledOut', id: p.id, scores: this.scores() });
        this.broadcastLobby();
      }
      if (!p.state) continue;
      const [x, y, z] = p.state.pos, [vx, vy, vz] = p.state.vel;
      views.push({ id: p.id, pos: { x, y, z }, vel: { x: vx, y: vy, z: vz }, stance: p.state.stance, alive: p.life === 'up' });
    }
    for (const shot of this.ai.step(dt, views)) this.enemyFired(shot);
    const packet = encodeEnemies(this.ai.views());
    for (const p of this.players.values()) p.sendBinary(packet);
    this.checkMissionEnd();
  }

  /** An enemy fired: everyone sees the bullet; the hit (decided by the AI) lands now. */
  private enemyFired(shot: EnemyShot) {
    // Aim the visible bullet so that, with drop and wind, it arrives where the AI meant it to.
    const dx = shot.to.x - shot.from.x, dy = shot.to.y - shot.from.y, dz = shot.to.z - shot.from.z;
    const t = Math.max(0.01, Math.hypot(dx, dz) / BULLET_SPEED);
    const wind = windAt(weatherFor(this.seed), this.missionTime());
    const ax = wind.x * WIND_DRIFT, az = wind.z * WIND_DRIFT;
    const vel: [number, number, number] = [dx / t - 0.5 * ax * t, dy / t + 0.5 * GRAVITY * t, dz / t - 0.5 * az * t];
    this.broadcast({ t: 'fire', from: shot.enemy, shot: this.nextShot++, pos: [shot.from.x, shot.from.y, shot.from.z], vel });
    const target = shot.hit && this.players.get(shot.hit.player);
    if (!shot.hit || !target || target.life !== 'up' || Date.now() < target.protectedUntil) return;
    const zone = shot.hit.zone;
    const res = target.health.applyHit(zone, ENEMY_DAMAGE);
    this.broadcast({ t: 'damage', target: target.id, attacker: shot.enemy, zone, damage: res.damage, health: res.health, point: [shot.to.x, shot.to.y, shot.to.z] });
    if (res.killed) this.goDown(target, shot.enemy, zone);
  }

  private goDown(p: Player, by: number, zone: HitZone) {
    p.life = 'down';
    p.downAt = Date.now();
    p.downs++;
    console.log(`[mission] ${p.name} is down (${zone})`);
    this.broadcast({ t: 'down', id: p.id, by, zone, bleedOut: BLEED_OUT, scores: this.scores() });
    this.broadcastLobby();
  }

  /** Success: nobody down and everyone standing is on the pad. Failure: nobody standing. */
  private checkMissionEnd() {
    const all = [...this.players.values()];
    const up = all.filter((p) => p.life === 'up');
    if (up.length === 0) return this.endMission(false);
    if (all.some((p) => p.life === 'down')) return;
    const { x, z } = this.map.extract;
    if (up.every((p) => p.state && Math.hypot(p.state.pos[0] - x, p.state.pos[2] - z) <= EXTRACT_RADIUS)) this.endMission(true);
  }

  private endMission(success: boolean) {
    const time = Math.round((Date.now() - this.startedAt) / 1000);
    console.log(`[mission] ${success ? 'EXTRACTED' : 'FAILED'} after ${time} s`);
    this.phase = 'results';
    this.broadcast({ t: 'results', success, time, scores: this.scores(), seconds: RESULTS_TIME });
    this.broadcastLobby();
    this.resultsTimer = setTimeout(() => {
      this.toLobby();
      this.broadcastLobby();
    }, RESULTS_TIME * 1000);
  }

  scores(): Score[] {
    return [...this.players.values()]
      .map(({ id, name, kills, downs, revives, shots, hits }) => ({ id, name, kills, downs, revives, shots, hits }))
      .sort((a, b) => b.kills - a.kills || b.revives - a.revives || a.downs - b.downs);
  }

  /** Everyone starts at the insertion point: map spawns 0-3, side by side. */
  pickSpawn(forId: number): number {
    return (forId - 1) % 4;
  }

  list(): PlayerInfo[] {
    return [...this.players.values()].map(({ id, name, ready, life }) => ({ id, name, ready, life }));
  }

  broadcast(msg: ServerMsg) {
    for (const p of this.players.values()) p.send(msg);
  }

  private broadcastLobby() {
    this.broadcast({ t: 'lobby', players: this.list(), phase: this.phase, countdown: this.countdown, seed: this.seed });
  }
}

function randomSeed() {
  return 1 + Math.floor(Math.random() * 999999);
}
