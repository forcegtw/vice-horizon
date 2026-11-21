// Plain-node smoke harness for the sim-side systems: wanted, weather, radio,
// economy. Imports the real modules with tiny mocks (no THREE scene, no
// WebAudio, no localStorage) and walks the update paths a browser tick would,
// so import-order and TDZ failures surface without launching a browser.
// Pass signal: exit 0 and the trailing "SMOKE OK" line. (Node also prints a
// benign MODULE_TYPELESS_PACKAGE_JSON warning; it is not a failure.)
import { Wanted } from '../game/src/wanted.js';
import { Weather } from '../game/src/weather.js';
import { Radio } from '../game/src/radio.js';
import { Economy } from '../game/src/economy.js';

// --- mocks ---
const noop = () => {};
const mockScene = () => ({
  fog: { density: 0.0038, color: {} },
  userData: {},
  add: noop,
});
const mockMat = () => ({ roughness: 1, metalness: 0, color: { setHex: noop } });
const mockCity = () => ({
  half: 420,
  road: { material: mockMat() },
  roadLines: [{ axis: 'z', line: 0 }, { axis: 'x', line: 84 }],
});

// --- wanted: heat climbs per crime, decays while no cops watch, clears ---
const state = { money: 0, wanted: 0, wantedCooldown: 0 };
const sfx = { wantedUp: noop, cash: noop, pickup: noop };
const hud = { toast: (t) => console.log('toast:', t) };
const w = new Wanted(state, sfx, hud);
w.crime('carjack');
console.log('wanted after carjack:', state.wanted, 'heat', Math.round(w.heat));
w.crime('policeCarjack');
w.crime('pedHit');
console.log('wanted stack:', state.wanted);
// 60 × 0.1 s sweeps the whole decay window with no cops in sight.
const DECAY_STEPS = 60;
for (let i = 0; i < DECAY_STEPS; i++) w.update(0.1, { x: 0, z: 0 }, { units: [] }, false);
console.log('after decay (no cops):', state.wanted, 'heat', Math.round(w.heat));
w.clear('escape');
console.log('cleared:', state.wanted, w.heat);

// --- weather: a full cycle must move the road surface between dry and wet ---
import * as THREE from '../game/vendor/three.min.js';
const scene = mockScene();
const city = mockCity();
let rngVal = 0.4;
const rng = () => (rngVal = (rngVal * 9301 + 49297) % 233280 / 233280);
const weather = new Weather(scene, city, rng);
for (let i = 0; i < 600; i++) weather.update(0.1, { x: 0, z: 0 });
console.log('weather phase:', weather.name, 'intensity', weather.intensity.toFixed(2),
  'wetness', weather.wetness.toFixed(2), 'label', weather.label());
console.log('road roughness after storm cycle:', city.road.material.roughness.toFixed(2));

// --- radio: in-car state and station cycling off the sfx bus ---
const radio = new Radio(sfx);
radio.setInCar(true);
console.log('radio label in car:', radio.label());
console.log('cycle:', radio.next(), radio.next(), radio.prev());

// --- economy: ledger bound to state, tuning perks, and the shop loop ---
// (no localStorage under node — the module's load path catches that)
const eco = new Economy(scene, city, rng);
eco.bind(state);
console.log('stations built:', eco.shops.length);
eco.money = 5000;
console.log('money via getter:', eco.money);
eco.money -= 100;
console.log('after spend:', eco.money, 'state.money', state.money);
console.log('speed multiplier:', eco.speedMultiplier(), 'armor cap:', eco.armorCap());
eco.upgrades.speed = true;
console.log('tuned speed multiplier:', eco.speedMultiplier());

// --- shop proximity: standing in range opens the menu, buying applies, leaving closes ---
const shop = eco.shops[0];
const player = { x: shop.x, z: shop.z, health: 50, armor: 0 };
eco.menuOpen = false;
eco.update(0.1, player, false, player, hud);
console.log('near shop (in car):', eco.insideShop !== null);
if (eco.insideShop) {
  eco.buy('health', player, hud, sfx);
  console.log('after buy health:', player.health, 'money', eco.money);
}
eco.update(0.1, { x: 999, z: 999 }, true, { x: 999, z: 999 }, hud);
console.log('left shop:', eco.insideShop === null, 'menuOpen', eco.menuOpen);
console.log('SMOKE OK');
