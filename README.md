# Spec Ops

A browser co-op game: a small squad against AI, in the spirit of the winter sniper mission from
Call of Duty Spec Ops. Low poly with simple textures (think Half-Life 1).

**Status:** playable end to end. Up to 8 players form a squad with scoped bolt-action rifles and have
to cross a procedurally generated snowy valley, from the insertion point to the extraction pad, past
outposts held by enemy soldiers the server controls. Every mission is a new map. There is no offline
mode: run the server, even to play alone.

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
The mission starts when everyone is ready, or when anyone presses START NOW (or the host types `start`
in the server console). Forward TCP port 8080 on the host's router for players outside your network.
`PORT`, `PASSWORD` and `MAP_SEED` environment variables override the config file.

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
watchtower, sandbag walls) where the enemy will be. You get a bearing when you spawn, orange smoke
rises over the pad, and the compass at the top of the screen marks it (orange diamond, with the
distance). Teammates show on the compass too, as triangles with their name and distance, red while
they are down. Enemies are never marked.

Every mission gets a new random map, unless `mapSeed` in the config or `MAP_SEED` fixes one. The
seed is printed when a mission starts. The first 40% of the route is quiet: no outposts or patrols
near the insertion point.

## Weather

Each mission's seed also sets its weather: where the wind blows from and how hard (it gusts and
veers a little over time), and how heavily it snows. It is the same for everyone.

- **Wind pushes bullets.** A 5 m/s crosswind moves a shot about 0.3 m at 200 m, 0.6 m at 300 m and
  1.1 m at 400 m; a gale doubles that. Hold into the wind at range.
- There is no wind gauge. Read it from the snow drifting past (it moves with the wind), the
  extraction smoke leaning over, the wind's sound (it comes from upwind and gets louder), and the
  briefing when you spawn ("WIND STRONG FROM THE NORTH").
- **Heavy snow shortens sight for everyone:** the fog closes in and the enemy sees less far, by
  up to 45%.

## The mission

The whole squad starts at the insertion point. The mission is won when everyone still standing is
on the extraction pad (nobody may be left down), and lost when nobody is standing. There is no
friendly fire and no respawning:

- At 0 health you go **down** and bleed out over 30 s. A teammate who holds **E** next to you for
  3 s gets you up with 50 health (they can't move or shoot meanwhile).
- If you bleed out you are **out** until the next mission.
- While down or out, and on the squad and mission-over screens, there is a quote, as old Call of Duty did: one of about 100
  real Donald Trump quotes, mostly about war and soldiers, with the date and where it was said
  (`packages/client/src/quotes.ts`, each checked against the Truth Social archive or news reports).
- Health does not come back by itself. Medkits (+40) and a teammate's revive are the only way back.
- Ammo runs out: you start with a full magazine and 15 spare rounds (carry up to 25). Each base has an
  ammo box (15 rounds) and a medkit by a hut door; every enemy you kill drops 6 rounds, and three in
  five carry a medkit. Walk over one to take it; whoever gets there first has it.

After the results (time, kills, revives, downs, accuracy) everyone goes back to the squad screen with
a new map. Each page reloads itself to build the new map and rejoins on its own.

## The enemy

The server runs the enemy soldiers (`packages/shared/src/ai.ts`, tuning in `constants.ts`), usually
30 to 40 of them: three to five guards at every outpost (almost always one up the watchtower), one or
two patrols round each outpost, roamers walking the route, and sentry pairs posted beside it watching
back the way you come. Each one goes from patrolling to suspicious (stops, turns your way, then walks
over), to searching (goes where you were and looks around), to alert (shouts so the ones near come
too, takes a knee and shoots, and runs to where it last saw you if you break line of sight).

They see you sooner close up, standing, moving and in front of them, and much later prone, still,
far away, at the edge of their view or behind pine branches. They hear footsteps (sprinting most)
and every rifle shot within 260 m. Kill one and anyone within 45 m who sees it (or is standing
right beside the body) goes on alert at once, though they need a moment to work out where the shot
came from. Their aim gets better the longer they keep you in sight, and two body hits put you down.

Enemies wear their mood: **yellow** on patrol, **orange** when suspicious or searching, **red** once
they have spotted you. Every enemy rifle has a **laser sight** in the same colour, so you can see
where each one is looking: faint while they patrol, sweeping slowly back and forth while they are
suspicious or searching, bold once alert. While they aim at you the laser wavers and then holds
steady: a steady laser means the next shot will probably hit. Lasers stop in pine branches (bullets
don't), so a crown between you hides the beam. You hear them: a "huh?" when one gets suspicious, a
shout when one spots you, and their boots in the snow.

When you are hit the screen flashes red and you hear the snap, the thump and your own grunt; the
edges stay red while you are badly hurt (and stay that way until you find a medkit). A headshot on an
enemy rings like struck steel.

URL options: `?join=host:port&name=X&password=Y` joins directly, `?test` hides the click-to-play
panel (for headless checks).

## Controls

| Key | Action |
| --- | --- |
| WASD | Move |
| Shift | Sprint (gets you up from crouch or prone); while scoped, hold your breath (4 s, then you are winded and sway more) |
| Space | Jump; from crouch or prone, stand up |
| C / Z | Crouch / prone (press again to stand). While sprinting: slide on your knees / dive onto your belly |
| Right mouse (hold) | Scope (12x). Sway is smallest prone, largest standing or moving |
| Left mouse | Fire. Work the bolt after every shot (1.1 s) |
| R | Reload (5-round magazine, from your spare rounds). Press R again while the needle is in the red to slap it home at once; near it, a quick finish; anywhere else it jams (+1.2 s) |
| E (hold) | Revive a downed teammate next to you |
| Tab | Scores |

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
  shared/   constants.ts (tuning), mapgen.ts (procedural map), weather.ts (wind, snow), rng.ts
  shared/   hitzones.ts (head/body/limb damage, Health), protocol.ts (messages, 36-byte soldier state,
            20-byte enemy state), ai.ts (the enemy), obstacles.ts (line of sight and walking round things)
  server/   main.ts (http + WebSocket on one port, AI tick), match.ts (lobby, countdown, the mission: down,
            revive, extraction, results, new map; the enemy), config.ts
  client/   main.ts (loop: input, scope, breath, recoil, camera), sim/player.ts (character controller,
            stances), sim/rifle.ts (magazine, bolt, reload), sim/bullets.ts (ballistics),
            models/ (soldier, rifle), render/ (pipeline, palette, snow), world.ts (terrain, instanced
            forest, objects, light, smoke), render/lasers.ts (enemy laser sights), enemies.ts (the server's enemy, drawn and heard), remotes.ts (other players, interpolated), fx.ts (trails,
            puffs, shatter), audio.ts, net.ts, ui/hud.ts, ui/menu.ts
```

## Look

Low poly with simple textures, heading toward Half-Life 1: smooth-lit snowy ground, textured rock,
bark, pine needles, planks and tin roofs, soldiers in helmets, vests and packs, a wooden-stocked rifle
with gloved hands in first person. Every texture is drawn in code into a small canvas at startup
(`render/textures.ts`); most are near-white detail multiplied by a palette colour, so the colours in
`render/palette.ts` (and the enemies' mood colours) still decide the look. Detailed models are merged
into one mesh per material (`render/merge.ts`) to keep draw calls down. Full resolution with
antialiasing and soft sun shadows.

Low junipers grow in clumps along the edges of the woods and out in the open: soft cover. Crouch or
lie behind one and the enemy sees only a glimpse of you (as through pine branches); bullets go
straight through, and an enemy laser stops in it.

The snow keeps a record: everyone standing or crouching leaves boot prints (yours, your squad's and
the enemy's: you can read where a patrol went), which fill in with snow after a couple of minutes
(sooner in heavy snow). The killed fall the way the shot pushed them and stay where they dropped, in
a spreading pool of blood; a downed teammate lies curled on one side, bleeding, until someone gets
them up. Hut windows glow: someone's home.
