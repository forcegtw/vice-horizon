// radio.js — the procedural in-car dial.
//
// Each station is a miniature WebAudio sequencer — bass line, lead arp, hats
// and kick — with its own scale, tempo and waveform pairing. No audio files:
// every note is synthesized at schedule time. The dial only spins while the
// player is behind the wheel; J / Shift-J step through stations, K mutes, and
// hud.js renders Radio.label() next to the clock.
//
// House rules this module keeps:
//   - Radio owns its oscillators and never touches the DOM.
//   - All station audio flows through one bus gain (BUS_VOLUME) connected to
//     sfx.master, so music ducks under sirens and never touches Sfx's own
//     musicGain.
//   - start() honours the mute toggle: unpausing a muted radio must not
//     resurrect a silent scheduler.
//   - stop() resets the lookahead clock, and MAX_CATCHUP_STEPS caps how far a
//     throttled tab may catch up per scheduler tick — neither a long pause
//     nor a backgrounded tab may ever dump a burst of overdue notes.

// The dial. `off` is a real slot so cycling can land on silence; its bpm of 0
// marks it as non-playing everywhere.
const DIAL = Object.freeze([
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
]);

const STEPS_PER_BAR = 8;          // eighth notes per bar
const AHEAD_MS = 90;              // scheduler lookahead
const POLL_MS = 40;               // scheduler tick interval
const CATCHUP_CAP = 16;           // max steps scheduled per tick
const BUS_VOLUME = 0.12;
const ARP_SKIP = 3;               // lead rests every ARP_SKIP-th step
const START_DELAY = 0.05;         // breathing room between start() and note 1

// One step = one eighth note.
function stepLength(bpm) {
  return 60 / bpm / 2;
}

export class Radio {
  constructor(sfx) {
    this.sfx = sfx;
    this.stationIndex = 0;
    this.step = 0;
    this.timer = null;
    this.nextTime = 0;
    this.active = false;    // true while the player sits in a car
    this.enabled = true;    // the K-key mute latch
    this.gain = null;       // radio bus, built lazily off sfx.ctx
  }

  // One bus gain for the whole dial; exists only when audio does.
  _ensureBus() {
    if (!this.sfx.ctx || this.gain) return;
    this.gain = this.sfx.ctx.createGain();
    this.gain.gain.value = BUS_VOLUME;
    this.gain.connect(this.sfx.master);
  }

  station() { return DIAL[this.stationIndex]; }

  // Enter / leave a car. Idempotent: re-calling with the same state is free.
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
    if (this.station().id === 'off') return;   // silence is not a scheduler
    if (!this.enabled) return;                 // muted: never schedule silently
    this._ensureBus();
    this.nextTime = this.sfx.ctx.currentTime + START_DELAY;
    this.step = 0;
    this.timer = setInterval(() => this._schedule(), POLL_MS);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.nextTime = 0;   // drop accumulated lookahead before the next resume
  }

  // Dial rotation. Both directions wrap (including RADIO OFF) and the
  // sequencer restarts only when the new station actually plays.
  next() {
    this.stationIndex = (this.stationIndex + 1) % DIAL.length;
    return this._retune();
  }

  prev() {
    this.stationIndex = (this.stationIndex + DIAL.length - 1) % DIAL.length;
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

  // Sequencer core: schedule notes up to AHEAD_MS ahead of "now", with a hard
  // cap on steps per tick so catch-up after a throttled tab stays a trickle.
  _schedule() {
    if (!this.sfx.ctx || !this.gain) return;
    if (this.sfx.ctx.state !== 'running') return;
    const st = this.station();
    if (st.id === 'off') { this.stop(); return; }
    const stepDur = stepLength(st.bpm);
    let guard = 0;
    while (
      this.nextTime < this.sfx.ctx.currentTime + AHEAD_MS / 1000 &&
      guard++ < CATCHUP_CAP
    ) {
      const s = this.step % STEPS_PER_BAR;
      const t = this.nextTime;
      // Bass: root-driven pattern through a gated envelope, every step.
      const deg = st.scale[st.pattern[s] % st.scale.length];
      this._voice(st.root * Math.pow(2, deg / 12), stepDur * 1.7, st.wave, 0.5, t);
      // Lead arp an octave up, quieter, resting every third step for lift.
      if (s % ARP_SKIP !== ARP_SKIP - 1) {
        const li = (this.step * 5) % st.scale.length;
        this._voice(st.root * 4 * Math.pow(2, st.scale[li] / 12), stepDur * 0.8, st.lead, 0.16, t);
      }
      // Hats ride the off-beats; the kick lands on downbeats.
      if (s % 2 === 1) this._cymbal(t);
      if (s % 4 === 0) this._thump(t);
      this.step++;
      this.nextTime += stepDur;
    }
  }

  // One enveloped oscillator note into the radio bus.
  _voice(freq, dur, type, vol, when) {
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

  // Closed hi-hat: a fading white-noise burst through a highpass.
  _cymbal(when) {
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

  // Kick: the classic pitch-dropping sine thump, 140 Hz down to 45 Hz.
  _thump(when) {
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

  // Station-change sting: a quick rising run through the station's scale.
  jingle() {
    const st = this.station();
    if (st.id === 'off' || !this.sfx.ctx) return;
    const t0 = this.sfx.ctx.currentTime;
    st.scale.slice(0, 4).forEach((deg, i) => {
      this._voice(st.root * 8 * Math.pow(2, deg / 12), 0.1, 'square', 0.2, t0 + i * 0.07);
    });
  }

  // HUD readout. Empty on foot; an explicit line while muted.
  label() {
    if (!this.active) return '';
    if (!this.enabled) return '🔇 Muted';
    return '📻 ' + this.station().name;
  }
}
