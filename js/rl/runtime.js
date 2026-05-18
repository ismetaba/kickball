// Runtime AI agent backed by a trained PPO policy.
//
// Drop-in replacement for `new AIController('expert')` in 1v1 matches.
// Implements the same interface:
//   update(player, ball, field, teammates, opponents, dt, rng)
//     -> { kick, chargeRatio }
//   ALSO calls player.applyInput(...) and player.activatePull() inside.
//
// Always uses the deterministic policy mean (no exploration) for inference.
(function(root, factory) {
    const exp = factory(root);
    root.RLRuntimeAgent = exp;
})(typeof self !== 'undefined' ? self : this, function(root) {

const RLPolicy = root.RLPolicy;
const RLEncoder = root.RLEncoder;

class RLRuntimeAgent {
    constructor() {
        this.policy = null;
        this._obs = new Float32Array(RLEncoder.FEATURE_DIM);
        // Per-runtime frame stack — separate from env stacks because the runtime
        // sees real game state, not env state. We need to push our own frames.
        this._stack = new RLEncoder.FrameStack(RLEncoder.FEATURE_DIM, RLEncoder.STACK_K);
        this._stackPrimed = false;
        this._reactionTimer = 0;
        this._lastAction = { kick: false, chargeRatio: 0 };
        this._lastMove = { x: 0, y: 0 };
        this._lastPull = false;
    }

    loadFrom(serialized) {
        const inDim = serialized.inDim;
        const hidden = serialized.hidden;
        this.policy = new RLPolicy.Policy(inDim, hidden);
        const ok = this.policy.loadFrom(serialized);
        // Verify the loaded model expects the dim we produce after stacking
        const expectedStacked = RLEncoder.FEATURE_DIM * RLEncoder.STACK_K;
        if (inDim !== expectedStacked) {
            console.warn('[RL] runtime model inDim=' + inDim + ' but encoder produces stacked dim=' + expectedStacked + ' — mismatch will produce garbage actions');
        }
        return ok;
    }

    setDifficulty(_d) {
        // Compatibility no-op
    }

    update(player, ball, field, teammates, opponents, dt, _rng) {
        if (!this.policy) {
            // Untrained: stand still, don't kick
            return { kick: false, chargeRatio: 0 };
        }

        const opp = opponents[0]; // 1v1 only
        if (!opp) return { kick: false, chargeRatio: 0 };

        // Reaction tick: re-evaluate the policy at ~30Hz (every other physics frame)
        // to mimic human reaction and save compute.
        this._reactionTimer -= dt;
        if (this._reactionTimer <= 0) {
            this._reactionTimer = 30; // ms
            // Pull live game state when available so the agent's "time/score/kickoff"
            // features match what it saw during training.
            const g = root.game;
            const isRed = player.team === 'red';
            const gameState = {
                timeLeft: g ? (g.timeRemaining || 60000) : 60000,
                scoreDiff: g ? ((isRed ? g.redScore : g.blueScore) - (isRed ? g.blueScore : g.redScore)) : 0,
                kickoffActive: g ? !!g.kickoffActive : false,
            };
            const powerUps = (g && g.powerUpManager && g.powerUpManager.powerUps) || [];
            RLEncoder.encode(player, opp, ball, field, gameState, powerUps, this._obs, false);
            // First call after match start: prime the stack with the current
            // frame in all K slots to avoid junk history.
            if (!this._stackPrimed) {
                this._stack.fill(this._obs);
                this._stackPrimed = true;
            } else {
                this._stack.push(this._obs);
            }
            const { raw } = this.policy.forward(this._stack.get());
            const mvX = Math.tanh(raw[0]);
            const mvY = Math.tanh(raw[1]);
            const chg = sigmoid(raw[2]);
            const kP = sigmoid(raw[3]);
            const pP = sigmoid(raw[4]);
            this._lastMove.x = isRed ? mvX : -mvX;
            this._lastMove.y = mvY;
            this._lastAction.kick = kP > 0.5;
            this._lastAction.chargeRatio = Math.min(chg, 1.0);
            this._lastPull = pP > 0.5;
        }

        // Apply movement (every physics tick — smoother)
        const mx = this._lastMove.x;
        const my = this._lastMove.y;
        const len = Math.sqrt(mx * mx + my * my);
        if (len > 1e-3) {
            player.applyInput(mx / Math.max(len, 1), my / Math.max(len, 1));
        }
        if (this._lastPull) player.activatePull();

        return { kick: this._lastAction.kick, chargeRatio: this._lastAction.chargeRatio };
    }
}

function sigmoid(x) {
    if (x >= 0) {
        const z = Math.exp(-x);
        return 1 / (1 + z);
    }
    const z = Math.exp(x);
    return z / (1 + z);
}

return RLRuntimeAgent;

});
