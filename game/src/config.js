// config.js — every gameplay tuning knob for Vice Horizon lives here.
// Deliberately dependency-free: any module may import it without creating a
// cycle. Numbers are tuned as a set (speeds pair with camera distances and
// city scale), so change one and check its neighbours.

// City footprint: blocks x blocks street grid, one lot per cell.
export const WORLD = Object.freeze({
  blocks: 10,        // cells per side
  lotSize: 84,       // metres across one cell (street + sidewalks + buildable)
  roadWidth: 16,     // asphalt width between sidewalks
  sidewalk: 3,       // pavement depth each side of the road
  dayLength: 165,    // seconds for one full day-night cycle
});

export const PLAYER = Object.freeze({
  walkSpeed: 8,
  runSpeed: 14,      // Shift sprint; needs to outrun traffic feel checks
  radius: 0.55,      // collision circle for resolveCircle
  height: 1.7,
  maxHealth: 100,
  maxArmor: 100,
  armorAbsorb: 0.7,  // share of incoming damage armor eats before health pays
});

// Getaway-car tuning. maxSpeed is what economy.js's engine-tune upgrade
// scales (+18%); grip and turnRate set how hard a corner survives at speed.
export const CAR = Object.freeze({
  accel: 16,
  brake: 26,
  maxSpeed: 38,      // ~137 km/h at this scale
  reverseSpeed: 10,
  drag: 0.9,
  turnRate: 1.9,
  grip: 3.2,
  radius: 1.4,       // collision circle vs building AABBs
  health: 100,
});

export const TRAFFIC = Object.freeze({
  carCount: 26,
  pedCount: 42,
  carSpeed: 9,
  pedSpeed: 1.6,
});

export const POLICE = Object.freeze({
  maxWanted: 5,      // star ceiling
  copsPerStar: 2,
  sightRange: 46,
  shootRange: 30,
  fireInterval: 0.9,
  damage: 7,
  despawnCooldown: 12,
});

// Chase-cam rig: boom length and height on foot vs driving, plus the
// speed-reactive FOV push the loop applies each frame.
export const CAMERA = Object.freeze({
  footBack: 5.8,
  footHeight: 3.0,
  carBack: 10.0,
  carHeight: 4.7,
  baseFov: 62,
  speedFovPush: 12,  // extra degrees at top speed
  fovLerp: 4,        // per-second approach rate for the push
});

// Player-car headlight rig (attachHeadlights in main.js reads these).
export const HEADLIGHTS = Object.freeze({
  range: 42,
  angle: 0.5,
  nightThreshold: 0.25, // switch on when dayAmt drops below this
  onIntensity: 320,
});

export const AUTOSAVE_SECONDS = 10;

export const WEAPONS = Object.freeze([
  { id: 'fist', name: 'Fists', damage: 10, rate: 0.45, range: 2.2, auto: false },
  { id: 'pistol', name: 'Pistol', damage: 22, rate: 0.28, range: 42, auto: false },
  { id: 'smg', name: 'SMG', damage: 12, rate: 0.09, range: 34, auto: true },
]);

export const MISSIONS = Object.freeze([
  {
    id: 'boost',
    name: 'Night Boost',
    brief: 'Boost the marked coupe and deliver it to the garage dock.',
    kind: 'car-delivery',
    reward: 750,
  },
  {
    id: 'cash-run',
    name: 'Cash Run',
    brief: 'Collect the four cash caches scattered downtown before time runs out.',
    kind: 'collect',
    reward: 900,
  },
  {
    id: 'payback',
    name: 'Payback',
    brief: 'Take out the three rival lookouts hanging around the piers.',
    kind: 'eliminate',
    reward: 1200,
  },
]);

export const SAVE_KEY = 'vice-horizon-save-v1';

// Shop menu copy mirrors economy.js prices — update both tables together.
export const UPGRADE_HINTS = Object.freeze({
  speed: 'ENGINE TUNE — +18% top speed',
  plating: 'PLATING — +50 armor capacity',
});

// Collect-mission pacing, kept out of missions.js.
export const CASH_RUN = Object.freeze({
  caches: 4,
  timeLimit: 150,
});

export const SAVE_SCHEMA_VERSION = 2;

// Deterministic RNG (mulberry32). World gen and ?shot= replay both share it,
// so a given seed always produces the identical city and traffic layout.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
