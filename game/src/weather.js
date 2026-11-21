// weather.js — the coastal atmosphere cycle: Clear → Overcast → Rain → Storm.
//
// A looping phase machine advances on randomized hold timers drawn from the
// seeded rng, so a fixed ?seed=N replays the identical weather history. Two
// smoothed scalars carry the look:
//   - intensity (0..1): rain sheet opacity/fall speed, fog thickening, and
//     the lightning chance once a storm is fully in.
//   - wetness (lags intensity): the road material's roughness/metalness, so
//     wet asphalt smears neon reflections while it rains and keeps glistening
//     long after the sky has cleared.
//
// Ownership rule: this module creates and exclusively touches its own rain
// Points, the lightning DirectionalLight, and the scene.userData.weatherFlash
// scalar. The road material is shared with city.js, so only its
// roughness/metalness/color are nudged here — never geometry or shader code.

import * as THREE from '../vendor/three.min.js';

// Rain sheet: one Points cloud of local-space drops that rides along with the
// focus body (player on foot, car when driving), so recycling a spent drop
// only needs a fresh local spot — no world-space bookkeeping.
const DROPS = 900;
const VOLUME_SPAN = 130;   // width/depth of the rain volume around the focus
const CEILING = 42;        // respawn height inside the volume
const DROP_SIZE = 0.34;
const WIND_SWAY = 2;       // metres of sinusoidal drift at full intensity

// Asphalt endpoints. Wetness blends the PBR numbers and swaps the tint once
// the surface reads visibly wet.
const ASPHALT_DRY = Object.freeze({ roughness: 0.72, metalness: 0.18, color: 0x1e2026 });
const ASPHALT_WET = Object.freeze({ roughness: 0.18, metalness: 0.5, color: 0x14161b });
const GLISTEN_MARK = 0.3;  // wetness above this reads as a wet road (and HUD copy)
const SOAK_RATE = 0.22;    // wetness units/s under heavy rain
const EVAP_RATE = 0.045;   // drying is far slower: streets glisten on after rain
const FLASH_DECAY = 3.2;   // how fast a lightning spike fades, per second
const FOG_GAIN = 0.8;      // how much rain thickens the boot fog density

// Phase ladder. Hold seconds are randomized ±(0.8..1.3x) on every entry, so
// no two days of weather feel identical even on the same seed.
const CYCLE = Object.freeze([
  { name: 'Clear',    intensity: 0.0,  hold: 40 },
  { name: 'Overcast', intensity: 0.15, hold: 26 },
  { name: 'Rain',     intensity: 0.6,  hold: 34 },
  { name: 'Storm',    intensity: 1.0,  hold: 22 },
]);

export class Weather {
  constructor(scene, city, rng) {
    this.scene = scene;
    this.city = city;
    this.rng = rng;
    this.phaseIndex = 0;
    this.holdT = CYCLE[0].hold;
    this.intensity = 0;          // smoothed 0..1
    this.wetness = 0;            // lags intensity
    this.lightningT = 3 + rng() * 6;
    this.flash = 0;              // decaying 0..1 spike
    this.name = CYCLE[0].name;

    // Drop cloud: positions are local to the Points object; velocities live
    // in a parallel array so the fall never reallocates.
    const pos = new Float32Array(DROPS * 3);
    const vel = new Float32Array(DROPS);
    for (let i = 0; i < DROPS; i++) {
      pos[i * 3] = (rng() - 0.5) * VOLUME_SPAN;
      pos[i * 3 + 1] = rng() * CEILING;
      pos[i * 3 + 2] = (rng() - 0.5) * VOLUME_SPAN;
      vel[i] = 26 + rng() * 18;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rainVel = vel;
    this.rainMat = new THREE.PointsMaterial({
      color: 0xa8c0e0,
      size: DROP_SIZE,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.rain = new THREE.Points(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);

    // Lightning owns a dedicated directional light; nothing else writes to it.
    this.flashLight = new THREE.DirectionalLight(0xdfe8ff, 0);
    this.flashLight.position.set(40, 120, 20);
    scene.add(this.flashLight);
    scene.add(this.flashLight.target);
    this.flashLight.target.position.set(0, 0, 0);

    // The fog swing stays relative to whatever env.js staged at boot.
    this.baseFogDensity = scene.fog ? scene.fog.density : 0.0038;
  }

  // Advance the phase machine and every visual subsystem. `player` is the
  // focus point the rain volume follows (the car while driving).
  update(dt, player) {
    this._advanceClock(dt);
    this._settleIntensity(dt);
    this._settleWetness(dt);
    this._fallDrops(dt, player);
    this._tintRoad();
    this._thickenFog(dt);
    this._strikeBolts(dt);
  }

  // Phase timer with jittered holds.
  _advanceClock(dt) {
    this.holdT -= dt;
    if (this.holdT > 0) return;
    this.phaseIndex = (this.phaseIndex + 1) % CYCLE.length;
    const phase = CYCLE[this.phaseIndex];
    this.holdT = phase.hold * (0.8 + this.rng() * 0.5);
    this.name = phase.name;
  }

  // Intensity eases quickly into bad weather, slowly back out of it.
  _settleIntensity(dt) {
    const target = CYCLE[this.phaseIndex].intensity;
    const rate = target > this.intensity ? 0.25 : 0.06;
    this.intensity += (target - this.intensity) * Math.min(1, dt * rate * 8);
  }

  // Wetness saturates under heavy rain and dries at roughly a third the rate.
  _settleWetness(dt) {
    if (this.intensity > 0.4) {
      this.wetness = Math.min(1, this.wetness + dt * SOAK_RATE);
    } else {
      this.wetness = Math.max(0, this.wetness - dt * EVAP_RATE);
    }
  }

  _fallDrops(dt, player) {
    const active = this.intensity > 0.12;
    this.rain.visible = active;
    if (!active) return;
    this.rainMat.opacity = Math.min(0.55, this.intensity * 0.6);
    const attr = this.rain.geometry.attributes.position;
    const arr = attr.array;
    const fall = 1 + this.intensity * 0.8;
    for (let i = 0; i < DROPS; i++) {
      let y = arr[i * 3 + 1] - this.rainVel[i] * fall * dt;
      if (y < 0) {
        y = CEILING;
        arr[i * 3] = (this.rng() - 0.5) * VOLUME_SPAN;
        arr[i * 3 + 2] = (this.rng() - 0.5) * VOLUME_SPAN;
      }
      arr[i * 3 + 1] = y;
    }
    attr.needsUpdate = true;
    // Slow sinusoidal wind drift so the sheet never reads as a rigid plane.
    const drift = Math.sin(this.wetness * 7 + this.holdT) * WIND_SWAY * this.intensity;
    this.rain.position.set(player.x + drift, 0, player.z);
  }

  _tintRoad() {
    const road = this.city.road;
    if (!road || !road.material) return;
    const m = road.material;
    m.roughness = ASPHALT_DRY.roughness + (ASPHALT_WET.roughness - ASPHALT_DRY.roughness) * this.wetness;
    m.metalness = ASPHALT_DRY.metalness + (ASPHALT_WET.metalness - ASPHALT_DRY.metalness) * this.wetness;
    m.color.setHex(this.wetness > GLISTEN_MARK ? ASPHALT_WET.color : ASPHALT_DRY.color);
  }

  _thickenFog(dt) {
    if (!this.scene.fog) return;
    const target = this.baseFogDensity * (1 + this.intensity * FOG_GAIN);
    this.scene.fog.density += (target - this.scene.fog.density) * Math.min(1, dt * 1.2);
  }

  _strikeBolts(dt) {
    if (this.intensity > 0.8) {
      this.lightningT -= dt;
      if (this.lightningT <= 0) {
        this.flash = 1;
        this.lightningT = 4 + this.rng() * 9;
      }
    }
    if (this.flash > 0) {
      // Two-bolt flicker: sharp spike, dip, second spike, then decay.
      this.flash = Math.max(0, this.flash - dt * FLASH_DECAY);
      const flick = this.flash > 0.6 ? this.flash : this.flash * 0.5;
      this.flashLight.intensity = flick * 14;
      this.scene.userData.weatherFlash = flick;
    } else {
      this.flashLight.intensity = 0;
      this.scene.userData.weatherFlash = 0;
    }
  }

  // HUD label. Thresholds mirror the CYCLE intensities so the copy always
  // agrees with what is actually falling from the sky.
  label() {
    if (this.intensity > 0.8) return '⛈ Storm';
    if (this.intensity > 0.3) return '🌧 Rain';
    if (this.wetness > 0.2) return '🌦 Wet roads';
    if (this.intensity > 0.05) return '☁ Overcast';
    return '☀ Clear';
  }

  // True while the rain sheet is visibly falling (audio hooks read this).
  get raining() { return this.intensity > 0.12; }
}
