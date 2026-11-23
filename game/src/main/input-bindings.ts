// Player actions and their input bindings. Two halves:
//
// - the action implementations (enter/steal car, attack, respawn, damage) and
//   the crime bridge, all operating on the shared world context w;
// - the per-frame key routing lifted out of the old stepPlayer: action taps
//   (enter/weapons/jobs/map/radio/shop) and the trigger handling that fires
//   the held weapon, semi-auto latch included.
//
// loop.ts calls handleActionKeys + handleTrigger in the same spot the inline
// code used to run, so input timing and the crime/wanted side effects are
// unchanged.

import * as THREE from '../../vendor/three.min.js';
import { PLAYER, WEAPONS } from '../config.js';
import { resolveCircle } from '../vehicles.js';
import { attachHeadlights } from './boot.ts';

// Seconds a muzzle line stays lit.
const TRACER_TTL = 0.09;

// Weapon fire visuals: push one tracer line into the pooled list; the loop's
// visual step drains expired lines.
function fireTracer(w, from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, w.tracerMat);
  w.scene.add(line);
  w.tracers.push({ line, t: TRACER_TTL });
}

export function heldWeapon(w) { return WEAPONS[w.player.weaponIndex]; }

// Crime bridge: legacy call sites pass a severity (1 or 2); the Wanted system
// converts it into heat. Pass an explicit kind when the caller knows better.
export function wantedUp(w, amount = 1, kind = null) {
  w.wanted.crime(kind || (amount >= 2 ? 'policeCarjack' : 'carjack'), 1);
}

export function damagePlayer(w, d) {
  if (!w.player.alive) return;
  let rem = d;
  if (w.player.armor > 0) {
    const soaked = Math.min(w.player.armor, rem * PLAYER.armorAbsorb);
    w.player.armor -= soaked;
    rem -= soaked;
  }
  w.player.health -= rem;
  if (w.player.health <= 0) {
    w.player.health = 0;
    w.player.alive = false;
    w.hud.toast('WASTED — press R to respawn');
    w.sfx.crash();
    if (w.player.inCar) exitCar(w);
  }
}

export function respawn(w) {
  w.player.health = PLAYER.maxHealth;
  w.player.armor = 0;
  w.player.alive = true;
  w.player.x = 8; w.player.z = 30;
  // Respawn forgives heat but not all of it: drop two stars' worth so a repeat
  // offence still escalates, while cops already spawned get cleared below.
  w.wanted.setHeat(w.wanted.heat - 200);
  w.police.clear();
}

// Enter the nearest car (traffic or a cruiser); steal if occupied.
export function tryEnterCar(w) {
  if (w.player.inCar) { exitCar(w); return; }
  let best = null, bestD2 = 4.5 * 4.5;
  for (const c of w.traffic.cars) {
    if (c.dead) continue;
    const d2 = (c.x - w.player.x) ** 2 + (c.z - w.player.z) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = c; }
  }
  for (const u of w.police.units) {
    if (u.dead) continue;
    const d2 = (u.x - w.player.x) ** 2 + (u.z - w.player.z) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = u; }
  }
  if (!best) return;
  w.player.inCar = true;
  w.player.wasWanted = w.state.wanted;
  w.playerCar = best;
  attachHeadlights(w.playerCar);
  // Grand theft auto: witnesses call it in (cruiser theft is worse).
  wantedUp(w, best.kind === 'police' ? 2 : 1, best.kind === 'police' ? 'policeCarjack' : 'carjack');
  w.sfx.pickup();
  w.hud.toast('Carjacked!');
}

export function exitCar(w) {
  w.player.inCar = false;
  w.player.x = w.playerCar.x + Math.sin(w.playerCar.heading + Math.PI / 2) * 2.4;
  w.player.z = w.playerCar.z + Math.cos(w.playerCar.heading + Math.PI / 2) * 2.4;
  w.sfx.engineOff();
}

export function attack(w) {
  const wep = heldWeapon(w);
  w.player.fireT = wep.rate;
  if (wep.id === 'fist') {
    w.sfx.punch();
    const hitPed = w.peds.killNear(w.player.x, w.player.z, wep.range);
    if (hitPed) {
      w.sideJobs.onPedKilled();
      wantedUp(w, 1, 'pedHit');
    }
    // Also damages cops on foot / rival targets if close.
    for (const t of w.mission.targets) {
      if (t.kind === 'rival' && !t.done && Math.hypot(t.x - w.player.x, t.z - w.player.z) < wep.range + 1) {
        t.rivalHp = (t.rivalHp ?? 30) - wep.damage;
        if (t.rivalHp <= 0) {
          t.mesh.userData.dead = true;
          w.scene.remove(t.mesh);
        }
      }
    }
    return;
  }
  w.sfx.gunshot();
  w.peds.setAlarm && w.peds.setAlarm({ x: w.player.x, z: w.player.z });
  // Ray toward camera direction; hit traffic cars and rivals.
  const fx = Math.sin(w.player.heading), fz = Math.cos(w.player.heading);
  const origin = new THREE.Vector3(w.player.x, 1.4, w.player.z);
  fireTracer(w, origin, origin.clone().add(new THREE.Vector3(fx * wep.range, 0, fz * wep.range)));
  for (const c of w.traffic.cars) {
    const dx = c.x - w.player.x, dz = c.z - w.player.z;
    const along = dx * fx + dz * fz;
    const side = Math.abs(dx * fz - dz * fx);
    if (along > 0 && along < wep.range && side < 1.6) {
      c.takeDamage(wep.damage);
      if (c.dead) wantedUp(w, 1, 'vehicleDestroyed');
      break;
    }
  }
  for (const t of w.mission.targets) {
    if (t.kind === 'rival' && !t.done && t.mesh) {
      const dx = t.x - w.player.x, dz = t.z - w.player.z;
      const along = dx * fx + dz * fz;
      const side = Math.abs(dx * fz - dz * fx);
      if (along > 0 && along < wep.range && side < 1.6) {
        t.rivalHp = (t.rivalHp ?? 30) - wep.damage;
        if (t.rivalHp <= 0) {
          t.mesh.userData.dead = true;
          w.scene.remove(t.mesh);
        }
        break;
      }
    }
  }
  // Shooting near peds raises heat.
  if (w.state.wanted === 0) wantedUp(w, 1, 'gunshot');
}

// One tap per frame: movement-adjacent actions the old stepPlayer routed
// inline. Order matters — enter/steal before radio, shop keys last — because
// several actions mutate the same flags (inCar, insideShop) the later checks
// read.
export function handleActionKeys(w) {
  const { input, player, hud, sfx } = w;
  if (input.actionTapped('enter')) tryEnterCar(w);
  if (input.actionTapped('photo') && w.photoMode) w.photoMode.enter();
  if (input.actionTapped('weaponNext')) { player.weaponIndex = (player.weaponIndex + 1) % WEAPONS.length; }
  if (input.actionTapped('weaponPrev')) { player.weaponIndex = (player.weaponIndex + WEAPONS.length - 1) % WEAPONS.length; }
  if (input.actionTapped('job')) w.mission.advance();
  if (input.tapped('KeyR') && !player.alive) respawn(w);
  if (input.actionTapped('sideJob')) w.sideJobs.startNext();
  if (input.actionTapped('map') && w.minimap) hud.toast(w.minimap.toggle() ? 'Map shown' : 'Map hidden', 1.5);
  // Radio: J cycles stations (Shift-J back), K toggles mute — in-car only.
  if (player.inCar) {
    if (input.actionTapped('radio')) {
      const name = input.down('ShiftLeft') || input.down('ShiftRight') ? w.radio.prev() : w.radio.next();
      w.radio.jingle();
      hud.toast(name, 2);
    }
    if (input.actionTapped('radioMute')) hud.toast(w.radio.toggleMute() ? '📻 Radio on' : '🔇 Radio muted', 2);
  }
  // Gas-station shop stops: B / N / V / C while parked at a station.
  if (w.economy.insideShop) {
    if (input.tapped('KeyB')) w.economy.buy('health', player, hud, sfx);
    if (input.tapped('KeyN')) w.economy.buy('armor', player, hud, sfx);
    if (input.tapped('KeyV')) w.economy.buy('speed', player, hud, sfx);
    if (input.tapped('KeyC')) w.economy.buy('plating', player, hud, sfx);
  }
}

// Fire the held weapon: holding LMB fires autos; semi-auto needs a fresh
// click each time (triggerLatched guards that).
export function handleTrigger(w, dt) {
  w.player.fireT -= dt;
  const wep = heldWeapon(w);
  if (w.input.firing && w.player.fireT <= 0 && (wep.auto || !w.triggerLatched)) {
    attack(w);
    w.triggerLatched = true;
  }
  if (!w.input.firing) w.triggerLatched = false;
}
