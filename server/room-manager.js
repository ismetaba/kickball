// Manages all game rooms, lobby, and player routing
const GameRoom = require('./game-room');
const { MSG, ROOM_STATE } = require('./protocol');

class RoomManager {
    constructor() {
        this.rooms = new Map();       // roomCode -> GameRoom
        this.playerRooms = new Map(); // playerId -> roomCode
        this.playerWs = new Map();    // playerId -> ws
        this.p2pRooms = new Map();    // roomCode -> { hostId, hostWs, peers: Map<peerId, {ws, name, team}>, settings }
    }

    handleMessage(playerId, ws, msg) {
        this.playerWs.set(playerId, ws);

        switch (msg.t) {
            case MSG.CREATE_ROOM:
                this._createRoom(playerId, ws, msg.d);
                break;
            case MSG.JOIN_ROOM:
                this._joinRoom(playerId, ws, msg.d);
                break;
            case MSG.LEAVE_ROOM:
                this._leaveRoom(playerId);
                break;
            case MSG.LIST_LOBBY:
                this._sendLobby(playerId, ws);
                break;
            case MSG.START_MATCH:
                this._startMatch(playerId);
                break;
            case MSG.SWITCH_TEAM:
                this._switchTeam(playerId, msg.d);
                break;
            case MSG.UPDATE_SETTINGS:
                this._updateSettings(playerId, msg.d);
                break;
            case MSG.QUICK_MATCH:
                this._quickMatch(playerId, ws, msg.d);
                break;
            case MSG.INPUT:
                this._handleInput(playerId, msg.d);
                break;
            case MSG.PING:
                this._sendTo(ws, MSG.PONG, { t: msg.d?.t });
                break;
            // P2P signaling
            case MSG.CREATE_P2P_ROOM:
                this._createP2PRoom(playerId, ws, msg.d);
                break;
            case MSG.JOIN_P2P_ROOM:
                this._joinP2PRoom(playerId, ws, msg.d);
                break;
            case MSG.START_P2P_MATCH:
                this._startP2PMatch(playerId, msg.d);
                break;
            case MSG.SIGNAL_OFFER:
            case MSG.SIGNAL_ANSWER:
            case MSG.SIGNAL_ICE:
                this._relaySignal(playerId, msg);
                break;
            case MSG.P2P_RELAY_STATE:
            case MSG.P2P_RELAY_GOAL:
            case MSG.P2P_RELAY_END:
                this._relayP2PData(playerId, msg);
                break;
            case MSG.P2P_RELAY_INPUT:
                this._relayP2PInput(playerId, msg);
                break;
            default:
                break;
        }
    }

    handleDisconnect(playerId) {
        const ref = this.playerRooms.get(playerId);
        if (ref && ref.startsWith('p2p:')) {
            // P2P room disconnect
            this._leaveP2PRoom(playerId);
        } else if (ref) {
            const room = this.rooms.get(ref);
            if (room) {
                room.removePlayer(playerId);
                if (room.playerCount === 0 || room.state === ROOM_STATE.FINISHED) {
                    if (room.simulation) room.simulation.stop();
                    this.rooms.delete(ref);
                }
            }
            this.playerRooms.delete(playerId);
        }
        this.playerWs.delete(playerId);
    }

    _createRoom(playerId, ws, data) {
        // Leave existing room first
        this._leaveRoom(playerId);

        const roomCode = this._generateCode();
        const name = data?.name || 'Player';
        const settings = data?.settings || {};

        const room = new GameRoom(roomCode, playerId, ws, name, settings);
        this.rooms.set(roomCode, room);
        this.playerRooms.set(playerId, roomCode);

        this._sendTo(ws, MSG.ROOM_CREATED, { roomCode });
        this._sendTo(ws, MSG.ROOM_JOINED, {
            roomCode,
            playerId,
            slots: room.getSlotInfo(),
            settings: room.settings,
            yourSlot: null,
            isHost: true,
        });
    }

    _joinRoom(playerId, ws, data) {
        const roomCode = data?.roomCode?.toUpperCase();
        const name = data?.name || 'Player';
        const team = data?.team;

        if (!roomCode) {
            this._sendTo(ws, MSG.ERROR, { message: 'Room code required' });
            return;
        }

        // Check P2P rooms first
        if (this.p2pRooms.has(roomCode)) {
            this._joinP2PRoom(playerId, ws, { roomCode, name });
            return;
        }

        const room = this.rooms.get(roomCode);
        if (!room) {
            this._sendTo(ws, MSG.ERROR, { message: 'Room not found' });
            return;
        }

        if (room.state !== ROOM_STATE.WAITING) {
            this._sendTo(ws, MSG.ERROR, { message: 'Match already in progress' });
            return;
        }

        // Leave existing room first
        this._leaveRoom(playerId);

        const joined = room.addPlayer(playerId, ws, name, team);
        if (!joined) {
            this._sendTo(ws, MSG.ERROR, { message: 'Room is full' });
            return;
        }

        this.playerRooms.set(playerId, roomCode);

        this._sendTo(ws, MSG.ROOM_JOINED, {
            roomCode,
            slots: room.getSlotInfo(),
            settings: room.settings,
            yourSlot: null,
            isHost: playerId === room.hostId,
        });
    }

    _leaveRoom(playerId) {
        const roomCode = this.playerRooms.get(playerId);
        if (!roomCode) return;

        const room = this.rooms.get(roomCode);
        if (room) {
            room.removePlayer(playerId);
            if (room.playerCount === 0 || room.state === ROOM_STATE.FINISHED) {
                if (room.simulation) room.simulation.stop();
                this.rooms.delete(roomCode);
            }
        }
        this.playerRooms.delete(playerId);
    }

    _startMatch(playerId) {
        const roomCode = this.playerRooms.get(playerId);
        if (!roomCode) return;

        const room = this.rooms.get(roomCode);
        if (!room) return;

        if (playerId !== room.hostId) {
            const ws = this.playerWs.get(playerId);
            if (ws) this._sendTo(ws, MSG.ERROR, { message: 'Only the host can start the match' });
            return;
        }

        // Free the room + player mappings promptly when the match ends
        // naturally, instead of waiting for the 60s stale-room sweep.
        room.onFinished = () => this._cleanupRoom(roomCode);
        room.startMatch();
    }

    _switchTeam(playerId, data) {
        const ref = this.playerRooms.get(playerId);
        if (!ref) return;

        // P2P room
        if (ref.startsWith('p2p:')) {
            const code = ref.slice(4);
            const p2pRoom = this.p2pRooms.get(code);
            if (!p2pRoom) return;
            const team = data?.team;
            if (p2pRoom.hostId === playerId) {
                // Host can't switch for now (always red)
            } else {
                const peer = p2pRoom.peers.get(playerId);
                if (peer && team) peer.team = team;
            }
            this._broadcastP2PRoom(code, p2pRoom);
            return;
        }

        const room = this.rooms.get(ref);
        if (!room) return;

        room.switchTeam(playerId, data?.team);
    }

    _quickMatch(playerId, ws, data = {}) {
        this._leaveRoom(playerId);

        const name = data?.name || 'Player';

        // Find an open waiting room that isn't full
        for (const [roomCode, room] of this.rooms) {
            if (room.state === ROOM_STATE.WAITING && room.playerCount < room.maxPlayers) {
                // Join this room. addPlayer can still refuse (full/started); if it
                // does, fall through to the next candidate instead of leaving the
                // player with a phantom room mapping.
                const team = this._getBalancedTeam(room);
                if (!room.addPlayer(playerId, ws, name, team)) continue;
                this.playerRooms.set(playerId, roomCode);
                this._sendTo(ws, MSG.ROOM_JOINED, {
                    roomCode,
                    playerId,
                    slots: room.getSlotInfo(),
                    settings: room.settings,
                    yourSlot: null,
                    isHost: false,
                });
                return;
            }
        }

        // No open rooms — create one
        this._createRoom(playerId, ws, { name });
    }

    _getBalancedTeam(room) {
        let red = 0, blue = 0;
        for (const [, p] of room.players) {
            if (p.team === 'red') red++;
            else blue++;
        }
        return red <= blue ? 'red' : 'blue';
    }

    _updateSettings(playerId, data = {}) {
        const ref = this.playerRooms.get(playerId);
        if (!ref) return;

        // Check P2P room first
        if (ref.startsWith('p2p:')) {
            const code = ref.slice(4);
            const p2pRoom = this.p2pRooms.get(code);
            if (!p2pRoom || p2pRoom.hostId !== playerId) return;
            if (data?.teamSize && [1, 2, 3, 4].includes(data.teamSize)) {
                p2pRoom.settings.teamSize = data.teamSize;
            }
            this._broadcastP2PRoom(code, p2pRoom);
            return;
        }

        const room = this.rooms.get(ref);
        if (!room || room.hostId !== playerId) return; // host only
        if (room.state !== ROOM_STATE.WAITING) return;

        // Update allowed settings
        if (data?.teamSize && [1, 2, 3, 4].includes(data.teamSize)) {
            // Reject a teamSize that no longer fits the players already in the
            // room. Each team holds teamSize players, so shrinking below the
            // current per-team occupancy would strand the extra players with no
            // simulation slot (invisible, uncontrollable) once the match starts.
            let redCount = 0, blueCount = 0;
            for (const [, p] of room.players) {
                if (p.team === 'red') redCount++; else blueCount++;
            }
            if (data.teamSize < Math.max(redCount, blueCount)) {
                const ws = this.playerWs.get(playerId);
                if (ws) this._sendTo(ws, MSG.ERROR, { message: 'Team size too small for current players' });
                return;
            }
            room.settings.teamSize = data.teamSize;
        }
        room._broadcastRoomUpdate();
    }

    _handleInput(playerId, input) {
        const roomCode = this.playerRooms.get(playerId);
        if (!roomCode) return;

        const room = this.rooms.get(roomCode);
        if (!room) return;

        room.handleInput(playerId, input);
    }

    _sendLobby(playerId, ws) {
        this._sendTo(ws, MSG.LOBBY_LIST, this.listLobby());
    }

    listLobby() {
        const lobbies = [];
        for (const [, room] of this.rooms) {
            if (room.state === ROOM_STATE.WAITING) {
                lobbies.push(room.getLobbyInfo());
            }
        }
        return lobbies;
    }

    // Remove a room and clear its players' room mappings. Used both by the
    // stale-room sweep and immediately when a match ends naturally.
    _cleanupRoom(roomCode) {
        const room = this.rooms.get(roomCode);
        if (!room) return;
        if (room.simulation) room.simulation.stop();
        for (const [playerId] of room.players) {
            if (this.playerRooms.get(playerId) === roomCode) {
                this.playerRooms.delete(playerId);
            }
        }
        this.rooms.delete(roomCode);
    }

    cleanupStaleRooms() {
        const now = Date.now();
        for (const [code, room] of this.rooms) {
            // Remove rooms that have been waiting too long or are finished
            if (room.state === ROOM_STATE.FINISHED ||
                (room.state === ROOM_STATE.WAITING && now - room.createdAt > 10 * 60 * 1000)) {
                this._cleanupRoom(code);
            }
        }
    }

    _generateCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars
        let code;
        do {
            code = '';
            for (let i = 0; i < 4; i++) {
                code += chars[Math.floor(Math.random() * chars.length)];
            }
        } while (this.rooms.has(code));
        return code;
    }

    _startP2PMatch(playerId, data) {
        const ref = this.playerRooms.get(playerId);
        if (!ref || !ref.startsWith('p2p:')) return;
        const code = ref.slice(4);
        const room = this.p2pRooms.get(code);
        if (!room || room.hostId !== playerId) return;

        // Build slots with proper indices
        const slots = this._getP2PSlots(room);
        let idx = 0;
        for (const s of slots) { s.index = idx++; }

        const matchData = {
            settings: room.settings,
            slots,
            isP2P: true,
            hostId: playerId,
        };

        // Tell everyone including host
        this._sendTo(room.hostWs, MSG.MATCH_STARTING, matchData);
        for (const [peerId, peer] of room.peers) {
            // Tell each peer which slot they are
            const peerSlot = slots.find(s => s.playerId === peerId);
            this._sendTo(peer.ws, MSG.MATCH_STARTING, {
                ...matchData,
                mySlot: peerSlot ? peerSlot.index : 1,
            });
        }
    }

    // --- P2P Signaling ---
    _createP2PRoom(playerId, ws, data) {
        this._leaveP2PRoom(playerId);
        this.playerWs.set(playerId, ws);

        const code = this._generateP2PCode();
        const name = data?.name || 'Player';
        const settings = data?.settings || { teamSize: 2, map: 'classic', duration: 180, goalLimit: 0 };

        this.p2pRooms.set(code, {
            hostId: playerId,
            hostWs: ws,
            hostName: name,
            peers: new Map(),
            settings,
            createdAt: Date.now(),
        });
        this.playerRooms.set(playerId, 'p2p:' + code);

        this._sendTo(ws, MSG.ROOM_CREATED, { roomCode: code, isP2P: true });
        this._sendTo(ws, MSG.ROOM_JOINED, {
            roomCode: code,
            playerId,
            slots: [{ playerId, name, team: 'red', isHost: true }],
            settings,
            isHost: true,
            isP2P: true,
        });
    }

    _joinP2PRoom(playerId, ws, data) {
        const code = data?.roomCode?.toUpperCase();
        const name = data?.name || 'Player';

        const room = this.p2pRooms.get(code);
        if (!room) {
            this._sendTo(ws, MSG.ERROR, { message: 'Room not found' });
            return;
        }

        // Pick balanced team
        let red = 1, blue = 0; // host is red
        for (const [, p] of room.peers) {
            if (p.team === 'red') red++; else blue++;
        }
        const team = red <= blue ? 'red' : 'blue';

        room.peers.set(playerId, { ws, name, team });
        this.playerWs.set(playerId, ws);
        this.playerRooms.set(playerId, 'p2p:' + code);

        // Build slots list
        const slots = this._getP2PSlots(room);

        // Tell the joiner
        this._sendTo(ws, MSG.ROOM_JOINED, {
            roomCode: code,
            playerId,
            slots,
            settings: room.settings,
            isHost: false,
            isP2P: true,
        });

        // Tell host about new peer
        this._sendTo(room.hostWs, MSG.P2P_PEER_JOINED, {
            peerId: playerId,
            name,
            team,
        });

        // Broadcast room update to everyone
        this._broadcastP2PRoom(code, room);
    }

    // Relay P2P game data from host to all peers via WebSocket (fallback when data channels aren't open)
    _relayP2PData(fromId, msg) {
        const ref = this.playerRooms.get(fromId);
        if (!ref || !ref.startsWith('p2p:')) return;
        const code = ref.slice(4);
        const room = this.p2pRooms.get(code);
        if (!room || room.hostId !== fromId) return;

        // Map relay types to client message types
        const typeMap = {
            'p2p_relay_state': 'state',
            'p2p_relay_goal': 'goal',
            'p2p_relay_end': 'match_end',
        };
        const clientType = typeMap[msg.t] || msg.t;

        for (const [, peer] of room.peers) {
            this._sendTo(peer.ws, clientType, msg.d);
        }
    }

    // Relay input from peer to host via WebSocket (fallback when data channels aren't open)
    _relayP2PInput(fromId, msg) {
        const ref = this.playerRooms.get(fromId);
        if (!ref || !ref.startsWith('p2p:')) return;
        const code = ref.slice(4);
        const room = this.p2pRooms.get(code);
        if (!room || room.hostId === fromId) return; // Only peers send input

        // Forward to host as a peer input message
        this._sendTo(room.hostWs, 'p2p_peer_input', { peerId: fromId, input: msg.d });
    }

    _relaySignal(fromId, msg) {
        const targetId = msg.d?.targetId;
        const targetWs = this.playerWs.get(targetId);
        if (targetWs) {
            this._sendTo(targetWs, msg.t, {
                ...msg.d,
                fromId,
            });
        }
    }

    _leaveP2PRoom(playerId) {
        const ref = this.playerRooms.get(playerId);
        if (!ref || !ref.startsWith('p2p:')) return;
        const code = ref.slice(4);
        const room = this.p2pRooms.get(code);
        if (!room) return;

        if (room.hostId === playerId) {
            // Host left — notify all peers and destroy room
            for (const [peerId, peer] of room.peers) {
                this._sendTo(peer.ws, MSG.P2P_PEER_LEFT, { peerId: playerId, hostLeft: true });
                this.playerRooms.delete(peerId);
            }
            this.p2pRooms.delete(code);
        } else {
            room.peers.delete(playerId);
            this._sendTo(room.hostWs, MSG.P2P_PEER_LEFT, { peerId: playerId });
            this._broadcastP2PRoom(code, room);
        }
        this.playerRooms.delete(playerId);
    }

    _getP2PSlots(room) {
        const slots = [{ playerId: room.hostId, name: room.hostName, team: 'red', isHost: true }];
        for (const [peerId, p] of room.peers) {
            slots.push({ playerId: peerId, name: p.name, team: p.team, isHost: false });
        }
        return slots;
    }

    _broadcastP2PRoom(code, room) {
        const data = {
            slots: this._getP2PSlots(room),
            settings: room.settings,
            hostId: room.hostId,
        };
        this._sendTo(room.hostWs, MSG.ROOM_UPDATE, data);
        for (const [, p] of room.peers) {
            this._sendTo(p.ws, MSG.ROOM_UPDATE, data);
        }
    }

    _generateP2PCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code;
        do {
            code = '';
            for (let i = 0; i < 4; i++) {
                code += chars[Math.floor(Math.random() * chars.length)];
            }
        } while (this.p2pRooms.has(code) || this.rooms.has(code));
        return code;
    }

    _sendTo(ws, type, data) {
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ t: type, d: data }));
        }
    }
}

module.exports = RoomManager;
