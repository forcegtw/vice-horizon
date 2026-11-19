// economy.js — cash, gas-station shop stops and vehicle upgrades for Vice
// Horizon. Gas stations are canopy + pump props planted on spread street
// corners; stopping inside one opens the shop menu (drive-through in a car,
// walk-up on foot). Purchases and cash persist in their own localStorage key
// alongside the main save.
//
// Design rules:
//   - Economy owns money flow and its own storage key. Mission rewards may
//     still credit state.money directly (Economy.bind() mirrors it here), and
//     save merges read the same field, so the two can never disagree after bind.
//   - Every credited/spent amount passes a finite-number guard so a bad value
//     from a future data-driven table cannot corrupt the ledger.
//   - PRICES and UPGRADES are the single source of truth for both the shop
//     menu text and the buy() switch; change one, not the other.

import * as THREE from '../vendor/three.min.js';
import { PLAYER, UPGRADE_HINTS } from './config.js';

const ECO_KEY = 'vice-horizon-economy-v1';

const PRICES = {
  health: 150,     // full heal at a gas station
  armor: 400,      // full armor refill
  speed: 2500,     // permanent engine tune (one-time)
  plating: 1800,   // permanent armor upgrade (one-time)
};

export const UPGRADES = {
  speedBonus: 0.18,   // +18% top speed with the engine tune
  armorBonus: 50,     // extra armor capacity with plating
};

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
    this._menuDirty = false;   // set after a purchase so the offer refreshes in place
    this.msg = '';
    this.msgT = 0;
    this.shopRadius = 8;       // metres from a canopy that counts as "at the station"

    this._load();
    this._buildStations();
  }

  // Cash source of truth is state.money once bound; before that (boot,
  // ?shot= staging) the local mirror answers so nothing reads undefined.
  get money() { return this._state ? this._state.money : this._cash; }
  set money(v) {
    if (this._state) this._state.money = v;
    else this._cash = v;
  }

  // Bind to the shared game state. A save already in state wins over the
  // economy mirror, so mission progress and cash never disagree on boot.
  bind(state) {
    this._state = state;
    if (!state.money && this._cash > 0) state.money = this._cash;
    this._cash = state.money;
  }

  _load() {
    try {
      const raw = localStorage.getItem(ECO_KEY);
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
      localStorage.setItem(ECO_KEY, JSON.stringify({
        money: this.money,
        upgrades: this.upgrades,
      }));
    } catch {
      /* best-effort: private mode or quota */
    }
  }

  // Gas stations: three spread corners, derived from the road-line list so the
  // layout follows whatever grid the city builds (no hardcoded coordinates).
  _buildStations() {
    const lines = this.city.roadLines;
    if (!lines || !lines.length) return;
    const picks = [0.12, 0.5, 0.86];
    for (let i = 0; i < picks.length; i++) {
      const lane = lines[Math.floor(picks[i] * lines.length)];
      const along = (picks[(i + 1) % picks.length] - 0.5) * 2 * this.city.half * 0.75;
      const x = lane.axis === 'z' ? lane.line + 6 : along;
      const z = lane.axis === 'z' ? along : lane.line + 6;
      this.shops.push(this._makeStation(x, z));
    }
  }

  // One station: lit canopy slab on four posts, a pump with a glowing band.
  _makeStation(x, z) {
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
  // after a purchase (so bought lines drop out immediately) and closes with a
  // short farewell when the player walks off.
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
      hud.toast(this._menuText(), 30);
    } else if (near && this.menuOpen && this._menuDirty) {
      this._menuDirty = false;
      hud.toast(this._menuText(), 30);
    } else if (!near && this.menuOpen) {
      this.menuOpen = false;
      hud.toast('Left the station.', 2);
    }
  }

  // Shop menu text. Keys and prices are assembled from PRICES so the two stay
  // in lockstep; already-owned upgrades drop out of the list.
  _menuText() {
    const u = this.upgrades;
    const p = PRICES;
    return 'GAS STATION — B buy health $' + p.health +
      ' · N buy armor $' + p.armor +
      (u.speed ? '' : ' · V engine tune $' + p.speed) +
      (u.plating ? '' : ' · C plating $' + p.plating);
  }

  // Shop hotkeys, called from the main loop when the player taps B/N/V/C.
  // Returns true when the tap was handled (even for "already full" no-ops, so
  // the key doesn't fall through to other bindings), false when ignored.
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
        ok = spend(PRICES.health);
        if (ok) {
          player.health = PLAYER.maxHealth;
          hud.toast('Patched up.', 2);
        }
        break;
      case 'armor':
        ok = spend(PRICES.armor);
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
        ok = spend(PRICES.speed);
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
        ok = spend(PRICES.plating);
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
  speedMultiplier() { return this.upgrades.speed ? 1 + UPGRADES.speedBonus : 1; }

  // Extra armor capacity above the base max (plating raises the ceiling).
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
