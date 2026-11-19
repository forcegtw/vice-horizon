// minimap.js — dedicated minimap module: a larger, toggleable (M) canvas
// map with roads from the city grid, player arrow, side-job blips, mission
// markers and police blips when wanted. Owns its own canvas + HUD chip so the
// existing Hud minimap stays untouched; Hud just calls hud.setMinimapVisible()
// to hide its copy when this one is up. Coarse redraw timer, not per-frame.
// The toggle label tracks state on both open and close.

import { WORLD } from './config.js';
import { HALF } from './city.js';

const SIZE = 230;

export class Minimap {
  constructor(root, city) {
    this.city = city;
    this.visible = false;   // off by default; M toggles
    root.insertAdjacentHTML('beforeend', `
      <div id="mm2" style="position:absolute;right:16px;top:60px;display:none;pointer-events:none;">
        <canvas id="mm2c" width="${SIZE}" height="${SIZE}"
          style="border-radius:12px;background:#0b0e14dd;border:2px solid #ffffff22;"></canvas>
        <div id="mm2label" style="text-align:right;font-size:11px;color:#9fb0d8;margin-top:3px;text-shadow:0 1px 3px #000a;">M — hide map</div>
      </div>`);
    this.el = root.querySelector('#mm2');
    this.label = root.querySelector('#mm2label');
    this.canvas = root.querySelector('#mm2c');
    this.g = this.canvas.getContext('2d');
    this.redrawT = 0;

    // Pre-bake the static road layer to an offscreen canvas once: the grid
    // never changes, so the per-redraw cost is one drawImage.
    this.roadLayer = document.createElement('canvas');
    this.roadLayer.width = this.roadLayer.height = SIZE;
    this.bakeRoads();
  }

  toggle() {
    this.setVisible(!this.visible);
    return this.visible;
  }

  setVisible(v) {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
    // Label follows the state: it used to be static text that lied on reopen.
    if (this.label) this.label.textContent = v ? 'M — hide map' : 'M — show map';
  }

  // Static layer: streets + block fills, north-up, whole city in frame.
  bakeRoads() {
    const g = this.roadLayer.getContext('2d');
    const s = SIZE / (HALF * 2 + 40); // world → px, small border
    const to = (v) => (v + HALF + 20) * s;
    g.fillStyle = '#10131b';
    g.fillRect(0, 0, SIZE, SIZE);
    // Blocks: slightly lighter fill for the lots.
    g.fillStyle = '#1a1f2c';
    const nb = WORLD.blocks + 1;
    for (let i = 0; i < nb - 1; i++) {
      for (let j = 0; j < nb - 1; j++) {
        const x0 = -HALF + i * WORLD.lotSize + WORLD.roadWidth / 2;
        const z0 = -HALF + j * WORLD.lotSize + WORLD.roadWidth / 2;
        g.fillRect(to(x0), to(z0), WORLD.lotSize * s - WORLD.roadWidth * s, WORLD.lotSize * s - WORLD.roadWidth * s);
      }
    }
    // Streets: centre lines stroked at road width.
    g.strokeStyle = '#3d4557';
    g.lineWidth = WORLD.roadWidth * s;
    g.beginPath();
    for (let i = 0; i < nb; i++) {
      const c = to(-HALF + i * WORLD.lotSize);
      g.moveTo(c, to(-HALF)); g.lineTo(c, to(HALF));
      g.moveTo(to(-HALF), c); g.lineTo(to(HALF), c);
    }
    g.stroke();
    // Waterfront strip accent along the west edge.
    g.strokeStyle = '#2c5f8a';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(to(-HALF - 8), to(-HALF)); g.lineTo(to(-HALF - 8), to(HALF));
    g.stroke();
  }

  // Per-frame tick but with an internal coarse redraw timer; dt clamps the
  // redraw to ~10 Hz which is plenty for a map.
  update(dt, player, playerCar, mission, sideJobs, state) {
    if (!this.visible) return;
    this.redrawT -= dt;
    if (this.redrawT > 0) return;
    // 10 Hz redraw: a map has no per-frame state, so this stays plenty smooth.
    this.redrawT = 0.1;
    this.draw(player, playerCar, mission, sideJobs, state);
  }

  draw(player, playerCar, mission, sideJobs, state) {
    const g = this.g;
    const s = SIZE / (HALF * 2 + 40);
    const to = (v) => (v + HALF + 20) * s;
    const px = player.inCar ? playerCar.x : player.x;
    const pz = player.inCar ? playerCar.z : player.z;
    const heading = player.inCar ? playerCar.heading : player.heading;

    g.clearRect(0, 0, SIZE, SIZE);
    g.drawImage(this.roadLayer, 0, 0);

    // Side-job blips: route checkpoints (race) or pickup/drop-off chain.
    if (sideJobs && sideJobs.state === 'active') {
      for (const b of sideJobs.blips()) {
        g.fillStyle = '#' + b.color.toString(16).padStart(6, '0');
        g.beginPath();
        g.arc(to(b.x), to(b.z), b.size, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Main mission marker: pulsing gold ring + dot.
    if (mission.marker.visible) {
      const mx = to(mission.marker.position.x);
      const mz = to(mission.marker.position.z);
      g.strokeStyle = '#ffc94a';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(mx, mz, 7, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = '#ffc94a';
      g.beginPath();
      g.arc(mx, mz, 3, 0, Math.PI * 2);
      g.fill();
    }

    // Police blips: brighter + larger as the star count climbs.
    if (state.wanted > 0) {
      const r = 2 + state.wanted;
      g.fillStyle = '#ff5f5f';
      for (const u of state.police.units) {
        if (u.dead) continue;
        g.beginPath();
        g.arc(to(u.x), to(u.z), r, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Traffic flecks, dim so they never shout over blips.
    g.fillStyle = '#6f7890';
    for (const c of state.traffic.cars) {
      if (c.dead) continue;
      g.fillRect(to(c.x) - 1, to(c.z) - 1, 2, 2);
    }

    // Player arrow, rotated to heading.
    g.save();
    g.translate(to(px), to(pz));
    g.rotate(heading);
    g.fillStyle = '#7ee08a';
    g.beginPath();
    g.moveTo(0, -7);
    g.lineTo(-5, 6);
    g.lineTo(0, 3);
    g.lineTo(5, 6);
    g.closePath();
    g.fill();
    g.restore();

    // Compass tick: a small N in the top-right corner.
    g.fillStyle = '#9fb0d8';
    g.font = 'bold 11px sans-serif';
    g.fillText('N', SIZE - 16, 14);
  }
}
