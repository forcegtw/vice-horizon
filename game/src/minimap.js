// minimap.js — the full-city map overlay, toggled with M.
//
// Owns its own canvas and label chip; hud.js collapses its corner radar
// while this is up, through the wrapped setVisible that main.js installs.
// The static road layer is baked once to an offscreen canvas — the street
// grid never changes at runtime, so every redraw is one drawImage plus the
// dynamic blips. Redraws are throttled to roughly 10 Hz; a map has no
// per-frame state that needs more.
//
// This map is north-up and never rotates — the corner radar in hud.js is
// the rotating one — so the compass N below never moves.

import { WORLD } from './config.js';
import { HALF } from './city.js';

// Canvas edge in px (square) and world metres of margin baked around the city.
const SIZE = 230;
const BORDER = 20;
// World metres the map spans: the city plus the baked margin on each side.
const VIEW_SPAN = HALF * 2 + BORDER * 2;
// Seconds between redraws while visible (~10 Hz).
const REDRAW_INTERVAL = 0.1;

const LABEL_ON = 'M — hide map';
const LABEL_OFF = 'M — show map';

export class Minimap {
  constructor(root, city) {
    this.city = city;
    this.visible = false;      // off by default; M toggles
    this.redrawT = 0;
    root.insertAdjacentHTML('beforeend', `
      <div id="mm2" style="position:absolute;right:16px;top:60px;display:none;pointer-events:none;">
        <canvas id="mm2c" width="${SIZE}" height="${SIZE}"
          style="border-radius:12px;background:#0b0e14dd;border:2px solid #ffffff22;"></canvas>
        <div id="mm2label" style="text-align:right;font-size:11px;color:#9fb0d8;margin-top:3px;text-shadow:0 1px 3px #000a;">${LABEL_OFF}</div>
      </div>`);
    this.el = root.querySelector('#mm2');
    this.label = root.querySelector('#mm2label');
    this.canvas = root.querySelector('#mm2c');
    this.g = this.canvas.getContext('2d');

    // Pre-baked static layer: lots, streets, waterfront accent.
    this.roadLayer = document.createElement('canvas');
    this.roadLayer.width = this.roadLayer.height = SIZE;
    this.bakeRoads();
  }

  toggle() {
    this.setVisible(!this.visible);
    return this.visible;
  }

  // Label tracks state on open and close alike, so it never lies.
  setVisible(v) {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
    if (this.label) this.label.textContent = v ? LABEL_ON : LABEL_OFF;
  }

  bakeRoads() {
    const g = this.roadLayer.getContext('2d');
    const s = SIZE / VIEW_SPAN;
    const to = (v) => (v + HALF + BORDER) * s;
    g.fillStyle = '#10131b';
    g.fillRect(0, 0, SIZE, SIZE);
    // Lot fills stop at the next block's street edge; the road stroke painted
    // after closes the gap, so streets read as continuous ribbons.
    g.fillStyle = '#1a1f2c';
    const lanes = WORLD.blocks + 1;
    for (let i = 0; i < lanes - 1; i++) {
      for (let j = 0; j < lanes - 1; j++) {
        const x0 = -HALF + i * WORLD.lotSize + WORLD.roadWidth / 2;
        const z0 = -HALF + j * WORLD.lotSize + WORLD.roadWidth / 2;
        g.fillRect(to(x0), to(z0), WORLD.lotSize * s - WORLD.roadWidth * s, WORLD.lotSize * s - WORLD.roadWidth * s);
      }
    }
    // Streets: one stroke per axis, at full road width.
    g.strokeStyle = '#3d4557';
    g.lineWidth = WORLD.roadWidth * s;
    g.beginPath();
    for (let i = 0; i < lanes; i++) {
      const c = to(-HALF + i * WORLD.lotSize);
      g.moveTo(c, to(-HALF)); g.lineTo(c, to(HALF));
      g.moveTo(to(-HALF), c); g.lineTo(to(HALF), c);
    }
    g.stroke();
    // Waterfront accent along the west edge.
    g.strokeStyle = '#2c5f8a';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(to(-HALF - 8), to(-HALF)); g.lineTo(to(-HALF - 8), to(HALF));
    g.stroke();
  }

  // Coarse tick: dt clamps the redraw rate; skipped entirely while hidden.
  update(dt, player, playerCar, mission, sideJobs, state) {
    if (!this.visible) return;
    this.redrawT -= dt;
    if (this.redrawT > 0) return;
    this.redrawT = REDRAW_INTERVAL;
    this.draw(player, playerCar, mission, sideJobs, state);
  }

  draw(player, playerCar, mission, sideJobs, state) {
    const g = this.g;
    const s = SIZE / VIEW_SPAN;
    const to = (v) => (v + HALF + BORDER) * s;
    const px = player.inCar ? playerCar.x : player.x;
    const pz = player.inCar ? playerCar.z : player.z;
    const heading = player.inCar ? playerCar.heading : player.heading;

    g.clearRect(0, 0, SIZE, SIZE);
    g.drawImage(this.roadLayer, 0, 0);

    // Side-job blips: the race route chain or the single delivery objective.
    if (sideJobs && sideJobs.state === 'active') {
      for (const b of sideJobs.blips()) {
        g.fillStyle = '#' + b.color.toString(16).padStart(6, '0');
        g.beginPath();
        g.arc(to(b.x), to(b.z), b.size, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Story marker: pulsing gold ring with a solid dot at its centre.
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

    // Police blips grow with the star count.
    if (state.wanted > 0) {
      g.fillStyle = '#ff5f5f';
      const r = 2 + state.wanted;
      for (const u of state.police.units) {
        if (u.dead) continue;
        g.beginPath();
        g.arc(to(u.x), to(u.z), r, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Traffic flecks, dim — never louder than the blips above.
    g.fillStyle = '#6f7890';
    for (const c of state.traffic.cars) {
      if (c.dead) continue;
      g.fillRect(to(c.x) - 1, to(c.z) - 1, 2, 2);
    }

    // Player arrow rotated to heading, on a north-up frame.
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

    g.fillStyle = '#9fb0d8';
    g.font = 'bold 11px sans-serif';
    g.fillText('N', SIZE - 16, 14);
  }
}
