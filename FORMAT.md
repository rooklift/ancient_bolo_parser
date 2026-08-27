# The Bolo game log file format

Bolo (Stuart Cheshire, Mac, 0.90–0.99.7) gained a game-logging feature in version 0.99.5 (April 1995): "Log Events to File…" writes a record of everything that happens in a game. Cheshire never shipped a player for these files. The format was reverse engineered around 2001–2003 by Carl Osterwald ("wharf rat"), author of the commercial BoloViewer application; this document is a synthesis of that work and our own analysis. See the separate FORMAT.notes for additional information. Citations such as [E:foo] are found there.

All multi-byte values are big-endian unless noted. Coordinates are map squares 0–255, with a packed pixel byte `yx` giving the position within the square (high nibble y, low nibble x).

**Every pixel-precision coordinate names the top-left of a 16px cell**, so the object itself sits half a tile further on in both axes: `(X*16 + px + 8, Y*16 + py + 8)`. Equivalently, a pixel byte of `0x00` places the object centred on its square rather than at its corner. This is uniform across tanks, shells and LGMs; reading a coordinate uncentred puts the object half a tile up and to the left, which is a subtle enough error to survive a long time [E:centring]. Objects without a pixel byte — pillboxes, bases, terrain events — are named by square outright and need no adjustment.

Bolo time runs at exactly 50 ticks per second.

## Terrain

0: building, 1: river, 2: swamp, 3: crater, 4: road, 5: forest, 6: rubble, 7: grass, 8: shot building, 9: boat, 10: mined swamp, 11: mined crater, 12: mined road, 13: mined forest, 14: mined rubble, 15: mined grass

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

Everything after the time tag is XORed with a fixed 128-byte mask (see `src/mask.js`), restarting at the length byte of every record. Since records are at most 127 bytes, the mask never wraps.

## Record payload

| size | contents |
|------|----------|
| 1    | sequence number, 0–0x7F, incremented by each node in the ring. Consecutive records therefore step by 1 when nothing goes missing; a step of *n* accounts for *n*−1 packets that never reached the logging machine, and a step of 0 is a duplicate. A log is thus self-reporting about the network it was recorded on [E:seq-loss] |
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

**If `b & 0xE` is nonzero, a 3-byte position subpacket is present** (after the tank position, if any): `XX YY yx` — the LGM for 8/C, the replacement man's parachute for 4. This resolves the values 5, 9 and D that the 2003 notes left as unknown — they are simply 4/8/C with the tick bit set. Bit 1 (the never-shipped towed-base feature) also carries the extension, but no real log has ever been seen with that bit set, so its payload semantics are unconfirmed [E:ext-bit].

### Tank status bits `T`

| bit | meaning |
|-----|---------|
| 1   | tank in boat |
| 2   | tank hidden (in trees) |
| 4   | tank dead / dying (with bit 8: death-animation flame position) |
| 8   | record carries a 5-byte tank position subpacket |

Special whole-nibble values: `7` = tank joining or dead (no position); `F` = "attached log" pseudo-record added by BoloViewer's modified Bolo builds (`F0` + Pascal-string log file name follows).

The tank direction nibble is 0 = north, increasing clockwise by 22.5° (note: *map start squares* use 0 = east increasing counter-clockwise).

### Tank position subpacket (5 bytes)

`XX YY yx SS ZA` — map square, pixel byte, speed, and `A` = motion bits (1 accelerating, 2 decelerating, 4 turning CCW, 8 turning CW). The layout is 5 bytes, the direction living in the header's `TD` byte [E:tankpos-5].

The square a tank *occupies* for game purposes (laying a mine, dumping pills on death) is the square containing its centre, `((X*16 + px + 8) >> 4, (Y*16 + py + 8) >> 4)` — not (X, Y), which is the character's top-left square [E:centre-square].

## ID-coded subpackets

After the position subpackets, zero or more subpackets identified by their first byte follow, concatenated until the record's length is exhausted. Notation: `d` = direction nibble, `n` = object index nibble, `T` = terrain nibble.

| id | size | meaning |
|------|------|---------|
| `0d`–`3d` | 4/6/8/10 | a shell list: 1–4 shells in flight, all travelling in direction `d`, with 3 bytes `XX YY yx` for the first and 2 signed bytes of pixel offset for each additional. The offsets are **chained**: each is relative to the *previous* shell in the list, not the first [E:shell-chained]. The direction nibble applies to **every** shell in its list; shells travelling in different directions occupy different lists, while shells from different firing sources may share a list when their directions agree [E:shell-direction]. A direction may occupy several lists in one record. A record may carry **several** shell lists concatenated (up to 12 seen in the wild): the sender's own shells plus those of any pillboxes it is currently simulating. Bolo migrates a firing pillbox's simulation to the machine it is shooting at, so pill shells ride in the *target's* restatements [E:pill-shell-migration]. Every record re-states *all* shells the sender is simulating, whatever the record's shape — a record with no shell lists means the sender simulates none [E:shell-restate]. The standalone map/node records carry no such implication; none has been seen while its sender had shells in flight. A shell's `XX YY yx` needs the usual half-tile centring [E:shell-centre] |
| `4d` | 4 | unused (missile in flight) |
| `5d` | 1 | shot fired from tank. The shell's first restatement sits 6-9 px from the tank centre, still inside the firer's own square. That opening frame does not fell the tree under the firer — though a shot that goes on to cross the square can still fell it [E:muzzle] |
| `6T` | 3 | terrain change to type `T` at `XX YY`. `T` names the **base** terrain and never a mined code, so the event cannot state a mine either way. Where forest grows back over mined grass the mine survives and playback must carry it across; other transitions are left as sent [E:mine-persists] |
| `7T` | 3 | explosion at `XX YY`; `T` = new terrain, or `B` = no terrain change, `C` = LGM plants mine, `D` = four-square superboom (craters the square and its E/S/SE neighbours, sparing water, bases and pillbox squares). A superboom also deals 4 **eventless** damage to any pillbox in its four squares — no `9n` is sent [E:superboom-pill]. The pillbox's **ground**, though, is spared: a crater — single `7 3` or superboom — is dropped on any square holding a grounded pillbox, dead or alive, while the superboom's damage still lands [E:crater-pill]. A single `7 3` reaches a pill's square only when that pill is **dead** — a live one blocks the tank whose death makes the crater — and there it changes nothing: not the ground, not the pill [E:superboom-pill]. A single crater (`T` = 3) spares open water in the same way: on river or deep sea it changes nothing, because the terminal crater of a dying tank is sent whatever lies under the wreck. A **boat** square is not spared — it craters, and then floods [E:crater-water]. Crater *flooding*, by contrast, IS evented: water-adjacent craters become water via explicit terrain changes, 25–37 ticks (0.50–0.74 s) later |
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
| `F4 nd` | 2 | pillbox `n` fires, shell direction `d` (the shell itself then appears in the shell lists of the machine simulating the pill — normally its target; see `0d`–`3d`). **When `d` reads 0 the index is unreliable**: about a quarter of those name the pill one above the one that really fired, so the true firer is `n-1`. Every other direction is right ~99% of the time. Playback may use the named pill as a candidate shell origin, but must reject geometrically implausible associations and try `n-1` for direction 0; damage and capture remain authoritative in their own events [E:pill-fire-index] |
| `F5` | 3 | LGM death at `XX YY` |
| `F6` | 1 | tank boards boat (boat consumed): the tank's centre square reverts from river-with-boat to plain river with **no** accompanying `6T` event — playback must apply the change itself [E:boat] |
| `F7` | 1 | tank lays mine |
| `F8` | 2+len | node id: Pascal string `player@node`; also sent on rename. A joining player's F8 has tank status `T=7` and is followed by established ring members restating their unchanged F8 ids; together those distinguish a slot admission from an isolated rename even when the former occupant's quit was lost |
| `F9` | 2 | tank death; code 1 = explosion, 2 = crater, 3 = sunk in deep sea (an F901 may be followed by F902 mid-animation). The respawn is the next tank position without the dying bit [E:respawn-gap]. Terminal cratering at the wreck's resting place is **evented** (`7T`/`7D`) and is gated on the ammo aboard: a 4-square superboom above 60 shells + mines, a single crater from 1 to 60, and no explosion at all when the tank dies empty [E:death-tiers] |
| `FA` | 4+len | chat message: 2-byte little-endian recipient bitmask (`FFFF` = all) + Pascal string (max 120 chars; longer messages split across records) |
| `FB` | 4 | shell falls to ground at `XX YY yx`; the pixel position is the shell's terminal point [E:shell-fall-terminal] |
| `FC dn` | 2 | shell (direction `d`) hits tank `n` |
| `FD`, `FE` | 1 | unused |
| `FF 0n`–`FF 4n` | 2 | pill `n`: pickup / repair 4 / repair 8 / repair 12 / full repair. **Pickup captures the pill immediately** — not at the later plant. Repairs never change ownership, whoever performs them [E:pill-capture] |
| `FF 50` | 4 | pill planted at `XX YY` (which pill: lowest index carried). The pill comes up at **full armour**, which the log does not state — playback must apply it [E:superboom-pill] |
| `FF 51` | 4 | pill dumped at `XX YY` by killed LGM (no F5 sent in this case) |
| `FF 6n` | 2 | base `n` captured |
| `FF 7n` / `FF 8n` | 2 / 4 | unused (base towing) |
| `FF F0` | 3+3f | player quit: field-length byte, then three fields — 6-byte `IP:port` pairs, the quitter's upstream / self / downstream ring neighbours. Field length 4 (presumably bare IPv4) also occurs rarely [E:quit-fields] |
| `FF F1` | 2 | map saved |
| `FF F2` / `FF F3` | 4 | alliance request / accept: 2-byte little-endian tank bitfield of **set** bits (the opposite convention from the game-info alliance words, where **zero** bits mark allies). A request names every member of the group being joined; an accept names only the admitted player — and admits them to the acceptor's **whole alliance**, though no event links them to the other members. A viewer must therefore treat alliance links as transitive [E:alliance-transitive] |
| `FF F4` | 2 | leave alliance |
| `FF F5` / `FF F6` | 2 | player unlocked / locked |

### Subpacket order within a record

Tank position, LGM position, base drains, pill pickups, base captures, terrain changes, tank death, tank fires, pillbox fires, shell falls, tank hits, base/pill hits, terrain explosions, shell lists (oldest first), messages. Map and node subpackets normally appear alone.

### Start-of-log sequence

When logging starts, Bolo emits: an `F8` for every player in the ring, then `F0 00`, `F1 01` (game info), `F1 02/03/04` (pill/base/start lists), `F1 Cx` history, and `F3` map runs (the whole map as RLE). If logging starts while the map is still downloading from the ring, the log is defective.

## What the log does NOT contain

Playback must re-implement fragments of game logic:

- **Dropped pills on tank death** are placed by an algorithm (serpentine search outward from the death square), not by explicit events.
- **A quitting player's carried pills drop the same way** around their last tank position, with no events [E:quit-pills].
- **Every dying tank position clears nearby forest**, with no terrain events — the dying-bit positions are the only trace, and later sliding wreck/flame positions use the same clearance as the first. The rule is a **15×15 pixel box** centred on the tank. For a terrain square, let `dx` and `dy` be the horizontal and vertical distances from the tank-centre pixel to the square's nearest pixel; fell its forest when `dx <= 7 && dy <= 7`. The boundary is Chebyshev, not Euclidean: the `(7,7)` diagonal is cleared along with everything closer, while axial distance 8 is not. Two integer comparisons, no multiplication, no square root — which is also what the corpus says. A grounded pillbox masks the terrain beneath it from this eventless clearance: if the box touches a pill-occupied forest square, leave the forest alone. This exemption does not apply to explicit terrain changes in general — but craters are masked by a pillbox in their own right, so an evented `7D` superboom damages a pillbox without cratering the ground beneath it [E:crater-pill]. The evented terminal cratering (`7T`/`7D`, see `F9`) is otherwise separate from this clearance rule and unaffected [E:forest-circle].
- **A mine survives a terrain change, and the event does not say so.** When forest grows back on mined grass the log carries a plain `6 5`, leaving a viewer that applies it literally showing clean forest over a live mine. Playback must preserve the mine bit across the change [E:mine-persists].
- **A crater event on open water or a pillbox square is a no-op.** The terminal `7 3` of a dying tank is emitted whatever lies under the wreck, and Bolo's cratering primitive spares river and deep sea, so playback must drop it — otherwise a crater appears mid-river and, nothing being left to flood it back, stays there for the rest of the replay. A boat square is the exception: it does crater (destroying the boat) and then floods back to river, evented like any other flood [E:crater-water]. A square holding a grounded pillbox, dead or alive, is spared the same way, by both crater paths — a superboom over one still deals its 4 damage, but leaves the ground alone [E:crater-pill].
- **The delayed second explosion of a dying tank is its cargo** — the ammunition cooking off, ~0.9 s after the initial `F9`. The `7D` events are logged, so playback needs no rule here [E:superboom-cargo].
- **Pill-fire shell spawn position** is computed from the pill position and the direction nibble via Bolo's internal sine/cosine tables — but only if a player wants the shell visible from the instant of the `F4`: the shell appears in the simulating machine's shell lists from its next restatement anyway, so reconstruction buys at most a fraction of a second and a viewer may reasonably skip it.
- **Ring splits are invisible**: a player who disconnects without a quit record simply stops sending and remains a ghost. A later slot admission remains inferable from its `T=7` F8 and the following burst of unchanged F8 restatements, at which point the admitted slot's old alliances must be cleared.
- **A mine under a starting pillbox does not exist**: the transferred map data keeps the mined terrain code, but the game ignores the mine, so a player must clear it from squares occupied by initial pillboxes.
- **A base's square behaves as road**, whatever the map data says beneath it. The transferred map carries real terrain under every base — across the corpus 33% crater, 33% road, 19% mined crater, 10% grass and 5% forest — and the game consults none of it: shells fly over, there is no tree to fell and no mine to strike. Playback may preserve the underlying value or rewrite it as road (and eventless terrain logic may mutate it): none of those choices affects gameplay while the base occupies the square. What matters is that nothing at a base square is ever *treated* as forest, mined, or an obstacle [E:base-road].
- **Shells appear to pass through live pillboxes — probably an artifact.** Current belief is that live pills do stop shells and that appearances to the contrary were the result of mistaken identity with regard to shells. Dead pills are a separate matter and are not claimed to stop anything [E:shell-passthrough].
- Shell flight, explosions and sounds are largely presentational: each sender re-states its in-flight shells every record, so drift does not accumulate.

## Bolo bugs discovered

Almost everything that looks wrong in a log turns out to be a rule we had not worked out yet, so the bar for this section is high: the game itself has to be at fault, and playback should not reproduce the fault faithfully. Two entries qualify, and only the first is ours.

- **The pill index in an `F4` is corrupt whenever the direction reads 0.** About a quarter of those name the pill one above the one that actually fired, so the true firer is `n-1`; every other direction is right about 99% of the time. Inside direction 0 the fault is one-sided: shots angled west of due north are hit about half the time, shots due north or east of it are not. The rate is uniform across the corpus — 22–27% in every year from 2001 to 2005, and 23–25% for every player slot — so it is what Bolo 0.99.7 does, not one bad build or one machine. It survived twenty years unnoticed because nothing depends on it: which pillbox is credited with a shot changes no game state, the shell is restated in the shell lists regardless, damage arrives as `9n` and capture at pickup, both carrying their own indices. The worst it can cost a viewer is a muzzle flash on the wrong pillbox [E:pill-fire-index].
- **`F1 8n` is never emitted**, so the pill half of the history grouping has to be recovered from the pill masks that ride the `Cn` records. This one is not our find: the 2003 notes attribute it to a flaw in Bolo's `log_bootinfo` [E:history].

A third candidate does not make the list. A log started while the map is still downloading from the ring is defective, but that is a limitation of where logging can begin rather than a fault in the game, and the game plays on correctly either way.

Two things that might look like bugs are not. A dying tank's terminal crater is sent whatever lies under the wreck, including open water and pillbox squares where it can have no effect [E:crater-water], [E:crater-pill] — but every machine applies the same terrain rule to it, so the game stays consistent and only a viewer that applies the event blindly goes wrong. And a base drained into a full tank is logged although the round is wasted [E:ammo-clamp], which is behaviour, not malfunction.

## Sources

- **Carl Osterwald ("wharf rat")**, author of the commercial BoloViewer: reverse-engineering notes from around 2001–2003, the origin of most of the opcode table.
- **A 2003 collaborator's working notes and questions**, which flag several fields as unknown; where this document resolves one, it says so.
- **[bolorama](https://github.com/astrospark/bolorama)**, an independent reverse engineering of the live wire protocol, used as a cross-check.
- **Cheshire's published Brain development kit (`Brain.h`)** and map-format sample code (`BoloMapFile.c`), the only first-party structure definitions available.
- **Our own empirical analysis**: a 120,840-record log from October 2002 (the "sample log"), a second sample log, and a private corpus of 446 logs (2001–2005, 13.4 million records, all Bolo 0.99.7). Corpus figures below are from the 446-log set unless stated.
- **Manual observation of original Bolo in an emulator**, for behaviour no log records directly.
- **[WinBolo](https://github.com/kippandrew/winbolo) source** (John Morrison) — an independent GPL reimplementation, not Bolo itself: used only to explain behaviour the logs already demonstrate.
