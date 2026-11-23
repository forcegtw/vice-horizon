// Frame engine. tick() drives the fixed phase order the old main.js used, and
// the per-phase bodies live here:
//
//   player   — input + actions resolve against last frame's world
//   systems  — traffic moves obstacles first, then the ped base machine, the
//              peds2 life layer poses the same rigs, police spawn on this
//              frame's wanted count, wanted heat decay reads police positions
//              from the prior step, then missions and economy
//   visuals  — rigs, particles, camera, sky, HUD
//   admin    — autosave cadence, input end-of-frame
//
// Day/night is one sweep (sun, moon, fog, emissive windows, lamp bulbs, neon)
// and exports updateSky.fraction / updateSky.dayAmt for the sky dome shader,
// the headlight rig and the environment mood. The loop stays allocation-free
// apart from the deliberate lerp/damp vectors; dt is clamped upstream and the
// phase order is deliberate — do not reshuffle it.

import * as THREE from '../../vendor/three.min.js';
import { WORLD, PLAYER, CAR, CAMERA, HEADLIGHTS, AUTOSAVE_SECONDS } from '../config.js';
import { resolveCircle } from '../vehicles.js';
import { writeSave } from '../save.js';
import { handleActionKeys, handleTrigger, damagePlayer, heldWeapon, wantedUp } from './input-bindings.ts';

// Headlights fade with dusk: on once night passes the threshold, off again at
// dawn. Reads updateSky.dayAmt exported by the sweep below.
function updateHeadlights(w) {
  const night = 1 - updateSky.dayAmt;
  const on = w.player.inCar && night > 1 - HEADLIGHTS.nightThreshold; // HEADLIGHTS.nightThreshold is dayAmt
  for (const s of w.playerCar?.headlights || []) {
    s.intensity += ((on ? HEADLIGHTS.onIntensity : 0) - s.intensity) * Math.min(1, 0.1);
    s.visible = s.intensity > 1;
  }
}

// Camera: chase boom with mouse yaw, dampened to the car's heading while
// driving. Kept out of buildings AND out of the sky: height clamps under the
// tallest nearby rooftop minus a margin, and the boom pulls in when blocked.
export function updateCamera(w, dt) {
  const md = w.input.consumeMouse();
  w.camYaw -= md.x * 0.0035;
  if (w.player.inCar) {
    if (md.x) w.camYaw -= md.x * 0.0035;
    else w.camYaw = THREE.MathUtils.damp(w.camYaw, w.playerCar.heading, 2.5, dt);
  }

  const target = w.player.inCar ? w.playerCar : w.player;
  const back = w.player.inCar ? CAMERA.carBack : CAMERA.footBack;
  const height = w.player.inCar ? CAMERA.carHeight : CAMERA.footHeight;
  const bx = target.x - Math.sin(w.camYaw) * back;
  const bz = target.z - Math.cos(w.camYaw) * back;
  const hit = resolveCircle(bx, bz, 1.4, w.city.solids);
  let cy = height;
  for (const s of w.city.solids) {
    if (hit.x > s.minX - 0.5 && hit.x < s.maxX + 0.5 && hit.z > s.minZ - 0.5 && hit.z < s.maxZ + 0.5) {
      cy = Math.max(cy, Math.min(s.h + 3, 26));
    }
  }
  w.camera.position.lerp(new THREE.Vector3(hit.x, cy, hit.z), 1 - Math.pow(0.0001, dt));
  w.camera.lookAt(target.x, 1.6, target.z);
}

// Sun and moon trade places through the day cycle; targets ride the player.
function placeSunAndMoon(w, ang, dayAmt) {
  w.sun.position.set(Math.cos(ang) * 180, Math.sin(ang) * 160 + 20, 60);
  w.sun.target.position.set(w.player.x, 0, w.player.z);
  w.sun.intensity = 1.7 * dayAmt;
  w.moon.position.set(-w.sun.position.x, Math.max(60, -Math.sin(ang) * 160), -40);
  w.moon.intensity = (1 - dayAmt) * 0.85;
  w.moon.target.position.set(w.player.x, 0, w.player.z);
  w.ambient.intensity = 0.45 + dayAmt * 0.55;
  w.ambient.color.setHex(dayAmt > 0.5 ? 0x9fb3d9 : 0x5a648a);
  w.hemi.intensity = 0.28 + dayAmt * 0.35;
  w.hemi.groundColor.setHex(dayAmt > 0.5 ? 0x241f2e : 0x1b2130);
}

function paintFog(w, dayAmt) {
  const dayCol = new THREE.Color(0x87a8d8);
  const duskCol = new THREE.Color(0x3a2a55);
  const nightCol = new THREE.Color(0x121a2c);
  w.scene.fog.color = dayCol.clone().lerp(duskCol, 1 - Math.min(1, dayAmt * 1.6)).lerp(nightCol, 1 - dayAmt);
}

// Night windows and neon: some lights on, but never a full white wall of dots —
// cap the emissive so walls stay dark and windows read as scattered light.
function setNightGlow(w, dayAmt) {
  w.city.buildingMats.forEach((m) => { m.emissiveIntensity = (1 - dayAmt) * 0.5; });
  w.city.shopMats.forEach((m) => { m.emissiveIntensity = 0.2 + (1 - dayAmt) * 0.9; });
  if (w.city.bulbMesh) w.city.bulbMesh.material.color.setScalar(0.4 + (1 - dayAmt) * 0.6);
  // Block-level neon pool lights fade in after dusk.
  for (const nl of w.city.neonLights) nl.intensity = (1 - dayAmt) * 26;
  // Neon signs flicker and shine after dusk.
  if (w.city.signMeshes) {
    const glow = 0.25 + (1 - dayAmt) * 0.75;
    for (const m of w.city.signMeshes) {
      const flick = 0.85 + 0.15 * Math.sin(w.state.time * 7 + m.userData.phase);
      m.material.color.setScalar(1);
      m.material.color.setHex([0xff2d95, 0x2de1ff, 0xffe14d, 0x7cff4d, 0xb44dff][Math.floor(m.userData.phase) % 5]);
      m.visible = glow > 0.4 && flick > 0.2;
    }
  }
}

// One sweep drives sun, moon, fog, emissive windows, lamp bulbs and neon;
// updateSky.fraction and updateSky.dayAmt are read downstream (sky dome
// shader, headlight rig, environment mood).
function updateSky(w) {
  const frac = (w.state.time % WORLD.dayLength) / WORLD.dayLength;
  const ang = frac * Math.PI * 2 - Math.PI / 2;
  const dayAmt = THREE.MathUtils.clamp(Math.sin(ang) * 1.4 + 0.35, 0, 1);
  placeSunAndMoon(w, ang, dayAmt);
  paintFog(w, dayAmt);
  setNightGlow(w, dayAmt);
  // Exported for the sky dome shader.
  updateSky.fraction = frac;
  updateSky.dayAmt = dayAmt;
}

// Rival lookouts get a physical body once the eliminate mission starts.
function materializeRivals(w) {
  for (const t of w.mission.targets) {
    if (t.kind === 'rival' && !t.mesh && !t.done) {
      const mesh = new THREE.Group();
      const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.64, 0.32), new THREE.MeshLambertMaterial({ color: 0x35c2b8 }));
      torso.position.y = 1.14;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshLambertMaterial({ color: 0xc98e5e }));
      head.position.y = 1.62;
      mesh.add(torso, head);
      mesh.position.set(t.x, 0, t.z);
      mesh.castShadow = true;
      w.scene.add(mesh);
      t.mesh = mesh;
    }
  }
}

function stepPlayer(w, dt) {
  if (!w.running || !w.player.alive) return;
  const { f, s } = w.input.moveAxis();
  if (w.player.inCar) {
    const throttle = f;
    w.playerCar.drive(throttle, s, dt, w.city.solids, w.economy.speedMultiplier());
    w.sfx.engine(Math.abs(w.playerCar.speed) / CAR.maxSpeed);
    // Running people over raises heat.
    const hitPed = w.peds.killNear(w.playerCar.x, w.playerCar.z, 2.6);
    if (hitPed) {
      w.sideJobs.onPedKilled();
      if (Math.abs(w.playerCar.speed) > 4) wantedUp(w, 1, 'pedHit');
    }
  } else {
    const sprint = w.input.down('ShiftLeft') || w.input.down('ShiftRight');
    const spd = sprint ? PLAYER.runSpeed : PLAYER.walkSpeed;
    const len = Math.hypot(f, s) || 1;
    const dirX = (f / len), dirZ = (s / len);
    // Movement is camera-relative; stride arithmetic kept in one expression
    // per axis: float evaluation order is load-bearing for the deterministic
    // sim.
    if (f || s) {
      const worldAng = w.camYaw + Math.atan2(dirX, dirZ);
      w.player.heading = worldAng;
      const nx = w.player.x + Math.sin(worldAng) * spd * (Math.abs(f) + Math.abs(s)) / len * dt * Math.sign(f || 1);
      const nz = w.player.z + Math.cos(worldAng) * spd * (Math.abs(f) + Math.abs(s)) / len * dt * Math.sign(f || 1);
      const hit = resolveCircle(nx, nz, PLAYER.radius, w.city.solids);
      if (hit.blocked) {
        // Squashed against a wall: keep the old spot so the ped can't tunnel.
      } else {
        w.player.x = hit.x; w.player.z = hit.z;
      }
      w.player.phase += dt * spd * 1.6;
      const swing = Math.sin(w.player.phase) * 0.55;
      const limbs = w.playerGroup.userData.limbs;
      limbs[0].rotation.x = swing;
      limbs[1].rotation.x = -swing;
      limbs[2].rotation.x = -swing * 0.7;
      limbs[3].rotation.x = -0.6 + swing * 0.25; // gun arm stays raised
    }
    w.sfx.engineOff();
  }

  // Actions — routed through the input bindings so remaps just work.
  handleActionKeys(w);
  handleTrigger(w, dt);
}

function stepSystems(w, dt, playerRef) {
  w.traffic.update(dt, w.player.inCar ? w.playerCar : { x: w.player.x, z: w.player.z, onFoot: !w.player.inCar }, w.city.solids, (c) => {
    // Traffic yields / panics near the player; nothing extra needed.
  });
  w.peds.update(dt, w.rng, playerRef, w.city.solids, w.state.wanted > 0 ? { x: w.player.x, z: w.player.z } : null);
  // Life layer runs after the base state machine so anim poses win the frame.
  w.peds2.senseThreat(playerRef, w.state.wanted, dt);
  w.peds2.update(dt, playerRef, w.state.wanted);
  w.peds2.setPlayerFocus(playerRef);
  w.police.syncCount(w.state.wanted, dt, playerRef, w.city.solids, w.rng, w.city);
  w.police.update(dt, playerRef, w.state, w.city.solids, w.rng, (d) => damagePlayer(w, d));
  w.wanted.update(dt, playerRef, w.police, w.player.inCar);
  // Wanted decay and heat bookkeeping live in Wanted.update; the loop only
  // wires the siren to the star count.
  w.sfx.siren(w.state.wanted > 0);
  w.mission.update(dt, playerRef, { time: w.state.time });
  w.sideJobs.update(dt, playerRef, { time: w.state.time });
  if (w.running && w.challenges) w.challenges.update(dt, playerRef, { time: w.state.time, inCar: w.player.inCar });
  w.economy.update(dt, w.player, w.player.inCar, w.playerCar, w.hud);
  w.radio.setInCar(w.player.inCar && w.running);
  materializeRivals(w);
  w.mission.collectReward(w.state);
}

function stepVisuals(w, dt) {
  if (!w.player.inCar) {
    w.playerGroup.visible = true;
    w.playerGroup.position.set(w.player.x, 0, w.player.z);
    w.playerGroup.rotation.y = w.player.heading;
  } else {
    w.playerGroup.visible = false;
    w.playerCar.sync();
  }
  for (const c of w.traffic.cars) if (!c.dead) c.sync();
  for (const t of w.mission.targets) {
    if (t.kind === 'rival' && t.mesh && !t.done && !t.mesh.userData.dead) {
      t.mesh.position.y = Math.sin(w.state.time * 3 + t.x) * 0.05;
    }
  }
  for (let i = w.tracers.length - 1; i >= 0; i--) {
    w.tracers[i].t -= dt;
    if (w.tracers[i].t <= 0) {
      w.scene.remove(w.tracers[i].line);
      w.tracers.splice(i, 1);
    }
  }
  w.particles.update(dt);
  w.weather.update(dt, w.player.inCar ? w.playerCar : w.player);

  trackSpeedFov(w, dt);

  updateSky(w);
  w.sky.update(updateSky.fraction, w.sun.position.clone().normalize(), updateSky.dayAmt);
  w.env.setMood(updateSky.dayAmt); // night chrome/glass reflections track the sky
  updateHeadlights(w);
  updateCamera(w, dt);
  w.hud.update(w.state, w.player, w.playerCar, w.mission, heldWeapon(w), w.weather.label(), w.radio.label());
  w.minimap.update(dt, w.player, w.playerCar, w.mission, w.sideJobs, w.state);
}

// Speed-reactive FOV: a subtle cinematic push at high speed.
function trackSpeedFov(w, dt) {
  const speedRatio = w.player.inCar ? Math.abs(w.playerCar.speed) / CAR.maxSpeed : 0;
  const targetFov = CAMERA.baseFov + speedRatio * CAMERA.speedFovPush;
  w.camera.fov += (targetFov - w.camera.fov) * Math.min(1, dt * CAMERA.fovLerp);
  w.camera.updateProjectionMatrix();
}

function stepFrameAdmin(w, dt) {
  // Autosave on a config-driven cadence (money, mission index, economy ledger).
  w.sinceAutosave += dt;
  if (w.sinceAutosave > AUTOSAVE_SECONDS) {
    w.sinceAutosave = 0;
    writeSave({ money: w.state.money, missionIndex: w.mission.index, ...(w.challenges ? w.challenges.saveData() : {}) });
    w.economy.persist();
  }
  w.input.endFrame();
}

function tick(w, now) {
  requestAnimationFrame((next) => tick(w, next));
  const dt = Math.min(0.05, (now - w.frameThen) / 1000);
  w.frameThen = now;
  // Pause: stop the schedule-ahead chain too, so music does not silently queue
  // while the overlay is up and then dump a burst on resume. Photo mode lives
  // in this branch too: its camera posing and overlay UI run only while the
  // sim is frozen, and it re-renders the same frame below.
  if (w.state.paused) {
    w.radio.stop();
    w.sfx.engineOff();
    if (w.photoMode) w.photoMode.update(dt);
    w.renderer.render(w.scene, w.camera);
    return;
  }

  w.state.time += dt;
  // One reference for "where the player is" this frame: on foot the ped, in a car
  // the vehicle. Every system below reads this instead of re-deriving the
  // ternary, so an enter/exit mid-frame can never leave two systems disagreeing
  // about the body.
  const playerRef = w.player.inCar ? w.playerCar : w.player;
  stepPlayer(w, dt);
  stepSystems(w, dt, playerRef);
  stepVisuals(w, dt);
  stepFrameAdmin(w, dt);
  w.renderer.render(w.scene, w.camera);
}

// Start the render loop. frameThen was stamped at boot so the first frame's
// dt stays small even if staging took a moment.
export function startLoop(w) {
  requestAnimationFrame((now) => tick(w, now));
}
