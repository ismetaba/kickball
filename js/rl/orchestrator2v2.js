// 2v2 RL orchestrator — separate trainer instance, separate localStorage key,
// separate worker URL. Runs the same PPO algorithm but with the 2v2 env+worker.
(function(root, factory) {
    const exp = factory(root);
    root.RLOrchestrator2v2 = exp;
})(typeof self !== 'undefined' ? self : this, function(root) {

const { PPOTrainer, computeGAE } = root.RLTrainer;
const { Policy } = root.RLPolicy;
const { League } = root.RLLeague;
const RLEncoder2v2 = root.RLEncoder2v2;

const STORAGE_KEY = 'kickzone-rl-2v2-v1';
const ACTIVE_KEY = 'kickzone-rl-2v2-active';
const PHASE_KEY = 'kickzone-rl-2v2-phase';

class RLOrchestrator2v2 {
    constructor(opts = {}) {
        this.opts = Object.assign({
            inDim: RLEncoder2v2.STACKED_DIM,
            hidden: 256,
            workerCount: Math.min(navigator.hardwareConcurrency || 4, 16),
            rolloutLen: 1024,
            evalEvery: 25,
            saveEvery: 2,
            gamma: 0.995,
            gaeLambda: 0.95,
            opponentMix: { self: 0.40, league: 0.20, rule: 0.25, chaser: 0.10, random: 0.05 },
            curriculumGens: 300, // longer than 1v1's 150 — coordination is harder
            leagueAddEvery: 30,
            phase: 1,
        }, opts);

        this.trainer = new PPOTrainer({
            inDim: this.opts.inDim,
            hidden: this.opts.hidden,
            rolloutLen: this.opts.rolloutLen,
        });
        this.league = new League(10);
        this.generation = 0;
        this.totalSteps = 0;
        this.lastStats = null;
        this.isTraining = false;
        this.onProgress = null;

        this.workers = [];
        this._workerBusy = [];
        this._pendingResults = [];
        this._gen_inFlight = false;
        this._lastEvalScore = null;
        this._evalHistory = [];
        this._initWorkers();
        this._tryLoad();
    }

    _initWorkers() {
        for (let i = 0; i < this.opts.workerCount; i++) {
            try {
                const w = new Worker('js/rl/worker2v2.js');
                w.onmessage = (e) => this._onWorkerMsg(i, e.data);
                w.onerror = (e) => console.warn('[RL2v2 worker error]', e.message);
                this.workers.push(w);
                this._workerBusy.push(false);
            } catch (e) {
                console.warn('[RL2v2] failed to init worker', i, e);
            }
        }
        if (this.workers.length === 0) {
            console.warn('[RL2v2] no workers available');
        } else {
            console.log('[RL2v2] initialized', this.workers.length, 'workers');
        }
    }

    start() {
        if (this.isTraining) return;
        this.isTraining = true;
        try {
            localStorage.setItem(ACTIVE_KEY, 'true');
            localStorage.setItem(PHASE_KEY, String(this.opts.phase || 1));
        } catch(e) {}
        if (typeof document !== 'undefined' && document.hidden) {
            console.warn('[RL2v2] training started while tab is hidden — keep this tab in the foreground for full speed.');
        }
        if (!this._pageHideListener) {
            this._pageHideListener = () => { try { this._save(); } catch(e) {} };
            window.addEventListener('pagehide', this._pageHideListener);
        }
        this._runGenerationLoop();
    }

    stop() {
        this.isTraining = false;
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
        this.totalSteps = 0;
        this.lastStats = null;
        this._lastEvalScore = null;
        this._evalHistory = [];
        try {
            localStorage.removeItem(STORAGE_KEY);
            localStorage.removeItem(ACTIVE_KEY);
            localStorage.removeItem(PHASE_KEY);
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

    envOptsForPhase() {
        const phase = this.opts.phase || 1;
        const base = { map: 'classic', powerUps: false, maxSteps: this.opts.rolloutLen };
        if (phase === 1) {
            return { ...base, disableSuperKick: true, disableKickPlayer: true, disablePull: true,
                superKickAbusePenalty: 0, kickPlayerAbusePenalty: 0 };
        }
        if (phase === 2) {
            return { ...base, disableSuperKick: true, disableKickPlayer: false, disablePull: false,
                kickPlayerAbusePenalty: 0.03 };
        }
        return { ...base, disableSuperKick: false, disableKickPlayer: false, disablePull: false,
            superKickAbusePenalty: 0.05, kickPlayerAbusePenalty: 0.03, powerUps: false };
    }

    _sampleOpponent() {
        const gen = this.generation;
        const curric = this.opts.curriculumGens;
        let mix;
        if (gen < curric / 2) {
            mix = { self: 0.0, league: 0.0, chaser: 0.3, rule: 0.5, random: 0.2 };
        } else if (gen < curric) {
            mix = { self: 0.15, league: 0.0, chaser: 0.15, rule: 0.5, random: 0.2 };
        } else {
            mix = this.opts.opponentMix;
        }
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

    _runGenerationLoop() {
        if (!this.isTraining) return;
        if (this._gen_inFlight) return;
        this._gen_inFlight = true;

        const policySer = this.trainer.policy.serialize();
        const envOpts = this.envOptsForPhase();
        this._pendingResults = [];
        for (let i = 0; i < this.workers.length; i++) {
            const oppType = this._sampleOpponent();
            const oppWeights = (oppType === 'league') ? this.league.sample().weights : null;
            this._workerBusy[i] = true;
            this.workers[i].postMessage({
                type: 'rollout',
                policySer, oppType, oppWeights,
                T: this.opts.rolloutLen,
                envOpts,
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
            this._evalHistory.push({ gen: this.generation, diff: score });
            if (this._evalHistory.length > 200) this._evalHistory.shift();
            this._emit({ event: 'eval' });
        }
    }

    async _consolidateAndUpdate() {
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

        const stats = await this.trainer.update({
            obs, actsPre, kicks, pulls, logProbsOld: logProbs, advs, returns,
        });
        this.lastStats = {
            ...stats,
            totalReward: totalReward / Math.max(this.workers.length, 1),
            goalsFor: totalGoalsA, goalsAgainst: totalGoalsO,
            transitions: total,
        };
        this.totalSteps += total;
        this.generation++;
        if (this.generation % this.opts.leagueAddEvery === 0) {
            this.league.add(this.trainer.policy.serialize(), this.generation, totalGoalsA - totalGoalsO);
        }
        if (this.generation % this.opts.saveEvery === 0) this._save();
        if (this.generation % this.opts.evalEvery === 0) this._dispatchEvaluation();
        this._emit({ event: 'update' });

        this._gen_inFlight = false;
        this._pendingResults = [];
        if (this.isTraining) this._runGenerationLoop();
    }

    _dispatchEvaluation() {
        if (this._evalTask) return;
        if (this.workers.length === 0) return;
        const idle = this._workerBusy.findIndex(b => !b);
        if (idle < 0) return;
        this._evalTask = 'rule';
        this._workerBusy[idle] = true;
        this._evalWorkerIdx = idle;
        this.workers[idle].postMessage({
            type: 'evaluate',
            policySer: this.trainer.policy.serialize(),
            oppType: 'rule',
            episodes: 2,
            envOpts: { map: 'classic', powerUps: false, maxSteps: 1200 },
        });
    }

    runEvaluation(oppType = 'rule', episodes = 4) {
        return new Promise((resolve, reject) => {
            const idle = this._workerBusy.findIndex(b => !b);
            if (idle < 0) { reject(new Error('all workers busy')); return; }
            const worker = this.workers[idle];
            this._workerBusy[idle] = true;
            const original = worker.onmessage;
            worker.onmessage = (e) => {
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
                } else { original(e); }
            };
            worker.postMessage({
                type: 'evaluate',
                policySer: this.trainer.policy.serialize(),
                oppType, episodes,
                envOpts: { map: 'classic', powerUps: false, maxSteps: 1800 },
            });
        });
    }

    async pretrainFromRules(opts = {}) {
        if (this.workers.length === 0) throw new Error('No workers available');
        const totalSamples = opts.totalSamples || 32000;
        const perWorker = Math.ceil(totalSamples / (2 * this.workers.length));
        const rounds = opts.rounds || 4;
        const epochsPerRound = opts.epochsPerRound || 4;
        for (let round = 0; round < rounds; round++) {
            const promises = this.workers.map((w, i) => new Promise((resolve) => {
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
            const stats = await this.trainer.behaviorClone(obs, acts, total, { epochs: epochsPerRound, lr: 5e-4 });
            console.log(`[BC2v2] round ${round + 1}/${rounds}: loss=${stats.loss.toFixed(4)} samples=${total}`);
            if (this.onProgress) this.onProgress({ event: 'bc', round: round + 1, rounds, loss: stats.loss, samples: total });
            this._save();
        }
    }

    _save() {
        try {
            const existingRaw = localStorage.getItem(STORAGE_KEY);
            if (existingRaw) {
                try {
                    const existing = JSON.parse(existingRaw);
                    const existingGen = existing.generation || 0;
                    if (existingGen > this.generation) {
                        console.warn('[RL2v2] _save() refused: localStorage has gen ' + existingGen + ' but this is at gen ' + this.generation);
                        return;
                    }
                } catch(e) {}
            }
            const obj = {
                policy: this.trainer.policy.serialize(),
                generation: this.generation,
                totalSteps: this.totalSteps,
                league: this.league.serialize(),
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
        } catch(e) {}
    }

    _tryLoad() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            const obj = JSON.parse(raw);
            if (!obj.policy) return false;
            const p = new Policy(this.opts.inDim, this.opts.hidden);
            if (!p.loadFrom(obj.policy)) return false;
            this.trainer.policy = p;
            this.generation = obj.generation || 0;
            this.totalSteps = obj.totalSteps || 0;
            if (obj.league) this.league.loadFrom(obj.league);
            console.log('[RL2v2] loaded checkpoint, generation', this.generation);
            return true;
        } catch(e) { return false; }
    }

    saveAs(filename = 'kickzone-rl-2v2-model.json') {
        const obj = {
            policy: this.trainer.policy.serialize(),
            generation: this.generation,
            totalSteps: this.totalSteps,
            timestamp: new Date().toISOString(),
            mode: '2v2',
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
        if (!obj.policy) throw new Error('Invalid 2v2 model file');
        const p = new Policy(this.opts.inDim, this.opts.hidden);
        if (!p.loadFrom(obj.policy)) throw new Error('2v2 architecture mismatch');
        this.trainer.policy = p;
        this.generation = obj.generation || 0;
        this.totalSteps = obj.totalSteps || 0;
        this._save();
        this._emit({ event: 'loaded' });
    }

    getRuntimeAgents() {
        // Returns 2 separate runtime agents that share the same policy
        if (typeof root.RLRuntimeAgent2v2 === 'undefined') return null;
        const sharedPolicy = root.RLRuntimeAgent2v2.makePolicyFrom(this.trainer.policy.serialize());
        if (!sharedPolicy) return null;
        return [
            new root.RLRuntimeAgent2v2(sharedPolicy),
            new root.RLRuntimeAgent2v2(sharedPolicy),
        ];
    }

    hasTrainedAgent() {
        return this.generation > 0;
    }
}

return RLOrchestrator2v2;

});
