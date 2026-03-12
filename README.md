# KickZone

A physics-based soccer game playable in the browser with touch controls, AI opponents, and online multiplayer.

## Features

- **Quick Match** — Play against AI with configurable team size (1v1 to 4v4), match duration, and difficulty
- **Local 1v1** — Two players on the same device
- **Online 1v1** — Peer-to-peer multiplayer via room codes (powered by PeerJS)
- **Tournament** — Bracket-style tournament mode
- **Practice Mode** — Free play to hone your skills
- **Power-Ups** — Collectible abilities that spawn on the field
- **Multiple Maps** — Classic, Big, and Futsal field layouts
- **Mobile-First** — Virtual joystick and action buttons optimized for touch

## Controls

| Action | Control |
|--------|---------|
| Move | Left joystick |
| Kick | KICK button (hold for power shot) |
| Dash | DASH button |
| Switch Player | SWAP button |

## Running

Open `index.html` in a browser. No build step required.

## Tech

Pure HTML5 Canvas + vanilla JavaScript. No frameworks. Online play uses [PeerJS](https://peerjs.com/) for WebRTC connections.
