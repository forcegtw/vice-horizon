// Vice Horizon — main loop. Boots the renderer, grows the city, and drives the
// player / traffic / police / mission systems each frame. Deterministic
// screenshot mode: ?shot=NAME&seed=N stages a tableau through shots.js.
// dt is clamped at the top of tick (never trust a raw delta on the first
// frame after focus returns). Budget target is 16.6 ms; the loop stays
// allocation-free — per-frame garbage is what spikes frame time, so scratch
// objects live at module scope and phases mutate them in place.

import * as THREE from '../vendor/three.min.js';
import { WORLD, PLAYER, CAR, CAMERA, HEADLIGHTS, AUTOSAVE_SECONDS, WEAPONS, MISSIONS, makeRng } from './config.js';
import { buildCity } from './city.js';
import { Input } from './input.js';
import { Sfx } from './sfx.js';
import { Vehicle, Traffic, Police, resolveCircle } from './vehicles.js';
import { carMesh, playerMesh } from './models.js';
import { buildEnvironment } from './env.js';
import { Peds } from './peds.js';
import { Peds2 } from './peds2.js';
import { Missions } from './missions.js';
import { SideJobs } from './missions2.js';
import { Minimap } from './minimap.js';
import { Hud } from './hud.js';
import { Sky } from './sky.js';
import { Particles } from './particles.js';
import { loadSave, writeSave } from './save.js';
import { Weather } from './weather.js';
import { Wanted } from './wanted.js';
import { Radio } from './radio.js';
import { Economy } from './economy.js';
import { SHOTS } from './shots.js';

// ---------------------------------------------------------------------------
// Viewport: renderer + scene + camera. Built first so every later system can
// take the scene as its anchor.
// ---------------------------------------------------------------------------
function createRenderer(canvas) {
  const gl = new THREE.WebGLRenderer({ canvas, antialias: true });
  gl.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  gl.shadowMap.enabled = true;
  gl.shadowMap.type = THREE.PCFSoftShadowMap;
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = 1.35;
  return gl;
}

function createScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);
  scene.fog = new THREE.FogExp2(0x0b0e14, 0.0038);
  return scene;
}

const canvas = document.getElementById('game');
const renderer = createRenderer(canvas);
const scene = createScene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);

// Deterministic replay inputs. Math.random is avoided on world paths; every
// spawn draws from rng (or a seeded variant) so ?shot= replays are identical
// between runs.
const params = new URLSearchParams(location.search);
const shotName = params.get('shot');
const seed = Number(params.get('seed') ?? 1) || 1;
const rng = makeRng(seed);

// ---------------------------------------------------------------------------
// World and its oldest dependencies. Construction order is load-bearing: each
// system here draws from rng while the city it lands in is already final.
// ---------------------------------------------------------------------------
const city = buildCity(scene, rng);
const sky = new Sky(scene);
const particles = new Particles(scene);
const env = buildEnvironment(renderer, scene);
const input = new Input(canvas);
const sfx = new Sfx();

// Day/night rig: dim ambient, a sun that orbits through the cycle, and a
// moonlight tint that takes over after dusk.
function stageDayNightLights(scene) {
  const ambient = new THREE.AmbientLight(0x9fb3d9, 0.7);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0x9fb0ff, 0x241f2e, 0.45);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffdfb0, 1.7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -160;
  sun.shadow.camera.right = 160;
  sun.shadow.camera.top = 160;
  sun.shadow.camera.bottom = -160;
  sun.shadow.camera.far = 500;
  scene.add(sun);
  scene.add(sun.target);
  const moon = new THREE.DirectionalLight(0x8fa8ff, 0.0);
  moon.castShadow = true;
  moon.shadow.mapSize.set(1024, 1024);
  moon.shadow.camera.left = -160;
  moon.shadow.camera.right = 160;
  moon.shadow.camera.top = 160;
  moon.shadow.camera.bottom = -160;
  moon.shadow.camera.far = 500;
  scene.add(moon);
  return { ambient, hemi, sun, moon };
}

const { ambient, hemi, sun, moon } = stageDayNightLights(scene);

// Headlight rig: two SpotLights lighting the road ahead, re-attached whenever
// the player steals a different car.
function attachHeadlights(car) {
  if (!car) return;
  if (!car.headlights) {
    const beamAt = (x) => {
      const beam = new THREE.SpotLight(0xfff2d0, 0, HEADLIGHTS.range, HEADLIGHTS.angle, 0.45, 1.4);
      beam.position.set(x, 0.8, 2.2);
      beam.target.position.set(x * 1.6, 0.1, 12);
      beam.shadow.camera.far = HEADLIGHTS.range + 3;
      car.mesh.add(beam, beam.target);
      return beam;
    };
    car.headlights = [beamAt(-0.6), beamAt(0.6)];
  }
}

// ---------------------------------------------------------------------------
// Player: the articulated rig with a held weapon, plus the vehicle placeholder
// the player drives once a car is stolen.
// ---------------------------------------------------------------------------
const playerGroup = playerMesh();
scene.add(playerGroup);

function createPlayerState() {
  return {
    x: 8, z: 30, heading: 0,
    health: PLAYER.maxHealth, armor: 0,
    alive: true, inCar: false,
    weaponIndex: 0,
    fireT: 0, phase: 0,
  };
}

const player = createPlayerState();
let playerCar = new Vehicle(null, 0, 0, 0, 'player');

// Weapon fire visuals: pooled tracer lines that live a few frames.
const tracerMat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });
const tracerPool = [];
function spawnTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, tracerMat);
  scene.add(line);
  tracerPool.push({ line, t: 0.09 });
}

// ---------------------------------------------------------------------------
// World actors, in the order they draw from rng.
// ---------------------------------------------------------------------------
const traffic = new Traffic(scene, city, rng);
// Vehicle events feed the particle pool and the soundboard.
function wireVehicleEvents(v) {
  v.onCrash = (car) => {
    particles.sparks(car.x, 1, car.z);
    if (Math.abs(car.speed) > 8) sfx.crash();
  };
  v.onExplode = (car) => {
    particles.explosion(car.x, 1, car.z);
    sfx.crash();
  };
}
for (const c of traffic.cars) wireVehicleEvents(c);

const peds = new Peds(scene, city, rng);
// Pedestrian life layer: walk tiers, fear of a wanted player, crowd density.
const peds2 = new Peds2(peds, city, rng);
const police = new Police(scene);
const mission = new Missions(scene, rng, city, sfx);
mission.setPlayerRef(player);
const weather = new Weather(scene, city, rng);
// Side-job board: races / deliveries / rampage, independent of the story chain.
const sideJobs = new SideJobs(scene, rng, city, sfx);

// A staged cruiser for shots (and future scripts): the beacon mesh follows the
// same userData.beacons contract Police.update reads.
function dropCruiserAt(x, z) {
  const mesh = carMesh(0x2a3f8f);
  const beacon = new THREE.Mesh(
    new THREE.BoxGeometry(1.2, 0.22, 0.6),
    new THREE.MeshBasicMaterial({ color: 0xff3333 })
  );
  beacon.position.set(0, 1.52, -0.3);
  mesh.add(beacon);
  mesh.userData.beacons = [beacon];
  scene.add(mesh);
  const unit = new Vehicle(mesh, x, z, Math.atan2(player.x - x, player.z - z), 'police');
  unit.fireT = 0;
  police.units.push(unit);
}

// ---------------------------------------------------------------------------
// Shared state bus: every cross-system read goes through this object.
// ---------------------------------------------------------------------------
const state = {
  money: 0,
  wanted: 0,
  time: WORLD.dayLength * 0.7,
  police,
  traffic,
  sfx,
  paused: false,
  wantedCooldown: 0,
  camera,
  player,
  playerCar,
  camYaw: 0,
  hideOverlay: () => overlay.hide(),
  spawnCopAt: (x, z) => dropCruiserAt(x, z),
  mission,
  stealCar: (c) => {
    playerCar = c;
    attachHeadlights(c);
    state.playerCar = c;
  },
  particles,
};

// Restore saved progress before the overlay is built.
const saved = loadSave();
if (saved) {
  state.money = saved.money ?? 0;
  mission.index = Math.min(saved.missionIndex ?? 0, MISSIONS.length);
}

// Start-screen overlay.
const overlay = Hud.overlay(document.body);
overlay.show(
  'VICE HORIZON',
  'An open-world crime playground on the neon coast. Steal cars, run jobs, outrun the heat.',
  'WASD — move / drive · Shift — sprint · F — enter / steal car · LMB — attack<br>' +
  'E / Q — switch weapon · T — start next job · G — side job board<br>' +
  'M — toggle big map / next mission · P — pause · R — respawn after bust',
  'START',
);

const hud = new Hud(document.body);
// Heat-driven star system on top of Police: crimes bank heat, cops follow the
// star count, and heat bleeds once nobody has eyes on the player.
const wanted = new Wanted(state, sfx, hud);
const radio = new Radio(sfx);
const economy = new Economy(scene, city, rng);
const minimap = new Minimap(document.body, city);
// The corner radar hides while the big map is up; wrap setVisible so both
// modules stay in step without knowing about each other.
minimap.setVisible = ((base) => (v) => {
  base(v);
  hud.setMinimapVisible(v);
})(minimap.setVisible.bind(minimap));

sideJobs.onReward = (cash, name) => {
  state.money += cash;
  hud.toast(`Side job paid — ${name} $${cash}`, 4);
};
sideJobs.onCrime = () => wantedUp(1, 'pedHit');

state.overlay = overlay;
state.wantedSys = wanted;
state.weather = weather;
state.radio = radio;
state.economy = economy;
// Economy owns the upgrades and merges its persisted cash into state.money
// (only when the main save had none, so the newer save wins).
economy.bind(state);

// ---------------------------------------------------------------------------
// Player helpers
// ---------------------------------------------------------------------------
function currentWeapon() { return WEAPONS[player.weaponIndex]; }

// Crime bridge: legacy call sites pass a severity (1 or 2); the Wanted system
// converts it into heat. Pass an explicit kind when the caller knows better.
function wantedUp(amount = 1, kind = null) {
  wanted.crime(kind || (amount >= 2 ? 'policeCarjack' : 'carjack'), 1);
}

function damagePlayer(damage) {
  if (!player.alive) return;
  let remaining = damage;
  if (player.armor > 0) {
    const absorbed = Math.min(player.armor, remaining * PLAYER.armorAbsorb);
    player.armor -= absorbed;
    remaining -= absorbed;
  }
  player.health -= remaining;
  if (player.health <= 0) {
    player.health = 0;
    player.alive = false;
    hud.toast('WASTED — press R to respawn');
    sfx.crash();
    if (player.inCar) exitCar();
  }
}

function respawn() {
  player.health = PLAYER.maxHealth;
  player.armor = 0;
  player.alive = true;
  player.x = 8;
  player.z = 30;
  // Respawn forgives heat but not all of it: drop two stars' worth so a repeat
  // offence still escalates; cops already spawned are cleared below.
  wanted.setHeat(wanted.heat - 200);
  police.clear();
}

// Nearest live car within the carried best distance. Scanned in list order
// with a strict `<`, so earlier lists win ties — traffic before cruisers.
function closestStealable(list, best, bestDist2) {
  for (const c of list) {
    if (c.dead) continue;
    const d2 = (c.x - player.x) ** 2 + (c.z - player.z) ** 2;
    if (d2 < bestDist2) { bestDist2 = d2; best = c; }
  }
  return { best, bestDist2 };
}

// Enter the nearest car (traffic or a cruiser); steal if occupied.
function tryEnterCar() {
  if (player.inCar) {
    exitCar();
    return;
  }
  const reach2 = 4.5 * 4.5;
  let found = closestStealable(traffic.cars, null, reach2);
  found = closestStealable(police.units, found.best, found.bestDist2);
  if (!found.best) return;
  player.inCar = true;
  player.wasWanted = state.wanted;
  playerCar = found.best;
  state.playerCar = found.best;
  attachHeadlights(playerCar);
  // Grand theft auto: witnesses call it in (cruiser theft is worse).
  wantedUp(found.best.kind === 'police' ? 2 : 1, found.best.kind === 'police' ? 'policeCarjack' : 'carjack');
  sfx.pickup();
  hud.toast('Carjacked!');
}

function exitCar() {
  player.inCar = false;
  player.x = playerCar.x + Math.sin(playerCar.heading + Math.PI / 2) * 2.4;
  player.z = playerCar.z + Math.cos(playerCar.heading + Math.PI / 2) * 2.4;
  sfx.engineOff();
}

// Close-quarters swing: peds fall, rival lookouts take fists too.
function strikeWithFists(w) {
  sfx.punch();
  const hitPed = peds.killNear(player.x, player.z, w.range);
  if (hitPed) {
    sideJobs.onPedKilled();
    wantedUp(1, 'pedHit');
  }
  for (const t of mission.targets) {
    if (t.kind === 'rival' && !t.done && Math.hypot(t.x - player.x, t.z - player.z) < w.range + 1) {
      t.rivalHp = (t.rivalHp ?? 30) - w.damage;
      if (t.rivalHp <= 0) {
        t.mesh.userData.dead = true;
        scene.remove(t.mesh);
      }
    }
  }
}

// Forward ray: traffic cars and rival targets in a narrow cone, tracer drawn.
function shootForward(w) {
  sfx.gunshot();
  const fx = Math.sin(player.heading);
  const fz = Math.cos(player.heading);
  const origin = new THREE.Vector3(player.x, 1.4, player.z);
  spawnTracer(origin, origin.clone().add(new THREE.Vector3(fx * w.range, 0, fz * w.range)));
  for (const c of traffic.cars) {
    const dx = c.x - player.x;
    const dz = c.z - player.z;
    const along = dx * fx + dz * fz;
    const side = Math.abs(dx * fz - dz * fx);
    if (along > 0 && along < w.range && side < 1.6) {
      c.takeDamage(w.damage);
      if (c.dead) wantedUp(1, 'vehicleDestroyed');
      break;
    }
  }
  for (const t of mission.targets) {
    if (t.kind === 'rival' && !t.done && t.mesh) {
      const dx = t.x - player.x;
      const dz = t.z - player.z;
      const along = dx * fx + dz * fz;
      const side = Math.abs(dx * fz - dz * fx);
      if (along > 0 && along < w.range && side < 1.6) {
        t.rivalHp = (t.rivalHp ?? 30) - w.damage;
        if (t.rivalHp <= 0) {
          t.mesh.userData.dead = true;
          scene.remove(t.mesh);
        }
        break;
      }
    }
  }
  // Shooting near peds raises heat.
  if (state.wanted === 0) wantedUp(1, 'gunshot');
}

function attack() {
  const w = currentWeapon();
  player.fireT = w.rate;
  if (w.id === 'fist') {
    strikeWithFists(w);
    return;
  }
  shootForward(w);
}

// Rival lookouts get a physical body once the eliminate mission starts.
function spawnRivalBodies() {
  for (const t of mission.targets) {
    if (t.kind === 'rival' && !t.mesh && !t.done) {
      const body = new THREE.Group();
      const torso = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.64, 0.32),
        new THREE.MeshLambertMaterial({ color: 0x35c2b8 })
      );
      torso.position.y = 1.14;
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 8, 6),
        new THREE.MeshLambertMaterial({ color: 0xc98e5e })
      );
      head.position.y = 1.62;
      body.add(torso, head);
      body.position.set(t.x, 0, t.z);
      body.castShadow = true;
      scene.add(body);
      t.mesh = body;
    }
  }
}

// ---------------------------------------------------------------------------
// Camera: mouse-look on foot, a heading-damped chase boom in a car, both kept
// out of buildings and under the rooftop line.
// ---------------------------------------------------------------------------
// Camera tuning: mouse yaw sensitivity, the boom's collision radius, and the
// rooftop ceiling the camera may climb to when boxed in by a building.
const CAMERA_MOUSE_SENS = 0.0035;
const CAMERA_COLLIDER_RADIUS = 1.4;
const CAMERA_CEILING = 26;

const cameraGoal = new THREE.Vector3(); // scratch target, reused every frame

function updateCamera(dt) {
  const md = input.consumeMouse();
  state.camYaw -= md.x * CAMERA_MOUSE_SENS;
  if (player.inCar) {
    if (md.x) state.camYaw -= md.x * CAMERA_MOUSE_SENS; // drag swings the car camera wider
    else state.camYaw = THREE.MathUtils.damp(state.camYaw, playerCar.heading, 2.5, dt);
  }

  const target = player.inCar ? playerCar : player;
  const back = player.inCar ? CAMERA.carBack : CAMERA.footBack;
  const height = player.inCar ? CAMERA.carHeight : CAMERA.footHeight;
  const cx = target.x - Math.sin(state.camYaw) * back;
  const cz = target.z - Math.cos(state.camYaw) * back;
  const hit = resolveCircle(cx, cz, CAMERA_COLLIDER_RADIUS, city.solids);
  let cy = height;
  for (const s of city.solids) {
    if (hit.x > s.minX - 0.5 && hit.x < s.maxX + 0.5 && hit.z > s.minZ - 0.5 && hit.z < s.maxZ + 0.5) {
      cy = Math.max(cy, Math.min(s.h + 3, CAMERA_CEILING));
    }
  }
  cameraGoal.set(hit.x, cy, hit.z);
  camera.position.lerp(cameraGoal, 1 - Math.pow(0.0001, dt));
  camera.lookAt(target.x, 1.6, target.z);
}

// ---------------------------------------------------------------------------
// Day / night: one clock drives sun, moon, fog, neon and headlight state.
// ---------------------------------------------------------------------------
const FOG_DAY = new THREE.Color(0x87a8d8);
const FOG_DUSK = new THREE.Color(0x3a2a55);
const FOG_NIGHT = new THREE.Color(0x121a2c);
const skyFogMix = new THREE.Color(); // scratch, mutated in place
const NEON_SIGN_TINTS = [0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d, 0xb44dff];

// Exported for the sky dome, the env mood and the headlights; written by
// updateSky() each frame.
let skyFrac = 0;
let skyDay = 1;

// Night windows: some lights on, but capped so walls stay dark and windows
// read as scattered light rather than a white wall of dots.
function setBuildingGlow(dayAmt) {
  city.buildingMats.forEach((m) => { m.emissiveIntensity = (1 - dayAmt) * 0.5; });
  city.shopMats.forEach((m) => { m.emissiveIntensity = 0.2 + (1 - dayAmt) * 0.9; });
  if (city.bulbMesh) city.bulbMesh.material.color.setScalar(0.4 + (1 - dayAmt) * 0.6);
  // Block-level neon pools fade in after dusk.
  for (const nl of city.neonLights) nl.intensity = (1 - dayAmt) * 26;
}

// Neon blade signs flicker and shine after dusk.
function updateNeonSigns(dayAmt) {
  if (!city.signMeshes) return;
  const glow = 0.25 + (1 - dayAmt) * 0.75;
  for (const m of city.signMeshes) {
    const flicker = 0.85 + 0.15 * Math.sin(state.time * 7 + m.userData.phase);
    m.material.color.setHex(NEON_SIGN_TINTS[Math.floor(m.userData.phase) % NEON_SIGN_TINTS.length]);
    m.visible = glow > 0.4 && flicker > 0.2;
  }
}

function updateSky() {
  const frac = (state.time % WORLD.dayLength) / WORLD.dayLength;
  const ang = frac * Math.PI * 2 - Math.PI / 2;
  const dayAmt = THREE.MathUtils.clamp(Math.sin(ang) * 1.4 + 0.35, 0, 1);

  sun.position.set(Math.cos(ang) * 180, Math.sin(ang) * 160 + 20, 60);
  sun.target.position.set(player.x, 0, player.z);
  sun.intensity = 1.7 * dayAmt;
  moon.position.set(-sun.position.x, Math.max(60, -Math.sin(ang) * 160), -40);
  moon.intensity = (1 - dayAmt) * 0.85;
  moon.target.position.set(player.x, 0, player.z);

  // Night floor: never let the city go pitch black.
  ambient.intensity = 0.45 + dayAmt * 0.55;
  ambient.color.setHex(dayAmt > 0.5 ? 0x9fb3d9 : 0x5a648a);
  hemi.intensity = 0.28 + dayAmt * 0.35;
  hemi.groundColor.setHex(dayAmt > 0.5 ? 0x241f2e : 0x1b2130);

  skyFogMix.copy(FOG_DAY)
    .lerp(FOG_DUSK, 1 - Math.min(1, dayAmt * 1.6))
    .lerp(FOG_NIGHT, 1 - dayAmt);
  scene.fog.color.copy(skyFogMix);

  setBuildingGlow(dayAmt);
  updateNeonSigns(dayAmt);

  skyFrac = frac;
  skyDay = dayAmt;
}

function updateHeadlights() {
  // HEADLIGHTS.nightThreshold is a dayAmt: beams on at or below it.
  const on = player.inCar && skyDay < HEADLIGHTS.nightThreshold;
  for (const beam of playerCar?.headlights || []) {
    beam.intensity += ((on ? HEADLIGHTS.onIntensity : 0) - beam.intensity) * Math.min(1, 0.1);
    beam.visible = beam.intensity > 1;
  }
}

// ---------------------------------------------------------------------------
// Main loop, split into the phases below. tick() only sequences them.
// ---------------------------------------------------------------------------
let lastFrameAt = performance.now();
let autosaveT = 0;
let started = false;
let attackHeld = false;

// Per-frame scratch objects: the loop must not allocate.
const worldTime = { time: 0 };
const footAnchor = { x: 0, z: 0, onFoot: true };
const threatPoint = { x: 0, z: 0 };

// ---- Player control ----
function runPlayerControls(dt) {
  const { f: fwd, s: side } = input.moveAxis();
  if (player.inCar) {
    playerCar.drive(fwd, side, dt, city.solids, economy.speedMultiplier());
    sfx.engine(Math.abs(playerCar.speed) / CAR.maxSpeed);
    // Running people over raises heat.
    const hitPed = peds.killNear(playerCar.x, playerCar.z, 2.6);
    if (hitPed) {
      sideJobs.onPedKilled();
      if (Math.abs(playerCar.speed) > 4) wantedUp(1, 'pedHit');
    }
  } else {
    const sprint = input.down('ShiftLeft') || input.down('ShiftRight');
    const spd = sprint ? PLAYER.runSpeed : PLAYER.walkSpeed;
    const len = Math.hypot(fwd, side) || 1;
    if (fwd || side) {
      // Movement is camera-relative.
      const worldAng = state.camYaw + Math.atan2(fwd / len, side / len);
      player.heading = worldAng;
      const nx = player.x + Math.sin(worldAng) * spd * (Math.abs(fwd) + Math.abs(side)) / len * dt * Math.sign(fwd || 1);
      const nz = player.z + Math.cos(worldAng) * spd * (Math.abs(fwd) + Math.abs(side)) / len * dt * Math.sign(fwd || 1);
      const hit = resolveCircle(nx, nz, PLAYER.radius, city.solids);
      if (!hit.blocked) {
        player.x = hit.x;
        player.z = hit.z;
      }
      player.phase += dt * spd * 1.6;
      const swing = Math.sin(player.phase) * 0.55;
      const limbs = playerGroup.userData.limbs;
      limbs[0].rotation.x = swing;
      limbs[1].rotation.x = -swing;
      limbs[2].rotation.x = -swing * 0.7;
      limbs[3].rotation.x = -0.6 + swing * 0.25; // gun arm stays raised
    }
    sfx.engineOff();
  }

  // Actions — routed through the input bindings so remaps just work.
  if (input.actionTapped('enter')) tryEnterCar();
  if (input.actionTapped('weaponNext')) player.weaponIndex = (player.weaponIndex + 1) % WEAPONS.length;
  if (input.actionTapped('weaponPrev')) player.weaponIndex = (player.weaponIndex + WEAPONS.length - 1) % WEAPONS.length;
  if (input.actionTapped('job')) mission.advance();
  if (input.tapped('KeyR') && !player.alive) respawn();
  if (input.actionTapped('sideJob')) sideJobs.startNext();
  if (input.actionTapped('map') && minimap) hud.toast(minimap.toggle() ? 'Map shown' : 'Map hidden', 1.5);
  // Radio: J cycles stations (Shift-J back), K toggles mute — in car only.
  if (player.inCar) {
    if (input.actionTapped('radio')) {
      const name = input.down('ShiftLeft') || input.down('ShiftRight') ? radio.prev() : radio.next();
      radio.jingle();
      hud.toast(name, 2);
    }
    if (input.actionTapped('radioMute')) hud.toast(radio.toggleMute() ? '📻 Radio on' : '🔇 Radio muted', 2);
  }
  // Gas-station shop stops: B / N / V / C while parked at a station.
  if (economy.insideShop) {
    if (input.tapped('KeyB')) economy.buy('health', player, hud, sfx);
    if (input.tapped('KeyN')) economy.buy('armor', player, hud, sfx);
    if (input.tapped('KeyV')) economy.buy('speed', player, hud, sfx);
    if (input.tapped('KeyC')) economy.buy('plating', player, hud, sfx);
  }

  player.fireT -= dt;
  const w = currentWeapon();
  // Holding LMB fires autos; semi-auto needs a fresh click each time.
  if (input.firing && player.fireT <= 0 && (w.auto || !attackHeld)) {
    attack();
    attackHeld = true;
  }
  if (!input.firing) attackHeld = false;
}

// ---- Systems ----
// Phase order is deliberate:
//   1. traffic   — obstacles move first, so peds/cops resolve against fresh boxes
//   2. peds      — base state machine (walk / flee / dead)
//   3. peds2     — life layer re-poses the same rigs after the base machine
//   4. police    — spawn/despawn uses this frame's wanted count
//   5. wanted    — heat decay reads police positions from step 4
//   6. missions  — objective checks against the final player position
//   7. economy   — shop proximity for that same position
function advanceSimulation(dt, playerRef) {
  footAnchor.x = player.x;
  footAnchor.z = player.z;
  if (state.wanted > 0) {
    threatPoint.x = player.x;
    threatPoint.z = player.z;
  }
  traffic.update(dt, player.inCar ? playerCar : footAnchor, city.solids, () => {
    // Traffic yields / panics near the player; nothing extra needed.
  });
  peds.update(dt, rng, playerRef, city.solids, state.wanted > 0 ? threatPoint : null);
  peds2.senseThreat(playerRef, state.wanted, dt);
  peds2.update(dt, playerRef, state.wanted);
  peds2.setPlayerFocus(playerRef);
  police.syncCount(state.wanted, dt, playerRef, city.solids, rng, city);
  police.update(dt, playerRef, state, city.solids, rng, damagePlayer);
  wanted.update(dt, playerRef, police, player.inCar);
  // The siren is wired straight to the star count; heat logic lives in Wanted.
  sfx.siren(state.wanted > 0);
  mission.update(dt, playerRef, worldTime);
  sideJobs.update(dt, playerRef, worldTime);
  economy.update(dt, player, player.inCar, playerCar, hud);
  radio.setInCar(player.inCar && started);
  spawnRivalBodies();
  mission.collectReward(state);
}

// ---- Visuals ----
function syncActors(dt) {
  if (!player.inCar) {
    playerGroup.visible = true;
    playerGroup.position.set(player.x, 0, player.z);
    playerGroup.rotation.y = player.heading;
  } else {
    playerGroup.visible = false;
    playerCar.sync();
  }
  for (const c of traffic.cars) if (!c.dead) c.sync();
  for (const t of mission.targets) {
    if (t.kind === 'rival' && t.mesh && !t.done && !t.mesh.userData.dead) {
      t.mesh.position.y = Math.sin(state.time * 3 + t.x) * 0.05;
    }
  }
  for (let i = tracerPool.length - 1; i >= 0; i--) {
    tracerPool[i].t -= dt;
    if (tracerPool[i].t <= 0) {
      scene.remove(tracerPool[i].line);
      tracerPool[i].line.geometry.dispose();
      tracerPool.splice(i, 1);
    }
  }
  particles.update(dt);
  weather.update(dt, player.inCar ? playerCar : player);
}

// ---- Presentation ----
function updatePresentation(dt) {
  // Speed-reactive FOV: a subtle cinematic push at high speed.
  const speedRatio = player.inCar ? Math.abs(playerCar.speed) / CAR.maxSpeed : 0;
  const targetFov = CAMERA.baseFov + speedRatio * CAMERA.speedFovPush;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * CAMERA.fovLerp);
  camera.updateProjectionMatrix();

  updateSky();
  sky.update(skyFrac, sun.position.clone().normalize(), skyDay);
  env.setMood(skyDay); // night chrome/glass reflections track the sky
  updateHeadlights();
  updateCamera(dt);
  hud.update(state, player, playerCar, mission, currentWeapon(), weather.label(), radio.label());
  minimap.update(dt, player, playerCar, mission, sideJobs, state);
}

// ---- Frame bookkeeping (after all systems, before the draw) ----
function frameBookkeeping(dt) {
  // Autosave on a config-driven cadence: money, mission index, economy ledger.
  autosaveT += dt;
  if (autosaveT > AUTOSAVE_SECONDS) {
    autosaveT = 0;
    writeSave({ money: state.money, missionIndex: mission.index });
    economy.persist();
  }
}

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - lastFrameAt) / 1000);
  lastFrameAt = now;

  // Pause: stop the schedule-ahead chain too, so music never queues behind the
  // overlay and dumps a burst on resume.
  if (state.paused) {
    radio.stop();
    sfx.engineOff();
    renderer.render(scene, camera);
    return;
  }

  state.time += dt;
  worldTime.time = state.time;

  // One reference for "where the player is" this frame: on foot the ped, in a
  // car the vehicle. Every system reads this, so an enter/exit mid-frame can
  // never leave two systems disagreeing about the body.
  const playerRef = player.inCar ? playerCar : player;

  if (started && player.alive) runPlayerControls(dt);
  advanceSimulation(dt, playerRef);
  syncActors(dt);
  updatePresentation(dt);
  frameBookkeeping(dt);

  input.endFrame();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Shot staging & boot
// ---------------------------------------------------------------------------
// Shot staging needs the overlay handle and every system to exist, so it runs
// last. The fixed-step loop caps nothing here — dt is already clamped.
function applyShot() {
  if (!shotName || !SHOTS[shotName]) return false;
  started = true;
  state.overlay = overlay;
  SHOTS[shotName](state);
  if (shotName !== 'start') overlay.hide();
  return true;
}

overlay.btn.addEventListener('click', () => {
  sfx.ensure();
  sfx.resume();
  overlay.hide();
  started = true;
  mission.advance(); // kicks off story mission 1 automatically
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyP' && started) {
    state.paused = !state.paused;
    if (state.paused) {
      overlay.show('PAUSED', 'Take a breath. The city waits.', 'P — resume', 'RESUME');
    } else {
      overlay.hide();
      // Pause stopped the radio scheduler; restart it if mid-drive.
      if (player.inCar && radio.enabled && radio.station().id !== 'off') radio.start();
    }
  }
});

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

applyShot();

requestAnimationFrame(tick);
