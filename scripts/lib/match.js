// Headless matches between AIs, shared by the training and evaluation scripts.
//
// Any AI with the game's AIController interface plays (AIController itself,
// SkillAgent, MatchAgent): update() moves the player and starts its pull,
// which act() captures and hands to the env as an action, the way game.js
// applies AI input every frame.
const { HeadlessEnv1v1 } = require('../../js/rl/env');
const { HeadlessEnv2v2 } = require('../../js/rl/env2v2');

// Real-game mechanics: pull, the homing super-kick and kick-as-body-check
const MATCH_ENV = {
    map: 'classic',
    powerUps: false,
    randomKickoff: false,
    disablePull: false,
    disableSuperKick: false,
    disableKickPlayer: false,
};

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

// Play `matches` matches of makeA() vs makeB(), alternating sides.
// Returns { win, draw, loss, gf, ga, points } from A's side (points: win 1,
// draw 0.5, as a share of matches) plus skillTime: steps A spent per skill.
function playMatches(makeA, makeB, opts = {}) {
    const matches = opts.matches || 20;
    const steps = Math.round((opts.seconds || 120) * 1000 / 33.34);
    const envOpts = Object.assign({}, MATCH_ENV, { maxSteps: steps, powerUps: !!opts.powerups });
    const res = { win: 0, draw: 0, loss: 0, gf: 0, ga: 0, points: 0, skillTime: {} };
    const tally = (ai) => { if (ai.skill) res.skillTime[ai.skill] = (res.skillTime[ai.skill] || 0) + 1; };
    for (let m = 0; m < matches; m++) {
        const aIsRed = m % 2 === 0;
        let env;
        if (opts.teamSize === 2) {
            env = new HeadlessEnv2v2(envOpts);
            env.reset();
            const teamA = aIsRed ? env.red : env.blue, teamB = aIsRed ? env.blue : env.red;
            const aisA = teamA.map(() => makeA()), aisB = teamB.map(() => makeB());
            for (let t = 0; t < steps; t++) {
                const actsA = teamA.map((p, i) => act(aisA[i], p, null, env, teamA, teamB));
                const actsB = teamB.map((p, i) => act(aisB[i], p, null, env, teamB, teamA));
                aisA.forEach(tally);
                env.step(aIsRed ? [...actsA, ...actsB] : [...actsB, ...actsA]);
            }
        } else {
            env = new HeadlessEnv1v1(envOpts);
            env.reset();
            const a = makeA(), b = makeB();
            const pa = aIsRed ? env.red : env.blue, pb = aIsRed ? env.blue : env.red;
            for (let t = 0; t < steps; t++) {
                const actA = act(a, pa, pb, env);
                const actB = act(b, pb, pa, env);
                tally(a);
                env.step(aIsRed ? actA : actB, aIsRed ? actB : actA);
            }
        }
        const gf = aIsRed ? env.scoreRed : env.scoreBlue;
        const ga = aIsRed ? env.scoreBlue : env.scoreRed;
        res.gf += gf; res.ga += ga;
        if (gf > ga) res.win++; else if (gf < ga) res.loss++; else res.draw++;
    }
    res.points = (res.win + 0.5 * res.draw) / matches;
    return res;
}

function fmtResult(r) {
    return `${r.win}-${r.draw}-${r.loss} (${r.gf}:${r.ga})`;
}

module.exports = { MATCH_ENV, act, playMatches, fmtResult };
