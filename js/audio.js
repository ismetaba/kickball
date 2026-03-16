// ─────────────────────────────────────────────────────────────
//  KickZone Sound Engine — Web Audio API (zero external files)
// ─────────────────────────────────────────────────────────────
class SoundManager {
    constructor() {
        this.ctx = null;
        this.masterGain = null;
        this.sfxGain = null;
        this.musicGain = null;
        this.volume = 0.6;
        this.musicVol = 0.35;
        this.muted = false;
        this._initialized = false;
        this._noiseBuffer = null;     // pre-built white noise
        this._pinkBuffer = null;      // pre-built pink noise (warmer)
        this._bgmNodes = [];          // active background music nodes
        this._bgmPlaying = false;
        this._bgmInterval = null;
        this._lastKickTime = 0;       // debounce rapid kicks
        this._lastBounceTime = 0;     // debounce rapid bounces
        this._lastWallTime = 0;

        // Persist
        const sv = localStorage.getItem('kickzone_volume');
        if (sv !== null) this.volume = parseFloat(sv);
        const sm = localStorage.getItem('kickzone_muted');
        if (sm === 'true') this.muted = true;
    }

    /* ══════════ Lifecycle ══════════ */

    init() {
        if (this._initialized) return;
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();

            // Master → destination
            this.masterGain = this.ctx.createGain();
            this.masterGain.connect(this.ctx.destination);

            // SFX bus
            this.sfxGain = this.ctx.createGain();
            this.sfxGain.gain.value = 1.0;
            this.sfxGain.connect(this.masterGain);

            // Music bus (lower)
            this.musicGain = this.ctx.createGain();
            this.musicGain.gain.value = this.musicVol;
            this.musicGain.connect(this.masterGain);

            this._buildNoiseBuffers();
            this._updateVolume();
            this._initialized = true;
        } catch (e) {
            console.warn('Web Audio not supported');
        }
    }

    unlock() {
        if (!this.ctx) this.init();
        if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    }

    _updateVolume() {
        if (this.masterGain) {
            this.masterGain.gain.setTargetAtTime(
                this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02
            );
        }
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, v));
        localStorage.setItem('kickzone_volume', this.volume);
        this._updateVolume();
    }

    toggleMute() {
        this.muted = !this.muted;
        localStorage.setItem('kickzone_muted', this.muted);
        this._updateVolume();
        return this.muted;
    }

    /* ══════════ Noise buffers (built once) ══════════ */

    _buildNoiseBuffers() {
        const sr = this.ctx.sampleRate;
        const len = sr * 2; // 2 seconds

        // White noise
        this._noiseBuffer = this.ctx.createBuffer(1, len, sr);
        const wd = this._noiseBuffer.getChannelData(0);
        for (let i = 0; i < len; i++) wd[i] = Math.random() * 2 - 1;

        // Pink noise (approximate with filtered white)
        this._pinkBuffer = this.ctx.createBuffer(1, len, sr);
        const pd = this._pinkBuffer.getChannelData(0);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
            const w = Math.random() * 2 - 1;
            b0 = 0.99886 * b0 + w * 0.0555179;
            b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.1538520;
            b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522;
            b5 = -0.7616 * b5 - w * 0.0168980;
            pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
            b6 = w * 0.115926;
        }
    }

    /* ══════════ Core synthesis ══════════ */

    _now() { return this.ctx ? this.ctx.currentTime : 0; }

    // Oscillator with ADSR-style envelope
    _tone(type, freq, t, dur, peak, attack, decay, sustain) {
        if (!this.ctx) return null;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = type;
        o.frequency.value = freq;

        const a = attack || 0.005;
        const d = decay || dur * 0.3;
        const s = sustain !== undefined ? sustain : peak * 0.3;

        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(peak, t + a);
        g.gain.linearRampToValueAtTime(s, t + a + d);
        g.gain.linearRampToValueAtTime(0.0001, t + dur);

        o.connect(g);
        g.connect(this.sfxGain);
        o.start(t);
        o.stop(t + dur + 0.01);
        return o;
    }

    // Pitched sweep (frequency glides)
    _sweep(type, startFreq, endFreq, t, dur, peak) {
        if (!this.ctx) return;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = type;
        o.frequency.setValueAtTime(startFreq, t);
        o.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 20), t + dur);
        g.gain.setValueAtTime(peak, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g);
        g.connect(this.sfxGain);
        o.start(t);
        o.stop(t + dur + 0.01);
    }

    // Noise burst with filter
    _noiseBurst(filterType, filterFreq, filterQ, t, dur, peak, buf) {
        if (!this.ctx) return;
        const src = this.ctx.createBufferSource();
        src.buffer = buf || this._noiseBuffer;
        src.loop = false;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(peak, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        const f = this.ctx.createBiquadFilter();
        f.type = filterType;
        f.frequency.value = filterFreq;
        f.Q.value = filterQ || 1;
        src.connect(f);
        f.connect(g);
        g.connect(this.sfxGain);
        src.start(t);
        src.stop(t + dur + 0.01);
    }

    // Noise burst with sweeping filter
    _noiseSwoop(filterType, startFreq, endFreq, q, t, dur, peak) {
        if (!this.ctx) return;
        const src = this.ctx.createBufferSource();
        src.buffer = this._noiseBuffer;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(peak, t + dur * 0.15);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        const f = this.ctx.createBiquadFilter();
        f.type = filterType;
        f.frequency.setValueAtTime(startFreq, t);
        f.frequency.exponentialRampToValueAtTime(Math.max(endFreq, 20), t + dur);
        f.Q.value = q || 2;
        src.connect(f);
        f.connect(g);
        g.connect(this.sfxGain);
        src.start(t);
        src.stop(t + dur + 0.01);
    }

    /* ════════════════════════════════════════════
       GAME SOUNDS
       ════════════════════════════════════════════ */

    kick(chargeRatio) {
        if (!this.ctx) return;
        const t = this._now();
        if (t - this._lastKickTime < 0.04) return; // debounce
        this._lastKickTime = t;

        const cr = Math.max(0.1, chargeRatio);

        // 1) Low-frequency "thwack" body — swept sine
        this._sweep('sine', 160 + cr * 200, 50, t, 0.08 + cr * 0.04, 0.2 + cr * 0.2);

        // 2) Bright transient click
        this._tone('square', 1200 + cr * 800, t, 0.015, 0.12 + cr * 0.1, 0.001, 0.01, 0);

        // 3) Impact noise — highpass filtered
        this._noiseBurst('highpass', 1500 + cr * 2000, 1.5, t, 0.04 + cr * 0.03, 0.12 + cr * 0.12);

        // 4) For strong kicks — add a "smack" pop
        if (cr > 0.5) {
            this._sweep('triangle', 3000, 500, t, 0.025, 0.08 + cr * 0.06);
            this._noiseBurst('bandpass', 3000, 3, t, 0.02, 0.06 * cr);
        }
    }

    ballBounce(intensity) {
        if (!this.ctx) return;
        const t = this._now();
        if (t - this._lastBounceTime < 0.05) return;
        this._lastBounceTime = t;

        const v = Math.min(intensity, 1);
        // Soft pitched "tonk"
        this._sweep('sine', 300 + v * 250, 100, t, 0.04 + v * 0.02, 0.06 + v * 0.08);
        // Soft click (triangle instead of square — less harsh)
        this._tone('triangle', 700 + v * 400, t, 0.006, 0.03 + v * 0.04, 0.001, 0.004, 0);
        // Subtle noise
        this._noiseBurst('bandpass', 1800 + v * 1000, 1.5, t, 0.018, 0.02 + v * 0.025);
    }

    wallBounce(speed) {
        if (!this.ctx) return;
        const t = this._now();
        if (t - this._lastWallTime < 0.05) return;
        this._lastWallTime = t;

        const v = Math.min((speed || 5) / 15, 1);
        // Hollow "bonk"
        this._sweep('sine', 200 + v * 100, 80, t, 0.06, 0.06 + v * 0.08);
        // Board-like rattle
        this._noiseBurst('bandpass', 600 + v * 400, 4, t, 0.04, 0.04 + v * 0.05);
    }

    playerCollision(intensity) {
        if (!this.ctx) return;
        const t = this._now();
        const v = Math.min(intensity || 0.5, 1);
        // Soft body bump — muted thud, no harsh buzz
        this._sweep('sine', 100, 45, t, 0.05, 0.04 + v * 0.03);
        // Gentle fabric/contact rustle
        this._noiseBurst('bandpass', 600, 1, t, 0.03, 0.02 + v * 0.015);
    }

    stun() {
        if (!this.ctx) return;
        const t = this._now();
        // Dizzy descending tones
        this._sweep('sine', 900, 300, t, 0.15, 0.08);
        this._sweep('triangle', 700, 250, t + 0.03, 0.12, 0.05);
        // Tiny stars sparkle
        this._tone('sine', 2200, t + 0.05, 0.06, 0.04, 0.002, 0.03, 0);
        this._tone('sine', 1800, t + 0.09, 0.06, 0.03, 0.002, 0.03, 0);
    }

    goal() {
        if (!this.ctx) return;
        const t = this._now();

        // 1) Warm sub-bass boom
        this._sweep('sine', 80, 30, t, 0.4, 0.2);

        // 2) Celebration chime arpeggio — clean sine tones rising
        const chimeNotes = [
            [523.3, 0.00, 0.60],   // C5
            [659.3, 0.08, 0.55],   // E5
            [784.0, 0.16, 0.50],   // G5
            [1047,  0.24, 0.45],   // C6
            [1319,  0.32, 0.40],   // E6
            [1568,  0.40, 0.35],   // G6
        ];
        chimeNotes.forEach(([freq, delay, dur]) => {
            // Pure sine chime
            this._tone('sine', freq, t + delay, dur, 0.09, 0.003, 0.08, 0.02);
            // Soft octave overtone for warmth
            this._tone('sine', freq * 2, t + delay, dur * 0.6, 0.02, 0.003, 0.06, 0);
        });

        // 3) Warm sustained chord (sine, not sawtooth)
        const chordFreqs = [261.6, 329.6, 392.0, 523.3]; // C4 E4 G4 C5
        chordFreqs.forEach(freq => {
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            const filt = this.ctx.createBiquadFilter();
            o.type = 'sine';  // clean sine — no buzz
            o.frequency.value = freq;
            filt.type = 'lowpass';
            filt.frequency.value = 1500;
            g.gain.setValueAtTime(0.0001, t + 0.2);
            g.gain.linearRampToValueAtTime(0.035, t + 0.4);
            g.gain.setValueAtTime(0.035, t + 1.0);
            g.gain.linearRampToValueAtTime(0.0001, t + 1.6);
            o.connect(filt);
            filt.connect(g);
            g.connect(this.sfxGain);
            o.start(t + 0.2);
            o.stop(t + 1.7);
        });

        // 4) Crowd roar (filtered pink noise swell)
        const crowd = this.ctx.createBufferSource();
        crowd.buffer = this._pinkBuffer;
        const cg = this.ctx.createGain();
        cg.gain.setValueAtTime(0.0001, t);
        cg.gain.linearRampToValueAtTime(0.08, t + 0.3);
        cg.gain.setValueAtTime(0.08, t + 1.0);
        cg.gain.linearRampToValueAtTime(0.0001, t + 1.8);
        const cf = this.ctx.createBiquadFilter();
        cf.type = 'bandpass';
        cf.frequency.value = 1000;
        cf.Q.value = 0.4;
        crowd.connect(cf);
        cf.connect(cg);
        cg.connect(this.sfxGain);
        crowd.start(t);
        crowd.stop(t + 2.0);

        // 5) Sparkle shimmer
        this._noiseBurst('highpass', 6000, 2, t + 0.3, 0.4, 0.03);
    }

    whistle(long) {
        if (!this.ctx) return;
        const t = this._now();
        const dur = long ? 0.7 : 0.3;

        // Two detuned oscillators for realistic whistle
        const o1 = this.ctx.createOscillator();
        const o2 = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const filt = this.ctx.createBiquadFilter();

        o1.type = 'sine';
        o2.type = 'sine';
        o1.frequency.value = 2800;
        o2.frequency.value = 2808;

        // Whistle warble
        const lfo = this.ctx.createOscillator();
        const lfoG = this.ctx.createGain();
        lfo.frequency.value = 8;
        lfoG.gain.value = 15;
        lfo.connect(lfoG);
        lfoG.connect(o1.frequency);
        lfoG.connect(o2.frequency);

        filt.type = 'bandpass';
        filt.frequency.value = 2800;
        filt.Q.value = 5;

        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.12, t + 0.02);
        if (long) {
            // Long final whistle: trill then fade
            g.gain.setValueAtTime(0.12, t + 0.1);
            g.gain.setValueAtTime(0.08, t + 0.3);
            g.gain.linearRampToValueAtTime(0.12, t + 0.4);
        }
        g.gain.setValueAtTime(0.1, t + dur - 0.05);
        g.gain.linearRampToValueAtTime(0.0001, t + dur);

        o1.connect(filt);
        o2.connect(filt);
        filt.connect(g);
        g.connect(this.sfxGain);

        // Breath noise layer
        this._noiseBurst('bandpass', 3000, 6, t, dur * 0.9, 0.03);

        o1.start(t); o2.start(t); lfo.start(t);
        o1.stop(t + dur + 0.01);
        o2.stop(t + dur + 0.01);
        lfo.stop(t + dur + 0.01);
    }

    countdown() {
        if (!this.ctx) return;
        const t = this._now();
        // Sharp electronic beep
        this._tone('sine', 880, t, 0.1, 0.12, 0.003, 0.04, 0.06);
        this._tone('sine', 1760, t, 0.06, 0.04, 0.002, 0.03, 0);
    }

    countdownFinal() {
        if (!this.ctx) return;
        const t = this._now();
        // Higher, longer, more urgent
        this._tone('sine', 1320, t, 0.2, 0.15, 0.003, 0.06, 0.08);
        this._tone('sine', 1760, t, 0.15, 0.08, 0.002, 0.05, 0);
        this._tone('triangle', 660, t + 0.01, 0.15, 0.06, 0.003, 0.05, 0);
    }

    powerUpSpawn() {
        if (!this.ctx) return;
        const t = this._now();
        // Magical shimmer — ascending arpeggiated sparkle
        const notes = [523, 659, 784, 1047, 1319];
        notes.forEach((f, i) => {
            this._tone('sine', f, t + i * 0.06, 0.2 - i * 0.02, 0.05, 0.003, 0.05, 0.02);
        });
        // Sparkle noise
        this._noiseBurst('highpass', 6000, 2, t, 0.3, 0.03);
    }

    powerUpCollect() {
        if (!this.ctx) return;
        const t = this._now();
        // Satisfying ascending chime + confirmation tone
        this._tone('sine', 880, t, 0.08, 0.12, 0.002, 0.03, 0.04);
        this._tone('sine', 1100, t + 0.06, 0.08, 0.1, 0.002, 0.03, 0.03);
        this._tone('triangle', 1320, t + 0.12, 0.12, 0.12, 0.002, 0.04, 0.03);
        this._tone('sine', 1760, t + 0.18, 0.18, 0.1, 0.003, 0.05, 0.02);
        // Bright sparkle
        this._noiseBurst('highpass', 5000, 2, t + 0.1, 0.15, 0.04);
    }

    freeze() {
        if (!this.ctx) return;
        const t = this._now();
        // Icy crystalline — rapid descending + shimmering high tones
        this._sweep('sine', 4000, 800, t, 0.3, 0.08);
        this._sweep('triangle', 3000, 600, t + 0.02, 0.25, 0.06);
        // Ice crackle
        this._noiseBurst('highpass', 6000, 4, t, 0.15, 0.08);
        this._noiseBurst('bandpass', 8000, 6, t + 0.05, 0.1, 0.05);
        // Low frozen thud
        this._sweep('sine', 200, 60, t, 0.2, 0.1);
    }

    /* ════════════════════════════════════════════
       UI SOUNDS
       ════════════════════════════════════════════ */

    uiClick() {
        if (!this.ctx) return;
        const t = this._now();
        // Clean digital click
        this._tone('sine', 1200, t, 0.04, 0.07, 0.001, 0.015, 0);
        this._tone('sine', 1800, t + 0.008, 0.025, 0.04, 0.001, 0.01, 0);
    }

    uiBack() {
        if (!this.ctx) return;
        const t = this._now();
        this._sweep('sine', 1000, 500, t, 0.06, 0.06);
        this._tone('triangle', 400, t + 0.02, 0.04, 0.04, 0.002, 0.02, 0);
    }

    uiStart() {
        if (!this.ctx) return;
        const t = this._now();
        // Energetic ascending confirmation
        this._tone('sine', 523, t, 0.08, 0.1, 0.003, 0.03, 0.04);
        this._tone('sine', 659, t + 0.07, 0.08, 0.1, 0.003, 0.03, 0.04);
        this._tone('triangle', 784, t + 0.14, 0.08, 0.1, 0.003, 0.03, 0.04);
        this._tone('sine', 1047, t + 0.21, 0.15, 0.12, 0.003, 0.04, 0.03);
    }

    pause() {
        if (!this.ctx) return;
        const t = this._now();
        this._sweep('sine', 800, 400, t, 0.12, 0.07);
        this._tone('triangle', 300, t + 0.04, 0.1, 0.04, 0.003, 0.04, 0);
    }

    resume() {
        if (!this.ctx) return;
        const t = this._now();
        this._sweep('sine', 400, 800, t, 0.1, 0.06);
        this._tone('triangle', 600, t + 0.04, 0.08, 0.05, 0.003, 0.03, 0);
    }

    win() {
        if (!this.ctx) return;
        const t = this._now();
        // Victory fanfare — triumphant ascending chord
        const melody = [
            [523, 0], [659, 0.12], [784, 0.24], [1047, 0.36]
        ];
        melody.forEach(([freq, offset]) => {
            this._tone('triangle', freq, t + offset, 0.35, 0.1, 0.005, 0.1, 0.04);
            this._tone('sine', freq * 2, t + offset, 0.25, 0.03, 0.003, 0.08, 0);
        });
        // Bright celebration shimmer
        this._noiseBurst('highpass', 5000, 1, t + 0.3, 0.4, 0.04);
    }

    lose() {
        if (!this.ctx) return;
        const t = this._now();
        // Somber descending — minor feel
        this._tone('triangle', 440, t, 0.3, 0.08, 0.01, 0.1, 0.03);
        this._tone('triangle', 370, t + 0.25, 0.3, 0.08, 0.01, 0.1, 0.03);
        this._tone('sine', 311, t + 0.5, 0.5, 0.1, 0.01, 0.15, 0.02);
        // Low rumble
        this._sweep('sine', 120, 50, t + 0.4, 0.4, 0.06);
    }

    switchPlayer() {
        if (!this.ctx) return;
        const t = this._now();
        this._tone('sine', 1000, t, 0.03, 0.05, 0.001, 0.015, 0);
        this._tone('sine', 1400, t + 0.025, 0.03, 0.04, 0.001, 0.015, 0);
    }

    comboSound(level) {
        if (!this.ctx) return;
        const t = this._now();
        // Ascending chime notes — more notes for higher combos
        const notes = [523, 659, 784, 1047, 1319, 1568];
        const count = Math.min(level + 1, notes.length);
        for (let i = 0; i < count; i++) {
            this._tone('sine', notes[i], t + i * 0.07, 0.15, 0.08 + level * 0.02, 0.003, 0.05, 0.02);
            if (level >= 3) {
                this._tone('sine', notes[i] * 2, t + i * 0.07, 0.1, 0.03, 0.002, 0.04, 0);
            }
        }
        if (level >= 2) this._noiseBurst('highpass', 5000, 2, t + count * 0.07, 0.3, 0.04);
        if (level >= 4) {
            // Legendary: crowd roar
            const crowd = this.ctx.createBufferSource();
            crowd.buffer = this._pinkBuffer;
            const cg = this.ctx.createGain();
            cg.gain.setValueAtTime(0.0001, t);
            cg.gain.linearRampToValueAtTime(0.06, t + 0.2);
            cg.gain.linearRampToValueAtTime(0.0001, t + 1.2);
            const cf = this.ctx.createBiquadFilter();
            cf.type = 'bandpass'; cf.frequency.value = 1200; cf.Q.value = 0.5;
            crowd.connect(cf); cf.connect(cg); cg.connect(this.sfxGain);
            crowd.start(t); crowd.stop(t + 1.3);
        }
    }

    fireGoal(level) {
        if (!this.ctx) return;
        this.goal();
        const t = this._now();
        // Extra bass boom for fire goals
        this._sweep('sine', 60, 20, t, 0.5, 0.25);
        // Extra sparkle
        this._noiseBurst('highpass', 4000, 3, t + 0.1, 0.5, 0.05);
        if (level >= 2) {
            // Inferno: distorted low sweep + power chord
            this._sweep('square', 100, 30, t, 0.3, 0.08);
            this._tone('sine', 1568, t + 0.2, 0.4, 0.06, 0.003, 0.1, 0.02);
            this._tone('sine', 2093, t + 0.25, 0.35, 0.05, 0.003, 0.1, 0.01);
        }
    }

    fireBallPierce() {
        if (!this.ctx) return;
        const t = this._now();
        // Dramatic whoosh
        this._noiseSwoop('bandpass', 2000, 500, 3, t, 0.15, 0.12);
        // Impact thud
        this._sweep('sine', 200, 60, t, 0.08, 0.1);
        // Rising pass-through tone
        this._sweep('sine', 400, 1200, t + 0.02, 0.1, 0.06);
    }

    pullActivate() {
        if (!this.ctx) return;
        const t = this._now();
        // Magical whoosh inward
        this._noiseSwoop('bandpass', 3000, 800, 3, t, 0.2, 0.08);
        // Rising magical tone
        this._sweep('sine', 400, 800, t, 0.15, 0.06);
        this._tone('sine', 1200, t + 0.1, 0.1, 0.04, 0.002, 0.05, 0);
    }

    suddenDeathStart() {
        if (!this.ctx) return;
        const t = this._now();
        // Deep bass rumble
        this._sweep('sine', 60, 25, t, 1.0, 0.15);
        // Alarm tones — two detuned descending
        this._sweep('square', 440, 220, t + 0.2, 0.4, 0.06);
        this._sweep('square', 445, 222, t + 0.2, 0.4, 0.05);
        // Rising tension noise
        this._noiseSwoop('bandpass', 500, 3000, 2, t + 0.5, 0.5, 0.08);
        // Sharp stinger
        this._tone('sine', 880, t + 1.0, 0.15, 0.12, 0.003, 0.05, 0.04);
        this._tone('sine', 1320, t + 1.05, 0.15, 0.1, 0.003, 0.05, 0.03);
    }

    /* ════════════════════════════════════════════
       BACKGROUND MUSIC — Procedural electronic loop
       ════════════════════════════════════════════ */

    startMusic() {
        if (!this.ctx || this._bgmPlaying) return;
        this._bgmPlaying = true;
        this.musicGain.gain.setTargetAtTime(this.musicVol, this.ctx.currentTime, 0.3);
        this._playMusicLoop();
    }

    stopMusic() {
        if (!this._bgmPlaying) return;
        this._bgmPlaying = false;
        if (this._bgmInterval) {
            clearTimeout(this._bgmInterval);
            this._bgmInterval = null;
        }
        if (this.musicGain) {
            this.musicGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.5);
        }
    }

    _playMusicLoop() {
        if (!this._bgmPlaying || !this.ctx) return;

        const t = this.ctx.currentTime + 0.05;
        const bpm = 105;
        const beat = 60 / bpm;
        const bar = beat * 4;
        const loopLen = bar * 4;

        // ── Soft kick (half-time feel: beats 1 & 3 only) ──
        for (let b = 0; b < 4; b++) {
            this._musicKick(t + b * bar);
            this._musicKick(t + b * bar + beat * 2);
        }

        // ── Soft hi-hat (gentle 8th notes) ──
        for (let i = 0; i < 32; i++) {
            const ht = t + i * (beat / 2);
            const isOffbeat = i % 2 === 1;
            this._musicHat(ht, isOffbeat ? 0.008 : 0.014, isOffbeat ? 0.025 : 0.04);
        }

        // ── Rim click / snap (on beat 2 & 4 for groove) ──
        for (let b = 0; b < 4; b++) {
            this._musicRim(t + b * bar + beat);
            this._musicRim(t + b * bar + beat * 3);
        }

        // ── Warm sine bass (no sawtooth) ──
        const bassNotes = [
            [65.4, 0, beat * 2],
            [65.4, beat * 2.5, beat * 1.2],
            [73.4, bar, beat * 2],
            [73.4, bar + beat * 2.5, beat * 1.2],
            [87.3, bar * 2, beat * 2],
            [82.4, bar * 2 + beat * 2.5, beat * 1.2],
            [73.4, bar * 3, beat * 2],
            [65.4, bar * 3 + beat * 2.5, beat * 1.2],
        ];
        bassNotes.forEach(([freq, offset, dur]) => {
            this._musicBass(t + offset, freq, dur);
        });

        // ── Ambient pad (long, warm, evolving) ──
        const padChords = [
            [[130.8, 164.8, 196.0, 261.6], 0],        // Cm add9
            [[146.8, 174.6, 220.0, 293.7], bar],       // Dm
            [[174.6, 220.0, 261.6, 349.2], bar * 2],   // F
            [[155.6, 196.0, 246.9, 311.1], bar * 3],    // Eb
        ];
        padChords.forEach(([notes, offset]) => {
            this._musicPad(t + offset, notes, bar * 0.97);
        });

        // ── Gentle melodic arp (sparse, varied per bar) ──
        const arpPatterns = [
            [523, null, 784, null, 659, null, 784, null],
            [587, null, 880, null, 698, null, null, null],
            [698, null, 1047, null, 880, null, 698, null],
            [659, null, 784, null, 523, null, null, null],
        ];
        arpPatterns.forEach((pattern, barIdx) => {
            pattern.forEach((freq, noteIdx) => {
                if (freq) {
                    this._musicArp(t + barIdx * bar + noteIdx * (beat / 2), freq);
                }
            });
        });

        // ── Occasional sparkle (every 2 bars) ──
        this._musicSparkle(t + bar * 1.75);
        this._musicSparkle(t + bar * 3.75);

        // Schedule next loop
        this._bgmInterval = setTimeout(() => {
            this._playMusicLoop();
        }, loopLen * 1000 - 100);
    }

    _musicKick(t) {
        if (!this.ctx) return;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(100, t);
        o.frequency.exponentialRampToValueAtTime(35, t + 0.1);
        g.gain.setValueAtTime(0.12, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.connect(g);
        g.connect(this.musicGain);
        o.start(t);
        o.stop(t + 0.2);
    }

    _musicHat(t, vol, dur) {
        if (!this.ctx) return;
        const src = this.ctx.createBufferSource();
        src.buffer = this._noiseBuffer;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(vol, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        const f = this.ctx.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = 8000;
        src.connect(f);
        f.connect(g);
        g.connect(this.musicGain);
        src.start(t);
        src.stop(t + dur + 0.01);
    }

    _musicRim(t) {
        if (!this.ctx) return;
        // Short sine click for rim/snap feel
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 800;
        g.gain.setValueAtTime(0.05, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
        o.connect(g);
        g.connect(this.musicGain);
        o.start(t);
        o.stop(t + 0.04);
        // Tiny noise transient
        const src = this.ctx.createBufferSource();
        src.buffer = this._noiseBuffer;
        const ng = this.ctx.createGain();
        ng.gain.setValueAtTime(0.025, t);
        ng.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
        const nf = this.ctx.createBiquadFilter();
        nf.type = 'bandpass';
        nf.frequency.value = 3500;
        nf.Q.value = 3;
        src.connect(nf);
        nf.connect(ng);
        ng.connect(this.musicGain);
        src.start(t);
        src.stop(t + 0.02);
    }

    _musicBass(t, freq, dur) {
        if (!this.ctx) return;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const f = this.ctx.createBiquadFilter();
        o.type = 'sine';  // Clean sine bass — no buzz
        o.frequency.value = freq;
        f.type = 'lowpass';
        f.frequency.value = 300;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.1, t + 0.03);
        g.gain.setValueAtTime(0.1, t + dur * 0.6);
        g.gain.linearRampToValueAtTime(0.0001, t + dur);
        o.connect(f);
        f.connect(g);
        g.connect(this.musicGain);
        o.start(t);
        o.stop(t + dur + 0.01);
    }

    _musicPad(t, notes, dur) {
        if (!this.ctx) return;
        notes.forEach((freq, i) => {
            // Two detuned oscillators per note for width
            const o1 = this.ctx.createOscillator();
            const o2 = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            const f = this.ctx.createBiquadFilter();
            o1.type = 'sine';
            o2.type = 'sine';
            o1.frequency.value = freq;
            o2.frequency.value = freq * 1.003; // slight detune for chorus
            f.type = 'lowpass';
            f.frequency.value = 500 + i * 40;
            g.gain.setValueAtTime(0.0001, t);
            g.gain.linearRampToValueAtTime(0.018, t + dur * 0.35);
            g.gain.setValueAtTime(0.018, t + dur * 0.55);
            g.gain.linearRampToValueAtTime(0.0001, t + dur);
            o1.connect(f);
            o2.connect(f);
            f.connect(g);
            g.connect(this.musicGain);
            o1.start(t);
            o2.start(t);
            o1.stop(t + dur + 0.02);
            o2.stop(t + dur + 0.02);
        });
    }

    _musicArp(t, freq) {
        if (!this.ctx) return;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const f = this.ctx.createBiquadFilter();
        o.type = 'sine';
        o.frequency.value = freq;
        f.type = 'lowpass';
        f.frequency.value = 1800;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.015, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.connect(f);
        f.connect(g);
        g.connect(this.musicGain);
        o.start(t);
        o.stop(t + 0.37);
    }

    _musicSparkle(t) {
        if (!this.ctx) return;
        // Tiny high-pitched shimmer accent
        const notes = [2093, 2637, 3136];
        notes.forEach((freq, i) => {
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            o.type = 'sine';
            o.frequency.value = freq;
            g.gain.setValueAtTime(0.0001, t + i * 0.04);
            g.gain.linearRampToValueAtTime(0.008, t + i * 0.04 + 0.01);
            g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.04 + 0.2);
            o.connect(g);
            g.connect(this.musicGain);
            o.start(t + i * 0.04);
            o.stop(t + i * 0.04 + 0.22);
        });
    }
}

// Global singleton
const Sound = new SoundManager();
