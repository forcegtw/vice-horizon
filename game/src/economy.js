// economy.js — cash, gas-station pit stops and vehicle upgrades.
//
// Gas stations are canopy + pump props planted on spread street corners,
// derived from the road-line list so the layout follows whatever grid the
// city builds (no hardcoded coordinates). Stopping inside a station opens
// the shop menu — drive-through in a car, walk-up on foot — and purchases
// persist in their own localStorage ledger beside the main save.
//
// Design rules this module keeps:
//   - The economy owns money flow and its own storage key. Mission rewards
//     may still credit state.money directly (bind() mirrors it here), and
//     save merges read the same field, so the two can never disagree on boot.
//   - Every credited or spent amount passes a finite-number guard, so a bad
//     value from a future data-driven table cannot corrupt the ledger.
//   - MENU_PRICES and the buy() switch are two views of one truth: the menu
//     text is assembled from the table, so the two can never drift apart.

import * as THREE from '../vendor/three.min.js';
import { PLAYER, UPGRADE_HINTS } from './config.js';

// Ledger key — save.js wipes the same string in clearSave(); keep both in step.
const LEDGER_KEY = 'vice-horizon-economy-v1';

// Shop menu's price list, in dollars. Key order matches the hotkeys of buy()
// (B health, N armor, V speed, C plating) so the menu reads left-to-right in
// the same order the keys sit on the keyboard.
const MENU_PRICES = Object.freeze({
  health: 150,     // full heal at a gas station
  armor: 400,      // full armor refill
  speed: 2500,     // permanent engine tune (one-time)
  plating: 1800,   // permanent armor upgrade (one-time)
});

// What each permanent upgrade grants once bought.
export const UPGRADES = Object.freeze({
  speedBonus: 0.18,   // +18% top speed with the engine tune
  armorBonus: 50,     // extra armor capacity with plating
});

// Station placement: fractions along the road-line list, so three stops land
// near the map's west end, middle and east end regardless of grid size.
const SITE_SPREAD = Object.freeze([0.12, 0.5, 0.86]);
const LOT_OFFSET = 6;      // metres a stop sits off the roadway, on the lot
const MENU_TOAST_SECONDS = 30;  // shop menu lingers until replaced or left

export class Economy {
  constructor(scene, city, rng) {
    this.scene = scene;
    this.city = city;
    this.rng = rng;
    this._cash = 0;
    this._state = null;
    this.upgrades = { speed: false, plating: false };
    this.shops = [];           // [{ x, z, mesh }]
    this.insideShop = null;
    this.menuOpen = false;
    this._menuDirty = false;   // set after a purchase so the offer refreshes
    this.msg = '';
    this.msgT = 0;
    this.shopRadius = 8;       // metres from a canopy that counts as "there"
    this._stationCount = 3;    // stations planted per city grid

    this._load();
    this._buildStops();
  }

  // Cash truth lives in state.money once bound; before that (boot, ?shot=
  // staging) the local mirror answers so nothing ever reads undefined.
  get money() { return this._state ? this._state.money : this._cash; }
  set money(v) {
    if (this._state) this._state.money = v;
    else this._cash = v;
  }

  // Bind to the shared game state. A save already sitting in state wins over
  // the economy mirror, so mission progress and cash never disagree on boot.
  bind(state) {
    this._state = state;
    if (!state.money && this._cash > 0) state.money = this._cash;
    this._cash = state.money;
  }

  // Ledger restore. Storage may be missing entirely (node smoke runs) or
  // hold corrupt JSON — either way the catch starts us fresh.
  _load() {
    try {
      const raw = localStorage.getItem(LEDGER_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (typeof data.money === 'number' && Number.isFinite(data.money)) {
        this._cash = data.money;
      }
      if (data.upgrades) {
        this.upgrades.speed = !!data.upgrades.speed;
        this.upgrades.plating = !!data.upgrades.plating;
      }
    } catch {
      /* corrupt or unavailable storage: start fresh */
    }
  }

  persist() {
    try {
      localStorage.setItem(LEDGER_KEY, JSON.stringify({
        money: this.money,
        upgrades: this.upgrades,
      }));
    } catch {
      /* best-effort: private mode or quota */
    }
  }

  // Stations: spread corners derived from the road-line list. The "along"
  // coordinate for each stop is stolen from the next pick in the list, which
  // keeps the three props apart without any hand-tuned coordinates.
  _buildStops() {
    const lines = this.city.roadLines;
    if (!lines || !lines.length) return;
    const picks = SITE_SPREAD.slice(0, this._stationCount);
    for (let i = 0; i < picks.length; i++) {
      const lane = lines[Math.floor(picks[i] * lines.length)];
      const along = (picks[(i + 1) % picks.length] - 0.5) * 2 * this.city.half * 0.75;
      const x = lane.axis === 'z' ? lane.line + LOT_OFFSET : along;
      const z = lane.axis === 'z' ? along : lane.line + LOT_OFFSET;
      this.shops.push(this._buildStop(x, z));
    }
  }

  // One station: lit canopy slab on four posts, a pump with a glowing band.
  _buildStop(x, z) {
    const g = new THREE.Group();
    const canopy = new THREE.Mesh(
      new THREE.BoxGeometry(10, 0.4, 8),
      new THREE.MeshStandardMaterial({
        color: 0xd23a3a,
        roughness: 0.5,
        metalness: 0.3,
        emissive: 0x551111,
        emissiveIntensity: 0.5,
      })
    );
    canopy.position.y = 4.6;
    canopy.castShadow = true;
    g.add(canopy);

    const postMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.7 });
    for (const [px, pz] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.6, 0.4), postMat);
      post.position.set(px, 2.3, pz);
      g.add(post);
    }

    const pump = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.6, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.6 })
    );
    pump.position.set(1.6, 0.8, 0);
    g.add(pump);

    const band = new THREE.Mesh(
      new THREE.BoxGeometry(0.94, 0.3, 0.74),
      new THREE.MeshBasicMaterial({ color: 0x7ee08a })
    );
    band.position.set(1.6, 1.3, 0);
    g.add(band);

    g.position.set(x, 0, z);
    this.scene.add(g);
    return { x, z, mesh: g };
  }

  // Per-frame shop proximity. The menu toast opens on entry, refreshes only
  // after a purchase (so bought lines drop out immediately) and closes with
  // a short farewell once the player walks off.
  update(dt, player, inCar, playerCar, hud) {
    if (this.msgT > 0) this.msgT -= dt;
    const px = inCar ? playerCar.x : player.x;
    const pz = inCar ? playerCar.z : player.z;

    let near = null;
    for (const s of this.shops) {
      if (Math.hypot(s.x - px, s.z - pz) < this.shopRadius) {
        near = s;
        break;
      }
    }
    this.insideShop = near;

    if (near && !this.menuOpen) {
      this.menuOpen = true;
      this._menuDirty = false;
      hud.toast(this._menuText(), MENU_TOAST_SECONDS);
    } else if (near && this.menuOpen && this._menuDirty) {
      this._menuDirty = false;
      hud.toast(this._menuText(), MENU_TOAST_SECONDS);
    } else if (!near && this.menuOpen) {
      this.menuOpen = false;
      hud.toast('Left the station.', 2);
    }
  }

  // Shop menu text, assembled from MENU_PRICES so keys and prices stay in
  // lockstep; already-owned upgrades drop out of the list.
  _menuText() {
    const u = this.upgrades;
    const p = MENU_PRICES;
    return 'GAS STATION — B buy health $' + p.health +
      ' · N buy armor $' + p.armor +
      (u.speed ? '' : ' · V engine tune $' + p.speed) +
      (u.plating ? '' : ' · C plating $' + p.plating);
  }

  // Shop hotkeys, called from the main loop on B / N / V / C taps. Returns
  // true when the tap was handled (even for "already full" no-ops, so the
  // key never falls through to other bindings), false when ignored.
  buy(item, player, hud, sfx) {
    if (!this.insideShop) return false;
    const spend = (cost) => {
      if (!Number.isFinite(cost) || cost < 0) return false;
      if (this.money < cost) {
        hud.toast('Not enough cash.', 2);
        return false;
      }
      this.money -= cost;
      return true;
    };

    let ok = false;
    switch (item) {
      case 'health':
        if (player.health >= PLAYER.maxHealth) {
          hud.toast('Health already full.', 2);
          return true;
        }
        ok = spend(MENU_PRICES.health);
        if (ok) {
          player.health = PLAYER.maxHealth;
          hud.toast('Patched up.', 2);
        }
        break;
      case 'armor':
        ok = spend(MENU_PRICES.armor);
        if (ok) {
          player.armor = this.armorCap();
          hud.toast('Armor fitted.', 2);
        }
        break;
      case 'speed':
        if (this.upgrades.speed) {
          hud.toast('Engine already tuned.', 2);
          return true;
        }
        ok = spend(MENU_PRICES.speed);
        if (ok) {
          this.upgrades.speed = true;
          hud.toast(UPGRADE_HINTS.speed, 3);
        }
        break;
      case 'plating':
        if (this.upgrades.plating) {
          hud.toast('Already plated.', 2);
          return true;
        }
        ok = spend(MENU_PRICES.plating);
        if (ok) {
          this.upgrades.plating = true;
          hud.toast(UPGRADE_HINTS.plating, 3);
        }
        break;
      default:
        return false;
    }

    if (ok) {
      sfx.cash();
      this.persist();
      this._menuDirty = true;
    }
    return true;
  }

  // Top-speed multiplier applied to the player's car in main.js drive calls.
  // Only the forward cap scales; reverse and braking stay stock.
  speedMultiplier() {
    return this.upgrades.speed ? 1 + UPGRADES.speedBonus : 1;
  }

  // Armor ceiling above the base max (plating raises it).
  armorCap() { return PLAYER.maxArmor + (this.upgrades.plating ? UPGRADES.armorBonus : 0); }

  // Mission rewards / pickups credit here so persistence stays in one place.
  // Zero, negative and non-finite payouts are silent no-ops, never corruption.
  credit(amount, hud) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.money += amount;
    this.persist();
    if (hud) hud.toast(`+$${amount}`, 2);
  }

  message(text, seconds = 3) {
    this.msg = text;
    this.msgT = seconds;
  }
}
