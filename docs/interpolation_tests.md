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
`main`'s own HEAD when this file was started; the `ffb7fd3` run was the branch's
own clean HEAD, with the tool already in the tree and byte-identical to `main`'s
(`git diff main HEAD -- tools/report-interpolation-rates.cjs` empty).
`tools/report-interpolation-rates.cjs` has not changed since `86807e0`, its
only commit. `main` has since gained `1db6e3f` and the three commits before it,
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
* `rate_links_pill_vouched` / `rate_links_pill_contradicted` -- the truth axis
  the coverage rates lack. Every shell-to-shell link of a pill chain whose
  ends both pin an orbit step is scored against the advance the pill's own
  statements elected over that record pair (the roster vote the matchers
  consult): vouched when the step gap equals it, contradicted when a vote
  passed and the link disagrees, unvouched when no vote passed and the link
  stands on cost margins alone. The rates are over the scored population;
  `links_pill_unpinned`, `links_pill_restated` (verbatim re-sends, zero
  advance by identity), `links_visual` and `links_no_pill_source` are
  reported beside them so the denominator is honest. Contradicted is a
  regression alarm, not a coverage figure; `--describe-links` prints
  every contradiction as a scene (record times, pill, steps, elected
  advance) with a class tally by how far the link disagrees, plus the
  matcher's own election over that pair as it saw it -- verdict,
  advance, score against runner-up, the pinned source steps with "d"
  on members that held a terminal candidate, the pinned landings --
  and both rosters as final state pins them.
* `roster_votes_unvoted` / `roster_votes_stood_down` /
  `roster_votes_passed` -- how often the matcher's election was
  available at all: a pill with under three pinned sources cannot vote,
  a vote inside the score-3 / margin-2 gates stands down. On the
  fixture 9,918 / 2,538 / 3,171: the vote decides one election in five.
* `pairs_pill_order` / `pairs_pill_order_kept` / `pairs_pill_order_blurred`
  / `pairs_pill_order_inverted` and `rate_pairs_pill_order_inverted` -- the
  distance-order axis (`score_pill_order` in `viewer/motion.js`). Every live
  shell of one pill advances one orbit step per sender update, so between
  two statements the pill's shells keep their order of distance from it: a
  trailer never passes its leader while both fly. Unlike the vouched /
  contradicted axis this needs no pinned step, so it also covers the pairs
  the lockstep passes skip (plural states disagreeing on a step, shells on
  different bradians). A pair is two shells of one pill in one snapshot
  whose links both land in one later snapshot (visual joins and verbatim
  re-sends excluded): kept when the order holds, inverted when it flips by
  more than the positions can lie -- the spread of the orbits' distance-
  to-step mapping across bradians, about three pixels, widened by the
  chained-offset uncertainty of any member not pinned to an exact orbit
  pixel -- and blurred when it flips within that. A pill fires no faster
  than every five or six ticks, so two of its live shells are at least
  two steps and over five pixels apart: a blurred pair is closer than two
  rightly placed shells can be, one of its positions or provenances
  wrong, a different complaint from a crossing. Inverted is a regression alarm like
  contradicted, not a coverage figure; `--describe-links` prints every
  inversion as an `order_example` scene (record times, pill, and each
  shell's distance, step and bradians at both ends of its link, with the
  stitched links marked) under an `order_class` tally by which link was a
  stitch and the narrower gap in whole steps. On the fixture 58,171 pairs,
  3 inverted, 0 blurred: all three are stitched links crossing a pairwise
  one, the leader's stitch landing three steps on where the trailer's link
  landed seven or nine.
* `pairs_tank_order` / `pairs_tank_order_kept` / `pairs_tank_order_blurred`
  / `pairs_tank_order_inverted` and `rate_pairs_tank_order_inverted` -- the
  tank-side order axis (`score_tank_order` in `viewer/motion.js`). A shell
  flies at 2 px/tick and a tank at most 1, so two shells of one tank on one
  heading keep their order along it: the later shot starts behind by at
  least the reload's length in pixels and the two then advance alike. The
  order of distance from the tank across headings is only nearly kept (a
  full-speed S-turn on road can put the later shell a tile further out in
  the first shell's last second), so the axis reads same-sector pairs of
  tank-born shells only, where the invariant is exact, each shell read as
  its position along the sector's centre line. Inverted when the order
  flips by more than three pixels plus the chained-offset slack of the
  members, blurred inside that (closer than two shots a reload apart can
  be). The scenes print under the same `order_example` / `order_class`
  lines as the pill axis, tagged `tank`, with each shell's advance along
  the line and its list index. On the fixture 9,129 pairs, 1 inverted, 1
  blurred; over the ten pairs 45,194 pairs, 14 inverted (seven scenes,
  each seen by both recorders); on `040601.6` 22,332 pairs and none. Every
  inversion is an identity swap between two shells on one line whose true
  continuations lie outside the interval's readings, so the swapped hops
  were the only candidates each shell had; the tank lockstep
  (`enforce_tank_lockstep_candidates`, INTERPOLATION.md) prunes among
  candidates and so reaches none of them, while moving about twenty other
  links over the ten pairs in the paired audit's favour (45,176 pairs
  once a shell that may have died abstains from the vote, `7290254`).
* Tank and LGM track coverage is reported too, but is byte-identical at all ten
  commits, so it is omitted below. For the record: `rate_tank_ticks_interpolated`
  0.687960 and `rate_lgm_ticks_interpolated` 0.435824 throughout. Note that the
  tick-weighted rate is the honest measure of how much of the replay is actually
  smooth; the per-segment rate flatters it badly (0.951096 for tanks).

## v1.0.7 -- `3f359d1` "rejoin / alliance issues"

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

## Branch point -- `main` at `86807e0`

The engine here was identical to the branch point `dca51d8` when this file was
started: every commit `main` had gained since then was a FORMAT.md edit or the
report tool. So this is the baseline the branch should be judged against, not a
parallel line of work. `main` has moved on since, and
`git diff dca51d8 main -- viewer/ src/` is no longer empty -- but the only
engine change in it is `6a83ce0`, whose effect on the report is one line
(`shell_births`), recorded under v1.0.8 below.

* `rate_shells_matched_forward` 0.961100 -- tied with v1.0.8; the best measured
  until `63b2e71`
* `rate_shells_unlinked` 0.016596 -- tied with v1.0.8; the best measured until
  `63b2e71`
* `rate_terminals_matched` 0.817321 -- tied with v1.0.8; the best measured until
  `63b2e71`
* `terminals_matched:tank_hit` 2826 of 3879
* `shells_from_pillbox` 11661
* `shells_with_pillbox_source` 41881
* `shells_with_birth` 28001 -- births now known well beyond tank shells
* `terminals_unseen_pillbox_source` 393

Versus v1.0.7 this is a gain across the board: +3.2 points of shell matching,
+4.6 points of terminal matching, and unlinked shells roughly halved.

## v1.0.8 -- `c15ed26` "aesthetic improvement"

Identical to the branch point everywhere but one line. The whole report diff
against `86807e0` is:

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
tank shell lost one. This is `6a83ce0` "Pillbox shots visible right from the
start", which extends `build_shell_births` in `viewer/motion.js` to derive a
start point from `pillbox_source_distance` instead of skipping non-tank shells.
The two later commits, `2f576f8` (a version label in the menu) and `c15ed26`
(pillbox draw order), touch only `viewer/main.js` and `viewer/renderer.js` and
cannot move the report.

This is a gain in what can be drawn, not in what is understood: it adds the
muzzle-to-first-sighting segment for pillbox shells, and does not change which
shells are matched to which, or which terminals are explained.

## Branch -- `15770f0` "Stuff"

* `rate_shells_matched_forward` 0.911773 -- down 4.9 points from the branch point
* `rate_shells_unlinked` 0.054411 -- up from 0.016596, more than tripled
* `rate_terminals_matched` 0.797674 -- down 2.0 points
* `terminals_matched:tank_hit` 2581 of 3879 -- down 245
* `shells_from_pillbox` 8666 -- down from 11661
* `shells_with_pillbox_source` 22517 -- roughly half of the branch point's 41881
* `shells_with_birth` 27968 -- retained
* `terminals_unseen_pillbox_source` 424

## Branch -- `37acbc7` "consider this tolerance rather than shell sprite size"

* `rate_shells_matched_forward` 0.914431
* `rate_shells_unlinked` 0.054005
* `rate_terminals_matched` 0.805940 -- up 0.8 points from `15770f0`
* `terminals_matched:tank_hit` 2782 of 3879 -- **up 201** from `15770f0`
* `shells_from_pillbox` 8666 -- unchanged
* `shells_with_pillbox_source` 22516 -- unchanged bar one shell
* `shells_with_birth` 27968 -- unchanged
* `terminals_unseen_pillbox_source` 424 -- unchanged

## Branch -- `8aa9506` "Stuff"

A confirmation run rather than a new data point. `8aa9506` adds
`tools/measure-pillbox-tank-hit-tolerance.cjs` and a `package.json` script, and
`39da396` after it adds only `tools/_check_death_impact_codes.cjs`; neither
touches engine code. Every metric is identical to `37acbc7`. Recorded so the
next section's gain can be pinned to a single commit.

## Branch -- `63b2e71` "Possible fix to a bad assumption", `using_the_pillbox_data` checkpoint

The first state to beat the branch point on every headline metric. It held the
best `rate_terminals_matched` for the next four measured commits; `d52f860`
below took the two shell-matching rates off it, and `ffb7fd3` has since taken
the terminal rate too.

* `rate_shells_matched_forward` 0.971011 -- up 5.7 points from `37acbc7`, and
  1.0 point above the branch point, the previous best
* `rate_shells_unlinked` 0.012094 -- down from 0.054005, and below the branch
  point's 0.016596
* `rate_terminals_matched` 0.845691 -- up 4.0 points from `37acbc7`, 2.8 above
  the branch point
* `terminals_matched:tank_hit` 3089 of 3879 -- up 307 from `37acbc7`, and 263
  above the branch point's 2826
* `shells_from_pillbox` 11663 -- recovered from 8666, two above the branch
  point's 11661
* `shells_with_pillbox_source` 44245 -- recovered from 22516, and 2364 above the
  branch point's 41881
* `shells_with_birth` 28006 -- up 38 from `37acbc7`, 5 above the branch point
* `shells_from_tank` 9021 -- up one from 9020
* `terminals_unseen_pillbox_source` 393 -- back to the branch point's value
* `shell_births` 9021 -- tank shells only; the branch does not carry `main`'s
  `6a83ce0`, so this is not comparable with v1.0.8's 20681
* `max_shell_interpolation_ticks` 50

The rest of the terminal breakdown moves the same way: `explosion` 1589 -> 1829,
`pillbox_damage` 5607 -> 5931, `shell_falls` 8311 -> 8398, and `base_damage`
1114 -> 1113, the one metric that goes backwards, by a single terminal.

`63b2e71` is the only commit in this span touching `viewer/motion.js`, so the
whole gain is its own -- no trio to disentangle this time.

## Branch of the branch -- `d52f860` "Try to determine true location from quantized pillbox shots", `using_the_pillbox_data_antifuzz` checkpoint

`using_the_pillbox_data_antifuzz` is `using_the_pillbox_data` plus this one
commit, so again the whole delta is attributable to it. It touches
`viewer/motion.js` and `viewer/pillbox_shell_orbits.js`. Its message warns
"possibly interrupted work", but the tree is not in a broken state: `npm test`
passes at this commit, 181 checks, no failures.

The trade is a real gain in shell matching against a rounding-error loss in
terminal matching.

* `rate_shells_matched_forward` 0.976801 -- up 0.58 points from `63b2e71`, the
  best measured
* `rate_shells_unlinked` 0.009342 -- down from 0.012094, the best measured and
  the first time this metric has gone below 1%
* `rate_terminals_matched` 0.845607 -- **down** 0.000084 from `63b2e71`, i.e.
  two terminals out of 24075. `63b2e71` keeps the record here, and holds it
  until `ffb7fd3`.
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
  all unchanged from `63b2e71`
* `max_shell_interpolation_ticks` 50

Reading the shape of it: the commit does not find new shells or new pillbox
attributions -- every origin and birth count is untouched -- it keeps existing
shells alive across more snapshot-to-snapshot links. That is what a better
estimate of a quantised shot's true position would be expected to do, and it is
consistent with the commit's stated aim. The two lost terminals are the cost of
those firmer chains occasionally preferring a snapshot successor to an impact.

## Branch after merging main -- `07b6bd9` "errors are one-sided", `using_the_pillbox_data_antifuzz` HEAD

This state includes the merge from `main`, `142718b`'s adjustment of pillbox
birth segments to exact recovered orbit positions, and `07b6bd9`'s one-sided
quantisation bound. The merge and `142718b` affect drawing and birth records;
`07b6bd9` is the engine change responsible for the shell-linkage delta below.
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
  terminals out of 24075; `63b2e71` still holds the terminal-matching record at
  this point, and keeps it until `ffb7fd3`
* `shells_matched_to_snapshot` 51772 -- up 88 from 51684
* `shells_unmatched_forward` 1625 -- down 86 from 1711
* `terminals_matched:tank_hit` 3086 and
  `terminals_matched:shell_falls` 8397 -- unchanged
* `terminals_matched:pillbox_damage` 5931 -- down 2 from 5933
* `shells_with_pillbox_source` 44245 -- up 6, returning to `63b2e71`'s best
* `shells_from_pillbox` 11663, `shells_from_tank` 9021,
  `shells_with_birth` 28006 and `terminals_unseen_pillbox_source` 393 --
  unchanged
* `shell_births` 20684 -- now includes both 9021 tank and 11663 pillbox births
  after merging main's `6a83ce0`; unlike the earlier branch-only values, this
  is directly comparable with v1.0.8's 20681
* `max_shell_interpolation_ticks` 50

The sign constraint also survives direct replay audits: every exact position
recovered for 1752 non-head shell observations in corpus replay md5
`0f691e1d594c0a6636c25578d7d4fa17`, and all 19162 in the sample fixture, lies
inside the one-sided bound. The original two-shell
case at record 1251 remains resolved to its two distinct orbit states and
shell-fall terminals.

## Branch -- `ffb7fd3` "Tank shots in index 1+ have uncertainty too", `using_the_pillbox_data_antifuzz` HEAD

The first state to hold all three headline records at once. `9e0ff73` between
this and `07b6bd9` edits only this file, so the whole delta belongs to
`ffb7fd3`. `npm test` passes here, 187 checks, no failures.

Where the previous three motion commits each bought shell continuity by giving
terminals back, this one gains on both axes together.

* `rate_shells_matched_forward` 0.980136 -- up from 0.977967, a new best
* `rate_shells_unlinked` 0.008081 -- down from 0.008637, a new best
* `rate_terminals_matched` 0.849553 -- up from 0.845524, and 0.003862 above
  `63b2e71`'s 0.845691, which had stood since it was measured. First movement
  of this record since `63b2e71`.
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
  `63b2e71`'s 3089
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

## Tank shells join the discrete simulation -- `20e863d`

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
`ffb7fd3`, and the first to gain on every one of them simultaneously:

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

## Chain stitching -- `ecd220c`

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
  +561 links, against the +23 of `20e863d` and the +160 of `ffb7fd3`
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

## Forced residual assignment -- `bb6f769`

The safe core of issue #15. After matching and stitching, one client's
leftovers form a bipartite problem -- suppliers of a shell identity
(unaccounted chain ends, unconsumed fired shots) against consumers of one
(origin-less chain starts, unexplained impacts) -- and a per-component
maximum-flow solver accepts exactly the assignments present in every
maximum assignment. Ambiguity stays unexplained; the only consistent
story gets told, including conclusions pairwise margins cannot reach.

* `rate_terminals_matched` 0.856698 -- up from 0.850218, a new best and
  the largest terminal gain since `63b2e71`; +156 terminals, all five
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

Cumulative for the branch line against `ffb7fd3`: forward matching
0.980136 -> 0.990889, unlinked 0.008081 -> 0.004434 (nearly halved),
terminals 0.849553 -> 0.856698.

## Jitter absorption and constant-velocity drawing -- `fb06764`

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
| `2680d76` pre-branch | 0.787 | 1465 | 62 | 0 | 0 |
| `ecd220c` stitching | 0.780 | 881 | 42 | 0 | 0 |
| `bb6f769` resolver | 0.779 | 672 | 29 | 0 | 0 |
| `fb06764` smoothing, ungated | 0.983 | 619 | 23 | 1 | 13 |
| `963f191` temporal gate | 0.983 | 622 | 25 | 0 | 7 |

Every known event in the branch history is visible: stitching and the
resolver halve the pops; smoothing lifts steady links from 79% to 98.3%
(timestamp jitter wobbled a fifth of all drawn links, far beyond the
extreme scenes that prompted the work); the false-absorption hover
appears exactly at `fb06764` and is removed by the temporal gate. The
zero hover readings on older states are correct, not blind spots -- that
artifact class arrived with stitching; the older pathology was pops and
wobble, which the audit counts separately. Seam jumps are zero at every
state, confirming the smoothing plumbing keeps handoffs continuous.

Remaining on the fixture at current: 622 pop-outs (0.8% of
observations), 25 backwards pops, 7 rush links, and 455 terminal links
whose arrival is capped by an early event record. These are the
truth-side numbers the cost-ranked assignment work (ROADMAP item 2)
must improve without the match rates being allowed to lie about it.

### The rush split

A rush was scored as distance over duration, with a zero-duration link
counted as infinitely fast, so the rush lines could not tell a link
drawn fast from one drawn in no time at all. The tool now splits each
rush line three ways, and the parts sum to the undivided line, which
keeps its old definition so the archived runs stay comparable:

* *timed* (`terminal_links_rushed_timed`, `rush_links_timed`): positive
  duration, above 3 px/tick -- the arrival capped by an event record
  that landed early, the class the line was always described as;
* *static* (`terminal_links_static`, `links_static`): zero duration and
  under half a pixel of length, drawing nothing -- a verbatim re-send
  under a fresh stamp, or a terminal matched where the shell already
  was;
* *instant* (`terminal_links_instant`, `links_instant`): zero duration
  with real length, the cap taken to its limit -- the event record
  carries the same stamp as the shell's last statement while the shell
  still had a step or two to fly, so the effect appears a few pixels on
  with no link drawn.

The split reads the two fixtures very differently, and corrects the
description above. On `n20021018.2` the 461 rushed terminal links are 5
timed and 456 static, all of the static ones box terminals (tank hits,
pill and base damage, explosions) whose shell was last stated already
inside the 16 px box: the effect draws where the shell was and there is
nothing to animate. The "455 terminal links whose arrival is capped by
an early event record" were never that; the capped class on an ordinary
ring is five links. On the fast-ring `040601.6` the 831 are 377 timed,
386 static and 68 instant -- the ring's 1-3 tick cadence lands event
records against shells still in flight, so the cap bites there and
nowhere else -- and its 1,104 rush links are 19 timed and 1,085 static,
the decomposition the fast-ring re-sends entry (`efe9ab2`) had done by
hand on that log. The `b9db294` step-zero matches land where the
reasoning said they would: against `0263483` the first form's extra
rushed links on `n20021018.2` are static 456 -> 592 with timed 5 -> 5,
and on `040601.6` static 386 -> 412 with timed 377 -> 381.

`--engine=DIR` runs the tool against another checkout's engine (a git
worktree of an older commit) and reports that checkout's commit, so a
historical state can be re-measured under a newer tool without dropping
the tool into the old tree. The corpus runs of the split are in
[`interpolation_tests_corpus.md`](interpolation_tests_corpus.md) under
the rush split section.

## Cost-forced assignment -- `dafa8d8`

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

## Pop rescue -- dilated and visual joins, `6b4140d`

The first change aimed squarely at the audit's headline artifact: the
forward-paired pop, a shell vanishing and an origin-less shell appearing
ahead of it on the same ray -- one shell drawn as two. Two mechanisms,
both bounded by the recovered physics:

* **Dilated joins**: stitching retried under time-only widened windows,
  at a penalty cost, for chains fragmented by sender clock dilation.
  Spatial exactness is untouched -- pill candidates must still sit on a
  surviving orbit, tank candidates must still satisfy a reachable
  bradian state; only the update-count window stretches.
* **Visual joins**: where identity is genuinely ambiguous (same-ray
  rivals inside the margin) but every candidate story draws the same
  line, the link is drawn without being believed -- `visual_join`
  continues the sprite but propagates no identity, no birth, no fate.
  This replaces the old behaviour of freezing the sprite at its packet
  position, a deliberate philosophy change: ambiguity about *which*
  shell this is need not cost the certainty that *a* shell flies on.

Fixture, against `dafa8d8`:

* audit `pops_paired_forward` 187 -> 20 (-89%); `pop_outs` 581 -> 411;
  backwards pops 22 -> 6; seam jumps still zero
* `rate_shells_matched_forward` 0.994427 -- up from 0.992122, a new best
* `rate_shells_unlinked` 0.002535 -- down from 0.003620, a new best
* `shells_visual_joins` 14
* `rate_terminals_matched` 0.856366 -- down from 0.858193, a give-back
  of 45 terminals: continue-vs-die reassignments, where a rescued
  continuation now outranks a previously inferred death. Which story is
  true is exactly what the record cannot say; the continuation is at
  least *seen*. Flagged for judgment rather than tuned away.
* steady links 0.983 -> 0.979, and 2 hover links appear -- dilated joins
  draw slower than 2 px/tick across stretched intervals, by construction
* bradian audit `no_model_s1` 73 -> 88 -- the rescued chains are the
  genuinely clock-dilated ones, so the strict per-update model rejects
  more of them once they are long enough to test; expected

## v1.0.9 -- `6254551` "Update builder.py"

The release is engine-identical to `6b4140d` above, so the pop-rescue numbers
are the release's numbers: `rate_shells_matched_forward` 0.994427,
`rate_shells_unlinked` 0.002535, `rate_terminals_matched` 0.856366. Between
the two commits sit only docs, two audit tools (`find-seam-jumps`,
`find-hover-links`), packaging (`viewer/builder.py`) and UI-only work in
`viewer/main.js` and `viewer/renderer.js` (loading bar, menu rearrange,
raw-shell-dots overlay) -- nothing the report loads, which is `logparse.js`,
`game.js`, `motion.js` and `network.js`, all byte-identical across the span.
The one engine change in between, `fdb72f1`'s hold-then-fly re-timing, was
reverted by `0439893` before the tag, and `git diff fdb72f1~1 0439893` is
empty, so the revert is clean. Everything measured after `6b4140d`
(`6787773` onward) is post-release.

## Leading impacts -- `6787773`

Dilated joins covered the clock lie in one direction; this covers the
other. A chain end whose restatement arrived late understates its
remaining flight, so an authoritative impact record can arrive *before*
the arrival estimate computed from the end's receiver timestamp, and the
residual pass could build no end-to-fate edge at all. The motivating
case (replay 072402.1, records ~10186-10195, two tank shots on one ray)
showed the failure shape clearly: with the true fate edge missing, the
maximum-flow story explained one fewer leftover, cost-forcing flew the
*younger* shot's first observation straight into the fall, and that
shot's real second restatement was left as a frozen orphan pop-in.

The fix admits residual end-to-fate edges whose distance exceeds the
receiver-clock window, with the lead bounded by the gap back to the
sender's previous record (the most that timestamp can be lying by,
capped at half a second) and carrying the dilated penalty so an
in-window story is always preferred. No cost tuning was needed for the
motivating case: once the missing edge exists, the true story explains
strictly more of the residue and value-forcing picks it.

Fixture, against `76c6c85` (identical engine to `6b4140d` for these
numbers):

* `rate_shells_matched_forward` 0.994427 -> 0.994888, a new best
* `rate_shells_unlinked` 0.002535 -> 0.002291, a new best
* `rate_terminals_matched` 0.856366 -> 0.857362, a new best -- +24
  terminals (`tank_hit` +16, `pillbox_damage` +8), with no per-type
  give-back
* audit `pop_outs` 411 -> 377, backwards pops 6 -> 5, seam jumps still
  zero
* `terminal_links_rushed` 458 -> 478 and steady links 0.979004 ->
  0.978496 -- a lead match caps its arrival at the fate record's time,
  so the final link draws faster than 2 px/tick; the same capped-arrival
  cost the matcher already accepted for lagging events, now paid by the
  rescued chains too
* Corpus: measured, and the story survives the scale-up at roughly 100x
  the fixture's deltas with all three headline records taken together --
  see the `6787773` entry in
  [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md).

## Uncapped shell falls -- drawing only

The first bite at the rushed-terminal class. An arrival is capped at the
event record's time because the record drops the shell from packet state
and an object impact's flash belongs beside its authoritative state
change -- but a shell fall has no coupled state, so its splash time is
purely cosmetic. Falls now keep their 2 px/tick physics arrival even
past the record: the splash retimes with it (the effects array is
sorted after all retiming, so later is as legal as earlier), and *fall
segments* -- the mirror of birth segments -- carry the sprite from the
moment state loses it to the retimed splash, replaying the link's own
lerp so the handoff is seamless. Object impacts and blocking terrain
stay capped.

Fixture:

* every line of the interpolation report is byte-identical -- the change
  is drawing-only, as intended; matching decisions do not depend on the
  cap
* audit `terminal_links_rushed` 478 -> 473; on the motivating replay
  072402.1 it is 267 -> 206. The falls share of the class is small on
  the fixture and large on laggy replays; the corpus number is the one
  to watch. The remainder is object impacts, capped by design.
* everything else in the audit byte-identical
* Corpus: `terminal_links_rushed` down 12.8%, landing below the
  pre-lead-fix baseline, with a three-in-ten-million favourable wiggle
  in the matching numbers the fixture could not see -- see the
  `f8ec4d5` entry in
  [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md).
* The wiggle exposed a real coupling: the candidate `end_time` fed both
  the equivalence rule's time gate and the renderer. `3c5edf5` splits
  them -- `end_time` stays the capped decision quantity, `draw_end_time`
  (uncapped for falls only) is what gets drawn -- making the change
  genuinely drawing-only. Fixture and replay metrics byte-identical
  either side of the split.

## Orbit-backed absorption and its guards -- `b29240b` + `8d310e3`

A pill shot's orbit can absorb a stitch-skipped restatement the
temporal gate strands: an exact orbit point, on a bradian surviving at
both ends of the stitch, strictly between their steps, is absorbed
however badly the sender's clock lied (`b29240b`, from replay
101202.10's pillbox 3, where the gate lost by 0.372 px and the shell
drew a 19 px backwards jump, a ten-tick hover and a 41 px rush).
`8d310e3` guards it both ways for dense streams: at most one candidate
per snapshot -- an angry pillbox fires every five or six ticks, so
stream-mates ride two or three steps apart and nothing in one snapshot
says which observation is the reconnected shell -- and an observation
the surviving orbits rule out is refused before the geometric gate can
absorb it.

Fixture:

* `b29240b`: shells matched forward 73,376 -> 73,379, unlinked
  169 -> 166, terminals unchanged; audit hover 2 -> 3 and rush 7 -> 8,
  observations entering the link structure that used to pop invisibly.
* `8d310e3`: matched forward -> 73,369, unlinked -> 172, terminals
  20,641 -> 20,638 -- the same-time double-absorbed pairs (seven
  snapshots on the fixture) leaving the ledger; audit rush links
  8 -> 1 and the 3.0+ speed bucket 8 -> 1, `pop_outs` 374 -> 384.
* Seam jumps 0 throughout on the fixture.
* Corpus: rush links down 17.5%, terminals flat, backwards pops up 278
  -- see the branch entry in
  [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md).

## The vouched-link metric -- measurement only

The headline rates count explanations, and a wrong link scores the same
as a right one, which is why honest give-backs have always read as
losses. With the statement-roster vote in the engine, every pill link
can now be scored against it after the fact (`score_pill_links` in
`viewer/motion.js`, reported by `report-interpolation-rates.cjs` as the
`links_*` lines and the two `rate_links_pill_*` rates). Nothing in the
engine changes; the scorer reads final state.

Fixture (`n20021018.2`):

* 52,759 shell-to-shell links: 19,797 from chains with no pill source,
  3 visual joins, 0 verbatim re-sends, 52 with an unpinned end
  (exactness lost downstream of a stitch -- roadmap item 8's debt, now
  with a number), leaving 32,907 scored.
* `rate_links_pill_vouched` 0.608351 (20,019),
  `rate_links_pill_contradicted` 0.000182 (6), unvouched 12,882.
* The six contradictions are all pairwise links on client 2, and they
  look real. Five are one scene: records #111355 -> #111359 (player 2,
  ticks 9,726,673 -> 9,726,685, 7521.1 s into the replay), the pill at
  pixel (1872, 2272) with seven live shells on bradian 231 at steps
  6/9/11/14/17/19/22, restated twelve ticks later at 14/17/19/22/25.
  The engine linked 19->25, 17->22, 14->19, 11->17 and 9->14 -- step
  advances of 6, 5, 5, 6, 5, mixed within one pill over one interval,
  which lockstep forbids -- popped the step-6 shell, and matched 22 to
  a tank-hit box. The roster elects 8 (five exact landings against
  three for 5 and two for 6), under which every shell advances
  together, 6 becomes the 14, 17 becomes the 25 that hits the tank,
  and 19 and 22 are the two deaths. Record #111355 arrived 16 ticks
  after the sender's previous record and #111359 a punctual 12 after
  it: the first stamp was late, the interval reads compressed, and
  cost preferred the shorter hops. At match time the deep list members
  were still unpinned (chained-offset quantisation), so the roster vote
  had too few landings to pass and stood down; the chain's later links
  pinned them, and the post-hoc vote sees the ladder shifted one rung.
  The sixth, records #81575 -> #81579 (ticks 9,627,041 -> 9,627,057),
  is a single link of the pill at (2064, 1792) advancing 9 against an
  elected 6. The first scenes the metric has named; on the books, not
  chased.

Fast-ring fixture (`040601.6`):

* 80,432 links, 1,679 of them verbatim re-sends, 33,142 without a pill
  source, 4 visual joins, 153 unpinned; 45,454 scored, 26,962 vouched
  (0.593171), **0 contradicted**, 18,492 unvouched.
* The zero is the scorer's own correction. The engine's vote table is
  keyed by record time, and on a fast ring two snapshots can share a
  time, so the one-hop and the composed two-hop span write the same key
  and the last writer wins. Scored through time keys the fixture showed
  381 contradictions, every one on a same-time pair with the link
  advancing 1 against a "vote" of 2; keyed by snapshot index they
  vanish. The engine's stitching and residual passes still read the
  time-keyed table, so on a fast ring a join across a same-time pair can
  be gated by the neighbouring span's advance -- a quirk now noted at
  `unanimous_lockstep_advance` and left as measured, since fixing it is
  an engine change that wants the corpus rig.

Both fixtures' counts are pinned in `test/test-viewer.cjs`.

## Doubtful voters abstain -- the roster election's alias tie-break

The metric's first named scene, chased at the owner's request after
watching the trailing shell vanish. Records #111355 -> #111359 on
client 2 (above): the match-time roster vote had 5 landings for
advance 8 against 4 for advance 3, one short of the margin gate, so it
stood down and cost linked the ladder one rung short. Advance 3 is the
rung-shift alias -- a near-regular ladder maps onto its own future at
the true advance minus the fire cadence -- and its deciding fourth
vote was cast by the step-22 shell, which in fact died in the tank-hit
box that record: a dead shell's position plus one cadence landed on
its neighbour's true landing. The target record carried a second
tank-hit that the engine's story left unmatched; under advance 8 the
step-19 shell dies in it, the trailing shell continues, and nothing
pops.

The dial (`enforce_roster_lockstep_candidates`): a member holding a
terminal candidate over the pair is a doubtful voter. The election is
held twice -- doubtful members abstain from the vote that must pass
the score-3 / margin-2 gates, and the full roster must still rank the
same advance first (ties allowed). Abstention can only lower scores,
so an alias the full vote would not lead can never win through it;
what the rule buys is the margin a dead shell's coincidence was
denying. A death stays undecided at match time exactly as before: the
passing vote prunes candidates by lockstep physics, and a doubtful
member that in fact continued keeps its lockstep-consistent
continuation.

Fixture, against the `1ea546c` state:

* `shells_matched_forward` 73,454 -> 73,460, `shells_unlinked`
  137 -> 136, `terminals_matched` 20,695 -> 20,696 (`tank_hit` +1: the
  second hit in the scene), `shell_births` 20,731 -> 20,727 with
  `shells_unseen_pillbox_birth` 21 -> 20 and `shells_stream_birth`
  7 -> 4 -- mints that were mis-linked ladders being re-minted, now
  linked instead. `flow_components` 1,220 -> 1,217.
* Contradictions 6 -> **0**: all six, the 9,627,041 scene included, were
  this one mechanism. Vouched 20,019 -> 20,049, unvouched
  12,882 -> 12,866, unpinned 52 -> 51.
* Audit: `pop_outs` 299 -> 293, `pop_ins` 263 -> 262,
  `pops_paired_forward` 12 -> 11, `rate_links_steady`
  0.978165 -> 0.978660 (the 1.5-1.8 bucket -20, 2.2-2.5 -5, 1.8-2.2
  +31), hover / rush / seam untouched at 1 / 0 / 0.
* Fast-ring fixture: report and audit byte-identical.
* Corpus: both shell-side records move on (matched forward +103 with
  `pop_outs` -103, unlinked -36), terminals +135 (`tank_hit` +76),
  steady links to the audit era's best; contradictions 423 -> 437 and
  backwards pops +25 on the books -- see the branch entry in
  [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md).

## The symmetric election and the orphan tie-break

What the corpus links run at `0eba698` (every contradiction with the
matcher's own election attached) said, read off the file: of 340
pairwise contradictions, 335 were **stand-downs** and none a passed
vote, and in 369 of all 376 stand-downs the matcher's best advance was
the post-hoc vote's -- lost by a margin of one in 310 and a tie in 66.
The ladder alias is structural: a near-regular ladder maps onto its
own future at the true advance plus or minus its period, and a long
landing roster lets that alias score within one of the truth forever,
so the margin-2 gate is unattainable for long ladders. The run also
caught the first abstention dial regressing: in 84 of the 140 pairwise
stand-down scenes the FULL roster cleared the gates and only the
thinned confident vote (three of five members dying and abstaining)
blocked it -- contradictions that dial introduced, hidden inside a net
+14.

Two rules, scored against those 140 scenes before touching the engine
(`docs/interpolation_tests_corpus.md` has the matrix):

* **Symmetric abstention.** The election passes when either vote
  clears the gates while the other still ranks the same advance first
  (a confident roster too small to vote does not object). Rescues 84
  scenes.
* **Orphan tie-break.** An orphan landing is a pinned target beyond
  the advance with no pinned source one advance behind it; a newborn
  sits at step <= advance, so under the true advance an orphan can only
  be a source the matcher failed to pin, while under the alias they are
  structural. When the gate fails by one or a tie, an orphan-free
  leader whose every rival within one carries an orphan takes the
  election. Rescues 26 more; all 110 agree with the post-hoc vote and
  none disagree.

Fixture, against `480c1d2`:

* `shells_matched_forward` 73,460 -> 73,461, `shells_stream_birth`
  4 -> 3, `shell_births` 20,727 -> 20,726; `links_pill_unpinned`
  51 -> 48, vouched 20,049 -> 20,060, contradictions still 0;
  `roster_votes_passed` 3,171 -> 3,720 (stood down 2,538 -> 1,989).
* Audit: `pop_outs` 293 -> 292, `rate_links_steady`
  0.978660 -> 0.978888, hover / rush / seam untouched at 1 / 0 / 0.
* Fast-ring fixture: matching and audit byte-identical; elections
  passed 4,830 -> 5,289.
* Corpus: both shell-side records on by the largest step since
  `efe9ab2` (matched forward +675 with `pop_outs` -675, unlinked -236),
  contradictions 437 -> 89, every audit lie metric down -- see the
  branch entry in
  [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md).

The election record now also carries the pill's unpinned member count
(`unvoted(2 unpinned)`, `passed:full_tiebreak(1 unpinned)@...`), so an
orphan under the true advance can be read as the unpinned source it is.

## The sender's stale tank box -- either box counts

Prompted by replay `122204.3_ds.fredde_vs_oscar`, tick 5264529 (about
7554 records in): pill 10's direction-15 shell, pinned to bradian 233
step 7 at (1964, 2337), draws no further, and the `tank_hit` on tank 3
in player 2's very next record goes unexplained. Tank 3 is driving
south-east at full speed across the shell's path. The orbit walks past
the tank's south-west corner: at step 9 the shell centre is 2.8 px
outside the *interpolated* track box, past the 2 px tolerance, and every
later step is further out because the box keeps moving east while the
shell moves west. Against the box the packet itself states -- tank 3's
5264529 restatement -- step 10 is 2 px outside, inside the tolerance.

That packet box is the honest one for this collision. It happened in
the sender's simulation, and the sender's picture of a remote tank is
the last restatement it received: in ring order player 3's record
follows player 2's, so the freshest position player 2 had during the
interval was the one the recorder had logged a round earlier, which is
exactly the packet box. The track refinement (`09155b1`) was written for
a tank driving *into* a shell earlier than its packet box suggests; for
a tank driving away it moves the box out from under a graze the sender
registered. `pillbox_shell_terminal_match` now walks the orbit against
the track box as before and, when that walk finds nothing, walks it
again against the packet box, placing the effect on the box the shell
entered. Only the pill-orbit branch changes: the ordinary ray branch
never used the track.

The first form of this (`b9db294`) tested both boxes at every step and
took the first entry. The corpus run caught what the fixture rates
could not: `terminal_links_rushed` 69,287 -> 82,149 while terminal links
rose by only 1,827. Every new rushed link was the same shape -- a shell
last seen where the tank is *about to be*, inside the packet box at
step zero, matched as a zero-length, zero-duration link where the
track walk had found the collision a step or two on at 2 px/tick. The
track now keeps first refusal over the whole walk, and the packet-box
walk never starts at step zero. On the three local files that removes
every one of the new rushed links (the three left on `040601.6` are
rescued shells whose arrival is capped at a hit record one tick later,
the cost already accepted for lagging events), at a price of two tank
hits over the three files against the first form.

Fixture, against `7e3833b`:

* `rate_shells_matched_forward` 0.996041 -> 0.996298
* `rate_shells_unlinked` 0.001844 -> 0.001736 (136 -> 128)
* `rate_terminals_matched` 0.859647 -> 0.860478 -- +20 net:
  `tank_hit` 3189 -> 3212, `pillbox_damage` -2, `shell_falls` -1
* `links_pill_vouched` 20060 -> 20080, contradicted still 0
* Over the fixture, `040601.6` and the motivating replay together:
  `tank_hit` 4285 -> 4327, unlinked 263 -> 248, contradicted 0
* Audit: `pop_outs` 292 -> 273, `terminal_links_rushed` 461 -> 461
  (the first form had it at 598), seam jumps still zero
* A 3 px tolerance instead recovers the scene too (`tank_hit` 4317 over
  the same three files) but is a fudge where this is the mechanism
* Corpus: both forms are measured under `b9db294` in
  [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md); the
  restructured walk (`0263483`) keeps `tank_hit` +1,552 and pop-outs
  -1,531 over 443 logs with `terminal_links_rushed` back within 124 of
  baseline

The scene is pinned in `test/test-viewer.cjs` ("tank-hit box the sender
knew recovers a graze the track has left"), with the tank restated
*after* the hit record as in the log, and fails on the previous engine.

## Tank births follow the record gap

Prompted by replay `2de598ba-20011027C_XD_palptrex_pinsnix` at 4:21 (tick
13072 from the log's start): player 2's tank, parked at 146,133 facing
west, fires two shots per record at the wall at 142,133 while pill 13
fires back through it. The records come 28 ticks apart, the tank fires
every 14, so every record restates a fresh volley at almost the previous
volley's pixels -- head at 2295 then 2294, the second shell at 2321 both
times -- beside the previous volley's impacts. The first shot, seven
pixels short of the wall, was drawn hanging there for the whole 28-tick
record, sliding one pixel, then a further twelve over the next 45 ticks,
then vanishing, while its explosion was handed to an invisible shot.

The mechanism was the tank-birth window in `mark_new_tank_shells`: the
muzzle tolerance plus the gap's worth of flight, but only while the gap
was inside the half-second position window; past 25 ticks it collapsed to
the bare 16 px tolerance. At a 28-tick gap neither fresh shell (17 and 44
px from the muzzle) could claim its fire event, and the pairwise matcher
skips terminals past the same 25 ticks, so both volleys reached the
residual pass as two chain ends, two origin-less starts and two spent
shots that `creation_start_match` (16 px at zero duration) could not
attach either. The flow then forced the only story it had: each old shell
onto the new shell a pixel ahead, as a dilated join, and the two shots
onto explosions as unseen sources. The window now follows the gap without
the cap, bounded by the shell's range. A shot logged in a record was
fired since the sender's previous record, so that is where its shell can
be; past the pairwise window the old-shell story goes untested before a
birth is claimed, but nearest-first assignment against the fire count
keeps a lingering shell from outranking a fresh one.

Two forms were measured: the allowance following the gap up to the
50-tick pairwise window and reverting to the muzzle tolerance beyond, and
the open, range-bounded form. The open form is a shade better on both
files with tank play across long gaps (fixture terminals 20720 -> 20722,
pop-outs 269 -> 267; the replay 5514 -> 5515, 93 -> 92) and nothing moves
the other way, so it is the one kept.

Fixture, against `1256974`:

* `rate_shells_matched_forward` 0.996298 -> 0.996380
* `rate_shells_unlinked` 0.001736 -> 0.001681 (128 -> 124)
* `rate_terminals_matched` 0.860478 -> 0.860727 (20716 -> 20722):
  `explosion` +1, `base_damage` +2, `pillbox_damage` +3
* `shells_from_tank` 9034 -> 9062, `shell_births` 20726 -> 20754,
  `terminals_unseen_tank_source` 1125 -> 1119
* Audit: `pop_outs` 273 -> 267, `pop_ins` 263 -> 235,
  `terminal_links_rushed` 461 -> 462, hovers 1 -> 1, seam jumps still
  zero, `rate_links_steady` unchanged
* `040601.6` is byte-identical
* The motivating replay: matched forward 0.993365 -> 0.994016, unlinked
  52 -> 45, terminals matched 5503 -> 5515 (`explosion` 451 -> 454,
  `pillbox_damage` 2045 -> 2054), tank origins 2257 -> 2284, unseen tank
  sources 267 -> 260; audit hovers 11 -> 8, `pop_outs` 102 -> 92,
  `pop_ins` 91 -> 66, rushed 98 -> 98, seam jumps zero
* Corpus: `bc1c9b7` in [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md)
  -- unlinked -589, terminals +998 with every type up, tank origins
  +3,548, hovers -261, pop-outs -801, pop-ins -3,352, contradictions
  and seam jumps unchanged

Left as found at the time: `creation_start_match` still measures a
same-record shot against zero flight. The next section measures the
consistent allowance and finds it redundant once both birth markers
carry the gap.

The scene is pinned in `test/test-viewer.cjs` ("a volley restated across
a long gap dies at the wall, the next is born at the tank"), with the
log's record spacing, and fails on the previous engine: the leading
shell gets no fate and neither shell of the second volley a birth.

## Pill births follow the record gap too

The same cap in the pill-side birth marker: `mark_new_pillbox_shells`
stood down entirely past the half-second position window, so an F4 and
its shell in a record more than 25 ticks after the sender's previous
one could not be attributed at the pairwise stage. The residual pass
could attach the shell to the F4 only within 16 px of the muzzle
(`creation_start_match` at zero duration), and the orbit-membership
claim takes a single sighting only fresh from the muzzle, so a shell
first seen well out along its orbit popped in mid-flight with its F4
left to be spent as an unseen source. The marker now follows the gap as
the tank one does, bounded by the shell's range; the pairwise window
already bounds the gap at 50 ticks. The count-forced unseen terminals
it marks (`mark_unseen_pillbox_terminals`) take the same widened
distance.

The other candidate, widening `creation_start_match` so a same-record
shot's flight is the interval [0, gap] as `creation_fate_match` already
takes it, was measured alone and on top of this change. Alone it moves
three unlinked shells on the fixture and seven on the motivating replay,
all pill, none tank -- the tank marker already covers the identical
window, so a tank start the marker refused is refused there too. On top
of this change it is a wash (fixture 119 -> 118 unlinked, the replay
27 -> 28) and mostly reclassifies orbit-membership births as
F4-attributed ones. Left strict.

Fixture, against `aa268f1` (main after the tank-window merge):

* `rate_shells_matched_forward` 0.996380 -> 0.996448
* `rate_shells_unlinked` 0.001681 -> 0.001613 (124 -> 119)
* `rate_terminals_matched` 0.860727 -> 0.860935 (20722 -> 20727):
  `explosion` +2, `pillbox_damage` +2, `tank_hit` +1
* `terminals_unseen_pillbox_source` 1222 -> 1217;
  `shells_unseen_pillbox_birth` 20 -> 7, the difference now claimed
  from their F4s rather than inferred from orbit membership
* `links_pill_unpinned` 44 -> 23, vouched 20080 unchanged, contradicted
  still 0; the roster-vote tallies shift by a few dozen as the newly
  pinned heads join the electorate
* Audit: `pop_outs` 267 -> 262, `terminal_links_rushed` 462 -> 463,
  hovers and seam jumps unchanged
* `040601.6`: every headline line identical; `links_pill_unpinned`
  153 -> 145 and the vote tallies move with it
* The motivating replay: matched forward 0.994016 -> 0.995447, unlinked
  45 -> 27, terminals matched 5515 -> 5538 (`pillbox_damage` +12,
  `explosion` +6, `tank_hit` +5), pill origins 3257 -> 3271, unseen pill
  sources 494 -> 476, visual joins 2 -> 0, `links_pill_unpinned`
  55 -> 18, vouched 3371 -> 3387, contradicted 0; audit hovers 8 -> 5,
  `pop_outs` 92 -> 70, `pop_ins` 66 -> 53, `rate_links_steady`
  0.966929 -> 0.968155, rushed 98 -> 99, seam jumps zero
* Corpus: `1a67872` in [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md)
  -- unlinked -1,215, terminals +1,471 with every type up, pill origins
  +1,159, unpinned pill links -9,149, contradictions 94 -> 92, hovers
  -184, pop-outs -1,509, backwards pops -59, for 43 more rush links

Pinned in `test/test-viewer.cjs` ("a pill shot first seen across a long
gap is born at its pill"): an F4 and its shell 15 steps out on bradian
63, 30 ticks after the previous record; the previous engine leaves it
with no source.

## Dilated joins bounded by the measured clock lie

The same replay, two records on. The fourth shot of the 4:21 stream is
10 px from the wall at tick 13115 and dies there at 13120; the impact
rides the 13145 record. The fifth is 34 px out. The 13145 list restates
a shell at 2282, a pixel behind the fourth's last statement, with one
fire event for its two shells, so 2282 reached the residual pass as an
origin-less start. There the flow priced the fourth's stories: the wall
at 50 (an arrival 25 ticks before its record, the terminal cost being
the whole lag to the record), or a dilated join onto 2282 at 21 -- the
join's shortfall of 52 px over the 30-tick gap divided by four. It took
the join, cost-forced by a margin of 18, handed the wall to the fifth,
and the chain smoothing then drew the fourth shot at 0.85 px/tick for
its entire sixty-tick life.

The join assumed the sender's clock lied by 52 px. The largest
along-track lie the corpus has shown is 35.5 px, the measurement the
smoothing bound `MAX_SMOOTHING_ALONG_TRACK_PIXELS` (48) was built on,
and `dilated_join_candidate` had no bound on the shortfall at all --
only `along >= -1` and the catch-up allowance above. A join needing a
larger lie than any ever measured is not a lagging sender but two
shells, so the candidate now refuses a shortfall beyond that bound. The
fourth shot takes its wall at 13120.

What it does not settle: the fifth shot now carries the 2282 join (a
32 px hop over the 30-tick gap, a 28 px lie, inside the bound) and is
then joined on to 2270 at 13160 rather than dying at the wall face
2 px away, because the fate there costs 28 -- its record trails the
arrival by 14 ticks, which is only the record cadence -- against the
join's 12.5. Whether the fate cost in the residual flow should charge
for lag that no record could have avoided is a separate cost-model
question, noted here and not dialled; the die-at-impact section's
continue-vs-die caution applies.

Fixture, against `a5cddef` (main after the pill-window merge): every
line identical; nothing on `n20021018.2` needed a lie that large. On
`040601.6`, the fast-ring fixture, the bound refuses three joins
(`shells_unlinked` 25 -> 28, `pop_outs` 115 -> 118) and takes
`hover_links` 46 -> 16 with them -- 27 of the 30 hovers found another
story, three became pops, and `rate_links_steady` 0.964069 -> 0.964403.
The motivating replay: hovers 5 -> 2, steady 0.966929 -> 0.968561, one
link fewer (`pop_outs` 70 -> 71, one backwards pair added -- the 2270
shell's pop-in behind the fifth shot's vanish, the remainder above),
terminals unchanged. Corpus: `f9d3e7c` in
[`interpolation_tests_corpus.md`](interpolation_tests_corpus.md) -- a
trade on the ledger, hovers -647 (-21%) and terminals +32 against
unlinked +213 and backwards pops +67, with the refused joins' two
classes read off the local files there; on screen the second class is
a hover ending sooner, its pop-in a ghost drawn for no frame.

Pinned in `test/test-viewer.cjs` ("a dilated join needing a larger
clock lie than measured yields to the wall"), the five records of the
scene as logged; the previous engine joins the fourth shot to the 2282
shell.

## Orbit states below a stitch

Roadmap item 8's first debt. `apply_stitch` puts the recovered orbit
states on the start shell, but `propagate_identity_down_chain` carried
only the source and the birth down the rest of the chain, and every
link from the start onward had been matched pairwise before the stitch
existed, when the start had no source and `pillbox_shell_successor_states`
had nothing to advance. So below every stitch, forced origin and
membership claim the shells kept only their quantised reconstruction:
no exact pixel for drawing and smoothing to anchor on, no orbit walk
when the chain's end reached the residual pass, no pin for the roster
vote.

`propagate_states_down_chain` now follows the identity walk at all
four sites (`apply_stitch`, `absorb_intermediate_observations`,
`apply_forced_origin`, `claim_unseen_pillbox_births`), re-deriving each
downstream link's states from the link's own duration with the same
successor functions the pairwise matcher runs -- so a link they confirm
is exactly as trusted as one matched with states in hand -- filling
only where states are absent, copying verbatim across a re-send as the
re-send pass does, and stopping at the first link the discrete model
cannot confirm. Tank chains get the same treatment with bradian states,
and a uniquely surviving bradian becomes the heading as it does
pairwise.

Fixture, against `ab9216e` (main after the lie-bound merge): every
matching and drawing line identical -- no link, terminal, birth, pop or
speed bucket moves -- except one terminal link reclassified static ->
instant (an end whose exact pixel is now recovered draws a few pixels
from its terminal rather than on it). The pinning axis is where it
lands:

* `links_pill_unpinned` 23 -> 5; `links_pill_vouched` 20080 -> 20088,
  `links_pill_contradicted` still 0
* `040601.6`: `links_pill_unpinned` 145 -> 71, vouched 26962 -> 27006,
  contradicted 0; nothing else moves
* The motivating replay: `links_pill_unpinned` 18 -> 2, vouched
  3387 -> 3391, contradicted 0; nothing else moves
* No headline rate moves, so no new row in the table below
* Corpus: `6b2cacd` in [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md)
  -- `links_pill_unpinned` 19,311 -> 2,772, vouched +10,787, matching
  and drawing still; contradictions 92 -> 140, the vote now scoring
  links made below joins without the lockstep defence, read there

Pinned in `test/test-viewer.cjs` ("orbit states carry down the chain
below a stitch"): a pill shot at step 2, then at steps 28 and 31 across
a 52-tick gap; the previous engine leaves the step-31 shell with its
source and no state.

## Spending the vote -- the contradiction sweep

The state walk's corpus run left the vouched-link metric scoring
16,539 links it could not see before, and 48 of them contradicted the
pill's elected advance -- ±2-step, mostly pairwise, links made below a
join without the lockstep defence (the corpus file's `6b2cacd` section
has the class table). The vote had only ever been a measurement; the
pairwise matcher defers to it at match time, but a link that reached
final state contradicting it stood. This turns the verdict into an
act.

`sweep_contradicted_links` runs after the membership claims, when every
pin is in, and applies `score_pill_links`'s own definition: a link with
both ends pinned, a passed election over its record pair, and a step
advance that disagrees. Such a link is undone -- the end loses its
story, the start its predecessor, both keep their pill and their
states, since a pill shell's position is an exact orbit point whichever
stream-mate it is -- and the stitching, residual and membership passes
run once more over the freed pieces. Their candidates all consult the
same reference, now carrying the election, so the indicted link cannot
return and the right stream-mate can take its place; where none can,
the pieces stand as an unfated end and an orphan start, which is the
honest drawing of a link the pill's own statements say was wrong.
Verbatim re-sends and visual joins are outside the scored population
and are left alone.

Fixture, against `38265ff` (main after the state-walk merge): nothing
to sweep. All three local files carry zero contradictions, so every
matching and drawing line is byte-identical; the cost of the extra
reference build and link scan measured 1.04, 1.08 and 1.05 of the
previous engine by alternating A/B, inside the run-to-run spread. The
corpus is the only measurement: 140 contradictions to spend, and the
question is how many of the freed ends and starts the second joining
round settles rather than pops. Corpus: `fe3f825` in
[`interpolation_tests_corpus.md`](interpolation_tests_corpus.md) --
contradictions 140 -> 14, unlinked -45, terminals +95 with every type
up, pop-outs -58, pop-ins -47; the 14 left are stitched links in
five replays, read there.

Pinned in `test/test-viewer.cjs` ("the roster vote's contradiction is
unlinked, its vouched neighbours kept") on a hand-built roster: four
pinned shells at steps 10, 12, 15 and 16 restated two steps on, three
linked to their true successors and the fourth one stream-mate too
far; the sweep undoes the fourth alone.

## A base is damaged only by tank shells -- `223c457`

An `An` never follows a pillbox shot (owner; GAMEPLAY.md). The engine
had built the base-damage terminal like any other object box, so a
pill shell crossing a base tile could take the hit as its fate and a
pill's F4 could be count-forced onto one. Both are refused before any
geometry (`terminal_takes_pillbox_shell`), and the diagnostics name
the refusal `weapon`.

Fixture, against `fe3f825`: `terminals_matched:base_damage` 1,132 ->
1,130, the two pill matches released; `tank_hit` 3,213 -> 3,216;
`terminals_matched` 20,727 -> 20,728; `terminals_unseen_tank_source`
1,119 -> 1,122; `shells_unlinked` 119 -> 118;
`shells_unmatched_forward` 262 -> 261. The three rates below. The
fast-ring fixture is byte-identical. Corpus: `223c457` in
[`interpolation_tests_corpus.md`](interpolation_tests_corpus.md) --
47 base hits released from pill shells, tank hits +57, unexplained
impacts -46, pop-outs -18, every truth axis unchanged.

## A turning tank's shell carries the nibble's sector -- `1623cbb`

A tank shell born as its tank crossed a sector boundary is listed a
sector off its true heading for its whole flight, and its `5d` nibble
is the true one (FORMAT.md [E:shell-birth-sector]). Such a shell now
carries the nibble as `sector`, read wherever a direction becomes
geometry, while its list label still matches its restatements.

Fixture, against `223c457`: 44 shells corrected, every one claiming
its birth (`shells_from_tank` 9,062 -> 9,074); `terminals_matched`
20,728 -> 20,732; `shells_unlinked` 118 -> 117;
`shells_unmatched_forward` 261 -> 258; `terminals_unseen_tank_source`
1,122 -> 1,117; one pairwise link undone (52,764 -> 52,763), a
corrected shell's proper heading refusing a successor its stale sector
had accepted. The fast-ring fixture moves the same way: tank births
+25, terminals 4,309 -> 4,317 with `tank_hit` +4, unlinked 28 -> 25,
one link undone. The three rates below. Corpus: `1623cbb` in
[`interpolation_tests_corpus.md`](interpolation_tests_corpus.md) --
impacts +608, unlinked -402, pop-outs -620, pop-ins -2,248, three
headline records, pill links untouched.

Pinned in `test/test-viewer.cjs` ("fixture turning-tank shells carry
the nibble's sector"): the count, that every sector is one step from
its label, and that the field rides down the chain.

## A dilated candidate outlives the on-schedule consensus

A scene from a replay outside the fixtures (`a52e7c28`, Daputa,
2002-08-24): pill at pixel (2240,1920) fires nine shells NNW from tick
332284, and the recorder stalls for 19 ticks so that every sender's
next record is stamped 332342 -- about ten ticks after the positions
inside it. Over the eight-tick pair 332342 -> 332350 the pill's whole
roster therefore advances nine steps, every true continuation dilated,
while the shell on bradian 241 at step 18 lands its ordinary four-step
hop (241@22) inside the fourth list member's quantisation box, which
also holds 239@22 -- the true occupant, the nine-step landing of the
bradian-239 shell at step 13. `propagate_ambiguous_pillbox_orbits`
trusted the alias alone, `constrain_pillbox_candidates_to_targets`
pruned the true dilated candidate against it, and only then did the
roster vote (advance 9, seven to five) evict the alias as well. The
observation was left with no candidate and a stale 241@22 provenance,
later minted as a stream birth drawn 48 ticks from the muzzle; the
bradian-239 chain popped out mid-air; and its next restatement was
claimed as an unseen shot with a 56-tick birth segment -- two phantom
shells and a vanish, in one volley whose other eight chains drew
perfectly.

The constraint pass now leaves a dilated candidate alone when it
shares no state with the target: the target's states are the
on-schedule candidates' own story, and the dilated candidate is by
construction the alternative to it, already barred from competing and
reaching selection only as the lone continuation on both sides.
Narrowing on agreement stands.

The replay: links 27,285 -> 27,287, `shells_unlinked` 17 -> 16,
pop-outs 47 -> 45, `shells_stream_birth` 1 -> 0,
`shells_unseen_pillbox_birth` 4 -> 3, `shell_births` 6,861 -> 6,859
(the two phantoms), vouched links 9,832 -> 9,839 with unvouched
6,497 -> 6,492 and contradictions still 0, steady links 0.975334 ->
0.975483. All nine chains of the volley now run muzzle to splash. A
second scene in the same replay (pill 2288,1984, ticks 400040-400051)
gains two pairwise links the stitcher had been repairing.

Fixture: every line of the rates report identical, every pinned count
in `test/test-viewer.cjs` holding; the drawn-motion audit moves one
link from the 2.5-3.0 bucket into 1.8-2.2 (steady 0.978811 ->
0.978830). Three shells change mechanism without changing story: two
links are made by the stitcher instead of the pairwise pass, and one
list member at step 7 carries the three bradians its own box admits
instead of the one a rival candidate's story had narrowed it to. The
fast-ring fixture is byte-identical. No headline rate moves, so no new
row in the table below. Corpus: `30ea4ef` in
[`interpolation_tests_corpus.md`](interpolation_tests_corpus.md) --
52 links gained, 53 pop-outs and 37 phantom births fewer, vouched
links +210 with contradictions unchanged, three headline records by
the smallest of margins.

## The sender's lockstep -- pooled roster votes, tried and reverted

The roster vote elects one advance per pill per sender record pair,
so a pill with fewer than three pinned shells in flight never votes,
and a vote inside the margin stands down, whatever the sender's other
pills have settled over the same pair. But a client steps every shell
of every pill firing at it in one update pass, so the advance belongs
to the sender transition. `tools/measure-cross-pill-agreement.cjs`
measured that first, on the corpus (`docs/corpus_runs/cb1fd5d-cross-pill.txt`,
443 logs): 10,434 of 10,434 pairs where two pills each elected agree;
99.77% of a sparse pill's pinned statements land at a rich pill's
advance where 22.9% could be landed by any other; pooling the pills'
scores elects 14.5% more pairs and never contradicts a per-pill
winner. Recorded as [E:sender-lockstep].

Both vote sites were then made to lend the sender's advance
(`8a54fd8`): where exactly one advance won any pill's election it
went to every pill of the sender that could not elect its own, and
where none passed, the pooled election (the full and confident scores
summed over every pill, under the same symmetric gates, no orphan
tie-break) stood in. A lent advance pruned members' off-lockstep
continuations and claimed landing ownership exactly as an elected
one; a pair whose pills elected different advances lent nothing. The
stitching and residual reference composed the sender's hops the same
way, a pill's own election taking precedence along its span.

Fixture, under the experiment: every coverage line of the rates
report identical (links 52,763, every shell and terminal count), the
drawn-motion audit byte-identical, and the truth axis moved: vouched
links 20,088 -> 21,512 with unvouched 12,873 -> 11,449,
`rate_links_pill_vouched` 0.609448 -> 0.652650, contradictions 0 ->
0. Of the 11,947 pills that could not vote, 955 were lent an advance
(unvoted 9,954 -> 9,198, stood down 1,993 -> 1,794, passed 3,717
unchanged). The fast-ring fixture: vouched 27,006 -> 30,141,
unvouched 18,530 -> 15,396, rate 0.593069 -> 0.661901,
contradictions 0, 1,995 lent; one visual join (4 -> 3) became an
identity link, with every other line identical and the audit
byte-identical.

Reverted after the corpus run (`8a54fd8` and `8212c0c` in
[`interpolation_tests_corpus.md`](interpolation_tests_corpus.md)):
vouched links +422,129 with contradictions unchanged at 14 and
distance inversions 191 -> 179, but the drawn picture a wash --
terminals +47 and unlinked -8 against 72 links lost, 25 pop-outs and
40 pill-side births gained, most of them chains the contradiction
sweep broke for good on a lent advance -- for a few percent of build
time. A large gain on the meter for no gain in what is drawn was not
worth the weight in the two most intricate functions of the engine.
The engine and the pinned counts in `test/test-viewer.cjs` are back
at `8f55e62`; the measurement tool, the evidence note, the corpus
runs and the report's `shells_sweep_unlinked` / `shells_sweep_rejoined`
lines (which read a flag the sweep already set) stay. No headline
rate moved on the fixture, so no row in the table below.

## Findings at the close of the ten-run table -- `ffb7fd3`

Written when `ffb7fd3` was the branch's head and the table above ended
there. The sections between it and this one carry the line onward and
supersede any "now" or "current" below; this block is kept as the
reading at that point, not the state of the engine. For the state of
the engine see the section after it.

* **The branch line now leads the branch point on every headline metric.** At
  `ffb7fd3` the forward match rate is 0.980136 against `main`'s 0.961100,
  unlinked shells 0.008081 against 0.016596, and terminal matching 0.849553
  against 0.817321. The branch spent `15770f0` through `8aa9506` behind the
  baseline; it is now clear of it on all three, and every headline record is
  held by the branch's own HEAD.
* **The pillbox-attribution regression is repaired.**
  `shells_with_pillbox_source` goes 22516 -> 44245 and `shells_from_pillbox`
  8666 -> 11663 at `63b2e71`, restoring what was lost between the branch point
  and `15770f0` and then exceeding it. `terminals_unseen_pillbox_source` returns
  to the branch point's 393. This is the single largest movement in the file.
* **The gain is attributable to one commit.** `8aa9506` and `39da396` add only
  tooling, and `63b2e71` is the sole commit in the span touching
  `viewer/motion.js`. Unlike the +201 tank hits below, this needs no caveat
  about a trio of commits.
* **The tank-hit work is a clear gain, and has kept going.** `15770f0` to
  `37acbc7` moves exactly one thing, `terminals_matched:tank_hit` 2581 to 2782,
  and everything else is flat to within a single shell. Caveat: that span covers
  three commits -- `09155b1` (interpolate tanks for shot collisions), `7bbb8cf`
  (give shells a hitbox) and `37acbc7` (the tolerance itself) -- so +201 is the
  trio's combined effect, not the tolerance commit measured alone. `63b2e71`
  adds a further +307, to 3089 of 3879, well past the branch point's 2826.
* **The four branch motion changes improve complementary things.** `63b2e71`
  recovered pillbox attribution and won terminals; `d52f860` recovered exact
  positions and lengthened shell chains; `07b6bd9` removes wrong-sign orbit
  candidates and lengthens them further; `ffb7fd3` widens the bound to index 1+
  tank shots. The middle two together gave back four of `63b2e71`'s 20360
  matched terminals, only 0.000167 of the rate, and `ffb7fd3` has since returned
  those four and 93 more.
* **`ffb7fd3` is the first commit to gain on both axes at once.** Every earlier
  branch motion commit either won terminals or won shell links and paid a couple
  of terminals for them. This one takes both records together: +160 shells
  matched forward and +97 terminals. That is the signature of admitting
  candidates a too-tight bound had excluded, rather than re-ranking the
  candidates already in hand.
* **Nothing measured so far trades away a whole metric class.** Across the ten
  commits the backwards movements on the branch line remain tiny:
  `base_damage` -1 at `63b2e71`, `tank_hit` -3 / `shell_falls` -1 at `d52f860`,
  `pillbox_damage` -2 at `07b6bd9`, and `explosion` -2 at `ffb7fd3`. There is
  no sign yet of a change that buys shell matching at the cost of terminal
  matching in any serious quantity.
* **The regression's origin is still unpinned, and now only of historical
  interest.** It was bracketed to `6c937e1` or `15770f0`, both named "Stuff";
  measuring `6c937e1` would still say which introduced it, but the symptom is
  gone, so this is archaeology rather than a fix that is owed.
* **Tank and LGM position tracks are untouched** by anything in this range,
  across all ten commits measured.
* **Main's pillbox-birth rendering work composes with the branch gains.** The
  current merged state reports 20680 births: all 9017 tank-shell and 11663
  pillbox-shell origins. The branch-point numbers remain the right interpolation
  baseline, while v1.0.8 remains the right birth-rendering baseline.
* **Historical `shell_births` values are not comparable until the main merge.**
  The branch-only checkpoints report 9021 because they lack `6a83ce0`; the
  current 20680 is comparable with v1.0.8's 20681. It now sits one *below* it,
  having peaked at 20684 at `07b6bd9`. The swing is entirely the tank-origin
  count: 9021 -> 9017 at `ffb7fd3`, against a pillbox contribution of 11663
  fixed since `63b2e71`. This is a reclassification, not a rendering loss -- the
  two pillbox shells `07b6bd9` held over v1.0.8 are still there, and the four
  shells that left are index 1+ tank shots that no longer claim a confident
  origin.

## A stall of the ring, and the two readings of the pair that spans it -- `c09e9e3`, `fb4bd12`

Ring records arrive in bursts, one per cycle, so the gap between
consecutive records of any sender is normally one ring cycle. The ten
games logged on two machines at once (`fixtures/pairs/`,
`tools/audit-paired-reconstruction.cjs --gaps`; the corpus results
file has the measurement) showed what a delayed link looks like from
one log: the log that stamped it longer has a whole-stream gap of two
cycles or more inside the link's span where the other log has one,
and after the delayed record the sender's cadence resumes at one
cycle in nine cases of ten -- the ring was held up, the cadence
shifted, and every stamp after the stall reads late by the excess.

The first cut (`c09e9e3`) read every such gap as a lie of the stamps
and shortened the pairwise matcher's duration by the excess. The
corpus said half of that was wrong (the `c09e9e3` section of the
corpus file): coverage and the backwards pops improved, but the pill
distance-order inversions rose by half and some 23,000 links drew
slow. Two things were behind it, and both are now in.

*The stall has two kinds, and one log cannot place it.* Held up
between the sender and the recorder, the packet's contents were
computed on the sender's cadence and only the stamp is late; held up
before the sender, the sender's simulation ran on through the wait and
the contents advanced the whole stamped interval. Reading the drawn
distance of every stalled link on the pairs against the two intervals,
the kinds come about half and half -- what a recorder at a random
point of the ring would see. Under one reading a candidate at the
other kind's distance is 18 px off the expected flight on a nine-tick
cycle, past the 8 px the matcher allows, so it was refused and the
shell went to a trailing candidate or a pop-out; hence the inversions.
So a pair that spans a stall now carries two readings of its interval,
the sender's cadence (the stamps less the excess) and the stamps, and
every candidate -- successor or terminal, orbit step or tank bradian
-- is scored against whichever it fits better
(`nearest_expected_distance`); the stamps remain the upper bound on
flight and on the roster vote's window, the cadence gates the
interpolation window, and the vote arbitrates between the two advances
as it was built to.

*On a fast ring two cycles is jitter.* The two-player fixture's cycle
is two ticks and its stamps bunch (dt = 1, 3, 1, 3), so the cycle
rule alone read a stall into 27% of its shell pairs and halved their
durations. The excess must also clear `STALL_MIN_EXCESS_TICKS`, six
ticks, three shell updates: above the matcher's tolerance and the
stamp jitter's outer edge on the pairs. That leaves 0.2% of the
fixture's pairs stalled and every metric of that fixture where it was.

The pairs, the metric the change was built against (`fb4bd12-paired-audit.txt`,
`fb4bd12-pairs-report.txt`, `fb4bd12-pairs-audit.txt`): the two builds of
a game disagreed on 803 forward stories at the baseline, 633 under
the single reading, 693 under two (the second reading admits more
candidates, and where two stories fit the two builds can still part).
Coverage over the twenty pair logs against the baseline:
`shells_matched_forward` 258,487 -> **258,906** (+419; the single
reading gave +270), `shells_unlinked` 526 -> **352**,
`terminals_matched` 54,487 -> **54,815** (+328), `rate_terminals_matched`
0.822619 -> 0.827571; the drawn audit's `pop_outs` 1,202 -> **783**,
`pops_paired_backwards` 54 -> 26, `pairs_pill_order_inverted` 5 -> 6.

The drawn speed. A link across a stall of the stamp-lie kind is now
joined to the nearer restatement and drawn over the stamps, which read
longer than the sender's cadence ran, so it draws slow by construction
-- as the tanks around it do, whose positions are interpolated over
the same stamps. The drawn audit counts these apart (`links_stalled`,
`hover_links_stalled`, and the `_unstalled` rates for everything
else): on the pairs `rate_links_steady` 0.961922 -> 0.960062 but
`rate_links_steady_unstalled` 0.961516, and 110 of the 191 hover
links span a stall. Whether the drawing should follow the cadence
instead was settled by eye (`tools/find-changed-scenes.cjs` finds the
scenes): across a stall of seconds the tanks are held and the shells
creep, where the old engine had them vanish, and the creep reads as
what it is, the net choking. The drawing keeps the stamps.

The committed fixtures: `040601.6` byte-identical to the baseline;
`n20021018.2` `shells_matched_forward` 73,495 -> 73,497 (two
`shell_falls`), `roster_votes_unvoted` 9,954 -> 9,956. Corpus:
`fb4bd12` in [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md)
-- against the baseline matched forward +4,152, unlinked -1,828,
terminals +2,569, pop-outs -15%, the order inversions back at 188
against 191, the steady rate over unstalled links within 0.0002 of the
baseline's.

## The pair after a stall carries two readings as well -- `40e92f6`, `92043d9`, `800f57c`

The stall sections above read the pair that spans a stall two ways
and left the pair after it on the stamps. A replay from the 2001
corpus (`20011221D`, a four-player game on a seven-tick ring) showed
what that misses. One sender's records ran 554393, 554407, 554414:
a fourteen-tick gap, eight ticks of excess, then seven. Its three
shells advanced 12 px over the fourteen ticks -- the stall of the
first kind, contents on the cadence and only the stamp late -- and
then 29 px over the seven: the ring caught up, the next record came
on time, and its contents spanned the seven ticks plus the eight the
delayed record had lagged by. Over the stamps alone 29 px is two
updates past the tolerance on a seven-tick pair, so every
continuation was refused, all three chains broke on the record after
the stall, and the delayed record's stale statements were left as
orphan fragments: the joining passes glued one of them, through a
dilated join, onto the end of an earlier shell whose tank hit had
gone unmatched (the box was the recorder's picture of the victim,
seventeen pixels east of the shooter's), and the trailing shell,
its successor taken, popped out.

So the pair after a stall carries two readings too, the mirror
image: the stamps, and the stamps plus the stall that delayed its
first record (each snapshot records that stall as `stall_before`).
Every candidate is scored against whichever reading it fits better,
as on the stalled pair; the longer reading bounds the flight and the
two birth windows, since a record stamped late states contents from
before its stamp. Under the second kind of stall, or a cadence that
shifted and stayed shifted, the stamps' reading wins as before. The
longer-reading parameter the leaf matchers take is renamed from
`stamped_duration`, since it is no longer always the stamps.

A pair that both follows a stall and spans one has four readings --
each record's contents stale by its stall or not -- and the first cut
(`40e92f6`) kept the two extremes. On the corpus that put a pill's
two shells on the two extremes over one pair, one advanced six steps
and the other fifteen, a distance-order inversion; `92043d9` passes
the stamps down as well, so the stamps and their mirror are scored
too, and away from a double stall the four collapse to the same two.

The scene itself now reconstructs as the lockstep reads it: the
three chains run straight to their own falls, and the drawing-only
smoother re-times the stale statements onto each chain's line, so
nothing crawls or sprints. The unmatched tank hit is untouched and
that shell still ends with no fate -- a separate problem, the
victim's box a ring round or two fresher than the shooter's.

The unit test (`test/test-viewer.cjs`, "the pair after a stall is
read over the stamps plus the stall") builds the shape by hand: a
seven-tick cadence, one record stamped seventeen ticks late with
contents ten ticks stale, the next on time with a 34 px hop that the
control without the stall refuses. It fails on `fb4bd12`.

The pairs, the metric the stall work was built against
(`800f57c-paired-audit.txt`, `800f57c-pairs-report.txt`,
`800f57c-pairs-audit.txt`): the two builds of a game disagreed on 693
forward stories at `fb4bd12` and on **625** now (A abstains 134 ->
133, B 130 -> 101, conflicts 429 -> 391), with the delayed links the
ones that moved (conflicts 187 -> 140), and the roster elections that
differ between the two builds 96 -> 54. Coverage over the twenty pair
logs: `shells_matched_forward` 258,906 -> **258,966**,
`shells_unlinked` 352 -> **317**, `terminals_matched` 54,815 ->
**54,869** (`pillbox_damage` +19, `tank_hit` +12, `shell_falls` +12,
`explosion` +8, `base_damage` +3), `rate_terminals_matched` 0.827571
-> 0.828386, `pairs_pill_order_inverted` 6 -> **5**; the drawn
audit's `pop_outs` 783 -> **723**, `hover_links` 191 -> 171,
`rush_links` 20 -> 28 under `92043d9` and **13** with the delayed head
slid (`800f57c`), `rate_links_steady` 0.960062 -> 0.961219.

The drawn speed. The stalled-pair sections settled that the drawing
keeps the stamps. A link out of the delayed record is then the
mirror of a link into it: where the longer reading was the truth its
contents span more than its stamps, so it draws fast. Inside a chain
the smoother re-times it -- the stale statement slides forward along
the line -- and the drawn audit counts the links out of a delayed
record apart (`links_after_stall`, `rush_links_after_stall`,
`rate_rush_links_unstalled`), the way it counts the stalled links.
The corpus (`92043d9` in the corpus file) then showed 335 more links
over 3 px/tick, and that counter blamed only 52 of them on the record
after the stall. Diffing the rushed links between the two engines
found the rest: smoothed chains, three and four links long at 3.1 to
3.6 px/tick, whose HEAD was the delayed record's statement. The
smoother anchors on the head, and a head stamped late by the whole
stall drags the chain: the lie sits inside the along-track bound, so
the smoother spreads it over every link rather than refusing. The
tail already had a pre-smoothing slide for its stale-anchor case,
and the post-smoothing head slide only trims what the smoother
leaves. So a head stated by a delayed record now slides forward
along its raw first link by the excess before smoothing
(`slide_delayed_chain_heads`, `800f57c`), the smoother anchors on the
slid position, and the chain draws at 2 px/tick from an honest
anchor; heads elsewhere keep the measured post-smoothing slide. The
second hand-built scene in the same test pins it: a head first seen
on the delayed record, 20 px behind where the on-time records put
it, slides those 20 px and the links after it draw at true speed.

The committed fixtures: both byte-identical to `fb4bd12` (the clean
game has no link on the record after a stall either). Corpus:
`92043d9` in [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md)
-- against `fb4bd12` matched forward +1,137, unlinked 9,708 -> 9,078,
terminals +945, pop-outs -5%, the order inversions 188 -> 173, the
contradictions still 14, and with the head slide rushed links 7,473
-> 7,365 and the steady rate 0.965741 -> 0.966639.

## A tank hit is tried against the statements the sender held -- `ee502e9`

The scene the after-stall sections left behind. In the 2001 replay
(`20011221D`, records 5082 to 5098) player 2 drives south behind
tank 3 firing every round, and every hit lands: three `FC` packets
in five records. The engine explained two and left the third, in
record 5098, with no shell: its box, tank 3's statement in the same
round, sat with its west edge nine pixels east of the ray, and the
only candidate popped out at (1737, 1950) with no fate. Tank 3's
statement two rounds earlier, (1742, 1960), has the ray a pixel
inside its west edge, and the shell's next update lands in it.

The mechanism is the one [E:hit-reporter] settled: the `FC` is sent
by the machine simulating the shell, and it found the collision
against ITS picture of the victim, the statement that had reached
it. The engine boxed the hit at the recorder's latest statement,
which the ring can leave a round or two ahead of the sender's (or,
when the victim's next statement arrives in the same bundle as the
hit, the sender's is the one before). The stale-box walk
(`0263483`) had met the same thing from the other side, a track
box sliding out from under the packet box, and gave the pill orbit
the packet box as its fallback; here the packet box itself is the
fresher one.

A probe over the two fixtures and the scene (4,555 hits) classified
the 699 the engine left unmatched by which of the victim's stated
boxes a same-direction shell of the sender's previous list would
have entered inside its flight window: 435 had no such shell at all
(point-blank, the shell dead before its first listing), 19 no box
on the ray, and of the rest 149 reached a box one or two statements
old, 122 of them shells with no story at all, and 7 a box three or
four old -- by the ring, one cycle stale in 81, two in 67, more in
8. So `game.js` keeps each tank's previous two statements
and hands them to a tank-hit terminal as `earlier_boxes`, and both
terminal matchers try the packet box first and the earlier boxes
only when no variant reaches it, newest first, the effect following
the box the shell entered. A stale-box match carries a penalty
above the match margin (`STALE_TANK_BOX_PENALTY_PIXELS`), so it can
never outbid an on-schedule continuation or a fresher box: it is a
fate for a shell that vanished from its sender's lists, not a rival.

Two rules came from the first cut, which offered the boxes to every
hit and let a stale box start at the statement. On `n20021018.2`
that gained 138 hits and lost three continuations and two hits,
and the losses were one shape: a pill barrage on the recorder's own
tank (record 10646), where a shell already touching the box the
tank had left two rounds earlier took a zero-length hit, its true
successor became an orphan birth, and the shell that had really hit
lost the terminal to it. So a hit reported on the sender's own tank
carries no earlier boxes -- a machine's picture of its own tank is
exact, and the tank track already covers the cycle before the
packet -- and a stale box must lie at least one shell update ahead
of the statement, the shell not already inside or touching it: had
the sender's picture of the tank contained the shell where it was
listed, the hit would have been found before the statement went
out. With those the fixture keeps 110 of the 138 and loses
nothing: the two continuations that do change are a 25-tick
dilated link replaced by an on-schedule hit, and a two-shell line
where the leader takes the hit the `FC` reports and the trailer
takes the continuation the leader had.

Fixture (`n20021018.2`), against `800f57c`:

* `rate_shells_matched_forward` 0.996529 -> **0.998034**
  (`shells_unmatched_forward` 256 -> 145)
* `rate_shells_unlinked` 0.001586 -> **0.001017** (117 -> 75)
* `rate_terminals_matched` 0.861225 -> **0.865877**: `tank_hit`
  3,217 -> **3,329**, no other class moves; `links_shell` 52,763 ->
  52,762, `shells_visual_joins` 3 -> 1, `flow_components` 1,205 ->
  1,193
* `links_pill_vouched` 20,088 -> 20,091, contradicted still 0,
  distance-order inversions still 3
* Audit: `pop_outs` 256 -> **145**, `terminal_links_rushed` 464 ->
  463, `terminal_links_static` 458 -> 457, `pop_ins` 224 -> 225,
  `rate_links_steady` 0.978830 -> 0.979076, seam jumps still zero
* `040601.6` is byte-identical: 397 of its 478 hits are on the
  recorder's own tank, which carry no earlier boxes, and the 81 on
  other tanks gain nothing

The ten pairs (`ee502e9-pairs-report.txt`, `-pairs-audit.txt`,
`-paired-audit.txt` against `800f57c-*`): `terminals_matched` 54,869
-> **54,992** (`tank_hit` +125, `explosion` -2), `shells_unlinked`
317 -> **269**, `rate_shells_matched_forward` 0.997085 -> 0.997563;
the drawn audit's `pop_outs` 723 -> **599**, `pops_paired_backwards`
29 -> **27**, `terminal_links_rushed` 1,700 -> 1,698, `rush_links`
and `hover_links` unchanged; the two builds of a game disagree on
625 forward stories -> **613** (A abstains 133 -> 129, B 101 -> 91,
conflicts 391 -> 393), roster elections differing 54 -> 54.

The unit test (`test/test-viewer.cjs`, "a hit on another player's
tank matches the statement the sender held") builds the scene by
hand -- a shell south along x 168, the victim stating (160, 300)
and then (186, 300), the hit against the second -- and its three
controls: both boxes on the ray, where the packet box keeps first
refusal and the effect stays put; the same hit reported by the
victim on itself, which carries no earlier boxes; and a shell
listed already touching the stale box, refused. It fails on
`800f57c`. Corpus: `ee502e9` in
[`interpolation_tests_corpus.md`](interpolation_tests_corpus.md).

## What the residue is made of -- `31c97c0`

With forward matching at 0.998 on the corpus the line was read as
finished, and the remaining classes were censused rather than
chased. Over a fifth of the corpus (89 of the 443 logs, every fifth
file), the ends with no forward story break down as:

| reason | ends |
| --- | --- |
| fate taken by another shell | 1,387 |
| ray misses every terminal | 778 |
| a valid fate still open | 522 |
| fate claimed by an unseen shot | 448 |
| window expired | 306 |
| timing lead or lag | 160 |
| orbit miss, no candidate, direction | 145 |

3,746 in all, spread thin: the worst tenth of the files holds 19% of
them and the worst single file is at 1% of its shells. The largest
class is two shells wanting one logged event, which the log cannot
settle. No scene type is left that one mechanism would sweep up.

The terminal side (0.839 matched) is a different matter, and most
of its gap is not a matching failure. Its largest unexplained
classes on the sample are pill damage where the shell's story
continued past the pill (2,353), explosions with no candidate shell
(1,676), explosions the orbit misses (1,564) and pill damage with no
candidate (1,157). The no-candidate explosions were looked at on
the fixture, all 240 of them:

| shape | cases |
| --- | --- |
| no shot, explosion on or beside the sender's own tank | 91 |
| sender dead or parachuting, no shot | 86 |
| no shot from the sender at all | 44 |
| same-record shot, first of a point-blank burst | 11 |
| same-record shot, no repeat | 8 |

Read against the terrain under each square: the 144 that turn a
square to river are boats destroyed by the sender sailing its own
boat over them (FORMAT.md [E:boat-over-boat]), the craters are 55
mines detonating under other tanks, 17 dying tanks' terminal craters
and 5 the sender's own tank on a mine. The `7T` packet carries all
of these besides shell impacts, and the mine plant and superboom.
None of the 221 is a shell impact, but `game.js` makes a shell
terminal of every `7T` except the mine plant and the superboom, so
they sit in the unmatched-terminal denominator with nothing that
could ever match them. Excluding them would lift the terminal rate
without changing a link, and the test wants care, since a listed
shell craters squares too. That is the first thing to do if the
terminal line is ever taken up. (`040601.6` has nine: eight round a
dead player, one same-record shot.)

The 19 with a same-record shot are a real bug, small and known. A
tank standing still and firing point-blank into the square beside
it, once a record, has its shot and its impact reported in the same
record every time, the shell dead before it could be listed
(records 3936 to 3948 of `n20021018.2`, four shots into a shot
building, code `7B`). The residual pass builds its ordinary edges
first, a shot in one record to an impact in a later one, and its
same-record edges only on what is left; the ordinary edges reach
the box beside the tank from the previous record's shot, so every
impact is credited to the shot one record earlier, the first impact
of the burst goes unexplained and the last shot is left unspent.
The right pairing is the same-record one four times over. It costs
one unexplained explosion per burst, about 700 over the corpus by
the sample, and nothing on screen: an unseen shot's claim draws no
shell and the boom keeps its record time. The principled fix is to
put the same-record edges into the flow beside the ordinary ones at
a small extra cost and let the flow prefer the assignment that
explains more; it touches the pass whose design keeps phase two
after phase one so nothing explained can degrade, so it wants a
corpus run of its own, for a metric nobody is watching. Left as is.

## A tank's shells keep their order along the heading, and advance in lockstep -- `422354a`, `e46dd5e`, `7290254`

The question was whether the matcher used the fact that a tank's
earlier shell stays further out than its later one. For pills it did,
twice over (the lockstep passes and `score_pill_order`); for tanks only
`prefer_ordered_shell_impacts` ordered a stream's fates by birth time.
The invariant is also weaker for a tank than the pill's: the tank moves
between shots, so across headings the order of distance from the tank
is only nearly kept -- a search over the documented speeds and turn
rate finds a full-speed S-turn on road that puts the later shell about
16 px further out in the first shell's last twenty ticks, 5 px on
grass, never in forest -- and its range setting can change, so birth
order is not fall order. Along one heading it is exact: a shell flies
at 2 px/tick and a tank at most 1, so the later shot starts behind by
at least the reload's length in pixels and the two then advance alike.

`422354a` measures that: `score_tank_order` reads same-sector pairs of
tank-born shells along the sector's centre line, kept, blurred (a flip
within three pixels plus chained-offset slack, closer than two shots a
reload apart can be) or inverted, in the shape of `score_pill_order`,
printed under the same `order_example` lines tagged `tank`.

Fixtures at `422354a`: `n20021018.2` 9,129 pairs, **1** inverted, 1
blurred; `040601.6` 22,319 pairs, none; the ten pairs 45,160 pairs,
**14** inverted (seven scenes, each seen by both recorders). Every
inversion is one shape. In the fixture's (records at 9713165 and
9713188, sector 4) three eastbound shells of one tank sit at 1996,
2019 and 2047 px along the heading and are next stated at 2024, 1997
(a newborn) and 2047 (a fall): every live shell flew 28 px, so the
23-tick stamp is about nine ticks late, a dropped restatement's worth.
The matcher, reading 46 px off the stamps, could accept only the 51 px
hop from 1996 to 2047 and made it; the stitcher then joined 2019 to
2024, 5 px in 23 ticks, and the two identities crossed. The crossing
and the truth cost the same total distance -- 51 + 5 = 28 + 28 -- and
the truth was outside the window.

`e46dd5e` enforces the tank's lockstep. The sender moves every shell
it simulates 2 px in one update pass, so between two of its statements
every one of its tank's live shells has flown the same distance,
whatever its heading; tank shells hold bradian position bounds rather
than orbit steps, so `enforce_tank_lockstep_candidates` reads pixel
advances, from the shell's exact pixel where its bradians agree on one
(else its stated pixel) to the candidate's, within three pixels plus the
chained-offset box of either end. One common advance must explain a
non-terminal candidate of every tank shell that has any; candidates no
common advance supports are pruned, and with none nothing is. Terminal
candidates stay out, and only shells with tank provenance join. It runs
in the matcher's pass loop after the pill lockstep passes.

Fixtures at `e46dd5e`, against `422354a`:

* `n20021018.2`: every rate unchanged, `flow_components` 1,193 ->
  1,188. The inversion stands: its shells had one candidate each.
* `040601.6`: one more shell links forward (`links_shell` 80,428 ->
  80,429, `shells_unmatched_forward` 111 -> 110), `shells_with_birth`
  +20, `pairs_tank_order` 22,319 -> 22,332, still none inverted.
* the ten pairs: `shells_matched_forward` 259,090 -> 259,097
  (`to_snapshot` +16, `to_terminal` -9: `pillbox_damage` -9),
  `shells_unlinked` 269 -> **267**, `shell_births` 54,993 -> 54,988,
  `shells_visual_joins` 28 -> 26, `pairs_tank_order` 45,160 -> 45,194
  with the 14 inversions untouched; the two builds of a game agree on
  128,592 -> **128,618** forward stories, conflicts 393 -> **376**,
  abstentions 129 / 91 -> 127 / 84, births agreed 48,197 -> **48,225**,
  roster elections differing 54 -> 54.

The corpus run at `e46dd5e` (its section in the corpus file) gave 146
terminals back, 109 of them `pillbox_damage`, and the ten pairs' nine
lost terminals showed the shape. In `20010412.1` (sender 1, records
3432199 and 3432220, a 21-tick stamp after a 12-tick stall) the lead
shell of a three-shell line had hit the pill and the record carried
its damage; its only continuation candidate was the 16 px hop onto its
successor's restatement, the short reading's distance. The lockstep
took that hop as the leader's advance and forced the two shells behind
onto the short reading too, so the leader continued instead of taking
its hit and the damage record went unclaimed. `7290254` makes a shell
with a terminal among its candidates abstain: its non-terminal hops
are still pruned against the advance the voters establish, but never
set it, and two voters are needed as before. On the ten pairs, against
`e46dd5e`: `terminals_matched` 54,983 -> **54,993** (`pillbox_damage`
17,530 -> 17,540; the pre-lockstep state had 54,992),
`shells_matched_forward` 259,097 -> 259,098, `shells_unlinked` 267 ->
268, `shell_births` back to 54,993, `pairs_tank_order` 45,194 ->
45,176 with the 14 inversions untouched; the two builds of a game
agree on 128,614 forward stories (128,592 before the lockstep,
128,618 at `e46dd5e`), conflicts **379** (393 / 376), births agreed
48,219 (48,197 / 48,225). Both single fixtures are byte-identical to
`e46dd5e`. The unit tests add the three-shell scene by hand: the
leader with a hop and a terminal, two voters behind it agreeing on 28
px, the hop pruned and the terminal kept; and the same leader with one
voter, where nothing is pruned.

Corpus at `364174f` (its section in the corpus file): against
`ee502e9`, `terminals_matched` 1,633,352 -> **1,633,385** in every
class, `shells_matched_forward` +177, `shells_unlinked` -63, the pill
truth axes byte-identical, `rate_links_steady` 0.966797 -> **0.966863**;
against `e46dd5e`, 146 -> +33 terminals for 47 forward matches and
eight tank inversions (330 -> 338). The thousand slow links `e46dd5e`
had added are gone with the abstention, which says what they were:
not the truth at a late stamp's clock but rosters a dead leader's hop
had forced onto the short reading.

The same structure is in `enforce_pillbox_lockstep_candidates`, whose
members vote whether or not they hold a terminal candidate (the roster
vote, `enforce_roster_lockstep_candidates`, already holds its election
with and without its doubtful members). Measured on the fixtures and
not applied: `n20021018.2` gains three forward matches, one terminal
and loses one of its three pinned inversions; the ten pairs lose one
terminal, gain twelve vouched links and three inversions (5 -> 8), and
the paired audit's conflicts go 379 -> 382. Every new inversion is a
dying leader given a one-step stitched continuation by the stitcher
after the pass pruned the same hop, so the abstention there needs the
stitcher's side worked out first, and its own section.

Why the pass reaches none of the inversions: in every scene the true
continuations lie outside the interval's readings, so the swapped hops
were the only candidates each shell had and there was nothing to prune
among. What the pass does move is the case one step milder, where a
shell has both its true continuation and a rival hop in the window and
another of the tank's shells says which advance the interval carried.
The common advance is in fact the interval's true length -- every tank
shell agreeing on 28 px says the gap was 14 ticks -- and reading the
clock off it, rather than pruning under it, is the change that would
reach the scenes; that is a change to the readings.

The unit tests (`test/test-viewer.cjs`) pin the fixture's tank order
counts and the fast-ring link count, exercise the scorer on hand-built
pairs (kept, inverted, blurred, chained members, a turning shell's
corrected sector, and the exclusions), and run the lockstep on
hand-built candidate tables: the trailer's hop onto the leader's
restatement pruned when the leader has only its own continuation, both
stories kept when the leader has a matching long hop too, a stand-down
with no common advance, terminals ignored, chained-offset slack, the
exact pixel read where the bradians agree, and pill and unattributed
shells kept out of the group. Corpus: `e46dd5e` in
[`interpolation_tests_corpus.md`](interpolation_tests_corpus.md).

## A shot is spent only where it could have flown -- `081d8aa`, `8289438`, `ae527fd`

Two accounting faults in `resolve_residual_shell_fates`, found by a
review of the code rather than by a scene, both in how the pass keeps
its books on fired shots.

`081d8aa`: the writeback of unspent shots to the snapshots was keyed by
record time, so two snapshots stamped on one tick -- the fast-ring
shape, 662 adjacent pairs on `040601.6` and none on `n20021018.2` --
each received the other's leftovers as well as its own. A second pass
(the one the contradiction sweep runs) then read both copies, and the
terminal diagnostics read them too. The writeback is now keyed by the
snapshot the shot came from. A hand-built scene in the unit tests puts
shots on two same-tick records and runs the resolver twice: on the old
code the leftovers doubled at each pass, two copies and then four.

`8289438`: the equivalence phase (phase three) drew its capacity from a
pool per source identity -- pill or tank, muzzle pixel, direction --
summed over every unspent shot from that muzzle at ANY time, and then
charged the spend to the identity's earliest unspent members. The
identity test was taken over the fate's within-margin candidates, as it
should be; the capacity was not, so a shot fired long after the impact
could fund the attribution and be charged for it. Instrumented on the
old code, the pool's charges on the two fixtures:

| fixture | within the margin | legal, outside the margin | not a candidate |
| --- | --- | --- | --- |
| `n20021018.2` | 4 | 2 | 7 |
| `040601.6` | 3 | 2 | 5 |

The "not a candidate" column is shots fired AFTER the impact they were
charged for, 8 to 3,609 ticks after it. The fix spends a fate's
attribution only from its own within-margin candidates, each checked
for unspent capacity at spend time and each applied with its own match
(the alternate-pill entry of a direction-0 F4 was formerly taken from
the first candidate for every unit). A hand-built scene in the unit
tests fires at ticks 210 and 211 and once more at 10 or at 700, lands
three or four impacts from tick 220 on, and checks that the shots at
210 and 211 fund all but the last, which the unrelated shot must
neither fund nor be charged for, for tank and pill sources both.

Fixtures, `8289438` against `364174f`. The `081d8aa` step alone moves
no rate on either fixture; it corrects one class of the fast ring's
terminal diagnostics, `tank_hit:creation_unforced:T` 1 ->
`tank_hit:direction:T` 2, where a phantom leftover had dressed a spent
shot up as an open story. With both:

* `n20021018.2`: `terminals_unseen_pillbox_source` 1,217 -> **1,209**,
  every other line byte-identical (matched forward 0.998034, unlinked
  0.001017, terminals matched 0.865877). The census pins move with it:
  unexplained terminals 896 -> 904, `fate_open` ends 22 -> 25.
* `040601.6`: `terminals_unseen_pillbox_source` 312 -> **309**, every
  other line byte-identical.
* the ten pairs: the paired audit is byte-identical.
* the drawn audit is byte-identical on both fixtures.

Two of the fixture's eight lost attributions were legal stories: a
same-source shot inside the flight window whose cost sat outside the
margin of a cheaper sibling that an earlier fate had already spent.
Had the sibling not existed, that shot would have been the within set
on its own, so the outcome depended on the order the fate's siblings
were served in, which is not a fact about the fate. `ae527fd` holds
the election again at spend time, over the candidates still unspent:
the new cheapest, the within set around it, one muzzle required, and
the live-shell test re-run against the new cheapest, since a rival
that sat outside the old margin can sit inside the new one. Fixtures,
against `8289438`: `n20021018.2` `terminals_unseen_pillbox_source`
1,209 -> **1,210** (unexplained terminals 904 -> 903), `040601.6`
byte-identical at 309, the ten pairs and both drawn audits
byte-identical. The unit tests add the two scenes by hand: two shots
from one tank muzzle at ticks 100 and 105 and two impacts at 120 and
121, where the first impact spends the cheap tick-100 story and the
second takes the costlier tick-105 one (Astra's code left it open);
and the same with a rival muzzle 2 px west whose tick-105 shot costs 6
for either impact -- inside the new margin, outside the old -- where
the second impact stays open and both shots stay unspent.

Corpus: `8289438` and `ae527fd` in [`interpolation_tests_corpus.md`](interpolation_tests_corpus.md).

## Every link is drawn to its end -- `cfc6bd0`

The third complaint of the review that produced the two accounting
fixes above, and the one they left open: the renderer draws packet
state, so a shell is drawn from the sender's latest record, lerping
toward its link target, and the sender's next record replaces that
list. A link whose target lies beyond that next record had nothing to
draw it from the moment the list was replaced, and the sprite vanished
mid-flight. The fall segments already carried one such class, a shell
fall retimed to its physics arrival past the record that reported it;
`cfc6bd0` makes them the gap segments (`build_shell_gap_segments`,
`shell_gap_positions_at`) and carries every such link -- stitches and
residual joins across a dropped or refused restatement, visual joins,
forced terminals reached a record or two on -- replaying the same lerp
at the same pace from the moment state loses the shell to the link's
end. Drawing only: no link, timing or effect changes, and the
drawn-motion audit, which has always read every link as drawn end to
end, is byte-identical by construction and now describes what is drawn.

Measured first by hand and then by `tools/measure-gap-segments.cjs`,
which counts the links past their record other than by a fall, by what
they reach and by drawn speed, over the two fixtures and the ten pairs:

* 157 links in 417,452 (0.04%), 1,935 ticks undrawn between them; 14
  on `n20021018.2` (the eight stitches the review named and six
  non-fall terminals, 159 ticks), 55 on `040601.6` (786 ticks), 0 to
  21 per pair log. The falls the segments already carried: 4,012.
* by drawn speed, the audit's buckets: 127 steady (1.8-2.2 px/tick),
  18 slow, 2 hovers (both stitches on the fast ring at 0.33 px/tick),
  9 fast, 1 rush (a pillbox hit at 3.6 over a five-tick link). Against
  95% steady for non-fall links generally, 81%: the classes that outlive
  a record are the stitches and capped arrivals the audit already counts
  as hovers and rushes, and the segments add no speed of their own -- a
  link that drew slow before the drop finishes slow. A speed gate on the
  segments was considered and not built: a link too dilated to draw is a
  matching question, and the hover residue is tracked under roadmap
  item 8.
* what the intermediate records held: of the 157, 39 had an observation
  absorption refused as ambiguous (the shell was there, in a crowd), 48
  an unlinked same-direction shell; the rest had no candidate for the
  shell at all, a restatement dropped or matched into another chain.

Corpus, `cfc6bd0-gap-segments.txt` (the run was taken with this
section drafted and uncommitted beside it, so the tool stamped
`cfc6bd0-dirty`; the line is corrected by hand, the engine and the tool
being `cfc6bd0`'s), 443 files: 5,124 links in 9,798,481
(0.052%), 55,956 ticks undrawn, the longest gap 53 ticks; 3,368
stitches, 229 visual joins, 1,037 pillbox hits, 234 base hits, 150 tank
hits, 106 explosions; 4,453 steady, 431 slow, 46 hovers, 192 fast, 2
rushes; 370 of the 443 logs have at least one, the most affected 151 in
148,335 links. The 96,952 falls past their record are the class the
segments carried before.

The unit tests keep the fall scene and add a stitch across a record
that restates no shells: the stitch links through it, packet state
holds nothing inside the gap, and the segment is sampled inside the
gap (12.75, 10.5 at tick 118 for a shell from 160,160 at 100 to 208,160
at 124), absent a tick before the empty record, present from it, and
gone at the tick the continuation's record takes over.

## Where the line stands -- `0263483`

The same three headline rates at the points a reader is likely to want,
all on the fixture, all from the sections above:

| state | matched forward | unlinked | terminals matched |
| --- | --- | --- | --- |
| v1.0.7 `3f359d1` | 0.929101 | 0.029667 | 0.771713 |
| branch point `86807e0` / v1.0.8 | 0.961100 | 0.016596 | 0.817321 |
| `ffb7fd3`, close of the ten-run table | 0.980136 | 0.008081 | 0.849553 |
| v1.0.9 `6254551` (engine `6b4140d`) | 0.994427 | 0.002535 | 0.856366 |
| `0263483`, the stale-box walk | 0.996298 | 0.001736 | 0.860478 |
| tank births follow the record gap | 0.996380 | 0.001681 | 0.860727 |
| pill births follow the record gap | 0.996448 | 0.001613 | 0.860935 |
| a base is damaged only by tank shells | 0.996461 | 0.001600 | 0.860976 |
| a turning tank's shell carries the nibble's sector | 0.996502 | 0.001586 | 0.861142 |
| a stalled pair carries two readings | 0.996529 | 0.001586 | 0.861225 |
| the pair after a stall carries two readings as well | 0.996529 | 0.001586 | 0.861225 |
| a tank hit is tried against the statements the sender held | 0.998034 | 0.001017 | 0.865877 |
| a tank's shells advance in lockstep | 0.998034 | 0.001017 | 0.865877 |
| a shot is spent only where it could have flown | 0.998034 | 0.001017 | 0.865877 |
| every link is drawn to its end | 0.998034 | 0.001017 | 0.865877 |

* **Every headline record is held by the current head.** Unlinked
  shells are down to 75, a sixteenth of the branch point's rate; forward
  matching has closed nineteen twentieths of the gap the branch point left;
  terminals matched is 4.9 points above it, `tank_hit` 2,826 -> 3,329.
  The stall reading barely touches this fixture -- a clean game, sixteen
  stalls in 137 minutes, no link spanning one -- and its row is here for
  the record; the corpus file has its measure.
* **The truth axes agree with the coverage axes**, which they were
  built to be able to refuse to do. Pill-link contradictions 6 -> 0
  since the metric was introduced; drawn-motion pop-outs 1,465 at the
  pre-branch state -> 145; steady links 0.787 -> 0.9791; seam jumps 0
  at every state ever audited. Nothing on the fixture's books is a
  match rate bought with a rendering lie. The corpus is a shade less
  clean (94 contradictions at `0263483`, per the corpus file), and that is where
  the next dial is.
* **Two eras are measured only on the corpus.** The unseen-shot,
  provenance-birth and pill-lockstep arcs (from `dc3bd3b` through
  `efe9ab2`) have no fixture sections; `pop_outs` moves 384 -> 299
  between the orbit-absorption entry and the vouched-link entry above,
  and the corpus file holds every commit in between.
* **Tank and LGM position tracks have never moved.** Byte-identical
  at every state in this file. Facing gained its own window once
  (`2680d76`) and has not changed since; nothing in shell matching
  reads it.
* **The one regression's origin stays unpinned**, bracketed to
  `6c937e1` or `15770f0` and repaired since `63b2e71`. Archaeology,
  not a debt.
