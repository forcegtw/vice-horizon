// radio.js — procedural in-car radio for Vice Horizon.
//
// Every station is a tiny WebAudio sequencer (bass line, lead arp, drums) with
// its own scale, tempo and waveforms — no audio files. The radio only plays
// while the player is in a car; J / Shift-J cycle stations, K toggles mute,
// and hud.js reads Radio.label() for the station name.
//
// Design rules:
//   - Radio owns its oscillators and never writes to the DOM.
//   - The radio bus is its own gain node (0.12) connected to sfx.master, so
//     station music ducks under sirens and never touches Sfx.musicGain.
//   - start() honours the mute toggle: unpausing a muted radio must not
//     resurrect a silent scheduler.
//   - stop() resets the lookahead clock so a long pause cannot make the next
//     resume dump a burst of overdue oscillators; MAX_CATCHUP_STEPS additionally
//     caps how far behind a throttled tab may catch up per scheduler tick.

const STATIONS = [
  {
    id: 'wave', name: 'WAVE 103', bpm: 104,
    wave: 'sawtooth', lead: 'square',
    scale: [0, 3, 7, 10, 12, 15],            // minor pentatonic-ish synthwave
    root: 55, pattern: [0, 0, 3, 0, 5, 4, 3, 2],
  },
  {
    id: 'flash', name: 'FLASH FM', bpm: 132,
    wave: 'square', lead: 'triangle',
    scale: [0, 2, 4, 7, 9, 12],              // bright major pop
    root: 65.4, pattern: [0, 4, 2, 5, 1, 3, 4, 0],
  },
  {
    id: 'bass', name: 'K-CHAT', bpm: 88,
    wave: 'triangle', lead: 'sine',
    scale: [0, 5, 7, 10, 12, 17],            // laid-back talk-radio groove
    root: 49, pattern: [0, 2, 1, 3, 2, 4, 1, 0],
  },
  {
    id: 'off', name: 'RADIO OFF', bpm: 0,
    wave: null, lead: null, scale: [], root: 0, pattern: [],
  },
];

const STEPS_PER_BAR = 8;
const LOOKAHEAD_MS = 90;
const TICK_MS = 40;
const MAX_CATCHUP_STEPS = 16;
const BUS_VOLUME = 0.12;

export class Radio {
  constructor(sfx) {
    this.sfx = sfx;
    this.stationIndex = 0;
    this.step = 0;
    this.timer = null;
    this.nextTime = 0;
    this.active = false;    // true while the player is in a car
    this.enabled = true;    // player mute toggle (K)
    this.gain = null;       // radio bus, lazily created off sfx.ctx
  }

  // One gain node for the whole radio, created only when audio exists.
  _ensureBus() {
    if (!this.sfx.ctx || this.gain) return;
    this.gain = this.sfx.ctx.createGain();
    this.gain.gain.value = BUS_VOLUME;
    this.gain.connect(this.sfx.master);
  }

  station() { return STATIONS[this.stationIndex]; }

  // Enter / leave a car. Idempotent: re-calling with the same state is a no-op.
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
    if (!this.enabled) return;      // muted: never start a silent scheduler
    this._ensureBus();
    this.nextTime = this.sfx.ctx.currentTime + 0.05;
    this.step = 0;
    this.timer = setInterval(() => this._schedule(), TICK_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextTime = 0;   // discard accumulated lookahead before the next resume
  }

  // Station cycling. Both directions wrap, including the RADIO OFF slot, and
  // restart the sequencer only when the new station actually plays.
  next() {
    this.stationIndex = (this.stationIndex + 1) % STATIONS.length;
    return this._retune();
  }

  prev() {
    this.stationIndex = (this.stationIndex + STATIONS.length - 1) % STATIONS.length;
    return this._retune();
  }

  _retune() {
    this.step = 0;
    this.stop();
    if (this.active && this.enabled && this.station().id !== 'off') this.start();
    return this.station().name;
  }

  toggleMute() {
    this.enabled = !this.enabled;
    if (!this.enabled) {
      this.stop();
    } else if (this.active && this.station().id !== 'off') {
      this.start();
    }
    return this.enabled;
  }

  // Sequencer: schedule audio-graph events up to LOOKAHEAD ahead of "now",
  // with a hard cap on steps per tick so catch-up after a throttled tab can
  // never spike the audio thread.
  _schedule() {
    if (!this.sfx.ctx || !this.gain) return;
    if (this.sfx.ctx.state !== 'running') return;
    const st = this.station();
    if (st.id === 'off') { this.stop(); return; }
    const stepDur = 60 / st.bpm / 2;   // eighth notes
    let guard = 0;
    while (
      this.nextTime < this.sfx.ctx.currentTime + LOOKAHEAD_MS / 1000 &&
      guard++ < MAX_CATCHUP_STEPS
    ) {
      const s = this.step % STEPS_PER_BAR;
      const t = this.nextTime;
      // Bass: root-driven pattern with a gated envelope.
      const deg = st.scale[st.pattern[s] % st.scale.length];
      this._blip(st.root * Math.pow(2, deg / 12), stepDur * 1.7, st.wave, 0.5, t);
      // Lead arp one octave up, quieter, skipping every third step for lift.
      if (s % 3 !== 2) {
        const li = (this.step * 5) % st.scale.length;
        this._blip(st.root * 4 * Math.pow(2, st.scale[li] / 12), stepDur * 0.8, st.lead, 0.16, t);
      }
      // Hats on off-beats, kick on downbeats.
      if (s % 2 === 1) this._hat(t);
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
    o.connect(g);
    g.connect(this.gain);
    o.start(when);
    o.stop(when + dur + 0.02);
  }

  // Closed hi-hat: short decaying noise burst through a highpass.
  _hat(when) {
    if (!this.sfx.ctx || !this.gain) return;
    const len = Math.floor(this.sfx.ctx.sampleRate * 0.04);
    const buf = this.sfx.ctx.createBuffer(1, len, this.sfx.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = this.sfx.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.sfx.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 6000;
    const g = this.sfx.ctx.createGain();
    g.gain.value = 0.35;
    src.connect(f);
    f.connect(g);
    g.connect(this.gain);
    src.start(when);
  }

  // Kick: pitch-dropping sine, the classic 140 Hz → 45 Hz thump.
  _kick(when) {
    if (!this.sfx.ctx || !this.gain) return;
    const o = this.sfx.ctx.createOscillator();
    const g = this.sfx.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, when);
    o.frequency.exponentialRampToValueAtTime(45, when + 0.12);
    g.gain.setValueAtTime(0.5, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.14);
    o.connect(g);
    g.connect(this.gain);
    o.start(when);
    o.stop(when + 0.16);
  }

  // Station-change sting: a quick rising arpeggio of the station's scale.
  jingle() {
    const st = this.station();
    if (st.id === 'off' || !this.sfx.ctx) return;
    const t0 = this.sfx.ctx.currentTime;
    st.scale.slice(0, 4).forEach((deg, i) => {
      this._blip(st.root * 8 * Math.pow(2, deg / 12), 0.1, 'square', 0.2, t0 + i * 0.07);
    });
  }

  // HUD readout. Empty string when on foot; explicit label when muted.
  label() {
    if (!this.active) return '';
    if (!this.enabled) return '🔇 Muted';
    return '📻 ' + this.station().name;
  }
}
