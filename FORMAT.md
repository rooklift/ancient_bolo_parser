# The Bolo game log file format

Bolo (Stuart Cheshire, Mac, 0.90–0.99.7) gained a game-logging feature in
version 0.99.5 (April 1995): "Log Events to File…" writes a record of
everything that happens in a game. Cheshire never shipped a player for these
files. The format was reverse engineered around 2001–2003 by Carl Osterwald
("wharf rat"), author of the commercial BoloViewer application, and this
document is a synthesis of his notes, a 2003 collaborator's working notes and
correspondence, cross-checks against the independently reverse-engineered
wire protocol in [bolorama](https://github.com/astrospark/bolorama), the
structure definitions in Cheshire's published Brain development kit
(`Brain.h`) and map-format sample code (`BoloMapFile.c`), and our own
empirical analysis of a real 120,840-record log from October 2002.

All multi-byte values are big-endian unless noted. Coordinates are map
squares 0–255, with a packed pixel byte `yx` giving the position within the
square (high nibble y, low nibble x, `0x00` = centred). Bolo time runs at
exactly 50 ticks per second.

## File header (72 bytes, not encrypted)

| offset | size | contents |
|--------|------|----------|
| 0      | 4    | ASCII `"Bolo"` |
| 4      | 4    | version, e.g. `00 99 07 00` for 0.99.7 |
| 8      | 64   | logging-option flags, `01` = on. Bytes 24–27 are not exposed in the options dialog and are normally `00`; enabling them (by editing the prefs file) logs F0–F3 map subpackets when a new player joins |

## Records

After the header, the file is a flat sequence of records:

| size | contents |
|------|----------|
| 4    | time tag, **little-endian**, in Bolo ticks (50/s). Not zero-based: initialised from the Mac's `TickCount()` (60/s) when the game starts, so only differences are meaningful |
| 1    | length byte `L` (includes itself; ≤ 127), **encrypted** |
| L−1  | payload, **encrypted** |

### Encryption

Everything after the time tag is XORed with a fixed 128-byte mask (see
`src/mask.js`), restarting at the length byte of every record. Since records
are at most 127 bytes, the mask never wraps.

## Record payload

| size | contents |
|------|----------|
| 1    | sequence number, 0–0x7F, incremented by each node in the ring |
| 1    | high nibble: status bits `b`; low nibble: sending player number |
| 1    | high nibble: tank status bits `T`; low nibble: tank direction |
| …    | position subpackets, then ID-coded subpackets |

### Status bits `b`

Bit 0 is independent; bits 2–3 form a two-bit field:

| value | meaning |
|-------|---------|
| 1     | 1000 ticks elapsed: increment base stocks. **Every** player's tick increments **every** base's shells, mines and armour by 1 (capped at 90), so regeneration scales with player count. Verified: under this model none of a sample log's 16,801 base-drain events comes from an empty base (stocks touch zero exactly 13 times); under the owner's-bases-only alternative, 6,112 drains would be impossible |
| 2     | unused (towed bases) |
| 4     | LGM (man) dead — position subpacket is the replacement man's **parachute** |
| 8     | LGM out of tank |
| C     | LGM out of tank, carrying a pillbox |

**If `b & 0xE` is nonzero, a 3-byte position subpacket is present** (after
the tank position, if any): `XX YY yx` — the LGM for 8/C, the replacement
man's parachute for 4. This resolves the values 5, 9 and D that the 2003
notes left as unknown — they are simply 4/8/C with the tick bit set.
Verified empirically: every record of both sample logs parses exactly to
its length under this rule and fails without it. Bit 1 (the never-shipped
towed-base feature) also carries the extension according to bolorama's
wire parser, which skips it for `senderFlags & 0xE0`; no real log has ever
been seen with that bit set, so its payload semantics are unconfirmed.

### Tank status bits `T`

| bit | meaning |
|-----|---------|
| 1   | tank in boat |
| 2   | tank hidden (in trees) |
| 4   | tank dead / dying (with bit 8: death-animation flame position) |
| 8   | record carries a 5-byte tank position subpacket |

Special whole-nibble values: `7` = tank joining or dead (no position);
`F` = "attached log" pseudo-record added by BoloViewer's modified Bolo
builds (`F0` + Pascal-string log file name follows).

The tank direction nibble is 0 = north, increasing clockwise by 22.5°
(note: *map start squares* use 0 = east increasing counter-clockwise).

### Tank position subpacket (5 bytes)

`XX YY yx SS ZA` — map square, pixel byte, speed, and `A` = motion bits
(1 accelerating, 2 decelerating, 4 turning CCW, 8 turning CW). An early
version of the notes described a 6-byte layout with a leading `cD` byte;
a 2003 erratum (confirmed by us) establishes 5 bytes, the direction living
in the header's `TD` byte.

The square a tank *occupies* for game purposes (laying a mine, dumping
pills on death) is the square containing its centre,
`((X*16 + px + 8) >> 4, (Y*16 + py + 8) >> 4)` — not (X, Y), which is the
character's top-left square. Verified empirically: every terrain event
following an F7 mine-lay lands on the centre square, never the character
square.

## ID-coded subpackets

After the position subpackets, zero or more subpackets identified by their
first byte follow, concatenated until the record's length is exhausted.
Notation: `d` = direction nibble, `n` = object index nibble, `T` = terrain
nibble.

| id | size | meaning |
|------|------|---------|
| `0d`–`3d` | 4/6/8/10 | a shell list: 1–4 shells in flight, 3 bytes `XX YY yx` for the first, 2 signed bytes of pixel offset (relative to that list's first shell) for each additional. A record may carry **several** shell lists concatenated (up to 12 seen in the wild): the sender's own shells plus those of any pillboxes it is currently simulating. Bolo migrates a firing pillbox's simulation to the machine it is shooting at, so pill shells ride in the *target's* restatements — verified: 91% of `F4` fires are followed by a direction-matching shell near the pill in some player's list, and the reporting player's tank sits within the pill's 8-square range (median 6.7). Every record re-states *all* shells the sender is simulating |
| `4d` | 4 | unused (missile in flight) |
| `5d` | 1 | shot fired from tank |
| `6T` | 3 | terrain change to type `T` at `XX YY` |
| `7T` | 3 | explosion at `XX YY`; `T` = new terrain, or `B` = no terrain change, `C` = LGM plants mine, `D` = four-square superboom (craters the square and its E/S/SE neighbours) |
| `8d` | 1 | unused |
| `9n` | 1 | 1 damage to pillbox `n` |
| `An` | 1 | 5 damage (one shell) to base `n` |
| `Bn`/`Cn`/`Dn` | 1 | base `n` drained of 1 shell / mine / armour |
| `En` | 1 | unused (missile drained) |
| `F0` | 2 | rejoin / map-header request |
| `F1 01` | 90 | game info: the 56-byte `GAMEINFO` struct from `Brain.h` (36-byte Pascal map name; 8-byte game id = host IPv4 + Mac-epoch start time; game type; mines flag; allow/assist AI; little-endian start delay and time limit in ticks) plus 16 little-endian words of per-player alliance bitmaps (0 bit = allied) |
| `F1 02` | 3+5n | pillbox list: `x y owner armour speed` each (map-file layout) |
| `F1 03` | 3+6n | base list: `x y owner armour shells mines` each |
| `F1 04` | 3+3n | start list: `x y direction` each |
| `F1 8n`/`F1 Cn` | 42 | pill/base "history": two 2-byte bit fields + 36-byte block (purpose unknown; only `F1 C0` seen in logs) |
| `F2` | 3 | map terrain request (2-byte `mapknown`) |
| `F3` | 3+run | map terrain data: 2-byte `mapknown`, then one RLE run in `.bmap` format (run length byte includes the 4-byte run header) |
| `F4 nd` | 2 | pillbox `n` fires, shell direction `d` (the shell itself then appears in the shell lists of the machine simulating the pill — normally its target; see `0d`–`3d`) |
| `F5` | 3 | LGM death at `XX YY` |
| `F6` | 1 | tank boards boat (boat consumed) |
| `F7` | 1 | tank lays mine |
| `F8` | 2+len | node id: Pascal string `player@node`; also sent on rename |
| `F9` | 2 | tank death; code 1 = explosion, 2 = crater, 3 = sunk in deep sea (an F901 may be followed by F902 mid-animation). The respawn is the next tank position without the dying bit; measured gaps are 5.0–6.8 s (median 6.0) |
| `FA` | 4+len | chat message: 2-byte little-endian recipient bitmask (`FFFF` = all) + Pascal string (max 120 chars; longer messages split across records) |
| `FB` | 4 | shell falls to ground at `XX YY yx` |
| `FC dn` | 2 | shell (direction `d`) hits tank `n` |
| `FD`, `FE` | 1 | unused |
| `FF 0n`–`FF 4n` | 2 | pill `n`: pickup / repair 4 / repair 8 / repair 12 / full repair |
| `FF 50` | 4 | pill planted at `XX YY` (which pill: lowest index carried) |
| `FF 51` | 4 | pill dumped at `XX YY` by killed LGM (no F5 sent in this case) |
| `FF 6n` | 2 | base `n` captured |
| `FF 7n` / `FF 8n` | 2 / 4 | unused (base towing) |
| `FF F0` | 3+3f | player quit: field-length byte, then three fields — confirmed to be 6-byte `IP:port` pairs, the quitter's upstream / self / downstream ring neighbours (decoded against known player addresses; game ports observed at 50000 and elsewhere) |
| `FF F1` | 2 | map saved |
| `FF F2` / `FF F3` | 4 | alliance request / accept: 2-byte little-endian tank bitfield of **set** bits (the opposite convention from the game-info alliance words, where **zero** bits mark allies). A request names every member of the group being joined; an accept names only the admitted player — and admits them to the acceptor's **whole alliance**, though no event links them to the other members. A viewer must therefore treat alliance links as transitive (verified on a 3v3 whose only accepts were A↔B and B↔C on each side) |
| `FF F4` | 2 | leave alliance |
| `FF F5` / `FF F6` | 2 | player unlocked / locked |

### Subpacket order within a record

Tank position, LGM position, base drains, pill pickups, base captures,
terrain changes, tank death, tank fires, pillbox fires, shell falls, tank
hits, base/pill hits, terrain explosions, shell lists (oldest first),
messages. Map and node subpackets normally appear alone.

### Start-of-log sequence

When logging starts, Bolo emits: an `F8` for every player in the ring, then
`F0 00`, `F1 01` (game info), `F1 02/03/04` (pill/base/start lists),
`F1 Cx` history, and `F3` map runs (the whole map as RLE). If logging starts
while the map is still downloading from the ring, the log is defective.

## What the log does NOT contain

Playback must re-implement fragments of game logic:

- **Dropped pills on tank death** are placed by an algorithm (serpentine
  search outward from the death square), not by explicit events.
- **Pill-fire shell spawn position** is computed from the pill position and
  the direction nibble via Bolo's internal sine/cosine tables.
- **Ring splits are invisible**: a player who disconnects without a quit
  record simply stops sending and remains a ghost.
- Shell flight, explosions and sounds are largely presentational: each
  sender re-states its in-flight shells every record, so drift does not
  accumulate.
