import type { Phase, PlayerInfo, Score } from '@spec-ops/shared';

// Join screen and lobby: plain HTML over the game canvas. White paper, dark ink, one red accent.

const CSS = `
#menu { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
  background: linear-gradient(#c9d5e2, #e8edf2 60%, #f3f5f7);
  font: 600 14px/1.4 system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1b1f23;
  letter-spacing: 0.06em; z-index: 10; }
#menu.see-through { background: rgba(232,237,242,0.6); }
#menu .box { background: rgba(245,247,249,0.96); border-top: 4px solid #e3221a; padding: 28px 32px;
  width: min(380px, calc(100vw - 32px)); box-sizing: border-box; box-shadow: 0 12px 40px rgba(27,31,35,0.15); }
#menu h1 { margin: 0 0 18px; font-size: 32px; font-weight: 800; letter-spacing: 0.08em; }
#menu label { display: block; margin: 14px 0 4px; font-size: 11px; color: rgba(27,31,35,0.55); }
#menu input { width: 100%; box-sizing: border-box; font: inherit; padding: 8px 10px; background: #fff; color: #1b1f23;
  border: 1px solid rgba(27,31,35,0.2); border-radius: 0; }
#menu input:focus { outline: none; border-color: #1b1f23; }
#menu button { font: inherit; margin: 18px 8px 0 0; padding: 10px 16px; cursor: pointer; border: 0;
  background: #1b1f23; color: #fff; letter-spacing: 0.08em; }
#menu button:hover { background: #e3221a; }
#menu button.alt { background: transparent; color: #1b1f23; box-shadow: inset 0 0 0 1px rgba(27,31,35,0.3); }
#menu button.alt:hover { box-shadow: inset 0 0 0 1px #1b1f23; }
#menu .error { color: #e3221a; min-height: 1.4em; margin-top: 12px; font-size: 12px; }
#menu ul { list-style: none; padding: 0; margin: 8px 0; }
#menu li { padding: 8px 10px; margin: 4px 0; background: rgba(27,31,35,0.05); }
#menu li.ready { background: #1b1f23; color: #fff; }
#menu .note { color: rgba(27,31,35,0.55); font-size: 12px; margin-top: 12px; }
`;

export type JoinChoice = { server: string; name: string; password: string };

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem('specops.' + k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem('specops.' + k, v);
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
    this.root.classList.remove('see-through');
    this.root.style.display = 'flex';
    this.root.innerHTML = `
      <form class="box">
        <h1>SPEC OPS</h1>
        <label>SERVER</label><input name="server" spellcheck="false">
        <label>YOUR NAME</label><input name="name" maxlength="16" spellcheck="false">
        <label>PASSWORD</label><input name="password" type="password">
        <div class="error"></div>
        <button type="submit">JOIN</button>
      </form>`;
    const form = this.root.querySelector('form')!;
    const field = (n: string) => form.querySelector<HTMLInputElement>(`input[name=${n}]`)!;
    field('server').value = store.get('server') || location.host;
    field('name').value = store.get('name') || 'SOLDIER' + Math.floor(Math.random() * 100);
    field('password').value = store.get('password');
    // Remember every field as it's typed (and the generated name), not only on JOIN.
    for (const n of ['server', 'name', 'password']) {
      store.set(n, field(n).value);
      field(n).addEventListener('input', () => store.set(n, n === 'password' ? field(n).value : field(n).value.trim()));
    }
    form.querySelector('.error')!.textContent = error;
    return new Promise((resolve) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const choice = { server: field('server').value.trim(), name: field('name').value.trim(), password: field('password').value };
        store.set('server', choice.server);
        store.set('name', choice.name);
        store.set('password', choice.password);
        form.querySelector('.error')!.textContent = 'CONNECTING...';
        resolve(choice);
      });
    });
  }

  /** Lobby: who's here and who's ready. */
  lobby(players: PlayerInfo[], phase: Phase, countdown: number, myId: number, onReady: (ready: boolean) => void, onStart: () => void) {
    this.root.classList.add('see-through');
    this.root.style.display = 'flex';
    const me = players.find((p) => p.id === myId);
    const status =
      phase === 'countdown'
        ? `STARTING IN ${countdown}...`
        : players.length < 2
          ? 'WAITING FOR MORE PLAYERS, OR PRESS START NOW'
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
    this.root.classList.add('see-through');
    this.root.style.display = 'flex';
    const name = scores.find((s) => s.id === winner)?.name ?? '???';
    const rows = scores
      .map((s) => `<li class="${s.id === winner ? 'ready' : ''}">${s.id === myId ? '&gt; ' : ''}${escape(s.name)} - ${s.kills} KILLS, ${s.deaths} DEATHS, ${accuracy(s)} HIT</li>`)
      .join('');
    this.root.innerHTML = `
      <div class="box">
        <h1>${winner === myId ? 'YOU WIN' : `${escape(name)} WINS`}</h1>
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

export function accuracy(s: Score) {
  return s.shots ? `${Math.round((100 * s.hits) / s.shots)}%` : '-';
}

function escape(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
