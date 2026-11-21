// env.js — the reflection environment. MeshStandardMaterial with metalness has
// nothing to bounce unless scene.environment holds a map, and chrome would read
// flat black. We build a tiny gradient dome (sky, two-tone horizon, ground
// bounce, sun blob), render it once through PMREMGenerator at boot, and hand
// the texture to the scene. Cost: one offscreen render at startup, zero after.
// setMood only lerps shader uniforms — the cached PMREM target is never
// rebuilt, so the per-frame price of day/night reflection changes is nil.
// The 220 / 8 exponents shape the sun blob (tight disc + wide halo); tune them
// together with sky.js's uSunSize so reflections and sky agree.

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
uniform vec3 uGround;
uniform vec3 uBounce;
uniform vec3 uSun;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  vec3 col = mix(uHorizon, uSky, pow(clamp(up, 0.0, 1.0), 0.55));
  // Warm sliver just under y=0, then the cool ground bounce below it.
  col = mix(col, uBounce, smoothstep(0.02, -0.12, up));
  col = mix(col, uGround, smoothstep(-0.08, -0.45, up));
  float disc = pow(max(0.0, dot(d, normalize(uSunDir))), 220.0);
  float halo = pow(max(0.0, dot(d, normalize(uSunDir))), 8.0) * 0.35;
  col += uSun * (disc * 3.0 + halo);
  gl_FragColor = vec4(col, 1.0);
}`;

// Lerp endpoints for the day/night re-tint. Hex triples in sky/horizon/bounce/
// ground order of effect.
const DAY_TINT = {
  sky: 0x8fb4e8, horizon: 0xd9e3f2, bounce: 0x6b7386, ground: 0x2a2c33,
};
const NIGHT_TINT = {
  sky: 0x0a1020, horizon: 0x1a2338, bounce: 0x121a2a, ground: 0x05070c,
};

// Reflection strength across the day cycle (day -> night). Night keeps a
// quarter intensity so chrome stays lit against the street instead of blacking out.
const REFLECT_DAY = 0.25;
const REFLECT_NIGHT = 0.75;

// Scratch colours reused across setMood calls — the per-frame path allocates
// nothing. setHex clears the colour first, so sharing one scratch is safe.
const scratch = new THREE.Color();

// Lerp one uniform between its day and night hex at the given blend factor.
function tint(uniform, dayHex, nightHex, blend) {
  uniform.value.copy(scratch.setHex(dayHex).lerp(scratch.setHex(nightHex), blend));
}

// Clamp helpers: setMood accepts a slightly over-unity dayAmt from callers.
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function buildEnvironment(renderer, scene) {
  const domeScene = new THREE.Scene();
  const uniforms = {
    uSky: { value: new THREE.Color(DAY_TINT.sky) },
    uHorizon: { value: new THREE.Color(DAY_TINT.horizon) },
    uBounce: { value: new THREE.Color(DAY_TINT.bounce) },
    uGround: { value: new THREE.Color(DAY_TINT.ground) },
    uSun: { value: new THREE.Color(0xfff1d0) },
    uSunDir: { value: new THREE.Vector3(0.45, 0.62, 0.35) },
  };
  const domeMat = new THREE.ShaderMaterial({
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    uniforms,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 20), domeMat);
  domeScene.add(dome);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromScene(domeScene, 0.02, 0.1, 200);
  scene.environment = target.texture;
  pmrem.dispose();
  dome.geometry.dispose();
  domeMat.dispose();

  return {
    // Re-tint the cached env when the day/night clock moves. Clamp at the
    // boundary: callers may hand in a slightly over-unity dayAmt.
    setMood(dayAmt) {
      const day = clamp01(dayAmt);
      const night = 1 - day;
      tint(uniforms.uSky, DAY_TINT.sky, NIGHT_TINT.sky, night);
      tint(uniforms.uHorizon, DAY_TINT.horizon, NIGHT_TINT.horizon, night);
      tint(uniforms.uBounce, DAY_TINT.bounce, NIGHT_TINT.bounce, night);
      tint(uniforms.uGround, DAY_TINT.ground, NIGHT_TINT.ground, night);
      // The sun blob inside the env dims at night so chrome never glows at 3 a.m.
      uniforms.uSun.value.setHex(0xfff1d0).multiplyScalar(0.35 + day * 0.65);
      // r160 supports scene.environmentIntensity directly.
      scene.environmentIntensity = REFLECT_DAY + day * (REFLECT_NIGHT - REFLECT_DAY);
    },
  };
}
