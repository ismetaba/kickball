# KickZone

A physics-based soccer game playable in the browser with touch controls, AI opponents, and online multiplayer.

## Features

- **Quick Match** — Play against AI with configurable team size (1v1 to 4v4), match duration, and difficulty
- **Online rooms** — Peer-to-peer multiplayer via room codes (WebRTC, deterministic lockstep netcode)
- **Practice Mode** — Free play to hone your skills
- **Power-Ups** — Collectible abilities that spawn on the field
- **Multiple Maps** — Small, Classic, and Huge field layouts
- **Mobile-First** — Virtual joystick and action buttons optimized for touch

## Controls

| Action | Control |
|--------|---------|
| Move | Left joystick |
| Kick | KICK button (hold for power shot) |
| Pull ball | PULL button (hold) |
| Switch Player | SWAP button |

## Running

Open `index.html` in a browser. No build step required.

## Tech

Pure HTML5 Canvas + vanilla JavaScript. No frameworks.

Online play (`js/netplay.js`, `js/p2p.js`): every phone runs the same deterministic 60 Hz simulation and only inputs are exchanged over a WebRTC data channel (the server in `server/` handles room codes, signaling and a relay fallback). Inputs are scheduled a few ticks ahead based on measured ping, every packet repeats unacknowledged inputs so packet loss doesn't stall the game, clocks are kept in step, and a periodic state hash triggers an automatic resync if two devices ever disagree. Both devices must run the same app version.
