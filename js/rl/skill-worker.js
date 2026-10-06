// AI Lab skill training worker: PPO on one skill drill (drills.js), entirely
// inside the worker so the page stays smooth.
//
// In:  { type: 'start', skill, policy?, level?, steps? }   policy: model-file
//                                                          weights to continue from
// Out: { type: 'progress', generation, level, totalSteps, trainSuccess, entropy }
//      { type: 'checkpoint', generation, level, totalSteps, successRate, levels,
//        improved, promoted, policy }                       policy: packed (f16)
//      { type: 'error', message }
self.importScripts(
    '../../shared/physics.js',
    '../../shared/entities.js',
    '../../shared/ai.js',
    '../../shared/powerups.js',
    './nn.js',
    './encoder.js',
    './policy.js',
    './trainer.js',
    './env.js',
    './drills.js',
    './skills.js'
);

const EVAL_EVERY = 5;

self.onmessage = (e) => {
    if (e.data.type === 'start') {
        train(e.data).catch(err => self.postMessage({ type: 'error', message: err.message }));
    }
};

async function train(msg) {
    const D = self.RLDrills;
    const hidden = msg.policy ? msg.policy.hidden : 128;
    const ppo = new self.RLTrainer.PPOTrainer({
        inDim: self.RLEncoder.STACKED_DIM,
        hidden,
        rolloutLen: msg.steps || 4096,
        learningRate: 2e-4,
        entCoef: 0.01,
    });
    if (msg.policy) {
        const start = self.RLSkills.decodePolicy(msg.policy);
        if (!ppo.policy.loadFrom(start.serialize())) throw new Error('model does not fit the encoder');
    }
    const trainer = new D.SkillTrainer(msg.skill, ppo, {
        steps: msg.steps || 4096,
        level: msg.level || 1,
        evalEpisodes: 150,
    });
    // Continuing from a trained model: record where it stands so only real
    // improvements are reported as such
    if (msg.policy) {
        const r = trainer.evaluate();
        trainer.best = { level: trainer.level, successRate: r.successRate };
    }
    for (;;) {
        const { stats, trainSuccess } = await trainer.trainGeneration();
        self.postMessage({
            type: 'progress',
            generation: trainer.generation,
            level: trainer.level,
            totalSteps: trainer.totalSteps,
            trainSuccess,
            entropy: stats.entropy,
        });
        if (trainer.generation % EVAL_EVERY === 0) {
            const c = trainer.checkpoint();
            const levels = c.improved ? trainer.report(150) : null;
            self.postMessage({
                type: 'checkpoint',
                generation: trainer.generation,
                level: c.level,
                totalSteps: trainer.totalSteps,
                successRate: c.result.successRate,
                levels,
                improved: c.improved,
                promoted: c.promoted,
                policy: c.improved ? self.RLSkills.packPolicy(ppo.policy.serialize()) : null,
            });
        }
    }
}
