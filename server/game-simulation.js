// Headless authoritative game simulation (runs on server at 60Hz)
const Physics = require('../shared/physics');
const { Player, Ball, Field } = require('../shared/entities');
const AIController = require('../shared/ai');
const PowerUpManager = require('../shared/powerups');
const GameConstants = require('../shared/constants');

class GameSimulation {
    constructor(settings) {
        this.settings = settings;
        this.tickRate = GameConstants.TICK_RATE;
        this.tickNumber = 0;
        this.tickInterval = null;

        // Set virtual size based on map
        const mapInfo = GameConstants.MAPS[settings.map] || GameConstants.MAPS.classic;
        this.VIRTUAL_W = mapInfo.virtualW;
        this.VIRTUAL_H = mapInfo.virtualH;

        // Create field
        this.field = new Field(this.VIRTUAL_W, this.VIRTUAL_H, settings.map);

        // Create ball
        this.ball = new Ball(this.field.centerX, this.field.centerY);

        // Players and slots
        this.players = [];
        this.slots = []; // { player, team, isHuman, playerId, aiController }
        this.aiControllers = [];

        // Match state
        this.redScore = 0;
        this.blueScore = 0;
        this.timeRemaining = settings.duration * 1000;
        this.isRunning = false;
        this.isGoalScored = false;
        this.goalTimer = 0;
        this.kickoffTeam = null;
        this.kickoffActive = false;
        this.matchOver = false;

        this.timeScale = 1.0;
        this.slowMoTimer = 0;
        this.momentum = { red: 0, blue: 0, max: 5, decayRate: 0.0001 };
        this.combo = { team: null, count: 0 };
        this.suddenDeath = false;
        this.suddenDeathTimer = 0;
        this.suddenDeathMaxTime = 60000;
        this.suddenDeathShrink = 0;
        this._originalMaxBallSpeed = Physics.MAX_BALL_SPEED;

        this.stats = {
            possession: { red: 0, blue: 0 },
            shots: { red: 0, blue: 0 },
        };

        // Cached team arrays
        this._redTeam = [];
        this._blueTeam = [];

        // Cached player -> slot index map (avoids .find() in hot paths)
        this._playerSlotMap = new Map();

        // Input queues per slot
        this._inputQueues = {};

        // Power-ups
        this.powerUpManager = new PowerUpManager(this.field);
        this.powerUpManager.enabled = settings.powerups !== false;

        // Event buffer (flushed each state send)
        this.pendingEvents = [];

        // Callbacks
        this.onStateUpdate = null; // called at STATE_SEND_RATE
        this.onGoal = null;
        this.onMatchEnd = null;
        this.onEvent = null;

        // Apply map physics
        this._applyMapPhysics();

        // Create spawn positions
        this._spawnPositions = this._getSpawnPositions();
    }

    _applyMapPhysics() {
        if (this.settings.map === 'huge') {
            Physics.KICK_FORCE = 9.5 * 1.4;
            Physics.POWER_KICK_FORCE = 9.8 * 1.4;
            Physics.MAX_BALL_SPEED = 30 * 1.5;
            Physics.MAX_PLAYER_SPEED = 5.2 * 1.3;
        }
    }

    _getSpawnPositions() {
        const f = this.field;
        const positions = { red: [], blue: [] };
        const size = this.settings.teamSize;

        const redBaseX = f.x + f.width * 0.25;
        const blueBaseX = f.x + f.width * 0.75;

        if (size === 1) {
            positions.red.push({ x: redBaseX, y: f.centerY });
            positions.blue.push({ x: blueBaseX, y: f.centerY });
        } else {
            const spacing = f.height / (size + 1);
            for (let i = 0; i < size; i++) {
                const y = f.y + spacing * (i + 1);
                positions.red.push({ x: redBaseX + (i === 0 ? -30 : 30), y });
                positions.blue.push({ x: blueBaseX + (i === 0 ? 30 : -30), y });
            }
        }
        return positions;
    }

    // Add a player slot (human or AI)
    addSlot(team, playerId = null) {
        const teamSlots = this.slots.filter(s => s.team === team);
        if (teamSlots.length >= this.settings.teamSize) return null;

        const positions = this._spawnPositions;
        const idx = teamSlots.length;
        const pos = positions[team][idx];
        if (!pos) return null;

        const isHuman = playerId !== null;
        const player = new Player(pos.x, pos.y, team, isHuman);
        this.players.push(player);

        const slot = {
            index: this.slots.length,
            player,
            team,
            isHuman,
            playerId,
            aiController: isHuman ? null : new AIController('normal'),
        };

        this.slots.push(slot);
        this._playerSlotMap.set(player, slot);
        if (!isHuman) {
            this.aiControllers.push({ player, ai: slot.aiController });
        }

        this._inputQueues[slot.index] = { x: 0, y: 0, kickCharging: false, kickChargeTime: 0, kickRelease: false, switchPlayer: false, pull: false };

        this._rebuildTeamCache();
        return slot;
    }

    // Fill empty slots with AI
    fillWithAI() {
        const teamSize = this.settings.teamSize;
        const redCount = this.slots.filter(s => s.team === 'red').length;
        const blueCount = this.slots.filter(s => s.team === 'blue').length;

        for (let i = redCount; i < teamSize; i++) {
            this.addSlot('red');
        }
        for (let i = blueCount; i < teamSize; i++) {
            this.addSlot('blue');
        }
    }

    // Remove a human player (replace with AI)
    removePlayer(playerId) {
        const slot = this.slots.find(s => s.playerId === playerId);
        if (!slot) return;

        slot.isHuman = false;
        slot.playerId = null;
        slot.player.isHuman = false;
        slot.aiController = new AIController('normal');
        this.aiControllers.push({ player: slot.player, ai: slot.aiController });
    }

    _rebuildTeamCache() {
        this._redTeam = this.players.filter(p => p.team === 'red');
        this._blueTeam = this.players.filter(p => p.team === 'blue');
    }

    // Get slot for a player ID
    getSlot(playerId) {
        return this.slots.find(s => s.playerId === playerId);
    }

    // Apply input from a remote player
    // IMPORTANT: One-shot events (kickRelease, switchPlayer) must be OR'd,
    // not overwritten — otherwise they get lost if another input arrives
    // before the server tick processes them.
    applyInput(playerId, input) {
        const slot = this.slots.find(s => s.playerId === playerId);
        if (!slot) return;
        const q = this._inputQueues[slot.index];
        q.x = (input.x || 0) / 100; // client sends *100 integer
        q.y = (input.y || 0) / 100;
        q.kickCharging = !!(input.kc || input.kickCharging);
        q.kickChargeTime = input.kt || input.kickChargeTime || 0;
        // OR one-shot events so they survive until consumed by tick()
        q.kickRelease = q.kickRelease || !!(input.kr || input.kickRelease);
        q.switchPlayer = q.switchPlayer || !!(input.sp || input.switchPlayer);
        q.pull = !!(input.pl || input.pull);
    }

    start() {
        this.isRunning = true;
        this.tickInterval = setInterval(() => this.tick(), 1000 / this.tickRate);
    }

    stop() {
        this.isRunning = false;
        if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
        }
    }

    tick() {
        if (!this.isRunning) return;

        const dt = GameConstants.TICK_MS;
        this.tickNumber++;

        // Goal celebration pause
        if (this.isGoalScored) {
            this.goalTimer -= dt;
            if (this.goalTimer <= 0) {
                this.isGoalScored = false;
                this._resetAfterGoal();
            }
            // Still send state during goal pause
            this._maybeSendState();
            return;
        }

        // Slow-motion recovery
        if (this.slowMoTimer > 0) {
            this.slowMoTimer -= dt;
            if (this.slowMoTimer <= 0) {
                this.timeScale = 1.0;
                this.slowMoTimer = 0;
            }
        }

        const scaledDt = dt * this.timeScale;
        Physics.dtRatio = (scaledDt / 16.67) * Physics.GAME_SPEED;

        // Timer
        if (this.suddenDeath) {
            this.suddenDeathTimer += dt;
            this.suddenDeathShrink = Math.min(this.suddenDeathTimer / this.suddenDeathMaxTime, 1);
            Physics.MAX_BALL_SPEED = this._originalMaxBallSpeed + this.suddenDeathShrink * 10;

            if (this.suddenDeathTimer >= this.suddenDeathMaxTime) {
                this._endMatch();
                return;
            }
        } else {
            this.timeRemaining -= dt;
            if (this.timeRemaining <= 0) {
                this.timeRemaining = 0;
                if (this.redScore === this.blueScore) {
                    this.suddenDeath = true;
                    this.suddenDeathTimer = 0;
                    this.suddenDeathShrink = 0;
                    this.ball.reset();
                    for (const p of this.players) p.reset();
                    this.powerUpManager.reset();
                    this._emitEvent('sudden_death', {});
                } else {
                    this._endMatch();
                    return;
                }
            }
        }

        // Momentum decay
        this.momentum.red = Math.max(0, this.momentum.red - this.momentum.decayRate * scaledDt);
        this.momentum.blue = Math.max(0, this.momentum.blue - this.momentum.decayRate * scaledDt);
        for (const p of this.players) {
            p.momentumBonus = this.momentum[p.team] / this.momentum.max;
        }

        // Process human inputs
        for (const slot of this.slots) {
            if (!slot.isHuman) continue;
            const input = this._inputQueues[slot.index];
            const p = slot.player;

            if (p.powerUp === 'frozen' || p.stunTimer > 0) continue;

            p.applyInput(input.x, input.y);

            if (input.kickCharging) {
                p.kickChargeRatio = Math.min(input.kickChargeTime / 1500, 1);
                const slowFactor = 1 - p.kickChargeRatio * 0.015;
                p.vx *= Math.pow(slowFactor, Physics.dtRatio);
                p.vy *= Math.pow(slowFactor, Physics.dtRatio);
            } else {
                p.kickChargeRatio = 0;
            }

            if (input.kickRelease) {
                const chargeRatio = Math.min(input.kickChargeTime / 1500, 1);
                this._hitNearbyPlayers(p, chargeRatio);
                if (p.kick(this.ball, chargeRatio)) {
                    this.stats.shots[p.team]++;
                    const towardGoal = (p.team === 'red' && this.ball.vx > 0) || (p.team === 'blue' && this.ball.vx < 0);
                    if (towardGoal) this._addMomentum(p.team);
                    this._emitEvent('kick', { slot: slot.index, charge: chargeRatio, bx: this.ball.x, by: this.ball.y });
                }
                input.kickRelease = false;
                input.kickChargeTime = 0;
            }

            if (input.switchPlayer) {
                this._switchPlayer(slot);
                input.switchPlayer = false;
            }
        }

        // AI input
        const redTeam = this._redTeam;
        const blueTeam = this._blueTeam;

        for (const { player, ai } of this.aiControllers) {
            if (player.powerUp === 'frozen' || player.stunTimer > 0) continue;

            const teammates = player.team === 'red' ? redTeam : blueTeam;
            const opponents = player.team === 'red' ? blueTeam : redTeam;
            const action = ai.update(player, this.ball, this.field, teammates, opponents, scaledDt);

            if (action.kick) {
                const cr = action.chargeRatio || 0.3;
                this._hitNearbyPlayers(player, cr);
                if (player.kick(this.ball, cr)) {
                    this.stats.shots[player.team]++;
                    const towardGoal = (player.team === 'red' && this.ball.vx > 0) || (player.team === 'blue' && this.ball.vx < 0);
                    if (towardGoal) this._addMomentum(player.team);
                    const slotIdx = (this._playerSlotMap.get(player)?.index ?? -1);
                    this._emitEvent('kick', { slot: slotIdx, charge: cr, bx: this.ball.x, by: this.ball.y });
                }
            }
        }

        // Super kick homing
        if (this.ball.superKick > 0 && this.ball.superTarget) {
            const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
            if (ballSpeed > 3) {
                const goalX = this.ball.superTarget === 'right' ? this.field.x + this.field.width : this.field.x;
                const goalY = this.field.goalY + this.field.goalHeight / 2;
                const toGoalX = goalX - this.ball.x;
                const toGoalY = goalY - this.ball.y;
                const toGoalN = Physics.normalize(toGoalX, toGoalY);
                const steerForce = 0.12 * Physics.dtRatio;
                this.ball.vx += toGoalN.x * steerForce;
                this.ball.vy += toGoalN.y * steerForce;
                Physics.clampSpeed(this.ball, ballSpeed);
            } else {
                this.ball.superTarget = null;
            }
        }

        // Dash power-up
        for (const p of this.players) {
            if (p.dashReady && p.powerUp === 'dash') {
                let dx = p.vx, dy = p.vy;
                const speed = Math.sqrt(dx * dx + dy * dy);
                if (speed > 0.5) {
                    const n = Physics.normalize(dx, dy);
                    const dashDist = 80;
                    const oldX = p.x, oldY = p.y;
                    p.x += n.x * dashDist;
                    p.y += n.y * dashDist;
                    for (const opp of this.players) {
                        if (opp.team === p.team || opp.stunTimer > 0) continue;
                        const dist = Physics.distance(p, opp);
                        const distOld = Physics.distance({ x: oldX, y: oldY }, opp);
                        if (dist < p.radius + opp.radius + 20 || distOld < p.radius + opp.radius + 20) {
                            opp.stunTimer = 400;
                            const knockN = Physics.normalize(opp.x - p.x, opp.y - p.y);
                            opp.vx = knockN.x * 3;
                            opp.vy = knockN.y * 3;
                        }
                    }
                    const slotIdx = (this._playerSlotMap.get(p)?.index ?? -1);
                    this._emitEvent('dash', { slot: slotIdx, fromX: oldX, fromY: oldY, toX: p.x, toY: p.y });
                }
                p.dashReady = false;
                p.powerUp = null;
                p.powerUpTimer = 0;
            }
        }

        // Ball pull
        const pullMaxRange = 150;
        for (const p of this.players) {
            if (p.pullActive) {
                const dist = Physics.distance(p, this.ball);
                if (dist >= pullMaxRange) {
                    p.pullActive = false;
                    p.pullCooldown = p.pullCooldownTime;
                } else if (dist > p.radius + this.ball.radius + 5) {
                    const dx = p.x - this.ball.x;
                    const dy = p.y - this.ball.y;
                    const n = Physics.normalize(dx, dy);
                    const falloff = 1 - (dist / pullMaxRange);
                    const pullStrength = 0.25 * falloff * Physics.dtRatio;
                    this.ball.vx += n.x * pullStrength;
                    this.ball.vy += n.y * pullStrength;
                    this.ball.vx *= Math.pow(0.985, Physics.dtRatio);
                    this.ball.vy *= Math.pow(0.985, Physics.dtRatio);
                }
            }
        }

        // Handle pull input for human players
        for (const slot of this.slots) {
            if (!slot.isHuman) continue;
            const input = this._inputQueues[slot.index];
            const p = slot.player;

            if (input.pull && !p.pullActive && p.pullCooldown <= 0 && Physics.distance(p, this.ball) < pullMaxRange) {
                p.activatePull();
            }
            if (!input.pull && p.pullActive) {
                p.pullActive = false;
                p.pullDuration = 0;
                p.pullCooldown = p.pullCooldownTime;
            }
        }

        // Update entities
        for (const p of this.players) p.update(scaledDt);
        this.ball.update(scaledDt, true); // skipTrail = true on server

        // Player-ball collisions
        for (const p of this.players) {
            if (this.ball.ghost && this.ball.lastKickedBy && p !== this.ball.lastKickedBy) continue;

            if (this.ball.fireLevel > 0 && this.ball.lastKickedBy && p.team !== this.ball.lastKickedBy.team) {
                const dist = Physics.distance(p, this.ball);
                if (dist < p.radius + this.ball.radius && p.stunTimer <= 0 && p.powerUp !== 'shield') {
                    p.stunTimer = 600;
                    const knockDir = Physics.normalize(p.x - this.ball.x, p.y - this.ball.y);
                    p.vx = knockDir.x * 4;
                    p.vy = knockDir.y * 4;
                    this.ball.vx *= 0.9;
                    this.ball.vy *= 0.9;
                    this._emitEvent('fire_pierce', { px: p.x, py: p.y, fireLevel: this.ball.fireLevel });
                    continue;
                }
            }

            const collided = Physics.resolveCircleCollision(p, this.ball, Physics.PLAYER_BOUNCE, Physics.BALL_BOUNCE);

            if (this.kickoffActive && p.team === this.kickoffTeam) {
                if (collided || this.ball.lastKickedBy === p) {
                    this.kickoffActive = false;
                }
            }

            if (collided) {
                const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
                if (ballSpeed > 3) this.ball.lastKickedBy = p;

                if (ballSpeed / Physics.MAX_BALL_SPEED > 0.15) {
                    this._emitEvent('ball_hit', { x: this.ball.x, y: this.ball.y, intensity: Math.min(ballSpeed / Physics.MAX_BALL_SPEED, 1) });
                }
            }

            // Auto kick on contact for human players charging
            if (collided) {
                const slot = (() => { const _s = this._playerSlotMap.get(p); return _s && _s.isHuman ? _s : null; })();
                if (slot) {
                    const input = this._inputQueues[slot.index];
                    if (input.kickCharging) {
                        const cr = p.kickChargeRatio || 0.1;
                        p.kick(this.ball, cr);
                        this.stats.shots[p.team]++;
                        this._emitEvent('kick', { slot: slot.index, charge: cr, bx: this.ball.x, by: this.ball.y });
                        input.kickCharging = false;
                        input.kickRelease = false;
                        input.kickChargeTime = 0;
                        p.kickChargeRatio = 0;
                    }
                }
            }

            // Knockback from power kicks
            if (collided && this.ball.lastKickedBy && p !== this.ball.lastKickedBy && p.powerUp !== 'shield') {
                const ballSpeed = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
                const speedRatio = ballSpeed / Physics.MAX_BALL_SPEED;
                if (this.ball.superKick > 0) {
                    p.stunTimer = 600 + speedRatio * 600;
                    if (ballSpeed > 0.5) {
                        const knockbackForce = 3 + speedRatio * 8;
                        const nx = this.ball.vx / ballSpeed;
                        const ny = this.ball.vy / ballSpeed;
                        p.vx += nx * knockbackForce;
                        p.vy += ny * knockbackForce;
                    }
                } else if (ballSpeed > 8) {
                    p.stunTimer = 200 + speedRatio * 400;
                    const knockbackForce = 1.5 + speedRatio * 4;
                    const nx = this.ball.vx / ballSpeed;
                    const ny = this.ball.vy / ballSpeed;
                    p.vx += nx * knockbackForce;
                    p.vy += ny * knockbackForce;
                }
            }
        }

        // Player-player collisions
        for (let i = 0; i < this.players.length; i++) {
            for (let j = i + 1; j < this.players.length; j++) {
                Physics.resolveCircleCollision(this.players[i], this.players[j], Physics.PLAYER_BOUNCE, Physics.PLAYER_BOUNCE);
            }
        }

        // Sudden death field shrink
        if (this.suddenDeath && this.suddenDeathShrink > 0) {
            const maxShrink = 0.15;
            const s = this.suddenDeathShrink * maxShrink;
            const shrinkX = this.field.width * s;
            const shrinkY = this.field.height * s;
            const origX = this.field.x, origY = this.field.y, origW = this.field.width, origH = this.field.height;
            this.field.x += shrinkX;
            this.field.y += shrinkY;
            this.field.width -= shrinkX * 2;
            this.field.height -= shrinkY * 2;
            for (const p of this.players) Physics.constrainToField(p, this.field, true);
            this.field.x = origX; this.field.y = origY;
            this.field.width = origW; this.field.height = origH;
        } else {
            for (const p of this.players) Physics.constrainToField(p, this.field, true);
        }

        // Kickoff restrictions
        if (this.kickoffActive && this.kickoffTeam) {
            const centerX = this.field.centerX;
            const centerY = this.field.centerY;
            const circleR = this.field.centerRadius;
            const scoringTeam = this.kickoffTeam === 'red' ? 'blue' : 'red';

            for (const p of this.players) {
                const dx = p.x - centerX;
                const dy = p.y - centerY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const insideCircle = dist < circleR;

                if (p.team === scoringTeam) {
                    if (scoringTeam === 'red') {
                        if (p.x + p.radius > centerX) { p.x = centerX - p.radius; if (p.vx > 0) p.vx = 0; }
                    } else {
                        if (p.x - p.radius < centerX) { p.x = centerX + p.radius; if (p.vx < 0) p.vx = 0; }
                    }
                    const minDist = circleR + p.radius;
                    if (dist < minDist && dist > 0) {
                        const nx = dx / dist, ny = dy / dist;
                        p.x = centerX + nx * minDist;
                        p.y = centerY + ny * minDist;
                        const dot = p.vx * nx + p.vy * ny;
                        if (dot < 0) { p.vx -= dot * nx; p.vy -= dot * ny; }
                    }
                } else {
                    const onOppSide = (p.team === 'red' && p.x + p.radius > centerX) ||
                                       (p.team === 'blue' && p.x - p.radius < centerX);
                    if (onOppSide) {
                        if (insideCircle) {
                            if (dist > circleR - 1 && dist > 0) {
                                const nx = dx / dist, ny = dy / dist;
                                p.x = centerX + nx * (circleR - 1);
                                p.y = centerY + ny * (circleR - 1);
                                const dot = p.vx * nx + p.vy * ny;
                                if (dot > 0) { p.vx -= dot * nx; p.vy -= dot * ny; }
                            }
                        } else {
                            if (p.team === 'red') { p.x = centerX - p.radius; if (p.vx > 0) p.vx = 0; }
                            else { p.x = centerX + p.radius; if (p.vx < 0) p.vx = 0; }
                        }
                    }
                }
            }
        }

        // Ball wall constraint
        const wallHit = Physics.constrainToField(this.ball, this.field, false);
        if (wallHit) {
            const spd = Math.sqrt(this.ball.vx * this.ball.vx + this.ball.vy * this.ball.vy);
            this._emitEvent('wall_bounce', { x: this.ball.x, y: this.ball.y, speed: spd });
            if (this.ball.fireLevel === 1 && spd > 6) {
                this.ball.ignite(2);
            }
        }

        // Possession tracking
        let closestRed = Infinity, closestBlue = Infinity;
        for (const p of this.players) {
            const d = Physics.distance(p, this.ball);
            if (p.team === 'red' && d < closestRed) closestRed = d;
            if (p.team === 'blue' && d < closestBlue) closestBlue = d;
        }
        if (closestRed < closestBlue) this.stats.possession.red += scaledDt;
        else this.stats.possession.blue += scaledDt;

        // Power-ups
        const collected = this.powerUpManager.update(scaledDt, this.players, this.suddenDeath);
        if (collected) {
            const slotIdx = (this._playerSlotMap.get(collected.player)?.index ?? -1);
            this._emitEvent('powerup_collect', { slot: slotIdx, type: collected.type.id });
        }

        // Check goal
        if (!this.isGoalScored) {
            const goal = Physics.checkGoal(this.ball, this.field);
            if (goal) {
                this._scoreGoal(goal);
            }
        }

        this._maybeSendState();
    }

    _maybeSendState() {
        // Send state at STATE_SEND_RATE (every N ticks)
        const ticksPerState = Math.round(this.tickRate / GameConstants.STATE_SEND_RATE);
        if (this.tickNumber % ticksPerState === 0 && this.onStateUpdate) {
            this.onStateUpdate(this.getStateSnapshot());
        }
    }

    _scoreGoal(team) {
        const fireLevel = this.ball.fireLevel || 0;
        const goalPoints = fireLevel >= 2 ? 3 : fireLevel >= 1 ? 2 : 1;

        if (team === 'red') this.redScore += goalPoints;
        else this.blueScore += goalPoints;

        const scorer = this.ball.lastKickedBy;
        const isOwnGoal = scorer && scorer.team !== team;
        if (scorer && !isOwnGoal) scorer.goals += goalPoints;

        if (team === this.combo.team) this.combo.count++;
        else this.combo = { team, count: 1 };

        this.isGoalScored = true;
        this.goalTimer = GameConstants.GOAL_PAUSE_MS;
        this.kickoffTeam = team === 'red' ? 'blue' : 'red';

        this.timeScale = 0.3;
        this.slowMoTimer = fireLevel >= 1 ? 1200 : 800;
        this._addMomentum(team, 2);

        const scorerSlot = scorer ? (this._playerSlotMap.get(scorer)?.index ?? -1) : -1;

        if (this.onGoal) {
            this.onGoal({
                team,
                scorer: scorerSlot,
                fireLevel,
                goalPoints,
                isOwnGoal,
                combo: this.combo.count,
                redScore: this.redScore,
                blueScore: this.blueScore,
            });
        }

        // Sudden death: first goal wins
        if (this.suddenDeath) {
            setTimeout(() => this._endMatch(), 2100);
            return;
        }

        // Check goal limit
        if (this.settings.goalLimit > 0) {
            if (this.redScore >= this.settings.goalLimit || this.blueScore >= this.settings.goalLimit) {
                setTimeout(() => this._endMatch(), 2100);
            }
        }
    }

    _resetAfterGoal() {
        this.ball.reset();
        for (const p of this.players) p.reset();
        this.powerUpManager.reset();
        this.kickoffActive = true;
    }

    _endMatch() {
        this.isRunning = false;
        this.matchOver = true;
        this.stop();

        if (this.onMatchEnd) {
            this.onMatchEnd({
                redScore: this.redScore,
                blueScore: this.blueScore,
                stats: this.stats,
            });
        }
    }

    _hitNearbyPlayers(kicker, chargeRatio) {
        if (chargeRatio < 0.25) return;
        const hitRange = kicker.radius + 40;
        const knockForce = 1.5 + chargeRatio * 3.5;
        for (const p of this.players) {
            if (p === kicker || p.team === kicker.team) continue;
            const dist = Physics.distance(kicker, p);
            if (dist < hitRange && dist > 0) {
                const dx = p.x - kicker.x;
                const dy = p.y - kicker.y;
                const n = Physics.normalize(dx, dy);
                p.vx += n.x * knockForce;
                p.vy += n.y * knockForce;
                p.stunTimer = 200 + chargeRatio * 800;
                this._emitEvent('stun', { px: p.x, py: p.y, intensity: chargeRatio });
            }
        }
    }

    _addMomentum(team, amount = 1) {
        this.momentum[team] = Math.min(this.momentum.max, this.momentum[team] + amount);
    }

    _switchPlayer(slot) {
        const p = slot.player;
        const teammates = this.players.filter(t => t.team === p.team && t !== p);
        if (teammates.length === 0) return;

        let nearest = null, nearestDist = Infinity;
        for (const t of teammates) {
            const d = Physics.distance(t, this.ball);
            if (d < nearestDist) { nearestDist = d; nearest = t; }
        }

        if (nearest) {
            // Old player becomes AI
            p.isHuman = false;
            const ai = new AIController('normal');
            slot.aiController = null; // will be replaced
            this.aiControllers.push({ player: p, ai });

            // New player becomes human
            nearest.isHuman = true;
            this.aiControllers = this.aiControllers.filter(c => c.player !== nearest);

            // Update slot reference
            const nearestSlot = this._playerSlotMap.get(nearest);
            if (nearestSlot) {
                // Swap: give the human's playerId to the nearest slot
                nearestSlot.isHuman = true;
                nearestSlot.playerId = slot.playerId;
                nearestSlot.aiController = null;

                slot.isHuman = false;
                slot.playerId = null;
                slot.aiController = ai;

                // Notify client of slot change
                this._emitEvent('switch_player', {
                    oldSlot: slot.index,
                    newSlot: nearestSlot.index,
                });
            }
        }
    }

    _emitEvent(type, data) {
        this.pendingEvents.push({ type, data });
        if (this.onEvent) {
            this.onEvent({ type, data });
        }
    }

    getStateSnapshot() {
        // Reuse cached snapshot object to minimize GC pressure
        if (!this._snapshot) {
            this._snapshot = {
                tick: 0,
                p: this.players.map(p => ({ x: 0, y: 0, vx: 0, vy: 0, s: 0, k: 0, pu: null, pt: 0, pa: 0, pc: 0, t: p.team })),
                b: { x: 0, y: 0, vx: 0, vy: 0, sp: 0, sk: 0, st: null, fl: 0, gh: 0 },
                rs: 0, bs: 0, t: 0, sd: 0, sds: 0, ka: 0, kt: null, ig: 0, ts: 1, pu: [],
            };
        }
        const snap = this._snapshot;
        snap.tick = this.tickNumber;

        for (let i = 0; i < this.players.length; i++) {
            const p = this.players[i];
            const sp = snap.p[i];
            sp.x = (p.x * 10 + 0.5) | 0; sp.x /= 10;
            sp.y = (p.y * 10 + 0.5) | 0; sp.y /= 10;
            sp.vx = (p.vx * 100 + 0.5) | 0; sp.vx /= 100;
            sp.vy = (p.vy * 100 + 0.5) | 0; sp.vy /= 100;
            sp.s = p.stunTimer | 0;
            sp.k = (p.kickChargeRatio * 100 + 0.5) | 0; sp.k /= 100;
            sp.pu = p.powerUp;
            sp.pt = p.powerUpTimer | 0;
            sp.pa = p.pullActive ? 1 : 0;
            sp.pc = p.pullCooldown | 0;
        }

        const b = this.ball;
        const sb = snap.b;
        sb.x = (b.x * 10 + 0.5) | 0; sb.x /= 10;
        sb.y = (b.y * 10 + 0.5) | 0; sb.y /= 10;
        sb.vx = (b.vx * 100 + 0.5) | 0; sb.vx /= 100;
        sb.vy = (b.vy * 100 + 0.5) | 0; sb.vy /= 100;
        sb.sp = (b.spin * 100 + 0.5) | 0; sb.sp /= 100;
        sb.sk = b.superKick > 0 ? 1 : 0;
        sb.st = b.superTarget;
        sb.fl = b.fireLevel;
        sb.gh = b.ghost ? 1 : 0;

        snap.rs = this.redScore;
        snap.bs = this.blueScore;
        snap.t = this.timeRemaining | 0;
        snap.sd = this.suddenDeath ? 1 : 0;
        snap.sds = (this.suddenDeathShrink * 1000 + 0.5) | 0; snap.sds /= 1000;
        snap.ka = this.kickoffActive ? 1 : 0;
        snap.kt = this.kickoffTeam;
        snap.ig = this.isGoalScored ? 1 : 0;
        snap.ts = this.timeScale;

        // Power-ups — rebuild only the array portion
        const pups = this.powerUpManager.powerUps;
        snap.pu.length = pups.length;
        for (let i = 0; i < pups.length; i++) {
            if (!snap.pu[i]) snap.pu[i] = { x: 0, y: 0, tid: '' };
            snap.pu[i].x = pups[i].x | 0;
            snap.pu[i].y = pups[i].y | 0;
            snap.pu[i].tid = pups[i].type.id;
        }

        return snap;
    }
}

module.exports = GameSimulation;
