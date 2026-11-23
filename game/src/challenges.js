// challenges.js — the dynamic challenge board. Three slots run at once (stunt
// combo, precision stop, coastal tour) and each rotates independently: finish
// one or let its clock die and the slot cools down, then rolls a fresh variant
// of its kind from the road grid. A cross-slot streak multiplier grows every
// payout while the board stays hot; any expiry wipes it.
//
// Constraints this module honours on purpose:
// - No THREE, no scene graph. Targets are HUD-declared coordinates (the widget
//   shows live distance readouts), so a plain-node smoke harness can drive
//   every path and the module can never touch the renderer.
// - No draws from the shared rng stream. Slot rolls come from a local
//   generator seeded by the world seed plus a per-slot rotation counter, so
//   boot's stream order (city -> traffic -> ... -> economy) is untouched.
// - Cash leaves through economy.addCredits only; this module never writes
//   state.money. Persistence rides the loop autosave via saveData() (an
//   additive key, so old readers of the save ignore it safely) and is restored
//   from loadSave() at construction — the streak survives reloads.

import { loadSave } from './save.js';

// Streak economy: computed before a finish is counted, so the very first
// clearance pays base value and each consecutive one steps up to the cap.
const STREAK_STEP = 0.2;
const STREAK_CAP = 3;
const STREAK_MAX_SAVED = 20;   // junk guards on the restored counter

// Seconds a slot sits empty between one roll expiring/finishing and the next.
const ROTATE_COOLDOWN = 5;

// Per-kind tuning lives inline on the slot defs so rebalancing is one table.
const SLOT_DEFS = [
  {
    id: 'stunt', title: 'STUNT COMBO',
    hint: 'sustain speed to build combo',
    payout: 320, duration: 45,
    speedFloor: 22,     // m/s (~79 km/h) at or above which combo accrues
    comboTarget: 100,
    comboRate: 14,      // combo points per second at/above the floor
    decayRate: 11,      // points per second bled below the floor
  },
  {
    id: 'precision', title: 'PRECISION STOP',
    hint: 'stop inside the marked zone',
    payout: 260, duration: 60,
    zoneRadius: 9,      // metres around the zone centre that counts
    stopSpeed: 1.5,     // m/s — slower than this reads as "stopped"
    holdTime: 1.6,      // seconds parked inside the zone to clear it
    decayRate: 2,       // hold bleeds off twice as fast as it builds
  },
  {
    id: 'tour', title: 'COASTAL TOUR',
    hint: 'hit every checkpoint in order',
    payout: 480, duration: 100,
    cpCount: 4,
    cpRadius: 12,
  },
];

// Small xorshift-style generator, independent of config.makeRng on purpose:
// challenge rolls must never perturb the shared stream the city, traffic and
// peds are sequenced on.
function slotRandom(worldSeed, slotIndex, rotation) {
  let s = (worldSeed ^ Math.imul(slotIndex + 1, 2654435761) ^ Math.imul(rotation + 7, 40503)) >>> 0;
  if (!s) s = 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export class Challenges {
  constructor(w) {
    this.w = w;
    this.city = w.city;
    this.seed = Number(w.seed) || 1;
    this.turns = [0, 0, 0];
    this.streak = 0;
    this.bestStreak = 0;
    this._loadStreak();
    this.slots = SLOT_DEFS.map((def, i) => this._dealSlot(def, i));
    this._cache = { streak: '', rows: ['', '', ''], shown: null };
    this._buildWidget();
  }

  multiplier() { return Math.min(STREAK_CAP, 1 + this.streak * STREAK_STEP); }

  // Streak survives reloads through the main save (read-only here; the write
  // side is the loop's autosave merging saveData()).
  _loadStreak() {
    const saved = loadSave();
    const c = saved && saved.challenges;
    if (c && Number.isFinite(c.streak)) this.streak = Math.max(0, Math.min(STREAK_MAX_SAVED, Math.floor(c.streak)));
    if (c && Number.isFinite(c.bestStreak)) this.bestStreak = Math.max(0, Math.min(STREAK_MAX_SAVED, Math.floor(c.bestStreak)));
    if (this.bestStreak < this.streak) this.bestStreak = this.streak;
  }

  // Persisted slice merged into the loop's writeSave call. Additive shape: the
  // schema version stays put because every reader (old and new) ignores keys
  // it does not know.
  saveData() {
    return { challenges: { streak: this.streak, bestStreak: this.bestStreak } };
  }

  // Snap a target onto the road grid the same way the shops and side jobs do:
  // pick a road line, then a coordinate along it, inside the playable half.
  _snapToRoad(rng) {
    const lines = (this.city && this.city.roadLines) || [];
    if (!lines.length) return { x: 0, z: 0 };
    const lane = lines[Math.floor(rng() * lines.length) % lines.length];
    const half = ((this.city && this.city.half) || 400) * 0.78;
    const along = (rng() * 2 - 1) * half;
    return lane.axis === 'z' ? { x: lane.line, z: along } : { x: along, z: lane.line };
  }

  _dealSlot(def, slotIndex) {
    this.turns[slotIndex] += 1;
    const rng = slotRandom(this.seed, slotIndex, this.turns[slotIndex]);
    const slot = {
      def, index: slotIndex,
      state: 'active',      // active | cooldown
      timer: def.duration,
      cooldown: 0,
      combo: 0,             // stunt
      hold: 0,              // precision
      zone: null, cps: null, cpIndex: 0, dist: 0,
    };
    if (def.id === 'precision') slot.zone = this._snapToRoad(rng);
    if (def.id === 'tour') {
      slot.cps = [];
      for (let i = 0; i < def.cpCount; i++) slot.cps.push(this._snapToRoad(rng));
    }
    return slot;
  }

  // Per-frame step, wired beside the mission/side-job updates in the loop.
  // body is the frame's player reference (the ped on foot, the vehicle in a
  // car); ctx carries what the widget and speed checks need.
  update(dt, body, ctx) {
    const inCar = !!(ctx && ctx.inCar);
    const speed = inCar && body ? Math.abs(body.speed || 0) : 0;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot.state === 'cooldown') {
        slot.cooldown -= dt;
        if (slot.cooldown <= 0) this.slots[i] = this._dealSlot(slot.def, i);
        continue;
      }
      slot.timer -= dt;
      if (slot.timer <= 0) { this._expire(slot); continue; }
      switch (slot.def.id) {
        case 'stunt': this._stepStunt(slot, speed, dt); break;
        case 'precision': this._stepPrecision(slot, body, inCar, speed, dt); break;
        case 'tour': this._stepTour(slot, body); break;
      }
    }
    this._syncWidget();
  }

  _stepStunt(slot, speed, dt) {
    if (speed >= slot.def.speedFloor) {
      slot.combo = Math.min(slot.def.comboTarget, slot.combo + slot.def.comboRate * dt);
    } else {
      slot.combo = Math.max(0, slot.combo - slot.def.decayRate * dt);
    }
    if (slot.combo >= slot.def.comboTarget) this._complete(slot);
  }

  _stepPrecision(slot, body, inCar, speed, dt) {
    if (!slot.zone) return;
    slot.dist = Math.hypot(body.x - slot.zone.x, body.z - slot.zone.z);
    if (inCar && slot.dist <= slot.def.zoneRadius && speed <= slot.def.stopSpeed) {
      slot.hold += dt;
      if (slot.hold >= slot.def.holdTime) this._complete(slot);
    } else {
      slot.hold = Math.max(0, slot.hold - slot.def.decayRate * dt);
    }
  }

  _stepTour(slot, body) {
    if (!slot.cps || slot.cpIndex >= slot.cps.length) return;
    const cp = slot.cps[slot.cpIndex];
    slot.dist = Math.hypot(body.x - cp.x, body.z - cp.z);
    if (slot.dist <= slot.def.cpRadius) {
      slot.cpIndex += 1;
      if (this.w.hud) {
        this.w.hud.toast(`Tour checkpoint ${slot.cpIndex}/${slot.cps.length}`, 2);
      }
      if (slot.cpIndex >= slot.cps.length) this._complete(slot);
    }
  }

  _complete(slot) {
    const w = this.w;
    const mult = this.multiplier();          // counted before the finish lands
    const payout = Math.round(slot.def.payout * mult);
    this.streak += 1;
    if (this.streak > this.bestStreak) this.bestStreak = this.streak;
    if (w.economy) w.economy.addCredits(payout, `${slot.def.title} cleared ×${this.streak}`, w.hud);
    this._retireSlot(slot);
  }

  _expire(slot) {
    if (this.streak > 0) {
      this.streak = 0;
      if (this.w.hud) this.w.hud.toast(`${slot.def.title} expired — streak lost`, 3);
    }
    this._retireSlot(slot);
  }

  _retireSlot(slot) {
    slot.state = 'cooldown';
    slot.cooldown = ROTATE_COOLDOWN;
    slot.timer = 0;
    slot.combo = 0;
    slot.hold = 0;
    slot.cpIndex = 0;
    slot.dist = 0;
  }

  // Widget: a fixed panel under the cash block, one row per slot. Every text
  // write goes through a dirty cache like hud.js — a steady frame touches no
  // DOM node. Visible only once play started (start overlay gone) and hidden
  // while photo mode parks it.
  _buildWidget() {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'vh-challenges';
    el.style.cssText = 'position:fixed;top:136px;right:16px;width:226px;display:none;pointer-events:none;' +
      "font-family:'Segoe UI',system-ui,sans-serif;color:#eef2ff;text-shadow:0 2px 4px #000000a6;";
    el.insertAdjacentHTML('beforeend', `
      <div style="background:#0b0e14d9;border:1px solid #ffffff1f;border-radius:10px;padding:8px 12px;
        box-shadow:0 6px 18px #00000059;">
        <div style="font-size:11px;letter-spacing:2px;color:#9fb0d8;">CHALLENGE BOARD</div>
        <div data-ref="streak" style="font-size:13px;color:#ffd76e;font-variant-numeric:tabular-nums;"></div>
      </div>`);
    this._rows = SLOT_DEFS.map((def) => {
      const card = document.createElement('div');
      card.style.cssText = 'background:#0b0e14d9;border:1px solid #ffffff1f;border-radius:10px;padding:6px 12px;' +
        'margin-top:5px;box-shadow:0 6px 18px #00000059;';
      card.insertAdjacentHTML('beforeend', `
        <div style="font-size:12px;font-weight:700;letter-spacing:1.2px;color:#7fd4ff;">${def.title}</div>
        <div data-ref="row" style="font-size:11px;color:#cbd5f5;font-variant-numeric:tabular-nums;"></div>`);
      el.appendChild(card);
      return card.querySelector('[data-ref="row"]');
    });
    this._streakLine = el.querySelector('[data-ref="streak"]');
    document.body.appendChild(el);
    this._panel = el;
  }

  _syncWidget() {
    const panel = this._panel;
    if (!panel) return;
    const w = this.w;
    const started = !!w.running && !!(w.overlay && w.overlay.hidden);
    const shown = started && !(w.photoMode && w.photoMode.active);
    if (this._cache.shown !== shown) {
      this._cache.shown = shown;
      panel.style.display = shown ? 'block' : 'none';
    }
    if (!shown) return;

    const streakText = `${this.streak} hot · next payout ×${this.multiplier().toFixed(2)} (best ${this.bestStreak})`;
    if (streakText !== this._cache.streak) {
      this._cache.streak = streakText;
      this._streakLine.textContent = streakText;
    }
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      let text;
      if (slot.state === 'cooldown') {
        text = `next in ${Math.max(0, Math.ceil(slot.cooldown))}s`;
      } else {
        const secs = `⏱ ${Math.max(0, Math.ceil(slot.timer))}s`;
        if (slot.def.id === 'stunt') {
          text = `combo ${Math.round(slot.combo)}/${slot.def.comboTarget} · ${secs}`;
        } else if (slot.def.id === 'precision') {
          text = `hold ${Math.round((slot.hold / slot.def.holdTime) * 100)}% · ${Math.round(slot.dist)}m · ${secs}`;
        } else {
          text = `CP ${Math.min(slot.cpIndex + 1, slot.cps.length)}/${slot.cps.length} · ${Math.round(slot.dist)}m · ${secs}`;
        }
      }
      if (text !== this._cache.rows[i]) {
        this._cache.rows[i] = text;
        this._rows[i].textContent = text;
      }
    }
  }
}
