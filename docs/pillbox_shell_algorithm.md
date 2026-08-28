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
