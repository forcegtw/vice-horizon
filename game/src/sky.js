// Sky dome: a single inverted sphere carrying a vertex-gradient shader — blue
// day bands, an orange dusk horizon, deep navy night — plus a sun/moon disc with
// halo and a star field that fades in after dusk. main.js drives the uniforms
// from the day clock; once built, the dome is pure GPU state and costs exactly
// one draw call per frame.
// Star positions come from hashing the view-direction cell, so the field is
// painted onto the dome itself: twinkling needs no time uniform and no per-frame
// CPU work at all.
// uSunDir must agree with env.js's dome highlight, or reflections and the visible
// disc will point at different suns.

import * as THREE from '../vendor/three.min.js';

const DOME_RADIUS = 800;   // shell size; must dwarf the fog range at the map rim

const DOME_VERT = `
varying vec3 vRay;
void main() {
  vRay = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DOME_FRAG = `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uSunSize;
uniform float uStarAmt;
varying vec3 vRay;

float hash(vec3 cell) {
  cell = fract(cell * 0.3183099 + vec3(0.71, 0.113, 0.419));
  cell *= 17.0;
  return fract(cell.x * cell.y * cell.z * (cell.x + cell.y + cell.z));
}

void main() {
  float shade = clamp(vRay.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 rgb = mix(uHorizon, uTop, pow(shade, 0.7));
  // Sun / moon disc with a soft halo around it.
  float angDist = distance(normalize(vRay), normalize(uSunDir));
  float disc = smoothstep(uSunSize, uSunSize * 0.55, angDist);
  float halo = pow(max(0.0, 1.0 - angDist * 2.2), 3.0) * 0.35;
  rgb += uSunColor * (disc + halo);
  // Stars: sparse bright points, upper hemisphere only.
  if (uStarAmt > 0.01 && vRay.y > 0.05) {
    vec3 starCell = floor(normalize(vRay) * 220.0);
    float roll = hash(starCell);
    if (roll > 0.9975) {
      // Twinkle derived from the cell hash itself: deterministic, time-free.
      float twinkle = 0.6 + 0.4 * sin(roll * 90.0);
      rgb += vec3(0.9, 0.95, 1.0) * uStarAmt * twinkle * smoothstep(0.05, 0.3, vRay.y);
    }
  }
  gl_FragColor = vec4(rgb, 1.0);
}`;

export class Sky {
  constructor(scene) {
    this.uniforms = {
      uTop: { value: new THREE.Color(0x3a6db8) },
      uHorizon: { value: new THREE.Color(0xc7d5ea) },
      uSunColor: { value: new THREE.Color(0xffdca8) },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uSunSize: { value: 0.03 },
      uStarAmt: { value: 0.0 },
    };
    const domeMat = new THREE.ShaderMaterial({
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 20), domeMat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  // frac: 0..1 position through the day (kept in the signature for callers that
  // pass the whole clock readout; the dome currently derives everything from the
  // sun vector and dayAmt). sunDir: normalized sun direction. dayAmt: 0..1.
  update(frac, sunDir, dayAmt) {
    // Recentre the shell on the sun's ground track so the 800 m dome never clips
    // into the fog at the map edge — a pure position write, no allocation.
    this.mesh.position.set(sunDir.x * 40, 0, sunDir.z * 40);
    const day = THREE.MathUtils.clamp(dayAmt, 0, 1);
    const dusk = 1 - Math.min(1, day * 1.8);   // peaks near sunrise / sunset
    const night = 1 - day;

    // Day: blue dome, warm horizon. Dusk: orange band, purple creeping into the
    // top. Night: deep navy, horizon lifted a touch so the city silhouette still
    // reads against the sky.
    this.uniforms.uTop.value.copy(SKY_TOP[0]).lerp(SKY_TOP[1], Math.min(1, dusk * 1.4)).lerp(SKY_TOP[2], night * 0.9);
    this.uniforms.uHorizon.value.copy(SKY_HOR[0]).lerp(SKY_HOR[1], dusk).lerp(SKY_HOR[2], night);
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.setHex(dusk > 0.4 ? 0xff9a5a : 0xffdca8);
    this.uniforms.uSunSize.value = 0.028 + dusk * 0.02;
    this.uniforms.uStarAmt.value = Math.pow(night, 1.3); // stars arrive mid-dusk
  }
}

// Lerp endpoints for update(): [day, dusk, night] per band. The dusk bands carry
// the strongest saturation swing (orange horizon, purple top) — that pair is what
// makes the 165 s cycle read as a real sunset in screenshots.
const SKY_TOP = [new THREE.Color(0x5b93d6), new THREE.Color(0x2c2350), new THREE.Color(0x0a1226)];
const SKY_HOR = [new THREE.Color(0xd8e6f5), new THREE.Color(0xf07a3e), new THREE.Color(0x24304c)];
