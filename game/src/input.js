// input.js — keyboard state, pointer look and the action-binding layer.
// Key state is a Set of event.code, so layout remaps (AZERTY and friends) stay
// consistent; keydown repeat events are ignored — holding a key relies on the
// Set alone. preventDefault is scoped to the keys a browser would otherwise
// scroll or navigate with, so game letters (F, T, G…) stay free for devtools.
// Blur clears keys, taps and the mouse button, so resume starts from a clean
// slate and alt-tab can never leave the trigger held down.
// Actions are an action -> codes map: rebinding mid-session is
// Input.rebind('enter', ['KeyF']), never an edit inside moveAxis or the loop.

// Keys the browser would otherwise scroll or navigate with are listed once; the
// keydown handler preventDefaults exactly this set.
const BROWSER_KEYS = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'];

export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.dragging = false;
    this.firing = false;
    this._pressedOnce = new Set();

    // Action bindings: each action matches ANY of its bound physical codes.
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
      this.firing = false;
      this.dragging = false;
    });

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
    return this._pressedOnce.delete(code);
  }

  // Rebind an action to a new set of codes (swap mid-session, no restart).
  rebind(action, codes) {
    if (action in this.bindings) this.bindings[action] = codes.slice();
  }

  // True the first frame any bound code for the action is freshly pressed.
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

  // Hand over the accumulated pointer delta and reset it.
  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  // Called once per frame by the main loop: one-shot taps live a single frame.
  endFrame() {
    this._pressedOnce.clear();
  }
}
