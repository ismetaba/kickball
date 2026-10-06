#!/usr/bin/env node
// Fine-tune one skill inside real matches.
//
//   node scripts/train-skill-in-match.js --skill defend --base match.json --init skills/defend.json
//
// A frozen full-match model (--base) plays; whenever the coach (js/rl/skills.js)
// gives the situation to --skill, the skill policy plays instead and learns
// from what follows in the match. Its advantage is judged with the base
// model's critic, which knows what match states are worth, so the skill is
// credited for the match outcome its play leads to rather than for its
// drill's own success test. Drill episodes stay in the mix (--drill-frac) so
// it keeps its technique.
//
// --use limits the hand-over to some coach situations (js/rl/skills.js
// SITUATIONS), and --hold sets the coach's minimum hold, as in the shipped
// hybrid (bundle-models.js --expert hybrid).
//
// Every --eval-every generations the hybrid (base + this skill) plays the
// base alone and the rule AI; the skill is saved to --out whenever the
// hybrid's result against the base model improves.
const fs = require('fs');
const path = require('path');

const RLPolicy = require('../js/rl/policy');
const { PPOTrainer } = require('../js/rl/trainer');
const { HeadlessEnv1v1 } = require('../js/rl/env');
const AIController = require('../shared/ai');
const D = require('../js/rl/drills');
const { SkillAgent, SkillCoach, MatchAgent, SKILLS, SITUATIONS } = require('../js/rl/skills');
const { MATCH_ENV: GAME_RULES, act, playMatches, fmtResult } = require('./lib/match');

const args = parseArgs(process.argv.slice(2), {
    skill: null,
    base: null,          // frozen full-match model
    init: null,          // starting skill checkpoint (train-skill.js output)
    gens: 200,
    steps: 8192,         // match steps per generation
    drillFrac: 0.3,      // extra drill steps, as a share of match steps
    lr: 1e-4,
    lrEnd: 2e-5,
    ent: 0.005,
    evalEvery: 5,
    evalMatches: 40,
    use: null,           // comma-separated situations where the skill may take over
    hold: 0,             // coach's minimum hold in ms (0: default)
    out: null,
});
if (!SKILLS.includes(args.skill) || !args.base || !args.init) {
    console.error('usage: node scripts/train-skill-in-match.js --skill <skill> --base <match model> --init <skill model> [--out file]');
    process.exit(1);
}
const outFile = path.resolve(args.out || `models/skills/${args.skill}-match.json`);
const situations = args.use ? args.use.split(',') : Object.keys(SITUATIONS).filter(k => SITUATIONS[k] === args.skill);
if (situations.some(k => SITUATIONS[k] !== args.skill)) throw new Error('--use: situations must belong to ' + args.skill);
const holdMs = args.hold || undefined;

const readJSON = (f) => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));
const baseSer = readJSON(args.base).policy;
const base = new RLPolicy.Policy(baseSer.inDim, baseSer.hidden);
if (!base.loadFrom(baseSer)) throw new Error('base model shape mismatch');
const initModel = readJSON(args.init);
const ppo = new PPOTrainer({
    inDim: initModel.policy.inDim,
    hidden: initModel.policy.hidden,
    rolloutLen: args.steps,
    learningRate: args.lr,
    entCoef: args.ent,
});
if (!ppo.policy.loadFrom(initModel.policy)) throw new Error('skill model shape mismatch');
const skillPolicy = ppo.policy;

// Training matches: real-game rules, 60 s episodes, the base model or the
// rule AI as the opponent
const MATCH_ENV = Object.assign({}, GAME_RULES, {
    maxSteps: 1800,
    randomKickoff: true,
    superKickAbusePenalty: 0.05,
    kickPlayerAbusePenalty: 0.03,
});
const match = { env: new HeadlessEnv1v1(MATCH_ENV), side: 'red', oppRule: null, coach: null };
startEpisode();

function startEpisode() {
    match.env.reset();
    match.side = Math.random() < 0.5 ? 'red' : 'blue';
    match.oppRule = Math.random() < 0.4 ? new AIController('normal') : null;
    match.coach = new SkillCoach(holdMs);
}

function collectMatchSegments(T) {
    const inDim = skillPolicy.inDim;
    const b = {
        obs: new Float32Array(T * inDim), actsPre: new Float32Array(T * 3),
        kicks: new Uint8Array(T), pulls: new Uint8Array(T), logProbs: new Float32Array(T),
        vBase: new Float32Array(T),      // base critic: what the state is worth in a match
        vSkill: new Float32Array(T),     // skill critic (left untrained on match data)
        rewards: new Float32Array(T),
        segEnd: new Uint8Array(T),       // the skill's control ended after this step
        segNext: new Float32Array(T),    // ...and the match was then worth this
        n: 0, segments: 0,
    };
    const env = match.env;
    let inSkill = false, last = -1;
    for (let t = 0; t < T; t++) {
        const isRed = match.side === 'red';
        const self = isRed ? env.red : env.blue, opp = isRed ? env.blue : env.red;
        const obs = isRed ? env.stackRed.get() : env.stackBlue.get();
        const pick = match.coach.choose(self, env.ball, opp, env.field, 33.34);
        const want = pick === args.skill && situations.includes(match.coach.spellSituation) ? pick : null;
        const vBase = base.forward(obs).value;
        if (inSkill && want !== args.skill) {
            b.segEnd[last] = 1;
            b.segNext[last] = vBase;
            inSkill = false;
        }
        let myAct;
        if (want === args.skill) {
            const s = skillPolicy.sampleAction(obs);
            const i = b.n++;
            b.obs.set(obs, i * inDim);
            b.actsPre.set(s.action.preCont, i * 3);
            b.kicks[i] = s.action.kick;
            b.pulls[i] = s.action.pull;
            b.logProbs[i] = s.logProb;
            b.vBase[i] = vBase;
            b.vSkill[i] = s.value;
            if (!inSkill) b.segments++;
            last = i;
            inSkill = true;
            myAct = toWorld(s.action, isRed);
        } else {
            myAct = toWorld(base.sampleAction(obs).action, isRed);
        }
        let oppAct;
        if (match.oppRule) oppAct = act(match.oppRule, opp, self, env);
        else oppAct = toWorld(base.sampleAction(isRed ? env.stackBlue.get() : env.stackRed.get()).action, !isRed);
        const out = isRed ? env.step(myAct, oppAct) : env.step(oppAct, myAct);
        if (want === args.skill) b.rewards[last] += isRed ? out.rewardRed : out.rewardBlue;
        if (out.done) {
            if (inSkill) { b.segEnd[last] = 1; b.segNext[last] = 0; inSkill = false; }
            startEpisode();
        }
    }
    if (inSkill) {
        const isRed = match.side === 'red';
        b.segEnd[last] = 1;
        b.segNext[last] = base.forward(isRed ? env.stackRed.get() : env.stackBlue.get()).value;
    }
    return b;
}

// GAE over the skill's match segments, valued by the base critic
function segmentGAE(b, gamma, lam) {
    const n = b.n;
    const adv = new Float32Array(n);
    let lastGae = 0;
    for (let t = n - 1; t >= 0; t--) {
        const end = b.segEnd[t];
        const nv = end ? b.segNext[t] : b.vBase[t + 1];
        const delta = b.rewards[t] + gamma * nv - b.vBase[t];
        lastGae = delta + (end ? 0 : gamma * lam * lastGae);
        adv[t] = lastGae;
    }
    return adv;
}

const drillEnv = new D.DrillEnv(args.skill);
const drillLevel = () => 1 + Math.floor(Math.random() * 3);

function evaluate() {
    const hybrid = () => new SkillAgent({ [args.skill]: skillPolicy }, { base, situations, holdMs });
    const opts = { matches: args.evalMatches, seconds: 120 };
    const vsBase = playMatches(hybrid, () => new MatchAgent(base), opts);
    const vsRule = playMatches(hybrid, () => new AIController('normal'), { matches: 10, seconds: 120 });
    const drills = [1, 2, 3].map(level =>
        D.evaluate(args.skill, D.policyActor(skillPolicy), { level, episodes: 200, seed: 99 }).successRate);
    return { vsBase, vsRule, drills };
}

function fmt(e) {
    return `hybrid vs base ${fmtResult(e.vsBase)} (${Math.round(e.vsBase.points * 100)}%)`
        + `  vs rule ${fmtResult(e.vsRule)}  drill L1/L2/L3 ${e.drills.map(x => Math.round(x * 100)).join('/')}`;
}

async function main() {
    let best = -1;
    const start = evaluate();
    console.log('start: ' + fmt(start));
    for (let g = 1; g <= args.gens; g++) {
        ppo.opts.learningRate = args.lr + (args.lrEnd - args.lr) * ((g - 1) / args.gens);
        const t0 = Date.now();
        const m = collectMatchSegments(args.steps);
        const mAdv = segmentGAE(m, 0.995, 0.95);
        const drillSteps = Math.round(args.steps * args.drillFrac);
        const d = D.collectRollout(drillEnv, skillPolicy, drillSteps, drillLevel);
        const dg = D.computeEpisodicGAE(d.rewards, d.values, d.dones, d.nextValue, 0.99, 0.95);
        const n = m.n, N = n + drillSteps, inDim = skillPolicy.inDim;
        const batch = {
            obs: new Float32Array(N * inDim), actsPre: new Float32Array(N * 3),
            kicks: new Uint8Array(N), pulls: new Uint8Array(N),
            logProbsOld: new Float32Array(N), advs: new Float32Array(N), returns: new Float32Array(N),
        };
        batch.obs.set(m.obs.subarray(0, n * inDim)); batch.obs.set(d.obs, n * inDim);
        batch.actsPre.set(m.actsPre.subarray(0, n * 3)); batch.actsPre.set(d.actsPre, n * 3);
        batch.kicks.set(m.kicks.subarray(0, n)); batch.kicks.set(d.kicks, n);
        batch.pulls.set(m.pulls.subarray(0, n)); batch.pulls.set(d.pulls, n);
        batch.logProbsOld.set(m.logProbs.subarray(0, n)); batch.logProbsOld.set(d.logProbs, n);
        batch.advs.set(mAdv); batch.advs.set(dg.adv, n);
        // The skill's critic keeps estimating drill returns: on match samples
        // its target is its own prediction (no value gradient)
        batch.returns.set(m.vSkill.subarray(0, n)); batch.returns.set(dg.ret, n);
        const stats = await ppo.update(batch);
        const drillOk = d.episodes.length ? d.episodes.filter(e => e.success).length / d.episodes.length : 0;
        let line = `gen ${String(g).padStart(4)}  ${Date.now() - t0}ms  match samples ${n} in ${m.segments} spells`
            + `  drill ${Math.round(drillOk * 100)}%  ent ${stats.entropy.toFixed(2)} kl ${stats.klEst.toFixed(3)}`;
        if (g % args.evalEvery === 0 || g === args.gens) {
            const e = evaluate();
            line += '\n      ' + fmt(e);
            if (e.vsBase.points > best) {
                best = e.vsBase.points;
                fs.mkdirSync(path.dirname(outFile), { recursive: true });
                fs.writeFileSync(outFile, JSON.stringify({
                    kind: 'kickzone-skill', version: 1, skill: args.skill,
                    level: initModel.level,
                    levels: { 1: e.drills[0], 2: e.drills[1], 3: e.drills[2] },
                    generation: (initModel.generation || 0) + g,
                    totalSteps: initModel.totalSteps,
                    matchTuned: { base: args.base, situations, holdMs, generations: g, vsBase: e.vsBase, vsRule: e.vsRule },
                    savedAt: new Date().toISOString(),
                    policy: skillPolicy.serialize(),
                }));
                line += '  saved';
            }
        }
        console.log(line);
    }
}

function toWorld(a, isRed) {
    return {
        moveX: isRed ? a.mvX : -a.mvX,
        moveY: a.mvY,
        kick: a.kick === 1,
        charge: a.chg * 0.95,
        pull: a.pull === 1,
    };
}

function parseArgs(argv, defaults) {
    const out = Object.assign({}, defaults);
    for (let i = 0; i < argv.length; i++) {
        const m = /^--([a-z-]+)$/.exec(argv[i]);
        if (!m) continue;
        const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (!(key in out)) throw new Error('unknown option --' + m[1]);
        if (typeof defaults[key] === 'boolean') { out[key] = true; continue; }
        const v = argv[++i];
        out[key] = typeof defaults[key] === 'number' ? Number(v) : v;
    }
    return out;
}

main();
