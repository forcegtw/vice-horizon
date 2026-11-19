// Central tuning constants for Vice Horizon. Everything gameplay-flavoured lives here so
// systems stay small and the feel can be adjusted in one place.
// Keep this file dependency-free so every module can import it without cycles.
// Units are explicit in names where ambiguity is possible (MS, MPS).
// Camera boom lengths, FOV push and headlight thresholds live here too, so a
// controller-user retune never touches loop code.
export const WORLD = {
  blocks: 10,          // city is blocks x blocks of streets and lots
  lotSize: 84,         // metres per block cell
  roadWidth: 16,
  sidewalk: 3,
  dayLength: 165,      // seconds for a full day-night cycle (was 150 — 2.2 in-game days/5 min felt rushed)
};

export const PLAYER = {
  walkSpeed: 8,
  runSpeed: 14,
  radius: 0.55,
  height: 1.7,
  maxHealth: 100,
  maxArmor: 100,
};

export const CAR = {
  accel: 16,
  brake: 26,
  maxSpeed: 38,        // ~137 km/h at this scale: fast enough to feel like a getaway
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

// Chase camera: distance/height on foot vs in car, plus the speed-reactive FOV push.
export const CAMERA = {
  footBack: 5.8,
  footHeight: 3.0,
  carBack: 10.0,
  carHeight: 4.7,
  baseFov: 62,
  speedFovPush: 12,    // extra degrees at max speed
  fovLerp: 4,          // per-second lerp rate for the push
};

// Player car headlight rig (see attachHeadlights in main.js).
export const HEADLIGHTS = {
  range: 42,
  angle: 0.5,
  nightThreshold: 0.25, // dayAmt below this switches them on
  onIntensity: 320,
};

// Autosave cadence, seconds — the loop stores money/mission/economy on this tick.
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

// Save schema version — bump when the persisted shape changes (see save.js).
export const SAVE_SCHEMA_VERSION = 2;

// Deterministic RNG (mulberry32) shared by world gen and ?shot= replay.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
