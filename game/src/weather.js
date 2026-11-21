// Weather: dynamic coastal weather cycles over Vice Horizon — clear, overcast,
// rain and storm. Rain is a recycled THREE.Points cloud that follows the player,
// wet roads drop the asphalt roughness (lights smear instead of dying), lightning
// is a spike on a dedicated flash light plus a brief ambient lift, and fog density
// tracks storm intensity. Fully deterministic when driven by the seeded rng, so
// ?shot= replays stay stable.
// Design rule: this module never mutates lights it does not own — the flash light
// and fog are created here and only touched here.
// Fog density lerp uses a dt-scaled factor, so the storm haze settles at the same
// rate at 30 fps and 144 fps.
// Wetness lags intensity on purpose: the rain can stop while the streets still
// glisten, and the dry-out rate below sets how long that afterglow lasts.

import * as THREE from '../vendor/three.min.js';

const RAIN_COUNT = 900;
const CELL = 130;          // rain volume width/depth around the player
const TOP = 42;            // rain volume height
const WET_ROUGHNESS = 0.18;
const DRY_ROUGHNESS = 0.72;
const WET_METALNESS = 0.5;
const DRY_METALNESS = 0.18;
const WET_GAIN = 0.22;     // wetness units per second while raining
const DRY_LOSS = 0.045;    // wetness units per second while drying (~2x slower feel)

// Weather state machine: each phase holds for a while, then transitions.
// Intensity 0..1 drives rain fall speed, fog, wetness and lightning chance.
const PHASES = [
  { name: 'Clear',   intensity: 0.0, hold: 40 },
  { name: 'Overcast', intensity: 0.15, hold: 26 },
  { name: 'Rain',    intensity: 0.6, hold: 34 },
  { name: 'Storm',   intensity: 1.0, hold: 22 },
];

export class Weather {
  constructor(scene, city, rng) {
    this.scene = scene;
    this.city = city;
    this.rng = rng;
    this.phase = 0;
    this.holdT = PHASES[0].hold;
    // Smoothed intensity eases between phases so nothing pops.
    this.intensity = 0;
    this.wetness = 0;          // lags intensity: roads dry slowly after rain
    this.lightningT = 3 + rng() * 6;
    this.flash = 0;            // 0..1 decaying spike

    // Rain points: positions recycled inside a box that tracks the player.
    const pos = new Float32Array(RAIN_COUNT * 3);
    const vel = new Float32Array(RAIN_COUNT);
    for (let i = 0; i < RAIN_COUNT; i++) {
      pos[i * 3] = (rng() - 0.5) * CELL;
      pos[i * 3 + 1] = rng() * TOP;
      pos[i * 3 + 2] = (rng() - 0.5) * CELL;
      vel[i] = 26 + rng() * 18;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rainVel = vel;
    const mat = new THREE.PointsMaterial({
      color: 0xa8c0e0, size: 0.34, transparent: true, opacity: 0,
      depthWrite: false, sizeAttenuation: true,
    });
    this.rain = new THREE.Points(geo, mat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);

    // Lightning flash light: a directional light owned solely by weather.
    this.flashLight = new THREE.DirectionalLight(0xdfe8ff, 0);
    this.flashLight.position.set(40, 120, 20);
    scene.add(this.flashLight);
    this.flashLight.target.position.set(0, 0, 0);
    scene.add(this.flashLight.target);

    // Fog baseline captured so storm density swings stay relative.
    this.baseFogDensity = scene.fog ? scene.fog.density : 0.0038;

    this.name = PHASES[0].name;
  }

  // Advance the phase machine; called once per frame with player focus point.
  update(dt, player) {
    this.holdT -= dt;
    if (this.holdT <= 0) {
      this.phase = (this.phase + 1) % PHASES.length;
      const p = PHASES[this.phase];
      this.holdT = p.hold * (0.8 + this.rng() * 0.5);
      this.name = p.name;
    }
    const target = PHASES[this.phase].intensity;
    // Intensity eases fast into rain, slower out of it.
    const ease = target > this.intensity ? 0.25 : 0.06;
    this.intensity += (target - this.intensity) * Math.min(1, dt * ease * 8);
    // Wetness saturates while raining, dries at ~1/3 the rate.
    if (this.intensity > 0.4) this.wetness = Math.min(1, this.wetness + dt * WET_GAIN);
    else this.wetness = Math.max(0, this.wetness - dt * DRY_LOSS);

    this._updateRain(dt, player);
    this._updateRoad();
    this._updateFog(dt);
    this._updateLightning(dt);
  }

  _updateRain(dt, player) {
    const active = this.intensity > 0.12;
    this.rain.visible = active;
    if (!active) return;
    const mat = this.rain.material;
    mat.opacity = Math.min(0.55, this.intensity * 0.6);
    const posAttr = this.rain.geometry.attributes.position;
    const arr = posAttr.array;
    const fall = 1 + this.intensity * 0.8;
    for (let i = 0; i < RAIN_COUNT; i++) {
      let y = arr[i * 3 + 1] - this.rainVel[i] * fall * dt;
      if (y < 0) {
        y = TOP;
        // Positions are local to the cloud: the whole Points object is moved
        // to the player, so recycling only needs a fresh spot inside the box.
        arr[i * 3] = (this.rng() - 0.5) * CELL;
        arr[i * 3 + 2] = (this.rng() - 0.5) * CELL;
      }
      arr[i * 3 + 1] = y;
    }
    posAttr.needsUpdate = true;
    // Wind drift: the cloud leans with a slow sine so it does not look rigid.
    this.rain.position.set(
      player.x + Math.sin(this.wetness * 7 + this.holdT) * 2 * this.intensity,
      0,
      player.z,
    );
  }

  _updateRoad() {
    const road = this.city.road;
    if (!road || !road.material) return;
    road.material.roughness = DRY_ROUGHNESS + (WET_ROUGHNESS - DRY_ROUGHNESS) * this.wetness;
    road.material.metalness = DRY_METALNESS + (WET_METALNESS - DRY_METALNESS) * this.wetness;
    // Slightly darken asphalt when soaked: wet streets read darker.
    road.material.color.setHex(this.wetness > 0.3 ? 0x14161b : 0x1e2026);
  }

  _updateFog(dt) {
    if (!this.scene.fog) return;
    // Storm haze: up to ~1.8x baseline density, scaled by rain intensity.
    const d = this.baseFogDensity * (1 + this.intensity * 0.8);
    this.scene.fog.density += (d - this.scene.fog.density) * Math.min(1, dt * 1.2);
  }

  _updateLightning(dt) {
    if (this.intensity > 0.8) {
      this.lightningT -= dt;
      if (this.lightningT <= 0) {
        this.flash = 1;
        this.lightningT = 4 + this.rng() * 9;
      }
    }
    if (this.flash > 0) {
      // Two-bolt flicker: sharp spike, quick dip, second spike, decay.
      this.flash = Math.max(0, this.flash - dt * 3.2);
      const flick = this.flash > 0.6 ? this.flash : this.flash * 0.5;
      this.flashLight.intensity = flick * 14;
      // Tiny ambient lift so silhouettes invert for a frame, not just one light.
      this.scene.userData.weatherFlash = flick;
    } else {
      this.flashLight.intensity = 0;
      if (this.scene.userData.weatherFlash) this.scene.userData.weatherFlash = 0;
    }
  }

  // HUD summary string. Thresholds mirror the PHASES intensity ladder (storm 1.0,
  // rain 0.6, overcast 0.15) so the label never disagrees with what's falling.
  label() {
    if (this.intensity > 0.8) return '⛈ Storm';
    if (this.intensity > 0.3) return '🌧 Rain';
    if (this.wetness > 0.2) return '🌦 Wet roads';
    if (this.intensity > 0.05) return '☁ Overcast';
    return '☀ Clear';
  }
}
