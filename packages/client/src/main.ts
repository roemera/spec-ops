import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  BULLET_SPEED, BREATH_RECOVER, GRAVITY, HIP_SPREAD, HOLD_BREATH, PHYSICS_HZ, RECOIL_PITCH, RECOIL_SETTLE, RESPAWN_DELAY, SCOPE_FOV,
  SCOPE_IN_TIME, SPAWN_PROTECTION, STATE_HZ, SWAY, ZONE_LABEL, generateMap,
  type Phase, type Score, type ServerMsg, type Stance,
} from '@spec-ops/shared';
import { Pipeline } from './render/pipeline';
import { PAL } from './render/palette';
import { World } from './world';
import { PlayerSim, type MoveInput } from './sim/player';
import { Rifle } from './sim/rifle';
import { Bullets, type Bullet, type SoldierHit } from './sim/bullets';
import { buildRifle } from './models/rifle';
import { Input } from './input';
import { Hud, HUD_COLORS } from './ui/hud';
import { Fx } from './fx';
import { Audio } from './audio';
import { Targets } from './targets';
import { Remotes } from './remotes';
import { Net } from './net';
import { Menu } from './ui/menu';

const params = new URLSearchParams(location.search);
// ?offline skips the menu (practice). ?join=host&name=X&password=Y joins a server directly.
// ?test hides the click-to-play panel (headless browsers cannot lock the pointer).
const TEST_MODE = params.has('test');
const STEP = 1 / PHYSICS_HZ;

const BASE_FOV = 70; // deg vertical
const ADS_FOV = 55; // deg while raising the scope, before it snaps to the scope view
const MOUSE_SENS = 0.0022; // rad per pixel at BASE_FOV; scales with fov so the scope isn't twitchy
const MESSAGE_TIME = 2.5; // s
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
    const choice = params.has('offline')
      ? ({ mode: 'offline' } as const)
      : params.has('join')
        ? ({ mode: 'online', server: params.get('join')!, name: params.get('name') ?? 'TEST', password: params.get('password') ?? '' } as const)
        : await menu.join(error);
    if (choice.mode === 'offline') {
      menu.hide();
      return runGame(menu, Number(params.get('seed') ?? 1337), null, null);
    }
    try {
      const { net, welcome } = await Net.connect(choice.server, choice.name, choice.password);
      return runGame(menu, welcome.seed, net, welcome);
    } catch (e) {
      error = String(e).toUpperCase();
      if (params.has('join')) params.delete('join'); // fall back to the menu
    }
  }
}

function runGame(menu: Menu, seed: number, net: Net | null, welcome: Welcome | null) {
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
  const world = new World(map, physics);

  const spawn = map.spawns[welcome?.spawn ?? 0];
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
  const wind = audio.loop('wind');
  wind.setVolume(0.25);
  // Offline: practice targets. Online: other players.
  const targets = net ? null : new Targets(world.scene, map, physics, spawn);
  const remotes = net ? new Remotes(world.scene, audio) : null;
  let phase: Phase = welcome?.phase ?? 'live';
  const playing = () => phase === 'live';

  // Online combat state. The server owns health; we mirror ours and show what it tells us.
  let health = 100;
  let dead: { killer: string; zone: string; until: number } | null = null;
  let protectedUntil = 0, hurtAt = -10;
  let scores: Score[] = [];
  const names = new Map<number, string>();
  const nameOf = (id: number) => names.get(id) ?? `PLAYER ${id}`;
  const zeroScores = (players: Array<{ id: number; name: string }>) =>
    players.map(({ id, name }) => ({ id, name, kills: 0, deaths: 0, shots: 0, hits: 0 }));
  for (const p of welcome?.players ?? []) names.set(p.id, p.name);
  scores = zeroScores(welcome?.players ?? []);
  if (net && phase === 'live') protectedUntil = SPAWN_PROTECTION; // joined mid-match
  /** You can move and shoot: match live and not dead. */
  const controlling = () => playing() && !dead;
  const arr = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

  let time = 0;
  let message: { text: string; color: string; until: number } | null = null;
  const say = (text: string, color: string = HUD_COLORS.ink) => (message = { text, color, until: time + MESSAGE_TIME });
  let hitMarker: { at: number; kill: boolean } | null = null;
  const mark = (kill: boolean) => (hitMarker = { at: time, kill });

  // --- Shooting ---

  /** Remote ids are positive; offline targets are -1 - index. */
  const bullets = new Bullets(
    physics,
    (origin, dir, len): SoldierHit | null => {
      const r = remotes?.hitTest(origin, dir, len);
      if (r) return { t: r.t, target: r.remote.id, zone: r.zone };
      const t = targets?.hitTest(origin, dir, len);
      if (t) return { t: t.t, target: -1 - targets!.list.indexOf(t.target), zone: t.zone };
      return null;
    },
    (b, hit, point, dir) => onHitSoldier(b, hit, point, dir),
    (b, point, normal) => {
      fx.endTrail(b.id, point);
      fx.impact(point, normal, point.y > map.heightAt(point.x, point.z) + 0.3 ? PAL.rock : PAL.snow);
      audio.play('impact', { pos: point, volume: 0.6 });
    },
  );

  let lastHit: { zone: string; range: number; killed: boolean } | null = null;
  function onHitSoldier(b: Bullet, hit: SoldierHit, point: THREE.Vector3, dir: THREE.Vector3) {
    fx.endTrail(b.id, point);
    audio.play('hit', { pos: point });
    const range = Math.round(b.start.distanceTo(point));
    if (hit.target > 0) {
      // Another player: show a wound here; the shooter reports it and the server decides.
      fx.wound(point, dir, PAL.friend);
      if (!b.visual) {
        net?.sendHit(b.id, hit.target, hit.zone, arr(point));
        mark(false);
      }
      return;
    }
    const target = targets!.list[-1 - hit.target];
    const res = target.health.applyHit(hit.zone);
    lastHit = { zone: hit.zone, range, killed: res.killed };
    if (res.killed) {
      fx.shatter(target.model.parts, dir, PAL.enemy);
      audio.play('shatter', { pos: point });
      targets!.kill(target);
      mark(true);
      say(`${ZONE_LABEL[hit.zone]}  ·  ${range} M`, HUD_COLORS.red);
    } else {
      fx.wound(point, dir, PAL.enemy);
      mark(false);
      say(`${ZONE_LABEL[hit.zone]}  ·  ${range} M`);
    }
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
    net?.sendFire(b.id, arr(origin), arr(vel));
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
  if (net && remotes) {
    const showLobby = (players: Parameters<Menu['lobby']>[0], countdown: number) =>
      menu.lobby(players, phase, countdown, net.id, (ready) => net.setReady(ready), () => net.startMatch());
    if (phase !== 'live') showLobby(welcome!.players, 0);
    else menu.hide();
    net.onMessage = (msg) => {
      if (msg.t === 'lobby') {
        for (const p of msg.players) names.set(p.id, p.name);
        if (msg.phase === 'live' && phase !== 'live') {
          // New match: fresh scores, and everyone is back on their feet.
          scores = zeroScores(msg.players);
          for (const id of remotes.byId.keys()) remotes.respawn(id);
        }
        phase = msg.phase;
        if (phase === 'live') menu.hide();
        else if (phase !== 'results') {
          dead = null;
          input.unlock();
          showLobby(msg.players, msg.countdown);
        }
      } else if (msg.t === 'spawn') {
        dead = null;
        health = 100;
        protectedUntil = time + SPAWN_PROTECTION;
        const sp = map.spawns[msg.spawn];
        player.teleport(sp, map.heightAt(sp.x, sp.z));
        rifle.reset();
        say('GO', HUD_COLORS.red);
      } else if (msg.t === 'left') {
        remotes.remove(msg.id);
      } else if (msg.t === 'fire') {
        // Someone else's shot: draw it and let it land here; they report its hits.
        const pos = new THREE.Vector3(...msg.pos), vel = new THREE.Vector3(...msg.vel);
        const dir = vel.clone().normalize();
        bullets.spawn(pos.clone().addScaledVector(dir, 0.9), pos, vel, undefined, true);
        fx.muzzleFlash(pos.clone().addScaledVector(dir, 0.9), dir);
        audio.play('shot', { pos });
      } else if (msg.t === 'damage') {
        if (msg.target === net.id) {
          health = msg.health;
          hurtAt = time;
          if (msg.health > 0) say(`HIT BY ${nameOf(msg.attacker)}  ·  ${ZONE_LABEL[msg.zone]}`, HUD_COLORS.red);
        }
      } else if (msg.t === 'kill') {
        scores = msg.scores;
        const killer = nameOf(msg.killer), victim = nameOf(msg.victim);
        if (msg.victim === net.id) {
          dead = { killer, zone: ZONE_LABEL[msg.zone], until: time + RESPAWN_DELAY };
          health = 0;
          scopeT = 0;
        } else {
          const r = remotes.byId.get(msg.victim);
          if (r && !r.dead) {
            fx.shatter(r.model.parts, new THREE.Vector3(), PAL.friend);
            audio.play('shatter', { pos: r.model.root.position.clone() });
          }
          remotes.kill(msg.victim);
          if (msg.killer === net.id) mark(true);
          say(msg.killer === net.id ? `YOU KILLED ${victim}  ·  ${ZONE_LABEL[msg.zone]}` : `${killer} KILLED ${victim}`, msg.killer === net.id ? HUD_COLORS.red : HUD_COLORS.ink);
        }
      } else if (msg.t === 'respawn') {
        if (msg.id !== net.id) remotes.respawn(msg.id);
      } else if (msg.t === 'results') {
        scores = msg.scores;
        dead = null;
        input.unlock();
        menu.results(msg.scores, msg.winner, msg.seconds, net.id);
        audio.jingle(msg.winner === net.id);
      }
    };
    net.onState = (st) => remotes.receive(st, time);
    net.onClose = (reason) => {
      input.unlock();
      menu.join(`DISCONNECTED: ${reason.toUpperCase()}`).then(() => location.reload());
    };
  }

  function sendState(dt: number) {
    if (!net || !playing()) return;
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

  function handleInput() {
    move.forward = move.right = 0;
    move.jump = move.sprint = false;
    wantScope = false;
    if (!controlling()) {
      // Lobby/countdown/dead: input ignored.
      input.takePresses();
      input.takeClicks();
      input.takeMouse();
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
    // A click that captures the mouse is not also a shot.
    if (clicks.some((c) => c.button === 0 && c.locked)) fire();
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
    if (dead) {
      // Down in the snow, looking along the ground.
      camera.position.set(feet.x, feet.y + 0.25, feet.z);
      euler.set(-0.1, player.yaw, 0.5);
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
    vm.root.visible = !scoped() && !dead;
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
    remotes?.update(time, dt);
    targets?.update(dt);
    acc += dt;
    while (acc >= STEP) {
      player.step(STEP, move);
      move.jump = false;
      physics.step();
      bullets.step(STEP);
      acc -= STEP;
    }
    if (rifle.update(dt) === 'reloaded') say('RELOADED');
    updateAim(dt);
    footsteps();
    sendState(dt);
    if (message && time > message.until) message = null;

    placeCamera(acc / STEP);
    placeViewmodel(dt);
    world.followShadow(feet);
    fx.syncTrails(bullets.live);
    fx.update(dt);
    audio.setListener(camera);
    pipeline.render(world.scene, camera, { scene: overlay, camera: vmCamera });

    const heading = camera.getWorldDirection(new THREE.Vector3());
    hud.draw({
      time,
      locked: input.locked || TEST_MODE || !playing(),
      everLocked: input.everLocked,
      scoped: scoped() && !dead,
      fovDeg: camera.fov,
      spreadRad: spreadNow(),
      viewHeading: ((Math.atan2(heading.x, -heading.z) * 180) / Math.PI + 360) % 360,
      health,
      stance: player.stance,
      mag: rifle.mag,
      spare: rifle.spare,
      busy: rifle.reloading ? 'reload' : rifle.boltLeft > 0 ? 'bolt' : null,
      busyProgress: rifle.busyProgress,
      breath,
      holding,
      hitMarker: hitMarker && { age: time - hitMarker.at, kill: hitMarker.kill },
      message,
      scores: net && input.isHeld('Tab') ? scores : null,
      myId: net?.id ?? 0,
      dead: dead && { killer: dead.killer, zone: dead.zone, respawnIn: dead.until - time },
      protectedFor: Math.max(0, protectedUntil - time),
      hurt: Math.max(0, 1 - (time - hurtAt) / 0.6),
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Handle for debugging and automated checks.
  (window as unknown as { __game: unknown }).__game = {
    THREE, player, rifle, map, physics, world, targets, remotes, bullets, fire, net, camera, sway,
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
    get dead() { return dead; },
    get scores() { return scores; },
    get scoped() { return scoped(); },
    get recoil() { return recoil; },
    get lastHit() { return lastHit; },
    get shotsFired() { return shotsFired; },
    get message() { return message; },
  };
}

start();
