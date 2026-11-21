// sfx.js — the WebAudio synth behind every sound in Vice Horizon: gunshots,
// punches, crashes, pickups, the cash sting, the wanted-star sting, the wailing
// siren, the engine drone and the ambient music loop. No audio assets anywhere;
// tones are enveloped oscillators and percussion is filtered noise bursts.
// Lifecycle: the AudioContext is created lazily on the first user gesture
// (browsers refuse it earlier), pause suspends rather than mutes so the
// schedule-ahead chain stops with the game, and long-lived oscillators (engine,
// siren) persist and get retuned in place while one-shots stop themselves.
// dispose() is the hard off-switch; cash() guards a missing context so a reward
// sting before the first gesture is a no-op instead of a TypeError.

export class Sfx {
  constructor() {
    this.ctx = null;         // AudioContext, null until ensure()
    this.master = null;      // root gain — the whole mix hangs off it
    this.musicGain = null;   // ambient loop sub-gain (the radio keeps its own bus)
    this.musicTimer = null;  // interval id of the ambient scheduler
    this._step = 0;          // ambient loop step counter
    this._engineOsc = null;
    this._engineGain = null;
    this._sirenOsc = null;
    this._sirenGain = null;
  }

  // Build the context + bus graph. Safe to call repeatedly.
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

  // Master volume in [0, 1] — one knob for the whole mix. setTargetAtTime
  // rather than a hard set, so a volume change never clicks.
  setVolume(v) {
    if (!this.master) return;
    const level = Math.max(0, Math.min(1, v));
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(level * 0.5, t, 0.08);
  }

  // Stop every long-lived oscillator so a paused or staged session leaves no
  // hum behind. One-shot nodes stop themselves; only these need a hand.
  dispose() {
    if (this.musicTimer) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
    this._step = 0;
    for (const node of [this._engineOsc, this._sirenOsc]) {
      try { node?.stop(); } catch { /* already stopped */ }
    }
    this._engineOsc = null;
    this._engineGain = null;
    this._sirenOsc = null;
    this._sirenGain = null;
  }

  // Enveloped one-shot tone; slideTo bends the pitch down for impacts.
  _tone(freq, dur, type = 'square', gain = 0.2, dest = null, slideTo = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
    // A 5 ms fade-in kills the click a step edge produces, then an exponential
    // tail decays out.
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env);
    env.connect(dest || this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // Decaying noise burst through a lowpass — the basis of every percussive hit.
  _noise(dur, gain = 0.3, filterFreq = 1200) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const env = this.ctx.createGain();
    env.gain.value = gain;
    src.connect(filter);
    filter.connect(env);
    env.connect(this.master);
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

  // Per-frame engine drone: one persistent sawtooth retuned to speed. The gain
  // gates to zero at idle so the sound settles instead of whispering forever.
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
    const t = this.ctx.currentTime;
    this._engineOsc.frequency.setTargetAtTime(55 + speedRatio * 130, t, 0.08);
    this._engineGain.gain.setTargetAtTime(speedRatio > 0.02 ? 0.05 : 0, t, 0.15);
  }

  engineOff() {
    if (this._engineGain && this.ctx) {
      this._engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1);
    }
  }

  crash() {
    this._noise(0.3, 0.6, 900);
    this._tone(70, 0.25, 'sawtooth', 0.3, null, 40);
  }

  pickup() {
    this._tone(660, 0.09, 'square', 0.22);
    this._tone(990, 0.12, 'square', 0.18);
  }

  // Cash register sting; the second note rides a timer for the "cha-ching" gap.
  cash() {
    if (!this.ctx) return;
    this._tone(880, 0.07, 'square', 0.2);
    setTimeout(() => {
      if (this.ctx) this._tone(1320, 0.09, 'square', 0.2);
    }, 70);
  }

  wantedUp() {
    this._tone(440, 0.18, 'square', 0.25, null, 220);
  }

  // Wailing siren while wanted > 0. The sweep phase derives from clock time, so
  // calling this every frame yields one continuous wail, not restarts.
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
      // Continue the wail from wherever it was instead of snapping the pitch.
      const current = this._sirenOsc.frequency.value;
      this._sirenOsc.frequency.cancelScheduledValues(t);
      this._sirenOsc.frequency.setValueAtTime(current, t);
      // Sweep bounds: LOW→HIGH across the first half of the period, back down
      // across the second, so per-frame calls weave one continuous wail.
      const low = 700;
      const high = 1500;
      const period = 1.8;
      const span = high - low;
      const phase = (t % period) / period;
      const target = phase < 0.5 ? low + span * (phase / 0.5) : high - span * ((phase - 0.5) / 0.5);
      this._sirenOsc.frequency.linearRampToValueAtTime(target, t + 0.05);
    } else if (!on && this._sirenOsc) {
      this._sirenOsc.stop();
      this._sirenOsc = null;
    }
  }

  // Ambient synthwave loop: bass + arp on an interval scheduler, faded in
  // slowly so unmuting never pops. Beats are skipped while the context is
  // suspended, so a paused tab resumes in step instead of dumping a burst.
  _startMusic() {
    const bpm = 96;
    const stepDur = 60 / bpm / 2;
    const bass = [55, 55, 65.4, 55, 49, 49, 58.3, 49];
    const arp = [220, 277, 330, 277, 196, 247, 294, 247];
    const t = this.ctx.currentTime;
    this.musicGain.gain.setValueAtTime(0.0001, t);
    this.musicGain.gain.exponentialRampToValueAtTime(0.16, t + 2.5);
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
