import { STANCE_LIST, type Stance } from './constants.ts';
import type { HitZone } from './hitzones.ts';
import { AI_STATES, type EnemyView } from './ai.ts';

// Network messages. Rare messages are JSON; the 20 Hz soldier state is a 36-byte binary packet.

export const PROTOCOL_VERSION = 9;
export const DEFAULT_PORT = 8080;
export const STATE_HZ = 20;
export const MAX_PLAYERS = 8;
export const INTERP_DELAY = 0.1; // s: other soldiers are drawn this far in the past
export const COUNTDOWN_SECONDS = 3;

export type Phase = 'lobby' | 'countdown' | 'live' | 'results';

/** Up and fighting, down (bleeding out, can be revived), or out of this mission. */
export type Life = 'up' | 'down' | 'dead';

export interface Score {
  id: number;
  name: string;
  kills: number; // enemies
  downs: number; // times this player went down
  revives: number; // teammates this player got back up
  shots: number;
  hits: number;
}

type Vec3 = [number, number, number];

export interface PlayerInfo {
  id: number;
  name: string;
  ready: boolean;
  life: Life;
}

export type ClientMsg =
  | { t: 'hello'; name: string; password: string; version: number }
  | { t: 'ready'; ready: boolean }
  | { t: 'start' } // anyone in the lobby can start the mission now
  | { t: 'revive'; target: number } // I held E next to this downed teammate for REVIVE_TIME
  | { t: 'fire'; shot: number; pos: Vec3; vel: Vec3 }
  | { t: 'hit'; shot: number; target: number; zone: HitZone; point: Vec3; dir: Vec3 }; // shooter-detected; target is a player or an enemy id

export type ServerMsg =
  | { t: 'welcome'; id: number; seed: number; players: PlayerInfo[]; phase: Phase; spawn: number }
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: PlayerInfo[]; phase: Phase; countdown: number; seed: number } // seed: this (or the next) mission's map
  | { t: 'spawn'; spawn: number } // go to this spawn point now (mission start)
  | { t: 'left'; id: number }
  | { t: 'fire'; from: number; shot: number; pos: Vec3; vel: Vec3 } // from: a player or an enemy id
  | { t: 'damage'; target: number; attacker: number; zone: HitZone; damage: number; health: number; point: Vec3 }
  | { t: 'down'; id: number; by: number; zone: HitZone; bleedOut: number; scores: Score[] } // bleedOut: s left
  | { t: 'revived'; id: number; by: number; health: number; scores: Score[] }
  | { t: 'bledOut'; id: number; scores: Score[] } // out until the next mission
  | { t: 'enemyDown'; id: number; killer: number; zone: HitZone; dir: Vec3; scores: Score[] } // an enemy was killed
  | { t: 'results'; success: boolean; time: number; scores: Score[]; seconds: number }; // time: mission length, s

// --- Binary soldier state ---

export interface SoldierState {
  id: number; // set by the server when relaying; clients send 0
  stance: Stance;
  scoped: boolean;
  pos: [number, number, number]; // feet
  vel: [number, number, number];
  yaw: number; // rad, 0 = facing -z
  pitch: number; // rad, + is up
}

export const STATE_BYTES = 4 + 8 * 4;
const KIND_STATE = 1;
const FLAG_SCOPED = 4; // bits 0-1: stance index

export function encodeState(s: SoldierState): ArrayBuffer {
  const buf = new ArrayBuffer(STATE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, KIND_STATE);
  v.setUint8(1, s.id);
  v.setUint8(2, STANCE_LIST.indexOf(s.stance) | (s.scoped ? FLAG_SCOPED : 0));
  const f = [...s.pos, ...s.vel, s.yaw, s.pitch];
  f.forEach((x, i) => v.setFloat32(4 + i * 4, x, true));
  return buf;
}

export function decodeState(data: ArrayBuffer | Uint8Array): SoldierState | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength !== STATE_BYTES || bytes[0] !== KIND_STATE) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f = (i: number) => v.getFloat32(4 + i * 4, true);
  const flags = v.getUint8(2);
  return {
    id: v.getUint8(1),
    stance: STANCE_LIST[flags & 3] ?? 'stand',
    scoped: (flags & FLAG_SCOPED) !== 0,
    pos: [f(0), f(1), f(2)],
    vel: [f(3), f(4), f(5)],
    yaw: f(6),
    pitch: f(7),
  };
}

// --- Binary enemy state (server -> clients, AI_HZ) ---

export const ENEMY_BYTES = 20;
const KIND_ENEMIES = 2;

export function encodeEnemies(list: EnemyView[]): ArrayBuffer {
  const buf = new ArrayBuffer(4 + list.length * ENEMY_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, KIND_ENEMIES);
  v.setUint8(1, list.length);
  list.forEach((e, i) => {
    const o = 4 + i * ENEMY_BYTES;
    v.setUint8(o, e.id);
    v.setUint8(o + 1, STANCE_LIST.indexOf(e.stance) | (AI_STATES.indexOf(e.state) << 2) | (e.dead ? 16 : 0));
    v.setInt16(o + 2, Math.round(e.pitch * 1000), true);
    v.setFloat32(o + 4, e.pos.x, true);
    v.setFloat32(o + 8, e.pos.y, true);
    v.setFloat32(o + 12, e.pos.z, true);
    v.setFloat32(o + 16, e.yaw, true);
  });
  return buf;
}

export function decodeEnemies(data: ArrayBuffer | Uint8Array): EnemyView[] | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 4 || bytes[0] !== KIND_ENEMIES) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint8(1);
  if (bytes.byteLength !== 4 + n * ENEMY_BYTES) return null;
  const out: EnemyView[] = [];
  for (let i = 0; i < n; i++) {
    const o = 4 + i * ENEMY_BYTES, flags = v.getUint8(o + 1);
    out.push({
      id: v.getUint8(o),
      stance: STANCE_LIST[flags & 3] ?? 'stand',
      state: AI_STATES[(flags >> 2) & 3],
      dead: (flags & 16) !== 0,
      pitch: v.getInt16(o + 2, true) / 1000,
      pos: { x: v.getFloat32(o + 4, true), y: v.getFloat32(o + 8, true), z: v.getFloat32(o + 12, true) },
      yaw: v.getFloat32(o + 16, true),
    });
  }
  return out;
}
