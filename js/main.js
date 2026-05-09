// Entry point
const game = new Game();
const ui = new UI(game);
game._ui = ui;
window._game = game;
window.game = game;
window.ui = ui;

// Auto-resume RL training (1v1 or 2v2) if it was active when the page closed.
// Each mode has its own "active" flag and orchestrator. They can both run
// concurrently — workers will share CPU cores but each lives in its own pool.
(function autoResumeRL() {
    setTimeout(() => {
        try {
            // 1v1 (also handle legacy unprefixed key for backward compat)
            const wasActive1v1 = localStorage.getItem('kickzone-rl-1v1-active') === 'true'
                              || localStorage.getItem('kickzone-rl-active') === 'true';
            if (wasActive1v1 && typeof RLOrchestrator !== 'undefined') {
                if (!window.rlOrch) window.rlOrch = new RLOrchestrator();
                const phase = parseInt(localStorage.getItem('kickzone-rl-1v1-phase') || localStorage.getItem('kickzone-rl-phase')) || 1;
                window.rlOrch.opts.phase = phase;
                console.log('[RL] auto-resuming 1v1 training from gen', window.rlOrch.generation, 'phase', phase);
                window.rlOrch.start();
            }
            // 2v2
            const wasActive2v2 = localStorage.getItem('kickzone-rl-2v2-active') === 'true';
            if (wasActive2v2 && typeof RLOrchestrator2v2 !== 'undefined') {
                if (!window.rlOrch2v2) window.rlOrch2v2 = new RLOrchestrator2v2();
                const phase = parseInt(localStorage.getItem('kickzone-rl-2v2-phase')) || 1;
                window.rlOrch2v2.opts.phase = phase;
                console.log('[RL2v2] auto-resuming 2v2 training from gen', window.rlOrch2v2.generation, 'phase', phase);
                window.rlOrch2v2.start();
            }
        } catch(e) { console.warn('[RL] auto-resume failed', e); }
    }, 200);
})();
