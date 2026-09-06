# The Bolo game log file format

Bolo (Stuart Cheshire, Mac, 0.90–0.99.7) gained a game-logging feature in version 0.99.5 (April 1995): "Log Events to File…" writes a record of everything that happens in a game. Cheshire never shipped a player for these files. The format was reverse engineered around 2001–2003 by Carl Osterwald ("wharf rat"), author of the commercial BoloViewer application; this document is a synthesis of that work and our own analysis. It states each rule briefly; the evidence behind every claim tagged `[E:foo]` is in [FORMAT.notes.md](FORMAT.notes.md), one entry per tag. The rules of the game itself, as opposed to the log, are in [GAMEPLAY.md](GAMEPLAY.md).

All multi-byte values are big-endian unless noted. Coordinates are map squares 0–255, with a packed pixel byte `yx` giving the position within the square (high nibble y, low nibble x).

**Every pixel-precision coordinate names the top-left of a 16px cell**, so the object itself sits half a tile further on in both axes: `(X*16 + px + 8, Y*16 + py + 8)`. Equivalently, a pixel byte of `0x00` places the object centred on its square rather than at its corner. This is uniform across tanks, shells and LGMs; reading a coordinate uncentred puts the object half a tile up and to the left, which is a subtle enough error to survive a long time [E:centring]. Objects without a pixel byte — pillboxes, bases, terrain events — are named by square outright and need no adjustment.

Bolo time runs at exactly 50 ticks per second.

## Terrain

0: building, 1: river, 2: swamp, 3: crater, 4: road, 5: forest, 6: rubble, 7: grass, 8: shot building, 9: boat, 10: mined swamp, 11: mined crater, 12: mined road, 13: mined forest, 14: mined rubble, 15: mined grass

Shells pass over: river, swamp, crater, road, rubble, grass (and their mined equivalents).

Shells are blocked by (and do damage to): building, forest (including mined forest), shot building, boat. Also by tanks, pillboxes (if not dead), and enemy bases that have armour above a certain threshold.

Tank movement is blocked by building and shot building, and by a hostile base with armour above 9, the level at which it can be captured (see [GAMEPLAY.md](GAMEPLAY.md), [E:base-capture]).

One hit from a shot converts forest to grass. One hit from a shot converts building to shot building. Four more hits convert shot building to rubble.

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
| 4    | time tag, **little-endian**, in Bolo ticks (50/s). It is the **recording machine's** clock at the moment it wrote the record: when the ring packet carrying the record arrived, or, for the recorder's own record, when it sent it. Two logs of one game stamp the same record on two different clocks, a constant apart for every sender, and a packet held up on its way round is stamped at one machine seconds after the other [E:two-recorders]. Not zero-based: initialised from the Mac's `TickCount()` (60/s) when the game starts, so only differences are meaningful. As a 32-bit counter it wraps after ~2.7 years of machine uptime; tags are monotonic in file order, so a player should unwrap any huge backward jump |
| 1    | length byte `L` (includes itself; ≤ 127), **encrypted** |
| L−1  | payload, **encrypted** |

### Encryption

Everything after the time tag is XORed with a fixed 128-byte mask (see `src/mask.js`), restarting at the length byte of every record. Since records are at most 127 bytes, the mask never wraps.

## Record payload

| size | contents |
|------|----------|
| 1    | ring slot counter, 0–0x7F: every node steps it once per ring cycle as the packet passes, and a record carries the count at its sender's turn. A step of *n* between consecutive records means *n*−1 nodes took their turn and had nothing to log — a parked tank between restatements, a dead one, the recording machine itself as readily as anyone — and a step of 0 is a duplicate. **A hole is not a lost packet**; what the format does show of the network is the stall, a packet held up on its way round. The value is the same at every machine, so two recordings of one game agree byte for byte on every ring record, and the figure the viewer calls loss is the share of quiet slots [E:seq-loss] [E:two-recorders] |
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

A moving tank restates its position in every record it sends, once per ring cycle; a stationary one only every few seconds, the period varying by log from about 4 to 8 s, so a live, connected player is routinely silent for 6–9 s, and the whole ring can crawl for far longer. A consumer inferring a split or a departure from silence should allow 15 s of it [E:idle-silence].

The square a tank *occupies* for game purposes (laying a mine, dumping pills on death) is the square containing its centre, `((X*16 + px + 8) >> 4, (Y*16 + py + 8) >> 4)` — not (X, Y), which is the character's top-left square [E:centre-square].

## ID-coded subpackets

After the position subpackets, zero or more subpackets identified by their first byte follow, concatenated until the record's length is exhausted. Notation: `d` = direction nibble, `n` = object index nibble, `T` = terrain nibble.

| id | size | meaning |
|------|------|---------|
| `0d`–`3d` | 4/6/8/10 | a shell list: 1–4 shells in flight, all travelling in direction `d`, with 3 bytes `XX YY yx` for the first and 2 signed bytes of pixel offset for each additional. The offsets are **chained**: each is relative to the *previous* shell in the list, not the first [E:shell-chained]. Only the head's coordinate is exact: member `n` is uncertain by up to `n` pixels per axis, one-sided, since each quantised offset rounds down [E:shell-offset-quantisation]. The direction nibble applies to **every** shell in its list; lists split by direction, not by firing source, and a direction may occupy several lists in one record [E:shell-direction]. A tank shell born as its tank crossed a sector boundary is listed one sector from its true heading for its whole flight, and its `5d` nibble is the true one [E:shell-birth-sector]. A record may carry **several** shell lists concatenated (up to 12 seen in the wild): the sender's own shells plus those of any pillboxes it is currently simulating, which is every pill whose target it is [E:pill-shell-migration] [E:pill-target]. Every record re-states *all* shells the sender is simulating, whatever the record's shape — a record with no shell lists means the sender simulates none [E:shell-restate]. **Every list of one record is a single sampling instant**: one pillbox's shells advance in lockstep across all the lists of one record, and an apparent cross-list disagreement is reconstruction error until a specific case proves otherwise, though whole records are routinely stated stale *as a unit* [E:shell-list-skew]. A shell's `XX YY yx` needs the usual half-tile centring [E:shell-centre] |
| `4d` | 4 | unused (missile in flight) |
| `5d` | 1 | shot fired from tank. The direction nibble is stamped at **fire** time, not at packet-build time, so it names the created shell's true direction; the event and its shell normally ride the same record, but ~1.5% of fires race the packet build and the shell's first restatement arrives one record later [E:shot-fire-time]. The shell's first restatement sits 6-9 px from the tank centre, still inside the firer's own square, and that opening frame does not fell the tree under the firer [E:muzzle]. **When the tank's facing crosses a sector boundary in the tick or two before the shot, the shell is listed one sector off the nibble** -- under the earlier facing -- and stays so for its whole flight, while flying the nibble's sector; a consumer should take the nibble as such a shell's true direction [E:shell-birth-sector] |
| `6T` | 3 | terrain change to type `T` at `XX YY`. `T` names the **base** terrain and never a mined code, so the event cannot state a mine either way. Where forest grows back over mined grass the mine survives and playback must carry it across; other transitions are left as sent [E:mine-persists] |
| `7T` | 3 | explosion at `XX YY`; `T` = new terrain, or `B` = no terrain change, `C` = LGM plants mine, `D` = four-square superboom (craters the square and its E/S/SE neighbours, sparing water, bases and pillbox squares). A superboom also deals 4 **eventless** damage to any pillbox in its four squares — no `9n` is sent [E:superboom-pill]. Cratering, single or superboom, spares the ground under a grounded pillbox, dead or alive, and spares open water; a **boat** square is not spared — it craters, and then floods [E:crater-pill] [E:crater-water]. Crater *flooding* IS evented: water-adjacent craters become water via explicit terrain changes, 25–37 ticks (0.50–0.74 s) later |
| `8d` | 1 | unused |
| `9n` | 1 | 1 damage to pillbox `n` |
| `An` | 1 | 5 damage (one shell) to base `n` |
| `Bn`/`Cn`/`Dn` | 1 | base `n` refuels the sender's tank by 1 shell / 1 mine / 1 armour. The shell and mine drains cost the base 1 each; the armour drain costs it **5** for the tank's 1 point [E:base-capture]. A drain into a full tank (40 shells or 40 mines) is still logged, but the round is wasted [E:ammo-clamp] |
| `En` | 1 | unused (missile drained) |
| `F0` | 2 | rejoin / map-header request |
| `F1 01` | 90 | game info: the 56-byte `GAMEINFO` struct (36-byte Pascal map name; 8-byte game id = host IPv4 + Mac-epoch start time; 1-byte game type (1 open, 2 tournament, 3 strict); 1-byte hidden mines flag (`0x80` hidden OK, `0xc0` all visible); 1-byte allow-AI; 1-byte assist-AI; 4-byte little-endian start delay; 4-byte little-endian time limit; both in ticks) plus 16 little-endian words of per-player alliance bitmaps (0 bit = allied) [E:gameinfo] |
| `F1 02` | 3+5n | pillbox list: `x y owner armour speed` each (map-file layout). An armour of `0xFF` marks a pill that is inside a tank when logging starts: the owner nibble is the carrying player, and playback holds the pill carried at full armour |
| `F1 03` | 3+6n | base list: `x y owner armour shells mines` each |
| `F1 04` | 3+3n | start list: `x y direction` each |
| `F1 8n`/`F1 Cn` | 42 | pill/base "history" **group**: a 2-byte little-endian pills bitmask, a 2-byte little-endian bases bitmask (**set** bits = members), then a 36-byte history value shared by every marked object — a zero-padded Pascal `player@node` string, or the empty/default value `00 01` + zeros. One record is emitted per distinct value in the start-of-log burst; together they partition all 16 pills and 16 bases exactly, and `n` is the lowest marked base. The string names a player tied to the group, but the exact rule remains murky. `F1 8n` itself is never emitted, but the pill masks ride the `Cn` records [E:history] |
| `F2` | 3 | map terrain request (2-byte `mapknown`, see `F3`) |
| `F3` | 3+run | map terrain data: 2-byte `mapknown`, then one RLE run in `.bmap` format (run length byte includes the 4-byte run header). `mapknown` is a map position `YY XX` — the transfer frontier: the previous run's row and end-column (`00 00` before the first run), everything before it in reading order being already known [E:mapknown] |
| `F4 nd` | 2 | pillbox `n` fires, shell direction `d`; the shell itself then appears in the shell lists of the machine simulating the pill — its target, the nearest hostile tank in range that is not hidden in forest [E:pill-target]. `d` points at the target, led by a sector (rarely two) when the target is moving, since pills shoot with deflection; and a tank touching the pill can make it fire along the tank's own facing instead [E:massaging]. **When `d` reads 0 and `n` is odd, the index may be one too high**: a packing carry lands in the index nibble, so the byte reports `true_n | 1` (see Bolo bugs below). An even `n` is always right; an odd `n` at direction 0 names the pill above the real firer about half the time, and the true firer is then `n-1`. Playback may use the named pill as a candidate shell origin, but must reject geometrically implausible associations and, for an odd index at direction 0, try `n-1`; damage and capture remain authoritative in their own events [E:pill-fire-index] |
| `F5` | 3 | LGM death at `XX YY`. The man is always the sender's own: the event carries no index, and the same record restates his position just ahead of it, centred on the named square [E:lgm-killers] |
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
| `FF 51` | 4 | pill dumped at `XX YY` by killed LGM (no F5 sent in this case). The pill comes to ground **dead** (armour 0), which the log does not state |
| `FF 6n` | 2 | base `n` captured by the sender. A neutral base is captured at any armour; a hostile one only at armour **≤ 9**. Taking a base from an owner **zeroes its armour, shells and mines**, which the log does not state — without that rule every recapture looks impossible [E:base-capture] |
| `FF 7n` / `FF 8n` | 2 / 4 | unused (base towing) |
| `FF F0` | 3+3f | player quit: field-length byte, then three fields — 6-byte `IP:port` pairs, the quitter's upstream / self / downstream ring neighbours. Field length 4 (presumably bare IPv4) also occurs rarely [E:quit-fields] |
| `FF F1` | 2 | map saved |
| `FF F2` / `FF F3` | 4 | alliance request / accept: 2-byte little-endian tank bitfield of **set** bits (the opposite convention from the game-info alliance words, where **zero** bits mark allies). A request names every member of the group being joined; an accept names only the admitted player — and admits them to the acceptor's **whole alliance**, though no event links them to the other members. A viewer must therefore treat alliance links as transitive [E:alliance-transitive] |
| `FF F4` | 2 | leave alliance. The leaver's planted pills pass to the remaining allies, with no ownership events; carried ones stay his. The manual is silent on bases; ownership works the same for both, so they pass over with the pills [E:leave-pills] |
| `FF F5` / `FF F6` | 2 | player unlocked / locked |

### Subpacket order within a record

Tank position, LGM position, base drains, pill pickups, base captures, terrain changes, tank death, tank fires, pillbox fires, shell falls, tank hits, base/pill hits, terrain explosions, shell lists (oldest first), messages. Map and node subpackets normally appear alone.

### Start-of-log sequence

When logging starts, Bolo emits: an `F8` for every player in the ring, then `F0 00`, `F1 01` (game info), `F1 02/03/04` (pill/base/start lists), `F1 Cx` history, and `F3` map runs (the whole map as RLE). If logging starts while the map is still downloading from the ring, the log is defective.

## What the log does NOT contain

Playback must re-implement fragments of game logic:

- **Dropped pills on tank death** are placed by an algorithm (serpentine search outward from the death square), not by explicit events. Carried pills are placed lowest index first, each taking the next acceptable square of a single never-backtracking search. The search accepts almost any square — river, deep sea and every mined variant included — refusing only a square already holding a pill or base and three terrains: building, shot building and boat [E:dump-terrain]. One exception: if the sender's man is out of the tank carrying a pill (status `C`) when it dies, the lowest-index carried pill is in his hands rather than in the tank, so it is not dumped; he goes on to plant it, and that plant arrives as an ordinary `FF 50` [E:man-carrying].
- **A quitting player's carried pills drop the same way** around their last tank position, with no events [E:quit-pills].
- **Dumped pills are dead.** Whether dropped by a dying tank, a quitting player or a killed man (`FF 51`), a pill comes to ground at armour 0 and must be repaired before it fires again; a planted pill (`FF 50`) comes up at full armour. The log states neither, and neither is obvious from the bytes.
- **A pill dumped onto a mined square clears the mine**, with no terrain event. The mine detonates without cratering: the terrain under it is unchanged, only the mine bit goes [E:dump-mine].
- **A player who quits leaves his planted pills, and his bases, with his alliance**, which may by then be a single player, and not with whoever later takes his slot. The log has no event for it. Playback can keep single-owner pills and still honour this by handing a quitter's grounded pills to the lowest-index remaining ally **who has a tank**, as for `FF F4`. When no ally holds a tank (a netsplit takes a whole team at once; a lone ally may be dead) the pills belong to nobody — not to an enemy either — go back to the owner if his name rejoins, and never to a stranger who takes his slot. Bolo offered both **Join** and **Rejoin**, and only Rejoin restored a returning player's things; the log carries no trace of which was pressed, so playback assumes Rejoin and relies on a general correction: a pill never fires at its own side, so any pill that fires at a player playback holds friendly to it is proven wrong and becomes nobody's until next picked up or planted. A fire within a second of an alliance event is exempt, since the pill may have been simulated before an accept reached its machine, as is an odd index at direction 0 [E:pill-target].
- **Leaving an alliance (`FF F4`) hands over the leaver's planted pills** to the remaining allies, with no ownership events; playback gives them to the lowest-index remaining mutual ally. Carried pills stay with the leaver. The manual is silent on bases; ownership works the same for both [E:pill-target], so playback hands them over with the pills [E:leave-pills].
- **Ownership and alliances belong to the person, not the slot** [E:owner-signals]. Netsplits shuffle players across slots, sometimes with no quit event at all, and afterwards each side's bases go on refuelling the old persons from their new slots. Base drains and captures police this from both directions (only a friendly base refuels a tank; only a neutral or hostile one can be captured); pills rest on the fire signal; pickups discriminate nothing, since a pill must be dead to be taken; and repairs are no signal at all, since repairing never captures a pill and is not restricted to one's own side. Playback keeps slot-indexed owners and honours the person by four identity rules: a join under the SAME name is a reconnect keeping the slot's alliance links; a join under a NEW name implicitly quits the displaced name, handing its grounded things over exactly like an announced quit; a quit-flagged slot still sending records past a straggler second (a netsplit ghost) recovers its departed things at once; and an actual rename that collides with a live name consolidates that name's property onto its lowest live slot, while periodic same-name restatements move nothing.
- **A captured base loses its stocks.** When a base changes hands from an owner (not from neutral) its armour, shells and mines go to 0 and only the stock ticks refill them. The log carries the capture and nothing else, and a viewer that keeps the old stocks shows a base that its own capture rule says could never have been taken [E:base-capture].
- **Pills inside a tank when logging starts** are flagged only by an armour byte of `0xFF` in the `F1 02` list, with the owner nibble naming the carrier (see the table).
- **Every dying tank position clears nearby forest**, with no terrain events — the dying-bit positions are the only trace, and later sliding wreck/flame positions use the same clearance as the first. The rule is a **15×15 pixel box** centred on the tank: fell a square's forest when the horizontal and vertical distances from the tank-centre pixel to the square's nearest pixel are both at most 7 (Chebyshev, not Euclidean). A grounded pillbox masks the forest beneath it from this eventless clearance. The evented terminal cratering (`7T`/`7D`, see `F9`) is separate and unaffected [E:forest-circle] [E:crater-pill].
- **A mine survives a terrain change, and the event does not say so.** When forest grows back on mined grass the log carries a plain `6 5`, leaving a viewer that applies it literally showing clean forest over a live mine. Playback must preserve the mine bit across the change [E:mine-persists].
- **A crater event on open water or a pillbox square is a no-op.** The terminal `7 3` of a dying tank is emitted whatever lies under the wreck, and Bolo's cratering primitive spares river, deep sea and any square holding a grounded pillbox, dead or alive, so playback must drop it. A boat square is the exception: it does crater (destroying the boat) and then floods back to river, evented like any other flood [E:crater-water] [E:crater-pill].
- **The delayed second explosion of a dying tank is its cargo** — the ammunition cooking off, ~0.9 s after the initial `F9`. The `7D` events are logged, so playback needs no rule here [E:superboom-cargo].
- **Pill-fire shell motion uses 128 fine directions** — the odd bradians, eight per sector of the 16 reported by the `F4` direction nibble — so the nibble alone cannot determine the spawn point or trajectory. The full integer simulation was recovered bit-exactly (`docs/pillbox_shell_algorithm.md`), and `viewer/pillbox_shell_orbits.js` regenerates every orbit; once a later restatement identifies the fine orbit, playback can reconstruct the shell back to its muzzle, or reject a continuation the orbit rules out. Synthetic spawning still buys at most a fraction of a second — the shell appears in the simulating machine's shell lists from its next restatement anyway — so a viewer may reasonably skip it.
- **Ring splits are invisible**: a player who disconnects without a quit record simply stops sending and remains a ghost. A later slot admission remains inferable from its `T=7` F8 and the following burst of unchanged F8 restatements, at which point the admitted slot's old alliances must be cleared.
- **A mine under a starting pillbox does not exist**: the transferred map data keeps the mined terrain code, but the game ignores the mine, so a player must clear it from squares occupied by initial pillboxes.
- **A base's square behaves as road**, whatever the map data says beneath it: the transferred map carries real terrain under every base and the game consults none of it. Playback may preserve the underlying value or rewrite it as road; what matters is that nothing at a base square is ever *treated* as forest, mined, or an obstacle [E:base-road].
- **Shells appear to pass through live pillboxes — an artifact.** Live pills do stop shells and dead pills do not (owner's knowledge, GAMEPLAY.md); the appearances to the contrary were mistaken identity with regard to shells [E:shell-passthrough].
- Shell flight, explosions and sounds are largely presentational: each sender re-states its in-flight shells every record, so drift does not accumulate.

## Bolo bugs discovered

Almost everything that looks wrong in a log turns out to be a rule we had not worked out yet, so the bar for this section is high: the game itself has to be at fault; playback corrects the fault where it can and reproduces it where it changed the game. Four entries qualify, and the last is not ours.

- **The pill index in an `F4` is corrupt for shots just west of due north.** Bolo packs the byte as `(n << 4) | BRAD_TO_PACK(bradian)` with `BRAD_TO_PACK(x) = (x + 8) >> 4`, which yields 16 rather than 0 for bradians 248–255, and the carry lands in the index nibble: the log reports `n | 1` at direction 0. So an even index is never wrong, an odd index at direction 0 is the pill above the real firer about half the time (the true firer is `n-1`), about a quarter of all direction-0 fires are affected, and every other direction is right about 99% of the time. The rate is uniform across years and player slots, so it is what Bolo 0.99.7 does, not one bad build or one machine. Nothing depends on the field, so the worst it can cost a viewer is a muzzle flash on the wrong pillbox [E:pill-fire-index].
- **A quitter's planted pills and bases apparently go to nobody when his only ally is dead.** A departing player's property passes to an ally, but seemingly only to one who holds a tank at that moment: over 1,030 logs, pills handed to a live ally never fired at him outside one exception, while a dead ally whose tank later came within range of the handed pills was shot in three of the four quits the corpus offers, and the fourth was not given longer than a hostile pill has been seen to wait. An ally merely out of touch for a few seconds still inherits, and with the lowest ally dead but another live the property does seem to go to the live one. Unlike the index fault, it changed the game, so playback reproduces it; a disconnect presumably behaves the same, since the log records both as a quit. Four quits is a small sample, hence the hedge [E:pill-target].
- **A shell fired as its tank crosses a sector boundary is listed under the wrong direction for life.** The shell list's direction nibble is a coarse facing the tank held a tick or two before the shot, while the `5d` nibble and the shell's velocity are from the shot itself; when the facing crossed a sector boundary in that interval, the shell flies the nibble's sector but is listed a sector off, and never re-listed. It is about 4% of the fires whose shell is seen at the muzzle, in both turn directions alike, across 378 of the 443 logs; the `FC` hit packet carries the true sector, so a reader trusting the list label loses every tank hit such a shell scores. Osterwald saw the disagreement and suspected a bug; the flight test settles which side is right. Playback takes the nibble as the shell's sector and keeps the list label only for matching restatements [E:shell-birth-sector].
- **`F1 8n` is never emitted**, so the pill half of the history grouping has to be recovered from the pill masks that ride the `Cn` records. This one is not our find: the 2003 notes attribute it to a flaw in Bolo's `log_bootinfo` [E:history].

The rules of play the log leaves unstated — tank armour, speeds, turn rates, hiding, pillbox anger, base capture and refuelling, the man, regrowth, the parachute — are in [GAMEPLAY.md](GAMEPLAY.md), measured on the fixture logs by `tools/measure-gameplay.cjs` [E:gameplay].

## Sources

- **Carl Osterwald ("wharf rat")**, author of the commercial BoloViewer: reverse-engineering notes from around 2001–2003, the origin of most of the opcode table.
- **A 2003 collaborator's working notes and questions**, which flag several fields as unknown; where this document resolves one, it says so.
- **[bolorama](https://github.com/astrospark/bolorama)**, an independent reverse engineering of the live wire protocol, used as a cross-check.
- **Cheshire's published Brain development kit (`Brain.h`)** and map-format sample code (`BoloMapFile.c`), the only first-party structure definitions available.
- **Our own empirical analysis**: a 120,840-record log from October 2002 (the "sample log"), a second sample log, and a private corpus of 446 logs (2001–2005, 13.4 million records, all Bolo 0.99.7), three of which are corrupt in some way and excluded from corpus-wide measurement, leaving 443. Corpus figures in FORMAT.notes are from the 443-log set unless an entry says 446, in which case it was run over the full set. A second private corpus of 587 logs supplied, among other things, ten games each logged on two machines at once — the only chance the format offers to see the same packets twice [E:two-recorders].
- **Manual observation of original Bolo in an emulator**, for behaviour no log records directly.
- **[WinBolo](https://github.com/kippandrew/winbolo) source** (John Morrison) — an independent GPL reimplementation, not Bolo itself: used only to explain behaviour the logs already demonstrate.
