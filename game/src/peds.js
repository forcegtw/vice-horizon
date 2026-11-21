// peds.js — pedestrian population for Vice Horizon.
//
// Each ped is a cheap low-poly rig (built by models.pedMesh) that walks the
// sidewalks along the road grid, panics at gunfire and near a wanted player,
// and can be killed (falling over, then recycling through spawn()).
//
// Layout of the module:
//   - spawn(): places a ped on a random road line's sidewalk, random heading.
//   - update(): per-ped state machine — dead (fall timer) / flee / walk —
//     plus collision against city solids and the limb swing animation.
//   - killNear(): flips the nearest living ped in range to 'dead'.
//   - setAlarm(): stores the latest gunfire position; the main loop passes it
//     in each frame anyway, but this lets systems trigger an alarm directly.
//
// Tuning notes (keep these coherent):
//   ALARM_RADIUS < CALM_RADIUS, so a ped that starts fleeing does not instantly
//   calm down while the shooter is still standing there. FLEE_SPEED should beat
//   the calm walk speed by a clear margin or the panic reads as a slow jog.
//   The ped cap comes from TRAFFIC.pedCount; dead peds hold their slot until
//   their timer expires, so the population never exceeds the cap.

import * as THREE from '../vendor/three.min.js';
import { TRAFFIC, PLAYER, WORLD } from './config.js';
import { pedMesh } from './models.js';
import { resolveCircle } from './vehicles.js';
import { HALF } from './city.js';

const SKIN = [0xe0b48c, 0xc98e5e, 0x8a5a3a, 0x6e4428];
const SHIRT = [0xd65f5f, 0x5f7fd6, 0x63b46a, 0xd6c45f, 0xb45fd6, 0x5fb8b4, 0xdddddd];

// Panic envelope: gunfire inside ALARM_RADIUS starts a sprint; the sprint ends
// only once the ped has put CALM_RADIUS between itself and the player.
const ALARM_RADIUS = 26;
const CALM_RADIUS = 40;
const FLEE_SPEED = 5.2;

// How long a body stays on the ground before its slot recycles.
const DEAD_TIME = 9;

// Streets stay walkable a little past the city edge before peds turn back.
const PED_MAP_MARGIN = 20;

export class Peds {
  constructor(scene, city, rng) {
    this.city = city;
    this.scene = scene;
    this.peds = [];
    this.lastAlarm = null;   // {x, z} of the most recent gunfire, if any
    for (let i = 0; i < TRAFFIC.pedCount; i++) {
      const mesh = pedMesh(rng);
      scene.add(mesh);
      const p = this.spawn(rng, { mesh });
      this.peds.push(p);
    }
  }

  // (Re)place one ped. Called at boot for every slot and again when a dead
  // ped's timer runs out, so it must fully reset the record it is given.
  spawn(rng, p) {
    const lane = this.city.roadLines[Math.floor(rng() * this.city.roadLines.length)];
    const along = (rng() - 0.5) * 2 * HALF;
    // Sidewalk offset: just outside the roadway, inside the pavement strip.
    const side = (rng() < 0.5 ? 1 : -1) * (WORLD.roadWidth / 2 + WORLD.sidewalk * 0.6);
    p.x = lane.axis === 'z' ? lane.line + side : along;
    p.z = lane.axis === 'z' ? along : lane.line + side;
    p.heading = rng() * Math.PI * 2;
    p.speed = TRAFFIC.pedSpeed * (0.7 + rng() * 0.6);
    p.phase = rng() * Math.PI * 2;
    p.state = 'walk';            // walk | flee | dead
    p.deadT = 0;
    if (p.fearLevel !== undefined) p.fearLevel = 0;  // reset peds2 layer state on recycle
    p.mesh.visible = true;
    p.mesh.rotation.x = 0;
    p.mesh.position.set(p.x, 0, p.z);
    return p;
  }

  // Directly register a panic source between frames (optional convenience).
  setAlarm(pos) { this.lastAlarm = pos; }

  update(dt, rng, playerPos, solids, alarmPos) {
    const alarm = alarmPos || this.lastAlarm;
    for (const p of this.peds) {
      if (p.state === 'dead') {
        p.deadT -= dt;
        // Face-plant in place: keep the pre-death heading, rotate onto the ground.
        p.mesh.rotation.x = Math.PI / 2;
        p.mesh.position.y = 0.2;
        if (p.deadT <= 0) {
          p.mesh.rotation.x = 0;
          this.spawn(rng, p);
        }
        continue;
      }

      // Gunfire (or a standing alarm) nearby triggers the sprint.
      if (alarm) {
        const d = Math.hypot(alarm.x - p.x, alarm.z - p.z);
        if (d < ALARM_RADIUS) p.state = 'flee';
      }
      if (p.state === 'flee') {
        const d = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
        if (d > CALM_RADIUS) {
          p.state = 'walk';
        } else {
          p.heading = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
          p.speed = FLEE_SPEED;
        }
      }
      if (p.state === 'walk') {
        p.speed = TRAFFIC.pedSpeed;
        // Occasional idle turn keeps the crowd from marching in lockstep.
        if (rng() < dt * 0.5) p.heading += (rng() - 0.5) * 1.6;
      }

      const nx = p.x + Math.sin(p.heading) * p.speed * dt;
      const nz = p.z + Math.cos(p.heading) * p.speed * dt;
      const hit = resolveCircle(nx, nz, PLAYER.radius, solids);
      if (hit.blocked) {
        // Veer sideways and retry next frame; a right turn plus a little noise.
        p.heading += Math.PI / 2 + rng();
      } else if (Math.abs(hit.x) < HALF + PED_MAP_MARGIN && Math.abs(hit.z) < HALF + PED_MAP_MARGIN) {
        p.x = hit.x;
        p.z = hit.z;
      } else {
        p.heading += Math.PI;   // wandered off the map: turn back
      }

      // Strut: opposite arm/leg swing, small vertical bob, forward lean.
      p.phase += dt * p.speed * 3.2;
      const limbs = p.mesh.userData.limbs;
      const swing = Math.sin(p.phase) * 0.62;
      limbs[0].rotation.x = swing;
      limbs[1].rotation.x = -swing;
      limbs[2].rotation.x = -swing * 0.8;
      limbs[3].rotation.x = swing * 0.8;
      p.mesh.position.y = Math.abs(Math.sin(p.phase)) * 0.05;
      p.mesh.rotation.x = p.state === 'flee' ? 0.14 : 0.05;

      p.mesh.position.set(p.x, 0, p.z);
      p.mesh.rotation.y = p.heading;
    }
  }

  // Flip the nearest living ped in range to dead. Returns the ped or null.
  // The fall itself is posed by the dead branch in update(); killing here only
  // changes state, so a missing mesh can never throw.
  killNear(x, z, range) {
    let best = null;
    let bestD2 = range * range;
    for (const p of this.peds) {
      if (p.state === 'dead') continue;
      const d2 = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    if (best) {
      best.state = 'dead';
      best.deadT = DEAD_TIME;
      best.speed = 0;        // the fall owns the body from here
      if (best.fearLevel !== undefined) best.fearLevel = 0;
    }
    return best;
  }
}

// Re-export the palettes so tests or future systems can sample them without
// duplicating the arrays. (Also consumed by peds2's density-based spawn notes.)
export const PED_PALETTES = Object.freeze({ SKIN, SHIRT });
