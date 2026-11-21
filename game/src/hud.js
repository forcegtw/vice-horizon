// hud.js — DOM + 2D-canvas HUD: cash, wanted stars, weapon, health/armor
// bars, corner radar (canvas, rotates so up is forward), speedometer, clock
// with weather, radio readout, mission banner, toasts, and the start/pause
// overlay built by the static Hud.overlay. Every text/width write passes a
// dirty-value cache first, so a steady frame touches zero DOM nodes. The
// overlay is class-driven; layout lives in one scoped style block injected
// once per page.

import { WORLD } from './config.js';
import { HALF } from './city.js';

// Corner radar geometry — one source of truth for canvas size, world span
// and the drawn bezel, so a resize is a single edit.
const RADAR = Object.freeze({
  size: 200,       // CSS + backing-store pixels (square)
  view: 220,       // world metres visible across the radar
  bezel: 3,        // drawn bezel thickness in px
  radius: 14,      // clip corner rounding
});

// Injected stylesheet id; the guard below keeps re-instantiation from
// stacking copies of the style block.
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
  border: 1px solid #ffffff26; display: none; color: #ffe9e9; max-width: 80vw; text-align: center; }
#hud .vh-hidden { display: none !important; }
`;

// Seconds the toast countdown steps per HUD frame. update() receives no dt,
// and a banner only needs to hide itself, so 1/60 is close enough.
const TOAST_STEP = 1 / 60;
// Bars re-write below this delta in percent.
const BAR_EPSILON = 0.4;
// Star row total — the HUD renders filled/empty pairs against this.
const MAX_STARS = 5;
// The filled/empty pair the wanted row renders with.
const STAR_FULL = '★';
const STAR_EMPTY = '☆';
// Health percentage below which the bar warms red.
const LOW_HEALTH_AT = 30;
// Wanted row tint above and at/below the escalation midpoint.
const STAR_COLOR_HOT = '#ff3d3d';
const STAR_COLOR_WARM = '#ff8a5f';
// Corner bracket length on the radar frame, in px.
const BRACKET_TICK = 14;

export class Hud {
  constructor(root) {
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
          <canvas id="minimap" width="${RADAR.size}" height="${RADAR.size}"></canvas>
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
    this._mmExternal = false;

    // Dirty-value cache: compared before every write below.
    this._last = { cash: '', stars: '', weapon: '', hp: -1, ap: -1, speedo: '', radio: '', clock: '', mission: '', watching: -1 };
  }

  // The big-map module calls this through the wrapped setVisible main.js
  // installs, so the corner radar and the full map never stack. No-op-safe
  // when the module is absent.
  setMinimapVisible(visible) {
    this._mmExternal = visible;
    this.el.radar.classList.toggle('vh-hidden', !!visible);
  }

  toast(text, seconds = 3) {
    this.el.toast.textContent = text;
    this.el.toast.style.display = 'block';
    this.toastT = seconds;
  }

  // Title / pause screens. Returns a small handle {el, title, sub, keys, btn,
  // hidden, show, hide} — main.js owns the click wiring.
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
      hide() {
        ov.style.display = 'none';
        this.hidden = true;
      },
    };
  }

  update(state, player, car, mission, weapon, weatherLabel, radioLabel) {
    // The HUD hides behind the title screen and appears once the game starts
    // (overlay dismissed by click or by shot staging).
    const started = !!(state.overlay && state.overlay.hidden);
    if (started !== !!this._last.watching) {
      this._last.watching = Number(started);
      this.hudEl.style.visibility = started ? 'visible' : 'hidden';
    }

    const cash = `$${state.money}`;
    if (cash !== this._last.cash) {
      this._last.cash = cash;
      this.el.cash.textContent = cash;
    }

    const stars = STAR_FULL.repeat(state.wanted) + STAR_EMPTY.repeat(MAX_STARS - state.wanted);
    if (stars !== this._last.stars) {
      this._last.stars = stars;
      this.el.wanted.textContent = stars;
      // The star row warms from orange to red as the level climbs.
      this.el.wanted.style.color = state.wanted > 2 ? STAR_COLOR_HOT : STAR_COLOR_WARM;
    }

    if (weapon.name !== this._last.weapon) {
      this._last.weapon = weapon.name;
      this.el.weapon.textContent = weapon.name;
    }

    // Bars: armor only shows once the player owns some.
    const hp = Math.max(0, Math.min(100, player.health));
    if (Math.abs(hp - this._last.hp) > BAR_EPSILON) {
      this._last.hp = hp;
      this.el.hp.style.width = `${hp}%`;
      this.el.hp.style.background = hp < LOW_HEALTH_AT
        ? 'linear-gradient(90deg,#a32121,#ff6b6b)'
        : 'linear-gradient(90deg,#2f8f47,#7ee08a)';
    }
    const ap = Math.max(0, Math.min(100, player.armor));
    if (Math.abs(ap - this._last.ap) > BAR_EPSILON) {
      this._last.ap = ap;
      this.el.ap.style.width = `${ap}%`;
    }

    const speedo = player.inCar ? `${Math.round(Math.abs(car.speed) * 3.6)} km/h` : '';
    if (speedo !== this._last.speedo) {
      this._last.speedo = speedo;
      this.el.speedo.textContent = speedo;
      this.el.speedo.style.display = speedo ? '' : 'none';
    }

    const radioText = radioLabel || '';
    if (radioText !== this._last.radio) {
      this._last.radio = radioText;
      this.el.radio.textContent = radioText;
    }

    // Day clock from the world time; the weather label rides the same panel.
    const dayFrac = (state.time / WORLD.dayLength) % 1;
    const hour = Math.floor(dayFrac * 24);
    const minute = Math.floor((dayFrac * 24 % 1) * 60);
    const clockText = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` +
      (weatherLabel ? `  ${weatherLabel}` : '');
    if (clockText !== this._last.clock) {
      this._last.clock = clockText;
      this.el.clock.textContent = clockText;
    }

    if (this.toastT > 0) {
      this.toastT -= TOAST_STEP;
      if (this.toastT <= 0) this.el.toast.style.display = 'none';
    }

    // Mission banner: one composed string (brief + countdown) so the panel
    // never flickers between updates.
    let banner = '';
    if (mission.msgT > 0) {
      banner = mission.msg;
      if (mission.state === 'active' && mission.current()?.kind === 'collect') {
        banner += ` — ${Math.ceil(mission.timer)}s left`;
      }
    }
    if (banner !== this._last.mission) {
      this._last.mission = banner;
      this.el.mission.textContent = banner;
      this.el.mission.style.display = banner ? 'block' : 'none';
    }

    this.drawMinimap(state, player, car, mission);
  }

  // Corner radar: rotating (up is forward), rounded-clip, bezel + ticks drawn
  // after the clipped content so the frame sits proud. Skipped entirely while
  // the full-city map is showing.
  drawMinimap(state, player, car, mission) {
    if (this._mmExternal) return;
    const g = this.mm;
    const S = RADAR.size;
    const R = S / 2;
    const scale = S / RADAR.view;
    const px = player.inCar ? car.x : player.x;
    const pz = player.inCar ? car.z : player.z;
    const heading = player.inCar ? car.heading : player.heading;

    g.clearRect(0, 0, S, S);
    g.save();
    this._traceRadarShape(g, S, RADAR.radius);
    g.clip();

    // Paper: a dark radial so the edges fall off instead of ending flat.
    const bg = g.createRadialGradient(R, R, R * 0.2, R, R, R);
    bg.addColorStop(0, '#161c28');
    bg.addColorStop(1, '#0a0d13');
    g.fillStyle = bg;
    g.fillRect(0, 0, S, S);

    // World layer, rotated so up is always the player's forward.
    g.save();
    g.translate(R, R);
    g.rotate(-heading);
    g.scale(scale, scale);
    g.translate(-px, -pz);

    g.strokeStyle = '#39414f';
    g.lineWidth = WORLD.roadWidth * 0.75;
    g.lineCap = 'butt';
    const lanes = WORLD.blocks + 1;
    g.beginPath();
    for (let i = 0; i < lanes; i++) {
      const c = -HALF + i * WORLD.lotSize;
      g.moveTo(c, -HALF); g.lineTo(c, HALF);
      g.moveTo(-HALF, c); g.lineTo(HALF, c);
    }
    g.stroke();

    // Story marker blip with a soft halo.
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

    // Cops: red dots that grow with the star count.
    const copR = (3.4 + state.wanted * 0.4) / scale;
    g.fillStyle = '#ff5f5f';
    for (const u of state.police.units) {
      if (u.dead) continue;
      g.beginPath();
      g.arc(u.x, u.z, copR, 0, Math.PI * 2);
      g.fill();
    }

    // Traffic: dim square flecks so they never read as blips.
    g.fillStyle = '#8a93a8';
    for (const c of state.traffic.cars) {
      if (c.dead) continue;
      g.fillRect(c.x - 1.5 / scale, c.z - 1.5 / scale, 3 / scale, 3 / scale);
    }
    g.restore();

    // Edge-of-range vignette over the world layer.
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
    g.restore();   // drop the clip

    this.drawMinimapFrame(g, S, state);
  }

  // Rounded-rect clip path for the radar, falling back to a plain rect when
  // roundRect is unavailable (older canvas implementations).
  _traceRadarShape(g, S, radius) {
    g.beginPath();
    if (g.roundRect) g.roundRect(RADAR.bezel, RADAR.bezel, S - RADAR.bezel * 2, S - RADAR.bezel * 2, radius);
    else g.rect(RADAR.bezel, RADAR.bezel, S - RADAR.bezel * 2, S - RADAR.bezel * 2);
  }

  // Radar housing: bezel (tints red while wanted), corner brackets, north
  // label. Runs after restore(), so nothing here is clipped away.
  drawMinimapFrame(g, S, state) {
    const b = RADAR.bezel / 2;
    g.save();
    this._traceRadarShape(g, S, RADAR.radius + 1);
    g.strokeStyle = state.wanted > 0 ? '#ff5f5f66' : '#ffffff2e';
    g.lineWidth = RADAR.bezel;
    g.stroke();

    const t = BRACKET_TICK;
    g.strokeStyle = '#ffffff5c';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(b, b + t); g.lineTo(b, b); g.lineTo(b + t, b);
    g.moveTo(S - b - t, b); g.lineTo(S - b, b); g.lineTo(S - b, b + t);
    g.moveTo(b, S - b - t); g.lineTo(b, S - b); g.lineTo(b + t, S - b);
    g.moveTo(S - b - t, S - b); g.lineTo(S - b, S - b); g.lineTo(S - b, S - b - t);
    g.stroke();

    g.fillStyle = '#9fb0d8';
    g.font = 'bold 10px sans-serif';
    g.textAlign = 'center';
    g.fillText('N', S / 2, b + 12);
    g.textAlign = 'left';
    g.restore();
  }
}
