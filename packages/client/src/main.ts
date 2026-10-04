import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  BULLET_SPEED, BREATH_RECOVER, ENEMY_ID_BASE, GRAVITY, HIP_SPREAD, HOLD_BREATH, Health, PHYSICS_HZ, RECOIL_PITCH,
  EXTRACT_RADIUS, RECOIL_SETTLE, REVIVE_RANGE, REVIVE_TIME, SCOPE_FOV, SCOPE_IN_TIME, SPAWN_PROTECTION, STATE_HZ, SWAY,
  ZONE_LABEL, generateMap, weatherFor, windAt, type Life,
  type Phase, type Score, type ServerMsg, type Stance,
} from '@spec-ops/shared';
import { Pipeline } from './render/pipeline';
import { PAL } from './render/palette';
import { World } from './world';
import { Snowfall } from './render/snow';
import { Lasers } from './render/lasers';
import { PlayerSim, type MoveInput } from './sim/player';
import { Rifle } from './sim/rifle';
import { Bullets, type Bullet, type SoldierHit } from './sim/bullets';
import { buildRifle } from './models/rifle';
import { Input } from './input';
import { Hud, HUD_COLORS } from './ui/hud';
import { Fx } from './fx';
import { Audio } from './audio';
import { Enemies } from './enemies';
import { Remotes } from './remotes';
import { Net } from './net';
import { Menu, rejoin, type JoinChoice } from './ui/menu';

const params = new URLSearchParams(location.search);
// ?join=host&name=X&password=Y joins a server directly.
// ?test hides the click-to-play panel (headless browsers cannot lock the pointer).
const TEST_MODE = params.has('test');
const STEP = 1 / PHYSICS_HZ;

const BASE_FOV = 70; // deg vertical
const ADS_FOV = 55; // deg while raising the scope, before it snaps to the scope view
const MOUSE_SENS = 0.0022; // rad per pixel at BASE_FOV; scales with fov so the scope isn't twitchy
const MESSAGE_TIME = 2.5; // s
const BRIEFING_TIME = 7; // s the extraction bearing shows after spawning
const STRIDE = 0.75; // m per footstep
const STANCE_STEADY: Record<Stance, number> = { stand: 1, crouch: 0.6, prone: 0.25 }; // sway and spread
const ZERO_RANGE = 100; // m: the scope is zeroed here (bullets cross the crosshair at this range)
const drop = (m: number) => (GRAVITY * m) / (2 * BULLET_SPEED * BULLET_SPEED); // rad, small angle

// First-person rifle, drawn with its own camera at a fixed fov: where it sits at the hip and
// when raised to the eye (view space).
const VM_FOV = 58;
const HIP = new THREE.Vector3(0.15, -0.15, -0.58);
const ADS = new THREE.Vector3(0, -0.085, -0.36);

type Welcome = Extract<ServerMsg, { t: 'welcome' }>;

async function start() {
  await RAPIER.init();
  const menu = new Menu();
  let error = '';
  for (;;) {
    // Straight in after a mission (the page reloaded for the new map), or from the URL, or ask.
    const again = error ? null : rejoin.take();
    const choice = params.has('join')
      ? { server: params.get('join')!, name: params.get('name') ?? 'TEST', password: params.get('password') ?? '' }
      : again ?? (await menu.join(error));
    try {
      const { net, welcome } = await Net.connect(choice.server, choice.name, choice.password);
      return runGame(menu, net, welcome, choice);
    } catch (e) {
      error = String(e).toUpperCase();
      if (params.has('join')) params.delete('join'); // fall back to the menu
    }
  }
}

/** Eight-way compass name for a direction on the map (north is -z). */
function bearingName(x: number, z: number) {
  const deg = ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
  return ['NORTH', 'NORTHEAST', 'EAST', 'SOUTHEAST', 'SOUTH', 'SOUTHWEST', 'WEST', 'NORTHWEST'][Math.round(deg / 45) % 8];
}

function runGame(menu: Menu, net: Net, welcome: Welcome, choice: JoinChoice) {
  const seed = welcome.seed;
  const viewCanvas = document.getElementById('view') as HTMLCanvasElement;
  const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;

  const pipeline = new Pipeline(viewCanvas);
  const hud = new Hud(hudCanvas);
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 16 / 9, 0.05, 1500);
  const vmCamera = new THREE.PerspectiveCamera(VM_FOV, 16 / 9, 0.02, 10); // the rifle's camera; stays at the origin
  const layout = () => {
    camera.aspect = vmCamera.aspect = pipeline.resize(innerWidth, innerHeight);
    camera.updateProjectionMatrix();
    vmCamera.updateProjectionMatrix();
    hud.resize(innerWidth, innerHeight);
  };
  layout();
  addEventListener('resize', layout);

  const physics = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  physics.timestep = STEP;
  const map = generateMap(seed);
  // This mission's weather (from the seed, like the map): wind gusts by mission time, the same on every client.
  const weather = weatherFor(seed);
  let missionClock = welcome.time; // s into the mission
  const calmOverride = { on: false }; // tests: no wind
  const wind = () => (calmOverride.on ? { x: 0, z: 0 } : windAt(weather, missionClock));
  const world = new World(map, physics, weather);
  const snow = new Snowfall(world.scene, weather.snow);

  const spawn = map.spawns[welcome.spawn];
  const player = new PlayerSim(physics, spawn, map.heightAt(spawn.x, spawn.z));
  const rifle = new Rifle();

  // The first-person rifle lives in its own scene, drawn over the world.
  const overlay = new THREE.Scene();
  overlay.add(new THREE.HemisphereLight(0xffffff, PAL.snowShade, 1.6));
  const vmSun = new THREE.DirectionalLight(0xffffff, 1.6);
  vmSun.position.set(0.45, 0.8, 0.3);
  overlay.add(vmSun);
  const vm = buildRifle();
  overlay.add(vm.root);
  /** The viewmodel muzzle, in world space (for trails): its view-space position, carried by the real camera. */
  const muzzleWorld = () => camera.localToWorld(vm.muzzle.getWorldPosition(new THREE.Vector3()));

  const fx = new Fx(world.scene, map.heightAt);
  const audio = new Audio();
  // The wind's sound comes from upwind, louder the harder it blows.
  const windSound = audio.loop('wind', new THREE.Vector3());
  const remotes = new Remotes(world.scene, audio);
  const enemies = new Enemies(world.scene, audio, fx);
  const lasers = new Lasers(world.scene, physics);
  let phase: Phase = welcome.phase;
  const playing = () => phase === 'live';

  // The server owns health; we mirror ours (healing at the same rate) and show what it tells us.
  const health = new Health();
  // Your life this mission: up, down (bleeding out until a teammate revives you) or out.
  let life: Life = 'up';
  let down: { by: string; zone: string; until: number } | null = null;
  let protectedUntil = 0, hurtAt = -10;
  let scores: Score[] = [];
  const names = new Map<number, string>();
  const nameOf = (id: number) => (id >= ENEMY_ID_BASE ? 'THE ENEMY' : (names.get(id) ?? `PLAYER ${id}`));
  const zeroScores = (players: Array<{ id: number; name: string }>) =>
    players.map(({ id, name }) => ({ id, name, kills: 0, downs: 0, revives: 0, shots: 0, hits: 0 }));
  for (const p of welcome.players) names.set(p.id, p.name);
  scores = zeroScores(welcome.players);
  if (phase === 'live') protectedUntil = SPAWN_PROTECTION; // joined mid-match
  /** You can move and shoot: mission on and you're up. */
  const controlling = () => playing() && life === 'up';
  const arr = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

  let time = 0;
  let message: { text: string; color: string; until: number } | null = null;
  const say = (text: string, color: string = HUD_COLORS.ink, seconds = MESSAGE_TIME) => (message = { text, color, until: time + seconds });

  // The mission: get from the insertion point to the extraction pad. No marker: a bearing at the
  // start, then the orange smoke over the pad.
  function brief() {
    const p = player.pos, e = map.extract;
    const dist = Math.round(Math.hypot(e.x - p.x, e.z - p.z) / 10) * 10;
    const strength = weather.windSpeed < 2.5 ? 'LIGHT' : weather.windSpeed < 5.5 ? 'STEADY' : 'STRONG';
    const fromBearing = (weather.windFrom * 180) / Math.PI;
    const from = ['NORTH', 'NORTHEAST', 'EAST', 'SOUTHEAST', 'SOUTH', 'SOUTHWEST', 'WEST', 'NORTHWEST'][Math.round(fromBearing / 45) % 8];
    say(`EXTRACTION  ${bearingName(e.x - p.x, e.z - p.z)}  ${dist} M  ·  FOLLOW THE ORANGE SMOKE  ·  WIND ${strength} FROM THE ${from}`, HUD_COLORS.signal, BRIEFING_TIME);
  }
  /** The server ends the mission when everyone standing is on the pad; until then, say who we wait for. */
  function onThePad() {
    if (!controlling() || Math.hypot(player.pos.x - map.extract.x, player.pos.z - map.extract.z) > EXTRACT_RADIUS) return;
    const away = [...remotes.byId.values()].filter((r) => r.life === 'down' || (r.life === 'up' && r.model.root.position.distanceTo(new THREE.Vector3(map.extract.x, r.model.root.position.y, map.extract.z)) > EXTRACT_RADIUS));
    if (away.length) say(`ON THE PAD  ·  WAITING FOR ${away.map((r) => nameOf(r.id)).join(', ')}`, HUD_COLORS.signal, 0.3);
  }
  let hitMarker: { at: number; kill: boolean } | null = null;
  const mark = (kill: boolean) => (hitMarker = { at: time, kill });

  // --- Shooting ---

  /** Targets are enemy ids (from ENEMY_ID_BASE). */
  const bullets = new Bullets(
    physics,
    (origin, dir, len): SoldierHit | null => {
      // Only the enemy: bullets pass through your squad (no friendly fire).
      const e = enemies.hitTest(origin, dir, len);
      if (e) return { t: e.t, target: e.enemy.id, zone: e.zone };
      return null;
    },
    (b, hit, point, dir) => onHitSoldier(b, hit, point, dir),
    (b, point, normal) => {
      fx.endTrail(b.id, point);
      fx.impact(point, normal, point.y > map.heightAt(point.x, point.z) + 0.3 ? PAL.rock : PAL.snow);
      audio.play('impact', { pos: point, volume: 0.6 });
    },
    wind,
  );

  let lastHit: { target: number; zone: string; range: number } | null = null;
  function onHitSoldier(b: Bullet, hit: SoldierHit, point: THREE.Vector3, dir: THREE.Vector3) {
    fx.endTrail(b.id, point);
    audio.play('hit', { pos: point });
    // A wound here; the shooter reports it and the server decides what it did.
    fx.wound(point, dir, PAL.enemy);
    if (b.visual) return;
    net.sendHit(b.id, hit.target, hit.zone, arr(point), arr(dir));
    lastHit = { target: hit.target, zone: hit.zone, range: Math.round(b.start.distanceTo(point)) };
    mark(false);
  }

  // Scope, breath, sway, recoil.
  let scopeT = 0; // 0 at the hip .. 1 through the scope
  let scopeOverride: boolean | null = null; // tests: headless browsers can't hold the right button
  let breath = 1, winded = false, holding = false;
  let swayAmp = 0;
  const sway = { yaw: 0, pitch: 0 };
  let kick = 0; // first-person rifle kick, decays
  let recoil = 0; // rad the view is kicked up, settles back to 0
  let shotsFired = 0;
  const scoped = () => scopeT >= 1;

  function spreadNow() {
    const moving = player.speed > 0.5 ? 1.6 : 1;
    return HIP_SPREAD * STANCE_STEADY[player.stance] * moving * (1 - scopeT);
  }

  function fire() {
    if (!controlling()) return;
    if (rifle.mag === 0) {
      if (rifle.reload()) audio.play('reload');
      else if (!rifle.reloading) {
        audio.play('dry');
        say('NO AMMO', HUD_COLORS.red);
      }
      return;
    }
    if (!rifle.fire()) return; // working the bolt or reloading
    const origin = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    // Hip fire: somewhere in a cone. Scoped: dead on (the sway is already in the camera).
    const spread = spreadNow();
    if (spread > 0) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
      const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
      const up = new THREE.Vector3().crossVectors(right, dir);
      dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();
    }
    dir.y += drop(ZERO_RANGE); // zeroed: aim a hair high so the bullet crosses the crosshair at 100 m
    dir.normalize();
    // Inherit your horizontal movement (vertical speed on the ground is just the controller pressing down).
    const vel = dir.clone().multiplyScalar(BULLET_SPEED).add(new THREE.Vector3(player.vel.x, 0, player.vel.z));
    // The trail starts at the muzzle you see (at the hip) or just under your eye (scoped).
    const start = scoped() ? origin.clone().addScaledVector(dir, 0.6).add(new THREE.Vector3(0, -0.06, 0)) : muzzleWorld();
    const b = bullets.spawn(start, origin, vel, player.body);
    net.sendFire(b.id, arr(origin), arr(vel));
    if (!scoped()) fx.muzzleFlash(vm.muzzle.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0, 0, -1), overlay);
    audio.play('shot');
    if (rifle.mag > 0) setTimeout(() => audio.play('bolt', { volume: 0.6 }), 180);
    else if (rifle.reload()) setTimeout(() => audio.play('reload'), 300);
    recoil += RECOIL_PITCH * (player.stance === 'prone' ? 0.5 : 1);
    kick = 1;
    shotsFired++;
  }

  const input = new Input(viewCanvas);
  addEventListener('mousedown', () => {
    audio.unlock();
    if (controlling()) input.lock();
  });

  // --- Network ---
  let sendTimer = 0;
  {
    const showLobby = (players: Parameters<Menu['lobby']>[0], countdown: number) =>
      menu.lobby(players, phase, countdown, net.id, (ready) => net.setReady(ready), () => net.startMatch());
    if (phase !== 'live') showLobby(welcome.players, 0);
    else menu.hide();
    for (const p of welcome.players) if (p.id !== net.id) remotes.setLife(p.id, p.life);
    net.onMessage = (msg) => {
      if (msg.t === 'lobby') {
        // A new mission has a new map: rejoin from a fresh page to build it.
        if (msg.seed !== seed && msg.phase === 'lobby') {
          rejoin.save(choice);
          location.reload();
          return;
        }
        for (const p of msg.players) {
          names.set(p.id, p.name);
          if (p.id !== net.id) remotes.setLife(p.id, p.life);
        }
        if (msg.phase === 'live' && phase !== 'live') {
          // Mission start: fresh scores, everyone up.
          scores = zeroScores(msg.players);
          enemies.clear(); // the server stood them all up again
        }
        phase = msg.phase;
        if (phase === 'live') menu.hide();
        else if (phase !== 'results') {
          input.unlock();
          showLobby(msg.players, msg.countdown);
        }
      } else if (msg.t === 'spawn') {
        life = 'up';
        down = null;
        health.reset();
        protectedUntil = time + SPAWN_PROTECTION;
        const sp = map.spawns[msg.spawn];
        player.teleport(sp, map.heightAt(sp.x, sp.z));
        rifle.reset();
        missionClock = 0;
        brief();
      } else if (msg.t === 'left') {
        remotes.remove(msg.id);
      } else if (msg.t === 'fire') {
        // Someone else's shot (a player's or the enemy's): draw it and let it land here.
        // Players report their own hits; the server already decided the enemy's.
        const pos = new THREE.Vector3(...msg.pos), vel = new THREE.Vector3(...msg.vel);
        const dir = vel.clone().normalize();
        bullets.spawn(pos.clone().addScaledVector(dir, 0.9), pos, vel, undefined, true);
        fx.muzzleFlash(pos.clone().addScaledVector(dir, 0.9), dir);
        audio.play('shot', { pos, rate: msg.from >= ENEMY_ID_BASE ? 1.12 : 1 });
      } else if (msg.t === 'damage') {
        if (msg.target === net.id) {
          health.health = msg.health;
          health.sinceHit = 0;
          hurtAt = time;
          audio.play('hit', { volume: 1.3 });
          if (msg.health > 0) say(`HIT BY ${nameOf(msg.attacker)}  ·  ${ZONE_LABEL[msg.zone]}`, HUD_COLORS.red);
        } else if (msg.attacker === net.id && msg.target < ENEMY_ID_BASE) say(`HIT ${nameOf(msg.target)}  ·  ${ZONE_LABEL[msg.zone]}`);
      } else if (msg.t === 'enemyDown') {
        scores = msg.scores;
        enemies.kill(msg.id, new THREE.Vector3(...msg.dir));
        if (msg.killer === net.id) {
          mark(true);
          const range = lastHit?.target === msg.id ? `  ·  ${lastHit.range} M` : '';
          say(`${ZONE_LABEL[msg.zone]}${range}`, HUD_COLORS.red);
        }
      } else if (msg.t === 'down') {
        scores = msg.scores;
        if (msg.id === net.id) {
          life = 'down';
          down = { by: nameOf(msg.by), zone: ZONE_LABEL[msg.zone], until: time + msg.bleedOut };
          health.health = 0;
          scopeT = 0;
          player.setStance('prone');
        } else {
          remotes.setLife(msg.id, 'down');
          say(`${nameOf(msg.id)} IS DOWN  ·  HOLD E NEXT TO THEM`, HUD_COLORS.red, 4);
        }
      } else if (msg.t === 'revived') {
        scores = msg.scores;
        if (msg.id === net.id) {
          life = 'up';
          down = null;
          health.health = msg.health;
          health.sinceHit = 0;
          say(`${nameOf(msg.by)} GOT YOU UP`);
        } else {
          remotes.setLife(msg.id, 'up');
          say(msg.by === net.id ? `YOU GOT ${nameOf(msg.id)} UP` : `${nameOf(msg.by)} GOT ${nameOf(msg.id)} UP`);
        }
      } else if (msg.t === 'bledOut') {
        scores = msg.scores;
        if (msg.id === net.id) life = 'dead';
        else {
          const r = remotes.byId.get(msg.id);
          if (r && r.life !== 'dead') {
            fx.shatter(r.model.parts, new THREE.Vector3(), PAL.friend);
            audio.play('shatter', { pos: r.model.root.position.clone() });
          }
          remotes.setLife(msg.id, 'dead');
          say(`${nameOf(msg.id)} BLED OUT`, HUD_COLORS.red);
        }
      } else if (msg.t === 'results') {
        scores = msg.scores;
        input.unlock();
        menu.results(msg.success, msg.time, msg.scores, msg.seconds, net.id);
        audio.jingle(msg.success);
      }
    };
    net.onState = (st) => remotes.receive(st, time);
    net.onEnemies = (list) => enemies.receive(list, time);
    net.onClose = (reason) => {
      input.unlock();
      menu.join(`DISCONNECTED: ${reason.toUpperCase()}`).then(() => location.reload());
    };
  }

  if (phase === 'live') brief();

  function sendState(dt: number) {
    if (!playing()) return;
    sendTimer += dt;
    if (sendTimer < 1 / STATE_HZ) return;
    sendTimer %= 1 / STATE_HZ;
    net.sendState({
      id: 0,
      stance: player.stance,
      scoped: scoped(),
      pos: arr(player.pos),
      vel: arr(player.vel),
      yaw: player.yaw,
      pitch: player.pitch,
    });
  }

  // --- Input ---
  const move: MoveInput = { forward: 0, right: 0, sprint: false, jump: false, scoped: false };
  let wantScope = false;

  /** The downed teammate within reach, if any, and how far along getting them up you are. */
  let reviving: { id: number; progress: number } | null = null;
  let reviveSentAt = -10;
  function updateRevive(dt: number) {
    let near: { id: number; d: number } | null = null;
    for (const r of remotes.byId.values()) {
      if (r.life !== 'down') continue;
      const d = Math.hypot(r.model.root.position.x - player.pos.x, r.model.root.position.z - player.pos.z);
      if (d <= REVIVE_RANGE && (!near || d < near.d)) near = { id: r.id, d };
    }
    if (!near || !controlling()) return void (reviving = null);
    if (reviving?.id !== near.id) reviving = { id: near.id, progress: 0 };
    // Hold E: you crouch over them and can't move or shoot until it's done.
    if ((input.isHeld('KeyE') || reviveOverride) && time - reviveSentAt > 1) {
      reviving.progress = Math.min(1, reviving.progress + dt / REVIVE_TIME);
      move.forward = move.right = 0;
      move.sprint = move.jump = false;
      if (reviving.progress >= 1) {
        net.sendRevive(near.id);
        reviveSentAt = time;
        reviving.progress = 0;
      }
    } else reviving.progress = 0;
  }
  let reviveOverride = false;

  function handleInput() {
    move.forward = move.right = 0;
    move.jump = move.sprint = false;
    wantScope = false;
    if (!controlling()) {
      // Lobby/countdown/down/out: you can only look around.
      input.takePresses();
      input.takeClicks();
      const [dx, dy] = input.takeMouse();
      if (playing()) {
        player.yaw -= dx * MOUSE_SENS;
        player.pitch = Math.max(-1.2, Math.min(1.2, player.pitch - dy * MOUSE_SENS));
      }
      return;
    }
    for (const code of input.takePresses()) {
      audio.unlock();
      // C: crouch (or up from prone to a crouch). Z: prone, or back up. Space: jump, or stand up.
      if (code === 'KeyC') player.setStance(player.stance === 'crouch' ? 'stand' : 'crouch');
      if (code === 'KeyZ') player.setStance(player.stance === 'prone' ? 'stand' : 'prone') || player.setStance('crouch');
      if (code === 'Space') {
        if (player.stance === 'stand') move.jump = true;
        else player.setStance('stand');
      }
      if (code === 'KeyR' && rifle.reload()) audio.play('reload');
    }
    const shift = input.isHeld('ShiftLeft') || input.isHeld('ShiftRight');
    move.forward = (input.isHeld('KeyW') ? 1 : 0) - (input.isHeld('KeyS') ? 1 : 0);
    move.right = (input.isHeld('KeyD') ? 1 : 0) - (input.isHeld('KeyA') ? 1 : 0);
    wantScope = scopeOverride ?? (input.locked && input.mouseButtons.has(2));
    move.sprint = shift && !wantScope;
    move.scoped = wantScope;

    const clicks = input.takeClicks();
    if (clicks.length) audio.unlock();
    const [dx, dy] = input.takeMouse();
    const sens = MOUSE_SENS * (camera.fov / BASE_FOV);
    player.yaw -= dx * sens;
    player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - dy * sens));
    // A click that captures the mouse is not also a shot. Not while getting a teammate up.
    if (clicks.some((c) => c.button === 0 && c.locked) && !reviving?.progress) fire();
  }

  /** Scope in/out, held breath, and the drift it steadies. */
  function updateAim(dt: number) {
    const sprinting = move.sprint && player.speed > 4;
    const canScope = wantScope && !rifle.reloading && !sprinting && controlling();
    scopeT = Math.max(0, Math.min(1, scopeT + (canScope ? dt : -dt * 1.5) / SCOPE_IN_TIME));

    const shift = input.isHeld('ShiftLeft') || input.isHeld('ShiftRight') || breathOverride;
    holding = scoped() && shift && !winded && breath > 0;
    if (holding) {
      breath = Math.max(0, breath - dt / HOLD_BREATH);
      if (breath === 0) winded = true;
    } else {
      breath = Math.min(1, breath + dt / BREATH_RECOVER);
      if (winded && breath > 0.6) winded = false;
    }
    // Sway amplitude eases between states so it never jumps.
    const moving = player.speed > 0.3 ? 2 : 1;
    const target = SWAY * STANCE_STEADY[player.stance] * moving * (holding ? 0.06 : winded ? 2.2 : 1);
    swayAmp += (target - swayAmp) * (1 - Math.exp(-dt * 4));
    const t = time;
    sway.yaw = scopeT * swayAmp * (Math.sin(t * 0.63) * 0.65 + Math.sin(t * 1.71 + 1) * 0.35);
    sway.pitch = scopeT * swayAmp * (Math.sin(t * 1.07 + 2) * 0.6 + Math.sin(t * 2.29) * 0.25);
    recoil *= Math.exp((-dt * 3) / RECOIL_SETTLE);
  }
  let breathOverride = false;

  // --- Frame ---
  const feet = new THREE.Vector3(), euler = new THREE.Euler(0, 0, 0, 'YXZ');
  let acc = 0, last = performance.now() / 1000, nextStep = STRIDE;

  function placeCamera(alpha: number) {
    player.feet(alpha, feet);
    if (life !== 'up') {
      // Down in the snow, rolled on one side, looking along the ground.
      camera.position.set(feet.x, feet.y + 0.3, feet.z);
      euler.set(player.pitch * 0.5, player.yaw, 0.5);
    } else {
      camera.position.set(feet.x, feet.y + player.eye, feet.z);
      euler.set(player.pitch + sway.pitch + recoil, player.yaw + sway.yaw, 0);
    }
    camera.quaternion.setFromEuler(euler);
    const fov = scoped() ? SCOPE_FOV : BASE_FOV + (ADS_FOV - BASE_FOV) * scopeT;
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }

  /** The rifle in your hands: hip to eye with the scope, bob while walking, kick, bolt and reload moves. */
  function placeViewmodel(dt: number) {
    vm.root.visible = !scoped() && life === 'up';
    const bob = player.grounded ? Math.min(1, player.speed / 3) : 0;
    const phase = (player.distance / STRIDE) * Math.PI;
    vm.root.position.lerpVectors(HIP, ADS, scopeT);
    vm.root.position.x += Math.sin(phase) * 0.012 * bob * (1 - scopeT);
    vm.root.position.y += Math.abs(Math.cos(phase)) * 0.01 * bob * (1 - scopeT);
    kick = Math.max(0, kick - dt * 6);
    vm.root.position.z += kick * 0.06;
    let rx = kick * 0.12, rz = 0;
    // Working the bolt: the handle comes up and back; reloading: the rifle rolls to show the magazine.
    if (rifle.boltLeft > 0) {
      const k = Math.sin(rifle.busyProgress * Math.PI);
      vm.bolt.rotation.z = k * 1.2;
      vm.bolt.position.z = 0.08 + k * 0.08;
      rz = k * 0.15;
    } else {
      vm.bolt.rotation.z = 0;
      vm.bolt.position.z = 0.08;
    }
    if (rifle.reloading) {
      const k = Math.sin(rifle.busyProgress * Math.PI);
      rz = k * 0.6;
      rx -= k * 0.25;
      vm.root.position.y -= k * 0.06;
    }
    vm.root.rotation.set(rx, 0, rz);
  }

  function footsteps() {
    if (player.distance < nextStep) return;
    nextStep = player.distance + STRIDE;
    const volume = player.stance === 'stand' ? (player.speed > 4 ? 0.7 : 0.45) : player.stance === 'crouch' ? 0.2 : 0.08;
    audio.play('step', { volume, rate: 0.9 + Math.random() * 0.2 });
  }

  function frame() {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - last);
    last = now;
    time += dt;

    handleInput();
    updateRevive(dt);
    remotes.update(time, dt);
    enemies.update(time, dt);
    acc += dt;
    while (acc >= STEP) {
      player.step(STEP, move);
      move.jump = false;
      physics.step();
      bullets.step(STEP);
      acc -= STEP;
    }
    if (rifle.update(dt) === 'reloaded') say('RELOADED');
    if (life === 'up') health.regen(dt);
    updateAim(dt);
    footsteps();
    onThePad();
    sendState(dt);
    if (message && time > message.until) message = null;

    placeCamera(acc / STEP);
    placeViewmodel(dt);
    world.followShadow(feet);
    if (playing()) missionClock += dt;
    const w = wind();
    world.update(dt, w);
    snow.update(dt, camera, w, viewCanvas.height);
    lasers.update(enemies.lasers(), camera, dt, viewCanvas.width, viewCanvas.height);
    const windSpeed = Math.hypot(w.x, w.z);
    windSound.setPosition(camera.position.clone().add(new THREE.Vector3(-w.x, 0.3 * windSpeed, -w.z).normalize().multiplyScalar(20)));
    windSound.setVolume(0.15 + Math.min(0.9, windSpeed * 0.1));
    windSound.setRate(0.8 + Math.min(0.5, windSpeed * 0.05));
    fx.syncTrails(bullets.live);
    fx.update(dt);
    audio.setListener(camera);
    pipeline.render(world.scene, camera, { scene: overlay, camera: vmCamera });

    const heading = camera.getWorldDirection(new THREE.Vector3());
    hud.draw({
      time,
      locked: input.locked || TEST_MODE || !playing(),
      everLocked: input.everLocked,
      scoped: scoped() && life === 'up',
      fovDeg: camera.fov,
      spreadRad: spreadNow(),
      viewHeading: ((Math.atan2(heading.x, -heading.z) * 180) / Math.PI + 360) % 360,
      health: health.health,
      stance: player.stance,
      mag: rifle.mag,
      spare: rifle.spare,
      busy: rifle.reloading ? 'reload' : rifle.boltLeft > 0 ? 'bolt' : null,
      busyProgress: rifle.busyProgress,
      breath,
      holding,
      hitMarker: hitMarker && { age: time - hitMarker.at, kill: hitMarker.kill },
      message,
      scores: input.isHeld('Tab') ? scores : null,
      myId: net.id,
      down: playing() && life !== 'up'
        ? { by: down?.by ?? 'THE ENEMY', zone: down?.zone ?? '', bleedOut: (down?.until ?? time) - time, help: [...remotes.byId.values()].some((r) => r.life === 'up'), out: life === 'dead' }
        : null,
      revive: reviving && { name: nameOf(reviving.id), progress: reviving.progress },
      protectedFor: Math.max(0, protectedUntil - time),
      hurt: Math.max(0, 1 - (time - hurtAt) / 0.6),
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Handle for debugging and automated checks.
  (window as unknown as { __game: unknown }).__game = {
    THREE, player, rifle, map, physics, world, enemies, remotes, bullets, fire, net, camera, sway, health, weather, wind,
    /** Tests: no wind, so aimAt lands exactly. */
    setCalm(on: boolean) { calmOverride.on = on; },
    /** Hold the scope / hold breath in tests (headless has no right mouse). */
    setScoped(on: boolean | null) { scopeOverride = on; },
    setHoldBreath(on: boolean) { breathOverride = on; },
    /** Look at a world position, allowing for bullet drop so a scoped shot lands there. */
    aimAt(x: number, y: number, z: number) {
      const eye = player.pos.clone().setY(player.pos.y + player.eye);
      const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z, flatDist = Math.hypot(dx, dz);
      player.yaw = Math.atan2(-dx, -dz);
      player.pitch = Math.atan2(dy, flatDist) + drop(flatDist) - drop(ZERO_RANGE);
      return Math.hypot(flatDist, dy);
    },
    get phase() { return phase; },
    get life() { return life; },
    setRevive(on: boolean) { reviveOverride = on; },
    get scores() { return scores; },
    get scoped() { return scoped(); },
    get recoil() { return recoil; },
    get lastHit() { return lastHit; },
    get shotsFired() { return shotsFired; },
    get message() { return message; },
    seed,
  };
}

start();
