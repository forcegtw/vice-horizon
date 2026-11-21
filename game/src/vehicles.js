// vehicles.js — the kinetic layer: a shared arcade Vehicle entity, circle-vs-AABB
// collision resolution against the city's colliders, lane traffic, and police
// pursuit. There is no physics engine; every body is a circle pushed out of static
// boxes, which is cheap and — tuned by config's CAR constants — feels right.
// resolveCircle is exported because peds and the camera share it: resolve the
// player first each frame so traffic visibly yields instead of shoving them.
// Two determinism rules hold everywhere here: respawns pull from the caller's
// seeded rng (never Math.random), and paint choice derives from the spawn transform,
// so ?shot= replays and the smoke harnesses see identical cars.

import * as THREE from '../vendor/three.min.js';
import { CAR, TRAFFIC, POLICE } from './config.js';
import { carMesh } from './models.js';
import { HALF } from './city.js';

const CAR_COLORS = [0xb0182c, 0x1a3a6b, 0xe8e8ea, 0x101318, 0x8f9299, 0xc9a227, 0x2c6e49, 0xd4581f];
// Traffic skips the near-black paint so cars stay visible against dark asphalt.
const CAR_BRIGHT = CAR_COLORS.filter((c) => c !== 0x101318);

// Lane offset from the street centre line (two lanes, one each way).
const LANE_OFFSET = 3.4;
// Traffic braking feel: how far ahead a car looks, and how quickly it sheds speed.
const PROBE_RANGE = 9;
const PROBE_SIDE = 2.4;
const BRAKE_DECEL = 18;
const RESUME_ACCEL = 6;
// Runaway-guard and carjack-window tuning.
const ESCAPE_MARGIN = 30;              // metres beyond HALF before a car turns around
const TURNAROUND_SPIN = Math.PI * 0.9;
const CARJACK_RANGE = 4;
const CARJACK_SIDE = 2.2;

// ---------------------------------------------------------------------------
// Vehicle entity shared by the player, traffic and police.
// ---------------------------------------------------------------------------
export class Vehicle {
  constructor(mesh, x, z, heading, kind) {
    this.mesh = mesh;
    this.kind = kind;              // 'player' | 'traffic' | 'police'
    this.x = x;
    this.z = z;
    this.y = 0;
    this.heading = heading;        // radians, 0 = facing +Z
    this.speed = 0;
    this.steer = 0;
    this.health = CAR.health;
    this.wheelSpin = 0;
    // Paint index derived from the spawn transform, not Math.random — replay-safe.
    this.colorIndex = (Math.abs(Math.round(x * 7 + z * 13)) + Math.round(heading * 5)) % CAR_COLORS.length;
    this.targetLane = null;        // reserved for traffic lane planning
    this.dead = false;
    this.burnT = 0;
  }

  forwardX() { return Math.sin(this.heading); }
  forwardZ() { return Math.cos(this.heading); }

  // One integration step. throttle and steerInput are in [-1, 1]; maxScale lets an
  // engine upgrade raise the forward cap without retuning CAR.maxSpeed.
  drive(throttle, steerInput, dt, solids, maxScale = 1) {
    const accel = throttle > 0 ? CAR.accel : CAR.brake;
    if (throttle !== 0) {
      const cap = throttle > 0 ? CAR.maxSpeed * maxScale : CAR.reverseSpeed;
      this.speed = THREE.MathUtils.clamp(this.speed + throttle * accel * dt, -cap, cap);
    } else {
      // Engine drag plus rolling friction; snap to a stop below a crawl so the
      // speedometer and idle engine loop settle instead of whispering forever.
      this.speed *= Math.pow(0.4, dt);
      if (Math.abs(this.speed) < 0.15) this.speed = 0;
    }

    // Steering authority grows with speed; the heading only turns while moving,
    // with the sign flipping in reverse so backing up steers like a real car.
    const authority = THREE.MathUtils.clamp(Math.abs(this.speed) / 10, 0.15, 1);
    this.steer = THREE.MathUtils.damp(this.steer, steerInput, 8, dt);
    this.heading += this.steer * CAR.turnRate * authority * dt * Math.sign(this.speed || 1);

    const nx = this.x + this.forwardX() * this.speed * dt;
    const nz = this.z + this.forwardZ() * this.speed * dt;
    const hit = resolveCircle(nx, nz, CAR.radius, solids);
    if (hit.blocked) {
      // Crunch: shed most of the speed, bounce back slightly, take impact damage.
      this.speed *= -0.25;
      this.takeDamage(Math.abs(this.speed) * 1.2 + 2);
      if (this.onCrash) this.onCrash(this);
    } else {
      this.x = hit.x;
      this.z = hit.z;
    }
    this.wheelSpin += this.speed * dt * 2.4;
  }

  takeDamage(d) {
    if (this.dead) return;
    this.health -= d;
    if (this.health <= 0) {
      this.dead = true;
      this.burnT = 4;
      if (this.onExplode) this.onExplode(this);
    }
  }

  sync() {
    if (!this.mesh) return;
    this.mesh.position.set(this.x, this.y, this.z);
    this.mesh.rotation.set(0, this.heading, this.steer * -0.06); // bank into the turn
    const wheels = this.mesh.userData.wheels || [];
    for (let i = 0; i < wheels.length; i++) {
      wheels[i].rotation.x = this.wheelSpin;
      if (i < 2) wheels[i].rotation.y = this.steer * 0.5;
    }
  }
}

// Push a circle out of every AABB it overlaps; returns the corrected position.
// Two passes: the first resolves the deepest overlap, the second cleans up cases
// where escaping one box shoved the circle into a neighbour.
export function resolveCircle(x, z, r, solids) {
  let blocked = false;
  for (let pass = 0; pass < 2; pass++) {
    for (const s of solids) {
      const cx = THREE.MathUtils.clamp(x, s.minX, s.maxX);
      const cz = THREE.MathUtils.clamp(z, s.minZ, s.maxZ);
      const dx = x - cx, dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r && d2 > 1e-9) {
        blocked = true;
        const d = Math.sqrt(d2);
        const push = (r - d) / d;
        x += dx * push;
        z += dz * push;
      } else if (d2 <= 1e-9) {
        blocked = true;
        x += r; // centre sits exactly inside the box: shove along +x
      }
    }
  }
  return { x, z, blocked };
}

// ---------------------------------------------------------------------------
// Traffic: cars loop along street lanes, braking for whatever is ahead.
// ---------------------------------------------------------------------------
export class Traffic {
  constructor(scene, city, rng) {
    this.city = city;
    // Keep the world-gen rng so respawns stay deterministic for a given seed.
    this.rng = rng;
    this.cars = [];
    for (let i = 0; i < TRAFFIC.carCount; i++) {
      const lane = city.roadLines[Math.floor(rng() * city.roadLines.length)];
      const along = (rng() - 0.5) * 2 * HALF;
      const dir = rng() < 0.5 ? 1 : -1;
      let x, z, heading;
      if (lane.axis === 'z') {
        x = lane.line + dir * LANE_OFFSET;
        z = along;
        heading = dir > 0 ? 0 : Math.PI;
      } else {
        z = lane.line + dir * LANE_OFFSET;
        x = along;
        heading = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      }
      const color = CAR_BRIGHT[Math.floor(rng() * CAR_BRIGHT.length)];
      const mesh = carMesh(color);
      scene.add(mesh);
      const v = new Vehicle(mesh, x, z, heading, 'traffic');
      v.speed = TRAFFIC.carSpeed * (0.7 + rng() * 0.4);
      this.cars.push(v);
    }
  }

  update(dt, playerPos, solids, onAlert) {
    for (const c of this.cars) {
      if (c.dead) {
        c.burnT -= dt;
        c.mesh.rotation.z += dt * 0.3;
        c.y = Math.max(-0.6, c.y - dt * 0.4);
        if (c.burnT <= 0) this.respawn(c);
        continue;
      }

      // Look-ahead: brake for another car (or the player) inside the probe cone.
      const fx = c.forwardX(), fz = c.forwardZ();
      let brake = false;
      for (const o of this.cars) {
        if (o === c || o.dead) continue;
        const dx = o.x - c.x, dz = o.z - c.z;
        const ahead = dx * fx + dz * fz;
        const side = Math.abs(dx * fz - dz * fx);
        if (ahead > 0 && ahead < PROBE_RANGE && side < PROBE_SIDE) brake = true;
      }
      const pdx = playerPos.x - c.x, pdz = playerPos.z - c.z;
      const pAhead = pdx * fx + pdz * fz;
      const pSide = Math.abs(pdx * fz - pdz * fx);
      if (pAhead > 0 && pAhead < PROBE_RANGE && pSide < 2.6) brake = true;

      c.speed = brake
        ? Math.max(0, c.speed - BRAKE_DECEL * dt)
        : Math.min(TRAFFIC.carSpeed, c.speed + RESUME_ACCEL * dt);

      // Runaway guard: a car that somehow escapes the map turns around instead of
      // fighting the boundary. The 30 m grace band lets corner swings breathe.
      const nx = c.x + fx * c.speed * dt;
      const nz = c.z + fz * c.speed * dt;
      const hit = resolveCircle(nx, nz, CAR.radius, solids);
      if (hit.blocked || Math.abs(hit.x) > HALF + ESCAPE_MARGIN || Math.abs(hit.z) > HALF + ESCAPE_MARGIN) {
        c.heading += TURNAROUND_SPIN;
        c.speed = 2;
        c.wheelSpin = 0; // drop pre-teleport highway spin
      } else {
        c.x = hit.x;
        c.z = hit.z;
      }

      // Carjack window: a slow car right beside the player on foot is stealable.
      if (onAlert && pAhead > 0 && pAhead < CARJACK_RANGE && pSide < CARJACK_SIDE && playerPos.onFoot) onAlert(c);

      c.wheelSpin += c.speed * dt * 2.4;
      c.sync();
    }
  }

  respawn(c) {
    const lane = this.city.roadLines[Math.floor(this.rng() * this.city.roadLines.length)];
    const along = (this.rng() - 0.5) * 2 * HALF;
    const dir = this.rng() < 0.5 ? 1 : -1;
    c.health = CAR.health;
    c.dead = false;
    c.burnT = 0;
    c.y = 0;
    c.mesh.rotation.z = 0;
    if (lane.axis === 'z') {
      c.x = lane.line + dir * LANE_OFFSET;
      c.z = along;
      c.heading = dir > 0 ? 0 : Math.PI;
    } else {
      c.z = lane.line + dir * LANE_OFFSET;
      c.x = along;
      c.heading = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
    c.speed = TRAFFIC.carSpeed * 0.8;
    c.sync();
  }
}

// ---------------------------------------------------------------------------
// Police: spawn with the wanted count, pursue the player, shoot on foot, and
// bump in cars. Livery is applied to a pearl-white sedan at spawn time.
// ---------------------------------------------------------------------------
export class Police {
  constructor(scene) {
    this.scene = scene;
    this.units = [];
    this.spawnTimer = 0;
  }

  // Reconcile the unit count with the current star rating. Called every frame.
  syncCount(wanted, dt, player, solids, rng, city) {
    const want = Math.min(POLICE.copsPerStar * wanted, 10);
    if (wanted === 0) {
      for (const u of this.units) this.scene.remove(u.mesh);
      this.units.length = 0;
      return;
    }
    this.spawnTimer -= dt;
    if (this.units.length < want && this.spawnTimer <= 0) {
      this.spawnTimer = 1.2;
      const ang = rng() * Math.PI * 2;
      const dist = 70 + rng() * 30;
      const x = THREE.MathUtils.clamp(player.x + Math.sin(ang) * dist, -HALF, HALF);
      const z = THREE.MathUtils.clamp(player.z + Math.cos(ang) * dist, -HALF, HALF);
      const mesh = carMesh(2); // PAINTS[2] — pearl white cruiser

      // Livery: blue door stripes and a red/blue lightbar.
      const stripeMat = new THREE.MeshStandardMaterial({ color: 0x1c3f8f, roughness: 0.4, metalness: 0.5 });
      for (const s of [-1, 1]) {
        const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 3.6), stripeMat);
        stripe.position.set(s * 1.03, 0.72, 0);
        mesh.add(stripe);
      }
      const barBase = new THREE.Mesh(
        new THREE.BoxGeometry(1.15, 0.12, 0.34),
        new THREE.MeshStandardMaterial({ color: 0x191b20, roughness: 0.6 })
      );
      barBase.position.set(0, 1.6, -0.35);
      mesh.add(barBase);
      const red = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.3),
        new THREE.MeshStandardMaterial({ color: 0xff3333, emissive: 0xff2222, emissiveIntensity: 2 }));
      red.position.set(-0.3, 1.72, -0.35);
      const blue = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x3366ff, emissive: 0x2244ff, emissiveIntensity: 2 }));
      blue.position.set(0.3, 1.72, -0.35);
      mesh.add(red, blue);
      // The lightbar halves are the update() strobe contract.
      mesh.userData.beacons = [red, blue];

      this.scene.add(mesh);
      const v = new Vehicle(mesh, x, z, Math.atan2(player.x - x, player.z - z), 'police');
      v.fireT = 0;
      this.units.push(v);
    }
    while (this.units.length > want) {
      const u = this.units.pop();
      if (u?.mesh?.parent) this.scene.remove(u.mesh);
    }
  }

  // Unit count for the HUD's siren readout.
  count() { return this.units.length; }

  update(dt, player, state, solids, rng, damagePlayer, onBust) {
    // Iterate backwards so removing a wrecked unit can't skip its neighbour.
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u.dead) {
        u.burnT -= dt;
        u.y = Math.max(-0.6, u.y - dt * 0.4);
        if (u.burnT <= 0) {
          this.scene.remove(u.mesh);
          this.units.splice(i, 1);
        }
        u.sync();
        continue;
      }

      // Beacon strobe: alternate the halves and sweep intensity with a sine so it
      // reads as a rotating bar rather than an on/off binary.
      const beacons = u.mesh.userData.beacons;
      if (beacons) {
        const phase = Math.floor(state.time * 6) % 2;
        const hot = 2.2 + Math.sin(state.time * 18) * 0.5;
        beacons[0].material.emissiveIntensity = phase ? hot : 0.3;
        beacons[1].material.emissiveIntensity = phase ? 0.3 : hot;
      }

      // Steer at the player; back off for the arrest once close.
      const dx = player.x - u.x, dz = player.z - u.z;
      const dist = Math.hypot(dx, dz);
      let diff = Math.atan2(dx, dz) - u.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // wrap to [-PI, PI]
      const steer = THREE.MathUtils.clamp(diff * 1.6, -1, 1);
      if (dist > 12) {
        u.drive(Math.sin(diff) > -0.4 ? 0.8 : 0.3, steer, dt, solids);
      } else {
        u.drive(dist > 6 ? 0.5 : -0.4, steer, dt, solids);
      }

      // Arcade shooting: range-gated, no wall check, faster with more stars.
      u.fireT -= dt;
      if (dist < POLICE.shootRange && u.fireT <= 0 && player.alive) {
        u.fireT = POLICE.fireInterval / Math.max(1, state.wanted * 0.6);
        damagePlayer(POLICE.damage, 'cop');
        state.sfx.gunshot(0.4);
      }
      u.sync();
    }
  }

  clear() {
    for (const u of this.units) this.scene.remove(u.mesh);
    this.units.length = 0;
  }
}
