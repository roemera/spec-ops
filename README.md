# Spec Ops

A browser co-op game: a small squad against AI, in the spirit of the winter sniper mission from
Call of Duty Spec Ops. Clean low poly look (think Superhot).

**Status:** early. You play a soldier with a scoped bolt-action rifle in a procedurally generated snowy
valley, from the insertion point to the extraction pad, past outposts held by enemy soldiers the server
controls. The match flow (lobby, kill limit, friendly fire) is still the old free-for-all one until
co-op missions arrive. There is no offline mode: run the server, even to play alone.

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
Ctrl+C stops both.

`npm run dev` and `npm run build` first run `scripts/ensure-native.mjs`, which installs Vite's native
binaries for your platform if npm skipped them (a known npm bug that shows up on Windows as
"Cannot find native binding").

## The map

Every map is generated from a seed (`packages/shared/src/mapgen.ts`). A seed gives a 640 m valley
walled in by mountains: rolling hills, rocky ridges, a frozen creek, thick pine forest broken by open
snowfields, boulders and fallen logs for cover. The squad inserts on one edge and has to reach the
extraction pad on the opposite one (about 450 m away), past two to four outposts (cabins, a
watchtower, sandbag walls) where the enemy will be. There is no marker: you get a bearing when you
spawn, and orange smoke rises over the pad.

The server picks a random seed when it starts, unless `mapSeed` in the config or `MAP_SEED` is set
(the seed is printed when the server starts).

## The enemy

The server runs the enemy soldiers (`packages/shared/src/ai.ts`, tuning in `constants.ts`): guards
at every outpost (one up the watchtower if there is one), a patrol round each outpost, and roamers
walking the route. Each one goes from patrolling to suspicious (stops, turns your way, then walks
over), to searching (goes where you were and looks around), to alert (shouts so the ones near come
too, takes a knee and shoots, and runs to where it last saw you if you break line of sight).

They see you sooner close up, standing, moving and in front of them, and much later prone, still,
far away, at the edge of their view or behind pine branches. They hear footsteps (sprinting most)
and every rifle shot within 260 m, and anyone who sees a friend go down comes looking. Their aim
gets better the longer they keep you in sight. You hear them: a "huh?" when one gets suspicious, a
shout when one spots you, and their boots in the snow. Health comes back 5 s after the last hit.

URL options: `?join=host:port&name=X&password=Y` joins directly, `?test` hides the click-to-play
panel (for headless checks).

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
  shared/   constants.ts (tuning), mapgen.ts (procedural map), rng.ts
  shared/   hitzones.ts (head/body/limb damage, Health), protocol.ts (messages, 36-byte soldier state,
            20-byte enemy state), ai.ts (the enemy), obstacles.ts (line of sight and walking round things)
  server/   main.ts (http + WebSocket on one port, AI tick), match.ts (lobby, countdown, spawns, kills,
            the enemy), config.ts
  client/   main.ts (loop: input, scope, breath, recoil, camera), sim/player.ts (character controller,
            stances), sim/rifle.ts (magazine, bolt, reload), sim/bullets.ts (ballistics),
            models/ (soldier, rifle), render/ (pipeline, palette), world.ts (terrain, instanced
            forest, objects, light, smoke), enemies.ts (the server's enemy, drawn and heard), remotes.ts (other players, interpolated), fx.ts (trails,
            puffs, shatter), audio.ts, net.ts, ui/hud.ts, ui/menu.ts
```

## Look

Clean low poly in the spirit of Superhot: flat-shaded geometry, a near-white snowy world, dark pines
and rocks for cover, black rifles, red enemies. Full resolution with antialiasing and soft sun
shadows; no textures. Colours live in `packages/client/src/render/palette.ts`.
