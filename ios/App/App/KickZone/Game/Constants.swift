// Game tuning constants — direct port of shared/physics.js + constants.js.
//
// Keeping these in one place mirrors the JS layout so cross-checking
// behaviour against the web version is trivial.

import CoreGraphics

enum GameConstants {
    static let tickRate: Double = 60
    static let tickSeconds: Double = 1.0 / 60.0

    // Map sizes (virtual coordinates — same as JS web build)
    enum Map: String { case big, classic, huge }
    static let mapSizes: [Map: (w: CGFloat, h: CGFloat)] = [
        .big:     (800, 500),
        .classic: (1500, 1000),
        .huge:    (2400, 1600),
    ]

    // Physics — direct port of shared/physics.js Physics object
    static let gameSpeed: CGFloat = 1.2
    static let friction: CGFloat = 0.955            // player friction per frame
    static let ballFriction: CGFloat = 0.993        // ball friction per frame
    static let wallBounce: CGFloat = 0.5
    static let playerBounce: CGFloat = 0.5
    static let ballBounce: CGFloat = 0.35
    static let maxPlayerSpeed: CGFloat = 5.2
    static let maxBallSpeed: CGFloat = 30
    static let kickForce: CGFloat = 9.5
    static let powerKickForce: CGFloat = 9.8
    static let playerAccel: CGFloat = 0.21
    static let kickCooldownMs: Double = 180
    static let pullCooldownMs: Double = 8000
    static let pullDurationMs: Double = 1000
    static let pullMaxRange: CGFloat = 150

    // Match
    static let defaultMatchSeconds: Int = 180
    static let kickoffDurationMs: Double = 1500
    static let goalCelebrationMs: Double = 2500
}

enum Team: String {
    case red, blue
    var opposite: Team { self == .red ? .blue : .red }
}
