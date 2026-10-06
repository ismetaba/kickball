#!/usr/bin/env node
// Choose where the skills should take over from a full-match model, by
// playing matches. Starting from the base model alone, try handing each coach
// situation (js/rl/skills.js SITUATIONS) to its skill and keep the one that
// most improves the hybrid's result against the base model; repeat until no
// situation helps by at least --margin.
//
//   node scripts/tune-coach.js --base match.json --bundle skills.json --matches 200 --jobs 8
//
// Every candidate is played with the same seed, so they face the same
// kickoffs and random draws. Prints the chosen situations, ready for
// bundle-models.js --expert hybrid --use <list>.
const { execFile } = require('child_process');
const path = require('path');
const { SITUATIONS } = require('../js/rl/skills');

const args = parseArgs(process.argv.slice(2), {
    base: null,
    bundle: 'models/skills.json',
    matches: 200,
    seconds: 120,
    margin: 0.02,
    jobs: 8,
    seed: 7,
});
if (!args.base) {
    console.error('usage: node scripts/tune-coach.js --base <match model> [--bundle skills.json]');
    process.exit(1);
}

function evalHybrid(situations) {
    const a = situations.length ? `hybrid:${args.base}:${situations.join(',')}` : `model:${args.base}`;
    const cli = [path.join(__dirname, 'eval-match.js'), '--a', a, '--b', `model:${args.base}`,
        '--bundle', args.bundle, '--matches', String(args.matches), '--seconds', String(args.seconds),
        '--seed', String(args.seed), '--json'];
    return new Promise((resolve, reject) => {
        execFile(process.execPath, cli, { maxBuffer: 1 << 20 }, (err, stdout) => {
            if (err) reject(err); else resolve(JSON.parse(stdout.trim().split('\n').pop()));
        });
    });
}

async function pool(tasks, n) {
    const out = new Array(tasks.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
        while (next < tasks.length) {
            const i = next++;
            out[i] = await tasks[i]();
        }
    }));
    return out;
}

const fmt = (r) => `${r.win}-${r.draw}-${r.loss} (${r.gf}:${r.ga}) ${(r.points * 100).toFixed(1)}%`;

async function main() {
    const chosen = [];
    let best = await evalHybrid(chosen);
    console.log(`base alone vs base: ${fmt(best)}`);
    for (;;) {
        const candidates = Object.keys(SITUATIONS).filter(k => !chosen.includes(k));
        if (!candidates.length) break;
        const results = await pool(candidates.map(k => () => evalHybrid([...chosen, k])), args.jobs);
        results.forEach((r, i) => console.log(`  + ${candidates[i].padEnd(15)} (${SITUATIONS[candidates[i]]}) ${fmt(r)}`));
        let bi = 0;
        results.forEach((r, i) => { if (r.points > results[bi].points) bi = i; });
        if (results[bi].points < best.points + args.margin) break;
        chosen.push(candidates[bi]);
        best = results[bi];
        console.log(`keep ${candidates[bi]} -> [${chosen.join(',')}] ${fmt(best)}`);
    }
    console.log(`\nchosen: ${chosen.length ? chosen.join(',') : '(none: the base model alone is best)'}`);
}

function parseArgs(argv, defaults) {
    const out = Object.assign({}, defaults);
    for (let i = 0; i < argv.length; i++) {
        const m = /^--([a-z-]+)$/.exec(argv[i]);
        if (!m) continue;
        const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (!(key in out)) throw new Error('unknown option --' + m[1]);
        const v = argv[++i];
        out[key] = typeof defaults[key] === 'number' ? Number(v) : v;
    }
    return out;
}

main();
