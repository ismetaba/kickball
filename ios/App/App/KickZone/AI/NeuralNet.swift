// Pure-Swift neural-network inference for the trained PPO policy.
// We only need the FORWARD pass (no backprop) since training happens on
// the desktop web build; the iOS app just runs inference.
//
// Architecture (matches the JS Policy):
//   trunk: Linear(inDim → H) → ReLU → Linear(H → H) → ReLU
//   actor head:  Linear(H → 5)      mu_mvX, mu_mvY, mu_chg, kick_logit, pull_logit
//   critic head: Linear(H → 1)      value (unused at inference)
//
// Storage matches the JSON the web side downloads — every weight matrix
// is stored row-major (out × in).

import Foundation

struct LinearLayer {
    let inDim: Int
    let outDim: Int
    var w: [Float]   // row-major, length outDim * inDim
    var b: [Float]   // length outDim

    /// y[outDim] = W * x[inDim] + b
    func forward(_ x: [Float], into y: inout [Float]) {
        for i in 0..<outDim {
            var s = b[i]
            let off = i * inDim
            for j in 0..<inDim { s += w[off + j] * x[j] }
            y[i] = s
        }
    }
}

struct PolicyNet {
    let inDim: Int
    let hidden: Int
    let l1: LinearLayer
    let l2: LinearLayer
    let actor: LinearLayer
    let critic: LinearLayer
    let logStd: [Float]   // length 3 (mu_mvX, mu_mvY, mu_chg)

    /// Forward pass returning the actor head outputs (5 values: mu_mvX,
    /// mu_mvY, mu_chg, kick_logit, pull_logit).
    func forward(_ x: [Float]) -> [Float] {
        var h1 = [Float](repeating: 0, count: hidden)
        l1.forward(x, into: &h1)
        for i in 0..<hidden where h1[i] < 0 { h1[i] = 0 }
        var h2 = [Float](repeating: 0, count: hidden)
        l2.forward(h1, into: &h2)
        for i in 0..<hidden where h2[i] < 0 { h2[i] = 0 }
        var out = [Float](repeating: 0, count: actor.outDim)
        actor.forward(h2, into: &out)
        return out
    }

    /// Decode the actor outputs into a deterministic action.
    /// Returns (moveX, moveY, charge, kick, pull) in side-coords (unflipped).
    static func decodeDeterministic(_ raw: [Float]) -> (moveX: Float, moveY: Float, charge: Float, kick: Bool, pull: Bool) {
        let mvX = tanhf(raw[0])
        let mvY = tanhf(raw[1])
        let chg = sigmoidf(raw[2])
        let kP = sigmoidf(raw[3])
        let pP = sigmoidf(raw[4])
        return (mvX, mvY, chg, kP > 0.5, pP > 0.5)
    }
}

@inline(__always)
func sigmoidf(_ x: Float) -> Float {
    if x >= 0 {
        return 1.0 / (1.0 + expf(-x))
    } else {
        let z = expf(x); return z / (1 + z)
    }
}

// MARK: - JSON loader

extension PolicyNet {
    /// Load from the JSON shape produced by the JS Orchestrator's
    /// `serialize()` method. Either:
    ///   { policy: { inDim, hidden, l1: {inDim,outDim,W,b}, l2, actor, critic, logStd }, ... }
    /// (downloaded model file) or just the inner `policy` object.
    static func load(jsonData: Data) throws -> PolicyNet {
        let obj = try JSONSerialization.jsonObject(with: jsonData)
        guard let root = obj as? [String: Any] else {
            throw NSError(domain: "RLPolicy", code: 1, userInfo: [NSLocalizedDescriptionKey: "Top-level JSON is not an object"])
        }
        let policyDict: [String: Any]
        if let inner = root["policy"] as? [String: Any] {
            policyDict = inner
        } else {
            policyDict = root
        }
        guard let inDim = policyDict["inDim"] as? Int,
              let hidden = policyDict["hidden"] as? Int else {
            throw NSError(domain: "RLPolicy", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing inDim or hidden"])
        }
        func makeLayer(_ name: String) throws -> LinearLayer {
            guard let d = policyDict[name] as? [String: Any],
                  let inD = d["inDim"] as? Int,
                  let outD = d["outDim"] as? Int,
                  let wArr = d["W"] as? [Any],
                  let bArr = d["b"] as? [Any] else {
                throw NSError(domain: "RLPolicy", code: 3, userInfo: [NSLocalizedDescriptionKey: "Bad layer \(name)"])
            }
            let w = wArr.map { ($0 as? NSNumber)?.floatValue ?? 0 }
            let b = bArr.map { ($0 as? NSNumber)?.floatValue ?? 0 }
            return LinearLayer(inDim: inD, outDim: outD, w: w, b: b)
        }
        let l1 = try makeLayer("l1")
        let l2 = try makeLayer("l2")
        let actor = try makeLayer("actor")
        let critic = try makeLayer("critic")
        let logStdArr = policyDict["logStd"] as? [Any] ?? []
        let logStd = logStdArr.map { ($0 as? NSNumber)?.floatValue ?? 0 }
        return PolicyNet(inDim: inDim, hidden: hidden, l1: l1, l2: l2,
                          actor: actor, critic: critic, logStd: logStd)
    }
}
