// Runtime RL agent — drop-in AgentController backed by a trained PolicyNet.
// Each player gets its own RLAgent (with its own frame stack), but they all
// share the same PolicyNet weights via a class wrapper.
//
// Decision rate: ~30 Hz (every other physics tick). Same as the JS runtime.

import CoreGraphics

final class RLAgent: AgentController {
    private let policy: PolicyNet
    private let stack: FrameStack
    private var stackPrimed = false
    private var reactionTimerMs: Double = 0
    private var lastMove: Vec2 = .zero
    private var lastCharge: CGFloat = 0
    private var lastKick: Bool = false
    private var lastPull: Bool = false
    private var obsScratch: [Float]

    init(policy: PolicyNet) {
        self.policy = policy
        self.stack = FrameStack(featureDim: RLEncoder.featureDim, k: RLEncoder.stackK)
        self.obsScratch = [Float](repeating: 0, count: RLEncoder.featureDim)
    }

    func update(player: Player, ball: Ball, field: Field,
                teammates: [Player], opponents: [Player],
                dtMs: Double, dtRatio: CGFloat) -> KickIntent {
        // Reaction tick: re-decide every 30ms
        reactionTimerMs -= dtMs
        if reactionTimerMs <= 0 {
            reactionTimerMs = 30
            // Pick the closest opponent as "the" opponent for 1v1 obs (in 2v2
            // we'd use the 2v2 encoder; this Swift port currently ships only
            // the 1v1 model — multiplayer/2v2 inference is a follow-on).
            let opp = opponents.first ?? player
            // (Simplified game state — runtime doesn't need real time/score
            // beyond what the trained model has seen at training time.)
            RLEncoder.encode(self_: player, opp: opp, ball: ball, field: field,
                             timeLeftMs: 60_000, scoreDiff: 0, kickoffActive: false,
                             out: &obsScratch)
            if !stackPrimed {
                stack.fill(obsScratch)
                stackPrimed = true
            } else {
                stack.push(obsScratch)
            }
            let raw = policy.forward(stack.stacked)
            let dec = PolicyNet.decodeDeterministic(raw)
            let isRed = (player.team == .red)
            let worldVx: CGFloat = isRed ? CGFloat(dec.moveX) : -CGFloat(dec.moveX)
            let worldVy: CGFloat = CGFloat(dec.moveY)
            lastMove = Vec2(worldVx, worldVy)
            lastCharge = CGFloat(dec.charge)
            lastKick = dec.kick
            lastPull = dec.pull
        }
        // Apply movement every physics tick (smoother than only re-deciding)
        let len = lastMove.length
        if len > 0.001 {
            player.applyInput(Vec2(lastMove.x / max(len, 1),
                                   lastMove.y / max(len, 1)),
                              dtRatio: dtRatio)
        }
        if lastPull { _ = player.activatePull() }
        return KickIntent(kick: lastKick, chargeRatio: lastCharge)
    }
}

// MARK: - Loading

enum RLAgentLoader {
    /// Try to load the bundled gen 1325 model from the app's main bundle.
    /// File is included as `kickzone-rl-gen1325.json` under Resources.
    static func loadBundledPolicy() -> PolicyNet? {
        guard let url = Bundle.main.url(forResource: "kickzone-rl-gen1325", withExtension: "json") else {
            print("[RL] no bundled model file found in app bundle")
            return nil
        }
        do {
            let data = try Data(contentsOf: url)
            let policy = try PolicyNet.load(jsonData: data)
            print("[RL] loaded bundled model — inDim=\(policy.inDim) hidden=\(policy.hidden)")
            return policy
        } catch {
            print("[RL] failed to load bundled model: \(error)")
            return nil
        }
    }
}
