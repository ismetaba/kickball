// Regression tests for RoomManager lobby/routing behaviour.
//
// Dependency-free (RoomManager -> GameRoom -> GameSimulation + shared/*), so
// they run under `node --test` with no npm install. WebSocket peers are stubbed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const RoomManager = require('../server/room-manager');
const GameRoom = require('../server/game-room');
const { MSG } = require('../server/protocol');

// Minimal ws stub: readyState OPEN, captures decoded outbound messages.
function fakeWs() {
    return {
        readyState: 1,
        sent: [],
        send(raw) { this.sent.push(JSON.parse(raw)); },
    };
}

function createRoom(rm, id, ws, settings) {
    rm.handleMessage(id, ws, { t: MSG.CREATE_ROOM, d: { name: id, settings } });
    return rm.playerRooms.get(id);
}

test('_updateSettings rejects a teamSize that no longer fits current players', () => {
    const rm = new RoomManager();
    const hostWs = fakeWs();
    const code = createRoom(rm, 'host', hostWs, { teamSize: 4, duration: 180, goalLimit: 5 });
    const room = rm.rooms.get(code);

    // Stack the red team to 3 (host + two joiners).
    rm.handleMessage('p2', fakeWs(), { t: MSG.JOIN_ROOM, d: { roomCode: code, name: 'P2', team: 'red' } });
    rm.handleMessage('p3', fakeWs(), { t: MSG.JOIN_ROOM, d: { roomCode: code, name: 'P3', team: 'red' } });
    const redCount = [...room.players.values()].filter(p => p.team === 'red').length;
    assert.equal(redCount, 3, 'red team has 3 players');

    hostWs.sent.length = 0;
    rm.handleMessage('host', hostWs, { t: MSG.UPDATE_SETTINGS, d: { teamSize: 2 } });

    assert.equal(room.settings.teamSize, 4, 'teamSize unchanged when it would strand players');
    assert.ok(hostWs.sent.some(m => m.t === MSG.ERROR), 'host receives an error');
});

test('_updateSettings accepts a teamSize that still fits current players', () => {
    const rm = new RoomManager();
    const hostWs = fakeWs();
    const code = createRoom(rm, 'host', hostWs, { teamSize: 4 });
    const room = rm.rooms.get(code);
    rm.handleMessage('p2', fakeWs(), { t: MSG.JOIN_ROOM, d: { roomCode: code, name: 'P2', team: 'red' } });
    rm.handleMessage('p3', fakeWs(), { t: MSG.JOIN_ROOM, d: { roomCode: code, name: 'P3', team: 'red' } });

    rm.handleMessage('host', hostWs, { t: MSG.UPDATE_SETTINGS, d: { teamSize: 3 } });
    assert.equal(room.settings.teamSize, 3, 'valid teamSize change applied');
});

test('_updateSettings tolerates a missing payload', () => {
    const rm = new RoomManager();
    const hostWs = fakeWs();
    createRoom(rm, 'host', hostWs, { teamSize: 2 });
    assert.doesNotThrow(() => rm.handleMessage('host', hostWs, { t: MSG.UPDATE_SETTINGS }));
});

test('_quickMatch joins an existing open room before creating a new one', () => {
    const rm = new RoomManager();
    const code = createRoom(rm, 'a', fakeWs(), { teamSize: 2 });

    rm.handleMessage('b', fakeWs(), { t: MSG.QUICK_MATCH, d: { name: 'B' } });

    assert.equal(rm.playerRooms.get('b'), code, 'quick-match joined the open room');
    assert.equal(rm.rooms.size, 1, 'no extra room created');
});

test('_quickMatch creates a room when none are open', () => {
    const rm = new RoomManager();
    rm.handleMessage('b', fakeWs(), { t: MSG.QUICK_MATCH, d: { name: 'B' } });
    assert.equal(rm.rooms.size, 1, 'a room was created');
    assert.ok(rm.playerRooms.get('b'), 'player mapped to the new room');
});

test('a finished match releases its room and player mappings promptly', () => {
    const rm = new RoomManager();
    const hostWs = fakeWs();
    const code = createRoom(rm, 'host', hostWs, { teamSize: 1, goalLimit: 1 });
    const room = rm.rooms.get(code);

    rm.handleMessage('host', hostWs, { t: MSG.START_MATCH });
    assert.equal(typeof room.onFinished, 'function', 'onFinished wired up on start');

    // Simulate the simulation signalling a natural match end.
    room.onFinished();

    assert.equal(rm.rooms.has(code), false, 'room removed immediately on finish');
    assert.equal(rm.playerRooms.has('host'), false, 'player room mapping cleared');
});

test('startMatch never tells a slotless player the match started', () => {
    const hostWs = fakeWs();
    const room = new GameRoom('T', 'host', hostWs, 'Host', { teamSize: 1, duration: 180, goalLimit: 5 });

    // Force an extra red player beyond the team-size-1 cap (no slot will exist).
    const extraWs = fakeWs();
    room.players.set('extra', { ws: extraWs, name: 'Extra', team: 'red', slotIndex: null });

    room.startMatch();

    assert.ok(hostWs.sent.some(m => m.t === MSG.MATCH_STARTING), 'host told the match started');
    assert.ok(extraWs.sent.some(m => m.t === MSG.ERROR), 'slotless player gets an error');
    assert.ok(!extraWs.sent.some(m => m.t === MSG.MATCH_STARTING), 'slotless player NOT told it started');

    room.simulation.stop();
});
