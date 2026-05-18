// Physics — port of shared/physics.js. The web build keeps this stateless
// (a global `Physics` namespace). We do the same with an enum.
//
// The game step loop calls these in order:
//   1. resolveCircleCollision for each player-ball + player-player pair
//   2. constrainToField on every entity (so they don't leave the field, plus
//      goal-post collision handling)
//   3. checkGoal on the ball (after constrain, since constrain can push it
//      out of the goal area)

import CoreGraphics

enum Physics {

    /// Elastic-ish circle-circle collision. Mutates both bodies in place.
    /// Returns true if a collision was resolved.
    @discardableResult
    static func resolveCircleCollision(
        a posA: inout Vec2, velA: inout Vec2, radiusA: CGFloat, massA: CGFloat, bounceA: CGFloat,
        b posB: inout Vec2, velB: inout Vec2, radiusB: CGFloat, massB: CGFloat, bounceB: CGFloat
    ) -> Bool {
        let delta = posB - posA
        let d = delta.length
        let minDist = radiusA + radiusB
        if d >= minDist || d == 0 { return false }

        let n = Vec2(delta.x / d, delta.y / d)
        let overlap = minDist - d
        let total = massA + massB

        posA -= n * overlap * (massB / total)
        posB += n * overlap * (massA / total)

        let dv = velA - velB
        let dvDotN = dot(dv, n)
        if dvDotN <= 0 { return true }

        let restitution = (bounceA + bounceB) / 2
        let impulse = (1 + restitution) * dvDotN / total
        velA -= n * impulse * massB
        velB += n * impulse * massA
        return true
    }

    /// Convenience overloads that mutate through the entity reference types.
    static func resolveCircleCollision(_ a: Player, _ b: Ball) {
        var pa = a.pos, va = a.vel, pb = b.pos, vb = b.vel
        resolveCircleCollision(
            a: &pa, velA: &va, radiusA: a.radius, massA: a.mass, bounceA: GameConstants.playerBounce,
            b: &pb, velB: &vb, radiusB: b.radius, massB: b.mass, bounceB: GameConstants.ballBounce
        )
        a.pos = pa; a.vel = va
        b.pos = pb; b.vel = vb
    }

    static func resolveCircleCollision(_ a: Player, _ b: Player) {
        var pa = a.pos, va = a.vel, pb = b.pos, vb = b.vel
        resolveCircleCollision(
            a: &pa, velA: &va, radiusA: a.radius, massA: a.mass, bounceA: GameConstants.playerBounce,
            b: &pb, velB: &vb, radiusB: b.radius, massB: b.mass, bounceB: GameConstants.playerBounce
        )
        a.pos = pa; a.vel = va
        b.pos = pb; b.vel = vb
    }

    /// Block an entity from passing through goal posts. Mirror of
    /// shared/physics.js Physics.blockFromGoal.
    private static func blockFromGoal(
        pos: inout Vec2, vel: inout Vec2, radius: CGFloat,
        mouthX: CGFloat, goalTop: CGFloat, goalBottom: CGFloat,
        goalDepth: CGFloat, isLeftGoal: Bool
    ) {
        let r = radius
        let postR: CGFloat = 5
        let backX = isLeftGoal ? mouthX - goalDepth : mouthX + goalDepth

        let minGX = min(mouthX, backX)
        let maxGX = max(mouthX, backX)
        if pos.x + r < minGX - postR || pos.x - r > maxGX + postR { return }
        if pos.y + r < goalTop - postR || pos.y - r > goalBottom + postR { return }

        // 4 corner posts
        let corners: [Vec2] = [
            Vec2(mouthX, goalTop),
            Vec2(mouthX, goalBottom),
            Vec2(backX, goalTop),
            Vec2(backX, goalBottom),
        ]
        for c in corners {
            let dx = pos.x - c.x
            let dy = pos.y - c.y
            let d = (dx * dx + dy * dy).squareRoot()
            let minDist = r + postR
            if d < minDist && d > 0.5 {
                let overlap = minDist - d
                let nx = dx / d
                let ny = dy / d
                pos.x += nx * overlap
                pos.y += ny * overlap
                let vDotN = vel.x * nx + vel.y * ny
                if vDotN < 0 {
                    vel.x -= (1 + GameConstants.wallBounce) * vDotN * nx
                    vel.y -= (1 + GameConstants.wallBounce) * vDotN * ny
                }
            }
        }

        let inGoalXRange = isLeftGoal
            ? (pos.x > backX && pos.x < mouthX)
            : (pos.x > mouthX && pos.x < backX)

        if inGoalXRange {
            // Top + bottom rails of the goal box
            if pos.y - r < goalTop && pos.y + r > goalTop {
                if pos.y >= goalTop {
                    pos.y = goalTop + r
                    if vel.y < 0 { vel.y *= -GameConstants.wallBounce }
                } else {
                    pos.y = goalTop - r
                    if vel.y > 0 { vel.y *= -GameConstants.wallBounce }
                }
            }
            if pos.y + r > goalBottom && pos.y - r < goalBottom {
                if pos.y <= goalBottom {
                    pos.y = goalBottom - r
                    if vel.y > 0 { vel.y *= -GameConstants.wallBounce }
                } else {
                    pos.y = goalBottom + r
                    if vel.y < 0 { vel.y *= -GameConstants.wallBounce }
                }
            }
        }

        // Back-wall of the goal
        if pos.y > goalTop + postR && pos.y < goalBottom - postR {
            if isLeftGoal {
                if pos.x - r < backX && pos.x + r > backX {
                    if pos.x >= backX {
                        pos.x = backX + r
                        if vel.x < 0 { vel.x *= -GameConstants.wallBounce }
                    } else {
                        pos.x = backX - r
                        if vel.x > 0 { vel.x *= -GameConstants.wallBounce }
                    }
                }
            } else {
                if pos.x + r > backX && pos.x - r < backX {
                    if pos.x <= backX {
                        pos.x = backX - r
                        if vel.x > 0 { vel.x *= -GameConstants.wallBounce }
                    } else {
                        pos.x = backX + r
                        if vel.x < 0 { vel.x *= -GameConstants.wallBounce }
                    }
                }
            }
        }
    }

    /// Constrain to field. Players bounce off canvas edges + goal posts.
    /// The ball can enter the goal mouth (that's how it scores).
    @discardableResult
    static func constrainToField(_ player: Player, _ field: Field) -> Bool {
        var bounced = false
        var p = player.pos, v = player.vel
        let r = player.radius
        let cw = field.canvasW
        let ch = field.canvasH

        if p.x - r < 0 { p.x = r; if v.x < 0 { v.x = 0 }; bounced = true }
        if p.x + r > cw { p.x = cw - r; if v.x > 0 { v.x = 0 }; bounced = true }
        if p.y - r < 0 { p.y = r; if v.y < 0 { v.y = 0 }; bounced = true }
        if p.y + r > ch { p.y = ch - r; if v.y > 0 { v.y = 0 }; bounced = true }

        blockFromGoal(pos: &p, vel: &v, radius: r,
                      mouthX: field.x, goalTop: field.goalTop, goalBottom: field.goalBottom,
                      goalDepth: field.goalDepth, isLeftGoal: true)
        blockFromGoal(pos: &p, vel: &v, radius: r,
                      mouthX: field.x + field.width, goalTop: field.goalTop, goalBottom: field.goalBottom,
                      goalDepth: field.goalDepth, isLeftGoal: false)

        player.pos = p
        player.vel = v
        return bounced
    }

    @discardableResult
    static func constrainToField(_ ball: Ball, _ field: Field) -> Bool {
        var bounced = false
        var p = ball.pos, v = ball.vel
        let r = ball.radius
        let goalTop = field.goalTop
        let goalBottom = field.goalBottom
        let goalDepth = field.goalDepth

        // Left side
        if p.x - r < field.x {
            if p.y > goalTop && p.y < goalBottom {
                if p.x - r < field.x - goalDepth {
                    p.x = field.x - goalDepth + r
                    v.x *= -GameConstants.wallBounce; bounced = true
                }
                if p.y - r < goalTop {
                    p.y = goalTop + r
                    v.y *= -GameConstants.wallBounce; bounced = true
                }
                if p.y + r > goalBottom {
                    p.y = goalBottom - r
                    v.y *= -GameConstants.wallBounce; bounced = true
                }
            } else {
                p.x = field.x + r
                v.x *= -GameConstants.wallBounce; bounced = true
            }
        }
        // Right side
        if p.x + r > field.x + field.width {
            if p.y > goalTop && p.y < goalBottom {
                if p.x + r > field.x + field.width + goalDepth {
                    p.x = field.x + field.width + goalDepth - r
                    v.x *= -GameConstants.wallBounce; bounced = true
                }
                if p.y - r < goalTop {
                    p.y = goalTop + r
                    v.y *= -GameConstants.wallBounce; bounced = true
                }
                if p.y + r > goalBottom {
                    p.y = goalBottom - r
                    v.y *= -GameConstants.wallBounce; bounced = true
                }
            } else {
                p.x = field.x + field.width - r
                v.x *= -GameConstants.wallBounce; bounced = true
            }
        }
        if p.y - r < field.y {
            p.y = field.y + r
            v.y *= -GameConstants.wallBounce; bounced = true
        }
        if p.y + r > field.y + field.height {
            p.y = field.y + field.height - r
            v.y *= -GameConstants.wallBounce; bounced = true
        }

        ball.pos = p
        ball.vel = v
        return bounced
    }

    /// Did the ball cross either goal line? Returns the team that gets
    /// CREDITED with the goal (the opposite of which goal was scored on).
    static func checkGoal(_ ball: Ball, _ field: Field) -> Team? {
        let goalTop = field.goalTop
        let goalBottom = field.goalBottom
        let scoreLine = field.goalDepth * 0.25
        if ball.pos.y > goalTop && ball.pos.y < goalBottom {
            if ball.pos.x < field.x - scoreLine { return .blue }       // ball entered red's goal
            if ball.pos.x > field.x + field.width + scoreLine { return .red }
        }
        return nil
    }
}
