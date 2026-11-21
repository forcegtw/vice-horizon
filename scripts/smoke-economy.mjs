// Node smoke test: pulls in the systems batch with duck-typed mocks and
// drives every update path a browser would, so TDZ and runtime slips surface
// here rather than mid-play. Wanted heat -> stars -> decay -> clear, a full
// Weather storm cycle, Radio station cycling, and Economy money/upgrades/
// shop proximity with an actual buy.

import { Wanted } from '../game/src/wanted.js';
import { Weather } from '../game/src/weather.js';
import { Radio } from '../game/src/radio.js';
import { Economy } from '../game/src/economy.js';
import * as THREE from '../game/vendor/three.min.js';

// Fixed rng stand-in: a deterministic LCG so the smoke run is reproducible.
let rngVal = 0.4;
function smokeRng() {
  return (rngVal = (rngVal * 9301 + 49297) % 233280 / 233280);
}

// --- mocks (duck-typed to what each module touches) ---
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

// ---- wanted: crime -> heat -> stars -> decay -> clear ----
const state = { money: 0, wanted: 0, wantedCooldown: 0 };
const sfx = { wantedUp: noop, cash: noop, pickup: noop };
const hud = { toast: (t) => console.log('toast:', t) };
const w = new Wanted(state, sfx, hud);
w.crime('carjack');
console.log('wanted after carjack:', state.wanted, 'heat', Math.round(w.heat));
w.crime('policeCarjack');
w.crime('pedHit');
console.log('wanted stack:', state.wanted);
// Six seconds of decay with no cops in sight should bleed the heat off.
const DECAY_DT = 0.1;
const decayFrames = 60;
for (let i = 0; i < decayFrames; i++) w.update(DECAY_DT, { x: 0, z: 0 }, { units: [] }, false);
console.log('after decay (no cops):', state.wanted, 'heat', Math.round(w.heat));
w.clear('escape');
console.log('cleared:', state.wanted, w.heat);

// ---- weather: fast-forward through a full change cycle (600 frames ≈ 60 s) ----
const WEATHER_FRAMES = 600;
const scene = mockScene();
const city = mockCity();
const rng = smokeRng;
const weather = new Weather(scene, city, rng);
for (let i = 0; i < WEATHER_FRAMES; i++) weather.update(0.1, { x: 0, z: 0 });
console.log('weather phase:', weather.name, 'intensity', weather.intensity.toFixed(2),
  'wetness', weather.wetness.toFixed(2), 'label', weather.label());
console.log('road roughness after storm cycle:', city.road.material.roughness.toFixed(2));

// ---- radio: labels and station cycling ----
const radio = new Radio(sfx);
radio.setInCar(true);
console.log('radio label in car:', radio.label());
console.log('cycle:', radio.next(), radio.next(), radio.prev());

// ---- economy (no localStorage in node — _load's catch handles it) ----
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

// ---- shop proximity flow: drive in, buy, drive away ----
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
