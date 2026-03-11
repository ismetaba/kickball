// Power-up system
class PowerUpManager {
    constructor(field) {
        this.field = field;
        this.powerUps = [];
        this.spawnTimer = 0;
        this.spawnInterval = 15000; // 15 seconds
        this.enabled = true;

        this.types = [
            { id: 'speed', label: 'SPEED BOOST', color: '#4caf50', icon: 'S', duration: 8000 },
            { id: 'power', label: 'POWER KICK', color: '#ff9800', icon: 'P', duration: 10000 },
            { id: 'curve', label: 'CURVE BALL', color: '#9c27b0', icon: 'C', duration: 12000 },
            { id: 'big', label: 'BIG PLAYER', color: '#2196f3', icon: 'B', duration: 8000 },
            { id: 'freeze', label: 'FREEZE OPPONENTS', color: '#00bcd4', icon: 'F', duration: 3000 },
            { id: 'magnet', label: 'BALL MAGNET', color: '#e91e63', icon: 'M', duration: 6000 },
        ];
    }

    update(dt, players) {
        if (!this.enabled) return null;

        this.spawnTimer += dt;
        if (this.spawnTimer >= this.spawnInterval && this.powerUps.length < 2) {
            this.spawn();
            this.spawnTimer = 0;
        }

        // Animate power-ups
        for (const pu of this.powerUps) {
            pu.bobTimer += dt * 0.003;
            pu.scale = 1 + Math.sin(pu.bobTimer) * 0.15;
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

    spawn() {
        const type = this.types[Math.floor(Math.random() * this.types.length)];
        const margin = 60;
        const x = this.field.x + margin + Math.random() * (this.field.width - margin * 2);
        const y = this.field.y + margin + Math.random() * (this.field.height - margin * 2);

        this.powerUps.push({
            x, y,
            radius: 12,
            type: type,
            bobTimer: 0,
            scale: 1,
        });
    }

    applyPowerUp(player, pu, allPlayers) {
        const type = pu.type;

        if (type.id === 'freeze') {
            // Freeze opponents
            for (const p of allPlayers) {
                if (p.team !== player.team) {
                    p.vx = 0;
                    p.vy = 0;
                    p.powerUp = 'frozen';
                    p.powerUpTimer = type.duration;
                }
            }
        } else if (type.id === 'big') {
            player.radius = 34;
            player.powerUp = 'big';
            player.powerUpTimer = type.duration;
            // Reset radius when power-up ends (handled in player update)
            setTimeout(() => { player.radius = 24; }, type.duration);
        } else {
            player.powerUp = type.id;
            player.powerUpTimer = type.duration;
        }
    }

    reset() {
        this.powerUps = [];
        this.spawnTimer = 0;
    }

    draw(ctx) {
        for (const pu of this.powerUps) {
            ctx.save();
            ctx.translate(pu.x, pu.y);
            ctx.scale(pu.scale, pu.scale);

            // Glow
            const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, pu.radius * 2);
            gradient.addColorStop(0, pu.type.color + '40');
            gradient.addColorStop(1, 'transparent');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(0, 0, pu.radius * 2, 0, Math.PI * 2);
            ctx.fill();

            // Body
            ctx.fillStyle = pu.type.color;
            ctx.beginPath();
            ctx.arc(0, 0, pu.radius, 0, Math.PI * 2);
            ctx.fill();

            // Border
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Icon
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(pu.type.icon, 0, 0);

            ctx.restore();
        }
    }
}
