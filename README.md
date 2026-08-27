Preamble: although this is entirely AI-coded, you (dear reader) have no idea the
lengths Claude, Sol, and myself have gone through, getting everything to work just
right. The amount of science we did on Bolo replays is quite absurd.

# Ancient Bolo Parser

A parser for log files written by the classic Macintosh
tank game **Bolo** (Stuart Cheshire, version 0.99.7bv).

Bolo could record games via "Log Events to File…" but never shipped a way to
play them back. The log format — including its XOR obfuscation — was cracked
around 2001–2003 by Carl Osterwald ("wharf rat") for his BoloViewer
application, which was never open-sourced. This project builds on a
surviving copy of his format notes, adds empirical findings of its own
(notably the man/parachute position rule that the 2003 notes left
unresolved), and documents everything in [FORMAT.md](FORMAT.md).

The parser is dependency-free ES-module JavaScript (Node ≥ 18), intended to
serve as the decode core of a future replay viewer (e.g. an Electron app —
the map rendering side already exists in [lgm](https://github.com/rooklift/lgm)).

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

`viewer/` is the Ancient Bolo Log Viewer — so named since WinBolo has its
own, modern log format — an Electron app that plays logs back: terrain rendered with
Bolo's tile art, tanks/men/shells/pills/bases live, transient explosion
effects, alliance team colours, a message-wire panel, seeking, speeds up to
64×, and a viewpoint selector choosing whose side draws as friendly. The
header also rates the network the game was played on — good, fair, bad or
awful — read off the packets that never arrived and the moments everything
froze ([E:seq-loss](FORMAT.md)).

<img width="1280" height="860" alt="viewer screenshot" src="https://github.com/user-attachments/assets/cd56620e-6c36-4640-b351-3a3b964524eb" />

```
cd viewer
npx electron .
```

(Requires `electron`; install globally or `npm install electron` in
`viewer/`.) To build standalone distributions, drop the official
Electron release zips named in `viewer/builder.py` into
`viewer/electron_zipped/` and run the script from `viewer/`.
Open a log with File → Open or by dropping it onto the window;
a log path can also be passed on the command line. The page also runs in a
plain browser via its file picker, which is handy for headless testing and
screenshots. File → Show file (**Cmd/Ctrl+Shift+O**) reveals the current
log in the system file browser. Playback → Previous Change and Next Change jump between the
distinct moments when new game information arrived; their shortcuts are
Up Arrow and Down Arrow. Home and End jump to the beginning and end of the
replay.

The map codec (`format.js`), tile-selection rules and sprites
(`sprites.js`, `sprites/` — WinBolo art, GPL v2), and the shell of
`main.js`/`renderer.js` are duplicated from the
[lgm](https://github.com/rooklift/lgm) map editor.

Tanks, men, pills and bases draw with classic Bolo object art
(`sprites/objects/`) by default; press **Cmd/Ctrl+G** (or View →
Object sprites) to switch to vector markers. **Cmd/Ctrl+S** (File →
Save initial map) exports the map's pristine pre-battle state as a
standard BMAPBOLO file. The art is two-sided — "good" is the
viewpoint player's team (the transport-bar selector; the first player by
default), everything else including neutral pillboxes draws as hostile — so it suits the common
two-team game; the vector markers remain better for free-for-alls.
Pillbox sprites encode armour (state 0 = dead); tank sprites cover all 16
directions afloat and ashore; shells and walking men stay vector.
For map debugging, **Cmd/Ctrl+D** (or View → Toggle coordinate debug
mode) shows the hovered tile (0–255) and world-pixel (0–4095) coordinates
whenever no mouse button is held. **Cmd/Ctrl+I** (or View → Toggle
pillbox IDs) labels every planted pillbox with its zero-based ID.
**Cmd/Ctrl+F** (or View → Toggle pill-fire flashes) shows a brief flash
whenever a pillbox fires; these flashes are off by default.

## Status

Real logs from three different games (December 2001 – October 2002, four
to six players, up to 2¼ hours and 120,840 records) parse with **zero
warnings**: every record's subpackets consume its length exactly. A
private corpus of 446 further logs (2001–2004, 13.4 million records,
212 MiB, all Bolo 0.99.7) also parses with zero warnings, zero hard
failures and zero truncations.
`fixtures/n20021018.2` is one of them, **anonymized**: player names,
hostnames, chat name-mentions and IP addresses were substituted with
same-length dummies (IPs from the RFC 5737 documentation range), leaving
every other byte of the replay identical — verified mechanically.
`npm test` runs the full battery against it (parsing, replay-engine
determinism, base-stock model, initial-map extraction) plus synthetic
tests, and additional raw logs are used locally from the gitignored
`samples/`. Please don't submit logs — anonymized or otherwise.

The committed interpolation-decision report is regenerated with
`npm run build:interpolation-report`; the test suite requires the generated
report for the sample replay to remain byte-identical.

The replay engine reconstructs full game state (terrain, pills, bases,
tanks, men, shells, alliances), including the pieces of game logic the log
omits by design — pill dumps on death, boat consumption, alliance
semantics; see the end of FORMAT.md for that list and its caveats. Not
attempted: scoring and sound. Tank, LGM and conservatively matched shell
movement is interpolated between nearby restatements. A matched impact also
carries a shell along its known ray at full speed until its terminal point;
across lag gaps or uncertain identities each object stops at its last known
position.

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
