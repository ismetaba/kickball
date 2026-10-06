// Headless online-match harness for tests: each peer runs the real browser
// game (js/game.js + js/netplay.js + shared/*) in its own VM context with
// stubbed DOM/canvas, driven by a shared simulated clock and connected
// through a fake network with configurable latency, jitter and loss.

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPTS = [
    'shared/physics.js', 'js/audio.js', 'shared/entities.js', 'shared/ai.js',
    'shared/powerups.js', 'js/renderer.js', 'js/game.js', 'js/netplay.js',
];
const SOURCES = SCRIPTS.map(f => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]);

function mulberry(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function fakeCtx() {
    const noop = () => {};
    const grad = { addColorStop: noop };
    return new Proxy({}, {
        get(t, k) {
            if (k in t) return t[k];
            if (k === 'getTransform') return () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
            if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
            return noop;
        },
        set(t, k, v) { t[k] = v; return true; },
    });
}

function fakeEl() {
    const classes = new Set();
    return {
        classList: {
            add: (c) => classes.add(c), remove: (c) => classes.delete(c),
            toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : f; if (on) classes.add(c); else classes.delete(c); return on; },
            contains: (c) => classes.has(c),
        },
        style: { setProperty() {} },
        textContent: '',
        appendChild() {},
        getContext: () => fakeCtx(),
    };
}

class World {
    constructor(seed = 7) {
        this.now = 0;
        this.rand = mulberry(seed);
        this.timers = [];
        this.queue = [];
        this.links = new Map();
        this.peers = new Map();
        this.hostName = null;
        this.sent = 0;
        this.lost = 0;
    }

    link(a, b, cfg) {
        this.links.set(a + '>' + b, cfg);
        this.links.set(b + '>' + a, cfg);
    }

    _linkCfg(a, b) {
        return this.links.get(a + '>' + b) || { latency: 15, jitter: 3, loss: 0 };
    }

    addPeer(name, opts) {
        const world = this;
        const els = new Map();
        const raf = [];
        const ctx = {
            console, Math, JSON, Date, Map, Set, Array, Object, Number, String, Boolean, Error, Proxy,
            Float64Array, Float32Array, Uint32Array, Int32Array, Uint8Array, Int16Array, ArrayBuffer, DataView,
            setTimeout: (fn, ms) => { world.timers.push({ at: world.now + (ms || 0), fn }); return 0; },
            clearTimeout() {}, setInterval: () => 0, clearInterval() {},
            performance: { now: () => world.now },
            requestAnimationFrame: (fn) => { raf.push(fn); return raf.length; },
            cancelAnimationFrame() {},
            localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
            document: {
                getElementById: (id) => { if (!els.has(id)) els.set(id, fakeEl()); return els.get(id); },
                querySelector: (q) => { if (!els.has(q)) els.set(q, fakeEl()); return els.get(q); },
                createElement: () => fakeEl(),
                createTextNode: () => ({}),
                addEventListener() {},
                hidden: false,
            },
            window: { addEventListener() {}, innerWidth: 844, innerHeight: 390, devicePixelRatio: 3 },
            screen: { width: 844, height: 390 },
        };
        ctx.self = ctx;
        vm.createContext(ctx);
        for (const [file, src] of SOURCES) vm.runInContext(src, ctx, { filename: file });

        const Game = vm.runInContext('Game', ctx);
        const LockstepSession = vm.runInContext('LockstepSession', ctx);
        const peer = {
            name, opts, ctx, raf, els,
            game: new Game(),
            LockstepSession,
            isHost: this.peers.size === 0,
            nextFrame: opts.startAt || 0,
            started: false,
            gone: false,
            frames: 0,
            stalledFrames: 0,
        };
        if (peer.isHost) this.hostName = name;
        const net = {
            sendFast: (peerId, payload) => { this._deliver(name, peerId, 'fast', payload.slice()); return true; },
            sendReliable: (peerId, msg) => { this._deliver(name, peerId, 'rel', JSON.parse(JSON.stringify(msg))); return true; },
            getRtt: (peerId) => {
                const target = peerId === 'host' ? this.hostName : peerId;
                const c = this._linkCfg(name, target);
                return { rtt: (c.latency + c.jitter) * 2, dev: c.jitter, samples: 10 };
            },
            transportOf: () => 'p2p',
        };
        peer.net = net;
        this.peers.set(name, peer);
        return peer;
    }

    _deliver(from, to, kind, data) {
        const target = to === 'host' ? this.hostName : to;
        const c = this._linkCfg(from, target);
        if (c.down) return;
        this.sent++;
        if (kind === 'fast' && this.rand() < c.loss) { this.lost++; return; }
        let delay = c.latency + this.rand() * c.jitter * 2;
        if (kind === 'rel') {
            // reliable channels are ordered
            const key = from + '>' + target;
            this._lastRel = this._lastRel || {};
            delay = Math.max(delay, (this._lastRel[key] || 0) - this.now + 0.01);
            this._lastRel[key] = this.now + delay;
        }
        this.queue.push({ at: this.now + delay, from, to: target, kind, data });
    }

    _flush() {
        this.queue.sort((a, b) => a.at - b.at);
        while (this.queue.length && this.queue[0].at <= this.now) {
            const m = this.queue.shift();
            const peer = this.peers.get(m.to);
            if (!peer || !peer.session || peer.gone) continue;
            const fromId = peer.isHost ? m.from : 'host';
            if (m.kind === 'fast') {
                peer.session.handleFast(fromId, new DataView(m.data.buffer, m.data.byteOffset, m.data.byteLength), 0);
            } else {
                peer.session.handleReliable(fromId, m.data);
            }
        }
    }

    // Start every peer's session with identical match parameters
    setupMatch({ settings, seed = 4242, inputDelay = 3 }) {
        const peers = [...this.peers.values()];
        const humanSlots = peers.map(p => p.opts.slot);
        for (const p of peers) {
            const peerSlots = new Map();
            if (p.isHost) for (const q of peers) if (q !== p) peerSlots.set(q.name, q.opts.slot);
            p.session = new p.LockstepSession({
                game: p.game, net: p.net, isHost: p.isHost, mySlot: p.opts.slot,
                humanSlots, peerSlots, inputDelay,
            });
            p.matchCfg = { settings, seed, humanSlots, mySlot: p.opts.slot };
            p.bot = botInput(p, this, 1000 + p.opts.slot);
        }
    }

    run(untilMs, events = []) {
        while (this.now < untilMs) {
            let next = Infinity;
            for (const p of this.peers.values()) if (!p.gone && p.nextFrame < next) next = p.nextFrame;
            for (const m of this.queue) if (m.at < next) next = m.at;
            for (const t of this.timers) if (t.at < next) next = t.at;
            for (const e of events) if (!e.done && e.at < next) next = e.at;
            if (next === Infinity || next > untilMs) { this.now = untilMs; break; }
            this.now = next;
            this._flush();
            for (let i = this.timers.length - 1; i >= 0; i--) {
                if (this.timers[i].at <= this.now) this.timers.splice(i, 1)[0].fn();
            }
            for (const e of events) if (!e.done && this.now >= e.at) { e.done = true; e.fn(this); }
            for (const p of this.peers.values()) this._frame(p);
        }
    }

    _frame(p) {
        if (p.gone || this.now < p.nextFrame) return;
        if (!p.started) {
            p.game.netplay = p.session;
            p.game.startLockstepMatch(p.matchCfg);
            p.game.onMatchEnd = () => p.session.linger();
            p.session.start();
            p.started = true;
            p.startedAt = this.now;
        } else {
            p.bot();
            const before = p.game.tickCount;
            const fn = p.raf.shift();
            p.raf.length = 0;
            if (fn) fn();
            p.frames++;
            if (p.game.tickCount === before && p.session.stallMs > 0) p.stalledFrames++;
        }
        const ms = p.opts.frameMs || 1000 / 60;
        p.nextFrame = this.now + ms;
    }
}

// Random but ball-chasing input with taps, long charges, pulls and swaps
function botInput(peer, world, seed) {
    const r = mulberry(seed);
    let nextChange = 0, releaseAt = -1;
    return () => {
        const inp = peer.game.input;
        const now = world.now;
        if (now >= nextChange) {
            const hp = peer.game.humanPlayer, b = peer.game.ball;
            if (hp && b && r() < 0.7) {
                const dx = b.x - hp.x, dy = b.y - hp.y, d = Math.hypot(dx, dy) || 1;
                inp.x = dx / d; inp.y = dy / d;
            } else {
                const a = r() * Math.PI * 2;
                inp.x = Math.cos(a); inp.y = Math.sin(a);
            }
            if (!inp.kickCharging && r() < 0.3) {
                inp.kickCharging = true;
                inp.kickChargeStart = now;
                releaseAt = now + (r() < 0.5 ? r() * 80 : r() * 1600);
            }
            inp.pull = r() < 0.08;
            if (r() < 0.04) inp.switchPlayer = true;
            nextChange = now + 60 + r() * 300;
        }
        if (inp.kickCharging && now >= releaseAt) {
            inp.kickChargeTime = Math.min(now - inp.kickChargeStart, 1500);
            inp.kickCharging = false;
            inp.kickRelease = true;
        }
    };
}

// Compare the desync-check hashes two peers recorded for the same ticks
function compareHashes(a, b) {
    let compared = 0, mismatched = 0;
    for (const [t, h] of b.session.hashes) {
        if (!a.session.hashes.has(t)) continue;
        compared++;
        if (a.session.hashes.get(t) !== h) mismatched++;
    }
    return { compared, mismatched };
}

module.exports = { World, compareHashes };
