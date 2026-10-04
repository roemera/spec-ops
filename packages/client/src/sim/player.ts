import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import {
  ACCEL, AIR_ACCEL, BODY_RADIUS, CROUCH_SPEED, GRAVITY, JUMP_SPEED, MAX_SLOPE, PRONE_SPEED, SLIDE, SLIDE_MIN_SPEED, SPRINT_SPEED, STANCES,
  STANCE_TIME, WALK_SPEED, type Spawn, type Stance,
} from '@spec-ops/shared';

const SKIN = 0.02; // m: the character controller's contact offset
const SCOPED_SPEED = 0.5; // fraction of normal speed while scoped

/** What the player wants this step. */
export interface MoveInput {
  forward: number; // -1..1
  right: number; // -1..1
  sprint: boolean;
  jump: boolean;
  scoped: boolean;
}

/**
 * The player's body: a capsule moved by Rapier's kinematic character controller.
 * Position is the feet. Yaw 0 faces -z; positive yaw turns left.
 */
export class PlayerSim {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;

  stance: Stance = 'stand';
  eye: number = STANCES.stand.eye; // current eye height, eases toward the stance's
  yaw = 0;
  pitch = 0;
  readonly vel = new THREE.Vector3();
  grounded = false;
  private onSteep = false;
  /** s left of a slide (crouch) or dive (prone) out of a sprint; 0 when not sliding. */
  slide = 0;
  private slideDecel = 0; // m/s^2 the slide slows by
  /** Metres walked, for footsteps and the walk cycle. */
  distance = 0;

  // Feet position at the last two physics steps, so rendering can interpolate between them.
  readonly prev = new THREE.Vector3();
  readonly pos = new THREE.Vector3();

  constructor(private world: RAPIER.World, spawn: Spawn, groundY: number) {
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, groundY + 0.05, spawn.z));
    this.collider = world.createCollider(this.shapeFor('stand'), this.body);
    this.controller = world.createCharacterController(SKIN);
    this.controller.enableAutostep(0.45, 0.2, false);
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle(MAX_SLOPE);
    this.controller.setMinSlopeSlideAngle(MAX_SLOPE);
    this.controller.setApplyImpulsesToDynamicBodies(false);
    this.yaw = spawn.rotY;
    this.pos.set(spawn.x, groundY + 0.05, spawn.z);
    this.prev.copy(this.pos);
  }

  /** A capsule standing on the feet (prone: a ball, low enough to hide behind a log). */
  private shapeFor(stance: Stance) {
    const h = STANCES[stance].height, half = Math.max(0, h / 2 - BODY_RADIUS);
    const desc = half > 0 ? RAPIER.ColliderDesc.capsule(half, BODY_RADIUS) : RAPIER.ColliderDesc.ball(BODY_RADIUS);
    return desc.setTranslation(0, h / 2, 0);
  }

  /** Change stance. Standing up under something fails; returns whether it changed. */
  setStance(stance: Stance): boolean {
    if (stance === this.stance) return true;
    if (STANCES[stance].height > STANCES[this.stance].height) {
      const h = STANCES[stance].height, half = Math.max(0, h / 2 - BODY_RADIUS);
      const shape = half > 0 ? new RAPIER.Capsule(half, BODY_RADIUS - 0.03) : new RAPIER.Ball(BODY_RADIUS - 0.03);
      const p = this.body.translation();
      let blocked = false;
      this.world.intersectionsWithShape({ x: p.x, y: p.y + h / 2 + 0.05, z: p.z }, { x: 0, y: 0, z: 0, w: 1 }, shape, () => {
        blocked = true;
        return false;
      }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, this.body);
      if (blocked) return false;
    }
    this.stance = stance;
    const desc = this.shapeFor(stance);
    this.collider.setShape(desc.shape);
    this.collider.setTranslationWrtParent(desc.translation);
    return true;
  }

  /**
   * Drop into a crouch slide or a prone dive, keeping the sprint's direction at a burst of speed.
   * Only on the ground, standing and going fast; returns whether it started.
   */
  startSlide(stance: 'crouch' | 'prone'): boolean {
    const v = this.speed;
    if (!this.grounded || this.stance !== 'stand' || v < SLIDE_MIN_SPEED || !this.setStance(stance)) return false;
    const { speed, time } = SLIDE[stance];
    this.vel.x *= speed / v;
    this.vel.z *= speed / v;
    this.slide = time;
    this.slideDecel = (speed - (stance === 'prone' ? PRONE_SPEED : CROUCH_SPEED)) / time;
    return true;
  }

  /** Move to a spawn point now (no interpolation from where we were). */
  teleport(spawn: Spawn, groundY: number) {
    this.body.setTranslation({ x: spawn.x, y: groundY + 0.05, z: spawn.z }, true);
    this.body.setNextKinematicTranslation({ x: spawn.x, y: groundY + 0.05, z: spawn.z });
    this.pos.set(spawn.x, groundY + 0.05, spawn.z);
    this.prev.copy(this.pos);
    this.vel.set(0, 0, 0);
    this.yaw = spawn.rotY;
    this.pitch = 0;
    this.slide = 0;
    this.setStance('stand');
  }

  /** Top speed for the current stance and input. */
  speedFor(input: MoveInput) {
    const base = this.stance === 'prone' ? PRONE_SPEED : this.stance === 'crouch' ? CROUCH_SPEED : WALK_SPEED;
    if (input.scoped) return base * SCOPED_SPEED;
    // Sprint: standing, and mostly forward.
    if (input.sprint && this.stance === 'stand' && input.forward > 0.5) return SPRINT_SPEED;
    return base;
  }

  step(dt: number, input: MoveInput) {
    this.prev.copy(this.pos);
    // Wanted horizontal velocity, in the direction you face.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = -sin * input.forward + cos * input.right;
    let wz = -cos * input.forward - sin * input.right;
    const len = Math.hypot(wx, wz);
    const speed = this.speedFor(input);
    if (len > 1) {
      wx /= len;
      wz /= len;
    }
    wx *= speed;
    wz *= speed;
    if (this.stance === 'stand') this.slide = 0; // jumped or stood up out of it
    if (this.slide > 0) {
      // Sliding: no steering, just slowing down. In the air it carries on unslowed.
      this.slide = Math.max(0, this.slide - dt);
      const v = this.speed;
      if (this.grounded && v > 0) {
        const k = Math.max(0, v - this.slideDecel * dt) / v;
        this.vel.x *= k;
        this.vel.z *= k;
      }
    } else {
      const accel = (this.grounded ? ACCEL : AIR_ACCEL) * dt;
      const dx = wx - this.vel.x, dz = wz - this.vel.z, dl = Math.hypot(dx, dz);
      const k = dl > accel ? accel / dl : 1;
      this.vel.x += dx * k;
      this.vel.z += dz * k;
    }

    if (this.grounded && input.jump && this.stance === 'stand') this.vel.y = JUMP_SPEED;
    else if (this.grounded && !this.onSteep) this.vel.y = 0;
    else this.vel.y -= GRAVITY * dt;

    // On walkable ground, move flat: the controller climbs slopes and snaps you down them. Pushing
    // down as well makes it drag you to a crawl going uphill. Too steep: gravity, so you slide.
    const want = { x: this.vel.x * dt, y: this.vel.y * dt, z: this.vel.z * dt };
    this.controller.computeColliderMovement(this.collider, want, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);
    const moved = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    // Standing on something steeper than you can climb? Read the ground's tilt straight below.
    let ny = 1;
    if (this.grounded) {
      const hit = this.world.castRayAndGetNormal(
        new RAPIER.Ray({ x: this.pos.x + moved.x, y: this.pos.y + moved.y + 0.3, z: this.pos.z + moved.z }, { x: 0, y: -1, z: 0 }),
        0.8, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, this.body,
      );
      if (hit) ny = hit.normal.y;
    }
    this.onSteep = this.grounded && ny < Math.cos(MAX_SLOPE);
    // In the air, blocked sideways: lose that speed. (On the ground the wanted speed takes over
    // within a step anyway, and keeping it means a slope doesn't bleed you to a crawl.)
    if (dt > 0 && !this.grounded) {
      this.vel.x = moved.x / dt;
      this.vel.z = moved.z / dt;
    }
    if (this.vel.y > 0 && moved.y < want.y - 1e-4) this.vel.y = 0; // head hit something
    this.pos.set(this.pos.x + moved.x, this.pos.y + moved.y, this.pos.z + moved.z);
    this.body.setNextKinematicTranslation(this.pos);
    if (this.grounded) this.distance += Math.hypot(moved.x, moved.z);

    // Eye height eases to the stance over STANCE_TIME.
    const target = STANCES[this.stance].eye;
    const rate = (STANCES.stand.eye - STANCES.prone.eye) / STANCE_TIME;
    this.eye += Math.max(-rate * dt, Math.min(rate * dt, target - this.eye));
  }

  /** Horizontal speed, m/s. */
  get speed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** Feet position for rendering, `alpha` of the way from the previous physics step to the current. */
  feet(alpha: number, out = new THREE.Vector3()) {
    return out.lerpVectors(this.prev, this.pos, alpha);
  }
}
