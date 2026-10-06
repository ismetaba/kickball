// Online lockstep netcode.
//
// Every peer runs the same deterministic 60 Hz simulation (Game.simTick) and
// only player inputs travel over the network. The pieces that keep it smooth:
//
//  * Input delay: input sampled at tick t is scheduled for tick t + delay, so
//    it normally reaches the other phones before they need it. Each peer picks
//    its own delay from the measured round-trip time and adjusts it live.
//  * Loss tolerance: inputs go over an unreliable data channel, but every
//    packet repeats all inputs the receiver hasn't acknowledged yet, so a lost
//    packet is repaired by the next one (~16 ms) instead of stalling.
//  * Direct exchange: peers don't wait for the host to "confirm" a tick; the
//    host just forwards guest inputs to the other guests.
//  * Time sync: peers compare tick clocks and the one that is ahead runs
//    slightly slower until they line up, so neither side sits at the edge of
//    stalling.
//  * Fixed-step clock + render interpolation (in Game) instead of one tick per
//    animation frame, so 30/60/120 Hz screens and dropped frames don't change
//    game speed or stall the other phone.
//  * Desync safety net: the host publishes a state hash every 30 ticks; a
//    guest that disagrees asks for the host's full state and re-simulates.

const NETPLAY_PROTOCOL = 2;

class LockstepSession {
    // opts:
    //   game        Game instance
    //   net         P2PNetwork (transport)
    //   isHost      boolean
    //   mySlot      player index controlled on this device
    //   humanSlots  player indices controlled by humans (incl. mine)
    //   peerSlots   host only: Map(peerId -> slot)
    //   inputDelay  initial delay in ticks (same on every peer)
    constructor(opts) {
        this.game = opts.game;
        this.net = opts.net;
        this.isHost = opts.isHost;
        this.mySlot = opts.mySlot;
        this.slots = [...opts.humanSlots].sort((a, b) => a - b);
        this.delay = opts.inputDelay;

        this.RING = 1024;          // input history per slot (~17 s)
        this.MAX_RUN = 64;         // max inputs per slot per packet
        this.CS_INTERVAL = 30;     // ticks between desync checks
        this.MAX_TICKS_PER_FRAME = 4;
        this.MAX_DEBT_MS = TICK_MS * 6;

        // Input history: slot -> { ticks, vals, contig }
        // contig = highest tick T such that every input up to T is known.
        this.buf = new Map();
        for (const s of this.slots) {
            const b = { ticks: new Int32Array(this.RING).fill(-1), vals: new Int32Array(this.RING), contig: -1 };
            for (let t = 0; t < this.delay; t++) this._store(b, t, 0);
            this.buf.set(s, b);
        }
        this.nextLocalTick = this.delay;

        // Slots whose human left: no input needed from `dropAt` on (AI plays them)
        this.dropAt = new Map();

        // Links: host has one per guest, a guest has one ('host')
        this.links = new Map();
        if (this.isHost) {
            for (const [peerId, slot] of opts.peerSlots) this._addLink(peerId, slot);
        } else {
            this._addLink('host', -1);
        }

        this.acc = 0;
        this.stallMs = 0;
        this._stalledShown = false;
        this._localDirty = false;

        // Desync detection
        this.hashes = new Map();       // tick -> local hash
        this.hostCs = null;            // host: latest { t, h } to publish
        this.pendingHostCs = new Map(); // guest: tick -> host hash
        this._lastCsSeen = -1;
        this._resyncAskedAt = -Infinity;
        this._lastResyncSent = new Map();
        this.resyncCount = 0;

        // Adaptive delay bookkeeping
        this._delayLowStreak = 0;
        this.relayMs = 0;              // guest: extra latency through the host

        this._pkt = new DataView(new ArrayBuffer(4096));
        this._pktBytes = new Uint8Array(this._pkt.buffer);
        this._inputs = [];
        this._decoded = new Map();
        for (const s of this.slots) this._decoded.set(s, { x: 0, y: 0, held: false, release: false, cr: 0, pull: false, sw: false });

        this._lingerTimer = null;
        this.started = false;
        this.destroyed = false;

        // Callbacks (set by UI)
        this.onStallChange = null;     // (isStalled) => void
        this.onConnectionLost = null;  // () => void
        this.onPeerSilent = null;      // host: (peerId) => void
    }

    _addLink(peerId, slot) {
        const ack = new Map();
        for (const s of this.slots) ack.set(s, this.delay - 1);
        this.links.set(peerId, {
            peerId, slot, ack,
            adv: 0, remoteAdv: 0, synced: false,
            lastRecv: performance.now(), lastSend: 0, dirty: true,
        });
    }

    // --- Input encoding (4 bytes; every peer uses the decoded values) -------

    static encode(inp) {
        const q = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));
        const flags = (inp.held ? 1 : 0) | (inp.release ? 2 : 0) | (inp.pull ? 4 : 0) | (inp.sw ? 8 : 0);
        const cr = Math.max(0, Math.min(255, Math.round((inp.cr || 0) * 255)));
        return (q(inp.x) & 255) | ((q(inp.y) & 255) << 8) | (flags << 16) | (cr << 24);
    }

    static decodeInto(v, out) {
        out.x = ((v << 24) >> 24) / 127;
        out.y = ((v << 16) >> 24) / 127;
        const flags = (v >>> 16) & 255;
        out.held = (flags & 1) !== 0;
        out.release = (flags & 2) !== 0;
        out.pull = (flags & 4) !== 0;
        out.sw = (flags & 8) !== 0;
        out.cr = ((v >>> 24) & 255) / 255;
        return out;
    }

    _store(b, tick, val) {
        if (tick <= b.contig) return false;
        const i = tick & (this.RING - 1);
        if (b.ticks[i] === tick) return false;
        b.ticks[i] = tick;
        b.vals[i] = val;
        while (b.ticks[(b.contig + 1) & (this.RING - 1)] === b.contig + 1) b.contig++;
        return true;
    }

    _has(slot, tick) {
        const b = this.buf.get(slot);
        return b.ticks[tick & (this.RING - 1)] === tick;
    }

    _needed(slot, tick) {
        const at = this.dropAt.get(slot);
        return at === undefined || tick < at;
    }

    // Called right after Game.startLockstepMatch — the clock starts now.
    start() {
        this.started = true;
        this.acc = 0;
        this.stallMs = 0;
        const now = performance.now();
        for (const link of this.links.values()) {
            link.lastRecv = now;
            link.synced = false;
        }
    }

    // --- Frame driver ---------------------------------------------------------

    // Called once per animation frame by Game.loop. Runs the ticks that are
    // due, sends packets, returns the render interpolation factor.
    advance(elapsed) {
        const g = this.game;

        // Time sync: if we're ahead of a peer, run the clock a bit slower.
        let ahead = 0;
        for (const link of this.links.values()) {
            if (!link.synced) continue;
            const a = (link.adv - link.remoteAdv) / 2;
            if (a > ahead) ahead = a;
        }
        const slow = ahead > 0.6 ? Math.min(0.12, (ahead - 0.3) * 0.04) : 0;
        this.acc += elapsed / (1 + slow);

        let ran = 0;
        let stalled = false;
        while (this.acc >= TICK_MS && ran < this.MAX_TICKS_PER_FRAME && g.isRunning) {
            this._generateLocal(g.tickCount);
            const inputs = this._collect(g.tickCount);
            if (!inputs) { stalled = true; break; }
            this._tick(inputs);
            this.acc -= TICK_MS;
            ran++;
        }
        if (this.acc > this.MAX_DEBT_MS) this.acc = this.MAX_DEBT_MS;

        if (stalled) this.stallMs += elapsed;
        else if (ran > 0) this.stallMs = 0;
        this._updateStall();

        this._pump(performance.now());
        return Math.min(this.acc / TICK_MS, 1);
    }

    _updateStall() {
        const show = this.stallMs > 500;
        if (show !== this._stalledShown) {
            this._stalledShown = show;
            if (this.onStallChange) this.onStallChange(show);
        }
        if (this.stallMs > 20000 && this.onConnectionLost) {
            const cb = this.onConnectionLost;
            this.onConnectionLost = null;
            cb();
        }
        // Host: a guest that has gone completely quiet is handed to the AI
        // so everyone else can keep playing.
        if (this.isHost && this.stallMs > 3000) {
            const now = performance.now();
            for (const link of [...this.links.values()]) {
                if (now - link.lastRecv > 10000) {
                    this.peerGone(link.peerId);
                    if (this.onPeerSilent) this.onPeerSilent(link.peerId);
                }
            }
        }
    }

    // Sample this device's controls for every tick up to tick + delay.
    // After a delay increase this fills the gap by repeating the input; after
    // a decrease it simply generates nothing until the clock catches up.
    _generateLocal(tick) {
        const target = tick + this.delay;
        const b = this.buf.get(this.mySlot);
        if (!b) return;
        while (this.nextLocalTick <= target) {
            const v = LockstepSession.encode(this.game.sampleLocalInput());
            this._store(b, this.nextLocalTick, v);
            this.nextLocalTick++;
            this._localDirty = true;
        }
    }

    // Inputs for `tick` as the flat [slot, input, ...] list Game.simTick
    // takes, or null if some human's input hasn't arrived yet.
    _collect(tick) {
        for (const s of this.slots) {
            if (this._needed(s, tick) && !this._has(s, tick)) return null;
        }
        for (const [s, at] of this.dropAt) {
            if (at === tick) this.game.dropSlot(s);
        }
        const out = this._inputs;
        out.length = 0;
        for (const s of this.slots) {
            if (!this._needed(s, tick)) continue;
            const b = this.buf.get(s);
            out.push(s, LockstepSession.decodeInto(b.vals[tick & (this.RING - 1)], this._decoded.get(s)));
        }
        return out;
    }

    _tick(inputs) {
        const g = this.game;
        g.simTick(inputs);
        const t = g.tickCount;
        if (t % this.CS_INTERVAL === 0) {
            const h = g.stateHash();
            this.hashes.set(t, h);
            this.hashes.delete(t - this.CS_INTERVAL * 40);
            if (this.isHost) this.hostCs = { t, h };
            else this._compareHostCs(t);
            this._adaptDelay();
        }
    }

    // --- Adaptive input delay -------------------------------------------------

    _adaptDelay() {
        let oneWay = -1, dev = 0;
        for (const link of this.links.values()) {
            const r = this.net.getRtt(link.peerId);
            if (!r || r.samples < 3) continue;
            const ow = r.rtt / 2 + (this.isHost ? 0 : this.relayMs);
            if (ow > oneWay) { oneWay = ow; dev = r.dev; }
        }
        if (oneWay < 0) return;
        const want = LockstepSession.delayFor(oneWay, dev);
        if (want > this.delay) {
            // Grow right away (late inputs stall the other side); the gap
            // ticks are filled with the current input.
            this.delay = want;
            this._delayLowStreak = 0;
        } else if (want < this.delay) {
            // Only shrink after a sustained calm period (avoids flapping)
            if (++this._delayLowStreak >= 4) {
                this.delay--;
                this._delayLowStreak = 0;
            }
        } else {
            this._delayLowStreak = 0;
        }
    }

    // Ticks of delay needed to cover the one-way latency plus jitter, with
    // one tick of slack for frame scheduling.
    static delayFor(oneWayMs, devMs) {
        const d = Math.ceil((oneWayMs + 2 * devMs + 6) / TICK_MS) + 1;
        return Math.max(2, Math.min(12, d));
    }

    // --- Desync detection / resync -------------------------------------------

    _compareHostCs(t) {
        const hostHash = this.pendingHostCs.get(t);
        const mine = this.hashes.get(t);
        if (hostHash === undefined || mine === undefined) return;
        this.pendingHostCs.delete(t);
        if (hostHash !== mine) this._requestResync(t);
    }

    _requestResync(t) {
        const now = performance.now();
        if (now - this._resyncAskedAt < 2000) return;
        this._resyncAskedAt = now;
        console.warn(`[netplay] desync at tick ${t} — requesting host state`);
        this.net.sendReliable('host', { k: 'rsq', t });
    }

    _applyResync(s) {
        const g = this.game;
        if (!g.isRunning || !s || typeof s.t !== 'number') return;
        const cur = g.tickCount;
        const target = s.t;
        // We must hold every input from the snapshot tick up to now to replay
        for (let t = target; t < cur; t++) {
            for (const slot of this.slots) {
                if (this._needed(slot, t) && !this._has(slot, t)) {
                    console.warn('[netplay] resync skipped: input history missing');
                    return;
                }
            }
        }
        Sound.suppressed = true;
        g.renderer.suppressFx = true;
        try {
            g.restoreSim(s);
            for (const k of this.hashes.keys()) if (k > target) this.hashes.delete(k);
            for (let t = target; t < cur && g.isRunning; t++) {
                const inputs = this._collect(t);
                if (!inputs) break;
                this._tick(inputs);
            }
        } finally {
            Sound.suppressed = false;
            g.renderer.suppressFx = false;
        }
        this.resyncCount++;
        this._resyncAskedAt = -Infinity;
    }

    // --- Messages -------------------------------------------------------------

    handleReliable(peerId, msg) {
        if (this.destroyed || !msg) return;
        if (msg.k === 'rsq' && this.isHost) {
            const now = performance.now();
            if (now - (this._lastResyncSent.get(peerId) || -Infinity) < 500) return;
            this._lastResyncSent.set(peerId, now);
            if (this.game.isRunning) this.net.sendReliable(peerId, { k: 'rss', s: this.game.serializeSim() });
        } else if (msg.k === 'rss' && !this.isHost) {
            this._applyResync(msg.s);
        } else if (msg.k === 'drop' && !this.isHost) {
            if (msg.slot === this.mySlot) {
                // The host gave up on us (we were unreachable too long)
                if (this.onConnectionLost) {
                    const cb = this.onConnectionLost;
                    this.onConnectionLost = null;
                    cb();
                }
                return;
            }
            if (this.buf.has(msg.slot) && !this.dropAt.has(msg.slot)) this.dropAt.set(msg.slot, msg.at);
        }
    }

    handleFast(peerId, view, o) {
        if (this.destroyed) return;
        const link = this.links.get(peerId);
        if (!link || view.byteLength - o < 21) return;
        if (view.getUint8(o) !== 1) return;
        o += 1;
        const now = performance.now();
        const remoteTick = view.getInt32(o, true); o += 4;
        const remoteFrac = view.getUint8(o) / 32; o += 1;
        link.remoteAdv = view.getInt16(o, true) / 64; o += 2;
        o += 1; // sender's delay (informational)
        const relayMs = view.getUint16(o, true); o += 2;
        const csTick = view.getInt32(o, true); o += 4;
        const csHash = view.getInt32(o, true); o += 4;
        link.lastRecv = now;
        if (!this.isHost) this.relayMs = relayMs;

        // Clock advantage sample: where we are vs where the remote is now
        const r = this.net.getRtt(peerId);
        if (this.started && r && r.samples > 0) {
            const mine = this.game.tickCount + this.acc / TICK_MS;
            const theirs = remoteTick + remoteFrac + (r.rtt / 2) / TICK_MS;
            const sample = mine - theirs;
            link.adv = link.synced ? link.adv * 0.9 + sample * 0.1 : sample;
            link.synced = true;
        }

        if (!this.isHost && csTick > this._lastCsSeen) {
            this._lastCsSeen = csTick;
            this.pendingHostCs.set(csTick, csHash);
            if (this.pendingHostCs.size > 64) {
                for (const k of this.pendingHostCs.keys()) {
                    if (k < this.game.tickCount - 600) this.pendingHostCs.delete(k);
                }
            }
            this._compareHostCs(csTick);
        }

        // Acks: what the remote already has from us
        const nAcks = view.getUint8(o); o += 1;
        for (let i = 0; i < nAcks; i++) {
            if (o + 5 > view.byteLength) return;
            const slot = view.getUint8(o);
            const t = view.getInt32(o + 1, true);
            o += 5;
            if (t > (link.ack.get(slot) ?? -1)) link.ack.set(slot, t);
        }

        // Input runs
        let gotNew = false;
        const nRuns = view.getUint8(o); o += 1;
        for (let i = 0; i < nRuns; i++) {
            if (o + 6 > view.byteLength) return;
            const slot = view.getUint8(o);
            const start = view.getInt32(o + 1, true);
            const count = view.getUint8(o + 5);
            o += 6;
            if (o + count * 4 > view.byteLength) return;
            const b = this.buf.get(slot);
            const accept = b && slot !== this.mySlot && (!this.isHost || slot === link.slot);
            if (accept) {
                const dropTick = this.dropAt.get(slot);
                const horizon = this.game.tickCount + this.RING / 2;
                for (let k = 0; k < count; k++) {
                    const t = start + k;
                    if (dropTick !== undefined && t >= dropTick) break;
                    if (t > horizon) break;
                    if (this._store(b, t, view.getInt32(o + k * 4, true))) gotNew = true;
                }
            }
            o += count * 4;
        }

        // Host: forward fresh guest input to the other guests right away
        if (gotNew && this.isHost && this.links.size > 1) {
            for (const other of this.links.values()) {
                if (other !== link) other.dirty = true;
            }
            this._pump(now);
        }
    }

    // --- Sending ----------------------------------------------------------------

    _pump(now) {
        if (this.destroyed) return;
        const local = this._localDirty;
        this._localDirty = false;
        for (const link of this.links.values()) {
            if (local || link.dirty || now - link.lastSend >= 33) {
                link.dirty = false;
                link.lastSend = now;
                const len = this._buildPacket(link);
                this.net.sendFast(link.peerId, this._pktBytes.subarray(0, len));
            }
        }
    }

    _buildPacket(link) {
        const dv = this._pkt;
        const g = this.game;
        let o = 0;
        dv.setUint8(o, 1); o += 1;
        dv.setInt32(o, g.tickCount, true); o += 4;
        dv.setUint8(o, Math.max(0, Math.min(255, Math.round((this.acc / TICK_MS) * 32)))); o += 1;
        dv.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(link.adv * 64))), true); o += 2;
        dv.setUint8(o, this.delay); o += 1;
        dv.setUint16(o, this.isHost ? this._relayMsFor(link) : 0, true); o += 2;
        const cs = this.isHost ? this.hostCs : null;
        dv.setInt32(o, cs ? cs.t : -1, true); o += 4;
        dv.setInt32(o, cs ? cs.h : 0, true); o += 4;

        // Acks for the slots this link sends us
        const ackPos = o++;
        let nAcks = 0;
        for (const s of this.slots) {
            if (s === this.mySlot) continue;
            if (this.isHost && s !== link.slot) continue;
            dv.setUint8(o, s);
            dv.setInt32(o + 1, this.buf.get(s).contig, true);
            o += 5;
            nAcks++;
        }
        dv.setUint8(ackPos, nAcks);

        // Every input the remote hasn't acknowledged (oldest first)
        const runPos = o++;
        let nRuns = 0;
        for (const s of this.slots) {
            if (this.isHost ? s === link.slot : s !== this.mySlot) continue;
            const b = this.buf.get(s);
            let to = b.contig;
            const dropTick = this.dropAt.get(s);
            if (dropTick !== undefined && to > dropTick - 1) to = dropTick - 1;
            let from = (link.ack.get(s) ?? -1) + 1;
            if (from < to - this.RING + 2) from = to - this.RING + 2;
            if (from > to) continue;
            const count = Math.min(to - from + 1, this.MAX_RUN);
            dv.setUint8(o, s);
            dv.setInt32(o + 1, from, true);
            dv.setUint8(o + 5, count);
            o += 6;
            for (let k = 0; k < count; k++) {
                dv.setInt32(o, b.vals[(from + k) & (this.RING - 1)], true);
                o += 4;
            }
            nRuns++;
        }
        dv.setUint8(runPos, nRuns);
        return o;
    }

    // Host: extra one-way latency a guest's input takes to reach the
    // slowest *other* guest through us.
    _relayMsFor(link) {
        let worst = 0;
        for (const other of this.links.values()) {
            if (other === link) continue;
            const r = this.net.getRtt(other.peerId);
            if (r && r.samples > 0 && r.rtt / 2 > worst) worst = r.rtt / 2;
        }
        return Math.min(65535, Math.round(worst));
    }

    // --- Membership -------------------------------------------------------------

    // Host: a guest left for good. Its input stream ends after the last tick
    // we hold; from then on the AI plays that slot on every peer.
    peerGone(peerId) {
        if (!this.isHost) return;
        const link = this.links.get(peerId);
        if (!link) return;
        this.links.delete(peerId);
        const slot = link.slot;
        if (!this.buf.has(slot) || this.dropAt.has(slot)) return;
        const at = this.buf.get(slot).contig + 1;
        this.dropAt.set(slot, at);
        for (const other of this.links.values()) {
            this.net.sendReliable(other.peerId, { k: 'drop', slot, at });
        }
    }

    // Keep repairing lost packets for a moment after the final whistle so
    // peers that are a few ticks behind can finish the match too.
    linger(ms = 4000) {
        if (this._lingerTimer || this.destroyed) return;
        const until = performance.now() + ms;
        this._lingerTimer = setInterval(() => {
            const now = performance.now();
            if (now > until || this.destroyed) {
                clearInterval(this._lingerTimer);
                this._lingerTimer = null;
                return;
            }
            this._pump(now);
        }, 50);
    }

    getStats() {
        let rtt = 0;
        let relay = false;
        for (const link of this.links.values()) {
            const r = this.net.getRtt(link.peerId);
            if (r && r.rtt > rtt) rtt = r.rtt;
            if (this.net.transportOf(link.peerId) !== 'p2p') relay = true;
        }
        return { rtt, delay: this.delay, relay, resyncs: this.resyncCount };
    }

    destroy() {
        this.destroyed = true;
        if (this._lingerTimer) { clearInterval(this._lingerTimer); this._lingerTimer = null; }
        this.onStallChange = null;
        this.onConnectionLost = null;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LockstepSession, NETPLAY_PROTOCOL };
}
