// weather.js — the coastal sky's mood swings. A four-phase cycle (clear →
// overcast → rain → storm) drives a recycled rain cloud that tracks the player,
// road wetness (asphalt roughness/metalness so headlights smear instead of
// dying), fog density, and lightning on a dedicated flash light.
// Determinism: every random draw comes from the seeded rng, so ?shot= replays
// stay frame-stable — no Math.random on these paths.
// Ownership rule: the flash light and the fog object are touched here only; the
// module never retunes lights owned by main.js.
// Wetness trails intensity on purpose: rain can stop while the tarmac still
// glistens, and the dry-out rate sets how long that afterglow lasts.

import * as THREE from '../vendor/three.min.js';

const DROPS = 900;            // recycled rain particles
const FIELD = 130;            // rain volume width/depth around the player
const CEIL = 42;              // rain volume height
const SOAK_ROUGH = 0.18;      // asphalt roughness when drenched
const ARID_ROUGH = 0.72;      // asphalt roughness when dry
const SOAK_METAL = 0.5;       // metalness when drenched
const ARID_METAL = 0.18;      // metalness when dry
const SOAK_RATE = 0.22;       // wetness gained per second in rain
const DRY_RATE = 0.045;       // wetness lost per second after it
const WET_TARMAC = 0x14161b;  // soaked asphalt reads darker
const DRY_TARMAC = 0x1e2026;  // dry asphalt
const BOLT_POWER = 14;        // peak intensity of a lightning flash spike

// The phase ladder. label() thresholds must mirror these intensities so the
// HUD readout never disagrees with what's actually falling.
const PHASES = [
  { name: 'Clear',    intensity: 0.0,  hold: 40 },
  { name: 'Overcast', intensity: 0.15, hold: 26 },
  { name: 'Rain',     intensity: 0.6,  hold: 34 },
  { name: 'Storm',    intensity: 1.0,  hold: 22 },
];

export class Weather {
  constructor(scene, city, rng) {
    this.scene = scene;
    this.city = city;
    this.rng = rng;
    this.phase = 0;
    this.holdT = PHASES[0].hold;
    this.intensity = 0;            // smoothed rain strength 0..1
    this.wetness = 0;              // lags intensity; roads dry slowly
    this.lightningT = 3 + rng() * 6;
    this.flash = 0;                // decaying lightning spike
    this.name = PHASES[0].name;

    // Rain particles live in local space; the whole cloud is moved to the
    // player, so a recycled drop only needs a fresh spot inside the box.
    const drops = new Float32Array(DROPS * 3);
    const speeds = new Float32Array(DROPS);
    for (let i = 0; i < DROPS; i++) {
      drops[i * 3] = (rng() - 0.5) * FIELD;
      drops[i * 3 + 1] = rng() * CEIL;
      drops[i * 3 + 2] = (rng() - 0.5) * FIELD;
      speeds[i] = 26 + rng() * 18;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(drops, 3));
    this.rainVel = speeds;
    this.rain = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xa8c0e0,
      size: 0.34,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);

    // Lightning flash light, owned solely by weather.
    this.flashLight = new THREE.DirectionalLight(0xdfe8ff, 0);
    this.flashLight.position.set(40, 120, 20);
    this.flashLight.target.position.set(0, 0, 0);
    scene.add(this.flashLight, this.flashLight.target);

    // Fog baseline captured so storm haze swings stay relative.
    this.baseFogDensity = scene.fog ? scene.fog.density : 0.0038;
  }

  // Advance the phase machine; called once per frame with a player focus point.
  update(dt, player) {
    this.holdT -= dt;
    if (this.holdT <= 0) {
      this.phase = (this.phase + 1) % PHASES.length;
      const p = PHASES[this.phase];
      this.holdT = p.hold * (0.8 + this.rng() * 0.5);
      this.name = p.name;
    }
    const target = PHASES[this.phase].intensity;
    // Intensity eases fast into rain, slower back out of it.
    const ease = target > this.intensity ? 0.25 : 0.06;
    this.intensity += (target - this.intensity) * Math.min(1, dt * ease * 8);
    // Wetness saturates while raining, dries at roughly a third of that rate.
    if (this.intensity > 0.4) {
      this.wetness = Math.min(1, this.wetness + dt * SOAK_RATE);
    } else {
      this.wetness = Math.max(0, this.wetness - dt * DRY_RATE);
    }
    this._rain(dt, player);
    this._tarmac();
    this._haze(dt);
    this._bolt(dt);
  }

  _rain(dt, player) {
    const active = this.intensity > 0.12;
    this.rain.visible = active;
    if (!active) return;
    this.rain.material.opacity = Math.min(0.55, this.intensity * 0.6);
    const attr = this.rain.geometry.attributes.position;
    const arr = attr.array;
    const fall = 1 + this.intensity * 0.8;
    for (let i = 0; i < DROPS; i++) {
      let y = arr[i * 3 + 1] - this.rainVel[i] * fall * dt;
      if (y < 0) {
        y = CEIL;
        arr[i * 3] = (this.rng() - 0.5) * FIELD;
        arr[i * 3 + 2] = (this.rng() - 0.5) * FIELD;
      }
      arr[i * 3 + 1] = y;
    }
    attr.needsUpdate = true;
    // Slow sine sway so the rain volume never reads as a rigid box.
    this.rain.position.set(
      player.x + Math.sin(this.wetness * 7 + this.holdT) * 2 * this.intensity,
      0,
      player.z,
    );
  }

  _tarmac() {
    const road = this.city.road;
    if (!road || !road.material) return;
    const m = road.material;
    m.roughness = ARID_ROUGH + (SOAK_ROUGH - ARID_ROUGH) * this.wetness;
    m.metalness = ARID_METAL + (SOAK_METAL - ARID_METAL) * this.wetness;
    m.color.setHex(this.wetness > 0.3 ? WET_TARMAC : DRY_TARMAC);
  }

  _haze(dt) {
    if (!this.scene.fog) return;
    // Storm haze: up to ~1.8x baseline density, scaled by rain intensity. The
    // dt-scaled factor settles at the same rate at 30 fps and 144 fps.
    const d = this.baseFogDensity * (1 + this.intensity * 0.8);
    this.scene.fog.density += (d - this.scene.fog.density) * Math.min(1, dt * 1.2);
  }

  _bolt(dt) {
    if (this.intensity > 0.8) {
      this.lightningT -= dt;
      if (this.lightningT <= 0) {
        this.flash = 1;
        this.lightningT = 4 + this.rng() * 9;
      }
    }
    if (this.flash > 0) {
      // Double-strike flicker: sharp spike, dip, echo, then fade.
      this.flash = Math.max(0, this.flash - dt * 3.2);
      const flick = this.flash > 0.6 ? this.flash : this.flash * 0.5;
      this.flashLight.intensity = flick * BOLT_POWER;
      // Tiny lift exported so silhouettes can invert for a frame elsewhere too.
      this.scene.userData.weatherFlash = flick;
    } else {
      this.flashLight.intensity = 0;
      this.scene.userData.weatherFlash = 0;
    }
  }

  // HUD summary string.
  label() {
    if (this.intensity > 0.8) return '⛈ Storm';
    if (this.intensity > 0.3) return '🌧 Rain';
    if (this.wetness > 0.2) return '🌦 Wet roads';
    if (this.intensity > 0.05) return '☁ Overcast';
    return '☀ Clear';
  }
}
