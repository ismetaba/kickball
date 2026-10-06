// Online netcode regression tests. Peers run the real browser game in
// isolated VM contexts (test/helpers/peer-sim.js) over a simulated network,
// so these catch both desyncs (non-deterministic simulation) and stalls
// (netcode that waits on lost or late packets).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { World, compareHashes } = require('./helpers/peer-sim');

const SETTINGS = { teamSize: 1, duration: 120, goalLimit: 0, powerups: true, map: 'classic', difficulty: 'normal' };

function oneVsOne(link, opts = {}) {
    const w = new World(opts.netSeed || 11);
    const host = w.addPeer('host', { slot: 0, frameMs: opts.hostFrameMs });
    const guest = w.addPeer('guest', { slot: 1, startAt: link.latency, frameMs: opts.guestFrameMs, perturbPow: opts.guestPerturbPow });
    w.link('host', 'guest', link);
    w.setupMatch({
        settings: { ...SETTINGS, ...(opts.settings || {}) },
        inputDelay: opts.inputDelay || 3,
        sharePowTable: opts.sharePowTable !== false,
    });
    return { w, host, guest };
}

test('input encoding round-trips through the 4-byte wire format', () => {
    const w = new World();
    const { LockstepSession } = w.addPeer('p', { slot: 0 });
    const out = {};
    const samples = [
        { x: 0, y: 0, held: false, release: false, cr: 0, pull: false, sw: false },
        { x: -1, y: 1, held: true, release: true, cr: 1, pull: true, sw: true },
        { x: 0.3333, y: -0.7071, held: true, release: false, cr: 0.42, pull: false, sw: true },
    ];
    for (const s of samples) {
        LockstepSession.decodeInto(LockstepSession.encode(s), out);
        assert.ok(Math.abs(out.x - s.x) <= 1 / 127 && Math.abs(out.y - s.y) <= 1 / 127);
        assert.equal(out.held, s.held);
        assert.equal(out.release, s.release);
        assert.equal(out.pull, s.pull);
        assert.equal(out.sw, s.sw);
        assert.ok(Math.abs(out.cr - s.cr) <= 1 / 255);
        // Decoding is a fixed point: every peer simulates the same value
        const again = {};
        LockstepSession.decodeInto(LockstepSession.encode(out), again);
        assert.deepEqual(again, out);
    }
});

test('two peers on a lossy, jittery link stay in sync and run in real time', () => {
    const { w, host, guest } = oneVsOne({ latency: 15, jitter: 5, loss: 0.03 });
    w.run(20000);
    const { compared, mismatched } = compareHashes(host, guest);
    assert.ok(compared >= 30, `compared ${compared} checkpoints`);
    assert.equal(mismatched, 0, 'state hashes diverged');
    assert.equal(guest.session.resyncCount, 0, 'no resync should be needed');
    const expected = (w.now - guest.startedAt) / (1000 / 60);
    assert.ok(guest.game.tickCount >= expected * 0.97, `guest ran ${guest.game.tickCount}/${Math.round(expected)} ticks`);
    assert.ok(host.stalledFrames + guest.stalledFrames < 60, `too many stalled frames (${host.stalledFrames}/${guest.stalledFrames})`);
    assert.ok(w.lost > 0, 'the link actually dropped packets');
});

test('different display rates (120 Hz vs 30 fps) do not change game speed or sync', () => {
    const { w, host, guest } = oneVsOne({ latency: 12, jitter: 3, loss: 0.01 },
        { hostFrameMs: 1000 / 120, guestFrameMs: 1000 / 30 });
    w.run(15000);
    assert.equal(compareHashes(host, guest).mismatched, 0);
    assert.ok(Math.abs(host.game.tickCount - guest.game.tickCount) <= 6);
    assert.ok(host.game.tickCount >= 0.97 * (w.now / (1000 / 60)));
});

test('a desynced guest is repaired from the host snapshot', () => {
    const { w, host, guest } = oneVsOne({ latency: 15, jitter: 3, loss: 0.01 });
    w.run(15000, [{ at: 4000, fn: () => { guest.game.ball.x += 5; guest.game.players[0].vx += 2; } }]);
    assert.ok(guest.session.resyncCount >= 1, 'guest requested a resync');
    // Every checkpoint after the repair matches again
    const late = [...guest.session.hashes].filter(([t]) => t > host.game.tickCount - 300);
    assert.ok(late.length > 0);
    for (const [t, h] of late) {
        if (host.session.hashes.has(t)) assert.equal(h, host.session.hashes.get(t), `tick ${t}`);
    }
});

test('when a guest leaves, the AI takes over its slot and the match continues', () => {
    const w = new World(5);
    const host = w.addPeer('host', { slot: 0 });
    const g1 = w.addPeer('g1', { slot: 2 });
    const g2 = w.addPeer('g2', { slot: 3 });
    w.link('host', 'g1', { latency: 15, jitter: 3, loss: 0.02 });
    w.link('host', 'g2', { latency: 25, jitter: 5, loss: 0.02 });
    w.setupMatch({ settings: { ...SETTINGS, teamSize: 2 }, inputDelay: 4 });
    w.run(16000, [{ at: 6000, fn: () => {
        g2.gone = true;
        w.links.get('host>g2').down = true;
        host.session.peerGone('g2');
    } }]);
    assert.equal(compareHashes(host, g1).mismatched, 0, 'remaining peers stay in sync');
    assert.ok(host.game.tickCount > 900, 'host kept playing');
    assert.deepEqual([...host.game._controlled.keys()].sort(), [0, 2]);
    assert.deepEqual([...g1.game._controlled.keys()].sort(), [0, 2]);
    // Every player is driven by exactly one of: a remaining human or the AI
    // (the remaining guest may have SWAPped onto the freed player since).
    for (const g of [host.game, g1.game]) {
        const humans = new Set(g._controlled.values());
        for (const p of g.players) {
            const ai = g.aiControllers.filter(c => c.player === p).length;
            assert.equal(ai, humans.has(p) ? 0 : 1);
        }
    }
});

test('a full match ends on the same tick with the same score for both players', () => {
    const { w, host, guest } = oneVsOne({ latency: 18, jitter: 4, loss: 0.02 }, { settings: { duration: 20 } });
    w.run(100000);
    assert.ok(host.game.matchOver && guest.game.matchOver, 'both matches finished');
    assert.equal(host.game.tickCount, guest.game.tickCount);
    assert.deepEqual([host.game.redScore, host.game.blueScore], [guest.game.redScore, guest.game.blueScore]);
    const hostTitle = host.els.get('result-title').textContent;
    const guestTitle = guest.els.get('result-title').textContent;
    if (host.game.redScore !== host.game.blueScore) {
        assert.notEqual(hostTitle, guestTitle, 'each side sees the result from its own team');
    }
});

test('different Math.pow rounding (iOS vs Android engines) cannot desync a match', () => {
    // Without the host's pow table the 1-ulp difference grows into a desync…
    const bad = oneVsOne({ latency: 12, jitter: 3, loss: 0 }, { guestPerturbPow: true, sharePowTable: false });
    bad.w.run(8000);
    const without = compareHashes(bad.host, bad.guest).mismatched + bad.guest.session.resyncCount;
    assert.ok(without > 0, 'the perturbation must matter, or this test proves nothing');

    // …with it, every peer multiplies by the host's exact values.
    const good = oneVsOne({ latency: 12, jitter: 3, loss: 0 }, { guestPerturbPow: true });
    good.w.run(8000);
    assert.equal(compareHashes(good.host, good.guest).mismatched, 0);
    assert.equal(good.guest.session.resyncCount, 0);
});

test('packets left over from a previous match are ignored', () => {
    const { w, host, guest } = oneVsOne({ latency: 15, jitter: 3, loss: 0 });
    w.run(2000);
    // A lingering session from the last match (different match id) whose
    // acks are far ahead of this match
    const stale = new host.LockstepSession({
        game: host.game, net: host.net, isHost: true, mySlot: 0,
        humanSlots: [0, 1], peerSlots: new Map([['guest', 1]]), inputDelay: 3, matchId: 99,
    });
    host.game.tickCount += 5000;
    stale.buf.get(1).contig = host.game.tickCount;
    const bytes = stale._pktBytes.slice(0, stale._buildPacket(stale.links.get('guest')));
    host.game.tickCount -= 5000;
    const ackBefore = guest.session.links.get('host').ack.get(0);
    guest.session.handleFast('host', new DataView(bytes.buffer), 0);
    assert.equal(guest.session.links.get('host').ack.get(0), ackBefore, 'stale acks must not apply');

    const t0 = guest.game.tickCount;
    w.run(5000);
    assert.ok(guest.game.tickCount - t0 > 170, 'match keeps running');
    assert.equal(compareHashes(host, guest).mismatched, 0);
});

test("the host's final score wins if a guest finished differently", () => {
    const { w, host, guest } = oneVsOne({ latency: 15, jitter: 3, loss: 0 }, { settings: { duration: 10 } });
    w.run(80000);
    assert.ok(host.game.matchOver && guest.game.matchOver);
    // Pretend the guest's last seconds diverged and it shows another score
    guest.game.blueScore += 3;
    guest.game.showResult();
    guest.session._finalTimer = null;
    guest.session.handleReliable('host', { k: 'end', m: guest.session.matchId, s: host.game.serializeSim() });
    w.run(w.now + 1500);
    assert.deepEqual([guest.game.redScore, guest.game.blueScore], [host.game.redScore, host.game.blueScore]);
});

test('a guest the host gives up on is told so and leaves', () => {
    const { w, host, guest } = oneVsOne({ latency: 15, jitter: 3, loss: 0 });
    let lost = false;
    guest.session.onConnectionLost = () => { lost = true; };
    w.run(2000, [{ at: 1000, fn: () => host.session.peerGone('guest') }]);
    assert.equal(lost, true);
    assert.ok(host.session.dropAt.has(1), 'host hands the slot to the AI');
});
