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

The corpus is the private set described in `FORMAT.md`'s Sources -- 446 logs
(2001-2005, all Bolo 0.99.7) less the three known to be corrupt, 443 -- read
recursively. It does not live in this repository and its
location is deliberately not recorded anywhere in the tree. The measurement
tools find it through `corpus.json` at the repo root, which is gitignored --
create it as `{"root": "/path/to/logs"}`, or set `BOLO_CORPUS` in the
environment. **An agent re-running this should ask the user where the corpus
is** rather than guessing, since `corpus.json` is absent from a fresh clone.
The three logs known to be hacked or broken are excluded.
Corpus logs are named after the players in them, and this repository
carries no player handles: wherever a tool prints a replay's name
(the `*_example` diagnostic lines, and so the archived runs) it is
reduced to its leading date digits plus six hex characters of the
basename's SHA-256 (`replay_label` in `tools/corpus.cjs`), which the
holder can match against the corpus by digesting each basename. The
committed fixtures' names are digits already and print verbatim.

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
`tools/report-interpolation-rates.cjs` still has exactly one commit, `86807e0`.
Runs were sequential, one process at a time.

Unlike the fixture file, no run here was taken from a live checkout: `main` has
moved on to the merge commit, so all ten used the worktree, which makes the
method uniform across the table rather than eight-of-ten.

**Rig validation.** Before the corpus runs, `3f359d1` was replayed through this
rig against the *fixture* and reproduced the published v1.0.7 row exactly --
`rate_shells_matched_forward` 0.929101, `rate_shells_unlinked` 0.029667,
`rate_terminals_matched` 0.771713, `terminals_matched:tank_hit` 2657,
`shells_from_pillbox` 11661, `shells_with_pillbox_source` 41226,
`shells_with_birth` 9021, `terminals_unseen_pillbox_source` 0,
`max_shell_interpolation_ticks` absent. The rig is therefore known to reproduce
the older file before any new number below is trusted.

**These numbers are current** as of `c39c321`: the two claims-only commits
after the `8d310e3` guard run (`dc3bd3b`, `c39c321`) leave every matching
metric byte-identical, so the guard run remains the measured state of record.
The last row is no longer `main`'s row, though: `main` has since gained the
death-dump terrain commits (`836aa38`, `4945872`), which touch
`viewer/game.js` -- a module the report loads -- and were unmeasured until
the `28fa3b0` run recorded in the headline table: `main`'s HEAD is now
measured, and the current measured state of record is the
fast-ring re-sends branch at `efe9ab2` (see its section), which
carries both shell-side records; `1de6e0d` keeps both terminal-side
ones; the `1ea546c` run adds the vouched-link columns with every
matching metric byte-identical, `3d6165a` -- doubtful voters abstain,
see its section -- then moves both shell-side records on, and
`4f02142` -- the symmetric election and orphan tie-break, see its
section -- moves them on again by the largest step since `efe9ab2`;
`1cb9502` reproduces it byte for byte; `b9db294` -- the sender's stale
tank box, see its section -- takes every record in the four matching
columns at once, at the price of 12,862 rushed terminal links; and
`0263483`, the same mechanism with the track keeping first refusal over
the whole walk, was the head for a while, a shade under `b9db294` on
every matching column with the rushed links back within 124 of
baseline; the line has since run on commit by commit (the table has
every step) to `ee502e9`, a tank hit tried against the statements
the sender held, the **current head**, holding every matching
record. (Earlier
revisions of this paragraph pinned the file at `ffb7fd3`/`e8f0415`, then at
`6b4140d`/`c1d6625`; later sections were measured from live checkouts of the
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
  `max_shell_interpolation_ticks` 50 from `86807e0` on, absent at `3f359d1`

## Headline table

| commit | | `matched` <!-- matched_forward --> | `unlinked` | `terminal` <!-- terminals_matched --> | `tank_hit` | `timed` <!-- terminal_links_rushed_timed --> | `backward` <!-- pops_paired_backwards --> | `contra` <!-- links_pill_contradicted --> |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `3f359d1` | v1.0.7 | 0.948521 | 0.018737 | 0.761484 | 201,999 |  |  |  |
| `86807e0` | branch point | 0.961727 | 0.013738 | 0.791346 | 211,623 |  |  |  |
| `c15ed26` | v1.0.8 | 0.961727 | 0.013738 | 0.791346 | 211,623 |  |  |  |
| `15770f0` | "Stuff" | 0.934635 | 0.032850 | 0.776327 | 197,958 |  |  |  |
| `37acbc7` | tolerance | 0.935831 | 0.032708 | 0.782268 | 209,485 |  |  |  |
| `8aa9506` | "Stuff" | 0.935831 | 0.032708 | 0.782268 | 209,485 |  |  |  |
| `63b2e71` | bad assumption | 0.967669 | 0.011431 | 0.813086 | 227,331 |  |  |  |
| `d52f860` | quantized shots | 0.972767 | 0.009576 | 0.813034 | 227,201 |  |  |  |
| `07b6bd9` | one-sided | 0.973966 | 0.009100 | 0.813066 | 227,223 |  |  |  |
| `ffb7fd3` | index 1+ | 0.975030 | 0.008829 | 0.816566 | 227,585 |  |  |  |
| `ecd220c` | bradian + stitching | 0.984399 | 0.005985 | 0.816888 | 228,016 |  |  |  |
| `fb06764` | forced assign + jitter | 0.988925 | 0.004020 | 0.827713 | 233,180 |  |  |  |
| `963f191` | temporal gate | 0.988826† | 0.004112† | 0.827709 | 233,180†† |  |  |  |
| `6b4140d` | cost-forcing + pop rescue, v1.0.9 | 0.993609 | 0.002202 | 0.828353 | 232,342 | 21,286 | 5,588 |  |
| `6787773` | leading impacts | 0.993965 | 0.002019 | 0.829538 | 233,481 | 24,214 | 5,514 |  |
| `8d310e3` | absorption guards | 0.993725 | 0.002190 | 0.829357 | 233,450 | 14,077 | 5,792 |  |
| `28fa3b0` | main, death dumps in | 0.994274 | 0.002143 | 0.832129 | 234,701 | 14,323 | 3,096 |  |
| `1de6e0d` | subsumed joins | 0.994671 | 0.001949 | 0.833354 | 236,059 | 16,056 | 3,116 |  |
| `d8da3c9` | pill-stream lockstep | 0.994823 | 0.001914 | 0.833265 | 235,967 | 16,103 | 3,134 |  |
| `8a513da` | late-head slide | 0.994823 | 0.001914 | 0.833265 | 235,967 | 16,103 | 3,128 |  |
| `fb6bd7c` | dilated continuations | 0.995341 | 0.001601 | 0.833183 | 235,739 | 16,205 | 2,924 |  |
| `3a7c1a5` | seam closure | 0.995341 | 0.001601 | 0.833183 | 235,739 | 16,205 | 2,924 |  |
| `20db569` | tail slide | 0.995341 | 0.001601 | 0.833183 | 235,739 | **12,544** | 2,924 |  |
| `06303dc` | guard split | 0.995341 | 0.001601 | 0.833183 | 235,739 | 12,544 | 2,925 |  |
| `11c9a94` | pill-wide lockstep | 0.995415 | 0.001547 | 0.833156 | 235,715 | 12,554 | 2,900 |  |
| `99d402a` | residual lockstep veto | 0.995308 | 0.001558 | 0.833192 | 235,747 | 12,554 | 2,922 |  |
| `aab319e` | pairwise roster lockstep | 0.995494 | 0.001520 | 0.833249 | 235,846 | 12,578 | 2,876 |  |
| `efe9ab2` | fast-ring re-sends | 0.996647 | 0.001446 | 0.833054 | 235,759 | 12,974 | 1,382 | 423‡ |
| `3d6165a` | doubtful voters abstain | 0.996657 | 0.001443 | 0.833123 | 235,835 | 12,979 | 1,407 | 437 |
| `4f02142` | symmetric elect, orphan tie-break | 0.996726 | 0.001419 | 0.833131 | 235,847 | 12,981 | 1,366 | 89 |
| `1cb9502` | two quadratic scans removed | 0.996726 | 0.001419 | 0.833131 | 235,847 | 12,981 | 1,366 | 89 |
| `b9db294` | stale tank box, either box per step | 0.996914 | 0.001379 | 0.834069 | 237,709 | 82,149 | 1,356 | 92 |
| `0263483` | stale tank box, track first refusal | 0.996882 | 0.001384 | 0.833914 | 237,399 | 13,108 | 1,360 | 94 |
| `bc1c9b7` | tank births follow the gap | 0.996964 | 0.001324 | 0.834427 | 237,436 | 13,116 | 1,228 | 94 |
| `1a67872` | pill births follow the gap | 0.997117 | 0.001201 | 0.835183 | 237,788 | 13,132 | **1,169** | 92 |
| `f9d3e7c` | dilated joins bounded by the measured lie | 0.997095 | 0.001222 | 0.835199 | 237,799 | 13,130 | 1,236 | 92 |
| `6b2cacd` | orbit states below a stitch | 0.997095 | 0.001222 | 0.835202 | 237,804 | 13,154 | 1,236 | 140 |
| `fe3f825` | the contradiction sweep | 0.997101 | 0.001218 | 0.835250 | 237,818 | 13,163 | 1,230 | **14** |
| `223c457` | a base is damaged only by tank shells | 0.997103 | 0.001217 | 0.835260 | 237,875 | 13,163 | 1,230 | **14** |
| `1623cbb` | a turning tank's shell carries the nibble's sector | **0.997166** | **0.001176** | **0.835572** | **238,130** | 13,188 | 1,224 | **14** |
| `30ea4ef` | a dilated candidate outlives the on-schedule consensus | **0.997171** | **0.001175** | **0.835573** | 238,128 | 13,188 | 1,224 | **14** |
| `ee2f432` | distance order scored (no engine change) | 0.997171 | 0.001175 | 0.835573 | 238,128 | 13,188§ | 1,224§ | **14** |
| `c09e9e3` | a stall subtracted from the link (one reading) | **0.997469** | **0.001026** | **0.836053** | **238,407** | 13,248 | **737** | **12** |
| `fb4bd12` | a stalled pair carries two readings | **0.997594** | **0.000989** | **0.836892** | **238,598** | 13,206 | 856 | 14 |
| `40e92f6` | the pair after a stall carries two readings as well (two extremes) | 0.997702 | 0.000930 | 0.837348 | 238,808 | 13,211 | 864 | 14 |
| `92043d9` | all four readings around a double stall | **0.997710** | **0.000925** | **0.837378** | 238,807 | 13,212 | **854** | 14 |
| `800f57c` | a delayed chain head slides before smoothing (drawing only) | **0.997710** | **0.000925** | **0.837378** | 238,807 | 13,212 | **854** | 14 |
| `ee502e9` | a tank hit tried against the statements the sender held | **0.998058** | **0.000810** | **0.839149** | **242,287** | 13,237 | **832** | 14 |
| `e46dd5e` | a tank's shells advance in lockstep | **0.998081** | **0.000801** | 0.839074 | 242,286 | 13,226 | **783** | 14 |
| `364174f` | a shell that may have died abstains from the tank lockstep (engine `7290254`) | 0.998076 | 0.000804 | **0.839166** | **242,293** | 13,230 | 801 | 14 |

The three right-hand columns are lower-is-better counts from the drawn
audit and the vouched-link score, added so that a drawing-only commit
(or one that trades a headline figure for a drawn one) has somewhere
in this table to show its gain. `terminal_links_rushed_timed` counts
terminal links drawn faster than 3 px/tick over a positive duration:
an event record landed before the shell's physics arrival and capped
it. It is the timed part of the older `terminal_links_rushed` line the
sections quote, which also counts every zero-duration link as
infinitely fast; four-fifths of that line is shells last stated
already inside their terminal's box, a corpus constant near 55,000
that no engine moves (see the rush split section, whose runs measured
this column for every row from `6b4140d` on under the `f3b4142` tool).
`pops_paired_backwards` counts pop-ins paired to a pop-out behind
them, the artifact the eye reads as a shell moving backwards.
`links_pill_contradicted` counts pill links whose statement rosters
disagree with the assignment; it should stay near zero. Blank cells
are rows the metric did not exist for. ‡ measured on the `efe9ab2`
engine by the `1ea546c` measurement-only run. The claims-only commits
between `8d310e3` and `28fa3b0` (`dc3bd3b`, `c39c321`) have no row but
moved `pops_paired_backwards` 5,792 -> 3,908 -> 3,253, see their
sections; `f8ec4d5`, the uncapped falls, likewise took the undivided
rushed line 79,521 -> 69,351 before `8d310e3`, a fall the split shows
to be timed.

`bc1c9b7` -- the tank-birth window, see its section -- takes the three
shell-side records and the backwards-pop record at once, the first row
to move a headline record since `b9db294`, which keeps `tank_hit` (its
310 extra hits were the zero-length links `0263483` gave back).
`1a67872` -- the pill-birth window, see its section -- moves all four
on again and takes `tank_hit` too, at 2 px/tick this time; `20db569`
keeps timed rushes and `4f02142` contradictions. `f9d3e7c` -- the
dilated-join lie bound, see its section -- is a trade: it gives back a
sliver of the two shell-side records and 67 backwards pops for a fifth
of the corpus's hovers, and edges the two terminal-side records on.
`6b2cacd` -- orbit states below a stitch, see its section -- is
pinning-only: it repeats `f9d3e7c`'s shell-side row, edges the
terminal side by five, and moves the contradiction column 92 -> 140,
which is the vouched-link metric seeing 16,500 links it could not
score before rather than links changing. `fe3f825` -- the
contradiction sweep, see its section -- spends them: contradictions
140 -> 14, the column's record by a wide margin, with every other
column level or better; `1a67872` keeps the two shell-side records by
a hair, `20db569` timed rushes.

The rows below the guard run were measured later, from the corpus
holder's live checkouts: `28fa3b0` closes the unmeasured-`main` gap the
currency notes tracked (death-dump terrain and everything since the guard
run included), `1de6e0d` -- the subsumed-joins branch, see its section
-- takes all four headline records at once, and `d8da3c9` -- the
pill-stream lockstep branch, see its section -- moves the two shell-side
records on while returning ~174 terminals, so `1de6e0d` keeps both
terminal-side columns. `8a513da` -- the late-head slide branch, see its
section -- is drawing-only: its matching axis is byte-identical to
`d8da3c9`, so its row repeats that row and no records move; its gains
live on the drawn audit. `fb6bd7c` -- the dilated-continuations branch,
see its section -- moves both shell-side records on again while
returning ~160 terminals, so `1de6e0d` still keeps both terminal-side
columns. `3a7c1a5` -- the seam closure, see its section -- is
drawing-only like `8a513da`: its row repeats `fb6bd7c`'s and its gain
is the audit's seam pair going to 0 / 0.00. `20db569` -- the tail
slide, see its section -- is drawing-only too; its gain is the
rushed-terminal class. `06303dc` -- the smoothing guard split, see its
section -- likewise; its gain is the refused-chain crawl-and-sprint
class. `11c9a94` -- the pill-wide lockstep, see its section -- moves
both shell-side records on again for 51 terminals returned, so
`1de6e0d` still keeps both terminal-side columns. `efe9ab2` -- the
fast-ring re-sends branch, see its section -- moves both shell-side
records by the largest single step since the `ecd220c` era (+11,319
matched forward, `pop_outs` down by exactly the complement) for 381
terminals returned, 342 of which stay explained through
unseen-pillbox-source attributions; `1de6e0d` still keeps both
terminal-side columns. The `28fa3b0`..`d8da3c9` runs report
`files_failed 1` where the campaign runs report 0: one extra, unparseable
file now sits in the corpus tree and contributes nothing, and every
per-corpus total (shells, terminals by class, tank and LGM points and
ticks) is byte-identical to the pinned 443-log corpus, so the rows are
comparable. The `8a513da` run reports `files 443, files_failed 0`:
`files` counts successful parses only, so the earlier rows' 443/1 was
444 enumerated files, and the `.py` skip-list entry (`5d34ad8`) simply
retires the failure at enumeration, leaving the same 443 parsed logs.

Before those rows, `6787773` held all four headline records (the terminal one with a caveat --
the unmeasured intermediate state `dafa8d8` sat higher, see its section).
`8d310e3` deliberately gives part of each rate record back -- invented
explanations leaving the ledger, see its section -- and lands between
`6b4140d` and `6787773`; the claims-only commits after it (`dc3bd3b`,
`c39c321`) are byte-identical on every table column, so its row is where the
measured line currently stands. `3c5edf5` re-ran byte-identical to `6787773`
(see the uncapped-falls entry), a confirmation rather than a row of its own.
`963f191` trades a hair of each headline back for correctness the rate can't
see -- see its section below. v1.0.9 (`6254551`) is engine-identical to
`6b4140d` -- everything between them is docs, tooling, packaging and viewer
UI, and the one engine change in the span was cleanly reverted before the tag
-- so the `6b4140d` row is the released engine's row, and everything below it
is post-release.

## Tank and LGM tracks

Byte-identical at all ten commits, exactly as on the fixture -- nothing in this
range touches position interpolation. For the record:

* `rate_tank_segments_interpolated` 0.953363, `rate_tank_ticks_interpolated` 0.608462
* `rate_lgm_segments_interpolated` 0.981653, `rate_lgm_ticks_interpolated` 0.528934

The tick-weighted rates differ from the fixture's (0.687960 tank, 0.435824
LGM): tanks interpolate worse across the corpus than in the sample, LGMs
better. Neither is evidence about this range of commits.

## v1.0.7 -- `3f359d1` "rejoin / alliance issues"

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

## Branch point -- `main` at `86807e0`

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

## v1.0.8 -- `c15ed26` "aesthetic improvement"

The fixture file's claim that exactly one line moves between `86807e0` and
`c15ed26` **holds on the corpus**. The entire report diff is:

* `shell_births` 650,858 -> 1,611,362

Everything else is identical, including all four headline rates, every
`terminals_matched` class, `shells_with_pillbox_source` 5,262,988,
`shells_with_birth` 3,405,148 and `terminals_unseen_pillbox_source` 37,124.

One detail does *not* survive the scale-up. On the fixture the added births are
pillbox shells exactly: 9020 + 11661 = 20681. On the corpus the identity is one
short -- `shells_from_tank` 650,858 + `shells_from_pillbox` 960,505 = 1,611,363
against `shell_births` 1,611,362. So across 443 logs there is exactly one shell
with a known origin and no birth record. It is the only commit where the
identity fails: it is exact at `07b6bd9` (1,612,510) and at `ffb7fd3`
(1,612,444). See the findings.

## Branch -- `15770f0` "Stuff"

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

## Branch -- `37acbc7` "consider this tolerance rather than shell sprite size"

* `rate_shells_matched_forward` 0.935831
* `rate_shells_unlinked` 0.032708
* `rate_terminals_matched` 0.782268 -- up 0.6 points from `15770f0`
* `terminals_matched:tank_hit` 209,485 -- **up 11,527** from `15770f0`
* `shells_from_pillbox` 764,990 -- unchanged
* `shells_with_pillbox_source` 3,065,728 -- down 85, effectively unchanged
* `shells_with_birth` 3,401,045 -- unchanged
* `terminals_unseen_pillbox_source` 39,222 -- unchanged

Same shape as the fixture: one metric moves and the rest hold. The caveat
carries over unchanged -- this span is three commits (`09155b1`, `7bbb8cf`,
`37acbc7`), so +11,527 is the trio's combined effect, not the tolerance commit
measured alone.

## Branch -- `8aa9506` "Stuff"

A confirmation run. **Every metric is identical to `37acbc7`**, all the way
through the file, which reproduces the fixture result at corpus scale and
confirms that `8aa9506` and `39da396` are tooling-only.

## Branch -- `63b2e71` "Possible fix to a bad assumption", `using_the_pillbox_data` checkpoint

The repair, and the largest single movement in the file.

* `rate_shells_matched_forward` 0.967669 -- up 3.2 points from `37acbc7`, and
  0.6 points above the branch point
* `rate_shells_unlinked` 0.011431 -- down from 0.032708, below the branch
  point's 0.013738
* `rate_terminals_matched` 0.813086 -- up 3.1 points from `37acbc7`, 2.2 above
  the branch point
* `terminals_matched:tank_hit` 227,331 -- up 17,846 from `37acbc7`, and 15,708
  above the branch point
* `shells_from_pillbox` 961,641 -- recovered from 764,990, and 1,136 above the
  branch point's 960,505
* `shells_with_pillbox_source` 5,833,694 -- recovered from 3,065,728, and
  570,706 above the branch point's 5,262,988
* `shells_with_birth` 3,406,344 -- up 5,299, and 1,196 above the branch point
* `shells_from_tank` 650,874
* `terminals_unseen_pillbox_source` 37,360
* `shell_births` 650,874 -- tank only; the branch lacks `6a83ce0`, so this is
  not comparable with v1.0.8
* `max_shell_interpolation_ticks` 50

The terminal breakdown moves the same way in every class:
`explosion` 146,757 -> 158,534, `pillbox_damage` 501,560 -> 525,809,
`shell_falls` 605,355 -> 611,487, `base_damage` 59,480 -> 59,461. On the corpus
`base_damage` is again the one class that goes backwards, by 19 -- the fixture
showed the same single-class regression, there by one terminal.

`63b2e71` is the only commit in this span touching `viewer/motion.js`, so the
whole gain is its own.

## Branch of the branch -- `d52f860` "Try to determine true location from quantized pillbox shots", `using_the_pillbox_data_antifuzz` checkpoint

The characteristic trade reproduces: shell matching up, terminal matching down
by a hair.

* `rate_shells_matched_forward` 0.972767 -- up 0.51 points from `63b2e71`
* `rate_shells_unlinked` 0.009576 -- down from 0.011431, the first corpus figure
  below 1%
* `rate_terminals_matched` 0.813034 -- **down** 0.000052 from `63b2e71`, i.e.
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

## Branch after merging main -- `07b6bd9` "errors are one-sided"

* `rate_shells_matched_forward` 0.973966 -- up from 0.972767, a new best
* `shells_matched_forward` 9,561,777 -- up 11,777
* `rate_shells_unlinked` 0.009100 -- down from 0.009576, a new best
* `shells_unlinked` 89,340 -- down 4,669
* `rate_terminals_matched` 0.813066 -- **up** 0.000032 from `d52f860`, i.e. 61
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

## Branch -- `ffb7fd3` "Tank shots in index 1+ have uncertainty too", `using_the_pillbox_data_antifuzz` HEAD

Holds all three headline records, and on the corpus it is cleaner than on the
fixture: it gains in **all five** terminal classes with no regression at all.

* `rate_shells_matched_forward` 0.975030 -- a new best
* `rate_shells_unlinked` 0.008829 -- a new best
* `rate_terminals_matched` 0.816566 -- up 0.003500 from `07b6bd9`, and 0.003480
  above `63b2e71`'s 0.813086, taking a record that had stood since it was set
* `shells_matched_forward` 9,572,222 -- up 10,445
* `shells_matched_to_snapshot` 7,982,827 -- up 3,633
* `shells_matched_to_terminal` 1,589,395 -- up 6,812
* `shells_unmatched_forward` 245,139 -- down 10,445
* `shells_unlinked` 86,675 -- down 2,665
* `max_shell_interpolation_ticks` 50

The terminal breakdown, all five up:

* `terminals_matched:pillbox_damage` 530,577 -- up 4,797
* `terminals_matched:shell_falls` 612,666 -- up 1,085
* `terminals_matched:tank_hit` 227,585 -- up 362, and 254 above `63b2e71`
* `terminals_matched:base_damage` 59,800 -- up 337
* `terminals_matched:explosion` 158,767 -- up 231

Attribution and births:

* `shells_from_tank` 650,808 -- down 66
* `shell_births` 1,612,444 -- down 66, the same shells:
  650,808 + 961,636 = 1,612,444
* `shells_with_birth` 3,410,213 -- up 3,874
* `shells_from_pillbox` 961,636 and `terminals_unseen_pillbox_source` 37,361 --
  unchanged; `shells_with_pillbox_source` 5,811,709 -- up 37

## Branch -- bradian tracking and chain stitching, `ecd220c`

The tank-shell bradian work (`20e863d`, see `docs/tank_shell_bradians.md`)
plus the fragment-stitching pass (`ecd220c`), run against the same corpus
from a live checkout of the branch. The measuring tool has gained one
commit since the ten-run table -- `2680d76` added the tank-facing track
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
  links that remained unmatched at `ffb7fd3`
* `rate_shells_unlinked` 0.005985 -- down from 0.008829;
  `shells_unlinked` 58,756, down 27,919, a 32% reduction
* `rate_terminals_matched` 0.816888 -- up 0.000322; 627 terminals
* `shells_matched_to_snapshot` 8,074,178 -- up 91,351 (the stitching);
  `shells_matched_to_terminal` 1,590,022 -- up 627

The terminal breakdown gains in **all five classes** -- on the fixture
`ecd220c`'s span still showed a one-terminal `shell_falls` loss, which
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

## Branch -- forced assignment and jitter absorption, `fb06764`

The forced-assignment residual resolver (`bb6f769`) plus jitter
absorption and constant-velocity drawing (`fb06764`), measured together
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
  have an explanation, against 83.6% at the `ffb7fd3` baseline; the
  truly unexplained residue is 180,909 (9.3%)
* Every terminal class gains: `tank_hit` +5,164 (86.5% matched),
  `pillbox_damage` +7,447, `shell_falls` +4,586, `explosion` +2,739,
  `base_damage` +1,135
* Origins spread: `shells_with_birth` +11,500,
  `shells_with_pillbox_source` +19,905, `shells_from_pillbox` +2,360,
  `shells_from_tank` +1,422; `shell_births` 1,612,506 -> 1,616,288

Cumulative for the branch against the `ffb7fd3` baseline: unmatched
forward shells 245,139 -> 108,728 and unlinked 86,675 -> 39,462, both
better than halved; forward matching 0.975030 -> 0.988925; terminals
0.816566 -> 0.827713 with all five classes up.

## Branch -- absorption temporal gate, `963f191`

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

## Drawn-motion audit -- corpus baseline at `dafa8d8`

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

## Branch -- cost-forced assignment and pop rescue, `dafa8d8` + `6b4140d`

One corpus report covering the two engine commits since `963f191`:
cost-forced residual assignment (`dafa8d8`, accept an edge when every
rival costs more than the three-pixel margin) and the pop rescue
(`6b4140d`, dilated joins for clock-dilated fragments plus draw-only
visual joins for same-ray ambiguity). No corpus report was run at
`dafa8d8` alone, but the drawn-motion audit was, and its
`terminal_links` figure lets the terminal movement be decomposed.
Deltas against `963f191`:

* `rate_shells_matched_forward` 0.993609 -- up from 0.988826, about
  +47,000 shells, a new record; `shells_unmatched_forward` 62,747
* `rate_shells_unlinked` 0.002202 -- down from 0.004112;
  `shells_unlinked` 21,615, down from 40,367, nearly halved again, a new
  record
* `rate_terminals_matched` 0.828353 -- up from 0.827709, +1,255 net, the
  best *recorded* figure. Decomposed via the `dafa8d8` audit's
  `terminal_links` 1,618,107: cost-forcing gained about +7,024 terminals
  (the fixture predicted +35 -- another two-hundred-fold corpus
  amplification of a residue concentrated in laggy games), then the pop
  rescue gave back 5,769 (fixture -45) as continue-vs-die
  reassignments. The unmeasured `dafa8d8` peak, about 0.831256, was
  higher than where we now stand.
* `terminals_matched:tank_hit` 232,342 -- down 838 from the `fb06764`
  record; the give-back concentrates here, previously inferred tank-hit
  deaths reassigned to rescued continuations
* `shells_visual_joins` 5,240 -- about 12 draw-only links per game
* `terminals_unseen_pillbox_source` 120,074 and
  `terminals_unseen_tank_source` 64,215 -- up from 96,171 and 58,264.
  Counting unseen attributions, 1,796,627 of 1,946,439 impacts now have
  an explanation, 92.3% against 90.7% at `fb06764`; the truly
  unexplained residue is 149,812 (7.7%)
* Birth identity exact: 652,247 + 964,248 = 1,616,495 = `shell_births`,
  up 195; `shells_from_tank` down 49, `shells_from_pillbox` up 244
* Non-shell tracks and corpus constants reproduce (122.8M tank ticks,
  112.3M LGM ticks, byte-identical rates)

## Drawn-motion audit at `6b4140d`

The rescue was built against this tool's baseline; here is its own
verdict, against `dafa8d8`:

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
whatever was then being attributed to cross-client migration -- an idea
since regarded as highly suspicious, since nothing in Bolo could hand an
in-flight shell to another machine; such scenes draw as pops by design.

## Leading impacts -- `6787773`

Residual end-to-fate edges may now *lead* the receiver-clock arrival
estimate, bounded by the gap back to the sender's previous record (see
the fixture file's entry for the mechanism and the motivating replay).
The fixture predicted +34 shells matched forward and +24 terminals; the
corpus delivers roughly 100x both, the by-now-familiar amplification of
a residue concentrated in laggy games -- and this change is specifically
about lag. Deltas against `6b4140d`:

* `rate_shells_matched_forward` 0.993965 -- up from 0.993609, +3,501
  shells, a new record; `shells_unmatched_forward` 59,246
* `rate_shells_unlinked` 0.002019 -- down from 0.002202;
  `shells_unlinked` 19,823, down from 21,615, a new record
* `rate_terminals_matched` 0.829538 -- up from 0.828353, +2,307
  terminals, the best recorded figure (the unmeasured `dafa8d8` peak
  still stands, on an engine with 44k forward-paired pops)
* `terminals_matched:tank_hit` 233,481 -- up 1,139, recovering the pop
  rescue's 838 give-back and passing `fb06764`'s 233,180 record by 301.
  The continue-vs-die reassignments that cost tank hits at `6b4140d`
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

The drawn-motion audit, against `6b4140d`:

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

## Uncapped shell falls -- `f8ec4d5`

The promised drawing-side follow-up, taken for the one terminal type
whose timing is purely cosmetic. Deltas against `6787773`:

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
  `6787773` added are repaid two and a half times over.
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
  **Removed at `3c5edf5`**: pairwise candidates now carry the capped
  `end_time` for decisions and a separate `draw_end_time` for the
  renderer. The residual path needed no split -- the flow solver has
  decided everything before an assignment is applied. Confirmed by
  re-run at `3c5edf5`: the report is byte-identical to the `6787773`
  run (the wiggle given back, terminals 1,614,645, `shell_falls`
  619,133), the audit's link structure reverts with it, and
  `terminal_links_rushed` holds at 69,351 -- the drawing win survives
  the decision revert in full.

## Orbit-backed absorption and its guards -- `b29240b` + `8d310e3`

The branch's absorption work at full scale: `b29240b` lets pill-orbit
evidence absorb a stitch-skipped restatement however far the sender's
clock drifted (the 101202.10 pillbox-3 case), and `8d310e3` guards it
for dense streams -- at most one candidate per snapshot, and an
observation the surviving orbits rule out is refused outright. Measured
by the corpus owner at the branch tip `e6bf843` (engine identical to
`8d310e3`; `e6bf843` is tooling only). Deltas against the `3c5edf5`
re-run. The guards fired roughly a hundred times more often than on the
fixture: an angry pillbox fires every five or six ticks, so the
multiple-candidate configuration the fixture shows seven times is
routine in laggy games.

The report:

* `rate_shells_matched_forward` 0.993725 -- down from 0.993965,
  `shells_unmatched_forward` 61,607 (+2,361); `rate_shells_unlinked`
  0.002190 -- up from 0.002019 (21,500, +1,677). Both give back part of
  the records set at `6787773`, landing between `6b4140d` and
  `6787773`. The give-back is the double-absorbed stream-mate pairs no
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

**The follow-up measured null.** `97872bb` rank-pairs equal-sized
refusal groups on consecutive snapshots of one stitch's gap into
draw-only joins; a clean re-run at `501c110` (the first with the commit
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

## The backwards-pop anatomy -- diagnostic at `417e48e`

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

The rank-pairing rescue (`97872bb`), aimed at refused-group pairs this
tally shows barely exist, is reverted with this entry: zero activations
in 9.8M observations, and the R classes it targeted are single-snapshot
shapes it could never touch. The absorption guards, the visually-claimed
census rule, and the diagnostic breadcrumbs stay.

## Unseen-shot births -- `dc3bd3b`

The backwards-pop anatomy's named target, measured at `0176b3e` (a
gitignore line on top of `dc3bd3b`; engine identical). An origin-less
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

Branch total on the drawn axis, against the pre-branch `3c5edf5`
baseline: `rush_links` 4,841 -> 4,029, `pops_paired_backwards`
5,514 -> 3,908, `pops_paired_forward` 9,162 -> 6,579, `hover_links`
3,642 -> 4,164, at a matching-ledger give-back of 0.000240 forward and
+1,677 unlinked -- the guard entry's invented explanations leaving. The
remaining 3,908 backwards pairs are unnamed; a `--describe-backwards`
run at this commit would show what survives now that the `U` class is
visible.

## Stream-provenance births -- `c39c321`

The residual backwards tally at `1c65d3e` had said `any U: zero` -- the
orbit-membership claims removed their family completely -- and named one
remaining class as a gap rather than a frontier: 655 pairs whose pop-in
already carried a pillbox source. `propagate_ambiguous_pillbox_orbits`
names a head's pill and orbit states without claiming which stream-mate
it is (the only path that stores a source on an unclaimed head), but
nothing marked it birth-drawable. Which slot it holds does not matter
for its birth: in every candidate story it flew from that muzzle.
Measured at `d766553` (a gitignore line on `c39c321`; engine identical),
against the `dc3bd3b` run:

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

Branch total on the drawn axis, `3c5edf5` -> here:
`pops_paired_backwards` 5,514 -> 3,253 (-41%), `pops_paired_forward`
9,162 -> 5,917 (-35%), `rush_links` 4,841 -> 4,029 (-17%),
`hover_links` 3,642 -> 4,164 (+14%), with 17,137 shells claimed to
their muzzles and shooters, at a matching-ledger give-back of 0.000240
forward and +1,677 unlinked -- the invented explanations the guard
entry removed.

## The terminal-failure census -- diagnostic at `4c6db63`

Item 6 opened like the backwards-pop work did, with a census before any
dial: `--describe-terminals` classifies every terminal that ends the
pipeline unexplained (no matched shell, no unseen source) by the one
constraint that killed its nearest-to-viable story. Corpus run at
`4c6db63`, 443 files: 148,056 classified, reconciling exactly with
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

Corpus verification at `5364df7`, 443 files: the additivity argument
held exactly at scale. `terminals_unseen_pillbox_source`
120,077 -> 163,396, `terminals_unseen_tank_source` 64,185 -> 78,460
(+57,594 attributions); every other line of the report and the entire
drawn-motion audit byte-identical to the `4c6db63` run. The census
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

Corpus verification at `0331b90`, 443 files, reconciling to the digit:
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

Item 6 running total, `5364df7`'s baseline -> here: unexplained
terminals 148,056 -> 84,955 (-43%), unseen attributions +62,929, with
zero movement anywhere else on either axis. The remaining frontier:
`end_continued` 20,321 (23.9%), `no_candidate` 17,914 (21.1%),
`orbit_miss` 11,682, `edge_unforced` 10,519 -- and the first of those
is the continue-vs-die decision, which is not additive and gets the
measure-first treatment.

## Continue-vs-die measured, and mostly acquitted -- `f9e3412`

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

## The end-side census, and die-at-impact -- `6318416` + the dial

`--describe-ends` mirrors the terminal census from the watcher's side:
for every chain end with no forward story (61,421 corpus, exactly the
audit's pop-outs), what fate was available and what blocked it? Corpus
at `6318416`: `fate_taken` 24,624 (40.1%), `fate_open` 10,580 (17.2% --
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

Corpus verification at `2c8d770`, 443 files: 5,396 deaths.
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

Item 6 running total, `5364df7`'s baseline -> here: unexplained
terminals 148,056 -> 79,896 (-46%), terminals_matched +5,396 (real
matches, not attributions), unseen attributions +62,592 net, pop-outs
-8.8%, and on the whole branch's drawn axis backwards pops now stand
at 3,096 against `3c5edf5`'s 5,514 (-44%) and forward-paired at 5,733
against 9,162 (-37%).

## Subsumed joins in the residual flow -- `1de6e0d`

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

Corpus, `28fa3b0` -> `1de6e0d`, both runs by the corpus holder:
`shells_matched_forward` +3,892 (0.994274 -> 0.994671), unlinked
21,037 -> 19,134 (-9.0%), `terminals_matched` +2,383
(0.832129 -> 0.833354) with **every class gaining** -- `tank_hit`
+1,358, `explosion` +371, `pillbox_damage` +355, `shell_falls` +297,
`base_damage` +2 -- the first commit since `ffb7fd3` with no class
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

## Pill-stream lockstep -- `d8da3c9`

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

Corpus, `1de6e0d` -> `d8da3c9`, run by the corpus holder (the same
`files_failed 1` condition as the previous two rows; every per-corpus
total byte-identical). The `1de6e0d` raw report is not in the tree, so
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

## Late-head slide -- `8a513da`

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

Corpus, `d8da3c9` -> `8a513da`, run by the corpus holder:

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
  enumerated files; the `.py` skip-list entry (`5d34ad8`) retires the
  unparseable one at enumeration and the same 443 parsed logs remain
  (every per-corpus total byte-identical to the pinned corpus). The
  hash-relevant pair settles at 443/0 from here on.

## Dilated same-orbit continuations -- `fb6bd7c`

Origin: a replay outside the corpus (97a7dfa2-022603.5), where a
pillbox's two westward stream-mates drew as three shells -- the
watcher's report was literally "the viewer shows three shots where the
raw dots show two". The sender's shell list arrived one hop stale, both
shells jumped seven orbit steps across a five-update stamp window while
keeping their exact three-step separation, and the trailer's true hop
(28.018px against an expected 20) missed the 8px cost gate by 0.018px.
With the trailer candidate-less, the lockstep pass had one constrained
member and stood down; the leader took the trailer's statement by a
3.105 margin -- the identity swap again, this time surviving `d8da3c9`'s
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

Corpus, `8a513da` -> `fb6bd7c`, run by the corpus holder (443/0 both,
every per-corpus total byte-identical; raw runs kept in
`docs/corpus_runs/`, as the lockstep section's note asked):

* `shells_matched_forward` ~+5,087 (0.994823 -> 0.995341) and
  `shells_unlinked` 18,792 -> 15,722 (-16.3%): both shell-side records
  move, the largest single-commit gain since `6b4140d`.
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
  `3a7c1a5` -- see the seam closure section.
* Recorded for the next run, no recent baseline to compare:
  `shells_unseen_pillbox_birth` 12,890, `shells_stream_birth` 1,039,
  `shells_visual_joins` 3,235, `terminals_unseen_pillbox_source`
  167,939, `terminals_unseen_tank_source` 78,903,
  `terminal_links_rushed` 72,139 (71,552 at `8a513da`, +587).

The trade in one line: about five thousand vanish-and-reappear
artifacts -- the class the eye actually catches, backwards pops
included -- bought with a smaller, subtler class of locally mis-paced
links plus 28 seam pixels' worth of handoff error, and 160 terminals
of ledger. The drawn-speed residue is real headroom for a
smoothing-side pass, not a reason to hold the matcher's gains.

## Seam closure -- `3a7c1a5`

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

Corpus verification, run by the corpus holder at `b5714e6`
(engine-identical to `3a7c1a5`; the two commits between are docs):
exactly as predicted, on every axis. `find-seam-jumps.cjs` reports
`seam_jumps 0` across all 443 files; the audit's `seam_jumps` 81 -> 0
with `seam_jump_max` 0.00; the rates report is byte-identical to the
`fb6bd7c` run apart from its commit stamp, `content_hash` included.
The speed histogram wobble is two links total -- one 0.5-1.0 -> 0.0-0.5
and one 3.0+ -> 2.5-3.0 (`rush_links` -1 with it) -- and every other
audit line is unchanged. The class is closed, the pre-existing 53
included: handoff continuity is now guaranteed by construction rather
than by every endpoint-writing pass staying in sync, and the audit's
seam metric finally sits at the zero its header always said it should.
Raw audit kept as `docs/corpus_runs/3a7c1a5-audit.txt`; the report
would duplicate the `fb6bd7c` one byte for byte, so it is not.

## Tail slide -- `20db569`

Origin: 110702.1 once more, the same volley's final shot, spotted by
the corpus holder in playback: a 5.97 px/tick sprint into the pillbox
it kills. Its last restatement arrived stale -- three orbit steps
across a 22-tick gap, the chain behind it smoothed down to 1.3 px/tick
by the same anchor -- and the honest impact record landed six ticks
later, capping the drawn arrival, so the terminal link carried
eighteen ticks of real flight in six. Crawl plus sprint total 2
px/tick: the whole lie is the stale anchor. This is the chain TAIL as
the smoothing pass's other fixed time anchor, the late-head disease
mirrored, feeding `terminal_links_rushed` -- the class the late-head
section called the axis's real headroom.

The fix mirrors the head slide (`slide_compressed_chain_tails`): a
terminal link's drawn length is the sender's clock, so when it exceeds
the stamp window by more than the 8px quantisation bound, the end's
drawn position slides forward along the link to the stamped time's
honest place on the ray, leaving exactly the window's worth of flight.
It runs before smoothing, whose final anchor now prefers the slid
position, so the chain re-times onto the honest anchor: the incident
chain draws at a uniform 1.84 px/tick with its impact at exactly 2.
Shell falls never qualify -- their drawn end is the uncapped physics
arrival, excess zero by construction. Drawing only; ordered
tail-slide, smooth, reconcile, head-slide.

Fixture: `terminal_links_rushed` 494 -> 461, a hover gone, ~35 links
shifting steady -> 2.2-3.0 (a re-anchored chain runs slightly fast
end to end instead of ending in a sprint); the incident replay
329 -> 281 with its slow buckets shrinking; `3.0+`, the pop metrics
and the seam pair untouched everywhere; the rates report
byte-identical. The synthetic test -- a stale tail, then an explosion
four ticks later -- fails on the previous engine at 12 px/tick with no
slide.

Corpus prediction for the next run: matching axis byte-identical;
`terminal_links_rushed` (72,139) down by several thousand, seven to
fifteen percent if the three local logs generalise; the slow buckets
and `hover_links` down; a modest steady -> 2.2-3.0 shift as the cost;
`seam_jumps` still 0; pops and `3.0+` untouched. The remaining fast
class after this is the mid-chain compression the late-head section
named -- 110702.1's three 5.6 px/tick dilated links at records
44605-44612, where whole-chain smoothing's deviation guard stands down
-- which is the piecewise re-timing dial, deliberately sequenced after
this commit so both chain anchors are honest inputs to it.

Corpus verification, run by the corpus holder at `79e496a`
(engine-identical to `20db569`; raw audit kept as
`docs/corpus_runs/20db569-audit.txt`, the report a byte-duplicate of
the standing one, hash included -- matching axis byte-identical as
predicted):

* `terminal_links_rushed` 72,139 -> 68,478 (-3,661, -5.1%) -- "several
  thousand" holds; the three local logs' 7-15% did not quite
  generalise, the corpus's stale-tail population being a little
  shallower than the incident replay suggested.
* Every slow bucket down -- `0.0-0.5` -25, `0.5-1.0` -138, `1.0-1.5`
  -738, `1.5-1.8` -2,361 (-3,262 in all) -- and `hover_links`
  4,158 -> 3,995: the crawls into stale anchors straighten alongside
  their sprints, as the cancellation argument says they must.
* The predicted cost: `2.2-2.5` +6,044 and `2.5-3.0` +1,224, steady
  rate 0.961900 -> 0.961384.
* The one miss: `3.0+` 5,785 (+196) and `rush_links` 5,731 (+196),
  predicted untouched -- re-anchored chains whose stamp window is
  compressed enough that uniform re-timing onto the honest tail lands
  past 3 px/tick. A real cost line, 0.002% of links, and the same
  population the piecewise dial exists for; the number to watch on the
  next engine commit.
* `seam_jumps` 0, `seam_jump_max` 0.00, and every pop metric
  byte-identical, as predicted.

Net on the drawn axis: 3,661 sprint-into-the-wall terminals and 3,262
crawling links traded for 7,268 links running mildly fast end to end
and 196 crossing 3 px/tick. On the file's own perceptual reading --
sprints and crawls are what the eye catches, a uniform 2.3 is not --
that is the intended trade at close to the intended price.

## The smoothing guard split -- `06303dc`

The piecewise re-timing dial, delivered by a smaller cut than the name
suggested. The residue it targeted -- 110702.1's three remaining 5.6
px/tick links, mid-chain compression where whole-chain smoothing
stands down -- turned out to be a guard problem, not a model problem.
The 24px deviation bound conflated two claims: CROSS-track deviation
(off the chain's own ray -- the observation may not be this chain's
story, the real reason to refuse) and ALONG-track deviation (the
sender's stamp lying about when the shell was seen at a point it
provably occupied; shells fly straight, so an on-ray point between the
anchors is the shell at SOME time). Measured over this file's laggiest
replays, every chain the radial bound refused sat within ONE PIXEL of
its ray while lying up to 35.5px along it -- record backlog, not
doubtful identity -- and refusing drew each lie raw as a crawl into
the stale restatement and a sprint out of it. And because shells fly
straight, the chord is the flight path: constant-velocity re-timing
onto it is exactly the piecewise dial, with no new model needed.

The guard now tests the components separately: cross-track keeps 24px,
along-track allows 48 (twice the radial bound, covering the worst
observed lie with margin). Strictly wider -- every chain smoothed
before still is, so nothing regresses by construction.

Fixture: byte-identical, hash included (it has no refused chains at
all -- the class lives in laggy logs). The incident replay collapses
its class: `hover_links` 34 -> 18, `rush_links` 29 -> 8, `3.0+`
29 -> 8, `0.0-0.5` to zero, +84 links steady; the ankle replay's one
refused chain smooths (a hover gone). Rates reports byte-identical
everywhere; seams 0. The synthetic test pins an interior 28px behind
schedule and 0.3px off the ray re-timing to a constant 2.02 px/tick,
and fails on the previous engine unsmoothed.

Corpus prediction for the next run: matching axis byte-identical;
`hover_links` (3,995) and `rush_links` (5,731) both down along with
`3.0+` (5,785) and the slow buckets, steady up. Magnitude is poorly
bracketed by the local logs -- the refused-chain population is
strongly lag-dependent (22 chains in 110702.1, one in the ankle
replay, zero in the fixture) -- so direction is the claim, not size.
The tail slide's +196 pace-compressed chains are NOT this population
(they smooth already, too fast overall) and should not move; they
remain the number to watch.

Corpus verification, run by the corpus holder at `e42c53c`
(engine-identical to `06303dc`; raw audit kept as
`docs/corpus_runs/06303dc-audit.txt`, the report once again a
byte-duplicate of the standing one, hash included):

* The extremes collapse as predicted: `hover_links` 3,995 -> 3,446
  (-13.7%), `rush_links` 5,731 -> 4,511 (-21.3%), `3.0+`
  5,785 -> 4,556, and `0.0-0.5` **halves**, 1,083 -> 554. The
  refused-chain population was clearly worth admitting at corpus
  scale.
* The redistribution's shape is instructive: `1.0-1.5` gains 1,895.
  A refused chain used to spend its lie as a crawl plus a sprint; once
  admitted, a chain whose overall stamp span genuinely exceeds its
  flight re-times to a uniform 1.0-1.5 px/tick instead. Uniform-slow
  replaces jerky -- the trade the pass exists to make -- and the
  remaining pace error is the stamp-span compression class, position
  fixes cannot reach it.
* `terminal_links_rushed` 68,478 byte-identical, `seam_jumps` 0,
  steady rate flat (+0.000012), and one pop pair reclassifies
  forward -> backwards (4,666/2,924 -> 4,665/2,925) as a smoothed
  endpoint moved past its partner -- the only movement outside the
  speed histogram.

With this row the branch's whole drawn-axis ledger, `8a513da` ->
`06303dc`, reads: pop-outs 50,638 -> 45,552, seams 53 -> 0, rushed
terminals 71,552 -> 68,478, hovers 3,894 -> 3,446, against a steady
rate easing 0.964548 -> 0.961396 and rushes 3,710 -> 4,511 -- the one
drawn metric still above its branch-point value, the dilated links
drawing the clock's lie, now that the lies once hidden in freezes,
pops and phantom births are drawn as moving links at all.

## Pill-wide lockstep -- `11c9a94`

The payoff of the shell-list-skew resolution: with every list of one
record established as a single sampling instant ([E:shell-list-skew]),
one common step advance explains a pill's entire roster per sender
transition, whatever each shell's bradian or list. The lockstep pass
now groups by pill alone -- one clean stream-mate anywhere in the
volley pins the advance for every shell of the pill -- where the
`d8da3c9` original could only compare shells sharing a single bradian,
leaving every singleton-bradian volley member (most of a turning
pill's shots) unprotected. Membership asks only that a shell's current
step be well-defined: one bradian, or several bradians agreeing on one
step, as near-muzzle states do. The stand-down rule is unchanged: no
common advance, no pruning.

Fixture: one unseen-birth claim withdrawn (23 -> 22, two claims
shifting species to stream-provenance births), unfated ends
300 -> 299, a pop pair gone. The laggy 110702.1 replay shows the
intended shape at strength: backwards pops 15 -> 11, hovers 18 -> 12,
pop-outs 211 -> 200, +12 links. The synthetic test pins the veto -- a
bradian-205 mate's unambiguous +7 forcing the bradian-195 leader off a
cheap four-step imposter it used to take by a 13-point margin -- and
fails on the previous engine with exactly the swap.

Corpus prediction for the next run -- a matching-axis change, so
nothing is byte-identical this time: `shells_matched_forward` up and
`pop_outs` down by a few hundred to a thousand (the three local logs
scale poorly, +1/+5/+12 links); `pops_paired_backwards` down by more
than its share, this being the anti-crossing rule at full width;
`shells_unseen_pillbox_birth` down; a small terminal ledger wobble
possible (the ankle replay gave back two terminal links). The
follow-up dial this sets up: the same one-advance-per-transition rule
as a veto in the stitching and residual passes, which currently accept
stories the matcher's lockstep would refuse.

Corpus verification, run by the corpus holder at `e3bc0e4`
(engine-identical to `11c9a94`; raw runs kept under
`docs/corpus_runs/`):

* `shells_matched_forward` +721 (0.995341 -> **0.995415**) with
  `pop_outs` 45,552 -> 44,831, exactly complementary, and
  `shells_unlinked` 15,722 -> 15,186 (-3.4%, to **0.001547**): both
  shell-side records move for the third commit in the arc, and the
  +721 sits mid-range of the few-hundred-to-a-thousand call.
* The attribution ledger trades invented stories for identity:
  `shells_visual_joins` 3,235 -> 2,992 (-243, -7.5%) and
  `shells_unseen_pillbox_birth` 12,890 -> 12,529 (-361), with
  `shells_with_pillbox_source` +2,014 -- vetoed swaps re-linking as
  the chains they always were.
* The terminal cost: -51 (0.833183 -> 0.833156), a third the size of
  the lockstep original's -174 and spread thin across classes
  (`tank_hit` -24, `pillbox_damage` -19); the same two readings as
  ever apply, and the residual-veto sequel is the instrument that
  would shrink it.
* Two soft misses, recorded: `pops_paired_backwards` fell -24 to
  2,900 -- less than its proportional share, not more, so the
  crossing class the rule targets is already mostly the matcher's
  rarer failure -- and `rush_links`/`3.0+` +196 as some of the newly
  correct links draw across their compressed stamp windows at the
  clock's lie, the standing pace residue that belongs to the
  drawing-side dials.
* `seam_jumps` 0, hovers -49, rushed terminals +18, steady rate
  -0.00016: the drawn axis otherwise holds.

## Residual lockstep veto -- `99d402a`

The lockstep's second arm: stitching and the residual flow accepted
stories the matcher's lockstep would refuse. Now, for each pill and
adjacent record pair, the pill's own STATEMENTS vote on the one
advance the sender's transition carries -- accepted only when it
explains at least three step-pinned statements and beats the runner-up
by two -- and a stitch or dilated join must agree or it is refused.
Conservation keeps the vote honest against cadence aliasing:
terminal-matched shells died mid-pair and do not vote as survivors,
claimed new shots are births and not landing spots. No dominant
reference, no veto.

Worth recording that two designs died on the fixture first. Trusting
accepted links let a single uncorroborated pairwise crossing --
admitted while its shell was still a sourceless orphan, exactly the
class the rule hunts -- become a unanimous "reference" that vetoed the
three correct joins beside it. And an unconserved roster vote aliased
to the fire cadence: dying shells and fresh shots mapped the roster
ladder onto its neighbours one slot over, outscoring the truth 7 to 5
at a physically absurd advance. Statements outvote links, and only
survivors vote.

Every fixture veto was hand-verified against the rosters, all four
righteous: a +9 stitch that was one half of a genuine crossing (its +5
partner being pairwise, beyond this dial's reach), an orbit-pinned
shell claiming a wholly off-orbit ghost chain, and two more of the
same shapes -- while the pruning heals two other chain ends and
matches one more terminal. The cost is honest pops where invented
joins used to be: fixture pop-outs +2 net, the 110702.1 replay +7 with
`rush_links` and the `3.0+` bucket down and the steady rate up.

Corpus prediction for the next run: the first deliberate ledger
give-back since `8d310e3` -- `shells_matched_forward` DOWN by a few
hundred to a thousand as vetoed joins leave, `pop_outs` up by the
complement, `shells_visual_joins` down, `rush_links` and `3.0+` down a
little, `seam_jumps` still 0, and small mixed movement in the birth
and terminal ledgers (the fixture gained a terminal; the vetoed
stories free their pieces for better claims). The known asymmetry, on
the record: a crossing whose wrong half is a PAIRWISE link is beyond
this dial -- the fixture shows two such surviving halves -- and
feeding the same statement-roster reference into the pairwise matcher
is the remaining lockstep dial.

Corpus verification, run by the corpus holder at `d280566`
(engine-identical to `99d402a`; raw runs kept under
`docs/corpus_runs/`):

* The give-back, as called: `shells_matched_forward` -1,042 (top of
  the predicted range) with `pop_outs` +1,042, exactly complementary;
  `shells_visual_joins` 2,992 -> 2,474 (-17.3%); `seam_jumps` 0;
  `terminal_links_rushed` byte-identical. The vetoed starts re-settle
  as stream-provenance births (+1,001) rather than joins.
* Two signals the vetoed joins were really lies, neither predicted
  this strongly. `terminals_matched` +70 with **every class gaining**
  (`tank_hit` +32, `shell_falls` +23, `pillbox_damage` +11,
  `explosion` +3, `base_damage` +1) -- only `1de6e0d` had ever gained
  every class at once -- the false joins had been hogging shells their
  real impacts needed. And the speed histogram enriches: the steady
  bucket GROWS by 1,760 links while total links fall 1,112, because
  the removed joins were disproportionately mis-paced.
* The misses, small: `rush_links` +20 and `3.0+` +18 where "down a
  little" was called, and `pops_paired_backwards` +22 -- vetoed joins
  expose the pop pairs they papered over, some reading backwards.
  `shells_unseen_pillbox_birth` +48 against a "down" lean.
* Ledger positions: `11c9a94` keeps both shell-side records (0.995415
  / 0.001547 against this row's 0.995308 / 0.001558 -- the give-back
  returns roughly the pill-wide commit's coverage gain while keeping
  its correctness), and the terminal rate rises to 0.833192, second
  only to `1de6e0d`'s record.

## Pairwise roster lockstep -- `aab319e`

The lockstep's last dial, closing the asymmetry the veto's entry put
on the record: a crossing whose wrong half is a PAIRWISE link. The
same statement-roster vote (>=3 pinned statements explained, runner-up
beaten by two) now runs inside the matcher, per pill and transition,
before margins decide anything. Differences from the post-match
reference, forced by running this early: target statements carry no
propagated orbit states yet, so their steps are pinned from raw
positions against the orbit table directly; and a shell's death is
undecided at match time, so dying shells stay in the source vote
(conservation still holds on the target side -- claimed newborns are
excluded -- and the margin gate is what makes a
death-thinned ladder stand down rather than misvote).

A passing vote is applied twice. Every pinned member's surviving
continuation must sit at exactly its step plus the advance -- the
within-margin wrong halves the candidate-based lockstep could not
prune, since it only intersects advances a member's own candidates
support. And landing ownership: a target step exactly one member's
statement explains belongs to that member, evicting the
provenance-less thief -- the sourceless orphan (born before the log,
or past claiming range) that competes on bare distance cost and wins
a compressed interval. A candidate another passing pill retained is
never evicted; two statements claiming one point is a genuine
conflict left to margins.

Every changed fixture transition hand-verifies as a uniform-advance
ladder where mixed advances used to draw: the (1920,1904) pill's +8
over 13 stamped ticks (9 rungs aligned, a minted stream birth and
four repair stitches dissolve into plain matches), the (2032,1856)
pill's +8 where a MID-FLIGHT s16 mint becomes a real continuation and
the one honest mint moves to the muzzle, and the (1808,2368) pill's
+9 (5 rungs) where an unseen-shot mint, a frozen end, and a stolen
tank_hit all resolve -- the downstream chain regaining exact orbit
provenance it never had. Plus one pure crossing swap, the trailer no
longer overtaking its leader. Unlike the veto this dial is gain on
every local ledger at once: the three local logs together are matched
+32, pop-outs -32, stream births 36 -> 22, unseen births -4, visual
joins -1, terminals +1, unlinked -8, steady-speed links +93.

Corpus prediction for the next run: `shells_matched_forward` UP by a
few hundred to ~1,500 with `pop_outs` down by the complement,
retaking both shell-side records from `11c9a94` (matched_forward
above 0.995415, unlinked below 0.001547) while keeping the veto's
terminal rate near 0.8332 or above (small `tank_hit` gain);
`shells_stream_birth` down by a few hundred (part of the veto's
+1,001 re-linking as true uniform-advance continuations),
`shells_unseen_pillbox_birth` down by tens to ~200, `seam_jumps`
still 0, the steady speed bucket up by low thousands with `1.5-1.8`
net down, and small mixed movement in `hover_links` and
`pops_paired_backwards` (ankle and seam1 moved one each, opposite
ways -- a lockstep-verified continuation over a lying stamp can
legitimately draw off-pace; that remains the deferred pace residue).

Corpus verification, run by the corpus holder at `956f1b7`
(engine-identical to `aab319e`; raw runs kept under
`docs/corpus_runs/`):

* Both shell-side records retaken, as called: `shells_matched_forward`
  +1,822 (just past the ~1,500 top of the range) with `pop_outs`
  -1,822, exactly complementary; 0.995494 matched / 0.001520 unlinked
  against `11c9a94`'s 0.995415 / 0.001547. And unlike `11c9a94`, the
  terminal ledger rises with it: `terminals_matched` +111 (`tank_hit`
  +99, `shell_falls` +34, `explosion` +9, against `pillbox_damage`
  -29, `base_damage` -2), 0.833249, second only to `1de6e0d`.
* The mint collapse outran the call. `shells_stream_birth` 2,057 ->
  923 (-55%; "down by a few hundred" was the prediction) -- more than
  the veto's whole +1,001 re-settled as real uniform-advance
  continuations. `shells_unseen_pillbox_birth` -193 (called at tens
  to ~200), `shells_visual_joins` -182, `shell_births` -1,382, and
  provenance flows through links instead of fresh claims
  (`shells_from_pillbox` -1,380, `shells_with_pillbox_source`
  +1,239).
* The audit agrees on every lie metric at once, better than the
  "mixed movement" hedge: `hover_links` -49, `rush_links` -31,
  `pop_ins` -329, `pops_paired_backwards` -46, `seam_jumps` still 0.
  The steady bucket grows 7,220 links (called at low thousands) while
  `1.5-1.8` sheds 4,830 -- with only +1,711 new links, some 5,500
  existing links moved onto the steady pace -- and `rate_links_steady`
  0.962269 is the audit era's best.
* The one counter-signal, small: `terminal_links_rushed` +44 on a
  base of 68,496 -- newly matched terminals in laggy volleys still
  draw their final hop fast. That is the deferred pace/drawn-speed
  residue, unchanged in character.

## Fast-ring verbatim re-sends -- `efe9ab2`

Motivated by a user-supplied fast-ring log outside the corpus, since
committed in redacted form as `fixtures/040601.6` (a two-player
low-latency game, token circulating every 1-3 ticks against
the corpus-normal ~12): there the sender's packet rate outpaces its
shell resampling, over half of all closely-spaced statements restate
the previous record's shell samples byte-for-byte under a fresh
receive stamp, and two sender packets occasionally land inside one
recorder tick. Every verbatim re-send seeded a parallel chain that
divided the true statement stream with the original and starved into a
mid-air pop, and every zero-duration snapshot pair fragmented every
chain crossing it. On that log the branch took
`rate_shells_matched_forward` 0.9819 -> 0.9986 and `pop_outs` 1,537 ->
118 while `rate_terminals_matched` held (0.8913 -> 0.8915).

Two engine changes (see `INTERPOLATION.md` and the commit message):
`link_stale_restatements` links a byte-identical restatement within 4
ticks as the same statement re-sent (identity, zero advance, states
copied verbatim, running before birth attribution so a re-send cannot
consume F4 capacity or be minted as a new shot), and
`match_shell_snapshots` now matches `duration == 0` pairs instead of
returning, record order carrying what the tied stamps cannot. Both are
inert at normal cadence: the fixture report is byte-identical, so this
branch has no fixture row and its evidence is this corpus run plus the
motivating log.

Corpus verification, run by the corpus holder at `efe9ab2` (raw runs
under `docs/corpus_runs/`):

* Both shell-side records move by the largest single step since the
  `ecd220c` era: `shells_matched_forward` +11,319 with `pop_outs`
  -11,319 (44,051 -> 32,732), exactly complementary; 0.996647 matched /
  0.001446 unlinked against `aab319e`'s 0.995494 / 0.001520. So the
  corpus does contain fast-ring stretches -- about a quarter of its
  residual pops were this one mechanism.
* The mint collapse is the largest yet: `shells_unseen_pillbox_birth`
  12,384 -> 6,401 (-48%) -- half of all orbit-membership birth claims
  were verbatim re-sends being minted as second shots --
  `shells_visual_joins` -899, `shell_births` -6,161,
  `shells_from_pillbox` -6,080, and provenance flows through links
  instead of fresh claims (`shells_with_pillbox_source` +12,211,
  `shells_with_birth` +46,296). `shells_stream_birth` moves +346
  against the tide, small.
* The audit's lie metrics follow: `pop_ins` -5,540,
  `pops_paired_backwards` 2,876 -> 1,382 (-52%), `seam_jumps` still
  0 / 0.00, and `rate_links_steady` 0.962269 -> 0.966241, the audit
  era's best -- the 2.2-3.0 buckets shed ~36,600 links onto the steady
  pace.
* The terminal give-back: `terminals_matched` -381 (0.833249 ->
  0.833054; `pillbox_damage` -321, `tank_hit` -87, `base_damage` -6,
  against `shell_falls` +31, `explosion` +2), leaving `1de6e0d`'s two
  terminal-side records untouched. 342 of the 381 reappear as
  `terminals_unseen_pillbox_source` (+342): the impact keeps its
  firing pill, losing only the shell-to-shell identity -- consistent
  with the known hazard that a terminal arriving in the same record as
  a verbatim re-send is pre-linked past and must be recovered by the
  residual pass, which prices it dilated. A twin rule that stands down
  when the twin has a live terminal candidate in the same snapshot is
  the obvious refinement if those 381 are ever worth chasing.
* `hover_links` +264 and `rush_links` +2,734 / `terminal_links_rushed`
  +733 are dominated by a metric definition, not drawn motion: the
  audit scores any zero-duration link as infinite speed, and dt=0
  links exist at all only since this branch. On the motivating log
  1,085 of 1,104 rush links were zero-duration and every one drew at
  zero length after smoothing (none moved more than half a pixel);
  the corpus decomposition awaits a holder run, but the same
  arithmetic (real positive-duration rushes 345 -> 19 there) says the
  drawn-speed story improved rather than regressed. Teaching the
  audit to bucket zero-duration links separately would settle it
  without redefining the historical columns.

The same fast-ring regime turned out to damage drawn tank and LGM
motion through their receive stamps (no identity is at stake, so
nothing pops -- the raw lerp just wobbles and freezes), fixed by
`smooth_track_positions` with its own measurement axis,
`tools/audit-track-motion.cjs`; see `INTERPOLATION.md` and the
`b102926` commit messages for the mechanism and the per-fixture
numbers. The corpus holder's run at `b102926`
(`docs/corpus_runs/b102926-track.txt`, made before the tool stamped
provenance) settles how widespread the regime is: **29.3% of all
tank statements and 20.9% of all LGM statements corpus-wide sit at
the few-tick gaps the pass engages on** -- the fast ring is a large
minority of the corpus, not a curiosity, consistent with the quarter
of forward-match failures the shell fix recovered. The pre-smoothing
baseline pair (`docs/corpus_runs/559ce0b-track.txt`: today's tool
dropped into a `559ce0b` worktree, the run stamping `commit unknown`
because the drop-in sat outside git's view -- the corpus holder
attests the checkout was `559ce0bece8bd6e68c891eb2f519b5a170739be5`)
quantifies the corpus-scale gain, with its own validity marks: the
same corpus input hash as every pinned run, `smoothed_points` 0
proving the raw engine, and `segments` and `zero_duration_pairs`
byte-identical to the smoothed run, since smoothing moves positions
and never structure. Measured:

* `rate_tank_alternation` 0.139317 -> 0.083348 (-40.2%), mean speed
  change 0.435823 -> 0.312838 (-28.2%), stale sandwiches 131,678 ->
  85,769 (-34.9%), with `moving_pairs` +192,987 as healed freezes
  rejoin the moving census. (Composition from the two fixtures had
  predicted "roughly 13-14% -> 8.3%"; the measured 13.93% -> 8.33%
  lands on it.)
* `rate_lgm_alternation` 0.163542 -> 0.103984 (-36.4%), mean
  0.479763 -> 0.345410 (-28.0%), stale sandwiches -1.3% -- the LGM
  freeze census is dominated by real work pauses at normal cadence,
  left alone by design.

Post-smoothing the corpus draws between the untouched normal-cadence
fixture and the smoothed fast-ring one, as composition predicts.

## The vouched-link metric -- `1ea546c`, measurement only

No engine change: `score_pill_links` bins every settled pill link
against the statement-roster vote after the fact (the fixture file's
section carries the definition, the six fixture contradictions and the
fast-ring keying finding that made the scorer key by snapshot index).
Corpus verification, run by the corpus holder at `1ea546c`
(`docs/corpus_runs/1ea546c-report.txt`):

* The engine is provably untouched: every pre-existing line of the
  report is byte-identical to the `efe9ab2` run, `content_hash` aside,
  so the matching state of record stays `efe9ab2` and this run adds
  columns rather than moving any.
* 8,162,955 shell-to-shell links: 3,023,189 from chains with no pill
  source, 1,393 visual joins, 19,867 verbatim re-sends, 29,221 with an
  unpinned end (item 8's stitch-exactness debt is 0.36% of all links
  at corpus scale), leaving 5,089,285 scored.
* `rate_links_pill_vouched` 0.569387 (2,897,774),
  `rate_links_pill_contradicted` **0.000083** (423), unvouched
  2,191,088 (43.1%).
* The contradiction rate is under half the fixture's 0.000182, so the
  corpus is no worse than the hand-picked sample on the one truth axis
  now available. 423 links in 5.09 million is the alarm's baseline: a
  change that moves it by tens is worth a look, one that moves it by
  hundreds is a regression whatever the coverage rates say.
* The unvouched 43% is the honest size of the residue the roster vote
  cannot see -- pairs where no dominant advance passed the score-3 /
  margin-2 gates: sparse pills, dying and newborn shells thinning the
  roster, dilated gaps. Those links stand on cost margins alone, as
  they always did; the metric now says how many there are, and sizes
  whether another dial on that residue is worth building.

## Doubtful voters abstain -- `3d6165a`

The vouched-link metric's first complaint, chased from the fixture
scene its six contradictions named (records #111355 -> #111359 on
client 2; the fixture file has the scene and the dial). A pill's roster
election stood down one short of its margin because a shell that died
over the pair cast the deciding vote for the rung-shift alias -- a
dead shell's position plus one fire cadence landing on its neighbour's
true landing -- and cost then linked the ladder one rung short,
popping the trailing shell and leaving the record's second tank hit
unmatched. Members holding a terminal candidate over the pair now
abstain from the vote that must pass the score-3 / margin-2 gates,
the full roster still having to rank the same advance first, so an
alias the full vote would not lead can never win through it. Fixture:
contradictions 6 -> 0, matched forward +6, pops -6, fast-ring fixture
byte-identical on both axes.

Corpus verification, run by the corpus holder at `3d6165a` (raw runs
under `docs/corpus_runs/`, both stamped with the commit and the pinned
input hash, zero failures):

* Both shell-side records move on: `shells_matched_forward` +103
  (0.996647 -> 0.996657) with `pop_outs` -103 (32,732 -> 32,629),
  exactly complementary as at `efe9ab2`; `shells_unlinked` -36
  (0.001446 -> 0.001443).
* The terminal side gains too, for once in the same direction:
  `terminals_matched` +135 (0.833054 -> 0.833123), `tank_hit` +76 --
  the scene's shape, a pill firing into a tank at close range and the
  ladder's second hit going unexplained -- `shell_falls` +27,
  `pillbox_damage` +24, `explosion` +9, `base_damage` -1. 34 of the
  135 come back from `terminals_unseen_pillbox_source` (an unseen
  attribution becoming a seen shell's death). `1de6e0d` keeps both
  terminal-side records (0.833354 / 236,059), now by 231 terminals.
* Mints fall as mis-linked ladders stop being re-minted:
  `shells_unseen_pillbox_birth` -13, `shells_stream_birth` -6,
  `shell_births` -20, `shells_from_pillbox` -22,
  `shells_with_pillbox_source` -119 (provenance that a wrong link had
  carried down a chain). `flow_components` -111: fewer fragments
  reach the residual pass.
* The truth axis: `links_pill_vouched` +436 (0.569387 -> 0.569486),
  `links_pill_unvouched` -569 -- more pairs now hold a passing vote --
  and `links_pill_contradicted` 423 -> 437 (+14, 0.000083 ->
  0.000086). The +14 is the alarm doing its job on a change to the
  very vote it scores: a pairwise election now passes where it used
  to stand down, and in fourteen places the post-hoc vote (taken with
  the fates decided, dying shells out of the source roster) disagrees
  with the link the match-time one admitted. Fourteen in 5.09 million
  is inside the "tens are worth a look" band the metric's own section
  set, not the "hundreds are a regression" one. The rates tool's
  `--describe-links` (added right after this run) prints every
  contradiction as a `link_example` line with its record times, pill,
  steps and elected advance, and a `link_class` tally by how far each
  link disagrees with the vote; a holder run with the flag names the
  fourteen.
* Audit: `rate_links_steady` 0.966241 -> 0.966551, the audit era's
  best again, the 1.5-1.8 bucket shedding 3,208 links and the 1.0-1.5
  bucket 173 onto the steady pace (+2,499) and the 2.2-2.5 bucket
  (+787) -- the admitted continuations are dilated, eight steps over a
  compressed twelve-tick stamp draw at 2.7 px/tick, the pace residue
  the roadmap's ideas shelf already carries. `hover_links` -13,
  `rush_links` +5, `terminal_links_rushed` +6, `seam_jumps` still
  0 / 0.00. The pop ledger: `pop_outs` -103 against `pop_ins` +52 and
  `pops_paired_backwards` +25 (1,382 -> 1,407) -- a passing vote
  evicts outside candidates from a claimed landing, so where the
  evicted shell was the true owner its target now starts a chain and
  its source ends one. Net pops -51; the backwards pairs are the
  honest cost on the books, at 0.000143 the rate's second-best ever.

## The 437 contradictions, named -- `cf7c061` links run

The corpus holder ran the rates tool with `--describe-links` at
`cf7c061` (`docs/corpus_runs/cf7c061-links.txt`; every coverage line
byte-identical to the `3d6165a` run, the flag adding 19 `link_class`
and 437 `link_example` lines). Read off the file, no engine access:

* 437 links in 218 scenes (one pill, one record pair): 131 scenes of
  a single link, 87 of two to seven. In **76 of the 87 multi-link
  scenes the engine's own links advance by different step counts
  within one pill over one interval** -- 284 links -- which lockstep
  forbids, so in those scenes the engine's story is inconsistent on
  its face and the vote's single advance is the better one. The
  contradiction alarm is catching wrong links, not wrong votes.
* The sign is the opposite of the fixture's. 350 links are long
  (`pairwise:+2` 146, `pairwise:+3` 125, `stitched:+2` 40 -- one rung
  ahead), 87 short (the fixture's ladder-linked-short shape). For the
  long class the link's step gap sits at physics (within one of
  duration/2) 255 times in 350 while the elected advance does 74
  times, and the gap-to-advance ratio clusters between 1.4 and 2.0:
  the sender's clock ran slow against the receive stamps, physics
  expected up to twice the true advance, and cost took the next rung.
  The largest scene (`101202.3`, pill (2160, 1952), t442170 -> 442182,
  seven links) is the whole ladder linked one rung long at advances
  5 and 6 against an elected 3 that explains six of seven statements.
* 54 of the 131 single-link scenes are stitched joins; the stitching
  pass reads the time-keyed vote table, so some of those may be the
  same-time key collision noted at `unanimous_lockstep_advance`
  rather than a matching error.
* Why the match-time vote let the long ladders through is not
  readable from this file: either it stood down (thin pinned landings
  among deep list members, or an alias inside the margin -- the
  abstention dial only helps when the spoiler holds a terminal
  candidate) or it passed and the compressed continuation was not
  among the candidates. Settling that wants the pill's pinned rosters
  at both ends and the match-time verdict on each `link_example`
  line -- recorded since the commit after this run: the matcher keeps
  every pill's election per record pair on the target snapshot
  (measurement only, output byte-identical), the scorer attaches it
  and both final rosters to each contradiction, and the tool prints
  them, with `roster_votes_unvoted / stood_down / passed` totals
  beside the rates (fixture: 9,918 / 2,538 / 3,171 -- the vote decides
  one election in five). The next links run reads all 218 scenes.

## The 437 read with their elections -- `0eba698` links run

The corpus holder re-ran `--describe-links` at `0eba698`
(`docs/corpus_runs/0eba698-links.txt`, coverage lines byte-identical
to `3d6165a`, each `link_example` now carrying the matcher's election
over its pair). Corpus-wide the matcher held 2,469,176 elections:
1,723,302 unvoted (under three pinned sources), 248,170 stood down,
497,704 passed -- the vote decides one election in five, as on the
fixture.

* **Every pairwise contradiction is a stand-down.** 340 pairwise: 335
  stood down, 5 unvoted, 0 passed. Of 376 stand-downs in all, 369
  had the matcher's best advance equal to the post-hoc vote's; the
  margin shortfall was one in 310 and a tie in 66; 346 had a dying
  member in the source roster. The matcher knew the advance and could
  not clear the gate.
* **The first abstention dial regressed 84 scenes.** In 84 of the 140
  pairwise stand-down scenes the full roster cleared the gates (e.g.
  `stood_down@5(2v2;full@5(4v2))`, three of five members dying and
  abstaining) and only the confident vote's failure blocked the pass
  -- contradictions `3d6165a` introduced, hidden inside its net +14.
* **The rule matrix**, scored on the file against all 140 scenes
  (310 links), agreement meaning the elected advance equals the
  post-hoc vote's:

  | rule | passes | agree | disagree |
  | --- | --- | --- | --- |
  | current (confident must pass, full leads) | 0 | 0 | 0 |
  | symmetric abstention | 84 | 84 | 0 |
  | symmetric + orphan tie-break | 110 | 110 | 0 |
  | orphan tie-break alone, no abstention | 107 | 107 | 0 |

  The 30 scenes neither rule reaches are tied or short of score
  three with the true advance itself carrying an orphan -- an
  unpinned source, now counted on the election record for the next
  run.
* Stitched contradictions (97) are a different population: 34 sit on
  pairs whose election passed and 19 on pairs with no adjacent
  election at all; the stitching pass reads the time-keyed reference,
  and those want their own reading.

The symmetric election with the orphan tie-break is built (fixture
file has the dial and its fixture numbers: +1 matched, -1 pop,
elections passed 3,171 -> 3,720, contradictions still 0, fast ring
byte-identical) and awaits its corpus row.

## The symmetric election and the orphan tie-break -- `4f02142`

Built from the `0eba698` links run's reading (previous section) and
scored on that file before the engine was touched. Corpus
verification, run by the corpus holder at `4f02142` (raw runs under
`docs/corpus_runs/`: the rates run with `--describe-links`, split into
`4f02142-report.txt` and `4f02142-links.txt`, and the audit; zero
failures):

* Both shell-side records move by the largest step since `efe9ab2`:
  `shells_matched_forward` +675 (0.996657 -> 0.996726) with `pop_outs`
  -675 (32,629 -> 31,954), exactly complementary once more;
  `shells_unlinked` -236 (0.001443 -> 0.001419). The terminal side
  +15 (`shell_falls` +15, `tank_hit` +12, `explosion` +5,
  `pillbox_damage` -16, `base_damage` -1); `1de6e0d` keeps both
  terminal-side records.
* The elections: `roster_votes_stood_down` 248,170 -> 183,827 and
  `roster_votes_passed` 497,704 -> 562,225 (+64,521, +13%); unvoted
  unchanged within 115. One pill election in four now passes.
* The truth axis: `links_pill_contradicted` **437 -> 89** (-80%,
  0.000086 -> 0.000017), vouched +4,308, unvouched -2,207, unpinned
  links 29,244 -> 28,457 (-787: exactness propagating further down
  correctly linked chains).
* Mints collapse as mis-linked ladders stop being re-minted:
  `shells_stream_birth` 1,263 -> 918 (-27%), `shells_unseen_pillbox_birth`
  -106, `shells_visual_joins` -82, `shell_births` -475,
  `shells_from_pillbox` -473, while `shells_with_pillbox_source` +454
  -- provenance carried by links rather than fresh claims, the same
  signature as `efe9ab2`. `flow_components` -290.
* Audit, every lie metric down: `pop_ins` -185, `pops_paired_forward`
  -35, `pops_paired_backwards` 1,407 -> 1,366 (-41, undoing
  `3d6165a`'s +25 and more), `hover_links` -35, `rush_links` -2,
  `rate_links_steady` 0.966551 -> 0.966644 (the audit era's best, the
  2.2-2.5 bucket giving back 408 of `3d6165a`'s 787), `seam_jumps`
  still 0 / 0.00. On the books: `terminal_links_rushed` +8,
  `terminals_unseen_pillbox_source` +8.

The remaining 89, read off the links file: 32 pairwise (30 stood
down, 2 unvoted; 21 of them on 2-4 tick pairs) and **57 stitched**. Of
the stitched, 38 sit on adjacent snapshot pairs, and in 29 of those
the link's step gap is exactly twice the elected advance, on 3-4 tick
pairs: the same-time key collision noted at
`unanimous_lockstep_advance` -- on a fast ring the one-hop and the
composed two-hop span write the same time key and the stitching pass
reads the two-hop advance for a one-hop join. That is a keying bug
with a measured population, and the next dial.

## Index-keyed vote table -- `4d5feb8`, measured null, reverted

The corpus holder ran both tools at `4d5feb8` (the branch head with
`3b4556d`, the index-keyed table, plus the name redaction; raw runs
under `docs/corpus_runs/` as `4d5feb8-*`). Against the `4f02142`
rows:

* The target did not move: `links_pill_contradicted` 89 -> 89, the
  same twelve classes with the same counts, and the same 29 stitched
  links on 3-4 tick pairs carrying twice the elected advance. Whatever
  those are, they are not the time-key collision.
* The costs were small but real and one-sided: `terminals_matched`
  -8 (`shell_falls` -4, `tank_hit` -2, `explosion` -1,
  `pillbox_damage` -1), `shells_matched_forward` -8 with `pop_outs`
  +8, `pops_paired_forward` 3,230 -> 3,252 (+22, one shell drawn as
  two -- the audit's most visible class), `hover_links` +2,
  `pops_paired_backwards` +2; `links_pill_vouched` +32 the only gain.

Reverted in the next commit. The reading: the composed two-hop
advance that a time key handed a same-time join was, in those eight
cases, the right answer -- which is consistent with the 29 two-hop
stitched contradictions being physically right too, a link across a
same-time pair whose source statement belongs to the earlier of the
two sender updates. If so the scorer's adjacent-pair vote is the wrong
yardstick for links that cross a same-time pair, and the alarm's
residue there is the metric's, not the engine's. Settling it wants
each link to carry which pass made it (pairwise, stitch, dilated,
residual, absorption) -- `stitched` is one flag set by several -- and
that is on the shelf, not built.

## The same-record starvation shape -- diagnostic, no dial

Found chasing the fixture's six unmatched `shell_falls` the census calls
`no_candidate` (the class anatomy: of thirteen unmatched falls, six have
no story at all, one has a single legal-but-declined candidate, six have
exactly two dangling candidates each -- dense-volley neighbours -- and
never a crowd). The owner identified the first probed case, fixture
record 47,489, as their own tank firing at deliberately low range at an
enemy LGM: fall 12px from the muzzle, flight ~6 ticks, shot and fall
reported in the SAME record, the shell never sampled by any list.

The mechanism, confirmed by instrumenting the resolver: the residual
flow cannot see same-record creation-to-fate stories at all --
`creation_fate_match` with no extra flight window rejects duration-zero
pairs, and only the same-record phase (phase three) grants the
fire-time window. So the flow force-assigned that shot to the NEXT
record's `pillbox_damage`, which cascaded down the burst: every shot in
the volley matched one fate late (the roster-ladder off-by-one shape
again, in the creation/fate ledger), and by the time phase three ran
the pool was spent and the cost-zero true story starved.

Two caveats now on the record. The census's `no_candidate` can mean "a
perfect candidate existed but was already spent elsewhere" -- the probe
reads the post-spend unclaimed lists, so starved fates under-report.
And the burst itself was genuinely over-subscribed (four shot-shaped
fates for three unseen shots), so no assignment could have satisfied
every fate. The owner judged the drawn result -- an honest splash with
no shell -- visually acceptable, so no dial was built; the candidate
fix (same-record edges visible to the flow, or phase three running
before cost-forcing) is on the roadmap's ideas shelf with the falls
rescue.

## Two quadratic scans removed -- `1cb9502`; the time-order assertion -- `7b6f0a6`

A performance audit of `viewer/motion.js`, measured by replicating the
fixture in time: `build_shell_positions` ran 3.8s / 8.7s / 22.5s at 1x /
2x / 4x, quadratic in replay length. Profiling put the excess in the
residual pass: `absorb_intermediate_observations` scanned every snapshot
from the replay's first record once per stitch and per forced terminal,
and the pass's final write-back filtered the whole creation-group list
once per snapshot. Both now index by time (a binary search and a map).
The same run is 2.6s / 5.4s / 10.1s, and the fixture reports are
byte-identical.

Corpus verification, run by the corpus holder at `1cb9502` (raw runs
under `docs/corpus_runs/` as `1cb9502-report.txt` and
`1cb9502-audit.txt`, zero failures): both reports are identical to the
`4f02142` runs in every line but the commit stamp and the audit's timing
lines, `content_hash` included (`1d0a56ac...` and `6e20ab36...`). The
audit's `build_ms` 388,841 -> 302,768 (-22%) on the holder's machine.

The passes that binary-search per-client lists rest on a sender's record
stamps never running backwards, which the branch had only checked on the
two fixtures. `tools/check-record-time-order.cjs` now asserts it over a
corpus; the holder's run at `7b6f0a6` (`7b6f0a6-time.txt`):

* 443 files, 13,338,093 records, 13,336,505 same-sender pairs: **zero
  backwards steps** in every population -- all records, snapshot-making
  records, and whole-file order across senders. `verdict monotonic`.
* Zero-length same-sender steps: 32,125 over all records, 2,714 among
  snapshot-making ones (the fast-ring same-tick pairs the zero-duration
  matching exists for). Whole-file order is 62% zero steps (8.3M of
  13.3M), the ring's same-tick bursts.
* The largest same-sender forward gap is 93,351 ticks (about 31
  minutes): a sender falling silent, never a stamp going back.

The assumption is now corpus-established, not assumed.

## The sender's stale tank box -- `b9db294`, and its rushed-link correction

Motivated by replay `122204.3_ds.fredde_vs_oscar`, tick 5264529: a pill
shell pinned to one orbit passes a fast-moving tank's corner 2 px
outside the box the packet states but 3 px outside the recorder's
interpolated track box, and the tank hit in the very next record goes
unexplained. The packet box is the one the sender's simulation collided
against -- its last restatement of the tank, a ring-round behind the
recorder's track -- so the orbit walk now accepts it as well as the
track box (see the fixture file's entry for the mechanism).

Corpus, run by the corpus holder at `b9db294` against `1cb9502` (raw
runs under `docs/corpus_runs/` as `b9db294-report.txt` and
`b9db294-audit.txt`, 443 files, zero failures):

* `rate_shells_matched_forward` 0.996726 -> 0.996914, a new best
* `rate_shells_unlinked` 0.001419 -> 0.001379 (13,928 -> 13,539), a new
  best
* `rate_terminals_matched` 0.833131 -> 0.834069, a new best: +1,827 net,
  `tank_hit` +1,862 (235,847 -> 237,709), the other four classes
  giving back 35 between them (`pillbox_damage` -17, `explosion` -9,
  `shell_falls` -7, `base_damage` -2)
* `links_pill_vouched` +407, `links_pill_contradicted` 89 -> 92
* audit `pop_outs` 31,954 -> 30,114, backwards pops 1,366 -> 1,356,
  seam jumps still zero
* **`terminal_links_rushed` 69,287 -> 82,149** -- the one line the
  fixture did not predict, and 12,862 more than the terminal links
  gained. The three-file diff of rushed links between the two engines
  gave the cause exactly: every new rushed link is a pill shell whose
  last restatement already sits inside the packet box -- where the
  tank is *about to be* -- accepted at step zero as a zero-length,
  zero-duration terminal link, where the track walk had found the
  collision a step or two on at 2 px/tick. The fixture's rate lines
  are blind to it because the terminal is matched either way.

`0263483` gives the track box first refusal over the whole orbit walk
and only then walks the packet box, never from step zero. On the three
local files that removes every new rushed link (fixture
`terminal_links_rushed` 461 -> 461 against the first form's 598) and
leaves every rate line of the fixture unchanged, at a price of two tank
hits over the three files.

Corpus, run by the corpus holder at `0263483` (`0263483-report.txt` and
`0263483-audit.txt`, 443 files, zero failures), against `1cb9502` with
`b9db294` in brackets:

* `rate_shells_matched_forward` 0.996726 -> 0.996882 (0.996914), a new
  best on a clean run
* `rate_shells_unlinked` 0.001419 -> 0.001384 (0.001379): 13,928 ->
  13,591
* `rate_terminals_matched` 0.833131 -> 0.833914 (0.834069): +1,525 net,
  `tank_hit` +1,552 (235,847 -> 237,399), `shell_falls` -10,
  `explosion` -9, `pillbox_damage` -8, `base_damage` 0
* `links_pill_vouched` +366, `links_pill_contradicted` 89 -> 94 (92)
* audit `pop_outs` 31,954 -> 30,423 (30,114), backwards pops 1,366 ->
  1,360, seam jumps still zero, `rate_links_steady` flat at 0.9666
* **`terminal_links_rushed` 69,287 -> 69,411** (82,149): the 12,862
  zero-length links are gone, and the 124 that remain are the shape
  the three-file diff showed -- rescued shells whose arrival is capped
  at a hit record a tick or so later, the cost already accepted for
  lagging events

The correction kept 83% of the first form's tank-hit gain and 83% of
its pop-out reduction while returning the rushed-link count to within
0.2% of baseline. `build_ms` 302,768 -> 318,146 across the two runs on
the holder's machine, which is run-to-run variation: the change adds one
box test per orbit step in tank-hit candidate evaluation and a bounded
second walk only when the first finds nothing, and local timing of the
fixture build shows no difference beyond noise.

## The rush split -- `f3b4142`, measurement only

The audit scored a rush as distance over duration, with a zero-duration
link counted as infinitely fast, so the rush lines could not tell a
link drawn fast from one drawn in no time at all. The `efe9ab2` section
warned of it and the `b9db294` section met it. `f3b4142` splits each
rush line three ways -- *timed* (positive duration, above 3 px/tick:
the arrival capped by an event record that landed early), *static*
(zero duration, under half a pixel: drawing nothing) and *instant*
(zero duration with real length: the cap at its limit) -- with the
parts summing to the undivided line, which keeps its definition; see
the fixture file's audit section for the mechanism. The tool's
`--engine=DIR` runs it against another checkout's engine, which is how
the rows below were measured without touching the old trees.

Corpus, the `f3b4142` tool against the engines at `1cb9502`, `b9db294`
and `0263483` (`1cb9502-audit-split.txt`, `b9db294-audit-split.txt`,
`0263483-audit-split.txt`; 443 files, zero failures). Every line these
runs share with the archived `-audit.txt` files is byte-identical, so
the corpus they ran on is the holder's, and only the new lines are
news:

| engine | `terminal_links_rushed` | timed | static | instant | `rush_links` | timed | static | instant |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `1cb9502` | 69,287 | 12,981 | 55,459 | 847 | 7,433 | 1,492 | 5,937 | 4 |
| `b9db294` | 82,149 | 13,025 | 68,240 | 884 | 7,400 | 13,025 | 5,937 | 4 |
| `0263483` | 69,411 | 13,108 | 55,454 | 849 | 7,436 | 1,495 | 5,937 | 4 |

* **Four-fifths of `terminal_links_rushed` was static all along.** At
  `1cb9502`, 55,459 of the 69,287 are shells last stated already inside
  their terminal's 16 px box (3.4% of all terminal links), where the
  effect draws at the shell's position and there is nothing to
  animate. The class the line was always described as -- an arrival
  capped by an early event record -- is the 12,981 timed links (0.8%
  of terminal links), with 847 instant ones the cap taken to its limit.
  Every earlier reading of the line as "lag-related" was a reading of
  the timed fifth.
* **`b9db294`'s 12,862 were static, link for link:** static +12,781,
  timed +44, instant +37. The step-zero matches drew nothing, exactly
  as the three-file diff said.
* **`0263483`'s residual 124 is timed:** against `1cb9502`, timed +127,
  static -5, instant +2. Those are the rescued tank hits whose arrival
  is capped at the hit record a tick or so later, the cost the section
  accepted, now on the line that means it. Against `b9db294` the walk
  is +83 timed: where the first form matched at step zero and drew
  nothing, the track-first walk finds the collision a step or two on
  and the cap bites.
* **The non-terminal rush line is 80% static too:** 7,433 = 1,492 timed
  + 5,937 static + 4 instant, the static ones the verbatim re-sends of
  `efe9ab2`, identical at all three engines. The 4 instant links are
  genuine mid-flight teleports -- four in 8.16M links -- and go on the
  books beside the seam invariant.

The same tool was then run against every headline row from `6b4140d`
on, seventeen more engines (`<commit>-audit-split.txt` for each; 443
files, zero failures every time; every line shared with an archived
audit byte-identical, and every audit figure the table had taken from
a section's prose confirmed, including the +1,674 between `28fa3b0`
and `1de6e0d` whose undivided cells had been blank: 69,836 and
71,510). Terminal links first, then the non-terminal rush line:

| engine | timed | static | instant | `rush_links` timed | static | instant |
| --- | --- | --- | --- | --- | --- | --- |
| `6b4140d` | 21,286 | 54,684 | 627 | 3,606 | 1,239 | 15 |
| `6787773` | 24,214 | 54,680 | 627 | 3,587 | 1,239 | 15 |
| `8d310e3` | 14,077 | 54,680 | 627 | 3,995 | 0 | 0 |
| `28fa3b0` | 14,323 | 54,875 | 638 | 4,029 | 0 | 0 |
| `1de6e0d` | 16,056 | 54,816 | 638 | 4,219 | 0 | 0 |
| `d8da3c9` | 16,103 | 54,809 | 640 | 4,149 | 0 | 0 |
| `8a513da` | 16,103 | 54,809 | 640 | 3,710 | 0 | 0 |
| `fb6bd7c` | 16,205 | 55,301 | 633 | 5,536 | 0 | 0 |
| `3a7c1a5` | 16,205 | 55,301 | 633 | 5,535 | 0 | 0 |
| `20db569` | **12,544** | 55,301 | 633 | 5,731 | 0 | 0 |
| `06303dc` | 12,544 | 55,301 | 633 | 4,511 | 0 | 0 |
| `11c9a94` | 12,554 | 55,324 | 618 | 4,707 | 0 | 0 |
| `99d402a` | 12,554 | 55,324 | 618 | 4,727 | 0 | 0 |
| `aab319e` | 12,578 | 55,347 | 615 | 4,696 | 0 | 0 |
| `efe9ab2` | 12,974 | 55,446 | 853 | 1,489 | 5,937 | 4 |
| `3d6165a` | 12,979 | 55,449 | 851 | 1,494 | 5,937 | 4 |
| `4f02142` | 12,981 | 55,459 | 847 | 1,492 | 5,937 | 4 |
| `1cb9502` | 12,981 | 55,459 | 847 | 1,492 | 5,937 | 4 |
| `b9db294` | 13,025 | 68,240 | 884 | 1,459 | 5,937 | 4 |
| `0263483` | 13,108 | 55,454 | 849 | 1,495 | 5,937 | 4 |

* **Static terminal links are a property of the corpus, not the
  engine:** 54,680 to 55,459 across every engine but `b9db294`. A
  shell last stated inside its box is a fact of the log, and no
  matcher changes it, so every movement the undivided line ever showed
  was its timed part (plus `b9db294`'s step-zero matches).
* **Read as timed, the line's history is the one the sections told:**
  the leading impacts (`6787773`) cost +2,928 timed, "the expected
  cost"; the uncapped falls and the guards brought it to 14,077; the
  subsumed joins cost +1,733; the tail slide (`20db569`) took -3,661,
  all of it timed, and holds the record at 12,544.
* **`efe9ab2`'s +733 was not only a definition:** timed +396, instant
  +238, static +99 on the terminal side. Its non-terminal
  `rush_links` +2,734 was: timed 4,696 -> 1,489 (-3,207) as the 5,937
  static re-sends appeared. The section's inference that the drawn-speed
  story improved is confirmed, and the improvement was two-thirds of
  the real rushes.
* **The absorption guards' "instant sideways blips" are named:** the
  1,239 static and 15 instant non-terminal links at `6b4140d` and
  `6787773` -- the same-time double-absorbs -- go to exactly 0 / 0 at
  `8d310e3`, and no zero-duration non-terminal link exists again until
  the fast-ring re-sends.

The headline table's column is the timed part from here on; the
undivided `terminal_links_rushed` figures stay in the sections and the
archived files.

## Tank births follow the record gap -- `bc1c9b7`

The fixture file's section of the same name has the scene (a parked
tank firing two shots per 28-tick record at a wall, each fresh volley
orphaned and glued onto the previous one a pixel away) and the
mechanism: the tank-birth window in `mark_new_tank_shells` stopped
growing past the half-second position window and collapsed to the bare
muzzle tolerance, and now follows the gap, bounded by the shell's
range. The open form was chosen over a 50-tick-capped one on two local
files; the corpus was the check on whether the open window claims
shells it should not at long gaps.

Corpus, `bc1c9b7-report.txt` and `bc1c9b7-audit.txt` against `0263483`
(443 files, zero failures; `shells` and `terminals` identical, so the
same corpus):

* `rate_shells_matched_forward` 0.996882 -> 0.996964
* `rate_shells_unlinked` 0.001384 -> 0.001324 (13,591 -> 13,002)
* `rate_terminals_matched` 0.833914 -> 0.834427 (1,623,163 ->
  1,624,161, +998): `pillbox_damage` +685, `base_damage` +126,
  `explosion` +121, `tank_hit` +37, `shell_falls` +29 -- every type up
* `shells_from_tank` 652,175 -> 655,723 (+3,548), `shell_births`
  1,622,649 -> 1,626,198; `terminals_unseen_tank_source` 78,932 ->
  77,946 (-986): impacts that were credited to invisible shots are now
  the observed shell's own
* `links_shell` 8,163,589 -> 8,163,392 (-197) and `shells_visual_joins`
  1,311 -> 1,294: the dilated and visual joins that were gluing volleys
  together, dissolved; `flow_components` 134,819 -> 134,456
* `links_pill_contradicted` 94 -> 94, `links_pill_vouched` unchanged;
  pill matching does not see the change
* Audit: `hover_links` 3,538 -> 3,277 (-261), `pop_outs` 30,423 ->
  29,622 (-801), `pop_ins` 31,123 -> 27,771 (-3,352),
  `pops_paired_backwards` 1,360 -> 1,228, `terminal_links_rushed`
  69,411 -> 69,397, `rush_links` 7,436 -> 7,437, `rate_links_steady`
  0.966649 -> 0.966693, seam jumps still zero
* The slow speed buckets thin the most: `link_speed:0.0-0.5` 653 -> 571,
  `0.5-1.0` 2,885 -> 2,706, which is the hover-in-front-of-the-wall
  shape leaving the drawn output

The one concern the open window carried -- claiming a lingering old
shell as a fresh shot past the pairwise window -- would show as rushed
links, backwards pops or contradictions rising, and all three fell or
held. The four commits between `0263483` and this one touch only game
state (ownership on quit, base stocks, the LGM burst), so the whole
delta is this change's.

## Pill births follow the record gap too -- `1a67872`

The fixture file's section of the same name has the mechanism: the
pill-side birth marker stood down entirely past the half-second
position window, so an F4 and its shell in a long-gap record were left
to the residual pass, which could attach them only within 16 px of the
muzzle, and to the orbit-membership claim, which takes a lone sighting
only fresh from the muzzle. The marker now follows the gap as the tank
one does. The corpus question was whether F4-backed claims across long
gaps would contradict the roster vote or steal successors from live
shells.

Corpus, `1a67872-report.txt` and `1a67872-audit.txt` against `bc1c9b7`
(443 files, zero failures, same corpus):

* `rate_shells_matched_forward` 0.996964 -> 0.997117
* `rate_shells_unlinked` 0.001324 -> 0.001201 (13,002 -> 11,787)
* `rate_terminals_matched` 0.834427 -> 0.835183 (1,624,161 ->
  1,625,632, +1,471): `pillbox_damage` +656, `explosion` +358,
  `tank_hit` +352, `shell_falls` +105, `base_damage` level
* `shells_from_pillbox` 970,475 -> 971,634 (+1,159);
  `shells_unseen_pillbox_birth` 6,281 -> 3,530, the difference now
  claimed from their F4s rather than inferred from orbit membership;
  `terminals_unseen_pillbox_source` 168,392 -> 167,475 (-917)
* `links_pill_unpinned` 28,474 -> 19,325 (-9,149): heads pinned to
  their orbit at the muzzle carry the pin down the chain;
  `links_pill_vouched` +3,438, `links_pill_contradicted` 94 -> 92
* `shells_visual_joins` 1,294 -> 1,259, `flow_components` 134,456 ->
  132,645; `shells_from_tank` -1
* Audit: `hover_links` 3,277 -> 3,093, `pop_outs` 29,622 -> 28,113
  (-1,509), `pop_ins` 27,771 -> 26,575, `pops_paired_backwards` 1,228 ->
  1,169, `rate_links_steady` 0.966693 -> 0.966727, seam jumps still
  zero; the slowest bucket `link_speed:0.0-0.5` 571 -> 446
* The cost: `rush_links` 7,437 -> 7,480 (+43, all timed) and
  `terminal_links_rushed` 69,397 -> 69,415 (+18, sixteen timed) --
  newly attributed heads whose first link is drawn against a record
  that landed early, forty-odd against fifteen hundred pops removed

The second measured candidate, widening `creation_start_match`, is not
in this row; the fixture section records it as redundant.

## Dilated joins bounded by the measured clock lie -- `f9d3e7c`

The fixture file's section of the same name has the scene: the fourth
shot of the 4:21 stream, ten pixels from its wall, joined as a dilated
continuation onto the next volley's restatement a pixel behind it and
drawn at 0.85 px/tick for its whole life, the wall handed to the fifth.
The join assumed a 52 px clock lie over a 30-tick gap;
`dilated_join_candidate` had no bound on the shortfall at all, and now
refuses one beyond `MAX_SMOOTHING_ALONG_TRACK_PIXELS` (48), the bound
built on the largest along-track lie the corpus has shown (35.5 px).
The local numbers said this would be a trade -- the fast-ring fixture
lost three links for thirty hovers -- and the corpus confirms the
shape.

Corpus, `f9d3e7c-report.txt` and `f9d3e7c-audit.txt` against `1a67872`
(443 files, zero failures, same corpus):

* `hover_links` 3,093 -> 2,446 (-647, -21%); `link_speed:0.0-0.5`
  446 -> 339 and `0.5-1.0` 2,647 -> 2,107; `rate_links_steady`
  0.966727 -> 0.966814
* `links_shell` 8,163,430 -> 8,163,173 (-257): the refused joins.
  32 of their ends took a terminal instead (`terminals_matched`
  1,625,632 -> 1,625,664, every type up, `tank_hit` +11), the rest
  vanish: `shells_unlinked` 11,787 -> 12,000 (+213),
  `pop_outs` 28,113 -> 28,338 (+225), `pop_ins` 26,575 -> 26,820 (+245)
* `pops_paired_backwards` 1,169 -> 1,236 (+67) and
  `pops_paired_forward` 2,972 -> 3,054 (+82): the refused joins'
  orphans, popping in beside the vanish
* `shells_visual_joins` 1,259 -> 1,216, `links_pill_contradicted`
  92 -> 92, vouched -3, rushes +3, seam jumps still zero
* `rate_shells_matched_forward` 0.997117 -> 0.997095 and
  `rate_shells_unlinked` 0.001201 -> 0.001222, both records handed
  back to `1a67872`; `rate_terminals_matched` 0.835183 -> 0.835199 and
  `tank_hit` 237,788 -> 237,799, both records on

What the refused joins are, read off the two local files with the
refusal instrumented (four on the fast-ring fixture, five on the
motivating replay): two classes. On the fast-ring fixture most are
byte-identical restatements of a whole three-shell list 39 to 46 ticks
after its first statement, under a fresh ring count and beside a
same-tick record from the same sender whose list has moved on (the
fast-ring fixture, records #50498 -> #50544 at 29:12.5 -> 29:13.4,
#16515 -> #16539 at 10:30.6 -> 10:31.2, #52299 -> #52335 at 30:10.2 ->
30:11.0, all player 1) -- a stale list restated, an identity the 4-tick
re-send pass is right not to claim and that the join used to draw as a
46-tick hover before the shells vanished anyway. The bound refuses the
join, so the shells vanish at the first statement, and the re-send's
own shells, with no forward story of their own, are drawn for no
frame at all: `shell_position_at` holds a storyless shell only at its
own tick, which a fractional playback clock never lands on. The
backwards pairs are those zero-duration ghosts, audit bookkeeping;
what the eye sees is the hover ending 46 ticks sooner.
On the motivating replay all five are crawls of 7 to 20 px over 29 to
45 ticks from a tank stream restating fresh shells near old ones -- two
shells glued into one, the class the bound exists for. The corpus's
257 are presumably the same mix, and neither class loses anything
visible. A verbatim multi-shell re-send across a long gap is provable
identity (three shells do not repeat their bytes by chance), so the
re-send pass could be extended to claim it as a zero-advance link if
the ledger is ever wanted clean of those ghosts; nothing drawn would
change.

## Orbit states below a stitch -- `6b2cacd`

The fixture file's section of the same name has the mechanism:
identity propagated down a chain below every stitch, forced origin and
membership claim, and orbit states did not, so every link below such a
join kept only its quantised reconstruction. `propagate_states_down_chain`
re-derives them link by link with the pairwise matcher's own successor
functions. On the fixture it moved nothing but the pinning axis; the
corpus question was the same, at scale.

Corpus, `6b2cacd-report.txt` and `6b2cacd-audit.txt` against `f9d3e7c`
(443 files, zero failures, same corpus):

* `links_pill_unpinned` 19,311 -> 2,772 (-16,539, -86%);
  `links_pill_vouched` 2,906,319 -> 2,917,106 (+10,787);
  `rate_links_pill_vouched` 0.569769 -> 0.570037
* `links_pill_contradicted` 92 -> 140 (+48)
* Matching and drawing essentially still: `links_shell` -2,
  `terminals_matched` +5 (`tank_hit` +5, `shell_falls` +1,
  `pillbox_damage` -1), `shells_visual_joins` 1,216 -> 1,209,
  `pop_outs` -3, `pop_ins` +3, hovers 2,446 -> 2,446, seam jumps still
  zero, `terminal_links_rushed` +28 (timed +24) and
  `terminal_links_instant` 854 -> 867: ends whose exact pixel is now
  recovered drawing a few pixels from their terminal instead of on it
* `build_ms` 326,690 -> 350,831 (+7%), a single run each on the
  holder's machine; an alternating A/B on the three local files put
  the walk at 1.05, 0.99 and 1.04 of the previous engine, inside the
  run-to-run spread, and the code runs the successor function a few
  hundred extra times per file against the matcher's tens of thousands

The contradiction line needs reading with care, since it is the
regression alarm. The newly pinned links are the 16,539 that were
matched pairwise below a join, before the join existed, when their
shell had no source: the pill-stream and roster lockstep passes prune
only pinned members' candidates, so those links were made on geometry
alone, with none of the lockstep defence the rest of the corpus's pill
links had. The walk cannot mis-pin a right link -- a pill shell's
position is an exact orbit point, so the state it derives is whatever
the positions say -- it can only pin a link, right or wrong, and then
the roster vote can score it. Forty-eight contradictions among 16,539
links made without the defence (0.29%) against 92 among 2.9 million
made with it (0.003%) is the defence's absence showing, and those 48
are the population the vote was built to catch.

`--describe-links` settles what they are (`6b2cacd-links.txt`, against
`4f02142-links.txt`, the last archived tally, at 89; the three between
`4f02142` and `f9d3e7c` were never classed):

| class | `4f02142` | `6b2cacd` |
| --- | --- | --- |
| pairwise +2 | 21 | 42 |
| pairwise -2 | 4 | 12 |
| stitched +2 | 38 | 48 |
| stitched -2 | 6 | 7 |
| pairwise ±3 | 6 | 13 |
| stitched ±3 | 7 | 11 |
| everything else | 7 | 7 |

Forty of the fifty-one new contradictions are ±2-step, twenty-nine of
them pairwise links: the ±1-member identity shift along a dense
same-bradian stream that the skew study named as the cross-list excess
(each member worth two steps), on links made pairwise below a join
without the lockstep defence. The commonest single shape is a link
advancing four steps where the pill's roster elected two. Nothing
outside the ±2/±3 classes moved, and the per-replay spread is the
same handful-per-log the baseline shows, so this is the known error
population made visible, not a new one made. Spending the count is
the next dial: a second lockstep pass over links a join has just
pinned, unlinking or re-matching a pinned link whose advance the
roster contradicts.

## The contradiction sweep -- `fe3f825`

The fixture file's section "Spending the vote" has the mechanism: once
every pin is in, a link whose step advance contradicts the advance the
pill's own statements elected over its record pair is undone, both
shells keeping their pill and their states, and the stitching,
residual and membership passes run once more over the freed pieces
under the election. Nothing to sweep on any local file; the corpus,
at 140, is the measurement, and the question was how many of the
freed pairs the second round would settle rather than pop.

Corpus, `fe3f825-report.txt`, `fe3f825-audit.txt` and
`fe3f825-links.txt` against `6b2cacd` (443 files, zero failures, same
corpus):

* `links_pill_contradicted` 140 -> 14 (`rate` 0.000027 -> 0.000003),
  the alarm column's record; `links_pill_vouched` +7
* `shells_unlinked` 12,000 -> 11,955; `shells_matched_forward` +58;
  `terminals_matched` 1,625,669 -> 1,625,764 (+95, every type up:
  `pillbox_damage` +49, `tank_hit` +14, `explosion` +12,
  `shell_falls` +12, `base_damage` +8)
* `links_shell` 8,163,171 -> 8,163,134 (-37): 126 links undone, 89
  remade or replaced by the second round, the rest becoming an end
  and a start -- `shells_stream_birth` 930 -> 1,014, the freed starts
  with a pill and states drawn from the muzzle, `shells_visual_joins`
  1,209 -> 1,222, `terminals_unseen_pillbox_source` +45
* `links_pill_unpinned` 2,772 -> 2,836: the sweep runs after the
  membership claims, so a chain the second round joins below a
  membership claim is not walked again; a small debt the next dial
  can take with it
* Audit: `pop_outs` 28,335 -> 28,277, `pop_ins` 26,823 -> 26,776,
  `pops_paired_forward` 3,058 -> 3,017, `pops_paired_backwards`
  1,236 -> 1,230, hovers 2,446 -> 2,451, `terminal_links_rushed` +11,
  seam jumps still zero
* `build_ms` 350,831 -> 359,429 (+2.5%): the extra reference build on
  every file, the second joining round on the files with something
  to sweep

Where the vote indicted a link, the second round found a better story
for most of the pairs, and the ledger says the stories were better:
fewer unlinked shells, more terminals of every kind, fewer pops of
every kind. That is the vote earning its keep as an authority rather
than a meter.

The 14 left standing are all stitched links, in five replays; six of
them are one chain in `20020911~1f7b70` joined across four records
against the roster at every hop, and three are 4-tick hops in
`20010326~fc6a01`, a fast-ring log. Every one was remade in the
second round by a stitch or dilated join whose gate consulted the
reference -- but that reference is keyed by record time, and on a fast
ring two snapshots share a time, so a one-hop and a composed two-hop
span write the same key, last writer winning, the quirk the reference
builder's own comment left as measured. `score_pill_links` keys by
snapshot index for exactly that reason. Keying the joining passes'
reference by index too is the obvious next look, and would either
close the remaining 14 or show them to be something else.

## A base is damaged only by tank shells -- `223c457`

A rule from the owner that the engine had never been told: an `An` is
always a tank shell's, a pillbox shot never damages a base. The base
terminal was built like any other object box, so a pill shell whose
orbit crossed a base tile could take the `An` as its fate, and a pill's
F4 with no shell-list position could be count-forced onto one. Both
are now refused before any geometry (`terminal_takes_pillbox_shell`,
in the shared terminal matcher and in the orbit entry test that serves
the unseen-shot edges), and the diagnostics name the refusal `weapon`,
beside `direction`, the other kind-based veto. The change is a single
field test per candidate, so no timing comparison is given.

Corpus, `123fc81-report.txt`, `123fc81-audit.txt` and
`123fc81-links.txt` against `fe3f825` (443 files, zero failures, same
corpus; `123fc81` is the docs commit on top of the engine commit
`223c457`, engine identical, and a fresh run of `fe3f825`'s engine on
this machine first reproduced the archived report's `content_hash`):

* `terminals_matched` 1,625,764 -> 1,625,782 (+18): `base_damage`
  61,368 -> 61,321 (-47, the pill matches released), `tank_hit`
  237,818 -> 237,875 (+57), `pillbox_damage` +6, `explosion` +2
* `terminals_unseen_tank_source` 77,958 -> 77,999 (+41),
  `terminals_unseen_pillbox_source` 167,506 -> 167,493 (-13): with no
  pill source competing, the freed base hits are count-forced onto
  the tank shots that fired them
* unexplained terminals (the census total) 75,256 -> 75,210 (-46);
  `shells_unlinked` 11,955 -> 11,945; `shells_matched_forward` +18;
  `flow_components` 133,252 -> 133,282
* `links_pill_vouched` +7, `links_pill_unvouched` -8;
  `links_pill_contradicted` 14, the same fourteen links
* Audit: `pop_outs` 28,277 -> 28,259, `pop_ins` 26,776 unchanged,
  `pops_paired_forward` 3,017 and `pops_paired_backwards` 1,230
  unchanged, hovers 2,451 unchanged, `terminal_links_rushed_timed`
  13,163 unchanged (static +16, instant -1), seam jumps still zero

The base-damage census says where the 47 went. Every `P` class under
`base_damage` is gone -- `orbit_miss:P` 240, the `end_continued` and
`end_claimed_other_fate` `P` classes 71 between them, `timing_lead:P`
17, `window_expired:P` 14, `timing_lag:P` 5, `edge_unforced:P` 2 --
and `weapon:P` 226 takes their place: base hits whose nearest story
was a pill shell now say so outright. The `T` and `?` classes grow by
the difference (`ray_miss:T` 123 -> 198, `end_claimed_other_fate:T`
1,296 -> 1,316, `end_continued.short+clps:T` 1,536 -> 1,553,
`window_expired:T` 168 -> 178, `no_candidate` 960 -> 965): with the
pill shell struck off, the tank shell that was second-nearest is
named, and its own constraint with it. On the tank-hit side
`end_continued.short+reb:P` 1,162 -> 1,128 and `edge_unforced:P` 132
-> 125 are the pill shells that had been continued onto a base and
now end on the tank hit they were always aimed at.

Every coverage axis moves in the rule's favour and no truth axis
moves against it, which is what a fact about the game rather than a
tuning should look like. The fixture's share is in
[`interpolation_tests.md`](interpolation_tests.md).

## A turning tank's shell carries the nibble's sector -- `1623cbb`

Osterwald's claim that a shell can be listed under a direction other
than its `5d` nibble is true, and the list is the wrong side: the list
direction is the tank's facing from one shell update before the shot,
the nibble and the shell's velocity are from the shot itself, and
whenever the turn crossed a sector boundary inside that update the
shell flies the
nibble's sector while staying listed a sector off for life
(FORMAT.md's fourth Bolo bug, evidence in FORMAT.notes.md
[E:shell-birth-sector], `7751f9a-shell-sector.txt`). Run through the
`fe3f825` engine those shells linked forward as well as any, but only
2.7% got a birth against 98.8% for exact-match fresh shells, and 24.6%
ended as pop-outs against 1.8%: every tank hit refused for direction,
since the `FC` packet carries the true sector, and single sightings
aiming their terminal ray a sector off. A fresh muzzle shell listed one
sector from a same-record fire nibble while the sender's header facing
changed now carries the nibble as `sector`; the label stays
`direction`, which consecutive restatements share, and every place a
direction becomes geometry reads the sector.

Corpus, `1b22d57-report.txt`, `1b22d57-audit.txt` and
`1b22d57-links.txt` against `123fc81` (443 files, zero failures, same
corpus; `1b22d57` is the docs commit two above the engine commit
`1623cbb`, engine identical):

* `terminals_matched` 1,625,782 -> 1,626,390 (+608): `tank_hit`
  237,875 -> 238,130 (+255), `explosion` +156, `pillbox_damage` +98,
  `base_damage` +86, `shell_falls` +13
* `shells_from_tank` 655,721 -> 657,959 (+2,238), `shell_births`
  +2,236, `shells_with_birth` +14,974 down the chains;
  `terminals_unseen_tank_source` 77,999 -> 77,313 (-686): the fires
  that used to be count-forced onto a nearby impact as unseen shots
  now claim the shell they fired, and the impact that shell reaches
* `shells_unlinked` 11,945 -> 11,543 (-402), `shells_matched_forward`
  +620, `flow_components` 133,282 -> 132,772
* unexplained terminals (the census total) 75,210 -> 75,276 (+66):
  the 686 unseen attributions withdrawn exceed the 608 impacts
  matched, so about seventy impacts that had been credited to an unseen
  tank shot stand open, since the shot was seen after all and its shell
  ends elsewhere. That is the honest reading; the phantom attribution
  was never drawn
* `links_pill_contradicted` 14, the same fourteen; `links_pill_vouched`
  unchanged; every pill count within 3
* Audit: `pop_outs` 28,259 -> 27,639 (-620), `pop_ins` 26,776 ->
  24,528 (-2,248, a birth being the muzzle rather than a pop),
  `pops_paired_forward` 3,017 -> 3,010, `pops_paired_backwards` 1,230
  -> 1,224, hovers 2,451 -> 2,448, `terminal_links_rushed_timed`
  13,163 -> 13,188, seam jumps still zero

Three headline records at once -- forward matching, unlinked shells,
terminals matched -- and the drawn-motion audit's pop columns with
them. The census moves as the mechanism says: `tank_hit:direction:?`
340 -> 301, the unknown-kind ray misses down in every class as the
shells gain a tank source, and the `T` classes up by the shells now
named. The pop-in figure is the visible one: over two thousand shells
that used to appear from nothing a few pixels ahead of a tank now
leave its barrel.

## A dilated candidate outlives the on-schedule consensus -- `30ea4ef`

The fixture doc's section of the same name has the scene: a stalled
recorder clock puts a pill's whole roster nine steps on in an
eight-tick pair, every true continuation dilated, and a neighbouring
bradian's ordinary four-step hop lands in a trailer's quantisation
box. Ambiguity propagation trusted the alias alone, the constraint
pass pruned the true dilated candidate against it, and the roster
vote then evicted the alias too, leaving the observation orphaned and
its stale provenance minted as a stream birth. The constraint pass now
leaves a dilated candidate alone when it shares no state with the
target; narrowing on agreement stands.

Corpus, `30ea4ef-report.txt` and `30ea4ef-audit.txt` against
`1b22d57` (443 files, zero failures, same corpus; the input hash
alternates between two values across the archive as it did between
`6b2cacd` and `123fc81`, with the file count and every unaffected
line identical):

* `shells_matched_to_snapshot` 8,163,146 -> 8,163,198 (+52),
  `shells_unmatched_forward` 27,825 -> 27,772 (-53),
  `shells_unlinked` 11,543 -> 11,536 (-7), `flow_components`
  132,772 -> 132,729
* `shell_births` 1,629,687 -> 1,629,650 (-37), all of it
  `shells_from_pillbox` (971,728 -> 971,691): `shells_stream_birth`
  1,014 -> 989 (-25) and `shells_unseen_pillbox_birth` 3,534 -> 3,521
  (-13), the phantoms the scene drew from the muzzle; `shells_visual_joins`
  1,221 -> 1,201 (-20); `shells_with_pillbox_source` +91 and
  `links_no_pill_source` -72, provenance carried down the chains the
  links now complete
* `terminals_matched` +1 (`pillbox_damage` +2, `shell_falls` +1,
  `tank_hit` -2), `terminals_unseen_pillbox_source` 167,501 ->
  167,499
* the truth axis moves the right way: `links_pill_vouched` 2,917,120
  -> 2,917,330 (+210), `links_pill_unvouched` -31,
  `links_pill_unpinned` 2,836 -> 2,801 (-35), `links_pill_contradicted`
  14 unchanged; `roster_votes_passed` 563,044 -> 563,197 (+153) with
  `stood_down` -117 and `unvoted` -26 -- the chains that now run
  through pin more sources, so more elections can be held
* Audit: `pop_outs` 27,639 -> 27,586 (-53), `pop_ins` 24,528 ->
  24,513 (-15), `pops_paired_forward` 3,010 -> 3,002, backwards pops
  1,224 unchanged; `rush_links` 7,476 -> 7,472 and
  `rush_links_timed` 1,534 -> 1,530, hovers 2,448 -> 2,450; seam
  jumps still zero. `rate_links_steady` 0.966810 -> 0.966807: the
  new links land mostly in the 2.2-2.5 px/tick bucket (+46, against
  +28 in 1.8-2.2 and -11 in 2.5-3.0), a link made under a clock lie
  being re-timed by the smoother a shade fast

Three headline records at once, by the smallest margins in the table;
every other column within a handful. The change is exactly as wide as
the scene that motivated it: about fifty stalled-clock volleys across
443 logs, each losing a pop-out and a phantom birth.

## Distance order scored -- `ee2f432`

No engine change: this commit adds `score_pill_order`, a third truth
axis beside vouched/contradicted (see the fixture doc's "What the
numbers mean"). Every live shell of one pill advances one orbit step
per sender update, so between two statements the pill's shells keep
their order of distance from it -- a trailer never passes its leader
while both fly. The scorer reads that off final state for every pair
of one pill's shells whose links land in one later snapshot, needing
no pinned step, so it also covers the pairs the lockstep passes skip.
A flip counts as inverted only beyond what the positions can lie by
(the spread of the orbits' distance-to-step mapping across bradians,
about three pixels, plus any chained-offset uncertainty on an unpinned
member); a flip within that is blurred -- closer than two live shells
of one pill can be, a pill firing no faster than every two or three
steps, so one of the pair's positions or provenances is wrong.

Corpus, `ee2f432-links.txt` (443 files, zero failures; the input hash
is `30ea4ef`'s, and every line the earlier report has is byte-identical
-- the row above repeats `30ea4ef`'s cells, § marking the two audit
columns carried rather than re-measured):

* `pairs_pill_order` 8,621,797; `pairs_pill_order_kept` 8,621,598;
  `pairs_pill_order_inverted` **191** (`rate` 0.000022);
  `pairs_pill_order_blurred` 8 -- same-pill pairs closer than two
  rightly placed shells can be, eight corpus-wide
* the 191 scenes fall on 169 distinct record pairs: one wrong link
  often crosses two or three stream-mates at once

Read by mechanism (the `order_class` tally splits by which link was a
stitch; the scenes were bucketed further by hand):

| mechanism | scenes |
| --- | --- |
| trailer's stitch advances further than the interval allows | 64 |
| leader's stitch lands on a shell with no orbit states | 52 |
| leader's stitch advances 1-3 steps while the trailer's pairwise link advances 6+ | 44 |
| both links stitched | 11 |
| leader's stitch has zero advance | 6 |
| both links pairwise | 13 |

So 177 of 191 involve a stitch. In 64 of the 65 trailer-stitch scenes
the leader's pairwise link advanced a plausible two or three steps for
the interval while the trailer, at step one or two in 38 of them, was
stitched six to fifteen steps on across the same pair: the dilated
join, which exists to let a late-stamped chain head sprint, accepting
a jump the pill's own stream-mate in the same shell list refutes. The
44 short-advance leader stitches are the mirror. Both share one root
cause -- a stitch whose advance disagrees with a same-pill pairwise
link over the same snapshot pair -- which the residual lockstep
reference only catches when the pill's roster is unanimous. The 52
stateless landings are a different failure: the leader's chain is
stitched onto a shell carrying no orbit states at all, a few pixels
on, while the trailer passes it; the likeliest reading is a leader
that died unrecorded and a stitch that claimed an unrelated shell.
The 13 pairwise scenes are the case a distance-order veto in the
pairwise matcher would refuse: twelve on different bradians with no
common advance, where the lockstep pass stood down and cost let the
trailer jump past, several on jittered pairs (three ticks carrying
four and eight steps).

None of it is fixed here. At 191 in 8.6 million pairs the drawn
overtakes are rare, and the alarm is now in the report to keep them
so; the fixture's three are pinned in the test suite. If the count is
ever worth chasing, the order is: stitch advance must agree with a
same-pill pairwise link over the same pair (about 108 scenes, likely
the 11 both-stitched too); refuse a stitch onto a landing no surviving
orbit can place (52); the pairwise distance-order veto (13). The 14
contradicted links are all stitched as well, so the first may clear
some of them.

## The sender's lockstep -- `8a54fd8`, measured, reverted

The fixture doc's section of the same name has the change: a client
steps every shell of every pill firing at it in one update pass, and
the `cb1fd5d` measurement (`cb1fd5d-cross-pill.txt`) found no pair in
the corpus where two pills of one sender elected different advances,
so both vote sites were made to lend the sender's advance -- one
pill's election, or the pooled election where none passed -- to every
pill of the sender that could not elect its own, with the stitching
and residual reference composing the sender's hops the same way. Two
corpus runs, then reverted; no row in the headline table, as for
`4d5feb8`.

Corpus, `8a54fd8-report.txt` and `8a54fd8-audit.txt` against
`30ea4ef` (443 files, zero failures, same corpus and input hash; the
order columns against `ee2f432-links.txt`):

* the truth axis moves by more than every earlier dial together:
  `links_pill_vouched` 2,917,330 -> **3,339,459** (+422,129),
  `links_pill_unvouched` 2,200,175 -> 1,778,138, `rate_links_pill_vouched`
  0.570067 -> **0.652543**; `links_pill_contradicted` **14 unchanged**;
  `links_pill_unpinned` 2,801 -> 2,532 (-269). `roster_votes_lent`
  286,749, out of `unvoted` 1,730,908 -> 1,480,776 (-250,132) and
  `stood_down` 184,057 -> 147,474 (-36,583); `passed` 563,197 ->
  563,189
* the distance-order alarm falls: `pairs_pill_order_inverted` 191 ->
  **179** (-12), `blurred` 8 -> 7, over 8,621,382 pairs (-415)
* two terminal-side records and the unlinked record move on:
  `terminals_matched` 1,626,391 -> 1,626,438 (+47: `tank_hit` +18,
  `pillbox_damage` +15, `shell_falls` +13, `explosion` +1),
  `rate_terminals_matched` 0.835573 -> **0.835597**;
  `shells_unlinked` 11,536 -> **11,528** (-8)
* the cost: `shells_matched_to_snapshot` 8,163,198 -> 8,163,126 (-72),
  so `shells_matched_forward` -25 net of the terminals and the
  forward-matched rate 0.997171 -> 0.997169, two millionths under
  `30ea4ef`'s record; `shells_visual_joins` 1,201 -> 1,166 (-35, the
  lent advance deciding same-ray stories the matcher used to draw
  without believing); `shell_births` +40, all pill-side --
  `shells_stream_birth` 989 -> 1,008 and `shells_unseen_pillbox_birth`
  3,521 -> 3,541 -- with `shells_with_pillbox_source` -177 and
  `links_no_pill_source` +174: some chains lost a link and the
  provenance below it, their freed starts minted as births
* Audit: `pop_outs` 27,586 -> 27,611 (+25), `pop_ins` 24,513 ->
  24,545 (+32), `pops_paired_forward` 3,002 -> 3,037 (+35) -- the
  shape of a chain broken in two, the same shell popping out and back
  in -- backwards pops 1,224 -> 1,225; `hover_links` 2,450 -> 2,484
  (+34), `rush_links` 7,472 -> 7,473; `rate_links_steady` 0.966807
  -> 0.966834, the 1.5-1.8 bucket -175 and 2.2-2.5 -134 against
  1.8-2.2 +151; seam jumps still zero

So the lent votes are doing two things at once. Where they veto a
crossing the pairwise cost had accepted, the chain re-forms on the
right stream-mate: the inversions, the terminals and the unlinked
count all say so, and 422 thousand links are now vouched by a
statement roster rather than a cost margin. Where they veto a link
nothing replaces, the chain breaks: about 70 links across 443 logs,
each a pop-out, a pop-in and a phantom birth. The contradiction
column sitting at 14 says the surviving links agree with the vote;
it cannot say whether the ~70 broken ones were crossings or true
links vetoed by one of the 0.23% of lent advances the measurement
found landing nowhere. The report now carries
`shells_sweep_unlinked` / `shells_sweep_rejoined` so the next run can
say how many of the breaks are the contradiction sweep's and how many
the matcher's own pruning; the fixtures have none of either. Three
records move on by small margins and one is returned by two
millionths; the truth axis moves by a tenth of its range.

The next run (`8212c0c-report.txt`, `8212c0c-audit.txt`: the counters
only, every other line byte-identical to `8a54fd8`) apportions them.
`shells_sweep_unlinked` 142, `shells_sweep_rejoined` 63: the sweep
now undoes 142 links and the second round links 79 of the freed
starts to nothing. At `fe3f825` the sweep undid 126 and left 37
broken (89 remade or replaced, a slightly wider count than rejoined,
which asks only whether the freed start was linked again). So the
lent reference adds about 16 indictments and about 42 permanent
breaks, which is most of the 72 links lost; the rest is the matcher's
own lent pruning. Read against the measurement, the breaks are the
expected residue rather than a fault: a link the sender's statements
contradict whose stream-mate's true landing was never recorded or
never pinned has nothing to rejoin to, and by the project's own rule
an unmatched pop is safer than a drawn crossing. The number to watch
is the 79.

The audit's `build_ms` 339,778 -> 380,698 (+12%) was the change's
running cost. Profiled on the fast-ring fixture, the reference
builder had more than doubled its share -- scoring every pill's
roster through a Map of advances, and writing every pill's span in
full where the sender's span carried the same number -- and the
matcher's vote was pinning every target against every sparse pill
afresh on each of its passes over a pair. Scoring by roster gaps into
an array, writing a pill's span only where it diverged from the
sender's, and caching the pinned landings per pair (`d1a9a21`)
brought the fixture overhead against `8f55e62` from 8-24% down to
about 5%, inside run-to-run noise, with both reports byte-identical.

Reverted with that in hand. The reading: the sender's lockstep is
true, and the vote could use it, but what it buys is almost entirely
on the meter -- 422 thousand links vouched by a statement roster that
were drawn exactly the same way before -- while what it changes in the
drawing is a few dozen scenes each way across 443 logs, a wash, plus
a chain broken for good wherever a lent advance vetoed a link nothing
replaced. That is not worth its weight in the two most intricate
functions of the engine, nor the build time. The engine and the pinned
counts are back at `8f55e62`; the measurement tool, [E:sender-lockstep],
the corpus runs and the report's two sweep counters stay. If the
vouched-link meter's blind third is ever worth closing, the cheap
form is to let the scorer alone consult the sender's advance, so the
meter sees what the engine does not act on.

## The two logs of one game -- `fadf3e9`, measurement only

The ten games of `fixtures/pairs/` were logged on two machines at once,
and the two logs of each carry the same ring records byte for byte
([E:two-recorders]); only the stamps differ, each machine's clock at
the moment the packet arrived. `tools/audit-paired-reconstruction.cjs`
builds both logs of each pair, aligns them record by record with the
compare tool's alignment, and compares every shell observation's
story: its successor or fate, its birth, its weapon, and the roster
election over its pair. Where the two builds disagree, the stamps
decided it, not the packets. This is evidence of a different kind from
the roster vote and the distance-order scorer, which are the matcher's
readings of its own output: agreement here proves nothing, since both
builds read near-identical input, but a disagreement is a scene where
a few ticks changed the matcher's mind. `fadf3e9-paired-audit.txt`
lists every one.

Each link is binned by how its own stamped duration differs between
the two logs: jitter (four ticks or fewer, the matcher's tolerance),
delay (more, up to the 50-tick window; median 8 ticks, at most 38), or
a stall (beyond the window). No terminal ever sat in another sender's
record -- the shooter's machine reports its own shells' impacts -- so
the cross-sender bin the tool keeps is empty. Observations within 100
ticks of either end of the shared stretch are left out.

Over the ten pairs, 190,593 snapshots and 129,251 shell observations:

* forward stories: agree 128,410 (99.35%; 361 of them both silent),
  A abstains 189, B abstains 157, conflict 457
* jitter: 127,572 links, 400 disagreements (0.31%): 219 conflicts,
  181 abstentions. 47 of the 400 have identical stamps on their own
  link and were decided by a neighbour's stamps in the same component
* delay: 1,570 links, 332 disagreements (21%)
* stall: 71 links, every one an abstention on the stalled side; no
  conflicts, and nothing joined across a stall on both sides
* births: 48,055 agree, 262 A only, 291 B only. Weapons: 90,637 agree,
  139 attributed on one side only, 5 conflicts (a pill against its
  neighbour one square over, in two scenes)
* roster elections: 31,893 compared, 90 differ, every one a passed
  election against a stood-down or unvoted one; no election ever
  settled on two different advances

The 457 conflicts by shape: 167 successor against successor, mostly
two shells of one list swapping successors; 147 the same kind of fate
at two different terminals (pillbox_damage 63, shell_falls 31,
explosion 31, tank_hit 18, base_damage 4); the rest a fate on one side
against a successor on the other.

What it says. Under the jitter regime the matcher is stable to three
parts in a thousand, and the 400 jitter scenes are the marginal
decisions worth reading, each balanced on the tolerance. Under the
delay regime the two logs genuinely disagree about timing and one link
in five flips, which is the cost of a late packet, not of the matcher.
The vote never elects two advances, which is what keying it by the
roster promised; it differs only in whether it passed, as which
members hold a terminal candidate moves with the stamps. Nothing was
changed on the strength of this; the scenes are for reading.

**The delayed link is one missed burst, and it shows from one log**
(`d6d9225-paired-gaps.txt`, the tool's `--gaps`). Ring records arrive in
bursts, one per cycle, so the widest gap between consecutive records
of any sender inside a link's span is normally one ring cycle: it is
one cycle on 84% of jitter links and never more than 1.5 on 99.4%. On
every delay link the log that stamped the link longer shows a widest
gap of 1.5 to 2 cycles (two cycles on 42%, more on a further 15%)
where the other log shows one cycle over the same span, and the stamp
difference itself clusters at half a cycle to one cycle: the packet
missed a burst and came with the next. A stall detector reading one
log -- the widest whole-stream gap inside the link at least 1.5 cycles
-- fires on 83% of delay links (91% of those that flip) and on 3.4% of
jitter links; at two cycles, 46% and 0.4%. What it could do with the
knowledge is less clear: on delay links the early side abstains more
often than the late side (54 to 40), so the late stamp is not simply
where the matcher fails, and of the 238 delayed conflicts 58 have the
late side taking a fate the early side gives to a successor against 21
the other way. Only under a stall proper (beyond the window) is the
picture one-sided: all 71 abstentions are the late side's. The lead,
untried: a record that arrives after a gap of two cycles or more could
be re-stamped a cycle earlier before matching, and this audit would
say whether the two builds then agree more.

## A stall of the ring subtracted from the link that spans it -- `c09e9e3`

The fixture doc's section of the same name has the change: every gap
of two ring cycles or more between consecutive records of any sender
is read as the ring held up, and the pairwise matcher's duration is
the stamps' interval less the excess accumulated between its two
records (`stall_excess_by_record`); drawing, terminal arrival and the
stitching passes keep the stamps. Built against the paired audit
above, where it took the two builds' disagreements from 803 to 633.

Corpus, `c1c07c1-report.txt` and `c1c07c1-audit.txt` against
`30ea4ef` (443 files, zero failures, same input hash; the order lines
against `ee2f432`, which added them without moving a matching metric):

* coverage: `shells_matched_forward` 9,789,589 -> **9,792,518**
  (+2,929, every one off `shells_unmatched_forward`), `shells_unlinked`
  11,536 -> **10,069** (-1,467), `terminals_matched` 1,626,391 ->
  **1,627,327** (+936: `shell_falls` +411, `tank_hit` +279, `explosion`
  +232, `pillbox_damage` +61, `base_damage` -47),
  `rate_terminals_matched` 0.835573 -> **0.836053**,
  `rate_shells_unlinked` 0.001175 -> **0.001026**. Every headline record
  moves on.
* the drawn audit's identity lines with it: `pop_outs` 27,586 ->
  **24,657** (-2,929), `pop_ins` 24,513 -> 22,744, `pops_paired_forward`
  3,002 -> 2,088, `pops_paired_backwards` 1,224 -> **737** (-40%),
  `rate_pop_outs` 0.002810 -> 0.002512
* the truth axes split: `links_pill_contradicted` 14 -> **12**, but
  `pairs_pill_order_inverted` 191 -> **285** (+94 over 8,623,761 pairs;
  `blurred` 8 unchanged), `links_pill_unpinned` 2,801 -> 2,894,
  `rate_links_pill_vouched` 0.570067 -> 0.569960
* the drawn speed goes the wrong way: `rate_links_steady` 0.966807 ->
  0.964066, some 23,000 links moved out of the 1.8-2.2 px/tick bucket
  into the slow ones (`link_speed:1.5-1.8` +11,190, `1.0-1.5` +8,903,
  `0.5-1.0` +1,770, `0.0-0.5` +1,083), `hover_links` 2,450 -> **5,303**;
  rushes flat (`rush_links` +12, `terminal_links_rushed` +206)
* `shells_with_birth` +2,105, `shells_unseen_pillbox_birth` 3,521 ->
  3,045, `terminals_unseen_pillbox_source` -294,
  `terminals_unseen_tank_source` +251, `shells_visual_joins` 1,201 ->
  1,171, `flow_components` +1,366

Reading. The identity side is what the pairs promised: links refused
or mis-taken across a stall are now joined to the nearer restatement,
and the backwards pops -- the vanish-and-reappear-behind shape -- fall
by two fifths. The two lines that worsen are the two limits named when
the change was made. The slow links are the drawing keeping the
stamps: a link the matcher now reads as one cycle of flight is still
drawn over the two the recorder stamped, at half speed, and the
smoothing passes do not take it up; the fix is to hand the drawn
timeline the same de-stalled clock, or to slide the chain across the
stall the way a late head is slid. The order inversions are the stall
the single log cannot place: a stall upstream of the sender delays
its packet with the sender's simulation running on, so the contents
did advance the two cycles the stamps say, and the shortened duration
then favours a trailing shell as the successor. The pairs never show
that kind, since it reaches both recorders alike. The one instrument
that can tell the two kinds apart from one log is the roster vote,
which elects the advance in orbit steps whatever the stamps claim:
letting the elected advance, rather than the gap, set the duration of
a stalled pair would keep the gain and give back the inversions. Both
are follow-ups; the change stands as measured.

Followed up on the pairs before the next corpus run (the fixture doc's
section has the design): reading every stalled link's drawn distance
against the two intervals shows the two stall kinds about half and
half, so a stalled pair now carries both readings and each candidate
is scored against the one it fits better, with the stamps the upper
bound; and a floor of six ticks on the excess keeps a fast ring's
jitter from reading as stalls (the two-player fixture had 27% of its
pairs stalled under the cycle rule alone). On the pairs that takes the
gain further than the single reading did and leaves the order
inversions where they were.

## A stalled pair carries two readings -- `fb4bd12`

The fixture doc's section of the same name has the change: a pair
that spans a stall of the ring is scored under both readings of its
interval, the sender's cadence and the stamps, each candidate against
the one it fits better, the stamps the upper bound; and the stall
excess must clear six ticks, so a fast ring's jitter is not read as
stalls. Built against the pairs after the `c09e9e3` run above showed
the single reading half wrong.

Corpus, `738c79a-report.txt` and `738c79a-audit.txt` against `30ea4ef`
(443 files, zero failures, same input hash), with the `c09e9e3`
single-reading run (`c1c07c1-*`) in the middle column:

* coverage, further than the single reading on every line:
  `shells_matched_forward` 9,789,589 -> 9,792,518 -> **9,793,741**
  (+4,152 on the baseline, every one off `shells_unmatched_forward`),
  `shells_unlinked` 11,536 -> 10,069 -> **9,708**, `terminals_matched`
  1,626,391 -> 1,627,327 -> **1,628,960** (+2,569: `shell_falls` +1,108,
  `pillbox_damage` +625, `tank_hit` +470, `explosion` +326,
  `base_damage` +40 where the single reading had lost 47),
  `rate_terminals_matched` 0.835573 -> 0.836053 -> **0.836892**,
  `rate_shells_unlinked` 0.001175 -> 0.001026 -> **0.000989**. Every
  headline record moves on again.
* the truth axes come back: `pairs_pill_order_inverted` 191 -> 285 ->
  **188** (`blurred` 8 -> 7), `links_pill_contradicted` 14 -> 12 ->
  **14**, `rate_links_pill_vouched` 0.570067 -> 0.569960 -> 0.570032,
  `links_pill_unpinned` 2,801 -> 2,894 -> 2,746
* the drawn audit: `pop_outs` 27,586 -> 24,657 -> **23,434** (-15% on
  the baseline), `pop_ins` 24,513 -> 22,846, `pops_paired_backwards`
  1,224 -> 737 -> **856** (the one line the second reading gives some
  of back, still -30% on the baseline), `rate_pop_outs` 0.002810 ->
  0.002387
* the drawn speed, now read apart: `links_stalled` 19,582, of which
  11,742 draw steady over the stamps (the stall before the sender:
  the contents advanced the whole interval) and 545 would over the
  cadence; `hover_links` 2,450 -> 5,303 -> 4,824, of which 1,766 span a
  stall; `rate_links_steady` 0.966807 -> 0.964066 -> 0.965741 and
  `rate_links_steady_unstalled` **0.966621**, within 0.0002 of the
  baseline's steady rate; `rate_hover_links_unstalled` 0.000375
  against the baseline's 0.000300; rushes unchanged
* `flow_components` 132,729 -> 134,095 -> 130,489, `shells_with_birth`
  +1,640, `shells_unseen_pillbox_birth` 3,521 -> 3,010,
  `terminals_unseen_pillbox_source` -399, `shells_visual_joins` 1,201 ->
  1,146

Reading. The two kinds of stall were the whole story of the `c09e9e3`
regression: with both readings on the table the inversions return to
the baseline and every coverage line goes further than the single
reading took it. On the corpus the stall before the sender is the
commoner kind, six links in ten, not the half the pairs showed. The
slow-drawn links that remain are the other kind drawn over the stamps,
as the tanks around them are; the unstalled hover rate a quarter above
the baseline (0.000375 against 0.000300, some 600 links) is the one
drawn-speed cost not yet named, presumably chains that continue past a
stalled link. The backwards pops give back 119 of the 487 the single
reading had recovered. The change stands as measured.

## The pair after a stall carries two readings as well -- `40e92f6`, `92043d9`, `800f57c`

The fixture doc's section of the same name has the change and the
scene: a record delayed by a stall may state contents from before
its stamp, and when the record after it arrives on time that pair's
contents span the stamps plus the stall. So the pair after a stall
is scored against the stamps and against the stamps plus the stall
that delayed its first record, the mirror of the stalled pair's two
readings, the longer reading bounding the flight and the birth
windows; and a pair that both follows a stall and spans one, four
readings, is scored against all four (`92043d9`) where the first cut
(`40e92f6`) kept the two extremes; and a chain head stated by the
delayed record slides forward before smoothing (`800f57c`), for the
drawn cost the first two runs showed.

Corpus, `800f57c-report.txt` and `800f57c-audit.txt` against
`fb4bd12` (`738c79a-*`; 443 files, zero failures, the input hash
differing only by path -- the `fb4bd12` engine re-measured from a
worktree reproduced `738c79a-report.txt` line for line, and its
drawn audit was re-run from the worktree under the current tool for
the after-stall lines). The matching lines are the same at `92043d9`
and `800f57c`, a drawing-only commit; the two-extremes cut
(`40e92f6`) is in the middle column where it differs:

* coverage: `shells_matched_forward` 9,793,741 -> 9,794,797 ->
  **9,794,878** (+1,137 on `fb4bd12`, every one off
  `shells_unmatched_forward`), `shells_unlinked` 9,708 -> 9,131 ->
  **9,078**, `terminals_matched` 1,628,960 -> 1,629,847 ->
  **1,629,905** (+945: `pillbox_damage` +385, `shell_falls` +249,
  `tank_hit` +209, `explosion` +64, `base_damage` +38),
  `rate_terminals_matched` 0.836892 -> **0.837378**,
  `rate_shells_unlinked` 0.000989 -> **0.000925`. Every headline
  record moves on.
* the truth axes: `pairs_pill_order_inverted` 188 -> 196 -> **173**
  (`blurred` 7 -> 6). The two-extremes cut's eight new inversions
  were double stalls read at the extremes, a pill's leader six steps
  on and its trailer fifteen over one pair; with the stamps and
  their mirror on the table the count ends fifteen under the
  baseline. `links_pill_contradicted` **14**, unchanged;
  `rate_links_pill_vouched` 0.570032 -> 0.570081, `links_pill_unpinned`
  2,746 -> 2,623.
* the drawn audit (`fb4bd12` -> `92043d9` -> `800f57c`): `pop_outs`
  23,434 -> **22,297** (-4.9%), `pop_ins` 22,846 -> 21,738,
  `pops_paired_forward` 2,074 -> 1,982, `pops_paired_backwards` 856 ->
  **854**, `hover_links` 4,824 -> 4,543 -> **4,566**
  (`hover_links_stalled` 1,766 -> 1,620: a stalled link whose other
  end used to be refused is now drawn to its true successor),
  `rate_links_steady` 0.965741 -> 0.966205 -> **0.966639**,
  `rate_links_steady_unstalled` 0.966621 -> 0.966973 -> **0.967409**,
  `rate_pop_outs` 0.002387 -> 0.002271
* the drawn cost, and its repair: `rush_links` 7,473 -> 7,808 ->
  **7,365** (`rush_links_timed` 1,531 -> 1,866 -> **1,423**,
  `link_speed:3.0+` 7,493 -> 7,829 -> 7,385). The audit's new
  after-stall lines (`links_after_stall` 19,397 -> 19,448,
  `rush_links_after_stall` 35 -> 87 -> **48**, `rate_rush_links_unstalled`
  0.000913 -> 0.000948 -> **0.000898**) blamed only 52 of the 335 extra
  rushes on the record after the stall; diffing the rushed links
  between the two engines found the rest were smoothed chains, three
  and four links at 3.1 to 3.6 px/tick, out of a head stated by the
  delayed record: the smoother anchors on the head, whose stamp is
  late by the whole stall, and spreads the catch-up over the chain.
  `800f57c` slides such a head forward along its raw first link
  before smoothing, as the tail slide does, and the rushes end 108
  under the baseline with the steady rate up on both readings.
* `shells_with_birth` +1,681, `shells_from_tank` +668,
  `shells_from_pillbox` +248, `shells_unseen_pillbox_birth` 3,010 ->
  1,981 and `shells_stream_birth` 977 -> 908 (heads that used to pop
  in after a stall and be claimed from orbit membership now arrive
  through their F4-backed chain), `terminals_unseen_pillbox_source`
  -105, `terminals_unseen_tank_source` -170, `shells_visual_joins`
  1,146 -> 1,115, `flow_components` 130,489 -> 128,735

Reading. The delayed record's stale statement is the whole story.
Before, the pair after a stall of the first kind refused every
continuation, so the delayed record's statements ended their chains
and started new ones; the stitching and residual passes then joined
across them, mostly rightly (the coverage they leave behind is the
thousand shells here), sometimes to the wrong end (the motivating
scene's dilated join, the backwards pops), and each stale statement
left as an orphan fragment was a rival for the joins. With the pair
read both ways the pairwise matcher links straight through, the
fragments never arise, and the joining passes have fewer pieces and
fewer wrong choices: pop-outs, hovers, order inversions and the two
builds' disagreements on the pairs (693 -> 625) all fall together.
The rushed links went the other way at first, and were not the
drawing keeping the stamps, as assumed when the after-stall counter
was added, but the smoother spreading a late head's lie along its
chain; with the head slid the drawn speed beats the baseline on
every line. The change stands as measured.

## A tank hit is tried against the statements the sender held -- `ee502e9`

The fixture doc's section of the same name has the change and the
scene: the `FC` hit is sent by the machine simulating the shell
([E:hit-reporter]) and found against its own picture of the victim,
the statement that had reached it, which the ring can leave a round
or two behind the box this log states. A tank-hit terminal on
another player's tank now carries the victim's previous two
statements; the packet box keeps first refusal, a stale-box match
carries a penalty above the match margin and must lie at least one
shell update ahead of the statement, and the effect follows the box
the shell entered.

Corpus, `ee502e9-report.txt` and `ee502e9-audit.txt` against
`800f57c-*` (443 files, zero failures, the same input hash):

* coverage: `shells_matched_forward` 9,794,878 -> **9,798,295**
  (+3,417, every one off `shells_unmatched_forward`, 22,483 ->
  19,066), `shells_unlinked` 9,078 -> **7,953** (-12.4%),
  `terminals_matched` 1,629,905 -> **1,633,352**: `tank_hit` 238,807
  -> **242,287** (+3,480), the other classes -33 between them
  (`explosion` -21, `base_damage` -5, `shell_falls` -5,
  `pillbox_damage` -2) where a shell now takes its tank hit and
  leaves the terminal another shell had been given; `links_shell`
  8,164,973 -> 8,164,943 (-30), `terminals_unseen_tank_source`
  77,261 -> 77,126, `flow_components` 128,735 -> 127,895.
  `rate_shells_matched_forward` 0.997710 -> **0.998058**,
  `rate_shells_unlinked` 0.000925 -> **0.000810**,
  `rate_terminals_matched` 0.837378 -> **0.839149**. Every headline
  record moves on, `tank_hit` by more than the stale-box walk's
  +1,552.
* the truth axes: `pairs_pill_order_inverted` **173**, `blurred` 6,
  `links_pill_contradicted` **14**, `links_pill_unpinned` 2,597, all
  unchanged; `links_pill_vouched` 2,918,600 -> 2,918,768,
  `rate_links_pill_vouched` 0.570086 -> 0.570119.
* the drawn audit: `pop_outs` 22,297 -> **18,880** (-15.3%,
  `rate_pop_outs` 0.002271 -> 0.001923), `pops_paired_backwards` 854
  -> **832**, `pops_paired_forward` 1,982 -> 1,970, `hover_links`
  4,566 -> **4,552**, `rush_links` 7,365 -> **7,327** (`rush_links_timed`
  1,423 -> 1,385), `link_speed:2.2-2.5` 78,988 -> 78,036 and
  `2.5-3.0` 9,905 -> 9,534 with `1.8-2.2` +1,259: `rate_links_steady`
  0.966639 -> **0.966797**, `rate_links_steady_unstalled` 0.967409
  -> **0.967567**. The stall lines are within a few of the baseline
  either way.
* the wrong way: `terminal_links_rushed` 69,692 -> 69,708 (+16;
  `terminal_links_rushed_timed` 13,212 -> 13,237, +25;
  `terminal_links_static` 55,617 -> 55,609; `instant` 863 -> 862),
  `pop_ins` 21,738 -> 21,759 (+21), against 3,480 more hits and
  3,417 fewer pop-outs.

Reading. A stale box is the sender's honest collision shape, and
the shells it fates were the pop-out class almost to a one: a shell
that vanished from its sender's lists a round after its last
statement, with an `FC` in the right direction on a box its ray
missed by a tank's width. The class breakdown says so -- every gain
is `tank_hit`, and the other terminals give up only the thirty-odd
shells a wrong fate had been assigned in the hit's place. The cost
is 25 more timed-rushed terminal links over 1.6 million -- the
ordinary capped arrival, a hit record stamped closer behind the
shell's last statement than the box's distance takes at 2 px/tick,
so the drawn link is compressed into the stamps' gap; about a fifth
of the stale-box hits on a corpus sample are capped at all, the
same shape as any other terminal link -- and 21
more pop-ins, the trailer of a two-shell line taking over the
continuation its leader had before the leader took its hit. The
first cut, offering the boxes to every hit including the sender's
own and letting a stale box start at the statement, was measured on
the fixture only (its section in the fixture doc); the corpus was
run on the restricted form alone. The change stands as measured.

## A tank's shells advance in lockstep -- `422354a`, `e46dd5e`

The fixture doc's section of the same name has the change and the
scenes. `422354a` is measurement only: `score_tank_order`, the
distance-order axis for a tank's own shells, reading same-sector pairs
along the sector's centre line (across headings the order is only nearly
kept -- a full-speed S-turn on road can put the later shell a tile
further out in the first shell's last second -- so the axis stays where
the invariant is exact). `e46dd5e` is the engine change: the sender
moves every shell it simulates 2 px in one update pass, so between two
of its statements every one of its tank's live shells has flown the same
distance, and `enforce_tank_lockstep_candidates` prunes the candidates no
common pixel advance supports, standing down when none exists. It is the
tank-side, pruning-only cousin of the pill lockstep, and deliberately
not the lent-vote sender lockstep of `8a54fd8`: it only ever removes a
candidate another of the tank's own shells contradicts, and lends
nothing.

Corpus, `e46dd5e-report.txt` and `e46dd5e-audit.txt` against
`ee502e9-*` (443 files, zero failures, the same 9,817,361 shell
observations, 1,946,439 terminals and 9,914,126 tank points; the
`input` line differs because it hashes the corpus directory's path,
not its contents, and this run was made from the directory 22 earlier
archived runs used). No pre-enforcement corpus run exists for the tank
order axis, so its 330 is a first reading, not a delta.

* coverage: `shells_matched_forward` 9,798,295 -> **9,798,519**
  (+224; `shells_matched_to_snapshot` +370, `shells_matched_to_terminal`
  -146), `shells_unmatched_forward` 19,066 -> 18,842, `shells_unlinked`
  7,953 -> **7,864** (-89), `rate_shells_matched_forward` 0.998058 ->
  **0.998081**, `rate_shells_unlinked` 0.000810 -> **0.000801**. Two
  records move on.
* the terminal record is given back: `terminals_matched` 1,633,352 ->
  1,633,206 (-146: `pillbox_damage` -109, `shell_falls` -19,
  `base_damage` -16, `explosion` -1, `tank_hit` -1),
  `rate_terminals_matched` 0.839149 -> 0.839074;
  `terminals_unseen_pillbox_source` +18, `terminals_unseen_tank_source`
  +34. `shell_births` 1,630,659 -> 1,630,541 (-118, `shells_from_tank`
  -119), `shells_visual_joins` 1,111 -> 1,089 (-22), `flow_components`
  127,895 -> 127,325 (-570), `links_no_pill_source` +393.
* the truth axes hold: `links_pill_contradicted` **14**,
  `pairs_pill_order_inverted` **173**, `blurred` 6, `links_pill_unpinned`
  2,597, all unchanged; `links_pill_vouched` -2. The new axis:
  `pairs_tank_order` 1,860,783, `inverted` **330**, `blurred` 17,
  `rate_pairs_tank_order_inverted` 0.000177 -- nine times the pill
  axis's rate, on a fifth of its pairs.
* the drawn audit: `pop_outs` 18,880 -> **18,656** (-224, exactly the
  forward gain), `pop_ins` 21,759 -> **21,507** (-252),
  `pops_paired_backwards` 832 -> **783** (-49, a record),
  `pops_paired_forward` 1,970 -> 1,951; `terminal_links_rushed` 69,708
  -> 69,690 (`timed` 13,237 -> **13,226**, `static` -5, `instant` -2);
  `rush_links` 7,327 -> 7,324; `hover_links` 4,552 -> 4,559 (+7);
  seam jumps still zero.
* the wrong way: `rate_links_steady` 0.966797 -> 0.966694,
  `rate_links_steady_unstalled` 0.967567 -> 0.967509. The speed
  histogram says how: `1.0-1.5` 20,286 -> **21,257** (+971), `1.5-1.8`
  +141, `1.8-2.2` 7,893,841 -> 7,893,361 (-480), `2.2-2.5` -231,
  `2.5-3.0` -35. The stall lines move with it: `links_stalled` 19,563
  -> 19,786, `links_stalled_steady` 12,639 -> 12,489,
  `links_after_stall_steady` 16,596 -> 16,508, `hover_links_stalled`
  1,612 -> 1,632.

Reading. The lockstep's one move is to refuse a hop another of the
tank's shells contradicts, and the histogram shows what those hops
were: the swap the fixture scene shows in miniature, where a record
stamped a dropped restatement late lets the leader's 2 px/tick hop onto
the trailer's true position outbid its own continuation. Refusing it
frees both shells, and the passes after the matcher rejoin them along
the truth -- 28 px in a "23-tick" gap, which the audit draws at 1.2
px/tick and books as unsteady. So 480 steady links become 1,100 slow
ones, and each rejoined chain retires a pop-out, a pop-in and a birth:
-224, -252, -118, in step. The steady rate falls for the same reason
the inversions stand: the audit and the matcher both read the interval
off the stamps, and here the stamps are the thing that is wrong. The
146 terminals are the cost, all but `tank_hit`, and `pillbox_damage`
three quarters of it: a shell whose short hop the lockstep refused had
been reaching a pill's damage record from where the hop put it, and
its rejoined chain arrives elsewhere or later; whether the record is
now unclaimed rightly or wrongly the corpus cannot say, and the pairs
fixtures, where the two recorders can, read the same change as
conflicts 393 -> 376 and agreed births +28 for -9 terminals. Read on
the pairs, the nine had one shape -- a stream leader that had hit its
pill, whose only continuation candidate was the spurious short hop
onto its successor's restatement, setting the roster's advance to the
short reading -- and `7290254` makes a shell that may have died
abstain from the vote (the fixture doc's section has the scene and
the pairs' numbers: terminals back to one above the pre-lockstep
state, the paired audit keeping most of the conflict gain). Its
corpus run is the next section, and it corrects the reading above:
the thousand slow links were not rejoined chains drawn at a late
stamp's clock. They were rosters forced onto the short reading of a
stall-widened interval by a dead leader's spurious hop, drawn slow
because the stamps were right; with the leader abstaining they are
gone, and the steady rate ends above `ee502e9`'s.

The 330 inversions are the number the pass was aimed at and did not
touch on the fixtures, for the reason the fixture doc gives: in every
scene the true continuations lie outside the interval's readings, so
the swapped hops were the only candidates each shell had and there was
nothing to prune among. The common advance the lockstep sees is the
interval's true length -- every tank shell agreeing on 28 px says the
gap was 14 ticks -- and the change that would reach those scenes reads
the clock off the tank's shells rather than pruning under it. That is
the next dial, and it is a change to the readings, which the stall
sections above spent three commits getting right.

## A shell that may have died abstains from the tank lockstep -- `7290254`, measured at `364174f`

The fixture doc's section has the scene. `364174f` is the docs commit
on top of `7290254`; the engine is `7290254`'s.

Corpus, `364174f-report.txt` and `364174f-audit.txt` against
`ee502e9-*` (the pre-lockstep state) and `e46dd5e-*` (the lockstep
without the abstention), 443 files, zero failures, the same input:

* coverage, `ee502e9` -> `e46dd5e` -> `364174f`: `shells_matched_forward`
  9,798,295 -> 9,798,519 -> 9,798,472 (+177 on the pre-lockstep state,
  47 under `e46dd5e`; `to_snapshot` 8,164,943 -> 8,165,313 -> 8,165,087,
  `to_terminal` 1,633,352 -> 1,633,206 -> 1,633,385), `shells_unlinked`
  7,953 -> 7,864 -> 7,890, `rate_shells_matched_forward` 0.998058 ->
  0.998081 -> 0.998076, `rate_shells_unlinked` 0.000810 -> 0.000801 ->
  0.000804. Both move on from `ee502e9`; `e46dd5e` keeps the two
  records by a hair, having paid 146 terminals for them.
* the terminal record is back, and then some: `terminals_matched`
  1,633,352 -> 1,633,206 -> **1,633,385** (+33 on `ee502e9`, in every
  class: `pillbox_damage` +15, `tank_hit` +6, `base_damage` +5,
  `explosion` +5, `shell_falls` +2), `rate_terminals_matched` 0.839149
  -> 0.839074 -> **0.839166**; `terminals_unseen_pillbox_source`
  166,982 -> 167,000 -> 166,978, `terminals_unseen_tank_source` 77,126
  -> 77,160 -> 77,117. `shell_births` 1,630,659 -> 1,630,541 ->
  1,630,661, `shells_from_tank` 658,295 -> 658,176 -> 658,297,
  `shells_visual_joins` 1,111 -> 1,089 -> 1,095, `flow_components`
  127,895 -> 127,325 -> 127,421.
* the truth axes: the pill side is byte-identical to `ee502e9`
  (`links_pill_contradicted` **14**, `pairs_pill_order_inverted` **173**,
  `blurred` 6, `links_pill_unpinned` 2,597, `links_pill_vouched`
  2,918,768, where `e46dd5e` had -2). The tank axis: `pairs_tank_order`
  1,860,783 -> 1,860,367, `inverted` 330 -> **338**, `blurred` 17. The
  abstention leaves a dying leader's roster both its stories, and cost
  takes the crossing in eight more pairs.
* the drawn audit: `pop_outs` 18,880 -> 18,656 -> 18,703, `pop_ins`
  21,759 -> 21,507 -> 21,613, `pops_paired_backwards` 832 -> 783 -> 801,
  `pops_paired_forward` 1,970 -> 1,951 -> 1,948; `hover_links` 4,552 ->
  4,559 -> **4,544**, `rush_links` 7,327 -> 7,324 -> 7,321
  (`rush_links_timed` 1,385 -> 1,382 -> 1,379); `terminal_links_rushed`
  69,708 -> 69,690 -> 69,695 (`timed` 13,237 -> 13,226 -> 13,230,
  `static` 55,609 -> 55,604 -> 55,605, `instant` 862 -> 860 -> 860);
  seam jumps still zero.
* the steady rate turns round: `rate_links_steady` 0.966797 ->
  0.966694 -> **0.966863**, `rate_links_steady_unstalled` 0.967567 ->
  0.967509 -> **0.967634**. The histogram: `1.0-1.5` 20,286 -> 21,257
  -> 20,339, `1.5-1.8` 151,347 -> 151,488 -> 150,973, `1.8-2.2`
  7,893,841 -> 7,893,361 -> **7,894,522** (+681 on `ee502e9`), `2.2-2.5`
  78,036 -> 77,805 -> 77,865; `links_stalled_steady` 12,639 -> 12,489
  -> 12,691, `links_after_stall_steady` 16,596 -> 16,508 -> 16,698,
  `hover_links_stalled` 1,612 -> 1,632 -> 1,605.

Reading, and a correction. The `e46dd5e` entry read its thousand new
slow links as rejoined chains drawn at a late stamp's clock, the truth
booked as unsteady because the stamps were wrong. The abstention shows
that was not what they were: with dying leaders out of the vote the
`1.0-1.5` bucket comes back to within 53 of `ee502e9` and the steady
bucket ends 681 above it. Those links were rosters the dead leader's
spurious hop had forced onto the short reading of a stall-widened
interval, drawn slow because the stamps were RIGHT, and the 146
terminals were the leaders continuing past their hits. So the
lockstep's genuine effect is the part that survives the abstention:
177 more forward matches, 63 fewer unlinked shells, 177 fewer pop-outs,
146 fewer pop-ins, 31 fewer backwards pops, 8 fewer hovers, 33 more
terminals in every class, the pill axes untouched, and a steady rate
above where it started. The eight extra tank inversions are the
abstention's price, the same trade the roster vote's symmetric
election made for pills: a doubtful voter can veto an alias it would
not lead, but cannot cast the deciding vote, and where it was in fact
alive and right the pairwise cost now has to find the story alone.
The change stands as measured. The pill-side pass carries the same
structure without the abstention (its roster vote has it); the fixture
doc's section records a measurement of adding it, a wash on the pairs,
and leaves it for a section of its own.

## A shot is spent only where it could have flown -- `8289438`

The fixture doc's section has the two faults and the fixture numbers.
`081d8aa` (the same-tick writeback) moved no rate on either fixture and
was not run on the corpus alone; the run archived here is the head with
both fixes, and the reading below assigns its movement to `8289438`.

Corpus, `8289438-report.txt` and `8289438-audit.txt` against
`364174f-*`, 443 files, zero failures, the same input:

* the books: `terminals_unseen_pillbox_source` 166,978 -> **165,516**
  (-1,462), `terminals_unseen_tank_source` 77,117 -> 77,112. Impacts
  with no story of any kind, matched or unseen, 68,959 -> 70,416: 1,457
  attributions leave the ledger, funded on the old code by a shot fired
  after the impact or by a costlier same-source shot that a cheaper
  sibling's spend had left as the only story. Nothing is drawn
  differently for that; an unseen attribution names a source and draws
  no shell.
* coverage, and a gain the accounting did not promise:
  `terminals_matched` 1,633,385 -> **1,633,395**, all ten of them
  `pillbox_damage` (544,780 -> 544,790), `rate_terminals_matched`
  0.839166 -> **0.839171**; `shells_matched_forward` 9,798,472 ->
  **9,798,481** (`to_terminal` +10, `to_snapshot` -1),
  `shells_unmatched_forward` 18,889 -> 18,880, `shells_unlinked` 7,890
  unchanged, `rate_shells_matched_forward` 0.998076 -> 0.998077;
  `flow_components` 127,421 -> 127,432, `shells_with_birth` -2,
  `pairs_tank_order` -1 with the 338 inversions, and the pill axes
  (14 contradicted, 173 inverted, 2,918,768 vouched), byte-identical.
* the drawn audit: `pop_outs` 18,703 -> **18,694**, `pop_ins` 21,613 ->
  21,614, backwards and forward pairs unchanged at 801 and 1,948;
  `terminal_links_rushed` 69,695 -> 69,699 (`timed` 13,230 -> 13,232,
  `instant` 860 -> 862); `hover_links` 4,544 and `rush_links` 7,321
  unchanged, `rate_links_steady` 0.966863 unchanged, the `1.8-2.2`
  bucket 7,894,522 unchanged, seam jumps 0.

Reading. Phase three only marks terminals, so on one pass it can move
nothing but the unseen lines, and on the fixtures nothing else moved.
The ten terminals and nine pop-outs can only come from the second
pass: where the contradiction sweep fires, the resolver runs again
over the freed pieces, and a terminal the first pass had given to a
shot fired after it was closed to every observed shell on the second
-- a fate group admits only terminals with no match and no unseen
source. So ten pillbox hits that an observed shell's forced terminal
could explain were being held by a shot that could not have made
them, and the shell popped out mid-air with its hit unexplained. The
four new rushed terminal links are those forced arrivals capped at
their event records, the shape every forced terminal has. The size
of the gain says how rare the sweep's second pass is, not how rare
the fault was: on a single pass the wrongly funded attributions cost
nothing drawn and closed nothing to a live shell, which is why both
fixtures' audits are byte-identical.

## Findings

* **The fixture's headline conclusions all survive the scale-up.** The branch
  line leads the branch point on every headline metric (0.975030 against
  0.961727, 0.008829 against 0.013738, 0.816566 against 0.791346); it was
  behind from `15770f0` to `8aa9506`; every record was held by `ffb7fd3` when
  the ten-run table closed (the branch line has since carried them further,
  per the table); and
  the pillbox-attribution regression and its repair are both there at full
  size. None of this was an artefact of one hand-picked replay.
* **The two confirmation-run claims reproduce exactly.** `c15ed26` differs from
  `86807e0` in one line, and `8aa9506` is identical to `37acbc7` in every line,
  across 443 logs. Those were the weakest claims in the fixture file -- a
  single replay can easily fail to exercise a difference -- and they now have
  113 times the evidence behind them.
* **`07b6bd9` goes the other way on the corpus.** On the fixture it lost two
  more terminals, continuing `d52f860`'s slide and leaving `63b2e71` holding
  the terminal record. On the corpus it *recovers* 61 terminals, and the class
  breakdown flips with it: `shell_falls`, `explosion` and `tank_hit` all gain
  where the fixture had them flat or losing. The fixture's "at the cost of two
  more matched terminals" does not generalise -- the one-sided bound is
  very slightly terminal-positive over 443 logs. It still ends below `63b2e71`
  on the terminal rate, by 39 terminals, so which commit holds the record at
  that point is unaffected.
* **`ffb7fd3` has no regression at corpus scale.** On the fixture it lost two
  `explosion` terminals, the sole blemish on the commit. Over 443 logs
  `explosion` gains 231 and every other class gains too. That two-terminal loss
  was noise in a single replay, and the commit's claim to be the first to gain
  on both axes at once is stronger than the fixture could show.
* **The `shells_with_birth` loose end resolves in the same direction, larger.**
  `shells_with_birth` rises 3,874 while `shells_from_tank` falls 66 at
  `ffb7fd3` -- the same counter-intuitive pairing the fixture file flagged for
  a look, at sixty times the magnitude, so it is not a small-sample effect. The
  question is unchanged and still worth answering in `build_shell_births`: an
  origin becoming uncertain does not cost a shell its birth, and apparently
  helps others find one.
* **One shell in the corpus has an origin and no birth, at v1.0.8 only.** The
  identity `shells_from_tank + shells_from_pillbox = shell_births` holds
  exactly at `07b6bd9` and `ffb7fd3` but is one short at `c15ed26`
  (1,611,363 against 1,611,362). It is a single observation in 9.8 million, and
  it is absent from the later states that carry the same `6a83ce0` birth code
  plus the branch work -- so the likeliest reading is a shell whose pillbox
  source is known but whose start point `6a83ce0` alone could not derive, since
  fixed by the branch. Worth one look at `build_shell_births`, not worth alarm.
* **`terminals_unseen_pillbox_source` does not return exactly to baseline.**
  The fixture shows 393 -> 424 -> 393, a clean round trip at `63b2e71`. The
  corpus shows 37,124 -> 39,222 -> 37,360: the repair recovers most of the
  regression but leaves 236 terminals more than the branch point had, and the
  figure then stays flat at 37,360/37,361 through `ffb7fd3`. The fixture's
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
  bracketed to `6c937e1` or `15770f0`, both named "Stuff". The corpus makes the
  regression far better characterised but does not locate it, since `6c937e1`
  was not among the ten commits measured.
* **The measured line ends at the stale-box walk, `0263483`**, the current
  head, with `b9db294` one section earlier holding every record in the
  headline table's four matching columns. (When this file first closed
  the current pair was `e8f0415`/`ffb7fd3`, later `c1d6625`/`6b4140d`,
  then the `8d310e3` guard
  run with `main` unmeasured past it. Since resolved: `main`'s HEAD was
  measured at `28fa3b0` and the line extended commit by commit -- see the
  headline table and the sections.)

<!-- Remember to update the "headline table" at top! -->
