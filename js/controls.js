// Touch and keyboard controls
class Controls {
    constructor(game) {
        this.game = game;
        this.joystickActive = false;
        this.joystickId = null;
        this.joystickBase = document.getElementById('joystick-base');
        this.joystickThumb = document.getElementById('joystick-thumb');
        this.joystickZone = document.getElementById('joystick-zone');

        this.baseX = 0;
        this.baseY = 0;

        // Double-tap tracking for tackle
        this.lastDashTapTime = 0;
        this.lastDashKeyTapTime = 0;

        this.setupTouch();
        this.setupKeyboard();
    }

    setupTouch() {
        const joystickZone = this.joystickZone;
        const kickBtn = document.getElementById('btn-kick');
        const dashBtn = document.getElementById('btn-dash');

        // Joystick
        joystickZone.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (this.joystickActive) return;

            const touch = e.changedTouches[0];
            this.joystickId = touch.identifier;
            this.joystickActive = true;

            const rect = this.joystickBase.getBoundingClientRect();
            this.baseX = rect.left + rect.width / 2;
            this.baseY = rect.top + rect.height / 2;

            this.updateJoystick(touch.clientX, touch.clientY);
        }, { passive: false });

        document.addEventListener('touchmove', (e) => {
            for (const touch of e.changedTouches) {
                if (touch.identifier === this.joystickId) {
                    e.preventDefault();
                    this.updateJoystick(touch.clientX, touch.clientY);
                }
            }
        }, { passive: false });

        document.addEventListener('touchend', (e) => {
            for (const touch of e.changedTouches) {
                if (touch.identifier === this.joystickId) {
                    this.joystickActive = false;
                    this.joystickId = null;
                    this.game.input.x = 0;
                    this.game.input.y = 0;
                    this.joystickThumb.style.transform = 'translate(0px, 0px)';
                }
            }
        });

        // Kick button (charged kick: hold to charge, release to kick)
        kickBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.game.input.kickCharging = true;
            this.game.input.kickChargeStart = performance.now();
            kickBtn.style.transform = 'scale(0.9)';
        }, { passive: false });

        kickBtn.addEventListener('touchend', (e) => {
            if (this.game.input.kickCharging) {
                const holdTime = performance.now() - this.game.input.kickChargeStart;
                this.game.input.kickChargeTime = Math.min(holdTime, 1000);
                this.game.input.kickCharging = false;
                this.game.input.kickRelease = true;
            }
            kickBtn.style.transform = '';
        });

        // Dash button (double-tap within 300ms triggers tackle instead)
        dashBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const now = performance.now();
            if (now - this.lastDashTapTime < 300) {
                // Double-tap: tackle
                this.game.input.tackle = true;
                this.game.input.dash = false;
            } else {
                this.game.input.dash = true;
            }
            this.lastDashTapTime = now;
            dashBtn.style.transform = 'scale(0.9)';
        }, { passive: false });

        dashBtn.addEventListener('touchend', (e) => {
            dashBtn.style.transform = '';
        });

        // Switch/Swap button
        const switchBtn = document.getElementById('btn-switch');
        switchBtn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            this.game.input.switchPlayer = true;
            switchBtn.style.transform = 'scale(0.9)';
        }, { passive: false });
        switchBtn.addEventListener('touchend', (e) => {
            switchBtn.style.transform = '';
        });

        // Prevent scrolling/zooming
        document.addEventListener('touchmove', (e) => {
            if (e.target.closest('#game-screen')) {
                e.preventDefault();
            }
        }, { passive: false });
    }

    updateJoystick(touchX, touchY) {
        const dx = touchX - this.baseX;
        const dy = touchY - this.baseY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const maxDist = 45;

        let clampedX = dx;
        let clampedY = dy;

        if (dist > maxDist) {
            clampedX = (dx / dist) * maxDist;
            clampedY = (dy / dist) * maxDist;
        }

        this.joystickThumb.style.transform = `translate(${clampedX}px, ${clampedY}px)`;

        // Normalize input to -1..1
        const inputDist = Math.min(dist, maxDist) / maxDist;
        if (inputDist > 0.1) { // Dead zone
            this.game.input.x = (dx / dist) * inputDist;
            this.game.input.y = (dy / dist) * inputDist;
        } else {
            this.game.input.x = 0;
            this.game.input.y = 0;
        }
    }

    setupKeyboard() {
        const keys = {};
        this.lastDashKeyTapTime2 = 0;

        document.addEventListener('keydown', (e) => {
            keys[e.key] = true;

            // Prevent arrow keys and space from scrolling
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
                e.preventDefault();
            }

            // --- Player 1: WASD + Space ---
            if (e.key === ' ') {
                if (!this.game.input.kickCharging) {
                    this.game.input.kickCharging = true;
                    this.game.input.kickChargeStart = performance.now();
                }
            }
            if (e.key === 'Shift') {
                const now = performance.now();
                if (now - this.lastDashKeyTapTime < 300) {
                    this.game.input.tackle = true;
                    this.game.input.dash = false;
                } else {
                    this.game.input.dash = true;
                }
                this.lastDashKeyTapTime = now;
            }
            if (e.key === 'q' || e.key === 'Q') {
                this.game.input.switchPlayer = true;
            }

            // --- Player 2: Arrow Keys + Enter/Numpad ---
            if (e.key === 'Enter') {
                if (!this.game.input2.kickCharging) {
                    this.game.input2.kickCharging = true;
                    this.game.input2.kickChargeStart = performance.now();
                }
            }
            if (e.key === '/' || e.key === 'NumpadDecimal') {
                const now = performance.now();
                if (now - this.lastDashKeyTapTime2 < 300) {
                    this.game.input2.tackle = true;
                    this.game.input2.dash = false;
                } else {
                    this.game.input2.dash = true;
                }
                this.lastDashKeyTapTime2 = now;
            }
            if (e.key === '.' || e.key === 'Numpad0') {
                this.game.input2.switchPlayer = true;
            }

            if (e.key === 'Escape') {
                if (this.game.isRunning && !this.game.matchOver) {
                    if (this.game.isPaused) this.game.resume();
                    else this.game.pause();
                }
            }
        });

        document.addEventListener('keyup', (e) => {
            keys[e.key] = false;

            // P1 kick release
            if (e.key === ' ') {
                if (this.game.input.kickCharging) {
                    const holdTime = performance.now() - this.game.input.kickChargeStart;
                    this.game.input.kickChargeTime = Math.min(holdTime, 1000);
                    this.game.input.kickCharging = false;
                    this.game.input.kickRelease = true;
                }
            }
            // P2 kick release
            if (e.key === 'Enter') {
                if (this.game.input2.kickCharging) {
                    const holdTime = performance.now() - this.game.input2.kickChargeStart;
                    this.game.input2.kickChargeTime = Math.min(holdTime, 1000);
                    this.game.input2.kickCharging = false;
                    this.game.input2.kickRelease = true;
                }
            }
        });

        // Keyboard movement polling
        const pollKeyboard = () => {
            // P1: WASD
            let kx = 0, ky = 0;
            if (keys['a'] || keys['A']) kx -= 1;
            if (keys['d'] || keys['D']) kx += 1;
            if (keys['w'] || keys['W']) ky -= 1;
            if (keys['s'] || keys['S']) ky += 1;

            if (kx !== 0 || ky !== 0) {
                const len = Math.sqrt(kx * kx + ky * ky);
                this.game.input.x = kx / len;
                this.game.input.y = ky / len;
            } else if (!this.joystickActive) {
                this.game.input.x = 0;
                this.game.input.y = 0;
            }

            // P2: Arrow keys
            let kx2 = 0, ky2 = 0;
            if (keys['ArrowLeft']) kx2 -= 1;
            if (keys['ArrowRight']) kx2 += 1;
            if (keys['ArrowUp']) ky2 -= 1;
            if (keys['ArrowDown']) ky2 += 1;

            if (kx2 !== 0 || ky2 !== 0) {
                const len = Math.sqrt(kx2 * kx2 + ky2 * ky2);
                this.game.input2.x = kx2 / len;
                this.game.input2.y = ky2 / len;
            } else {
                this.game.input2.x = 0;
                this.game.input2.y = 0;
            }

            requestAnimationFrame(pollKeyboard);
        };
        pollKeyboard();
    }
}
