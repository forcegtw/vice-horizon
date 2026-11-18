// Input handling: keyboard state, pointer look, and pause/menu toggles.
// The camera follows the player automatically; mouse drag is optional free look.
// Key state is a Set of event.code, so layout remaps (AZERTY etc.) stay consistent.

export class Input {
  constructor(canvas) {
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.dragging = false;
    this.firing = false;
    this._pressedOnce = new Set();

    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.keys.add(e.code);
      this._pressedOnce.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

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

  // Movement axes for the current frame: forward, strafe in [-1, 1].
  moveAxis() {
    let f = 0, s = 0;
    if (this.down('KeyW') || this.down('ArrowUp')) f += 1;
    if (this.down('KeyS') || this.down('ArrowDown')) f -= 1;
    if (this.down('KeyA') || this.down('ArrowLeft')) s -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) s += 1;
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
