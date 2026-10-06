// Tests for the RL skill drills (js/rl/drills.js): every drill starts in a
// sensible state, always ends, rewards the skill it is named after, and the
// PPO plumbing (rollout -> GAE -> update) runs on it.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Physics = require('../shared/physics');
const RLEncoder = require('../js/rl/encoder');
const { HeadlessEnv1v1 } = require('../js/rl/env');
const { PPOTrainer } = require('../js/rl/trainer');
const D = require('../js/rl/drills');

const LEVELS = [1, 2, 3];
const OUTCOMES = {
    dribble: ['carried', 'scored', 'own_goal', 'stolen', 'lost', 'timeout'],
    defend: ['cleared', 'held', 'danger', 'conceded', 'own_goal'],
    shoot: ['scored', 'own_goal', 'saved', 'missed', 'timeout'],
    pull: ['won', 'conceded', 'timeout'],
};

function randomActor(seed) {
    const rng = D.seededRandom(seed);
    return () => ({
        moveX: rng() * 2 - 1, moveY: rng() * 2 - 1,
        kick: rng() < 0.2, charge: rng(), pull: rng() < 0.05,
    });
}

function onPitch(env, e) {
    const g = env.g;
    return e.x >= g.fx - 1 && e.x <= g.right + 1 && e.y >= g.fy - 1 && e.y <= g.fy + g.fh + 1;
}

test('every drill starts with the ball and agent on the pitch and apart', () => {
    for (const skill of D.SKILLS) {
        for (const level of LEVELS) {
            const env = new D.DrillEnv(skill, { level, rng: D.seededRandom(level) });
            for (let i = 0; i < 200; i++) {
                const obs = env.reset(level);
                const where = `${skill} L${level} #${i}`;
                assert.ok(onPitch(env, env.ball), `${where}: ball on the pitch`);
                assert.ok(onPitch(env, env.red), `${where}: agent on the pitch`);
                assert.ok(Physics.distance(env.red, env.ball) >= env.red.radius + env.ball.radius - 1,
                    `${where}: agent not overlapping the ball`);
                assert.equal(obs.length, RLEncoder.STACKED_DIM);
                assert.ok(obs.every(Number.isFinite), `${where}: finite observation`);
                if (level === 1) assert.ok(env.blue.y < env.g.fy, `${where}: no opponent on level 1`);
                else assert.ok(onPitch(env, env.blue), `${where}: opponent on the pitch`);
            }
        }
    }
});

test('each drill sets up the situation it trains', () => {
    const n = 200;
    const dribble = new D.DrillEnv('dribble', { rng: D.seededRandom(1) });
    for (let i = 0; i < n; i++) {
        dribble.reset(1);
        const d = Physics.distance(dribble.red, dribble.ball);
        assert.ok(d <= dribble.red.radius + dribble.ball.radius + 3, 'ball starts at the agent\'s feet');
    }

    // Unanswered, every level-1 defend shot is on target
    const defend = new D.DrillEnv('defend', { rng: D.seededRandom(2) });
    for (let i = 0; i < n; i++) {
        defend.reset(1);
        const { ball, g } = defend;
        assert.ok(ball.vx < 0, 'shot travels toward the agent\'s own goal');
        const yAtLine = ball.y + ball.vy * ((g.fx - ball.x) / ball.vx);
        assert.ok(yAtLine > g.goalTop && yAtLine < g.goalBot, 'shot is aimed inside the goal mouth');
    }

    const shoot = new D.DrillEnv('shoot', { rng: D.seededRandom(3) });
    for (let i = 0; i < n; i++) {
        shoot.reset(2);
        const p = shoot.progress(shoot.ball.x);
        assert.ok(p >= 0.55 && p <= 0.85, 'ball starts in the attacking half');
        assert.ok(shoot.progress(shoot.blue.x) > 0.95, 'keeper starts in front of the goal');
    }

    const pull = new D.DrillEnv('pull', { rng: D.seededRandom(4) });
    for (let i = 0; i < n; i++) {
        pull.reset(1 + (i % 3));
        assert.ok(pull.red.pullCooldown <= 0 && !pull.red.pullActive, 'pull is ready');
    }
});

test('episodes always end within the time limit with a known outcome', () => {
    for (const skill of D.SKILLS) {
        for (const level of LEVELS) {
            const act = randomActor(level);
            const env = new D.DrillEnv(skill, { level, rng: D.seededRandom(10 + level) });
            for (let ep = 0; ep < 40; ep++) {
                env.reset(level);
                let out;
                do { out = env.step(act(env)); } while (!out.done && env.steps <= env.maxSteps);
                assert.ok(out.done, `${skill} L${level}: episode ended`);
                assert.ok(env.steps <= env.maxSteps, `${skill} L${level}: within ${env.maxSteps} steps`);
                assert.ok(OUTCOMES[skill].includes(out.outcome), `${skill} L${level}: known outcome ${out.outcome}`);
                assert.ok(Number.isFinite(out.reward));
            }
        }
    }
});

// The core property: a drill must reward the skill, so a player that has it
// (the scripted reference) succeeds far more often than one that doesn't.
test('the reference heuristic succeeds far more often than standing still', () => {
    for (const skill of D.SKILLS) {
        for (const level of LEVELS) {
            const heur = D.evaluate(skill, D.HEURISTICS[skill], { level, episodes: 200, seed: 5 });
            const idle = D.evaluate(skill, () => D.IDLE, { level, episodes: 200, seed: 5 });
            const tag = `${skill} L${level}: heuristic ${heur.successRate}, idle ${idle.successRate}`;
            assert.ok(heur.successRate - idle.successRate >= 0.3, tag);
            if (level === 1) assert.ok(heur.successRate >= 0.6, tag);
        }
    }
});

test('successful episodes earn clearly more reward than failed ones', () => {
    for (const skill of D.SKILLS) {
        for (const level of LEVELS) {
            const r = D.evaluate(skill, D.HEURISTICS[skill], { level, episodes: 200, seed: 6 });
            if (r.avgRewardSuccess === null || r.avgRewardFail === null) continue;
            assert.ok(r.avgRewardSuccess > r.avgRewardFail + 1,
                `${skill} L${level}: success ${r.avgRewardSuccess.toFixed(2)} vs fail ${r.avgRewardFail.toFixed(2)}`);
        }
    }
});

test('pulling wins the ball off a fast carrier far more often than chasing alone', () => {
    const noPull = env => Object.assign(D.HEURISTICS.pull(env), { pull: false });
    const withPull = D.evaluate('pull', D.HEURISTICS.pull, { level: 3, episodes: 300, seed: 7 });
    const without = D.evaluate('pull', noPull, { level: 3, episodes: 300, seed: 7 });
    assert.ok(withPull.successRate > without.successRate + 0.15,
        `with pull ${withPull.successRate}, without ${without.successRate}`);
    assert.ok(withPull.pullUseRate > 0.9);
});

test('a pull started out of range is penalized and burns the cooldown', () => {
    const make = () => {
        const env = new D.DrillEnv('pull', { rng: D.seededRandom(8) });
        env.reset(1);
        env.ball.x = env.red.x + 300 > env.g.right - 20 ? env.red.x - 300 : env.red.x + 300;
        env.ball.y = env.red.y;
        env.ball.vx = 0; env.ball.vy = 0;
        return env;
    };
    const pulled = make();
    const rPull = pulled.step({ ...D.IDLE, pull: true }).reward;
    const waited = make();
    const rWait = waited.step(D.IDLE).reward;
    assert.equal(pulled.d.wastedPulls, 1);
    assert.ok(pulled.red.pullCooldown > 0, 'cooldown started');
    assert.ok(rPull <= rWait - 0.25, `penalized: ${rPull} vs ${rWait}`);
});

test('episodic GAE stops at episode boundaries', () => {
    const gamma = 0.9, lam = 1;
    // Episode 1 = steps 0-1 (reward 1 at its end), episode 2 = steps 2-3
    const rewards = Float32Array.from([0, 1, 0, 0]);
    const values = Float32Array.from([0.5, 0.5, 2, 2]);
    const dones = Uint8Array.from([0, 1, 0, 0]);
    const { adv, ret } = D.computeEpisodicGAE(rewards, values, dones, 5, gamma, lam);
    // Last step of episode 1 does not bootstrap from episode 2's value (2)
    assert.ok(Math.abs(adv[1] - (1 - 0.5)) < 1e-6);
    // Step 0 sees the reward at its episode's end
    assert.ok(Math.abs(adv[0] - (0 + gamma * 0.5 - 0.5 + gamma * lam * adv[1])) < 1e-6);
    // The unfinished episode bootstraps from nextValue
    assert.ok(Math.abs(adv[3] - (gamma * 5 - 2)) < 1e-6);
    for (let t = 0; t < 4; t++) assert.ok(Math.abs(ret[t] - (adv[t] + values[t])) < 1e-6);
});

test('a drill rollout feeds a PPO update end to end', async () => {
    const env = new D.DrillEnv('shoot', { rng: D.seededRandom(9) });
    const trainer = new PPOTrainer({ inDim: RLEncoder.STACKED_DIM, hidden: 32, minibatchSize: 128, epochs: 1 });
    const T = 600;
    const batch = D.collectRollout(env, trainer.policy, T, () => 1);
    assert.equal(batch.obs.length, T * RLEncoder.STACKED_DIM);
    assert.ok(batch.episodes.length > 0, 'short drill episodes finish inside one rollout');
    assert.equal(batch.episodes.length, batch.dones.reduce((a, b) => a + b, 0));
    const { adv, ret } = D.computeEpisodicGAE(batch.rewards, batch.values, batch.dones, batch.nextValue, 0.99, 0.95);
    const stats = await trainer.update({
        obs: batch.obs, actsPre: batch.actsPre, kicks: batch.kicks, pulls: batch.pulls,
        logProbsOld: batch.logProbs, advs: adv, returns: ret,
    });
    assert.ok(Number.isFinite(stats.policyLoss) && Number.isFinite(stats.valueLoss));
    assert.ok(trainer.policy.l1.W.every(Number.isFinite), 'weights stay finite');
});

test('seeded drills replay identically', () => {
    for (const skill of D.SKILLS) {
        const a = D.evaluate(skill, D.HEURISTICS[skill], { level: 2, episodes: 30, seed: 11 });
        const b = D.evaluate(skill, D.HEURISTICS[skill], { level: 2, episodes: 30, seed: 11 });
        assert.deepEqual(a, b, skill);
    }
});

test('the match env still scores and resets after a goal', () => {
    const env = new HeadlessEnv1v1({ randomKickoff: false });
    env.reset();
    const f = env.field;
    env.ball.x = f.x + f.width - 5;
    env.ball.y = f.goalY + f.goalHeight / 2;
    env.ball.vx = 20; env.ball.vy = 0;
    const idle = { moveX: 0, moveY: 0, kick: false, charge: 0, pull: false };
    const out = env.step(idle, idle);
    assert.equal(out.goal, 'red');
    assert.equal(out.scoreRed, 1);
    assert.ok(out.rewardRed > 0.9 && out.rewardBlue < -0.9);
    assert.equal(env.ball.x, f.centerX, 'ball back on the center spot');
});
