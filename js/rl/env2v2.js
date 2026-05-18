// Headless 2v2 environment for KickZone RL.
//
// Same physics + reward backbone as 1v1, but with 4 players, sorted-opponent
// per-player observations, and team-coordination shaping:
//   - Pass-completion reward: when I kick → my teammate next-touches the
//     ball (without an opp touching in between), I get +passCompleteCoef.
//     Only counted if the ball ALSO advanced toward opp goal (anti-gaming).
//   - Possession-transfer reward (smaller): rewarded whenever my teammate
//     touches the ball after me, regardless of progress.
//   - Spread penalty: small per-step penalty when I'm clustered with my
//     teammate (<80 px). Forces them to spread.
//   - Support-positioning reward: when teammate has the ball, I get a small
//     reward for being in a "support slot" (forward and to one side).
//
// Per-team state (we track ball-touching and reward attribution at team level).
(function(root, factory) {
    let Physics, Entities, PowerUpManager, RLEncoder2v2;
    if (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports) {
        Physics = require('../../shared/physics');
        Entities = require('../../shared/entities');
        PowerUpManager = require('../../shared/powerups');
        RLEncoder2v2 = require('./encoder2v2');
    } else {
        Physics = root.Physics;
        Entities = { Player: root.Player, Ball: root.Ball, Field: root.Field };
        PowerUpManager = root.PowerUpManager;
        RLEncoder2v2 = root.RLEncoder2v2;
    }
    const exp = factory(Physics, Entities, PowerUpManager, RLEncoder2v2);
    if (typeof module !== 'undefined' && module.exports) module.exports = exp;
    else root.RLEnv2v2 = exp;
})(typeof self !== 'undefined' ? self : this, function(Physics, Entities, PowerUpManager, RLEncoder2v2) {

const { Player, Ball, Field } = Entities;

const DEFAULT_OPTS = {
    map: 'classic',
    maxSteps: 1800,
    powerUps: false,
    randomKickoff: true,
    rewardScale: 1.0,
    // Per-step shaping (mostly inherited from 1v1; tuning factors slightly
    // smaller because there are 2 agents per team accumulating signal).
    progressCoef: 0.0002,
    timePenalty: 0.0,
    forwardKickCoef: 0.06,
    ownGoalKickPenalty: 0.02,
    activityKickBonus: 0.012,
    ballNearGoalBonus: 0.0005,
    ballInOwnHalfPenalty: 0.0001,
    approachBallCoef: 0.00010,
    // Phase / curriculum flags
    disableSuperKick: true,
    disableKickPlayer: true,
    disablePull: true,
    superKickAbusePenalty: 0,
    kickPlayerAbusePenalty: 0,
    // Stagnation
    stagnationPenalty: 0.0003,
    stagnationRadius: 150,
    stagnationThreshold: 3000,
    // ===== 2v2-specific =====
    // Pass completion reward: kick → teammate touches ball next, without opp interception
    passCompleteCoef: 0.05,
    // Smaller "any teammate touched after me" possession transfer reward
    possessionTransferCoef: 0.015,
    // Spread penalty when teammates are <80 px apart
    spreadPenaltyCoef: 0.0001,
    spreadPenaltyRadius: 80,
    // Support-position bonus when teammate has ball and I'm in support slot
    supportSlotCoef: 0.0002,
};

class HeadlessEnv2v2 {
    constructor(opts = {}) {
        this.opts = Object.assign({}, DEFAULT_OPTS, opts);
        const map = this.opts.map;
        const sizes = { big: [800,500], classic: [1500,1000], huge: [2400,1600] };
        const [W, H] = sizes[map] || sizes.classic;
        this.W = W; this.H = H;
        this.field = new Field(W, H, map);
        this.ball = new Ball(this.field.centerX, this.field.centerY);
        // 2 reds + 2 blues. red[0] / blue[0] are "first" players, red[1] / blue[1] second.
        // Spawn formation: red on left at y=1/3 and y=2/3 of field, blue mirror.
        this.red = [
            new Player(this.field.x + this.field.width * 0.25, this.field.y + this.field.height * 0.35, 'red', false),
            new Player(this.field.x + this.field.width * 0.25, this.field.y + this.field.height * 0.65, 'red', false),
        ];
        this.blue = [
            new Player(this.field.x + this.field.width * 0.75, this.field.y + this.field.height * 0.35, 'blue', false),
            new Player(this.field.x + this.field.width * 0.75, this.field.y + this.field.height * 0.65, 'blue', false),
        ];
        this.players = [...this.red, ...this.blue];
        this.powerUpMgr = this.opts.powerUps ? new PowerUpManager(this.field) : null;

        this.steps = 0;
        this.scoreRed = 0;
        this.scoreBlue = 0;
        this.maxSteps = this.opts.maxSteps;
        this.kickoffActive = false;
        this.kickoffTimer = 0;

        // Pre-allocated single-frame obs buffers (one per player)
        const FD = RLEncoder2v2.FEATURE_DIM;
        this.obsRed = [new Float32Array(FD), new Float32Array(FD)];
        this.obsBlue = [new Float32Array(FD), new Float32Array(FD)];
        // Frame stacks
        this.stackRed = [
            new RLEncoder2v2.FrameStack(FD, RLEncoder2v2.STACK_K),
            new RLEncoder2v2.FrameStack(FD, RLEncoder2v2.STACK_K),
        ];
        this.stackBlue = [
            new RLEncoder2v2.FrameStack(FD, RLEncoder2v2.STACK_K),
            new RLEncoder2v2.FrameStack(FD, RLEncoder2v2.STACK_K),
        ];

        // Reward shaping state
        this._prevBallProgress = 0;
        this._prevDist = [0, 0, 0, 0]; // approach-ball per player
        this._stagnationTimer = 0;
        this._lastBallTrackX = this.field.centerX;
        this._lastBallTrackY = this.field.centerY;
        // Pass tracking: who kicked last (per player), and their team
        this._lastKicker = null;
        this._lastKickerProgress = 0; // ball.x at the moment of last kick (for anti-gaming)
    }

    reset() {
        this.ball.x = this.field.centerX;
        this.ball.y = this.opts.randomKickoff
            ? this.field.centerY + (Math.random() - 0.5) * this.field.height * 0.4
            : this.field.centerY;
        this.ball.vx = 0; this.ball.vy = 0; this.ball.spin = 0;
        this.ball.superKick = 0; this.ball.superTarget = null;
        this.ball.lastKickedBy = null; this.ball.fireLevel = 0; this.ball.fireDuration = 0;
        this.ball.ghost = false; this.ball.ghostTimer = 0;
        this.ball.trailHead = 0; this.ball.trailCount = 0;

        const spots = [
            { x: 0.25, y: 0.35 }, { x: 0.25, y: 0.65 },
            { x: 0.75, y: 0.35 }, { x: 0.75, y: 0.65 },
        ];
        for (let i = 0; i < this.players.length; i++) {
            const p = this.players[i];
            const s = spots[i];
            p.x = this.field.x + this.field.width * s.x;
            p.y = this.field.y + this.field.height * s.y + (Math.random() - 0.5) * this.field.height * 0.05;
            p.vx = 0; p.vy = 0;
            p.kickCooldown = 0;
            p.pullCooldown = 0; p.pullActive = false; p.pullDuration = 0;
            p.powerUp = null; p.powerUpTimer = 0;
            p.stunTimer = 0; p.dashReady = false;
            p.kickChargeRatio = 0;
            p.momentumBonus = 0;
        }
        if (this.powerUpMgr) this.powerUpMgr.reset();

        this.steps = 0;
        this.scoreRed = 0;
        this.scoreBlue = 0;
        this.kickoffActive = false;
        this.kickoffTimer = 0;
        this._prevBallProgress = 0;
        for (let i = 0; i < 4; i++) this._prevDist[i] = Physics.distance(this.players[i], this.ball);
        this._stagnationTimer = 0;
        this._lastBallTrackX = this.ball.x;
        this._lastBallTrackY = this.ball.y;
        this._lastKicker = null;
        this._lastKickerProgress = 0;

        this._initStacks();
        return this._observe();
    }

    _resetPositions() {
        this.ball.x = this.field.centerX;
        this.ball.y = this.field.centerY + (Math.random() - 0.5) * this.field.height * 0.3;
        this.ball.vx = 0; this.ball.vy = 0;
        this.ball.spin = 0; this.ball.superKick = 0; this.ball.superTarget = null;
        this.ball.lastKickedBy = null;
        this.ball.fireLevel = 0; this.ball.fireDuration = 0;
        this.ball.ghost = false; this.ball.ghostTimer = 0;
        const spots = [
            { x: 0.25, y: 0.35 }, { x: 0.25, y: 0.65 },
            { x: 0.75, y: 0.35 }, { x: 0.75, y: 0.65 },
        ];
        for (let i = 0; i < this.players.length; i++) {
            const p = this.players[i];
            const s = spots[i];
            p.x = this.field.x + this.field.width * s.x;
            p.y = this.field.y + this.field.height * s.y;
            p.vx = 0; p.vy = 0;
            p.kickCooldown = 0;
            p.pullActive = false; p.pullCooldown = 0;
            p.stunTimer = 0;
            p.powerUp = null; p.powerUpTimer = 0;
        }
        this.kickoffActive = true;
        this.kickoffTimer = 1500;
        for (let i = 0; i < 4; i++) this._prevDist[i] = Physics.distance(this.players[i], this.ball);
        this._stagnationTimer = 0;
        this._lastBallTrackX = this.ball.x;
        this._lastBallTrackY = this.ball.y;
        this._lastKicker = null;
        this._lastKickerProgress = 0;
        this._initStacks();
    }

    _apply(player, action) {
        if (player.stunTimer > 0 || player.powerUp === 'frozen') return false;
        const mx = action.moveX || 0;
        const my = action.moveY || 0;
        const len = Math.sqrt(mx * mx + my * my);
        if (len > 1e-3) {
            const nx = mx / Math.max(len, 1);
            const ny = my / Math.max(len, 1);
            player.applyInput(Math.min(nx, 1), Math.min(ny, 1));
        }
        if (!this.opts.disablePull && action.pull) player.activatePull();
        return !!action.kick;
    }

    _hitNearbyPlayers(kicker, chargeRatio) {
        if (this.opts.disableKickPlayer) return 0;
        if (chargeRatio < 0.25) return 0;
        const hitRange = kicker.radius + 40;
        const knockForce = 1.5 + chargeRatio * 3.5;
        let stunCount = 0;
        for (const p of this.players) {
            if (p === kicker || p.team === kicker.team) continue;
            const dx = p.x - kicker.x;
            const dy = p.y - kicker.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < hitRange && dist > 0) {
                const n = Physics.normalize(dx, dy);
                p.vx += n.x * knockForce;
                p.vy += n.y * knockForce;
                p.stunTimer = 200 + chargeRatio * 800;
                stunCount++;
            }
        }
        return stunCount;
    }

    // Step the env. actions: array of 4 {moveX, moveY, charge, kick, pull}
    // ordered [red0, red1, blue0, blue1].
    step(actions) {
        const dt = 33.34;
        Physics.dtRatio = (dt / 16.67) * Physics.GAME_SPEED;

        if (this.kickoffActive) {
            this.kickoffTimer -= dt;
            if (this.kickoffTimer <= 0) this.kickoffActive = false;
        }

        const wantsKick = [false, false, false, false];
        for (let i = 0; i < 4; i++) wantsKick[i] = this._apply(this.players[i], actions[i]);

        const preBVx = this.ball.vx, preBVy = this.ball.vy;
        const preBallX = this.ball.x;

        // Track who connected (for pass attribution)
        const connected = [false, false, false, false];
        const stuns = [0, 0, 0, 0];
        const chargeCap = this.opts.disableSuperKick ? 0.79 : 1.0;
        const playerCharges = new Array(4);
        for (let i = 0; i < 4; i++) {
            const c = clamp01((actions[i] && actions[i].charge) || 0);
            playerCharges[i] = Math.min(c, chargeCap);
        }

        if (!this.kickoffActive) {
            for (let i = 0; i < 4; i++) {
                if (!wantsKick[i]) continue;
                stuns[i] = this._hitNearbyPlayers(this.players[i], playerCharges[i]);
                connected[i] = this.players[i].kick(this.ball, playerCharges[i]);
            }
        }

        // Track pass: figure out which (if any) player NEW-touched the ball this kick.
        // If the previous lastKickedBy != current and current kicker is on same team
        // as previous, that's a possession-transfer / pass.
        let passBonusForPlayer = -1;     // index of last kicker (gets pass complete reward)
        let passTransferTeam = null;
        for (let i = 0; i < 4; i++) {
            if (connected[i]) {
                const player = this.players[i];
                if (this._lastKicker && this._lastKicker !== player && this._lastKicker.team === player.team) {
                    // teammate of last kicker just touched ball → possession transfer
                    passTransferTeam = player.team;
                    // For pass-complete reward (anti-gaming), require ball advanced toward opp goal
                    // since the last kick.
                    const dirRed = player.team === 'red' ? 1 : -1;
                    const ballAdvanced = (this.ball.x - this._lastKickerProgress) * dirRed > 80;
                    if (ballAdvanced) {
                        // Find the player (last kicker) to credit
                        for (let j = 0; j < 4; j++) {
                            if (this.players[j] === this._lastKicker) { passBonusForPlayer = j; break; }
                        }
                    }
                }
                // Always update last kicker to most recent
                this._lastKicker = player;
                this._lastKickerProgress = this.ball.x;
            }
        }

        // Update entities + ball
        for (const p of this.players) p.update(dt);
        this.ball.update(dt, true);

        // Pull physics
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

        // Collisions: 4 player-ball + 6 player-player pairs
        for (const p of this.players) {
            Physics.resolveCircleCollision(p, this.ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE);
        }
        for (let i = 0; i < this.players.length; i++) {
            for (let j = i + 1; j < this.players.length; j++) {
                Physics.resolveCircleCollision(this.players[i], this.players[j], Physics.PLAYER_BOUNCE, Physics.PLAYER_BOUNCE);
            }
        }

        for (const p of this.players) Physics.constrainToField(p, this.field, true);
        Physics.constrainToField(this.ball, this.field, false);

        // Super kick homing
        if (this.ball.superKick > 0 && this.ball.superTarget) {
            const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
            if (ballSpeed > 3) {
                const goalX = this.ball.superTarget === 'right'
                    ? this.field.x + this.field.width
                    : this.field.x;
                const goalY = this.field.goalY + this.field.goalHeight / 2;
                const toGoalN = Physics.normalize(goalX - this.ball.x, goalY - this.ball.y);
                const steerForce = 0.12 * Physics.dtRatio;
                this.ball.vx += toGoalN.x * steerForce;
                this.ball.vy += toGoalN.y * steerForce;
                Physics.clampSpeed(this.ball, ballSpeed);
            } else {
                this.ball.superTarget = null;
            }
        }

        if (this.powerUpMgr) this.powerUpMgr.update(dt, this.players, false);

        // ===== Per-player rewards =====
        const r = [0, 0, 0, 0];
        const fw = this.field.width;
        const fx = this.field.x;
        const ballProgressRed = (this.ball.x - fx) / fw;
        const dProgress = ballProgressRed - this._prevBallProgress;
        this._prevBallProgress = ballProgressRed;
        const progressR = dProgress * (this.opts.progressCoef * 1000);
        const progressB = -dProgress * (this.opts.progressCoef * 1000);

        // Distribute progress to all team members
        for (let i = 0; i < 2; i++) { r[i] += progressR; r[2 + i] += progressB; }

        // Approach-ball potential shaping
        for (let i = 0; i < 4; i++) {
            const dNow = Physics.distance(this.players[i], this.ball);
            r[i] += (this._prevDist[i] - dNow) * this.opts.approachBallCoef;
            this._prevDist[i] = dNow;
        }

        // Ball deep in opp half / own half pressure
        const ballInBlueArea = ballProgressRed > 0.7;
        const ballInRedArea = ballProgressRed < 0.3;
        if (ballInBlueArea) { r[0] += this.opts.ballNearGoalBonus; r[1] += this.opts.ballNearGoalBonus; }
        if (ballInRedArea)  { r[2] += this.opts.ballNearGoalBonus; r[3] += this.opts.ballNearGoalBonus; }
        if (ballInRedArea)  { r[0] -= this.opts.ballInOwnHalfPenalty; r[1] -= this.opts.ballInOwnHalfPenalty; }
        if (ballInBlueArea) { r[2] -= this.opts.ballInOwnHalfPenalty; r[3] -= this.opts.ballInOwnHalfPenalty; }

        // Per-kick rewards (forward / activity / own-goal-direction / abuse)
        for (let i = 0; i < 4; i++) {
            if (!connected[i]) continue;
            const dvx = this.ball.vx - preBVx;
            const dirSign = (i < 2) ? 1 : -1;  // red wants +x, blue wants -x
            r[i] += this.opts.forwardKickCoef * Math.tanh(dvx * dirSign / 8);
            r[i] += this.opts.activityKickBonus;
            // Own-goal direction kick
            if (i < 2) {
                if (this.ball.vx < -3 && this.ball.x < this.field.centerX) r[i] -= this.opts.ownGoalKickPenalty;
            } else {
                if (this.ball.vx > 3 && this.ball.x > this.field.centerX) r[i] -= this.opts.ownGoalKickPenalty;
            }
            // Phase 3 abuse penalties
            if (this.opts.superKickAbusePenalty > 0 && this.ball.superKick > 0) {
                const oppSide = (i < 2) ? (this.ball.x > this.field.centerX) : (this.ball.x < this.field.centerX);
                if (!oppSide) r[i] -= this.opts.superKickAbusePenalty;
            }
            if (this.opts.kickPlayerAbusePenalty > 0 && stuns[i] > 0) {
                r[i] -= this.opts.kickPlayerAbusePenalty * stuns[i];
            }
        }

        // Pass-completion / possession-transfer rewards
        if (passBonusForPlayer >= 0) {
            r[passBonusForPlayer] += this.opts.passCompleteCoef;
        }
        if (passTransferTeam) {
            const startIdx = passTransferTeam === 'red' ? 0 : 2;
            // Smaller teamwide bonus for any successful possession transfer
            r[startIdx] += this.opts.possessionTransferCoef;
            r[startIdx + 1] += this.opts.possessionTransferCoef;
        }

        // Spread penalty (anti-clustering): teammates within radius
        const dRedTeam = Physics.distance(this.players[0], this.players[1]);
        const dBlueTeam = Physics.distance(this.players[2], this.players[3]);
        if (dRedTeam < this.opts.spreadPenaltyRadius)  { r[0] -= this.opts.spreadPenaltyCoef; r[1] -= this.opts.spreadPenaltyCoef; }
        if (dBlueTeam < this.opts.spreadPenaltyRadius) { r[2] -= this.opts.spreadPenaltyCoef; r[3] -= this.opts.spreadPenaltyCoef; }

        // Support-positioning reward: when the OTHER teammate has the ball,
        // I should be in a forward+side support slot.
        const possessor = this.ball.lastKickedBy;
        if (possessor) {
            const possessorTeam = possessor.team;
            const teamStart = possessorTeam === 'red' ? 0 : 2;
            const dirSign = possessorTeam === 'red' ? 1 : -1;
            for (let i = 0; i < 2; i++) {
                const idx = teamStart + i;
                if (this.players[idx] === possessor) continue;
                // I'm the off-ball teammate. Reward if I'm forward of possessor and sideways.
                const dx = (this.players[idx].x - possessor.x) * dirSign;
                const dy = Math.abs(this.players[idx].y - possessor.y);
                if (dx > 80 && dy > 60) {
                    r[idx] += this.opts.supportSlotCoef;
                }
            }
        }

        // Time penalty + stagnation
        for (let i = 0; i < 4; i++) r[i] -= this.opts.timePenalty;

        const sdx = this.ball.x - this._lastBallTrackX;
        const sdy = this.ball.y - this._lastBallTrackY;
        const stagDist = Math.sqrt(sdx * sdx + sdy * sdy);
        if (stagDist > this.opts.stagnationRadius) {
            this._stagnationTimer = 0;
            this._lastBallTrackX = this.ball.x;
            this._lastBallTrackY = this.ball.y;
        } else {
            this._stagnationTimer += dt;
        }
        if (this._stagnationTimer > this.opts.stagnationThreshold) {
            for (let i = 0; i < 4; i++) r[i] -= this.opts.stagnationPenalty;
        }

        // Goals
        let goal = null;
        const scorer = Physics.checkGoal(this.ball, this.field);
        if (scorer === 'red') {
            this.scoreRed++;
            r[0] += 1.0; r[1] += 1.0; r[2] -= 1.0; r[3] -= 1.0;
            goal = 'red';
            this._resetPositions();
            this._prevBallProgress = 0.5;
        } else if (scorer === 'blue') {
            this.scoreBlue++;
            r[2] += 1.0; r[3] += 1.0; r[0] -= 1.0; r[1] -= 1.0;
            goal = 'blue';
            this._resetPositions();
            this._prevBallProgress = 0.5;
        }

        this.steps++;
        const truncated = this.steps >= this.maxSteps;
        const done = truncated;

        const obs = this._observe();
        return {
            obsRedStacked: [obs.obsRed[0].stacked, obs.obsRed[1].stacked],
            obsBlueStacked: [obs.obsBlue[0].stacked, obs.obsBlue[1].stacked],
            rewards: r.map(v => v * this.opts.rewardScale),
            done, truncated, goal,
            scoreRed: this.scoreRed, scoreBlue: this.scoreBlue,
        };
    }

    _observe(pushToStack = true) {
        const gs = {
            timeLeft: Math.max(0, (this.maxSteps - this.steps) * 33.34),
            scoreDiff: this.scoreRed - this.scoreBlue,
            kickoffActive: this.kickoffActive,
        };
        const pus = this.powerUpMgr ? this.powerUpMgr.powerUps : null;
        // Encode each player's view
        // Red 0: teammate=red[1], opps=blue
        // Red 1: teammate=red[0], opps=blue
        // Blue 0: teammate=blue[1], opps=red, scoreDiff flipped
        // Blue 1: teammate=blue[0], opps=red, scoreDiff flipped
        RLEncoder2v2.encode(this.red[0], this.red[1], this.blue, this.ball, this.field, gs, pus, this.obsRed[0], false);
        RLEncoder2v2.encode(this.red[1], this.red[0], this.blue, this.ball, this.field, gs, pus, this.obsRed[1], false);
        const gsBlue = { ...gs, scoreDiff: -gs.scoreDiff };
        RLEncoder2v2.encode(this.blue[0], this.blue[1], this.red, this.ball, this.field, gsBlue, pus, this.obsBlue[0], false);
        RLEncoder2v2.encode(this.blue[1], this.blue[0], this.red, this.ball, this.field, gsBlue, pus, this.obsBlue[1], false);
        if (pushToStack) {
            for (let i = 0; i < 2; i++) this.stackRed[i].push(this.obsRed[i]);
            for (let i = 0; i < 2; i++) this.stackBlue[i].push(this.obsBlue[i]);
        }
        return {
            obsRed: [{ raw: this.obsRed[0], stacked: this.stackRed[0].get() }, { raw: this.obsRed[1], stacked: this.stackRed[1].get() }],
            obsBlue: [{ raw: this.obsBlue[0], stacked: this.stackBlue[0].get() }, { raw: this.obsBlue[1], stacked: this.stackBlue[1].get() }],
        };
    }

    _initStacks() {
        this._observe(false);
        for (let i = 0; i < 2; i++) {
            this.stackRed[i].fill(this.obsRed[i]);
            this.stackBlue[i].fill(this.obsBlue[i]);
        }
    }
}

function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
}

return { HeadlessEnv2v2 };

});
