import { STANCE_LIST, type Stance } from './constants.ts';
import type { HitZone } from './hitzones.ts';

// Network messages. Rare messages are JSON; the 20 Hz soldier state is a 36-byte binary packet.

export const PROTOCOL_VERSION = 7;
export const DEFAULT_PORT = 8080;
export const STATE_HZ = 20;
export const MAX_PLAYERS = 8;
export const INTERP_DELAY = 0.1; // s: other soldiers are drawn this far in the past
export const COUNTDOWN_SECONDS = 3;

export type Phase = 'lobby' | 'countdown' | 'live' | 'results';

export interface Score {
  id: number;
  name: string;
  kills: number;
  deaths: number;
  shots: number;
  hits: number;
}

type Vec3 = [number, number, number];

export interface PlayerInfo {
  id: number;
  name: string;
  ready: boolean;
}

export type ClientMsg =
  | { t: 'hello'; name: string; password: string; version: number }
  | { t: 'ready'; ready: boolean }
  | { t: 'start' } // anyone in the lobby can start the match now
  | { t: 'fire'; shot: number; pos: Vec3; vel: Vec3 }
  | { t: 'hit'; shot: number; target: number; zone: HitZone; point: Vec3 }; // shooter-detected

export type ServerMsg =
  | { t: 'welcome'; id: number; seed: number; players: PlayerInfo[]; phase: Phase; spawn: number }
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: PlayerInfo[]; phase: Phase; countdown: number }
  | { t: 'spawn'; spawn: number } // go to this spawn point now (match start)
  | { t: 'left'; id: number }
  | { t: 'fire'; from: number; shot: number; pos: Vec3; vel: Vec3 }
  | { t: 'damage'; target: number; attacker: number; zone: HitZone; damage: number; health: number; point: Vec3 }
  | { t: 'kill'; victim: number; killer: number; zone: HitZone; scores: Score[] }
  | { t: 'respawn'; id: number } // that player is back (stand their body up again)
  | { t: 'results'; scores: Score[]; winner: number; seconds: number };

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
