# Interpolation coverage across versions

How much of a replay the motion code manages to explain, measured at eight
points in the history. Produced with `tools/report-interpolation-rates.cjs`
(which lives on `main`), run once per checked-out commit:

```
node tools/report-interpolation-rates.cjs -f <absolute path to the fixture>
```

All eight runs read the same input, `fixtures/n20021018.2`
(sha256 `100d68e2c2679cbac40a09bedc7cddeed9e357eed8de9205cba96bfe5a511ba9`). The
fixture blob is identical at every commit measured, so nothing here is an
artefact of the sample changing underneath the engine. The tool writes nothing
to disk; each historical run was done in a throwaway worktree with `main`'s copy
of the tool dropped in, so the measuring code is the same in all eight runs and
only the engine differs. The v1.0.8 run needed no worktree: it was `main`'s own
HEAD when this file was started, and `tools/report-interpolation-rates.cjs` has
not changed since `76d8b8a`. `main` has since gained `12bc73d` and the three
commits before it, but they touch only `viewer/main.js`, `viewer/preload.js`,
`viewer/renderer.js` and packaging, so v1.0.8's numbers are still `main`'s.

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
* Tank and LGM track coverage is reported too, but is byte-identical at all eight
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

## Branch -- `4f5dbe9` "Possible fix to a bad assumption", `using_the_pillbox_data` HEAD

The first state to beat the branch point on every headline metric. It still
holds the best `rate_terminals_matched` of any commit measured; `83cb132` below
has since taken the two shell-matching rates off it.

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

## Branch of the branch -- `83cb132` "Try to determine true location from quantized pillbox shots", `using_the_pillbox_data_antifuzz` HEAD

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
  two terminals out of 24075. `4f5dbe9` keeps the record here.
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

## Findings

* **The branch line now leads the branch point on every headline metric.** At
  `83cb132` the forward match rate is 0.976801 against `main`'s 0.961100,
  unlinked shells 0.009342 against 0.016596, and terminal matching 0.845607
  against 0.817321. The branch spent `ad6a3b6` through `c848efd` behind the
  baseline; it is now clear of it on all three.
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
* **The two branch commits improve different things, and neither undoes the
  other.** `4f5dbe9` recovered pillbox attribution and won terminals;
  `83cb132` leaves every attribution and birth count untouched and instead
  lengthens shell chains, taking `rate_shells_unlinked` below 1% for the first
  time. The one place they conflict is trivial: `83cb132` gives back two of
  `4f5dbe9`'s matched terminals, 0.000084 of the rate.
* **Nothing measured so far trades away a whole metric class.** Across the eight
  commits the only backwards movements on the branch line are single-terminal:
  `base_damage` -1 at `4f5dbe9`, and `tank_hit` -3 / `shell_falls` -1 at
  `83cb132`. There is no sign yet of a change that buys shell matching at the
  cost of terminal matching in any serious quantity.
* **The regression's origin is still unpinned, and now only of historical
  interest.** It was bracketed to `9bc584d` or `ad6a3b6`, both named "Stuff";
  measuring `9bc584d` would still say which introduced it, but the symptom is
  gone, so this is archaeology rather than a fix that is owed.
* **Tank and LGM position tracks are untouched** by anything in this range,
  across all eight commits measured.
* **`main` has moved since the branch point, but only in what it can draw.**
  v1.0.8 adds 11661 pillbox shell births and changes nothing else in the report,
  and the five commits after it touch only the renderer, the Electron shell,
  packaging and this file. The branch-point numbers are still the right
  baseline.
* **`shell_births` is not comparable across the two lines.** The branch reports
  9021 (tank shells only) because it does not carry `main`'s `f4f15d9`; that
  commit's 11661 extra pillbox births are a drawing improvement, not an
  interpolation one, and would land on top of the branch's gains if merged.
