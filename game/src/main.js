// Vice Horizon — entrypoint and frame loop.
//
// Responsibilities, in boot order:
//   1. renderer + scene + camera setup (deterministic when ?seed=N is given)
//   2. city build, environment dressing, input + audio
//   3. lights (sun, moon, ambient/hemi, headlight rig)
//   4. player rig, weapon tracers, traffic/peds/police/missions/side jobs
//   5. wanted/weather/radio/economy/minimap/HUD wiring onto a shared `state`
//   6. save restore, start overlay, shot staging (?shot=start|play|end|dusk)
//   7. the fixed-cap rAF loop that drives every system each frame
//
// dt is clamped here — never trust a raw delta on the first frame after focus
// returns. Frame budget target is 16.6 ms; traffic culling dominates it, so
// revisit the city build before touching systems if frames spike. The loop is
// allocation-free on purpose: per-frame garbage is what spikes frame time.

import * as THREE from '../vendor/three.min.js';
import { WORLD, PLAYER, CAR, POLICE, CAMERA, HEADLIGHTS, AUTOSAVE_SECONDS, WEAPONS, MISSIONS, makeRng } from './config.js';
import { buildCity } from './city.js';
import { Input } from './input.js';
import { Sfx } from './sfx.js';
import { Vehicle, Traffic, Police, resolveCircle } from './vehicles.js';
import { carMesh, pedMesh, playerMesh } from './models.js';
import { buildEnvironment } from './env.js';
import { Peds } from './peds.js';
import { Peds2 } from './peds2.js';
import { Missions, makeMarker } from './missions.js';
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

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.35;

// Night-navy base; the fog color is repainted every frame by updateSky().
const NIGHT_SKY = 0x0b0e14;
const scene = new THREE.Scene();
scene.background = new THREE.Color(NIGHT_SKY);
scene.fog = new THREE.FogExp2(NIGHT_SKY, 0.0038);

const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);

// Query params: ?shot=NAME stages a deterministic scene, ?seed=N fixes all
// spawning. Math.random is never used below — everything draws from rng.
const params = new URLSearchParams(location.search);
const shotName = params.get('shot');
const seed = Number(params.get('seed') ?? 1) || 1;
const rng = makeRng(seed);

// ------------------------------------------------------------------ world
const city = buildCity(scene, rng);
const sky = new Sky(scene);
const particles = new Particles(scene);
const env = buildEnvironment(renderer, scene);
const input = new Input(canvas);
const sfx = new Sfx();

// Lights: dim ambient plus a sun that orbits through the day cycle.
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

// Moonlight tint for the night side of the cycle, with soft shadows so the
// streets never read as flat black.
const moon = new THREE.DirectionalLight(0x8fa8ff, 0.0);
moon.castShadow = true;
moon.shadow.mapSize.set(1024, 1024);
moon.shadow.camera.left = -160; moon.shadow.camera.right = 160;
moon.shadow.camera.top = 160; moon.shadow.camera.bottom = -160;
moon.shadow.camera.far = 500;
scene.add(moon);

// Headlight rig: two SpotLights lighting the road ahead of the player's car.
// The rig is built once per stolen car and reattached whenever they switch.
function attachHeadlights(car) {
  // The rig is built once per car and reattached whenever they switch rides.
  if (!car || car.headlights) return;
  const makeSpot = (x) => {
    const s = new THREE.SpotLight(0xfff2d0, 0, HEADLIGHTS.range, HEADLIGHTS.angle, 0.45, 1.4);
    s.position.set(x, 0.8, 2.2);
    s.target.position.set(x * 1.6, 0.1, 12);
    s.shadow.camera.far = HEADLIGHTS.range + 3;
    car.mesh.add(s, s.target);
    return s;
  };
  car.headlights = [makeSpot(-0.6), makeSpot(0.6)];
}

function updateHeadlights() {
  // HEADLIGHTS.nightThreshold is expressed against dayAmt, not hour.
  const nightAmt = 1 - updateSky.dayAmt;
  const shouldRun = player.inCar && nightAmt > 1 - HEADLIGHTS.nightThreshold;
  for (const s of playerCar?.headlights || []) {
    s.intensity += ((shouldRun ? HEADLIGHTS.onIntensity : 0) - s.intensity) * Math.min(1, 0.1);
    s.visible = s.intensity > 1;
  }
}

// ------------------------------------------------------------------ player
const playerGroup = playerMesh();
scene.add(playerGroup);

const player = {
  x: 8, z: 30, heading: 0,
  health: PLAYER.maxHealth, armor: 0,
  alive: true, inCar: false,
  weaponIndex: 0,
  fireT: 0, phase: 0,
};

// The player's car object exists from frame one; its mesh appears lazily when
// they first steal something (see state.stealCar).
let playerCar = new Vehicle(null, 0, 0, 0, 'player');

// Weapon fire visuals: pooled tracer lines with a short lifetime.
const tracerMat = new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9 });
const tracers = [];
function spawnTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, tracerMat);
  scene.add(line);
  tracers.push({ line, t: 0.09 });
}

// ------------------------------------------------------------------ actors
const traffic = new Traffic(scene, city, rng);

// Every vehicle gets the same crash/explosion bridge into particles + audio.
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
// Life layer: walk anims, fear of a wanted player, district density. It poses
// the same rigs after the base ped machine has run for the frame.
const peds2 = new Peds2(peds, city, rng);
const police = new Police(scene);
const mission = new Missions(scene, rng, city, sfx);
mission.setPlayerRef(player);
const weather = new Weather(scene, city, rng);
// Side-job board: races / deliveries / rampage, independent of the main chain.
const sideJobs = new SideJobs(scene, rng, city, sfx);

// World time when the game boots: 0.7 of a day puts the opening on the warm
// late-afternoon side of the cycle, so the title screen has long shadows.
const BOOT_DAY_FRACTION = 0.7;

// Shared state bag: every system that needs cross-cutting reads/writes hangs
// off this object rather than reaching into module-level lets.
const state = {
  money: 0, wanted: 0, time: WORLD.dayLength * BOOT_DAY_FRACTION,
  police, traffic,
  sfx, paused: false,
  wantedCooldown: 0,
  camera,
  player, playerCar,
  hideOverlay: () => overlay.hide(),
  spawnCopAt: (x, z) => {
    // Police.syncCount builds units itself; this manual path exists for staged
    // shots, and mirrors its mesh contract (beacons array for the lightbar).
    const mesh = carMesh(0x2a3f8f);
    const beacon = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 0.22, 0.6),
      new THREE.MeshBasicMaterial({ color: 0xff3333 })
    );
    beacon.position.set(0, 1.52, -0.3);
    mesh.add(beacon);
    mesh.userData.beacons = [beacon];
    scene.add(mesh);
    const v = new Vehicle(mesh, x, z, Math.atan2(player.x - x, player.z - z), 'police');
    v.fireT = 0;
    police.units.push(v);
  },
  mission,
  stealCar: (c) => { playerCar = c; attachHeadlights(c); },
  particles,
};

sideJobs.onReward = (cash, name) => {
  state.money += cash;
  hud.toast(`Side job paid — ${name} $${cash}`, 4);
};
sideJobs.onCrime = () => wantedUp(1, 'pedHit');

// Restore saved progress (money + mission index) before anything reads it.
const saved = loadSave();
if (saved) {
  state.money = saved.money ?? 0;
  mission.index = Math.min(saved.missionIndex ?? 0, MISSIONS.length);
}
// Economy owns upgrades; economy.bind merges its persisted cash into
// state.money only when the main save carried none, so the newer save wins.

// ------------------------------------------------------------------ UI
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
// Heat-driven stars on top of Police: crimes bank heat, cops follow the star
// count, and heat bleeds off once nobody has eyes on the player.
const wanted = new Wanted(state, sfx, hud);
const radio = new Radio(sfx);
const economy = new Economy(scene, city, rng);
const minimap = new Minimap(document.body, city);
// Mirror minimap visibility into the HUD (it collapses its panel when hidden).
minimap.setVisible = ((orig) => (v) => { orig(v); hud.setMinimapVisible(v); })(minimap.setVisible.bind(minimap));

state.wantedSys = wanted;
state.weather = weather;
state.radio = radio;
state.economy = economy;
economy.bind(state);

// Shot staging needs the overlay handle, so it is callable only once the
// overlay exists (applyShot() runs at the bottom of boot).
function applyShot() {
  if (!shotName || !SHOTS[shotName]) return false;
  started = true;
  state.overlay = overlay;
  SHOTS[shotName](state);
  if (shotName !== 'start') overlay.hide();
  return true;
}

// ------------------------------------------------------------------ helpers
function currentWeapon() { return WEAPONS[player.weaponIndex]; }

// Crime bridge: legacy call sites pass a severity (1 or 2); the Wanted system
// converts that into heat. Callers that know better pass an explicit kind.
function wantedUp(amount = 1, kind = null) {
  wanted.crime(kind || (amount >= 2 ? 'policeCarjack' : 'carjack'), 1);
}

function damagePlayer(d) {
  if (!player.alive) return;
  let remaining = d;
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
  player.x = 8; player.z = 30;
  // Forgiveness, not amnesty: drop two stars' worth of heat so repeat offences
  // still escalate, then clear cops that already spawned.
  wanted.setHeat(wanted.heat - 200);
  police.clear();
}

// Enter the nearest car (traffic or a police cruiser); stealing is implicit.
// Squared distance a car must be within for the player to enter it.
const ENTER_RADIUS_SQ = 4.5 * 4.5;
function tryEnterCar() {
  if (player.inCar) { exitCar(); return; }
  let best = null, bestD2 = ENTER_RADIUS_SQ;
  for (const c of traffic.cars) {
    if (c.dead) continue;
    const d2 = (c.x - player.x) ** 2 + (c.z - player.z) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = c; }
  }
  for (const u of police.units) {
    if (u.dead) continue;
    const d2 = (u.x - player.x) ** 2 + (u.z - player.z) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = u; }
  }
  if (!best) return;
  player.inCar = true;
  player.wasWanted = state.wanted;
  playerCar = best;
  attachHeadlights(playerCar);
  // Grand theft auto: witnesses call it in; cruiser theft escalates faster.
  wantedUp(best.kind === 'police' ? 2 : 1, best.kind === 'police' ? 'policeCarjack' : 'carjack');
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
    if (hitPed) {
      sideJobs.onPedKilled();
      wantedUp(1, 'pedHit');
    }
    // Fists also land on close rival targets in eliminate jobs.
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
  // Ray along the player's heading; hits traffic cars and rival lookouts.
  const fx = Math.sin(player.heading), fz = Math.cos(player.heading);
  const origin = new THREE.Vector3(player.x, 1.4, player.z);
  spawnTracer(origin, origin.clone().add(new THREE.Vector3(fx * w.range, 0, fz * w.range)));

  for (const c of traffic.cars) {
    const dx = c.x - player.x, dz = c.z - player.z;
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
  // Shooting near peds raises heat even if everything missed.
  if (state.wanted === 0) wantedUp(1, 'gunshot');
}

// Rival lookouts get a physical body once an eliminate mission starts.
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

// ------------------------------------------------------------------ camera
let camYaw = 0;
function updateCamera(dt) {
  const md = input.consumeMouse();
  camYaw -= md.x * 0.0035;
  if (player.inCar) {
    if (md.x) camYaw -= md.x * 0.0035;
    else camYaw = THREE.MathUtils.damp(camYaw, playerCar.heading, 2.5, dt);
  }

  const target = player.inCar ? playerCar : player;
  const back = player.inCar ? CAMERA.carBack : CAMERA.footBack;
  const height = player.inCar ? CAMERA.carHeight : CAMERA.footHeight;
  const cx = target.x - Math.sin(camYaw) * back;
  const cz = target.z - Math.cos(camYaw) * back;

  // Keep the boom out of buildings AND out of the sky: clamp height under the
  // tallest nearby rooftop minus a margin, and pull in when blocked.
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

// ------------------------------------------------------------------ day/night
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

  // Fog blends day -> dusk -> night.
  const dayCol = new THREE.Color(0x87a8d8);
  const duskCol = new THREE.Color(0x3a2a55);
  const nightCol = new THREE.Color(0x121a2c);
  scene.fog.color = dayCol.clone()
    .lerp(duskCol, 1 - Math.min(1, dayAmt * 1.6))
    .lerp(nightCol, 1 - dayAmt);

  // Neon windows: some lights on, but never a full white wall of dots — cap
  // the emissive so walls stay dark and windows read as scattered light.
  city.buildingMats.forEach((m) => { m.emissiveIntensity = (1 - dayAmt) * 0.5; });
  city.shopMats.forEach((m) => { m.emissiveIntensity = 0.2 + (1 - dayAmt) * 0.9; });
  if (city.bulbMesh) city.bulbMesh.material.color.setScalar(0.4 + (1 - dayAmt) * 0.6);

  // Block-level neon pool lights fade in after dusk; signs flicker on.
  for (const nl of city.neonLights) nl.intensity = (1 - dayAmt) * 26;
  if (city.signMeshes) {
    const glow = 0.25 + (1 - dayAmt) * 0.75;
    for (const m of city.signMeshes) {
      const flick = 0.85 + 0.15 * Math.sin(state.time * 7 + m.userData.phase);
      m.material.color.setScalar(1);
      m.material.color.setHex([0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d, 0xb44dff][Math.floor(m.userData.phase) % 5]);
      m.visible = glow > 0.4 && flick > 0.2;
    }
  }

  // Exported for the sky dome shader and the headlight logic.
  updateSky.fraction = frac;
  updateSky.dayAmt = dayAmt;
}

// ------------------------------------------------------------------ main loop
let last = performance.now();
let saveT = 0;
let started = false;
let attackHeld = false;

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // Pause: freeze the schedule-ahead chain too, so music does not silently
  // queue under the overlay and then dump a burst on resume.
  if (state.paused) {
    radio.stop();
    sfx.engineOff();
    renderer.render(scene, camera);
    return;
  }

  state.time += dt;

  // ---- Player control ----
  // One reference for "where the player is" this frame: on foot the ped, in a
  // car the vehicle. Every system reads this, so an enter/exit mid-frame can
  // never leave two systems disagreeing about the body.
  const playerRef = player.inCar ? playerCar : player;
  if (started && player.alive) {
    const { f, s } = input.moveAxis();
    if (player.inCar) {
      playerCar.drive(f, s, dt, city.solids, economy.speedMultiplier());
      sfx.engine(Math.abs(playerCar.speed) / CAR.maxSpeed);
      // Running people over raises heat (above a crawl).
      const hitPed = peds.killNear(playerCar.x, playerCar.z, 2.6);
      if (hitPed) {
        sideJobs.onPedKilled();
        if (Math.abs(playerCar.speed) > 4) wantedUp(1, 'pedHit');
      }
    } else {
      const sprint = input.down('ShiftLeft') || input.down('ShiftRight');
      const spd = sprint ? PLAYER.runSpeed : PLAYER.walkSpeed;
      const len = Math.hypot(f, s) || 1;
      const dirX = f / len, dirZ = s / len;
      // Camera-relative movement on foot; camYaw follows the boom behind the body.
      if (f || s) {
        const worldAng = camYaw + Math.atan2(dirX, dirZ);
        player.heading = worldAng;
        const step = spd * (Math.abs(f) + Math.abs(s)) / len * dt * Math.sign(f || 1);
        const nx = player.x + Math.sin(worldAng) * step;
        const nz = player.z + Math.cos(worldAng) * step;
        const hit = resolveCircle(nx, nz, PLAYER.radius, city.solids);
        if (hit.blocked) {
          // Squashed against a wall: keep the old spot so the ped can't tunnel.
        } else {
          player.x = hit.x; player.z = hit.z;
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
    // Radio: J cycles stations (Shift-J backwards), K toggles mute — in-car only.
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
  //   1. traffic  — obstacles move first so later systems resolve fresh boxes
  //   2. peds     — base state machine (walk / flee / dead)
  //   3. peds2    — life layer poses the same rigs after the base machine ran
  //   4. police   — spawn/despawn against this frame's wanted count
  //   5. wanted   — heat decay reads police positions from step 4
  //   6. missions — objective checks against the final player position
  //   7. economy  — shop proximity for the same position
  traffic.update(dt, player.inCar ? playerCar : { x: player.x, z: player.z, onFoot: !player.inCar }, city.solids, () => {
    // Traffic yields / panics near the player; nothing extra needed here.
  });
  peds.update(dt, rng, playerRef, city.solids, state.wanted > 0 ? { x: player.x, z: player.z } : null);
  peds2.senseThreat(playerRef, state.wanted, dt);
  peds2.update(dt, playerRef, state.wanted);
  peds2.setPlayerFocus(playerRef);
  police.syncCount(state.wanted, dt, playerRef, city.solids, rng, city);
  police.update(dt, playerRef, state, city.solids, rng, damagePlayer);
  wanted.update(dt, playerRef, police, player.inCar);
  // The loop only wires the siren to the star count; decay and heat
  // bookkeeping live inside Wanted.update.
  sfx.siren(state.wanted > 0);
  mission.update(dt, playerRef, { time: state.time });
  sideJobs.update(dt, playerRef, { time: state.time });
  economy.update(dt, player, player.inCar, playerCar, hud);
  radio.setInCar(player.inCar && started);
  ensureRivalMeshes();
  mission.collectReward(state);

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
  weather.update(dt, player.inCar ? playerCar : player);

  // Speed-reactive FOV: a subtle cinematic push at high speed.
  const speedRatio = player.inCar ? Math.abs(playerCar.speed) / CAR.maxSpeed : 0;
  const targetFov = CAMERA.baseFov + speedRatio * CAMERA.speedFovPush;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * CAMERA.fovLerp);
  camera.updateProjectionMatrix();

  updateSky();
  sky.update(updateSky.fraction, sun.position.clone().normalize(), updateSky.dayAmt);
  env.setMood(updateSky.dayAmt); // night chrome/glass reflections track the sky
  updateHeadlights();
  updateCamera(dt);
  hud.update(state, player, playerCar, mission, currentWeapon(), weather.label(), radio.label());
  minimap.update(dt, player, playerCar, mission, sideJobs, state);

  // ---- Frame bookkeeping (after all systems, before the draw) ----
  // Autosave on a config-driven cadence (money, mission index, economy ledger).
  saveT += dt;
  if (saveT > AUTOSAVE_SECONDS) {
    saveT = 0;
    writeSave({ money: state.money, missionIndex: mission.index });
    economy.persist();
  }

  input.endFrame();
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------ boot
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
      // Pause stopped the radio scheduler; restart it if the player is mid-drive.
      if (player.inCar && radio.enabled && radio.station().id !== 'off') radio.start();
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
