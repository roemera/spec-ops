import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_PORT } from '@spec-ops/shared';

export interface Config {
  port: number;
  password: string; // empty = no password
  mapSeed: number;
  killLimit: number;
}

/** server.config.json at the repo root, falling back to server.config.example.json; env vars win. */
export function loadConfig(root: string): Config {
  const defaults: Config = { port: DEFAULT_PORT, password: '', mapSeed: 1337, killLimit: 10 };
  let file: Partial<Config> = {};
  for (const name of ['server.config.json', 'server.config.example.json']) {
    const path = `${root}/${name}`;
    if (existsSync(path)) {
      file = JSON.parse(readFileSync(path, 'utf8'));
      if (name !== 'server.config.json') console.log(`[config] no server.config.json, using ${name}`);
      break;
    }
  }
  const env = process.env;
  return {
    ...defaults,
    ...file,
    ...(env.PORT ? { port: Number(env.PORT) } : {}),
    ...(env.PASSWORD !== undefined ? { password: env.PASSWORD } : {}),
    ...(env.MAP_SEED ? { mapSeed: Number(env.MAP_SEED) } : {}),
    ...(env.KILL_LIMIT ? { killLimit: Number(env.KILL_LIMIT) } : {}),
  };
}
