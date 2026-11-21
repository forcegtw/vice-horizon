// peds.js — the street crowd. Low-poly walkers cruising the sidewalks who
// panic at gunfire, get knocked flat, and recycle through spawn(). The class
// doubles as the rig for rival NPCs in the eliminate mission, so killNear()
// is also the mission kill path.
//
// Ownership split: peds.js owns the ped record and the walk/flee/dead state
// machine; peds2.js layers richer animation and fear on top and must never
// fight this class over p.state. Outfits come from models.pedMesh, which
// draws from the shared seeded rng — the draw count per ped is part of the
// replay contract, so spawn() keeps its exact draw order.
//
// Two radii shape crowd panic: gunfire within ALARM_RADIUS scares a ped, and
// it keeps sprinting until it is CALM_RADIUS from the player. Raising the
// calm radius keeps streets scared longer after the shooting stops. Dead
// peds hold their heading when they fall (no snap toward the killer) and
// recycle in place, so the ped cap and draw-call count stay honest.

import { TRAFFIC, PLAYER, WORLD } from './config.js';
import { pedMesh } from './models.js';
import { resolveCircle } from './vehicles.js';
import { HALF } from './city.js';

// Gunfire scares peds within this range; they settle once this far from the panic source.
const ALARM_RADIUS = 26;
const CALM_RADIUS = 40;
// Sprint of a scared ped. peds2's PANIC_SPRINT must stay above this or
// sprinters visibly slow down at the moment they should be fastest.
const FLEE_SPEED = 5.2;
// Base strut: stride cycles per second and swing amplitude.
const STRUT_RATE = 3.2;
const STRUT_SWING = 0.62;
// Sidewalk clearance: peds walk this far off the road centre line.
const CURB_OFFSET = WORLD.roadWidth / 2 + WORLD.sidewalk * 0.6;
// Past this distance from the centre a ped has wandered out of the city and is bounced back.
const CITY_MARGIN = HALF + 20;
// A downed ped stays on the ground this many seconds before recycling.
const DEAD_SECONDS = 9;

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

  // (Re)place one ped on a random sidewalk. Every rng draw here is part of the
  // seeded replay contract: lane, stretch along it, curb side, heading, pace
  // and gait phase, in that order.
  spawn(rng, p) {
    const lines = this.city.roadLines;
    const lane = lines[Math.floor(rng() * lines.length)];
    const along = (rng() - 0.5) * 2 * HALF;
    const curb = (rng() < 0.5 ? 1 : -1) * CURB_OFFSET;
    p.x = lane.axis === 'z' ? lane.line + curb : along;
    p.z = lane.axis === 'z' ? along : lane.line + curb;
    p.heading = rng() * Math.PI * 2;
    p.speed = TRAFFIC.pedSpeed * (0.7 + rng() * 0.6);
    p.phase = rng() * Math.PI * 2;
    p.state = 'walk';          // walk | flee | dead
    p.deadT = 0;
    p.mesh.visible = true;
    p.mesh.position.set(p.x, 0, p.z);
    return p;
  }

  update(dt, rng, playerPos, solids, alarmPos) {
    for (const p of this.peds) {
      if (p.state === 'dead') { this._stepDead(p, dt, rng); continue; }
      this._stepAlive(p, dt, rng, playerPos, solids, alarmPos);
      this._pose(p, dt);
    }
  }

  // Dead peds simply tip over onto the ground and wait out the timer, then
  // recycle through spawn() with a clean record.
  _stepDead(p, dt, rng) {
    p.deadT -= dt;
    p.mesh.rotation.x = Math.PI / 2;
    p.mesh.position.y = 0.2;
    if (p.deadT <= 0) {
      p.mesh.rotation.x = 0;
      this.spawn(rng, p);
    }
  }

  // Per-ped brains and movement for the living. The flee branch never draws
  // from rng (deterministic sprint away from the player); only wandering and
  // obstacle turns spend draws.
  _stepAlive(p, dt, rng, playerPos, solids, alarmPos) {
    // Gunfire nearby flips the panic state on. The wanted player standing
    // close is handled by peds2, which hands over into this same flee branch.
    if (alarmPos && Math.hypot(alarmPos.x - p.x, alarmPos.z - p.z) < ALARM_RADIUS) {
      p.state = 'flee';
    }

    if (p.state === 'flee') {
      // Sprint straight away from the player; settle back once well clear.
      // A ped calming down this frame still flees this frame — the else is
      // skipped — so the transition never teleports the stride.
      if (Math.hypot(playerPos.x - p.x, playerPos.z - p.z) > CALM_RADIUS) p.state = 'walk';
      p.heading = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
      p.speed = FLEE_SPEED;
    } else {
      p.speed = TRAFFIC.pedSpeed;
      // Occasional wander turn.
      if (rng() < dt * 0.5) p.heading += (rng() - 0.5) * 1.6;
    }

    const nx = p.x + Math.sin(p.heading) * p.speed * dt;
    const nz = p.z + Math.cos(p.heading) * p.speed * dt;
    const hit = resolveCircle(nx, nz, PLAYER.radius, solids);
    if (hit.blocked) {
      p.heading += Math.PI / 2 + rng();   // shuffle around the obstacle
    } else if (Math.abs(hit.x) < CITY_MARGIN && Math.abs(hit.z) < CITY_MARGIN) {
      p.x = hit.x;
      p.z = hit.z;
    } else {
      p.heading += Math.PI;               // turned around at the city edge
    }
  }

  // Strut pose for the living: alternating limb swings with counter-swinging
  // arms, plus a forward lean that deepens while fleeing. Runs after the
  // step so the pose matches this frame's motion; peds2 re-poses on top.
  _pose(p, dt) {
    p.phase += dt * p.speed * STRUT_RATE;
    const limbs = p.mesh.userData.limbs;
    const swing = Math.sin(p.phase) * STRUT_SWING;
    limbs[0].rotation.x = swing;
    limbs[1].rotation.x = -swing;
    limbs[2].rotation.x = -swing * 0.8;
    limbs[3].rotation.x = swing * 0.8;
    p.mesh.rotation.x = p.state === 'flee' ? 0.14 : 0.05;
    p.mesh.position.set(p.x, 0, p.z);
    p.mesh.rotation.y = p.heading;
  }

  // Kill the nearest living ped within range; returns the ped or null. This
  // only flips state — the dead branch poses the fall — so a missed mesh can
  // never crash. fearLevel belongs to the peds2 layer; resetting it here keeps
  // the recycled ped from panicking on respawn.
  killNear(x, z, range) {
    let best = null;
    let bestD2 = range * range;
    for (const p of this.peds) {
      if (p.state === 'dead') continue;
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = p; }
    }
    if (best) {
      best.state = 'dead';
      best.deadT = DEAD_SECONDS;
      best.speed = 0;      // the fall animation owns the body from here
      best.fearLevel = 0;
    }
    return best;
  }
}
