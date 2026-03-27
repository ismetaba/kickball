// Physics engine for circle-based 2D soccer (shared: browser + server)
(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.Physics = factory();
    }
})(typeof self !== 'undefined' ? self : this, function() {

const Physics = {
    dtRatio: 1,
    GAME_SPEED: 1.2,
    FRICTION: 0.955,
    BALL_FRICTION: 0.993,
    WALL_BOUNCE: 0.5,
    PLAYER_BOUNCE: 0.5,
    BALL_BOUNCE: 0.35,
    MAX_PLAYER_SPEED: 5.2,
    MAX_BALL_SPEED: 30,
    KICK_FORCE: 9.5,
    POWER_KICK_FORCE: 9.8,
    PLAYER_ACCELERATION: 0.21,

    distance(a, b) {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        return Math.sqrt(dx * dx + dy * dy);
    },

    normalize(vx, vy) {
        const len = Math.sqrt(vx * vx + vy * vy);
        if (len === 0) return { x: 0, y: 0 };
        return { x: vx / len, y: vy / len };
    },

    clampSpeed(entity, maxSpeed) {
        const speed = Math.sqrt(entity.vx * entity.vx + entity.vy * entity.vy);
        if (speed > maxSpeed) {
            const ratio = maxSpeed / speed;
            entity.vx *= ratio;
            entity.vy *= ratio;
        }
    },

    resolveCircleCollision(a, b, bounceA, bounceB) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.radius + b.radius;

        if (dist >= minDist || dist === 0) return false;

        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDist - dist;
        const totalMass = a.mass + b.mass;

        a.x -= nx * overlap * (b.mass / totalMass);
        a.y -= ny * overlap * (b.mass / totalMass);
        b.x += nx * overlap * (a.mass / totalMass);
        b.y += ny * overlap * (a.mass / totalMass);

        const dvx = a.vx - b.vx;
        const dvy = a.vy - b.vy;
        const dvDotN = dvx * nx + dvy * ny;

        if (dvDotN <= 0) return true;

        const restitution = (bounceA + bounceB) / 2;
        const impulse = (1 + restitution) * dvDotN / totalMass;

        a.vx -= impulse * b.mass * nx;
        a.vy -= impulse * b.mass * ny;
        b.vx += impulse * a.mass * nx;
        b.vy += impulse * a.mass * ny;

        return true;
    },

    blockFromGoal(entity, mouthX, goalTop, goalBottom, goalDepth, isLeftGoal) {
        const r = entity.radius;
        const postR = 5;
        const backX = isLeftGoal ? mouthX - goalDepth : mouthX + goalDepth;

        const minGX = Math.min(mouthX, backX);
        const maxGX = Math.max(mouthX, backX);
        if (entity.x + r < minGX - postR || entity.x - r > maxGX + postR) return;
        if (entity.y + r < goalTop - postR || entity.y - r > goalBottom + postR) return;

        const corners = [
            { x: mouthX, y: goalTop },
            { x: mouthX, y: goalBottom },
            { x: backX, y: goalTop },
            { x: backX, y: goalBottom }
        ];
        for (const c of corners) {
            const dx = entity.x - c.x;
            const dy = entity.y - c.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = r + postR;
            if (dist < minDist && dist > 0.5) {
                const overlap = minDist - dist;
                const nx = dx / dist;
                const ny = dy / dist;
                entity.x += nx * overlap;
                entity.y += ny * overlap;
                const vDotN = entity.vx * nx + entity.vy * ny;
                if (vDotN < 0) {
                    entity.vx -= (1 + this.WALL_BOUNCE) * vDotN * nx;
                    entity.vy -= (1 + this.WALL_BOUNCE) * vDotN * ny;
                }
            }
        }

        const inGoalXRange = isLeftGoal
            ? (entity.x > backX && entity.x < mouthX)
            : (entity.x > mouthX && entity.x < backX);

        if (inGoalXRange) {
            if (entity.y - r < goalTop && entity.y + r > goalTop) {
                if (entity.y >= goalTop) {
                    entity.y = goalTop + r;
                    if (entity.vy < 0) entity.vy *= -this.WALL_BOUNCE;
                } else {
                    entity.y = goalTop - r;
                    if (entity.vy > 0) entity.vy *= -this.WALL_BOUNCE;
                }
            }
            if (entity.y + r > goalBottom && entity.y - r < goalBottom) {
                if (entity.y <= goalBottom) {
                    entity.y = goalBottom - r;
                    if (entity.vy > 0) entity.vy *= -this.WALL_BOUNCE;
                } else {
                    entity.y = goalBottom + r;
                    if (entity.vy < 0) entity.vy *= -this.WALL_BOUNCE;
                }
            }
        }

        if (entity.y > goalTop + postR && entity.y < goalBottom - postR) {
            if (isLeftGoal) {
                if (entity.x - r < backX && entity.x + r > backX) {
                    if (entity.x >= backX) {
                        entity.x = backX + r;
                        if (entity.vx < 0) entity.vx *= -this.WALL_BOUNCE;
                    } else {
                        entity.x = backX - r;
                        if (entity.vx > 0) entity.vx *= -this.WALL_BOUNCE;
                    }
                }
            } else {
                if (entity.x + r > backX && entity.x - r < backX) {
                    if (entity.x <= backX) {
                        entity.x = backX - r;
                        if (entity.vx > 0) entity.vx *= -this.WALL_BOUNCE;
                    } else {
                        entity.x = backX + r;
                        if (entity.vx < 0) entity.vx *= -this.WALL_BOUNCE;
                    }
                }
            }
        }
    },

    constrainToField(entity, field, isPlayer = false) {
        const r = entity.radius;
        const goalTop = field.goalY;
        const goalBottom = field.goalY + field.goalHeight;
        const goalDepth = field.goalDepth || 20;
        let bounced = false;

        if (isPlayer) {
            const cw = field.canvasWidth;
            const ch = field.canvasHeight;

            if (entity.x - r < 0) { entity.x = r; if (entity.vx < 0) entity.vx = 0; }
            if (entity.x + r > cw) { entity.x = cw - r; if (entity.vx > 0) entity.vx = 0; }
            if (entity.y - r < 0) { entity.y = r; if (entity.vy < 0) entity.vy = 0; }
            if (entity.y + r > ch) { entity.y = ch - r; if (entity.vy > 0) entity.vy = 0; }

            this.blockFromGoal(entity, field.x, goalTop, goalBottom, goalDepth, true);
            this.blockFromGoal(entity, field.x + field.width, goalTop, goalBottom, goalDepth, false);
        } else {
            if (entity.x - r < field.x) {
                if (entity.y > goalTop && entity.y < goalBottom) {
                    if (entity.x - r < field.x - goalDepth) {
                        entity.x = field.x - goalDepth + r;
                        entity.vx *= -this.WALL_BOUNCE; bounced = true;
                    }
                    if (entity.y - r < goalTop) {
                        entity.y = goalTop + r;
                        entity.vy *= -this.WALL_BOUNCE; bounced = true;
                    }
                    if (entity.y + r > goalBottom) {
                        entity.y = goalBottom - r;
                        entity.vy *= -this.WALL_BOUNCE; bounced = true;
                    }
                } else {
                    entity.x = field.x + r;
                    entity.vx *= -this.WALL_BOUNCE; bounced = true;
                }
            }
            if (entity.x + r > field.x + field.width) {
                if (entity.y > goalTop && entity.y < goalBottom) {
                    if (entity.x + r > field.x + field.width + goalDepth) {
                        entity.x = field.x + field.width + goalDepth - r;
                        entity.vx *= -this.WALL_BOUNCE; bounced = true;
                    }
                    if (entity.y - r < goalTop) {
                        entity.y = goalTop + r;
                        entity.vy *= -this.WALL_BOUNCE; bounced = true;
                    }
                    if (entity.y + r > goalBottom) {
                        entity.y = goalBottom - r;
                        entity.vy *= -this.WALL_BOUNCE; bounced = true;
                    }
                } else {
                    entity.x = field.x + field.width - r;
                    entity.vx *= -this.WALL_BOUNCE; bounced = true;
                }
            }

            if (entity.y - r < field.y) {
                entity.y = field.y + r;
                entity.vy *= -this.WALL_BOUNCE; bounced = true;
            }
            if (entity.y + r > field.y + field.height) {
                entity.y = field.y + field.height - r;
                entity.vy *= -this.WALL_BOUNCE; bounced = true;
            }
        }
        return bounced;
    },

    checkGoal(ball, field) {
        const goalTop = field.goalY;
        const goalBottom = field.goalY + field.goalHeight;
        const scoreLine = field.goalDepth * 0.25;

        if (ball.y > goalTop && ball.y < goalBottom) {
            if (ball.x < field.x - scoreLine) return 'blue';
            if (ball.x > field.x + field.width + scoreLine) return 'red';
        }
        return null;
    }
};

return Physics;
});
