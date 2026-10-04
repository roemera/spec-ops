import { makeRng } from './rng.ts';

// Each mission's weather comes from its seed, so the server and every client agree on it: where the
// wind blows from, how strong (it gusts over time), and how hard it snows. Wind pushes bullets
// sideways; heavy snow closes the fog in and shortens how far the enemy can see.

export interface Weather {
  windFrom: number; // rad, compass bearing the wind blows from (0 = north, -z)
  windSpeed: number; // m/s, average
  snow: number; // 0..1, light to heavy
  visibility: number; // 0..1 multiplier on fog distance and enemy view range
}

export function weatherFor(seed: number): Weather {
  const rng = makeRng(seed * 31 + 5);
  const windFrom = rng.range(0, Math.PI * 2);
  const windSpeed = 1 + rng.next() ** 1.4 * 8; // mostly breezy, sometimes a gale
  const snow = 0.15 + rng.next() * 0.85;
  return { windFrom, windSpeed, snow, visibility: 1 - 0.45 * snow };
}

/** Wind velocity (m/s, horizontal, the way the air moves) `t` seconds into the mission. Gusts and veers slowly. */
export function windAt(w: Weather, t: number): { x: number; z: number } {
  const gust = 1 + 0.3 * Math.sin(t * 0.23 + 1.3) + 0.2 * Math.sin(t * 0.61 + 0.4);
  const from = w.windFrom + 0.2 * Math.sin(t * 0.07);
  const speed = w.windSpeed * Math.max(0.2, gust);
  // Blowing from bearing `from` means moving toward the opposite bearing.
  return { x: -Math.sin(from) * speed, z: Math.cos(from) * speed };
}
