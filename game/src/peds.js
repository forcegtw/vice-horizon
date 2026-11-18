// Pedestrians: capsule-adjacent low-poly walkers who stroll the sidewalks and flee
// gunfire. Doubles as the rig for rival NPCs in the eliminate mission.

import * as THREE from '../vendor/three.min.js';
import { TRAFFIC, PLAYER, WORLD } from './config.js';
import { pedMesh } from './models.js';
import { resolveCircle } from './vehicles.js';
import { HALF } from './city.js';

const SKIN = [0xe0b48c, 0xc98e5e, 0x8a5a3a, 0x6e4428];
const SHIRT = [0xd65f5f, 0x5f7fd6, 0x63b46a, 0xd6c45f, 0xb45fd6, 0x5fb8b4, 0xdddddd];

export class Peds {
  constructor(scene, city, rng) {
    this.city = city;
    this.peds = [];
    for (let i = 0; i < TRAFFIC.pedCount; i++) {
      const mesh = pedMesh(rng);
      scene.add(mesh);
      const p = this.spawn(rng, { mesh });
      this.peds.push(p);
    }
  }

  spawn(rng, p) {
    const lane = this.city.roadLines[Math.floor(rng() * this.city.roadLines.length)];
    const along = (rng() - 0.5) * 2 * HALF;
    const side = (rng() < 0.5 ? 1 : -1) * (WORLD.roadWidth / 2 + WORLD.sidewalk * 0.6);
    p.x = lane.axis === 'z' ? lane.line + side : along;
    p.z = lane.axis === 'z' ? along : lane.line + side;
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
      if (p.state === 'dead') {
        p.deadT -= dt;
        p.mesh.rotation.x = Math.PI / 2;
        p.mesh.position.y = 0.2;
        if (p.deadT <= 0) {
          p.mesh.rotation.x = 0;
          this.spawn(rng, p);
        }
        continue;
      }

      // Flee if gunfire alarmed nearby or the wanted player is right on top of them.
      if (alarmPos) {
        const d = Math.hypot(alarmPos.x - p.x, alarmPos.z - p.z);
        if (d < 26) p.state = 'flee';
      }
      if (p.state === 'flee') {
        const d = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
        if (d > 40) p.state = 'walk';
        p.heading = Math.atan2(p.x - playerPos.x, p.z - playerPos.z);
        p.speed = 5.2;
      } else {
        p.speed = TRAFFIC.pedSpeed;
        // Occasional wander turn.
        if (rng() < dt * 0.5) p.heading += (rng() - 0.5) * 1.6;
      }

      const nx = p.x + Math.sin(p.heading) * p.speed * dt;
      const nz = p.z + Math.cos(p.heading) * p.speed * dt;
      const hit = resolveCircle(nx, nz, PLAYER.radius, solids);
      if (hit.blocked) {
        p.heading += Math.PI / 2 + rng();
      } else if (Math.abs(hit.x) < HALF + 20 && Math.abs(hit.z) < HALF + 20) {
        p.x = hit.x; p.z = hit.z;
      } else {
        p.heading += Math.PI; // bounce back into the city
      }

      // Strut animation.
      p.phase += dt * p.speed * 3.2;
      const limbs = p.mesh.userData.limbs;
      const swing = Math.sin(p.phase) * 0.62;
      limbs[0].rotation.x = swing;
      limbs[1].rotation.x = -swing;
      limbs[2].rotation.x = -swing * 0.8;
      limbs[3].rotation.x = swing * 0.8;
      // Vertical bob + subtle forward lean while moving; settles when idle-flee.
      p.mesh.position.y = Math.abs(Math.sin(p.phase)) * 0.05;
      p.mesh.rotation.x = p.state === 'flee' ? 0.14 : 0.05;

      p.mesh.position.set(p.x, 0, p.z);
      p.mesh.rotation.y = p.heading;
    }
  }

  // Kill the nearest ped within range; returns the ped or null.
  killNear(x, z, range) {
    let best = null, bd = range * range;
    for (const p of this.peds) {
      if (p.state === 'dead') continue;
      const d2 = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d2 < bd) { bd = d2; best = p; }
    }
    if (best) {
      best.state = 'dead';
      best.deadT = 9;
    }
    return best;
  }
}
