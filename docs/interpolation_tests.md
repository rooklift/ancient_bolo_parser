# Interpolation coverage across versions

How much of a replay the motion code manages to explain, measured at ten
points in the history. Produced with `tools/report-interpolation-rates.cjs`
(which lives on `main`), run once per checked-out commit:

```
node tools/report-interpolation-rates.cjs -f <absolute path to the fixture>
```

All ten runs read the same input, `fixtures/n20021018.2`
(sha256 `100d68e2c2679cbac40a09bedc7cddeed9e357eed8de9205cba96bfe5a511ba9`). The
fixture blob is identical at every commit measured, so nothing here is an
artefact of the sample changing underneath the engine. The tool writes nothing
to disk; each historical run was done in a throwaway worktree with `main`'s copy
of the tool dropped in, so the measuring code is the same in all ten runs and
only the engine differs. Two runs needed no worktree. The v1.0.8 run was
`main`'s own HEAD when this file was started; the `926f391` run was the branch's
own clean HEAD, with the tool already in the tree and byte-identical to `main`'s
(`git diff main HEAD -- tools/report-interpolation-rates.cjs` empty).
`tools/report-interpolation-rates.cjs` has not changed since `76d8b8a`, its
only commit. `main` has since gained `12bc73d` and the three commits before it,
but they touch only `viewer/main.js`, `viewer/preload.js`, `viewer/renderer.js`
and packaging, so v1.0.8's numbers are still `main`'s.

## What the numbers mean

* `rate_shells_matched_forward` -- of every shell seen in every snapshot, the
  fraction that was matched onward, either to a later snapshot or to a terminal.
* `rate_shells_unlinked` -- the fraction matched neither forwards nor backwards:
  a shell that appeared and vanished with nothing to account for it. The clearest
  failure signal in the report.
* `rate_terminals_matched` -- of the impacts and explosions in the log, the
  fraction a shell was found to explain.
* `shells_with_pillbox_source` / `shells_from_pillbox` -- how much shell-to-pillbox
  attribution survived.
* `shells_with_birth` -- shells whose origin moment is known.
* `shell_births` -- how many birth records the viewer builds: one per shell
  observation whose flight can be traced back to the muzzle, so the shell can be
  drawn from the moment it was fired rather than from the first snapshot showing
  it. Not the same as `shells_with_birth`; before v1.0.8 only tank shells
  qualified.
* Tank and LGM track coverage is reported too, but is byte-identical at all ten
  commits, so it is omitted below. For the record: `rate_tank_ticks_interpolated`
  0.687960 and `rate_lgm_ticks_interpolated` 0.435824 throughout. Note that the
  tick-weighted rate is the honest measure of how much of the replay is actually
  smooth; the per-segment rate flatters it badly (0.951096 for tanks).

## v1.0.7 -- `323c673` "rejoin / alliance issues"

* `rate_shells_matched_forward` 0.929101
* `rate_shells_unlinked` 0.029667
* `rate_terminals_matched` 0.771713
* `terminals_matched:tank_hit` 2657 of 3879
* `shells_from_pillbox` 11661
* `shells_with_pillbox_source` 41226
* `shells_with_birth` 9021 -- equal to `shells_from_tank`, i.e. only tank shells
  had a known birth at this point
* `max_shell_interpolation_ticks` absent; the report prints `-` rather than a
  fake zero
* `terminals_unseen_pillbox_source` 0

## Branch point -- `main` at `76d8b8a`

The engine here was identical to the branch point `6777d35` when this file was
started: every commit `main` had gained since then was a FORMAT.md edit or the
report tool. So this is the baseline the branch should be judged against, not a
parallel line of work. `main` has moved on since, and
`git diff 6777d35 main -- viewer/ src/` is no longer empty -- but the only
engine change in it is `f4f15d9`, whose effect on the report is one line
(`shell_births`), recorded under v1.0.8 below.

* `rate_shells_matched_forward` 0.961100 -- tied with v1.0.8; the best measured
  until `4f5dbe9`
* `rate_shells_unlinked` 0.016596 -- tied with v1.0.8; the best measured until
  `4f5dbe9`
* `rate_terminals_matched` 0.817321 -- tied with v1.0.8; the best measured until
  `4f5dbe9`
* `terminals_matched:tank_hit` 2826 of 3879
* `shells_from_pillbox` 11661
* `shells_with_pillbox_source` 41881
* `shells_with_birth` 28001 -- births now known well beyond tank shells
* `terminals_unseen_pillbox_source` 393

Versus v1.0.7 this is a gain across the board: +3.2 points of shell matching,
+4.6 points of terminal matching, and unlinked shells roughly halved.

## v1.0.8 -- `e4582dc` "aesthetic improvement"

Identical to the branch point everywhere but one line. The whole report diff
against `76d8b8a` is:

* `shell_births` 9020 -> 20681

Everything else matches byte for byte:

* `rate_shells_matched_forward` 0.961100 -- unchanged
* `rate_shells_unlinked` 0.016596 -- unchanged
* `rate_terminals_matched` 0.817321 -- unchanged
* `terminals_matched:tank_hit` 2826 of 3879 -- unchanged
* `shells_from_pillbox` 11661, `shells_with_pillbox_source` 41881,
  `shells_with_birth` 28001, `terminals_unseen_pillbox_source` 393 -- unchanged

The added births are pillbox shells, exactly: 9020 (`shells_from_tank`) + 11661
(`shells_from_pillbox`) = 20681, so every pillbox shell gained a birth and no
tank shell lost one. This is `f4f15d9` "Pillbox shots visible right from the
start", which extends `build_shell_births` in `viewer/motion.js` to derive a
start point from `pillbox_source_distance` instead of skipping non-tank shells.
The two later commits, `6801403` (a version label in the menu) and `e4582dc`
(pillbox draw order), touch only `viewer/main.js` and `viewer/renderer.js` and
cannot move the report.

This is a gain in what can be drawn, not in what is understood: it adds the
muzzle-to-first-sighting segment for pillbox shells, and does not change which
shells are matched to which, or which terminals are explained.

## Branch -- `ad6a3b6` "Stuff"

* `rate_shells_matched_forward` 0.911773 -- down 4.9 points from the branch point
* `rate_shells_unlinked` 0.054411 -- up from 0.016596, more than tripled
* `rate_terminals_matched` 0.797674 -- down 2.0 points
* `terminals_matched:tank_hit` 2581 of 3879 -- down 245
* `shells_from_pillbox` 8666 -- down from 11661
* `shells_with_pillbox_source` 22517 -- roughly half of the branch point's 41881
* `shells_with_birth` 27968 -- retained
* `terminals_unseen_pillbox_source` 424

## Branch -- `5e69318` "consider this tolerance rather than shell sprite size"

* `rate_shells_matched_forward` 0.914431
* `rate_shells_unlinked` 0.054005
* `rate_terminals_matched` 0.805940 -- up 0.8 points from `ad6a3b6`
* `terminals_matched:tank_hit` 2782 of 3879 -- **up 201** from `ad6a3b6`
* `shells_from_pillbox` 8666 -- unchanged
* `shells_with_pillbox_source` 22516 -- unchanged bar one shell
* `shells_with_birth` 27968 -- unchanged
* `terminals_unseen_pillbox_source` 424 -- unchanged

## Branch -- `c848efd` "Stuff"

A confirmation run rather than a new data point. `c848efd` adds
`tools/measure-pillbox-tank-hit-tolerance.cjs` and a `package.json` script, and
`dd553c5` after it adds only `tools/_check_death_impact_codes.cjs`; neither
touches engine code. Every metric is identical to `5e69318`. Recorded so the
next section's gain can be pinned to a single commit.

## Branch -- `4f5dbe9` "Possible fix to a bad assumption", `using_the_pillbox_data` checkpoint

The first state to beat the branch point on every headline metric. It held the
best `rate_terminals_matched` for the next four measured commits; `83cb132`
below took the two shell-matching rates off it, and `926f391` has since taken
the terminal rate too.

* `rate_shells_matched_forward` 0.971011 -- up 5.7 points from `5e69318`, and
  1.0 point above the branch point, the previous best
* `rate_shells_unlinked` 0.012094 -- down from 0.054005, and below the branch
  point's 0.016596
* `rate_terminals_matched` 0.845691 -- up 4.0 points from `5e69318`, 2.8 above
  the branch point
* `terminals_matched:tank_hit` 3089 of 3879 -- up 307 from `5e69318`, and 263
  above the branch point's 2826
* `shells_from_pillbox` 11663 -- recovered from 8666, two above the branch
  point's 11661
* `shells_with_pillbox_source` 44245 -- recovered from 22516, and 2364 above the
  branch point's 41881
* `shells_with_birth` 28006 -- up 38 from `5e69318`, 5 above the branch point
* `shells_from_tank` 9021 -- up one from 9020
* `terminals_unseen_pillbox_source` 393 -- back to the branch point's value
* `shell_births` 9021 -- tank shells only; the branch does not carry `main`'s
  `f4f15d9`, so this is not comparable with v1.0.8's 20681
* `max_shell_interpolation_ticks` 50

The rest of the terminal breakdown moves the same way: `explosion` 1589 -> 1829,
`pillbox_damage` 5607 -> 5931, `shell_falls` 8311 -> 8398, and `base_damage`
1114 -> 1113, the one metric that goes backwards, by a single terminal.

`4f5dbe9` is the only commit in this span touching `viewer/motion.js`, so the
whole gain is its own -- no trio to disentangle this time.

## Branch of the branch -- `83cb132` "Try to determine true location from quantized pillbox shots", `using_the_pillbox_data_antifuzz` checkpoint

`using_the_pillbox_data_antifuzz` is `using_the_pillbox_data` plus this one
commit, so again the whole delta is attributable to it. It touches
`viewer/motion.js` and `viewer/pillbox_shell_orbits.js`. Its message warns
"possibly interrupted work", but the tree is not in a broken state: `npm test`
passes at this commit, 181 checks, no failures.

The trade is a real gain in shell matching against a rounding-error loss in
terminal matching.

* `rate_shells_matched_forward` 0.976801 -- up 0.58 points from `4f5dbe9`, the
  best measured
* `rate_shells_unlinked` 0.009342 -- down from 0.012094, the best measured and
  the first time this metric has gone below 1%
* `rate_terminals_matched` 0.845607 -- **down** 0.000084 from `4f5dbe9`, i.e.
  two terminals out of 24075. `4f5dbe9` keeps the record here, and holds it
  until `926f391`.
* `shells_matched_to_snapshot` 51684 -- up 429; every shell gained is matched
  onward to a later snapshot, not to a terminal
* `shells_unmatched_forward` 1711 -- down 427
* `shells_unlinked` 689 -- down 203
* `terminals_matched:tank_hit` 3086 of 3879 -- down 3
* `terminals_matched:pillbox_damage` 5933 -- up 2
* `terminals_matched:shell_falls` 8397 -- down 1
* `shells_with_pillbox_source` 44239 -- down 6
* `shells_from_pillbox` 11663, `shells_from_tank` 9021, `shells_with_birth`
  28006, `shell_births` 9021, `terminals_unseen_pillbox_source` 393,
  `terminals_matched:base_damage` 1113, `terminals_matched:explosion` 1829 --
  all unchanged from `4f5dbe9`
* `max_shell_interpolation_ticks` 50

Reading the shape of it: the commit does not find new shells or new pillbox
attributions -- every origin and birth count is untouched -- it keeps existing
shells alive across more snapshot-to-snapshot links. That is what a better
estimate of a quantised shot's true position would be expected to do, and it is
consistent with the commit's stated aim. The two lost terminals are the cost of
those firmer chains occasionally preferring a snapshot successor to an impact.

## Branch after merging main -- `5f9d86f` "errors are one-sided", `using_the_pillbox_data_antifuzz` HEAD

This state includes the merge from `main`, `cbf1d6e`'s adjustment of pillbox
birth segments to exact recovered orbit positions, and `5f9d86f`'s one-sided
quantisation bound. The merge and `cbf1d6e` affect drawing and birth records;
`5f9d86f` is the engine change responsible for the shell-linkage delta below.
An arithmetic right shift always rounds a chained offset down, so a member at
index `i` can only have an exact coordinate in
`[reconstructed, reconstructed + i]` on each axis. The former symmetric bound
also admitted physically impossible coordinates below the reconstruction.

This tightens the previous best shell-continuity results, at the cost of two
more matched terminals:

* `rate_shells_matched_forward` 0.977967 -- up from 0.976801, a new best
* `shells_matched_forward` 72128 -- up 86 from 72042
* `rate_shells_unlinked` 0.008637 -- down from 0.009342, a new best
* `shells_unlinked` 637 -- down 52 from 689
* `rate_terminals_matched` 0.845524 -- down 0.000083 from 0.845607, another two
  terminals out of 24075; `4f5dbe9` still holds the terminal-matching record at
  this point, and keeps it until `926f391`
* `shells_matched_to_snapshot` 51772 -- up 88 from 51684
* `shells_unmatched_forward` 1625 -- down 86 from 1711
* `terminals_matched:tank_hit` 3086 and
  `terminals_matched:shell_falls` 8397 -- unchanged
* `terminals_matched:pillbox_damage` 5931 -- down 2 from 5933
* `shells_with_pillbox_source` 44245 -- up 6, returning to `4f5dbe9`'s best
* `shells_from_pillbox` 11663, `shells_from_tank` 9021,
  `shells_with_birth` 28006 and `terminals_unseen_pillbox_source` 393 --
  unchanged
* `shell_births` 20684 -- now includes both 9021 tank and 11663 pillbox births
  after merging main's `f4f15d9`; unlike the earlier branch-only values, this
  is directly comparable with v1.0.8's 20681
* `max_shell_interpolation_ticks` 50

The sign constraint also survives direct replay audits: every exact position
recovered for 1752 non-head shell observations in corpus replay md5
`0f691e1d594c0a6636c25578d7d4fa17`, and all 19162 in the sample fixture, lies
inside the one-sided bound. The original two-shell
case at record 1251 remains resolved to its two distinct orbit states and
shell-fall terminals.

## Branch -- `926f391` "Tank shots in index 1+ have uncertainty too", `using_the_pillbox_data_antifuzz` HEAD

The first state to hold all three headline records at once. `3a46de5` between
this and `5f9d86f` edits only this file, so the whole delta belongs to
`926f391`. `npm test` passes here, 187 checks, no failures.

Where the previous three motion commits each bought shell continuity by giving
terminals back, this one gains on both axes together.

* `rate_shells_matched_forward` 0.980136 -- up from 0.977967, a new best
* `rate_shells_unlinked` 0.008081 -- down from 0.008637, a new best
* `rate_terminals_matched` 0.849553 -- up from 0.845524, and 0.003862 above
  `4f5dbe9`'s 0.845691, which had stood since it was measured. First movement
  of this record since `4f5dbe9`.
* `shells_matched_forward` 72288 -- up 160 from 72128
* `shells_matched_to_snapshot` 51835 -- up 63 from 51772
* `shells_matched_to_terminal` 20453 -- up 97
* `shells_unmatched_forward` 1465 -- down 160 from 1625
* `shells_unlinked` 596 -- down 41 from 637
* `max_shell_interpolation_ticks` 50

The terminal breakdown gains in four classes of five, the first broad advance in
this span:

* `terminals_matched:pillbox_damage` 5997 -- up 66 from 5931
* `terminals_matched:shell_falls` 8416 -- up 19 from 8397
* `terminals_matched:tank_hit` 3096 of 3879 -- up 10 from 3086, and 7 above
  `4f5dbe9`'s 3089
* `terminals_matched:base_damage` 1117 -- up 4 from 1113
* `terminals_matched:explosion` 1827 -- down 2 from 1829, the only regression

Attribution is flat and births move by four:

* `shells_from_tank` 9017 -- down 4 from 9021
* `shell_births` 20680 -- down 4 from 20684, the same four shells:
  9017 + 11663 = 20680
* `shells_with_birth` 28067 -- up 61 from 28006
* `shells_from_pillbox` 11663, `shells_with_pillbox_source` 44245,
  `terminals_unseen_pillbox_source` 393 -- all unchanged

Reading the shape of it: widening the bound to index 1+ tank shots admits
candidates the tighter bound had been rejecting outright, rather than merely
re-ranking the ones already admitted. That is consistent with gaining shell
links and terminals at the same time, which a pure re-ranking cannot do -- the
earlier commits' two-terminal costs were exactly that kind of trade. The four
shells leaving `shells_from_tank` are the expected direct effect: a tank shot at
index 1+ that now carries uncertainty is no longer a confident tank origin.

One loose end worth a look before this becomes the baseline: `shells_with_birth`
rises 61 while `shells_from_tank` falls 4, so births are being derived for
shells whose origin is now less certain, not more. That is plausibly correct --
an uncertain origin still has a recoverable start point -- but it is the one
number here whose direction is not obviously implied by the commit message, and
`build_shell_births` in `viewer/motion.js` is where it would be confirmed.

## Tank facing gets a window of its own

Facing had always been bridged with the position limit of 25 ticks, so a tank
that went quiet for longer snapped between angles instead of turning. Replay
`062003.1` at 2:40 is the case that prompted the change: player 1 is logged at
north on tick 8601710 and at west on tick 8601750, with no record of his own in
between, and the viewer flipped the sprite a quarter turn in one frame.

A turn rate is bounded in a way an unseen path across open ground is not, which
is the argument for a longer window, but only as far as the logs support it.
Measured over the whole corpus, on continuous facing segments, in ticks per
sixteenth of a circle:

| gap | segments | 1st pct | median |
| --- | --- | --- | --- |
| up to 25 ticks | 12759519 | 2.00 | 7.00 |
| 26 to 50 | 71711 | 6.75 | 12.25 |
| 51 to 100 | 44009 | 7.29 | 19.33 |
| over 100 | 56054 | 16.29 | 109.00 |

Nothing in the 26-50 band implies a turn faster than turns already seen inside
the trusted window, so those spans are reconstructions rather than inventions.
Past 50 the change sizes start clustering at seven or eight sixteenths -- 1263
of the 51-100 segments, against 61 in the band below -- and at eight the shorter
way round is a coin toss. `MAX_DIRECTION_INTERPOLATION_TICKS` is therefore 50,
the same window shells get, and the report now carries the facing track and
`max_direction_interpolation_ticks` alongside the position tracks.

On the fixture, `rate_tank_direction_ticks_interpolated` 0.895421 -> 0.917236
and `rate_tank_direction_segments_interpolated` 0.977480 -> 0.984905, with
`tank_direction_segments_overlong` 1637 -> 757. Corpus-wide, over 443 replays,
0.816613 -> 0.837266 tick-weighted, 171774 overlong segments down to 100063.
Every shell, terminal, tank-position and LGM metric is byte-identical before and
after, in both runs: facing feeds drawing only, and nothing in shell matching
reads it.

## Tank shells join the discrete simulation -- `c4bf83c`

Corpus measurement (`docs/tank_shell_bradians.md`) proved tank shells run
the same integer simulation as pillbox shells, at all 256 bradians. This
commit makes the matcher use it: a tank-born shell carries per-bradian
hypothesis states bounding its exact internal coordinate, continuations
are vetoed when no state can reach them, boxes narrow into exact
coordinates and uniquely pinned bradians into exact headings, and exact
trajectories get the same two-pixel box graze the exact pill orbits
already had against reconstructed tanks. The update-count window is two
per link (the equivalent of the matcher's existing eight-pixel distance
tolerance); a one-update window was measured too, and vetoed a handful of
real, merely-laggy links, converting them to impact matches but costing
one net forward match.

The first commit to hold all three headline records at once since
`926f391`, and the first to gain on every one of them simultaneously:

* `rate_shells_matched_forward` 0.980448 -- up from 0.980136, a new best
* `rate_shells_unlinked` 0.007864 -- down from 0.008081, a new best
* `rate_terminals_matched` 0.850218 -- up from 0.849553, a new best
* `shells_matched_forward` 72311 -- up 23
* `shells_matched_to_snapshot` 51842 -- up 7
* `shells_matched_to_terminal` 20469 -- up 16
* `shells_unlinked` 580 -- down 16
* `terminals_matched:tank_hit` 3108 of 3879 -- up 12
* `terminals_matched:pillbox_damage` 6000 -- up 3
* `terminals_matched:base_damage` 1118 -- up 1
* `terminals_matched:explosion` 1828 -- up 1
* `terminals_matched:shell_falls` 8415 -- down 1, the only regression
* `shells_from_tank` 9019 -- up 2; `shells_with_birth` 28081 -- up 14;
  `shell_births` 20682 -- up 2
* Tank, LGM and facing tracks byte-identical, as expected

Reading the shape of it: the veto converts physically impossible snapshot
links into the impacts the shells actually reached (hence terminals up
across four classes while snapshot links also rise), and the recovered
exact coordinates let bounded restatements match where the quantised
reconstruction previously missed. `npm test` passes, 188 checks; the
bounded-successor test's hand-made coordinates violated the integer
simulation (its y rose then fell, which no bradian can do) and were
regenerated to follow it.

## Chain stitching -- `0d181be`

The issue #15 feasibility probe (`tools/probe-shot-fate-parsimony.cjs`)
showed the unexplained residue's largest single cause is same-client
chain fragmentation, not anything exotic: links failed on since-resolved
margin ambiguities, and lag gaps past the pairwise window split every
in-flight shell of a sender at once. This commit adds a per-client
stitching pass reconnecting chain ends to origin-less chain starts under
the ordinary physics tests, with discrete (orbit/bradian) evidence
allowed to bridge up to a shell lifetime.

The largest single movement in shell continuity measured in this file:

* `rate_shells_matched_forward` 0.988055 -- up from 0.980448, a new best;
  +561 links, against the +23 of `c4bf83c` and the +160 of `926f391`
* `rate_shells_unlinked` 0.004990 -- down from 0.007864, a new best and
  the first time under half a percent
* `rate_terminals_matched` 0.850218 -- unchanged, as expected: stitching
  joins restatements and does not touch terminal assignment
* `shells_with_birth` 28178 -- up 97; `shells_with_pillbox_source` 44303
  -- up 58: origins now flow across the joins
* The bradian-consistency audit is flat (`no_model_s1` 70 vs 69), so the
  new links are as physically sound as the old ones
* The probe's fragment residue falls by roughly 40%: chains missing an
  origin 1297 -> 830, missing a fate 1442 -> 881

`npm test` passes, 189 checks, including a new lag-gap stitching case.

## Forced residual assignment -- `d10f153`

The safe core of issue #15. After matching and stitching, one client's
leftovers form a bipartite problem -- suppliers of a shell identity
(unaccounted chain ends, unconsumed fired shots) against consumers of one
(origin-less chain starts, unexplained impacts) -- and a per-component
maximum-flow solver accepts exactly the assignments present in every
maximum assignment. Ambiguity stays unexplained; the only consistent
story gets told, including conclusions pairwise margins cannot reach.

* `rate_terminals_matched` 0.856698 -- up from 0.850218, a new best and
  the largest terminal gain since `4f5dbe9`; +156 terminals, all five
  classes up (`tank_hit` +53 to 3161, `pillbox_damage` +44,
  `shell_falls` +32, `explosion` +20, `base_damage` +8)
* `rate_shells_matched_forward` 0.990889 -- up from 0.988055, a new best
* `rate_shells_unlinked` 0.004434 -- down from 0.004990, a new best
* `terminals_unseen_pillbox_source` 792 -- up from 393, and a new
  `terminals_unseen_tank_source` 879: 1,278 further impacts whose shell
  was never observed now name their firing pill or tank. Counting those,
  92.6% of the fixture's terminals have an explanation, against 86.6%
  before the pass.
* `shells_from_tank` +12, `shells_from_pillbox` +8, `shells_with_birth`
  +40 -- forced origin recovery for origin-less chains
* The bradian physics audit is flat (`no_model_s1` 70), and the
  event-lag bound means every forced fate sits within ordinary record
  lag of its shell's inferred arrival.
* Build time on the fixture rises about half a second; playback is
  untouched.

`npm test` passes, 191 checks, including new forced-late-impact and
unseen-tank-attribution cases.

Cumulative for the branch line against `926f391`: forward matching
0.980136 -> 0.990889, unlinked 0.008081 -> 0.004434 (nearly halved),
terminals 0.849553 -> 0.856698.

## Jitter absorption and constant-velocity drawing -- `4c791a0`

Prompted by replay `122903.4` records 4264-4288: a lagging sender whose
record timestamps drift several updates against its simulation, making a
pill burst's per-hop speeds read 0.7 to 3.6 px/tick around the true 2.
Stitches now absorb the on-path observations they bridge over (formerly
phantom second shells -- the reported backwards motion), and a final
pass re-times chains of three or more restatements to constant drawn
velocity between their anchors. Drawing only; packet-exact state and
matcher artifacts untouched.

* `rate_shells_matched_forward` 0.991607 -- up from 0.990889, a new best
* `rate_shells_unlinked` 0.003729 -- down from 0.004434, a new best; the
  52 shells recovered are precisely the absorbed phantoms
* `rate_terminals_matched` 0.856739 -- up 1 terminal
* Bradian audit moves by two chains (the absorbed middles are by
  definition the time-jittered ones); everything else flat

`npm test` passes, 193 checks, including the reduced jittered-sender
scene from the replay.

## The drawn-motion audit -- a second measurement axis

The match rates count explanations; they cannot see what the renderer
does with them. `tools/audit-drawn-motion.cjs` measures the drawn link
structure directly: the speed of every interpolated link (a perfect
engine draws all of them at 2 px/tick), hover (<1) and rush (>3) links,
seam jumps (handoff discontinuities, an invariant that must be zero),
pop-outs/pop-ins, and backwards pops (an origin-less appearance behind a
same-direction vanish -- the perceptual backwards-moving shell).

Calibration on the fixture across five engine states, current tool
throughout:

| state | steady links | pop-outs | backwards pops | hover | rush |
| --- | --- | --- | --- | --- | --- |
| `5455724` pre-branch | 0.787 | 1465 | 62 | 0 | 0 |
| `0d181be` stitching | 0.780 | 881 | 42 | 0 | 0 |
| `d10f153` resolver | 0.779 | 672 | 29 | 0 | 0 |
| `4c791a0` smoothing, ungated | 0.983 | 619 | 23 | 1 | 13 |
| `b345ef0` current | 0.983 | 622 | 25 | 0 | 7 |

Every known event in the branch history is visible: stitching and the
resolver halve the pops; smoothing lifts steady links from 79% to 98.3%
(timestamp jitter wobbled a fifth of all drawn links, far beyond the
extreme scenes that prompted the work); the false-absorption hover
appears exactly at `4c791a0` and is removed by the temporal gate. The
zero hover readings on older states are correct, not blind spots -- that
artifact class arrived with stitching; the older pathology was pops and
wobble, which the audit counts separately. Seam jumps are zero at every
state, confirming the smoothing plumbing keeps handoffs continuous.

Remaining on the fixture at current: 622 pop-outs (0.8% of
observations), 25 backwards pops, 7 rush links, and 455 terminal links
whose arrival is capped by an early event record. These are the
truth-side numbers the cost-ranked assignment work (ROADMAP item 2)
must improve without the match rates being allowed to lie about it.

## Cost-forced assignment -- `f340943`

Parsimony phase 2: the residual resolver solves each component as
minimum-cost maximum flow and accepts, beyond the forced edges, any edge
whose rivals all cost more than `SHELL_MATCH_MARGIN` extra -- the
pairwise matcher's own three-pixel ambiguity unit, applied with
component-wide sight of which rivals are themselves needed elsewhere.
The first change judged by the drawn-motion audit, and it gains on both
axes:

* `rate_terminals_matched` 0.858193 -- up from 0.856739 (+35), a new best
* `rate_shells_matched_forward` 0.992122 -- up from 0.991566, a new best
* `rate_shells_unlinked` 0.003620 -- down from 0.003769, a new best
* unseen attributions +125 (pill 792 -> 864, tank 880 -> 933)
* drawn-motion audit: `pop_outs` 622 -> 581, backwards pops 25 -> 22,
  hovers and seam jumps still zero, steady-link rate flat
* bradian audit `no_model_s1` 72 -> 73, within noise

The margin dial was measured at 1, 3, 6 and 10: monotone, with margin 1
best on every visible metric (556 pop-outs, terminals 0.858858). It was
not taken: one pixel sits inside quantisation noise, where the audit is
blind to same-ray identity swaps that draw identically, and the
established ambiguity unit keeps the system explicable. The remaining
gap between margin 3 and margin 1 (~25 pop-outs) is the measured price
of that caution.

## Findings

* **The branch line now leads the branch point on every headline metric.** At
  `926f391` the forward match rate is 0.980136 against `main`'s 0.961100,
  unlinked shells 0.008081 against 0.016596, and terminal matching 0.849553
  against 0.817321. The branch spent `ad6a3b6` through `c848efd` behind the
  baseline; it is now clear of it on all three, and every headline record is
  held by the branch's own HEAD.
* **The pillbox-attribution regression is repaired.**
  `shells_with_pillbox_source` goes 22516 -> 44245 and `shells_from_pillbox`
  8666 -> 11663 at `4f5dbe9`, restoring what was lost between the branch point
  and `ad6a3b6` and then exceeding it. `terminals_unseen_pillbox_source` returns
  to the branch point's 393. This is the single largest movement in the file.
* **The gain is attributable to one commit.** `c848efd` and `dd553c5` add only
  tooling, and `4f5dbe9` is the sole commit in the span touching
  `viewer/motion.js`. Unlike the +201 tank hits below, this needs no caveat
  about a trio of commits.
* **The tank-hit work is a clear gain, and has kept going.** `ad6a3b6` to
  `5e69318` moves exactly one thing, `terminals_matched:tank_hit` 2581 to 2782,
  and everything else is flat to within a single shell. Caveat: that span covers
  three commits -- `422c5ff` (interpolate tanks for shot collisions), `18b51b9`
  (give shells a hitbox) and `5e69318` (the tolerance itself) -- so +201 is the
  trio's combined effect, not the tolerance commit measured alone. `4f5dbe9`
  adds a further +307, to 3089 of 3879, well past the branch point's 2826.
* **The four branch motion changes improve complementary things.** `4f5dbe9`
  recovered pillbox attribution and won terminals; `83cb132` recovered exact
  positions and lengthened shell chains; `5f9d86f` removes wrong-sign orbit
  candidates and lengthens them further; `926f391` widens the bound to index 1+
  tank shots. The middle two together gave back four of `4f5dbe9`'s 20360
  matched terminals, only 0.000167 of the rate, and `926f391` has since returned
  those four and 93 more.
* **`926f391` is the first commit to gain on both axes at once.** Every earlier
  branch motion commit either won terminals or won shell links and paid a couple
  of terminals for them. This one takes both records together: +160 shells
  matched forward and +97 terminals. That is the signature of admitting
  candidates a too-tight bound had excluded, rather than re-ranking the
  candidates already in hand.
* **Nothing measured so far trades away a whole metric class.** Across the ten
  commits the backwards movements on the branch line remain tiny:
  `base_damage` -1 at `4f5dbe9`, `tank_hit` -3 / `shell_falls` -1 at `83cb132`,
  `pillbox_damage` -2 at `5f9d86f`, and `explosion` -2 at `926f391`. There is
  no sign yet of a change that buys shell matching at the cost of terminal
  matching in any serious quantity.
* **The regression's origin is still unpinned, and now only of historical
  interest.** It was bracketed to `9bc584d` or `ad6a3b6`, both named "Stuff";
  measuring `9bc584d` would still say which introduced it, but the symptom is
  gone, so this is archaeology rather than a fix that is owed.
* **Tank and LGM position tracks are untouched** by anything in this range,
  across all ten commits measured.
* **Main's pillbox-birth rendering work composes with the branch gains.** The
  current merged state reports 20680 births: all 9017 tank-shell and 11663
  pillbox-shell origins. The branch-point numbers remain the right interpolation
  baseline, while v1.0.8 remains the right birth-rendering baseline.
* **Historical `shell_births` values are not comparable until the main merge.**
  The branch-only checkpoints report 9021 because they lack `f4f15d9`; the
  current 20680 is comparable with v1.0.8's 20681. It now sits one *below* it,
  having peaked at 20684 at `5f9d86f`. The swing is entirely the tank-origin
  count: 9021 -> 9017 at `926f391`, against a pillbox contribution of 11663
  fixed since `4f5dbe9`. This is a reclassification, not a rendering loss -- the
  two pillbox shells `5f9d86f` held over v1.0.8 are still there, and the four
  shells that left are index 1+ tank shots that no longer claim a confident
  origin.
