// Skill drills for KickZone RL.
//
// Full matches teach slowly: the reward (a goal) is rare, and a learning
// agent spends most of a match nowhere near the skill it is trying to learn.
// A drill is a short scenario (3–6 s) built around one skill, with its own
// start state, end condition and reward, so the signal arrives every few
// seconds:
//
//   dribble  carry the ball into the attacking third without losing it
//   defend   keep a shot or an attacker out of your goal, then clear the ball
//   shoot    score from the attacking half (levels 2–3: past a goalkeeper)
//   pull     win a loose or carried ball, pulling it in once it is in range
//
// Level 1 has no opponent; levels 2 and 3 add a scripted one (slow, then
// full speed).
//
// The agent is always red (attacking right). Observations, actions and
// physics are exactly those of HeadlessEnv1v1 (the encoder mirrors blue's
// view), so a drill-trained policy can play either side of a real match.
//
// Every episode ends with an outcome. The share of successful outcomes is
// the skill's metric (evaluate()); collectRollout() + computeEpisodicGAE()
// produce PPO batches.
(function(root, factory) {
    let Physics, RLEnv, RLEncoder;
    if (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports) {
        Physics = require('../../shared/physics');
        RLEnv = require('./env');
        RLEncoder = require('./encoder');
    } else {
        Physics = root.Physics;
        RLEnv = root.RLEnv;
        RLEncoder = root.RLEncoder;
    }
    const exp = factory(Physics, RLEnv, RLEncoder);
    if (typeof module !== 'undefined' && module.exports) module.exports = exp;
    else root.RLDrills = exp;
})(typeof self !== 'undefined' ? self : this, function(Physics, RLEnv, RLEncoder) {

const { HeadlessEnv1v1 } = RLEnv;

const SKILLS = ['dribble', 'defend', 'shoot', 'pull'];
const MAX_LEVEL = 3;
const PULL_RANGE = 150;   // matches the pull physics in env.js and game.js
const IDLE = Object.freeze({ moveX: 0, moveY: 0, kick: false, charge: 0, pull: false });

class DrillEnv extends HeadlessEnv1v1 {
    constructor(skill, opts = {}) {
        const drill = DRILLS[skill];
        if (!drill) throw new Error('Unknown drill: ' + skill);
        // Pull is part of every skill; super-kick and kick-as-body-check stay
        // off like in match Phase 1 (see env.js) unless opts turn them on.
        super(Object.assign({ map: 'classic', powerUps: false, disablePull: false }, opts));
        this.skill = skill;
        this.drill = drill;
        this.level = opts.level || 1;
        this.rng = opts.rng || Math.random;
        this.g = fieldGeometry(this.field);
        // Ball at the player's feet: close enough to keep pushing or kick
        this.controlDist = this.red.radius + this.ball.radius + 20;
        this.active = false;      // an episode is in progress
        this.outcome = null;
        this.success = false;
        this.d = {};              // per-episode drill state
        this._gs = { timeLeft: 60000, scoreDiff: 0, kickoffActive: false };
    }

    reset(level = this.level) {
        this.level = Math.max(1, Math.min(MAX_LEVEL, level | 0));
        const ball = this.ball;
        ball.vx = 0; ball.vy = 0; ball.spin = 0;
        ball.superKick = 0; ball.superTarget = null; ball.lastKickedBy = null;
        ball.fireLevel = 0; ball.fireDuration = 0; ball.ghost = false; ball.ghostTimer = 0;
        for (const p of this.players) {
            p.vx = 0; p.vy = 0;
            p.kickCooldown = 0;
            p.pullCooldown = 0; p.pullActive = false; p.pullDuration = 0;
            p.powerUp = null; p.powerUpTimer = 0;
            p.stunTimer = 0; p.dashReady = false;
            p.kickChargeRatio = 0; p.momentumBonus = 0;
        }
        // Pull is on cooldown in half the episodes so skills also learn to
        // manage without it (the pull drill makes it ready in setup).
        if (this.rng() < 0.5) this.red.pullCooldown = this.rng() * this.red.pullCooldownTime;

        this.steps = 0;
        this.scoreRed = 0;
        this.scoreBlue = 0;
        this.kickoffActive = false;
        this.kickoffTimer = 0;
        this.outcome = null;
        this.success = false;
        // The match clock and score don't matter to a skill: randomize them so
        // the policy learns to ignore those features.
        this._gs = {
            timeLeft: this.rng() * 180000,
            scoreDiff: Math.floor(this.rng() * 5) - 2,
            kickoffActive: false,
        };
        this.d = { lastTouch: null, pullsUsed: 0, wastedPulls: 0 };
        this.maxSteps = this.drill.maxSteps[this.level - 1];
        this.drill.setup(this, this.level);
        this.active = true;
        this._initStacks();
        return this.stackRed.get();
    }

    _gameState() {
        return this._gs;
    }

    // Advance one step with the agent's (red's) action; the drill drives blue.
    // Returns { obs, reward, done, outcome, success }.
    step(action) {
        const red = this.red;
        const pullReady = red.pullCooldown <= 0 && !red.pullActive;
        const distBefore = Physics.distance(red, this.ball);
        const opp = this.level > 1 ? this.drill.opponent(this, this.level) : IDLE;
        const sim = this._simulate(action, opp);
        this.steps++;
        if (sim.redTouched) this.d.lastTouch = 'red';
        else if (sim.blueTouched) this.d.lastTouch = 'blue';

        let { reward, outcome } = this.drill.score(this, sim);
        // A pull started out of range switches straight off and burns the
        // whole cooldown (8 s) — in a match that's a wasted ability.
        if (action.pull && pullReady) {
            if (distBefore >= PULL_RANGE) {
                this.d.wastedPulls++;
                reward -= this.drill.wastedPullPenalty;
            } else {
                this.d.pullsUsed++;
            }
        }
        if (!outcome && this.steps >= this.maxSteps) {
            const t = this.drill.timeout(this);
            outcome = t.outcome;
            reward += t.reward;
        }
        this.outcome = outcome || null;
        const done = !!outcome;
        if (done) {
            this.active = false;
            this.success = this.drill.successOutcomes.includes(outcome);
        }
        this._observe();
        return { obs: this.stackRed.get(), reward, done, outcome: this.outcome, success: this.success };
    }

    // Field progress of an x coordinate from red's side: 0 = own goal line,
    // 1 = opponent's goal line.
    progress(x) {
        return (x - this.g.fx) / this.g.fw;
    }
}

// --- Drill definitions --------------------------------------------------------
//
// setup(env, level)   place ball and players (agent = red)
// opponent(env, level) blue's action on levels 2–3
// score(env, sim)     per-step { reward, outcome } (outcome null = continue)
// timeout(env)        { outcome, reward } when maxSteps runs out

const DRILLS = {
    dribble: {
        maxSteps: [180, 180, 180],          // 6 s
        successOutcomes: ['carried', 'scored'],
        wastedPullPenalty: 0.1,
        targetProgress: 0.78,               // the attacking third
        loseDist: 160,                      // farther than this and the ball is gone
        setup(env, level) {
            const { g, rng, red, ball, blue } = env;
            red.x = g.fx + g.fw * lerp(0.1, 0.5, rng());
            red.y = lerp(g.fy + 80, g.fy + g.fh - 80, rng());
            // Ball at the player's feet, within ±60° of straight ahead
            const a = (rng() * 2 - 1) * Math.PI / 3;
            const d = red.radius + ball.radius + 2;
            ball.x = red.x + Math.cos(a) * d;
            ball.y = red.y + Math.sin(a) * d;
            if (level === 1) {
                park(env, blue);
            } else {
                // A presser somewhere ahead
                const p0 = Math.min(0.85, env.progress(red.x) + 0.25);
                blue.x = g.fx + g.fw * lerp(p0, 0.92, rng());
                blue.y = lerp(g.fy + 60, g.fy + g.fh - 60, rng());
            }
            env.d.prevProgress = env.progress(ball.x);
            env.d.prevPhi = 0;
        },
        opponent(env, level) {
            return pressBot(env, level === 2 ? 0.55 : 1.0);
        },
        score(env, sim) {
            const drill = DRILLS.dribble;
            const ballP = env.progress(env.ball.x);
            const d = Physics.distance(env.red, env.ball);
            // Ball moved toward the opponent's goal
            let reward = 2.0 * (ballP - env.d.prevProgress);
            env.d.prevProgress = ballP;
            // Potential-based: drifting away from the ball costs, coming back refunds it
            const phi = -0.3 * Math.max(0, d - env.controlDist) / (drill.loseDist - env.controlDist);
            reward += phi - env.d.prevPhi;
            env.d.prevPhi = phi;

            if (sim.scorer === 'red') return { reward: reward + 1, outcome: 'scored' };
            if (sim.scorer === 'blue') return { reward: reward - 1.5, outcome: 'own_goal' };
            if (sim.blueTouched) return { reward: reward - 1, outcome: 'stolen' };
            if (d > drill.loseDist) return { reward: reward - 1, outcome: 'lost' };
            if (ballP >= drill.targetProgress && d <= env.controlDist + 20) {
                return { reward: reward + 1, outcome: 'carried' };
            }
            return { reward, outcome: null };
        },
        timeout() {
            // As bad as losing the ball: otherwise standing still (no risk of
            // losing it) beats trying, and PPO settles there.
            return { outcome: 'timeout', reward: -1 };
        },
    },

    defend: {
        maxSteps: [120, 180, 180],          // 4 s for a shot, 6 s against an attacker
        successOutcomes: ['cleared', 'held'],
        wastedPullPenalty: 0.1,
        setup(env, level) {
            const { g, rng, red, ball, blue } = env;
            if (level === 1) {
                // A shot from red's half aimed inside the goal mouth, fast
                // enough to get there if nobody touches it.
                ball.x = g.fx + g.fw * lerp(0.2, 0.5, rng());
                ball.y = lerp(g.fy + 60, g.fy + g.fh - 60, rng());
                const tx = g.fx - 10;
                const ty = lerp(g.goalTop + 25, g.goalBot - 25, rng());
                const dx = tx - ball.x, dy = ty - ball.y;
                const dist = Math.hypot(dx, dy);
                const vMin = dist / (ballTravelPerSpeed() * 0.75);
                const v = Math.min(11, Math.max(4, vMin) + rng() * 3);
                ball.vx = dx / dist * v;
                ball.vy = dy / dist * v;
                // Somewhere the shot can be reached from in time
                const contact = red.radius + ball.radius - 8;
                for (let tries = 0; tries < 30; tries++) {
                    placeAwayFrom(env, red, ball, 0.03, 0.4, 70);
                    if (interceptPoint(env, red, ball, contact)) break;
                }
                park(env, blue);
            } else {
                // An attacker in red's half running at goal with the ball
                blue.x = g.fx + g.fw * lerp(0.38, 0.5, rng());
                blue.y = lerp(g.fy + 80, g.fy + g.fh - 80, rng());
                ball.x = blue.x - (blue.radius + ball.radius + 2);
                ball.y = blue.y;
                env.d.aimY = lerp(g.goalTop + 30, g.goalBot - 30, rng());
                placeAwayFrom(env, red, ball, 0.05, 0.3, 120);
            }
            env.d.prevPhi = 0.5 * env.progress(ball.x);
            env.d.touched = false;
        },
        opponent(env, level) {
            return attackerBot(env, level === 2 ? 0.55 : 1.0);
        },
        score(env, sim) {
            const ballP = env.progress(env.ball.x);
            // Potential-based: ball moving away from the own goal
            const phi = 0.5 * ballP;
            let reward = phi - env.d.prevPhi;
            env.d.prevPhi = phi;
            if (sim.redTouched && !env.d.touched) {
                env.d.touched = true;
                reward += 0.1;
            }
            if (sim.scorer === 'blue') {
                return env.d.lastTouch === 'red'
                    ? { reward: reward - 1.5, outcome: 'own_goal' }
                    : { reward: reward - 1, outcome: 'conceded' };
            }
            // Cleared: the agent sent it over halfway (or all the way in)
            if (sim.scorer === 'red' || (ballP >= 0.5 && env.d.lastTouch === 'red')) {
                return { reward: reward + 1, outcome: 'cleared' };
            }
            return { reward, outcome: null };
        },
        timeout(env) {
            // No goal, but a ball still sitting in front of the goal isn't safe
            return env.progress(env.ball.x) >= 0.25
                ? { outcome: 'held', reward: 0.3 }
                : { outcome: 'danger', reward: -0.3 };
        },
    },

    shoot: {
        maxSteps: [120, 120, 120],          // 4 s
        successOutcomes: ['scored'],
        wastedPullPenalty: 0.1,
        setup(env, level) {
            const { g, rng, red, ball, blue } = env;
            ball.x = g.fx + g.fw * lerp(0.55, 0.85, rng());
            ball.y = lerp(g.fy + 70, g.fy + g.fh - 70, rng());
            // Agent somewhere around the ball, mostly on the side away from goal
            const back = Math.atan2(ball.y - g.goalCY, ball.x - g.right);
            for (let tries = 0; tries < 20; tries++) {
                const a = back + (rng() * 2 - 1) * (110 * Math.PI / 180);
                const d = lerp(50, 200, rng());
                red.x = clamp(ball.x + Math.cos(a) * d, g.fx + 30, g.right - 30);
                red.y = clamp(ball.y + Math.sin(a) * d, g.fy + 30, g.fy + g.fh - 30);
                if (Physics.distance(red, ball) > red.radius + ball.radius + 6) break;
            }
            if (level === 1) {
                park(env, blue);
            } else {
                blue.x = g.right - blue.radius - 20;
                blue.y = g.goalCY + (rng() - 0.5) * 80;
            }
            env.d.prevDist = Physics.distance(red, ball);
            env.d.aimBonusGiven = false;
        },
        opponent(env, level) {
            return keeperBot(env, level === 2 ? 0.45 : 0.9);
        },
        score(env, sim) {
            const { g, ball } = env;
            const d = Physics.distance(env.red, ball);
            let reward = -0.003;                       // shoot sooner rather than later
            reward += 0.3 * (env.d.prevDist - d) / g.fw;
            env.d.prevDist = d;
            // One-time bonus for the first kick that's on target
            if (sim.redKickConnected && !env.d.aimBonusGiven && headingIntoGoal(env)) {
                env.d.aimBonusGiven = true;
                reward += 0.15;
            }
            if (sim.scorer === 'red') return { reward: reward + 1, outcome: 'scored' };
            if (sim.scorer === 'blue') return { reward: reward - 1.5, outcome: 'own_goal' };
            if (sim.blueTouched) return { reward: reward - 0.5, outcome: 'saved' };
            const atEndLine = ball.x >= g.right - ball.radius - 0.5;
            if (atEndLine && (ball.y <= g.goalTop || ball.y >= g.goalBot)) {
                return { reward: reward - 0.5, outcome: 'missed' };
            }
            if (env.progress(ball.x) < 0.35) return { reward: reward - 0.5, outcome: 'missed' };
            return { reward, outcome: null };
        },
        timeout() {
            return { outcome: 'timeout', reward: -0.5 };
        },
    },

    pull: {
        maxSteps: [90, 120, 120],           // 3 s for a loose ball, 4 s against a carrier
        successOutcomes: ['won'],
        wastedPullPenalty: 0.3,
        setup(env, level) {
            const { g, rng, red, ball, blue } = env;
            red.pullCooldown = 0;
            if (level === 1) {
                // A loose ball 70–210 away, usually rolling away from the agent
                red.x = g.fx + g.fw * lerp(0.15, 0.85, rng());
                red.y = lerp(g.fy + 60, g.fy + g.fh - 60, rng());
                const a = rng() * Math.PI * 2;
                const d = lerp(70, 210, rng());
                ball.x = clamp(red.x + Math.cos(a) * d, g.fx + 40, g.right - 40);
                ball.y = clamp(red.y + Math.sin(a) * d, g.fy + 40, g.fy + g.fh - 40);
                if (rng() < 0.7) {
                    const away = Math.atan2(ball.y - red.y, ball.x - red.x) + (rng() * 2 - 1) * 0.7;
                    const v = lerp(2, 6, rng());
                    ball.vx = Math.cos(away) * v;
                    ball.vy = Math.sin(away) * v;
                }
                park(env, blue);
            } else {
                // An attacker carrying the ball toward red's goal
                blue.x = g.fx + g.fw * lerp(0.35, 0.8, rng());
                blue.y = lerp(g.fy + 80, g.fy + g.fh - 80, rng());
                ball.x = blue.x - (blue.radius + ball.radius + 2);
                ball.y = blue.y;
                env.d.aimY = lerp(g.goalTop + 30, g.goalBot - 30, rng());
                for (let tries = 0; tries < 20; tries++) {
                    const a = rng() * Math.PI * 2;
                    const d = lerp(100, 200, rng());
                    red.x = clamp(ball.x + Math.cos(a) * d, g.fx + 30, g.right - 30);
                    red.y = clamp(ball.y + Math.sin(a) * d, g.fy + 30, g.fy + g.fh - 30);
                    if (Physics.distance(red, blue) > red.radius + blue.radius + 40
                        && Physics.distance(red, ball) > 90) break;
                }
            }
            env.d.prevDist = Physics.distance(red, ball);
        },
        opponent(env, level) {
            return attackerBot(env, level === 2 ? 0.55 : 1.0);
        },
        score(env, sim) {
            const { red, ball, blue } = env;
            const d = Physics.distance(red, ball);
            let reward = 0.0015 * (env.d.prevDist - d);
            env.d.prevDist = d;
            if (sim.scorer === 'blue') return { reward: reward - 1, outcome: 'conceded' };
            const relSpeed = Math.hypot(ball.vx - red.vx, ball.vy - red.vy);
            const oppClear = env.level === 1 || Physics.distance(blue, ball) > env.controlDist;
            if (sim.scorer === 'red' || (d <= env.controlDist && relSpeed < 4 && oppClear)) {
                // Faster wins pay more
                return { reward: reward + 1 + 0.5 * (1 - env.steps / env.maxSteps), outcome: 'won' };
            }
            return { reward, outcome: null };
        },
        timeout() {
            return { outcome: 'timeout', reward: -0.5 };
        },
    },
};

// --- Scripted opponents (blue) ------------------------------------------------

// Runs at the ball (aiming slightly ahead of it); any touch steals it.
function pressBot(env, speed) {
    const { blue, ball } = env;
    return steer(blue, ball.x + ball.vx * 6, ball.y + ball.vy * 6, speed);
}

// Dribbles at red's goal and shoots once close enough with a clear angle.
function attackerBot(env, speed) {
    const { blue, ball, g } = env;
    const aimY = env.d.aimY !== undefined ? env.d.aimY : g.goalCY;
    const inRange = Physics.distance(blue, ball) < blue.radius + ball.radius + 18;
    if (inRange && env.progress(ball.x) < 0.38) {
        // Kick direction is player -> ball; shoot if that line enters the goal mouth
        const kx = ball.x - blue.x, ky = ball.y - blue.y;
        if (kx < -1) {
            const yAtLine = ball.y + ky * ((g.fx - ball.x) / kx);
            if (yAtLine > g.goalTop + 15 && yAtLine < g.goalBot - 15) {
                return { moveX: 0, moveY: 0, kick: true, charge: 0.6, pull: false };
            }
        }
    }
    return dribbleToward(blue, ball, g.fx, aimY, speed);
}

// Goalkeeper: tracks the ball along the goal mouth, stepping out when it's near.
function keeperBot(env, speed) {
    const { blue, ball, g } = env;
    const lineX = g.right - blue.radius - 20;
    const tx = Math.abs(ball.x - g.right) < 260 ? lineX - 40 : lineX;
    const ty = clamp(ball.y, g.goalTop + 10, g.goalBot - 10);
    return steer(blue, tx, ty, speed);
}

// --- Reference heuristics (red) -------------------------------------------------
//
// Hand-written solutions to each drill. They prove a drill is solvable (see
// test/drills.test.js), give a baseline for the learned policy to beat, and
// can serve as demonstrations for behavior cloning.

const HEURISTICS = {
    dribble(env) {
        const { red, ball, g } = env;
        return dribbleToward(red, ball, g.right, g.goalCY, 1.0);
    },

    defend(env) {
        const { red, ball, g } = env;
        const d = Physics.distance(red, ball);
        // Clear it whenever the kick would send it upfield
        if (d < red.radius + ball.radius + 19 && ball.x - red.x > 4) {
            return { moveX: 1, moveY: 0, kick: true, charge: 0.7, pull: false };
        }
        // Ball heading for our goal: get onto its path in front of it
        if (ball.vx < -1) {
            const cut = interceptPoint(env, red, ball);
            if (cut) return steer(red, cut.x, cut.y, 1.0);
        }
        // Otherwise win it and push it upfield
        return dribbleToward(red, ball, g.right, g.goalCY, 1.0);
    },

    shoot(env) {
        const { red, ball, blue, g } = env;
        // Aim for the side of the goal the keeper isn't covering
        let ty = g.goalCY;
        if (env.level > 1) ty = blue.y > g.goalCY ? g.goalTop + 35 : g.goalBot - 35;
        const tx = g.right;
        const ux = tx - ball.x, uy = ty - ball.y;
        const ul = Math.hypot(ux, uy) || 1;
        const bx = ball.x - red.x, by = ball.y - red.y;
        const bl = Math.hypot(bx, by) || 1;
        const align = (bx * ux + by * uy) / (bl * ul);
        // Kick once lined up and nearly still: a moving kicker adds its
        // velocity and spin to the ball and curls it wide
        const settled = Math.hypot(red.vx, red.vy) < 1;
        if (bl < red.radius + ball.radius + 19 && align > 0.985 && settled) {
            return { moveX: 0, moveY: 0, kick: true, charge: 0.7, pull: false };
        }
        // Line up just behind the ball without bumping it off the shot line
        return dribbleToward(red, ball, tx, ty, 1.0, true);
    },

    pull(env) {
        const { red, ball } = env;
        const d = Physics.distance(red, ball);
        const m = steer(red, ball.x + ball.vx * 8, ball.y + ball.vy * 8, 1.0);
        const ready = red.pullCooldown <= 0 && !red.pullActive;
        m.pull = ready && d < PULL_RANGE - 10 && d > env.controlDist;
        return m;
    },
};

// --- Movement helpers -----------------------------------------------------------

// Move toward a point, easing off within ~40 units so it doesn't overshoot.
function steer(self, tx, ty, speed) {
    const dx = tx - self.x, dy = ty - self.y;
    const d = Math.hypot(dx, dy);
    if (d < 2) return { moveX: 0, moveY: 0, kick: false, charge: 0, pull: false };
    const s = speed * Math.min(1, d / 40);
    return { moveX: dx / d * s, moveY: dy / d * s, kick: false, charge: 0, pull: false };
}

// Push the ball toward (tx, ty) with the body: get behind it, then run through
// it. With stopBehind, stop on the spot just behind the ball instead (to shoot).
function dribbleToward(self, ball, tx, ty, speed, stopBehind = false) {
    let ux = tx - ball.x, uy = ty - ball.y;
    const ul = Math.hypot(ux, uy) || 1;
    ux /= ul; uy /= ul;
    const R = self.radius + ball.radius;
    const rx = self.x - ball.x, ry = self.y - ball.y;  // ball -> player
    const rl = Math.hypot(rx, ry) || 1;
    const align = -(rx * ux + ry * uy) / rl;           // 1 = directly behind the ball
    if (stopBehind && align > 0.85) {
        return steer(self, ball.x - ux * (R + 12), ball.y - uy * (R + 12), speed);
    }
    if (align > 0.85 && rl < R + 30) {
        // Lined up: run through the ball's center toward the target
        let mx = ux - rx / rl, my = uy - ry / rl;
        const ml = Math.hypot(mx, my) || 1;
        return { moveX: mx / ml * speed, moveY: my / ml * speed, kick: false, charge: 0, pull: false };
    }
    const along = rx * ux + ry * uy;
    if (along > -R * 0.3) {
        // Beside or in front of the ball: swing around it on the side we're on
        const lat = rx * -uy + ry * ux;
        const side = lat >= 0 ? 1 : -1;
        const wx = ball.x - uy * side * (R + 25) - ux * R * 0.6;
        const wy = ball.y + ux * side * (R + 25) - uy * R * 0.6;
        return steer(self, wx, wy, speed);
    }
    return steer(self, ball.x - ux * (R + 4), ball.y - uy * (R + 4), speed);
}

// Earliest point on a moving ball's path that `self` can get within `slack` of
// before the ball does (null if none before it reaches the goal line).
// Ignores wall bounces.
function interceptPoint(env, self, ball, slack = 0) {
    const dtRatio = (33.34 / 16.67) * Physics.GAME_SPEED;   // one env step
    const fric = Math.pow(Physics.BALL_FRICTION, dtRatio);
    const reach = Physics.MAX_PLAYER_SPEED * dtRatio * 0.8;  // per step, allowing for acceleration
    let x = ball.x, y = ball.y, vx = ball.vx, vy = ball.vy;
    for (let k = 1; k <= 90; k++) {
        vx *= fric; vy *= fric;
        x += vx * dtRatio; y += vy * dtRatio;
        if (x < env.g.fx) return null;
        if ((Math.hypot(x - self.x, y - self.y) - slack) / reach + 2 <= k) {
            // Stand slightly ahead of where the ball will be, so it runs into us
            const v = Math.hypot(vx, vy) || 1;
            return { x: x + vx / v * 10, y: y + vy / v * 10 };
        }
    }
    return null;
}

// --- Placement helpers ------------------------------------------------------------

function fieldGeometry(field) {
    return {
        fx: field.x,
        fy: field.y,
        fw: field.width,
        fh: field.height,
        right: field.x + field.width,
        goalTop: field.goalY,
        goalBot: field.goalY + field.goalHeight,
        goalCY: field.goalY + field.goalHeight / 2,
    };
}

// Move an unused opponent off the pitch (into the margin above it, which
// players can stand in but the ball never reaches).
function park(env, p) {
    p.x = env.g.fx + env.g.fw / 2;
    p.y = Math.max(p.radius, env.g.fy / 2);
}

// Random spot in a band of field progress, at least minDist from `other`.
function placeAwayFrom(env, p, other, pMin, pMax, minDist) {
    const { g, rng } = env;
    for (let tries = 0; tries < 30; tries++) {
        p.x = g.fx + g.fw * lerp(pMin, pMax, rng());
        p.y = lerp(g.fy + 50, g.fy + g.fh - 50, rng());
        if (Physics.distance(p, other) >= minDist) return;
    }
}

// Would the ball, on its current straight-line path, cross the opponent's
// goal line inside the mouth?
function headingIntoGoal(env) {
    const { ball, g } = env;
    if (ball.vx <= 0.5) return false;
    const yAtLine = ball.y + ball.vy * ((g.right - ball.x) / ball.vx);
    return yAtLine > g.goalTop && yAtLine < g.goalBot;
}

// Distance a ball rolls per unit of initial speed before friction stops it
function ballTravelPerSpeed() {
    return 1 / (1 - Physics.BALL_FRICTION);
}

function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// --- Training and evaluation --------------------------------------------------------

// Small seeded PRNG (mulberry32) so evaluations are reproducible.
function seededRandom(seed) {
    let s = seed | 0;
    return function() {
        s = s + 0x6D2B79F5 | 0;
        let t = Math.imul(s ^ s >>> 15, 1 | s);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Deterministic (mean) action of a policy for the drill's agent.
function policyActor(policy) {
    return (env) => {
        const { raw } = policy.forward(env.stackRed.get());
        return {
            moveX: Math.tanh(raw[0]),
            moveY: Math.tanh(raw[1]),
            charge: sigmoid(raw[2]) * 0.95,   // same squash as worker.js
            kick: sigmoid(raw[3]) > 0.5,
            pull: sigmoid(raw[4]) > 0.5,
        };
    };
}

// Run `episodes` drill episodes with act(env) -> action and report how often
// the skill succeeded and how the failures happened.
function evaluate(skill, act, opts = {}) {
    const episodes = opts.episodes || 200;
    const level = opts.level || 1;
    const env = new DrillEnv(skill, Object.assign({}, opts.envOpts, { level, rng: seededRandom(opts.seed || 1) }));
    const outcomes = {};
    let successes = 0, totalReward = 0, totalSteps = 0, pullEpisodes = 0, wastedPulls = 0;
    let rewardSuccess = 0, rewardFail = 0;
    for (let ep = 0; ep < episodes; ep++) {
        env.reset(level);
        let epReward = 0;
        for (;;) {
            const out = env.step(act(env));
            epReward += out.reward;
            if (out.done) break;
        }
        outcomes[env.outcome] = (outcomes[env.outcome] || 0) + 1;
        if (env.success) { successes++; rewardSuccess += epReward; }
        else rewardFail += epReward;
        totalReward += epReward;
        totalSteps += env.steps;
        if (env.d.pullsUsed > 0) pullEpisodes++;
        wastedPulls += env.d.wastedPulls;
    }
    const failures = episodes - successes;
    return {
        skill,
        level,
        episodes,
        successRate: successes / episodes,
        outcomes,
        avgReward: totalReward / episodes,
        avgRewardSuccess: successes ? rewardSuccess / successes : null,
        avgRewardFail: failures ? rewardFail / failures : null,
        avgSteps: totalSteps / episodes,
        pullUseRate: pullEpisodes / episodes,
        wastedPullsPerEpisode: wastedPulls / episodes,
    };
}

// Collect T steps of experience from the stochastic policy. Episodes carry
// over between calls; levelFor() picks the level of each new episode.
// dones[t] = 1 means the episode ended with step t (use computeEpisodicGAE).
function collectRollout(env, policy, T, levelFor) {
    const inDim = policy.inDim;
    const batch = {
        obs: new Float32Array(T * inDim),
        actsPre: new Float32Array(T * 3),
        kicks: new Uint8Array(T),
        pulls: new Uint8Array(T),
        logProbs: new Float32Array(T),
        values: new Float32Array(T),
        rewards: new Float32Array(T),
        dones: new Uint8Array(T),
        nextValue: 0,
        episodes: [],      // { level, outcome, success, reward, steps } per finished episode
    };
    const pickLevel = levelFor || (() => env.level);
    if (!env.active) { env.reset(pickLevel()); env._epReward = 0; }
    for (let t = 0; t < T; t++) {
        const obs = env.stackRed.get();
        const s = policy.sampleAction(obs);
        batch.obs.set(obs, t * inDim);
        batch.actsPre[t * 3] = s.action.preCont[0];
        batch.actsPre[t * 3 + 1] = s.action.preCont[1];
        batch.actsPre[t * 3 + 2] = s.action.preCont[2];
        batch.kicks[t] = s.action.kick;
        batch.pulls[t] = s.action.pull;
        batch.logProbs[t] = s.logProb;
        batch.values[t] = s.value;
        const out = env.step({
            moveX: s.action.mvX,
            moveY: s.action.mvY,
            kick: s.action.kick === 1,
            charge: s.action.chg * 0.95,
            pull: s.action.pull === 1,
        });
        batch.rewards[t] = out.reward;
        env._epReward += out.reward;
        if (out.done) {
            batch.dones[t] = 1;
            batch.episodes.push({
                level: env.level, outcome: out.outcome, success: out.success,
                reward: env._epReward, steps: env.steps,
            });
            env.reset(pickLevel());
            env._epReward = 0;
        }
    }
    batch.nextValue = policy.forward(env.stackRed.get()).value;
    return batch;
}

// Record n (observation, action) pairs of act(env) playing the drill, in the
// layout PPOTrainer.behaviorClone expects: acts = [moveX, moveY, charge, kick, pull].
// Used to warm-start a policy from a reference heuristic before PPO.
function collectDemonstrations(skill, act, n, levelFor, rng) {
    const env = new DrillEnv(skill, { rng: rng || Math.random });
    const inDim = RLEncoder.STACKED_DIM;
    const obs = new Float32Array(n * inDim);
    const acts = new Float32Array(n * 5);
    const pickLevel = levelFor || (() => 1);
    env.reset(pickLevel());
    for (let i = 0; i < n; i++) {
        obs.set(env.stackRed.get(), i * inDim);
        const a = act(env);
        acts[i * 5] = a.moveX;
        acts[i * 5 + 1] = a.moveY;
        acts[i * 5 + 2] = a.charge;
        acts[i * 5 + 3] = a.kick ? 1 : 0;
        acts[i * 5 + 4] = a.pull ? 1 : 0;
        if (env.step(a).done) env.reset(pickLevel());
    }
    return { obs, acts, n };
}

// GAE where dones[t] = 1 means the episode ended with step t, so neither the
// value bootstrap nor the advantage crosses into the next episode. (Drill
// episodes are short, so this boundary is hit constantly.)
function computeEpisodicGAE(rewards, values, dones, nextValue, gamma, lam) {
    const T = rewards.length;
    const adv = new Float32Array(T);
    const ret = new Float32Array(T);
    let lastGae = 0;
    for (let t = T - 1; t >= 0; t--) {
        const notDone = 1 - dones[t];
        const nv = (t === T - 1) ? nextValue : values[t + 1];
        const delta = rewards[t] + gamma * nv * notDone - values[t];
        lastGae = delta + gamma * lam * notDone * lastGae;
        adv[t] = lastGae;
        ret[t] = lastGae + values[t];
    }
    return { adv, ret };
}

function sigmoid(x) {
    if (x >= 0) {
        const z = Math.exp(-x);
        return 1 / (1 + z);
    }
    const z = Math.exp(x);
    return z / (1 + z);
}

return {
    SKILLS,
    MAX_LEVEL,
    DRILLS,
    DrillEnv,
    HEURISTICS,
    IDLE,
    evaluate,
    policyActor,
    collectRollout,
    collectDemonstrations,
    computeEpisodicGAE,
    seededRandom,
};

});
