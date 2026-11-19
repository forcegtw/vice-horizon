// Sky: a big inverted sphere with a vertex-gradient shader, a sun disc glow baked
// into the same shader (its direction must match env.js's dome highlight or
// reflections disagree), and a sprinkle of stars that fade in at night.
// Uniforms are driven by the day/night clock in main.js, so one draw call covers
// dusk to dark; shader uniforms are the only live state after the first build.
// Stars use a pure hash of the direction cell, so the field is fixed to the
// dome and twinkles without a time uniform — no per-frame CPU cost at all.

import * as THREE from '../vendor/three.min.js';

const VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
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
  // Sun / moon disc with soft halo.
  float d = distance(normalize(vDir), normalize(uSunDir));
  float disc = smoothstep(uSunSize, uSunSize * 0.55, d);
  float halo = pow(max(0.0, 1.0 - d * 2.2), 3.0) * 0.35;
  col += uSunColor * (disc + halo);
  // Stars: sparse bright points in the upper hemisphere.
  if (uStarAmt > 0.01 && vDir.y > 0.05) {
    vec3 cell = floor(normalize(vDir) * 220.0);
    float s = hash(cell);
    if (s > 0.9975) {
      // Twinkle from the cell hash itself: deterministic, no time uniform needed.
      float tw = 0.6 + 0.4 * sin(s * 90.0);
      col += vec3(0.9, 0.95, 1.0) * uStarAmt * tw * smoothstep(0.05, 0.3, vDir.y);
    }
  }
  gl_FragColor = vec4(col, 1.0);
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
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(800, 32, 20), mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  // frac: 0..1 through the day; sunDir: normalized direction to the sun; dayAmt 0..1.
  update(frac, sunDir, dayAmt) {
    this.mesh.position.set(sunDir.x * 40, 0, sunDir.z * 40); // recentre on play area cheaply
    const day = THREE.MathUtils.clamp(dayAmt, 0, 1);
    const dusk = 1 - Math.min(1, day * 1.8);                 // 1 near sunrise/sunset
    const night = 1 - day;

    // Day: blue dome, warm horizon. Dusk: orange band. Night: deep navy.
    // Polish pass 4: dusk horizon warmed further (sunset over water), night horizon
    // lifted slightly so the city silhouette still reads against the sky.
    const top = SKY_TOP[0].clone().lerp(SKY_TOP[1], Math.min(1, dusk * 1.4)).lerp(SKY_TOP[2], night * 0.9);
    const hor = SKY_HOR[0].clone().lerp(SKY_HOR[1], dusk).lerp(SKY_HOR[2], night);
    this.uniforms.uTop.value.copy(top);
    this.uniforms.uHorizon.value.copy(hor);
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.setHex(dusk > 0.4 ? 0xff9a5a : 0xffdca8);
    this.uniforms.uSunSize.value = 0.028 + dusk * 0.02;
    this.uniforms.uStarAmt.value = Math.pow(night, 1.3); // stars appear earlier in dusk
    // The dome recentres on the play area each frame so the 800 m shell never
    // clips against the fog at the map edge — pure position write, no alloc.
  }
}

// Module-level lerp targets for update(): [day, dusk, night] per band. Allocated
// once so the per-frame path allocates only the two clone() results.
// Dusk bands carry the strongest saturation change (orange horizon, purple top):
// those two are what make the 165 s cycle read as a real sunset in screenshots.
const SKY_TOP = [new THREE.Color(0x5b93d6), new THREE.Color(0x2c2350), new THREE.Color(0x0a1226)];
const SKY_HOR = [new THREE.Color(0xd8e6f5), new THREE.Color(0xf07a3e), new THREE.Color(0x24304c)];
