// One pooled THREE.Points cloud serves every effect — explosion fireballs, crash
// sparks, dust puffs. A burst claims a slice of the ring buffer, slots animate
// position/colour per frame, and dead slots are recycled immediately, so a busy
// firefight never grows the pool. Additive blending hides slot reuse nicely.
// Dead slots are parked at y = PARK_Y with their colour zeroed; the park test is
// a hard <= on the sentinel so a bounce that lands exactly on PARK_Y still gets
// scrubbed — a position-only park once left a bright pixel floating in reflections
// at grazing angles.

import * as THREE from '../vendor/three.min.js';

const POOL = 600;         // ceiling; bursts beyond it silently reuse the oldest slots
const PARK_Y = -1000;     // where dead particles hide, far below the map
const GRAVITY = 9.8;
const FLOOR_Y = 0.1;      // bounce height above the road surface
const BOUNCE_KEEP = -0.3; // vertical velocity kept after a floor bounce
const EMBER_FLOOR = 0.25; // red-channel floor so dark smoke still reads as embers

export class Particles {
  constructor(scene) {
    this.pos = new Float32Array(POOL * 3);
    this.col = new Float32Array(POOL * 3);
    this.vel = new Float32Array(POOL * 3);
    this.life = new Float32Array(POOL);    // seconds remaining per slot
    this.maxLife = new Float32Array(POOL);
    this.size = new Float32Array(POOL);
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

  // Drop `count` particles at a point. Ring-buffer cursor decides which slots are
  // reused, so over-firing simply overwrites the oldest burst.
  burst(x, y, z, count, color, speed, life = 0.9, size = 1.4) {
    const tint = new THREE.Color(color);
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % POOL;
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      this.pos[i * 3] = x;
      this.pos[i * 3 + 1] = y;
      this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = Math.cos(a) * speed * (0.3 + Math.random() * 0.7);
      this.vel[i * 3 + 1] = up * speed * 0.9 + 2;
      this.vel[i * 3 + 2] = Math.sin(a) * speed * (0.3 + Math.random() * 0.7);
      // Per-particle brightness wobble; the red channel floors at EMBER_FLOOR so
      // even dark smoke keeps a visible ember under additive blending.
      const shade = 0.7 + Math.random() * 0.5;
      this.col[i * 3] = Math.min(1, tint.r * shade + EMBER_FLOOR);
      this.col[i * 3 + 1] = tint.g * shade;
      this.col[i * 3 + 2] = tint.b * shade;
      this.life[i] = life * (0.6 + Math.random() * 0.6);
      this.maxLife[i] = this.life[i];
      this.size[i] = size * (0.6 + Math.random());
    }
  }

  explosion(x, y, z) {
    // Fireball core, hot sparks, then a slow smoke tail — three bursts, one pool.
    this.burst(x, y, z, 60, 0xff8c3a, 14, 1.2, 2.2);
    this.burst(x, y + 1, z, 30, 0xffe08a, 8, 0.8, 1.6);
    this.burst(x, y + 0.5, z, 20, 0x555555, 5, 1.6, 2.8);
  }

  sparks(x, y, z) {
    this.burst(x, y, z, 12, 0xffd76e, 6, 0.4, 0.9);
  }

  // Dust puff for landings / hard stops: neutral grey, short life, low speed.
  dust(x, y, z) {
    this.burst(x, y, z, 8, 0x8a8a8a, 3, 0.5, 1.2);
  }

  // Hide a dead slot below the world and scrub its velocity and colour so the
  // additive blender can never sample it again. Only the y coordinate moves —
  // x/z are left as the particle died (they're irrelevant once y is under the map).
  park(i) {
    this.pos[i * 3 + 1] = PARK_Y;
    this.vel[i * 3] = 0;
    this.vel[i * 3 + 1] = 0;
    this.vel[i * 3 + 2] = 0;
    this.col[i * 3] = 0;
    this.col[i * 3 + 1] = 0;
    this.col[i * 3 + 2] = 0;
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < POOL; i++) {
      if (this.life[i] <= 0) {
        if (this.pos[i * 3 + 1] > PARK_Y / 10) {
          this.park(i);
          any = true;
        }
        continue;
      }
      any = true;
      this.life[i] -= dt;
      this.vel[i * 3 + 1] -= GRAVITY * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < FLOOR_Y) {
        this.vel[i * 3 + 1] *= BOUNCE_KEEP;
        this.pos[i * 3 + 1] = FLOOR_Y;
      }
    }
    if (any) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
  }
}
