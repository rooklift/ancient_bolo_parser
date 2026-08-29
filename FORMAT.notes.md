## Evidence

Each entry backs the tagged claim in the FORMAT document.

**[E:base-road]** — from gameplay knowledge, and corroborated by shells. A shell cannot be inside a standing tree, so any shell restated inside a tile the model calls forest marks a square the model has wrong. Taking only frames at least 2 px inside their tile — deep enough that boundary rounding cannot explain them — gives 2,341 across the corpus, and they divide up completely:

| what is on that tile | frames | |
|---|---|---|
| a base | 2009 | 85.8% |
| the tile is felled within 1.5 s (an ordinary hit) | 207 | 8.8% |
| a grounded pillbox | 97 | 4.1% |
| a muzzle frame, fired that same record | 28 | 1.2% |

Bases account for six sevenths of it. The last 1.2% is not noise but the muzzle case of [E:muzzle], so every frame in the table is accounted for and nothing is left over.

The original engine does **not** rewrite base squares: it keeps the map's real terrain, which the base sprite hides anyway. A player need not preserve that implementation detail, because base occupancy overrides the value for every gameplay purpose. Rewriting or mutating it changes nothing in the clearance sweep except ~45 fewer squares counted as "cleared", which were never gameplay forest to begin with — so the figures in [E:forest-circle] hold either way.

The 97 pillbox frames are **not** the same phenomenon. A pillbox does not alter the ground it stands on, and it can be captured and carried away, at which point that ground matters again — so unlike a base's, the terrain under a pill has to be kept *and* consulted. Those frames are explained by the pillbox itself: the shell is being absorbed as `9n` damage, or is one of the pass-throughs in [E:shell-passthrough]. Neither says anything about the ground beneath.

**[E:base-tick]** — under the every-player-increments-every-base model, none of a sample log's 16,801 base-drain events comes from an empty base (stocks touch zero exactly 13 times). Under the owner's-bases-only alternative, 6,112 drains would be impossible.

**[E:ext-bit]** — every record of both sample logs parses exactly to its length under this rule and fails without it. That bit 1 also carries the extension comes from bolorama's wire parser, which skips it for `senderFlags & 0xE0`.

**[E:tankpos-5]** — an early version of Osterwald's notes described a 6-byte layout with a leading `cD` byte; a 2003 erratum, confirmed by us, establishes 5 bytes.

**[E:centre-square]** — every terrain event following an `F7` mine-lay lands on the centre square, never the character square.

**[E:shell-chained]** — chained and first-relative decoding are equivalent for 2-shell lists. Verified on 3-shell lists where a new shot becomes the list head: first-relative decoding conjures a phantom shell and loses a real one, chained decoding reconstructs every position to the pixel.

**[E:shell-offset-quantisation]** — replay `052504.1 cliffa.red vs ds.√`, records 1210–1255, isolates 63 direction-13 shell observations on the left half of the map, all fired by pillbox 4 at (123,123). All 18 list heads match an exact direction-13 point in the independently recovered pillbox orbit table. Of the 45 members reconstructed through signed chained offsets, only 7 match exactly; every other member lies within one pixel per preceding link, per axis, of an exact orbit point. The final pair makes the consequence concrete: the head is exact bradian 209 step 30 at relative `(-117,-51)`, while adding the second member's encoded `(5,6)` offset gives `(-112,-45)`, one pixel from its exact bradian 207 step-28 position `(-111,-44)`. Their exact terminals are respectively `(-124,-54)` and `(-126,-49)`. Thus the offsets were quantised independently from finer internal coordinates; adding them to an already quantised head accumulates bounded positional uncertainty. Because the signed arithmetic shift rounds every link down, the bound is one-sided on each axis: for member index `i`, `reconstructed <= exact <= reconstructed + i`. Exact-physics matching must test this interval, not demand equality or use a symmetric uncertainty box.

The quantiser itself is recoverable once an orbit supplies the internal 1/16-pixel coordinates: each byte is `(next_internal - previous_internal) >> 4`, with a signed arithmetic shift. It reproduces 18,873 of 18,875 adjacent uniquely resolved pill-shell pairs in `n20021018.2` and 1,720 of 1,721 in `052504.1`, including roughly 18,000 negative components; the three contradictions are consistent with the provisional shell identity/source being wrong. For the final pair above, the internal coordinates are `(-1857,-801)` and `(-1771,-690)`, whose difference `(86,111) >> 4` is exactly the logged `(5,6)`. This makes the raw offset chain useful evidence rather than mere error: candidate orbit states for adjacent members can be retained only when their exact internal coordinates reproduce the byte pair.

**[E:shell-direction]** — quiet reciprocal exchanges isolate the direction semantics without tracking shell identity between restatements. Across the 446-log corpus, 2,607 records follow a sender restatement containing no shells with exactly one tank fire, one approximately reciprocal pill fire, and exactly two new shells. Every one encodes them as two 1-shell lists; none uses one 2-shell list. Of these, 2,587 also pass a strict source-and-ray geometry check, again with no mixed list. As a control, 349 geometrically clean quiet records have two different pillboxes fire in the same direction: all 349 combine the two shells into one 2-shell list, proving that the split is by direction rather than firing source.

The sample log supplies the within-one-emitter case. From 21:24.24, pillbox 8 changes its aim from direction 5 to direction 4 while its older shells are still airborne. The directions coexist in separate lists through 21:25.22; at 21:24.98, a restatement with no new fire has direction-5 shells travelling southeast from the pill and direction-4 shells travelling east. The newer direction-4 lists remain after the last direction-5 shell expires. Thus the header direction describes every shell in its list.

**[E:muzzle]** — of the 28 frames in [E:base-road] that sit inside forest with no base or pillbox on the tile, **all 28** were fired in that very record: the sender's last `5d` is 0.00 s old in every case. 23 of the 28 have the firing tank in the same tile as the shell, 14 of those with the tank's hidden-in-trees bit set, and in 26 the shell is 6-9 px from the tank centre — the muzzle offset, a shell that has barely cleared the barrel.

So these are not shells crossing forest: the opening frame simply does not fell the tree under the firer, whether because the shell is not collision-tested on its first tick or because it is exempt while inside the firer's square. The log cannot separate those.

It does **not** follow that a tank can never fell its own tile. Of 14,666 shots fired by a tank standing on forest, 17.0% see that tile felled within 1.5 s, and the rate rises with the room the shell has to cross the square: at a runway of 15-16 px — the tank hard against one edge, firing straight across — it reaches 29% and 39%, and at maximum inwardness 41%. The flat ~17% elsewhere is uncontrolled, since a tank sitting in cover is usually being shot at and incoming fire fells the same tile; separating the two would need a control this measurement does not have. Read it as: the opening frame is exempt, the rest of the flight is not.

This matters only to code that models shell-terrain interaction, since the felling itself is evented — but such a model will otherwise clear the firer's own tile every time anyone shoots from cover.

**[E:pill-shell-migration]** — 91% of `F4` fires are followed by a direction-matching shell near the pill in some player's list, and the reporting player's tank sits within the pill's 8-square range (median 6.7).

**[E:shell-restate]** — zero of 743 in-flight shells reappear after a list-less record from their sender, whether that record carries a tank position, only events, or a dead tank's `T=7`.

**[E:centring]** — the rule is established separately for each kind of object that carries a pixel byte, by three independent methods: tanks in [E:centre-square], shells in [E:shell-centre], and LGMs here.

An LGM's square shows up in events it causes — `FF 50` pill plant, `FF 51` pill dump, `F5` LGM death — which name a square outright. Testing its last reported position against those, over the corpus:

| offset | plants on the named square | LGM deaths |
|---|---|---|
| +0 px | 28.2% | 27.3% |
| +4 px | 75.2% | 68.4% |
| **+8 px** | **88.4%** | **81.3%** |
| +12 px | 73.9% | 68.0% |

(28,264 plants and 6,444 deaths). Neither peak reaches 100% because the LGM keeps walking between its last position restatement and the event. Parachutes ride the same subpacket as LGMs, so presumably share the convention, but no square-addressed event is caused by one, so it is untested. `FB` uses the shell convention established separately in [E:shell-fall-terminal].

**[E:shell-fall-terminal]** — an `FB` shell continues at 2 px/tick along the fine heading learned from its earlier restatements; its `XX YY yx` position is the resulting terminal point, not a position expected to equal the last restatement. This matches 8,191 of 8,495 events (96.4%). The matched paths remain straight independently of the matching cost: lateral residual against the learned ray is median 0.56 px and p90 2.0 px. This supersedes the earlier negative result from comparing `FB` directly with the shell's last reported position. For any matched shell terminal, playback dates its transient impact effect to the computed arrival time; the event's authoritative terrain, object, or tank state change remains at its logged record time.

**[E:shell-centre]** — fitted against the terrain the corpus says a shell cannot be inside. Reading 9,838,080 shell restatements at a range of pixel offsets and counting how many land inside a standing tree gives a sharp V with its floor at exactly +8:

| offset | inside standing forest | |
|---|---|---|
| +6 px | 20740 | 0.21% |
| +7 px | 13586 | 0.14% |
| **+8 px** | **7055** | **0.07%** |
| +9 px | 12233 | 0.12% |
| +10 px | 18045 | 0.18% |
| +16 px | 76887 | 0.78% |

Uncentred (+0) it is 83,626, twelve times the minimum. The 0.07% residual is consistent with ordinary frames captured just before impact — a shell's last restatement can fall inside the tile it is about to strike. The viewer already had this right (`world_x` in `viewer/renderer.js` adds half a tile, verified there against 3,000 muzzle samples); it was the analysis tools that read the raw coordinate.

**[E:superboom-pill]** — the superboom's damage to a pillbox is eventless, so the figure has to be recovered rather than read. **It is 4**, confirmed directly in an emulator: superboom a pill at full armour and it takes eleven further shells to kill, each shell being 1 damage.

The corpus agrees, and did so before the emulator was tried. Pill armour is reconstructible from events (`F1 02` for the starting value, -1 per `9n`, +4/+8/+12 or full per `FF 1n`-`4n`), and the log then contradicts itself if the damage figure is wrong, in two opposite directions: a **pickup** of a pill we still credit with armour means the figure is too small, and a pill **firing** while we think it dead means it is too large. Sweeping the value over 3,038 constraint events in intervals containing a superboom and no single crater:

| damage | impossible pickups | impossible fires | total |
|---|---|---|---|
| 0–3 | 55 | 15 | 70 |
| **4** | **0** | **31** | **31** |
| 5 | 0 | 176 | 176 |
| 6 | 0 | 318 | 318 |

The pickup side collapses to zero at exactly 4 — a hard lower bound — and the firing side then rises 5.7x between 4 and 5 and climbs from there. At 4 the residual is 1.0%, level with the reconstruction's 0.7% noise floor; at 5 it is eight times that. This is worth stating because the older evidence here — one pill superboomed at armour 8 and picked up after only four `9n`s — established only that the blast did *at least* 4, and WinBolo's `TK_DAMAGE` is 5, so the two plausible values had never been separated. They are separated now, and Bolo is not WinBolo.

Two neighbouring quantities fall out of the same sweep. A **single crater** `7 3` on a pill's square does **no** damage: across 2,039 constraint events no pickup anywhere in the corpus requires it to have done anything, and the firing side is minimised at zero — matching WinBolo, whose small explosion never touches pills. Note what that population can be, though. A `7 3` on a pill square is a dying tank's terminal crater, and a tank cannot die on a live pillbox because a live one blocks it; only a dead pill lies flat enough to drive over, which is how one is collected in the first place. So every case in the corpus is a pill already at armour 0, and what is shown is that the crater leaves a dead pill undisturbed. Whether a single crater would damage a **live** pill is not decidable from logs, because the situation cannot arise in one. And a **planted pill comes up at full armour**: swept as a nuisance parameter over the 1,198,455 constraint events in blast-free intervals, contradictions fall monotonically from 494,111 at armour 0 to 8,437 at 15. That last figure is the noise floor of the whole method, and about two thirds of it is cross-sender ordering — a pill's last shot logged by its simulator a fraction after the killing hit was logged by the shooter — rather than any error in the arithmetic. `node tools/measure-pill-damage.cjs`.

**[E:mine-persists]** — observed in playback and confirmed twice over by the game itself: a square where forest had grown back over mined grass exploded later, though the viewer had been showing clean forest since the `6 5` arrived, and players could be seen steering around the square while nothing was drawn there to avoid. Both tells say the mine was still present and that every client knew it.

The corpus explains why the event cannot say so. Across 13.4 million records the codes a `6T` actually carries are grass (102,302), forest (61,268), building (14,852), road (13,299), boat (7,720), river (1,479) and shot building (1). **No mined code is ever sent.** One record appears to break that and does not survive inspection: an empty `FA` message followed by three stray bytes parsing as `6 F` at 230,209, a deep-sea square at the far edge of the map with the fighting twenty tiles away, and in the wrong subpacket order besides, since messages come last. The lengths happen to add up, so the parser raises nothing, but it is not an event. So `T` is the base terrain by convention rather than by accident, and the mine is simply left implicit. Forest growing over a mine is the case that catches a viewer out, 48 times in the corpus, and it is the only one this project applies: `viewer/game.js` rewrites mined grass + `6 5` to mined forest and leaves every other terrain change as sent. Generalising further would be guesswork in the wrong direction, because some changes onto a mined square plausibly clear the mine rather than preserve it — a mine detonating leaves a crater, and WinBolo's LGM road build on a mined square signals a mine explosion as it lays the road. Nothing in the corpus separates those cases, so they are left alone.

This is not a Bolo bug and does not belong in that section: the clients agreed with each other about what the square held, and the game played on correctly. It is a piece of state the log declines to restate, like the boat consumed in [E:boat].

**[E:crater-water]** — in the sample log every crater-making event was classified by the terrain under it and checked for a following flood. Craters the game really made beside water flooded 5 of 5, always as an explicit `6 1` 25–37 ticks later; the 4 that landed on a **boat** square flooded 4 of 4 the same way. The 12 single `7 3`s that landed on river or deep sea flooded 0 of 12 — and all 12 are terminal death craters, arriving 0.74–1.50 s after the dying player's own `F9`, never in any other context. Three of those squares later receive a `6T` **boat** event, which requires river underneath: had the crater applied, a man there would have built a road instead. All 9 floods in the log are accounted for by the two flooding rows, so nothing floods silently. WinBolo agrees and supplies the mechanism: its small tank explosion craters only `if (currentPos != RIVER && currentPos != DEEP_SEA)` and then queues a flood check (`tankexp.c`), its big explosion excludes `BOAT` as well (matching `7D`'s water sparing), and `floodCheckFill` fills on any orthogonal `RIVER`/`BOAT`/`DEEP_SEA` after `FLOOD_FILL_WAIT`, chaining into neighbouring craters (`floodfill.c`).

**[E:crater-pill]** — **confirmed directly in an emulator**: a dead pillbox protects the ground beneath it from a superboom. The corpus reached the same answer first, and covers the cases the emulator test does not, so the measurement is kept below.

It uses the same flood read-out as [E:crater-water], applied to pillbox squares. Across the corpus 2,456 crater events land on a square holding a grounded pill; 43 of those squares have an orthogonal water neighbour, so whether the ground changed can be read back from whether it floods. Against the same event on bare ground:

| square | kind | n | flooded within 3 s |
|---|---|---|---|
| no pill, plain | `7 3` | 303 | 300 (99%) |
| no pill, mined | `7 3` | 304 | 299 (98%) |
| no pill, plain | `7D` | 94 | 92 (98%) |
| **dead pill, plain** | `7 3` | 24 | **0** |
| **dead pill, plain** | `7D` | 5 | **0** |
| **live pill, plain** | `7D` | 1 | **0** |
| dead pill, mined | `7 3` | 13 | 5 (38%) |

Median flood delay is 0.56–0.58 s throughout, the [E:crater-water] figure. The dead-pill rows are what the emulator run confirms. The live-pill row is a single observation — but nothing points the other way. That case did not flood either, WinBolo's `pillsExistPos` returns true for any grounded pill whatever its armour, and the sparing happens in the cratering step, which asks only whether a pill occupies the square; armour enters one step later, in the damage. A live pill is expected to behave exactly as a dead one here, and one emulator shot would put it beyond doubt.

One `7D` in the corpus (md5 `42977edf2c2630e2cabb1ca43a1b214d`, at 25:23.66, origin 127,135) demonstrates every part of the rule at once, which is worth having in one place:

| square | terrain | occupant |
|---|---|---|
| 127,135 | grass → grass | live pill, armour 9 → 5 |
| 128,135 | grass → grass | dead pill, armour 0 |
| 127,136 | river → river | — |
| 128,136 | grass → **river** | — |

The bare square craters and floods; the water square is untouched; both pill squares keep their grass while the live pill takes its 4 eventless damage in the same event — the damage of [E:superboom-pill] and the cratering coming apart in a single boom. The dead pill's square is orthogonally adjacent to the one that just flooded, so had it cratered the flood would have chained into it; it stayed grass. This is also the only live-pill observation in the corpus, which is why that row is n=1. Waiting for the pill to be picked up rescues none of the null cases: in a separate pass each square was followed to the end of its log (the tool checks only the 3 s window), and the only late floods — 198 s, 556 s, 2,556 s — arrive 0.5–0.7 s after a *fresh* crater on that square once the pill had gone, the ordinary rule rather than a deferred one. This is what corrects the older claim that a `7D` craters beneath a pillbox; the eventless damage of [E:superboom-pill] is untouched, since both readings damage the pill and only the ground distinguishes them.

The **mined** row is unresolved and deliberately left so. All thirteen rest on pill positions our own serpentine death-dump model placed rather than on events (41 of the 43 do), and near-water dumps are exactly where that model would diverge. Two of the five floods carry proof the pill was not there at all: a man later builds a **boat** on the square while the model still shows a pill on it, which Bolo forbids. Corpus-wide only 3 of 97,139 build events land on a believed-pill square — 0 of 28,855 evented placements against 3 of 5,710 modelled ones — and **two of those three** land on squares in this 43-square set, where chance would put 0.02 of them. The alternative reading, that a mine detonating under a pill craters regardless, cannot be separated from it: both reach the log as a bare `7 3`. Playback therefore spares the pill square in every case, which is wrong only if that second reading is the true one. `node tools/measure-crater-pill.cjs`.

**[E:ammo-clamp]** — reconstructing tank ammo across 12,583 lives that begin at an observed respawn (see [E:death-tiers]), every out-of-range excursion is an overflow past Brain.h's cap of 40 and not one is a negative. Charging drains into a full tank drops the violation rate from 5.7% to 1.2%; the residual is slightly-too-many shots seen, the method's noise floor. `node tools/measure-death-ammo.cjs`.

**[E:gameinfo]** — the struct layout and the constants are from `Brain.h`: `enum { GameType_open=1, GameType_tournament, GameType_strict_tment };` and `#define GAMEINFO_HIDDENMINES 0x80` / `#define GAMEINFO_ALLMINES_VISIBLE 0xC0`, with the field declared `BYTE hidden_mines;` and commented as holding one of those two values. The corpus shows only those two values across all 446 logs (`0xc0` in 435, `0x80` in 11, all of the latter in 2001–2002). 442 of 446 logs are strict. Brain.h declares the two `long` fields on a big-endian Mac, but the log stores them little-endian: only 3 corpus logs have a nonzero time limit, and they read as 230–239 minutes little-endian against 0.7–2.5 *years* big-endian. The start delay is zero in all 446 logs, so its endianness is inferred from its neighbour rather than measured.

**[E:history]** — that **set** bits mark members is contra the 2003 notes' guess of zero bits. On the naming rule: in one log the string matched the current owner of exactly those bases, in others a player who had left long before (base "memory" outliving ownership); Bolo's own `make_history()` is equally murky. `F1 8n` is never emitted because `log_bootinfo` is flawed, per the 2003 notes.

**[E:mapknown]** — verified exactly on 254/254 runs across four logs.

**[E:boat]** — all 38 sample boardings sit on terrain 9, none has a terrain event.

**[E:seq-loss]** — a step above 1 is really loss, but only where the ring is settled, and getting that qualifier wrong ruins the measurement.

**The gathering phase.** While a game is still gathering — the map being handed to joiners, nodes arriving — the ring turns at full speed while the logging machine records only a fraction of what goes round it. The sequence number races ahead of the log, and every slot it skips is charged as a lost packet. Gathering therefore reads as catastrophic loss without a single packet having gone astray: in one 19-minute 4-player log the first three minutes score 89%, 83% and 63% while the settled middle sits between 2% and 8%. It is short — a median 56 s, a few percent of a log — but extreme enough to dominate any average that includes it. Across the corpus, the share of a log spent gathering predicts its untrimmed loss figure at **r = 0.83**; measured over settled play only, that relationship disappears entirely (**r = −0.03**).

**Where settled play begins is best asked of the game, not the log.** The marker used is the **first base capture**: somebody drove a man into a base and took it, which cannot happen until the map has been distributed and everyone is playing. Every one of the 445 logs has one, a median 56 s in. The obvious alternative — inferring the moment from where the log's record rate reaches its plateau — reads the log rather than the game, and misfires on a minority of them, declaring the plateau reached in the very first block of a game that had not begun; those logs keep their artefact and land among the worst in the corpus. Against the capture marker the rate rule scores a worst case of 69.8% loss versus 49.5%, and a 99th percentile of 46.9% versus 28.5%. The capture marker is also the more consistent of the two, though this needs care to see: its raw split-half correlation is *lower* (0.88 against 0.95) purely because it deletes a large artefactual spread that both halves of a log shared, and correlation grows with the spread of what is correlated. On measures that do not scale that way it wins — half-to-half disagreement in loss falls (p90 of |A−B| from 3.13 to 2.76 points), band agreement rises from 74.6% to 75.5%, and among the 421 logs both rules put under 20% loss, where no artefactual tail can flatter either, the split-half correlation is higher for the capture marker (0.808 against 0.772). Rate inference is kept only as a fallback for a game in which no base was ever captured; no such log exists in this corpus.

**What the steps track, once the ramp is excluded.** Loss rises with player count, a ring gaining a hop per player and each hop another chance to drop a packet: medians 5.2% at two players, 6.6% at four, 7.4% at six. It also agrees at r = 0.69 with an entirely separate reading of the same stream — the share of elapsed time in gaps over half a second, during which nothing arrived at all. Over settled play the corpus runs from 1.3% in the cleanest games to 49.5% in the worst, median 6.3%.

**A correction.** Read end to end, these logs appear to improve year on year as dial-up gave way to broadband — medians 13.1% in 2001 falling to 9.1% in 2005. Almost all of that is the ramp: faster links transferred the map faster, so later logs waste less of themselves gathering. In settled play the medians are 6.6%, 6.2%, 5.9%, 6.2%, 5.7% — essentially flat. What improved between 2001 and 2005 was how quickly a game could be *started*, not how well it ran once it had.

Steps are only trusted across gaps under 5 s. A node rejoining after a longer silence can advance the 7-bit counter right round, and a wrapped step understates the hole rather than measuring it. The tail after the first quit is excluded on the same grounds as the ramp, though it costs far less: the ring is dissolving there, not failing.

Scoring interleaved half-minute blocks of the settled span as though they were two separate games gives r = 0.88 on loss and 0.94 on stall, so this is a property of a session rather than of whichever minute was sampled, and fair to state once for a whole game — which is what the viewer's header does, via `network_conditions` in `viewer/network.js`. All of the above reproduces with `tools/measure-network-conditions.cjs`.

**[E:respawn-gap]** — measured gaps are 5.0–6.8 s (median 6.0).

**[E:death-tiers]** — across 14,365 deaths the tiers split ~7% superboom, ~64% single crater, ~29% no explosion. That the crater-less deaths really have no crater, rather than an unlogged one, is verified via flooding: crater flooding is evented and fast, and of 206 crater-less deaths ending beside water, none flooded.

The ammo thresholds are measured rather than assumed. The logs carry no ammo-aboard field, but a strict game (`gametype` 3) respawns a tank empty, so a life beginning at an observed respawn can be integrated forwards: `+1` shell per `Bn`, `+1` mine per `Cn`, `−1` shell per `5d`, `−1` mine per `F7`, clamped at 40 each (see [E:ammo-clamp]). Over 12,583 such lives the tier mix per unit of combined ammo steps sharply, twice:

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

No superboom occurs anywhere below 60, so the superboom rule is shells + mines > 60. A tank carrying anything at all craters; only an empty tank dies silently. The flat ~8% "none" residual present at every ammo level is tier-misclassification noise (the crater event falling outside the match window) — it does not ramp with ammo, so it is not a physical effect. Superboom deaths carry a median of 40 mines, so in practice the threshold means a full mine load plus about 21 shells. `node tools/measure-death-ammo.cjs`.

**[E:pill-fire-index]** — the pill index in an `F4` is wrong often enough to matter to anyone auditing it, and only when the direction nibble reads 0. Two independent measurements agree.

The first identifies a shot without using its position to find it: take an `F4` from a sender that was simulating no shells at its previous restatement, whose next restatement carries exactly one, with nothing in between that could spawn another. That shell is the pill's by elimination. Then ask which pill it sits on:

| direction | n | on the named pill | on pill `n-1` |
|---|---|---|---|
| 1–15 | 6,136–7,451 each | 98.0–99.1% | 0.7–1.7% |
| **0** | **6,786** | **76.0%** | **23.7%** |

The 0.7–1.7% on the other rows is the method's own noise floor, so direction 0 misfires at roughly twenty times the background rate. The rate is not concentrated anywhere: across the 372 logs carrying at least five identifiable north shots the median is 20% (p25 13%, p75 36%, a spread consistent with binomial noise at 5–50 shots per log), and the aggregate holds at 22–27% for every year from 2001 to 2005 and 23–25% for every player slot.

The second needs no shells at all. A pill inside a tank cannot fire, so an `F4` naming a carried pill is impossible on its face. There are 2,156 of them in the corpus; **2,148 read direction 0**, and in **all 2,148** the pill one index lower was on the ground and available to be the real firer. The remaining 8 are scattered across other directions.

Within direction 0 the fault is confined to one side of north. Taking the shot's true angle from the shell's offset out of the firing pill — the spawn is only ~10 px, so the resolution is coarse — shots pointing **west** of due north are misattributed 47% of the time (1,573 of 3,333), shots due north 0.2% (2 of 1,286), and shots east of north 1.6% (35 of 2,151), the last being the method's own noise floor. Inspecting those 35 individually shows what they are: pairs of adjacent pillboxes where both candidates lie inside the matching threshold and the wrong one is a few pixels nearer, so the honest reading is that east of north is unaffected and the boundary sits strictly west of vertical. The firer's map position carries no signal at all: median X 127 for the misattributed against 128 for the rest.

The cause is not established. The signature — index too high by exactly one, only on direction 0, and only for shots angled west of north — is what a packing overflow would look like, since `F4` packs the byte as `(pill << 4) | d` and a `d` of 16 rather than 0 would carry into the pill nibble, making `(n << 4) | 16` identical to `((n+1) << 4) | 0`. That is inference from the shape of the error, not something we have verified in Bolo's code. It does sit well with the west-of-north split — half of one side of the boundary is what a threshold just west of vertical would produce, and it is why the overall direction-0 rate lands near a quarter rather than a half. Whatever the mechanism, the consequences are confined to which pill a viewer credits with a shot: no terrain, armour, ownership or position depends on the field, and pickups (`FF 0n`) and damage (`9n`) carry their own indices and are unaffected. `node tools/measure-pill-fire-index.cjs`.

**[E:pill-capture]** — a dead pill picked up, dumped by the captor's dying tank, and repaired in place by the captor's ally then fired on its former owner's team. That repairs never change ownership: a full repair of a dead enemy pill left it firing at the repairer's own team.

**[E:quit-fields]** — the three fields were decoded against known player addresses; game ports observed at 50000 and elsewhere. Field length 4 occurs in 5 of 955 quits in the corpus.

**[E:alliance-transitive]** — verified on a 3v3 whose only accepts were A↔B and B↔C on each side.

**[E:quit-pills]** — in two mid-game quits-while-carrying, the pills were later picked up within a tile of the quitter's last tank centre; in one case both at once, lying together.

**[E:forest-circle]** — manual observation of original Bolo in an emulator shows a wreck moving in a cardinal direction can remove trees in two adjacent rows, which a centre-only trail cannot reproduce.

Sweeping the clearance size and shape over the corpus brackets it from both sides. Too small a rule leaves phantom trees, showing up as pillboxes planted on modelled forest — impossible, so a single one convicts the rule; too large a rule fells trees that provably still stood, showing up as delayed repeat-clear events and as live tanks reporting the hidden-in-trees bit. Over 15,406 dying sequences:

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

Radius 8 is the smallest *circle* that eliminates pill plants, but the box of half-width 7 dominates it: every square the circle clears has `dx, dy <= 7`, so the box is a strict superset, and it clears 499 more squares at no cost whatever — the same 0 delayed contradictions, the same 2 hidden-tank hits, the same 0 plants. Box 8 settles the size, over-clearing catastrophically at 725 delayed contradictions and 112 hidden hits. So the boundary is Chebyshev at 7, and the corners the circle was cutting off were real. The residual 64 repeat-clears are all within one second, where redundant reports and event ordering are common.

The `regrown` column settles it, and it is the sharpest evidence here because it uses nothing but the game's own events. Forest grows back with an explicit terrain change, and a tree cannot grow where one already stands — so a growth event on a tile a rule still believes is forest proves that tile was really grass. Such a tile has by construction never been cleared by an event and never fallen inside that rule's clearance, so nothing innocent is left.

The column falls monotonically with coverage and reaches exactly zero at box 7, staying there for everything wider. So box 7 is the **smallest** rule that leaves no impossible regrowth, while box 8 is the first to over-clear badly: the two detectors close on the same answer from opposite sides. The circle's 116 residual anomalies all sit in the corners the box adds, against 61,152 ordinary growth events elsewhere — and that Bolo never restates growth on an already-forested tile is what makes the count meaningful.

The pill exception rests on unusually specific evidence: all nine later LGM farming events on cleared forest occur exactly on pill dump squares, as do all five delayed repeat-clear explosions and five of the seven hidden-tank conflicts. Applying it is what takes the delayed contradictions from 14 to zero and the hidden-tank conflicts from 7 to 2, at a cost of 37 clearances. The exemption is not arbitrary: a pillbox shields the ground it stands on without replacing it, which is also why the terrain beneath one must be preserved rather than overwritten (see [E:base-road], where a base differs precisely in that respect). Reproduce with `node tools/measure-tree-clearance.cjs`.

Earlier rounds carried a further under-clearing column, counting shells seen inside modelled forest on the reasoning that forest stops shells. It has been withdrawn: it read a shell's position without centring it (see [E:shell-centre]), and the "phantom tree" population it appeared to find was an off-by-half-a-tile. Nothing above depended on it.

**[E:superboom-cargo]** — 1,010 of 1,136 four-square superbooms occur mid-death-sequence, ~0.9 s after the initial `F9`. For what determines whether one happens at all, see [E:death-tiers].

**[E:shell-passthrough]** — the original observation: the sample logs show streams of shells on a line through a pill's centre where some hit (the shooter itself sends the `9n`) while others are restated well beyond the pill and fly on — dozens of ray-consistent cases per log, through hostile and neutral pills at full armour. 29 cases across two logs rest purely on absolute list-head coordinates.

That last point defends against *offset decoding*, which is a different problem from **shell identity**, and identity is where this breaks down. A re-examination found the apparent pass-throughs concentrated exactly where identity is unrecoverable. In `2001\april\040201 redsluggo vs dsmega` at 8:15, one player's list carries a direction-8 stream in which `(2081,2235)` and `(2083,2275)` appear singly in consecutive restatements — and then **together** at 8:15.98, proving they are two shells and not one that moved 40 px. The same position `(2081,2235)` also recurs 0.54 s apart, which no moving shell can do: successive shells from a fixed emitter pass through the same points at the same phase, so a stream cannot be tracked by position at all.

Two pillboxes firing on one line at different cadences is the ordinary case for this, and it is also the case that generates most apparent pass-throughs. A corner-graze filter alone removes 80% of naive hits, and of what survives, 839 of 1,126 are pills at armour 0. The live-pill residue has not been shown to survive proper identity tracking, and the working assumption is that it does not.
