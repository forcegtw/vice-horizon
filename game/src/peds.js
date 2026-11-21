// peds.js — the street crowd. Every pedestrian is a light rig from models.js
// running a small walk / flee / dead machine along the sidewalks. This module is
// the BASE layer only: it owns placement, collision movement and the fall/recycle
// cycle. peds2.js layers richer moods and animation tiers on the same records, so
// its fields (fearLevel in particular) are reset here on kill, letting a recycled
// ped wake up calm.
// Tuning notes: SCARE_RANGE and SETTLE_RANGE shape how gunfire ripples through a
// block. The settle radius is deliberately wider than the scare radius — panic
// lingers a little after the shooting stops, then streets go back to normal.
// Per-ped cost matters (42 rigs, hot loop): flee checks stay to two hypots.

import { TRAFFIC, PLAYER, WORLD } from './config.js';
import { pedMesh } from './models.js';
import { resolveCircle } from './vehicles.js';
import { HALF } from './city.js';

const SCARE_RANGE = 26;    // gunfire within this radius flips a ped to flee
const SETTLE_RANGE = 40;   // past this distance from the threat they calm down
const SPRINT_MPS = 5.2;    // flee pace; peds2's panic sprint must beat this
const EDGE_MARGIN = 20;    // peds may wander this far past the outermost street
const FALL_SECONDS = 9;    // a dropped ped lies on the ground this long before recycling
const WANDER_CHANCE = 0.5; // per-second chance of a lazy direction change
const STRIDE = 3.2;        // walk-cycle phase multiplier
const SWING = 0.62;        // limb swing amplitude, radians

export class Peds {
  constructor(scene, city, rng) {
    this.city = city;
    this.peds = [];
    for (let i = 0; i < TRAFFIC.pedCount; i++) {
      const mesh = pedMesh(rng);
      scene.add(mesh);
      this.peds.push(this.spawn(rng, { mesh }));
    }
  }

  // (Re)place one ped record. Runs at boot and again to recycle a fallen ped,
  // so every base field is reset here — nothing may survive from the old life.
  spawn(rng, p) {
    const lane = this.city.roadLines[Math.floor(rng() * this.city.roadLines.length)];
    const along = (rng() - 0.5) * 2 * HALF;
    const side = (rng() < 0.5 ? 1 : -1) * (WORLD.roadWidth / 2 + WORLD.sidewalk * 0.6);
    if (lane.axis === 'z') {
      p.x = lane.line + side;
      p.z = along;
    } else {
      p.x = along;
      p.z = lane.line + side;
    }
    p.heading = rng() * Math.PI * 2;
    p.speed = TRAFFIC.pedSpeed * (0.7 + rng() * 0.6);
    p.phase = rng() * Math.PI * 2;
    p.state = 'walk';                 // walk | flee | dead
    p.deadT = 0;
    p.mesh.visible = true;
    p.mesh.rotation.x = 0;
    p.mesh.position.set(p.x, 0, p.z);
    return p;
  }

  update(dt, rng, playerPos, solids, alarmPos) {
    for (const p of this.peds) {
      if (p.state === 'dead') {
        this._fall(p, dt, rng);
        continue;
      }
      if (alarmPos && Math.hypot(alarmPos.x - p.x, alarmPos.z - p.z) < SCARE_RANGE) {
        p.state = 'flee';
      }
      if (p.state === 'flee') {
        const d = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
        if (d > SETTLE_RANGE) p.state = 'walk';
        p.heading = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
        p.speed = SPRINT_MPS;
      } else {
        p.speed = TRAFFIC.pedSpeed;
        if (rng() < dt * WANDER_CHANCE) p.heading += (rng() - 0.5) * 1.6;
      }
      this._move(p, dt, rng, solids);
      this._pose(p, dt);
    }
  }

  _fall(p, dt, rng) {
    p.deadT -= dt;
    // Face-plant: keep the heading the ped died with, tip onto the ground.
    p.mesh.rotation.x = Math.PI / 2;
    p.mesh.position.y = 0.2;
    if (p.deadT <= 0) this.spawn(rng, p);
  }

  _move(p, dt, rng, solids) {
    const nx = p.x + Math.sin(p.heading) * p.speed * dt;
    const nz = p.z + Math.cos(p.heading) * p.speed * dt;
    const hit = resolveCircle(nx, nz, PLAYER.radius, solids);
    if (hit.blocked) {
      // Squashed against geometry: turn away and stay put, no tunnelling.
      p.heading += Math.PI / 2 + rng();
    } else if (Math.abs(hit.x) < HALF + EDGE_MARGIN && Math.abs(hit.z) < HALF + EDGE_MARGIN) {
      p.x = hit.x;
      p.z = hit.z;
    } else {
      p.heading += Math.PI; // wandered off the map edge: about-face
    }
  }

  _pose(p, dt) {
    p.phase += dt * p.speed * STRIDE;
    const swing = Math.sin(p.phase) * SWING;
    const limbs = p.mesh.userData.limbs;
    limbs[0].rotation.x = swing;
    limbs[1].rotation.x = -swing;
    limbs[2].rotation.x = -swing * 0.8;
    limbs[3].rotation.x = swing * 0.8;
    p.mesh.position.set(p.x, 0, p.z);
    // Small vertical bob while striding; leaning forward reads as urgency.
    p.mesh.position.y = Math.abs(Math.sin(p.phase)) * 0.05;
    p.mesh.rotation.x = p.state === 'flee' ? 0.14 : 0.05;
    p.mesh.rotation.y = p.heading;
  }

  // Drop the nearest live ped inside range. The dead branch above owns the fall
  // pose; this only flips state and clears layer fields so the recycled ped
  // never wakes up scared. A missing mesh can never crash this path.
  killNear(x, z, range) {
    let best = null;
    let bd = range * range;
    for (const p of this.peds) {
      if (p.state === 'dead') continue;
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 < bd) {
        bd = d2;
        best = p;
      }
    }
    if (best) {
      best.state = 'dead';
      best.deadT = FALL_SECONDS;
      best.speed = 0;      // the fall animation owns the body from here
      best.fearLevel = 0;  // layer state reset for a clean respawn
    }
    return best;
  }
}
