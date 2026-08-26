# The Bolo game log file format

Bolo (Stuart Cheshire, Mac, 0.90–0.99.7) gained a game-logging feature in
version 0.99.5 (April 1995): "Log Events to File…" writes a record of
everything that happens in a game. Cheshire never shipped a player for these
files. The format was reverse engineered around 2001–2003 by Carl Osterwald
("wharf rat"), author of the commercial BoloViewer application; this document
is a synthesis of that work and our own analysis. See
[Sources](#sources) and [Evidence](#evidence) at the end for where each
claim comes from.

All multi-byte values are big-endian unless noted. Coordinates are map
squares 0–255, with a packed pixel byte `yx` giving the position within the
square (high nibble y, low nibble x).

**Every pixel-precision coordinate names the top-left of a 16px cell**, so
the object itself sits half a tile further on in both axes:
`(X*16 + px + 8, Y*16 + py + 8)`. Equivalently, a pixel byte of `0x00`
places the object centred on its square rather than at its corner. This is
uniform across tanks, shells and LGMs; reading a coordinate uncentred puts
the object half a tile up and to the left, which is a subtle enough error
to survive a long time [E:centring]. Objects without a pixel byte —
pillboxes, bases, terrain events — are named by square outright and need
no adjustment.

Bolo time runs at exactly 50 ticks per second.

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
| 4    | time tag, **little-endian**, in Bolo ticks (50/s). Not zero-based: initialised from the Mac's `TickCount()` (60/s) when the game starts, so only differences are meaningful. As a 32-bit counter it wraps after ~2.7 years of machine uptime; tags are monotonic in file order, so a player should unwrap any huge backward jump |
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
| 1     | 1000 ticks elapsed: increment base stocks. **Every** player's tick increments **every** base's shells, mines and armour by 1 (capped at 90), so regeneration scales with player count [E:base-tick] |
| 2     | unused (towed bases) |
| 4     | LGM (man) dead — position subpacket is the replacement man's **parachute** |
| 8     | LGM out of tank |
| C     | LGM out of tank, carrying a pillbox |

**If `b & 0xE` is nonzero, a 3-byte position subpacket is present** (after
the tank position, if any): `XX YY yx` — the LGM for 8/C, the replacement
man's parachute for 4. This resolves the values 5, 9 and D that the 2003
notes left as unknown — they are simply 4/8/C with the tick bit set. Bit 1
(the never-shipped towed-base feature) also carries the extension, but no
real log has ever been seen with that bit set, so its payload semantics are
unconfirmed [E:ext-bit].

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
(1 accelerating, 2 decelerating, 4 turning CCW, 8 turning CW). The layout is
5 bytes, the direction living in the header's `TD` byte [E:tankpos-5].

The square a tank *occupies* for game purposes (laying a mine, dumping
pills on death) is the square containing its centre,
`((X*16 + px + 8) >> 4, (Y*16 + py + 8) >> 4)` — not (X, Y), which is the
character's top-left square [E:centre-square].

## ID-coded subpackets

After the position subpackets, zero or more subpackets identified by their
first byte follow, concatenated until the record's length is exhausted.
Notation: `d` = direction nibble, `n` = object index nibble, `T` = terrain
nibble.

| id | size | meaning |
|------|------|---------|
| `0d`–`3d` | 4/6/8/10 | a shell list: 1–4 shells in flight, 3 bytes `XX YY yx` for the first, 2 signed bytes of pixel offset for each additional — **chained**: each offset is relative to the *previous* shell in the list, not the first [E:shell-chained]. The direction nibble `d` belongs to the first shell only; shells of any direction may ride one list. A record may carry **several** shell lists concatenated (up to 12 seen in the wild): the sender's own shells plus those of any pillboxes it is currently simulating. Bolo migrates a firing pillbox's simulation to the machine it is shooting at, so pill shells ride in the *target's* restatements [E:pill-shell-migration]. Every record re-states *all* shells the sender is simulating, whatever the record's shape — a record with no shell lists means the sender simulates none [E:shell-restate]. The standalone map/node records carry no such implication; none has been seen while its sender had shells in flight. A shell's `XX YY yx` needs the usual half-tile centring [E:shell-centre] |
| `4d` | 4 | unused (missile in flight) |
| `5d` | 1 | shot fired from tank. The shell's first restatement sits 6-9 px from the tank centre, still inside the firer's own square, and does **not** interact with the terrain there: a tank shooting from inside forest never fells its own tree [E:muzzle] |
| `6T` | 3 | terrain change to type `T` at `XX YY` |
| `7T` | 3 | explosion at `XX YY`; `T` = new terrain, or `B` = no terrain change, `C` = LGM plants mine, `D` = four-square superboom (craters the square and its E/S/SE neighbours, sparing water and bases). A superboom also deals 4 **eventless** damage to any pillbox in its four squares — no `9n` is sent [E:superboom-pill]. Crater *flooding*, by contrast, IS evented: water-adjacent craters become water via explicit terrain changes, typically within a second |
| `8d` | 1 | unused |
| `9n` | 1 | 1 damage to pillbox `n` |
| `An` | 1 | 5 damage (one shell) to base `n` |
| `Bn`/`Cn`/`Dn` | 1 | base `n` drained of 1 shell / mine / armour. A drain into a full tank (40 shells or 40 mines) is still logged, but the round is wasted [E:ammo-clamp] |
| `En` | 1 | unused (missile drained) |
| `F0` | 2 | rejoin / map-header request |
| `F1 01` | 90 | game info: the 56-byte `GAMEINFO` struct (36-byte Pascal map name; 8-byte game id = host IPv4 + Mac-epoch start time; 1-byte game type (1 open, 2 tournament, 3 strict); 1-byte hidden mines flag (`0x80` hidden OK, `0xc0` all visible); 1-byte allow-AI; 1-byte assist-AI; 4-byte little-endian start delay; 4-byte little-endian time limit; both in ticks) plus 16 little-endian words of per-player alliance bitmaps (0 bit = allied) [E:gameinfo] |
| `F1 02` | 3+5n | pillbox list: `x y owner armour speed` each (map-file layout) |
| `F1 03` | 3+6n | base list: `x y owner armour shells mines` each |
| `F1 04` | 3+3n | start list: `x y direction` each |
| `F1 8n`/`F1 Cn` | 42 | pill/base "history" **group**: a 2-byte little-endian pills bitmask, a 2-byte little-endian bases bitmask (**set** bits = members), then a 36-byte history value shared by every marked object — a zero-padded Pascal `player@node` string, or the empty/default value `00 01` + zeros. One record is emitted per distinct value in the start-of-log burst; together they partition all 16 pills and 16 bases exactly, and `n` is the lowest marked base. The string names a player tied to the group, but the exact rule remains murky. `F1 8n` itself is never emitted, but the pill masks ride the `Cn` records [E:history] |
| `F2` | 3 | map terrain request (2-byte `mapknown`, see `F3`) |
| `F3` | 3+run | map terrain data: 2-byte `mapknown`, then one RLE run in `.bmap` format (run length byte includes the 4-byte run header). `mapknown` is a map position `YY XX` — the transfer frontier: the previous run's row and end-column (`00 00` before the first run), everything before it in reading order being already known [E:mapknown] |
| `F4 nd` | 2 | pillbox `n` fires, shell direction `d` (the shell itself then appears in the shell lists of the machine simulating the pill — normally its target; see `0d`–`3d`) |
| `F5` | 3 | LGM death at `XX YY` |
| `F6` | 1 | tank boards boat (boat consumed): the tank's centre square reverts from river-with-boat to plain river with **no** accompanying `6T` event — playback must apply the change itself [E:boat] |
| `F7` | 1 | tank lays mine |
| `F8` | 2+len | node id: Pascal string `player@node`; also sent on rename |
| `F9` | 2 | tank death; code 1 = explosion, 2 = crater, 3 = sunk in deep sea (an F901 may be followed by F902 mid-animation). The respawn is the next tank position without the dying bit [E:respawn-gap]. Terminal cratering at the wreck's resting place is **evented** (`7T`/`7D`) and is gated on the ammo aboard: a 4-square superboom above 60 shells + mines, a single crater from 1 to 60, and no explosion at all when the tank dies empty [E:death-tiers] |
| `FA` | 4+len | chat message: 2-byte little-endian recipient bitmask (`FFFF` = all) + Pascal string (max 120 chars; longer messages split across records) |
| `FB` | 4 | shell falls to ground at `XX YY yx` |
| `FC dn` | 2 | shell (direction `d`) hits tank `n` |
| `FD`, `FE` | 1 | unused |
| `FF 0n`–`FF 4n` | 2 | pill `n`: pickup / repair 4 / repair 8 / repair 12 / full repair. **Pickup captures the pill immediately** — not at the later plant. Repairs never change ownership, whoever performs them [E:pill-capture] |
| `FF 50` | 4 | pill planted at `XX YY` (which pill: lowest index carried) |
| `FF 51` | 4 | pill dumped at `XX YY` by killed LGM (no F5 sent in this case) |
| `FF 6n` | 2 | base `n` captured |
| `FF 7n` / `FF 8n` | 2 / 4 | unused (base towing) |
| `FF F0` | 3+3f | player quit: field-length byte, then three fields — 6-byte `IP:port` pairs, the quitter's upstream / self / downstream ring neighbours. Field length 4 (presumably bare IPv4) also occurs rarely [E:quit-fields] |
| `FF F1` | 2 | map saved |
| `FF F2` / `FF F3` | 4 | alliance request / accept: 2-byte little-endian tank bitfield of **set** bits (the opposite convention from the game-info alliance words, where **zero** bits mark allies). A request names every member of the group being joined; an accept names only the admitted player — and admits them to the acceptor's **whole alliance**, though no event links them to the other members. A viewer must therefore treat alliance links as transitive [E:alliance-transitive] |
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
- **A quitting player's carried pills drop the same way** around their
  last tank position, with no events [E:quit-pills].
- **Every dying tank position clears nearby forest**, with no terrain
  events — the dying-bit positions are the only trace, and later sliding
  wreck/flame positions use the same clearance as the first. The rule is a
  **15×15 pixel box** centred on the tank. For a terrain square, let `dx`
  and `dy` be the horizontal and vertical distances from the tank-centre
  pixel to the square's nearest pixel; fell its forest when
  `dx <= 7 && dy <= 7`. The boundary is Chebyshev, not Euclidean: the
  `(7,7)` diagonal is cleared along with everything closer, while axial
  distance 8 is not. Two integer comparisons, no multiplication, no square
  root — which is also what the corpus says. A grounded pillbox masks
  the terrain beneath it from this eventless clearance: if the box
  touches a pill-occupied forest square, leave the forest alone. This
  exemption does not apply to explicit terrain changes or explosions; in
  particular, an evented `7D` superboom still craters beneath and damages a
  pillbox. The evented terminal cratering (`7T`/`7D`, see `F9`) is separate
  and unaffected [E:forest-circle].
- **The delayed second explosion of a dying tank is its cargo** — the
  ammunition cooking off, ~0.9 s after the initial `F9`. The `7D` events
  are logged, so playback needs no rule here [E:superboom-cargo].
- **Pill-fire shell spawn position** is computed from the pill position and
  the direction nibble via Bolo's internal sine/cosine tables — but only if
  a player wants the shell visible from the instant of the `F4`: the shell
  appears in the simulating machine's shell lists from its next
  restatement anyway, so reconstruction buys at most a fraction of a
  second and a viewer may reasonably skip it.
- **Ring splits are invisible**: a player who disconnects without a quit
  record simply stops sending and remains a ghost.
- **A mine under a starting pillbox does not exist**: the transferred map
  data keeps the mined terrain code, but the game ignores the mine, so a
  player must clear it from squares occupied by initial pillboxes.
- **A base's square behaves as road**, whatever the map data says beneath
  it. The transferred map carries real terrain under every base — across
  the corpus 33% crater, 33% road, 19% mined crater, 10% grass and 5%
  forest — and the game consults none of it: shells fly over, there is no
  tree to fell and no mine to strike. There is no need to *rewrite* the
  terrain, and a player is better off keeping what the map holds, since
  the base sprite covers it and the real ground stays recoverable. What
  matters is not to consult it: nothing at a base square should be
  treated as forest, mined, or an obstacle [E:base-road].
- **Shells really can pass through live pillboxes.** A viewer drawing
  restated shell positions faithfully will show these pass-throughs because
  they are real. The deciding factor is not step parity or lateral offset
  (both measured as even splits), so the mechanism is unknown
  [E:shell-passthrough].
- Shell flight, explosions and sounds are largely presentational: each
  sender re-states its in-flight shells every record, so drift does not
  accumulate.

## Sources

- **Carl Osterwald ("wharf rat")**, author of the commercial BoloViewer:
  reverse-engineering notes from around 2001–2003, the origin of most of
  the opcode table.
- **A 2003 collaborator's working notes and questions**, which flag several
  fields as unknown; where this document resolves one, it says so.
- **[bolorama](https://github.com/astrospark/bolorama)**, an independent
  reverse engineering of the live wire protocol, used as a cross-check.
- **Cheshire's published Brain development kit (`Brain.h`)** and map-format
  sample code (`BoloMapFile.c`), the only first-party structure
  definitions available.
- **Our own empirical analysis**: a 120,840-record log from October 2002
  (the "sample log"), a second sample log, and a private corpus of 446 logs
  (2001–2005, 13.4 million records, all Bolo 0.99.7). Corpus figures below
  are from the 446-log set unless stated.
- **Manual observation of original Bolo in an emulator**, for behaviour no
  log records directly.

## Evidence

Each entry backs the tagged claim in the body above.

**[E:base-road]** — from gameplay knowledge, and corroborated by shells.
A shell cannot be inside a standing tree, so any shell restated inside a
tile the model calls forest marks a square the model has wrong. Taking
only frames at least 2 px inside their tile — deep enough that boundary
rounding cannot explain them — gives 2,341 across the corpus, and they
divide up completely:

| what is on that tile | frames | |
|---|---|---|
| a base | 2009 | 85.8% |
| the tile is felled within 1.5 s (an ordinary hit) | 207 | 8.8% |
| a grounded pillbox | 97 | 4.1% |
| a muzzle frame, fired that same record | 28 | 1.2% |

Bases account for six sevenths of it. The last 1.2% is not noise but the
muzzle case of [E:muzzle], so every frame in the table is accounted for
and nothing is left over.

The engine deliberately does **not** rewrite base squares: it keeps the
map's real terrain, which the base sprite hides anyway. Rewriting them
changes nothing in the clearance sweep except ~45 fewer squares counted as
"cleared", which were never forest to begin with — so the figures in
[E:forest-circle] hold either way.

The 97 pillbox frames are **not** the same phenomenon. A pillbox does not
alter the ground it stands on, and it can be captured and carried away, at
which point that ground matters again — so unlike a base's, the terrain
under a pill has to be kept *and* consulted. Those frames are explained by
the pillbox itself: the shell is being absorbed as `9n` damage, or is one
of the pass-throughs in [E:shell-passthrough]. Neither says anything about
the ground beneath.

**[E:base-tick]** — under the every-player-increments-every-base model,
none of a sample log's 16,801 base-drain events comes from an empty base
(stocks touch zero exactly 13 times). Under the owner's-bases-only
alternative, 6,112 drains would be impossible.

**[E:ext-bit]** — every record of both sample logs parses exactly to its
length under this rule and fails without it. That bit 1 also carries the
extension comes from bolorama's wire parser, which skips it for
`senderFlags & 0xE0`.

**[E:tankpos-5]** — an early version of Osterwald's notes described a
6-byte layout with a leading `cD` byte; a 2003 erratum, confirmed by us,
establishes 5 bytes.

**[E:centre-square]** — every terrain event following an `F7` mine-lay
lands on the centre square, never the character square.

**[E:shell-chained]** — chained and first-relative decoding are equivalent
for 2-shell lists. Verified on 3-shell lists where a new shot becomes the
list head: first-relative decoding conjures a phantom shell and loses a
real one, chained decoding reconstructs every position to the pixel.

**[E:muzzle]** — of the 28 frames in [E:base-road] that sit inside forest
with no base or pillbox on the tile, **all 28** were fired in that very
record: the sender's last `5d` is 0.00 s old in every case. 23 of the 28
have the firing tank in the same tile as the shell, 14 of those with the
tank's hidden-in-trees bit set, and in 26 the shell is 6-9 px from the
tank centre — the muzzle offset, a shell that has barely cleared the
barrel.

So these are not shells crossing forest. A tank firing from inside a tree
does not fell it, whether because the shell is not collision-tested on its
first tick or because it is exempt while still within the firer's square;
the log cannot separate those. This matters only to code that models
shell-terrain interaction, since the felling itself is evented — but such
a model will otherwise clear the firer's own tile every time anyone shoots
from cover.

**[E:pill-shell-migration]** — 91% of `F4` fires are followed by a
direction-matching shell near the pill in some player's list, and the
reporting player's tank sits within the pill's 8-square range (median 6.7).

**[E:shell-restate]** — zero of 743 in-flight shells reappear after a
list-less record from their sender, whether that record carries a tank
position, only events, or a dead tank's `T=7`.

**[E:centring]** — the rule is established separately for each kind of
object that carries a pixel byte, by three independent methods: tanks in
[E:centre-square], shells in [E:shell-centre], and LGMs here.

An LGM's square shows up in events it causes — `FF 50` pill plant,
`FF 51` pill dump, `F5` LGM death — which name a square outright. Testing
its last reported position against those, over the corpus:

| offset | plants on the named square | LGM deaths |
|---|---|---|
| +0 px | 28.2% | 27.3% |
| +4 px | 75.2% | 68.4% |
| **+8 px** | **88.4%** | **81.3%** |
| +12 px | 73.9% | 68.0% |

(28,264 plants and 6,444 deaths). Neither peak reaches 100% because the
LGM keeps walking between its last position restatement and the event.
Parachutes ride the same subpacket as LGMs, so presumably share the
convention, but no square-addressed event is caused by one, so it is
untested. `FB` (shell falls) carries a pixel byte too and is **not**
settled: matching it against the sender's in-flight shells fails because
the shell travels on after its last restatement, and matching it against
a co-occurring explosion fails because the two are not causally paired
(best fit 2.7%).

**[E:shell-centre]** — fitted against the terrain the corpus says a shell
cannot be inside. Reading 9,838,080 shell restatements at a range of
pixel offsets and counting how many land inside a standing tree gives a
sharp V with its floor at exactly +8:

| offset | inside standing forest | |
|---|---|---|
| +6 px | 20740 | 0.21% |
| +7 px | 13586 | 0.14% |
| **+8 px** | **7055** | **0.07%** |
| +9 px | 12233 | 0.12% |
| +10 px | 18045 | 0.18% |
| +16 px | 76887 | 0.78% |

Uncentred (+0) it is 83,626, twelve times the minimum. The 0.07% residual
is consistent with ordinary frames captured just before impact — a shell's
last restatement can fall inside the tile it is about to strike. The
viewer already had this right (`world_x` in `viewer/renderer.js` adds half
a tile, verified there against 3,000 muzzle samples); it was the analysis
tools that read the raw coordinate.

**[E:superboom-pill]** — a pill superboomed at armour 8 was picked up,
which requires armour 0, after only four `9n`s; the blast's unlogged
damage closes the gap.

**[E:ammo-clamp]** — reconstructing tank ammo across 12,583 lives that
begin at an observed respawn (see [E:death-tiers]), every out-of-range
excursion is an overflow past Brain.h's cap of 40 and not one is a
negative. Charging drains into a full tank drops the violation rate from
5.7% to 1.2%; the residual is slightly-too-many shots seen, the method's
noise floor. `node tools/measure-death-ammo.cjs`.

**[E:gameinfo]** — the struct layout and the constants are from `Brain.h`:
`enum { GameType_open=1, GameType_tournament, GameType_strict_tment };`
and `#define GAMEINFO_HIDDENMINES 0x80` /
`#define GAMEINFO_ALLMINES_VISIBLE 0xC0`, with the field declared
`BYTE hidden_mines;` and commented as holding one of those two values.
The corpus shows only those two values across all 446 logs (`0xc0` in 435,
`0x80` in 11, all of the latter in 2001–2002). 442 of 446 logs are strict.
Brain.h declares the two `long` fields on a big-endian Mac, but the log
stores them little-endian: only 3 corpus logs have a nonzero time limit,
and they read as 230–239 minutes little-endian against 0.7–2.5 *years*
big-endian. The start delay is zero in all 446 logs, so its endianness is
inferred from its neighbour rather than measured.

**[E:history]** — that **set** bits mark members is contra the 2003 notes'
guess of zero bits. On the naming rule: in one log the string matched the
current owner of exactly those bases, in others a player who had left long
before (base "memory" outliving ownership); Bolo's own `make_history()` is
equally murky. `F1 8n` is never emitted because `log_bootinfo` is flawed,
per the 2003 notes.

**[E:mapknown]** — verified exactly on 254/254 runs across four logs.

**[E:boat]** — all 38 sample boardings sit on terrain 9, none has a
terrain event.

**[E:respawn-gap]** — measured gaps are 5.0–6.8 s (median 6.0).

**[E:death-tiers]** — across 14,365 deaths the tiers split ~7% superboom,
~64% single crater, ~29% no explosion. That the crater-less deaths really
have no crater, rather than an unlogged one, is verified via flooding:
crater flooding is evented and fast, and of 206 crater-less deaths ending
beside water, none flooded.

The ammo thresholds are measured rather than assumed. The logs carry no
ammo-aboard field, but a strict game (`gametype` 3) respawns a tank empty,
so a life beginning at an observed respawn can be integrated forwards:
`+1` shell per `Bn`, `+1` mine per `Cn`, `−1` shell per `5d`, `−1` mine
per `F7`, clamped at 40 each (see [E:ammo-clamp]). Over 12,583 such lives
the tier mix per unit of combined ammo steps sharply, twice:

| shells + mines | n | none | crater | superboom |
|---|---|---|---|---|
| 0 | 3737 | 97% | 3% | 0% |
| 1 | 166 | 17% | 83% | 0% |
| 2 | 162 | 10% | 90% | 0% |
| … | | | | |
| 59 | 77 | 13% | 87% | 0% |
| 60 | 56 | 4% | 88% | 9% |
| 61 | 76 | 9% | 13% | 78% |
| 62 | 64 | 8% | 3% | 89% |

No superboom occurs anywhere below 60, so the superboom rule is
shells + mines > 60. A tank carrying anything at all craters; only an
empty tank dies silently. The flat ~8% "none" residual present at every
ammo level is tier-misclassification noise (the crater event falling
outside the match window) — it does not ramp with ammo, so it is not a
physical effect. Superboom deaths carry a median of 40 mines, so in
practice the threshold means a full mine load plus about 21 shells.
`node tools/measure-death-ammo.cjs`.

**[E:pill-capture]** — a dead pill picked up, dumped by the captor's dying
tank, and repaired in place by the captor's ally then fired on its former
owner's team. That repairs never change ownership: a full repair of a dead
enemy pill left it firing at the repairer's own team.

**[E:quit-fields]** — the three fields were decoded against known player
addresses; game ports observed at 50000 and elsewhere. Field length 4
occurs in 5 of 955 quits in the corpus.

**[E:alliance-transitive]** — verified on a 3v3 whose only accepts were
A↔B and B↔C on each side.

**[E:quit-pills]** — in two mid-game quits-while-carrying, the pills were
later picked up within a tile of the quitter's last tank centre; in one
case both at once, lying together.

**[E:forest-circle]** — manual observation of original Bolo in an emulator
shows a wreck moving in a cardinal direction can remove trees in two
adjacent rows, which a centre-only trail cannot reproduce.

Sweeping the clearance size and shape over the corpus brackets it from
both sides. Too small a rule leaves phantom trees, showing up as pillboxes
planted on modelled forest — impossible, so a single one convicts the
rule; too large a rule fells trees that provably still stood, showing up
as delayed repeat-clear events and as live tanks reporting the
hidden-in-trees bit. Over 15,406 dying sequences:

| rule | cleared | contra >1s | contra ≤1s | hidden | plants | regrown |
|---|---|---|---|---|---|---|
| centre only | 6984 | 1 | 12 | 0 | 53 | 1774 |
| circle radius 6 | 14082 | 14 | 51 | 6 | 17 | 645 |
| circle radius 7 | 15362 | 14 | 57 | 6 | 7 | 409 |
| circle radius 8 | 16730 | 14 | 62 | 7 | 0 | 116 |
| circle radius 8, pill-masked | 16692 | 0 | 62 | 2 | 0 | 116 |
| circle radius 8 closed | 17488 | 318 | 122 | 60 | 0 | 109 |
| **box 7** | 17228 | 14 | 64 | 7 | 0 | **0** |
| **box 7, pill-masked** | **17191** | **0** | **64** | **2** | **0** | **0** |
| box 8 | 18860 | 725 | 193 | 112 | 0 | 0 |
| full footprint | 18001 | 353 | 125 | 54 | 0 | 0 |

Radius 8 is the smallest *circle* that eliminates pill plants, but the box
of half-width 7 dominates it: every square the circle clears has
`dx, dy <= 7`, so the box is a strict superset, and it clears 499 more
squares at no cost whatever — the same 0 delayed contradictions, the same
2 hidden-tank hits, the same 0 plants. Box 8 settles the size, over-clearing
catastrophically at 725 delayed contradictions and 112 hidden hits. So the
boundary is Chebyshev at 7, and the corners the circle was cutting off were
real. The residual 64 repeat-clears are all within one second, where
redundant reports and event ordering are common.

The `regrown` column settles it, and it is the sharpest evidence here
because it uses nothing but the game's own events. Forest grows back with an
explicit terrain change, and a tree cannot grow where one already stands — so
a growth event on a tile a rule still believes is forest proves that tile was
really grass. Such a tile has by construction never been cleared by an event
and never fallen inside that rule's clearance, so nothing innocent is left.

The column falls monotonically with coverage and reaches exactly zero at
box 7, staying there for everything wider. So box 7 is the **smallest** rule
that leaves no impossible regrowth, while box 8 is the first to over-clear
badly: the two detectors close on the same answer from opposite sides. The
circle's 116 residual anomalies all sit in the corners the box adds, against
61,152 ordinary growth events elsewhere — and that Bolo never restates growth
on an already-forested tile is what makes the count meaningful.

The pill exception rests on unusually specific evidence: all nine later
LGM farming events on cleared forest occur exactly on pill dump
squares, as do all five delayed repeat-clear explosions and five of the
seven hidden-tank conflicts. Applying it is what takes the delayed
contradictions from 14 to zero and the hidden-tank conflicts from 7 to 2,
at a cost of 37 clearances. The exemption is not arbitrary: a pillbox
shields the ground it stands on without replacing it, which is also why
the terrain beneath one must be preserved rather than overwritten (see
[E:base-road], where a base differs precisely in that respect).
Reproduce with `node tools/measure-tree-clearance.cjs`.

Earlier rounds carried a further under-clearing column, counting shells
seen inside modelled forest on the reasoning that forest stops shells.
It has been withdrawn: it read a shell's position without centring it
(see [E:shell-centre]), and the "phantom tree" population it appeared to
find was an off-by-half-a-tile. Nothing above depended on it.

**[E:superboom-cargo]** — 1,010 of 1,136 four-square superbooms occur
mid-death-sequence, ~0.9 s after the initial `F9`. For what determines
whether one happens at all, see [E:death-tiers].

**[E:shell-passthrough]** — the sample logs show streams of shells on a
line through a pill's centre where some shells hit (the shooter itself
sends the `9n`) while others are restated well beyond the pill and fly on
— dozens of ray-consistent cases per log, through hostile and neutral
pills at full armour. 29 cases across two logs rest purely on absolute
list-head coordinates, immune to any offset-decoding concern.
