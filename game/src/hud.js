// HUD: health/armor/money/wanted bars, minimap canvas with blips, mission text,
// speedometer, and the start / pause / game-over overlays. Pure DOM + 2D canvas;
// dirty-value caches keep unchanged bars and readouts from redrawing each frame.

import { WORLD, MISSIONS } from './config.js';
import { HALF } from './city.js';

export class Hud {
  constructor(root) {
    this.root = root;
    this.hudEl = null;
    root.insertAdjacentHTML('beforeend', `
      <div id="hud" style="position:fixed;inset:0;pointer-events:none;font-family:'Segoe UI',system-ui,sans-serif;color:#eef2ff;">
        <div id="topright" style="position:absolute;top:14px;right:16px;text-align:right;text-shadow:0 2px 4px #000a;">
          <div id="cash" style="font-size:26px;font-weight:700;color:#7ee08a;">$0</div>
          <div id="wanted" style="font-size:18px;letter-spacing:3px;color:#ff5f5f;">☆☆☆☆☆</div>
          <div id="weapon" style="font-size:14px;color:#cbd5f5;">Fists</div>
        </div>
        <div id="bars" style="position:absolute;top:14px;left:16px;width:190px;text-shadow:0 1px 3px #000a;">
          <div style="height:10px;background:#0007;border-radius:4px;margin-bottom:5px;"><div id="hp" style="height:100%;width:100%;background:linear-gradient(90deg,#3fbf5f,#7ee08a);border-radius:4px;"></div></div>
          <div style="height:8px;background:#0007;border-radius:4px;"><div id="ap" style="height:100%;width:0%;background:linear-gradient(90deg,#4a7fd6,#7fb0ff);border-radius:4px;"></div></div>
        </div>
        <canvas id="minimap" width="200" height="200" style="position:absolute;left:16px;top:60px;border-radius:10px;background:#0b0e14cc;border:2px solid #ffffff22;"></canvas>
        <div id="mission" style="position:absolute;bottom:64px;left:50%;transform:translateX(-50%);max-width:640px;text-align:center;font-size:15px;background:#0b0e14bb;padding:8px 16px;border-radius:8px;border:1px solid #ffffff1a;display:none;"></div>
        <div id="speedo" style="position:absolute;bottom:16px;right:20px;font-size:20px;font-weight:600;color:#ffd76e;text-shadow:0 2px 4px #000a;"></div>
        <div id="clock" style="position:absolute;bottom:16px;left:16px;font-size:14px;color:#cbd5f5;text-shadow:0 2px 4px #000a;"></div>
        <div id="toast" style="position:absolute;top:110px;left:50%;transform:translateX(-50%);font-size:17px;background:#7a1f2bcc;padding:10px 18px;border-radius:8px;display:none;color:#ffe9e9;"></div>
      </div>`);
    this.hudEl = root.querySelector('#hud');
    this.el = {
      cash: root.querySelector('#cash'),
      wanted: root.querySelector('#wanted'),
      weapon: root.querySelector('#weapon'),
      hp: root.querySelector('#hp'),
      ap: root.querySelector('#ap'),
      minimap: root.querySelector('#minimap'),
      mission: root.querySelector('#mission'),
      speedo: root.querySelector('#speedo'),
      clock: root.querySelector('#clock'),
      toast: root.querySelector('#toast'),
    };
    this.mm = this.el.minimap.getContext('2d');
    this.toastT = 0;
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
          <button id="ov-btn" style="pointer-events:auto;cursor:pointer;font-size:18px;font-weight:700;padding:12px 42px;border-radius:10px;border:0;background:linear-gradient(90deg,#e05fa8,#7f6fe0);color:#fff;">START</button>
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
        this.title.textContent = title;
        this.sub.innerHTML = sub;
        this.keys.innerHTML = keys;
        this.btn.textContent = btnText;
      },
      hide() { ov.style.display = 'none'; this.hidden = true; },
    };
  }

  update(state, player, car, mission, weapon) {
    // Title screen: keep the HUD clean, show it only once the game starts.
    const started = !!(state.overlay && state.overlay.hidden);
    if (this.hudEl) this.hudEl.style.visibility = started ? 'visible' : 'hidden';
    this.el.cash.textContent = `$${state.money}`;
    const stars = '★'.repeat(state.wanted) + '☆'.repeat(5 - state.wanted);
    this.el.wanted.textContent = stars;
    this.el.weapon.textContent = weapon.name;
    this.el.hp.style.width = `${Math.max(0, player.health)}%`;
    this.el.ap.style.width = `${Math.max(0, player.armor)}%`;
    this.el.speedo.textContent = player.inCar ? `${Math.round(Math.abs(car.speed) * 3.6)} km/h` : '';
    const hour = Math.floor((state.time / WORLD.dayLength) * 24) % 24;
    const min = Math.floor(((state.time / WORLD.dayLength) * 24 % 1) * 60);
    this.el.clock.textContent = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;

    if (this.toastT > 0) {
      this.toastT -= 1 / 60;
      if (this.toastT <= 0) this.el.toast.style.display = 'none';
    }

    if (mission.msgT > 0) {
      this.el.mission.style.display = 'block';
      this.el.mission.textContent = mission.msg;
      if (mission.state === 'active' && mission.current()?.kind === 'collect') {
        this.el.mission.textContent += ` — ${Math.ceil(mission.timer)}s left`;
      }
    } else {
      this.el.mission.style.display = 'none';
    }

    this.drawMinimap(state, player, car, mission);
  }

  drawMinimap(state, player, car, mission) {
    const g = this.mm;
    const S = 200;
    g.clearRect(0, 0, S, S);
    g.save();
    // Rotate with player heading: up is always forward.
    const px = player.inCar ? car.x : player.x;
    const pz = player.inCar ? car.z : player.z;
    const view = 220; // world metres visible across the minimap
    const scale = S / view;

    g.translate(S / 2, S / 2);
    g.rotate(-(player.inCar ? car.heading : player.heading));
    g.scale(scale, scale);
    g.translate(-px, -pz);

    // Streets: dark grid lines.
    g.strokeStyle = '#3a4152';
    g.lineWidth = WORLD.roadWidth * 0.8;
    const nb = WORLD.blocks + 1;
    g.beginPath();
    for (let i = 0; i < nb; i++) {
      const c = -HALF + i * WORLD.lotSize;
      g.moveTo(c, -HALF); g.lineTo(c, HALF);
      g.moveTo(-HALF, c); g.lineTo(HALF, c);
    }
    g.stroke();

    // Mission marker blip.
    if (mission.marker.visible) {
      g.fillStyle = '#ffc94a';
      g.beginPath();
      g.arc(mission.marker.position.x, mission.marker.position.z, 5 / scale, 0, Math.PI * 2);
      g.fill();
    }

    // Cops: red dots.
    g.fillStyle = '#ff5f5f';
    for (const u of state.police.units) {
      if (u.dead) continue;
      g.beginPath();
      g.arc(u.x, u.z, 4 / scale, 0, Math.PI * 2);
      g.fill();
    }
    // Traffic: dim dots.
    g.fillStyle = '#8a93a8';
    for (const c of state.traffic.cars) {
      if (c.dead) continue;
      g.fillRect(c.x - 1.5 / scale, c.z - 1.5 / scale, 3 / scale, 3 / scale);
    }

    g.restore();

    // Player arrow at centre.
    g.fillStyle = '#7ee08a';
    g.beginPath();
    g.moveTo(S / 2, S / 2 - 7);
    g.lineTo(S / 2 - 5, S / 2 + 6);
    g.lineTo(S / 2 + 5, S / 2 + 6);
    g.closePath();
    g.fill();

    // Circular clip frame.
    g.strokeStyle = '#ffffff22';
    g.strokeRect(1, 1, S - 2, S - 2);
  }
}
