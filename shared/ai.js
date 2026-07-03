// AI controller for computer-controlled players (shared: browser + server)
(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        const Physics = require('./physics');
        module.exports = factory(Physics);
    } else {
        root.AIController = factory(root.Physics);
    }
})(typeof self !== 'undefined' ? self : this, function(Physics) {

class AIController {
    constructor(difficulty = 'normal') {
        this.setDifficulty(difficulty);
        this.targetX = 0;
        this.targetY = 0;
        this.decisionTimer = 0;
        this.role = 'attack';
        this.aimX = 0;
        this.aimY = 0;
    }

    setDifficulty(difficulty) {
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

    wouldKickTowardOwnGoal(player, ball, field) {
        const kx = ball.x - player.x;
        const ky = ball.y - player.y;
        const len = Math.sqrt(kx * kx + ky * ky);
        if (len < 1) return false;
        const nx = kx / len;
        const ny = ky / len;
        const resultVx = nx * 7.8 + player.vx * 0.3;
        const resultVy = ny * 7.8 + player.vy * 0.3;

        const towardOwnGoalX = player.team === 'red' ? resultVx < 0 : resultVx > 0;
        if (!towardOwnGoalX) return false;

        const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
        const distToGoalX = Math.abs(ball.x - ownGoalX);
        if (distToGoalX > field.width * 0.6) return false;

        if (Math.abs(resultVx) < 0.5) return true;
        const timeToGoal = distToGoalX / Math.abs(resultVx);
        const predictedY = ball.y + resultVy * timeToGoal;

        const goalMargin = 40;
        const goalTop = field.goalY - goalMargin;
        const goalBottom = field.goalY + field.goalHeight + goalMargin;

        if (predictedY > goalTop && predictedY < goalBottom) return true;

        return false;
    }

    // Lockstep multiplayer passes a shared seeded rng so AI decisions are
    // identical on every peer; offline/server callers omit it.
    _random() {
        return this._rng ? this._rng.next() : Math.random();
    }

    update(player, ball, field, teammates, opponents, dt, rng) {
        this._rng = rng || null;
        this.decisionTimer -= dt;

        if (this.decisionTimer > 0) {
            this.moveToTarget(player);
            return { kick: false, chargeRatio: 0.3 };
        }

        this.decisionTimer = this.reactionTime + this._random() * this.reactionJitter;

        this.assignRole(player, ball, field, teammates, opponents);

        let kick = false;
        let chargeRatio = 0.3;

        const distToBall = Physics.distance(player, ball);
        const kickDist = (player.radius + ball.radius + 8) * this.kickRange;
        const predicted = this.predictBall(ball, this.interceptFrames);

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

        if (distToBall < kickDist) {
            const result = this.decideKick(player, ball, field, teammates, opponents);
            kick = result.kick;
            chargeRatio = result.chargeRatio;
        }

        this.moveToTarget(player);
        return { kick, chargeRatio };
    }

    assignRole(player, ball, field, teammates, opponents) {
        if (teammates.length <= 1) {
            this.role = 'attack';
            return;
        }

        const dist = Physics.distance(player, ball);
        let rank = 0;
        for (const t of teammates) {
            if (t === player) continue;
            if (Physics.distance(t, ball) < dist) rank++;
        }

        const ballOnOurSide = player.team === 'red'
            ? ball.x < field.centerX
            : ball.x > field.centerX;

        const prevRole = this.role;
        let newRole;

        if (rank === 0) {
            newRole = 'attack';
        } else if (ballOnOurSide) {
            newRole = 'defend';
        } else {
            newRole = 'support';
        }

        if (prevRole === 'attack' && newRole !== 'attack') {
            let closestDist = Infinity;
            for (const t of teammates) {
                if (t === player) continue;
                const td = Physics.distance(t, ball);
                if (td < closestDist) closestDist = td;
            }
            if (dist < closestDist * 1.2) {
                newRole = 'attack';
            }
        }

        this.role = newRole;
    }

    playAttack(player, ball, field, teammates, opponents, distToBall, predicted) {
        if (distToBall > 35) {
            const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
            const playerToOwnGoal = Math.abs(player.x - ownGoalX);
            const ballToOwnGoal = Math.abs(predicted.x - ownGoalX);

            const ballSpeedTowardGoal = player.team === 'red' ? -ball.vx : ball.vx;
            const ballMovingTowardOwnGoal = ballSpeedTowardGoal > 3;

            if (ballMovingTowardOwnGoal && distToBall < 100) {
                const sideOffset = player.y > predicted.y ? 30 : -30;
                const awayFromGoal = player.team === 'red' ? 15 : -15;
                this.targetX = predicted.x + awayFromGoal;
                this.targetY = predicted.y + sideOffset;
            } else if (playerToOwnGoal > ballToOwnGoal && distToBall < 80) {
                const goalSideOffset = player.team === 'red' ? -25 : 25;
                this.targetX = predicted.x + goalSideOffset;
                this.targetY = predicted.y;
            } else {
                this.targetX = predicted.x;
                this.targetY = predicted.y;
            }
        } else {
            const target = this.chooseBestTarget(player, ball, field, teammates, opponents);
            this.aimX = target.x;
            this.aimY = target.y;

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

        const ballSpeedTowardGoal = player.team === 'red' ? -ball.vx : ball.vx;
        const ballMovingFastTowardGoal = ballSpeedTowardGoal > 3;
        const inShootingLane = Math.abs(player.y - ball.y) < 40
            && ((player.team === 'red' && player.x < ball.x) || (player.team === 'blue' && player.x > ball.x));

        if (ballMovingFastTowardGoal && inShootingLane && distToBall < 120) {
            const sideDir = player.y < ball.y ? -1 : 1;
            if (Math.abs(player.y - ball.y) < 15) {
                const sideDirFromGoal = player.y < goalCenterY ? -1 : 1;
                this.targetY = ball.y + sideDirFromGoal * 50;
            } else {
                this.targetY = ball.y + sideDir * 50;
            }
            this.targetX = player.x;
        } else if (distToBall < 55 && ballOnOurSide) {
            const playerToOwnGoal = Math.abs(player.x - ownGoalX);
            const ballToOwnGoal = Math.abs(predicted.x - ownGoalX);

            if (playerToOwnGoal < ballToOwnGoal) {
                this.targetX = predicted.x;
                this.targetY = predicted.y;
            } else {
                const sideOffset = (player.y > ball.y) ? 35 : -35;
                const goalSideOffset = player.team === 'red' ? -25 : 25;
                this.targetX = predicted.x + goalSideOffset;
                this.targetY = predicted.y + sideOffset;
            }
        } else {
            const t = 0.35 * this.positioningSkill;
            this.targetX = ownGoalX + (ball.x - ownGoalX) * t;

            const directLineY = ball.y;
            const offsetDir = player.y > goalCenterY ? 1 : -1;
            this.targetY = field.centerY + (directLineY - field.centerY) * 0.45 * this.positioningSkill + offsetDir * 20;

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

        const midX = ball.x + (goalX - ball.x) * 0.5;

        const minDistFromBall = field.width * 0.2;
        const distFromBall = Math.abs(midX - ball.x);
        let targetX = midX;
        if (distFromBall < minDistFromBall) {
            targetX = player.team === 'red'
                ? ball.x + minDistFromBall
                : ball.x - minDistFromBall;
        }

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

        if (Math.abs(bestY - ball.y) < field.height * 0.15) {
            bestY = ball.y > field.centerY
                ? ball.y - field.height * 0.2
                : ball.y + field.height * 0.2;
        }

        this.targetX = targetX;
        this.targetY = bestY;
        this.clampTarget(field);
    }

    chooseBestTarget(player, ball, field, teammates, opponents) {
        const goalX = player.team === 'red' ? field.x + field.width : field.x;
        const goalCenterY = field.goalY + field.goalHeight / 2;
        const distToGoal = Math.sqrt((goalX - ball.x) ** 2 + (goalCenterY - ball.y) ** 2);

        if (distToGoal < field.width * 0.55) {
            return { x: goalX, y: this.bestGoalSpot(opponents, field) };
        }

        const pass = this.findPassTarget(player, ball, field, teammates, opponents);
        if (pass) return { x: pass.x, y: pass.y };

        return { x: goalX, y: this.bestGoalSpot(opponents, field) };
    }

    decideKick(player, ball, field, teammates, opponents) {
        const goalX = player.team === 'red' ? field.x + field.width : field.x;
        const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
        const goalCenterY = field.goalY + field.goalHeight / 2;
        const distToGoal = Math.sqrt((goalX - ball.x) ** 2 + (goalCenterY - ball.y) ** 2);
        const distToOwnGoal = Math.abs(ball.x - ownGoalX);

        const spotY = this.bestGoalSpot(opponents, field);
        if (this.isAimedAt(player, ball, goalX, spotY) && !this.wouldKickTowardOwnGoal(player, ball, field)) {
            let charge = 0.25;
            if (distToGoal < field.width * 0.5) charge = 0.4;
            if (distToGoal < field.width * 0.35) charge = 0.55;
            if (distToGoal < field.width * 0.2) charge = 0.75;
            if (distToGoal < field.width * 0.12) charge = 0.9;

            if (this._random() < this.accuracy) {
                return { kick: true, chargeRatio: charge };
            }
        }

        const pass = this.findPassTarget(player, ball, field, teammates, opponents);
        if (pass && this.isAimedAt(player, ball, pass.x, pass.y) && !this.wouldKickTowardOwnGoal(player, ball, field)) {
            const passDist = Physics.distance(player, pass);
            const charge = Math.min(0.15 + passDist / (field.width * 2), 0.45);
            if (this._random() < this.accuracy * 0.85) {
                return { kick: true, chargeRatio: charge };
            }
        }

        if (distToOwnGoal < field.width * 0.15 && !this.wouldKickTowardOwnGoal(player, ball, field)) {
            return { kick: true, chargeRatio: 0.6 };
        }

        if (distToOwnGoal < field.width * 0.5 && this.isAimedAt(player, ball, goalX, goalCenterY)
            && !this.wouldKickTowardOwnGoal(player, ball, field)) {
            return { kick: true, chargeRatio: 0.3 };
        }

        return { kick: false, chargeRatio: 0.3 };
    }

    bestGoalSpot(opponents, field) {
        const goalTop = field.goalY + 12;
        const goalBottom = field.goalY + field.goalHeight - 12;

        const jitter = (1 - this.accuracy) * 30 * (this._random() - 0.5);

        if (this._random() < 0.5) {
            return Math.min(goalBottom + jitter, goalBottom);
        } else {
            return Math.max(goalTop + jitter, goalTop);
        }
    }

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

            if (passDist < 50 || passDist > field.width * 0.7) continue;
            if (!this.isLaneClear(ball, t, opponents)) continue;

            let score = (field.width - distToGoal) / field.width * 1.5;
            score += openness * 0.8;
            if (isAhead) score += 1.2;

            if (score > bestScore) { bestScore = score; best = t; }
        }

        return bestScore > 2.0 ? best : null;
    }

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
            if (Math.abs(ox * (-ny) + oy * nx) < 35) return false;
        }
        return true;
    }

    getOpenness(player, opponents) {
        let min = Infinity;
        for (const o of opponents) {
            const d = Physics.distance(player, o);
            if (d < min) min = d;
        }
        return Math.min(min / 80, 2.0);
    }

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
            // Inline the unit vector (reusing `dist`) instead of calling
            // Physics.normalize, which allocates a fresh {x,y} object on this
            // per-tick hot path (one AI moves every tick). dist > 3 guarantees
            // a non-zero divisor, matching normalize's len === 0 guard.
            const inv = 1 / dist;
            const speed = Math.min(dist / this.moveDiv, 1);
            player.applyInput(dx * inv * speed, dy * inv * speed);
        }
    }
}

return AIController;
});
