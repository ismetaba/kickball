// SpriteKit scene that renders the GameEngine state.
//
// Design choices:
//   - One persistent set of nodes per entity, repositioned every frame
//     (no churn-creating nodes per tick).
//   - We treat the engine's virtual coords as our scene coords directly;
//     the SKScene's `scaleMode = .aspectFit` handles fitting to screen.
//   - The camera tracks the ball center for a soft-follow feel.
//
// The engine itself is the source of truth — this file is read-only on
// game state, write-only on visuals.

import SpriteKit

final class GameScene: SKScene {
    weak var engine: GameEngine?

    private var fieldNode: SKNode!
    private var ballNode: SKShapeNode!
    private var playerNodes: [Player: SKNode] = [:]
    private var goalNotificationLabel: SKLabelNode!
    private var lastGoalCelebTeam: Team? = nil

    private let cam = SKCameraNode()

    override func didMove(to view: SKView) {
        backgroundColor = SKColor(red: 0.04, green: 0.05, blue: 0.10, alpha: 1)
        scaleMode = .aspectFit
        camera = cam
        addChild(cam)

        guard let engine = engine else { return }
        size = CGSize(width: engine.field.canvasW, height: engine.field.canvasH)
        cam.position = CGPoint(x: engine.field.centerX, y: engine.field.centerY)

        buildField(engine.field)
        buildBall()
        buildPlayers(engine.players)
        buildGoalNotification()
    }

    override func update(_ currentTime: TimeInterval) {
        guard let engine = engine else { return }
        engine.tick(currentTime)
        renderFrame(engine: engine)
    }

    // MARK: - Build static visuals

    private func buildField(_ field: Field) {
        let fn = SKNode()
        fn.zPosition = 0
        fieldNode = fn
        addChild(fn)

        // Outer pitch
        let outer = SKShapeNode(rect: CGRect(x: field.x, y: field.y,
                                             width: field.width, height: field.height),
                                cornerRadius: 8)
        outer.strokeColor = SKColor(red: 0.30, green: 0.83, blue: 1.0, alpha: 0.7)
        outer.lineWidth = 4
        outer.fillColor = SKColor(red: 0.04, green: 0.07, blue: 0.18, alpha: 1.0)
        fn.addChild(outer)

        // Halfway line
        let half = SKShapeNode()
        let halfPath = CGMutablePath()
        halfPath.move(to: CGPoint(x: field.centerX, y: field.y))
        halfPath.addLine(to: CGPoint(x: field.centerX, y: field.y + field.height))
        half.path = halfPath
        half.strokeColor = SKColor(red: 0.30, green: 0.83, blue: 1.0, alpha: 0.5)
        half.lineWidth = 2
        fn.addChild(half)

        // Center circle
        let circle = SKShapeNode(circleOfRadius: field.centerRadius)
        circle.position = CGPoint(x: field.centerX, y: field.centerY)
        circle.strokeColor = SKColor(red: 0.30, green: 0.83, blue: 1.0, alpha: 0.5)
        circle.lineWidth = 2
        fn.addChild(circle)

        // Goals (left and right)
        for isLeft in [true, false] {
            let mouthX = isLeft ? field.x : field.x + field.width
            let backX = isLeft ? mouthX - field.goalDepth : mouthX + field.goalDepth
            let g = SKShapeNode(rect: CGRect(x: min(mouthX, backX),
                                             y: field.goalTop,
                                             width: field.goalDepth,
                                             height: field.goalHeight))
            g.strokeColor = SKColor.white.withAlphaComponent(0.7)
            g.lineWidth = 3
            g.fillColor = SKColor(red: 0.15, green: 0.20, blue: 0.40, alpha: 0.7)
            fn.addChild(g)
        }
    }

    private func buildBall() {
        let n = SKShapeNode(circleOfRadius: 14)
        n.fillColor = SKColor.white
        n.strokeColor = SKColor(white: 0.8, alpha: 1)
        n.lineWidth = 1
        n.zPosition = 5
        ballNode = n
        addChild(n)
    }

    private func buildPlayers(_ players: [Player]) {
        for p in players {
            let n = playerNode(for: p)
            playerNodes[p] = n
            addChild(n)
        }
    }

    // Tear down the old player nodes and build a fresh set (used on rematch,
    // when the engine's Player instances have been replaced).
    private func rebuildPlayers(_ players: [Player]) {
        for n in playerNodes.values { n.removeFromParent() }
        playerNodes.removeAll()
        buildPlayers(players)
    }

    private func playerNode(for p: Player) -> SKNode {
        let group = SKNode()
        group.zPosition = 4
        let body = SKShapeNode(circleOfRadius: p.radius)
        body.fillColor = (p.team == .red)
            ? SKColor(red: 1.0, green: 0.30, blue: 0.43, alpha: 1.0)
            : SKColor(red: 0.30, green: 0.83, blue: 1.0, alpha: 1.0)
        body.strokeColor = SKColor.white.withAlphaComponent(0.8)
        body.lineWidth = 2
        body.name = "body"
        group.addChild(body)
        if p.isHuman {
            // Ring to mark the human-controlled player
            let ring = SKShapeNode(circleOfRadius: p.radius + 6)
            ring.strokeColor = SKColor(red: 1.0, green: 0.83, blue: 0.20, alpha: 0.9)
            ring.lineWidth = 2.5
            ring.fillColor = .clear
            group.addChild(ring)
        }
        return group
    }

    private func buildGoalNotification() {
        let l = SKLabelNode(fontNamed: "AvenirNext-Heavy")
        l.text = "GOAL!"
        l.fontSize = 96
        l.zPosition = 99
        l.alpha = 0
        l.verticalAlignmentMode = .center
        l.horizontalAlignmentMode = .center
        goalNotificationLabel = l
        cam.addChild(l)
    }

    // MARK: - Per-frame render

    private func renderFrame(engine: GameEngine) {
        // A rematch replaces every Player with a new instance. Our identity-keyed
        // node map would then miss them all (players frozen) until the nodes are
        // rebuilt. Detect the swap cheaply (the first roster member is no longer
        // a known key) and rebuild.
        if let first = engine.players.first, playerNodes[first] == nil {
            rebuildPlayers(engine.players)
        }

        ballNode.position = CGPoint(x: engine.ball.pos.x, y: engine.ball.pos.y)

        for p in engine.players {
            if let n = playerNodes[p] {
                n.position = CGPoint(x: p.pos.x, y: p.pos.y)
            }
        }

        // Soft camera follow (lerp to ball)
        let target = CGPoint(x: engine.ball.pos.x, y: engine.ball.pos.y)
        cam.position = CGPoint(
            x: cam.position.x + (target.x - cam.position.x) * 0.08,
            y: cam.position.y + (target.y - cam.position.y) * 0.08
        )

        // Goal celebration
        if let team = engine.goalCelebrationTeam, team != lastGoalCelebTeam {
            lastGoalCelebTeam = team
            goalNotificationLabel.text = (team == .red) ? "RED SCORES!" : "BLUE SCORES!"
            goalNotificationLabel.fontColor = (team == .red)
                ? SKColor(red: 1.0, green: 0.30, blue: 0.43, alpha: 1.0)
                : SKColor(red: 0.30, green: 0.83, blue: 1.0, alpha: 1.0)
            goalNotificationLabel.alpha = 0
            goalNotificationLabel.run(.sequence([
                .group([.fadeIn(withDuration: 0.25), .scale(to: 1.2, duration: 0.25)]),
                .wait(forDuration: 1.5),
                .fadeOut(withDuration: 0.5),
            ]))
        } else if engine.goalCelebrationTeam == nil {
            lastGoalCelebTeam = nil
        }
    }
}
