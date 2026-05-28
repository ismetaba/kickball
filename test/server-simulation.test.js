// Regression tests for the authoritative server simulation.
//
// These exercise the dependency-free core (shared/* + server/game-simulation),
// so they run under `node --test` with no npm install required.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Physics = require('../shared/physics');
const GameSimulation = require('../server/game-simulation');
const GameRoom = require('../server/game-room');

const PRISTINE = {
    KICK_FORCE: Physics.KICK_FORCE,
    POWER_KICK_FORCE: Physics.POWER_KICK_FORCE,
    MAX_BALL_SPEED: Physics.MAX_BALL_SPEED,
    MAX_PLAYER_SPEED: Physics.MAX_PLAYER_SPEED,
};

function makeSim(overrides = {}) {
    return new GameSimulation({
        teamSize: 1, duration: 180, goalLimit: 5, powerups: false, map: 'classic',
        ...overrides,
    });
}

test('physics constants are isolated per simulation (no cross-room corruption)', () => {
    const huge = makeSim({ map: 'huge' });
    const classic = makeSim({ map: 'classic' });

    // Each sim re-applies its own constants at the top of every tick. After a
    // huge-map sim applies its config, the global reflects huge values...
    huge._applyPhysicsConfig();
    assert.equal(Physics.KICK_FORCE, PRISTINE.KICK_FORCE * 1.4);
    assert.equal(Physics.MAX_BALL_SPEED, PRISTINE.MAX_BALL_SPEED * 1.5);

    // ...but a classic-map sim ticking next fully restores its own, rather
    // than inheriting the huge values. This is the bug the fix prevents.
    classic._applyPhysicsConfig();
    assert.equal(Physics.KICK_FORCE, PRISTINE.KICK_FORCE);
    assert.equal(Physics.MAX_BALL_SPEED, PRISTINE.MAX_BALL_SPEED);
    assert.equal(Physics.MAX_PLAYER_SPEED, PRISTINE.MAX_PLAYER_SPEED);
});

test('a huge-map sim never permanently pollutes the global Physics object', () => {
    const huge = makeSim({ map: 'huge' });
    huge.start();
    huge.stop();
    // After a huge match runs and stops, a fresh classic sim must still see
    // pristine defaults once it applies its own config.
    const classic = makeSim({ map: 'classic' });
    classic._applyPhysicsConfig();
    assert.equal(Physics.KICK_FORCE, PRISTINE.KICK_FORCE);
    assert.equal(Physics.MAX_BALL_SPEED, PRISTINE.MAX_BALL_SPEED);
});

test('applyInput clamps hostile / out-of-range values', () => {
    const sim = makeSim();
    const slot = sim.addSlot('red', 'player-1'); // human slot
    const q = sim._inputQueues[slot.index];

    sim.applyInput('player-1', { x: 999999, y: -999999, kt: 1e9, kc: 1 });
    assert.equal(q.x, 1, 'x clamped to 1');
    assert.equal(q.y, -1, 'y clamped to -1');
    assert.equal(q.kickChargeTime, 1500, 'charge time capped at MAX_KICK_CHARGE_MS');

    sim.applyInput('player-1', { x: 'not-a-number', y: NaN });
    assert.equal(q.x, 0, 'non-numeric x collapses to 0');
    assert.equal(q.y, 0, 'NaN y collapses to 0');

    // Garbage payloads must not throw.
    assert.doesNotThrow(() => sim.applyInput('player-1', null));
    assert.doesNotThrow(() => sim.applyInput('player-1', 42));
});

test('GameRoom sanitizes settings against whitelists', () => {
    const room = new GameRoom('TEST', 'host', null, 'Host', {
        teamSize: 999, duration: 99999, goalLimit: 7, map: 'evil', powerups: true,
    });
    assert.equal(room.settings.teamSize, 2, 'absurd teamSize falls back to default');
    assert.equal(room.settings.duration, 180, 'unknown duration falls back to default');
    assert.equal(room.settings.goalLimit, 5, 'unknown goalLimit falls back to default');
    assert.equal(room.settings.map, 'classic', 'unknown map falls back to classic');

    const ok = new GameRoom('TEST2', 'host', null, 'Host', {
        teamSize: 3, duration: 300, goalLimit: 0, map: 'huge', powerups: false,
    });
    assert.deepEqual(ok.settings, {
        teamSize: 3, duration: 300, goalLimit: 0, powerups: false, map: 'huge',
    });
});

test('stop() cancels pending match-end timers', () => {
    const sim = makeSim({ goalLimit: 1 });
    sim.addSlot('red', 'player-1');
    sim.fillWithAI();
    sim.start();
    sim._scheduleEndMatch();
    assert.equal(sim._pendingTimers.size, 1, 'a timer is pending');
    sim.stop();
    assert.equal(sim._pendingTimers.size, 0, 'stop() cleared pending timers');
});

test('a full match tick pipeline runs without throwing (1v1, all maps)', () => {
    for (const map of ['big', 'classic', 'huge']) {
        const sim = makeSim({ map, powerups: true });
        sim.addSlot('red', 'player-1');
        sim.fillWithAI();
        sim.isRunning = true;
        assert.doesNotThrow(() => {
            for (let i = 0; i < 120; i++) sim.tick(); // ~2s of simulation
        }, `map ${map} ticked cleanly`);
        sim.stop();
    }
});
