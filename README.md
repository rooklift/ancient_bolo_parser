Preamble: although this is entirely AI-coded, you (dear reader) have no idea the lengths Claude, Sol, and myself have gone through, getting everything to work just right. The amount of science we did on Bolo replays is quite absurd.

# Ancient Bolo Parser

A parser for log files written by the classic Macintosh tank game **Bolo** (Stuart Cheshire, version 0.99.7bv).

The log format was cracked around 2001–2003 by Carl Osterwald ("wharf rat") for his BoloViewer application. This project builds on a surviving copy of his (or someone's) format notes, adds empirical findings of its own, and documents everything in [FORMAT.md](docs/FORMAT.md). The rules of the game the logs record, as distinct from the log format, are in [GAMEPLAY.md](docs/GAMEPLAY.md).

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

`viewer/` is the Ancient Bolo Log Viewer — an [Electron](https://www.electronjs.org/) app that plays logs back. Featuring gameplay, alliances, messages, seeking, speeds up to 64×, and a viewpoint selector choosing whose side draws as friendly.

<img width="1280" height="860" alt="viewer screenshot" src="https://raw.githubusercontent.com/rooklift/ancient_bolo_parser/refs/heads/main/docs/viewer.png" />

```
cd viewer
npx electron .
```

The same files also run as a plain web page: open `viewer/index.html` in a browser, or serve the `viewer/` directory with any static file server. The web version has no application menu, so it cannot export video, and its toggle shortcuts are bare keys (D, I, F, L, G, M, B, R, T) rather than Ctrl+key.

### Tauri edition (Windows)

`viewer/tauri/` hosts the same viewer in a [Tauri](https://tauri.app) shell: a small Rust program around the WebView2 engine Windows already ships, so the app is a few MB instead of the ~200 MB Electron folder. We build this on GitHub and add it to the releases.

## Status

The viewer reconstructs full game state (terrain, pills, bases, tanks, men, shells, alliances), including the pieces of game logic the log omits by design — pill dumps on death, boat consumption, alliance semantics; see the end of FORMAT.md for that list and its caveats. Tank, LGM and conservatively matched shell movement is interpolated between nearby restatements.

The shell interpolator is a forensic reconstruction engine for anonymous projectiles: a quantisation-aware state estimator driven by a bit-exact simulator of Bolo's integer shell physics, reverse-engineered from empirical data; a 256-bradian discrete-trajectory hypothesis tracker that collapses to exact orbits wherever the origin is pinned; a byte-exact stale-restatement linker; a margin-gated mutual-best identity matcher; a same-origin lockstep roster arbiter; a conservative chain stitcher; a min-cost maximum-flow resolver for forced residual origins, continuations, and fates; and a constant-velocity smoother with late-stamp head correction, arrival-retimed splashes, and seamless birth-and-fall segments, all so that a shell with no ID in a 25-year-old log can be drawn flying from the muzzle to the target.

## Provenance and credits

- **Stuart Cheshire** — Bolo itself; `GAMEINFO` layout from his published
  Brain development kit; map RLE from his `BoloMapFile.c` sample code; and
  sprites are ultimately derived from the original game too.
- **Carl Osterwald ("wharf rat")** — original reverse engineering of the
  log encryption and packet formats (2001–2003), author of BoloViewer.
- **Rob Keogh ("Pins")** whose working notes and prototype Perl
  parser preserved that knowledge.
- Two anonymous Bolo players who recorded and provided a large corpus of
  real log files from the 2000s.
- **[Bolorama](https://github.com/astrospark/bolorama)** (Astrospark
  Technologies) — independently reverse-engineered Bolo UDP wire protocol,
  used to cross-check opcode layouts.
- **[WinBolo](https://github.com/kippandrew/winbolo)** (**John Morrison**,
  1998–2008, GPL v2) — an independent GPL reimplementation of Bolo, used to
  explain behaviour the logs already demonstrate; `viewer/format.js`'s map
  reader/writer is a port of its `bolo_map.c`, and `viewer/sprites.js`'s
  terrain tile rules are a port of its `screencalc.c`.
