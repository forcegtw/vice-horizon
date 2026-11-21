// peds.js — the sidewalk crowd: spawn, stroll, panic, fall, recycle.
//
// A pedestrian is a plain record { x, z, heading, speed, phase, state, deadT,
// mesh } wrapped around a jointed rig from models.pedMesh. The crowd is a
// fixed pool of TRAFFIC.pedCount slots: records are recycled, never created
// or freed, so even a sustained rampage allocates nothing.
//
// What lives here:
//   spawn()    — (re)place one record on a road line's pavement. Runs once
//                per slot at boot and again when a body's timer runs out.
//   setAlarm() — stash a panic source between frames (main.js also feeds the
//                freshest gunshot straight into update()).
//   update()   — the per-ped machine: dead → flee → walk, collision against
//                city.solids, and the base strut that drives the rig.
//   killNear() — switch the nearest living ped in range to 'dead'. The fall
//                pose is applied by update(), so this never touches meshes
//                and cannot throw on a missing rig.
//
// Tuning pairs to keep coherent:
//   HEAR_GUNFIRE must stay below CALM_GAP — a ped that breaks into a sprint
//   may not calm down while the shooter is still standing there.
//   FLEE_SPEED must lose to peds2's PANIC_SPRINT (6.4), or peds handed over
//   to the panic layer would visibly slow down mid-flight.

import { TRAFFIC, PLAYER, WORLD } from './config.js';
import { pedMesh } from './models.js';
import { resolveCircle } from './vehicles.js';
import { HALF } from './city.js';

// Complexion + wardrobe tables, re-exported as PED_PALETTES so other systems
// can sample the same looks without re-declaring the hex sets.
const SKIN = [0xe0b48c, 0xc98e5e, 0x8a5a3a, 0x6e4428];
const SHIRT = [0xd65f5f, 0x5f7fd6, 0x63b46a, 0xd6c45f, 0xb45fd6, 0x5fb8b4, 0xdddddd];

// Panic radius vs calm radius (see the pairing note in the header).
const HEAR_GUNFIRE = 26;
const CALM_GAP = 40;
const FLEE_SPEED = 5.2;     // panic pace; peds2's PANIC_SPRINT must beat it
const BODY_STAY = 9;        // seconds a body rests before its slot recycles
const EDGE_PAD = 20;        // pavement stays walkable a little past the edge

// Strut look: swing amplitude, stride tempo, and the per-second chance a
// stroller picks a fresh heading so the crowd never marches in lockstep.
const STRUT_AMPLITUDE = 0.62;
const STRIDE_TEMPO = 3.2;
const DRIFT_CHANCE = 0.5;
const DRIFT_ARC = 1.6;      // radians a wandering stroller may swing through

export class Peds {
  constructor(scene, city, rng) {
    this.city = city;
    this.scene = scene;
    this.peds = [];
    this.lastAlarm = null;   // {x, z} of the latest gunfire, when known
    for (let i = 0; i < TRAFFIC.pedCount; i++) {
      const mesh = pedMesh(rng);
      scene.add(mesh);
      this.peds.push(this.spawn(rng, { mesh }));
    }
  }

  // (Re)place one ped record. One fixed draw order — lane → along → side →
  // heading → pace → phase — keeps a fixed seed laying out the same crowd
  // every boot. `p` may carry layer state from peds2; fear is wiped here so
  // a recycled ped never comes back still scared of its previous life.
  spawn(rng, p) {
    const lanes = this.city.roadLines;
    const lane = lanes[Math.floor(rng() * lanes.length)];
    const along = (rng() - 0.5) * 2 * HALF;
    // Pavement offset: just outside the roadway, inside the sidewalk strip.
    const side = (rng() < 0.5 ? 1 : -1) * (WORLD.roadWidth / 2 + WORLD.sidewalk * 0.6);
    p.x = lane.axis === 'z' ? lane.line + side : along;
    p.z = lane.axis === 'z' ? along : lane.line + side;
    p.heading = rng() * Math.PI * 2;
    p.speed = TRAFFIC.pedSpeed * (0.7 + rng() * 0.6);
    p.phase = rng() * Math.PI * 2;
    p.state = 'walk';            // walk | flee | dead
    p.deadT = 0;
    if (p.fearLevel !== undefined) p.fearLevel = 0;
    p.mesh.visible = true;
    p.mesh.rotation.x = 0;
    p.mesh.position.set(p.x, 0, p.z);
    return p;
  }

  // Register a panic source between frames (optional convenience).
  setAlarm(pos) { this.lastAlarm = pos; }

  // Per-ped machine. Dead bodies rest and recycle; the living react to the
  // alarm, take one movement step, and play the base strut.
  update(dt, rng, playerPos, solids, alarmPos) {
    const alarm = alarmPos || this.lastAlarm;
    for (const p of this.peds) {
      if (p.state === 'dead') {
        this._restBody(p, dt);
        if (p.deadT <= 0) this.spawn(rng, p);
        continue;
      }
      this._react(p, alarm, playerPos, dt, rng);
      this._advance(p, dt, solids, rng);
      this._walkCycle(p, dt);
    }
  }

  // Fall pose: face-plant in place, keeping the pre-death heading. The body
  // keeps whatever x/z the last strut left so it never snaps on death.
  _restBody(p, dt) {
    p.deadT -= dt;
    p.mesh.rotation.x = Math.PI / 2;
    p.mesh.position.y = 0.2;
  }

  // Gunfire (or a standing alarm) nearby trips the sprint. Fleeing peds run
  // until CALM_GAP is cleared, then rejoin the stroll on the same frame —
  // speed and wander resume immediately, so nobody coasts at sprint pace.
  _react(p, alarm, playerPos, dt, rng) {
    if (alarm && Math.hypot(alarm.x - p.x, alarm.z - p.z) < HEAR_GUNFIRE) {
      p.state = 'flee';
    }
    if (p.state === 'flee') this._sprintAway(p, playerPos);
    if (p.state === 'walk') {
      p.speed = TRAFFIC.pedSpeed;
      if (rng() < dt * DRIFT_CHANCE) p.heading += (rng() - 0.5) * DRIFT_ARC;
    }
  }

  // Run directly away from the player; calm returns past CALM_GAP.
  _sprintAway(p, playerPos) {
    const gap = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
    if (gap > CALM_GAP) {
      p.state = 'walk';
      return;
    }
    p.heading = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
    p.speed = FLEE_SPEED;
  }

  // One movement step with collision. A blocked ped veers sideways with a
  // little noise; one that wandered past the map edge turns back around.
  _advance(p, dt, solids, rng) {
    const nx = p.x + Math.sin(p.heading) * p.speed * dt;
    const nz = p.z + Math.cos(p.heading) * p.speed * dt;
    const hit = resolveCircle(nx, nz, PLAYER.radius, solids);
    if (hit.blocked) {
      p.heading += Math.PI / 2 + rng();
    } else if (Math.abs(hit.x) < HALF + EDGE_PAD && Math.abs(hit.z) < HALF + EDGE_PAD) {
      p.x = hit.x;
      p.z = hit.z;
    } else {
      p.heading += Math.PI;
    }
  }

  // Base strut: opposite arm/leg swing (limbs are [legL, legR, armL, armR]),
  // a small bob, and a forward lean that deepens while fleeing.
  _walkCycle(p, dt) {
    p.phase += dt * p.speed * STRIDE_TEMPO;
    const swing = Math.sin(p.phase) * STRUT_AMPLITUDE;
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
      best.deadT = BODY_STAY;
      best.speed = 0;          // the fall owns the body from here
      if (best.fearLevel !== undefined) best.fearLevel = 0;
    }
    return best;
  }
}

export const PED_PALETTES = Object.freeze({ SKIN, SHIRT });
