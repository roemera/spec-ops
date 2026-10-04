# Spec Ops

Browser co-op game: a small squad of players against AI, in the spirit of the winter sniper mission
from Call of Duty Spec Ops (snowy terrain, long sightlines, patrols to slip past or pick off).

The code started as a copy of Skeleton Crew (a multiplayer tank game). The soldier, rifle and look are
new; the map layout and the PvP match flow (lobby, kill limit) are inherited and still to be replaced.

## Direction

- **Clean low poly, Superhot-like.** Flat-shaded simple geometry, a stark limited palette, crisp
  full-resolution rendering. No pixelation, vertex wobble or dithering from the old low-res look.
- **Spend polish only where it changes how the game plays.** If a sound or animation would take real
  work to do well, keep it simple and stylised rather than detailed.
- Everything is generated in code: map (seeded), models (boxes/cylinders/low poly meshes), textures
  (tiny canvases, if any), sounds (procedural). No asset files.
- No minimap and no spotting markers. Information comes from looking and directional sound.
- Trusted clients, dev-run server, password to join. No anti-cheat, no matchmaking.

## Code

- npm workspaces: `packages/shared` (constants, map gen, damage rules, protocol; used by client and
  server), `packages/client` (Vite + Three.js + Rapier), `packages/server` (Node + ws).
- Server and shared run as TypeScript directly in Node (type stripping): only erasable syntax
  (no enums, no constructor parameter properties) and `.ts` extensions on relative imports.
  `npm run typecheck` enforces this.
- Tuning numbers live in `packages/shared/src/constants.ts` and `hitzones.ts`.
- Check: `npm run typecheck` and `npm run build`.
- Run: `npm run dev` (game server + Vite together; default password `changeme`); `?test&offline` for headless single-player checks,
  `?test&join=localhost:5173&name=A&password=pw` for multiplayer ones (hides the click-to-play
  panel). `window.__game` exposes the player, rifle, targets, remotes, `fire()`, `aimAt(x, y, z)`
  (allows for bullet drop), `setScoped()` and `setHoldBreath()` for scripted tests.
- Colours live in `packages/client/src/render/palette.ts`; every mesh uses `flat()` from there.
