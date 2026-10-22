// WebAudio engine: procedural sound effects and generative ambient music. No audio files are shipped.
import { composePhrase, midiToHz } from '../core/music.js';
import { BLOCKS } from '../core/blocks.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.vol = { music: 0.6, sfx: 0.8 };
    this.mood = 'day';
    this.listener = { x: 0, y: 0, z: 0, yaw: 0 };
    this._timer = 0;
    this._nextPhrase = 0;
    this._musicOn = false;
  }

  /** Must be called from a user gesture at least once (iOS/Chrome autoplay rules). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }
      this._build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  _build() {
    const c = this.ctx;
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.ratio.value = 4;
    this.master = c.createGain(); this.master.gain.value = 0.9;
    this.sfxBus = c.createGain(); this.musicBus = c.createGain();
    this.sfxBus.connect(this.master); this.musicBus.connect(this.master);
    this.master.connect(this.comp); this.comp.connect(c.destination);
    this.setVolumes(this.vol);

    // reverb from generated noise
    const len = Math.floor(c.sampleRate * 3.2);
    const ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    this.reverb = c.createConvolver(); this.reverb.buffer = ir;
    this.reverbGain = c.createGain(); this.reverbGain.gain.value = 0.55;
    this.reverb.connect(this.reverbGain); this.reverbGain.connect(this.musicBus);
    this.delay = c.createDelay(1.5); this.delay.delayTime.value = 0.46;
    const fb = c.createGain(); fb.gain.value = 0.34;
    const dlp = c.createBiquadFilter(); dlp.type = 'lowpass'; dlp.frequency.value = 2400;
    this.delay.connect(dlp); dlp.connect(fb); fb.connect(this.delay);
    dlp.connect(this.reverb); dlp.connect(this.musicBus);

    // 1s of white noise reused by every sound effect
    const nl = c.sampleRate;
    this.noise = c.createBuffer(1, nl, c.sampleRate);
    const nd = this.noise.getChannelData(0);
    for (let i = 0; i < nl; i++) nd[i] = Math.random() * 2 - 1;
    this.startMusic();
  }

  setVolumes(v) {
    Object.assign(this.vol, v);
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.sfxBus.gain.setTargetAtTime(this.vol.sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.vol.music * 0.8, t, 0.2);
  }

  setListener(x, y, z, yaw) { this.listener.x = x; this.listener.y = y; this.listener.z = z; this.listener.yaw = yaw; }
  setMood(m) { this.mood = m; }
  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }

  // -------------------------------------------------------------- primitives
  _gainAt(pos) {
    if (!pos) return { g: 1, pan: 0 };
    const l = this.listener;
    const dx = pos.x - l.x, dy = pos.y - l.y, dz = pos.z - l.z;
    const d = Math.hypot(dx, dy, dz);
    const rx = Math.cos(l.yaw), rz = -Math.sin(l.yaw);
    const pan = d > 0.3 ? clamp((dx * rx + dz * rz) / d, -1, 1) * 0.7 : 0;
    return { g: 1 / (1 + d * 0.12), pan };
  }

  _out(g, pan) {
    const c = this.ctx;
    if (c.createStereoPanner && pan) {
      const p = c.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(this.sfxBus);
    } else g.connect(this.sfxBus);
  }

  _noise({ dur = 0.15, type = 'bandpass', freq = 1500, q = 1, gain = 0.3, attack = 0.002, sweep = 0, delay = 0, pos = null, rate = 1 }) {
    const c = this.ctx; if (!c) return;
    const { g: dist, pan } = this._gainAt(pos);
    const t = c.currentTime + delay;
    const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true; src.playbackRate.value = rate;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweep), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain * dist, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); this._out(g, pan);
    src.start(t, Math.random() * 0.8); src.stop(t + dur + 0.05);
  }

  _tone({ freq = 440, to = 0, type = 'sine', dur = 0.15, gain = 0.2, attack = 0.003, delay = 0, pos = null, lp = 0 }) {
    const c = this.ctx; if (!c) return;
    const { g: dist, pan } = this._gainAt(pos);
    const t = c.currentTime + delay;
    const o = c.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain * dist, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); node = f; }
    node.connect(g); this._out(g, pan);
    o.start(t); o.stop(t + dur + 0.05);
  }

  // ----------------------------------------------------------------- effects
  /** Break / place / step for a block material ('stone','grass','sand','wood','leaves','water'). */
  material(kind, action, pos) {
    if (!this.ctx) return;
    const loud = action === 'break' ? 1 : action === 'place' ? 0.8 : 0.35;
    const j = 0.88 + Math.random() * 0.25; // pitch jitter
    switch (kind) {
      case 'stone':
        this._noise({ dur: 0.14, freq: 2400 * j, q: 1.4, gain: 0.34 * loud, pos });
        this._tone({ freq: 210 * j, to: 90, type: 'square', dur: 0.09, gain: 0.07 * loud, pos, lp: 900 });
        break;
      case 'wood':
        this._tone({ freq: 200 * j, to: 105, dur: 0.16, gain: 0.34 * loud, pos });
        this._noise({ dur: 0.09, freq: 800 * j, q: 0.9, gain: 0.2 * loud, pos });
        break;
      case 'leaves':
        for (let i = 0; i < 3; i++) this._noise({ dur: 0.1, freq: (3200 + i * 500) * j, q: 0.6, gain: 0.16 * loud, delay: i * 0.035, pos });
        break;
      case 'sand':
        this._noise({ dur: 0.2, type: 'bandpass', freq: 3200 * j, q: 0.5, gain: 0.22 * loud, pos });
        break;
      case 'water':
        this._noise({ dur: 0.28, type: 'lowpass', freq: 1400, sweep: 400, q: 0.7, gain: 0.25 * loud, pos });
        break;
      default: // grass / dirt
        this._noise({ dur: 0.17, type: 'lowpass', freq: 950 * j, q: 0.8, gain: 0.42 * loud, pos });
        this._tone({ freq: 140 * j, to: 80, dur: 0.1, gain: 0.08 * loud, pos });
    }
  }

  forBlock(id, action, pos) {
    const b = BLOCKS[id];
    this.material(b ? b.sound : 'stone', action, pos);
  }

  pickup() { this._tone({ freq: 520, to: 1100, dur: 0.09, gain: 0.13 }); this._tone({ freq: 780, to: 1500, dur: 0.07, gain: 0.05, delay: 0.03 }); }
  craft() {
    this._tone({ freq: midiToHz(76), type: 'triangle', dur: 0.5, gain: 0.14 });
    this._tone({ freq: midiToHz(81), type: 'sine', dur: 0.7, gain: 0.12, delay: 0.09 });
    this._tone({ freq: midiToHz(88), type: 'sine', dur: 0.5, gain: 0.05, delay: 0.09 });
  }
  click() { this._tone({ freq: 760, type: 'square', dur: 0.025, gain: 0.04 }); }
  open() { this._tone({ freq: 330, to: 520, type: 'triangle', dur: 0.1, gain: 0.07 }); }
  close() { this._tone({ freq: 520, to: 300, type: 'triangle', dur: 0.1, gain: 0.07 }); }
  jump() { this._noise({ dur: 0.05, type: 'highpass', freq: 1200, gain: 0.05 }); }
  land(speed, below) {
    const s = clamp((speed - 8) / 20, 0.15, 1);
    this._tone({ freq: 90, to: 45, dur: 0.18, gain: 0.3 * s });
    const b = BLOCKS[below];
    this.material(b ? b.sound : 'grass', 'step');
  }
  hurt(amount = 1) {
    const k = clamp(amount / 6, 0.5, 1.4);
    this._tone({ freq: 190, to: 70, type: 'sawtooth', dur: 0.2, gain: 0.2 * k, lp: 900 });
    this._noise({ dur: 0.12, type: 'lowpass', freq: 700, gain: 0.28 * k });
  }
  eat() {
    for (let i = 0; i < 4; i++) {
      this._noise({ dur: 0.07, type: 'bandpass', freq: 1700 + Math.random() * 900, q: 1.1, gain: 0.3, delay: i * 0.11 });
      this._tone({ freq: 150 + Math.random() * 40, to: 90, dur: 0.06, gain: 0.07, delay: i * 0.11 });
    }
  }
  death() {
    [midiToHz(57), midiToHz(53), midiToHz(48)].forEach((f, i) => this._tone({ freq: f, to: f * 0.92, type: 'triangle', dur: 1.1, gain: 0.16, attack: 0.02, delay: i * 0.28, lp: 1400 }));
    this._tone({ freq: 80, to: 36, dur: 0.9, gain: 0.35 });
  }
  /** A tree shooting up from a sapling: rustle and a rising chime. */
  grow(pos) {
    if (!this.ctx) return;
    for (let i = 0; i < 6; i++) this._noise({ dur: 0.16, freq: 3000 + i * 260, q: 0.6, gain: 0.13, delay: i * 0.06, pos });
    [72, 76, 79, 84].forEach((m, i) => this._tone({ freq: midiToHz(m), type: 'sine', dur: 0.6, gain: 0.07, delay: 0.05 + i * 0.09, pos }));
  }
  right() {
    [72, 76, 79, 84].forEach((m, i) => this._tone({ freq: midiToHz(m), type: 'triangle', dur: 0.4, gain: 0.13, delay: i * 0.08 }));
  }
  wrong() {
    this._tone({ freq: 220, to: 160, type: 'square', dur: 0.22, gain: 0.08, lp: 900 });
    this._tone({ freq: 165, to: 110, type: 'square', dur: 0.32, gain: 0.08, lp: 900, delay: 0.2 });
  }
  /** The 3 second fuse: a hiss with beeps that speed up. */
  fuse(pos) {
    if (!this.ctx) return;
    this._noise({ dur: 3, type: 'highpass', freq: 2600, sweep: 6200, q: 0.7, gain: 0.16, attack: 0.05, pos });
    [0, 0.7, 1.4, 1.95, 2.4, 2.7, 2.88].forEach((t) => this._tone({ freq: 880, type: 'square', dur: 0.07, gain: 0.07, delay: t, pos, lp: 3000 }));
  }
  boom(pos) {
    if (!this.ctx) return;
    this._tone({ freq: 78, to: 24, dur: 1.1, gain: 0.7, pos });
    this._noise({ dur: 0.9, type: 'lowpass', freq: 1400, sweep: 120, q: 0.6, gain: 0.8, attack: 0.004, pos });
    this._noise({ dur: 0.35, type: 'bandpass', freq: 2600, q: 0.5, gain: 0.35, attack: 0.002, pos });
    for (let i = 0; i < 6; i++) this._noise({ dur: 0.15, freq: 900 + Math.random() * 900, q: 0.7, gain: 0.2, delay: 0.25 + i * 0.1, pos });
  }
  deny() { this._tone({ freq: 150, to: 110, type: 'square', dur: 0.09, gain: 0.05, lp: 700 }); }
  toolBreak() {
    this._noise({ dur: 0.25, freq: 1800, q: 1, gain: 0.3 });
    this._tone({ freq: 500, to: 120, type: 'sawtooth', dur: 0.3, gain: 0.1, lp: 1500 });
  }

  treeFall(pos) {
    if (!this.ctx) return;
    // groaning creak with crackles
    this._tone({ freq: 95, to: 62, type: 'sawtooth', dur: 1.1, gain: 0.1, attack: 0.15, lp: 520, pos });
    this._tone({ freq: 140, to: 80, type: 'sawtooth', dur: 0.9, gain: 0.05, attack: 0.2, lp: 420, delay: 0.1, pos });
    for (let i = 0; i < 7; i++) this._noise({ dur: 0.05, freq: 1500 + Math.random() * 2500, q: 2, gain: 0.18, delay: 0.05 + Math.random() * 0.9, pos });
    for (let i = 0; i < 5; i++) this._noise({ dur: 0.18, freq: 3000, q: 0.6, gain: 0.1, delay: 0.2 + i * 0.13, pos });
  }
  treeLand(pos) {
    if (!this.ctx) return;
    this._tone({ freq: 74, to: 36, dur: 0.55, gain: 0.55, pos });
    this._noise({ dur: 0.4, type: 'lowpass', freq: 500, gain: 0.5, pos });
    for (let i = 0; i < 6; i++) this._noise({ dur: 0.14, freq: 3400, q: 0.6, gain: 0.14, delay: 0.05 + i * 0.045, pos });
  }

  // ------------------------------------------------------------------ music
  startMusic() {
    if (this._musicOn || !this.ctx) return;
    this._musicOn = true;
    this._nextPhrase = this.ctx.currentTime + 3;
    this._timer = setInterval(() => this._tick(), 500);
  }

  _tick() {
    const c = this.ctx;
    if (!c || c.state !== 'running' || this.vol.music < 0.01) return;
    if (c.currentTime >= this._nextPhrase) this.playPhrase();
  }

  playPhrase(seed = (Math.random() * 1e9) | 0) {
    const c = this.ctx; if (!c) return null;
    const p = composePhrase(seed, this.mood);
    const t0 = c.currentTime + 0.15;
    for (const e of p.events) this._note(e, t0 + e.t);
    this._nextPhrase = t0 + p.duration + 22 + Math.random() * 50; // generous silence between phrases
    return p;
  }

  _note(e, when) {
    const c = this.ctx;
    const f = midiToHz(e.midi);
    const end = when + e.dur;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, when);
    let stopAt = end + 0.5;
    const oscs = [];
    if (e.voice === 'pad') {
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1300; lp.Q.value = 0.4;
      const a = c.createOscillator(); a.type = 'sine'; a.frequency.value = f;
      const b = c.createOscillator(); b.type = 'triangle'; b.frequency.value = f * 1.004;
      const bg = c.createGain(); bg.gain.value = 0.5;
      a.connect(lp); b.connect(bg); bg.connect(lp); lp.connect(g);
      g.gain.linearRampToValueAtTime(e.vel, when + 1.8);
      g.gain.setValueAtTime(e.vel, Math.max(when + 1.8, end - 0.2));
      g.gain.linearRampToValueAtTime(0.0001, end + 2.2);
      stopAt = end + 2.4;
      oscs.push(a, b);
      g.connect(this.reverb); g.connect(this.musicBus);
    } else if (e.voice === 'bass') {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      o.connect(g);
      g.gain.linearRampToValueAtTime(e.vel, when + 0.06);
      g.gain.exponentialRampToValueAtTime(0.0001, end + 0.4);
      oscs.push(o);
      g.connect(this.musicBus);
    } else {
      // soft felt-piano lead: fundamental + decaying harmonics, sent to delay and reverb
      const mix = c.createGain(); mix.connect(g);
      [[1, 'triangle', 0.9], [2, 'sine', 0.28], [3, 'sine', 0.1]].forEach(([m, type, amp]) => {
        const o = c.createOscillator(); o.type = type; o.frequency.value = f * m;
        const og = c.createGain(); og.gain.value = amp;
        og.gain.setValueAtTime(amp, when);
        og.gain.exponentialRampToValueAtTime(amp * 0.05, when + 1.0 + 0.6 / m);
        o.connect(og); og.connect(mix); oscs.push(o);
      });
      g.gain.linearRampToValueAtTime(e.vel, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, end + 1.4);
      stopAt = end + 1.6;
      g.connect(this.musicBus); g.connect(this.delay); g.connect(this.reverb);
    }
    for (const o of oscs) { o.start(when); o.stop(stopAt); }
  }
}
