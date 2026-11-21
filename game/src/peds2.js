// peds2.js — the "life" layer painted over the base crowd (peds.js).
//
// This module owns no meshes and no ped cap. It decorates the existing ped
// records with behavioural state (anim tier, fear, idle browsing), runs a
// threat-sensing pass driven by the wanted level, and poses a richer rig
// animation than the base strut. main.js calls it after peds.update():
//     peds.update(...); peds2.senseThreat(...); peds2.update(...);
//
// Rules the two layers agree on:
//   - peds.js owns p.state ('walk'/'flee'/'dead'). This layer may set
//     p.state = 'flee' when fear boils over but never touches 'dead'.
//   - PANIC_SPRINT must exceed the base FLEE_SPEED (5.2), or peds handed
//     over to the base flee branch would visibly slow down mid-panic.
//   - crowdPressure() shapes where crowds feel thick: the boardwalk strip
//     and the downtown core stay busy (>= 1.0, worth topping up), the docks
//     stay sparse. topUp() only ever moves peds into the busy zones.

import { WORLD } from './config.js';
import { HALF } from './city.js';

// Crowd pressure for one map spot, as a fraction of the map span west → east.
// Values at or above 1.0 mean "worth topping up", below 1.0 "leave it thin".
function crowdPressure(x, z) {
  const t = (x + HALF) / (HALF * 2);
  if (t < 0.25) return 1.15;                                  // boardwalk
  if (Math.abs(x) < HALF * 0.35 && Math.abs(z) < HALF * 0.35) return 1.25; // downtown core
  if (t > 0.75) return 0.6;                                   // industrial docks
  return 1.0;
}

const IDLE_SHARE = 0.18;      // share of peds that start as window-shoppers
const BROWSE_SPEED = 0.35;    // browsing shuffle speed
const PANIC_SPRINT = 6.4;     // must stay above peds.js FLEE_SPEED (5.2)
const BREAKDOWN_FEAR = 0.75;  // fear at which the run starts
const SETTLE_FEAR = 0.3;      // fear below which a hurry eases back to stroll
const WAVE_SPEED = 2.2;       // idle arm-wave oscillation, cycles per second

// Fear sensing: radius grows per star, closeness and heat set the ceiling,
// and panic rises much faster than it settles.
const SENSE_BASE = 14;
const SENSE_PER_STAR = 9;
const CALM_BASE = 0.45;
const CALM_PER_STAR = 0.2;
const RISE_RATE = 3.5;
const SETTLE_RATE = 1.1;
const HURRY_RATE = 0.05;      // per-second chance a stroller looks busy

// Stride tempo per animation tier, in cycles per second…
const TEMPO = Object.freeze({ stroll: 3.2, hurry: 4.6, sprint: 6.0, idle: 1.0 });
// …and swing amplitude per tier.
const AMPLITUDE = Object.freeze({ stroll: 0.62, hurry: 0.78, sprint: 0.62, idle: 0.08 });

export class Peds2 {
  constructor(peds, city, rng) {
    this.peds = peds;      // the Peds instance from peds.js
    this.city = city;
    this.rng = rng;
    this.playerFocus = { x: 0, z: 0 };

    // Decorate the existing records once at boot...
    for (const p of this.peds.peds) this.augment(p, rng, true);

    // ...and wrap the base spawn() so recycled peds come back with fresh
    // layer state — otherwise a former sprinter would stroll in carrying
    // stale fear from its previous life.
    const baseSpawn = this.peds.spawn.bind(this.peds);
    this.peds.spawn = (rngArg, rec) => {
      baseSpawn(rngArg, rec);
      this.augment(rec, rngArg, false);
      return rec;
    };
  }

  // Add or refresh the layer fields on one ped record.
  augment(p, rng, initial) {
    p.anim = 'stroll';               // stroll | hurry | sprint | idle
    p.idleT = 0;                     // seconds of browsing left
    p.fearLevel = 0;                 // 0 calm → 1 panicking, eased per frame
    p.lean = (rng() - 0.5) * 0.25;   // per-ped sway bias so idlers differ
    p.wavePhase = rng() * Math.PI * 2;
    p.density = crowdPressure(p.x, p.z);
    if (initial && rng() < IDLE_SHARE) {
      p.anim = 'idle';
      p.idleT = 4 + rng() * 10;
    }
  }

  // Threat pass: fear climbs with wanted stars and closeness; maxing out
  // hands the ped to the base flee logic, which owns the run from there.
  // Runs every frame; the math is cheap enough that early-outs are the only
  // optimisation it needs (no heat → no sensing cost).
  senseThreat(playerPos, wanted, dt) {
    const stars = wanted || 0;
    if (stars <= 0) return;
    const radius = SENSE_BASE + stars * SENSE_PER_STAR;
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;
      const dx = playerPos.x - p.x;
      const dz = playerPos.z - p.z;
      const d = Math.hypot(dx, dz);
      let target = 0;
      if (d < radius) {
        target = Math.min(1, (1 - d / radius) * (CALM_BASE + stars * CALM_PER_STAR));
      }
      // Panic fast, calm down slowly.
      const rate = target > p.fearLevel ? RISE_RATE : SETTLE_RATE;
      p.fearLevel += (target - p.fearLevel) * Math.min(1, dt * rate);

      if (p.state === 'flee') continue;   // base layer already owns the sprint
      if (p.fearLevel > BREAKDOWN_FEAR) {
        p.anim = 'sprint';
        p.heading = Math.atan2(-dx, -dz); // run away from the player
        p.speed = PANIC_SPRINT * (0.85 + this.rng() * 0.3);
        p.state = 'flee';                 // hand over; base settles at CALM_GAP
      } else if (p.anim === 'sprint') {
        p.anim = 'hurry';
      }
    }
  }

  // Idle browsing: stand, sway, occasionally shuffle or move on. Returns
  // true while the ped keeps idling (the caller skips its own tempo logic).
  tickIdle(p, dt) {
    if (p.anim !== 'idle') return false;
    p.idleT -= dt;
    p.speed = BROWSE_SPEED;
    p.heading += p.lean * dt * 0.4;
    if (p.idleT <= 0) {
      if (this.rng() < 0.5) {
        p.anim = 'stroll';
        p.heading += (this.rng() - 0.5) * 2.4;
      } else {
        p.idleT = 3 + this.rng() * 8;   // keep browsing a while longer
      }
    }
    return true;
  }

  // Per-frame pass: tier transitions, stride tempo, limb swings, lean.
  update(dt, playerPos, wanted) {
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;   // the fall pose belongs to peds.js
      p.density = crowdPressure(p.x, p.z);

      if (!this.tickIdle(p, dt)) this._tier(p, dt);
      this._animate(p, dt);
    }
  }

  // Tier transitions for walking peds: hurry decays back to stroll once the
  // fear drains, and a few walkers always look busy even in a calm city.
  _tier(p, dt) {
    if (p.anim === 'hurry' && p.state !== 'flee' && p.fearLevel < SETTLE_FEAR) {
      p.anim = 'stroll';
    }
    if (p.anim === 'stroll' && p.state !== 'flee' && this.rng() < dt * HURRY_RATE) {
      p.anim = 'hurry';
    }
  }

  // Rig posing: cadence + amplitude per tier, the idle arm wave and body
  // roll, and a frame-rate-independent lean ease (sprinters hunch, calm
  // peds stand tall).
  _animate(p, dt) {
    const tempo = TEMPO[p.anim] || TEMPO.stroll;
    const gait = p.state === 'flee' ? 1.5 : (p.anim === 'idle' ? 0.2 : 1.0);
    p.phase += dt * tempo * gait * (p.speed > 4 ? 1.3 : 1);

    const limbs = p.mesh.userData.limbs;
    const swing = Math.sin(p.phase) * (AMPLITUDE[p.anim] || AMPLITUDE.stroll);
    limbs[0].rotation.x = swing;
    limbs[1].rotation.x = -swing;
    limbs[2].rotation.x = -swing * 0.8;
    limbs[3].rotation.x = swing * 0.8;

    if (p.anim === 'idle') {
      // Wave at nothing in particular; a slight body roll sells the sway.
      p.wavePhase += dt * WAVE_SPEED;
      limbs[2].rotation.x = -0.9 + Math.sin(p.wavePhase) * 0.35;
      p.mesh.rotation.z = Math.sin(p.wavePhase * 0.5) * 0.04;
    } else {
      p.mesh.rotation.z = 0;
    }

    const targetLean = p.state === 'flee' ? 0.16 : 0.05 + p.fearLevel * 0.1;
    p.mesh.rotation.x += (targetLean - p.mesh.rotation.x) * Math.min(1, dt * 6);
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
      if (crowdPressure(x, z) < 1.0) continue;   // the docks stay thin

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
