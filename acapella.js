/* acapella.js — a generative a cappella engine for DUALITY · CLOUDS
   Musical logic borrowed from the harmony system: just-intonation ratios built from perfect
   intervals, Fibonacci durations and phrase lengths, φ-timed echoes, a circle-of-fifths random
   walk for the key, and a seeded PRNG that never repeats — so every seed is a different piece
   and no piece ever loops.

   window.Acapella = { Sampler, Engine, loadBuffers, JUST, MODES, NOTE_NAMES } */
(function () {
  const PHI = (1 + Math.sqrt(5)) / 2;
  const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  // just intonation: semitones above the tonic → frequency ratio (perfect 4th/5th/octave exact)
  const JUST = [1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8];
  const MODES = {
    ionian: [0, 2, 4, 5, 7, 9, 11], dorian: [0, 2, 3, 5, 7, 9, 10], aeolian: [0, 2, 3, 5, 7, 8, 10],
    lydian: [0, 2, 4, 6, 7, 9, 11], mixolydian: [0, 2, 4, 5, 7, 9, 10], phrygian: [0, 1, 3, 5, 7, 8, 10]
  };
  // chord movement as a weighted Markov chain over scale degrees (0 = I … 6 = vii)
  const PROG = {
    0: [[3, 3], [4, 3], [5, 2], [1, 1], [2, 1]], 1: [[4, 4], [3, 1], [0, 1]], 2: [[5, 3], [3, 2], [1, 1]],
    3: [[4, 3], [0, 2], [1, 1], [5, 1]], 4: [[0, 4], [5, 2], [3, 1]], 5: [[3, 3], [1, 2], [4, 1], [0, 1]], 6: [[0, 3], [5, 1]]
  };
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
  const weighted = (r, pairs) => {
    let x = r() * pairs.reduce((s, p) => s + p[1], 0);
    for (const [v, w] of pairs) { x -= w; if (x <= 0) return v; }
    return pairs[pairs.length - 1][0];
  };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mtof = m => 440 * 2 ** ((m - 69) / 12);

  /* ---- loading ---- */
  async function loadBuffers(ctx, items, onProgress) {
    // items: [{ key, path }] → { key: AudioBuffer } (missing files are skipped, not fatal)
    const out = {}; let done = 0;
    await Promise.all(items.map(async it => {
      try {
        const r = await fetch(encodeURI(it.path));
        if (!r.ok) throw new Error(r.status);
        out[it.key] = await ctx.decodeAudioData(await r.arrayBuffer());
      } catch (e) { /* skipped */ }
      done++; onProgress && onProgress(done, items.length);
    }));
    return out;
  }

  /* ---- sampler: nearest-root zone, pitched by playback rate, optional loop + envelope ---- */
  class Sampler {
    constructor(ctx, out) { this.ctx = ctx; this.out = out; this.zones = []; this.rr = 0; }
    add(buffer, midi, opts = {}) { if (buffer) this.zones.push({ buffer, midi, f: mtof(midi), ...opts }); return this; }
    get ready() { return this.zones.length > 0; }
    play(freq, when, { vel = 0.7, dur = 1, attack = 0.005, release = 0.15, pan = 0, out = null } = {}) {
      if (!this.zones.length) return null;
      let best = null, bd = 1e9;
      for (const z of this.zones) { const d = Math.abs(Math.log2(freq / z.f)); if (d < bd) { bd = d; best = z; } }
      const rrs = this.zones.filter(z => z.midi === best.midi);   // round robins share a root
      const z = rrs[this.rr++ % rrs.length];
      const ctx = this.ctx, src = ctx.createBufferSource();
      src.buffer = z.buffer; src.playbackRate.value = freq / z.f;
      if (z.loop) { src.loop = true; src.loopStart = z.loop[0]; src.loopEnd = z.loop[1]; }
      const g = ctx.createGain(), end = when + dur;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(vel, when + attack);
      g.gain.setValueAtTime(vel, Math.max(when + attack, end));
      g.gain.linearRampToValueAtTime(0, end + release);
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      src.connect(g).connect(p).connect(out || this.out);
      src.start(when, z.offset || 0);
      src.stop(end + release + 0.05);
      return src;
    }
    // one-shot at native pitch (tape noises, prepared piano ticks)
    shot(key, when, { vel = 0.5, pan = 0, offset = 0, dur = null } = {}) {
      const z = this.zones.find(z => z.key === key); if (!z) return null;
      const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = z.buffer;
      const g = ctx.createGain(); g.gain.value = vel;
      const p = ctx.createStereoPanner(); p.pan.value = pan;
      src.connect(g).connect(p).connect(this.out);
      src.start(when, offset);
      if (dur) { g.gain.setValueAtTime(vel, when + dur - 0.3); g.gain.linearRampToValueAtTime(0, when + dur); src.stop(when + dur + 0.02); }
      return src;
    }
  }

  /* ---- the engine ---- */
  // three parts, mapped to the three swimmers: alto (left), soprano (centre), bass (right)
  const PARTS = [
    { name: 'alto',    lo: 52, hi: 67, durs: [2, 3, 5],     rest: 0.12, vel: 0.55 },
    { name: 'soprano', lo: 60, hi: 79, durs: [1, 2, 3, 5],  rest: 0.10, vel: 0.62 },
    { name: 'bass',    lo: 40, hi: 55, durs: [5, 8, 13],    rest: 0.05, vel: 0.6 }
  ];

  class Engine {
    /* opts: { ctx, bpm: () => number, sing(part, ev), onEvent(ev), instruments: { ep, toy, vox, tape }, enabled: () => ({ep,toy,tape}) } */
    constructor(opts) {
      this.o = opts; this.ctx = opts.ctx;
      this.setSeed(opts.seed || 1);
      this.timer = null; this.events = []; this.partEvents = [[], [], []];
    }
    setSeed(seed) {
      this.seed = seed; this.r = mulberry32(seed * 2654435761 >>> 0);
      const r = this.r;
      this.tonic = 45 + Math.floor(r() * 12);               // A2 … A♭3
      this.mode = pick(r, Object.keys(MODES));
      this.chord = 0;
      this.breath = 0.35 + r() * 0.4;                        // density / activity, random-walks over time
      this.phrase = 0;
      this.lastStep = PARTS.map(p => this.nearestStep(Math.round((p.lo + p.hi) / 2), 0));
      this.phraseEnd = 0;
      this.forceModulate = false;
      this.pullTo = null; this.pullStrength = 0.6;
    }
    get scale() { return MODES[this.mode]; }
    // "step" = absolute scale step number (octave * 7 + degree); midi/freq derive from it
    stepToMidi(s) { const d = ((s % 7) + 7) % 7, o = Math.floor(s / 7); return this.tonic + 12 * o + this.scale[d]; }
    stepToFreq(s) { const d = ((s % 7) + 7) % 7, o = Math.floor(s / 7); return mtof(this.tonic) * 2 ** o * JUST[this.scale[d]]; }
    nearestStep(midi, bias) {
      let best = 0, bd = 1e9;
      for (let s = -14; s < 35; s++) { const d = Math.abs(this.stepToMidi(s) - midi); if (d < bd) { bd = d; best = s; } }
      return best + (bias || 0);
    }
    chordTones() { return [0, 2, 4].map(k => (this.chord + k) % 7).concat(this.breath > 0.7 ? [(this.chord + 6) % 7] : []); }
    isChordTone(s) { return this.chordTones().includes(((s % 7) + 7) % 7); }
    snapToChord(s, lo, hi) {
      let best = s, bd = 1e9;
      for (let k = s - 6; k <= s + 6; k++) {
        const m = this.stepToMidi(k);
        if (m < lo || m > hi || !this.isChordTone(k)) continue;
        const d = Math.abs(k - s) + (k === s ? -0.5 : 0);
        if (d < bd) { bd = d; best = k; }
      }
      return best;
    }
    describe() {
      return `${NOTE_NAMES[this.tonic % 12]} ${this.mode} · ${ROMAN[this.chord]} · breath ${this.breath.toFixed(2)} · seed ${this.seed}`;
    }
    keyHue() { return ((this.tonic % 12) * 7 % 12) * 30; }   // circle of fifths → colour wheel

    /* one phrase for all parts + instruments; returns events with absolute ctx times */
    genPhrase(t0) {
      const r = this.r, beat = 60 / this.o.bpm();
      const L = weighted(r, [[5, 2], [8, 5], [13, 2]]);        // Fibonacci phrase lengths
      const evs = [];
      this.phrase++;
      // harmony moves first
      if (this.phrase > 1) this.chord = weighted(r, PROG[this.chord]);
      this.breath = clamp(this.breath + (r() - 0.5) * 0.25, 0.15, 1);
      // a modulation, sometimes: a fifth up or down (the tape machine marks it)
      const pulled = this.pullTo != null && this.pullTo.pc !== this.tonic % 12 && r() < this.pullStrength;
      if (this.phrase > 2 && (pulled || this.forceModulate || r() < 0.14)) {
        this.forceModulate = false;
        if (pulled) {
          // another piece is in a different key: go to it (the tape marks the moment)
          let t = 44 + ((this.pullTo.pc - 44) % 12 + 12) % 12;
          this.tonic = t;
          if (this.pullTo.mode && MODES[this.pullTo.mode]) this.mode = this.pullTo.mode;
          this.pullTo = null;
        } else {
          const dir = r() < 0.5 ? 7 : -7;
          let t = this.tonic + dir; if (t > 56) t -= 12; if (t < 44) t += 12;
          this.tonic = t;
          if (r() < 0.4) this.mode = pick(r, Object.keys(MODES));
        }
        this.chord = 0;
        evs.push({ kind: 'tape', t: t0 - 1.4 * beat, dur: 2.5 });
        this.lastStep = PARTS.map((p, i) => this.nearestStep(this.stepToMidi(this.lastStep[i]), 0));
      }
      // voices
      PARTS.forEach((p, i) => {
        let t = 0, s = this.lastStep[i];
        const rest = p.rest + (1 - this.breath) * 0.3;
        while (t < L - 1e-6) {
          let dur = pick(r, p.durs);
          if (i === 1 && r() < 0.3) dur *= 0.5;
          if (i === 2 && this.breath < 0.4 && r() < 0.5) dur = L;   // the bass holds a drone when it's quiet
          dur = Math.min(dur, L - t);
          if (r() < rest && t > 0) { t += dur; continue; }
          if (t === 0 || (!this.isChordTone(s) && r() < 0.6)) s = this.snapToChord(s, p.lo, p.hi);
          else {
            const mv = weighted(r, [[0, 15], [1, 25], [-1, 25], [2, 7], [-2, 7], [3, 5], [-3, 5], [4, 5], [-4, 6]]);
            s += mv;
            if (Math.abs(mv) >= 3) s = this.snapToChord(s, p.lo, p.hi);     // leaps land on chord tones
          }
          // keep in range by reflecting
          while (this.stepToMidi(s) > p.hi) s -= 7;
          while (this.stepToMidi(s) < p.lo) s += 7;
          const strong = t % 4 === 0;
          const vel = clamp(p.vel * (0.7 + 0.3 * this.breath) * (strong ? 1.1 : 0.9) + (r() - 0.5) * 0.12, 0.2, 1);
          evs.push({ kind: 'voice', part: i, t: t0 + t * beat, dur: dur * beat * 0.95, midi: this.stepToMidi(s), freq: this.stepToFreq(s), vel, step: s });
          t += dur;
        }
        this.lastStep[i] = s;
      });
      // instruments
      const en = this.o.enabled ? this.o.enabled() : { ep: true, toy: true, tape: true };
      const chordFreqs = oct => this.chordTones().slice(0, 3).map(d => this.stepToFreq(oct * 7 + d));
      const sparse = !!this.o.sparse;
      if (en.ep) {
        if (sparse || this.breath < 0.5 || r() < 0.35) {
          // a block chord on the downbeat, rolled slightly
          chordFreqs(1).forEach((f, j) => evs.push({ kind: 'ep', t: t0 + j * 0.03, dur: L * beat * 0.85, freq: f, vel: 0.42 }));
          if (L >= 8) chordFreqs(1).forEach((f, j) => evs.push({ kind: 'ep', t: t0 + 5 * beat + j * 0.03, dur: 3 * beat, freq: f, vel: 0.3 }));
        } else {
          // a Fibonacci arpeggio, climbing an octave and back
          const fs = [...chordFreqs(1), ...chordFreqs(2), ...chordFreqs(1).reverse()], times = [0, 1, 2, 3, 5, 8, 10, 11, 13];
          times.forEach((k, j) => { if (k * 0.5 < L) evs.push({ kind: 'ep', t: t0 + k * 0.5 * beat, dur: 2.5 * beat, freq: fs[j % fs.length], vel: 0.34 + 0.08 * (j % 2) }); });
        }
        // the piano doubles the melody
        if (!sparse) for (const e of evs.filter(e => e.kind === 'voice' && e.part === 1)) if (r() < 0.55)
          evs.push({ kind: 'ep', t: e.t, dur: e.dur, freq: e.freq, vel: 0.3 + e.vel * 0.2 });
      }
      if (en.toy && this.breath > 0.3) {
        // the toy piano echoes the soprano an octave up, φ beats late
        for (const e of evs.filter(e => e.kind === 'voice' && e.part === 1)) if (r() < (sparse ? 0.18 : 0.35 + this.breath * 0.5))
          evs.push({ kind: 'toy', t: e.t + PHI * beat * 0.5, dur: 1.2 * beat, freq: e.freq * 2, vel: 0.26 + e.vel * 0.18 });
        if (!sparse && r() < 0.25) evs.push({ kind: 'prep', t: t0, vel: 0.3 });
      }
      this.phraseEnd = t0 + L * beat;
      return evs;
    }

    start() {
      if (this.timer) return;
      const ctx = this.ctx;
      this.phraseEnd = ctx.currentTime + 0.3;
      this.scheduled = new Set();
      const tick = () => {
        const now = ctx.currentTime;
        while (this.phraseEnd < now + 2.5) {
          const evs = this.genPhrase(this.phraseEnd);
          this.events.push(...evs);
          for (const e of evs) if (e.kind === 'voice') this.partEvents[e.part].push(e);
        }
        for (const e of this.events) {
          if (e.t <= now + 0.6 && !e.done) { e.done = true; this.o.onEvent && this.o.onEvent(e); }
        }
        this.events = this.events.filter(e => !e.done);
        for (const list of this.partEvents) while (list.length && list[0].t + list[0].dur + 0.6 < now) list.shift();
      };
      this.tick = tick; tick();
      this.timer = setInterval(tick, 80);
    }
    stop() { clearInterval(this.timer); this.timer = null; this.events = []; this.partEvents = [[], [], []]; }
    // the note a part is singing right now (or null)
    current(part, now) {
      const list = this.partEvents[part];
      for (let i = list.length - 1; i >= 0; i--) { const e = list[i]; if (e.t <= now) return now < e.t + e.dur ? e : null; }
      return null;
    }
    modulateNow() { this.forceModulate = true; }
    // influence from a linked piece: pc = pitch class 0–11 (C = 0), strength = probability per phrase
    pull(pc, mode, strength = 0.6) { this.pullTo = { pc: ((pc % 12) + 12) % 12, mode }; this.pullStrength = strength; }
    nudgeBreath(toward, amount) { this.breath = clamp(this.breath + (toward - this.breath) * amount, 0.15, 1); }
  }

  window.Acapella = { Sampler, Engine, loadBuffers, JUST, MODES, NOTE_NAMES, PARTS, mtof };
})();
