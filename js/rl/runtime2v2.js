// Runtime 2v2 AI agent. Drop-in for AIController on each player of a 2v2 team.
//
// Each player gets ITS OWN RLRuntimeAgent2v2 instance. They all share the
// same underlying policy weights, but each maintains its own frame stack
// (since each player sees a different self-centered observation).
//
// The shared weights are loaded once via `loadSharedFrom(serialized)`; each
// instance then keeps a reference to the shared Policy.
(function(root, factory) {
    const exp = factory(root);
    root.RLRuntimeAgent2v2 = exp;
})(typeof self !== 'undefined' ? self : this, function(root) {

const RLPolicy = root.RLPolicy;
const RLEncoder2v2 = root.RLEncoder2v2;

class RLRuntimeAgent2v2 {
    constructor(sharedPolicy) {
        this.policy = sharedPolicy || null;
        this._obs = new Float32Array(RLEncoder2v2.FEATURE_DIM);
        this._stack = new RLEncoder2v2.FrameStack(RLEncoder2v2.FEATURE_DIM, RLEncoder2v2.STACK_K);
        this._stackPrimed = false;
        this._reactionTimer = 0;
        this._lastAction = { kick: false, chargeRatio: 0 };
        this._lastMove = { x: 0, y: 0 };
        this._lastPull = false;
    }

    // Sets the shared Policy reference for this and any sibling agents.
    static makePolicyFrom(serialized) {
        const p = new RLPolicy.Policy(serialized.inDim, serialized.hidden);
        const ok = p.loadFrom(serialized);
        if (!ok) return null;
        const expectedStacked = RLEncoder2v2.FEATURE_DIM * RLEncoder2v2.STACK_K;
        if (serialized.inDim !== expectedStacked) {
            console.warn('[RL2v2] runtime model inDim=' + serialized.inDim + ' but encoder produces stacked dim=' + expectedStacked);
        }
        return p;
    }

    setSharedPolicy(p) {
        this.policy = p;
        this._stackPrimed = false;
    }

    setDifficulty(_d) { /* compat no-op */ }

    update(player, ball, field, teammates, opponents, dt, _rng) {
        if (!this.policy) return { kick: false, chargeRatio: 0 };
        // Find the teammate (non-self player on same team) and 2 opponents.
        let teammate = null;
        for (const t of teammates) { if (t !== player) { teammate = t; break; } }
        const opps = opponents.slice(0, 2);

        this._reactionTimer -= dt;
        if (this._reactionTimer <= 0) {
            this._reactionTimer = 30;
            const g = root.game;
            const isRed = player.team === 'red';
            const gameState = {
                timeLeft: g ? (g.timeRemaining || 60000) : 60000,
                scoreDiff: g ? ((isRed ? g.redScore : g.blueScore) - (isRed ? g.blueScore : g.redScore)) : 0,
                kickoffActive: g ? !!g.kickoffActive : false,
            };
            const powerUps = (g && g.powerUpManager && g.powerUpManager.powerUps) || [];
            RLEncoder2v2.encode(player, teammate, opps, ball, field, gameState, powerUps, this._obs, false);
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

return RLRuntimeAgent2v2;

});
