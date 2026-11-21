// particles.js — one pooled THREE.Points cloud shared by explosions, sparks
// and dust puffs.
//
// Each burst claims a slice of a ring buffer and animates position, velocity
// and alpha per frame; dead slots are reclaimed by the next burst, so an
// arbitrarily long firefight never grows the pool. POOL_SIZE is the hard
// ceiling — bursts past it silently reuse the oldest slots, and additive
// blending plus per-particle colour fades hide that reuse.
//
// Dead slots park far below the map AND zero their colour. A position-only
// park used to leave a bright pixel floating in wet-road reflections when
// additive blending sampled a parked slot at grazing angles — zeroing the
// colour is the fix, so keep the pair together.
//
// Bursts draw from Math.random on purpose: spawn scatter is throwaway
// visual noise, and keeping it outside the seeded rng leaves ?shot=
// replays exact.

import * as THREE from '../vendor/three.min.js';

const POOL_SIZE = 600;            // hard ceiling — bursts past it recycle slots
const PARK_Y = -1000;             // dead-slot parking depth, far below the map
const PARK_TEST_Y = PARK_Y / 10;  // anything this deep counts as parked
const GRAVITY = 9.8;
const FLOOR_BOUNCE = 0.3;         // vertical restitution on the asphalt
const REST_HEIGHT = 0.1;          // particles settle just above the road
const DOT_SIZE = 1.4;             // shared sprite size (world units)
const DEFAULT_LIFE = 0.9;         // burst lifetime when a caller omits it
const DEFAULT_SIZE = 1.4;         // burst size when a caller omits it

export class Particles {
  constructor(scene) {
    this.pos = new Float32Array(POOL_SIZE * 3);
    this.col = new Float32Array(POOL_SIZE * 3);
    this.vel = new Float32Array(POOL_SIZE * 3);
    this.life = new Float32Array(POOL_SIZE);     // seconds remaining per slot
    this.maxLife = new Float32Array(POOL_SIZE);
    // Per-slot size is tracked for a future per-particle-size shader; the
    // shared PointsMaterial ignores it today.
    this.size = new Float32Array(POOL_SIZE);
    this.cursor = 0;                             // next slot a burst claims

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.mat = new THREE.PointsMaterial({
      size: DOT_SIZE,
      vertexColors: true,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  // Claim `count` slots at a point with a colour and radial velocity. Life
  // and size get a mild random spread so bursts look organic.
  burst(x, y, z, count, color, speed, life = DEFAULT_LIFE, size = DEFAULT_SIZE) {
    const base = new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % POOL_SIZE;
      const s = i * 3;
      const angle = Math.random() * Math.PI * 2;
      const spread = speed * (0.3 + Math.random() * 0.7);
      this.pos[s] = x;
      this.pos[s + 1] = y;
      this.pos[s + 2] = z;
      this.vel[s] = Math.cos(angle) * spread;
      this.vel[s + 1] = Math.random() * speed * 0.9 + 2;
      this.vel[s + 2] = Math.sin(angle) * spread;
      const shade = 0.7 + Math.random() * 0.5;
      this.col[s] = Math.min(1, base.r * shade + 0.25);
      this.col[s + 1] = base.g * shade;
      this.col[s + 2] = base.b * shade;
      const span = life * (0.6 + Math.random() * 0.6);
      this.life[i] = span;
      this.maxLife[i] = span;
      this.size[i] = size * (0.6 + Math.random());
    }
  }

  // Fireball core, hot sparks, then a slow smoke tail — three bursts, one pool.
  explosion(x, y, z) {
    this.burst(x, y, z, 60, 0xff8c3a, 14, 1.2, 2.2);
    this.burst(x, y + 1, z, 30, 0xffe08a, 8, 0.8, 1.6);
    this.burst(x, y + 0.5, z, 20, 0x555555, 5, 1.6, 2.8);
  }

  // Debris kicked up by a collision.
  sparks(x, y, z) {
    this.burst(x, y, z, 12, 0xffd76e, 6, 0.4, 0.9);
  }

  // Landing / hard-stop puff: neutral grey, short life, low speed.
  dust(x, y, z) {
    this.burst(x, y, z, 8, 0x8a8a8a, 3, 0.5, 1.2);
  }

  update(dt) {
    let dirty = false;
    for (let i = 0; i < POOL_SIZE; i++) {
      const s = i * 3;
      if (this.life[i] <= 0) {
        // Park once, then leave it alone (a dirty flag per frame would churn).
        if (this.pos[s + 1] > PARK_TEST_Y) {
          this.pos[s + 1] = PARK_Y;
          this.vel[s] = 0;
          this.vel[s + 1] = 0;
          this.vel[s + 2] = 0;
          this.col[s] = 0;
          this.col[s + 1] = 0;
          this.col[s + 2] = 0;
          dirty = true;
        }
        continue;
      }
      dirty = true;
      this.life[i] -= dt;
      this.vel[s + 1] -= GRAVITY * dt;
      this.pos[s] += this.vel[s] * dt;
      this.pos[s + 1] += this.vel[s + 1] * dt;
      this.pos[s + 2] += this.vel[s + 2] * dt;
      if (this.pos[s + 1] < REST_HEIGHT) {
        this.vel[s + 1] *= -FLOOR_BOUNCE;
        this.pos[s + 1] = REST_HEIGHT;
      }
    }
    if (dirty) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
  }
}
