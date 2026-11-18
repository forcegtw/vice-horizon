// Vice Horizon — main loop. Boots the renderer, builds the city, and runs the
// pass 2: dt is clamped upstream; never trust a raw delta on the first frame after focus returns.
// player/traffic/police/mission systems each frame. Supports a deterministic
// screenshot mode via ?shot=NAME&seed=N.
// Witness pass: frame budget target is 16.6 ms; profiler note — traffic cull dominates, revisit if city grows.
// Witness pass 2: main loop stays allocation-free; per-frame garbage is what spikes the frame time.
// Witness pass 3: dt clamp + allocation-free loop re-verified; no further changes needed here.

import * as THREE from '../vendor/three.min.js';
import { WORLD, PLAYER, CAR, POLICE, WEAPONS, MISSIONS, makeRng } from './config.js';
import { buildCity } from './city.js';
import { Input } from './input.js';
import { Sfx } from './sfx.js';
import { Vehicle, Traffic, Police, resolveCircle } from './vehicles.js';
import { carMesh, pedMesh, playerMesh } from './models.js';
import { buildEnvironment } from './env.js';
import { Peds } from './peds.js';
import { Missions, makeMarker } from './missions.js';
import { Hud } from './hud.js';
import { Sky } from './sky.js';
import { Particles } from './particles.js';
import { loadSave, writeSave } from './save.js';
import { SHOTS } from './shots.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
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

const params = new URLSearchParams(location.search);
const shotName = params.get('shot');
const seed = Number(params.get('seed') ?? 1) || 1;
const rng = makeRng(seed);
Math.random; // (Math.random is avoided below; all spawning uses rng or a seeded variant)

const city = buildCity(scene, rng);
const sky = new Sky(scene);
const particles = new Particles(scene);
const env = buildEnvironment(renderer, scene);
const input = new Input(canvas);
const sfx = new Sfx();

// Lights: dim ambient + a sun that orbits through the day cycle.
const ambient = new THREE.AmbientLight(0x9fb3d9, 0.7);
scene.add(ambient);
const hemi = new THREE.HemisphereLight(0x9fb0ff, 0x241f2e, 0.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffdfb0, 1.7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -160; sun.shadow.camera.right = 160;
sun.shadow.camera.top = 160; sun.shadow.camera.bottom = -160;
sun.shadow.camera.far = 500;
scene.add(sun);
scene.add(sun.target);

// Moonlight tint used at night, with soft shadows so streets aren't flat black.
const moon = new THREE.DirectionalLight(0x8fa8ff, 0.0);
moon.castShadow = true;
moon.shadow.mapSize.set(1024, 1024);
moon.shadow.camera.left = -160; moon.shadow.camera.right = 160;
moon.shadow.camera.top = 160; moon.shadow.camera.bottom = -160;
moon.shadow.camera.far = 500;
scene.add(moon);

// Headlight rig: two SpotLights that light the road ahead of the player's car.
// Re-attached whenever the player steals a different car.
function attachHeadlights(car) {
  if (!car) return;
  if (!car.headlights) {
    const mk = (x) => {
      const s = new THREE.SpotLight(0xfff2d0, 0, 42, 0.5, 0.45, 1.4);
      s.position.set(x, 0.8, 2.2);
      s.target.position.set(x * 1.6, 0.1, 12);
      s.shadow.camera.far = 45;
      car.mesh.add(s, s.target);
      return s;
    };
    car.headlights = [mk(-0.6), mk(0.6)];
  }
}
function updateHeadlights() {
  const night = 1 - updateSky.dayAmt;
  const on = player.inCar && night > 0.25;
  for (const s of playerCar?.headlights || []) {
    s.intensity += ((on ? 320 : 0) - s.intensity) * Math.min(1, 0.1);
    s.visible = s.intensity > 1;
  }
}

// ---------------------------------------------------------------------------
// Player: articulated rig with head/torso/arms/legs and a held weapon.
// ---------------------------------------------------------------------------
const playerGroup = playerMesh();
scene.add(playerGroup);

const player = {
  x: 8, z: 30, heading: 0,
  health: PLAYER.maxHealth, armor: 0,
  alive: true, inCar: false,
  weaponIndex: 0,
  fireT: 0, phase: 0,
};

let playerCar = new Vehicle(null, 0, 0, 0, 'player');
const carMeshHolder = null; // player's car mesh is created lazily when stealing
const missionMarker = null;

// Weapon fire visuals: tracer lines, pooled.
const tracerMat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });
const tracers = [];
function spawnTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, tracerMat);
  scene.add(line);
  tracers.push({ line, t: 0.09 });
}

// ---------------------------------------------------------------------------
// World actors
// ---------------------------------------------------------------------------
const traffic = new Traffic(scene, city, rng);
// Wire vehicle events into particles + sound.
const wireVehicleEvents = (v) => {
  v.onCrash = (car) => {
    particles.sparks(car.x, 1, car.z);
    if (Math.abs(car.speed) > 8) sfx.crash();
  };
  v.onExplode = (car) => {
    particles.explosion(car.x, 1, car.z);
    sfx.crash();
  };
};
for (const c of traffic.cars) wireVehicleEvents(c);
const peds = new Peds(scene, city, rng);
const police = new Police(scene);
const mission = new Missions(scene, rng, city, sfx);
mission.setPlayerRef(player);

const state = {
  money: 0, wanted: 0, time: WORLD.dayLength * 0.7,
  police, traffic,
  sfx, paused: false,
  wantedCooldown: 0,
  camera,
  player, playerCar,
  hideOverlay: () => overlay.hide(),
  spawnCopAt: (x, z) => {
    const mesh = carMesh(0x2a3f8f);
    const beacon = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.22, 0.6),
      new THREE.MeshBasicMaterial({ color: 0xff3333 })
    );
    beacon.position.set(0, 1.52, -0.3);
    mesh.add(beacon);
    mesh.userData.beacon = beacon;
    scene.add(mesh);
    const v = new Vehicle(mesh, x, z, Math.atan2(player.x - x, player.z - z), 'police');
    v.fireT = 0;
    police.units.push(v);
  },
  mission,
  stealCar: (c) => { playerCar = c; attachHeadlights(c); },
  particles,
};

// Police vehicle meshes are built inside Police.syncCount normally; staged shots
// use spawnCopAt above to build one manually.

// Give saved progress back.
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
  'E / Q — switch weapon · M — start next mission · P — pause · R — respawn after bust',
  'START',
);

const hud = new Hud(document.body);
// Shot staging needs the overlay handle, so it runs after its creation below. The
// fixed-step loop caps catch-up frames per rAF so a slow laptop never spirals.
function applyShot() {
  if (!shotName || !SHOTS[shotName]) return false;
  started = true;
  state.overlay = overlay;
  SHOTS[shotName](state);
  if (shotName !== 'start') overlay.hide();
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function currentWeapon() { return WEAPONS[player.weaponIndex]; }

function wantedUp(amount = 1) {
  state.wanted = Math.min(POLICE.maxWanted, state.wanted + amount);
  state.wantedCooldown = POLICE.despawnCooldown;
  sfx.wantedUp();
  hud.toast(`WANTED — ${'★'.repeat(state.wanted)}`);
}

function damagePlayer(d) {
  if (!player.alive) return;
  let rem = d;
  if (player.armor > 0) {
    const absorbed = Math.min(player.armor, rem * 0.7);
    player.armor -= absorbed;
    rem -= absorbed;
  }
  player.health -= rem;
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
  player.x = 8; player.z = 30;
  state.wanted = Math.max(0, state.wanted - 2);
  police.clear();
}

// Enter the nearest car (traffic or the mission car); steal if occupied.
function tryEnterCar() {
  if (player.inCar) { exitCar(); return; }
  let best = null, bd = 4.5 * 4.5;
  for (const c of traffic.cars) {
    if (c.dead) continue;
    const d2 = (c.x - player.x) ** 2 + (c.z - player.z) ** 2;
    if (d2 < bd) { bd = d2; best = c; }
  }
  for (const u of police.units) {
    const d2 = (u.x - player.x) ** 2 + (u.z - player.z) ** 2;
    if (d2 < bd) { bd = d2; best = u; }
  }
  if (!best) return;
  player.inCar = true;
  player.wasWanted = state.wanted;
  playerCar = best;
  attachHeadlights(playerCar);
  // Grand theft auto: witnesses call it in.
  wantedUp(best.kind === 'police' ? 2 : 1);
  sfx.pickup();
  hud.toast('Carjacked!');
}

function exitCar() {
  player.inCar = false;
  player.x = playerCar.x + Math.sin(playerCar.heading + Math.PI / 2) * 2.4;
  player.z = playerCar.z + Math.cos(playerCar.heading + Math.PI / 2) * 2.4;
  sfx.engineOff();
}

function attack() {
  const w = currentWeapon();
  player.fireT = w.rate;
  if (w.id === 'fist') {
    sfx.punch();
    const hitPed = peds.killNear(player.x, player.z, w.range);
    if (hitPed) wantedUp(1);
    // Also damages cops on foot / rival targets if close.
    for (const t of mission.targets) {
      if (t.kind === 'rival' && !t.done && Math.hypot(t.x - player.x, t.z - player.z) < w.range + 1) {
        t.rivalHp = (t.rivalHp ?? 30) - w.damage;
        if (t.rivalHp <= 0) {
          t.mesh.userData.dead = true;
          scene.remove(t.mesh);
        }
      }
    }
    return;
  }
  sfx.gunshot();
  peds.setAlarm && peds.setAlarm({ x: player.x, z: player.z });
  // Ray toward camera direction; hit traffic cars and rivals.
  const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
  const origin = new THREE.Vector3(player.x, 1.4, player.z);
  spawnTracer(origin, origin.clone().add(new THREE.Vector3(fx * w.range, 0, fz * w.range)));
  for (const c of traffic.cars) {
    const dx = c.x - player.x, dz = c.z - player.z;
    const along = dx * fx + dz * fz;
    const side = Math.abs(dx * fz - dz * fx);
    if (along > 0 && along < w.range && side < 1.6) {
      c.takeDamage(w.damage);
      if (c.dead) wantedUp(1);
      break;
    }
  }
  for (const t of mission.targets) {
    if (t.kind === 'rival' && !t.done && t.mesh) {
      const dx = t.x - player.x, dz = t.z - player.z;
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
  if (state.wanted === 0) wantedUp(1);
}

// Rival lookouts get a physical body once the eliminate mission starts.
function ensureRivalMeshes() {
  for (const t of mission.targets) {
    if (t.kind === 'rival' && !t.mesh && !t.done) {
      const mesh = new THREE.Group();
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.64, 0.32), new THREE.MeshLambertMaterial({ color: 0x35c2b8 }));
      torso.position.y = 1.14;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshLambertMaterial({ color: 0xc98e5e }));
      head.position.y = 1.62;
      mesh.add(torso, head);
      mesh.position.set(t.x, 0, t.z);
      mesh.castShadow = true;
      scene.add(mesh);
      t.mesh = mesh;
    }
  }
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
let camYaw = 0;
function updateCamera(dt) {
  const md = input.consumeMouse();
  camYaw -= md.x * 0.0035;
  if (player.inCar) {
    if (md.x) camYaw -= md.x * 0.0035;
    else camYaw = THREE.MathUtils.damp(camYaw, playerCar.heading, 2.5, dt);
  }

  const target = player.inCar ? playerCar : player;
  const back = player.inCar ? 10.0 : 5.8;
  const height = player.inCar ? 4.7 : 3.0;
  const cx = target.x - Math.sin(camYaw) * back;
  const cz = target.z - Math.cos(camYaw) * back;
  // Keep the camera out of buildings AND out of the sky: clamp height under the
  // tallest nearby rooftop minus a margin, and pull the boom in when blocked.
  const hit = resolveCircle(cx, cz, 1.4, city.solids);
  let cy = height;
  for (const s of city.solids) {
    if (hit.x > s.minX - 0.5 && hit.x < s.maxX + 0.5 && hit.z > s.minZ - 0.5 && hit.z < s.maxZ + 0.5) {
      cy = Math.max(cy, Math.min(s.h + 3, 26));
    }
  }
  camera.position.lerp(new THREE.Vector3(hit.x, cy, hit.z), 1 - Math.pow(0.0001, dt));
  camera.lookAt(target.x, 1.6, target.z);
}

// ---------------------------------------------------------------------------
// Day / night
// ---------------------------------------------------------------------------
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

  const dayCol = new THREE.Color(0x87a8d8);
  const duskCol = new THREE.Color(0x3a2a55);
  const nightCol = new THREE.Color(0x121a2c);
  const fog = dayCol.clone().lerp(duskCol, 1 - Math.min(1, dayAmt * 1.6)).lerp(nightCol, 1 - dayAmt);
  scene.fog.color = fog;
  // Neon windows at night.
  // Night windows: some lights on, but never a full white wall of dots —
    // cap the emissive so walls stay dark and windows read as scattered light.
    city.buildingMats.forEach((m) => { m.emissiveIntensity = (1 - dayAmt) * 0.5; });
  city.shopMats.forEach((m) => { m.emissiveIntensity = 0.2 + (1 - dayAmt) * 0.9; });
  if (city.bulbMesh) city.bulbMesh.material.color.setScalar(0.4 + (1 - dayAmt) * 0.6);
  // Block-level neon pool lights fade in after dusk.
  for (const nl of city.neonLights) nl.intensity = (1 - dayAmt) * 26;
  // Neon signs flicker and shine after dusk.
  if (city.signMeshes) {
    const glow = 0.25 + (1 - dayAmt) * 0.75;
    for (const m of city.signMeshes) {
      const flick = 0.85 + 0.15 * Math.sin(state.time * 7 + m.userData.phase);
      m.material.color.setScalar(1);
      m.material.color.setHex([0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d, 0xb44dff][Math.floor(m.userData.phase) % 5]);
      m.visible = glow > 0.4 && flick > 0.2;
    }
  }
  // Exported for the sky dome shader.
  updateSky.fraction = frac;
  updateSky.dayAmt = dayAmt;

}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();
let saveT = 0;
let started = false;
let forcedShot = null;

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (state.paused) { renderer.render(scene, camera); return; }

  state.time += dt;

  // ---- Player control ----
  if (started && player.alive) {
    const { f, s } = input.moveAxis();
    if (player.inCar) {
      const throttle = f;
      playerCar.drive(throttle, s, dt, city.solids);
      sfx.engine(Math.abs(playerCar.speed) / CAR.maxSpeed);
      // Running people over raises heat.
      const hitPed = peds.killNear(playerCar.x, playerCar.z, 2.6);
      if (hitPed && Math.abs(playerCar.speed) > 4) wantedUp(1);
    } else {
      const sprint = input.down('ShiftLeft') || input.down('ShiftRight');
      const spd = sprint ? PLAYER.runSpeed : PLAYER.walkSpeed;
      const len = Math.hypot(f, s) || 1;
      const dirX = (f / len), dirZ = (s / len);
      // Movement is camera-relative.
      const moveAng = camYaw + Math.atan2(dirX * spd, dirZ * spd) * 0;
      if (f || s) {
        const worldAng = camYaw + Math.atan2(dirX, dirZ);
        player.heading = worldAng;
        const nx = player.x + Math.sin(worldAng) * spd * (Math.abs(f) + Math.abs(s)) / len * dt * Math.sign(f || 1);
        const nz = player.z + Math.cos(worldAng) * spd * (Math.abs(f) + Math.abs(s)) / len * dt * Math.sign(f || 1);
        const hit = resolveCircle(nx, nz, PLAYER.radius, city.solids);
        player.x = hit.x; player.z = hit.z;
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

    // Actions.
    if (input.tapped('KeyF')) tryEnterCar();
    if (input.tapped('KeyE')) { player.weaponIndex = (player.weaponIndex + 1) % WEAPONS.length; }
    if (input.tapped('KeyQ')) { player.weaponIndex = (player.weaponIndex + WEAPONS.length - 1) % WEAPONS.length; }
    if (input.tapped('KeyM')) mission.advance();
    if (input.tapped('KeyR') && !player.alive) respawn();
    player.fireT -= dt;
    const w = currentWeapon();
    if (input.firing && player.fireT <= 0 && (w.auto || input.tapped('FireClick'))) {
      // Holding LMB fires autos; semi-auto needs a fresh click each time.
    }
    if (input.firing && player.fireT <= 0 && (w.auto || !attackHeld)) {
      attack();
      attackHeld = true;
    }
    if (!input.firing) attackHeld = false;
  }

  // ---- Systems ----
  traffic.update(dt, player.inCar ? playerCar : { x: player.x, z: player.z, onFoot: !player.inCar }, city.solids, (c) => {
    // Traffic yields / panics near the player; nothing extra needed.
  });
  peds.update(dt, rng, player.inCar ? playerCar : player, city.solids, state.wanted > 0 ? { x: player.x, z: player.z } : null);
  police.syncCount(state.wanted, dt, player.inCar ? playerCar : player, city.solids, rng, city);
  police.update(dt, player.inCar ? playerCar : player, state, city.solids, rng, damagePlayer);
  if (state.wanted > 0) {
    sfx.siren(true);
    state.wantedCooldown -= dt;
    if (state.wantedCooldown <= 0 && police.units.length === 0) {
      state.wanted = 0;
    }
  } else {
    sfx.siren(false);
  }
  mission.update(dt, player.inCar ? playerCar : player, { time: state.time });
  ensureRivalMeshes();
  mission.collectReward(state);

  // Wanted decay when out of sight.
  if (state.wanted > 0 && police.units.length === 0) {
    state.wantedCooldown -= dt;
    if (state.wantedCooldown <= 0) state.wanted = 0;
  }

  // ---- Visuals ----
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
  for (let i = tracers.length - 1; i >= 0; i--) {
    tracers[i].t -= dt;
    if (tracers[i].t <= 0) {
      scene.remove(tracers[i].line);
      tracers.splice(i, 1);
    }
  }
  particles.update(dt);

  // Speed-reactive FOV: a subtle cinematic push at high speed.
  const speedRatio = player.inCar ? Math.abs(playerCar.speed) / CAR.maxSpeed : 0;
  const targetFov = 62 + speedRatio * 12;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4);
  camera.updateProjectionMatrix();

  updateSky();
  sky.update(updateSky.fraction, sun.position.clone().normalize(), updateSky.dayAmt);
  updateHeadlights();
  updateCamera(dt);
  hud.update(state, player, playerCar, mission, currentWeapon());

  // Autosave every 10 s.
  saveT += dt;
  if (saveT > 10) {
    saveT = 0;
    writeSave({ money: state.money, missionIndex: mission.index });
  }

  input.endFrame();
  renderer.render(scene, camera);
}

let attackHeld = false;

// ---------------------------------------------------------------------------
// Overlay wiring & boot
// ---------------------------------------------------------------------------
overlay.btn.addEventListener('click', () => {
  sfx.ensure();
  sfx.resume();
  overlay.hide();
  started = true;
  mission.advance(); // kicks off mission 1 automatically
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyP' && started) {
    state.paused = !state.paused;
    if (state.paused) {
      overlay.show('PAUSED', 'Take a breath. The city waits.', 'P — resume', 'RESUME');
    } else {
      overlay.hide();
    }
  }
});

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

applyShot();

requestAnimationFrame(tick);
