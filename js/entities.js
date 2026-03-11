// Game entities: Player, Ball, Field

class Player {
    constructor(x, y, team, isHuman = false, isKeeper = false) {
        this.x = x;
        this.y = y;
        this.spawnX = x;
        this.spawnY = y;
        this.vx = 0;
        this.vy = 0;
        this.radius = isKeeper ? 28 : 24;
        this.mass = 1;
        this.team = team; // 'red' or 'blue'
        this.isHuman = isHuman;
        this.isKeeper = isKeeper;
        this.kickCooldown = 0;
        this.dashCooldown = 0;
        this.dashTimer = 0;
        this.isDashing = false;
        this.powerUp = null;
        this.powerUpTimer = 0;
        this.goals = 0;
        this.assists = 0;
        this.kicks = 0;
        this.lastTouchedBall = false;
        // Tackle properties
        this.tackleCooldown = 0;
        this.tackleTimer = 0;
        this.isTackling = false;
        this.tackleRecoveryTimer = 0;
        this.tackleDirX = 0;
        this.tackleDirY = 0;
        this.kickChargeRatio = 0;
        this.stunTimer = 0;
    }

    reset() {
        this.x = this.spawnX;
        this.y = this.spawnY;
        this.vx = 0;
        this.vy = 0;
        this.kickCooldown = 0;
        this.isDashing = false;
        this.dashTimer = 0;
        this.isTackling = false;
        this.tackleTimer = 0;
        this.tackleRecoveryTimer = 0;
        this.stunTimer = 0;
    }

    update(dt) {
        // Stunned: can't do anything, just sit still
        if (this.stunTimer > 0) {
            this.stunTimer -= dt;
            this.vx *= 0.8;
            this.vy *= 0.8;
            this.x += this.vx;
            this.y += this.vy;
            return;
        }

        if (this.kickCooldown > 0) this.kickCooldown -= dt;
        if (this.dashCooldown > 0) this.dashCooldown -= dt;
        if (this.tackleCooldown > 0) this.tackleCooldown -= dt;

        if (this.isDashing) {
            this.dashTimer -= dt;
            if (this.dashTimer <= 0) {
                this.isDashing = false;
            }
        }

        if (this.isTackling) {
            this.tackleTimer -= dt;
            if (this.tackleTimer <= 0) {
                this.isTackling = false;
                this.tackleRecoveryTimer = 200; // 200ms recovery
            }
        }

        if (this.tackleRecoveryTimer > 0) {
            this.tackleRecoveryTimer -= dt;
            // Player is immobile during recovery
            this.vx *= 0.85;
            this.vy *= 0.85;
        }

        if (this.powerUpTimer > 0) {
            this.powerUpTimer -= dt;
            if (this.powerUpTimer <= 0) {
                this.powerUp = null;
            }
        }

        // Apply friction
        const friction = (this.isDashing || this.isTackling) ? 0.995 : Physics.FRICTION;
        this.vx *= friction;
        this.vy *= friction;

        // Clamp speed
        const maxSpeed = (this.isDashing || this.isTackling) ? Physics.MAX_PLAYER_SPEED * 2 : this.getMaxSpeed();
        Physics.clampSpeed(this, maxSpeed);

        this.x += this.vx;
        this.y += this.vy;
    }

    getMaxSpeed() {
        if (this.powerUp === 'speed') return Physics.MAX_PLAYER_SPEED * 1.5;
        return Physics.MAX_PLAYER_SPEED;
    }

    getKickForce() {
        if (this.powerUp === 'power') return Physics.POWER_KICK_FORCE;
        return Physics.KICK_FORCE;
    }

    applyInput(inputX, inputY) {
        const accel = Physics.PLAYER_ACCELERATION;
        this.vx += inputX * accel;
        this.vy += inputY * accel;
    }

    dash() {
        if (this.dashCooldown > 0 || this.isDashing) return false;

        const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (speed < 0.5) {
            // Dash forward if standing still (towards center)
            this.vx = (this.team === 'red' ? 1 : -1) * Physics.DASH_FORCE;
        } else {
            const n = Physics.normalize(this.vx, this.vy);
            this.vx = n.x * Physics.DASH_FORCE;
            this.vy = n.y * Physics.DASH_FORCE;
        }

        this.isDashing = true;
        this.dashTimer = Physics.DASH_DURATION;
        this.dashCooldown = Physics.DASH_COOLDOWN;
        return true;
    }

    kick(ball, chargeRatio = 0) {
        if (this.kickCooldown > 0) return false;

        const dist = Physics.distance(this, ball);
        const kickRange = this.radius + ball.radius + 8;

        if (dist > kickRange) return false;

        const dx = ball.x - this.x;
        const dy = ball.y - this.y;
        const n = Physics.normalize(dx, dy);
        // Low charge = moderate, high charge = strong
        const minForce = this.getKickForce() * 0.6;
        const maxForce = Physics.POWER_KICK_FORCE;
        const curve = Math.min(chargeRatio, 1);
        const force = minForce + (maxForce - minForce) * curve;

        ball.vx = n.x * force + this.vx * 0.3;
        ball.vy = n.y * force + this.vy * 0.3;

        // Recoil: kicker gets pushed back (stronger with more charge)
        const recoilForce = 2 + chargeRatio * 5;
        this.vx = -n.x * recoilForce;
        this.vy = -n.y * recoilForce;

        // Super kick at high charge — auto-aim toward enemy goal
        if (chargeRatio > 0.8) {
            ball.superKick = 1.0;
            // Store target: enemy goal center (red attacks right, blue attacks left)
            ball.superTarget = this.team === 'red' ? 'right' : 'left';
        } else {
            ball.superKick = 0;
            ball.superTarget = null;
        }

        // Ball spin/curve: calculate cross product between kick direction and player movement
        // This applies to ALL players; curve power-up doubles the effect
        const perpX = -n.y;
        const perpY = n.x;
        const movePerp = this.vx * perpX + this.vy * perpY;
        const spinMultiplier = this.powerUp === 'curve' ? 0.5 : 0.25;
        ball.vx += perpX * movePerp * spinMultiplier;
        ball.vy += perpY * movePerp * spinMultiplier;

        // Apply spin to ball for continuous curving in flight
        ball.spin = movePerp * (this.powerUp === 'curve' ? 0.5 : 0.25);

        this.kickCooldown = 250;
        this.kicks++;
        ball.lastKickedBy = this;
        return true;
    }

    tackle(ball) {
        if (this.tackleCooldown > 0 || this.isTackling || this.tackleRecoveryTimer > 0) return false;

        const dist = Physics.distance(this, ball);
        if (dist > 100) return false;

        // Lunge toward the ball
        const dx = ball.x - this.x;
        const dy = ball.y - this.y;
        const n = Physics.normalize(dx, dy);

        this.vx = n.x * Physics.DASH_FORCE * 1.2;
        this.vy = n.y * Physics.DASH_FORCE * 1.2;

        this.isTackling = true;
        this.tackleTimer = 200;
        this.tackleCooldown = 2000;
        this.tackleDirX = n.x;
        this.tackleDirY = n.y;

        return true;
    }
}

class Ball {
    constructor(x, y) {
        this.x = x;
        this.y = y;
        this.spawnX = x;
        this.spawnY = y;
        this.vx = 0;
        this.vy = 0;
        this.radius = 14;
        this.mass = 0.5;
        this.lastKickedBy = null;
        this.trail = [];
        this.spin = 0;
        this.superKick = 0;
        this.superTarget = null;
    }

    reset() {
        this.x = this.spawnX;
        this.y = this.spawnY;
        this.vx = 0;
        this.vy = 0;
        this.lastKickedBy = null;
        this.trail = [];
        this.spin = 0;
        this.superKick = 0;
        this.superTarget = null;
    }

    update(dt) {
        this.vx *= Physics.BALL_FRICTION;
        this.vy *= Physics.BALL_FRICTION;

        // Apply spin as a lateral force perpendicular to ball movement direction
        if (Math.abs(this.spin) > 0.01) {
            const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
            if (speed > 0.5) {
                const dirX = this.vx / speed;
                const dirY = this.vy / speed;
                // Perpendicular to movement direction
                const perpX = -dirY;
                const perpY = dirX;
                this.vx += perpX * this.spin * 0.1;
                this.vy += perpY * this.spin * 0.1;
            }
            // Decay spin
            this.spin *= 0.97;
        }

        Physics.clampSpeed(this, Physics.MAX_BALL_SPEED);

        this.x += this.vx;
        this.y += this.vy;

        // Trail effect — more particles during super kick
        const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (this.superKick > 0 && speed > 1) {
            // Dense fire trail
            this.trail.push({ x: this.x, y: this.y, life: 1.0 });
            this.trail.push({ x: this.x + (Math.random() - 0.5) * 6, y: this.y + (Math.random() - 0.5) * 6, life: 0.8 });
        } else if (speed > 3) {
            this.trail.push({ x: this.x, y: this.y, life: 1.0 });
        }
        // Decay trail
        const decayRate = this.superKick > 0 ? 0.03 : 0.05;
        for (let i = this.trail.length - 1; i >= 0; i--) {
            this.trail[i].life -= decayRate;
            if (this.trail[i].life <= 0) this.trail.splice(i, 1);
        }
    }
}

class Field {
    constructor(canvasWidth, canvasHeight, mapType = 'classic') {
        this.mapType = mapType;
        this.update(canvasWidth, canvasHeight);
    }

    update(canvasWidth, canvasHeight) {
        const padding = 30;
        let widthRatio, heightRatio;

        switch (this.mapType) {
            case 'big':
                widthRatio = 0.92;
                heightRatio = 0.82;
                break;
            case 'futsal':
                widthRatio = 0.78;
                heightRatio = 0.65;
                break;
            default: // classic
                widthRatio = 0.85;
                heightRatio = 0.75;
        }

        this.width = canvasWidth * widthRatio;
        this.height = canvasHeight * heightRatio;
        this.x = (canvasWidth - this.width) / 2;
        this.y = (canvasHeight - this.height) / 2 - 20;

        this.goalHeight = this.height * 0.38;
        this.goalY = this.y + (this.height - this.goalHeight) / 2;
        this.goalDepth = 85;

        this.centerX = this.x + this.width / 2;
        this.centerY = this.y + this.height / 2;
        this.centerRadius = Math.min(this.width, this.height) * 0.15;

        // Penalty area dimensions
        this.penaltyWidth = this.width * 0.15;
        this.penaltyHeight = this.height * 0.5;
        this.penaltyY = this.y + (this.height - this.penaltyHeight) / 2;
    }
}
