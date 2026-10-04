// Starting tuning values. Change after playtesting.

// Soldier movement (m/s)
export const WALK_SPEED = 3.2;
export const SPRINT_SPEED = 5.8;
export const CROUCH_SPEED = 1.7;
export const PRONE_SPEED = 0.7;
export const JUMP_SPEED = 4.2; // m/s upward, standing only
export const ACCEL = 30; // m/s^2 toward the wanted speed on the ground
export const AIR_ACCEL = 4; // m/s^2 in the air
export const MAX_SLOPE = (62 * Math.PI) / 180; // steeper than this, you slide (bare cliffs and the mountains round the map)
// Slide: C (crouch) or Z (prone, a dive) while sprinting carries you on, slowing to the stance's
// speed over the time.
export const SLIDE = {
  crouch: { speed: 7.2, time: 0.9 },
  prone: { speed: 6.4, time: 0.6 },
} as const;
export const SLIDE_MIN_SPEED = 4.5; // m/s: going at least this fast to slide
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
export const WIND_DRIFT = 1; // m/s^2 sideways push on a bullet per m/s of wind (5 m/s crosswind: ~0.5 m at 300 m)
export const MAG_SIZE = 5;
// Ammo is limited: spare rounds come from ammo boxes at the bases and off the dead.
export const START_SPARE = 15; // rounds carried besides the loaded magazine
export const MAX_SPARE = 25;
export const AMMO_BOX = 15; // rounds in a base's ammo box
export const AMMO_DROP = 6; // rounds off a body
export const MEDKIT_DROP_CHANCE = 0.6; // a body carries a medkit
export const PICKUP_RANGE = 1.6; // m from your feet: walk over it to take it
export const BOLT_TIME = 1.1; // s between shots (working the bolt)
export const RELOAD_TIME = 2.6; // s to swap the magazine
// Active reload: press R again while reloading. In the perfect zone the magazine is in at once; in the
// good zone (around it) a moment later; anywhere else it jams and takes longer. One try per reload.
export const ACTIVE_RELOAD = { good: [0.36, 0.58], perfect: [0.44, 0.5] } as const; // fractions of RELOAD_TIME
export const RELOAD_GOOD_FINISH = 0.3; // s left after a good press
export const RELOAD_JAM = 1.2; // s added by a missed press
export const HIP_SPREAD = (2.5 * Math.PI) / 180; // rad, unscoped (halved crouched, quartered prone)
export const SCOPE_FOV = 6; // deg vertical (about 12x)
export const SCOPE_IN_TIME = 0.18; // s to raise the scope
export const SWAY = (0.35 * Math.PI) / 180; // rad of scope drift standing (crouch 0.6x, prone 0.25x)
export const HOLD_BREATH = 4; // s you can hold your breath (Shift, scoped) to stop the sway
export const BREATH_RECOVER = 3; // s to get your breath back fully
export const RECOIL_PITCH = (1.6 * Math.PI) / 180; // rad the view kicks up per shot, settling back over RECOIL_SETTLE
export const RECOIL_SETTLE = 0.35; // s

// World
export const MAP_SIZE = 640; // m, square, centred on the origin (mountains take the outer 70 m)
export const MAP_CELLS = 200; // height grid cells per side (3.2 m: the low poly facet size)
export const FOG_NEAR = 60; // m: fog starts
export const FOG_FAR = 420; // m: nothing visible beyond

// Rendering
export const MAX_PIXEL_RATIO = 2; // cap for high-DPI screens
export const SHADOW_RANGE = 70; // m around the camera that casts sharp shadows

export const PHYSICS_HZ = 60;

// Damage
export const PLAYER_HEALTH = 100;
// Health doesn't come back by itself: medkits (at the bases, on bodies) and a teammate's revive.
export const MEDKIT_HEAL = 40;
export const SPAWN_PROTECTION = 3; // s
export const RESULTS_TIME = 12; // s the results screen shows before the lobby (and a new map)

// Co-op: at 0 health you go down. A teammate holding E next to you for REVIVE_TIME gets you up;
// otherwise you bleed out and are out until the next mission. No respawns.
export const BLEED_OUT = 30; // s
export const REVIVE_TIME = 3; // s holding E
export const REVIVE_RANGE = 2.2; // m
export const REVIVE_HEALTH = 50;
export const EXTRACT_RADIUS = 7; // m from the pad's centre: the squad is extracted when all standing are inside

// Enemy AI. Detection is a meter per enemy per player: it fills while they can see you, and at 1
// they are alert. Seeing is harder far away, low down, standing still, at the edge of their view,
// and through pine branches.
export const ENEMY_ID_BASE = 100; // enemy ids start here (players are 1..MAX_PLAYERS)
export const AI_HZ = 10; // decisions and network updates per second
export const ENEMY_HEALTH = 100;
export const ENEMY_DAMAGE = 0.55; // fraction of the player rifle's zone damage an enemy hit does
export const ENEMY_WALK = 1.4; // m/s patrolling
export const ENEMY_RUN = 4; // m/s when alert
export const VIEW_RANGE = 260; // m: beyond this they see nothing
export const VIEW_HALF_ANGLE = (70 * Math.PI) / 180; // field of view either side of where they look
export const DETECT_RATE = 2.9; // meter per second at close range, standing, moving, dead ahead
export const DETECT_DECAY = 0.12; // per second when they can't see or hear you
export const SUSPICIOUS_AT = 0.35; // meter level where they stop and look your way
export const FOLIAGE_SEE = 0.25; // visibility left after looking through one pine's branches (enough cover to stop them firing)
export const STANCE_SEEN = { stand: 1, crouch: 0.45, prone: 0.12 } as const;
export const HEAR_STEPS = { stand: 14, crouch: 6, prone: 2 } as const; // m footsteps carry (doubled sprinting)
export const HEAR_SHOT = 320; // m an unsuppressed rifle shot carries
export const SHOUT_RANGE = 100; // m an alert enemy's shout reaches other enemies
export const ENEMY_FIRE_RANGE = 280; // m
export const ENEMY_FIRE_INTERVAL = [0.9, 1.8] as const; // s between shots
export const ENEMY_ACCURACY = 0.6; // hit chance at close range once fully aimed at a still, standing target
export const ENEMY_AIM_TIME = 2.6; // s of keeping you in sight to reach full accuracy
