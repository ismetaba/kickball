// UI management
class UI {
    constructor(game) {
        this.game = game;
        this.currentScreen = 'menu';
        this.p2p = new P2PNetwork();
        this.playerName = 'Player' + Math.floor(Math.random() * 999);
        this._connecting = false; // blocks double-connects for host/join

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
        muteBtn.textContent = Sound.muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
        volSlider.addEventListener('input', () => {
            Sound.init();
            Sound.setVolume(volSlider.value / 100);
            if (Sound.muted) { Sound.toggleMute(); muteBtn.textContent = '\uD83D\uDD0A'; }
        });
        muteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            Sound.init();
            const muted = Sound.toggleMute();
            muteBtn.textContent = muted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
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
            if (this.game.isOnline || this.game.isP2PHost || this.game.isLockstep) {
                // Online/P2P/Lockstep: show leave confirmation instead of pausing
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
            if (this.game.isOnline || this.game.isP2PHost || this.game.isLockstep) {
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
            // P2P / online matches can't be restarted locally — leave match instead
            if (this.game.isP2PHost || this._isP2PRoom || this.game.isLockstep || this.game.isOnline) {
                this._teardownMatch();
                this.showScreen('menu');
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

    // Full match teardown — safe to call from quit, result, or disconnect.
    // Handles local, lockstep, and online cleanup in one place so each path
    // doesn't drift.
    _teardownMatch() {
        // Controls own their own event listeners — destroy them so they
        // don't accumulate across matches.
        if (this.controls) {
            this.controls.destroy();
            this.controls = null;
        }

        // Clean up P2P broadcast interval (legacy)
        if (this.game._p2pBroadcastInterval) {
            clearInterval(this.game._p2pBroadcastInterval);
            this.game._p2pBroadcastInterval = null;
        }
        // Clean up lockstep state
        this.game.isLockstep = false;
        this.game._lockstepInputBuffer = null;
        this.game._applyPeerInputs = null;
        this.game._pendingChecksums = null;
        this.game._recentChecksums = null;
        this.game._ciHistory = null;
        this.game._onLockstepStall = null;
        this.game._endMatchAtTick = null;
        this.game._replayUntil = 0;
        this.game.isOnline = false;
        // Restore the difficulty the lockstep match pinned to 'normal'
        if (this._preP2PDifficulty !== undefined) {
            this.game.settings.difficulty = this._preP2PDifficulty;
            this._preP2PDifficulty = undefined;
        }

        this.game.quit();

        if (this.game.isP2PHost || this._isP2PRoom) {
            try { this.p2p.leaveRoom(); } catch (e) {}
            try { this.p2p.disconnect(); } catch (e) {}
            this.game.isP2PHost = false;
            this._isP2PRoom = false;
        }

        // Reset pause overlay text for next time
        const resumeBtn = document.getElementById('btn-resume');
        const restartBtn = document.getElementById('btn-restart');
        const quitBtn = document.getElementById('btn-quit');
        if (resumeBtn) resumeBtn.textContent = 'Resume';
        if (restartBtn) restartBtn.classList.remove('hidden');
        if (quitBtn) quitBtn.textContent = 'Quit to Menu';
        document.getElementById('pause-overlay').classList.add('hidden');
        document.getElementById('result-overlay').classList.add('hidden');
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
            this.p2p.leaveRoom();
            this._isP2PRoom = false;
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
            this.showScreen('room');
            document.getElementById('room-code-display').textContent = data.roomCode;
            document.getElementById('btn-start-room').classList.remove('hidden');
            document.getElementById('room-team-size').classList.remove('hidden');
            this._isP2PRoom = true;
        };

        this.p2p.onRoomJoined = (data) => {
            this.showScreen('room');
            document.getElementById('room-code-display').textContent = data.roomCode;
            const isHost = data.hostId ? (data.hostId === this.p2p.playerId) : data.isHost;
            this._updateRoomSlots(data.slots, data.settings, isHost);
            this._isP2PRoom = true;
        };

        this.p2p.onRoomUpdate = (data) => {
            const isHost = data.hostId ? (data.hostId === this.p2p.playerId) : this.p2p.isHost;
            this._updateRoomSlots(data.slots, data.settings, isHost);
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
            // If a match is running and the host disconnected, teardown
            if (this.game.isRunning || this._isP2PRoom) {
                this._showToast(msg || 'Disconnected from room');
                this._teardownMatch();
                this.showScreen('menu');
            } else {
                this._showToast(msg || 'Connection error');
            }
        };

        this.p2p.onDisconnected = () => {
            // Signaling channel dropped. If we're mid-match it's often fine (WebRTC
            // is peer-to-peer by then), but if we're still in a room lobby it's worth
            // surfacing.
            if (this.currentScreen === 'room' && !this.game.isRunning) {
                this._showToast('Lost connection. Reconnecting…');
            }
        };

        // Host: when match starts, run physics locally and broadcast to peers
        this.p2p.onMatchStarting = (data) => {
            if (this.p2p.isHost) {
                this._startP2PHostMatch(data);
            } else {
                // Client: same as server-based online but use p2p for networking
                this._startP2PClientMatch(data);
            }
        };

        // Client: handle goal from host
        this.p2p.onGoal = (data) => {
            if (this.p2p.isHost) return; // Host already handles goals locally
            // Lockstep guests run the full deterministic sim: their own
            // scoreGoal() already handled scores, notification and sound.
            // Overwriting sim state from an async network message here
            // double-counts goals and fights the checksum/resync layer.
            if (this.game.isLockstep) return;
            this.game.redScore = data.redScore || 0;
            this.game.blueScore = data.blueScore || 0;
            const dom = this.game._dom;
            if (dom.redScore) dom.redScore.textContent = this.game.redScore;
            if (dom.blueScore) dom.blueScore.textContent = this.game.blueScore;

            // Show goal notification matching the host's richer markup
            const notif = dom.goalNotif;
            if (notif) {
                const fireLevel = data.fireLevel || 0;
                let goalText = 'GOAL!';
                if (fireLevel >= 2) goalText = 'INFERNO GOAL!!!';
                else if (fireLevel >= 1) goalText = 'FIRE GOAL!';
                if (dom.goalText) dom.goalText.textContent = goalText;
                if (dom.goalScorer) {
                    const team = (data.team || '').toUpperCase();
                    const pts = data.points && data.points > 1 ? ' (+' + data.points + ')' : '';
                    dom.goalScorer.textContent = team ? `${team} Team${pts}` : '';
                }
                notif.classList.remove('hidden');
                if (this._clientGoalTimer) clearTimeout(this._clientGoalTimer);
                this._clientGoalTimer = setTimeout(() => {
                    notif.classList.add('hidden');
                    this._clientGoalTimer = null;
                }, 2500);
            }

            if ((data.fireLevel || 0) >= 1 && typeof Sound.fireGoal === 'function') {
                Sound.fireGoal(data.fireLevel);
            } else {
                Sound.goal();
            }
        };

        // Client: handle match end from host — mirror the host's richer overlay
        this.p2p.onMatchEnd = (data) => {
            if (this.p2p.isHost) return;
            this.game.isRunning = false;
            this.game.matchOver = true;
            this.game.redScore = data.red || 0;
            this.game.blueScore = data.blue || 0;
            Sound.stopMusic();
            Sound.whistle(true);

            const dom = this.game._dom;
            const myTeam = this._myTeam || 'blue';
            const localScore = myTeam === 'red' ? this.game.redScore : this.game.blueScore;
            const remoteScore = myTeam === 'red' ? this.game.blueScore : this.game.redScore;

            if (dom.resultTitle) {
                if (localScore > remoteScore) {
                    dom.resultTitle.textContent = 'YOU WIN!';
                    dom.resultTitle.style.color = '#4caf50';
                    setTimeout(() => Sound.win(), 400);
                } else if (remoteScore > localScore) {
                    dom.resultTitle.textContent = 'YOU LOSE';
                    dom.resultTitle.style.color = '#e94560';
                    setTimeout(() => Sound.lose(), 400);
                } else {
                    dom.resultTitle.textContent = 'DRAW';
                    dom.resultTitle.style.color = '#53d8fb';
                }
            }

            if (dom.resultScore) this.game._renderScoreDuo(dom.resultScore, this.game.redScore, this.game.blueScore);
            if (dom.matchStats) {
                const totalPoss = this.game.stats.possession.red + this.game.stats.possession.blue;
                const redPoss = totalPoss > 0 ? Math.round((this.game.stats.possession.red / totalPoss) * 100) : 50;
                this.game._renderMatchStats(dom.matchStats, redPoss, false);
            }
            if (dom.resultOverlay) dom.resultOverlay.classList.remove('hidden');
        };

        // Host: receive input from peers
        this.p2p.onPeerInput = (peerId, input) => {
            if (this.game._p2pInputQueues) {
                const q = this.game._p2pInputQueues.get(peerId);
                if (q) {
                    q.x = (input.x || 0) / 100;
                    q.y = (input.y || 0) / 100;
                    q.kickCharging = !!input.kc;
                    q.kickChargeTime = input.kt || 0;
                    q.kickRelease = q.kickRelease || !!input.kr;
                    q.switchPlayer = q.switchPlayer || !!input.sp;
                    q.pull = !!input.pl;
                }
            }
        };
    }

    _startP2PHostMatch(data) {
        // Guard against double invocation (duplicate match_starting would
        // re-seed and restart the host mid-match, desyncing everyone).
        if (this.game.isRunning) return;

        // Input delay: server-echoed value from match_starting so host and
        // guests pre-seed the identical tick range (a mismatch desyncs tick 0).
        const INPUT_DELAY = Number.isInteger(data.inputDelay) ? data.inputDelay : 3;

        // Remember the local difficulty — lockstep pins it to 'normal' below,
        // and it must not leak into the next offline match.
        this._preP2PDifficulty = this.game.settings.difficulty;

        // Host runs the game using lockstep
        this.game.settings = {
            ...this.game.settings,
            ...data.settings,
        };
        // Lockstep sims must be identical on every peer: difficulty is not part
        // of the shared room settings, so pin it rather than inherit whatever
        // this device last used offline.
        this.game.settings.difficulty = 'normal';
        this.game.isOnline = false;
        this.game.isP2PHost = true;
        this.game.p2p = this.p2p;
        this.game.isLockstep = true;
        this.game._lockstepInputBuffer = new Map();
        this.game._myPlayerIdx = 0; // Host is always player 0
        this.game._inputDelay = INPUT_DELAY; // Store for runtime use
        // Clear single-device mode flags that would otherwise leak into this
        // match (e.g. practiceMode freezes the match timer on one peer only).
        this.game.practiceMode = false;
        this.game.isLocal1v1 = false;
        this.game.isSpectator = false;

        // Seed the shared RNG from the server-minted match seed (the same
        // match_starting message delivers it to every peer).
        const matchSeed = data.matchSeed || 12345;
        this.game.rng.seed(matchSeed);

        // Start the game
        this.showScreen('game');
        this.game.startMatch();

        // Start measuring RTT for adaptive delay adjustments mid-match
        this.p2p.startRTTMeasurement();

        // Pre-seed the first INPUT_DELAY ticks with empty inputs so lockstep can start advancing.
        // Without this, ticks 0..INPUT_DELAY-1 never get inputs and the game freezes.
        const emptyInput = { x: 0, y: 0, kick: false, chargeRatio: 0, pull: false, switchPlayer: false };
        for (let t = 0; t < INPUT_DELAY; t++) {
            const seedMap = new Map();
            for (let i = 0; i < this.game.players.length; i++) {
                seedMap.set(i, { ...emptyInput });
            }
            this.game._lockstepInputBuffer.set(t, seedMap);
        }

        this._ensureControls();

        // Map peers to player indices
        this._peerPlayerMap = new Map(); // peerId -> playerIdx
        this._peerIds = new Set();
        if (data.slots) {
            let redSlotIdx = 0, blueSlotIdx = 0;
            const teamSize = this.game.settings.teamSize;

            for (const slot of data.slots) {
                let playerIdx;
                if (slot.team === 'red') {
                    playerIdx = redSlotIdx++;
                } else {
                    playerIdx = teamSize + blueSlotIdx++;
                }

                if (slot.playerId === this.p2p.playerId) {
                    this.game._myPlayerIdx = playerIdx;
                    continue;
                }

                if (playerIdx >= 0 && playerIdx < this.game.players.length) {
                    const player = this.game.players[playerIdx];
                    player.isHuman = true;

                    // Remove AI for this player
                    this.game.aiControllers = this.game.aiControllers.filter(
                        ac => ac && ac.player !== player
                    );

                    this._peerPlayerMap.set(slot.playerId, playerIdx);
                    this._peerIds.add(slot.playerId);
                }
            }
        }

        // Build slot→controlled-player map so lockstep swap stays deterministic.
        // Every peer maintains this map identically.
        this.game._slotControlled = new Map();
        for (let i = 0; i < this.game.players.length; i++) {
            this.game._slotControlled.set(i, this.game.players[i]);
        }

        // The AI update loop consumes the shared RNG in aiControllers order, so
        // that order must be identical on every peer.
        this.game.aiControllers.sort((a, b) =>
            this.game.players.indexOf(a.player) - this.game.players.indexOf(b.player));

        // Pending peer inputs: tick -> Map(peerId -> input)
        this._pendingPeerInputs = new Map();

        // Host: receive lockstep inputs from peers
        this.p2p.onLockstepInput = (peerId, inputData) => {
            // Ignore inputs from peers who've already disconnected
            if (!this._peerIds.has(peerId)) return;
            const tick = inputData.tk;
            if (!this._pendingPeerInputs.has(tick)) {
                this._pendingPeerInputs.set(tick, new Map());
            }
            this._pendingPeerInputs.get(tick).set(peerId, inputData);

            // Check if we can confirm this tick
            this._tryConfirmTick(tick);
        };

        // Host: when a peer disconnects mid-match, drop them from the
        // expected-input set so the lockstep keeps confirming ticks instead
        // of stalling. The slot's player stays in place but receives no input
        // for the rest of the match — both host and remaining clients see
        // the same thing, so the simulations stay in sync.
        this.p2p.onPeerDisconnected = ({ peerId }) => {
            if (!peerId || !this._peerIds || !this._peerIds.has(peerId)) return;
            this._peerIds.delete(peerId);
            this._peerPlayerMap.delete(peerId);
            for (const [tick, peerMap] of this._pendingPeerInputs) {
                peerMap.delete(peerId);
                this._tryConfirmTick(tick);
            }
            // Also re-try every host-scheduled tick: ticks blocked SOLELY on
            // the departed peer have no _pendingPeerInputs entry at all, so the
            // loop above never visits them — without this the host deadlocks
            // forever when its only guest leaves mid-match.
            for (const tick of [...this._hostInputTicks.keys()].sort((a, b) => a - b)) {
                this._tryConfirmTick(tick);
            }
            this._showToast('A player disconnected');
        };

        // Unrecoverable stall: a peer stopped delivering inputs (hidden tab,
        // dead connection the socket layer hasn't noticed). Kick them so the
        // match resumes for everyone else.
        this.game._onLockstepStall = (tick) => {
            const peerInputs = this._pendingPeerInputs.get(tick);
            for (const peerId of [...this._peerIds]) {
                if (!peerInputs || !peerInputs.has(peerId)) {
                    this.p2p.onPeerDisconnected({ peerId });
                }
            }
        };

        // Track which ticks the host has submitted its own input for
        this._hostInputTicks = new Map(); // tick -> input

        // Called once per EXECUTED tick (from the lockstep accumulator loop):
        // read local input and schedule it for tickCount + INPUT_DELAY. The
        // host's input reaches guests inside the confirmed-inputs broadcast,
        // so no separate 'li' send is needed (guests have no handler for it).
        this.game._applyPeerInputs = () => {
            const game = this.game;
            const targetTick = game.tickCount + INPUT_DELAY;

            // Package local input
            const localInput = this._packageLockstepInput();
            this._hostInputTicks.set(targetTick, localInput);

            // Try to confirm any pending ticks
            this._tryConfirmTick(targetTick);
        };

        // Try to confirm a tick when all inputs are available
        this._tryConfirmTick = (tick) => {
            // Need host input + all peer inputs for this tick
            if (!this._hostInputTicks.has(tick)) return;

            const peerInputs = this._pendingPeerInputs.get(tick);
            if (this._peerIds.size > 0) {
                if (!peerInputs) return;
                for (const peerId of this._peerIds) {
                    if (!peerInputs.has(peerId)) return;
                }
            }

            // All inputs available — build confirmed input set
            const confirmedMap = new Map();

            // Host's own input
            const hostInput = this._hostInputTicks.get(tick);
            confirmedMap.set(this.game._myPlayerIdx, hostInput);

            // Peer inputs
            if (peerInputs) {
                for (const [peerId, inp] of peerInputs) {
                    const playerIdx = this._peerPlayerMap.get(peerId);
                    if (playerIdx !== undefined) {
                        confirmedMap.set(playerIdx, {
                            x: (inp.x || 0) / 100,
                            y: (inp.y || 0) / 100,
                            kick: !!inp.k,
                            chargeRatio: (inp.cr || 0) / 100,
                            pull: !!inp.pl,
                            switchPlayer: !!inp.sw
                        });
                    }
                }
            }

            // Add to local lockstep buffer
            this.game._lockstepInputBuffer.set(tick, confirmedMap);

            // Broadcast confirmed inputs to all peers
            const serialized = [];
            for (const [idx, inp] of confirmedMap) {
                serialized.push({
                    pi: idx,
                    x: (inp.x * 100) | 0,
                    y: (inp.y * 100) | 0,
                    k: inp.kick ? 1 : 0,
                    cr: (inp.chargeRatio * 100) | 0,
                    pl: inp.pull ? 1 : 0,
                    sw: inp.switchPlayer ? 1 : 0
                });
            }
            this.p2p.broadcastConfirmedInputs(tick, serialized);

            // Cleanup
            this._hostInputTicks.delete(tick);
            this._pendingPeerInputs.delete(tick);
        };
    }

    _packageLockstepInput() {
        const input = this.game.input;
        const chargeRatio = input.kickRelease ? Math.min(input.kickChargeTime / 1500, 1) : 0;
        // Quantize exactly like the wire encoding ((v*100)|0 / 100): the host
        // applies its own input from this object directly, so it must simulate
        // the same values the guests decode from the network.
        const q = (v) => ((v * 100) | 0) / 100;
        const result = {
            x: q(input.x),
            y: q(input.y),
            kick: !!input.kickRelease,
            chargeRatio: q(chargeRatio),
            pull: !!input.pull,
            switchPlayer: !!input.switchPlayer
        };

        // Consume one-shot inputs
        input.kickRelease = false;
        input.kickChargeTime = 0;
        input.switchPlayer = false;

        return result;
    }

    _buildP2PState() {
        // Binary protocol: pack all state into an ArrayBuffer
        // Layout: [playerCount(1)] [per player: x(2) y(2) vx(2) vy(2) = 8 bytes]
        //         [ball: x(2) y(2) vx(2) vy(2) = 8 bytes]
        //         [redScore(1) blueScore(1) timeRemaining(2) = 4 bytes]
        const players = this.game.players;
        const numPlayers = players.length;
        const totalBytes = 1 + numPlayers * 8 + 8 + 4;
        const buf = new ArrayBuffer(totalBytes);
        const view = new DataView(buf);
        let offset = 0;

        // Player count
        view.setUint8(offset++, numPlayers);

        // Players: positions * 10, velocities * 100 as int16
        for (let i = 0; i < numPlayers; i++) {
            const p = players[i];
            view.setInt16(offset, (p.x * 10) | 0, true); offset += 2;
            view.setInt16(offset, (p.y * 10) | 0, true); offset += 2;
            view.setInt16(offset, (p.vx * 100) | 0, true); offset += 2;
            view.setInt16(offset, (p.vy * 100) | 0, true); offset += 2;
        }

        // Ball
        const b = this.game.ball;
        view.setInt16(offset, (b.x * 10) | 0, true); offset += 2;
        view.setInt16(offset, (b.y * 10) | 0, true); offset += 2;
        view.setInt16(offset, (b.vx * 100) | 0, true); offset += 2;
        view.setInt16(offset, (b.vy * 100) | 0, true); offset += 2;

        // Score + timer
        view.setUint8(offset++, this.game.redScore || 0);
        view.setUint8(offset++, this.game.blueScore || 0);
        view.setUint16(offset, Math.round((this.game.timeRemaining || 0) / 100) | 0, true); // deciseconds

        return buf;
    }

    _startP2PClientMatch(data) {
        // Input delay: server-echoed value from match_starting — must match the
        // host's exactly, or the pre-seeded tick ranges diverge at tick 0.
        const INPUT_DELAY = Number.isInteger(data.inputDelay) ? data.inputDelay : 3;

        // Guard against double invocation (WS + DC both fire match_starting)
        if (this.game.isRunning) return;

        // Remember the local difficulty — lockstep pins it to 'normal' below,
        // and it must not leak into the next offline match.
        this._preP2PDifficulty = this.game.settings.difficulty;

        // Client in P2P lockstep mode — runs identical physics locally
        this.game.settings = data.settings || { teamSize: 1, map: 'classic', duration: 180, goalLimit: 0 };
        // Pin difficulty like the host does — it is not a shared room setting.
        this.game.settings.difficulty = 'normal';
        this.game.isOnline = false; // Not using old online interpolation
        this.game.isHost = false;
        this.game.isP2PHost = false;
        this.game.isLockstep = true;
        this.game.p2p = this.p2p;
        this.game._lockstepInputBuffer = new Map();
        this.game._inputDelay = INPUT_DELAY;
        this.game._pendingChecksums = new Map();
        this.game._recentChecksums = new Map();
        this.game._ciHistory = new Map();
        // Clear single-device mode flags that would otherwise leak into this
        // match (e.g. practiceMode freezes the match timer on one peer only).
        this.game.practiceMode = false;
        this.game.isLocal1v1 = false;
        this.game.isSpectator = false;

        // Seed RNG with same match seed as host
        const matchSeed = data.matchSeed || 12345;
        this.game.rng.seed(matchSeed);

        const settings = this.game.settings;

        // Start the game identically to the host
        this.showScreen('game');
        this.game.startMatch();

        // Start measuring RTT for adaptive delay
        this.p2p.startRTTMeasurement();

        // Pre-seed the first INPUT_DELAY ticks with empty inputs so lockstep can start advancing.
        // Must match what the host does — both sides need identical initial ticks.
        const emptyInput = { x: 0, y: 0, kick: false, chargeRatio: 0, pull: false, switchPlayer: false };
        for (let t = 0; t < INPUT_DELAY; t++) {
            const seedMap = new Map();
            for (let i = 0; i < this.game.players.length; i++) {
                seedMap.set(i, { ...emptyInput });
            }
            this.game._lockstepInputBuffer.set(t, seedMap);
        }

        // Now remap players: find which one we control
        const mySlot = data.mySlot !== undefined ? data.mySlot : 1;
        this.p2p.mySlot = mySlot;

        // startMatch() sets players[0] as human by default.
        // We need to re-assign based on actual slot assignments.
        // First, revert the default human assignment:
        const defaultHuman = this.game.humanPlayer;
        if (defaultHuman) {
            defaultHuman.isHuman = false;
            // Add AI controller back for this player
            this.game.aiControllers.push({ player: defaultHuman, ai: new AIController(settings.difficulty || 'normal') });
            this.game.humanPlayer = null;
        }

        // Determine our player index from slots
        let myPlayerIdx = 0;
        if (data.slots) {
            let redSlotIdx = 0, blueSlotIdx = 0;
            const teamSize = settings.teamSize;

            for (const slot of data.slots) {
                let playerIdx;
                if (slot.team === 'red') {
                    playerIdx = redSlotIdx++;
                } else {
                    playerIdx = teamSize + blueSlotIdx++;
                }

                if (slot.playerId === this.p2p.playerId || slot.index === mySlot) {
                    myPlayerIdx = playerIdx;
                    if (playerIdx < this.game.players.length) {
                        const player = this.game.players[playerIdx];
                        player.isHuman = true;
                        this.game.humanPlayer = player;

                        // Remove AI for this player
                        this.game.aiControllers = this.game.aiControllers.filter(
                            ac => ac && ac.player !== player
                        );
                    }
                } else {
                    // Mark other human players as human (not AI controlled)
                    if (slot.playerId && playerIdx < this.game.players.length) {
                        const player = this.game.players[playerIdx];
                        player.isHuman = true;
                        this.game.aiControllers = this.game.aiControllers.filter(
                            ac => ac && ac.player !== player
                        );
                    }
                }
            }
        }

        this.game._myPlayerIdx = myPlayerIdx;

        // Mirror the host's slot→controlled-player map so lockstep swap is deterministic.
        this.game._slotControlled = new Map();
        for (let i = 0; i < this.game.players.length; i++) {
            this.game._slotControlled.set(i, this.game.players[i]);
        }

        // The AI update loop consumes the shared RNG in aiControllers order, so
        // that order must be identical on every peer (re-adding the default
        // human's AI above appended it out of order).
        this.game.aiControllers.sort((a, b) =>
            this.game.players.indexOf(a.player) - this.game.players.indexOf(b.player));

        this._ensureControls();

        // Client: receive confirmed inputs from host and add to lockstep buffer
        this.p2p.onConfirmedInputs = (cData) => {
            const tick = cData.tk;
            // Late duplicate for a tick we already executed — ignore, or it
            // would sit in the buffer forever.
            if (tick < this.game.tickCount) return;
            const inputs = cData.inputs;
            const confirmedMap = new Map();

            for (const inp of inputs) {
                confirmedMap.set(inp.pi, {
                    x: (inp.x || 0) / 100,
                    y: (inp.y || 0) / 100,
                    kick: !!inp.k,
                    chargeRatio: (inp.cr || 0) / 100,
                    pull: !!inp.pl,
                    switchPlayer: !!inp.sw
                });
            }

            this.game._lockstepInputBuffer.set(tick, confirmedMap);

            // Keep recent confirmed inputs so a checksum mismatch for a past
            // tick can rewind + replay (rollback) instead of going uncorrected.
            const hist = this.game._ciHistory;
            if (hist) {
                hist.set(tick, confirmedMap);
                while (hist.size > 240) {
                    hist.delete(hist.keys().next().value);
                }
            }
        };

        // Client: verify host checksums at the exact tick they were computed
        // for. Future ticks are buffered (verified when we reach them); past
        // ticks are compared against our own recorded hash and roll back on
        // mismatch — the guest often runs AHEAD of the host's execution
        // (confirmations outpace the host's frame loop), so "past" checksums
        // are the common case, not an anomaly.
        this.p2p.onChecksum = (csData) => {
            if (!this.game._pendingChecksums) return;
            if (csData.tk === this.game.tickCount) {
                this.game._verifyChecksum(csData);
            } else if (csData.tk > this.game.tickCount) {
                this.game._pendingChecksums.set(csData.tk, csData);
            } else {
                const mine = this.game._recentChecksums && this.game._recentChecksums.get(csData.tk);
                if (mine !== undefined && mine !== csData.h) {
                    console.warn(`Lockstep desync at past tick ${csData.tk} — rolling back`);
                    if (!this.game._rollbackToChecksum(csData)) {
                        console.error('Rollback impossible (confirmed-input history gap) — desync persists until next checksum');
                    }
                }
            }
        };

        // Guest-side unrecoverable stall: surface it — if the host is truly
        // gone, the hostLeft/disconnect path tears the match down.
        this.game._onLockstepStall = () => {
            this._showToast('Connection stalled — waiting for host…');
        };

        // Called once per EXECUTED tick (from the lockstep accumulator loop):
        // send local input to the host for tickCount + INPUT_DELAY.
        this.game._applyPeerInputs = () => {
            const game = this.game;
            const targetTick = game.tickCount + INPUT_DELAY;

            const localInput = this._packageLockstepInput();

            // Send to host
            this.p2p.sendLockstepInput(targetTick, myPlayerIdx, {
                x: localInput.x, y: localInput.y,
                kick: localInput.kick, chargeRatio: localInput.chargeRatio,
                pull: localInput.pull, switchPlayer: localInput.switchPlayer
            });
        };
    }

    _updateRoomSlots(slots, settings, isHost) {
        const redSlots = document.getElementById('red-slots');
        const blueSlots = document.getElementById('blue-slots');
        redSlots.innerHTML = '';
        blueSlots.innerHTML = '';

        for (const slot of slots) {
            const div = document.createElement('div');
            div.style.cssText = 'padding:6px 10px;border-radius:6px;font-size:14px;' +
                (slot.isHost ? 'border:1px solid #ffd700;' : 'border:1px solid rgba(255,255,255,0.1);') +
                'background:rgba(255,255,255,0.05);color:#fff;';
            div.textContent = (slot.isHost ? '\u2605 ' : '') + slot.name;

            if (slot.team === 'red') redSlots.appendChild(div);
            else blueSlots.appendChild(div);

            // All rooms are P2P rooms — the legacy this.network branch threw a
            // TypeError here for every joiner (swallowed upstream), leaving the
            // joiner's lobby half-rendered and _myTeam unset.
            const myId = this.p2p ? this.p2p.playerId : null;
            if (myId && slot.playerId === myId) {
                this._myTeam = slot.team;
            }
        }

        // Fill empty slots with "AI" placeholder
        const teamSize = settings.teamSize;
        const redCount = slots.filter(s => s.team === 'red').length;
        const blueCount = slots.filter(s => s.team === 'blue').length;
        for (let i = redCount; i < teamSize; i++) {
            const div = document.createElement('div');
            div.style.cssText = 'padding:6px 10px;border-radius:6px;font-size:14px;border:1px solid rgba(255,255,255,0.05);background:rgba(255,255,255,0.02);color:#555;';
            div.textContent = 'AI';
            redSlots.appendChild(div);
        }
        for (let i = blueCount; i < teamSize; i++) {
            const div = document.createElement('div');
            div.style.cssText = 'padding:6px 10px;border-radius:6px;font-size:14px;border:1px solid rgba(255,255,255,0.05);background:rgba(255,255,255,0.02);color:#555;';
            div.textContent = 'AI';
            blueSlots.appendChild(div);
        }

        // Show settings
        document.getElementById('room-settings-display').textContent =
            `${settings.teamSize}v${settings.teamSize} | ${settings.map} | ${settings.duration}s | Goal limit: ${settings.goalLimit || 'None'}`;

        // Start button and team size selector (host only)
        const startBtn = document.getElementById('btn-start-room');
        const teamSizeDiv = document.getElementById('room-team-size');
        if (isHost) {
            startBtn.classList.remove('hidden');
            teamSizeDiv.classList.remove('hidden');
            // Highlight active size
            document.querySelectorAll('.room-size-btn').forEach(btn => {
                btn.classList.toggle('active', parseInt(btn.dataset.roomSize) === settings.teamSize);
            });
        } else {
            startBtn.classList.add('hidden');
            teamSizeDiv.classList.add('hidden');
        }
    }

    startPractice() {
        this.game.settings.teamSize = 1;
        this.game.settings.duration = 9999;
        this.game.settings.goalLimit = 0;
        this.game.settings.powerups = false;
        this.game.settings.map = 'classic';
        this.game.practiceMode = true;
        this.game.isOnline = false;

        this.showScreen('game');
        document.getElementById('red-score').textContent = '0';
        document.getElementById('blue-score').textContent = '0';
        document.getElementById('timer').textContent = 'PRACTICE';

        this.game.startPractice();
        this._ensureControls();
    }

    startGame() {
        this.game.practiceMode = false;
        this.game.isOnline = false;
        this.showScreen('game');
        document.getElementById('red-score').textContent = '0';
        document.getElementById('blue-score').textContent = '0';

        const secs = this.game.settings.duration;
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        document.getElementById('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;

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
