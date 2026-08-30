# Endpoint-only shot pairing: how far do creations + terminals alone go?

The interpolation system pairs shots to fates through the full shell
restatement machinery. This experiment asks the opposite question: throw
away every shell list, keep only the shot **creation** events (`5d` tank
fire, `F4` pill fire, each carrying its gross 4-bit direction) and the
shot **terminal** events (`FB` fall, `FC` tank hit, `9n` pill damage,
`An` base damage, shot-attributable `7T` explosion), and pair them on
physics alone: 2 px/tick flight, 8.5-tile range, the direction sector,
and record-time consistency. How many pair up, and how trustworthy are
the pairings?

`tools/probe-endpoint-pairing.mjs` runs the experiment. It is a
measurement probe, not app code, and shares nothing with the matcher.

## Method

Creations are placed at the firing tank's interpolated track position
(`5d`) or the named pill's centre (`F4`, trying `n−1` too for the
direction-0 index fault [E:pill-fire-index]). Terminals are the exact
`FB` point or a 16 px box (tank hits use the interpolated target track).
An edge joins a creation to a terminal when the displacement fits the
range, lies in the shot's direction cone (17° half-angle plus box slack),
and the record-time gap is consistent with a 2 px/tick flight
(default −20/+60 ticks of slack for record lag).

The feasibility graph is then read as a unit-capacity flow problem, and
the residual graph's strongly connected components classify every edge
exactly (no heuristics):

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

Pairability is essentially total; identity is mostly ambiguous:

* **99.8%** of creations and **98.1%** of terminals participate in a
  maximum matching — the books nearly balance, so almost every shot
  *has* a plausible fate and almost every fate a plausible shot.
* Only **15.9%** of creations get an exact pair that survives in every
  maximum matching; **35.2%** are class-determined (fate kind + place
  certain even where the specific event record is interchangeable);
  tank shots 47.1%, pill shots 25.5%.
* From the other side, **52.3%** of terminals know their shooter (source
  + direction class) with certainty — endpoint-only shooter attribution.
* Simple tie-broken tiers do worse than the flow analysis: mutual-best
  with margin pairs 18.4%, mutually-unique only 4.7%.

Against the full engine's reconstruction (21,345 engine opinions):

* class-determined endpoint pairs agree with the engine **91.2%** of the
  time — and the disagreements are nearly all *same event type, other
  instance* (another 9n on another pill, a different fall point): the
  stream-mate aliasing endpoint data cannot see through;
* mutual-best-with-margin agrees 82.8% — the cost margin is a weaker
  certainty signal than every-maximum-matching forcedness;
* a cheapest-edge-first best guess over everything (89.0% paired) agrees
  60.3% on fate kind + place, 38.8% on the exact event.

Window sensitivity (early/late record-lag slack, cone): tightening to
−8/+25/13° lifts determinacy to 40.4% but its accuracy *falls* to 87.2%
(true partners get excluded, leaving false certainty); loosening to
−30/+90/20° drops determinacy to 27.5% for 91.9% accuracy. The determined
tier hovers around 90% correct wherever the windows sit — the remaining
errors are aliasing, not window tuning.

## Reading

An angry pillbox fires every 5–6 ticks; successive same-ray shots are
interchangeable for any single terminal, and tank duels re-fire on a
similar cadence at the same target. That is why exact identity is forced
for only ~16% of shots while class identity doubles that: the ambiguity
is real, but it is mostly ambiguity between *equivalent stories*. The
engine faces the same equivalence and picks per-shell answers only
because the restatements order the stream.

Caveats: the terminal population is the viewer's — `7C`/`7D` are
excluded, but the remaining explosions still contain non-shell events
(mine detonations, dying-tank craters), which endpoint pairing can
absorb a shot into; the geometry prunes most but not all. The engine
agreement figures are conservative lower bounds, since recovering the
engine's own creation identities uses a greedy time-nearest claim that
can itself swap stream-mates.

Single-fixture numbers; the probe takes a replay path argument if a
corpus is available.
