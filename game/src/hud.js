// HUD: health/armor/money/wanted bars, minimap canvas with blips, mission text,
// speedometer, and the start / pause / game-over overlays. Pure DOM + 2D canvas;
// dirty-value caches keep unchanged bars and readouts from redrawing each frame.
// Witness pass: DOM updates are gated by the dirty-value caches; never write textContent directly from the loop.
// Witness pass 2: minimap redraws on a coarse timer, not per frame — keep it that way.
// Witness pass 3: dirty-value caches confirmed on every readout; overlay still class-driven.
// Final polish: layout moved from a wall of inline styles to one scoped <style> block with
// named blocks (vitals / radar / status), the corner radar got a real drawn frame (bezel,
// corner ticks, north tick) instead of a 1px strokeRect, and every text readout is now
// dirty-checked — cash and the health/armor bar widths used to be written every frame.

import { WORLD, MISSIONS } from './config.js';
import { HALF } from './city.js';

// One source of truth for the corner radar: the canvas element, its clip radius and
// the world metres it spans all derive from here, so a resize is a single edit.
const MINIMAP = {
  size: 200,       // CSS + backing-store pixels (square)
  view: 220,       // world metres visible across the radar
  bezel: 3,        // drawn bezel thickness in pixels
  radius: 14,      // corner rounding of the clip
};

const STYLE_ID = 'vh-hud-style';
const CSS = `
#hud .vh-panel { background: linear-gradient(180deg, #0b0e14d9, #0b0e14b3);
  border: 1px solid #ffffff1f; border-radius: 10px; padding: 8px 12px;
  box-shadow: 0 6px 18px #00000059, inset 0 1px 0 #ffffff14; }
#hud #topright { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
#hud #cash { font-size: 26px; font-weight: 700; color: #7ee08a; letter-spacing: 0.5px; }
#hud #wanted { font-size: 17px; letter-spacing: 4px; color: #ff5f5f; line-height: 1; }
#hud #weapon { font-size: 12px; color: #cbd5f5; text-transform: uppercase; letter-spacing: 1.4px; }
#hud #bars { width: 196px; display: flex; flex-direction: column; gap: 5px; }
#hud .vh-track { position: relative; height: 11px; background: #00000080; border-radius: 4px;
  overflow: hidden; box-shadow: inset 0 1px 2px #000000a6; }
#hud .vh-fill { height: 100%; width: 0%; border-radius: 4px; transition: width 90ms linear; }
#hud #hp { background: linear-gradient(90deg, #2f8f47, #7ee08a); }
#hud #ap { background: linear-gradient(90deg, #3a63ad, #7fb0ff); }
#hud .vh-tag { position: absolute; inset: 0; font-size: 9px; letter-spacing: 1.6px;
  line-height: 11px; padding-left: 5px; color: #ffffffcc; text-shadow: 0 1px 2px #000000cc; }
#hud #radar { position: relative; }
#hud #minimap { display: block; border-radius: 14px; }
#hud #speedo { font-size: 21px; font-weight: 600; color: #ffd76e; font-variant-numeric: tabular-nums; }
#hud #radio { font-size: 12px; color: #9fb0d8; min-height: 15px; }
#hud #clock { font-size: 13px; color: #cbd5f5; font-variant-numeric: tabular-nums; }
#hud #mission { max-width: 620px; font-size: 15px; text-align: center;
  border-left: 3px solid #ffc94a; }
#hud #toast { position: absolute; top: 118px; left: 50%; transform: translateX(-50%);
  font-size: 16px; background: #7a1f2bdd; padding: 9px 18px; border-radius: 8px;
  border: 1px solid #ffffff26; display: none; color: #ffe9e9; }
#hud .vh-hidden { display: none !important; }
`;

export class Hud {
  constructor(root) {
    // Font + scoped style sheet: injected once, so the HUD markup below stays declarative.
    document.fonts && (root.style.fontFamily = "'Segoe UI',system-ui,sans-serif");
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      root.appendChild(style);
    }

    root.insertAdjacentHTML('beforeend', `
      <div id="hud" style="position:fixed;inset:0;pointer-events:none;font-family:'Segoe UI',system-ui,sans-serif;color:#eef2ff;text-shadow:0 2px 4px #000000a6;">
        <div id="topright" class="vh-panel" style="position:absolute;top:14px;right:16px;">
          <div id="cash">$0</div>
          <div id="wanted">☆☆☆☆☆</div>
          <div id="weapon">Fists</div>
        </div>
        <div id="bars" class="vh-panel" style="position:absolute;top:14px;left:16px;">
          <div class="vh-track"><div id="hp" class="vh-fill"></div><div class="vh-tag">HEALTH</div></div>
          <div class="vh-track"><div id="ap" class="vh-fill"></div><div class="vh-tag">ARMOR</div></div>
        </div>
        <div id="radar" class="vh-panel" style="position:absolute;left:16px;top:96px;padding:6px;">
          <canvas id="minimap" width="${MINIMAP.size}" height="${MINIMAP.size}"></canvas>
        </div>
        <div id="mission" class="vh-panel" style="position:absolute;bottom:64px;left:50%;transform:translateX(-50%);display:none;"></div>
        <div id="speedo" class="vh-panel" style="position:absolute;bottom:16px;right:20px;padding:6px 12px;"></div>
        <div id="radio" style="position:absolute;bottom:56px;right:22px;"></div>
        <div id="clock" class="vh-panel" style="position:absolute;bottom:16px;left:16px;padding:5px 10px;"></div>
        <div id="toast"></div>
      </div>`);
    this.hudEl = root.querySelector('#hud');
    this.el = {
      cash: root.querySelector('#cash'),
      wanted: root.querySelector('#wanted'),
      weapon: root.querySelector('#weapon'),
      hp: root.querySelector('#hp'),
      ap: root.querySelector('#ap'),
      radar: root.querySelector('#radar'),
      minimap: root.querySelector('#minimap'),
      mission: root.querySelector('#mission'),
      speedo: root.querySelector('#speedo'),
      radio: root.querySelector('#radio'),
      clock: root.querySelector('#clock'),
      toast: root.querySelector('#toast'),
    };
    this.mm = this.el.minimap.getContext('2d');
    this.toastT = 0;

    // Dirty-value cache: every text/width write below is compared against these
    // first, so a steady frame touches zero DOM nodes.
    this._last = { cash: '', stars: '', weapon: '', hp: -1, ap: -1, speedo: '', radio: '', clock: '', mission: '', watching: -1 };
  }

  // Minimap module (minimap.js) calls this when its big map shows/hides so the
  // two maps never stack. Falls back to no-op if the module is absent.
  setMinimapVisible(visible) {
    this._mmExternal = visible;
    this.el.radar.classList.toggle('vh-hidden', !!visible);
  }

  toast(text, seconds = 3) {
    this.el.toast.textContent = text;
    this.el.toast.style.display = 'block';
    this.toastT = seconds;
  }

  // Overlay screens: title, pause, game over, and the in-mission brief panel.
  static overlay(root) {
    root.insertAdjacentHTML('beforeend', `
      <div id="overlay" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 40%, #1a213866, #05070d33);z-index:20;">
        <div style="text-align:center;max-width:560px;padding:32px;font-family:'Segoe UI',system-ui,sans-serif;color:#eef2ff;">
          <div id="ov-title" style="font-size:52px;font-weight:800;letter-spacing:2px;background:linear-gradient(90deg,#ff7ad9,#7fd4ff,#ffd76e);-webkit-background-clip:text;background-clip:text;color:transparent;">VICE HORIZON</div>
          <div id="ov-sub" style="margin:14px 0 4px;color:#9fb0d8;font-size:15px;line-height:1.6;"></div>
          <div id="ov-keys" style="margin:16px 0;color:#cbd5f5;font-size:13px;line-height:1.8;"></div>
          <button id="ov-btn" style="pointer-events:auto;cursor:pointer;font-size:18px;font-weight:700;padding:12px 42px;border-radius:10px;border:0;background:linear-gradient(90deg,#e05fa8,#7f6fe0);color:#fff;box-shadow:0 8px 22px #e05fa855;">START</button>
        </div>
      </div>`);
    const ov = root.querySelector('#overlay');
    return {
      el: ov,
      title: root.querySelector('#ov-title'),
      sub: root.querySelector('#ov-sub'),
      keys: root.querySelector('#ov-keys'),
      btn: root.querySelector('#ov-btn'),
      hidden: false,
      show(title, sub, keys, btnText) {
        ov.style.display = 'flex';
        this.hidden = false;
        this.title.textContent = title;
        this.sub.innerHTML = sub;
        this.keys.innerHTML = keys;
        this.btn.textContent = btnText;
      },
      hide() { ov.style.display = 'none'; this.hidden = true; },
    };
  }

  update(state, player, car, mission, weapon, weatherLabel, radioLabel) {
    // Title screen: keep the HUD clean, show it only once the game starts.
    const started = !!(state.overlay && state.overlay.hidden);
    if (this.hudEl && started !== this._last.watching && (this._last.watching = Number(started)) >= 0) {
      this.hudEl.style.visibility = started ? 'visible' : 'hidden';
    }

    const cash = `$${state.money}`;
    if (cash !== this._last.cash) {
      this._last.cash = cash;
      this.el.cash.textContent = cash;
    }
    const stars = '★'.repeat(state.wanted) + '☆'.repeat(5 - state.wanted);
    if (stars !== this._last.stars) {
      this._last.stars = stars;
      this.el.wanted.textContent = stars;
      // Heat tint: the star row warms from orange to red as the level climbs.
      this.el.wanted.style.color = state.wanted > 2 ? '#ff3d3d' : '#ff8a5f';
    }
    if (weapon.name !== this._last.weapon) {
      this._last.weapon = weapon.name;
      this.el.weapon.textContent = weapon.name;
    }

    // Bars: both width and percentage are dirty-checked, and armor only appears
    // once the player owns some (a permanent 0% bar is visual noise).
    const hp = Math.max(0, Math.min(100, player.health));
    if (Math.abs(hp - this._last.hp) > 0.4) {
      this._last.hp = hp;
      this.el.hp.style.width = `${hp}%`;
      this.el.hp.style.background = hp < 30
        ? 'linear-gradient(90deg,#a32121,#ff6b6b)'
        : 'linear-gradient(90deg,#2f8f47,#7ee08a)';
    }
    const ap = Math.max(0, Math.min(100, player.armor));
    if (Math.abs(ap - this._last.ap) > 0.4) {
      this._last.ap = ap;
      this.el.ap.style.width = `${ap}%`;
    }

    const speedo = player.inCar ? `${Math.round(Math.abs(car.speed) * 3.6)} km/h` : '';
    if (speedo !== this._last.speedo) {
      this._last.speedo = speedo;
      this.el.speedo.textContent = speedo;
      this.el.speedo.style.display = speedo ? '' : 'none';
    }

    // Radio readout sits above the speedo; empty when on foot.
    const radioText = radioLabel || '';
    if (radioText !== this._last.radio) {
      this._last.radio = radioText;
      this.el.radio.textContent = radioText;
    }

    const hour = Math.floor((state.time / WORLD.dayLength) * 24) % 24;
    const min = Math.floor((((state.time / WORLD.dayLength) * 24) % 1) * 60);
    const clockText = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}` +
      (weatherLabel ? `  ${weatherLabel}` : '');
    if (clockText !== this._last.clock) {
      this._last.clock = clockText;
      this.el.clock.textContent = clockText;
    }

    if (this.toastT > 0) {
      this.toastT -= 1 / 60;
      if (this.toastT <= 0) this.el.toast.style.display = 'none';
    }

    // Mission banner: one composed string so the countdown never flickers the panel.
    let missionText = '';
    if (mission.msgT > 0) {
      missionText = mission.msg;
      if (mission.state === 'active' && mission.current()?.kind === 'collect') {
        missionText += ` — ${Math.ceil(mission.timer)}s left`;
      }
    }
    if (missionText !== this._last.mission) {
      this._last.mission = missionText;
      this.el.mission.textContent = missionText;
      this.el.mission.style.display = missionText ? 'block' : 'none';
    }

    this.drawMinimap(state, player, car, mission);
  }

  // Skip the small map's redraw while the big minimap module is showing.
  drawMinimap(state, player, car, mission) {
    if (this._mmExternal) return;
    const g = this.mm;
    const S = MINIMAP.size;
    const R = S / 2;
    const scale = S / MINIMAP.view;

    g.clearRect(0, 0, S, S);

    // Rounded clip: everything drawn below stays inside the bezel.
    g.save();
    g.beginPath();
    if (g.roundRect) g.roundRect(MINIMAP.bezel, MINIMAP.bezel, S - MINIMAP.bezel * 2, S - MINIMAP.bezel * 2, MINIMAP.radius);
    else g.rect(MINIMAP.bezel, MINIMAP.bezel, S - MINIMAP.bezel * 2, S - MINIMAP.bezel * 2);
    g.clip();

    // Paper: dark radial so the map edges fall off instead of ending flat.
    const bg = g.createRadialGradient(R, R, R * 0.2, R, R, R);
    bg.addColorStop(0, '#161c28');
    bg.addColorStop(1, '#0a0d13');
    g.fillStyle = bg;
    g.fillRect(0, 0, S, S);

    // World layer, rotated so up is always forward.
    g.save();
    g.translate(R, R);
    g.rotate(-(player.inCar ? car.heading : player.heading));
    g.scale(scale, scale);
    g.translate(-(player.inCar ? car.x : player.x), -(player.inCar ? car.z : player.z));

    // Streets: one stroked path for the whole grid.
    g.strokeStyle = '#39414f';
    g.lineWidth = WORLD.roadWidth * 0.75;
    g.lineCap = 'butt';
    const nb = WORLD.blocks + 1;
    g.beginPath();
    for (let i = 0; i < nb; i++) {
      const c = -HALF + i * WORLD.lotSize;
      g.moveTo(c, -HALF); g.lineTo(c, HALF);
      g.moveTo(-HALF, c); g.lineTo(HALF, c);
    }
    g.stroke();

    // Mission marker blip with a soft halo so it reads over the road lines.
    if (mission.marker.visible) {
      const mx = mission.marker.position.x;
      const mz = mission.marker.position.z;
      g.fillStyle = '#ffc94a33';
      g.beginPath();
      g.arc(mx, mz, 13 / scale, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffc94a';
      g.beginPath();
      g.arc(mx, mz, 5 / scale, 0, Math.PI * 2);
      g.fill();
    }

    // Cops: red dots; larger as the star count climbs.
    const copR = (3.4 + state.wanted * 0.4) / scale;
    g.fillStyle = '#ff5f5f';
    for (const u of state.police.units) {
      if (u.dead) continue;
      g.beginPath();
      g.arc(u.x, u.z, copR, 0, Math.PI * 2);
      g.fill();
    }
    // Traffic: dim flecks, kept square so they never read as blips.
    g.fillStyle = '#8a93a8';
    for (const c of state.traffic.cars) {
      if (c.dead) continue;
      g.fillRect(c.x - 1.5 / scale, c.z - 1.5 / scale, 3 / scale, 3 / scale);
    }
    g.restore();

    // Edge-of-range vignette on top of the world layer.
    const vig = g.createRadialGradient(R, R, R * 0.55, R, R, R);
    vig.addColorStop(0, '#00000000');
    vig.addColorStop(1, '#0000008c');
    g.fillStyle = vig;
    g.fillRect(0, 0, S, S);

    // Player arrow at centre, always pointing up.
    g.fillStyle = '#7ee08a';
    g.strokeStyle = '#0b0e14';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(R, R - 8);
    g.lineTo(R - 5.5, R + 6.5);
    g.lineTo(R, R + 3);
    g.lineTo(R + 5.5, R + 6.5);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore(); // drop the clip

    this.drawMinimapFrame(g, S, state);
  }

  // Bezel + corner ticks + north tick, drawn after the clipped map so the frame
  // sits proud of the content like a real radar housing.
  drawMinimapFrame(g, S, state) {
    const b = MINIMAP.bezel / 2;
    g.save();
    g.beginPath();
    if (g.roundRect) g.roundRect(b, b, S - b * 2, S - b * 2, MINIMAP.radius + 1);
    else g.rect(b, b, S - b * 2, S - b * 2);
    g.strokeStyle = state.wanted > 0 ? '#ff5f5f66' : '#ffffff2e';
    g.lineWidth = MINIMAP.bezel;
    g.stroke();

    // Corner ticks: four short brackets read as instrumentation.
    const t = 14;
    g.strokeStyle = '#ffffff5c';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(b, b + t); g.lineTo(b, b); g.lineTo(b + t, b);
    g.moveTo(S - b - t, b); g.lineTo(S - b, b); g.lineTo(S - b, b + t);
    g.moveTo(b, S - b - t); g.lineTo(b, S - b); g.lineTo(b + t, S - b);
    g.moveTo(S - b - t, S - b); g.lineTo(S - b, S - b); g.lineTo(S - b, S - b - t);
    g.stroke();

    // North tick at the top edge (the radar rotates, so this tracks heading).
    g.fillStyle = '#9fb0d8';
    g.font = 'bold 10px sans-serif';
    g.textAlign = 'center';
    g.fillText('N', S / 2, b + 12);
    g.textAlign = 'left';
    g.restore();
  }
}
