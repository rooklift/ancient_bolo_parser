# Endpoint-only shot pairing: how far do creations + terminals alone go?

The interpolation system pairs shots to fates through the full shell
restatement machinery. This experiment asks the opposite question: throw
away every shell list, keep only the shot **creation** events (`5d` tank
fire, `F4` pill fire, each carrying its gross 4-bit direction) and the
shot **terminal** events (`FB` fall, `FC` tank hit, `9n` pill damage,
`An` base damage, shot-attributable `7T` explosion), and pair them on
physics alone. How many pair up, and how trustworthy are the pairings?

`tools/probe-endpoint-pairing.mjs` runs the experiment. It is a
measurement probe, not app code, and shares nothing with the matcher.

## Method

Creations are placed at the firing tank's interpolated track position
(`5d`) or the named pill's centre (`F4`, trying `n−1` too for the
direction-0 index fault [E:pill-fire-index]). Terminals are the exact
`FB` point or a 16 px box (tank hits use the interpolated target track).

Edges are feasibility-tested per kind:

* **Tank shots**: displacement within range, inside the direction cone
  (17° half-angle plus box slack), record-time gap consistent with a
  2 px/tick flight over the *actual* distance (default −20/+60 ticks of
  record-lag slack). No full-range assumption anywhere — tanks adjust
  their range, so only distance-vs-time consistency is safe.
* **Pill shots** are fully discrete: 8 fine bradians per coarse sector,
  known orbits, constant 32-update (64-tick) lifetime. A pill→`FB` edge
  requires the fall point to equal one of the sector's 8 orbit terminal
  pixels *exactly* (raw-coordinate comparison, so the half-tile centring
  convention cancels) after 64 ticks ± lag; a pill→box edge requires
  some sector orbit's shell centre to actually enter the box, at the
  entry step's own flight time. Approximately-placed pills (eventless
  serpentine drops after a tank death) fall back to the cone test.
* **Same-sender FIFO**: the constant lifetime means two pill shots fired
  and simulated on one machine that both fall must fall in fire order.
  Candidate edges crossing a *forced* same-sender pill→fall pair are
  pruned, and the graph re-solved to fixpoint (649 edges in 3 rounds at
  default windows). The mirror argument is deliberately NOT applied to
  tanks: adjustable range breaks fall ordering for them. The constraint
  compares stream order (record and subpacket order within one sender),
  never timestamps, so record-time jitter cannot upset it.

How trustworthy is the 64-tick gate under real network conditions?
`tools/measure-pill-fall-timing.mjs` measures the F4→FB record-time gap
on assumption-free pairs — falls whose exact pixel names exactly one
(pill, sector) story with exactly one F4 candidate in ±300 ticks, no
timing gate applied. On 534 such pairs: median 63 ticks, 89% inside
[60, 72], 99.6% inside [44, 124], and 533/534 have the same sender for
F4 and FB (mid-flight migration really doesn't happen). The spread is
just the record cadence: an event waits for the sender's next outgoing
record (up to ~17 ticks at 4/s), so the gap is 64 ± one record interval
either way, with rare genuine stalls beyond (4 of 534 exceed 80, max
288). The default −20/+60 gate is exactly the 99.6% band.

The graph is then read as a unit-capacity flow problem, and the residual
graph's strongly connected components classify every edge exactly:

* **maximum matching** — how many creations *can* be paired at all;
* **forced pairs** — pairs present in *every* maximum matching;
* **class-determined** — creations matched in every maximum matching
  whose every possible partner across maximum matchings is the same
  *kind* of fate at the same *place* (interchangeable terminal events:
  the same pill hit twice in one interval, etc.).

`--verify` additionally runs the real engine and recovers its
creation→terminal opinions (chain origins and fates, joined by
`match_time`), scoring how often the endpoint pairing agrees.

## Results (fixture `n20021018.2`: 23,680 shots, 24,075 terminals)

Pairability is essentially total; identity is partly recoverable:

* **99.6%** of creations and **97.9%** of terminals participate in a
  maximum matching — the books nearly balance, so almost every shot
  *has* a plausible fate and almost every fate a plausible shot.
* **17.4%** of creations get an exact pair that survives in every
  maximum matching; **37.8%** are class-determined (fate kind + place
  certain even where the specific event record is interchangeable):
  tank shots 47.3%, pill shots 30.1%.
* From the other side, **64.6%** of terminals know their shooter (source
  + direction class) with certainty — endpoint-only shooter attribution.
* Simpler tiers: mutual-best with margin pairs 24.3%, mutually-unique
  7.7%.

Against the full engine's reconstruction (21,345 engine opinions):

* class-determined endpoint pairs agree with the engine **90.7%** of the
  time — and the disagreements are nearly all *same event type, other
  instance* (another 9n on another pill, a stream-mate's fall point):
  the aliasing endpoint data cannot see through;
* mutual-best-with-margin agrees 87.5%;
* a cheapest-edge-first best guess over everything (89.6% paired) agrees
  64.3% on fate kind + place, 44.2% on the exact event.

The discrete pill constraints and FIFO pruning are worth real accuracy
*and* coverage at once (before them: 35.2% determined at 91.2%, mutual
best 18.4% at 82.8%, global guess 60.3%). Window sensitivity: tightening
lag slack to −12/+40 lifts determinacy to **46.6%** (tank 54.5%, pill
40.2%) at 89.1% accuracy and 98.0% coverage; the old −8/+25/13°
extreme reached similar determinacy at worse accuracy (87.2%) by
excluding true partners. The determined tier hovers around 90% correct
wherever the windows sit — the residual errors are stream-mate aliasing,
not window tuning.

## Reading

An angry pillbox fires every 5–6 ticks; successive same-ray shots are
interchangeable for any single terminal, and tank duels re-fire on a
similar cadence at the same target. That is why exact identity is forced
for only ~17% of shots while class identity doubles it: the ambiguity is
real, but it is mostly ambiguity between *equivalent stories*. The
engine faces the same equivalence and picks per-shell answers only
because the restatements order the stream.

Caveats: the terminal population is the viewer's — `7C`/`7D` are
excluded, but the remaining explosions still contain non-shell events
(mine detonations, dying-tank craters), which endpoint pairing can
absorb a shot into; the geometry prunes most but not all. The FIFO
pruning treats forced pairs as true pairs (the verification measures
them ~90% true). The engine agreement figures are conservative lower
bounds, since recovering the engine's own creation identities uses a
greedy time-nearest claim that can itself swap stream-mates.

Single-fixture numbers; the probe takes a replay path argument if a
corpus is available.
