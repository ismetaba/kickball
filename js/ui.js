// UI management
class UI {
    constructor(game) {
        this.game = game;
        this.currentScreen = 'menu';
        this.tournament = null;
        this.network = null;
        this.pingUpdateInterval = null;
        this.onlineSettings = {
            teamSize: 1,
            duration: 180,
            goalLimit: 5,
            difficulty: 'medium',
            powerups: true,
            map: 'classic',
        };

        this.setupMenuEvents();
        this.setupSettingsEvents();
        this.setupGameEvents();
        this.setupTournament();
        this.setupOnlineEvents();
    }

    showScreen(name) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(`${name}-screen`).classList.add('active');
        this.currentScreen = name;
    }

    setupMenuEvents() {
        document.getElementById('btn-quick-match').addEventListener('click', () => {
            this.showScreen('match-settings');
        });

        document.getElementById('btn-tournament').addEventListener('click', () => {
            this.generateTournamentBracket();
            this.showScreen('tournament');
        });

        document.getElementById('btn-practice').addEventListener('click', () => {
            this.startPractice();
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

                    // Update settings
                    if (btn.dataset.teamSize) this.game.settings.teamSize = parseInt(btn.dataset.teamSize);
                    if (btn.dataset.duration) this.game.settings.duration = parseInt(btn.dataset.duration);
                    if (btn.dataset.goals) this.game.settings.goalLimit = parseInt(btn.dataset.goals);
                    if (btn.dataset.difficulty) this.game.settings.difficulty = btn.dataset.difficulty;
                    if (btn.dataset.powerups) this.game.settings.powerups = btn.dataset.powerups === 'on';
                    if (btn.dataset.map) this.game.settings.map = btn.dataset.map;
                });
            });
        });

        document.getElementById('btn-back-menu').addEventListener('click', () => {
            this.showScreen('menu');
        });

        document.getElementById('btn-start-match').addEventListener('click', () => {
            this.startGame();
        });
    }

    setupGameEvents() {
        document.getElementById('btn-pause').addEventListener('click', () => {
            if (this.game.isPaused) this.game.resume();
            else this.game.pause();
        });

        document.getElementById('btn-resume').addEventListener('click', () => {
            this.game.resume();
        });

        document.getElementById('btn-restart').addEventListener('click', () => {
            this.game.restart();
        });

        document.getElementById('btn-quit').addEventListener('click', () => {
            if (this.game.isOnline) {
                this.game.quit();
                this.resetLobby();
                this.showScreen('menu');
                return;
            }
            this.game.quit();
            this.showScreen('menu');
        });

        document.getElementById('btn-rematch').addEventListener('click', () => {
            if (this.game.isOnline) {
                // No rematch in online — go back to menu
                this.game.quit();
                this.resetLobby();
                document.getElementById('result-overlay').classList.add('hidden');
                this.showScreen('menu');
                return;
            }
            if (this.tournament) {
                this.advanceTournament();
            } else {
                this.game.restart();
            }
        });

        document.getElementById('btn-result-menu').addEventListener('click', () => {
            if (this.game.isOnline) {
                this.game.quit();
                this.resetLobby();
                document.getElementById('result-overlay').classList.add('hidden');
                this.showScreen('menu');
                return;
            }
            this.game.quit();
            document.getElementById('result-overlay').classList.add('hidden');
            this.showScreen('menu');
        });
    }

    startPractice() {
        // Save current settings, apply practice settings
        this.game.settings.teamSize = 1;
        this.game.settings.duration = 9999;
        this.game.settings.goalLimit = 0;
        this.game.settings.powerups = false;
        this.game.settings.map = 'classic';
        this.game.practiceMode = true;

        this.showScreen('game');
        document.getElementById('red-score').textContent = '0';
        document.getElementById('blue-score').textContent = '0';
        document.getElementById('timer').textContent = 'PRACTICE';

        this.game.startPractice();

        if (!this.controls) {
            this.controls = new Controls(this.game);
        }
    }

    startGame() {
        this.game.practiceMode = false;
        this.showScreen('game');
        document.getElementById('red-score').textContent = '0';
        document.getElementById('blue-score').textContent = '0';

        const secs = this.game.settings.duration;
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        document.getElementById('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;

        this.game.startMatch();

        // Initialize controls if not yet
        if (!this.controls) {
            this.controls = new Controls(this.game);
        }
    }

    // ---- Tournament ----
    setupTournament() {
        document.getElementById('btn-back-from-tournament').addEventListener('click', () => {
            this.showScreen('menu');
        });

        document.getElementById('btn-start-tournament').addEventListener('click', () => {
            this.startTournamentMatch();
        });
    }

    generateTournamentBracket() {
        const teams = [
            'You', 'Thunderbolts', 'Storm FC', 'Phoenix',
            'Dragons', 'Wolves', 'Titans', 'Hawks'
        ];

        this.tournament = {
            teams: teams,
            rounds: [],
            currentRound: 0,
            currentMatch: 0,
        };

        // Quarterfinals
        const qf = [];
        for (let i = 0; i < teams.length; i += 2) {
            qf.push({ teamA: teams[i], teamB: teams[i + 1], winner: null });
        }
        this.tournament.rounds.push({ name: 'Quarterfinals', matches: qf });
        this.tournament.rounds.push({ name: 'Semifinals', matches: [] });
        this.tournament.rounds.push({ name: 'Final', matches: [] });

        this.renderBracket();
    }

    renderBracket() {
        const container = document.getElementById('tournament-bracket');
        container.innerHTML = '';

        for (const round of this.tournament.rounds) {
            const div = document.createElement('div');
            div.className = 'bracket-round';
            div.innerHTML = `<h3>${round.name}</h3>`;

            if (round.matches.length === 0) {
                div.innerHTML += '<p style="color:#555;font-size:13px;">TBD</p>';
            } else {
                for (let i = 0; i < round.matches.length; i++) {
                    const match = round.matches[i];
                    const isCurrent = this.tournament.rounds.indexOf(round) === this.tournament.currentRound
                        && i === this.tournament.currentMatch && !match.winner;
                    const isWon = match.winner !== null;

                    div.innerHTML += `
                        <div class="bracket-match ${isCurrent ? 'current' : ''} ${isWon ? 'won' : ''}">
                            <span class="bracket-team" style="${match.teamA === 'You' ? 'color:#e94560' : ''}">${match.teamA}</span>
                            <span class="bracket-vs">${match.winner ? (match.winner === match.teamA ? '2-0' : '0-2') : 'VS'}</span>
                            <span class="bracket-team" style="${match.teamB === 'You' ? 'color:#e94560' : ''}">${match.teamB}</span>
                        </div>
                    `;
                }
            }

            container.appendChild(div);
        }
    }

    startTournamentMatch() {
        const round = this.tournament.rounds[this.tournament.currentRound];
        if (!round || round.matches.length === 0) return;

        const match = round.matches[this.tournament.currentMatch];
        if (!match || match.winner) {
            // Auto-simulate non-player matches
            this.simulateRemainingMatches();
            return;
        }

        // Start the game
        this.game.settings.goalLimit = 3;
        this.game.settings.duration = 180;
        this.startGame();
    }

    simulateRemainingMatches() {
        const round = this.tournament.rounds[this.tournament.currentRound];

        for (const match of round.matches) {
            if (!match.winner && match.teamA !== 'You' && match.teamB !== 'You') {
                match.winner = Math.random() > 0.5 ? match.teamA : match.teamB;
            }
        }

        // Check if all matches in round are done
        if (round.matches.every(m => m.winner)) {
            this.setupNextRound();
        }

        this.renderBracket();
    }

    advanceTournament() {
        document.getElementById('result-overlay').classList.add('hidden');

        const round = this.tournament.rounds[this.tournament.currentRound];
        const match = round.matches[this.tournament.currentMatch];

        // Determine winner based on match result
        if (this.game.redScore > this.game.blueScore) {
            match.winner = match.teamA === 'You' ? 'You' : match.teamA;
        } else {
            match.winner = match.teamB === 'You' ? match.teamB : match.teamB;
        }

        this.game.quit();

        // Simulate other matches in this round
        this.simulateRemainingMatches();

        // Check if round is complete
        if (round.matches.every(m => m.winner)) {
            this.setupNextRound();
        }

        this.renderBracket();
        this.showScreen('tournament');
    }

    setupNextRound() {
        const currentRound = this.tournament.rounds[this.tournament.currentRound];
        const nextRoundIdx = this.tournament.currentRound + 1;

        if (nextRoundIdx >= this.tournament.rounds.length) {
            // Tournament over
            return;
        }

        const nextRound = this.tournament.rounds[nextRoundIdx];
        const winners = currentRound.matches.map(m => m.winner);

        nextRound.matches = [];
        for (let i = 0; i < winners.length; i += 2) {
            if (i + 1 < winners.length) {
                nextRound.matches.push({ teamA: winners[i], teamB: winners[i + 1], winner: null });
            }
        }

        this.tournament.currentRound = nextRoundIdx;
        this.tournament.currentMatch = nextRound.matches.findIndex(
            m => m.teamA === 'You' || m.teamB === 'You'
        );
        if (this.tournament.currentMatch === -1) this.tournament.currentMatch = 0;
    }

    // ---- Online Multiplayer ----
    setupOnlineEvents() {
        // Online 1v1 button from main menu
        document.getElementById('btn-online').addEventListener('click', () => {
            this.resetLobby();
            this.showScreen('online-lobby');
        });

        // Host game button
        document.getElementById('btn-host-game').addEventListener('click', () => {
            this.hostOnlineGame();
        });

        // Join game button
        document.getElementById('btn-join-game').addEventListener('click', () => {
            document.getElementById('lobby-choice').classList.add('hidden');
            document.getElementById('lobby-join').classList.remove('hidden');
            document.getElementById('room-code-input').focus();
        });

        // Connect button (join with code)
        document.getElementById('btn-connect').addEventListener('click', () => {
            const code = document.getElementById('room-code-input').value.trim().toUpperCase();
            if (code.length === 4) {
                this.joinOnlineGame(code);
            } else {
                document.getElementById('join-status').textContent = 'Enter a 4-character room code';
                document.getElementById('join-status').className = 'lobby-status error';
            }
        });

        // Room code input — auto-connect on 4 chars + Enter key
        document.getElementById('room-code-input').addEventListener('keyup', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('btn-connect').click();
            }
        });

        // Online settings toggles (host lobby)
        document.querySelectorAll('.online-opt').forEach(btn => {
            btn.addEventListener('click', () => {
                // Toggle active in same row
                const row = btn.closest('.option-row');
                row.querySelectorAll('.online-opt').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                // Update online settings
                if (btn.dataset.onlineTeamSize) this.onlineSettings.teamSize = parseInt(btn.dataset.onlineTeamSize);
                if (btn.dataset.onlineDuration) this.onlineSettings.duration = parseInt(btn.dataset.onlineDuration);
                if (btn.dataset.onlinePowerups) this.onlineSettings.powerups = btn.dataset.onlinePowerups === 'on';
            });
        });

        // Back from lobby
        document.getElementById('btn-back-lobby').addEventListener('click', () => {
            if (this.network) {
                this.network.destroy();
                this.network = null;
            }
            this.resetLobby();
            this.showScreen('menu');
        });

        // Disconnect overlay — back to menu
        document.getElementById('btn-disconnect-menu').addEventListener('click', () => {
            this.game.quit();
            this.resetLobby();
            document.getElementById('disconnect-overlay').classList.add('hidden');
            this.showScreen('menu');
        });
    }

    hostOnlineGame() {
        // Hide choice, show host panel
        document.getElementById('lobby-choice').classList.add('hidden');
        document.getElementById('lobby-host').classList.remove('hidden');

        // Create network manager
        this.network = new NetworkManager();

        // Status callback
        this.network.onStatusChange = (status, message) => {
            const statusEl = document.getElementById('host-status');
            statusEl.textContent = message;
            statusEl.className = 'lobby-status';
            if (status === 'connected') {
                statusEl.classList.add('connected');
                // Opponent connected — start match after brief delay
                document.getElementById('lobby-connected').classList.remove('hidden');
                document.getElementById('lobby-host').classList.add('hidden');
                setTimeout(() => {
                    this.startOnlineMatch(true);
                }, 1500);
            } else if (status === 'error') {
                statusEl.classList.add('error');
            }
        };

        // Host and get room code
        const code = this.network.hostGame();
        document.getElementById('room-code-display').textContent = code;
    }

    joinOnlineGame(code) {
        const statusEl = document.getElementById('join-status');
        statusEl.textContent = 'Connecting...';
        statusEl.className = 'lobby-status';

        this.network = new NetworkManager();

        this.network.onStatusChange = (status, message) => {
            statusEl.textContent = message;
            statusEl.className = 'lobby-status';
            if (status === 'connected') {
                statusEl.classList.add('connected');
                // Wait for host to send match start signal
                document.getElementById('lobby-join').classList.add('hidden');
                document.getElementById('lobby-connected').classList.remove('hidden');
            } else if (status === 'error') {
                statusEl.classList.add('error');
            }
        };

        // Listen for match start signal from host
        this.network.onMatchStart = (settings) => {
            this.onlineSettings = { ...settings };
            this.startOnlineMatch(false);
        };

        this.network.joinGame(code);
    }

    startOnlineMatch(isHost) {
        // Build match settings
        const settings = {
            teamSize: this.onlineSettings.teamSize,
            duration: this.onlineSettings.duration,
            goalLimit: this.onlineSettings.goalLimit,
            difficulty: this.onlineSettings.difficulty,
            powerups: this.onlineSettings.powerups,
            map: this.onlineSettings.map || 'classic',
        };

        // If host, send settings to guest
        if (isHost) {
            this.network.sendMatchStart(settings);
        }

        // Switch to game screen
        this.showScreen('game');
        document.getElementById('red-score').textContent = '0';
        document.getElementById('blue-score').textContent = '0';

        const secs = settings.duration;
        const m = Math.floor(secs / 60);
        const s = secs % 60;
        document.getElementById('timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;

        // Show online HUD
        document.getElementById('online-hud').classList.remove('hidden');

        // Start the online match in game engine
        this.game.startOnlineMatch(settings, this.network, isHost);

        // Initialize controls if not yet
        if (!this.controls) {
            this.controls = new Controls(this.game);
        }

        // Setup disconnect handler
        this.network.onDisconnect = () => {
            this.stopPingUpdate();
            document.getElementById('disconnect-overlay').classList.remove('hidden');
        };

        // Start ping display update
        this.startPingUpdate();
    }

    startPingUpdate() {
        this.pingUpdateInterval = setInterval(() => {
            if (this.network && this.network.isOnline) {
                const ping = this.network.latency;
                const pingEl = document.getElementById('online-ping');
                pingEl.textContent = ping + 'ms';

                const dot = document.getElementById('online-connection-dot');
                dot.className = '';
                if (ping > 200) {
                    dot.classList.add('disconnected');
                } else if (ping > 100) {
                    dot.classList.add('warning');
                }
            }
        }, 1000);
    }

    stopPingUpdate() {
        if (this.pingUpdateInterval) {
            clearInterval(this.pingUpdateInterval);
            this.pingUpdateInterval = null;
        }
    }

    resetLobby() {
        // Stop ping updates
        this.stopPingUpdate();

        // Destroy network if still active
        if (this.network) {
            this.network.destroy();
            this.network = null;
        }

        // Reset lobby UI
        document.getElementById('lobby-choice').classList.remove('hidden');
        document.getElementById('lobby-host').classList.add('hidden');
        document.getElementById('lobby-join').classList.add('hidden');
        document.getElementById('lobby-connected').classList.add('hidden');

        document.getElementById('room-code-display').textContent = '----';
        document.getElementById('host-status').textContent = 'Creating room...';
        document.getElementById('host-status').className = 'lobby-status';
        document.getElementById('room-code-input').value = '';
        document.getElementById('join-status').textContent = '';
        document.getElementById('join-status').className = 'lobby-status';

        // Hide online HUD
        document.getElementById('online-hud').classList.add('hidden');
    }
}
