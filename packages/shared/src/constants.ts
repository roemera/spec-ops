// Starting tuning values. Change after playtesting.

// Soldier movement (m/s)
export const WALK_SPEED = 3.2;
export const SPRINT_SPEED = 5.8;
export const CROUCH_SPEED = 1.7;
export const PRONE_SPEED = 0.7;
export const JUMP_SPEED = 4.2; // m/s upward, standing only
export const ACCEL = 30; // m/s^2 toward the wanted speed on the ground
export const AIR_ACCEL = 4; // m/s^2 in the air
export const MAX_SLOPE = (50 * Math.PI) / 180; // steeper than this, you slide
export const STANCE_TIME = 0.25; // s to change stance (eye height eases over this)

// Body: capsule radius, and per-stance height (feet to top) and eye height.
export const BODY_RADIUS = 0.3;
export const STANCES = {
  stand: { height: 1.8, eye: 1.65 },
  crouch: { height: 1.2, eye: 1.05 },
  prone: { height: 0.6, eye: 0.35 },
} as const;
export type Stance = keyof typeof STANCES;
export const STANCE_LIST: Stance[] = ['stand', 'crouch', 'prone'];

// Rifle: bolt-action, scoped. Bullets are simulated with drop.
export const BULLET_SPEED = 600; // m/s muzzle velocity: slow enough that drop and lead matter at 200+ m
export const GRAVITY = 9.81;
export const BULLET_LIFETIME = 2; // s before a bullet that hit nothing is removed
export const MAG_SIZE = 5;
export const SPARE_MAGS = 4; // magazines carried besides the loaded one
export const BOLT_TIME = 1.1; // s between shots (working the bolt)
export const RELOAD_TIME = 2.6; // s to swap the magazine
export const HIP_SPREAD = (2.5 * Math.PI) / 180; // rad, unscoped (halved crouched, quartered prone)
export const SCOPE_FOV = 6; // deg vertical (about 12x)
export const SCOPE_IN_TIME = 0.18; // s to raise the scope
export const SWAY = (0.35 * Math.PI) / 180; // rad of scope drift standing (crouch 0.6x, prone 0.25x)
export const HOLD_BREATH = 4; // s you can hold your breath (Shift, scoped) to stop the sway
export const BREATH_RECOVER = 3; // s to get your breath back fully
export const RECOIL_PITCH = (1.6 * Math.PI) / 180; // rad the view kicks up per shot, settling back over RECOIL_SETTLE
export const RECOIL_SETTLE = 0.35; // s

// World
export const MAP_SIZE = 400; // m, square, centred on the origin
export const MAP_CELLS = 128; // height grid cells per side
export const FOG_NEAR = 60; // m: fog starts
export const FOG_FAR = 420; // m: nothing visible beyond

// Rendering
export const MAX_PIXEL_RATIO = 2; // cap for high-DPI screens
export const SHADOW_RANGE = 70; // m around the camera that casts sharp shadows

export const PHYSICS_HZ = 60;

// Damage
export const PLAYER_HEALTH = 100;
export const RESPAWN_DELAY = 5; // s
export const SPAWN_PROTECTION = 3; // s
export const RESULTS_TIME = 15; // s the results screen shows before the lobby
