// photo-mode.js — cinematic free camera. Freezes the sim through the same
// state.paused machinery the P-key uses, then hands the lens to the player:
// orbit around a locked pivot, zoom, canvas CSS filter presets and a FOV
// slider. Rendering needs no special path — the loop's pause branch already
// renders the frozen scene every frame, so this module only has to pose the
// camera and keep its own UI alive inside that branch (the loop calls
// update() there).
//
// Pause ownership: photo mode and the P-overlay both write state.paused. The
// self-heal at the top of update() re-freezes the sim if the P handler woke
// it up under a detached camera, so neither owner can silently strand the
// other. Exit puts camera transform, FOV, canvas filter and HUD visibility
// back exactly where they were found, then mirrors the P-resume radio restart.

// Orbit tuning. Mouse deltas arrive per pointer event; arrow keys and zoom
// are per-second rates so holding them moves the camera at a steady angular
// speed no matter how the frames pace.
const MOUSE_ORBIT_SPEED = 0.0045;   // rad per pixel of drag
const MOUSE_TILT_SPEED = 0.0036;    // rad per pixel, vertical drag
const ARROW_YAW_RATE = 1.7;         // rad/s
const ARROW_PITCH_RATE = 1.1;       // rad/s
const ZOOM_RATE = 1.1;              // exponential, per second
const DIST_MIN = 4;
const DIST_MAX = 120;
const GROUND_MARGIN = 0.9;          // the lens never dips under the asphalt
const PITCH_MIN = -0.2;             // slightly below horizon, mostly above
const PITCH_MAX = 1.4;
const FOV_MIN = 30;
const FOV_MAX = 100;

// Filter presets applied as CSS filters on the WebGL canvas: zero render-loop
// cost, and they compose with the scene's tone mapping instead of fighting it.
const FILTERS = [
  { id: 'clean', label: 'CLEAN', css: 'none' },
  { id: 'sepia', label: 'SEPIA', css: 'sepia(0.62) saturate(1.15) contrast(1.05)' },
  { id: 'noir', label: 'NOIR', css: 'grayscale(1) contrast(1.35) brightness(0.92)' },
  { id: 'vivid', label: 'VIVID', css: 'saturate(1.75) contrast(1.12)' },
];

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export class PhotoMode {
  constructor(w) {
    this.w = w;
    this.active = false;
    this.filterCursor = 0;
    this.pivot = { x: 0, y: 1.2, z: 0 };
    this.yaw = 0;
    this.pitch = 0.4;
    this.boom = 12;
    this._snapshot = null;   // { pos, quat, fov, camYaw } captured on enter
    this._panel = null;
    this._filterLabel = null;
    this._fovLabel = null;
    this._fovSlider = null;
    this._mountOverlay();
  }

  _activeFilter() { return FILTERS[this.filterCursor]; }

  // The PHOTO MODE overlay: title + control hints up top, filter readout and
  // the FOV slider on a pointer-enabled strip at the bottom. Built once; the
  // DOM is skipped entirely in plain-node contexts (smoke harnesses).
  _mountOverlay() {
    if (typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.id = 'vh-photo-mode';
    el.style.cssText = 'position:fixed;inset:0;display:none;pointer-events:none;z-index:15;' +
      "font-family:'Segoe UI',system-ui,sans-serif;color:#eef2ff;text-shadow:0 2px 4px #000000a6;";
    el.insertAdjacentHTML('beforeend', `
      <div style="position:absolute;top:16px;left:50%;transform:translateX(-50%);text-align:center;
        background:#0b0e14d9;border:1px solid #ffffff1f;border-radius:10px;padding:10px 22px;
        box-shadow:0 6px 18px #00000059;">
        <div style="font-size:22px;font-weight:800;letter-spacing:3px;
          background:linear-gradient(90deg,#7fd4ff,#ff7ad9);-webkit-background-clip:text;
          background-clip:text;color:transparent;">PHOTO MODE</div>
        <div style="margin-top:4px;font-size:12px;color:#cbd5f5;line-height:1.5;">
          drag / ← → — orbit · ↑ ↓ — tilt · − / = — zoom · X — filter · H — exit</div>
      </div>
      <div style="position:absolute;bottom:18px;left:50%;transform:translateX(-50%);
        background:#0b0e14d9;border:1px solid #ffffff1f;border-radius:10px;padding:10px 16px;
        display:flex;align-items:center;gap:10px;pointer-events:auto;">
        <span style="font-size:11px;letter-spacing:1.6px;color:#9fb0d8;">FOV</span>
        <input data-ref="fov" type="range" min="${FOV_MIN}" max="${FOV_MAX}" step="1"
          style="width:180px;accent-color:#ff7ad9;cursor:pointer;">
        <span data-ref="fovval" style="font-size:12px;font-variant-numeric:tabular-nums;width:36px;"></span>
        <span data-ref="filter" style="font-size:11px;letter-spacing:1.6px;color:#ffd76e;
          border-left:1px solid #ffffff26;padding-left:10px;"></span>
      </div>`);
    document.body.appendChild(el);
    this._panel = el;
    this._fovSlider = el.querySelector('[data-ref="fov"]');
    this._fovLabel = el.querySelector('[data-ref="fovval"]');
    this._filterLabel = el.querySelector('[data-ref="filter"]');
    this._fovSlider.addEventListener('input', () => {
      const cam = this.w.camera;
      cam.fov = clamp(Number(this._fovSlider.value), FOV_MIN, FOV_MAX);
      cam.updateProjectionMatrix();
      this._fovLabel.textContent = `${Math.round(cam.fov)}°`;
    });
  }

  // Enter from the action-key route in input-bindings. The orbit frame is
  // derived from wherever the chase camera currently sits, so the hand-off is
  // a seamless grab instead of a snap to a default angle.
  enter() {
    if (this.active || !this.w.running) return;
    const w = this.w;
    const cam = w.camera;
    const body = w.player.inCar ? w.playerCar : w.player;
    this.pivot.x = body.x;
    this.pivot.z = body.z;
    this.pivot.y = w.player.inCar ? 1.0 : 1.2;

    const dx = cam.position.x - this.pivot.x;
    const dy = cam.position.y - this.pivot.y;
    const dz = cam.position.z - this.pivot.z;
    this.boom = clamp(Math.hypot(dx, dz), DIST_MIN, DIST_MAX);
    this.yaw = Math.atan2(dx, dz);
    this.pitch = clamp(Math.atan2(dy, Math.max(0.001, this.boom)), PITCH_MIN, PITCH_MAX);

    this._snapshot = { pos: cam.position.clone(), quat: cam.quaternion.clone(), fov: cam.fov, camYaw: w.camYaw };
    this.active = true;
    w.state.paused = true;
    w.input.consumeMouse(); // drop the stale look delta so the orbit starts clean
    w.canvas.style.filter = this._activeFilter().css;
    if (w.hud && w.hud.hudEl) w.hud.hudEl.style.visibility = 'hidden';
    if (this._panel) {
      this._panel.style.display = 'block';
      this._fovSlider.value = String(Math.round(clamp(cam.fov, FOV_MIN, FOV_MAX)));
      this._fovLabel.textContent = `${Math.round(cam.fov)}°`;
      this._filterLabel.textContent = this._activeFilter().label;
    }
    // Park the challenge widget too — the sim is frozen, its readouts would lie.
    if (typeof document !== 'undefined') {
      const board = document.getElementById('vh-challenges');
      if (board) board.style.display = 'none';
    }
  }

  // Driven from the loop's pause branch every frame while frozen. Consumes
  // input like a normal frame (including endFrame, which the pause branch
  // skips) so tap semantics keep working with the sim stopped.
  update(dt) {
    if (!this.active) return;
    const w = this.w;
    if (!w.state.paused) w.state.paused = true; // self-heal: see pause-ownership note
    const input = w.input;

    if (input.tapped('KeyH') || input.tapped('Escape')) { this.exit(); return; }

    const md = input.consumeMouse();
    this.yaw -= md.x * MOUSE_ORBIT_SPEED;
    this.pitch = clamp(this.pitch - md.y * MOUSE_TILT_SPEED, PITCH_MIN, PITCH_MAX);
    if (input.down('ArrowLeft')) this.yaw += ARROW_YAW_RATE * dt;
    if (input.down('ArrowRight')) this.yaw -= ARROW_YAW_RATE * dt;
    if (input.down('ArrowUp')) this.pitch = clamp(this.pitch + ARROW_PITCH_RATE * dt, PITCH_MIN, PITCH_MAX);
    if (input.down('ArrowDown')) this.pitch = clamp(this.pitch - ARROW_PITCH_RATE * dt, PITCH_MIN, PITCH_MAX);
    // Exponential zoom keeps the feel constant at every distance.
    const zoomingOut = input.down('Minus') || input.down('NumpadSubtract');
    const zoomingIn = input.down('Equal') || input.down('NumpadAdd');
    if (zoomingOut) this.boom = clamp(this.boom * Math.exp(ZOOM_RATE * dt), DIST_MIN, DIST_MAX);
    if (zoomingIn) this.boom = clamp(this.boom * Math.exp(-ZOOM_RATE * dt), DIST_MIN, DIST_MAX);

    if (input.tapped('KeyX')) {
      this.filterCursor = (this.filterCursor + 1) % FILTERS.length;
      w.canvas.style.filter = this._activeFilter().css;
      if (this._filterLabel) this._filterLabel.textContent = this._activeFilter().label;
    }

    this._applyOrbitPose();
    input.endFrame();
  }

  _applyOrbitPose() {
    const cam = this.w.camera;
    const cy = Math.cos(this.pitch);
    const sy = Math.sin(this.pitch);
    cam.position.set(
      this.pivot.x + Math.sin(this.yaw) * cy * this.boom,
      Math.max(GROUND_MARGIN, this.pivot.y + sy * this.boom),
      this.pivot.z + Math.cos(this.yaw) * cy * this.boom,
    );
    cam.lookAt(this.pivot.x, this.pivot.y, this.pivot.z);
  }

  // Restore everything enter() touched. The chase camera re-lerps from the
  // restored transform on the next live frame, so there is no visible jump.
  exit() {
    if (!this.active) return;
    const w = this.w;
    const cam = w.camera;
    const s = this._snapshot;
    cam.position.copy(s.pos);
    cam.quaternion.copy(s.quat);
    cam.fov = s.fov;
    cam.updateProjectionMatrix();
    w.camYaw = s.camYaw;
    w.canvas.style.filter = 'none';
    this.active = false;
    this._snapshot = null;
    w.state.paused = false;
    if (w.hud && w.hud.hudEl) w.hud.hudEl.style.visibility = '';
    if (this._panel) this._panel.style.display = 'none';
    if (typeof document !== 'undefined') {
      const board = document.getElementById('vh-challenges');
      if (board) board.style.display = '';
    }
    // Mirror the P-resume: the pause branch stopped the radio scheduler.
    if (w.player.inCar && w.radio && w.radio.enabled && w.radio.station().id !== 'off') w.radio.start();
  }
}
