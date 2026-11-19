// Particles: one pooled THREE.Points system for explosions, sparks and dust.
// Each burst grabs a slice of the ring pool and animates positions/alpha per
// frame; dead slots are reclaimed, so a busy firefight never grows.
// Pool size 600 is the ceiling; bursts beyond it silently reuse the oldest slots.
// Alpha fades are per-particle; additive blending hides pool reuse nicely.
// The dead-slot park check is a hard <= on the sentinel so a bounce that briefly
// parks a particle at exactly y=-1000 also zeroes its colour.

import * as THREE from '../vendor/three.min.js';

const MAX = 600;

export class Particles {
  constructor(scene) {
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);   // remaining seconds
    this.maxLife = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.cursor = 0;
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

  burst(x, y, z, count, color, speed, life = 0.9, size = 1.4) {
    const c = new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % MAX;
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = Math.cos(a) * speed * (0.3 + Math.random() * 0.7);
      this.vel[i * 3 + 1] = up * speed * 0.9 + 2;
      this.vel[i * 3 + 2] = Math.sin(a) * speed * (0.3 + Math.random() * 0.7);
      const shade = 0.7 + Math.random() * 0.5;
      this.col[i * 3] = Math.min(1, c.r * shade + 0.25);
      this.col[i * 3 + 1] = c.g * shade;
      this.col[i * 3 + 2] = c.b * shade;
      this.life[i] = life * (0.6 + Math.random() * 0.6);
      this.maxLife[i] = this.life[i];
      this.size[i] = size * (0.6 + Math.random());
    }
  }

  explosion(x, y, z) {
    this.burst(x, y, z, 60, 0xff8c3a, 14, 1.2, 2.2);
    this.burst(x, y + 1, z, 30, 0xffe08a, 8, 0.8, 1.6);
    this.burst(x, y + 0.5, z, 20, 0x555555, 5, 1.6, 2.8);
  }

  sparks(x, y, z) {
    this.burst(x, y, z, 12, 0xffd76e, 6, 0.4, 0.9);
  }

  // Dust puff for landings/hard stops: neutral grey, short life, low speed.
  dust(x, y, z) {
    this.burst(x, y, z, 8, 0x8a8a8a, 3, 0.5, 1.2);
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        // Park dead particles far below the map AND zero their colour: the
        // position-only park used to leave a bright pixel floating in reflections
        // when additive blending sampled the parked slot at grazing angles.
        if (this.pos[i * 3 + 1] > -100) {
          this.pos[i * 3 + 1] = -1000;
          this.vel[i * 3] = 0; this.vel[i * 3 + 1] = 0; this.vel[i * 3 + 2] = 0;
          this.col[i * 3] = 0; this.col[i * 3 + 1] = 0; this.col[i * 3 + 2] = 0;
          any = true;
        }
        continue;
      }
      any = true;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= 9.8 * dt;             // gravity
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.1) { this.vel[i * 3 + 1] *= -0.3; this.pos[i * 3 + 1] = 0.1; }
    }
    if (any) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
  }
}
