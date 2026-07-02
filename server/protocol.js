// Message types for client-server communication
const MSG = {
    // Lobby (client -> server)
    CREATE_ROOM: 'create_room',
    JOIN_ROOM: 'join_room',
    LEAVE_ROOM: 'leave_room',
    LIST_LOBBY: 'list_lobby',
    START_MATCH: 'start_match',
    SWITCH_TEAM: 'switch_team',
    UPDATE_SETTINGS: 'update_settings',
    QUICK_MATCH: 'quick_match',

    // Lobby (server -> client)
    ROOM_CREATED: 'room_created',
    ROOM_JOINED: 'room_joined',
    ROOM_UPDATE: 'room_update',
    LOBBY_LIST: 'lobby_list',
    MATCH_STARTING: 'match_starting',
    ERROR: 'error',

    // In-game (client -> server)
    INPUT: 'input',
    PING: 'ping',

    // In-game (server -> client)
    STATE: 'state',
    GOAL: 'goal',
    EVENT: 'event',
    MATCH_END: 'match_end',
    PONG: 'pong',

    // P2P signaling (relayed through server)
    CREATE_P2P_ROOM: 'create_p2p_room',
    JOIN_P2P_ROOM: 'join_p2p_room',
    SIGNAL_OFFER: 'signal_offer',
    SIGNAL_ANSWER: 'signal_answer',
    SIGNAL_ICE: 'signal_ice',
    P2P_PEER_JOINED: 'p2p_peer_joined',
    P2P_PEER_LEFT: 'p2p_peer_left',
    START_P2P_MATCH: 'start_p2p_match',
    P2P_RELAY_STATE: 'p2p_relay_state',
    P2P_RELAY_GOAL: 'p2p_relay_goal',
    P2P_RELAY_END: 'p2p_relay_end',
    P2P_RELAY_INPUT: 'p2p_relay_input',
    // Lockstep relay fallbacks (host -> guests when data channels aren't open).
    // Forwarded to guests as 'ci'/'cs', matching the data-channel message types.
    P2P_RELAY_CI: 'p2p_relay_ci',
    P2P_RELAY_CS: 'p2p_relay_cs',
};

const ROOM_STATE = {
    WAITING: 'waiting',
    STARTING: 'starting',
    PLAYING: 'playing',
    FINISHED: 'finished',
};

module.exports = { MSG, ROOM_STATE };
