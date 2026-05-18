// Lightweight 2D vector math for game physics.
//
// We avoid SIMD for clarity and to keep the code easy to debug — at the
// scale of one game loop tick (a handful of players + 1 ball + collisions)
// the perf difference is irrelevant.

import CoreGraphics

struct Vec2: Equatable {
    var x: CGFloat
    var y: CGFloat

    init(_ x: CGFloat, _ y: CGFloat) { self.x = x; self.y = y }
    init(x: CGFloat, y: CGFloat) { self.x = x; self.y = y }

    static let zero = Vec2(0, 0)

    var lengthSq: CGFloat { x * x + y * y }
    var length: CGFloat { lengthSq.squareRoot() }

    func normalized() -> Vec2 {
        let l = length
        return l > 0 ? Vec2(x / l, y / l) : .zero
    }

    static func + (lhs: Vec2, rhs: Vec2) -> Vec2 { Vec2(lhs.x + rhs.x, lhs.y + rhs.y) }
    static func - (lhs: Vec2, rhs: Vec2) -> Vec2 { Vec2(lhs.x - rhs.x, lhs.y - rhs.y) }
    static func * (lhs: Vec2, rhs: CGFloat) -> Vec2 { Vec2(lhs.x * rhs, lhs.y * rhs) }
    static func * (lhs: CGFloat, rhs: Vec2) -> Vec2 { Vec2(lhs * rhs.x, lhs * rhs.y) }
    static func / (lhs: Vec2, rhs: CGFloat) -> Vec2 { Vec2(lhs.x / rhs, lhs.y / rhs) }
    static prefix func - (v: Vec2) -> Vec2 { Vec2(-v.x, -v.y) }
    static func += (lhs: inout Vec2, rhs: Vec2) { lhs.x += rhs.x; lhs.y += rhs.y }
    static func -= (lhs: inout Vec2, rhs: Vec2) { lhs.x -= rhs.x; lhs.y -= rhs.y }
    static func *= (lhs: inout Vec2, rhs: CGFloat) { lhs.x *= rhs; lhs.y *= rhs }
}

func dot(_ a: Vec2, _ b: Vec2) -> CGFloat { a.x * b.x + a.y * b.y }
func dist(_ a: Vec2, _ b: Vec2) -> CGFloat { (a - b).length }
func distSq(_ a: Vec2, _ b: Vec2) -> CGFloat { (a - b).lengthSq }
