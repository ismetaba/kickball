// Minimal MLP library for KickZone RL
// Pure JS, Float32Array, hand-rolled backprop. No dependencies.
//
// Design notes:
//   - Layer = Linear (W: rows x cols, b: rows). Activation applied separately.
//   - All weights are stored row-major in flat Float32Arrays for cache locality.
//   - Backprop is implemented for the specific topology used by the actor-critic
//     trunk (Linear -> ReLU -> Linear -> ReLU -> {Linear actor, Linear critic}).
//   - Adam optimizer state is stored per-parameter.
//
// The intent is *correctness over generality*: we don't need a generic autograd.
(function(root, factory) {
    const exp = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = exp;
    else {
        root.RLNN = exp;
    }
})(typeof self !== 'undefined' ? self : this, function() {

// Standard normal sampler (Box–Muller)
function randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

// He initialization for ReLU
function heInit(rows, cols, out) {
    const std = Math.sqrt(2.0 / cols);
    for (let i = 0; i < out.length; i++) out[i] = randn() * std;
}

// Small uniform init for output layers (so policy starts near zero)
function smallInit(out, scale) {
    for (let i = 0; i < out.length; i++) out[i] = (Math.random() * 2 - 1) * scale;
}

class Linear {
    constructor(inDim, outDim, smallOutput = false) {
        this.inDim = inDim;
        this.outDim = outDim;
        this.W = new Float32Array(outDim * inDim);
        this.b = new Float32Array(outDim);
        if (smallOutput) smallInit(this.W, 0.01);
        else heInit(outDim, inDim, this.W);
        // Adam state
        this.mW = new Float32Array(outDim * inDim);
        this.vW = new Float32Array(outDim * inDim);
        this.mb = new Float32Array(outDim);
        this.vb = new Float32Array(outDim);
    }

    // Forward: y = W x + b. x: [inDim], y: [outDim]
    forward(x, y) {
        const W = this.W, b = this.b, inDim = this.inDim, outDim = this.outDim;
        for (let i = 0; i < outDim; i++) {
            let s = b[i];
            const off = i * inDim;
            for (let j = 0; j < inDim; j++) s += W[off + j] * x[j];
            y[i] = s;
        }
    }

    // Forward batch: X: [B, inDim] flat, Y: [B, outDim] flat
    forwardBatch(X, Y, B) {
        const W = this.W, b = this.b, inDim = this.inDim, outDim = this.outDim;
        for (let n = 0; n < B; n++) {
            const xo = n * inDim;
            const yo = n * outDim;
            for (let i = 0; i < outDim; i++) {
                let s = b[i];
                const woff = i * inDim;
                for (let j = 0; j < inDim; j++) s += W[woff + j] * X[xo + j];
                Y[yo + i] = s;
            }
        }
    }

    // Backward batch: given dY [B,outDim], inputs X [B,inDim]
    //   accumulates gradients into gW, gb, returns dX [B,inDim]
    //   gW shape [outDim, inDim], gb shape [outDim]
    backwardBatch(X, dY, B, gW, gb, dX) {
        const W = this.W, inDim = this.inDim, outDim = this.outDim;
        for (let i = 0; i < gW.length; i++) gW[i] = 0;
        for (let i = 0; i < gb.length; i++) gb[i] = 0;
        if (dX) for (let i = 0; i < B * inDim; i++) dX[i] = 0;

        for (let n = 0; n < B; n++) {
            const xo = n * inDim;
            const yo = n * outDim;
            for (let i = 0; i < outDim; i++) {
                const g = dY[yo + i];
                gb[i] += g;
                const woff = i * inDim;
                for (let j = 0; j < inDim; j++) {
                    gW[woff + j] += g * X[xo + j];
                    if (dX) dX[xo + j] += g * W[woff + j];
                }
            }
        }
    }

    // Adam step. lr: learning rate, t: timestep (1-indexed), beta1, beta2, eps
    adamStep(gW, gb, B, lr, t, beta1 = 0.9, beta2 = 0.999, eps = 1e-8, weightDecay = 0) {
        const W = this.W, b = this.b, mW = this.mW, vW = this.vW, mb = this.mb, vb = this.vb;
        const bc1 = 1 - Math.pow(beta1, t);
        const bc2 = 1 - Math.pow(beta2, t);
        const invB = 1 / B;
        for (let i = 0; i < W.length; i++) {
            const g = gW[i] * invB + weightDecay * W[i];
            mW[i] = beta1 * mW[i] + (1 - beta1) * g;
            vW[i] = beta2 * vW[i] + (1 - beta2) * g * g;
            const mh = mW[i] / bc1;
            const vh = vW[i] / bc2;
            W[i] -= lr * mh / (Math.sqrt(vh) + eps);
        }
        for (let i = 0; i < b.length; i++) {
            const g = gb[i] * invB;
            mb[i] = beta1 * mb[i] + (1 - beta1) * g;
            vb[i] = beta2 * vb[i] + (1 - beta2) * g * g;
            const mh = mb[i] / bc1;
            const vh = vb[i] / bc2;
            b[i] -= lr * mh / (Math.sqrt(vh) + eps);
        }
    }

    serialize() {
        return {
            inDim: this.inDim, outDim: this.outDim,
            W: Array.from(this.W), b: Array.from(this.b)
        };
    }

    loadFrom(obj) {
        if (obj.inDim !== this.inDim || obj.outDim !== this.outDim) return false;
        this.W.set(obj.W);
        this.b.set(obj.b);
        return true;
    }
}

// Element-wise ReLU on a Float32Array slice (in place). Returns mask of activated units.
function reluInPlace(x, len) {
    const mask = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        if (x[i] > 0) mask[i] = 1;
        else x[i] = 0;
    }
    return mask;
}
// Apply ReLU mask to gradient (gradient passes through where mask=1)
function reluBackward(dY, mask, len) {
    for (let i = 0; i < len; i++) {
        if (!mask[i]) dY[i] = 0;
    }
}

return { Linear, randn, reluInPlace, reluBackward, heInit, smallInit };

});
