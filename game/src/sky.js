// sky.js — the visible sky: one huge inverted sphere wearing a direction-based
// gradient shader. Day paints a blue dome with a pale horizon; dusk drags an
// orange band around the compass; night drops the whole thing to navy. The
// sun/moon disc is baked into the same shader — its direction has to agree
// with env.js's dome highlight, or reflections will visibly disagree with the
// sky. Stars are sprinkled by a pure hash of the direction cell, so the field
// is pinned to the dome and twinkles with no clock and no per-frame CPU.
//
// main.js drives the uniforms from the day/night cycle every frame; after the
// constructor, uniform writes are the only live state in this class.

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

// Stateless 3D hash: stable per direction cell, varies smoothly across cells.
float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(h, uHorizonPow));
  // Sun / moon disc with a soft halo.
  float d = distance(normalize(vDir), normalize(uSunDir));
  float disc = smoothstep(uSunSize, uSunSize * 0.55, d);
  float halo = pow(max(0.0, 1.0 - d * 2.2), 3.0) * 0.35;
  col += uSunColor * (disc + halo);
  // Sparse bright points in the upper hemisphere; the twinkle comes out of
  // the cell hash itself, so it needs no time uniform.
  if (uStarAmt > 0.01 && vDir.y > 0.05) {
    vec3 cell = floor(normalize(vDir) * 220.0);
    float s = hash(cell);
    if (s > 0.9975) {
      float tw = 0.6 + 0.4 * sin(s * 90.0);
      col += vec3(0.9, 0.95, 1.0) * uStarAmt * tw * smoothstep(0.05, 0.3, vDir.y);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// Per-band lerp targets [day, dusk, night]. The dusk bands carry the strongest
// saturation (orange horizon, purple top) — that trio is what makes the
// 165 s cycle read as a real sunset in screenshots.
const HORIZON_POW = 0.7;
const TOP_BANDS = [
  new THREE.Color(0x5b93d6),  // day
  new THREE.Color(0x2c2350),  // dusk
  new THREE.Color(0x0a1226),  // night
];
const HORIZON_BANDS = [
  new THREE.Color(0xd8e6f5),
  new THREE.Color(0xf07a3e),
  new THREE.Color(0x24304c),
];

const SUN_DAY = 0xffdca8;
const SUN_DUSK = 0xff9a5a;

// Disc radius near sunrise/sunset vs at noon; the bigger dusk disc is what
// makes low sun feel low. Tune together with env.js's dome exponents.
const SUN_SIZE_BASE = 0.028;
const SUN_SIZE_DUSK_BONUS = 0.02;

export class Sky {
  constructor(scene) {
    // Blend targets for update() — preallocated so the per-frame path
    // allocates nothing (the main loop is allocation-free on purpose).
    this.scratchTop = new THREE.Color();
    this.scratchHor = new THREE.Color();
    this.uniforms = {
      uTop: { value: new THREE.Color(TOP_BANDS[0]) },
      uHorizon: { value: new THREE.Color(HORIZON_BANDS[0]) },
      uSunColor: { value: new THREE.Color(SUN_DAY) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uSunSize: { value: SUN_SIZE_BASE },
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
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 20), mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  // frac: 0..1 through the day (unused today but part of the drive contract);
  // sunDir: normalized sun direction; dayAmt: 0..1 brightness. Pure uniform
  // writes — nothing is allocated per frame.
  update(frac, sunDir, dayAmt) {
    // Recentre the 800 m shell toward the sun's azimuth so it never clips
    // against the fog at the map edge. Position-only write.
    this.mesh.position.set(sunDir.x * 40, 0, sunDir.z * 40);
    const day = THREE.MathUtils.clamp(dayAmt, 0, 1);
    const night = 1 - day;
    const dusk = 1 - Math.min(1, day * 1.8); // peaks near sunrise/sunset

    const top = this.scratchTop.copy(TOP_BANDS[0])
      .lerp(TOP_BANDS[1], Math.min(1, dusk * 1.4))
      .lerp(TOP_BANDS[2], night * 0.9);
    const hor = this.scratchHor.copy(HORIZON_BANDS[0])
      .lerp(HORIZON_BANDS[1], dusk)
      .lerp(HORIZON_BANDS[2], night);
    this.uniforms.uTop.value.copy(top);
    this.uniforms.uHorizon.value.copy(hor);
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.setHex(dusk > 0.4 ? SUN_DUSK : SUN_DAY);
    this.uniforms.uSunSize.value = SUN_SIZE_BASE + dusk * SUN_SIZE_DUSK_BONUS;
    this.uniforms.uStarAmt.value = Math.pow(night, 1.3); // stars creep in at dusk
  }
}
