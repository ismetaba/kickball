// Actor-Critic policy used by the PPO trainer.
//
// Topology:
//   x  -> Linear(in -> H)  -> ReLU -> h1
//   h1 -> Linear(H -> H)   -> ReLU -> h2
//   h2 -> Linear(H -> 5)   -> raw policy logits  (mu_mvX, mu_mvY, mu_chg, kickL, pullL)
//   h2 -> Linear(H -> 1)   -> value
//
// The policy distribution is hybrid:
//   continuous heads (3): Normal(mu = tanh/sigmoid-squashed mean, sigma = exp(log_std))
//   discrete heads   (2): Bernoulli(p = sigmoid(logit))
//
// We learn a single log_std vector for the 3 continuous heads (standard PPO trick).
//
// Backprop is hand-rolled. We compute analytic gradients of:
//   loss = -E[ ratio * adv  -- clipped ] - c1 * value_loss + c2 * entropy
// where ratio = exp(log_pi(a|s) - log_pi_old(a|s)).
//
// All shapes documented inline.
(function(root, factory) {
    const RLNN = (typeof require !== 'undefined') ? require('./nn') : root.RLNN;
    const exp = factory(RLNN);
    if (typeof module !== 'undefined' && module.exports) module.exports = exp;
    else root.RLPolicy = exp;
})(typeof self !== 'undefined' ? self : this, function(RLNN) {

const Linear = RLNN.Linear;

// Output indices on the actor head (5 outputs)
const A_MVX = 0, A_MVY = 1, A_CHG = 2, A_KICK = 3, A_PULL = 4;
const N_CONT = 3; // moveX, moveY, charge
const N_DISC = 2; // kick, pull
const N_OUT = 5;

class Policy {
    constructor(inDim, hidden = 256) {
        this.inDim = inDim;
        this.hidden = hidden;

        this.l1 = new Linear(inDim, hidden);
        this.l2 = new Linear(hidden, hidden);
        this.actor = new Linear(hidden, N_OUT, true); // small init for output
        this.critic = new Linear(hidden, 1, true);

        // log_std for the 3 continuous outputs (initialized to log(0.6) so policy is exploratory at start)
        this.logStd = new Float32Array(N_CONT);
        for (let i = 0; i < N_CONT; i++) this.logStd[i] = Math.log(0.6);
        // Adam state for log_std
        this.m_logStd = new Float32Array(N_CONT);
        this.v_logStd = new Float32Array(N_CONT);

        // Reusable scratch buffers (single-step inference)
        this._h1 = new Float32Array(hidden);
        this._h2 = new Float32Array(hidden);
        this._actor = new Float32Array(N_OUT);
        this._critic = new Float32Array(1);
    }

    // Forward inference: produces raw policy outputs and value.
    //   Returns { raw[N_OUT], value }
    forward(x) {
        this.l1.forward(x, this._h1);
        for (let i = 0; i < this.hidden; i++) if (this._h1[i] < 0) this._h1[i] = 0;
        this.l2.forward(this._h1, this._h2);
        for (let i = 0; i < this.hidden; i++) if (this._h2[i] < 0) this._h2[i] = 0;
        this.actor.forward(this._h2, this._actor);
        this.critic.forward(this._h2, this._critic);
        return { raw: this._actor, value: this._critic[0] };
    }

    // Sample a stochastic action from the policy.
    // Returns:
    //   action: { mvX, mvY, chg, kick, pull }  (post-squash, ready to apply)
    //   logProb: scalar (sum of log probs of the sampled action)
    //   raw: Float32Array(N_OUT) -- raw logits (saved for training)
    //   value: scalar
    sampleAction(x) {
        const { raw, value } = this.forward(x);
        // Continuous: sample from Normal(mu, sigma) BEFORE squashing
        // mu_pre is the raw output. Action_pre = mu + sigma * eps.
        // We then squash: mvX = tanh(action_pre[0]), mvY = tanh(action_pre[1]),
        //                 chg = sigmoid(action_pre[2]).
        // log_prob is computed in the *pre-squash* space.
        const sampledPre = new Float32Array(N_CONT);
        let logProb = 0;
        for (let i = 0; i < N_CONT; i++) {
            const sigma = Math.exp(this.logStd[i]);
            const eps = RLNN.randn();
            const a = raw[i] + sigma * eps;
            sampledPre[i] = a;
            // log N(a; mu=raw[i], sigma) = -0.5*((a-mu)/sigma)^2 - log(sigma) - 0.5*log(2pi)
            logProb += -0.5 * eps * eps - this.logStd[i] - 0.918938533;
        }
        // Discrete: Bernoulli on each
        const kickLogit = raw[A_KICK];
        const pullLogit = raw[A_PULL];
        const kickP = sigmoid(kickLogit);
        const pullP = sigmoid(pullLogit);
        const kick = Math.random() < kickP ? 1 : 0;
        const pull = Math.random() < pullP ? 1 : 0;
        // log Bernoulli(b; p) = b*log(p) + (1-b)*log(1-p)
        // numerically stable form via logits:
        //   log p = -softplus(-logit), log(1-p) = -softplus(logit)
        logProb += -softplus(kick ? -kickLogit : kickLogit);
        logProb += -softplus(pull ? -pullLogit : pullLogit);

        return {
            action: {
                preCont: sampledPre,        // [3] used for training
                kick: kick,
                pull: pull,
                mvX: Math.tanh(sampledPre[0]),
                mvY: Math.tanh(sampledPre[1]),
                chg: sigmoid(sampledPre[2]),
            },
            logProb: logProb,
            value: value,
            // We don't return raw — caller can re-forward at training time.
        };
    }

    // Compute log prob and entropy for a given (state, action) pair using current params.
    // Used inside PPO update to compute the new log_pi.
    //   state: Float32Array(inDim) (already cached features)
    //   actionPre: Float32Array(3)  pre-squash continuous action
    //   kick, pull: 0/1
    // Returns { logProb, entropy, value, raw } -- all current
    evaluate(x, actionPre, kick, pull) {
        const { raw, value } = this.forward(x);
        let logProb = 0;
        let entropy = 0;
        for (let i = 0; i < N_CONT; i++) {
            const sigma = Math.exp(this.logStd[i]);
            const diff = (actionPre[i] - raw[i]) / sigma;
            logProb += -0.5 * diff * diff - this.logStd[i] - 0.918938533;
            entropy += this.logStd[i] + 0.5 * Math.log(2 * Math.PI * Math.E);
        }
        const kickLogit = raw[A_KICK];
        const pullLogit = raw[A_PULL];
        logProb += -softplus(kick ? -kickLogit : kickLogit);
        logProb += -softplus(pull ? -pullLogit : pullLogit);
        // Bernoulli entropy: -p log p - (1-p) log(1-p) using logit form:
        const kickP = sigmoid(kickLogit);
        const pullP = sigmoid(pullLogit);
        entropy += bernoulliEntropy(kickP) + bernoulliEntropy(pullP);
        return { logProb, entropy, value, raw, kickP, pullP };
    }

    // Save / load weights
    serialize() {
        return {
            inDim: this.inDim,
            hidden: this.hidden,
            l1: this.l1.serialize(),
            l2: this.l2.serialize(),
            actor: this.actor.serialize(),
            critic: this.critic.serialize(),
            logStd: Array.from(this.logStd),
        };
    }

    loadFrom(obj) {
        if (obj.inDim !== this.inDim || obj.hidden !== this.hidden) return false;
        return this.l1.loadFrom(obj.l1)
            && this.l2.loadFrom(obj.l2)
            && this.actor.loadFrom(obj.actor)
            && this.critic.loadFrom(obj.critic)
            && (obj.logStd && obj.logStd.length === N_CONT && (this.logStd.set(obj.logStd), true));
    }
}

function softplus(x) {
    if (x > 30) return x;
    if (x < -30) return 0;
    return Math.log(1 + Math.exp(x));
}
function sigmoid(x) {
    if (x >= 0) {
        const z = Math.exp(-x);
        return 1 / (1 + z);
    }
    const z = Math.exp(x);
    return z / (1 + z);
}
function bernoulliEntropy(p) {
    if (p <= 1e-9 || p >= 1 - 1e-9) return 0;
    return -p * Math.log(p) - (1 - p) * Math.log(1 - p);
}

return { Policy, N_OUT, N_CONT, N_DISC, A_KICK, A_PULL, A_MVX, A_MVY, A_CHG, sigmoid, softplus };

});
