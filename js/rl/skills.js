// Skill-based AI: four skill policies trained on drills (drills.js) and a
// coach that decides which one is playing.
//
// Every 33 ms (one training step) the coach reads who has the ball and where,
// and hands control to one skill:
//
//   ball heading into our goal                          -> defend
//   opponent has the ball in our half                   -> defend
//   opponent has the ball in their half, or it's loose  -> pull (win the ball)
//   we have the ball in the attacking zone              -> shoot
//   we have the ball anywhere else                      -> dribble
//
// SkillAgent has the same interface as AIController / RLRuntimeAgent:
//   update(player, ball, field, teammates, opponents, dt, rng) -> { kick, chargeRatio }
// and moves the player / starts its pull itself. In team games only the
// player nearest the ball uses the skills; the others position themselves
// with the scripted AIController. MatchAgent runs a single full-match policy
// the same way.
(function(root, factory) {
    let Physics, RLPolicy, RLEncoder, AIController;
    if (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports) {
        Physics = require('../../shared/physics');
        RLPolicy = require('./policy');
        RLEncoder = require('./encoder');
        AIController = require('../../shared/ai');
    } else {
        Physics = root.Physics;
        RLPolicy = root.RLPolicy;
        RLEncoder = root.RLEncoder;
        AIController = root.AIController;
    }
    const exp = factory(root, Physics, RLPolicy, RLEncoder, AIController);
    if (typeof module !== 'undefined' && module.exports) module.exports = exp;
    else root.RLSkills = exp;
})(typeof self !== 'undefined' ? self : this, function(root, Physics, RLPolicy, RLEncoder, AIController) {

const SKILLS = ['dribble', 'defend', 'shoot', 'pull'];
const STEP_MS = 33.34;       // decision interval = one drill training step
const SHOOT_FROM = 0.62;     // ball progress (0 own goal .. 1 their goal) where we shoot
const MIN_HOLD_MS = 200;     // keep a skill at least this long, so control doesn't flicker

// Read the situation from `player`'s side of the pitch.
function readSituation(player, ball, opp, field) {
    const isRed = player.team === 'red';
    const dir = isRed ? 1 : -1;
    const progress = isRed
        ? (ball.x - field.x) / field.width
        : (field.x + field.width - ball.x) / field.width;
    const control = player.radius + ball.radius + 30;
    const myDist = Physics.distance(player, ball);
    const oppDist = opp ? Physics.distance(opp, ball) : Infinity;
    const mine = myDist <= control && myDist <= oppDist;
    const theirs = !mine && oppDist <= control;
    // A shot on our goal: moving toward our goal line on a path into the mouth
    let shotIncoming = false;
    if (ball.vx * dir < -2) {
        const ownGoalX = isRed ? field.x : field.x + field.width;
        const yAtLine = ball.y + ball.vy * ((ownGoalX - ball.x) / ball.vx);
        shotIncoming = yAtLine > field.goalY - 30 && yAtLine < field.goalY + field.goalHeight + 30;
    }
    return { progress, mine, theirs, shotIncoming, closer: myDist < oppDist };
}

// The situations the coach tells apart, and the skill each one goes to
const SITUATIONS = {
    shot: 'defend',               // the ball is heading into our goal
    carriedAtUs: 'defend',        // the opponent has it in our half
    carriedAway: 'pull',          // the opponent has it in their half
    attackWithBall: 'shoot',      // we have it in the attacking zone
    carryWithBall: 'dribble',     // we have it anywhere else
    looseNearGoal: 'shoot',       // loose in the attacking zone, we're closer
    looseTheyLead: 'defend',      // loose in our half, they're closer
    loose: 'pull',                // any other loose ball
};

function classify(s) {
    if (s.shotIncoming && !s.mine) return 'shot';
    if (s.theirs) return s.progress < 0.5 ? 'carriedAtUs' : 'carriedAway';
    if (s.mine) return s.progress >= SHOOT_FROM ? 'attackWithBall' : 'carryWithBall';
    if (s.progress >= SHOOT_FROM && s.closer) return 'looseNearGoal';
    if (!s.closer && s.progress < 0.4) return 'looseTheyLead';
    return 'loose';
}

function pickSkill(s) {
    return SITUATIONS[classify(s)];
}

class SkillCoach {
    constructor() {
        this.skill = null;
        this.situation = null;     // situation at the latest decision
        this.heldMs = 0;
    }

    choose(player, ball, opp, field, dt) {
        const s = readSituation(player, ball, opp, field);
        this.situation = classify(s);
        const want = SITUATIONS[this.situation];
        this.heldMs += dt;
        const urgent = want === 'defend' && s.shotIncoming;
        if (want !== this.skill && (this.skill === null || this.heldMs >= MIN_HOLD_MS || urgent)) {
            this.skill = want;
            this.heldMs = 0;
        }
        return this.skill;
    }
}

// Pack a serialized policy for shipping: every weight array becomes
// { f16: base64 } (half precision, ~4x smaller than JSON numbers).
function packPolicy(ser) {
    const pack = (a) => ({ f16: toFloat16Base64(a) });
    const layer = (l) => ({ inDim: l.inDim, outDim: l.outDim, W: pack(l.W), b: pack(l.b) });
    return {
        inDim: ser.inDim,
        hidden: ser.hidden,
        l1: layer(ser.l1),
        l2: layer(ser.l2),
        actor: layer(ser.actor),
        critic: layer(ser.critic),
        logStd: pack(ser.logStd),
    };
}

// Turn a policy as stored in a model file into a Policy: { inDim, hidden,
// l1: {W, b}, ... } where each array is a plain number array or packed
// { f16: base64 } (packPolicy).
function decodePolicy(ser) {
    const unpack = (a) => (a && a.f16 !== undefined ? fromFloat16Base64(a.f16) : a);
    const layer = (l) => ({ inDim: l.inDim, outDim: l.outDim, W: unpack(l.W), b: unpack(l.b) });
    const policy = new RLPolicy.Policy(ser.inDim, ser.hidden);
    const ok = policy.loadFrom({
        inDim: ser.inDim,
        hidden: ser.hidden,
        l1: layer(ser.l1),
        l2: layer(ser.l2),
        actor: layer(ser.actor),
        critic: layer(ser.critic),
        logStd: unpack(ser.logStd),
    });
    if (!ok) throw new Error('skill policy does not match its declared shape');
    return policy;
}

// Runtime for learned 1v1 policies behind the AIController interface:
// decides every 33 ms (one training step), moves the player and starts its
// pull every frame, and attempts the kick once per decision, as in training.
// In team games only the player nearest the ball is driven by the policy;
// the others are positioned by the scripted AIController.
//
// Subclasses pick the policy (_choosePolicy) and the clock/score features the
// encoder sees (_gameState).
class LearnedAgent {
    // random: source for the kick/pull draws (default Math.random)
    constructor(random = Math.random) {
        this.random = random;
        this.threshold = false;            // true: kick/pull only when p > 0.5
        this._obs = new Float32Array(RLEncoder.FEATURE_DIM);
        this._stack = new RLEncoder.FrameStack(RLEncoder.FEATURE_DIM, RLEncoder.STACK_K);
        this._stackPrimed = false;
        this._timer = 0;
        this._move = { x: 0, y: 0 };
        this._kick = false;
        this._charge = 0;
        this._pull = false;
        this._support = null;              // AIController for off-ball play in team games
    }

    setDifficulty() {
        // Compatibility no-op (AIController interface)
    }

    update(player, ball, field, teammates, opponents, dt, rng) {
        if (teammates && teammates.length > 1 && nearest(teammates, ball) !== player) {
            if (!this._support) this._support = new AIController('normal');
            this._stackPrimed = false;     // fresh history when we take the ball again
            this._onBench();
            return this._support.update(player, ball, field, teammates, opponents, dt, rng);
        }
        const opp = nearest(opponents, ball);
        if (!opp) return { kick: false, chargeRatio: 0 };

        this._timer -= dt;
        let kickNow = false;
        if (this._timer <= 0) {
            this._timer = STEP_MS;
            this._decide(player, ball, field, opp);
            kickNow = this._kick;
        }

        const mx = this._move.x, my = this._move.y;
        const len = Math.sqrt(mx * mx + my * my);
        if (len > 1e-3) player.applyInput(mx / Math.max(len, 1), my / Math.max(len, 1));
        if (this._pull) player.activatePull();
        return { kick: kickNow, chargeRatio: this._charge };
    }

    _decide(player, ball, field, opp) {
        const isRed = player.team === 'red';
        RLEncoder.encode(player, opp, ball, field, this._gameState(player), null, this._obs, false);
        if (!this._stackPrimed) {
            this._stack.fill(this._obs);
            this._stackPrimed = true;
        } else {
            this._stack.push(this._obs);
        }
        const policy = this._choosePolicy(player, ball, field, opp);
        const { raw } = policy.forward(this._stack.get());
        const mvX = Math.tanh(raw[0]);
        this._move.x = isRed ? mvX : -mvX;
        this._move.y = Math.tanh(raw[1]);
        this._charge = sigmoid(raw[2]) * 0.95;   // same squash as in training
        // Kick and pull are drawn from their probabilities, as in training
        const kickP = sigmoid(raw[3]), pullP = sigmoid(raw[4]);
        this._kick = this.threshold ? kickP > 0.5 : this.random() < kickP;
        this._pull = this.threshold ? pullP > 0.5 : this.random() < pullP;
    }

    _onBench() {}
}

class SkillAgent extends LearnedAgent {
    // policies: { dribble: Policy, defend: Policy, shoot: Policy, pull: Policy }
    // opts.base: a full-match Policy that plays whenever the coach picks a
    //            skill that isn't in `policies` (so skills can be added to a
    //            match model one at a time)
    // opts.situations: with a base, the situations (SITUATIONS keys) where the
    //            skills may play at all; the base plays everywhere else
    constructor(policies, opts = {}) {
        super(opts.random);
        this.base = opts.base || null;
        this.situations = opts.situations ? new Set(opts.situations) : null;
        for (const name of SKILLS) {
            if (!policies[name] && !this.base) throw new Error('missing skill policy: ' + name);
        }
        this.policies = policies;
        this.coach = new SkillCoach();
        this.skill = null;                 // skill in control (for debugging / HUD)
    }

    // Build agents that share one set of decoded policies:
    //   const make = SkillAgent.factory(bundle); const ai = make();
    // bundle.skills[name] is a model file ({ policy, ... }) or a decoded Policy;
    // opts.base likewise (a full-match model). opts.only limits where skills
    // play: skill names (all of that skill's situations) and/or SITUATIONS keys.
    static factory(bundle, opts = {}) {
        const load = (m) => (m instanceof RLPolicy.Policy ? m : decodePolicy(m.policy));
        let situations = null;
        if (opts.only) {
            situations = Object.keys(SITUATIONS).filter(k =>
                opts.only.includes(k) || opts.only.includes(SITUATIONS[k]));
        }
        const policies = {};
        for (const name of SKILLS) {
            if (situations && !situations.some(k => SITUATIONS[k] === name)) continue;
            if (bundle.skills[name]) policies[name] = load(bundle.skills[name]);
        }
        const base = opts.base ? load(opts.base) : null;
        return () => new SkillAgent(policies, { base, situations });
    }

    // A fixed clock and score: the skills were trained with these randomized
    // (so they ignore them) and a full-match base model was evaluated with them
    _gameState() {
        return { timeLeft: 60000, scoreDiff: 0, kickoffActive: false };
    }

    _choosePolicy(player, ball, field, opp) {
        this.skill = this.coach.choose(player, ball, opp, field, STEP_MS);
        const allowed = !this.situations || this.situations.has(this.coach.situation);
        return (allowed && this.policies[this.skill]) || this.base;
    }

    _onBench() {
        this.coach.skill = null;
        this.skill = null;
    }
}

// One full-match policy (e.g. from scripts/train-match.js), fed the same fixed
// clock and score it saw in its evaluation matches.
class MatchAgent extends LearnedAgent {
    constructor(policy, opts = {}) {
        super(opts.random);
        this.policy = policy;
        this.threshold = !!opts.threshold;
    }

    // model: a model file ({ policy, threshold? }); agents share the decoded weights
    static factory(model) {
        const policy = decodePolicy(model.policy);
        return () => new MatchAgent(policy, { threshold: model.threshold });
    }

    _gameState() {
        return { timeLeft: 60000, scoreDiff: 0, kickoffActive: false };
    }

    _choosePolicy() {
        return this.policy;
    }
}

function nearest(players, ball) {
    let best = null, bestD = Infinity;
    for (const p of players) {
        const d = Physics.distance(p, ball);
        if (d < bestD) { bestD = d; best = p; }
    }
    return best;
}

function sigmoid(x) {
    if (x >= 0) {
        const z = Math.exp(-x);
        return 1 / (1 + z);
    }
    const z = Math.exp(x);
    return z / (1 + z);
}

// --- float16 packing (keeps the bundled models small) --------------------------

function toFloat16Base64(arr) {
    const u16 = new Uint16Array(arr.length);
    for (let i = 0; i < arr.length; i++) u16[i] = f32ToF16(arr[i]);
    return bytesToBase64(new Uint8Array(u16.buffer));
}

function fromFloat16Base64(b64) {
    const bytes = base64ToBytes(b64);
    const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    const out = new Float32Array(u16.length);
    for (let i = 0; i < u16.length; i++) out[i] = f16ToF32(u16[i]);
    return out;
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

function f32ToF16(v) {
    _f32[0] = v;
    const x = _u32[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = ((x >>> 23) & 0xff) - 127 + 15;
    let mant = x & 0x7fffff;
    if (exp <= 0) {
        if (exp < -10) return sign;                       // too small: signed zero
        mant |= 0x800000;                                 // subnormal half
        const shift = 14 - exp;
        let h = mant >>> shift;
        if ((mant >>> (shift - 1)) & 1) h++;              // round
        return sign | h;
    }
    if (exp >= 31) return sign | 0x7c00;                  // overflow: infinity
    let h = sign | (exp << 10) | (mant >>> 13);
    if (mant & 0x1000) h++;                               // round to nearest
    return h;
}

function f16ToF32(h) {
    const sign = (h & 0x8000) ? -1 : 1;
    const exp = (h >>> 10) & 0x1f;
    const mant = h & 0x3ff;
    if (exp === 0) return sign * mant * Math.pow(2, -24);
    if (exp === 31) return mant ? NaN : sign * Infinity;
    return sign * (1 + mant / 1024) * Math.pow(2, exp - 15);
}

function bytesToBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

function base64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') {
        const buf = Buffer.from(b64, 'base64');
        return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
    }
    const s = atob(b64);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
}

return {
    SKILLS,
    SHOOT_FROM,
    SkillAgent,
    MatchAgent,
    SkillCoach,
    SITUATIONS,
    readSituation,
    classify,
    pickSkill,
    packPolicy,
    decodePolicy,
    toFloat16Base64,
    fromFloat16Base64,
};

});
