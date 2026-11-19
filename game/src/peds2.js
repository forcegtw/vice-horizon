// peds2.js — the "life" layer over the base Peds population (peds.js).
//
// This module does not own meshes or the ped cap. It decorates the existing
// ped records with behavioural state (anim tier, fear, idle browsing), runs a
// threat-sensing pass driven by the wanted level, and drives a richer rig
// animation than the base strut. main.js calls it after peds.update():
//     peds.update(...); peds2.senseThreat(...); peds2.update(...);
//
// Rules the two layers agree on:
//   - peds.js owns p.state ('walk'/'flee'/'dead'). This layer may set
//     p.state = 'flee' when fear maxes out but never touches 'dead'.
//   - PANIC_SPRINT must exceed the base FLEE_SPEED (5.2), or peds handed over
//     to the base flee branch would visibly slow down mid-panic.
//   - districtDensity() shapes where crowds feel thick: the beach strip and
//     downtown stay busy, the docks stay sparse. Values near/above 1.0 mean
//     "worth topping up", below 1.0 means "leave it thin".

import { WORLD } from './config.js';
import { HALF } from './city.js';

// Fraction of the map coordinate range, west → east.
function districtDensity(x, z) {
  const t = (x + HALF) / (HALF * 2);
  if (t < 0.25) return 1.15;                                  // boardwalk
  if (Math.abs(x) < HALF * 0.35 && Math.abs(z) < HALF * 0.35) return 1.25; // downtown core
  if (t > 0.75) return 0.6;                                   // industrial docks
  return 1.0;
}

const IDLE_CHANCE = 0.18;     // share of peds that start as window-shoppers
const IDLE_SPEED = 0.35;      // browsing shuffle speed
const PANIC_SPRINT = 6.4;     // must stay above peds.js FLEE_SPEED (5.2)
const FEAR_SPRINT_THRESHOLD = 0.75;
const FEAR_HURRY_THRESHOLD = 0.3;

// Cadence per animation tier, in stride cycles per second.
const CADENCE = { stroll: 3.2, hurry: 4.6, sprint: 6.0, idle: 1.0 };
// Arm/leg swing amplitude per tier.
const AMPLITUDE = { stroll: 0.62, hurry: 0.78, sprint: 0.62, idle: 0.08 };

export class Peds2 {
  constructor(peds, city, rng) {
    this.peds = peds;      // the Peds instance from peds.js
    this.city = city;
    this.rng = rng;
    this.playerFocus = { x: 0, z: 0 };

    // Decorate the existing records once at boot...
    for (const p of this.peds.peds) this.augment(p, rng, true);

    // ...and wrap the base spawn() so recycled peds come back with fresh
    // layer state (otherwise a former sprinter would stroll in with stale fear).
    const baseSpawn = this.peds.spawn.bind(this.peds);
    this.peds.spawn = (rngArg, rec) => {
      baseSpawn(rngArg, rec);
      this.augment(rec, rngArg, false);
      return rec;
    };
  }

  // Add/refresh the layer fields on one ped record.
  augment(p, rng, initial) {
    p.anim = 'stroll';               // stroll | hurry | sprint | idle
    p.idleT = 0;                     // seconds of browsing left
    p.fearLevel = 0;                 // 0 calm → 1 panicking, eased per frame
    p.lean = (rng() - 0.5) * 0.25;   // per-ped sway bias so idlers differ
    p.wavePhase = rng() * Math.PI * 2;
    p.density = districtDensity(p.x, p.z);
    if (initial && rng() < IDLE_CHANCE) {
      p.anim = 'idle';
      p.idleT = 4 + rng() * 10;
    }
  }

  // Threat pass: fear rises with wanted stars and closeness, and maxing out
  // hands the ped to the base flee logic. Runs every frame; math is cheap.
  senseThreat(playerPos, wanted, dt) {
    const stars = wanted || 0;
    if (stars <= 0) return;   // no heat → no sensing cost
    const radius = 14 + stars * 9;
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;
      const dx = playerPos.x - p.x;
      const dz = playerPos.z - p.z;
      const d = Math.hypot(dx, dz);
      let target = 0;
      if (d < radius) {
        target = Math.min(1, (1 - d / radius) * (0.45 + stars * 0.2));
      }
      // Panic fast, calm down slowly.
      const rate = target > p.fearLevel ? 3.5 : 1.1;
      p.fearLevel += (target - p.fearLevel) * Math.min(1, dt * rate);

      if (p.state === 'flee') continue;   // base layer already owns the sprint
      if (p.fearLevel > FEAR_SPRINT_THRESHOLD) {
        p.anim = 'sprint';
        p.heading = Math.atan2(-dx, -dz); // run away from the player
        p.speed = PANIC_SPRINT * (0.85 + this.rng() * 0.3);
        p.state = 'flee';                 // hand over; base settles at CALM_RADIUS
      } else if (p.anim === 'sprint') {
        p.anim = 'hurry';
      }
    }
  }

  // Idle browsing: stand, sway, occasionally shuffle. Returns true when the
  // ped is idling (the caller skips its own stroll/hurry logic then).
  tickIdle(p, dt) {
    if (p.anim !== 'idle') return false;
    p.idleT -= dt;
    p.speed = IDLE_SPEED;
    p.heading += p.lean * dt * 0.4;
    if (p.idleT <= 0) {
      if (this.rng() < 0.5) {
        p.anim = 'stroll';
        p.heading += (this.rng() - 0.5) * 2.4;
      } else {
        p.idleT = 3 + this.rng() * 8;
      }
    }
    return true;
  }

  // Animation pass: cadence + amplitude per tier, idle arm wave, lean.
  update(dt, playerPos, wanted) {
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;   // the fall pose belongs to peds.js
      p.density = districtDensity(p.x, p.z);

      if (!this.tickIdle(p, dt)) {
        // Decay hurry back to stroll once the fear is gone.
        if (p.anim === 'hurry' && p.state !== 'flee' && p.fearLevel < FEAR_HURRY_THRESHOLD) {
          p.anim = 'stroll';
        }
        // A few pedestrians always look busy, even in a calm city.
        if (p.anim === 'stroll' && p.state !== 'flee' && this.rng() < dt * 0.05) {
          p.anim = 'hurry';
        }
      }

      const cadence = CADENCE[p.anim] || CADENCE.stroll;
      const speedScale = p.state === 'flee' ? 1.5 : (p.anim === 'idle' ? 0.2 : 1.0);
      p.phase += dt * cadence * speedScale * (p.speed > 4 ? 1.3 : 1);

      const limbs = p.mesh.userData.limbs;
      const swing = Math.sin(p.phase) * (AMPLITUDE[p.anim] || AMPLITUDE.stroll);
      limbs[0].rotation.x = swing;
      limbs[1].rotation.x = -swing;
      limbs[2].rotation.x = -swing * 0.8;
      limbs[3].rotation.x = swing * 0.8;

      if (p.anim === 'idle') {
        // Wave at nothing in particular; a slight body roll sells the sway.
        p.wavePhase += dt * 2.2;
        limbs[2].rotation.x = -0.9 + Math.sin(p.wavePhase) * 0.35;
        p.mesh.rotation.z = Math.sin(p.wavePhase * 0.5) * 0.04;
      } else {
        p.mesh.rotation.z = 0;
      }

      // Sprinters hunch; calm peds ease upright. Frame-rate independent ease.
      const targetLean = p.state === 'flee' ? 0.16 : 0.05 + p.fearLevel * 0.1;
      p.mesh.rotation.x += (targetLean - p.mesh.rotation.x) * Math.min(1, dt * 6);
    }
  }

  // Optional top-up pass: repositions the peds farthest from the player into
  // busy districts, so crowd density reads high where it matters without
  // adding meshes or blowing the ped cap. Returns how many were moved.
  topUp(budget) {
    let moved = 0;
    for (let i = 0; i < budget; i++) {
      const lane = this.city.roadLines[Math.floor(this.rng() * this.city.roadLines.length)];
      const along = (this.rng() - 0.5) * 2 * HALF;
      const side = (this.rng() < 0.5 ? 1 : -1) * (WORLD.roadWidth / 2 + WORLD.sidewalk * 0.6);
      const x = lane.axis === 'z' ? lane.line + side : along;
      const z = lane.axis === 'z' ? along : lane.line + side;
      if (districtDensity(x, z) < 1.0) continue;   // docks stay thin

      // Donor: the living, calm ped farthest from the player focus.
      let donor = null;
      let bestD = -1;
      for (const p of this.peds.peds) {
        if (p.state === 'dead' || p.state === 'flee') continue;
        const d = Math.hypot(p.x - this.playerFocus.x, p.z - this.playerFocus.z);
        if (d > bestD) { bestD = d; donor = p; }
      }
      if (donor) {
        donor.x = x;
        donor.z = z;
        donor.mesh.position.set(x, 0, z);
        this.augment(donor, this.rng, true);
        moved++;
      }
    }
    return moved;
  }

  setPlayerFocus(pos) {
    if (pos) { this.playerFocus.x = pos.x; this.playerFocus.z = pos.z; }
  }
}
