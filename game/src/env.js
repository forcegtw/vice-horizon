// Environment reflections. MeshStandardMaterial has nothing to reflect unless the
// scene carries an environment map — metal and glass would render flat black — so
// at boot we rasterize a tiny gradient dome (sky, horizon band, warm sun blob,
// cool ground bounce) into a PMREM and hand the baked texture to the scene.
// Cost profile: one offscreen render at startup, nothing per frame. setMood only
// rewrites shader uniforms plus scene.environmentIntensity; the cached PMREM
// target is never rebuilt, so dusk just dims the same reflections.
// The dome paints a second horizon band and a cool ground bounce, so chrome and
// glass pick up a visible two-tone horizon instead of one flat gradient.
// The 220.0 / 8.0 fragment exponents shape the sun blob: the tight lobe is the
// disc, the wide one the halo — retune them together with sky.js's uSunSize.

import * as THREE from '../vendor/three.min.js';

const DOME_VERT = `
varying vec3 vRay;
void main() {
  vRay = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const DOME_FRAG = `
uniform vec3 uSky;
uniform vec3 uHorizon;
uniform vec3 uBounce;
uniform vec3 uGround;
uniform vec3 uSun;
uniform vec3 uSunDir;
varying vec3 vRay;
void main() {
  vec3 dir = normalize(vRay);
  float height = clamp(dir.y, -1.0, 1.0);
  vec3 rgb = mix(uHorizon, uSky, pow(clamp(height, 0.0, 1.0), 0.55));
  // Two-tone horizon: a warm sliver just under y=0, then the ground bounce below.
  rgb = mix(rgb, uBounce, smoothstep(0.02, -0.12, height));
  rgb = mix(rgb, uGround, smoothstep(-0.08, -0.45, height));
  float disc = pow(max(0.0, dot(dir, normalize(uSunDir))), 220.0);
  float glow = pow(max(0.0, dot(dir, normalize(uSunDir))), 8.0) * 0.35;
  rgb += uSun * (disc * 3.0 + glow);
  gl_FragColor = vec4(rgb, 1.0);
}`;

// Palettes the dome is re-tinted from each mood change. Hex triples are
// [sky, horizon, bounce, ground]; DAY and NIGHT are the lerp endpoints.
const DAY_TINT = {
  sky: 0x8fb4e8, horizon: 0xd9e3f2, bounce: 0x6b7386, ground: 0x2a2c33,
};
const NIGHT_TINT = {
  sky: 0x0a1020, horizon: 0x1a2338, bounce: 0x121a2a, ground: 0x05070c,
};

// Reflection-strength envelope: night keeps a quarter intensity so chrome never
// reads as dead black against the lit street, day tops out at the full map.
const REFLECT_FLOOR = 0.25;
const REFLECT_NIGHT_DIM = 0.35;   // multiplier the baked sun blob keeps at midnight
const REFLECT_DAY_GAIN = 0.65;    // plus this share of full strength per dayAmt
const REFLECT_DAY_SPAN = 0.75;    // added to the floor across the day ramp
const SUN_TINT = 0xfff1d0;        // one warm white for the baked blob, day and night

// Shared lerp target: setHex overwrites it completely, so reusing one Color for
// every channel lerp is allocation-free and safe.
const lerpTarget = new THREE.Color();

export function buildEnvironment(renderer, scene) {
  const uniforms = {
    uSky: { value: new THREE.Color(DAY_TINT.sky) },
    uHorizon: { value: new THREE.Color(DAY_TINT.horizon) },
    uBounce: { value: new THREE.Color(DAY_TINT.bounce) },
    uGround: { value: new THREE.Color(DAY_TINT.ground) },
    uSun: { value: new THREE.Color(SUN_TINT) },
    uSunDir: { value: new THREE.Vector3(0.45, 0.62, 0.35) },
  };
  const domeMat = new THREE.ShaderMaterial({
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const domeScene = new THREE.Scene();
  const dome = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 20), domeMat);
  domeScene.add(dome);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const baked = pmrem.fromScene(domeScene, 0.02, 0.1, 200);
  scene.environment = baked.texture;
  pmrem.dispose();
  dome.geometry.dispose();
  domeMat.dispose();

  // Scratch colours mutated in place — the per-frame lerp path never allocates.
  const outSky = new THREE.Color();
  const outHorizon = new THREE.Color();
  const outBounce = new THREE.Color();
  const outGround = new THREE.Color();

  return {
    // Re-tint the cached env as the clock moves. Callers may hand in a slightly
    // over-unity dayAmt; clamping here keeps the env from over-brightening.
    setMood(dayAmt) {
      const day = THREE.MathUtils.clamp(dayAmt, 0, 1);
      const night = 1 - day;
      uniforms.uSky.value.copy(outSky.setHex(DAY_TINT.sky).lerp(lerpTarget.setHex(NIGHT_TINT.sky), night));
      uniforms.uHorizon.value.copy(outHorizon.setHex(DAY_TINT.horizon).lerp(lerpTarget.setHex(NIGHT_TINT.horizon), night));
      uniforms.uBounce.value.copy(outBounce.setHex(DAY_TINT.bounce).lerp(lerpTarget.setHex(NIGHT_TINT.bounce), night));
      uniforms.uGround.value.copy(outGround.setHex(DAY_TINT.ground).lerp(lerpTarget.setHex(NIGHT_TINT.ground), night));
      // The baked sun blob dims with the world — chrome should not glow at 3 a.m.
      uniforms.uSun.value.setHex(SUN_TINT).multiplyScalar(REFLECT_NIGHT_DIM + day * REFLECT_DAY_GAIN);
      scene.environmentIntensity = REFLECT_FLOOR + day * REFLECT_DAY_SPAN;
    },
  };
}
