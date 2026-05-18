// Swift port of js/rl/encoder.js (the 1v1 encoder with frame stacking).
//
// Produces a 56-feature observation per frame from the player's
// perspective. The runtime agent stacks the last 3 frames to feed into
// the network (168 dims).
//
// We keep this exactly compatible with the JS encoder so the Swift
// inference behaves identically to the trained desktop model.

import CoreGraphics

enum RLEncoder {
    static let featureDim = 56
    static let stackK = 3
    static let stackedDim = featureDim * stackK

    /// Encode `self`'s view of the world into `out`. Caller must pass an
    /// array of at least `featureDim` elements (we mutate in place).
    static func encode(self_ s: Player, opp o: Player, ball b: Ball, field f: Field,
                       timeLeftMs: Double, scoreDiff: Int, kickoffActive: Bool,
                       out: inout [Float]) {
        let isRed = (s.team == .red)
        let fw = f.width
        let fh = f.height
        let fx = f.x
        let fy = f.y
        let maxBallSpeed = Float(GameConstants.maxBallSpeed)

        // Side-coord helpers (red passes through; blue mirrors x)
        @inline(__always) func sideX(_ x: CGFloat) -> Float {
            isRed ? Float((x - fx) / fw) : Float((fx + fw - x) / fw)
        }
        @inline(__always) func sideY(_ y: CGFloat) -> Float {
            Float((y - fy) / fh)
        }
        @inline(__always) func sideVx(_ vx: CGFloat) -> Float {
            (isRed ? Float(vx) : -Float(vx)) / maxBallSpeed
        }
        @inline(__always) func sideVy(_ vy: CGFloat) -> Float {
            Float(vy) / maxBallSpeed
        }

        var i = 0
        // --- Self (14)
        out[i] = sideX(s.pos.x) * 2 - 1; i += 1
        out[i] = sideY(s.pos.y) * 2 - 1; i += 1
        out[i] = sideVx(s.vel.x); i += 1
        out[i] = sideVy(s.vel.y); i += 1
        out[i] = Float(min(s.kickCooldownMs / 200, 1)); i += 1
        out[i] = Float(min(s.pullCooldownMs / 8000, 1)); i += 1
        out[i] = s.powerUp == .speed ? 1 : 0; i += 1
        out[i] = s.powerUp == .ghost ? 1 : 0; i += 1
        out[i] = s.powerUp == .shield ? 1 : 0; i += 1
        out[i] = s.powerUp == .dash ? 1 : 0; i += 1
        out[i] = s.powerUp == .frozen ? 1 : 0; i += 1
        out[i] = s.powerUp == .slowed ? 1 : 0; i += 1
        out[i] = s.stunMs > 0 ? 1 : 0; i += 1
        out[i] = s.pullActive ? 1 : 0; i += 1

        // --- Opp (10) — relative
        out[i] = sideX(o.pos.x) - sideX(s.pos.x); i += 1
        out[i] = sideY(o.pos.y) - sideY(s.pos.y); i += 1
        out[i] = sideVx(o.vel.x); i += 1
        out[i] = sideVy(o.vel.y); i += 1
        out[i] = Float(min(o.kickCooldownMs / 200, 1)); i += 1
        out[i] = o.powerUp == .speed ? 1 : 0; i += 1
        out[i] = o.powerUp == .ghost ? 1 : 0; i += 1
        out[i] = o.powerUp == .shield ? 1 : 0; i += 1
        out[i] = o.powerUp == .dash ? 1 : 0; i += 1
        out[i] = (o.stunMs > 0 || o.powerUp == .frozen) ? 1 : 0; i += 1

        // --- Ball (9)
        let bx = sideX(b.pos.x)
        let by = sideY(b.pos.y)
        out[i] = bx - sideX(s.pos.x); i += 1
        out[i] = by - sideY(s.pos.y); i += 1
        out[i] = sideVx(b.vel.x); i += 1
        out[i] = sideVy(b.vel.y); i += 1
        out[i] = b.superKick > 0 ? 1 : 0; i += 1
        out[i] = b.ghost ? 1 : 0; i += 1
        let poss: Float = (b.lastKickedBy === s) ? 1 : (b.lastKickedBy === o ? -1 : 0)
        out[i] = poss; i += 1
        out[i] = bx - sideX(o.pos.x); i += 1
        out[i] = by - sideY(o.pos.y); i += 1

        // --- Predicted ball 15 frames ahead (4)
        let pred = predictBall(b, frames: 15)
        let pbx = sideX(pred.x)
        let pby = sideY(pred.y)
        out[i] = pbx - sideX(s.pos.x); i += 1
        out[i] = pby - sideY(s.pos.y); i += 1
        out[i] = pbx - bx; i += 1
        out[i] = pby - by; i += 1

        // --- Goals (3)
        out[i] = 0 - sideX(s.pos.x); i += 1
        out[i] = 1 - sideX(s.pos.x); i += 1
        let goalCenterY = Float((f.goalY + f.goalHeight / 2 - fy) / fh)
        out[i] = goalCenterY - sideY(s.pos.y); i += 1

        // --- Game state (3)
        out[i] = Float(timeLeftMs / 60000); i += 1
        out[i] = tanhf(Float(scoreDiff) * 0.5); i += 1
        out[i] = kickoffActive ? 1 : 0; i += 1

        // --- Shooting features (8)
        let kickRange = Float(s.radius + b.radius + 21)
        let dRaw = Float(((b.pos.x - s.pos.x) * (b.pos.x - s.pos.x)
                       + (b.pos.y - s.pos.y) * (b.pos.y - s.pos.y)).squareRoot())
        let inKickRange: Float = dRaw < kickRange ? 1 : 0
        out[i] = inKickRange; i += 1
        let kdx = Float(b.pos.x - s.pos.x)
        let kdy = Float(b.pos.y - s.pos.y)
        let klen = max((kdx * kdx + kdy * kdy).squareRoot(), 1)
        let knx = kdx / klen
        let kny = kdy / klen
        let oppGoalX = isRed ? Float(fx + fw) : Float(fx)
        let goalCenterAbsY = Float(f.goalY + f.goalHeight / 2)
        let tgx = oppGoalX - Float(b.pos.x)
        let tgy = goalCenterAbsY - Float(b.pos.y)
        let tglen = max((tgx * tgx + tgy * tgy).squareRoot(), 1)
        let tnx = tgx / tglen
        let tny = tgy / tglen
        let aimDot = knx * tnx + kny * tny
        out[i] = aimDot; i += 1
        out[i] = (aimDot > 0.7 && inKickRange == 1) ? 1 : 0; i += 1
        let perp = abs(kdx * tny - kdy * tnx)
        out[i] = min(perp / Float(fw), 1); i += 1
        out[i] = (isRed ? tgx : -tgx) / Float(fw); i += 1
        out[i] = tgy / Float(fh); i += 1
        let opx = Float(o.pos.x - b.pos.x)
        let opy = Float(o.pos.y - b.pos.y)
        let oprojF = opx * tnx + opy * tny
        let oprojP = abs(opx * tny - opy * tnx)
        let oppInLane: Float = (oprojF > 0 && oprojF < tglen && oprojP < 50) ? 1 : 0
        out[i] = oppInLane; i += 1
        out[i] = min(tglen / Float(fw), 1); i += 1

        // Pad zeros up to featureDim
        while i < featureDim { out[i] = 0; i += 1 }
    }

    private static func predictBall(_ ball: Ball, frames: Int) -> Vec2 {
        var x = ball.pos.x, y = ball.pos.y
        var vx = ball.vel.x, vy = ball.vel.y
        let f = GameConstants.ballFriction
        for _ in 0..<frames {
            vx *= f; vy *= f
            x += vx; y += vy
        }
        return Vec2(x, y)
    }
}

/// Ring-buffer style frame stack.
final class FrameStack {
    let featureDim: Int
    let k: Int
    private var frames: [[Float]] = []
    private(set) var stacked: [Float]

    init(featureDim: Int, k: Int) {
        self.featureDim = featureDim
        self.k = k
        self.stacked = [Float](repeating: 0, count: featureDim * k)
    }

    func fill(_ frame: [Float]) {
        frames = Array(repeating: frame, count: k)
        rebuild()
    }
    func push(_ frame: [Float]) {
        if frames.count == k { frames.removeFirst() }
        frames.append(frame)
        rebuild()
    }
    private func rebuild() {
        for i in 0..<k {
            let base = i * featureDim
            let f = frames[i]
            for j in 0..<featureDim { stacked[base + j] = f[j] }
        }
    }
}
