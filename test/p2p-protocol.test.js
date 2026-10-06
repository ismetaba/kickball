// Contract tests for the P2P signaling/relay protocol between the client
// (js/p2p.js message shapes) and the server (RoomManager routing). The online
// netcode relies on two relay envelopes when no direct WebRTC link exists:
//   host  -> p2p_relay_state {k, to, ...} -> guests receive 'state'
//   guest -> p2p_relay_input {k, ...}     -> host receives 'p2p_peer_input'
// Message-name drift between the two sides has shipped before, so pin it.

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

test('duplicate start_p2p_match is ignored until the host reports the match ended', () => {
    const { rm, hostWs, guestWs } = setupP2PRoom();
    const starts = () => guestWs.sent.filter(m => m.t === MSG.MATCH_STARTING).length;

    rm.handleMessage('host', hostWs, { t: MSG.START_P2P_MATCH, d: {} });
    assert.equal(starts(), 1);

    rm.handleMessage('host', hostWs, { t: MSG.START_P2P_MATCH, d: {} });
    assert.equal(starts(), 1, 'no second match_starting mid-match');

    rm.handleMessage('host', hostWs, { t: MSG.P2P_MATCH_ENDED, d: {} });
    rm.handleMessage('host', hostWs, { t: MSG.START_P2P_MATCH, d: {} });
    assert.equal(starts(), 2, 'rematch from the room starts again');
});

test('p2p_match_ended reopens the room for joins', () => {
    const { rm, hostWs, code } = setupP2PRoom();
    rm.handleMessage('host', hostWs, { t: MSG.START_P2P_MATCH, d: {} });
    assert.equal(rm.p2pRooms.get(code).started, true);

    rm.handleMessage('host', hostWs, { t: MSG.P2P_MATCH_ENDED, d: {} });
    assert.equal(rm.p2pRooms.get(code).started, false);

    const g2 = fakeWs();
    rm.handleMessage('g2', g2, { t: MSG.JOIN_P2P_ROOM, d: { roomCode: code, name: 'G2' } });
    assert.ok(g2.last(MSG.ROOM_JOINED), 'new guest can join after the match ended');
});

test('P2P teamSize shrink below occupancy and invalid team switches are rejected', () => {
    const { rm, hostWs, guestWs, code } = setupP2PRoom();
    const room = rm.p2pRooms.get(code);

    // Guest was auto-balanced to blue; move them to red — now red has 2.
    rm.handleMessage('guest', guestWs, { t: MSG.SWITCH_TEAM, d: { team: 'red' } });
    assert.equal(room.peers.get('guest').team, 'red');

    // Arbitrary team strings are ignored.
    rm.handleMessage('guest', guestWs, { t: MSG.SWITCH_TEAM, d: { team: 'purple' } });
    assert.equal(room.peers.get('guest').team, 'red');

    // teamSize 1 would strand one of the two red players.
    hostWs.sent.length = 0;
    rm.handleMessage('host', hostWs, { t: MSG.UPDATE_SETTINGS, d: { teamSize: 1 } });
    assert.equal(room.settings.teamSize, 2, 'shrink rejected');
    assert.ok(hostWs.last(MSG.ERROR), 'host told why');
});

test('duplicate join_p2p_room from the host answers idempotently without corrupting peers', () => {
    const { rm, hostWs, code } = setupP2PRoom();
    const room = rm.p2pRooms.get(code);

    rm.handleMessage('host', hostWs, { t: MSG.JOIN_P2P_ROOM, d: { roomCode: code, name: 'Host' } });

    assert.equal(room.peers.has('host'), false, 'host never inserted into peers');
    assert.ok(rm.p2pRooms.has(code), 'room still alive');
    assert.ok(hostWs.last(MSG.ROOM_JOINED), 'idempotent room_joined reply');
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

test('host relay frames reach guests as state with the payload intact', () => {
    const { rm, hostWs, guestWs } = setupP2PRoom();
    const payload = { k: 'f', to: 'guest', b: 'pwECAwQ=' };

    rm.handleMessage('host', hostWs, { t: MSG.P2P_RELAY_STATE, d: payload });

    const relayed = guestWs.last('state');
    assert.ok(relayed, 'guest received a state frame');
    assert.deepEqual(relayed.d, payload);
});

test('guest relay frames reach the host as p2p_peer_input tagged with the sender', () => {
    const { rm, hostWs, guestWs } = setupP2PRoom();
    const payload = { k: 'r', m: { k: 'rsq', t: 90 } };

    rm.handleMessage('guest', guestWs, { t: MSG.P2P_RELAY_INPUT, d: payload });

    const relayed = hostWs.last('p2p_peer_input');
    assert.ok(relayed, 'host received the relayed frame');
    assert.equal(relayed.d.peerId, 'guest');
    assert.deepEqual(relayed.d.input, payload);
});

test('guests cannot send host-only relay frames', () => {
    const { rm, hostWs, guestWs } = setupP2PRoom();
    guestWs.sent.length = 0;
    hostWs.sent.length = 0;

    rm.handleMessage('guest', guestWs, { t: MSG.P2P_RELAY_STATE, d: { k: 'f', b: 'AA==' } });

    assert.equal(guestWs.sent.length + hostWs.sent.length, 0, 'nothing relayed from a non-host');
});

test('match_starting gives every member the same slot list', () => {
    const { rm, hostWs, guestWs } = setupP2PRoom();
    rm.handleMessage('host', hostWs, { t: MSG.START_P2P_MATCH, d: {} });
    const a = hostWs.last(MSG.MATCH_STARTING).d.slots.map(s => [s.playerId, s.team]);
    const b = guestWs.last(MSG.MATCH_STARTING).d.slots.map(s => [s.playerId, s.team]);
    assert.deepEqual(a, b);
    assert.deepEqual(a, [['host', 'red'], ['guest', 'blue']]);
});
