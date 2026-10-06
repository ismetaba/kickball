#!/usr/bin/env node
// Train one skill policy on its drill (js/rl/drills.js) with PPO, headless.
//
//   node scripts/train-skill.js --skill dribble
//   node scripts/train-skill.js --skill shoot --gens 300 --out models/skills/shoot.json
//
// Starts at --level (default 1) and moves up a level once the policy succeeds
// in --promote of the evaluation episodes, or once it has stopped improving at
// the current level (--patience evaluations without a new best, at
// --promote-min or better). Lower levels stay in the episode mix so they
// aren't forgotten. The best checkpoint (highest level, then success rate) is
// written to --out, and training resumes from it unless --fresh is given.
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
    patience: 20,       // ...or this many evaluations without improving
    promoteMin: 0.4,    //    while at least this good
    evalEvery: 5,
    evalEpisodes: 300,
    lr: 3e-4,
    lrEnd: null,        // anneal the learning rate linearly to this (default: constant)
    ent: 0.01,
    out: null,
    fresh: false,
    bc: 0,              // heuristic demonstration steps to clone before PPO
});
if (!D.SKILLS.includes(args.skill)) {
    console.error(`usage: node scripts/train-skill.js --skill <${D.SKILLS.join('|')}> [--gens N] [--out file]`);
    process.exit(1);
}
const outFile = path.resolve(args.out || `models/skills/${args.skill}.json`);

const ppo = new PPOTrainer({
    inDim: RLEncoder.STACKED_DIM,
    hidden: args.hidden,
    rolloutLen: args.steps,
    learningRate: args.lr,
    entCoef: args.ent,
});
const trainer = new D.SkillTrainer(args.skill, ppo, {
    steps: args.steps,
    level: args.level,
    promote: args.promote,
    patience: args.patience,
    promoteMin: args.promoteMin,
    evalEpisodes: args.evalEpisodes,
});

if (!args.fresh && fs.existsSync(outFile)) {
    const saved = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (saved.skill === args.skill && ppo.policy.loadFrom(saved.policy)) {
        trainer.level = Math.max(trainer.level, saved.level);
        trainer.best = { level: saved.level, successRate: saved.successRate };
        trainer.totalSteps = saved.totalSteps || 0;
        trainer.generation = saved.generation || 0;
        console.log(`resumed ${outFile}: level ${saved.level}, success ${pct(saved.successRate)}, gen ${trainer.generation}`);
    } else {
        console.log(`ignoring ${outFile} (different skill or network size)`);
    }
}

async function main() {
    if (args.bc > 0) {
        const demo = D.collectDemonstrations(args.skill, D.HEURISTICS[args.skill], args.bc, trainer.levelFor);
        for (let round = 0; round < 3; round++) {
            const r = await ppo.behaviorClone(demo.obs, demo.acts, demo.n, { epochs: 2 });
            console.log(`behavior cloning ${round + 1}/3: loss ${r.loss.toFixed(4)}`);
        }
        const r = trainer.evaluate();
        console.log(`after cloning: eval ${pct(r.successRate)} ${fmtOutcomes(r.outcomes, r.episodes)}`);
    }
    const lrEnd = args.lrEnd === null ? args.lr : args.lrEnd;
    for (let g = 0; g < args.gens; g++) {
        ppo.opts.learningRate = args.lr + (lrEnd - args.lr) * (g / args.gens);
        const t0 = Date.now();
        const { stats, trainSuccess, episodes } = await trainer.trainGeneration();
        let line = `gen ${String(trainer.generation).padStart(4)}  L${trainer.level}`
            + `  ${(trainer.totalSteps / 1e6).toFixed(2)}M steps`
            + `  train ${pct(trainSuccess)} (${episodes} eps)`
            + `  ent ${stats.entropy.toFixed(2)}  kl ${stats.klEst.toFixed(3)}  ${Date.now() - t0}ms`;

        if (trainer.generation % args.evalEvery === 0 || g === args.gens - 1) {
            const c = trainer.checkpoint();
            const r = c.result;
            line += `  | eval ${pct(r.successRate)} ${fmtOutcomes(r.outcomes, r.episodes)}`;
            if (args.skill === 'pull') line += ` pullUse ${pct(r.pullUseRate)}`;
            if (c.improved) {
                save(c.level, r);
                line += '  saved';
            }
            if (c.promoted) line += `  -> level ${trainer.level}${c.plateaued ? ' (plateau)' : ''}`;
        }
        console.log(line);
    }
    console.log(`best: level ${trainer.best.level}, success ${pct(trainer.best.successRate)} -> ${outFile}`);
}

function save(level, evalResult) {
    // Success at every level, so the checkpoint says how good it is overall
    const levels = trainer.report();
    levels[level] = evalResult.successRate;
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({
        kind: 'kickzone-skill',
        version: 1,
        skill: args.skill,
        level,
        successRate: evalResult.successRate,
        levels,
        outcomes: evalResult.outcomes,
        generation: trainer.generation,
        totalSteps: trainer.totalSteps,
        savedAt: new Date().toISOString(),
        policy: ppo.policy.serialize(),
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
        out[key] = typeof defaults[key] === 'number' || key === 'lrEnd' ? Number(v) : v;
    }
    return out;
}

main();
