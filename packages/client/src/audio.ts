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
  /** A loop: render this many s more and crossfade the end into the start, so it wraps seamlessly. */
  loopFade?: number;
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

/**
 * A two-pole resonator: one mode ringing at `freq` Hz, dying by `decay` (1/s). A unit impulse in
 * rings at about unit amplitude. Stateful: feed it one sample at a time.
 */
const resonator = (freq: number, decay: number) => {
  const w = (2 * Math.PI * freq) / RATE, r = Math.exp(-decay / RATE);
  const c = 2 * r * Math.cos(w), r2 = r * r, g = Math.sin(w);
  let y1 = 0, y2 = 0;
  return (x: number) => {
    const y = c * y1 - r2 * y2 + g * x;
    y2 = y1;
    y1 = y;
    return y;
  };
};

/**
 * One part of the action hitting or sliding on another. With `len` it slides (a scrape) for that
 * long, otherwise it strikes once. `f` is the part's lowest mode (low for a magazine, high for a pin),
 * `wood` how much it thumps the stock.
 */
interface MechEvent { at: number; f: number; amp: number; len?: number; wood?: number; decay?: number }

/**
 * Gun mechanics as modal synthesis: each event is a burst of noise (a strike) or a train of
 * stick-slip impulses (a slide) driving a few resonant modes of a small steel part (the mode
 * ratios of a free bar), plus the raw click itself and a knock through the wooden stock. Real
 * clicks are mostly the transient: the modes are short and quiet, so it clacks rather than dings.
 */
const mech = (events: MechEvent[]): Gen => {
  const parts = events.map((e) => {
    const decay = e.decay ?? 70;
    const modes = [1, 2.756, 5.404, 8.933].filter((k) => e.f * k < 16000);
    return {
      e,
      bank: modes.map((k, i) => resonator(e.f * k, decay * (1 + i * 0.8))),
      wood: [resonator(230, 55), resonator(470, 80)],
      hp: lowpass(0.15),
      end: e.at + (e.len ?? 0) + 0.35,
    };
  });
  return (t, r) => {
    let out = 0;
    for (const p of parts) {
      const { e } = p, u = t - e.at;
      if (u < 0 || t > p.end) continue;
      let x = 0;
      if (e.len) {
        // Sliding: irregular catches of the surfaces, loudest mid-stroke.
        if (u < e.len) {
          const env = Math.sin((Math.PI * u) / e.len);
          if (r() < 1400 / RATE) x += (r() * 2 - 1) * env * 0.75;
          x += (r() * 2 - 1) * env * 0.07;
        }
      } else x = (r() * 2 - 1) * Math.exp(-u / 0.00025) + (u * RATE < 1 ? 1 : 0);
      x *= e.amp;
      const click = x - p.hp(x); // the transient, rumble taken off
      let ring = 0;
      for (let i = 0; i < p.bank.length; i++) ring += p.bank[i](x) / (1 + i);
      const knock = (e.wood ?? 0) * (p.wood[0](x) + 0.5 * p.wood[1](x));
      out += click * 1.6 + ring * 0.35 + knock * 0.5;
    }
    return out;
  };
};

/** Friedlander pulse: the shape of a blast wave. A push lasting `T` s, then a longer, shallower pull. */
const friedlander = (t: number, T: number) => (t < 0 ? 0 : (1 - t / T) * Math.exp(-t / T));

/**
 * The shot, rendered whole: a dry close-up blast, then a valley's worth of reflections made by
 * scattering copies of it (sparse "velvet" taps), each later copy darker, since air and snow soak
 * up the top end first.
 */
function shotBuffer(variant: number, seconds: number) {
  const rnd = makeRng(4242 + variant * 17).next;
  const n = Math.floor(seconds * RATE);
  const jit = (a: number) => 1 + (rnd() * 2 - 1) * a;
  // Dry blast, 60 ms.
  const dl = Math.floor(0.06 * RATE), dry = new Float32Array(dl);
  const T = 0.0006 * jit(0.15), Tsub = 0.004 * jit(0.15);
  const gasLp = lowpass(0.5), ring = [resonator(2150 * jit(0.05), 45), resonator(3380 * jit(0.05), 60), resonator(5100 * jit(0.05), 90)];
  const ground = 0.0042 * jit(0.2), groundLp = lowpass(0.25);
  const pre = new Float32Array(dl);
  for (let i = 0; i < dl; i++) {
    const t = i / RATE;
    // The crack: a sub-millisecond N, up then down.
    const crack = t < 0.00011 ? 0.8 : t < 0.00024 ? -0.8 : 0;
    const gas = gasLp(rnd() * 2 - 1) * Math.exp(-t * 55) * Math.min(1, t / 0.0004) * 0.9;
    pre[i] = crack + 1.4 * friedlander(t, T) + 0.35 * friedlander(t, Tsub) + gas;
  }
  for (let i = 0; i < dl; i++) {
    // The ground bounce arrives a few ms late, a little dulled.
    const j = i - Math.round(ground * RATE);
    const bounce = j >= 0 ? groundLp(pre[j]) * 0.55 : 0;
    const x = pre[i] + bounce;
    let rg = 0;
    for (let k = 0; k < ring.length; k++) rg += ring[k](i < 90 ? pre[i] * 0.02 : 0) / (1 + k);
    dry[i] = Math.tanh(x * 1.5) + rg * 0.5;
  }
  // Three shades of the blast for the reflections: bright (near), dull, dark (far).
  const shade = (a: number) => {
    const l1 = lowpass(a), l2 = lowpass(a);
    return dry.map((x) => l2(l1(x)));
  };
  const shades = [shade(0.3), shade(0.09), shade(0.035)];
  const out = new Float32Array(n);
  out.set(dry);
  const tap = (at: number, amp: number) => {
    const s = shades[at < 0.15 ? 0 : at < 0.6 ? 1 : 2];
    const i0 = Math.floor(at * RATE);
    for (let k = 0; k < dl && i0 + k < n; k++) out[i0 + k] += s[k] * amp;
  };
  // Diffuse rolling tail: taps thinning out and dying away.
  for (let t = 0.012; t < seconds - 0.06; ) {
    const env = Math.min(1, t / 0.08) * (Math.exp(-t * 2.4) * 0.9 + Math.exp(-t * 0.9) * 0.15);
    tap(t, (rnd() < 0.5 ? -1 : 1) * env * 0.05 * (0.5 + rnd()));
    t += (1 / 1400) * (1 + t * 2) * (0.5 + rnd());
  }
  // Slapback off the slopes: clusters of taps, each echo later, quieter, smeared wider.
  const echoes = [[0.17, 0.5], [0.39, 0.33], [0.74, 0.22], [1.2, 0.13]];
  for (const [at, amp] of echoes) {
    const a = at * jit(0.15), spread = 0.015 + a * 0.05;
    for (let k = 0; k < 10; k++) tap(a + rnd() * spread, (rnd() < 0.5 ? -1 : 1) * amp * (0.4 + 0.6 * rnd()) * 0.45);
  }
  // Fade the very end so the take doesn't stop on a sample.
  for (let i = n - 2000; i < n; i++) out[i] *= (n - i) / 2000;
  let peak = 0;
  for (const x of out) peak = Math.max(peak, Math.abs(x));
  for (let i = 0; i < n; i++) out[i] *= 3.4 / peak;
  return out;
}

/** One take of a sound as samples: generated, looped if it loops, soft clipped. */
export function renderSound(name: SoundName, variant: number): Float32Array<ArrayBuffer> {
  const def = GENERATORS[name];
  const len = Math.floor(def.seconds * RATE), fade = Math.floor((def.loopFade ?? 0) * RATE);
  const g = def.gen(variant), rnd = makeRng(name.length * 977 + variant * 31).next;
  const raw = new Float32Array(len + fade);
  for (let i = 0; i < raw.length; i++) raw[i] = g(i / RATE, rnd) * 0.5;
  // Equal-power crossfade: the extra tail fades out over the start as the start fades in.
  for (let i = 0; i < fade; i++) {
    const k = (i / fade) * (Math.PI / 2);
    raw[i] = raw[i] * Math.sin(k) + raw[len + i] * Math.cos(k);
  }
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = soften(raw[i]);
  return out;
}

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
  // A rifle shot from behind the stock, built the way recordings break one down: the bullet's
  // N-wave crack, the muzzle blast (a Friedlander pressure pulse, a millisecond or so of push then a
  // longer pull), the receiver ringing, the ground bounce a few ms later, then the report rolling
  // round the valley, smeared and duller with each slope it comes back off.
  shot: {
    seconds: 2.6,
    variants: 3,
    gen: (v) => {
      const buf = shotBuffer(v, 2.6);
      return (t) => buf[Math.min(buf.length - 1, Math.round(t * RATE))];
    },
  },
  // Working the bolt: lift (click), draw back (steel on steel, a clack at the stop, the empty brass
  // tinkles out), drive forward (a round strips into the chamber), turn down to lock (solid clack).
  bolt: {
    seconds: 0.8,
    gen: () =>
      mech([
        { at: 0.01, f: 1900, amp: 0.8, wood: 0.3 },
        { at: 0.07, len: 0.11, f: 2600, amp: 0.45 },
        { at: 0.185, f: 1250, amp: 1, wood: 0.6 },
        { at: 0.23, f: 3900, amp: 0.25, decay: 14 }, // the case
        { at: 0.3, f: 4700, amp: 0.1, decay: 18 },
        { at: 0.35, len: 0.11, f: 2400, amp: 0.5 },
        { at: 0.465, f: 1400, amp: 1, wood: 0.5 },
        { at: 0.6, f: 2050, amp: 0.9, wood: 0.8 },
      ]),
  },
  // Magazine out: the release clicks, the mag slides out of the well, a hand stuffs it in a pouch.
  reload: {
    seconds: 0.75,
    gen: () => {
      const m = mech([
        { at: 0.02, f: 3100, amp: 0.55, wood: 0.15 },
        { at: 0.05, len: 0.1, f: 1700, amp: 0.4 },
        { at: 0.155, f: 950, amp: 0.45, wood: 0.25 },
      ]);
      const cloth = lowpass(0.12), cloth2 = lowpass(0.02);
      let grain = 0;
      return (t, r) => {
        const n = r() * 2 - 1, c = cloth(n) - cloth2(n);
        // Canvas: a band of noise in uneven scuffs.
        if (r() < 0.01) grain = 0.4 + r() * 0.6;
        grain *= 0.9993;
        const rustle = t > 0.36 && t < 0.64 ? c * 5 * grain * Math.sin((Math.PI * (t - 0.36)) / 0.28) : 0;
        return m(t, r) + rustle;
      };
    },
  },
  // Magazine in: a short slide up the well, the solid seat, the catch snapping over.
  magIn: {
    seconds: 0.3,
    gen: () =>
      mech([
        { at: 0.0, len: 0.05, f: 1600, amp: 0.4 },
        { at: 0.06, f: 850, amp: 1.2, wood: 1 },
        { at: 0.073, f: 3000, amp: 0.6 },
      ]),
  },
  // Perfect active reload: the palm slaps the magazine home hard, a bright catch.
  perfect: {
    seconds: 0.4,
    gen: () => {
      const m = mech([
        { at: 0.004, f: 800, amp: 1.4, wood: 1.3 },
        { at: 0.014, f: 3400, amp: 0.7 },
      ]);
      const skin = lowpass(0.2);
      return (t, r) => m(t, r) + skin(r() * 2 - 1) * 2.5 * Math.exp(-t * 160);
    },
  },
  // Fumbled active reload: a dull clunk off the edge of the well, then the mag rattling loose.
  jam: {
    seconds: 0.5,
    gen: () =>
      mech([
        { at: 0.0, f: 620, amp: 1.1, wood: 1.4, decay: 120 },
        { at: 0.13, f: 2200, amp: 0.35 },
        { at: 0.19, f: 1900, amp: 0.25, wood: 0.3 },
        { at: 0.26, f: 2400, amp: 0.3 },
      ]),
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
    gen: () => mech([{ at: 0.0, f: 3300, amp: 0.8, wood: 0.25 }, { at: 0.011, f: 4400, amp: 0.25 }]),
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
  // Wind, after Andy Farnell's model (Designing Sound, "Practical 18: Wind"). One control signal,
  // the wind's strength, drives everything: a slow swell, plus gusts (noise low-passed twice at
  // 0.5 Hz, so they wander), plus squalls (noise low-passed at 3 Hz, gated so only its peaks get
  // through). That strength sets the level of a broad band of noise around 600 Hz (Farnell uses 800; lower suits a wide valley), and both the
  // level and the pitch of two narrow resonances (Q 60), the whistle, which rise as it blows
  // harder. Crossfaded into a 20 s loop.
  wind: {
    seconds: 20,
    loopFade: 3,
    gen: () => {
      const lp = (fc: number) => {
        const a = 1 - Math.exp((-2 * Math.PI * fc) / RATE);
        let y = 0;
        return (x: number) => (y += a * (x - y));
      };
      /** Resonant band-pass (state-variable filter), unity gain at the centre. */
      const bp = (q: number) => {
        let low = 0, band = 0;
        return (x: number, fc: number) => {
          const f = 2 * Math.sin((Math.PI * fc) / RATE), d = 1 / q;
          low += f * band;
          const high = x - low - d * band;
          band += f * high;
          return band * d;
        };
      };
      const gustA = lp(0.5), gustB = lp(0.5), squallA = lp(3), squallB = lp(3);
      const body = bp(1), whistle1 = bp(60), whistle2 = bp(60), rumble = lp(120);
      return (t, r) => {
        const n = r() * 2 - 1;
        const swell = 0.5 + 0.09 * Math.sin(2 * Math.PI * 0.1 * t) + 0.05 * Math.sin(2 * Math.PI * 0.035 * t + 1);
        const gust = gustB(gustA(n)) * 80 * (swell + 0.375);
        const squall = Math.max(0, squallB(squallA(r() * 2 - 1)) * 40 - 0.4) * 0.7;
        const c = Math.max(0.05, Math.min(1.3, swell + gust + squall));
        const air = body(n, 600) * c * 1.8;
        const howl = (whistle1(n, 430 + 300 * c) * 5.5 + whistle2(n, 720 + 330 * c) * 3) * c * c;
        return (air + howl + rumble(n) * 2.2 * c) * 1.7;
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
    for (const [name, { seconds, variants = 1 }] of Object.entries(GENERATORS) as Array<[SoundName, SoundDef]>) {
      const takes: AudioBuffer[] = [];
      for (let v = 0; v < variants; v++) {
        const len = Math.floor(seconds * RATE);
        const buf = ctx.createBuffer(1, len, RATE);
        buf.copyToChannel(renderSound(name, v), 0);
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
  /**
   * `ambient` (0..1, positional only): the share heard from all round rather than from `pos`, to
   * soften how much it shifts as you turn. `ambientLevel` matches it to how loud the placed part
   * arrives (the panner's falloff at the distance the caller keeps it).
   */
  loop(name: SoundName, pos?: THREE.Vector3, ambient = 0, ambientLevel = 1): Loop {
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
      if (p) {
        const placed = this.ctx.createGain(), around = this.ctx.createGain();
        placed.gain.value = 1 - ambient;
        around.gain.value = ambient * ambientLevel;
        gain.connect(placed).connect((pn = this.panner(p)));
        gain.connect(around).connect(this.master);
      } else gain.connect(this.master);
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
