// peds2.js — pedestrian life pass: richer walk states, wanted-level fear
// behaviour and district crowd density. This is a layer on top of Peds
// (peds.js), not a replacement: it reuses the existing ped records and meshes
// and only augments the per-ped state machine, so the ped count, rig and
// recycling stay untouched. main.js runs peds.update() then peds2.update().
// District density is written onto the ped (per-ped, refreshed on the move) and
// the idle sway uses a stable per-ped lean instead of a fresh random each frame.
// PANIC_SPRINT must stay above peds.js's FLEE_SPEED or sprinters visibly slow
// down at the moment they should be at their fastest.

import { WORLD } from './config.js';
import { HALF } from './city.js';

// District crowd density: the beach strip (west edge) and downtown core stay
// busy, the industrial east edge thins out. Sampled from x, since the city
// grid is symmetric about 0.
function districtDensity(x, z) {
  const t = (x + HALF) / (HALF * 2); // 0 = west beach, 1 = east edge
  if (t < 0.25) return 1.15;         // boardwalk: tourists
  if (Math.abs(x) < HALF * 0.35 && Math.abs(z) < HALF * 0.35) return 1.25; // downtown
  if (t > 0.75) return 0.6;          // industrial docks
  return 1.0;
}

const IDLE_CHANCE = 0.18;    // fraction of peds that start as idlers/window-shoppers
const IDLE_SPEED = 0.35;     // near-stationary browsing speed
const PANIC_SPRINT = 6.4;    // sprint speed when stars are high
const WALK_ANIM = { stroll: 3.2, hurry: 4.6, sprint: 6.0 };   // stride cycles per second

export class Peds2 {
  constructor(peds, city, rng) {
    this.peds = peds;   // Peds instance
    this.city = city;
    this.rng = rng;

    // Augment every existing ped record with layer state.
    for (const p of this.peds.peds) this.augment(p, rng, true);

    // Wrap spawn so recycled peds come out with fresh layer state too.
    const base = this.peds.spawn.bind(this.peds);
    this.peds.spawn = (rng, p) => {
      base(rng, p);
      this.augment(p, rng, false);
      return p;
    };
  }

  augment(p, rng, initial) {
    p.anim = 'stroll';                 // stroll | hurry | sprint | idle
    p.idleT = 0;                       // remaining idle seconds
    p.fearLevel = 0;                   // 0 calm → 1 panicked, eased each frame
    p.lean = (rng() - 0.5) * 0.25;     // idle sway bias, keeps idlers distinct
    p.wavePhase = rng() * Math.PI * 2;
    p.density = districtDensity(p.x, p.z);
    if (initial && rng() < IDLE_CHANCE) {
      p.anim = 'idle';
      p.idleT = 4 + rng() * 10;
    }
  }

  // Fear reacts to wanted stars and proximity: stars 1 → on-edge near player,
  // stars 3+ → the whole street sprints. Runs each frame, cheap math only.
  senseThreat(playerPos, wanted, dt) {
    for (const p of this.peds.peds) {
      if (p.state === 'dead') continue;
      const d = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
      // Base threat scales with stars; only bites inside a radius that grows
      // with the star count so 1-star heat doesn't empty the whole map.
      const radius = 14 + wanted * 9;
      let target = 0;
      if (wanted > 0 && d < radius) {
        target = Math.min(1, (1 - d / radius) * (0.45 + wanted * 0.2));
      }
      // Ease toward the target fear level; calm-down is slower than panic.
      const rate = target > p.fearLevel ? 3.5 : 1.1;
      p.fearLevel += (target - p.fearLevel) * Math.min(1, dt * rate);
      // p.state is owned by peds.js ('flee' on alarm); the layer only nudges
      // animation intensity — never fight the base flee logic.
      if (p.state === 'flee') continue;
      if (p.fearLevel > 0.75) {
        p.anim = 'sprint';
        p.heading = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
        p.speed = PANIC_SPRINT * (0.85 + this.rng() * 0.3);
        p.state = 'flee'; // hand over to the base flee branch, which settles at d > 40
      } else if (p.anim === 'sprint') {
        p.anim = 'hurry';
      }
    }
  }

  // Idle/window-shop behaviour: stand, sway, occasionally shuffle a step.
  tickIdle(p, dt) {
    if (p.anim !== 'idle') return false;
    p.idleT -= dt;
    p.speed = IDLE_SPEED;
    // Sway in place: tiny heading wobble from the ped's own lean bias, no travel intent.
    p.heading += p.lean * dt * 0.4;
    if (p.idleT <= 0) {
      // Half resume strolling, half browse a bit longer.
      if (this.rng() < 0.5) {
        p.anim = 'stroll';
        p.heading += (this.rng() - 0.5) * 2.4; // pick a fresh direction
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
        // hurry = brisk business walk between sprint and stroll.
        if (p.anim === 'hurry' && p.state !== 'flee' && p.fearLevel < 0.3) {
          p.anim = 'stroll';
        }
        // Occasional hurried pedestrian even at peace: city texture.
        if (p.anim === 'stroll' && p.state !== 'flee' && this.rng() < dt * 0.05) {
          p.anim = 'hurry';
        }
      }

      // Animation state → rig: cadence and stride come from the anim tier.
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

      // Idle arm wave: browsed goods, waved at a friend across the street.
      if (p.anim === 'idle') {
        p.wavePhase += dt * 2.2;
        limbs[2].rotation.x = -0.9 + Math.sin(p.wavePhase) * 0.35;
        p.mesh.rotation.z = Math.sin(p.wavePhase * 0.5) * 0.04;
      } else {
        p.mesh.rotation.z = 0;
      }

      // Sprint lean reads as urgency; calm stroll stands tall.
      const fearLean = p.state === 'flee' ? 0.16 : 0.05 + p.fearLevel * 0.1;
      p.mesh.rotation.x += (fearLean - p.mesh.rotation.x) * Math.min(1, dt * 6);
    }
  }

  // District-aware respawn helper for main.js: when a district looks empty,
  // top up with extra peds only where density is high (called on a slow timer).
  topUp(scene, budget) {
    const rng = this.rng;
    let added = 0;
    for (let i = 0; i < budget; i++) {
      const lane = this.city.roadLines[Math.floor(rng() * this.city.roadLines.length)];
      const along = (rng() - 0.5) * 2 * HALF;
      const side = (rng() < 0.5 ? 1 : -1) * (WORLD.roadWidth / 2 + WORLD.sidewalk * 0.6);
      const x = lane.axis === 'z' ? lane.line + side : along;
      const z = lane.axis === 'z' ? along : lane.line + side;
      if (districtDensity(x, z) < 1.0) continue; // docks stay sparse
      // No new meshes: an existing distant ped is repositioned into the busy
      // district, so the ped cap and draw-call count stay fixed.
      let donor = null, bd = -1;
      const focus = this.playerFocus || { x: 0, z: 0 };
      for (const p of this.peds.peds) {
        if (p.state === 'dead' || p.state === 'flee') continue;
        const d = Math.hypot(p.x - focus.x, p.z - focus.z);
        if (d > bd) { bd = d; donor = p; }
      }
      if (donor) {
        donor.x = x; donor.z = z;
        donor.mesh.position.set(x, 0, z);
        this.augment(donor, rng, true);
        added++;
      }
    }
    return added;
  }

  setPlayerFocus(pos) { this.playerFocus = pos; }
}
