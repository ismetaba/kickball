// Tests for the skill-based runtime AI (js/rl/skills.js): the coach's skill
// choice, the agent's game-facing behavior, and the float16 model packing.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Physics = require('../shared/physics');
const { Player, Ball, Field } = require('../shared/entities');
const RLEncoder = require('../js/rl/encoder');
const RLPolicy = require('../js/rl/policy');
const S = require('../js/rl/skills');

const field = new Field(1500, 1000, 'classic');
const goalCY = field.goalY + field.goalHeight / 2;
const atProgress = (p) => field.x + field.width * p;

// A policy whose output ignores the input: actor biases set the action.
function constantPolicy({ moveX = 0, moveY = 0, kick = false, pull = false, charge = 0.5 } = {}) {
    const p = new RLPolicy.Policy(RLEncoder.STACKED_DIM, 8);
    p.l1.W.fill(0); p.l2.W.fill(0); p.actor.W.fill(0); p.critic.W.fill(0);
    const atanh = (x) => 0.5 * Math.log((1 + x) / (1 - x));
    p.actor.b[0] = atanh(Math.max(-0.999, Math.min(0.999, moveX)));
    p.actor.b[1] = atanh(Math.max(-0.999, Math.min(0.999, moveY)));
    p.actor.b[2] = Math.log(charge / (1 - charge));
    p.actor.b[3] = kick ? 10 : -10;
    p.actor.b[4] = pull ? 10 : -10;
    return p;
}

function agentWith(policy) {
    const policies = {};
    for (const s of S.SKILLS) policies[s] = policy;
    return new S.SkillAgent(policies);
}

test('the coach hands each situation to the right skill', () => {
    const red = new Player(0, goalCY, 'red');
    const blue = new Player(0, goalCY, 'blue');
    const ball = new Ball(0, goalCY);
    const place = (pRed, pBlue, pBall, vx = 0) => {
        red.x = atProgress(pRed); blue.x = atProgress(pBlue); ball.x = atProgress(pBall);
        red.y = blue.y = goalCY + 150; ball.y = goalCY + 150;
        ball.vx = vx; ball.vy = 0;
        return S.pickSkill(S.readSituation(red, ball, blue, field));
    };
    assert.equal(place(0.3, 0.8, 0.32), 'dribble', 'own ball in our half');
    assert.equal(place(0.7, 0.2, 0.72), 'shoot', 'own ball in the attacking zone');
    assert.equal(place(0.6, 0.3, 0.28), 'defend', 'opponent has it in our half');
    assert.equal(place(0.4, 0.7, 0.68), 'pull', 'opponent has it in their half');
    assert.equal(place(0.45, 0.9, 0.6), 'pull', 'loose ball, we are closer');
    assert.equal(place(0.7, 0.2, 0.85), 'shoot', 'loose ball near their goal, we are closer');
    assert.equal(place(0.1, 0.35, 0.25), 'defend', 'loose ball in our half, they are closer');

    // A shot into our goal mouth beats everything else
    red.x = atProgress(0.5); blue.x = atProgress(0.9);
    ball.x = atProgress(0.3); ball.y = goalCY; ball.vx = -12; ball.vy = 0;
    assert.equal(S.pickSkill(S.readSituation(red, ball, blue, field)), 'defend');

    // The same picture seen by blue (mirrored) gives the same answer
    const b2 = new Player(atProgress(0.3), goalCY + 150, 'blue');
    const r2 = new Player(atProgress(0.8), goalCY + 150, 'red');
    const ball2 = new Ball(atProgress(0.28), goalCY + 150);
    assert.equal(S.pickSkill(S.readSituation(b2, ball2, r2, field)), 'shoot',
        'blue with the ball near the red goal shoots');
});

test('the coach holds a skill briefly unless a shot is coming', () => {
    const coach = new S.SkillCoach();
    const red = new Player(atProgress(0.3), goalCY + 150, 'red');
    const blue = new Player(atProgress(0.9), goalCY + 150, 'blue');
    const ball = new Ball(atProgress(0.32), goalCY + 150);
    assert.equal(coach.choose(red, ball, blue, field, 33), 'dribble');
    // Ball now in the attacking zone at our feet: shoot, but not instantly
    red.x = atProgress(0.7); ball.x = atProgress(0.72);
    assert.equal(coach.choose(red, ball, blue, field, 33), 'dribble', 'held');
    for (let i = 0; i < 6; i++) coach.choose(red, ball, blue, field, 33);
    assert.equal(coach.skill, 'shoot', 'switched after the hold time');
    // A shot on goal switches to defend immediately
    red.x = atProgress(0.6); ball.x = atProgress(0.3); ball.y = goalCY; ball.vx = -12;
    assert.equal(coach.choose(red, ball, blue, field, 33), 'defend');
});

test('the agent drives the player through the game AI interface', () => {
    Physics.dtRatio = 1.2;
    const agent = agentWith(constantPolicy({ moveX: 1, kick: true, pull: true, charge: 0.5 }));
    const red = new Player(atProgress(0.3), goalCY, 'red');
    const blue = new Player(atProgress(0.7), goalCY, 'blue');
    const ball = new Ball(atProgress(0.32), goalCY);
    const r = agent.update(red, ball, field, [red], [blue], 16.67);
    assert.equal(r.kick, true);
    assert.ok(Math.abs(r.chargeRatio - 0.5 * 0.95) < 1e-6, 'charge squashed like in training');
    assert.ok(red.vx > 0, 'moved forward (toward the blue goal)');
    assert.equal(red.pullActive, true, 'pull started');
    assert.ok(S.SKILLS.includes(agent.skill));
    // Decisions happen every 33 ms; the kick is attempted once per decision
    const r2 = agent.update(red, ball, field, [red], [blue], 16.67);
    assert.equal(r2.kick, false);

    // For blue, "forward" is toward the red goal
    const blueAgent = agentWith(constantPolicy({ moveX: 1 }));
    const b = new Player(atProgress(0.7), goalCY, 'blue');
    blueAgent.update(b, ball, field, [b], [red], 16.67);
    assert.ok(b.vx < 0, 'blue moved toward the red goal');
});

test('in team games only the player nearest the ball uses the skills', () => {
    Physics.dtRatio = 1.2;
    const agent = agentWith(constantPolicy({ moveX: 1 }));
    const ball = new Ball(atProgress(0.5), goalCY);
    const near = new Player(atProgress(0.48), goalCY, 'red');
    const far = new Player(atProgress(0.1), goalCY, 'red');
    const opp = new Player(atProgress(0.8), goalCY, 'blue');
    agent.update(far, ball, field, [near, far], [opp], 16.67);
    assert.equal(agent.skill, null, 'the far player is positioned by the scripted AI');
    agent.update(near, ball, field, [near, far], [opp], 16.67);
    assert.ok(S.SKILLS.includes(agent.skill), 'the near player plays a skill');
});

test('float16 packing keeps weights to within half precision', () => {
    const values = Float32Array.from([0, -0, 1, -1, 0.1, -0.333, 3.14159, 1e-3, -2.5e-5, 6e-8, 1000, -60000]);
    const back = S.fromFloat16Base64(S.toFloat16Base64(values));
    for (let i = 0; i < values.length; i++) {
        const v = values[i], b = back[i];
        const tol = Math.max(Math.abs(v) * 1e-3, 6e-8);
        assert.ok(Math.abs(b - v) <= tol, `${v} -> ${b}`);
    }
});

test('a packed policy decodes to (almost) the same network', () => {
    const p = new RLPolicy.Policy(RLEncoder.STACKED_DIM, 32);
    const packed = S.packPolicy(p.serialize());
    const json = JSON.stringify(packed);
    assert.ok(json.length < JSON.stringify(p.serialize()).length / 3, 'much smaller than plain JSON');
    const q = S.decodePolicy(JSON.parse(json));
    const x = new Float32Array(RLEncoder.STACKED_DIM).map(() => Math.random() * 2 - 1);
    const a = Array.from(p.forward(x).raw);
    const b = Array.from(q.forward(x).raw);
    for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-2, `output ${i}: ${a[i]} vs ${b[i]}`);
});

test('a hybrid agent lets the base model play except in its skills\' situations', () => {
    Physics.dtRatio = 1.2;
    const forward = constantPolicy({ moveX: 1 });
    const backward = constantPolicy({ moveX: -1 });
    const make = S.SkillAgent.factory({ skills: { defend: backward } }, { base: forward, only: ['defend'] });
    const agent = make();
    const red = new Player(atProgress(0.3), goalCY + 150, 'red');
    const blue = new Player(atProgress(0.9), goalCY + 150, 'blue');
    // Our ball in our half: the coach says dribble, which isn't in the hybrid -> base model
    const ball = new Ball(atProgress(0.32), goalCY + 150);
    agent.update(red, ball, field, [red], [blue], 16.67);
    assert.equal(agent.skill, 'dribble');
    assert.ok(red.vx > 0, 'base model moved forward');
    // A shot on our goal: defend takes over
    const shot = new Ball(atProgress(0.2), goalCY);
    shot.vx = -12;
    const agent2 = make();
    const red2 = new Player(atProgress(0.3), goalCY + 150, 'red');
    agent2.update(red2, shot, field, [red2], [blue], 16.67);
    assert.equal(agent2.skill, 'defend');
    assert.ok(red2.vx < 0, 'defend skill moved back');
});

test('a skill that takes over plays out its spell, then hands back to the base', () => {
    Physics.dtRatio = 1.2;
    const forward = constantPolicy({ moveX: 1 });
    const backward = constantPolicy({ moveX: -1 });
    // Defend may take over only when a shot is coming
    const agent = S.SkillAgent.factory({ skills: { defend: backward } }, { base: forward, only: ['shot'] })();
    const red = new Player(atProgress(0.4), goalCY + 200, 'red');
    const blue = new Player(atProgress(0.9), goalCY + 200, 'blue');
    const ball = new Ball(atProgress(0.3), goalCY);
    ball.vx = -12;
    const step = () => { const vx0 = red.vx; agent.update(red, ball, field, [red], [blue], 33.34); return red.vx - vx0; };
    assert.ok(step() < 0, 'shot incoming: defend takes over');
    // The ball stops: no longer a shot, but defend finishes its spell (the coach's hold)
    ball.vx = 0;
    assert.equal(agent.coach.situation, 'shot');
    assert.ok(step() < 0, 'still defending during the hold');
    assert.notEqual(agent.coach.situation, 'shot');
    // Once the hold is over the coach moves on and the base model plays again
    for (let i = 0; i < 8; i++) step();
    assert.ok(step() > 0, 'base model back in control');
});
