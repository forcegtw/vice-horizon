// wanted.js — police heat: numeric heat, star escalation, pursuit tracking
// and decay. The star counter lives in shared game state (state.wanted); this
// module owns the underlying heat value and the timers that raise and bleed it.
//
// Contract with the rest of the game:
//   - Crimes call Wanted.crime(kind, amount). Unknown kinds still add heat via
//     a generic fallback so a typo can never silently void a crime.
//   - Missions raise a floor with missionHeat(stars) or wipe it with clear().
//   - Respawn forgiveness / scripted events use setHeat() (no re-announcements).
//   - The main loop calls update(dt, player, police, inCar) once per frame.
//   - HUD reads state.wanted, heatRatio() for the bar, and toast messages.
//
// Star ladder: STAR_THRESHOLDS[n-1] heat buys star n. A full star is 100 heat
// by convention, so missionHeat(stars) uses stars * 100.

import { POLICE } from './config.js';

// Heat banked per crime. Robbing the law outranks robbing civilians.
const CRIME_HEAT = {
  carjack: 60,
  policeCarjack: 110,
  pedHit: 45,
  vehicleDestroyed: 55,
  gunshot: 25,
  copDestroyed: 90,
};
const UNKNOWN_CRIME_HEAT = 40;

const STAR_THRESHOLDS = [40, 110, 220, 360, 520];
const DECAY_PER_SEC = 6;       // heat bleed once the police lose sight
const PURSUIT_TIMEOUT = 14;    // seconds of no cops in sight before decay starts
const IN_CAR_BONUS = 4;        // extra sight seconds while driving: getaways feel earned
const FULL_STAR = 100;

export class Wanted {
  constructor(state, sfx, hud) {
    this.state = state;   // shared game state; state.wanted is the star count
    this.sfx = sfx;
    this.hud = hud;
    this.heat = 0;
    this.sightT = PURSUIT_TIMEOUT;
    this.crimeCount = 0;
    this.escaped = false;
  }

  // Register a crime. amount multiplies the base heat (spree helper); both the
  // kind lookup and the multiplier are guarded so bad data can't zero or
  // NaN the heat ledger.
  crime(kind, amount = 1) {
    const mult = Number.isFinite(amount) ? Math.max(0, amount) : 1;
    const add = Math.max(0, CRIME_HEAT[kind] ?? UNKNOWN_CRIME_HEAT) * mult;
    this.heat += add;
    this.crimeCount += mult;
    this.sightT = PURSUIT_TIMEOUT;
    this.escaped = false;
    this._syncStars(false);
  }

  // Mission commit: raise heat to a fixed floor without ever lowering it.
  missionHeat(stars) {
    const target = Math.min(POLICE.maxWanted, Math.max(0, stars)) * FULL_STAR;
    if (this.heat < target) {
      this.heat = target;
      this._syncStars(false);
    }
    this.sightT = PURSUIT_TIMEOUT;
  }

  // Bribe dot / garage / mission handoff: wipe everything.
  clear(reason = '') {
    this.heat = 0;
    this.state.wanted = 0;
    this.state.wantedCooldown = 0;
    this.sightT = PURSUIT_TIMEOUT;
    this.escaped = reason === 'escape';
    if (this.hud) {
      this.hud.toast(reason === 'escape' ? 'You lost the heat.' : 'Heat cleared.');
    }
  }

  // Direct writer (partial wipe on respawn, scripted drops). Never re-announces
  // a star the player still holds — that's what the announce flag guards.
  setHeat(v) {
    this.heat = Number.isFinite(v) ? Math.max(0, v) : 0;
    this._syncStars(false);
  }

  stars() {
    let s = 0;
    for (const t of STAR_THRESHOLDS) {
      if (this.heat >= t) s++;
      else break;
    }
    return Math.min(s, POLICE.maxWanted);
  }

  // Push the derived star count into state, announcing only genuine increases
  // (or decreases when announce is set) so toasts never spam on tiny decays.
  _syncStars(announce) {
    const prev = this.state.wanted;
    const next = this.stars();
    this.state.wanted = next;
    if (next > prev) {
      this.sfx.wantedUp();
      if (this.hud) this.hud.toast(`WANTED — ${'★'.repeat(next)}`);
      this.state.wantedCooldown = POLICE.despawnCooldown;
    } else if (next < prev && announce) {
      if (this.hud) {
        this.hud.toast(next > 0 ? `Heat cooling — ${'★'.repeat(next)}` : 'Clean.');
      }
    }
  }

  // Per-frame pursuit bookkeeping. A live cop inside sightRange keeps the
  // timer topped up; once it expires, heat bleeds and stars cool down.
  update(dt, player, police, inCar) {
    let seen = false;
    const units = (police && police.units) || [];
    for (const u of units) {
      if (u.dead) continue;
      if (Math.hypot(u.x - player.x, u.z - player.z) < POLICE.sightRange) {
        seen = true;
        break;
      }
    }
    if (seen) {
      this.sightT = PURSUIT_TIMEOUT;
      if (inCar) this.sightT += IN_CAR_BONUS;
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

    // Cooldown mirrors main.js semantics: ticks down only while wanted.
    if (this.state.wanted > 0 && this.state.wantedCooldown > 0) {
      this.state.wantedCooldown -= dt;
    }
  }

  // Progress toward the next star within the current band, clamped to [0, 1].
  // At max stars the bar reads full so an over-banked heat can't overflow it.
  heatRatio() {
    const s = this.stars();
    if (s >= POLICE.maxWanted) return 1;
    const cur = s === 0 ? 0 : STAR_THRESHOLDS[s - 1];
    const next = STAR_THRESHOLDS[s];
    const span = next - cur;
    if (span <= 0) return 1;
    return Math.max(0, Math.min(1, (this.heat - cur) / span));
  }
}
