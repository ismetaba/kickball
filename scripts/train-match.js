#!/usr/bin/env node
// Train one full-match policy with PPO on a mix of real 1v1 matches and the
// skill drills (js/rl/drills.js), headless.
//
//   node scripts/train-match.js --init models/kickzone-rl-gen1325.json --gens 300
//
// Match rollouts teach winning; drill rollouts teach technique (dribbling,
// defending, shooting, pulling) that full matches rarely exercise. Each
// generation is --drill-frac drill steps (spread over the four skills) and
// the rest match steps against a mix of opponents: the game's rule AI, the
// frozen starting model, past snapshots of this one, and itself.
//
// Every --eval-every generations it plays matches against the rule AI and
// the starting model and runs every drill; the checkpoint with the best
// combined score is written to --out, plus a snapshot per evaluation in
// --out's directory so any point of the run can be picked later.
const fs = require('fs');
const path = require('path');

const RLEncoder = require('../js/rl/encoder');
const RLPolicy = require('../js/rl/policy');
const { PPOTrainer } = require('../js/rl/trainer');
const { HeadlessEnv1v1 } = require('../js/rl/env');
const AIController = require('../shared/ai');
const D = require('../js/rl/drills');

const args = parseArgs(process.argv.slice(2), {
    init: null,          // starting weights (a policy JSON), or a fresh net of --hidden
    hidden: 256,
    gens: 300,
    steps: 16384,        // total environment steps per generation
    drillFrac: 0.5,      // share of them spent in drills
    lr: 1e-4,
    lrEnd: 3e-5,
    ent: 0.005,
    evalEvery: 10,
    evalMatches: 20,
    out: 'models/match-skilled.json',
    snapshots: true,
});

const MATCH_ENV = {
    map: 'classic',
    maxSteps: 1800,           // 60 s episodes
    powerUps: false,
    randomKickoff: true,
    disablePull: false,
    disableSuperKick: false,
    disableKickPlayer: false,
    superKickAbusePenalty: 0.05,
    kickPlayerAbusePenalty: 0.03,
};
const OPPONENT_MIX = { rule: 0.35, init: 0.25, league: 0.2, self: 0.2 };
const DRILL_LEVEL_MIX = [0.2, 0.4, 0.4];

const outFile = path.resolve(args.out);
const snapDir = outFile.replace(/\.json$/, '') + '-snapshots';

let initSer = null;
if (args.init) {
    const j = JSON.parse(fs.readFileSync(args.init, 'utf8'));
    initSer = j.policy || j;
}
const hidden = initSer ? initSer.hidden : args.hidden;
const trainer = new PPOTrainer({
    inDim: RLEncoder.STACKED_DIM,
    hidden,
    rolloutLen: args.steps,
    learningRate: args.lr,
    entCoef: args.ent,
});
if (initSer && !trainer.policy.loadFrom(initSer)) throw new Error('init model does not fit the encoder');
const initPolicy = initSer ? policyFrom(initSer) : null;
const league = [];

// --- Match rollouts -------------------------------------------------------------

const match = {
    env: new HeadlessEnv1v1(MATCH_ENV),
    side: 'red',
    oppType: 'rule',
    oppPolicy: null,
    oppRule: null,
    epReward: 0,
    results: [],      // { oppType, gf, ga } per finished episode
};
startMatchEpisode();

function startMatchEpisode() {
    match.env.reset();
    match.side = Math.random() < 0.5 ? 'red' : 'blue';
    match.oppType = pick(OPPONENT_MIX);
    if (match.oppType === 'init' && !initPolicy) match.oppType = 'self';
    if (match.oppType === 'league' && league.length === 0) match.oppType = 'self';
    match.oppPolicy = match.oppType === 'init' ? initPolicy
        : match.oppType === 'league' ? league[(Math.random() * league.length) | 0]
        : match.oppType === 'self' ? trainer.policy : null;
    match.oppRule = match.oppType === 'rule' ? new AIController('normal') : null;
}

function collectMatchRollout(T) {
    const policy = trainer.policy;
    const inDim = policy.inDim;
    const b = newBatch(T, inDim);
    const env = match.env;
    for (let t = 0; t < T; t++) {
        const isRed = match.side === 'red';
        const self = isRed ? env.red : env.blue;
        const opp = isRed ? env.blue : env.red;
        const obs = isRed ? env.stackRed.get() : env.stackBlue.get();
        const s = policy.sampleAction(obs);
        record(b, t, obs, s);
        const myAct = toWorld(s.action, isRed);
        let oppAct;
        if (match.oppRule) {
            oppAct = ruleAct(match.oppRule, opp, self, env);
        } else {
            const oObs = isRed ? env.stackBlue.get() : env.stackRed.get();
            oppAct = toWorld(match.oppPolicy.sampleAction(oObs).action, !isRed);
        }
        const out = isRed ? env.step(myAct, oppAct) : env.step(oppAct, myAct);
        b.rewards[t] = isRed ? out.rewardRed : out.rewardBlue;
        if (out.done) {
            b.dones[t] = 1;
            match.results.push({
                oppType: match.oppType,
                gf: isRed ? out.scoreRed : out.scoreBlue,
                ga: isRed ? out.scoreBlue : out.scoreRed,
            });
            startMatchEpisode();
        }
    }
    const isRed = match.side === 'red';
    b.nextValue = policy.forward(isRed ? env.stackRed.get() : env.stackBlue.get()).value;
    return b;
}

// --- Drill rollouts ----------------------------------------------------------------

const drillEnvs = {};
for (const s of D.SKILLS) drillEnvs[s] = new D.DrillEnv(s);
const drillLevel = () => 1 + pickIndex(DRILL_LEVEL_MIX);

// --- Training loop -----------------------------------------------------------------

let best = -Infinity;
const history = [];
async function main() {
    if (args.snapshots) fs.mkdirSync(snapDir, { recursive: true });
    if (initPolicy) {
        const e = evaluateAll();
        console.log('start: ' + fmtEval(e));
        history.push({ generation: 0, ...e });
    }
    for (let g = 1; g <= args.gens; g++) {
        trainer.opts.learningRate = args.lr + (args.lrEnd - args.lr) * ((g - 1) / args.gens);
        const t0 = Date.now();
        const drillSteps = Math.round(args.steps * args.drillFrac / D.SKILLS.length);
        const matchSteps = args.steps - drillSteps * D.SKILLS.length;
        const parts = [];
        const m = collectMatchRollout(matchSteps);
        parts.push({ b: m, gae: D.computeEpisodicGAE(m.rewards, m.values, m.dones, m.nextValue, 0.995, 0.95) });
        const drillEps = {};
        for (const s of D.SKILLS) {
            const r = D.collectRollout(drillEnvs[s], trainer.policy, drillSteps, drillLevel);
            drillEps[s] = r.episodes;
            parts.push({ b: r, gae: D.computeEpisodicGAE(r.rewards, r.values, r.dones, r.nextValue, 0.99, 0.95) });
        }
        const tRoll = Date.now() - t0;
        const stats = await trainer.update(concatBatches(parts));

        if (g % 25 === 0) {
            league.push(policyFrom(trainer.policy.serialize()));
            if (league.length > 8) league.shift();
        }

        const recent = match.results.splice(0);
        const vsRule = recent.filter(r => r.oppType === 'rule');
        let line = `gen ${String(g).padStart(4)}  ${tRoll}+${Date.now() - t0 - tRoll}ms`
            + `  ent ${stats.entropy.toFixed(2)} kl ${stats.klEst.toFixed(3)}`
            + `  train matches ${recent.length} (vs rule ${goals(vsRule)})`
            + '  drills ' + D.SKILLS.map(s => `${s} ${pct(rate(drillEps[s]))}`).join(' ');
        if (g % args.evalEvery === 0 || g === args.gens) {
            const e = evaluateAll();
            history.push({ generation: g, ...e });
            line += '\n      eval ' + fmtEval(e);
            const ser = trainer.policy.serialize();
            if (args.snapshots) {
                fs.writeFileSync(path.join(snapDir, `gen${String(g).padStart(4, '0')}.json`),
                    JSON.stringify({ generation: g, eval: e, policy: ser }));
            }
            if (e.score > best) {
                best = e.score;
                fs.mkdirSync(path.dirname(outFile), { recursive: true });
                fs.writeFileSync(outFile, JSON.stringify({
                    kind: 'kickzone-match', version: 1, generation: g, eval: e,
                    init: args.init, savedAt: new Date().toISOString(), policy: ser,
                }));
                line += '  saved';
            }
            fs.writeFileSync(outFile.replace(/\.json$/, '-history.json'), JSON.stringify(history, null, 1));
        }
        console.log(line);
    }
}

// Matches against the rule AI and the starting model, plus every drill.
// score = match points share (win 1, draw 0.5) averaged over both opponents,
// blended with the mean drill success at levels 2 and 3.
function evaluateAll() {
    const me = () => new PolicyAgent(trainer.policy);
    const vsRule = playMatches(me, () => new AIController('normal'), args.evalMatches);
    const vsInit = initPolicy ? playMatches(me, () => new PolicyAgent(initPolicy), args.evalMatches) : null;
    const drills = {};
    let sum = 0, n = 0;
    for (const s of D.SKILLS) {
        drills[s] = {};
        for (const level of [1, 2, 3]) {
            const r = D.evaluate(s, D.policyActor(trainer.policy), { level, episodes: 200, seed: 99 });
            drills[s][level] = r.successRate;
            if (level > 1) { sum += r.successRate; n++; }
        }
    }
    const matchScore = vsInit ? (vsRule.points + vsInit.points) / 2 : vsRule.points;
    const drillScore = sum / n;
    return { vsRule, vsInit, drills, matchScore, drillScore, score: 0.6 * matchScore + 0.4 * drillScore };
}

function fmtEval(e) {
    const m = (r) => r ? `${r.win}-${r.draw}-${r.loss} (${r.gf}:${r.ga})` : '-';
    return `vs rule ${m(e.vsRule)}  vs init ${m(e.vsInit)}  drills L1/L2/L3 `
        + D.SKILLS.map(s => `${s} ${[1, 2, 3].map(l => Math.round(e.drills[s][l] * 100)).join('/')}`).join(' ')
        + `  score ${e.score.toFixed(3)}`;
}

// --- Match play for evaluation --------------------------------------------------

// Mean movement, kick/pull drawn from their probabilities (as in training)
class PolicyAgent {
    constructor(policy) {
        this.policy = policy;
        this.obs = new Float32Array(RLEncoder.FEATURE_DIM);
        this.stack = new RLEncoder.FrameStack(RLEncoder.FEATURE_DIM, RLEncoder.STACK_K);
        this.primed = false;
    }
    act(self, opp, env) {
        RLEncoder.encode(self, opp, env.ball, env.field, { timeLeft: 60000, scoreDiff: 0 }, null, this.obs, false);
        if (this.primed) this.stack.push(this.obs); else { this.stack.fill(this.obs); this.primed = true; }
        const { raw } = this.policy.forward(this.stack.get());
        const isRed = self.team === 'red';
        return {
            moveX: Math.tanh(raw[0]) * (isRed ? 1 : -1),
            moveY: Math.tanh(raw[1]),
            charge: RLPolicy.sigmoid(raw[2]) * 0.95,
            kick: Math.random() < RLPolicy.sigmoid(raw[3]),
            pull: Math.random() < RLPolicy.sigmoid(raw[4]),
        };
    }
}

function playMatches(makeA, makeB, n) {
    const res = { win: 0, draw: 0, loss: 0, gf: 0, ga: 0, points: 0 };
    const steps = Math.round(120000 / 33.34);
    for (let i = 0; i < n; i++) {
        const env = new HeadlessEnv1v1(Object.assign({}, MATCH_ENV, { maxSteps: steps, randomKickoff: false }));
        env.reset();
        const aRed = i % 2 === 0;
        const A = makeA(), B = makeB();
        const pa = aRed ? env.red : env.blue, pb = aRed ? env.blue : env.red;
        for (let t = 0; t < steps; t++) {
            const aa = A.act ? A.act(pa, pb, env) : ruleAct(A, pa, pb, env);
            const bb = B.act ? B.act(pb, pa, env) : ruleAct(B, pb, pa, env);
            env.step(aRed ? aa : bb, aRed ? bb : aa);
        }
        const gf = aRed ? env.scoreRed : env.scoreBlue, ga = aRed ? env.scoreBlue : env.scoreRed;
        res.gf += gf; res.ga += ga;
        if (gf > ga) res.win++; else if (gf < ga) res.loss++; else res.draw++;
    }
    res.points = (res.win + 0.5 * res.draw) / n;
    return res;
}

// The rule AI moves the player itself; capture its input as an env action.
function ruleAct(ai, self, opp, env) {
    let mx = 0, my = 0;
    const applyInput = self.applyInput;
    self.applyInput = (x, y) => { mx = x; my = y; };
    let r;
    try {
        r = ai.update(self, env.ball, env.field, [self], [opp], 33.34, null);
    } finally {
        self.applyInput = applyInput;
    }
    return { moveX: mx, moveY: my, kick: !!r.kick, charge: r.chargeRatio || 0.3, pull: false };
}

// --- Helpers ------------------------------------------------------------------------

function toWorld(a, isRed) {
    return {
        moveX: isRed ? a.mvX : -a.mvX,
        moveY: a.mvY,
        kick: a.kick === 1,
        charge: a.chg * 0.95,
        pull: a.pull === 1,
    };
}

function newBatch(T, inDim) {
    return {
        obs: new Float32Array(T * inDim),
        actsPre: new Float32Array(T * 3),
        kicks: new Uint8Array(T),
        pulls: new Uint8Array(T),
        logProbs: new Float32Array(T),
        values: new Float32Array(T),
        rewards: new Float32Array(T),
        dones: new Uint8Array(T),
        nextValue: 0,
    };
}

function record(b, t, obs, s) {
    b.obs.set(obs, t * obs.length);
    b.actsPre[t * 3] = s.action.preCont[0];
    b.actsPre[t * 3 + 1] = s.action.preCont[1];
    b.actsPre[t * 3 + 2] = s.action.preCont[2];
    b.kicks[t] = s.action.kick;
    b.pulls[t] = s.action.pull;
    b.logProbs[t] = s.logProb;
    b.values[t] = s.value;
}

function concatBatches(parts) {
    const N = parts.reduce((n, p) => n + p.b.rewards.length, 0);
    const inDim = trainer.policy.inDim;
    const out = {
        obs: new Float32Array(N * inDim), actsPre: new Float32Array(N * 3),
        kicks: new Uint8Array(N), pulls: new Uint8Array(N),
        logProbsOld: new Float32Array(N), advs: new Float32Array(N), returns: new Float32Array(N),
    };
    let o = 0;
    for (const { b, gae } of parts) {
        const n = b.rewards.length;
        out.obs.set(b.obs.subarray(0, n * inDim), o * inDim);
        out.actsPre.set(b.actsPre.subarray(0, n * 3), o * 3);
        out.kicks.set(b.kicks.subarray(0, n), o);
        out.pulls.set(b.pulls.subarray(0, n), o);
        out.logProbsOld.set(b.logProbs.subarray(0, n), o);
        out.advs.set(gae.adv, o);
        out.returns.set(gae.ret, o);
        o += n;
    }
    return out;
}

function policyFrom(ser) {
    const p = new RLPolicy.Policy(ser.inDim, ser.hidden);
    p.loadFrom(ser);
    return p;
}

function pick(mix) {
    const r = Math.random();
    let acc = 0;
    for (const [k, w] of Object.entries(mix)) {
        acc += w;
        if (r <= acc) return k;
    }
    return Object.keys(mix)[0];
}

function pickIndex(weights) {
    const r = Math.random();
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
        acc += weights[i];
        if (r <= acc) return i;
    }
    return weights.length - 1;
}

function rate(eps) {
    return eps.length ? eps.filter(e => e.success).length / eps.length : 0;
}

function goals(results) {
    const gf = results.reduce((a, r) => a + r.gf, 0), ga = results.reduce((a, r) => a + r.ga, 0);
    return `${gf}:${ga}`;
}

function pct(x) {
    return (x * 100).toFixed(0) + '%';
}

function parseArgs(argv, defaults) {
    const out = Object.assign({}, defaults);
    for (let i = 0; i < argv.length; i++) {
        const m = /^--([a-z-]+)$/.exec(argv[i]);
        if (!m) continue;
        const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (!(key in out)) throw new Error('unknown option --' + m[1]);
        if (typeof defaults[key] === 'boolean') {
            const nxt = argv[i + 1];
            if (nxt === 'false' || nxt === 'true') { out[key] = nxt === 'true'; i++; } else out[key] = true;
            continue;
        }
        const v = argv[++i];
        out[key] = typeof defaults[key] === 'number' ? Number(v) : v;
    }
    return out;
}

main();
