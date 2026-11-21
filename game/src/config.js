// config.js — the single tuning table for Vice Horizon.
// Every gameplay-flavoured number lives here so systems stay small and rebalancing
// never means hunting through loop code. The file deliberately imports nothing:
// every other module (and both node smoke harnesses) can pull from it without
// creating an import cycle. Unit-bearing names carry their unit in the key (MS, MPS).

export const WORLD = {
  blocks: 10,          // city grid is blocks x blocks street cells
  lotSize: 84,         // metres per cell, street centre to street centre
  roadWidth: 16,
  sidewalk: 3,
  dayLength: 165,      // seconds per day-night cycle; shots.js mirrors it as WORLD_DAY
};

export const PLAYER = {
  walkSpeed: 8,
  runSpeed: 14,        // Shift sprint; keep above traffic feel checks
  radius: 0.55,
  height: 1.7,
  maxHealth: 100,
  maxArmor: 100,
  armorAbsorb: 0.7,    // share of incoming damage armor eats before health pays
};

// Arcade car handling. maxSpeed partners with economy's engine tune (+18%);
// grip and turnRate decide how hard a corner the getaway can hold at speed.
export const CAR = {
  accel: 16,
  brake: 26,
  maxSpeed: 38,        // ~137 km/h at city scale
  reverseSpeed: 10,
  drag: 0.9,
  turnRate: 1.9,
  grip: 3.2,
  radius: 1.4,
  health: 100,
};

export const TRAFFIC = {
  carCount: 26,
  pedCount: 42,
  carSpeed: 9,
  pedSpeed: 1.6,
};

export const POLICE = {
  maxWanted: 5,
  copsPerStar: 2,
  sightRange: 46,
  shootRange: 30,
  fireInterval: 0.9,
  damage: 7,
  despawnCooldown: 12,
};

// Chase camera: boom length/height on foot vs in a car, plus the speed-reactive
// FOV push. Retuning a controller feel pass never needs to touch loop code.
export const CAMERA = {
  footBack: 5.8,
  footHeight: 3.0,
  carBack: 10.0,
  carHeight: 4.7,
  baseFov: 62,
  speedFovPush: 12,    // extra degrees at top speed
  fovLerp: 4,          // per-second approach rate for the push
};

// Player car headlight rig (attached in main.js; see HEADLIGHTS.nightThreshold).
export const HEADLIGHTS = {
  range: 42,
  angle: 0.5,
  nightThreshold: 0.25, // dayAmt at or below this switches the beams on
  onIntensity: 320,
};

// Autosave cadence in seconds; the loop persists money/mission/economy on this tick.
export const AUTOSAVE_SECONDS = 10;

export const WEAPONS = [
  { id: 'fist', name: 'Fists', damage: 10, rate: 0.45, range: 2.2, auto: false },
  { id: 'pistol', name: 'Pistol', damage: 22, rate: 0.28, range: 42, auto: false },
  { id: 'smg', name: 'SMG', damage: 12, rate: 0.09, range: 34, auto: true },
];

export const MISSIONS = [
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
];

export const SAVE_KEY = 'vice-horizon-save-v1';

// Shop menu blurbs; economy.js owns the matching price table — edit the two in step.
export const UPGRADE_HINTS = {
  speed: 'ENGINE TUNE — +18% top speed',
  plating: 'PLATING — +50 armor capacity',
};

// Collect-mission pacing, kept here so missions.js stays table-free.
export const CASH_RUN = {
  caches: 4,        // cash caches to grab before the clock expires
  timeLimit: 150,   // seconds the collect clock gets
};

// Persisted save shape; bump when the fields change (save.js gates on this).
export const SAVE_SCHEMA_VERSION = 2;

// Deterministic PRNG (mulberry32) shared by world generation and ?shot= replay.
// Same seed in, identical stream out — never swap in Math.random on these paths.
export function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6D2B79F5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
