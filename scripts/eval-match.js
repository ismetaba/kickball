#!/usr/bin/env node
// Play full matches between two AIs in the headless match env and report
// wins, draws, losses and goals. Mechanics match a real game: pull, super-kick
// and kick-as-body-check are on; power-ups with --powerups. 1v1 by default,
// 2v2 with --team-size 2 (each side's AI drives both of its players).
//
//   node scripts/eval-match.js --a skills --b rule
//   node scripts/eval-match.js --a skills --skills-dir /tmp/runs --skill-suffix -bc --matches 200
//
// AI kinds:
//   rule     the scripted AIController the game uses today
//   skills   SkillAgent: the coach + four skill policies, loaded from
//            models/skills.json (or --skills-dir/<skill><suffix>.json)
//   model:<file>  a single full-match PPO policy (e.g. models/kickzone-rl-gen1325.json),
//                 kick/pull drawn from their probabilities as in training
//   model-det:<file>  the same, but kick/pull only above p = 0.5 (js/rl/runtime.js today)
//   hybrid:<file>:<skills>  that model plays, except in the situations the coach
//                 gives to the listed skills (comma-separated), e.g.
//                 hybrid:models/kickzone-rl-gen1325.json:shoot,defend
const fs = require('fs');
const path = require('path');

const { HeadlessEnv1v1 } = require('../js/rl/env');
const { HeadlessEnv2v2 } = require('../js/rl/env2v2');
const AIController = require('../shared/ai');
const { SkillAgent, MatchAgent, SKILLS } = require('../js/rl/skills');
const { seededRandom } = require('../js/rl/drills');

const args = parseArgs(process.argv.slice(2), {
    a: 'skills',
    b: 'rule',
    matches: 100,
    teamSize: 1,
    seconds: 180,
    powerups: false,
    seed: 1,
    skillsDir: null,
    skillSuffix: '',
    bundle: 'models/skills.json',
});

// Everything random (env resets, the rule AI) draws from Math.random
Math.random = seededRandom(args.seed);

function loadSkillBundle() {
    if (!args.skillsDir) return JSON.parse(fs.readFileSync(path.resolve(args.bundle), 'utf8'));
    const skills = {};
    for (const s of SKILLS) {
        const file = path.join(args.skillsDir, s + args.skillSuffix + '.json');
        skills[s] = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    return { skills };
}

let makeSkillAgent = null;
const matchFactories = {};
function makeAgent(kind) {
    if (kind === 'rule') return new AIController('normal');
    if (kind === 'skills') {
        if (!makeSkillAgent) makeSkillAgent = SkillAgent.factory(loadSkillBundle());
        return makeSkillAgent();
    }
    const h = /^hybrid:(.+):([a-z,]+)$/.exec(kind);
    if (h) {
        if (!matchFactories[kind]) {
            const base = JSON.parse(fs.readFileSync(h[1], 'utf8'));
            matchFactories[kind] = SkillAgent.factory(loadSkillBundle(), { base, only: h[2].split(',') });
        }
        return matchFactories[kind]();
    }
    const m = /^model(-det)?:(.+)$/.exec(kind);
    if (m) {
        if (!matchFactories[kind]) {
            const model = JSON.parse(fs.readFileSync(m[2], 'utf8'));
            matchFactories[kind] = MatchAgent.factory({ policy: model.policy, threshold: !!m[1] });
        }
        return matchFactories[kind]();
    }
    throw new Error('unknown AI kind: ' + kind);
}

// Run an AI's update() and capture what it asked for as an env action
// (movement and pull are applied by the env, like game.js does per frame).
function act(ai, self, opp, env, teammates = [self], opponents = [opp]) {
    let mx = 0, my = 0, pull = false;
    const applyInput = self.applyInput, activatePull = self.activatePull;
    self.applyInput = (x, y) => { mx = x; my = y; };
    self.activatePull = () => { pull = true; return true; };
    let r;
    try {
        r = ai.update(self, env.ball, env.field, teammates, opponents, 33.34, null);
    } finally {
        self.applyInput = applyInput;
        self.activatePull = activatePull;
    }
    // game.js: an AI kick with no charge given uses 0.3
    return { moveX: mx, moveY: my, kick: !!r.kick, charge: r.chargeRatio || 0.3, pull };
}

const steps = Math.round(args.seconds * 1000 / 33.34);
const totals = { win: 0, draw: 0, loss: 0, gf: 0, ga: 0 };
const skillTime = {};
const t0 = Date.now();
const ENV_OPTS = {
    maxSteps: steps,
    powerUps: args.powerups,
    randomKickoff: false,
    disablePull: false,
    disableSuperKick: false,
    disableKickPlayer: false,
};
for (let m = 0; m < args.matches; m++) {
    const aIsRed = m % 2 === 0;
    let gf, ga;
    if (args.teamSize === 2) {
        const env = new HeadlessEnv2v2(ENV_OPTS);
        env.reset();
        const teamA = aIsRed ? env.red : env.blue, teamB = aIsRed ? env.blue : env.red;
        const aisA = teamA.map(() => makeAgent(args.a)), aisB = teamB.map(() => makeAgent(args.b));
        for (let t = 0; t < steps; t++) {
            const actsA = teamA.map((p, i) => act(aisA[i], p, null, env, teamA, teamB));
            const actsB = teamB.map((p, i) => act(aisB[i], p, null, env, teamB, teamA));
            for (const ai of aisA) if (ai.skill) skillTime[ai.skill] = (skillTime[ai.skill] || 0) + 1;
            env.step(aIsRed ? [...actsA, ...actsB] : [...actsB, ...actsA]);
        }
        gf = aIsRed ? env.scoreRed : env.scoreBlue;
        ga = aIsRed ? env.scoreBlue : env.scoreRed;
    } else {
        const env = new HeadlessEnv1v1(ENV_OPTS);
        env.reset();
        const aiA = makeAgent(args.a), aiB = makeAgent(args.b);
        const pa = aIsRed ? env.red : env.blue, pb = aIsRed ? env.blue : env.red;
        for (let t = 0; t < steps; t++) {
            const actA = act(aiA, pa, pb, env);
            const actB = act(aiB, pb, pa, env);
            if (aiA.skill) skillTime[aiA.skill] = (skillTime[aiA.skill] || 0) + 1;
            env.step(aIsRed ? actA : actB, aIsRed ? actB : actA);
        }
        gf = aIsRed ? env.scoreRed : env.scoreBlue;
        ga = aIsRed ? env.scoreBlue : env.scoreRed;
    }
    totals.gf += gf; totals.ga += ga;
    if (gf > ga) totals.win++; else if (gf < ga) totals.loss++; else totals.draw++;
}

const n = args.matches;
console.log(`${args.a} vs ${args.b}: ${n} ${args.teamSize}v${args.teamSize} matches of ${args.seconds}s${args.powerups ? ' with power-ups' : ''}`
    + ` (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log(`  won ${totals.win}  drew ${totals.draw}  lost ${totals.loss}`
    + `  | goals ${totals.gf}-${totals.ga} (${(totals.gf / n).toFixed(2)} - ${(totals.ga / n).toFixed(2)} per match)`);
const used = Object.values(skillTime).reduce((a, b) => a + b, 0);
if (used) {
    console.log('  skill time: ' + Object.entries(skillTime)
        .map(([k, v]) => `${k} ${Math.round(v / used * 100)}%`).join('  '));
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
