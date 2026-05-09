// PPO trainer for KickZone 1v1.
//
// Pipeline per generation:
//   1. Collect rollouts in parallel workers (or main thread if workers unavail.).
//      Each rollout: T steps × N envs × (red + blue + mirror augmentation) tuples.
//      Opponents sampled per env: 60% self-current, 25% league, 15% scripted.
//   2. Compute advantages with GAE(lambda=0.95, gamma=0.995).
//   3. PPO update: 4 epochs over minibatches, clip ratio 0.2.
//   4. Save best to League if it beats baseline.
//
// All math is hand-rolled. Backprop graph (per minibatch):
//
//   obs   -> l1 -> ReLU h1 -> l2 -> ReLU h2 -> actor head (5)
//                                          \-> critic head (1)
//
//   Actor loss (PPO clip):
//     ratio = exp(logp_new - logp_old)
//     surr1 = ratio * adv
//     surr2 = clip(ratio, 1-eps, 1+eps) * adv
//     L_pi  = -mean(min(surr1, surr2))
//
//   Critic loss:
//     L_v   = 0.5 * mean((V(s) - target)^2)        target = adv + V_old
//
//   Entropy bonus:
//     L_ent = -ent_coef * mean(entropy)
//
//   Total: L_pi + vf_coef * L_v + L_ent
//
// Gradient flow (manual):
//   dL/dActor[5]  -> backward through actor Linear -> dh2_a
//   dL/dCritic[1] -> backward through critic Linear -> dh2_v
//   dh2 = dh2_a + dh2_v
//   ReLU mask, then backward through l2 and l1.
//
//   For the policy gradient we need d(logp)/d(actor_raw):
//     for continuous i in {0,1,2}:
//       d_logp_d_mu = (action_pre[i] - mu) / sigma^2
//     for kick logit:
//       d_logp_d_logit = action - sigmoid(logit)
//     for pull logit: same form.
//
//   For log_std:
//     d_logp_d_logstd[i] = ((action_pre[i] - mu)^2 / sigma^2) - 1
//
// (See PPO paper, Schulman et al. 2017)
(function(root, factory) {
    let RLNN, RLPolicy, RLEncoder;
    if (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports) {
        RLNN = require('./nn');
        RLPolicy = require('./policy');
        RLEncoder = require('./encoder');
    } else {
        RLNN = root.RLNN;
        RLPolicy = root.RLPolicy;
        RLEncoder = root.RLEncoder;
    }
    const exp = factory(RLNN, RLPolicy, RLEncoder);
    if (typeof module !== 'undefined' && module.exports) module.exports = exp;
    else root.RLTrainer = exp;
})(typeof self !== 'undefined' ? self : this, function(RLNN, RLPolicy, RLEncoder) {

const { Policy, sigmoid, N_OUT, N_CONT, A_KICK, A_PULL } = RLPolicy;

const DEFAULTS = {
    inDim: RLEncoder.STACKED_DIM,
    hidden: 256,                  // bumped from 128 for richer spatial reasoning
    rolloutLen: 1024,
    numEnvs: 8,
    epochs: 4,
    minibatchSize: 512,
    clipEps: 0.2,
    vfCoef: 0.5,
    entCoef: 0.005,               // lower since action masking + bigger net make exploration cheaper
    learningRate: 2.5e-4,         // slightly lower for the bigger net's stability
    gamma: 0.995,
    gaeLambda: 0.95,
    maxGradNorm: 1.0,
    weightDecay: 0,
};

// Yield to the event loop so the UI can process clicks/renders. MessageChannel
// is faster and lower-overhead than setTimeout(0) (which has a 4ms minimum in
// browsers); typical yield cost is <0.1ms.
let _yieldChannel = null;
function yieldToUI() {
    return new Promise(resolve => {
        if (typeof MessageChannel === 'undefined') {
            setTimeout(resolve, 0);
            return;
        }
        if (!_yieldChannel) _yieldChannel = new MessageChannel();
        _yieldChannel.port1.onmessage = () => resolve();
        _yieldChannel.port2.postMessage(null);
    });
}

// Compute advantages and returns using GAE. All inputs Float32Array.
//   rewards, values, dones: length T
//   nextValue: bootstrap value
function computeGAE(rewards, values, dones, nextValue, gamma, lam) {
    const T = rewards.length;
    const adv = new Float32Array(T);
    let lastGae = 0;
    for (let t = T - 1; t >= 0; t--) {
        const nv = (t === T - 1) ? nextValue : values[t + 1];
        const nd = (t === T - 1) ? 0 : dones[t + 1];
        const delta = rewards[t] + gamma * nv * (1 - nd) - values[t];
        lastGae = delta + gamma * lam * (1 - nd) * lastGae;
        adv[t] = lastGae;
    }
    const ret = new Float32Array(T);
    for (let t = 0; t < T; t++) ret[t] = adv[t] + values[t];
    return { adv, ret };
}

class PPOTrainer {
    constructor(opts = {}) {
        this.opts = Object.assign({}, DEFAULTS, opts);
        this.policy = new Policy(this.opts.inDim, this.opts.hidden);
        this.t = 0; // global Adam step
        this.generation = 0;
        // Pre-allocated grad buffers
        const H = this.opts.hidden;
        this.gW1 = new Float32Array(H * this.opts.inDim);
        this.gb1 = new Float32Array(H);
        this.gW2 = new Float32Array(H * H);
        this.gb2 = new Float32Array(H);
        this.gWa = new Float32Array(N_OUT * H);
        this.gba = new Float32Array(N_OUT);
        this.gWc = new Float32Array(1 * H);
        this.gbc = new Float32Array(1);
        this.gLogStd = new Float32Array(N_CONT);
    }

    // Update policy from a batch of transitions.
    //   batch: {
    //     obs: Float32Array[N * inDim],
    //     actsPre: Float32Array[N * 3],
    //     kicks: Uint8Array[N],
    //     pulls: Uint8Array[N],
    //     logProbsOld: Float32Array[N],
    //     advs: Float32Array[N],
    //     returns: Float32Array[N],
    //   }
    // Make `update` async + yield to the event loop every few minibatches so
    // the UI stays responsive during training. Each minibatch is ~50-80ms
    // synchronously; yielding every 4 minibatches gives the UI thread ~50ms
    // slices to process clicks, render the chart, etc.
    async update(batch) {
        const opts = this.opts;
        const N = batch.advs.length;
        // Normalize advantages
        let mean = 0;
        for (let i = 0; i < N; i++) mean += batch.advs[i];
        mean /= N;
        let varSum = 0;
        for (let i = 0; i < N; i++) {
            const d = batch.advs[i] - mean;
            varSum += d * d;
        }
        const std = Math.sqrt(varSum / N) + 1e-8;
        for (let i = 0; i < N; i++) batch.advs[i] = (batch.advs[i] - mean) / std;

        const idx = new Int32Array(N);
        for (let i = 0; i < N; i++) idx[i] = i;

        let lastStats = null;
        let mbCount = 0;
        for (let epoch = 0; epoch < opts.epochs; epoch++) {
            for (let i = N - 1; i > 0; i--) {
                const j = (Math.random() * (i + 1)) | 0;
                const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
            }
            for (let start = 0; start < N; start += opts.minibatchSize) {
                const end = Math.min(start + opts.minibatchSize, N);
                lastStats = this._stepMinibatch(batch, idx, start, end);
                mbCount++;
                if (mbCount % 4 === 0) await yieldToUI();
            }
        }
        return lastStats;
    }

    // Lazily acquire pooled per-minibatch buffers sized for capacity B
    _ensureMBBuffers(B) {
        const opts = this.opts;
        const H = opts.hidden;
        const inDim = opts.inDim;
        if (this._mb && this._mb.cap >= B) return this._mb;
        this._mb = {
            cap: B,
            X: new Float32Array(B * inDim),
            H1: new Float32Array(B * H),
            H1mask: new Uint8Array(B * H),
            H2: new Float32Array(B * H),
            H2mask: new Uint8Array(B * H),
            Aout: new Float32Array(B * N_OUT),
            Cout: new Float32Array(B * 1),
            dAout: new Float32Array(B * N_OUT),
            dCout: new Float32Array(B * 1),
            dH2: new Float32Array(B * H),
            dH2c: new Float32Array(B * H),
            dH1: new Float32Array(B * H),
        };
        return this._mb;
    }

    // One PPO update on a minibatch
    _stepMinibatch(batch, idx, start, end) {
        const opts = this.opts;
        const policy = this.policy;
        const H = opts.hidden;
        const inDim = opts.inDim;
        const B = end - start;

        const mb = this._ensureMBBuffers(B);
        const X = mb.X, H1 = mb.H1, H1mask = mb.H1mask;
        const H2 = mb.H2, H2mask = mb.H2mask;
        const Aout = mb.Aout, Cout = mb.Cout;
        // Zero the slices we'll write to (everything gets overwritten in forward
        // pass, but masks need to be reset in case ReLU prunes a different unit).
        for (let i = 0; i < B * H; i++) { H1mask[i] = 0; H2mask[i] = 0; }

        // Gather inputs
        for (let n = 0; n < B; n++) {
            const i = idx[start + n];
            for (let k = 0; k < inDim; k++) X[n * inDim + k] = batch.obs[i * inDim + k];
        }

        // Forward pass
        policy.l1.forwardBatch(X, H1, B);
        for (let i = 0; i < B * H; i++) {
            if (H1[i] > 0) H1mask[i] = 1; else { H1[i] = 0; H1mask[i] = 0; }
        }
        policy.l2.forwardBatch(H1, H2, B);
        for (let i = 0; i < B * H; i++) {
            if (H2[i] > 0) H2mask[i] = 1; else { H2[i] = 0; H2mask[i] = 0; }
        }
        policy.actor.forwardBatch(H2, Aout, B);
        policy.critic.forwardBatch(H2, Cout, B);

        // Compute losses + d/dAout, d/dCout
        const dAout = mb.dAout;
        const dCout = mb.dCout;
        for (let i = 0; i < B * N_OUT; i++) dAout[i] = 0;
        for (let i = 0; i < B; i++) dCout[i] = 0;
        let policyLoss = 0, valueLoss = 0, entropy = 0, klEst = 0;
        const logStd = policy.logStd;
        const sigma = [Math.exp(logStd[0]), Math.exp(logStd[1]), Math.exp(logStd[2])];

        for (let n = 0; n < B; n++) {
            const i = idx[start + n];
            const aoff = n * N_OUT;

            // Compute new logProb under current policy
            let logp = 0;
            for (let k = 0; k < N_CONT; k++) {
                const mu = Aout[aoff + k];
                const a = batch.actsPre[i * N_CONT + k];
                const diff = (a - mu) / sigma[k];
                logp += -0.5 * diff * diff - logStd[k] - 0.918938533;
            }
            const kickL = Aout[aoff + A_KICK];
            const pullL = Aout[aoff + A_PULL];
            const kk = batch.kicks[i];
            const pp = batch.pulls[i];
            logp += -softplus(kk ? -kickL : kickL);
            logp += -softplus(pp ? -pullL : pullL);

            const oldLogp = batch.logProbsOld[i];
            const ratio = Math.exp(logp - oldLogp);
            const adv = batch.advs[i];

            // Clipped surrogate
            const clipped = Math.max(Math.min(ratio, 1 + opts.clipEps), 1 - opts.clipEps);
            const surr1 = ratio * adv;
            const surr2 = clipped * adv;
            const surr = Math.min(surr1, surr2);
            policyLoss += -surr;

            // Gradient of -surr w.r.t. ratio (and indirectly w.r.t. logp)
            //   d(-surr1)/dratio = -adv
            //   if surr1 < surr2 (chose ratio*adv), gradient is -adv
            //   else (chose clipped*adv), gradient w.r.t ratio is 0 *iff* clipped is binding
            let dRatio;
            if (surr1 < surr2) dRatio = -adv;
            else if (ratio > 1 + opts.clipEps || ratio < 1 - opts.clipEps) dRatio = 0;
            else dRatio = -adv;
            // dlogp = dRatio * ratio (since dratio/dlogp = ratio)
            const dlogp = dRatio * ratio;

            // Entropy contribution: H_cont = sum(logStd + const), H_disc = H_bern(p)
            //   ent_coef * entropy is *added* to objective; dL/d(logStd) = -ent_coef * 1
            //   Bernoulli entropy: H(p) = -p log p - (1-p) log(1-p). d/dlogit = (sigmoid(-logit) - sigmoid(logit))/2 ?
            //   Easier: include entropy via direct gradient on logits below.
            const kP = sigmoid(kickL);
            const pP = sigmoid(pullL);
            const entCont = logStd[0] + logStd[1] + logStd[2] + 1.5 * Math.log(2 * Math.PI * Math.E);
            const entDisc = bernEnt(kP) + bernEnt(pP);
            entropy += entCont + entDisc;

            // KL approximation (for monitoring): kl ~ (oldLogp - logp)
            klEst += (oldLogp - logp);

            // Critic loss gradient: 0.5 * (V - return)^2 -> dL/dV = (V - return)
            const v = Cout[n];
            const target = batch.returns[i];
            const td = v - target;
            valueLoss += 0.5 * td * td;
            dCout[n] = opts.vfCoef * td;

            // Backprop into actor outputs
            // Continuous: d_logp/d_mu = (a - mu) / sigma^2
            for (let k = 0; k < N_CONT; k++) {
                const mu = Aout[aoff + k];
                const a = batch.actsPre[i * N_CONT + k];
                const dlogp_dmu = (a - mu) / (sigma[k] * sigma[k]);
                dAout[aoff + k] += dlogp * dlogp_dmu;
            }
            // d_logp/d_logit = (action - p)
            const dlogp_dKickL = (kk - kP);
            const dlogp_dPullL = (pp - pP);
            dAout[aoff + A_KICK] += dlogp * dlogp_dKickL;
            dAout[aoff + A_PULL] += dlogp * dlogp_dPullL;

            // Entropy gradient (we want to MAXIMIZE entropy, so subtract from loss)
            //   dL_total/dlogit_kick (for entropy term -ent_coef * H_kick):
            //   dH_bern/dlogit = -p * log(p/(1-p)) ... compute via difference
            const dH_dKickL = -bernEntGradLogit(kickL, kP);
            const dH_dPullL = -bernEntGradLogit(pullL, pP);
            // Loss = ... - ent_coef * entropy. So dL/dlogit = -ent_coef * dH/dlogit
            // But dH_dKickL above already has the negative sign in the helper; we apply directly:
            dAout[aoff + A_KICK] += -opts.entCoef * dH_dKickL;
            dAout[aoff + A_PULL] += -opts.entCoef * dH_dPullL;
            // Continuous entropy depends only on logStd; handled separately below.

            // Gradient on logStd (continuous entropy + log_prob term)
            //   dlogp/dlogstd[k] = ((a - mu)^2/sigma^2 - 1)
            //   dH_cont/dlogstd[k] = 1
            for (let k = 0; k < N_CONT; k++) {
                const a = batch.actsPre[i * N_CONT + k];
                const mu = Aout[aoff + k];
                const norm = (a - mu) / sigma[k];
                const dlogp_dlogstd = norm * norm - 1;
                this.gLogStd[k] += dlogp * dlogp_dlogstd;
                this.gLogStd[k] += -opts.entCoef * 1.0; // entropy bonus
            }
        }

        // ---- Backward pass through layers ----
        const dH2 = mb.dH2;
        // through actor (Linear): dAout -> dH2_a, accumulates gWa, gba
        policy.actor.backwardBatch(H2, dAout, B, this.gWa, this.gba, dH2);
        // through critic
        const dH2c = mb.dH2c;
        policy.critic.backwardBatch(H2, dCout, B, this.gWc, this.gbc, dH2c);
        for (let i = 0; i < B * H; i++) dH2[i] += dH2c[i];

        // ReLU backward at H2
        for (let i = 0; i < B * H; i++) if (!H2mask[i]) dH2[i] = 0;

        // through l2
        const dH1 = mb.dH1;
        policy.l2.backwardBatch(H1, dH2, B, this.gW2, this.gb2, dH1);
        for (let i = 0; i < B * H; i++) if (!H1mask[i]) dH1[i] = 0;

        // through l1 (no dX needed)
        policy.l1.backwardBatch(X, dH1, B, this.gW1, this.gb1, null);

        // ---- Apply Adam ----
        this.t += 1;
        const lr = opts.learningRate;
        // Gradient clipping (global norm)
        const gnorm = this._globalGradNorm();
        const scale = (gnorm > opts.maxGradNorm) ? (opts.maxGradNorm / (gnorm + 1e-8)) : 1.0;
        if (scale < 1.0) {
            scaleArr(this.gW1, scale); scaleArr(this.gb1, scale);
            scaleArr(this.gW2, scale); scaleArr(this.gb2, scale);
            scaleArr(this.gWa, scale); scaleArr(this.gba, scale);
            scaleArr(this.gWc, scale); scaleArr(this.gbc, scale);
            scaleArr(this.gLogStd, scale);
        }

        policy.l1.adamStep(this.gW1, this.gb1, B, lr, this.t, 0.9, 0.999, 1e-8, opts.weightDecay);
        policy.l2.adamStep(this.gW2, this.gb2, B, lr, this.t, 0.9, 0.999, 1e-8, opts.weightDecay);
        policy.actor.adamStep(this.gWa, this.gba, B, lr, this.t, 0.9, 0.999, 1e-8, opts.weightDecay);
        policy.critic.adamStep(this.gWc, this.gbc, B, lr, this.t, 0.9, 0.999, 1e-8, opts.weightDecay);
        // log_std Adam (treat as parameter)
        for (let k = 0; k < N_CONT; k++) {
            const g = this.gLogStd[k] / B;
            policy.m_logStd[k] = 0.9 * policy.m_logStd[k] + 0.1 * g;
            policy.v_logStd[k] = 0.999 * policy.v_logStd[k] + 0.001 * g * g;
            const mh = policy.m_logStd[k] / (1 - Math.pow(0.9, this.t));
            const vh = policy.v_logStd[k] / (1 - Math.pow(0.999, this.t));
            policy.logStd[k] -= lr * mh / (Math.sqrt(vh) + 1e-8);
            // Clamp log_std to reasonable range
            if (policy.logStd[k] < -2.5) policy.logStd[k] = -2.5;
            if (policy.logStd[k] > 0.5) policy.logStd[k] = 0.5;
        }
        // Reset gradient accumulators
        zero(this.gW1); zero(this.gb1);
        zero(this.gW2); zero(this.gb2);
        zero(this.gWa); zero(this.gba);
        zero(this.gWc); zero(this.gbc);
        zero(this.gLogStd);

        return {
            policyLoss: policyLoss / B,
            valueLoss: valueLoss / B,
            entropy: entropy / B,
            klEst: klEst / B,
            gradNorm: gnorm,
        };
    }

    _globalGradNorm() {
        let s = 0;
        for (const arr of [this.gW1, this.gb1, this.gW2, this.gb2, this.gWa, this.gba, this.gWc, this.gbc, this.gLogStd]) {
            for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
        }
        return Math.sqrt(s);
    }
}

function softplus(x) {
    if (x > 30) return x;
    if (x < -30) return 0;
    return Math.log(1 + Math.exp(x));
}
function bernEnt(p) {
    if (p <= 1e-9 || p >= 1 - 1e-9) return 0;
    return -p * Math.log(p) - (1 - p) * Math.log(1 - p);
}
// dH_bern(p)/d(logit) where p = sigmoid(logit)
//   H = -p*log(p) - (1-p)*log(1-p)
//   dp/dlogit = p(1-p)
//   dH/dp = -log(p) + log(1-p) = log((1-p)/p) = -logit
//   dH/dlogit = -logit * p * (1-p)
function bernEntGradLogit(logit, p) {
    return -logit * p * (1 - p);
}
function scaleArr(a, s) { for (let i = 0; i < a.length; i++) a[i] *= s; }
function zero(a) { for (let i = 0; i < a.length; i++) a[i] = 0; }

// Behavior cloning supervised loss for pretraining the policy from rule-based
// demonstrations. Inputs: obs[N, inDim], acts[N, 5] (moveX, moveY, charge in
// post-squash space; kick, pull as 0/1).
// Loss components:
//   - MSE on (moveX, moveY) tanh-pre-squash (use atanh of clamped target)
//   - MSE on charge sigmoid-pre-squash (use logit of clamped target)
//   - BCE on kick / pull logits
PPOTrainer.prototype.behaviorClone = async function(obs, acts, N, opts = {}) {
    const epochs = opts.epochs || 4;
    const minibatchSize = opts.minibatchSize || 256;
    const lr = opts.lr || 3e-4;
    const policy = this.policy;
    const inDim = this.opts.inDim;
    const H = this.opts.hidden;

    const idx = new Int32Array(N);
    for (let i = 0; i < N; i++) idx[i] = i;

    let lastLoss = 0;
    let lastSteps = 0;
    let mbCount = 0;
    for (let ep = 0; ep < epochs; ep++) {
        for (let i = N - 1; i > 0; i--) {
            const j = (Math.random() * (i + 1)) | 0;
            const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
        }
        for (let start = 0; start < N; start += minibatchSize) {
            const end = Math.min(start + minibatchSize, N);
            const B = end - start;
            const mb = this._ensureMBBuffers(B);
            const X = mb.X, H1 = mb.H1, H1mask = mb.H1mask;
            const H2 = mb.H2, H2mask = mb.H2mask;
            const Aout = mb.Aout;
            // Reset masks
            for (let i = 0; i < B * H; i++) { H1mask[i] = 0; H2mask[i] = 0; }
            // Gather inputs
            for (let n = 0; n < B; n++) {
                const i = idx[start + n];
                for (let k = 0; k < inDim; k++) X[n * inDim + k] = obs[i * inDim + k];
            }
            // Forward
            policy.l1.forwardBatch(X, H1, B);
            for (let i = 0; i < B * H; i++) { if (H1[i] > 0) H1mask[i] = 1; else { H1[i] = 0; H1mask[i] = 0; } }
            policy.l2.forwardBatch(H1, H2, B);
            for (let i = 0; i < B * H; i++) { if (H2[i] > 0) H2mask[i] = 1; else { H2[i] = 0; H2mask[i] = 0; } }
            policy.actor.forwardBatch(H2, Aout, B);

            // Loss + d/dAout
            const dAout = mb.dAout;
            for (let i = 0; i < B * N_OUT; i++) dAout[i] = 0;
            let loss = 0;
            for (let n = 0; n < B; n++) {
                const i = idx[start + n];
                const ao = n * N_OUT;
                const ai = i * 5;
                // Target (post-squash)
                const tgtMx = Math.max(-0.99, Math.min(0.99, acts[ai + 0]));
                const tgtMy = Math.max(-0.99, Math.min(0.99, acts[ai + 1]));
                const tgtChg = Math.max(0.01, Math.min(0.99, acts[ai + 2]));
                const tgtKick = acts[ai + 3] | 0;
                const tgtPull = acts[ai + 4] | 0;
                // Convert targets to pre-squash space
                const tgtMxPre = 0.5 * Math.log((1 + tgtMx) / (1 - tgtMx));     // atanh
                const tgtMyPre = 0.5 * Math.log((1 + tgtMy) / (1 - tgtMy));
                const tgtChgPre = Math.log(tgtChg / (1 - tgtChg));               // logit
                // MSE on continuous pre-squash
                const dx = Aout[ao + 0] - tgtMxPre;
                const dy = Aout[ao + 1] - tgtMyPre;
                const dc = Aout[ao + 2] - tgtChgPre;
                loss += 0.5 * (dx * dx + dy * dy + dc * dc) * 0.05; // scale down
                dAout[ao + 0] = dx * 0.05;
                dAout[ao + 1] = dy * 0.05;
                dAout[ao + 2] = dc * 0.05;
                // BCE on kick logit, upweight positives 20x to fight class imbalance
                // (rule AI kicks ~2% of frames; without weighting BC predicts prior).
                const kL = Aout[ao + 3];
                const kP = sigmoid(kL);
                const kickWeight = tgtKick ? 20 : 1;
                loss += kickWeight * (-tgtKick * Math.log(kP + 1e-9) - (1 - tgtKick) * Math.log(1 - kP + 1e-9));
                dAout[ao + 3] = kickWeight * (kP - tgtKick);
                const pL = Aout[ao + 4];
                const pP = sigmoid(pL);
                loss += -tgtPull * Math.log(pP + 1e-9) - (1 - tgtPull) * Math.log(1 - pP + 1e-9);
                dAout[ao + 4] = pP - tgtPull;
            }

            // Backward
            const dH2 = mb.dH2;
            policy.actor.backwardBatch(H2, dAout, B, this.gWa, this.gba, dH2);
            // No critic gradient in BC
            for (let i = 0; i < B * H; i++) if (!H2mask[i]) dH2[i] = 0;
            const dH1 = mb.dH1;
            policy.l2.backwardBatch(H1, dH2, B, this.gW2, this.gb2, dH1);
            for (let i = 0; i < B * H; i++) if (!H1mask[i]) dH1[i] = 0;
            policy.l1.backwardBatch(X, dH1, B, this.gW1, this.gb1, null);

            // Adam step
            this.t += 1;
            policy.l1.adamStep(this.gW1, this.gb1, B, lr, this.t);
            policy.l2.adamStep(this.gW2, this.gb2, B, lr, this.t);
            policy.actor.adamStep(this.gWa, this.gba, B, lr, this.t);
            // critic untouched
            for (let i = 0; i < this.gW1.length; i++) this.gW1[i] = 0;
            for (let i = 0; i < this.gb1.length; i++) this.gb1[i] = 0;
            for (let i = 0; i < this.gW2.length; i++) this.gW2[i] = 0;
            for (let i = 0; i < this.gb2.length; i++) this.gb2[i] = 0;
            for (let i = 0; i < this.gWa.length; i++) this.gWa[i] = 0;
            for (let i = 0; i < this.gba.length; i++) this.gba[i] = 0;
            lastLoss = loss / B;
            lastSteps += 1;
            mbCount++;
            if (mbCount % 4 === 0) await yieldToUI();
        }
    }
    return { loss: lastLoss, steps: lastSteps };
};

return { PPOTrainer, computeGAE };

});
