// peds2.js — the pedestrian life layer. This is a layer on top of Peds
// (peds.js), not a replacement: the same ped records and meshes keep flowing
// through the base walk/flee/dead machine, and this pass enriches what they
// do while alive — browsing idlers, brisk business walkers, sprinters scared
// by the wanted player — plus a coarse district crowd density read. The ped
// count, rig and recycling stay untouched; main.js runs senseThreat → update
// → setPlayerFocus each frame, in that order, after the base peds.update().
//
// Contract notes:
// - p.state stays owned by peds.js. This layer only nudges animation tiers,
//   and may hand a terrified ped into the base flee branch, which then owns
//   the sprint and settles it past its calm radius.
// - PANIC_SPRINT must stay above peds.js's FLEE_SPEED or sprinters visibly
//   slow down at the moment they should be at their fastest.
// - fearLevel eases toward a threat target: panic is fast, calm-down slow.

import { WORLD } from './config.js';
import { HALF } from './city.js';

// Coarse district crowd density, sampled from position. The grid is symmetric
// about 0, so x alone separates the west beach strip from the east docks:
// boardwalk and downtown stay busy, the industrial edge thins out.
function districtDensity(x, z) {
  const t = (x + HALF) / (HALF * 2);   // 0 = west beach, 1 = east edge
  if (t < 0.25) return 1.15;           // boardwalk: tourists
  if (Math.abs(x) < HALF * 0.35 && Math.abs(z) < HALF * 0.35) return 1.25; // downtown
  if (t > 0.75) return 0.6;            // industrial docks
  return 1.0;
}

const IDLE_CHANCE = 0.18;    // fraction of peds that start as idlers/window-shoppers
const IDLE_SPEED = 0.35;     // near-stationary browsing speed
const PANIC_SPRINT = 6.4;    // sprint speed when stars are high
const HURRY_CHANCE = 0.05;   // per-second chance a calm stroll turns brisk: city texture
// Stride cycles per second per animation tier.
const WALK_ANIM = { stroll: 3.2, hurry: 4.6, sprint: 6.0 };

export class Peds2 {
  constructor(peds, city, rng) {
    this.peds = peds;   // the base Peds instance
    this.city = city;
    this.rng = rng;

    // Augment every ped that already exists.
    for (const p of this.peds.peds) this.augment(p, rng, true);

    // Wrap the base spawn so recycled peds rebirth with fresh layer state too.
    const baseSpawn = this.peds.spawn.bind(this.peds);
    this.peds.spawn = (rng, p) => {
      baseSpawn(rng, p);
      this.augment(p, rng, false);
      return p;
    };
  }

  // Add this layer's fields to a ped record. Runs once per (re)birth: the
  // constructor seeds existing peds with initial=true, the wrapped spawn
  // covers every recycled ped after that. rng draws here are part of the
  // seeded replay contract, in this order.
  augment(p, rng, initial) {
    p.anim = 'stroll';                 // stroll | hurry | sprint | idle
    p.idleT = 0;                       // remaining idle seconds
    p.fearLevel = 0;                   // 0 calm → 1 panicked, eased each frame
    p.lean = (rng() - 0.5) * 0.25;     // stable per-ped idle sway bias
    p.wavePhase = rng() * Math.PI * 2;
    p.density = districtDensity(p.x, p.z);
    if (initial && rng() < IDLE_CHANCE) {
      p.anim = 'idle';
      p.idleT = 4 + rng() * 10;
    }
  }

  // Fear reads the wanted stars and distance: one star only nerves up peds
  // right next to the player, three-plus sprints the whole street. The threat
  // radius grows with the star count so low heat never empties the map. Cheap
  // per-frame math only; runs before update so the pose matches the fear.
  senseThreat(playerPos, wanted, dt) {
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;
      const d = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
      const radius = 14 + wanted * 9;
      let target = 0;
      if (wanted > 0 && d < radius) {
        target = Math.min(1, (1 - d / radius) * (0.45 + wanted * 0.2));
      }
      // Ease toward the target; calm-down is slower than panic.
      const rate = target > p.fearLevel ? 3.5 : 1.1;
      p.fearLevel += (target - p.fearLevel) * Math.min(1, dt * rate);
      // The base flee branch settles its own peds; never fight it.
      if (p.state === 'flee') continue;
      if (p.fearLevel > 0.75) {
        p.anim = 'sprint';
        p.heading = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
        p.speed = PANIC_SPRINT * (0.85 + this.rng() * 0.3);
        p.state = 'flee';   // hand over to the base flee branch
      } else if (p.anim === 'sprint') {
        p.anim = 'hurry';
      }
    }
  }

  // Window-shopping: stand, sway with the ped's own lean bias, then either
  // resume strolling on a fresh heading or browse a while longer. Returns
  // true when the ped spent the frame idling, so update skips the walk tiers.
  tickIdle(p, dt) {
    if (p.anim !== 'idle') return false;
    p.idleT -= dt;
    p.speed = IDLE_SPEED;
    p.heading += p.lean * dt * 0.4;   // tiny wobble, no travel intent
    if (p.idleT <= 0) {
      if (this.rng() < 0.5) {
        p.anim = 'stroll';
        p.heading += (this.rng() - 0.5) * 2.4;   // pick a fresh direction
      } else {
        p.idleT = 3 + this.rng() * 8;
      }
    }
    return true;
  }

  update(dt, playerPos, wanted) {
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;
      p.density = districtDensity(p.x, p.z) || p.density;

      if (!this.tickIdle(p, dt)) {
        // hurry = brisk business walk between sprint and stroll; it decays
        // back to stroll once the ped is calm, and calm streets keep a few
        // hurried walkers around as city texture.
        if (p.anim === 'hurry' && p.state !== 'flee' && p.fearLevel < 0.3) {
          p.anim = 'stroll';
        }
        if (p.anim === 'stroll' && p.state !== 'flee' && this.rng() < dt * HURRY_CHANCE) {
          p.anim = 'hurry';
        }
      }

      this._poseWalk(p, dt);
    }
  }

  // Animation tier → rig: cadence and stride come from the anim tier, the
  // amplitude from it too, and fleeing peds pump their legs harder. Idlers
  // wave an arm at nothing in particular and tilt slightly; sprinters lean
  // into the run, calm walkers stand tall.
  _poseWalk(p, dt) {
    const cadence = WALK_ANIM[p.anim] || WALK_ANIM.stroll;
    const speedScale = p.state === 'flee' ? 1.5 : (p.anim === 'idle' ? 0.2 : 1.0);
    p.phase += dt * cadence * speedScale * (p.speed > 4 ? 1.3 : 1);

    const limbs = p.mesh.userData.limbs;
    const amp = p.anim === 'idle' ? 0.08 : p.anim === 'hurry' ? 0.78 : 0.62;
    const swing = Math.sin(p.phase) * amp;
    limbs[0].rotation.x = swing;
    limbs[1].rotation.x = -swing;
    limbs[2].rotation.x = -swing * 0.8;
    limbs[3].rotation.x = swing * 0.8;

    if (p.anim === 'idle') {
      p.wavePhase += dt * 2.2;
      limbs[2].rotation.x = -0.9 + Math.sin(p.wavePhase) * 0.35;
      p.mesh.rotation.z = Math.sin(p.wavePhase * 0.5) * 0.04;
    } else {
      p.mesh.rotation.z = 0;
    }

    const fearLean = p.state === 'flee' ? 0.16 : 0.05 + p.fearLevel * 0.1;
    p.mesh.rotation.x += (fearLean - p.mesh.rotation.x) * Math.min(1, dt * 6);
  }

  // District-aware top-up for main.js: when a busy district looks thin, pull
  // the farthest wandering peds into it rather than creating meshes, so the
  // ped cap and draw-call count stay fixed. Sparse districts (density < 1)
  // never get help — the docks are supposed to be empty-ish. `scene` is kept
  // in the signature for call-site symmetry with the other systems.
  topUp(scene, budget) {
    const rng = this.rng;
    let added = 0;
    for (let i = 0; i < budget; i++) {
      const lines = this.city.roadLines;
      const lane = lines[Math.floor(rng() * lines.length)];
      const along = (rng() - 0.5) * 2 * HALF;
      const curb = (rng() < 0.5 ? 1 : -1) * (WORLD.roadWidth / 2 + WORLD.sidewalk * 0.6);
      const x = lane.axis === 'z' ? lane.line + curb : along;
      const z = lane.axis === 'z' ? along : lane.line + curb;
      if (districtDensity(x, z) < 1.0) continue;

      const focus = this.playerFocus || { x: 0, z: 0 };
      let donor = null;
      let farthest = -1;
      for (const p of this.peds.peds) {
        if (p.state === 'dead' || p.state === 'flee') continue;
        const d = Math.hypot(p.x - focus.x, p.z - focus.z);
        if (d > farthest) { farthest = d; donor = p; }
      }
      if (donor) {
        donor.x = x;
        donor.z = z;
        donor.mesh.position.set(x, 0, z);
        this.augment(donor, rng, true);
        added++;
      }
    }
    return added;
  }

  setPlayerFocus(pos) { this.playerFocus = pos; }
}
