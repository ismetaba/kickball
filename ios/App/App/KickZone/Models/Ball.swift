// Ball entity — direct port of shared/entities.js Ball class.
// Tracks position, velocity, spin (curve), super-kick (homing), and ghost
// (passes through opponents). Trail is omitted here — handled by the
// renderer if desired.

import CoreGraphics

enum SuperKickTarget {
    case left, right  // which goal the homing ball targets
}

final class Ball {
    var pos: Vec2
    var vel: Vec2 = .zero
    let spawn: Vec2
    let radius: CGFloat = 14
    let mass: CGFloat = 0.5

    var lastKickedBy: Player? = nil
    var spin: CGFloat = 0
    var superKick: CGFloat = 0
    var superTarget: SuperKickTarget? = nil
    var fireLevel: Int = 0
    var fireRemainingMs: Double = 0
    var ghost: Bool = false
    var ghostRemainingMs: Double = 0

    init(pos: Vec2) {
        self.pos = pos
        self.spawn = pos
    }

    func reset() {
        pos = spawn
        vel = .zero
        lastKickedBy = nil
        spin = 0
        superKick = 0
        superTarget = nil
        fireLevel = 0
        fireRemainingMs = 0
        ghost = false
        ghostRemainingMs = 0
    }

    func update(dtMs: Double, dtRatio: CGFloat) {
        if ghost {
            ghostRemainingMs -= dtMs
            if ghostRemainingMs <= 0 { ghost = false }
        }
        if fireLevel > 0 {
            fireRemainingMs -= dtMs
            let s = vel.length
            if fireRemainingMs <= 0 || s < 5 {
                fireLevel = 0
                fireRemainingMs = 0
            }
        }
        let f = pow(GameConstants.ballFriction, dtRatio)
        vel *= f

        // Magnus/spin curve
        if abs(spin) > 0.01 {
            let s = vel.length
            if s > 0.5 {
                let dir = vel / s
                let perp = Vec2(-dir.y, dir.x)
                vel += perp * spin * 0.1 * dtRatio
            }
            spin *= pow(0.97, dtRatio)
        }

        // Speed clamp
        let s = vel.length
        if s > GameConstants.maxBallSpeed {
            vel *= (GameConstants.maxBallSpeed / s)
        }
        pos += vel * dtRatio
    }
}
