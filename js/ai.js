// AI controller for computer-controlled players
class AIController {
    constructor(difficulty = 'normal') {
        this.setDifficulty(difficulty);
        this.targetX = 0;
        this.targetY = 0;
        this.decisionTimer = 0;
        this.role = 'attack'; // attack, defend, support
        this.aimX = 0;
        this.aimY = 0;
    }

    setDifficulty(difficulty) {
        // Normal is the only rule-based difficulty
        this.reactionTime = 40;
        this.reactionJitter = 30;
        this.accuracy = 1.0;
        this.aggressiveness = 0.92;
        this.kickRange = 1.0;
        this.positioningSkill = 1.0;
        this.interceptFrames = 12;
        this.aimThreshold = 0.35;
        this.moveDiv = 16;
    }

    // Predict ball position using physics-accurate friction decay
    predictBall(ball, frames) {
        let x = ball.x, y = ball.y;
        let vx = ball.vx, vy = ball.vy;
        for (let i = 0; i < frames; i++) {
            vx *= Physics.BALL_FRICTION;
            vy *= Physics.BALL_FRICTION;
            x += vx;
            y += vy;
        }
        return { x, y };
    }

    // Check if kick direction roughly matches desired target direction
    isAimedAt(player, ball, tx, ty) {
        const kx = ball.x - player.x;
        const ky = ball.y - player.y;
        const dx = tx - ball.x;
        const dy = ty - ball.y;
        const m1 = Math.sqrt(kx * kx + ky * ky);
        const m2 = Math.sqrt(dx * dx + dy * dy);
        if (m1 < 1 || m2 < 1) return true;
        return (kx * dx + ky * dy) / (m1 * m2) > this.aimThreshold;
    }

    // SAFETY: Check if kicking from current position would send ball toward OWN goal
    wouldKickTowardOwnGoal(player, ball, field) {
        // Simulate actual kick direction: normalize(ball-player) * force + player.vx * 0.3
        const kx = ball.x - player.x;
        const ky = ball.y - player.y;
        const len = Math.sqrt(kx * kx + ky * ky);
        if (len < 1) return false;
        // Use minimum kick force (7.8) as conservative estimate
        const nx = kx / len;
        const ny = ky / len;
        const resultVx = nx * 7.8 + player.vx * 0.3;
        const resultVy = ny * 7.8 + player.vy * 0.3;

        // Check X direction: toward own goal?
        const towardOwnGoalX = player.team === 'red' ? resultVx < 0 : resultVx > 0;
        if (!towardOwnGoalX) return false;

        // Ball heading toward own goal on X — now check if it would enter goal area on Y
        const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
        const distToGoalX = Math.abs(ball.x - ownGoalX);
        // Only dangerous if ball is within half the field of own goal
        if (distToGoalX > field.width * 0.6) return false;

        // Predict where ball would arrive at goal line Y
        if (Math.abs(resultVx) < 0.5) return true; // Slow but going backward = dangerous
        const timeToGoal = distToGoalX / Math.abs(resultVx);
        const predictedY = ball.y + resultVy * timeToGoal;

        // If predicted Y is anywhere near the goal area, it's dangerous
        const goalMargin = 40; // Extra margin for safety
        const goalTop = field.goalY - goalMargin;
        const goalBottom = field.goalY + field.goalHeight + goalMargin;

        if (predictedY > goalTop && predictedY < goalBottom) return true;

        return false;
    }

    update(player, ball, field, teammates, opponents, dt) {
        this.decisionTimer -= dt;

        if (this.decisionTimer > 0) {
            this.moveToTarget(player);
            return { kick: false, dash: false, tackle: false, chargeRatio: 0.3 };
        }

        this.decisionTimer = this.reactionTime + Math.random() * this.reactionJitter;

        // Assign role based on team dynamics
        this.assignRole(player, ball, field, teammates, opponents);

        let kick = false;
        let dash = false;
        let tackle = false;
        let chargeRatio = 0.3;

        const distToBall = Physics.distance(player, ball);
        const kickDist = (player.radius + ball.radius + 8) * this.kickRange;
        const predicted = this.predictBall(ball, this.interceptFrames);

        // Execute role-specific positioning
        switch (this.role) {
            case 'attack':
                this.playAttack(player, ball, field, teammates, opponents, distToBall, predicted);
                break;
            case 'defend':
                this.playDefend(player, ball, field, teammates, opponents, distToBall, predicted);
                break;
            case 'support':
                this.playSupport(player, ball, field, teammates, opponents);
                break;
        }

        // Kick decision: only when in range
        if (distToBall < kickDist) {
            const result = this.decideKick(player, ball, field, teammates, opponents);
            kick = result.kick;
            chargeRatio = result.chargeRatio;
        }

        // Tackle: lunge at opponent who controls the ball
        if (!kick && distToBall > kickDist && distToBall < 90 && player.tackleCooldown <= 0) {
            const oppNearBall = this.nearestTo(ball, opponents);
            if (oppNearBall && Physics.distance(oppNearBall, ball) < 35) {
                if (Math.random() < this.aggressiveness * 0.5) {
                    tackle = true;
                }
            }
        }

        // Dash: sprint toward ball strategically
        if (!kick && !tackle && player.dashCooldown <= 0) {
            // Attacker: dash to reach ball first
            if (this.role === 'attack' && distToBall > 50 && distToBall < 150) {
                if (Math.random() < this.aggressiveness * 0.35) dash = true;
            }
            // Defender: dash to intercept incoming ball
            if (this.role === 'defend' && distToBall < 100 && distToBall > 40) {
                const ballComingOurWay = player.team === 'red' ? ball.vx < -2 : ball.vx > 2;
                if (ballComingOurWay && Math.random() < this.aggressiveness * 0.4) dash = true;
            }
        }

        this.moveToTarget(player);
        return { kick, dash, tackle, chargeRatio };
    }

    assignRole(player, ball, field, teammates, opponents) {
        if (teammates.length <= 1) {
            this.role = 'attack';
            return;
        }

        const dist = Physics.distance(player, ball);
        // Rank by distance to ball (0 = closest)
        let rank = 0;
        for (const t of teammates) {
            if (t === player) continue;
            if (Physics.distance(t, ball) < dist) rank++;
        }

        const ballOnOurSide = player.team === 'red'
            ? ball.x < field.centerX
            : ball.x > field.centerX;

        // Hysteresis: only switch roles if distance difference is significant
        // This prevents jittery role-swapping when two players are equidistant
        const prevRole = this.role;
        let newRole;

        if (rank === 0) {
            newRole = 'attack';
        } else if (ballOnOurSide) {
            newRole = 'defend';
        } else {
            newRole = 'support';
        }

        // Add hysteresis for attack ↔ other transitions
        if (prevRole === 'attack' && newRole !== 'attack') {
            // Only give up attack role if clearly NOT the closest
            let closestDist = Infinity;
            for (const t of teammates) {
                if (t === player) continue;
                const td = Physics.distance(t, ball);
                if (td < closestDist) closestDist = td;
            }
            // Stay as attacker if within 20% of closest teammate's distance
            if (dist < closestDist * 1.2) {
                newRole = 'attack';
            }
        }

        this.role = newRole;
    }

    playAttack(player, ball, field, teammates, opponents, distToBall, predicted) {
        if (distToBall > 35) {
            // Intercept: go to predicted ball position
            // But approach from the correct side to avoid own-goal deflections
            const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
            const playerToOwnGoal = Math.abs(player.x - ownGoalX);
            const ballToOwnGoal = Math.abs(predicted.x - ownGoalX);

            // Check if ball is moving fast toward our goal — if so, approach from the side
            const ballSpeedTowardGoal = player.team === 'red' ? -ball.vx : ball.vx;
            const ballMovingTowardOwnGoal = ballSpeedTowardGoal > 3;

            if (ballMovingTowardOwnGoal && distToBall < 100) {
                // Ball coming toward our goal — approach from the SIDE to redirect, not head-on
                const sideOffset = player.y > predicted.y ? 30 : -30;
                const awayFromGoal = player.team === 'red' ? 15 : -15;
                this.targetX = predicted.x + awayFromGoal;
                this.targetY = predicted.y + sideOffset;
            } else if (playerToOwnGoal > ballToOwnGoal && distToBall < 80) {
                // We're on the wrong side (ball between us and own goal) and close
                // Approach from goal-side to avoid pushing ball toward own goal
                const goalSideOffset = player.team === 'red' ? -25 : 25;
                this.targetX = predicted.x + goalSideOffset;
                this.targetY = predicted.y;
            } else {
                this.targetX = predicted.x;
                this.targetY = predicted.y;
            }
        } else {
            // Close to ball: position behind it to aim at best target
            const target = this.chooseBestTarget(player, ball, field, teammates, opponents);
            this.aimX = target.x;
            this.aimY = target.y;

            // Position on opposite side of ball from target
            const dx = target.x - ball.x;
            const dy = target.y - ball.y;
            const n = Physics.normalize(dx, dy);
            this.targetX = ball.x - n.x * 22;
            this.targetY = ball.y - n.y * 22;
        }
    }

    playDefend(player, ball, field, teammates, opponents, distToBall, predicted) {
        const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
        const goalCenterY = field.goalY + field.goalHeight / 2;
        const ballOnOurSide = player.team === 'red'
            ? ball.x < field.centerX
            : ball.x > field.centerX;

        // Check if ball is moving fast toward our goal — if so, get OUT of the shooting lane
        const ballSpeedTowardGoal = player.team === 'red' ? -ball.vx : ball.vx;
        const ballMovingFastTowardGoal = ballSpeedTowardGoal > 3;
        const inShootingLane = Math.abs(player.y - ball.y) < 40
            && ((player.team === 'red' && player.x < ball.x) || (player.team === 'blue' && player.x > ball.x));

        if (ballMovingFastTowardGoal && inShootingLane && distToBall < 120) {
            // CRITICAL: Get out of the way — move laterally to avoid deflecting ball into own goal
            const sideDir = player.y < ball.y ? -1 : 1;
            // If player is very close to ball Y, pick a side based on goal center
            if (Math.abs(player.y - ball.y) < 15) {
                const sideDirFromGoal = player.y < goalCenterY ? -1 : 1;
                this.targetY = ball.y + sideDirFromGoal * 50;
            } else {
                this.targetY = ball.y + sideDir * 50;
            }
            this.targetX = player.x; // Don't change X, just dodge sideways
        } else if (distToBall < 55 && ballOnOurSide) {
            // Close AND ball is in our half: engage carefully from goal side
            const playerToOwnGoal = Math.abs(player.x - ownGoalX);
            const ballToOwnGoal = Math.abs(predicted.x - ownGoalX);

            if (playerToOwnGoal < ballToOwnGoal) {
                // Already on goal side — safe to approach ball directly
                this.targetX = predicted.x;
                this.targetY = predicted.y;
            } else {
                // On wrong side — approach from the side (not directly in front)
                // This avoids standing in the shooting lane and causing deflection own goals
                const sideOffset = (player.y > ball.y) ? 35 : -35;
                const goalSideOffset = player.team === 'red' ? -25 : 25;
                this.targetX = predicted.x + goalSideOffset;
                this.targetY = predicted.y + sideOffset;
            }
        } else {
            // Hold defensive position between ball and our goal — mark space, not shot-block
            const t = 0.35 * this.positioningSkill;
            this.targetX = ownGoalX + (ball.x - ownGoalX) * t;

            // Track ball Y but stay centered — don't drift to extremes
            // OFFSET from direct ball-to-goal line to avoid deflections
            const directLineY = ball.y;
            const offsetDir = player.y > goalCenterY ? 1 : -1;
            this.targetY = field.centerY + (directLineY - field.centerY) * 0.45 * this.positioningSkill + offsetDir * 20;

            // Stay well in defensive half — create clear separation from attacker
            if (player.team === 'red') {
                this.targetX = Math.min(this.targetX, field.centerX - field.width * 0.08);
            } else {
                this.targetX = Math.max(this.targetX, field.centerX + field.width * 0.08);
            }
        }
        this.clampTarget(field);
    }

    playSupport(player, ball, field, teammates, opponents) {
        const goalX = player.team === 'red' ? field.x + field.width : field.x;

        // Position WELL ahead of the ball toward opponent's goal — create width & passing option
        // Use 50% between ball and goal (not 30%) for much wider spread
        const midX = ball.x + (goalX - ball.x) * 0.5;

        // Ensure minimum distance from ball to prevent clustering
        const minDistFromBall = field.width * 0.2;
        const distFromBall = Math.abs(midX - ball.x);
        let targetX = midX;
        if (distFromBall < minDistFromBall) {
            targetX = player.team === 'red'
                ? ball.x + minDistFromBall
                : ball.x - minDistFromBall;
        }

        // Find vertical position with most space from opponents AND teammates
        // Use wider vertical slots for better spread
        const slots = [
            field.y + field.height * 0.2,
            field.centerY - field.height * 0.15,
            field.centerY + field.height * 0.15,
            field.y + field.height * 0.8,
        ];

        let bestY = field.centerY;
        let bestOpen = -1;
        for (const sy of slots) {
            let minDist = Infinity;
            // Consider distance from opponents AND other teammates
            for (const o of opponents) {
                const d = Math.sqrt((targetX - o.x) ** 2 + (sy - o.y) ** 2);
                if (d < minDist) minDist = d;
            }
            for (const t of teammates) {
                if (t === player) continue;
                const d = Math.sqrt((targetX - t.x) ** 2 + (sy - t.y) ** 2);
                if (d < minDist) minDist = d;
            }
            if (minDist > bestOpen) {
                bestOpen = minDist;
                bestY = sy;
            }
        }

        // Also offset Y from ball to prevent vertical clustering
        if (Math.abs(bestY - ball.y) < field.height * 0.15) {
            bestY = ball.y > field.centerY
                ? ball.y - field.height * 0.2
                : ball.y + field.height * 0.2;
        }

        this.targetX = targetX;
        this.targetY = bestY;
        this.clampTarget(field);
    }

    // Decide best target: shoot at goal or pass to teammate
    chooseBestTarget(player, ball, field, teammates, opponents) {
        const goalX = player.team === 'red' ? field.x + field.width : field.x;
        const goalCenterY = field.goalY + field.goalHeight / 2;
        const distToGoal = Math.sqrt((goalX - ball.x) ** 2 + (goalCenterY - ball.y) ** 2);

        // In shooting range: aim at goal
        if (distToGoal < field.width * 0.55) {
            return { x: goalX, y: this.bestGoalSpot(opponents, field) };
        }

        // Otherwise look for a pass
        const pass = this.findPassTarget(player, ball, field, teammates, opponents);
        if (pass) return { x: pass.x, y: pass.y };

        // Default: aim at goal
        return { x: goalX, y: this.bestGoalSpot(opponents, field) };
    }

    // Smart kick decision when in range
    // Key principle: only kick when properly aimed. Let physics collision handle dribbling.
    decideKick(player, ball, field, teammates, opponents) {
        const goalX = player.team === 'red' ? field.x + field.width : field.x;
        const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
        const goalCenterY = field.goalY + field.goalHeight / 2;
        const distToGoal = Math.sqrt((goalX - ball.x) ** 2 + (goalCenterY - ball.y) ** 2);
        const distToOwnGoal = Math.abs(ball.x - ownGoalX);

        // 1) SHOOT at goal — always try when aimed at goal (and won't own-goal)
        const spotY = this.bestGoalSpot(opponents, field);
        if (this.isAimedAt(player, ball, goalX, spotY) && !this.wouldKickTowardOwnGoal(player, ball, field)) {
            // Power based on distance: closer = harder shot
            let charge = 0.25;
            if (distToGoal < field.width * 0.5) charge = 0.4;
            if (distToGoal < field.width * 0.35) charge = 0.55;
            if (distToGoal < field.width * 0.2) charge = 0.75;
            if (distToGoal < field.width * 0.12) charge = 0.9;

            if (Math.random() < this.accuracy) {
                return { kick: true, chargeRatio: charge };
            }
        }

        // 2) PASS to open teammate if aimed (and won't own-goal)
        const pass = this.findPassTarget(player, ball, field, teammates, opponents);
        if (pass && this.isAimedAt(player, ball, pass.x, pass.y) && !this.wouldKickTowardOwnGoal(player, ball, field)) {
            const passDist = Physics.distance(player, pass);
            const charge = Math.min(0.15 + passDist / (field.width * 2), 0.45);
            if (Math.random() < this.accuracy * 0.85) {
                return { kick: true, chargeRatio: charge };
            }
        }

        // 3) EMERGENCY CLEAR: ball dangerously close to our own goal
        //    ONLY clear if kick direction goes AWAY from our goal (prevents own goals)
        if (distToOwnGoal < field.width * 0.15 && !this.wouldKickTowardOwnGoal(player, ball, field)) {
            return { kick: true, chargeRatio: 0.6 };
        }

        // 4) Aimed kick forward: on our side and aimed at goal — advance the ball
        if (distToOwnGoal < field.width * 0.5 && this.isAimedAt(player, ball, goalX, goalCenterY)
            && !this.wouldKickTowardOwnGoal(player, ball, field)) {
            return { kick: true, chargeRatio: 0.3 };
        }

        // Don't kick — let collision physics dribble the ball, keep positioning
        return { kick: false, chargeRatio: 0.3 };
    }

    // Find best spot in goal to aim at
    bestGoalSpot(opponents, field) {
        const goalTop = field.goalY + 12;
        const goalBottom = field.goalY + field.goalHeight - 12;

        // Inaccuracy for lower difficulties
        const jitter = (1 - this.accuracy) * 30 * (Math.random() - 0.5);

        // Aim for a random corner
        if (Math.random() < 0.5) {
            return Math.min(goalBottom + jitter, goalBottom);
        } else {
            return Math.max(goalTop + jitter, goalTop);
        }
    }

    // Find best teammate to pass to
    findPassTarget(player, ball, field, teammates, opponents) {
        const goalX = player.team === 'red' ? field.x + field.width : field.x;
        let best = null;
        let bestScore = -Infinity;

        for (const t of teammates) {
            if (t === player) continue;

            const distToGoal = Math.abs(goalX - t.x);
            const isAhead = player.team === 'red' ? t.x > ball.x + 20 : t.x < ball.x - 20;
            const openness = this.getOpenness(t, opponents);
            const passDist = Physics.distance(player, t);

            // Skip targets too close or too far
            if (passDist < 50 || passDist > field.width * 0.7) continue;
            // Skip if pass lane is blocked
            if (!this.isLaneClear(ball, t, opponents)) continue;

            let score = (field.width - distToGoal) / field.width * 1.5;
            score += openness * 0.8;
            if (isAhead) score += 1.2;

            if (score > bestScore) { bestScore = score; best = t; }
        }

        return bestScore > 2.0 ? best : null;
    }

    // Check if passing lane between two points is free of opponents
    isLaneClear(from, to, opponents) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) return true;
        const nx = dx / dist;
        const ny = dy / dist;

        for (const o of opponents) {
            const ox = o.x - from.x;
            const oy = o.y - from.y;
            const proj = ox * nx + oy * ny;
            if (proj < 0 || proj > dist) continue;
            // Perpendicular distance to line
            if (Math.abs(ox * (-ny) + oy * nx) < 35) return false;
        }
        return true;
    }

    // How open is a player (distance to nearest opponent, normalized)
    getOpenness(player, opponents) {
        let min = Infinity;
        for (const o of opponents) {
            const d = Physics.distance(player, o);
            if (d < min) min = d;
        }
        return Math.min(min / 80, 2.0);
    }

    // Find entity nearest to a point
    nearestTo(point, entities) {
        let best = null, bestD = Infinity;
        for (const e of entities) {
            const d = Physics.distance(point, e);
            if (d < bestD) { bestD = d; best = e; }
        }
        return best;
    }

    clampTarget(field) {
        this.targetX = Math.max(field.x + 25, Math.min(field.x + field.width - 25, this.targetX));
        this.targetY = Math.max(field.y + 25, Math.min(field.y + field.height - 25, this.targetY));
    }

    moveToTarget(player) {
        const dx = this.targetX - player.x;
        const dy = this.targetY - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 3) {
            const n = Physics.normalize(dx, dy);
            const speed = Math.min(dist / this.moveDiv, 1);
            player.applyInput(n.x * speed, n.y * speed);
        }
    }
}

