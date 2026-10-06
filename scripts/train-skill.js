#!/usr/bin/env node
// Train one skill policy on its drill (js/rl/drills.js) with PPO, headless.
//
//   node scripts/train-skill.js --skill dribble
//   node scripts/train-skill.js --skill shoot --gens 300 --out models/skills/shoot.json
//
// Starts at --level (default 1) and moves up a level once the deterministic
// policy succeeds in --promote of the evaluation episodes. Lower levels stay
// in the episode mix so they aren't forgotten. The best checkpoint (highest
// level, then success rate) is written to --out, and training resumes from it
// unless --fresh is given.
//
// --bc N first behavior-clones N steps of the drill's reference heuristic
// (drills.js HEURISTICS), so PPO starts from a competent player instead of
// a random one.
const fs = require('fs');
const path = require('path');

const RLEncoder = require('../js/rl/encoder');
const { PPOTrainer } = require('../js/rl/trainer');
const D = require('../js/rl/drills');

const args = parseArgs(process.argv.slice(2), {
    skill: null,
    gens: 200,          // PPO generations
    steps: 8192,        // environment steps per generation
    hidden: 128,
    level: 1,
    promote: 0.8,       // success rate that unlocks the next level
    evalEvery: 5,
    evalEpisodes: 300,
    lr: 3e-4,
    ent: 0.01,
    gamma: 0.99,
    lambda: 0.95,
    out: null,
    fresh: false,
    bc: 0,              // heuristic demonstration steps to clone before PPO
});
if (!D.SKILLS.includes(args.skill)) {
    console.error(`usage: node scripts/train-skill.js --skill <${D.SKILLS.join('|')}> [--gens N] [--out file]`);
    process.exit(1);
}
const outFile = path.resolve(args.out || `models/skills/${args.skill}.json`);

const trainer = new PPOTrainer({
    inDim: RLEncoder.STACKED_DIM,
    hidden: args.hidden,
    rolloutLen: args.steps,
    learningRate: args.lr,
    entCoef: args.ent,
});

let level = args.level;
let best = { level: 0, successRate: -1 };
let totalSteps = 0;
let generation = 0;
if (!args.fresh && fs.existsSync(outFile)) {
    const saved = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (saved.skill === args.skill && trainer.policy.loadFrom(saved.policy)) {
        level = Math.max(level, saved.level);
        best = { level: saved.level, successRate: saved.successRate };
        totalSteps = saved.totalSteps || 0;
        generation = saved.generation || 0;
        console.log(`resumed ${outFile}: level ${saved.level}, success ${pct(saved.successRate)}, gen ${generation}`);
    } else {
        console.log(`ignoring ${outFile} (different skill or network size)`);
    }
}

// 70% of episodes at the current level, the rest spread over earlier ones
function levelFor() {
    if (level === 1 || Math.random() < 0.7) return level;
    return 1 + Math.floor(Math.random() * (level - 1));
}

const env = new D.DrillEnv(args.skill, { level });

(async () => {
    if (args.bc > 0) {
        const demo = D.collectDemonstrations(args.skill, D.HEURISTICS[args.skill], args.bc, levelFor);
        for (let round = 0; round < 3; round++) {
            const r = await trainer.behaviorClone(demo.obs, demo.acts, demo.n, { epochs: 2 });
            console.log(`behavior cloning ${round + 1}/3: loss ${r.loss.toFixed(4)}`);
        }
        const r = D.evaluate(args.skill, D.policyActor(trainer.policy),
            { level, episodes: args.evalEpisodes, seed: 1234 });
        console.log(`after cloning: eval ${pct(r.successRate)} ${fmtOutcomes(r.outcomes, r.episodes)}`);
    }
    for (let g = 0; g < args.gens; g++) {
        generation++;
        const t0 = Date.now();
        const batch = D.collectRollout(env, trainer.policy, args.steps, levelFor);
        const tRoll = Date.now() - t0;
        const { adv, ret } = D.computeEpisodicGAE(batch.rewards, batch.values, batch.dones,
            batch.nextValue, args.gamma, args.lambda);
        const stats = await trainer.update({
            obs: batch.obs, actsPre: batch.actsPre, kicks: batch.kicks, pulls: batch.pulls,
            logProbsOld: batch.logProbs, advs: adv, returns: ret,
        });
        totalSteps += args.steps;

        const atLevel = batch.episodes.filter(e => e.level === level);
        const trainSucc = atLevel.length ? atLevel.filter(e => e.success).length / atLevel.length : 0;
        let line = `gen ${String(generation).padStart(4)}  L${level}  ${(totalSteps / 1e6).toFixed(2)}M steps`
            + `  train ${pct(trainSucc)} (${atLevel.length} eps)`
            + `  ent ${stats.entropy.toFixed(2)}  kl ${stats.klEst.toFixed(3)}`
            + `  ${tRoll}+${Date.now() - t0 - tRoll}ms`;

        if (generation % args.evalEvery === 0 || g === args.gens - 1) {
            const r = D.evaluate(args.skill, D.policyActor(trainer.policy),
                { level, episodes: args.evalEpisodes, seed: 1234 });
            line += `  | eval ${pct(r.successRate)} ${fmtOutcomes(r.outcomes, r.episodes)}`;
            if (args.skill === 'pull') line += ` pullUse ${pct(r.pullUseRate)}`;
            if (level > best.level || (level === best.level && r.successRate > best.successRate)) {
                best = { level, successRate: r.successRate };
                save(r);
                line += '  saved';
            }
            if (r.successRate >= args.promote && level < D.MAX_LEVEL) {
                level++;
                line += `  -> level ${level}`;
            }
        }
        console.log(line);
    }
    console.log(`best: level ${best.level}, success ${pct(best.successRate)} -> ${outFile}`);
})();

function save(evalResult) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({
        kind: 'kickzone-skill',
        version: 1,
        skill: args.skill,
        level,
        successRate: evalResult.successRate,
        outcomes: evalResult.outcomes,
        generation,
        totalSteps,
        savedAt: new Date().toISOString(),
        policy: trainer.policy.serialize(),
    }));
}

function pct(x) {
    return (x * 100).toFixed(0).padStart(3) + '%';
}

function fmtOutcomes(outcomes, n) {
    return Object.entries(outcomes)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${Math.round(v / n * 100)}`)
        .join(' ');
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
