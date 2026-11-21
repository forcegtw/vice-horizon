// input.js — keyboard state, pointer look, and action bindings.
// Key state is a Set of event.code, so layout remaps (AZERTY etc.) stay
// consistent; keydown repeats are ignored — holding a key relies on the Set
// only. Actions are defined as an action->codes map so rebinding is
// Input.rebind('enter', ['KeyF']) instead of an edit inside the loop.
// preventDefault is scoped to exactly the keys the browser would scroll or
// navigate with; game letters stay untouched so devtools typing still works.
// Blur clears keys, taps and the mouse button, so refocus after alt-tab can
// never resume with the weapon firing.

// Keys the browser would scroll or navigate with; preventDefault applies only
// to these so game letters stay untouched.
const BROWSER_KEYS = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'];

export class Input {
  constructor(canvas) {
    this.keys = new Set();        // currently held codes
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.dragging = false;
    this.firing = false;          // LMB held
    this._pressedOnce = new Set(); // fresh presses not yet consumed

    // Action bindings: an action matches ANY of its bound physical codes, so a
    // rebinding to two keys still fires from either.
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
      if (e.repeat) return;
      this.keys.add(e.code);
      this._pressedOnce.add(e.code);
      if (BROWSER_KEYS.includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this._pressedOnce.clear();
      this.firing = false;
      this.dragging = false;
    });

    // Pointer drag = camera look. movementX/Y only accumulates while dragging,
    // so a stray mouse move over the page never swings the camera.
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

  // True the first frame any bound code for the action is freshly pressed.
  actionTapped(action) {
    return this.bindings[action].some((c) => this.tapped(c));
  }

  // Movement axes for this frame: forward and strafe in [-1, 1].
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

  // End-of-frame: consumed taps must not fire again next frame.
  endFrame() {
    this._pressedOnce.clear();
  }
}
