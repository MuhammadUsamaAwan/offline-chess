// Synthesized chess sound effects via the Web Audio API.
// No audio assets needed, so the app stays fully offline.

export class Sounds {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }

  // Lazily create/resume the audio context (must follow a user gesture).
  _ac() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  setEnabled(v) { this.enabled = v; }

  // A short tonal "knock".
  _tone(freq, dur, { type = 'sine', gain = 0.35, at = 0 } = {}) {
    const ac = this._ac();
    if (!ac) return;
    const t = ac.currentTime + at;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + dur);
  }

  // A filtered noise burst — gives moves/captures their "click".
  _noise(dur, { freq = 1200, q = 0.7, gain = 0.4, at = 0 } = {}) {
    const ac = this._ac();
    if (!ac) return;
    const t = ac.currentTime + at;
    const frames = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, frames, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const filter = ac.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    filter.Q.value = q;
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(ac.destination);
    src.start(t);
    src.stop(t + dur);
  }

  move() {
    if (!this.enabled) return;
    this._tone(190, 0.07, { type: 'triangle', gain: 0.3 });
    this._noise(0.04, { freq: 1500, gain: 0.18 });
  }

  capture() {
    if (!this.enabled) return;
    this._noise(0.09, { freq: 900, q: 0.5, gain: 0.45 });
    this._tone(140, 0.09, { type: 'square', gain: 0.18 });
  }

  castle() {
    if (!this.enabled) return;
    this.move();
    this._tone(190, 0.06, { type: 'triangle', gain: 0.28, at: 0.09 });
    this._noise(0.04, { freq: 1500, gain: 0.16, at: 0.09 });
  }

  check() {
    if (!this.enabled) return;
    this._tone(880, 0.08, { type: 'sine', gain: 0.28 });
    this._tone(1180, 0.1, { type: 'sine', gain: 0.24, at: 0.08 });
  }

  promote() {
    if (!this.enabled) return;
    [523, 659, 784, 1047].forEach((f, i) =>
      this._tone(f, 0.12, { type: 'triangle', gain: 0.26, at: i * 0.06 }));
  }

  gameEnd() {
    if (!this.enabled) return;
    [784, 622, 523].forEach((f, i) =>
      this._tone(f, 0.22, { type: 'sine', gain: 0.3, at: i * 0.14 }));
  }
}
