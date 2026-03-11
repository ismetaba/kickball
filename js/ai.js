// AI controller for computer-controlled players
class AIController {
    constructor(difficulty = 'medium') {
        this.setDifficulty(difficulty);
        this.targetX = 0;
        this.targetY = 0;
        this.decisionTimer = 0;
        this.role = 'attack'; // attack, defend, support
    }

    setDifficulty(difficulty) {
        switch (difficulty) {
            case 'easy':
                this.reactionTime = 400;
                this.accuracy = 0.5;
                this.aggressiveness = 0.3;
                this.kickRange = 0.7;
                this.positioningSkill = 0.4;
                break;
            case 'hard':
                this.reactionTime = 100;
                this.accuracy = 0.95;
                this.aggressiveness = 0.8;
                this.kickRange = 1.0;
                this.positioningSkill = 0.9;
                break;
            default: // medium
                this.reactionTime = 200;
                this.accuracy = 0.75;
                this.aggressiveness = 0.55;
                this.kickRange = 0.85;
                this.positioningSkill = 0.65;
        }
    }

    update(player, ball, field, teammates, opponents, dt) {
        this.decisionTimer -= dt;

        if (this.decisionTimer > 0) {
            this.moveToTarget(player);
            return { kick: false, dash: false };
        }

        this.decisionTimer = this.reactionTime + Math.random() * 200;

        // Assign roles based on position
        this.assignRole(player, ball, field, teammates);

        let kick = false;
        let dash = false;

        const distToBall = Physics.distance(player, ball);
        const kickDist = (player.radius + ball.radius + 8) * this.kickRange;
        const isOnOurSide = player.team === 'red'
            ? ball.x < field.centerX
            : ball.x > field.centerX;

        switch (this.role) {
            case 'attack':
                this.playAttack(player, ball, field, opponents, distToBall);
                break;
            case 'defend':
                this.playDefend(player, ball, field, distToBall);
                break;
            case 'support':
                this.playSupport(player, ball, field, teammates, distToBall);
                break;
        }

        // Kick logic
        if (distToBall < kickDist) {
            const goalX = player.team === 'red' ? field.x + field.width : field.x;
            const goalY = field.goalY + field.goalHeight / 2;
            const dx = goalX - ball.x;
            const dy = goalY - ball.y;
            const distToGoal = Math.sqrt(dx * dx + dy * dy);

            // Kick towards goal if facing it, or pass
            if (distToGoal < field.width * 0.6 || Math.random() < this.aggressiveness) {
                // Hesitation: sometimes AI doesn't kick even when in range
                if (Math.random() < this.accuracy) {
                    kick = true;
                }

                // Add inaccuracy
                const inaccuracy = (1 - this.accuracy) * 40;
                this.targetX = goalX + (Math.random() - 0.5) * inaccuracy;
                this.targetY = goalY + (Math.random() - 0.5) * inaccuracy;
            } else if (Math.random() < 0.3) {
                kick = true; // Clear ball
            }
        }

        // Dash to reach ball if close
        if (distToBall < 100 && distToBall > 40 && Math.random() < this.aggressiveness * 0.3) {
            dash = true;
        }

        this.moveToTarget(player);
        return { kick, dash };
    }

    assignRole(player, ball, field, teammates) {
        if (teammates.length === 0) {
            this.role = 'attack';
            return;
        }

        // Find closest teammate to ball
        let closestDist = Physics.distance(player, ball);
        let isClosest = true;

        for (const t of teammates) {
            if (t === player) continue;
            const d = Physics.distance(t, ball);
            if (d < closestDist) {
                isClosest = false;
                break;
            }
        }

        const isOnDefensiveSide = player.team === 'red'
            ? player.x < field.centerX
            : player.x > field.centerX;

        if (isClosest) {
            this.role = 'attack';
        } else if (isOnDefensiveSide) {
            this.role = 'defend';
        } else {
            this.role = 'support';
        }
    }

    playAttack(player, ball, field, opponents, distToBall) {
        // Move towards ball
        const interceptX = ball.x + ball.vx * 5;
        const interceptY = ball.y + ball.vy * 5;

        if (distToBall > 30) {
            this.targetX = interceptX;
            this.targetY = interceptY;
        } else {
            // Position between ball and opponent goal
            const goalX = player.team === 'red' ? field.x + field.width : field.x;
            const goalY = field.goalY + field.goalHeight / 2;
            const dirX = goalX - ball.x;
            const dirY = goalY - ball.y;
            const n = Physics.normalize(dirX, dirY);
            this.targetX = ball.x - n.x * 20;
            this.targetY = ball.y - n.y * 20;
        }
    }

    playDefend(player, ball, field, distToBall) {
        // Position between ball and our goal
        const goalX = player.team === 'red' ? field.x : field.x + field.width;
        const goalY = field.centerY;

        let defX = goalX + (ball.x - goalX) * 0.3 * this.positioningSkill;
        let defY = goalY + (ball.y - goalY) * 0.5 * this.positioningSkill;

        // Occasional mispositioning: drift from ideal position
        const wobble = (1 - this.positioningSkill) * 0.5;
        if (Math.random() < wobble) {
            defY += (Math.random() - 0.5) * field.height * 0.2;
        }

        this.targetX = defX;
        this.targetY = defY;

        // Rush ball if it's close
        if (distToBall < 100) {
            this.targetX = ball.x + ball.vx * 3;
            this.targetY = ball.y + ball.vy * 3;
        }
    }

    playSupport(player, ball, field, teammates, distToBall) {
        // Position for a pass
        const goalX = player.team === 'red' ? field.x + field.width : field.x;
        const offsetY = (Math.random() - 0.5) * field.height * 0.4;

        this.targetX = ball.x + (goalX - ball.x) * 0.3;
        this.targetY = field.centerY + offsetY;

        // Stay within field
        this.targetX = Math.max(field.x + 30, Math.min(field.x + field.width - 30, this.targetX));
        this.targetY = Math.max(field.y + 30, Math.min(field.y + field.height - 30, this.targetY));
    }

    moveToTarget(player) {
        const dx = this.targetX - player.x;
        const dy = this.targetY - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 5) {
            const n = Physics.normalize(dx, dy);
            const speed = Math.min(dist / 30, 1);
            player.applyInput(n.x * speed, n.y * speed);
        }
    }
}

// Goalkeeper AI controller
class GoalkeeperAI {
    constructor(difficulty = 'medium') {
        this.setDifficulty(difficulty);
        this.smoothY = 0; // smoothed ball Y tracking
        this.initialized = false;
    }

    setDifficulty(difficulty) {
        switch (difficulty) {
            case 'easy':
                this.reflexSpeed = 0.03;
                this.diveSpeed = 0.6;
                this.rushDistance = 0.6;
                this.mistakeChance = 0.12;
                break;
            case 'hard':
                this.reflexSpeed = 0.09;
                this.diveSpeed = 1.0;
                this.rushDistance = 1.0;
                this.mistakeChance = 0.02;
                break;
            default: // medium
                this.reflexSpeed = 0.06;
                this.diveSpeed = 0.8;
                this.rushDistance = 0.8;
                this.mistakeChance = 0.06;
        }
    }

    update(player, ball, field, teammates, opponents, dt) {
        // Initialize smoothY to goal center on first call
        if (!this.initialized) {
            this.smoothY = field.centerY;
            this.initialized = true;
        }

        const isRed = player.team === 'red';

        // Our goal line X position
        const goalLineX = isRed ? field.x : field.x + field.width;
        // Keeper base X: 15% from our goal line into the field
        const baseX = isRed
            ? field.x + field.width * 0.15
            : field.x + field.width * 0.85;

        const goalCenterY = field.goalY + field.goalHeight / 2;
        const goalTop = field.goalY;
        const goalBottom = field.goalY + field.goalHeight;

        // Penalty area boundaries
        const penaltyLeft = isRed
            ? field.x
            : field.x + field.width - field.penaltyWidth;
        const penaltyRight = isRed
            ? field.x + field.penaltyWidth
            : field.x + field.width;
        const penaltyTop = field.penaltyY;
        const penaltyBottom = field.penaltyY + field.penaltyHeight;

        // Compute ball distance to our goal line
        const ballDistToGoal = Math.abs(ball.x - goalLineX);

        // Is ball heading toward our goal?
        const ballMovingTowardGoal = isRed
            ? ball.vx < -1
            : ball.vx > 1;

        const ballSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);

        // Smooth tracking of ball Y (with reflex speed)
        const trackingSpeed = this.reflexSpeed;
        this.smoothY += (ball.y - this.smoothY) * trackingSpeed;

        // Goalkeeper mistake: occasionally misjudge position
        if (Math.random() < this.mistakeChance) {
            this.smoothY += (Math.random() - 0.5) * field.goalHeight * 0.3;
        }

        // Clamp smoothY to goal area
        const clampedY = Math.max(goalTop + player.radius, Math.min(goalBottom - player.radius, this.smoothY));

        let targetX = baseX;
        let targetY = clampedY;

        let kick = false;
        let dash = false;

        // Rush out when ball is in penalty area
        const ballInPenaltyX = isRed
            ? ball.x < penaltyRight
            : ball.x > penaltyLeft;
        const ballInPenaltyY = ball.y > penaltyTop && ball.y < penaltyBottom;

        if (ballInPenaltyX && ballInPenaltyY && ballDistToGoal < field.penaltyWidth * 1.2) {
            // Rush toward ball but don't go past penalty area edge
            const rushX = isRed
                ? Math.min(ball.x - 20, penaltyRight - player.radius)
                : Math.max(ball.x + 20, penaltyLeft + player.radius);
            targetX = rushX * this.rushDistance + baseX * (1 - this.rushDistance);
            targetY = ball.y;
        }

        // Dive logic: ball is fast and heading toward goal
        if (ballMovingTowardGoal && ballSpeed > 6 && ballDistToGoal < field.width * 0.35) {
            // Predict where ball will cross the goal line
            const timeToGoal = ballDistToGoal / Math.abs(ball.vx);
            const predictedY = ball.y + ball.vy * timeToGoal;

            // If predicted Y is within goal area, dive there
            if (predictedY > goalTop - 20 && predictedY < goalBottom + 20) {
                const diveTargetY = Math.max(goalTop + player.radius, Math.min(goalBottom - player.radius, predictedY));
                targetY = diveTargetY;

                // Move closer to goal line for the save
                const saveX = isRed
                    ? field.x + field.width * 0.08
                    : field.x + field.width * 0.92;
                targetX = saveX;

                // Dash to dive if the ball is really close and fast
                if (ballDistToGoal < field.width * 0.2 && ballSpeed > 8) {
                    const distToTarget = Math.abs(player.y - diveTargetY);
                    if (distToTarget > 30) {
                        dash = true;
                    }
                }
            }
        }

        // When ball is far away, return to center of goal
        if (ballDistToGoal > field.width * 0.55) {
            targetX = baseX;
            targetY = goalCenterY;
        }

        // Clamp target within penalty area
        if (isRed) {
            targetX = Math.max(field.x + player.radius, Math.min(penaltyRight - player.radius, targetX));
        } else {
            targetX = Math.max(penaltyLeft + player.radius, Math.min(field.x + field.width - player.radius, targetX));
        }
        targetY = Math.max(field.y + player.radius, Math.min(field.y + field.height - player.radius, targetY));

        // Move toward target
        const dx = targetX - player.x;
        const dy = targetY - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 3) {
            const n = Physics.normalize(dx, dy);
            const speed = Math.min(dist / 15, 1); // Faster response than field players
            player.applyInput(n.x * speed, n.y * speed);
        }

        // Kick ball away if close enough
        const distToBall = Physics.distance(player, ball);
        const kickRange = player.radius + ball.radius + 10;
        if (distToBall < kickRange) {
            kick = true;
        }

        return { kick, dash };
    }
}
