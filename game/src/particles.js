// particles.js — one pooled THREE.Points system shared by explosions, sparks
// and dust. Each burst claims a slice of a ring buffer and animates position,
// velocity and alpha per frame; dead slots are reclaimed, so a long firefight
// never grows the pool. Pool size 600 is the hard ceiling — bursts past it
// silently reuse the oldest slots. Additive blending plus per-particle colour
// fades hide that reuse. Dead slots park far below the map AND zero their
// colour: a position-only park used to leave a bright pixel floating in
// reflections when additive blending sampled a parked slot at grazing angles.

import * as THREE from '../vendor/three.min.js';

const POOL = 600;
const PARK_Y = -1000;
const GRAVITY = 9.8;
const FLOOR_BOUNCE = 0.3;

export class Particles {
  constructor(scene) {
    this.pos = new Float32Array(POOL * 3);
    this.col = new Float32Array(POOL * 3);
    this.vel = new Float32Array(POOL * 3);
    this.life = new Float32Array(POOL);     // seconds remaining
    this.maxLife = new Float32Array(POOL);
    this.size = new Float32Array(POOL);
    this.cursor = 0;                        // next slot a burst claims
    this.alive = 0;

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

  // Spawn `count` particles at a point with a colour and radial velocity.
  // life/size get mild random spread so bursts look organic.
  burst(x, y, z, count, color, speed, life = 0.9, size = 1.4) {
    const base = new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % POOL;
      const angle = Math.random() * Math.PI * 2;
      const rise = Math.random();
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      const spread = speed * (0.3 + Math.random() * 0.7);
      this.vel[i * 3] = Math.cos(angle) * spread;
      this.vel[i * 3 + 1] = rise * speed * 0.9 + 2;
      this.vel[i * 3 + 2] = Math.sin(angle) * spread;
      const shade = 0.7 + Math.random() * 0.5;
      this.col[i * 3] = Math.min(1, base.r * shade + 0.25);
      this.col[i * 3 + 1] = base.g * shade;
      this.col[i * 3 + 2] = base.b * shade;
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

  // Landing / hard-stop puff: neutral grey, short life, low speed.
  dust(x, y, z) {
    this.burst(x, y, z, 8, 0x8a8a8a, 3, 0.5, 1.2);
  }

  update(dt) {
    let dirty = false;
    for (let i = 0; i < POOL; i++) {
      if (this.life[i] <= 0) {
        // Park once, then leave it alone (dirty flag would otherwise churn).
        if (this.pos[i * 3 + 1] > PARK_Y / 10) {
          this.pos[i * 3 + 1] = PARK_Y;
          this.vel[i * 3] = 0;
          this.vel[i * 3 + 1] = 0;
          this.vel[i * 3 + 2] = 0;
          this.col[i * 3] = 0;
          this.col[i * 3 + 1] = 0;
          this.col[i * 3 + 2] = 0;
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
      if (this.pos[i * 3 + 1] < 0.1) {
        this.vel[i * 3 + 1] *= -FLOOR_BOUNCE;
        this.pos[i * 3 + 1] = 0.1;
      }
    }
    if (dirty) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
  }
}
