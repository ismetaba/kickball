// Contract tests for the P2P signaling/relay protocol between the client
// (js/p2p.js message shapes) and the server (RoomManager routing). These pin
// the exact wire behaviour the lockstep netcode depends on — message-name
// drift between the two sides has shipped before (p2p_relay_state was
// rewritten to 'state' and confirmed inputs never reached guests).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const RoomManager = require('../server/room-manager');
const { MSG } = require('../server/protocol');

function fakeWs() {
    return {
        readyState: 1,
        sent: [],
        send(raw) { this.sent.push(JSON.parse(raw)); },
        last(type) {
            for (let i = this.sent.length - 1; i >= 0; i--) {
                if (this.sent[i].t === type) return this.sent[i];
            }
            return null;
        },
    };
}

function setupP2PRoom() {
    const rm = new RoomManager();
    const hostWs = fakeWs();
    const guestWs = fakeWs();
    rm.handleMessage('host', hostWs, { t: MSG.CREATE_P2P_ROOM, d: { name: 'Host' } });
    const code = hostWs.last(MSG.ROOM_CREATED).d.roomCode;
    rm.handleMessage('guest', guestWs, { t: MSG.JOIN_P2P_ROOM, d: { roomCode: code, name: 'Guest' } });
    return { rm, hostWs, guestWs, code };
}

test('match_starting carries the same matchSeed and inputDelay to host and every guest', () => {
    const { rm, hostWs, guestWs } = setupP2PRoom();

    rm.handleMessage('host', hostWs, { t: MSG.START_P2P_MATCH, d: { isP2P: true, inputDelay: 4 } });

    const hostMsg = hostWs.last(MSG.MATCH_STARTING);
    const guestMsg = guestWs.last(MSG.MATCH_STARTING);
    assert.ok(hostMsg, 'host received match_starting');
    assert.ok(guestMsg, 'guest received match_starting');
    assert.ok(Number.isInteger(hostMsg.d.matchSeed) && hostMsg.d.matchSeed > 0, 'server minted a match seed');
    assert.equal(hostMsg.d.matchSeed, guestMsg.d.matchSeed, 'identical seed on every peer');
    assert.equal(hostMsg.d.inputDelay, 4, 'host input delay echoed');
    assert.equal(guestMsg.d.inputDelay, 4, 'guest gets the same input delay');
});

test('match_starting sanitizes an out-of-range inputDelay to the default', () => {
    const { rm, hostWs } = setupP2PRoom();
    rm.handleMessage('host', hostWs, { t: MSG.START_P2P_MATCH, d: { inputDelay: 9999 } });
    assert.equal(hostWs.last(MSG.MATCH_STARTING).d.inputDelay, 3);
});

test('p2p_relay_ci from the host reaches guests as ci with the payload intact', () => {
    const { rm, hostWs, guestWs } = setupP2PRoom();
    const inputs = [{ pi: 0, x: 100, y: 0, k: 1, cr: 50, pl: 0, sw: 0 }];

    rm.handleMessage('host', hostWs, { t: MSG.P2P_RELAY_CI, d: { tk: 120, inputs } });

    const relayed = guestWs.last('ci');
    assert.ok(relayed, 'guest received a ci frame');
    assert.equal(relayed.d.tk, 120);
    assert.deepEqual(relayed.d.inputs, inputs);
});

test('p2p_relay_cs from the host reaches guests as cs with checksum and full state', () => {
    const { rm, hostWs, guestWs } = setupP2PRoom();

    rm.handleMessage('host', hostWs, { t: MSG.P2P_RELAY_CS, d: { tk: 60, h: -123456, fs: { rs: 1 } } });

    const relayed = guestWs.last('cs');
    assert.ok(relayed, 'guest received a cs frame');
    assert.equal(relayed.d.tk, 60);
    assert.equal(relayed.d.h, -123456);
    assert.deepEqual(relayed.d.fs, { rs: 1 });
});

test('guests cannot send host-only relay frames', () => {
    const { rm, hostWs, guestWs } = setupP2PRoom();
    hostWs.sent.length = 0;

    rm.handleMessage('guest', guestWs, { t: MSG.P2P_RELAY_CI, d: { tk: 1, inputs: [] } });

    assert.equal(hostWs.sent.length, 0, 'nothing relayed from a non-host');
});

test('leave_room actually removes a P2P member and notifies the host', () => {
    const { rm, hostWs, guestWs, code } = setupP2PRoom();

    rm.handleMessage('guest', guestWs, { t: MSG.LEAVE_ROOM, d: {} });

    const room = rm.p2pRooms.get(code);
    assert.ok(room, 'room survives a guest leaving');
    assert.equal(room.peers.size, 0, 'guest removed from the room');
    assert.equal(rm.playerRooms.has('guest'), false, 'guest mapping cleared');
    assert.ok(hostWs.last(MSG.P2P_PEER_LEFT), 'host notified');
});

test('leave_room by the host destroys the room and tells guests hostLeft', () => {
    const { rm, hostWs, guestWs, code } = setupP2PRoom();

    rm.handleMessage('host', hostWs, { t: MSG.LEAVE_ROOM, d: {} });

    assert.equal(rm.p2pRooms.has(code), false, 'room destroyed');
    const left = guestWs.last(MSG.P2P_PEER_LEFT);
    assert.ok(left && left.d.hostLeft, 'guests told the host left');
    assert.equal(rm.playerRooms.has('guest'), false, 'guest mapping cleared');
});

test('joining a full or started P2P room is rejected', () => {
    const rm = new RoomManager();
    const hostWs = fakeWs();
    rm.handleMessage('host', hostWs, {
        t: MSG.CREATE_P2P_ROOM,
        d: { name: 'Host', settings: { teamSize: 1, map: 'classic', duration: 180, goalLimit: 0 } },
    });
    const code = hostWs.last(MSG.ROOM_CREATED).d.roomCode;

    const g1 = fakeWs();
    rm.handleMessage('g1', g1, { t: MSG.JOIN_P2P_ROOM, d: { roomCode: code, name: 'G1' } });
    assert.ok(g1.last(MSG.ROOM_JOINED), 'first guest fits (1v1 = 2 players)');

    const g2 = fakeWs();
    rm.handleMessage('g2', g2, { t: MSG.JOIN_P2P_ROOM, d: { roomCode: code, name: 'G2' } });
    assert.ok(g2.last(MSG.ERROR), 'second guest rejected — room is full');
    assert.equal(g2.last(MSG.ROOM_JOINED), null);

    rm.handleMessage('host', hostWs, { t: MSG.START_P2P_MATCH, d: {} });
    const g3 = fakeWs();
    rm.handleMessage('g3', g3, { t: MSG.JOIN_P2P_ROOM, d: { roomCode: code, name: 'G3' } });
    assert.ok(g3.last(MSG.ERROR), 'joining after match start rejected');
});

test('stale-room sweep reaps a P2P room whose host socket is dead', () => {
    const { rm, guestWs, code } = setupP2PRoom();

    rm.p2pRooms.get(code).hostWs.readyState = 3; // CLOSED, no close event fired
    rm.cleanupStaleRooms();

    assert.equal(rm.p2pRooms.has(code), false, 'zombie-hosted room removed');
    const left = guestWs.last(MSG.P2P_PEER_LEFT);
    assert.ok(left && left.d.hostLeft, 'surviving guest notified');
    assert.equal(rm.playerRooms.has('guest'), false);
});
