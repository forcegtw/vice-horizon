// peds.js — sidewalk population: spawn, stroll, panic, fall, recycle.
//
// A ped is a plain record { x, z, heading, speed, phase, state, deadT, mesh }
// wrapped around a jointed rig built by models.pedMesh. The population is
// capped by TRAFFIC.pedCount and slots never grow or shrink: a killed ped
// lies on the pavement for BODY_LINGER seconds, then its record respawns
// somewhere else, keeping allocation flat through rampages.
//
// Module layout:
//   spawn()     — (re)place one record on a road line's sidewalk
//   setAlarm()  — stash a panic source between frames (optional; the main
//                 loop also passes the alarm straight into update())
//   update()    — the per-ped machine, dead → flee → walk, plus collision
//                 against city.solids and the base strut animation
//   killNear()  — flip the closest living ped in range to 'dead'; the fall
//                 pose itself is applied by update(), so this never touches
//                 meshes and a missing rig can never throw
//
// Tuning pairs to keep coherent:
//   GUNFIRE_RADIUS must stay below SAFE_ZONE, or a ped that starts sprinting
//   would instantly calm down with the shooter still standing there.
//   SPRINT_SPEED must lose to peds2's PANIC_SPRINT (6.4), or peds handed over
//   to the panic layer would visibly slow down mid-flight.

import { TRAFFIC, PLAYER, WORLD } from './config.js';
import { pedMesh } from './models.js';
import { resolveCircle } from './vehicles.js';
import { HALF } from './city.js';

// Skin + outfit palettes, exported as PED_PALETTES so other systems can
// sample them without re-declaring the hex sets.
const SKIN = [0xe0b48c, 0xc98e5e, 0x8a5a3a, 0x6e4428];
const SHIRT = [0xd65f5f, 0x5f7fd6, 0x63b46a, 0xd6c45f, 0xb45fd6, 0x5fb8b4, 0xdddddd];

const GUNFIRE_RADIUS = 26;   // a shot this close starts the sprint
const SAFE_ZONE = 40;        // calm resumes once this far from the player
const SPRINT_SPEED = 5.2;    // panic pace; peds2's PANIC_SPRINT must beat it
const BODY_LINGER = 9;       // seconds a body stays before the slot recycles
const EDGE_MARGIN = 20;      // streets stay walkable a little past the edge

// Strut look: arm/leg swing amplitude and how fast the stride advances.
const SWING = 0.62;
const STRIDE_GAIN = 3.2;
const WANDER_CHANCE = 0.5;   // per second, a stroller drifts onto a new heading

export class Peds {
  constructor(scene, city, rng) {
    this.city = city;
    this.scene = scene;
    this.peds = [];
    this.lastAlarm = null;   // {x, z} of the most recent gunfire, if any
    for (let i = 0; i < TRAFFIC.pedCount; i++) {
      const mesh = pedMesh(rng);
      scene.add(mesh);
      this.peds.push(this.spawn(rng, { mesh }));
    }
  }

  // (Re)place one ped. Called at boot for every slot and again when a dead
  // ped's timer runs out, so it must fully reset the record it is given.
  // One fixed draw order — lane → along → side → heading → pace → phase —
  // keeps a fixed seed laying out the identical crowd.
  spawn(rng, p) {
    const lanes = this.city.roadLines;
    const lane = lanes[Math.floor(rng() * lanes.length)];
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
    if (p.fearLevel !== undefined) p.fearLevel = 0;  // clear peds2 layer state on recycle
    p.mesh.visible = true;
    p.mesh.rotation.x = 0;
    p.mesh.position.set(p.x, 0, p.z);
    return p;
  }

  // Register a panic source between frames (optional convenience).
  setAlarm(pos) { this.lastAlarm = pos; }

  update(dt, rng, playerPos, solids, alarmPos) {
    const alarm = alarmPos || this.lastAlarm;
    for (const p of this.peds) {
      if (p.state === 'dead') {
        this._lieStill(p, dt);
        if (p.deadT <= 0) this.spawn(rng, p);
        continue;
      }

      // Gunfire (or a standing alarm) nearby trips the sprint.
      if (alarm && Math.hypot(alarm.x - p.x, alarm.z - p.z) < GUNFIRE_RADIUS) {
        p.state = 'flee';
      }
      if (p.state === 'flee') this._runAway(p, playerPos);
      if (p.state === 'walk') {
        p.speed = TRAFFIC.pedSpeed;
        // Occasional idle turn so the crowd never marches in lockstep.
        if (rng() < dt * WANDER_CHANCE) p.heading += (rng() - 0.5) * 1.6;
      }

      this._step(p, dt, solids, rng);
      this._strut(p, dt);
    }
  }

  // Dead pose: face-plant in place, keeping the pre-death heading.
  _lieStill(p, dt) {
    p.deadT -= dt;
    p.mesh.rotation.x = Math.PI / 2;
    p.mesh.position.y = 0.2;
  }

  // Sprint directly away until SAFE_ZONE is cleared, then resume strolling.
  _runAway(p, playerPos) {
    const gap = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
    if (gap > SAFE_ZONE) {
      p.state = 'walk';
      return;
    }
    p.heading = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
    p.speed = SPRINT_SPEED;
  }

  // One movement step with collision. A blocked ped veers sideways with a
  // little noise; one that wandered past the map edge turns back.
  _step(p, dt, solids, rng) {
    const nx = p.x + Math.sin(p.heading) * p.speed * dt;
    const nz = p.z + Math.cos(p.heading) * p.speed * dt;
    const hit = resolveCircle(nx, nz, PLAYER.radius, solids);
    if (hit.blocked) {
      p.heading += Math.PI / 2 + rng();
    } else if (Math.abs(hit.x) < HALF + EDGE_MARGIN && Math.abs(hit.z) < HALF + EDGE_MARGIN) {
      p.x = hit.x;
      p.z = hit.z;
    } else {
      p.heading += Math.PI;
    }
  }

  // Base strut: opposite arm/leg swing, small bob, forward lean.
  _strut(p, dt) {
    p.phase += dt * p.speed * STRIDE_GAIN;
    const swing = Math.sin(p.phase) * SWING;
    const limbs = p.mesh.userData.limbs;
    limbs[0].rotation.x = swing;
    limbs[1].rotation.x = -swing;
    limbs[2].rotation.x = -swing * 0.8;
    limbs[3].rotation.x = swing * 0.8;
    p.mesh.position.y = Math.abs(Math.sin(p.phase)) * 0.05;
    p.mesh.rotation.x = p.state === 'flee' ? 0.14 : 0.05;
    p.mesh.position.set(p.x, 0, p.z);
    p.mesh.rotation.y = p.heading;
  }

  // Flip the nearest living ped in range to dead; returns it or null.
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
      best.deadT = BODY_LINGER;
      best.speed = 0;        // the fall owns the body from here
      if (best.fearLevel !== undefined) best.fearLevel = 0;
    }
    return best;
  }
}

export const PED_PALETTES = Object.freeze({ SKIN, SHIRT });
