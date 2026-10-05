# Spec Ops

Browser co-op game: a small squad of players against AI, in the spirit of the winter sniper mission
from Call of Duty Spec Ops (snowy terrain, long sightlines, patrols to slip past or pick off).

The code started as a copy of Skeleton Crew (a multiplayer tank game). The soldier, rifle and look are
new, and so is the procedural map (`mapgen.ts`: valley, forest, creek, route from start to extraction,
outposts) and the enemy AI, which only the server runs (`ai.ts`, with `obstacles.ts` for line of sight).
Weather (`weather.ts`) comes from the mission seed: wind drifts bullets and is read from snow, smoke
and sound (no gauge); heavy snow shortens fog and enemy sight. There is no offline mode. Missions are co-op: no friendly fire, down/revive/bleed out, extraction
when everyone standing is on the pad, a new map each mission (clients reload and rejoin to build it).
Mission rules are plain logic in `server/src/match.ts`; test them in Node with fake players.

## Direction

- **Low poly with simple textures, toward Half-Life 1.** Modest geometry with some detail (kit on
  soldiers, frames and roofs on huts), small procedural textures, smooth lighting, a limited palette,
  crisp full-resolution rendering. Readability first: enemies keep their mood colours. Nothing fancy
  (no post-processing). Merge static pieces (`render/merge.ts`) so detail doesn't cost draw calls.
- **Spend polish only where it changes how the game plays.** If a sound or animation would take real
  work to do well, keep it simple and stylised rather than detailed.
- Everything is generated in code: map (seeded), models (boxes/cylinders/low poly meshes), textures
  (small canvases, `render/textures.ts`), sounds (procedural). No asset files.
- No minimap and no spotting enemies. The compass strip marks only the extraction pad and teammates;
  enemies are found by looking and directional sound.
- Trusted clients, dev-run server, password to join. No anti-cheat, no matchmaking.

## Code

- npm workspaces: `packages/shared` (constants, map gen, damage rules, protocol; used by client and
  server), `packages/client` (Vite + Three.js + Rapier), `packages/server` (Node + ws).
- Server and shared run as TypeScript directly in Node (type stripping): only erasable syntax
  (no enums, no constructor parameter properties) and `.ts` extensions on relative imports.
  `npm run typecheck` enforces this.
- Tuning numbers live in `packages/shared/src/constants.ts` and `hitzones.ts`.
- Check: `npm run typecheck` and `npm run build`.
- Run: `npm run dev` (game server + Vite together; default password `changeme`). Headless checks join
  with `?test&join=localhost:5173&name=A&password=pw` (hides the click-to-play prompt; `MAP_SEED=2`
  on the server for a fixed map). `window.__game` exposes the player, rifle, enemies, remotes, net,
  `fire()`, `aimAt(x, y, z)` (allows for bullet drop), `setScoped()` and `setHoldBreath()`.
  Headless Chromium renders slowly and game time is capped per frame, so give waits generous margins.
- AI tuning can be checked without a browser: run `EnemyAi.step()` in Node against a generated map.
- Colours live in `packages/client/src/render/palette.ts`; every mesh uses `flat()` from there.
