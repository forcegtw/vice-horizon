// wanted.js — the heat ledger behind the HUD stars. Crimes bank heat, stars
// escalate from the banked total, and heat bleeds off while no cop has the
// player inside sight range. The numeric state lives here; the star display
// stays in hud.js, and scripted staging (saves, ?shot=) may write state.wanted
// directly without passing through this module.
//
// Design notes:
// - heatRatio() clamps to [0, 1], so over-banked heat can never push the
//   heat bar past full.
// - An unknown crime kind still costs generic heat: a typo at a call site can
//   never make a crime free.
// - update() only tracks sight and decay; spawning and despawning cops is
//   Police.syncCount's job, and the loop just wires the siren to the stars.

import { POLICE } from './config.js';

// Heat banked per crime type; one full star is 100 heat. Robbing the law
// (policeCarjack, copDestroyed) outranks robbing civilians.
const CRIME_HEAT = {
  carjack: 60,
  policeCarjack: 110,
  pedHit: 45,
  vehicleDestroyed: 55,
  gunshot: 25,
  copDestroyed: 90,
};

const GENERIC_HEAT = 40;      // fallback for unknown crime kinds
const HEAT_PER_STAR = 100;    // heat for one full star; missionHeat floors on it

const STAR_THRESHOLDS = [40, 110, 220, 360, 520]; // heat needed for 1..5 stars
const DECAY_PER_SEC = 6;        // heat bleeds while out of police sight
const PURSUIT_TIMEOUT = 14;     // s of no cop in range before decay kicks in
const IN_CAR_BONUS = 4;         // extra sightT seconds while driving: getaways feel earned

export class Wanted {
  constructor(state, sfx, hud) {
    this.state = state;   // shared game state; state.wanted is the star count
    this.sfx = sfx;
    this.hud = hud;
    this.heat = 0;
    this.sightT = PURSUIT_TIMEOUT;   // countdown until decay may resume
    this.lastStars = 0;
    this.crimeCount = 0;
    this.escaped = false;
  }

  // Register a crime. `amount` is an optional multiplier (e.g. a spree).
  crime(kind, amount = 1) {
    const add = Math.max(0, CRIME_HEAT[kind] ?? GENERIC_HEAT) * Math.max(0, amount);
    this.heat += add;
    this.crimeCount += amount;
    this.sightT = PURSUIT_TIMEOUT;
    this._syncStars(true);
  }

  // Missions call this: taking the job raises a fixed floor of heat.
  missionHeat(stars) {
    const target = Math.min(POLICE.maxWanted, stars) * HEAT_PER_STAR;
    if (this.heat >= target) return;
    this.heat = target;
    this._syncStars(true);
  }

  // Bribe / garage / mission handoff: wipes heat entirely.
  clear(reason = '') {
    if (this.heat <= 0) return;
    this.heat = 0;
    this.state.wanted = 0;
    this.state.wantedCooldown = 0;   // stale cooldown would keep ticking on a clean state
    this.sightT = PURSUIT_TIMEOUT;
    this.escaped = reason === 'escape';
    if (this.hud) this.hud.toast(reason === 'escape' ? 'You lost the heat.' : 'Heat cleared.');
  }

  // Direct heat writer for respawn forgiveness and scripted events. Bypasses
  // crime() so a partial wipe never re-announces a star the player still has.
  setHeat(v) {
    this.heat = Math.max(0, v);
    this._syncStars(false);
  }

  // Stars earned from the banked heat, capped at the police ceiling.
  stars() {
    let s = 0;
    for (const t of STAR_THRESHOLDS) {
      if (this.heat >= t) s++;
    }
    return Math.min(s, POLICE.maxWanted);
  }

  _syncStars(announce) {
    const prev = this.state.wanted;
    const next = this.stars();
    this.state.wanted = next;
    if (next > prev) {
      this.sfx.wantedUp();
      if (this.hud) this.hud.toast(`WANTED — ${'★'.repeat(next)}`);
      this.state.wantedCooldown = POLICE.despawnCooldown;
    } else if (announce && next < prev) {
      if (this.hud) this.hud.toast(next > 0 ? `Heat cooling — ${'★'.repeat(next)}` : 'Clean.');
    }
  }

  // Per-frame: track whether any cop still has sight, and decay heat when
  // none does. `inCar` stretches the pursuit timer — fast getaways feel earned.
  update(dt, player, police, inCar) {
    // Line-of-sight proxy: any live unit inside sightRange keeps the timer hot.
    let seen = false;
    for (const u of police.units) {
      if (u.dead) continue;
      if (Math.hypot(u.x - player.x, u.z - player.z) < POLICE.sightRange) {
        seen = true;
        break;
      }
    }
    if (seen) {
      this.sightT = PURSUIT_TIMEOUT + (inCar ? IN_CAR_BONUS : 0);
      this.escaped = false;
    } else {
      this.sightT -= dt;
    }

    if (this.heat > 0 && this.sightT <= 0) {
      const starsBefore = this.state.wanted;
      this.heat = Math.max(0, this.heat - DECAY_PER_SEC * dt);
      // Announce only when the decay actually dropped a star.
      this._syncStars(this.stars() !== starsBefore);
      if (this.heat <= 0 && !this.escaped) this.clear('escape');
    }

    // despawnCooldown bookkeeping mirrors main.js semantics.
    if (this.state.wanted > 0) {
      this.state.wantedCooldown -= dt;
    }
  }

  // HUD: percent progress toward the next star, clamped to [0, 1]
  // (1.0 = full bar at the five-star ceiling).
  heatRatio() {
    const s = this.stars();
    if (s >= POLICE.maxWanted) return 1;
    const floor = s === 0 ? 0 : STAR_THRESHOLDS[s - 1];
    const ceil = STAR_THRESHOLDS[s];
    return Math.max(0, Math.min(1, (this.heat - floor) / (ceil - floor)));
  }
}
