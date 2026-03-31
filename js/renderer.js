// Rendering engine — performance-optimized (no shadowBlur, no per-frame gradients)
class Renderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.confetti = [];
        this.goalFlashTimer = 0;
        this.goalFlashTeam = null;
        // Net ripple state
        this.netRipple = { left: 0, right: 0 };
        this.netRippleHitY = { left: 0.5, right: 0.5 };
        this.screenShake = 0;
        this.hitFlashes = [];
        this._bgGrad = null; // cached background gradient
        this._bgH = 0;
        this.comboPopup = null;
        this.suddenDeathFlash = 0;
        this.dashTrails = [];
        this.resize();
    }

    resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        // On iOS WKWebView, window dimensions can be 0 during startup or orientation changes.
        // Fall back to document/screen dimensions, with a hard minimum to prevent zero-scale rendering.
        let w = window.innerWidth || document.documentElement.clientWidth || screen.width || 320;
        let h = window.innerHeight || document.documentElement.clientHeight || screen.height || 480;
        // Absolute minimum to prevent zero-scale canvas
        w = Math.max(w, 320);
        h = Math.max(h, 240);
        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
        this.ctx.scale(dpr, dpr);
        this.w = w;
        this.h = h;
        this._bgGrad = null; // invalidate cache
    }

    clear() {
        const ctx = this.ctx;
        ctx.save();
        if (this.screenShake > 0) {
            const intensity = this.screenShake * 6;
            const sx = (Math.random() - 0.5) * intensity;
            const sy = (Math.random() - 0.5) * intensity;
            ctx.translate(sx, sy);
            this.screenShake *= 0.85;
            if (this.screenShake < 0.01) this.screenShake = 0;
        }
        // Cached background gradient (only recreate on resize or map change)
        const mapType = this._currentMapType || 'classic';
        if (!this._bgGrad || this._bgH !== this.h || this._bgMap !== mapType) {
            this._bgGrad = ctx.createLinearGradient(0, 0, 0, this.h);
            if (mapType === 'ice') {
                this._bgGrad.addColorStop(0, '#0a1525');
                this._bgGrad.addColorStop(0.5, '#101e38');
                this._bgGrad.addColorStop(1, '#0a1525');
            } else if (mapType === 'volcano') {
                this._bgGrad.addColorStop(0, '#1a0a05');
                this._bgGrad.addColorStop(0.5, '#2a1008');
                this._bgGrad.addColorStop(1, '#1a0a05');
            } else if (mapType === 'neon') {
                this._bgGrad.addColorStop(0, '#020208');
                this._bgGrad.addColorStop(0.5, '#050510');
                this._bgGrad.addColorStop(1, '#020208');
            } else {
                this._bgGrad.addColorStop(0, '#0a0e27');
                this._bgGrad.addColorStop(0.5, '#121638');
                this._bgGrad.addColorStop(1, '#0a0e27');
            }
            this._bgH = this.h;
            this._bgMap = mapType;
        }
        ctx.fillStyle = this._bgGrad;
        ctx.fillRect(-10, -10, this.w + 20, this.h + 20);
    }

    endFrame() {
        this.ctx.restore();
    }

    triggerShake(intensity) {
        this.screenShake = Math.min(intensity, 1);
    }

    drawField(field) {
        const ctx = this.ctx;
        const mapType = field.mapType || 'classic';

        // Map-specific surface colors
        const mapThemes = {
            classic: { surface: 'rgba(20, 25, 60, 0.9)', grid: 'rgba(80, 120, 255, 0.06)', line: 'rgba(0, 229, 255, 0.7)', dot: '#00e5ff', redZone: 'rgba(233, 69, 96, 0.04)', blueZone: 'rgba(83, 216, 251, 0.04)' },
            big: { surface: 'rgba(20, 25, 60, 0.9)', grid: 'rgba(80, 120, 255, 0.06)', line: 'rgba(0, 229, 255, 0.7)', dot: '#00e5ff', redZone: 'rgba(233, 69, 96, 0.04)', blueZone: 'rgba(83, 216, 251, 0.04)' },
            futsal: { surface: 'rgba(20, 25, 60, 0.9)', grid: 'rgba(80, 120, 255, 0.06)', line: 'rgba(0, 229, 255, 0.7)', dot: '#00e5ff', redZone: 'rgba(233, 69, 96, 0.04)', blueZone: 'rgba(83, 216, 251, 0.04)' },
            ice: { surface: 'rgba(180, 220, 240, 0.15)', grid: 'rgba(200, 230, 255, 0.08)', line: 'rgba(100, 200, 255, 0.7)', dot: '#88ddff', redZone: 'rgba(233, 69, 96, 0.06)', blueZone: 'rgba(83, 216, 251, 0.06)' },
            volcano: { surface: 'rgba(60, 15, 10, 0.9)', grid: 'rgba(255, 80, 30, 0.06)', line: 'rgba(255, 100, 30, 0.7)', dot: '#ff6600', redZone: 'rgba(255, 100, 30, 0.05)', blueZone: 'rgba(255, 200, 50, 0.05)' },
            neon: { surface: 'rgba(5, 5, 20, 0.95)', grid: 'rgba(0, 255, 128, 0.08)', line: 'rgba(0, 255, 128, 0.8)', dot: '#00ff80', redZone: 'rgba(255, 0, 128, 0.06)', blueZone: 'rgba(0, 128, 255, 0.06)' },
        };
        const theme = mapThemes[mapType] || mapThemes.classic;

        // Dark playing surface
        ctx.fillStyle = theme.surface;
        ctx.fillRect(field.x, field.y, field.width, field.height);

        // Ice map: add shiny reflection streaks
        if (mapType === 'ice') {
            ctx.globalAlpha = 0.06;
            ctx.fillStyle = '#fff';
            for (let i = 0; i < 5; i++) {
                const rx = field.x + (field.width * (i * 0.22 + 0.05));
                ctx.fillRect(rx, field.y, 3, field.height);
            }
            ctx.globalAlpha = 1;
        }

        // Volcano map: lava cracks
        if (mapType === 'volcano') {
            const t = performance.now() * 0.001;
            ctx.strokeStyle = `rgba(255, 60, 0, ${0.08 + Math.sin(t) * 0.03})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            // Simple zigzag cracks
            const cx = field.x + field.width * 0.3;
            const cy = field.y + field.height * 0.2;
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + 30, cy + 40);
            ctx.lineTo(cx + 10, cy + 80);
            ctx.lineTo(cx + 40, cy + 120);
            ctx.stroke();
            ctx.beginPath();
            const cx2 = field.x + field.width * 0.7;
            const cy2 = field.y + field.height * 0.6;
            ctx.moveTo(cx2, cy2);
            ctx.lineTo(cx2 - 20, cy2 + 35);
            ctx.lineTo(cx2 + 15, cy2 + 70);
            ctx.stroke();
        }

        // Neon map: animated border glow
        if (mapType === 'neon') {
            const t = performance.now() * 0.003;
            const pulse = 0.3 + Math.sin(t) * 0.15;
            ctx.strokeStyle = `rgba(0, 255, 128, ${pulse})`;
            ctx.lineWidth = 4;
            ctx.strokeRect(field.x - 2, field.y - 2, field.width + 4, field.height + 4);
        }

        // Grid pattern — reduced density
        ctx.strokeStyle = theme.grid;
        ctx.lineWidth = 1;
        const gridSize = 40;
        ctx.beginPath();
        for (let gx = field.x; gx <= field.x + field.width; gx += gridSize) {
            ctx.moveTo(gx, field.y);
            ctx.lineTo(gx, field.y + field.height);
        }
        for (let gy = field.y; gy <= field.y + field.height; gy += gridSize) {
            ctx.moveTo(field.x, gy);
            ctx.lineTo(field.x + field.width, gy);
        }
        ctx.stroke(); // Single stroke call for entire grid

        // Field outline (no shadowBlur)
        ctx.strokeStyle = theme.line;
        ctx.lineWidth = 2;
        ctx.strokeRect(field.x, field.y, field.width, field.height);

        // Center line
        ctx.beginPath();
        ctx.moveTo(field.centerX, field.y);
        ctx.lineTo(field.centerX, field.y + field.height);
        ctx.stroke();

        // Center circle
        ctx.beginPath();
        ctx.arc(field.centerX, field.centerY, field.centerRadius, 0, Math.PI * 2);
        ctx.stroke();

        // Center dot
        ctx.fillStyle = theme.dot;
        ctx.beginPath();
        ctx.arc(field.centerX, field.centerY, 4, 0, Math.PI * 2);
        ctx.fill();

        // Penalty areas
        ctx.strokeStyle = theme.line;
        ctx.strokeRect(field.x, field.penaltyY, field.penaltyWidth, field.penaltyHeight);
        ctx.strokeRect(
            field.x + field.width - field.penaltyWidth,
            field.penaltyY,
            field.penaltyWidth,
            field.penaltyHeight
        );

        // Team zone tint (solid fills instead of gradient)
        ctx.fillStyle = theme.redZone;
        ctx.fillRect(field.x, field.y, field.width / 2, field.height);
        ctx.fillStyle = theme.blueZone;
        ctx.fillRect(field.centerX, field.y, field.width / 2, field.height);

        // Goals
        const goalDepth = field.goalDepth;
        const gTop = field.goalY;
        const gBot = field.goalY + field.goalHeight;
        const gHeight = field.goalHeight;
        const netSpacing = 16; // Wider spacing = fewer lines
        const netTime = Date.now() * 0.003;

        // Ball push for each goal
        const ballPushLeft = this.calcBallPush(this.trackedBall, field, 'left');
        const ballPushRight = this.calcBallPush(this.trackedBall, field, 'right');

        this.drawGoalNet(ctx, field.x, gTop, gBot, gHeight, goalDepth, netSpacing, netTime, 'left',
            'rgba(233,69,96,', '#e94560', this.netRipple.left, this.netRippleHitY.left, ballPushLeft);
        this.drawGoalNet(ctx, field.x + field.width, gTop, gBot, gHeight, goalDepth, netSpacing, netTime, 'right',
            'rgba(83,216,251,', '#53d8fb', this.netRipple.right, this.netRippleHitY.right, ballPushRight);
    }

    calcBallPush(ball, field, side) {
        if (!ball) return null;
        const gTop = field.goalY;
        const gBot = field.goalY + field.goalHeight;
        if (ball.y < gTop || ball.y > gBot) return null;

        if (side === 'left') {
            if (ball.x < field.x && ball.x > field.x - field.goalDepth) {
                const depth = (field.x - ball.x) / field.goalDepth;
                const normY = (ball.y - gTop) / field.goalHeight;
                return { depth, normY, speed: Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy) };
            }
        } else {
            if (ball.x > field.x + field.width && ball.x < field.x + field.width + field.goalDepth) {
                const depth = (ball.x - field.x - field.width) / field.goalDepth;
                const normY = (ball.y - gTop) / field.goalHeight;
                return { depth, normY, speed: Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy) };
            }
        }
        return null;
    }

    drawGoalNet(ctx, lineX, gTop, gBot, gHeight, goalDepth, netSpacing, time, side, rgba, solidColor, ripple, rippleHitY, ballPush) {
        const dir = side === 'left' ? -1 : 1;
        const backX = lineX + dir * goalDepth;

        // Dark background
        const bgX = side === 'left' ? lineX - goalDepth : lineX;
        ctx.fillStyle = side === 'left' ? 'rgba(30,10,15,0.65)' : 'rgba(10,15,30,0.65)';
        ctx.fillRect(bgX, gTop, goalDepth, gHeight);

        // Simplified net mesh — step size 6 instead of 3 for fewer points
        ctx.strokeStyle = rgba + '0.35)';
        ctx.lineWidth = 1;

        const step = 6; // Coarser iteration = fewer trig calls

        // Simplified wave: only apply when ripple or ball push active
        const hasRipple = ripple > 0;
        const hasPush = !!ballPush;
        const hasAnimation = hasRipple || hasPush;

        // Vertical net lines
        for (let i = 0; i <= goalDepth; i += netSpacing) {
            const depthRatio = i / goalDepth;
            ctx.beginPath();
            for (let y = gTop; y <= gBot; y += step) {
                const normY = (y - gTop) / gHeight;
                let wave = Math.sin(time + normY * 6) * 1.5 * depthRatio; // Single ambient wave

                if (hasRipple) {
                    const distFromHit = Math.abs(normY - rippleHitY);
                    const spread = Math.max(0, 1 - distFromHit * 1.8);
                    wave += Math.sin(time * 6 - distFromHit * 10) * ripple * 20 * depthRatio * spread;
                }

                if (hasPush) {
                    const distY = Math.abs(normY - ballPush.normY);
                    const influence = Math.max(0, 1 - distY * 3);
                    const pushStrength = ballPush.depth * influence * influence * 25;
                    const depthInfluence = Math.max(0, 1 - Math.abs(depthRatio - ballPush.depth) * 2);
                    wave += pushStrength * depthInfluence;
                }

                const px = lineX + dir * i + wave * dir;
                if (y === gTop) ctx.moveTo(px, y);
                else ctx.lineTo(px, y);
            }
            ctx.stroke();
        }

        // Horizontal net lines
        for (let j = gTop; j <= gBot; j += netSpacing) {
            const normY = (j - gTop) / gHeight;
            ctx.beginPath();
            for (let i = 0; i <= goalDepth; i += step) {
                const depthRatio = i / goalDepth;
                let wave = Math.sin(time + normY * 6) * 1.5 * depthRatio;

                if (hasRipple) {
                    const distFromHit = Math.abs(normY - rippleHitY);
                    const spread = Math.max(0, 1 - distFromHit * 1.8);
                    wave += Math.sin(time * 6 - distFromHit * 10) * ripple * 20 * depthRatio * spread;
                }

                if (hasPush) {
                    const distY = Math.abs(normY - ballPush.normY);
                    const influence = Math.max(0, 1 - distY * 3);
                    const pushStrength = ballPush.depth * influence * influence * 25;
                    const depthInfluence = Math.max(0, 1 - Math.abs(depthRatio - ballPush.depth) * 2);
                    wave += pushStrength * depthInfluence;
                }

                const px = lineX + dir * i;
                const py = j + wave;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }

        // Goal posts (no shadowBlur)
        ctx.strokeStyle = solidColor;
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(lineX, gTop);
        ctx.lineTo(backX, gTop);
        ctx.lineTo(backX, gBot);
        ctx.lineTo(lineX, gBot);
        ctx.stroke();

        // Inner white highlight
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(lineX, gTop);
        ctx.lineTo(backX, gTop);
        ctx.lineTo(backX, gBot);
        ctx.lineTo(lineX, gBot);
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'miter';

        // Post caps (simple circles, no shadow)
        ctx.fillStyle = solidColor;
        ctx.beginPath(); ctx.arc(lineX, gTop, 7, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(lineX, gBot, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(lineX, gTop, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(lineX, gBot, 3, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgba + '0.5)';
        ctx.beginPath(); ctx.arc(backX, gTop, 4, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(backX, gBot, 4, 0, Math.PI * 2); ctx.fill();
    }

    triggerNetRipple(side, ballY, field) {
        const normY = (ballY - field.goalY) / field.goalHeight;
        if (side === 'left') {
            this.netRipple.left = 1.0;
            this.netRippleHitY.left = Math.max(0, Math.min(1, normY));
        } else {
            this.netRipple.right = 1.0;
            this.netRippleHitY.right = Math.max(0, Math.min(1, normY));
        }
    }

    updateNetRipple(dt) {
        const decay = 0.002;
        if (this.netRipple.left > 0) this.netRipple.left = Math.max(0, this.netRipple.left - decay * dt);
        if (this.netRipple.right > 0) this.netRipple.right = Math.max(0, this.netRipple.right - decay * dt);
    }

    drawBall(ball) {
        const ctx = this.ctx;
        const isSuper = ball.superKick > 0;
        const isFire = ball.fireLevel > 0;
        const isBlue = ball.fireLevel >= 2;
        const ballSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);

        // Decay super kick
        if (isSuper && ballSpeed < 3) ball.superKick = 0;

        // Trail (circular buffer based — O(1) per frame)
        const trailPts = ball.getTrailPoints ? ball.getTrailPoints() : [];
        const trailLen = trailPts.length;
        if (trailLen > 0) {
            if ((isSuper || isFire) && ballSpeed > 2) {
                for (let i = 0; i < trailLen; i += 2) {
                    const alpha = 1 - (i >> 1) / (trailLen / 2);
                    if (alpha <= 0) continue;
                    if (isBlue) {
                        ctx.fillStyle = `rgba(${80 + (alpha * 80) | 0},${160 + (alpha * 60) | 0},255,${alpha * 0.7})`;
                    } else {
                        ctx.fillStyle = `rgba(255,${100 + (alpha * 120) | 0},${(alpha * 30) | 0},${alpha * 0.6})`;
                    }
                    ctx.beginPath();
                    ctx.arc(trailPts[i], trailPts[i + 1], ball.radius * alpha * 1.2, 0, Math.PI * 2);
                    ctx.fill();
                }

                ctx.globalAlpha = 0.25;
                ctx.fillStyle = isBlue ? '#4488ff' : '#ff8800';
                ctx.beginPath();
                ctx.arc(ball.x, ball.y, ball.radius * 2.5, 0, Math.PI * 2);
                ctx.fill();

                if (isBlue) {
                    const pulse = 0.15 + Math.sin(performance.now() * 0.01) * 0.1;
                    ctx.globalAlpha = pulse;
                    ctx.strokeStyle = '#88ccff';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(ball.x, ball.y, ball.radius * 3 + Math.sin(performance.now() * 0.008) * 4, 0, Math.PI * 2);
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
            } else {
                for (let i = 0; i < trailLen; i += 2) {
                    const alpha = 1 - (i >> 1) / (trailLen / 2);
                    if (alpha <= 0) continue;
                    ctx.fillStyle = `rgba(160,200,255,${alpha * 0.3})`;
                    ctx.beginPath();
                    ctx.arc(trailPts[i], trailPts[i + 1], ball.radius * alpha, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        // Ghost ball effect
        const isGhost = ball.ghost;
        if (isGhost) {
            ctx.globalAlpha = 0.35 + Math.sin(Date.now() * 0.005) * 0.15;
        }

        // Ball shadow
        ctx.fillStyle = isGhost ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(ball.x + 2, ball.y + 4, ball.radius * 0.9, ball.radius * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Ghost ball outer glow
        if (isGhost) {
            const ghostGlow = ctx.createRadialGradient(ball.x, ball.y, ball.radius * 0.5, ball.x, ball.y, ball.radius * 2.5);
            ghostGlow.addColorStop(0, 'rgba(200, 220, 255, 0.3)');
            ghostGlow.addColorStop(1, 'rgba(200, 220, 255, 0)');
            ctx.fillStyle = ghostGlow;
            ctx.beginPath();
            ctx.arc(ball.x, ball.y, ball.radius * 2.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // Ball body
        let ballColor = '#e0e8ff';
        if (isGhost) ballColor = '#c8d8ff';
        else if (isBlue && ballSpeed > 2) ballColor = '#aaddff';
        else if ((isSuper || isFire) && ballSpeed > 2) ballColor = '#ffdd44';
        ctx.fillStyle = ballColor;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
        ctx.fill();

        // Ghost dashed outline
        if (isGhost) {
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.arc(ball.x, ball.y, ball.radius + 1, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Ball highlight (cheap 3D effect — single arc, no gradient)
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.arc(ball.x - ball.radius * 0.25, ball.y - ball.radius * 0.25, ball.radius * 0.45, 0, Math.PI * 2);
        ctx.fill();

        if (isGhost) {
            ctx.globalAlpha = 1;
        }

        // Ball pattern (pentagon dots)
        ctx.fillStyle = 'rgba(100,130,255,0.3)';
        const spinSpeed = ball.spin ? ball.spin * 0.05 : 0;
        const angle = Date.now() * (0.002 + spinSpeed);
        for (let i = 0; i < 5; i++) {
            const a = angle + (i * Math.PI * 2) / 5;
            const px = ball.x + Math.cos(a) * ball.radius * 0.55;
            const py = ball.y + Math.sin(a) * ball.radius * 0.55;
            ctx.beginPath();
            ctx.arc(px, py, ball.radius * 0.22, 0, Math.PI * 2);
            ctx.fill();
        }

        // Ball outline
        ctx.strokeStyle = 'rgba(160,180,255,0.5)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
        ctx.stroke();
    }

    drawPlayer(player, isControlled = false) {
        const ctx = this.ctx;
        const baseColor = player.team === 'red' ? '#ff4d6d' : '#4dd4ff';
        const glowRGB = player.team === 'red' ? '255,77,109' : '77,212,255';

        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.ellipse(player.x + 2, player.y + 4, player.radius * 0.9, player.radius * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Power-up effects
        if (player.powerUp && player.powerUp !== 'frozen' && player.powerUp !== 'slowed') {
            const colors = { speed: '#4caf50', ghost: '#ffffff', shield: '#ffd700' };
            const color = colors[player.powerUp] || '#fff';
            const t = Date.now() * 0.003;

            if (player.powerUp === 'shield') {
                // Shield: golden hexagonal aura
                ctx.save();
                ctx.translate(player.x, player.y);
                ctx.rotate(t * 0.2);
                ctx.beginPath();
                const shieldR = player.radius + 6;
                for (let i = 0; i < 6; i++) {
                    const a = (i * Math.PI * 2) / 6;
                    if (i === 0) ctx.moveTo(Math.cos(a) * shieldR, Math.sin(a) * shieldR);
                    else ctx.lineTo(Math.cos(a) * shieldR, Math.sin(a) * shieldR);
                }
                ctx.closePath();
                ctx.strokeStyle = '#ffd700';
                ctx.lineWidth = 3;
                ctx.globalAlpha = 0.6 + Math.sin(t * 2) * 0.3;
                ctx.stroke();
                ctx.fillStyle = 'rgba(255, 215, 0, 0.1)';
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.restore();
            } else if (player.powerUp === 'ghost') {
                // Ghost: ethereal pulsing white aura with dashed ring
                ctx.globalAlpha = 0.4 + Math.sin(t * 2) * 0.2;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.setLineDash([3, 5]);
                ctx.beginPath();
                ctx.arc(player.x, player.y, player.radius + 6, t, t + Math.PI * 1.5);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.globalAlpha = 1;
            } else if (player.powerUp === 'speed') {
                // Speed: green streak lines trailing behind
                ctx.strokeStyle = '#4caf50';
                ctx.lineWidth = 2;
                ctx.globalAlpha = 0.5;
                for (let i = 0; i < 3; i++) {
                    const offset = (i + 1) * 5;
                    const trailX = player.x - (player.vx * offset * 0.3);
                    const trailY = player.y - (player.vy * offset * 0.3);
                    ctx.beginPath();
                    ctx.arc(trailX, trailY, player.radius - i * 3, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.globalAlpha *= 0.5;
                }
                ctx.globalAlpha = 1;
            } else {
                // Default: colored dashed ring
                ctx.strokeStyle = color;
                ctx.lineWidth = 3;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.arc(player.x, player.y, player.radius + 4, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }

        // Slowed effect: teal tint overlay
        if (player.powerUp === 'slowed') {
            ctx.fillStyle = 'rgba(0, 150, 136, 0.25)';
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 3, 0, Math.PI * 2);
            ctx.fill();
            // Slow wave rings
            const t = Date.now() * 0.002;
            ctx.strokeStyle = 'rgba(0, 150, 136, 0.3)';
            ctx.lineWidth = 1;
            const wavePhase = (t % 1);
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 3 + wavePhase * 8, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Stunned effect (simplified — just 4 dots orbiting)
        if (player.stunTimer > 0) {
            const t = Date.now() * 0.005;
            const stunAlpha = Math.min(player.stunTimer / 400, 1);
            ctx.fillStyle = `rgba(255, 221, 68, ${stunAlpha * 0.8})`;
            for (let i = 0; i < 4; i++) {
                const a = t + (i * Math.PI * 2) / 4;
                ctx.beginPath();
                ctx.arc(player.x + Math.cos(a) * (player.radius + 8),
                        player.y + Math.sin(a) * (player.radius + 8) * 0.5 - player.radius * 0.3,
                        3, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Frozen overlay
        if (player.powerUp === 'frozen') {
            ctx.fillStyle = 'rgba(0, 188, 212, 0.3)';
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 4, 0, Math.PI * 2);
            ctx.fill();
        }

        // Player body (solid color, no gradient)
        ctx.fillStyle = baseColor;
        ctx.beginPath();
        ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
        ctx.fill();

        // Momentum glow (simple circle)
        if (player.momentumBonus > 0.7) {
            const fireAlpha = (player.momentumBonus - 0.7) / 0.3;
            ctx.globalAlpha = fireAlpha * 0.3;
            ctx.fillStyle = baseColor;
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // Player outline
        ctx.strokeStyle = isControlled ? '#fff' : `rgba(${glowRGB},0.6)`;
        ctx.lineWidth = isControlled ? 3 : 1.5;
        ctx.beginPath();
        ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
        ctx.stroke();

        // Eyes
        const speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
        let lookX = 0, lookY = 0;
        if (speed > 0.3) {
            const n = Physics.normalize(player.vx, player.vy);
            lookX = n.x * 2;
            lookY = n.y * 2;
        }
        const eyeSpacing = player.radius * 0.3;
        const eyeY = player.y - player.radius * 0.15;
        const eyeSize = player.radius * 0.22;
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(player.x - eyeSpacing + lookX, eyeY + lookY, eyeSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(player.x + eyeSpacing + lookX, eyeY + lookY, eyeSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#111';
        const pupilSize = eyeSize * 0.55;
        ctx.beginPath();
        ctx.arc(player.x - eyeSpacing + lookX * 1.3, eyeY + lookY * 1.3, pupilSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(player.x + eyeSpacing + lookX * 1.3, eyeY + lookY * 1.3, pupilSize, 0, Math.PI * 2);
        ctx.fill();

        // Controlled player indicator (simple triangle, no shadow)
        if (isControlled) {
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.moveTo(player.x, player.y - player.radius - 12);
            ctx.lineTo(player.x - 6, player.y - player.radius - 5);
            ctx.lineTo(player.x + 6, player.y - player.radius - 5);
            ctx.closePath();
            ctx.fill();
        }

        // Kick range indicator
        if (isControlled && player.kickCooldown <= 0) {
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 16, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Charge ring
        if (isControlled && player.kickChargeRatio > 0) {
            this.drawChargeRing(player);
        }
    }

    drawChargeRing(player) {
        const ctx = this.ctx;
        const ratio = player.kickChargeRatio;
        const ringRadius = player.radius + 14;
        const lineWidth = 5;
        const startAngle = -Math.PI / 2;
        const endAngle = startAngle + Math.PI * 2 * ratio;

        // Background ring
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.arc(player.x, player.y, ringRadius, 0, Math.PI * 2);
        ctx.stroke();

        // Charge arc
        const teamColor = player.team === 'red' ? [233, 69, 96] : [83, 216, 251];
        const fullColor = [255, 255, 100];
        const r = Math.round(teamColor[0] + (fullColor[0] - teamColor[0]) * ratio);
        const g = Math.round(teamColor[1] + (fullColor[1] - teamColor[1]) * ratio);
        const b = Math.round(teamColor[2] + (fullColor[2] - teamColor[2]) * ratio);

        ctx.strokeStyle = `rgb(${r},${g},${b})`;
        ctx.lineWidth = lineWidth;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(player.x, player.y, ringRadius, startAngle, endAngle);
        ctx.stroke();
        ctx.lineCap = 'butt';

        // Tip dot
        const tipX = player.x + Math.cos(endAngle) * ringRadius;
        const tipY = player.y + Math.sin(endAngle) * ringRadius;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(tipX, tipY, 3, 0, Math.PI * 2);
        ctx.fill();

        // Fully charged: pulsing glow
        if (ratio > 0.8) {
            const pulse = 0.4 + Math.sin(performance.now() * 0.008) * 0.2;
            const glowRadius = player.radius + 20 + Math.sin(performance.now() * 0.006) * 4;
            ctx.strokeStyle = `rgba(255, 200, 50, ${pulse})`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(player.x, player.y, glowRadius, 0, Math.PI * 2);
            ctx.stroke();
        }
    }

    drawPullLink(player, ball, dist) {
        const ctx = this.ctx;
        const maxRange = 200;
        const alpha = 0.5 * Math.min(1, 1 - dist / maxRange);
        const teamRGB = player.team === 'red' ? '233,69,96' : '83,216,251';
        const t = performance.now() * 0.005;

        // Animated dashed line
        ctx.strokeStyle = `rgba(${teamRGB},${alpha})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -t * 8;
        ctx.beginPath();
        ctx.moveTo(player.x, player.y);
        ctx.lineTo(ball.x, ball.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Pulsing circle around player
        const pulse = 0.3 + Math.sin(t * 2) * 0.15;
        ctx.strokeStyle = `rgba(156,39,176,${pulse})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(player.x, player.y, player.radius + 10 + Math.sin(t * 3) * 3, 0, Math.PI * 2);
        ctx.stroke();

        // Small particles along the pull line (4 particles)
        for (let i = 0; i < 4; i++) {
            const frac = ((t * 0.3 + i * 0.25) % 1);
            const px = ball.x + (player.x - ball.x) * frac;
            const py = ball.y + (player.y - ball.y) * frac;
            ctx.fillStyle = `rgba(200,130,255,${0.6 * (1 - frac)})`;
            ctx.beginPath();
            ctx.arc(px, py, 2 + frac * 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    drawPullIndicator(player) {
        if (!player.pullActive && player.pullCooldown <= 0) return;
        const ctx = this.ctx;

        if (player.pullActive) {
            // Duration remaining indicator (arc around player)
            const ratio = player.pullDuration / player.pullMaxDuration;
            ctx.strokeStyle = 'rgba(156,39,176,0.6)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
            ctx.stroke();
        } else if (player.pullCooldown > 0) {
            // Cooldown indicator (dim arc)
            const ratio = 1 - player.pullCooldown / player.pullCooldownTime;
            ctx.strokeStyle = 'rgba(100,60,120,0.3)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ratio);
            ctx.stroke();
        }
    }

    spawnDashTrail(fromX, fromY, toX, toY, team) {
        this.dashTrails.push({
            fromX, fromY, toX, toY, team,
            life: 1.0,
        });
    }

    drawDashTrails() {
        const ctx = this.ctx;
        for (let i = this.dashTrails.length - 1; i >= 0; i--) {
            const t = this.dashTrails[i];
            t.life -= 0.04;
            if (t.life <= 0) { this.dashTrails.splice(i, 1); continue; }

            const color = t.team === 'red' ? '255,180,50' : '50,180,255';
            // Streak line
            ctx.globalAlpha = t.life * 0.7;
            ctx.strokeStyle = `rgba(${color},${t.life})`;
            ctx.lineWidth = 4 * t.life;
            ctx.beginPath();
            ctx.moveTo(t.fromX, t.fromY);
            ctx.lineTo(t.toX, t.toY);
            ctx.stroke();

            // Afterimage circles along path
            for (let j = 0; j < 4; j++) {
                const frac = j / 4;
                const px = t.fromX + (t.toX - t.fromX) * frac;
                const py = t.fromY + (t.toY - t.fromY) * frac;
                ctx.fillStyle = `rgba(${color},${t.life * 0.4 * (1 - frac)})`;
                ctx.beginPath();
                ctx.arc(px, py, 12 * t.life * (1 - frac * 0.5), 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
        }
    }

    spawnHitFlash(x, y, intensity) {
        const count = Math.floor(4 + intensity * 6); // Fewer particles
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1 + Math.random() * 3 * intensity;
            this.hitFlashes.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1.0,
                decay: 0.04 + Math.random() * 0.03,
                size: 2 + Math.random() * 3 * intensity,
                color: intensity > 0.5 ? '#ffdd44' : '#fff',
            });
        }
    }

    updateHitFlashes() {
        // Swap-and-pop removal
        let i = 0;
        while (i < this.hitFlashes.length) {
            const p = this.hitFlashes[i];
            p.x += p.vx;
            p.y += p.vy;
            p.vx *= 0.92;
            p.vy *= 0.92;
            p.life -= p.decay;
            if (p.life <= 0) {
                this.hitFlashes[i] = this.hitFlashes[this.hitFlashes.length - 1];
                this.hitFlashes.pop();
            } else {
                i++;
            }
        }
    }

    drawHitFlashes() {
        const ctx = this.ctx;
        for (let i = 0; i < this.hitFlashes.length; i++) {
            const p = this.hitFlashes[i];
            ctx.globalAlpha = p.life;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    drawKickoffBarrier(field, restrictedTeam) {
        const ctx = this.ctx;
        const cx = field.centerX;
        const cy = field.centerY;
        const cr = field.centerRadius;
        const time = performance.now() / 1000;

        const alpha = 0.3 + Math.sin(time * 4) * 0.15;
        const color = restrictedTeam === 'red'
            ? `rgba(233, 69, 96, ${alpha})`
            : `rgba(83, 216, 251, ${alpha})`;

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 6]);
        ctx.lineDashOffset = -time * 40;

        ctx.beginPath();
        ctx.moveTo(cx, field.y);
        ctx.lineTo(cx, cy - cr);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy + cr);
        ctx.lineTo(cx, field.y + field.height);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cx, cy, cr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Subtle zone fills
        const zoneAlpha = 0.04;
        const zoneColor = restrictedTeam === 'red'
            ? `rgba(233, 69, 96, ${zoneAlpha})`
            : `rgba(83, 216, 251, ${zoneAlpha})`;
        ctx.fillStyle = zoneColor;
        if (restrictedTeam === 'red') {
            ctx.fillRect(cx, field.y, field.width / 2, field.height);
        } else {
            ctx.fillRect(field.x, field.y, field.width / 2, field.height);
        }
    }

    drawKickoffBarrierLine(field, team) {
        const ctx = this.ctx;
        const cx = field.centerX;
        const cy = field.centerY;
        const cr = field.centerRadius;
        const time = performance.now() / 1000;

        const alpha = 0.2 + Math.sin(time * 4 + 1) * 0.1;
        const color = team === 'red'
            ? `rgba(233, 69, 96, ${alpha})`
            : `rgba(83, 216, 251, ${alpha})`;

        // Center line with gap for circle
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 8]);
        ctx.lineDashOffset = -time * 30;
        ctx.beginPath();
        ctx.moveTo(cx, field.y);
        ctx.lineTo(cx, cy - cr);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy + cr);
        ctx.lineTo(cx, field.y + field.height);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // --- Confetti system ---
    spawnConfetti(team) {
        const colors = team === 'red'
            ? ['#e94560', '#ff6b81', '#ff4757', '#ffa502', '#fff200', '#ffffff']
            : ['#53d8fb', '#70a1ff', '#1e90ff', '#ffa502', '#fff200', '#ffffff'];

        for (let i = 0; i < 80; i++) { // 80 instead of 120
            this.confetti.push({
                x: this.w / 2 + (Math.random() - 0.5) * 200,
                y: this.h / 2 - 50 + (Math.random() - 0.5) * 100,
                vx: (Math.random() - 0.5) * 12,
                vy: (Math.random() - 1) * 10 - 3,
                width: 4 + Math.random() * 8,
                height: 3 + Math.random() * 5,
                color: colors[Math.floor(Math.random() * colors.length)],
                rotation: Math.random() * Math.PI * 2,
                rotationSpeed: (Math.random() - 0.5) * 0.3,
                gravity: 0.12 + Math.random() * 0.08,
                life: 1.0,
                decay: 0.006 + Math.random() * 0.01,
            });
        }

        this.goalFlashTimer = 500;
        this.goalFlashTeam = team;
    }

    updateConfetti(dt) {
        if (this.goalFlashTimer > 0) {
            this.goalFlashTimer -= dt;
        }

        // Swap-and-pop removal
        let i = 0;
        while (i < this.confetti.length) {
            const c = this.confetti[i];
            c.vy += c.gravity;
            c.vx *= 0.99;
            c.x += c.vx;
            c.y += c.vy;
            c.rotation += c.rotationSpeed;
            c.life -= c.decay;

            if (c.life <= 0 || c.y > this.h + 20) {
                this.confetti[i] = this.confetti[this.confetti.length - 1];
                this.confetti.pop();
            } else {
                i++;
            }
        }
    }

    drawConfetti() {
        const ctx = this.ctx;
        // Goal flash is drawn in screen space by game.render() instead

        // setTransform instead of save/restore per particle
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (let i = 0; i < this.confetti.length; i++) {
            const c = this.confetti[i];
            ctx.globalAlpha = c.life;
            ctx.fillStyle = c.color;
            const cos = Math.cos(c.rotation);
            const sin = Math.sin(c.rotation);
            ctx.setTransform(cos * dpr, sin * dpr, -sin * dpr, cos * dpr, c.x * dpr, c.y * dpr);
            ctx.fillRect(-c.width / 2, -c.height / 2, c.width, c.height);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1;
    }

    // --- Combo popup system ---
    showComboPopup(text, team) {
        this.comboPopup = {
            text,
            team,
            timer: 0,
            maxTime: 2000,
        };
    }

    drawComboPopup() {
        if (!this.comboPopup) return;
        const ctx = this.ctx;
        const p = this.comboPopup;
        p.timer += 16.67; // Approximate frame time

        const progress = p.timer / p.maxTime;
        if (progress >= 1) { this.comboPopup = null; return; }

        // Scale: elastic pop-in then settle
        let scale;
        if (progress < 0.15) {
            scale = 1.5 + (1 - progress / 0.15) * 1.0; // Start big, settle
        } else {
            scale = 1.5;
        }

        // Fade out in last 40%
        const alpha = progress > 0.6 ? 1 - (progress - 0.6) / 0.4 : 1;

        const cx = this.w / 2;
        const cy = this.h * 0.35;
        const teamColor = p.team === 'red' ? '#ff4d6d' : '#4dd4ff';

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(cx, cy);
        ctx.scale(scale, scale);

        // Starburst rays behind text
        const rayCount = 10;
        const rayAngle = performance.now() * 0.001;
        ctx.strokeStyle = teamColor;
        ctx.lineWidth = 2;
        ctx.globalAlpha = alpha * 0.3;
        for (let i = 0; i < rayCount; i++) {
            const a = rayAngle + (i / rayCount) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * 30, Math.sin(a) * 30);
            ctx.lineTo(Math.cos(a) * 80, Math.sin(a) * 80);
            ctx.stroke();
        }
        ctx.globalAlpha = alpha;

        // Text
        ctx.font = 'bold 36px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = teamColor;
        ctx.lineWidth = 4;
        ctx.strokeText(p.text, 0, 0);
        ctx.fillStyle = '#fff';
        ctx.fillText(p.text, 0, 0);

        ctx.restore();
    }

    // --- Fire impact effect ---
    spawnFireImpact(x, y, level) {
        const color = level >= 2 ? '#88ccff' : '#ffaa33';
        const count = 8;
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2;
            const speed = 2 + Math.random() * 3;
            this.hitFlashes.push({
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                life: 1.0,
                decay: 0.03 + Math.random() * 0.02,
                size: 3 + Math.random() * 4,
                color,
            });
        }
    }

    // --- Sudden Death overlay ---
    showSuddenDeath() {
        this.suddenDeathFlash = 2000;
    }

    drawSuddenDeathOverlay(field, shrinkProgress) {
        const ctx = this.ctx;
        const maxShrink = 0.15;
        const s = shrinkProgress * maxShrink;
        const shrinkX = field.width * s;
        const shrinkY = field.height * s;

        // Pulsing danger zone borders
        const pulse = 0.15 + Math.sin(performance.now() * 0.004) * 0.1;
        ctx.fillStyle = `rgba(255, 50, 30, ${pulse})`;

        // Top danger zone
        ctx.fillRect(field.x, field.y, field.width, shrinkY);
        // Bottom danger zone
        ctx.fillRect(field.x, field.y + field.height - shrinkY, field.width, shrinkY);
        // Left danger zone
        ctx.fillRect(field.x, field.y, shrinkX, field.height);
        // Right danger zone
        ctx.fillRect(field.x + field.width - shrinkX, field.y, shrinkX, field.height);

        // Inner boundary line
        ctx.strokeStyle = `rgba(255, 100, 50, ${0.4 + pulse})`;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.lineDashOffset = -performance.now() * 0.02;
        ctx.strokeRect(
            field.x + shrinkX, field.y + shrinkY,
            field.width - shrinkX * 2, field.height - shrinkY * 2
        );
        ctx.setLineDash([]);
    }

    drawSuddenDeathHUD() {
        const ctx = this.ctx;
        if (this.suddenDeathFlash > 0) {
            this.suddenDeathFlash -= 16.67;
            const progress = this.suddenDeathFlash / 2000;

            // Flash overlay
            if (progress > 0.8) {
                ctx.fillStyle = `rgba(255, 30, 0, ${(progress - 0.8) * 1.5})`;
                ctx.fillRect(0, 0, this.w, this.h);
            }

            // Big text
            const textAlpha = progress > 0.3 ? 1 : progress / 0.3;
            const textScale = progress > 0.85 ? 1.5 + (progress - 0.85) * 3 : 1.5;
            ctx.save();
            ctx.globalAlpha = textAlpha;
            ctx.translate(this.w / 2, this.h * 0.4);
            ctx.scale(textScale, textScale);
            ctx.font = 'bold 32px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.strokeStyle = '#ff2200';
            ctx.lineWidth = 4;
            ctx.strokeText('SUDDEN DEATH', 0, 0);
            ctx.fillStyle = '#fff';
            ctx.fillText('SUDDEN DEATH', 0, 0);
            ctx.font = '16px sans-serif';
            ctx.fillText('Next goal wins!', 0, 28);
            ctx.restore();
        } else {
            // Persistent small label
            ctx.save();
            ctx.globalAlpha = 0.6 + Math.sin(performance.now() * 0.003) * 0.2;
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = '#ff4444';
            ctx.fillText('SUDDEN DEATH', this.w / 2, 18);
            ctx.restore();
        }
    }
}
