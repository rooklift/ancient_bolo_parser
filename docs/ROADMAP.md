# Interpolation roadmap

Planned next steps for the shell-reconstruction work, in intended order.
Written after the forced-assignment / jitter-absorption arc, refreshed
after the absorption-override / birth-claiming arc, and again after the
pill lockstep arc (item 9); see the results files for the measurement
history and `docs/interpolation_tests_corpus.md` for the full
commit-by-commit account.

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

## 4. Shooter attribution surfaced as stats -- VERY LOW PRIORITY

Owner's call: park this. The attribution layer is proven (the wall scene reconstructed a
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

## 6. Terminal matching for stream leaders -- DONE, closed at the knee

Ran as a census-first arc (`--describe-terminals`, `--describe-ends`),
four measured dials, every one corpus-verified with zero cost on the
untouched axes: the same-record unseen-shot phase, the
equivalence-forced attributions, capacity-honest accounting, and
die-at-impact (5,396 mid-air vanishes became deaths at the wall -- the
arc's only real match gains, the rest being attributions). Closing
tally against the arc's baseline: unexplained impacts -46% (148k ->
80k), backwards pops -44% and forward-paired -37% against the
pre-branch baseline. What remains is dominated by information the log
never carried (senders fire faster than they restate, so volley
siblings are real but unobserved; fall events get lost) and by
vanishes that are visually CORRECT (a shell disappearing at range end
fell -- the pop-out metric does not distinguish that from a mid-flight
vanish). Deliberately closed here rather than polished further; the
full account is in the corpus results file.

**The mode from here is complaint-driven**: the owner watches replays
and reports scenes that look wrong ("this shell should have
interpolated better", with replay, rough time, and where to look);
each report gets the record-level scene dump, a census classification
of what blocked it, and a measured fix. That instrument has better
resolution than any corpus metric now -- it is how this branch started,
and the diagnostics built this arc exist to service it.

## 7. Tank-stream turnover (maybe)

The other 982 backwards pairs are tank streams: a lost 5d has no orbit
anchor (unknown firing tick and sub-pixel origin), so a tank-birth
analogue of the orbit-membership claim would run on the bradian
hypothesis machinery with far weaker constraints. Uncertain payoff;
measure the false-claim risk before believing it. Explicitly optional.

## 8. Small engine debts -- mostly retired

* `propagate_identity_down_chain` carried source and birth but not
  orbit states, so exactness was silently dropped downstream of every
  stitch. DONE: `propagate_states_down_chain` re-derives the states
  link by link below every stitch, forced origin and membership claim
  (see `docs/interpolation_tests.md`, "Orbit states below a stitch").
* The hover class (4,164 corpus links drawn slow, mostly dilated joins)
  wanted the drawing-side speed floor item 2b promised. It went 4,164
  -> 3,347 in the lockstep arc, -> 3,093 with the pill-birth window and
  -> 2,446 with the dilated-join lie bound, none of them the floor. The
  residue is the true dilation class -- hops whose assumed clock lie is
  inside the measured bound, drawn slow by construction -- and a floor
  would only redraw those as a sprint and a park, the hover in another
  costume. The lever is deciding per hop whether it is one shell or
  two, which the lie bound began; the smoothing pass's own 24px
  plausibility gate remains the other half. Open, restated.
* The seam-jump family (129 links, max 3.16 px) was root-caused and
  closed by item 9's seam closure: 81 corpus seam jumps to 0, and 0 at
  every audit since. DONE.

## 9. The pill lockstep arc -- DONE

Ran complaint-driven exactly as item 6 predicted, starting from one
extra drawn shell in one volley. Eight measured dials: dilated same-orbit
continuations, the seam closure (81 corpus seam jumps to 0, still 0),
the tail slide, the smoothing guard split, the shell-list simultaneity
measurement (4.3M pairs settling [E:shell-list-skew] as a working
invariant), the pill-wide matcher lockstep, the residual lockstep veto,
and the pairwise roster lockstep. The statement-roster vote -- the
pill's own restatements electing the one step advance a sender
transition carries -- now backs all three engines (pairwise matcher,
stitching, residual flow). Closing position: every shell-side corpus
record held (0.995494 matched forward / 0.001520 unlinked), terminal
rate second only to `029acac`, the audit era's best steady-speed rate,
stream-birth mints down 55% in the final dial alone. Item 8's hover
debt largely dissolved along the way (4,164 -> 3,347 without the
speed floor being built). Full account in the corpus results file.

## 10. Doubtful voters abstain -- DONE

The first complaint the vouched-link metric produced, chased as item 6
predicted: the owner watched the metric's named scene (fixture records
#111355 -> #111359) and saw the trailing shell vanish. The roster
election had stood down one short of its margin because a shell that
died over the pair cast the deciding vote for the rung-shift alias.
Members holding a terminal candidate now abstain from the gated vote,
the full roster still having to rank the same advance first (see
`docs/interpolation_tests.md`). Fixture: contradictions 6 -> 0, matched
forward +6, pops -6, a second tank hit explained, fast-ring fixture
byte-identical. Corpus: both shell-side records on (matched forward
+103, `pop_outs` -103, unlinked -36), terminals +135 with `tank_hit`
+76, steady links to the audit era's best; contradictions 423 -> 437
and backwards pops +25 on the books. The rates tool's
`--describe-links` names every contradiction (record times, pill,
steps, elected advance, the matcher's own election over the pair and
both rosters) so each can be read without the log; that is the
instrument for the complaint-driven mode from here, alongside the
audit's `--describe-backwards`. The first corpus links run (437 named)
found the majority linked LONG by one rung with the engine's own links
at mixed advances -- wrong links, the mirror of the fixture scene --
and the election bookkeeping exists to say whether the vote stood
down or was never held; see the corpus file's links-run section.

## 11. The symmetric election and the orphan tie-break -- DONE

The second complaint the vouched-link metric produced, read straight
off the `41bb718` links run: every pairwise contradiction was a
stand-down in which the matcher knew the advance and missed the margin
by one or a tie -- the ladder alias is structural for long rosters --
and item 10's one-way abstention had itself regressed 84 scenes by
thinning the roster below the gates. The election now passes when
either vote clears the gates with the other leading the same advance,
and an orphan-free leader wins a margin-one or tied election when every
rival within one leaves a high-step landing without a source. Scored
against all 140 stand-down scenes before building: 110 rescued, all
agreeing with the post-hoc vote. Corpus: matched forward +675 with
`pop_outs` -675, unlinked -236, contradictions 437 -> 89, stream
births -27%, every audit lie metric down. What remains is mostly the
stitching pass reading the time-keyed vote table on same-time pairs
(item 12). See `docs/interpolation_tests.md`.

## 12. The vote table keyed by snapshot index -- measured null, REVERTED

The `0bfd71d` links run's residue looked like the same-time key
collision noted when the scorer was built: 29 of the 89 surviving
contradictions were stitched links on 3-4 tick pairs carrying exactly
twice the elected advance. Keying the stitching and residual passes'
vote table by snapshot index (`84c4605`) was byte-identical on both
fixtures and, on the corpus, a null on its target (89 -> 89, the same
29) at a cost of 8 terminals, 8 forward matches and 22 forward-paired
pops. Reverted. The reading: the composed two-hop advance is the right
answer for a join across a same-time pair, so those 29 are most likely
the scorer's yardstick being wrong there, not wrong links. On the
shelf: a per-link record of which pass made it (pairwise, stitch,
dilated, residual, absorption -- `stitched` is one flag set by
several), which would settle it in one run.

## Ideas shelf

Unscheduled, in no particular order; each was sized during the lockstep
arc but deliberately not started.

* **Falls rescue / forced fates.** The unmatched `shell_falls` anatomy
  (fixture: thirteen cases -- six with no story at all, one with a
  single legal-but-declined candidate, six with exactly two dangling
  candidates, never a crowd) says roughly half the 4,368 corpus
  unmatched falls have a legal declined story. Three doctrine-shaped
  dials: force a unique legal edge between an unexplained end and an
  unmatched fall; force FATES, not just assignments, when every
  max-flow kills an end (N falls with N dangling ends -- the 2x2 case
  defeats per-edge forcing today even though both deaths are certain,
  with equivalence-close falls absorbing the pairing ambiguity); and
  the leader-falls-first tiebreak (fixed 32-step lifetime means the
  shell further along the shared ray falls first). Each rescue
  un-freezes an END as well as matching a terminal, so pop-outs and
  the end census improve together; ~2k terminals would clear
  `029acac`'s all-time terminal record. Related, same neighbourhood:
  the same-record starvation fix (the flow cannot see duration-zero
  creation-to-fate stories, so a low-range shot's own fall can starve
  while the flow spends the shot one fate late -- see "The same-record
  starvation shape" in the corpus results file).
* **Correctness-weighted coverage metric -- DONE.** The headline rates
  count explanations, not correct ones -- a lie and a truth score the
  same, which is why honest give-backs read as losses. Built as
  `score_pill_links` (measurement only): every pill link is binned
  vouched / contradicted / unvouched against the roster vote, reported
  by the rates tool as `rate_links_pill_vouched` and
  `rate_links_pill_contradicted`, pinned on both fixtures in the test
  suite. Fixture: 0.608 vouched, 6 contradictions in 32,907 scored --
  all one client, the roster-ladder off-by-one shape, the metric's
  first named scenes. Fast ring: 0 contradictions once keyed by
  snapshot index (time keys collide on same-time pairs there; the
  engine's own table still uses them -- a quirk on the books). Corpus: 5,089,285 scored, 0.569 vouched, 423
  contradicted (0.000083), every matching metric byte-identical. See
  `docs/interpolation_tests.md` and the corpus file.
* **The pace / drawn-speed residue.** Rushed terminal links (68,540
  corpus, 3.0+ px/tick final hops) are the one class every lockstep
  dial nudges the wrong way by a few dozen: a lockstep-verified
  continuation over a lying stamp draws off-pace because the drawn
  timeline is still the record stamps. The real fix decouples them --
  judged poor cost/benefit twice now, but the sizing is on file.

## Standing questions for the project owner

* Stats surface (item 4): where should it live in the viewer?
* Risk appetite for Δ (item 2): conservative default with an aggressive
  measurement run, or hold at forced-only until the audit tool matures?
* Unseen-shot drawing (item 3): always on, or toggleable? (Scope now
  settled: adjacent-tile shots are never drawn.)
* Continue-vs-die (item 2b): the pop rescue prefers a seen continuation
  over an inferred death when both fit, costing ~5,769 corpus terminal
  matches. Keep the preference, or should an authoritative fate event
  outrank a rescued continuation? (Item 6 reopened and largely
  answered this: the measurement acquitted the continuations -- most
  are correct single shells riding volleys with unobserved siblings --
  and die-at-impact now settles the chain-END case in the fate's
  favour when no continuation story survives the margin.)
* Tank-birth analogue (item 7): worth the false-claim risk at all?
