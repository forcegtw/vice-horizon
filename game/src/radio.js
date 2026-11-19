// Radio: in-car radio for Vice Horizon. Procedural chiptune stations built on
// WebAudio — every station is a tiny sequencer (bass line, lead arp, drums)
// with its own scale, tempo and waveform, so switching stations audibly changes
// the mood without any audio files. The radio only plays while the player is
// in a car; J / Shift-J cycle stations, K mutes, and the HUD gets the station
// name via Radio.label(). All scheduling runs on the shared Sfx context.
// Design rule: Radio owns its oscillators and never writes to the DOM — the
// HUD readout is dirty-checked in hud.js.
// start() honors the mute toggle so unpausing a muted radio cannot resurrect a
// silent scheduler, and stop() resets the lookahead clock so a long pause
// doesn't make the next resume schedule a burst of overdue steps.

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

const LOOKAHEAD_MS = 90;   // schedule this far ahead
const TICK_MS = 40;        // scheduler interval

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

  // Radio bus: one gain node per radio so station music ducks under sirens
  // and never routes through Sfx.musicGain (the ambient loop keeps its own).
  _ensureBus() {
    if (!this.sfx.ctx || this.gain) return;
    this.gain = this.sfx.ctx.createGain();
    this.gain.gain.value = 0.12;
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
    if (!this.enabled) return; // muted: a resume must not start a silent scheduler
    this._ensureBus();
    this.nextTime = this.sfx.ctx.currentTime + 0.05;
    this.step = 0;
    this.timer = setInterval(() => this._schedule(), TICK_MS);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Drop any lookahead that accumulated while stopped, so the next start()
    // resumes at "now" instead of dumping a burst of overdue steps.
    this.nextTime = 0;
  }

  // Cycle to the next station; restarts the sequencer if it changes.
  next() {
    this.stationIndex = (this.stationIndex + 1) % STATIONS.length;
    this.step = 0;
    this.stop();
    if (this.active && this.enabled && this.station().id !== 'off') this.start();
    return this.station().name;
  }

  prev() {
    this.stationIndex = (this.stationIndex + STATIONS.length - 1) % STATIONS.length;
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
    if (!this.sfx.ctx || !this.gain) return;
    if (this.sfx.ctx.state !== 'running') return;
    const st = this.station();
    if (st.id === 'off') { this.stop(); return; }
    const stepDur = 60 / st.bpm / 2;
    // Hard cap on catch-up steps: a throttled background tab can fall far behind,
    // and scheduling hundreds of overdue oscillators at once spikes the audio thread.
    let guard = 0;
    while (this.nextTime < this.sfx.ctx.currentTime + LOOKAHEAD_MS / 1000 && guard++ < 16) {
      const s = this.step % 8;
      const t = this.nextTime;
      // Bass: root-driven pattern, gated envelope on the radio bus.
      this._blip(st.root * Math.pow(2, st.scale[st.pattern[s] % st.scale.length] / 12),
        stepDur * 1.7, st.wave, 0.5, t);
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
    if (!this.sfx.ctx || !this.gain) return;
    const o = this.sfx.ctx.createOscillator();
    const g = this.sfx.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, when);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    o.connect(g); g.connect(this.gain);
    o.start(when); o.stop(when + dur + 0.02);
  }

  _hat(when, stepDur) {
    if (!this.sfx.ctx) return;
    const len = Math.floor(this.sfx.ctx.sampleRate * 0.04);
    const buf = this.sfx.ctx.createBuffer(1, len, this.sfx.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.sfx.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.sfx.ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 6000;
    const g = this.sfx.ctx.createGain(); g.gain.value = 0.35;
    src.connect(f); f.connect(g); g.connect(this.gain);
    src.start(when);
  }

  _kick(when) {
    if (!this.sfx.ctx) return;
    const o = this.sfx.ctx.createOscillator();
    const g = this.sfx.ctx.createGain();
    // Pitch-dropping sine: the classic 140 Hz -> 45 Hz thump.
    o.type = 'sine';
    o.frequency.setValueAtTime(140, when);
    o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    g.gain.setValueAtTime(0.5, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.14);
    o.connect(g); g.connect(this.gain);
    o.start(when); o.stop(when + 0.16);
  }

  // Station jingle: quick arpeggio sting played when a station is selected.
  jingle() {
    const st = this.station();
    if (st.id === 'off' || !this.sfx.ctx) return;
    const t0 = this.sfx.ctx.currentTime;
    st.scale.slice(0, 4).forEach((deg, i) => {
      this._blip(st.root * 8 * Math.pow(2, deg / 12), 0.1, 'square', 0.2, t0 + i * 0.07);
    });
  }

  // HUD readout.
  label() {
    if (!this.active) return '';
    if (!this.enabled) return '🔇 Muted';
    return '📻 ' + this.station().name;
  }
}
