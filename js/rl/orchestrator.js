// RL training orchestrator (main thread).
//
// Owns the policy parameters and Adam state. Dispatches rollouts to workers,
// receives transitions, computes GAE, runs PPO updates, manages the League
// and curriculum, and reports progress to the UI.
//
// Public API:
//   const orch = new RLOrchestrator(opts);
//   orch.onProgress = (info) => ...;
//   orch.start();
//   orch.stop();
//   orch.getRuntimeAgent() -> RLRuntimeAgent (drop-in replacement for AIController)
(function(root, factory) {
    const exp = factory(root);
    root.RLOrchestrator = exp;
})(typeof self !== 'undefined' ? self : this, function(root) {

const { PPOTrainer, computeGAE } = root.RLTrainer;
const { Policy } = root.RLPolicy;
const { League } = root.RLLeague;
const RLEncoder = root.RLEncoder;

// Storage key for the 1v1 model. We use a 1v1-prefixed key so the 2v2
// orchestrator can use a separate one without collision. On first read we
// also fall back to the legacy unprefixed key so existing checkpoints
// migrate transparently.
const STORAGE_KEY = 'kickzone-rl-1v1-v1';
const LEGACY_STORAGE_KEY = 'kickzone-rl-v1';
const ACTIVE_KEY = 'kickzone-rl-1v1-active';
const PHASE_KEY = 'kickzone-rl-1v1-phase';
const LEGACY_ACTIVE_KEY = 'kickzone-rl-active';
const LEGACY_PHASE_KEY = 'kickzone-rl-phase';

class RLOrchestrator {
    constructor(opts = {}) {
        this.opts = Object.assign({
            inDim: RLEncoder.STACKED_DIM,
            hidden: 256,
            // Use up to 16 workers but cap at the machine's logical core count.
            // Past ~physical-core-count there's diminishing return because of
            // hyperthreading + shared L1/L2 cache + the synchronous PPO update
            // step (Amdahl's law: more workers means more idle time during update).
            workerCount: Math.min(navigator.hardwareConcurrency || 4, 16),
            rolloutLen: 1024,            // T per worker
            evalEvery: 20,              // generations between eval probes
            gamma: 0.995,
            gaeLambda: 0.95,
            // Mirror augmentation is OFF: it would need an extra policy forward
            // pass per step to compute the correct logProb/value on the mirrored
            // observation. Without it the PPO ratio for mirrored entries is
            // biased and pushes the gradient in the wrong direction on half the
            // data. Sticking with a strict, correct rollout.
            mirrorAugment: false,
            opponentMix: { self: 0.40, league: 0.25, chaser: 0.10, defender: 0.10, rule: 0.10, random: 0.05 },
            curriculumGens: 150,
            leagueAddEvery: 25,
            phase: 1,
            saveEvery: 2,         // checkpoint every 2 gens (was 10) so refresh loses ≤1 gen
        }, opts);

        this.trainer = new PPOTrainer({
            inDim: this.opts.inDim,
            hidden: this.opts.hidden,
            rolloutLen: this.opts.rolloutLen,
        });
        this.league = new League(10);
        this.generation = 0;
        this.bestEloProxy = 0;          // crude proxy: avg goals diff vs scripted bots
        this.lastStats = null;
        this.totalSteps = 0;
        this.isTraining = false;
        this.onProgress = null;

        this.workers = [];
        this._workerBusy = [];
        this._pendingResults = [];
        this._gen_inFlight = false;
        this._lastEvalScore = null;
        this._evalTask = null;
        this._initWorkers();
        this._tryLoad();
    }

    _initWorkers() {
        for (let i = 0; i < this.opts.workerCount; i++) {
            try {
                const w = new Worker('js/rl/worker.js');
                w.onmessage = (e) => this._onWorkerMsg(i, e.data);
                w.onerror = (e) => console.warn('[RL worker error]', e.message);
                this.workers.push(w);
                this._workerBusy.push(false);
            } catch (e) {
                console.warn('[RL] failed to init worker', i, e);
            }
        }
        if (this.workers.length === 0) {
            console.warn('[RL] no workers available; training will be slow');
        } else {
            console.log('[RL] initialized', this.workers.length, 'workers');
        }
    }

    start() {
        if (this.isTraining) return;
        this.isTraining = true;
        // Persist "training is active" flag so we auto-resume on page reload.
        try {
            localStorage.setItem(ACTIVE_KEY, 'true');
            localStorage.setItem(PHASE_KEY, String(this.opts.phase || 1));
        } catch(e) {}
        // Warn if the tab is hidden — browsers throttle workers heavily there.
        if (typeof document !== 'undefined' && document.hidden) {
            console.warn('[RL] training started while tab is hidden — keep this tab in the foreground for full speed.');
        }
        // Final save when the tab is about to close (browser-supported best-effort)
        if (!this._pageHideListener) {
            this._pageHideListener = () => { try { this._save(); } catch(e) {} };
            window.addEventListener('pagehide', this._pageHideListener);
        }
        // One-time visibility listener with throttling (60s minimum interval
        // between warnings) so we don't spam the console if visibilitychange
        // fires repeatedly in some environments.
        if (!this._visListener) {
            this._lastVisWarnAt = 0;
            this._visListener = () => {
                if (!this.isTraining || !document.hidden) return;
                const now = performance.now();
                if (now - this._lastVisWarnAt < 60000) return;
                this._lastVisWarnAt = now;
                console.warn('[RL] tab backgrounded — training will slow down significantly until you switch back.');
            };
            document.addEventListener('visibilitychange', this._visListener);
        }
        this._runGenerationLoop();
    }

    stop() {
        this.isTraining = false;
        // Persist a final checkpoint and clear the auto-resume flag
        try {
            this._save();
            localStorage.removeItem(ACTIVE_KEY);
        } catch(e) {}
    }

    reset() {
        this.stop();
        this.trainer = new PPOTrainer({ inDim: this.opts.inDim, hidden: this.opts.hidden, rolloutLen: this.opts.rolloutLen });
        this.league = new League(10);
        this.generation = 0;
        this.bestEloProxy = 0;
        this.totalSteps = 0;
        this.lastStats = null;
        this._lastEvalScore = null;
        try {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(LEGACY_STORAGE_KEY);
            localStorage.removeItem(ACTIVE_KEY);
            localStorage.removeItem(PHASE_KEY);
            localStorage.removeItem(LEGACY_ACTIVE_KEY);
            localStorage.removeItem(LEGACY_PHASE_KEY);
        } catch(e) {}
        this._emit({ event: 'reset' });
    }

    _emit(info) {
        if (this.onProgress) this.onProgress({
            generation: this.generation,
            totalSteps: this.totalSteps,
            stats: this.lastStats,
            evalScore: this._lastEvalScore,
            league: this.league.size(),
            isTraining: this.isTraining,
            ...info,
        });
    }

    // Pick an opponent type for one rollout, weighted by opponentMix and curriculum
    _sampleOpponent() {
        const gen = this.generation;
        const curric = this.opts.curriculumGens;
        let mix;
        if (gen < curric / 2) {
            mix = { self: 0.0, league: 0.0, chaser: 0.4, defender: 0.2, rule: 0.2, random: 0.2 };
        } else if (gen < curric) {
            mix = { self: 0.15, league: 0.0, chaser: 0.25, defender: 0.2, rule: 0.25, random: 0.15 };
        } else {
            mix = this.opts.opponentMix;
        }
        // Disable league sampling when empty
        if (this.league.size() === 0) {
            mix = { ...mix };
            mix.self = (mix.self || 0) + (mix.league || 0);
            mix.league = 0;
        }
        const r = Math.random();
        let acc = 0;
        for (const k of Object.keys(mix)) {
            acc += mix[k];
            if (r <= acc) return k;
        }
        return 'self';
    }

    // Build env options from current phase setting
    envOptsForPhase() {
        const phase = this.opts.phase || 1;
        const base = { map: 'classic', powerUps: false, maxSteps: this.opts.rolloutLen };
        if (phase === 1) {
            // Phase 1: pure soccer fundamentals — no abusable mechanics
            return { ...base, disableSuperKick: true, disableKickPlayer: true, disablePull: true,
                superKickAbusePenalty: 0, kickPlayerAbusePenalty: 0 };
        }
        if (phase === 2) {
            // Phase 2: enable kick-player and pull but still no super-kick
            return { ...base, disableSuperKick: true, disableKickPlayer: false, disablePull: false,
                kickPlayerAbusePenalty: 0.03 };
        }
        // Phase 3: full game with abuse penalty
        return { ...base, disableSuperKick: false, disableKickPlayer: false, disablePull: false,
            superKickAbusePenalty: 0.05, kickPlayerAbusePenalty: 0.03, powerUps: false };
    }

    _runGenerationLoop() {
        if (!this.isTraining) return;
        if (this._gen_inFlight) return;
        this._gen_inFlight = true;

        const policySer = this.trainer.policy.serialize();
        const envOpts = this.envOptsForPhase();
        this._pendingResults = [];
        for (let i = 0; i < this.workers.length; i++) {
            const oppType = this._sampleOpponent();
            const agentSide = (Math.random() < 0.5) ? 'red' : 'blue';
            const oppWeights = (oppType === 'league') ? this.league.sample().weights : null;
            this._workerBusy[i] = true;
            this.workers[i].postMessage({
                type: 'rollout',
                policySer: policySer,
                oppType: oppType,
                oppWeights: oppWeights,
                T: this.opts.rolloutLen,
                envOpts,
                agentSide,
                augmentMirror: this.opts.mirrorAugment,
            });
        }
    }

    _onWorkerMsg(idx, data) {
        if (data.type === 'rolloutResult') {
            this._workerBusy[idx] = false;
            this._pendingResults.push(data);
            if (this._pendingResults.length === this.workers.length) {
                this._consolidateAndUpdate();
            }
        } else if (data.type === 'evaluationResult') {
            this._evalTask = null;
            if (this._evalWorkerIdx !== undefined) {
                this._workerBusy[this._evalWorkerIdx] = false;
                this._evalWorkerIdx = undefined;
            }
            const score = (data.agentGoals - data.oppGoals);
            this._lastEvalScore = { vs: data.oppType, agentGoals: data.agentGoals, oppGoals: data.oppGoals, diff: score };
            // Push to a small history for the UI line chart
            if (!this._evalHistory) this._evalHistory = [];
            this._evalHistory.push({ gen: this.generation, diff: score });
            if (this._evalHistory.length > 200) this._evalHistory.shift();
            this._emit({ event: 'eval' });
        }
    }

    async _consolidateAndUpdate() {
        // Merge per-worker rollouts into one big batch.
        // Compute GAE per rollout, then concatenate.
        const allObs = [], allActsPre = [], allKicks = [], allPulls = [];
        const allLogProbs = [], allAdvs = [], allReturns = [];
        let totalGoalsA = 0, totalGoalsO = 0, totalReward = 0;
        for (const r of this._pendingResults) {
            const obs = new Float32Array(r.obs);
            const actsPre = new Float32Array(r.actsPre);
            const kicks = new Uint8Array(r.kicks);
            const pulls = new Uint8Array(r.pulls);
            const logProbs = new Float32Array(r.logProbs);
            const values = new Float32Array(r.values);
            const rewards = new Float32Array(r.rewards);
            const dones = new Uint8Array(r.dones);
            const n = r.n;
            // Use only the first n entries
            // Compute GAE per rollout (treating each rollout as one trajectory)
            // For mirror-augmented batch, even/odd indices are paired (orig, mirror).
            // We only need GAE over the *original* timeline, but since reward/dones
            // are duplicated for both copies, we can compute GAE on copies separately
            // and the result is the same — easier to just compute on the whole sequence
            // because mirror entries have identical dynamics.
            // For correctness we compute GAE on the whole array (rewards/dones already
            // duplicated). It's slightly biased because consecutive frames in the array
            // are (t, t-mirror) but values at t and t-mirror should be ~identical since
            // the policy is symmetric in expectation.
            const { adv, ret } = computeGAE(rewards.subarray(0, n), values.subarray(0, n), dones.subarray(0, n), r.nextValue, this.opts.gamma, this.opts.gaeLambda);
            allObs.push({ data: obs, n });
            allActsPre.push({ data: actsPre, n });
            allKicks.push({ data: kicks, n });
            allPulls.push({ data: pulls, n });
            allLogProbs.push({ data: logProbs, n });
            allAdvs.push(adv);
            allReturns.push(ret);
            totalGoalsA += r.goalsAgent;
            totalGoalsO += r.goalsOpp;
            totalReward += r.totalReward;
        }
        // Concatenate
        let total = 0;
        for (const a of allAdvs) total += a.length;
        const inDim = this.opts.inDim;
        const obs = new Float32Array(total * inDim);
        const actsPre = new Float32Array(total * 3);
        const kicks = new Uint8Array(total);
        const pulls = new Uint8Array(total);
        const logProbs = new Float32Array(total);
        const advs = new Float32Array(total);
        const returns = new Float32Array(total);
        let off = 0;
        for (let i = 0; i < allAdvs.length; i++) {
            const n = allAdvs[i].length;
            obs.set(allObs[i].data.subarray(0, n * inDim), off * inDim);
            actsPre.set(allActsPre[i].data.subarray(0, n * 3), off * 3);
            kicks.set(allKicks[i].data.subarray(0, n), off);
            pulls.set(allPulls[i].data.subarray(0, n), off);
            logProbs.set(allLogProbs[i].data.subarray(0, n), off);
            advs.set(allAdvs[i], off);
            returns.set(allReturns[i], off);
            off += n;
        }

        // PPO update — async (yields every 4 minibatches so UI stays
        // responsive). Pipelining (dispatching next rollout BEFORE the update)
        // was tried but causes a race: workers can return mid-update and
        // trigger a concurrent _consolidateAndUpdate, corrupting policy
        // weights. We now serialize: collect → update → dispatch next.
        const stats = await this.trainer.update({
            obs, actsPre, kicks, pulls, logProbsOld: logProbs, advs, returns,
        });
        this.lastStats = {
            ...stats,
            totalReward: totalReward / Math.max(this.workers.length, 1),
            goalsFor: totalGoalsA,
            goalsAgainst: totalGoalsO,
            transitions: total,
        };

        this.totalSteps += total;
        this.generation++;

        // Update league periodically
        if (this.generation % this.opts.leagueAddEvery === 0) {
            this.league.add(this.trainer.policy.serialize(), this.generation, totalGoalsA - totalGoalsO);
        }

        if (this.generation % this.opts.saveEvery === 0) this._save();
        if (this.generation % this.opts.evalEvery === 0) this._dispatchEvaluation();

        this._emit({ event: 'update' });

        // Reset gate flags + dispatch next generation now that update is done
        this._gen_inFlight = false;
        this._pendingResults = [];
        if (this.isTraining) this._runGenerationLoop();
    }

    _dispatchEvaluation() {
        if (this._evalTask) return;
        if (this.workers.length === 0) return;
        // Free a worker for eval
        // Wait until all workers idle; if a generation is in flight, skip this eval.
        const idle = this._workerBusy.findIndex(b => !b);
        if (idle < 0) return;
        this._evalTask = 'rule';
        this._workerBusy[idle] = true;
        this._evalWorkerIdx = idle;
        this.workers[idle].postMessage({
            type: 'evaluate',
            policySer: this.trainer.policy.serialize(),
            oppType: 'chaser',
            episodes: 2,
            envOpts: { map: 'classic', powerUps: false, maxSteps: 1200 },
        });
    }

    // Public: run a focused eval against a scripted opponent and resolve a goal-diff
    runEvaluation(oppType = 'chaser', episodes = 4) {
        return new Promise((resolve, reject) => {
            const idle = this._workerBusy.findIndex(b => !b);
            if (idle < 0) { reject(new Error('all workers busy')); return; }
            const worker = this.workers[idle];
            this._workerBusy[idle] = true;
            const original = worker.onmessage;
            const handler = (e) => {
                if (e.data.type === 'evaluationResult') {
                    worker.onmessage = original;
                    this._workerBusy[idle] = false;
                    resolve({
                        oppType: e.data.oppType,
                        episodes: e.data.episodes,
                        agentGoals: e.data.agentGoals,
                        oppGoals: e.data.oppGoals,
                        diff: e.data.agentGoals - e.data.oppGoals,
                    });
                } else {
                    original(e);
                }
            };
            worker.onmessage = handler;
            worker.postMessage({
                type: 'evaluate',
                policySer: this.trainer.policy.serialize(),
                oppType,
                episodes,
                envOpts: { map: 'classic', powerUps: false, maxSteps: 1800 },
            });
        });
    }

    _save() {
        try {
            // Multi-tab safety: never overwrite a newer checkpoint with an
            // older one. If two tabs are open and a stale tab calls _save(),
            // we'd otherwise clobber the active tab's hard-earned progress.
            // We compare *generation* numbers — only write if ours is ≥ what's
            // already on disk.
            const existingRaw = localStorage.getItem(STORAGE_KEY);
            if (existingRaw) {
                try {
                    const existing = JSON.parse(existingRaw);
                    const existingGen = existing.generation || 0;
                    if (existingGen > this.generation) {
                        console.warn('[RL] _save() refused: localStorage has gen ' + existingGen + ' but this orchestrator is at gen ' + this.generation + '. A different tab is more advanced.');
                        return;
                    }
                } catch(e) { /* stored data corrupt — proceed to overwrite */ }
            }
            const obj = {
                policy: this.trainer.policy.serialize(),
                generation: this.generation,
                totalSteps: this.totalSteps,
                league: this.league.serialize(),
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
        } catch(e) { /* storage full */ }
    }

    _tryLoad() {
        try {
            // Prefer the new prefixed key; fall back to legacy unprefixed key
            // for backward compatibility (one-time auto-migration).
            let raw = localStorage.getItem(STORAGE_KEY);
            let migratedFromLegacy = false;
            if (!raw) {
                raw = localStorage.getItem(LEGACY_STORAGE_KEY);
                if (raw) migratedFromLegacy = true;
            }
            if (!raw) return false;
            const obj = JSON.parse(raw);
            if (!obj.policy) return false;
            const p = new Policy(this.opts.inDim, this.opts.hidden);
            if (!p.loadFrom(obj.policy)) return false;
            this.trainer.policy = p;
            this.generation = obj.generation || 0;
            this.totalSteps = obj.totalSteps || 0;
            if (obj.league) this.league.loadFrom(obj.league);
            console.log('[RL] loaded checkpoint, generation', this.generation, migratedFromLegacy ? '(migrated from legacy key)' : '');
            // Migrate legacy data into the new key on the next save
            if (migratedFromLegacy) {
                this._save();
                try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch(e) {}
            }
            return true;
        } catch(e) {
            return false;
        }
    }

    saveAs(filename = 'kickzone-rl-model.json') {
        const obj = {
            policy: this.trainer.policy.serialize(),
            generation: this.generation,
            totalSteps: this.totalSteps,
            timestamp: new Date().toISOString(),
        };
        const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    async loadFromFile(file) {
        const text = await file.text();
        const obj = JSON.parse(text);
        if (!obj.policy) throw new Error('Invalid model file');
        const p = new Policy(this.opts.inDim, this.opts.hidden);
        if (!p.loadFrom(obj.policy)) throw new Error('Architecture mismatch');
        this.trainer.policy = p;
        this.generation = obj.generation || 0;
        this.totalSteps = obj.totalSteps || 0;
        this._save();
        this._emit({ event: 'loaded' });
    }

    // Pretrain the policy via behavior cloning from rule-based AI demonstrations.
    // This breaks the cold-start problem: PPO from random init struggles on
    // sparse-reward soccer; starting from a competent imitation of the rule AI
    // gives meaningful gradient signal from step 1.
    async pretrainFromRules(opts = {}) {
        if (this.workers.length === 0) throw new Error('No workers available');
        const totalSamples = opts.totalSamples || 32000;
        const perWorker = Math.ceil(totalSamples / (2 * this.workers.length)); // *2 because both red and blue recorded
        const rounds = opts.rounds || 4;
        const epochsPerRound = opts.epochsPerRound || 4;

        for (let round = 0; round < rounds; round++) {
            // Collect demonstrations in parallel
            const promises = this.workers.map((w, i) => new Promise((resolve, reject) => {
                if (this._workerBusy[i]) { resolve(null); return; }
                this._workerBusy[i] = true;
                const original = w.onmessage;
                w.onmessage = (e) => {
                    if (e.data.type === 'demonstrateResult') {
                        w.onmessage = original;
                        this._workerBusy[i] = false;
                        resolve(e.data);
                    } else { original(e); }
                };
                w.postMessage({
                    type: 'demonstrate',
                    T: perWorker,
                    envOpts: { ...this.envOptsForPhase(), maxSteps: perWorker },
                });
            }));
            const results = (await Promise.all(promises)).filter(Boolean);
            // Concat
            let total = 0;
            for (const r of results) total += r.n;
            const inDim = this.opts.inDim;
            const obs = new Float32Array(total * inDim);
            const acts = new Float32Array(total * 5);
            let off = 0;
            for (const r of results) {
                obs.set(new Float32Array(r.obs).subarray(0, r.n * inDim), off * inDim);
                acts.set(new Float32Array(r.acts).subarray(0, r.n * 5), off * 5);
                off += r.n;
            }
            // BC update
            const stats = await this.trainer.behaviorClone(obs, acts, total, { epochs: epochsPerRound, lr: 5e-4 });
            console.log(`[BC] round ${round + 1}/${rounds}: loss=${stats.loss.toFixed(4)} samples=${total}`);
            if (this.onProgress) this.onProgress({ event: 'bc', round: round + 1, rounds, loss: stats.loss, samples: total });
            // Save after every round so an interruption doesn't lose all BC progress
            this._save();
        }
    }

    getRuntimeAgent() {
        // Lazily clone serialized policy weights for runtime use
        if (typeof root.RLRuntimeAgent === 'undefined') return null;
        const ag = new root.RLRuntimeAgent();
        ag.loadFrom(this.trainer.policy.serialize());
        return ag;
    }

    hasTrainedAgent() {
        return this.generation > 0;
    }
}

return RLOrchestrator;

});
