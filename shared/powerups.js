// Power-up system (shared: browser + server)
// On server: isServer=true skips sound/rendering. On client: draws normally.
(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        const Physics = require('./physics');
        module.exports = factory(Physics, true);
    } else {
        root.PowerUpManager = factory(root.Physics, false);
    }
})(typeof self !== 'undefined' ? self : this, function(Physics, isServer) {

class PowerUpManager {
    constructor(field) {
        this.field = field;
        this.powerUps = [];
        this.spawnTimer = 0;
        this.spawnInterval = 15000;
        this.enabled = true;
        this.isServer = isServer;

        this.types = [
            { id: 'speed', label: 'SPEED BOOST', color: '#4caf50', icon: '\u26A1', duration: 8000, shape: 'bolt' },
            { id: 'ghost', label: 'GHOST BALL', color: '#ffffff', icon: '\uD83D\uDC7B', duration: 5000, shape: 'diamond' },
            { id: 'dash', label: 'DASH', color: '#ffc107', icon: '\uD83D\uDCA8', duration: 0, shape: 'arrow' },
            { id: 'shield', label: 'SHIELD', color: '#ffd700', icon: '\uD83D\uDEE1', duration: 6000, shape: 'hexagon' },
            { id: 'freeze', label: 'FREEZE OPPONENTS', color: '#00bcd4', icon: '\u2744', duration: 3000, shape: 'snowflake' },
            { id: 'slow', label: 'SLOW FIELD', color: '#009688', icon: '\uD83D\uDD50', duration: 4000, shape: 'wave' },
        ];
    }

    update(dt, players, suddenDeath, rng) {
        if (!this.enabled) return null;

        const interval = suddenDeath ? 5000 : this.spawnInterval;
        const maxOnField = suddenDeath ? 4 : 2;

        this.spawnTimer += dt;
        if (this.spawnTimer >= interval && this.powerUps.length < maxOnField) {
            this.spawn(rng);
            this.spawnTimer = 0;
        }

        // Animate power-ups (client only)
        if (!this.isServer) {
            for (const pu of this.powerUps) {
                pu.bobTimer += dt * 0.003;
                pu.scale = 1 + Math.sin(pu.bobTimer) * 0.15;
                pu.rotateTimer = (pu.rotateTimer || 0) + dt * 0.002;
                pu.pulseTimer = (pu.pulseTimer || 0) + dt * 0.004;
            }
        }

        // Check collection
        for (const player of players) {
            for (let i = this.powerUps.length - 1; i >= 0; i--) {
                const pu = this.powerUps[i];
                const dist = Physics.distance(player, pu);
                if (dist < player.radius + pu.radius) {
                    this.applyPowerUp(player, pu, players);
                    this.powerUps.splice(i, 1);
                    return { player, type: pu.type };
                }
            }
        }
        return null;
    }

    spawn(rng) {
        // Lockstep multiplayer passes a shared seeded rng so every peer spawns
        // the identical power-up at the identical position. Without one
        // (offline / server-authoritative), plain Math.random is fine.
        const rand = rng ? () => rng.next() : Math.random;
        const type = this.types[Math.floor(rand() * this.types.length)];
        const margin = 60;
        const x = this.field.x + margin + rand() * (this.field.width - margin * 2);
        const y = this.field.y + margin + rand() * (this.field.height - margin * 2);

        this.powerUps.push({
            x, y,
            radius: 14,
            type: type,
            bobTimer: 0,
            scale: 1,
            rotateTimer: 0,
            pulseTimer: 0,
            spawnTime: Date.now(),
        });

        if (!this.isServer && typeof Sound !== 'undefined') {
            Sound.powerUpSpawn();
        }
    }

    applyPowerUp(player, pu, allPlayers) {
        const type = pu.type;

        if (type.id === 'freeze') {
            for (const p of allPlayers) {
                if (p.team !== player.team) {
                    p.vx = 0;
                    p.vy = 0;
                    p.powerUp = 'frozen';
                    p.powerUpTimer = type.duration;
                }
            }
        } else if (type.id === 'slow') {
            for (const p of allPlayers) {
                if (p.team !== player.team) {
                    p.powerUp = 'slowed';
                    p.powerUpTimer = type.duration;
                }
            }
        } else if (type.id === 'dash') {
            player.powerUp = 'dash';
            player.powerUpTimer = 1;
            player.dashReady = true;
        } else if (type.id === 'ghost') {
            player.powerUp = 'ghost';
            player.powerUpTimer = type.duration;
        } else if (type.id === 'shield') {
            player.powerUp = 'shield';
            player.powerUpTimer = type.duration;
        } else {
            player.powerUp = type.id;
            player.powerUpTimer = type.duration;
        }
    }

    reset() {
        this.powerUps = [];
        this.spawnTimer = 0;
    }

    // Draw method only works on client — server never calls this
    draw(ctx) {
        if (this.isServer) return;
        const now = Date.now();
        for (const pu of this.powerUps) {
            ctx.save();
            ctx.translate(pu.x, pu.y);
            ctx.scale(pu.scale, pu.scale);

            const age = (now - pu.spawnTime) / 1000;
            const pulse = Math.sin(pu.pulseTimer) * 0.5 + 0.5;
            const rot = pu.rotateTimer;

            const glowRadius = pu.radius * 2.5 + pulse * 4;
            const outerGlow = ctx.createRadialGradient(0, 0, pu.radius * 0.5, 0, 0, glowRadius);
            outerGlow.addColorStop(0, pu.type.color + '30');
            outerGlow.addColorStop(0.6, pu.type.color + '15');
            outerGlow.addColorStop(1, 'transparent');
            ctx.fillStyle = outerGlow;
            ctx.beginPath();
            ctx.arc(0, 0, glowRadius, 0, Math.PI * 2);
            ctx.fill();

            this._drawShape(ctx, pu.type, pu.radius, rot, pulse);

            ctx.fillStyle = '#fff';
            ctx.font = `bold ${pu.radius}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(pu.type.icon, 0, 1);

            this._drawParticles(ctx, pu.type, pu.radius, rot, age);

            ctx.restore();
        }
    }

    _drawShape(ctx, type, r, rot, pulse) {
        ctx.save();
        switch (type.shape) {
            case 'bolt':
                ctx.rotate(rot * 0.5);
                this._polygon(ctx, 6, r + 1);
                ctx.fillStyle = type.color + 'cc';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
                break;
            case 'diamond':
                ctx.rotate(rot * 0.8 + Math.PI / 4);
                this._polygon(ctx, 4, r + 2);
                ctx.fillStyle = type.color + '99';
                ctx.fill();
                ctx.strokeStyle = type.color;
                ctx.lineWidth = 2;
                ctx.setLineDash([3, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
                const ghostGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
                ghostGrad.addColorStop(0, 'rgba(255,255,255,0.4)');
                ghostGrad.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.fillStyle = ghostGrad;
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.fill();
                break;
            case 'arrow':
                ctx.rotate(rot * 1.5);
                this._drawArrow(ctx, r + 2);
                ctx.fillStyle = type.color + 'dd';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
                break;
            case 'hexagon':
                ctx.rotate(rot * 0.3);
                this._polygon(ctx, 6, r + 2);
                ctx.fillStyle = type.color + 'bb';
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 3;
                ctx.stroke();
                this._polygon(ctx, 6, r - 3);
                ctx.strokeStyle = type.color;
                ctx.lineWidth = 1.5;
                ctx.stroke();
                break;
            case 'snowflake':
                ctx.fillStyle = type.color + 'cc';
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                for (let i = 0; i < 6; i++) {
                    const a = rot * 0.4 + (i * Math.PI * 2) / 6;
                    ctx.beginPath();
                    ctx.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5);
                    ctx.lineTo(Math.cos(a) * (r + 5), Math.sin(a) * (r + 5));
                    ctx.stroke();
                    const bx = Math.cos(a) * (r + 2);
                    const by = Math.sin(a) * (r + 2);
                    ctx.beginPath();
                    ctx.moveTo(bx, by);
                    ctx.lineTo(bx + Math.cos(a + 0.5) * 3, by + Math.sin(a + 0.5) * 3);
                    ctx.moveTo(bx, by);
                    ctx.lineTo(bx + Math.cos(a - 0.5) * 3, by + Math.sin(a - 0.5) * 3);
                    ctx.stroke();
                }
                break;
            case 'wave':
                ctx.fillStyle = type.color + 'bb';
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
                for (let i = 0; i < 2; i++) {
                    const wavePhase = (pulse + i * 0.5) % 1;
                    const waveR = r + wavePhase * 10;
                    ctx.globalAlpha = (1 - wavePhase) * 0.5;
                    ctx.strokeStyle = type.color;
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(0, 0, waveR, 0, Math.PI * 2);
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
                break;
            default:
                ctx.fillStyle = type.color;
                ctx.beginPath();
                ctx.arc(0, 0, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
        }
        ctx.restore();
    }

    _drawParticles(ctx, type, r, rot, age) {
        const count = 4;
        for (let i = 0; i < count; i++) {
            const angle = rot * 1.2 + (i * Math.PI * 2) / count + age * 0.3;
            const orbitR = r + 6 + Math.sin(age * 2 + i) * 3;
            const px = Math.cos(angle) * orbitR;
            const py = Math.sin(angle) * orbitR;
            const pSize = 1.5 + Math.sin(age * 3 + i * 1.5) * 0.8;

            ctx.fillStyle = type.color;
            ctx.globalAlpha = 0.6 + Math.sin(age * 2 + i) * 0.3;
            ctx.beginPath();
            ctx.arc(px, py, pSize, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }

    _polygon(ctx, sides, r) {
        ctx.beginPath();
        for (let i = 0; i < sides; i++) {
            const a = (i * Math.PI * 2) / sides - Math.PI / 2;
            if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
            else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
    }

    _drawArrow(ctx, r) {
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
            const outerA = (i * Math.PI * 2) / 5 - Math.PI / 2;
            const innerA = outerA + Math.PI / 5;
            if (i === 0) ctx.moveTo(Math.cos(outerA) * r, Math.sin(outerA) * r);
            else ctx.lineTo(Math.cos(outerA) * r, Math.sin(outerA) * r);
            ctx.lineTo(Math.cos(innerA) * r * 0.5, Math.sin(innerA) * r * 0.5);
        }
        ctx.closePath();
    }
}

return PowerUpManager;
});
