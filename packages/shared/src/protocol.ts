import type { HitZone, Part } from './hitzones.ts';

// Network messages. Rare messages are JSON; the 20 Hz tank state is a 52-byte binary packet.

export const PROTOCOL_VERSION = 6;
export const DEFAULT_PORT = 8080;
export const STATE_HZ = 20;
export const MAX_PLAYERS = 8;
export const INTERP_DELAY = 0.1; // s: other tanks are drawn this far in the past
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
  | { t: 'fire'; shell: number; pos: Vec3; vel: Vec3; mg?: boolean } // mg: a machine-gun bullet
  | { t: 'hit'; shell: number; target: number; zone: HitZone; point: Vec3 } // shooter-detected
  | { t: 'break'; id: number }; // I broke this map object (fence, tree, wall)

export type ServerMsg =
  | { t: 'welcome'; id: number; seed: number; players: PlayerInfo[]; phase: Phase; spawn: number; broken: number[] }
  | { t: 'reject'; reason: string }
  | { t: 'lobby'; players: PlayerInfo[]; phase: Phase; countdown: number }
  | { t: 'spawn'; spawn: number } // go to this spawn point now (match start)
  | { t: 'left'; id: number }
  | { t: 'fire'; from: number; shell: number; pos: Vec3; vel: Vec3; mg?: boolean }
  | { t: 'damage'; target: number; attacker: number; zone: HitZone; damage: number; health: number; broke: Part | null; point: Vec3 }
  | { t: 'kill'; victim: number; killer: number; zone: HitZone; scores: Score[] }
  | { t: 'respawn'; id: number } // that player's tank is back (clear its wreck)
  | { t: 'break'; id: number } // someone broke this map object
  | { t: 'results'; scores: Score[]; winner: number; seconds: number };

// --- Binary tank state ---

export interface TankState {
  id: number; // set by the server when relaying; clients send 0
  flags: number; // reserved, send 0
  pos: [number, number, number];
  quat: [number, number, number, number];
  vel: [number, number, number];
  turretYaw: number;
  gunPitch: number;
}

export const STATE_BYTES = 4 + 12 * 4;
const KIND_STATE = 1;

export function encodeState(s: TankState): ArrayBuffer {
  const buf = new ArrayBuffer(STATE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, KIND_STATE);
  v.setUint8(1, s.id);
  v.setUint8(2, s.flags);
  const f = [...s.pos, ...s.quat, ...s.vel, s.turretYaw, s.gunPitch];
  f.forEach((x, i) => v.setFloat32(4 + i * 4, x, true));
  return buf;
}

export function decodeState(data: ArrayBuffer | Uint8Array): TankState | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength !== STATE_BYTES || bytes[0] !== KIND_STATE) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const f = (i: number) => v.getFloat32(4 + i * 4, true);
  return {
    id: v.getUint8(1),
    flags: v.getUint8(2),
    pos: [f(0), f(1), f(2)],
    quat: [f(3), f(4), f(5), f(6)],
    vel: [f(7), f(8), f(9)],
    turretYaw: f(10),
    gunPitch: f(11),
  };
}
