import * as THREE from 'three';
import { makeRng } from '@spec-ops/shared';

// All sounds are generated at startup. Outside sounds are positional (HRTF) and delayed by the
// speed of sound, so you can hear where a shot came from and roughly how far.

export const RATE = 44100;
const SPEED_OF_SOUND = 343; // m/s

export type SoundName = 'shot' | 'bolt' | 'reload' | 'dry' | 'step' | 'impact' | 'hit' | 'shatter' | 'wind' | 'shout' | 'huh' | 'hurt' | 'headshot' | 'magIn' | 'perfect' | 'jam' | 'pickup' | 'slide';

type Gen = (t: number, rnd: () => number) => number;

interface SoundDef {
  seconds: number;
  /** Several takes, one picked at random each play (default 1). */
  variants?: number;
  gen: (variant: number) => Gen;
}

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

/**
 * A metal part striking metal: a tick of noise and a few inharmonic ringing modes (like a small
 * steel part), the higher ones dying faster. `f0` sets the size: low for a magazine, high for a pin.
 */
const clank = (t: number, at: number, f0: number, decay: number, amp: number, r: () => number) => {
  const u = t - at;
  if (u < 0 || u > 0.4) return 0;
  let x = (r() * 2 - 1) * Math.exp(-u * 900) * 1.2;
  const modes = [1, 2.32, 4.25, 6.83, 9.4];
  for (let k = 0; k < modes.length; k++) x += Math.sin(2 * Math.PI * f0 * modes[k] * u + k) * Math.exp(-u * decay * (1 + k * 0.7)) / (1 + k * 0.8);
  return x * amp;
};

/** A one-pole low-pass, stateful: feed it one sample at a time. `a` 0..1 (smaller = darker). */
const lowpass = (a: number) => {
  let y = 0;
  return (x: number) => (y += a * (x - y));
};

/** Metal sliding on metal between `from` and `to` s: bright filtered noise with a gritty buzz. */
const scraper = () => {
  const lp = lowpass(0.35), lp2 = lowpass(0.05);
  return (t: number, from: number, to: number, amp: number, r: () => number) => {
    const n = r() * 2 - 1, band = lp(n) - lp2(n); // band-pass: no rumble, no hiss
    if (t < from || t > to) return 0;
    const k = (t - from) / (to - from);
    const grit = 0.6 + 0.4 * Math.sin(2 * Math.PI * 140 * t + 3 * Math.sin(2 * Math.PI * 23 * t));
    return band * grit * Math.sin(Math.PI * k) * amp * 2.5;
  };
};

/** Soft clip: untouched below 0.8, rounding off toward 1 above (no harsh digital clipping). */
export function soften(x: number) {
  const a = Math.abs(x);
  return a < 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2));
}

export const GENERATORS: Record<SoundName, SoundDef> = {
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
  // A rifle shot up close: the supersonic crack, the muzzle blast, a chest-thump of low end, then the
  // report rolling round the valley, slapping back off the slopes a few times, duller each time.
  shot: {
    seconds: 2.6,
    gen: () => {
      const blastLp = lowpass(0.3), tailLp = lowpass(0.035), tailLp2 = lowpass(0.05), echoLp = lowpass(0.08);
      const echoes = [[0.16, 0.45], [0.37, 0.3], [0.71, 0.2], [1.15, 0.12]];
      return (t, r) => {
        const n = r() * 2 - 1;
        // N-wave: a sharp positive spike then negative, under a millisecond, then bright hash.
        const crack = (t < 0.00035 ? 1 : t < 0.0007 ? -0.8 : 0) * 2.5 + n * Math.exp(-t * 700) * 1.4;
        const blast = blastLp(n) * Math.exp(-t * 28) * 3.2;
        const thump = Math.sin(2 * Math.PI * (48 + 70 * Math.exp(-t * 35)) * t) * Math.exp(-t * 11) * 1.4;
        const tail = tailLp2(tailLp(n)) * (Math.exp(-t * 1.6) * 0.8 + 0.2 * Math.exp(-t * 0.6)) * 9 * Math.min(1, t * 20);
        let echo = 0;
        const e = echoLp(n);
        for (const [at, amp] of echoes) if (t > at) echo += e * amp * Math.exp(-(t - at) * 14) * 3.5;
        return Math.tanh(crack + blast + thump + tail + echo) * 1.9;
      };
    },
  },
  // Working the bolt: lift (click), draw back (slide, then the empty case ticks out against the
  // stop), drive forward (slide, a round strips into the chamber), turn down to lock (solid click).
  bolt: {
    seconds: 0.75,
    gen: () => {
      const sc = scraper();
      return (t, r) =>
        clank(t, 0.01, 1700, 60, 0.7, r) +
        sc(t, 0.07, 0.19, 0.5, r) + clank(t, 0.19, 1150, 45, 1, r) + clank(t, 0.235, 2900, 90, 0.35, r) +
        sc(t, 0.36, 0.48, 0.55, r) + clank(t, 0.48, 1350, 40, 1.1, r) +
        clank(t, 0.6, 2100, 55, 0.85, r);
    },
  },
  // Magazine out: the release clicks, the mag slides out of the well, a hand into a pouch.
  reload: {
    seconds: 0.75,
    gen: () => {
      const sc = scraper(), cloth = lowpass(0.06);
      return (t, r) => {
        const n = r() * 2 - 1, c = cloth(n);
        const rustle = t > 0.36 && t < 0.62 ? c * 4 * Math.sin((Math.PI * (t - 0.36)) / 0.26) * (0.6 + 0.4 * Math.sin(t * 90)) : 0;
        return clank(t, 0.02, 2600, 80, 0.55, r) + sc(t, 0.05, 0.17, 0.6, r) + clank(t, 0.17, 780, 50, 0.45, r) + rustle * 0.6;
      };
    },
  },
  // Magazine in: a short slide up the well, the solid seat, the catch snapping over.
  magIn: {
    seconds: 0.3,
    gen: () => {
      const sc = scraper();
      return (t, r) => sc(t, 0, 0.06, 0.5, r) + clank(t, 0.06, 820, 38, 1.2, r) + clank(t, 0.075, 2400, 85, 0.55, r);
    },
  },
  // Perfect active reload: the palm slaps the magazine home hard, a bright catch.
  perfect: {
    seconds: 0.4,
    gen: () => (t, r) =>
      Math.sin(2 * Math.PI * 170 * t) * Math.exp(-t * 45) * 0.9 + clank(t, 0.0, 900, 35, 0.9, r) + clank(t, 0.012, 3100, 70, 0.45, r),
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
  // Picking something up: a hand on canvas, rounds or bottles rattling, a latch.
  pickup: {
    seconds: 0.5,
    gen: () => {
      const cloth = lowpass(0.08);
      return (t, r) => {
        const c = cloth(r() * 2 - 1) * 3 * Math.exp(-t * 9);
        return c + clank(t, 0.05, 2300, 90, 0.35, r) + clank(t, 0.11, 2700, 100, 0.3, r) + clank(t, 0.16, 2050, 90, 0.3, r) + clank(t, 0.3, 1300, 60, 0.45, r);
      };
    },
  },
  // Sliding into the snow: a hiss of packed grains under the body, fading as you slow, a few
  // gear rattles, and a thump as you go down.
  slide: {
    seconds: 0.9,
    gen: () => {
      const hiss = lowpass(0.25), low = lowpass(0.03), cloth = lowpass(0.08);
      return (t, r) => {
        const n = r() * 2 - 1;
        const env = Math.min(1, t / 0.04) * Math.exp(-t * 3.2);
        const grains = hiss(n) * (0.7 + 0.5 * Math.sin(t * 47 + 3 * Math.sin(t * 13))) * 2.2 * env;
        const thump = low(n) * 5 * Math.exp(-t * 22);
        return grains + thump + cloth(n) * 1.5 * Math.exp(-t * 6) + clank(t, 0.08, 1500, 80, 0.15, r) + clank(t, 0.21, 1900, 90, 0.1, r);
      };
    },
  },
  // Dry fire: the firing pin snaps on an empty chamber.
  dry: {
    seconds: 0.15,
    gen: () => (t, r) => clank(t, 0, 3300, 110, 0.7, r),
  },
  // A boot in snow: a muffled heel thump and a squeak-crunch of packed grains. Several takes,
  // picked at random, so a run of steps never repeats.
  step: {
    seconds: 0.3,
    variants: 6,
    gen: (v) => {
      const grainLp = lowpass(0.3 + 0.06 * v), body = lowpass(0.04), seedR = makeRng(v * 131 + 7);
      const len = 0.17 + seedR.next() * 0.08, heel = 0.4 + seedR.next() * 0.4, squeak = 900 + seedR.next() * 900;
      return (t, r) => {
        const n = r() * 2 - 1;
        const env = Math.sin(Math.PI * Math.min(1, t / len)) * (t < len ? 1 : 0);
        const crunch = r() < 0.12 + 0.06 * Math.sin(t * 60 + v) ? grainLp(n) * 3 : grainLp(n) * 0.6;
        const thump = body(n) * 6 * Math.exp(-t * 30) * heel;
        const sq = Math.sin(2 * Math.PI * squeak * t) * 0.08 * Math.exp(-t * 25);
        return (crunch * env + thump + sq) * 0.55;
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
  // Loopable wind, 12 s: irregular gusts (several slow swells that don't line up, so it doesn't
  // breathe like surf), a hiss through the pines that brightens as a gust builds, and a thin howl
  // whose pitch rises with it. Every modulation fits a whole number of times into 12 s, so it loops.
  wind: {
    seconds: 12,
    gen: () => {
      const L = 12;
      const hissHi = lowpass(0.5), hissLo = lowpass(0.04), rumble = lowpass(0.004);
      // Two resonant band-passes (state-variable filters) for the howl.
      const howl = (q: number) => {
        let low = 0, band = 0;
        return (x: number, fc: number) => {
          const f = 2 * Math.sin((Math.PI * fc) / RATE);
          low += f * band;
          const high = x - low - q * band;
          band += f * high;
          return band;
        };
      };
      const h1 = howl(0.04), h2 = howl(0.06);
      const w = (k: number, t: number, ph: number) => Math.sin((2 * Math.PI * k * t) / L + ph);
      return (t, r) => {
        const n = r() * 2 - 1;
        const g0 = 0.5 + 0.22 * w(1, t, 1.3) + 0.16 * w(3, t, 0.4) + 0.1 * w(5, t, 2.2) + 0.05 * w(23, t, 0.9) + 0.03 * w(41, t, 2.7);
        const gust = Math.max(0, g0) ** 1.6; // peaky: lulls, then a gust
        const hiss = (hissHi(n) - hissLo(n)) * (0.25 + 0.9 * gust);
        const tone = (h1(n, 380 + 420 * gust) * 0.05 + h2(n, 610 + 520 * gust) * 0.035) * gust;
        return (hiss * 1.6 + tone + rumble(n) * 6 * (0.3 + gust)) * 1.1;
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
  private buffers = new Map<SoundName, AudioBuffer[]>();
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
    for (const [name, { seconds, gen, variants = 1 }] of Object.entries(GENERATORS) as Array<[SoundName, SoundDef]>) {
      const takes: AudioBuffer[] = [];
      for (let v = 0; v < variants; v++) {
        const len = Math.floor(seconds * RATE);
        const buf = ctx.createBuffer(1, len, RATE);
        const data = buf.getChannelData(0);
        const g = gen(v), rnd = makeRng(name.length * 977 + v * 31).next;
        for (let i = 0; i < len; i++) data[i] = soften(g(i / RATE, rnd) * 0.5);
        takes.push(buf);
      }
      this.buffers.set(name, takes);
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
    const takes = this.buffers.get(name)!;
    src.buffer = takes[Math.floor(Math.random() * takes.length)];
    src.playbackRate.value = opts.rate ?? 1;
    const gain = ctx.createGain();
    gain.gain.value = opts.volume ?? 1;
    src.connect(gain);
    let delay = 0;
    if (opts.pos) {
      // The air takes the top off distant sounds: a far shot is a dull boom, a near one cracks.
      const d = opts.pos.distanceTo(this.listenerPos);
      const air = ctx.createBiquadFilter();
      air.type = 'lowpass';
      air.frequency.value = Math.max(700, 20000 * Math.exp(-d / 140));
      gain.connect(air);
      air.connect(this.panner(opts.pos));
      delay = d / SPEED_OF_SOUND;
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
      src.buffer = this.buffers.get(name)![0];
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
