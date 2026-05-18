// Field geometry — port of shared/entities.js Field class.
// All sizes are in *virtual* coordinates; the renderer scales to screen.

import CoreGraphics

final class Field {
    let canvasW: CGFloat
    let canvasH: CGFloat
    let mapType: GameConstants.Map

    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat

    let goalY: CGFloat
    let goalHeight: CGFloat
    let goalDepth: CGFloat = 85

    let centerX: CGFloat
    let centerY: CGFloat
    let centerRadius: CGFloat

    let penaltyWidth: CGFloat
    let penaltyHeight: CGFloat
    let penaltyY: CGFloat

    init(canvasW: CGFloat, canvasH: CGFloat, mapType: GameConstants.Map = .classic) {
        self.canvasW = canvasW
        self.canvasH = canvasH
        self.mapType = mapType

        let widthRatio: CGFloat = 0.85
        let heightRatio: CGFloat = 0.75

        self.width = canvasW * widthRatio
        self.height = canvasH * heightRatio
        self.x = (canvasW - width) / 2
        self.y = (canvasH - height) / 2 - 20

        self.goalHeight = height * 0.38
        self.goalY = y + (height - goalHeight) / 2

        self.centerX = x + width / 2
        self.centerY = y + height / 2
        self.centerRadius = min(width, height) * 0.15

        self.penaltyWidth = width * 0.15
        self.penaltyHeight = height * 0.5
        self.penaltyY = y + (height - penaltyHeight) / 2
    }

    /// Mouth and back of each goal (used by physics for goal-post collisions).
    var leftGoalMouthX: CGFloat { x }
    var rightGoalMouthX: CGFloat { x + width }
    var goalTop: CGFloat { goalY }
    var goalBottom: CGFloat { goalY + goalHeight }
}
