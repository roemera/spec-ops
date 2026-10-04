import {
  COUNTDOWN_SECONDS, MAX_PLAYERS, RESPAWN_DELAY, RESULTS_TIME, SPAWN_PROTECTION, TankDamage, generateMap,
  type ClientMsg, type Phase, type PlayerInfo, type Score, type ServerMsg, type Spawn,
} from '@skeleton-crew/shared';

export interface Player {
  id: number;
  name: string;
  ready: boolean;
  pos: [number, number, number] | null; // last reported position, for picking spawns
  send(msg: ServerMsg): void;
  // Combat (the server owns health; clients report their own shells' hits)
  damage: TankDamage;
  alive: boolean;
  protectedUntil: number; // ms timestamp: hits before this are ignored (spawn protection)
  kills: number;
  deaths: number;
  shots: number;
  hits: number;
  hitShells: Set<number>; // shells already counted as hits (accuracy counts each shell once)
  respawnTimer: ReturnType<typeof setTimeout> | null;
}

type Fire = Extract<ClientMsg, { t: 'fire' }>;
type Hit = Extract<ClientMsg, { t: 'hit' }>;

/** Players, the lobby and the match phase. Pure logic: no sockets, so it is easy to test. */
export class Match {
  readonly players = new Map<number, Player>();
  phase: Phase = 'lobby';
  countdown = 0;
  private spawns: Spawn[];
  private destructible: Set<number>; // ids of map objects that can break
  readonly broken = new Set<number>(); // broken this match; everything stands again at the next
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  readonly seed: number;
  readonly killLimit: number;
  private resultsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(seed: number, killLimit: number) {
    this.seed = seed;
    this.killLimit = killLimit;
    const map = generateMap(seed);
    this.spawns = map.spawns;
    this.destructible = new Set(map.objects.filter((o) => o.destructible).map((o) => o.id));
  }

  get full() {
    return this.players.size >= MAX_PLAYERS;
  }

  /** Lowest free id from 1. */
  private freeId() {
    for (let id = 1; ; id++) if (!this.players.has(id)) return id;
  }

  join(name: string, send: Player['send']): Player {
    const p: Player = {
      id: this.freeId(), name: name.slice(0, 16) || 'TANK', ready: false, pos: null, send,
      damage: new TankDamage(), alive: true, protectedUntil: Date.now() + SPAWN_PROTECTION * 1000,
      kills: 0, deaths: 0, shots: 0, hits: 0, hitShells: new Set(), respawnTimer: null,
    };
    this.players.set(p.id, p);
    p.send({ t: 'welcome', id: p.id, seed: this.seed, players: this.list(), phase: this.phase, spawn: this.pickSpawn(p.id), broken: [...this.broken] });
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
    this.broken.clear();
    for (const p of this.players.values()) this.resetCombat(p);
    // Everyone to a different spawn, in random order.
    const order = this.spawns.map((_, i) => i).sort(() => Math.random() - 0.5);
    [...this.players.values()].forEach((p, i) => p.send({ t: 'spawn', spawn: order[i % order.length] }));
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
    p.damage.reset();
    p.hitShells.clear();
  }

  // --- Combat ---

  /** A player fired: count it and show the shot to everyone else. */
  fire(from: Player, msg: Fire) {
    if (this.phase !== 'live' || !from.alive) return;
    if (!msg.mg) from.shots++; // accuracy counts cannon shots only
    for (const p of this.players.values()) {
      if (p !== from) p.send({ t: 'fire', from: from.id, shell: msg.shell, pos: msg.pos, vel: msg.vel, mg: msg.mg });
    }
  }

  /** The shooter's client says its shell hit someone. Trusted, but the target must be alive and unprotected. */
  hit(from: Player, msg: Hit) {
    const target = this.players.get(msg.target);
    if (this.phase !== 'live' || !target || target === from || !target.alive || Date.now() < target.protectedUntil) return;
    const zone = msg.zone;
    const res = target.damage.applyHit(zone, Math.random());
    if (zone !== 'man' && !from.hitShells.has(msg.shell)) {
      from.hitShells.add(msg.shell);
      from.hits++;
    }
    this.broadcast({ t: 'damage', target: target.id, attacker: from.id, zone, damage: res.damage, health: res.health, broke: res.broke, point: msg.point });
    if (!res.destroyed) return;
    target.alive = false;
    target.deaths++;
    from.kills++;
    console.log(`[kill] ${from.name} killed ${target.name} (${zone}) - ${from.kills}/${this.killLimit}`);
    this.broadcast({ t: 'kill', victim: target.id, killer: from.id, zone, scores: this.scores() });
    if (from.kills >= this.killLimit) return this.endMatch(from.id);
    target.respawnTimer = setTimeout(() => this.respawn(target), RESPAWN_DELAY * 1000);
  }

  /** A player broke a map object. Record it once and tell everyone else. */
  breakObject(from: Player, id: number) {
    if (this.phase !== 'live' || !this.destructible.has(id) || this.broken.has(id)) return;
    this.broken.add(id);
    for (const p of this.players.values()) if (p !== from) p.send({ t: 'break', id });
  }

  private respawn(p: Player) {
    p.respawnTimer = null;
    if (this.phase !== 'live' || !this.players.has(p.id)) return;
    p.damage.reset();
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

  /** The spawn farthest from every other player we know the position of. */
  pickSpawn(forId: number): number {
    const others = [...this.players.values()].filter((p) => p.id !== forId && p.pos);
    if (others.length === 0) return Math.floor(Math.random() * this.spawns.length);
    let best = 0, bestDist = -1;
    this.spawns.forEach((s, i) => {
      const d = Math.min(...others.map((p) => Math.hypot(p.pos![0] - s.x, p.pos![2] - s.z)));
      if (d > bestDist) [best, bestDist] = [i, d];
    });
    return best;
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
