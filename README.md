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

## AI

**Normal** difficulty plays the scripted `AIController`. **Expert** plays a trained neural-network policy that ships with the game (`models/expert.json`, loaded by `js/ai-models.js`); in team games it controls whoever is nearest the ball and the scripted AI positions the rest. Online matches always use the scripted AI, so every device computes the same moves.

### Skill drills

Each skill is trained on its own drill (`js/rl/drills.js`): a scenario a few seconds long with its own start, end and reward, at three levels (no opponent, slow opponent, full-speed opponent — half of level 3 is the game's own rule AI).

| Skill | Success means |
|---|---|
| dribble | carrying the ball into the attacking third without losing it |
| defend | stopping a shot or an attacker, then clearing the ball past halfway |
| shoot | scoring from the attacking half (past a keeper on levels 2–3) |
| pull | winning a loose or carried ball, pulling it in when it's in range |

The four skill models ship in `models/skills.json`. In the **AI Lab → Skills** tab you can watch each one play its drill with live success rates, train it further in the browser, and play a test match against the coach that switches between the skills (`js/rl/skills.js`).

### Training from the terminal

```
npm run train:skill -- --skill shoot          # one skill on its drill
node scripts/train-match.js --init models/kickzone-rl-gen1325.json   # full matches + all drills
node scripts/eval-match.js --a model:models/match.json --b rule      # play AIs against each other
node scripts/bundle-models.js --dribble d.json --defend f.json --shoot s.json --pull p.json \
    --expert match --match m.json                                     # pack models into models/
```

`train-skill.js` prints the success rate as it learns, moves up a level at 80% success (or when it stops improving), and saves the best policy; `--bc 40000` starts from a copy of the scripted reference player. `train-match.js` trains one policy on matches against the rule AI, its starting model and its own past versions, mixed with drill episodes so it also learns the techniques full matches rarely exercise; it evaluates matches and drills as it goes. `eval-match.js` plays 1v1 or 2v2 (`--team-size 2`) matches between any two AIs.
