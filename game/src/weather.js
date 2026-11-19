// weather.js — coastal weather cycle for Vice Horizon: Clear → Overcast →
// Rain → Storm, on a looping phase machine driven by the seeded rng (so
// ?shot= replays stay deterministic).
//
// What each phase drives:
//   - intensity (0..1, smoothed): rain opacity and fall speed, fog density,
//     lightning chance in storms.
//   - wetness (lags intensity): road material roughness/metalness so wet
//     asphalt smears lights instead of dying, then dries slowly after rain.
//
// Ownership rule: this module creates and exclusively touches its own rain
// Points, flash DirectionalLight, and the scene.userData.weatherFlash scalar.
// The road material is shared with city.js, so weather only nudges its
// roughness/metalness/color — never geometry or shader.

import * as THREE from '../vendor/three.min.js';

const RAIN_COUNT = 900;
const RAIN_CELL = 130;    // width/depth of the rain volume around the player
const RAIN_TOP = 42;      // spawn height inside the volume
const RAIN_SIZE = 0.34;

const ROAD_DRY = { roughness: 0.72, metalness: 0.18, color: 0x1e2026 };
const ROAD_WET = { roughness: 0.18, metalness: 0.5, color: 0x14161b };
const WET_GAIN = 0.22;    // wetness units/s while raining
const DRY_LOSS = 0.045;   // drying is deliberately much slower: streets glisten on

// Phase ladder: hold seconds are randomized ±(0.8..1.3x) per entry.
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
    this.phaseIndex = 0;
    this.holdT = PHASES[0].hold;
    this.intensity = 0;          // smoothed 0..1
    this.wetness = 0;            // lags intensity
    this.lightningT = 3 + rng() * 6;
    this.flash = 0;              // decaying 0..1 spike
    this.name = PHASES[0].name;

    // Rain particle cloud: local coordinates inside the cell; the whole Points
    // object moves with the player, so recycling only needs a fresh local spot.
    const pos = new Float32Array(RAIN_COUNT * 3);
    const vel = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i++) {
      pos[i * 3] = (rng() - 0.5) * RAIN_CELL;
      pos[i * 3 + 1] = rng() * RAIN_TOP;
      pos[i * 3 + 2] = (rng() - 0.5) * RAIN_CELL;
      vel[i] = 26 + rng() * 18;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rainVel = vel;
    this.rainMat = new THREE.PointsMaterial({
      color: 0xa8c0e0,
      size: RAIN_SIZE,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.rain = new THREE.Points(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);

    // Lightning: dedicated directional light, owned only by weather.
    this.flashLight = new THREE.DirectionalLight(0xdfe8ff, 0);
    this.flashLight.position.set(40, 120, 20);
    scene.add(this.flashLight);
    scene.add(this.flashLight.target);
    this.flashLight.target.position.set(0, 0, 0);

    // Fog swing stays relative to whatever env.js set up at boot.
    this.baseFogDensity = scene.fog ? scene.fog.density : 0.0038;
  }

  // Advance the phase machine and every visual subsystem. player is the focus
  // point (the car when driving) that the rain volume follows.
  update(dt, player) {
    this.holdT -= dt;
    if (this.holdT <= 0) {
      this.phaseIndex = (this.phaseIndex + 1) % PHASES.length;
      const phase = PHASES[this.phaseIndex];
      this.holdT = phase.hold * (0.8 + this.rng() * 0.5);
      this.name = phase.name;
    }

    // Intensity eases quickly into bad weather, slowly back out of it.
    const target = PHASES[this.phaseIndex].intensity;
    const ease = target > this.intensity ? 0.25 : 0.06;
    this.intensity += (target - this.intensity) * Math.min(1, dt * ease * 8);

    // Wetness saturates while raining hard, dries at roughly a third the rate.
    if (this.intensity > 0.4) {
      this.wetness = Math.min(1, this.wetness + dt * WET_GAIN);
    } else {
      this.wetness = Math.max(0, this.wetness - dt * DRY_LOSS);
    }

    this._rain(dt, player);
    this._roads();
    this._fog(dt);
    this._lightning(dt);
  }

  _rain(dt, player) {
    const active = this.intensity > 0.12;
    this.rain.visible = active;
    if (!active) return;
    this.rainMat.opacity = Math.min(0.55, this.intensity * 0.6);
    const attr = this.rain.geometry.attributes.position;
    const arr = attr.array;
    const fall = 1 + this.intensity * 0.8;
    for (let i = 0; i < RAIN_COUNT; i++) {
      let y = arr[i * 3 + 1] - this.rainVel[i] * fall * dt;
      if (y < 0) {
        y = RAIN_TOP;
        arr[i * 3] = (this.rng() - 0.5) * RAIN_CELL;
        arr[i * 3 + 2] = (this.rng() - 0.5) * RAIN_CELL;
      }
      arr[i * 3 + 1] = y;
    }
    attr.needsUpdate = true;
    // Slow sinusoidal wind drift so the sheet never reads as rigid.
    const drift = Math.sin(this.wetness * 7 + this.holdT) * 2 * this.intensity;
    this.rain.position.set(player.x + drift, 0, player.z);
  }

  _roads() {
    const road = this.city.road;
    if (!road || !road.material) return;
    const m = road.material;
    m.roughness = ROAD_DRY.roughness + (ROAD_WET.roughness - ROAD_DRY.roughness) * this.wetness;
    m.metalness = ROAD_DRY.metalness + (ROAD_WET.metalness - ROAD_DRY.metalness) * this.wetness;
    m.color.setHex(this.wetness > 0.3 ? ROAD_WET.color : ROAD_DRY.color);
  }

  _fog(dt) {
    if (!this.scene.fog) return;
    const target = this.baseFogDensity * (1 + this.intensity * 0.8);
    this.scene.fog.density += (target - this.scene.fog.density) * Math.min(1, dt * 1.2);
  }

  _lightning(dt) {
    if (this.intensity > 0.8) {
      this.lightningT -= dt;
      if (this.lightningT <= 0) {
        this.flash = 1;
        this.lightningT = 4 + this.rng() * 9;
      }
    }
    if (this.flash > 0) {
      // Two-bolt flicker: sharp spike, dip, second spike, then decay.
      this.flash = Math.max(0, this.flash - dt * 3.2);
      const flick = this.flash > 0.6 ? this.flash : this.flash * 0.5;
      this.flashLight.intensity = flick * 14;
      this.scene.userData.weatherFlash = flick;
    } else {
      this.flashLight.intensity = 0;
      this.scene.userData.weatherFlash = 0;
    }
  }

  // HUD label. Thresholds mirror the PHASES intensity ladder so the text
  // always agrees with what is actually falling from the sky.
  label() {
    if (this.intensity > 0.8) return '⛈ Storm';
    if (this.intensity > 0.3) return '🌧 Rain';
    if (this.wetness > 0.2) return '🌦 Wet roads';
    if (this.intensity > 0.05) return '☁ Overcast';
    return '☀ Clear';
  }
}
