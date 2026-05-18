// SwiftUI root view — manages app navigation between menu, settings,
// and the live game.

import SwiftUI
import SpriteKit

enum AppScreen: Hashable {
    case menu, settings, game, howToPlay
}

final class AppRouter: ObservableObject {
    @Published var screen: AppScreen = .menu
    @Published var settings = MatchSettings()
    @Published var practiceMode = false
    let cachedRLPolicy: PolicyNet? = RLAgentLoader.loadBundledPolicy()
}

struct ContentView: View {
    @StateObject var router = AppRouter()

    var body: some View {
        ZStack {
            switch router.screen {
            case .menu:
                MainMenuView(router: router)
            case .settings:
                SettingsView(router: router)
            case .howToPlay:
                HowToPlayView(router: router)
            case .game:
                GameView(router: router)
            }
        }
        .background(LinearGradient(
            colors: [Color(red: 0.024, green: 0.039, blue: 0.10),
                     Color(red: 0.04, green: 0.06, blue: 0.27)],
            startPoint: .topLeading, endPoint: .bottomTrailing
        ))
        .preferredColorScheme(.dark)
    }
}

// MARK: - Menu

struct MainMenuView: View {
    @ObservedObject var router: AppRouter

    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            VStack(spacing: 4) {
                HStack(spacing: 0) {
                    Text("KICK")
                        .font(.system(size: 56, weight: .black, design: .rounded))
                        .foregroundColor(Color(red: 1.0, green: 0.30, blue: 0.43))
                        .tracking(4)
                    Text("ZONE")
                        .font(.system(size: 56, weight: .black, design: .rounded))
                        .foregroundColor(Color(red: 0.30, green: 0.83, blue: 1.0))
                        .tracking(4)
                }
                .shadow(color: Color.cyan.opacity(0.3), radius: 30)
                Text("PHYSICS-BASED SOCCER")
                    .font(.system(size: 12, weight: .semibold))
                    .tracking(6)
                    .foregroundColor(Color(white: 0.4))
            }
            VStack(spacing: 12) {
                MenuButton("Quick Match", primary: true) {
                    router.practiceMode = false
                    router.screen = .settings
                }
                MenuButton("Practice Mode") {
                    router.practiceMode = true
                    router.settings.teamSize = 1
                    router.settings.durationSeconds = 9999
                    router.screen = .game
                }
                MenuButton("How to Play") {
                    router.screen = .howToPlay
                }
            }
            .padding(.top, 30)
            .frame(maxWidth: 320)
            Spacer()
            Text("RL agent: \(router.cachedRLPolicy == nil ? "not loaded" : "gen 1325 loaded")")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(.gray)
        }
        .padding()
    }
}

private struct MenuButton: View {
    let label: String
    var primary: Bool = false
    let action: () -> Void
    init(_ label: String, primary: Bool = false, action: @escaping () -> Void) {
        self.label = label; self.primary = primary; self.action = action
    }
    var body: some View {
        Button(action: action) {
            Text(label.uppercased())
                .font(.system(size: 16, weight: .heavy))
                .tracking(2)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(primary
                      ? Color(red: 1.0, green: 0.30, blue: 0.43).opacity(0.20)
                      : Color.cyan.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8).stroke(
                primary ? Color(red: 1.0, green: 0.30, blue: 0.43) : Color.cyan,
                lineWidth: 2
            )
        )
        .foregroundColor(primary ? .white : Color(red: 0.30, green: 0.83, blue: 1.0))
    }
}

// MARK: - Settings

struct SettingsView: View {
    @ObservedObject var router: AppRouter

    var body: some View {
        VStack(spacing: 18) {
            Text("Match Settings")
                .font(.system(size: 24, weight: .heavy))
                .foregroundColor(Color(red: 0.30, green: 0.83, blue: 1.0))
                .padding(.top, 24)

            settingRow("Team Size") {
                segPicker(values: [1, 2, 3, 4],
                          selected: router.settings.teamSize,
                          label: { "\($0)v\($0)" }) {
                    router.settings.teamSize = $0
                }
            }
            settingRow("Match Duration") {
                segPicker(values: [120, 180, 300],
                          selected: router.settings.durationSeconds,
                          label: { "\($0 / 60) min" }) {
                    router.settings.durationSeconds = $0
                }
            }
            settingRow("Goal Limit") {
                segPicker(values: [3, 5, 0],
                          selected: router.settings.goalLimit,
                          label: { $0 == 0 ? "No Limit" : "\($0)" }) {
                    router.settings.goalLimit = $0
                }
            }
            settingRow("AI Difficulty") {
                segPicker(values: Difficulty.allCases,
                          selected: router.settings.difficulty,
                          label: { $0.rawValue.capitalized }) {
                    router.settings.difficulty = $0
                }
            }
            settingRow("Map") {
                segPicker(values: [GameConstants.Map.big, .classic, .huge],
                          selected: router.settings.map,
                          label: { $0.rawValue.capitalized }) {
                    router.settings.map = $0
                }
            }
            HStack(spacing: 14) {
                Button("Back") { router.screen = .menu }
                    .buttonStyle(SecondaryStyle())
                Button("Start Match") { router.screen = .game }
                    .buttonStyle(PrimaryStyle())
            }
            .padding(.top, 18)
            Spacer()
        }
        .padding()
    }

    @ViewBuilder
    private func settingRow<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(1.5)
                .foregroundColor(Color(white: 0.5))
            content()
        }
        .frame(maxWidth: 360)
    }

    @ViewBuilder
    private func segPicker<Value: Hashable>(
        values: [Value], selected: Value,
        label: @escaping (Value) -> String,
        select: @escaping (Value) -> Void
    ) -> some View {
        HStack(spacing: 6) {
            ForEach(values, id: \.self) { v in
                Button(action: { select(v) }) {
                    Text(label(v))
                        .font(.system(size: 13, weight: .heavy))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(v == selected
                              ? Color.cyan.opacity(0.25)
                              : Color.cyan.opacity(0.05))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6).stroke(
                        v == selected ? Color.cyan : Color.cyan.opacity(0.3),
                        lineWidth: 1.5
                    )
                )
                .foregroundColor(v == selected ? .white : Color.cyan.opacity(0.7))
            }
        }
    }
}

private struct PrimaryStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .heavy)).tracking(1.5)
            .padding(.horizontal, 24).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 8)
                .fill(Color(red: 1.0, green: 0.30, blue: 0.43).opacity(0.25)))
            .overlay(RoundedRectangle(cornerRadius: 8)
                .stroke(Color(red: 1.0, green: 0.30, blue: 0.43), lineWidth: 2))
            .foregroundColor(.white)
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
private struct SecondaryStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold)).tracking(1.5)
            .padding(.horizontal, 24).padding(.vertical, 12)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.gray.opacity(0.15)))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.gray, lineWidth: 1.5))
            .foregroundColor(Color.gray)
    }
}

// MARK: - How To Play

struct HowToPlayView: View {
    @ObservedObject var router: AppRouter
    var body: some View {
        VStack(spacing: 18) {
            Text("How to Play").font(.system(size: 24, weight: .heavy)).foregroundColor(Color.cyan).padding(.top, 24)
            VStack(alignment: .leading, spacing: 14) {
                helpRow("🕹", "Move", "Use the left joystick.")
                helpRow("⚽", "Kick", "Tap KICK to shoot. Hold for power shot.")
                helpRow("🧲", "Pull", "Hold PULL to attract the ball when nearby.")
                helpRow("🎯", "Score", "Score more goals than your opponent.")
            }.padding().frame(maxWidth: 360)
            Spacer()
            Button("Back") { router.screen = .menu }.buttonStyle(SecondaryStyle())
        }.padding()
    }
    private func helpRow(_ icon: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(icon).font(.system(size: 28))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 16, weight: .heavy)).foregroundColor(.white)
                Text(text).font(.system(size: 13)).foregroundColor(.gray)
            }
        }
    }
}

// MARK: - Game

struct GameView: View {
    @ObservedObject var router: AppRouter
    @StateObject private var engine = GameEngine()
    @State private var sceneRef: GameScene? = nil
    @State private var showingEnd = false

    var body: some View {
        ZStack {
            // The scene is owned by SpriteView; we set up the engine first
            SpriteView(scene: makeScene(), preferredFramesPerSecond: 60,
                       options: [.shouldCullNonVisibleNodes],
                       debugOptions: [])
                .ignoresSafeArea()
                .onAppear {
                    if let policy = router.cachedRLPolicy {
                        engine.expertAgentFactory = { RLAgent(policy: policy) }
                    }
                    engine.settings = router.settings
                    engine.startMatch()
                }
                .onDisappear { engine.stop() }

            // Top HUD
            VStack {
                HStack(spacing: 16) {
                    scoreBadge(team: .red, score: engine.redScore)
                    Text(formattedTime(ms: engine.timeRemainingMs))
                        .font(.system(size: 18, weight: .heavy, design: .monospaced))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14).padding(.vertical, 6)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.45)))
                    scoreBadge(team: .blue, score: engine.blueScore)
                    Spacer()
                    Button(action: { engine.pause() ; router.screen = .menu }) {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                            .padding(10)
                            .background(Circle().fill(Color.black.opacity(0.45)))
                    }
                }
                .padding(.horizontal, 16).padding(.top, 12)
                Spacer()
            }

            // Touch controls
            ControlsOverlay(engine: engine).allowsHitTesting(true)

            // Match over overlay
            if engine.matchOver {
                matchOverOverlay
            }
        }
    }

    private func makeScene() -> GameScene {
        let scene = GameScene()
        scene.scaleMode = .aspectFit
        scene.engine = engine
        scene.size = CGSize(width: 1500, height: 1000)
        return scene
    }

    private func scoreBadge(team: Team, score: Int) -> some View {
        let color: Color = (team == .red)
            ? Color(red: 1.0, green: 0.30, blue: 0.43)
            : Color(red: 0.30, green: 0.83, blue: 1.0)
        return Text("\(score)")
            .font(.system(size: 22, weight: .black, design: .rounded))
            .foregroundColor(color)
            .frame(width: 36, height: 36)
            .background(Circle().fill(Color.black.opacity(0.45)))
    }

    private func formattedTime(ms: Double) -> String {
        let s = Int(ms / 1000)
        return String(format: "%d:%02d", s / 60, s % 60)
    }

    private var matchOverOverlay: some View {
        ZStack {
            Color.black.opacity(0.7).ignoresSafeArea()
            VStack(spacing: 16) {
                Text(engine.redScore == engine.blueScore ? "DRAW"
                     : engine.redScore > engine.blueScore ? "RED WINS!" : "BLUE WINS!")
                    .font(.system(size: 28, weight: .heavy))
                    .foregroundColor(.white)
                Text("\(engine.redScore) — \(engine.blueScore)")
                    .font(.system(size: 36, weight: .black, design: .monospaced))
                    .foregroundColor(.white)
                Button("Rematch") { engine.startMatch() }.buttonStyle(PrimaryStyle())
                Button("Main Menu") { router.screen = .menu }.buttonStyle(SecondaryStyle())
            }
        }
    }
}
