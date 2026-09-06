# Evidence for FORMAT.md

Each entry backs a tagged claim in [FORMAT.md](FORMAT.md): the format document states the rule in a line or two and cites `[E:foo]`, and the entry here carries the measurement, the argument, the counter-examples and the tool that reproduces it. Entries are grouped by topic and are long by design; this is the audit trail, and nothing in it is needed to read the format.

Corpus figures are from the 443-log set unless an entry says 446, in which case it was run over the full set (see the Sources section of FORMAT.md); "the sample log" is the fixture `n20021018.2`, and a "second corpus" of 587 logs is named where it was used.

## Contents

**Coordinates and record layout**

- [`[E:centring]`](#ecentring-pixel-coordinates-need-the-half-tile-centring) — pixel coordinates need the half-tile centring
- [`[E:centre-square]`](#ecentre-square-a-tank-occupies-the-square-containing-its-centre) — a tank occupies the square containing its centre
- [`[E:shell-centre]`](#eshell-centre-shells-centre-at-8-px) — shells centre at +8 px
- [`[E:tankpos-5]`](#etankpos-5-the-tank-position-subpacket-is-5-bytes) — the tank position subpacket is 5 bytes
- [`[E:ext-bit]`](#eext-bit-the-lgm-parachute-position-extension) — the LGM / parachute position extension

**The ring and the network**

- [`[E:seq-loss]`](#eseq-loss-the-ring-slot-counter-holes-the-gathering-phase-and-the-three-network-readings) — the ring slot counter, holes, the gathering phase, and the three network readings
- [`[E:two-recorders]`](#etwo-recorders-two-logs-of-one-game) — two logs of one game
- [`[E:idle-silence]`](#eidle-silence-how-long-a-live-player-can-be-silent) — how long a live player can be silent
- [`[E:quit-fields]`](#equit-fields-the-three-address-fields-of-a-quit) — the three address fields of a quit

**Shells**

- [`[E:shell-chained]`](#eshell-chained-offsets-chain-from-the-previous-member) — offsets chain from the previous member
- [`[E:shell-offset-quantisation]`](#eshell-offset-quantisation-the-one-sided-quantisation-bound) — the one-sided quantisation bound
- [`[E:shell-direction]`](#eshell-direction-lists-split-by-direction-not-by-source) — lists split by direction, not by source
- [`[E:shell-restate]`](#eshell-restate-every-record-restates-every-shell-the-sender-simulates) — every record restates every shell the sender simulates
- [`[E:shell-list-skew]`](#eshell-list-skew-all-the-lists-of-one-record-are-one-sampling-instant) — all the lists of one record are one sampling instant
- [`[E:shell-fall-terminal]`](#eshell-fall-terminal-fb-is-the-shells-terminal-point) — `FB` is the shell's terminal point
- [`[E:shot-fire-time]`](#eshot-fire-time-the-5d-nibble-is-stamped-at-fire-time) — the `5d` nibble is stamped at fire time
- [`[E:muzzle]`](#emuzzle-the-opening-frame-does-not-fell-the-firers-tree) — the opening frame does not fell the firer's tree
- [`[E:shell-birth-sector]`](#eshell-birth-sector-a-shell-born-on-a-sector-boundary-is-listed-a-sector-off-for-life) — a shell born on a sector boundary is listed a sector off for life
- [`[E:shell-passthrough]`](#eshell-passthrough-apparent-pass-throughs-are-identity-errors) — apparent pass-throughs are identity errors

**Pillboxes**

- [`[E:pill-shell-migration]`](#epill-shell-migration-pill-shells-ride-in-the-simulating-machines-lists) — pill shells ride in the simulating machine's lists
- [`[E:pill-target]`](#epill-target-the-f4-sender-is-the-pills-target-hand-over-of-a-departed-players-property) — the `F4` sender is the pill's target; hand-over of a departed player's property
- [`[E:pill-fire-index]`](#epill-fire-index-the-direction-0-index-fault) — the direction-0 index fault
- [`[E:massaging]`](#emassaging-a-touching-tank-makes-a-pill-fire-along-the-tanks-facing) — a touching tank makes a pill fire along the tank's facing
- [`[E:pill-capture]`](#epill-capture-pickup-captures-repair-never-does) — pickup captures; repair never does
- [`[E:superboom-pill]`](#esuperboom-pill-superboom-pill-damage-is-4-a-single-crater-does-none-a-plant-is-at-full-armour) — superboom pill damage is 4; a single crater does none; a plant is at full armour
- [`[E:crater-pill]`](#ecrater-pill-a-grounded-pillbox-spares-the-ground-beneath-it-from-every-crater-path) — a grounded pillbox spares the ground beneath it from every crater path

**Tanks, death and dumps**

- [`[E:gameplay]`](#egameplay-the-measured-numbers-behind-gameplaymd) — the measured numbers behind GAMEPLAY.md
- [`[E:mine-damage]`](#emine-damage-a-mine-takes-3-armour-floored-and-a-tank-at-2-or-1-is-lost) — a mine takes 3 armour, floored, and a tank at 2 or 1 is lost
- [`[E:ammo-clamp]`](#eammo-clamp-shells-and-mines-cap-at-40) — shells and mines cap at 40
- [`[E:respawn-gap]`](#erespawn-gap-respawn-5068-s-after-death) — respawn 5.0–6.8 s after death
- [`[E:death-tiers]`](#edeath-tiers-the-terminal-explosion-is-gated-on-ammo-aboard) — the terminal explosion is gated on ammo aboard
- [`[E:superboom-cargo]`](#esuperboom-cargo-the-second-explosion-is-the-cargo) — the second explosion is the cargo
- [`[E:forest-circle]`](#eforest-circle-a-dying-tanks-forest-clearance-is-a-1515-box-pill-masked) — a dying tank's forest clearance is a 15×15 box, pill-masked
- [`[E:dump-terrain]`](#edump-terrain-what-a-death-dump-accepts) — what a death dump accepts
- [`[E:man-carrying]`](#eman-carrying-a-man-out-with-a-pill-keeps-it-through-his-tanks-death) — a man out with a pill keeps it through his tank's death
- [`[E:pill-pickup-logged]`](#epill-pickup-logged-every-planted-pill-was-picked-up-on-the-record) — every planted pill was picked up on the record
- [`[E:dump-mine]`](#edump-mine-a-pill-dumped-onto-a-mine-clears-it) — a pill dumped onto a mine clears it
- [`[E:quit-pills]`](#equit-pills-a-quitters-carried-pills-drop-around-his-last-position) — a quitter's carried pills drop around his last position

**Terrain**

- [`[E:mine-persists]`](#emine-persists-a-mine-survives-a-terrain-change) — a mine survives a terrain change
- [`[E:crater-water]`](#ecrater-water-a-crater-on-open-water-is-a-no-op-a-boat-craters-and-floods) — a crater on open water is a no-op; a boat craters and floods
- [`[E:boat]`](#eboat-boarding-consumes-the-boat-with-no-event) — boarding consumes the boat with no event
- [`[E:base-road]`](#ebase-road-a-bases-square-behaves-as-road) — a base's square behaves as road

**Bases, ownership and alliances**

- [`[E:base-tick]`](#ebase-tick-every-players-tick-increments-every-base) — every player's tick increments every base
- [`[E:base-capture]`](#ebase-capture-capture-at-armour-9-drain-cost-5-capture-zeroes-stocks) — capture at armour ≤ 9, drain cost 5, capture zeroes stocks
- [`[E:owner-signals]`](#eowner-signals-ownership-belongs-to-the-person-not-the-slot) — ownership belongs to the person, not the slot
- [`[E:leave-pills]`](#eleave-pills-a-leavers-planted-pills-stay-with-the-alliance) — a leaver's planted pills stay with the alliance
- [`[E:alliance-transitive]`](#ealliance-transitive-an-accept-admits-to-the-whole-alliance) — an accept admits to the whole alliance

**The man**

- [`[E:lgm-killers]`](#elgm-killers-what-kills-a-man) — what kills a man

**Game info, map transfer and the start-of-log burst**

- [`[E:gameinfo]`](#egameinfo-the-gameinfo-struct) — the `GAMEINFO` struct
- [`[E:history]`](#ehistory-the-pillbase-history-groups) — the pill/base history groups
- [`[E:mapknown]`](#emapknown-the-f3-transfer-frontier) — the `F3` transfer frontier

## Coordinates and record layout

### [E:centring] — pixel coordinates need the half-tile centring

The rule is established separately for each kind of object that carries a pixel byte, by three independent methods: tanks in [E:centre-square], shells in [E:shell-centre], and LGMs here.

An LGM's square shows up in events it causes — `FF 50` pill plant, `FF 51` pill dump, `F5` LGM death — which name a square outright. Testing its last reported position against those, over the corpus:

| offset | plants on the named square | LGM deaths |
|---|---|---|
| +0 px | 28.2% | 27.3% |
| +4 px | 75.2% | 68.4% |
| **+8 px** | **88.4%** | **81.3%** |
| +12 px | 73.9% | 68.0% |

(28,264 plants and 6,444 deaths). Neither peak reaches 100% because the LGM keeps walking between its last position restatement and the event. The restatement that rides in the *same record* as the event is better than that: in the two fixture logs every `F5` and `FF 51` (86 events) is preceded in its own record by the sender's LGM position, whose +8 px centre square is the named square every time. The viewer places the death effect on that pixel position when a same-record restatement is on hand and centred on the named square, and on the square itself otherwise; the corpus has not been measured for this. Parachutes ride the same subpacket as LGMs, so presumably share the convention, but no square-addressed event is caused by one, so it is untested. `FB` uses the shell convention established separately in [E:shell-fall-terminal].

### [E:centre-square] — a tank occupies the square containing its centre

Every terrain event following an `F7` mine-lay lands on the centre square, never the character square.

### [E:shell-centre] — shells centre at +8 px

Fitted against the terrain the corpus says a shell cannot be inside. Reading 9,838,080 shell restatements at a range of pixel offsets and counting how many land inside a standing tree gives a sharp V with its floor at exactly +8:

| offset | inside standing forest | |
|---|---|---|
| +6 px | 20740 | 0.21% |
| +7 px | 13586 | 0.14% |
| **+8 px** | **7055** | **0.07%** |
| +9 px | 12233 | 0.12% |
| +10 px | 18045 | 0.18% |
| +16 px | 76887 | 0.78% |

Uncentred (+0) it is 83,626, twelve times the minimum. The 0.07% residual is consistent with ordinary frames captured just before impact — a shell's last restatement can fall inside the tile it is about to strike. The viewer already had this right (`world_x` in `viewer/renderer.js` adds half a tile, verified there against 3,000 muzzle samples); it was the analysis tools that read the raw coordinate.

### [E:tankpos-5] — the tank position subpacket is 5 bytes

An early version of Osterwald's notes described a 6-byte layout with a leading `cD` byte; a 2003 erratum, confirmed by us, establishes 5 bytes.

### [E:ext-bit] — the LGM / parachute position extension

Every record of both sample logs parses exactly to its length under this rule and fails without it. That bit 1 also carries the extension comes from bolorama's wire parser, which skips it for `senderFlags & 0xE0`.

## The ring and the network

### [E:seq-loss] — the ring slot counter, holes, the gathering phase, and the three network readings

A step above 1 is a node that logged nothing that cycle, not a lost packet; and the count is only worth reading where the ring is settled, since getting that qualifier wrong ruins the measurement.

**A step is not a loss.** The reading below was built on a step of *n* meaning *n*−1 packets that never reached the logging machine. Two logs of one game written on two machines ([E:two-recorders]) say otherwise: their sequence holes are identical — 1,489 holes missing 8,611 slots in each, over the same stretch — and not one of the missing slots is a record in the other log, although the recorders sat at different positions in the ring, where a packet dropped on the way to one would have reached the other. `tools/measure-seq-holes.cjs` then reads every hole for what it is. The ring is in the counter (each slot owns one residue of it, unwrapped; the first reading used the ring order the unit steps spell out, 0→2→3→1→0 in that game, and the chain of successors closed on the player who actually sent the next record at every one of 12,682 holes in the four logs to hand), so each missing slot can be handed to the player whose turn it was (the two committed fixtures and the pair).

Classed by what the owner was doing, read from his nearest records either side: 43% a parked tank restating the same pixel before and after; 28% a dead or joining tank; 28% a stop, a start, or a position on one side only; and **zero** — not one of 13,627 missing slots — a moving tank, both neighbours under way at different pixels within 40 ticks, which is the one shape a dropped restatement would have, since a moving tank restates every cycle. A third of the missing slots (4,413) are the recording machine's *own* turn, in its own log, which no network can have lost. Whole-cycle holes (step = players + 1, what a packet lost with every block aboard would leave) never occur in the four-player logs, and in the two-player fixture they are both tanks parked. And the ring does not slow for a hole: 36% of holes sit inside a same-tick burst, where a lost packet cannot be, and a single-slot hole crossing a burst boundary costs a median 1.0 ring cycle, the same as an ordinary step across one.

So the sequence byte is a **ring slot counter**, stepped by every node as the packet passes whether or not that node has anything to say, and a hole is a quiet slot. The figure the viewer calls loss is the share of the ring's turns on which the node had nothing to log: it rises with player count because more players means more of them parked or dead at any moment, and it reads as catastrophic while a game gathers because everyone is waiting. What follows stands as measured — the same numbers under their real name.

**No loss at all, and a second log is the only way to know.** The holder's scan of both corpora (`docs/corpus_runs/bc9611b-recordings.txt`) found ten games logged on two machines at once; across them, of 38,318 missing slots in one log's holes inside the shared stretch, **none** is a record the other machine received.

Three readings in turn said otherwise and each was the alignment, not the ring: 38 (and 141 and 144 in two more games) were idle restatements matched a lap of the 7-bit counter out, cured by rejecting byte-identical matches stamped seconds off the sender's offset; then 12 in one game, one run of three cycles that one machine "had as a 49-tick hole" — the replays showed that machine's log *began* three seconds later than the match said, its first records idle restatements byte-identical to the other log's a lap earlier and within the rejection tolerance on a 6-tick ring; and the last candidates, a record or two either side of an 8 s absence in three games, are the same packets in both logs, stamped at one machine when the stall ended and at the other before it began — deliveries, late. The tool now tells a late delivery from a lap-out by the late machine's own log (a real delay ends a wait of the same length there) and reports both.

`tools/measure-seq-holes.cjs` over both corpora (`docs/corpus_runs/2f4c4f3-holes.txt`, 1,006 logs, 1.96 million missing slots, 1.63 million of them in partial-cycle holes handed to owners by the counter's residues — see the tool for how a slot is read from the counter) puts the moving class at **16 slots** — 0.001% — spread over ten logs, no log with more than four. Two earlier runs had read 3,465 and 18: the two logs that led the first with 1,436 and 366 change ring size mid-game (a player joining or dropping), which a successor map over the whole game misread, and read by residues they show none.

The sixteen that remain are not loss either. Every one is a crawling tank, the slower of its two speed bytes at most 18 of 64 — a moving tank restates every cycle whatever its pixel does (99.95% of consecutive records of a tank with speed > 0 are one cycle apart though half repeat the pixel, the tool's `restating` line), so a tank tapping the throttle at speed 5 can sit out a cycle by stopping for it, while a restatement dropped by the network would fall on fast tanks, which make five of every six moving pairs, and none did.

So a hole is a quiet slot, to the last one the corpus can be asked about; the two-machine pairs show no packet lost between two machines in 191,000 records; and the network's visible trace is the stall, a packet held up on its way round — 5 to 10 s in the three seen from both sides — which a single log records as a stretch in which nothing arrived. Since the game's ring needs its packet back to go on, a loss must cost a wait, and whatever repairs it leaves the counter unbroken.

**The gathering phase.** While a game is still gathering — the map being handed to joiners, nodes arriving — the ring turns at full speed while the logging machine records only a fraction of what goes round it. The sequence number races ahead of the log, and every slot it skips is charged as a lost packet. Gathering therefore reads as catastrophic loss without a single packet having gone astray: in one 19-minute 4-player log the first three minutes score 89%, 83% and 63% while the settled middle sits between 2% and 8%. It is short — a median 56 s, a few percent of a log — but extreme enough to dominate any average that includes it. Across the corpus, the share of a log spent gathering predicts its untrimmed loss figure at **r = 0.83**; measured over settled play only, that relationship disappears entirely (**r = −0.03**).

**Where settled play begins is best asked of the game, not the log.** The marker used is the **first base capture**: somebody drove a man into a base and took it, which cannot happen until the map has been distributed and everyone is playing. Every one of the 445 logs has one, a median 56 s in.

The obvious alternative — inferring the moment from where the log's record rate reaches its plateau — reads the log rather than the game, and misfires on a minority of them, declaring the plateau reached in the very first block of a game that had not begun; those logs keep their artefact and land among the worst in the corpus. Against the capture marker the rate rule scores a worst case of 69.8% loss versus 49.5%, and a 99th percentile of 46.9% versus 28.5%.

The capture marker is also the more consistent of the two, though this needs care to see: its raw split-half correlation is *lower* (0.88 against 0.95) purely because it deletes a large artefactual spread that both halves of a log shared, and correlation grows with the spread of what is correlated. On measures that do not scale that way it wins — half-to-half disagreement in loss falls (p90 of |A−B| from 3.13 to 2.76 points), band agreement rises from 74.6% to 75.5%, and among the 421 logs both rules put under 20% loss, where no artefactual tail can flatter either, the split-half correlation is higher for the capture marker (0.808 against 0.772). Rate inference is kept only as a fallback for a game in which no base was ever captured; no such log exists in this corpus.

**What the steps track, once the ramp is excluded.** The quiet-slot share rises with player count, more players meaning more of them parked or dead at any moment (it was read at the time as a ring gaining a hop per player, each hop another chance to drop a packet): medians 5.2% at two players, 6.6% at four, 7.4% at six. It also agrees at r = 0.69 with an entirely separate reading of the same stream — the share of elapsed time in gaps over half a second, during which nothing arrived at all. Over settled play the corpus runs from 1.3% in the cleanest games to 49.5% in the worst, median 6.3%.

**A correction.** Read end to end, these logs appear to improve year on year as dial-up gave way to broadband — medians 13.1% in 2001 falling to 9.1% in 2005. Almost all of that is the ramp: faster links transferred the map faster, so later logs waste less of themselves gathering. In settled play the medians are 6.6%, 6.2%, 5.9%, 6.2%, 5.7% — essentially flat. What improved between 2001 and 2005 was how quickly a game could be *started*, not how well it ran once it had.

Steps are only trusted across gaps under 5 s. A node rejoining after a longer silence can advance the 7-bit counter right round, and a wrapped step understates the hole rather than measuring it. The tail after the first quit is excluded on the same grounds as the ramp, though it costs far less: the ring is dissolving there, not failing.

**The reading neither of those makes: latency.** A token ring turns at the speed of its slowest link, and a slow ring is invisible to both counts above — it drops nothing (the steps march by 1) and need never go silent for the half second a stall requires; it just delivers everything late. Measured as the 90th-percentile gap between one record from a player and the next from the same player, over settled play the corpus runs 6–27 ticks, median 9, rising with player count as hops accumulate (median 7 at two players, 10 at four, 14 at six) and nearly uncorrelated with the other two readings (r = 0.15 against loss, 0.26 against stall).

It earns its place in the verdict by predicting what a viewer can make of the stream: the share of shell observations the motion pipeline fails to chain forward tracks cycle p90 at rho = 0.76, against 0.41 for stall and 0.25 for loss — and the loss figure's correlation is mostly player count in disguise, collapsing to 0.02 within four-player logs while cycle keeps 0.71. The poster child is a four-player log with 2.7% loss whose ring turned every 0.3 s: the corpus's worst shell interpolation on nearly its cleanest loss figure. Reproduces with `tools/measure-network-agreement.cjs`.

Scoring interleaved half-minute blocks of the settled span as though they were two separate games gives r = 0.88 on loss, 0.94 on stall and 0.99 on cycle time, so this is a property of a session rather than of whichever minute was sampled, and fair to state once for a whole game — which is what the viewer's header does, via `network_conditions` in `viewer/network.js`, the verdict being the worst of the three readings' bands. All of the above reproduces with `tools/measure-network-conditions.cjs`.

### [E:two-recorders] — two logs of one game

A game of 29 March 2003 on Easter Island III, four players, survives as two logs: `20030329~fc3fcb`, 14.2 minutes written by the player in slot 2, and `20030329.2~dd2544`, 17.5 minutes written by the host in slot 0, who started logging three minutes earlier and stopped three records after the other quit. `tools/compare-recordings.cjs` sets each log's start-of-log burst aside (it is written locally and sent to nobody: the other log shows nothing at the moment it happens) and aligns the rest as a longest common subsequence of raw decrypted payloads.

Every one of the 17,178 ring records of the shorter log is in the longer one, byte for byte, sequence byte included, in the same order; the longer log's 246 extra records are 243 before the shorter log began and 3 after its recorder quit, with nothing unique to either inside the shared stretch. What one machine logs, every machine logs: the file is the ring's transcript, and its only per-machine content is the time tags, the boot burst, and where it starts and stops. The two bursts differ in 24 and 22 records, the map rows and base stocks that changed in the three minutes between the two starts.

Subtracting the time tags pairwise, B − A is 117,351 ticks for senders 0, 1 and 3 (p1–p99 within −5/+2 ticks of it) and 117,358 for sender 2, one ring cycle more (the median cycle is 6 ticks in both logs): slot 2's records are stamped a cycle earlier in A, relative to everyone else's, than in B, which is what stamping one's own record at send time and the others' at arrival predicts, and it names slot 2 as A's recorder — as the burst rule of `viewer/network.js` already did, by a different reading. (B's recorder is not marked this way: from B's side, slot 0's own record and the records B receives in the same packet all reach A together one hop later.) The two Macs' clocks, converted to Bolo ticks, agree to 3 ppm over 850 s, under a tick end to end. The lone quit in the shorter log is its recorder's, and the log ends on it, as the terminal-quit rule expects. The sequence holes are the same in both logs to the slot, which is where [E:seq-loss] begins. `--scan` over a corpus groups logs by the game id in their game info (host address plus start time) to find every such pair.

The holder's scan of both corpora (`docs/corpus_runs/bc9611b-recordings.txt`, 1,030 logs) found 16 games logged twice: six are one machine restarting its log, the two files covering different stretches of the game with nothing but a stray idle restatement in common, and ten are two machines logging at once, 191,126 shared records in all. In every one of the ten, every record the shared stretch holds is byte-identical in both logs, and every record that seemed to be in one log only turned out to be in both — matched a lap out, or delivered late through a stall (see [E:seq-loss]); no machine ever wrote a record the other lacked, or wrote one differently.

The stamp offsets fall into two groups a ring cycle apart in every pair. A sender's packet reaches whichever recorder comes first on its way round, so the group stamped later at B is the arc of the ring running forward from just after B's recorder up to and including A's, and the other group the arc up to and including B's; the ring order, read from the sequence steps, says which slot ends each arc, and those are the two recorders. Over the ten pairs that names all twenty recorders, and every one agrees with the burst rule of `viewer/network.js` — twenty independent confirmations of a rule that had rested on one log whose recorder was known. Clock drift between two Macs runs from 1 to 24 ppm, under a tick a minute.

One trap the scan taught: an idle tank restates the same bytes for minutes and the sequence byte comes round every 128 records — under 200 ticks on a fast four-player ring — so an anchorless stretch can be matched a lap out, and a fixed tolerance cannot separate that from a packet genuinely delivered 8 s late through a stall. The tool reads the late machine's own log instead: a real delay ends a wait of the same length there, a lap-out sits in ordinary traffic. It lists the late deliveries (the three stalls of 5–10 s over the ten pairs, seen from both sides) and every run of one-log-only records with the gap the other log shows across it.

### [E:idle-silence] — how long a live player can be silent

`tools/measure-tank-silence.cjs` takes, for every record a player sends, the gap since his previous record of any kind, and calls it a live silence unless it reaches 30 s or ends in a quit. Over the two committed fixtures and a third four-player log (199,318 live silences), the longest is 8.8 s; 110 exceed 5 s, 5 exceed 8 s, none exceeds 10 s. The long ones are almost all idle tanks — position restatements either side identical in square, pixel and direction — and cluster in the gathering phase, the four longest being the four players of the third log sitting at their starts between 73 and 79 s in, before the first base capture at 91 s. The idle restatement period is a property of the log rather than a constant: the two-player fixture restates a still tank every 2–4 s, the third log every 6–7 s, the four-player fixture every 8 s, with a spread of a second or two either side on every one.

Over the 443-log corpus (13,303,354 live silences; the holder's run at the tool's first commit is archived as `docs/corpus_runs/ae73302-silence.txt`) the idle picture holds — p99 5.6 s, p99.9 9.2 s, 407 idle silences past 10 s and 7 past 15 s, the longest 19.7 s — but the wall-clock tail runs to 28.9 s, right up to the absence bound, and it is made of *moving* tanks silent several at once: the four longest are four players of one log all ending a 28.9 s silence at the same instant, 1151.3 s in.

A fade keyed to the playback clock ghosts them all (a 5 s rule fades 15,818 silences in 413 of the 443 logs; 15 s still fades 96 in 47), and it cannot tell whether the log heard anyone else meanwhile. The tool's second reading, the *ring* silence — from a player's previous record to the latest record from anyone stamped strictly before his next — is the one a subtler fade would use: it stays put through a stall in which nobody is heard, and a burst of records at one tick, the usual end of one, does not count against the players in it, since the viewer applies every record at a tick before drawing.

On the corpus (`docs/corpus_runs/1195356-silence.txt`) the ring reading for idle tanks is p99 4.9 s, p99.9 8.4 s, 204 past 10 s and 5 past 15 s, the longest 19.4 s; a 15 s ring rule fades 52 silences in 29 logs, 5 idle and 47 moving. The moving tail is barely shorter than the wall-clock one, and listing the longest with the records heard from each other player meanwhile splits it in two.

Some are **splits the log really saw**: a player silent 28 s while player 0 alone was heard 62 times, another 24.6 s against 137 records from player 0 — the logging machine talking to itself across a split, and fading the absent tank is the fade doing its job. The rest are **crawls**, the ring freezing for everyone: the three longest silences of all, 28.9 s, each heard exactly one record from every other player, and a 24.1 s trio in another log likewise; nobody is a ghost there, but by time alone every one of them fades. Time cannot tell the two apart, and a cycle count alone cannot tell a ghost from an idle tank — a still tank sits out 32 records from a neighbour in 6 s on a fast ring.

A rule taking both — 15 s of the ring heard turning, and some one other player heard at least 5 times over — would fade 38 silences in 27 logs on the corpus, against 96 in 47 for 15 s of the clock; the viewer fades by the clock at 15 s, the subtler rule costing a table of counters in the game state for a few dozen events over 11,600 minutes of play.

**Whether an idle machine keeps sending at all** — players waiting at the start, or hanging about after someone dropped — is answered by the silences the 30 s bound sets aside: of the 1,006, 941 end in a quit record and 25 in a `T=7` re-admission, both the ring losing the player; 29 end in an ordinary record with the tank moved or without a position, a split healing; and just 2 end with the tank on the very spot it left, one of 30.1 s and one of 136.5 s, each with one record heard from anyone else meanwhile — the whole log frozen, not a machine gone quiet while the ring turned. No idle, connected player in 443 logs was silent for more than 19.4 s of the ring turning.

The viewer once faded after 5 s of clock time, which drew every idle tank of the gathering phase as a ghost: there the whole ring is on a 6–8 s cycle, and across a 7.6 s silence in the third log each of the other three players was heard exactly once.

Before the game has settled — nobody shooting, no base draining — nothing else from a player fills the interval between a stationary tank's restatements, which is why a live, connected player is routinely silent for 6–9 s. Measuring a silence against the records the log *did* receive from others meanwhile would be more faithful than the clock alone, but as the ring reading above shows it buys only a few dozen events corpus-wide.

### [E:quit-fields] — the three address fields of a quit

The three fields were decoded against known player addresses; game ports observed at 50000 and elsewhere. Field length 4 occurs in 5 of 955 quits in the corpus.

## Shells

### [E:shell-chained] — offsets chain from the previous member

Chained and first-relative decoding are equivalent for 2-shell lists. Verified on 3-shell lists where a new shot becomes the list head: first-relative decoding conjures a phantom shell and loses a real one, chained decoding reconstructs every position to the pixel.

### [E:shell-offset-quantisation] — the one-sided quantisation bound

Replay md5 `0f691e1d594c0a6636c25578d7d4fa17`, records 1210–1255, isolates 63 direction-13 shell observations on the left half of the map, all fired by pillbox 4 at (123,123). All 18 list heads match an exact direction-13 point in the independently recovered pillbox orbit table. Of the 45 members reconstructed through signed chained offsets, only 7 match exactly; every other member lies within one pixel per preceding link, per axis, of an exact orbit point.

The final pair makes the consequence concrete: the head is exact bradian 209 step 30 at relative `(-117,-51)`, while adding the second member's encoded `(5,6)` offset gives `(-112,-45)`, one pixel from its exact bradian 207 step-28 position `(-111,-44)`. Their exact terminals are respectively `(-124,-54)` and `(-126,-49)`. Thus the offsets were quantised independently from finer internal coordinates; adding them to an already quantised head accumulates bounded positional uncertainty.

Because the signed arithmetic shift rounds every link down, the bound is one-sided on each axis: for member index `i`, `reconstructed <= exact <= reconstructed + i`. Exact-physics matching must test this interval, not demand equality or use a symmetric uncertainty box.

The quantiser itself is recoverable once an orbit supplies the internal 1/16-pixel coordinates: each byte is `(next_internal - previous_internal) >> 4`, with a signed arithmetic shift. It reproduces 18,873 of 18,875 adjacent uniquely resolved pill-shell pairs in `n20021018.2` and 1,720 of 1,721 in that replay, including roughly 18,000 negative components; the three contradictions are consistent with the provisional shell identity/source being wrong. For the final pair above, the internal coordinates are `(-1857,-801)` and `(-1771,-690)`, whose difference `(86,111) >> 4` is exactly the logged `(5,6)`. This makes the raw offset chain useful evidence rather than mere error: candidate orbit states for adjacent members can be retained only when their exact internal coordinates reproduce the byte pair.

### [E:shell-direction] — lists split by direction, not by source

Quiet reciprocal exchanges isolate the direction semantics without tracking shell identity between restatements. Across the 446-log corpus, 2,607 records follow a sender restatement containing no shells with exactly one tank fire, one approximately reciprocal pill fire, and exactly two new shells. Every one encodes them as two 1-shell lists; none uses one 2-shell list. Of these, 2,587 also pass a strict source-and-ray geometry check, again with no mixed list. As a control, 349 geometrically clean quiet records have two different pillboxes fire in the same direction: all 349 combine the two shells into one 2-shell list, proving that the split is by direction rather than firing source.

The sample log supplies the within-one-emitter case. From 21:24.24, pillbox 8 changes its aim from direction 5 to direction 4 while its older shells are still airborne. The directions coexist in separate lists through 21:25.22; at 21:24.98, a restatement with no new fire has direction-5 shells travelling southeast from the pill and direction-4 shells travelling east. The newer direction-4 lists remain after the last direction-5 shell expires. Thus the header direction describes every shell in its list.

### [E:shell-restate] — every record restates every shell the sender simulates

Zero of 743 in-flight shells reappear after a list-less record from their sender, whether that record carries a tank position, only events, or a dead tank's `T=7`.

### [E:shell-list-skew] — all the lists of one record are one sampling instant

Measured by `tools/measure-shell-list-staleness.cjs`: for every pair of same-pill matched shells whose orbit step is unambiguous at both ends of one statement-to-statement transition, the difference of their orbit-step advances, bucketed by whether the pair shared a shell list at each end. Members whose orbit could clamp the advance near its ~32-step end are excluded. Over three replays (the committed fixture plus two laggy corpus games, `022603.5` and `110702.1`; 58,022 surviving pairs), the advance difference is **zero** in 99.82% of same-list/same-list pairs and 99.67% of cross-list/cross-list pairs — the pill-wide lockstep is a strong prior even across lists. The tool prints the same-list disagreement rate as `error_floor`: cross-list disagreement runs at barely twice it overall, four to five times it in the buckets whose list membership churns between the statements, and on the clean fixture the two rates are nearly equal, so the above-floor signal lives exactly where lag lives — which is where matcher error lives too.

The nonzero residue must be read skeptically, and a first skeptical pass dissolved much of it. Same-list pairs disagree too (at rates in the same range as cross-list pairs), and a list's chained offsets describe one coherent snapshot, so a same-list disagreement is a *reconstruction* error by construction — the matched-chain noise floor sits exactly where the skew signal would. Three error mechanisms were identified by hand: identity shifts of ±1 member along dense same-bradian streams (each worth ±2 steps, concentrated in stitched links); orbit-step advances clamped by the ~32-step lifetime near expiry; and the tally's conditioning on matched single-state chains, which both undercounts skew and admits mislinks.

A cautionary negative controls the reading: the `022603.5` transition at 2:56 was first taken for a stale direction-12 list, but the full dump shows **all five** of the pill's linked shells — across three lists and three bradians — advancing exactly +7 where 5 updates elapsed: perfect cross-list lockstep, the whole *record pair* compressed as a unit, which the pairwise difference cannot see and playback handles by re-timing.

What survives the skeptical pass is a handful of list-coherent bimodal transitions: in `110702.1` at 45:45, three shells across two lists and two bradians advance +10 in mutual lockstep (their chains continuing coherently for 3–4 further links) against ~+5 for the other list's shells in a 3.5-update window; similar splits appear at 22:15 in the same replay (+11 against +3) and at 14:26 in `022603.5` (+9 against +6). These resist the error reading — multiple mutually-lockstep shells would all have to be mislinked the same way — but the demonstrated noise floor means genuine per-list skew is **not established**; every apparent instance so far examined closely has either dissolved or retains an unexcluded error explanation.

The corpus-scale run settled it, in the direction the project's own heuristic predicted (what looks 99% true here is usually 100% true, the residue a mistake). Over all 443 logs -- 4,339,887 pairs -- the same-list `error_floor` is 0.178%, and **stable** cross-list pairs (same list assignments at both ends) disagree at 0.202%, a ratio of 1.14. The magnitude distributions match too, and where they differ they point *away* from skew: disagreements of seven or more steps -- the shape a genuinely stale list would produce -- run at 20 per million within single lists (provably pure reconstruction error) against 16 per million across them, and the cross-list excess concentrates at two-to-three steps, the signature of a ±1-member identity shift along a dense stream.

The once-promising excess is confined to the churn buckets (list membership differing between the two statements: 1.11% and 1.16%, six times the floor) -- exactly where an identity swap between stream-mates in different lists manufactures both the apparent churn and the apparent disagreement, so those buckets carry no independent evidence. The list-coherent bimodal cases named above sit in churn territory and no longer support a skew reading on their own.

Conclusion: no genuine per-list sampling skew has been demonstrated anywhere in the corpus, and every measurable signature of the apparent exceptions matches reconstruction error. The working rule for playback: **all the lists of one record are a single sampling instant**; the pill-wide common advance is one number per sender transition (though the whole record is routinely stale as a unit); and an apparent cross-list disagreement indicts the reconstruction, not the record.

The one formal caveat is survivorship -- the tally conditions on matched chains, so a skew mode that always breaks its chain would be invisible to it -- but every observable claim the skew hypothesis made has failed. This invariant is now strong enough to enforce: the matcher's lockstep pass, currently gated to one bradian of one pill, could intersect candidate advances across a pill's whole roster, and the residual passes could veto stories that give one sender's transition two different advances.

Within one list simultaneity follows from the encoding, since the chained offsets describe one coherent snapshot. Whole records, by contrast, are routinely stated stale *as a unit* — every shell of every list a few updates further along than the receive stamp implies — which pairwise lockstep is blind to. The sender's true simulation keeps one pill's live shells in strict distance order at all times (every shell advances one step per update pass); a cross-list skewed statement, if they genuinely occur, would misreport that order, so an apparent overtake between shells stated in different lists is weaker evidence than one stated within a list. The standalone map/node records carry no such implication; none has been seen while its sender had shells in flight.

### [E:shell-fall-terminal] — `FB` is the shell's terminal point

An `FB` shell continues at 2 px/tick along the fine heading learned from its earlier restatements; its `XX YY yx` position is the resulting terminal point, not a position expected to equal the last restatement. This matches 8,191 of 8,495 events (96.4%). The matched paths remain straight independently of the matching cost: lateral residual against the learned ray is median 0.56 px and p90 2.0 px. This supersedes the earlier negative result from comparing `FB` directly with the shell's last reported position. For any matched shell terminal, playback dates its transient impact effect to the computed arrival time; the event's authoritative terrain, object, or tank state change remains at its logged record time.

### [E:shot-fire-time] — the `5d` nibble is stamped at fire time

The two hypotheses separate because every record header restates the sender's packet-time direction, so a packet-time nibble would equal it always. It does not. Across the 443-log corpus (764,209 `5d` events; the holder's run at the tool's own commit is archived as `docs/corpus_runs/137752f-shot.txt`), 101,947 fires arrive in records where the sender's header direction had just changed, and there the nibble matches the **previous** record's heading 44,091 times against the new one's 51,584, with 6,272 matching neither — 6,023 of those lying on the short arc between the two headings, where a fire mid-way through a multi-step turn would land. A packet-time nibble can produce none of those 50,363 disagreements (6.6% of all fires); a fire-time nibble predicts all of them. 94% of the neither-cases sit one coarse step from the packet-time heading; the 1,042 arriving in steady-heading records read as fires during a jink the restatement cadence never sampled, and a 428-fire tail (0.06%) lies two or more steps out, the residue sharper turns and lost records supply.

The nibble also matches a real shell: a direction-matching shell list rides the same record for 82% of previous-heading fires against 88% of agreeing ones, most of the remainder being point-blank shots dead before any restatement (11.5% of all fires). And 11,279 fires (1.5%) have their shell's first restatement in the sender's *next* record: the fire raced the packet build, so the event is logged one record before its shell.

That skew, not a stale direction nibble, is the reading the numbers support for the turning-tank case in issues #17/#24 (there the d14 fire event sat one record before the d14 shell's first restatement, while the d13 event in the shell's own record was the next shot of a turning burst) — so a consumer matching births to fire events should keep direction equality **exact** and instead be prepared to look one record back for the event. The shell-list check here is coarse — a same-direction pillbox shell can satisfy it — so the split between classes, not the absolute same-record rate, carries the finding.

First established on the two committed fixtures (12,612 events), which show the same shape throughout. `node tools/measure-shot-direction.cjs`.

### [E:muzzle] — the opening frame does not fell the firer's tree

Of the 28 frames in [E:base-road] that sit inside forest with no base or pillbox on the tile, **all 28** were fired in that very record: the sender's last `5d` is 0.00 s old in every case. 23 of the 28 have the firing tank in the same tile as the shell, 14 of those with the tank's hidden-in-trees bit set, and in 26 the shell is 6-9 px from the tank centre — the muzzle offset, a shell that has barely cleared the barrel.

So these are not shells crossing forest: the opening frame simply does not fell the tree under the firer, whether because the shell is not collision-tested on its first tick or because it is exempt while inside the firer's square. The log cannot separate those.

It does **not** follow that a tank can never fell its own tile. Of 14,666 shots fired by a tank standing on forest, 17.0% see that tile felled within 1.5 s, and the rate rises with the room the shell has to cross the square: at a runway of 15-16 px — the tank hard against one edge, firing straight across — it reaches 29% and 39%, and at maximum inwardness 41%. The flat ~17% elsewhere is uncontrolled, since a tank sitting in cover is usually being shot at and incoming fire fells the same tile; separating the two would need a control this measurement does not have. Read it as: the opening frame is exempt, the rest of the flight is not.

This matters only to code that models shell-terrain interaction, since the felling itself is evented — but such a model will otherwise clear the firer's own tile every time anyone shoots from cover.

### [E:shell-birth-sector] — a shell born on a sector boundary is listed a sector off for life

Osterwald's notes record that a shell can sit in a shell list "with a 0-15 direction that is not equal to the direction reported in the 5d subpacket", and call it a possible Bolo bug. It is real, it has a mechanism, and the list is the side that is wrong. `node tools/measure-shell-birth-sector.cjs` over the 443-log corpus (`docs/corpus_runs/da2d5d7-shell-sector.txt`) takes every shell listed within 10 px of its sender's tank, outbound along its own heading (an inbound one is a pill's, simulated by its target), and fresh -- no shell of the same list direction one record earlier where a 2 px/tick flight would have put it. That is 53,150 fresh muzzle shells. 50,572 carry a nibble's direction in the same record and 504 one from the record before or after; 47 have no nibble anywhere; 2,027 disagree with every nibble, and 2,024 of those by exactly one sector. The 2,024 lie in 378 of the 443 logs, so it is the game and not a machine; 2,006 arrive in a record whose header facing had changed since the sender's previous record, and in 1,749 the shell's list direction is the *previous* record's facing while the nibble is the current one. The sign splits evenly, 1,058 one way and 966 the other. So the list direction is a coarse facing the tank held shortly before the shot, the nibble is from the shot itself, and they part only when the turn crossed a sector boundary in between.

How long before the shot that facing was sampled is not read off any byte; it is bounded by the rate. Among the 9,909 fresh muzzle shells fired in records where the sender's header facing changed, 2,006 are a sector off (20%), against 18 of 43,241 fired on a steady heading. A facing sampled a fixed L ticks before the shot catches the boundary inside that window for about L/gap of the shots fired during a one-sector turn, so the share should fall as the record gap grows, and it does: 518 of 816 at gaps of 1-4 ticks (63%), 1,087 of 4,786 at 5-8 (23%), 374 of 3,884 at 9-16 (9.6%), 27 of 423 at 17 and up (6.4%). Share times gap puts L between one and two ticks in every bucket past the saturating first, and a facing carried over from the previous packet would hold near 100% whatever the gap. So the label is the facing of a tick or two before the shot, and the rate alone cannot say whether the game takes it every time.

Whether it does is settled by pinning the shells (`--pin`, same archive). The engine pins most tank shells to an exact bradian, and a tank turns at a known rate, so a shell's bradian distance into the nibble's sector from the boundary the turn entered by says how long before the shot the facing crossed. Of the 2,109 pinned shells fired in a one-sector turn, every stale label lies within the first four bradians past that boundary, and none of the 1,262 shells four or more bradians past it is stale; four bradians is two ticks at the open-ground turn rate, one shell update. Inside that window the share is set by whether the tank was still turning at the shot. Shells within a bradian of the boundary whose sender's facing was still changing in its next record, so certainly mid-turn, are stale in 43 of 44; two or three bradians past it, in 40 of 63, the shortfall being slower terrain, where a tank covers only one or two bradians in the window. Shells within a bradian whose sender had stopped turning by its next record are stale in 113 of 121 at gaps of four ticks or less, 134 of 213 at five to eight, and 14 of 76 beyond: a tank that halts a turn just past a boundary and then fires has a facing inside the window but nothing stale to sample, and a longer gap gives it more time to have halted. On a steady heading, 0 of 7,526 pinned shells are stale. So the fault is deterministic: the list label is the facing from one shell update before the shot, and whenever the facing crossed a sector boundary inside that update the label is the old sector, every time. The wider turns agree: shells fired while the facing moved two sectors in the gap are off in 243 of 753 (32%), and then the label is the middle sector, neither the previous record's facing nor the current one.

Which one the shell obeys is settled by its flight: each case is re-found one and two records on under both headings at 2 px/tick, and the flight follows the nibble in 510 of 513 decided cases. The control -- exact-match shells scored the same way against their own sector and its neighbour -- decides 32,272 to 10, so the test separates one sector cleanly. The shell is never relabelled: 1,620 of the cases are re-found later still listed under the stale direction, 2 under the nibble's. The `FC` hit packet, by contrast, carries the true sector: of the 493 such shells the engine at `7801209` left as pop-outs, 234 had a tank-hit box reachable along the nibble's heading, and its direction was the nibble in 184, the list label in 4.

The consequence for a reader is the whole flight, not the birth. Run through the engine at `7801209`, the 2,006 corrected shells linked forward as well as the 48,377 exact-match fresh shells (6.2 restatements a chain against 5.7, false predecessors 3 against 13), but only 2.7% got a birth from their fire event against 98.8%, and 24.6% ended as a pop-out with no explained impact against 1.8%: every tank hit refused for direction (7 credited where about 150 were expected), and single sightings aiming their terminal ray a sector off (324 of the 493). Playback takes the nibble as such a shell's sector and keeps the list label only for matching restatements (INTERPOLATION.md; the corpus effect is in `docs/interpolation_tests_corpus.md`). This extends [E:shot-fire-time], whose "keep direction equality exact" holds for the shell's true sector and not for its label, and is the same phenomenon `docs/tank_shell_bradians.md` saw from the other end as a ±4-bradian spill past the nibble's round window.

### [E:shell-passthrough] — apparent pass-throughs are identity errors

The original observation: the sample logs show streams of shells on a line through a pill's centre where some hit (the shooter itself sends the `9n`) while others are restated well beyond the pill and fly on — dozens of ray-consistent cases per log, through hostile and neutral pills at full armour. 29 cases across two logs rest purely on absolute list-head coordinates.

That last point defends against *offset decoding*, which is a different problem from **shell identity**, and identity is where this breaks down. A re-examination found the apparent pass-throughs concentrated exactly where identity is unrecoverable. In `2001\april\040201 redsluggo vs dsmega` at 8:15, one player's list carries a direction-8 stream in which `(2081,2235)` and `(2083,2275)` appear singly in consecutive restatements — and then **together** at 8:15.98, proving they are two shells and not one that moved 40 px. The same position `(2081,2235)` also recurs 0.54 s apart, which no moving shell can do: successive shells from a fixed emitter pass through the same points at the same phase, so a stream cannot be tracked by position at all.

Two pillboxes firing on one line at different cadences is the ordinary case for this, and it is also the case that generates most apparent pass-throughs. A corner-graze filter alone removes 80% of naive hits, and of what survives, 839 of 1,126 are pills at armour 0. The live-pill residue has not been shown to survive proper identity tracking, and the working assumption is that it does not.

## Pillboxes

### [E:pill-shell-migration] — pill shells ride in the simulating machine's lists

91% of `F4` fires are followed by a direction-matching shell near the pill in some player's list, and the reporting player's tank sits within the pill's 8-square range (median 6.7).

A pillbox is simulated by the machine it is shooting at: each machine checks whether its own tank is the pill's target — the nearest hostile tank in range — and simulates the shots fired at it, so pill shells ride in the *target's* restatements from the muzzle onward. That is a per-shot decision every machine makes for itself, not a handoff: nothing in Bolo could pass an in-flight shell to another machine, and the idea that one ever does is regarded as highly suspicious (see INTERPOLATION.md).

### [E:pill-target] — the `F4` sender is the pill's target; hand-over of a departed player's property

The sender of an `F4` is the pill's target, and the target is the nearest hostile tank. Over the 443-log corpus (1,162,752 fires; the holder's run at the tool's commit is archived as `docs/corpus_runs/012fa63-target.txt`), 102,929 fires arrive with two or more hostile tanks inside a pill shell's 8.5-tile flight; in 96,049 of those (93.3%) the sender's tank is the nearest of them, against 49.6% if the simulating machine were drawn at random. Of the 6,880 exceptions, 4,449 lose by 8 px or less and only 24 by more than 64 — stale restatements, since positions are read from each player's latest packet — and in 2,260 the nearer tank was hidden in forest. Those are not losses: ranked among *visible* hostile tanks only, the sender is nearest in 98,308 (95.5%), so all but one of the hidden-rival cases resolve, and the sender's own tank is hidden at the moment of a fire in only 4,329 of 1,156,489 corpus fires (0.4%; 17 of 13,009 on the sample log). A pill does not target a tank hidden in forest; the residue is the size the hidden bit's own staleness would produce.

The direction nibble backs the same reading: it points at the sender's tank exactly in 64.9% and one sector off in another 26.2%, at the nearer rival instead in 0.5%. The one-off cases are deflection shooting, not error: a pill leads a moving target. Over the corpus, with the tank's motion read from its last two restatements, a nibble one sector off the bearing lies on the side the tank is moving toward 374,951 times and on the trailing side 19,929; two sectors off, 9,267 against 260; three or more, 3,428 against 278. A still tank draws 255,467 exact fires, 14,714 one off and 80 two off. Two or more sectors of lead is rare (about 1.5% of fires at a moving tank) but real, so a consumer gating pill shells by direction should allow it. The sample log alone gives 93.9% of 1,106 contested fires, losses all within 32 px.

The direction-0 index fault is resolved first: an odd-index direction-0 fire goes to pill `n-1` when the named pill is allied to the sender or beyond a shell's flight of its tank and `n-1` is neither — 15,394 times over the corpus, with 5,269 more where both fit and the named one is kept. Before that rule, every one of the 27 fires the sample log set aside as "sender allied to the pill" was such a fire, the named pill 190–725 px off and the pill below hostile within 36–127 px: a third, independent sighting of [E:pill-fire-index].

The 4,125 fires that named a pill the model held allied to the sender turned out to be two things, neither a game rule. 4,083 of them were one replay with a netsplit and a rejoin into shuffled slots, and were the tool's own fault: it had run the game model without the viewer's join classification (`classify_node_joins`), so a slot re-entered by a `T=7` roster burst kept its old occupant's alliances, and the next accept's clique merge spread the stale link to everyone. The viewer itself passes the classification and does not make this mistake. With it passed through, that replay's count falls to 41, and every one of the 41 is a fire from an *orphaned* pill: one whose owner slot had quit since the pill got that owner.

Pills are owned by an alliance rather than by a tank (owner's knowledge; the manual says as much for leaving an alliance, see [E:leave-pills]), and a departed player's planted pills stay with his alliance. The replay bears this out by person, which is the only way to follow it across a slot shuffle: of 866 fires from orphaned pills, **0** are at a player who was in the owner's alliance when he quit, 521 at other players present then, and 345 at a name that joined afterwards; the six that first looked like exceptions were odd-index direction-0 fires with a hostile pill one below, [E:pill-fire-index] again.

What the model gets wrong is only the slot-reuse clause of its `quit` handling in `viewer/game.js` ("keep their allegiance until the slot is reused"): when an enemy took the departed owner's slot, the model handed him the pills, and they shot him and his allies. Since the game evidently keeps them with the old owner's alliance even after the members return under new slot numbers, following that needs names, not slots.

Over the corpus, with the join classification in place, the allied-sender fires fall from 4,125 to 82, of which 80 are from orphaned pills, and the rule holds at scale: 4,741 fires from orphaned pills, 39 at a member of the owner's alliance as of the quit (0.8%, a residue that may be the frozen mask itself being stale in a netsplit, unread), 4,357 at other players present then, and 345 at names that joined afterwards.

The two allied-sender fires that are not orphans are read: in each, the fire shares its tick with the accept that admitted the sender to the pill's alliance (one record apart in the log), so the pill was simulated before the accept had gone round the ring — the model is one record ahead of the game, no more.

The 192 naming a pill beyond the sender's range are the soft edge of a circle, not evidence of a box: 167 lie within 160 px of the pill and 19 more within 200 px, but 76 of the 192 have a horizontal or vertical distance over 136 px, which a per-axis range would not allow. A tank's logged position can be a dozen ticks old and the tank closing at up to a pixel a tick, so a fire logged at 137–150 px is a tank that was inside the radius when the pill decided; the range is the circle at or about the shell's 8.5-tile flight, as the owner says. Six lie beyond 200 px, most with a sender position over a second old. 34 have a nearer hostile pill along the direction nibble, unread.

The viewer's `quit` handling keeps the slot as owner and so goes wrong only when an enemy later takes that slot. With single-owner pills the alliance rule reduces to handing a quitter's grounded pills to a remaining ally, exactly as `FF F4` alliance-leave already does ([E:leave-pills]); over the corpus 391 of the 728 quits that left pills behind had such an ally present, and those quits account for 2,648 of the 4,741 orphaned-pill fires.

The 39 anomalies were the hand-over failing in one replay, and the reason is the heir's state, not the quitter's: a player died and quit, and at that moment his only ally was dead too (killed 60 records earlier, respawning 4 records later), so his pills went to nobody and one of them fired at that ally 28 times until he killed and re-planted it. The other quit in the same replay handed its pill to a live ally as the rule says. See the heir-state split above.

The remaining quits found no ally in the game, the netsplit case: the owner's name rejoined later for 1,325 of the fires and never for 768. For those the pills must not pass to whoever takes the slot; handing them to the returning owner by name covers the larger part, and the rest stay with a departed slot that nobody inherits.

Implemented in `viewer/game.js`: `quit` hands over as `alliance_leave` does, and with no heir marks the pills DEPARTED, remembering only the owner's name, from which only that name rejoining recovers them; the viewer draws such a pill as hostile to every viewpoint.

The recovery assumes the returning player pressed Rejoin rather than Join — only Rejoin gave a player his things back, and the netsplit replay's chat has a player who chose Join reporting "no stuff" and being told to rejoin — since the log shows nothing of the choice; a same-named stranger would also be taken for the owner.

Since a pill never fires at its own side, the model treats a fire at a player it holds friendly to the pill as proof that its ownership or alliance picture is wrong, and, not knowing which, makes the pill nobody's (DEPARTED with no friends) until it is next picked up or planted. Two exemptions: an odd index at direction 0, being possibly one too high; and a fire within a second of any alliance request, accept or leave, because two corpus fires share a tick with the accept that made the pair allies and the pill was simulated before it arrived.

Measured over the corpus, the rule triggers seven times, in three replays, and every one is the same shape: a quitter's pills handed to his heir under the hand-over, then firing at that heir. The split that explains them is the heir's state at the hand-over: of the 394 quits with an ally left, the heir had a live tank at 344, and the 2,281 orphaned-pill fires that followed those include **none** at an ally; the heir was dead or tankless at 50, and the 243 fires that followed those include all seven. That split says only that the dead heir did not get them, not who did: the other 236 fires were at enemies, which any owner but an enemy would produce.

A tankless heir losing out looks like a bug, and a bug could as easily hand the pills to an enemy, so the next run tallied each quit's orphaned-pill fires by target against candidate heirs (archived as `docs/corpus_runs/012fa63-target.txt`; a real heir is never fired at).

With no ally holding a tank, 406 quits: the pills fired 1,311 times in 55 of them, 858 of those at the lowest-index live enemy across 45 quits, 852 at the lowest-index player present across 43, and 40 at the dead ally. None of those inherits, and no other enemy does either: in 25 of the 55 quits the pills shot every enemy present at the quit, which a pill owned by any one of them never does. Nobody's is the reading that stands.

With the lowest-index ally live, 344 quits: 2,281 fires, none at that ally and 1,162 at the lowest-index live enemy, so the hand-over is real. With that ally dead but another ally live, 2 quits and 42 fires, none at the next live ally but none at the lowest live enemy either, so whether the pills pass to the next live ally (as playback assumes) or to nobody is unsettled. The next name to take the quitter's slot was fired at 9 times in the one quit the run offers with fires after the join, and never in one other where the fires may all predate it, unread.

So a departing player's pills go to an ally who holds a tank, and with none they are nobody's; the model does the same, and with it in place the fire rule triggers 0 times over the corpus and the allied-sender fires are the two same-tick accepts. The dead-quitter reading below is superseded (the quitter's own state never mattered, the heir's did).

Bases follow the same hand-over and DEPARTED rules, on the owner's word that ownership works the same for both; they have no fire to correct by, so a wrongly reclaimed base stays with the returned player. `node tools/measure-pill-target.cjs`.

A second corpus of 587 logs (1,096,282 fires) put the hand-over through the same tools and turned up the first live heirs ever fired at, two replays. In the first, a player asked an ally for an alliance ten seconds before quitting: his request named two slots, one of them a player who had left eight minutes earlier, the other accepted, and the heir held a live tank at the quit. Within 25 s, six of the eight pills the heir came within range of had fired at him, and he then *captured* one of the quitter's bases, which nobody inherits from himself. In the second a player left his alliance, re-requested it naming a slot whose player had already quit, was accepted, and quit; the heir had sat within range of the two handed pills for over 40 s after the leave without a shot, so the leave had handed them over, and they turned hostile only after that quit and the quit of the last other member while the heir was dead.

What the two share is a standing alliance request naming a departed player, and `measure-pill-target.cjs` and `measure-base-owner.cjs` now split every quit and leave that hands property over by the lowest slot the departing player's alliance named -- in the model's alliance word, or only in that request -- and whether its player had quit, with the ticks the heir's live tank then spent within a shell's flight of a live handed pill (a pill that is nobody's fires at it there; the heir's own never does).

Over both corpora (`docs/corpus_runs/1ad64ff-target.txt`, `1ad64ff-target-mystery.txt`, `0bc38f7-base.txt`, `0bc38f7-base-mystery.txt`): with that slot present, 747 live-heir quits and 55 leaves, 7,806 fires, 507,479 ticks of exposure, **0** fires at an heir, and heirs refuelling at inherited bases in 67 of the quits. With a departed *former ally* merely left in the alliance word, 31 quits: five exposed the heir for 1,940 ticks in all, 0 fires at him, so a departed player in the word does not disturb the hand-over. With a standing *request* naming a departed slot below the heir: two quits in 1,030 logs, the first replay above, which failed, and one with no exposure at all.

So the hand-over rule stands as implemented for every ordinary case, and the one shape it may get wrong -- a quit made while the quitter's request still names a player who has left, which happens because the player list goes on showing him -- rests on a single case; the fire rule's self-correction repairs it after the first shot, and playback is left as it is. Which member of an alliance holds a handed pill is invisible in the log until members quit, so the second replay's alternative reading, the leave having handed to a member other than the lowest-index one, could not be separated from the request reading. Two mystery-corpus quirks noted in passing: allied-sender fires there are 11 (2 on the 443 corpus), 7 of them the first replay, and the fire rule triggers 8 times, all in those two replays.

The dead-heir reading had run one way only: fires at an ally who was dead or tankless at the quit said the pills were not his, but nothing had counted the times his live tank later sat within a shell's flight of those pills unshot, which is what the pills being his after all would look like. `measure-pill-target.cjs` now follows that ally by name and keeps, per handed pill, the unbroken run of ticks in which his live, unhidden tank is the nearest tank to that live pill and within its range, restarting the run whenever the pill shoots anyone, since its delay restarts.

How long such a run can go unshot is not the rested delay of 100 ticks: a rested pill's first shot at a newcomer takes longer, so the tool calibrates on the lowest live enemy at every quit, followed under the same measure, reading his run off at each shot at him (`docs/corpus_runs/41c07e3-target.txt`, 1,030 logs): 2,607 shots, median 10 ticks (angry pills), 90th percentile 104, 99th 146, 99.9th 281, longest 644, with 8 over 200 and 2 over 300, a tail that stale positions would make.

Of 116 quits whose lowest remaining ally had no live tank, the ally held a live tank again in 32 and brought it within range of a live handed pill in 7. Three of the seven were shot, and they account for all 40 fires ever counted at a dead heir: in each the ally's tank carried the dead bit at the quit, no other ally was live, and the pill waited 158, 196 and 284 ticks of him as its nearest target before the first shot, the rested pill's latency seen in the control's tail.

Of the four not shot, one is the other case entirely, another ally live at the quit: there the passed-over ally sat 1,023 unbroken ticks as the nearest tank in range of a pill that fired 61 times at every enemy present, longer than any of the 2,607 shots at an enemy waited, so the pill held him friendly: with the lowest ally dead the property does go to the next live ally, as playback assumes (the earlier two such quits had no exposure).

Two had an ally the tool called stale rather than dead, a tank not dead but unheard of for over 5 s, unshot over runs of 313 and 147 ticks; the 313 is longer than any of the three shot cases waited but well inside the control's tail, and since the game apparently counted those tanks live and handed to them, the tool's 116 overstates the dead heirs: 56 carried the dead bit, 60 were merely stale.

That leaves one dead, passed-over ally unshot: 255 ticks as the nearest tank in range of a single pill that fired 33 times at others outside that run. That is shorter than the 284 ticks one of the three shot cases waited, so it is a pill that had not yet fired, not one that held him friendly.

Two-sided, then: of four dead allies whose tanks came back within range of the handed pills, three were shot and the fourth was not given longer than a hostile pill has been seen to wait. The reading stands, on four quits; the viewer's test (`has_live_tank`, the dead and dying bits with no staleness clause) matches the split and needs no change.

Unlike the index fault, the dead-heir hand-over changed the game: the orphaned pills were hostile to everyone until killed and re-planted. Playback reproduces it, because the corpus shows it happening; a disconnect presumably behaves the same, since the log records both as a quit. A dead player is still a member of the alliance, and the manual promises the alliance keeps the property, so this looks like Bolo searching its live tanks for an heir rather than its players.

### [E:pill-fire-index] — the direction-0 index fault

The pill index in an `F4` is wrong often enough to matter to anyone auditing it, and only when the direction nibble reads 0. The mechanism is known, and two independent corpus measurements confirm it, one of them by three tests any counterexample would falsify. Run over the 443-log corpus at the tool's own commit, archived as `docs/corpus_runs/5cca155-index.txt`.

The mechanism: the byte is packed as `(n << 4) | BRAD_TO_PACK(bradian)` with `BRAD_TO_PACK(x) = (x + 8) >> 4`. For bradians 248–255, the eight just west of due north, that is 16 rather than 0, and the carry is ORed into the index nibble: the report is `true_n | 1` at direction 0. It predicts that an even reported index is never wrong, that every wrong index is odd and belongs to a west-of-north shot (the true firer being `n-1`), and that an even index at direction 0 is never a west-of-north shot (an even pill's west shot corrupts to odd).

The first measurement identifies a shot without using its position to find it: take an `F4` from a sender that was simulating no shells at its previous restatement, whose next restatement carries exactly one, with nothing in between that could spawn another. That shell is the pill's by elimination. Then ask which pill it sits on:

| direction | n | on the named pill | on pill `n-1` | neither |
|---|---|---|---|---|
| 1–15 | 6,106–7,393 each | 98.0–99.2% | 0.7–1.7% | 0.1–0.3% |
| **0** | **6,753** | **76.1%** | **23.7%** | 0.2% |

The 0.7–1.7% on the other rows is the method's own noise floor (adjacent pillboxes both inside the matching threshold), so direction 0 misfires at roughly twenty times the background rate. An earlier run split the rate by log, year and slot: across the 372 logs carrying at least five identifiable north shots the median was 20% (p25 13%, p75 36%, consistent with binomial noise at 5–50 shots per log), 22–27% for every year from 2001 to 2005 and 23–25% for every player slot, so it is what Bolo 0.99.7 does and not one bad build.

The same events, split by the parity of the named index and by which side of due north the shell left the pill on (east, west, or too near vertical to call):

| named index | shots | on the named pill (E / W / near) | on pill `n-1` (E / W / near) | neither |
|---|---|---|---|---|
| even | 1,662 | 600 / 0 / 1,050 | 6 / 0 / 4 | 2 |
| odd | 5,091 | 596 / 1,099 / 1,791 | 23 / 958 / 612 | 12 |

All three predictions hold. Even-index errors: 10 of 1,662 (0.6%), the noise floor, and not one of them a west-side shot. West-side even-index shots: **0**, against 2,057 west-side shots among the odd indices, so an even pill's westward shots are all reported under the odd index above it, exactly as the carry says. East-side on-lower cases: 23 of 1,616, again the noise floor. On the affected population the fault is about a coin toss: 958 of 2,057 west-side odd-index shots (47%) name the pill above, which is why the aggregate direction-0 rate lands near a quarter rather than a half.

A third sighting comes free from [E:pill-target]: on the sample log, every `F4` that names a pill allied to its own sender (27 of 13,075) is a direction-0 fire with an odd index, the named pill 190–725 px from the sender's tank and the pill below hostile and within range. No even index, and no other direction, ever does this.

The second measurement needs no shells at all. A pill inside a tank cannot fire, so an `F4` naming a carried pill is impossible on its face. There are 2,123 of them in the corpus, **every one at direction 0** (3.0% of the 69,929 direction-0 fires, 0 of the 1.09 million at every other direction), and in **all 2,123** the pill one index lower was on the ground and available to be the real firer.

The consequences are confined to which pill a viewer credits with a shot: no terrain, armour, ownership or position depends on the field, and pickups (`FF 0n`) and damage (`9n`) carry their own indices and are unaffected. The viewer applies the parity rule (`viewer/game.js`, the `pillbox_fires` handling): an odd index at direction 0 gets `n-1` as an alternate origin, an even one does not. `node tools/measure-pill-fire-index.cjs`.

It survived twenty years unnoticed because nothing depends on it: which pillbox is credited with a shot changes no game state, the shell is restated in the shell lists regardless, damage arrives as `9n` and capture at pickup, both carrying their own indices. The worst it can cost a viewer is a muzzle flash on the wrong pillbox.

### [E:massaging] — a touching tank makes a pill fire along the tank's facing

The well-known Bolo bug: a tank against a hostile pillbox, creeping along its edge, makes the pill fire in the tank's own facing direction instead of at the tank. Measured by `tools/measure-pill-target.cjs`: over the corpus, of 1,156,489 fires at the sender's tank, the tank is within 24 px of the pill in 14,790, and in 5,767 of those (39.0%) the fire direction equals the tank's facing, against 76,031 of 1,141,699 (6.7%, the 1-in-16 chance rate) when the tank is further off; the sample log alone reads 189 of 323 (58.5%) against 6.2%. Among the contested fires whose nibble points at neither tank, 1,022 of 8,672 are touching fires along the facing. A consumer matching pill shells to fire events should not assume the direction nibble points at the target when the target is touching the pill.

### [E:pill-capture] — pickup captures; repair never does

A dead pill picked up, dumped by the captor's dying tank, and repaired in place by the captor's ally then fired on its former owner's team. That repairs never change ownership: a full repair of a dead enemy pill left it firing at the repairer's own team.

### [E:superboom-pill] — superboom pill damage is 4; a single crater does none; a plant is at full armour

The superboom's damage to a pillbox is eventless, so the figure has to be recovered rather than read. **It is 4**, confirmed directly in an emulator: superboom a pill at full armour and it takes eleven further shells to kill, each shell being 1 damage.

The corpus agrees, and did so before the emulator was tried. Pill armour is reconstructible from events (`F1 02` for the starting value, -1 per `9n`, +4/+8/+12 or full per `FF 1n`-`4n`), and the log then contradicts itself if the damage figure is wrong, in two opposite directions: a **pickup** of a pill we still credit with armour means the figure is too small, and a pill **firing** while we think it dead means it is too large. Sweeping the value over 3,038 constraint events in intervals containing a superboom and no single crater:

| damage | impossible pickups | impossible fires | total |
|---|---|---|---|
| 0–3 | 55 | 15 | 70 |
| **4** | **0** | **31** | **31** |
| 5 | 0 | 176 | 176 |
| 6 | 0 | 318 | 318 |

The pickup side collapses to zero at exactly 4 — a hard lower bound — and the firing side then rises 5.7x between 4 and 5 and climbs from there. At 4 the residual is 1.0%, level with the reconstruction's 0.7% noise floor; at 5 it is eight times that. This is worth stating because the older evidence here — one pill superboomed at armour 8 and picked up after only four `9n`s — established only that the blast did *at least* 4, and WinBolo's `TK_DAMAGE` is 5, so the two plausible values had never been separated. They are separated now, and Bolo is not WinBolo.

Two neighbouring quantities fall out of the same sweep. A **single crater** `7 3` on a pill's square does **no** damage: across 2,039 constraint events no pickup anywhere in the corpus requires it to have done anything, and the firing side is minimised at zero — matching WinBolo, whose small explosion never touches pills. Note what that population can be, though. A `7 3` on a pill square is a dying tank's terminal crater, and a tank cannot die on a live pillbox because a live one blocks it; only a dead pill lies flat enough to drive over, which is how one is collected in the first place. So every case in the corpus is a pill already at armour 0, and what is shown is that the crater leaves a dead pill undisturbed. Whether a single crater would damage a **live** pill is not decidable from logs, because the situation cannot arise in one.

And a **planted pill comes up at full armour**: swept as a nuisance parameter over the 1,198,455 constraint events in blast-free intervals, contradictions fall monotonically from 494,111 at armour 0 to 8,437 at 15. That last figure is the noise floor of the whole method, and about two thirds of it is cross-sender ordering — a pill's last shot logged by its simulator a fraction after the killing hit was logged by the shooter — rather than any error in the arithmetic. `node tools/measure-pill-damage.cjs`.

### [E:crater-pill] — a grounded pillbox spares the ground beneath it from every crater path

**confirmed directly in an emulator**: a dead pillbox protects the ground beneath it from a superboom. The corpus reached the same answer first, and covers the cases the emulator test does not, so the measurement is kept below.

It uses the same flood read-out as [E:crater-water], applied to pillbox squares. On the corrected dump model ([E:dump-terrain]) the corpus has 2,445 crater events landing on a square holding a grounded pill; 37 of those squares have an orthogonal water neighbour (2 with evented pill positions, 35 modelled), so whether the ground changed can be read back from whether it floods. Against the same event on bare ground:

| square | kind | n | flooded within 3 s |
|---|---|---|---|
| no pill, mined | `7 3` | 278 | 277 (100%) |
| no pill, plain | `7 3` | 302 | 299 (99%) |
| no pill, plain | `7D` | 92 | 89 (97%) |
| **dead pill, mined** | `7 3` | 8 | **0** |
| **dead pill, plain** | `7 3` | 24 | **0** |
| **dead pill, plain** | `7D` | 4 | **0** |
| **live pill, plain** | `7D` | 1 | **0** |

Median flood delay is 0.56–0.58 s throughout, the [E:crater-water] figure. The dead-pill rows are what the emulator run confirms. The live-pill row is a single observation — but nothing points the other way. That case did not flood either, WinBolo's `pillsExistPos` returns true for any grounded pill whatever its armour, and the sparing happens in the cratering step, which asks only whether a pill occupies the square; armour enters one step later, in the damage. A live pill is expected to behave exactly as a dead one here, and one emulator shot would put it beyond doubt.

One `7D` in the corpus (md5 `42977edf2c2630e2cabb1ca43a1b214d`, at 25:23.66, origin 127,135) demonstrates every part of the rule at once, which is worth having in one place:

| square | terrain | occupant |
|---|---|---|
| 127,135 | grass → grass | live pill, armour 9 → 5 |
| 128,135 | grass → grass | dead pill, armour 0 |
| 127,136 | river → river | — |
| 128,136 | grass → **river** | — |

The bare square craters and floods; the water square is untouched; both pill squares keep their grass while the live pill takes its 4 eventless damage in the same event — the damage of [E:superboom-pill] and the cratering coming apart in a single boom. The dead pill's square is orthogonally adjacent to the one that just flooded, so had it cratered the flood would have chained into it; it stayed grass. This is also the only live-pill observation in the corpus, which is why that row is n=1.

Waiting for the pill to be picked up rescues none of the null cases: in a separate pass each square was followed to the end of its log (the tool checks only the 3 s window), and the only late floods — 198 s, 556 s, 2,556 s — arrive 0.5–0.7 s after a *fresh* crater on that square once the pill had gone, the ordinary rule rather than a deferred one. This is what corrects the older claim that a `7D` craters beneath a pillbox; the eventless damage of [E:superboom-pill] is untouched, since both readings damage the pill and only the ground distinguishes them.

The **mined** row was unresolved until the dump model was corrected, and its resolution vindicates both measurements at once. On the old, water-refusing model the row read 13 cases with 5 floods (38%), and the floods were suspected phantoms: near-water dumps were exactly where that model would diverge, and two of the five carried proof the pill was not there at all — a man later built a **boat** on the square while the model still showed a pill on it, which Bolo forbids.

On the corrected model ([E:dump-terrain]) the row reads **8 cases, 0 floods**: the five "floods" were exactly the five misplaced pills, gone along with their squares, and the impossible builds vanished with them — **0 of 96,333** build events corpus-wide now land on a believed-pill square (0 of 28,721 evented placements, 0 of 5,667 modelled death dumps, 0 of 454 others; previously 3 of 97,139, two of them in this very set). So the alternative reading — that a mine detonating under a pill craters regardless, indistinguishable in the log since both arrive as a bare `7 3` — is refuted rather than merely unseparated: a pillbox spares the ground beneath it from every crater path, mined squares included, and playback's spare-in-every-case rule is measured rather than assumed. `node tools/measure-crater-pill.cjs`.

## Tanks, death and dumps

### [E:gameplay] — the measured numbers behind GAMEPLAY.md

The numbers in GAMEPLAY.md tagged *measured* come from `tools/measure-gameplay.cjs`, first over the two fixture logs and a third 7-minute replay (`docs/corpus_runs/d8d7483-gameplay.txt`) and then over the 443-log corpus (`docs/corpus_runs/0c4e116-gameplay.txt`, 13.3 million records, 11,682 minutes); the corpus figures are quoted here. Timings read from restatements are quantised to the sender's record cadence, which is why cadence-bound medians (reload, refuel spacing) sit a tick or two above the fine-cadence value, and the turn intervals round up on coarse logs.

**Tank armour 9** — replaying each life at 9, −1 per `FC` hit, +1 per `Dn` capped at 9, puts 12,375 of 15,443 shell deaths at exactly 0, where 8 gives −1 and 10 leaves 1; the −1 and −2 tail (1,835) matches hits logged twice within 2 ticks by two senders (2,125 corpus-wide), and the 1,136 with armour left are the size mine damage would leave; the 775 drownings (`F9` code 3) carry 0–8 hits.

**Speed byte = pixels per tick × 64** — byte 64 moves 1.00 px/tick, 48 moves 0.75, 24 moves 0.375; terrain medians road 57, boat 62, grass 48, forest 24, river 12, swamp 13, the owner's 16:12:6:3 exactly.

**Hidden** — the nearest non-forest square is at least 9 px (Chebyshev) from the tank centre in 319,754 of 320,198 hidden restatements, and at 1–8 px in 288,719 of 288,775 shown ones with their centre in forest.

**Turning** — the interval between successive direction-nibble changes while the turn bit, the terrain and the speed class hold (base squares as road): on the fine-cadence fixtures 8 ticks per sixteenth on road, grass and boat and 16 in forest; corpus medians road, grass and boat 11 (p25 8, the cadence rounding up), forest 16–17, crater 20–26, rubble 16–25, swamp 25, river 23–28. A first pass that read rough terrain as fast was tanks sitting on bases whose map terrain is crater.

**Reload** — corpus gaps mode 12–13 ticks, p5 7, floor 5–6, with 17,857 records carrying two shots and 444 three or four; the fine fixture alone reads mode 12–14 with 7% at 7–10.

**Pill anger** — fires within 5 s of a hit come every 7 ticks (p25 0, several per record); by time since the last hit, 5–15 s → 20, 15–30 s → 38, 30–60 s → 66, 60–120 s → 100, beyond → 100. The `F1 02` speed byte reads 100 in 1,107,542 fires and 18–98 in 61,000, logs that started while pills were angry, so the byte is the live delay; 255 occurs 1,116 times, unexplained.

**Refuel** — shells every 9 ticks (p25 7), mines 8 (p25 6), armour 54 (p25 51); 15,529 of 1,276,168 drains within 20 ticks of a different resource; empty to full ≈ 1,050 ticks.

**Man** — 1.0 px/tick on road and grass, 0.46 in forest, 0.25 on crater, rubble and swamp; dwell before the event, medians: boat 8, plant pill 9, repairs 9, building 10, mine 11, harvest 14, road 25 ticks.

**Parachute** — 6,507 runs: the start is a square of the `F1 04` list in 6,505, the nearest start to the landing in 397 (6%, below the 12.5% chance level), median 4,302 ticks (86 s), max 19,693, drift 0.12 px/tick, landing a median 6 px from the tank's position at the death; WinBolo draws a random start and aims at that position.

**Regrowth** — 60,905 events: grass 60,009, road 840, crater 41, swamp 10, rubble 4; 60,764 with at least one forest neighbour, the mode four; senders in proportion to presence; 0.76 per forest-touching grass square per player-hour, 0.14 per grass square.

### [E:mine-damage] — a mine takes 3 armour, floored, and a tank at 2 or 1 is lost

A mine takes 3 armour off a tank, floored at 0, and a tank on its last 2 points (1 or 0 display bars) is lost outright; owner's emulator tests at 8, 3, 2, 1 and 0 bars, giving 5, 0, 0, lost and lost. `tools/measure-mine-damage.cjs` over the 443-log corpus (`docs/corpus_runs/af89fbf-mine-damage.txt`) had already drawn the same shape: of 7,348 explosions on squares the model held mined, 1,024 had a tank centred on the square, 504 of those tanks were lost within a second and 517 drove on. Integrating each life's armour (9, −1 per hit, +1 per drain) and sweeping a fixed damage, 3 put the most mine-involved deaths at exactly 0 (267, against 238 for 2 and 70 for 4) but left 23 survivors it should have killed — and those 23 sit at integrated armour 3 (22) and 2 (1), which is precisely the floor the emulator shows.

The fatal side is confounded, as the owner expected: a tank can set off two mines at once and can be under fire at the same time, so 392 mine-involved deaths end above 0 under a single subtraction, and the fatal histogram runs all the way to armour 9. The survivors are the clean side, and none survived from armour 1 or 2 bar the one case the corpus's duplicated hits ([E:gameplay]) would produce. WinBolo's mine does 2 with no floor, its one constant so far that Bolo does not share.

A second run (`docs/corpus_runs/77c6c22-mine-damage.txt`) read the loss directly, with no model of the mine: for a tank that drove on from its single mine and later fell to shells, the mine took armour-before + drains-after − hits-after. By the armour the tank had: at 5, all 13 readings say 3; at 6 to 9 the mode is 3 in every row (18 of 31, 15 of 33, 11 of 22, 19 of 45); at 4, 10 of 12 say 3 and at 3, 10 of 12 say 2 — both "left at 1", the floor.

The secondary peaks are runs of mines the attribution credited as one, and they carry the floor too: 6 at armour 7–9 (two mines), 5 at armour 6 (6 → 3 → 1) and 8 at armour 9 (9 → 6 → 3 → 1); a plain 3 per mine without the floor would give 6 and 9 there. The clean losses — one mine, no shell hit within 2 s, no other mined-square explosion nearby — sat 45 at armour 1–2 and 28 above, the latter mostly runs the first filter's before-the-hit window missed (a tank at 5 lost 0.06 s after the hit is two mines at once); the tool now looks for other mines up to the loss.

Three survivors' readings of a loss of 0 are the size of the one open question: what a mine set off by a shell does to a tank standing on it. The tool's attribution (tank centre on the square within a second) does not separate that case from a tank rolling onto the mine.

### [E:ammo-clamp] — shells and mines cap at 40

Reconstructing tank ammo across 12,583 lives that begin at an observed respawn (see [E:death-tiers]), every out-of-range excursion is an overflow past Brain.h's cap of 40 and not one is a negative. Charging drains into a full tank drops the violation rate from 5.7% to 1.2%; the residual is slightly-too-many shots seen, the method's noise floor. `node tools/measure-death-ammo.cjs`.

### [E:respawn-gap] — respawn 5.0–6.8 s after death

Measured gaps are 5.0–6.8 s (median 6.0).

### [E:death-tiers] — the terminal explosion is gated on ammo aboard

Across 14,365 deaths the tiers split ~7% superboom, ~64% single crater, ~29% no explosion. That the crater-less deaths really have no crater, rather than an unlogged one, is verified via flooding: crater flooding is evented and fast, and of 206 crater-less deaths ending beside water, none flooded.

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

### [E:superboom-cargo] — the second explosion is the cargo

1,010 of 1,136 four-square superbooms occur mid-death-sequence, ~0.9 s after the initial `F9`. For what determines whether one happens at all, see [E:death-tiers].

### [E:forest-circle] — a dying tank's forest clearance is a 15×15 box, pill-masked

Manual observation of original Bolo in an emulator shows a wreck moving in a cardinal direction can remove trees in two adjacent rows, which a centre-only trail cannot reproduce.

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

A second corpus of 587 logs (14,416 dying sequences) reproduces the table's shape -- box 7 pill-masked at 0 delayed contradictions, 2 hidden-tank hits and 0 plants -- and put two growth events in the regrown column that no rule removes, box 8 and the full footprint included, so they were never about clearance geometry. Both are in the first ninety seconds of their logs, before the first base capture: one a `65` on a square the recorder's own map transfer had delivered as forest, sent by a player thirty seconds into the log; the other a second `65` on a square another player had grown fifty seconds earlier, sent by a player who had joined in between and whose map copy evidently still had it as grass.

During the gathering phase the peers' map copies are still being reconciled, and a machine whose copy lacks a tree the recorder's copy has will grow one; the same phase the loss measurement has to trim for the same reason ([E:seq-loss]). The tool now counts the regrown column from the first base capture on and puts earlier ones in a `gathering` column of their own, listed under `--samples` with the square's last event: on the 443-log corpus nothing moves (0 in the gathering column for every rule), and on the second corpus the two are the whole of that column and box 7 reads zero again.

The pill exception rests on unusually specific evidence: all nine later LGM farming events on cleared forest occur exactly on pill dump squares, as do all five delayed repeat-clear explosions and five of the seven hidden-tank conflicts. Applying it is what takes the delayed contradictions from 14 to zero and the hidden-tank conflicts from 7 to 2, at a cost of 37 clearances. The exemption is not arbitrary: a pillbox shields the ground it stands on without replacing it, which is also why the terrain beneath one must be preserved rather than overwritten (see [E:base-road], where a base differs precisely in that respect). Reproduce with `node tools/measure-tree-clearance.cjs`.

Earlier rounds carried a further under-clearing column, counting shells seen inside modelled forest on the reasoning that forest stops shells. It has been withdrawn: it read a shell's position without centring it (see [E:shell-centre]), and the "phantom tree" population it appeared to find was an off-by-half-a-tile. Nothing above depended on it.

The rule as playback applies it: for a terrain square, let `dx` and `dy` be the horizontal and vertical distances from the tank-centre pixel to the square's nearest pixel, and fell its forest when `dx <= 7 && dy <= 7`. The `(7,7)` diagonal is cleared along with everything closer, while axial distance 8 is not: two integer comparisons, no multiplication, no square root — which is also what the corpus says. A grounded pillbox masks the terrain beneath it: if the box touches a pill-occupied forest square, leave the forest alone. Later sliding wreck and flame positions use the same clearance as the first. The pill exemption does not apply to explicit terrain changes in general — but craters are masked by a pillbox in their own right ([E:crater-pill]), so an evented `7D` superboom damages a pillbox without cratering the ground beneath it. The evented terminal cratering (`7T`/`7D`, see [E:death-tiers]) is otherwise separate from this clearance rule and unaffected.

### [E:dump-terrain] — what a death dump accepts

A serpentine-dumped pill's true square shows up at its next pickup: the `FF 0n` names the pill outright, and the picking tank's centre square ([E:centre-square]) rides the same record. That the restated tile is not a tile stale — a pickup mid-interval restated by a tank already past the square — is not assumed but measured, because pickups of **evented**-position pills (initial list, `FF 50` plant, `FF 51` LGM dump) have known squares and calibrate the method for free: across both logs the restated tank tile equals the known pill tile in **415 of 415** such pickups, so the record is evidently emitted on the simulation tick of the pickup itself. (The LGM position riding the same record is, by the same test, stale noise — exact in 3 of 35, off by up to 45 tiles — so it is not used at all.)

Matching the tank square against the serpentine path from the death square gives the path position the pill really occupied, model-independently — every earlier unoccupied square was *skipped* by the real game, the observed one *accepted*. Over the sample log and a 2002 replay (md5 `05802109fccca307403b7d42a4da8f62`), 60 of 62 dumped pills resolve to an exact path square (2 never picked up), the resolved positions are strictly increasing in pill-index order at every multi-pill dump — 0 violations, confirming lowest-index-first placement along a single never-backtracking search — and **no terrain was ever skipped**: all 5 skips were squares occupied by a pill or base. Terrain accepted: grass 24, road 29, rubble 4, **river 3**.

The river cases are the decisive ones, since the model had been refusing water. In the 2002 replay a tank died fording (death square 102,124, mid-river) carrying pills 0 and 6; they landed on the death square itself and the square north of it — the first two path positions, both river. The collector's tank centre entered each square exactly at the record carrying its pickup, and under the water-refusing predicate those two were the only pickups of the log's 153 to miss their modelled square, both pills having slid two path positions into the forest; the sample log carries the same signature in miniature, its one river-death dump being its only off-square pickup of 322. With river accepted, all 475 pickups across the two logs land exactly on their modelled square.

The corpus run settles the rest. Over 443 logs: control 29,573 exact against 15 off-by-one (0.05%, the method's noise floor); 4,024 serpentine dumps of 6,121 pills, 5,536 resolved to exact path squares, and **0 order violations**.

213 resolutions land on squares whose terrain changed *within the dump record itself* and are quarantined rather than tallied — 188 of them forest felled to grass by the dying tank's own clearance ([E:forest-circle]), the other 25 craterings and shot buildings from the death explosions. An earlier pass without the quarantine showed 4 rests on "building", and all 4 were of this kind (three cratered in the dump record, one shot), not holes in the predicate — as the geometry already insisted, since the observation is a tank centre tile, which cannot lie in standing building terrain.

What remains is entirely clean. The terrains observed skipped are exactly the impassable set — **building 20, shot building 28, boat 2** — and nothing else, ever. Everything else is accepted, with counts: road 2,924, grass 1,755, crater 223, rubble 151, forest 90, **deep sea 60**, mined road 42, river 31, mined grass 24, swamp 12, mined crater 7, mined forest 2, mined swamp 1, mined rubble 1. Deep sea's 60 rests against 0 skips also rule out a river-over-deep-sea preference: a search reaching water takes it at once. `node tools/measure-dump-terrain.cjs`.

### [E:man-carrying] — a man out with a pill keeps it through his tank's death

A man out of the tank carrying a pill (status `C`) has it in his hands, and the tank's death dump does not include it; it is the lowest-index carried pill, the one a plant would use. The evidence is the plants that would otherwise be impossible: on the fixture, every `FF 50` the dump model had to treat as a no-op (planting a pill it already had on the ground) followed a tank death with the man out carrying, and the man went on to plant exactly that pill. Modelled in `viewer/game.js` `dump_carried_pills`, which withholds the lowest-index carried pill when the sender's man is out with one.

### [E:pill-pickup-logged] — every planted pill was picked up on the record

Osterwald's notes describe a tank driving over a dead pill with no pickup logged and later planting it, "but there is no way to determine which one because it isn't carrying any pills". The corpus has no such case. `node tools/measure-pill-plant-carry.cjs` (`docs/corpus_runs/4cd75a4-pill-carry.txt`) runs the viewer's own carry model -- the `F1 02` carried-at-start sentinels, the death and quit dumps, the man-out-carrying exception above -- over the 443 logs: 28,132 plants, 35,136 pickups, and zero plants by a player the model holds as carrying nothing. The model is checked against every pickup on the way, since a missed pickup would leave a later one on a square the model does not expect: the picker's tank centre is on the model's square for the pill in 35,108 of the 35,136 pickups, on an adjacent square in 15 (a tank that moved on between its restatement and the pickup), never further, and 13 pickups are of a pill the model holds as carried, the netsplit and quit edge cases. What Osterwald saw was most likely a pill in the man's hands, or a pill carried when logging started, which the `F1 02` list marks with armour `0xFF` and which no pickup ever precedes.

### [E:dump-mine] — a pill dumped onto a mine clears it

Emulator-observed: a dead pill dumped onto a mined square arrives with the mine's explosion sound and the mine gone, but no crater; the terrain under the mine is unchanged. Modelled in `viewer/game.js` `dump_carried_pills`, which demines every square a dumped pill lands on.

### [E:quit-pills] — a quitter's carried pills drop around his last position

In two mid-game quits-while-carrying, the pills were later picked up within a tile of the quitter's last tank centre; in one case both at once, lying together.

## Terrain

### [E:mine-persists] — a mine survives a terrain change

Observed in playback and confirmed twice over by the game itself: a square where forest had grown back over mined grass exploded later, though the viewer had been showing clean forest since the `6 5` arrived, and players could be seen steering around the square while nothing was drawn there to avoid. Both tells say the mine was still present and that every client knew it.

The corpus explains why the event cannot say so. Across 13.4 million records the codes a `6T` actually carries are grass (102,302), forest (61,268), building (14,852), road (13,299), boat (7,720), river (1,479) and shot building (1). **No mined code is ever sent.**

One record appears to break that and does not survive inspection: an empty `FA` message followed by three stray bytes parsing as `6 F` at 230,209, a deep-sea square at the far edge of the map with the fighting twenty tiles away, and in the wrong subpacket order besides, since messages come last. The lengths happen to add up, so the parser raises nothing, but it is not an event.

So `T` is the base terrain by convention rather than by accident, and the mine is simply left implicit. Forest growing over a mine is the case that catches a viewer out, 48 times in the corpus, and it is the only one this project applies: `viewer/game.js` rewrites mined grass + `6 5` to mined forest and leaves every other terrain change as sent. Generalising further would be guesswork in the wrong direction, because some changes onto a mined square plausibly clear the mine rather than preserve it — a mine detonating leaves a crater, and WinBolo's LGM road build on a mined square signals a mine explosion as it lays the road. Nothing in the corpus separates those cases, so they are left alone.

This is not a Bolo bug and does not belong in that section: the clients agreed with each other about what the square held, and the game played on correctly. It is a piece of state the log declines to restate, like the boat consumed in [E:boat].

### [E:crater-water] — a crater on open water is a no-op; a boat craters and floods

In the sample log every crater-making event was classified by the terrain under it and checked for a following flood. Craters the game really made beside water flooded 5 of 5, always as an explicit `6 1` 25–37 ticks later; the 4 that landed on a **boat** square flooded 4 of 4 the same way. The 12 single `7 3`s that landed on river or deep sea flooded 0 of 12 — and all 12 are terminal death craters, arriving 0.74–1.50 s after the dying player's own `F9`, never in any other context. Three of those squares later receive a `6T` **boat** event, which requires river underneath: had the crater applied, a man there would have built a road instead. All 9 floods in the log are accounted for by the two flooding rows, so nothing floods silently. WinBolo agrees and supplies the mechanism: its small tank explosion craters only `if (currentPos != RIVER && currentPos != DEEP_SEA)` and then queues a flood check (`tankexp.c`), its big explosion excludes `BOAT` as well (matching `7D`'s water sparing), and `floodCheckFill` fills on any orthogonal `RIVER`/`BOAT`/`DEEP_SEA` after `FLOOD_FILL_WAIT`, chaining into neighbouring craters (`floodfill.c`).

For playback the consequence is that a `7 3` on river or deep sea must be dropped: applied literally, a crater appears mid-river and, nothing being left to flood it back, stays there for the rest of the replay. The terminal crater of a dying tank is sent whatever lies under the wreck, so the case is routine rather than rare.

### [E:boat] — boarding consumes the boat with no event

All 38 sample boardings sit on terrain 9, none has a terrain event.

### [E:base-road] — a base's square behaves as road

From gameplay knowledge, and corroborated by shells. A shell cannot be inside a standing tree, so any shell restated inside a tile the model calls forest marks a square the model has wrong. Taking only frames at least 2 px inside their tile — deep enough that boundary rounding cannot explain them — gives 2,341 across the corpus, and they divide up completely:

| what is on that tile | frames | |
|---|---|---|
| a base | 2009 | 85.8% |
| the tile is felled within 1.5 s (an ordinary hit) | 207 | 8.8% |
| a grounded pillbox | 97 | 4.1% |
| a muzzle frame, fired that same record | 28 | 1.2% |

Bases account for six sevenths of it. The last 1.2% is not noise but the muzzle case of [E:muzzle], so every frame in the table is accounted for and nothing is left over.

The original engine does **not** rewrite base squares: it keeps the map's real terrain, which the base sprite hides anyway. A player need not preserve that implementation detail, because base occupancy overrides the value for every gameplay purpose. Rewriting or mutating it changes nothing in the clearance sweep except ~45 fewer squares counted as "cleared", which were never gameplay forest to begin with — so the figures in [E:forest-circle] hold either way.

The 97 pillbox frames are **not** the same phenomenon. A pillbox does not alter the ground it stands on, and it can be captured and carried away, at which point that ground matters again — so unlike a base's, the terrain under a pill has to be kept *and* consulted. Those frames are explained by the pillbox itself: the shell is being absorbed as `9n` damage, or is one of the pass-throughs in [E:shell-passthrough]. Neither says anything about the ground beneath.

Across the corpus the transferred map carries real terrain under every base — 33% crater, 33% road, 19% mined crater, 10% grass and 5% forest — and the game consults none of it: shells fly over, there is no tree to fell and no mine to strike. Playback may preserve the underlying value or rewrite it as road (and eventless terrain logic may mutate it): none of those choices affects gameplay while the base occupies the square.

## Bases, ownership and alliances

### [E:base-tick] — every player's tick increments every base

Under the every-player-increments-every-base model, none of a sample log's 16,801 base-drain events comes from an empty base (stocks touch zero exactly 13 times). Under the owner's-bases-only alternative, 6,112 drains would be impossible.

### [E:base-capture] — capture at armour ≤ 9, drain cost 5, capture zeroes stocks

Three rules recovered together, because each alone left the others' evidence unexplained. Under the old model (armour −5 per `An`, −1 per `Dn`, +1 per player tick, unchanged by capture) the two fixture logs showed 252 captures of a *hostile* base at model armour spread evenly from 0 to 88, with over 100 above 30, while every neutral capture sat at 90 and, in both logs, every record whose tank centre sat on a hostile base square was a capture record — a tank is never on a hostile base without taking it.

Reading the high-armour cases showed they were recaptures within a minute of a previous capture with no shooting in between: the "armour" was the stock ticks counting up from the old value. WinBolo's `bases.c` names the mechanism (`basesSetOwner` zeroes armour, shells and mines when a base changes hands from an owner) and two constants: `MIN_ARMOUR_CAPTURE 9` (a hostile base is capturable at armour ≤ 9) and `BASE_ARMOUR_GIVE 5` (an armour refuel costs the base 5).

Scored on the fixtures: with the reset alone (drain cost 1) 41 hostile captures still sit above 9; with the reset and drain cost 5, all 253 hostile captures in the three logs land at 0–9, 68 of them at 5–9, so the threshold is 9 rather than 0.

The shell-blocking threshold is independent of this: hits on bases are logged at every model armour from 5 to 90 and never at 1–4, though bases sit at 1–4 after ticks — a base under 5 armour lets shells over (WinBolo `BASE_MIN_CAN_HIT 4`). Residuals: 33 of 1,565 hits land on a base the corrected model holds at 0–4, 14 of them in the capture's own record.

Over the 443-log corpus the same model puts 11,927 of 11,945 hostile captures at 0–9 (the 18 others include 10 at 90, netsplit ownership noise), 6,973 of 6,975 neutral captures at 90, and 74 of some 150,000 base hits at 0–4; the 90 captures of bases the viewer holds DEPARTED spread over every armour, so for capture the game treats an heirless base as neutral. Whether shells and mines reset too the logs cannot prove, only permit: 204 of 225 owner-to-owner captures are followed by no drain at all within 60 s, and none by more drains than the ticks since the capture could have supplied. `node tools/measure-gameplay.cjs` prints the capture histogram by owner; the diagnosis runs are described in GAMEPLAY.md.

### [E:owner-signals] — ownership belongs to the person, not the slot

Base drains, base captures, live-pill pickups and live-pill repairs, used as ownership police: only a friendly base refuels a tank (the drain rides in the refuelling tank's own record), only a neutral or hostile base can be captured, and a pill must be dead to be picked up (all 35,123 corpus pickups are of dead pills). Repairs are NOT a signal: on the owner's word, repairing a pill — dead or alive — never captures it and is open to anyone; neutral pills are repaired deliberately to deny the enemy a capture, enemy pills by misclick (the corpus holds 175 hostile-pill repairs in 162 log:pill:actor pairs, identical under every ownership model — that denial play and those misclicks, seen in one replay as a player repairing a neutral pill back up while an enemy grinds it down toward capture).

Scored over the corpus, a fully person-keyed model — ownership and alliance links keyed to NAMES, slots only carrying them; a same-name join a reconnect keeping links and property; a new-name join a linkless arrival implicitly quitting the name it displaces; renames carrying both along; a quit severing nothing; a ghost (a quit-flagged slot still transmitting) counting as present — commits zero drain and zero capture violations over 1,276,168 drains and 19,010 captures, where the v1.1.2 keep-the-slot reading fails 1,293 drains and 7 captures (4 of them "capturing his own base") and the pill-style DEPARTED reading fails 2,692 and 3.

On pills the fire signal is the only police, and it shows nothing against the person-keyed reading: one trigger over the corpus (from the alliance continuity of a reconnect), which the fire rule's self-correction absorbs, plus two fires inside the alliance-grace second.

The decisive replays are netsplit storms in which the roster shuffles across slots with some occupant changes carrying no quit event at all; one log also shows two same-name reconnects whose allies go on refuelling at their bases for the rest of the game with no re-accept logged, which is what pins alliance membership as surviving a reconnect (Rejoin restoring it silently), and another shows one person occupying two slots at once, draining "his ghost's" bases from the new one.

The viewer implements the person rules on its slot-keyed state (implicit quit, same-name reconnect, ghost recovery, rename consolidation, in `viewer/game.js`) and scores zero against every signal over the replays that carried all of the corpus's violations. `node tools/measure-base-owner.cjs`, `node tools/measure-pill-owner.cjs`.

Netsplits shuffle players across slots, sometimes with no quit event at all — a classified join simply installs a new name where a live one sat — and afterwards each side's bases go on refuelling exactly the old PERSONS from their new slots, new allies included, while bases taken from a team before a split must be captured back from it after.

### [E:leave-pills] — a leaver's planted pills stay with the alliance

From the Bolo manual, on leaving an alliance: "Any pillboxes he is carrying at the time are his, but any active ones on the map remain with the members of the alliance." Which member inherits is not stated; the viewer assigns them to the lowest-index remaining mutual ally. Bases are not mentioned; ownership works the same for pills and bases (see [E:pill-target]), so the viewer hands the leaver's bases over with the pills.

### [E:alliance-transitive] — an accept admits to the whole alliance

Verified on a 3v3 whose only accepts were A↔B and B↔C on each side.

## The man

### [E:lgm-killers] — what kills a man

What kills a man, read off the two fixture logs (86 deaths: 71 `F5`, 15 `FF 51`). Neither event names a man, and none is needed: every one of the 86 rides in a record that also restates the sender's own LGM position, ahead of the event, with its +8 px centre square on the named square, and no other player's man was ever the nearer. Each machine simulates its own man, so it is the only one with a death to report.

Classifying each death by what the log shows arriving at that position in the 30 ticks before it: 33 are a shell falling (`FB`) within 12 px of him on open ground, with nothing else near; 27 a hit (`9n`) on a pillbox on his square; 7 a shell fall within 12 px while he stood on a pill square, either of which could have taken the shell; 4 an explosion on his square that shot a building or felled his tree; 2 a crater or superboom on or beside his square; and 12 — the residue the first pass could not explain — a tank hit (`FC`) on a tank whose centre sat within 20 px of him, no shell fall anywhere near.

Ten of those twelve are his OWN tank: the man dies beside it the moment it takes a shell, a cycle after climbing out or before climbing back in. The other two are an enemy tank he was standing against when a pillbox shell struck it. The last death, on a base square, follows an `An` hit on that base by one ring cycle.

So a shell kills the man at its terminal point whatever it ends against — open ground, pillbox, building, tree, tank or base — and the death is logged a cycle later by his owner's machine. Not run over the corpus. `node tools/measure-lgm-killers.cjs fixtures --samples`.

## Game info, map transfer and the start-of-log burst

### [E:gameinfo] — the `GAMEINFO` struct

The struct layout and the constants are from `Brain.h`: `enum { GameType_open=1, GameType_tournament, GameType_strict_tment };` and `#define GAMEINFO_HIDDENMINES 0x80` / `#define GAMEINFO_ALLMINES_VISIBLE 0xC0`, with the field declared `BYTE hidden_mines;` and commented as holding one of those two values. The corpus shows only those two values across all 446 logs (`0xc0` in 435, `0x80` in 11, all of the latter in 2001–2002). 442 of 446 logs are strict. Brain.h declares the two `long` fields on a big-endian Mac, but the log stores them little-endian: only 3 corpus logs have a nonzero time limit, and they read as 230–239 minutes little-endian against 0.7–2.5 *years* big-endian. The start delay is zero in all 446 logs, so its endianness is inferred from its neighbour rather than measured.

### [E:history] — the pill/base history groups

That **set** bits mark members is contra the 2003 notes' guess of zero bits. On the naming rule: in one log the string matched the current owner of exactly those bases, in others a player who had left long before (base "memory" outliving ownership); Bolo's own `make_history()` is equally murky. `F1 8n` is never emitted because `log_bootinfo` is flawed, per the 2003 notes.

### [E:mapknown] — the `F3` transfer frontier

Verified exactly on 254/254 runs across four logs.
