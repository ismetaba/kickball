// UI management
class UI {
    constructor(game) {
        this.game = game;
        this.currentScreen = 'menu';
        this.tournament = null;

        this.setupMenuEvents();
        this.setupSettingsEvents();
        this.setupGameEvents();
        this.setupTournament();
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
            this.game.quit();
            this.showScreen('menu');
        });

        document.getElementById('btn-rematch').addEventListener('click', () => {
            if (this.tournament) {
                this.advanceTournament();
            } else {
                this.game.restart();
            }
        });

        document.getElementById('btn-result-menu').addEventListener('click', () => {
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
}
