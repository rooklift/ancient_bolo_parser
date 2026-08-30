# Interpolation roadmap

Planned next steps for the shell-reconstruction work, in intended order.
Written after the forced-assignment / jitter-absorption arc and refreshed
after the absorption-override / birth-claiming arc; see
`INTERPOLATION.md` for the current state and the results files for the
measurement history.

## 1. A drawn-motion audit tool (prerequisite for everything below) -- DONE

The absorption temporal gate taught the central lesson: the headline
rates measure matches, not truth — a commit made the numbers fractionally
worse and the replays visibly better. Before turning any more matching
dials, build the missing truth-side instrument:

`tools/audit-drawn-motion.cjs` — sample the drawn shell positions per
tick (as the ad-hoc scene scripts did) and count artifact classes
corpus-wide:

* **backwards steps**: a sprite position regressing along its heading,
  excluding legitimate muzzle spawns behind a leader (require that the
  nearer predecessor sprite vanished, or gate on distance from any
  active muzzle);
* **teleports**: nearest-neighbour displacement far above 2 px/tick;
* **hovers**: chains drawn below ~1 px/tick for many consecutive ticks
  (the false-absorption signature);
* **mid-field pops**: shells appearing or vanishing far from any muzzle,
  terminal, or map edge.

Calibrate by running it at three historical states (pre-branch main, the
pre-gate branch, current): the known artifact fixes must show up, or the
metric is wrong. Then it becomes the second axis every future matching
change is judged on.

## 2. Cost-ranked assignment over the ambiguous residue (parsimony phase 2) -- DONE at margin 3

The forced-only resolver leaves ~180k corpus impacts (9.3%) and a
similar order of fragment joins unexplained because two or more stories
tie. Relax "forced in every maximum assignment" to "present in every
assignment within margin Δ of optimal":

* Reuse the existing residual graph, component decomposition, and flow
  solver. Optimise lexicographically: maximise explanations (flow), then
  minimise total geometric cost (min-cost max-flow; per-edge costs
  already exist but need per-type normalisation — a join's pixel error
  and a fate's graze are not naturally commensurable).
* Acceptance: an edge is kept when every assignment within Δ of the
  optimum uses it — computed like the forced test, comparing best
  against best-without-edge, but on cost rather than cardinality.
  Δ = 0 reproduces today's behaviour; Δ is the risk dial.
* Hard physics vetoes on edges stay untouched; Δ only arbitrates among
  physically possible stories.
* Measure at several Δ on fixture and corpus, watching the usual rates
  AND the audit tool AND the bradian consistency audit. Dense same-ray
  pill streams are the known danger zone: several stories draw
  identically there, so the audit tool, not the match rate, is the
  arbiter of whether an aggressive Δ is safe.

## 2b. Rescue the forward-paired pops -- DONE

Not on the original list; the audit's first corpus run named the target
(44,652 forward-paired pops -- one shell drawn as two) and the owner
prioritised it above item 3. Done in `a74033a` via dilated joins
(stitching under time-only widened windows at a penalty cost, spatial
exactness untouched) and visual joins (draw-only links across genuine
same-ray ambiguity -- no identity, birth or fate propagates). Corpus:
pops 44,652 -> 9,443, pop-outs -38%, backwards pops halved, forward and
unlinked records; costs on the books: 5,769 terminals given back to
continue-vs-die reassignments, hover links 454 -> 3,562 (dilated joins
drawn slow -- wants a drawing-side speed floor), seam jumps 5 -> 128.

## 2c. Absorption clock-override, dense-stream guards, orbit births -- DONE

The 101202.10 clock-spike arc, measured commit by commit in the corpus
results file. Pill-orbit evidence now overrides the sender's clock in
jitter absorption, both ways (an exact orbit point strictly between a
stitch's steps is absorbed however the timestamps lie; an observation
the surviving orbits rule out is refused however well its geometry
reads), guarded for dense streams by candidate uniqueness per snapshot.
The audit gained `--describe-backwards`, whose corpus tally reframed
the backwards-pop class as STREAM TURNOVER -- dead leaders paired with
never-claimed followers -- and pointed at two birth-claiming
mechanisms: unseen shots recovered from orbit membership when the F4
was lost (14,352 corpus claims), and stream-provenance heads claimed
where ambiguity propagation had already named their pill (2,785).
Corpus, whole arc: backwards pops -41%, forward-paired pops -35%, rush
links -17%, ~17k shells drawn from their muzzles with shooters named;
hover +14% and a 0.000240 forward-match give-back of invented
explanations on the books. A rank-pairing rescue for refused groups
measured a corpus-wide null and was reverted; the account is in the
results file. Tools now stamp their output with the measuring commit.

## 3. Draw the unseen shots -- SCOPED DOWN

~247k corpus impacts now carry an unseen pill or tank source but render
as nothing. The owner's call: an adjacent-tile shot (Chebyshev <= 1,
diagonals included) needs no drawn projectile -- the flash-and-break is
close to what one perceives at that range anyway -- and the fixture
says that covers ~80% of the class (pill 82%, tank 78%), with ~17% at
two tiles (~a third of a second, borderline) and only ~2-4% genuinely
long flights. So: extend `build_shell_births` to emit muzzle-to-impact
segments only for shots beyond the adjacency radius (pill entry points
exactly via the orbit walk; arrival time = event time capped by
distance at 2 px/tick), and the payoff is a few thousand corpus
segments, not 247k. Still cheap and drawing-only, no longer urgent.
The attribution layer itself is unaffected and feeds item 4 at full
size.

## 4. Shooter attribution surfaced as stats

The attribution layer is proven (the wall scene reconstructed a
human-verifiable story). Aggregate per player and per pill: damage dealt
to tanks/pills/bases, walls destroyed, shell counts, kills (tank_hit
chains followed by tank_death within a short window). Chain shooter =
the chain's birth (tank chains: the restating client; pill chains: the
pill at the source position), plus the unseen attributions. Build the
aggregation in `game.build` (one pass over snapshots, cheap), dump it as
a tool first for validation against known games, then design the viewer
surface with the user — live panel, end screen, or console dump first.

## 5. Network-weather profiling (science, opportunistic)

The dilation and jitter measurements (0.7-3.6 px/tick apparent speeds,
±5-update timestamp drift) are per-client, per-time-window measurements
of 2003 network conditions recoverable from the replays. Fit per-client
updates-vs-ticks slope and jitter amplitude over time; report per
replay. Explains residual `no_model` chains, could annotate the viewer,
and is simply a delightful thing to reconstruct. Tool-only.

## 6. Terminal matching for stream leaders

The largest residue, two ways of naming one thing: 17% of corpus
impacts still unmatched, and ~2,270 of the remaining 3,253 backwards
pops are pill-stream leaders dying with unexplained fates (their
followers now claimed, the leaders still pop out). The anatomy says the
wins are here, not in more motion work. No design yet; the
`--describe-backwards` examples and the terminal-match failure reasons
are the starting data.

## 7. Tank-stream turnover (maybe)

The other 982 backwards pairs are tank streams: a lost 5d has no orbit
anchor (unknown firing tick and sub-pixel origin), so a tank-birth
analogue of the orbit-membership claim would run on the bradian
hypothesis machinery with far weaker constraints. Uncertain payoff;
measure the false-claim risk before believing it. Explicitly optional.

## 8. Small engine debts

* `propagate_identity_down_chain` carries source and birth but not
  orbit states, so exactness is silently dropped downstream of every
  stitch.
* The hover class (4,164 corpus links drawn slow, mostly dilated joins)
  still wants the drawing-side speed floor item 2b promised; the
  smoothing pass's own 24px plausibility gate is the other half of it.
* The seam-jump family (129 links, max 3.16 px, stable since
  `a74033a`) is on the books but unexplained; small enough to ignore,
  annoying enough to root-cause someday.

## Standing questions for the project owner

* Stats surface (item 4): where should it live in the viewer?
* Risk appetite for Δ (item 2): conservative default with an aggressive
  measurement run, or hold at forced-only until the audit tool matures?
* Unseen-shot drawing (item 3): always on, or toggleable? (Scope now
  settled: adjacent-tile shots are never drawn.)
* Continue-vs-die (item 2b): the pop rescue prefers a seen continuation
  over an inferred death when both fit, costing ~5,769 corpus terminal
  matches. Keep the preference, or should an authoritative fate event
  outrank a rescued continuation? (Item 6 will reopen this.)
* Tank-birth analogue (item 7): worth the false-claim risk at all?
