import {
  BULLET_SPEED, COUNTDOWN_SECONDS, ENEMY_DAMAGE, ENEMY_ID_BASE, EnemyAi, FOLIAGE_SEE, GRAVITY, Health, MAX_PLAYERS,
  Obstacles, RESPAWN_DELAY, RESULTS_TIME, SPAWN_PROTECTION, encodeEnemies, generateMap,
  type ClientMsg, type EnemyShot, type Phase, type PlayerInfo, type PlayerView, type Score, type ServerMsg,
  type SoldierState,
} from '@spec-ops/shared';

export interface Player {
  id: number;
  name: string;
  ready: boolean;
  state: SoldierState | null; // last reported position, stance and velocity
  send(msg: ServerMsg): void;
  sendBinary(data: ArrayBuffer): void;
  // Combat (the server owns health; clients report their own bullets' hits)
  health: Health;
  alive: boolean;
  protectedUntil: number; // ms timestamp: hits before this are ignored (spawn protection)
  kills: number;
  deaths: number;
  shots: number;
  hits: number;
  hitShots: Set<number>; // shots already counted as hits (accuracy counts each shot once)
  respawnTimer: ReturnType<typeof setTimeout> | null;
}

type Fire = Extract<ClientMsg, { t: 'fire' }>;
type Hit = Extract<ClientMsg, { t: 'hit' }>;

/**
 * Players, the lobby, the match phase and the enemy. Pure logic: no sockets, so it is easy to test.
 * The server owns the enemy: it runs the AI (tick) and tells everyone where they are.
 */
export class Match {
  readonly players = new Map<number, Player>();
  phase: Phase = 'lobby';
  countdown = 0;
  private ai: EnemyAi;
  private nextShot = 1; // ids for enemy bullets
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  readonly seed: number;
  readonly killLimit: number;
  private resultsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(seed: number, killLimit: number) {
    this.seed = seed;
    this.killLimit = killLimit;
    const map = generateMap(seed);
    this.ai = new EnemyAi(map, new Obstacles(map, FOLIAGE_SEE));
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
      health: new Health(), alive: true, protectedUntil: Date.now() + SPAWN_PROTECTION * 1000,
      kills: 0, deaths: 0, shots: 0, hits: 0, hitShots: new Set(), respawnTimer: null,
    };
    this.players.set(p.id, p);
    p.send({ t: 'welcome', id: p.id, seed: this.seed, players: this.list(), phase: this.phase, spawn: this.pickSpawn(p.id) });
    this.broadcastLobby();
    return p;
  }

  leave(id: number) {
    const p = this.players.get(id);
    if (p?.respawnTimer) clearTimeout(p.respawnTimer);
    if (!this.players.delete(id)) return;
    this.broadcast({ t: 'left', id });
    if (this.players.size === 0) this.toLobby();
    else {
      this.broadcastLobby();
      this.maybeCountdown();
    }
  }

  setReady(id: number, ready: boolean) {
    const p = this.players.get(id);
    if (!p || this.phase !== 'lobby') return;
    p.ready = ready;
    this.broadcastLobby();
    this.maybeCountdown();
  }

  /** Host typed `start`: begin even if not everyone is ready (works solo). */
  forceStart() {
    if (this.phase === 'lobby' && this.players.size > 0) this.startCountdown();
  }

  /** All ready and at least two players: count down. */
  private maybeCountdown() {
    const all = [...this.players.values()];
    if (this.phase === 'lobby' && all.length >= 2 && all.every((p) => p.ready)) this.startCountdown();
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
    this.ai.reset();
    for (const p of this.players.values()) {
      this.resetCombat(p);
      p.send({ t: 'spawn', spawn: this.pickSpawn(p.id) });
    }
    this.broadcastLobby();
  }

  private toLobby() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.resultsTimer) clearTimeout(this.resultsTimer);
    this.countdownTimer = this.resultsTimer = null;
    this.phase = 'lobby';
    for (const p of this.players.values()) {
      p.ready = false;
      if (p.respawnTimer) clearTimeout(p.respawnTimer);
      p.respawnTimer = null;
    }
  }

  private resetCombat(p: Player) {
    if (p.respawnTimer) clearTimeout(p.respawnTimer);
    Object.assign(p, { alive: true, protectedUntil: Date.now() + SPAWN_PROTECTION * 1000, kills: 0, deaths: 0, shots: 0, hits: 0, respawnTimer: null });
    p.health.reset();
    p.hitShots.clear();
  }

  // --- Combat ---

  /** A player fired: count it and show the shot to everyone else. */
  fire(from: Player, msg: Fire) {
    if (this.phase !== 'live' || !from.alive) return;
    from.shots++;
    this.ai.heardShot(from.id, { x: msg.pos[0], y: msg.pos[1], z: msg.pos[2] });
    for (const p of this.players.values()) {
      if (p !== from) p.send({ t: 'fire', from: from.id, shot: msg.shot, pos: msg.pos, vel: msg.vel });
    }
  }

  /** The shooter's client says its bullet hit someone. Trusted, but the target must be alive and unprotected. */
  hit(from: Player, msg: Hit) {
    if (msg.target >= ENEMY_ID_BASE) return this.hitEnemy(from, msg);
    const target = this.players.get(msg.target);
    if (this.phase !== 'live' || !target || target === from || !target.alive || Date.now() < target.protectedUntil) return;
    const zone = msg.zone;
    const res = target.health.applyHit(zone);
    if (!from.hitShots.has(msg.shot)) {
      from.hitShots.add(msg.shot);
      from.hits++;
    }
    this.broadcast({ t: 'damage', target: target.id, attacker: from.id, zone, damage: res.damage, health: res.health, point: msg.point });
    if (!res.killed) return;
    target.alive = false;
    target.deaths++;
    from.kills++;
    console.log(`[kill] ${from.name} killed ${target.name} (${zone}) - ${from.kills}/${this.killLimit}`);
    this.broadcast({ t: 'kill', victim: target.id, killer: from.id, zone, scores: this.scores() });
    if (from.kills >= this.killLimit) return this.endMatch(from.id);
    target.respawnTimer = setTimeout(() => this.respawn(target), RESPAWN_DELAY * 1000);
  }

  private hitEnemy(from: Player, msg: Hit) {
    if (this.phase !== 'live' || !from.alive) return;
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

  /** One AI step: the enemy looks, moves and shoots; players heal; everyone gets the enemy's positions. */
  tick(dt: number) {
    if (this.phase !== 'live') return;
    const views: PlayerView[] = [];
    for (const p of this.players.values()) {
      p.health.regen(dt);
      if (!p.state) continue;
      const [x, y, z] = p.state.pos, [vx, vy, vz] = p.state.vel;
      views.push({ id: p.id, pos: { x, y, z }, vel: { x: vx, y: vy, z: vz }, stance: p.state.stance, alive: p.alive });
    }
    for (const shot of this.ai.step(dt, views)) this.enemyFired(shot);
    const packet = encodeEnemies(this.ai.views());
    for (const p of this.players.values()) p.sendBinary(packet);
  }

  /** An enemy fired: everyone sees the bullet; the hit (decided by the AI) lands now. */
  private enemyFired(shot: EnemyShot) {
    // Aim the visible bullet so that, with drop, it arrives where the AI meant it to.
    const dx = shot.to.x - shot.from.x, dy = shot.to.y - shot.from.y, dz = shot.to.z - shot.from.z;
    const t = Math.max(0.01, Math.hypot(dx, dz) / BULLET_SPEED);
    const vel: [number, number, number] = [dx / t, dy / t + 0.5 * GRAVITY * t, dz / t];
    this.broadcast({ t: 'fire', from: shot.enemy, shot: this.nextShot++, pos: [shot.from.x, shot.from.y, shot.from.z], vel });
    const target = shot.hit && this.players.get(shot.hit.player);
    if (!shot.hit || !target || !target.alive || Date.now() < target.protectedUntil) return;
    const zone = shot.hit.zone;
    const res = target.health.applyHit(zone, ENEMY_DAMAGE);
    this.broadcast({ t: 'damage', target: target.id, attacker: shot.enemy, zone, damage: res.damage, health: res.health, point: [shot.to.x, shot.to.y, shot.to.z] });
    if (!res.killed) return;
    target.alive = false;
    target.deaths++;
    console.log(`[kill] the enemy killed ${target.name} (${zone})`);
    this.broadcast({ t: 'kill', victim: target.id, killer: shot.enemy, zone, scores: this.scores() });
    target.respawnTimer = setTimeout(() => this.respawn(target), RESPAWN_DELAY * 1000);
  }

  private respawn(p: Player) {
    p.respawnTimer = null;
    if (this.phase !== 'live' || !this.players.has(p.id)) return;
    p.health.reset();
    p.alive = true;
    p.protectedUntil = Date.now() + SPAWN_PROTECTION * 1000;
    p.send({ t: 'spawn', spawn: this.pickSpawn(p.id) });
    this.broadcast({ t: 'respawn', id: p.id });
  }

  private endMatch(winner: number) {
    console.log(`[results] ${this.players.get(winner)?.name} wins`);
    this.phase = 'results';
    for (const p of this.players.values()) {
      if (p.respawnTimer) clearTimeout(p.respawnTimer);
      p.respawnTimer = null;
    }
    this.broadcast({ t: 'results', scores: this.scores(), winner, seconds: RESULTS_TIME });
    this.broadcastLobby();
    this.resultsTimer = setTimeout(() => {
      this.toLobby();
      this.broadcastLobby();
    }, RESULTS_TIME * 1000);
  }

  scores(): Score[] {
    return [...this.players.values()]
      .map(({ id, name, kills, deaths, shots, hits }) => ({ id, name, kills, deaths, shots, hits }))
      .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }

  /** Everyone starts (and comes back) at the insertion point: map spawns 0-3, side by side. */
  pickSpawn(forId: number): number {
    return (forId - 1) % 4;
  }

  list(): PlayerInfo[] {
    return [...this.players.values()].map(({ id, name, ready }) => ({ id, name, ready }));
  }

  broadcast(msg: ServerMsg) {
    for (const p of this.players.values()) p.send(msg);
  }

  private broadcastLobby() {
    this.broadcast({ t: 'lobby', players: this.list(), phase: this.phase, countdown: this.countdown });
  }
}
