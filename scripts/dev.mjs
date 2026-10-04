// `npm run dev`: the game server and the Vite dev server together, in one terminal.
// The game server gets the keyboard, so `start` and `players` still work. Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;

const children = [
  spawn(node, [join(root, 'packages/server/src/main.ts')], { cwd: root, stdio: 'inherit' }),
  spawn(node, [join(root, 'node_modules/vite/bin/vite.js')], { cwd: join(root, 'packages/client'), stdio: ['ignore', 'inherit', 'inherit'] }),
];

let stopping = false;
const stopAll = (code) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  process.exit(code ?? 0);
};
for (const c of children) c.on('exit', (code) => stopAll(code));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
