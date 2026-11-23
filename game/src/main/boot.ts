// World construction. Everything that runs exactly once at boot, in the order
// the old main.js module body ran it: renderer/scene/camera, the seeded rng
// (never Math.random below this point), the city, the ambient systems, the
// day-cycle lights, the player rig, the actor systems, the shared game state
// and the save restore.
//
// The construction order is load-bearing twice over: the systems share one
// rng stream in a fixed sequence (city -> traffic -> peds -> peds2 ->
// missions -> weather -> sideJobs -> economy), and several constructors hang
// side effects off the scene. boot stops right before UI exists; ui-wiring.ts
// creates the overlay/hud/system UI and binds the economy ledger.
//
// Every exported function is a factory over a plain context object (w) — no
// module-level side effects, so import order can never reshuffle the stream.

import * as THREE from '../../vendor/three.min.js';
import { WORLD, PLAYER, HEADLIGHTS, MISSIONS, makeRng } from '../config.js';
import { buildCity } from '../city.js';
import { Input } from '../input.js';
import { Sfx } from '../sfx.js';
import { Vehicle, Traffic, Police } from '../vehicles.js';
import { carMesh, playerMesh } from '../models.js';
import { buildEnvironment } from '../env.js';
import { Peds } from '../peds.js';
import { Peds2 } from '../peds2.js';
import { Missions } from '../missions.js';
import { SideJobs } from '../missions2.js';
import { Minimap } from '../minimap.js';
import { Sky } from '../sky.js';
import { Particles } from '../particles.js';
import { loadSave } from '../save.js';
import { Weather } from '../weather.js';

// Sun/moon shadow-camera half-span in metres: wide enough to cover the
// playable grid, tight enough to keep depth precision. Retune sun and moon
// together — both cameras share it.
const SHADOW_SPAN = 160;

// Headlight rig: two SpotLights lighting the road ahead of the player's car.
// Re-attached whenever the player steals a different car. The loop fades the
// intensities; this only builds the rig once per car mesh.
export function attachHeadlights(car) {
  if (!car) return;
  if (!car.headlights) {
    const makeBeam = (x) => {
      const s = new THREE.SpotLight(0xfff2d0, 0, HEADLIGHTS.range, HEADLIGHTS.angle, 0.45, 1.4);
      s.position.set(x, 0.8, 2.2);
      s.target.position.set(x * 1.6, 0.1, 12);
      s.shadow.camera.far = HEADLIGHTS.range + 3;
      car.mesh.add(s, s.target);
      return s;
    };
    car.headlights = [makeBeam(-0.6), makeBeam(0.6)];
  }
}

// Build the whole world and return the shared context every other main/
// module reads and mutates. Fields added later by ui-wiring.ts: overlay, hud,
// wanted, radio, economy, minimap.
export function createWorld() {
  const canvas = document.getElementById('game');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.35;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);
  scene.fog = new THREE.FogExp2(0x0b0e14, 0.0038);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);

  // Shot staging and the world seed.
  const params = new URLSearchParams(location.search);
  const shotName = params.get('shot');
  const seed = Number(params.get('seed') ?? 1) || 1;
  const rng = makeRng(seed);

  // City geometry first, then the ambient systems that hang off it.
  const city = buildCity(scene, rng);
  const sky = new Sky(scene);
  const particles = new Particles(scene);
  const env = buildEnvironment(renderer, scene);
  const input = new Input(canvas);
  const sfx = new Sfx();

  // Lights: dim ambient fill plus a sun and moon that trade places through
  // the day cycle. Moonlight keeps streets from going flat black after dusk.
  const ambient = new THREE.AmbientLight(0x9fb3d9, 0.7);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0x9fb0ff, 0x241f2e, 0.45);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffdfb0, 1.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -SHADOW_SPAN; sun.shadow.camera.right = SHADOW_SPAN;
  sun.shadow.camera.top = SHADOW_SPAN; sun.shadow.camera.bottom = -SHADOW_SPAN;
  sun.shadow.camera.far = 500;
  scene.add(sun);
  scene.add(sun.target);

  const moon = new THREE.DirectionalLight(0x8fa8ff, 0.0);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024, 1024);
  moon.shadow.camera.left = -SHADOW_SPAN; moon.shadow.camera.right = SHADOW_SPAN;
  moon.shadow.camera.top = SHADOW_SPAN; moon.shadow.camera.bottom = -SHADOW_SPAN;
  moon.shadow.camera.far = 500;
  scene.add(moon);

  // Player: articulated rig with head/torso/arms/legs and a held weapon.
  const playerGroup = playerMesh();
  scene.add(playerGroup);
  const player = {
    x: 8, z: 30, heading: 0,
    health: PLAYER.maxHealth, armor: 0,
    alive: true, inCar: false,
    weaponIndex: 0,
    fireT: 0, phase: 0,
  };
  const playerCar = new Vehicle(null, 0, 0, 0, 'player');

  // Weapon fire visuals: tracer lines, pooled. fireTracer() in input-bindings
  // pushes; the loop's visual step drains expired lines.
  const tracerMat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });
  const tracers = [];

  // World actors. hookVehicleFx wires vehicle events into particles + sound.
  const traffic = new Traffic(scene, city, rng);
  const hookVehicleFx = (v) => {
    v.onCrash = (car) => {
      particles.sparks(car.x, 1, car.z);
      if (Math.abs(car.speed) > 8) sfx.crash();
    };
    v.onExplode = (car) => {
      particles.explosion(car.x, 1, car.z);
      sfx.crash();
    };
  };
  for (const c of traffic.cars) hookVehicleFx(c);
  const peds = new Peds(scene, city, rng);
  // Pedestrian life layer: walk anims, fear of wanted player, district density.
  const peds2 = new Peds2(peds, city, rng);
  const police = new Police(scene);
  const mission = new Missions(scene, rng, city, sfx);
  mission.setPlayerRef(player);
  const weather = new Weather(scene, city, rng);
  // Side-job board: races / deliveries / rampage, independent of the main chain.
  const sideJobs = new SideJobs(scene, rng, city, sfx);
  // Late-bound on purpose: state exists a few lines down, hud arrives with
  // ui-wiring — neither can fire a payout before both exist.
  sideJobs.onReward = (cash, name) => {
    w.state.money += cash;
    w.hud.toast(`Side job paid — ${name} $${cash}`, 4);
  };

  // Shared game state every system reads and mutates. Police vehicle meshes
  // are normally built inside Police.syncCount; staged shots use spawnCopAt
  // to build one manually. state.playerCar is a boot-time snapshot kept for
  // symmetry with the pre-refactor state object; live play reads w.playerCar
  // (stealCar swaps that, not the snapshot).
  const state = {
    money: 0, wanted: 0, time: WORLD.dayLength * 0.7,
    police, traffic,
    sfx, paused: false,
    wantedCooldown: 0,
    camera,
    player, playerCar,
    hideOverlay: () => w.overlay.hide(),
    spawnCopAt: (x, z) => {
      const mesh = carMesh(0x2a3f8f);
      const beacon = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.22, 0.6),
        new THREE.MeshBasicMaterial({ color: 0xff3333 })
      );
      beacon.position.set(0, 1.52, -0.3);
      mesh.add(beacon);
      mesh.userData.beacons = [beacon]; // same contract Police.update uses for its lightbar flash
      scene.add(mesh);
      const v = new Vehicle(mesh, x, z, Math.atan2(player.x - x, player.z - z), 'police');
      v.fireT = 0;
      police.units.push(v);
    },
    mission,
    stealCar: (c) => { w.playerCar = c; attachHeadlights(c); },
    particles,
  };

  // Give saved progress back.
  const saved = loadSave();
  if (saved) {
    state.money = saved.money ?? 0;
    mission.index = Math.min(saved.missionIndex ?? 0, MISSIONS.length);
  }

  const w = {
    canvas, renderer, scene, camera,
    shotName, seed, rng,
    city, sky, particles, env, input, sfx,
    ambient, hemi, sun, moon,
    playerGroup, player, playerCar,
    tracerMat, tracers,
    traffic, peds, peds2, police, mission, weather, sideJobs,
    state,
    // Loop cadence state; running flips via the START button or shot staging.
    frameThen: performance.now(),
    sinceAutosave: 0,
    running: false,
    triggerLatched: false,
    camYaw: 0,
  };
  return w;
}
