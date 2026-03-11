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

        document.addEventListener('keydown', (e) => {
            keys[e.key] = true;

            if (e.key === ' ' || e.key === 'x' || e.key === 'X') {
                if (!this.game.input.kickCharging) {
                    this.game.input.kickCharging = true;
                    this.game.input.kickChargeStart = performance.now();
                }
            }
            if (e.key === 'Shift' || e.key === 'z' || e.key === 'Z') {
                const now = performance.now();
                if (now - this.lastDashKeyTapTime < 300) {
                    // Double-tap: tackle
                    this.game.input.tackle = true;
                    this.game.input.dash = false;
                } else {
                    this.game.input.dash = true;
                }
                this.lastDashKeyTapTime = now;
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

            if (e.key === ' ' || e.key === 'x' || e.key === 'X') {
                if (this.game.input.kickCharging) {
                    const holdTime = performance.now() - this.game.input.kickChargeStart;
                    this.game.input.kickChargeTime = Math.min(holdTime, 1000);
                    this.game.input.kickCharging = false;
                    this.game.input.kickRelease = true;
                }
            }
        });

        // Keyboard movement polling
        const pollKeyboard = () => {
            let kx = 0, ky = 0;
            if (keys['ArrowLeft'] || keys['a'] || keys['A']) kx -= 1;
            if (keys['ArrowRight'] || keys['d'] || keys['D']) kx += 1;
            if (keys['ArrowUp'] || keys['w'] || keys['W']) ky -= 1;
            if (keys['ArrowDown'] || keys['s'] || keys['S']) ky += 1;

            // Only override if keyboard is being used
            if (kx !== 0 || ky !== 0) {
                const len = Math.sqrt(kx * kx + ky * ky);
                this.game.input.x = kx / len;
                this.game.input.y = ky / len;
            } else if (!this.joystickActive) {
                this.game.input.x = 0;
                this.game.input.y = 0;
            }

            requestAnimationFrame(pollKeyboard);
        };
        pollKeyboard();
    }
}
