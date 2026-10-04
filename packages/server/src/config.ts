import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_PORT } from '@spec-ops/shared';

export interface Config {
  port: number;
  password: string; // empty = no password
  mapSeed: number; // 0 = a new random map every mission
  peaceful: boolean; // the enemy never notices anyone (tests, screenshots)
}

/** server.config.json at the repo root, falling back to server.config.example.json; env vars win. */
export function loadConfig(root: string): Config {
  const defaults: Config = { port: DEFAULT_PORT, password: '', mapSeed: 0, peaceful: false };
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
  const config: Config = {
    ...defaults,
    ...file,
    ...(env.PORT ? { port: Number(env.PORT) } : {}),
    ...(env.PASSWORD !== undefined ? { password: env.PASSWORD } : {}),
    ...(env.MAP_SEED ? { mapSeed: Number(env.MAP_SEED) } : {}),
    ...(env.PEACEFUL ? { peaceful: env.PEACEFUL === '1' } : {}),
  };
  return config;
}
