// sky.js — an inverted sphere carrying a vertex-gradient shader: day blue dome,
// orange dusk band, navy night, a sun/moon disc baked into the same shader (its
// direction must match env.js's dome highlight or reflections disagree), and a
// sprinkle of stars that fade in after dark. main.js drives the uniforms from
// the day/night clock; after the first build, shader uniforms are the only live
// state. Stars come from a pure hash of the direction cell, so the field is
// fixed to the dome and twinkles with no time uniform and no per-frame CPU.

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
  // Sparse bright points in the upper hemisphere; twinkle comes from the cell
  // hash itself so it needs no clock.
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

// Per-band lerp targets [day, dusk, night], allocated once. The dusk bands
// carry the strongest saturation shift (orange horizon, purple top) — that is
// what makes the 165 s cycle read as a real sunset in screenshots.
// Exponent shaping the horizon falloff in the fragment shader; tune with
// env.js's dome pow exponents so sky and reflections agree.
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

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uTop: { value: new THREE.Color(TOP_BANDS[0]) },
      uHorizon: { value: new THREE.Color(HORIZON_BANDS[0]) },
      uSunColor: { value: new THREE.Color(SUN_DAY) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uSunSize: { value: 0.03 },
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

  // frac: 0..1 through the day; sunDir: normalized direction to the sun;
  // dayAmt: 0..1 brightness. Pure uniform writes — no allocation per frame.
  update(frac, sunDir, dayAmt) {
    // Recentre the 800 m shell on the play area so it never clips against the
    // fog at the map edge. Position-only write.
    this.mesh.position.set(sunDir.x * 40, 0, sunDir.z * 40);
    const day = THREE.MathUtils.clamp(dayAmt, 0, 1);
    const night = 1 - day;
    const dusk = 1 - Math.min(1, day * 1.8); // 1 near sunrise/sunset

    const top = TOP_BANDS[0].clone()
      .lerp(TOP_BANDS[1], Math.min(1, dusk * 1.4))
      .lerp(TOP_BANDS[2], night * 0.9);
    const hor = HORIZON_BANDS[0].clone()
      .lerp(HORIZON_BANDS[1], dusk)
      .lerp(HORIZON_BANDS[2], night);
    this.uniforms.uTop.value.copy(top);
    this.uniforms.uHorizon.value.copy(hor);
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.setHex(dusk > 0.4 ? SUN_DUSK : SUN_DAY);
    this.uniforms.uSunSize.value = 0.028 + dusk * 0.02;
    this.uniforms.uStarAmt.value = Math.pow(night, 1.3); // stars creep in at dusk
  }
}
