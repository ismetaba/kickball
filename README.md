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

**Normal** difficulty plays the scripted `AIController`. **Expert** plays trained neural networks that ship with the game (`models/expert.json` + `models/skills.json`, loaded by `js/ai-models.js`): a full-match policy, with the separately trained **defend** skill taking over when the opponent carries the ball into our half or wins the race to a loose ball there. In team games it controls whoever is nearest the ball and the scripted AI positions the rest. Online matches always use the scripted AI, so every device computes the same moves.

| Expert vs (3-minute matches) | won – drawn – lost | goals |
|---|---|---|
| scripted AI (Normal), 1v1 | 99 – 0 – 1 | 16.3 – 1.1 per match |
| scripted AI, 2v2 with power-ups | 57 – 3 – 0 | 10.9 – 2.4 |
| previous best model (`kickzone-rl-gen1325`) | 210 – 44 – 46 | 4.1 – 2.2 |
| its own match policy without the defend skill | 184 – 46 – 70 | 2.6 – 1.7 |

Only the defend skill is used in matches: handing the ball to the dribble, shoot or pull skills made the match policy lose more (a match is won by moving the ball fast; the drills reward close control).

### Skill drills

Each skill is trained on its own drill (`js/rl/drills.js`): a scenario a few seconds long with its own start, end and reward, at three levels (no opponent, slow opponent, full-speed opponent — half of level 3 is the game's own rule AI).

| Skill | Success means |
|---|---|
| dribble | carrying the ball into the attacking third without losing it |
| defend | stopping a shot or an attacker, then clearing the ball past halfway |
| shoot | scoring from the attacking half (past a keeper on levels 2–3) |
| pull | winning a loose or carried ball, pulling it in when it's in range |

Drill success at levels 1 / 2 / 3 (600 episodes each):

| | dribble | defend | shoot | pull |
|---|---|---|---|---|
| shipped skill models | 100 / 99 / 92 | 78 / 89 / 82 | 98 / 81 / 51 | 97 / 90 / 78 |
| scripted reference player | 100 / 64 / 27 | 72 / 80 / 70 | 99 / 79 / 34 | 97 / 81 / 52 |
| previous full-match model | 8 / 2 / 1 | 35 / 78 / 70 | 19 / 11 / 6 | 81 / 64 / 37 |

The four skill models ship in `models/skills.json`. In the **AI Lab → Skills** tab you can watch each one play its drill with live success rates, train it further in the browser, and play a test match against the coach that switches between the skills (`js/rl/skills.js`).

### Training from the terminal

```
npm run train:skill -- --skill shoot          # one skill on its drill
node scripts/train-match.js --init models/kickzone-rl-gen1325.json   # full matches + all drills
node scripts/eval-match.js --a model:models/match.json --b rule      # play AIs against each other
node scripts/train-skill-in-match.js --skill defend --base m.json --init defend.json  # tune a skill in matches
node scripts/tune-coach.js --base m.json --bundle skills.json         # where should skills take over?
node scripts/bundle-models.js --dribble d.json --defend f.json --shoot s.json --pull p.json \
    --expert hybrid --match m.json --use carriedAtUs,looseTheyLead --hold 400   # pack models into models/
```

`train-skill.js` prints the success rate as it learns, moves up a level at 80% success (or when it stops improving), and saves the best policy; `--bc 40000` starts from a copy of the scripted reference player. `train-match.js` trains one policy on matches against the rule AI, its starting model and its own past versions, mixed with drill episodes so it also learns the techniques full matches rarely exercise; it evaluates matches and drills as it goes. `eval-match.js` plays 1v1 or 2v2 (`--team-size 2`) matches between any two AIs.
