// 2v2 rollout worker.
//
// Same shape as the 1v1 worker but:
//   - HeadlessEnv2v2 with 4 players
//   - SHARED policy controls all 4 (the agent's 2 + the opponent's 2)
//   - Stochastic sampling for the agent's team and the self/league opponent's team
//   - Records 2 transitions per step (one per agent player)
//   - Pass-completion + possession-transfer rewards already in env's reward
//
// Opponents:
//   - 'self': same policy controls opp team (with sampling so symmetry breaks)
//   - 'league': frozen weights from past snapshot
//   - 'rule': rule-based AIController, with the same role-assignment logic the
//     live game uses for 2v2 (chase/defend/support emerges from teammate count)
//   - 'random': both opp players act randomly
self.importScripts(
    '../../shared/physics.js',
    '../../shared/entities.js',
    '../../shared/ai.js',
    '../../shared/powerups.js',
    './nn.js',
    './encoder2v2.js',
    './policy.js',
    './env2v2.js'
);

const { Policy } = self.RLPolicy;
const { HeadlessEnv2v2 } = self.RLEnv2v2;

// Wrap the rule-based AIController so we can read its move intent without
// it actually mutating the player. Same trick as 1v1 worker.
function ruleActionFor(aiController, player, teammates, opponents, ball, field) {
    let capX = 0, capY = 0;
    const realApply = player.applyInput;
    player.applyInput = function(x, y) { capX = x; capY = y; };
    const result = aiController.update(player, ball, field, teammates, opponents, 33.34, null);
    player.applyInput = realApply;
    return {
        moveX: capX,
        moveY: capY,
        kick: result.kick,
        charge: result.chargeRatio || 0,
        pull: false,
    };
}

function chaserAction(self, opps, ball, field) {
    const dx = ball.x - self.x;
    const dy = ball.y - self.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const moveX = dist > 1 ? dx / dist : 0;
    const moveY = dist > 1 ? dy / dist : 0;
    const kickRange = self.radius + ball.radius + 12;
    const towardGoal = self.team === 'red' ? (ball.x - self.x) > 0 : (ball.x - self.x) < 0;
    return { moveX, moveY, kick: dist < kickRange && towardGoal, charge: 0.4, pull: false };
}

function randomAction(prev, t, ball, self) {
    if (!prev || t > prev.until) {
        prev = { mx: Math.random() * 2 - 1, my: Math.random() * 2 - 1, until: t + 200 + Math.random() * 400 };
    }
    const dx = ball.x - self.x;
    const dy = ball.y - self.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const bx = dist > 1 ? dx / dist * 0.6 : 0;
    const by = dist > 1 ? dy / dist * 0.6 : 0;
    return {
        action: {
            moveX: prev.mx * 0.4 + bx,
            moveY: prev.my * 0.4 + by,
            kick: dist < self.radius + ball.radius + 12 && Math.random() < 0.7,
            charge: Math.random() * 0.5,
            pull: false,
        },
        prev,
    };
}

function sampleFromPolicy(policy, obs, isRed) {
    const result = policy.sampleAction(obs);
    const a = result.action;
    const worldVx = isRed ? a.mvX : -a.mvX;
    const worldVy = a.mvY;
    return {
        action: {
            moveX: worldVx,
            moveY: worldVy,
            kick: a.kick === 1,
            charge: a.chg * 0.95,
            pull: a.pull === 1,
        },
        preCont: a.preCont,
        kick: a.kick,
        pull: a.pull,
        logProb: result.logProb,
        value: result.value,
    };
}

function detFromPolicy(policy, obs, isRed) {
    const { raw } = policy.forward(obs);
    const sig = self.RLPolicy.sigmoid;
    return {
        moveX: isRed ? Math.tanh(raw[0]) : -Math.tanh(raw[0]),
        moveY: Math.tanh(raw[1]),
        kick: sig(raw[3]) > 0.5,
        charge: sig(raw[2]) * 0.95,
        pull: sig(raw[4]) > 0.5,
    };
}

self.onmessage = function(e) {
    const msg = e.data;
    if (msg.type === 'rollout') runRollout(msg);
    else if (msg.type === 'evaluate') runEvaluation(msg);
    else if (msg.type === 'demonstrate') runDemonstrate(msg);
};

function runRollout(msg) {
    const { policySer, oppType, oppWeights, T, envOpts } = msg;

    const policy = new Policy(policySer.inDim, policySer.hidden);
    policy.loadFrom(policySer);
    let oppPolicy = null;
    let ruleAIs = null;
    if (oppType === 'self' || oppType === 'league') {
        oppPolicy = new Policy(policySer.inDim, policySer.hidden);
        oppPolicy.loadFrom(oppWeights || policySer);
    } else if (oppType === 'rule') {
        ruleAIs = [new self.AIController('normal'), new self.AIController('normal')];
    }

    const env = new HeadlessEnv2v2(envOpts || {});
    env.reset();

    // Both red players are "agents" (the policy we're training).
    // Both blue players are the "opponents" (controlled by oppType).
    // Each STEP records 2 transitions (one per agent player).
    const inDim = policy.inDim;
    const cap = T * 2; // 2 agents
    const obs = new Float32Array(cap * inDim);
    const actsPre = new Float32Array(cap * 3);
    const kicks = new Uint8Array(cap);
    const pulls = new Uint8Array(cap);
    const logProbs = new Float32Array(cap);
    const values = new Float32Array(cap);
    const rewards = new Float32Array(cap);
    const dones = new Uint8Array(cap);
    let cursor = 0;

    let randPrev = [null, null];
    let totalReward = 0;
    let goalsAgent = 0, goalsOpp = 0;

    for (let t = 0; t < T; t++) {
        // Agent (red) actions: sample for each player using their own stacked obs
        const agentSamples = [
            sampleFromPolicy(policy, env.stackRed[0].get(), true),
            sampleFromPolicy(policy, env.stackRed[1].get(), true),
        ];

        // Record both agent transitions (2 per step)
        for (let pi = 0; pi < 2; pi++) {
            const s = agentSamples[pi];
            const stackedObs = env.stackRed[pi].get();
            for (let k = 0; k < inDim; k++) obs[cursor * inDim + k] = stackedObs[k];
            actsPre[cursor * 3 + 0] = s.preCont[0];
            actsPre[cursor * 3 + 1] = s.preCont[1];
            actsPre[cursor * 3 + 2] = s.preCont[2];
            kicks[cursor] = s.kick;
            pulls[cursor] = s.pull;
            logProbs[cursor] = s.logProb;
            values[cursor] = s.value;
            cursor++;
        }
        const recordIdxA = cursor - 2; // red[0] index
        const recordIdxB = cursor - 1; // red[1] index

        // Opponent (blue) actions
        const oppActs = [null, null];
        if (oppType === 'self' || oppType === 'league') {
            oppActs[0] = sampleFromPolicy(oppPolicy, env.stackBlue[0].get(), false).action;
            oppActs[1] = sampleFromPolicy(oppPolicy, env.stackBlue[1].get(), false).action;
        } else if (oppType === 'chaser') {
            oppActs[0] = chaserAction(env.blue[0], env.red, env.ball, env.field);
            oppActs[1] = chaserAction(env.blue[1], env.red, env.ball, env.field);
        } else if (oppType === 'rule') {
            oppActs[0] = ruleActionFor(ruleAIs[0], env.blue[0], env.blue, env.red, env.ball, env.field);
            oppActs[1] = ruleActionFor(ruleAIs[1], env.blue[1], env.blue, env.red, env.ball, env.field);
        } else { // random
            for (let pi = 0; pi < 2; pi++) {
                const r = randomAction(randPrev[pi], t * 33.34, env.ball, env.blue[pi]);
                oppActs[pi] = r.action;
                randPrev[pi] = r.prev;
            }
        }

        const stepOut = env.step([
            agentSamples[0].action,
            agentSamples[1].action,
            oppActs[0],
            oppActs[1],
        ]);
        // Rewards are per-player [red0, red1, blue0, blue1]
        const rA = stepOut.rewards[0];
        const rB = stepOut.rewards[1];
        rewards[recordIdxA] = rA;
        rewards[recordIdxB] = rB;
        const isDone = stepOut.done ? 1 : 0;
        dones[recordIdxA] = isDone;
        dones[recordIdxB] = isDone;
        totalReward += (rA + rB) / 2;
        if (stepOut.goal === 'red') goalsAgent++;
        else if (stepOut.goal === 'blue') goalsOpp++;

        if (stepOut.done) env.reset();
    }

    // Bootstrap value at T (use red[0] as a representative; both agent slots
    // are similar in expectation since they share the policy)
    const fwd0 = policy.forward(env.stackRed[0].get());
    const fwd1 = policy.forward(env.stackRed[1].get());
    const nextValue = (fwd0.value + fwd1.value) / 2;

    self.postMessage({
        type: 'rolloutResult',
        obs: obs.buffer,
        actsPre: actsPre.buffer,
        kicks: kicks.buffer,
        pulls: pulls.buffer,
        logProbs: logProbs.buffer,
        values: values.buffer,
        rewards: rewards.buffer,
        dones: dones.buffer,
        n: cursor,
        nextValue,
        oppType,
        totalReward,
        goalsAgent,
        goalsOpp,
    }, [obs.buffer, actsPre.buffer, kicks.buffer, pulls.buffer, logProbs.buffer, values.buffer, rewards.buffer, dones.buffer]);
}

function runDemonstrate(msg) {
    const { T, envOpts } = msg;
    const env = new HeadlessEnv2v2(envOpts || {});
    env.reset();
    const ais = [
        new self.AIController('normal'), new self.AIController('normal'),
        new self.AIController('normal'), new self.AIController('normal'),
    ];
    const inDim = self.RLEncoder2v2.STACKED_DIM;
    const obs = new Float32Array(T * inDim);
    const acts = new Float32Array(T * 5);
    let n = 0;
    for (let t = 0; t < T; t++) {
        // All 4 players controlled by rule-based AI; record obs/acts from RED
        // perspective only (data is mirrored at training time via team-flip).
        const a0 = ruleActionFor(ais[0], env.red[0], env.red, env.blue, env.ball, env.field);
        const a1 = ruleActionFor(ais[1], env.red[1], env.red, env.blue, env.ball, env.field);
        const b0 = ruleActionFor(ais[2], env.blue[0], env.blue, env.red, env.ball, env.field);
        const b1 = ruleActionFor(ais[3], env.blue[1], env.blue, env.red, env.ball, env.field);
        // Capture stacked obs + actions for red[0] and red[1] BEFORE stepping
        const stackedR0 = env.stackRed[0].get();
        const stackedR1 = env.stackRed[1].get();
        if (n < T) {
            for (let k = 0; k < inDim; k++) obs[n * inDim + k] = stackedR0[k];
            acts[n * 5 + 0] = a0.moveX;
            acts[n * 5 + 1] = a0.moveY;
            acts[n * 5 + 2] = a0.charge;
            acts[n * 5 + 3] = a0.kick ? 1 : 0;
            acts[n * 5 + 4] = a0.pull ? 1 : 0;
            n++;
        }
        if (n < T) {
            for (let k = 0; k < inDim; k++) obs[n * inDim + k] = stackedR1[k];
            acts[n * 5 + 0] = a1.moveX;
            acts[n * 5 + 1] = a1.moveY;
            acts[n * 5 + 2] = a1.charge;
            acts[n * 5 + 3] = a1.kick ? 1 : 0;
            acts[n * 5 + 4] = a1.pull ? 1 : 0;
            n++;
        }
        env.step([a0, a1, b0, b1]);
    }
    self.postMessage({ type: 'demonstrateResult', obs: obs.buffer, acts: acts.buffer, n }, [obs.buffer, acts.buffer]);
}

function runEvaluation(msg) {
    const { policySer, oppType, oppWeights, episodes, envOpts } = msg;
    const policy = new Policy(policySer.inDim, policySer.hidden);
    policy.loadFrom(policySer);
    let oppPolicy = null;
    let ruleAIs = null;
    if (oppType === 'self' || oppType === 'league') {
        oppPolicy = new Policy(policySer.inDim, policySer.hidden);
        oppPolicy.loadFrom(oppWeights || policySer);
    } else if (oppType === 'rule') {
        ruleAIs = [new self.AIController('normal'), new self.AIController('normal')];
    }

    const env = new HeadlessEnv2v2(envOpts || {});
    let agentGoals = 0, oppGoals = 0;
    for (let ep = 0; ep < episodes; ep++) {
        env.reset();
        let randPrev = [null, null];
        for (let t = 0; t < env.maxSteps; t++) {
            const a0 = detFromPolicy(policy, env.stackRed[0].get(), true);
            const a1 = detFromPolicy(policy, env.stackRed[1].get(), true);
            let b0, b1;
            if (oppType === 'self' || oppType === 'league') {
                b0 = detFromPolicy(oppPolicy, env.stackBlue[0].get(), false);
                b1 = detFromPolicy(oppPolicy, env.stackBlue[1].get(), false);
            } else if (oppType === 'chaser') {
                b0 = chaserAction(env.blue[0], env.red, env.ball, env.field);
                b1 = chaserAction(env.blue[1], env.red, env.ball, env.field);
            } else if (oppType === 'rule') {
                b0 = ruleActionFor(ruleAIs[0], env.blue[0], env.blue, env.red, env.ball, env.field);
                b1 = ruleActionFor(ruleAIs[1], env.blue[1], env.blue, env.red, env.ball, env.field);
            } else {
                const r0 = randomAction(randPrev[0], t * 33.34, env.ball, env.blue[0]); b0 = r0.action; randPrev[0] = r0.prev;
                const r1 = randomAction(randPrev[1], t * 33.34, env.ball, env.blue[1]); b1 = r1.action; randPrev[1] = r1.prev;
            }
            const out = env.step([a0, a1, b0, b1]);
            if (out.done) break;
        }
        agentGoals += env.scoreRed;
        oppGoals += env.scoreBlue;
    }
    self.postMessage({ type: 'evaluationResult', oppType, episodes, agentGoals, oppGoals });
}
