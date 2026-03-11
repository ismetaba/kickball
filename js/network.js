// Network manager for online multiplayer via PeerJS (WebRTC)
class NetworkManager {
    constructor() {
        this.peer = null;
        this.conn = null;
        this.isHost = false;
        this.isOnline = false;
        this.roomCode = '';
        this.status = 'idle';

        // Callbacks
        this.onStatusChange = null;
        this.onRemoteInput = null;
        this.onStateSnapshot = null;
        this.onMatchStart = null;
        this.onGoalScored = null;
        this.onMatchEnd = null;
        this.onDisconnect = null;

        // Latency tracking
        this.latency = 0;
        this.pingInterval = null;

        // Throttle timers
        this.lastStateSend = 0;
        this.lastInputSend = 0;
        this.STATE_SEND_INTERVAL = 50;  // ~20Hz
        this.INPUT_SEND_INTERVAL = 33;  // ~30Hz
    }

    generateRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 4; i++) {
            code += chars[Math.floor(Math.random() * chars.length)];
        }
        return code;
    }

    // --- HOST ---
    hostGame() {
        this.isHost = true;
        this.roomCode = this.generateRoomCode();
        this.setStatus('creating', 'Creating room...');

        const peerId = 'kickzone-' + this.roomCode.toLowerCase();
        this.peer = new Peer(peerId, { debug: 0 });

        this.peer.on('open', () => {
            this.setStatus('waiting', 'Waiting for opponent...');
        });

        this.peer.on('connection', (conn) => {
            this.conn = conn;
            this.setupConnection(conn);
        });

        this.peer.on('error', (err) => {
            if (err.type === 'unavailable-id') {
                this.peer.destroy();
                this.roomCode = this.generateRoomCode();
                this.hostGame();
                return;
            }
            this.setStatus('error', 'Connection error: ' + err.type);
        });

        return this.roomCode;
    }

    // --- GUEST ---
    joinGame(roomCode) {
        this.isHost = false;
        this.roomCode = roomCode.toUpperCase();
        this.setStatus('connecting', 'Connecting...');

        this.peer = new Peer(undefined, { debug: 0 });

        this.peer.on('open', () => {
            const hostPeerId = 'kickzone-' + this.roomCode.toLowerCase();
            const conn = this.peer.connect(hostPeerId, { reliable: true });
            this.conn = conn;
            this.setupConnection(conn);
        });

        this.peer.on('error', (err) => {
            if (err.type === 'peer-unavailable') {
                this.setStatus('error', 'Room not found. Check the code.');
            } else {
                this.setStatus('error', 'Connection error: ' + err.type);
            }
        });
    }

    setupConnection(conn) {
        conn.on('open', () => {
            this.isOnline = true;
            this.setStatus('connected', 'Connected!');
            this.startPingLoop();
        });

        conn.on('data', (data) => {
            this.handleMessage(data);
        });

        conn.on('close', () => this.handleDisconnect());
        conn.on('error', () => this.handleDisconnect());
    }

    // --- Message Protocol ---
    handleMessage(msg) {
        switch (msg.t) {
            case 'input':
                if (this.onRemoteInput) this.onRemoteInput(msg.d);
                break;
            case 'state':
                if (this.onStateSnapshot) this.onStateSnapshot(msg.d);
                break;
            case 'start':
                if (this.onMatchStart) this.onMatchStart(msg.d);
                break;
            case 'ping':
                this.send({ t: 'pong', d: msg.d });
                break;
            case 'pong':
                this.latency = Math.round((performance.now() - msg.d) / 2);
                break;
            case 'goal':
                if (this.onGoalScored) this.onGoalScored(msg.d);
                break;
            case 'end':
                if (this.onMatchEnd) this.onMatchEnd(msg.d);
                break;
        }
    }

    send(data) {
        if (this.conn && this.conn.open) {
            this.conn.send(data);
        }
    }

    // --- State Serialization (compact) ---
    serializeState(game) {
        const players = game.players.map(p => ({
            x: Math.round(p.x * 10) / 10,
            y: Math.round(p.y * 10) / 10,
            vx: Math.round(p.vx * 100) / 100,
            vy: Math.round(p.vy * 100) / 100,
            team: p.team,
            isHuman: p.isHuman,
            isDashing: p.isDashing,
            isTackling: p.isTackling,
            stunTimer: Math.round(p.stunTimer),
            kickCooldown: Math.round(p.kickCooldown),
            kickChargeRatio: Math.round(p.kickChargeRatio * 100) / 100,
            powerUp: p.powerUp,
            powerUpTimer: Math.round(p.powerUpTimer),
            radius: p.radius,
            momentumBonus: Math.round(p.momentumBonus * 100) / 100,
        }));

        const ball = {
            x: Math.round(game.ball.x * 10) / 10,
            y: Math.round(game.ball.y * 10) / 10,
            vx: Math.round(game.ball.vx * 100) / 100,
            vy: Math.round(game.ball.vy * 100) / 100,
            spin: Math.round((game.ball.spin || 0) * 100) / 100,
            superKick: game.ball.superKick || 0,
        };

        const state = {
            p: players,
            b: ball,
            rs: game.redScore,
            bs: game.blueScore,
            t: Math.round(game.timeRemaining),
            mr: Math.round(game.momentum.red * 100) / 100,
            mb: Math.round(game.momentum.blue * 100) / 100,
            ts: game.timeScale,
            ig: game.isGoalScored,
        };

        // Include powerups on field
        if (game.powerUpManager && game.powerUpManager.powerUps) {
            state.pu = game.powerUpManager.powerUps.map(pu => ({
                x: Math.round(pu.x),
                y: Math.round(pu.y),
                tid: pu.type ? pu.type.id : null,
            }));
        }

        return state;
    }

    // Guest applies state snapshot
    deserializeState(snapshot, game) {
        const lerpFactor = 0.3;

        for (let i = 0; i < snapshot.p.length && i < game.players.length; i++) {
            const sp = snapshot.p[i];
            const gp = game.players[i];
            gp.x += (sp.x - gp.x) * lerpFactor;
            gp.y += (sp.y - gp.y) * lerpFactor;
            gp.vx = sp.vx;
            gp.vy = sp.vy;
            gp.isDashing = sp.isDashing;
            gp.isTackling = sp.isTackling;
            gp.stunTimer = sp.stunTimer;
            gp.kickCooldown = sp.kickCooldown;
            gp.kickChargeRatio = sp.kickChargeRatio;
            gp.powerUp = sp.powerUp;
            gp.powerUpTimer = sp.powerUpTimer;
            gp.radius = sp.radius;
            gp.momentumBonus = sp.momentumBonus;
        }

        const lerpBall = 0.35;
        game.ball.x += (snapshot.b.x - game.ball.x) * lerpBall;
        game.ball.y += (snapshot.b.y - game.ball.y) * lerpBall;
        game.ball.vx = snapshot.b.vx;
        game.ball.vy = snapshot.b.vy;
        game.ball.spin = snapshot.b.spin;
        game.ball.superKick = snapshot.b.superKick;

        game.redScore = snapshot.rs;
        game.blueScore = snapshot.bs;
        game.timeRemaining = snapshot.t;
        game.momentum.red = snapshot.mr;
        game.momentum.blue = snapshot.mb;
        game.timeScale = snapshot.ts;
        game.isGoalScored = snapshot.ig;

        // Update HUD
        document.getElementById('red-score').textContent = game.redScore;
        document.getElementById('blue-score').textContent = game.blueScore;
        const secs = Math.ceil(game.timeRemaining / 1000);
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        document.getElementById('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;

        // Update momentum bars
        const redBar = document.getElementById('momentum-fill-red');
        const blueBar = document.getElementById('momentum-fill-blue');
        if (redBar) redBar.style.width = (game.momentum.red / game.momentum.max * 100) + '%';
        if (blueBar) blueBar.style.width = (game.momentum.blue / game.momentum.max * 100) + '%';

        // Sync powerups
        if (snapshot.pu && game.powerUpManager) {
            game.powerUpManager.powerUps = snapshot.pu.filter(sp => sp.tid).map(sp => ({
                x: sp.x, y: sp.y,
                radius: 12,
                type: game.powerUpManager.types.find(t => t.id === sp.tid),
                bobTimer: 0,
                scale: 1,
            }));
        }
    }

    serializeInput(input) {
        return {
            x: Math.round(input.x * 100) / 100,
            y: Math.round(input.y * 100) / 100,
            dash: input.dash,
            tackle: input.tackle,
            kickCharging: input.kickCharging,
            kickChargeTime: input.kickChargeTime,
            kickRelease: input.kickRelease,
            switchPlayer: input.switchPlayer,
        };
    }

    // Host: send state (throttled)
    sendState(game) {
        const now = performance.now();
        if (now - this.lastStateSend < this.STATE_SEND_INTERVAL) return;
        this.lastStateSend = now;
        this.send({ t: 'state', d: this.serializeState(game) });
    }

    // Guest: send input (throttled)
    sendInput(input) {
        const now = performance.now();
        if (now - this.lastInputSend < this.INPUT_SEND_INTERVAL) return;
        this.lastInputSend = now;
        this.send({ t: 'input', d: this.serializeInput(input) });
    }

    sendMatchStart(settings) {
        this.send({ t: 'start', d: settings });
    }

    // --- Ping ---
    startPingLoop() {
        this.pingInterval = setInterval(() => {
            if (this.conn && this.conn.open) {
                this.send({ t: 'ping', d: performance.now() });
            }
        }, 2000);
    }

    setStatus(status, message) {
        this.status = status;
        if (this.onStatusChange) this.onStatusChange(status, message);
    }

    handleDisconnect() {
        this.isOnline = false;
        this.setStatus('disconnected', 'Opponent disconnected');
        this.stopPingLoop();
        if (this.onDisconnect) this.onDisconnect();
    }

    stopPingLoop() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    destroy() {
        this.stopPingLoop();
        if (this.conn) { this.conn.close(); this.conn = null; }
        if (this.peer) { this.peer.destroy(); this.peer = null; }
        this.isOnline = false;
        this.isHost = false;
        this.status = 'idle';
    }
}
