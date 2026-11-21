// radio.js — the in-car dial for Vice Horizon. Four stations: three procedural
// chiptune sequencers (bass line, lead arp, drums) plus RADIO OFF, each with
// its own scale, tempo and waveforms, so flipping stations audibly changes
// the mood without shipping a single audio file. The radio only plays while
// the player is in a car; J / Shift-J cycle stations, K mutes, and the HUD
// polls Radio.label() for the readout. All scheduling runs on the shared Sfx
// audio context and clock.
//
// Rules this module keeps:
// - Radio owns its oscillators and a private bus gain, and never writes to
//   the DOM (hud.js dirty-checks the label) or to Sfx.musicGain — the ambient
//   loop keeps its own bus. The 0.12 bus level keeps the synth under the SFX
//   layer; the engine tone lives on master.
// - start() honours the mute toggle, so unpausing a muted radio cannot
//   resurrect a silent scheduler, and stop() resets the lookahead clock so a
//   long pause never resumes into a burst of overdue steps.
// - LOOKAHEAD bounds how far ahead steps are queued and the catch-up cap
//   bounds how many overdue steps one scheduler tick may queue, so neither a
//   slow frame nor a throttled background tab can spike the audio thread.

const STATIONS = [
  {
    id: 'wave', name: 'WAVE 103', bpm: 104,
    wave: 'sawtooth', lead: 'square',
    scale: [0, 3, 7, 10, 12, 15],       // minor pentatonic-ish synthwave
    root: 55, pattern: [0, 0, 3, 0, 5, 4, 3, 2],
  },
  {
    id: 'flash', name: 'FLASH FM', bpm: 132,
    wave: 'square', lead: 'triangle',
    scale: [0, 2, 4, 7, 9, 12],          // major, upbeat pop
    root: 65.4, pattern: [0, 4, 2, 5, 1, 3, 4, 0],
  },
  {
    id: 'bass', name: 'K-CHAT', bpm: 88,
    wave: 'triangle', lead: 'sine',
    scale: [0, 5, 7, 10, 12, 17],        // laid-back talk-radio groove
    root: 49, pattern: [0, 2, 1, 3, 2, 4, 1, 0],
  },
  {
    id: 'off', name: 'RADIO OFF', bpm: 0,
    wave: null, lead: null, scale: [], root: 0, pattern: [],
  },
];

const LOOKAHEAD_MS = 90;         // schedule this far ahead
const TICK_MS = 40;              // scheduler interval
const MAX_CATCHUP_STEPS = 16;    // hard cap on overdue steps queued per tick
const EIGHT_BEAT = 8;            // patterns are eight steps long
const BUS_GAIN = 0.12;           // radio bus level: synth ducks under the SFX layer

export class Radio {
  constructor(sfx) {
    this.sfx = sfx;
    this.stationIndex = 0;
    this.step = 0;
    this.timer = null;
    this.nextTime = 0;
    this.active = false;         // true while in a car
    this.enabled = true;         // player mute toggle
    this.gain = null;            // radio bus, lazily created off sfx.ctx
  }

  // Radio bus: one gain node per radio so station music ducks under sirens.
  _ensureBus() {
    if (!this.sfx.ctx || this.gain) return;
    this.gain = this.sfx.ctx.createGain();
    this.gain.gain.value = BUS_GAIN;
    this.gain.connect(this.sfx.master);
  }

  station() { return STATIONS[this.stationIndex]; }

  // Enter / leave a car.
  setInCar(inCar) {
    if (inCar === this.active) return;
    this.active = inCar;
    if (inCar) {
      this._ensureBus();
      this.start();
    } else {
      this.stop();
    }
  }

  start() {
    if (!this.sfx.ctx || this.timer) return;
    if (this.station().id === 'off') return;
    if (!this.enabled) return;   // muted: a resume must not start a silent scheduler
    this._ensureBus();
    this.nextTime = this.sfx.ctx.currentTime + 0.05;
    this.step = 0;
    this.timer = setInterval(() => this._schedule(), TICK_MS);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Drop any lookahead accumulated while stopped, so the next start()
    // resumes at "now" instead of dumping a burst of overdue steps.
    this.nextTime = 0;
  }

  // Cycle stations; restarts the sequencer only when the new station plays.
  next() { return this._tune(1); }
  prev() { return this._tune(-1); }
  _tune(dir) {
    const count = STATIONS.length;
    this.stationIndex = (this.stationIndex + dir + count) % count;
    this.step = 0;
    this.stop();
    if (this.active && this.enabled && this.station().id !== 'off') this.start();
    return this.station().name;
  }

  toggleMute() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.stop();
    else if (this.active && this.station().id !== 'off') this.start();
    return this.enabled;
  }

  _schedule() {
    const ctx = this.sfx.ctx;
    if (!ctx || !this.gain) return;
    if (ctx.state !== 'running') return;
    const st = this.station();
    if (st.id === 'off') { this.stop(); return; }
    const stepDur = 60 / st.bpm / 2;
    // Catch-up cap: a throttled background tab can fall far behind, and
    // queueing hundreds of overdue oscillators at once spikes the audio thread.
    let guard = 0;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD_MS / 1000 && guard++ < MAX_CATCHUP_STEPS) {
      const s = this.step % EIGHT_BEAT;
      const t = this.nextTime;
      // Bass: root-driven pattern, gated envelope on the radio bus.
      const bassDeg = st.scale[st.pattern[s] % st.scale.length];
      this._blip(st.root * Math.pow(2, bassDeg / 12), stepDur * 1.7, st.wave, 0.5, t);
      // Lead arp one octave up, quieter, skipping every 3rd step for syncopation.
      if (s % 3 !== 2) {
        const li = (this.step * 5) % st.scale.length;
        this._blip(st.root * 4 * Math.pow(2, st.scale[li] / 12), stepDur * 0.8, st.lead, 0.16, t);
      }
      // Hats on off-beats, kick on the downbeat.
      if (s % 2 === 1) this._hat(t, stepDur);
      if (s % 4 === 0) this._kick(t);
      this.step++;
      this.nextTime += stepDur;
    }
  }

  _blip(freq, dur, type, vol, when) {
    const ctx = this.sfx.ctx;
    if (!ctx || !this.gain) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(vol, when + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, when + dur);
    osc.connect(env);
    env.connect(this.gain);
    osc.start(when);
    osc.stop(when + dur + 0.02);
  }

  _hat(when, stepDur) {
    const ctx = this.sfx.ctx;
    if (!ctx) return;
    const len = Math.floor(ctx.sampleRate * 0.04);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const out = ctx.createGain();
    out.gain.value = 0.35;
    src.connect(hp);
    hp.connect(out);
    out.connect(this.gain);
    src.start(when);
  }

  _kick(when) {
    const ctx = this.sfx.ctx;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    // Pitch-dropping sine: the classic 140 Hz → 45 Hz thump.
    osc.type = 'sine';
    osc.frequency.setValueAtTime(140, when);
    osc.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    env.gain.setValueAtTime(0.5, when);
    env.gain.exponentialRampToValueAtTime(0.001, when + 0.14);
    osc.connect(env);
    env.connect(this.gain);
    osc.start(when);
    osc.stop(when + 0.16);
  }

  // Station jingle: a quick ascending arpeggio sting when a station is picked.
  jingle() {
    const st = this.station();
    if (st.id === 'off' || !this.sfx.ctx) return;
    const t0 = this.sfx.ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      const deg = st.scale[i];
      this._blip(st.root * 8 * Math.pow(2, deg / 12), 0.1, 'square', 0.2, t0 + i * 0.07);
    }
  }

  // HUD readout.
  label() {
    if (!this.active) return '';
    if (!this.enabled) return '🔇 Muted';
    return '📻 ' + this.station().name;
  }
}
