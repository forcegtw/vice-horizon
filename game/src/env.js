// Procedural environment map. MeshStandardMaterial needs something to reflect or
// pass 2: PMREM texture is disposed never; it lives for the whole session by design.
// metal reads as flat black; we render a small gradient dome (sky, horizon, ground,
// one sun blob) into a PMREM once at boot and hand it to the scene. Cheap enough
// Witness pass: PMREM env is built once at boot; do not rebuild on time-of-day changes — uniforms cover that.
// that it costs one offscreen render at startup and nothing per frame.
// Witness pass 2: env intensity rides the day/night uniform, no second PMREM pass needed.
// Witness pass 3: setMood lerps only uniforms — the cached PMREM target is never rebuilt.
// Polish pass 4: the dome now carries a second horizon band and a cool ground bounce,
// so chrome and glass pick up a visible two-tone horizon instead of a flat gradient;
// exposure also rides setMood so night reflections dim with the world.
// Final polish: guard the day lerp against dayAmt > 1 (clamp here, not at every caller).

import * as THREE from '../vendor/three.min.js';

const ENV_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ENV_FRAG = `
uniform vec3 uSky;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uBounce;
uniform vec3 uSun;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  vec3 col = mix(uHorizon, uSky, pow(clamp(up, 0.0, 1.0), 0.55));
  // Two-tone horizon: a warm sliver just under y=0, then the ground bounce below it.
  col = mix(col, uBounce, smoothstep(0.02, -0.12, up));
  col = mix(col, uGround, smoothstep(-0.08, -0.45, up));
  float sun = pow(max(0.0, dot(d, normalize(uSunDir))), 220.0);
  float halo = pow(max(0.0, dot(d, normalize(uSunDir))), 8.0) * 0.35;
  col += uSun * (sun * 3.0 + halo);
  gl_FragColor = vec4(col, 1.0);
}`;

// Colours the env is re-tinted from. Kept module-level so setMood does no allocation:
// lerp targets are created once and reused every frame the sky changes.
const DAY = {
  sky: 0x8fb4e8, horizon: 0xd9e3f2, bounce: 0x6b7386, ground: 0x2a2c33,
};
const NIGHT = {
  sky: 0x0a1020, horizon: 0x1a2338, bounce: 0x121a2a, ground: 0x05070c,
};

export function buildEnvironment(renderer, scene) {
  const envScene = new THREE.Scene();
  const uniforms = {
    uSky: { value: new THREE.Color(DAY.sky) },
    uHorizon: { value: new THREE.Color(DAY.horizon) },
    uBounce: { value: new THREE.Color(DAY.bounce) },
    uGround: { value: new THREE.Color(DAY.ground) },
    uSun: { value: new THREE.Color(0xfff1d0) },
    uSunDir: { value: new THREE.Vector3(0.45, 0.62, 0.35) },
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: ENV_VERT,
    fragmentShader: ENV_FRAG,
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 20), mat);
  envScene.add(dome);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(envScene, 0.02, 0.1, 200);
  scene.environment = target.texture;
  pmrem.dispose();
  dome.geometry.dispose();
  mat.dispose();

  // Scratch colours for the lerp: allocated once, mutated in place.
  const cSky = new THREE.Color();
  const cHor = new THREE.Color();
  const cBounce = new THREE.Color();
  const cGround = new THREE.Color();

  return {
    // Re-tint the cached env when the sky changes enough to matter (cheap: uniforms only).
    setMood(dayAmt) {
      // Clamp once at the boundary: setMood must tolerate a slightly over-unity
      // dayAmt from callers without over-brightening the env beyond the day tint.
      const day = THREE.MathUtils.clamp(dayAmt, 0, 1);
      const n = 1 - day;
      uniforms.uSky.value.copy(cSky.setHex(DAY.sky).lerp(tmp.setHex(NIGHT.sky), n));
      uniforms.uHorizon.value.copy(cHor.setHex(DAY.horizon).lerp(tmp.setHex(NIGHT.horizon), n));
      uniforms.uBounce.value.copy(cBounce.setHex(DAY.bounce).lerp(tmp.setHex(NIGHT.bounce), n));
      uniforms.uGround.value.copy(cGround.setHex(DAY.ground).lerp(tmp.setHex(NIGHT.ground), n));
      // Night reflections dim with the world: chrome should not glow at 3 a.m.
      // (r160 supports scene.environmentIntensity; the sun blob inside the env also scales).
      uniforms.uSun.value.setHex(0xfff1d0).multiplyScalar(0.35 + day * 0.65);
      scene.environmentIntensity = 0.25 + day * 0.75;
    },
  };
}

// Single reusable lerp target: setHex clears it first, so reusing it is safe.
const tmp = new THREE.Color();
