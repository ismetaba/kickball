// Game entities: Player, Ball, Field

class Player {
    constructor(x, y, team, isHuman = false) {
        this.x = x;
        this.y = y;
        this.spawnX = x;
        this.spawnY = y;
        this.vx = 0;
        this.vy = 0;
        this.radius = 24;
        this.mass = 1;
        this.team = team; // 'red' or 'blue'
        this.isHuman = isHuman;
        this.kickCooldown = 0;
        this.powerUp = null;
        this.powerUpTimer = 0;
        this.goals = 0;
        this.assists = 0;
        this.kicks = 0;
        this.lastTouchedBall = false;
        this.kickChargeRatio = 0;
        this.stunTimer = 0;
        this.momentumBonus = 0;
        // Ball pull ability
        this.pullActive = false;
        this.pullCooldown = 0;
        this.pullDuration = 0;
        this.pullMaxDuration = 1000;  // 1s max pull time
        this.pullCooldownTime = 8000; // 8s cooldown
    }

    reset() {
        this.x = this.spawnX;
        this.y = this.spawnY;
        this.vx = 0;
        this.vy = 0;
        this.kickCooldown = 0;
        this.stunTimer = 0;
        this.pullActive = false;
        this.pullCooldown = 0;
        this.pullDuration = 0;
    }

    update(dt) {
        const s = Physics.dtRatio; // Frame-rate independent scale factor

        // Stunned: can't move, slide to a smooth stop
        if (this.stunTimer > 0) {
            this.stunTimer -= dt;
            const damping = Math.pow(0.997, dt);
            this.vx *= damping;
            this.vy *= damping;
            this.x += this.vx * s;
            this.y += this.vy * s;
            return;
        }

        if (this.kickCooldown > 0) this.kickCooldown -= dt;
        if (this.pullCooldown > 0) this.pullCooldown -= dt;

        // Pull duration countdown
        if (this.pullActive) {
            this.pullDuration -= dt;
            if (this.pullDuration <= 0) {
                this.pullActive = false;
                this.pullCooldown = this.pullCooldownTime;
            }
        }

        if (this.powerUpTimer > 0) {
            this.powerUpTimer -= dt;
            if (this.powerUpTimer <= 0) {
                if (this.powerUp === 'big') this.radius = 24;
                this.powerUp = null;
            }
        }

        // Apply friction (frame-rate independent)
        this.vx *= Math.pow(Physics.FRICTION, s);
        this.vy *= Math.pow(Physics.FRICTION, s);

        // Clamp speed
        const maxSpeed = this.getMaxSpeed();
        Physics.clampSpeed(this, maxSpeed);

        this.x += this.vx * s;
        this.y += this.vy * s;
    }

    getMaxSpeed() {
        let base = Physics.MAX_PLAYER_SPEED;
        if (this.powerUp === 'speed') base *= 1.5;
        if (this.momentumBonus) base *= (1 + this.momentumBonus * 0.15);
        return base;
    }

    getKickForce() {
        let base = Physics.KICK_FORCE;
        if (this.powerUp === 'power') base = Physics.POWER_KICK_FORCE;
        if (this.momentumBonus) base *= (1 + this.momentumBonus * 0.2);
        return base;
    }

    applyInput(inputX, inputY) {
        const accel = Physics.PLAYER_ACCELERATION * Physics.dtRatio;
        this.vx += inputX * accel;
        this.vy += inputY * accel;
    }

    activatePull() {
        if (this.pullCooldown > 0 || this.pullActive) return false;
        this.pullActive = true;
        this.pullDuration = this.pullMaxDuration;
        return true;
    }

    kick(ball, chargeRatio = 0) {
        if (this.kickCooldown > 0) return false;

        const dist = Physics.distance(this, ball);
        const kickRange = this.radius + ball.radius + 21;

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

        // Recoil: light taps keep momentum, charged kicks push back
        const recoilForce = chargeRatio * 3;
        this.vx = this.vx * (1 - chargeRatio * 0.7) - n.x * recoilForce;
        this.vy = this.vy * (1 - chargeRatio * 0.7) - n.y * recoilForce;

        // Super kick at high charge — auto-aim toward enemy goal + ignite
        if (chargeRatio > 0.8) {
            ball.superKick = 1.0;
            ball.superTarget = this.team === 'red' ? 'right' : 'left';
            ball.ignite(1);
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

        this.kickCooldown = 180;
        this.kicks++;
        ball.lastKickedBy = this;
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
        this.fireLevel = 0;
        this.fireDuration = 0;
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
        this.fireLevel = 0;
        this.fireDuration = 0;
    }

    ignite(level) {
        if (level > this.fireLevel) this.fireLevel = level;
        this.fireDuration = level >= 2 ? 4000 : 3000;
    }

    update(dt) {
        const s = Physics.dtRatio; // Frame-rate independent scale factor

        // Fire decay
        if (this.fireLevel > 0) {
            this.fireDuration -= dt;
            const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
            if (this.fireDuration <= 0 || speed < 5) {
                this.fireLevel = 0;
                this.fireDuration = 0;
            }
        }

        this.vx *= Math.pow(Physics.BALL_FRICTION, s);
        this.vy *= Math.pow(Physics.BALL_FRICTION, s);

        // Apply spin as a lateral force perpendicular to ball movement direction
        if (Math.abs(this.spin) > 0.01) {
            const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
            if (speed > 0.5) {
                const dirX = this.vx / speed;
                const dirY = this.vy / speed;
                const perpX = -dirY;
                const perpY = dirX;
                this.vx += perpX * this.spin * 0.1 * s;
                this.vy += perpY * this.spin * 0.1 * s;
            }
            this.spin *= Math.pow(0.97, s);
        }

        Physics.clampSpeed(this, Physics.MAX_BALL_SPEED);

        this.x += this.vx * s;
        this.y += this.vy * s;

        // Trail effect — flat array [x0,y0,x1,y1,...] for performance
        const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        const maxTrailLen = this.superKick > 0 ? 40 : 20; // max coordinate pairs (x2)
        if (this.superKick > 0 && speed > 1) {
            this.trail.push(this.x, this.y);
            this.trail.push(this.x + (Math.random() - 0.5) * 6, this.y + (Math.random() - 0.5) * 6);
        } else if (speed > 3) {
            this.trail.push(this.x, this.y);
        } else if (this.trail.length > 0) {
            // Ball slowed down — shrink trail so it fades away instead of freezing
            this.trail.shift();
            this.trail.shift();
        }
        // Trim old trail entries from front (FIFO)
        while (this.trail.length > maxTrailLen) {
            this.trail.shift();
            this.trail.shift();
        }
    }
}

class Field {
    constructor(canvasWidth, canvasHeight, mapType = 'classic') {
        this.mapType = mapType;
        this.update(canvasWidth, canvasHeight);
    }

    update(canvasWidth, canvasHeight) {
        this.canvasWidth = canvasWidth;
        this.canvasHeight = canvasHeight;
        const padding = 30;
        let widthRatio, heightRatio;

        // Map-specific physics modifiers (defaults)
        this.frictionMod = 1.0;     // Multiplier on ball friction
        this.bounceMod = 1.0;       // Multiplier on wall bounce
        this.playerFrictionMod = 1.0; // Multiplier on player friction

        switch (this.mapType) {
            case 'big':
                widthRatio = 0.92;
                heightRatio = 0.82;
                break;
            case 'futsal':
                widthRatio = 0.78;
                heightRatio = 0.65;
                break;
            case 'ice':
                widthRatio = 0.85;
                heightRatio = 0.75;
                this.frictionMod = 0.6;       // Very slippery
                this.playerFrictionMod = 0.5;  // Players slide more
                this.bounceMod = 1.3;          // Bouncier walls
                break;
            case 'volcano':
                widthRatio = 0.82;
                heightRatio = 0.72;
                this.frictionMod = 1.2;        // Slightly sticky
                this.bounceMod = 1.8;          // Super bouncy walls
                break;
            case 'neon':
                widthRatio = 0.72;
                heightRatio = 0.60;
                this.frictionMod = 0.85;       // Slightly slippery
                this.bounceMod = 1.2;          // Moderate bounce
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
