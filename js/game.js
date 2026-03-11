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

        this.input = { x: 0, y: 0, kick: false, dash: false, tackle: false, kickCharging: false, kickChargeStart: 0, kickChargeTime: 0, kickRelease: false };

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

        this.render();

        requestAnimationFrame(() => this.loop());
    }

    update(dt) {
        // Timer (skip in practice mode)
        if (!this.practiceMode) {
            this.timeRemaining -= dt;
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
                    if (chargeRatio > 0.8) {
                        this.renderer.triggerShake(0.8);
                    }
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
            }

            // Fire ball hits any player: knock them back and stun for 1 second
            if (collided && this.ball.superKick > 0 && p !== this.ball.lastKickedBy) {
                p.stunTimer = 1000;
                // Knockback scales with ball speed (faster = harder hit)
                const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
                if (ballSpeed > 0.5) {
                    const knockbackForce = 4 + (ballSpeed / Physics.MAX_BALL_SPEED) * 12;
                    p.vx = (this.ball.vx / ballSpeed) * knockbackForce;
                    p.vy = (this.ball.vy / ballSpeed) * knockbackForce;
                }
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
            p.vx = n.x * 8;
            p.vy = n.y * 8;
            p.stunTimer = 1000;
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

        // Confetti explosion
        this.renderer.spawnConfetti(team);

        // Net ripple: ball scored in left goal = blue scored, right goal = red scored
        const netSide = team === 'blue' ? 'left' : 'right';
        this.renderer.triggerNetRipple(netSide, this.ball.y, this.field);

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

        const resultOverlay = document.getElementById('result-overlay');
        const title = document.getElementById('result-title');
        const score = document.getElementById('result-score');
        const stats = document.getElementById('match-stats');

        if (this.redScore > this.blueScore) {
            title.textContent = 'YOU WIN!';
            title.style.color = '#4caf50';
        } else if (this.blueScore > this.redScore) {
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

        // Confetti (on top of everything)
        this.renderer.drawConfetti();

        // End frame (restore screen shake transform)
        this.renderer.endFrame();
    }

    pause() {
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
        document.getElementById('pause-overlay').classList.add('hidden');
        document.getElementById('result-overlay').classList.add('hidden');
        document.getElementById('goal-notification').classList.add('hidden');
    }
}
