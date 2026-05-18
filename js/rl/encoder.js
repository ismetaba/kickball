// State encoder + action decoder for KickZone 1v1 RL.
//
// Goals:
//   - Compact, normalized observation that captures everything the agent needs.
//   - Symmetric: the same encoder works regardless of team (red/blue) by
//     internally mirroring blue's view so the policy only ever learns one frame.
//   - Mirror augmentation across the X axis (vertical mirror) doubles training
//     data for free — the game is symmetric vertically.
//
// Convention: "side" coordinates are always from the agent's perspective.
//   - +x_side = "forward" (toward enemy goal)
//   - +y_side = "down" on the field
// For a red player, side coords == world coords.
// For a blue player, x is flipped (world.x -> field.right - world.x).
(function(root, factory) {
    const Physics = (typeof require !== 'undefined') ? require('../../shared/physics') : root.Physics;
    const exp = factory(Physics);
    if (typeof module !== 'undefined' && module.exports) module.exports = exp;
    else root.RLEncoder = exp;
})(typeof self !== 'undefined' ? self : this, function(Physics) {

const FEATURE_DIM = 56;
// Frame stacking: the policy sees the last STACK_K observations concatenated
// in [oldest, ..., newest] order. This gives the agent implicit access to
// acceleration, ball curve, and short-term opponent intent without an LSTM.
const STACK_K = 3;
const STACKED_DIM = FEATURE_DIM * STACK_K;
const NUM_POWERUP_TYPES = 6; // speed, ghost, dash, shield, freeze, slow
const POWERUP_INDEX = { speed: 0, ghost: 1, dash: 2, shield: 3, freeze: 4, slow: 5 };

// Mirror flag controls whether to flip Y axis (for data augmentation)
function encode(self, opp, ball, field, gameState, powerUps, out, mirrorY = false) {
    const isRed = self.team === 'red';
    const fw = field.width;
    const fh = field.height;
    const fx = field.x;
    const fy = field.y;
    const fcx = field.centerX;
    const fcy = field.centerY;

    // Convert world -> agent-side coords. For blue, flip across centerX.
    const sideX = (x) => isRed ? (x - fx) / fw : (fx + fw - x) / fw; // [0..1]
    const sideY = (y) => {
        const v = (y - fy) / fh;
        return mirrorY ? (1 - v) : v; // [0..1]
    };
    const sideVx = (vx) => (isRed ? vx : -vx) / Physics.MAX_BALL_SPEED;
    const sideVy = (vy) => (mirrorY ? -vy : vy) / Physics.MAX_BALL_SPEED;

    let i = 0;

    // --- Self ---
    out[i++] = sideX(self.x) * 2 - 1;
    out[i++] = sideY(self.y) * 2 - 1;
    out[i++] = sideVx(self.vx);
    out[i++] = sideVy(self.vy);
    out[i++] = Math.min(self.kickCooldown / 200, 1);
    out[i++] = Math.min(self.pullCooldown / 8000, 1);
    // Powerup one-hot (4 main types — others handled via flags)
    out[i++] = self.powerUp === 'speed' ? 1 : 0;
    out[i++] = self.powerUp === 'ghost' ? 1 : 0;
    out[i++] = self.powerUp === 'shield' ? 1 : 0;
    out[i++] = self.powerUp === 'dash' ? 1 : 0;
    out[i++] = (self.powerUp === 'frozen') ? 1 : 0;
    out[i++] = (self.powerUp === 'slowed') ? 1 : 0;
    out[i++] = self.stunTimer > 0 ? 1 : 0;
    out[i++] = self.pullActive ? 1 : 0;

    // --- Opponent (relative to self in side coords) ---
    out[i++] = sideX(opp.x) - sideX(self.x);
    out[i++] = sideY(opp.y) - sideY(self.y);
    out[i++] = sideVx(opp.vx);
    out[i++] = sideVy(opp.vy);
    out[i++] = Math.min(opp.kickCooldown / 200, 1);
    out[i++] = opp.powerUp === 'speed' ? 1 : 0;
    out[i++] = opp.powerUp === 'ghost' ? 1 : 0;
    out[i++] = opp.powerUp === 'shield' ? 1 : 0;
    out[i++] = opp.powerUp === 'dash' ? 1 : 0;
    out[i++] = (opp.stunTimer > 0 || opp.powerUp === 'frozen') ? 1 : 0;

    // --- Ball ---
    const bx = sideX(ball.x);
    const by = sideY(ball.y);
    out[i++] = bx - sideX(self.x);
    out[i++] = by - sideY(self.y);
    out[i++] = sideVx(ball.vx);
    out[i++] = sideVy(ball.vy);
    out[i++] = ball.superKick > 0 ? 1 : 0;
    out[i++] = ball.ghost ? 1 : 0;
    // Possession: 1 = self touched last, -1 = opponent, 0 = neither
    out[i++] = ball.lastKickedBy === self ? 1 : (ball.lastKickedBy === opp ? -1 : 0);
    out[i++] = bx - sideX(opp.x); // ball relative to opponent (helps positioning)
    out[i++] = by - sideY(opp.y);

    // --- Predicted ball (15 frames ahead) ---
    const pred = predictBall(ball, 15);
    const pbx = sideX(pred.x);
    const pby = sideY(pred.y);
    out[i++] = pbx - sideX(self.x);
    out[i++] = pby - sideY(self.y);
    out[i++] = pbx - bx; // ball drift direction
    out[i++] = pby - by;

    // --- Goals (relative side coords) ---
    // Own goal is at sideX=0, opponent goal at sideX=1
    out[i++] = 0 - sideX(self.x); // dist to own goal x
    out[i++] = 1 - sideX(self.x); // dist to opp goal x
    const goalCenterY = (field.goalY + field.goalHeight / 2 - fy) / fh;
    const myGoalY = mirrorY ? (1 - goalCenterY) : goalCenterY;
    out[i++] = myGoalY - sideY(self.y);

    // --- Game state ---
    out[i++] = (gameState.timeLeft || 0) / 60000;
    out[i++] = Math.tanh((gameState.scoreDiff || 0) * 0.5);
    out[i++] = gameState.kickoffActive ? 1 : 0;

    // --- Shooting quality features (8) ---
    // These tell the agent: "If I kicked right now, would it score?"
    // Computing these once per encode is much cheaper than the network learning
    // to derive them from raw positions and velocities.
    const kickRange = self.radius + ball.radius + 21;
    const ballDistRaw = Math.sqrt((ball.x - self.x) * (ball.x - self.x) + (ball.y - self.y) * (ball.y - self.y));
    const inKickRange = ballDistRaw < kickRange;
    out[i++] = inKickRange ? 1 : 0;
    // Kick direction (player -> ball, the direction the ball would go if kicked now)
    const kdx = ball.x - self.x;
    const kdy = ball.y - self.y;
    const klen = Math.max(Math.sqrt(kdx * kdx + kdy * kdy), 1);
    const knx = kdx / klen;
    const kny = kdy / klen;
    // Vector from ball to opponent goal
    const oppGoalX = isRed ? (fx + fw) : fx;
    const goalCenterYAbs = field.goalY + field.goalHeight / 2;
    const tgx = oppGoalX - ball.x;
    const tgy = goalCenterYAbs - ball.y;
    const tglen = Math.max(Math.sqrt(tgx * tgx + tgy * tgy), 1);
    const tnx = tgx / tglen;
    const tny = tgy / tglen;
    // Cosine of angle between kick direction and direction-to-goal: 1 = perfect aim
    const aimDot = knx * tnx + kny * tny;
    out[i++] = aimDot;
    out[i++] = aimDot > 0.7 && inKickRange ? 1 : 0; // "shooting opportunity now"
    // Distance from current kick line to goal center (perpendicular distance)
    // This tells the agent how far off-line their kick would be.
    const perpDist = Math.abs(kdx * tny - kdy * tnx); // cross product magnitude
    out[i++] = Math.min(perpDist / fw, 1);
    // Vector from ball to opponent goal (in side coords)
    out[i++] = (isRed ? tgx : -tgx) / fw;
    out[i++] = (mirrorY ? -tgy : tgy) / fh;
    // Is opponent in the shooting lane? (along ball -> goal line)
    const opx = opp.x - ball.x;
    const opy = opp.y - ball.y;
    const oprojForward = opx * tnx + opy * tny;
    const oprojPerp = Math.abs(opx * tny - opy * tnx);
    const oppInLane = (oprojForward > 0 && oprojForward < tglen && oprojPerp < 50) ? 1 : 0;
    out[i++] = oppInLane;
    out[i++] = Math.min(tglen / fw, 1); // ball-to-goal distance, normalized

    // --- Nearest power-up ---
    let nearestPU = null;
    let nearestPUDist = Infinity;
    if (powerUps && powerUps.length) {
        for (const pu of powerUps) {
            const d = Physics.distance(self, pu);
            if (d < nearestPUDist) { nearestPUDist = d; nearestPU = pu; }
        }
    }
    if (nearestPU) {
        out[i++] = sideX(nearestPU.x) - sideX(self.x);
        out[i++] = sideY(nearestPU.y) - sideY(self.y);
        out[i++] = 1; // present
        const pid = (nearestPU.type && nearestPU.type.id) || nearestPU.id;
        const idx = POWERUP_INDEX[pid] !== undefined ? POWERUP_INDEX[pid] : -1;
        // Single scalar encoding type (saves features) plus binary "any-puj" flag
        out[i++] = idx >= 0 ? (idx + 1) / NUM_POWERUP_TYPES : 0;
    } else {
        out[i++] = 0;
        out[i++] = 0;
        out[i++] = 0;
        out[i++] = 0;
    }

    // Pad zeros to FEATURE_DIM exactly
    while (i < FEATURE_DIM) out[i++] = 0;
    return out;
}

// Predict ball using the same friction model as the game
function predictBall(ball, frames) {
    let x = ball.x, y = ball.y, vx = ball.vx, vy = ball.vy;
    const f = Physics.BALL_FRICTION;
    for (let i = 0; i < frames; i++) {
        vx *= f; vy *= f;
        x += vx; y += vy;
    }
    return { x, y };
}

// Decode actor logits into a usable game action. The actor outputs 5 numbers:
//   [0,1] mu_moveX, mu_moveY: continuous, squashed by tanh -> direction
//   [2]   mu_charge: continuous, squashed by sigmoid -> 0..1
//   [3]   kick_logit: discrete, sigmoid -> probability
//   [4]   pull_logit: discrete, sigmoid -> probability
//
// At training time we sample (Gaussian for continuous, Bernoulli for discrete);
// at runtime we take the deterministic mean.
function decodeActionDeterministic(self, ball, isRed, mirrorY, raw) {
    const mvx = Math.tanh(raw[0]);
    const mvy = Math.tanh(raw[1]);
    const charge = sigmoid(raw[2]);
    const kickP = sigmoid(raw[3]);
    const pullP = sigmoid(raw[4]);

    // Convert from side coords back to world
    const worldVx = isRed ? mvx : -mvx;
    const worldVy = mirrorY ? -mvy : mvy;
    return {
        moveX: worldVx,
        moveY: worldVy,
        charge: charge,
        kick: kickP > 0.5,
        pull: pullP > 0.5,
    };
}

function sigmoid(x) {
    if (x >= 0) {
        const z = Math.exp(-x);
        return 1 / (1 + z);
    } else {
        const z = Math.exp(x);
        return z / (1 + z);
    }
}

// FrameStack: tiny utility that keeps the last K encoded frames per side
// and produces the stacked input vector. Used by both env and runtime agent.
class FrameStack {
    constructor(featureDim, k) {
        this.featureDim = featureDim;
        this.k = k;
        this.frames = []; // length k, oldest first
        this.stacked = new Float32Array(featureDim * k);
    }
    // Replace all k slots with this single frame (used on reset / goal-reset)
    fill(frame) {
        this.frames = [];
        for (let i = 0; i < this.k; i++) this.frames.push(new Float32Array(frame));
        this._rebuild();
    }
    // Push a new frame, dropping the oldest
    push(frame) {
        this.frames.shift();
        this.frames.push(new Float32Array(frame));
        this._rebuild();
    }
    _rebuild() {
        const fd = this.featureDim;
        for (let i = 0; i < this.k; i++) {
            const f = this.frames[i];
            this.stacked.set(f, i * fd);
        }
    }
    get() { return this.stacked; }
}

return {
    FEATURE_DIM,
    STACK_K,
    STACKED_DIM,
    encode,
    decodeActionDeterministic,
    sigmoid,
    predictBall,
    FrameStack,
};

});
