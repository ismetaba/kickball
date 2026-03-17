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

// Learning AI controller — fully NN-controlled, drop-in compatible with AIController
class LearningAI {
    constructor(nn) {
        // 22 inputs -> 32 -> 16 -> 5 outputs (moveX, moveY, kick, charge, pull)
        this.nn = nn || new NeuralNetwork([22, 32, 16, 5]);
        this.fitness = 0;
    }

    update(player, ball, field, teammates, opponents, dt) {
        const input = this.buildInput(player, ball, field, opponents);
        const output = this.nn.forward(input);

        // NN has FULL control — no hardcoded logic
        // output[0] = moveX direction (-1 to 1)
        // output[1] = moveY direction (-1 to 1)
        // output[2] = kick signal (>0 = kick)
        // output[3] = charge ratio (mapped 0 to 0.7)
        // output[4] = pull signal (>0.5 = activate pull)

        const moveX = output[0];
        const moveY = output[1];

        // Normalize movement to unit length (NN decides direction, physics handles speed)
        const moveLen = Math.sqrt(moveX * moveX + moveY * moveY);
        if (moveLen > 0.01) {
            player.applyInput(moveX / moveLen, moveY / moveLen);
        }

        // Kick: NN decides when to kick, physics enforces range/cooldown
        const distToBall = Physics.distance(player, ball);
        const kickRange = player.radius + ball.radius + 12;
        const doKick = distToBall < kickRange && output[2] > 0;
        const chargeRatio = Math.min((output[3] + 1) / 2, 0.7);

        // Pull: NN decides when to pull
        if (output[4] > 0.5) {
            player.activatePull();
        }

        return {
            kick: doKick,
            chargeRatio: chargeRatio
        };
    }

    buildInput(player, ball, field, opponents) {
        const fw = field.width;
        const fh = field.height;
        const fx = field.x;
        const fy = field.y;

        // Normalize to -1..1 relative to field
        const normX = (x) => ((x - fx) / fw) * 2 - 1;
        const normY = (y) => ((y - fy) / fh) * 2 - 1;
        const normV = (v) => v / Physics.MAX_BALL_SPEED;

        // Find nearest opponent
        let nearOpp = opponents[0] || player;
        let nearDist = Infinity;
        for (const o of opponents) {
            const d = Physics.distance(player, o);
            if (d < nearDist) { nearDist = d; nearOpp = o; }
        }

        // Goal positions
        const oppGoalX = player.team === 'red' ? field.x + field.width : field.x;
        const ownGoalX = player.team === 'red' ? field.x : field.x + field.width;
        const goalCenterY = field.goalY + field.goalHeight / 2;

        // Relative vectors (more useful than absolute positions)
        const toBallX = ball.x - player.x;
        const toBallY = ball.y - player.y;
        const ballDist = Math.sqrt(toBallX * toBallX + toBallY * toBallY);

        const toGoalX = oppGoalX - player.x;
        const toGoalY = goalCenterY - player.y;

        const toOwnGoalX = ownGoalX - player.x;
        const toOwnGoalY = goalCenterY - player.y;

        return new Float32Array([
            normX(player.x),               // 0: own position x
            normY(player.y),               // 1: own position y
            normV(player.vx),              // 2: own velocity x
            normV(player.vy),              // 3: own velocity y
            (toBallX / fw) * 2,            // 4: relative ball x (direction + distance)
            (toBallY / fh) * 2,            // 5: relative ball y
            normV(ball.vx),                // 6: ball velocity x
            normV(ball.vy),                // 7: ball velocity y
            Math.min(ballDist / (fw * 0.5), 1) * 2 - 1,  // 8: distance to ball (normalized)
            (nearOpp.x - player.x) / fw * 2, // 9: relative opponent x
            (nearOpp.y - player.y) / fh * 2, // 10: relative opponent y
            normV(nearOpp.vx),             // 11: opponent velocity x
            normV(nearOpp.vy),             // 12: opponent velocity y
            (toGoalX / fw) * 2,            // 13: relative enemy goal x
            (toGoalY / fh) * 2,            // 14: relative enemy goal y
            (toOwnGoalX / fw) * 2,         // 15: relative own goal x
            (toOwnGoalY / fh) * 2,         // 16: relative own goal y
            player.team === 'red' ? -1 : 1, // 17: team side
            ball.lastKickedBy === player ? 1 : -1, // 18: do I have possession?
            player.pullCooldown > 0 ? -1 : 1,      // 19: pull available?
            player.kickCooldown > 0 ? -1 : 1,      // 20: kick available?
            Physics.distance(nearOpp, ball) / (fw * 0.5) * 2 - 1  // 21: opponent distance to ball
        ]);
    }

    clone() {
        return new LearningAI(this.nn.clone());
    }
}

// Default skill weights for fitness calculation
const DEFAULT_SKILL_WEIGHTS = {
    goalScoring: 1.0,
    shotAccuracy: 1.0,
    ballControl: 1.0,
    positioning: 1.0,
    ballAdvancement: 1.0,
};

// Headless simulation for fast training
class HeadlessMatch {
    constructor(field, skillWeights) {
        this.field = field;
        this.skillWeights = skillWeights || DEFAULT_SKILL_WEIGHTS;
        this.ball = new Ball(field.centerX, field.centerY);
        this.redPlayer = new Player(field.x + field.width * 0.25, field.centerY, 'red', false);
        this.bluePlayer = new Player(field.x + field.width * 0.75, field.centerY, 'blue', false);
        this.players = [this.redPlayer, this.bluePlayer];
        this.redScore = 0;
        this.blueScore = 0;
        this.timeElapsed = 0;
        this.matchDuration = 12000; // 12 seconds per training match
        this.finished = false;
        this.steps = 0;

        // Per-skill accumulators for each side
        this.redSkills = { goalScoring: 0, shotAccuracy: 0, ballControl: 0, positioning: 0, ballAdvancement: 0 };
        this.blueSkills = { goalScoring: 0, shotAccuracy: 0, ballControl: 0, positioning: 0, ballAdvancement: 0 };

        // Track previous ball velocity to detect kicks
        this._prevBallVx = 0;
        this._prevBallVy = 0;
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

        this.bluePlayer.x = this.field.x + this.field.width * 0.75;
        this.bluePlayer.y = this.field.centerY;
        this.bluePlayer.vx = 0;
        this.bluePlayer.vy = 0;
        this.bluePlayer.kickCooldown = 0;
    }

    step(redAI, blueAI) {
        const dt = 33.34; // simulate at 30fps (2x step for speed)
        Physics.dtRatio = (dt / 16.67) * Physics.GAME_SPEED;

        // Save ball state before kicks to detect kick direction
        this._prevBallVx = this.ball.vx;
        this._prevBallVy = this.ball.vy;

        // AI decisions
        const redAction = redAI.update(this.redPlayer, this.ball, this.field, [this.redPlayer], [this.bluePlayer], dt);
        const blueAction = blueAI.update(this.bluePlayer, this.ball, this.field, [this.bluePlayer], [this.redPlayer], dt);

        // Execute kicks and track kick direction for shot accuracy
        if (redAction.kick) {
            this.redPlayer.kick(this.ball, redAction.chargeRatio || 0.3);
            this._trackKickDirection('red');
        }
        if (blueAction.kick) {
            this.bluePlayer.kick(this.ball, blueAction.chargeRatio || 0.3);
            this._trackKickDirection('blue');
        }

        // Update entities
        for (const p of this.players) p.update(dt);
        this.ball.update(dt);

        // Pull physics (same as game.js)
        const pullMaxRange = 150;
        for (const p of this.players) {
            if (p.pullActive) {
                const dist = Physics.distance(p, this.ball);
                if (dist >= pullMaxRange) {
                    p.pullActive = false;
                    p.pullCooldown = p.pullCooldownTime;
                } else if (dist > p.radius + this.ball.radius + 5) {
                    const dx = p.x - this.ball.x;
                    const dy = p.y - this.ball.y;
                    const n = Physics.normalize(dx, dy);
                    const falloff = 1 - (dist / pullMaxRange);
                    const pullStrength = 0.25 * falloff * Physics.dtRatio;
                    this.ball.vx += n.x * pullStrength;
                    this.ball.vy += n.y * pullStrength;
                    this.ball.vx *= Math.pow(0.985, Physics.dtRatio);
                    this.ball.vy *= Math.pow(0.985, Physics.dtRatio);
                }
            }
        }

        // Collisions
        Physics.resolveCircleCollision(this.redPlayer, this.ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE);
        Physics.resolveCircleCollision(this.bluePlayer, this.ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE);
        Physics.resolveCircleCollision(this.redPlayer, this.bluePlayer, Physics.PLAYER_BOUNCE, Physics.PLAYER_BOUNCE);

        // Field constraints
        for (const p of this.players) {
            Physics.constrainToField(p, this.field, true);
        }
        Physics.constrainToField(this.ball, this.field, false);

        // --- Per-frame skill tracking (all skills target ~0-100 range over a match) ---
        const redDist = Physics.distance(this.redPlayer, this.ball);
        const blueDist = Physics.distance(this.bluePlayer, this.ball);
        const fw = this.field.width;
        const midX = this.field.x + fw / 2;
        this.steps++;

        // Ball Control: always reward being close, always penalize being far
        // This creates a continuous gradient that pulls the AI toward the ball at all times
        const redKickRange = this.redPlayer.radius + this.ball.radius + 21;
        const blueKickRange = this.bluePlayer.radius + this.ball.radius + 21;

        // Continuous distance-based reward: closer = more positive, far = negative
        // Range: +0.5 (touching) down to -0.15 (max distance)
        const redCloseness = 1 - Math.min(redDist / (fw * 0.5), 1); // 1=on ball, 0=half field away
        this.redSkills.ballControl += redCloseness * 0.5 - 0.15;
        const blueCloseness = 1 - Math.min(blueDist / (fw * 0.5), 1);
        this.blueSkills.ballControl += blueCloseness * 0.5 - 0.15;

        // Bonus for actually touching the ball (kick range)
        if (redDist < redKickRange) this.redSkills.ballControl += 0.3;
        if (blueDist < blueKickRange) this.blueSkills.ballControl += 0.3;

        // Possession bonus only when also near the ball (prevents kick-and-run-away)
        if (this.ball.lastKickedBy === this.redPlayer && redDist < 100) this.redSkills.ballControl += 0.2;
        if (this.ball.lastKickedBy === this.bluePlayer && blueDist < 100) this.blueSkills.ballControl += 0.2;

        // Positioning: reward being goal-side (between ball and own goal) on defense
        const redOwnGoalX = this.field.x;
        const blueOwnGoalX = this.field.x + fw;
        const redGoalSide = this.redPlayer.x < this.ball.x ? 1 : 0;
        const redInOwnHalf = this.redPlayer.x < midX;
        if (redInOwnHalf && redGoalSide) this.redSkills.positioning += 0.15;
        else if (!redInOwnHalf && this.redPlayer.x > this.ball.x) this.redSkills.positioning += 0.1;
        else this.redSkills.positioning -= 0.05;

        const blueGoalSide = this.bluePlayer.x > this.ball.x ? 1 : 0;
        const blueInOwnHalf = this.bluePlayer.x > midX;
        if (blueInOwnHalf && blueGoalSide) this.blueSkills.positioning += 0.15;
        else if (!blueInOwnHalf && this.bluePlayer.x < this.ball.x) this.blueSkills.positioning += 0.1;
        else this.blueSkills.positioning -= 0.05;

        // Ball Advancement: reward ball position in opponent half (scaled to match other skills)
        const ballProgressRed = (this.ball.x - this.field.x) / fw;
        this.redSkills.ballAdvancement += (ballProgressRed - 0.5) * 0.3;
        this.blueSkills.ballAdvancement += (0.5 - ballProgressRed) * 0.3;

        // Check goals — reward scales with how deep the ball was in opponent half
        // Scoring from opponent's side = bigger reward, own-half lucky bounce = smaller
        const scorer = Physics.checkGoal(this.ball, this.field);
        if (scorer) {
            // ballProgressRed: 0 = red's goal, 1 = blue's goal
            // For red scoring (ball at blue goal, progress~1): bonus = high
            // For blue scoring (ball at red goal, progress~0): bonus = high
            const baseReward = 30;
            const positionBonus = 30; // max extra for deep penetration
            if (scorer === 'red') {
                this.redScore++;
                const depth = ballProgressRed; // 0-1, higher = deeper in blue half
                this.redSkills.goalScoring += baseReward + positionBonus * depth;
                this.blueSkills.goalScoring -= 20;
            } else {
                this.blueScore++;
                const depth = 1 - ballProgressRed; // 0-1, higher = deeper in red half
                this.blueSkills.goalScoring += baseReward + positionBonus * depth;
                this.redSkills.goalScoring -= 20;
            }
            this.reset();
        }

        this.timeElapsed += dt;
        if (this.timeElapsed >= this.matchDuration) {
            this.finished = true;
        }
    }

    // Track kick direction: reward kicking toward enemy goal, penalize toward own goal
    _trackKickDirection(team) {
        const bvx = this.ball.vx;
        const bvy = this.ball.vy;
        const speed = Math.sqrt(bvx * bvx + bvy * bvy);
        if (speed < 2) return; // too slow to matter

        const skills = team === 'red' ? this.redSkills : this.blueSkills;
        const enemyGoalX = team === 'red' ? this.field.x + this.field.width : this.field.x;
        const ownGoalX = team === 'red' ? this.field.x : this.field.x + this.field.width;
        const goalCenterY = this.field.goalY + this.field.goalHeight / 2;

        // Direction to enemy goal
        const toEnemyX = enemyGoalX - this.ball.x;
        const toEnemyY = goalCenterY - this.ball.y;
        const toEnemyDist = Math.sqrt(toEnemyX * toEnemyX + toEnemyY * toEnemyY);

        // Direction to own goal
        const toOwnX = ownGoalX - this.ball.x;
        const toOwnY = goalCenterY - this.ball.y;
        const toOwnDist = Math.sqrt(toOwnX * toOwnX + toOwnY * toOwnY);

        // Dot product with ball velocity (normalized)
        const dotEnemy = (bvx * toEnemyX + bvy * toEnemyY) / (speed * Math.max(toEnemyDist, 1));
        const dotOwn = (bvx * toOwnX + bvy * toOwnY) / (speed * Math.max(toOwnDist, 1));

        // Reward kicking toward enemy goal, penalize toward own goal
        if (dotEnemy > 0.3) skills.shotAccuracy += 5 * dotEnemy;
        if (dotOwn > 0.3) skills.shotAccuracy -= 10 * dotOwn;
    }

    // Run entire match, return fitness for each side
    run(redAI, blueAI) {
        this.reset();
        this.redScore = 0;
        this.blueScore = 0;
        this.timeElapsed = 0;
        this.finished = false;
        this.steps = 0;
        this.redSkills = { goalScoring: 0, shotAccuracy: 0, ballControl: 0, positioning: 0, ballAdvancement: 0 };
        this.blueSkills = { goalScoring: 0, shotAccuracy: 0, ballControl: 0, positioning: 0, ballAdvancement: 0 };

        while (!this.finished) {
            this.step(redAI, blueAI);
        }

        return {
            redFitness: this.calcFitness(this.redSkills),
            blueFitness: this.calcFitness(this.blueSkills),
        };
    }

    calcFitness(skills) {
        const w = this.skillWeights;
        let fitness = 0;
        for (const skill in skills) {
            fitness += skills[skill] * (w[skill] || 1.0);
        }
        return fitness;
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

        // Skill weights for fitness calculation (user-adjustable)
        this.skillWeights = { ...DEFAULT_SKILL_WEIGHTS };

        // Stagnation tracking for adaptive mutation
        this._stagnationCounter = 0;
        this._lastBestFitness = -Infinity;
        this._stagnationThreshold = 20; // generations without improvement to trigger boost

        // Create a virtual field for headless matches (matches classic map: 1500x1000)
        this.field = new Field(1500, 1000, 'classic');

        // Diverse sparring opponents to prevent strategy collapse
        this.sparringOpponents = [
            new ChaserAI(),
            new RandomAI(),
            new DefenderAI(),
            new AIController('normal'),
            new AIController('expert'),
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

    setSkillWeights(weights) {
        this.skillWeights = { ...DEFAULT_SKILL_WEIGHTS, ...weights };
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
        const fieldData = { w: 1500, h: 1000, mapType: 'classic' };

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
                    selfPlayPairs: selfPlayPairs,
                    skillWeights: this.skillWeights
                }
            });
        }
    }

    runGeneration() {
        const match = new HeadlessMatch(this.field, this.skillWeights);

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
