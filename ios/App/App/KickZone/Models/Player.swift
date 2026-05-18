// Player entity — direct port of shared/entities.js Player class.
// Mutable reference type so the physics engine can read/write its fields
// in place during the simulation step.

import CoreGraphics

final class Player {
    var pos: Vec2
    var vel: Vec2 = .zero
    let spawn: Vec2
    let team: Team
    var isHuman: Bool

    let radius: CGFloat = 24
    let mass: CGFloat = 1

    var kickCooldownMs: Double = 0
    var pullCooldownMs: Double = 0
    var pullDurationMs: Double = 0
    var pullActive: Bool = false
    var stunMs: Double = 0
    var kickChargeRatio: CGFloat = 0
    var lastTouchedBall: Bool = false

    var powerUp: PowerUpKind? = nil
    var powerUpRemainingMs: Double = 0

    var goals: Int = 0
    var kicks: Int = 0

    init(pos: Vec2, team: Team, isHuman: Bool = false) {
        self.pos = pos
        self.spawn = pos
        self.team = team
        self.isHuman = isHuman
    }

    func reset() {
        pos = spawn
        vel = .zero
        kickCooldownMs = 0
        stunMs = 0
        pullActive = false
        pullCooldownMs = 0
        pullDurationMs = 0
    }

    var maxSpeed: CGFloat {
        var base = GameConstants.maxPlayerSpeed
        if powerUp == .speed { base *= 1.5 }
        if powerUp == .slowed { base *= 0.5 }
        return base
    }

    var kickForce: CGFloat { GameConstants.kickForce }

    /// Applies an input direction (already unit-length-or-shorter) to velocity.
    func applyInput(_ dir: Vec2, dtRatio: CGFloat) {
        let accel = GameConstants.playerAccel * dtRatio
        vel += dir * accel
    }

    /// Per-tick update: friction, speed clamp, position integrate.
    func update(dtMs: Double, dtRatio: CGFloat) {
        if stunMs > 0 {
            stunMs -= dtMs
            let damp = pow(0.997, CGFloat(dtMs))
            vel *= damp
            pos += vel * dtRatio
            return
        }
        if kickCooldownMs > 0 { kickCooldownMs -= dtMs }
        if pullCooldownMs > 0 { pullCooldownMs -= dtMs }
        if pullActive {
            pullDurationMs -= dtMs
            if pullDurationMs <= 0 {
                pullActive = false
                pullCooldownMs = GameConstants.pullCooldownMs
            }
        }
        if powerUpRemainingMs > 0 {
            powerUpRemainingMs -= dtMs
            if powerUpRemainingMs <= 0 { powerUp = nil }
        }
        let f = pow(GameConstants.friction, dtRatio)
        vel *= f
        // Clamp speed
        let s = vel.length
        if s > maxSpeed {
            vel *= (maxSpeed / s)
        }
        pos += vel * dtRatio
    }

    func activatePull() -> Bool {
        if pullCooldownMs > 0 || pullActive { return false }
        pullActive = true
        pullDurationMs = GameConstants.pullDurationMs
        return true
    }

    /// Attempt to kick the ball. Returns true if connected.
    @discardableResult
    func kick(_ ball: Ball, chargeRatio: CGFloat) -> Bool {
        if kickCooldownMs > 0 { return false }
        let d = dist(pos, ball.pos)
        let kickRange = radius + ball.radius + 21
        if d > kickRange { return false }

        let toBall = ball.pos - pos
        let n = toBall.normalized()
        let charge = max(0, min(chargeRatio, 1))
        let minF = kickForce * 0.75
        let maxF = GameConstants.powerKickForce
        let force = minF + (maxF - minF) * charge

        ball.vel = n * force + vel * 0.3
        // Recoil
        let recoil = charge * 3
        vel = vel * (1 - charge * 0.7) - n * recoil

        // Super kick at high charge
        if charge > 0.8 {
            ball.superKick = 1.0
            ball.superTarget = (team == .red) ? .right : .left
            ball.fireLevel = 1
            ball.fireRemainingMs = 3000
        } else {
            ball.superKick = 0
            ball.superTarget = nil
        }

        // Spin from lateral motion (banana shots)
        let perp = Vec2(-n.y, n.x)
        let movePerp = dot(vel, perp)
        let spinMul: CGFloat = 0.25
        ball.vel += perp * movePerp * spinMul
        ball.spin = movePerp * 0.25

        if powerUp == .ghost {
            ball.ghost = true
            ball.ghostRemainingMs = 3000
            powerUp = nil
            powerUpRemainingMs = 0
        }

        kickCooldownMs = GameConstants.kickCooldownMs
        kicks += 1
        ball.lastKickedBy = self
        return true
    }
}

enum PowerUpKind {
    case speed, ghost, dash, shield, frozen, slowed
}
