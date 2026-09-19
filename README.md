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

## Fixtures

`fixtures/` holds anonymised logs: three single games from the 2000s, and in `fixtures/pairs/` ten games each recorded on two machines at once, named by date (a second number telling apart two games of one day) with `-A` and `-B` for the two recorders. `fixtures/emulator_solo` is different: a single-player game the owner recorded in an emulator in 2026 as a set of controlled experiments, with the ground truth typed into the chat, read by `tools/measure-emulator-log.cjs` and written up in FORMAT.notes.md under [E:emulator-log]. In the old logs, player and machine names, chat and IP addresses are substituted byte for byte (`tools/redact-names.cjs`, `redact-chat.cjs`, `redact-addresses.cjs`); every other byte is as recorded, so the two logs of a pair still agree on every shared record. `tools/compare-recordings.cjs` lays the two logs of a pair side by side, and `tools/audit-paired-reconstruction.cjs` compares what the viewer's shell matcher makes of each: the same packets under two sets of timestamps. `tools/fingerprint-build.cjs` digests the viewer's build of every fixture (`--save` before a change that should leave the reconstruction alone, `--check` after), so such a change is proven byte-identical rather than trusted.

# Ancient Bolo Log Viewer

`viewer/` is the Ancient Bolo Log Viewer — an [Electron](https://www.electronjs.org/) app that plays logs back. Featuring gameplay, alliances, messages, seeking, speeds up to 64×, and a viewpoint selector choosing whose side draws as friendly.

<img width="1280" height="860" alt="viewer screenshot" src="https://raw.githubusercontent.com/rooklift/ancient_bolo_parser/refs/heads/main/docs/viewer_still.png" />

```
cd viewer
npx electron .
```

The same files also run as a plain web page: open `viewer/index.html` in a browser, or serve the `viewer/` directory with any static file server. The web version has no application menu, so it cannot export video, and its toggle shortcuts are bare keys (D, I, F, L, G, M, B, R, T) rather than Ctrl+key. Since there is no menu to read the keys off, the web version alone gets a shortcut sheet: press `?`, or use the `?` button at the end of the transport bar.

### Game sounds

Game sounds use the visible area as the listener. Events on screen use near
sounds, and events off screen but less than 40 tiles from the camera centre
use far sounds. That circular distance uses map tiles, independent of zoom,
so a view wider than 40 tiles hears no far sounds at all. Locking
the camera to a player makes audio follow that player, and only then are that
player's own gunfire and hits played as self sounds; a free camera hears every
tank as near or far. The player selector alone only changes friendly colours.
Sounds are mono, as in the game. They play at 50% volume, with a random ±3%
pitch/rate variation on each playback to soften repetition. Up to four copies
of one sound overlap; a fifth restarts the copy that has played longest. The
**Speaker** button toggles audio. Playback above 100%, seeking, and
frame stepping are silent. Video exports remain silent. Browsers may require
a click or keypress before allowing sound. The logs do not contain an audio
track, so sounds are inferred. A record is stamped when its packet reached
the recorder, which bunches a busy pillbox's fire events into whatever records
the ring delivered, so gunfire is not taken from the fire events: each shell
the matcher traced back to a muzzle sounds at the moment it is drawn leaving
it, the same clock as the impact sounds, and a shell the matcher could not
place is silent. Builder and terrain-impact sounds come from the recorded
events, impacts retimed to the matched shell's arrival where there is one.

### Tauri edition (Windows)

`viewer/tauri/` hosts the same viewer in a [Tauri](https://tauri.app) shell: a small Rust program around the WebView2 engine Windows already ships, so the app is a few MB instead of the ~200 MB Electron folder. We build this on GitHub and add it to the releases.

## Status

The viewer reconstructs full game state (terrain, pills, bases, tanks, men, shells, alliances), including the pieces of game logic the log omits by design — pill dumps on death, boat consumption, alliance semantics; see the end of FORMAT.md for that list and its caveats. Tank, LGM and conservatively matched shell movement is interpolated between nearby restatements.

The shell interpolator is a forensic reconstruction engine for anonymous projectiles: a quantisation-aware state estimator driven by a bit-exact simulator of Bolo's integer shell physics, reverse-engineered from empirical data; a 256-bradian discrete-trajectory hypothesis tracker that collapses to exact orbits wherever the origin is pinned; a byte-exact stale-restatement linker; a margin-gated mutual-best identity matcher; a same-origin lockstep roster arbiter; a sender-clock reader that dates each record pair off the sender's own shells -- the tank's common advance, or a pill's passed election -- with a terminal's nearest explainer the one doubtful voter, and lends the composed clock to the joins and to the drawing of late records; a conservative chain stitcher; a min-cost maximum-flow resolver for forced residual origins, continuations, and fates; and a constant-velocity smoother with late-stamp head correction, arrival-retimed splashes, and seamless birth-and-fall segments, all so that a shell with no ID in a 25-year-old log can be drawn flying from the muzzle to the target.

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
  terrain tile rules are a port of its `screencalc.c`. Game sound WAVs in
  `viewer/sounds/` are copied from WinBolo's `data/sounds/` (excluding lobby
  and ping sounds).
