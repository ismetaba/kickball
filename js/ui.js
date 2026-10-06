// UI management
class UI {
    constructor(game) {
        this.game = game;
        this.currentScreen = 'menu';
        this.p2p = new P2PNetwork();
        this.playerName = 'Player' + Math.floor(Math.random() * 999);
        this._connecting = false; // blocks double-connects for host/join

        // Online match state
        this._isP2PRoom = false;
        this._room = null;          // last room snapshot { slots, settings, isHost }
        this._session = null;       // LockstepSession while an online match runs
        this._launchTimer = null;
        this._awaitStartTimer = null;
        this._netHudTimer = null;

        this.setupMenuEvents();
        this.setupSettingsEvents();
        this.setupGameEvents();
        this._setupRoomEvents();
        this.setupP2PEvents();

        // Initialize audio on first user interaction (required by mobile browsers)
        const initAudio = () => {
            Sound.init();
            Sound.unlock();
            document.removeEventListener('touchstart', initAudio);
            document.removeEventListener('click', initAudio);
        };
        document.addEventListener('touchstart', initAudio, { once: true });
        document.addEventListener('click', initAudio, { once: true });

        // UI click sounds for all buttons
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('button, .option-btn, .menu-btn');
            if (btn) Sound.uiClick();
        });
    }

    showScreen(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        const target = document.getElementById(`${name}-screen`);
        if (target) target.classList.add('active');
        this.currentScreen = name;
    }

    // Unified "wait for p2p to connect, then do thing" flow.
    // Shows status via `statusFn`, gives up after ~5s.
    _whenP2PConnected(statusFn, onReady, onTimeout) {
        if (this.p2p.isOnline) { onReady(); return; }
        if (this._connecting) {
            // Already trying — just poll for readiness without re-connecting
        } else {
            this._connecting = true;
            try { this.p2p.connect(); } catch (e) { /* connect() is defensive */ }
        }
        let attempts = 0;
        const MAX_ATTEMPTS = 25; // 5 seconds at 200ms
        const poll = () => {
            if (this.p2p.isOnline) {
                this._connecting = false;
                onReady();
                return;
            }
            if (++attempts >= MAX_ATTEMPTS) {
                this._connecting = false;
                if (onTimeout) onTimeout();
                return;
            }
            if (statusFn) statusFn(attempts, MAX_ATTEMPTS);
            setTimeout(poll, 200);
        };
        poll();
    }

    setupMenuEvents() {
        document.getElementById('btn-quick-match').addEventListener('click', () => {
            this.showScreen('match-settings');
        });

        document.getElementById('btn-host-game').addEventListener('click', () => {
            const btn = document.getElementById('btn-host-game');
            if (btn.disabled) return;
            const originalText = 'Create Room';
            btn.textContent = 'Connecting…';
            btn.disabled = true;
            this._whenP2PConnected(
                null,
                () => {
                    btn.textContent = originalText;
                    btn.disabled = false;
                    this.p2p.createRoom(this.playerName, this.game.settings);
                },
                () => {
                    btn.textContent = originalText;
                    btn.disabled = false;
                    this._showToast('Could not reach server. Check your internet connection.');
                }
            );
        });

        document.getElementById('btn-join-game').addEventListener('click', () => {
            this.showScreen('join');
            const statusEl = document.getElementById('join-status');
            if (statusEl) statusEl.textContent = '';
        });

        document.getElementById('btn-back-join').addEventListener('click', () => {
            this.showScreen('menu');
        });

        // Auto-uppercase and allow pressing Enter to join
        const joinInput = document.getElementById('join-code-input');
        if (joinInput) {
            joinInput.addEventListener('input', () => {
                joinInput.value = joinInput.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4);
            });
            joinInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') document.getElementById('btn-join-code').click();
            });
        }

        document.getElementById('btn-join-code').addEventListener('click', () => {
            const btn = document.getElementById('btn-join-code');
            if (btn.disabled) return;
            const code = (joinInput?.value || '').trim().toUpperCase();
            const statusEl = document.getElementById('join-status');
            if (code.length !== 4) {
                if (statusEl) statusEl.textContent = 'Enter a 4-character room code.';
                return;
            }

            btn.disabled = true;
            btn.textContent = '…';
            if (statusEl) statusEl.textContent = 'Connecting…';

            this._whenP2PConnected(
                null,
                () => {
                    if (statusEl) statusEl.textContent = 'Joining room ' + code + '…';
                    this.p2p.joinRoom(code, this.playerName);
                    // Button stays disabled — onRoomJoined / onError will re-enable by navigating
                    // Safety: re-enable after 8s in case no reply arrives
                    setTimeout(() => {
                        btn.disabled = false;
                        btn.textContent = 'JOIN';
                    }, 8000);
                },
                () => {
                    btn.disabled = false;
                    btn.textContent = 'JOIN';
                    if (statusEl) statusEl.textContent = 'Could not reach server.';
                }
            );
        });

        document.getElementById('btn-practice').addEventListener('click', () => {
            this.startPractice();
        });

        const aiLabBtn = document.getElementById('btn-ai-lab');
        if (aiLabBtn) aiLabBtn.addEventListener('click', () => {
            this.showScreen('ai-lab');
            this._initAILab();
        });

        document.getElementById('btn-settings').addEventListener('click', () => {
            this.showScreen('match-settings');
        });

        document.getElementById('btn-how-to-play').addEventListener('click', () => {
            this.showScreen('how-to-play');
        });

        document.getElementById('btn-back-help').addEventListener('click', () => {
            this.showScreen('menu');
        });
    }

    setupSettingsEvents() {
        // Option buttons toggle
        document.querySelectorAll('.option-row').forEach(row => {
            row.querySelectorAll('.option-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    row.querySelectorAll('.option-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');

                    if (btn.dataset.teamSize) this.game.settings.teamSize = parseInt(btn.dataset.teamSize);
                    if (btn.dataset.duration) this.game.settings.duration = parseInt(btn.dataset.duration);
                    if (btn.dataset.goals) this.game.settings.goalLimit = parseInt(btn.dataset.goals);
                    if (btn.dataset.difficulty) this.game.settings.difficulty = btn.dataset.difficulty;
                    if (btn.dataset.powerups) this.game.settings.powerups = btn.dataset.powerups === 'on';
                    if (btn.dataset.map) this.game.settings.map = btn.dataset.map;
                });
            });
        });

        // Volume controls
        const volSlider = document.getElementById('volume-slider');
        const muteBtn = document.getElementById('btn-mute');
        volSlider.value = Sound.volume * 100;
        muteBtn.textContent = Sound.muted ? '🔇' : '🔊';
        volSlider.addEventListener('input', () => {
            Sound.init();
            Sound.setVolume(volSlider.value / 100);
            if (Sound.muted) { Sound.toggleMute(); muteBtn.textContent = '🔊'; }
        });
        muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            Sound.init();
            const muted = Sound.toggleMute();
            muteBtn.textContent = muted ? '🔇' : '🔊';
        });

        document.getElementById('btn-back-menu').addEventListener('click', () => {
            this.showScreen('menu');
        });

        document.getElementById('btn-start-match').addEventListener('click', () => {
            Sound.uiStart();
            this.startGame();
        });
    }

    setupGameEvents() {
        document.getElementById('btn-pause').addEventListener('click', () => {
            if (this.game.isNetworked) {
                // Online: show leave confirmation instead of pausing
                document.getElementById('pause-overlay').classList.remove('hidden');
                document.getElementById('btn-resume').textContent = 'Back to Game';
                document.getElementById('btn-restart').classList.add('hidden');
                document.getElementById('btn-quit').textContent = 'Leave Match';
            } else {
                if (this.game.isPaused) this.game.resume();
                else this.game.pause();
            }
        });

        document.getElementById('btn-resume').addEventListener('click', () => {
            if (this.game.isNetworked) {
                // Just close the overlay — game never paused
                document.getElementById('pause-overlay').classList.add('hidden');
            } else {
                this.game.resume();
            }
        });

        document.getElementById('btn-restart').addEventListener('click', () => {
            this.game.restart();
        });

        document.getElementById('btn-quit').addEventListener('click', () => {
            this._teardownMatch();
            this.showScreen('menu');
        });

        document.getElementById('btn-rematch').addEventListener('click', () => {
            // Online: go back to the room so the host can start another match
            if (this._session || this._isP2PRoom) {
                this._backToRoom();
                return;
            }
            document.getElementById('result-overlay').classList.add('hidden');
            this.game.restart();
        });

        document.getElementById('btn-result-menu').addEventListener('click', () => {
            this._teardownMatch();
            this.showScreen('menu');
        });
    }

    // Stop whatever match is running (local or online) without touching the
    // room connection. Safe to call when nothing is running.
    _endMatchSession() {
        // Controls own their own event listeners — destroy them so they
        // don't accumulate across matches.
        if (this.controls) {
            this.controls.destroy();
            this.controls = null;
        }
        if (this._launchTimer) { clearTimeout(this._launchTimer); this._launchTimer = null; }
        if (this._awaitStartTimer) { clearTimeout(this._awaitStartTimer); this._awaitStartTimer = null; }
        if (this._session) {
            this._session.destroy();
            this._session = null;
        }
        this._stopNetHud();
        this._showWaiting(false);

        this.game.quit();

        // Practice and online matches run with their own settings; give the
        // player back the ones they picked on the settings screen.
        if (this._userSettings) {
            this.game.settings = this._userSettings;
            this._userSettings = null;
        }

        // Reset pause / result overlay text for next time
        const resumeBtn = document.getElementById('btn-resume');
        const restartBtn = document.getElementById('btn-restart');
        const quitBtn = document.getElementById('btn-quit');
        const rematchBtn = document.getElementById('btn-rematch');
        if (resumeBtn) resumeBtn.textContent = 'Resume';
        if (restartBtn) restartBtn.classList.remove('hidden');
        if (quitBtn) quitBtn.textContent = 'Quit to Menu';
        if (rematchBtn) rematchBtn.textContent = 'Rematch';
        document.getElementById('pause-overlay').classList.add('hidden');
        document.getElementById('result-overlay').classList.add('hidden');
    }

    // Full teardown back to the main menu: also leaves any online room.
    _teardownMatch() {
        this._endMatchSession();
        if (this._isP2PRoom) {
            try { this.p2p.sayGoodbye(); } catch (e) {}
            try { this.p2p.leaveRoom(); } catch (e) {}
            try { this.p2p.disconnect(); } catch (e) {}
            this._isP2PRoom = false;
            this._room = null;
        }
    }

    // After an online match: stay connected and return to the room lobby.
    _backToRoom() {
        this._endMatchSession();
        if (this._isP2PRoom && this._room) {
            this._updateRoomSlots(this._room.slots, this._room.settings, this.p2p.isHost);
            this.showScreen('room');
        } else {
            this._teardownMatch();
            this.showScreen('menu');
        }
    }

    // --- Room lobby events (P2P only) ---
    _setupRoomEvents() {
        document.getElementById('btn-switch-team').addEventListener('click', () => {
            const currentTeam = this._myTeam || 'red';
            this.p2p.switchTeam(currentTeam === 'red' ? 'blue' : 'red');
        });

        document.getElementById('btn-start-room').addEventListener('click', () => {
            Sound.uiStart();
            this.p2p.startMatch();
        });

        document.getElementById('btn-leave-room').addEventListener('click', () => {
            this._teardownMatch();
            this.showScreen('menu');
        });

        // Room team size buttons (host only)
        document.querySelectorAll('.room-size-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const size = parseInt(btn.dataset.roomSize);
                this.p2p.updateRoomSettings({ teamSize: size });
            });
        });
    }

    // Lightweight toast — small non-blocking notice.
    _showToast(message, ms = 3200) {
        let toast = document.getElementById('ui-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'ui-toast';
            toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);' +
                'background:rgba(20,25,55,0.95);border:1px solid rgba(77,212,255,0.35);' +
                'color:#fff;padding:10px 18px;border-radius:10px;z-index:200;font-size:14px;' +
                'backdrop-filter:blur(6px);box-shadow:0 4px 16px rgba(0,0,0,0.45);transition:opacity 0.25s;';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.style.opacity = '1';
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, ms);
    }

    setupP2PEvents() {
        this.p2p.onRoomCreated = (data) => {
            this._isP2PRoom = true;
            this.showScreen('room');
            document.getElementById('room-code-display').textContent = data.roomCode;
            document.getElementById('btn-start-room').classList.remove('hidden');
            document.getElementById('room-team-size').classList.remove('hidden');
        };

        this.p2p.onRoomJoined = (data) => {
            this._isP2PRoom = true;
            this.showScreen('room');
            document.getElementById('room-code-display').textContent = data.roomCode;
            const isHost = data.hostId ? (data.hostId === this.p2p.playerId) : !!data.isHost;
            this._room = { slots: data.slots || [], settings: data.settings || {} };
            this._updateRoomSlots(this._room.slots, this._room.settings, isHost);
        };

        this.p2p.onRoomUpdate = (data) => {
            const isHost = data.hostId ? (data.hostId === this.p2p.playerId) : this.p2p.isHost;
            this._room = { slots: data.slots || [], settings: data.settings || {} };
            this._updateRoomSlots(this._room.slots, this._room.settings, isHost);
        };

        this.p2p.onError = (msg) => {
            const joinStatus = document.getElementById('join-status');
            if (joinStatus && this.currentScreen === 'join') {
                joinStatus.textContent = msg || 'Connection error';
                // Re-enable the JOIN button
                const btn = document.getElementById('btn-join-code');
                if (btn) { btn.disabled = false; btn.textContent = 'JOIN'; }
                return;
            }
            // Mid-match or in a room: the room is gone (e.g. host left)
            if (this.game.isRunning || this._isP2PRoom) {
                this._showToast(msg || 'Disconnected from room');
                this._teardownMatch();
                this.showScreen('menu');
            } else {
                this._showToast(msg || 'Connection error');
            }
        };

        this.p2p.onDisconnected = () => {
            // Signaling channel dropped. Mid-match that's usually fine (the
            // game runs peer-to-peer); in the lobby it's worth surfacing.
            if (this.currentScreen === 'room' && !this.game.isRunning) {
                this._showToast('Lost connection. Reconnecting…');
            }
        };

        this.p2p.onMatchStarting = (data) => {
            if (this.p2p.isHost) this._hostStartMatch(data);
            else this._awaitHostStart();
        };

        this.p2p.onPeerDisconnected = (data) => {
            if (data && !data.hostLeft && this._session && this.p2p.isHost && this._session.links.has(data.peerId)) {
                this._session.peerGone(data.peerId);
                this._showToast('A player left — the AI takes over');
            }
        };

        this.p2p.onLinkChange = (peerId, state) => {
            if (state === 'open') this.p2p.sendReliable(peerId, { k: 'hello', v: NETPLAY_PROTOCOL });
        };

        this.p2p.onReliable = (peerId, msg) => {
            if (!msg || typeof msg.k !== 'string') return;
            if (msg.k === 'hello') {
                if (msg.v !== NETPLAY_PROTOCOL && !this._versionWarned) {
                    this._versionWarned = true;
                    this._showToast('The other player has a different app version — update both devices.', 5000);
                }
            } else if (msg.k === 'ls_start') {
                if (!this.p2p.isHost) this._guestStartMatch(msg);
            } else if (this._session) {
                this._session.handleReliable(peerId, msg);
            }
        };

        this.p2p.onFast = (peerId, view, offset) => {
            if (this._session) this._session.handleFast(peerId, view, offset);
        };
    }

    // Map lobby slots to player indices: red slots fill 0..n-1, blue slots
    // n..2n-1, in server order (identical on every device).
    static _assignSlots(slots, teamSize) {
        const assign = new Map();
        let red = 0, blue = 0;
        for (const slot of slots) {
            if (!slot || !slot.playerId) continue;
            if (slot.team === 'red' && red < teamSize) assign.set(slot.playerId, red++);
            else if (slot.team === 'blue' && blue < teamSize) assign.set(slot.playerId, teamSize + blue++);
        }
        return assign;
    }

    // Host: the server confirmed the start. Pick the shared seed and input
    // delay, tell every guest, then start in sync with them.
    _hostStartMatch(data) {
        if (this.game.isRunning || this._session) this._endMatchSession();
        const slots = data.slots || [];
        let red = 0, blue = 0;
        for (const s of slots) { if (s.team === 'red') red++; else if (s.team === 'blue') blue++; }
        const base = { ...this.game.settings, ...(data.settings || {}) };
        const teamSize = Math.max(1, Math.min(4, Math.max(base.teamSize || 1, red, blue)));
        const settings = {
            teamSize,
            duration: base.duration,
            goalLimit: base.goalLimit,
            powerups: base.powerups !== false,
            map: base.map || 'classic',
            difficulty: base.difficulty || 'normal',
        };
        // Leave out players we haven't heard from (closed the app, lost
        // connection) — their slot is played by the AI instead of stalling.
        const live = slots.filter(s => s.playerId === this.p2p.playerId || this.p2p.isPeerAlive(s.playerId));
        const assign = UI._assignSlots(live, teamSize);
        const mySlot = assign.get(this.p2p.playerId);
        if (mySlot === undefined) {
            this._showToast('Could not start match');
            return;
        }

        // Initial delay from the worst measured RTT (adapts during the match)
        let oneWay = 0, dev = 0, measured = false, guests = 0;
        for (const peerId of assign.keys()) {
            if (peerId === this.p2p.playerId) continue;
            guests++;
            const r = this.p2p.getRtt(peerId);
            if (r && r.samples > 0) {
                measured = true;
                if (r.rtt / 2 > oneWay) { oneWay = r.rtt / 2; dev = r.dev; }
            }
        }
        if (guests > 1) oneWay *= 2; // guest -> host -> guest
        const inputDelay = measured ? LockstepSession.delayFor(oneWay, dev) : 4;
        const seed = ((Math.random() * 0x7ffffffe) | 0) + 1;
        const startIn = 300;

        const startMsg = {
            k: 'ls_start', v: NETPLAY_PROTOCOL, seed, inputDelay, settings,
            assign: [...assign], startIn,
        };
        const peerSlots = new Map();
        for (const [peerId, slot] of assign) {
            if (peerId === this.p2p.playerId) continue;
            peerSlots.set(peerId, slot);
            this.p2p.sendReliable(peerId, startMsg);
        }

        this._launchMatch({
            isHost: true, seed, inputDelay, settings,
            humanSlots: [...assign.values()], mySlot, peerSlots,
        }, startIn);
    }

    // Guest: the server says a match is starting; the host's start message
    // (seed, delay, slots) follows over the data channel.
    _awaitHostStart() {
        if (this._awaitStartTimer) clearTimeout(this._awaitStartTimer);
        this._awaitStartTimer = setTimeout(() => {
            this._awaitStartTimer = null;
            if (!this._session) this._showToast('Match could not start — ask the host to try again');
        }, 6000);
    }

    _guestStartMatch(msg) {
        if (msg.v !== NETPLAY_PROTOCOL) {
            this._showToast('The host has a different app version — update both devices.', 5000);
            return;
        }
        if (this.game.isRunning || this._session) this._endMatchSession();
        if (this._awaitStartTimer) { clearTimeout(this._awaitStartTimer); this._awaitStartTimer = null; }
        const assign = new Map(msg.assign || []);
        const mySlot = assign.get(this.p2p.playerId);
        if (mySlot === undefined) {
            this._showToast('No free slot in this match');
            return;
        }
        // Start at the same moment as the host: its timer began roughly
        // one-way latency before this message arrived.
        const r = this.p2p.getRtt('host');
        const oneWay = r && r.samples > 0 ? r.rtt / 2 : 0;
        this._launchMatch({
            isHost: false, seed: msg.seed, inputDelay: msg.inputDelay, settings: msg.settings,
            humanSlots: [...assign.values()], mySlot,
        }, Math.max(0, (msg.startIn || 0) - oneWay));
    }

    _launchMatch(cfg, delayMs) {
        const session = new LockstepSession({
            game: this.game,
            net: this.p2p,
            isHost: cfg.isHost,
            mySlot: cfg.mySlot,
            humanSlots: cfg.humanSlots,
            peerSlots: cfg.peerSlots || new Map(),
            inputDelay: cfg.inputDelay,
        });
        session.onStallChange = (stalled) => this._showWaiting(stalled);
        session.onConnectionLost = () => {
            this._showToast('Connection lost');
            this._teardownMatch();
            this.showScreen('menu');
        };
        session.onPeerSilent = () => this._showToast('A player disconnected — the AI takes over');
        this._session = session;

        this.showScreen('game');
        document.getElementById('btn-rematch').textContent = 'Back to Room';
        this._launchTimer = setTimeout(() => {
            this._launchTimer = null;
            if (this._session !== session) return;
            if (!this._userSettings) this._userSettings = { ...this.game.settings };
            this.game.netplay = session;
            this.game.startLockstepMatch({
                settings: cfg.settings,
                seed: cfg.seed,
                humanSlots: cfg.humanSlots,
                mySlot: cfg.mySlot,
            });
            this.game.onMatchEnd = () => session.linger();
            session.start();
            this._ensureControls();
            this._startNetHud();
        }, delayMs);
    }

    // Small "ping" readout so connection quality is visible during a match
    _startNetHud() {
        const el = document.getElementById('net-indicator');
        if (!el) return;
        this._stopNetHud();
        el.classList.remove('hidden');
        const update = () => {
            if (!this._session) return;
            const st = this._session.getStats();
            el.textContent = `${Math.round(st.rtt)} ms${st.relay ? ' · relay' : ''}`;
            el.classList.toggle('warn', st.rtt >= 80 || st.relay);
            el.classList.toggle('bad', st.rtt >= 160);
        };
        update();
        this._netHudTimer = setInterval(update, 500);
    }

    _stopNetHud() {
        if (this._netHudTimer) { clearInterval(this._netHudTimer); this._netHudTimer = null; }
        const el = document.getElementById('net-indicator');
        if (el) el.classList.add('hidden');
    }

    _showWaiting(show) {
        const el = document.getElementById('net-waiting');
        if (el) el.classList.toggle('hidden', !show);
    }

    _updateRoomSlots(slots, settings, isHost) {
        const redSlots = document.getElementById('red-slots');
        const blueSlots = document.getElementById('blue-slots');
        redSlots.textContent = '';
        blueSlots.textContent = '';

        const myId = this.p2p.playerId;
        for (const slot of slots) {
            const div = document.createElement('div');
            div.style.cssText = 'padding:6px 10px;border-radius:6px;font-size:14px;' +
                (slot.isHost ? 'border:1px solid #ffd700;' : 'border:1px solid rgba(255,255,255,0.1);') +
                'background:rgba(255,255,255,0.05);color:#fff;';
            div.textContent = (slot.isHost ? '★ ' : '') + slot.name + (slot.playerId === myId ? ' (you)' : '');

            if (slot.team === 'red') redSlots.appendChild(div);
            else blueSlots.appendChild(div);

            if (slot.playerId === myId) this._myTeam = slot.team;
        }

        // Fill empty slots with "AI" placeholder
        const teamSize = settings.teamSize || 1;
        const redCount = slots.filter(s => s.team === 'red').length;
        const blueCount = slots.filter(s => s.team === 'blue').length;
        const aiCss = 'padding:6px 10px;border-radius:6px;font-size:14px;border:1px solid rgba(255,255,255,0.05);background:rgba(255,255,255,0.02);color:#555;';
        for (let i = redCount; i < teamSize; i++) {
            const div = document.createElement('div');
            div.style.cssText = aiCss;
            div.textContent = 'AI';
            redSlots.appendChild(div);
        }
        for (let i = blueCount; i < teamSize; i++) {
            const div = document.createElement('div');
            div.style.cssText = aiCss;
            div.textContent = 'AI';
            blueSlots.appendChild(div);
        }

        // Show settings
        document.getElementById('room-settings-display').textContent =
            `${teamSize}v${teamSize} | ${settings.map} | ${settings.duration}s | Goal limit: ${settings.goalLimit || 'None'}`;

        // Start button and team size selector (host only)
        const startBtn = document.getElementById('btn-start-room');
        const teamSizeDiv = document.getElementById('room-team-size');
        if (isHost) {
            startBtn.classList.remove('hidden');
            teamSizeDiv.classList.remove('hidden');
            // Highlight active size
            document.querySelectorAll('.room-size-btn').forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.roomSize) === teamSize);
            });
        } else {
            startBtn.classList.add('hidden');
            teamSizeDiv.classList.add('hidden');
        }
        // The host is always red (server rule), so only guests can switch
        const switchBtn = document.getElementById('btn-switch-team');
        if (switchBtn) switchBtn.classList.toggle('hidden', !!isHost);
    }

    startPractice() {
        this._endMatchSession();
        this._userSettings = { ...this.game.settings };
        this.game.settings = {
            ...this.game.settings,
            teamSize: 1, duration: 9999, goalLimit: 0, powerups: false, map: 'classic',
        };

        this.showScreen('game');
        this.game.startPractice();
        this._ensureControls();
    }

    startGame() {
        this._endMatchSession();
        this.game.practiceMode = false;
        this.showScreen('game');
        this.game.startMatch();
        this._ensureControls();
    }

    _ensureControls() {
        // Fresh Controls per match — destroy() zeroes any stale instance on quit.
        if (!this.controls) this.controls = new Controls(this.game);
    }

    // -------------------- AI Lab --------------------
    _initAILab() {
        if (this._aiLabInitialized) {
            this._refreshAILab();
            return;
        }
        this._aiLabInitialized = true;

        if (typeof RLOrchestrator === 'undefined') {
            const status = document.getElementById('ai-lab-status');
            if (status) {
                status.textContent = 'RL scripts missing';
                status.style.color = '#ff4d6d';
            }
            return;
        }

        // Track which mode (1v1 or 2v2) the lab is currently displaying.
        // Each mode has its own orchestrator; buttons route to the current one.
        this._aiLabMode = '1v1';

        // Mode tab switcher
        document.querySelectorAll('[data-mode]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-mode]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this._aiLabMode = btn.dataset.mode;
                // Lazy-create the right orchestrator for this mode
                this._ensureCurrentOrch();
                // Update mode description + phase button highlight + stats
                const desc = document.getElementById('ai-lab-mode-desc');
                if (desc) {
                    desc.textContent = this._aiLabMode === '1v1'
                        ? 'Train a 1v1 neural-network AI with PPO + League self-play. Your machine handles all training locally.'
                        : 'Train a 2v2 model with passing, teammate coordination, and role assignment. ~3× the training time of 1v1 but learns team strategy.';
                }
                this._highlightCurrentPhase();
                this._refreshAILab();
            });
        });

        // Lazy-create both orchestrators (the inactive one waits in the background)
        this._ensureCurrentOrch();

        // Phase selector
        document.querySelectorAll('[data-phase]').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('[data-phase]').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const p = parseInt(btn.dataset.phase);
                const orch = this._currentOrch();
                if (orch) orch.opts.phase = p;
                const desc = {
                    1: 'Sade tekme + hareket. Super-kick, body-check, pull devre dışı. Temel becerileri öğren.',
                    2: 'Phase 1 + body-check + pull aktif. Süper tekme hâlâ kapalı. Body-check abuse cezası.',
                    3: 'Tam oyun: super-kick + body-check + pull aktif. Abuse cezalı.',
                };
                const dEl = document.getElementById('phase-desc');
                if (dEl) dEl.textContent = desc[p];
            });
        });

        document.getElementById('btn-ai-lab-start').addEventListener('click', () => {
            const orch = this._currentOrch();
            if (!orch) return;
            orch.start();
            this._setAILabStatus(this._aiLabMode + ' Training Phase ' + (orch.opts.phase || 1), '#4dd4ff');
        });
        document.getElementById('btn-ai-lab-bc').addEventListener('click', async () => {
            const btn = document.getElementById('btn-ai-lab-bc');
            const orig = btn.textContent;
            btn.disabled = true;
            const orch = this._currentOrch();
            if (!orch) { btn.disabled = false; return; }
            try {
                orch.stop();
                this._setAILabStatus(this._aiLabMode + ' BC pretrain — round 1/4…', '#4dd4ff');
                orch.onProgress = (info) => {
                    if (info.event === 'bc') {
                        this._setAILabStatus(`${this._aiLabMode} BC — round ${info.round}/${info.rounds}, loss ${info.loss.toFixed(4)}`, '#4dd4ff');
                    } else {
                        this._refreshAILab(info);
                    }
                };
                await orch.pretrainFromRules({ totalSamples: 24000, rounds: 4, epochsPerRound: 4 });
                this._setAILabStatus(this._aiLabMode + ' BC done — ready for PPO', '#4dd4ff');
            } catch (e) {
                this._setAILabStatus('BC failed: ' + e.message, '#ff4d6d');
            } finally {
                btn.disabled = false;
                btn.textContent = orig;
            }
        });
        document.getElementById('btn-ai-lab-stop').addEventListener('click', () => {
            const orch = this._currentOrch();
            if (!orch) return;
            orch.stop();
            this._setAILabStatus(this._aiLabMode + ' Stopped', '#fc6');
        });
        document.getElementById('btn-ai-lab-save').addEventListener('click', () => {
            const orch = this._currentOrch();
            if (!orch) return;
            orch.saveAs('kickzone-rl-' + this._aiLabMode + '-gen' + orch.generation + '.json');
        });
        document.getElementById('ai-lab-load-input').addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const orch = this._currentOrch();
            if (!orch) return;
            try {
                await orch.loadFromFile(file);
                this._setAILabStatus(this._aiLabMode + ' Loaded', '#4dd4ff');
            } catch (err) {
                this._setAILabStatus('Load failed: ' + err.message, '#ff4d6d');
            }
            e.target.value = '';
        });
        document.getElementById('btn-ai-lab-test').addEventListener('click', () => {
            // Test match in the current mode's team size
            this.game.settings.teamSize = (this._aiLabMode === '2v2') ? 2 : 1;
            this.game.settings.difficulty = 'expert';
            this.game.settings.powerups = false;
            this.game.settings.map = 'classic';
            this.startGame();
        });
        document.getElementById('btn-ai-lab-reset').addEventListener('click', () => {
            if (!confirm('Reset all ' + this._aiLabMode + ' training progress? This cannot be undone.')) return;
            const orch = this._currentOrch();
            if (orch) orch.reset();
            this._setAILabStatus(this._aiLabMode + ' Reset', '#fc6');
            this._refreshAILab();
        });
        document.getElementById('btn-ai-lab-back').addEventListener('click', () => {
            this.showScreen('menu');
        });

        this._highlightCurrentPhase();
        this._refreshAILab();
    }

    _currentOrch() {
        return this._aiLabMode === '2v2' ? window.rlOrch2v2 : window.rlOrch;
    }

    _ensureCurrentOrch() {
        if (this._aiLabMode === '2v2') {
            if (typeof RLOrchestrator2v2 === 'undefined') return;
            if (!window.rlOrch2v2) window.rlOrch2v2 = new RLOrchestrator2v2();
            window.rlOrch2v2.onProgress = (info) => this._refreshAILab(info);
        } else {
            if (!window.rlOrch) window.rlOrch = new RLOrchestrator();
            window.rlOrch.onProgress = (info) => this._refreshAILab(info);
        }
    }

    _highlightCurrentPhase() {
        const orch = this._currentOrch();
        if (!orch) return;
        const p = orch.opts.phase || 1;
        document.querySelectorAll('[data-phase]').forEach(b => {
            b.classList.toggle('active', parseInt(b.dataset.phase) === p);
        });
    }

    _refreshAILab(info) {
        const orch = this._currentOrch();
        if (!orch) return;
        const $ = (id) => document.getElementById(id);
        if ($('ai-lab-gen')) $('ai-lab-gen').textContent = orch.generation;
        if ($('ai-lab-steps')) $('ai-lab-steps').textContent = orch.totalSteps.toLocaleString();
        if ($('ai-lab-league')) $('ai-lab-league').textContent = orch.league.size();
        const s = orch.lastStats;
        if (s) {
            if ($('ai-lab-ploss')) $('ai-lab-ploss').textContent = s.policyLoss.toFixed(4);
            if ($('ai-lab-vloss')) $('ai-lab-vloss').textContent = s.valueLoss.toFixed(4);
            if ($('ai-lab-entropy')) $('ai-lab-entropy').textContent = s.entropy.toFixed(3);
        }
        const ev = orch._lastEvalScore;
        if (ev && $('ai-lab-eval')) {
            $('ai-lab-eval').textContent = `${ev.agentGoals}–${ev.oppGoals}` + (ev.diff > 0 ? ' (winning)' : ev.diff < 0 ? ' (losing)' : '');
        }
        if ($('ai-lab-status')) {
            if (orch.isTraining) {
                $('ai-lab-status').textContent = 'Training (gen ' + orch.generation + ')';
                $('ai-lab-status').style.color = '#4dd4ff';
            }
        }
        // Tiny eval chart: x=generation, y=goal diff
        const chart = $('ai-lab-chart');
        if (chart && orch._evalHistory && orch._evalHistory.length) {
            const ctx = chart.getContext('2d');
            const w = chart.width, h = chart.height;
            ctx.clearRect(0, 0, w, h);
            const data = orch._evalHistory;
            let minY = -1, maxY = 1;
            for (const p of data) { if (p.diff < minY) minY = p.diff; if (p.diff > maxY) maxY = p.diff; }
            const span = Math.max(1, maxY - minY);
            // Zero line
            const zeroY = h - (0 - minY) / span * h;
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
            // Path
            ctx.strokeStyle = '#4dd4ff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            for (let i = 0; i < data.length; i++) {
                const x = (i / Math.max(1, data.length - 1)) * w;
                const y = h - (data[i].diff - minY) / span * h;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
    }

    _setAILabStatus(text, color) {
        const el = document.getElementById('ai-lab-status');
        if (!el) return;
        el.textContent = text;
        el.style.color = color || '#fff';
    }
}
