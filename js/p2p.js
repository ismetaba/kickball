// P2P networking using WebRTC data channels
// Host runs game physics, clients send input and receive state
// Fly.io server is only used for signaling (room codes, SDP exchange, ICE candidates)

class P2PNetwork {
    constructor(serverUrl) {
        // Use local server only when running in a real browser on localhost (not Capacitor)
        const isNativeApp = typeof window.Capacitor !== 'undefined';
        const isLocalDev = !isNativeApp && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
        this.serverUrl = serverUrl || (isLocalDev ? 'ws://localhost:8080' : 'wss://kickzone-server.fly.dev');
        this.ws = null;
        this.isOnline = false;
        this.isHost = false;
        this.isP2P = true;
        this.playerId = null;
        this.roomCode = null;

        // WebRTC
        this.peerConnections = new Map(); // peerId -> RTCPeerConnection
        this.dataChannels = new Map();    // peerId -> RTCDataChannel
        this.hostChannel = null;          // client's data channel to host

        // Same interface as network.js for compatibility
        this.stateBuffer = [];
        this.serverPlayerPos = null;
        this.renderDelay = 33; // Reduced with extrapolation support
        this.latency = 0;
        this.mySlot = null;

        // Callbacks (same as network.js)
        this.onConnected = null;
        this.onDisconnected = null;
        this.onError = null;
        this.onRoomCreated = null;
        this.onRoomJoined = null;
        this.onRoomUpdate = null;
        this.onMatchStarting = null;

        // Host-only callbacks
        this.onPeerInput = null;       // Called when host receives input from a peer
        this.onPeerConnected = null;
        this.onPeerDisconnected = null;

        // Client-only callbacks
        this.onStateSnapshot = null;   // Called when client receives state from host
        this.onGoal = null;
        this.onMatchEnd = null;

        // Lockstep callbacks
        this.onLockstepInput = null;    // Host receives peer input for a tick
        this.onConfirmedInputs = null;  // Guest receives confirmed inputs for a tick
        this.onChecksum = null;         // Guest receives checksum

        this.INPUT_SEND_INTERVAL = 16;
        this.lastInputSend = 0;

        this._rtcConfig = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
            ]
        };
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
                    if (!this.ws) this.connect();
                }, 2000);
            }
            if (this.onDisconnected) this.onDisconnected();
        };
        this._intentionalClose = false;

        this.ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                this._handleSignalingMessage(msg);
            } catch (err) {}
        };
    }

    disconnect() {
        this._intentionalClose = true;
        this._closeAllPeers();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.isOnline = false;
    }

    _send(msg) {
        if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify(msg));
        }
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
        this.mySlot = null;
    }

    switchTeam(team) {
        this._send({ t: 'switch_team', d: { team } });
    }

    updateRoomSettings(settings) {
        this._send({ t: 'update_settings', d: settings });
    }

    startMatch() {
        if (!this.isHost) return;
        // Send via signaling server so all peers get it (data channels may not be open yet)
        this._send({ t: 'start_p2p_match', d: { isP2P: true } });
    }

    // --- Signaling Message Handling ---
    _handleSignalingMessage(msg) {
        switch (msg.t) {
            case 'room_created':
                this.roomCode = msg.d.roomCode;
                this.isHost = true;
                if (this.onRoomCreated) this.onRoomCreated(msg.d);
                break;

            case 'room_joined':
                this.roomCode = msg.d.roomCode;
                this.isHost = msg.d.isHost;
                if (msg.d.playerId) this.playerId = msg.d.playerId;
                if (this.onRoomJoined) this.onRoomJoined(msg.d);
                break;

            case 'room_update':
                if (msg.d.hostId) {
                    this.isHost = (msg.d.hostId === this.playerId);
                }
                if (this.onRoomUpdate) this.onRoomUpdate(msg.d);
                break;

            case 'p2p_peer_joined':
                // Host: a new peer joined — create WebRTC offer
                this._createOfferForPeer(msg.d.peerId);
                if (this.onPeerConnected) this.onPeerConnected(msg.d);
                break;

            case 'p2p_peer_left':
                this._closePeer(msg.d.peerId);
                if (msg.d.hostLeft) {
                    // Host disconnected — game over
                    this._closeAllPeers();
                    if (this.onError) this.onError('Host disconnected');
                }
                if (this.onPeerDisconnected) this.onPeerDisconnected(msg.d);
                break;

            case 'signal_offer':
                // Client: received offer from host
                this._handleOffer(msg.d.fromId, msg.d.sdp);
                break;

            case 'signal_answer':
                // Host: received answer from peer
                this._handleAnswer(msg.d.fromId, msg.d.sdp);
                break;

            case 'signal_ice':
                // Either side: received ICE candidate
                this._handleIceCandidate(msg.d.fromId, msg.d.candidate);
                break;

            case 'pong':
                if (msg.d && msg.d.t) {
                    const rtt = performance.now() - msg.d.t;
                    this.latency = this.latency * 0.8 + rtt * 0.2;
                }
                break;

            case 'match_starting':
                if (this.onMatchStarting) this.onMatchStarting(msg.d);
                break;

            case 'state':
                // State relayed via WebSocket as base64 binary
                if (!this.isHost && msg.d) {
                    if (typeof msg.d === 'string') {
                        // Base64 encoded binary
                        const raw = atob(msg.d);
                        const buf = new ArrayBuffer(raw.length);
                        const bytes = new Uint8Array(buf);
                        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
                        this._handleBinaryState(buf);
                    } else {
                        // Legacy JSON fallback
                        this._handleHostMessage(msg);
                    }
                }
                break;

            case 'p2p_peer_input':
                // Host: input relayed from peer via WebSocket
                if (this.isHost && msg.d) {
                    if (msg.d.tk !== undefined && this.onLockstepInput) {
                        // Lockstep input via relay
                        this.onLockstepInput(msg.d.peerId, msg.d);
                    } else if (this.onPeerInput) {
                        this.onPeerInput(msg.d.peerId, msg.d.input);
                    }
                }
                break;

            case 'p2p_relay_state':
                // Client: confirmed lockstep inputs via relay
                if (!this.isHost && msg.d && msg.d.tk !== undefined && this.onConfirmedInputs) {
                    this.onConfirmedInputs(msg.d);
                }
                break;

            case 'goal':
                if (!this.isHost && this.onGoal) this.onGoal(msg.d);
                break;

            case 'match_end':
                if (!this.isHost && this.onMatchEnd) this.onMatchEnd(msg.d);
                break;

            case 'error':
                if (this.onError) this.onError(msg.d.message);
                break;
        }
    }

    // --- WebRTC: Host creates offer for a peer ---
    async _createOfferForPeer(peerId) {
        const pc = new RTCPeerConnection(this._rtcConfig);
        this.peerConnections.set(peerId, pc);

        // Create data channel (host side)
        const dc = pc.createDataChannel('game', { ordered: false, maxRetransmits: 0 });
        this._setupDataChannel(dc, peerId);

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this._send({ t: 'signal_ice', d: { targetId: peerId, candidate: e.candidate } });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                this._closePeer(peerId);
            }
        };

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this._send({ t: 'signal_offer', d: { targetId: peerId, sdp: offer.sdp } });
        } catch (err) {
            console.error('WebRTC offer failed:', err);
        }
    }

    // --- WebRTC: Client handles offer from host ---
    async _handleOffer(hostId, sdp) {
        const pc = new RTCPeerConnection(this._rtcConfig);
        this.peerConnections.set(hostId, pc);

        pc.ondatachannel = (e) => {
            this.hostChannel = e.channel;
            this._setupHostChannel(e.channel);
        };

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                this._send({ t: 'signal_ice', d: { targetId: hostId, candidate: e.candidate } });
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                if (this.onError) this.onError('Host disconnected');
                this._closeAllPeers();
            }
        };

        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this._send({ t: 'signal_answer', d: { targetId: hostId, sdp: answer.sdp } });
        } catch (err) {
            console.error('WebRTC answer failed:', err);
        }
    }

    // --- WebRTC: Host handles answer from peer ---
    async _handleAnswer(peerId, sdp) {
        const pc = this.peerConnections.get(peerId);
        if (!pc) return;
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        } catch (err) {
            console.error('WebRTC set answer failed:', err);
        }
    }

    // --- WebRTC: Handle ICE candidate ---
    async _handleIceCandidate(fromId, candidate) {
        const pc = this.peerConnections.get(fromId);
        if (!pc) return;
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {}
    }

    // --- Data Channel Setup (Host side — one per peer) ---
    _setupDataChannel(dc, peerId) {
        dc.binaryType = 'arraybuffer';
        dc.onopen = () => {
            this.dataChannels.set(peerId, dc);
        };
        dc.onclose = () => {
            this.dataChannels.delete(peerId);
        };
        dc.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.t === 'input' && this.onPeerInput) {
                    this.onPeerInput(peerId, msg.d);
                } else if (msg.t === 'li' && this.onLockstepInput) {
                    // Lockstep input from peer
                    this.onLockstepInput(peerId, msg.d);
                }
            } catch (err) {}
        };
    }

    // --- Data Channel Setup (Client side — channel to host) ---
    _setupHostChannel(dc) {
        dc.binaryType = 'arraybuffer';
        dc.onopen = () => {
            console.log('P2P data channel to host open');
        };
        dc.onclose = () => {
            this.hostChannel = null;
        };
        dc.onmessage = (e) => {
            // Binary data = state update
            if (e.data instanceof ArrayBuffer) {
                this._handleBinaryState(e.data);
                return;
            }
            try {
                const msg = JSON.parse(e.data);
                if (msg.t === 'ci' && this.onConfirmedInputs) {
                    // Lockstep confirmed inputs from host
                    this.onConfirmedInputs(msg.d);
                } else if (msg.t === 'cs' && this.onChecksum) {
                    // Lockstep checksum from host
                    this.onChecksum(msg.d);
                } else {
                    this._handleHostMessage(msg);
                }
            } catch (err) {}
        };
    }

    // --- Client: Decode binary state from host ---
    _handleBinaryState(buffer) {
        const view = new DataView(buffer);
        let o = 0; // offset
        const numPlayers = view.getUint8(o); o += 1;

        const players = [];
        for (let i = 0; i < numPlayers; i++) {
            const x = view.getInt16(o, true) / 10; o += 2;
            const y = view.getInt16(o, true) / 10; o += 2;
            const vx = view.getInt16(o, true) / 100; o += 2;
            const vy = view.getInt16(o, true) / 100; o += 2;
            players.push({ x, y, vx, vy });
        }

        const bx = view.getInt16(o, true) / 10; o += 2;
        const by = view.getInt16(o, true) / 10; o += 2;
        const bvx = view.getInt16(o, true) / 100; o += 2;
        const bvy = view.getInt16(o, true) / 100; o += 2;

        const redScore = view.getUint8(o); o += 1;
        const blueScore = view.getUint8(o); o += 1;
        const timeDs = view.getUint16(o, true); // deciseconds

        this.stateBuffer.push({
            p: players,
            b: { x: bx, y: by, vx: bvx, vy: bvy },
            s: { r: redScore, b: blueScore, t: timeDs / 10 },
            _time: performance.now(),
        });
        while (this.stateBuffer.length > 10) this.stateBuffer.shift();
    }

    // --- Client: Handle JSON messages from host via data channel ---
    _handleHostMessage(msg) {
        switch (msg.t) {
            case 'state':
                msg.d._time = performance.now();
                this.stateBuffer.push(msg.d);
                while (this.stateBuffer.length > 10) this.stateBuffer.shift();
                break;
            case 'match_starting':
                if (this.onMatchStarting) this.onMatchStarting(msg.d);
                break;
            case 'goal':
                if (this.onGoal) this.onGoal(msg.d);
                break;
            case 'match_end':
                if (this.onMatchEnd) this.onMatchEnd(msg.d);
                break;
        }
    }

    // --- Host: Broadcast binary state to all peers ---
    broadcastState(binaryData) {
        let sentViaDC = false;
        for (const [, dc] of this.dataChannels) {
            if (dc.readyState === 'open') {
                try { dc.send(binaryData); sentViaDC = true; } catch (e) {}
            }
        }
        // Fallback: relay via WebSocket as base64
        if (!sentViaDC && this.isHost) {
            const bytes = new Uint8Array(binaryData);
            let str = '';
            for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
            this._send({ t: 'p2p_relay_state', d: btoa(str) });
        }
    }

    broadcastMatchStarting(data) {
        const msg = JSON.stringify({ t: 'match_starting', d: data });
        for (const [, dc] of this.dataChannels) {
            if (dc.readyState === 'open') {
                try { dc.send(msg); } catch (e) {}
            }
        }
    }

    broadcastGoal(data) {
        const msg = JSON.stringify({ t: 'goal', d: data });
        let sent = false;
        for (const [, dc] of this.dataChannels) {
            if (dc.readyState === 'open') {
                try { dc.send(msg); sent = true; } catch (e) {}
            }
        }
        if (!sent) this._send({ t: 'p2p_relay_goal', d: data });
    }

    broadcastMatchEnd(data) {
        const msg = JSON.stringify({ t: 'match_end', d: data });
        let sent = false;
        for (const [, dc] of this.dataChannels) {
            if (dc.readyState === 'open') {
                try { dc.send(msg); sent = true; } catch (e) {}
            }
        }
        if (!sent) this._send({ t: 'p2p_relay_end', d: data });
    }

    // --- Lockstep: send local input for a future tick ---
    sendLockstepInput(tick, playerIdx, input) {
        const msg = JSON.stringify({
            t: 'li',
            d: {
                tk: tick,
                pi: playerIdx,
                x: (input.x * 100) | 0,
                y: (input.y * 100) | 0,
                k: input.kick ? 1 : 0,
                cr: (input.chargeRatio * 100) | 0,
                pl: input.pull ? 1 : 0,
                sw: input.switchPlayer ? 1 : 0
            }
        });

        let sent = false;
        if (this.isHost) {
            for (const [, dc] of this.dataChannels) {
                if (dc.readyState === 'open') {
                    try { dc.send(msg); sent = true; } catch(e) {}
                }
            }
        } else if (this.hostChannel && this.hostChannel.readyState === 'open') {
            try { this.hostChannel.send(msg); sent = true; } catch(e) {}
        }
        if (!sent) this._send({ t: 'p2p_relay_input', d: JSON.parse(msg).d });
    }

    // Host: broadcast confirmed inputs for a tick to all peers
    broadcastConfirmedInputs(tick, allInputs) {
        const msg = JSON.stringify({ t: 'ci', d: { tk: tick, inputs: allInputs } });
        let sent = false;
        for (const [, dc] of this.dataChannels) {
            if (dc.readyState === 'open') {
                try { dc.send(msg); sent = true; } catch(e) {}
            }
        }
        if (!sent) this._send({ t: 'p2p_relay_state', d: { tk: tick, inputs: allInputs } });
    }

    // Host: broadcast checksum
    broadcastChecksum(tick, hash) {
        const msg = JSON.stringify({ t: 'cs', d: { tk: tick, h: hash } });
        for (const [, dc] of this.dataChannels) {
            if (dc.readyState === 'open') {
                try { dc.send(msg); } catch(e) {}
            }
        }
    }

    // --- Client: Send input to host via data channel (or WebSocket fallback) ---
    sendInput(input) {
        const hasDC = this.hostChannel && this.hostChannel.readyState === 'open';
        if (!hasDC && (!this.ws || this.ws.readyState !== 1)) return false;

        const now = performance.now();
        const isOneShot = input.kickRelease || input.switchPlayer;
        if (!isOneShot && now - this.lastInputSend < this.INPUT_SEND_INTERVAL) return false;

        const chargeTime = input.kickCharging
            ? Math.min(performance.now() - (input.kickChargeStart || performance.now()), 1500)
            : (input.kickChargeTime || 0);

        const inputMsg = JSON.stringify({
            t: 'input',
            d: {
                x: (input.x * 100 + 0.5) | 0,
                y: (input.y * 100 + 0.5) | 0,
                kc: input.kickCharging ? 1 : 0,
                kt: chargeTime | 0,
                kr: input.kickRelease ? 1 : 0,
                sp: input.switchPlayer ? 1 : 0,
                pl: input.pull ? 1 : 0,
            }
        });

        try {
            if (hasDC) {
                this.hostChannel.send(inputMsg);
            } else {
                // Fallback: relay input via signaling server
                this._send({ t: 'p2p_relay_input', d: JSON.parse(inputMsg).d });
            }
        } catch (e) { return false; }

        this.lastInputSend = now;
        return true;
    }

    // --- Interpolation (same as network.js for client compatibility) ---
    interpolate(game) {
        const buf = this.stateBuffer;
        if (buf.length === 0) return;

        const now = performance.now();
        const renderTime = now - this.renderDelay;

        let prev = null, next = null;
        for (let i = buf.length - 1; i >= 0; i--) {
            if (buf[i]._time <= renderTime) {
                prev = buf[i];
                next = buf[i + 1] || prev;
                break;
            }
        }

        if (!prev) {
            prev = buf[buf.length - 1];
            next = prev;
        }

        const gap = next._time - prev._time;
        // Allow t > 1 for extrapolation (capped at 1.5 to prevent overshoot)
        const t = gap > 0 ? Math.min((renderTime - prev._time) / gap, 1.5) : 1;

        this._applyState(game, prev, next, t);
    }

    _applyState(game, prev, next, t) {
        const players = game.players;
        const ball = game.ball;
        const np = next.p;
        const pp = prev.p;

        if (!np || !ball) return;

        // Ball — interpolate + extrapolate for smoothness
        const nb = next.b;
        const pb = prev.b;
        if (nb && pb) {
            if (t <= 1) {
                // Interpolate between two known states
                ball.x = pb.x + (nb.x - pb.x) * t;
                ball.y = pb.y + (nb.y - pb.y) * t;
            } else {
                // Extrapolate beyond latest state using velocity
                const extraTime = (t - 1) * (next._time - prev._time) / 1000;
                ball.x = nb.x + nb.vx * extraTime;
                ball.y = nb.y + nb.vy * extraTime;
            }
            ball.vx = nb.vx;
            ball.vy = nb.vy;
        }

        // Players
        for (let i = 0; i < players.length && i < np.length; i++) {
            const p = players[i];
            const npItem = np[i];
            const ppItem = pp[i] || npItem;

            if (p === game.humanPlayer && !game.isHost) {
                // Client's local player — store server pos for reconciliation
                this.serverPlayerPos = {
                    x: ppItem.x + (npItem.x - ppItem.x) * Math.min(t, 1),
                    y: ppItem.y + (npItem.y - ppItem.y) * Math.min(t, 1),
                    vx: npItem.vx,
                    vy: npItem.vy,
                };
            } else {
                if (t <= 1) {
                    p.x = ppItem.x + (npItem.x - ppItem.x) * t;
                    p.y = ppItem.y + (npItem.y - ppItem.y) * t;
                } else {
                    const extraTime = (t - 1) * (next._time - prev._time) / 1000;
                    p.x = npItem.x + npItem.vx * extraTime;
                    p.y = npItem.y + npItem.vy * extraTime;
                }
                p.vx = npItem.vx;
                p.vy = npItem.vy;
            }
        }

        // Score & timer — only update HUD when changed
        if (next.s) {
            const newRed = next.s.r || 0;
            const newBlue = next.s.b || 0;
            if (game.redScore !== newRed || game.blueScore !== newBlue) {
                game.redScore = newRed;
                game.blueScore = newBlue;
                const redEl = document.getElementById('red-score');
                const blueEl = document.getElementById('blue-score');
                if (redEl) redEl.textContent = newRed;
                if (blueEl) blueEl.textContent = newBlue;
            }

            game.timeRemaining = (next.s.t || 0) * 1000;
            const secs = Math.ceil(game.timeRemaining / 1000);
            if (this._lastTimerSec !== secs) {
                this._lastTimerSec = secs;
                const timerEl = document.getElementById('timer');
                if (timerEl) {
                    const m = Math.floor(secs / 60);
                    const s = secs % 60;
                    timerEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
                }
            }
        }
    }

    // --- Cleanup ---
    _closePeer(peerId) {
        const dc = this.dataChannels.get(peerId);
        if (dc) { try { dc.close(); } catch (e) {} this.dataChannels.delete(peerId); }
        const pc = this.peerConnections.get(peerId);
        if (pc) { try { pc.close(); } catch (e) {} this.peerConnections.delete(peerId); }
    }

    _closeAllPeers() {
        for (const [id] of this.peerConnections) this._closePeer(id);
        if (this.hostChannel) { try { this.hostChannel.close(); } catch (e) {} this.hostChannel = null; }
    }

    get connectedPeerCount() {
        let count = 0;
        for (const [, dc] of this.dataChannels) {
            if (dc.readyState === 'open') count++;
        }
        return count;
    }
}
