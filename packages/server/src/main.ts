import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { AI_HZ, PROTOCOL_VERSION, STATE_BYTES, decodeState, type ClientMsg, type ServerMsg } from '@spec-ops/shared';
import { loadConfig } from './config.ts';
import { serveStatic } from './static.ts';
import { Match, type Player } from './match.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const config = loadConfig(root);
const match = new Match(config.mapSeed);
match.peaceful = config.peaceful;

const http = createServer(serveStatic(join(root, 'packages/client/dist')));
const wss = new WebSocketServer({ server: http, path: '/ws' });

const HELLO_TIMEOUT = 5000; // ms to send a correct hello
const HEARTBEAT = 2000; // ms between pings; a client missing two is dropped

wss.on('connection', (ws: WebSocket, req) => {
  const addr = req.socket.remoteAddress;
  let player: Player | null = null;
  let alive = true;
  const send = (msg: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const sendBinary = (data: ArrayBuffer) => ws.readyState === ws.OPEN && ws.send(data);
  const helloTimer = setTimeout(() => !player && ws.close(), HELLO_TIMEOUT);

  ws.on('pong', () => (alive = true));
  const beat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, HEARTBEAT);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Soldier state: stamp the sender's id and relay to everyone else.
      if (!player || match.phase !== 'live') return;
      const bytes = new Uint8Array(data as Buffer);
      if (bytes.byteLength !== STATE_BYTES) return;
      bytes[1] = player.id;
      const s = decodeState(bytes);
      if (s) player.state = s;
      for (const other of wss.clients) if (other !== ws && other.readyState === other.OPEN && (other as Tagged).playerId) other.send(bytes);
      return;
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.t === 'hello' && !player) {
      if (msg.version !== PROTOCOL_VERSION) return reject(`version mismatch: server ${PROTOCOL_VERSION}, you ${msg.version}. Pull and rebuild.`);
      if (config.password && msg.password !== config.password) return reject('wrong password');
      if (match.full) return reject('server full');
      clearTimeout(helloTimer);
      player = match.join(msg.name, send, sendBinary);
      (ws as Tagged).playerId = player.id;
      console.log(`[join] #${player.id} ${player.name} from ${addr} (${match.players.size} playing)`);
    } else if (msg.t === 'ready' && player) {
      match.setReady(player.id, msg.ready);
    } else if (msg.t === 'fire' && player) {
      match.fire(player, msg);
    } else if (msg.t === 'hit' && player) {
      match.hit(player, msg);
    } else if (msg.t === 'revive' && player) {
      match.revive(player, msg.target);
    } else if (msg.t === 'start' && player) {
      console.log(`[start] #${player.id} ${player.name} started the match`);
      match.forceStart();
    }
  });

  function reject(reason: string) {
    console.log(`[reject] ${addr}: ${reason}`);
    send({ t: 'reject', reason });
    ws.close();
  }

  ws.on('close', () => {
    clearInterval(beat);
    clearTimeout(helloTimer);
    if (player) {
      console.log(`[leave] #${player.id} ${player.name}`);
      match.leave(player.id);
    }
  });
});

type Tagged = WebSocket & { playerId?: number };

// The enemy thinks and moves at AI_HZ.
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  match.tick(Math.min(0.5, (now - lastTick) / 1000));
  lastTick = now;
}, 1000 / AI_HZ);

http.listen(config.port, () => {
  console.log(`Spec Ops server on port ${config.port}, ${config.mapSeed ? `map seed ${config.mapSeed}` : `a new map every mission (first: ${match.seed})`}, ${config.password ? 'password set' : 'NO password'}`);
  console.log('Players open http://<this machine>:' + config.port + '   Commands: start, players, help');
});

// Host console.
createInterface({ input: process.stdin }).on('line', (line) => {
  const cmd = line.trim().toLowerCase();
  if (cmd === 'start') {
    match.forceStart();
    console.log(match.phase === 'countdown' ? 'starting...' : `can't start (phase ${match.phase}, ${match.players.size} players)`);
  } else if (cmd === 'players') {
    console.log(`${match.phase}: ` + (match.list().map((p) => `#${p.id} ${p.name}${p.ready ? ' (ready)' : ''}`).join(', ') || 'nobody'));
  } else if (cmd) console.log('commands: start (begin the mission now), players');
});
