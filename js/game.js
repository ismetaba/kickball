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

        this.input = { x: 0, y: 0, kick: false, kickCharging: false, kickChargeStart: 0, kickChargeTime: 0, kickRelease: false, switchPlayer: false };
        this.input2 = { x: 0, y: 0, kick: false, kickCharging: false, kickChargeStart: 0, kickChargeTime: 0, kickRelease: false, switchPlayer: false };
        this.timeScale = 1.0;
        this.slowMoTimer = 0;
        this.momentum = { red: 0, blue: 0, max: 5, decayRate: 0.0001 };
        this._lastCountdownSec = -1;

        // Local 1v1
        this.isLocal1v1 = false;
        this.humanPlayer2 = null;

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

        window.addEventListener('resize', () => this.onResize());
    }

    rebuildTeamCache() {
        this._redTeam = this.players.filter(p => p.team === 'red');
        this._blueTeam = this.players.filter(p => p.team === 'blue');
    }

    onResize() {
        if (!this.isRunning) return;
        this.renderer.resize();
        this.field.update(this.renderer.w, this.renderer.h);
        this.repositionEntities();
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

    startMatch() {
        this.renderer.resize();
        this.field = new Field(this.renderer.w, this.renderer.h, this.settings.map);
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

        this.lastTime = performance.now();
        Sound.whistle(false);
        Sound.startMusic();
        this.loop();
    }

    startLocal1v1() {
        this.renderer.resize();
        this.field = new Field(this.renderer.w, this.renderer.h, this.settings.map || 'classic');
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

        this.lastTime = performance.now();
        Sound.whistle(false);
        Sound.startMusic();
        this.loop();
    }

    startPractice() {
        this.renderer.resize();
        this.field = new Field(this.renderer.w, this.renderer.h, this.settings.map);
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
        this.field = new Field(this.renderer.w, this.renderer.h, this.settings.map || 'classic');
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
            this.timeRemaining -= rawDt;
            if (this.timeRemaining <= 0) {
                this.timeRemaining = 0;
                this.endMatch();
                return;
            }

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
                const slowFactor = 1 - this.humanPlayer.kickChargeRatio * 0.04;
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
                const slowFactor = 1 - this.remoteHumanPlayer.kickChargeRatio * 0.04;
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
                const slowFactor = 1 - this.humanPlayer2.kickChargeRatio * 0.04;
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

        // Update entities
        for (const p of this.players) p.update(dt);
        this.ball.update(dt);

        // Player-ball collisions
        for (const p of this.players) {
            // Dribble: when player is close to ball and moving, gently guide ball along
            const dribbleDist = Physics.distance(p, this.ball);
            const dribbleRange = p.radius + this.ball.radius + 6;
            if (dribbleDist < dribbleRange && dribbleDist > 0 && p.stunTimer <= 0) {
                const playerSpeed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
                if (playerSpeed > 0.8) {
                    // Soft nudge scaled by proximity — closer = stronger
                    const proximity = 1 - (dribbleDist / dribbleRange);
                    const strength = 0.04 * proximity * Physics.dtRatio;
                    this.ball.vx += p.vx * strength;
                    this.ball.vy += p.vy * strength;
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

                // OWN-GOAL DEFLECTION PREVENTION: if collision sent ball toward player's own goal,
                // dampen the toward-own-goal velocity to prevent accidental own goals
                if (!p.isHuman) {
                    const ownGoalX = p.team === 'red' ? this.field.x : this.field.x + this.field.width;
                    const towardOwn = p.team === 'red' ? this.ball.vx < -1.5 : this.ball.vx > 1.5;
                    const distToOwnGoal = Math.abs(p.x - ownGoalX);

                    if (towardOwn && distToOwnGoal < this.field.width * 0.5) {
                        // Scale dampening: stronger when closer to own goal
                        const dangerFactor = 1 - (distToOwnGoal / (this.field.width * 0.5));
                        const dampen = 0.1 + (1 - dangerFactor) * 0.3; // 0.1 near goal, 0.4 at midfield
                        this.ball.vx *= dampen;
                        // Push ball sideways toward nearest sideline instead
                        const sideDir = this.ball.y < this.field.centerY ? -1 : 1;
                        const redirectForce = Math.abs(this.ball.vx) * 0.6 + 1.5;
                        this.ball.vy += sideDir * redirectForce;
                    }
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

        // Constrain to field
        for (const p of this.players) {
            Physics.constrainToField(p, this.field, true);
        }

        // Kickoff restriction: scoring team can't cross center line or enter center circle
        if (this.kickoffActive && this.kickoffTeam) {
            const restrictedTeam = this.kickoffTeam === 'red' ? 'blue' : 'red';
            const centerX = this.field.centerX;
            const centerY = this.field.centerY;
            const circleR = this.field.centerRadius;
            for (const p of this.players) {
                if (p.team !== restrictedTeam) continue;

                // Block from crossing center line
                if (restrictedTeam === 'red') {
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

                // Block from entering center circle
                const dx = p.x - centerX;
                const dy = p.y - centerY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const minDist = circleR + p.radius;
                if (dist < minDist && dist > 0) {
                    const nx = dx / dist;
                    const ny = dy / dist;
                    p.x = centerX + nx * minDist;
                    p.y = centerY + ny * minDist;
                    // Kill velocity toward center
                    const dot = p.vx * nx + p.vy * ny;
                    if (dot < 0) {
                        p.vx -= dot * nx;
                        p.vy -= dot * ny;
                    }
                }
            }
        }
        const wallHit = Physics.constrainToField(this.ball, this.field, false);
        if (wallHit) {
            const spd = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
            Sound.wallBounce(spd);
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
        const collected = this.powerUpManager.update(dt, this.players);
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
        if (team === 'red') {
            this.redScore++;
            document.getElementById('red-score').textContent = this.redScore;
        } else {
            this.blueScore++;
            document.getElementById('blue-score').textContent = this.blueScore;
        }

        // Track who scored — only credit if they scored for their own team (not own goal)
        const scorer = this.ball.lastKickedBy;
        const isOwnGoal = scorer && scorer.team !== team;
        if (scorer && !isOwnGoal) {
            scorer.goals++;
        }

        // Show notification
        const notif = document.getElementById('goal-notification');
        notif.querySelector('.goal-text').textContent = isOwnGoal ? 'OWN GOAL!' : 'GOAL!';
        notif.querySelector('.goal-scorer').textContent =
            scorer ? `${scorer.team.toUpperCase()} Team` : '';
        notif.classList.remove('hidden');

        this.isGoalScored = true;
        this.goalTimer = 2500;

        // Set kickoff team: the team that was scored ON gets the kickoff
        // 'team' is who scored, so the other team gets the kickoff
        this.kickoffTeam = team === 'red' ? 'blue' : 'red';

        // Goal sound + heavy screen shake
        Sound.goal();
        this.renderer.triggerShake(1.0);

        // Slow-motion on goal (timer-based, not setTimeout)
        this.timeScale = 0.3;
        this.slowMoTimer = 800;

        // Momentum boost for scoring team
        this.addMomentum(team, 2);

        // Confetti explosion
        this.renderer.spawnConfetti(team);

        // Net ripple: ball scored in left goal = blue scored, right goal = red scored
        const netSide = team === 'blue' ? 'left' : 'right';
        this.renderer.triggerNetRipple(netSide, this.ball.y, this.field);

        // Notify guest about goal
        if (this.isOnline && this.isHost && this.network) {
            this.network.send({ t: 'goal', d: { team: team } });
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

        if (localScore > remoteScore) {
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

        stats.innerHTML = `
            Possession: <span style="color:#e94560">${redPoss}%</span> - <span style="color:#53d8fb">${100 - redPoss}%</span><br>
            Shots: <span style="color:#e94560">${this.stats.shots.red}</span> - <span style="color:#53d8fb">${this.stats.shots.blue}</span><br>
            Your Goals: ${this.humanPlayer ? this.humanPlayer.goals : 0}<br>
            Your Kicks: ${this.humanPlayer ? this.humanPlayer.kicks : 0}
        `;

        resultOverlay.classList.remove('hidden');
    }

    hitNearbyPlayers(kicker, chargeRatio) {
        if (chargeRatio < 0.50) return;
        const hitRange = kicker.radius + 40;
        const knockForce = 2.0 + chargeRatio * 3.0;
        for (const p of this.players) {
            if (p === kicker || p.team === kicker.team) continue;
            const dist = Physics.distance(kicker, p);
            if (dist < hitRange && dist > 0) {
                const dx = p.x - kicker.x;
                const dy = p.y - kicker.y;
                const n = Physics.normalize(dx, dy);
                p.vx += n.x * knockForce;
                p.vy += n.y * knockForce;
                p.stunTimer = 300 + chargeRatio * 700;
                this.renderer.spawnHitFlash(p.x, p.y, 0.4);
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
        this.renderer.trackedBall = this.ball;
        this.renderer.drawField(this.field);

        // Kickoff barrier visual
        if (this.kickoffActive && this.kickoffTeam) {
            const restrictedTeam = this.kickoffTeam === 'red' ? 'blue' : 'red';
            this.renderer.drawKickoffBarrier(this.field, restrictedTeam);
        }

        // Power-ups
        this.powerUpManager.draw(this.renderer.ctx);

        // Players
        for (const p of this.players) {
            const isControlled = (p === this.humanPlayer) || (p === this.humanPlayer2);
            this.renderer.drawPlayer(p, isControlled);
        }

        // Ball
        this.renderer.drawBall(this.ball);

        // Hit flash particles
        this.renderer.drawHitFlashes();

        // Confetti (on top of everything)
        this.renderer.drawConfetti();

        // End frame (restore screen shake transform)
        this.renderer.endFrame();
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
        this.startMatch();
    }

    quit() {
        this.isRunning = false;
        this.isLocal1v1 = false;
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
