// Headless 1v1 environment for KickZone RL.
//
// Wraps Player/Ball/Field + Physics from shared/* into a fast simulator that
// can be stepped at >1000 Hz on a modern CPU. Power-ups are off by default
// during training (curriculum); enable via opts.powerUps.
//
// Reward (per agent):
//   - +1.0 on score      (sparse, the truth signal)
//   - -1.0 on conceded
//   - +0.0005 * d_progress  (ball position toward enemy goal, normalized)
//   - +0.05 * dotForward(ball.v) when agent kicks ball forward (small)
//   - -0.05 * own_goal_kick  (penalize kicking toward own goal)
//   - -0.0001 / step  (mild time penalty so agent doesn't stall at 0:0)
//
// Episode ends on:
//   - first goal    -> reset positions, episode_done flag
//   - max_steps     -> truncated
//
// Returns step(): { obs_red, obs_blue, reward_red, reward_blue, done, info }
(function(root, factory) {
    let Physics, Entities, PowerUpManager, RLEncoder;
    if (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports) {
        Physics = require('../../shared/physics');
        Entities = require('../../shared/entities');
        PowerUpManager = require('../../shared/powerups');
        RLEncoder = require('./encoder');
    } else {
        Physics = root.Physics;
        Entities = { Player: root.Player, Ball: root.Ball, Field: root.Field };
        PowerUpManager = root.PowerUpManager;
        RLEncoder = root.RLEncoder;
    }
    const exp = factory(Physics, Entities, PowerUpManager, RLEncoder);
    if (typeof module !== 'undefined' && module.exports) module.exports = exp;
    else root.RLEnv = exp;
})(typeof self !== 'undefined' ? self : this, function(Physics, Entities, PowerUpManager, RLEncoder) {

const { Player, Ball, Field } = Entities;

const DEFAULT_OPTS = {
    map: 'classic',
    maxSteps: 1800,
    powerUps: false,
    randomKickoff: true,
    rewardScale: 1.0,
    // Reward shaping (v3): kicks are reliably net-positive in expectation,
    // and a potential-based "approach ball" term teaches chase from random init
    // without altering the optimal policy.
    progressCoef: 0.0003,
    timePenalty: 0.0,
    forwardKickCoef: 0.08,
    ownGoalKickPenalty: 0.02,
    activityKickBonus: 0.015,
    ballNearGoalBonus: 0.0006,
    ballInOwnHalfPenalty: 0.00015,
    approachBallCoef: 0.00012,
    // Phase / curriculum flags. Phase 1 disables the "easy mode" features the
    // agent would otherwise learn to abuse (super-kick autohome, kick-as-body
    // check, pull). Phase 3+ re-enables them with abuse penalties.
    disableSuperKick: true,
    disableKickPlayer: true,
    disablePull: true,
    superKickAbusePenalty: 0,
    kickPlayerAbusePenalty: 0,
    // Stagnation penalty: punishes the "wait for opponent" stall pattern.
    // If the ball stays within stagnationRadius of the tracked spot for more
    // than stagnationThreshold ms, both agents take a small per-step penalty.
    // This breaks symmetric stalemates without punishing legitimate slow play
    // (e.g. positional defense after a clearance — the ball is moving).
    stagnationPenalty: 0.0003,
    stagnationRadius: 150,
    stagnationThreshold: 3000,
};

class HeadlessEnv1v1 {
    constructor(opts = {}) {
        this.opts = Object.assign({}, DEFAULT_OPTS, opts);
        const map = this.opts.map;
        // virtual size for the chosen map
        const sizes = { big: [800,500], classic: [1500,1000], huge: [2400,1600] };
        const [W, H] = sizes[map] || sizes.classic;
        this.W = W; this.H = H;
        this.field = new Field(W, H, map);
        this.ball = new Ball(this.field.centerX, this.field.centerY);
        this.red = new Player(this.field.x + this.field.width * 0.25, this.field.centerY, 'red', false);
        this.blue = new Player(this.field.x + this.field.width * 0.75, this.field.centerY, 'blue', false);
        this.players = [this.red, this.blue];
        this.powerUpMgr = this.opts.powerUps ? new PowerUpManager(this.field) : null;

        this.steps = 0;
        this.scoreRed = 0;
        this.scoreBlue = 0;
        this.maxSteps = this.opts.maxSteps;
        this.kickoffActive = false;
        this.kickoffTimer = 0;

        // Pre-allocated obs buffers (single-frame raw observation).
        this.obsRed = new Float32Array(RLEncoder.FEATURE_DIM);
        this.obsBlue = new Float32Array(RLEncoder.FEATURE_DIM);
        // Frame-stacked observation buffers (what the policy actually consumes).
        // Stack of last K frames per side, oldest-to-newest concatenated.
        this.stackRed = new RLEncoder.FrameStack(RLEncoder.FEATURE_DIM, RLEncoder.STACK_K);
        this.stackBlue = new RLEncoder.FrameStack(RLEncoder.FEATURE_DIM, RLEncoder.STACK_K);

        // Internals for reward shaping
        this._prevBallProgress = 0;
        this._prevDistRed = 0;
        this._prevDistBlue = 0;
        // Stagnation tracking
        this._stagnationTimer = 0;
        this._lastBallTrackX = this.field.centerX;
        this._lastBallTrackY = this.field.centerY;
    }

    reset(seed = 0) {
        // Random kickoff y for diversity
        this.ball.x = this.field.centerX;
        this.ball.y = this.opts.randomKickoff
            ? this.field.centerY + (Math.random() - 0.5) * this.field.height * 0.4
            : this.field.centerY;
        this.ball.vx = 0; this.ball.vy = 0; this.ball.spin = 0;
        this.ball.superKick = 0; this.ball.superTarget = null;
        this.ball.lastKickedBy = null; this.ball.fireLevel = 0; this.ball.fireDuration = 0;
        this.ball.ghost = false; this.ball.ghostTimer = 0;
        this.ball.trailHead = 0; this.ball.trailCount = 0;

        for (const p of this.players) {
            const isRed = p.team === 'red';
            p.x = this.field.x + this.field.width * (isRed ? 0.25 : 0.75);
            p.y = this.field.centerY + (Math.random() - 0.5) * this.field.height * 0.2;
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
        this._prevDistRed = Physics.distance(this.red, this.ball);
        this._prevDistBlue = Physics.distance(this.blue, this.ball);
        this._stagnationTimer = 0;
        this._lastBallTrackX = this.ball.x;
        this._lastBallTrackY = this.ball.y;

        // Fill frame stacks with the initial observation (no leakage from
        // prior episode).
        this._initStacks();
        return this._observe();
    }

    // Soft reset: ball + player positions only, keep score/steps
    _resetPositions() {
        this.ball.x = this.field.centerX;
        this.ball.y = this.field.centerY + (Math.random() - 0.5) * this.field.height * 0.3;
        this.ball.vx = 0; this.ball.vy = 0;
        this.ball.spin = 0; this.ball.superKick = 0; this.ball.superTarget = null;
        this.ball.lastKickedBy = null;
        this.ball.fireLevel = 0; this.ball.fireDuration = 0;
        this.ball.ghost = false; this.ball.ghostTimer = 0;
        for (const p of this.players) {
            const isRed = p.team === 'red';
            p.x = this.field.x + this.field.width * (isRed ? 0.25 : 0.75);
            p.y = this.field.centerY;
            p.vx = 0; p.vy = 0;
            p.kickCooldown = 0;
            p.pullActive = false; p.pullCooldown = 0;
            p.stunTimer = 0;
            p.powerUp = null; p.powerUpTimer = 0;
        }
        this.kickoffActive = true;
        this.kickoffTimer = 1500;
        this._prevDistRed = Physics.distance(this.red, this.ball);
        this._prevDistBlue = Physics.distance(this.blue, this.ball);
        this._stagnationTimer = 0;
        this._lastBallTrackX = this.ball.x;
        this._lastBallTrackY = this.ball.y;
        // Reset frame stacks so the post-goal kickoff doesn't carry stale frames
        this._initStacks();
    }

    // Apply an action {moveX, moveY, charge, kick, pull} for a player
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

    // Mirror of game.js hitNearbyPlayers — kick-as-body-check.
    // Stuns and knocks back opponents within 40 units of the kicker when
    // chargeRatio >= 0.25. Disabled in Phase 1 training so the agent doesn't
    // learn to abuse it; re-enabled in Phase 3+ with abuse penalty.
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

    // Run one physics step (32ms = 30Hz, matching 2x sim speed used during training)
    step(actionRed, actionBlue) {
        const dt = 33.34;
        Physics.dtRatio = (dt / 16.67) * Physics.GAME_SPEED;

        // Block kicks/pulls during kickoff brief restriction window
        if (this.kickoffActive) {
            this.kickoffTimer -= dt;
            if (this.kickoffTimer <= 0) this.kickoffActive = false;
        }

        const wantsKickRed = this._apply(this.red, actionRed);
        const wantsKickBlue = this._apply(this.blue, actionBlue);

        // Capture pre-kick ball state for reward shaping
        const preBVx = this.ball.vx, preBVy = this.ball.vy;

        let redKickConnected = false;
        let blueKickConnected = false;
        let redStuns = 0, blueStuns = 0;
        // chargeCap: in Phase 1 we clamp at 0.79 so player.kick() can't trigger
        // the super-kick branch (which fires at >0.8). In later phases this is
        // set to 1.0 (no clamp) so the agent can use super-kick properly.
        const chargeCap = this.opts.disableSuperKick ? 0.79 : 1.0;
        const redCharge = Math.min(clamp01(actionRed.charge || 0), chargeCap);
        const blueCharge = Math.min(clamp01(actionBlue.charge || 0), chargeCap);
        if (wantsKickRed && !this.kickoffActive) {
            // hitNearbyPlayers fires BEFORE kick() in game.js (regardless of
            // whether kick connects). Mirror that ordering here.
            redStuns = this._hitNearbyPlayers(this.red, redCharge);
            redKickConnected = this.red.kick(this.ball, redCharge);
        }
        if (wantsKickBlue && !this.kickoffActive) {
            blueStuns = this._hitNearbyPlayers(this.blue, blueCharge);
            blueKickConnected = this.blue.kick(this.ball, blueCharge);
        }

        // Update entities
        for (const p of this.players) p.update(dt);
        this.ball.update(dt, true); // skipTrail

        // Pull physics (mirror of game.js)
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
        Physics.resolveCircleCollision(this.red, this.ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE);
        Physics.resolveCircleCollision(this.blue, this.ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE);
        Physics.resolveCircleCollision(this.red, this.blue, Physics.PLAYER_BOUNCE, Physics.PLAYER_BOUNCE);

        for (const p of this.players) Physics.constrainToField(p, this.field, true);
        Physics.constrainToField(this.ball, this.field, false);

        // Super kick homing (matches game.js)
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

        // Power-ups
        if (this.powerUpMgr) this.powerUpMgr.update(dt, this.players, false);

        // ---- Reward shaping ----
        let rRed = 0, rBlue = 0;
        const fw = this.field.width;
        const fx = this.field.x;
        const ballProgressRed = (this.ball.x - fx) / fw; // 0..1, 1 = blue side (red wants this)
        const dProgress = ballProgressRed - this._prevBallProgress;
        this._prevBallProgress = ballProgressRed;
        rRed += dProgress * (this.opts.progressCoef * 1000);
        rBlue += -dProgress * (this.opts.progressCoef * 1000);

        // Potential-based "approach ball" shaping
        const distRed = Physics.distance(this.red, this.ball);
        const distBlue = Physics.distance(this.blue, this.ball);
        rRed += (this._prevDistRed - distRed) * this.opts.approachBallCoef;
        rBlue += (this._prevDistBlue - distBlue) * this.opts.approachBallCoef;
        this._prevDistRed = distRed;
        this._prevDistBlue = distBlue;

        // Ball deep in opponent's half: continual pressure reward
        const ballInBlueArea = ballProgressRed > 0.7;
        const ballInRedArea = ballProgressRed < 0.3;
        if (ballInBlueArea) rRed += this.opts.ballNearGoalBonus;
        if (ballInRedArea) rBlue += this.opts.ballNearGoalBonus;

        // Penalize ball stuck in your own half — pressures the agent to push forward
        // so passive defensive parking does not stay reward-neutral.
        if (ballInRedArea) rRed -= this.opts.ballInOwnHalfPenalty;
        if (ballInBlueArea) rBlue -= this.opts.ballInOwnHalfPenalty;

        // Per-kick rewards (forward kicks rewarded, own-goal-direction kicks penalized,
        // and a tiny bonus for kicking at all so passive standing isn't reward-equivalent).
        if (redKickConnected) {
            const dvx = this.ball.vx - preBVx;
            rRed += this.opts.forwardKickCoef * Math.tanh(dvx / 8);
            rRed += this.opts.activityKickBonus;
            if (this.ball.vx < -3 && this.ball.x < this.field.centerX) {
                rRed -= this.opts.ownGoalKickPenalty;
            }
            // Phase 3+ abuse penalties
            if (this.opts.superKickAbusePenalty > 0 && this.ball.superKick > 0) {
                // Only valid super-kick: aimed, well-positioned, away from own goal.
                // Otherwise penalize spamming it from anywhere.
                const ballAdvanced = this.ball.x > this.field.centerX;
                if (!ballAdvanced) rRed -= this.opts.superKickAbusePenalty;
            }
            if (this.opts.kickPlayerAbusePenalty > 0 && redStuns > 0) {
                // Penalize using kick primarily as a body-check
                rRed -= this.opts.kickPlayerAbusePenalty * redStuns;
            }
        }
        if (blueKickConnected) {
            const dvx = this.ball.vx - preBVx;
            rBlue += this.opts.forwardKickCoef * Math.tanh(-dvx / 8);
            rBlue += this.opts.activityKickBonus;
            if (this.ball.vx > 3 && this.ball.x > this.field.centerX) {
                rBlue -= this.opts.ownGoalKickPenalty;
            }
            if (this.opts.superKickAbusePenalty > 0 && this.ball.superKick > 0) {
                const ballAdvanced = this.ball.x < this.field.centerX;
                if (!ballAdvanced) rBlue -= this.opts.superKickAbusePenalty;
            }
            if (this.opts.kickPlayerAbusePenalty > 0 && blueStuns > 0) {
                rBlue -= this.opts.kickPlayerAbusePenalty * blueStuns;
            }
        }

        // Optional flat time penalty (disabled in v2 — own-half pressure does the job)
        rRed -= this.opts.timePenalty;
        rBlue -= this.opts.timePenalty;

        // Stagnation penalty: ball not moving meaningfully → both punished.
        // The ball-position tracker resets each time the ball makes a real move,
        // so legitimate slow phases (clearance, then both regroup) don't trigger
        // it as long as the ball is actually progressing somewhere.
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
            rRed -= this.opts.stagnationPenalty;
            rBlue -= this.opts.stagnationPenalty;
        }

        // Goals
        let goal = null;
        const scorer = Physics.checkGoal(this.ball, this.field);
        if (scorer === 'red') {
            this.scoreRed++;
            rRed += 1.0;
            rBlue -= 1.0;
            goal = 'red';
            this._resetPositions();
            this._prevBallProgress = 0.5;
        } else if (scorer === 'blue') {
            this.scoreBlue++;
            rBlue += 1.0;
            rRed -= 1.0;
            goal = 'blue';
            this._resetPositions();
            this._prevBallProgress = 0.5;
        }

        this.steps++;
        const truncated = this.steps >= this.maxSteps;
        const done = truncated; // continuing-task style: only truncate, never "done" without truncation

        const obs = this._observe();
        return {
            obsRed: obs.obsRed,
            obsBlue: obs.obsBlue,
            obsRedStacked: obs.obsRedStacked,
            obsBlueStacked: obs.obsBlueStacked,
            rewardRed: rRed * this.opts.rewardScale,
            rewardBlue: rBlue * this.opts.rewardScale,
            done,
            truncated,
            goal,
            scoreRed: this.scoreRed,
            scoreBlue: this.scoreBlue,
        };
    }

    _observe(pushToStack = true) {
        const gs = {
            timeLeft: Math.max(0, (this.maxSteps - this.steps) * 33.34),
            scoreDiff: this.scoreRed - this.scoreBlue,
            kickoffActive: this.kickoffActive,
        };
        const pus = this.powerUpMgr ? this.powerUpMgr.powerUps : null;
        RLEncoder.encode(this.red, this.blue, this.ball, this.field, gs, pus, this.obsRed, false);
        const gsBlue = { ...gs, scoreDiff: -gs.scoreDiff };
        RLEncoder.encode(this.blue, this.red, this.ball, this.field, gsBlue, pus, this.obsBlue, false);
        if (pushToStack) {
            this.stackRed.push(this.obsRed);
            this.stackBlue.push(this.obsBlue);
        }
        return {
            obsRed: this.obsRed,
            obsBlue: this.obsBlue,
            obsRedStacked: this.stackRed.get(),
            obsBlueStacked: this.stackBlue.get(),
        };
    }

    // Initialize frame stacks (called after reset) — fills all slots with the
    // current frame so the policy doesn't see stale history from before reset.
    _initStacks() {
        // Compute one observation without pushing
        this._observe(false);
        this.stackRed.fill(this.obsRed);
        this.stackBlue.fill(this.obsBlue);
    }
}

function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
}

return { HeadlessEnv1v1 };

});
