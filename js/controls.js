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

        // Track attached listeners so we can detach cleanly
        this._listeners = [];
        this._rafId = null;

        this.setupTouch();
        this.setupKeyboard();
    }

    // Helper: attach and remember a listener for later removal
    _on(target, type, handler, opts) {
        target.addEventListener(type, handler, opts);
        this._listeners.push({ target, type, handler, opts });
    }

    // Clean up all attached listeners — call before discarding the instance
    destroy() {
        for (const { target, type, handler, opts } of this._listeners) {
            target.removeEventListener(type, handler, opts);
        }
        this._listeners.length = 0;
        if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    }

    setupTouch() {
        const joystickZone = this.joystickZone;
        const kickBtn = document.getElementById('btn-kick');

        // Dynamic joystick — base appears where you touch
        this._on(joystickZone, 'touchstart', (e) => {
            e.preventDefault();
            if (this.joystickActive) return;

            const touch = e.changedTouches[0];
            this.joystickId = touch.identifier;
            this.joystickActive = true;

            // Position joystick base centered on touch point
            this.baseX = touch.clientX;
            this.baseY = touch.clientY;
            this.joystickBase.style.left = (this.baseX - 60) + 'px';
            this.joystickBase.style.top = (this.baseY - 60) + 'px';
            this.joystickBase.classList.add('active');
            this.joystickThumb.style.transform = 'translate(0px, 0px)';
        }, { passive: false });

        this._on(document, 'touchmove', (e) => {
            for (const touch of e.changedTouches) {
                if (touch.identifier === this.joystickId) {
                    e.preventDefault();
                    this.updateJoystick(touch.clientX, touch.clientY);
                }
            }
        }, { passive: false });

        const releaseJoystick = (e) => {
            for (const touch of e.changedTouches) {
                if (touch.identifier === this.joystickId) {
                    this._resetJoystick();
                }
            }
        };
        this._on(document, 'touchend', releaseJoystick);
        this._on(document, 'touchcancel', releaseJoystick);

        // Kick button (charged kick: hold to charge, release to kick)
        this._on(kickBtn, 'touchstart', (e) => {
            e.preventDefault();
            this.game.input.kickCharging = true;
            this.game.input.kickChargeStart = performance.now();
            kickBtn.style.transform = 'scale(0.9)';
        }, { passive: false });

        const releaseKick = () => {
            if (this.game.input.kickCharging) {
                const holdTime = performance.now() - this.game.input.kickChargeStart;
                this.game.input.kickChargeTime = Math.min(holdTime, 1500);
                this.game.input.kickCharging = false;
                this.game.input.kickRelease = true;
            }
            kickBtn.style.transform = '';
        };
        this._on(kickBtn, 'touchend', releaseKick);
        // touchcancel: never skip releasing — otherwise kick stays "held" forever
        this._on(kickBtn, 'touchcancel', releaseKick);

        // Switch/Swap button
        const switchBtn = document.getElementById('btn-switch');
        this._on(switchBtn, 'touchstart', (e) => {
            e.preventDefault();
            this.game.input.switchPlayer = true;
            switchBtn.style.transform = 'scale(0.9)';
        }, { passive: false });
        const resetSwitchBtn = () => { switchBtn.style.transform = ''; };
        this._on(switchBtn, 'touchend', resetSwitchBtn);
        this._on(switchBtn, 'touchcancel', resetSwitchBtn);

        // Pull button (ball attract)
        const pullBtn = document.getElementById('btn-pull');
        if (pullBtn) {
            this._on(pullBtn, 'touchstart', (e) => {
                e.preventDefault();
                this.game.input.pull = true;
                pullBtn.style.transform = 'scale(0.9)';
            }, { passive: false });
            const releasePull = () => {
                this.game.input.pull = false;
                pullBtn.style.transform = '';
            };
            this._on(pullBtn, 'touchend', releasePull);
            this._on(pullBtn, 'touchcancel', releasePull);
        }

        // Zoom controls
        const zoomInBtn = document.getElementById('btn-zoom-in');
        const zoomOutBtn = document.getElementById('btn-zoom-out');
        if (zoomInBtn) {
            this._on(zoomInBtn, 'touchstart', (e) => {
                e.preventDefault();
                this.game.cameraZoom = Math.min(this.game.cameraZoom * 1.25, 4.0);
                this.game._updateFieldViewScale();
            }, { passive: false });
            // Desktop click fallback so zoom works on non-touch devices
            this._on(zoomInBtn, 'click', () => {
                this.game.cameraZoom = Math.min(this.game.cameraZoom * 1.25, 4.0);
                this.game._updateFieldViewScale();
            });
        }
        if (zoomOutBtn) {
            this._on(zoomOutBtn, 'touchstart', (e) => {
                e.preventDefault();
                this.game.cameraZoom = Math.max(this.game.cameraZoom / 1.25, 0.5);
                this.game._updateFieldViewScale();
            }, { passive: false });
            this._on(zoomOutBtn, 'click', () => {
                this.game.cameraZoom = Math.max(this.game.cameraZoom / 1.25, 0.5);
                this.game._updateFieldViewScale();
            });
        }

        // Prevent scrolling/zooming
        this._on(document, 'touchmove', (e) => {
            if (e.target.closest('#game-screen')) {
                e.preventDefault();
            }
        }, { passive: false });
    }

    _resetJoystick() {
        this.joystickActive = false;
        this.joystickId = null;
        this.game.input.x = 0;
        this.game.input.y = 0;
        if (this.joystickThumb) this.joystickThumb.style.transform = 'translate(0px, 0px)';
        if (this.joystickBase) this.joystickBase.classList.remove('active');
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
        this._keys = keys; // expose for clearing

        // Clear all input when window loses focus to prevent stuck movement
        const clearAllInput = () => {
            for (const k in keys) keys[k] = false;
            this.game.input.x = 0;
            this.game.input.y = 0;
            this.game.input.kickCharging = false;
            this.game.input.pull = false;
            this.game.input2.x = 0;
            this.game.input2.y = 0;
            this.game.input2.kickCharging = false;
            this.game.input2.pull = false;
            // Also reset joystick in case touchcancel was missed
            if (this.joystickActive) this._resetJoystick();
        };
        this._on(window, 'blur', clearAllInput);
        this._on(document, 'visibilitychange', () => {
            if (document.hidden) clearAllInput();
        });

        this._on(document, 'keydown', (e) => {
            // Normalize letter keys to lowercase to prevent stuck keys
            // when CapsLock or Shift state changes between keydown/keyup
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            if (keys[key]) return; // Ignore key repeat
            keys[key] = true;

            // Prevent arrow keys and space from scrolling
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(key)) {
                e.preventDefault();
            }

            // --- Player 1: WASD + Space ---
            if (key === ' ') {
                if (!this.game.input.kickCharging) {
                    this.game.input.kickCharging = true;
                    this.game.input.kickChargeStart = performance.now();
                }
            }
            if (key === 'q') {
                this.game.input.switchPlayer = true;
            }
            if (key === 'e') {
                this.game.input.pull = true;
            }

            // --- Player 2: Arrow Keys + Enter/Numpad ---
            if (key === 'Enter') {
                if (!this.game.input2.kickCharging) {
                    this.game.input2.kickCharging = true;
                    this.game.input2.kickChargeStart = performance.now();
                }
            }
            if (key === '.' || key === 'Numpad0') {
                this.game.input2.switchPlayer = true;
            }
            if (key === 'Shift') {
                this.game.input2.pull = true;
            }

            if (key === 'Escape') {
                if (this.game.isRunning && !this.game.matchOver) {
                    if (this.game.isPaused) this.game.resume();
                    else this.game.pause();
                }
            }
        });

        this._on(document, 'keyup', (e) => {
            const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
            keys[key] = false;

            // P1 kick release
            if (key === ' ') {
                if (this.game.input.kickCharging) {
                    const holdTime = performance.now() - this.game.input.kickChargeStart;
                    this.game.input.kickChargeTime = Math.min(holdTime, 1500);
                    this.game.input.kickCharging = false;
                    this.game.input.kickRelease = true;
                }
            }
            // P1 pull release
            if (key === 'e') {
                this.game.input.pull = false;
            }
            // P2 pull release
            if (key === 'Shift') {
                this.game.input2.pull = false;
            }
            // P2 kick release
            if (key === 'Enter') {
                if (this.game.input2.kickCharging) {
                    const holdTime = performance.now() - this.game.input2.kickChargeStart;
                    this.game.input2.kickChargeTime = Math.min(holdTime, 1500);
                    this.game.input2.kickCharging = false;
                    this.game.input2.kickRelease = true;
                }
            }
        });

        // Keyboard movement polling
        const pollKeyboard = () => {
            // P1: WASD (always lowercase — normalized in keydown/keyup)
            let kx = 0, ky = 0;
            if (keys['a']) kx -= 1;
            if (keys['d']) kx += 1;
            if (keys['w']) ky -= 1;
            if (keys['s']) ky += 1;

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

            this._rafId = requestAnimationFrame(pollKeyboard);
        };
        pollKeyboard();
    }
}
