// Vehicles: geometry factory, player driving physics, traffic AI and police pursuit.
// Everything is simple kinematic arcade physics against the city's AABB colliders;
// handbrake-style tuning lives in config, not here. resolveCircle is shared so peds
// and cars can push each other without a physics engine — call it for the player
// first so traffic yields to them. Realistic tire models would wreck the feel;
// arcade friction constants are deliberate.
// The runaway guard resets wheelSpin so a teleported car doesn't spin its tires at
// highway rate, and police despawn respects an already-removed mesh.

import * as THREE from '../vendor/three.min.js';
import { CAR, TRAFFIC, POLICE, WORLD } from './config.js';
import { carMesh } from './models.js';
import { HALF } from './city.js';

const CAR_COLORS = [0xb0182c, 0x1a3a6b, 0xe8e8ea, 0x101318, 0x8f9299, 0xc9a227, 0x2c6e49, 0xd4581f];

// A low-poly sedan: body + cabin + 4 wheel boxes, grouped so it can tilt and roll.
// ---------------------------------------------------------------------------
// Vehicle entity shared by player, traffic and police.
// ---------------------------------------------------------------------------
export class Vehicle {
  constructor(mesh, x, z, heading, kind) {
    this.mesh = mesh;
    this.kind = kind;              // 'player' | 'traffic' | 'police'
    this.x = x;
    this.z = z;
    this.y = 0;
    this.heading = heading;        // radians, 0 = +Z forward
    this.speed = 0;
    this.steer = 0;
    this.health = CAR.health;
    this.wheelSpin = 0;
    // Polish pass 4: paint index is derived from the spawn transform, not Math.random —
    // ?shot= replay and the smoke harness need identical cars for identical seeds.
    this.colorIndex = (Math.abs(Math.round(x * 7 + z * 13)) + Math.round(heading * 5)) % CAR_COLORS.length;
    this.targetLane = null;        // traffic AI lane
    this.dead = false;
    this.burnT = 0;
  }

  forwardX() { return Math.sin(this.heading); }
  forwardZ() { return Math.cos(this.heading); }

  // Drive with throttle in [-1,1] and steer in [-1,1]; one integration step.
  // maxScale lets upgrades (engine tune) raise the forward speed cap without
  // touching the tuned constants in config.
  drive(throttle, steerInput, dt, solids, maxScale = 1) {
    const accel = throttle > 0 ? CAR.accel : CAR.brake;
    if (throttle !== 0) {
      const cap = throttle > 0 ? CAR.maxSpeed * maxScale : CAR.reverseSpeed;
      this.speed = THREE.MathUtils.clamp(this.speed + throttle * accel * dt, -cap, cap);
    } else {
      // Engine drag + rolling friction; snap to 0 below a crawl so the speedo
      // and idle engine sound settle instead of whispering forever.
      this.speed *= Math.pow(0.4, dt);
      if (Math.abs(this.speed) < 0.15) this.speed = 0;
    }

    // Speed-sensitive steering.
    const steerAuthority = THREE.MathUtils.clamp(Math.abs(this.speed) / 10, 0.15, 1);
    this.steer = THREE.MathUtils.damp(this.steer, steerInput, 8, dt);
    this.heading += this.steer * CAR.turnRate * steerAuthority * dt * Math.sign(this.speed || 1);

    const nx = this.x + this.forwardX() * this.speed * dt;
    const nz = this.z + this.forwardZ() * this.speed * dt;
    const hit = resolveCircle(nx, nz, CAR.radius, solids);
    if (hit.blocked) {
      // Crunch: kill most of the speed, bounce slightly off the obstruction.
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
    this.mesh.rotation.set(0, this.heading, this.steer * -0.06);
    const wheels = this.mesh.userData.wheels || [];
    for (let i = 0; i < wheels.length; i++) {
      wheels[i].rotation.x = this.wheelSpin;
      if (i < 2) wheels[i].rotation.y = this.steer * 0.5;
    }
  }
}

// Push a circle out of every AABB it overlaps; returns corrected position.
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
        x += r; // degenerate: shove along +x
      }
    }
  }
  return { x, z, blocked };
}

// ---------------------------------------------------------------------------
// Traffic: cars loop along street lanes, stopping for obstacles ahead.
// ---------------------------------------------------------------------------
export class Traffic {
  constructor(scene, city, rng) {
    this.city = city;
    // Keep the world-gen RNG so respawns stay deterministic per seed (same reason
    // as Vehicle.colorIndex: shots and smoke runs must not drift between passes).
    this.rng = rng;
    this.cars = [];
    for (let i = 0; i < TRAFFIC.carCount; i++) {
      const lane = city.roadLines[Math.floor(rng() * city.roadLines.length)];
      const along = (rng() - 0.5) * 2 * HALF;
      const dir = rng() < 0.5 ? 1 : -1;
      let x, z, heading;
      if (lane.axis === 'z') {
        x = lane.line + dir * 3.4;
        z = along;
        heading = dir > 0 ? 0 : Math.PI;
      } else {
        z = lane.line + dir * 3.4;
        x = along;
        heading = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      }
      // Bias traffic toward brighter paints so cars pop against asphalt.
      const CAR_BRIGHT = CAR_COLORS.filter((c) => c !== 0x101318); // skip near-black obsidian
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

      // Simple intersection handling: keep going, but brake for cars and the player ahead.
      const fx = c.forwardX(), fz = c.forwardZ();
      let brake = false;
      const probe = 9;
      for (const o of this.cars) {
        if (o === c || o.dead) continue;
        const dx = o.x - c.x, dz = o.z - c.z;
        const along = dx * fx + dz * fz;
        const side = Math.abs(dx * fz - dz * fx);
        if (along > 0 && along < probe && side < 2.4) brake = true;
      }
      const pdx = playerPos.x - c.x, pdz = playerPos.z - c.z;
      const palong = pdx * fx + pdz * fz;
      const pside = Math.abs(pdx * fz - pdz * fx);
      if (palong > 0 && palong < probe && pside < 2.6) brake = true;

      if (brake) c.speed = Math.max(0, c.speed - 18 * dt);
      else c.speed = Math.min(TRAFFIC.carSpeed, c.speed + 6 * dt);

      // Runaway guard: teleport back onto a lane if it wandered out of bounds.
      const nx = c.x + fx * c.speed * dt;
      const nz = c.z + fz * c.speed * dt;
      const hit = resolveCircle(nx, nz, CAR.radius, solids);
      if (hit.blocked || Math.abs(hit.x) > HALF + 30 || Math.abs(hit.z) > HALF + 30) {
        // Turn around instead of fighting the wall.
        c.heading += Math.PI * 0.9;
        c.speed = 2;
        c.wheelSpin = 0; // don't keep highway spin from the pre-teleport run
      } else {
        c.x = hit.x; c.z = hit.z;
      }

      // Player carjacking: slow traffic near a player on foot is stealable.
      if (onAlert && palong > 0 && palong < 4 && pside < 2.2 && playerPos.onFoot) onAlert(c);

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
      c.x = lane.line + dir * 3.4; c.z = along;
      c.heading = dir > 0 ? 0 : Math.PI;
    } else {
      c.z = lane.line + dir * 3.4; c.x = along;
      c.heading = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
    c.speed = TRAFFIC.carSpeed * 0.8;
    c.sync();
  }
}

// ---------------------------------------------------------------------------
// Police: pursue the player when wanted, shoot on foot, PIT-style bumps in cars.
// ---------------------------------------------------------------------------
export class Police {
  constructor(scene) {
    this.scene = scene;
    this.units = [];
    this.spawnTimer = 0;
  }

  syncCount(wanted, dt, player, solids, rng, city) {
    const want = Math.min(POLICE.copsPerStar * wanted, 10);
    // Despawn when calm.
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
      const mesh = carMesh(2); // pearl white paint (PAINTS[2] in models.js)
      // Police livery: blue stripe panels + lightbar.
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
      mesh.userData.beacon = { material: { color: { setHex: () => {} } } };
      mesh.userData.beacons = [red, blue];
      this.scene.add(mesh);
      const v = new Vehicle(mesh, x, z, Math.atan2(player.x - x, player.z - z), 'police');
      v.fireT = 0;
      v.wanted = true;
      this.units.push(v);
    }
    while (this.units.length > want) {
      const u = this.units.pop();
      if (u?.mesh?.parent) this.scene.remove(u.mesh);
    }
  }

  update(dt, player, state, solids, rng, damagePlayer, onBust) {
    for (const u of this.units) {
      if (u.dead) {
        u.burnT -= dt;
        u.y = Math.max(-0.6, u.y - dt * 0.4);
        if (u.burnT <= 0) {
          this.scene.remove(u.mesh);
          this.units.splice(this.units.indexOf(u), 1);
        }
        u.sync();
        continue;
      }

      // Beacon flash: alternate the lightbar halves, and sweep the intensity with a
      // sine so the strobe reads as a rotating bar rather than an on/off binary.
      const beacons = u.mesh.userData.beacons;
      if (beacons) {
        const phase = Math.floor(state.time * 6) % 2;
        const hot = 2.2 + Math.sin(state.time * 18) * 0.5;
        beacons[0].material.emissiveIntensity = phase ? hot : 0.3;
        beacons[1].material.emissiveIntensity = phase ? 0.3 : hot;
      }

      const dx = player.x - u.x, dz = player.z - u.z;
      const dist = Math.hypot(dx, dz);
      const desired = Math.atan2(dx, dz);
      let diff = desired - u.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));

      if (dist > 12) {
        u.drive(Math.sin(diff) > -0.4 ? 0.8 : 0.3, THREE.MathUtils.clamp(diff * 1.6, -1, 1), dt, solids);
      } else {
        // Close in for the arrest / shoot-out.
        u.drive(dist > 6 ? 0.5 : -0.4, THREE.MathUtils.clamp(diff * 1.6, -1, 1), dt, solids);
      }

      // Shoot at the player when in range and roughly line of sight (no wall check: keep it arcade).
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
