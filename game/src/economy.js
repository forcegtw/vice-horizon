// economy.js — cash, gas-station shop stops, and the permanent vehicle
// upgrades that persist in localStorage alongside the main save. Three
// canopies (plus pump props, built here) sit on spread street corners, and
// pulling inside one — drive-through in a car, walk-up on foot — opens the
// shop menu; B / N / V / C spend.
//
// Pricing is delegated to pricing.js (price table, offer-board text, till
// guard); this class owns money flow and its own storage key. Mission
// rewards credit through credit() so persistence stays in one place, and
// bind() merges the persisted ledger into the shared game state, where a
// save already present wins over the mirror — mission progress and cash
// never disagree on boot.

import * as THREE from '../vendor/three.min.js';
import { PLAYER, UPGRADE_HINTS } from './config.js';
import { PRICES, priceCheck, menuTitle } from './pricing.js';

const ECO_KEY = 'vice-horizon-economy-v1';

const SHOP_RADIUS = 8;   // metres from a canopy that counts as "at the station"

export const UPGRADES = {
  speedBonus: 0.18,   // +18% top speed per engine tune
  armorBonus: 50,     // extra armor capacity per plating kit
};

export class Economy {
  constructor(scene, city, rng) {
    this.scene = scene;
    this.city = city;
    this.rng = rng;
    this._cash = 0;        // money mirror until bind() hands us the real state
    this._state = null;
    this.upgrades = { speed: false, plating: false };
    this.shops = [];       // {x, z, mesh}
    this.insideShop = null;
    this.menuOpen = false;
    this._menuDirty = false;   // set after a purchase so the offer refreshes in place
    this.msg = '';
    this.msgT = 0;
    this.shopRadius = SHOP_RADIUS;

    this._load();
    this._buildStations();
  }

  // Single source of truth for cash is state.money once bound; before that
  // (boot, ?shot= staging) the local mirror answers so nothing reads undefined.
  get money() { return this._state ? this._state.money : this._cash; }
  set money(v) {
    if (this._state) this._state.money = v;
    else this._cash = v;
  }

  // Bind to the shared game state.
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
      if (typeof data.money === 'number') this._cash = data.money;
      if (data.upgrades) {
        this.upgrades.speed = !!data.upgrades.speed;
        this.upgrades.plating = !!data.upgrades.plating;
      }
    } catch { /* corrupt entry: start fresh */ }
  }

  persist() {
    try {
      localStorage.setItem(ECO_KEY, JSON.stringify({
        money: this.money,
        upgrades: this.upgrades,
      }));
    } catch { /* best-effort */ }
  }

  // Gas stations: pick three spread street corners and plant a canopy + pumps.
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

  _makeStation(x, z) {
    const g = new THREE.Group();
    // Canopy: flat slab on posts, lit edge so it reads at night.
    const canopyMat = new THREE.MeshStandardMaterial({
      color: 0xd23a3a, roughness: 0.5, metalness: 0.3,
      emissive: 0x551111, emissiveIntensity: 0.5,
    });
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(10, 0.4, 8), canopyMat);
    canopy.position.y = 4.6;
    canopy.castShadow = true;
    g.add(canopy);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.7 });
    for (const px of [-4, 4]) {
      for (const pz of [-3, 3]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.6, 0.4), postMat);
        post.position.set(px, 2.3, pz);
        g.add(post);
      }
    }
    // Pump: small box with a glowing band.
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

  // Per-frame: detect shop proximity. Inside the radius opens (or refreshes)
  // the menu; leaving it closes with a nudge toast.
  update(dt, player, inCar, playerCar, hud) {
    if (this.msgT > 0) this.msgT -= dt;
    const px = inCar ? playerCar.x : player.x;
    const pz = inCar ? playerCar.z : player.z;

    let near = null;
    for (const s of this.shops) {
      if (Math.hypot(s.x - px, s.z - pz) < this.shopRadius) { near = s; break; }
    }
    this.insideShop = near;

    if (!near) {
      if (this.menuOpen) {
        this.menuOpen = false;
        hud.toast('Left the station.', 2);
      }
      return;
    }
    if (!this.menuOpen || this._menuDirty) {
      // Refresh only after a purchase too: the bought line drops out of the
      // menu at once instead of lingering until the player leaves and returns.
      this.menuOpen = true;
      this._menuDirty = false;
      hud.toast(this._menuText(), 30);
    }
  }

  _menuText() {
    return menuTitle(this.upgrades);
  }

  // Shop hotkeys, called from the main loop when input.tapped fires.
  buy(item, player, hud, sfx) {
    if (!this.insideShop) return false;
    const spend = (cost) => {
      // Non-finite / negative prices can't occur (PRICES is static), but the
      // guard in pricing.js keeps a future data-driven table from bricking
      // the till.
      if (!priceCheck(cost)) return false;
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
        if (player.health >= PLAYER.maxHealth) { hud.toast('Health already full.', 2); return true; }
        ok = spend(PRICES.health);
        if (ok) { player.health = PLAYER.maxHealth; hud.toast('Patched up.', 2); }
        break;
      case 'armor':
        ok = spend(PRICES.armor);
        if (ok) { player.armor = this.armorCap(); hud.toast('Armor fitted.', 2); }
        break;
      case 'speed':
        if (this.upgrades.speed) { hud.toast('Engine already tuned.', 2); return true; }
        ok = spend(PRICES.speed);
        if (ok) { this.upgrades.speed = true; hud.toast(UPGRADE_HINTS.speed, 3); }
        break;
      case 'plating':
        if (this.upgrades.plating) { hud.toast('Already plated.', 2); return true; }
        ok = spend(PRICES.plating);
        if (ok) { this.upgrades.plating = true; hud.toast(UPGRADE_HINTS.plating, 3); }
        break;
      default:
        return false;
    }
    if (ok) { sfx.cash(); this.persist(); this._menuDirty = true; }
    return true;
  }

  // Top-speed multiplier applied to the player's car in main.js drive calls.
  speedMultiplier() { return this.upgrades.speed ? 1 + UPGRADES.speedBonus : 1; }

  // Extra armor capacity above PLAYER.maxArmor.
  armorCap() { return PLAYER.maxArmor + (this.upgrades.plating ? UPGRADES.armorBonus : 0); }

  // Mission rewards / pickups credit here so persistence stays in one place.
  // Clamp every credited amount: a negative or non-finite payout from a future
  // mission table must not corrupt the ledger; zero/negative payouts no-op.
  credit(amount, hud) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.money += amount;
    this.persist();
    if (hud) hud.toast(`+$${amount}`, 2);
  }

  message(text, seconds = 3) { this.msg = text; this.msgT = seconds; }
}
