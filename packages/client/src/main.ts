import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  GUN_MAX_ELEVATION, GUN_MIN_ELEVATION, MG_RATE, MG_SPEED, MG_SPREAD, PART_LABEL, PHYSICS_HZ, RENDER_HEIGHT,
  RENDER_WIDTH, RESPAWN_DELAY, SHELL_SPEED, SPAWN_PROTECTION, STATE_HZ, ZONE_LABEL, generateMap, hullZone,
  type HitZone, type Part, type Phase, type Score, type ServerMsg,
} from '@spec-ops/shared';
import { Pipeline } from './render/pipeline';
import { World } from './world';
import { buildTankModel, TRACK_TEXTURE_LENGTH } from './models/tank';
import { TankSim } from './sim/tank';
import { Input } from './input';
import { Hud, HUD_COLORS } from './ui/hud';
import { Gun } from './sim/gun';
import { Shells, type HitOutcome, type Shell, type ShellHit } from './sim/shells';
import { Bullets } from './sim/bullets';
import type { ColliderRole } from './sim/tank';
import { Fx } from './fx';
import { Audio, type Voice } from './audio';
import { Targets } from './targets';
import { Remotes } from './remotes';
import { Net } from './net';
import { Menu } from './ui/menu';

const params = new URLSearchParams(location.search);
// ?offline skips the menu (practice). ?join=host&name=X&password=Y joins a server directly.
// ?test hides the click-to-play panel (headless browsers cannot lock the pointer).
const TEST_MODE = params.has('test');
const STEP = 1 / PHYSICS_HZ;

// Views (vertical fov in degrees): head out of the hatch, and down the gun sight (right mouse).
const LOOKOUT_FOV = 60;
const SIGHT_FOV = 15;
const AIM_RANGE = 500; // m: how far the gaze ray looks for something to aim the gun at
const MOUSE_SENS = 0.0025; // rad per pixel at 60 deg fov
const RECOIL_IMPULSE = 9000; // N*s
const MESSAGE_TIME = 2.5; // s

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

  // Letterbox both canvases to 16:9; the browser scales them up with nearest-neighbour.
  let box = { left: 0, top: 0, width: 1, height: 1 };
  const layout = () => {
    const scale = Math.min(innerWidth / RENDER_WIDTH, innerHeight / RENDER_HEIGHT);
    const width = Math.floor(RENDER_WIDTH * scale), height = Math.floor(RENDER_HEIGHT * scale);
    box = { left: Math.floor((innerWidth - width) / 2), top: Math.floor((innerHeight - height) / 2), width, height };
    for (const c of [viewCanvas, hudCanvas]) {
      Object.assign(c.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${width}px`, height: `${height}px` });
    }
  };
  layout();
  addEventListener('resize', layout);

  const pipeline = new Pipeline(viewCanvas);
  const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physics.timestep = STEP;
  const map = generateMap(seed);
  const world = new World(map, physics);

  const spawn = map.spawns[welcome?.spawn ?? 0];
  const tank = new TankSim(physics, spawn, map.heightAt(spawn.x, spawn.z));
  const model = buildTankModel();
  world.scene.add(model.root);

  const hud = new Hud(hudCanvas);
  const gun = new Gun();
  const fx = new Fx(world.scene);
  const audio = new Audio();
  const engine = audio.loop('engine');
  // Offline: practice targets. Online: other players.
  const targets = net ? null : new Targets(physics, world.scene, map, spawn, audio, fx);
  const remotes = net ? new Remotes(physics, world.scene, audio) : null;
  let phase: Phase = welcome?.phase ?? 'live';
  const playing = () => phase === 'live';

  // Online combat state. The server owns health; we mirror ours and show what it tells us.
  let dead: { killer: string; zone: string; until: number } | null = null;
  let protectedUntil = 0, hurtAt = -10;
  let scores: Score[] = [];
  const names = new Map<number, string>();
  const nameOf = (id: number) => names.get(id) ?? `TANK ${id}`;
  const zeroScores = (players: Array<{ id: number; name: string }>) =>
    players.map(({ id, name }) => ({ id, name, kills: 0, deaths: 0, shots: 0, hits: 0 }));
  for (const p of welcome?.players ?? []) names.set(p.id, p.name);
  scores = zeroScores(welcome?.players ?? []);
  if (net && phase === 'live') protectedUntil = SPAWN_PROTECTION; // joined mid-match
  /** You can drive and shoot: match live and not dead. */
  const controlling = () => playing() && !dead;
  const arr = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

  let message: { text: string; color: string; until: number } | null = null;
  const say = (text: string, color: string) => (message = { text, color, until: time + MESSAGE_TIME });

  // The crew (you) mumbles gibberish when things happen. Each game gets its own voice pitch.
  const crewPitch = 110 + Math.random() * 90;
  let lastVoice = -10;
  let subtitle: { text: string; until: number } | null = null;
  function crew(mood: Voice, urgent = false) {
    if (!urgent && time - lastVoice < 0.6) return;
    lastVoice = time;
    audio.voice(mood, crewPitch);
    const words = { grunt: 1, yep: 1, shout: 2, scream: 3, panic: 5, cheer: 3, wail: 2 }[mood];
    const end = mood === 'scream' || mood === 'panic' || mood === 'cheer' || mood === 'shout' ? '!' : '...';
    subtitle = { text: `CREW: ${gibberish(words)}${end}`, until: time + 1.8 };
  }

  const shells = new Shells(physics, (shell, hit) => onShellHit(shell, hit));

  // Machine-gun bullets only hurt a lookout sticking out of a hatch.
  const bullets = new Bullets(
    physics,
    (origin, dir, len) => {
      const h = remotes?.hitMan(origin, dir, len);
      return h ? { t: h.t, target: h.remote.id } : null;
    },
    (b, target, point) => {
      fx.puff(point, true);
      if (!b.visual) net?.sendHit(b.id, target, 'man', arr(point));
    },
    (_b, point) => fx.puff(point),
  );
  let mgCooldown = 0;
  function fireMg() {
    const pos = new THREE.Vector3(), dir = new THREE.Vector3();
    tank.coax(pos, dir, aimPoint);
    // a little spread: a cone around the barrel
    dir.x += (Math.random() - 0.5) * 2 * MG_SPREAD;
    dir.y += (Math.random() - 0.5) * 2 * MG_SPREAD;
    dir.z += (Math.random() - 0.5) * 2 * MG_SPREAD;
    dir.normalize();
    const v = tank.body.linvel();
    const vel = dir.multiplyScalar(MG_SPEED).add(new THREE.Vector3(v.x, v.y, v.z));
    const b = bullets.spawn(pos, vel, tank.body);
    net?.sendFire(b.id, arr(pos), arr(vel), true);
    audio.play('mg', { volume: 0.5 });
  }

  /** Which zone a hit on a tank is, from the collider it hit and the surface normal. */
  function classifyZone(role: ColliderRole, body: { rotation(): { x: number; y: number; z: number; w: number } }, normal: THREE.Vector3): HitZone {
    if (role === 'barrel') return 'barrel';
    if (role === 'turret') return normal.y > 0.7 ? 'top' : 'turret';
    // Surface normal in the hull's own frame.
    const r = body.rotation();
    const local = normal.clone().applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w).invert());
    return hullZone(local.x, local.y, local.z);
  }

  /** Our shell hit another tank: report it; the server owns the damage. */
  function reportHits(shell: Shell, point: THREE.Vector3, direct: { id: number; zone: HitZone } | null) {
    if (net && direct && !shell.visual) net.sendHit(shell.id, direct.id, direct.zone, arr(point));
  }

  /** Decide what a shell hit does. Fences and trees break and let it through; everything else stops it. */
  function onShellHit(shell: Shell, hit: ShellHit): HitOutcome {
    const broken = world.shellHit(hit.collider.handle, hit.dir);
    if (broken && broken.kind !== 'wall') return 'pass';
    const remote = remotes?.find(hit.collider) ?? null;
    const found = targets?.find(hit.collider) ?? null;
    if (!broken && hit.collider.isSensor() && !found && !remote) return 'pass'; // some other sensor
    fx.explosion(hit.point, found || remote ? 1.2 : 1);
    audio.play('explosion', { pos: hit.point });
    if (remote) audio.play('impact', { pos: hit.point });
    const direct = remote && !remote.remote.dead ? { id: remote.remote.id, zone: classifyZone(remote.role, remote.remote.sim.body, hit.normal) } : null;
    reportHits(shell, hit.point, direct);
    if (found && targets) {
      audio.play('impact', { pos: hit.point });
      const { target, role } = found;
      if (target.deadFor > 0) return 'stop';
      const zone = classifyZone(role, target.sim.body, hit.normal);
      const res = target.sim.damage.applyHit(zone, Math.random());
      if (res.broke) target.sim.onPartBroken(res.broke);
      let text = `HIT ${ZONE_LABEL[res.zone]} -${res.damage}`;
      if (res.broke) text += ` ${PART_LABEL[res.broke]} BROKEN`;
      if (res.destroyed) {
        text = `TARGET DESTROYED (${ZONE_LABEL[res.zone]})`;
        targets.destroy(target);
        crew('cheer', true);
      }
      say(text, res.destroyed ? HUD_COLORS.lime : HUD_COLORS.yellow);
      lastHit = { zone: res.zone, damage: res.damage, broke: res.broke, destroyed: res.destroyed };
    }
    return 'stop';
  }
  let lastHit: { zone: HitZone; damage: number; broke: Part | null; destroyed: boolean } | null = null;

  function fire() {
    if (!controlling()) return;
    if (tank.isBroken('gun')) {
      audio.play('dry');
      say('GUN BROKEN', HUD_COLORS.red);
      return;
    }
    if (!gun.fire()) {
      audio.play('dry');
      say('RELOADING', HUD_COLORS.yellow);
      return;
    }
    const pos = new THREE.Vector3(), dir = new THREE.Vector3();
    tank.muzzle(pos, dir);
    const v = tank.body.linvel();
    const vel = dir.clone().multiplyScalar(SHELL_SPEED).add(new THREE.Vector3(v.x, v.y, v.z));
    const shell = shells.spawn(pos, vel, tank.body);
    net?.sendFire(shell.id, arr(pos), arr(vel));
    tank.recoil(dir, RECOIL_IMPULSE);
    crew('shout');
    fx.muzzleFlash(pos, dir);
    audio.play('cannon');
    setTimeout(() => audio.play('clank', { rate: 0.8 }), 350); // casing hits the floor
    shotsFired++;
  }
  let shotsFired = 0;
  const input = new Input(viewCanvas, (cx, cy) => [
    Math.floor(((cx - box.left) / box.width) * RENDER_WIDTH),
    Math.floor(((cy - box.top) / box.height) * RENDER_HEIGHT),
  ]);
  const camera = new THREE.PerspectiveCamera(LOOKOUT_FOV, RENDER_WIDTH / RENDER_HEIGHT, 0.1, 1200);

  // Where you look, relative to the hull (yaw: + is left). The turret follows it.
  const look = { yaw: 0, pitch: -0.05 };
  let sighting = false; // right mouse held: down the gun sight
  let sightOverride: boolean | null = null; // tests: headless browsers can't hold the right button

  addEventListener('mousedown', () => {
    audio.unlock();
    if (controlling()) input.lock();
  });

  // --- Network ---
  let sendTimer = 0;
  if (net && remotes) {
    // Map objects: what was broken before we joined, and what we break, goes through the server.
    for (const id of welcome!.broken) world.breakById(id, false);
    world.onBreak = (id) => net.sendBreak(id);
    const showLobby = (players: Parameters<Menu['lobby']>[0], countdown: number) =>
      menu.lobby(players, phase, countdown, net.id, (ready) => net.setReady(ready), () => net.startMatch());
    if (phase !== 'live') showLobby(welcome!.players, 0);
    else menu.hide();
    net.onMessage = (msg) => {
      if (msg.t === 'lobby') {
        for (const p of msg.players) names.set(p.id, p.name);
        if (msg.phase === 'live' && phase !== 'live') {
          // New match: fresh scores, and every wreck from the last one is back in action.
          scores = zeroScores(msg.players);
          for (const id of remotes.byId.keys()) remotes.respawn(id);
          world.resetBreakables();
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
        wreck(model, false);
        protectedUntil = time + SPAWN_PROTECTION;
        const sp = map.spawns[msg.spawn];
        tank.teleport(sp, map.heightAt(sp.x, sp.z));
        tank.damage.reset();
        gun.reset();
        look.yaw = 0;
        look.pitch = -0.05;
        say('GO GO GO', HUD_COLORS.lime);
      } else if (msg.t === 'left') {
        remotes.remove(msg.id);
      } else if (msg.t === 'fire' && msg.mg) {
        const pos = new THREE.Vector3(...msg.pos), vel = new THREE.Vector3(...msg.vel);
        bullets.spawn(pos, vel, remotes.byId.get(msg.from)?.sim.body, true);
        audio.play('mg', { pos, volume: 0.7 });
      } else if (msg.t === 'fire') {
        // Someone else's shot: draw it and let it explode here; they report its hits.
        const pos = new THREE.Vector3(...msg.pos), vel = new THREE.Vector3(...msg.vel);
        shells.spawn(pos, vel, remotes.byId.get(msg.from)?.sim.body, true);
        fx.muzzleFlash(pos, vel.clone().normalize());
        audio.play('cannon', { pos });
      } else if (msg.t === 'damage') {
        const what = `${ZONE_LABEL[msg.zone]} -${msg.damage}${msg.broke ? ` ${PART_LABEL[msg.broke]} BROKEN` : ''}`;
        if (msg.target === net.id) {
          tank.damage.health = msg.health;
          if (msg.broke) {
            tank.damage.breakPart(msg.broke);
            tank.onPartBroken(msg.broke);
          }
          hurtAt = time;
          audio.play('impact', { volume: 1.5, rate: 0.7 });
          if (msg.health > 0) crew(msg.broke ? 'panic' : 'scream', true);
          say(`HIT BY ${nameOf(msg.attacker)}: ${what}`, HUD_COLORS.red);
        } else if (msg.attacker === net.id) {
          say(`HIT ${nameOf(msg.target)}: ${what}`, HUD_COLORS.yellow);
          lastHit = { zone: msg.zone, damage: msg.damage, broke: msg.broke, destroyed: msg.health <= 0 };
        }
      } else if (msg.t === 'kill') {
        scores = msg.scores;
        const killer = nameOf(msg.killer), victim = nameOf(msg.victim);
        if (msg.victim === net.id) {
          dead = { killer, zone: ZONE_LABEL[msg.zone], until: time + RESPAWN_DELAY };
          tank.centreSteer();
          tank.throttleIdx = 2; // stop
          const p = tank.body.translation();
          fx.fire(new THREE.Vector3(p.x, p.y + 1.2, p.z), RESPAWN_DELAY);
          audio.play('explosion', { volume: 1.5 });
          wreck(model, true);
          crew('wail', true);
        } else {
          remotes.kill(msg.victim);
          if (msg.killer === net.id) crew('cheer', true);
          const r = remotes.byId.get(msg.victim);
          if (r) fx.fire(r.model.root.position.clone().add(new THREE.Vector3(0, 1.2, 0)), RESPAWN_DELAY);
          say(msg.killer === net.id ? `YOU KILLED ${victim}` : `${killer} KILLED ${victim}`, msg.killer === net.id ? HUD_COLORS.lime : HUD_COLORS.white);
        }
      } else if (msg.t === 'break') {
        world.breakById(msg.id);
      } else if (msg.t === 'respawn') {
        if (msg.id !== net.id) remotes.respawn(msg.id);
      } else if (msg.t === 'results') {
        scores = msg.scores;
        dead = null;
        input.unlock();
        menu.results(msg.scores, msg.winner, msg.seconds, net.id);
        wreck(model, false);
        audio.jingle(msg.winner === net.id);
        crew(msg.winner === net.id ? 'cheer' : 'wail', true);
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
    const p = tank.body.translation(), q = tank.body.rotation(), v = tank.body.linvel();
    net.sendState({
      id: 0,
      flags: 0,
      pos: [p.x, p.y, p.z],
      quat: [q.x, q.y, q.z, q.w],
      vel: [v.x, v.y, v.z],
      turretYaw: tank.turretYaw,
      gunPitch: tank.gunPitch,
    });
  }

  const hullPos = new THREE.Vector3(), hullQuat = new THREE.Quaternion();
  const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpE = new THREE.Euler(0, 0, 0, 'YXZ');
  let acc = 0, last = performance.now() / 1000, time = 0;

  function handleInput(dt: number) {
    if (!controlling()) {
      // Lobby/countdown/dead: tank parked, input ignored.
      input.takePresses();
      input.takeClicks();
      input.takeMouse();
      tank.brake = true;
      sighting = false;
      return;
    }
    for (const code of input.takePresses()) {
      audio.unlock();
      // Dev key: break a random part on your own tank to see its effect.
      if (code === 'F8') {
        const parts: Part[] = ['tracks', 'engine', 'turretRing', 'gun', 'optics'];
        const part = parts[Math.floor(Math.random() * parts.length)];
        tank.damage.breakPart(part);
        tank.onPartBroken(part);
        say(`DEV: ${PART_LABEL[part]} BROKEN`, HUD_COLORS.red);
        crew('panic', true);
      }
      // Driving levers: they stay where you leave them.
      if (code === 'KeyW') tank.throttleUp();
      if (code === 'KeyS') tank.throttleDown();
      if (code === 'KeyA') tank.steerBy(-1);
      if (code === 'KeyD') tank.steerBy(1);
      if (code === 'KeyX') tank.centreSteer();
    }
    tank.brake = input.isHeld('Space');

    const clicks = input.takeClicks();
    if (clicks.length) audio.unlock();
    const [dx, dy] = input.takeMouse();
    // A click that captures the mouse is not also a game action (no firing on the grab click).
    const lmb = clicks.some((c) => c.button === 0 && c.locked);
    sighting = sightOverride ?? (input.locked && input.mouseButtons.has(2));
    if (sighting) {
      // Down the sight the mouse moves the gun directly; keep the gaze in step so letting go doesn't jump.
      const sens = MOUSE_SENS * (SIGHT_FOV / 60) * (input.isHeld('ShiftLeft') ? 0.3 : 1);
      // Only when the mouse moves: a swing already under way (from the gaze) carries on.
      if (dx || dy) tank.aimBy(-dx * sens, -dy * sens);
      look.yaw = tank.turretYawCmd;
      look.pitch = clamp(tank.gunPitchCmd, 1.2);
    } else {
      look.yaw -= dx * MOUSE_SENS;
      look.pitch = clamp(look.pitch - dy * MOUSE_SENS, 1.2);
    }
    if (lmb) fire();
    // Hold the middle button for the machine gun. Unlimited ammo, no recoil.
    if (input.mouseButtons.has(1) && input.locked) {
      mgCooldown -= dt;
      while (mgCooldown <= 0) {
        fireMg();
        mgCooldown += 1 / MG_RATE;
      }
    } else mgCooldown = 0;
  }

  /** Point the gun at a world position, compensating for hull tilt and shell drop. */
  function aimAtPoint(x: number, y: number, z: number) {
    tank.pose(hullPos, hullQuat);
    const local = new THREE.Vector3(x, y, z).sub(hullPos).applyQuaternion(hullQuat.clone().invert());
    const { yaw, pitch, range } = tank.aimAnglesTo(local);
    tank.turretYawCmd = yaw;
    const drop = (9.81 * range) / (2 * SHELL_SPEED * SHELL_SPEED);
    tank.gunPitchCmd = Math.max(GUN_MIN_ELEVATION, Math.min(GUN_MAX_ELEVATION, pitch + drop));
    return range;
  }

  /** Head-out view: the turret swings toward whatever you are looking at. */
  const gazeTarget = new THREE.Vector3();
  let aimRange = 75; // m to what you're aiming at
  const aimPoint = new THREE.Vector3(); // what the crosshair (sight) or your gaze (head out) is on

  /** Down the sight: how far away is whatever the crosshair is on? */
  function sightRange() {
    const origin = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const r = rangeAlong(origin, dir);
    aimPoint.copy(origin).addScaledVector(dir, r);
    return r;
  }

  /** Distance along a ray to the first solid thing, or another tank's commander (he has no collider). */
  function rangeAlong(origin: THREE.Vector3, dir: THREE.Vector3) {
    const hit = physics.castRay(new RAPIER.Ray(origin, dir), AIM_RANGE, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, tank.body);
    const man = remotes?.hitMan(origin, dir, AIM_RANGE);
    return Math.min(hit ? hit.timeOfImpact : AIM_RANGE, man ? man.t : AIM_RANGE);
  }
  function followGaze() {
    const origin = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    gazeTarget.copy(origin).addScaledVector(dir, Math.max(rangeAlong(origin, dir), 15));
    aimRange = aimAtPoint(gazeTarget.x, gazeTarget.y, gazeTarget.z);
    aimPoint.copy(gazeTarget);
  }

  /** Where the gun actually points, on screen (HUD pixels), at the distance you're looking. */
  function gunMark(): [number, number] | null {
    const pos = new THREE.Vector3(), dir = new THREE.Vector3();
    tank.muzzle(pos, dir);
    const p = pos.addScaledVector(dir, Math.max(15, gazeTarget.distanceTo(pos))).project(camera);
    if (p.z > 1) return null;
    return [((p.x + 1) / 2) * RENDER_WIDTH, ((1 - p.y) / 2) * RENDER_HEIGHT];
  }

  function placeCamera(): { fov: number; viewHeading: number } {
    let fov = LOOKOUT_FOV;
    if (dead) {
      // Death camera: circle the burning wreck in jerky 12 fps steps.
      model.root.visible = true;
      const a = (Math.floor(time * 12) / 12) * 0.5;
      camera.position.set(hullPos.x + Math.sin(a) * 14, hullPos.y + 6, hullPos.z + Math.cos(a) * 14);
      camera.lookAt(hullPos);
    } else if (sighting) {
      // Down the gun sight, right above the cannon.
      model.root.visible = false;
      camera.position.copy(model.gun.localToWorld(tmpV.set(0, 0.3, -0.4)));
      model.gun.getWorldQuaternion(camera.quaternion);
      fov = SIGHT_FOV;
    } else {
      // Head out of the hatch.
      model.root.visible = true;
      camera.position.copy(model.turret.localToWorld(tmpV.set(0.5, 1.35, 0.4)));
      camera.quaternion.copy(hullQuat).multiply(tmpQ.setFromEuler(tmpE.set(look.pitch, look.yaw, 0)));
    }
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    const dir = camera.getWorldDirection(tmpV);
    return { fov, viewHeading: compass(dir.x, dir.z) };
  }

  function frame() {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, now - last);
    last = now;
    time += dt;

    handleInput(dt);
    remotes?.update(time, dt);
    acc += dt;
    while (acc >= STEP) {
      tank.step(STEP);
      targets?.step(STEP);
      physics.step();
      world.checkBreaks(tank.hullCollider, Math.abs(tank.speed));
      shells.step(STEP);
      bullets.step(STEP);
      acc -= STEP;
    }
    if (gun.update(dt)) audio.play('breech', { volume: 0.5 }); // reloaded
    world.update(dt);
    targets?.update(dt);
    sendState(dt);
    fx.syncTracers(shells.live);
    fx.syncBulletTracers(bullets.live);
    fx.update(dt);
    if (message && time > message.until) message = null;

    // Sync the tank model.
    tank.pose(hullPos, hullQuat);
    model.root.position.copy(hullPos);
    model.root.quaternion.copy(hullQuat);
    model.turret.rotation.y = tank.turretYaw;
    model.gun.rotation.x = tank.gunPitch;
    model.trackMaps[0].offset.y += (tank.trackSpeed[0] * dt) / TRACK_TEXTURE_LENGTH;
    model.trackMaps[1].offset.y += (tank.trackSpeed[1] * dt) / TRACK_TEXTURE_LENGTH;
    model.root.updateMatrixWorld(true);

    const view = placeCamera();
    if (controlling() && !sighting) followGaze();
    else if (sighting) aimRange = sightRange();
    audio.setInside(sighting);
    audio.setListener(camera);
    engine.setRate(0.6 + Math.abs(tank.speed) / 12);
    engine.setVolume(0.35);
    pipeline.render(world.scene, camera);

    hud.draw({
      tank, time,
      locked: input.locked || TEST_MODE || !playing(),
      everLocked: input.everLocked,
      sighting,
      fovDeg: view.fov,
      viewHeading: view.viewHeading,
      gunMark: !dead && !sighting ? gunMark() : null,
      gun,
      message,
      scores: net && input.isHeld('Tab') ? scores : null,
      myId: net?.id ?? 0,
      dead: dead && { killer: dead.killer, zone: dead.zone, respawnIn: dead.until - time },
      protectedFor: Math.max(0, protectedUntil - time),
      hurt: Math.max(0, 1 - (time - hurtAt) / 0.6),
      subtitle: subtitle && time < subtitle.until ? subtitle.text : null,
    });
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // Handle for debugging and automated checks.
  (window as unknown as { __game: unknown }).__game = {
    THREE, tank, map, physics, look, world, gun, targets, remotes, shells, bullets, fire, fireMg, net,
    /** Hold the gun sight in tests (headless has no right mouse). */
    setSighting(on: boolean | null) { sightOverride = on; },
    get phase() { return phase; },
    get dead() { return dead; },
    get scores() { return scores; },
    /** Point the gun at a world position (tests). The gaze is moved there too, or it would pull the turret back. */
    aimAt(x: number, y: number, z: number) {
      const r = aimAtPoint(x, y, z);
      look.yaw = tank.turretYawCmd;
      look.pitch = tank.gunPitchCmd;
      return r;
    },
    get lastHit() { return lastHit; },
    get aimRange() { return aimRange; },
    get shotsFired() { return shotsFired; },
    get message() { return message; },
  };
}

const SYLLABLES = ['BLO', 'RK', 'GNA', 'HUP', 'ZO', 'KRA', 'MEE', 'OOG', 'FLA', 'TCH', 'NNG', 'WUB', 'SKO', 'PRT', 'GLUB', 'YAH'];
/** Crew talk, as subtitled by someone who wasn't listening. */
function gibberish(words: number) {
  const pick = () => SYLLABLES[Math.floor(Math.random() * SYLLABLES.length)];
  return Array.from({ length: words }, () => pick() + (Math.random() < 0.5 ? pick().toLowerCase() : '')).join(' ').toUpperCase();
}

const WRECK = new THREE.MeshLambertMaterial({ color: 0x110011 });
/** Turn a tank model into a black wreck, or back. */
function wreck(m: { root: THREE.Object3D }, on: boolean) {
  m.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (on) {
      o.userData.mat ??= o.material;
      o.material = WRECK;
    } else if (o.userData.mat) o.material = o.userData.mat;
  });
}

function clamp(v: number, limit: number) {
  return Math.max(-limit, Math.min(limit, v));
}
/** Compass bearing in degrees, 0 = north (-z), 90 = east (+x). */
function compass(x: number, z: number) {
  return ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
}

start();
