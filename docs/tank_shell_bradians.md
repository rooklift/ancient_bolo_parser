# Tank shells run the pillbox simulation, at all 256 bradians

Pillbox shells were proven to follow a recovered integer simulation
(`docs/pillbox_shell_algorithm.md`): a truncated sine table, velocity
`(SCALE(d,64), SCALE(d+192,64))` per update, one update every two ticks,
positions rendered by `>>4` — but pills only ever fire the 128 odd
bradians. Emulation then suggested tanks can shoot at all 256 integer
bradians. This experiment tests, from the replay corpus alone, whether
tank shells follow the same simulation, and at which bradians.

## Method

`tools/measure-tank-shell-bradians.cjs` extracts every non-pillbox shell
chain the matcher links (3+ restatements) and asks, exactly: is there a
bradian `d`, a sub-pixel origin, and per-record update counts within a
small jitter of elapsed-ticks/2, that reproduce every observed pixel,
honouring the one-sided shell-list quantisation bounds? Candidate
bradians are gated to `direction*16 + [-8..15]`, the union of both
plausible nibble mappings. Controls: a `round(64·sin)` table, a
`trunc(64·sin)` table, and a half-velocity-every-tick cadence — each
differs from the recovered model in 58/256 velocity components. A 1-in-50
subsample is additionally tested against all 256 bradians to measure
coincidental fits, and failed chains are retried ungated.

"Slack" is per-observation jitter in the update count: slack 1 tolerates
±1 update (±2 ticks) of record-time vs simulation-time skew.

## Corpus results

443 replays, 802,503 chains, 586,186 analyzed (length ≥ 3).

**The recovered model explains almost everything.**

* consistent at slack 0 / 1 / 2: 55.1% / **96.2%** / **98.3%**
* confident tank-origin chains at slack 1: **97.8%** (513,272 chains)
* unknown-origin chains: 84.3% — the shortfall is expected, since this
  bucket contains unattributed pillbox shells and more mislinks
* consistency holds across chain length: 96.5% at length 3, 96.5% at
  10+ observations, where a false model could not survive

**Discrimination between models is one-sided.** Counting chains one model
explains and the other does not, at slack 1:

| comparison | recovered only | control only |
|---|---|---|
| vs round table | 89,651 | 155 |
| vs trunc table | 75,422 | 320 |
| vs every-tick cadence | 258,702 | 215 |

**Consistency is not coincidence.** In the all-256 subsample (11,857
chains), out-of-sector bradians fit only 1,158 times across ~2.75M
chain-bradian tests — a false-fit probability of ~0.0004 per bradian.

**Tanks use all 256 bradians.** Uniquely pinned chains land on 117,029
even and 123,479 odd bradians (65,248 / 67,046 under strict slack-0
pinning). Pills never fire even bradians; tanks do, constantly.

**The nibble mapping is round-to-nearest, as for pills.** Pinned offsets
`d - 16*nibble` are flat across [-8..+7] (~14–20k each). The dip at
offset 0 (9,651) is a pinning artifact, not an aim deficit: bradians
adjacent to a cardinal are nearly identical, so cardinal shots usually
retain two candidates instead of one.

## The residue, itemised

* **~2% nibble/bradian skew.** The unique-offset histogram has a tail at
  +8..+11 (3,394 chains), and the ungated retries of failed chains
  recover bradians almost exclusively at offsets −9..−12 (5,790 hits).
  Together: a symmetric ±(1..4)-bradian spill past the round window's
  edges. That is what firing from a turning tank would produce if the
  nibble and the shell's bradian are sampled a tick or two apart.
* **Simulation time dilation.** The dumped unexplained chains are
  straight lines at ~1.9 px/tick — consistently slightly *slow*, never
  fast. A sender whose simulation stalls under network load while record
  timestamps keep counting produces exactly this; slack 1 absorbs small
  amounts, long chains under sustained lag exceed it. The slack 1 → 2
  gain (+12,585 chains) is the same effect at moderate size.
* **Mislinks.** At least one dumped chain visibly curves; no shell does.
  These are matcher false-positives, and this tool is the first
  instrument that can see them — a chain no bradian can explain is
  either dilated time or a wrong identity.
* `no_model_s1` (fits nothing, controls included): 9,381 chains, 1.6%.

## Implications

* Tank-shell matching can adopt the pill-style hypothesis machinery:
  per-direction candidate velocity vectors from the recovered table
  (24 gated bradians), exact quantised arithmetic, and hard
  impossibility verdicts for proposed continuations — with the sub-pixel
  origin as the only free parameter, narrowing as the chain grows.
  **Since implemented** in `viewer/motion.js` (tank bradian states); it
  took all three headline interpolation metrics to new records at once —
  see the `c4bf83c` section of `docs/interpolation_tests.md`.
* A pinned bradian gives an exact heading, better than the current
  continuously-refined estimate, and an exact future track for collision
  and terminal prediction once the origin phase is bounded.
* The ±4 nibble skew means the direction gate should be the round window
  widened by four bradians either side, [-12..11], which is what
  `viewer/motion.js` uses (`TANK_BRADIAN_MIN_OFFSET` / `MAX_OFFSET`). The
  tool's own [-8..15] gate is the union of both nibble mappings, chosen
  before the round mapping was established; it covers the +8..+11 side of
  the spill but not the −9..−12 side, which is exactly where its ungated
  retries recovered their 5,790 hits.
* Chains no bradian explains are evidence of a mislink or time dilation,
  usable as a diagnostic on the matcher itself.
