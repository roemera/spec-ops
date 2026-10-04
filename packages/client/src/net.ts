import {
  PROTOCOL_VERSION, decodeEnemies, decodeState, encodeState,
  type ClientMsg, type EnemyView, type HitZone, type ServerMsg, type SoldierState,
} from '@spec-ops/shared';

type Vec3 = [number, number, number];

type Welcome = Extract<ServerMsg, { t: 'welcome' }>;

/** WebSocket connection to the game server. */
export class Net {
  onMessage: (msg: ServerMsg) => void = () => {};
  onState: (s: SoldierState) => void = () => {};
  onEnemies: (list: EnemyView[]) => void = () => {};
  onClose: (reason: string) => void = () => {};
  private closedReason = 'connection lost';

  private constructor(private ws: WebSocket, readonly id: number) {
    ws.addEventListener('message', (e) => {
      if (e.data instanceof ArrayBuffer) {
        const s = decodeState(e.data);
        if (s) return this.onState(s);
        const list = decodeEnemies(e.data);
        if (list) this.onEnemies(list);
      } else this.onMessage(JSON.parse(e.data));
    });
    ws.addEventListener('close', () => this.onClose(this.closedReason));
  }

  /** Connect and say hello. Resolves with the welcome, rejects with the server's reason. */
  static connect(host: string, name: string, password: string): Promise<{ net: Net; welcome: Welcome }> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${proto}://${host}/ws`);
      } catch (e) {
        return reject(String(e));
      }
      ws.binaryType = 'arraybuffer';
      const fail = (reason: string) => {
        reject(reason);
        ws.close();
      };
      ws.addEventListener('open', () => {
        const hello: ClientMsg = { t: 'hello', name, password, version: PROTOCOL_VERSION };
        ws.send(JSON.stringify(hello));
      });
      ws.addEventListener('error', () => fail(`can't reach the game server at ${host}. Is it running?`));
      const first = (e: MessageEvent) => {
        if (typeof e.data !== 'string') return;
        ws.removeEventListener('message', first);
        const msg = JSON.parse(e.data) as ServerMsg;
        if (msg.t === 'welcome') resolve({ net: new Net(ws, msg.id), welcome: msg });
        else fail(msg.t === 'reject' ? msg.reason : 'unexpected reply');
      };
      ws.addEventListener('message', first);
    });
  }

  private send(msg: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  setReady(ready: boolean) {
    this.send({ t: 'ready', ready });
  }

  /** START NOW: begin the mission without waiting for everyone to be ready. */
  startMatch() {
    this.send({ t: 'start' });
  }

  sendFire(shot: number, pos: Vec3, vel: Vec3) {
    this.send({ t: 'fire', shot, pos, vel });
  }

  sendHit(shot: number, target: number, zone: HitZone, point: Vec3, dir: Vec3) {
    this.send({ t: 'hit', shot, target, zone, point, dir });
  }

  sendRevive(target: number) {
    this.send({ t: 'revive', target });
  }

  sendState(s: SoldierState) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeState(s));
  }
}
