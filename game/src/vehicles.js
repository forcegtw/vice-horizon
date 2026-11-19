// vehicles.js — the Vehicle entity, arcade driving physics, traffic AI and
// police pursuit. No physics engine: everything is kinematic integration against
// the city's AABB colliders via resolveCircle (shared with peds and the camera,
// so cars, people and the boom all agree on geometry). Tuning lives in config;
// friction constants here are deliberate — real tire models would kill the feel.

import * as THREE from '../vendor/three.min.js';
import { CAR, TRAFFIC, POLICE } from './config.js';
import { carMesh } from './models.js';
import { HALF } from './city.js';

// Traffic paints biased bright so cars pop against asphalt; obsidian skipped.
const CAR_COLORS = [0xb0182c, 0x1a3a6b, 0xe8e8ea, 0x101318, 0x8f9299, 0xc9a227, 0x2c6e49, 0xd4581f];
const CAR_BRIGHT = CAR_COLORS.filter((c) => c !== 0x101318);

const WANDER_GRACE = 30;    // metres beyond HALF a car may swing wide before recall
const PROBE = 9;            // lookahead distance for traffic braking
const POLICE_CAP = 10;      // hard ceiling on simultaneous cruisers

// ---------------------------------------------------------------------------
// Vehicle entity shared by the player, traffic and police.
// ---------------------------------------------------------------------------
export class Vehicle {
  constructor(mesh, x, z, heading, kind) {
    this.mesh = mesh;
    this.kind = kind;            // 'player' | 'traffic' | 'police'
    this.x = x;
    this.z = z;
    this.y = 0;
    this.heading = heading;      // radians; 0 faces +Z
    this.speed = 0;
    this.steer = 0;
    this.health = CAR.health;
    this.wheelSpin = 0;
    this.dead = false;
    this.burnT = 0;
    this.targetLane = null;
    this.onCrash = null;
    this.onExplode = null;
    // Paint index derives from the spawn transform, never Math.random — the
    // ?shot= replay and smoke harnesses need identical cars for a given seed.
    this.colorIndex = (Math.abs(Math.round(x * 7 + z * 13)) + Math.round(heading * 5)) % CAR_COLORS.length;
  }

  forwardX() { return Math.sin(this.heading); }
  forwardZ() { return Math.cos(this.heading); }

  // One integration step with throttle in [-1, 1], steering in [-1, 1].
  // maxScale lets the engine-tune upgrade raise the forward cap without
  // touching the tuned config constants.
  drive(throttle, steerInput, dt, solids, maxScale = 1) {
    if (throttle !== 0) {
      const accel = throttle > 0 ? CAR.accel : CAR.brake;
      const cap = throttle > 0 ? CAR.maxSpeed * maxScale : CAR.reverseSpeed;
      this.speed = THREE.MathUtils.clamp(this.speed + throttle * accel * dt, -cap, cap);
    } else {
      // Engine drag + rolling friction; snap to zero below a crawl so the
      // speedometer and idle engine settle instead of whispering forever.
      this.speed *= Math.pow(0.4, dt);
      if (Math.abs(this.speed) < 0.15) this.speed = 0;
    }

    // Steering authority grows with speed: parked cars barely turn.
    const authority = THREE.MathUtils.clamp(Math.abs(this.speed) / 10, 0.15, 1);
    this.steer = THREE.MathUtils.damp(this.steer, steerInput, 8, dt);
    this.heading += this.steer * CAR.turnRate * authority * dt * Math.sign(this.speed || 1);

    const nx = this.x + this.forwardX() * this.speed * dt;
    const nz = this.z + this.forwardZ() * this.speed * dt;
    const hit = resolveCircle(nx, nz, CAR.radius, solids);
    if (hit.blocked) {
      // Crunch: most of the speed dies, a slight rebound off the obstacle.
      this.takeDamage(Math.abs(this.speed) * 1.2 + 2);
      this.speed *= -0.25;
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

// Push a circle out of every AABB it overlaps. Two passes: the first resolves
// the deepest overlaps, the second cleans up corners where pushing out of one
// box shoved the circle into its neighbour.
export function resolveCircle(x, z, r, solids) {
  let blocked = false;
  const r2 = r * r;
  for (let pass = 0; pass < 2; pass++) {
    for (const s of solids) {
      const cx = Math.min(Math.max(x, s.minX), s.maxX);
      const cz = Math.min(Math.max(z, s.minZ), s.maxZ);
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < r2 && d2 > 1e-9) {
        blocked = true;
        const d = Math.sqrt(d2);
        const push = (r - d) / d;
        x += dx * push;
        z += dz * push;
      } else if (d2 <= 1e-9) {
        // Degenerate: centre inside the box — shove along +x.
        blocked = true;
        x += r;
      }
    }
  }
  return { x, z, blocked };
}

// Place a car on a lane: lane offset 3.4 puts it in the correct side of the
// road for its travel direction.
function lanePlacement(lane, along, dir) {
  if (lane.axis === 'z') {
    return { x: lane.line + dir * 3.4, z: along, heading: dir > 0 ? 0 : Math.PI };
  }
  return { x: along, z: lane.line + dir * 3.4, heading: dir > 0 ? Math.PI / 2 : -Math.PI / 2 };
}

function pickLane(roadLines, rng) {
  const lane = roadLines[Math.floor(rng() * roadLines.length)];
  const along = (rng() - 0.5) * 2 * HALF;
  const dir = rng() < 0.5 ? 1 : -1;
  return { lane, along, dir };
}

// ---------------------------------------------------------------------------
// Traffic: cars loop along street lanes, braking for anything ahead.
// ---------------------------------------------------------------------------
export class Traffic {
  constructor(scene, city, rng) {
    this.city = city;
    // World-gen RNG retained so respawns stay deterministic per seed — same
    // reason Vehicle.colorIndex is transform-derived.
    this.rng = rng;
    this.cars = [];
    for (let i = 0; i < TRAFFIC.carCount; i++) {
      const { lane, along, dir } = pickLane(city.roadLines, rng);
      const place = lanePlacement(lane, along, dir);
      const mesh = carMesh(CAR_BRIGHT[Math.floor(rng() * CAR_BRIGHT.length)]);
      scene.add(mesh);
      const v = new Vehicle(mesh, place.x, place.z, place.heading, 'traffic');
      v.speed = TRAFFIC.carSpeed * (0.7 + rng() * 0.4);
      this.cars.push(v);
    }
  }

  update(dt, playerPos, solids, onAlert) {
    for (const c of this.cars) {
      if (c.dead) {
        // Burn-out sink then respawn: tilt, sink below the street, recover.
        c.burnT -= dt;
        c.mesh.rotation.z += dt * 0.3;
        c.y = Math.max(-0.6, c.y - dt * 0.4);
        if (c.burnT <= 0) this.respawn(c);
        continue;
      }

      const fx = c.forwardX();
      const fz = c.forwardZ();
      let brake = false;

      // Anything ahead in the same corridor forces a brake. Probe on the dot
      // product (ahead) and cross product (sideways clearance).
      for (const o of this.cars) {
        if (o === c || o.dead) continue;
        const dx = o.x - c.x;
        const dz = o.z - c.z;
        const ahead = dx * fx + dz * fz;
        const side = Math.abs(dx * fz - dz * fx);
        if (ahead > 0 && ahead < PROBE && side < 2.4) brake = true;
      }
      const pdx = playerPos.x - c.x;
      const pdz = playerPos.z - c.z;
      const pAhead = pdx * fx + pdz * fz;
      const pSide = Math.abs(pdx * fz - pdz * fx);
      if (pAhead > 0 && pAhead < PROBE && pSide < 2.6) brake = true;

      if (brake) c.speed = Math.max(0, c.speed - 18 * dt);
      else c.speed = Math.min(TRAFFIC.carSpeed, c.speed + 6 * dt);

      // Integrate, then recall any car that hit a wall or wandered past the
      // map edge grace band: it turns around on the spot with fresh wheels.
      const nx = c.x + fx * c.speed * dt;
      const nz = c.z + fz * c.speed * dt;
      const hit = resolveCircle(nx, nz, CAR.radius, solids);
      if (hit.blocked || Math.abs(hit.x) > HALF + WANDER_GRACE || Math.abs(hit.z) > HALF + WANDER_GRACE) {
        c.heading += Math.PI * 0.9;
        c.speed = 2;
        c.wheelSpin = 0;
      } else {
        c.x = hit.x;
        c.z = hit.z;
      }

      // Slow traffic right next to an on-foot player is stealable.
      if (onAlert && pAhead > 0 && pAhead < 4 && pSide < 2.2 && playerPos.onFoot) onAlert(c);

      c.wheelSpin += c.speed * dt * 2.4;
      c.sync();
    }
  }

  respawn(c) {
    const { lane, along, dir } = pickLane(this.city.roadLines, this.rng);
    const place = lanePlacement(lane, along, dir);
    c.x = place.x;
    c.z = place.z;
    c.heading = place.heading;
    c.health = CAR.health;
    c.dead = false;
    c.burnT = 0;
    c.y = 0;
    c.mesh.rotation.z = 0;
    c.speed = TRAFFIC.carSpeed * 0.8;
    c.sync();
  }
}

// ---------------------------------------------------------------------------
// Police: cruisers pursue while wanted, shoot in range, despawn when calm.
// ---------------------------------------------------------------------------
function buildCruiserMesh() {
  const mesh = carMesh(2); // pearl white base paint
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
  const mkBeacon = (x, color, emissive) => {
    const b = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.16, 0.3),
      new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: 2 }),
    );
    b.position.set(x, 1.72, -0.35);
    mesh.add(b);
    return b;
  };
  const red = mkBeacon(-0.3, 0xff3333, 0xff2222);
  const blue = mkBeacon(0.3, 0x3366ff, 0x2244ff);
  mesh.userData.beacons = [red, blue];
  return mesh;
}

export class Police {
  constructor(scene) {
    this.scene = scene;
    this.units = [];
    this.spawnTimer = 0;
  }

  syncCount(wanted, dt, player, solids, rng, city) {
    const want = Math.min(POLICE.copsPerStar * wanted, POLICE_CAP);
    if (wanted === 0) {
      // Calm streets: everyone goes home.
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
      const mesh = buildCruiserMesh();
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

  count() { return this.units.length; }

  update(dt, player, state, solids, rng, damagePlayer, onBust) {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u.dead) {
        u.burnT -= dt;
        u.y = Math.max(-0.6, u.y - dt * 0.4);
        if (u.burnT <= 0) {
          this.scene.remove(u.mesh);
          this.units.splice(i, 1);
        } else {
          u.sync();
        }
        continue;
      }

      // Lightbar strobe: halves alternate, intensity sweeps on a sine so it
      // reads as a rotating bar rather than an on/off lamp.
      const beacons = u.mesh.userData.beacons;
      if (beacons) {
        const phase = Math.floor(state.time * 6) % 2;
        const hot = 2.2 + Math.sin(state.time * 18) * 0.5;
        beacons[0].material.emissiveIntensity = phase ? hot : 0.3;
        beacons[1].material.emissiveIntensity = phase ? 0.3 : hot;
      }

      const dx = player.x - u.x;
      const dz = player.z - u.z;
      const dist = Math.hypot(dx, dz);
      const desired = Math.atan2(dx, dz);
      let diff = desired - u.heading;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const steer = THREE.MathUtils.clamp(diff * 1.6, -1, 1);

      if (dist > 12) {
        u.drive(Math.sin(diff) > -0.4 ? 0.8 : 0.3, steer, dt, solids);
      } else {
        // Close in for the arrest: creep nearer or back off when touching.
        u.drive(dist > 6 ? 0.5 : -0.4, steer, dt, solids);
      }

      // Arcade line-of-sight: in range and alive is enough to fire.
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
