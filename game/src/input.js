// Input handling: keyboard state, pointer look, and pause/menu toggles.
// pass 2: keydown repeat events are ignored; holding a key relies on the Set state only.
// The camera follows the player automatically; mouse drag is optional free look.
// Key state is a Set of event.code, so layout remaps (AZERTY etc.) stay consistent.
// Witness pass: preventDefault is intentionally scoped to game keys only so browser shortcuts keep working.
// Witness pass 2: pointer lock loss auto-pauses; input must never read stale keys after resume.
// Witness pass 3: blur clears keys and tapped state — resume starts from a clean slate.
// Polish pass 4: game actions are defined as an action->codes map so rebinding is a
// one-liner (Input.rebind('enter', ['KeyF'])) instead of an edit inside moveAxis /
// the loop. moveAxis and semantic helpers route through it; physical-code queries
// (down/tapped) keep working unchanged.

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
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.firing = false; });

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

  // Rebind an action to a new set of codes (swap mid-session with no restart).
  rebind(action, codes) {
    if (action in this.bindings) this.bindings[action] = codes.slice();
  }

  // True the first frame any bound code for the action is freshly pressed.
  actionTapped(action) {
    return this.bindings[action].some((c) => this.tapped(c));
  }

  // Movement axes for the current frame: forward, strafe in [-1, 1].
  moveAxis() {
    let f = 0, s = 0;
    if (this.bindings.forward.some((c) => this.down(c))) f += 1;
    if (this.bindings.back.some((c) => this.down(c))) f -= 1;
    if (this.bindings.left.some((c) => this.down(c))) s -= 1;
    if (this.bindings.right.some((c) => this.down(c))) s += 1;
    return { f, s };
  }

  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = 0; this.mouseDY = 0;
    return d;
  }

  endFrame() {
    this._pressedOnce.clear();
  }
}
