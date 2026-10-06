// GameEngine — the heart of the simulation. Owns players, ball, field,
// drives the per-tick loop. Delegates rendering to SpriteKit nodes that
// observe via the `tick(...)` callback.
//
// This is a port of the relevant chunks of js/game.js — specifically the
// per-tick simulation pipeline:
//   1. Read human input (from controls)
//   2. Run AI controllers for non-human players
//   3. Apply kick decisions
//   4. Update entity physics
//   5. Apply pull (ball attraction) for any active pulls
//   6. Resolve collisions (ball-player, player-player)
//   7. Constrain to field
//   8. Super-kick homing (if active)
//   9. Check goal
//   10. Tick match clock + sudden death etc.

import CoreGraphics
import Combine
import QuartzCore   // CACurrentMediaTime

enum Difficulty: String, CaseIterable, Identifiable {
    case normal, expert
    var id: String { rawValue }
}

struct MatchSettings {
    var teamSize: Int = 1
    var durationSeconds: Int = 180
    var goalLimit: Int = 5
    var difficulty: Difficulty = .normal
    var map: GameConstants.Map = .classic
}

/// Live game state observed by SwiftUI views.
final class GameEngine: ObservableObject {

    // MARK: - Public observable state
    @Published private(set) var redScore: Int = 0
    @Published private(set) var blueScore: Int = 0
    // Whole-seconds clock for the HUD. The high-frequency `timeRemainingMs` is
    // deliberately NOT @Published — publishing it every tick forced a full
    // SwiftUI body re-evaluation ~60x/sec. Views bind to `displaySeconds`, which
    // changes only ~1x/sec.
    @Published private(set) var displaySeconds: Int = 180
    private(set) var timeRemainingMs: Double = 180_000
    @Published private(set) var isRunning: Bool = false
    @Published private(set) var isPaused: Bool = false
    @Published private(set) var matchOver: Bool = false
    @Published private(set) var goalCelebrationTeam: Team? = nil

    // MARK: - Live entities (read-only; only the engine mutates these)
    private(set) var field: Field
    private(set) var ball: Ball
    private(set) var players: [Player] = []
    private(set) var humanPlayer: Player? = nil

    // Per-team roster caches, rebuilt only when the roster changes (match start).
    // Avoids allocating two fresh arrays per AI per tick in the step loop.
    private var redPlayers: [Player] = []
    private var bluePlayers: [Player] = []

    // Input from controls layer (set externally)
    var humanInputDir: Vec2 = .zero
    var humanIsCharging: Bool = false
    var humanChargeStartMs: Double = 0
    var humanKickRelease: Bool = false
    var humanPull: Bool = false

    // AI bindings
    private var aiBindings: [(player: Player, ai: AgentController)] = []

    // Settings + clock. `settings` is set by the view before startMatch().
    var settings: MatchSettings
    private var lastTickTime: CFTimeInterval = 0
    private var goalCelebrationRemainingMs: Double = 0
    private var kickoffActive: Bool = false
    private var kickoffTeam: Team? = nil

    // RL agent factory (provided by app — returns a fresh runtime agent
    // with the trained policy, or nil if no model bundled).
    var expertAgentFactory: (() -> AgentController?)? = nil

    // MARK: - Init

    init(settings: MatchSettings = .init()) {
        self.settings = settings
        let (w, h) = GameConstants.mapSizes[settings.map] ?? (1500, 1000)
        self.field = Field(canvasW: w, canvasH: h, mapType: settings.map)
        self.ball = Ball(pos: Vec2(field.centerX, field.centerY))
    }

    // MARK: - Match lifecycle

    func startMatch() {
        let (w, h) = GameConstants.mapSizes[settings.map] ?? (1500, 1000)
        self.field = Field(canvasW: w, canvasH: h, mapType: settings.map)
        self.ball = Ball(pos: Vec2(field.centerX, field.centerY))

        players = []
        aiBindings = []
        let positions = spawnPositions()

        // Red team: index 0 is human
        for i in 0..<settings.teamSize {
            let isHuman = (i == 0)
            let p = Player(pos: positions.red[i], team: .red, isHuman: isHuman)
            players.append(p)
            if isHuman {
                humanPlayer = p
            } else {
                aiBindings.append((p, makeAI()))
            }
        }
        // Blue team: all AI
        for i in 0..<settings.teamSize {
            let p = Player(pos: positions.blue[i], team: .blue)
            players.append(p)
            aiBindings.append((p, makeAI()))
        }

        // Cache team rosters once (stable for the whole match).
        redPlayers = players.filter { $0.team == .red }
        bluePlayers = players.filter { $0.team == .blue }

        redScore = 0
        blueScore = 0
        timeRemainingMs = Double(settings.durationSeconds) * 1000
        displaySeconds = settings.durationSeconds
        isRunning = true
        isPaused = false
        matchOver = false
        goalCelebrationTeam = nil
        goalCelebrationRemainingMs = 0
        kickoffActive = false
        lastTickTime = CACurrentMediaTime()
    }

    func pause() { isPaused = true }
    func resume() { isPaused = false; lastTickTime = CACurrentMediaTime() }
    func stop() {
        isRunning = false
        isPaused = false
    }

    // MARK: - Tick

    /// Called every frame from the renderer. Computes dt internally.
    func tick(_ now: CFTimeInterval) {
        guard isRunning, !isPaused, !matchOver else { return }
        let dt = max(0, min(now - lastTickTime, 0.1)) * 1000.0  // ms, capped at 100ms
        lastTickTime = now
        if dt < 0.5 { return }
        step(dtMs: dt)
    }

    /// One simulation step. Mirrors js/game.js loop().
    private func step(dtMs: Double) {
        let dtRatio = CGFloat((dtMs / 16.67) * Double(GameConstants.gameSpeed))

        // Goal celebration pause
        if goalCelebrationRemainingMs > 0 {
            goalCelebrationRemainingMs -= dtMs
            if goalCelebrationRemainingMs <= 0 {
                goalCelebrationTeam = nil
                resetForKickoff()
            }
            return
        }

        // Match clock. Publish only the whole-seconds value (and only when it
        // changes) so the HUD updates ~1x/sec instead of invalidating the view
        // tree every frame.
        timeRemainingMs -= dtMs
        if timeRemainingMs <= 0 {
            timeRemainingMs = 0
            if displaySeconds != 0 { displaySeconds = 0 }
            matchOver = true
            return
        }
        let secs = Int(timeRemainingMs / 1000)   // floor, matches prior HUD display
        if secs != displaySeconds { displaySeconds = secs }

        // 1. Human input → human player
        if let hp = humanPlayer, hp.stunMs <= 0, hp.powerUp != .frozen {
            let dir = humanInputDir
            let len = dir.length
            if len > 0.001 {
                let n = Vec2(min(dir.x / max(len, 1), 1), min(dir.y / max(len, 1), 1))
                hp.applyInput(n, dtRatio: dtRatio)
            }
            // Charge / release kick
            if humanIsCharging {
                hp.kickChargeRatio = min(humanChargeMs() / 1500.0, 1.0)
            }
            if humanKickRelease {
                let charge = hp.kickChargeRatio
                hp.kickChargeRatio = 0
                humanIsCharging = false
                humanKickRelease = false
                hp.kick(ball, chargeRatio: charge)
            }
            if humanPull { hp.activatePull() }
        }

        // 2. AI turns
        for binding in aiBindings {
            let p = binding.player
            if p.stunMs > 0 || p.powerUp == .frozen { continue }
            let mates = (p.team == .red) ? redPlayers : bluePlayers
            let opps = (p.team == .red) ? bluePlayers : redPlayers
            let intent = binding.ai.update(player: p, ball: ball, field: field,
                                           teammates: mates, opponents: opps,
                                           dtMs: dtMs, dtRatio: dtRatio)
            if intent.kick { p.kick(ball, chargeRatio: intent.chargeRatio) }
        }

        // 3. Update entities
        for p in players { p.update(dtMs: dtMs, dtRatio: dtRatio) }
        ball.update(dtMs: dtMs, dtRatio: dtRatio)

        // 4. Pull (ball attraction toward active pullers)
        for p in players where p.pullActive {
            let d = dist(p.pos, ball.pos)
            if d >= GameConstants.pullMaxRange {
                p.pullActive = false
                p.pullCooldownMs = GameConstants.pullCooldownMs
            } else if d > p.radius + ball.radius + 5 {
                let toPlayer = (p.pos - ball.pos).normalized()
                let falloff = 1 - (d / GameConstants.pullMaxRange)
                let strength = 0.25 * falloff * dtRatio
                ball.vel += toPlayer * strength
                ball.vel *= pow(0.985, dtRatio)
            }
        }

        // 5. Collisions
        for p in players {
            if !ball.ghost {
                Physics.resolveCircleCollision(p, ball)
            }
        }
        for i in 0..<players.count {
            for j in (i+1)..<players.count {
                Physics.resolveCircleCollision(players[i], players[j])
            }
        }

        // 6. Field constraints
        for p in players { Physics.constrainToField(p, field) }
        Physics.constrainToField(ball, field)

        // 7. Super-kick homing
        if ball.superKick > 0, let target = ball.superTarget {
            let s = ball.vel.length
            if s > 3 {
                let goalX: CGFloat = (target == .right) ? field.x + field.width : field.x
                let goalY = field.goalY + field.goalHeight / 2
                let toGoal = (Vec2(goalX, goalY) - ball.pos).normalized()
                let steer: CGFloat = 0.12 * dtRatio
                ball.vel += toGoal * steer
                let cur = ball.vel.length
                if cur > 0 { ball.vel *= (s / cur) }   // maintain speed
            } else {
                ball.superTarget = nil
            }
        }

        // 8. Goal check
        if let scorer = Physics.checkGoal(ball, field) {
            if scorer == .red { redScore += 1 } else { blueScore += 1 }
            goalCelebrationTeam = scorer
            goalCelebrationRemainingMs = GameConstants.goalCelebrationMs
            kickoffTeam = scorer.opposite
            // Goal-limit check
            if settings.goalLimit > 0 {
                if redScore >= settings.goalLimit || blueScore >= settings.goalLimit {
                    matchOver = true
                }
            }
        }
    }

    private func resetForKickoff() {
        for p in players { p.reset() }
        ball.reset()
    }

    // MARK: - Helpers

    private func spawnPositions() -> (red: [Vec2], blue: [Vec2]) {
        let f = field
        var red: [Vec2] = [], blue: [Vec2] = []
        let redBaseX = f.x + f.width * 0.25
        let blueBaseX = f.x + f.width * 0.75
        if settings.teamSize == 1 {
            red.append(Vec2(redBaseX, f.centerY))
            blue.append(Vec2(blueBaseX, f.centerY))
        } else {
            let spacing = f.height / CGFloat(settings.teamSize + 1)
            for i in 0..<settings.teamSize {
                let y = f.y + spacing * CGFloat(i + 1)
                let dx: CGFloat = (i == 0) ? -30 : 30
                red.append(Vec2(redBaseX + dx, y))
                blue.append(Vec2(blueBaseX - dx, y))
            }
        }
        return (red, blue)
    }

    private func makeAI() -> AgentController {
        if settings.difficulty == .expert, let agent = expertAgentFactory?() {
            return agent
        }
        return AIController()
    }

    private func humanChargeMs() -> Double {
        max(0, CACurrentMediaTime() * 1000.0 - humanChargeStartMs)
    }
}
