# Skeleton Crew

Browser multiplayer tank game: one player is the whole crew (driver, gunner, loader, lookout).
Design doc: https://claude.ai/code/artifact/6ed43f7e-4ee7-4297-b6c4-ff1759a31cf7

## Direction

- **Cursed beats polished.** If a sound or animation would take real work to do well, do it badly on
  purpose: stutter, stretch, wrong pitch, noise voices. Matches the Cruelty Squad look, saves time,
  keeps the game simple. Spend polish only where it changes how the game plays.
- Everything is generated in code: map (seeded), models (boxes/cylinders), textures (tiny canvases),
  sounds (procedural, bitcrushed). No asset files.
- No minimap and no spotting markers. Information comes from looking (lookout seat) and directional sound.
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
  panel). `window.__game` exposes the tank, gun, targets, `fire()` and `aimAt()` for scripted tests.
