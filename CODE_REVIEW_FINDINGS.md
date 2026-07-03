# Implementation plan — kickball / KickZone code review

Source: full multi-agent review of 2026-07-03 (8 review dimensions, every finding adversarially
re-verified against the code; 93 confirmed findings). Duplicates are merged, so this plan has
**85 items in 8 work packages**. Every item is a single committed directive — no alternatives.

## Rules for the implementing agent (read before starting)

1. **Determinism is the invariant.** Any change touching `shared/`, the sim paths of `js/game.js`,
   or `server/game-simulation.js` must keep host and guest simulations bit-identical. If an item
   adds or removes sim-state, it says so and names the checksum/serializer updates required;
   never add randomness, wall-clock time, or render-dependent state to the sim.
2. **Locate code by the `locate:` excerpt, not by line number.** Line numbers drift as items land.
3. **Run `npm test` after every item.** An item is done only when its **Verify** step passes.
4. **Land each package as one commit/PR**, in package order within a package (items are ordered by
   dependency). Do not interleave items from different packages in one commit.
5. **Mirror `?v=` cache-busting bumps.** Any edit to a `js/`/`css/` file must bump its query string
   in `index.html` AND in the `sw.js` ASSETS list (they must stay identical).
6. **Swift parity.** Where an item notes the iOS port has the same logic, make the identical change
   in `ios/App/App/KickZone/` in the same commit.
7. **Golden fixture regeneration.** After any intentional sim-behavior change, regenerate
   `test/fixtures/determinism-golden.json` (P0-2) in the same commit and say so in the message.
8. **Do not implement anything from the "Refuted" list** at the end of this file.

## Package order

| Package | Theme | Items | Depends on | Agent capability |
|---|---|---|---|---|
| P0 | Test infrastructure first | 3 | — | basic |
| P1 | Determinism & lockstep-sim correctness | 8 | P0 | basic, guardrail-aware |
| P2 | Server hardening | 20 | — (parallel to P1) | basic |
| P3 | Connection lifecycle | 9 | P1 | **capable agent / human review** |
| P4 | Game loop & rendering polish | 9 | P1 | basic |
| P5 | Client quality (PWA, audio, a11y) | 8 | — | basic |
| P6 | RL / AI subsystem | 14 | P1 | basic; care on training math |
| P7 | iOS native parity | 14 | — | basic; needs Xcode to verify |

---

## Package P0 — Test infrastructure first
**Goal.** Make the determinism test actually test determinism, and add missing lockstep test coverage, so every sim-affecting fix in P1-P3 is provable.
**When.** Land before everything else — later packages rely on these tests to prove their fixes.
**Agent capability.** basic agent
**Package verification.** From the repo root run `npm test` (this runs `node --test` over `test/`). All existing suites (`determinism.test.js`, `p2p-protocol.test.js`, `room-manager.test.js`, `server-simulation.test.js`, `shared-core.test.js`) plus the new `test/lockstep-confirmation.test.js` must pass, with the new golden fixture `test/fixtures/determinism-golden.json` committed. Nothing in this package may modify `shared/`, `js/`, or `server/` production code — it is test-only. Confirm with `git status` that only `test/` files changed.

---

### P0-1 [high] Fix NaN-corrupted determinism replay so 95% of the test is no longer vacuous
- [ ] `test/determinism.test.js` — locate: `Physics.resolveCircleCollision(players[i], players[j]);`

The determinism replay test calls `Physics.resolveCircleCollision` without the `bounceA`/`bounceB` arguments (lines ~90 and ~92). In `shared/physics.js`, `restitution = (bounceA + bounceB) / 2` becomes `NaN`, which propagates NaN into every velocity on the first real collision — measured at tick 64 of 1200 the entire player/ball state is non-finite and never recovers. Because `hashState` hashes with `(v | 0)` and `NaN | 0 === 0`, ticks 64–1199 hash to identical constants in both replays, so the test passes green while comparing frozen garbage. Any nondeterminism introduced into the sim after tick 64 would go completely undetected.

**Change:**
1. In `runMatch` in `test/determinism.test.js`, pass bounce arguments exactly as the production call sites in `js/game.js` do: player-vs-player becomes `Physics.resolveCircleCollision(players[i], players[j], Physics.PLAYER_BOUNCE, Physics.PLAYER_BOUNCE)` (matches `js/game.js` line ~1552) and player-vs-ball becomes `Physics.resolveCircleCollision(players[i], ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE)` (matches `js/game.js` line ~1447).
2. In `hashState`, make the `add` helper fail loudly on non-finite input: at the top of `add(v)`, do `assert.ok(Number.isFinite(v), 'non-finite value entered the sim state hash');` (use the already-imported `node:assert/strict`). This guarantees any future NaN in the shared core fails the test at the exact tick it appears instead of silently hashing to 0.
3. In the first test (`same seed + same inputs...`), after the replay loop add a dynamics sanity assertion proving real physics ran: assert the final ball position of run `a` stays inside the playable canvas, i.e. `assert.ok(ball.x >= 0 && ball.x <= 1500 && ball.y >= 0 && ball.y <= 1000)`. To reach the ball, change `runMatch` to also return the final ball position (e.g. `finalBall: { x: ball.x, y: ball.y }`) and assert on that.

This is a test-only change: do not touch `shared/physics.js` or any sim file here (a P1 item adds NaN defenses to `resolveCircleCollision` itself; this test must keep passing explicit bounce constants regardless). Determinism guardrail: no sim-state fields are added or removed, so `js/game.js` `_computeChecksum` and `_serializeFullState` are unchanged, and the Swift port under `ios/App/App/KickZone/` needs no parity change.

**Verify:** `npm test` passes. Then run this one-off sanity check: temporarily delete the bounce arguments from one `resolveCircleCollision` call in the test, run `node --test test/determinism.test.js`, and confirm it now FAILS with the "non-finite value entered the sim state hash" assertion (proving the guard works); restore the arguments and confirm it passes again.

**Interacts with:** P0-2 (the golden fixture must be generated after this fix, because per-tick hashes change), P1-5 (resolveCircleCollision NaN defaults in `shared/physics.js`).

---

### P0-2 [medium] Add a committed golden per-tick hash fixture with bit-exact float hashing
- [ ] `test/determinism.test.js`, new `test/helpers/determinism-match.js`, new `test/fixtures/determinism-golden.json`, new `test/fixtures/generate-determinism-golden.js` — locate: `const a = runMatch(42, ticks);`

The determinism test replays the match twice inside the same Node/V8 process and compares the two runs to each other. That structurally cannot detect the primary lockstep threat: an engine/runtime whose math differs from the reference (V8 vs JavaScriptCore in the iOS Capacitor build, or a Node/V8 version upgrade) — both replays share one implementation, so they agree by construction. Additionally the hash quantizes positions to 0.1px (`x*10 | 0`) and velocities to 0.01, so sub-quantum floating-point drift at a given tick is invisible until it amplifies through a collision branch.

**Change:**
1. Extract `SeededRNG`, `hashState`, and `runMatch` out of `test/determinism.test.js` into a new module `test/helpers/determinism-match.js` that exports `{ runMatch, TICK_MS }`. `test/determinism.test.js` requires it; the existing two tests keep their current assertions (including the P0-1 finiteness guard and ball-bounds check).
2. Make `hashState` bit-exact for floats: keep the existing `add(v)` (with the P0-1 finiteness assertion) for integer-valued fields (`kickCooldown`, `powerUpTimer`, powerUp lengths, `mgr.spawnTimer`, power-up `x`/`y`/id length, `rng.s`), and add a helper `addF64(v)` that asserts `Number.isFinite(v)`, writes `v` into a module-level 8-byte `DataView` (`dv.setFloat64(0, v)`), then feeds `dv.getUint32(0)` and `dv.getUint32(4)` through `add`. Use `addF64` for every float field: player `x, y, vx, vy` and ball `x, y, vx, vy, spin`. Any last-ulp drift now changes the hash. This touches only the test-side hash, NOT `js/game.js` `_computeChecksum` — do not change production code.
3. Create `test/fixtures/generate-determinism-golden.js`: a plain Node script (`node test/fixtures/generate-determinism-golden.js`) that requires `../helpers/determinism-match`, runs `runMatch(42, 1200)`, and writes `test/fixtures/determinism-golden.json` containing `{ "seed": 42, "ticks": 1200, "hashes": [...1200 ints...] }`. Run it once and commit the JSON.
4. Add a third test to `test/determinism.test.js`: `'replay matches the committed golden hash trace (engine/runtime drift guard)'` — load the fixture with `require`, run `runMatch(fixture.seed, fixture.ticks)`, and `assert.equal` each per-tick hash against `fixture.hashes[t]`, with a failure message stating the first divergent tick and: "if the sim was changed intentionally, regenerate with: node test/fixtures/generate-determinism-golden.js".

Determinism guardrail: this item is test-only; it must not alter `shared/` or `js/game.js` behavior, adds no sim-state field, and therefore requires no `_computeChecksum`/`_serializeFullState` update and no `ios/App/App/KickZone/` parity change. Critical process note for later packages: any INTENTIONAL sim-behavior change (e.g. P1's Math.pow-to-literal replacement in `shared/entities.js`) will legitimately change the hashes — that commit must regenerate and commit the fixture in the same change, and the same numeric change must land in the Swift port for parity.

**Verify:** `npm test` passes with the fixture committed. Sanity check the guard: temporarily change `FRICTION: 0.955` to `0.9550001` in `shared/physics.js`, run `node --test test/determinism.test.js`, confirm the golden-trace test fails at an early tick, then revert and confirm green.

**Interacts with:** P0-1 (must land first; hashes depend on its fix), P1-4 (Math.pow literal replacement will require fixture regeneration), P1-5 (resolveCircleCollision NaN defaults — no hash change expected, but run this test to prove it).

---

### P0-3 [low] Add two-instance headless lockstep confirmation tests (host + guest end-to-end)
- [ ] new `test/lockstep-confirmation.test.js`, new `test/helpers/headless-lockstep.js`; exercised code lives in `js/ui.js` — locate: `this._tryConfirmTick = (tick) => {`

The client-side lockstep confirmation machinery has zero test coverage: `test/p2p-protocol.test.js` only tests server `RoomManager` routing, while the host's `_tryConfirmTick` completeness check (`js/ui.js` ~702), the input decode/re-encode round trip (~727-751), the disconnect-retry confirmation (~652-666), the guest's `tick < tickCount` duplicate-ci guard (~955), rollback replay (`js/game.js` `_rollbackToChecksum`), and the stall-kick path (~673-680) are all untested. This is exactly where the confirmed desync bugs live, and P1's fixes there are unprovable without a harness that runs a real host `Game`+`UI` against a real guest `Game`+`UI`.

**Change:**
1. Create `test/helpers/headless-lockstep.js` exporting `createPeer()` and `connectPeers(host, guest, { delayTicks })`. `createPeer()` builds an isolated `vm` context (`node:vm`) per peer so the mutable `Physics` module state (`dtRatio`, `MAX_BALL_SPEED`) cannot cross-talk between the two instances:
   - Evaluate, via `vm.runInContext`, the concatenated sources (`fs.readFileSync`) of `shared/physics.js`, `shared/entities.js`, `shared/ai.js`, `shared/powerups.js` (their UMD wrappers attach globals to the context), then `js/game.js`, then `js/ui.js`, then a final expression `;({ Game, UI })` to extract the classes.
   - The sandbox provides browser stubs: a universal stub-element factory (object with no-op `addEventListener`/`removeEventListener`/`appendChild`/`removeChild`, `classList` with no-op `add`/`remove`/`toggle` and `contains: () => false`, `style: {}`, `textContent: ''`, `closest: () => null`, `querySelector` returning another stub element, `querySelectorAll: () => []`); `document` whose `getElementById`/`querySelector`/`createElement` return stub elements, `querySelectorAll: () => []`, no-op `addEventListener`/`removeEventListener`, `body` a stub element; `window` with no-op `addEventListener` and `innerWidth: 1280`, `innerHeight: 800`; `performance = { now: () => harness-controlled monotonic counter }`; `requestAnimationFrame: () => 0` (never invokes the callback — the harness drives ticks itself), no-op `cancelAnimationFrame`; `localStorage` with `getItem: () => null` and no-op `setItem`/`removeItem`; `navigator: { userAgent: '' }`; Node's `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval` and `console` passed through.
   - Stub the browser-only classes as sandbox globals so `js/renderer.js`, `js/audio.js`, `js/controls.js`, `js/p2p.js` are never loaded: `Renderer`, `Controls`, and `P2PNetwork` are classes whose constructor returns `new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } })` (any unknown method is a no-op, any assignment — like `ui.p2p.onLockstepInput = ...` or the harness overriding `sendLockstepInput` — is stored); `Sound` is one such Proxy object.
   - `createPeer()` returns `{ game: new Game(), ui: new UI(game), ctx }` (constructed inside the context).
2. `connectPeers(host, guest, { delayTicks = 0 })` wires an in-memory channel that mimics `js/p2p.js` exactly, including wire quantization and JSON round-trips (`JSON.parse(JSON.stringify(payload))` on every delivery):
   - `guest.ui.p2p.sendLockstepInput = (tick, pi, input) => enqueue(() => host.ui.p2p.onLockstepInput('guest', { tk: tick, pi, x: (input.x*100)|0, y: (input.y*100)|0, k: input.kick?1:0, cr: (input.chargeRatio*100)|0, pl: input.pull?1:0, sw: input.switchPlayer?1:0 }))` — this must byte-match `sendLockstepInput` in `js/p2p.js` (~line 565).
   - `host.ui.p2p.broadcastConfirmedInputs = (tick, allInputs) => enqueue(() => guest.ui.p2p.onConfirmedInputs({ tk: tick, inputs: allInputs }))` and `host.ui.p2p.broadcastChecksum = (tick, hash, fullState) => enqueue(() => guest.ui.p2p.onChecksum({ tk: tick, h: hash, fs: fullState }))`, matching `js/p2p.js` `'ci'`/`'cs'` payload shapes.
   - `enqueue` releases messages in FIFO order after `delayTicks` harness steps. Expose `flush()` and the queue for tests that need to duplicate or withhold messages.
3. Start a 1v1 match on both peers by calling the real entry points inside each context: `host.ui.p2p.playerId = 'host'`, `guest.ui.p2p.playerId = 'guest'`; `slots = [{ playerId: 'host', team: 'red' }, { playerId: 'guest', team: 'blue' }]`; `host.ui._startP2PHostMatch({ matchSeed: 42, inputDelay: 3, settings: { teamSize: 1, duration: 180, goalLimit: 0, powerups: true, map: 'classic' }, slots })` and `guest.ui._startP2PClientMatch({ matchSeed: 42, inputDelay: 3, settings: <same>, mySlot: 1, slots })`.
4. Provide a harness `step()` that advances one simulated tick: for each peer, if `game._lockstepCanAdvance()` then (mirroring `js/game.js` loop ~504) `if (game.tickCount >= game._replayUntil && game._applyPeerInputs) game._applyPeerInputs();` followed by `game._lockstepTick()`; then deliver due channel messages. Local inputs are scripted by writing `game.input.x/y/kickRelease/kickChargeTime/pull/switchPlayer` before each step.
5. Create `test/lockstep-confirmation.test.js` with these cases (each asserting via `game._computeChecksum()` called inside the peer's context):
   - **Happy path:** 600 steps with scripted keyboard-style inputs (x/y in {-1, 0, 1}, periodic kicks with full charge); assert host and guest checksums are equal at every 60-tick boundary and final `tickCount`s match.
   - **Delayed delivery:** same, with `delayTicks: 3`; assert checksum equality (guest lags, then confirms identically).
   - **Duplicate ci delivery:** deliver every `broadcastConfirmedInputs` message twice, the second copy 5 steps later (after the guest has executed the tick); assert no divergence and assert the guest's `game._lockstepInputBuffer.size` stays bounded (< 32), proving the `tick < this.game.tickCount` dedup guard in `js/ui.js` (~955).
   - **Peer disconnect mid-tick:** after 120 steps, stop delivering the guest's inputs and invoke `host.ui.p2p.onPeerDisconnected({ peerId: 'guest' })`; run 120 more host-only steps and assert `host.game.tickCount` keeps advancing (no deadlock), proving the disconnect-retry confirmation sweep in `js/ui.js` (~652-666).
   - **Stall-kick:** after 120 steps, withhold guest inputs WITHOUT a disconnect event, then call `host.game._onLockstepStall(host.game.tickCount + 3)` directly; assert the silent peer is removed (`host.ui._peerIds.size === 0`) and host ticks resume.
   - **Rollback replay:** run until the guest is several ticks past a 60-tick boundary T, capture the host's real `_serializeFullState()` at T, then deliver `guest.ui.p2p.onChecksum({ tk: T, h: <guest's recorded hash at T> + 1, fs: <host state> })` to force the past-tick mismatch path; step the guest to the present and assert `_rollbackToChecksum` rewound and replayed (guest reaches its prior `tickCount` and the next 60-tick checksums match the host).
   - **Analog quantization round-trip, marked `{ todo: true }`:** scripted analog joystick values including 0.29, 0.57, and -0.58; assert 60-tick checksum equality. Add a comment: this documents the known host/guest quantization desync in `js/ui.js` (`(inp.x * 100) | 0` vs the host's `q()` values) and flips to a hard passing assertion when the P1 input-encoding fix lands, at which point the implementer of that fix must remove `{ todo: true }`.

Determinism guardrail: this item adds NO production code — `js/game.js`, `js/ui.js`, `js/p2p.js`, and `shared/` must be byte-identical before and after; the harness stubs live entirely under `test/helpers/`. If any production symbol turns out to be unreachable from the sandbox, fix the sandbox, not the game code. No sim-state field is added or removed, so `_computeChecksum`/`_serializeFullState` are untouched and no `ios/App/App/KickZone/` parity change is needed. Note for later packages: the Swift port reimplements this confirmation logic natively and is NOT covered by these tests — any P1 change to the confirmation/encoding logic must be mirrored there manually.

**Verify:** `npm test` passes with all new cases green (the analog case reports `todo`, not failure). As a harness-integrity check, temporarily inject `this.rng.next()` into `_lockstepTick`'s input loop path on the HOST context only (edit the in-memory source string in the helper, not the file), run `node --test test/lockstep-confirmation.test.js`, and confirm the happy-path checksum assertion fails; remove the injection and confirm green.

**Interacts with:** P0-1 and P0-2 (shared expectation that `npm test` is the proof harness), P1-1 (input quantization fix flips the todo case to a hard assertion), P1-3 (host input validation should extend these tests with hostile-input cases), P1-2 (renderer superKick decay — the stubbed Renderer means this suite only proves sim-path determinism, not renderer non-interference).

---

## Package P1 — Determinism and lockstep-sim correctness
**Goal.** Every peer must simulate bit-identical state from the same inputs. Fix the input encoding round-trip, remove all non-deterministic influences from the sim, and validate peer input at the host.
**When.** Land immediately after P0, as one unit. These are the fixes that stop live desyncs.
**Agent capability.** Basic agent, but every change here MUST respect the determinism guardrail: any change to shared/, js/game.js sim paths, or server/game-simulation.js must keep host and guest simulations bit-identical — it must alter behavior identically for all peers, and any added/removed sim-state field must be reflected in `js/game.js _computeChecksum` and `_serializeFullState`. Items P1-2, P1-4, and P1-6 change the deterministic simulation sequence, so the whole package must ship to all peers at once (bump the `?v=` cache-buster on every touched script in `index.html`; current values: `shared/physics.js?v=1`, `shared/entities.js?v=1`, `js/renderer.js?v=22`, `js/game.js?v=34`, `js/p2p.js?v=2`, `js/ui.js?v=26`).
**Package verification.** Run `npm test` (all suites, including the P0-added determinism and lockstep tests, must pass). Because P1-2/P1-4/P1-6 change the deterministic tick sequence, regenerate the golden per-tick hash fixture introduced by P0 (the fixture-based determinism test) in the same commit. Finally, play a 2–3 minute two-browser P2P match using touch/analog joystick input and confirm the console shows zero `Lockstep desync at tick` warnings.

### P1-1 [high] Make the lockstep input encode/decode round-trip an exact identity
- [ ] `shared/input-codec.js` (new), `js/ui.js`, `js/p2p.js`, `index.html`, `test/input-codec.test.js` (new) — locate: `const q = (v) => ((v * 100) | 0) / 100;`

The host quantizes its own input with `((v*100)|0)/100` (`_packageLockstepInput`, js/ui.js:768) and applies that object directly, but when it broadcasts confirmed inputs it re-encodes every value as `(inp.x * 100) | 0` (js/ui.js:746-749). Because `(n/100)*100` is not exactly `n` in IEEE doubles (e.g. `0.29*100 === 28.999999999999996`), truncation with `|0` collapses values: the host simulates x=-0.58 while guests simulate x=-0.57, and the host's decode-then-re-encode of guest inputs (js/ui.js:727-733 → 746-749) collapses the same way. Any analog joystick value landing on these hundredths makes peers integrate different accelerations in the same tick, guaranteeing a checksum mismatch at the next 60-tick boundary and a player-visible rollback/full-resync cycle during ordinary play.

**Change:**
1. Create `shared/input-codec.js` using the same UMD wrapper pattern as `shared/physics.js`, exporting an `InputCodec` object with three functions: `encode(v)` — coerce with `v = +v`, replace non-finite with 0, clamp to [-1, 1], return `Math.round(v * 100)`; `decode(n)` — coerce with `n = n | 0`, clamp to [-100, 100], return `n / 100`; `quantize(v)` — return `InputCodec.decode(InputCodec.encode(v))`. `Math.round` (unlike `|0` truncation) makes `encode(decode(n)) === n` for every integer n in [-100, 100].
2. In `js/ui.js _packageLockstepInput` (line ~762), replace the local `q` helper with `InputCodec.quantize` for `x`, `y`, and `chargeRatio`.
3. In `js/ui.js _tryConfirmTick` (line ~715), decode peer inputs with `InputCodec.decode(inp.x)`, `InputCodec.decode(inp.y)`, `InputCodec.decode(inp.cr)` (replacing the `(inp.x || 0) / 100` expressions), and serialize the broadcast with `InputCodec.encode(inp.x)`, `InputCodec.encode(inp.y)`, `InputCodec.encode(inp.chargeRatio)` (replacing the `(inp.x * 100) | 0` expressions).
4. In `js/ui.js` guest handler `p2p.onConfirmedInputs` (line ~952-969), decode with `InputCodec.decode` the same way.
5. In `js/p2p.js sendLockstepInput` (line ~565), encode `x`, `y`, `cr` with `InputCodec.encode`.
6. In `index.html`, add `<script src="shared/input-codec.js?v=1"></script>` immediately after the `shared/powerups.js` script tag (line ~308), and bump the `?v=` numbers of `js/ui.js` and `js/p2p.js`.
7. Add `test/input-codec.test.js` (node:test, `require('../shared/input-codec')`).

Determinism guardrail: this changes which input values feed the sim, identically on every peer (the host applies `quantize(v)` and every guest decodes the same wire integer to the same value); no sim-state field is added or removed, so `_computeChecksum` and `_serializeFullState` in js/game.js need no change. All peers must run the same build (versions bumped above). The Swift port (ios/App/App/KickZone/) has no multiplayer/lockstep code, so no parity change is needed there.

**Verify:** `npm test`. The new `test/input-codec.test.js` asserts: (a) `InputCodec.encode(InputCodec.decode(n)) === n` for every integer n in [-100, 100]; (b) `InputCodec.quantize` is idempotent and equal to decode-of-encode for a sweep of floats `v = k/1000, k in [-1000, 1000]`, explicitly including the historical failure values 0.29, -0.57, -0.58; (c) `InputCodec.decode(1e6) === 1`, `InputCodec.decode(-1e6) === -1`, `InputCodec.decode('junk') === 0`. The P0 two-instance lockstep test (checksum equality over hundreds of ticks with analog inputs) must also pass.

**Interacts with:** P1-3 (uses the codec's clamped decode), P0-3 (the two-instance lockstep confirmation test exercises this path).

### P1-2 [high] Move superKick decay out of the renderer into the deterministic sim
- [ ] `js/renderer.js`, `shared/entities.js` — locate: `if (isSuper && ballSpeed < 3) ball.superKick = 0;`

`drawBall()` in js/renderer.js (line ~390) writes `ball.superKick = 0` when the rendered ball speed drops below 3, and this is the only decay path anywhere — shared/entities.js only sets `superKick` at kick time (lines 151/155) and reset (line 214). `superKick` feeds back into the simulation (super-kick homing at js/game.js:1305, heavy stun/knockback on collision, and it is checksummed at js/game.js:753). Renders are decoupled from lockstep ticks (up to 5 catch-up ticks per frame), so two peers clear the flag at different tick boundaries, causing divergent homing/stun outcomes, checksum mismatches, and visible resync snaps; even single-player homing duration is frame-rate dependent.

**Change:**
1. In `shared/entities.js Ball.update`, immediately after `Physics.clampSpeed(this, Physics.MAX_BALL_SPEED);` (line ~285), add: `if (this.superKick > 0) { const spd = Math.sqrt(this.vx * this.vx + this.vy * this.vy); if (spd < 3) { this.superKick = 0; this.superTarget = null; } }`.
2. In `js/renderer.js drawBall`, delete the mutation line `if (isSuper && ballSpeed < 3) ball.superKick = 0;` and its `// Decay super kick` comment (line ~389-390). The renderer must treat entity state as read-only.
3. Bump `?v=` for `shared/entities.js` and `js/renderer.js` in `index.html`.

Determinism guardrail: the decay now runs inside the shared per-tick entity update, identically on every peer. `superKick` and `superTarget` are already covered by `_computeChecksum` (js/game.js:753 `add(b.superKick * 10)`) and `_serializeFullState` (`bsk`/`bst` fields), so no checksum/serializer change is needed. Note this also fixes the authoritative server (server/game-simulation.js uses the same shared `Ball.update`), where `superKick` previously never decayed and kept applying heavy-stun knockback after the ball slowed. Swift parity: the port never decays `superKick` at all — add the identical block (speed < 3 → `superKick = 0; superTarget = nil`) to `ios/App/App/KickZone/Models/Ball.swift`'s update method so behavior matches.

**Verify:** `npm test`, and add a regression test in `test/shared-core.test.js`: construct a `Ball`, set `superKick = 1`, `superTarget = 'right'`, `vx = 2, vy = 0` (speed < 3), call `ball.update(16.67)`, and assert `ball.superKick === 0 && ball.superTarget === null`; also assert that with `vx = 10` the flag survives the update. Grep confirms `js/renderer.js` contains no assignment to any `ball.` property.

**Interacts with:** P1-7 (both touch `Ball.update` and the trail/render boundary), P0-2 (regenerate the golden hash fixture — this changes the deterministic sequence whenever a super kick decays).

### P1-3 [medium] Validate and clamp hostile peer input at the host
- [ ] `js/ui.js`, `js/game.js` — locate: `const tick = inputData.tk;`

The host's `onLockstepInput` (js/ui.js:634-644) buffers `inputData` keyed by the raw `inputData.tk` with no type or range check: a modified client can send huge, negative, or string ticks that are never confirmed and never pruned (the periodic prune at js/game.js:701-705 covers only `_lockstepInputBuffer`), growing `_pendingPeerInputs` without bound. Input values are decoded without clamping and rebroadcast to all peers: an unclamped `chargeRatio` flows into `hitNearbyPlayers` where `p.stunTimer = 200 + chargeRatio * 800` (js/game.js:1959), so `cr = 1e6` stuns every nearby opponent for minutes — a freeze cheat every honest peer faithfully simulates — and x/y beyond ±1 give instant max-speed acceleration.

**Change:**
1. In `js/ui.js` `p2p.onLockstepInput` (line ~634), after the existing `_peerIds` check, add: `const tick = inputData.tk; if (!Number.isInteger(tick)) return; if (tick < this.game.tickCount || tick > this.game.tickCount + 120) return;` (guests schedule inputs only a few ticks ahead — `INPUT_DELAY` defaults to 3 — so a 120-tick window is generous).
2. In the same handler, after inserting into `_pendingPeerInputs`, add a sweep: `if (this._pendingPeerInputs.size > 64) { for (const t of this._pendingPeerInputs.keys()) { if (t < this.game.tickCount) this._pendingPeerInputs.delete(t); } }`.
3. Value clamping is provided by `InputCodec.decode` from P1-1 (clamps to [-1, 1] at every decode site). Additionally floor chargeRatio at zero at the host decode site in `_tryConfirmTick`: `chargeRatio: Math.max(0, InputCodec.decode(inp.cr))`.
4. Defense in depth in `js/game.js hitNearbyPlayers` (line ~1946): as the first line of the function, add `chargeRatio = Math.min(Math.max(chargeRatio, 0), 1);` before the existing `if (chargeRatio < 0.25) return;`.

Determinism guardrail: the host decode-clamp runs before the confirmed-input broadcast, so guests receive already-clamped integers and decode them to the same values the host applies — all peers simulate identical inputs. The `hitNearbyPlayers` clamp is in the js/game.js sim path and executes identically on every peer for the same confirmed inputs; no sim-state field is added or removed, so `_computeChecksum`/`_serializeFullState` are unchanged. The authoritative server has its own separate `_hitNearbyPlayers` (server/game-simulation.js) which is hardened by the P2 package, and the Swift port has no multiplayer code — no parity change needed here.

**Verify:** `npm test` (the `InputCodec.decode` clamping assertions from P1-1's test cover the value clamps). Extend the P0-3 lockstep-confirmation test harness with two cases: (a) deliver an input with `tk: 'abc'` and one with `tk: 999999` to the host handler and assert `_pendingPeerInputs` gains no entry for them; (b) deliver `cr: 100000` from a fake peer and assert the confirmed map's `chargeRatio` is exactly 1 and the rebroadcast wire value is 100.

**Interacts with:** P1-1 (codec), P0-3 (test harness for the confirmation state machine).

### P1-4 [medium] Replace fractional-exponent Math.pow in the sim with precomputed per-tick literals
- [ ] `shared/physics.js`, `shared/entities.js`, `js/game.js` — locate: `this.vx *= Math.pow(Physics.FRICTION, s);`

The per-tick integration path calls `Math.pow` with fractional exponents: player friction `Math.pow(Physics.FRICTION, s)` (shared/entities.js:90-91), ball friction (269-270), spin decay `Math.pow(0.97, s)` (282), stun damping `Math.pow(0.997, dt)` (63), and pull damping `Math.pow(0.985, Physics.dtRatio)` (js/game.js:1389-1390). ECMAScript defines `Math.pow` as implementation-approximated (only sqrt is correctly rounded), so a V8 peer versus a JavaScriptCore (iOS WKWebView) peer can differ in the last ulp; lockstep amplifies ulp differences through collision branches into recurring 60-tick checksum mismatches and rubber-band resyncs in cross-browser matches. In lockstep the exponents are constants (`s === Physics.GAME_SPEED === 1.2`; `dt` is 16.67 or 16.67*0.3), so the transcendental call is avoidable.

**Change:**
1. In `shared/physics.js`, add six precomputed constants to the `Physics` object with these exact literals (each is the full-precision double of the pow it replaces): `PLAYER_FRICTION_TICK: 0.94624597658079657` (0.955^1.2), `BALL_FRICTION_TICK: 0.99160589101071051` (0.993^1.2), `SPIN_DECAY_TICK: 0.96410887586375660` (0.97^1.2), `STUN_DAMP_TICK: 0.95114841614596490` (0.997^16.67), `STUN_DAMP_TICK_SLOWMO: 0.98508677069822237` (0.997^(16.67*0.3)), `PULL_DAMP_TICK: 0.98202710873518240` (0.985^1.2).
2. In `shared/entities.js Player.update` (line ~90): `const f = (s === Physics.GAME_SPEED && Physics.FRICTION === 0.955) ? Physics.PLAYER_FRICTION_TICK : Math.pow(Physics.FRICTION, s); this.vx *= f; this.vy *= f;` (the `Physics.FRICTION === 0.955` guard covers maps that scale friction via `applyMapPhysics`; the fallback only runs in non-lockstep situations such as offline slow-motion where `dtRatio` is scaled).
3. Same pattern for stun damping (line ~63): `const damping = dt === 16.67 ? Physics.STUN_DAMP_TICK : dt === 16.67 * 0.3 ? Physics.STUN_DAMP_TICK_SLOWMO : Math.pow(0.997, dt);`.
4. In `Ball.update` (line ~269): use `Physics.BALL_FRICTION_TICK` when `s === Physics.GAME_SPEED && Physics.BALL_FRICTION === 0.993`, else fall back; for spin decay (line ~282) use `Physics.SPIN_DECAY_TICK` when `s === Physics.GAME_SPEED`, else fall back.
5. In `js/game.js` pull damping (lines ~1389-1390): compute `const pullDamp = Physics.dtRatio === Physics.GAME_SPEED ? Physics.PULL_DAMP_TICK : Math.pow(0.985, Physics.dtRatio);` once and multiply both `ball.vx` and `ball.vy` by it.
6. Bump `?v=` for `shared/physics.js`, `shared/entities.js`, `js/game.js` in `index.html`.

Determinism guardrail: in lockstep, `Physics.dtRatio` is pinned to `GAME_SPEED` (js/game.js:601) and `dt` is 16.67 (16.67*0.3 under slow-mo), so every peer now multiplies by the identical committed literal and `Math.pow` never executes in the lockstep sim path. Values shift by at most 1 ulp from the previous V8 results, identically for all peers; no sim-state field changes, so `_computeChecksum`/`_serializeFullState` are unchanged. The authoritative server uses the same shared entities and benefits automatically (its own server-only `Math.pow` calls at server/game-simulation.js:403/517 are single-engine and stay as-is). Swift parity: `ios/App/App/KickZone/Models/Player.swift:67/85` and `Models/Ball.swift:59/70` compute the same `pow` factors — add the same six literals to `Game/Constants.swift` and use them when `dtRatio == 1.2` so the port's feel stays identical (the port is single-player, so this is behavior parity, not lockstep safety).

**Verify:** `npm test`, plus a new test in `test/shared-core.test.js` that (a) asserts each `Physics.*_TICK` constant equals the exact literal above, and (b) temporarily replaces `Math.pow` with a function that throws, runs `Player.update(16.67)` (both stunned with `stunTimer = 100` and unstunned) and `Ball.update(16.67)` with `spin = 1` under `Physics.dtRatio = Physics.GAME_SPEED`, restores `Math.pow` in a finally block, and asserts nothing threw — proving the lockstep path is transcendental-free.

**Interacts with:** P1-6 (both change the deterministic sequence; ship in the same version bump), P0-2 (regenerate the golden hash fixture).

### P1-5 [medium] Give resolveCircleCollision safe bounce defaults and make NaN state loudly visible
- [ ] `shared/physics.js`, `js/game.js` — locate: `const restitution = (bounceA + bounceB) / 2;`

`resolveCircleCollision` computes `restitution = (bounceA + bounceB) / 2` with no validation, so a caller that omits the bounce arguments produces NaN impulse and NaN velocities for both entities. Nothing downstream stops the spread: `clampSpeed`'s comparison is false for NaN, `constrainToField` comparisons are all false, and `checkGoal` returns null forever, so one NaN permanently freezes entities and makes the match unfinishable. The lockstep checksum hashes NaN as 0 (`(NaN|0) === 0`), so identical NaN on both peers reports "in sync" while the match is destroyed. The determinism test already fell into exactly this trap (fully non-finite state within 64 ticks), proving the footgun is real for any future caller.

**Change:**
1. In `shared/physics.js`, change the signature to `resolveCircleCollision(a, b, bounceA = Physics.PLAYER_BOUNCE, bounceB = Physics.PLAYER_BOUNCE)` (the `Physics` const is in closure scope inside the factory, so the default expression resolves at call time).
2. In `js/game.js _computeChecksum` (line ~737), make non-finite state loud: change the `add` helper to `const add = (v) => { if (!Number.isFinite(v)) { if (!this._nanWarned) { this._nanWarned = true; console.error('Non-finite value in lockstep checksum state'); } v = 0; } h = (h * 31 + (v | 0)) | 0; };` — the hashed value for non-finite input stays 0 exactly as before (so this changes no checksum output), but corruption can no longer pass silently.
3. Bump `?v=` for `shared/physics.js` and `js/game.js` in `index.html`.

Determinism guardrail: the defaults change nothing for any existing production call site (js/game.js:1447/1552, server/game-simulation.js:561/624, js/rl/env.js, js/rl/env2v2.js all pass explicit constants), and the checksum helper produces bit-identical hashes for all finite state — behavior is identical on every peer. No sim-state field is added or removed (`_nanWarned` is a local diagnostic flag never simulated, hashed, or serialized), so `_computeChecksum` output and `_serializeFullState` are unchanged. Swift parity: `ios/App/App/KickZone/Game/Physics.swift` uses non-optional typed parameters, so the omitted-argument failure cannot occur there — no change needed.

**Verify:** `npm test`. Add a regression test in `test/shared-core.test.js`: create two overlapping entities with closing velocities (e.g. `{x:0,y:0,vx:1,vy:0,radius:20,mass:1}` and `{x:10,y:0,vx:-1,vy:0,radius:20,mass:1}`), call `Physics.resolveCircleCollision(a, b)` with no bounce arguments, and assert all four velocity components are finite via `Number.isFinite`. The P0-fixed determinism test (which now passes bounce args and asserts per-tick finiteness) must also stay green.

**Interacts with:** P0-1 (the determinism-test bounce-args + finiteness fix).

### P1-6 [medium] Fix SeededRNG to use the unsigned shift required by xorshift32
- [ ] `js/game.js`, `test/determinism.test.js` — locate: `this.s ^= this.s >> 17;`

`SeededRNG.next()` (js/game.js:8) uses the arithmetic shift `this.s ^= this.s >> 17` where xorshift32 requires the logical shift `>>>`. Sign extension makes the per-step state map 2-to-1 instead of a bijection (states 0xf6f4c545 and 0x0af4daba map to the same successor), destroying the guaranteed 2^32-1 period and statistical properties, and state 0 is absorbing — a reachable lock-up (0xfc001fff maps to 0 in one step) after which `next()` returns 0.0 forever, freezing all AI jitter and power-up randomness. It does not desync peers (all run the same code and `rng.s` is checksummed), but this PRNG drives all match-critical randomness. The test mirror in test/determinism.test.js:24 has the identical bug and must change in the same commit.

**Change:**
1. In `js/game.js` line 8, change `this.s ^= this.s >> 17;` to `this.s ^= this.s >>> 17;`.
2. In `test/determinism.test.js` line 24 (the mirrored `SeededRNG` class), make the identical change.
3. This changes the deterministic random sequence, so it must ship simultaneously to all lockstep peers: bump the `?v=` on `js/game.js` in `index.html` (this package already bumps it) and land P1-4 and P1-6 in the same release so no mixed-version match is possible.
4. Add a canonical-sequence test (in `test/determinism.test.js`): seeding with 1, the first three post-step states `(rng.s >>> 0)` after each `next()` call must be exactly `270369`, `67634689`, `2647435461` — the published xorshift32(13,17,5) sequence. Any future regression to `>>` fails this immediately.

Determinism guardrail: every peer steps the identical new sequence from the shared match seed; `rng.s` is already covered by `_computeChecksum` (js/game.js:770) and `_serializeFullState` (`rng` field), so no checksum/serializer change is needed. Swift parity: the iOS port (ios/App/App/KickZone/) does not port this PRNG at all (it uses Swift's own randomness and is single-player only), so no Swift change is needed.

**Verify:** `npm test` — the new canonical-sequence assertion passes with `>>>` and fails with `>>`; the P0-2 golden hash fixture is regenerated in this same commit (the RNG sequence change alters every AI decision).

**Interacts with:** P1-4 (ships in the same version bump), P0-1/P0-2 (the test file's mirrored RNG and the golden fixture).

### P1-7 [low] Remove trail generation (and its Math.random) from Ball.update
- [ ] `shared/entities.js`, `js/game.js`, `js/rl/env.js`, `js/rl/env2v2.js`, `server/game-simulation.js`, `test/determinism.test.js` — locate: `this._addTrailPoint(this.x + (Math.random() - 0.5) * 6`

`Ball.update`'s trail block (shared/entities.js:291-302) calls `Math.random()` twice per tick while a superkick is live, and the lockstep path calls `this.ball.update(dt)` with `skipTrail` defaulting to false (js/game.js:1421) — unseeded randomness executes inside the shared entity's sim update every lockstep tick. It only writes the cosmetic trail buffer today, so it cannot desync gameplay, but nothing enforces that containment and the determinism test explicitly skips the branch, so a future regression that lets the jitter touch position/velocity would pass all tests. The codebase already has the right pattern: online mode builds the trail in the render loop (js/game.js:542-550).

**Change:**
1. In `shared/entities.js Ball.update`, delete the entire `if (!skipTrail) { ... }` trail block (lines ~290-302) and remove the `skipTrail` parameter, making the signature `update(dt)`. The shared entity update is now 100% randomness-free.
2. Update every call site to drop the second argument: `js/rl/env.js:269`, `js/rl/env2v2.js:310`, `server/game-simulation.js:541` (all currently `this.ball.update(dt, true)`), and `test/determinism.test.js:85` (`ball.update(TICK_MS, true)` → `ball.update(TICK_MS)`). `js/game.js:1421` already passes only `dt`.
3. In `js/game.js loop()`, generalize the existing online-only trail block (line ~542): change the condition `if (this.isOnline && this.ball)` to `if (this.ball && this.isRunning)` and extend the body to reproduce the removed entity logic exactly: compute speed; `const maxPairs = this.ball.superKick > 0 ? 20 : 10;`; if `this.ball.superKick > 0 && speed > 1`, push `_addTrailPoint(this.ball.x, this.ball.y, maxPairs)` plus a second point jittered by `(Math.random() - 0.5) * 6` on each axis; else if `speed > 3`, push one point; else if `trailCount > 0`, decrement `trailCount`. `Math.random` is fine here — this runs after the tick loop, render-side only.
4. Bump `?v=` for `shared/entities.js` and `js/game.js` in `index.html`.

Determinism guardrail: trail fields (`trail`, `trailHead`, `trailCount`) are cosmetic, read only by `getTrailPoints()` for rendering, and are not covered by `_computeChecksum` or `_serializeFullState` — removing the writes from the sim changes no simulated or hashed state, identically for all peers. Swift parity: `ios/App/App/KickZone/Models/Ball.swift` has no trail logic in its update, so no Swift change is needed.

**Verify:** `npm test` — the determinism test now runs `Ball.update` with no trail-skipping escape hatch, so any reintroduction of `Math.random` into the entity update fails it. `grep -n "Math.random" shared/` returns nothing. Manual check: start an offline match, land a fully charged super kick, and confirm the fiery jittered trail still renders.

**Interacts with:** P1-2 (same function and same render/sim boundary), P0-2 (golden fixture: hashes are unaffected since trail state is not hashed, but the test call-site signature changes in this item).

### P1-8 [low] Clear stale kick/movement input when a match starts
- [ ] `js/game.js` — locate: `// Reset per-match input state so a stale "kick held"`

Controls handlers write into `game.input` unconditionally, even on menu/result screens: releasing Space on the result screen sets `input.kickRelease = true` with `kickChargeTime` up to 1500 (js/controls.js:273-279), and only `quit()` clears input state (js/game.js:2317-2325) — `startMatch()`/`restart()` do not. Pressing and releasing Space on the result screen and then tapping Rematch makes the first simulation tick of the new match consume the stale flag: the player fires an unprompted fully-charged kick with screen shake and sound at kickoff.

**Change:** In `js/game.js`, extract the input-reset block from `quit()` (the lines resetting `this.input.x/y/kick/kickCharging/kickRelease/kickChargeTime/switchPlayer/pull` and the same `this.input2` fields, lines ~2317-2325) into a new method `_resetInputs()` that mutates the fields of the existing `this.input`/`this.input2` objects (do not replace the objects — Controls holds references to them). Call `this._resetInputs()` from `quit()` where the block used to be, and add a call at the top of `startMatch()` (line ~341) and at the top of `startPractice()` (line ~427).

Determinism guardrail: this only clears the local pre-match input staging objects; in lockstep, simulated inputs come exclusively from the confirmed-input buffer, and each peer clearing its own local input at match start cannot diverge the shared sim. No sim-state field is added or removed — `_computeChecksum` and `_serializeFullState` are unchanged. Swift parity: the iOS port has its own input lifecycle and does not share this Controls/Game wiring, so no Swift change is needed.

**Verify:** `npm test` still passes (game.js is browser-only, so this is a manual check): play an offline match to the result screen, press and release Space on the result screen, click Rematch, and confirm no kick sound, screen shake, or ball launch occurs on the first tick of the new match; also confirm in-match kicking still works and that `quit()` followed by a new match behaves unchanged.

**Interacts with:** none.

---

## Package P2 — Server hardening (trust, robustness, security)
**Goal.** The server must never trust client-supplied values, never let one bad client/room take down the process or other rooms, and bound all resources.
**When.** Independent of P1; can land in parallel. Group into one PR.
**Agent capability.** basic agent
**Package verification.** Run `npm test` from the repo root (runs `node --test` over `test/`) — all existing and newly added tests must pass. Then boot the server locally with `node server/server.js` and confirm `curl -s localhost:8080/health` prints `ok` and the process stays up with no exceptions in the log.

---

### P2-1 [high] Whitelist team values at every ingress and sweep wedged PLAYING rooms
- [ ] `server/game-room.js`, `server/room-manager.js` — locate: `let team = preferredTeam;`

`GameRoom.addPlayer` stores any truthy client-supplied team string verbatim (only falsy or a full `'red'`/`'blue'` is re-assigned), and `GameRoom.switchTeam` accepts any string because the count of players on a nonsense team is always below `teamSize`. When the host later starts the match, `GameSimulation.addSlot` does `positions[team][idx]` on `positions = { red: [], blue: [] }`, so a team like `'purple'` throws a TypeError. The exception is swallowed by the message try/catch in `server/server.js`, leaving the room stuck in PLAYING forever: nobody can join, the host cannot restart, and `cleanupStaleRooms` only sweeps FINISHED and WAITING rooms. Any client can brick any public lobby room by joining with a crafted `team` value in JOIN_ROOM or SWITCH_TEAM.

**Change:**
1. In `server/game-room.js` `addPlayer`, before the auto-assign block, coerce the input: `if (preferredTeam !== 'red' && preferredTeam !== 'blue') preferredTeam = null;` (keep the existing capacity-based auto-balance logic after it).
2. In `server/game-room.js` `switchTeam`, add an early return at the top: `if (newTeam !== 'red' && newTeam !== 'blue') return;`.
3. In `server/room-manager.js` `cleanupStaleRooms`, extend the classic-room sweep condition to also remove wedged rooms: sweep when `room.state === ROOM_STATE.PLAYING && (!room.simulation || !room.simulation.isRunning)`. (A healthy PLAYING room always has `simulation.isRunning === true`; `_endMatch` flips state to FINISHED synchronously, so this only matches rooms whose startMatch crashed.)
No sim-state fields are added or removed; `js/game.js` `_computeChecksum`/`_serializeFullState` need no update. The Swift port has no lobby/team-join code, so no iOS change.

**Verify:** `npm test`. Add a regression test in `test/room-manager.test.js`: create a room, send `JOIN_ROOM` with `team: 'purple'`, assert the joined player's stored `team` is `'red'` or `'blue'`; send `SWITCH_TEAM` with `team: 'green'` and assert the player's team is unchanged; then send `START_MATCH` and assert it does not throw and `room.state === 'playing'` with a running simulation.

**Interacts with:** P2-12 (both touch `cleanupStaleRooms`).

---

### P2-2 [high] Track kick charge server-side and put the melee stun on a cooldown
- [ ] `server/game-simulation.js` — locate: `this._hitNearbyPlayers(p, chargeRatio);`

The authoritative simulation trusts the client-claimed charge time: `applyInput` clamps `input.kt` only to [0, 1500], and the charge movement penalty applies only when the client volunteers `kc=1`. A hacked client sending `{kr:1, kt:1500, kc:0}` every frame gets full-power super kicks every 180 ms with no charge slowdown. Worse, `_hitNearbyPlayers` runs on every kick release before the cooldown-gated `p.kick()` and has no cooldown of its own, so it re-applies a 1000 ms stun plus stacking knockback to every nearby opponent on every 60 Hz tick — a permanent stun-lock that defeats the authoritative-server anti-cheat model.

**Change:** All edits are in `server/game-simulation.js`; this is the server-authoritative sim, not the P2P lockstep sim, so host/guest lockstep determinism is unaffected, no shared/ file changes, no `js/game.js` checksum/serializer update, and no Swift parity change.
1. In `addSlot` (the `this._inputQueues[slot.index] = {...}` line), add two server-owned fields to the queue object: `serverChargeMs: 0, meleeCooldownMs: 0`.
2. In `applyInput`, delete the two lines that parse and clamp `input.kt ?? input.kickChargeTime` into `q.kickChargeTime` — the wire value is no longer read anywhere. Keep parsing `kc`/`kickCharging` and the one-shot ORs.
3. In `tick()`'s human-input loop, decrement the melee cooldown each tick: `if (input.meleeCooldownMs > 0) input.meleeCooldownMs -= dt;` (put it right after `const p = slot.player;`, before the frozen/stun `continue`).
4. Replace the charging branch: when `input.kickCharging`, accumulate `input.serverChargeMs = Math.min(input.serverChargeMs + dt, MAX_KICK_CHARGE_MS);` and set `p.kickChargeRatio = input.serverChargeMs / MAX_KICK_CHARGE_MS;` (keep the existing movement-slowdown lines using this ratio). When not charging and not releasing this tick, reset `input.serverChargeMs = 0` and `p.kickChargeRatio = 0`.
5. In the `input.kickRelease` branch, compute `const chargeRatio = Math.min(input.serverChargeMs / MAX_KICK_CHARGE_MS, 1);`, then gate the melee: `if (chargeRatio >= 0.25 && input.meleeCooldownMs <= 0) { this._hitNearbyPlayers(p, chargeRatio); input.meleeCooldownMs = 500; }`. Keep the `p.kick(this.ball, chargeRatio)` call as-is. Replace `input.kickChargeTime = 0` with `input.serverChargeMs = 0` at the end of the branch.

**Verify:** `npm test`. Add a regression test in `test/server-simulation.test.js`: build a `GameSimulation` with two opposing human slots placed adjacent, call `applyInput` with `{kr:1, kt:1500}` and run one `tick()` — assert the opponent's `stunTimer` is 0 (no server-accumulated charge means no melee and no super kick). Then simulate holding charge (`{kc:1}` inputs across ~90 ticks) followed by `{kr:1}` and assert the kick fires with full charge. Finally, spam `{kc:1, kr:1}` for 60 consecutive ticks and assert the opponent's stun is applied at most twice (melee cooldown enforced).

**Interacts with:** none. (The lockstep path in `js/game.js` `hitNearbyPlayers` has similar semantics but runs identically on all peers; changing it is out of scope for this item and would require a paired change on every peer plus the Swift port — leave it untouched here.)

---

### P2-3 [high] Restrict switch-player to AI-controlled teammates
- [ ] `server/game-simulation.js` — locate: `const teammates = this.players.filter(t => t.team === p.team && t !== p);`

`_switchPlayer` picks the same-team player nearest the ball without excluding human-controlled players. In a 2v2+ match with two humans on one team, pressing switch when your human teammate is nearest the ball overwrites their slot's `playerId` with yours and turns your old slot into AI. The victim's `playerId` then maps to no slot, so all their subsequent inputs are silently dropped for the rest of the match, and their disconnect never triggers AI replacement. One normal button press permanently hijacks a teammate's avatar.

**Change:** In `server/game-simulation.js` `_switchPlayer`, change the candidate filter to `this.players.filter(t => t.team === p.team && t !== p && !t.isHuman);` — the existing `if (teammates.length === 0) return;` already handles the no-AI-teammate case. This is the server-authoritative sim only: no shared/ or `js/game.js` change, so lockstep determinism, `_computeChecksum`, `_serializeFullState`, and the Swift port are all unaffected.

**Verify:** `npm test`. Add a regression test in `test/server-simulation.test.js`: create a simulation with `teamSize: 2`, add two human slots on red (so no red AI exists), place the second human nearest the ball, send a switch input from the first human, run a tick, and assert both slots retain their original `playerId` values. Then repeat with one human plus one AI on red and assert the swap moves the human's `playerId` to the AI's slot.

**Interacts with:** none.

---

### P2-4 [medium] Close the MAPS prototype-chain bypass in map validation
- [ ] `server/game-room.js`, `server/game-simulation.js` — locate: `GameConstants.MAPS[settings.map] ? settings.map : 'classic'`

`sanitizeSettings` validates the map with a truthiness lookup on a plain object literal, so inherited `Object.prototype` keys pass: `settings.map = 'constructor'` (also `'toString'`, `'hasOwnProperty'`, …) survives sanitization. The `GameSimulation` constructor then resolves `GameConstants.MAPS['constructor']` to the truthy `Function` object, so `virtualW`/`virtualH` are `undefined` and all field, ball, and spawn positions become NaN — the whole match runs on NaN physics with goals that can never trigger. A griefer can host such rooms and let QUICK_MATCH funnel strangers into guaranteed-broken matches.

**Change:**
1. In `server/game-room.js` `sanitizeSettings`, replace the map line with: `map: (typeof settings.map === 'string' && Object.hasOwn(GameConstants.MAPS, settings.map)) ? settings.map : 'classic',`.
2. In `server/game-simulation.js` constructor, replace `const mapInfo = GameConstants.MAPS[settings.map] || GameConstants.MAPS.classic;` with `const mapInfo = (typeof settings.map === 'string' && Object.hasOwn(GameConstants.MAPS, settings.map)) ? GameConstants.MAPS[settings.map] : GameConstants.MAPS.classic;`.
Determinism guardrail: this touches `server/game-simulation.js` but only rejects invalid maps that already produced broken NaN state; for every whitelisted map, behavior is bit-identical. No shared/ file or sim-state field changes, so `js/game.js` `_computeChecksum`/`_serializeFullState` need no update. The Swift port's `Constants.swift` hardcodes its own map data and never indexes by client string, so no iOS parity change.

**Verify:** `npm test`. Add a regression test in `test/room-manager.test.js` (or `test/server-simulation.test.js`): create a room with `settings: { map: 'constructor' }`, assert `room.settings.map === 'classic'`, start the match, and assert `Number.isFinite(room.simulation.ball.x)`.

**Interacts with:** P2-5 (P2-5 reuses `sanitizeSettings`, so land this first).

---

### P2-5 [medium] Sanitize P2P room settings at creation with the classic-room whitelist
- [ ] `server/room-manager.js`, `server/game-room.js` — locate: `const settings = data?.settings || { teamSize: 2, map: 'classic', duration: 180, goalLimit: 0 };`

`_createP2PRoom` stores `data.settings` verbatim, unlike classic rooms which run `sanitizeSettings`. The unsanitized `teamSize` drives capacity math: a non-numeric value makes `maxPlayers` NaN so the join-capacity check never rejects (unlimited joins) and the start-time occupancy guard is NaN-poisoned; a huge value is echoed to every joiner whose client then builds that many entities (client freeze/crash). The whole attacker-controlled blob (up to the 64 KB frame cap) is also rebroadcast verbatim to every peer in ROOM_JOINED, ROOM_UPDATE, and MATCH_STARTING. The UPDATE_SETTINGS path whitelists teamSize but the creation path bypasses it entirely.

**Change:**
1. In `server/game-room.js`, export the sanitizer: after `module.exports = GameRoom;` add `module.exports.sanitizeSettings = sanitizeSettings;`.
2. In `server/room-manager.js`, destructure it at the top: `const GameRoom = require('./game-room'); const { sanitizeSettings } = GameRoom;` (adjust the existing require line).
3. In `_createP2PRoom`, replace the settings line with `const settings = sanitizeSettings(data?.settings || { goalLimit: 0 });` — passing `{ goalLimit: 0 }` when the client sends nothing preserves the previous P2P default of "no goal limit" (`sanitizeSettings({goalLimit: 0})` yields `{ teamSize: 2, duration: 180, goalLimit: 0, powerups: true, map: 'classic' }`).
Determinism note: the sanitized settings object is broadcast identically to host and all guests in MATCH_STARTING, so every peer constructs its lockstep sim from the same values — no divergence, no checksum/serializer change, no Swift change.

**Verify:** `npm test`. Add a regression test in `test/room-manager.test.js` (or `test/p2p-protocol.test.js`): send `CREATE_P2P_ROOM` with `settings: { teamSize: 'lots', map: 'constructor', duration: 999, extra: 'x'.repeat(1000) }` and assert the stored room settings are exactly `{ teamSize: 2, duration: 180, goalLimit: 5, powerups: true, map: 'classic' }` (no `extra` key), and that joining a 5th player into the 2v2 room is rejected with a 'Room is full' ERROR.

**Interacts with:** P2-4 (modifies the same `sanitizeSettings`; land P2-4 first).

---

### P2-6 [low] Validate and bound player names at every ingress
- [ ] `server/room-manager.js` — locate: `const name = data?.name || 'Player';`

All five name ingress points (`_createRoom`, `_joinRoom`, `_quickMatch`, `_createP2PRoom`, `_joinP2PRoom`) accept `data.name` with only `|| 'Player'` — any truthy value passes, including a ~64 KB string, an object, or an array. The value is stored and re-serialized into every ROOM_UPDATE/ROOM_JOINED broadcast, MATCH_STARTING slot list, and the public unauthenticated `/api/lobby` response, creating an amplification vector and shipping unbounded untrusted content to other clients.

**Change:** Add one helper near the top of `server/room-manager.js`:
```js
function sanitizeName(raw) {
    if (typeof raw !== 'string') return 'Player';
    const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 20);
    return cleaned || 'Player';
}
```
Replace all five occurrences of `data?.name || 'Player'` (in `_createRoom`, `_joinRoom`, `_quickMatch`, `_createP2PRoom`, `_joinP2PRoom`) with `sanitizeName(data?.name)`. Server-only change; no sim, checksum, or iOS impact.

**Verify:** `npm test`. Add a regression test in `test/room-manager.test.js`: create a room with `name: 'x'.repeat(5000)` and assert the stored host name is 20 chars; create another with `name: { a: 1 }` and assert it is `'Player'`; assert control characters are stripped.

**Interacts with:** none.

---

### P2-7 [high] Add per-connection rate limiting, per-IP and global connection caps, and a room cap
- [ ] `server/server.js`, `server/room-manager.js` — locate: `wss.on('connection', (ws) => {`

The WebSocket server accepts unlimited connections with no per-IP throttle, no cap on total connections, no message-rate limit, and no cap on rooms or concurrently running simulations. An attacker can open N sockets, each with a fresh uuid identity, send CREATE_ROOM + START_MATCH on each, and the server runs N independent 60 Hz AI-filled simulations — CPU and memory exhaustion on the 1 GB Fly VM. P2P rooms held by open sockets persist up to 24 h, so held sockets hold rooms indefinitely.

**Change:**
1. In `server/server.js`, change the handler to `wss.on('connection', (ws, req) => {` and derive `const ip = req.headers['fly-client-ip'] || req.socket.remoteAddress;`.
2. Add module-level `const ipCounts = new Map();` and constants `MAX_CONNS_PER_IP = 20`, `MAX_TOTAL_CONNS = 2000`. At the top of the connection handler: if `wss.clients.size > MAX_TOTAL_CONNS` or `(ipCounts.get(ip) || 0) >= MAX_CONNS_PER_IP`, call `ws.close(1013, 'Server busy')` and return before registering message handlers. Otherwise increment `ipCounts` and decrement it in the `'close'` handler (delete the key at 0).
3. Add a token bucket per socket: on connection set `ws._tokens = 120; ws._lastRefill = Date.now();`. At the top of the `'message'` handler refill `ws._tokens = Math.min(120, ws._tokens + (now - ws._lastRefill) * 0.06); ws._lastRefill = now;` (60 msgs/sec sustained, 120 burst); if `ws._tokens < 1`, call `ws.close(1008, 'Rate limit exceeded')` and return; else `ws._tokens -= 1` and proceed.
4. In `server/room-manager.js`, add `const MAX_ROOMS = 500;` and at the top of both `_createRoom` and `_createP2PRoom`: `if (this.rooms.size + this.p2pRooms.size >= MAX_ROOMS) { this._sendTo(ws, MSG.ERROR, { message: 'Server is full' }); return; }`. (QUICK_MATCH creates via `_createRoom`, so it is covered.)
Server-only change; no sim, checksum, or iOS impact. The 60 msgs/sec budget comfortably covers the client's 60 Hz INPUT cadence plus pings.

**Verify:** `npm test`. Add a regression test in `test/room-manager.test.js`: monkey-set `rm.rooms` to contain 500 dummy entries (or loop `_createRoom` with distinct ids after lowering the cap via a test hook) and assert the next CREATE_ROOM receives an ERROR 'Server is full'. Manually: `node server/server.js`, open a ws client, send 1000 messages in a tight loop, and confirm the socket is closed with code 1008 while a second normal client stays connected.

**Interacts with:** P2-17 (failed-join throttle rides on the same abuse-handling layer), P2-8/P2-9 (all touch `server.js` connection lifecycle).

---

### P2-8 [medium] Add a WebSocket heartbeat to detect half-dead connections
- [ ] `server/server.js` — locate: `ws.playerId = playerId;`

The server never pings sockets and tracks no liveness flag, so a half-open TCP connection (mobile radio loss, NAT timeout, crashed browser without FIN) keeps `readyState === OPEN` indefinitely. Zombies occupy lobby slots, mid-match players are never handed to AI (that only happens on a `'close'` event), state broadcasts keep buffering into dead sockets, and the P2P zombie sweep explicitly trusts `readyState === 1`, so zombie P2P host rooms survive up to the 24 h age cap.

**Change:** In `server/server.js`, implement the standard `ws` heartbeat: in the connection handler set `ws.isAlive = true;` and register `ws.on('pong', () => { ws.isAlive = true; });`. Add a module-level interval after the `wss` setup:
```js
const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) { ws.terminate(); continue; }
        ws.isAlive = false;
        ws.ping();
    }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));
```
`terminate()` fires `'close'`, which already routes into `roomManager.handleDisconnect` and cleans up rooms, AI handoff, and P2P teardown. Server-only change; no sim, checksum, or iOS impact.

**Verify:** `npm test` (existing suites must still pass — the interval must not keep test processes alive; use `heartbeat.unref()` after creating it so `node --test` and the process can exit naturally). Manually: start the server, connect a ws client that never responds to pings (e.g. a raw TCP socket after the upgrade handshake, or patch a client lib to drop pongs), and confirm the server terminates it within ~60 s and logs the disconnect.

**Interacts with:** P2-9 (the hard-cap termination check is added to this same interval), P2-7.

---

### P2-9 [medium] Skip and eventually terminate stalled sockets using ws.bufferedAmount
- [ ] `server/game-room.js`, `server/room-manager.js`, `server/server.js` — locate: `try { playerData.ws.send(msg); } catch(e) {}`

Nothing in the server ever reads `ws.bufferedAmount`. State snapshots go to every client dozens of times per second; a client whose TCP window has stalled (congested link, backgrounded tab, half-dead socket) keeps `readyState` OPEN while Node queues every frame in heap memory for the duration of the match, and per-message-deflate burns CPU compressing frames that will never be delivered. The P2P relay path `_relayP2PData` has the same gap when fanning host state to peers.

**Change:**
1. In `server/game-room.js` `_broadcastToAll(type, data)`, inside the send loop: when `type === MSG.STATE` and `playerData.ws.bufferedAmount > 64 * 1024`, `continue` without sending (snapshots are full-state; dropped ones are harmless).
2. In `server/room-manager.js` `_relayP2PData`, before `this._sendTo(peer.ws, clientType, msg.d)`: when `clientType === 'state'` and `peer.ws.bufferedAmount > 64 * 1024`, skip that peer. Do NOT skip `ci`/`cs`/`goal`/`match_end` frames — confirmed inputs and resync snapshots are lockstep-critical and must stay ordered; a stalled socket delays them regardless, and the hard cap below handles pathological cases.
3. Hard cap: in the heartbeat interval added by P2-8 in `server/server.js`, before the isAlive check add `if (ws.bufferedAmount > 1024 * 1024) { ws.terminate(); continue; }` so any socket saturated above 1 MB is killed and cleaned up through the normal disconnect path.
Server-only transport change: no peer's simulation input stream is altered (only droppable interpolation snapshots are skipped), so lockstep determinism is preserved; no checksum/serializer or iOS change.

**Verify:** `npm test`. Add a regression test in `test/room-manager.test.js` using the existing `fakeWs()` stub extended with a settable `bufferedAmount`: set a peer's `bufferedAmount` to `100000`, invoke `_relayP2PData` with a `p2p_relay_state` message, and assert nothing was pushed to that peer's `sent` array while a `p2p_relay_ci` message still goes through. Similarly assert `_broadcastToAll(MSG.STATE, ...)` skips a backed-up player but `_broadcastToAll(MSG.GOAL, ...)` does not.

**Interacts with:** P2-8 (hard cap lives in the heartbeat interval — land P2-8 first).

---

### P2-10 [medium] Isolate simulation-tick and sweep-interval crashes from the process
- [ ] `server/game-simulation.js`, `server/server.js` — locate: `this.tickInterval = setInterval(() => this._drive(), 1000 / this.tickRate);`

The 60 Hz simulation driver runs from a bare `setInterval` with no try/catch anywhere in `_drive()`/`tick()`, which calls deep into shared AI/physics/power-up code. Any exception on that path escapes to the event loop as an uncaughtException and kills the whole Node process, ending every concurrent match. The 60 s `cleanupStaleRooms` interval in `server.js` is equally unprotected. One bad room must not take down the process.

**Change:**
1. In `server/game-simulation.js`, wrap the entire body of `_drive()` in try/catch. In the catch: `console.error('Simulation tick crashed:', err);` then `this.stop();` set `this.matchOver = true;` and fire `if (this.onMatchEnd) this.onMatchEnd({ redScore: this.redScore, blueScore: this.blueScore, stats: this.stats, aborted: true });`. GameRoom's existing `onMatchEnd` handler then marks the room FINISHED, broadcasts MATCH_END to clients, and triggers `onFinished` → `_cleanupRoom`, releasing the room.
2. In `server/server.js`, wrap the sweep callback: `setInterval(() => { try { roomManager.cleanupStaleRooms(); } catch (e) { console.error('Room sweep failed:', e); } }, 60000);`.
Determinism guardrail: this touches `server/game-simulation.js` (server-authoritative sim only) and changes no tick math — behavior is identical unless a crash already occurred. No shared/ or sim-state field changes, so `js/game.js` `_computeChecksum`/`_serializeFullState` are untouched and no Swift parity change is needed.

**Verify:** `npm test`. Add a regression test in `test/server-simulation.test.js`: create and start a simulation, monkey-patch `sim.tick = () => { throw new Error('boom'); }`, register an `onMatchEnd` spy, call `sim._drive()` directly, and assert it does not throw, `sim.isRunning === false`, and `onMatchEnd` was called with `aborted: true`.

**Interacts with:** P2-11 (both rewrite `_drive()`; apply sequentially).

---

### P2-11 [medium] Drive the tick accumulator from a monotonic clock and clamp negative elapsed time
- [ ] `server/game-simulation.js` — locate: `let elapsed = now - this._lastTickTime;`

`_drive` computes elapsed time from `Date.now()`, which is wall-clock and steps backward under NTP corrections, VM migration, and host suspend/resume. Only the positive direction is clamped, so a backward step of T seconds drives `_tickAccumulator` deeply negative and every simulation on the process freezes (no ticks, no state sends, stopped match clock) until T of real time re-accumulates, while connections stay alive.

**Change:** In `server/game-simulation.js`, add `const { performance } = require('node:perf_hooks');` at the top. In `start()`, set `this._lastTickTime = performance.now();`. In `_drive()`, use `const now = performance.now();` and after computing `elapsed`, add `if (elapsed < 0) elapsed = 0;` as a defensive clamp. Determinism guardrail: touches `server/game-simulation.js` only; per-step tick math is unchanged (ticks still advance in exact TICK_MS steps), no shared/ or sim-state field change, no `js/game.js` checksum/serializer update, no Swift change (the iOS engine uses its own display-link timing).

**Verify:** `npm test`. Add a regression test in `test/server-simulation.test.js`: start a simulation, record `tickNumber`, set `sim._lastTickTime = performance.now() + 60000` (simulating a 60 s backward clock step), call `sim._drive()` twice with a ~17 ms real sleep between them (or stub `performance.now` progression), and assert `_tickAccumulator >= 0` and that `tickNumber` still advances on subsequent driven frames.

**Interacts with:** P2-10 (both rewrite `_drive()`; apply sequentially).

---

### P2-12 [medium] Sweep lobbies on inactivity, notify affected sockets, and error on actions from unmapped players
- [ ] `server/room-manager.js`, `server/game-room.js` — locate: `now - room.createdAt > 10 * 60 * 1000`

`cleanupStaleRooms` deletes any WAITING room older than 10 minutes regardless of activity — `createdAt` is never refreshed by joins, team switches, or settings changes — and `_cleanupRoom` sends nothing to the affected sockets. Players waiting >10 minutes for friends are left staring at a live-looking lobby; the host's next START_MATCH finds no `playerRooms` entry and returns silently, as does every subsequent lobby action.

**Change:**
1. In `server/game-room.js`: set `this.lastActivityAt = Date.now();` in the constructor and add a `touch() { this.lastActivityAt = Date.now(); }` method. Call `this.touch()` at the top of `addPlayer`, `removePlayer`, and `switchTeam` (after the early-return guards).
2. In `server/room-manager.js` `_updateSettings` (classic branch), call `room.touch()` after a successful settings update.
3. In `cleanupStaleRooms`, change the WAITING condition to use `now - room.lastActivityAt > 10 * 60 * 1000` (keep the FINISHED condition). Before calling `_cleanupRoom(code)` on a WAITING room, notify its members: `for (const [pid] of room.players) room._sendTo(pid, MSG.ERROR, { message: 'Room closed due to inactivity' });`.
4. In `_startMatch`, replace the two silent returns (`if (!roomCode) return;` and `if (!room) return;`) with sends of `MSG.ERROR` `{ message: 'You are not in a room' }` via `this.playerWs.get(playerId)` before returning.
Server-only change; no sim, checksum, or iOS impact.

**Verify:** `npm test`. Add a regression test in `test/room-manager.test.js`: create a room, backdate `room.lastActivityAt` by 11 minutes, call `rm.cleanupStaleRooms()`, and assert the room is gone AND the host's fake ws received an ERROR message; then send START_MATCH from the now-unmapped host and assert an ERROR reply arrives instead of silence. Also assert that a room whose `lastActivityAt` was refreshed by a recent join survives the sweep.

**Interacts with:** P2-1 (both touch `cleanupStaleRooms`).

---

### P2-13 [medium] Scope the WebRTC signaling relay to same-room host↔peer pairs
- [ ] `server/room-manager.js` — locate: `_relaySignal(fromId, msg) {`

`_relaySignal` forwards SIGNAL_OFFER/ANSWER/ICE to `playerWs.get(msg.d.targetId)` with no verification that sender and target share a room — authorization rests entirely on the target uuid being secret, but playerIds are broadcast to every room member via slots/P2P_PEER_JOINED. Anyone who ever shared a lobby with a victim can, even after leaving, inject fabricated offers/ICE at them, forcing their client to build and tear down RTCPeerConnections mid-match. The sibling relays `_relayP2PData` and `_relayP2PInput` both check membership; this one was missed.

**Change:** In `server/room-manager.js` `_relaySignal`, add checks mirroring the sibling relays before forwarding (signaling topology is a star — the host exchanges SDP/ICE with each peer, per `js/p2p.js` `_handleOffer(hostId, ...)`):
```js
_relaySignal(fromId, msg) {
    const ref = this.playerRooms.get(fromId);
    if (!ref || !ref.startsWith('p2p:')) return;
    const room = this.p2pRooms.get(ref.slice(4));
    if (!room) return;
    const targetId = msg.d?.targetId;
    const isMember = (id) => id === room.hostId || room.peers.has(id);
    if (!isMember(fromId) || !isMember(targetId)) return;
    if (fromId !== room.hostId && targetId !== room.hostId) return; // star topology only
    // ...existing playerWs lookup + _sendTo...
}
```
Server-only change; no sim, checksum, or iOS impact.

**Verify:** `npm test`. Add a regression test in `test/room-manager.test.js` (or `test/p2p-protocol.test.js`): set up a P2P room with host H and peer A, plus an outsider X in no room (and a second case: X in a different P2P room). Send `SIGNAL_OFFER` from X targeting A and assert A's fake ws received nothing; send `SIGNAL_OFFER` from H targeting A and `SIGNAL_ANSWER` from A targeting H and assert both are delivered with `fromId` attached; send `SIGNAL_ICE` from A targeting another peer B (peer→peer) and assert it is dropped.

**Interacts with:** none.

---

### P2-14 [medium] Move TURN credentials out of client source; serve them from the signaling server
- [ ] `js/p2p.js`, `server/server.js` — locate: `credential: 'kMpLJTKsS2+wrFux'`

The metered.ca TURN username/credential pair is hardcoded three times in `js/p2p.js` (`_rtcConfig.iceServers`), shipped to every visitor, and committed to a public repo. Anyone can lift these long-lived credentials and relay arbitrary traffic through the project's TURN account, exhausting the quota and breaking TURN fallback for the ~10-15% of players who need it. Rotation currently requires a client redeploy, and native builds bake the credential in permanently.

**Change:**
1. In `server/server.js`, add a `GET /api/turn` route (next to `/api/lobby`) that returns `{ iceServers }` built from environment variables: `TURN_URLS` (comma-separated URL list), `TURN_USERNAME`, `TURN_CREDENTIAL`. When any variable is unset, return `{ iceServers: [] }`. Each URL becomes `{ urls, username, credential }`.
2. In `js/p2p.js`, delete the three hardcoded `turn:a.relay.metered.ca` entries from `_rtcConfig.iceServers`, keeping the two STUN entries. Add an async `_fetchTurnServers()` method that fetches `this.serverUrl.replace(/^ws/, 'http') + '/api/turn'` with a short timeout, and on success appends the returned entries to `this._rtcConfig.iceServers`; on any failure, log and continue STUN-only. Call it (fire-and-forget, awaited before first `RTCPeerConnection` creation where practical) when the signaling socket connects.
3. Operational steps to record in the PR description: rotate the exposed metered.ca credential in the provider dashboard (it is burned in git history) and set the new values via `fly secrets set TURN_URLS=... TURN_USERNAME=... TURN_CREDENTIAL=...`.
`js/p2p.js` is bundled into the iOS app via `npm run sync:ios` (Capacitor copies `js/` into `www/`), so no Swift change is needed, but a new native build must be cut for the change to reach installed apps. This is a networking-layer change only — no sim-state, checksum, or serializer impact.

**Verify:** `npm test`. Manual: run `TURN_URLS='turn:example.com:443' TURN_USERNAME=u TURN_CREDENTIAL=c node server/server.js` and assert `curl -s localhost:8080/api/turn` returns the entry, and that with the vars unset it returns `{"iceServers":[]}`. Grep check: `grep -rn "metered.ca\|kMpLJTKsS2" js/ index.html` returns nothing. Load the game locally against the local server and confirm a P2P room still connects host↔guest (STUN-only path).

**Interacts with:** P2-19 (the CSP `connect-src` must allow the https origin of the signaling server for this fetch).

---

### P2-15 [low] Make the state-send rate honest: set STATE_SEND_RATE to a divisor of TICK_RATE
- [ ] `shared/constants.js`, `server/game-simulation.js` — locate: `STATE_SEND_RATE: 40`

`_ticksPerState = Math.max(1, Math.round(60 / 40)) = 2`, so snapshots actually go out every 2nd tick — 30 Hz, not the 40 Hz the constant documents. Nothing else reads `STATE_SEND_RATE` (the client interpolator hardcodes its own 33 ms delay), so nothing is functionally broken today, but the documented cadence is wrong and any future re-tuning to a non-divisor of 60 will silently misround the same way.

**Change:**
1. In `shared/constants.js`, change to `STATE_SEND_RATE: 30,` and update the comment to: `// Hz — server sends state snapshots at this rate. MUST divide TICK_RATE evenly; the server sends every (TICK_RATE / STATE_SEND_RATE)-th tick.`
2. In `server/game-simulation.js`, keep the `_ticksPerState` computation but guard the constraint: `this._ticksPerState = Math.max(1, Math.round(this.tickRate / GameConstants.STATE_SEND_RATE)); if (this.tickRate % GameConstants.STATE_SEND_RATE !== 0) console.warn('STATE_SEND_RATE does not divide TICK_RATE; actual send rate is', this.tickRate / this._ticksPerState, 'Hz');`.
Determinism guardrail: `shared/constants.js` is shared by host and guest, but `STATE_SEND_RATE` is not read by the lockstep sim, `js/game.js` `_computeChecksum`, or `_serializeFullState` — no sim-state field changes, so no checksum/serializer update. The Swift port's `Constants.swift` does not define this constant, so no iOS parity change; the updated `shared/constants.js` still flows into native builds via `npm run sync:ios`.

**Verify:** `npm test`. Add an assertion to `test/server-simulation.test.js`: `assert.equal(GameConstants.TICK_RATE % GameConstants.STATE_SEND_RATE, 0)` and assert a fresh `GameSimulation`'s `_ticksPerState === 2` (i.e. the actual cadence equals `TICK_RATE / STATE_SEND_RATE`).

**Interacts with:** none.

---

### P2-16 [low] Include playerId in the plain-JOIN_ROOM ROOM_JOINED payload
- [ ] `server/room-manager.js` — locate: `this._sendTo(ws, MSG.ROOM_JOINED, {\n            roomCode,\n            slots: room.getSlotInfo(),` (the `_joinRoom` occurrence)

`_createRoom`, `_quickMatch`, and `_joinP2PRoom` all include the server-assigned `playerId` in their ROOM_JOINED payload, but the plain `_joinRoom` path omits it. Since playerIds are minted server-side per connection and names are not unique, a client joining via JOIN_ROOM has no reliable way to identify which slots entry is itself, and client logic reading `d.playerId` silently gets `undefined` on this one path.

**Change:** In `server/room-manager.js` `_joinRoom`, add `playerId,` to the ROOM_JOINED payload object (matching the `_createRoom`, `_quickMatch`, and `_joinP2PRoom` payloads). Server-only protocol addition; no sim, checksum, or iOS impact.

**Verify:** `npm test`. Add an assertion to an existing join test in `test/room-manager.test.js` (or a new one): after a `JOIN_ROOM`, find the joiner's ROOM_JOINED message in the fake ws `sent` array and assert `msg.d.playerId` equals the joining player's id.

**Interacts with:** none.

---

### P2-17 [low] Generate room codes with a CSPRNG and throttle failed join attempts
- [ ] `server/room-manager.js` — locate: `const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';`

Room codes are 4 chars over a 32-char alphabet (~1.05M space) generated with `Math.random`, and there is no limit on failed JOIN/JOIN_P2P_ROOM attempts — each wrong guess gets a cheap 'Room not found' ERROR, so the whole code space is enumerable from one connection. P2P rooms are private (never listed in the lobby), so the code is their only access control; enumeration lets griefers occupy slots in private waiting lobbies. `Math.random` is also predictable, aiding guessing.

**Change:**
1. In `server/room-manager.js`, add `const crypto = require('crypto');` at the top and replace `chars[Math.floor(Math.random() * chars.length)]` with `chars[crypto.randomInt(chars.length)]` in both `_generateCode` and `_generateP2PCode`. Keep the length at 4 — the client join input has `maxlength="4"` and the display assumes 4 chars, so lengthening would require coordinated client changes; the throttle below is what makes enumeration impractical.
2. Add a failed-join throttle: in `_joinRoom` and `_joinP2PRoom`, whenever a 'Room not found' ERROR is sent, increment `ws._failedJoins = (ws._failedJoins || 0) + 1;` and if it exceeds 20, call `ws.close(1008, 'Too many failed join attempts')` after sending the error. Combined with the per-IP connection cap from P2-7 (20 conns/IP), an attacker gets at most ~400 guesses per IP against a 1M code space.
Server-only change; no sim, checksum, or iOS impact.

**Verify:** `npm test`. Add a regression test in `test/room-manager.test.js`: send 21 `JOIN_ROOM` messages with bogus codes from one fake ws (give the stub a `close(code)` method that records the code) and assert `close` was called with 1008 on the 21st; also assert generated codes still match `/^[A-HJ-NP-Z2-9]{4}$/` and are unique across `rooms` and `p2pRooms`.

**Interacts with:** P2-7 (per-IP connection cap completes the enumeration defense; land P2-7 first).

---

### P2-18 [low] Add an Origin allowlist to the WebSocket upgrade and tighten HTTP CORS
- [ ] `server/server.js` — locate: `const wss = new WebSocketServer({`

The WebSocketServer performs no Origin check and the HTTP layer sets `Access-Control-Allow-Origin: *`, so any web page on any origin can open a socket to the production server and drive the full signaling/relay protocol, amplifying resource-exhaustion abuse from visitors' browsers. There are no cookies/sessions so classic CSWSH data theft does not apply, but browser-origin abuse should still be shut off.

**Change:** In `server/server.js`:
1. Add `const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);` at the top. If the list is empty, log a startup warning that origin checking is disabled.
2. Pass a `verifyClient` option to the `WebSocketServer` constructor: `verifyClient: ({ origin }) => !origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)`. Absent Origin must be allowed — the Capacitor iOS app and non-browser clients send none (and non-browser attackers can spoof it anyway; this guard targets browser-based amplification).
3. In the HTTP handler, replace the wildcard CORS: when `ALLOWED_ORIGINS` is non-empty, set `Access-Control-Allow-Origin` to `req.headers.origin` only if it is in the list (omit the header otherwise); keep `*` only when the allowlist is unconfigured.
4. Note in the PR: set `fly secrets set ALLOWED_ORIGINS=https://<production-site-origin>,capacitor://localhost` at deploy time.
Server-only change; no sim, checksum, or iOS impact (the native app sends no Origin and stays allowed).

**Verify:** `npm test`. Manual: run `ALLOWED_ORIGINS=https://good.example node server/server.js`; a ws client sending `Origin: https://evil.example` must be rejected at upgrade (connection error), one sending `Origin: https://good.example` or no Origin must connect; `curl -s -H 'Origin: https://evil.example' -D- localhost:8080/api/lobby` must not echo the evil origin in `Access-Control-Allow-Origin`.

**Interacts with:** P2-7 (same connection-acceptance layer).

---

### P2-19 [low] Add a Content-Security-Policy and referrer policy to the client page
- [ ] `index.html` — locate: `<meta name="theme-color" content="#0a0e27">`

The document ships with no CSP or referrer policy. XSS risk is currently low (user-controlled names render via `textContent`), but a CSP is the standard defense-in-depth that would contain any future injection and restrict where scripts and connections may originate. All 24 scripts are external files, there are no inline scripts or inline event handlers, and no external fonts/images — only inline `style=""` attributes — so a strict script policy is safe to adopt.

**Change:** In `index.html` `<head>`, immediately after the viewport meta, add:
```html
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws://localhost:8080 http://localhost:8080 wss://kickzone-server.fly.dev https://kickzone-server.fly.dev; worker-src 'self'; object-src 'none'; base-uri 'self'">
<meta name="referrer" content="strict-origin-when-cross-origin">
```
The `https://kickzone-server.fly.dev` and `http://localhost:8080` entries cover the `/api/turn` fetch added by P2-14 and the `/api/lobby` fetch; `wss:`/`ws:` cover the signaling socket. Note: `frame-ancestors` is ignored in meta-delivered CSP, so framing protection is not achievable from this static page and is intentionally omitted. This file is bundled into iOS via `npm run sync:ios`; Capacitor serves from `capacitor://localhost` where `'self'` still resolves correctly, but the remote `connect-src` entries above already cover the native app's server calls — no Swift change.

**Verify:** Serve the game locally (e.g. `npx serve .` or the project's usual static server), open it in a browser with DevTools console, play a practice match, open the AI Lab screen, and create/join an online room against the local server — assert zero CSP violation reports in the console and that the service worker still registers. `npm test` must still pass (unaffected).

**Interacts with:** P2-14 (connect-src must include the signaling server's https origin).

---

### P2-20 [low] Run the server container as a non-root user
- [ ] `Dockerfile` — locate: `CMD ["node", "server.js"]`

The image never drops privileges, so the Node process runs as uid 0 inside the container. Any RCE or path traversal in the process or a compromised dependency executes as container root, widening the blast radius. Standard container hardening: the `node:20-alpine` base image ships a built-in unprivileged `node` user.

**Change:** In `Dockerfile`, add a `USER node` line after `WORKDIR /app/server` and before `EXPOSE 8080`. No `chown` is needed: the server only reads its files, and root-copied files are world-readable by default; the process binds port 8080 (unprivileged). No code, sim, checksum, or iOS impact.

**Verify:** `docker build -t kickball-server . && docker run --rm kickball-server node -e "console.log(process.getuid())"` prints a non-zero uid (1000), and `docker run --rm -p 8080:8080 kickball-server` starts cleanly with `curl -s localhost:8080/health` returning `ok`. If Docker is unavailable locally, verification happens on the next `fly deploy` by checking the health endpoint.

**Interacts with:** none.

---

## Package P3 — Connection lifecycle (rejoin, ICE recovery, stalls)
**Goal.** A transient network blip, a backgrounded tab, or a signaling drop must degrade gracefully (grace periods, ICE restart, rejoin, re-admission) instead of destroying a healthy match.
**When.** Land after P1. Design the protocol changes as ONE coherent change — these items all touch the same lifecycle code and must be consistent.
**Agent capability.** NEEDS A CAPABLE AGENT OR HUMAN REVIEW — protocol design spanning client and server. The Design subsection below is the package's single source of truth; every item is written against it.
**Package verification.** Run `npm test` (all suites, including the new `test/p2p-client.test.js` and the extended `test/p2p-protocol.test.js` added by these items). Then do a manual two-browser session against a local server (`node server/server.js`, open `index.html` twice on localhost): play a lockstep match while (a) disabling the guest's network for ~5 s, (b) hiding the host tab for 30 s, (c) pausing the guest's JS in DevTools for 16 s and resuming. The match must survive all three: no "Host disconnected" teardown, guests keep control after returning, and the console shows no uncaught errors.

### Design

All P3 items implement one protocol design. **Session-token rejoin:** the client mints a random session token when it creates/joins a room and sends it inside `create_p2p_room`/`join_p2p_room`; the server maps token → canonical playerId and, when a member's WebSocket closes, holds their seat for a 30 s grace period (`rejoinGraceMs`) instead of emitting `p2p_peer_left`; a reconnecting socket sends `rejoin_room {token}` and is re-bound to the same playerId, seat, and room. **Advisory peer_left:** while a lockstep match is running (a new `P2PNetwork.matchActive` flag, set by ui.js at match start and cleared at teardown), a `p2p_peer_left` whose data channel is still open is ignored; the authoritative "peer is gone" signal mid-match is the data-channel `close` event on the host. **ICE-restart-with-grace:** `connectionState === 'disconnected'`/`'failed'` never tears the match down; it starts a 10 s grace timer plus `pc.restartIce()` renegotiated over the (rejoin-hardened) signaling channel, with the host always the offerer; on grace expiry the dead RTCPeerConnection is closed, lockstep traffic continues over the existing WS relay fallback, and the host issues a fresh offer to rebuild the channel. **Hidden-tab ticking:** the lockstep pump is extracted from the rAF loop and additionally driven by a Web Worker timer while `document.hidden`, so a backgrounded host keeps confirming ticks and a backgrounded guest keeps sending inputs. **Stall ladder:** at 2 s of missing inputs every peer shows a "waiting" notice; at 15 s the host *suspends* (not kicks) the silent peer — ticks confirm without them, the peer is notified, and their seat is re-admitted the moment their inputs resume, with the host substituting empty inputs for the suspension-window ticks inside the confirmed-input broadcasts so every simulation stays bit-identical; a guest that stalls for 3 consecutive 15 s windows (~45 s) ends the match cleanly and returns to the menu. Determinism guardrail for the whole package: host and guest simulations must stay bit-identical — every behavioral change must apply identically on all peers via the confirmed-input/checksum stream, and no item here adds/removes a sim-state field, so `js/game.js` `_computeChecksum` and `_serializeFullState` stay untouched (any deviation from that requires updating both). The Swift port (`ios/App/App/KickZone/`) contains no P2P/lockstep networking, so no Swift parity changes are needed; the Capacitor iOS app picks up all JS changes via `npm run stage:web` / `sync:ios`.

### P3-1 [medium] Buffer early lockstep frames instead of dropping them
- [ ] `js/p2p.js`, `test/p2p-client.test.js` (new) — locate: `msg.t === 'li' && this.onLockstepInput`

The `'li'` data-channel handler drops frames whenever `this.onLockstepInput` is null, and that handler is only assigned inside `_startP2PHostMatch`, which runs when the host's own `match_starting` arrives over its WebSocket. The server sends `match_starting` to host and guests on separate TCP connections with no cross-connection ordering guarantee, so a guest that starts first sends inputs for ticks D..2D-1 over the already-open reliable channel and the host discards them at the application layer — the host then stalls 15 s at tick D and kicks the guest at kickoff. The same null-handler drop exists for guest-side `'ci'`/`'cs'` frames and for the WS relay paths.

**Change:**
1. In `js/p2p.js` constructor, add backing fields and buffers *before* the existing callback assignments: `this._onLockstepInput = null; this._onConfirmedInputs = null; this._onChecksum = null; this._earlyLI = []; this._earlyCI = []; this._earlyCS = [];`.
2. Add class accessors so assignment flushes the buffer: `set onLockstepInput(fn) { this._onLockstepInput = fn; if (fn) { const q = this._earlyLI; this._earlyLI = []; for (const f of q) fn(f.peerId, f.d); } }` with a matching getter; same pattern for `onConfirmedInputs` and `onChecksum` (their queue entries are just `d`). The existing `this.onLockstepInput = null` constructor lines now hit the setters harmlessly.
3. Add dispatch helpers: `_dispatchLI(peerId, d)` calls the handler when set, else pushes `{peerId, d}` onto `_earlyLI` capped at 256 (shift oldest); `_dispatchCI(d)` same with `_earlyCI` cap 256; `_dispatchCS(d)` same with `_earlyCS` cap 8.
4. Route all four intake sites through the helpers: the DC `'li'` branch in `_setupDataChannel` (drop the `&& this.onLockstepInput` guard), the WS `'p2p_peer_input'` lockstep branch (`relayedInput.tk !== undefined` → `this._dispatchLI(msg.d.peerId, relayedInput)`), and the `'ci'`/`'cs'` branches in both `_setupHostChannel` and `_handleSignalingMessage` (keep the existing `!this.isHost && msg.d.tk !== undefined` guards).
5. Clear all three buffers in `disconnect()` and `_closeAllPeers()`.
6. Make `js/p2p.js` loadable in Node for tests: append `if (typeof module !== 'undefined' && module.exports) { module.exports = P2PNetwork; }` at the bottom (browser-safe; later items' tests reuse this).
7. Create `test/p2p-client.test.js` using `node:test` + `assert/strict`: set `global.window = {}` and `global.location = { hostname: 'test' }` before `require('../js/p2p.js')`, construct `new P2PNetwork('ws://test')`, call `_dispatchLI('peerA', {tk: 3})` and `_dispatchLI('peerA', {tk: 4})` with no handler set, then assign `onLockstepInput` to a collector and assert both frames arrive in FIFO tick sequence 3, 4; add the analogous test for `_dispatchCI`.

**Verify:** `npm test` passes, with the new `test/p2p-client.test.js` asserting that lockstep frames received before the handler is assigned are delivered, in arrival sequence, the moment the handler is assigned, and that nothing is delivered twice.

**Interacts with:** P3-5 (re-admission consumes `_dispatchLI`), P0-3 (client lockstep test coverage).

### P3-2 [high] Add session-token rejoin with server-side seat grace
- [ ] `server/protocol.js`, `server/server.js`, `server/room-manager.js`, `js/p2p.js`, `js/ui.js`, `test/p2p-protocol.test.js` — locate: `case 'p2p_peer_left':`

The signaling WebSocket is a hard mid-match dependency: the server assigns a fresh uuid per connection and `handleDisconnect` immediately runs `_leaveP2PRoom`, so a transient WS drop on the host destroys the room and every guest tears down a healthy DC-connected match ("Host disconnected"); a guest's WS drop makes the host permanently close that guest's RTCPeerConnection. The client's auto-reconnect cannot recover because the new socket gets a new uuid unknown to the room, and the protocol has no rejoin message.

**Change:**
1. `server/protocol.js`: add `REJOIN_ROOM: 'rejoin_room'`, `ROOM_REJOINED: 'room_rejoined'`, `REJOIN_FAILED: 'rejoin_failed'` to `MSG`.
2. `server/server.js`: route by socket identity so a rejoin can re-bind it — in the `message` handler call `roomManager.handleMessage(ws.playerId, ws, msg)` and in `close` call `roomManager.handleDisconnect(ws.playerId, ws)` (instead of the closure `playerId`).
3. `server/room-manager.js` constructor: accept `opts = {}`, set `this.rejoinGraceMs = Number.isFinite(opts.rejoinGraceMs) ? opts.rejoinGraceMs : 30000;` and `this.p2pSessions = new Map(); // token -> canonical playerId`.
4. `_createP2PRoom` / `_joinP2PRoom`: read `const token = typeof data?.token === 'string' && data.token.length <= 64 ? data.token : null;`; store `hostToken`, `hostDisconnectedAt: null`, `hostGraceTimer: null` on the room and `token`, `disconnectedAt: null`, `graceTimer: null` on each peer record; when token is present, `this.p2pSessions.set(token, playerId)`.
5. `handleDisconnect(playerId, ws)`: first line `if (ws && this.playerWs.get(playerId) !== ws) return;` (ignore stale closes of a socket that was already replaced by a rejoin). For a `p2p:` ref whose member has a token: do NOT call `_leaveP2PRoom`; set `disconnectedAt = Date.now()` (host field on the room, peer field on the record), schedule `graceTimer = setTimeout(() => { const cur = this.playerWs.get(playerId); if (!cur || cur.readyState !== 1) this._leaveP2PRoom(playerId); }, this.rejoinGraceMs)` (call `.unref?.()` on it), and `this.playerWs.delete(playerId)` while keeping `playerRooms`. Members without a token keep today's immediate `_leaveP2PRoom`.
6. Add `case MSG.REJOIN_ROOM: this._rejoinRoom(playerId, ws, msg.d); break;` and implement `_rejoinRoom(connId, ws, data)`: look up `canonicalId = this.p2pSessions.get(data?.token)`; on any lookup/membership failure reply `MSG.REJOIN_FAILED`. On success: `ws.playerId = canonicalId; this.playerWs.set(canonicalId, ws); this.playerWs.delete(connId);`, refresh `room.hostWs`/`peer.ws`, clear `disconnectedAt` and `clearTimeout` the grace timer, and reply `MSG.ROOM_REJOINED` with `{ roomCode, playerId: canonicalId, isHost, hostId: room.hostId, slots: this._getP2PSlots(room), settings: room.settings, started: room.started }`.
7. `_leaveP2PRoom`: when destroying the room (host case) clear every peer's `graceTimer` and delete every member token from `p2pSessions`; when a single peer leaves, clear that peer's timer and token.
8. `cleanupStaleRooms`: keep rooms whose host is within grace: `const hostAlive = (room.hostWs && room.hostWs.readyState === 1) || (room.hostDisconnectedAt && now - room.hostDisconnectedAt < this.rejoinGraceMs * 2);`.
9. `_startP2PMatch` zombie eviction: match start still requires a live socket — when evicting a peer whose `ws.readyState !== 1`, also `clearTimeout(peer.graceTimer)` and delete their token from `p2pSessions` so a late rejoin fails cleanly.
10. `js/p2p.js`: add `this.sessionToken = null; this.matchActive = false;` in the constructor. In `createRoom()` and `joinRoom()`, mint `this.sessionToken = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);` and include `token: this.sessionToken` in the payload. In `ws.onopen`, BEFORE `_flushSendQueue()`: `if (this.roomCode && this.sessionToken) this.ws.send(JSON.stringify({ t: 'rejoin_room', d: { token: this.sessionToken } }));` so queued relay frames land on a re-bound seat. In `leaveRoom()`, set `this.sessionToken = null` (a voluntary leave must not rejoin).
11. `js/p2p.js` `_handleSignalingMessage`: add `case 'room_rejoined':` (set `roomCode`/`playerId`/`isHost` from `msg.d`; if `!this.matchActive` and `this.onRoomUpdate`, call it with `msg.d` so a lobby re-renders; never navigate mid-match) and `case 'rejoin_failed':` (if `this.matchActive`, log and continue — the match lives on the DC; else set `this.roomCode = null` and call `this.onError('Room closed')`).
12. `js/p2p.js` `case 'p2p_peer_left':` — advisory mid-match: compute `dcOpen` (`msg.d.hostLeft` → `this.hostChannel?.readyState === 'open'`; else the peer's entry in `this.dataChannels` is `'open'`); when `this.matchActive && dcOpen`, `break` without closing anything. Otherwise keep today's behavior. To keep prompt guest-quit detection, in `_setupDataChannel` `dc.onclose` add `if (this.matchActive && this.onPeerDisconnected) this.onPeerDisconnected({ peerId });` — the DC close is now the host's authoritative peer-gone signal.
13. `js/ui.js`: set `this.p2p.matchActive = true` in `_startP2PHostMatch` and `_startP2PClientMatch` (right after the `isRunning` guards) and `this.p2p.matchActive = false` in `_teardownMatch()`.
14. Extend `test/p2p-protocol.test.js` (construct with `new RoomManager({ rejoinGraceMs: 15 })` where timing matters; give `fakeWs()` objects a `playerId` property): (a) guest WS drop then `rejoin_room` with the token within grace → host never receives `p2p_peer_left`, new socket gets `room_rejoined` with the ORIGINAL playerId, and a subsequent `p2p_relay_ci` from the host reaches the new guest socket as `'ci'`; (b) grace expiry without rejoin (await ~50 ms) → host receives `p2p_peer_left`; (c) host drop + host rejoin within grace → guests never receive `hostLeft`; (d) after a rejoin, `handleDisconnect(canonicalId, oldWs)` with the stale socket is a no-op.

**Verify:** `npm test` green including the four new contract tests above. Manual: mid-match, kill the host's network for ~5 s and restore it — the guest match keeps running, the server log shows the rejoin, and no client shows "Host disconnected".

**Interacts with:** P3-3 (ICE restart renegotiates over the rejoined signaling channel), P3-4 (guest stall deadline is the backstop when rejoin fails), P3-5 (peer_left semantics), P2 package (other changes to server/room-manager.js — merge carefully).

### P3-3 [high] Replace fatal WebRTC teardown with ICE-restart grace
- [ ] `js/p2p.js` — locate: `pc.onconnectionstatechange`

Both `connectionstatechange` handlers treat `'disconnected'` the same as `'failed'`: the guest immediately fires `onError('Host disconnected')` + `_closeAllPeers()` (full match teardown via ui.js), and the host permanently `_closePeer()`s the guest. WebRTC `'disconnected'` is frequently a transient 1–2 s blip that self-recovers, `pc.restartIce()` is never attempted, and the complete WS relay fallback that already exists for `'li'`/`'ci'`/`'cs'` is defeated by the eager teardown.

**Change:**
1. Add `this._peerGraceTimers = new Map();` to the constructor, plus `_startIceGrace(peerId, pc)` (no-op if a timer exists; `setTimeout` 10000 ms that deletes itself, returns if `pc.connectionState === 'connected'`, else `this._closePeer(peerId)` and, when `this.isHost`, `this._createOfferForPeer(peerId)` to rebuild the channel through signaling) and `_clearIceGrace(peerId)`.
2. Host handler in `_createOfferForPeer`: on `'connected'` call `_clearIceGrace(peerId)`; on `'disconnected'`/`'failed'` call `try { pc.restartIce(); } catch (e) {}` then `_startIceGrace(peerId, pc)`. Remove the unconditional `_closePeer(peerId)`.
3. Renegotiation support: move the host's offer creation into `pc.onnegotiationneeded` guarded by a `pc._makingOffer` flag (`createOffer` → `setLocalDescription` → send `signal_offer` with `pc.localDescription.sdp`, reset the flag in `finally`), and delete the manual one-shot offer block at the end of `_createOfferForPeer` — `onnegotiationneeded` fires once when the data channel is created and again after `restartIce()`. The host is always the offerer, so there is no glare.
4. Guest `_handleOffer`: reuse the existing connection for re-offers — `let pc = this.peerConnections.get(hostId); if (!pc) { create + register + attach ondatachannel/onicecandidate/onconnectionstatechange }` then always `setRemoteDescription`/`createAnswer`/`setLocalDescription`/send `signal_answer`. (Today a re-offer would clobber the live pc with a fresh one.)
5. Guest handler in `_handleOffer`: delete `onError('Host disconnected')` and `_closeAllPeers()`; on `'connected'` clear grace, on `'disconnected'`/`'failed'` call `_startIceGrace(hostId, pc)` (guests do not call `restartIce` — the host offers; after guest-side expiry `_closePeer(hostId)` frees the dead pc and the host's fresh offer rebuilds it, while `sendLockstepInput`'s existing relay fallback carries inputs meanwhile).
6. `_closePeer`: also `_clearIceGrace(peerId)` and delete any timer entry; `disconnect()` clears all timers via `_closeAllPeers`.

**Verify:** `npm test` (no regressions; this file has unit coverage from P3-1's harness — add one test asserting `_startIceGrace` + `_clearIceGrace` set/clear entries in `_peerGraceTimers` using a stub `pc` object). Manual: mid-match, toggle the guest machine's Wi-Fi off for 3–5 s — the match freezes briefly and resumes; previously it ended with "Host disconnected". Grep the file to confirm no `connectionstatechange` path calls `onError` anymore.

**Interacts with:** P3-2 (signaling must survive its own drops for the re-offer to arrive), P3-6 (RTT pings ride the same DC and resume after recovery).

### P3-4 [high] Keep lockstep ticking in hidden tabs and surface stalls early
- [ ] `js/game.js`, `js/ui.js` — locate: `if (waited > 15000 && this._onLockstepStall)`

The lockstep loop is driven exclusively by `requestAnimationFrame`, which browsers suspend for hidden tabs. A hidden HOST stops confirming ticks while its sockets stay alive, so guests freeze forever behind a 15 s toast loop with no deadline; a hidden GUEST stops producing inputs, silently freezing the opponent for 2–15 s (only a console.warn at 2 s) and then getting kicked. There is no `visibilitychange` handling and no guest-side recovery deadline anywhere in game.js/ui.js/p2p.js.

**Change:**
1. `js/game.js`: extract the `isLockstep` block of `loop()` (the `TICK_MS`/accumulator/`steps < 5` while-loop, verbatim, caps included) into a new method `_pumpLockstep(elapsed)`; `loop()` calls it.
2. Add `_startBackgroundPump()`: no-op if already started; build an inline Web Worker from a Blob URL whose source is `setInterval(() => postMessage(0), 50);` (revoke the URL after construction); `worker.onmessage` runs `if (!this.isRunning || !this.isLockstep || !document.hidden || this.isPaused) return;` then computes `now = performance.now(); const elapsed = Math.min(now - this.lastTime, 100); this.lastTime = now; this._pumpLockstep(elapsed);`. Wrap worker construction in try/catch; on failure fall back to `this._bgPumpInterval = setInterval(sameHandler, 250)`. Add `_stopBackgroundPump()` that terminates the worker / clears the interval. Call `_startBackgroundPump()` at the end of `startMatch()` when `this.isLockstep`, and `_stopBackgroundPump()` inside `quit()`. When the tab is visible the handler no-ops and rAF drives ticking; when hidden, rAF is suspended so only the worker pumps — no double-stepping is possible, and both paths share `lastTime`/`_accumulator`.
3. Early stall notice: in `_lockstepCanAdvance`, inside the existing `!this._lockstepStallWarned && waited > 2000` branch, add `this._lockstepWaitingShown = true; if (this._onLockstepWaiting) this._onLockstepWaiting(true);`. In `_lockstepTick`, next to the `_lockstepWaitStart`/`_lockstepStallWarned` resets, add `if (this._lockstepWaitingShown) { this._lockstepWaitingShown = false; if (this._onLockstepWaiting) this._onLockstepWaiting(false); }`. Initialize both fields in the constructor and reset them in `startMatch()`.
4. `js/ui.js`: add a `_hideToast()` method (set the toast opacity to 0 and clear `_toastTimer`). In BOTH `_startP2PHostMatch` and `_startP2PClientMatch` wire `this.game._onLockstepWaiting = (waiting) => { if (waiting) { this._showToast('Connection interrupted — waiting for players…', 15000); } else { this._hideToast(); this._guestStallCount = 0; } };`.
5. Guest deadline: in `_startP2PClientMatch` set `this._guestStallCount = 0;` and replace the toast-only `_onLockstepStall` handler with one that increments `this._guestStallCount`; at `>= 3` (≈45 s frozen) it shows 'Connection to host lost — match ended', calls `this._teardownMatch()`, and `this.showScreen('menu')`; below 3 it keeps today's 'Connection stalled — waiting for host…' toast.
6. `_teardownMatch()`: add `this.game._onLockstepWaiting = null;` (the pump is stopped by `quit()`, which `_teardownMatch` already calls).

**Determinism guardrail:** this changes only WHEN ticks execute, never WHAT they compute — `_pumpLockstep` must be a verbatim extraction and the worker handler must reuse it unmodified, so host and guest stay bit-identical; no sim-state field is added, so `_computeChecksum` and `_serializeFullState` stay untouched. The Swift port (`ios/App/App/KickZone/`) has no lockstep loop, so no parity change is needed there.

**Verify:** `npm test` green. Manual, two browsers: (a) hide the HOST tab for 30 s — the guest's match keeps advancing (at most a brief hitch at the transition); before the fix it froze behind repeating toasts. (b) Hide the GUEST tab 10 s — the host keeps playing and the guest's player idles without a kick. (c) Freeze one side with the DevTools debugger for 3 s — the other side shows the 'waiting' toast within ~2 s and it clears on resume. (d) Kill the host tab entirely — the guest returns to the menu after ~45 s with the 'Connection to host lost' toast.

**Interacts with:** P3-5 (the 15 s stall path this item counts is converted to suspension there), P3-2 (rejoin usually recovers before the 45 s deadline fires).

### P3-5 [high] Convert the 15 s stall kick into suspension with re-admission
- [ ] `js/ui.js`, `js/p2p.js` — locate: `this.game._onLockstepStall = (tick) => {`

When a peer misses inputs for >15 s the host synthesizes `onPeerDisconnected({peerId})`, removing them from `_peerIds` so ticks confirm without them — but nothing is sent to the kicked peer and their connections stay open: they keep receiving `'ci'`/`'cs'`, keep simulating in sync, and keep sending inputs that the host silently drops (`if (!this._peerIds.has(peerId)) return`). A mobile guest who backgrounds the app >15 s comes back to a match where their joystick is permanently dead, with zero feedback.

**Change:**
1. `js/ui.js` `_startP2PHostMatch`: initialize `this._suspendedPeers = new Set(); this._peerResumeTick = new Map(); this._lastConfirmedTick = -1;` next to `_pendingPeerInputs`.
2. Extract the body of the current `onPeerDisconnected` handler (delete from `_peerIds`, re-run `_tryConfirmTick` over `_pendingPeerInputs` and `_hostInputTicks`) into `this._removePeerFromLockstep(peerId)`. Rewire `this.p2p.onPeerDisconnected` (permanent departure: server `p2p_peer_left`, DC close from P3-2) to call it and additionally delete the peer from `_peerPlayerMap`, `_suspendedPeers`, and `_peerResumeTick`, showing the 'A player disconnected' toast only when the peer was actually present.
3. Add `this._suspendPeer(peerId)`: if not in `_peerIds` return; add to `_suspendedPeers`, call `_removePeerFromLockstep(peerId)` (keeping the `_peerPlayerMap` entry), send `this.p2p.sendToPeer(peerId, { t: 'susp', d: { s: 1 } })`, toast 'A player lost connection — holding their seat'. Change the host `_onLockstepStall` handler to call `this._suspendPeer(peerId)` instead of `this.p2p.onPeerDisconnected({ peerId })`.
4. Re-admission in the `onLockstepInput` handler: when `!this._peerIds.has(peerId)`, return unless `this._suspendedPeers.has(peerId)`; then require `Number.isInteger(inputData.tk) && inputData.tk > this._lastConfirmedTick`, and re-admit: delete from `_suspendedPeers`, add to `_peerIds`, `this._peerResumeTick.set(peerId, inputData.tk)`, send `{ t: 'susp', d: { s: 0 } }` via `sendToPeer`, toast 'A player reconnected'. Then fall through to the existing storage + `_tryConfirmTick(tick)`.
5. `_tryConfirmTick`: replace the completeness check with one that tolerates the resume window — for each `peerId` in `_peerIds` without an input for `tick`: `const rt = this._peerResumeTick.get(peerId); if (rt === undefined || tick >= rt) return;` (remove the unconditional `if (!peerInputs) return;` early-out). When building `confirmedMap`, peers inside their resume window (`tick < rt`) get the empty input `{ x: 0, y: 0, kick: false, chargeRatio: 0, pull: false, switchPlayer: false }`. After a successful confirm: `this._lastConfirmedTick = Math.max(this._lastConfirmedTick, tick);` and delete `_peerResumeTick` entries whose `rt <= tick + 1`.
6. `js/p2p.js`: add `sendToPeer(peerId, obj)` (host-side: look up the DC in `this.dataChannels`, `try { dc.send(JSON.stringify(obj)) } catch (e) {}` when open) and `this.onSuspended = null` in the constructor; in `_setupHostChannel`'s onmessage add `else if (msg.t === 'susp') { if (this.onSuspended) this.onSuspended(!!(msg.d && msg.d.s)); }`.
7. `js/ui.js` `_startP2PClientMatch`: wire `this.p2p.onSuspended = (s) => this._showToast(s ? 'Connection unstable — you were temporarily suspended' : 'You are back in the match');`. `_teardownMatch()`: set `this.p2p.onSuspended = null`.

**Determinism guardrail:** the substituted empty inputs exist only inside the host's confirmed-input sets, which are broadcast unchanged to every guest (including the returning peer) and applied identically by the host from its own `_lockstepInputBuffer` — so all simulations stay bit-identical. `isHuman` never changes during suspension, no sim-state field is added, and `js/game.js` `_computeChecksum` / `_serializeFullState` must NOT be touched. The Swift port has no lockstep code; no parity change.

**Verify:** `npm test` green. Manual, two browsers: pause the GUEST's JS in DevTools for ~16 s, then resume — the host shows the 'lost connection' toast at ~15 s and 'A player reconnected' within ~1 s of resume; the guest sees both `susp` toasts and their joystick works for the rest of the match (before the fix it stayed dead with no message). Then have the guest quit via the pause menu — the host sees 'A player disconnected' promptly and the match keeps running.

**Interacts with:** P3-4 (same stall pipeline; the worker pump makes suspensions rarer), P3-1 (buffered `li` dispatch), P3-2 (permanent-departure signal).

### P3-6 [medium] Measure RTT in the lobby and widen the input-delay clamp
- [ ] `js/p2p.js`, `test/p2p-client.test.js` — locate: `Math.max(2, Math.min(5, halfRTTTicks + 1))`

`startMatch()` sends `inputDelay = getAdaptiveInputDelay()`, but RTT measurement only starts inside the match-start handlers — after the delay was already chosen — so every first match uses the default 3 ticks regardless of real latency, and since every post-match path leaves the room, warm RTTs are never used; stale `_peerRTTs` from previous rooms can also leak into a new room's delay. Independently, the 2–5 tick clamp caps the one-way budget at ~83 ms, so RTTs above ~150 ms force the whole match into permanent sub-60 Hz stutter even though the server accepts delays up to 10.

**Change:**
1. In `_updateAdaptiveDelay`, change the clamp to `this._adaptiveInputDelay = Math.max(2, Math.min(10, halfRTTTicks + 1));`, matching the server's accepted 2–10 range (`server/room-manager.js` `_startP2PMatch` validation); update the constructor comment `(2-5 range)` to `(2-10 range)`.
2. Start measuring as soon as a channel opens: call `this.startRTTMeasurement()` inside `_setupDataChannel`'s `dc.onopen` (host side) and `_setupHostChannel`'s `dc.onopen` (guest side). `startRTTMeasurement` already clears any prior interval, so the existing ui.js calls at match start stay and are harmless.
3. Reset stale state per room: at the top of `createRoom()` and `joinRoom()`, run `this._peerRTTs.clear(); this._pingTimestamps.clear(); this._adaptiveInputDelay = 3;`. In `_closePeer(peerId)`, delete that peer from `_peerRTTs` and `_pingTimestamps`. In `leaveRoom()`, call `this.stopRTTMeasurement()`.
4. Add unit tests to `test/p2p-client.test.js`: (a) `_peerRTTs.set('a', 300); _updateAdaptiveDelay();` → `getAdaptiveInputDelay() === 10`; (b) `_peerRTTs.set('a', 40); _updateAdaptiveDelay();` → delay is 3; (c) after seeding `_peerRTTs` and setting `_adaptiveInputDelay = 7`, calling `joinRoom('ABCD', 'n')` leaves `_peerRTTs.size === 0` and delay 3.

**Determinism note:** the delay is chosen once by the host before the match and echoed by the server to every peer in the same `match_starting` message, so all peers still start from identical parameters; RTT pings never touch sim state.

**Verify:** `npm test` green, including the three new clamp/reset tests and the existing `match_starting sanitizes an out-of-range inputDelay` contract test. Manual: create a room, wait ~3 s in the lobby, start the match, and check in the host console that `ui.p2p._peerRTTs.size > 0` before start and that the sent `inputDelay` reflects the measured RTT.

**Interacts with:** P3-3 (RTT pings ride the DC that grace-recovery keeps alive).

### P3-7 [low] Replay rollbacks synchronously with muted effects
- [ ] `js/game.js` — locate: `_rollbackToChecksum(csData) {`

After a desync rollback, the rewound ticks are replayed through the normal real-time accumulator (~1 tick per frame, 5-step cap), so a rollback of N ticks takes ~N frames to reach the present; during that window the guest's input sends are suppressed, so the host starves and the whole room hitches for roughly the replay duration. Replayed ticks also re-fire kick sounds, screen shake, and goal notifications the player already saw.

**Change:**
1. In `_rollbackToChecksum`, after `this._replayUntil = presentTick;`, replay synchronously in the same call: `while (this.tickCount < presentTick && this.isRunning) { this._lockstepTick(); }` then `this._accumulator = 0;` and keep returning `true`. The input-send guard at `loop()` line ~504 (`tickCount >= this._replayUntil`) is untouched: after the synchronous replay `tickCount === _replayUntil`, so sends resume on the very next frame. (`_lockstepCanAdvance` is unnecessary here — the buffer was just seeded from `_ciHistory` for the whole window.)
2. Mute replay presentation: add `get _isReplaying() { return this.isLockstep && this.tickCount < this._replayUntil; }` to `Game`. In `_lockstepTick`, gate the kick effect block (`this.renderer.triggerShake`, `this.renderer.spawnHitFlash`, `Sound.kick`) plus the `Sound.pullActivate()` and `Sound.switchPlayer()` calls behind `if (!this._isReplaying)`, keeping every state mutation (stats.shots, momentum, swap) unconditional.
3. In `scoreGoal`, gate the presentation-only side effects — goal notification DOM/timer, confetti, screen shake, and every `Sound.*` call — behind `!this._isReplaying`, while leaving all state mutations (scores, scorer credit, combo, momentum, kickoff scheduling, `_endMatchAtTick`) exactly as they are. The score HUD `textContent` updates may stay (idempotent).

**Determinism guardrail:** the replay executes the identical `_lockstepTick` code on identical inputs — only pacing and renderer/Sound calls change, which no peer checksums. No sim-state field is added, so `_computeChecksum` and `_serializeFullState` must NOT be modified. The Swift port has no rollback/lockstep; no parity change.

**Verify:** `npm test` green. Manual: in a live guest console, run `game.ball.x += 5` mid-match to force the next checksum to mismatch; the console logs the rollback and the game visibly continues without the multi-frame freeze, with no duplicated kick/goal sounds during the correction, and the host side shows no stall warning.

**Interacts with:** P0-2/P0-3 (headless lockstep harness can later pin this with an automated test), P1 (its determinism fixes make rollbacks rare).

### P3-8 [low] Remap the host's own player explicitly and hide its Switch Team button
- [ ] `js/ui.js` — locate: `this.game._myPlayerIdx = playerIdx;`

In `_startP2PHostMatch`'s slot loop, the host's own slot hits `continue` without setting `player.isHuman`, removing that player's AI controller, and reassigning `game.humanPlayer` — it silently relies on `startMatch()` having made `players[0]` the human and on the server pinning the host to red slot 0. If host team-switching is ever enabled server-side, the host device would keep an AIController on its own player while guests remove it, diverging the `aiControllers` list and shared-RNG consumption from tick 0. The lobby also shows the host a Switch Team button that the server silently ignores.

**Change:**
1. In the host's slot branch of `_startP2PHostMatch` (before the `continue`), make the mapping explicit and correct for any `playerIdx`: when `playerIdx < this.game.players.length`, take `const player = this.game.players[playerIdx];`; if `this.game.humanPlayer && this.game.humanPlayer !== player`, revert the default assignment (`this.game.humanPlayer.isHuman = false;` and `this.game.aiControllers.push({ player: this.game.humanPlayer, ai: new AIController('normal') })` — `new AIController('normal')` mirrors the guest path in `_startP2PClientMatch` exactly; do NOT use `_makeAI()` here); then set `player.isHuman = true; this.game.humanPlayer = player;` and filter `player` out of `this.game.aiControllers`, exactly as the peer branch does. The existing `aiControllers.sort` after the loop normalizes iteration position.
2. In `_updateRoomSlots`, hide the button the server refuses: `const switchBtn = document.getElementById('btn-switch-team'); if (switchBtn) switchBtn.classList.toggle('hidden', !!isHost);` (guests keep it).

**Determinism note:** today the server always makes the host red slot 0, so runtime behavior is unchanged; this makes the client correct by construction. The remap must leave the `aiControllers` composition identical to what guests compute (guests already mark every occupied slot's player as human and strip its AI), which step 1's mirroring guarantees. No sim-state field changes; `_computeChecksum` / `_serializeFullState` untouched. No Swift parity needed.

**Verify:** `npm test` green. Manual: host a room — the Switch Team button is hidden for the host and visible for a guest; start a 2v2 lockstep match and confirm in the host console that `game.humanPlayer === game.players[game._myPlayerIdx]`, `game.humanPlayer.isHuman === true`, and `game.aiControllers.every(ac => ac.player !== game.humanPlayer)`; play a full minute with no desync/resync warnings in either console.

**Interacts with:** none.

### P3-9 [low] Validate binary state frame length before parsing
- [ ] `js/p2p.js`, `test/p2p-client.test.js` — locate: `const numPlayers = view.getUint8(o); o += 1;`

The client data-channel `onmessage` dispatches ArrayBuffer frames to `_handleBinaryState` before the try/catch that guards the JSON path, and `_handleBinaryState` trusts the leading player-count byte, reading `numPlayers*8 + 12` further bytes with no length check — a truncated frame (from the DC path at `_setupHostChannel` and from the base64 `'state'` WS relay path) throws an uncaught RangeError from the event handler. This legacy snapshot path is dormant during lockstep, so impact is a console error and a dropped frame, but it is the one unguarded parse in the message plumbing.

**Change:** At the top of `_handleBinaryState`, add explicit validation and drop malformed frames: `if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 1) return;` then, after reading `numPlayers`, `if (buffer.byteLength < 1 + numPlayers * 8 + 12) return;`. Leave both call sites unchanged.

**Verify:** `npm test` green, with a new test in `test/p2p-client.test.js`: calling `_handleBinaryState` with (a) an empty `ArrayBuffer` and (b) a 10-byte buffer whose first byte claims 4 players does not throw and leaves `stateBuffer.length === 0`; a correctly sized buffer (1 player: 1 + 8 + 12 = 21 bytes) parses and pushes exactly one entry.

**Interacts with:** none.

---

## Package P4 — Game loop and rendering polish (web)
**Goal.** Frame-rate-independent effects and timers, correct DPR handling, no per-frame waste, no stale input.
**When.** Any time after P1. Independent items.
**Agent capability.** basic agent
**Package verification.** Run `npm test` (all existing suites must stay green — none of these items touch shared/ sim math). Then a manual browser smoke pass: serve the repo root statically (`npx http-server .` and open `index.html`), play an offline match and confirm (a) goal confetti bursts from screen center at devtools DPR emulation 1, 2, and 3; (b) the combo popup lasts about 2 seconds; (c) pausing with Escape during a goal celebration freezes the celebration; (d) exactly one whistle at match end; (e) `grep -c "Date.now" js/renderer.js` prints 0.

### P4-1 [medium] Fix drawConfetti DPR mismatch and move screen-space overlays out of the world transform
- [ ] `js/renderer.js`, `js/game.js` — locate: `const dpr = Math.min(window.devicePixelRatio || 1, 2);`

`Renderer.resize()` establishes the canvas backing-store scale as `Math.min(devicePixelRatio, 3) * 1.5` (supersampling) and stores it in `this.dpr`, but `drawConfetti()` (js/renderer.js:1029-1046) escapes the current transform with `ctx.setTransform` using a locally recomputed `Math.min(devicePixelRatio, 2)` — the two never match (they differ by at least the 1.5x supersample factor), so confetti draws at the wrong scale/position. Worse, the trailing `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` runs even with zero particles and leaves that wrong transform active, wiping the screen-shake translate from `clear()` and the always-active fieldViewScale transform, which mispositions `drawComboPopup()` and `drawSuddenDeathHUD()` (both draw at `this.w/2`-style CSS-pixel screen coordinates) on every frame — they currently run before the `ctx.restore()` at js/game.js:2123.

**Change:**
1. In `js/renderer.js` `drawConfetti()`: delete the local `const dpr = Math.min(window.devicePixelRatio || 1, 2);`. At the top, add `if (this.confetti.length === 0) return;` and capture `const base = ctx.getTransform();`. Per particle, replace the manual matrix with `ctx.setTransform(base); ctx.translate(c.x, c.y); ctx.rotate(c.rotation); ctx.fillRect(-c.width / 2, -c.height / 2, c.width, c.height);`. After the loop, restore with `ctx.setTransform(base); ctx.globalAlpha = 1;`. This preserves whatever base transform (dpr scale + shake translate) is active and never leaks a wrong one.
2. In `js/game.js` `render()`: move the three screen-space calls — `this.renderer.drawConfetti();`, `this.renderer.drawComboPopup();`, and the `if (this.suddenDeath) { this.renderer.drawSuddenDeathHUD(); }` block (currently at lines 2090-2098) — to immediately after `if (fvs) ctx.restore();` (line 2123) and before the goal-flash overlay block, so they honestly draw in screen space. Leave `drawSuddenDeathOverlay` (field-space, line 2086) where it is.

This is render-only code; it must not touch any sim-state field, so `_computeChecksum`/`_serializeFullState` in js/game.js stay unchanged and host/guest lockstep simulations stay bit-identical. The Swift port (ios/App/App/KickZone/Rendering/GameScene.swift) uses SpriteKit nodes, not a canvas transform stack — no parity change needed.

**Verify:** `npm test` stays green. In the browser with devtools device emulation at DPR 1, 2, and 3: score a goal — confetti bursts centered on screen at correct size; trigger a combo popup — text appears horizontally centered at ~35% screen height; reach sudden death — the "SUDDEN DEATH" label is centered; screen shake remains visible while confetti is airborne.

**Interacts with:** P4-2 (edits the same drawConfetti/drawComboPopup/drawSuddenDeathHUD functions), P4-4 (edits render()).

### P4-2 [medium] Make all particle/FX timers time-based instead of per-rendered-frame
- [ ] `js/renderer.js`, `js/game.js` — locate: `p.timer += 16.67; // Approximate frame time`

Several visual systems integrate per rendered frame, not per elapsed time: `updateHitFlashes()` takes no dt at all, `updateConfetti(dt)` uses dt only for `goalFlashTimer` while particle gravity/decay are per-call, `drawDashTrails` does `t.life -= 0.04` per frame, `clear()` decays `screenShake *= 0.85` per frame, `drawComboPopup` hardcodes `p.timer += 16.67`, and `drawSuddenDeathHUD` does `suddenDeathFlash -= 16.67`. The rAF loop is uncapped, so on a 120 Hz display (ProMotion iPhones/iPads run this app in WKWebView) every effect plays at 2x speed — the combo popup lasts 1 s instead of 2 s — and at half speed on 30 fps devices. The loop already computes a clamped `elapsed` (js/game.js:484, capped at 100 ms), so the plumbing exists.

**Change:**
1. In `js/renderer.js` constructor: add `this.frameDt = 16.67;`.
2. In `js/game.js` `loop()`: change `this.renderer.updateHitFlashes();` (line 540) to `this.renderer.updateHitFlashes(elapsed);`, and immediately before `this.render();` (line 559) add `this.renderer.frameDt = elapsed;`.
3. In `updateHitFlashes(dt)`: compute `const f = dt / 16.67;` and scale every integration: `p.x += p.vx * f; p.y += p.vy * f; p.vx *= Math.pow(0.92, f); p.vy *= Math.pow(0.92, f); p.life -= p.decay * f;`.
4. In `updateConfetti(dt)`: compute `const f = dt / 16.67;` and scale the particle loop: `c.vy += c.gravity * f; c.vx *= Math.pow(0.99, f); c.x += c.vx * f; c.y += c.vy * f; c.rotation += c.rotationSpeed * f; c.life -= c.decay * f;` (the existing `goalFlashTimer -= dt` is already correct).
5. In `clear()`: replace `this.screenShake *= 0.85;` with `this.screenShake *= Math.pow(0.85, this.frameDt / 16.67);`.
6. In `drawDashTrails()`: replace `t.life -= 0.04;` with `t.life -= 0.04 * (this.frameDt / 16.67);`.
7. In `drawComboPopup()`: replace `p.timer += 16.67;` with `p.timer += this.frameDt;` and delete the "Approximate frame time" comment.
8. In `drawSuddenDeathHUD()`: replace `this.suddenDeathFlash -= 16.67;` with `this.suddenDeathFlash -= this.frameDt;`.

All of this is renderer-only cosmetic state — no sim-state field is added or removed, so `_computeChecksum`/`_serializeFullState` in js/game.js must not change, and lockstep determinism is unaffected (the fixed-timestep sim accumulator is untouched). The Swift port's effects (GameScene.swift) use SKAction durations in seconds and are already time-based — no parity change.

**Verify:** `npm test` stays green. In the browser: combo popup visibly lasts ~2 s and confetti fall/fade at the same speed whether devtools CPU throttling is off or 6x (frame rate halves but effect duration stays constant). On a 120 Hz display the popup still lasts ~2 s.

**Interacts with:** P4-1 (same functions), P4-3 (consumes `renderer.frameDt`), P4-9 (nearby renderer edits).

### P4-3 [low] Make camera follow smoothing frame-rate independent
- [ ] `js/game.js`, `ios/App/App/KickZone/Rendering/GameScene.swift` — locate: `const lerp = 0.1;`

`render()` advances the camera with a fixed per-frame lerp factor of 0.1 (js/game.js:2022-2024), so at 120 Hz the camera converges roughly twice as fast as at 60 Hz and feels floaty at 30 fps. The Swift port has the identical defect: GameScene.swift lines 176-181 lerp the camera by a fixed 0.08 per SpriteKit frame.

**Change:**
1. In `js/game.js` `render()`: replace `const lerp = 0.1;` with time-corrected exponential smoothing: `const lerp = 1 - Math.pow(0.9, (this.renderer.frameDt || 16.67) / 16.67);` (requires P4-2's `frameDt` plumbing to have landed).
2. In `ios/App/App/KickZone/Rendering/GameScene.swift`: in `update(_ currentTime:)`, track the previous frame timestamp (`lastCameraTime`), compute `let dt = lastCameraTime > 0 ? currentTime - lastCameraTime : 1.0/60.0; lastCameraTime = currentTime`, and replace the fixed `0.08` factor with `let k = 1 - pow(0.92, dt * 60)` in both camera axis lerps.

`_cameraX`/`_cameraY` are render-only (not in `_computeChecksum` or `_serializeFullState`), so this cannot affect lockstep determinism; do not add them to the checksum or serializer.

**Verify:** `npm test` stays green. In the browser at a camera-zoom map (any map sets cameraZoom 1.4-2.6): camera follow feel is identical with devtools CPU throttling off vs 6x (converges over the same wall-clock time). iOS build compiles (`npm run sync:ios` then build in Xcode) and camera follow feels unchanged at 60 Hz.

**Interacts with:** P4-2 (depends on `renderer.frameDt`), P4-4 (both edit render()).

### P4-4 [low] Add render interpolation between fixed simulation ticks
- [ ] `js/game.js`, `js/renderer.js` — locate: `while (this._accumulator >= TICK_MS) {`

The simulation runs at a fixed 16.67 ms timestep, but `render()` always draws entities at their last-tick positions and ignores the leftover accumulator fraction. On 120 Hz displays every other frame renders an identical state, and on 90 Hz panels the 2-1-2-1 tick cadence produces visible stutter on the fast-moving ball. This is the standard "fix your timestep" interpolation companion, and it is absent.

**Change:**
1. In `js/game.js`, add a helper `_snapshotRenderPrev()` that stores `_prevX = x; _prevY = y;` on `this.ball` and every entry of `this.players`. Call it immediately before `this._lockstepTick();` in the lockstep drain loop (line ~507) and immediately before `this.update(TICK_MS);` in the offline drain loop (line ~520).
2. In `render()`, before any drawing: compute `const alpha = this.isOnline ? 1 : Math.max(0, Math.min((this._accumulator || 0) / 16.67, 1));` (online mode already has its own snapshot interpolation). For the ball and each player set render-only fields: `e.renderX = (e._prevX === undefined || Math.abs(e.x - e._prevX) > 64 || Math.abs(e.y - e._prevY) > 64) ? e.x : e._prevX + (e.x - e._prevX) * alpha;` and the same for `renderY`. The 64-px threshold suppresses one-frame streaks on teleports (goal resets, lockstep full-state resyncs) without touching any reset path.
3. In `js/renderer.js` `drawBall(ball)` and `drawPlayer(player, ...)`: at the top declare `const bx = ball.renderX !== undefined ? ball.renderX : ball.x;` (and `by`, and `px`/`py` for player) and substitute those for every `ball.x`/`ball.y`/`player.x`/`player.y` read in the function body. In `js/game.js` `render()`, make the camera target read `target.renderX !== undefined ? target.renderX : target.x` (and y). Leave transient effect draws (pull links, indicators, trails) on raw positions — a sub-tick offset there is invisible.

Determinism guardrail: this must keep host and guest simulations bit-identical. `render()` must never write `x/y/vx/vy` — only the new `_prevX/_prevY/renderX/renderY` fields, which are render-only and MUST NOT be added to `_computeChecksum()` or `_serializeFullState()` in js/game.js (no checksum/serializer change). The snapshot call runs identically on all peers but only feeds rendering. The Swift port (GameEngine.swift line 159) steps its engine with variable dt rather than a fixed accumulator, so it has no interpolation gap — no parity change.

**Verify:** `npm test` stays green (in particular test/determinism.test.js). In the browser: ball motion is smooth during play; immediately after a goal reset there is no one-frame streak of ball or players across the field. On a 120 Hz display motion is visibly smoother than before.

**Interacts with:** P4-1, P4-3 (all edit render()); any P1 lockstep items that edit the drain loops.

### P4-5 [low] Guard the offline drain loop and endMatch against multi-tick re-entry
- [ ] `js/game.js` — locate: `while (this._accumulator >= TICK_MS) {`

The lockstep drain loop checks `&& this.isRunning` (js/game.js:500), but the offline loop (line 517) does not. If the frame in which the match clock expires has more than one queued tick (any frame > 33 ms — common on mobile jank, and up to 5 ticks after the 100 ms clamp), `update()` calls `endMatch()`, and the remaining queued ticks still execute; each re-enters the `timeRemaining <= 0` branch and calls `endMatch()` again, since `endMatch()` (line 1833) has no re-entry guard. The whistle plays twice and a second `Sound.win()/Sound.lose()` is scheduled.

**Change:**
1. In `js/game.js` line 517, change the offline drain condition to `while (this._accumulator >= TICK_MS && this.isRunning) {`, mirroring the lockstep loop.
2. Add `if (this.matchOver) return;` as the first line of `endMatch()`. This is safe across restarts because `startMatch` paths reset `this.matchOver = false` (lines 390 and 451).

Determinism guardrail: `endMatch()` is also reached from the lockstep tick path, so this must alter behavior identically for all peers — it does, because the guard only suppresses re-entry after `matchOver` is already set, and `matchOver`/`isRunning` are driven by the deterministic sim clock (`timeRemaining`, which is already in the checksum). No sim-state field is added or removed, so `_computeChecksum()` and `_serializeFullState()` stay unchanged. The Swift port already guards its tick with `guard isRunning, !isPaused, !matchOver else { return }` (GameEngine.swift line 150) — no parity change.

**Verify:** `npm test` stays green. In the browser, play an offline match to time expiry with unequal scores: exactly one whistle sounds, the result overlay appears once, and win/lose jingle plays once. Confirm `grep -n "&& this.isRunning" js/game.js` now matches both drain loops.

**Interacts with:** P4-6 (adjacent code in loop()).

### P4-6 [low] Stop the goal-celebration timer while the game is paused
- [ ] `js/game.js` — locate: `if (!this.isOnline && !this.isLockstep && this.isGoalScored) {`

The offline goal-timer block (js/game.js:529-536) sits outside the `if (!this.isPaused)` gate in `loop()`. Pressing Escape during the 2.5 s goal celebration keeps `goalTimer` counting against real elapsed time, so `resetAfterGoal()` fires behind the pause overlay — ball and players are respawned and the kickoff restriction armed while the match is supposedly frozen, and on resume the celebration has been skipped.

**Change:** In `js/game.js` `loop()`, move the entire goal-timer block (`if (!this.isOnline && !this.isLockstep && this.isGoalScored) { ... }`, lines 529-536) inside the `if (!this.isPaused) { ... }` block, placing it after the lockstep/online/offline branch chain but before the closing brace of the pause gate. Keep its accompanying comment with it.

This block is explicitly excluded from online and lockstep modes (lockstep drives goal resets from the tick clock inside `_lockstepTick`), and `pause()` refuses to pause those modes anyway, so peers are unaffected; no sim-state field changes, no checksum/serializer update needed. The Swift port gates its whole tick on `!isPaused` (GameEngine.swift line 150) — no parity change.

**Verify:** `npm test` stays green. In the browser: score a goal offline, press Escape during the celebration, wait 5+ seconds, resume — the celebration continues where it left off and `resetAfterGoal()` (kickoff barrier appearing) happens only after the remaining celebration time elapses post-resume.

**Interacts with:** P4-5 (adjacent code in loop()).

### P4-7 [low] Remove per-frame allocations and redundant DOM writes in hot paths
- [ ] `js/renderer.js`, `js/game.js` — locate: `const mapThemes = {`

Three hot-path regressions cause avoidable GC churn and DOM invalidation on low-end mobile: (1) `drawField` rebuilds the entire `mapThemes` literal — 6 nested objects, ~36 strings — every frame (js/renderer.js:100-107); (2) `drawBall` creates a radial gradient every frame while the ghost power-up is active (line 452), contradicting the file's "no per-frame gradients" header; (3) `game.render()` writes `pullBtn.textContent = 'PULL'` every frame even when unchanged (js/game.js:2110/2118), and `update()` rewrites the timer `textContent`/`style.color` every 16.67 ms tick (js/game.js:1113-1114, 1146).

**Change:**
1. In `js/renderer.js`: move the `mapThemes` object literal out of `drawField` to a module-level `const MAP_THEMES = { ... };` above `class Renderer`, and in `drawField` use `const theme = MAP_THEMES[mapType] || MAP_THEMES.classic;`.
2. In `js/renderer.js` constructor add `this._ghostGrad = null; this._ghostGradRadius = 0;`. In `drawBall`'s ghost-glow block: when `!this._ghostGrad || this._ghostGradRadius !== ball.radius`, create the radial gradient once centered at (0,0) — `ctx.createRadialGradient(0, 0, ball.radius * 0.5, 0, 0, ball.radius * 2.5)` with the same two color stops — and store it plus `this._ghostGradRadius = ball.radius`. Draw it via `ctx.save(); ctx.translate(ball.x, ball.y); ctx.fillStyle = this._ghostGrad; ctx.beginPath(); ctx.arc(0, 0, ball.radius * 2.5, 0, Math.PI * 2); ctx.fill(); ctx.restore();`.
3. In `js/game.js` `render()` pull-button block: cache the last written label in `this._pullBtnLastText` and assign `pullBtn.textContent` only when the new value differs (covers both the `'PULL'` writes and the countdown `secs + 's'` write).
4. In `js/game.js` `update()` timer blocks (sudden-death at 1110-1114 and normal at 1143-1146): build the string, and only when it differs from `this._lastTimerText` write `textContent` and update the cache. For the sudden-death color, set `this._dom.timer.style.color = '#ff4444'` only when `this._timerColorRed` is not already true (set the flag), and clear the flag where `endMatch()` resets `timer.style.color = ''` (line 1841).

All render/DOM-only; no sim-state fields are added, so `_computeChecksum()`/`_serializeFullState()` are untouched and lockstep determinism is unaffected. The Swift port renders with SpriteKit nodes and SwiftUI labels — no parity change.

**Verify:** `npm test` stays green. In the browser: all 6 maps render visually identical to before; grab the ghost power-up — the ball's glow looks unchanged while following the ball; the match timer still counts down once per second and turns red in sudden death, and resets to default color on the next match; pull button cooldown countdown still displays.

**Interacts with:** P4-9 (both edit drawField's top region in renderer.js).

### P4-8 [low] Fix the dead Numpad0 player-2 swap binding
- [ ] `js/controls.js` — locate: `if (key === '.' || key === 'Numpad0') {`

`KeyboardEvent.key` for the numpad-0 key is `'0'` (NumLock on) or `'Insert'` (NumLock off); `'Numpad0'` only ever appears as `e.code`. The comparison at js/controls.js:253 reads the normalized `e.key`, so the intended P2 switch-player binding on numpad 0 can never fire — only the `'.'` binding works, leaving an unresponsive key for players following the implied two-keyboard-player control scheme.

**Change:** In `js/controls.js` line 253, change the condition to `if (key === '.' || e.code === 'Numpad0') {`. The keydown repeat guard (`keys[key]`) still works because it keys off `e.key` (`'0'`/`'Insert'`), and `switchPlayer` is a one-shot flag consumed by the game, so no keyup change is needed.

Input capture is local-only (lockstep transmits sampled input, not key events), so determinism is unaffected. The Swift port uses touch joysticks (Joystick.swift), no keyboard — no parity change.

**Verify:** `npm test` stays green. In a local 2-player browser match on a keyboard with a numpad: pressing numpad 0 with NumLock on switches P2's controlled player; pressing it with NumLock off also switches; `.` continues to work.

**Interacts with:** none.

### P4-9 [low] Standardize renderer animation timing on performance.now()
- [ ] `js/renderer.js` — locate: `const netTime = Date.now() * 0.003;`

Renderer animation phases mix two clocks: the goal-net wave (line 216), ghost-ball flicker (441), ball pentagon spin (495), power-up auras (528), slow rings (596), and stun orbit (607) use `Date.now()`, while volcano cracks, neon glow, kickoff barrier, charge-ring pulse, and others use `performance.now()`. `Date.now()` is wall-clock and jumps on NTP/timezone/system clock adjustments, making those animations visibly skip or reverse phase, and mixing bases lets related effects drift relative to each other.

**Change:** In `js/renderer.js`, replace `Date.now()` with `performance.now()` at all six call sites: lines 216 (`netTime`), 441 (ghost flicker alpha), 495 (pentagon spin `angle`), 528 (power-up aura `t`), 596 (slow rings `t`), and 607 (stun orbit `t`). Multipliers and everything else stay identical — these are free-running sine phases, so only the phase origin shifts.

Renderer-only cosmetic timing; no sim state, no checksum/serializer change, no lockstep impact. The Swift port animates via SKAction — no parity change.

**Verify:** `grep -n "Date.now" js/renderer.js` returns no matches. `npm test` stays green. In the browser: goal nets wave, the ball pattern spins, ghost ball flickers, and power-up auras pulse exactly as before.

**Interacts with:** P4-2 and P4-7 (nearby edits in renderer.js draw functions).

---

## Package P5 — Client quality: PWA, audio, settings, accessibility
**Goal.** Make the dormant PWA/offline support actually work, fix audio lifecycle on iOS Safari, stop practice mode corrupting shared settings.
**When.** Any time. Independent items.
**Agent capability.** basic agent
**Package verification.** After all items land, do the release bookkeeping once: bump the `?v=` query strings for every file this package edited — `js/audio.js?v=4`→`?v=5`, `js/ui.js?v=26`→`?v=27`, `js/main.js?v=23`→`?v=24`, `css/style.css?v=24`→`?v=25` — in BOTH `index.html` (the `<script>`/`<link>` tags) and `sw.js` (the `ASSETS` array entries must remain byte-identical to the URLs index.html loads), and bump `CACHE_NAME` in `sw.js` from `'kickzone-v3'` to `'kickzone-v4'`. Then run `npm test` from the repo root (all existing node tests must pass). Finally serve the repo root over HTTP (`cd "/Users/matt/Project 1/kickball" && python3 -m http.server 8000`), open `http://localhost:8000` in Chrome, and confirm: DevTools → Application → Service Workers shows `sw.js` activated; Application → Manifest shows the KickZone manifest with icons and no warnings; toggling DevTools Network to "Offline" and reloading still loads the game; a Practice session followed by Quick Match still starts a 2v2, 3:00 match with power-ups; background music plays without gaps at loop boundaries; audio still works after `Sound.ctx.suspend()` in the console followed by a click.

### P5-1 [medium] Guard all localStorage access in audio.js so blocked storage cannot kill the UI
- [ ] `js/audio.js` — locate: `localStorage.getItem('kickzone_volume')`

`SoundManager`'s constructor reads `localStorage` with no try/catch, and it runs at script-parse time via `const Sound = new SoundManager()` at the bottom of `js/audio.js`. In browsers where storage access throws (Chrome/Edge "Block all cookies", sandboxed iframe embeds), `audio.js` aborts, the global `Sound` binding is never created, and the `UI` constructor then throws `ReferenceError` at `volSlider.value = Sound.volume * 100` (js/ui.js, ~line 194) — the whole menu becomes dead. `setVolume` and `toggleMute` also call `localStorage.setItem` unguarded, and a corrupted stored value makes `parseFloat` yield `NaN`, which later breaks `_updateVolume`'s `setTargetAtTime`.

**Change:**
1. At the top of `js/audio.js`, before `class SoundManager`, add two module-scope helpers: `function _storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }` and `function _storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }`.
2. In the constructor, replace the two raw reads: `const sv = _storageGet('kickzone_volume'); if (sv !== null) { const v = parseFloat(sv); if (Number.isFinite(v)) this.volume = Math.min(1, Math.max(0, v)); }` and `const sm = _storageGet('kickzone_muted'); if (sm === 'true') this.muted = true;`.
3. In `setVolume` (line ~74) and `toggleMute` (line ~80), replace `localStorage.setItem(...)` with `_storageSet(...)`.
This touches no simulation code; no checksum/serializer changes and no Swift parity (the native port has no SoundManager).

**Verify:** `npm test` still passes. In a browser: run `localStorage.setItem('kickzone_volume', 'abc')` in the console, reload — the game loads, the volume slider shows 60, and button-click SFX play (previously audio silently broke). Then enable Chrome Settings → Privacy → "Block all cookies", reload `http://localhost:8000` — the menu renders AND Quick Match → Start Match starts a game (previously the UI constructor threw `ReferenceError: Sound is not defined` and every button was dead). Re-enable cookies afterwards.

**Interacts with:** P5-2, P5-3 (same file — apply in this order to avoid merge friction).

### P5-2 [medium] Recover the AudioContext after iOS interruptions instead of unlocking only once
- [ ] `js/audio.js`, `js/ui.js` — locate: `this.ctx.state === 'suspended'`

`SoundManager.unlock()` is the only place `ctx.resume()` is ever called, and its sole caller is the first-gesture `initAudio` handler in the `UI` constructor (js/ui.js lines 17–24), registered with `{ once: true }` and self-removing. On iOS Safari — this game's primary mobile target — a phone call, Siri, alarm, and app switching move the AudioContext to the non-standard `'interrupted'` state, which `unlock()`'s `state === 'suspended'` check misses anyway. After one interruption, all SFX and music stay dead for the rest of the session; the mute button and volume slider call `Sound.init()` (a no-op once initialized), so nothing can recover it short of a reload.

**Change:**
1. In `js/audio.js` `unlock()`, change the guard from `this.ctx.state === 'suspended'` to `this.ctx.state !== 'running'` (this also covers WebKit's `'interrupted'` state).
2. In `js/ui.js`, in the `UI` constructor immediately after the two `initAudio` registrations (after line 24), add two persistent recovery hooks: `document.addEventListener('pointerdown', () => { if (Sound.ctx && Sound.ctx.state !== 'running') Sound.unlock(); }, true);` (capture phase, never removed) and `document.addEventListener('visibilitychange', () => { if (!document.hidden && Sound._initialized) Sound.unlock(); });`. The `Sound._initialized` guard prevents creating the AudioContext outside a user gesture.
No sim code touched; no checksum/serializer changes; no Swift parity needed.

**Verify:** `npm test` passes. In a desktop browser: start a match so audio plays, run `Sound.ctx.suspend()` in the console (SFX go silent), then click anywhere — `Sound.ctx.state` returns `'running'` and SFX are audible again (before the fix, sound stayed dead because the once-only unlock handler was gone). On an iOS device, if available: start a match, invoke Siri, dismiss it — audio resumes on the next tap.

**Interacts with:** P5-1, P5-3 (js/audio.js), P5-4 (js/ui.js).

### P5-3 [low] Schedule background-music loops on the AudioContext clock instead of bare setTimeout
- [ ] `js/audio.js` — locate: `loopLen * 1000 - 100`

`_playMusicLoop()` anchors each 4-bar loop at `ctx.currentTime + 0.05` when its callback happens to run, and schedules the next loop with `setTimeout(loopLen * 1000 - 100)`. That leaves ~150 ms of margin with no absolute-time accumulation, so any main-thread stall longer than that (GC pause, heavy physics/render frame, background-tab timer clamping ≥ 1 s) produces an audible gap at the loop seam, and the errors accumulate rather than correct — exactly when the game is busiest.

**Change:** Replace the timer with a standard Web Audio lookahead scheduler:
1. In the constructor, add `this._nextLoopTime = 0;`.
2. In `startMusic()`, after setting `_bgmPlaying`, set `this._nextLoopTime = this.ctx.currentTime + 0.05;`, replace the direct `this._playMusicLoop()` call with `this._scheduleMusicAhead()`, and start the wake-up timer: `this._bgmInterval = setInterval(() => this._scheduleMusicAhead(), 250);`.
3. Add a new method `_scheduleMusicAhead()`: return early if `!this._bgmPlaying || !this.ctx`; compute `const loopLen = (60 / 105) * 16;` (beat × 4 beats/bar × 4 bars, matching the constants inside `_playMusicLoop`); if `this._nextLoopTime < this.ctx.currentTime` reset it to `this.ctx.currentTime + 0.05` (catch-up after long tab-hide so it never schedules a backlog of past loops); then `while (this._nextLoopTime - this.ctx.currentTime < 2) { this._playMusicLoop(this._nextLoopTime); this._nextLoopTime += loopLen; }`.
4. Change `_playMusicLoop()` to `_playMusicLoop(t)`: delete the line `const t = this.ctx.currentTime + 0.05;` and delete the trailing `this._bgmInterval = setTimeout(...)` block entirely.
5. In `stopMusic()`, change `clearTimeout(this._bgmInterval)` to `clearInterval(this._bgmInterval)`.
Audio only — no determinism, checksum, serializer, and Swift implications.

**Verify:** `npm test` passes. In a browser with music playing (start any match), run a deliberate 500 ms main-thread stall in the console (`const s = performance.now(); while (performance.now() - s < 500);`) shortly before a loop boundary — the music continues seamlessly (before, a ~0.5 s gap was audible). Hide the tab for 30 s, return — music resumes cleanly without a burst of overlapping loops.

**Interacts with:** P5-1, P5-2 (same file).

### P5-4 [medium] Stop Practice mode and AI Lab test from permanently clobbering shared match settings
- [ ] `js/ui.js` — locate: `this.game.settings.duration = 9999`

`startPractice()` (js/ui.js ~1092) mutates the single shared `game.settings` object in place (teamSize=1, duration=9999, goalLimit=0, powerups=false, map='classic') and nothing ever restores it; the `btn-ai-lab-test` handler (~1248) does the same and additionally pins `difficulty='expert'`. After one Practice session, Quick Match shows "2v2 / 3 min / Power-Ups On" highlighted (the `active` classes are hard-coded in index.html and never re-synced) but actually starts a 1v1, power-up-free match with a 9999-second timer. The codebase already half-solves this for P2P via `_preP2PDifficulty`, but that only restores difficulty — the P2P room-settings merge still leaks teamSize/duration/map.

**Change:** Generalize the existing snapshot/restore pattern to the whole settings object:
1. In `startPractice()`, as the first line, add `if (!this._preMatchSettings) this._preMatchSettings = { ...this.game.settings };` before the mutations.
2. Add the same line at the top of the `btn-ai-lab-test` click handler (before `this.game.settings.teamSize = ...`).
3. In `_startP2PHostMatch()` and `_startP2PClientMatch()`, replace the line `this._preP2PDifficulty = this.game.settings.difficulty;` with that same `_preMatchSettings` snapshot line. Keep the `this.game.settings.difficulty = 'normal';` pin in both P2P paths untouched — lockstep peers must keep running identical settings.
4. In `_teardownMatch()`, replace the `_preP2PDifficulty` restore block (lines ~294–298) with: `if (this._preMatchSettings) { this.game.settings = { ...this._preMatchSettings }; this._preMatchSettings = null; }`. Grep for `_preP2PDifficulty` afterwards and delete any leftover reference.
5. Add a method `_syncSettingsUI()` that reads `const s = this.game.settings;` and for each button in `document.querySelectorAll('#match-settings-screen .option-btn')` toggles the `active` class by comparing its dataset to the live settings: `data-team-size` vs `String(s.teamSize)`, `data-duration` vs `String(s.duration)`, `data-goals` vs `String(s.goalLimit)`, `data-difficulty` vs `s.difficulty`, `data-powerups` vs `(s.powerups ? 'on' : 'off')`, `data-map` vs `s.map` (only compare the attribute each button actually carries). Call it from `showScreen()` when `name === 'match-settings'`.
Determinism guardrail: this must keep host and guest simulations bit-identical — the snapshot is taken before match start and the restore happens only in `_teardownMatch` (never mid-match), and the in-match settings the sim reads are unchanged, including the P2P `difficulty='normal'` pin. No sim-state field is added/removed, so `js/game.js` `_computeChecksum` and `_serializeFullState` need no updates. The Swift port (ios/App/App/KickZone/) has its own native settings flow in `UI/ContentView.swift` and does not share this code — no parity change needed.

**Verify:** `npm test` passes. In a browser: play Practice, quit to menu, open Quick Match — the settings screen highlights 2v2 / 3 min / 5 goals / Normal / On / Classic, and Start Match begins a 2v2 match with a 3:00 timer and power-ups (before the fix: 1v1, no power-ups, timer 166:39). Repeat with AI Lab → Test Match: after quitting, difficulty is back to Normal. Change a setting (e.g. 1v1), play Practice, return — the 1v1 choice is still highlighted and used (user choices persist; only special-mode overrides are rolled back).

**Interacts with:** P5-5 (both edit js/ui.js `_teardownMatch`; do this one first), P5-2 (js/ui.js constructor).

### P5-5 [low] Delete the dead legacy P2P state-broadcast path and the unused _bgmNodes field
- [ ] `js/ui.js`, `js/p2p.js`, `js/audio.js` — locate: `_buildP2PState()`

The pre-lockstep host-broadcast architecture left an unreachable code chain: `_buildP2PState()` (js/ui.js ~786–823) has zero call sites; the `p2p.onPeerInput` handler in `setupP2PEvents` (~507–520) guards on `this.game._p2pInputQueues`, which is never created anywhere; `p2p.js`'s `broadcastState()` has zero callers, so its receive-side `_handleBinaryState()` can never fire; `_teardownMatch` clears a `_p2pBroadcastInterval` that is never set; and `js/audio.js` declares `this._bgmNodes = []` which is never read nor written again. Keeping this invites someone to "fix" a path that cannot execute.

**Change:**
1. `js/ui.js`: delete the entire `_buildP2PState()` method; delete the `this.p2p.onPeerInput = (peerId, input) => {...}` block in `setupP2PEvents` (including its "Host: receive input from peers" comment); delete the `_p2pBroadcastInterval` cleanup block in `_teardownMatch` (the `if (this.game._p2pBroadcastInterval) {...}` statement and its "legacy" comment).
2. `js/p2p.js`: delete the `broadcastState(binaryData)` method; delete `_handleBinaryState(buffer)`; delete its two call sites — the `if (e.data instanceof ArrayBuffer) { this._handleBinaryState(e.data); return; }` branch in the client `dc.onmessage` handler (~line 446), and the entire `case 'state':` block in the WebSocket message switch (~lines 263–277, the base64-relay decoder).
3. `js/audio.js`: delete the line `this._bgmNodes = [];` and its comment.
4. Do NOT touch `js/game.js` (its `network`-guarded sends are out of scope for this item), and leave `p2p.js`'s `onPeerInput` field, `sendInput`, `stateBuffer`, and `interpolate` in place — this item removes only the listed pieces.
5. Grep the repo for `_buildP2PState`, `_handleBinaryState`, `broadcastState`, `_p2pInputQueues`, `_p2pBroadcastInterval`, `_bgmNodes` and confirm zero remaining references in `js/`.
Determinism guardrail: the change must keep host and guest simulations bit-identical — everything deleted is provably unreachable on every peer, so behavior is unchanged for all peers; no sim-state field is added/removed, so `js/game.js` `_computeChecksum` and `_serializeFullState` need no updates. The Swift port (ios/App/App/KickZone/) never had this legacy path — no parity change.

**Verify:** `npm test` passes (test/p2p-protocol.test.js exercises the live lockstep protocol and must be untouched). The grep in step 5 returns no hits under `js/`. In a browser, a full P2P smoke test still works if two clients are available: Create Room + Join Game on two tabs, start the match, both peers stay in sync and the match ends normally.

**Interacts with:** P5-4 (js/ui.js `_teardownMatch`), P5-1/P5-2/P5-3 (js/audio.js).

### P5-6 [medium] Register the service worker so sw.js and offline support actually run
- [ ] `js/main.js` — locate: `const ui = new UI(game);`

`sw.js` implements a complete offline app shell — a 23-entry precache list mirroring every `?v=` query string in index.html, `allSettled` install hardening, versioned cache cleanup, and a stale-while-revalidate fetch handler — but nothing anywhere calls `navigator.serviceWorker.register()`. The service worker never installs, so there is no offline support, no asset caching, and Chromium's PWA installability check fails. Every edit to the `ASSETS` list has been maintenance on inert code.

**Change:** At the end of `js/main.js`, add the registration, deferred to `load` so it does not compete with game-asset fetches: `if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(e => console.warn('[SW] registration failed', e)); }); }`. The relative path `sw.js` resolves against the served root (start_url is `/index.html`), giving the SW scope `/` to match the absolute-path `ASSETS` entries. The `'serviceWorker' in navigator` guard makes this a safe no-op inside the Capacitor iOS webview and on non-supporting browsers. No sim code, no checksum/serializer, no Swift parity.

**Verify:** Serve the repo root over HTTP (`cd "/Users/matt/Project 1/kickball" && python3 -m http.server 8000`), open `http://localhost:8000` in Chrome. DevTools → Application → Service Workers shows `sw.js` with status "activated and is running"; Application → Cache Storage shows `kickzone-v3` (v4 after the package-final bump) populated with the ASSETS entries. Set DevTools Network to "Offline" and reload — the game menu loads and Practice mode is playable. `npm test` still passes.

**Interacts with:** P5-7 (together they complete PWA installability), package-final `?v=`/`CACHE_NAME` bump.

### P5-7 [medium] Link manifest.json, apple-touch-icon, and a favicon from index.html
- [ ] `index.html` — locate: `<link rel="stylesheet" href="css/style.css`

index.html's `<head>` contains only meta tags and the stylesheet link — there is no `<link rel="manifest">`, so the fully-prepared `manifest.json` (name, icons, standalone display, portrait orientation lock, start_url) is never read by any browser despite `apple-mobile-web-app-capable` being set and the SW precaching it. There is also no `<link rel="apple-touch-icon">` (the icon lives at `icons/apple-touch-icon.png`, not the site root where iOS looks by convention), so iOS "Add to Home Screen" gets a page screenshot, and there is no favicon.

**Change:** In `index.html`, immediately before the existing stylesheet `<link>` (line ~18), add three lines: `<link rel="manifest" href="manifest.json">`, `<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">`, and `<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">`. All three files already exist in the repo (`manifest.json`, `icons/apple-touch-icon.png`, `icons/icon-192.png`); no new assets are needed and `sw.js` already precaches them. No sim code, no checksum/serializer changes. The Capacitor iOS build restages index.html via `npm run stage:web`, so no separate iOS edit is needed.

**Verify:** Serve locally as in P5-6 and open Chrome DevTools → Application → Manifest: it shows "KickZone - Mobile Soccer", standalone display, portrait orientation, and both icons with no warnings. The browser tab shows the KickZone icon instead of the default globe. With P5-6 also landed, Chrome's address bar offers the install prompt (desktop: install icon in the omnibox).

**Interacts with:** P5-6.

### P5-8 [low] Allow pinch-zoom on menu screens and give icon-only buttons accessible names
- [ ] `index.html`, `css/style.css`, `js/ui.js` — locate: `maximum-scale=1.0, user-scalable=no`

The viewport meta sets `maximum-scale=1.0, user-scalable=no`, disabling pinch zoom across the entire app — including the menu, settings, and How-to-Play text screens where zooming is a legitimate low-vision need (WCAG 1.4.4) — while iOS Safari has ignored `user-scalable=no` since iOS 10 anyway, so it does not even deliver the intended gameplay benefit. Separately, the icon-only pause button (`&#10074;&#10074;`) and the emoji mute button have no `aria-label`, so screen readers announce nothing meaningful for the controls that gate pausing/leaving a match and audio.

**Change:**
1. `index.html` line 5: change the viewport meta content to `width=device-width, initial-scale=1.0` (drop `maximum-scale` and `user-scalable`).
2. `css/style.css`: remove `touch-action: none;` from the `body` rule and add a new rule `#game-screen { touch-action: none; }` so browser gesture handling stays disabled on the game surface (the joystick handlers in js/controls.js already call `preventDefault` with `{ passive: false }`) while text screens regain pinch-zoom.
3. `index.html`: add `aria-label="Pause"` to `<button id="btn-pause" ...>` and `aria-label="Mute"` to `<button id="btn-mute" ...>`.
4. `js/ui.js` (~lines 194–206): where `muteBtn.textContent` is set — the initial assignment and the two handlers — also set `muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute')` (initial: based on `Sound.muted`; the volume-slider unmute branch sets it to `'Mute'`).
No sim code, no checksum/serializer changes, no Swift parity (the native port uses SwiftUI accessibility separately).

**Verify:** `npm test` passes. On a touch device (Chrome DevTools device emulation with touch also works for the CSS check): pinch-zoom works on the menu and How-to-Play screens; during a match, dragging the joystick neither zooms nor scrolls the page. In DevTools → Elements → Accessibility pane, `#btn-pause` exposes the name "Pause" and `#btn-mute` exposes "Mute", flipping to "Unmute" after tapping it.

**Interacts with:** P5-4 (both edit js/ui.js), package-final `?v=` bump for css/style.css.

---

## Package P6 — RL / AI subsystem
**Goal.** Fix gameplay-visible AI bugs (agent sharing, stun-lock, silent expert downgrade), then training-correctness bugs (entropy sign, GAE, checkpointing).
**When.** Any time after P1 (the kick-latch fix interacts with hitNearbyPlayers changes). One PR.
**Agent capability.** basic agent for runtime items; training-math items need care but are localized
**Package verification.** Run `npm test` (all existing suites in `test/` plus the new `test/rl-trainer.test.js`, `test/rl-nn.test.js`, `test/rl-policy.test.js`, `test/rl-runtime.test.js` must pass). Then a manual browser smoke pass: (1) fresh profile (cleared localStorage) → Expert 1v1 match uses the bundled model (console logs it) and the AI never chain-stuns you against a wall; (2) AI Lab → start 1v1 training for ~3 generations, reload, generation is retained; (3) 2v2 Expert match with a trained 2v2 model → run `new Set(game.aiControllers.map(c => c.ai)).size === game.aiControllers.length` in the console (must be `true`).

### P6-1 [high] Gate the AI body-check (hitNearbyPlayers) on the kick cooldown to stop per-tick stun-lock
- [ ] `js/game.js`, `server/game-simulation.js` — locate: `this.hitNearbyPlayers(player, cr);` (game.js) and `this._hitNearbyPlayers(player, cr);` (server)

In the AI application loop (`js/game.js` ~line 1289), `if (action.kick) { this.hitNearbyPlayers(player, cr); ... }` runs every fixed 16.67 ms tick. `hitNearbyPlayers` (game.js ~line 1946) has no cooldown: whenever `chargeRatio >= 0.25` it re-applies knockback and resets `p.stunTimer = 200 + chargeRatio*800` on every opponent within `radius + 40`. Both the RL runtime agents (which latch `_lastAction.kick` across their 30 ms reaction window) and the scripted `AIController` (which returns `kick: true` continuously while in range, `shared/ai.js:125-132`) therefore re-stun a wall- or corner-pinned human every tick — a permanent stun-lock. `Player.kick()`'s 180 ms `kickCooldown` never engages when the ball is out of range (it returns false without setting the cooldown, `shared/entities.js:128-174`), so gating on the ball-kick alone is not enough. Human input paths only call `hitNearbyPlayers` on discrete kick-release events, confirming the per-tick invocation is unintended. `server/game-simulation.js` lines 439-449 have the identical pattern.

**Change:**
1. In `js/game.js`, in the AI loop (`for (const { player, ai } of this.aiControllers)` around line 1289), change the kick branch to: `if (action.kick && player.kickCooldown <= 0) { const cr = action.chargeRatio || 0.3; this.hitNearbyPlayers(player, cr); const kicked = player.kick(this.ball, cr); if (!kicked) player.kickCooldown = 180; if (kicked) { /* existing stats/shake/sound block unchanged */ } }`. I.e. (a) the whole kick attempt (body-check + ball kick) only fires when `kickCooldown <= 0`, and (b) a whiffed attempt (ball out of range) still starts the same 180 ms cooldown so the body-check can fire at most every 180 ms — the same cadence a human kick-release achieves.
2. Apply the identical change to `server/game-simulation.js` in the AI loop at lines 439-449 (`if (action.kick) { const cr = action.chargeRatio || 0.3; this._hitNearbyPlayers(player, cr); ... }`), using `player.kickCooldown <= 0` as the gate and setting `player.kickCooldown = 180` when `player.kick(...)` returns false.
3. Do NOT touch the human input paths (game.js lines 617, 1187, 1224, 1259; server line 411) — those fire on discrete kick-release events already.

Determinism guardrail: this changes lockstep sim behavior (scripted AI runs inside the lockstep sim), so it must alter behavior identically for all peers — it does, because it is a pure function of existing sim state and all peers run the same code. It uses only the existing `kickCooldown` field, which is already in the lockstep checksum (`js/game.js` `_computeChecksum`, line ~746 `add(p.kickCooldown)`) and in `_serializeFullState` (`kc:` field, lines ~795/865) — no checksum or serializer update is required. The Swift port (`ios/App/App/KickZone/Game/GameEngine.swift`) has no `hitNearbyPlayers` equivalent (its AI loop at line 215 only calls `p.kick`), so no iOS change is needed.

**Verify:** `npm test` (the server-simulation and determinism suites must still pass). Add a regression test in `test/server-simulation.test.js`: build a simulation where an AI player stands adjacent to an opponent with the ball far away and the AI action returns `kick: true, chargeRatio: 0.5` every tick; step the sim 30 ticks and assert `_hitNearbyPlayers`'s stun was applied at most `ceil(30*16.67/180)+1` times (track via the victim's `stunTimer` being allowed to decrease between applications), i.e. assert the victim's `stunTimer` strictly decreases on at least one pair of consecutive ticks. Manually: in a browser Expert match, let the AI pin you against a wall — you must recover from stun.

**Interacts with:** P1 kick-latch item (per the package order note), P6-5.

### P6-2 [high] Give every 2v2 player its own RLRuntimeAgent2v2 instance (kill the wrap-around pool)
- [ ] `js/game.js`, `js/rl/orchestrator2v2.js` — locate: `this._rl2v2Pool[this._rl2v2PoolIdx % this._rl2v2Pool.length]`

A single-player 2v2 match creates 3 AI players (`startMatch`, game.js lines 354-372, calls `_makeAI()` three times), but `RLOrchestrator2v2.getRuntimeAgents()` (orchestrator2v2.js lines 442-451) returns exactly 2 agents, and the modulo indexer at game.js line 208 hands the SAME `RLRuntimeAgent2v2` object to the red teammate and to blue opponent #2. The instance's `_reactionTimer`, `_stack`, `_lastMove`, `_lastAction` are per-instance state (the file's own header says each player must get its own instance), so both players double-decrement one timer and one of them applies the other's cached action verbatim every tick — with the team-dependent x-sign flip wrong for the mirroring player. The pool is also cached across matches (invalidated only on `generation` change, game.js line 203), carrying stale frame stacks into new matches.

**Change:**
1. In `js/rl/orchestrator2v2.js`, replace `getRuntimeAgents()` with a per-call factory `getRuntimeAgent()`: cache the shared policy per generation (`if (!this._runtimePolicy || this._runtimePolicyGen !== this.generation) { this._runtimePolicy = root.RLRuntimeAgent2v2.makePolicyFrom(this.trainer.policy.serialize()); this._runtimePolicyGen = this.generation; }`), return `null` if `RLRuntimeAgent2v2` is undefined or the policy failed to build, and otherwise return `new root.RLRuntimeAgent2v2(this._runtimePolicy)` — a fresh agent instance on every call. Delete `getRuntimeAgents()` (its only caller is game.js).
2. In `js/game.js` `_makeAI()` (lines 197-211), delete the `_rl2v2Pool` / `_rl2v2PoolToken` / `_rl2v2PoolIdx` block and replace it with `const ag = window.rlOrch2v2.getRuntimeAgent(); if (ag) return ag;`. Remove any other references to `_rl2v2Pool*` fields.

Determinism guardrail: `_makeAI` early-returns the scripted `AIController` for lockstep matches before any RL branch (game.js line 185), so lockstep peers are unaffected; no sim-state field is added or removed, so `js/game.js` `_computeChecksum` and `_serializeFullState` need no update. The Swift port already creates one agent per player via `engine.expertAgentFactory = { RLAgent(policy: policy) }` (ios/App/App/KickZone/UI/ContentView.swift:337), so no iOS change is needed.

**Verify:** `npm test` still passes (no node-visible surface changes). Manually: with a trained 2v2 model, start a single-player 2v2 Expert match and run `new Set(game.aiControllers.map(c => c.ai)).size === game.aiControllers.length` in the console — must be `true` (it is `false` today). Watch the red AI teammate: it must no longer mirror a blue opponent's movement.

**Interacts with:** P6-8 (fresh per-match agents remove the cross-match stale-stack half of that item).

### P6-3 [high] Stop training checkpoints from silently failing on localStorage quota
- [ ] `js/rl/orchestrator.js`, `js/rl/orchestrator2v2.js`, `js/ui.js` — locate: `} catch(e) { /* storage full */ }`

`_save()` (orchestrator.js lines 424-450) stores the current policy PLUS `this.league.serialize()` — up to 10 additional full policy snapshots (~2.27 MB of JSON each; League entries are added every 25 generations). Around generation 50 the blob exceeds the ~5 MB localStorage quota and `localStorage.setItem` throws `QuotaExceededError`, which is swallowed by an empty catch with no logging, no UI signal, and no fallback. From then on every checkpoint (including the pagehide final save) silently fails and every reload reverts training to the last checkpoint that fit — hours of silent loss. `orchestrator2v2.js` `_save()` (lines 372-393) has the identical pattern with an even larger policy.

**Change:**
1. In `js/rl/orchestrator.js` `_save()`, wrap the `localStorage.setItem(STORAGE_KEY, JSON.stringify(obj))` call so that on exception it retries once with a league-free checkpoint: `const slim = { policy: obj.policy, generation: obj.generation, totalSteps: obj.totalSteps }; localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));`. The policy alone (~2.3 MB) always fits, preserving the "refresh loses ≤1 gen" guarantee; only the league opponents are dropped.
2. If the retry also throws, set `this._saveFailed = true`, `console.warn('[RL] checkpoint save failed — storage full. Export your model from the AI Lab.')` (warn once, guard on a `_saveFailWarned` flag), and call `this._emit({ event: 'save-failed' })`. On any successful write clear `this._saveFailed = false` and `this._saveFailWarned = false`.
3. Apply steps 1-2 identically in `js/rl/orchestrator2v2.js` `_save()` (use the `[RL2v2]` log prefix).
4. In `js/ui.js`, in the orchestrator `onProgress` handler that already drives `_setAILabStatus` (AI Lab wiring around line 1140), handle `event === 'save-failed'` by calling `this._setAILabStatus('SAVE FAILED — storage full, export your model!', '#ff4d6d')`.

This code never runs inside the lockstep sim; no determinism or checksum impact. No iOS equivalent (training is web-only).

**Verify:** `npm test` unaffected. Manually in the browser console: `const orig = localStorage.setItem.bind(localStorage); let n = 0; localStorage.setItem = (k, v) => { if (k === 'kickzone-rl-1v1-v1') { n++; if (v.length > 3_000_000 || n < 2) throw new DOMException('quota', 'QuotaExceededError'); } return orig(k, v); }; window.rlOrch._save();` — assert the slim retry landed (`JSON.parse(localStorage.getItem('kickzone-rl-1v1-v1')).league === undefined` and `generation` matches), then make setItem always throw, call `_save()` again, and assert the console warning appears and the AI Lab status shows the red save-failed message. Restore `localStorage.setItem = orig` afterwards.

**Interacts with:** P6-14 (checkpoint integrity on load).

### P6-4 [medium] Load the bundled pretrained model so Expert 1v1 is not silently identical to Normal
- [ ] `js/main.js`, `js/game.js`, `sw.js` — locate: `const fallbackDiff = (diff === 'expert') ? 'normal' : diff;`

On the web, the RL agent is only used when `window.rlOrch.hasTrainedAgent()` is true, which requires a locally trained or hand-imported checkpoint (`generation > 0`). The shipped 2.27 MB pretrained model `models/kickzone-rl-gen1325.json` (inDim 168, hidden 256 — matching `RLEncoder.STACKED_DIM`) is referenced by zero web files, so on a fresh install selecting "Expert" silently gives `new AIController('normal')` — Expert is literally Normal with no notice. (The iOS app already loads its bundled copy via `RLAgentLoader.loadBundledPolicy()`, so this is web-only.)

**Change:**
1. In `js/main.js`, add a fire-and-forget prefetch after the game/UI setup: `fetch('models/kickzone-rl-gen1325.json').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(obj => { if (obj && obj.policy && obj.policy.inDim === RLEncoder.STACKED_DIM) { window.rlBundledPolicySer = obj.policy; console.log('[RL] bundled expert model ready (gen ' + (obj.generation || '?') + ')'); } }).catch(e => console.warn('[RL] bundled expert model unavailable — Expert falls back to scripted AI', e));` (guard the whole thing with `typeof RLEncoder !== 'undefined'`).
2. In `js/game.js` `_makeAI()`, after the existing `hasTrainedAgent()` 1v1 branch (so a user-trained checkpoint always wins) and before the `fallbackDiff` fallback, add: `if (diff === 'expert' && ts === 1 && typeof RLRuntimeAgent !== 'undefined' && window.rlBundledPolicySer) { const ag = new RLRuntimeAgent(); if (ag.loadFrom(window.rlBundledPolicySer)) return ag; }`. Never write the bundled model into the user's localStorage checkpoint.
3. In `sw.js`, add `'/models/kickzone-rl-gen1325.json'` to the `ASSETS` precache array so Expert works offline (install already uses `Promise.allSettled`, so a fetch failure cannot break the install).

If the fetch fails or the model has not arrived yet when a match starts, the existing `AIController('normal')` fallback applies for that match — acceptable. Determinism guardrail: the lockstep early-return in `_makeAI` (game.js line 185) runs before this branch, so lockstep peers still all use the scripted AI; no sim-state field changes, so no checksum/serializer update. iOS already has this behavior — no parity change.

**Verify:** `npm test` unaffected. Manually: clear site data, reload, wait for the `[RL] bundled expert model ready` console line, start an Expert 1v1 match, and assert `game.aiControllers[0].ai.constructor.name === 'RLRuntimeAgent'` in the console. Then block the model URL in DevTools, reload, start Expert 1v1, and assert the fallback warning fires and the match still starts with `AIController`.

**Interacts with:** P6-5, P6-6, P6-7 (the bundled model's live behavior depends on those runtime-decode fixes).

### P6-5 [medium] Apply the training-time 0.95 charge scaling in the runtime action decode
- [ ] `js/rl/runtime.js`, `js/rl/runtime2v2.js`, `ios/App/App/KickZone/AI/NeuralNet.swift` — locate: `this._lastAction.chargeRatio = Math.min(chg, 1.0);`

Every training and eval path scales the charge head output by 0.95 (`worker.js` lines 114/145/163, `worker2v2.js` lines 89/107 — "squash a bit so 1.0 isn't always super-kick"), but the deployed runtime agents skip it (`runtime.js:91`, `runtime2v2.js:82` use `Math.min(chg, 1.0)`). The deployed agent therefore kicks systematically harder than the policy that was evaluated, and crosses the super-kick threshold (`chargeRatio > 0.8` in `shared/entities.js:150`) at sigmoid output 0.8 instead of ~0.842 — firing super-kicks a Phase-1/2-trained model has never experienced.

**Change:** In `js/rl/runtime.js` (line ~91) and `js/rl/runtime2v2.js` (line ~82), change the decode to `this._lastAction.chargeRatio = Math.min(chg * 0.95, 1.0);` so it matches `worker.js`/`worker2v2.js` exactly. Swift parity: in `ios/App/App/KickZone/AI/NeuralNet.swift` `decodeDeterministic` (line ~64), change `let chg = sigmoidf(raw[2])` usage so the returned charge is `chg * 0.95` (matching the JS eval decode `detFromPolicy`). These files never run inside the lockstep sim (RL agents are disabled for lockstep in `_makeAI`), so there is no determinism/checksum impact.

**Verify:** `grep -n "0.95" js/rl/runtime.js js/rl/runtime2v2.js ios/App/App/KickZone/AI/NeuralNet.swift` shows the scaling in all three decodes. `npm test` passes. The vm-based runtime test added in P6-6 (`test/rl-runtime.test.js`) additionally asserts that after one `update()` call the returned `chargeRatio` equals `sigmoid(raw[2]) * 0.95` for a known policy output.

**Interacts with:** P6-4, P6-6, P6-1.

### P6-6 [medium] Clamp the runtime timeLeft feature into the trained range and stop `|| 60000` swallowing 0
- [ ] `js/rl/runtime.js`, `js/rl/runtime2v2.js`, `ios/App/App/KickZone/AI/RLAgent.swift` — locate: `g.timeRemaining || 60000`

The encoder emits `timeLeft / 60000` (encoder.js:113). In training, `timeLeft = (maxSteps - steps) * 33.34` with `maxSteps = 1024`, so the feature never exceeds ~0.569. At runtime `g.timeRemaining` starts at 180000 ms by default (game.js:28), making the feature 3.0 at kickoff — a permanently out-of-distribution global input for most of the match. Additionally `g.timeRemaining || 60000` maps the legitimate value 0 (clock expired / sudden death, reachable via game.js:1123-1131) to 60000, snapping the feature from ~0 to 1.0 exactly when endgame behavior matters. `runtime2v2.js:61` has the same code.

**Change:**
1. In `js/rl/runtime.js`, add a module-level constant `const TRAINED_HORIZON_MS = 34140; // rolloutLen 1024 * 33.34ms — max timeLeft ever seen in training` and a helper `function runtimeTimeLeft(g) { const tl = (g && Number.isFinite(g.timeRemaining)) ? g.timeRemaining : TRAINED_HORIZON_MS; return Math.min(tl, TRAINED_HORIZON_MS); }`. In `update()`, replace `timeLeft: g ? (g.timeRemaining || 60000) : 60000,` with `timeLeft: runtimeTimeLeft(g),`. Expose the helper for tests as a static: `RLRuntimeAgent._timeLeftFor = runtimeTimeLeft;`.
2. Duplicate the same constant/helper/replacement in `js/rl/runtime2v2.js` (expose as `RLRuntimeAgent2v2._timeLeftFor`).
3. Swift parity: in `ios/App/App/KickZone/AI/RLAgent.swift` line ~49, change `timeLeftMs: 60_000` to `timeLeftMs: 34_140` so the iOS feature (encoded at Encoder.swift:102 as `timeLeftMs/60000`) sits at the top of the trained range instead of above it.

No lockstep/checksum impact (RL runtime never runs in lockstep).

**Verify:** Add `test/rl-runtime.test.js` (node:test) that loads `js/rl/runtime.js` via `node:vm` (`vm.runInNewContext(fs.readFileSync('js/rl/runtime.js','utf8'), ctx)` with `ctx.RLPolicy = require('../js/rl/policy')` and `ctx.RLEncoder = require('../js/rl/encoder')`), then asserts: `RLRuntimeAgent._timeLeftFor({ timeRemaining: 0 }) === 0`, `_timeLeftFor({ timeRemaining: 180000 }) === 34140`, `_timeLeftFor(null) === 34140`, `_timeLeftFor({ timeRemaining: NaN }) === 34140`. Same four asserts for `runtime2v2.js`. `npm test` passes.

**Interacts with:** P6-4, P6-5, P6-7.

### P6-7 [medium] Zero the power-up observation features at runtime to match the training distribution
- [ ] `js/rl/runtime.js`, `js/rl/runtime2v2.js`, `js/rl/encoder.js`, `js/rl/encoder2v2.js`, `ios/App/App/KickZone/AI/Encoder.swift`, `ios/App/App/KickZone/AI/RLAgent.swift` — locate: `g.powerUpManager && g.powerUpManager.powerUps) || []`

`envOptsForPhase()` sets `powerUps: false` for ALL training phases in both orchestrators, so during training the ~15 power-up-related observation dims (self/opponent power-up one-hots at encoder.js:60-65/75-79, frozen/slowed flags, `ball.ghost` at :89, and the 4 nearest-power-up features at :159-181) are always zero. At runtime the agents feed live power-up state into the encoder while game settings default to `powerups: true`, so in a normal Expert match the network receives nonzero values in dims it has only ever seen as zero — classic train/serve skew producing arbitrary responses exactly when power-ups are in play. The AI Lab test button masks this by forcing `powerups = false` (ui.js:1252).

**Change:**
1. In `js/rl/encoder.js`, extend the signature to `function encode(self, opp, ball, field, gameState, powerUps, out, mirrorY = false, zeroPowerUps = false)`. At the top add `if (zeroPowerUps) powerUps = null;` and local views `const selfPU = zeroPowerUps ? null : self.powerUp; const oppPU = zeroPowerUps ? null : opp.powerUp; const ballGhost = zeroPowerUps ? false : ball.ghost;`, then use `selfPU`/`oppPU`/`ballGhost` in the one-hot and ghost lines (lines 60-65, 75-79, 89). Leave `stunTimer`/`pullActive` untouched (those occur in training). Training/env callers pass nothing extra, so behavior there is bit-identical.
2. Apply the same optional `zeroPowerUps` parameter to `js/rl/encoder2v2.js`'s `encode` (same feature families: per-player one-hots, ball ghost, nearest-power-up block).
3. In `js/rl/runtime.js` `update()`, call `RLEncoder.encode(player, opp, ball, field, gameState, powerUps, this._obs, false, true);` (and keep passing the live array — it is nulled inside). In `js/rl/runtime2v2.js`, pass `true` as the trailing `zeroPowerUps` argument likewise.
4. Swift parity: `ios/App/App/KickZone/AI/Encoder.swift` reads live `powerUp` one-hots (lines 51-56, 66-70) and `b.ghost` (line 80). Add a `zeroPowerUps: Bool = false` parameter to `RLEncoder.encode` that forces those outputs to 0, and pass `zeroPowerUps: true` from `RLAgent.update` (RLAgent.swift line ~48).

No lockstep/checksum impact (encoder is not part of the deterministic sim; RL agents are disabled in lockstep).

**Verify:** Add to `test/rl-runtime.test.js` (encoder is `require`-able directly): build a stub player with `powerUp: 'speed'`, opp with `powerUp: 'ghost'`, ball with `ghost: true`, and one power-up in the array; call `RLEncoder.encode(..., mirrorY=false, zeroPowerUps=true)` and assert output indices 6-11 (self one-hots + frozen/slowed), 19-22 (opp one-hots), the `ball.ghost` dim, and the last 4 nearest-power-up dims are all 0, while the same call with `zeroPowerUps=false` produces nonzero values in those dims. Also assert a plain 8-argument call (no flag) is byte-identical to pre-change output for a fixed input (training-path regression). `npm test` passes.

**Interacts with:** P6-4, P6-6.

### P6-8 [low] Add reset() to runtime agents and re-prime frame stacks on post-goal and sudden-death resets
- [ ] `js/rl/runtime.js`, `js/rl/runtime2v2.js`, `js/game.js`, `ios/App/App/KickZone/AI/RLAgent.swift`, `ios/App/App/KickZone/Game/GameEngine.swift` — locate: `if (!this._stackPrimed) {`

The training env refills the frame stack on every episode reset AND every post-goal position reset (`_initStacks`, env.js:155/186) so the policy never sees teleport discontinuities. The runtime agents prime once (`_stackPrimed`) and never again: after every goal the players/ball teleport to spawn but the stack retains pre-teleport frames, feeding the policy impossible transitions for the next ~60 ms. (The cross-match carryover half of this problem is fixed by P6-2's fresh-agent-per-match factory.)

**Change:**
1. In `js/rl/runtime.js` and `js/rl/runtime2v2.js`, add a `reset()` method to the agent class: `reset() { this._stackPrimed = false; this._reactionTimer = 0; this._lastAction.kick = false; this._lastAction.chargeRatio = 0; this._lastMove.x = 0; this._lastMove.y = 0; this._lastPull = false; }`.
2. In `js/game.js` `resetAfterGoal()` (line ~1823), after `this.powerUpManager.reset();` add: `for (const { ai } of this.aiControllers) { if (typeof ai.reset === 'function') ai.reset(); }`.
3. Add the same guarded loop in the sudden-death position reset (game.js lines ~1133-1135, right after `this.powerUpManager.reset();`).
4. Swift parity: add `func reset() { stackPrimed = false; reactionTimerMs = 0; lastMove = .zero; lastCharge = 0; lastKick = false; lastPull = false }` to `ios/App/App/KickZone/AI/RLAgent.swift`, and in `ios/App/App/KickZone/Game/GameEngine.swift` call the agents' `reset()` from `resetForKickoff()` (line ~284) for every AI controller that is an `RLAgent`.

Determinism guardrail: `resetAfterGoal` runs inside the lockstep sim, but in lockstep every AI is a scripted `AIController` (game.js:185), which has no `reset` method (verified in `shared/ai.js`), so the guarded call is a no-op executed identically on all peers. No sim-state field is added or removed — the RL agent's internal stack is not sim state — so `_computeChecksum` and `_serializeFullState` need no update. `server/game-simulation.js` uses only scripted AI, so no server change.

**Verify:** Extend `test/rl-runtime.test.js` (vm-loaded runtime as in P6-6): construct an agent with a small random `Policy`, drive `update()` twice with stub state so the stack is primed and pushed, call `reset()`, assert `_stackPrimed === false`, `_reactionTimer === 0`, `_lastAction.kick === false`, then call `update()` again and assert the stack was re-filled (all K frames identical — compare `_stack.frames[0]` and `_stack.frames[2]`). `npm test` passes, including the existing lockstep determinism suite.

**Interacts with:** P6-2.

### P6-9 [medium] Fix the flipped sign on the PPO discrete-head entropy bonus
- [ ] `js/rl/trainer.js` — locate: `const dH_dKickL = -bernEntGradLogit(kickL, kP);`

`bernEntGradLogit(logit, p)` correctly returns dH/dlogit = `-logit*p*(1-p)` (trainer.js:440-442). But the call site negates it (`const dH_dKickL = -bernEntGradLogit(kickL, kP)`, line ~330) and then negates again (`dAout[aoff + A_KICK] += -opts.entCoef * dH_dKickL`, line ~334). The net applied gradient is `+entCoef * dH/dlogit`, while the loss `L = ... - entCoef*H` requires `-entCoef * dH/dlogit`. Gradient descent therefore pushes kick/pull logits AWAY from zero — the "entropy bonus" actively penalizes exploration on both Bernoulli heads in the whole 1v1 and 2v2 training pipeline (the continuous-head entropy on logStd at line ~347 is correct, hiding the inconsistency).

**Change:** In `js/rl/trainer.js` `_stepMinibatch`, remove the double negation: replace the four lines around 330-335 with `dAout[aoff + A_KICK] += -opts.entCoef * bernEntGradLogit(kickL, kP); dAout[aoff + A_PULL] += -opts.entCoef * bernEntGradLogit(pullL, pP);` (delete the `dH_dKickL`/`dH_dPullL` temporaries and update the adjacent comment to say the applied term is dL/dlogit for L = -entCoef·H). No other lines change. Training code never runs in the lockstep sim — no determinism/checksum impact; no Swift parity (iOS ships inference only).

**Verify:** Add `test/rl-trainer.test.js` (node:test, `const { PPOTrainer } = require('../js/rl/trainer');`): create `new PPOTrainer({ inDim: 12, hidden: 8 })` with `trainer.opts.entCoef = 1.0`, `trainer.opts.learningRate = 5e-3`, `trainer.opts.epochs = 1`, `trainer.opts.minibatchSize = 512`. Build a batch of N=64 random obs; for each sample run `trainer.policy.forward(obs_i)` and set `actsPre` equal to the continuous means (so the Gaussian log-prob gradient is zero), `returns[i]` equal to the forward value (so the critic gradient is zero), `advs` all 0 (normalizes to 0, so the PPO surrogate gradient is zero), `kicks[i]`/`pulls[i]` anything, `logProbsOld` 0. Record `mean(|kick logit|)` over the 64 obs before and after `await trainer.update(batch)`; assert it strictly decreased (entropy maximization pulls logits toward zero — with the current bug it increases). `npm test` passes.

**Interacts with:** P6-10, P6-11 (same file).

### P6-10 [medium] De-interleave the two agents' trajectories before computing 2v2 GAE
- [ ] `js/rl/trainer.js`, `js/rl/orchestrator2v2.js`, `js/rl/worker2v2.js` — locate: `dones.subarray(0, n), r.nextValue, this.opts.gamma, this.opts.gaeLambda` (orchestrator2v2.js)

`worker2v2.js` records TWO transitions per env step in one flat array — `[red0_t, red1_t, red0_t+1, red1_t+1, ...]` (lines 163-217) with genuinely per-player rewards and values — and `orchestrator2v2.js:225` runs `computeGAE` over that array as one trajectory. The recursion `delta = r[t] + gamma*V[t+1] - V[t]` therefore bootstraps red0's reward with red1's same-timestep value (and vice versa), and the per-real-timestep discount becomes `(gamma*lambda)^2`, halving the credit-assignment horizon. Every 2v2 advantage estimate is systematically biased; the 1v1 pipeline is unaffected.

**Change:**
1. In `js/rl/trainer.js`, next to `computeGAE`, add and export `computeGAEInterleaved(rewards, values, dones, nextValue0, nextValue1, gamma, lam)`: gather the even-index (agent 0) and odd-index (agent 1) subsequences into temporary Float32Arrays/Uint8Arrays, run `computeGAE` on each with its own bootstrap value, and scatter `adv`/`ret` back to the original interleaved indices; return `{ adv, ret }` sized like the input. Add it to the module's `return { PPOTrainer, computeGAE, computeGAEInterleaved }`.
2. In `js/rl/worker2v2.js` `runRollout`, replace the averaged bootstrap with per-agent values: post `nextValue0: fwd0.value, nextValue1: fwd1.value` (drop the old `nextValue` field and its "similar in expectation" comment).
3. In `js/rl/orchestrator2v2.js` `_consolidateAndUpdate`, destructure `computeGAEInterleaved` from `root.RLTrainer` and replace the `computeGAE(...)` call with `computeGAEInterleaved(rewards.subarray(0, n), values.subarray(0, n), dones.subarray(0, n), r.nextValue0, r.nextValue1, this.opts.gamma, this.opts.gaeLambda)`. The concatenated PPO batch stays interleaved — only the temporal recursion changes.

Do NOT change the 1v1 path (`orchestrator.js` records one transition per step). No lockstep/sim/checksum impact; no Swift parity (training is web-only).

**Verify:** In `test/rl-trainer.test.js`: build T=16 real steps → 32 interleaved entries with random rewards/values and a `done` at step 9; compute `computeGAEInterleaved(...)` and independently compute `computeGAE` on the manually de-interleaved even and odd subsequences with their respective bootstrap values; assert the scattered `adv` and `ret` match element-wise within 1e-6. Also assert that for a trajectory where agent 0's rewards are all 0 and agent 1's are all 1, agent 0's advantages are unaffected by agent 1's rewards. `npm test` passes.

**Interacts with:** P6-9, P6-12, P6-13 (same files).

### P6-11 [low] Clip the mean-gradient norm instead of the minibatch-summed norm
- [ ] `js/rl/trainer.js` — locate: `const gnorm = this._globalGradNorm();`

`_globalGradNorm()` (trainer.js:417-423) measures the gradient accumulators, which hold SUMS over the minibatch (`backwardBatch` accumulates over B=512 samples), and clips them against `maxGradNorm = 1.0`. `adamStep` then divides by B (nn.js:111). The effective clip threshold on the mean-gradient norm is therefore ~1/512 ≈ 0.002: virtually every minibatch is rescaled, the clip acts as constant normalization instead of an outlier guard, the partial final minibatch of each epoch adds scale jitter into Adam's m/v statistics, and the reported `gradNorm` stat is a misleading B-dependent sum-norm.

**Change:** In `_stepMinibatch`, compute the mean-based norm: `const gnorm = this._globalGradNorm() / B;` (the subsequent uniform `scale` applied to the sum-accumulators is unchanged in form — scaling sums by `s` scales the means Adam consumes by `s`). Report the mean-based value in the returned stats (`gradNorm: gnorm`). Leave `maxGradNorm: 1.0` as configured — it now has its conventional meaning. Training-only code; no determinism, checksum, or Swift impact.

**Verify:** In `test/rl-trainer.test.js`: create two `PPOTrainer({ inDim: 12, hidden: 8 })` instances A and B and copy weights with `B.policy.loadFrom(A.policy.serialize())`; build one transition (with `returns = value + 1.0` so the critic drives a nonzero gradient, `advs` all 0) duplicated 4 times for A's batch and 8 times for B's batch; run one `update()` each with `epochs = 1` and `minibatchSize = 512` (single minibatch); assert `|statsA.gradNorm - statsB.gradNorm| < 1e-4` (with the bug, B's reported norm is ~2x A's). `npm test` passes.

**Interacts with:** P6-9, P6-10 (same file).

### P6-12 [medium] Complete or abort a training generation when a worker fails instead of stalling forever
- [ ] `js/rl/orchestrator.js`, `js/rl/orchestrator2v2.js` — locate: `this._pendingResults.length === this.workers.length`

`_consolidateAndUpdate` fires only when `_pendingResults.length === this.workers.length` (orchestrator.js:254), and `w.onerror` merely logs a warning (line 89) — a worker that throws (worker.js has no try/catch around `runRollout`) or is killed under memory pressure never reports, so `_gen_inFlight` stays true forever and training silently freezes while the UI shows "Training". Separately, if worker construction failed entirely (`workers.length === 0`), `start()` → `_runGenerationLoop()` sets `_gen_inFlight = true`, dispatches nothing, and hangs immediately. `orchestrator2v2.js` (gate at line 194, log-only onerror at line 61) is identical.

**Change (apply identically to both orchestrators):**
1. Add `this._pendingFailCount = 0;` to the constructor and reset it to 0 at the top of `_runGenerationLoop()` (next to `this._pendingResults = []`).
2. Change the worker error handler to `w.onerror = (e) => { console.warn('[RL worker error]', e.message); this._onWorkerFailure(i); };`.
3. Add `_onWorkerFailure(idx)`: if `!this._gen_inFlight || !this._workerBusy[idx]` return; set `this._workerBusy[idx] = false; this._pendingFailCount++;` then run the shared completion check.
4. Extract the completion check into `_maybeConsolidate()`: `if (this._pendingResults.length + this._pendingFailCount < this.workers.length) return; if (this._pendingResults.length > 0) { this._consolidateAndUpdate(); } else { this._gen_inFlight = false; this.isTraining = false; this._emit({ event: 'error', message: 'all rollout workers failed' }); console.warn('[RL] generation aborted: all workers failed'); }` — consolidating with partial results is fine (`_consolidateAndUpdate` already iterates whatever is in `_pendingResults`; its `totalReward / this.workers.length` average is an acceptable slight underestimate). Call `_maybeConsolidate()` from both the `rolloutResult` branch of `_onWorkerMsg` (replacing the current equality check) and `_onWorkerFailure`.
5. In `start()`, before setting listeners, bail out when there are no workers: `if (this.workers.length === 0) { this.isTraining = false; this._emit({ event: 'error', message: 'no rollout workers available — training cannot run' }); console.warn('[RL] start() aborted: no workers'); return; }` (place after the `isTraining` guard/assignment so the flag ends false).

Training-only code; no determinism, checksum, or Swift impact.

**Verify:** `npm test` unaffected. Manually in the browser console with training running: call `window.rlOrch._onWorkerFailure(0)` right after a generation dispatch and confirm the generation still completes (generation counter advances) using the remaining workers' results; then simulate total failure by calling `_onWorkerFailure(i)` for every worker index on a fresh generation and confirm `isTraining` flips to false and the AI Lab shows the error event rather than hanging. Also run `const o = new RLOrchestrator({ workerCount: 0 }); o.start();` (with worker construction stubbed to fail if needed) and confirm it returns immediately with `o.isTraining === false`.

**Interacts with:** P6-13 (same dispatch/message-handling code — implement P6-12 first, then P6-13 on top).

### P6-13 [low] Broadcast policy weights to workers as transferable Float32Array buffers
- [ ] `js/rl/policy.js`, `js/rl/orchestrator.js`, `js/rl/orchestrator2v2.js`, `js/rl/worker.js`, `js/rl/worker2v2.js` — locate: `policySer: policySer,`

Every generation, `trainer.policy.serialize()` converts ~110k Float32 weights to plain JS number arrays (`Array.from`, nn.js:131), and the same object is structured-cloned by `postMessage` to each of up to 16 workers on the main thread — a periodic multi-megabyte main-thread stall, notable because auto-resume runs training during gameplay (main.js:12-34) and the workers' return path already uses Transferables correctly.

**Change:**
1. In `js/rl/policy.js`, add `serializeFlat()` returning `{ meta: { inDim: this.inDim, hidden: this.hidden }, buf }` where `buf` is one `Float32Array` containing, in fixed order: `l1.W, l1.b, l2.W, l2.b, actor.W, actor.b, critic.W, critic.b, logStd`. Add `loadFromFlat(meta, f32)` that validates `meta.inDim`/`meta.hidden` against the instance and the exact expected total length (return false on mismatch), then `.set()`s each segment into the existing typed arrays via running offsets. Export nothing new (they are Policy methods).
2. In `js/rl/orchestrator.js` `_runGenerationLoop`, replace `const policySer = this.trainer.policy.serialize();` with `const flat = this.trainer.policy.serializeFlat();`, and in the per-worker loop post `{ type: 'rollout', policyMeta: flat.meta, policyFlat: flat.buf.slice().buffer, ... }` with the buffer in the transfer list (`postMessage(msg, [msg.policyFlat])`). Each worker gets its own `.slice()` copy so the transfer is valid. Leave eval/BC/league/save paths on JSON `serialize()`.
3. Same change in `js/rl/orchestrator2v2.js` `_runGenerationLoop`.
4. In `js/rl/worker.js` and `js/rl/worker2v2.js` `runRollout`, build the policy from the flat form when present: `const policy = new Policy(msg.policyMeta.inDim, msg.policyMeta.hidden); policy.loadFromFlat(msg.policyMeta, new Float32Array(msg.policyFlat));` keeping the existing `policySer` path for the `evaluate`/opponent (`oppWeights`) messages, which stay JSON.

Training-only code; no determinism, checksum, or Swift impact.

**Verify:** Add `test/rl-policy.test.js` (node:test): create `Policy(24, 8)`, perturb `logStd`, round-trip `const f = p.serializeFlat(); const p2 = new Policy(24, 8); assert(p2.loadFromFlat(f.meta, f.buf) === true);` then assert `JSON.stringify(p2.serialize()) === JSON.stringify(p.serialize())`; also assert `loadFromFlat` returns false for a wrong-length buffer and for mismatched meta dims. `npm test` passes. Manually: start training in the browser and confirm generations still advance and the checkpoint still saves/loads.

**Interacts with:** P6-12 (same dispatch code), P6-14.

### P6-14 [low] Validate weight-array lengths in Linear.loadFrom
- [ ] `js/rl/nn.js` — locate: `if (obj.inDim !== this.inDim || obj.outDim !== this.outDim) return false;`

`Linear.loadFrom` (nn.js:135-140) checks `inDim`/`outDim` but not `obj.W.length`/`obj.b.length`. `Float32Array.set` with a SHORTER source succeeds silently, leaving the tail of `W` at its random He-initialized values — a truncated or hand-edited model file imported via `loadFromFile` loads "successfully" and produces a subtly broken policy with no error. A LONGER source throws a `RangeError`, escaping the boolean contract that callers like `Policy.loadFrom` and `orchestrator.loadFromFile` expect (the UI then shows a raw RangeError instead of "Architecture mismatch").

**Change:** In `js/rl/nn.js` `Linear.loadFrom`, add before the `set()` calls: `if (!obj.W || obj.W.length !== this.W.length || !obj.b || obj.b.length !== this.b.length) return false;`. No other files change — `Policy.loadFrom` already boolean-chains the per-layer results, so both orchestrators' `loadFromFile` now correctly throw their intended 'Architecture mismatch' error. Training/inference-loading code only; no determinism, checksum, or Swift impact (iOS has its own JSON loader).

**Verify:** Add `test/rl-nn.test.js` (node:test, `const { Linear } = require('../js/rl/nn');`): serialize a `Linear(4, 3)`, then assert (a) `loadFrom` returns false when `W` is truncated by one element, (b) returns false (and does not throw) when `W` has one extra element, (c) returns false when `b` is truncated, (d) returns true and reproduces identical `serialize()` output for an unmodified object. `npm test` passes.

**Interacts with:** P6-3 (corrupt-checkpoint handling), P6-13 (flat loader applies the same length validation).

---

## Package P7 — iOS native parity and robustness
**Goal.** Bring the Swift port back to step-for-step parity with the JS sim (fixed timestep, y-axis, missing mechanics) and remove crash paths.
**When.** Independent of other packages. Requires an Xcode build to verify — flag any item you cannot verify without running the app in the simulator.
**Agent capability.** Basic agent for mechanical items; verify with xcodebuild where possible.
**Package verification.** Run `cd "/Users/matt/Project 1/kickball/ios/App" && xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' build` and confirm it succeeds. Then run `cd "/Users/matt/Project 1/kickball" && npm test` and confirm it stays green, and confirm via `git diff --stat` that NO files under `shared/`, `js/`, or `server/` were modified — every item in this package is Swift-only. Finally do one simulator pass: joystick-up moves the player up, holding KICK slows the player, touching the ball while charging auto-kicks, a tied match enters sudden death, the scoring team is blocked at the center line after a goal, Practice Mode never ends, and Expert 1v1 still uses the RL agent.

**Package-wide determinism guardrail.** All items below change only files under `ios/App/App/` (the standalone single-device Swift port). The JS files cited in each item (`js/game.js`, `shared/ai.js`, `shared/physics.js`, `shared/constants.js`, `js/rl/runtime.js`, `js/controls.js`) are read-only porting references — do NOT edit them. They drive the P2P lockstep simulation, which must stay bit-identical between host and guest; any change there would also require updating `js/game.js` `_computeChecksum` and `_serializeFullState`. No item here adds or removes JS sim-state fields, so `_computeChecksum` and `_serializeFullState` must NOT be touched by this package.

### P7-1 [high] Port the fixed-timestep accumulator into GameEngine.tick
- [ ] `ios/App/App/KickZone/Game/GameEngine.swift` — locate: `let dt = max(0, min(now - lastTickTime, 0.1))`

`GameEngine.tick` runs ONE variable-size physics step per frame with `dtRatio = (dtMs / 16.67) * gameSpeed`, capped only by a 100 ms frame clamp — so a frame hitch produces a single step with dtRatio up to 7.2, letting a fast ball (maxBallSpeed 30) move 216 units in one discrete-collision step and tunnel through posts, goal rails and players. On 120 Hz ProMotion devices every frame runs at dtRatio ≈ 0.6, permanently diverging the nonlinear terms (spin curve, pull damping, homing) from the fixed-60 Hz sim the RL policy was trained on. The JS offline loop it claims to mirror (js/game.js ~514–522) instead accumulates elapsed time and runs whole 16.67 ms sub-steps at constant dtRatio.

**Change:**
1. Add `private var accumulatorMs: Double = 0` to `GameEngine`; reset it to 0 in `startMatch()` and `resume()`.
2. Rewrite `tick(_ now:)`: keep the existing `guard` and the 100 ms dt clamp, delete the `if dt < 0.5 { return }` early-out, then do `accumulatorMs += dt; accumulatorMs = min(accumulatorMs, 16.67 * 8)` and run `var steps = 0; while accumulatorMs >= 16.67 && steps < 5 { accumulatorMs -= 16.67; step(dtMs: 16.67); steps += 1 }` — the 8-tick backlog clamp and 5-step cap mirror the lockstep loop's protection in js/game.js.
3. Leave `step(dtMs:)` computing `dtRatio = CGFloat((dtMs / 16.67) * Double(GameConstants.gameSpeed))` — it now always evaluates to the constant `gameSpeed` (1.2), exactly like `Physics.dtRatio = Physics.GAME_SPEED` in the JS offline loop. Update the "Mirrors js/game.js loop()" comment to describe the accumulator.
This is Swift-only; no JS sim-state fields change, so `js/game.js` `_computeChecksum`/`_serializeFullState` must not be updated.

**Verify:** `cd "/Users/matt/Project 1/kickball/ios/App" && xcodebuild -project App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' build` succeeds. In the simulator, play a Quick Match and confirm game speed is unchanged at 60 fps and that backgrounding/foregrounding the app mid-match does not teleport the ball. Add `assert(dtMs == 16.67)` at the top of `step(dtMs:)` temporarily while testing, then remove it (or keep it as `assert` since it compiles out in Release).

**Interacts with:** P7-5, P7-7 (both restructure the clock/time-scale plumbing inside `step`).

### P7-2 [high] Fix inverted vertical joystick controls
- [ ] `ios/App/App/KickZone/Controls/Joystick.swift` — locate: `let ny = thumb.y / max`

The sim is a port of the JS canvas engine (y-down), the joystick emits SwiftUI drag deltas (also y-down: thumb up gives `ny < 0`), but `GameScene` maps sim coordinates directly into SpriteKit's y-UP scene space with no flip anywhere. Pushing the joystick up therefore moves the player DOWN on screen. The vertically symmetric field masks the mirroring everywhere except the human's controls.

**Change:** In `JoystickView`'s `DragGesture.onChanged`, negate the y component of the emitted vector only: change `onChange(Vec2(nx, ny))` to `onChange(Vec2(nx, -ny))`, leaving the `thumb` visual offset (which is in SwiftUI y-down view space) untouched. Add a comment: SwiftUI drag deltas are y-down while the sim is rendered directly into SpriteKit's y-up scene space, so the y axis is flipped exactly once, here at the input boundary — do NOT add a second flip in `GameScene.swift`. The sim/physics code stays line-for-line comparable to the JS build.

**Verify:** xcodebuild build succeeds. In the simulator, push the joystick straight up: the player moves toward the top of the screen; push down: toward the bottom.

**Interacts with:** none.

### P7-3 [medium] Clear stuck human input when the game pauses (touch-cancellation guard)
- [ ] `ios/App/App/KickZone/Game/GameEngine.swift`, `ios/App/App/KickZone/Controls/Joystick.swift` — locate: `func pause() { isPaused = true }`

All touch controls are SwiftUI `DragGesture`s whose only terminal callback is `.onEnded`. When iOS cancels a touch instead of ending it (incoming call, Control Center / Notification Center edge swipe, app switcher), `.onEnded` is not delivered, so `engine.humanInputDir` keeps its last non-zero value (the player runs in a fixed direction forever) or `engine.humanIsCharging` stays true (the kick charges to full and stays held). The web build guards this exact failure with `touchcancel` handlers in js/controls.js (75–97: "never skip releasing"); the iOS port has no equivalent, and `pause()` clears nothing.

**Change:**
1. Add `func clearHumanInput()` to `GameEngine` that sets `humanInputDir = .zero`, `humanIsCharging = false`, `humanKickRelease = false`, `humanPull = false`, and `humanPlayer?.kickChargeRatio = 0`.
2. Call `clearHumanInput()` from inside `pause()` so every pause path (the HUD X button, the `scenePhase` handler in `ContentView.swift`, and the notification observers added by P7-4) drops stale input. System touch cancellation always coincides with the scene going `.inactive`/`.background`, which already calls `engine.pause()` in `GameView`'s `.onChange(of: scenePhase)`.
Swift-only; no JS sim-state change, so no checksum/serializer updates.

**Verify:** xcodebuild build succeeds. In the simulator, hold the joystick and swipe down Control Center, then dismiss it: the player must stop instead of running forever. Hold KICK, open the app switcher, return: the kick must not still be charging.

**Interacts with:** P7-4 (its observers call `pause()` and inherit the clearing).

### P7-4 [low] Pause/resume the engine from UIKit lifecycle notifications
- [ ] `ios/App/App/KickZone/Game/GameEngine.swift`, `ios/App/App/AppDelegate.swift` — locate: `// App-lifecycle hooks (kept slim — pause the game when backgrounded)`

The app uses the legacy `@UIApplicationMain` lifecycle with a `UIHostingController` and no scene manifest. The only pause path is `GameView`'s `@Environment(\.scenePhase)` handler, and `scenePhase` is unreliable for SwiftUI embedded via `UIHostingController` under the legacy lifecycle. The AppDelegate comment promises pause-on-background but all five hooks are empty. If `scenePhase` never transitions, the match clock silently loses time and a held kick charge keeps accruing wall-clock time (`humanChargeMs` uses `CACurrentMediaTime`).

**Change:**
1. In `GameEngine.init`, `import UIKit` and register two `NotificationCenter.default.addObserver(forName:object:queue: .main)` observers: on `UIApplication.willResignActiveNotification` call `if self.isRunning && !self.isPaused { self.pause() }`; on `UIApplication.didBecomeActiveNotification` call `if self.isRunning && !self.matchOver { self.resume() }`. Store the returned tokens and remove them in `deinit`.
2. Keep the existing `scenePhase` handler in `ContentView.swift` unchanged as a secondary path (`pause()`/`resume()` are idempotent).
3. Update the stale AppDelegate comment above the empty hooks to say background pausing is handled by `GameEngine`'s notification observers.
Because P7-3 makes `pause()` clear human input, the stuck-charge symptom is covered too. Swift-only; no checksum/serializer updates.

**Verify:** xcodebuild build succeeds. In the simulator, press Home mid-match and return: the match resumes without a clock jump; a kick held across the background transition is released, not charged to full.

**Interacts with:** P7-3.

### P7-5 [medium] Port sudden death for tied matches
- [ ] `ios/App/App/KickZone/Game/GameEngine.swift`, `ios/App/App/KickZone/Game/Constants.swift`, `ios/App/App/KickZone/UI/ContentView.swift` — locate: `if timeRemainingMs <= 0 {`

When `timeRemainingMs` hits 0 the Swift engine sets `matchOver = true` unconditionally and the UI shows "DRAW". The JS build (js/game.js 1100–1135) instead enters sudden death on a tie: it resets positions, ramps `Physics.MAX_BALL_SPEED` up by +10 over 30 s (`SUDDEN_DEATH_TIMER: 30000` in shared/constants.js), shows a red counting-up timer, and ends on the first goal or after the 30 s cap. The GameEngine header even lists sudden death as step 10 of the ported pipeline, but no implementation exists.

**Change:**
1. `Constants.swift`: change `static let maxBallSpeed: CGFloat = 30` to `static var maxBallSpeed: CGFloat = 30`, add `static let baseMaxBallSpeed: CGFloat = 30` and `static let suddenDeathTimerMs: Double = 30_000` (port of `SUDDEN_DEATH_TIMER`).
2. `GameEngine`: add `@Published private(set) var suddenDeath = false` and `private var suddenDeathElapsedMs: Double = 0`. In `startMatch()` set both back to false/0 and `GameConstants.maxBallSpeed = GameConstants.baseMaxBallSpeed`.
3. In `step`'s clock block: when `timeRemainingMs <= 0` and `redScore == blueScore`, instead of `matchOver = true` set `suddenDeath = true`, `suddenDeathElapsedMs = 0`, and call `resetForKickoff()`; only set `matchOver = true` when scores differ.
4. When `suddenDeath` is true, skip the normal clock and instead: `suddenDeathElapsedMs += dtMs`; `let shrink = min(suddenDeathElapsedMs / GameConstants.suddenDeathTimerMs, 1)`; `GameConstants.maxBallSpeed = GameConstants.baseMaxBallSpeed + shrink * 10`; set `displaySeconds = Int(ceil(suddenDeathElapsedMs / 1000))` (counts up); if `suddenDeathElapsedMs >= GameConstants.suddenDeathTimerMs` set `matchOver = true`.
5. In the goal-check block: if `suddenDeath` and a goal is scored, set `matchOver = true` (golden goal) after incrementing the score, matching the existing goal-limit pattern.
6. `ContentView.swift` `GameView`: tint the timer text red (`.foregroundColor(engine.suddenDeath ? .red : .white)`).
Swift-only; the `suddenDeath` state exists only in the Swift engine, so `js/game.js` `_computeChecksum`/`_serializeFullState` must NOT be updated.

**Verify:** xcodebuild build succeeds. In the simulator, start a 2-minute match with goal limit "No Limit", keep the score tied until time expires: the timer turns red and counts up, positions reset, the next goal immediately ends the match; with no goal, the match ends as DRAW after 30 s.

**Interacts with:** P7-1 (clock block restructure), P7-13 (practice mode must skip sudden death).

### P7-6 [low] Port the kickoff restriction after goals
- [ ] `ios/App/App/KickZone/Game/GameEngine.swift`, `ios/App/App/KickZone/Game/Physics.swift` — locate: `kickoffTeam = scorer.opposite`

`GameEngine` assigns `kickoffTeam` on every goal, but `kickoffActive` is only ever written false and neither variable is read — the restriction is dead code. In the JS build, `resetAfterGoal` sets `kickoffActive = true` (js/game.js 1830), the restriction blocks the scoring team at the center line and out of the center circle until the conceding team touches the ball (enforcement at 1581–1645, clearing at 1449–1454), so on iOS the scoring team can rush the ball the instant play resumes.

**Change:**
1. `Physics.swift`: make the convenience overload `static func resolveCircleCollision(_ a: Player, _ b: Ball)` return `Bool` with `@discardableResult`, forwarding the inner primitive's return value (P7-7 and P7-10 also consume this).
2. In `step`'s goal-celebration completion branch (where `resetForKickoff()` is called), set `kickoffActive = true` right after the reset — the Swift equivalent of js/game.js 1830. Keep `kickoffActive = false` in `startMatch()`.
3. In the player-ball collision loop, capture `let collided = Physics.resolveCircleCollision(p, ball)` and port js/game.js 1449–1454: `if kickoffActive, p.team == kickoffTeam, (collided || ball.lastKickedBy === p) { kickoffActive = false }`.
4. After the `constrainToField` block, port the barrier from js/game.js 1581–1645 line-for-line: when `kickoffActive` and `kickoffTeam != nil`, compute `scoringTeam = kickoffTeam!.opposite`; for each player on the scoring team, clamp at the center line (red: `if p.pos.x + p.radius > field.centerX { p.pos.x = field.centerX - p.radius; if p.vel.x > 0 { p.vel.x = 0 } }`, blue mirrored) and push them out of the center circle (`minDist = field.centerRadius + p.radius`, reposition along the normal and remove inward velocity via the dot-product projection exactly as the JS does); for the kickoff team, when their center is past the line, contain them within the circle if inside it (clamp distance to `centerRadius - 1`, remove outward velocity) else clamp to the center line — copy the JS branch structure exactly.
5. Leave `kickoffDurationMs` in `Constants.swift` as-is (its JS counterpart `KICKOFF_DURATION` is likewise defined but unused; the restriction clears only on touch).
Swift-only; do not edit js/game.js — its kickoff state is already in the lockstep checksum and must stay untouched.

**Verify:** xcodebuild build succeeds. In the simulator, score a goal, then immediately push toward the opponent half after the reset: your player is walled at the center line and cannot enter the center circle until the opposing team touches the ball, after which movement is free.

**Interacts with:** P7-7 (shares the `collided` capture in the collision loop), P7-10 (feeds the real `kickoffActive` to the RL encoder).

### P7-7 [medium] Port charge slow-down, auto-kick on contact, kick knockback stun, and post-goal slow motion
- [ ] `ios/App/App/KickZone/Game/GameEngine.swift` — locate: `if humanIsCharging {`

Four player-facing mechanics from js/game.js are missing on iOS: (1) charging a kick does not slow the player (JS damps velocity per tick, 1174–1180); (2) a charging player who touches the ball just bounces it instead of auto-kicking (JS 1476–1489); (3) charged kicks never knock back / stun nearby opponents (JS `hitNearbyPlayers`, 1946–1963) — nothing on iOS ever sets `stunMs`, making the existing `stunMs` guards dead code; (4) after a goal the Swift sim hard-freezes while JS keeps simulating at 0.3× slow motion (timeScale set at ~1766–1768). Together these make kicking and scoring feel materially different from the web game.

**Change:**
1. Charge slow-down: in the human-input block, when `humanIsCharging`, after updating `kickChargeRatio` add `let slow = pow(1 - hp.kickChargeRatio * 0.015, dtRatio); hp.vel *= slow`; add `else if !humanKickRelease { hp.kickChargeRatio = 0 }` to mirror the JS else-branch.
2. Add `private func hitNearbyPlayers(kicker: Player, chargeRatio: CGFloat)` porting js/game.js 1946–1963: return if `chargeRatio < 0.25`; `hitRange = kicker.radius + 40`; `knockForce = 1.5 + chargeRatio * 3.5`; for every player of the other team within `hitRange` (distance > 0), add `n * knockForce` to their velocity and set `stunMs = 200 + Double(chargeRatio) * 800` (Player.update already decays `stunMs`, and the input/AI blocks already skip stunned players). Call it immediately before `hp.kick(ball, chargeRatio: charge)` in the `humanKickRelease` branch (JS 1187) and immediately before `p.kick(ball, chargeRatio: intent.chargeRatio)` in the AI-intent branch (JS 1291).
3. Auto-kick on contact: in the collision loop, using `collided` from P7-6, add: `if collided, p === humanPlayer, humanIsCharging { let cr = max(p.kickChargeRatio, 0.1); p.kick(ball, chargeRatio: cr); humanIsCharging = false; humanKickRelease = false; p.kickChargeRatio = 0 }` (port of JS 1476–1489; the JS lockstep skip does not apply — iOS is local play).
4. Post-goal slow motion: add `private var timeScale: Double = 1.0` and `private var slowMoRemainingMs: Double = 0` (reset both in `startMatch()`). In the scoring block set `timeScale = 0.3; slowMoRemainingMs = ball.fireLevel >= 1 ? 1200 : 800` (JS 1766–1768). Restructure the top of `step`: `let rawDt = dtMs`; decrement `slowMoRemainingMs` by `rawDt` and restore `timeScale = 1` when it hits 0; compute the working `dtMs = rawDt * timeScale` and derive `dtRatio` from that; the match clock, sudden-death timer, and `goalCelebrationRemainingMs` use `rawDt`. Replace the goal-celebration early-return freeze with continued (slow-motion) simulation: remove the `return`, and guard `Physics.checkGoal` with `goalCelebrationRemainingMs <= 0` so the ball sitting in the net cannot re-score; `resetForKickoff()` still fires when the celebration expires.
Swift-only; no JS edits, so no lockstep checksum/serializer updates.

**Verify:** xcodebuild build succeeds. In the simulator: holding KICK visibly slows your player proportional to charge; running into the ball while charging kicks it instantly; a full-charge kick next to an opponent knocks them back and briefly stuns them (they stop responding for under a second); after a goal, play continues in slow motion for about a second before positions reset.

**Interacts with:** P7-1 (dt plumbing), P7-5 (rawDt clock), P7-6 (`collided` capture).

### P7-8 [low] Fix super-kick homing to clamp speed and run before ball integration
- [ ] `ios/App/App/KickZone/Game/GameEngine.swift` — locate: `if cur > 0 { ball.vel *= (s / cur) }`

After applying the homing steer, Swift rescales the ball velocity to exactly its pre-steer speed even when the steer reduced it, so iOS super-kicks keep re-boosting and hold speed where the web build lets it bleed (JS uses `Physics.clampSpeed`, which only scales DOWN — js/game.js 1325, shared/physics.js 36–43). The homing also runs at the wrong pipeline position: after `constrainToField` on iOS versus before entity integration in JS (homing at 1305–1330, `p.update`/`ball.update` at 1420–1421), compounding trajectory divergence.

**Change:** Change the rescale to a clamp: `let cur = ball.vel.length; if cur > s { ball.vel *= (s / cur) }`. Move the entire super-kick homing block from its current position (step 7, after field constraints) to immediately before the entity-update loop ("3. Update entities"), matching the JS order. Renumber the step comments in `step()` and the pipeline list in the file header accordingly. Swift-only; no checksum/serializer updates.

**Verify:** xcodebuild build succeeds. In the simulator, a full-charge (super) kick still visibly curves toward the goal; after bouncing off a wall away from the goal, the ball slows rather than maintaining full speed indefinitely.

**Interacts with:** P7-7 (both restructure `step`; apply after it to avoid conflicting edits).

### P7-9 [medium] Restore AI passing (findPassTarget / isLaneClear / getOpenness) in the Swift rule AI
- [ ] `ios/App/App/KickZone/AI/AIController.swift` — locate: `if distToGoal < field.width * 0.55 {`

The Swift port of shared/ai.js dropped the passing logic: `chooseBestTarget` contains an if/else whose two branches return the identical expression (the stub where the pass branch used to be), `decideKick` has no pass-kick branch, and `findPassTarget`/`isLaneClear`/`getOpenness` are absent entirely. In any 2v2/3v3/4v4 match the normal-difficulty AI only dribbles and shoots, never passing — visibly dumber team play than the web version, despite the file header claiming behaviour equivalence.

**Change:**
1. Port `findPassTarget`, `isLaneClear`, and `getOpenness` from shared/ai.js (~385–436) into `AIController` with identical thresholds: pass distance must be in `50 ..< field.width * 0.7`; lane blocked if any opponent's perpendicular distance to the pass line is `< 35` within the segment; openness = `min(nearestOpponentDist / 80, 2.0)`; score = `(field.width - distToGoal) / field.width * 1.5 + openness * 0.8 + (isAhead ? 1.2 : 0)` where `isAhead` means 20 units goal-ward of the ball; return the best teammate only if its score `> 2.0`, else nil.
2. `chooseBestTarget`: add a `teammates: [Player]` parameter; keep the `distToGoal < field.width * 0.55` early return, then `if let pass = findPassTarget(...) { return pass.pos }`, then the goal-spot fallback — this removes the duplicated dead branch.
3. `decideKick`: add a `teammates: [Player]` parameter; after the shoot-at-goal branch, port the pass branch (shared/ai.js 350–357): if `findPassTarget` returns a teammate and `isAimedAt(player:ball:tx:pass.pos.x, ty:pass.pos.y)` and `!wouldKickTowardOwnGoal(...)`, kick with `charge = min(0.15 + dist(player.pos, pass.pos) / (field.width * 2), 0.45)` when `CGFloat.random(in: 0..<1) < accuracy * 0.85`.
4. Thread `teammates` through the two call sites: `playAttack` (add a `teammates` parameter) and the `decideKick` call in `update`.
Keep using `CGFloat.random` as the existing Swift file does (iOS is single-device; do NOT port Swift RNG usage back into shared/ai.js, which uses a lockstep-seeded `_random`). Swift-only; no checksum/serializer updates.

**Verify:** xcodebuild build succeeds. In the simulator, start a 3v3 Normal match and watch the blue team: AI players with an open, goal-ward teammate now kick lateral/forward passes instead of exclusively shooting at goal.

**Interacts with:** P7-10 (both edit `AIController.swift`'s signatures; land this first).

### P7-10 [medium] Feed the RL expert real time/score/kickoff state and attribute ball deflections
- [ ] `ios/App/App/KickZone/AI/RLAgent.swift`, `ios/App/App/KickZone/AI/AIController.swift`, `ios/App/App/KickZone/Game/GameEngine.swift` — locate: `timeLeftMs: 60_000, scoreDiff: 0, kickoffActive: false`

`RLAgent` hardcodes `timeLeftMs: 60_000, scoreDiff: 0, kickoffActive: false` into the observation encoder, so 3 of the 56 features the policy was trained on are permanently wrong on iOS — the expert never sees that it is behind/ahead or that time is running out. The JS runtime deliberately feeds live values (js/rl/runtime.js 55–75). Additionally, iOS only sets `ball.lastKickedBy` inside `Player.kick`, while js/game.js 1465–1468 reassigns it on any significant deflection, so the possession feature (Encoder.swift line 81) has different semantics than in training.

**Change:**
1. In `AIController.swift`, next to `KickIntent`, add `struct MatchContext { let timeLeftMs: Double; let redScore: Int; let blueScore: Int; let kickoffActive: Bool }`.
2. Extend `AgentController.update` with a `context: MatchContext` parameter; `AIController.update` accepts and ignores it; `GameEngine.step` builds one `MatchContext(timeLeftMs: timeRemainingMs, redScore: redScore, blueScore: blueScore, kickoffActive: kickoffActive)` before the AI loop and passes it to every binding.
3. In `RLAgent.update`, replace the hardcoded encoder arguments with `timeLeftMs: context.timeLeftMs`, `scoreDiff: player.team == .red ? context.redScore - context.blueScore : context.blueScore - context.redScore`, `kickoffActive: context.kickoffActive`, mirroring js/rl/runtime.js 63–71. Delete the "Simplified game state" comment.
4. In `GameEngine`'s player-ball collision loop (using `collided` from P7-6), port js/game.js 1465–1468: `if collided, ball.vel.length > 3 { ball.lastKickedBy = p }`.
Swift-only; the encoder feature layout (56 dims) is unchanged, and no JS files are edited, so no lockstep checksum/serializer updates.

**Verify:** xcodebuild build succeeds. In the simulator, an Expert 1v1 match still runs (agent moves, kicks, pulls). Temporarily `print` the encoded `scoreDiff`/`timeLeftMs` for one decision and confirm they track the live score and clock, then remove the print.

**Interacts with:** P7-6 (kickoffActive, `collided`), P7-9 (protocol signature churn in the same file), P7-11 (same `RLAgent.update` body).

### P7-11 [medium] Gate the Expert RL agent to 1v1 and select the nearest opponent
- [ ] `ios/App/App/KickZone/Game/GameEngine.swift`, `ios/App/App/KickZone/AI/RLAgent.swift` — locate: `let opp = opponents.first ?? player`

`makeAI()` returns an `RLAgent` for every AI player whenever difficulty is Expert, and the Settings UI freely combines Expert with team sizes 2–4. The bundled policy is a 1v1 model (the web uses a separate 2v2 encoder for team play and bails when no single opponent exists), so in team matches up to 7 agents run out-of-distribution inference against `opponents.first` — the spawn-order first opponent, not "the closest opponent" as the comment claims — and the `?? player` fallback would encode the agent as its own opponent.

**Change:**
1. In `GameEngine.makeAI()`, only use the expert factory for 1v1: `if settings.difficulty == .expert, settings.teamSize == 1, let agent = expertAgentFactory?() { return agent }`; team matches at Expert fall back to `AIController()`. Add a comment that this matches the web build, which uses a dedicated 2v2 runtime for team play that has not been ported.
2. In `RLAgent.update`, replace `let opp = opponents.first ?? player` with: if `opponents` is empty, return `KickIntent(kick: false, chargeRatio: 0)` without encoding (mirror of js/rl/runtime.js's `if (!opp) return`); otherwise pick the opponent minimizing `dist(player.pos, $0.pos)`, making the code match its own comment.
Swift-only; no checksum/serializer updates.

**Verify:** xcodebuild build succeeds. In the simulator, Expert + 2v2: the AI shows rule-AI behavior (role positioning, passing from P7-9); Expert + 1v1: the RL agent is still used (menu shows "gen 1325 loaded" and the opponent plays with the RL agent's distinctive style).

**Interacts with:** P7-10 (same function body; apply after it).

### P7-12 [low] Validate model shapes in PolicyNet.load and reject malformed weights
- [ ] `ios/App/App/KickZone/AI/NeuralNet.swift` — locate: `let w = wArr.map { ($0 as? NSNumber)?.floatValue ?? 0 }`

`PolicyNet.load` accepts any W/b array lengths and silently coerces non-numeric entries to 0. `LinearLayer.forward` then indexes `w[off + j]`/`x[j]` unchecked and `decodeDeterministic` reads `raw[0...4]`, so a regenerated model with different dims, or a truncated file, loads "successfully" at launch and crashes with index-out-of-range on the first expert decision mid-match (or silently produces garbage actions). The bundled gen-1325 file happens to be consistent today, so this is a latent footgun for the next model drop.

**Change:** In `makeLayer`, throw an `NSError` (domain "RLPolicy", new code) instead of coercing: map elements with `guard let n = $0 as? NSNumber else { throw ... }`, and after mapping verify `w.count == outD * inD` and `b.count == outD`, throwing with a message naming the layer and expected/actual counts. After constructing all four layers, validate the chain before returning: `inDim == RLEncoder.stackedDim` (168), `l1.inDim == inDim`, `l1.outDim == hidden`, `l2.inDim == hidden && l2.outDim == hidden`, `actor.inDim == hidden && actor.outDim == 5`, `critic.inDim == hidden && critic.outDim == 1`; throw on any mismatch. `RLAgentLoader.loadBundledPolicy` already catches, logs, and returns nil, which makes `makeAI()` fall back to `AIController` — no other call-site change needed. Swift-only; no checksum/serializer updates.

**Verify:** xcodebuild build succeeds and the launch log still prints `[RL] loaded bundled model — inDim=168 hidden=256` (the bundled file is valid, so validation must pass it). Negative check: temporarily point `loadBundledPolicy` at a copy of the JSON with one element removed from `l1.W`; the app must log `[RL] failed to load bundled model` and Expert matches must fall back to the rule AI without crashing; revert the temporary change.

**Interacts with:** P7-14 (same loader path).

### P7-13 [low] Make Practice Mode a real settings flag that disables the clock and goal limit
- [ ] `ios/App/App/KickZone/UI/ContentView.swift`, `ios/App/App/KickZone/Game/GameEngine.swift` — locate: `router.settings.durationSeconds = 9999`

Practice Mode is faked as a 9999-second match: the HUD shows a "166:39" countdown, and the session still hard-ends at the leftover goal limit (default 5) or after ~2h46m with a WIN/DRAW overlay. The web build treats `practiceMode` as a first-class flag that skips the match timer entirely (js/game.js 1100: `if (!this.practiceMode)`) and never ends the session. `MatchSettings` has no practice flag, and `AppRouter.practiceMode` is written but never read.

**Change:**
1. Add `var practiceMode: Bool = false` to `MatchSettings` and delete the unused `@Published var practiceMode` from `AppRouter`.
2. In `MainMenuView`: "Quick Match" sets `router.settings.practiceMode = false`; "Practice Mode" sets `router.settings.practiceMode = true` and `router.settings.teamSize = 1`, and no longer touches `durationSeconds`.
3. In `GameEngine.step`, mirror the JS guard: when `settings.practiceMode`, skip the entire match-clock block (no `timeRemainingMs` decrement, no time-up handling, no sudden death from P7-5) and skip the goal-limit `matchOver` check — scores still accumulate, the session only ends via the X button.
4. In `GameView`'s HUD, hide the timer badge when `engine.settings.practiceMode`.
Swift-only; no checksum/serializer updates.

**Verify:** xcodebuild build succeeds. In the simulator, Practice Mode shows no countdown badge, scoring 6+ goals does not end the session, and exiting via X returns to the menu; Quick Match still counts down and ends at the goal limit.

**Interacts with:** P7-5 (sudden death must sit inside the `!practiceMode` guard).

### P7-14 [low] Load the 2.2 MB RL model off the main thread
- [ ] `ios/App/App/KickZone/UI/ContentView.swift` — locate: `let cachedRLPolicy: PolicyNet? = RLAgentLoader.loadBundledPolicy()`

`AppRouter.cachedRLPolicy` is initialized inline when `ContentView`'s `@StateObject` is created, synchronously on the main thread during launch. `PolicyNet.load` parses the 2.2 MB JSON via `JSONSerialization` into `[Any]` and per-element `NSNumber` mapping over ~110k weights, easily adding 100 ms+ before first frame on older devices. The policy is only needed when an Expert match starts.

**Change:** Change the property to `@Published private(set) var cachedRLPolicy: PolicyNet? = nil` and add an `init()` to `AppRouter` that dispatches `RLAgentLoader.loadBundledPolicy()` on `DispatchQueue.global(qos: .userInitiated)` and assigns the result back on `DispatchQueue.main.async` (weak self). The menu's "RL agent: …" label already reads the property and will flip to "gen 1325 loaded" when the publish fires. `GameView.onAppear` already installs the factory only when `cachedRLPolicy` is non-nil; if an Expert match is started before loading finishes, `makeAI()` falls back to `AIController` for that match, which is the accepted trade-off. Swift-only; no checksum/serializer updates.

**Verify:** xcodebuild build succeeds. In the simulator, the menu appears immediately, briefly shows "RL agent: not loaded", then flips to "gen 1325 loaded" within about a second; an Expert 1v1 started afterwards uses the RL agent.

**Interacts with:** P7-12 (same loader), P7-11 (factory installation path).

---

## Refuted during verification — do NOT implement

- **this._dom.timer dereferenced without null guard, violating the class's own documented HUD invariant** (js/game.js) — The unguarded dereferences exist as cited (game.js lines 1113-1114, 1146) and do contradict the constructor's documented invariant (lines 105-107), but the failure is unreachable: #timer is hardcoded in index.html (line 236) and all scripts, including main.js which constructs Game, load at the end o
- **Seeded-RNG consumers fail open to unseeded Math.random() when the rng argument is missing — silent desync instead of loud failure** (shared/ai.js) — The code exists as cited (ai.js:89-91, powerups.js:72), but the failure is not reachable: every lockstep call site passes this.rng (game.js:1287, 1673), and this.rng is unconditionally constructed at game.js:77 (new SeededRNG(12345)), so it can never be undefined; resync (game.js:887) re-seeds rathe
- **Date.now() wall-clock timestamp stored inside shared sim-state power-up objects** (shared/powerups.js) — The cited code exists (spawnTime: Date.now() at shared/powerups.js:86, read only by client-only draw() at line 143), but no failure is reachable: _computeChecksum (js/game.js:757-759) hashes only pu.x/pu.y/pu.type.id, _serializeFullState (line 838) sends only {x,y,t}, and _applyFullState (line 909) 
- **Dimension-mismatched model load only warns, then proceeds to NaN actions via out-of-bounds reads** (js/rl/runtime.js) — The cited warn-only branch exists (runtime.js:39-41, runtime2v2.js:34-38) and OOB reads in Linear.forward (nn.js:60-61) would indeed yield NaN, but the scenario is unreachable end-to-end. The only callers are orchestrator.getRuntimeAgent (orchestrator.js:567-568) and orchestrator2v2.getRuntimeAgents

## Properties to preserve (verified strengths — do not regress these while fixing)

### P2P / Lockstep
- Correct core lockstep discipline: the data channel is explicitly ordered+reliable with a written rationale (p2p.js:327-331), and the engine never fabricates missing inputs on a stall (game.js:571-573) — the right choice for a no-rollback lockstep, with a bounded fixed-timestep accumulator decoupling tick rate from display refresh (120Hz screens can't double-speed the match).
- Solid RNG-seed agreement: the server mints a single matchSeed and echoes the (range-validated) inputDelay in the same match_starting broadcast to every peer, duplicate start_p2p_match is idempotent server-side, and both client entry points guard against double invocation — and this contract is pinned by regression tests.
- Real desync detection and recovery: 60-tick checksums cover essentially every sim-feeding field (positions, velocities, timers, power-ups, AI decision timers, RNG state, isHuman flags), checksums are buffered for future ticks and compared against recorded hashes for past ticks, and mismatches trigger an authoritative full-state resync or an input-replay rollback rather than being ignored.
- Careful determinism hygiene throughout the sim: a shared seeded RNG is threaded into AI decisions and power-up spawns, aiControllers are re-sorted by player index after every mutation to keep RNG consumption order identical, lockstep pins difficulty, disables per-device RL agents, replaces wall-clock goal/match-end timers with tick-scheduled ones, and skips the raw-local-input auto-kick path with an explicit 'instant desync' comment.
- Defense-in-depth transport: every lockstep-critical message (input, confirmed inputs, checksum+state, goal, match end) has a WebSocket relay fallback, with per-peer delivery counting so the relay fires when ANY peer lacks an open channel; TURN fallback is configured for strict NATs; malformed signaling frames are rejected before dispatch; and the host derives each input's player slot from the server-verified peerId mapping, ignoring the client-claimed index (blocks slot spoofing).

### Game loop & rendering
- Proper fixed-timestep architecture with delta clamping: elapsed is capped at 100 ms after tab-restore (game.js:484), the lockstep drain loop bounds both the accumulator backlog (TICK_MS * 8) and steps per frame (< 5), preventing spiral-of-death while keeping 120 Hz displays from running the match at 2x.
- Disciplined lifecycle management: Controls registers every listener through a tracked _on() helper and removes them all in destroy(), which ui.js calls in a single _teardownMatch() path; Game tracks all setTimeouts in _pendingTimers and cancels them in quit(); requestAnimationFrame ids are cancelled before every restart so loops never double up.
- Robust input handling: window blur and visibilitychange clear all keys, kick-charge, and joystick state to prevent stuck input; touchcancel is treated as release on every button; the joystick tracks its specific touch identifier for correct multi-touch; letter keys are normalized to lowercase to avoid CapsLock/Shift stuck-key bugs; passive:false is used only where preventDefault is actually needed.
- Serious rendering-performance discipline: cached background gradient invalidated only on resize/map change, no shadowBlur, batched single-stroke grid, swap-and-pop particle removal, circular-buffer ball trail, and cached DOM refs (this._dom) instead of per-frame getElementById.
- Lockstep correctness mindset in the loop layer: missing inputs are never fabricated (wait + surfaced stall instead of silent divergence), goal celebrations and match end run on the tick clock rather than wall-clock timers, checksums cover RNG state and cooldowns, resync snapshots are full-precision, and result-screen DOM is built without interpolated innerHTML.

### Server
- WebSocket resource bounding at the transport layer: maxPayload of 64 KB rejects oversized frames before buffering, and perMessageDeflate is tuned (windowBits 13, level 1, threshold 64, concurrencyLimit) with comments explaining the per-socket memory math (server.js:45-63).
- The tick driver is a proper fixed-timestep accumulator with a spiral-of-death guard: elapsed time is clamped to 5 ticks and the catch-up loop is step-capped, so a GC pause or overloaded host degrades gracefully instead of freezing the event loop (game-simulation.js:278-295).
- Input handling is defensively written: applyInput coerces and clamps every client-supplied field (NaN/Infinity collapse to 0, charge time capped), and one-shot events (kickRelease, switchPlayer) are OR'd rather than overwritten so they survive until the tick consumes them — with regression tests covering hostile payloads (game-simulation.js:245-264, test/server-simulation.test.js:57-74).
- Cross-room physics isolation is handled deliberately: per-room constants are snapshotted from pristine module defaults and re-applied at the top of every tick so concurrent matches on the shared mutable Physics singleton cannot corrupt each other, and this exact hazard is pinned by dedicated tests (game-simulation.js:15-20, 139-146; test/server-simulation.test.js:27-55).
- Good lifecycle and efficiency hygiene: match-end setTimeouts are tracked in a set and cleared in stop(); room codes are checked for uniqueness across both the classic and P2P registries to prevent join-routing shadowing; broadcasts serialize once per message instead of per recipient; and state snapshots reuse a cached object with quantized fields to cut GC pressure and bandwidth (game-simulation.js:103-104, 297-319, 885-946; room-manager.js:405-417; game-room.js:211-219).

### Determinism
- Randomness in the sim path is centralized behind an injected xorshift32 SeededRNG (AI decisions, power-up type/position), the lockstep match seeds it from a host-minted matchSeed, and the rng state is included in both the 60-tick checksum and the full-state resync snapshot — so rng drift is detectable and recoverable.
- Field geometry is built from fixed per-map virtual dimensions (e.g. 1500x1000 classic) rather than the local canvas; window size only affects camera zoom and render scale, so peers with different screens simulate bit-identical fields.
- The lockstep driver pins the timestep (dtRatio = GAME_SPEED, TICK_MS = 16.67) and moves every match-flow timer onto the tick clock (goal celebration, scheduled match end via _endMatchAtTick), never fabricates missing inputs on stall, and the host quantizes its own input exactly like the wire encoding ((v*100|0)/100) before simulating it — eliminating host/guest input-precision asymmetry.
- Iteration-order discipline is explicit: aiControllers are re-sorted to canonical player-index order after every control swap and resync (with a comment noting rng consumption depends on iteration order), collisions run in fixed i<j order, and confirmed per-tick inputs are applied in the host's serialized order on every peer.
- Local-only effects are consistently fenced out of the deterministic sim: renderer/sound calls never mutate sim state, the auto-kick-on-contact path that reads raw local input is explicitly skipped in lockstep, locally-trained RL agents are disabled in lockstep matches, and the server re-pushes per-room physics constants at the top of every tick so concurrent rooms never read each other's values.

### Security
- Message size is bounded (maxPayload: 64*1024 in server.js:50) so a single oversized/deeply-nested frame is rejected before buffering, and the zlib window is capped to limit per-connection memory.
- Player identity is server-assigned (uuidv4) and never trusted from the client: input is routed by the authenticated playerId, and lockstep peer input is mapped to a player slot via the server-known peerId (ui.js _peerPlayerMap) rather than the client-supplied 'pi' field — so a client cannot spoof another player's input.
- Host-only privileged actions are enforced server-side (start_match at room-manager.js:198, update_settings hostId checks, _relayP2PData requires room.hostId===fromId, _relayP2PInput rejects the host) rather than trusting a client 'isHost' flag.
- Classic-room settings are strictly whitelisted/coerced (game-room.js sanitizeSettings clamps teamSize/duration/goalLimit/map), and start-time occupancy checks prevent two peers mapping onto the same slot.
- User-controlled names are rendered with textContent (ui.js:1041) and score/stats markup is built without innerHTML interpolation (game.js), avoiding DOM-based XSS from lobby/chat-style fields.
- Object spread ({...msg.d, fromId}) is used for relaying rather than Object.assign onto shared objects, and JSON.parse'd payloads are not merged into prototypes, so the code avoids prototype-pollution sinks; production uses wss:// and fly.toml sets force_https.

### Client quality
- XSS-safe DOM construction throughout the UI: player names, room slots, scores, and stats are rendered exclusively via textContent/createElement (ui.js _updateRoomSlots, game.js _renderScoreDuo/_renderMatchStats explicitly commented 'no innerHTML with interpolation'); the only innerHTML uses are constant-string clears.
- Disciplined listener/timer hygiene across match lifecycle: Controls tracks every listener via _on() and destroy() detaches them all plus cancels RAF; UI recreates Controls per match; a single centralized _teardownMatch() is shared by quit/result/disconnect paths and clears intervals, lockstep buffers, toast timers, and restores the pinned P2P difficulty so cleanup paths cannot drift.
- The service worker code itself is well-engineered: precache list exactly mirrors all 23 ?v= cache-busting URLs in index.html (verified entry-by-entry), Promise.allSettled prevents one missing asset from bricking install, versioned cache name with activate-time cleanup, and the fetch handler correctly scopes to same-origin GETs so WebRTC/TURN/CDN traffic is untouched.
- AudioContext lifecycle start is correct for mobile: creation and unlock are deferred to the first user gesture with {once:true} touchstart/click listeners, every sound method degrades gracefully with `if (!this.ctx) return`, noise buffers are built once and reused, and rapid-fire SFX (kick/bounce/wall) are debounced to prevent node storms during physics contact bursts.
- Lockstep-aware UI code shows real determinism care: _packageLockstepInput quantizes local input exactly like the wire encoding so host and guests simulate identical values, aiControllers are re-sorted into player order on both host and client with comments explaining shared-RNG consumption order, and duplicate match_starting invocations are guarded on both paths.

### RL / AI
- RL agents are deliberately excluded from P2P lockstep with an explanatory comment (game.js:182-188): every peer simulates AI slots with the shared scripted controller and seeded RNG, correctly avoiding desyncs from per-device weights and non-deterministic transcendental math.
- The inference core is allocation-conscious and cheap: Policy.forward reuses preallocated scratch buffers (policy.js:53-68), the encoder writes into a caller-owned Float32Array, and decisions are throttled to ~30Hz via a reaction timer that matches the 33.34ms training step — roughly 0.1M MACs per decision, negligible on the main thread.
- Worker rollout results are returned as Transferable ArrayBuffers (worker.js:320-337, worker2v2.js:225-241), training is parallelized across a hardwareConcurrency-sized worker pool, and the PPO update yields to the UI via MessageChannel every 4 minibatches to keep the page responsive.
- Clean train/deploy policy split: stochastic sampling during rollouts (with an explicit comment on why deterministic self-play stalemates), deterministic mean at runtime, and team-mirrored encoding so a single policy plays both sides; the env re-primes frame stacks on every reset and post-goal teleport to prevent cross-episode observation leakage.
- Careful numerics and robustness details throughout: numerically stable sigmoid/softplus, logit-form Bernoulli log-probs, GAE with done-masking and bootstrap value, correct PPO clip subgradients, a multi-tab checkpoint guard that refuses to clobber a newer generation (orchestrator.js:431-441), and a service worker that uses Promise.allSettled so one bad asset cannot brick offline install.

### iOS native
- Physics constants and formulas are a faithful, line-for-line port: gameSpeed/friction/ballFriction/bounces/maxSpeeds/kickForce/playerAccel all match shared/physics.js exactly, and the collision impulse, goal-post blocking, constrain-to-field, and checkGoal logic mirror the JS reference precisely — including subtleties like pow(friction, dtRatio) frame-rate compensation and the kick's post-recoil spin calculation order.
- SwiftUI publishing discipline: the high-frequency clock is deliberately non-@Published with a ~1Hz displaySeconds derived value (GameEngine.swift:41-46), and ControlsOverlay intentionally holds a plain engine reference instead of @ObservedObject so writing inputs never triggers view invalidation — both documented with clear comments.
- Renderer hygiene: GameScene keeps one persistent node per entity repositioned each frame (no per-tick node churn), uses `weak var engine` to avoid a retain cycle, and detects roster replacement after rematch via the identity-keyed node map so player nodes are rebuilt without leaking (GameScene.swift:117-121, 159-166).
- Allocation-conscious RL inference: per-agent reused obs/h1/h2/out scratch buffers, a numerically stable two-branch sigmoid, oldest-first frame stacking matching the JS FrameStack, and a decode path identical to the JS runtime's deterministic mean policy (RLAgent.swift:19-32, NeuralNet.swift:54-81).
- Graceful degradation on model-load failure: a missing bundled model returns nil, the menu surfaces load status, and expert difficulty silently falls back to the rule-based AIController (RLAgentLoader/makeAI); dt is clamped to 100ms in tick() and resume() re-bases lastTickTime, bounding foreground-return time jumps.
