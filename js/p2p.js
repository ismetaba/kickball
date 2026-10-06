// P2P transport over WebRTC data channels.
// The Fly.io server is only used for signaling (room codes, SDP exchange, ICE
// candidates) and as a fallback relay when a direct connection can't be made.
//
// Each host<->guest link has two channels:
//   fast — unordered, no retransmits: game input packets (netplay.js repairs
//          loss itself, so a late packet never blocks newer ones)
//   ctrl — ordered + reliable: match start, resync snapshots, etc.
// Every fast packet carries timestamps so both sides keep a live RTT
// estimate without separate ping traffic.

const FAST_MAGIC = 0xA7;
const FAST_HEADER = 21; // magic(1) sendTime(8) echoTime(8) echoDelay(4)

class P2PNetwork {
    constructor(serverUrl) {
        // Use local server only when running in a real browser on localhost (not Capacitor)
        const isNativeApp = typeof window.Capacitor !== 'undefined';
        const isLocalDev = !isNativeApp && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
        this.serverUrl = serverUrl || (isLocalDev ? 'ws://localhost:8080' : 'wss://kickzone-server.fly.dev');
        this.ws = null;
        this.isOnline = false;
        this.isHost = false;
        this.playerId = null;
        this.roomCode = null;

        // peerId -> link state. Guests have a single link keyed 'host'.
        this.peers = new Map();
        this._knownPeers = new Set(); // host: guests currently in the room

        // Signaling / room callbacks
        this.onConnected = null;
        this.onDisconnected = null;
        this.onError = null;
        this.onRoomCreated = null;
        this.onRoomJoined = null;
        this.onRoomUpdate = null;
        this.onMatchStarting = null;
        this.onPeerConnected = null;
        this.onPeerDisconnected = null;

        // Data callbacks
        this.onFast = null;      // (peerId, DataView, payloadOffset)
        this.onReliable = null;  // (peerId, msg)
        this.onLinkChange = null; // (peerId, 'open' | 'closed')

        this._rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                // TURN fallback for peers behind strict/symmetric NATs (~10-15% of connections)
                {
                    urls: 'turn:a.relay.metered.ca:80',
                    username: 'e8dd65e92f3b4a27b7108142',
                    credential: 'kMpLJTKsS2+wrFux',
                },
                {
                    urls: 'turn:a.relay.metered.ca:443',
                    username: 'e8dd65e92f3b4a27b7108142',
                    credential: 'kMpLJTKsS2+wrFux',
                },
                {
                    urls: 'turn:a.relay.metered.ca:443?transport=tcp',
                    username: 'e8dd65e92f3b4a27b7108142',
                    credential: 'kMpLJTKsS2+wrFux',
                },
            ]
        };

        this._sendBuf = new Uint8Array(4096 + FAST_HEADER);
        this._sendView = new DataView(this._sendBuf.buffer);
        this._pingTimer = null;
    }

    // --- WebSocket to signaling server ---
    connect() {
        if (this.ws) return;
        try {
            this.ws = new WebSocket(this.serverUrl);
        } catch (err) {
            console.error('P2P WebSocket creation failed:', err);
            if (this.onError) this.onError('Connection failed');
            return;
        }
        this._intentionalClose = false;

        this.ws.onopen = () => {
            this.isOnline = true;
            if (this.onConnected) this.onConnected();
        };

        this.ws.onerror = (err) => {
            console.error('P2P WebSocket error:', err);
        };

        this.ws.onclose = () => {
            this.isOnline = false;
            this.ws = null;
            // Auto-reconnect if we were in a room (signaling dropped)
            if (this.roomCode && !this._intentionalClose) {
                setTimeout(() => {
                    if (!this.ws && this.roomCode && !this._intentionalClose) this.connect();
                }, 2000);
            }
            if (this.onDisconnected) this.onDisconnected();
        };

        this.ws.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch (err) { return; }
            try {
                this._handleSignalingMessage(msg);
            } catch (err) {
                console.error('P2P message handler failed:', msg && msg.t, err);
            }
        };

        this._startPings();
    }

    disconnect() {
        this._intentionalClose = true;
        this._stopPings();
        this._closeAllPeers();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isOnline = false;
        this.roomCode = null;
        this.isHost = false;
    }

    _send(msg) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(msg));
            return true;
        }
        return false;
    }

    // --- Room Operations (via signaling server) ---
    createRoom(name, settings) {
        this._send({ t: 'create_p2p_room', d: { name, settings } });
    }

    joinRoom(roomCode, name) {
        this._send({ t: 'join_p2p_room', d: { roomCode, name } });
    }

    leaveRoom() {
        this._send({ t: 'leave_room', d: {} });
        this._closeAllPeers();
        this.roomCode = null;
    }

    switchTeam(team) {
        this._send({ t: 'switch_team', d: { team } });
    }

    updateRoomSettings(settings) {
        this._send({ t: 'update_settings', d: settings });
    }

    startMatch() {
        if (!this.isHost) return;
        this._send({ t: 'start_p2p_match', d: { isP2P: true } });
    }

    // --- Signaling Message Handling ---
    _handleSignalingMessage(msg) {
        // Drop malformed frames before they can throw in the switch arms
        if (!msg || typeof msg.t !== 'string') return;
        if (!msg.d) msg.d = {};
        switch (msg.t) {
            case 'room_created':
                this.roomCode = msg.d.roomCode;
                this.isHost = true;
                if (this.onRoomCreated) this.onRoomCreated(msg.d);
                break;

            case 'room_joined':
                this.roomCode = msg.d.roomCode;
                this.isHost = !!msg.d.isHost;
                if (msg.d.playerId) this.playerId = msg.d.playerId;
                if (this.onRoomJoined) this.onRoomJoined(msg.d);
                break;

            case 'room_update':
                if (msg.d.hostId && this.playerId) {
                    this.isHost = (msg.d.hostId === this.playerId);
                }
                if (this.onRoomUpdate) this.onRoomUpdate(msg.d);
                break;

            case 'p2p_peer_joined':
                // Host: a new peer joined — create WebRTC offer
                this._knownPeers.add(msg.d.peerId);
                this._createOfferForPeer(msg.d.peerId);
                if (this.onPeerConnected) this.onPeerConnected(msg.d);
                break;

            case 'p2p_peer_left':
                if (msg.d.hostLeft) {
                    // Host disconnected — game over
                    this._closeAllPeers();
                    if (this.onError) this.onError('Host disconnected');
                } else {
                    this._knownPeers.delete(msg.d.peerId);
                    this._closePeer(msg.d.peerId);
                }
                if (this.onPeerDisconnected) this.onPeerDisconnected(msg.d);
                break;

            case 'signal_offer':
                // Guest: received offer from host
                this._handleOffer(msg.d.fromId, msg.d.sdp);
                break;

            case 'signal_answer':
                // Host: received answer from peer
                this._handleAnswer(msg.d.fromId, msg.d.sdp);
                break;

            case 'signal_ice':
                // Either side: received ICE candidate
                this._handleIceCandidate(this.isHost ? msg.d.fromId : 'host', msg.d.candidate);
                break;

            case 'match_starting':
                if (this.onMatchStarting) this.onMatchStarting(msg.d);
                break;

            case 'state':
                // Guest: host data relayed through the server (no direct link)
                if (!this.isHost && (!msg.d.to || msg.d.to === this.playerId)) {
                    this._handleRelayed('host', msg.d);
                }
                break;

            case 'p2p_peer_input':
                // Host: guest data relayed through the server
                if (this.isHost && msg.d.peerId && msg.d.input) {
                    this._handleRelayed(msg.d.peerId, msg.d.input);
                }
                break;

            case 'error':
                if (this.onError) this.onError(msg.d.message);
                break;
        }
    }

    // --- WebRTC link management ---

    _link(peerId) {
        let link = this.peers.get(peerId);
        if (!link) {
            link = {
                peerId, pc: null, fast: null, ctrl: null,
                pendingIce: [], remoteSet: false,
                rtt: 0, dev: 0, samples: 0, createdAt: performance.now(),
                lastRecvSendTime: 0, lastRecvAt: 0, lastFastSend: 0,
                discTimer: null, offerAttempts: 0,
            };
            this.peers.set(peerId, link);
        }
        return link;
    }

    _newPeerConnection(peerId) {
        const link = this._link(peerId);
        this._closePc(link);
        const pc = new RTCPeerConnection(this._rtcConfig);
        link.pc = pc;
        link.pendingIce = [];
        link.remoteSet = false;

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                const targetId = this.isHost ? peerId : link.remotePlayerId;
                if (targetId) this._send({ t: 'signal_ice', d: { targetId, candidate: e.candidate } });
            }
        };

        pc.onconnectionstatechange = () => {
            if (link.pc !== pc) return;
            const st = pc.connectionState;
            if (st === 'connected') {
                if (link.discTimer) { clearTimeout(link.discTimer); link.discTimer = null; }
            } else if (st === 'disconnected') {
                // Often transient (Wi-Fi hiccup) — give ICE a few seconds to recover
                if (!link.discTimer) {
                    link.discTimer = setTimeout(() => {
                        link.discTimer = null;
                        if (link.pc === pc && pc.connectionState !== 'connected') this._onPcFailed(peerId);
                    }, 5000);
                }
            } else if (st === 'failed') {
                this._onPcFailed(peerId);
            }
        };
        return pc;
    }

    // Direct link lost: traffic falls back to the server relay. The host
    // also tries to re-establish the direct link a couple of times.
    _onPcFailed(peerId) {
        const link = this.peers.get(peerId);
        if (!link) return;
        this._closePc(link);
        if (this.onLinkChange) this.onLinkChange(peerId, 'closed');
        if (this.isHost && this._knownPeers.has(peerId) && link.offerAttempts < 3) {
            setTimeout(() => {
                if (this._knownPeers.has(peerId) && !link.pc) this._createOfferForPeer(peerId);
            }, 1000);
        }
    }

    _setupChannel(link, dc) {
        dc.binaryType = 'arraybuffer';
        const isFast = dc.label === 'fast';
        if (isFast) link.fast = dc; else link.ctrl = dc;
        dc.onopen = () => {
            if (this.onLinkChange) this.onLinkChange(link.peerId, 'open');
            if (isFast) this._sendFastRaw(link, null); // prime RTT measurement
        };
        dc.onclose = () => {
            if (isFast && link.fast === dc) link.fast = null;
            if (!isFast && link.ctrl === dc) link.ctrl = null;
        };
        dc.onmessage = (e) => {
            if (isFast) {
                if (e.data instanceof ArrayBuffer) this._receiveFast(link, new DataView(e.data));
            } else {
                let msg;
                try { msg = JSON.parse(e.data); } catch (err) { return; }
                this._dispatchReliable(link.peerId, msg);
            }
        };
    }

    // Host creates the offer and both channels for a peer
    async _createOfferForPeer(peerId) {
        const link = this._link(peerId);
        link.offerAttempts++;
        try {
            const pc = this._newPeerConnection(peerId);
            this._setupChannel(link, pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
            this._setupChannel(link, pc.createDataChannel('ctrl', { ordered: true }));
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this._send({ t: 'signal_offer', d: { targetId: peerId, sdp: offer.sdp } });
        } catch (err) {
            console.error('WebRTC offer failed:', err);
        }
    }

    // Guest answers the host's offer
    async _handleOffer(hostPlayerId, sdp) {
        const link = this._link('host');
        link.remotePlayerId = hostPlayerId;
        try {
            const pc = this._newPeerConnection('host');
            pc.ondatachannel = (e) => this._setupChannel(link, e.channel);
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
            this._flushIce(link);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this._send({ t: 'signal_answer', d: { targetId: link.remotePlayerId, sdp: answer.sdp } });
        } catch (err) {
            console.error('WebRTC answer failed:', err);
        }
    }

    async _handleAnswer(peerId, sdp) {
        const link = this.peers.get(peerId);
        if (!link || !link.pc) return;
        try {
            await link.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
            this._flushIce(link);
        } catch (err) {
            console.error('WebRTC set answer failed:', err);
        }
    }

    // Candidates can arrive before the remote description is set; adding
    // them then throws and the candidate is lost, so queue until ready.
    _handleIceCandidate(peerId, candidate) {
        const link = this.peers.get(peerId);
        if (!link || !link.pc || !candidate) return;
        if (!link.remoteSet) {
            link.pendingIce.push(candidate);
            return;
        }
        link.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    }

    _flushIce(link) {
        link.remoteSet = true;
        const queued = link.pendingIce;
        link.pendingIce = [];
        for (const c of queued) {
            link.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
    }

    // --- Fast (unreliable) messages ---

    // Send a binary payload; falls back to the server relay if the direct
    // channel isn't open.
    sendFast(peerId, payload) {
        const link = this.peers.get(peerId) || (this.isHost ? null : this._link('host'));
        if (!link) return false;
        return this._sendFastRaw(link, payload);
    }

    _sendFastRaw(link, payload) {
        const now = performance.now();
        const len = FAST_HEADER + (payload ? payload.length : 0);
        const v = this._sendView;
        v.setUint8(0, FAST_MAGIC);
        v.setFloat64(1, now, true);
        v.setFloat64(9, link.lastRecvSendTime, true);
        v.setFloat32(17, link.lastRecvAt ? now - link.lastRecvAt : 0, true);
        if (payload) this._sendBuf.set(payload, FAST_HEADER);
        link.lastFastSend = now;

        const dc = link.fast;
        if (dc && dc.readyState === 'open') {
            // Skip when the socket is backed up; netplay resends anything unacked
            if (dc.bufferedAmount > 65536) return false;
            try {
                dc.send(this._sendBuf.slice(0, len));
                // While ICE is "disconnected" (possibly recovering) also use
                // the relay so the other side isn't left waiting.
                if (!link.discTimer) return true;
            } catch (e) { /* fall through to relay */ }
        }
        const b64 = P2PNetwork._toBase64(this._sendBuf, len);
        if (this.isHost) {
            return this._send({ t: 'p2p_relay_state', d: { k: 'f', to: link.peerId, b: b64 } });
        }
        return this._send({ t: 'p2p_relay_input', d: { k: 'f', b: b64 } });
    }

    _receiveFast(link, view) {
        if (view.byteLength < FAST_HEADER || view.getUint8(0) !== FAST_MAGIC) return;
        const now = performance.now();
        const sendTime = view.getFloat64(1, true);
        const echoTime = view.getFloat64(9, true);
        const echoDelay = view.getFloat32(17, true);
        link.lastRecvSendTime = sendTime;
        link.lastRecvAt = now;
        if (echoTime > 0) {
            const rtt = now - echoTime - echoDelay;
            if (rtt >= 0 && rtt < 5000) {
                if (link.samples === 0) {
                    link.rtt = rtt;
                    link.dev = rtt / 4;
                } else {
                    link.dev = link.dev * 0.85 + Math.abs(rtt - link.rtt) * 0.15;
                    link.rtt = link.rtt * 0.9 + rtt * 0.1;
                }
                link.samples++;
            }
        }
        if (view.byteLength > FAST_HEADER && this.onFast) this.onFast(link.peerId, view, FAST_HEADER);
    }

    // --- Reliable messages ---

    sendReliable(peerId, msg) {
        const link = this.peers.get(peerId);
        const dc = link && link.ctrl;
        if (dc && dc.readyState === 'open' && !link.discTimer) {
            try { dc.send(JSON.stringify(msg)); return true; } catch (e) { /* relay */ }
        }
        if (this.isHost) return this._send({ t: 'p2p_relay_state', d: { k: 'r', to: peerId, m: msg } });
        return this._send({ t: 'p2p_relay_input', d: { k: 'r', m: msg } });
    }

    _handleRelayed(peerId, d) {
        if (!d || typeof d !== 'object') return;
        const link = this.isHost ? this.peers.get(peerId) || this._link(peerId) : this._link('host');
        if (d.k === 'f' && typeof d.b === 'string') {
            const bytes = P2PNetwork._fromBase64(d.b);
            if (bytes) this._receiveFast(link, new DataView(bytes.buffer));
        } else if (d.k === 'r' && d.m) {
            this._dispatchReliable(peerId, d.m);
        }
    }

    _dispatchReliable(peerId, msg) {
        if (msg && msg.k === 'bye') {
            this._handleBye(peerId);
            return;
        }
        if (this.onReliable) this.onReliable(peerId, msg);
    }

    // The other side is leaving on purpose. Sent over the data channel and
    // the server relay (ordered before our leave_room), so it arrives even if
    // the server doesn't announce the departure itself.
    sayGoodbye() {
        const msg = { k: 'bye' };
        if (this.isHost) {
            for (const peerId of new Set([...this._knownPeers, ...this.peers.keys()])) {
                const link = this.peers.get(peerId);
                if (link && link.ctrl && link.ctrl.readyState === 'open') {
                    try { link.ctrl.send(JSON.stringify(msg)); } catch (e) {}
                }
                this._send({ t: 'p2p_relay_state', d: { k: 'r', to: peerId, m: msg } });
            }
        } else {
            const link = this.peers.get('host');
            if (link && link.ctrl && link.ctrl.readyState === 'open') {
                try { link.ctrl.send(JSON.stringify(msg)); } catch (e) {}
            }
            this._send({ t: 'p2p_relay_input', d: { k: 'r', m: msg } });
        }
    }

    _handleBye(peerId) {
        if (this.isHost) {
            if (!this._knownPeers.has(peerId) && !this.peers.has(peerId)) return;
            this._knownPeers.delete(peerId);
            this._closePeer(peerId);
            if (this.onPeerDisconnected) this.onPeerDisconnected({ peerId });
        } else if (this.roomCode) {
            this._closeAllPeers();
            if (this.onError) this.onError('Host left the room');
        }
    }

    static _toBase64(bytes, len) {
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }

    static _fromBase64(b64) {
        try {
            const raw = atob(b64);
            const out = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
            return out;
        } catch (e) { return null; }
    }

    // --- Link info ---

    // Keep RTT fresh in the lobby and during stalls: a header-only packet to
    // any peer we haven't sent to recently.
    _startPings() {
        if (this._pingTimer) return;
        this._pingTimer = setInterval(() => {
            const now = performance.now();
            if (!this.isHost && this.roomCode) this._link('host');
            for (const link of this.peers.values()) {
                const direct = link.fast && link.fast.readyState === 'open';
                // Without a direct link, ping through the relay (less often)
                if (now - link.lastFastSend > (direct ? 200 : 1000) && (direct || this.roomCode)) {
                    this._sendFastRaw(link, null);
                }
            }
        }, 250);
    }

    _stopPings() {
        if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    }

    // Heard from recently (or only just joined) — used to leave ghost slots
    // out of a match.
    isPeerAlive(peerId) {
        const link = this.peers.get(peerId);
        if (!link) return false;
        const now = performance.now();
        return now - link.lastRecvAt < 4000 || now - link.createdAt < 5000;
    }

    getRtt(peerId) {
        const link = this.peers.get(peerId);
        if (!link) return null;
        return { rtt: link.rtt, dev: link.dev, samples: link.samples };
    }

    transportOf(peerId) {
        const link = this.peers.get(peerId);
        return link && link.fast && link.fast.readyState === 'open' ? 'p2p' : 'relay';
    }

    // Guests currently in the room (host only)
    get guestIds() {
        return [...this._knownPeers];
    }

    maxRtt() {
        let worst = 0;
        for (const link of this.peers.values()) if (link.samples > 0 && link.rtt > worst) worst = link.rtt;
        return worst;
    }

    // --- Cleanup ---
    _closePc(link) {
        if (link.discTimer) { clearTimeout(link.discTimer); link.discTimer = null; }
        for (const dc of [link.fast, link.ctrl]) {
            if (dc) { try { dc.close(); } catch (e) {} }
        }
        link.fast = null;
        link.ctrl = null;
        if (link.pc) {
            try { link.pc.close(); } catch (e) {}
            link.pc = null;
        }
    }

    _closePeer(peerId) {
        const link = this.peers.get(peerId);
        if (!link) return;
        this._closePc(link);
        this.peers.delete(peerId);
    }

    _closeAllPeers() {
        for (const peerId of [...this.peers.keys()]) this._closePeer(peerId);
        this._knownPeers.clear();
    }
}
