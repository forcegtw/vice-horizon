// peds2.js — the life layer riding on peds.js. It never replaces the base
// machine: it decorates the same ped records with mood fields (fearLevel, anim,
// idleT, ...) and re-poses the shared rigs after peds.update() has run, which is
// why main.js calls senseThreat() then update() every frame in that order.
// p.state stays owned by peds.js; this layer only nudges anim tiers and, on
// full panic, hands the run over to the base flee branch.
// Crowd texture: density is sampled from world x alone because the grid is
// symmetric about 0 — beach strip west, downtown core centre, docks east.

import { WORLD } from './config.js';
import { HALF } from './city.js';

// 0 = west boardwalk, 1 = east dockside. Downtown bumps density hardest.
function crowdDensity(x, z) {
  const t = (x + HALF) / (HALF * 2);
  if (t < 0.25) return 1.15;                                               // beach tourists
  if (Math.abs(x) < HALF * 0.35 && Math.abs(z) < HALF * 0.35) return 1.25; // downtown core
  if (t > 0.75) return 0.6;                                                // sparse docks
  return 1.0;
}

const IDLER_SHARE = 0.18;    // share of peds that boot into window-shopping idle
const BROWSE_MPS = 0.35;     // idle shuffle pace
const PANIC_MPS = 6.4;       // sprint under high stars; must beat peds.js flee pace
const STRIDE_CPS = { stroll: 3.2, hurry: 4.6, sprint: 6.0 };  // cadence per tier
const FEAR_PANIC = 0.75;     // fear level at which a ped breaks into a sprint
const FEAR_RADIUS = 14;      // base awareness bubble around the player
const FEAR_PER_STAR = 9;     // bubble growth per wanted star
const PANIC_RATE = 3.5;      // fear ramps in fast...
const CALM_RATE = 1.1;       // ...and drains out slowly
const HURRY_CHANCE = 0.05;   // per-second chance a calm stroller speeds up

export class Peds2 {
  constructor(peds, city, rng) {
    this.peds = peds;    // the Peds instance — records and meshes stay shared
    this.city = city;
    this.rng = rng;
    this.playerFocus = null;

    for (const p of this.peds.peds) this._dress(p, rng, true);

    // Intercept recycling so respawned peds also arrive with fresh layer state.
    const baseSpawn = this.peds.spawn.bind(this.peds);
    this.peds.spawn = (rng, p) => {
      baseSpawn(rng, p);
      this._dress(p, rng, false);
      return p;
    };
  }

  _dress(p, rng, booting) {
    p.anim = 'stroll';               // stroll | hurry | sprint | idle
    p.idleT = 0;                     // remaining idle seconds
    p.fearLevel = 0;                 // 0 calm → 1 panicked, eased every frame
    p.lean = (rng() - 0.5) * 0.25;   // stable sway bias; keeps idlers distinct
    p.wavePhase = rng() * Math.PI * 2;
    p.density = crowdDensity(p.x, p.z);
    if (booting && rng() < IDLER_SHARE) {
      p.anim = 'idle';
      p.idleT = 4 + rng() * 10;
    }
  }

  // Fear reacts to wanted stars and proximity: 1 star keeps passers-by on edge
  // near the player, 3+ stars empties a whole street into a sprint. Radius
  // grows per star so low heat never depopulates the map.
  senseThreat(playerPos, wanted, dt) {
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;
      const radius = FEAR_RADIUS + wanted * FEAR_PER_STAR;
      const d = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
      let target = 0;
      if (wanted > 0 && d < radius) {
        target = Math.min(1, (1 - d / radius) * (0.45 + wanted * 0.2));
      }
      const rate = target > p.fearLevel ? PANIC_RATE : CALM_RATE;
      p.fearLevel += (target - p.fearLevel) * Math.min(1, dt * rate);
      if (p.state === 'flee') continue;
      if (p.fearLevel > FEAR_PANIC) {
        p.anim = 'sprint';
        p.heading = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
        p.speed = PANIC_MPS * (0.85 + this.rng() * 0.3);
        p.state = 'flee'; // base branch settles them once past 40 m
      } else if (p.anim === 'sprint') {
        p.anim = 'hurry';
      }
    }
  }

  // Idlers stand, sway on their own lean bias and occasionally shuffle. Returns
  // true while the ped stays idle so walking tiers are skipped.
  _browse(p, dt) {
    if (p.anim !== 'idle') return false;
    p.idleT -= dt;
    p.speed = BROWSE_MPS;
    p.heading += p.lean * dt * 0.4;
    if (p.idleT <= 0) {
      if (this.rng() < 0.5) {
        p.anim = 'stroll';
        p.heading += (this.rng() - 0.5) * 2.4; // pick a fresh direction
      } else {
        p.idleT = 3 + this.rng() * 8;          // browse a little longer
      }
    }
    return true;
  }

  update(dt, playerPos, wanted) {
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;
      p.density = crowdDensity(p.x, p.z) || p.density;

      if (!this._browse(p, dt)) {
        const calm = p.state !== 'flee' && p.fearLevel < 0.3;
        if (p.anim === 'hurry' && calm) p.anim = 'stroll';
        // A few hurried walkers even at peace: cheap city texture.
        if (p.anim === 'stroll' && p.state !== 'flee' && this.rng() < dt * HURRY_CHANCE) {
          p.anim = 'hurry';
        }
      }

      // Cadence and stride scale from the anim tier.
      const cadence = STRIDE_CPS[p.anim] || STRIDE_CPS.stroll;
      const scale = p.state === 'flee' ? 1.5 : p.anim === 'idle' ? 0.2 : 1.0;
      p.phase += dt * cadence * scale * (p.speed > 4 ? 1.3 : 1);

      const limbs = p.mesh.userData.limbs;
      const amp = p.anim === 'idle' ? 0.08 : p.anim === 'hurry' ? 0.78 : 0.62;
      const swing = Math.sin(p.phase) * amp;
      limbs[0].rotation.x = swing;
      limbs[1].rotation.x = -swing;
      limbs[2].rotation.x = -swing * 0.8;
      limbs[3].rotation.x = swing * 0.8;

      // Idle arm wave: browsed goods, waved at a friend across the street.
      if (p.anim === 'idle') {
        p.wavePhase += dt * 2.2;
        limbs[2].rotation.x = -0.9 + Math.sin(p.wavePhase) * 0.35;
        p.mesh.rotation.z = Math.sin(p.wavePhase * 0.5) * 0.04;
      } else {
        p.mesh.rotation.z = 0;
      }

      // Sprint lean reads as urgency; calm stroll stands tall.
      const leanTarget = p.state === 'flee' ? 0.16 : 0.05 + p.fearLevel * 0.1;
      p.mesh.rotation.x += (leanTarget - p.mesh.rotation.x) * Math.min(1, dt * 6);
    }
  }

  // Slow-tick district top-up: instead of new meshes, the farthest calm ped is
  // repositioned into a busy district, so the cap and draw-call count stay fixed.
  topUp(scene, budget) {
    const rng = this.rng;
    let added = 0;
    for (let i = 0; i < budget; i++) {
      const lane = this.city.roadLines[Math.floor(rng() * this.city.roadLines.length)];
      const along = (rng() - 0.5) * 2 * HALF;
      const side = (rng() < 0.5 ? 1 : -1) * (WORLD.roadWidth / 2 + WORLD.sidewalk * 0.6);
      const x = lane.axis === 'z' ? lane.line + side : along;
      const z = lane.axis === 'z' ? along : lane.line + side;
      if (crowdDensity(x, z) < 1.0) continue; // docks stay sparse
      const focus = this.playerFocus || { x: 0, z: 0 };
      let donor = null;
      let bd = -1;
      for (const p of this.peds.peds) {
        if (p.state === 'dead' || p.state === 'flee') continue;
        const d = Math.hypot(p.x - focus.x, p.z - focus.z);
        if (d > bd) {
          bd = d;
          donor = p;
        }
      }
      if (donor) {
        donor.x = x;
        donor.z = z;
        donor.mesh.position.set(x, 0, z);
        this._dress(donor, rng, true);
        added++;
      }
    }
    return added;
  }

  setPlayerFocus(pos) {
    this.playerFocus = pos;
  }
}
