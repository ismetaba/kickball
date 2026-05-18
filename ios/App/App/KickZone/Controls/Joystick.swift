// SwiftUI virtual joystick + action buttons for the gameplay screen.
//
// All controls write into the shared GameEngine through @ObservedObject.
// The joystick is a draggable thumb inside a base circle; output is a
// unit-length-or-shorter Vec2.

import SwiftUI

struct ControlsOverlay: View {
    @ObservedObject var engine: GameEngine
    @State private var charging = false
    @State private var chargeStart: TimeInterval = 0

    var body: some View {
        GeometryReader { geo in
            ZStack {
                // Joystick (left)
                JoystickView(onChange: { dir in
                    engine.humanInputDir = dir
                }, onEnd: {
                    engine.humanInputDir = .zero
                })
                .frame(width: 120, height: 120)
                .position(x: 80, y: geo.size.height - 90)

                // Kick button (right)
                ActionButton(label: "KICK",
                             color: .pink,
                             onPress: {
                    chargeStart = CACurrentMediaTime() * 1000
                    engine.humanIsCharging = true
                    engine.humanChargeStartMs = chargeStart
                }, onRelease: {
                    engine.humanKickRelease = true
                })
                .frame(width: 80, height: 80)
                .position(x: geo.size.width - 70, y: geo.size.height - 90)

                // Pull button (right inner)
                ActionButton(label: "PULL",
                             color: .purple,
                             onPress: { engine.humanPull = true },
                             onRelease: { engine.humanPull = false })
                .frame(width: 60, height: 60)
                .position(x: geo.size.width - 165, y: geo.size.height - 100)
            }
        }
        .ignoresSafeArea()
    }
}

private struct JoystickView: View {
    var onChange: (Vec2) -> Void
    var onEnd: () -> Void
    @State private var thumb: CGPoint = .zero
    @State private var dragging = false

    var body: some View {
        GeometryReader { geo in
            let r = min(geo.size.width, geo.size.height) / 2
            ZStack {
                Circle()
                    .stroke(Color.cyan.opacity(0.4), lineWidth: 3)
                    .background(Circle().fill(Color.cyan.opacity(0.08)))
                Circle()
                    .fill(Color.cyan.opacity(0.7))
                    .frame(width: 40, height: 40)
                    .offset(x: thumb.x, y: thumb.y)
            }
            .contentShape(Circle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        dragging = true
                        let center = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
                        let dx = v.location.x - center.x
                        let dy = v.location.y - center.y
                        let len = (dx * dx + dy * dy).squareRoot()
                        let max = r - 20
                        if len > max {
                            thumb = CGPoint(x: dx * max / len, y: dy * max / len)
                        } else {
                            thumb = CGPoint(x: dx, y: dy)
                        }
                        let nx = thumb.x / max
                        let ny = thumb.y / max
                        onChange(Vec2(nx, ny))
                    }
                    .onEnded { _ in
                        dragging = false
                        thumb = .zero
                        onEnd()
                    }
            )
        }
    }
}

private struct ActionButton: View {
    var label: String
    var color: Color
    var onPress: () -> Void
    var onRelease: () -> Void
    @State private var pressed = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(color, lineWidth: 3)
                .background(Circle().fill(color.opacity(pressed ? 0.4 : 0.18)))
            Text(label)
                .font(.system(size: 14, weight: .heavy, design: .rounded))
                .foregroundColor(.white)
                .tracking(1.5)
        }
        .scaleEffect(pressed ? 0.94 : 1.0)
        .gesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in
                    if !pressed { pressed = true; onPress() }
                }
                .onEnded { _ in
                    pressed = false
                    onRelease()
                }
        )
    }
}
