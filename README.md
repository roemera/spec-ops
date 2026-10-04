# Skeleton Crew

A browser tank game where you are the whole crew: driver, gunner, loader and lookout, one seat at a time.
Switching seats takes 0.6 seconds. Design doc: https://claude.ai/code/artifact/6ed43f7e-4ee7-4297-b6c4-ff1759a31cf7

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

The map is 400 m across, sized for a tight 1v1 (`MAP_SIZE` in `packages/shared/src/constants.ts`;
the generator scales its layout to it).

URL options: `?offline` skips the menu, `?join=host:port&name=X&password=Y` joins directly,
`?seed=123` picks the offline map, `?test` hides the click-to-play panel (for headless checks).

## Controls

| Seat | Controls |
| --- | --- |
| Any | 1 Driver, 2 Gunner, 3 Loader, 4 Lookout (0.6 s crawl, you control nothing meanwhile), hold Tab for the scoreboard |
| Driver | W/S throttle lever (R full, R 1/2, stop, 1/4, 1/2, full), A/D steering lever, X centre, Space brake (held) |
| Gunner | Mouse aims (turret follows at 24 deg/s), left click fires the cannon, hold middle button for the machine gun, right click 2x/4x zoom, Shift fine aim |
| Loader | Free cursor: drag a shell from the rack into the open breech, Space opens/closes the breech |
| Lookout | Mouse look, hold right click for 6x binoculars |

Levers stay where you leave them, so the tank keeps driving while you are in another seat.

Firing opens the breech and empties it. Someone (you) has to crawl to the loader seat, drag a shell in
and close the breech before the gun is ready again. The rack holds 6 and refills from storage (30)
at one shell every 4 s.

Damage: side hull hits kill in one shot, front and rear hull in two. If your crew is out as
lookout (a little man sticks out of the hatch), any shell hit on your tank kills you (shrapnel),
and so do 3 machine-gun bullets. The coaxial machine gun (unlimited, no recoil, bullets drop) can
only hurt that man, never a tank.

Dev key: F8 breaks a random part on your own tank, to see its effect.

## Sound

All sounds are generated in code (no files), low sample rate and bitcrushed. Outside sounds are
positional (HRTF): you can hear where an engine or explosion is. They arrive late with distance
(speed of sound) and are muffled while you are inside the tank; put your head out as lookout to
hear clearly. Click or press a key once to start audio (browser rule).

## Layout

```
packages/
  shared/   constants.ts (tuning), mapgen.ts (seeded map), rng.ts
  shared/   hitzones.ts (damage table, TankDamage), protocol.ts (messages, 52-byte tank state)
  server/   main.ts (http + WebSocket on one port), match.ts (lobby, countdown, spawns), config.ts
  client/   main.ts (loop), sim/tank.ts (physics), sim/gun.ts (breech, rack), sim/shells.ts (ballistics),
            seats/, ui/ (HUD, loader station, bitmap font), render/ (low-res pipeline, vertex wobble,
            textures), models/, world.ts, targets.ts (practice tanks), fx.ts, audio.ts,
            net.ts (WebSocket client), remotes.ts (other players, interpolated), ui/menu.ts (join, lobby)
```

## Status

- Milestone 1 (offline driving and seats): done.
- Milestone 2 (offline shooting and loading, directional sound): done. Four practice tanks sit ahead
  of the spawn; one drives in circles.
- Milestone 3 (server, password, lobby, other tanks moving and colliding): done.
- Milestone 4 (networked combat): done. The shooter's game reports hits, the server owns health,
  breaks parts, counts kills; 5 s respawn with 3 s spawn protection; a shell exploding within 3 m
  of a lookout's open hatch kills outright; first to the kill limit wins, 15 s results, then lobby.
- Milestone 5 (destructible objects in sync): done. Whoever breaks a fence, tree or wall tells the
  server; everyone sees it break, late joiners get the list, and everything stands again at the
  next match. (Lookout spotting was dropped: the lookout's job is just to look.)
- Milestone 6 (cursed extras): done. Gibberish crew voice lines with subtitles (firing, loading,
  crawling, getting hit, parts breaking, kills, dying), a jerky death camera circling your burning
  wreck, and a flashing, shaking results screen with an out-of-tune fanfare or a sad trombone.
