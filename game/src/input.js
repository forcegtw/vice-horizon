// Vice Horizon input layer. One class owns every way a hand talks to the game:
// held keys, one-shot presses, pointer-drag look and the fire button.
//
// Design notes:
// - Key identity is KeyboardEvent.code, not key, so AZERTY/Dvorak players get
//   the same physical layout as QWERTY users.
// - Auto-repeat keydown events are dropped; "held" is derived from the Set, and
//   "just pressed" from a separate per-frame queue that endFrame() drains.
// - preventDefault is a whitelist, not a blanket: only codes the browser would
//   otherwise scroll or navigate with (arrows, Space, Tab) are swallowed, which
//   leaves devtools typing and browser shortcuts alone.
// - A lost-focus blur wipes held keys and the fire button, so alt-tabbing away
//   mid-firefight can never leave the weapon firing on return.

// Codes the browser treats as scroll/navigation gestures; the keydown handler
// preventDefaults exactly this list.
const SCROLL_GRABBER_CODES = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'];

function isScrollGrabber(code) {
  return SCROLL_GRABBER_CODES.includes(code);
}

export class Input {
  constructor(canvas) {
    // Codes currently held, and codes pressed since the last endFrame().
    this.keys = new Set();
    this._freshPresses = new Set();

    // Pointer-look accumulators, consumed once per frame by the camera.
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.dragging = false;

    // Primary mouse button state (the fire input).
    this.firing = false;

    // Action table: every gameplay verb maps to one or more physical codes.
    // Rebinding is a data edit here, never a change in the loop code.
    this.bindings = {
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
    };

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return; // holding a key relies on Set membership only
      this.keys.add(e.code);
      this._freshPresses.add(e.code);
      if (isScrollGrabber(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      // Focus loss: drop held keys and the fire button; one-shot presses are
      // drained by the next endFrame() as usual.
      this.keys.clear();
      this.firing = false;
      this.dragging = false;
    });

    // Drag-to-look: pointer capture keeps the move stream flowing past the
    // canvas edge; movement deltas only count while a drag is live.
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

    // Left mouse button is the attack/fire input; the right button opens the
    // browser menu, which would fight the drag look, so it is suppressed.
    window.addEventListener('mousedown', (e) => { if (e.button === 0) this.firing = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.firing = false; });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // True while a physical code is held.
  down(code) { return this.keys.has(code); }

  // True exactly once per physical press; the flag is consumed on read.
  tapped(code) {
    if (!this._freshPresses.has(code)) return false;
    this._freshPresses.delete(code);
    return true;
  }

  // Point an action at a new set of codes; mid-session remaps need no restart.
  rebind(action, codes) {
    if (action in this.bindings) this.bindings[action] = codes.slice();
  }

  // True the frame any code bound to the action was freshly pressed.
  actionTapped(action) {
    return this.bindings[action].some((c) => this.tapped(c));
  }

  // Movement axes for the frame: f = forward(+1)/back(-1), s = strafe in [-1, 1].
  moveAxis() {
    let f = 0, s = 0;
    if (this.bindings.forward.some((c) => this.down(c))) f += 1;
    if (this.bindings.back.some((c) => this.down(c))) f -= 1;
    if (this.bindings.left.some((c) => this.down(c))) s -= 1;
    if (this.bindings.right.some((c) => this.down(c))) s += 1;
    return { f, s };
  }

  // Hand the camera this frame's accumulated look delta and reset it.
  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  // End-of-frame bookkeeping: everything pressed this frame becomes stale.
  endFrame() {
    this._freshPresses.clear();
  }
}
