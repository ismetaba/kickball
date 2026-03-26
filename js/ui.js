// UI management
class UI {
    constructor(game) {
        this.game = game;
        this.currentScreen = 'menu';

        this.setupMenuEvents();
        this.setupSettingsEvents();
        this.setupGameEvents();

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
        document.getElementById(`${name}-screen`).classList.add('active');
        this.currentScreen = name;
    }

    setupMenuEvents() {
        document.getElementById('btn-quick-match').addEventListener('click', () => {
            this.showScreen('match-settings');
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
            e.stopPropagation(); // don't trigger uiClick twice
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
            this.game.restart();
        });

        document.getElementById('btn-result-menu').addEventListener('click', () => {
            this.game.quit();
            document.getElementById('result-overlay').classList.add('hidden');
            this.showScreen('menu');
        });
    }

    startPractice() {
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
}
