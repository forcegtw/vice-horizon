// Sky: a big inverted sphere with a vertex-gradient shader, a sun disc glow baked
// into the same shader, and a sprinkle of stars that fade in at night.
// Uniforms are driven by the day/night clock in env/main, so one draw call covers dusk to dark.

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
    const dayTop = new THREE.Color(0x5b93d6);
    const duskTop = new THREE.Color(0x2c2350);
    const nightTop = new THREE.Color(0x0a1226);
    const dayHor = new THREE.Color(0xd8e6f5);
    const duskHor = new THREE.Color(0xe8794a);
    const nightHor = new THREE.Color(0x1e2a44);

    const top = dayTop.clone().lerp(duskTop, Math.min(1, dusk * 1.4)).lerp(nightTop, night * 0.9);
    const hor = dayHor.clone().lerp(duskHor, dusk).lerp(nightHor, night);
    this.uniforms.uTop.value.copy(top);
    this.uniforms.uHorizon.value.copy(hor);
    this.uniforms.uSunDir.value.copy(sunDir);
    this.uniforms.uSunColor.value.setHex(dusk > 0.4 ? 0xff9a5a : 0xffdca8);
    this.uniforms.uSunSize.value = 0.028 + dusk * 0.02;
    this.uniforms.uStarAmt.value = Math.pow(night, 1.5);
  }
}
