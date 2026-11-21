// sky.js — the visible sky over Vice Horizon: one huge inverted sphere
// wearing a direction-based gradient shader.
//
// Day paints a blue dome with a pale horizon; dusk drags an orange band
// around the compass; night drops the whole vault to navy. The sun/moon
// disc is baked into the same shader — its direction has to agree with
// env.js's dome highlight, or reflections will visibly disagree with the
// sky. Stars are sprinkled by a pure hash of the direction cell, so the
// field is pinned to the dome and twinkles with no clock and no per-frame
// CPU.
//
// main.js drives the uniforms from the day/night cycle every frame; after
// the constructor, uniform writes are the only live state in this class.

import * as THREE from '../vendor/three.min.js';

const DOME_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DOME_FRAG = `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunSize;
uniform float uStarAmt;
uniform float uHorizonPow;
varying vec3 vDir;

// Stateless 3D hash: stable within a direction cell, decorrelated across
// neighbouring cells so the star field never forms a visible lattice.
float cellHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 dir = normalize(vDir);
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(h, uHorizonPow));

  // Sun / moon disc with a soft halo.
  float sep = distance(dir, normalize(uSunDir));
  float disc = smoothstep(uSunSize, uSunSize * 0.55, sep);
  float halo = pow(max(0.0, 1.0 - sep * 2.2), 3.0) * 0.35;
  col += uSunColor * (disc + halo);

  // Sparse bright points in the upper hemisphere; the twinkle comes out of
  // the cell hash itself, so it needs no time uniform.
  if (uStarAmt > 0.01 && dir.y > 0.05) {
    float s = cellHash(floor(dir * 220.0));
    if (s > 0.9975) {
      float twinkle = 0.6 + 0.4 * sin(s * 90.0);
      col += vec3(0.9, 0.95, 1.0) * uStarAmt * twinkle * smoothstep(0.05, 0.3, dir.y);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// Gradient lerp targets [day, dusk, night]. The dusk bands carry the
// strongest saturation (orange horizon, violet top) — that trio is what
// makes the 165 s cycle read as a real sunset in screenshots.
const HORIZON_POW = 0.7;
const VAULT_BANDS = [
  new THREE.Color(0x5b93d6),  // clear day
  new THREE.Color(0x2c2350),  // dusk
  new THREE.Color(0x0a1226),  // night
];
const HAZE_BANDS = [
  new THREE.Color(0xd8e6f5),  // pale day horizon
  new THREE.Color(0xf07a3e),  // sunset band
  new THREE.Color(0x24304c),  // night horizon
];

const SUN_NOON = 0xffdca8;
const SUN_LOW = 0xff9a5a;

// Disc radius near sunrise/sunset vs at noon; the swollen dusk disc is what
// makes a low sun feel low. Tune together with env.js's dome exponents.
const SUN_SIZE_NOON = 0.028;
const SUN_SIZE_DUSK_BONUS = 0.02;

// How quickly the dusk band saturates as daylight fades; higher values pull
// the orange horizon earlier onto the day clock.
const DUSK_GAIN = 1.8;

// Dome shell radius, and how far it drifts toward the sun azimuth so it
// never clips against the fog at the map edge.
const DOME_RADIUS = 800;
const DOME_PUSH = 40;

export class Sky {
  constructor(scene) {
    // Blend targets for update() — preallocated so the per-frame path
    // allocates nothing (the main loop is allocation-free on purpose).
    this.blendTop = new THREE.Color();
    this.blendHorizon = new THREE.Color();
    this.uniforms = {
      uTop: { value: new THREE.Color(VAULT_BANDS[0]) },
      uHorizon: { value: new THREE.Color(HAZE_BANDS[0]) },
      uSunColor: { value: new THREE.Color(SUN_NOON) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uSunSize: { value: SUN_SIZE_NOON },
      uStarAmt: { value: 0.0 },
      uHorizonPow: { value: HORIZON_POW },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 20), mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  // frac: 0..1 through the day (unused today but part of the drive
  // contract); sunDir: normalized sun direction; dayAmt: 0..1 brightness.
  // Pure uniform writes — nothing is allocated per frame.
  update(frac, sunDir, dayAmt) {
    // Recentre the shell toward the sun's azimuth so it never clips against
    // the fog at the map edge. Position-only write.
    this.mesh.position.set(sunDir.x * DOME_PUSH, 0, sunDir.z * DOME_PUSH);

    const day = THREE.MathUtils.clamp(dayAmt, 0, 1);
    const night = 1 - day;
    const dusk = 1 - Math.min(1, day * DUSK_GAIN); // peaks near sunrise/sunset

    this.uniforms.uTop.value.copy(
      this.blendTop.copy(VAULT_BANDS[0])
        .lerp(VAULT_BANDS[1], Math.min(1, dusk * 1.4))
        .lerp(VAULT_BANDS[2], night * 0.9),
    );
    this.uniforms.uHorizon.value.copy(
      this.blendHorizon.copy(HAZE_BANDS[0])
        .lerp(HAZE_BANDS[1], dusk)
        .lerp(HAZE_BANDS[2], night),
    );
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.setHex(dusk > 0.4 ? SUN_LOW : SUN_NOON);
    this.uniforms.uSunSize.value = SUN_SIZE_NOON + dusk * SUN_SIZE_DUSK_BONUS;
    this.uniforms.uStarAmt.value = Math.pow(night, 1.3); // stars creep in at dusk
  }
}
