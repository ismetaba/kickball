// RL rollout worker.
//
// Receives a serialized policy + opponent profile, runs T steps in a HeadlessEnv
// for both red and blue (collecting tuples for both perspectives plus mirrors),
// then sends back a SoA batch of transitions.
//
// To minimize transfer cost we:
//   - flatten obs into a single Float32Array sent via Transferable
//   - send only what the trainer needs (no logged metadata)
self.importScripts(
    '../../shared/physics.js',
    '../../shared/entities.js',
    '../../shared/ai.js',
    '../../shared/powerups.js',
    './nn.js',
    './encoder.js',
    './policy.js',
    './env.js'
);

const { Policy } = self.RLPolicy;
const { HeadlessEnv1v1 } = self.RLEnv;

// --- Scripted opponents (fast, simple) used for curriculum -------------------

function chaserAction(self, opp, ball, field) {
    const dx = ball.x - self.x;
    const dy = ball.y - self.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const moveX = dist > 1 ? dx / dist : 0;
    const moveY = dist > 1 ? dy / dist : 0;
    const kickRange = self.radius + ball.radius + 12;
    const goalX = self.team === 'red' ? field.x + field.width : field.x;
    const towardGoal = self.team === 'red' ? (ball.x - self.x) > 0 : (ball.x - self.x) < 0;
    return {
        moveX, moveY,
        kick: dist < kickRange && towardGoal,
        charge: 0.4,
        pull: false,
    };
}

// Wrap the shared rule-based AIController so we can read its intended movement
// without it actually mutating the player. We capture applyInput, then route
// the captured intent through the env's normal _apply path.
function ruleAction(aiController, player, opp, ball, field) {
    let capX = 0, capY = 0;
    const realApply = player.applyInput;
    player.applyInput = function(x, y) { capX = x; capY = y; };
    const result = aiController.update(player, ball, field, [player], [opp], 33.34, null);
    player.applyInput = realApply;
    return {
        moveX: capX,
        moveY: capY,
        kick: result.kick,
        charge: result.chargeRatio || 0,
        pull: false,
    };
}

function defenderAction(self, opp, ball, field) {
    const ownGoalX = self.team === 'red' ? field.x : field.x + field.width;
    const goalCenterY = field.goalY + field.goalHeight / 2;
    const targetX = ownGoalX + (ball.x - ownGoalX) * 0.3;
    const targetY = goalCenterY + (ball.y - goalCenterY) * 0.5;
    const dx = targetX - self.x;
    const dy = targetY - self.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const moveX = dist > 3 ? dx / dist : 0;
    const moveY = dist > 3 ? dy / dist : 0;
    const ballDist = Math.sqrt((ball.x - self.x) ** 2 + (ball.y - self.y) ** 2);
    const kickRange = self.radius + ball.radius + 10;
    const kickAway = self.team === 'red' ? (ball.x - self.x) > 0 : (ball.x - self.x) < 0;
    return {
        moveX, moveY,
        kick: ballDist < kickRange && kickAway,
        charge: 0.5,
        pull: false,
    };
}

function randomAction(prev, t, ball, self) {
    if (!prev || t > prev.until) {
        prev = {
            mx: Math.random() * 2 - 1,
            my: Math.random() * 2 - 1,
            until: t + 200 + Math.random() * 400,
        };
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

// Sample an action from the policy and convert to game-ready form
function sampleFromPolicy(policy, obs, mirrorY, isRed) {
    const result = policy.sampleAction(obs);
    const a = result.action;
    // Convert side-coords back to world coords
    const worldVx = isRed ? a.mvX : -a.mvX;
    const worldVy = mirrorY ? -a.mvY : a.mvY;
    const charge = a.chg * 0.95; // squash a bit so 1.0 isn't always super-kick
    return {
        action: {
            moveX: worldVx,
            moveY: worldVy,
            kick: a.kick === 1,
            charge,
            pull: a.pull === 1,
        },
        preCont: a.preCont,
        kick: a.kick,
        pull: a.pull,
        logProb: result.logProb,
        value: result.value,
    };
}

// Deterministic policy action (used at runtime / final eval; mean of distribution).
function detFromPolicy(policy, obs, mirrorY, isRed) {
    const { raw } = policy.forward(obs);
    const mvX = Math.tanh(raw[0]);
    const mvY = Math.tanh(raw[1]);
    const chg = self.RLPolicy.sigmoid(raw[2]);
    const kP = self.RLPolicy.sigmoid(raw[3]);
    const pP = self.RLPolicy.sigmoid(raw[4]);
    const worldVx = isRed ? mvX : -mvX;
    const worldVy = mirrorY ? -mvY : mvY;
    return {
        moveX: worldVx,
        moveY: worldVy,
        kick: kP > 0.5,
        charge: chg * 0.95,
        pull: pP > 0.5,
    };
}

// Stochastic policy action used during *training* by self-play / league opponents.
// Sampling is critical: deterministic self-play with symmetric init produces
// mirror-image stalemates with zero learning signal. Sampling ensures both
// sides explore differently each rollout.
function stochFromPolicy(policy, obs, mirrorY, isRed) {
    const result = policy.sampleAction(obs);
    const a = result.action;
    const worldVx = isRed ? a.mvX : -a.mvX;
    const worldVy = mirrorY ? -a.mvY : a.mvY;
    return {
        moveX: worldVx,
        moveY: worldVy,
        kick: a.kick === 1,
        charge: a.chg * 0.95,
        pull: a.pull === 1,
    };
}

// Main message handler
self.onmessage = function(e) {
    const msg = e.data;
    if (msg.type === 'rollout') runRollout(msg);
    else if (msg.type === 'evaluate') runEvaluation(msg);
    else if (msg.type === 'demonstrate') runDemonstrate(msg);
};

// Generate (obs, action) pairs from rule-based-AI vs rule-based-AI matches.
// Used by the orchestrator for behavior cloning pretraining: the policy is
// trained to imitate the rule-based player's outputs, giving PPO a competent
// non-random starting point. This breaks the cold-start problem PPO has on
// sparse-reward soccer.
function runDemonstrate(msg) {
    const { T, envOpts } = msg;
    const env = new HeadlessEnv1v1(envOpts || {});
    env.reset();
    const ai1 = new AIController('normal');
    const ai2 = new AIController('normal');
    // Demonstration obs use the STACKED dim — must match what policy sees.
    const inDim = self.RLEncoder.STACKED_DIM;
    const obs = new Float32Array(T * inDim);
    const acts = new Float32Array(T * 5); // moveX, moveY, charge, kick, pull
    let n = 0;
    for (let t = 0; t < T; t++) {
        const aRed = ruleAction(ai1, env.red, env.blue, env.ball, env.field);
        const aBlue = ruleAction(ai2, env.blue, env.red, env.ball, env.field);
        // Capture stacked obs BEFORE stepping (so it matches state -> action)
        const stackedRed = env.stackRed.get();
        const stackedBlue = env.stackBlue.get();
        if (n < T) {
            for (let k = 0; k < inDim; k++) obs[n * inDim + k] = stackedRed[k];
            acts[n * 5 + 0] = aRed.moveX;
            acts[n * 5 + 1] = aRed.moveY;
            acts[n * 5 + 2] = aRed.charge;
            acts[n * 5 + 3] = aRed.kick ? 1 : 0;
            acts[n * 5 + 4] = aRed.pull ? 1 : 0;
            n++;
        }
        if (n < T) {
            for (let k = 0; k < inDim; k++) obs[n * inDim + k] = stackedBlue[k];
            acts[n * 5 + 0] = -aBlue.moveX;
            acts[n * 5 + 1] = aBlue.moveY;
            acts[n * 5 + 2] = aBlue.charge;
            acts[n * 5 + 3] = aBlue.kick ? 1 : 0;
            acts[n * 5 + 4] = aBlue.pull ? 1 : 0;
            n++;
        }
        env.step(aRed, aBlue);
    }
    self.postMessage({
        type: 'demonstrateResult',
        obs: obs.buffer,
        acts: acts.buffer,
        n
    }, [obs.buffer, acts.buffer]);
}

// Run T steps collecting transitions. Always controls *agent* via current policy
// (with sampling). Opponent is one of: 'self' (current policy, deterministic),
// 'league' (frozen weights, deterministic), 'chaser', 'defender', 'random'.
function runRollout(msg) {
    const { policySer, oppType, oppWeights, T, envOpts, agentSide, augmentMirror } = msg;

    const policy = new Policy(policySer.inDim, policySer.hidden);
    policy.loadFrom(policySer);

    let oppPolicy = null;
    let ruleAI = null;
    if (oppType === 'self' || oppType === 'league') {
        oppPolicy = new Policy(policySer.inDim, policySer.hidden);
        oppPolicy.loadFrom(oppWeights || policySer);
    } else if (oppType === 'rule') {
        ruleAI = new AIController('normal');
    }

    const env = new HeadlessEnv1v1(envOpts || {});
    env.reset();

    // SoA buffers (mirror augmentation removed — was off and producing dead work)
    const inDim = policy.inDim;
    const cap = T;
    const obs = new Float32Array(cap * inDim);
    const actsPre = new Float32Array(cap * 3);
    const kicks = new Uint8Array(cap);
    const pulls = new Uint8Array(cap);
    const logProbs = new Float32Array(cap);
    const values = new Float32Array(cap);
    const rewards = new Float32Array(cap);
    const dones = new Uint8Array(cap);
    let cursor = 0;

    let randPrev = null;
    let totalReward = 0;
    let goalsAgent = 0, goalsOpp = 0;

    for (let t = 0; t < T; t++) {
        // Use STACKED obs (last K frames concatenated) — what the policy was trained on
        const obsAgent = agentSide === 'red' ? env.stackRed.get() : env.stackBlue.get();
        const sample = sampleFromPolicy(policy, obsAgent, false, agentSide === 'red');

        for (let k = 0; k < inDim; k++) obs[cursor * inDim + k] = obsAgent[k];
        actsPre[cursor * 3 + 0] = sample.preCont[0];
        actsPre[cursor * 3 + 1] = sample.preCont[1];
        actsPre[cursor * 3 + 2] = sample.preCont[2];
        kicks[cursor] = sample.kick;
        pulls[cursor] = sample.pull;
        logProbs[cursor] = sample.logProb;
        values[cursor] = sample.value;
        const recordIdx = cursor;
        cursor++;

        // Opponent action — also gets stacked obs if it's a learned policy
        const oppPlayer = agentSide === 'red' ? env.blue : env.red;
        const selfPlayer = agentSide === 'red' ? env.red : env.blue;
        let oppAct;
        if (oppType === 'self' || oppType === 'league') {
            const oppObs = agentSide === 'red' ? env.stackBlue.get() : env.stackRed.get();
            oppAct = stochFromPolicy(oppPolicy, oppObs, false, oppPlayer.team === 'red');
        } else if (oppType === 'chaser') {
            oppAct = chaserAction(oppPlayer, selfPlayer, env.ball, env.field);
        } else if (oppType === 'defender') {
            oppAct = defenderAction(oppPlayer, selfPlayer, env.ball, env.field);
        } else if (oppType === 'rule') {
            oppAct = ruleAction(ruleAI, oppPlayer, selfPlayer, env.ball, env.field);
        } else { // random
            const r = randomAction(randPrev, t * 33.34, env.ball, oppPlayer);
            oppAct = r.action;
            randPrev = r.prev;
        }

        // Step environment
        let stepOut;
        if (agentSide === 'red') stepOut = env.step(sample.action, oppAct);
        else                       stepOut = env.step(oppAct, sample.action);

        const rew = agentSide === 'red' ? stepOut.rewardRed : stepOut.rewardBlue;
        rewards[recordIdx] = rew;
        const isDone = stepOut.done ? 1 : 0;
        dones[recordIdx] = isDone;
        totalReward += rew;
        if (stepOut.goal === agentSide) goalsAgent++;
        else if (stepOut.goal && stepOut.goal !== agentSide) goalsOpp++;

        if (stepOut.done) env.reset();
    }

    // Bootstrap value at T (stacked obs)
    const obsAgent = agentSide === 'red' ? env.stackRed.get() : env.stackBlue.get();
    const fwd = policy.forward(obsAgent);
    const nextValue = fwd.value;

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
        agentSide,
        oppType,
        totalReward,
        goalsAgent,
        goalsOpp,
    }, [obs.buffer, actsPre.buffer, kicks.buffer, pulls.buffer, logProbs.buffer, values.buffer, rewards.buffer, dones.buffer]);
}

// Evaluation: deterministic policy vs scripted bot, return win/loss/draw
function runEvaluation(msg) {
    const { policySer, oppType, oppWeights, episodes, envOpts } = msg;
    const policy = new Policy(policySer.inDim, policySer.hidden);
    policy.loadFrom(policySer);
    let oppPolicy = null;
    let ruleAI = null;
    if (oppType === 'self' || oppType === 'league') {
        oppPolicy = new Policy(policySer.inDim, policySer.hidden);
        oppPolicy.loadFrom(oppWeights || policySer);
    } else if (oppType === 'rule') {
        ruleAI = new AIController('normal');
    }

    const env = new HeadlessEnv1v1(envOpts || {});
    let agentGoals = 0, oppGoals = 0;
    for (let ep = 0; ep < episodes; ep++) {
        env.reset();
        const agentSide = (ep % 2 === 0) ? 'red' : 'blue';
        let randPrev = null;
        for (let t = 0; t < env.maxSteps; t++) {
            const obsA = agentSide === 'red' ? env.stackRed.get() : env.stackBlue.get();
            const aAct = detFromPolicy(policy, obsA, false, agentSide === 'red');
            const oppPlayer = agentSide === 'red' ? env.blue : env.red;
            const selfPlayer = agentSide === 'red' ? env.red : env.blue;
            let oAct;
            if (oppType === 'self' || oppType === 'league') {
                const oObs = agentSide === 'red' ? env.stackBlue.get() : env.stackRed.get();
                oAct = detFromPolicy(oppPolicy, oObs, false, oppPlayer.team === 'red');
            } else if (oppType === 'chaser') oAct = chaserAction(oppPlayer, selfPlayer, env.ball, env.field);
            else if (oppType === 'defender') oAct = defenderAction(oppPlayer, selfPlayer, env.ball, env.field);
            else if (oppType === 'rule') oAct = ruleAction(ruleAI, oppPlayer, selfPlayer, env.ball, env.field);
            else {
                const r = randomAction(randPrev, t * 33.34, env.ball, oppPlayer);
                oAct = r.action; randPrev = r.prev;
            }
            const out = agentSide === 'red'
                ? env.step(aAct, oAct)
                : env.step(oAct, aAct);
            if (out.done) break;
        }
        if (agentSide === 'red') { agentGoals += env.scoreRed; oppGoals += env.scoreBlue; }
        else                      { agentGoals += env.scoreBlue; oppGoals += env.scoreRed; }
    }
    self.postMessage({
        type: 'evaluationResult',
        oppType,
        episodes,
        agentGoals,
        oppGoals,
    });
}
