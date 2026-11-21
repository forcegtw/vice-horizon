// wanted.js — heat-driven police response. Crimes bank heat; heat crossing star
// thresholds raises state.wanted, which Police.syncCount reads to size the
// response. Decay only runs after SIGHT_MEMORY seconds with no live unit in
// range, so heat sticks through a chase and bleeds once nobody has eyes on the
// player. The HUD renders the stars; this module stays purely numeric so shot
// staging and saves can write state.wanted directly without a round-trip here.

import { POLICE } from './config.js';

// Heat banked per crime kind. Unlisted kinds still cost DEFAULT_HEAT so a typo
// can never make a crime free.
const CRIME_HEAT = {
  carjack: 60,
  policeCarjack: 110,
  pedHit: 45,
  vehicleDestroyed: 55,
  gunshot: 25,
  copDestroyed: 90,
};
const DEFAULT_HEAT = 40;
const HEAT_PER_STAR = 100;   // missionHeat floors are quoted in stars
const STAR_THRESHOLDS = [40, 110, 220, 360, 520]; // heat needed for 1..5 stars
const DECAY_MPS = 6;         // heat bleed per second while out of sight
const SIGHT_MEMORY = 14;     // no-contact seconds before decay kicks in
const GETAWAY_GRACE = 4;     // extra sight seconds while driving: getaways feel earned

export class Wanted {
  constructor(state, sfx, hud) {
    this.state = state;   // shared game state; state.wanted is the star count
    this.sfx = sfx;
    this.hud = hud;
    this.heat = 0;
    this.sightT = SIGHT_MEMORY; // seconds since a cop was last within sightRange
    this.lastStars = 0;
    this.crimeCount = 0;
    this.escaped = false;
  }

  // Register a crime. amount multiplies the heat (e.g. a spree); negative or
  // unknown inputs degrade safely instead of zeroing or NaN-ing the bank.
  crime(kind, amount = 1) {
    const add = Math.max(0, CRIME_HEAT[kind] ?? DEFAULT_HEAT) * Math.max(0, amount);
    this.heat += add;
    this.crimeCount += amount;
    this.sightT = SIGHT_MEMORY;
    this._sync(true);
  }

  // Missions call this: taking the job raises a fixed floor of heat, never
  // lowering whatever the player has already banked.
  missionHeat(stars) {
    const floor = Math.min(POLICE.maxWanted, stars) * HEAT_PER_STAR;
    if (this.heat < floor) {
      this.heat = floor;
      this._sync(true);
    }
  }

  // Bribe / garage / mission handoff: wipes heat entirely. A stale cooldown
  // would keep ticking on an already-clean state, so it goes too.
  clear(reason = '') {
    if (this.heat <= 0) return;
    this.heat = 0;
    this.state.wanted = 0;
    this.state.wantedCooldown = 0;
    this.sightT = SIGHT_MEMORY;
    this.escaped = reason === 'escape';
    if (this.hud) this.hud.toast(reason === 'escape' ? 'You lost the heat.' : 'Heat cleared.');
  }

  // Direct heat writer for respawn forgiveness and scripted events. Bypasses
  // crime() so a partial wipe never re-announces a star the player still has.
  setHeat(v) {
    this.heat = Math.max(0, v);
    this._sync(false);
  }

  stars() {
    let s = 0;
    for (const t of STAR_THRESHOLDS) {
      if (this.heat >= t) s++;
    }
    return Math.min(s, POLICE.maxWanted);
  }

  _sync(announce) {
    const prev = this.state.wanted;
    const next = this.stars();
    this.state.wanted = next;
    if (next > prev) {
      this.sfx.wantedUp();
      if (this.hud) this.hud.toast(`WANTED — ${'★'.repeat(next)}`);
      this.state.wantedCooldown = POLICE.despawnCooldown;
    } else if (next < prev && announce) {
      if (this.hud) this.hud.toast(next > 0 ? `Heat cooling — ${'★'.repeat(next)}` : 'Clean.');
    }
  }

  // Per-frame: track whether cops still have sight, and decay heat when they
  // don't. Also keeps wantedCooldown bookkeeping in step with main.js semantics.
  update(dt, player, police, inCar) {
    // Line-of-sight proxy: any live unit within sightRange keeps the timer hot.
    let seen = false;
    for (const u of police.units) {
      if (u.dead) continue;
      if (Math.hypot(u.x - player.x, u.z - player.z) < POLICE.sightRange) {
        seen = true;
        break;
      }
    }
    if (seen) {
      this.sightT = SIGHT_MEMORY;
      if (inCar) this.sightT += GETAWAY_GRACE;
      this.escaped = false;
    } else {
      this.sightT -= dt;
    }

    if (this.heat > 0 && this.sightT <= 0) {
      const before = this.state.wanted;
      this.heat = Math.max(0, this.heat - DECAY_MPS * dt);
      this._sync(this.stars() !== before);
      if (this.heat <= 0 && !this.escaped) this.clear('escape');
    }

    if (this.state.wanted > 0) {
      this.state.wantedCooldown -= dt;
    }
  }

  // HUD helper: progress toward the next star within the current band, clamped
  // to [0, 1] — an over-banked heat can never push the bar past full.
  heatRatio() {
    const s = this.stars();
    if (s >= POLICE.maxWanted) return 1;
    const low = s === 0 ? 0 : STAR_THRESHOLDS[s - 1];
    const high = STAR_THRESHOLDS[s];
    return Math.max(0, Math.min(1, (this.heat - low) / (high - low)));
  }
}
