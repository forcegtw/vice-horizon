// Procedural environment map. MeshStandardMaterial needs something to reflect or
// metal reads as flat black; we render a small gradient dome (sky, horizon, ground,
// one sun blob) into a PMREM once at boot and hand it to the scene. Cheap enough
// that it costs one offscreen render at startup and nothing per frame.

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
uniform vec3 uSun;
uniform vec3 uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);
  vec3 col = mix(uHorizon, uSky, pow(clamp(up, 0.0, 1.0), 0.55));
  col = mix(col, uGround, smoothstep(0.0, -0.25, up));
  float sun = pow(max(0.0, dot(d, normalize(uSunDir))), 220.0);
  float halo = pow(max(0.0, dot(d, normalize(uSunDir))), 8.0) * 0.35;
  col += uSun * (sun * 3.0 + halo);
  gl_FragColor = vec4(col, 1.0);
}`;

export function buildEnvironment(renderer, scene) {
  const envScene = new THREE.Scene();
  const uniforms = {
    uSky: { value: new THREE.Color(0x8fb4e8) },
    uHorizon: { value: new THREE.Color(0xd9e3f2) },
    uGround: { value: new THREE.Color(0x2a2c33) },
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

  return {
    // Re-tint the cached env when the sky changes enough to matter (cheap: uniforms only).
    setMood(dayAmt) {
      uniforms.uSky.value.setHex(0x8fb4e8).lerp(new THREE.Color(0x0a1020), 1 - dayAmt);
      uniforms.uHorizon.value.setHex(0xd9e3f2).lerp(new THREE.Color(0x1a2338), 1 - dayAmt);
      uniforms.uGround.value.setHex(0x2a2c33).lerp(new THREE.Color(0x05070c), 1 - dayAmt);
    },
  };
}
