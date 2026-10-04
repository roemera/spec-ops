import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import {
  BARREL_LENGTH, GRAVITY, TankDamage, type Part,
  GUN_ELEVATION_RATE, GUN_MAX_ELEVATION, GUN_MIN_ELEVATION, HULL_HALF, HULL_TURN_RATE, STEER_STEP,
  TANK_MASS, THROTTLE_STEPS, TOP_SPEED_FORWARD, TOP_SPEED_REVERSE, TURRET_TURN_RATE, type Spawn,
} from '@skeleton-crew/shared';

// Suspension: 5 rays per side from the hull floor.
const SUSP_X = 1.4;
const SUSP_Z = [-2.6, -1.3, 0, 1.3, 2.6];
const SUSP_LEN = 1.1; // m
const SUSP_K = 75000; // N/m per point (~0.4 m sag at rest)
const SUSP_C = 16000; // N*s/m per point
// Track grip: how hard each grounded point pushes toward the commanded velocity.
const GRIP_LONG = 3; // 1/s
const GRIP_LAT = 10; // 1/s
const MU_LONG = 1.0;
const MU_LAT = 0.8;
const ACCEL_MAX = 3; // m/s^2
const BRAKE_MAX = 8; // m/s^2
const COAX_CONVERGE = 75; // m: default crossing range when nothing is targeted
const COAX_ALIGN = (3 * Math.PI) / 180; // rad: within this, bullets go exactly where you aim
const AIM_LEAD = (3 * Math.PI) / 180; // rad: how far the mouse may get ahead of the turret

/** Tank collision groups: member of group 3, collides with everything except debris (group 2). */
export const TANK_GROUPS = 0x0004_fffd;

// Turret and gun geometry, in the hull frame (forward is -z). The model uses the same numbers.
export const TURRET_OFFSET = new THREE.Vector3(0, HULL_HALF.y + 0.45, 0.4);
export const GUN_OFFSET = new THREE.Vector3(0, 0.1, -1.45); // in the turret frame

export type ColliderRole = 'hull' | 'turret' | 'barrel';

const v3 = () => new THREE.Vector3();

export class TankSim {
  readonly body: RAPIER.RigidBody;
  readonly hullCollider: RAPIER.Collider;
  readonly turretCollider: RAPIER.Collider;
  readonly barrelCollider: RAPIER.Collider;
  readonly damage = new TankDamage();

  // Driver levers: they stay where they were left (cruise control).
  throttleIdx = THROTTLE_STEPS.indexOf(0);
  steer = 0; // -1 (left) .. 1 (right)
  brake = false;

  // Turret: actual angles move toward commanded ones at fixed rates.
  turretYaw = 0;
  gunPitch = 0;
  turretYawCmd = 0;
  gunPitchCmd = 0;

  // Read by visuals and HUD.
  speed = 0; // m/s along hull forward
  trackSpeed: [number, number] = [0, 0];
  grounded = 0; // fraction of suspension points touching

  private points: THREE.Vector3[] = [];
  private tmp = { a: v3(), b: v3(), c: v3(), d: v3(), e: v3(), f: v3(), n: v3(), q: new THREE.Quaternion() };

  /**
   * `kinematic` tanks are other players: moved by network updates, solid to your tank and to shells,
   * but not pushed around by anything.
   */
  constructor(private world: RAPIER.World, spawn: Spawn, groundY: number, kinematic = false) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawn.rotY);
    this.body = world.createRigidBody(
      (kinematic ? RAPIER.RigidBodyDesc.kinematicPositionBased() : RAPIER.RigidBodyDesc.dynamic())
        .setTranslation(spawn.x, groundY + 2.2, spawn.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCanSleep(false)
        .setAngularDamping(0.6)
        .setLinearDamping(0.05)
        .setCcdEnabled(true),
    );
    const { x: hx, y: hy, z: hz } = HULL_HALF;
    const m = TANK_MASS;
    this.hullCollider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setMassProperties(
          m,
          { x: 0, y: -0.3, z: 0 },
          { x: (m / 12) * (4 * hy * hy + 4 * hz * hz), y: (m / 12) * (4 * hx * hx + 4 * hz * hz), z: (m / 12) * (4 * hx * hx + 4 * hy * hy) },
          { x: 0, y: 0, z: 0, w: 1 },
        )
        .setFriction(0.3)
        .setCollisionGroups(TANK_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );
    this.turretCollider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(1.1, 0.45, 1.4).setTranslation(TURRET_OFFSET.x, TURRET_OFFSET.y, TURRET_OFFSET.z).setDensity(0).setFriction(0.3).setCollisionGroups(TANK_GROUPS),
      this.body,
    );
    // The barrel is a sensor: shells can hit it, but it never snags on walls.
    this.barrelCollider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.18, 0.18, BARREL_LENGTH / 2).setDensity(0).setSensor(true).setCollisionGroups(TANK_GROUPS),
      this.body,
    );
    this.syncTurretColliders();
    for (const x of [-SUSP_X, SUSP_X]) for (const z of SUSP_Z) this.points.push(new THREE.Vector3(x, -hy, z));
  }

  get throttle() {
    return THROTTLE_STEPS[this.throttleIdx];
  }

  /** Which part of this tank a collider is, or null if it is not ours. */
  roleOf(collider: RAPIER.Collider): ColliderRole | null {
    if (collider.handle === this.hullCollider.handle) return 'hull';
    if (collider.handle === this.turretCollider.handle) return 'turret';
    if (collider.handle === this.barrelCollider.handle) return 'barrel';
    return null;
  }

  isBroken(part: Part) {
    return this.damage.isBroken(part);
  }

  /** Break a part and apply its immediate effect (broken tracks also kill cruise control). */
  onPartBroken(part: Part) {
    if (part === 'tracks') {
      this.throttleIdx = THROTTLE_STEPS.indexOf(0);
      this.steer = 0;
    }
  }

  // --- Driver levers ---
  throttleUp() {
    this.throttleIdx = Math.min(THROTTLE_STEPS.length - 1, this.throttleIdx + 1);
  }
  throttleDown() {
    this.throttleIdx = Math.max(0, this.throttleIdx - 1);
  }
  steerBy(dir: -1 | 1) {
    this.steer = Math.max(-1, Math.min(1, this.steer + dir * STEER_STEP));
  }
  centreSteer() {
    this.steer = 0;
  }

  // --- Gunner ---
  /**
   * Mouse aiming. The command may only lead the actual turret/gun by AIM_LEAD, so flicking the mouse
   * doesn't pile up a backlog: the turret stops soon after the mouse does, and reverses at once.
   */
  aimBy(dYaw: number, dPitch: number) {
    this.turretYawCmd = clampAround(this.turretYawCmd + dYaw, this.turretYaw, AIM_LEAD);
    const pitch = clampAround(this.gunPitchCmd + dPitch, this.gunPitch, AIM_LEAD);
    this.gunPitchCmd = Math.max(GUN_MIN_ELEVATION, Math.min(GUN_MAX_ELEVATION, pitch));
  }

  step(dt: number) {
    this.damage.update(dt); // broken parts repair over time
    this.stepTurret(dt);
    this.stepDrive(dt);
  }

  private stepTurret(dt: number) {
    const rate = TURRET_TURN_RATE * (this.isBroken('turretRing') ? 0.25 : 1);
    const dy = this.turretYawCmd - this.turretYaw;
    this.turretYaw += Math.sign(dy) * Math.min(Math.abs(dy), rate * dt);
    const dp = this.gunPitchCmd - this.gunPitch;
    this.gunPitch += Math.sign(dp) * Math.min(Math.abs(dp), GUN_ELEVATION_RATE * dt);
    this.syncTurretColliders();
  }

  /** Set turret and gun angles directly (remote tanks). */
  setTurret(yaw: number, pitch: number) {
    this.turretYaw = this.turretYawCmd = yaw;
    this.gunPitch = this.gunPitchCmd = pitch;
    this.syncTurretColliders();
  }

  /** Move to a spawn point, stopped, with levers centred (match start, respawn). */
  teleport(spawn: Spawn, groundY: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spawn.rotY);
    this.body.setTranslation({ x: spawn.x, y: groundY + 2.2, z: spawn.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.throttleIdx = THROTTLE_STEPS.indexOf(0);
    this.steer = 0;
    this.setTurret(0, 0);
  }

  /**
   * Turret yaw and gun pitch that put the barrel's line through `target` (hull frame).
   * The gun pivots at the mantlet, which itself swings with the turret, so iterate a few times.
   */
  aimAnglesTo(target: THREE.Vector3): { yaw: number; pitch: number; range: number } {
    let yaw = this.turretYaw;
    const d = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      const pivot = GUN_OFFSET.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw).add(TURRET_OFFSET);
      d.copy(target).sub(pivot);
      const raw = Math.atan2(-d.x, -d.z);
      yaw = raw + Math.round((this.turretYaw - raw) / (Math.PI * 2)) * Math.PI * 2; // nearest turn
    }
    const range = Math.hypot(d.x, d.z);
    return { yaw, pitch: Math.atan2(d.y, range), range };
  }

  /** Turret and gun rotation in the hull frame. */
  private gunFrame(outQuat: THREE.Quaternion) {
    return outQuat.setFromEuler(new THREE.Euler(this.gunPitch, this.turretYaw, 0, 'YXZ'));
  }

  private syncTurretColliders() {
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.turretYaw);
    this.turretCollider.setRotationWrtParent({ x: qYaw.x, y: qYaw.y, z: qYaw.z, w: qYaw.w });
    const q = this.gunFrame(new THREE.Quaternion());
    const mid = this.gunPointLocal(-BARREL_LENGTH / 2, new THREE.Vector3());
    this.barrelCollider.setTranslationWrtParent({ x: mid.x, y: mid.y, z: mid.z });
    this.barrelCollider.setRotationWrtParent({ x: q.x, y: q.y, z: q.z, w: q.w });
  }

  /** A point along the barrel axis (z in gun frame, negative is out the muzzle), in the hull frame. */
  private gunPointLocal(z: number, out: THREE.Vector3) {
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.turretYaw);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.gunPitch);
    out.set(0, 0, z).applyQuaternion(qPitch).add(GUN_OFFSET).applyQuaternion(qYaw).add(TURRET_OFFSET);
    return out;
  }

  /** Muzzle position and barrel direction in world space. */
  muzzle(outPos: THREE.Vector3, outDir: THREE.Vector3) {
    const t = this.body.translation(), r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    this.gunPointLocal(-BARREL_LENGTH, outPos).applyQuaternion(q).add(new THREE.Vector3(t.x, t.y, t.z));
    outDir.set(0, 0, -1).applyQuaternion(this.gunFrame(new THREE.Quaternion())).applyQuaternion(q);
  }

  /**
   * Coaxial machine gun, beside the cannon's mantlet. It fires at `target` (what your crosshair or
   * gaze is on) when the barrel points within COAX_ALIGN of it; otherwise along the barrel,
   * crossing the cannon's line at the same range.
   */
  coax(outPos: THREE.Vector3, outDir: THREE.Vector3, target?: THREE.Vector3) {
    const t = this.body.translation(), r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w), p = new THREE.Vector3(t.x, t.y, t.z);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.turretYaw);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.gunPitch);
    outPos.set(0.25, 0.05, -1.0).applyQuaternion(qPitch).add(GUN_OFFSET).applyQuaternion(qYaw).add(TURRET_OFFSET)
      .applyQuaternion(q).add(p);
    const range = target ? Math.max(10, target.distanceTo(outPos)) : COAX_CONVERGE;
    const alongBarrel = this.gunPointLocal(-range, new THREE.Vector3()).applyQuaternion(q).add(p);
    outDir.copy(alongBarrel).sub(outPos).normalize();
    if (target) {
      const toTarget = target.clone().sub(outPos).normalize();
      if (toTarget.angleTo(outDir) < COAX_ALIGN) outDir.copy(toTarget);
    }
  }

  /** Kick the hull back when the gun fires. */
  recoil(dir: THREE.Vector3, impulse: number) {
    const t = this.body.translation(), r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const p = TURRET_OFFSET.clone().applyQuaternion(q).add(new THREE.Vector3(t.x, t.y, t.z));
    this.body.applyImpulseAtPoint({ x: -dir.x * impulse, y: -dir.y * impulse, z: -dir.z * impulse }, p, true);
  }

  private stepDrive(dt: number) {
    const { a: pos, b: fwd, c: up, d: tmp, e: rel, f: vdes, n: normal, q } = this.tmp;
    const body = this.body;
    const t = body.translation(), r = body.rotation();
    q.set(r.x, r.y, r.z, r.w);
    const com = body.worldCom();
    const lin = body.linvel();
    up.set(0, 1, 0).applyQuaternion(q);
    fwd.set(0, 0, -1).applyQuaternion(q);
    this.speed = lin.x * fwd.x + lin.y * fwd.y + lin.z * fwd.z;

    const throttle = this.throttle;
    // Broken tracks: the tank can't drive and the tracks drag like a brake.
    const tracksOut = this.isBroken('tracks');
    const stopped = this.brake || tracksOut;
    const engine = this.isBroken('engine') ? 0.25 : 1;
    const vTarget = stopped ? 0 : (throttle >= 0 ? throttle * TOP_SPEED_FORWARD : throttle * TOP_SPEED_REVERSE) * engine;
    // Turning right = clockwise from above = negative yaw rate.
    const yawTarget = stopped ? 0 : -this.steer * HULL_TURN_RATE * engine;
    const aMax = stopped || Math.abs(vTarget) < Math.abs(this.speed) ? BRAKE_MAX : ACCEL_MAX;

    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: -up.x, y: -up.y, z: -up.z });
    const mPer = TANK_MASS / this.points.length;
    let grounded = 0;
    const sideSpeed = [0, 0], sideCount = [0, 0];

    for (let i = 0; i < this.points.length; i++) {
      pos.copy(this.points[i]).applyQuaternion(q).add(tmp.set(t.x, t.y, t.z));
      ray.origin = { x: pos.x, y: pos.y, z: pos.z };
      const hit = this.world.castRayAndGetNormal(ray, SUSP_LEN, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, TANK_GROUPS, undefined, body);
      if (!hit) continue;
      grounded++;
      const toi = hit.timeOfImpact;
      normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
      const contact = { x: pos.x - up.x * toi, y: pos.y - up.y * toi, z: pos.z - up.z * toi };
      const vel = body.velocityAtPoint(contact);

      // Spring + damper along the ground normal.
      const vN = vel.x * normal.x + vel.y * normal.y + vel.z * normal.z;
      const load = Math.max(0, SUSP_K * (SUSP_LEN - toi) - SUSP_C * vN);
      body.applyImpulseAtPoint({ x: normal.x * load * dt, y: normal.y * load * dt, z: normal.z * load * dt }, pos, true);

      // Ground-plane axes at this point.
      const f = tmp.copy(fwd).addScaledVector(normal, -fwd.dot(normal)).normalize();
      const fx = f.x, fy = f.y, fz = f.z;
      const right = new THREE.Vector3(fx, fy, fz).cross(normal); // f x n = right

      // Commanded velocity of the ground under this point: forward speed + hull rotation.
      // This gives skid steering for free: the outer track runs faster than the inner one.
      rel.set(contact.x - com.x, contact.y - com.y, contact.z - com.z);
      vdes.set(fx * vTarget, fy * vTarget, fz * vTarget).add(new THREE.Vector3().copy(normal).multiplyScalar(yawTarget).cross(rel));
      const dvx = vdes.x - vel.x, dvy = vdes.y - vel.y, dvz = vdes.z - vel.z;
      const dLong = dvx * fx + dvy * fy + dvz * fz;
      const dLat = dvx * right.x + dvy * right.y + dvz * right.z;
      // Engine power cancels gravity along the slope (fy > 0 = facing uphill), so hills cost little speed.
      // A broken engine only manages a quarter of it. Track grip still limits what you can climb.
      const slopeAccel = GRAVITY * fy * engine;
      const fLong = clamp(dLong * mPer * GRIP_LONG + slopeAccel * mPer, Math.min(MU_LONG * load, (aMax + Math.abs(slopeAccel)) * mPer));
      const fLat = clamp(dLat * mPer * GRIP_LAT, MU_LAT * load);
      body.applyImpulseAtPoint(
        {
          x: (fx * fLong + right.x * fLat) * dt,
          y: (fy * fLong + right.y * fLat) * dt,
          z: (fz * fLong + right.z * fLat) * dt,
        },
        contact,
        true,
      );

      const side = this.points[i].x < 0 ? 0 : 1;
      sideSpeed[side] += vel.x * fx + vel.y * fy + vel.z * fz;
      sideCount[side]++;
    }
    this.grounded = grounded / this.points.length;
    for (const s of [0, 1]) this.trackSpeed[s] = sideCount[s] ? sideSpeed[s] / sideCount[s] : this.trackSpeed[s] * 0.95;
  }

  /** Hull pose for rendering. */
  pose(outPos: THREE.Vector3, outQuat: THREE.Quaternion) {
    const t = this.body.translation(), r = this.body.rotation();
    outPos.set(t.x, t.y, t.z);
    outQuat.set(r.x, r.y, r.z, r.w);
  }
}

/** Keep `v` within `lead` of `around`. */
function clampAround(v: number, around: number, lead: number) {
  return Math.max(around - lead, Math.min(around + lead, v));
}

function clamp(v: number, limit: number) {
  return v > limit ? limit : v < -limit ? -limit : v;
}
