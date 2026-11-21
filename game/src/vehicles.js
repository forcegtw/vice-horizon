// Vehicles: the car entity, player driving physics, traffic AI and police pursuit.
// Physics is deliberately simple — kinematic arcade motion resolved against the
// city's AABB colliders via resolveCircle, which is also shared with peds so
// bodies push each other without a physics engine (call it for the player first
// so traffic yields). Real tire models would wreck the feel; the friction and
// steering constants are tuned in config and kept arcade on purpose.
// Determinism notes: traffic spawn/respawn and police spawns draw from the shared
// seeded rng in a fixed order, and Vehicle.colorIndex is derived from the spawn
// transform instead of Math.random — ?shot= replay and the smoke harnesses need
// identical cars for identical seeds.
// The turnaround guard resets wheelSpin so a teleported car doesn't keep spinning
// its tires at highway rate, and police despawn respects an already-removed mesh.

import * as THREE from '../vendor/three.min.js';
import { CAR, TRAFFIC, POLICE, WORLD } from './config.js';
import { carMesh } from './models.js';
import { HALF } from './city.js';

const CAR_COLORS = [0xb0182c, 0x1a3a6b, 0xe8e8ea, 0x101318, 0x8f9299, 0xc9a227, 0x2c6e49, 0xd4581f];
const CAR_BRIGHT = CAR_COLORS.filter((c) => c !== 0x101318); // skip near-black obsidian

const IDLE_SNAP = 0.15;        // below this speed the car simply stops (engine settles)
const COAST_DECAY = 0.4;       // no-throttle speed decay base per second
const STEER_LERP_RATE = 8;     // how fast the wheel follows the input
const WALL_BOUNCE = -0.25;     // speed kept (reversed) after crunching a wall
const WALL_DAMAGE_BASE = 2;
const WALL_DAMAGE_PER_SPEED = 1.2;
const SPIN_PER_METRE = 2.4;    // wheelSpin radians per metre travelled

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
    // Paint index is derived from the spawn transform, never from Math.random.
    this.colorIndex = (Math.abs(Math.round(x * 7 + z * 13)) + Math.round(heading * 5)) % CAR_COLORS.length;
    this.targetLane = null;        // traffic AI lane
    this.dead = false;
    this.burnT = 0;
  }

  forwardX() { return Math.sin(this.heading); }
  forwardZ() { return Math.cos(this.heading); }

  // One integration step: throttle in [-1,1], steer in [-1,1]. maxScale lets
  // upgrades (engine tune) raise the forward cap without touching config.
  drive(throttle, steerInput, dt, solids, maxScale = 1) {
    const accel = throttle > 0 ? CAR.accel : CAR.brake;
    if (throttle !== 0) {
      const cap = throttle > 0 ? CAR.maxSpeed * maxScale : CAR.reverseSpeed;
      this.speed = THREE.MathUtils.clamp(this.speed + throttle * accel * dt, -cap, cap);
    } else {
      // Engine drag + rolling friction; snap to zero below a crawl so the speedo
      // and the idle engine sound settle instead of whispering forever.
      this.speed *= Math.pow(COAST_DECAY, dt);
      if (Math.abs(this.speed) < IDLE_SNAP) this.speed = 0;
    }

    // Speed-sensitive steering authority; reverse flips the turn direction.
    const steerAuthority = THREE.MathUtils.clamp(Math.abs(this.speed) / 10, 0.15, 1);
    this.steer = THREE.MathUtils.damp(this.steer, steerInput, STEER_LERP_RATE, dt);
    this.heading += this.steer * CAR.turnRate * steerAuthority * dt * Math.sign(this.speed || 1);

    const nx = this.x + this.forwardX() * this.speed * dt;
    const nz = this.z + this.forwardZ() * this.speed * dt;
    const hit = resolveCircle(nx, nz, CAR.radius, solids);
    if (hit.blocked) {
      // Crunch: reverse most of the speed, take damage, fire the crash hook.
      this.speed *= WALL_BOUNCE;
      this.takeDamage(Math.abs(this.speed) * WALL_DAMAGE_PER_SPEED + WALL_DAMAGE_BASE);
      if (this.onCrash) this.onCrash(this);
    } else {
      this.x = hit.x;
      this.z = hit.z;
    }
    this.wheelSpin += this.speed * dt * SPIN_PER_METRE;
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

// Push a circle out of every AABB it overlaps and report whether it was squeezed.
// Two passes: the first resolves the deepest overlaps, the second cleans up any
// corner where escaping one box shoved the circle into its neighbour. The
// degenerate case (circle centred inside a box) shoves along +x to escape.
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
        x += r;
      }
    }
  }
  return { x, z, blocked };
}

// Lane bookkeeping shared by spawn and respawn: pick a street, a position along
// it, a direction, and derive the world transform. Offsets sit cars 3.4 m off the
// centre line — the right-hand lane.
function lanePlacement(city, rng) {
  const lane = city.roadLines[Math.floor(rng() * city.roadLines.length)];
  const along = (rng() - 0.5) * 2 * HALF;
  const dir = rng() < 0.5 ? 1 : -1;
  if (lane.axis === 'z') {
    return { x: lane.line + dir * 3.4, z: along, heading: dir > 0 ? 0 : Math.PI };
  }
  return { z: lane.line + dir * 3.4, x: along, heading: dir > 0 ? Math.PI / 2 : -Math.PI / 2 };
}

// ---------------------------------------------------------------------------
// Traffic: cars loop along street lanes, braking for cars and players ahead.
// ---------------------------------------------------------------------------
const LOOK_AHEAD = 9;          // metres of forward scan for obstacles
const CAR_SIDE_MARGIN = 2.4;   // lateral tolerance vs other cars
const PLAYER_SIDE_MARGIN = 2.6;
const STEAL_RANGE = 4;         // how close a stopped car must be to be flagged stealable
const STEAL_SIDE_MARGIN = 2.2;
const BRAKE_DECEL = 18;
const CRUISE_ACCEL = 6;
const OUT_OF_BOUNDS_GRACE = 30; // metres beyond HALF before the turnaround kicks in

export class Traffic {
  constructor(scene, city, rng) {
    this.city = city;
    // Keep the world-gen rng so respawns stay deterministic per seed (same reason
    // as Vehicle.colorIndex: shots and smoke runs must not drift between boots).
    this.rng = rng;
    this.cars = [];
    for (let i = 0; i < TRAFFIC.carCount; i++) {
      const spot = lanePlacement(city, rng);
      // Bias traffic toward brighter paints so cars pop against the asphalt.
      const color = CAR_BRIGHT[Math.floor(rng() * CAR_BRIGHT.length)];
      const mesh = carMesh(color);
      scene.add(mesh);
      const v = new Vehicle(mesh, spot.x, spot.z, spot.heading, 'traffic');
      v.speed = TRAFFIC.carSpeed * (0.7 + rng() * 0.4);
      this.cars.push(v);
    }
  }

  // Braking decision: another car or the player sits just ahead in our lane.
  static blockedAhead(c, fx, fz, others, playerPos) {
    for (const o of others) {
      if (o === c || o.dead) continue;
      const dx = o.x - c.x, dz = o.z - c.z;
      const along = dx * fx + dz * fz;
      if (along > 0 && along < LOOK_AHEAD && Math.abs(dx * fz - dz * fx) < CAR_SIDE_MARGIN) return true;
    }
    const pdx = playerPos.x - c.x, pdz = playerPos.z - c.z;
    const palong = pdx * fx + pdz * fz;
    return palong > 0 && palong < LOOK_AHEAD && Math.abs(pdx * fz - pdz * fx) < PLAYER_SIDE_MARGIN;
  }

  update(dt, playerPos, solids, onAlert) {
    for (const c of this.cars) {
      if (c.dead) {
        // Wreck: sink and roll slightly while it burns, then respawn.
        c.burnT -= dt;
        c.mesh.rotation.z += dt * 0.3;
        c.y = Math.max(-0.6, c.y - dt * 0.4);
        if (c.burnT <= 0) this.respawn(c);
        continue;
      }

      const fx = c.forwardX(), fz = c.forwardZ();
      const brake = Traffic.blockedAhead(c, fx, fz, this.cars, playerPos);
      if (brake) c.speed = Math.max(0, c.speed - BRAKE_DECEL * dt);
      else c.speed = Math.min(TRAFFIC.carSpeed, c.speed + CRUISE_ACCEL * dt);

      // Turnaround guard: past the map edge plus the swing-wide grace band, spin
      // the car around on the spot instead of letting it fight the boundary.
      const nx = c.x + fx * c.speed * dt;
      const nz = c.z + fz * c.speed * dt;
      const hit = resolveCircle(nx, nz, CAR.radius, solids);
      if (hit.blocked || Math.abs(hit.x) > HALF + OUT_OF_BOUNDS_GRACE || Math.abs(hit.z) > HALF + OUT_OF_BOUNDS_GRACE) {
        c.heading += Math.PI * 0.9;
        c.speed = 2;
        c.wheelSpin = 0; // don't carry highway spin into the turnaround
      } else {
        c.x = hit.x;
        c.z = hit.z;
      }

      // A stopped car near an on-foot player is flagged stealable.
      const pdx = playerPos.x - c.x, pdz = playerPos.z - c.z;
      const palong = pdx * fx + pdz * fz;
      if (onAlert && playerPos.onFoot && palong > 0 && palong < STEAL_RANGE
          && Math.abs(pdx * fz - pdz * fx) < STEAL_SIDE_MARGIN) onAlert(c);

      c.wheelSpin += c.speed * dt * SPIN_PER_METRE;
      c.sync();
    }
  }

  respawn(c) {
    const spot = lanePlacement(this.city, this.rng);
    c.health = CAR.health;
    c.dead = false;
    c.burnT = 0;
    c.y = 0;
    c.mesh.rotation.z = 0;
    c.x = spot.x;
    c.z = spot.z;
    c.heading = spot.heading;
    c.speed = TRAFFIC.carSpeed * 0.8;
    c.sync();
  }
}

// ---------------------------------------------------------------------------
// Police: pursue the player when wanted, shoot within range, despawn when calm.
// ---------------------------------------------------------------------------
const BEACON_FLASH_HZ = 6;         // alternation rate of the lightbar halves
const BEACON_SWEEP_HZ = 18;        // sine sweep that reads as a rotating bar
const BEACON_HOT = 2.2;
const BEACON_COLD = 0.3;
const PURCHASE_DIST = 12;          // inside this, cops close for the arrest
const PIT_DIST = 6;                // inside this, they back off to box the player in
const COP_SPAWN_MIN_DIST = 70;     // spawn ring around the player...
const COP_SPAWN_DIST_SPAN = 30;    // ...out to this radius

export class Police {
  constructor(scene) {
    this.scene = scene;
    this.units = [];
    this.spawnTimer = 0;
  }

  // Build a marked cruiser: white body, blue flank stripes, strobing lightbar.
  // The userData shim keeps the same mesh contract spawnCopAt in main.js builds.
  static buildCruiserMesh(scene) {
    const mesh = carMesh(2); // pearl white (PAINTS[2] in models.js)
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x1c3f8f, roughness: 0.4, metalness: 0.5 });
    for (const s of [-1, 1]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 3.6), stripeMat);
      stripe.position.set(s * 1.03, 0.72, 0);
      mesh.add(stripe);
    }
    const barBase = new THREE.Mesh(
      new THREE.BoxGeometry(1.15, 0.12, 0.34),
      new THREE.MeshStandardMaterial({ color: 0x191b20, roughness: 0.6 }),
    );
    barBase.position.set(0, 1.6, -0.35);
    mesh.add(barBase);
    const red = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.16, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xff3333, emissive: 0xff2222, emissiveIntensity: 2 }),
    );
    red.position.set(-0.3, 1.72, -0.35);
    const blue = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.16, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x3366ff, emissive: 0x2244ff, emissiveIntensity: 2 }),
    );
    blue.position.set(0.3, 1.72, -0.35);
    mesh.add(red, blue);
    mesh.userData.beacon = { material: { color: { setHex: () => {} } } };
    mesh.userData.beacons = [red, blue];
    scene.add(mesh);
    return mesh;
  }

  syncCount(wanted, dt, player, solids, rng, city) {
    const want = Math.min(POLICE.copsPerStar * wanted, 10);
    // Calm streets: clear every unit.
    if (wanted === 0) {
      for (const u of this.units) this.scene.remove(u.mesh);
      this.units.length = 0;
      return;
    }
    this.spawnTimer -= dt;
    if (this.units.length < want && this.spawnTimer <= 0) {
      this.spawnTimer = 1.2;
      const ang = rng() * Math.PI * 2;
      const dist = COP_SPAWN_MIN_DIST + rng() * COP_SPAWN_DIST_SPAN;
      const x = THREE.MathUtils.clamp(player.x + Math.sin(ang) * dist, -HALF, HALF);
      const z = THREE.MathUtils.clamp(player.z + Math.cos(ang) * dist, -HALF, HALF);
      const mesh = Police.buildCruiserMesh(this.scene);
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

  // Unit count for the HUD/siren wiring.
  count() { return this.units.length; }

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

      // Lightbar strobe: alternate halves, sweep intensity with a sine so it
      // reads as a rotating bar rather than an on/off blink.
      const beacons = u.mesh.userData.beacons;
      if (beacons) {
        const phase = Math.floor(state.time * BEACON_FLASH_HZ) % 2;
        const hot = BEACON_HOT + Math.sin(state.time * BEACON_SWEEP_HZ) * 0.5;
        beacons[0].material.emissiveIntensity = phase ? hot : BEACON_COLD;
        beacons[1].material.emissiveIntensity = phase ? BEACON_COLD : hot;
      }

      const dx = player.x - u.x, dz = player.z - u.z;
      const dist = Math.hypot(dx, dz);
      const desired = Math.atan2(dx, dz);
      let diff = desired - u.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const steer = THREE.MathUtils.clamp(diff * 1.6, -1, 1);

      if (dist > PURCHASE_DIST) {
        u.drive(Math.sin(diff) > -0.4 ? 0.8 : 0.3, steer, dt, solids);
      } else {
        // Close in for the arrest / shoot-out, backing off when nearly on top.
        u.drive(dist > PIT_DIST ? 0.5 : -0.4, steer, dt, solids);
      }

      // Fire when in range and roughly on sight (arcade: no wall raycast).
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
