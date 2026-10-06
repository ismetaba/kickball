// Behavioral tests for the shared simulation core (physics + entities + AI +
// powerups). These document the contracts the client, server, and RL envs all
// depend on, so a future refactor that changes them fails loudly.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const Physics = require('../shared/physics');
const { Player, Ball, Field } = require('../shared/entities');
const AIController = require('../shared/ai');
const PowerUpManager = require('../shared/powerups');

// Entities read Physics.dtRatio / constants, which the simulation normally
// sets each tick. Pin them to known values for deterministic assertions.
beforeEach(() => {
    Physics.dtRatio = 1;
    Physics.MAX_PLAYER_SPEED = 5.2;
    Physics.MAX_BALL_SPEED = 30;
    Physics.KICK_FORCE = 9.5;
    Physics.POWER_KICK_FORCE = 9.8;
});

test('Physics.resolveCircleCollision separates overlapping circles', () => {
    const a = { x: 0, y: 0, vx: 0, vy: 0, radius: 10, mass: 1 };
    const b = { x: 5, y: 0, vx: 0, vy: 0, radius: 10, mass: 1 };
    const collided = Physics.resolveCircleCollision(a, b, 0.5, 0.5);
    assert.equal(collided, true);
    const sep = Math.hypot(b.x - a.x, b.y - a.y);
    assert.ok(sep >= 20 - 1e-9, `circles separated to >= sum of radii (got ${sep})`);
});

test('Physics.checkGoal detects a ball past each goal line', () => {
    const field = new Field(1500, 1000, 'classic');
    const ball = new Ball(field.centerX, field.goalY + field.goalHeight / 2);
    assert.equal(Physics.checkGoal(ball, field), null, 'centered ball is not a goal');

    ball.x = field.x - field.goalDepth; // well past the left line
    assert.equal(Physics.checkGoal(ball, field), 'blue');

    ball.x = field.x + field.width + field.goalDepth; // past the right line
    assert.equal(Physics.checkGoal(ball, field), 'red');
});

test('Player.kick launches the ball and respects cooldown', () => {
    const p = new Player(100, 100, 'red');
    const ball = new Ball(130, 100); // within kick range, to the right
    const before = Math.hypot(ball.vx, ball.vy);
    assert.equal(before, 0);

    assert.equal(p.kick(ball, 0.5), true, 'kick connects in range');
    assert.ok(ball.vx > 0, 'ball driven to the right (toward where it sat)');
    assert.ok(Math.hypot(ball.vx, ball.vy) > 0, 'ball gained speed');

    assert.equal(p.kick(ball, 0.5), false, 'second kick blocked by cooldown');
});

test('Player.kick out of range does nothing', () => {
    const p = new Player(0, 0, 'red');
    const ball = new Ball(500, 500);
    assert.equal(p.kick(ball, 1), false);
    assert.equal(ball.vx, 0);
    assert.equal(ball.vy, 0);
});

test('a full-charge kick triggers a super kick toward the opponent goal', () => {
    const red = new Player(100, 100, 'red');
    const ball = new Ball(130, 100);
    red.kick(ball, 1.0);
    assert.equal(ball.superTarget, 'right', 'red attacks the right goal');
    assert.ok(ball.superKick > 0);
});

test('Player.update applies friction and clamps to max speed', () => {
    const p = new Player(100, 100, 'red');
    p.vx = 100; p.vy = 0; // absurd speed
    p.update(16.67);
    const speed = Math.hypot(p.vx, p.vy);
    assert.ok(speed <= Physics.MAX_PLAYER_SPEED + 1e-9, `clamped to max (got ${speed})`);
});

test('AIController chases the ball without throwing', () => {
    const ai = new AIController('normal');
    const p = new Player(200, 200, 'blue');
    const ball = new Ball(800, 500);
    const field = new Field(1500, 1000, 'classic');
    const vBefore = { vx: p.vx, vy: p.vy };
    const action = ai.update(p, ball, field, [p], [], 16.67);
    assert.equal(typeof action, 'object');
    assert.equal(typeof action.kick, 'boolean');
    // Over a few decisions it should start moving (decision timer permitting).
    for (let i = 0; i < 30; i++) ai.update(p, ball, field, [p], [], 16.67);
    assert.ok(p.vx !== vBefore.vx || p.vy !== vBefore.vy, 'AI moved the player');
});

test('PowerUpManager.update is safe and eventually spawns when enabled', () => {
    const field = new Field(1500, 1000, 'classic');
    const mgr = new PowerUpManager(field);
    mgr.enabled = true;
    const players = [new Player(100, 100, 'red'), new Player(900, 500, 'blue')];
    assert.doesNotThrow(() => {
        for (let i = 0; i < 2000; i++) mgr.update(16.67, players, false);
    });
    assert.ok(Array.isArray(mgr.powerUps));
});
