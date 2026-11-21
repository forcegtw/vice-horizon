// input.js — keyboard state, action bindings and pointer look.
//
// Design notes:
//   * Key identity is event.code, never event.key, so bindings survive
//     keyboard layouts (AZERTY, Dvorak) without per-user remapping.
//   * keydown repeats are dropped. Holding a key is tracked by the held set;
//     the once-per-press set exists purely for taps.
//   * Actions map to arrays of codes and fire when ANY bound code is tapped,
//     so a rebinding to two keys works from either of them.
//   * preventDefault is scoped to exactly the keys the browser would scroll
//     or navigate with; game letters stay untouched so devtools typing keeps
//     working while the game is focused.
//   * A blur wipes held keys, pending taps and the fire latch — alt-tabbing
//     away mid-firefight can never come back with the trigger stuck down.

// Keys the browser would otherwise act on (scroll, focus change, navigation).
const BROWSER_KEYS = Object.freeze([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab',
]);

// Default action -> physical codes. rebind() swaps any entry at runtime.
const DEFAULT_BINDINGS = Object.freeze({
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  enter: ['KeyF'],
  weaponNext: ['KeyE'],
  weaponPrev: ['KeyQ'],
  job: ['KeyT'],
  sideJob: ['KeyG'],
  radio: ['KeyJ'],
  radioMute: ['KeyK'],
  map: ['KeyM'],
});

export class Input {
  constructor(canvas) {
    this.keys = new Set();          // codes currently held
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.dragging = false;
    this.firing = false;            // primary button held
    this._pressedOnce = new Set();  // presses awaiting consumption
    // Per-instance copy: rebinding one Input must never touch the defaults.
    this.bindings = { ...DEFAULT_BINDINGS };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this._pressedOnce.add(e.code);
      if (BROWSER_KEYS.includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.release());

    // Drag-to-look: deltas accumulate only while the pointer is captured on
    // the canvas, so a stray sweep across the page never swings the camera.
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
    });
    window.addEventListener('pointerup', () => { this.dragging = false; });
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    });
    window.addEventListener('mousedown', (e) => { if (e.button === 0) this.firing = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.firing = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  down(code) { return this.keys.has(code); }

  // True exactly once per physical press, consumed on read.
  tapped(code) {
    if (this._pressedOnce.has(code)) {
      this._pressedOnce.delete(code);
      return true;
    }
    return false;
  }

  // Swap an action's codes mid-session, no restart needed.
  rebind(action, codes) {
    if (action in this.bindings) this.bindings[action] = Object.freeze(codes.slice());
  }

  // True the first frame any code bound to the action is freshly pressed.
  actionTapped(action) {
    return this.bindings[action].some((c) => this.tapped(c));
  }

  // Movement axes for this frame: forward and strafe, each in [-1, 1].
  moveAxis() {
    let f = 0, s = 0;
    if (this.bindings.forward.some((c) => this.down(c))) f += 1;
    if (this.bindings.back.some((c) => this.down(c))) f -= 1;
    if (this.bindings.left.some((c) => this.down(c))) s -= 1;
    if (this.bindings.right.some((c) => this.down(c))) s += 1;
    return { f, s };
  }

  // Camera deltas since the last read; resets the accumulator.
  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  // Forget everything held or pending. Wired to the blur handler, and safe
  // to call from anywhere that needs to force-clear the pad.
  release() {
    this.keys.clear();
    this._pressedOnce.clear();
    this.firing = false;
    this.dragging = false;
  }

  // End-of-frame sweep: a tap consumed this frame must not re-fire next frame.
  endFrame() {
    this._pressedOnce.clear();
  }
}
