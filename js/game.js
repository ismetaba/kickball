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

        this.input = { x: 0, y: 0, kick: false, kickCharging: false, kickChargeStart: 0, kickChargeTime: 0, kickRelease: false, switchPlayer: false, pull: false };
        this.input2 = { x: 0, y: 0, kick: false, kickCharging: false, kickChargeStart: 0, kickChargeTime: 0, kickRelease: false, switchPlayer: false, pull: false };
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

        // Local 1v1
        this.isLocal1v1 = false;
        this.humanPlayer2 = null;

        // AI vs AI spectator
        this.isSpectator = false;
        this._aiVsAiTypes = null;
        this._baseGameSpeed = Physics.GAME_SPEED;

        // Lockstep deterministic multiplayer
        this.rng = new SeededRNG(12345);
        this.tickCount = 0;
        this._accumulator = 0;
        this.isLockstep = false;
        this._lockstepInputBuffer = null;
        this._myPlayerIdx = 0;

        // Online multiplayer state
        this.isOnline = false;
        this.isHost = false;
        this.network = null;
        this.remoteInput = { x: 0, y: 0, kickCharging: false, kickChargeTime: 0, kickRelease: false, switchPlayer: false };
        this.remoteHumanPlayer = null;

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
            redBar: document.getElementById('momentum-fill-red'),
            blueBar: document.getElementById('momentum-fill-blue'),
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
        };

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
    _makeAI() {
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

    repositionEntities() {
        // Recalculate spawn positions after resize
        const positions = this.getSpawnPositions();
        this.ball.spawnX = this.field.centerX;
        this.ball.spawnY = this.field.centerY;

        let redIdx = 0, blueIdx = 0;
        for (const p of this.players) {
            if (p.team === 'red') {
                if (redIdx < positions.red.length) {
                    p.spawnX = positions.red[redIdx].x;
                    p.spawnY = positions.red[redIdx].y;
                }
                redIdx++;
            } else {
                if (blueIdx < positions.blue.length) {
                    p.spawnX = positions.blue[blueIdx].x;
                    p.spawnY = positions.blue[blueIdx].y;
                }
                blueIdx++;
            }
        }
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
        }
    }

    startMatch() {
        this.renderer.resize();
        this._setVirtualSize(this.settings.map);
        this._updateFieldViewScale();
        this.field = new Field(this.VIRTUAL_W, this.VIRTUAL_H, this.settings.map);
        this.ball = new Ball(this.field.centerX, this.field.centerY);

        this.players = [];
        this.aiControllers = [];

        const positions = this.getSpawnPositions();

        // Create red team (player is on red)
        for (let i = 0; i < this.settings.teamSize; i++) {
            const isHuman = i === 0;
            const p = new Player(positions.red[i].x, positions.red[i].y, 'red', isHuman);
            this.players.push(p);
            if (isHuman) {
                this.humanPlayer = p;
            } else {
                const redAi = this._makeAI();
                this.aiControllers.push({ player: p, ai: redAi });
            }
        }

        // Create blue team (all AI)
        for (let i = 0; i < this.settings.teamSize; i++) {
            const p = new Player(positions.blue[i].x, positions.blue[i].y, 'blue', false);
            this.players.push(p);
            const ai = this._makeAI();
            this.aiControllers.push({ player: p, ai });
        }

        this.rebuildTeamCache();
        this.powerUpManager = new PowerUpManager(this.field);
        this.powerUpManager.enabled = this.settings.powerups;

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
        this.combo = { team: null, count: 0 };
        this.suddenDeath = false;
        this.suddenDeathTimer = 0;
        this.suddenDeathShrink = 0;
        Physics.MAX_BALL_SPEED = this._originalMaxBallSpeed;

        this.tickCount = 0;
        this._accumulator = 0;
        this._endMatchScheduled = false;
        this._goalNotifTimer = null;
        this._powerUpNotifTimer = null;

        this.applyMapPhysics();
        this.lastTime = performance.now();
        Sound.whistle(false);
        Sound.startMusic();
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        this.loop();

        // iOS WKWebView fix: dimensions may not be available at startup.
        // Re-resize after the view has settled to ensure correct canvas size.
        this._setTimeout(() => { this.renderer.resize(); this._updateFieldViewScale(); }, 100);
        this._setTimeout(() => { this.renderer.resize(); this._updateFieldViewScale(); }, 300);
    }

    startPractice() {
        this.renderer.resize();
        this._setVirtualSize(this.settings.map);
        this._updateFieldViewScale();
        this.field = new Field(this.VIRTUAL_W, this.VIRTUAL_H, this.settings.map);
        this.ball = new Ball(this.field.centerX, this.field.centerY);

        this.players = [];
        this.aiControllers = [];

        // Just the human player, no AI
        const p = new Player(this.field.centerX - 60, this.field.centerY, 'red', true);
        this.players.push(p);
        this.humanPlayer = p;

        this.rebuildTeamCache();
        this.powerUpManager = new PowerUpManager(this.field);
        this.powerUpManager.enabled = false;

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
        this.practiceMode = true;
        this.stats = { possession: { red: 0, blue: 0 }, shots: { red: 0, blue: 0 } };
        this.combo = { team: null, count: 0 };
        this.suddenDeath = false;
        this.suddenDeathTimer = 0;
        this.suddenDeathShrink = 0;
        this._endMatchScheduled = false;
        this._goalNotifTimer = null;
        this._powerUpNotifTimer = null;
        Physics.MAX_BALL_SPEED = this._originalMaxBallSpeed;

        this.applyMapPhysics();
        this.lastTime = performance.now();
        Sound.whistle(false);
        Sound.startMusic();
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        this.loop();

        // iOS WKWebView fix: dimensions may not be available at startup.
        this._setTimeout(() => { this.renderer.resize(); this._updateFieldViewScale(); }, 100);
        this._setTimeout(() => { this.renderer.resize(); this._updateFieldViewScale(); }, 300);
    }

    loop() {
        if (!this.isRunning) { this._rafId = null; return; }

        try {
            const now = performance.now();
            const elapsed = Math.min(now - this.lastTime, 100);
            this.lastTime = now;

            if (!this.isPaused) {
                if (this.isLockstep) {
                    // Lockstep P2P: schedule 1 input, consume 1 tick per frame.
                    // _applyPeerInputs schedules input for (tickCount + INPUT_DELAY).
                    // We must consume exactly 1 tick so tickCount advances by 1,
                    // keeping the pipeline aligned: each frame fills the next gap.
                    // At 60fps this gives 60Hz physics (matching TICK_MS = 16.67).
                    if (this._applyPeerInputs) this._applyPeerInputs();
                    if (this._lockstepCanAdvance()) {
                        this._lockstepTick();
                    }
                } else if (this.isOnline) {
                    this._onlineUpdate(elapsed);
                } else {
                    // Fixed timestep accumulator for offline play
                    this._accumulator = (this._accumulator || 0) + elapsed;
                    const TICK_MS = 16.67;
                    while (this._accumulator >= TICK_MS) {
                        this._accumulator -= TICK_MS;
                        Physics.dtRatio = Physics.GAME_SPEED;
                        this.update(TICK_MS);
                        this.tickCount++;
                    }
                }
            }

            // Goal timer (uses real time for display purposes)
            if (!this.isOnline && this.isGoalScored) {
                this.goalTimer -= elapsed;
                if (this.goalTimer <= 0) {
                    this.isGoalScored = false;
                    if (this._dom.goalNotif) this._dom.goalNotif.classList.add('hidden');
                    this.resetAfterGoal();
                }
            }

            this.renderer.updateConfetti(elapsed);
            this.renderer.updateNetRipple(elapsed);
            this.renderer.updateHitFlashes();

            if (this.isOnline && this.ball) {
                const speed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
                const maxPairs = this.ball.superKick > 0 ? 20 : 10;
                if (speed > 3) {
                    this.ball._addTrailPoint(this.ball.x, this.ball.y, maxPairs);
                } else if (this.ball.trailCount > 0) {
                    this.ball.trailCount--;
                }
            }

            // Self-healing: if canvas has bad dimensions, re-resize
            // (iOS WKWebView can report 0 dimensions during transitions)
            if (this.renderer.w < 100 || this.renderer.h < 100) {
                this.renderer.resize();
                this._updateFieldViewScale();
            }

            this.render();
        } catch (err) {
            console.error('Game loop error:', err);
        }

        this._rafId = requestAnimationFrame(() => this.loop());
    }

    _lockstepCanAdvance() {
        if (!this._lockstepInputBuffer) return false;
        if (this._lockstepInputBuffer.has(this.tickCount)) return true;

        // Input timeout: if we've been waiting >100ms for inputs, use last known input
        // This prevents the game from stalling on brief packet loss
        if (!this._lockstepWaitStart) {
            this._lockstepWaitStart = performance.now();
            return false;
        }
        const waited = performance.now() - this._lockstepWaitStart;
        if (waited > 100) {
            // Timeout: fill missing tick with last known inputs
            const lastTick = this.tickCount - 1;
            const lastInputs = this._lockstepLastInputs || new Map();
            const fallbackMap = new Map();
            const emptyInput = { x: 0, y: 0, kick: false, chargeRatio: 0, pull: false, switchPlayer: false };
            for (let i = 0; i < this.players.length; i++) {
                const last = lastInputs.get(i);
                // Copy last directional input but clear one-shot actions
                fallbackMap.set(i, last
                    ? { x: last.x, y: last.y, kick: false, chargeRatio: 0, pull: last.pull, switchPlayer: false }
                    : { ...emptyInput });
            }
            this._lockstepInputBuffer.set(this.tickCount, fallbackMap);
            this._lockstepWaitStart = null;
            console.warn(`Lockstep timeout at tick ${this.tickCount}, using last known input`);
            return true;
        }
        return false;
    }

    _lockstepTick() {
        const inputs = this._lockstepInputBuffer.get(this.tickCount);
        this._lockstepInputBuffer.delete(this.tickCount);

        // Reset wait timer and save inputs for timeout fallback
        this._lockstepWaitStart = null;
        if (inputs) this._lockstepLastInputs = inputs;

        Physics.dtRatio = Physics.GAME_SPEED;
        const TICK_MS = 16.67;

        // Apply all player inputs for this tick.
        // The "current controlled player" for a slot can change over time via SWAP,
        // so we route inputs through _slotControlled instead of always using players[playerIdx].
        if (inputs) {
            for (const [playerIdx, inp] of inputs) {
                const player = this._slotControlled?.get(playerIdx) || this.players[playerIdx];
                if (!player) continue;

                if (player.powerUp !== 'frozen' && player.stunTimer <= 0) {
                    player.applyInput(inp.x, inp.y);
                }

                if (inp.kick && inp.chargeRatio > 0) {
                    this.hitNearbyPlayers(player, inp.chargeRatio);
                    if (player.kick(this.ball, inp.chargeRatio)) {
                        this.stats.shots[player.team]++;
                        const shakeIntensity = 0.15 + inp.chargeRatio * 0.85;
                        this.renderer.triggerShake(shakeIntensity);
                        this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + inp.chargeRatio * 0.7);
                        Sound.kick(inp.chargeRatio);
                        const towardGoal = (player.team === 'red' && this.ball.vx > 0) || (player.team === 'blue' && this.ball.vx < 0);
                        if (towardGoal) this.addMomentum(player.team);
                    }
                }
                if (inp.pull) {
                    if (!player.pullActive && player.pullCooldown <= 0 && Physics.distance(player, this.ball) < 150) {
                        player.activatePull();
                        if (playerIdx === this._myPlayerIdx) Sound.pullActivate();
                    }
                } else if (player.pullActive) {
                    player.pullActive = false;
                    player.pullDuration = 0;
                    player.pullCooldown = player.pullCooldownTime;
                }
                // Player swap must run on EVERY peer for every slot's swap input,
                // not just the peer that pressed it — otherwise the simulations diverge.
                if (inp.switchPlayer && this._slotControlled) {
                    const newHuman = this._swapToNearestTeammate(player);
                    this._slotControlled.set(playerIdx, newHuman);
                    if (playerIdx === this._myPlayerIdx) {
                        this.humanPlayer = newHuman;
                        Sound.switchPlayer();
                    }
                }
            }
        }

        // Run physics update with lockstep flag active
        this.update(TICK_MS);
        this.tickCount++;

        // Checksum every 60 ticks with full state for auto-resync
        if (this.tickCount % 60 === 0 && this.p2p) {
            const hash = this._computeChecksum();
            if (this.isP2PHost) {
                // Include full state so guests can auto-resync on mismatch
                const fullState = this._serializeFullState();
                this.p2p.broadcastChecksum(this.tickCount, hash, fullState);
            }
        }
    }

    _computeChecksum() {
        // Covers everything that can desync — position, velocity, timers,
        // and whether a player is currently "human" for rendering purposes.
        let h = 0;
        for (const p of this.players) {
            h = (h * 31 + ((p.x * 10) | 0)) | 0;
            h = (h * 31 + ((p.y * 10) | 0)) | 0;
            h = (h * 31 + ((p.vx * 100) | 0)) | 0;
            h = (h * 31 + ((p.vy * 100) | 0)) | 0;
            h = (h * 31 + ((p.stunTimer | 0))) | 0;
            h = (h * 31 + ((p.pullCooldown | 0))) | 0;
            h = (h * 31 + (p.isHuman ? 1 : 0)) | 0;
        }
        h = (h * 31 + ((this.ball.x * 10) | 0)) | 0;
        h = (h * 31 + ((this.ball.y * 10) | 0)) | 0;
        h = (h * 31 + ((this.ball.vx * 100) | 0)) | 0;
        h = (h * 31 + ((this.ball.vy * 100) | 0)) | 0;
        h = (h * 31 + this.redScore) | 0;
        h = (h * 31 + this.blueScore) | 0;
        return h;
    }

    // Serialize full game state for desync recovery
    _serializeFullState() {
        // Include which player each slot currently controls so swap state
        // is also restored on a resync. Slots that don't exist in the map
        // use their default index.
        const slotCtrl = [];
        if (this._slotControlled) {
            for (const [slotIdx, player] of this._slotControlled) {
                slotCtrl.push([slotIdx, this.players.indexOf(player)]);
            }
        }
        const players = this.players.map(p => ({
            x: Math.round(p.x * 100) / 100,
            y: Math.round(p.y * 100) / 100,
            vx: Math.round(p.vx * 100) / 100,
            vy: Math.round(p.vy * 100) / 100,
            st: p.stunTimer || 0,
            pc: p.pullCooldown || 0,
            ih: p.isHuman ? 1 : 0,
        }));
        return {
            p: players,
            bx: Math.round(this.ball.x * 100) / 100,
            by: Math.round(this.ball.y * 100) / 100,
            bvx: Math.round(this.ball.vx * 100) / 100,
            bvy: Math.round(this.ball.vy * 100) / 100,
            rs: this.redScore,
            bs: this.blueScore,
            tr: this.timeRemaining,
            sc: slotCtrl,
        };
    }

    // Apply full state from host to fix desync
    _applyFullState(state) {
        if (!state || !state.p) return;
        for (let i = 0; i < this.players.length && i < state.p.length; i++) {
            const p = this.players[i];
            const sp = state.p[i];
            p.x = sp.x;
            p.y = sp.y;
            p.vx = sp.vx;
            p.vy = sp.vy;
            if (sp.st !== undefined) p.stunTimer = sp.st;
            if (sp.pc !== undefined) p.pullCooldown = sp.pc;
            if (sp.ih !== undefined) p.isHuman = sp.ih === 1;
        }
        this.ball.x = state.bx;
        this.ball.y = state.by;
        this.ball.vx = state.bvx;
        this.ball.vy = state.bvy;
        this.redScore = state.rs;
        this.blueScore = state.bs;
        if (state.tr !== undefined) this.timeRemaining = state.tr;

        // Restore the slot→controlled-player map
        if (state.sc && this._slotControlled) {
            this._slotControlled.clear();
            for (const [slotIdx, playerIdx] of state.sc) {
                if (playerIdx >= 0 && playerIdx < this.players.length) {
                    this._slotControlled.set(slotIdx, this.players[playerIdx]);
                }
            }
            // Rebuild aiControllers so AI runs only on non-human players
            const controlledSet = new Set(this._slotControlled.values());
            this.aiControllers = this.aiControllers.filter(ac => ac && !controlledSet.has(ac.player));
            for (const p of this.players) {
                if (!p.isHuman && !this.aiControllers.some(ac => ac.player === p)) {
                    this.aiControllers.push({ player: p, ai: new AIController(this.settings.difficulty || 'normal') });
                }
            }
            // Update local humanPlayer pointer
            if (this._myPlayerIdx !== undefined) {
                const mine = this._slotControlled.get(this._myPlayerIdx);
                if (mine) this.humanPlayer = mine;
            }
        }
    }

    _onlineUpdate(dt) {
        if (!this.network) return;

        // 1. Send input to server
        const sent = this.network.sendInput(this.input);
        if (sent) {
            this.input.kickRelease = false;
            this.input.switchPlayer = false;
        }

        // 2. Interpolate all remote entities from server state buffer
        //    This sets positions for remote players and ball via smooth interpolation.
        //    For the local player, it stores the server target in network.serverPlayerPos.
        this.network.interpolate(this);

        // 3. Client-side prediction for local player
        //    Apply input immediately so movement feels instant.
        //    Then gently correct toward server position.
        Physics.dtRatio = (dt / 16.67) * Physics.GAME_SPEED;
        const hp = this.humanPlayer;
        if (hp && hp.stunTimer <= 0 && hp.powerUp !== 'frozen') {
            // Apply joystick input
            hp.applyInput(this.input.x, this.input.y);

            // Kick charge visual — use kickChargeStart (set on touchstart),
            // not kickChargeTime (only set on release)
            if (this.input.kickCharging) {
                hp.kickChargeRatio = Math.min((performance.now() - this.input.kickChargeStart) / 1500, 1);
                // Slow down while charging
                const slowFactor = 1 - hp.kickChargeRatio * 0.015;
                hp.vx *= Math.pow(slowFactor, Physics.dtRatio);
                hp.vy *= Math.pow(slowFactor, Physics.dtRatio);
            } else {
                hp.kickChargeRatio = 0;
            }

            // Physics step
            const s = Physics.dtRatio;
            hp.vx *= Math.pow(Physics.FRICTION, s);
            hp.vy *= Math.pow(Physics.FRICTION, s);
            Physics.clampSpeed(hp, hp.getMaxSpeed());
            hp.x += hp.vx * s;
            hp.y += hp.vy * s;

            // Constrain to field
            if (this.field) {
                Physics.constrainToField(hp, this.field, true);
            }

            // Server reconciliation: smoothly correct toward server position
            // Skip reconciliation for the first second so the server catches up with our input
            if (!this._onlineStartTime) this._onlineStartTime = performance.now();
            const timeSinceStart = performance.now() - this._onlineStartTime;

            const srv = this.network.serverPlayerPos;
            if (srv && timeSinceStart > 1000) {
                const errX = srv.x - hp.x;
                const errY = srv.y - hp.y;
                const errDist = Math.sqrt(errX * errX + errY * errY);

                if (errDist > 60) {
                    hp.x = srv.x;
                    hp.y = srv.y;
                    hp.vx = srv.vx;
                    hp.vy = srv.vy;
                } else if (errDist > 1) {
                    // Only correct position, NOT velocity — velocity correction
                    // fights the prediction and makes movement feel sluggish
                    hp.x += errX * 0.1;
                    hp.y += errY * 0.1;
                }
            }
        }

        // 4. Local collision resolution — prevent visual overlap
        if (hp) {
            // Player vs other players
            for (const p of this.players) {
                if (p === hp) continue;
                const dx = p.x - hp.x;
                const dy = p.y - hp.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const minDist = hp.radius + p.radius;
                if (dist > 0 && dist < minDist) {
                    const nx = dx / dist;
                    const ny = dy / dist;
                    const overlap = minDist - dist;
                    // Push local player out (don't move remote — server owns them)
                    hp.x -= nx * overlap;
                    hp.y -= ny * overlap;
                }
            }
            // Player vs ball
            if (this.ball) {
                const dx = this.ball.x - hp.x;
                const dy = this.ball.y - hp.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const minDist = hp.radius + this.ball.radius;
                if (dist > 0 && dist < minDist) {
                    const nx = dx / dist;
                    const ny = dy / dist;
                    const overlap = minDist - dist;
                    hp.x -= nx * overlap * 0.5;
                    hp.y -= ny * overlap * 0.5;
                }
            }
        }

        // 5. Animate power-ups locally (visual only)
        if (this.powerUpManager) {
            const pups = this.powerUpManager.powerUps;
            for (let i = 0; i < pups.length; i++) {
                const pu = pups[i];
                pu.bobTimer = (pu.bobTimer || 0) + dt * 0.003;
                pu.scale = 1 + Math.sin(pu.bobTimer) * 0.15;
                pu.rotateTimer = (pu.rotateTimer || 0) + dt * 0.002;
                pu.pulseTimer = (pu.pulseTimer || 0) + dt * 0.004;
            }
        }
    }

    update(dt) {
        // Online mode is handled by _onlineUpdate() called from loop().
        // This update() is called for offline/local/lockstep (inside _lockstepTick) matches.

        // Recover from slow-motion
        if (this.slowMoTimer > 0) {
            this.slowMoTimer -= dt;
            if (this.slowMoTimer <= 0) {
                this.timeScale = 1.0;
                this.slowMoTimer = 0;
            }
        }

        // Apply time scale for slow-motion effects
        const rawDt = dt;
        dt *= this.timeScale;
        // In lockstep/fixed timestep mode, dtRatio is already set by the caller
        if (!this.isLockstep) {
            Physics.dtRatio = (dt / 16.67) * Physics.GAME_SPEED;
        }

        // Timer (skip in practice mode) - use raw dt so timer isn't affected by slow-mo
        if (!this.practiceMode) {
            if (this.suddenDeath) {
                // Sudden death timer
                this.suddenDeathTimer += rawDt;
                this.suddenDeathShrink = Math.min(this.suddenDeathTimer / this.suddenDeathMaxTime, 1);

                // Gradually increase ball speed
                Physics.MAX_BALL_SPEED = this._originalMaxBallSpeed + this.suddenDeathShrink * 10;

                // Update timer display
                const secs = Math.ceil(this.suddenDeathTimer / 1000);
                const m = Math.floor(secs / 60);
                const s = secs % 60;
                this._dom.timer.textContent = `${m}:${s.toString().padStart(2, '0')}`;
                this._dom.timer.style.color = '#ff4444';

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
                    if (this.redScore === this.blueScore && !this.practiceMode) {
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
                    const secs = Math.ceil(this.timeRemaining / 1000);
                    const m = Math.floor(secs / 60);
                    const s = secs % 60;
                    this._dom.timer.textContent = `${m}:${s.toString().padStart(2, '0')}`;

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

        // Momentum HUD hidden (mechanic still active under the hood)

        // Human input (skipped in lockstep — inputs applied by _lockstepTick)
        if (!this.isLockstep && this.humanPlayer && this.humanPlayer.powerUp !== 'frozen' && this.humanPlayer.stunTimer <= 0) {
            this.humanPlayer.applyInput(this.input.x, this.input.y);

            // Track charge time for visual feedback + slow player while charging
            if (this.input.kickCharging) {
                this.humanPlayer.kickChargeRatio = Math.min((performance.now() - this.input.kickChargeStart) / 1500, 1);
                // Slow player down while holding kick (more charge = slower)
                const slowFactor = 1 - this.humanPlayer.kickChargeRatio * 0.015;
                this.humanPlayer.vx *= Math.pow(slowFactor, Physics.dtRatio);
                this.humanPlayer.vy *= Math.pow(slowFactor, Physics.dtRatio);
            } else {
                this.humanPlayer.kickChargeRatio = 0;
            }

            // Charged kick: released after charging
            if (this.input.kickRelease) {
                const chargeRatio = Math.min(this.input.kickChargeTime / 1500, 1);
                this.hitNearbyPlayers(this.humanPlayer, chargeRatio);
                if (this.humanPlayer.kick(this.ball, chargeRatio)) {
                    this.stats.shots.red++;
                    const shakeIntensity = 0.15 + chargeRatio * 0.85;
                    this.renderer.triggerShake(shakeIntensity);
                    this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + chargeRatio * 0.7);
                    Sound.kick(chargeRatio);
                    if (this.ball.vx > 0) this.addMomentum('red');
                }
                this.input.kickRelease = false;
                this.input.kickChargeTime = 0;
            }

            if (this.input.switchPlayer) {
                this.switchToNearestTeammate();
                Sound.switchPlayer();
                this.input.switchPlayer = false;
            }
        }

        // Remote player input (online: host applies guest's input to blue human)
        if (this.isOnline && this.isHost && this.remoteHumanPlayer &&
            this.remoteHumanPlayer.powerUp !== 'frozen' && this.remoteHumanPlayer.stunTimer <= 0) {

            this.remoteHumanPlayer.applyInput(this.remoteInput.x, this.remoteInput.y);

            if (this.remoteInput.kickCharging) {
                this.remoteHumanPlayer.kickChargeRatio = Math.min(this.remoteInput.kickChargeTime / 1500, 1);
                const slowFactor = 1 - this.remoteHumanPlayer.kickChargeRatio * 0.015;
                this.remoteHumanPlayer.vx *= Math.pow(slowFactor, Physics.dtRatio);
                this.remoteHumanPlayer.vy *= Math.pow(slowFactor, Physics.dtRatio);
            } else {
                this.remoteHumanPlayer.kickChargeRatio = 0;
            }

            if (this.remoteInput.kickRelease) {
                const chargeRatio = Math.min(this.remoteInput.kickChargeTime / 1500, 1);
                this.hitNearbyPlayers(this.remoteHumanPlayer, chargeRatio);
                if (this.remoteHumanPlayer.kick(this.ball, chargeRatio)) {
                    this.stats.shots.blue++;
                    this.renderer.triggerShake(0.15 + chargeRatio * 0.85);
                    this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + chargeRatio * 0.7);
                    Sound.kick(chargeRatio);
                    if (this.ball.vx < 0) this.addMomentum('blue');
                }
                this.remoteInput.kickRelease = false;
                this.remoteInput.kickChargeTime = 0;
            }

            if (this.remoteInput.switchPlayer) {
                this.switchToNearestTeammate_remote();
                this.remoteInput.switchPlayer = false;
            }
        }

        // Local 1v1: Player 2 input (blue team)
        if (this.isLocal1v1 && this.humanPlayer2 &&
            this.humanPlayer2.powerUp !== 'frozen' && this.humanPlayer2.stunTimer <= 0) {

            this.humanPlayer2.applyInput(this.input2.x, this.input2.y);

            if (this.input2.kickCharging) {
                this.humanPlayer2.kickChargeRatio = Math.min((performance.now() - this.input2.kickChargeStart) / 1500, 1);
                const slowFactor = 1 - this.humanPlayer2.kickChargeRatio * 0.015;
                this.humanPlayer2.vx *= Math.pow(slowFactor, Physics.dtRatio);
                this.humanPlayer2.vy *= Math.pow(slowFactor, Physics.dtRatio);
            } else {
                this.humanPlayer2.kickChargeRatio = 0;
            }

            if (this.input2.kickRelease) {
                const chargeRatio = Math.min(this.input2.kickChargeTime / 1500, 1);
                this.hitNearbyPlayers(this.humanPlayer2, chargeRatio);
                if (this.humanPlayer2.kick(this.ball, chargeRatio)) {
                    this.stats.shots.blue++;
                    this.renderer.triggerShake(0.15 + chargeRatio * 0.85);
                    this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + chargeRatio * 0.7);
                    Sound.kick(chargeRatio);
                    if (this.ball.vx < 0) this.addMomentum('blue');
                }
                this.input2.kickRelease = false;
                this.input2.kickChargeTime = 0;
            }

            if (this.input2.switchPlayer) {
                this.switchToNearestTeammate_p2();
                this.input2.switchPlayer = false;
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
                if (player.kick(this.ball, cr)) {
                    this.stats.shots[player.team]++;
                    const shakeIntensity = 0.15 + cr * 0.55;
                    this.renderer.triggerShake(shakeIntensity);
                    this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + cr * 0.5);
                    Sound.kick(cr);
                    const towardGoal = (player.team === 'red' && this.ball.vx > 0) || (player.team === 'blue' && this.ball.vx < 0);
                    if (towardGoal) this.addMomentum(player.team);
                }
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
                let dx = p.vx;
                let dy = p.vy;
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
        const pullMaxRange = 150; // Only works within 150px
        for (const p of this.players) {
            if (p.pullActive) {
                const dist = Physics.distance(p, this.ball);
                if (dist >= pullMaxRange) {
                    // Out of range — cancel pull and start cooldown
                    p.pullActive = false;
                    p.pullCooldown = p.pullCooldownTime;
                } else if (dist > p.radius + this.ball.radius + 5) {
                    const dx = p.x - this.ball.x;
                    const dy = p.y - this.ball.y;
                    const n = Physics.normalize(dx, dy);
                    // Pull force falls off with distance (stronger when closer)
                    const falloff = 1 - (dist / pullMaxRange);
                    const pullStrength = 0.25 * falloff * Physics.dtRatio;
                    this.ball.vx += n.x * pullStrength;
                    this.ball.vy += n.y * pullStrength;
                    // Slow the ball while pulling (creates a "catching" feel)
                    this.ball.vx *= Math.pow(0.985, Physics.dtRatio);
                    this.ball.vy *= Math.pow(0.985, Physics.dtRatio);
                }
            }
        }

        // Handle pull input for human player (must be in range) — skipped in lockstep
        if (!this.isLockstep && this.humanPlayer && this.input.pull && !this.humanPlayer.pullActive && this.humanPlayer.pullCooldown <= 0
            && Physics.distance(this.humanPlayer, this.ball) < pullMaxRange) {
            this.humanPlayer.activatePull();
            Sound.pullActivate();
        }
        if (!this.isLockstep && this.humanPlayer && !this.input.pull && this.humanPlayer.pullActive) {
            // Released pull early — end it and start cooldown
            this.humanPlayer.pullActive = false;
            this.humanPlayer.pullDuration = 0;
            this.humanPlayer.pullCooldown = this.humanPlayer.pullCooldownTime;
        }

        // P2 pull (local 1v1, must be in range)
        if (this.isLocal1v1 && this.humanPlayer2 && this.input2.pull && !this.humanPlayer2.pullActive && this.humanPlayer2.pullCooldown <= 0
            && Physics.distance(this.humanPlayer2, this.ball) < pullMaxRange) {
            this.humanPlayer2.activatePull();
        }
        if (this.isLocal1v1 && this.humanPlayer2 && !this.input2.pull && this.humanPlayer2.pullActive) {
            this.humanPlayer2.pullActive = false;
            this.humanPlayer2.pullDuration = 0;
            this.humanPlayer2.pullCooldown = this.humanPlayer2.pullCooldownTime;
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

            // Auto kick on contact: if player is charging (any amount) and touches ball, kick with current charge
            if (collided && p === this.humanPlayer && this.input.kickCharging) {
                const cr = p.kickChargeRatio || 0.1;
                p.kick(this.ball, cr);
                this.stats.shots.red++;
                const shakeIntensity = 0.15 + cr * 0.85;
                this.renderer.triggerShake(shakeIntensity);
                this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + cr * 0.7);
                Sound.kick(cr);
                this.input.kickCharging = false;
                this.input.kickRelease = false;
                this.input.kickChargeTime = 0;
                p.kickChargeRatio = 0;
            }

            // Auto kick on contact for P2 (local 1v1)
            if (collided && this.isLocal1v1 && p === this.humanPlayer2 && this.input2.kickCharging) {
                const cr = p.kickChargeRatio || 0.1;
                p.kick(this.ball, cr);
                this.stats.shots.blue++;
                const shakeIntensity = 0.15 + cr * 0.85;
                this.renderer.triggerShake(shakeIntensity);
                this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + cr * 0.7);
                Sound.kick(cr);
                this.input2.kickCharging = false;
                this.input2.kickRelease = false;
                this.input2.kickChargeTime = 0;
                p.kickChargeRatio = 0;
            }

            // Auto kick on contact for remote player (online host)
            if (collided && this.isOnline && this.isHost && p === this.remoteHumanPlayer && this.remoteInput.kickCharging) {
                const cr = p.kickChargeRatio || 0.1;
                p.kick(this.ball, cr);
                this.stats.shots.blue++;
                const shakeIntensity = 0.15 + cr * 0.85;
                this.renderer.triggerShake(shakeIntensity);
                this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + cr * 0.7);
                Sound.kick(cr);
                this.remoteInput.kickCharging = false;
                this.remoteInput.kickRelease = false;
                this.remoteInput.kickChargeTime = 0;
                p.kickChargeRatio = 0;
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

        // Player-player collisions
        for (let i = 0; i < this.players.length; i++) {
            for (let j = i + 1; j < this.players.length; j++) {
                const hit = Physics.resolveCircleCollision(
                    this.players[i], this.players[j],
                    Physics.PLAYER_BOUNCE, Physics.PLAYER_BOUNCE
                );
                // No sound on player-player collision (by design)
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

        // Online: host sends state to guest
        if (this.isOnline && this.isHost && this.network) {
            this.network.sendState(this);
        }
    }

    scoreGoal(team) {
        // Fire ball scoring: 2x for level 1, 3x for level 2
        const fireLevel = this.ball.fireLevel || 0;
        const goalPoints = fireLevel >= 2 ? 3 : fireLevel >= 1 ? 2 : 1;

        if (team === 'red') {
            this.redScore += goalPoints;
            if (this._dom.redScore) this._dom.redScore.textContent = this.redScore;
        } else {
            this.blueScore += goalPoints;
            if (this._dom.blueScore) this._dom.blueScore.textContent = this.blueScore;
        }

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
                scorer ? `${scorer.team.toUpperCase()} Team${goalPoints > 1 ? ' (+' + goalPoints + ')' : ''}` : '';
        }
        if (notif) notif.classList.remove('hidden');

        this.isGoalScored = true;
        this.goalTimer = 2500;

        // Set kickoff team: the team that was scored ON gets the kickoff
        this.kickoffTeam = team === 'red' ? 'blue' : 'red';

        // Goal sound + heavy screen shake (bigger for fire goals)
        if (fireLevel >= 1) {
            Sound.fireGoal(fireLevel);
            this.renderer.triggerShake(1.0);
        } else {
            Sound.goal();
            this.renderer.triggerShake(1.0);
        }

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

        // Notify guest about goal
        if (this.isOnline && this.isHost && this.network) {
            this.network.send({ t: 'goal', d: { team: team } });
        }
        // P2P host: broadcast goal to peers with full context so their overlay matches
        if (this.isP2PHost && this.p2p) {
            this.p2p.broadcastGoal({
                team,
                redScore: this.redScore,
                blueScore: this.blueScore,
                fireLevel,
                points: goalPoints,
                isOwnGoal,
            });
        }

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

    _scheduleEndMatch(ms) {
        // Guard against double scheduling (e.g. goal-limit hit on a sudden-death goal)
        if (this._endMatchScheduled) return;
        this._endMatchScheduled = true;
        this._setTimeout(() => this.endMatch(), ms);
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
        this.isRunning = false;
        this.matchOver = true;
        this.suddenDeath = false;
        this.suddenDeathTimer = 0;
        this.suddenDeathShrink = 0;
        Physics.MAX_BALL_SPEED = this._originalMaxBallSpeed;
        this.resetMapPhysics();
        if (this._dom && this._dom.timer) this._dom.timer.style.color = '';
        Sound.stopMusic();
        Sound.whistle(true);

        // Notify guest about match end
        if (this.isOnline && this.isHost && this.network) {
            this.network.send({ t: 'end', d: { red: this.redScore, blue: this.blueScore } });
        }
        // P2P host: broadcast match end to peers
        if (this.isP2PHost && this.p2p) {
            this.p2p.broadcastMatchEnd({ red: this.redScore, blue: this.blueScore });
        }

        const resultOverlay = this._dom.resultOverlay;
        const title = this._dom.resultTitle;
        const score = this._dom.resultScore;
        const stats = this._dom.matchStats;

        // Determine local team
        const localTeam = (this.isOnline && !this.isHost) ? 'blue' : 'red';
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

    // Swap control from `current` to the teammate closest to the ball.
    // Returns the new human player (or `current` if no swap happened).
    // Idempotent: never creates duplicate AI controllers for the same player.
    _swapToNearestTeammate(current) {
        if (!current) return current;
        let nearest = null;
        let nearestDist = Infinity;
        for (const p of this.players) {
            if (p.team !== current.team || p === current) continue;
            const d = Physics.distance(p, this.ball);
            if (d < nearestDist) { nearestDist = d; nearest = p; }
        }
        if (!nearest) return current;

        current.isHuman = false;
        if (!this.aiControllers.some(c => c.player === current)) {
            this.aiControllers.push({
                player: current,
                ai: new AIController(this.settings.difficulty || 'normal'),
            });
        }
        nearest.isHuman = true;
        this.aiControllers = this.aiControllers.filter(c => c.player !== nearest);
        return nearest;
    }

    switchToNearestTeammate() {
        this.humanPlayer = this._swapToNearestTeammate(this.humanPlayer);
    }

    switchToNearestTeammate_remote() {
        this.remoteHumanPlayer = this._swapToNearestTeammate(this.remoteHumanPlayer);
    }

    switchToNearestTeammate_p2() {
        this.humanPlayer2 = this._swapToNearestTeammate(this.humanPlayer2);
    }

    render() {
        this.renderer.clear();

        // Apply field view scale for training-size matches (trained AI watch mode)
        const ctx = this.renderer.ctx;
        const fvs = this.renderer.fieldViewScale;
        if (fvs) {
            ctx.save();
            if (this.cameraZoom !== 1) {
                // Camera follows player (or ball in spectator mode)
                const target = this.humanPlayer || this.ball;
                // Smooth camera follow
                const lerp = 0.1;
                this._cameraX += (target.x - this._cameraX) * lerp;
                this._cameraY += (target.y - this._cameraY) * lerp;
                const zoom = fvs * this.cameraZoom;
                const halfW = this.renderer.w / 2;
                const halfH = this.renderer.h / 2;
                ctx.translate(halfW, halfH);
                ctx.scale(zoom, zoom);
                ctx.translate(-this._cameraX, -this._cameraY);
            } else {
                ctx.translate(this.renderer.fieldViewOffsetX, this.renderer.fieldViewOffsetY);
                ctx.scale(fvs, fvs);
            }
        }

        this.renderer.trackedBall = this.ball;
        this.renderer._currentMapType = this.field.mapType;
        this.renderer.drawField(this.field);

        // Kickoff barrier visual
        if (this.kickoffActive && this.kickoffTeam) {
            const scoringTeam = this.kickoffTeam === 'red' ? 'blue' : 'red';
            this.renderer.drawKickoffBarrier(this.field, scoringTeam);
            this.renderer.drawKickoffBarrierLine(this.field, this.kickoffTeam);
        }

        // Power-ups
        this.powerUpManager.draw(this.renderer.ctx);

        // Players
        for (const p of this.players) {
            const isControlled = (p === this.humanPlayer) || (p === this.humanPlayer2);
            this.renderer.drawPlayer(p, isControlled);
        }

        // Pull ability visual links (only when in range)
        for (const p of this.players) {
            if (p.pullActive) {
                const dist = Physics.distance(p, this.ball);
                if (dist < 150) {
                    this.renderer.drawPullLink(p, this.ball, dist);
                }
            }
        }

        // Pull cooldown indicator for controlled players
        if (this.humanPlayer) {
            this.renderer.drawPullIndicator(this.humanPlayer);
        }
        if (this.humanPlayer2) {
            this.renderer.drawPullIndicator(this.humanPlayer2);
        }

        // Ball
        this.renderer.drawBall(this.ball);

        // Dash trails
        this.renderer.drawDashTrails();

        // Hit flash particles
        this.renderer.drawHitFlashes();

        // Sudden death overlay
        if (this.suddenDeath) {
            this.renderer.drawSuddenDeathOverlay(this.field, this.suddenDeathShrink);
        }

        // Confetti (on top of everything)
        this.renderer.drawConfetti();

        // Combo popup
        this.renderer.drawComboPopup();

        // Sudden death label
        if (this.suddenDeath) {
            this.renderer.drawSuddenDeathHUD();
        }

        // Kick charge meter (visual feedback while holding KICK)
        this._updateKickChargeMeter();

        // Update pull button visual state
        const pullBtn = this._dom.pullBtn;
        if (pullBtn && this.humanPlayer) {
            const hp = this.humanPlayer;
            if (hp.pullActive) {
                pullBtn.classList.remove('on-cooldown');
                pullBtn.style.opacity = '';
                pullBtn.textContent = 'PULL';
            } else if (hp.pullCooldown > 0) {
                pullBtn.classList.add('on-cooldown');
                const secs = Math.ceil(hp.pullCooldown / 1000);
                pullBtn.textContent = secs + 's';
            } else {
                pullBtn.classList.remove('on-cooldown');
                pullBtn.style.opacity = '';
                pullBtn.textContent = 'PULL';
            }
        }

        // Restore field view scale transform
        if (fvs) ctx.restore();

        // Goal flash overlay (must be in screen space, not world space)
        if (this.renderer.goalFlashTimer > 0) {
            const alpha = (this.renderer.goalFlashTimer / 500) * 0.3;
            ctx.fillStyle = this.renderer.goalFlashTeam === 'red'
                ? `rgba(233, 69, 96, ${alpha})`
                : `rgba(83, 216, 251, ${alpha})`;
            ctx.fillRect(0, 0, this.renderer.w, this.renderer.h);
        }

        // Draw off-screen indicators and minimap when zoomed in (in screen space)
        if (this.cameraZoom > 1.05) {
            this._drawOffScreenArrows(ctx);
            this._drawMinimap(ctx);
        }

        // End frame (restore screen shake transform)
        this.renderer.endFrame();
    }

    _updateKickChargeMeter() {
        if (!this._dom) return;
        if (!this._dom.kickBtn) this._dom.kickBtn = document.getElementById('btn-kick');
        const btn = this._dom.kickBtn;
        if (!btn) return;
        const hp = this.humanPlayer;
        const charging = !!(this.input.kickCharging && hp && hp.powerUp !== 'frozen' && hp.stunTimer <= 0);
        let ratio = 0;
        if (charging) {
            ratio = Math.min((performance.now() - (this.input.kickChargeStart || performance.now())) / 1500, 1);
        }
        if (charging) {
            btn.classList.add('charging');
            btn.style.setProperty('--charge', ratio.toFixed(3));
        } else if (this._lastChargeRatio !== 0) {
            btn.classList.remove('charging');
            btn.style.setProperty('--charge', '0');
        }
        this._lastChargeRatio = charging ? ratio : 0;
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

    pause() {
        if (this.isOnline || this.isP2PHost || this.isLockstep) return; // No pausing in online/P2P matches
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
        this.startMatch();
    }

    quit() {
        this.isRunning = false;
        this.isPaused = false;
        this.matchOver = true;
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
        this._clearAllTimers();
        this._goalNotifTimer = null;
        this._powerUpNotifTimer = null;
        this._endMatchScheduled = false;

        // Reset per-match input state so a stale "kick held" / "movement" doesn't
        // leak into the next match.
        this.input.x = 0; this.input.y = 0;
        this.input.kick = false;
        this.input.kickCharging = false; this.input.kickRelease = false;
        this.input.kickChargeTime = 0;
        this.input.switchPlayer = false; this.input.pull = false;
        this.input2.x = 0; this.input2.y = 0;
        this.input2.kickCharging = false; this.input2.kickRelease = false;
        this.input2.kickChargeTime = 0;
        this.input2.switchPlayer = false; this.input2.pull = false;

        this.resetMapPhysics();
        Sound.stopMusic();
        if (this._dom.pauseOverlay) this._dom.pauseOverlay.classList.add('hidden');
        if (this._dom.resultOverlay) this._dom.resultOverlay.classList.add('hidden');
        if (this._dom.goalNotif) this._dom.goalNotif.classList.add('hidden');
        if (this._dom.powerUpNotif) this._dom.powerUpNotif.classList.add('hidden');
        if (this._dom.timer) this._dom.timer.style.color = '';
    }
}
