// Physics engine for circle-based 2D soccer
const Physics = {
    FRICTION: 0.94,
    BALL_FRICTION: 0.985,
    WALL_BOUNCE: 0.5,
    PLAYER_BOUNCE: 0.35,
    BALL_BOUNCE: 0.55,
    MAX_PLAYER_SPEED: 2.2,
    MAX_BALL_SPEED: 22,
    KICK_FORCE: 9,
    POWER_KICK_FORCE: 22,
    DASH_FORCE: 4.5,
    DASH_COOLDOWN: 3000,
    DASH_DURATION: 180,
    PLAYER_ACCELERATION: 0.25,

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

    constrainToField(entity, field, isPlayer = false) {
        const r = entity.radius;
        const goalTop = field.goalY;
        const goalBottom = field.goalY + field.goalHeight;
        const goalDepth = field.goalDepth || 20;
        // Players can overflow on field edges but NOT into goals
        const overflow = isPlayer ? entity.radius * 1.5 : 0;

        if (isPlayer) {
            // Is the player's center in the goal Y range?
            const nearGoalY = entity.y > goalTop - r && entity.y < goalBottom + r;

            // --- Left side ---
            if (nearGoalY && entity.x < field.x + r) {
                // Near goal opening: hard wall at field line, cannot enter goal
                entity.x = field.x + r;
                if (entity.vx < 0) entity.vx *= -this.WALL_BOUNCE;

                // Also push away from post edges if overlapping
                if (entity.y < goalTop + r && entity.y > goalTop - r) {
                    entity.y = goalTop - r;
                    if (entity.vy > 0) entity.vy *= -this.WALL_BOUNCE;
                }
                if (entity.y > goalBottom - r && entity.y < goalBottom + r) {
                    entity.y = goalBottom + r;
                    if (entity.vy < 0) entity.vy *= -this.WALL_BOUNCE;
                }
            } else if (entity.x - r < field.x - overflow) {
                // Not near goal: allow overflow up to 1.5x body
                entity.x = field.x - overflow + r;
                if (entity.vx < 0) entity.vx *= -this.WALL_BOUNCE;
            }

            // --- Right side ---
            if (nearGoalY && entity.x > field.x + field.width - r) {
                entity.x = field.x + field.width - r;
                if (entity.vx > 0) entity.vx *= -this.WALL_BOUNCE;

                if (entity.y < goalTop + r && entity.y > goalTop - r) {
                    entity.y = goalTop - r;
                    if (entity.vy > 0) entity.vy *= -this.WALL_BOUNCE;
                }
                if (entity.y > goalBottom - r && entity.y < goalBottom + r) {
                    entity.y = goalBottom + r;
                    if (entity.vy < 0) entity.vy *= -this.WALL_BOUNCE;
                }
            } else if (entity.x + r > field.x + field.width + overflow) {
                entity.x = field.x + field.width + overflow - r;
                if (entity.vx > 0) entity.vx *= -this.WALL_BOUNCE;
            }
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
        }

        // Top / bottom walls — overflow allowed but not into goal zone
        if (isPlayer) {
            // Check if player is near the goal X range (left or right edge)
            const nearLeftGoalX = entity.x - r < field.x;
            const nearRightGoalX = entity.x + r > field.x + field.width;

            if (nearLeftGoalX || nearRightGoalX) {
                // Near goal sides: no Y overflow to prevent clipping above/below goal
                if (entity.y - r < field.y) {
                    entity.y = field.y + r;
                    if (entity.vy < 0) entity.vy *= -this.WALL_BOUNCE;
                }
                if (entity.y + r > field.y + field.height) {
                    entity.y = field.y + field.height - r;
                    if (entity.vy > 0) entity.vy *= -this.WALL_BOUNCE;
                }
            } else {
                // Normal overflow
                if (entity.y - r < field.y - overflow) {
                    entity.y = field.y - overflow + r;
                    if (entity.vy < 0) entity.vy *= -this.WALL_BOUNCE;
                }
                if (entity.y + r > field.y + field.height + overflow) {
                    entity.y = field.y + field.height + overflow - r;
                    if (entity.vy > 0) entity.vy *= -this.WALL_BOUNCE;
                }
            }
        } else {
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
        const scoreLine = field.goalDepth * 0.5; // Ball must go halfway into the net

        if (ball.y > goalTop && ball.y < goalBottom) {
            if (ball.x < field.x - scoreLine) return 'blue';
            if (ball.x > field.x + field.width + scoreLine) return 'red';
        }
        return null;
    }
};
