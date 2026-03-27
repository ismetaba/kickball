// WebSocket network manager for online multiplayer
// Uses proper interpolation: renders remote entities ~100ms behind real-time
// by blending between two known server states.
class NetworkManager {
    constructor() {
        this.ws = null;
        this.playerId = null;
        this.roomCode = null;
        this.isOnline = false;
        this.isHost = false;
        this.mySlot = null;
        this.latency = 0;

        // Server URL — always connect to Fly.io production server
        this.serverUrl = 'wss://kickzone-server.fly.dev';

        // Input throttle — send every frame at 60Hz for minimal latency
        this.lastInputSend = 0;
        this.INPUT_SEND_INTERVAL = 16; // ~60Hz

        // --- Interpolation state ---
        // We buffer server snapshots and render remote entities between two
        // known states. The render point is (now - renderDelay) so we're always
        // interpolating between known data, never extrapolating.
        this.stateBuffer = [];     // [{...state, _time: ms}, ...] sorted by _time
        this.renderDelay = 50;     // ms behind real-time (lower = more responsive)
        this._serverTimeOffset = 0; // local_time - server_time estimate

        // Target positions for local player correction (set by interpolation)
        this.serverPlayerPos = null; // {x, y, vx, vy} from latest state for mySlot

        // Callbacks
        this.onConnected = null;
        this.onDisconnected = null;
        this.onError = null;
        this.onLobbyList = null;
        this.onRoomCreated = null;
        this.onRoomJoined = null;
        this.onRoomUpdate = null;
        this.onMatchStarting = null;
        this.onGoal = null;
        this.onGameEvent = null;
        this.onMatchEnd = null;

        // Ping
        this._pingInterval = null;
        this._pingsSent = 0;

        // Cached DOM refs
        this._scoreRedEl = null;
        this._scoreBlueEl = null;
        this._timerEl = null;
        this._lastTimerSec = -1;
        this._lastRedScore = -1;
        this._lastBlueScore = -1;
    }

    connect() {
        if (this.ws) this.disconnect();

        let url = this.serverUrl;
        if (!url.startsWith('ws')) {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            url = protocol + '//' + url;
        }

        this.ws = new WebSocket(url);

        this.ws.onopen = () => {
            this.isOnline = true;
            this._startPing();
            if (this.onConnected) this.onConnected();
        };

        this.ws.onmessage = (e) => {
            try {
                this._handleMessage(JSON.parse(e.data));
            } catch (err) {
                // ignore bad messages
            }
        };

        this.ws.onclose = () => {
            this.isOnline = false;
            this._stopPing();
            if (this.onDisconnected) this.onDisconnected();
        };

        this.ws.onerror = () => {
            if (this.onError) this.onError('Connection failed');
        };
    }

    disconnect() {
        this._stopPing();
        if (this.ws) { this.ws.close(); this.ws = null; }
        this.isOnline = false;
        this.roomCode = null;
        this.mySlot = null;
        this.stateBuffer.length = 0;
    }

    send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    // --- Lobby Operations ---
    createRoom(name, settings) { this.send({ t: 'create_room', d: { name, settings } }); }
    joinRoom(roomCode, name, team) { this.send({ t: 'join_room', d: { roomCode, name, team } }); }
    leaveRoom() { this.send({ t: 'leave_room', d: {} }); this.roomCode = null; this.mySlot = null; }
    listLobby() { this.send({ t: 'list_lobby', d: {} }); }
    startMatch() { this.send({ t: 'start_match', d: {} }); }
    switchTeam(team) { this.send({ t: 'switch_team', d: { team } }); }
    updateRoomSettings(settings) { this.send({ t: 'update_settings', d: settings }); }
    quickMatch(name) { this.send({ t: 'quick_match', d: { name } }); }

    // --- In-Game Input ---
    sendInput(input) {
        const now = performance.now();
        const isOneShot = input.kickRelease || input.switchPlayer;
        if (!isOneShot && now - this.lastInputSend < this.INPUT_SEND_INTERVAL) return false;

        // Send current charge time while charging (not just on release)
        const chargeTime = input.kickCharging
            ? Math.min(performance.now() - (input.kickChargeStart || performance.now()), 1500)
            : (input.kickChargeTime || 0);

        this.send({
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

        this.lastInputSend = now;
        return true;
    }

    // --- Core: Interpolate between two server states ---
    // Call this every frame from the render loop.
    // Returns an object with interpolated positions for all entities,
    // or null if not enough data yet.
    interpolate(game) {
        const buf = this.stateBuffer;
        if (buf.length === 0) return;

        const now = performance.now();
        const renderTime = now - this.renderDelay;

        // Find the two states to interpolate between
        // We want: prev._time <= renderTime <= next._time
        let prev = null, next = null;
        for (let i = 1; i < buf.length; i++) {
            if (buf[i]._time >= renderTime) {
                prev = buf[i - 1];
                next = buf[i];
                break;
            }
        }

        // If renderTime is past all buffered states, use the latest and extrapolate slightly
        if (!prev && buf.length >= 2) {
            prev = buf[buf.length - 2];
            next = buf[buf.length - 1];
        } else if (!prev) {
            // Only one state — just snap to it
            this._applyState(game, buf[buf.length - 1], buf[buf.length - 1], 1);
            return;
        }

        const range = next._time - prev._time;
        // Allow up to 1.5x extrapolation for smoother motion when packets are slightly delayed
        const alpha = range > 0 ? Math.max(0, Math.min(1.5, (renderTime - prev._time) / range)) : 1;

        this._applyState(game, prev, next, alpha);

        // Prune old states (keep at least 2 before renderTime for safety)
        while (buf.length > 4 && buf[1]._time < renderTime) {
            buf.shift();
        }
    }

    // Hermite interpolation: uses position + velocity at both endpoints
    // Produces much smoother curves than linear interpolation
    _hermite(p0, v0, p1, v1, t, dt) {
        // dt = time between states in seconds (for velocity scaling)
        const t2 = t * t;
        const t3 = t2 * t;
        const h00 = 2*t3 - 3*t2 + 1;
        const h10 = t3 - 2*t2 + t;
        const h01 = -2*t3 + 3*t2;
        const h11 = t3 - t2;
        return h00 * p0 + h10 * (v0 * dt) + h01 * p1 + h11 * (v1 * dt);
    }

    _applyState(game, prev, next, alpha) {
        const mySlot = this.mySlot;
        const players = game.players;
        const ball = game.ball;
        // Time between states in seconds (for hermite velocity scaling)
        const stateDt = (next._time - prev._time) / 1000 || 0.025;
        // Scale factor: server velocity is in pixels/frame (~16.67ms), convert to px/sec
        const velScale = 60; // 60 frames/sec

        // Interpolate remote players, store server pos for local player
        for (let i = 0; i < players.length && i < next.p.length && i < prev.p.length; i++) {
            const pp = prev.p[i];
            const np = next.p[i];
            const p = players[i];

            if (i === mySlot) {
                // Use hermite for smoother server target
                const targetX = this._hermite(pp.x, pp.vx * velScale, np.x, np.vx * velScale, Math.min(alpha, 1), stateDt);
                const targetY = this._hermite(pp.y, pp.vy * velScale, np.y, np.vy * velScale, Math.min(alpha, 1), stateDt);
                const targetVx = pp.vx + (np.vx - pp.vx) * alpha;
                const targetVy = pp.vy + (np.vy - pp.vy) * alpha;
                this.serverPlayerPos = { x: targetX, y: targetY, vx: targetVx, vy: targetVy };
                p.stunTimer = np.s || 0;
                p.powerUp = np.pu;
                p.powerUpTimer = np.pt || 0;
                p.pullActive = np.pa === 1;
                p.pullCooldown = np.pc || 0;
            } else {
                // Remote players: hermite interpolation for smooth curves
                const t = Math.min(alpha, 1);
                p.x = this._hermite(pp.x, pp.vx * velScale, np.x, np.vx * velScale, t, stateDt);
                p.y = this._hermite(pp.y, pp.vy * velScale, np.y, np.vy * velScale, t, stateDt);
                // When extrapolating past buffer (alpha > 1), use velocity-based extrapolation
                if (alpha > 1) {
                    const extra = (alpha - 1) * (next._time - prev._time) / 16.67;
                    p.x = np.x + np.vx * extra;
                    p.y = np.y + np.vy * extra;
                }
                p.vx = pp.vx + (np.vx - pp.vx) * alpha;
                p.vy = pp.vy + (np.vy - pp.vy) * alpha;
                p.stunTimer = np.s || 0;
                p.kickChargeRatio = np.k || 0;
                p.powerUp = np.pu;
                p.powerUpTimer = np.pt || 0;
                p.pullActive = np.pa === 1;
                p.pullCooldown = np.pc || 0;
            }
        }

        // Ball: hermite interpolation for buttery smooth movement
        const bp = prev.b;
        const bn = next.b;
        const bt = Math.min(alpha, 1);
        ball.x = this._hermite(bp.x, bp.vx * velScale, bn.x, bn.vx * velScale, bt, stateDt);
        ball.y = this._hermite(bp.y, bp.vy * velScale, bn.y, bn.vy * velScale, bt, stateDt);
        // Extrapolate ball when past buffer
        if (alpha > 1) {
            const extra = (alpha - 1) * (next._time - prev._time) / 16.67;
            ball.x = bn.x + bn.vx * extra;
            ball.y = bn.y + bn.vy * extra;
        }
        ball.vx = bp.vx + (bn.vx - bp.vx) * alpha;
        ball.vy = bp.vy + (bn.vy - bp.vy) * alpha;
        ball.spin = bn.sp;
        ball.superKick = bn.sk;
        ball.superTarget = bn.st;
        ball.fireLevel = bn.fl;
        ball.ghost = bn.gh === 1;

        // Match state from latest
        const s = next;
        game.timeRemaining = s.t;
        game.suddenDeath = s.sd === 1;
        game.suddenDeathShrink = s.sds;
        game.kickoffActive = s.ka === 1;
        game.kickoffTeam = s.kt;
        game.isGoalScored = s.ig === 1;
        game.timeScale = s.ts || 1;

        // Scores — cache DOM refs and only update on change
        if (!this._scoreRedEl) {
            this._scoreRedEl = document.getElementById('red-score');
            this._scoreBlueEl = document.getElementById('blue-score');
            this._timerEl = document.getElementById('timer');
        }
        if (this._lastRedScore !== s.rs || this._lastBlueScore !== s.bs) {
            game.redScore = s.rs;
            game.blueScore = s.bs;
            this._lastRedScore = s.rs;
            this._lastBlueScore = s.bs;
            this._scoreRedEl.textContent = s.rs;
            this._scoreBlueEl.textContent = s.bs;
        }

        // Timer — once per second
        const secs = (s.t / 1000 + 0.99) | 0; // fast ceil
        if (this._lastTimerSec !== secs) {
            this._lastTimerSec = secs;
            const m = (secs / 60) | 0;
            const sec = secs % 60;
            this._timerEl.textContent = m + ':' + (sec < 10 ? '0' : '') + sec;
            this._timerEl.style.color = game.suddenDeath ? '#ff4444' : '';
        }

        // Power-ups
        if (game.powerUpManager) {
            const puData = s.pu || [];
            const existing = game.powerUpManager.powerUps;
            if (puData.length !== existing.length) {
                if (!this._puTypeMap) {
                    this._puTypeMap = {};
                    for (const t of game.powerUpManager.types) this._puTypeMap[t.id] = t;
                }
                game.powerUpManager.powerUps = puData.map(pu => ({
                    x: pu.x, y: pu.y, radius: 14,
                    type: this._puTypeMap[pu.tid] || game.powerUpManager.types[0],
                    bobTimer: 0, scale: 1, rotateTimer: 0, pulseTimer: 0, spawnTime: performance.now(),
                }));
            } else {
                for (let i = 0; i < puData.length; i++) {
                    existing[i].x = puData[i].x;
                    existing[i].y = puData[i].y;
                }
            }
        }
    }

    // --- Message Handling ---
    _handleMessage(msg) {
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
                // Update isHost from hostId sent by server
                if (msg.d.hostId) {
                    this.isHost = (msg.d.hostId === this.playerId);
                }
                if (this.onRoomUpdate) this.onRoomUpdate(msg.d);
                break;
            case 'lobby_list':
                if (this.onLobbyList) this.onLobbyList(msg.d);
                break;
            case 'match_starting':
                this.mySlot = msg.d.yourSlot;
                this.stateBuffer.length = 0;
                this.serverPlayerPos = null;
                if (this.onMatchStarting) this.onMatchStarting(msg.d);
                break;
            case 'state':
                msg.d._time = performance.now();
                this.stateBuffer.push(msg.d);
                // Cap buffer at 6 states (at 40Hz = 150ms window)
                // Smaller buffer = less memory, faster search
                while (this.stateBuffer.length > 6) this.stateBuffer.shift();
                break;
            case 'goal':
                if (this.onGoal) this.onGoal(msg.d);
                break;
            case 'event':
                if (this.onGameEvent) this.onGameEvent(msg.d);
                break;
            case 'match_end':
                if (this.onMatchEnd) this.onMatchEnd(msg.d);
                break;
            case 'pong':
                if (msg.d && msg.d.t) {
                    const rtt = performance.now() - msg.d.t;
                    // Smooth latency estimate
                    this.latency = this.latency * 0.8 + rtt * 0.2;
                    // Adjust render delay: keep it tight for responsiveness
                    // At 30Hz state rate, inter-frame gap is ~33ms
                    // We need just enough buffer to have 2 states to interpolate between
                    this.renderDelay = Math.max(35, Math.min(100, 35 + this.latency * 0.3));
                }
                break;
            case 'error':
                if (this.onError) this.onError(msg.d.message);
                break;
        }
    }

    // --- Ping ---
    _startPing() {
        this._pingInterval = setInterval(() => {
            this.send({ t: 'ping', d: { t: performance.now() } });
        }, 1000);
    }

    _stopPing() {
        if (this._pingInterval) { clearInterval(this._pingInterval); this._pingInterval = null; }
    }
}
