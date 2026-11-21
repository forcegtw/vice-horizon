// sfx.js — the WebAudio synth rack. No audio files ship with the game; every
// sound is generated at runtime from oscillators and shaped noise.
//
// House rules:
//   * The AudioContext is built lazily on the first user gesture (browsers
//     refuse audio before one), and everything routes through one master
//     gain so volume stays a single knob.
//   * Tones use a short attack and exponential decay — a raw step edge reads
//     as a click, not a sound.
//   * The engine and siren are persistent oscillators retuned in place each
//     frame, never rebuilt; per-frame node churn is what pops and crackles.
//   * dispose() stops every long-lived node so a paused or staged session
//     leaves no hum behind.
//   * cash() guards a missing context: the reward sting can fire before the
//     first gesture, and that must be a no-op, not a TypeError.

// Tone attack in seconds — kills the click a raw step edge produces.
const TONE_ATTACK = 0.005;
// Siren wail period in seconds: the pitch sweeps 700 -> 1500 -> 700 Hz.
const SIREN_PERIOD = 1.4;
// Idle hum gate: below this speed ratio the engine oscillator goes silent.
const ENGINE_IDLE_GATE = 0.02;
// Music bed tempo and the fade-in window for its bus gain.
const MUSIC_BPM = 96;
const MUSIC_FADE_SECONDS = 2.5;
// Master gain ceiling: setVolume's [0, 1] level scales into this.
const MASTER_CEILING = 0.5;

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

  // Build the context + master chain on first gesture; repeat calls are free.
  ensure() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = MASTER_CEILING;
    this.master.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.16;
    this.musicGain.connect(this.master);
    this._startMusic();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // Whole-mix volume in [0, 1]. setTargetAtTime rather than a hard write so
  // a volume change never clicks.
  setVolume(v) {
    if (!this.master) return;
    const level = Math.max(0, Math.min(1, v));
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(level * MASTER_CEILING, this.ctx.currentTime, 0.08);
  }

  // Stop every long-lived oscillator and the music scheduler.
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
    this._sirenOsc = null;
  }

  // One enveloped oscillator tone; slideTo sweeps frequency exponentially.
  _tone(freq, dur, type = 'square', gain = 0.2, dest = null, slideTo = null) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + TONE_ATTACK);
    env.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(env);
    env.connect(dest || this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // Shaped white noise through a lowpass — impacts, gunfire, hats.
  _noise(dur, gain = 0.3, filterFreq = 1200) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const frames = Math.max(1, Math.floor(this.ctx.sampleRate * dur));
    const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
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

  // Persistent engine oscillator retuned to a speed ratio in [0, 1]; the
  // gain gates it to zero while parked so the hum never idles forever.
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
    const pitch = 55 + speedRatio * 130;
    this._engineOsc.frequency.setTargetAtTime(pitch, this.ctx.currentTime, 0.08);
    const running = speedRatio > ENGINE_IDLE_GATE ? 0.05 : 0;
    this._engineGain.gain.setTargetAtTime(running, this.ctx.currentTime, 0.15);
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

  // Continuous wail while on. The phase derives from clock time so repeated
  // per-frame calls ride one sweep instead of snapping back to the bottom.
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
      const phase = (t % SIREN_PERIOD) / SIREN_PERIOD;
      const half = phase < 0.5;
      const pitch = half ? 700 + 800 * (phase / 0.5) : 1500 - 800 * ((phase - 0.5) / 0.5);
      this._sirenOsc.frequency.linearRampToValueAtTime(pitch, t + 0.05);
    } else if (!on && this._sirenOsc) {
      this._sirenOsc.stop();
      this._sirenOsc = null;
    }
  }

  // Synthwave bed: bass, arp and hats over an 8-step loop, scheduled ahead by
  // an interval that matches the step duration. The bus gain fades in so
  // unmuting never pops.
  _startMusic() {
    const stepDur = 60 / MUSIC_BPM / 2;
    const bass = [55, 55, 65.4, 55, 49, 49, 58.3, 49];
    const arp = [220, 277, 330, 277, 196, 247, 294, 247];
    this.musicGain.gain.setValueAtTime(0.0001, this.ctx.currentTime);
    this.musicGain.gain.exponentialRampToValueAtTime(0.16, this.ctx.currentTime + MUSIC_FADE_SECONDS);
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
