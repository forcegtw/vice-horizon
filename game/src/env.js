// env.js — the reflection environment. MeshStandardMaterial reads scene.environment
// for its reflections; without one, metal and glass render flat black. We build a
// tiny gradient dome (sky band, horizon band, ground bounce, one sun lobe), bake it
// through PMREM once at boot, and hand the texture to the scene. Cost: one offscreen
// render at startup, nothing per frame.
// Mood changes (dayAmt from the day/night clock) only rewrite shader uniforms on the
// cached PMREM target — the target itself is never rebuilt, so setMood is allocation
// free and cheap enough to call every frame.
// The sun lobe is two exponents working together: a tight power for the disc and a
// wide one for the halo. Retune them alongside sky.js's uSunSize so the visible sky
// and the reflections agree about where the sun is.

import * as THREE from '../vendor/three.min.js';

const DOME_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DOME_FRAG = `
uniform vec3 uSky;
uniform vec3 uHorizon;
uniform vec3 uBounce;
uniform vec3 uGround;
uniform vec3 uSun;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  vec3 col = mix(uHorizon, uSky, pow(clamp(up, 0.0, 1.0), 0.55));
  // Two-tone horizon: a warm sliver just below eye level, then the cool ground
  // bounce under it — chrome and glass pick up both bands in their reflections.
  col = mix(col, uBounce, smoothstep(0.02, -0.12, up));
  col = mix(col, uGround, smoothstep(-0.08, -0.45, up));
  float disc = pow(max(0.0, dot(d, normalize(uSunDir))), 220.0);
  float halo = pow(max(0.0, dot(d, normalize(uSunDir))), 8.0) * 0.35;
  col += uSun * (disc + halo);
  gl_FragColor = vec4(col, 1.0);
}`;

// Tint palettes as [sky, horizon, bounce, ground] hex quads; DAY and NIGHT are the
// two ends of the setMood lerp. Module scope so the lerp targets never allocate.
const DAY_TINT = [0x8fb4e8, 0xd9e3f2, 0x6b7386, 0x2a2c33];
const NIGHT_TINT = [0x0a1020, 0x1a2338, 0x121a2a, 0x05070c];

const SUN_TINT = 0xfff1d0;
const SUN_DIR = new THREE.Vector3(0.45, 0.62, 0.35).normalize();
// Dome is small and low-poly on purpose: PMREM blurs it into six texels per face,
// so extra geometry would be wasted render cost at boot.
const DOME_RADIUS = 40;

// Reflection floors: night keeps a quarter intensity so chrome never reads as
// flat black against the lit street; day reaches full strength.
const REFLECTION_FLOOR = 0.25;
const REFLECTION_RANGE = 0.75;   // added on top of the floor at full day

// Night dims the sun lobe inside the env so reflective surfaces don't glow at 3 a.m.
const NIGHT_SUN_FLOOR = 0.35;
const NIGHT_SUN_RANGE = 0.65;

// Scratch colours for the per-frame lerp — created once, mutated in place. Two
// sets because lerp() mutates its receiver: one holds the day end, one the night end.
const dayScratch = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];
const nightScratch = [new THREE.Color(), new THREE.Color(), new THREE.Color(), new THREE.Color()];

// Uniform keys ordered to match the DAY_TINT/NIGHT_TINT quads above.
const UNIFORM_KEYS = ['uSky', 'uHorizon', 'uBounce', 'uGround'];

export function buildEnvironment(renderer, scene) {
  const uniforms = {
    uSky: { value: new THREE.Color(DAY_TINT[0]) },
    uHorizon: { value: new THREE.Color(DAY_TINT[1]) },
    uBounce: { value: new THREE.Color(DAY_TINT[2]) },
    uGround: { value: new THREE.Color(DAY_TINT[3]) },
    uSun: { value: new THREE.Color(SUN_TINT) },
    uSunDir: { value: SUN_DIR.clone() },
  };
  const domeMat = new THREE.ShaderMaterial({
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 20), domeMat));

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(envScene, 0.02, 0.1, 200);
  scene.environment = target.texture;
  pmrem.dispose();

  domeMat.dispose();
  envScene.children[0].geometry.dispose();

  return {
    // Re-tint the cached env when the day/night clock moves. dayAmt may arrive a
    // touch over 1 from callers; clamp here so the env never over-brightens.
    setMood(dayAmt) {
      const day = THREE.MathUtils.clamp(dayAmt, 0, 1);
      const night = 1 - day;
      for (let i = 0; i < 4; i++) {
        uniforms[UNIFORM_KEYS[i]].value.copy(
          dayScratch[i].setHex(DAY_TINT[i]).lerp(nightScratch[i].setHex(NIGHT_TINT[i]), night)
        );
      }
      uniforms.uSun.value.setHex(SUN_TINT).multiplyScalar(NIGHT_SUN_FLOOR + day * NIGHT_SUN_RANGE);
      scene.environmentIntensity = REFLECTION_FLOOR + day * REFLECTION_RANGE;
    },
  };
}
