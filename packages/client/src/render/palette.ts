import * as THREE from 'three';

// Superhot in the snow: a near-white world, dark cover, black guns, red enemies.
// Colours carry the meaning; keep the list short.
export const PAL = {
  skyTop: 0xc9d5e2,
  horizon: 0xe8edf2, // also the fog: far things fade into the sky
  snow: 0xf3f5f7,
  snowShade: 0x8ea2b6, // hemisphere ground colour: tints shadowed sides blue
  ice: 0xc9dbe6, // the frozen creek
  cliff: 0x9aa3ab, // bare rock on steep ground
  rock: 0x8d969f,
  wall: 0xc4cad0,
  roof: 0x454d55,
  pine: 0x2e3b43,
  trunk: 0x1c2126,
  fence: 0x3a4248,
  gun: 0x15181b,
  enemy: 0xe3221a, // red: something you can shoot (targets now, AI later)
  friend: 0x262b30, // other players: charcoal, never red
  skin: 0xe9e4de,
  trail: 0x2a3036,
  signal: 0xff7a1a, // orange: the objective (extraction smoke). Never on enemies or players
  flash: 0xfff4d6,
} as const;

/** Flat-shaded Lambert: every face one colour, lit by the sun. The whole look in one material. */
export function flat(color: number, extra: THREE.MeshLambertMaterialParameters = {}) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
}

const shared = new Map<number, THREE.MeshLambertMaterial>();
/** The same opaque flat material for every mesh of one colour (fewer state changes, less memory). */
export function flatShared(color: number) {
  let m = shared.get(color);
  if (!m) shared.set(color, (m = flat(color)));
  return m;
}
