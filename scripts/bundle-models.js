#!/usr/bin/env node
// Pack trained checkpoints into the model files the game ships with
// (weights as float16, see js/rl/skills.js packPolicy):
//
//   models/skills.json   the four skill policies (scripts/train-skill.js output)
//   models/expert.json   the AI behind Expert difficulty
//
//   node scripts/bundle-models.js \
//       --dribble runs/dribble.json --defend runs/defend.json \
//       --shoot runs/shoot.json --pull runs/pull.json \
//       --expert match --match runs/match.json [--threshold]
//
// --expert match   Expert plays the full-match policy given by --match
//                  (--threshold: kick/pull only when p > 0.5 instead of sampled)
// --expert skills  Expert is the coach driving the four skills
const fs = require('fs');
const path = require('path');
const { SKILLS, packPolicy } = require('../js/rl/skills');

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out || 'models');
fs.mkdirSync(outDir, { recursive: true });

const skills = {};
for (const s of SKILLS) {
    if (!args[s]) throw new Error(`--${s} <checkpoint> is required`);
    const m = JSON.parse(fs.readFileSync(args[s], 'utf8'));
    if (m.skill && m.skill !== s) throw new Error(`${args[s]} is a ${m.skill} model, not ${s}`);
    skills[s] = {
        level: m.level,
        levels: m.levels,
        generation: m.generation,
        totalSteps: m.totalSteps,
        policy: packPolicy(m.policy),
    };
}
write('skills.json', { kind: 'kickzone-skills', version: 1, createdAt: new Date().toISOString(), skills });

const expertKind = args.expert || 'skills';
let expert;
if (expertKind === 'match') {
    if (!args.match) throw new Error('--expert match needs --match <checkpoint>');
    const m = JSON.parse(fs.readFileSync(args.match, 'utf8'));
    expert = {
        kind: 'kickzone-expert', version: 1, type: 'match',
        threshold: !!args.threshold,
        generation: m.generation, eval: m.eval,
        createdAt: new Date().toISOString(),
        policy: packPolicy(m.policy),
    };
} else if (expertKind === 'skills') {
    expert = { kind: 'kickzone-expert', version: 1, type: 'skills', createdAt: new Date().toISOString() };
} else {
    throw new Error('--expert must be match or skills');
}
write('expert.json', expert);

function write(name, obj) {
    const file = path.join(outDir, name);
    const json = JSON.stringify(obj);
    fs.writeFileSync(file, json);
    console.log(`${file}: ${(json.length / 1024).toFixed(0)} KB`);
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const m = /^--([a-z]+)$/.exec(argv[i]);
        if (!m) continue;
        if (m[1] === 'threshold') { out.threshold = true; continue; }
        out[m[1]] = argv[++i];
    }
    return out;
}
