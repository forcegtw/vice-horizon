// Tuning tables for Vice Horizon. Every gameplay-flavoured constant lives here so
// systems stay small and rebalancing never touches loop code. The file is
// deliberately dependency-free: any module can import it without forming a cycle.
// Units are spelled out in the key name wherever ambiguity is possible (MS =
// seconds, the rest is metres / metres-per-second at street scale).

export const WORLD = {
  blocks: 10,          // the street grid is blocks x blocks cells
  lotSize: 84,         // metres per cell, road and sidewalks included
  roadWidth: 16,
  sidewalk: 3,
  dayLength: 165,      // seconds for one full day-night sweep
};

export const PLAYER = {
  walkSpeed: 8,
  runSpeed: 14,        // sprint speed; has to outpace TRAFFIC.carSpeed feel checks
  radius: 0.55,
  height: 1.7,
  maxHealth: 100,
  maxArmor: 100,
  armorAbsorb: 0.7,    // share of incoming damage armor soaks before health pays
};

// Arcade car physics. maxSpeed pairs with economy's speedMultiplier (+18% engine
// tune); grip and turnRate decide how hard a corner the getaway can hold at speed.
export const CAR = {
  accel: 16,
  brake: 26,
  maxSpeed: 38,        // ~137 km/h at this scale: getaway-fast, still controllable
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

// Chase camera: boom length and height on foot vs driving, plus the
// speed-reactive FOV push used on the highway.
export const CAMERA = {
  footBack: 5.8,
  footHeight: 3.0,
  carBack: 10.0,
  carHeight: 4.7,
  baseFov: 62,
  speedFovPush: 12,    // extra degrees added at top speed
  fovLerp: 4,          // per-second rate the push eases in with
};

// Player-car headlight rig (built by attachHeadlights in main.js).
export const HEADLIGHTS = {
  range: 42,
  angle: 0.5,
  nightThreshold: 0.25, // lamps come on once dayAmt drops under this
  onIntensity: 320,
};

// Autosave cadence in seconds — the loop stores money/mission/economy on this tick.
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

// Shop menu blurbs mirror economy.js pricing; keep the two tables in step.
export const UPGRADE_HINTS = {
  speed: 'ENGINE TUNE — +18% top speed',
  plating: 'PLATING — +50 armor capacity',
};

// Collect-mission pacing lives here so missions.js stays table-free.
export const CASH_RUN = {
  caches: 4,        // caches to grab before the collect clock expires
  timeLimit: 150,   // seconds the collect clock gets
};

// Seeded PRNG (mulberry32). World generation and ?shot= replay both draw from a
// single instance, so the same seed always rebuilds the identical city.
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
