const http = require('http');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const RoomManager = require('./room-manager');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
    }

    if (req.url === '/api/lobby') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(roomManager.listLobby()));
        return;
    }

    if (req.url === '/api/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            rooms: roomManager.rooms.size,
            players: roomManager.playerWs.size,
        }));
        return;
    }

    res.writeHead(404);
    res.end('Not found');
});

const wss = new WebSocketServer({
    server,
    // Reject oversized frames before buffering them — a single game message
    // (input or relayed state) is well under 64 KB, so anything larger is
    // either a bug or an attempt to exhaust server memory.
    maxPayload: 64 * 1024,
    perMessageDeflate: {
        zlibDeflateOptions: { level: 1 }, // fastest compression
        threshold: 64, // only compress messages > 64 bytes
        concurrencyLimit: 4,
    },
});
const roomManager = new RoomManager();

wss.on('connection', (ws) => {
    const playerId = uuidv4();
    ws.playerId = playerId;

    console.log(`Player connected: ${playerId}`);

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            roomManager.handleMessage(playerId, ws, msg);
        } catch (e) {
            console.error('Bad message:', e.message);
        }
    });

    ws.on('close', () => {
        console.log(`Player disconnected: ${playerId}`);
        roomManager.handleDisconnect(playerId);
    });

    ws.on('error', (err) => {
        console.error(`WebSocket error for ${playerId}:`, err.message);
    });
});

// Cleanup stale rooms every 60s
setInterval(() => roomManager.cleanupStaleRooms(), 60000);

server.listen(PORT, () => {
    console.log(`KickZone server running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Lobby: http://localhost:${PORT}/api/lobby`);
});
