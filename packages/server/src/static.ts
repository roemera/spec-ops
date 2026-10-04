import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Serve the built client (packages/client/dist). */
export function serveStatic(dir: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (!existsSync(join(dir, 'index.html'))) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('Client not built. Run `npm run build` (or `npm start`, which builds and runs the server).');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    let path = normalize(join(dir, decodeURIComponent(url.pathname)));
    if (!path.startsWith(dir)) path = join(dir, 'index.html'); // no escaping the folder
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    createReadStream(path).pipe(res);
  };
}
