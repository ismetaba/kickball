// Physics engine for circle-based 2D soccer
const Physics = {
    FRICTION: 0.92,
    BALL_FRICTION: 0.992,
    WALL_BOUNCE: 0.7,
    PLAYER_BOUNCE: 0.35,
    BALL_BOUNCE: 0.7,
    MAX_PLAYER_SPEED: 3.0,
    MAX_BALL_SPEED: 28,
    KICK_FORCE: 13,
    POWER_KICK_FORCE: 28,
    DASH_FORCE: 5.5,
    DASH_COOLDOWN: 1800,
    DASH_DURATION: 180,
    PLAYER_ACCELERATION: 0.4,

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

        // Separate overlapping circles
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDist - dist;
        const totalMass = a.mass + b.mass;

        a.x -= nx * overlap * (b.mass / totalMass);
        a.y -= ny * overlap * (b.mass / totalMass);
        b.x += nx * overlap * (a.mass / totalMass);
        b.y += ny * overlap * (a.mass / totalMass);

        // Relative velocity
        const dvx = a.vx - b.vx;
        const dvy = a.vy - b.vy;
        const dvDotN = dvx * nx + dvy * ny;

        // Don't resolve if moving apart
        if (dvDotN <= 0) return true;

        const restitution = (bounceA + bounceB) / 2;
        const impulse = (1 + restitution) * dvDotN / totalMass;

        a.vx -= impulse * b.mass * nx;
        a.vy -= impulse * b.mass * ny;
        b.vx += impulse * a.mass * nx;
        b.vy += impulse * a.mass * ny;

        return true;
    },

    // Block player from entering a goal area. Uses a flat wall for the mouth
    // with circular collision at goal posts for smooth corner sliding.
    blockFromGoal(entity, mouthX, goalTop, goalBottom, goalDepth, isLeftGoal) {
        const r = entity.radius;
        const postR = 5; // Goal post collision radius

        // Only process if entity is near the goal area
        const nearX = isLeftGoal
            ? (entity.x - r < mouthX + r && entity.x > mouthX - goalDepth - r)
            : (entity.x + r > mouthX - r && entity.x < mouthX + goalDepth + r);
        if (!nearX) return;
        if (entity.y + r < goalTop - r && entity.y - r > goalBottom + r) return;

        // 1) Goal posts: circle collision at post corners (smooth rounding)
        const posts = [
            { x: mouthX, y: goalTop },
            { x: mouthX, y: goalBottom }
        ];
        for (const post of posts) {
            const dx = entity.x - post.x;
            const dy = entity.y - post.y;
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

        // 2) Goal mouth wall: flat vertical wall between posts
        // Only block if entity is between the posts (Y-wise) and approaching from the field
        if (entity.y > goalTop + postR && entity.y < goalBottom - postR) {
            if (isLeftGoal) {
                if (entity.x - r < mouthX && entity.x > mouthX - goalDepth) {
                    entity.x = mouthX + r;
                    if (entity.vx < 0) entity.vx *= -this.WALL_BOUNCE;
                }
            } else {
                if (entity.x + r > mouthX && entity.x < mouthX + goalDepth) {
                    entity.x = mouthX - r;
                    if (entity.vx > 0) entity.vx *= -this.WALL_BOUNCE;
                }
            }
        }

        // 3) Top/bottom bars: only block from outside the goal
        const behindMouth = isLeftGoal ? (entity.x < mouthX) : (entity.x > mouthX);
        if (behindMouth) {
            // Top bar: block from above
            if (entity.y + r > goalTop && entity.y < goalTop + r) {
                entity.y = goalTop - r;
                if (entity.vy > 0) entity.vy *= -this.WALL_BOUNCE;
            }
            // Bottom bar: block from below
            if (entity.y - r < goalBottom && entity.y > goalBottom - r) {
                entity.y = goalBottom + r;
                if (entity.vy < 0) entity.vy *= -this.WALL_BOUNCE;
            }
        }
    },

    constrainToField(entity, field, isPlayer = false) {
        const r = entity.radius;
        const goalTop = field.goalY;
        const goalBottom = field.goalY + field.goalHeight;
        const goalDepth = field.goalDepth || 20;

        if (isPlayer) {
            const cw = field.canvasWidth;
            const ch = field.canvasHeight;

            // Canvas edge boundaries
            if (entity.x - r < 0) { entity.x = r; if (entity.vx < 0) entity.vx = 0; }
            if (entity.x + r > cw) { entity.x = cw - r; if (entity.vx > 0) entity.vx = 0; }
            if (entity.y - r < 0) { entity.y = r; if (entity.vy < 0) entity.vy = 0; }
            if (entity.y + r > ch) { entity.y = ch - r; if (entity.vy > 0) entity.vy = 0; }

            // Block from goal areas
            this.blockFromGoal(entity, field.x, goalTop, goalBottom, goalDepth, true);
            this.blockFromGoal(entity, field.x + field.width, goalTop, goalBottom, goalDepth, false);
        } else {
            // Ball: can enter goal area, constrained by goal depth
            // Left goal
            if (entity.x - r < field.x) {
                if (entity.y > goalTop && entity.y < goalBottom) {
                    if (entity.x - r < field.x - goalDepth) {
                        entity.x = field.x - goalDepth + r;
                        entity.vx *= -this.WALL_BOUNCE;
                    }
                    if (entity.y - r < goalTop) {
                        entity.y = goalTop + r;
                        entity.vy *= -this.WALL_BOUNCE;
                    }
                    if (entity.y + r > goalBottom) {
                        entity.y = goalBottom - r;
                        entity.vy *= -this.WALL_BOUNCE;
                    }
                } else {
                    entity.x = field.x + r;
                    entity.vx *= -this.WALL_BOUNCE;
                }
            }
            // Right goal
            if (entity.x + r > field.x + field.width) {
                if (entity.y > goalTop && entity.y < goalBottom) {
                    if (entity.x + r > field.x + field.width + goalDepth) {
                        entity.x = field.x + field.width + goalDepth - r;
                        entity.vx *= -this.WALL_BOUNCE;
                    }
                    if (entity.y - r < goalTop) {
                        entity.y = goalTop + r;
                        entity.vy *= -this.WALL_BOUNCE;
                    }
                    if (entity.y + r > goalBottom) {
                        entity.y = goalBottom - r;
                        entity.vy *= -this.WALL_BOUNCE;
                    }
                } else {
                    entity.x = field.x + field.width - r;
                    entity.vx *= -this.WALL_BOUNCE;
                }
            }

            // Ball Y walls
            if (entity.y - r < field.y) {
                entity.y = field.y + r;
                entity.vy *= -this.WALL_BOUNCE;
            }
            if (entity.y + r > field.y + field.height) {
                entity.y = field.y + field.height - r;
                entity.vy *= -this.WALL_BOUNCE;
            }
        }
    },

    checkGoal(ball, field) {
        const goalTop = field.goalY;
        const goalBottom = field.goalY + field.goalHeight;
        const scoreLine = field.goalDepth * 0.25; // Ball crossing the line counts

        if (ball.y > goalTop && ball.y < goalBottom) {
            if (ball.x < field.x - scoreLine) return 'blue';
            if (ball.x > field.x + field.width + scoreLine) return 'red';
        }
        return null;
    }
};
