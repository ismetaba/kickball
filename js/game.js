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

        // Cached DOM elements (avoid getElementById every frame)
        this._dom = {
            timer: document.getElementById('timer'),
            redBar: document.getElementById('momentum-fill-red'),
            blueBar: document.getElementById('momentum-fill-blue'),
        };

        // Cached team arrays (rebuilt when players change, not every frame)
        this._redTeam = [];
        this._blueTeam = [];

        // Virtual field resolution — depends on map type
        this.VIRTUAL_W = 800;
        this.VIRTUAL_H = 500;

        window.addEventListener('resize', () => this.onResize());
    }

    rebuildTeamCache() {
        this._redTeam = this.players.filter(p => p.team === 'red');
        this._blueTeam = this.players.filter(p => p.team === 'blue');
    }

    _setVirtualSize(mapType) {
        if (mapType === 'big') {
            this.VIRTUAL_W = 800;
            this.VIRTUAL_H = 500;
            this.cameraZoom = 1;
        } else if (mapType === 'huge') {
            this.VIRTUAL_W = 2400;
            this.VIRTUAL_H = 1600;
            this.cameraZoom = 1.8; // zoom in — show portion of field around player
        } else {
            // Classic
            this.VIRTUAL_W = 1500;
            this.VIRTUAL_H = 1000;
            this.cameraZoom = 1;
        }
        this._cameraX = this.VIRTUAL_W / 2;
        this._cameraY = this.VIRTUAL_H / 2;
    }

    _updateFieldViewScale() {
        const s = Math.min(this.renderer.w / this.VIRTUAL_W, this.renderer.h / this.VIRTUAL_H);
        this.renderer.fieldViewScale = s;
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
                const redAi = this.settings.difficulty === 'expert' && typeof Trainer !== 'undefined' && Trainer.hasTrainedAgent()
                    ? Trainer.getBestAgent()
                    : new AIController(this.settings.difficulty === 'expert' ? 'normal' : this.settings.difficulty);
                this.aiControllers.push({ player: p, ai: redAi });
            }
        }

        // Create blue team (all AI)
        for (let i = 0; i < this.settings.teamSize; i++) {
            const p = new Player(positions.blue[i].x, positions.blue[i].y, 'blue', false);
            this.players.push(p);
            const ai = this.settings.difficulty === 'expert' && typeof Trainer !== 'undefined' && Trainer.hasTrainedAgent()
                ? Trainer.getBestAgent()
                : new AIController(this.settings.difficulty === 'expert' ? 'normal' : this.settings.difficulty);
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

        this.applyMapPhysics();
        this.lastTime = performance.now();
        Sound.whistle(false);
        Sound.startMusic();
        this.loop();
    }

    createAI(type) {
        switch (type) {
            case 'trained':   return Trainer.getBestAgent();
            case 'chaser':    return new ChaserAI();
            case 'random':    return new RandomAI();
            case 'defender':  return new DefenderAI();
            case 'rule-based':
            default:          return new AIController(this.settings.difficulty || 'normal');
        }
    }

    startAIvsAI(redType, blueType) {
        this.renderer.resize();
        this._setVirtualSize(this.settings.map);
        this._updateFieldViewScale();
        this.field = new Field(this.VIRTUAL_W, this.VIRTUAL_H, this.settings.map);
        this.ball = new Ball(this.field.centerX, this.field.centerY);

        this.players = [];
        this.aiControllers = [];
        this.humanPlayer = null;
        this.isSpectator = true;
        this._aiVsAiTypes = { red: redType, blue: blueType };
        this._baseGameSpeed = Physics.GAME_SPEED;

        const positions = this.getSpawnPositions();

        for (let i = 0; i < this.settings.teamSize; i++) {
            const p = new Player(positions.red[i].x, positions.red[i].y, 'red', false);
            this.players.push(p);
            this.aiControllers.push({ player: p, ai: this.createAI(redType) });
        }

        for (let i = 0; i < this.settings.teamSize; i++) {
            const p = new Player(positions.blue[i].x, positions.blue[i].y, 'blue', false);
            this.players.push(p);
            this.aiControllers.push({ player: p, ai: this.createAI(blueType) });
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

        this.applyMapPhysics();
        this.lastTime = performance.now();
        Sound.whistle(false);
        Sound.startMusic();
        this.loop();
    }

    setSpectatorSpeed(multiplier) {
        Physics.GAME_SPEED = this._baseGameSpeed * multiplier;
    }

    startLocal1v1() {
        this.renderer.resize();
        this._setVirtualSize(this.settings.map || 'classic');
        this._updateFieldViewScale();
        this.field = new Field(this.VIRTUAL_W, this.VIRTUAL_H, this.settings.map || 'classic');
        this.ball = new Ball(this.field.centerX, this.field.centerY);

        this.players = [];
        this.aiControllers = [];
        this.isLocal1v1 = true;

        const positions = this.getSpawnPositions();
        const teamSize = this.settings.teamSize;

        // Red team: P1 is human
        for (let i = 0; i < teamSize; i++) {
            const isHuman = (i === 0);
            const p = new Player(positions.red[i].x, positions.red[i].y, 'red', isHuman);
            this.players.push(p);
            if (isHuman) {
                this.humanPlayer = p;
            } else {
                this.aiControllers.push({ player: p, ai: new AIController(this.settings.difficulty || 'normal') });
            }
        }

        // Blue team: P2 is human
        for (let i = 0; i < teamSize; i++) {
            const isHuman = (i === 0);
            const p = new Player(positions.blue[i].x, positions.blue[i].y, 'blue', isHuman);
            this.players.push(p);
            if (isHuman) {
                this.humanPlayer2 = p;
            } else {
                this.aiControllers.push({ player: p, ai: new AIController(this.settings.difficulty || 'normal') });
            }
        }

        this.rebuildTeamCache();
        this.powerUpManager = new PowerUpManager(this.field);
        this.powerUpManager.enabled = this.settings.powerups !== false;

        this.redScore = 0;
        this.blueScore = 0;
        this.timeRemaining = (this.settings.duration || 180) * 1000;
        this.isRunning = true;
        this.isPaused = false;
        this.matchOver = false;
        this.isGoalScored = false;
        this.goalTimer = 0;
        this.kickoffTeam = null;
        this.kickoffActive = false;
        this.practiceMode = false;
        this.stats = { possession: { red: 0, blue: 0 }, shots: { red: 0, blue: 0 } };
        this.momentum = { red: 0, blue: 0, max: 5, decayRate: 0.0001 };
        this.timeScale = 1.0;
        this.combo = { team: null, count: 0 };
        this.suddenDeath = false;
        this.suddenDeathTimer = 0;
        this.suddenDeathShrink = 0;
        Physics.MAX_BALL_SPEED = this._originalMaxBallSpeed;

        this.applyMapPhysics();
        this.lastTime = performance.now();
        Sound.whistle(false);
        Sound.startMusic();
        this.loop();
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
        Physics.MAX_BALL_SPEED = this._originalMaxBallSpeed;

        this.applyMapPhysics();
        this.lastTime = performance.now();
        Sound.whistle(false);
        Sound.startMusic();
        this.loop();
    }

    startOnlineMatch(settings, network, isHost) {
        this.network = network;
        this.isOnline = true;
        this.isHost = isHost;
        this.settings = { ...settings };

        this.renderer.resize();
        this._setVirtualSize(this.settings.map || 'classic');
        this._updateFieldViewScale();
        this.field = new Field(this.VIRTUAL_W, this.VIRTUAL_H, this.settings.map || 'classic');
        this.ball = new Ball(this.field.centerX, this.field.centerY);

        this.players = [];
        this.aiControllers = [];

        const positions = this.getSpawnPositions();
        const teamSize = this.settings.teamSize;

        // Red team: first player is human (local for host, remote for guest)
        for (let i = 0; i < teamSize; i++) {
            const isRedHuman = (i === 0);
            const p = new Player(positions.red[i].x, positions.red[i].y, 'red', isRedHuman);
            this.players.push(p);
            if (isRedHuman) {
                if (isHost) this.humanPlayer = p;
                else this.remoteHumanPlayer = p;
            } else {
                this.aiControllers.push({ player: p, ai: new AIController(this.settings.difficulty || 'normal') });
            }
        }

        // Blue team: first player is human (remote for host, local for guest)
        for (let i = 0; i < teamSize; i++) {
            const isBlueHuman = (i === 0);
            const p = new Player(positions.blue[i].x, positions.blue[i].y, 'blue', isBlueHuman);
            this.players.push(p);
            if (isBlueHuman) {
                if (isHost) this.remoteHumanPlayer = p;
                else this.humanPlayer = p;
            } else {
                this.aiControllers.push({ player: p, ai: new AIController(this.settings.difficulty || 'normal') });
            }
        }

        // Setup network callbacks
        if (isHost) {
            network.onRemoteInput = (inputData) => {
                Object.assign(this.remoteInput, inputData);
            };
        } else {
            network.onStateSnapshot = (snapshot) => {
                network.deserializeState(snapshot, this);
            };
            network.onGoalScored = (data) => {
                const notif = document.getElementById('goal-notification');
                notif.querySelector('.goal-text').textContent = 'GOAL!';
                notif.querySelector('.goal-scorer').textContent = data.team.toUpperCase() + ' Team';
                notif.classList.remove('hidden');
                this.isGoalScored = true;
                this.goalTimer = 2500;
                this.kickoffTeam = data.team === 'red' ? 'blue' : 'red';
                this.renderer.triggerShake(1.0);
                this.renderer.spawnConfetti(data.team);
            };
            network.onMatchEnd = (data) => {
                this.redScore = data.red;
                this.blueScore = data.blue;
                this.endMatch();
            };
        }

        this.rebuildTeamCache();
        this.powerUpManager = new PowerUpManager(this.field);
        this.powerUpManager.enabled = this.settings.powerups !== false;

        this.redScore = 0;
        this.blueScore = 0;
        this.timeRemaining = (this.settings.duration || 180) * 1000;
        this.isRunning = true;
        this.isPaused = false;
        this.matchOver = false;
        this.isGoalScored = false;
        this.goalTimer = 0;
        this.kickoffTeam = null;
        this.kickoffActive = false;
        this.practiceMode = false;
        this.stats = { possession: { red: 0, blue: 0 }, shots: { red: 0, blue: 0 } };
        this.momentum = { red: 0, blue: 0, max: 5, decayRate: 0.0001 };
        this.timeScale = 1.0;
        this.combo = { team: null, count: 0 };
        this.suddenDeath = false;
        this.suddenDeathTimer = 0;
        this.suddenDeathShrink = 0;
        Physics.MAX_BALL_SPEED = this._originalMaxBallSpeed;

        this.applyMapPhysics();
        this.lastTime = performance.now();
        Sound.whistle(false);
        Sound.startMusic();
        this.loop();
    }

    loop() {
        if (!this.isRunning) return;

        const now = performance.now();
        const dt = Math.min(now - this.lastTime, 100);
        this.lastTime = now;

        if (!this.isPaused) {
            this.update(dt);
        }

        if (this.isGoalScored) {
            this.goalTimer -= dt;
            if (this.goalTimer <= 0) {
                this.isGoalScored = false;
                document.getElementById('goal-notification').classList.add('hidden');
                this.resetAfterGoal();
            }
        }

        // Always update effects (even during goal pause)
        this.renderer.updateConfetti(dt);
        this.renderer.updateNetRipple(dt);
        this.renderer.updateHitFlashes();

        this.render();

        requestAnimationFrame(() => this.loop());
    }

    update(dt) {
        // Guest: run local prediction for own player, send input to host
        if (this.isOnline && !this.isHost) {
            Physics.dtRatio = (dt / 16.67) * Physics.GAME_SPEED;
            const sent = this.network ? this.network.sendInput(this.input) : false;

            // Local prediction: apply own input immediately for responsiveness
            const hp = this.humanPlayer;
            if (hp && hp.stunTimer <= 0 && hp.powerUp !== 'frozen') {
                hp.applyInput(this.input.x, this.input.y);

                if (this.input.kickCharging) {
                    hp.kickChargeRatio = Math.min(this.input.kickChargeTime / 1500, 1);
                } else {
                    hp.kickChargeRatio = 0;
                }

                if (this.input.switchPlayer) this.switchToNearestTeammate();

                // Move own player locally (dt-scaled)
                const s = Physics.dtRatio;
                hp.vx *= Math.pow(0.92, s);
                hp.vy *= Math.pow(0.92, s);
                hp.x += hp.vx * s;
                hp.y += hp.vy * s;

                // Keep in bounds
                const f = this.field;
                hp.x = Math.max(f.x + hp.radius, Math.min(f.x + f.width - hp.radius, hp.x));
                hp.y = Math.max(f.y + hp.radius, Math.min(f.y + f.height - hp.radius, hp.y));
            }

            // Only consume one-shot inputs after they were actually sent
            if (sent) {
                this.input.kickRelease = false;
                this.input.switchPlayer = false;
            }
            return;
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
        const rawDt = dt;
        dt *= this.timeScale;
        Physics.dtRatio = (dt / 16.67) * Physics.GAME_SPEED;

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

        // Human input
        if (this.humanPlayer && this.humanPlayer.powerUp !== 'frozen' && this.humanPlayer.stunTimer <= 0) {
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

            const action = ai.update(player, this.ball, this.field, teammates, opponents, dt);

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

        // Magnet power-up: ball attracted to player
        for (const p of this.players) {
            if (p.powerUp === 'magnet') {
                const dist = Physics.distance(p, this.ball);
                if (dist < 120 && dist > p.radius + this.ball.radius) {
                    const dx = p.x - this.ball.x;
                    const dy = p.y - this.ball.y;
                    const n = Physics.normalize(dx, dy);
                    this.ball.vx += n.x * 0.35 * Physics.dtRatio;
                    this.ball.vy += n.y * 0.35 * Physics.dtRatio;
                }
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

        // Handle pull input for human player (must be in range)
        if (this.humanPlayer && this.input.pull && !this.humanPlayer.pullActive && this.humanPlayer.pullCooldown <= 0
            && Physics.distance(this.humanPlayer, this.ball) < pullMaxRange) {
            this.humanPlayer.activatePull();
            Sound.pullActivate();
        }
        if (this.humanPlayer && !this.input.pull && this.humanPlayer.pullActive) {
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
            // Fire ball piercing: skip collision with opponents, stun them instead
            if (this.ball.fireLevel > 0 && this.ball.lastKickedBy && p.team !== this.ball.lastKickedBy.team) {
                const dist = Physics.distance(p, this.ball);
                if (dist < p.radius + this.ball.radius && p.stunTimer <= 0) {
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
            if (collided && this.ball.lastKickedBy && p !== this.ball.lastKickedBy) {
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
        const collected = this.powerUpManager.update(dt, this.players, this.suddenDeath);
        if (collected) {
            const notif = document.getElementById('powerup-notification');
            notif.querySelector('.powerup-text').textContent = collected.type.label;
            notif.classList.remove('hidden');
            setTimeout(() => notif.classList.add('hidden'), 2000);
            if (collected.type.id === 'freeze') Sound.freeze();
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
            document.getElementById('red-score').textContent = this.redScore;
        } else {
            this.blueScore += goalPoints;
            document.getElementById('blue-score').textContent = this.blueScore;
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
        const notif = document.getElementById('goal-notification');
        let goalText = isOwnGoal ? 'OWN GOAL!' : 'GOAL!';
        if (fireLevel >= 2) goalText = 'INFERNO GOAL!!!';
        else if (fireLevel >= 1) goalText = 'FIRE GOAL!';
        notif.querySelector('.goal-text').textContent = goalText;
        notif.querySelector('.goal-scorer').textContent =
            scorer ? `${scorer.team.toUpperCase()} Team${goalPoints > 1 ? ' (+' + goalPoints + ')' : ''}` : '';
        notif.classList.remove('hidden');

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

        // Sudden death: first goal wins
        if (this.suddenDeath) {
            setTimeout(() => this.endMatch(), 2100);
            return;
        }

        // Check goal limit
        if (this.settings.goalLimit > 0) {
            if (this.redScore >= this.settings.goalLimit || this.blueScore >= this.settings.goalLimit) {
                setTimeout(() => this.endMatch(), 2100);
            }
        }
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

        const resultOverlay = document.getElementById('result-overlay');
        const title = document.getElementById('result-title');
        const score = document.getElementById('result-score');
        const stats = document.getElementById('match-stats');

        // Determine local team
        const localTeam = (this.isOnline && !this.isHost) ? 'blue' : 'red';
        const localScore = localTeam === 'red' ? this.redScore : this.blueScore;
        const remoteScore = localTeam === 'red' ? this.blueScore : this.redScore;

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
            setTimeout(() => Sound.win(), 400);
        } else if (remoteScore > localScore) {
            title.textContent = 'YOU LOSE';
            title.style.color = '#e94560';
            setTimeout(() => Sound.lose(), 400);
        } else {
            title.textContent = 'DRAW';
            title.style.color = '#53d8fb';
        }

        score.innerHTML = `<span style="color:#e94560">${this.redScore}</span> - <span style="color:#53d8fb">${this.blueScore}</span>`;

        const totalPoss = this.stats.possession.red + this.stats.possession.blue;
        const redPoss = totalPoss > 0 ? Math.round((this.stats.possession.red / totalPoss) * 100) : 50;

        if (this.isSpectator) {
            stats.innerHTML = `
                Possession: <span style="color:#e94560">${redPoss}%</span> - <span style="color:#53d8fb">${100 - redPoss}%</span><br>
                Shots: <span style="color:#e94560">${this.stats.shots.red}</span> - <span style="color:#53d8fb">${this.stats.shots.blue}</span>
            `;
        } else {
            stats.innerHTML = `
                Possession: <span style="color:#e94560">${redPoss}%</span> - <span style="color:#53d8fb">${100 - redPoss}%</span><br>
                Shots: <span style="color:#e94560">${this.stats.shots.red}</span> - <span style="color:#53d8fb">${this.stats.shots.blue}</span><br>
                Your Goals: ${this.humanPlayer ? this.humanPlayer.goals : 0}<br>
                Your Kicks: ${this.humanPlayer ? this.humanPlayer.kicks : 0}
            `;
        }

        resultOverlay.classList.remove('hidden');
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

    switchToNearestTeammate() {
        if (!this.humanPlayer) return;
        const teammates = this.players.filter(p =>
            p.team === this.humanPlayer.team && p !== this.humanPlayer
        );
        if (teammates.length === 0) return;

        let nearest = null;
        let nearestDist = Infinity;
        for (const t of teammates) {
            const d = Physics.distance(t, this.ball);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = t;
            }
        }

        if (nearest) {
            // Old human becomes AI
            this.humanPlayer.isHuman = false;
            this.aiControllers.push({ player: this.humanPlayer, ai: new AIController(this.settings.difficulty) });

            // New human
            nearest.isHuman = true;
            this.aiControllers = this.aiControllers.filter(c => c.player !== nearest);
            this.humanPlayer = nearest;
        }
    }

    switchToNearestTeammate_remote() {
        if (!this.remoteHumanPlayer) return;
        const teammates = this.players.filter(p =>
            p.team === this.remoteHumanPlayer.team && p !== this.remoteHumanPlayer
        );
        if (teammates.length === 0) return;

        let nearest = null;
        let nearestDist = Infinity;
        for (const t of teammates) {
            const d = Physics.distance(t, this.ball);
            if (d < nearestDist) { nearestDist = d; nearest = t; }
        }

        if (nearest) {
            this.remoteHumanPlayer.isHuman = false;
            this.aiControllers.push({ player: this.remoteHumanPlayer, ai: new AIController(this.settings.difficulty || 'normal') });
            nearest.isHuman = true;
            this.aiControllers = this.aiControllers.filter(c => c.player !== nearest);
            this.remoteHumanPlayer = nearest;
        }
    }

    switchToNearestTeammate_p2() {
        if (!this.humanPlayer2) return;
        const teammates = this.players.filter(p =>
            p.team === this.humanPlayer2.team && p !== this.humanPlayer2
        );
        if (teammates.length === 0) return;

        let nearest = null;
        let nearestDist = Infinity;
        for (const t of teammates) {
            const d = Physics.distance(t, this.ball);
            if (d < nearestDist) { nearestDist = d; nearest = t; }
        }

        if (nearest) {
            this.humanPlayer2.isHuman = false;
            this.aiControllers.push({ player: this.humanPlayer2, ai: new AIController(this.settings.difficulty || 'normal') });
            nearest.isHuman = true;
            this.aiControllers = this.aiControllers.filter(c => c.player !== nearest);
            this.humanPlayer2 = nearest;
        }
    }

    render() {
        this.renderer.clear();

        // Apply field view scale for training-size matches (trained AI watch mode)
        const ctx = this.renderer.ctx;
        const fvs = this.renderer.fieldViewScale;
        if (fvs) {
            ctx.save();
            if (this.cameraZoom > 1) {
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

        // Update pull button visual state
        const pullBtn = document.getElementById('btn-pull');
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

        // Huge map: draw off-screen indicators and minimap (in screen space)
        if (this.cameraZoom > 1) {
            this._drawOffScreenArrows(ctx);
            this._drawMinimap(ctx);
        }

        // End frame (restore screen shake transform)
        this.renderer.endFrame();
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
        if (this.isOnline) return; // No pausing in online matches
        this.isPaused = true;
        Sound.pause();
        document.getElementById('pause-overlay').classList.remove('hidden');
    }

    resume() {
        this.isPaused = false;
        this.lastTime = performance.now();
        Sound.resume();
        document.getElementById('pause-overlay').classList.add('hidden');
    }

    restart() {
        document.getElementById('pause-overlay').classList.add('hidden');
        document.getElementById('result-overlay').classList.add('hidden');
        document.getElementById('goal-notification').classList.add('hidden');
        if (this._aiVsAiTypes) {
            this.startAIvsAI(this._aiVsAiTypes.red, this._aiVsAiTypes.blue);
        } else {
            this.startMatch();
        }
    }

    quit() {
        this.isRunning = false;
        this.isLocal1v1 = false;
        this.isSpectator = false;
        this._aiVsAiTypes = null;
        Physics.GAME_SPEED = this._baseGameSpeed;
        this.resetMapPhysics();
        Sound.stopMusic();
        this.humanPlayer2 = null;
        if (this.isOnline && this.network) {
            this.network.destroy();
            this.network = null;
            this.isOnline = false;
            this.isHost = false;
        }
        document.getElementById('pause-overlay').classList.add('hidden');
        document.getElementById('result-overlay').classList.add('hidden');
        document.getElementById('goal-notification').classList.add('hidden');
        document.getElementById('disconnect-overlay').classList.add('hidden');
        document.getElementById('online-hud').classList.add('hidden');
    }
}
