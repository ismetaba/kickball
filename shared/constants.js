// Shared constants for client and server
(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.GameConstants = factory();
    }
})(typeof self !== 'undefined' ? self : this, function() {
    return {
        TICK_RATE: 60,
        TICK_MS: 1000 / 60,
        STATE_SEND_RATE: 40, // Hz — server sends state snapshots at this rate
        INPUT_SEND_RATE: 60, // Hz — client sends input at this rate

        MAPS: {
            big:     { virtualW: 800,  virtualH: 500 },
            classic: { virtualW: 1500, virtualH: 1000 },
            huge:    { virtualW: 2400, virtualH: 1600 },
        },

        MAX_TEAM_SIZE: 4,
        ROOM_CODE_LENGTH: 4,
        ROOM_STALE_MS: 10 * 60 * 1000, // 10 minutes

        // Game durations
        DURATIONS: [120, 180, 300],
        GOAL_LIMITS: [0, 3, 5],

        // Sudden death
        SUDDEN_DEATH_TIMER: 30000,
        SUDDEN_DEATH_SHRINK_RATE: 0.00005,

        // Goal celebration
        GOAL_PAUSE_MS: 2500,

        // Kickoff restrictions
        KICKOFF_DURATION: 1500,
    };
});
