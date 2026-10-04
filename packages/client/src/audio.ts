import * as THREE from 'three';
import { makeRng } from '@spec-ops/shared';

// All sounds are generated at startup. Outside sounds are positional (HRTF) and delayed by the
// speed of sound, so you can hear where a shot came from and roughly how far.

const RATE = 22050;
const SPEED_OF_SOUND = 343; // m/s

export type SoundName = 'shot' | 'bolt' | 'reload' | 'dry' | 'step' | 'impact' | 'hit' | 'shatter' | 'wind' | 'shout' | 'huh' | 'hurt' | 'headshot' | 'magIn' | 'perfect' | 'jam';

type Gen = (t: number, rnd: () => number) => number;

/** A short click: a burst of noise with a ring at `freq`. */
const click = (t: number, at: number, freq: number, r: () => number) => {
  const u = t - at;
  if (u < 0) return 0;
  return ((r() * 2 - 1) * 0.8 + Math.sin(2 * Math.PI * freq * u)) * Math.exp(-u * 90);
};

/**
 * A voice-ish buzz: harmonics of a gliding pitch, loudest near two vowel formants (f1, f2).
 * Not words, just the shape of a shout.
 */
const voice = (seconds: number, f0: (t: number) => number, f1: number, f2: number, env: (t: number) => number): Gen => {
  let phase = 0;
  return (t, r) => {
    phase += f0(t) / RATE;
    let x = 0;
    for (let k = 1; k <= 24; k++) {
      const f = k * f0(t);
      const w = Math.exp(-(((f - f1) / 180) ** 2)) + 0.7 * Math.exp(-(((f - f2) / 260) ** 2));
      x += w * Math.sin(2 * Math.PI * k * phase);
    }
    return (x * 0.5 + (r() * 2 - 1) * 0.06) * env(Math.min(t, seconds));
  };
};

const GENERATORS: Record<SoundName, { seconds: number; gen: () => Gen }> = {
  // An enemy spots you: a sharp, rising-then-falling "HEY!".
  shout: {
    seconds: 0.45,
    gen: () => voice(0.45, (t) => 210 + 90 * Math.sin(Math.min(1, t / 0.4) * Math.PI), 750, 1250, (t) => Math.min(1, t / 0.03) * Math.exp(-((t - 0.15) ** 2) / 0.03)),
  },
  // An enemy heard or glimpsed something: a short, low, questioning "huh?".
  huh: {
    seconds: 0.35,
    gen: () => voice(0.35, (t) => 120 + 60 * (t / 0.35), 550, 1000, (t) => Math.min(1, t / 0.04) * Math.exp(-((t - 0.12) ** 2) / 0.02) * 0.8),
  },
  // Supersonic crack, then a low boom that rolls off.
  shot: {
    seconds: 1.4,
    gen: () => {
      let lp = 0;
      return (t, r) => {
        lp += 0.18 * (r() * 2 - 1 - lp);
        const crack = (r() * 2 - 1) * Math.exp(-t * 160);
        const boom = Math.sin(2 * Math.PI * (70 - 30 * t) * t) * Math.exp(-t * 7);
        return 1.6 * crack + 2.4 * lp * Math.exp(-t * 4) + 0.9 * boom;
      };
    },
  },
  // Bolt up, back, forward, down.
  bolt: {
    seconds: 0.75,
    gen: () => (t, r) => click(t, 0.02, 1800, r) + 0.8 * click(t, 0.2, 1200, r) + click(t, 0.48, 1500, r) + 0.7 * click(t, 0.62, 2200, r),
  },
  // Magazine out and a fumble in the pouch (the seat is magIn, when it actually goes in).
  reload: {
    seconds: 0.7,
    gen: () => (t, r) => 0.8 * click(t, 0.05, 900, r) + 0.3 * click(t, 0.4, 600, r) + 0.25 * click(t, 0.55, 750, r),
  },
  // The magazine seated (end of any reload).
  magIn: {
    seconds: 0.15,
    gen: () => (t, r) => click(t, 0, 1400, r) + 0.6 * click(t, 0.05, 2400, r),
  },
  // Perfect active reload: a hard slap and a bright rising ping.
  perfect: {
    seconds: 0.45,
    gen: () => (t, r) => 1.2 * click(t, 0, 2000, r) + 0.5 * Math.sin(2 * Math.PI * (1500 + 1400 * t) * t) * Math.exp(-t * 9),
  },
  // Fumbled active reload: a dull metal clunk and a rattle.
  jam: {
    seconds: 0.5,
    gen: () => {
      let lp = 0;
      return (t, r) => {
        lp += 0.2 * (r() * 2 - 1 - lp);
        return Math.sin(2 * Math.PI * 190 * t) * 1.2 * Math.exp(-t * 18) + 1.5 * lp * Math.exp(-t * 14) + 0.5 * click(t, 0.16, 700, r) + 0.4 * click(t, 0.27, 900, r);
      };
    },
  },
  dry: {
    seconds: 0.1,
    gen: () => (t, r) => click(t, 0, 2600, r),
  },
  // Boot in snow: a soft, filtered crunch.
  step: {
    seconds: 0.22,
    gen: () => {
      let lp = 0;
      return (t, r) => {
        lp += 0.25 * (r() * 2 - 1 - lp);
        const grain = r() < 0.08 ? (r() * 2 - 1) * 0.5 : 0;
        return (lp * 2 + grain) * Math.sin(Math.PI * Math.min(1, t / 0.22)) * Math.exp(-t * 8);
      };
    },
  },
  impact: {
    seconds: 0.3,
    gen: () => {
      let lp = 0;
      return (t, r) => {
        lp += 0.3 * (r() * 2 - 1 - lp);
        return 2 * lp * Math.exp(-t * 25) + 0.4 * Math.sin(2 * Math.PI * 160 * t) * Math.exp(-t * 30);
      };
    },
  },
  // You're hit: a sharp snap, a heavy thump in the chest, and a grunt.
  hurt: {
    seconds: 0.6,
    gen: () => {
      const grunt = voice(0.35, (t) => 150 - 70 * t, 600, 1100, (t) => Math.min(1, t / 0.02) * Math.exp(-((t - 0.08) ** 2) / 0.012));
      return (t, r) => {
        const snap = (r() * 2 - 1) * 1.4 * Math.exp(-t * 260);
        const thump = Math.sin(2 * Math.PI * (85 - 70 * t) * t) * 1.8 * Math.exp(-t * 11);
        return snap + thump + (t > 0.05 ? 0.8 * grunt(t - 0.05, r) : 0);
      };
    },
  },
  // Your bullet found a head: a bright metallic ding (inharmonic partials, like struck steel).
  headshot: {
    seconds: 0.8,
    gen: () => (t, r) =>
      0.5 * click(t, 0, 3200, r) +
      (Math.sin(2 * Math.PI * 1850 * t) + 0.55 * Math.sin(2 * Math.PI * 1850 * 2.76 * t) + 0.25 * Math.sin(2 * Math.PI * 1850 * 5.4 * t)) *
        0.6 * Math.exp(-t * 6),
  },
  // A bullet into a body: a dull thump.
  hit: {
    seconds: 0.25,
    gen: () => (t, r) => (Math.sin(2 * Math.PI * (110 - 120 * t) * t) * 1.2 + (r() * 2 - 1) * 0.3) * Math.exp(-t * 22),
  },
  // Glassy break: bright pings scattered over a noise burst.
  shatter: {
    seconds: 0.9,
    gen: () => {
      const pings = Array.from({ length: 14 }, (_, i) => ({ at: i * 0.035 + Math.random() * 0.05, f: 2500 + Math.random() * 4000 }));
      return (t, r) => {
        let x = (r() * 2 - 1) * 0.5 * Math.exp(-t * 12);
        for (const p of pings) if (t > p.at) x += 0.25 * Math.sin(2 * Math.PI * p.f * (t - p.at)) * Math.exp(-(t - p.at) * 30);
        return x;
      };
    },
  },
  // Loopable wind: slow swells of filtered noise, wrapping around after 4 s.
  wind: {
    seconds: 4,
    gen: () => {
      let lp = 0, lp2 = 0;
      return (t, r) => {
        lp += 0.02 * (r() * 2 - 1 - lp);
        lp2 += 0.05 * (lp - lp2);
        const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * t) / 4);
        return lp2 * 14 * swell;
      };
    },
  },
};

export interface Loop {
  setPosition(p: THREE.Vector3): void;
  setRate(rate: number): void;
  setVolume(v: number): void;
  stop(): void;
}

export class Audio {
  private ctx: AudioContext | null = null;
  private buffers = new Map<SoundName, AudioBuffer>();
  private master!: GainNode;

  /** Browsers only allow audio after a user gesture; call from a click/keydown. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return; // no audio device; the game runs silent
    }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(ctx.destination);
    for (const [name, { seconds, gen }] of Object.entries(GENERATORS) as Array<[SoundName, (typeof GENERATORS)[SoundName]]>) {
      const len = Math.floor(seconds * RATE);
      const buf = ctx.createBuffer(1, len, RATE);
      const data = buf.getChannelData(0);
      const g = gen(), rnd = makeRng(name.length * 977).next;
      for (let i = 0; i < len; i++) data[i] = Math.max(-1, Math.min(1, g(i / RATE, rnd) * 0.5));
      this.buffers.set(name, buf);
    }
    for (const fn of this.pending) fn();
    this.pending = [];
  }
  private pending: Array<() => void> = [];

  get ready() {
    return this.ctx !== null;
  }

  /** Put the listener at the camera. */
  setListener(camera: THREE.Camera) {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = ctx.listener;
    const p = camera.getWorldPosition(new THREE.Vector3());
    const f = camera.getWorldDirection(new THREE.Vector3());
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(new THREE.Quaternion()));
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setValueAtTime(p.x, t);
      l.positionY.setValueAtTime(p.y, t);
      l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(f.x, t);
      l.forwardY.setValueAtTime(f.y, t);
      l.forwardZ.setValueAtTime(f.z, t);
      l.upX.setValueAtTime(u.x, t);
      l.upY.setValueAtTime(u.y, t);
      l.upZ.setValueAtTime(u.z, t);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
    this.listenerPos.copy(p);
  }
  private listenerPos = new THREE.Vector3();

  private panner(pos: THREE.Vector3) {
    const pn = this.ctx!.createPanner();
    pn.panningModel = 'HRTF';
    pn.distanceModel = 'inverse';
    pn.refDistance = 12;
    pn.maxDistance = 3000;
    pn.rolloffFactor = 1;
    pn.positionX.value = pos.x;
    pn.positionY.value = pos.y;
    pn.positionZ.value = pos.z;
    pn.connect(this.master);
    return pn;
  }

  /**
   * Play a one-shot. With `pos` it is positional and arrives after distance / speed of sound;
   * without, it is your own (your rifle, your boots).
   */
  play(name: SoundName, opts: { pos?: THREE.Vector3; volume?: number; rate?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = this.buffers.get(name)!;
    src.playbackRate.value = opts.rate ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = opts.volume ?? 1;
    src.connect(gain);
    let delay = 0;
    if (opts.pos) {
      gain.connect(this.panner(opts.pos));
      delay = opts.pos.distanceTo(this.listenerPos) / SPEED_OF_SOUND;
    } else gain.connect(this.master);
    src.start(ctx.currentTime + delay);
  }

  /** A short fanfare for the winner, a falling line for everyone else. */
  jingle(win: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const notes = win
      ? [[523, 0.12], [659, 0.12], [784, 0.12], [1047, 0.5], [988, 0.12], [1047, 0.7]]
      : [[392, 0.45], [370, 0.45], [349, 0.45], [330, 1.4]];
    let t = ctx.currentTime + 0.05;
    for (const [freq, len] of notes) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0, t);
      env.gain.linearRampToValueAtTime(0.25, t + 0.02);
      env.gain.setValueAtTime(0.25, t + len * 0.8);
      env.gain.linearRampToValueAtTime(0, t + len);
      osc.connect(env);
      env.connect(this.master);
      osc.start(t);
      osc.stop(t + len + 0.02);
      t += len;
    }
  }

  /** A looping sound (wind). Positional if `pos` is given. Safe to call before unlock. */
  loop(name: SoundName, pos?: THREE.Vector3): Loop {
    let src: AudioBufferSourceNode | null = null, gain: GainNode | null = null, pn: PannerNode | null = null;
    let rate = 1, volume = 1;
    const p = pos?.clone();
    let stopped = false;
    const start = () => {
      if (stopped || !this.ctx) return;
      src = this.ctx.createBufferSource();
      src.buffer = this.buffers.get(name)!;
      src.loop = true;
      src.playbackRate.value = rate;
      gain = this.ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      if (p) gain.connect((pn = this.panner(p)));
      else gain.connect(this.master);
      src.start();
    };
    if (this.ctx) start();
    else this.pending.push(start);
    return {
      setPosition: (v) => {
        p?.copy(v);
        if (pn && this.ctx) {
          const t = this.ctx.currentTime;
          pn.positionX.setTargetAtTime(v.x, t, 0.05);
          pn.positionY.setTargetAtTime(v.y, t, 0.05);
          pn.positionZ.setTargetAtTime(v.z, t, 0.05);
        }
      },
      setRate: (r) => {
        rate = r;
        if (src && this.ctx) src.playbackRate.setTargetAtTime(r, this.ctx.currentTime, 0.1);
      },
      setVolume: (v) => {
        volume = v;
        if (gain && this.ctx) gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
      },
      stop: () => {
        stopped = true;
        src?.stop();
      },
    };
  }
}
