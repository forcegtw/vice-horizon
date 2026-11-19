// Economy: cash, gas-station shop stops, and vehicle upgrades that persist in
// localStorage alongside the main save. Gas stations sit on three spread street corners
// (canopy + pump props added here), and stopping inside one opens a shop menu.
// Design rule: Economy owns money flow and its own storage key; mission
// rewards still credit state.money directly, and the save merge happens here.
import * as THREE from '../vendor/three.min.js';
import { PLAYER } from './config.js';

const ECO_KEY = 'vice-horizon-economy-v1';

const PRICES = {
  health: 150,       // full heal at a gas station
  armor: 400,        // full armor refill
  speed: 2500,       // permanent engine upgrade (one-time)
  plating: 1800,     // permanent armor upgrade (one-time)
};

export const UPGRADES = {
  speedBonus: 0.18,   // +18% top speed per speed upgrade
  armorBonus: 50,     // extra armor capacity
};

export class Economy {
  constructor(scene, city, rng) {
    this.scene = scene;
    this.city = city;
    this.rng = rng;
    this._cash = 0;
    this._state = null;
    this.upgrades = { speed: false, plating: false };
    this.shops = [];       // {x, z, mesh, ring}
    this.insideShop = null;
    this.menuOpen = false;
    this._menuDirty = false;   // set after a purchase so the offer refreshes in place
    this.msg = '';
    this.msgT = 0;

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

  // Gas stations: pick 3 spread street corners and plant a canopy + pump props.
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
    for (const [px, pz] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.6, 0.4), postMat);
      post.position.set(px, 2.3, pz);
      g.add(post);
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

  // Per-frame: detect shop proximity (drive-through in a car, walk-up on foot).
  update(dt, player, inCar, playerCar, hud) {
    if (this.msgT > 0) this.msgT -= dt;
    const px = inCar ? playerCar.x : player.x;
    const pz = inCar ? playerCar.z : player.z;

    let near = null;
    for (const s of this.shops) {
      if (Math.hypot(s.x - px, s.z - pz) < 8) { near = s; break; }
    }
    this.insideShop = near;

    if (near && !this.menuOpen) {
      this.menuOpen = true;
      this._menuDirty = false;
      hud.toast(this._menuText(), 30);
    } else if (near && this.menuOpen && this._menuDirty) {
      // Refresh the offer only after a purchase: the bought line drops out of the
      // menu at once instead of lingering until the player leaves and returns.
      this._menuDirty = false;
      hud.toast(this._menuText(), 30);
    } else if (!near && this.menuOpen) {
      this.menuOpen = false;
      hud.toast('Left the station.', 2);
    }
  }

  _menuText() {
    const u = this.upgrades;
    return 'GAS STATION — B buy health $150 · N buy armor $400' +
      (u.speed ? '' : ' · V engine tune $2500') +
      (u.plating ? '' : ' · C plating $1800');
  }

  // Shop hotkeys, called from the main loop when input.tapped fires.
  buy(item, player, hud, sfx) {
    if (!this.insideShop) return false;
    const spend = (cost) => {
      // Non-finite / negative prices can't occur (PRICES is static), but the
      // guard keeps a future data-driven price table from bricking the till.
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
        if (player.health >= PLAYER.maxHealth) { hud.toast('Health already full.', 2); return true; }
        ok = spend(PRICES.health);
        if (ok) { player.health = PLAYER.maxHealth; hud.toast('Patched up.', 2); }
        break;
      case 'armor':
        ok = spend(PRICES.armor);
        if (ok) {
          player.armor = PLAYER.maxArmor + (this.upgrades.plating ? UPGRADES.armorBonus : 0);
          hud.toast('Armor fitted.', 2);
        }
        break;
      case 'speed':
        if (this.upgrades.speed) { hud.toast('Engine already tuned.', 2); return true; }
        ok = spend(PRICES.speed);
        if (ok) {
          this.upgrades.speed = true;
          hud.toast('ENGINE TUNE — +18% top speed', 3);
        }
        break;
      case 'plating':
        if (this.upgrades.plating) { hud.toast('Already plated.', 2); return true; }
        ok = spend(PRICES.plating);
        if (ok) {
          this.upgrades.plating = true;
          hud.toast('PLATING — +50 armor capacity', 3);
        }
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
  // Clamp every credited amount so a negative or non-finite reward from a future
  // mission table can't corrupt the ledger; zero/negative payouts are no-ops.
  credit(amount, hud) {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.money += amount;
    this.persist();
    if (hud) hud.toast(`+$${amount}`, 2);
  }

  message(text, seconds = 3) { this.msg = text; this.msgT = seconds; }
}
