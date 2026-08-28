# Interpolation coverage across versions

How much of a replay the motion code manages to explain, measured at four
points in the history. Produced with `tools/report-interpolation-rates.cjs`
(which lives on `main`), run once per checked-out commit:

```
node tools/report-interpolation-rates.cjs -f <absolute path to the fixture>
```

All four runs read the same input, `fixtures/n20021018.2`. The fixture blob is
identical at every commit measured, so nothing here is an artefact of the
sample changing underneath the engine. The tool writes nothing to disk; each
run was done in a throwaway worktree with `main`'s copy of the tool dropped in,
so the measuring code is the same in all four runs and only the engine differs.

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
* Tank and LGM track coverage is reported too, but is byte-identical at all four
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

The engine here is identical to the branch point `6777d35`: every commit `main`
has gained since then is a FORMAT.md edit or the report tool, and
`git diff 6777d35 main -- viewer/ src/` is empty. So this is the baseline the
branch should be judged against, not a parallel line of work.

* `rate_shells_matched_forward` 0.961100 -- best of the four
* `rate_shells_unlinked` 0.016596 -- best of the four
* `rate_terminals_matched` 0.817321 -- best of the four
* `terminals_matched:tank_hit` 2826 of 3879
* `shells_from_pillbox` 11661
* `shells_with_pillbox_source` 41881
* `shells_with_birth` 28001 -- births now known well beyond tank shells
* `terminals_unseen_pillbox_source` 393

Versus v1.0.7 this is a gain across the board: +3.2 points of shell matching,
+4.6 points of terminal matching, and unlinked shells roughly halved.

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

## Findings

* **The tank-hit work is a clear gain.** `ad6a3b6` to `5e69318` moves exactly one
  thing, `terminals_matched:tank_hit` 2581 to 2782, and everything else is flat to
  within a single shell. Caveat: that span covers three commits -- `422c5ff`
  (interpolate tanks for shot collisions), `18b51b9` (give shells a hitbox) and
  `5e69318` (the tolerance itself) -- so +201 is the trio's combined effect, not
  the tolerance commit measured alone.
* **There is a separate pillbox-attribution regression, upstream of that work.**
  Between the branch point and `ad6a3b6`, `shells_with_pillbox_source` halves and
  `shells_from_pillbox` drops by 3000, taking the forward match rate down with it.
  Since `main` and the branch point are the same engine, `main`'s higher numbers
  are not `main` pulling ahead -- they are attribution the branch had at v1.0.7
  and has since lost. The +201 tank hits sit on top of that loss.
* **The regression is bracketed to two commits**, `9bc584d` or `ad6a3b6`, both
  named "Stuff". Measuring `9bc584d` would pin it to one.
* **Tank and LGM position tracks are untouched** by anything in this range.
