#!/usr/bin/env node
// Play full matches between two AIs in the headless match env and report
// wins, draws, losses and goals. Mechanics match a real game: pull, super-kick
// and kick-as-body-check are on; power-ups with --powerups. 1v1 by default,
// 2v2 with --team-size 2 (each side's AI drives both of its players).
//
//   node scripts/eval-match.js --a expert --b rule
//   node scripts/eval-match.js --a skills --skills-dir /tmp/runs --skill-suffix -bc --matches 200
//
// AI kinds:
//   rule     the scripted AIController the game uses on Normal
//   expert   the shipped Expert AI (models/expert.json + models/skills.json)
//   skills   SkillAgent: the coach + four skill policies, loaded from
//            models/skills.json (or --bundle, or --skills-dir/<skill><suffix>.json)
//   model:<file>  a single full-match PPO policy (e.g. models/kickzone-rl-gen1325.json),
//                 kick/pull drawn from their probabilities as in training
//   model-det:<file>  the same, but kick/pull only above p = 0.5
//   hybrid:<file>:<skills>  that model plays, except in the situations the coach
//                 gives to the listed skills (comma-separated), e.g.
//                 hybrid:models/kickzone-rl-gen1325.json:shoot,defend
const fs = require('fs');
const path = require('path');

const AIController = require('../shared/ai');
const { SkillAgent, MatchAgent, SKILLS } = require('../js/rl/skills');
const { seededRandom } = require('../js/rl/drills');
const { playMatches, fmtResult } = require('./lib/match');

const args = parseArgs(process.argv.slice(2), {
    a: 'expert',
    b: 'rule',
    matches: 100,
    teamSize: 1,
    seconds: 180,
    powerups: false,
    seed: 1,
    skillsDir: null,
    skillSuffix: '',
    bundle: 'models/skills.json',
    expert: 'models/expert.json',
});

// Everything random (env resets, the AIs' kick/pull draws) uses Math.random
Math.random = seededRandom(args.seed);

const readJSON = (f) => JSON.parse(fs.readFileSync(path.resolve(f), 'utf8'));

function loadSkillBundle() {
    if (!args.skillsDir) return readJSON(args.bundle);
    const skills = {};
    for (const s of SKILLS) skills[s] = readJSON(path.join(args.skillsDir, s + args.skillSuffix + '.json'));
    return { skills };
}

const factories = {};
function factoryFor(kind) {
    if (kind === 'rule') return () => new AIController('normal');
    if (factories[kind]) return factories[kind];
    let f;
    let m;
    if (kind === 'skills') {
        f = SkillAgent.factory(loadSkillBundle());
    } else if (kind === 'expert') {
        const e = readJSON(args.expert);
        if (e.type === 'skills') f = SkillAgent.factory(loadSkillBundle());
        else if (e.type === 'hybrid') f = SkillAgent.factory(loadSkillBundle(), { base: e, only: e.skills });
        else f = MatchAgent.factory(e);
    } else if ((m = /^hybrid:(.+):([a-z,]+)$/.exec(kind))) {
        f = SkillAgent.factory(loadSkillBundle(), { base: readJSON(m[1]), only: m[2].split(',') });
    } else if ((m = /^model(-det)?:(.+)$/.exec(kind))) {
        f = MatchAgent.factory({ policy: readJSON(m[2]).policy, threshold: !!m[1] });
    } else {
        throw new Error('unknown AI kind: ' + kind);
    }
    factories[kind] = f;
    return f;
}

const t0 = Date.now();
const r = playMatches(factoryFor(args.a), factoryFor(args.b), {
    matches: args.matches, seconds: args.seconds, teamSize: args.teamSize, powerups: args.powerups,
});
const n = args.matches;
console.log(`${args.a} vs ${args.b}: ${n} ${args.teamSize}v${args.teamSize} matches of ${args.seconds}s`
    + `${args.powerups ? ' with power-ups' : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log(`  won-drew-lost ${fmtResult(r)}  | ${(r.gf / n).toFixed(2)} - ${(r.ga / n).toFixed(2)} goals per match`
    + `  | points ${(r.points * 100).toFixed(0)}%`);
const used = Object.values(r.skillTime).reduce((a, b) => a + b, 0);
if (used) {
    console.log('  coach time: ' + Object.entries(r.skillTime)
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
