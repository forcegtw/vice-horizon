// Wanted system: heat-driven star levels, escalating police response, pursuit
// timers and heat decay. This is the gameplay layer over Police.syncCount —
// crimes call Wanted.crime(), missions can raise or clear heat, and the loop
// only has to call Wanted.update(dt, ...).
// Design rule: the star display stays in HUD; this module owns only the numeric
// heat and its escalation/decay timers, so save/shot staging can set wanted
// directly without going through here.
// Final polish: heatRatio() clamps to [0,1] so an over-banked heat value (e.g. after
// missionHeat floors past a threshold) can't push the heat bar past full.

import { POLICE } from './config.js';

// Heat banked per crime type; a full star is 100 heat.
const CRIME_HEAT = {
  carjack: 60,
  policeCarjack: 110,
  pedHit: 45,
  vehicleDestroyed: 55,
  gunshot: 25,
  copDestroyed: 90,
};

const STAR_THRESHOLDS = [40, 110, 220, 360, 520]; // heat needed for 1..5 stars
const DECAY_PER_SEC = 6;          // heat bleeds when out of police sight
const PURSUIT_TIMEOUT = 14;       // s of no cop in range before decay kicks in
const RAMP_PER_STAR = 1;          // extra cars per star handled via copsPerStar

export class Wanted {
  constructor(state, sfx, hud) {
    this.state = state;   // shared game state (state.wanted is the star count)
    this.sfx = sfx;
    this.hud = hud;
    this.heat = 0;
    this.sightT = PURSUIT_TIMEOUT; // time since a cop was last within sightRange
    this.lastStars = 0;
    this.crimeCount = 0;
    this.escaped = false;
  }

  // Register a crime. amount is optional multiplier (e.g. spree).
  crime(kind, amount = 1) {
    const add = (CRIME_HEAT[kind] ?? 40) * amount;
    this.heat += add;
    this.crimeCount += amount;
    this.sightT = PURSUIT_TIMEOUT;
    this._syncStars(true);
  }

  // Missions call this: committing the job raises a fixed floor of heat.
  missionHeat(stars) {
    const target = Math.min(POLICE.maxWanted, stars) * 100;
    if (this.heat < target) {
      this.heat = target;
      this._syncStars(true);
    }
  }

  // Bribe / garage / mission handoff: clears heat entirely.
  clear(reason = '') {
    if (this.heat <= 0) return;
    this.heat = 0;
    this.state.wanted = 0;
    this.sightT = PURSUIT_TIMEOUT;
    this.escaped = reason === 'escape';
    if (this.hud) this.hud.toast(reason === 'escape' ? 'You lost the heat.' : 'Heat cleared.');
  }

  stars() {
    let s = 0;
    for (const t of STAR_THRESHOLDS) if (this.heat >= t) s++;
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
    } else if (next < prev && announce) {
      if (this.hud) this.hud.toast(next > 0 ? `Heat cooling — ${'★'.repeat(next)}` : 'Clean.');
    }
  }

  // Per-frame: track whether cops still have sight, decay heat when they don't.
  update(dt, player, police, inCar) {
    // Line-of-sight proxy: any live cop within sightRange keeps the timer hot.
    let seen = false;
    for (const u of police.units) {
      if (u.dead) continue;
      const d = Math.hypot(u.x - player.x, u.z - player.z);
      if (d < POLICE.sightRange) { seen = true; break; }
    }
    if (seen) {
      this.sightT = PURSUIT_TIMEOUT;
      // Evading at speed stretches the decay timer slightly: fast getaways feel earned.
      if (inCar) this.sightT += 4;
      this.escaped = false;
    } else {
      this.sightT -= dt;
    }

    if (this.heat > 0 && this.sightT <= 0) {
      this.heat = Math.max(0, this.heat - DECAY_PER_SEC * dt);
      const before = this.state.wanted;
      this._syncStars(this.stars() !== before);
      if (this.heat <= 0 && !this.escaped) this.clear('escape');
    }

    // despawnCooldown bookkeeping mirrors main.js semantics.
    if (this.state.wanted > 0) {
      this.state.wantedCooldown -= dt;
    }
  }

  // HUD: percent progress toward the next star (for a heat bar), clamped to [0, 1].
  heatRatio() {
    const s = this.stars();
    if (s >= POLICE.maxWanted) return 1;
    const cur = s === 0 ? 0 : STAR_THRESHOLDS[s - 1];
    const next = STAR_THRESHOLDS[s];
    const r = (this.heat - cur) / (next - cur);
    return Math.max(0, Math.min(1, r));
  }
}
