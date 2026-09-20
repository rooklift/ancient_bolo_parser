> Hi! Don't bother looking at the rest of the repo, but solely at docs/pillbox-shell-orbits-compact.json
>
> Coarse direction 0 corresponds to north. Coordinates or vectors are given as [x, y] pairs. Negative Y values mean north of the origin, positive means south.
> What exact shot simulation algorithm could produce the data? The code was written circa 1990 and will likely be 16-bit at best, no floating point.

I'll start by looking at the data file.

* Listed docs and checked file size
* Previewed JSON head
* Summarized dataset structure
* Computed per-step deltas
* Estimate velocity per bradian
* Fit fixed-point linear model with floor
* Printed velocities and started offsets
* Tested velocity formula candidates
* Brute force angle offset and scale
* Fit with finer fixed-point resolutions
* Tested round-positive/trunc-negative rule
* Refit assuming truncation-toward-zero rendering
* Searched table+shift implementations

Found a strong candidate. Let me verify it reproduces the whole file exactly.

* Simulate and compare against full dataset
* Recovered the underlying sine table from the data

Let me confirm the unified "one rounding helper" formulation and dump the recovered table.

* Final verification of unified model

All 128 trajectories (4224 coordinate pairs) reproduce **bit-exactly**. Here's the algorithm.

## The model

Everything lives in an integer world unit = **1/16 of the JSON unit**. (If the JSON is pixels at 16 px/tile, the internal unit is 1/256 tile — i.e. a 16-bit coordinate split 8 bits tile / 8 bits sub-tile.)

**1. One 8-bit sine table, amplitude 128, magnitude-truncated**

```c
/* quarter table, 65 entries, 0..128; other quadrants by reflect + negate */
SIN[i] == (int)(128.0 * sin(i * 2*PI/256))     /* truncate toward zero, NOT round */
/*  0   3   6   9  12  15  18  21  24  28  31  34  37  40  43  46  48 ...
   ... 122 123 124 124 125 126 126 127 127 127 127 127 128            */
```

**2. One scaling helper — round-half-up via arithmetic shift**

```c
#define SCALE(dir, dist)  (((SIN[dir] * (dist)) + 64) >> 7)   /* >> is ARITHMETIC */
```

**3. Fire and fly**

```c
dir = bradian;                       /* 0..255, 0 = north, increasing clockwise */
opp = (dir + 192) & 255;             /* sin(θ-90°) = -cos θ  →  the Y component */

x = SCALE(dir, 128);   y = SCALE(opp, 128);   /* muzzle: 128 units = half a tile */
vx = SCALE(dir,  64);  vy = SCALE(opp,  64);  /* speed : 64 units/tick = ¼ tile  */

for (n = 0; n <= 32; n++) {          /* spawn point + 32 moves, then it expires */
    plot(x >> 4, y >> 4);            /* world → JSON/pixel units */
    x += vx;  y += vy;
}
```

Range = 128 + 32·64 = 2176 units = **8.5 tiles**. `positions[]` is the spawn point plus 31 moves; `terminal` is the 32nd move.

And the sprite index: `coarse_direction == ((bradian + 8) >> 4) & 15` (round-to-nearest of 16).

## Why it must be this, and not the obvious alternatives

Fitting a fixed-point accumulator to each orbit gives a **unique** velocity per bradian, quantised to 1/16 JSON unit — so the shell is *not* stepped by exact `4·sinθ`; it carries a pre-quantised integer velocity. The give-away is the rounding, which is asymmetric by **sign**, not by axis:

| bradian | component | exact 64·sin/cos | data |
|---|---|---|---|
| 1 | vx | +1.571 | **+2** (rounds up) |
| 255 | vx | −1.571 | **−1** (truncates) |
| 1 | vy | −63.981 | **−63** (truncates) |
| 127 | vy | +63.981 | **+64** (rounds up) |

That is exactly `(T + 1) >> 1` on a *signed* table value with an arithmetic shift — round-half-toward-+∞. It rules out:

- a `round(64·sin)` velocity table (58/256 components wrong) or a `trunc(64·sin)` one (58 wrong);
- any single amplitude + phase with uniform rounding — best possible is 98/128, and it's provably impossible: `vx(63)=64` forces scale ≥ 63.5 while `vy(63)=−1` forces scale < 61.1;
- `/2` instead of `>>1` — C's truncating division gives −61 where bradian 9 needs vy = −62;
- negating *after* the shift (`-SCALE(dir+64, ...)`) — that yields −64 where bradian 1 needs −63. The negation has to happen at the table lookup, which is what a quarter-table-with-sign-fixup does naturally.

The double reduction also pins the table down: the spawn offset is `SIN[dir]` and the velocity is `(SIN[dir]+1)>>1`, and the two sum to `SIN[dir]`, so **every table entry the file touches is uniquely recoverable** — all 128 of them come out equal to `trunc(128·sinθ)`, with `SIN[256-i] == -SIN[i]` and `SIN[128-i] == SIN[i]` holding exactly. (Only odd indices are exercised by this file; the 33 even quarter-table entries, `SIN[64] = 128` included, are inferred from the formula.)

The tidy part is that `dist = 128` makes `SCALE(dir, 128) == SIN[dir]` exactly, so the muzzle offset needs no rounding of its own — spawn and per-tick motion come from the same one-line helper, which is why the spawn looks "unrounded" and the velocity "rounded".

## Addendum (2026-09-20)

The transcript above is kept as it was written. The algorithm it recovered is what `viewer/pillbox_shell_orbits.js` implements, and re-running it against the file still reproduces all 128 orbits (4224 coordinate pairs) bit-exactly. Later work found the following corrections.

**The peak of the table is 127, not 128.** The table is a signed byte, so the one entry where `128·sin` reaches exactly 128, `SIN[64]`, is stored saturated as 127. The transcript's `SIN[64] = 128` was an extrapolation of the truncation formula to an entry this data never reads. It was settled from tank shells, which do fire the even bradians: an independently sourced copy of the original table is declared `SInt8` and reads 127 at the peak, and the replay corpus agrees — a shell fired due north (bradian 0) or due west (bradian 192) moves 63 world units per update, not 64 (over 1,030 logs, 2,344 north and 2,405 west chains fit only the 127 table, against 0 and 1 the other way). The corrected definition is

```c
/* quarter table, 65 entries, 0..127; other quadrants by reflect + negate */
SIN[i] == MIN(127, (int)(128.0 * sin(i * 2*PI/256)))   /* truncate toward zero, then saturate */
```

and the listing in step 1 ends `... 127 127 127 127 127 127`. Nothing else in the transcript changes: `dir` is always odd for pillboxes, so both lookups (`dir` and `dir + 192`) land on odd indices, and the 128 odd entries the transcript recovered are the entire set this code path can reach. See `docs/tank_shell_bradians.md`, "The peak of the table".

**Only odd bradians.** The file's 128 odd bradians are not a sampling artefact of this data set: pillboxes only ever fire odd bradians, eight fine directions per sector of the 16 the direction nibble reports (`docs/FORMAT.md`). The `dir = bradian` line in step 3 can be read with "always odd here" attached.

**The argument that pins each table entry down is misstated.** The paragraph beginning "The double reduction also pins the table down" says the spawn offset `SIN[dir]` and the velocity `(SIN[dir]+1)>>1` "sum to `SIN[dir]`". They do not (for bradian 1 that is 3 + 2). The entries are nonetheless uniquely recoverable, for a different reason. The velocity alone is ambiguous: `(T+1)>>1` maps both `T = 2v−1` and `T = 2v` to the same `v`, and every one of the 128 odd entries has such a twin. But the spawn offset is the *unhalved* entry, so the two candidates start one world unit apart and their 33 rendered samples diverge. Re-checked against the file: varying any single odd entry over −128..127 while holding the rest fixed, exactly one value reproduces every orbit that reads it, and that value is `trunc(128·sinθ)` in all 128 cases.

**Two tallies in the "ruling out" section did not reproduce.** Re-counted against the velocities the file fixes, a `round(64·sin)` velocity table gets 68 of the 256 components wrong, and so does `trunc(64·sin)` (34 of the 128 odd entries each, every entry being used twice), not 58. A search over a single amplitude and phase with one uniform rounding rule peaked at 76 of 128 orbits with both components right (ceiling, amplitude about 63.5), not 98. The transcript may have counted differently, and the conclusions stand — none of these alternatives fits — but its figures should not be quoted.
