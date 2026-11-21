// sky.js — the visible sky: one big inverted sphere carrying a gradient shader,
// a sun/moon disc with halo baked into the same shader, and a sprinkle of stars
// that only appear after dusk. A single draw call covers dawn to dark; after the
// first build the only live state is the uniform set, which main.js's day/night
// clock drives through update().
// The sun direction here must agree with env.js's dome highlight — otherwise the
// sky shows one sun and the reflections show another.
// Stars are a pure hash of the direction cell, so the field is fixed to the dome
// and "twinkles" without a time uniform: zero per-frame CPU cost.

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
varying vec3 vDir;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(h, 0.7));
  // Sun / moon disc plus a soft halo around it.
  float d = distance(normalize(vDir), normalize(uSunDir));
  float disc = smoothstep(uSunSize, uSunSize * 0.55, d);
  float halo = pow(max(0.0, 1.0 - d * 2.2), 3.0) * 0.35;
  col += uSunColor * (disc + halo);
  // Stars: sparse bright points, upper hemisphere only, twinkle driven by the
  // cell hash itself (deterministic, no time uniform needed).
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

// Gradient band colours per sky phase: [day, dusk, night]. The dusk entries carry
// the strongest saturation swing (orange horizon, purple top) — those two bands
// are what make the 165 s cycle read as a real sunset in screenshots.
const TOP_BANDS = [0x5b93d6, 0x2c2350, 0x0a1226];
const HORIZON_BANDS = [0xd8e6f5, 0xf07a3e, 0x24304c];
const TOP_BANDS_C = TOP_BANDS.map((h) => new THREE.Color(h));
const HORIZON_BANDS_C = HORIZON_BANDS.map((h) => new THREE.Color(h));

// Scratch colours for the per-frame band lerps; updated in place, never reallocated.
const topMix = new THREE.Color();
const horizonMix = new THREE.Color();

// Sun appearance: warm cream by default, deeper orange once dusk dominates.
const SUN_NOON = 0xffdca8;
const SUN_DUSK = 0xff9a5a;
const SUN_BASE_SIZE = 0.028;
const SUN_DUSK_GROWTH = 0.02;
// Uniform values at construction: pre-dawn blue, before the first update() lands.
const BOOT_TOP = 0x3a6db8;
const BOOT_HORIZON = 0xc7d5ea;

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uTop: { value: new THREE.Color(BOOT_TOP) },
      uHorizon: { value: new THREE.Color(BOOT_HORIZON) },
      uSunColor: { value: new THREE.Color(SUN_NOON) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uSunSize: { value: 0.03 },
      uStarAmt: { value: 0.0 },
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

  // frac: 0..1 through the day cycle; sunDir: normalized sun direction; dayAmt: 0..1.
  update(frac, sunDir, dayAmt) {
    // Recentre the dome on the play area so the 800 m shell never clips against
    // the fog at the map edge — a cheap position write, no allocation.
    this.mesh.position.set(sunDir.x * 40, 0, sunDir.z * 40);

    const day = THREE.MathUtils.clamp(dayAmt, 0, 1);
    const dusk = 1 - Math.min(1, day * 1.8); // peaks near sunrise/sunset
    const night = 1 - day;

    // Day: blue dome over a warm horizon. Dusk: orange band, purple overhead.
    // Night: deep navy with the horizon lifted slightly so the city silhouette
    // still reads against the sky.
    topMix.copy(TOP_BANDS_C[0]).lerp(TOP_BANDS_C[1], Math.min(1, dusk * 1.4)).lerp(TOP_BANDS_C[2], night * 0.9);
    horizonMix.copy(HORIZON_BANDS_C[0]).lerp(HORIZON_BANDS_C[1], dusk).lerp(HORIZON_BANDS_C[2], night);
    this.uniforms.uTop.value.copy(topMix);
    this.uniforms.uHorizon.value.copy(horizonMix);
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.setHex(dusk > 0.4 ? SUN_DUSK : SUN_NOON);
    this.uniforms.uSunSize.value = SUN_BASE_SIZE + dusk * SUN_DUSK_GROWTH;
    // pow < 1 makes stars arrive earlier in the dusk ramp than pure night amount.
    this.uniforms.uStarAmt.value = Math.pow(night, 1.3);
  }
}
