// Main game logic
class Game {
    constructor() {
        this.canvas = document.getElementById('game-canvas');
        this.renderer = new Renderer(this.canvas);

        this.settings = {
            teamSize: 2,
            duration: 180,
            goalLimit: 5,
            difficulty: 'medium',
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
        this.lastTime = 0;
        this.matchOver = false;

        this.input = { x: 0, y: 0, kick: false, dash: false, tackle: false, kickCharging: false, kickChargeStart: 0, kickChargeTime: 0, kickRelease: false, switchPlayer: false };
        this.timeScale = 1.0;
        this.momentum = { red: 0, blue: 0, max: 5, decayRate: 0.0001 };

        // Online multiplayer state
        this.isOnline = false;
        this.isHost = false;
        this.network = null;
        this.remoteInput = { x: 0, y: 0, dash: false, tackle: false, kickCharging: false, kickChargeTime: 0, kickRelease: false, switchPlayer: false };
        this.remoteHumanPlayer = null;

        // Stats
        this.stats = {
            possession: { red: 0, blue: 0 },
            shots: { red: 0, blue: 0 },
        };

        window.addEventListener('resize', () => this.onResize());
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
            if (p.isKeeper) {
                // Update keeper spawn position
                const keeperPos = p.team === 'red' ? positions.redKeeper : positions.blueKeeper;
                p.spawnX = keeperPos.x;
                p.spawnY = keeperPos.y;
            } else if (p.team === 'red') {
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

        // Keeper spawn positions (near each goal)
        const goalCenterY = f.goalY + f.goalHeight / 2;
        positions.redKeeper = { x: f.x + f.width * 0.15, y: goalCenterY };
        positions.blueKeeper = { x: f.x + f.width * 0.85, y: goalCenterY };

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
                this.aiControllers.push({ player: p, ai: new AIController(this.settings.difficulty) });
            }
        }

        // Create blue team (all AI)
        for (let i = 0; i < this.settings.teamSize; i++) {
            const p = new Player(positions.blue[i].x, positions.blue[i].y, 'blue', false);
            this.players.push(p);
            this.aiControllers.push({ player: p, ai: new AIController(this.settings.difficulty) });
        }

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
        this.stats = { possession: { red: 0, blue: 0 }, shots: { red: 0, blue: 0 } };
        this.momentum = { red: 0, blue: 0, max: 5, decayRate: 0.0001 };
        this.timeScale = 1.0;

        this.lastTime = performance.now();
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
        this.practiceMode = true;
        this.stats = { possession: { red: 0, blue: 0 }, shots: { red: 0, blue: 0 } };

        this.lastTime = performance.now();
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
                this.aiControllers.push({ player: p, ai: new AIController(this.settings.difficulty || 'medium') });
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
                this.aiControllers.push({ player: p, ai: new AIController(this.settings.difficulty || 'medium') });
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
                this.renderer.triggerShake(1.0);
                this.renderer.spawnConfetti(data.team);
            };
            network.onMatchEnd = (data) => {
                this.redScore = data.red;
                this.blueScore = data.blue;
                this.endMatch();
            };
        }

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
        this.practiceMode = false;
        this.stats = { possession: { red: 0, blue: 0 }, shots: { red: 0, blue: 0 } };
        this.momentum = { red: 0, blue: 0, max: 5, decayRate: 0.0001 };
        this.timeScale = 1.0;

        this.lastTime = performance.now();
        this.loop();
    }

    loop() {
        if (!this.isRunning) return;

        const now = performance.now();
        const dt = Math.min(now - this.lastTime, 33); // Cap at ~30fps worth of dt
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
            const sent = this.network ? this.network.sendInput(this.input) : false;

            // Local prediction: apply own input immediately for responsiveness
            const hp = this.humanPlayer;
            if (hp && hp.stunTimer <= 0 && hp.powerUp !== 'frozen') {
                hp.applyInput(this.input.x, this.input.y);

                if (this.input.kickCharging) {
                    hp.kickChargeRatio = Math.min(this.input.kickChargeTime / 1000, 1);
                } else {
                    hp.kickChargeRatio = 0;
                }

                if (this.input.dash) hp.dash();
                if (this.input.tackle) hp.tackle(this.ball);
                if (this.input.switchPlayer) this.switchToNearestTeammate();

                // Move own player locally
                hp.vx *= Math.pow(0.92, dt / 16.67);
                hp.vy *= Math.pow(0.92, dt / 16.67);
                hp.x += hp.vx * dt / 16.67;
                hp.y += hp.vy * dt / 16.67;

                // Keep in bounds
                const f = this.field;
                hp.x = Math.max(f.x + hp.radius, Math.min(f.x + f.width - hp.radius, hp.x));
                hp.y = Math.max(f.y + hp.radius, Math.min(f.y + f.height - hp.radius, hp.y));
            }

            // Only consume one-shot inputs after they were actually sent
            if (sent) {
                this.input.kickRelease = false;
                this.input.dash = false;
                this.input.tackle = false;
                this.input.switchPlayer = false;
            }
            return;
        }

        // Apply time scale for slow-motion effects
        const rawDt = dt;
        dt *= this.timeScale;

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
            document.getElementById('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
        }

        // Momentum decay
        this.momentum.red = Math.max(0, this.momentum.red - this.momentum.decayRate * dt);
        this.momentum.blue = Math.max(0, this.momentum.blue - this.momentum.decayRate * dt);

        // Apply momentum bonus to all players
        for (const p of this.players) {
            p.momentumBonus = this.momentum[p.team] / this.momentum.max;
        }

        // Update momentum HUD
        const redBar = document.getElementById('momentum-fill-red');
        const blueBar = document.getElementById('momentum-fill-blue');
        if (redBar) redBar.style.width = (this.momentum.red / this.momentum.max * 100) + '%';
        if (blueBar) blueBar.style.width = (this.momentum.blue / this.momentum.max * 100) + '%';

        // Human input
        if (this.humanPlayer && this.humanPlayer.powerUp !== 'frozen' && this.humanPlayer.stunTimer <= 0) {
            this.humanPlayer.applyInput(this.input.x, this.input.y);

            // Track charge time for visual feedback + slow player while charging
            if (this.input.kickCharging) {
                this.humanPlayer.kickChargeRatio = Math.min((performance.now() - this.input.kickChargeStart) / 1000, 1);
                // Slow player down while holding kick (more charge = slower)
                const slowFactor = 1 - this.humanPlayer.kickChargeRatio * 0.12; // up to 12% slower at full charge
                this.humanPlayer.vx *= slowFactor;
                this.humanPlayer.vy *= slowFactor;
            } else {
                this.humanPlayer.kickChargeRatio = 0;
            }

            // Charged kick: released after charging
            if (this.input.kickRelease) {
                const chargeRatio = Math.min(this.input.kickChargeTime / 1000, 1);
                if (this.humanPlayer.kick(this.ball, chargeRatio)) {
                    this.stats.shots.red++;
                    const shakeIntensity = 0.15 + chargeRatio * 0.85;
                    this.renderer.triggerShake(shakeIntensity);
                    this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + chargeRatio * 0.7);
                    // Momentum on kicks toward opponent half
                    if (this.ball.vx > 0) this.addMomentum('red');
                }
                if (chargeRatio > 0.5) {
                    this.hitNearbyPlayers(this.humanPlayer);
                }
                this.input.kickRelease = false;
                this.input.kickChargeTime = 0;
            }

            if (this.input.tackle) {
                this.humanPlayer.tackle(this.ball);
                this.input.tackle = false;
            } else if (this.input.dash) {
                this.humanPlayer.dash();
                this.input.dash = false;
            }

            if (this.input.switchPlayer) {
                this.switchToNearestTeammate();
                this.input.switchPlayer = false;
            }
        }

        // Remote player input (online: host applies guest's input to blue human)
        if (this.isOnline && this.isHost && this.remoteHumanPlayer &&
            this.remoteHumanPlayer.powerUp !== 'frozen' && this.remoteHumanPlayer.stunTimer <= 0) {

            this.remoteHumanPlayer.applyInput(this.remoteInput.x, this.remoteInput.y);

            if (this.remoteInput.kickCharging) {
                this.remoteHumanPlayer.kickChargeRatio = Math.min(this.remoteInput.kickChargeTime / 1000, 1);
                const slowFactor = 1 - this.remoteHumanPlayer.kickChargeRatio * 0.12;
                this.remoteHumanPlayer.vx *= slowFactor;
                this.remoteHumanPlayer.vy *= slowFactor;
            } else {
                this.remoteHumanPlayer.kickChargeRatio = 0;
            }

            if (this.remoteInput.kickRelease) {
                const chargeRatio = Math.min(this.remoteInput.kickChargeTime / 1000, 1);
                if (this.remoteHumanPlayer.kick(this.ball, chargeRatio)) {
                    this.stats.shots.blue++;
                    this.renderer.triggerShake(0.15 + chargeRatio * 0.85);
                    this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.3 + chargeRatio * 0.7);
                    if (this.ball.vx < 0) this.addMomentum('blue');
                }
                if (chargeRatio > 0.5) this.hitNearbyPlayers(this.remoteHumanPlayer);
                this.remoteInput.kickRelease = false;
                this.remoteInput.kickChargeTime = 0;
            }

            if (this.remoteInput.tackle) {
                this.remoteHumanPlayer.tackle(this.ball);
                this.remoteInput.tackle = false;
            } else if (this.remoteInput.dash) {
                this.remoteHumanPlayer.dash();
                this.remoteInput.dash = false;
            }

            if (this.remoteInput.switchPlayer) {
                this.switchToNearestTeammate_remote();
                this.remoteInput.switchPlayer = false;
            }
        }

        // AI input
        const redTeam = this.players.filter(p => p.team === 'red');
        const blueTeam = this.players.filter(p => p.team === 'blue');

        for (const { player, ai } of this.aiControllers) {
            if (player.powerUp === 'frozen' || player.stunTimer > 0) continue;

            const teammates = player.team === 'red' ? redTeam : blueTeam;
            const opponents = player.team === 'red' ? blueTeam : redTeam;

            const action = ai.update(player, this.ball, this.field, teammates, opponents, dt);

            if (action.kick) {
                if (player.kick(this.ball, 0.3)) {
                    this.stats.shots[player.team]++;
                    this.renderer.triggerShake(0.2);
                    this.renderer.spawnHitFlash(this.ball.x, this.ball.y, 0.4);
                    // Momentum on kicks toward opponent half
                    const towardGoal = (player.team === 'red' && this.ball.vx > 0) || (player.team === 'blue' && this.ball.vx < 0);
                    if (towardGoal) this.addMomentum(player.team);
                }
                this.hitNearbyPlayers(player);
            }
            if (action.dash) {
                player.dash();
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

                // Gently steer toward goal
                const steerForce = 0.12;
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
                    this.ball.vx += n.x * 0.35;
                    this.ball.vy += n.y * 0.35;
                }
            }
        }

        // Update entities
        for (const p of this.players) p.update(dt);
        this.ball.update(dt);

        // Player-ball collisions
        for (const p of this.players) {
            const collided = Physics.resolveCircleCollision(p, this.ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE);

            // Hit flash on collision
            if (collided) {
                const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
                const intensity = Math.min(ballSpeed / Physics.MAX_BALL_SPEED, 1);
                if (intensity > 0.15) {
                    this.renderer.spawnHitFlash(this.ball.x, this.ball.y, intensity);
                }
            }

            // Auto super kick: if player is fully charged and touches the ball, fire it at enemy goal
            if (collided && p === this.humanPlayer && this.input.kickCharging && p.kickChargeRatio >= 1.0) {
                p.kick(this.ball, 1.0);
                this.stats.shots.red++;
                this.renderer.triggerShake(0.8);
                this.input.kickCharging = false;
                this.input.kickRelease = false;
                this.input.kickChargeTime = 0;
                p.kickChargeRatio = 0;
            }

            // Tackle: extra force on ball in tackle direction
            if (collided && p.isTackling) {
                this.ball.vx += p.tackleDirX * Physics.KICK_FORCE * 0.8;
                this.ball.vy += p.tackleDirY * Physics.KICK_FORCE * 0.8;
                this.ball.lastKickedBy = p;
                this.addMomentum(p.team);
            }

            // Fire ball hits any player: knock them back and stun
            if (collided && this.ball.superKick > 0 && p !== this.ball.lastKickedBy) {
                const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
                // Stun duration scales with impact speed (600-1200ms)
                p.stunTimer = 600 + (ballSpeed / Physics.MAX_BALL_SPEED) * 600;
                // Smooth knockback: add to existing velocity for natural feel
                if (ballSpeed > 0.5) {
                    const knockbackForce = 3 + (ballSpeed / Physics.MAX_BALL_SPEED) * 8;
                    const nx = this.ball.vx / ballSpeed;
                    const ny = this.ball.vy / ballSpeed;
                    p.vx += nx * knockbackForce;
                    p.vy += ny * knockbackForce;
                }
                // Spawn visual impact
                this.renderer.spawnHitFlash(p.x, p.y, 0.8);
            }
        }

        // Player-player collisions
        for (let i = 0; i < this.players.length; i++) {
            for (let j = i + 1; j < this.players.length; j++) {
                Physics.resolveCircleCollision(
                    this.players[i], this.players[j],
                    Physics.PLAYER_BOUNCE, Physics.PLAYER_BOUNCE
                );
            }
        }

        // Constrain to field
        for (const p of this.players) {
            Physics.constrainToField(p, this.field, true);
        }
        Physics.constrainToField(this.ball, this.field, false);

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
        }

        // Check goal (skip if already celebrating)
        if (!this.isGoalScored) {
            const goal = Physics.checkGoal(this.ball, this.field);
            if (goal) {
                this.scoreGoal(goal);
            }

            // Near-miss slow-mo: ball heading fast toward goal area
            if (!goal) {
                const ballInGoalY = this.ball.y > this.field.goalY &&
                                     this.ball.y < this.field.goalY + this.field.goalHeight;
                const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
                const nearLeftGoal = this.ball.x < this.field.x + 40 && this.ball.vx < -3;
                const nearRightGoal = this.ball.x > this.field.x + this.field.width - 40 && this.ball.vx > 3;

                if (ballInGoalY && ballSpeed > 6 && (nearLeftGoal || nearRightGoal)) {
                    this.timeScale = Math.max(0.4, this.timeScale * 0.95);
                } else {
                    this.timeScale = Math.min(1.0, this.timeScale + 0.05);
                }
            }
        }

        // Online: host sends state to guest
        if (this.isOnline && this.isHost && this.network) {
            this.network.sendState(this);
        }
    }

    hitNearbyPlayers(kicker) {
        for (const p of this.players) {
            if (p === kicker || p.stunTimer > 0) continue;
            const dist = Physics.distance(kicker, p);
            const touchRange = kicker.radius + p.radius + 20;
            if (dist > touchRange) continue;

            const dx = p.x - kicker.x;
            const dy = p.y - kicker.y;
            const n = Physics.normalize(dx, dy);
            // Add knockback to existing velocity for smoother feel
            p.vx += n.x * 6;
            p.vy += n.y * 6;
            p.stunTimer = 700;
            this.renderer.spawnHitFlash(p.x, p.y, 0.6);
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

        // Track who scored
        if (this.ball.lastKickedBy) {
            this.ball.lastKickedBy.goals++;
        }

        // Show notification
        const notif = document.getElementById('goal-notification');
        notif.querySelector('.goal-text').textContent = 'GOAL!';
        const scorer = this.ball.lastKickedBy;
        notif.querySelector('.goal-scorer').textContent =
            scorer ? `${scorer.team.toUpperCase()} Team` : '';
        notif.classList.remove('hidden');

        this.isGoalScored = true;
        this.goalTimer = 2500;

        // Heavy screen shake on goal
        this.renderer.triggerShake(1.0);

        // Slow-motion on goal
        this.timeScale = 0.3;
        setTimeout(() => { this.timeScale = 1.0; }, 800);

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
    }

    endMatch() {
        this.isRunning = false;
        this.matchOver = true;

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
        } else if (remoteScore > localScore) {
            title.textContent = 'YOU LOSE';
            title.style.color = '#e94560';
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

    addMomentum(team, amount = 1) {
        this.momentum[team] = Math.min(this.momentum.max, this.momentum[team] + amount);
    }

    switchToNearestTeammate() {
        if (!this.humanPlayer) return;
        const teammates = this.players.filter(p =>
            p.team === this.humanPlayer.team && p !== this.humanPlayer && !p.isKeeper
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
            p.team === this.remoteHumanPlayer.team && p !== this.remoteHumanPlayer && !p.isKeeper
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
            this.aiControllers.push({ player: this.remoteHumanPlayer, ai: new AIController(this.settings.difficulty || 'medium') });
            nearest.isHuman = true;
            this.aiControllers = this.aiControllers.filter(c => c.player !== nearest);
            this.remoteHumanPlayer = nearest;
        }
    }

    render() {
        this.renderer.clear();
        this.renderer.trackedBall = this.ball;
        this.renderer.drawField(this.field);

        // Power-ups
        this.powerUpManager.draw(this.renderer.ctx);

        // Players
        for (const p of this.players) {
            this.renderer.drawPlayer(p, p === this.humanPlayer);
            if (p === this.humanPlayer) {
                this.renderer.drawDashCooldown(p);
            }
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
        document.getElementById('pause-overlay').classList.remove('hidden');
    }

    resume() {
        this.isPaused = false;
        this.lastTime = performance.now();
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
