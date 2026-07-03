// Lockstep determinism replay test.
//
// P2P multiplayer runs the identical simulation on every peer and only
// exchanges inputs, so the shared core MUST be bit-identical given the same
// seed and the same input sequence. This test assembles a headless match from
// the shared modules (AI + power-ups + physics — every consumer of randomness
// in the sim path), replays it twice, and compares a full state hash at every
// tick. Any reintroduction of Math.random()/Date.now() into the sim path
// makes this fail immediately.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Physics = require('../shared/physics');
const { Player, Ball, Field } = require('../shared/entities');
const AIController = require('../shared/ai');
const PowerUpManager = require('../shared/powerups');

// Mirror of the client's SeededRNG (js/game.js) — xorshift32.
class SeededRNG {
    constructor(seed) { this.s = seed || 1; }
    next() {
        this.s ^= this.s << 13;
        this.s ^= this.s >> 17;
        this.s ^= this.s << 5;
        return (this.s >>> 0) / 4294967296;
    }
}

const TICK_MS = 16.67;

function hashState(players, ball, mgr, rng) {
    let h = 0;
    const add = (v) => { h = (h * 31 + (v | 0)) | 0; };
    for (const p of players) {
        add(p.x * 10); add(p.y * 10); add(p.vx * 100); add(p.vy * 100);
        add(p.kickCooldown); add(p.powerUpTimer);
        add(p.powerUp ? p.powerUp.length : 0);
    }
    add(ball.x * 10); add(ball.y * 10); add(ball.vx * 100); add(ball.vy * 100);
    add(ball.spin * 100);
    add(mgr.spawnTimer);
    for (const pu of mgr.powerUps) { add(pu.x); add(pu.y); add(pu.type.id.length); }
    add(rng.s);
    return h;
}

// Run a headless 2v2 match for `ticks` ticks with all four players
// AI-controlled, seeded power-up spawns, and full physics. Returns the
// per-tick hash sequence plus the final power-up layout.
function runMatch(seed, ticks) {
    const rng = new SeededRNG(seed);
    const field = new Field(1500, 1000, 'classic');
    const ball = new Ball(field.centerX, field.centerY);
    const players = [
        new Player(field.x + field.width * 0.25, field.centerY - 100, 'red'),
        new Player(field.x + field.width * 0.25, field.centerY + 100, 'red'),
        new Player(field.x + field.width * 0.75, field.centerY - 100, 'blue'),
        new Player(field.x + field.width * 0.75, field.centerY + 100, 'blue'),
    ];
    const ais = players.map(() => new AIController('normal'));
    const mgr = new PowerUpManager(field);
    mgr.enabled = true;
    mgr.spawnTimer = 14000; // cross the 15s spawn threshold quickly

    const red = players.filter(p => p.team === 'red');
    const blue = players.filter(p => p.team === 'blue');
    const hashes = new Array(ticks);

    for (let t = 0; t < ticks; t++) {
        Physics.dtRatio = Physics.GAME_SPEED;

        for (let i = 0; i < players.length; i++) {
            const p = players[i];
            const teammates = p.team === 'red' ? red : blue;
            const opponents = p.team === 'red' ? blue : red;
            const action = ais[i].update(p, ball, field, teammates, opponents, TICK_MS, rng);
            if (action.kick) p.kick(ball, action.chargeRatio || 0.3);
        }

        for (const p of players) {
            p.update(TICK_MS);
            Physics.constrainToField(p, field, true);
        }
        ball.update(TICK_MS, true);
        Physics.constrainToField(ball, field, false);

        for (let i = 0; i < players.length; i++) {
            for (let j = i + 1; j < players.length; j++) {
                Physics.resolveCircleCollision(players[i], players[j]);
            }
            Physics.resolveCircleCollision(players[i], ball);
        }

        mgr.update(TICK_MS, players, false, rng);
        hashes[t] = hashState(players, ball, mgr, rng);
    }

    return { hashes, powerUps: mgr.powerUps.map(pu => ({ x: pu.x, y: pu.y, id: pu.type.id })) };
}

test('same seed + same inputs replays to an identical state hash on every tick', () => {
    const ticks = 1200; // ~20s of sim, crosses at least one power-up spawn
    const a = runMatch(42, ticks);
    const b = runMatch(42, ticks);

    for (let t = 0; t < ticks; t++) {
        assert.equal(a.hashes[t], b.hashes[t], `state hash diverged at tick ${t}`);
    }
    assert.deepEqual(a.powerUps, b.powerUps, 'power-up spawns must be identical');
    assert.ok(a.powerUps.length >= 1, 'at least one power-up spawned during the replay');
});

test('a different seed produces a different simulation (rng actually flows through)', () => {
    const ticks = 1200;
    const a = runMatch(42, ticks);
    const b = runMatch(43, ticks);
    assert.notEqual(a.hashes[ticks - 1], b.hashes[ticks - 1],
        'different seeds must diverge — is the seeded rng being ignored somewhere?');
});
