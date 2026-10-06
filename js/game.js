// Deterministic PRNG for lockstep multiplayer (xorshift32)
class SeededRNG {
    constructor(seed) {
        this.s = seed || 1;
    }
    next() {
        this.s ^= this.s << 13;
        this.s ^= this.s >> 17;
        this.s ^= this.s << 5;
        return (this.s >>> 0) / 4294967296;
    }
    nextInt(max) {
        return (this.next() * max) | 0;
    }
    seed(s) {
        this.s = s || 1;
    }
}

// Fixed simulation step. Every mode (offline and online) advances the world
// in exact 60 Hz ticks; rendering interpolates between the last two ticks.
const TICK_MS = 1000 / 60;
const KICK_CHARGE_MS = 1500;
const PULL_RANGE = 150;

// Largest per-tick move we still interpolate. Anything bigger is a teleport
// (goal reset, dash, resync) and is drawn at its new position directly.
const INTERP_MAX_PLAYER = 60;
const INTERP_MAX_BALL = 120;

// 32-bit FNV-style hash over exact float bits — used for online desync checks.
const _hashF64 = new Float64Array(1);
const _hashU32 = new Uint32Array(_hashF64.buffer);
function hashValue(h, v) {
    if (typeof v === 'number') {
        _hashF64[0] = v;
        h = Math.imul(h ^ _hashU32[0], 0x01000193);
        return Math.imul(h ^ _hashU32[1], 0x01000193);
    }
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) h = hashValue(h, v[i]);
        return Math.imul(h ^ v.length, 0x01000193);
    }
    if (typeof v === 'string') {
        for (let i = 0; i < v.length; i++) h = Math.imul(h ^ v.charCodeAt(i), 0x01000193);
        return Math.imul(h ^ 0x5bd1e995, 0x01000193);
    }
    if (typeof v === 'boolean') return Math.imul(h ^ (v ? 0x51 : 0x50), 0x01000193);
    if (v && typeof v === 'object') {
        for (const k in v) h = hashValue(h, v[k]);
        return h;
    }
    return Math.imul(h ^ 0x9e3779b9, 0x01000193); // null / undefined
}

// Main game logic
class Game {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.renderer = new Renderer(this.canvas);

        this.settings = {
            teamSize: 2,
            duration: 180,
            goalLimit: 5,
            difficulty: 'normal',
            powerups: true,
            map: 'classic',
        };

        this.field = null;
        this.ball = null;
        this.players = [];
        this.humanPlayer = null;
        this.aiControllers = [];
        this.powerUpManager = null;

        this.redScore = 0;
        this.blueScore = 0;
        this.timeRemaining = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.isGoalScored = false;
        this.goalTimer = 0;
        this.kickoffTeam = null;     // team that gets kickoff (was scored on)
        this.kickoffActive = false;  // true while kickoff restriction is active
        this.lastTime = 0;
        this.matchOver = false;
        this.practiceMode = false;

        // Raw controller state, written by Controls. Sampled once per tick.
        this.input = { x: 0, y: 0, kickCharging: false, kickChargeStart: 0, kickChargeTime: 0, kickRelease: false, switchPlayer: false, pull: false };
        this.timeScale = 1.0;
        this.slowMoTimer = 0;
        this.momentum = { red: 0, blue: 0, max: 5, decayRate: 0.0001 };
        this._lastCountdownSec = -1;
        this.combo = { team: null, count: 0 };
        this.suddenDeath = false;
        this.suddenDeathTimer = 0;
        this.suddenDeathMaxTime = 60000;
        this.suddenDeathShrink = 0;
        this._originalMaxBallSpeed = Physics.MAX_BALL_SPEED;
        this._endMatchTimer = 0;

        // AI vs AI spectator
        this.isSpectator = false;
        this._baseGameSpeed = Physics.GAME_SPEED;

        // Fixed-step clock + deterministic state shared with online lockstep
        this.rng = new SeededRNG(12345);
        this.tickCount = 0;
        this._accumulator = 0;
        this._tickInputs = [];

        // Who controls which player. Keys are "slots" (the player index a
        // human was assigned at kickoff); the value follows SWAPs.
        this._controlled = new Map();
        this._mySlot = 0;
        this._localTeam = 'red';

        // Online lockstep (set up by UI via startLockstepMatch)
        this.isLockstep = false;
        this.netplay = null;
        this.onMatchEnd = null;

        // Stats
        this.stats = {
            possession: { red: 0, blue: 0 },
            shots: { red: 0, blue: 0 },
        };

        // Cached DOM elements (avoid getElementById every frame).
        // All HUD mutations go through these refs so a missing element
        // is a no-op instead of a crash.
        this._dom = {
            timer: document.getElementById('timer'),
            redScore: document.getElementById('red-score'),
            blueScore: document.getElementById('blue-score'),
            goalNotif: document.getElementById('goal-notification'),
            goalText: document.querySelector('#goal-notification .goal-text'),
            goalScorer: document.querySelector('#goal-notification .goal-scorer'),
            powerUpNotif: document.getElementById('powerup-notification'),
            powerUpText: document.querySelector('#powerup-notification .powerup-text'),
            pauseOverlay: document.getElementById('pause-overlay'),
            resultOverlay: document.getElementById('result-overlay'),
            resultTitle: document.getElementById('result-title'),
            resultScore: document.getElementById('result-score'),
            matchStats: document.getElementById('match-stats'),
            pullBtn: document.getElementById('btn-pull'),
            kickBtn: document.getElementById('btn-kick'),
        };
        this._hud = { timer: null, red: null, blue: null, pull: null, charge: -1 };

        // Cached team arrays (rebuilt when players change, not every frame)
        this._redTeam = [];
        this._blueTeam = [];

        // Virtual field resolution — depends on map type
        this.VIRTUAL_W = 800;
        this.VIRTUAL_H = 500;

        // Pending timers (tracked so quit() can cancel them cleanly)
        this._pendingTimers = new Set();
        this._rafId = null;

        // Debounced orientation handler — avoids queuing N setTimeouts
        // if the user rotates rapidly.
        this._orientationTimers = [];
        window.addEventListener('resize', () => this.onResize());
        window.addEventListener('orientationchange', () => {
            // Cancel any pending orientation resizes from a prior rotation
            for (const id of this._orientationTimers) clearTimeout(id);
            this._orientationTimers.length = 0;
            // iOS WKWebView needs extra time to settle new dimensions after rotation
            this._orientationTimers.push(setTimeout(() => this.onResize(), 100));
            this._orientationTimers.push(setTimeout(() => this.onResize(), 300));
            this._orientationTimers.push(setTimeout(() => this.onResize(), 500));
        });
    }

    get isNetworked() {
        return this.isLockstep;
    }

    // Tracked setTimeout: auto-cancelled by quit()
    _setTimeout(fn, ms) {
        const id = setTimeout(() => {
            this._pendingTimers.delete(id);
            fn();
        }, ms);
        this._pendingTimers.add(id);
        return id;
    }

    _clearAllTimers() {
        for (const id of this._pendingTimers) clearTimeout(id);
        this._pendingTimers.clear();
        for (const id of this._orientationTimers) clearTimeout(id);
        this._orientationTimers.length = 0;
    }

    rebuildTeamCache() {
        this._redTeam = this.players.filter(p => p.team === 'red');
        this._blueTeam = this.players.filter(p => p.team === 'blue');
    }

    // Build the right AI for the current difficulty.
    // - 1v1 expert: use the 1v1 PPO agent if available
    // - 2v2 expert: use the 2v2 PPO agent (each AI player gets its own
    //   runtime instance backed by the SAME shared policy)
    // Online lockstep always uses the scripted AIController: it is cheap,
    // seeded through this.rng, and identical on every device (a locally
    // trained RL model is not).
    _makeAI() {
        if (this.isLockstep) return new AIController('normal');
        const diff = this.settings.difficulty;
        const ts = this.settings.teamSize;
        if (diff === 'expert' && ts === 1
            && typeof RLOrchestrator !== 'undefined'
            && window.rlOrch && window.rlOrch.hasTrainedAgent()
            && typeof RLRuntimeAgent !== 'undefined') {
            const ag = window.rlOrch.getRuntimeAgent();
            if (ag) return ag;
        }
        if (diff === 'expert' && ts === 2
            && typeof RLOrchestrator2v2 !== 'undefined'
            && window.rlOrch2v2 && window.rlOrch2v2.hasTrainedAgent()
            && typeof RLRuntimeAgent2v2 !== 'undefined') {
            // Lazy-create the shared 2v2 runtime pool: each call hands out a
            // fresh per-player agent that references the same policy weights.
            if (!this._rl2v2Pool || this._rl2v2PoolToken !== window.rlOrch2v2.generation) {
                this._rl2v2Pool = window.rlOrch2v2.getRuntimeAgents() || [];
                this._rl2v2PoolToken = window.rlOrch2v2.generation;
                this._rl2v2PoolIdx = 0;
            }
            const ag = this._rl2v2Pool[this._rl2v2PoolIdx % this._rl2v2Pool.length];
            this._rl2v2PoolIdx++;
            if (ag) return ag;
        }
        const fallbackDiff = (diff === 'expert') ? 'normal' : diff;
        return new AIController(fallbackDiff || 'normal');
    }

    _setVirtualSize(mapType) {
        const isMobile = window.innerWidth < 768 || window.innerHeight < 768;
        if (mapType === 'big') {
            this.VIRTUAL_W = 800;
            this.VIRTUAL_H = 500;
            this.cameraZoom = isMobile ? 2.2 : 1.4;
        } else if (mapType === 'huge') {
            this.VIRTUAL_W = 2400;
            this.VIRTUAL_H = 1600;
            this.cameraZoom = 2.6;
        } else {
            // Classic
            this.VIRTUAL_W = 1500;
            this.VIRTUAL_H = 1000;
            this.cameraZoom = isMobile ? 2.2 : 1.4;
        }
        this._cameraX = this.VIRTUAL_W / 2;
        this._cameraY = this.VIRTUAL_H / 2;
    }

    _updateFieldViewScale() {
        const s = Math.min(this.renderer.w / this.VIRTUAL_W, this.renderer.h / this.VIRTUAL_H);
        this.renderer.fieldViewScale = s || 0.1; // Prevent zero scale
        this.renderer.fieldViewOffsetX = (this.renderer.w - this.VIRTUAL_W * s) / 2;
        this.renderer.fieldViewOffsetY = (this.renderer.h - this.VIRTUAL_H * s) / 2;
    }

    onResize() {
        if (!this.isRunning) return;
        this.renderer.resize();
        this._updateFieldViewScale();
    }

    getSpawnPositions() {
        const f = this.field;
        const positions = { red: [], blue: [] };
        const size = this.settings.teamSize;

        const redBaseX = f.x + f.width * 0.25;
        const blueBaseX = f.x + f.width * 0.75;

        if (size === 1) {
            positions.red.push({ x: redBaseX, y: f.centerY });
            positions.blue.push({ x: blueBaseX, y: f.centerY });
        } else {
            const spacing = f.height / (size + 1);
            for (let i = 0; i < size; i++) {
                const y = f.y + spacing * (i + 1);
                positions.red.push({ x: redBaseX + (i === 0 ? -30 : 30), y });
                positions.blue.push({ x: blueBaseX + (i === 0 ? 30 : -30), y });
            }
        }

        return positions;
    }

    applyMapPhysics() {
        // Store base physics values (only once)
        if (!this._basePhysics) {
            this._basePhysics = {
                BALL_FRICTION: Physics.BALL_FRICTION,
                WALL_BOUNCE: Physics.WALL_BOUNCE,
                FRICTION: Physics.FRICTION,
                KICK_FORCE: Physics.KICK_FORCE,
                POWER_KICK_FORCE: Physics.POWER_KICK_FORCE,
                MAX_BALL_SPEED: Physics.MAX_BALL_SPEED,
                MAX_PLAYER_SPEED: Physics.MAX_PLAYER_SPEED,
            };
        }
        // Apply map modifiers
        const f = this.field;
        Physics.BALL_FRICTION = 1 - (1 - this._basePhysics.BALL_FRICTION) * f.frictionMod;
        Physics.WALL_BOUNCE = this._basePhysics.WALL_BOUNCE * f.bounceMod;
        Physics.FRICTION = 1 - (1 - this._basePhysics.FRICTION) * f.playerFrictionMod;

        // Scale kick power and speeds for larger maps
        if (this.settings.map === 'huge') {
            Physics.KICK_FORCE = this._basePhysics.KICK_FORCE * 1.4;
            Physics.POWER_KICK_FORCE = this._basePhysics.POWER_KICK_FORCE * 1.4;
            Physics.MAX_BALL_SPEED = this._basePhysics.MAX_BALL_SPEED * 1.5;
            Physics.MAX_PLAYER_SPEED = this._basePhysics.MAX_PLAYER_SPEED * 1.3;
        } else {
            Physics.KICK_FORCE = this._basePhysics.KICK_FORCE;
            Physics.POWER_KICK_FORCE = this._basePhysics.POWER_KICK_FORCE;
            Physics.MAX_BALL_SPEED = this._basePhysics.MAX_BALL_SPEED;
            Physics.MAX_PLAYER_SPEED = this._basePhysics.MAX_PLAYER_SPEED;
        }
        // Sudden death ramps the ball speed up from this map-adjusted cap
        this._originalMaxBallSpeed = Physics.MAX_BALL_SPEED;
    }

    resetMapPhysics() {
        if (this._basePhysics) {
            Physics.BALL_FRICTION = this._basePhysics.BALL_FRICTION;
            Physics.WALL_BOUNCE = this._basePhysics.WALL_BOUNCE;
            Physics.FRICTION = this._basePhysics.FRICTION;
            Physics.KICK_FORCE = this._basePhysics.KICK_FORCE;
            Physics.POWER_KICK_FORCE = this._basePhysics.POWER_KICK_FORCE;
            Physics.MAX_BALL_SPEED = this._basePhysics.MAX_BALL_SPEED;
            Physics.MAX_PLAYER_SPEED = this._basePhysics.MAX_PLAYER_SPEED;
            this._originalMaxBallSpeed = Physics.MAX_BALL_SPEED;
        }
    }

    // --- Match setup -------------------------------------------------------

    _prepareField() {
        this.renderer.resize();
        this._setVirtualSize(this.settings.map);
        this._updateFieldViewScale();
        this.field = new Field(this.VIRTUAL_W, this.VIRTUAL_H, this.settings.map);
        this.ball = new Ball(this.field.centerX, this.field.centerY);
    }

    // Create both teams in a fixed order (red 0..n-1, blue n..2n-1). Players
    // whose index is in `humanIdx` are human-controlled; everyone else gets
    // an AI controller, also in index order so lockstep peers match.
    _buildPlayers(humanIdx) {
        this.players = [];
        this.aiControllers = [];
        const positions = this.getSpawnPositions();
        const n = this.settings.teamSize;
        for (let i = 0; i < n * 2; i++) {
            const team = i < n ? 'red' : 'blue';
            const pos = positions[team][i % n];
            const p = new Player(pos.x, pos.y, team, humanIdx.has(i));
            this.players.push(p);
        }
        for (const p of this.players) {
            if (!p.isHuman) this.aiControllers.push({ player: p, ai: this._makeAI() });
        }
        this.rebuildTeamCache();
    }

    _resetMatchState() {
        this.redScore = 0;
        this.blueScore = 0;
        this.timeRemaining = this.settings.duration * 1000;
        this.isRunning = true;
        this.isPaused = false;
        this.matchOver = false;
        this.isGoalScored = false;
        this.goalTimer = 0;
        this.kickoffTeam = null;
        this.kickoffActive = false;
        this.stats = { possession: { red: 0, blue: 0 }, shots: { red: 0, blue: 0 } };
        this.momentum = { red: 0, blue: 0, max: 5, decayRate: 0.0001 };
        this.timeScale = 1.0;
        this.slowMoTimer = 0;
        this.combo = { team: null, count: 0 };
        this.suddenDeath = false;
        this.suddenDeathTimer = 0;
        this.suddenDeathShrink = 0;
        this._endMatchTimer = 0;
        this._lastCountdownSec = -1;
        this.tickCount = 0;
        this._accumulator = 0;
        this._powerUpNotifTimer = null;

        this._hud = { timer: null, red: null, blue: null, pull: null, charge: -1 };
        if (this._dom.timer) this._dom.timer.style.color = '';
        if (this._dom.goalNotif) this._dom.goalNotif.classList.add('hidden');
        this._updateScoreHud();
        this._updateTimerHud();
    }

    _beginLoop() {
        this.applyMapPhysics();
        Physics.MAX_BALL_SPEED = this._originalMaxBallSpeed;
        this._snapPrev();
        this.lastTime = performance.now();
        Sound.whistle(false);
        Sound.startMusic();
        this._pauseBackgroundWork();
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        this.loop();

        // iOS WKWebView fix: dimensions may not be available at startup.
        // Re-resize after the view has settled to ensure correct canvas size.
        this._setTimeout(() => { this.renderer.resize(); this._updateFieldViewScale(); }, 100);
        this._setTimeout(() => { this.renderer.resize(); this._updateFieldViewScale(); }, 300);
    }

    startMatch() {
        this.isLockstep = false;
        this.netplay = null;
        Physics.GAME_SPEED = this._baseGameSpeed;
        this._prepareField();
        this._buildPlayers(new Set([0]));
        this.humanPlayer = this.players[0];
        this._mySlot = 0;
        this._controlled = new Map([[0, this.humanPlayer]]);
        this._localTeam = 'red';

        this.powerUpManager = new PowerUpManager(this.field);
        this.powerUpManager.enabled = this.settings.powerups;

        this._resetMatchState();
        this._beginLoop();
    }

    startPractice() {
        this.isLockstep = false;
        this.netplay = null;
        Physics.GAME_SPEED = this._baseGameSpeed;
        this._prepareField();
        this.aiControllers = [];

        // Just the human player, no AI
        const p = new Player(this.field.centerX - 60, this.field.centerY, 'red', true);
        this.players = [p];
        this.humanPlayer = p;
        this._mySlot = 0;
        this._controlled = new Map([[0, p]]);
        this._localTeam = 'red';
        this.rebuildTeamCache();

        this.powerUpManager = new PowerUpManager(this.field);
        this.powerUpManager.enabled = false;

        this.practiceMode = true;
        this._resetMatchState();
        this._beginLoop();
    }

    // Online lockstep: every peer calls this with the exact same config
    // (from the host's start message), so the worlds start bit-identical.
    //   cfg.settings   — host's match settings
    //   cfg.seed       — shared RNG seed
    //   cfg.humanSlots — player indices driven by remote/local humans
    //   cfg.mySlot     — the player index this device controls
    startLockstepMatch(cfg) {
        this.settings = { ...this.settings, ...cfg.settings };
        this.practiceMode = false;
        this.isLockstep = true;
        this.isSpectator = false;
        Physics.GAME_SPEED = this._baseGameSpeed;
        this.rng.seed(cfg.seed);

        this._prepareField();
        this._buildPlayers(new Set(cfg.humanSlots));
        this._controlled = new Map();
        for (const slot of cfg.humanSlots) this._controlled.set(slot, this.players[slot]);
        this._mySlot = cfg.mySlot;
        this.humanPlayer = this.players[cfg.mySlot] || null;
        this._localTeam = this.humanPlayer ? this.humanPlayer.team : 'red';

        this.powerUpManager = new PowerUpManager(this.field);
        this.powerUpManager.enabled = this.settings.powerups !== false;

        this._resetMatchState();
        this._beginLoop();
    }

    // --- Main loop ---------------------------------------------------------

    // `frameTime` is the requestAnimationFrame timestamp (vsync-aligned, so
    // much steadier than reading the clock inside the callback).
    loop(frameTime) {
        if (!this.isRunning) { this._rafId = null; return; }

        try {
            const now = frameTime !== undefined ? frameTime : performance.now();
            const elapsed = Math.max(0, Math.min(now - this.lastTime, 250));
            this.lastTime = Math.max(this.lastTime, now);

            let alpha = 1;
            if (!this.isPaused) {
                alpha = this.netplay ? this.netplay.advance(elapsed) : this._advanceOffline(elapsed);
            }

            this.renderer.updateEffects(elapsed);

            // Self-healing: if canvas has bad dimensions, re-resize
            // (iOS WKWebView can report 0 dimensions during transitions)
            if (this.renderer.w < 100 || this.renderer.h < 100) {
                this.renderer.resize();
                this._updateFieldViewScale();
            }

            this.render(alpha, elapsed);
        } catch (err) {
            console.error('Game loop error:', err);
        }

        this._rafId = requestAnimationFrame((t) => this.loop(t));
    }

    // Offline: classic fixed-timestep accumulator. Returns the interpolation
    // factor between the previous and current tick for rendering.
    _advanceOffline(elapsed) {
        this._accumulator += elapsed;
        if (this._accumulator > TICK_MS * 6) this._accumulator = TICK_MS * 6;
        const inputs = this._tickInputs;
        while (this._accumulator >= TICK_MS && this.isRunning) {
            this._accumulator -= TICK_MS;
            inputs.length = 0;
            if (this.humanPlayer) inputs.push(this._mySlot, this.sampleLocalInput());
            this.simTick(inputs);
        }
        return this._accumulator / TICK_MS;
    }

    // Convert raw controller state into one tick's input and consume the
    // one-shot events (kick release, swap) so each is delivered exactly once.
    sampleLocalInput() {
        const src = this.input;
        const inp = {
            x: src.x,
            y: src.y,
            held: !!src.kickCharging,
            release: !!src.kickRelease,
            cr: src.kickRelease ? Math.min((src.kickChargeTime || 0) / KICK_CHARGE_MS, 1) : 0,
            pull: !!src.pull,
            sw: !!src.switchPlayer,
        };
        src.kickRelease = false;
        src.kickChargeTime = 0;
        src.switchPlayer = false;
        return inp;
    }

    // One deterministic 60 Hz step. `inputs` is a flat [slot, input, ...]
    // list for the human-controlled slots this tick.
    simTick(inputs) {
        this._snapPrev();
        this.update(TICK_MS, inputs);
        this.tickCount++;
    }

    _snapPrev() {
        for (const p of this.players) { p._px = p.x; p._py = p.y; }
        if (this.ball) { this.ball._px = this.ball.x; this.ball._py = this.ball.y; }
    }

    // Online: a disconnected human's slot is handed to the AI. Called by the
    // netcode at the same tick on every peer.
    dropSlot(slot) {
        const p = this._controlled.get(slot);
        if (!p) return;
        this._controlled.delete(slot);
        p.isHuman = false;
        p.chargeTicks = 0;
        p.chargeLock = false;
        p.kickChargeRatio = 0;
        if (!this.aiControllers.some(c => c.player === p)) {
            this.aiControllers.push({ player: p, ai: new AIController('normal') });
        }
    }

    // --- Simulation --------------------------------------------------------

    update(dt, inputs) {
        const rawDt = dt;

        // Goal celebration → kickoff reset. Tick-based so every online peer
        // resets on exactly the same tick.
        if (this.isGoalScored) {
            this.goalTimer -= rawDt;
            if (this.goalTimer <= 0) {
                this.isGoalScored = false;
                if (this._dom.goalNotif) this._dom.goalNotif.classList.add('hidden');
                this.resetAfterGoal();
            }
        }
        if (this._endMatchTimer > 0) {
            this._endMatchTimer -= rawDt;
            if (this._endMatchTimer <= 0) {
                this._endMatchTimer = 0;
                this.endMatch();
                return;
            }
        }

        // Recover from slow-motion
        if (this.slowMoTimer > 0) {
            this.slowMoTimer -= dt;
            if (this.slowMoTimer <= 0) {
                this.timeScale = 1.0;
                this.slowMoTimer = 0;
            }
        }

        // Apply time scale for slow-motion effects
        dt *= this.timeScale;
        Physics.dtRatio = this.timeScale * Physics.GAME_SPEED;

        // Timer (skip in practice mode) - use raw dt so timer isn't affected by slow-mo
        if (!this.practiceMode) {
            if (this.suddenDeath) {
                this.suddenDeathTimer += rawDt;
                this.suddenDeathShrink = Math.min(this.suddenDeathTimer / this.suddenDeathMaxTime, 1);

                // Gradually increase ball speed
                Physics.MAX_BALL_SPEED = this._originalMaxBallSpeed + this.suddenDeathShrink * 10;
                this._updateTimerHud();

                // Force end after max time
                if (this.suddenDeathTimer >= this.suddenDeathMaxTime) {
                    this.endMatch();
                    return;
                }
            } else {
                this.timeRemaining -= rawDt;
                if (this.timeRemaining <= 0) {
                    this.timeRemaining = 0;
                    // Sudden death if tied
                    if (this.redScore === this.blueScore) {
                        this.suddenDeath = true;
                        this.suddenDeathTimer = 0;
                        this.suddenDeathShrink = 0;
                        Sound.suddenDeathStart();
                        this.renderer.showSuddenDeath();
                        // Reset positions for sudden death
                        this.ball.reset();
                        for (const p of this.players) p.reset();
                        this.powerUpManager.reset();
                    } else {
                        this.endMatch();
                        return;
                    }
                }

                if (!this.suddenDeath) {
                    this._updateTimerHud();
                    const secs = Math.ceil(this.timeRemaining / 1000);
                    // Countdown beeps in final seconds
                    if (secs <= 5 && secs !== this._lastCountdownSec) {
                        this._lastCountdownSec = secs;
                        if (secs === 1) Sound.countdownFinal();
                        else Sound.countdown();
                    }
                }
            }
        }

        // Momentum decay
        this.momentum.red = Math.max(0, this.momentum.red - this.momentum.decayRate * dt);
        this.momentum.blue = Math.max(0, this.momentum.blue - this.momentum.decayRate * dt);

        // Apply momentum bonus to all players
        for (const p of this.players) {
            p.momentumBonus = this.momentum[p.team] / this.momentum.max;
        }

        // Human input (offline local player, or every slot in lockstep)
        if (inputs) {
            for (let i = 0; i < inputs.length; i += 2) {
                const slot = inputs[i];
                const player = this._controlled.get(slot);
                if (!player) continue;
                const next = this._applyHumanInput(player, inputs[i + 1], slot);
                if (next !== player) {
                    this._controlled.set(slot, next);
                    if (slot === this._mySlot) this.humanPlayer = next;
                }
            }
        }

        // AI input (use cached team arrays — rebuilt on match start, not every frame)
        const redTeam = this._redTeam;
        const blueTeam = this._blueTeam;

        for (const { player, ai } of this.aiControllers) {
            if (player.powerUp === 'frozen' || player.stunTimer > 0) continue;

            const teammates = player.team === 'red' ? redTeam : blueTeam;
            const opponents = player.team === 'red' ? blueTeam : redTeam;

            const action = ai.update(player, this.ball, this.field, teammates, opponents, dt, this.rng);

            if (action.kick) {
                const cr = action.chargeRatio || 0.3;
                this.hitNearbyPlayers(player, cr);
                if (player.kick(this.ball, cr)) this._onKick(player, cr, 0.55, 0.5);
            }
        }

        // Super kick homing: curve ball toward enemy goal
        if (this.ball.superKick > 0 && this.ball.superTarget) {
            const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
            if (ballSpeed > 3) {
                // Target is the center of the enemy goal
                const goalX = this.ball.superTarget === 'right'
                    ? this.field.x + this.field.width
                    : this.field.x;
                const goalY = this.field.goalY + this.field.goalHeight / 2;

                // Direction to goal
                const toGoalX = goalX - this.ball.x;
                const toGoalY = goalY - this.ball.y;
                const toGoalN = Physics.normalize(toGoalX, toGoalY);

                // Gently steer toward goal (dt-scaled)
                const steerForce = 0.12 * Physics.dtRatio;
                this.ball.vx += toGoalN.x * steerForce;
                this.ball.vy += toGoalN.y * steerForce;

                // Maintain speed after steering
                Physics.clampSpeed(this.ball, ballSpeed);
            } else {
                // Ball slowed down, stop homing
                this.ball.superTarget = null;
            }
        }

        // Dash power-up: instant teleport in movement direction + stun nearby opponents
        for (const p of this.players) {
            if (p.dashReady && p.powerUp === 'dash') {
                // Find movement direction (use velocity or input)
                const dx = p.vx;
                const dy = p.vy;
                const speed = Math.sqrt(dx * dx + dy * dy);
                if (speed > 0.5) {
                    const n = Physics.normalize(dx, dy);
                    const dashDist = 80;
                    const oldX = p.x;
                    const oldY = p.y;
                    p.x += n.x * dashDist;
                    p.y += n.y * dashDist;
                    // Stun opponents along the dash path
                    for (const opp of this.players) {
                        if (opp.team === p.team || opp.stunTimer > 0) continue;
                        // Check distance to dash line
                        const dist = Physics.distance(p, opp);
                        const distOld = Physics.distance({ x: oldX, y: oldY }, opp);
                        if (dist < p.radius + opp.radius + 20 || distOld < p.radius + opp.radius + 20) {
                            opp.stunTimer = 400;
                            const knockN = Physics.normalize(opp.x - p.x, opp.y - p.y);
                            opp.vx = knockN.x * 3;
                            opp.vy = knockN.y * 3;
                            this.renderer.spawnHitFlash(opp.x, opp.y, 0.6);
                        }
                    }
                    // Dash visual effect
                    this.renderer.spawnDashTrail(oldX, oldY, p.x, p.y, p.team);
                    Sound.powerUpCollect();
                }
                p.dashReady = false;
                p.powerUp = null;
                p.powerUpTimer = 0;
            }
        }

        // Ball pull ability: active pull attracts ball to player (max range limited)
        for (const p of this.players) {
            if (p.pullActive) {
                const dist = Physics.distance(p, this.ball);
                if (dist >= PULL_RANGE) {
                    // Out of range — cancel pull and start cooldown
                    p.pullActive = false;
                    p.pullCooldown = p.pullCooldownTime;
                } else if (dist > p.radius + this.ball.radius + 5) {
                    const dx = p.x - this.ball.x;
                    const dy = p.y - this.ball.y;
                    const n = Physics.normalize(dx, dy);
                    // Pull force falls off with distance (stronger when closer)
                    const falloff = 1 - (dist / PULL_RANGE);
                    const pullStrength = 0.25 * falloff * Physics.dtRatio;
                    this.ball.vx += n.x * pullStrength;
                    this.ball.vy += n.y * pullStrength;
                    // Slow the ball while pulling (creates a "catching" feel)
                    this.ball.vx *= Math.pow(0.985, Physics.dtRatio);
                    this.ball.vy *= Math.pow(0.985, Physics.dtRatio);
                }
            }
        }

        // Update entities
        for (const p of this.players) p.update(dt);
        this.ball.update(dt);

        // Player-ball collisions
        for (const p of this.players) {
            // Ghost ball: passes through all players except the kicker
            if (this.ball.ghost && this.ball.lastKickedBy && p !== this.ball.lastKickedBy) {
                continue;
            }

            // Fire ball piercing: skip collision with opponents, stun them instead
            if (this.ball.fireLevel > 0 && this.ball.lastKickedBy && p.team !== this.ball.lastKickedBy.team) {
                const dist = Physics.distance(p, this.ball);
                if (dist < p.radius + this.ball.radius && p.stunTimer <= 0 && p.powerUp !== 'shield') {
                    // Pierce through: stun player, slow ball slightly
                    p.stunTimer = 600;
                    const knockDir = Physics.normalize(p.x - this.ball.x, p.y - this.ball.y);
                    p.vx = knockDir.x * 4;
                    p.vy = knockDir.y * 4;
                    this.ball.vx *= 0.9;
                    this.ball.vy *= 0.9;
                    Sound.fireBallPierce();
                    this.renderer.spawnFireImpact(p.x, p.y, this.ball.fireLevel);
                    continue;
                }
            }

            const collided = Physics.resolveCircleCollision(p, this.ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE);

            // Clear kickoff restriction when kickoff team touches or kicks the ball
            if (this.kickoffActive && p.team === this.kickoffTeam) {
                if (collided || this.ball.lastKickedBy === p) {
                    this.kickoffActive = false;
                }
            }

            // Hit flash + sound on collision
            if (collided) {
                const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
                const intensity = Math.min(ballSpeed / Physics.MAX_BALL_SPEED, 1);
                if (intensity > 0.15) {
                    this.renderer.spawnHitFlash(this.ball.x, this.ball.y, intensity);
                    Sound.ballBounce(intensity);
                }

                // Update lastKickedBy on significant deflections — this ensures
                // that if a defender deflects a shot, it's attributed to them, not the original kicker
                if (ballSpeed > 3) {
                    this.ball.lastKickedBy = p;
                }
            }

            // Auto kick on contact: a human charging (any amount) who touches
            // the ball kicks it with the current charge. The rest of that
            // charge is spent — releasing the button afterwards does nothing.
            if (collided && p.chargeTicks > 0 && !p.chargeLock) {
                const cr = p.kickChargeRatio || 0.1;
                if (p.kick(this.ball, cr)) {
                    this._onKick(p, cr, 0.85, 0.7);
                    p.chargeTicks = 0;
                    p.kickChargeRatio = 0;
                    p.chargeLock = true;
                    if (p === this.humanPlayer) {
                        this.input.kickCharging = false;
                        this.input.kickRelease = false;
                        this.input.kickChargeTime = 0;
                    }
                }
            }

            // Power kick ball hits any player: knock them back and stun based on speed
            // Shield power-up: immune to stun and knockback
            if (collided && this.ball.lastKickedBy && p !== this.ball.lastKickedBy && p.powerUp !== 'shield') {
                const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
                const speedRatio = ballSpeed / Physics.MAX_BALL_SPEED;
                if (this.ball.superKick > 0) {
                    // Fire ball: heavy stun and knockback
                    p.stunTimer = 600 + speedRatio * 600;
                    if (ballSpeed > 0.5) {
                        const knockbackForce = 3 + speedRatio * 8;
                        const nx = this.ball.vx / ballSpeed;
                        const ny = this.ball.vy / ballSpeed;
                        p.vx += nx * knockbackForce;
                        p.vy += ny * knockbackForce;
                    }
                    this.renderer.spawnHitFlash(p.x, p.y, 0.8);
                } else if (ballSpeed > 8) {
                    // Fast regular kick: lighter stun and knockback
                    p.stunTimer = 200 + speedRatio * 400;
                    const knockbackForce = 1.5 + speedRatio * 4;
                    const nx = this.ball.vx / ballSpeed;
                    const ny = this.ball.vy / ballSpeed;
                    p.vx += nx * knockbackForce;
                    p.vy += ny * knockbackForce;
                    this.renderer.spawnHitFlash(p.x, p.y, 0.5);
                }
            }
        }

        // Player-player collisions (no sound by design)
        for (let i = 0; i < this.players.length; i++) {
            for (let j = i + 1; j < this.players.length; j++) {
                Physics.resolveCircleCollision(
                    this.players[i], this.players[j],
                    Physics.PLAYER_BOUNCE, Physics.PLAYER_BOUNCE
                );
            }
        }

        // Sudden death: shrink field walls
        if (this.suddenDeath && this.suddenDeathShrink > 0) {
            const maxShrink = 0.15; // Shrink up to 15% on each side
            const s = this.suddenDeathShrink * maxShrink;
            const shrinkX = this.field.width * s;
            const shrinkY = this.field.height * s;
            // Temporarily adjust field for constraint, then restore
            const origX = this.field.x, origY = this.field.y, origW = this.field.width, origH = this.field.height;
            this.field.x += shrinkX;
            this.field.y += shrinkY;
            this.field.width -= shrinkX * 2;
            this.field.height -= shrinkY * 2;
            for (const p of this.players) Physics.constrainToField(p, this.field, true);
            this.field.x = origX; this.field.y = origY;
            this.field.width = origW; this.field.height = origH;
        } else {
            for (const p of this.players) Physics.constrainToField(p, this.field, true);
        }

        // Kickoff restriction:
        // Both teams: blocked at center line
        // Scoring team: also can't enter center circle
        if (this.kickoffActive && this.kickoffTeam) {
            const centerX = this.field.centerX;
            const centerY = this.field.centerY;
            const circleR = this.field.centerRadius;
            const scoringTeam = this.kickoffTeam === 'red' ? 'blue' : 'red';
            for (const p of this.players) {
                const dx = p.x - centerX;
                const dy = p.y - centerY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const insideCircle = dist < circleR;

                if (p.team === scoringTeam) {
                    // Scoring team: blocked at center line
                    if (scoringTeam === 'red') {
                        if (p.x + p.radius > centerX) {
                            p.x = centerX - p.radius;
                            if (p.vx > 0) p.vx = 0;
                        }
                    } else {
                        if (p.x - p.radius < centerX) {
                            p.x = centerX + p.radius;
                            if (p.vx < 0) p.vx = 0;
                        }
                    }
                    // Scoring team: can't enter center circle
                    const minDist = circleR + p.radius;
                    if (dist < minDist && dist > 0) {
                        const nx = dx / dist;
                        const ny = dy / dist;
                        p.x = centerX + nx * minDist;
                        p.y = centerY + ny * minDist;
                        const dot = p.vx * nx + p.vy * ny;
                        if (dot < 0) {
                            p.vx -= dot * nx;
                            p.vy -= dot * ny;
                        }
                    }
                } else {
                    // Scored-on team: center line + circle barrier
                    // Center-based circle check, center-based containment = small corrections
                    const onOppSide = (p.team === 'red' && p.x + p.radius > centerX) ||
                                       (p.team === 'blue' && p.x - p.radius < centerX);
                    if (onOppSide) {
                        if (insideCircle) {
                            // Center is inside circle: contain center within circle
                            if (dist > circleR - 1 && dist > 0) {
                                const nx = dx / dist;
                                const ny = dy / dist;
                                p.x = centerX + nx * (circleR - 1);
                                p.y = centerY + ny * (circleR - 1);
                                const dot = p.vx * nx + p.vy * ny;
                                if (dot > 0) {
                                    p.vx -= dot * nx;
                                    p.vy -= dot * ny;
                                }
                            }
                        } else {
                            // Center is outside circle: clamp to center line
                            if (p.team === 'red') {
                                p.x = centerX - p.radius;
                                if (p.vx > 0) p.vx = 0;
                            } else {
                                p.x = centerX + p.radius;
                                if (p.vx < 0) p.vx = 0;
                            }
                        }
                    }
                }
            }
        }
        const wallHit = Physics.constrainToField(this.ball, this.field, false);
        if (wallHit) {
            const spd = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
            Sound.wallBounce(spd);
            // Fire upgrade: wall bounce while on fire at high speed → blue fire
            if (this.ball.fireLevel === 1 && spd > 6) {
                this.ball.ignite(2);
            }
        }

        // Super kick ends once the ball has slowed down
        if (this.ball.superKick > 0) {
            const spd = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
            if (spd < 3) this.ball.superKick = 0;
        }

        // Track possession
        let closestRed = Infinity, closestBlue = Infinity;
        for (const p of this.players) {
            const d = Physics.distance(p, this.ball);
            if (p.team === 'red' && d < closestRed) closestRed = d;
            if (p.team === 'blue' && d < closestBlue) closestBlue = d;
        }
        if (closestRed < closestBlue) this.stats.possession.red += dt;
        else this.stats.possession.blue += dt;

        // Power-ups
        const collected = this.powerUpManager.update(dt, this.players, this.suddenDeath, this.rng);
        if (collected) {
            const notif = this._dom.powerUpNotif;
            if (notif) {
                if (this._dom.powerUpText) this._dom.powerUpText.textContent = collected.type.label;
                notif.classList.remove('hidden');
                if (this._powerUpNotifTimer) clearTimeout(this._powerUpNotifTimer);
                this._powerUpNotifTimer = this._setTimeout(() => {
                    notif.classList.add('hidden');
                    this._powerUpNotifTimer = null;
                }, 2000);
            }
            if (collected.type.id === 'freeze' || collected.type.id === 'slow') Sound.freeze();
            else Sound.powerUpCollect();
        }

        // Check goal (skip if already celebrating)
        if (!this.isGoalScored) {
            const goal = Physics.checkGoal(this.ball, this.field);
            if (goal) {
                this.scoreGoal(goal);
            }
        }
    }

    // Apply one tick of a human's input to the player they control. Pure
    // function of (state, input) so online peers stay in sync. Returns the
    // player the slot controls afterwards (changes on SWAP).
    _applyHumanInput(player, inp, slot) {
        const isLocal = slot === this._mySlot;
        const canAct = player.powerUp !== 'frozen' && player.stunTimer <= 0;

        if (canAct) player.applyInput(inp.x, inp.y);

        // Kick release. If an auto-kick on contact already spent this charge,
        // the release just clears that lock.
        if (inp.release) {
            if (player.chargeLock) {
                player.chargeLock = false;
            } else if (canAct) {
                this.hitNearbyPlayers(player, inp.cr);
                if (player.kick(this.ball, inp.cr)) this._onKick(player, inp.cr, 0.85, 0.7);
            }
        }

        // Charging: power ramps up while held, and the player slows down
        if (inp.held && !player.chargeLock) {
            player.chargeTicks++;
            player.kickChargeRatio = Math.min(player.chargeTicks * TICK_MS / KICK_CHARGE_MS, 1);
            if (canAct) {
                const slowFactor = Math.pow(1 - player.kickChargeRatio * 0.015, Physics.dtRatio);
                player.vx *= slowFactor;
                player.vy *= slowFactor;
            }
        } else {
            player.chargeTicks = 0;
            player.kickChargeRatio = 0;
            if (!inp.held) player.chargeLock = false;
        }

        // Pull (hold): must start within range, releasing ends it early
        if (inp.pull) {
            if (!player.pullActive && player.pullCooldown <= 0 && Physics.distance(player, this.ball) < PULL_RANGE) {
                player.activatePull();
                if (isLocal) Sound.pullActivate();
            }
        } else if (player.pullActive) {
            player.pullActive = false;
            player.pullDuration = 0;
            player.pullCooldown = player.pullCooldownTime;
        }

        if (inp.sw) {
            const next = this._swapToNearestTeammate(player);
            if (isLocal) Sound.switchPlayer();
            if (next !== player) {
                // The held kick carries over to the new player
                next.chargeTicks = player.chargeTicks;
                next.chargeLock = player.chargeLock;
                next.kickChargeRatio = player.kickChargeRatio;
                player.chargeTicks = 0;
                player.chargeLock = false;
                player.kickChargeRatio = 0;
            }
            return next;
        }
        return player;
    }

    _onKick(player, cr, shakeScale, flashScale) {
        this.stats.shots[player.team]++;
        this.renderer.triggerShake(0.15 + cr * shakeScale);
        this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + cr * flashScale);
        Sound.kick(cr);
        const towardGoal = (player.team === 'red' && this.ball.vx > 0) || (player.team === 'blue' && this.ball.vx < 0);
        if (towardGoal) this.addMomentum(player.team);
    }

    scoreGoal(team) {
        // Fire ball scoring: 2x for level 1, 3x for level 2
        const fireLevel = this.ball.fireLevel || 0;
        const goalPoints = fireLevel >= 2 ? 3 : fireLevel >= 1 ? 2 : 1;

        if (team === 'red') this.redScore += goalPoints;
        else this.blueScore += goalPoints;
        this._updateScoreHud();

        // Track who scored — only credit if they scored for their own team (not own goal)
        const scorer = this.ball.lastKickedBy;
        const isOwnGoal = scorer && scorer.team !== team;
        if (scorer && !isOwnGoal) {
            scorer.goals += goalPoints;
        }

        // Combo tracking
        if (team === this.combo.team) {
            this.combo.count++;
        } else {
            this.combo = { team: team, count: 1 };
        }

        // Combo effects
        const comboNames = ['', '', 'DOUBLE!', 'HAT TRICK!', 'UNSTOPPABLE!', 'LEGENDARY!'];
        if (this.combo.count >= 2) {
            const comboLevel = Math.min(this.combo.count, 5);
            const comboText = comboNames[comboLevel] || 'LEGENDARY!';
            this.renderer.showComboPopup(comboText, team);
            Sound.comboSound(comboLevel - 1);
        }

        // Show notification
        const notif = this._dom.goalNotif;
        let goalText = isOwnGoal ? 'OWN GOAL!' : 'GOAL!';
        if (fireLevel >= 2) goalText = 'INFERNO GOAL!!!';
        else if (fireLevel >= 1) goalText = 'FIRE GOAL!';
        if (this._dom.goalText) this._dom.goalText.textContent = goalText;
        if (this._dom.goalScorer) {
            this._dom.goalScorer.textContent =
                scorer ? `${team.toUpperCase()} Team${goalPoints > 1 ? ' (+' + goalPoints + ')' : ''}` : '';
        }
        if (notif) notif.classList.remove('hidden');

        this.isGoalScored = true;
        this.goalTimer = 2500;

        // Set kickoff team: the team that was scored ON gets the kickoff
        this.kickoffTeam = team === 'red' ? 'blue' : 'red';

        // Goal sound + heavy screen shake (bigger for fire goals)
        if (fireLevel >= 1) Sound.fireGoal(fireLevel);
        else Sound.goal();
        this.renderer.triggerShake(1.0);

        // Slow-motion on goal (timer-based, not setTimeout)
        this.timeScale = 0.3;
        this.slowMoTimer = fireLevel >= 1 ? 1200 : 800;

        // Momentum boost for scoring team
        this.addMomentum(team, 2);

        // Confetti explosion (double for fire goals)
        this.renderer.spawnConfetti(team);
        if (fireLevel >= 1) this.renderer.spawnConfetti(team);

        // Net ripple: ball scored in left goal = blue scored, right goal = red scored
        const netSide = team === 'blue' ? 'left' : 'right';
        this.renderer.triggerNetRipple(netSide, this.ball.y, this.field);

        // Sudden death: first goal wins
        if (this.suddenDeath) {
            this._scheduleEndMatch(2100);
            return;
        }

        // Check goal limit
        if (this.settings.goalLimit > 0) {
            if (this.redScore >= this.settings.goalLimit || this.blueScore >= this.settings.goalLimit) {
                this._scheduleEndMatch(2100);
            }
        }
    }

    // Ends the match after `ms` of game time (tick-based, so online peers
    // end on the same tick).
    _scheduleEndMatch(ms) {
        if (this._endMatchTimer > 0) return;
        this._endMatchTimer = ms;
    }

    resetAfterGoal() {
        this.ball.reset();
        for (const p of this.players) p.reset();
        this.powerUpManager.reset();

        // Activate kickoff restriction: the team that did NOT score gets kickoff
        // The scoring team cannot cross the center line until the other team touches the ball
        this.kickoffActive = true;
    }

    endMatch() {
        if (this.matchOver) return;
        this.isRunning = false;
        this.matchOver = true;
        this.suddenDeath = false;
        this.suddenDeathTimer = 0;
        this.suddenDeathShrink = 0;
        this.resetMapPhysics();
        if (this._dom.timer) this._dom.timer.style.color = '';
        Sound.stopMusic();
        Sound.whistle(true);

        const resultOverlay = this._dom.resultOverlay;
        const title = this._dom.resultTitle;
        const score = this._dom.resultScore;
        const stats = this._dom.matchStats;

        const localTeam = this._localTeam;
        const localScore = localTeam === 'red' ? this.redScore : this.blueScore;
        const remoteScore = localTeam === 'red' ? this.blueScore : this.redScore;

        if (title) {
            if (this.isSpectator) {
                if (this.redScore > this.blueScore) {
                    title.textContent = 'RED WINS!';
                    title.style.color = '#e94560';
                } else if (this.blueScore > this.redScore) {
                    title.textContent = 'BLUE WINS!';
                    title.style.color = '#53d8fb';
                } else {
                    title.textContent = 'DRAW';
                    title.style.color = '#aaa';
                }
                Physics.GAME_SPEED = this._baseGameSpeed;
            } else if (localScore > remoteScore) {
                title.textContent = 'YOU WIN!';
                title.style.color = '#4caf50';
                this._setTimeout(() => Sound.win(), 400);
            } else if (remoteScore > localScore) {
                title.textContent = 'YOU LOSE';
                title.style.color = '#e94560';
                this._setTimeout(() => Sound.lose(), 400);
            } else {
                title.textContent = 'DRAW';
                title.style.color = '#53d8fb';
            }
        }

        if (score) this._renderScoreDuo(score, this.redScore, this.blueScore);

        const totalPoss = this.stats.possession.red + this.stats.possession.blue;
        const redPoss = totalPoss > 0 ? Math.round((this.stats.possession.red / totalPoss) * 100) : 50;

        if (stats) this._renderMatchStats(stats, redPoss, this.isSpectator);

        if (resultOverlay) resultOverlay.classList.remove('hidden');
        if (this.onMatchEnd) this.onMatchEnd();
    }

    // Build red-blue "X - Y" score markup safely (no innerHTML with interpolation)
    _renderScoreDuo(el, red, blue) {
        el.textContent = '';
        const redSpan = document.createElement('span');
        redSpan.style.color = '#e94560';
        redSpan.textContent = String(red);
        const blueSpan = document.createElement('span');
        blueSpan.style.color = '#53d8fb';
        blueSpan.textContent = String(blue);
        el.appendChild(redSpan);
        el.appendChild(document.createTextNode(' - '));
        el.appendChild(blueSpan);
    }

    // Build match stats DOM without innerHTML
    _renderMatchStats(el, redPoss, isSpectator) {
        el.textContent = '';
        const addRow = (label, redVal, blueVal) => {
            const row = document.createElement('div');
            row.appendChild(document.createTextNode(label + ': '));
            const r = document.createElement('span');
            r.style.color = '#e94560';
            r.textContent = String(redVal);
            row.appendChild(r);
            row.appendChild(document.createTextNode(' - '));
            const b = document.createElement('span');
            b.style.color = '#53d8fb';
            b.textContent = String(blueVal);
            row.appendChild(b);
            el.appendChild(row);
        };
        addRow('Possession', redPoss + '%', (100 - redPoss) + '%');
        addRow('Shots', this.stats.shots.red, this.stats.shots.blue);
        if (!isSpectator) {
            const goals = document.createElement('div');
            goals.textContent = `Your Goals: ${this.humanPlayer ? this.humanPlayer.goals : 0}`;
            el.appendChild(goals);
            const kicks = document.createElement('div');
            kicks.textContent = `Your Kicks: ${this.humanPlayer ? this.humanPlayer.kicks : 0}`;
            el.appendChild(kicks);
        }
    }

    hitNearbyPlayers(kicker, chargeRatio) {
        if (chargeRatio < 0.25) return;
        const hitRange = kicker.radius + 40;
        const knockForce = 1.5 + chargeRatio * 3.5;
        for (const p of this.players) {
            if (p === kicker || p.team === kicker.team) continue;
            const dist = Physics.distance(kicker, p);
            if (dist < hitRange && dist > 0) {
                const dx = p.x - kicker.x;
                const dy = p.y - kicker.y;
                const n = Physics.normalize(dx, dy);
                p.vx += n.x * knockForce;
                p.vy += n.y * knockForce;
                p.stunTimer = 200 + chargeRatio * 800;
                this.renderer.spawnHitFlash(p.x, p.y, 0.3 + chargeRatio * 0.5);
            }
        }
    }

    addMomentum(team, amount = 1) {
        this.momentum[team] = Math.min(this.momentum.max, this.momentum[team] + amount);
    }

    _isControlledByHuman(player) {
        for (const p of this._controlled.values()) if (p === player) return true;
        return false;
    }

    // Swap control from `current` to the teammate closest to the ball.
    // Returns the new human player (or `current` if no swap happened).
    // Never swaps onto a teammate another human is already controlling, and
    // never creates duplicate AI controllers for the same player.
    _swapToNearestTeammate(current) {
        if (!current) return current;
        let nearest = null;
        let nearestDist = Infinity;
        for (const p of this.players) {
            if (p.team !== current.team || p === current || this._isControlledByHuman(p)) continue;
            const d = Physics.distance(p, this.ball);
            if (d < nearestDist) { nearestDist = d; nearest = p; }
        }
        if (!nearest) return current;

        current.isHuman = false;
        if (!this.aiControllers.some(c => c.player === current)) {
            this.aiControllers.push({
                player: current,
                ai: this.isLockstep ? new AIController('normal') : new AIController(this.settings.difficulty || 'normal'),
            });
        }
        nearest.isHuman = true;
        this.aiControllers = this.aiControllers.filter(c => c.player !== nearest);
        return nearest;
    }

    // --- Online state snapshot / checksum -----------------------------------

    // Everything the simulation reads, in plain JSON-safe form. Used for the
    // periodic desync checksum and to resync a peer from the host.
    serializeSim() {
        const idx = (p) => (p ? this.players.indexOf(p) : -1);
        const b = this.ball;
        const pm = this.powerUpManager;
        return {
            t: this.tickCount,
            rng: this.rng.s,
            sc: [this.redScore, this.blueScore, this.timeRemaining],
            g: [this.isGoalScored ? 1 : 0, this.goalTimer, this._endMatchTimer],
            ko: [this.kickoffTeam, this.kickoffActive ? 1 : 0],
            ts: [this.timeScale, this.slowMoTimer],
            mo: [this.momentum.red, this.momentum.blue],
            cb: [this.combo.team, this.combo.count],
            sd: [this.suddenDeath ? 1 : 0, this.suddenDeathTimer, this.suddenDeathShrink, Physics.MAX_BALL_SPEED],
            st: [this.stats.possession.red, this.stats.possession.blue, this.stats.shots.red, this.stats.shots.blue],
            p: this.players.map(p => [
                p.x, p.y, p.vx, p.vy, p.kickCooldown, p.powerUp, p.powerUpTimer,
                p.goals, p.kicks, p.stunTimer, p.momentumBonus, p.dashReady ? 1 : 0,
                p.pullActive ? 1 : 0, p.pullCooldown, p.pullDuration, p.isHuman ? 1 : 0,
                p.chargeTicks, p.chargeLock ? 1 : 0, p.kickChargeRatio,
            ]),
            b: [b.x, b.y, b.vx, b.vy, idx(b.lastKickedBy), b.spin, b.superKick, b.superTarget,
                b.fireLevel, b.fireDuration, b.ghost ? 1 : 0, b.ghostTimer],
            pu: [pm.spawnTimer, pm.powerUps.map(pu => [pu.x, pu.y, pu.radius, pu.type.id])],
            ai: this.aiControllers.map(({ player, ai }) => [
                idx(player), ai.targetX, ai.targetY, ai.decisionTimer, ai.role, ai.aimX, ai.aimY,
            ]),
            ctl: Array.from(this._controlled, ([slot, p]) => [slot, idx(p)]),
        };
    }

    stateHash() {
        return hashValue(0x811c9dc5, this.serializeSim()) | 0;
    }

    restoreSim(s) {
        this.tickCount = s.t;
        this.rng.s = s.rng;
        [this.redScore, this.blueScore, this.timeRemaining] = s.sc;
        this.isGoalScored = s.g[0] === 1;
        this.goalTimer = s.g[1];
        this._endMatchTimer = s.g[2];
        this.kickoffTeam = s.ko[0];
        this.kickoffActive = s.ko[1] === 1;
        [this.timeScale, this.slowMoTimer] = s.ts;
        [this.momentum.red, this.momentum.blue] = s.mo;
        this.combo = { team: s.cb[0], count: s.cb[1] };
        this.suddenDeath = s.sd[0] === 1;
        this.suddenDeathTimer = s.sd[1];
        this.suddenDeathShrink = s.sd[2];
        Physics.MAX_BALL_SPEED = s.sd[3];
        [this.stats.possession.red, this.stats.possession.blue, this.stats.shots.red, this.stats.shots.blue] = s.st;

        for (let i = 0; i < this.players.length && i < s.p.length; i++) {
            const p = this.players[i];
            const a = s.p[i];
            p.x = a[0]; p.y = a[1]; p.vx = a[2]; p.vy = a[3];
            p.kickCooldown = a[4]; p.powerUp = a[5]; p.powerUpTimer = a[6];
            p.goals = a[7]; p.kicks = a[8]; p.stunTimer = a[9]; p.momentumBonus = a[10];
            p.dashReady = a[11] === 1; p.pullActive = a[12] === 1;
            p.pullCooldown = a[13]; p.pullDuration = a[14]; p.isHuman = a[15] === 1;
            p.chargeTicks = a[16]; p.chargeLock = a[17] === 1; p.kickChargeRatio = a[18];
        }

        const b = this.ball;
        const ba = s.b;
        b.x = ba[0]; b.y = ba[1]; b.vx = ba[2]; b.vy = ba[3];
        b.lastKickedBy = ba[4] >= 0 ? this.players[ba[4]] : null;
        b.spin = ba[5]; b.superKick = ba[6]; b.superTarget = ba[7];
        b.fireLevel = ba[8]; b.fireDuration = ba[9]; b.ghost = ba[10] === 1; b.ghostTimer = ba[11];

        const pm = this.powerUpManager;
        pm.spawnTimer = s.pu[0];
        pm.powerUps = s.pu[1].map(([x, y, radius, typeId]) => ({
            x, y, radius,
            type: pm.types.find(t => t.id === typeId) || pm.types[0],
            bobTimer: 0, scale: 1, rotateTimer: 0, pulseTimer: 0, spawnTime: Date.now(),
        }));

        this.aiControllers = s.ai.map(([pi, tx, ty, dtm, role, ax, ay]) => {
            const ai = new AIController('normal');
            ai.targetX = tx; ai.targetY = ty; ai.decisionTimer = dtm;
            ai.role = role; ai.aimX = ax; ai.aimY = ay;
            return { player: this.players[pi], ai };
        });

        this._controlled = new Map(s.ctl.map(([slot, pi]) => [slot, this.players[pi]]));
        const mine = this._controlled.get(this._mySlot);
        if (mine) this.humanPlayer = mine;

        this._snapPrev();
        this._updateScoreHud();
        this._updateTimerHud();
        if (this._dom.goalNotif && !this.isGoalScored) this._dom.goalNotif.classList.add('hidden');
    }

    // --- HUD ----------------------------------------------------------------

    _updateScoreHud() {
        if (this._hud.red !== this.redScore && this._dom.redScore) {
            this._dom.redScore.textContent = this.redScore;
            this._hud.red = this.redScore;
        }
        if (this._hud.blue !== this.blueScore && this._dom.blueScore) {
            this._dom.blueScore.textContent = this.blueScore;
            this._hud.blue = this.blueScore;
        }
    }

    // Writes the clock only when the shown text changes (it ticks 60x/s)
    _updateTimerHud() {
        const el = this._dom.timer;
        if (!el) return;
        let text;
        if (this.practiceMode) {
            text = 'PRACTICE';
        } else {
            const ms = this.suddenDeath ? this.suddenDeathTimer : this.timeRemaining;
            const secs = Math.ceil(ms / 1000);
            text = `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, '0')}`;
        }
        if (text !== this._hud.timer) {
            el.textContent = text;
            this._hud.timer = text;
            el.style.color = this.suddenDeath ? '#ff4444' : '';
        }
    }

    // Charge shown on this device: driven by the real button so it responds
    // instantly, even online where the simulation runs a few ticks behind.
    _localChargeRatio() {
        const hp = this.humanPlayer;
        if (!hp || !this.input.kickCharging) return 0;
        if (hp.powerUp === 'frozen' || hp.stunTimer > 0) return 0;
        return Math.min((performance.now() - (this.input.kickChargeStart || performance.now())) / KICK_CHARGE_MS, 1);
    }

    _updateKickChargeMeter(ratio) {
        const btn = this._dom.kickBtn;
        if (!btn) return;
        const charging = this.input.kickCharging && ratio > 0;
        const q = charging ? Math.round(ratio * 100) / 100 : 0;
        if (q === this._hud.charge) return;
        this._hud.charge = q;
        if (charging) {
            btn.classList.add('charging');
            btn.style.setProperty('--charge', q.toFixed(2));
        } else {
            btn.classList.remove('charging');
            btn.style.setProperty('--charge', '0');
        }
    }

    _updatePullButton() {
        const pullBtn = this._dom.pullBtn;
        const hp = this.humanPlayer;
        if (!pullBtn || !hp) return;
        let state;
        if (hp.pullActive || hp.pullCooldown <= 0) state = 'PULL';
        else state = Math.ceil(hp.pullCooldown / 1000) + 's';
        if (state === this._hud.pull) return;
        this._hud.pull = state;
        pullBtn.textContent = state;
        pullBtn.classList.toggle('on-cooldown', state !== 'PULL');
    }

    // --- Rendering ----------------------------------------------------------

    // Move entities to their interpolated positions for drawing. Returns
    // true if positions were changed and must be restored afterwards.
    _applyInterpolation(alpha) {
        if (alpha >= 0.999 || !this.ball) return false;
        const lerp = (e, maxStep) => {
            e._rx = e.x;
            e._ry = e.y;
            if (e._px === undefined) return;
            const dx = e.x - e._px;
            const dy = e.y - e._py;
            if (dx * dx + dy * dy > maxStep * maxStep) return;
            e.x = e._px + dx * alpha;
            e.y = e._py + dy * alpha;
        };
        for (const p of this.players) lerp(p, INTERP_MAX_PLAYER);
        lerp(this.ball, INTERP_MAX_BALL);
        return true;
    }

    _undoInterpolation() {
        for (const p of this.players) { p.x = p._rx; p.y = p._ry; }
        this.ball.x = this.ball._rx;
        this.ball.y = this.ball._ry;
    }

    render(alpha = 1, elapsed = TICK_MS) {
        const interpolated = this._applyInterpolation(alpha);
        try {
            this._draw(elapsed);
        } finally {
            if (interpolated) this._undoInterpolation();
        }
    }

    _draw(elapsed) {
        const r = this.renderer;
        const ctx = r.ctx;
        r.clear();

        // World space (camera)
        const fvs = r.fieldViewScale;
        ctx.save();
        if (this.cameraZoom !== 1) {
            // Camera follows player (or ball in spectator mode)
            const target = this.humanPlayer || this.ball;
            const follow = 1 - Math.pow(0.9, elapsed / TICK_MS);
            this._cameraX += (target.x - this._cameraX) * follow;
            this._cameraY += (target.y - this._cameraY) * follow;
            const zoom = fvs * this.cameraZoom;
            ctx.translate(r.w / 2, r.h / 2);
            ctx.scale(zoom, zoom);
            ctx.translate(-this._cameraX, -this._cameraY);
        } else {
            ctx.translate(r.fieldViewOffsetX, r.fieldViewOffsetY);
            ctx.scale(fvs, fvs);
        }

        r.trackedBall = this.ball;
        r._currentMapType = this.field.mapType;
        r.drawField(this.field);

        // Kickoff barrier visual
        if (this.kickoffActive && this.kickoffTeam) {
            const scoringTeam = this.kickoffTeam === 'red' ? 'blue' : 'red';
            r.drawKickoffBarrier(this.field, scoringTeam);
            r.drawKickoffBarrierLine(this.field, this.kickoffTeam);
        }

        this.powerUpManager.draw(ctx);

        const chargeRatio = this._localChargeRatio();
        for (const p of this.players) {
            const isControlled = p === this.humanPlayer;
            r.drawPlayer(p, isControlled, isControlled ? chargeRatio : 0);
        }

        // Pull ability visual links (only when in range)
        for (const p of this.players) {
            if (p.pullActive) {
                const dist = Physics.distance(p, this.ball);
                if (dist < PULL_RANGE) r.drawPullLink(p, this.ball, dist);
            }
        }

        // Pull cooldown indicator for the controlled player
        if (this.humanPlayer) r.drawPullIndicator(this.humanPlayer);

        r.drawBall(this.ball);
        r.drawDashTrails();
        r.drawHitFlashes();

        if (this.suddenDeath) r.drawSuddenDeathOverlay(this.field, this.suddenDeathShrink);

        ctx.restore();

        // Screen space
        if (r.goalFlashTimer > 0) {
            const alpha = (r.goalFlashTimer / 500) * 0.3;
            ctx.fillStyle = r.goalFlashTeam === 'red'
                ? `rgba(233, 69, 96, ${alpha})`
                : `rgba(83, 216, 251, ${alpha})`;
            ctx.fillRect(0, 0, r.w, r.h);
        }
        r.drawConfetti();
        r.drawComboPopup();
        if (this.suddenDeath) r.drawSuddenDeathHUD();

        // Off-screen indicators and minimap when zoomed in
        if (this.cameraZoom > 1.05) {
            this._drawOffScreenArrows(ctx);
            this._drawMinimap(ctx);
        }

        // End frame (restore screen shake transform)
        r.endFrame();

        this._updateKickChargeMeter(chargeRatio);
        this._updatePullButton();
    }

    _worldToScreen(wx, wy) {
        const fvs = this.renderer.fieldViewScale;
        const zoom = fvs * this.cameraZoom;
        const halfW = this.renderer.w / 2;
        const halfH = this.renderer.h / 2;
        return {
            x: halfW + (wx - this._cameraX) * zoom,
            y: halfH + (wy - this._cameraY) * zoom
        };
    }

    _drawOffScreenArrows(ctx) {
        const w = this.renderer.w;
        const h = this.renderer.h;
        const margin = 30;
        const arrowSize = 10;

        const drawArrow = (wx, wy, color) => {
            const s = this._worldToScreen(wx, wy);
            // Check if on screen
            if (s.x >= -20 && s.x <= w + 20 && s.y >= -20 && s.y <= h + 20) return;
            // Clamp to screen edge
            const cx = w / 2, cy = h / 2;
            const dx = s.x - cx, dy = s.y - cy;
            const angle = Math.atan2(dy, dx);
            const ex = Math.max(margin, Math.min(w - margin, cx + Math.cos(angle) * (w / 2 - margin)));
            const ey = Math.max(margin, Math.min(h - margin, cy + Math.sin(angle) * (h / 2 - margin)));

            ctx.save();
            ctx.translate(ex, ey);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(arrowSize, 0);
            ctx.lineTo(-arrowSize, -arrowSize * 0.7);
            ctx.lineTo(-arrowSize, arrowSize * 0.7);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.8;
            ctx.fill();
            ctx.restore();
        };

        // Ball arrow (white)
        drawArrow(this.ball.x, this.ball.y, '#fff');

        // Player arrows
        for (const p of this.players) {
            if (p === this.humanPlayer) continue;
            drawArrow(p.x, p.y, p.team === 'red' ? '#ff4d6d' : '#4dd4ff');
        }
    }

    _drawMinimap(ctx) {
        const mmW = 140, mmH = 90;
        const mmX = 10, mmY = 50;
        const f = this.field;

        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#0a0e27';
        ctx.fillRect(mmX, mmY, mmW, mmH);
        ctx.strokeStyle = '#4dd4ff';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.4;
        ctx.strokeRect(mmX, mmY, mmW, mmH);

        // Scale field to minimap
        const sx = (x) => mmX + ((x - f.x) / f.width) * mmW;
        const sy = (y) => mmY + ((y - f.y) / f.height) * mmH;

        // Field border
        ctx.strokeStyle = '#1e3a6e';
        ctx.globalAlpha = 0.5;
        ctx.strokeRect(mmX + 1, mmY + 1, mmW - 2, mmH - 2);

        // Center line
        ctx.beginPath();
        ctx.moveTo(mmX + mmW / 2, mmY);
        ctx.lineTo(mmX + mmW / 2, mmY + mmH);
        ctx.stroke();

        // Players
        ctx.globalAlpha = 0.9;
        for (const p of this.players) {
            ctx.beginPath();
            ctx.arc(sx(p.x), sy(p.y), p === this.humanPlayer ? 3.5 : 2.5, 0, Math.PI * 2);
            ctx.fillStyle = p.team === 'red' ? '#ff4d6d' : '#4dd4ff';
            ctx.fill();
            if (p === this.humanPlayer) {
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }

        // Ball
        ctx.beginPath();
        ctx.arc(sx(this.ball.x), sy(this.ball.y), 2, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();

        // Camera viewport rectangle
        const fvs = this.renderer.fieldViewScale;
        const zoom = fvs * this.cameraZoom;
        const viewW = this.renderer.w / zoom;
        const viewH = this.renderer.h / zoom;
        const vx = sx(this._cameraX - viewW / 2);
        const vy = sy(this._cameraY - viewH / 2);
        const vw = (viewW / f.width) * mmW;
        const vh = (viewH / f.height) * mmH;
        ctx.strokeStyle = '#fff';
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.strokeRect(vx, vy, vw, vh);

        ctx.restore();
    }

    // --- Lifecycle ----------------------------------------------------------

    // RL training (AI Lab) keeps every CPU core busy; pause it while a match
    // is on screen so the game loop gets a stable frame rate.
    _pauseBackgroundWork() {
        for (const orch of [window.rlOrch, window.rlOrch2v2]) {
            if (orch && typeof orch.pause === 'function') orch.pause();
        }
    }

    _resumeBackgroundWork() {
        for (const orch of [window.rlOrch, window.rlOrch2v2]) {
            if (orch && typeof orch.resume === 'function') orch.resume();
        }
    }

    pause() {
        if (this.isLockstep) return; // No pausing in online matches
        this.isPaused = true;
        Sound.pause();
        if (this._dom.pauseOverlay) this._dom.pauseOverlay.classList.remove('hidden');
    }

    resume() {
        this.isPaused = false;
        this.lastTime = performance.now();
        Sound.resume();
        if (this._dom.pauseOverlay) this._dom.pauseOverlay.classList.add('hidden');
    }

    restart() {
        if (this._dom.pauseOverlay) this._dom.pauseOverlay.classList.add('hidden');
        if (this._dom.resultOverlay) this._dom.resultOverlay.classList.add('hidden');
        if (this._dom.goalNotif) this._dom.goalNotif.classList.add('hidden');
        if (this._dom.powerUpNotif) this._dom.powerUpNotif.classList.add('hidden');
        if (this.practiceMode) this.startPractice();
        else this.startMatch();
    }

    quit() {
        this.isRunning = false;
        this.isPaused = false;
        this.matchOver = true;
        this.isLockstep = false;
        this.netplay = null;
        this.onMatchEnd = null;
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        this._clearAllTimers();
        this._powerUpNotifTimer = null;
        this._endMatchTimer = 0;

        // Reset per-match input state so a stale "kick held" / "movement" doesn't
        // leak into the next match.
        const inp = this.input;
        inp.x = 0; inp.y = 0;
        inp.kickCharging = false; inp.kickRelease = false;
        inp.kickChargeTime = 0;
        inp.switchPlayer = false; inp.pull = false;

        this.resetMapPhysics();
        Physics.GAME_SPEED = this._baseGameSpeed;
        Sound.stopMusic();
        this._resumeBackgroundWork();
        if (this._dom.kickBtn) {
            this._dom.kickBtn.classList.remove('charging');
            this._dom.kickBtn.style.setProperty('--charge', '0');
        }
        if (this._dom.pauseOverlay) this._dom.pauseOverlay.classList.add('hidden');
        if (this._dom.resultOverlay) this._dom.resultOverlay.classList.add('hidden');
        if (this._dom.goalNotif) this._dom.goalNotif.classList.add('hidden');
        if (this._dom.powerUpNotif) this._dom.powerUpNotif.classList.add('hidden');
        if (this._dom.timer) this._dom.timer.style.color = '';
    }
}
