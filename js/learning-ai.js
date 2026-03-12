// Neural Network + Neuroevolution Learning AI
// Trains through self-play using a genetic algorithm

class NeuralNetwork {
    constructor(layers) {
        this.layers = layers; // e.g. [16, 20, 12, 5]
        this.weights = [];
        this.biases = [];

        for (let i = 0; i < layers.length - 1; i++) {
            const rows = layers[i + 1];
            const cols = layers[i];
            // Xavier initialization
            const scale = Math.sqrt(2 / (cols + rows));
            const w = new Float32Array(rows * cols);
            const b = new Float32Array(rows);
            for (let j = 0; j < w.length; j++) w[j] = (Math.random() * 2 - 1) * scale;
            for (let j = 0; j < b.length; j++) b[j] = 0;
            this.weights.push(w);
            this.biases.push(b);
        }
    }

    forward(input) {
        let activation = new Float32Array(input);

        for (let l = 0; l < this.weights.length; l++) {
            const w = this.weights[l];
            const b = this.biases[l];
            const rows = this.layers[l + 1];
            const cols = this.layers[l];
            const output = new Float32Array(rows);

            for (let i = 0; i < rows; i++) {
                let sum = b[i];
                const offset = i * cols;
                for (let j = 0; j < cols; j++) {
                    sum += w[offset + j] * activation[j];
                }
                // tanh for hidden layers, tanh for output too (clamped to -1..1)
                output[i] = Math.tanh(sum);
            }
            activation = output;
        }
        return activation;
    }

    getWeightCount() {
        let count = 0;
        for (let i = 0; i < this.weights.length; i++) {
            count += this.weights[i].length + this.biases[i].length;
        }
        return count;
    }

    // Flatten all weights + biases into a single array
    serialize() {
        const parts = [];
        for (let i = 0; i < this.weights.length; i++) {
            parts.push(...this.weights[i]);
            parts.push(...this.biases[i]);
        }
        return parts;
    }

    // Restore from flat array
    deserialize(flat) {
        let idx = 0;
        for (let i = 0; i < this.weights.length; i++) {
            for (let j = 0; j < this.weights[i].length; j++) {
                this.weights[i][j] = flat[idx++];
            }
            for (let j = 0; j < this.biases[i].length; j++) {
                this.biases[i][j] = flat[idx++];
            }
        }
    }

    clone() {
        const nn = new NeuralNetwork(this.layers);
        nn.deserialize(this.serialize());
        return nn;
    }
}

// Learning AI controller — drop-in compatible with AIController
class LearningAI {
    constructor(nn) {
        this.nn = nn || new NeuralNetwork([20, 24, 12, 5]);
        this.fitness = 0;
        this.targetX = 0;
        this.targetY = 0;
    }

    update(player, ball, field, teammates, opponents, dt) {
        const input = this.buildInput(player, ball, field, opponents);
        const output = this.nn.forward(input);

        // NN controls decisions: kick, dash, charge, and positioning offset near ball
        const kickSignal = output[2];
        const dashSignal = output[3];
        const chargeRatio = Math.min((output[4] + 1) / 2, 0.7);

        const distToBall = Physics.distance(player, ball);
        const kickRange = player.radius + ball.radius + 12;
        const nearBall = distToBall < kickRange;
        player.isDribbling = false; // reset each frame

        // Find nearest opponent distance
        let nearestOppDist = Infinity;
        let nearestOpp = null;
        for (const o of opponents) {
            const d = Physics.distance(player, o);
            if (d < nearestOppDist) { nearestOppDist = d; nearestOpp = o; }
        }

        // --- Dribbling (çalım) detection ---
        // Dribble when: we have the ball AND opponent is pressuring but we have possession
        const hasBall = distToBall < kickRange + 20;
        const oppPressure = nearestOppDist < 150;
        // Only dribble if WE are closer to the ball than the nearest opponent
        const nearestOppToBall = nearestOpp ? Physics.distance(nearestOpp, ball) : Infinity;
        const havePossession = distToBall < nearestOppToBall - 5;
        const shouldDribble = hasBall && oppPressure && nearestOpp && havePossession;

        // --- Role assignment for 2v2+ ---
        let role = 'attack';
        if (teammates.length > 1) {
            let closestTeammateDist = Infinity;
            for (const t of teammates) {
                if (t === player) continue;
                const td = Physics.distance(t, ball);
                if (td < closestTeammateDist) closestTeammateDist = td;
            }
            if (closestTeammateDist < distToBall - 40) {
                role = 'support';
            }
        }

        let moveX = 0, moveY = 0;
        let dribbleKick = false;
        let dribbleCharge = 0;

        if (shouldDribble && role === 'attack') {
            // --- Çalım (dribble) mode ---
            player.isDribbling = true;
            const forwardDir = player.team === 'red' ? 1 : -1;
            const oppGoalX = player.team === 'red' ? field.x + field.width : field.x;
            const goalCY = field.goalY + field.goalHeight / 2;

            // Movement: dodge perpendicular to opponent, biased toward goal
            const oppDx = nearestOpp.x - player.x;
            const oppDy = nearestOpp.y - player.y;
            const oppDist = Math.sqrt(oppDx * oppDx + oppDy * oppDy);

            const toGoalX = oppGoalX - player.x;
            const toGoalY = goalCY - player.y;
            const toGoalDist = Math.sqrt(toGoalX * toGoalX + toGoalY * toGoalY);
            const goalDirX = toGoalDist > 1 ? toGoalX / toGoalDist : forwardDir;
            const goalDirY = toGoalDist > 1 ? toGoalY / toGoalDist : 0;

            if (oppDist > 1) {
                const perpX1 = -oppDy / oppDist, perpY1 = oppDx / oppDist;
                const perpX2 = oppDy / oppDist, perpY2 = -oppDx / oppDist;
                const dot1 = perpX1 * goalDirX + perpY1 * goalDirY;
                const dot2 = perpX2 * goalDirX + perpY2 * goalDirY;
                const perpX = dot1 > dot2 ? perpX1 : perpX2;
                const perpY = dot1 > dot2 ? perpY1 : perpY2;

                // Mostly forward, some dodge
                moveX = perpX * 0.35 + goalDirX * 0.65;
                moveY = perpY * 0.35 + goalDirY * 0.65;
                const len = Math.sqrt(moveX * moveX + moveY * moveY);
                if (len > 0.01) { moveX /= len; moveY /= len; }
            } else {
                moveX = goalDirX;
                moveY = goalDirY;
            }

            // Dribble nudge: directly push ball toward opponent goal (bypass player.kick direction)
            if (nearBall && player.kickCooldown <= 0) {
                dribbleKick = false; // Don't use normal kick — use direct nudge instead
                // Nudge ball: add velocity toward opponent goal + slight dodge
                const nudgeForce = 3.0;
                const nudgeDirX = goalDirX * 0.8 + (moveX - goalDirX) * 0.2;
                const nudgeDirY = goalDirY * 0.8 + (moveY - goalDirY) * 0.2;
                ball.vx += nudgeDirX * nudgeForce;
                ball.vy += nudgeDirY * nudgeForce;
                ball.lastKickedBy = player;
                player.kickCooldown = 200; // cooldown between nudges
            }
        } else if (role === 'attack') {
            // Normal attack: chase ball directly
            const dx = ball.x - player.x;
            const dy = ball.y - player.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 1) {
                moveX = dx / dist;
                moveY = dy / dist;

                // Near ball: NN offset for approach angle
                if (dist < 80) {
                    const offsetScale = 0.4 * (1 - dist / 80);
                    moveX += output[0] * offsetScale;
                    moveY += output[1] * offsetScale;
                    const len = Math.sqrt(moveX * moveX + moveY * moveY);
                    if (len > 0.01) { moveX /= len; moveY /= len; }
                }
            }
        } else {
            // Support role: position between ball and own goal
            const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
            const supportX = (ball.x + ownGoalX) * 0.5;
            const ballRelY = ball.y - field.centerY;
            const supportY = field.centerY - ballRelY * 0.5;

            const sdx = supportX - player.x;
            const sdy = supportY - player.y;
            const sdist = Math.sqrt(sdx * sdx + sdy * sdy);
            if (sdist > 5) {
                moveX = sdx / sdist;
                moveY = sdy / sdist;
            }

            // If ball comes close, switch to attacking it
            if (distToBall < 80) {
                const dx = ball.x - player.x;
                const dy = ball.y - player.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                moveX = dx / dist;
                moveY = dy / dist;
            }
        }

        player.applyInput(moveX, moveY);

        // Kick decision: dribble soft touch OR normal kick
        const doKick = dribbleKick || (nearBall && kickSignal > 0.5 && !shouldDribble);
        const kickCharge = dribbleKick ? dribbleCharge : chargeRatio;

        return {
            kick: doKick,
            dash: distToBall > 50 && distToBall < 150 && dashSignal > 0.5,
            tackle: false,
            chargeRatio: kickCharge
        };
    }

    buildInput(player, ball, field, opponents) {
        const fw = field.width;
        const fh = field.height;
        const fx = field.x;
        const fy = field.y;

        // Normalize positions to -1..1 relative to field
        const normX = (x) => ((x - fx) / fw) * 2 - 1;
        const normY = (y) => ((y - fy) / fh) * 2 - 1;
        const normVx = (v) => v / Physics.MAX_BALL_SPEED;
        const normVy = (v) => v / Physics.MAX_BALL_SPEED;

        // Find nearest opponent
        let nearOpp = opponents[0] || player;
        let nearDist = Infinity;
        for (const o of opponents) {
            const d = Physics.distance(player, o);
            if (d < nearDist) { nearDist = d; nearOpp = o; }
        }

        // Goal positions
        const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
        const oppGoalX = player.team === 'red' ? field.x + field.width : field.x;
        const goalCenterY = field.goalY + field.goalHeight / 2;

        // Angle from ball to opponent goal
        const toBallX = ball.x - player.x;
        const toBallY = ball.y - player.y;
        const ballDist = Math.sqrt(toBallX * toBallX + toBallY * toBallY);
        const normBallDist = Math.min(ballDist / (fw * 0.5), 1) * 2 - 1;

        const toGoalX = oppGoalX - ball.x;
        const toGoalY = goalCenterY - ball.y;
        const goalDist = Math.sqrt(toGoalX * toGoalX + toGoalY * toGoalY);
        const goalAngle = Math.atan2(toGoalY, toGoalX) / Math.PI;

        // Angle from player to ball
        const playerToBallAngle = Math.atan2(toBallY, toBallX) / Math.PI;

        // Is ball between player and opponent goal?
        const ballBetween = (player.team === 'red')
            ? (ball.x > player.x && ball.x < oppGoalX) ? 1 : -1
            : (ball.x < player.x && ball.x > oppGoalX) ? 1 : -1;

        // Distance from opponent to ball (useful for deciding to race)
        const oppBallDist = Physics.distance(nearOpp, ball);
        const normOppBallDist = Math.min(oppBallDist / (fw * 0.5), 1) * 2 - 1;

        // Opponent distance from own goal (is goal exposed?)
        const oppToOwnGoalDist = Math.abs(nearOpp.x - ownGoalX) / fw * 2 - 1;

        return new Float32Array([
            normX(player.x),           // 0: own x
            normY(player.y),           // 1: own y
            normVx(player.vx),         // 2: own vx
            normVy(player.vy),         // 3: own vy
            normX(ball.x),             // 4: ball x
            normY(ball.y),             // 5: ball y
            normVx(ball.vx),           // 6: ball vx
            normVy(ball.vy),           // 7: ball vy
            normX(nearOpp.x),          // 8: opponent x
            normY(nearOpp.y),          // 9: opponent y
            normVx(nearOpp.vx),        // 10: opponent vx
            normVy(nearOpp.vy),        // 11: opponent vy
            normBallDist,              // 12: distance to ball
            goalAngle,                 // 13: angle from ball to opponent goal
            Math.min(goalDist / fw, 1) * 2 - 1,  // 14: distance from ball to goal
            player.team === 'red' ? -1 : 1,       // 15: team side
            playerToBallAngle,         // 16: angle from player to ball
            ballBetween,               // 17: is ball between player & goal
            normOppBallDist,           // 18: opponent distance to ball
            oppToOwnGoalDist           // 19: opponent distance from own goal
        ]);
    }

    clone() {
        return new LearningAI(this.nn.clone());
    }
}

// Headless simulation for fast training
class HeadlessMatch {
    constructor(field) {
        this.field = field;
        this.ball = new Ball(field.centerX, field.centerY);
        this.redPlayer = new Player(field.x + field.width * 0.25, field.centerY, 'red', false);
        this.bluePlayer = new Player(field.x + field.width * 0.75, field.centerY, 'blue', false);
        this.players = [this.redPlayer, this.bluePlayer];
        this.redScore = 0;
        this.blueScore = 0;
        this.timeElapsed = 0;
        this.matchDuration = 12000; // 12 seconds per training match
        this.finished = false;

        // Track fitness components
        this.redBallTime = 0;
        this.blueBallTime = 0;
        this.redTotalBallDist = 0;
        this.blueTotalBallDist = 0;
        this.steps = 0;

        // Enhanced fitness tracking
        this.redStats = { shotsOnGoal: 0, ballAdvancement: 0, ownHalfTime: 0 };
        this.blueStats = { shotsOnGoal: 0, ballAdvancement: 0, ownHalfTime: 0 };
    }

    reset() {
        this.ball.x = this.field.centerX;
        this.ball.y = this.field.centerY;
        this.ball.vx = 0;
        this.ball.vy = 0;
        this.ball.spin = 0;
        this.ball.superKick = 0;
        this.ball.superTarget = null;
        this.ball.lastKickedBy = null;

        this.redPlayer.x = this.field.x + this.field.width * 0.25;
        this.redPlayer.y = this.field.centerY;
        this.redPlayer.vx = 0;
        this.redPlayer.vy = 0;
        this.redPlayer.kickCooldown = 0;
        this.redPlayer.dashCooldown = 0;

        this.bluePlayer.x = this.field.x + this.field.width * 0.75;
        this.bluePlayer.y = this.field.centerY;
        this.bluePlayer.vx = 0;
        this.bluePlayer.vy = 0;
        this.bluePlayer.kickCooldown = 0;
        this.bluePlayer.dashCooldown = 0;
    }

    step(redAI, blueAI) {
        const dt = 33.34; // simulate at 30fps (2x step for speed)
        Physics.dtRatio = (dt / 16.67) * Physics.GAME_SPEED;

        // AI decisions
        const redAction = redAI.update(this.redPlayer, this.ball, this.field, [this.redPlayer], [this.bluePlayer], dt);
        const blueAction = blueAI.update(this.bluePlayer, this.ball, this.field, [this.bluePlayer], [this.redPlayer], dt);

        // Execute kicks
        if (redAction.kick) {
            this.redPlayer.kick(this.ball, redAction.chargeRatio || 0.3);
        }
        if (blueAction.kick) {
            this.bluePlayer.kick(this.ball, blueAction.chargeRatio || 0.3);
        }

        // Execute dashes
        if (redAction.dash) this.redPlayer.dash();
        if (blueAction.dash) this.bluePlayer.dash();

        // Update entities
        for (const p of this.players) p.update(dt);
        this.ball.update(dt);

        // Collisions
        Physics.resolveCircleCollision(this.redPlayer, this.ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE);
        Physics.resolveCircleCollision(this.bluePlayer, this.ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE);
        Physics.resolveCircleCollision(this.redPlayer, this.bluePlayer, Physics.PLAYER_BOUNCE, Physics.PLAYER_BOUNCE);

        // Field constraints
        for (const p of this.players) {
            Physics.constrainToField(p, this.field, true);
        }
        Physics.constrainToField(this.ball, this.field, false);

        // Track fitness metrics
        const redDist = Physics.distance(this.redPlayer, this.ball);
        const blueDist = Physics.distance(this.bluePlayer, this.ball);
        this.redTotalBallDist += redDist;
        this.blueTotalBallDist += blueDist;
        if (redDist < blueDist) this.redBallTime += dt;
        else this.blueBallTime += dt;
        this.steps++;

        // Enhanced: track shots on goal (ball moving toward opponent goal)
        const midX = this.field.x + this.field.width / 2;
        const goalTop = this.field.goalY;
        const goalBottom = this.field.goalY + this.field.goalHeight;
        const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);

        // Red shoots right, blue shoots left
        if (this.ball.vx > 3 && ballSpeed > 5 && this.ball.y > goalTop && this.ball.y < goalBottom) {
            if (this.ball.x > midX) this.redStats.shotsOnGoal += 0.01;
        }
        if (this.ball.vx < -3 && ballSpeed > 5 && this.ball.y > goalTop && this.ball.y < goalBottom) {
            if (this.ball.x < midX) this.blueStats.shotsOnGoal += 0.01;
        }

        // Ball advancement: how far ball is in opponent half
        const ballProgressRed = (this.ball.x - this.field.x) / this.field.width; // 0..1, higher = closer to blue goal
        const ballProgressBlue = 1 - ballProgressRed;
        this.redStats.ballAdvancement += ballProgressRed * 0.001;
        this.blueStats.ballAdvancement += ballProgressBlue * 0.001;

        // Penalize staying in own half
        if (this.redPlayer.x < midX) this.redStats.ownHalfTime += 0.001;
        if (this.bluePlayer.x > midX) this.blueStats.ownHalfTime += 0.001;

        // Check goals
        const scorer = Physics.checkGoal(this.ball, this.field);
        if (scorer) {
            if (scorer === 'red') this.redScore++;
            else this.blueScore++;
            this.reset();
        }

        this.timeElapsed += dt;
        if (this.timeElapsed >= this.matchDuration) {
            this.finished = true;
        }
    }

    // Run entire match, return fitness for each side
    run(redAI, blueAI) {
        this.reset();
        this.redScore = 0;
        this.blueScore = 0;
        this.timeElapsed = 0;
        this.finished = false;
        this.redBallTime = 0;
        this.blueBallTime = 0;
        this.redTotalBallDist = 0;
        this.blueTotalBallDist = 0;
        this.steps = 0;
        this.redStats = { shotsOnGoal: 0, ballAdvancement: 0, ownHalfTime: 0 };
        this.blueStats = { shotsOnGoal: 0, ballAdvancement: 0, ownHalfTime: 0 };

        while (!this.finished) {
            this.step(redAI, blueAI);
        }

        const avgRedDist = this.redTotalBallDist / Math.max(this.steps, 1);
        const avgBlueDist = this.blueTotalBallDist / Math.max(this.steps, 1);
        const maxDist = this.field.width * 0.5;

        return {
            redFitness: this.calcFitness(this.redScore, this.blueScore, avgRedDist, maxDist, this.redBallTime, 'red'),
            blueFitness: this.calcFitness(this.blueScore, this.redScore, avgBlueDist, maxDist, this.blueBallTime, 'blue'),
        };
    }

    calcFitness(goalsFor, goalsAgainst, avgDist, maxDist, possTime, side) {
        const stats = side === 'red' ? this.redStats : this.blueStats;

        // Proximity multiplier: 0.1 (far from ball) to 1.0 (on top of ball)
        // This GATES all other rewards — you can't score high fitness by camping
        const proxFactor = 0.1 + 0.9 * Math.pow(1 - Math.min(avgDist / maxDist, 1), 1.5);

        // Base fitness from behavior
        let f = 0;
        f += goalsFor * 100;                         // huge goal reward
        f += Math.pow(goalsFor, 2) * 25;             // accelerating multi-goal bonus
        f -= goalsAgainst * 15;                      // conceding penalty (not too harsh early on)
        f += (stats.shotsOnGoal || 0) * 12;          // shots on goal
        f += (stats.ballAdvancement || 0) * 6;       // pushing ball forward
        f += (possTime / this.matchDuration) * 20;   // possession time

        // Apply proximity gate — all rewards scaled by how close you stay to ball
        f *= proxFactor;

        // Small additive proximity bonus to bootstrap learning (always rewarded)
        f += (1 - avgDist / maxDist) * 50;

        // Goal differential bonus (also gated)
        const diff = goalsFor - goalsAgainst;
        if (diff > 0) f += diff * 25 * proxFactor;

        return f;
    }
}

// Scripted sparring opponents to provide diverse challenges
class ChaserAI {
    // Aggressively chases ball and kicks toward goal
    update(player, ball, field, teammates, opponents, dt) {
        const dx = ball.x - player.x;
        const dy = ball.y - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 1) {
            player.applyInput(dx / dist, dy / dist);
        }
        const goalX = player.team === 'red' ? field.x + field.width : field.x;
        const kickRange = player.radius + ball.radius + 10;
        const toGoalX = goalX - player.x;
        const kickDirX = ball.x - player.x;
        // Only kick if it sends ball roughly toward goal
        const kickTowardGoal = (player.team === 'red') ? kickDirX > 0 : kickDirX < 0;
        return {
            kick: dist < kickRange && kickTowardGoal,
            dash: dist > 80 && dist < 150 && Math.random() < 0.1,
            tackle: false,
            chargeRatio: 0.4
        };
    }
}

class RandomAI {
    // Random movement with occasional kicks — easy baseline
    constructor() { this._timer = 0; this._mx = 0; this._my = 0; }
    update(player, ball, field, teammates, opponents, dt) {
        this._timer -= dt;
        if (this._timer <= 0) {
            this._mx = Math.random() * 2 - 1;
            this._my = Math.random() * 2 - 1;
            this._timer = 200 + Math.random() * 400;
        }
        // Bias toward ball
        const dx = ball.x - player.x;
        const dy = ball.y - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const bx = dist > 1 ? dx / dist * 0.6 : 0;
        const by = dist > 1 ? dy / dist * 0.6 : 0;
        player.applyInput(this._mx * 0.4 + bx, this._my * 0.4 + by);
        return {
            kick: dist < player.radius + ball.radius + 12 && Math.random() < 0.7,
            dash: Math.random() < 0.02,
            tackle: false,
            chargeRatio: Math.random() * 0.5
        };
    }
}

class DefenderAI {
    // Stays between ball and own goal, clears when close
    update(player, ball, field, teammates, opponents, dt) {
        const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
        const goalCenterY = field.goalY + field.goalHeight / 2;
        // Position between ball and own goal
        const targetX = ownGoalX + (ball.x - ownGoalX) * 0.3;
        const targetY = goalCenterY + (ball.y - goalCenterY) * 0.5;
        const dx = targetX - player.x;
        const dy = targetY - player.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 3) {
            player.applyInput(dx / dist, dy / dist);
        }
        const ballDist = Physics.distance(player, ball);
        const kickRange = player.radius + ball.radius + 10;
        // Kick ball away from own goal
        const kickDirX = ball.x - player.x;
        const kickAway = (player.team === 'red') ? kickDirX > 0 : kickDirX < 0;
        return {
            kick: ballDist < kickRange && kickAway,
            dash: ballDist < 60 && ballDist > 30 && Math.random() < 0.15,
            tackle: false,
            chargeRatio: 0.5
        };
    }
}

// Evolutionary trainer
class EvolutionTrainer {
    constructor() {
        this.populationSize = 30;
        this.population = [];
        this.generation = 0;
        this.bestFitness = -Infinity;
        this.bestAgent = null;
        this.isTraining = false;
        this._animFrame = null;
        this._batchSize = 5; // matches per training tick
        this.onProgress = null; // callback(gen, bestFitness)

        // Stagnation tracking for adaptive mutation
        this._stagnationCounter = 0;
        this._lastBestFitness = -Infinity;
        this._stagnationThreshold = 20; // generations without improvement to trigger boost

        // Create a virtual field for headless matches (800x500 canvas sim)
        this.field = new Field(800, 500, 'classic');

        // Diverse sparring opponents to prevent strategy collapse
        this.sparringOpponents = [
            new ChaserAI(),
            new RandomAI(),
            new DefenderAI(),
            new AIController('easy'),
            new AIController('medium'),
        ];

        // Hall of fame: past best agents to prevent forgetting
        this.hallOfFame = [];
        this.hallOfFameMaxSize = 5;

        // Web Workers for parallel training
        this._workers = [];
        this._workerCount = Math.min(navigator.hardwareConcurrency || 4, 8);
        this._useWorkers = false;
        this._pendingGen = null; // tracks async generation in progress
        this._initWorkers();

        this.initPopulation();
        this.loadFromStorage();
        // If no local model, try loading the bundled model from file
        if (!this.bestAgent) {
            this.loadFromFile();
        }
    }

    _initWorkers() {
        try {
            for (let i = 0; i < this._workerCount; i++) {
                const w = new Worker('js/training-worker.js');
                w.onmessage = (e) => this._onWorkerResult(i, e.data);
                w.onerror = (e) => {
                    console.warn('Worker error, falling back to main thread:', e.message);
                    this._useWorkers = false;
                };
                this._workers.push({ worker: w, busy: false, results: null });
            }
            this._useWorkers = true;
            console.log(`Parallel training: ${this._workerCount} workers`);
        } catch (e) {
            console.warn('Web Workers unavailable, using main thread:', e.message);
            this._useWorkers = false;
        }
    }

    _onWorkerResult(workerIdx, data) {
        if (data.type === 'results') {
            this._workers[workerIdx].results = data.results;
            this._workers[workerIdx].busy = false;
            this._checkAllWorkersDone();
        }
    }

    _checkAllWorkersDone() {
        if (!this._pendingGen) return;
        if (this._workers.some(w => w.busy)) return;

        // All workers done — collect results
        const allResults = [];
        for (const w of this._workers) {
            if (w.results) allResults.push(...w.results);
            w.results = null;
        }

        // Apply fitness scores to population
        for (const r of allResults) {
            if (this.population[r.index]) {
                this.population[r.index].fitness = r.fitness;
            }
        }

        // Do selection/reproduction on main thread (fast)
        this._evolve();
        this.generation++;
        this._pendingGen = null;

        if (this.generation % 10 === 0) this.saveToStorage();
        if (this.onProgress) this.onProgress(this.generation, this.bestFitness);

        // Immediately start next generation if still training
        if (this.isTraining) {
            // Small yield to keep UI responsive
            this._animFrame = setTimeout(() => this._trainParallel(), 0);
        }
    }

    initPopulation() {
        this.population = [];
        for (let i = 0; i < this.populationSize; i++) {
            this.population.push(new LearningAI());
        }
    }

    start() {
        if (this.isTraining) return;
        this.isTraining = true;
        if (this._useWorkers) {
            this._trainParallel();
        } else {
            this._train();
        }
    }

    stop() {
        this.isTraining = false;
        this._pendingGen = null;
        if (this._animFrame) {
            clearTimeout(this._animFrame);
            this._animFrame = null;
        }
    }

    resetTraining() {
        this.stop();
        this.generation = 0;
        this.bestFitness = -Infinity;
        this.bestAgent = null;
        this.hallOfFame = [];
        this._stagnationCounter = 0;
        this._lastBestFitness = -Infinity;
        this.initPopulation();
        localStorage.removeItem('kickzone-learned-ai');
        if (this.onProgress) this.onProgress(0, 0);
    }

    _train() {
        if (!this.isTraining) return;

        // Time-budgeted: run as many generations as fit in ~80ms, then yield
        const budget = 80; // ms per frame
        const start = performance.now();
        let ran = 0;

        while (performance.now() - start < budget && this.isTraining) {
            this.runGeneration();
            this.generation++;
            ran++;

            // Save best every 10 generations
            if (this.generation % 10 === 0) {
                this.saveToStorage();
            }
        }

        if (this.onProgress && ran > 0) {
            this.onProgress(this.generation, this.bestFitness);
        }

        // Use setTimeout(0) instead of rAF for faster scheduling (~4ms vs ~16ms)
        this._animFrame = setTimeout(() => this._train(), 0);
    }

    // Build the list of opponent matchups for a generation
    _buildMatchups() {
        const opponents = [];
        const allOpponents = [
            { type: 'chaser' }, { type: 'random' }, { type: 'defender' },
            { type: 'easy' }, { type: 'medium' },
            ...this.hallOfFame.map(a => ({ type: 'learned', weights: a.nn.serialize() }))
        ];
        const sparringRounds = this.generation < 300 ? 2 : 1;
        for (let r = 0; r < sparringRounds; r++) {
            const opp = allOpponents[Math.floor(Math.random() * allOpponents.length)];
            opponents.push({ ...opp, playAsBlue: Math.random() < 0.5 });
        }
        return opponents;
    }

    _trainParallel() {
        if (!this.isTraining || this._pendingGen) return;
        this._pendingGen = true;

        const opponents = this._buildMatchups();
        const fieldData = { w: 800, h: 500, mapType: 'classic' };

        // Self-play pairs
        let selfPlayPairs = null;
        if (this.generation >= 300) {
            const indices = [...Array(this.populationSize).keys()].sort(() => Math.random() - 0.5);
            selfPlayPairs = [];
            for (let i = 0; i < indices.length - 1; i += 2) {
                selfPlayPairs.push({ redIndex: indices[i], blueIndex: indices[i + 1] });
            }
        }

        // Serialize all agent weights
        const allAgents = this.population.map((a, i) => ({ weights: a.nn.serialize(), index: i }));

        // Split agents across workers
        const chunkSize = Math.ceil(allAgents.length / this._workerCount);
        for (let i = 0; i < this._workerCount; i++) {
            const chunk = allAgents.slice(i * chunkSize, (i + 1) * chunkSize);
            if (chunk.length === 0) continue;
            this._workers[i].busy = true;
            this._workers[i].results = null;
            this._workers[i].worker.postMessage({
                type: 'evaluate',
                data: {
                    agents: chunk,
                    // Each worker needs ALL agents for self-play pairs
                    allAgents: selfPlayPairs ? allAgents : undefined,
                    opponents,
                    field: fieldData,
                    generation: this.generation,
                    selfPlayPairs: selfPlayPairs
                }
            });
        }
    }

    runGeneration() {
        const match = new HeadlessMatch(this.field);

        // Reset fitness
        for (const agent of this.population) {
            agent.fitness = 0;
        }

        let matchesPerAgent = 0;

        // Early curriculum: skip self-play until agents can at least chase the ball (gen < 300)
        if (this.generation >= 300) {
            const shuffled = [...this.population].sort(() => Math.random() - 0.5);
            for (let i = 0; i < shuffled.length - 1; i += 2) {
                const a = shuffled[i];
                const b = shuffled[i + 1];
                const result = match.run(a, b);
                a.fitness += result.redFitness;
                b.fitness += result.blueFitness;
            }
            matchesPerAgent += 1;
        }

        const allOpponents = [...this.sparringOpponents, ...this.hallOfFame];
        const sparringRounds = this.generation < 300 ? 2 : 1;
        for (let r = 0; r < sparringRounds; r++) {
            for (const agent of this.population) {
                const opp = allOpponents[Math.floor(Math.random() * allOpponents.length)];
                if (Math.random() < 0.5) {
                    const result = match.run(agent, opp);
                    agent.fitness += result.redFitness;
                } else {
                    const result = match.run(opp, agent);
                    agent.fitness += result.blueFitness;
                }
            }
            matchesPerAgent++;
        }

        for (const agent of this.population) {
            agent.fitness /= matchesPerAgent;
        }

        this._evolve();
    }

    // Selection, reproduction, stagnation tracking — shared between parallel and sequential
    _evolve() {
        // Sort by fitness (best first)
        this.population.sort((a, b) => b.fitness - a.fitness);

        // Track stagnation
        if (this.population[0].fitness > this._lastBestFitness + 0.1) {
            this._stagnationCounter = 0;
            this._lastBestFitness = this.population[0].fitness;
        } else {
            this._stagnationCounter++;
        }

        if (this.population[0].fitness > this.bestFitness) {
            this.bestFitness = this.population[0].fitness;
            this.bestAgent = this.population[0].clone();

            this.hallOfFame.push(this.bestAgent.clone());
            if (this.hallOfFame.length > this.hallOfFameMaxSize) {
                this.hallOfFame.shift();
            }
        }

        // Selection + reproduction
        const eliteCount = Math.floor(this.populationSize * 0.15);
        const immigrantCount = Math.max(2, Math.floor(this.populationSize * 0.1));
        const newPop = [];

        for (let i = 0; i < eliteCount; i++) {
            newPop.push(this.population[i].clone());
        }

        for (let i = 0; i < immigrantCount; i++) {
            newPop.push(new LearningAI());
        }

        if (this._stagnationCounter > 50 && this.hallOfFame.length > 0) {
            const hofAgent = this.hallOfFame[Math.floor(Math.random() * this.hallOfFame.length)];
            const mutant = hofAgent.clone();
            this.mutate(mutant, 0.3);
            newPop.push(mutant);
        }

        const mutRate = this.getMutationRate();
        const mutMag = this.getMutationMagnitude();
        while (newPop.length < this.populationSize) {
            const parentA = this.tournamentSelect(3);
            const parentB = this.tournamentSelect(3);
            const child = this.crossover(parentA, parentB);
            this.mutate(child, mutRate, mutMag);
            newPop.push(child);
        }

        this.population = newPop;
    }

    tournamentSelect(k) {
        let best = null;
        for (let i = 0; i < k; i++) {
            const idx = Math.floor(Math.random() * this.population.length);
            if (!best || this.population[idx].fitness > best.fitness) {
                best = this.population[idx];
            }
        }
        return best;
    }

    crossover(a, b) {
        const child = new LearningAI();
        const weightsA = a.nn.serialize();
        const weightsB = b.nn.serialize();
        const childWeights = new Array(weightsA.length);

        // Uniform crossover
        for (let i = 0; i < weightsA.length; i++) {
            childWeights[i] = Math.random() < 0.5 ? weightsA[i] : weightsB[i];
        }
        child.nn.deserialize(childWeights);
        return child;
    }

    mutate(agent, rate, magnitude) {
        magnitude = magnitude || 0.1;
        const weights = agent.nn.serialize();
        for (let i = 0; i < weights.length; i++) {
            if (Math.random() < rate) {
                // Gaussian-ish mutation with variable magnitude
                const u1 = Math.random();
                const u2 = Math.random();
                const gauss = Math.sqrt(-2 * Math.log(u1 + 1e-10)) * Math.cos(2 * Math.PI * u2);
                weights[i] += gauss * magnitude;
            }
        }
        agent.nn.deserialize(weights);
    }

    getMutationRate() {
        // Base rate decays but has a reasonable floor
        let base = Math.max(0.08, 0.3 - this.generation * 0.001);

        // Adaptive: boost mutation when stagnating
        if (this._stagnationCounter > this._stagnationThreshold) {
            // Linearly increase mutation rate the longer we stagnate
            const boost = Math.min(0.3, (this._stagnationCounter - this._stagnationThreshold) * 0.005);
            base = Math.min(0.5, base + boost);
        }
        return base;
    }

    getMutationMagnitude() {
        // Base magnitude
        let mag = 0.1;

        // When stagnating, make mutations bigger to escape local optima
        if (this._stagnationCounter > this._stagnationThreshold) {
            const boost = Math.min(0.4, (this._stagnationCounter - this._stagnationThreshold) * 0.003);
            mag += boost;
        }
        return mag;
    }

    saveToStorage() {
        if (!this.bestAgent) return;
        const data = {
            generation: this.generation,
            bestFitness: this.bestFitness,
            weights: this.bestAgent.nn.serialize(),
            layers: this.bestAgent.nn.layers,
        };
        try {
            localStorage.setItem('kickzone-learned-ai', JSON.stringify(data));
        } catch (e) {
            // localStorage full or unavailable
        }
    }

    loadFromStorage() {
        try {
            const raw = localStorage.getItem('kickzone-learned-ai');
            if (!raw) return false;
            const data = JSON.parse(raw);
            if (!data.weights || !data.layers) return false;

            // Check if saved architecture matches current — discard if incompatible
            const expectedLayers = new LearningAI().nn.layers;
            if (JSON.stringify(data.layers) !== JSON.stringify(expectedLayers)) {
                console.log('Saved AI has different architecture, discarding. Old:', data.layers, 'New:', expectedLayers);
                localStorage.removeItem('kickzone-learned-ai');
                return false;
            }

            this.generation = data.generation || 0;
            this.bestFitness = data.bestFitness || 0;
            this._lastBestFitness = this.bestFitness;
            this._stagnationCounter = 0;

            const nn = new NeuralNetwork(data.layers);
            nn.deserialize(data.weights);
            this.bestAgent = new LearningAI(nn);

            // Seed population with best agent + mutations
            this.population = [];
            this.population.push(this.bestAgent.clone());
            for (let i = 1; i < this.populationSize; i++) {
                const agent = this.bestAgent.clone();
                this.mutate(agent, 0.15);
                this.population.push(agent);
            }

            return true;
        } catch (e) {
            return false;
        }
    }

    async loadFromFile() {
        try {
            const res = await fetch('models/kickzone-model.json');
            if (!res.ok) return false;
            const data = await res.json();
            if (!data.weights || !data.layers) return false;

            const expectedLayers = new LearningAI().nn.layers;
            if (JSON.stringify(data.layers) !== JSON.stringify(expectedLayers)) {
                console.log('Bundled model has different architecture, skipping.');
                return false;
            }

            this.generation = data.generation || 0;
            this.bestFitness = data.bestFitness || 0;
            this._lastBestFitness = this.bestFitness;
            this._stagnationCounter = 0;

            const nn = new NeuralNetwork(data.layers);
            nn.deserialize(data.weights);
            this.bestAgent = new LearningAI(nn);

            // Seed population with best agent + mutations
            this.population = [];
            this.population.push(this.bestAgent.clone());
            for (let i = 1; i < this.populationSize; i++) {
                const agent = this.bestAgent.clone();
                this.mutate(agent, 0.15);
                this.population.push(agent);
            }

            // Also save to localStorage for future loads
            this.saveToStorage();
            console.log('Loaded bundled model (gen ' + this.generation + ', fitness ' + this.bestFitness.toFixed(1) + ')');
            return true;
        } catch (e) {
            return false;
        }
    }

    getBestAgent() {
        if (this.bestAgent) return this.bestAgent.clone();
        // No trained agent yet — return random
        return new LearningAI();
    }

    hasTrainedAgent() {
        return this.bestAgent !== null;
    }
}

// Global trainer instance
const Trainer = new EvolutionTrainer();
