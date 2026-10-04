import * as THREE from 'three';
import { makeRng } from '@spec-ops/shared';

// All sounds are generated at startup: low sample rate, crushed to a few bits.
// Outside sounds are positional (HRTF), delayed by the speed of sound, and muffled while you are inside the tank.

const RATE = 11025; // lo-fi on purpose
const SPEED_OF_SOUND = 343; // m/s
const INSIDE_CUTOFF = 700; // Hz: outside world heard through armour
const OUTSIDE_CUTOFF = 18000; // Hz: head out of the hatch

export type SoundName = 'cannon' | 'explosion' | 'clank' | 'breech' | 'dry' | 'engine' | 'crawl' | 'impact' | 'mg';

type Gen = (t: number, rnd: () => number) => number;

const crush = (x: number) => Math.round(Math.max(-1, Math.min(1, x)) * 12) / 12;

const GENERATORS: Record<SoundName, { seconds: number; gen: () => Gen }> = {
  cannon: {
    seconds: 1.6,
    gen: () => {
      let lp = 0;
      return (t, r) => {
        lp += 0.35 * (r() * 2 - 1 - lp);
        const boom = Math.sin(2 * Math.PI * (55 - 25 * t) * t) * Math.exp(-t * 5);
        return 2.2 * (lp * Math.exp(-t * 3.5) + boom);
      };
    },
  },
  explosion: {
    seconds: 2.2,
    gen: () => {
      let lp = 0;
      return (t, r) => {
        lp += 0.12 * (r() * 2 - 1 - lp);
        const crackle = r() < 0.004 * Math.exp(-t * 2) ? 1 : 0;
        return 3 * lp * Math.exp(-t * 2.2) + crackle + Math.sin(2 * Math.PI * 38 * t) * Math.exp(-t * 4);
      };
    },
  },
  impact: {
    seconds: 0.6,
    gen: () => (t, r) =>
      (Math.sin(2 * Math.PI * 140 * t) + 0.6 * Math.sin(2 * Math.PI * 431 * t) + 0.5 * (r() * 2 - 1)) * Math.exp(-t * 9),
  },
  clank: {
    seconds: 0.4,
    gen: () => (t, r) =>
      (0.5 * Math.sin(2 * Math.PI * 420 * t) + 0.4 * Math.sin(2 * Math.PI * 1130 * t) + 0.3 * Math.sin(2 * Math.PI * 2210 * t)) *
        Math.exp(-t * 14) + (t < 0.01 ? r() * 2 - 1 : 0),
  },
  breech: {
    seconds: 0.6,
    gen: () => (t, r) =>
      (0.7 * Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 610 * t)) * Math.exp(-t * 10) +
      (t < 0.02 ? r() * 2 - 1 : 0) + Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t * 20),
  },
  mg: {
    seconds: 0.1,
    gen: () => (t, r) => ((r() * 2 - 1) * 1.6 + Math.sin(2 * Math.PI * 220 * t)) * Math.exp(-t * 45),
  },
  dry: {
    seconds: 0.12,
    gen: () => (t, r) => (r() * 2 - 1) * Math.exp(-t * 60),
  },
  crawl: {
    seconds: 0.5,
    gen: () => {
      let lp = 0;
      return (t, r) => {
        lp += 0.3 * (r() * 2 - 1 - lp);
        return lp * Math.sin(Math.PI * (t / 0.5)) * 1.5;
      };
    },
  },
  // Loopable: exactly 30 engine cycles in one second.
  engine: {
    seconds: 1,
    gen: () => (t, r) => {
      const phase = (t * 30) % 1;
      const pulse = phase < 0.3 ? 1 : -0.4;
      return 0.5 * pulse + 0.3 * Math.sin(2 * Math.PI * 60 * t) + 0.15 * (r() * 2 - 1);
    },
  },
};

/** What the crew is mumbling about. Each mood has its own pitch, speed and length. */
export type Voice = 'grunt' | 'shout' | 'yep' | 'scream' | 'panic' | 'cheer' | 'wail';

const MOODS: Record<Voice, { syllables: [number, number]; pitch: number; len: number; glide: number }> = {
  grunt: { syllables: [1, 2], pitch: 0.8, len: 0.12, glide: -0.2 },
  yep: { syllables: [1, 1], pitch: 1.2, len: 0.1, glide: 0.3 },
  shout: { syllables: [2, 3], pitch: 1.1, len: 0.11, glide: 0.1 },
  scream: { syllables: [3, 4], pitch: 1.7, len: 0.09, glide: 0.5 },
  panic: { syllables: [5, 7], pitch: 1.5, len: 0.06, glide: 0.2 },
  cheer: { syllables: [3, 4], pitch: 1.3, len: 0.12, glide: 0.4 },
  wail: { syllables: [2, 2], pitch: 1.0, len: 0.45, glide: -0.6 },
};

// Vowel formants (F1, F2) in Hz: a, e, i, o, u.
const VOWELS: Array<[number, number]> = [[800, 1200], [500, 1900], [300, 2300], [500, 900], [350, 800]];

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
  private outside!: BiquadFilterNode; // everything positional goes through here
  private inside = true;

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
    this.outside = ctx.createBiquadFilter();
    this.outside.type = 'lowpass';
    this.outside.frequency.value = this.inside ? INSIDE_CUTOFF : OUTSIDE_CUTOFF;
    this.outside.connect(this.master);
    for (const [name, { seconds, gen }] of Object.entries(GENERATORS) as Array<[SoundName, (typeof GENERATORS)[SoundName]]>) {
      const len = Math.floor(seconds * RATE);
      const buf = ctx.createBuffer(1, len, RATE);
      const data = buf.getChannelData(0);
      const g = gen(), rnd = makeRng(name.length * 977).next;
      for (let i = 0; i < len; i++) data[i] = crush(g(i / RATE, rnd) * 0.5);
      this.buffers.set(name, buf);
    }
    for (const fn of this.pending) fn();
    this.pending = [];
  }
  private pending: Array<() => void> = [];

  get ready() {
    return this.ctx !== null;
  }

  /** Inside the hull the world is muffled; with your head out it is not. */
  setInside(inside: boolean) {
    if (inside === this.inside) return;
    this.inside = inside;
    if (this.ctx) this.outside.frequency.setTargetAtTime(inside ? INSIDE_CUTOFF : OUTSIDE_CUTOFF, this.ctx.currentTime, 0.08);
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
    pn.connect(this.outside);
    return pn;
  }

  /**
   * Play a one-shot. With `pos` it is a positional outside sound that arrives after
   * distance / speed of sound; without, it is inside the tank with you.
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

  /**
   * Gibberish crew voice: buzzy syllables through two vowel formants, crushed. Cursed on purpose.
   * `base` is this crew's pitch in Hz.
   */
  voice(mood: Voice, base = 150, volume = 0.9) {
    const ctx = this.ctx;
    if (!ctx) return;
    const m = MOODS[mood];
    const out = ctx.createGain();
    out.gain.value = volume;
    const crusher = ctx.createWaveShaper();
    crusher.curve = Float32Array.from({ length: 64 }, (_, i) => Math.round(((i / 63) * 2 - 1) * 4) / 4);
    crusher.connect(out);
    out.connect(this.master);
    const n = m.syllables[0] + Math.floor(Math.random() * (m.syllables[1] - m.syllables[0] + 1));
    let t = ctx.currentTime + 0.02;
    for (let i = 0; i < n; i++) {
      const len = m.len * (0.7 + Math.random() * 0.6);
      const f0 = base * m.pitch * (0.85 + Math.random() * 0.3);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.linearRampToValueAtTime(f0 * (1 + m.glide * (Math.random() + 0.3)), t + len);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.5, t + 0.015);
      env.gain.setValueAtTime(0.5, t + len * 0.7);
      env.gain.linearRampToValueAtTime(0, t + len);
      const [f1, f2] = VOWELS[Math.floor(Math.random() * VOWELS.length)];
      for (const f of [f1, f2]) {
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = f;
        bp.Q.value = 6;
        osc.connect(bp);
        bp.connect(env);
      }
      env.connect(crusher);
      osc.start(t);
      osc.stop(t + len + 0.02);
      t += len + 0.03 + Math.random() * 0.04;
    }
  }

  /** Out-of-tune fanfare for the winner, sad trombone for everyone else. */
  jingle(win: boolean) {
    const ctx = this.ctx;
    if (!ctx) return;
    const notes = win
      ? [[523, 0.12], [659, 0.12], [784, 0.12], [1047, 0.5], [988, 0.12], [1047, 0.7]]
      : [[392, 0.45], [370, 0.45], [349, 0.45], [330, 1.4]];
    let t = ctx.currentTime + 0.05;
    for (const [freq, len] of notes) {
      const osc = ctx.createOscillator();
      osc.type = win ? 'square' : 'sawtooth';
      const detune = (Math.random() - 0.5) * 120; // cents: nobody tuned this
      osc.frequency.setValueAtTime(freq, t);
      osc.detune.setValueAtTime(detune, t);
      if (!win && len > 1) {
        // the wah-wah at the end
        const lfo = ctx.createOscillator(), depth = ctx.createGain();
        lfo.frequency.value = 6;
        depth.gain.value = 18;
        lfo.connect(depth);
        depth.connect(osc.frequency);
        lfo.start(t);
        lfo.stop(t + len);
      }
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

  /** A looping sound (engines). Positional if `pos` is given. Safe to call before unlock. */
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
