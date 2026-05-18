// Rule-based AI — port of shared/ai.js AIController.
// Behaviour-equivalent to the JS version: chase ball, position behind it
// pointing at goal, shoot when aimed, refuse to kick toward own goal.

import CoreGraphics

protocol AgentController: AnyObject {
    /// Called every physics tick. The controller may apply input on the
    /// player and return whether to kick this tick (along with charge).
    func update(player: Player, ball: Ball, field: Field,
                teammates: [Player], opponents: [Player],
                dtMs: Double, dtRatio: CGFloat) -> KickIntent
}

struct KickIntent { let kick: Bool; let chargeRatio: CGFloat }

final class AIController: AgentController {
    private var targetX: CGFloat = 0
    private var targetY: CGFloat = 0
    private var decisionTimerMs: Double = 0
    private var role: Role = .attack

    private let reactionTimeMs: Double = 40
    private let reactionJitterMs: Double = 30
    private let accuracy: CGFloat = 1.0
    private let kickRangeMul: CGFloat = 1.0
    private let positioningSkill: CGFloat = 1.0
    private let interceptFrames: Int = 12
    private let aimThreshold: CGFloat = 0.35
    private let moveDiv: CGFloat = 16

    enum Role { case attack, defend, support }

    func update(player: Player, ball: Ball, field: Field,
                teammates: [Player], opponents: [Player],
                dtMs: Double, dtRatio: CGFloat) -> KickIntent {
        decisionTimerMs -= dtMs
        if decisionTimerMs > 0 {
            moveToTarget(player: player)
            return KickIntent(kick: false, chargeRatio: 0.3)
        }
        decisionTimerMs = reactionTimeMs + Double.random(in: 0..<reactionJitterMs)

        assignRole(player: player, ball: ball, field: field, teammates: teammates)

        let distToBall = dist(player.pos, ball.pos)
        let kickDist = (player.radius + ball.radius + 8) * kickRangeMul
        let predicted = predictBall(ball, frames: interceptFrames)

        switch role {
        case .attack:
            playAttack(player: player, ball: ball, field: field, opponents: opponents, distToBall: distToBall, predicted: predicted)
        case .defend:
            playDefend(player: player, ball: ball, field: field, distToBall: distToBall, predicted: predicted)
        case .support:
            playSupport(player: player, ball: ball, field: field, opponents: opponents, teammates: teammates)
        }

        var kick = false
        var charge: CGFloat = 0.3
        if distToBall < kickDist {
            let r = decideKick(player: player, ball: ball, field: field, opponents: opponents)
            kick = r.kick; charge = r.chargeRatio
        }
        moveToTarget(player: player)
        return KickIntent(kick: kick, chargeRatio: charge)
    }

    // MARK: - Role assignment

    private func assignRole(player: Player, ball: Ball, field: Field, teammates: [Player]) {
        if teammates.count <= 1 { role = .attack; return }
        let d = dist(player.pos, ball.pos)
        var rank = 0
        for t in teammates where t !== player {
            if dist(t.pos, ball.pos) < d { rank += 1 }
        }
        let ballOnOurSide = (player.team == .red) ? (ball.pos.x < field.centerX) : (ball.pos.x > field.centerX)
        let prev = role
        var newRole: Role
        if rank == 0 { newRole = .attack }
        else if ballOnOurSide { newRole = .defend }
        else { newRole = .support }

        // Hysteresis: don't drop attack role unless clearly not closest
        if prev == .attack && newRole != .attack {
            var closestOther: CGFloat = .infinity
            for t in teammates where t !== player {
                let td = dist(t.pos, ball.pos)
                if td < closestOther { closestOther = td }
            }
            if d < closestOther * 1.2 { newRole = .attack }
        }
        role = newRole
    }

    // MARK: - Behaviours

    private func playAttack(player: Player, ball: Ball, field: Field,
                            opponents: [Player], distToBall: CGFloat, predicted: Vec2) {
        if distToBall > 35 {
            let ownGoalX = (player.team == .red) ? field.x : field.x + field.width
            let playerToOwnGoal = abs(player.pos.x - ownGoalX)
            let ballToOwnGoal = abs(predicted.x - ownGoalX)
            let ballSpeedTowardGoal = (player.team == .red) ? -ball.vel.x : ball.vel.x
            let ballMovingTowardOwnGoal = ballSpeedTowardGoal > 3
            if ballMovingTowardOwnGoal && distToBall < 100 {
                let sideOffset: CGFloat = (player.pos.y > predicted.y) ? 30 : -30
                let awayFromGoal: CGFloat = (player.team == .red) ? 15 : -15
                targetX = predicted.x + awayFromGoal
                targetY = predicted.y + sideOffset
            } else if playerToOwnGoal > ballToOwnGoal && distToBall < 80 {
                let goalSideOffset: CGFloat = (player.team == .red) ? -25 : 25
                targetX = predicted.x + goalSideOffset
                targetY = predicted.y
            } else {
                targetX = predicted.x
                targetY = predicted.y
            }
        } else {
            let target = chooseBestTarget(player: player, ball: ball, field: field, opponents: opponents)
            let toTarget = (target - ball.pos).normalized()
            targetX = ball.pos.x - toTarget.x * 22
            targetY = ball.pos.y - toTarget.y * 22
        }
    }

    private func playDefend(player: Player, ball: Ball, field: Field,
                            distToBall: CGFloat, predicted: Vec2) {
        let ownGoalX = (player.team == .red) ? field.x : field.x + field.width
        let goalCenterY = field.goalY + field.goalHeight / 2
        let ballOnOurSide = (player.team == .red) ? (ball.pos.x < field.centerX) : (ball.pos.x > field.centerX)
        let ballSpeedTowardGoal = (player.team == .red) ? -ball.vel.x : ball.vel.x
        let ballMovingFastTowardGoal = ballSpeedTowardGoal > 3
        let inShootingLane = abs(player.pos.y - ball.pos.y) < 40
            && ((player.team == .red && player.pos.x < ball.pos.x) || (player.team == .blue && player.pos.x > ball.pos.x))

        if ballMovingFastTowardGoal && inShootingLane && distToBall < 120 {
            let sideDir: CGFloat = (player.pos.y < ball.pos.y) ? -1 : 1
            if abs(player.pos.y - ball.pos.y) < 15 {
                let sideDirFromGoal: CGFloat = (player.pos.y < goalCenterY) ? -1 : 1
                targetY = ball.pos.y + sideDirFromGoal * 50
            } else {
                targetY = ball.pos.y + sideDir * 50
            }
            targetX = player.pos.x
        } else if distToBall < 55 && ballOnOurSide {
            let playerToOwn = abs(player.pos.x - ownGoalX)
            let ballToOwn = abs(predicted.x - ownGoalX)
            if playerToOwn < ballToOwn {
                targetX = predicted.x
                targetY = predicted.y
            } else {
                let sideOffset: CGFloat = (player.pos.y > ball.pos.y) ? 35 : -35
                let goalSideOffset: CGFloat = (player.team == .red) ? -25 : 25
                targetX = predicted.x + goalSideOffset
                targetY = predicted.y + sideOffset
            }
        } else {
            let t: CGFloat = 0.35 * positioningSkill
            targetX = ownGoalX + (ball.pos.x - ownGoalX) * t
            let directLineY = ball.pos.y
            let offsetDir: CGFloat = (player.pos.y > goalCenterY) ? 1 : -1
            targetY = field.centerY + (directLineY - field.centerY) * 0.45 * positioningSkill + offsetDir * 20
            if player.team == .red {
                targetX = min(targetX, field.centerX - field.width * 0.08)
            } else {
                targetX = max(targetX, field.centerX + field.width * 0.08)
            }
        }
        clampTarget(field: field)
    }

    private func playSupport(player: Player, ball: Ball, field: Field,
                             opponents: [Player], teammates: [Player]) {
        let goalX = (player.team == .red) ? field.x + field.width : field.x
        let midX = ball.pos.x + (goalX - ball.pos.x) * 0.5
        let minDistFromBall = field.width * 0.2
        let distFromBall = abs(midX - ball.pos.x)
        var tx = midX
        if distFromBall < minDistFromBall {
            tx = (player.team == .red) ? ball.pos.x + minDistFromBall : ball.pos.x - minDistFromBall
        }
        let slots: [CGFloat] = [
            field.y + field.height * 0.2,
            field.centerY - field.height * 0.15,
            field.centerY + field.height * 0.15,
            field.y + field.height * 0.8,
        ]
        var bestY = field.centerY
        var bestOpen: CGFloat = -1
        for sy in slots {
            var minD: CGFloat = .infinity
            for o in opponents {
                let d = ((tx - o.pos.x) * (tx - o.pos.x) + (sy - o.pos.y) * (sy - o.pos.y)).squareRoot()
                if d < minD { minD = d }
            }
            for t in teammates where t !== player {
                let d = ((tx - t.pos.x) * (tx - t.pos.x) + (sy - t.pos.y) * (sy - t.pos.y)).squareRoot()
                if d < minD { minD = d }
            }
            if minD > bestOpen { bestOpen = minD; bestY = sy }
        }
        if abs(bestY - ball.pos.y) < field.height * 0.15 {
            bestY = (ball.pos.y > field.centerY) ? ball.pos.y - field.height * 0.2 : ball.pos.y + field.height * 0.2
        }
        targetX = tx
        targetY = bestY
        clampTarget(field: field)
    }

    // MARK: - Decisions

    private func chooseBestTarget(player: Player, ball: Ball, field: Field, opponents: [Player]) -> Vec2 {
        let goalX: CGFloat = (player.team == .red) ? field.x + field.width : field.x
        let goalCenterY = field.goalY + field.goalHeight / 2
        let distToGoal = ((goalX - ball.pos.x) * (goalX - ball.pos.x) + (goalCenterY - ball.pos.y) * (goalCenterY - ball.pos.y)).squareRoot()
        if distToGoal < field.width * 0.55 {
            return Vec2(goalX, bestGoalSpot(opponents: opponents, field: field))
        }
        return Vec2(goalX, bestGoalSpot(opponents: opponents, field: field))
    }

    private func decideKick(player: Player, ball: Ball, field: Field, opponents: [Player]) -> KickIntent {
        let goalX: CGFloat = (player.team == .red) ? field.x + field.width : field.x
        let ownGoalX: CGFloat = (player.team == .red) ? field.x : field.x + field.width
        let goalCenterY = field.goalY + field.goalHeight / 2
        let distToGoal = ((goalX - ball.pos.x) * (goalX - ball.pos.x) + (goalCenterY - ball.pos.y) * (goalCenterY - ball.pos.y)).squareRoot()
        let distToOwnGoal = abs(ball.pos.x - ownGoalX)

        let spotY = bestGoalSpot(opponents: opponents, field: field)
        if isAimedAt(player: player, ball: ball, tx: goalX, ty: spotY)
            && !wouldKickTowardOwnGoal(player: player, ball: ball, field: field) {
            var charge: CGFloat = 0.25
            if distToGoal < field.width * 0.5 { charge = 0.4 }
            if distToGoal < field.width * 0.35 { charge = 0.55 }
            if distToGoal < field.width * 0.2 { charge = 0.75 }
            if distToGoal < field.width * 0.12 { charge = 0.9 }
            if CGFloat.random(in: 0..<1) < accuracy {
                return KickIntent(kick: true, chargeRatio: charge)
            }
        }
        if distToOwnGoal < field.width * 0.15 && !wouldKickTowardOwnGoal(player: player, ball: ball, field: field) {
            return KickIntent(kick: true, chargeRatio: 0.6)
        }
        if distToOwnGoal < field.width * 0.5
            && isAimedAt(player: player, ball: ball, tx: goalX, ty: goalCenterY)
            && !wouldKickTowardOwnGoal(player: player, ball: ball, field: field) {
            return KickIntent(kick: true, chargeRatio: 0.3)
        }
        return KickIntent(kick: false, chargeRatio: 0.3)
    }

    private func bestGoalSpot(opponents: [Player], field: Field) -> CGFloat {
        let goalTop = field.goalY + 12
        let goalBottom = field.goalY + field.goalHeight - 12
        let jitter = (1 - accuracy) * 30 * (CGFloat.random(in: 0..<1) - 0.5)
        if Bool.random() {
            return min(goalBottom + jitter, goalBottom)
        } else {
            return max(goalTop + jitter, goalTop)
        }
    }

    // MARK: - Helpers

    private func predictBall(_ ball: Ball, frames: Int) -> Vec2 {
        var x = ball.pos.x, y = ball.pos.y, vx = ball.vel.x, vy = ball.vel.y
        for _ in 0..<frames {
            vx *= GameConstants.ballFriction
            vy *= GameConstants.ballFriction
            x += vx; y += vy
        }
        return Vec2(x, y)
    }

    private func isAimedAt(player: Player, ball: Ball, tx: CGFloat, ty: CGFloat) -> Bool {
        let kx = ball.pos.x - player.pos.x
        let ky = ball.pos.y - player.pos.y
        let dx = tx - ball.pos.x
        let dy = ty - ball.pos.y
        let m1 = (kx * kx + ky * ky).squareRoot()
        let m2 = (dx * dx + dy * dy).squareRoot()
        if m1 < 1 || m2 < 1 { return true }
        return (kx * dx + ky * dy) / (m1 * m2) > aimThreshold
    }

    private func wouldKickTowardOwnGoal(player: Player, ball: Ball, field: Field) -> Bool {
        let kx = ball.pos.x - player.pos.x
        let ky = ball.pos.y - player.pos.y
        let len = (kx * kx + ky * ky).squareRoot()
        if len < 1 { return false }
        let nx = kx / len
        let ny = ky / len
        let resultVx = nx * 7.8 + player.vel.x * 0.3
        let resultVy = ny * 7.8 + player.vel.y * 0.3

        let towardOwnGoalX = (player.team == .red) ? resultVx < 0 : resultVx > 0
        if !towardOwnGoalX { return false }
        let ownGoalX: CGFloat = (player.team == .red) ? field.x : field.x + field.width
        let distToGoalX = abs(ball.pos.x - ownGoalX)
        if distToGoalX > field.width * 0.6 { return false }
        if abs(resultVx) < 0.5 { return true }
        let timeToGoal = distToGoalX / abs(resultVx)
        let predY = ball.pos.y + resultVy * timeToGoal
        let margin: CGFloat = 40
        return predY > field.goalY - margin && predY < field.goalY + field.goalHeight + margin
    }

    private func clampTarget(field: Field) {
        targetX = max(field.x + 25, min(field.x + field.width - 25, targetX))
        targetY = max(field.y + 25, min(field.y + field.height - 25, targetY))
    }

    private func moveToTarget(player: Player) {
        let dx = targetX - player.pos.x
        let dy = targetY - player.pos.y
        let d = (dx * dx + dy * dy).squareRoot()
        if d > 3 {
            let n = Vec2(dx / d, dy / d)
            let speed = min(d / moveDiv, 1)
            // applyInput uses dtRatio internally; we pass 1.0 here because the
            // game engine multiplies by dtRatio when running this controller's
            // moves (matches how the JS version does it).
            player.applyInput(Vec2(n.x * speed, n.y * speed), dtRatio: 1.0)
        }
    }
}
