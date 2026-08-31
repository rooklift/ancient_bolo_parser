# Interpolation coverage across versions -- full corpus

Originally the same ten commits measured in
[`interpolation_tests.md`](interpolation_tests.md), re-run against the whole
443-log corpus instead of the single sample replay; later sections extend the
line commit by commit as the branch grew. The "ten commits" and "ten runs" in
the method notes below describe that original rig, which the later runs each
re-validate in their own sections.
Produced with `tools/report-interpolation-rates.cjs`, run once per checked-out
commit:

```
node tools/report-interpolation-rates.cjs -r "<corpus root>"
```

(or, with `corpus.json` or `BOLO_CORPUS` configured, plain
`node tools/report-interpolation-rates.cjs` — since the guard commits the
tool run bare reads the whole corpus itself, the same way
`audit-drawn-motion.cjs` does).

Read this file alongside the fixture one rather than instead of it. The metric
definitions in [`interpolation_tests.md`](interpolation_tests.md) ("What the
numbers mean") apply unchanged and are not repeated here; what follows is the
same experiment at roughly 113 times the data, and the interesting content is
where the two disagree.

## Method

The corpus is the private 443-log set described in `FORMAT.md` (2001-2005, all
Bolo 0.99.7), read recursively. It does not live in this repository and its
location is deliberately not recorded anywhere in the tree. The measurement
tools find it through `corpus.json` at the repo root, which is gitignored --
create it as `{"root": "/path/to/logs"}`, or set `BOLO_CORPUS` in the
environment. **An agent re-running this should ask the user where the corpus
is** rather than guessing, since `corpus.json` is absent from a fresh clone.
The three logs known to be hacked or broken are excluded.

* 443 files, 221,354,707 bytes. The one `.txt` in the tree is excluded by the
  tool's own extension filter, so the file count the tool reports is the log
  count.
* Composition by year: 2001 132, 2002 92, 2003 52, 2004 122, 2005 34, plus 11
  further logs held outside the year directories.
* Manifest digest `f8eee92cd6ee1f2b8cec07fe82edc8972eec09e9b21348bc1cfa002432e672d4`
  -- the sha256 of the sorted `sha256sum` listing of those 443 files, by path
  relative to the corpus root. This pins the corpus the way the fixture file's
  single sha256 pins its one replay.
* `files_failed` is **0** at all ten commits and stderr is empty at all ten, so
  every log parsed at every version. Nothing below is a survivorship figure.
* The corpus is not in the repository, so its blobs are necessarily identical
  at every commit measured.

All ten runs were done in one throwaway detached worktree, checked out to each
commit in turn, with `main`'s copy of the tool dropped in each time. The tool's
sha256 was recorded per run and is
`f2909fa6498a5e6e1725ef7372d9e6ddf1372895036fe1d637b7b6d3ac494160` at all ten,
so the measuring code is provably identical and only the engine differs.
`tools/report-interpolation-rates.cjs` still has exactly one commit, `76d8b8a`.
Runs were sequential, one process at a time.

Unlike the fixture file, no run here was taken from a live checkout: `main` has
moved on to the merge commit, so all ten used the worktree, which makes the
method uniform across the table rather than eight-of-ten.

**Rig validation.** Before the corpus runs, `323c673` was replayed through this
rig against the *fixture* and reproduced the published v1.0.7 row exactly --
`rate_shells_matched_forward` 0.929101, `rate_shells_unlinked` 0.029667,
`rate_terminals_matched` 0.771713, `terminals_matched:tank_hit` 2657,
`shells_from_pillbox` 11661, `shells_with_pillbox_source` 41226,
`shells_with_birth` 9021, `terminals_unseen_pillbox_source` 0,
`max_shell_interpolation_ticks` absent. The rig is therefore known to reproduce
the older file before any new number below is trusted.

**These numbers are current** as of `a78253b`: the two claims-only commits
after the `90925b0` guard run (`775fe4b`, `a78253b`) leave every matching
metric byte-identical, so the guard run remains the measured state of record.
The last row is no longer `main`'s row, though: `main` has since gained the
death-dump terrain commits (`72adf37`, `b805f2c`), which touch
`viewer/game.js` -- a module the report loads -- and were unmeasured until
the `97fa412` run recorded in the headline table: `main`'s HEAD is now
measured, and the current measured state of record is the
dilated-continuations branch at `e2bbbfb` (see its section), which
carries both shell-side records; `029acac` keeps both terminal-side
ones. (Earlier
revisions of this paragraph pinned the file at `926f391`/`4572cff`, then at
`a74033a`/`380e333`; later sections were measured from live checkouts of the
named commits, per their sections.)

## Corpus totals

Constant at all ten commits, and worth having once:

* `shells` 9,817,361 shell observations; `shells_in_final_snapshot` 186
* `terminals` 1,946,439, broken down `pillbox_damage` 716,235,
  `shell_falls` 624,224, `tank_hit` 269,483, `explosion` 240,538,
  `base_damage` 95,959
* `tank_points` 9,914,126, `tank_ticks` 122,807,769
* `lgm_points` 7,876,644, `lgm_ticks` 112,261,469
* `max_position_interpolation_ticks` 25 throughout;
  `max_shell_interpolation_ticks` 50 from `76d8b8a` on, absent at `323c673`

## Headline table

| commit | | `matched_forward` | `unlinked` | `terminals_matched` | `tank_hit` |
| --- | --- | --- | --- | --- | --- |
| `323c673` | v1.0.7 | 0.948521 | 0.018737 | 0.761484 | 201,999 |
| `76d8b8a` | branch point | 0.961727 | 0.013738 | 0.791346 | 211,623 |
| `e4582dc` | v1.0.8 | 0.961727 | 0.013738 | 0.791346 | 211,623 |
| `ad6a3b6` | "Stuff" | 0.934635 | 0.032850 | 0.776327 | 197,958 |
| `5e69318` | tolerance | 0.935831 | 0.032708 | 0.782268 | 209,485 |
| `c848efd` | "Stuff" | 0.935831 | 0.032708 | 0.782268 | 209,485 |
| `4f5dbe9` | bad assumption | 0.967669 | 0.011431 | 0.813086 | 227,331 |
| `83cb132` | quantized shots | 0.972767 | 0.009576 | 0.813034 | 227,201 |
| `5f9d86f` | one-sided | 0.973966 | 0.009100 | 0.813066 | 227,223 |
| `926f391` | index 1+ | 0.975030 | 0.008829 | 0.816566 | 227,585 |
| `0d181be` | bradian + stitching | 0.984399 | 0.005985 | 0.816888 | 228,016 |
| `4c791a0` | forced assign + jitter | 0.988925 | 0.004020 | 0.827713 | 233,180 |
| `b345ef0` | temporal gate | 0.988826† | 0.004112† | 0.827709 | 233,180†† |
| `a74033a` | cost-forcing + pop rescue, v1.0.9 | 0.993609 | 0.002202 | 0.828353 | 232,342 |
| `ad2168d` | leading impacts | 0.993965 | 0.002019 | 0.829538 | 233,481 |
| `90925b0` | absorption guards | 0.993725 | 0.002190 | 0.829357 | 233,450 |
| `97fa412` | main, death dumps in | 0.994274 | 0.002143 | 0.832129 | 234,701 |
| `029acac` | subsumed joins | 0.994671 | 0.001949 | **0.833354** | **236,059** |
| `537cb6d` | pill-stream lockstep | 0.994823 | 0.001914 | 0.833265 | 235,967 |
| `3956580` | late-head slide | 0.994823 | 0.001914 | 0.833265 | 235,967 |
| `e2bbbfb` | dilated continuations | **0.995341** | **0.001601** | 0.833183 | 235,739 |
| `c890ecc` | seam closure | 0.995341 | 0.001601 | 0.833183 | 235,739 |

The rows below the guard run were measured later, from the corpus
holder's live checkouts: `97fa412` closes the unmeasured-`main` gap the
currency notes tracked (death-dump terrain and everything since the guard
run included), `029acac` -- the subsumed-joins branch, see its section
-- takes all four headline records at once, and `537cb6d` -- the
pill-stream lockstep branch, see its section -- moves the two shell-side
records on while returning ~174 terminals, so `029acac` keeps both
terminal-side columns. `3956580` -- the late-head slide branch, see its
section -- is drawing-only: its matching axis is byte-identical to
`537cb6d`, so its row repeats that row and no records move; its gains
live on the drawn audit. `e2bbbfb` -- the dilated-continuations branch,
see its section -- moves both shell-side records on again while
returning ~160 terminals, so `029acac` still keeps both terminal-side
columns. `c890ecc` -- the seam closure, see its section -- is
drawing-only like `3956580`: its row repeats `e2bbbfb`'s and its gain
is the audit's seam pair going to 0 / 0.00. The `97fa412`..`537cb6d` runs report
`files_failed 1` where the campaign runs report 0: one extra, unparseable
file now sits in the corpus tree and contributes nothing, and every
per-corpus total (shells, terminals by class, tank and LGM points and
ticks) is byte-identical to the pinned 443-log corpus, so the rows are
comparable. The `3956580` run reports `files 443, files_failed 0`:
`files` counts successful parses only, so the earlier rows' 443/1 was
444 enumerated files, and the `.py` skip-list entry (`e5ec295`) simply
retires the failure at enumeration, leaving the same 443 parsed logs.

Before those rows, `ad2168d` held all four headline records (the terminal one with a caveat --
the unmeasured intermediate state `f340943` sat higher, see its section).
`90925b0` deliberately gives part of each rate record back -- invented
explanations leaving the ledger, see its section -- and lands between
`a74033a` and `ad2168d`; the claims-only commits after it (`775fe4b`,
`a78253b`) are byte-identical on every table column, so its row is where the
measured line currently stands. `70b1227` re-ran byte-identical to `ad2168d`
(see the uncapped-falls entry), a confirmation rather than a row of its own.
`b345ef0` trades a hair of each headline back for correctness the rate can't
see -- see its section below. v1.0.9 (`8f6fe27`) is engine-identical to
`a74033a` -- everything between them is docs, tooling, packaging and viewer
UI, and the one engine change in the span was cleanly reverted before the tag
-- so the `a74033a` row is the released engine's row, and everything below it
is post-release.

## Tank and LGM tracks

Byte-identical at all ten commits, exactly as on the fixture -- nothing in this
range touches position interpolation. For the record:

* `rate_tank_segments_interpolated` 0.953363, `rate_tank_ticks_interpolated` 0.608462
* `rate_lgm_segments_interpolated` 0.981653, `rate_lgm_ticks_interpolated` 0.528934

The tick-weighted rates differ from the fixture's (0.687960 tank, 0.435824
LGM): tanks interpolate worse across the corpus than in the sample, LGMs
better. Neither is evidence about this range of commits.

## v1.0.7 -- `323c673` "rejoin / alliance issues"

* `rate_shells_matched_forward` 0.948521
* `rate_shells_unlinked` 0.018737
* `rate_terminals_matched` 0.761484
* `terminals_matched:tank_hit` 201,999 of 269,483
* `shells_from_pillbox` 960,505
* `shells_with_pillbox_source` 5,183,572
* `shells_with_birth` 650,855 -- equal to `shells_from_tank`, i.e. only tank
  shells had a known birth, the same relationship the fixture shows
* `terminals_unseen_pillbox_source` 0
* `max_shell_interpolation_ticks` absent, reported `-`

## Branch point -- `main` at `76d8b8a`

The baseline the branch is judged against.

* `rate_shells_matched_forward` 0.961727
* `rate_shells_unlinked` 0.013738
* `rate_terminals_matched` 0.791346
* `terminals_matched:tank_hit` 211,623 of 269,483
* `shells_from_pillbox` 960,505 -- unchanged from v1.0.7
* `shells_with_pillbox_source` 5,262,988
* `shells_with_birth` 3,405,148
* `terminals_unseen_pillbox_source` 37,124 -- rises from v1.0.7's 0, the metric
  having become meaningful
* `shell_births` 650,858 -- tank shells only

## v1.0.8 -- `e4582dc` "aesthetic improvement"

The fixture file's claim that exactly one line moves between `76d8b8a` and
`e4582dc` **holds on the corpus**. The entire report diff is:

* `shell_births` 650,858 -> 1,611,362

Everything else is identical, including all four headline rates, every
`terminals_matched` class, `shells_with_pillbox_source` 5,262,988,
`shells_with_birth` 3,405,148 and `terminals_unseen_pillbox_source` 37,124.

One detail does *not* survive the scale-up. On the fixture the added births are
pillbox shells exactly: 9020 + 11661 = 20681. On the corpus the identity is one
short -- `shells_from_tank` 650,858 + `shells_from_pillbox` 960,505 = 1,611,363
against `shell_births` 1,611,362. So across 443 logs there is exactly one shell
with a known origin and no birth record. It is the only commit where the
identity fails: it is exact at `5f9d86f` (1,612,510) and at `926f391`
(1,612,444). See the findings.

## Branch -- `ad6a3b6` "Stuff"

The regression, and it is deeper on the corpus than on the fixture in the
shell-linkage metrics.

* `rate_shells_matched_forward` 0.934635 -- down 2.7 points from the branch point
* `rate_shells_unlinked` 0.032850 -- up from 0.013738, 2.4x the branch point
* `rate_terminals_matched` 0.776327 -- down 1.5 points
* `terminals_matched:tank_hit` 197,958 -- down 13,665, and below even v1.0.7's
  201,999
* `shells_from_pillbox` 764,990 -- down 195,515 from 960,505
* `shells_with_pillbox_source` 3,065,813 -- 58.3% of the branch point's
  5,262,988
* `shells_with_birth` 3,401,045
* `terminals_unseen_pillbox_source` 39,222
* `shell_births` 650,876

## Branch -- `5e69318` "consider this tolerance rather than shell sprite size"

* `rate_shells_matched_forward` 0.935831
* `rate_shells_unlinked` 0.032708
* `rate_terminals_matched` 0.782268 -- up 0.6 points from `ad6a3b6`
* `terminals_matched:tank_hit` 209,485 -- **up 11,527** from `ad6a3b6`
* `shells_from_pillbox` 764,990 -- unchanged
* `shells_with_pillbox_source` 3,065,728 -- down 85, effectively unchanged
* `shells_with_birth` 3,401,045 -- unchanged
* `terminals_unseen_pillbox_source` 39,222 -- unchanged

Same shape as the fixture: one metric moves and the rest hold. The caveat
carries over unchanged -- this span is three commits (`422c5ff`, `18b51b9`,
`5e69318`), so +11,527 is the trio's combined effect, not the tolerance commit
measured alone.

## Branch -- `c848efd` "Stuff"

A confirmation run. **Every metric is identical to `5e69318`**, all the way
through the file, which reproduces the fixture result at corpus scale and
confirms that `c848efd` and `dd553c5` are tooling-only.

## Branch -- `4f5dbe9` "Possible fix to a bad assumption", `using_the_pillbox_data` checkpoint

The repair, and the largest single movement in the file.

* `rate_shells_matched_forward` 0.967669 -- up 3.2 points from `5e69318`, and
  0.6 points above the branch point
* `rate_shells_unlinked` 0.011431 -- down from 0.032708, below the branch
  point's 0.013738
* `rate_terminals_matched` 0.813086 -- up 3.1 points from `5e69318`, 2.2 above
  the branch point
* `terminals_matched:tank_hit` 227,331 -- up 17,846 from `5e69318`, and 15,708
  above the branch point
* `shells_from_pillbox` 961,641 -- recovered from 764,990, and 1,136 above the
  branch point's 960,505
* `shells_with_pillbox_source` 5,833,694 -- recovered from 3,065,728, and
  570,706 above the branch point's 5,262,988
* `shells_with_birth` 3,406,344 -- up 5,299, and 1,196 above the branch point
* `shells_from_tank` 650,874
* `terminals_unseen_pillbox_source` 37,360
* `shell_births` 650,874 -- tank only; the branch lacks `f4f15d9`, so this is
  not comparable with v1.0.8
* `max_shell_interpolation_ticks` 50

The terminal breakdown moves the same way in every class:
`explosion` 146,757 -> 158,534, `pillbox_damage` 501,560 -> 525,809,
`shell_falls` 605,355 -> 611,487, `base_damage` 59,480 -> 59,461. On the corpus
`base_damage` is again the one class that goes backwards, by 19 -- the fixture
showed the same single-class regression, there by one terminal.

`4f5dbe9` is the only commit in this span touching `viewer/motion.js`, so the
whole gain is its own.

## Branch of the branch -- `83cb132` "Try to determine true location from quantized pillbox shots", `using_the_pillbox_data_antifuzz` checkpoint

The characteristic trade reproduces: shell matching up, terminal matching down
by a hair.

* `rate_shells_matched_forward` 0.972767 -- up 0.51 points from `4f5dbe9`
* `rate_shells_unlinked` 0.009576 -- down from 0.011431, the first corpus figure
  below 1%
* `rate_terminals_matched` 0.813034 -- **down** 0.000052 from `4f5dbe9`, i.e.
  100 terminals out of 1,946,439
* `shells_matched_to_snapshot` 7,967,478 -- up 50,140
* `shells_unmatched_forward` 267,361 -- down 50,040
* `shells_unlinked` 94,009 -- down 12,217
* `terminals_matched:tank_hit` 227,201 -- down 130
* `terminals_matched:shell_falls` 611,547 -- up 60
* `terminals_matched:base_damage` 59,466 -- up 5
* `terminals_matched:explosion` 158,518 -- down 16
* `terminals_matched:pillbox_damage` 525,790 -- down 19
* `shells_with_pillbox_source` 5,823,632 -- down 10,062
* `shells_with_birth` 3,406,335 -- down 9
* `shells_from_pillbox` 961,641, `shells_from_tank` 650,874,
  `terminals_unseen_pillbox_source` 37,360, `shell_births` 650,874 -- unchanged

The reading in the fixture file holds: origins and births are untouched while
snapshot-to-snapshot links get longer, which is what a better estimate of a
quantised shot's position should do.

## Branch after merging main -- `5f9d86f` "errors are one-sided"

* `rate_shells_matched_forward` 0.973966 -- up from 0.972767, a new best
* `shells_matched_forward` 9,561,777 -- up 11,777
* `rate_shells_unlinked` 0.009100 -- down from 0.009576, a new best
* `shells_unlinked` 89,340 -- down 4,669
* `rate_terminals_matched` 0.813066 -- **up** 0.000032 from `83cb132`, i.e. 61
  terminals recovered
* `shells_matched_to_snapshot` 7,979,194 -- up 11,716
* `shells_unmatched_forward` 255,584 -- down 11,777
* `terminals_matched:shell_falls` 611,581 -- up 34
* `terminals_matched:tank_hit` 227,223 -- up 22
* `terminals_matched:explosion` 158,536 -- up 18
* `terminals_matched:pillbox_damage` 525,780 -- down 10
* `terminals_matched:base_damage` 59,463 -- down 3
* `shells_with_pillbox_source` 5,811,672 -- down 11,960
* `shells_from_pillbox` 961,636 -- down 5
* `shells_from_tank` 650,874 and `terminals_unseen_pillbox_source` 37,361 --
  effectively unchanged
* `shells_with_birth` 3,406,339 -- up 4
* `shell_births` 1,612,510 -- both tank and pillbox births after the merge;
  650,874 + 961,636 = 1,612,510 exactly

This is the one commit whose *direction* differs from the fixture. See the
findings.

## Branch -- `926f391` "Tank shots in index 1+ have uncertainty too", `using_the_pillbox_data_antifuzz` HEAD

Holds all three headline records, and on the corpus it is cleaner than on the
fixture: it gains in **all five** terminal classes with no regression at all.

* `rate_shells_matched_forward` 0.975030 -- a new best
* `rate_shells_unlinked` 0.008829 -- a new best
* `rate_terminals_matched` 0.816566 -- up 0.003500 from `5f9d86f`, and 0.003480
  above `4f5dbe9`'s 0.813086, taking a record that had stood since it was set
* `shells_matched_forward` 9,572,222 -- up 10,445
* `shells_matched_to_snapshot` 7,982,827 -- up 3,633
* `shells_matched_to_terminal` 1,589,395 -- up 6,812
* `shells_unmatched_forward` 245,139 -- down 10,445
* `shells_unlinked` 86,675 -- down 2,665
* `max_shell_interpolation_ticks` 50

The terminal breakdown, all five up:

* `terminals_matched:pillbox_damage` 530,577 -- up 4,797
* `terminals_matched:shell_falls` 612,666 -- up 1,085
* `terminals_matched:tank_hit` 227,585 -- up 362, and 254 above `4f5dbe9`
* `terminals_matched:base_damage` 59,800 -- up 337
* `terminals_matched:explosion` 158,767 -- up 231

Attribution and births:

* `shells_from_tank` 650,808 -- down 66
* `shell_births` 1,612,444 -- down 66, the same shells:
  650,808 + 961,636 = 1,612,444
* `shells_with_birth` 3,410,213 -- up 3,874
* `shells_from_pillbox` 961,636 and `terminals_unseen_pillbox_source` 37,361 --
  unchanged; `shells_with_pillbox_source` 5,811,709 -- up 37

## Branch -- bradian tracking and chain stitching, `0d181be`

The tank-shell bradian work (`c4bf83c`, see `docs/tank_shell_bradians.md`)
plus the fragment-stitching pass (`0d181be`), run against the same corpus
from a live checkout of the branch. The measuring tool has gained one
commit since the ten-run table -- `5455724` added the tank-facing track
metrics, purely additively, so every key compared below is computed by
identical code -- and the corpus constants reproduce exactly (`shells`
9,817,361, `terminals` 1,946,439 with the same five-class breakdown,
`files_failed` 0), as do
all tank, LGM and facing track numbers, byte for byte: the branch touched
shell reconstruction and nothing else.

All three headline records move, the forward-matching one by more than
any commit in this file:

* `rate_shells_matched_forward` 0.984399 -- up from 0.975030;
  `shells_matched_forward` 9,664,200, **up 91,978**, closing 37.5% of all
  links that remained unmatched at `926f391`
* `rate_shells_unlinked` 0.005985 -- down from 0.008829;
  `shells_unlinked` 58,756, down 27,919, a 32% reduction
* `rate_terminals_matched` 0.816888 -- up 0.000322; 627 terminals
* `shells_matched_to_snapshot` 8,074,178 -- up 91,351 (the stitching);
  `shells_matched_to_terminal` 1,590,022 -- up 627

The terminal breakdown gains in **all five classes** -- on the fixture
`0d181be`'s span still showed a one-terminal `shell_falls` loss, which
corpus scale erases:

* `terminals_matched:tank_hit` 228,016 -- up 431
* `terminals_matched:pillbox_damage` 530,682 -- up 105
* `terminals_matched:base_damage` 59,852 -- up 52
* `terminals_matched:explosion` 158,791 -- up 24
* `terminals_matched:shell_falls` 612,681 -- up 15

Attribution flows across the stitched joins at scale:

* `shells_with_birth` 3,459,755 -- up 49,542
* `shells_with_pillbox_source` 5,881,532 -- up 69,823
* `shells_from_tank` 650,870 -- up 62; `shells_from_pillbox` 961,636 and
  `terminals_unseen_pillbox_source` 37,361 -- unchanged
* `shell_births` 1,612,506 = 650,870 + 961,636 **exactly**; the identity
  holds

## Branch -- forced assignment and jitter absorption, `4c791a0`

The forced-assignment residual resolver (`d10f153`) plus jitter
absorption and constant-velocity drawing (`4c791a0`), measured together
against the previous corpus run. Corpus constants and every tank, LGM
and facing number reproduce byte-for-byte again, and the birth identity
is exact: 652,292 + 963,996 = 1,616,288 = `shell_births`.

Both passes scale better than the fixture predicted -- the residue they
target is concentrated in laggy, dense games the hand-picked fixture
under-represents:

* `rate_terminals_matched` 0.827713 -- up from 0.816888, +21,071
  terminals; the fixture gained 0.65 points here, the corpus 1.08
* `rate_shells_matched_forward` 0.988925 -- up from 0.984399, +44,433
* `rate_shells_unlinked` 0.004020 -- down from 0.005985; `shells_unlinked`
  39,462, down 19,294, largely the absorbed phantom observations
* `terminals_unseen_pillbox_source` 96,171 -- up from 37,361, plus the
  new `terminals_unseen_tank_source` 58,266: about 117,000 impacts whose
  shell was never observed now name their firing pill or tank
* Counting unseen attributions, 90.7% of the corpus's 1,946,439 impacts
  have an explanation, against 83.6% at the `926f391` baseline; the
  truly unexplained residue is 180,909 (9.3%)
* Every terminal class gains: `tank_hit` +5,164 (86.5% matched),
  `pillbox_damage` +7,447, `shell_falls` +4,586, `explosion` +2,739,
  `base_damage` +1,135
* Origins spread: `shells_with_birth` +11,500,
  `shells_with_pillbox_source` +19,905, `shells_from_pillbox` +2,360,
  `shells_from_tank` +1,422; `shell_births` 1,612,506 -> 1,616,288

Cumulative for the branch against the `926f391` baseline: unmatched
forward shells 245,139 -> 108,728 and unlinked 86,675 -> 39,462, both
better than halved; forward matching 0.975030 -> 0.988925; terminals
0.816566 -> 0.827713 with all five classes up.

## Branch -- absorption temporal gate, `b345ef0`

The fix for the dense-stream false absorption found in replay `122903.4`
(a trailing shell claimed as a stitched leader's intermediate because it
sat on the segment, drawing a shell that hovered and then rocketed).
Requiring absorbed observations to agree with uniform time rejects about
955 such claims corpus-wide -- each one a wrong identity that rendered
as that artifact:

* `shells_matched_to_snapshot` 8,096,589 -- down 951;
  `shells_unlinked` 40,367 -- up 905. These are the false absorptions,
  now correctly unexplained rather than wrongly explained.
* `rate_terminals_matched` 0.827709 -- down 8 terminals of 1.9M;
  `terminals_unseen_tank_source` down 2; everything else within a few
  counts, and `shell_births` rises 12 with the identity still exact
  (652,296 + 964,004 = 1,616,300).
* Non-shell tracks byte-identical; corpus constants reproduce.

A reminder the headline rates measure matches, not truth: this commit
makes the numbers fractionally worse and the replays visibly better.

## Drawn-motion audit -- corpus baseline at `f340943`

The first corpus run of `tools/audit-drawn-motion.cjs`, on the engine
with cost-forced assignment. This is the baseline of record for the
drawn-quality axis; historical values are recoverable through worktrees
since the tool runs on old engine states (the fixture calibration in
`interpolation_tests.md` anchors the history: pre-smoothing engines sat
near 79% steady links there).

* `links` 8,098,852; `rate_links_steady` 0.966038 -- 96.6% of all drawn
  links move at 1.8-2.2 px/tick
* `hover_links` 454 (0.006%); `rush_links` 6,193 (0.08%)
* `pop_outs` 100,216 (1.02% of observations); `pops_paired_forward`
  44,652; `pops_paired_backwards` 11,759 (~27 per game)
* `terminal_links_rushed` 76,603 of 1,618,107 -- arrivals capped by an
  event record that landed early; lag-related, cosmetically mild
* `seam_jumps` 5 (max 3.16 px) -- five violations in 8.1M links of an
  invariant the fixture holds exactly. A genuine rare bug, likely a
  successor's orbit-exact pixel refined after its predecessor's link
  target froze. On the books, low priority.
* `audit_ms` 5,830 total across 443 replays -- about 13 ms each

Reading it forward: the 44,652 forward-paired pops are the named,
counted core of the remaining visible artifacts -- vanish-and-reappear
events the audit's own pairing judges to be one shell continuing. They
are the target for the next round of matching work, with this tool as
the scorekeeper.

## Branch -- cost-forced assignment and pop rescue, `f340943` + `a74033a`

One corpus report covering the two engine commits since `b345ef0`:
cost-forced residual assignment (`f340943`, accept an edge when every
rival costs more than the three-pixel margin) and the pop rescue
(`a74033a`, dilated joins for clock-dilated fragments plus draw-only
visual joins for same-ray ambiguity). No corpus report was run at
`f340943` alone, but the drawn-motion audit was, and its
`terminal_links` figure lets the terminal movement be decomposed.
Deltas against `b345ef0`:

* `rate_shells_matched_forward` 0.993609 -- up from 0.988826, about
  +47,000 shells, a new record; `shells_unmatched_forward` 62,747
* `rate_shells_unlinked` 0.002202 -- down from 0.004112;
  `shells_unlinked` 21,615, down from 40,367, nearly halved again, a new
  record
* `rate_terminals_matched` 0.828353 -- up from 0.827709, +1,255 net, the
  best *recorded* figure. Decomposed via the `f340943` audit's
  `terminal_links` 1,618,107: cost-forcing gained about +7,024 terminals
  (the fixture predicted +35 -- another two-hundred-fold corpus
  amplification of a residue concentrated in laggy games), then the pop
  rescue gave back 5,769 (fixture -45) as continue-vs-die
  reassignments. The unmeasured `f340943` peak, about 0.831256, was
  higher than where we now stand.
* `terminals_matched:tank_hit` 232,342 -- down 838 from the `4c791a0`
  record; the give-back concentrates here, previously inferred tank-hit
  deaths reassigned to rescued continuations
* `shells_visual_joins` 5,240 -- about 12 draw-only links per game
* `terminals_unseen_pillbox_source` 120,074 and
  `terminals_unseen_tank_source` 64,215 -- up from 96,171 and 58,264.
  Counting unseen attributions, 1,796,627 of 1,946,439 impacts now have
  an explanation, 92.3% against 90.7% at `4c791a0`; the truly
  unexplained residue is 149,812 (7.7%)
* Birth identity exact: 652,247 + 964,248 = 1,616,495 = `shell_births`,
  up 195; `shells_from_tank` down 49, `shells_from_pillbox` up 244
* Non-shell tracks and corpus constants reproduce (122.8M tank ticks,
  112.3M LGM ticks, byte-identical rates)

## Drawn-motion audit at `a74033a`

The rescue was built against this tool's baseline; here is its own
verdict, against `f340943`:

* `pops_paired_forward` 9,443 -- down from 44,652, a 78.9% collapse
  (the fixture managed 89%); about 101 per game to about 21
* `pop_outs` 62,561 -- down from 100,216 (1.02% of observations to
  0.64%); `pops_paired_backwards` 5,588 -- down from 11,759, halved
* `rate_links_steady` 0.964359 -- down from 0.966038; `rush_links`
  4,860, down from 6,193
* `hover_links` 3,562 -- up from 454, the visible cost. Dilated joins
  draw below 1 px/tick across intervals the sender's clock stretched;
  1,052 links sit below 0.5 px/tick. About 8 per game. The audit-side
  follow-up is a floor on drawn speed (or a per-chain smoothing cap) so
  a rescued identity never renders as a loitering shell.
* `seam_jumps` 128 -- up from 5, `seam_jump_max` 3.16 unchanged. The
  known rare handoff bug grew with the new join types; still tiny in
  magnitude and count (128 of 8.1M links), on the books.
* `terminal_links_rushed` 76,597 -- flat from 76,603

Reading it together: the named target -- the four-fifths of visible
vanish-and-reappear artifacts the audit judged to be one shell -- has
collapsed, at the cost of a small terminal give-back, a hover class that
needs a drawing-side floor, and two dozen more seam jumps. The 9,443
that remain are chains whose dilation exceeds even the widened windows
(the bradian audit's growing `no_model` class points the same way) plus
true cross-client migrations, which draw as pops by design.

## Leading impacts -- `ad2168d`

Residual end-to-fate edges may now *lead* the receiver-clock arrival
estimate, bounded by the gap back to the sender's previous record (see
the fixture file's entry for the mechanism and the motivating replay).
The fixture predicted +34 shells matched forward and +24 terminals; the
corpus delivers roughly 100x both, the by-now-familiar amplification of
a residue concentrated in laggy games -- and this change is specifically
about lag. Deltas against `a74033a`:

* `rate_shells_matched_forward` 0.993965 -- up from 0.993609, +3,501
  shells, a new record; `shells_unmatched_forward` 59,246
* `rate_shells_unlinked` 0.002019 -- down from 0.002202;
  `shells_unlinked` 19,823, down from 21,615, a new record
* `rate_terminals_matched` 0.829538 -- up from 0.828353, +2,307
  terminals, the best recorded figure (the unmeasured `f340943` peak
  still stands, on an engine with 44k forward-paired pops)
* `terminals_matched:tank_hit` 233,481 -- up 1,139, recovering the pop
  rescue's 838 give-back and passing `4c791a0`'s 233,180 record by 301.
  The continue-vs-die reassignments that cost tank hits at `a74033a`
  are exactly the cases this change re-decides: the continuation and
  the death now both get claimed.
* `terminals_unseen_pillbox_source` 120,090 (+16) and
  `terminals_unseen_tank_source` 64,181 (-34) -- essentially flat.
  Counting unseen attributions, 1,798,916 of 1,946,439 impacts have an
  explanation, 92.4%; the truly unexplained residue is 147,523
* Birth identity exact: 652,260 + 964,260 = 1,616,520 = `shell_births`,
  up 25
* `shells_visual_joins` 5,212 -- down 28; a few former draw-only links
  are now believed
* Non-shell tracks and corpus constants reproduce (122.8M tank ticks,
  112.3M LGM ticks)

The drawn-motion audit, against `a74033a`:

* `pop_outs` 59,060 -- down from 62,561 by exactly 3,501: every newly
  matched shell was previously a visible pop. `pops_paired_forward`
  9,162, down from 9,443; `pops_paired_backwards` 5,514, down from
  5,588; `rush_links` 4,841, down from 4,860
* `seam_jumps` 128 and `seam_jump_max` 3.16 -- byte-identical; the rare
  handoff bug neither grew nor moved
* `terminal_links_rushed` 79,521 -- up from 76,597, the expected cost:
  a lead match caps its arrival at the fate record's time, so the final
  link draws fast. 4.9% of terminal links, from 4.75%; the same
  capped-arrival cosmetic lagging events already paid, landing on
  chains that previously rendered as a pop-out plus a frozen orphan
* `hover_links` 3,642 -- up 80, same neighbourhood as before;
  `rate_links_steady` 0.963885, down from 0.964359

Reading it together: a both-axes gain at full scale -- more shells
matched forward *and* more terminals explained, with every pop class
down and the seam-jump invariant untouched -- paid for with ~2,900 more
rushed final links. The rushed-terminal class remains the obvious
drawing-side follow-up (a per-link speed cap at draw time), but it
predates this change.

## Uncapped shell falls -- `7b9030a`

The promised drawing-side follow-up, taken for the one terminal type
whose timing is purely cosmetic. Deltas against `ad2168d`:

* `terminal_links_rushed` 69,351 -- down from 79,521, a 12.8% bite.
  10,170 falls that used to slam into their splash now draw the whole
  final leg at 2 px/tick, splash retimed to the drawn shell's arrival,
  fall segments carrying the sprite past the record. To be clear about
  what is being claimed: the sender-side splash necessarily happened
  *before* its record arrived, so a lead-case retime moves the splash
  *further* from sender truth, not closer -- what it buys is scene
  consistency, the splash landing where and when the drawn shell does,
  on a drawn timeline already built from the restatement clock that was
  lying in the first place. This lands the class
  *below* the 76,597 of the pre-lead-fix baseline: the +2,924 that
  `ad2168d` added are repaid two and a half times over.
* The falls share of the class turns out to be ~13%. The remaining
  69,351 are object impacts and blocking terrain, capped by design --
  their flash belongs beside the authoritative state change.
* Hover links, rush links, the steady rate, and the seam-jump pair
  (128 / 3.16) are byte-identical; `pop_outs` down 2.
* The fixture's "drawing-only, byte-identical" claim is *almost* true
  at scale, but not exactly: +2 shells matched forward, +3 matched
  `shell_falls` terminals, -1 unlinked, +1 birth (terminal rate
  0.829538 -> 0.829539). The coupling is `equivalent_shell_candidates`,
  which treats a restatement and an impact within one tick as the same
  endpoint -- an uncapped fall arrival flips a handful of equivalence
  decisions. Three in ten million, every one favourable, invisible on
  the fixture; recorded here so the coupling is on the books.
  **Removed at `70b1227`**: pairwise candidates now carry the capped
  `end_time` for decisions and a separate `draw_end_time` for the
  renderer. The residual path needed no split -- the flow solver has
  decided everything before an assignment is applied. Confirmed by
  re-run at `70b1227`: the report is byte-identical to the `ad2168d`
  run (the wiggle given back, terminals 1,614,645, `shell_falls`
  619,133), the audit's link structure reverts with it, and
  `terminal_links_rushed` holds at 69,351 -- the drawing win survives
  the decision revert in full.

## Orbit-backed absorption and its guards -- `33e1ee5` + `90925b0`

The branch's absorption work at full scale: `33e1ee5` lets pill-orbit
evidence absorb a stitch-skipped restatement however far the sender's
clock drifted (the 101202.10 pillbox-3 case), and `90925b0` guards it
for dense streams -- at most one candidate per snapshot, and an
observation the surviving orbits rule out is refused outright. Measured
by the corpus owner at the branch tip `c26595b` (engine identical to
`90925b0`; `c26595b` is tooling only). Deltas against the `70b1227`
re-run. The guards fired roughly a hundred times more often than on the
fixture: an angry pillbox fires every five or six ticks, so the
multiple-candidate configuration the fixture shows seven times is
routine in laggy games.

The report:

* `rate_shells_matched_forward` 0.993725 -- down from 0.993965,
  `shells_unmatched_forward` 61,607 (+2,361); `rate_shells_unlinked`
  0.002190 -- up from 0.002019 (21,500, +1,677). Both give back part of
  the records set at `ad2168d`, landing between `a74033a` and
  `ad2168d`. The give-back is the double-absorbed stream-mate pairs no
  longer counted as matches: each was one zero-duration link plus one
  stolen identity, so this is invented explanations leaving the ledger.
* `rate_terminals_matched` 0.829357 -- 1,614,293, down 352 of 1.6M,
  essentially flat. Counting unseen attributions, 1,798,555 of
  1,946,439 impacts have an explanation, still 92.4%.
* `terminals_matched:shell_falls` 619,140 (+7);
  `terminals_matched:tank_hit` 233,450 (-31).
* `shells_visual_joins` 5,435 -- up 223: some of the refused ambiguity
  re-enters as draw-only continuations, believed by nothing.
* Birth identity exact: 652,279 + 964,272 = 1,616,551 = `shell_births`,
  up 31.
* Corpus constants reproduce: 443 files, no failures, 9,817,361 shell
  observations, 122.8M tank ticks, 112.3M LGM ticks.

The drawn-motion audit:

* `rush_links` 3,995 -- down from 4,841, a 17.5% collapse. This was the
  point: the same-time double-absorb links drew as instant sideways
  blips, and they are gone from the drawn output.
* `pop_outs` 61,421 -- up from 59,060 by exactly the 2,361 newly
  unmatched shells, the audit's usual identity.
* `pops_paired_backwards` 5,792 (+278) and `pops_paired_forward` 9,292
  (+130) -- the visible cost: a refused observation pops at its stale
  position, behind the drawn chain. `hover_links` 4,163 (+521), the
  same neighbourhood as every rescue so far. `rate_links_steady`
  0.963579, from 0.963885.
* `terminal_links_rushed` 69,384 -- +33, flat.
* `seam_jumps` 129, `seam_jump_max` 3.16 -- one more instance of the
  known on-the-books family, magnitude unchanged.

Reading it together: the degenerate-link class collapsed as designed and
terminals held, paid for in the residue classes -- honest pops where
invented threads used to be. The one number pointing at more work is the
backwards-pop rise: refused stream-mate observations in multi-snapshot
gaps pair as reappear-behind artifacts, and they are exactly the shape
the visual-join machinery exists for -- every candidate story draws the
same ray. Extending draw-only joins to refused absorption candidates is
the follow-up.

**The follow-up measured null.** `9471365` rank-pairs equal-sized
refusal groups on consecutive snapshots of one stitch's gap into
draw-only joins; a clean re-run at `a8538fa` (the first with the commit
line in the header, ruling out a stale checkout) is byte-identical on
both axes -- zero activations in 9.8M observations. Consecutive stale
records are stale by similar amounts, so they pairwise-match each other
into fragments; orphans arise at staleness *transitions*, one bad
record between good ones, which is a single-snapshot shape the rank
pass deliberately does not touch. So the backwards-pop residue lives in
configurations not yet identified: the audit's `--describe-backwards`
mode (with `absorption_refused` / `absorption_contradicted` breadcrumbs
in the engine) exists to name them from data. First reading, on replay
101202.10: its backwards pops are matched pill-stream chain ends
pairing with unclaimed observations a few pixels behind -- no refusal
involvement at all. The corpus tally is the one to run.

## The backwards-pop anatomy -- diagnostic at `ab7e4e9`

The `--describe-backwards` tally over the full corpus (5,792 backwards
pops, examples from 366 of 443 files -- a corpus-wide phenomenon at
about thirteen per game, not a few pathological logs):

* 92.2% of the pop-outs are MATCHED chain ends (`m...`): established,
  often pill- or bradian-attributed chains that stop without an
  explained fate. Only 410 involve a stitch.
* 70.1% of the pop-ins are chained list members (`...q`), 25.0% bare
  unflagged heads: observations with no predecessor and no claimed
  birth.
* The absorption guards are largely exonerated: `R` appears in 5.4% of
  pairs and `C` in 3.9% -- together about the size of the +278 the
  guard commit added, and no more. The base phenomenon predates
  absorption entirely.
* The reappearance distance is the give-away: median 13 px behind the
  vanish point, p10 48 px -- one angry-pill fire interval (five to
  seven ticks at 2 px/tick) and multiples of it, at ordinary
  restatement cadence (dt mostly under 20 ticks). Not quantisation
  (which would sit at a pixel or two), not lag gaps.

Reading: a backwards pop is STREAM TURNOVER, not a motion error. The
leading shell of a same-ray stream dies with its terminal unexplained
(the 17% of impacts still unmatched), and a follower that was never
birth-claimed -- its shot record lost, or fired capacity mis-assigned --
first appears one fire interval behind. The audit pairs the two as a
reappear-behind artifact; the eye mostly reads a continuing stream. The
two real targets are therefore upstream and already-known weaknesses
that compound here: terminal matching for stream leaders, and birth
attribution that survives a lost F4 -- an observation lying on a known
pill's orbit at a plausible step is claimable as an unseen-shot birth
the same way `unseen_pillbox_source` already claims impacts.

The rank-pairing rescue (`9471365`), aimed at refused-group pairs this
tally shows barely exist, is reverted with this entry: zero activations
in 9.8M observations, and the R classes it targeted are single-snapshot
shapes it could never touch. The absorption guards, the visually-claimed
census rule, and the diagnostic breadcrumbs stay.

## Unseen-shot births -- `775fe4b`

The backwards-pop anatomy's named target, measured at `f1e7624` (a
gitignore line on top of `775fe4b`; engine identical). An origin-less
chain whose every observation lies on one live pill's orbit at strictly
increasing steps is claimed as that pill's shot -- no F4 required --
after every F4-backed and forced explanation has had first refusal.
Deltas against the guard run:

* `shells_unseen_pillbox_birth` 14,352: lost-F4 shells recovered, each
  now drawn from the muzzle with its shooter named.
  `shells_from_pillbox` 964,272 + 14,352 = 978,624 exactly;
  652,279 + 978,624 = 1,630,903 = `shell_births`, the birth identity
  exact as ever. `shells_with_pillbox_source` +104,285 -- about 7.3
  observations of attribution carried down each claimed chain, matching
  the three-to-seven chain lengths inspected on 101202.10.
* `pop_ins` 59,352 -> 45,001, down 24% -- one less than the claim
  count, one claim sitting in a first snapshot where it never counted.
  `pops_paired_backwards` 5,792 -> 3,908, down 32.5% and now well BELOW
  the pre-guard 5,514: the claimed shells were the reappearing-behind
  side of the pairs, exactly as the anatomy said.
  `pops_paired_forward` 9,292 -> 6,579.
* Every matching metric is byte-identical -- matched forward, unlinked,
  terminals, every track number -- as a claims-only change must be.
  `pop_outs`, `terminal_links_rushed` and the seam pair (129 / 3.16)
  likewise. The only other audit movement is a small speed-bucket
  shuffle (`rush_links` +34 of 8.1M links) from smoothing re-anchoring
  on claimed heads' exact orbit pixels.

Confidence rules held up: raw orbit membership alone would have claimed
half again as many on 101202.10 (50 against the 37 claimed); chains of
two or more corroborated observations, single sightings only exact and
at most four steps from the muzzle, and the one-surviving-pill rule
trim the coincidences. Claimed heads sit at steps 3-10 -- first seen
one or two restatements after firing, the lost-F4 profile.

Branch total on the drawn axis, against the pre-branch `70b1227`
baseline: `rush_links` 4,841 -> 4,029, `pops_paired_backwards`
5,514 -> 3,908, `pops_paired_forward` 9,162 -> 6,579, `hover_links`
3,642 -> 4,164, at a matching-ledger give-back of 0.000240 forward and
+1,677 unlinked -- the guard entry's invented explanations leaving. The
remaining 3,908 backwards pairs are unnamed; a `--describe-backwards`
run at this commit would show what survives now that the `U` class is
visible.

## Stream-provenance births -- `a78253b`

The residual backwards tally at `709ca93` had said `any U: zero` -- the
orbit-membership claims removed their family completely -- and named one
remaining class as a gap rather than a frontier: 655 pairs whose pop-in
already carried a pillbox source. `propagate_ambiguous_pillbox_orbits`
names a head's pill and orbit states without claiming which stream-mate
it is (the only path that stores a source on an unclaimed head), but
nothing marked it birth-drawable. Which slot it holds does not matter
for its birth: in every candidate story it flew from that muzzle.
Measured at `7050c31` (a gitignore line on `a78253b`; engine identical),
against the `775fe4b` run:

* `shells_stream_birth` 2,785; `pop_ins` 45,001 -> 42,216, exactly the
  claim count. `shells_from_pillbox` 978,624 + 2,785 = 981,409 and
  `shell_births` +2,785, both exact; `shells_with_pillbox_source`
  unchanged -- these heads already carried their source, which was the
  point.
* `pops_paired_backwards` 3,908 -> 3,253: minus 655, precisely the
  in-`P` class the previous tally counted, and the new tally confirms
  `in has P: 0` -- the class is extinct. `pops_paired_forward`
  6,579 -> 5,917.
* Everything else on both axes is byte-identical, seam pair included.

What remains of the backwards class, 3,253 pairs, is now purely the two
known frontiers: tank-stream turnover (`out k`, 982 -- a lost 5d has no
orbit anchor, so a tank-birth analogue would need the bradian
hypothesis machinery, with far weaker constraints), and stream leaders
dying with unexplained terminals (`out P` 889, unattributed 1,382),
which is the terminal-matching frontier by another name.

Branch total on the drawn axis, `70b1227` -> here:
`pops_paired_backwards` 5,514 -> 3,253 (-41%), `pops_paired_forward`
9,162 -> 5,917 (-35%), `rush_links` 4,841 -> 4,029 (-17%),
`hover_links` 3,642 -> 4,164 (+14%), with 17,137 shells claimed to
their muzzles and shooters, at a matching-ledger give-back of 0.000240
forward and +1,677 unlinked -- the invented explanations the guard
entry removed.

## The terminal-failure census -- diagnostic at `adb0537`

Item 6 opened like the backwards-pop work did, with a census before any
dial: `--describe-terminals` classifies every terminal that ends the
pipeline unexplained (no matched shell, no unseen source) by the one
constraint that killed its nearest-to-viable story. Corpus run at
`adb0537`, 443 files: 148,056 classified, reconciling exactly with
332,146 unmatched minus the unseen-attributed (172 terminals carry both
unseen flags, hence the apparent off-by-172 in naive subtraction).

* By reason: `end_continued` 34,277 (23.2%), `no_candidate` 31,723
  (21.4%), `orbit_miss` 19,602 (13.2%), `edge_unforced` 13,263 (9.0%),
  `end_claimed_other_fate` 12,639 (8.5%), `direction` 9,854,
  `ray_miss` 8,629, `creation_unforced` 7,114, and timing classes
  under 4% each. Largest single signature:
  `pillbox_damage:end_continued:T`, 19,725.
* Dissecting that signature on the fixture found not stream turnover
  but **adjacent-pill crossfire**: a pill returning fire at a tank
  sends shells through its neighbour pill one tile away (~25px,
  ~12 ticks -- shorter than a record gap), so the shells are never
  restated and the `pillbox_fires` shot and the neighbour's
  `pillbox_damage` arrive in the same record. `creation_fate_match`
  required `duration > 0`, so a same-record shot could never explain a
  same-record impact -- the commonest case for point-blank flights was
  unexplainable by construction. The nearby tank stream then wins the
  census label as a geometric red herring (the classifier ranks end
  stories above creation stories).
* Fixture-side measurement of the hole: admitting same-record sources
  raises creation-explainable unexplained terminals from 154 to 991 of
  1,639 -- 60%, an upper bound but the dominant structural gap by far.

## Same-record unseen shots -- second residual phase

The fix: after the residual flow runs untouched, a second forced
assignment matches same-record shots (fire-time window widened by the
sender's record gap, `creation_fate_match` interval cost) onto the
fates that remain unexplained. Strictly additive by construction --
the edges compete only with each other, phase one is already applied,
and its spent creation capacity is honoured.

Fixture: unexplained 1,639 -> 1,103 (-33%);
`terminals_unseen_pillbox_source` 864 -> 1,209,
`terminals_unseen_tank_source` 934 -> 1,125 (sum +536, exactly the
census drop). Everything else in the report and the entire drawn-motion
audit are byte-identical. The census red herrings deflate with the hole:
`direction` 208 -> 18, `no_candidate` 406 -> 224, `end_continued`
354 -> 244.

Corpus verification at `20694f2`, 443 files: the additivity argument
held exactly at scale. `terminals_unseen_pillbox_source`
120,077 -> 163,396, `terminals_unseen_tank_source` 64,185 -> 78,460
(+57,594 attributions); every other line of the report and the entire
drawn-motion audit byte-identical to the `adb0537` run. The census
falls 148,056 -> 90,570 (-39%), and the red herrings deflate as on the
fixture: `no_candidate` 31,723 -> 9,657, `orbit_miss` 19,602 -> 7,845,
`direction` 9,854 -> 1,048. What leads now is `end_continued` 22,629
(25.0%) and `creation_unforced` 22,092 (24.4%) -- the latter being
shots that reach their impacts but lose to rival stories inside the
forcing margin, the near-claims the next dial has to arbitrate.

One footnote the corpus exposed: the both-flags overlap grew 172 -> 280,
because `apply_forced_unseen` only skipped terminals already stamped by
its OWN kind, so a pill claim and a tank claim could stamp the same
terminal while an identical sibling stayed unexplained. One terminal is
one shell's impact; the skip now covers either kind, which redirects
those wasted stamps to open siblings (fixture: no change; corpus:
expected to convert up to ~280 double-stamps into explanations at the
next measured commit).

## Equivalence-forced attributions, and what `creation_unforced` really was

The census's 22,092 `creation_unforced` suggested a third phase:
per-edge forcing is defeated by interchangeable parallel stories (two
identical shots explaining two identical impacts leave no single edge
forced though the SOURCE is certain in every story -- the
stream-provenance argument again), so attribute a fate when every
creation story within the forcing margin names one source identity, no
live shell story competes inside that margin, and the identity has
unspent capacity. A shells-hidden fixture probe predicted ~213 claims;
the implemented phase, which honours real capacity, found 16. The gap
was the finding: 1,749 of the fixture's 2,357 creation groups are FULLY
SPENT by phases one and two -- the diagnostics were reading the
pre-residual unclaimed lists and dressing exhausted sources up as open
stories. A shot that already explains a birth or an impact is not
available to explain another.

Two changes: the equivalence phase (small, capacity-safe, kept), and
the residual pass now writes its spending back to the snapshots'
unclaimed-source lists, so the census is capacity-honest. Fixture:
unseen +16 (pill 1,209 -> 1,223, tank 1,125 -> 1,127), audit and all
match counts byte-identical; census 1,103 -> 1,087, with
`creation_unforced` collapsing 224 -> 4 and the spent stories
redistributing to their true labels (`no_candidate` 224 -> 304,
`direction` 18 -> 73, `ray_miss` 81 -> 112, `orbit_miss` 123 -> 149).
The corpus's 22,092 should deflate the same way, which re-points the
frontier at `end_continued` -- the impacts whose shot became an
observed chain that was then continued past them: continue-vs-die,
as the roadmap's standing question anticipated.

Corpus verification at `71b2c83`, 443 files, reconciling to the digit:
`terminals_unseen_pillbox_source` 163,396 -> 168,222,
`terminals_unseen_tank_source` 78,460 -> 78,969 (+5,335 claims -- ten
times the fixture's ratio; the corpus is richer in multi-shot
same-source scenes), census 90,570 -> 84,955 (-5,615 = 5,335 claims
plus exactly the 280 double-stamps the previous entry predicted; the
both-flags overlap is now zero corpus-wide). Every other report line
and the entire drawn-motion audit byte-identical yet again.
`creation_unforced` deflates 22,092 -> 1,715 as the capacity-honest
reading predicted, redistributing mostly into `no_candidate`
(9,657 -> 17,914) and `orbit_miss` (7,845 -> 11,682).

Item 6 running total, `20694f2`'s baseline -> here: unexplained
terminals 148,056 -> 84,955 (-43%), unseen attributions +62,929, with
zero movement anywhere else on either axis. The remaining frontier:
`end_continued` 20,321 (23.9%), `no_candidate` 17,914 (21.1%),
`orbit_miss` 11,682, `edge_unforced` 10,519 -- and the first of those
is the continue-vs-die decision, which is not additive and gets the
measure-first treatment.

## Continue-vs-die measured, and mostly acquitted -- `54f16d3`

The measure-only cut subclassified the 20,321 `end_continued` corpus
cases (non-census lines byte-identical, as a diagnostics-only commit
must be): `.short` 17,855 (87.9%) -- the chain's continuation falls
SHORT of the impact, still approaching the box -- against `.thru`
2,466 (12.1%), the drawn fly-past. `+clps` 4,712 chains later claim an
identical same-box terminal; pill chains 6,249 of which 6,245 have
orbit-member continuations; tank chains 13,934.

Then the raw-record arithmetic on collapse scenes acquitted the
matcher: in the first scene, 13 fire events produced only 6 observed
heads and 8 impacts on the box -- the sender fires faster than it
restates, so nearly half the volley's shells were REAL BUT NEVER
OBSERVED, and the unexplained impacts are theirs. The drawn chains are
mostly correct single shells riding volleys with invisible siblings;
"splitting" chains at the extra impacts would invent deaths that never
happened, and even the `.thru` fly-past can be a correct rendering (the
box was broken by an unseen sibling while the observed shell legally
passed). The dense scenes are also multi-source (tank plus pills on
one box), which is why the equivalence phase's single-identity test
rightly refuses them: WHICH source caused impact #7 is genuinely
ambiguous, and per the owner's adjacency call, attributing it buys
nothing visible.

Consequence: the census residue is largely an accounting residue in
scenes whose drawing is already right. The watcher-visible remainder
lives on the AUDIT side -- 3,253 backwards pops (~2,270 of them stream
leaders vanishing mid-air with their fates unexplained), 61,421
pop-outs -- and the dial worth designing is die-at-impact for CHAIN
ENDS: give a popping-out leader its death at a fitting unexplained
impact. That is not a split of any healthy link, and it is where the
eye actually catches the error.

## The end-side census, and die-at-impact -- `0b60520` + the dial

`--describe-ends` mirrors the terminal census from the watcher's side:
for every chain end with no forward story (61,421 corpus, exactly the
audit's pop-outs), what fate was available and what blocked it? Corpus
at `0b60520`: `fate_taken` 24,624 (40.1%), `fate_open` 10,580 (17.2% --
a valid edge to a still-unexplained impact, blocked only by ambiguity),
`ray_miss` 9,396, `window_expired` 4,714, `fate_unseen` 3,681 (the
impact went to an unseen-shot attribution while an observed shell
vanished), `no_candidate` 2,840.

The dial: die-at-impact, the drawn-side twin of the visual join. When
every within-margin story for an unfated end is a death at one
geometry -- no continuation candidate survives inside the margin --
the end takes the cheapest still-open fate and the mid-air vanish
becomes a death at the wall. It runs before the unseen-shot phases, so
an observed shell outranks an invisible sibling for the same impact.
Building it exposed an ordering gap worth remembering: the residual's
edges are built before its assignments run, and a forced origin gives
a chain its heading DURING application, so box-terminal edges that
need the ray never existed -- the dial therefore re-probes current
shell state rather than reusing the graph's edges (on the fixture that
was the difference between 9 deaths and 34).

Fixture: 34 deaths (`terminals_matched` 20,638 -> 20,672, the arc's
first real match gains), pop-outs 384 -> 350, one forward-paired pop
gone, one unseen claim ceded to a live shell, `fate_open` 63 -> 26
(the rest are contention and start-rival blocks, honest), and nothing
else moves on either axis. Corpus verification pending -- this commit
is MEANT to move the audit, and the prediction is pop-outs down by
several thousand with hover/rush/seam untouched.

Corpus verification at `60e52b1`, 443 files: 5,396 deaths.
`terminals_matched` 1,614,293 -> 1,619,689 and pop-outs
61,421 -> 56,025, exactly complementary; forward-paired pops
5,917 -> 5,733, backwards 3,253 -> 3,096; hover, rush, seam and the
whole link-speed histogram untouched; 337 unseen claims ceded to live
observed shells (the intended preference); `fate_open` 10,580 -> 4,097
with the un-applied remainder reclassified as contention.

The backwards question got its answer: only -157. The vanishing stream
leaders are NOT in `fate_open` -- the post-dial census is dominated by
`fate_taken` (25,893, led by `fate_taken:shell_falls:P` at 8,045):
ends whose fitting event was claimed by a sibling chain, the stream
collapse seen from the end side, plus range-end falls whose events
never arrived. Note the perceptual reading of that residue: a shell
vanishing AT ITS RANGE END is what really happened (it fell), so much
of the remaining pop-out count may be visually correct already; the
audit's pop_outs metric does not yet distinguish mid-flight vanishes
(the true artifact) from range-end ones. That subdivision is the next
instrument to build before chasing the number further.

Item 6 running total, `20694f2`'s baseline -> here: unexplained
terminals 148,056 -> 79,896 (-46%), terminals_matched +5,396 (real
matches, not attributions), unseen attributions +62,592 net, pop-outs
-8.8%, and on the whole branch's drawn axis backwards pops now stand
at 3,096 against `70b1227`'s 5,514 (-44%) and forward-paired at 5,733
against 9,162 (-37%).

## Subsumed joins in the residual flow -- `029acac`

Origin: a replay outside the corpus (031403.1), where a pillbox shot
that visibly hits a stationary tank popped mid-air with the tank hit
unexplained. The shell's last restatement arrived with the sender's
clock lying by six ticks; the pairwise matcher rightly refused the hop,
and in the residual flow the dilated join to that orphan restatement
(cost 11.18) and the fate edge to the impact (9.93) then sat within the
forcing margin of each other -- two rival consumers of one chain end
that are really halves of one story, each vetoing the other. The
`edge_unforced` census class, in other words, seen from inside.

Three changes, all residual-layer (the pairwise matcher, its margins,
and the absorption census are untouched; a first attempt that admitted
off-clock continuations in the pairwise successor gate was abandoned
after it broke three designed guarantees -- it poisoned long stitches
into hover-and-rush and let the stitcher claim ambiguous stream-mates
around the census): a join edge to a lone orphan start that is provably
an intermediate of a fate edge's flight (exact orbit point, surviving
bradian, strictly between the end's step and the fate's entry step) is
*subsumed* -- kept out of the flow so it cannot cost the fate its
forcing; a forced terminal then absorbs such intermediates through
`absorb_intermediate_observations` and its census, re-timing the
arrival from the last absorbed observation; and `shell_terminal_match`
extends the residual pass's gap-bounded lead allowance to orbit-tracked
ends (previously diagnostics-only on the assumption discrete distances
never need it -- false for an end whose restatement was delayed: one
fixture fall was being refused by 0.016px), with the ordinary branch's
dilated penalty mirrored.

Fixture: unlinked 169 -> 158, terminals_matched 20,672 -> 20,692
(tank hits +15), matched forward 0.995254 -> 0.995634, pop-outs
350 -> 322, at the cost of twelve more rushed terminal links
(477 -> 489). The new synthetic test reproduces the mutual veto
bit-exactly and fails on the previous engine.

Corpus, `97fa412` -> `029acac`, both runs by the corpus holder:
`shells_matched_forward` +3,892 (0.994274 -> 0.994671), unlinked
21,037 -> 19,134 (-9.0%), `terminals_matched` +2,383
(0.832129 -> 0.833354) with **every class gaining** -- `tank_hit`
+1,358, `explosion` +371, `pillbox_damage` +355, `shell_falls` +297,
`base_damage` +2 -- the first commit since `926f391` with no class
paying for another. The attribution ledger trades upward in kind:
unseen-source marks -126 and orbit-membership/stream birth claims -143
(with `shells_with_birth` +1,168), orphans that used to need a claim of
their own now absorbed into chains that already carry one.

Drawn axis: pop-outs 56,025 -> 52,133 -- exactly the -3,892 the match
gains predict, the same complementarity the die-at-impact section saw
-- pop-ins -1,357, forward-paired pops -643, hover links -169, seam
jumps 129 -> 119. The costs: `terminal_links_rushed` +1,674 (+2.4%,
the same proportion as the fixture -- a lead-admitted death draws
slightly fast from a late-stamped anchor, traded against a pop plus an
unexplained impact), rush links +190, and backwards pops 3,096 -> 3,116
(+20 on a metric whose absolute base shrank 7%; flat, but the one
number worth re-checking on the next run).

## Pill-stream lockstep -- `537cb6d`

Origin: a replay outside the corpus (b8f1763b-121001.2), where a
pillbox's two final shots at a fleeing tank -- same fine direction,
bradian 163, two orbit steps apart -- drew the later shot overtaking
the earlier one mid-air and falling six ticks before it. Two live
shells from one pill on one bradian advance in lockstep, so that is
impossible; the invariant is the corpus holder's: same sender, both
from a pillbox, both ending in shell falls -- birth order is fall
order. In the incident, one record pair arrived 5 receiver-ticks apart
carrying 8 sender-ticks of flight; the leader's short hop into the
trailer's true position then cost 2.19 against 6.28 for its own
continuation -- a margin the matcher treats as decisive -- the
trailer's true hop fell to the 8px error cutoff, and the stitch pass
completed the identity swap. Every later restatement and both falls
were then attributed crosswise.

The fix is a pruning pass in the pairwise matcher
(`enforce_pillbox_lockstep_candidates`, in the constraint-refinement
loop): within one snapshot, the same-stream shells narrowed to the same
single bradian must advance by one common step count, and candidates no
jointly consistent story supports are pruned. When no common advance
exists (a fall mid-interval, a dropped restatement) the pass stands
down, so it vetoes physically impossible crossings and never invents a
link; terminals are exempt, dying being how a shell leaves the
lockstep. Enforcement has to sit in the matcher: by the time two falls
read out of order the chains have already traded tails mid-air, and
reassigning fall records cannot uncross the drawn paths.

Fixture: matched forward 0.995634 -> 0.995675, unlinked
0.002142 -> 0.002102, steady drawn links 0.977891 -> 0.978499,
pop-outs 322 -> 319, hovers 4 -> 3, terminals unchanged. Two frozen
census pins move with it (three fewer unfated ends; two
stream-provenance birth claims no longer needed, their chains now
staying connected). The synthetic test reduced from the incident locks
both the no-crossing assignment and the fall order, and fails on the
previous engine with exactly the observed swap.

Corpus, `029acac` -> `537cb6d`, run by the corpus holder (the same
`files_failed 1` condition as the previous two rows; every per-corpus
total byte-identical). The `029acac` raw report is not in the tree, so
deltas marked ~ are derived from its published rates; the rest are
exact against recorded absolutes.

* `shells_matched_forward` ~+1,493 (0.994671 -> 0.994823) and
  `shells_unlinked` 19,134 -> 18,792 (-1.8%): both shell-side records
  move again.
* `pop_outs` 52,133 -> 50,638 (-1,495) -- once more almost exactly the
  complement of the forward-match gain.
* `seam_jumps` 119 -> 53 and `seam_jump_max` 3.16 -> 2.83 -- the
  largest proportional movement on the drawn axis, and more than the
  incident class alone would predict. Plausibly real: a crossed pair
  hands two chains through one another's restatements, which is
  exactly the handoff mismatch the seam metric exists to catch. Worth
  re-confirming next run before crediting it fully.
* The cost: `terminals_matched` ~-174 (0.833354 -> 0.833265), giving
  back about seven percent of the subsumed-joins commit's +2,383.
  `tank_hit` -92 (236,059 -> 235,967) is the only class the recorded
  history can pin; the remaining ~-82 cannot be decomposed without the
  prior run's class lines. (Note for future runs: keep the raw
  reports.)
* `pops_paired_backwards` 3,116 -> 3,134 (+18): a third consecutive
  small creep on a base that keeps shrinking; still the number to
  watch.

Two readings of the terminal cost, not separable from rates alone. A
crossed chain can reach a terminal the true chain cannot be *proven*
to reach, so part of the -174 is false credit leaving the ledger --
the rate counts explanations, not correct ones. Or the common-advance
intersection can over-prune when one member's true candidate is
missing from the table (the same 8px cutoff that started this),
stranding a chain short of its fall. The ordinal fall-order check
discussed alongside the change -- pill-fire stream order against
fall-record stream order within one sender, no timestamps anywhere --
would separate the two: inversions surviving the veto point at the
second reading, a clean census with fewer explanations points at the
first. It is the natural next measurement.

## Late-head slide -- `3956580`

Origin: the lockstep incident's replay again (b8f1763b-121001.2), same
pillbox, the stream's *first* shot this time: the record carrying its
fire and first restatement arrived ~20 ticks late (a 23-tick stamp gap
against ~3 ticks of content movement), the next record arrived on
time, and the 6-tick stamp window between them then had to carry 11
orbit steps of real flight. The chain itself was correct -- the
residual resolver forced the end onto its tank hit through the lead
allowance and absorbed the middle restatement on the way -- but a
chain head is a time anchor the smoothing pass never moves, so the
first link drew at 7.4 px/tick against the physical 2.

The fix is a drawing-only pass after smoothing
(`slide_compressed_chain_heads`): a head link's drawn length is itself
the sender's clock, so when it exceeds the stamp window by more than
the one-sided quantisation bound explains (8 px), the head's drawn
position slides forward along the link to where the shell truly was at
its stamped time, leaving exactly the window's worth of flight. The
birth-segment builder re-derives its span from the slid position
(pillbox and tank branches both), so the muzzle-to-head flight hands
off seamlessly at true speed -- in the incident the birth now leaves
the muzzle at about the true fire time and the link draws at exactly
2 px/tick.

Fixture (the incident replay): `link_speed:3.0+` 1 -> 0 and
`rush_links` 1 -> 0, both into the steady bucket; the rates report is
byte-identical, hash included. Three new checks pin the slide, the
birth handoff and the punctual-head no-op. The synthetic reduction
links through the resolver's dilated join at 6 orbit steps -- the
incident's own 11 exceeds `DILATED_CATCHUP_PIXELS` and needed the
terminal forcing, which the fixture idiom does not reach.

Corpus, `537cb6d` -> `3956580`, run by the corpus holder:

* Matching axis: every result line byte-identical, as designed -- the
  pass writes drawn positions only.
* 956 links slide into the steady bucket, and the histogram shows
  nothing else: `3.0+` 4,206 -> 3,767 (-439, -10.4%), `2.5-3.0`
  15,105 -> 14,671 (-434), `2.2-2.5` 97,220 -> 97,137 (-83),
  `1.8-2.2` +956 exactly; every slower bucket byte-identical, the
  pass being unable to move a head anywhere but forward.
  `rush_links` 4,149 -> 3,710 (-10.6%), `rate_links_steady`
  0.964431 -> 0.964548.
* Six pop pairs reclassify backwards -> forward:
  `pops_paired_backwards` 3,134 -> 3,128 with `pops_paired_forward`
  +6 -- a slid head can only move a reappearance forward along its
  track. The first move down after three consecutive creeps
  (3,096 -> 3,116 -> 3,134); the watch stands, but the direction is
  finally right.
* Untouched, as predicted: hovers 3,894, pop-outs 50,638, pop-ins
  40,927, `terminal_links_rushed` 71,552 (terminal links are outside
  the pass's scope; still the largest fast-drawing class by far), and
  seams 53 with max 2.83 -- which also re-confirms the lockstep row's
  119 -> 53 halving that its section asked to see again before
  crediting.
* The residue at `3.0+` (3,767) is mid-chain compression -- a late
  record *inside* a chain, where whole-chain smoothing's 24 px
  deviation guard stands down -- plus head links under the 8 px
  threshold. Mid-chain wants piecewise re-timing rather than the
  single-line whole-chain model; the rushed-terminal class, nineteen
  times larger, is the axis's real headroom.
* Bookkeeping: `files 443, files_failed 0`. Both tools count `files`
  on successful parse only, so the earlier rows' 443/1 was 444
  enumerated files; the `.py` skip-list entry (`e5ec295`) retires the
  unparseable one at enumeration and the same 443 parsed logs remain
  (every per-corpus total byte-identical to the pinned corpus). The
  hash-relevant pair settles at 443/0 from here on.

## Dilated same-orbit continuations -- `e2bbbfb`

Origin: a replay outside the corpus (97a7dfa2-022603.5), where a
pillbox's two westward stream-mates drew as three shells -- the
watcher's report was literally "the viewer shows three shots where the
raw dots show two". The sender's shell list arrived one hop stale, both
shells jumped seven orbit steps across a five-update stamp window while
keeping their exact three-step separation, and the trailer's true hop
(28.018px against an expected 20) missed the 8px cost gate by 0.018px.
With the trailer candidate-less, the lockstep pass had one constrained
member and stood down; the leader took the trailer's statement by a
3.105 margin -- the identity swap again, this time surviving `537cb6d`'s
own defence because the defence never saw the candidate it needed. The
severed halves then drew as the full artifact set: the trailer frozen
mid-air for ten ticks, and its continuation minted as an unseen shot
with a 36-tick synthetic birth flight, a phantom third shell predating
the real shell's own fire time.

The fix admits the missing candidate instead of widening the gate: when
no on-schedule orbit step explains a same-stream hop, steps inside the
dilated update window survive as penalized candidates (the
widen-in-time-only principle `pill_states_reachable` already uses).
Dilated costs measure the clock's lie, not likelihood, so such a
candidate never competes on margins -- it reaches selection only as the
lone remaining story on both of its sides, after the lockstep and
constraint passes have pruned. Dilated stories neither propagate stream
provenance nor enter stitching; a synthetic test pins each refusal (an
earlier attempt at off-clock pairwise continuations was abandoned for
exactly those two poisons, per the subsumed-joins section). Fixture:
matched forward 0.995675 -> 0.995932, pop-outs 319 -> 300, four unseen
birth claims withdrawn, four visual joins upgraded to identity links.

Corpus, `3956580` -> `e2bbbfb`, run by the corpus holder (443/0 both,
every per-corpus total byte-identical; raw runs kept in
`docs/corpus_runs/`, as the lockstep section's note asked):

* `shells_matched_forward` ~+5,087 (0.994823 -> 0.995341) and
  `shells_unlinked` 18,792 -> 15,722 (-16.3%): both shell-side records
  move, the largest single-commit gain since `a74033a`.
* `pop_outs` 50,638 -> 45,552 (-10.0%) -- once more the complement of
  the forward-match gain -- with `pop_ins` 40,927 -> 37,409,
  `pops_paired_forward` ~5,096 -> 4,666, and `pops_paired_backwards`
  3,128 -> 2,924: the number three sections told us to watch finally
  moves down by more than noise (-6.5%).
* The terminal cost: `terminals_matched` ~-160 (0.833265 -> 0.833183),
  `tank_hit` 235,967 -> 235,739 (-228) with the other classes net +68.
  Same two readings as the lockstep row's -174: false credit leaving
  the ledger as crossed chains uncross, or over-strict refusal
  stranding ends short of their fates. The ordinal fall-order
  instrument that section proposed would separate them and is still
  unbuilt.
* The drawn-speed cost, the real price: the dilated links draw the
  clock's lie locally. `rush_links` 3,710 -> 5,536 (+49%), `3.0+`
  3,767 -> 5,590, `2.5-3.0` 14,671 -> 17,905, `2.2-2.5`
  97,137 -> 102,911, `hover_links` 3,894 -> 4,158, and
  `rate_links_steady` 0.964548 -> 0.961900: roughly 16,500 links
  (~0.2% of 8.1M) leave the steady bucket, about three links redrawn
  off-schedule per pop pair removed. Whole-chain smoothing's 24px
  deviation guard stands down across these hops for the same reason it
  does on mid-chain compression; the late-head slide section already
  named piecewise re-timing as the dial for that class, and these
  links are its newest members.
* `seam_jumps` 53 -> 81 with `seam_jump_max` 2.83 -> 4.24 -- the one
  metric moving the wrong way on a shrinking base. Not reproduced by
  the fixture or the origin replay (both unchanged); wanted a
  `find-hover-links`-style look with `find-seam-jumps.cjs` before the
  next engine commit. Since taken: root-caused as a latent
  stale-endpoint class this commit merely re-rolled, and closed at
  `c890ecc` -- see the seam closure section.
* Recorded for the next run, no recent baseline to compare:
  `shells_unseen_pillbox_birth` 12,890, `shells_stream_birth` 1,039,
  `shells_visual_joins` 3,235, `terminals_unseen_pillbox_source`
  167,939, `terminals_unseen_tank_source` 78,903,
  `terminal_links_rushed` 72,139 (71,552 at `3956580`, +587).

The trade in one line: about five thousand vanish-and-reappear
artifacts -- the class the eye actually catches, backwards pops
included -- bought with a smaller, subtler class of locally mis-paced
links plus 28 seam pixels' worth of handoff error, and 160 terminals
of ledger. The drawn-speed residue is real headroom for a
smoothing-side pass, not a reason to hold the matcher's gains.

## Seam closure -- `c890ecc`

The seam creep got its look. `find-seam-jumps.cjs` over the corpus put
the new worst case (4.24px) in 110702.1: a dense pill volley leaves an
orphan restatement whose only claim is a draw-only visual join, and
`apply_visual_join` stores the successor's quantised packet coordinate
as the link endpoint while the successor draws at its orbit-recovered
exact pixel, (3, 3) away. The class is latent, not new: every pass
that stores a link endpoint at creation time (a stitch's exact pixel
included) goes stale when a later pass refines where the successor
draws, which is the whole pre-existing 53; the dilated-continuations
commit merely re-rolled which pairs get visual-joined, and one landed
on an uncertainty-3 chained member instead of an exact head. At the
baseline the same replay's join happened to pick a packet==orbit
orphan -- zero seams there was luck, not correctness.

The fix closes the class rather than the instance: a drawing-only
reconciliation pass after smoothing aims every unsmoothed non-terminal
link at its successor's final draw source (smoothed links already aim
at the successor's smoothed position by construction), running before
head sliding so the slide measures its sprint from the corrected
endpoint. The reduced synthetic -- a visual join onto a chained member
quantised a pixel short -- fails on the previous engine with exactly
the packet-pixel endpoint.

Fixture and the dilated-continuations origin replay: byte-identical,
hashes included (both had no seams to close). The incident replay's
audit moves only its seam lines, 1 -> 0. Corpus prediction for the
next run: the matching axis byte-identical, `seam_jumps` 81 -> 0 and
`seam_jump_max` to 0.00 -- the pre-existing 53 close along with the 28
-- with at most a few links changing speed bucket where an endpoint
moved by a pixel or two.

Corpus verification, run by the corpus holder at `a4b0090`
(engine-identical to `c890ecc`; the two commits between are docs):
exactly as predicted, on every axis. `find-seam-jumps.cjs` reports
`seam_jumps 0` across all 443 files; the audit's `seam_jumps` 81 -> 0
with `seam_jump_max` 0.00; the rates report is byte-identical to the
`e2bbbfb` run apart from its commit stamp, `content_hash` included.
The speed histogram wobble is two links total -- one 0.5-1.0 -> 0.0-0.5
and one 3.0+ -> 2.5-3.0 (`rush_links` -1 with it) -- and every other
audit line is unchanged. The class is closed, the pre-existing 53
included: handoff continuity is now guaranteed by construction rather
than by every endpoint-writing pass staying in sync, and the audit's
seam metric finally sits at the zero its header always said it should.
Raw audit kept as `docs/corpus_runs/c890ecc-audit.txt`; the report
would duplicate the `e2bbbfb` one byte for byte, so it is not.

## Findings

* **The fixture's headline conclusions all survive the scale-up.** The branch
  line leads the branch point on every headline metric (0.975030 against
  0.961727, 0.008829 against 0.013738, 0.816566 against 0.791346); it was
  behind from `ad6a3b6` to `c848efd`; every record was held by `926f391` when
  the ten-run table closed (the branch line has since carried them further,
  per the table); and
  the pillbox-attribution regression and its repair are both there at full
  size. None of this was an artefact of one hand-picked replay.
* **The two confirmation-run claims reproduce exactly.** `e4582dc` differs from
  `76d8b8a` in one line, and `c848efd` is identical to `5e69318` in every line,
  across 443 logs. Those were the weakest claims in the fixture file -- a
  single replay can easily fail to exercise a difference -- and they now have
  113 times the evidence behind them.
* **`5f9d86f` goes the other way on the corpus.** On the fixture it lost two
  more terminals, continuing `83cb132`'s slide and leaving `4f5dbe9` holding
  the terminal record. On the corpus it *recovers* 61 terminals, and the class
  breakdown flips with it: `shell_falls`, `explosion` and `tank_hit` all gain
  where the fixture had them flat or losing. The fixture's "at the cost of two
  more matched terminals" does not generalise -- the one-sided bound is
  very slightly terminal-positive over 443 logs. It still ends below `4f5dbe9`
  on the terminal rate, by 39 terminals, so which commit holds the record at
  that point is unaffected.
* **`926f391` has no regression at corpus scale.** On the fixture it lost two
  `explosion` terminals, the sole blemish on the commit. Over 443 logs
  `explosion` gains 231 and every other class gains too. That two-terminal loss
  was noise in a single replay, and the commit's claim to be the first to gain
  on both axes at once is stronger than the fixture could show.
* **The `shells_with_birth` loose end resolves in the same direction, larger.**
  `shells_with_birth` rises 3,874 while `shells_from_tank` falls 66 at
  `926f391` -- the same counter-intuitive pairing the fixture file flagged for
  a look, at sixty times the magnitude, so it is not a small-sample effect. The
  question is unchanged and still worth answering in `build_shell_births`: an
  origin becoming uncertain does not cost a shell its birth, and apparently
  helps others find one.
* **One shell in the corpus has an origin and no birth, at v1.0.8 only.** The
  identity `shells_from_tank + shells_from_pillbox = shell_births` holds
  exactly at `5f9d86f` and `926f391` but is one short at `e4582dc`
  (1,611,363 against 1,611,362). It is a single observation in 9.8 million, and
  it is absent from the later states that carry the same `f4f15d9` birth code
  plus the branch work -- so the likeliest reading is a shell whose pillbox
  source is known but whose start point `f4f15d9` alone could not derive, since
  fixed by the branch. Worth one look at `build_shell_births`, not worth alarm.
* **`terminals_unseen_pillbox_source` does not return exactly to baseline.**
  The fixture shows 393 -> 424 -> 393, a clean round trip at `4f5dbe9`. The
  corpus shows 37,124 -> 39,222 -> 37,360: the repair recovers most of the
  regression but leaves 236 terminals more than the branch point had, and the
  figure then stays flat at 37,360/37,361 through `926f391`. The fixture's
  "back to the branch point's value" was a small-sample coincidence.
* **The absolute rates are lower than the fixture's throughout**, by 3-4 points
  on terminal matching and around half a point on forward matching. The sample
  replay is an easier log than the corpus average, which is what a hand-picked
  sample would be expected to be. Only the deltas between commits should be
  compared across the two files; the levels should not.
* **Tank and LGM position tracks are untouched by all ten commits**, now
  confirmed over 122.8M tank ticks and 112.3M LGM ticks rather than one
  replay's worth.
* **The regression's origin is still unpinned**, as in the fixture file:
  bracketed to `9bc584d` or `ad6a3b6`, both named "Stuff". The corpus makes the
  regression far better characterised but does not locate it, since `9bc584d`
  was not among the ten commits measured.
* **The measured line ends at the `90925b0` guard run**, unchanged on every
  matching metric through the claims-only `775fe4b` and `a78253b`. `main` has
  moved past it: the death-dump terrain commits (`72adf37`, `b805f2c`) touch
  `viewer/game.js`, which the report loads, so `main`'s own HEAD is unmeasured
  until the next run. (When this file first closed the current pair was
  `4572cff`/`926f391`, later `380e333`/`a74033a`. Since resolved: `main`'s
  HEAD was measured at `97fa412` and the line extended by the subsumed-joins
  branch at `029acac`, then the pill-stream lockstep branch at `537cb6d`,
  then the drawing-only late-head slide branch at `3956580` -- see the
  headline table and their sections.)

<!-- Remember to update the "headline table" at top! -->
