// AI Lab "Skills" tab: watch a skill model play its drill live, see its
// success rate per level, and keep training it in the browser.
//
// The model for each skill is the player's own (trained here, kept in
// localStorage via AIModels) or else the one that ships with the game. With
// neither, the drill's scripted reference player is shown instead. Training
// runs PPO in js/rl/skill-worker.js; each improved checkpoint is saved and
// immediately used for watching and for the skills Test Match.
class SkillLab {
    constructor() {
        this.skill = 'dribble';
        this.level = 1;
        this.visible = false;
        this.env = null;
        this.actor = null;
        this.modelLabel = '';
        this.watch = { episodes: 0, successes: 0 };
        this.flash = null;           // { text, good, until } after each episode
        this.worker = null;
        this._acc = 0;
        this._last = 0;
        this._raf = null;
        this._policyCache = new Map();
        this._ = (id) => document.getElementById(id);
    }

    init() {
        document.querySelectorAll('[data-skill]').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.worker) this.stopTraining();
                this.skill = btn.dataset.skill;
                this._restart();
            });
        });
        document.querySelectorAll('[data-skill-level]').forEach(btn => {
            btn.addEventListener('click', () => {
                this.level = parseInt(btn.dataset.skillLevel);
                this._restart();
            });
        });
        this._('btn-skill-train').addEventListener('click', () => this.startTraining());
        this._('btn-skill-stop').addEventListener('click', () => this.stopTraining());
        this._('btn-skill-reset').addEventListener('click', () => {
            if (!AIModels.hasLocalSkill(this.skill)) return;
            if (!confirm('Discard your training for ' + this.skill + ' and use the shipped model?')) return;
            this.stopTraining();
            AIModels.clearLocalSkill(this.skill);
            this._restart();
        });
        AIModels.ready.then(() => { if (this.visible) this._restart(); });
    }

    show() {
        this.visible = true;
        this._restart();
        this._last = performance.now();
        if (!this._raf) this._raf = requestAnimationFrame((t) => this._frame(t));
    }

    hide() {
        this.visible = false;
    }

    // --- Watching --------------------------------------------------------------

    _restart() {
        const model = AIModels.skillModel(this.skill);
        const policy = model ? this._policy(model) : null;
        this.actor = policy ? RLDrills.policyActor(policy) : RLDrills.HEURISTICS[this.skill];
        this.modelLabel = !model ? 'scripted reference'
            : AIModels.hasLocalSkill(this.skill) ? `your training (gen ${model.generation || 0})`
            : 'shipped';
        this.env = new RLDrills.DrillEnv(this.skill, { level: this.level });
        this.env.reset(this.level);
        this.watch = { episodes: 0, successes: 0 };
        this.flash = null;
        this._acc = 0;
        this._renderStats(model);
    }

    _policy(model) {
        const key = this.skill + ':' + (model.savedAt || '') + ':' + (model.generation || 0);
        if (!this._policyCache.has(key)) this._policyCache.set(key, RLSkills.decodePolicy(model.policy));
        return this._policyCache.get(key);
    }

    _frame(now) {
        this._raf = null;
        if (!this.visible) return;
        const dt = Math.min(100, now - this._last);
        this._last = now;
        if (this.flash && now < this.flash.until) {
            // Pause briefly on each result so it can be read
        } else {
            if (this.flash) { this.flash = null; this.env.reset(this.level); }
            this._acc += dt;
            while (this._acc >= 33.34 && !this.flash) {
                this._acc -= 33.34;
                const out = this.env.step(this.actor(this.env));
                if (out.done) {
                    this.watch.episodes++;
                    if (out.success) this.watch.successes++;
                    this.flash = { text: OUTCOME_TEXT[out.outcome] || out.outcome, good: out.success, until: now + 700 };
                    this._acc = 0;
                    this._renderStats();
                }
            }
        }
        this._draw();
        this._raf = requestAnimationFrame((t) => this._frame(t));
    }

    _renderStats(model = AIModels.skillModel(this.skill)) {
        const w = this.watch;
        this._('skill-lab-model').textContent = this.modelLabel;
        this._('skill-lab-watch').textContent = w.episodes
            ? `${w.successes}/${w.episodes} (${Math.round(w.successes / w.episodes * 100)}%)` : '—';
        const lv = model && model.levels;
        this._('skill-lab-levels').textContent = lv
            ? [1, 2, 3].map(l => (lv[l] === undefined ? '—' : Math.round(lv[l] * 100) + '%')).join(' / ')
            : '—';
        document.querySelectorAll('[data-skill]').forEach(b => b.classList.toggle('active', b.dataset.skill === this.skill));
        document.querySelectorAll('[data-skill-level]').forEach(b =>
            b.classList.toggle('active', parseInt(b.dataset.skillLevel) === this.level));
        this._('skill-lab-desc').textContent = SKILL_TEXT[this.skill];
    }

    _draw() {
        const canvas = this._('skill-lab-canvas');
        if (!canvas || !this.env) return;
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        const ctx = canvas.getContext('2d');
        const f = this.env.field;
        const pad = 12;
        const vx0 = f.x - f.goalDepth - pad, vx1 = f.x + f.width + f.goalDepth + pad;
        const vy0 = f.y - pad, vy1 = f.y + f.height + pad;
        const scale = Math.min(cw / (vx1 - vx0), ch / (vy1 - vy0));
        const ox = (cw - (vx1 - vx0) * scale) / 2 - vx0 * scale;
        const oy = (ch - (vy1 - vy0) * scale) / 2 - vy0 * scale;
        const X = (x) => ox + x * scale, Y = (y) => oy + y * scale;

        ctx.fillStyle = '#0d2a1a';
        ctx.fillRect(0, 0, cw, ch);
        ctx.fillStyle = '#1d5c35';
        ctx.fillRect(X(f.x), Y(f.y), f.width * scale, f.height * scale);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = Math.max(1, 2 * scale);
        ctx.strokeRect(X(f.x), Y(f.y), f.width * scale, f.height * scale);
        ctx.beginPath();
        ctx.moveTo(X(f.centerX), Y(f.y)); ctx.lineTo(X(f.centerX), Y(f.y + f.height));
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(X(f.centerX), Y(f.centerY), f.centerRadius * scale, 0, Math.PI * 2);
        ctx.stroke();
        for (const left of [true, false]) {
            const gx = left ? f.x - f.goalDepth : f.x + f.width;
            ctx.fillStyle = left ? 'rgba(255,77,109,0.25)' : 'rgba(77,212,255,0.25)';
            ctx.fillRect(X(gx), Y(f.goalY), f.goalDepth * scale, f.goalHeight * scale);
            ctx.strokeRect(X(gx), Y(f.goalY), f.goalDepth * scale, f.goalHeight * scale);
        }

        const { red, blue, ball } = this.env;
        if (red.pullActive) {
            ctx.strokeStyle = 'rgba(255,220,120,0.8)';
            ctx.setLineDash([4 * dpr, 4 * dpr]);
            ctx.beginPath(); ctx.moveTo(X(red.x), Y(red.y)); ctx.lineTo(X(ball.x), Y(ball.y)); ctx.stroke();
            ctx.setLineDash([]);
        }
        const dot = (e, fill, ring) => {
            ctx.beginPath();
            ctx.arc(X(e.x), Y(e.y), e.radius * scale, 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.fill();
            if (ring) { ctx.strokeStyle = ring; ctx.lineWidth = Math.max(1, 3 * scale); ctx.stroke(); }
        };
        if (blue.y > f.y) dot(blue, this.env.ruleOpponent ? '#9b7bff' : '#4dd4ff');
        dot(red, '#ff4d6d', red.pullCooldown <= 0 && !red.pullActive ? 'rgba(255,220,120,0.9)' : null);
        dot(ball, '#ffffff');

        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.font = `${11 * dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(`Level ${this.level}  ·  ${this.modelLabel}`, 8 * dpr, 16 * dpr);
        if (this.flash) {
            ctx.font = `bold ${22 * dpr}px system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillStyle = this.flash.good ? '#7dff9a' : '#ff6b81';
            ctx.fillText(this.flash.text, cw / 2, ch / 2);
        }
    }

    // --- Training -------------------------------------------------------------

    startTraining() {
        if (this.worker) return;
        const model = AIModels.skillModel(this.skill);
        const skill = this.skill;
        // Generations continue from the player's earlier training of this skill
        this._genBase = AIModels.hasLocalSkill(skill) ? (model.generation || 0) : 0;
        this.worker = new Worker('js/rl/skill-worker.js');
        this.worker.onmessage = (e) => this._onWorker(skill, e.data);
        this.worker.onerror = (e) => this._setTrain('Error: ' + e.message, '#ff4d6d');
        this.worker.postMessage({
            type: 'start',
            skill,
            policy: model ? model.policy : null,
            level: this.level,
        });
        this._setTrain('Starting…', '#4dd4ff');
    }

    stopTraining() {
        if (!this.worker) return;
        this.worker.terminate();
        this.worker = null;
        this._setTrain('Stopped', '#fc6');
    }

    _onWorker(skill, msg) {
        if (msg.type === 'error') {
            this._setTrain('Error: ' + msg.message, '#ff4d6d');
            this.stopTraining();
            return;
        }
        if (msg.type === 'progress') {
            this._setTrain(`Gen ${msg.generation} · level ${msg.level} · ${Math.round(msg.trainSuccess * 100)}% in training`, '#4dd4ff');
            return;
        }
        if (msg.type === 'checkpoint' && msg.improved) {
            AIModels.saveLocalSkill(skill, {
                kind: 'kickzone-skill',
                skill,
                level: msg.level,
                levels: msg.levels,
                generation: this._genBase + msg.generation,
                savedAt: new Date().toISOString(),
                policy: msg.policy,
            });
            if (skill === this.skill) this._restart();
        }
    }

    _setTrain(text, color) {
        const el = this._('skill-lab-train');
        el.textContent = text;
        el.style.color = color || '#fff';
    }
}

const OUTCOME_TEXT = {
    carried: 'Carried it ✓', scored: 'Goal ✓', own_goal: 'Own goal ✗', stolen: 'Stolen ✗',
    lost: 'Lost it ✗', timeout: 'Out of time ✗', cleared: 'Cleared ✓', held: 'Held ✓',
    danger: 'Not cleared ✗', conceded: 'Conceded ✗', saved: 'Saved ✗', missed: 'Missed ✗', won: 'Won it ✓',
};

const SKILL_TEXT = {
    dribble: 'Carry the ball into the attacking third without losing it.',
    defend: 'Stop the shot or the attacker, then clear the ball past halfway.',
    shoot: 'Score from the attacking half — past a keeper on levels 2–3.',
    pull: 'Win a loose or carried ball, pulling it in when it\'s in range.',
};
