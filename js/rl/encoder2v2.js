// State encoder for KickZone 2v2.
//
// Produces a self-centered observation for ONE player at a time. The same
// encoder is called per-player (the shared policy is applied 4 times per
// physics step — once for each agent — but each call sees the world from
// that specific player's perspective).
//
// Key design choices vs the 1v1 encoder:
//   - 1 teammate slot (rel pos + vel + status)
//   - 2 opponent slots, ALWAYS SORTED BY DISTANCE TO SELF (so the network
//     sees the same scene the same way regardless of opponent ID)
//   - Pass-target features: where would my kick land relative to teammate,
//     is the lane clear, does the teammate have a shooting opportunity from
//     where they are
//   - Spacing features: distance to teammate, "am I clustered"
//
// Symmetry: same isRed-flips-X / mirrorY trick as 1v1 so the policy only
// has to learn one frame.
(function(root, factory) {
    const Physics = (typeof require !== 'undefined') ? require('../../shared/physics') : root.Physics;
    const exp = factory(Physics);
    if (typeof module !== 'undefined' && module.exports) module.exports = exp;
    else root.RLEncoder2v2 = exp;
})(typeof self !== 'undefined' ? self : this, function(Physics) {

const FEATURE_DIM = 80;
const STACK_K = 3;
const STACKED_DIM = FEATURE_DIM * STACK_K;

// Compute features for ONE player.
//   self: this player (Player object)
//   teammate: the other player on self's team (or null if not present)
//   opps: [Player, Player] — both opponents
//   ball, field, gameState, powerUps: same as 1v1 encoder
function encode(self, teammate, opps, ball, field, gameState, powerUps, out, mirrorY = false) {
    const isRed = self.team === 'red';
    const fw = field.width;
    const fh = field.height;
    const fx = field.x;
    const fy = field.y;

    // World -> agent-side coords
    const sideX = (x) => isRed ? (x - fx) / fw : (fx + fw - x) / fw;
    const sideY = (y) => {
        const v = (y - fy) / fh;
        return mirrorY ? (1 - v) : v;
    };
    const sideVx = (vx) => (isRed ? vx : -vx) / Physics.MAX_BALL_SPEED;
    const sideVy = (vy) => (mirrorY ? -vy : vy) / Physics.MAX_BALL_SPEED;

    let i = 0;

    // ===== Self (14) =====
    out[i++] = sideX(self.x) * 2 - 1;
    out[i++] = sideY(self.y) * 2 - 1;
    out[i++] = sideVx(self.vx);
    out[i++] = sideVy(self.vy);
    out[i++] = Math.min(self.kickCooldown / 200, 1);
    out[i++] = Math.min(self.pullCooldown / 8000, 1);
    out[i++] = self.powerUp === 'speed' ? 1 : 0;
    out[i++] = self.powerUp === 'ghost' ? 1 : 0;
    out[i++] = self.powerUp === 'shield' ? 1 : 0;
    out[i++] = self.powerUp === 'dash' ? 1 : 0;
    out[i++] = (self.powerUp === 'frozen') ? 1 : 0;
    out[i++] = (self.powerUp === 'slowed') ? 1 : 0;
    out[i++] = self.stunTimer > 0 ? 1 : 0;
    out[i++] = self.pullActive ? 1 : 0;

    // ===== Teammate (9) — relative pose + minimal status =====
    if (teammate) {
        out[i++] = sideX(teammate.x) - sideX(self.x);
        out[i++] = sideY(teammate.y) - sideY(self.y);
        out[i++] = sideVx(teammate.vx);
        out[i++] = sideVy(teammate.vy);
        out[i++] = Math.min(teammate.kickCooldown / 200, 1);
        out[i++] = teammate.powerUp === 'speed' ? 1 : 0;
        out[i++] = teammate.powerUp === 'ghost' ? 1 : 0;
        out[i++] = teammate.powerUp === 'shield' ? 1 : 0;
        out[i++] = teammate.stunTimer > 0 ? 1 : 0;
    } else {
        for (let k = 0; k < 9; k++) out[i++] = 0;
    }

    // ===== Opponents (16) — SORTED BY DISTANCE TO SELF =====
    // Always closest first so the network sees a stable "nearest opponent" feature.
    const sortedOpps = opps.slice().sort((a, b) => Physics.distance(self, a) - Physics.distance(self, b));
    for (let oi = 0; oi < 2; oi++) {
        const o = sortedOpps[oi];
        if (o) {
            out[i++] = sideX(o.x) - sideX(self.x);
            out[i++] = sideY(o.y) - sideY(self.y);
            out[i++] = sideVx(o.vx);
            out[i++] = sideVy(o.vy);
            out[i++] = Math.min(o.kickCooldown / 200, 1);
            out[i++] = o.powerUp === 'speed' ? 1 : 0;
            out[i++] = o.powerUp === 'ghost' ? 1 : 0;
            out[i++] = (o.stunTimer > 0 || o.powerUp === 'frozen') ? 1 : 0;
        } else {
            for (let k = 0; k < 8; k++) out[i++] = 0;
        }
    }

    // ===== Ball (9) =====
    const bx = sideX(ball.x);
    const by = sideY(ball.y);
    out[i++] = bx - sideX(self.x);
    out[i++] = by - sideY(self.y);
    out[i++] = sideVx(ball.vx);
    out[i++] = sideVy(ball.vy);
    out[i++] = ball.superKick > 0 ? 1 : 0;
    out[i++] = ball.ghost ? 1 : 0;
    // Possession: 1 = my team has it, -1 = opp team, 0 = none
    let poss = 0;
    if (ball.lastKickedBy) {
        poss = (ball.lastKickedBy.team === self.team) ? 1 : -1;
    }
    out[i++] = poss;
    // Ball relative to teammate (helps the agent reason about giving/getting passes)
    if (teammate) {
        out[i++] = bx - sideX(teammate.x);
        out[i++] = by - sideY(teammate.y);
    } else {
        out[i++] = 0; out[i++] = 0;
    }

    // ===== Predicted ball 15 frames ahead (4) =====
    const pred = predictBall(ball, 15);
    const pbx = sideX(pred.x);
    const pby = sideY(pred.y);
    out[i++] = pbx - sideX(self.x);
    out[i++] = pby - sideY(self.y);
    out[i++] = pbx - bx;
    out[i++] = pby - by;

    // ===== Goals (3) =====
    out[i++] = 0 - sideX(self.x);  // dist to own goal x
    out[i++] = 1 - sideX(self.x);  // dist to opp goal x
    const goalCenterY = (field.goalY + field.goalHeight / 2 - fy) / fh;
    const myGoalY = mirrorY ? (1 - goalCenterY) : goalCenterY;
    out[i++] = myGoalY - sideY(self.y);

    // ===== Game state (3) =====
    out[i++] = (gameState.timeLeft || 0) / 60000;
    out[i++] = Math.tanh((gameState.scoreDiff || 0) * 0.5);
    out[i++] = gameState.kickoffActive ? 1 : 0;

    // ===== Shooting features (8) — same definitions as 1v1 =====
    const kickRange = self.radius + ball.radius + 21;
    const ballDistRaw = Math.sqrt((ball.x - self.x) * (ball.x - self.x) + (ball.y - self.y) * (ball.y - self.y));
    const inKickRange = ballDistRaw < kickRange;
    out[i++] = inKickRange ? 1 : 0;
    const kdx = ball.x - self.x;
    const kdy = ball.y - self.y;
    const klen = Math.max(Math.sqrt(kdx * kdx + kdy * kdy), 1);
    const knx = kdx / klen;
    const kny = kdy / klen;
    const oppGoalX = isRed ? (fx + fw) : fx;
    const goalCenterYAbs = field.goalY + field.goalHeight / 2;
    const tgx = oppGoalX - ball.x;
    const tgy = goalCenterYAbs - ball.y;
    const tglen = Math.max(Math.sqrt(tgx * tgx + tgy * tgy), 1);
    const tnx = tgx / tglen;
    const tny = tgy / tglen;
    const aimDot = knx * tnx + kny * tny;
    out[i++] = aimDot;
    out[i++] = aimDot > 0.7 && inKickRange ? 1 : 0;
    const perpDist = Math.abs(kdx * tny - kdy * tnx);
    out[i++] = Math.min(perpDist / fw, 1);
    out[i++] = (isRed ? tgx : -tgx) / fw;
    out[i++] = (mirrorY ? -tgy : tgy) / fh;
    // Is ANY opponent in the shooting lane? (the closer one is what matters most)
    let anyOppInLane = 0;
    for (const o of opps) {
        const opx = o.x - ball.x;
        const opy = o.y - ball.y;
        const oprojForward = opx * tnx + opy * tny;
        const oprojPerp = Math.abs(opx * tny - opy * tnx);
        if (oprojForward > 0 && oprojForward < tglen && oprojPerp < 50) {
            anyOppInLane = 1;
            break;
        }
    }
    out[i++] = anyOppInLane;
    out[i++] = Math.min(tglen / fw, 1);

    // ===== Pass features (6) — what would a pass to teammate look like? =====
    if (teammate) {
        // Vector from ball to teammate (where the pass would go)
        const ptx = teammate.x - ball.x;
        const pty = teammate.y - ball.y;
        const ptlen = Math.max(Math.sqrt(ptx * ptx + pty * pty), 1);
        const ptnx = ptx / ptlen;
        const ptny = pty / ptlen;
        // Cosine between my-current-kick-direction and direction-to-teammate.
        // High = if I kick now, ball goes toward teammate.
        const passAimDot = knx * ptnx + kny * ptny;
        out[i++] = passAimDot;
        // Distance to teammate (the longer, the harder the pass)
        out[i++] = Math.min(ptlen / fw, 1);
        // Is an opponent in the passing lane?
        let oppInPassLane = 0;
        for (const o of opps) {
            const opx = o.x - ball.x;
            const opy = o.y - ball.y;
            const oprojForward = opx * ptnx + opy * ptny;
            const oprojPerp = Math.abs(opx * ptny - opy * ptnx);
            if (oprojForward > 0 && oprojForward < ptlen && oprojPerp < 50) {
                oppInPassLane = 1;
                break;
            }
        }
        out[i++] = oppInPassLane;
        // If teammate received the ball at their position, what would their
        // shot quality be? (encourages passes that put teammate in good positions)
        const tToGoalX = oppGoalX - teammate.x;
        const tToGoalY = goalCenterYAbs - teammate.y;
        const tToGoalLen = Math.max(Math.sqrt(tToGoalX * tToGoalX + tToGoalY * tToGoalY), 1);
        out[i++] = Math.min(tToGoalLen / fw, 1);  // teammate-to-goal distance
        // Is teammate ahead of me toward opp goal? (passing forward is generally good)
        const teammateAhead = isRed ? (teammate.x > self.x) : (teammate.x < self.x);
        out[i++] = teammateAhead ? 1 : 0;
        // Teammate is in opponent half?
        const tInOppHalf = isRed ? (teammate.x > field.x + fw / 2) : (teammate.x < field.x + fw / 2);
        out[i++] = tInOppHalf ? 1 : 0;
    } else {
        for (let k = 0; k < 6; k++) out[i++] = 0;
    }

    // ===== Spacing features (2) =====
    if (teammate) {
        const teamDistRaw = Math.sqrt((teammate.x - self.x) ** 2 + (teammate.y - self.y) ** 2);
        out[i++] = Math.min(teamDistRaw / fw, 1);
        // Anti-clustering: 1 if teammate is uncomfortably close (<80 px)
        out[i++] = teamDistRaw < 80 ? 1 : 0;
    } else {
        out[i++] = 0; out[i++] = 0;
    }

    // Pad to FEATURE_DIM exactly
    while (i < FEATURE_DIM) out[i++] = 0;
    return out;
}

function predictBall(ball, frames) {
    let x = ball.x, y = ball.y, vx = ball.vx, vy = ball.vy;
    const f = Physics.BALL_FRICTION;
    for (let i = 0; i < frames; i++) {
        vx *= f; vy *= f;
        x += vx; y += vy;
    }
    return { x, y };
}

// Frame stacker — same shape as 1v1's, parameterized by FEATURE_DIM
class FrameStack {
    constructor(featureDim, k) {
        this.featureDim = featureDim;
        this.k = k;
        this.frames = [];
        this.stacked = new Float32Array(featureDim * k);
    }
    fill(frame) {
        this.frames = [];
        for (let i = 0; i < this.k; i++) this.frames.push(new Float32Array(frame));
        this._rebuild();
    }
    push(frame) {
        this.frames.shift();
        this.frames.push(new Float32Array(frame));
        this._rebuild();
    }
    _rebuild() {
        const fd = this.featureDim;
        for (let i = 0; i < this.k; i++) {
            this.stacked.set(this.frames[i], i * fd);
        }
    }
    get() { return this.stacked; }
}

return {
    FEATURE_DIM,
    STACK_K,
    STACKED_DIM,
    encode,
    predictBall,
    FrameStack,
};

});
