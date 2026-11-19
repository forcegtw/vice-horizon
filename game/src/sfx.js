// sfx.js — WebAudio synth: every sound is generated at runtime, no audio files.
// The context is created lazily on the first user gesture (browsers require it)
// and everything routes through one master gain, so volume is a single knob.
// Enveloped tones (5 ms attack, exponential decay) kill the click a raw step
// edge produces. Long-lived oscillators — engine, siren — are persistent nodes
// retuned per frame rather than rebuilt, and dispose() stops them all so a
// paused/shot session leaves no hum. cash() guards a missing context so the
// reward sting before the first gesture is a no-op, not a TypeError.

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicGain = null;
    this.musicTimer = null;
    this._step = 0;
    this._engineOsc = null;
    this._engineGain = null;
    this._sirenOsc = null;
    this._sirenGain = null;
  }

  // Create the context + master chain on first gesture; safe to call repeatedly.
  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.16;
    this.musicGain.connect(this.master);
    this._startMusic();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // Master volume in [0, 1] for the whole mix. setTargetAtTime rather than a
  // hard set so a volume change never clicks.
  setVolume(v) {
    if (!this.master) return;
    const t = Math.max(0, Math.min(1, v));
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(t * 0.5, this.ctx.currentTime, 0.08);
  }

  // Stop every long-lived oscillator and the music scheduler.
  dispose() {
    if (this.musicTimer) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    this._step = 0;
    for (const n of [this._engineOsc, this._sirenOsc]) {
      try { n?.stop(); } catch { /* already stopped */ }
    }
    this._engineOsc = null;
    this._sirenOsc = null;
  }

  // One enveloped oscillator tone; slideTo sweeps frequency exponentially.
  _tone(freq, dur, type = 'square', gain = 0.2, dest = null, slideTo = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    g.connect(dest || this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // Shaped white noise through a lowpass — impacts, gunfire, hats.
  _noise(dur, gain = 0.3, filterFreq = 1200) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
  }

  gunshot(vol = 0.8) {
    this._noise(0.14, 0.5 * vol, 3200);
    this._tone(180, 0.1, 'square', 0.25 * vol, null, 60);
  }

  punch() {
    this._noise(0.09, 0.4, 700);
    this._tone(90, 0.08, 'sine', 0.3, null, 50);
  }

  // Persistent engine oscillator retuned to speed ratio [0, 1]; gain gates it
  // to zero when idling so the hum doesn't run while parked.
  engine(speedRatio) {
    if (!this.ctx) return;
    if (!this._engineOsc) {
      this._engineOsc = this.ctx.createOscillator();
      this._engineGain = this.ctx.createGain();
      this._engineOsc.type = 'sawtooth';
      this._engineGain.gain.value = 0;
      this._engineOsc.connect(this._engineGain);
      this._engineGain.connect(this.master);
      this._engineOsc.start();
    }
    const f = 55 + speedRatio * 130;
    this._engineOsc.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.08);
    this._engineGain.gain.setTargetAtTime(speedRatio > 0.02 ? 0.05 : 0, this.ctx.currentTime, 0.15);
  }

  engineOff() {
    if (this._engineGain) this._engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
  }

  crash() {
    this._noise(0.3, 0.6, 900);
    this._tone(70, 0.25, 'sawtooth', 0.3, null, 40);
  }

  pickup() {
    this._tone(660, 0.09, 'square', 0.22);
    this._tone(990, 0.12, 'square', 0.18);
  }

  cash() {
    if (!this.ctx) return;
    this._tone(880, 0.07, 'square', 0.2);
    setTimeout(() => { if (this.ctx) this._tone(1320, 0.09, 'square', 0.2); }, 70);
  }

  wantedUp() {
    this._tone(440, 0.18, 'square', 0.25, null, 220);
  }

  // Continuous wail while on. Phase derives from clock time so repeated calls
  // per frame ride one sweep instead of snapping back to the bottom each call.
  siren(on) {
    if (!this.ctx) return;
    if (on && !this._sirenOsc) {
      this._sirenOsc = this.ctx.createOscillator();
      this._sirenGain = this.ctx.createGain();
      this._sirenOsc.type = 'triangle';
      this._sirenGain.gain.value = 0.06;
      this._sirenOsc.connect(this._sirenGain);
      this._sirenGain.connect(this.master);
      this._sirenOsc.start();
    }
    if (on && this._sirenOsc) {
      const t = this.ctx.currentTime;
      this._sirenOsc.frequency.cancelScheduledValues(t);
      this._sirenOsc.frequency.setValueAtTime(this._sirenOsc.frequency.value, t);
      const ph = (t % 1.8) / 1.8;
      const target = ph < 0.5 ? 700 + 800 * (ph / 0.5) : 1500 - 800 * ((ph - 0.5) / 0.5);
      this._sirenOsc.frequency.linearRampToValueAtTime(target, t + 0.05);
    } else if (!on && this._sirenOsc) {
      this._sirenOsc.stop();
      this._sirenOsc = null;
    }
  }

  // Synthwave bed: bass + arp + hats on an 8-step loop, scheduled ahead by an
  // interval that matches the step duration. Gain fades in over 2.5 s so
  // unmuting never pops.
  _startMusic() {
    const bpm = 96;
    const stepDur = 60 / bpm / 2;
    const bass = [55, 55, 65.4, 55, 49, 49, 58.3, 49];
    const arp = [220, 277, 330, 277, 196, 247, 294, 247];
    this.musicGain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    this.musicGain.gain.exponentialRampToValueAtTime(0.16, this.ctx.currentTime + 2.5);
    this.musicTimer = setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'running') return;
      const s = this._step % 8;
      this._tone(bass[s], stepDur * 1.8, 'sawtooth', 0.18, this.musicGain);
      this._tone(arp[s] * 2, stepDur * 0.9, 'square', 0.045, this.musicGain);
      if (s % 4 === 0) this._noise(0.06, 0.12, 4000);
      this._step++;
    }, stepDur * 1000);
  }
}
