# KickZone — Native iOS

This folder contains a from-scratch native Swift port of the KickZone web game.
SwiftUI for the UI shell, SpriteKit for the gameplay scene, pure-Swift inference
for the trained PPO policy.

## Folder layout

```
KickZone/
├── Models/        # Vec2, Player, Ball, Field
├── Game/          # Constants, Physics, GameEngine
├── AI/            # AIController (rule-based), NeuralNet, Encoder, RLAgent
├── Controls/      # Joystick + action buttons (SwiftUI)
├── Rendering/     # SpriteKit scene
├── UI/            # ContentView, MainMenuView, SettingsView, GameView
└── Resources/     # kickzone-rl-gen1325.json (bundled trained model)
```

## ONE-TIME SETUP — wire the new files into Xcode

The Xcode project (`App.xcodeproj`) only knows about files that have been
explicitly added to its build sources. The Swift files in this folder are NOT
compiled until you add them.

**In Xcode (5 minutes):**

1. Open `ios/App/App.xcodeproj`.
2. In the left sidebar (the Project Navigator), find the **App** group.
3. Drag the `KickZone` folder from Finder INTO the App group.
4. In the dialog:
   - Check **Copy items if needed**: OFF (already in place)
   - **Create groups** (NOT folder references)
   - **Add to targets**: ✅ App
5. Click **Finish**.

Xcode will then compile every `.swift` file in `KickZone/**` and bundle the
JSON model from `KickZone/Resources/`.

## Removing Capacitor (optional but recommended)

The Capacitor framework is still linked but unused. To clean up:

1. In Xcode: **App** target → **General** → **Frameworks, Libraries…**
2. Remove `Capacitor` (the SPM package).
3. Delete the `App/public/` folder (was Capacitor's webview bundle).
4. Delete `App/capacitor.config.json` and `App/config.xml`.

The app will be ~5 MB smaller and won't link the WebKit bridge.

## Build + run

After the one-time setup:
- ⌘R to build and run on simulator or device
- The bundle will include `kickzone-rl-gen1325.json`. On launch you'll see
  `[RL] loaded bundled model — inDim=168 hidden=256` in the Xcode console.
- "AI Difficulty: Expert" in match settings → the RL policy plays the AI side.

## What's working

- 1v1 native gameplay (rule-based or RL agent)
- Trained gen-1325 RL agent inference on-device
- Touch controls (virtual joystick + KICK/PULL)
- SpriteKit rendering with camera follow + goal celebrations
- Match clock, score, kickoffs, goal-limit termination
- SwiftUI menu / settings / how-to-play

## What's NOT yet implemented (follow-on work)

- 2v2 / 3v3 / 4v4 (game engine supports it; UI plumbed through, but the
  bundled RL model is the 1v1 model — no native 2v2 model yet)
- Power-ups (engine has hooks, but PowerUpManager not yet ported)
- Audio (no sound effects or music)
- Online multiplayer (Capacitor build used PeerJS; native version would need
  MultipeerConnectivity or a custom WebRTC integration)
- AI training (the iOS app only runs inference; train on the desktop web
  build, then ship the model JSON via Resources)

## How to ship a fresh trained model

1. Train in the web app, click **Download Model**.
2. Replace `KickZone/Resources/kickzone-rl-gen1325.json` with the new file.
3. Update the filename reference in `RLAgent.swift` if needed.
4. Rebuild — the new policy ships in the next bundle.

## Architecture notes

- All game state lives in `GameEngine` (an `ObservableObject` published to SwiftUI).
- `GameScene` reads engine state every frame and updates SpriteKit nodes
  in place — no node churn per tick.
- `Physics` is stateless (a Swift enum with static methods) — direct port
  of `shared/physics.js`.
- `AIController` is the rule-based AI (port of `shared/ai.js`).
- `RLAgent` runs a pure-Swift forward pass on the trained PPO policy.
  Decision rate is ~30 Hz (every other physics tick) so the network forward
  pass costs ~50µs per agent — negligible on any modern iPhone.
