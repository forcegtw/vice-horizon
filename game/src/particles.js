// particles.js — one pooled THREE.Points system for explosions, sparks and dust.
// Bursts claim slots from a fixed ring buffer and animate positions/colours per
// frame; dead slots are reclaimed, so a long firefight never grows the pool.
// MAX is the hard ceiling — a burst larger than the pool simply overwrites the
// oldest slots. Additive blending hides that reuse nicely.
// Dead particles are parked far below the map AND have their colour zeroed: the
// old position-only park left a bright pixel floating in reflections when the
// additive blend sampled the parked slot at grazing angles.

import * as THREE from '../vendor/three.min.js';

const MAX_PARTICLE_COUNT = 600;
const GRAVITY = 9.8;
const GROUND_Y = 0.1;
const PARK_Y = -1000;
const BOUNCE_DAMPING = 0.3; // fraction of velocity kept after a ground bounce

export class Particles {
  constructor(scene) {
    this.pos = new Float32Array(MAX_PARTICLE_COUNT * 3);
    this.col = new Float32Array(MAX_PARTICLE_COUNT * 3);
    this.vel = new Float32Array(MAX_PARTICLE_COUNT * 3);
    this.life = new Float32Array(MAX_PARTICLE_COUNT);    // seconds remaining
    this.maxLife = new Float32Array(MAX_PARTICLE_COUNT);
    this.size = new Float32Array(MAX_PARTICLE_COUNT);
    this.cursor = 0;

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.mat = new THREE.PointsMaterial({
      size: 1.4,
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

  // Spawn `count` particles from one point. Colour variance and the +0.25 red
  // bias keep fireballs hot at the core; life and size vary per particle so a
  // burst dissolves instead of vanishing as a block.
  burst(x, y, z, count, color, speed, life = 0.9, size = 1.4) {
    const c = new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLE_COUNT;
      const angle = Math.random() * Math.PI * 2;
      const up = Math.random();
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = Math.cos(angle) * speed * (0.3 + Math.random() * 0.7);
      this.vel[i * 3 + 1] = up * speed * 0.9 + 2;
      this.vel[i * 3 + 2] = Math.sin(angle) * speed * (0.3 + Math.random() * 0.7);
      const shade = 0.7 + Math.random() * 0.5;
      this.col[i * 3] = Math.min(1, c.r * shade + 0.25);
      this.col[i * 3 + 1] = c.g * shade;
      this.col[i * 3 + 2] = c.b * shade;
      this.life[i] = life * (0.6 + Math.random() * 0.6);
      this.maxLife[i] = this.life[i];
      this.size[i] = size * (0.6 + Math.random());
    }
  }

  // Fireball core, hot sparks, then a slow smoke tail — three bursts, one pool.
  explosion(x, y, z) {
    this.burst(x, y, z, 60, 0xff8c3a, 14, 1.2, 2.2);
    this.burst(x, y + 1, z, 30, 0xffe08a, 8, 0.8, 1.6);
    this.burst(x, y + 0.5, z, 20, 0x555555, 5, 1.6, 2.8);
  }

  sparks(x, y, z) {
    this.burst(x, y, z, 12, 0xffd76e, 6, 0.4, 0.9);
  }

  // Dust puff for landings and hard stops: neutral grey, short life, low speed.
  dust(x, y, z) {
    this.burst(x, y, z, 8, 0x8a8a8a, 3, 0.5, 1.2);
  }

  update(dt) {
    let dirty = false;
    for (let i = 0; i < MAX_PARTICLE_COUNT; i++) {
      if (this.life[i] <= 0) {
        // Park once: the y-check keeps already-parked slots from re-zeroing every
        // frame. Zero the colour too, or additive blending leaves a lone pixel.
        if (this.pos[i * 3 + 1] > PARK_Y / 10) {
          this.pos[i * 3 + 1] = PARK_Y;
          this.vel[i * 3] = 0; this.vel[i * 3 + 1] = 0; this.vel[i * 3 + 2] = 0;
          this.col[i * 3] = 0; this.col[i * 3 + 1] = 0; this.col[i * 3 + 2] = 0;
          dirty = true;
        }
        continue;
      }
      dirty = true;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= GRAVITY * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < GROUND_Y) {
        this.vel[i * 3 + 1] *= -BOUNCE_DAMPING;
        this.pos[i * 3 + 1] = GROUND_Y;
      }
    }
    if (dirty) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
  }
}
