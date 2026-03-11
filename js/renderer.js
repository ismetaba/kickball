// Rendering engine
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
        this.resize();
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = window.innerWidth * dpr;
        this.canvas.height = window.innerHeight * dpr;
        this.ctx.scale(dpr, dpr);
        this.w = window.innerWidth;
        this.h = window.innerHeight;
    }

    clear() {
        this.ctx.save();
        if (this.screenShake > 0) {
            const intensity = this.screenShake * 6;
            const sx = (Math.random() - 0.5) * intensity;
            const sy = (Math.random() - 0.5) * intensity;
            this.ctx.translate(sx, sy);
            this.screenShake *= 0.85;
            if (this.screenShake < 0.01) this.screenShake = 0;
        }
        // Neon arcade background
        const grad = this.ctx.createLinearGradient(0, 0, 0, this.h);
        grad.addColorStop(0, '#0a0e27');
        grad.addColorStop(0.5, '#121638');
        grad.addColorStop(1, '#0a0e27');
        this.ctx.fillStyle = grad;
        this.ctx.fillRect(-10, -10, this.w + 20, this.h + 20);
    }

    endFrame() {
        this.ctx.restore();
    }

    triggerShake(intensity) {
        this.screenShake = Math.min(intensity, 1);
    }

    drawField(field) {
        const ctx = this.ctx;
        const time = Date.now() * 0.001;

        // Dark playing surface with subtle grid
        ctx.fillStyle = 'rgba(20, 25, 60, 0.9)';
        ctx.fillRect(field.x, field.y, field.width, field.height);

        // Animated grid pattern
        ctx.strokeStyle = 'rgba(80, 120, 255, 0.06)';
        ctx.lineWidth = 1;
        const gridSize = 40;
        for (let gx = field.x; gx <= field.x + field.width; gx += gridSize) {
            ctx.beginPath();
            ctx.moveTo(gx, field.y);
            ctx.lineTo(gx, field.y + field.height);
            ctx.stroke();
        }
        for (let gy = field.y; gy <= field.y + field.height; gy += gridSize) {
            ctx.beginPath();
            ctx.moveTo(field.x, gy);
            ctx.lineTo(field.x + field.width, gy);
            ctx.stroke();
        }

        // Neon field outline with glow
        ctx.shadowColor = '#00e5ff';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.7)';
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

        // Center dot - pulsing
        const pulse = 4 + Math.sin(time * 3) * 1.5;
        ctx.shadowBlur = 20;
        ctx.fillStyle = '#00e5ff';
        ctx.beginPath();
        ctx.arc(field.centerX, field.centerY, pulse, 0, Math.PI * 2);
        ctx.fill();

        // Penalty areas
        ctx.strokeRect(field.x, field.penaltyY, field.penaltyWidth, field.penaltyHeight);
        ctx.strokeRect(
            field.x + field.width - field.penaltyWidth,
            field.penaltyY,
            field.penaltyWidth,
            field.penaltyHeight
        );

        // Team zone gradients (subtle colored fog on each half)
        const redZone = ctx.createLinearGradient(field.x, 0, field.centerX, 0);
        redZone.addColorStop(0, 'rgba(233, 69, 96, 0.06)');
        redZone.addColorStop(1, 'transparent');
        ctx.fillStyle = redZone;
        ctx.fillRect(field.x, field.y, field.width / 2, field.height);

        const blueZone = ctx.createLinearGradient(field.centerX, 0, field.x + field.width, 0);
        blueZone.addColorStop(0, 'transparent');
        blueZone.addColorStop(1, 'rgba(83, 216, 251, 0.06)');
        ctx.fillStyle = blueZone;
        ctx.fillRect(field.centerX, field.y, field.width / 2, field.height);

        ctx.shadowBlur = 0;

        // Goals
        const goalDepth = field.goalDepth;
        const gTop = field.goalY;
        const gBot = field.goalY + field.goalHeight;
        const gHeight = field.goalHeight;
        const netSpacing = 12;
        const netTime = Date.now() * 0.003;

        // Calculate ball push for each goal (dynamic net deformation)
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
                const depth = (field.x - ball.x) / field.goalDepth; // 0..1 how deep
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

        // Gradient overlay
        const grad = ctx.createLinearGradient(backX, 0, lineX, 0);
        grad.addColorStop(0, rgba + '0.3)');
        grad.addColorStop(1, rgba + '0.02)');
        ctx.fillStyle = grad;
        ctx.fillRect(bgX, gTop, goalDepth, gHeight);

        // Net mesh with dynamic deformation
        ctx.strokeStyle = rgba + '0.4)';
        ctx.lineWidth = 1;

        // Helper: calculate elastic wave offset at a given point
        const getWave = (normY, depthRatio) => {
            // Gentle ambient sway (always alive)
            let wave = Math.sin(time * 1.2 + normY * 6) * 2.0 * depthRatio;
            wave += Math.sin(time * 0.8 + normY * 10 + depthRatio * 4) * 1.5 * depthRatio;
            wave += Math.cos(time * 0.5 + depthRatio * 8) * 1.0 * depthRatio;

            // Goal ripple from scoring — elastic bounce back
            if (ripple > 0) {
                const distFromHit = Math.abs(normY - rippleHitY);
                const spread = Math.max(0, 1 - distFromHit * 1.8);
                // Multiple bounce frequencies for elastic feel
                const bounce1 = Math.sin(time * 6 - distFromHit * 10) * ripple * 25 * depthRatio;
                const bounce2 = Math.sin(time * 9 - distFromHit * 15) * ripple * 10 * depthRatio;
                wave += (bounce1 + bounce2) * spread;
            }

            // Ball push: elastic bulge around ball — stretches the net like rubber
            if (ballPush) {
                const distY = Math.abs(normY - ballPush.normY);
                const influence = Math.max(0, 1 - distY * 3); // Wider falloff
                const elasticStretch = influence * influence; // Quadratic for elastic curve
                const pushStrength = ballPush.depth * elasticStretch * 30;
                const depthInfluence = Math.max(0, 1 - Math.abs(depthRatio - ballPush.depth) * 2);
                const speedBoost = Math.min(ballPush.speed * 0.15, 2);
                wave += pushStrength * depthInfluence * (0.6 + speedBoost);
                // Add wobble around the push point
                wave += Math.sin(time * 8 + normY * 20) * elasticStretch * ballPush.depth * 4 * depthRatio;
            }

            return wave;
        };

        // Vertical net lines
        for (let i = 0; i <= goalDepth; i += netSpacing) {
            const depthRatio = i / goalDepth;
            ctx.beginPath();
            for (let y = gTop; y <= gBot; y += 3) {
                const normY = (y - gTop) / gHeight;
                const wave = getWave(normY, depthRatio);
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
            for (let i = 0; i <= goalDepth; i += 3) {
                const depthRatio = i / goalDepth;
                const wave = getWave(normY, depthRatio);
                const px = lineX + dir * i;
                const py = j + wave;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.stroke();
        }

        // Goal posts with neon glow
        ctx.shadowColor = solidColor;
        ctx.shadowBlur = 15;
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
        ctx.shadowBlur = 0;
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

        // Post caps (neon circles)
        ctx.shadowColor = solidColor;
        ctx.shadowBlur = 12;
        ctx.fillStyle = solidColor;
        ctx.beginPath(); ctx.arc(lineX, gTop, 7, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(lineX, gBot, 7, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        // White center on caps
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(lineX, gTop, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(lineX, gBot, 3, 0, Math.PI * 2); ctx.fill();
        // Back corner caps
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
        const ballSpeed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);

        // Decay super kick
        if (isSuper && ballSpeed < 3) ball.superKick = 0;

        // Fire trail for super kick
        if (isSuper && ballSpeed > 2) {
            for (const t of ball.trail) {
                const fireR = Math.floor(255);
                const fireG = Math.floor(100 + t.life * 120);
                const fireB = Math.floor(t.life * 30);
                ctx.fillStyle = `rgba(${fireR},${fireG},${fireB},${t.life * 0.7})`;
                ctx.beginPath();
                ctx.arc(t.x, t.y, ball.radius * t.life * 1.3, 0, Math.PI * 2);
                ctx.fill();
            }

            // Outer fire glow
            const glowSize = ball.radius * 2.5 + Math.sin(Date.now() * 0.02) * 4;
            const fireGlow = ctx.createRadialGradient(ball.x, ball.y, ball.radius * 0.5, ball.x, ball.y, glowSize);
            fireGlow.addColorStop(0, 'rgba(255,200,50,0.4)');
            fireGlow.addColorStop(0.5, 'rgba(255,100,20,0.2)');
            fireGlow.addColorStop(1, 'transparent');
            ctx.fillStyle = fireGlow;
            ctx.beginPath();
            ctx.arc(ball.x, ball.y, glowSize, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Normal trail - neon blue-white
            for (const t of ball.trail) {
                ctx.fillStyle = `rgba(160,200,255,${t.life * 0.35})`;
                ctx.beginPath();
                ctx.arc(t.x, t.y, ball.radius * t.life, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Neon glow under ball
        ctx.shadowColor = isSuper ? '#ff8800' : '#ffffff';
        ctx.shadowBlur = isSuper ? 25 : 15;

        // Ball body
        if (isSuper && ballSpeed > 2) {
            const ballGrad = ctx.createRadialGradient(ball.x - 3, ball.y - 3, 0, ball.x, ball.y, ball.radius);
            ballGrad.addColorStop(0, '#fff');
            ballGrad.addColorStop(0.4, '#ffdd44');
            ballGrad.addColorStop(1, '#ff6600');
            ctx.fillStyle = ballGrad;
        } else {
            const ballGrad = ctx.createRadialGradient(ball.x - 2, ball.y - 2, 0, ball.x, ball.y, ball.radius);
            ballGrad.addColorStop(0, '#ffffff');
            ballGrad.addColorStop(0.7, '#e0e8ff');
            ballGrad.addColorStop(1, '#a0b0ff');
            ctx.fillStyle = ballGrad;
        }
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
        ctx.fill();

        // Ball pattern (pentagon style) - rotates faster with spin
        ctx.shadowBlur = 0;
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

        // Ball outline - neon ring
        ctx.strokeStyle = 'rgba(160,180,255,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
        ctx.stroke();
    }

    drawPlayer(player, isControlled = false) {
        const ctx = this.ctx;

        // Shadow (softer on dark background)
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.beginPath();
        ctx.ellipse(player.x + 2, player.y + 4, player.radius * 0.9, player.radius * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();

        // Dash effect
        if (player.isDashing) {
            ctx.strokeStyle = player.team === 'red' ? 'rgba(233,69,96,0.5)' : 'rgba(83,216,251,0.5)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 6, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Tackle slide effect: stretched ellipse trail behind player
        if (player.isTackling) {
            const trailColor = player.team === 'red' ? 'rgba(233,69,96,0.35)' : 'rgba(83,216,251,0.35)';
            const trailX = player.x - player.tackleDirX * player.radius * 1.5;
            const trailY = player.y - player.tackleDirY * player.radius * 1.5;
            const slideAngle = Math.atan2(player.tackleDirY, player.tackleDirX);

            ctx.fillStyle = trailColor;
            ctx.beginPath();
            ctx.ellipse(trailX, trailY, player.radius * 1.8, player.radius * 0.5, slideAngle, 0, Math.PI * 2);
            ctx.fill();

            // Dust particles
            const dustColor = 'rgba(180,160,120,0.3)';
            ctx.fillStyle = dustColor;
            for (let i = 0; i < 3; i++) {
                const offset = (i + 1) * 0.6;
                const dx = player.x - player.tackleDirX * player.radius * offset;
                const dy = player.y - player.tackleDirY * player.radius * offset;
                const jx = (Math.random() - 0.5) * 8;
                const jy = (Math.random() - 0.5) * 8;
                ctx.beginPath();
                ctx.arc(dx + jx, dy + jy, 3 + Math.random() * 3, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Power-up glow
        if (player.powerUp && player.powerUp !== 'frozen') {
            const colors = {
                speed: '#4caf50',
                power: '#ff9800',
                curve: '#9c27b0',
                big: '#2196f3',
                magnet: '#e91e63',
            };
            const glowColor = colors[player.powerUp] || '#fff';
            ctx.strokeStyle = glowColor;
            ctx.lineWidth = 3;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 4, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Stunned effect (orbiting neon sparks + wobble)
        if (player.stunTimer > 0) {
            const time = Date.now() * 0.005;
            const orbitDist = player.radius + 8;
            const stunRatio = Math.min(player.stunTimer / 400, 1); // fade out near end

            // Orbiting sparks
            for (let i = 0; i < 4; i++) {
                const a = time + (i * Math.PI * 2) / 4;
                const sx = player.x + Math.cos(a) * orbitDist;
                const sy = player.y + Math.sin(a) * orbitDist * 0.5 - player.radius * 0.3;
                const sparkSize = 3 + Math.sin(time * 3 + i) * 1;

                ctx.shadowColor = '#ffdd44';
                ctx.shadowBlur = 8;
                ctx.fillStyle = `rgba(255, 221, 68, ${stunRatio * 0.9})`;
                ctx.beginPath();
                ctx.arc(sx, sy, sparkSize, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.shadowBlur = 0;

            // Darkened overlay with slight pulse
            const overlayAlpha = 0.2 + Math.sin(time * 4) * 0.08;
            ctx.fillStyle = `rgba(0,0,0,${overlayAlpha * stunRatio})`;
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 2, 0, Math.PI * 2);
            ctx.fill();
        }

        // Frozen effect
        if (player.powerUp === 'frozen') {
            ctx.fillStyle = 'rgba(0, 188, 212, 0.3)';
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 4, 0, Math.PI * 2);
            ctx.fill();
        }

        // Player body with neon glow
        const baseColor = player.team === 'red' ? '#ff4d6d' : '#4dd4ff';
        const darkColor = player.team === 'red' ? '#cc2244' : '#2299cc';
        const glowRGB = player.team === 'red' ? '255,77,109' : '77,212,255';

        // Outer neon glow
        ctx.shadowColor = baseColor;
        ctx.shadowBlur = isControlled ? 20 : 10;

        const gradient = ctx.createRadialGradient(
            player.x - 3, player.y - 3, 0,
            player.x, player.y, player.radius
        );
        gradient.addColorStop(0, '#fff');
        gradient.addColorStop(0.3, baseColor);
        gradient.addColorStop(1, darkColor);

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Momentum fire glow effect
        if (player.momentumBonus > 0.7) {
            const fireAlpha = (player.momentumBonus - 0.7) / 0.3;
            const fireRadius = player.radius + 8 + Math.sin(Date.now() * 0.01) * 3;
            const teamFireColor = player.team === 'red' ? '255,77,109' : '77,212,255';
            const fireGrad = ctx.createRadialGradient(player.x, player.y, player.radius * 0.8, player.x, player.y, fireRadius);
            fireGrad.addColorStop(0, `rgba(${teamFireColor},${fireAlpha * 0.4})`);
            fireGrad.addColorStop(0.6, `rgba(255,200,50,${fireAlpha * 0.2})`);
            fireGrad.addColorStop(1, 'transparent');
            ctx.fillStyle = fireGrad;
            ctx.beginPath();
            ctx.arc(player.x, player.y, fireRadius, 0, Math.PI * 2);
            ctx.fill();
        }

        // Player outline
        ctx.strokeStyle = isControlled ? '#fff' : `rgba(${glowRGB},0.6)`;
        ctx.lineWidth = isControlled ? 3 : 1.5;
        ctx.beginPath();
        ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
        ctx.stroke();

        // Face - eyes that look toward movement direction
        const speed = Math.sqrt(player.vx * player.vx + player.vy * player.vy);
        let lookX = 0, lookY = 0;
        if (speed > 0.3) {
            const n = Physics.normalize(player.vx, player.vy);
            lookX = n.x * 2;
            lookY = n.y * 2;
        }
        // Eye whites
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
        // Pupils
        const pupilSize = eyeSize * 0.55;
        ctx.fillStyle = '#111';
        ctx.beginPath();
        ctx.arc(player.x - eyeSpacing + lookX * 1.3, eyeY + lookY * 1.3, pupilSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(player.x + eyeSpacing + lookX * 1.3, eyeY + lookY * 1.3, pupilSize, 0, Math.PI * 2);
        ctx.fill();

        // Direction indicator for controlled player
        if (isControlled) {
            // Pulsing arrow indicator above
            const arrowPulse = 1 + Math.sin(Date.now() * 0.008) * 0.15;
            ctx.fillStyle = '#fff';
            ctx.shadowColor = '#fff';
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.moveTo(player.x, player.y - player.radius - 12 * arrowPulse);
            ctx.lineTo(player.x - 6, player.y - player.radius - 5);
            ctx.lineTo(player.x + 6, player.y - player.radius - 5);
            ctx.closePath();
            ctx.fill();
            ctx.shadowBlur = 0;
        }

        // Kick range indicator (when near ball)
        if (isControlled && player.kickCooldown <= 0) {
            ctx.strokeStyle = 'rgba(255,255,255,0.15)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.radius + 8 + 8, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Charge ring (visible while holding kick button)
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

        // Background ring (dim)
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.arc(player.x, player.y, ringRadius, 0, Math.PI * 2);
        ctx.stroke();

        // Filled charge arc - interpolate from team color to bright white/yellow at full
        const teamColor = player.team === 'red' ? [233, 69, 96] : [83, 216, 251];
        const fullColor = [255, 255, 100]; // bright yellow at max charge
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

        // Outer glow when charge is high
        if (ratio > 0.5) {
            const glowAlpha = (ratio - 0.5) * 0.6;
            ctx.strokeStyle = `rgba(${r},${g},${b},${glowAlpha})`;
            ctx.lineWidth = lineWidth + 4;
            ctx.beginPath();
            ctx.arc(player.x, player.y, ringRadius, startAngle, endAngle);
            ctx.stroke();
        }

        // Pulsing dot at the tip of the charge arc
        const tipX = player.x + Math.cos(endAngle) * ringRadius;
        const tipY = player.y + Math.sin(endAngle) * ringRadius;
        const pulse = 3 + Math.sin(Date.now() * 0.01) * 1.5;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.beginPath();
        ctx.arc(tipX, tipY, pulse, 0, Math.PI * 2);
        ctx.fill();
    }

    drawMagnetLink(owner, ball, dist) {
        const ctx = this.ctx;
        const maxRange = 80;
        const alpha = 0.4 * (1 - dist / maxRange);
        const color = owner.team === 'red' ? `rgba(233,69,96,${alpha})` : `rgba(83,216,251,${alpha})`;
        const time = Date.now() * 0.005;

        // Dotted energy line
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.moveTo(owner.x, owner.y);
        ctx.lineTo(ball.x, ball.y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Small energy particles along the link
        const dx = ball.x - owner.x;
        const dy = ball.y - owner.y;
        for (let i = 0; i < 3; i++) {
            const t = ((time * 0.8 + i * 0.33) % 1);
            const px = owner.x + dx * t;
            const py = owner.y + dy * t;
            const size = 2 + Math.sin(time * 3 + i) * 1;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(px, py, size, 0, Math.PI * 2);
            ctx.fill();
        }

        // Glow around ball when magnetized
        const glowColor = owner.team === 'red' ? 'rgba(233,69,96,' : 'rgba(83,216,251,';
        ctx.strokeStyle = glowColor + (alpha * 0.8) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.radius + 4 + Math.sin(time * 4) * 2, 0, Math.PI * 2);
        ctx.stroke();
    }

    spawnHitFlash(x, y, intensity) {
        const count = Math.floor(6 + intensity * 8);
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
        for (let i = this.hitFlashes.length - 1; i >= 0; i--) {
            const p = this.hitFlashes[i];
            p.x += p.vx;
            p.y += p.vy;
            p.vx *= 0.92;
            p.vy *= 0.92;
            p.life -= p.decay;
            if (p.life <= 0) this.hitFlashes.splice(i, 1);
        }
    }

    drawHitFlashes() {
        const ctx = this.ctx;
        for (const p of this.hitFlashes) {
            ctx.globalAlpha = p.life;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    drawDashCooldown(player) {
        if (player.dashCooldown <= 0) return;

        const ctx = this.ctx;
        const ratio = player.dashCooldown / Physics.DASH_COOLDOWN;
        const startAngle = -Math.PI / 2;
        const endAngle = startAngle + Math.PI * 2 * (1 - ratio);

        ctx.strokeStyle = 'rgba(83, 216, 251, 0.4)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(player.x, player.y, player.radius + 2, startAngle, endAngle);
        ctx.stroke();
    }

    // --- Confetti system ---
    spawnConfetti(team) {
        const colors = team === 'red'
            ? ['#e94560', '#ff6b81', '#ff4757', '#ffa502', '#fff200', '#ffffff']
            : ['#53d8fb', '#70a1ff', '#1e90ff', '#ffa502', '#fff200', '#ffffff'];

        for (let i = 0; i < 120; i++) {
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
                decay: 0.005 + Math.random() * 0.008,
            });
        }

        this.goalFlashTimer = 500;
        this.goalFlashTeam = team;
    }

    updateConfetti(dt) {
        if (this.goalFlashTimer > 0) {
            this.goalFlashTimer -= dt;
        }

        for (let i = this.confetti.length - 1; i >= 0; i--) {
            const c = this.confetti[i];
            c.vy += c.gravity;
            c.vx *= 0.99;
            c.x += c.vx;
            c.y += c.vy;
            c.rotation += c.rotationSpeed;
            c.life -= c.decay;

            if (c.life <= 0 || c.y > this.h + 20) {
                this.confetti.splice(i, 1);
            }
        }
    }

    drawConfetti() {
        const ctx = this.ctx;

        // Screen flash on goal
        if (this.goalFlashTimer > 0) {
            const alpha = (this.goalFlashTimer / 500) * 0.3;
            const flashColor = this.goalFlashTeam === 'red'
                ? `rgba(233, 69, 96, ${alpha})`
                : `rgba(83, 216, 251, ${alpha})`;
            ctx.fillStyle = flashColor;
            ctx.fillRect(0, 0, this.w, this.h);
        }

        for (const c of this.confetti) {
            ctx.save();
            ctx.translate(c.x, c.y);
            ctx.rotate(c.rotation);
            ctx.globalAlpha = c.life;
            ctx.fillStyle = c.color;
            ctx.fillRect(-c.width / 2, -c.height / 2, c.width, c.height);
            ctx.restore();
        }
        ctx.globalAlpha = 1;
    }
}
