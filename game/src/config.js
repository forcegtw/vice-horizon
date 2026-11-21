// config.js — the single tuning surface for Vice Horizon.
//
// Rules of the house:
//   * No imports, no DOM, no three.js. Any module can pull this in without
//     worrying about cycles, and the node smoke harness can load it cold.
//   * The numbers are a family, not independent knobs: street pitch pairs with
//     camera booms, car speed pairs with cop shooting ranges, day length pairs
//     with the ?shot= staging clocks (shots.js duplicates WORLD_DAY on
//     purpose). Move one and eyeball its neighbours before shipping.
//
// All exports are frozen so nothing can silently retune the game at runtime.

// Street-grid geometry and the world clock. One "lot" cell = road plus two
// sidewalks plus the buildable interior; the whole grid spans blocks x blocks.
export const WORLD = Object.freeze({
  blocks: 10,
  lotSize: 84,
  roadWidth: 16,
  sidewalk: 3,
  dayLength: 165,
});

// On-foot body: movement feel, collision size, and how damage splits between
// armor and health. Armor eats its share first, health takes the rest.
export const PLAYER = Object.freeze({
  walkSpeed: 8,
  runSpeed: 14,
  radius: 0.55,
  height: 1.7,
  maxHealth: 100,
  maxArmor: 100,
  armorAbsorb: 0.7,
});

// The getaway car. maxSpeed is the base the economy module's engine tune
// multiplies (+18%); accel/brake/turnRate/grip together decide how the car
// takes a corner at speed. Tweak them in pairs, not solo.
export const CAR = Object.freeze({
  accel: 16,
  brake: 26,
  maxSpeed: 38,
  reverseSpeed: 10,
  drag: 0.9,
  turnRate: 1.9,
  grip: 3.2,
  radius: 1.4,
  health: 100,
});

// Ambient population density: how many lane-loop cars and sidewalk walkers
// share the streets with you.
export const TRAFFIC = Object.freeze({
  carCount: 26,
  pedCount: 42,
  carSpeed: 9,
  pedSpeed: 1.6,
});

// Law enforcement: how many stars exist, how many cruisers each star buys,
// and the pursuit envelope (spot, shoot, fire cadence, cooldown after calm).
export const POLICE = Object.freeze({
  maxWanted: 5,
  copsPerStar: 2,
  sightRange: 46,
  shootRange: 30,
  fireInterval: 0.9,
  damage: 7,
  despawnCooldown: 12,
});

// Chase camera: boom length/height differ on foot vs behind the wheel, and a
// speed-reactive FOV push sells the sense of velocity at top speed.
export const CAMERA = Object.freeze({
  footBack: 5.8,
  footHeight: 3.0,
  carBack: 10.0,
  carHeight: 4.7,
  baseFov: 62,
  speedFovPush: 12,
  fovLerp: 4,
});

// Headlight rig for whatever car the player is driving. main.js reads these
// when building the two SpotLights per stolen vehicle.
export const HEADLIGHTS = Object.freeze({
  range: 42,
  angle: 0.5,
  nightThreshold: 0.25,
  onIntensity: 320,
});

// Ledger autosave cadence in seconds of gameplay.
export const AUTOSAVE_SECONDS = 10;

// Arsenal. rate = seconds between shots; auto = hold-to-fire.
export const WEAPONS = Object.freeze([
  { id: 'fist', name: 'Fists', damage: 10, rate: 0.45, range: 2.2, auto: false },
  { id: 'pistol', name: 'Pistol', damage: 22, rate: 0.28, range: 42, auto: false },
  { id: 'smg', name: 'SMG', damage: 12, rate: 0.09, range: 34, auto: true },
]);

// Story chain. kinds map onto mission-type branches in missions.js; rewards
// land through mission.collectReward(state) — the single writer for story cash.
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

// localStorage bucket for the main save (money + story index).
export const SAVE_KEY = 'vice-horizon-save-v1';

// Shop copy for the gas-station menu. economy.js holds the prices — when you
// touch a price or its label here, mirror the change there.
export const UPGRADE_HINTS = Object.freeze({
  speed: 'ENGINE TUNE — +18% top speed',
  plating: 'PLATING — +50 armor capacity',
});

// Cash-cache mission pacing (kept here so missions.js stays layout-only).
export const CASH_RUN = Object.freeze({
  caches: 4,
  timeLimit: 150,
});

// Save schema generation. Bumping it triggers the v1->v2 migration in save.js.
export const SAVE_SCHEMA_VERSION = 2;

// Seeded uniform generator (mulberry32). Every random decision in world
// generation, traffic layout and shot staging flows through one instance of
// this, so seed N always rebuilds the identical city. The four shift/add
// constants are the published mulberry32 constants — swapping any of them
// changes every saved/replayed layout, so leave them as they are.
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
