# Spec Ops

A browser co-op game: a small squad against AI, in the spirit of the winter sniper mission from
Call of Duty Spec Ops. Clean low poly look (think Superhot).

**Status:** early. You play a soldier with a scoped bolt-action rifle on the inherited Skeleton Crew map
(snowed over). Offline there is a practice range of red targets; online it is still the old free-for-all
match flow until the AI and co-op missions arrive.

Stack: TypeScript, Three.js, Rapier (WebAssembly physics), Vite. Everything (map, models, textures) is generated in code.

## Run

Needs Node 22.18+ (runs the server's TypeScript directly, no build step).

**Play with friends (one port to forward):**

```
npm install
copy server.config.example.json server.config.json   # then set the password (cp on Mac/Linux)
npm start                                            # builds the game, serves it + the WebSocket on :8080
```

Everyone opens `http://<host ip>:8080`, enters a name and the password, and clicks READY.
The match starts when everyone (2+) is ready, or when the host types `start` in the server console
(works solo); any player can also press START NOW in the lobby. Forward TCP port 8080 on the host's router for players outside your network.
`PORT`, `PASSWORD`, `MAP_SEED` and `KILL_LIMIT` environment variables override the config file.

**Developing:** `npm run dev` starts the game server (port 8080) and the Vite dev server together,
then open http://localhost:5173 (Vite forwards the game connection to 8080). Without a
server.config.json the password is `changeme`. Press START NOW in the lobby (or type `start` in that terminal) to begin, even solo;
Ctrl+C stops both. PRACTICE OFFLINE on the join screen gives the single-player range with targets.

`npm run dev` and `npm run build` first run `scripts/ensure-native.mjs`, which installs Vite's native
binaries for your platform if npm skipped them (a known npm bug that shows up on Windows as
"Cannot find native binding").

The map is 400 m across (`MAP_SIZE` in `packages/shared/src/constants.ts`; the generator scales its
layout to it).

URL options: `?offline` skips the menu, `?join=host:port&name=X&password=Y` joins directly,
`?seed=123` picks the offline map, `?test` hides the click-to-play panel (for headless checks).

## Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Shift | Sprint; while scoped, hold your breath (4 s, then you are winded and sway more) |
| Space | Jump; from crouch or prone, stand up |
| C / Z | Crouch / prone (press again to stand) |
| Right mouse (hold) | Scope (12x). Sway is smallest prone, largest standing or moving |
| Left mouse | Fire. Work the bolt after every shot (1.1 s) |
| R | Reload (5-round magazine, 20 spare) |
| Tab | Scores (online) |

The rifle fires real bullets at 600 m/s with drop. The scope is zeroed at 100 m; the marks below the
centre show where to hold for 200, 300 and 400 m. Moving targets need a lead.

Damage: a head or body hit kills, two limb hits kill.

## Sound

All sounds are generated in code (no files). Shots, impacts and footsteps are positional (HRTF) and
arrive late with distance (speed of sound): you can hear where a shot came from and roughly how far.
Footsteps are loud standing, quiet crouched and nearly silent prone. Click or press a key once to
start audio (browser rule).

## Layout

```
packages/
  shared/   constants.ts (tuning), mapgen.ts (seeded map), rng.ts
  shared/   hitzones.ts (head/body/limb damage, Health), protocol.ts (messages, 36-byte soldier state)
  server/   main.ts (http + WebSocket on one port), match.ts (lobby, countdown, spawns, kills), config.ts
  client/   main.ts (loop: input, scope, breath, recoil, camera), sim/player.ts (character controller,
            stances), sim/rifle.ts (magazine, bolt, reload), sim/bullets.ts (ballistics),
            models/ (soldier, rifle), render/ (pipeline, palette), world.ts (map, light, shadows),
            targets.ts (practice range), remotes.ts (other players, interpolated), fx.ts (trails,
            puffs, shatter), audio.ts, net.ts, ui/hud.ts, ui/menu.ts
```

## Look

Clean low poly in the spirit of Superhot: flat-shaded geometry, a near-white snowy world, dark pines
and rocks for cover, black rifles, red enemies. Full resolution with antialiasing and soft sun
shadows; no textures. Colours live in `packages/client/src/render/palette.ts`.
