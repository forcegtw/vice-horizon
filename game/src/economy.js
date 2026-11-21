// economy.js — the till. Owns cash (mirrored onto state.money once bound),
// three gas-station shop stops planted on street corners, and the two vehicle
// upgrades that persist under a private localStorage key, so wiping the mission
// save never zeroes a tuned engine.
// Money rule: mission rewards credit state.money directly; this module only
// moves money at the shop, and the save merge happens at bind() time — a save
// already living in state wins over the stored ledger mirror.
// Gas stations get canopy + pump props here; stopping inside the radius opens
// the shop menu, and the offer toast refreshes in place after a purchase.

import * as THREE from '../vendor/three.min.js';
import { PLAYER, UPGRADE_HINTS } from './config.js';

const LEDGER_KEY = 'vice-horizon-economy-v1';

const PRICES = {
  health: 150,     // full heal at the pumps
  armor: 400,      // full armor refill
  speed: 2500,     // one-time engine tune
  plating: 1800,   // one-time armor capacity upgrade
};

export const UPGRADES = {
  speedBonus: 0.18,   // top-speed multiplier from the engine tune
  armorBonus: 50,     // extra armor capacity from plating
};

const MENU_HOLD = 30;      // seconds the station menu toast stays up
const LEFT_HOLD = 2;       // seconds the "left the station" note stays up
const CURB_OFFSET = 6;     // metres a station sits off the street centre line

export class Economy {
  constructor(scene, city, rng) {
    this.scene = scene;
    this.city = city;
    this.rng = rng;
    this._cash = 0;            // ledger mirror until bind() hands over to state
    this._state = null;
    this.upgrades = { speed: false, plating: false };
    this.shops = [];           // { x, z, mesh }
    this.insideShop = null;
    this.menuOpen = false;
    this._menuDirty = false;   // a purchase landed; the offer needs a refresh
    this.msg = '';
    this.msgT = 0;
    this.shopRadius = 8;       // metres from a canopy that counts as "at the pumps"

    this._load();
    this._buildStations();
  }

  // Single source of truth for cash is state.money once bound; before that
  // (boot, ?shot= staging) the local mirror answers so nothing reads undefined.
  get money() {
    return this._state ? this._state.money : this._cash;
  }

  set money(v) {
    if (this._state) this._state.money = v;
    else this._cash = v;
  }

  bind(state) {
    this._state = state;
    if (!state.money && this._cash > 0) state.money = this._cash;
    this._cash = state.money;
  }

  _load() {
    try {
      const raw = localStorage.getItem(LEDGER_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (typeof data.money === 'number') this._cash = data.money;
      if (data.upgrades) {
        this.upgrades.speed = !!data.upgrades.speed;
        this.upgrades.plating = !!data.upgrades.plating;
      }
    } catch {
      // Corrupt entry or no storage (node smoke runs here too): start fresh.
    }
  }

  persist() {
    try {
      localStorage.setItem(LEDGER_KEY, JSON.stringify({
        money: this.money,
        upgrades: this.upgrades,
      }));
    } catch {
      // Best effort — losing one save beat is acceptable.
    }
  }

  // Three stations on spread corners: one toward each end of the grid, one mid.
  _buildStations() {
    const lines = this.city.roadLines;
    if (!lines || !lines.length) return;
    const picks = [0.12, 0.5, 0.86];
    for (let i = 0; i < picks.length; i++) {
      const lane = lines[Math.floor(picks[i] * lines.length)];
      const along = (picks[(i + 1) % picks.length] - 0.5) * 2 * this.city.half * 0.75;
      const x = lane.axis === 'z' ? lane.line + CURB_OFFSET : along;
      const z = lane.axis === 'z' ? along : lane.line + CURB_OFFSET;
      this.shops.push(this._makeStation(x, z));
    }
  }

  _makeStation(x, z) {
    const kiosk = new THREE.Group();
    // Canopy: flat slab on posts, emissive edge so it reads at night.
    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0xd23a3a,
      roughness: 0.5,
      metalness: 0.3,
      emissive: 0x551111,
      emissiveIntensity: 0.5,
    });
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(10, 0.4, 8), canopyMat);
    canopy.position.y = 4.6;
    canopy.castShadow = true;
    kiosk.add(canopy);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.7 });
    for (const [px, pz] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.6, 0.4), postMat);
      post.position.set(px, 2.3, pz);
      kiosk.add(post);
    }
    // Pump: small box with a glowing status band.
    const pump = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 1.6, 0.7),
      new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.6 }),
    );
    pump.position.set(1.6, 0.8, 0);
    kiosk.add(pump);
    const band = new THREE.Mesh(
      new THREE.BoxGeometry(0.94, 0.3, 0.74),
      new THREE.MeshBasicMaterial({ color: 0x7ee08a }),
    );
    band.position.set(1.6, 1.3, 0);
    kiosk.add(band);
    kiosk.position.set(x, 0, z);
    this.scene.add(kiosk);
    return { x, z, mesh: kiosk };
  }

  // Per-frame: shop proximity. Drive-through in a car, walk-up on foot — the
  // focus point follows whichever body the player currently is.
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
      hud.toast(this._menuText(), MENU_HOLD);
    } else if (near && this.menuOpen && this._menuDirty) {
      // Refresh only after a purchase: the bought line drops out of the menu
      // at once instead of lingering until the player leaves and returns.
      this._menuDirty = false;
      hud.toast(this._menuText(), MENU_HOLD);
    } else if (!near && this.menuOpen) {
      this.menuOpen = false;
      hud.toast('Left the station.', LEFT_HOLD);
    }
  }

  // Price strings interpolate PRICES so the menu and the till never disagree.
  _menuText() {
    const u = this.upgrades;
    let text = `GAS STATION — B buy health $${PRICES.health} · N buy armor $${PRICES.armor}`;
    if (!u.speed) text += ` · V engine tune $${PRICES.speed}`;
    if (!u.plating) text += ` · C plating $${PRICES.plating}`;
    return text;
  }

  // Shop hotkeys, called from the main loop when input.tapped fires.
  buy(item, player, hud, sfx) {
    if (!this.insideShop) return false;
    let ok = false;
    switch (item) {
      case 'health':
        if (player.health >= PLAYER.maxHealth) {
          hud.toast('Health already full.', 2);
          return true;
        }
        ok = this._charge(PRICES.health, hud);
        if (ok) {
          player.health = PLAYER.maxHealth;
          hud.toast('Patched up.', 2);
        }
        break;
      case 'armor':
        ok = this._charge(PRICES.armor, hud);
        if (ok) {
          player.armor = PLAYER.maxArmor + (this.upgrades.plating ? UPGRADES.armorBonus : 0);
          hud.toast('Armor fitted.', 2);
        }
        break;
      case 'speed':
        if (this.upgrades.speed) {
          hud.toast('Engine already tuned.', 2);
          return true;
        }
        ok = this._charge(PRICES.speed, hud);
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
        ok = this._charge(PRICES.plating, hud);
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

  // Till guard: prices are static today, but a future data-driven table must
  // never brick the ledger or let NaN walk through.
  _charge(cost, hud) {
    if (!Number.isFinite(cost) || cost < 0) return false;
    if (this.money < cost) {
      hud.toast('Not enough cash.', 2);
      return false;
    }
    this.money -= cost;
    return true;
  }

  // Top-speed multiplier applied to the player's car in main.js drive calls.
  speedMultiplier() {
    return this.upgrades.speed ? 1 + UPGRADES.speedBonus : 1;
  }

  // Extra armor capacity above PLAYER.maxArmor.
  armorCap() {
    return PLAYER.maxArmor + (this.upgrades.plating ? UPGRADES.armorBonus : 0);
  }

  // Mission rewards / pickups credit here so persistence stays in one place.
  // Non-finite or zero/negative payouts are no-ops and never touch the ledger.
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
