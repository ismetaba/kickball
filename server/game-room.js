// A single game room with lobby + match lifecycle
const { ROOM_STATE, MSG } = require('./protocol');
const GameSimulation = require('./game-simulation');
const GameConstants = require('./../shared/constants');

// Coerce client-supplied room settings to known-good values. Everything here
// drives timers and array sizing in the simulation, so unvalidated values are
// a robustness/DoS hazard — reject anything not on the whitelist.
function sanitizeSettings(settings = {}) {
    const teamSize = Number(settings.teamSize);
    const duration = Number(settings.duration);
    const goalLimit = Number(settings.goalLimit);
    return {
        teamSize: Number.isInteger(teamSize) && teamSize >= 1 && teamSize <= GameConstants.MAX_TEAM_SIZE
            ? teamSize : 2,
        duration: GameConstants.DURATIONS.includes(duration) ? duration : 180,
        goalLimit: GameConstants.GOAL_LIMITS.includes(goalLimit) ? goalLimit : 5,
        powerups: settings.powerups !== false,
        map: GameConstants.MAPS[settings.map] ? settings.map : 'classic',
    };
}

class GameRoom {
    constructor(roomCode, hostId, hostWs, hostName, settings) {
        this.roomCode = roomCode;
        this.state = ROOM_STATE.WAITING;
        this.settings = sanitizeSettings(settings);
        this.createdAt = Date.now();
        this.hostId = hostId;

        // Connected players: playerId -> { ws, name, team, slotIndex }
        this.players = new Map();
        this.simulation = null;

        // Optional hook fired once when the match ends naturally, so the
        // RoomManager can release this room's resources promptly.
        this.onFinished = null;

        // Add host
        this.players.set(hostId, { ws: hostWs, name: hostName, team: 'red', slotIndex: null });
    }

    get maxPlayers() {
        return this.settings.teamSize * 2;
    }

    get playerCount() {
        return this.players.size;
    }

    addPlayer(playerId, ws, name, preferredTeam) {
        if (this.players.size >= this.maxPlayers) return false;
        if (this.state !== ROOM_STATE.WAITING) return false;

        // Auto-assign team
        const redCount = [...this.players.values()].filter(p => p.team === 'red').length;
        const blueCount = [...this.players.values()].filter(p => p.team === 'blue').length;

        let team = preferredTeam;
        if (!team || (team === 'red' && redCount >= this.settings.teamSize) || (team === 'blue' && blueCount >= this.settings.teamSize)) {
            team = redCount <= blueCount ? 'red' : 'blue';
        }

        this.players.set(playerId, { ws, name, team, slotIndex: null });
        this._broadcastRoomUpdate();
        return true;
    }

    removePlayer(playerId) {
        const player = this.players.get(playerId);
        if (!player) return;

        this.players.delete(playerId);

        // If match is running, replace with AI
        if (this.simulation && this.state === ROOM_STATE.PLAYING) {
            this.simulation.removePlayer(playerId);
        }

        // If host left, assign new host or close room
        if (playerId === this.hostId) {
            const remaining = [...this.players.keys()];
            if (remaining.length > 0) {
                this.hostId = remaining[0];
            } else {
                // Room is empty — will be cleaned up
                this.state = ROOM_STATE.FINISHED;
                if (this.simulation) this.simulation.stop();
                return;
            }
        }

        this._broadcastRoomUpdate();
    }

    switchTeam(playerId, newTeam) {
        const player = this.players.get(playerId);
        if (!player || this.state !== ROOM_STATE.WAITING) return;

        const teamCount = [...this.players.values()].filter(p => p.team === newTeam).length;
        if (teamCount >= this.settings.teamSize) return;

        player.team = newTeam;
        this._broadcastRoomUpdate();
    }

    startMatch() {
        if (this.state !== ROOM_STATE.WAITING) return;
        this.state = ROOM_STATE.PLAYING;

        this.simulation = new GameSimulation(this.settings);

        // Add human players
        for (const [playerId, playerData] of this.players) {
            const slot = this.simulation.addSlot(playerData.team, playerId);
            if (slot) {
                playerData.slotIndex = slot.index;
            }
        }

        // Fill remaining slots with AI
        this.simulation.fillWithAI();

        // Wire up callbacks
        this.simulation.onStateUpdate = (state) => {
            this._broadcastToAll(MSG.STATE, state);
        };

        this.simulation.onGoal = (data) => {
            this._broadcastToAll(MSG.GOAL, data);
        };

        this.simulation.onMatchEnd = (data) => {
            this.state = ROOM_STATE.FINISHED;
            this._broadcastToAll(MSG.MATCH_END, data);
            if (this.onFinished) this.onFinished();
        };

        this.simulation.onEvent = (event) => {
            this._broadcastToAll(MSG.EVENT, event);
        };

        // Tell clients the match is starting with their slot info
        for (const [playerId, playerData] of this.players) {
            // Defense-in-depth: a player with no simulation slot (e.g. the room
            // somehow over-filled a team) must not be told the match started —
            // they'd be an invisible, uncontrollable non-participant. Notify and
            // skip them instead.
            if (playerData.slotIndex === null) {
                this._sendTo(playerId, MSG.ERROR, { message: 'No slot available for this match' });
                continue;
            }
            this._sendTo(playerId, MSG.MATCH_STARTING, {
                yourSlot: playerData.slotIndex,
                settings: this.settings,
                slots: this.simulation.slots.map(s => ({
                    index: s.index,
                    team: s.team,
                    isHuman: s.isHuman,
                    playerId: s.playerId,
                    name: s.playerId ? (this.players.get(s.playerId)?.name || 'Player') : 'AI',
                })),
            });
        }

        // Start the simulation
        this.simulation.start();
    }

    handleInput(playerId, input) {
        if (!this.simulation || this.state !== ROOM_STATE.PLAYING) return;
        this.simulation.applyInput(playerId, input);
    }

    // Get lobby-friendly info
    getLobbyInfo() {
        return {
            roomCode: this.roomCode,
            hostName: this.players.get(this.hostId)?.name || 'Unknown',
            teamSize: this.settings.teamSize,
            map: this.settings.map,
            playerCount: this.playerCount,
            maxPlayers: this.maxPlayers,
        };
    }

    getSlotInfo() {
        const slots = [];
        for (const [playerId, data] of this.players) {
            slots.push({
                playerId,
                name: data.name,
                team: data.team,
                isHost: playerId === this.hostId,
            });
        }
        return slots;
    }

    _broadcastRoomUpdate() {
        const data = {
            slots: this.getSlotInfo(),
            settings: this.settings,
            hostId: this.hostId,
        };
        for (const [playerId] of this.players) {
            this._sendTo(playerId, MSG.ROOM_UPDATE, data);
        }
    }

    _broadcastToAll(type, data) {
        // Serialize once, send to all — avoids N * JSON.stringify
        const msg = JSON.stringify({ t: type, d: data });
        for (const [, playerData] of this.players) {
            if (playerData.ws && playerData.ws.readyState === 1) {
                try { playerData.ws.send(msg); } catch(e) {}
            }
        }
    }

    _sendTo(playerId, type, data) {
        const player = this.players.get(playerId);
        if (player && player.ws && player.ws.readyState === 1) {
            player.ws.send(JSON.stringify({ t: type, d: data }));
        }
    }
}

module.exports = GameRoom;
