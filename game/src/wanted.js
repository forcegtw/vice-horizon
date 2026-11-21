// wanted.js — the heat ledger behind the HUD star row.
//
// Crimes bank heat instead of writing stars directly. The visible star count
// is derived from the banked total against a gate ladder, which is why there
// is always a "partly earned next star" the heat bar can render. This module
// owns the ledger and the pursuit timers; the shared state bag carries the
// derived star count (state.wanted) plus the escalation grace window
// (state.wantedCooldown) that police spawning reads.
//
// Contracts the rest of the game relies on:
//   - crime(kind, amount) is the universal entry point. Kinds missing from
//     the table still cost heat through a generic fallback, so a typo can
//     never silently void a crime.
//   - missionHeat(stars) raises the ledger to a floor without ever lowering
//     it — scripted chases use it to force a minimum pursuit level.
//   - setHeat(v) is the raw writer (respawn forgiveness, scripted drops).
//     It never re-announces a star the player still holds.
//   - clear(reason) wipes everything: bribe dots, garages, escapes.
//   - update(dt, player, police, inCar) runs once per frame. Live cops inside
//     sight range keep the pursuit timer topped up; heat only bleeds after
//     the timer empties, which is what makes a getaway feel earned.
//
// One full star equals HEAT_PER_STAR heat — that is also the unit
// missionHeat() speaks in.

import { POLICE } from './config.js';

// Heat banked per crime. Offences against the law always outcost the civilian
// ones, so stealing a cruiser escalates faster than stealing a sedan.
const HEAT_TABLE = Object.freeze({
  carjack: 60,
  policeCarjack: 110,
  pedHit: 45,
  vehicleDestroyed: 55,
  gunshot: 25,
  copDestroyed: 90,
});
const UNLISTED_CRIME_HEAT = 40;

// Heat required to light each star, in order. Between gates the heat bar
// shows progress toward the next one.
const STAR_GATES = Object.freeze([40, 110, 220, 360, 520]);
const HEAT_PER_STAR = 100;

// Pursuit bookkeeping. After this many seconds with no cop in sight, the
// ledger starts cooling; driving extends the grace a little because a
// moving getaway should buy real distance.
const SIGHT_GRACE = 14;
const GRACE_BONUS_IN_CAR = 4;
const COOL_RATE = 6;   // heat units shed per unobserved second

export class Wanted {
  constructor(state, sfx, hud) {
    this.state = state;      // shared bag; wanted + wantedCooldown live here
    this.sfx = sfx;
    this.hud = hud;
    this.heat = 0;           // the ledger itself
    this.sightT = SIGHT_GRACE;
    this.crimeCount = 0;     // offences since the last wipe
    this.escaped = false;    // set once natural decay reached zero
  }

  // Bank a crime. `amount` multiplies the base cost (spree helper); the kind
  // lookup and multiplier are guarded so bad data can never NaN the ledger.
  crime(kind, amount = 1) {
    const mult = typeof amount === 'number' && Number.isFinite(amount)
      ? Math.max(0, amount)
      : 1;
    const cost = HEAT_TABLE[kind] ?? UNLISTED_CRIME_HEAT;
    this.heat += Math.max(0, cost) * mult;
    this.crimeCount += mult;
    this.sightT = SIGHT_GRACE;
    this.escaped = false;
    this._pushStars(false);
  }

  // Scripted floor: lift the ledger to `stars` worth of heat if it sits lower.
  missionHeat(stars) {
    const floor = Math.min(POLICE.maxWanted, Math.max(0, stars)) * HEAT_PER_STAR;
    if (floor > this.heat) {
      this.heat = floor;
      this._pushStars(false);
    }
    this.sightT = SIGHT_GRACE;
  }

  // Bribe dot / garage / mission handoff: wipe the ledger and the timers.
  clear(reason = '') {
    this.heat = 0;
    this.state.wanted = 0;
    this.state.wantedCooldown = 0;
    this.sightT = SIGHT_GRACE;
    this.escaped = reason === 'escape';
    if (this.hud) {
      this.hud.toast(reason === 'escape' ? 'You lost the heat.' : 'Heat cleared.');
    }
  }

  // Direct writer. Clamped and finite-guarded; silent by design.
  setHeat(v) {
    this.heat = Number.isFinite(v) ? Math.max(0, v) : 0;
    this._pushStars(false);
  }

  // Count the gates the ledger has passed, capped at the star ceiling.
  stars() {
    let lit = 0;
    while (lit < STAR_GATES.length && this.heat >= STAR_GATES[lit]) lit++;
    return Math.min(lit, POLICE.maxWanted);
  }

  // Re-derive stars into state and announce genuine moves upward. Cooling
  // messages only fire when `announceCooling` is set, so boot-time syncs and
  // respawn forgiveness never toast a star the player still holds.
  _pushStars(announceCooling) {
    const had = this.state.wanted;
    const now = this.stars();
    this.state.wanted = now;
    if (now > had) {
      this.sfx.wantedUp();
      if (this.hud) this.hud.toast(`WANTED — ${'★'.repeat(now)}`);
      this.state.wantedCooldown = POLICE.despawnCooldown;
    } else if (now < had && announceCooling) {
      if (this.hud) {
        this.hud.toast(now > 0 ? `Heat cooling — ${'★'.repeat(now)}` : 'Clean.');
      }
    }
  }

  // Per-frame pursuit bookkeeping. Any live unit inside sightRange refreshes
  // the grace window; once it drains, the ledger cools and stars dim.
  update(dt, player, police, inCar) {
    const units = (police && police.units) || [];
    let spotted = false;
    for (const u of units) {
      if (u.dead) continue;
      if (Math.hypot(u.x - player.x, u.z - player.z) < POLICE.sightRange) {
        spotted = true;
        break;
      }
    }
    if (spotted) {
      this.sightT = SIGHT_GRACE + (inCar ? GRACE_BONUS_IN_CAR : 0);
      this.escaped = false;
    } else {
      this.sightT -= dt;
    }

    if (this.heat > 0 && this.sightT <= 0) {
      const held = this.state.wanted;
      this.heat = Math.max(0, this.heat - COOL_RATE * dt);
      const droppedAStar = this.stars() < held;
      this._pushStars(droppedAStar);   // announce only a real star drop
      if (this.heat === 0 && !this.escaped) this.clear('escape');
    }

    // Cooldown mirrors main.js semantics: ticks down only while wanted.
    if (this.state.wanted > 0 && this.state.wantedCooldown > 0) {
      this.state.wantedCooldown -= dt;
    }
  }

  // Progress toward the next star inside the current gate band, clamped to
  // [0, 1]. At the ceiling the bar reads full so over-banked heat cannot
  // overflow the display.
  heatRatio() {
    const lit = this.stars();
    if (lit >= POLICE.maxWanted) return 1;
    const floor = lit === 0 ? 0 : STAR_GATES[lit - 1];
    const ceiling = STAR_GATES[lit];
    const span = ceiling - floor;
    return span > 0 ? Math.max(0, Math.min(1, (this.heat - floor) / span)) : 1;
  }
}
