# The Ancient Bolo Parser handbook

One document that explains the whole project: what Bolo logs are, how
they are encoded, what game they record, what the log leaves out and how
playback fills it in, how the viewer turns sparse packets into smooth
motion, how every claim was measured, and where the tools and archived
runs live. It is a synthesis of the repository's other documentation, not
a replacement for it: every section ends by naming the file that carries
the full detail, and the evidence tags `[E:foo]` refer to entries in
`FORMAT.notes.md`. Where this handbook and a source document disagree,
the source document wins, and this one should be fixed.

## Contents

1. [The project in one page](#1-the-project-in-one-page)
2. [Getting started](#2-getting-started)
3. [The game Bolo](#3-the-game-bolo)
4. [The log file format](#4-the-log-file-format)
5. [What the log does not say, and what playback must supply](#5-what-the-log-does-not-say-and-what-playback-must-supply)
6. [Bugs in Bolo itself](#6-bugs-in-bolo-itself)
7. [The network, as the log shows it](#7-the-network-as-the-log-shows-it)
8. [Shell physics, recovered bit-exactly](#8-shell-physics-recovered-bit-exactly)
9. [Interpolation: from packets to motion](#9-interpolation-from-packets-to-motion)
10. [Measuring the interpolation engine](#10-measuring-the-interpolation-engine)
11. [Roadmap and open questions](#11-roadmap-and-open-questions)
12. [The tools](#12-the-tools)
13. [The archived corpus runs](#13-the-archived-corpus-runs)
14. [Evidence index](#14-evidence-index)
15. [Sources, credits and provenance](#15-sources-credits-and-provenance)
16. [Glossary](#16-glossary)
17. [Map of the documentation](#17-map-of-the-documentation)

---

## 1. The project in one page

**Bolo** is Stuart Cheshire's classic Macintosh networked tank game
(versions 0.90 to 0.99.7). Version 0.99.5 (April 1995) added "Log Events
to File…", which writes a record of everything that happens in a game.
Cheshire never shipped a player for those files. The format was reverse
engineered around 2001–2003 by Carl Osterwald ("wharf rat") for his
commercial BoloViewer; a surviving copy of those notes, preserved with
Rob Keogh's ("Pins") working notes and prototype Perl parser, is the
seed of this project.

Bolo is played over a **token ring**: one packet circulates through
every player's machine in turn, each machine appending its own block as
the packet passes. A log is the recording machine's transcript of that
ring. Every machine in the ring sees the same packets, so, apart from
the time stamps, the local start-of-log burst, and where it starts and
stops, a log written on one machine is byte-identical to a log of the
same game written on another `[E:two-recorders]`.

The repository holds:

- **`src/parse.js`** — a dependency-free ES-module parser (Node ≥ 18)
  that decrypts and decodes a log into records and subpackets.
  `viewer/logparse.js` is a generated classic-script build of it.
- **`bin/dump.js`** — a command-line inspector (summary, event stream,
  JSON, raw hex).
- **`viewer/`** — the *Ancient Bolo Log Viewer*, which reconstructs full
  game state (terrain, pills, bases, tanks, men, shells, alliances) and
  plays it back with smooth interpolated motion, seeking, speeds to 64×,
  a viewpoint selector, and video export. It runs as an Electron app, a
  plain web page, or a Tauri (WebView2) app on Windows.
- **`tools/`** — some forty measurement scripts that establish every
  numerical claim in the documentation by running it over a private
  corpus of real logs.
- **`docs/`** — the format specification, the evidence behind it, the
  rules of the game, the interpolation design, its measured history, and
  the archived corpus runs.
- **`fixtures/`** — two anonymised real logs used by the test suite and
  as the fixed measurement sample: `n20021018.2` (a 2002 four-player
  game on an ordinary ring) and `040601.6` (a two-player game on a
  very fast ring).

The two things the project is proudest of are the evidence base, in
which almost every rule was measured over hundreds of logs rather than
guessed, and the shell interpolator: a forensic reconstruction engine
that draws a shell with no ID in a 25-year-old log flying from muzzle
to target, driven by a bit-exact recovery of Bolo's integer shell
physics.

Everything in the code and documentation was AI-written, under the
direction of the project owner, who supplied the corpus, the game
knowledge and the judgement calls.

---

## 2. Getting started

### The parser and dump tool

```
node bin/dump.js <logfile>            # summary
node bin/dump.js <logfile> --events   # human-readable event stream
node bin/dump.js <logfile> --json     # one JSON record per line
node bin/dump.js <logfile> --raw 20   # hex of decrypted records
```

As a library:

```js
import { records, parseHeader } from "./src/parse.js";
for (const rec of records(new Uint8Array(fs.readFileSync(file)))) {
	// rec.time (50 ticks/s), rec.player, rec.subpackets: tank_position,
	// lgm_position, shells, terrain_change, message, tank_death, ...
}
```

The exported API of `src/parse.js` is `TICKS_PER_SECOND`, `macRoman`
(Mac Roman decoding, so names and chat survive), `parseHeader`,
`formatVersion`, `rawRecords` (decrypted but undecoded), `parseRecord`,
`records` (the generator above) and `parseLog`. After editing the parser,
regenerate the viewer's copy with `node tools/build-viewer-parser.mjs`.

### The viewer

Electron:

```
cd viewer
npx electron .
```

Web: open `viewer/index.html` in a browser, or serve `viewer/` with any
static file server. The web version has no application menu, so it
cannot export video, and its toggle shortcuts are bare keys (D, I, F, L,
G, M, B, R, T) rather than Ctrl+key.

Tauri (Windows): `viewer/tauri/` hosts the same page in a small Rust
shell around the WebView2 engine Windows already ships, so the app is a
few MB instead of a ~200 MB Electron folder. Page files are shared
(`tauri/stage.mjs` copies them in at build time); only the window, menu,
dialogs and file access are reimplemented in `tauri/src/main.rs`, and
`viewer/tauri_api.js` gives the page the same `window.api` the Electron
preload script does. To build locally with Rust and Node installed:

```
cd viewer/tauri
npx --yes @tauri-apps/cli@2.11.4 build
```

The executable is `viewer/tauri/target/release/ancient-bolo-log-viewer.exe`.
Differences from Electron: the menu shows shortcuts but the page handles
the keys itself, and dropped files arrive through the window. Video
export works the same way. Only Windows is set up so far.

Releases: `.github/workflows/release-builds.yml` runs when a release is
published, builds the Windows, Linux and Mac Electron apps and the
Windows Tauri app from the tagged commit, and attaches the zips. It can
also be run by hand from the Actions tab. `tauri-test-build.yml` builds
just the Tauri app from any branch and leaves the `.exe` as a workflow
artifact.

The viewer's menu, and the keys behind it:

| menu | items |
|---|---|
| File | Open log (Ctrl+O), Show file, Save initial map (Ctrl+S), Save video (whole game), Save video (from here) |
| Playback | Play/Pause (Space), Previous change (Up), Next change (Down), Go to beginning (Home), Go to end (End) |
| View | Zoom in/out (Ctrl+=/Ctrl+-), Fit map (Ctrl+0), player lock (Ctrl+L), simple graphics (Ctrl+G), simple terrain (Ctrl+T), simple LGM (Ctrl+M), big shots (Ctrl+B), neutral pill colour (Ctrl+N), full screen (F11) |
| Debug | debug coordinates (Ctrl+D), pillbox IDs (Ctrl+I), pill-fire flashes (Ctrl+F), raw shell positions (Ctrl+R), dev tools |

The viewer's modules: `game.js` (the replay engine: packet-exact world
state timeline), `motion.js` (render-only motion reconstruction, see
§9), `network.js` (the good/fair/bad/awful verdict, see §7),
`renderer.js` (canvas view and transport), `sprites.js` (terrain tile
rules, a port of WinBolo's `screencalc.c`), `format.js` (the `.bmap` map
codec, a port of WinBolo's `bolo_map.c`), `pillbox_shell_orbits.js`
(the recovered shell simulation, §8), `video.js` and `webm.js` (offline
deterministic WebM export via WebCodecs and a hand-rolled muxer).

### Tests

```
npm test
```

runs the parser regression test against the fixture (which must parse
completely with no warnings and yield known ground truth), the viewer
engine tests (including pinned interpolation counts and synthetic
scenes reduced from real incidents), robustness, orbit-table, WebM,
Tauri-API, record-time-order and recording-comparison tests.

### The corpus

Most measurement tools run over a private corpus of logs that lives
outside the tree. They find it through `corpus.json` at the repo root
(gitignored; `{"root": "/path/to/logs"}`) or the `BOLO_CORPUS`
environment variable. A fresh clone has neither, so **an agent
re-running a measurement should ask where the corpus is** rather than
guess. Corpus logs are named after players, and the repository carries
no player handles: tools print a replay as its leading date digits plus
six hex characters of the SHA-256 of its basename (`replay_label` in
`tools/corpus.cjs`), and `tools/find-replay.cjs` maps a label back to a
file for whoever holds the corpus.

Two corpora are referred to throughout:

- the **443-log corpus** (2001–2005, all Bolo 0.99.7, 13.4 million
  records; 446 logs less three corrupt ones), the set behind almost
  every "corpus" figure, and
- a **second corpus of 587 logs**, later supplied, which among other
  things contains ten games each logged on two machines at once. Runs
  over both together are "1,030 logs".

Two single logs are also named: the **sample log** (120,840 records,
October 2002, now the fixture `n20021018.2`) and a second sample.

Detail: `README.md`.

---

## 3. The game Bolo

This section is the rules of play, as distinct from the log. Nearly all
of it is the owner's knowledge, gathered through the questionnaire in
`docs/gameplay_questionnaire.txt`, and then measured wherever a replay
could measure it. `GAMEPLAY.md` tags each statement **(owner)**,
**(owner, unsure)**, **(corpus)**, **(measured)** or **(fixtures)**;
the tags are dropped here for readability but the numbers are the
measured ones.

### The pieces

A game is played on a 256×256 map of 16-pixel squares by up to 16
players, each driving one **tank**. Every tank carries one **man** (the
LGM, "little green man") who can be sent out on foot to build and
repair. The map holds up to 16 **pillboxes** (pills), automatic guns
that fire at hostile tanks, and up to 16 **bases**, which refuel
friendly tanks. Players may form **alliances**; ownership of pills and
bases belongs to a player and, through them, to their alliance, and it
follows the *person*, not the player slot. There is no neutral player:
everyone is hostile to everyone unless allied. Pills and bases can be
neutral.

Time runs at exactly 50 ticks per second.

### Tanks

- **Armour 9.** A tank dies on the ninth net hit. The game displays 8
  bars and the tank dies when hit at 0, which is the same count. A shell
  hit removes 1. **A mine removes 3, floored at 0, and a tank on its last
  2 points is lost outright** (in display bars: 8→5, 3→0, 2→0, 1 or
  0→lost). WinBolo uses 2 with no floor; this is the one WinBolo constant
  so far that Bolo does not share `[E:mine-damage]`. An armour drain from
  a base restores 1 to the tank and costs the base 5. The log has no
  armour field: health is integrated from hits, drains and deaths.
- **Ammunition:** at most 40 shells and 40 mines `[E:ammo-clamp]`.
  Respawn loadout by game type: **open** 40/40/full, **strict** 0/0/full,
  **tournament** a variable number of shells, no mines, full armour.
  That is the only difference between the game types.
- **Speed.** The speed byte is pixels per tick × 64. Top speed by
  terrain: road and boat 64 (1 px/tick, about 3 squares a second), grass
  48, forest 24, river/swamp/crater/rubble 12 (the owner's ratio 16:12:6:3
  exactly). Boats are travelled *in*, not over.
- **Turning** slows with terrain: about 8 ticks per sixteenth of a
  circle on road, grass and boat (2.5 s for a full circle), 16–17 in
  forest (about 5 s), 24–28 on crater, rubble, swamp and river (about
  8 s). WinBolo: 2.61 s, 5.17 s, 10.29 s.
- **Firing** is possible while moving and turning. The interval between
  shots is typically 12–13 ticks, a quarter second, but a quarter of gaps
  are 7–11, the floor is 5–6, and 2.4% of firing records carry two shots.
  Whether the reload varies or the stamps jitter is open. Tank shells run
  the same integer physics as pill shells (§8) at all 256 bradians,
  2 px/tick, about 8.5 tiles of range.
- **Hiding.** A tank is hidden in trees when no non-forest square comes
  within 9 px (Chebyshev) of the tank centre: the whole 16 px box plus a
  one-pixel margin must be forest. A hidden tank is invisible on enemy
  screens and is not targeted by pillboxes.
- **Water.** A tank can cross river slowly, and doing so slowly drains
  its shells and mines (so shots and mine-lays are not the only ammo
  sinks). Deep sea is instant death without a boat (`F9` code 3) and
  harmless in one.
- **Bases as obstacles.** A hostile base is impassable until its armour
  is 9 or less, at which point driving on captures it.
- **Death and respawn.** The wreck's explosion tiers, forest clearance
  and pill dump are in §5. The respawn follows 5.0–6.8 s later
  `[E:respawn-gap]`, at a square of the start list that is not always the
  player's own; the rule is unknown, and neither the nearest start nor
  the farthest from enemies explains the choices seen.

### Shells

- A shell damages any tank it hits, allies included.
- A shell kills the man in one hit, but only if it falls very near him
  or hits a forest square he stands in; otherwise it flies over. While
  he plants, repairs or builds he is briefly inside the thing, and a
  shell hitting it then kills him.
- **A live pillbox stops a shell; a dead one does not.** Apparent
  pass-throughs in the logs were shell-identity errors
  `[E:shell-passthrough]`.
- Friendly and neutral bases do not block shells. A hostile base blocks
  them at armour 5 and above and lets them over below that (hits are
  logged at every armour from 5 to 90 and at 0–4 in only 74 of some
  150,000; WinBolo `BASE_MIN_CAN_HIT 4`).
- A shell detonates a mine it lands on (evented as `7T`), and destroys a
  boat whether or not a tank is in it (the square reverts to river).
- Shells are blocked by, and damage, building, forest and shot building.
  The opening frame of a shot does not fell the tree under the firer
  `[E:muzzle]`.

### Pillboxes

- **Armour 15** at full; each hit removes 1 (`9n`); a superboom removes
  **4** with no event `[E:superboom-pill]`; a single crater on its
  square does nothing `[E:crater-pill]`.
- **Anger.** The delay between shots runs from 100 ticks at rest to 6
  ticks fully angry: fires within 5 s of a hit come every 6–7 ticks, and
  the gap grows roughly 1.5 ticks per quiet second (about 20 at 5–15 s
  since the last hit, 38 at 15–30 s, 66 at 30–60 s, 100 beyond a
  minute). The "speed" byte in the `F1 02` list is this delay: 100 at
  rest, 18–98 in logs started mid-fight, and an unexplained 255.
- **Targeting.** A pill fires at the nearest hostile tank within about
  8.5 tiles that is not hidden in forest, leading a moving target by a
  sector or occasionally two, and it is simulated by the *target's* own
  machine `[E:pill-target]`. It does not fire at the man; it does fire at
  a tank in a boat. A tank touching the pill can make it fire along the
  tank's own facing instead, the "massaging" bug `[E:massaging]`.
- **Capture and repair.** A pill must be dead (armour 0) to be picked
  up, anyone may pick it up, and pickup captures it immediately. Repairs
  never change ownership and are open to anyone (neutral pills are
  repaired to deny the enemy a capture, enemy pills by misclick). One
  harvested tree fully repairs a pill or plants a dead one at full
  health; the partial repairs by 4, 8 or 12 probably happen when the tank
  has less than a full unit of wood.
- **Planting** brings a pill up at full armour; dumping (death, quit,
  killed man) drops it dead, still owned by the same player.

### Bases

- **Stocks.** A base holds up to 90 each of shells, mines and armour.
  **Every player's 1000-tick timer adds 1 to every base's three stocks**,
  so regeneration scales with player count `[E:base-tick]`. A shell hit
  removes 5 armour (`An`); a shell or mine refuel costs 1 of that stock
  and an armour refuel costs 5.
- **Capture.** A neutral base is captured by driving over it at any
  armour (6,973 of 6,975 neutral captures at 90). A hostile base must be
  shot down to armour **≤ 9** first (11,927 of 11,945 at 0–9; WinBolo
  `MIN_ARMOUR_CAPTURE 9`). A base whose owner left with no heir is
  captured at any armour, like a neutral. **Capturing a base from an
  owner zeroes its armour, shells and mines** (measured for armour,
  WinBolo for all three) `[E:base-capture]`.
- **Refuelling.** A base refuels its owner's tank and any ally's. The
  tank need only stay on the square. One shell per 7–9 ticks, one mine
  per 6–8, one armour per 50–54, one resource at a time (1.2% of drains
  interleave), so empty to full takes about 1,050 ticks, 21 s. On a slow
  ring the transfer is capped at one unit per packet the tank sends.
  Every unit is logged as a drain, even into a full tank.
- A base does nothing hostile beyond blocking an enemy's path while it
  has armour, and its square behaves as road whatever the map says
  beneath `[E:base-road]`.

### The man (LGM)

- **Actions:** harvest a tree (forest to grass, yielding wood), build
  road, build a building, build a boat (river only), build or repair a
  pill, plant a mine. Wood costs: pillbox 1, road about 0.5, boat about
  5, building unknown. The action is fast once he is there (medians from
  arrival to event: boat 8 ticks, plant pill 9, repairs 9, building 10,
  mine 11, harvest 14, road 25).
- **Movement:** blocked by everything that blocks a tank, slowed by swamp
  and crater, cannot cross river or swim. 1.0 px/tick on road and grass,
  0.46 in forest, 0.25 on crater, rubble and swamp.
- **Pathing:** a straight line toward the target; on meeting an obstacle
  on one axis he drops that axis and keeps the other; if both are blocked
  he gives up.
- **Death:** a shell kills him at its terminal point whatever it ends
  against: open ground, a pillbox, building, tree, tank (his own as
  readily as an enemy's, since he has just climbed out or is about to
  climb in) or base; explosions on him too. In the fixtures every one of
  86 deaths has a shell arriving at his position within 30 ticks
  `[E:lgm-killers]`. He does not detonate a mine by walking on it. His
  death is logged as `F5`, or `FF 51` if he carried a pill, which lies
  dead where he fell; the man is always the sender's own.
- **Replacement:** a new man parachutes to where the tank was at the
  moment of the death (landing 3–11 px from it), setting out from one of
  the map's start squares, chosen apparently at random (the nearest only
  6% of the time, below chance), drifting at 0.12 px/tick, so the tank is
  without a man for a median 86 s and up to six minutes. The parachute
  rides the `b=4` position subpacket for the whole flight.
- A mine cannot be laid from a boat, but the man can be sent ashore from
  a boat adjacent to land to plant one.

### Terrain

- **Mines** can lie on swamp, crater, road, forest, rubble and grass. A
  tank driving onto one takes 3 armour (with the floor above); the
  square craters (7,187 of 7,348 detonations) or rarely stays grass.
  Whether a shell-triggered mine hurts a tank standing on it, or reaches
  neighbouring squares, is not known. Almost all games disallowed hidden
  mines.
- **Forest regrowth** prefers grass but takes most land squares except
  impassable ones (60,009 of 60,905 on grass, 840 road, 41 crater, 10
  swamp, 4 rubble; 99.8% had a forest neighbour). Each client simulates
  its own growth, so the rate scales with player count: about 0.76
  regrowths per forest-touching grass square per player-hour. It is
  evented as `6 5`, and a mine beneath survives it `[E:mine-persists]`.
- **Craters** can be filled by building road, and flood to river when
  next to water `[E:crater-water]`.
- **Boats.** Driving onto a boat consumes it with no event `[E:boat]`;
  driving off onto land leaves the boat behind on the water square
  (the `6 9` terrain event).
- Rivers block the man and slow tanks; swamps and craters slow both.

### Alliances and players

- Allies' pills do not fire at each other and their bases refuel each
  other. A player can switch view to any friendly pillbox. Messages can
  be addressed to allies only (the `FA` recipient bitmask); the owner
  knows of no "nearby" option, so any other bitmask is hand-picked.
  Allied shells still do damage.
- A leaver's planted pills and bases stay with the alliance; a
  quitter's do too; a disconnection is treated as a quit. Which member
  holds them is invisible in the log; §5 has the viewer's rules.
- **Join** restored nothing; **Rejoin** restored a returning player's
  things. The log does not say which was pressed; playback assumes
  Rejoin.
- Brains (AI players) did chat; nothing in the log marks one.
- The `player@node` history string in the `F1 Cn` groups is unexplained
  `[E:history]`.

Detail: `GAMEPLAY.md`, `gameplay_questionnaire.txt`, and `[E:gameplay]`,
`[E:base-capture]`, `[E:mine-damage]`, `[E:lgm-killers]` in
`FORMAT.notes.md`.

---

## 4. The log file format

All multi-byte values are big-endian unless noted. Coordinates are map
squares 0–255, with a packed pixel byte `yx` giving the position within
the square (high nibble y, low nibble x).

**Centring.** Every pixel-precision coordinate names the top-left of a
16 px cell, so the object sits half a tile further on in both axes:
`(X*16 + px + 8, Y*16 + py + 8)`. A pixel byte of `0x00` places the
object centred on its square. This holds uniformly for tanks, shells and
LGMs, established separately for each `[E:centring]`, `[E:centre-square]`,
`[E:shell-centre]`. Objects without a pixel byte (pillboxes, bases,
terrain events) are named by square outright. The square a tank
*occupies* for game purposes is the one containing its centre, not
(X, Y).

### Terrain codes

0 building, 1 river, 2 swamp, 3 crater, 4 road, 5 forest, 6 rubble,
7 grass, 8 shot building, 9 boat, 10 mined swamp, 11 mined crater,
12 mined road, 13 mined forest, 14 mined rubble, 15 mined grass.

Shells pass over river, swamp, crater, road, rubble, grass and their
mined equivalents. They are blocked by, and damage, building, forest
(mined included), shot building and boat; also by tanks, live pillboxes,
and hostile bases at armour ≥ 5. Tank movement is blocked by building and
shot building, and by a hostile base above armour 9. One hit converts
forest to grass and building to shot building; four more hits convert
shot building to rubble.

### File header (72 bytes, not encrypted)

| offset | size | contents |
|---|---|---|
| 0 | 4 | ASCII `"Bolo"` |
| 4 | 4 | version, e.g. `00 99 07 00` for 0.99.7 |
| 8 | 64 | logging-option flags, `01` = on. Bytes 24–27 are not in the options dialog and are normally `00`; enabling them logs `F0`–`F3` map subpackets when a player joins |

### Records

After the header the file is a flat sequence of records:

| size | contents |
|---|---|
| 4 | time tag, **little-endian**, in ticks (50/s). It is the **recording machine's** clock at the moment it wrote the record: when the ring packet carrying the record arrived, or, for its own record, when it sent it. Not zero-based (initialised from the Mac's `TickCount()`), so only differences mean anything; a 32-bit counter, wrapping after ~2.7 years of uptime, monotonic in file order, so unwrap any huge backward jump |
| 1 | length byte `L` (includes itself, ≤ 127), **encrypted** |
| L−1 | payload, **encrypted** |

**Encryption:** everything after the time tag is XORed with a fixed
128-byte mask (`src/mask.js`), restarting at the length byte of every
record. Records are at most 127 bytes, so the mask never wraps.

### Record payload

| size | contents |
|---|---|
| 1 | **ring slot counter**, 0–0x7F. Every node steps it once per ring cycle as the packet passes; a record carries the count at its sender's turn. A step of *n* between consecutive records means *n*−1 nodes had nothing to log. **A hole is not a lost packet** (§7) `[E:seq-loss]` |
| 1 | high nibble: status bits `b`; low nibble: sending player number |
| 1 | high nibble: tank status bits `T`; low nibble: tank direction |
| … | position subpackets, then ID-coded subpackets |

**Status bits `b`** (bit 0 independent, bits 2–3 a two-bit field):

| value | meaning |
|---|---|
| 1 | 1000 ticks elapsed: every base's shells, mines and armour +1 (capped at 90) `[E:base-tick]` |
| 2 | unused (towed bases) |
| 4 | LGM dead; the position subpacket is the replacement man's **parachute** |
| 8 | LGM out of tank |
| C | LGM out of tank, carrying a pillbox |

If `b & 0xE` is nonzero, a 3-byte position subpacket `XX YY yx` follows
the tank position (if any): the LGM for 8/C, the parachute for 4. This
resolves the values 5, 9 and D the 2003 notes left unknown: 4/8/C with
the tick bit set `[E:ext-bit]`.

**Tank status bits `T`:**

| bit | meaning |
|---|---|
| 1 | tank in boat |
| 2 | tank hidden (in trees) |
| 4 | tank dead / dying (with bit 8: death-animation flame position) |
| 8 | record carries a 5-byte tank position subpacket |

Whole-nibble specials: `7` = tank joining or dead (no position); `F` =
"attached log" pseudo-record from BoloViewer's modified builds. The
direction nibble is 0 = north, increasing clockwise by 22.5° (map
*start squares* use 0 = east, counter-clockwise).

**Tank position subpacket (5 bytes):** `XX YY yx SS ZA`: square, pixel
byte, speed, and `A` = motion bits (1 accelerating, 2 decelerating, 4
turning CCW, 8 turning CW); the direction lives in the header
`[E:tankpos-5]`. A moving tank restates every record, once per ring
cycle; a stationary one only every few seconds (4 to 8 s depending on
the log), so a live, connected player is routinely silent for 6–9 s.
A consumer inferring a split from silence should allow 15 s
`[E:idle-silence]`.

### ID-coded subpackets

After the position subpackets, zero or more subpackets identified by
their first byte, concatenated until the length is exhausted. Notation:
`d` = direction nibble, `n` = object index nibble, `T` = terrain nibble.

| id | size | meaning |
|---|---|---|
| `0d`–`3d` | 4/6/8/10 | **shell list**: 1–4 shells in flight, all in direction `d`; 3 bytes `XX YY yx` for the first, then 2 signed bytes of pixel offset per additional shell, **chained** (each relative to the previous) `[E:shell-chained]`. Only the head is exact; member `i` is uncertain by up to `i` px per axis, one-sided (`reconstructed ≤ exact ≤ reconstructed + i`) `[E:shell-offset-quantisation]`. Lists split by direction, not by source `[E:shell-direction]`. A record may carry up to 12 lists: the sender's own shells plus those of every pillbox it is simulating, which is every pill whose target it is `[E:pill-shell-migration]` `[E:pill-target]`. Every record restates **all** shells the sender simulates `[E:shell-restate]`. **All the lists of one record are one sampling instant** `[E:shell-list-skew]` |
| `4d` | 4 | unused (missile) |
| `5d` | 1 | **shot fired** from tank. The nibble is stamped at **fire** time, not packet-build time, so it names the shell's true direction; about 1.5% of fires race the packet build and the shell first appears one record later `[E:shot-fire-time]`. The first restatement is 6–9 px from the tank centre `[E:muzzle]` |
| `6T` | 3 | **terrain change** to `T` at `XX YY`. `T` is the base terrain, never a mined code, so the event cannot state a mine; where forest regrows over mined grass the mine survives `[E:mine-persists]` |
| `7T` | 3 | **explosion** at `XX YY`; `T` = new terrain, or `B` no change, `C` LGM plants mine, `D` four-square superboom (craters the square and its E/S/SE neighbours, sparing water, bases and pillbox squares; deals 4 eventless damage to any pill in its four squares). A crater on open water or a pillbox square is a no-op; a boat square craters and then floods. Crater flooding *is* evented, 25–37 ticks later `[E:crater-water]` `[E:crater-pill]` `[E:superboom-pill]` |
| `8d` | 1 | unused |
| `9n` | 1 | 1 damage to pillbox `n` |
| `An` | 1 | 5 damage (one shell) to base `n` |
| `Bn`/`Cn`/`Dn` | 1 | base `n` refuels the sender by 1 shell / 1 mine / 1 armour (costing the base 1 / 1 / **5**). Logged even into a full tank `[E:ammo-clamp]` |
| `En` | 1 | unused (missile drained) |
| `F0` | 2 | rejoin / map-header request |
| `F1 01` | 90 | **game info**: the 56-byte `GAMEINFO` struct (36-byte Pascal map name; 8-byte game id = host IPv4 + Mac-epoch start time; game type 1 open, 2 tournament, 3 strict; hidden-mines flag `0x80` hidden OK / `0xc0` all visible; allow-AI; assist-AI; 4-byte little-endian start delay; 4-byte little-endian time limit, in ticks) plus 16 little-endian words of per-player alliance bitmaps (**0 bit = allied**) `[E:gameinfo]` |
| `F1 02` | 3+5n | pillbox list: `x y owner armour speed`. Armour `0xFF` marks a pill inside a tank at log start; the owner nibble is the carrier |
| `F1 03` | 3+6n | base list: `x y owner armour shells mines` |
| `F1 04` | 3+3n | start list: `x y direction` |
| `F1 8n`/`F1 Cn` | 42 | pill/base **history group**: 2-byte LE pills bitmask, 2-byte LE bases bitmask (**set** bits = members), then a 36-byte value shared by every marked object (a Pascal `player@node` string, or `00 01` + zeros). `F1 8n` itself is never emitted; the pill masks ride the `Cn` records `[E:history]` |
| `F2` | 3 | map terrain request (2-byte `mapknown`) |
| `F3` | 3+run | map terrain data: 2-byte `mapknown` (the transfer frontier, `YY XX` of the previous run's row and end column), then one RLE run in `.bmap` format `[E:mapknown]` |
| `F4 nd` | 2 | **pillbox `n` fires** in direction `d`; the shell then appears in the target's shell lists. `d` points at the target, led by a sector when it moves. **When `d` = 0 and `n` is odd, the index may be one too high** (§6) `[E:pill-fire-index]` |
| `F5` | 3 | LGM death at `XX YY`; always the sender's own man `[E:lgm-killers]` |
| `F6` | 1 | tank boards boat: the centre square reverts to plain river with **no** `6T` `[E:boat]` |
| `F7` | 1 | tank lays mine |
| `F8` | 2+len | node id: Pascal string `player@node`; also on rename. A joining player's `F8` has `T=7` and is followed by the ring restating their unchanged ids |
| `F9` | 2 | **tank death**; code 1 explosion, 2 crater, 3 sunk. Terminal cratering is evented and ammo-gated: superboom above 60 shells + mines, single crater from 1 to 60, nothing when empty `[E:death-tiers]` |
| `FA` | 4+len | chat: 2-byte LE recipient bitmask (`FFFF` = all) + Pascal string (max 120 chars, longer messages split) |
| `FB` | 4 | shell falls to ground at `XX YY yx`, the shell's terminal point `[E:shell-fall-terminal]` |
| `FC dn` | 2 | shell (direction `d`) hits tank `n` |
| `FD`, `FE` | 1 | unused |
| `FF 0n`–`FF 4n` | 2 | pill `n`: pickup / repair 4 / 8 / 12 / full. **Pickup captures immediately**; repairs never change ownership `[E:pill-capture]` |
| `FF 50` | 4 | pill planted at `XX YY` (lowest carried index), at **full armour**, unstated |
| `FF 51` | 4 | pill dumped at `XX YY` by a killed LGM, **dead**, unstated |
| `FF 6n` | 2 | base `n` captured by the sender (neutral at any armour, hostile at ≤ 9; taking a base from an owner zeroes its stocks, unstated) `[E:base-capture]` |
| `FF 7n` / `FF 8n` | 2 / 4 | unused (base towing) |
| `FF F0` | 3+3f | player quit: field-length byte, then three `IP:port` fields (upstream / self / downstream ring neighbours); length 4 also occurs rarely `[E:quit-fields]` |
| `FF F1` | 2 | map saved |
| `FF F2` / `FF F3` | 4 | alliance request / accept: 2-byte LE bitfield of **set** bits (opposite of the game-info words). A request names every member of the group; an accept names only the admitted player, who joins the acceptor's **whole** alliance, so links are transitive `[E:alliance-transitive]` |
| `FF F4` | 2 | leave alliance; planted pills (and bases) pass to the remaining allies `[E:leave-pills]` |
| `FF F5` / `FF F6` | 2 | player unlocked / locked |

**Order within a record:** tank position, LGM position, base drains,
pill pickups, base captures, terrain changes, tank death, tank fires,
pillbox fires, shell falls, tank hits, base/pill hits, terrain
explosions, shell lists (oldest first), messages. Map and node
subpackets normally appear alone.

**Start-of-log sequence:** an `F8` for every player, then `F0 00`,
`F1 01`, `F1 02/03/04`, `F1 Cx` history, and `F3` map runs for the whole
map. A log started while the map is still downloading is defective. The
burst is written locally and sent to nobody.

Detail: `FORMAT.md` (the specification) and `FORMAT.notes.md` (the
evidence for every tagged claim).

---

## 5. What the log does not say, and what playback must supply

The log is a transcript of the ring, and the ring carries only what the
machines need to tell each other. Everything they all compute locally is
absent, so a player of logs has to re-implement fragments of the game.
Every rule here was recovered from the corpus, an emulator, or the
owner, and the viewer (`viewer/game.js`) implements all of them.

**Death, dumps and craters**

- **Dropped pills on tank death** are placed by a serpentine search
  outward from the death square, lowest index first, each taking the
  next acceptable square of a single never-backtracking search. The
  search accepts almost anything, river and deep sea and every mined
  variant included, refusing only a square holding a pill or base and
  three terrains: building, shot building and boat `[E:dump-terrain]`.
  Exception: if the man is out carrying a pill (status `C`) when the
  tank dies, the lowest-index carried pill is in his hands and is not
  dumped; he goes on to plant it `[E:man-carrying]`.
- **A quitting player's carried pills drop the same way** around the
  last tank position `[E:quit-pills]`.
- **Dumped pills are dead** (armour 0), however they were dropped; a
  planted pill comes up at full armour.
- **A pill dumped onto a mined square clears the mine** without a
  crater `[E:dump-mine]`.
- **Every dying-tank position clears nearby forest** with no events:
  a **15×15 pixel box** centred on the tank, felling a square's forest
  when its nearest pixel is within 7 of the centre on both axes
  (Chebyshev, not Euclidean). A grounded pillbox masks the forest
  beneath it from this clearance `[E:forest-circle]`.
- **A crater on open water or a pillbox square is a no-op**; a boat
  square craters and floods back. The pill's square is spared by both
  crater paths while a superboom still deals its 4 damage
  `[E:crater-water]` `[E:crater-pill]`.
- **The delayed second explosion of a dying tank is its cargo** cooking
  off, about 0.9 s after the `F9`; those `7D` events are logged
  `[E:superboom-cargo]`.

**Terrain state**

- **A mine survives a terrain change.** Forest regrowing on mined grass
  arrives as a plain `6 5`; playback must keep the mine bit. Only this
  transition is applied, since others plausibly clear the mine
  `[E:mine-persists]`.
- **A tank boarding a boat** reverts the square to plain river
  `[E:boat]`.
- **A mine under a starting pillbox does not exist**; clear it from
  squares occupied by initial pills.
- **A base's square behaves as road** whatever lies beneath (the map
  carries real terrain under every base: 33% crater, 33% road, 19% mined
  crater, 10% grass, 5% forest) `[E:base-road]`.
- **A captured base loses its stocks** when taken from an owner
  `[E:base-capture]`.
- **Pills inside a tank at log start** are flagged only by armour
  `0xFF` in the `F1 02` list.

**Ownership, alliances and people**

- **Ownership and alliances belong to the person, not the slot**
  `[E:owner-signals]`. Netsplits shuffle players across slots, sometimes
  with no quit event at all. A person-keyed model explains every one of
  the corpus's 1.28M drains and 19K captures where every slot-keyed
  reading fails somewhere. Playback keeps slot-indexed owners and honours
  the person through four identity rules: a join under the **same** name
  is a reconnect keeping the slot's alliance links; a join under a
  **new** name implicitly quits the displaced name, handing over its
  grounded things like an announced quit; a quit-flagged slot still
  sending past a straggler second (a netsplit ghost) recovers its things;
  and a rename that collides with a live name consolidates that name's
  property onto its lowest live slot.
- **A quitter's planted pills and bases stay with his alliance**, not
  with whoever takes the slot. Playback hands them to the lowest-index
  remaining ally **who has a tank**; when no ally holds a tank they are
  nobody's (DEPARTED), hostile to everyone, returning only if the owner's
  name rejoins (Rejoin assumed) `[E:pill-target]`.
- **Leaving an alliance (`FF F4`)** hands planted pills and bases to the
  lowest-index remaining mutual ally; carried pills stay with the leaver
  `[E:leave-pills]`.
- **The fire correction:** a pill never fires at its own side, so a pill
  that fires at a player playback holds friendly to it is proven wrong
  and becomes nobody's until next picked up or planted. Exempt: a fire
  within a second of an alliance event, and an odd index at direction 0.
  Over the corpus this rule triggers 0 times once the hand-over rules
  are in place; in the second corpus it repairs the one known failure
  shape (a quit made while the quitter's alliance request still named a
  departed player).
- **Ring splits are invisible**: a player who disconnects without a
  quit simply stops sending and remains a ghost. A later slot admission
  is inferable from its `T=7` `F8` and the burst of unchanged `F8`s that
  follow, at which point the slot's old alliances must be cleared.

**Shells and presentation**

- **Pill-fire shell motion uses 128 fine directions** (the odd bradians),
  so the `F4` nibble alone cannot determine the spawn point; the full
  simulation is recovered (§8) and playback can reconstruct a shell back
  to its muzzle once a restatement pins the orbit.
- **Shells appear to pass through live pillboxes**: an artifact of
  mistaken shell identity, not a rule `[E:shell-passthrough]`.
- Shell flight, explosions and sounds are largely presentational: every
  sender restates its shells every record, so drift never accumulates.

Detail: the closing section of `FORMAT.md`.

---

## 6. Bugs in Bolo itself

Almost everything that looks wrong in a log is a rule not yet worked
out, so the bar is high: the game must be at fault. Three entries
qualify.

1. **The `F4` pill index is corrupt for shots just west of due north.**
   Bolo packs the byte as `(n << 4) | BRAD_TO_PACK(bradian)` with
   `BRAD_TO_PACK(x) = (x + 8) >> 4`, which yields 16 rather than 0 for
   bradians 248–255, and the carry lands in the index nibble: the log
   reports `n | 1` at direction 0. An even index is never wrong; an odd
   index at direction 0 is the pill above the real firer about half the
   time; about a quarter of all direction-0 fires are affected; every
   other direction is right about 99% of the time. The rate is uniform
   across years (22–27%) and slots (23–25%), so it is what 0.99.7 does.
   It survived twenty years unnoticed because nothing depends on it: the
   shell is restated regardless, damage and capture carry their own
   indices. The independent proof: 2,123 `F4`s in the corpus name a pill
   our model holds *inside a tank*, every one at direction 0, and in all
   2,123 the pill one below was on the ground `[E:pill-fire-index]`.
2. **A quitter's planted pills and bases apparently go to nobody when
   his only ally is dead.** Property passes to an ally who holds a tank
   at that moment; a dead ally whose tank later came within range was
   shot in three of the four quits the corpus offers (40 fires), and the
   fourth was not given longer than a hostile pill has been seen to
   wait. A merely out-of-touch ally still inherits, and with the lowest
   ally dead but another live the property goes to the live one. This
   changed the game (orphaned pills hostile to everyone), so playback
   reproduces it. Four quits is a small sample, hence the hedge
   `[E:pill-target]`.
3. **`F1 8n` is never emitted**, so the pill half of the history
   grouping is recovered from the masks on the `Cn` records. Not this
   project's find: the 2003 notes attribute it to a flaw in Bolo's
   `log_bootinfo` `[E:history]`.

Not a bug, but easily mistaken for one: the mine surviving a `6 5`
regrowth. The clients agreed about the square; the log simply declines
to restate the mine `[E:mine-persists]`.

Detail: `FORMAT.md`, "Bolo bugs discovered".

---

## 7. The network, as the log shows it

**The ring slot counter.** The payload's first byte was long read as a
sequence number whose holes were lost packets. Two logs of one game,
written on two machines at different ring positions, killed that
reading: their holes are identical, and not one missing slot in either
is a record the other machine had. The byte is a **ring slot counter**,
stepped by every node as the packet passes whether or not it has
anything to say; a hole is a quiet slot (a parked tank between
restatements, a dead one, the recorder itself). Over 1,006 logs and
1.96 million missing slots, exactly **16** fall on a tank that was
moving, all crawling at speed 18 or under of 64 where a stop for one
cycle costs nothing, and across the ten two-machine games no packet was
ever lost between two machines in 191,000 records. What the network
does show is the **stall**: a packet held up for 5–10 s on its way
round, stamped at one machine when the wait ends and at the other
before it began `[E:seq-loss]` `[E:two-recorders]`.

**Two recorders.** Every ring record of the shorter of a matched pair is
in the longer, byte for byte, sequence byte included; a log's only
per-machine content is its time tags, its start-of-log burst, and where
it starts and stops. The stamp offsets between two recorders fall into
two groups a ring cycle apart (a sender's packet reaches whichever
recorder comes first on its way round), which names both recorders and
confirmed the viewer's burst rule twenty times over. Two Macs' clocks
drift by 1–24 ppm, under a tick a minute.

**The gathering phase.** While a game is gathering (map handed to
joiners, nodes arriving) the ring turns at full speed while the recorder
logs a fraction of it, so the counter races ahead and the quiet-slot
share reads as catastrophic. It is short (median 56 s) but dominates
any untrimmed average. Settled play is best marked by the **first base
capture**, which every one of 445 logs has. The apparent year-on-year
improvement from 2001 to 2005 is almost entirely faster map transfers
shortening the ramp: settled-play medians are flat (6.6% to 5.7%).

**Silence.** A live, connected player is routinely silent for 6–9 s; over
13.3 million silences, p99 is 5.6 s and the longest idle silence is
19.7 s, but the wall-clock tail runs to 28.9 s and is made of *moving*
tanks silent several at once, the ring crawling for everyone. The viewer
fades a tank after 15 s of clock time `[E:idle-silence]`.

**Latency.** A slow ring drops nothing and need not stall; it delivers
everything late. Measured as the p90 gap between one record from a
player and the next from the same player, settled play runs 6–27 ticks
(median 9), rising with player count. It is the reading that predicts
what a viewer can make of the stream: the share of shell observations
the motion code fails to chain forward tracks cycle p90 at rho 0.76,
against 0.41 for stall and 0.25 for loss.

**The verdict.** `viewer/network.js` rates each game good / fair / bad /
awful from three readings over settled play (quiet-slot share, bands
6/11/22%; stalled time, bands 2/7/18%; p90 cycle, bands 14/19/26 ticks),
taking the worst, which places the corpus at roughly 38% good, 46% fair,
13% bad, 4% awful. Half-minute interleaved halves of a game agree at
r = 0.88 / 0.94 / 0.99, so one verdict per game is fair.

Detail: `[E:seq-loss]`, `[E:two-recorders]`, `[E:idle-silence]` in
`FORMAT.notes.md`; `viewer/network.js`; `tools/measure-seq-holes.cjs`,
`compare-recordings.cjs`, `measure-tank-silence.cjs`,
`measure-network-conditions.cjs`, `measure-network-agreement.cjs`.

---

## 8. Shell physics, recovered bit-exactly

### The pillbox shell simulation

Pillboxes fire in exactly **128 discrete directions**: the odd bradians
1, 3, …, 255 (bradian 0 = north, clockwise, 256 to the circle; eight
fine directions per 4-bit coarse sector). From the orbit data in
`docs/pillbox-shell-orbits-compact.json`, the original integer
simulation was recovered so that all 128 trajectories (4,224 coordinate
pairs) reproduce bit-exactly:

```c
/* quarter table, 65 entries, 0..128, magnitude-TRUNCATED, not rounded */
SIN[i] == (int)(128.0 * sin(i * 2*PI/256))

#define SCALE(dir, dist)  (((SIN[dir] * (dist)) + 64) >> 7)   /* arithmetic shift */

dir = bradian;                       /* 0..255, always odd for a pill */
opp = (dir + 192) & 255;             /* sin(theta - 90) = -cos theta: the Y component */

x = SCALE(dir, 128);   y = SCALE(opp, 128);   /* muzzle: 128 units = half a tile */
vx = SCALE(dir,  64);  vy = SCALE(opp,  64);  /* speed: 64 units per update = quarter tile */

for (n = 0; n <= 32; n++) {          /* spawn point + 32 moves, then it expires */
	plot(x >> 4, y >> 4);            /* internal units are 1/16 px; render by >> 4 */
	x += vx;  y += vy;
}
```

One update every two ticks, so 2 px/tick; 32 updates, 64 ticks; range
128 + 32·64 = 2,176 units = **8.5 tiles**. The sprite's coarse direction
is `((bradian + 8) >> 4) & 15`, round-to-nearest. The give-away that
pins the rounding is that it is asymmetric by *sign*: `(T + 1) >> 1` on
a signed table value, so +1.571 rounds to +2 and −1.571 truncates to −1.
The obvious alternatives (a `round(64·sin)` or `trunc(64·sin)` table,
uniform rounding at any amplitude, `/2` instead of `>>1`, negating after
the shift) are each ruled out by specific bradians. Because the muzzle
offset is the unhalved table entry, each entry is used at two scales and
so pinned exactly. `viewer/pillbox_shell_orbits.js` regenerates every
orbit: for each bradian, every whole-pixel position the shell can ever
occupy plus its terminal point.

### Tank shells run the same simulation, at all 256 bradians

`tools/measure-tank-shell-bradians.cjs` asks of every matched tank-shell
chain (3+ restatements) whether some bradian, sub-pixel origin and
per-record update counts reproduce every observed pixel under the
one-sided quantisation bounds. Over 443 replays and 586,186 chains: the
recovered model is consistent for **96.2%** at ±1 update of jitter
(98.3% at ±2; 97.8% of confident tank-origin chains), holding equally at
length 3 and 10+. Against the controls (round table, trunc table,
every-tick cadence) the discrimination is one-sided by ratios of
hundreds to one. Uniquely pinned chains land on 117,029 even and
123,479 odd bradians: pills never fire even bradians, tanks do
constantly. The nibble mapping is round-to-nearest, with a symmetric
±1–4 bradian spill past the window's edges (about 2%), which is what a
turning tank produces if nibble and bradian are sampled a tick or two
apart; the matcher's direction gate is therefore [−12, +11] bradians
around the nibble. The unexplained residue (`no_model_s1` 1.6%) is
straight lines at ~1.9 px/tick, consistently slow: senders whose
simulation stalled while their stamps kept counting (*dilation*), plus a
few mislinks that visibly curve. Tank shells differ from pill shells in
having no absolute track: the firing tick and the tank's sub-pixel
position are unknown, so a tank shell carries per-bradian hypothesis
boxes that narrow as the chain grows.

### The offset quantiser

The chained offsets between list members are `(next_internal −
previous_internal) >> 4` with a signed arithmetic shift, so each byte
rounds down. This reproduces 18,873 of 18,875 adjacent uniquely resolved
pill-shell pairs in the fixture. The consequence for matching: member
`i`'s true coordinate lies in `[reconstructed, reconstructed + i]` per
axis, never below, and the raw bytes themselves are a constraint two
orbit hypotheses must reproduce `[E:shell-offset-quantisation]`.

Detail: `pillbox_shell_algorithm.md`, `tank_shell_bradians.md`,
`pillbox-shell-orbits-compact.json`.

---

## 9. Interpolation: from packets to motion

Everything in this section feeds *drawing only*. State reconstruction
stays packet-exact; interpolation is a rendering layer in
`viewer/motion.js` that looks ahead to the next trustworthy restatement.

### The problem

Moving objects are restated about four times a second and nothing
carries an identity. Tanks and LGMs restate absolute positions, so the
work is knowing when *not* to join consecutive points. Shells are the
hard case: each record restates every shell its sender simulates as
anonymous lists that gain and lose entries at any restatement, and the
log never says which shell at time T is which at T+5.

### Two clocks

The sender's simulation clock is exact but invisible: it advances every
shell one step every two ticks, all together, and a shell list is a
snapshot of it. The record's stamp is the recorder's receive tick, which
can run early or late against the contents by a few updates. When the
error wanders record to record it is *jitter* (a per-hop speed read off
two stamps can come out anywhere from 0.7 to 3.6 px/tick around the true
2); when a sender's simulation falls behind its stamps it is *dilation*
(its shells read consistently slow). On a fast ring stamps also collide,
two snapshots in one recorder tick. The rule the engine follows:
**distance is the trustworthy quantity and time the approximate one.**
In matching, time is a tolerance (a link must fit within two updates of
what its stamps imply, re-anchored per link); in drawing, stamps give
way to distances (chains re-timed to constant velocity, late heads and
tails slid along their ray, effects placed at the physics arrival).

### Tanks and LGMs

Per-player tracks of timestamped points, each marked continuous or not;
continuity breaks on death, quit, dying flags, parachute/walking
transitions and LGM tank entry. Windows are bounded: **position 25
ticks** (beyond that, hold the last point rather than draw through lag),
**facing 50 ticks** (corpus measurement showed gaps of 26–50 ticks imply
no turn faster than turns seen inside the trusted window, while past 50
the shorter way round is a coin toss). An LGM whose status flips to "in
tank" is animated to the tank if close enough.

Drawing gets a cautious jitter treatment (`smooth_track_positions`): on
a fast ring receive stamps bunch (dt = 1, 3, 1, 3 around a true 2) and
verbatim re-sends draw as freeze-and-jump. A point is eligible only
where the raw path through it is straight, every correction is a pure
slide along the point's own chord (a tank only ever moves on one of 16
facings, so any lateral bend reads as impossible motion), and the slide
is capped. The pass engages only between closely spaced statements and
leaves normal-cadence replays pixel-for-pixel untouched. Corpus-wide,
29.3% of tank statements and 20.9% of LGM statements sit at the few-tick
gaps it engages on; it cut tank speed alternation by 40%.

### Shells: the pipeline

Shells fly at exactly 2 px/tick, the backbone of everything. Matching
runs per *client* and a chain never crosses one: the idea that a shell's
simulation migrates between machines mid-flight is regarded as highly
suspicious (no mechanism, and no scene measured that needed it), and a
cross-client coincidence renders as one shell vanishing and another
appearing.

1. **Verbatim re-sends** are linked first (`link_stale_restatements`):
   on a fast ring over half of closely spaced statements repeat the
   previous record's samples byte for byte under a fresh stamp; a
   byte-identical pair within 4 ticks is one statement re-sent
   (identity, zero advance). Zero-duration snapshot pairs are matched,
   not skipped.
2. **Pairwise matching** (`match_shell_snapshots`) between consecutive
   snapshots: same 4-bit direction, cost from deviation against
   `duration × 2 px/tick` plus angular error against a heading refined
   from the whole track. Terminals (`FB` an exact point; `FC`, `9n`,
   `An`, attributable `7T` as 16 px boxes) compete as candidates with
   multiplicity. A pill shell on a pinned orbit is walked first against
   the interpolated tank track, then, only if that finds nothing,
   against the box the packet states, starting one step on (the
   sender's picture of a remote tank is its last restatement, so for a
   tank driving away the packet box is the honest one). Assignment is
   **mutually best with a margin** (`SHELL_MATCH_MARGIN` 3 px); an
   unmatched pop is safer than an invented path.
3. **Discrete hypothesis tracking.** A pill shell carries a set of
   `(bradian, step)` orbit states consistent with everything seen; a
   continuation must be a later step on a surviving orbit within the
   one-sided bound, and an empty set proves it impossible. Raw chained
   offset bytes prune state pairs. When the states agree on one pixel
   the exact simulation position is recovered. Tank shells carry
   per-bradian boxes bounding their internal coordinate.
4. **Lockstep.** All of one pill's live shells advance the same number
   of steps per sender transition. Three enforcement points: candidate
   intersection across the pill's whole roster
   (`enforce_pillbox_lockstep_candidates`, standing down when no common
   advance exists), a **statement-roster vote**
   (`enforce_roster_lockstep_candidates`: the pill's pinned statements
   elect the one advance, accepted at score ≥ 3 and margin ≥ 2, held
   with and without members holding a terminal candidate, with an
   orphan-free tie-break for margin-one or tied elections), and the same
   vote as a veto in stitching and the residual flow.
5. **Birth attribution.** New shells are matched back to `5d` (within
   range and sector of the firing tank, refined against its interpolated
   track) and `F4` (orbit treatment; odd index at direction 0 also tries
   `n−1`). Shells drawn from the muzzle. Lost-`F4` shots are claimed from
   orbit membership alone when every observation lies on one live pill's
   orbit at strictly increasing steps; heads already named by ambiguity
   propagation get stream-provenance births.
6. **Stitching** (`stitch_shell_chains`) reconnects chain ends to
   origin-less starts under the ordinary physics, with orbit evidence
   allowed to bridge up to a shell lifetime; *dilated joins* retry under
   time-only widened windows at a penalty; *visual joins* draw a
   continuation without believing it where every candidate story draws
   the same line.
7. **Residual resolution** (`resolve_residual_shell_fates`): per
   component, a min-cost maximum-flow over suppliers (unaccounted chain
   ends, unconsumed shots) and consumers (origin-less starts,
   unexplained impacts), applying every edge present in every maximum
   assignment or forced by cost beyond the margin. Impacts may *lead*
   the receiver-clock estimate by the gap back to the sender's previous
   record. A join to an orphan that is provably an intermediate of a
   fate's flight is *subsumed* so the two halves cannot veto each other.
   A second additive phase force-assigns same-record shots (fire and
   impact in one record: point-blank flights) onto remaining fates, then
   an equivalence phase attributes fates whose every story names one
   source. *Die-at-impact* gives a popping-out end its death when every
   within-margin story is a death at one geometry. Unseen-source
   attribution names the pill or tank for impacts whose shell was never
   observed.
8. **Absorption** (`absorb_intermediate_observations`): stitches and
   forced terminals absorb the jittered on-path restatements they
   bridge, gated by uniform time (24 px), at most one candidate per
   snapshot, with orbit evidence overriding the clock both ways.

### Rendering

A render tick is answered by binary-searching the track, verifying the
stored state still matches packet-exact state, and lerping toward the
matched successor or terminal. Effects are retimed to the inferred
arrival; an object impact stays capped at its record (the record drops
the shell from state), a shell fall keeps its 2 px/tick arrival even
past the record, with fall segments carrying the sprite to the retimed
splash. A chain end with no forward story vanishes rather than hovers
(most such ends are real deaths). Drawing-only passes after every
identity is decided, in order: tail slide, constant-velocity smoothing
of chains of three or more (cross-track guard 24 px, along-track 48
px), endpoint reconciliation (so handoffs never seam), head slide.

Constants worth knowing (`viewer/motion.js`): position window 25 ticks,
shell and facing windows 50, shell speed 2 px/tick, match error 8 px,
margin 3 px, tank-hit tolerance 2 px, stale re-send bound 4 ticks, stitch
gap 100 ticks, tank shell flight limit 72 ticks, shell range 136 px,
tank bradian gate [−12, +11].

Detail: `INTERPOLATION.md`, and the comments in `viewer/motion.js`.

---

## 10. Measuring the interpolation engine

Two instruments judge every matching change, on two samples.

**`tools/report-interpolation-rates.cjs`** scores an engine build on a
fixture (`-f`) or the corpus (`-r`, or configured): `rate_shells_matched_forward`
(shells matched onward to a snapshot or terminal), `rate_shells_unlinked`
(appeared and vanished unexplained, the clearest failure signal),
`rate_terminals_matched` (impacts and explosions a shell explains),
attribution and birth counts, and the **vouched-link truth axis**
(`score_pill_links`): every pill link whose ends both pin an orbit step
is vouched, contradicted or unvouched against the roster vote, and
`links_pill_contradicted` is a regression alarm rather than a coverage
figure. `--describe-links` names every contradiction as a scene;
`--describe-terminals` and `--describe-ends` census what blocked each
unexplained terminal and each unfated chain end.

**`tools/audit-drawn-motion.cjs`** samples what the renderer draws:
link speeds (a perfect engine draws everything at 2 px/tick), hover
(<1) and rush (>3, split timed / static / instant) links, seam jumps at
handoffs (an invariant, now 0), pop-outs and pop-ins, and backwards
pops; `--describe-backwards` names them. `tools/audit-track-motion.cjs`
does the same for tanks and LGMs.

Both were built because the headline rates count explanations, not
correct ones: a commit once made the numbers fractionally worse and the
replays visibly better, and a wrong link scores like a right one.

**Where the line stands.** On the fixture `n20021018.2`:

| state | matched forward | unlinked | terminals matched |
|---|---|---|---|
| v1.0.7 `323c673` | 0.929101 | 0.029667 | 0.771713 |
| branch point `76d8b8a` / v1.0.8 | 0.961100 | 0.016596 | 0.817321 |
| `926f391`, close of the ten-run table | 0.980136 | 0.008081 | 0.849553 |
| v1.0.9 `8f6fe27` (engine `a74033a`) | 0.994427 | 0.002535 | 0.856366 |
| `30d5351`, the stale-box walk, current | 0.996298 | 0.001736 | 0.860478 |

On the 443-log corpus (9,817,361 shell observations, 1,946,439
terminals) at `30d5351`: matched forward 0.996882, unlinked 0.001384,
terminals 0.833914 (`tank_hit` 237,399 of 269,483), 13,108 timed rushed
terminal links, 1,360 backwards pops, 94 contradicted pill links in
5.09 million scored, seam jumps 0. Counting unseen-source attributions,
about 96% of corpus impacts have an explanation. Pill-link
contradictions on the fixture are 0; pop-outs went from 1,465 at the
pre-branch state to 273; steady links from 0.787 to 0.979. Tank and LGM
position tracks have never moved.

**The arcs, in order** (each entry in the two test files has the
mechanism, the fixture delta, the corpus delta and its prediction):
the pillbox orbit data and the one-sided quantisation bound; tank
shells joining the discrete simulation; chain stitching; forced residual
assignment; jitter absorption and constant-velocity drawing; the drawn
audit; cost-forced assignment; the pop rescue (dilated and visual joins,
v1.0.9); leading impacts; uncapped falls; orbit-backed absorption and its
guards; unseen-shot and stream-provenance births; the terminal census,
same-record shots, equivalence attribution and die-at-impact; subsumed
joins; the pill lockstep arc (stream lockstep, late-head slide, dilated
continuations, seam closure, tail slide, smoothing guard split,
pill-wide lockstep, residual veto, pairwise roster vote); fast-ring
re-sends and track smoothing; the vouched-link metric; doubtful voters
abstain; the symmetric election and orphan tie-break; the index-keyed
vote table (measured null, reverted); two quadratic scans removed; the
sender's stale tank box; the rush split.

Recurring lessons the history teaches: a fixture delta typically
amplifies about a hundredfold on the corpus because residues concentrate
in laggy games; `pop_outs` moves by exactly the complement of forward
matches gained; a deliberate give-back of invented explanations reads as
a loss on the coverage axis and a gain on the truth axis; the static
four-fifths of the rushed-terminal line is a property of the corpus, not
the engine.

Detail: `interpolation_tests.md` (fixture history and metric definitions),
`interpolation_tests_corpus.md` (corpus history, headline table, findings).

---

## 11. Roadmap and open questions

The interpolation roadmap's numbered items are nearly all done: the
drawn-motion audit (1), cost-ranked assignment at margin 3 (2), the pop
rescue (2b), absorption override and orbit births (2c), terminal
matching for stream leaders (6, closed at the knee), the pill lockstep
arc (9), doubtful voters (10), the symmetric election (11), and the
index-keyed vote table (12, measured null and reverted). Drawing unseen
shots (3) was scoped down to shots beyond an adjacent tile, low
priority; shooter attribution as stats (4) is parked; network-weather
profiling (5) and tank-stream turnover (7) are optional. Small engine
debts (8): `propagate_identity_down_chain` drops orbit states past a
stitch; the pace / drawn-speed residue. The **mode from here is
complaint-driven**: the owner watches replays and reports scenes that
look wrong, each gets a record-level scene dump, a census classification
and a measured fix.

Ideas shelf: a falls rescue / forced fates (roughly half the 4,368
corpus unmatched falls have a legal declined story); the same-record
starvation fix; a per-link record of which pass made it, which would
settle whether the 29 two-hop stitched contradictions are the scorer's
yardstick being wrong.

Gameplay measurements still open: whether a shell-triggered mine hurts
a tank on the square and reaches neighbours; whether the tank reload is
variable or the stamps jitter; whether pill anger doubles per hit and
what a speed byte of 255 means; whether shells and mines reset on
capture and whether refuelling needs the base above 10 armour; the
respawn and parachute start choice; the `F1 Cn` history string.

Standing questions for the owner: where a stats surface should live;
risk appetite for the assignment margin; whether unseen-shot drawing
should be toggleable; whether a tank-birth analogue is worth the
false-claim risk.

Detail: `ROADMAP.md`; "Open measurements" in `GAMEPLAY.md`.

---

## 12. The tools

All under `tools/`, all Node scripts, most reading the corpus via
`tools/corpus.cjs`. None writes to disk; each prints its tally to stdout,
stamped with the measuring commit and the input hash where the tool has
learned to.

**Measurement of format and gameplay claims**

| tool | question it answers | evidence entry |
|---|---|---|
| `measure-gameplay.cjs` | tank armour, speed byte, hiding, turning, reload, pill anger, refuel rates, man speeds and dwell, parachute, regrowth, base captures | `[E:gameplay]` `[E:base-capture]` |
| `measure-mine-damage.cjs` | how much armour a mine takes | `[E:mine-damage]` |
| `measure-death-ammo.cjs` | ammo aboard at death against the explosion tier; the 40-round clamp | `[E:death-tiers]` `[E:ammo-clamp]` |
| `measure-pill-damage.cjs` | superboom damage to a pill (4), single crater (0), planted armour (full) | `[E:superboom-pill]` |
| `measure-crater-pill.cjs` | whether a crater changes the ground under a pill (no), read via flooding | `[E:crater-pill]` |
| `measure-dump-terrain.cjs` | which squares a death dump accepts | `[E:dump-terrain]` |
| `measure-tree-clearance.cjs` | the dying tank's forest clearance (box 7, pill-masked) | `[E:forest-circle]` |
| `measure-pill-target.cjs` | which machine simulates a pill's shot; hand-over of a quitter's pills; massaging | `[E:pill-target]` `[E:massaging]` |
| `measure-pill-fire-index.cjs` | the direction-0 index fault | `[E:pill-fire-index]` |
| `measure-pill-owner.cjs`, `measure-base-owner.cjs` | person-keyed ownership, policed by drains, captures, pickups and fires | `[E:owner-signals]` |
| `measure-pill-position.cjs` | whether a firing pill is where the model says | |
| `measure-shot-direction.cjs` | fire-time vs packet-time direction nibble | `[E:shot-fire-time]` |
| `measure-shell-list-staleness.cjs` | per-list sampling skew within a record (none) | `[E:shell-list-skew]` |
| `measure-tank-shell-bradians.cjs` | tank shells on the recovered simulation | `tank_shell_bradians.md` |
| `measure-lgm-killers.cjs` | what kills a man | `[E:lgm-killers]` |
| `measure-seq-holes.cjs` | what a hole in the ring counter is | `[E:seq-loss]` |
| `compare-recordings.cjs` | two logs of one game side by side; `--scan` finds pairs | `[E:two-recorders]` |
| `find-same-game-replays.cjs` | logs sharing a game id | |
| `measure-tank-silence.cjs` | how long a live player goes silent | `[E:idle-silence]` |
| `measure-network-conditions.cjs`, `measure-network-agreement.cjs` | the good/fair/bad/awful bands and whether the verdict predicts interpolation | `[E:seq-loss]` |
| `check-record-time-order.cjs` | that a sender's stamps never run backwards (they don't, over 13.3M records) | |

**Interpolation measurement and diagnosis**

| tool | purpose |
|---|---|
| `report-interpolation-rates.cjs` | the coverage and truth rates (§10); `--describe-links`, `--describe-terminals`, `--describe-ends` |
| `audit-drawn-motion.cjs` | the drawn shell motion audit; `--describe-backwards`; `--engine=DIR` to measure another checkout |
| `audit-track-motion.cjs` | the drawn tank and LGM motion audit |
| `build-interpolation-report.cjs` | a human-diffable account of every interpolation choice on the fixture |
| `find-hover-links.cjs`, `find-seam-jumps.cjs`, `find-flow-cap-components.cjs` | locate the worst instances of an audit class so a human can watch them |
| `probe-shot-fate-parsimony.cjs` | the feasibility probe behind the residual flow |
| `measure-pillbox-orbit-effect.cjs`, `measure-pillbox-tank-hit-tolerance.cjs` | compare the matcher with a baseline revision or a 0 px tolerance |
| `_check_death_impact_codes.cjs` | a one-off check of death impact codes |

**Build and utility**

| tool | purpose |
|---|---|
| `build-viewer-parser.mjs` | regenerate `viewer/logparse.js` from `src/parse.js` |
| `corpus.cjs` | resolve the corpus root; `replay_label` |
| `find-replay.cjs` | map a redacted replay label back to a file |

`main_audits.bat` at the root runs the rates report and the drawn audit
into `report.txt` and `audit.txt` for the corpus holder.

---

## 13. The archived corpus runs

`docs/corpus_runs/` holds the corpus holder's raw tool output, named
`<commit>-<kind>.txt` after the commit the tool ran at. Each is the
primary source for the figures quoted in the documents.

| kind | count | what it is |
|---|---|---|
| `report` | 12 | `report-interpolation-rates.cjs` over the corpus, one per measured engine state from `e2bbbfb` to `30d5351` (plus the reverted `f970ce7`) |
| `audit` | 14 | `audit-drawn-motion.cjs` over the corpus at the same states, plus the drawing-only commits `c890ecc`, `baee09c` and `716a349` |
| `audit-split` | 20 | the same audit under the `eb6157f` rush-split tool, re-run against every headline engine from `a74033a` on |
| `links` | 4 | `--describe-links` runs naming every contradicted pill link (`3c37c4a`, `41bb718`, `0bfd71d`, `f970ce7`) |
| `track` | 2 | the drawn track audit before (`c97a823`) and after (`00304ae`) track smoothing |
| `gameplay` | 2 | `measure-gameplay.cjs` on three replays (`d8d7483`) and the corpus (`0c4e116`) |
| `target`, `target-mystery` | 3 + 1 | pill targeting and hand-over over the 443 corpus (`012fa63`, `1ad64ff`), the second corpus (`1ad64ff-target-mystery`), and both (`41c07e3`, 1,030 logs) |
| `base`, `base-mystery` | 1 + 1 | base ownership hand-over on both corpora (`0bc38f7`) |
| `mine-damage` | 2 | the modelled sweep (`af89fbf`) and the direct reading (`77c6c22`) |
| `index` | 1 | the `F4` index fault (`5cca155`) |
| `shot` | 1 | fire-time direction (`137752f`) |
| `staleness` | 1 | the shell-list skew tally, 4.3M pairs (`6e8f9a9`) |
| `holes` | 1 | ring counter holes over 1,006 logs (`2f4c4f3`) |
| `recordings` | 1 | the two-recorder scan over 1,030 logs (`bc9611b`) |
| `silence` | 1 | tank silences over the corpus (`1195356`) |
| `time` | 1 | record time order over the corpus (`4bcde21`) |

---

## 14. Evidence index

Every tag used in the documents, with a one-line summary. The full
entries are in `FORMAT.notes.md`.

| tag | claim, in brief |
|---|---|
| `[E:alliance-transitive]` | an accept admits to the whole alliance; verified on a 3v3 with chained accepts |
| `[E:ammo-clamp]` | shells and mines cap at 40; drains into a full tank are logged and wasted |
| `[E:base-capture]` | hostile capture at armour ≤ 9, armour drain costs the base 5, capture zeroes stocks; shells blocked at ≥ 5 |
| `[E:base-road]` | a base square behaves as road; 2,341 shell frames "inside forest" are 86% bases |
| `[E:base-tick]` | every player's tick increments every base; the alternative makes 6,112 drains impossible |
| `[E:boat]` | boarding consumes the boat with no terrain event (38 of 38) |
| `[E:centre-square]` | a tank occupies the square containing its centre (mine-lays prove it) |
| `[E:centring]` | pixel coordinates need +8 px; LGM plants and deaths peak at +8 |
| `[E:crater-pill]` | a grounded pill spares the ground from every crater path (0 of 37 floods; emulator-confirmed) |
| `[E:crater-water]` | a crater on river or sea is a no-op (0 of 12 floods); on a boat it craters and floods |
| `[E:death-tiers]` | superboom above 60 shells + mines, crater from 1 to 60, nothing when empty |
| `[E:dump-mine]` | a pill dumped onto a mine clears it without a crater (emulator) |
| `[E:dump-terrain]` | the death dump refuses only building, shot building, boat, and occupied squares; 0 order violations |
| `[E:ext-bit]` | `b & 0xE` carries a 3-byte position; bit 1 too (bolorama) |
| `[E:forest-circle]` | dying tank clearance is a 15×15 box (Chebyshev 7), pill-masked; the `regrown` column hits 0 exactly there |
| `[E:gameinfo]` | the `GAMEINFO` layout and constants from `Brain.h`; the two longs are little-endian |
| `[E:gameplay]` | the measured numbers behind `GAMEPLAY.md` |
| `[E:history]` | set bits mark members; the naming rule is murky; `F1 8n` never emitted |
| `[E:idle-silence]` | live silences: p99 5.6 s, longest idle 19.7 s, moving tail to 28.9 s; fade at 15 s |
| `[E:leave-pills]` | the manual: a leaver's active pills remain with the alliance; bases handled the same |
| `[E:lgm-killers]` | all 86 fixture deaths have a shell arriving within 30 ticks, ending against anything |
| `[E:man-carrying]` | a man out with a pill keeps it through his tank's death |
| `[E:mapknown]` | the `F3` frontier, verified on 254/254 runs |
| `[E:massaging]` | a touching tank makes a pill fire along the tank's facing 39% of the time (chance 6.7%) |
| `[E:mine-damage]` | a mine takes 3, floored at 0, and a tank at 2 or 1 is lost |
| `[E:mine-persists]` | no `6T` ever carries a mined code; forest over mined grass keeps the mine |
| `[E:muzzle]` | the opening frame does not fell the firer's tree; 28 of 28 forest frames were fired that record |
| `[E:owner-signals]` | ownership by person: zero drain and capture violations where slot models fail hundreds |
| `[E:pill-capture]` | pickup captures; repair never does |
| `[E:pill-fire-index]` | the direction-0 carry into the index nibble, three independent confirmations |
| `[E:pill-shell-migration]` | 91% of `F4`s are followed by a matching shell in some list, the reporter within range |
| `[E:pill-target]` | the `F4` sender is the pill's target, the nearest visible hostile tank (95.5%); deflection; hand-over rules |
| `[E:quit-fields]` | the three `IP:port` fields of a quit |
| `[E:quit-pills]` | a quitter's carried pills drop around the last tank position |
| `[E:respawn-gap]` | respawn 5.0–6.8 s after death |
| `[E:seq-loss]` | the ring slot counter; a hole is a quiet slot; the gathering phase; loss, stall and latency readings |
| `[E:shell-centre]` | shells centre at +8 px: the sharp V of frames inside standing forest |
| `[E:shell-chained]` | offsets chain from the previous member |
| `[E:shell-direction]` | lists split by direction, not source (2,607 quiet reciprocal exchanges, 349 controls) |
| `[E:shell-fall-terminal]` | `FB` is the terminal point of a 2 px/tick flight (96.4% match) |
| `[E:shell-list-skew]` | all lists of one record are one instant: cross-list disagreement at 1.14× the error floor |
| `[E:shell-offset-quantisation]` | the one-sided bound and the recoverable quantiser |
| `[E:shell-passthrough]` | apparent pass-throughs are identity errors |
| `[E:shell-restate]` | every record restates every shell the sender simulates (0 of 743 reappear after a list-less record) |
| `[E:shot-fire-time]` | the `5d` nibble is stamped at fire time; 1.5% of fires precede their shell by a record |
| `[E:superboom-cargo]` | the second explosion is the cargo, 0.9 s after `F9` |
| `[E:superboom-pill]` | superboom pill damage is 4; single crater 0; plant at full |
| `[E:tankpos-5]` | the tank position subpacket is 5 bytes |
| `[E:two-recorders]` | two logs of one game agree byte for byte; the recorder is namable from the stamp offsets |

---

## 15. Sources, credits and provenance

- **Stuart Cheshire** — Bolo itself; the `GAMEINFO` layout from his
  published Brain development kit (`docs/Brain.h`); the map RLE from his
  `BoloMapFile.c`; `docs/BoloInfoPacket.c`, his sample code for the
  game-info packet interface; the sprites are ultimately derived from
  the game.
- **Carl Osterwald ("wharf rat")** — reverse engineering of the log
  encryption and packet formats (2001–2003), author of BoloViewer, the
  origin of most of the opcode table.
- **Rob Keogh ("Pins")** — working notes and a prototype Perl parser
  that preserved that knowledge; a 2003 collaborator's notes flagged
  several fields as unknown, most since resolved.
- **Two anonymous Bolo players** who recorded and supplied the corpora.
- **[Bolorama](https://github.com/astrospark/bolorama)** (Astrospark
  Technologies) — an independent reverse engineering of the live UDP
  wire protocol, used to cross-check opcode layouts.
- **[WinBolo](https://github.com/kippandrew/winbolo)** (John Morrison,
  1998–2008, GPL v2) — an independent reimplementation, not Bolo, used
  only to explain behaviour the logs already demonstrate; the viewer's
  map codec and terrain tile rules are ports of its `bolo_map.c` and
  `screencalc.c`. Where a WinBolo constant agrees with a measurement
  (`MIN_ARMOUR_CAPTURE 9`, `BASE_ARMOUR_GIVE 5`, `BASE_MIN_CAN_HIT 4`)
  the two agreeing is worth more than either; where it disagrees (mine
  damage 2 vs 3, superboom pill damage 5 vs 4) Bolo is not WinBolo.
- **Manual observation of original Bolo in an emulator**, for behaviour
  no log records directly (superboom damage, crater sparing, the mine
  floor, dump demining).
- **The project owner's** knowledge of the game, via the questionnaire.

---

## 16. Glossary

- **bradian** — 1/256 of a circle; 0 = north, clockwise. Pills fire on
  the odd ones, tanks on all 256. The 4-bit direction nibble is
  `(bradian + 8) >> 4`.
- **base** — a refuelling station; up to 16; captured by driving on.
- **birth** — the moment and point a shell left its muzzle; a shell with
  a known birth is drawn from there.
- **chain** — a sequence of shell observations the matcher believes are
  one shell.
- **corpus** — the private 443-log set (or the second 587-log set,
  "the mystery corpus"; together 1,030 logs).
- **DEPARTED** — the viewer's state for property whose owner left with
  no heir: nobody's, hostile to every viewpoint.
- **dilation** — a sender's simulation falling behind its record stamps,
  so its shells read consistently slow.
- **fixture** — a committed anonymised log: `n20021018.2` (normal ring),
  `040601.6` (fast ring).
- **gathering phase** — the start of a game, before the first base
  capture, when the map is being distributed.
- **jitter** — record-to-record wander of the stamp against the
  contents.
- **LGM** — the little green man; the tank's engineer.
- **lockstep** — all of one pill's live shells advance the same number
  of steps per sender transition.
- **orbit** — the complete list of whole-pixel positions a pill shell on
  one bradian can ever occupy, plus its terminal.
- **pill** — pillbox; up to 16; fires at the nearest visible hostile
  tank within 8.5 tiles.
- **pop** — a drawn shell appearing (pop-in) or vanishing (pop-out)
  with no story; a *backwards pop* is a pop-in behind a same-direction
  pop-out.
- **restatement** — a record re-sending an object's current position.
- **ring cycle** — one circulation of the token packet; a moving tank
  restates once per cycle.
- **roster** — the set of a pill's shells in one snapshot, as pinned to
  orbit steps.
- **snapshot** — one record's shell lists, taken as one sampling
  instant.
- **stall** — the ring held up, nothing arriving from anyone.
- **superboom** — the four-square explosion of a tank dying with more
  than 60 shells + mines aboard.
- **terminal** — an authoritative shot-ending event: fall, tank hit,
  pill or base damage, attributable explosion.
- **tick** — 1/50 s.
- **visual join** — a drawn continuation across genuine ambiguity that
  propagates no identity, birth or fate.
- **vouched / contradicted** — a pill link that agrees / disagrees with
  the advance its pill's roster elected.

---

## 17. Map of the documentation

| document | what it holds | read it for |
|---|---|---|
| `README.md` | usage, viewer builds, status, credits | getting started |
| `docs/FORMAT.md` | the log specification, playback rules, Bolo bugs, sources | the bytes |
| `docs/FORMAT.notes.md` | the evidence entry behind every `[E:tag]` | why a rule is believed |
| `docs/GAMEPLAY.md` | the rules of play, tagged by provenance | the game |
| `docs/gameplay_questionnaire.txt` | the owner's raw answers | provenance of the game rules |
| `docs/INTERPOLATION.md` | the motion engine's design | how the viewer draws |
| `docs/interpolation_tests.md` | fixture measurement history, metric definitions | judging an engine change |
| `docs/interpolation_tests_corpus.md` | corpus measurement history, headline table | the same at scale |
| `docs/ROADMAP.md` | what was planned, what was done, what is shelved | what to do next |
| `docs/pillbox_shell_algorithm.md` | the recovered shell simulation | the physics |
| `docs/tank_shell_bradians.md` | tank shells on that simulation | the physics, for tanks |
| `docs/pillbox-shell-orbits-compact.json` | every pill shell orbit, as data | tests and tools |
| `docs/Brain.h`, `docs/BoloInfoPacket.c` | Cheshire's first-party structure definitions | `GAMEINFO`, byte order |
| `docs/corpus_runs/` | raw archived tool output | the numbers at source |
| `docs/viewer.png` | a screenshot | |
| `docs/HANDBOOK.md` | this document | everything, once, in order |
