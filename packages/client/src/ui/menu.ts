import type { Phase, PlayerInfo, Score } from '@skeleton-crew/shared';

// Join screen and lobby: plain HTML over the game canvas, styled to hurt a little.

const CSS = `
#menu { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: repeating-linear-gradient(45deg, #ff4fd8 0 12px, #a3127f 12px 24px);
  font: bold 16px/1.3 "Courier New", monospace; color: #b6ff00; z-index: 10; }
#menu.see-through { background: rgba(20,0,26,0.55); }
#menu .box { background: #14001a; border: 6px solid #ffe600; padding: 20px 24px; width: min(420px, 90vw);
  box-shadow: 10px 10px 0 #00ffe1; }
#menu h1 { margin: 0 0 12px; color: #ff4fd8; font-size: 30px; letter-spacing: 2px; transform: skewX(-8deg); }
#menu label { display: block; margin: 10px 0 2px; color: #ffe600; }
#menu input { width: 100%; box-sizing: border-box; font: inherit; padding: 6px; background: #5b0fa8; color: #fff;
  border: 3px solid #b6ff00; }
#menu button { font: inherit; margin: 14px 8px 0 0; padding: 8px 14px; cursor: pointer; border: 3px solid #14001a;
  background: #b6ff00; color: #14001a; box-shadow: 4px 4px 0 #ff4fd8; }
#menu button.alt { background: #00ffe1; }
#menu button:active { transform: translate(3px, 3px); box-shadow: 1px 1px 0 #ff4fd8; }
#menu .error { color: #ff1f3d; min-height: 1.3em; margin-top: 10px; }
#menu ul { list-style: none; padding: 0; margin: 8px 0; }
#menu li { padding: 3px 6px; margin: 3px 0; background: #2a0033; }
#menu li.ready { color: #14001a; background: #b6ff00; }
#menu .note { color: #00ffe1; font-size: 13px; margin-top: 10px; }
/* Results: everything flashes and shakes, in steps so it stutters. */
#menu.victory { animation: sc-bg 0.5s steps(2) infinite; }
#menu.victory .box { animation: sc-jitter 0.25s steps(2) infinite; }
#menu.victory h1 { font-size: 40px; transform: rotate(-4deg) scaleX(1.35); transform-origin: left;
  animation: sc-flash 0.3s steps(2) infinite; }
#menu.victory pre { margin: 0 0 6px; font: bold 18px/1 "Courier New", monospace; color: #ffe600;
  animation: sc-spin 1.2s steps(6) infinite; display: inline-block; }
@keyframes sc-bg { 0% { background: rgba(255,79,216,0.6); } 100% { background: rgba(0,255,225,0.45); } }
@keyframes sc-jitter { 0% { transform: translate(-4px,2px) rotate(-1deg); } 100% { transform: translate(4px,-3px) rotate(1.5deg); } }
@keyframes sc-flash { 0% { color: #ff4fd8; } 100% { color: #b6ff00; } }
@keyframes sc-spin { 0% { transform: scaleX(1); } 50% { transform: scaleX(-1) skewY(8deg); } 100% { transform: scaleX(1); } }
`;

export type JoinChoice = { mode: 'offline' } | { mode: 'online'; server: string; name: string; password: string };

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem('sc.' + k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem('sc.' + k, v);
    } catch {
      /* private mode: fine */
    }
  },
};

export class Menu {
  private root: HTMLDivElement;

  constructor() {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    this.root = document.createElement('div');
    this.root.id = 'menu';
    document.body.append(this.root);
  }

  /** Ask how to play. Resolves when the player picks. */
  join(error = ''): Promise<JoinChoice> {
    this.root.classList.remove('see-through', 'victory');
    this.root.style.display = 'flex';
    this.root.innerHTML = `
      <form class="box">
        <h1>SKELETON CREW</h1>
        <label>SERVER</label><input name="server" spellcheck="false">
        <label>YOUR NAME</label><input name="name" maxlength="16" spellcheck="false">
        <label>PASSWORD</label><input name="password" type="password">
        <div class="error"></div>
        <button type="submit">CLIMB IN</button><button type="button" class="alt">PRACTICE OFFLINE</button>
      </form>`;
    const form = this.root.querySelector('form')!;
    const field = (n: string) => form.querySelector<HTMLInputElement>(`input[name=${n}]`)!;
    field('server').value = store.get('server') || location.host;
    field('name').value = store.get('name') || 'TANK' + Math.floor(Math.random() * 100);
    field('password').value = store.get('password');
    // Remember every field as it's typed (and the generated name), not only on CLIMB IN.
    for (const n of ['server', 'name', 'password']) {
      store.set(n, field(n).value);
      field(n).addEventListener('input', () => store.set(n, n === 'password' ? field(n).value : field(n).value.trim()));
    }
    form.querySelector('.error')!.textContent = error;
    return new Promise((resolve) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const choice = { mode: 'online' as const, server: field('server').value.trim(), name: field('name').value.trim(), password: field('password').value };
        store.set('server', choice.server);
        store.set('name', choice.name);
        store.set('password', choice.password);
        form.querySelector('.error')!.textContent = 'CONNECTING...';
        resolve(choice);
      });
      form.querySelector('button.alt')!.addEventListener('click', () => resolve({ mode: 'offline' }));
    });
  }

  /** Lobby: who's here and who's ready. */
  lobby(players: PlayerInfo[], phase: Phase, countdown: number, myId: number, onReady: (ready: boolean) => void, onStart: () => void) {
    this.root.classList.add('see-through');
    this.root.classList.remove('victory');
    this.root.style.display = 'flex';
    const me = players.find((p) => p.id === myId);
    const status =
      phase === 'countdown'
        ? `STARTING IN ${countdown}...`
        : players.length < 2
          ? 'WAITING FOR MORE TANKS, OR PRESS START NOW'
          : 'STARTS WHEN EVERYONE IS READY, OR WHEN ANYONE PRESSES START NOW';
    this.root.innerHTML = `
      <div class="box">
        <h1>LOBBY</h1>
        <ul>${players.map((p) => `<li class="${p.ready ? 'ready' : ''}">${p.id === myId ? '&gt; ' : ''}${escape(p.name)}${p.ready ? ' - READY' : ''}</li>`).join('')}</ul>
        <div class="note">${status}</div>
        ${phase === 'lobby' ? `<button class="ready">${me?.ready ? 'NOT READY' : 'READY'}</button><button class="alt start">START NOW</button>` : ''}
      </div>`;
    this.root.querySelector('button.ready')?.addEventListener('click', () => onReady(!me?.ready));
    this.root.querySelector('button.start')?.addEventListener('click', onStart);
  }

  /** End of match: who won, the table, and how long until the lobby. */
  results(scores: Score[], winner: number, seconds: number, myId: number) {
    this.root.classList.add('see-through', 'victory');
    this.root.style.display = 'flex';
    const name = scores.find((s) => s.id === winner)?.name ?? '???';
    const rows = scores
      .map((s) => `<li class="${s.id === winner ? 'ready' : ''}">${s.id === myId ? '&gt; ' : ''}${escape(s.name)} - ${s.kills} KILLS, ${s.deaths} DEATHS, ${accuracy(s)} HIT</li>`)
      .join('');
    this.root.innerHTML = `
      <div class="box">
        <pre>${winner === myId ? TROPHY : SKULL}</pre>
        <h1>${winner === myId ? 'YOU WIN. SOMEHOW.' : `${escape(name)} WINS`}</h1>
        <ul>${rows}</ul>
        <div class="note">BACK TO THE LOBBY IN <span class="secs">${seconds}</span>...</div>
      </div>`;
    const el = this.root.querySelector('.secs')!;
    let left = seconds;
    const timer = setInterval(() => {
      left--;
      if (!el.isConnected || left < 0) return clearInterval(timer);
      el.textContent = String(left);
    }, 1000);
  }

  hide() {
    this.root.style.display = 'none';
  }
}

const TROPHY = ` \\___/ 
 (  $  )
  \\_/
  _|_`;
const SKULL = `  ___
 (x x)
  |=|`;

export function accuracy(s: Score) {
  return s.shots ? `${Math.round((100 * s.hits) / s.shots)}%` : '-';
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
