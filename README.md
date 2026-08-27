Preamble: although this is entirely AI-coded, you (dear reader) have no idea the lengths Claude, Sol, and myself have gone through, getting everything to work just right. The amount of science we did on Bolo replays is quite absurd.

# Ancient Bolo Parser

A parser for log files written by the classic Macintosh tank game **Bolo** (Stuart Cheshire, version 0.99.7bv).

The log format was cracked around 2001–2003 by Carl Osterwald ("wharf rat") for his BoloViewer application. This project builds on a surviving copy of his (or someone's) format notes, adds empirical findings of its own, and documents everything in [FORMAT.md](FORMAT.md).

The parser is dependency-free ES-module JavaScript (Node ≥ 18).

## Usage

```
node bin/dump.js <logfile>            # summary
node bin/dump.js <logfile> --events   # human-readable event stream
node bin/dump.js <logfile> --json     # one JSON record per line
node bin/dump.js <logfile> --raw 20   # hex of decrypted records
```

Library:

```js
import { records, parseHeader } from "./src/parse.js";
for (const rec of records(new Uint8Array(fs.readFileSync(file)))) {
	// rec.time (50 ticks/s), rec.player, rec.subpackets: tank_position,
	// lgm_position, shells, terrain_change, message, tank_death, ...
}
```

# Ancient Bolo Log Viewer

`viewer/` is the Ancient Bolo Log Viewer — an Electron app that plays logs back. Featuring gameplay, alliances, messages, seeking, speeds up to
64×, and a viewpoint selector choosing whose side draws as friendly.

<img width="1280" height="860" alt="viewer screenshot" src="https://github.com/user-attachments/assets/cd56620e-6c36-4640-b351-3a3b964524eb" />

```
cd viewer
npx electron .
```

## Status

The viewer reconstructs full game state (terrain, pills, bases, tanks, men, shells, alliances), including the pieces of game logic the log omits by design — pill dumps on death, boat consumption, alliance semantics; see the end of FORMAT.md for that list and its caveats. Not attempted: scoring and sound. Tank, LGM and conservatively matched shell movement is interpolated between nearby restatements.

## Provenance and credits

- **Stuart Cheshire** — Bolo itself; `GAMEINFO` layout from his published
  Brain development kit; map RLE from his `BoloMapFile.c` sample code.
- **Carl Osterwald ("wharf rat")** — original reverse engineering of the
  log encryption and packet formats (2001–2003), author of BoloViewer.
- An anonymous 2003 collaborator whose working notes and prototype Perl
  parser preserved that knowledge.
- **[bolorama](https://github.com/astrospark/bolorama)** (Astrospark
  Technologies) — independently reverse-engineered Bolo UDP wire protocol,
  used to cross-check opcode layouts.
