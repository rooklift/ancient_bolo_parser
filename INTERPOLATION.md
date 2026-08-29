# Interpolation

How the viewer turns Bolo's sparse network restatements into smooth motion,
and how it decides which shell in one packet is "the same shell" in the next.
This is the broad-strokes map; the code itself (mostly `viewer/motion.js`)
carries the fine detail in comments, and `docs/interpolation_tests.md` carries
the measured history.

## The problem

A log is the recording player's incoming network traffic. Moving objects are
*restated* about four times a second, and nothing carries an identity:

- **Tanks and LGMs** restate absolute positions, so interpolation is just
  "join consecutive points" — the work is knowing when *not* to join them.
- **Shells** are the hard case. Each record restates every shell its sender
  is currently simulating, as anonymous lists with no IDs. Lists gain and
  lose entries at any restatement. The log never says "the shell at time T
  is the shell at T+5"; we have to infer it.

Everything below feeds *drawing only*. State reconstruction stays
packet-exact; interpolation is a rendering layer that looks ahead to the next
trustworthy restatement.

## Tanks and LGMs

`build_tank_positions`, `build_tank_directions` and `build_lgm_positions`
build per-player tracks of timestamped points, each marked `continuous` or
not with respect to the previous point. Continuity breaks on death, quit,
dying flags, parachute/walking transitions, and LGM tank entry — joining
across those would invent motion between two different object states.

Interpolation windows are deliberately bounded:

- **Position**: 25 ticks (half a second). Beyond that the path between two
  points is untrustworthy — hold the last known point rather than draw a
  made-up line through lag.
- **Tank facing**: 50 ticks. A turn rate is bounded in a way an unseen path
  is not; corpus measurement showed gaps of 26–50 ticks imply no turn faster
  than turns seen inside the trusted window, while past 50 the shorter way
  round stops being a safe guess.
- An LGM whose status flips to "in tank" gets animated to the tank if his
  last position was close enough, supplying the endpoint the log omits.

## Shells: the general machinery

Shells travel at exactly 2 px/tick, which is the backbone of everything.
Matching runs per *client* (per player slot): shell simulation can migrate
between machines mid-flight, but joining across clients would create
convincing false identities, so a migration renders as one shell vanishing
and another appearing.

For each client, consecutive shell-list snapshots are matched
(`match_shell_snapshots`). The candidate targets for a shell in snapshot N
are:

1. **Shells in snapshot N+1** — same 4-bit direction required; cost is how
   far the displacement deviates from `duration × 2 px/tick`, plus an
   angular error against the shell's heading. The 4-bit logged direction
   only defines a sector, so a finer heading is continuously refined from
   the whole trusted track (fixed origin at the weapon source or first
   sighting, not the noisy first displacement).
2. **Terminals** — authoritative shot-ending events converted to geometry:
   `shell_falls` (FB) is an exact terminal point; tank hits (FC), pillbox
   damage (9n), base damage (An) and shot-attributable explosions (7T) are
   16 px boxes the shell centre must enter. Tank-hit boxes are tested
   against the *interpolated* tank track at the shell's arrival time, since
   the tank may have moved since the packet's stated position. Identical
   terminals are interchangeable and carry multiplicity (capacity), since
   two shells can die in one tile in one interval.

Assignment is deliberately conservative: only **mutually best** pairs are
accepted, and only when each wins by a margin (`SHELL_MATCH_MARGIN`) over
its alternatives. An unmatched pop is safer than a smooth but invented path.
A layer of tie-breaking rules handles the recurring ambiguities: a
restatement and an impact describing the same visual endpoint are treated as
equivalent rather than competing; impacts that arrive late are reserved for
the *leading* shell of a known weapon stream when a younger shell would
otherwise steal them; grazes (near-miss corner hits within quantisation
tolerance) never outcompete exact geometry.

### Shell birth (source attribution)

New shells are matched backwards to firing events:

- **Tank shots** (`5d`): candidate shells within range of the firing tank's
  position, in the right sector. The birth point is then refined against the
  interpolated tank track at the inferred firing time, which matters when a
  moving tank fires between position packets.
- **Pillbox shots** (`F4`): see below — these get the full orbit treatment.
  The F4's pill index is unreliable when the direction nibble reads 0
  (~25% name the pill one above the true firer), so direction-0 shots also
  try pill `n−1` as a fallback origin.

A shell with a known birth gets drawn from the muzzle onward
(`build_shell_births`), not just from its first restatement. Pill shots that
died entirely between restatements (an F4 with no shell ever seen) can still
claim strictly count-forced terrain explosions (`mark_unseen_pillbox_terminals`).

### Quantisation: why nothing is quite where it says it is

Only the *head* of a shell list carries an exact whole-pixel coordinate.
Each later member is a chained signed-byte offset from the previous member,
and each offset was quantised (arithmetic-shifted, i.e. rounded *down*)
independently from finer internal coordinates. So member `i`'s true
coordinate lies in the one-sided box `[reconstructed, reconstructed + i]`
per axis — never below the reconstruction. This `position_uncertainty` is
threaded through all matching: pillbox shells resolve the bound against
their discrete orbits, and tank shells at index 1+ are expanded into the
small set of integer position variants when tested against terminals.
Getting this bound right (one-sided, and applied to tank shots too) was
worth measurable accuracy; treating reconstructed positions as exact was
the bug that initially made the orbit data look like a regression.

## Pillbox shells: the exact simulation

The big recent win. Pillboxes fire in exactly **128 discrete directions**
(odd bradians 1, 3, … 255; bradian 0 = north, clockwise; 8 fine directions
per 4-bit coarse sector). The original integer simulation was recovered
*bit-exactly* from empirical data (`docs/pillbox_shell_algorithm.md`): an
8-bit truncated sine table, one round-half-up arithmetic-shift scaling
helper, a muzzle offset of half a tile, velocity of a quarter tile per tick,
and a 32-tick lifetime (8.5 tiles range). `viewer/pillbox_shell_orbits.js`
regenerates every orbit: for each bradian, the complete list of whole-pixel
positions the shell can ever occupy, plus its terminal (expiry) point.
`docs/pillbox-shell-orbits-compact.json` is the same data as a file.

This turns pillbox-shell matching from fuzzy geometry into hypothesis
filtering over a finite state space:

- A pillbox shell carries a set of **orbit states** — `(bradian, step)`
  pairs consistent with everything observed so far. Near the muzzle several
  fine directions overlap the same pixels, so the set starts plural and
  later restatements narrow it.
- A proposed continuation must be a *later step on one of the surviving
  orbits*, within the uncertainty bound. An empty result proves the
  continuation physically impossible — the strongest kind of negative
  evidence, unavailable before this data existed.
- Terminal matching walks the orbit forward point by point: an exact match
  for `shell_falls`, discrete shell-centre entry into the box for
  tile/object hits. This also sharpens impact timing and effect placement.
- The raw chained offset bytes between adjacent list members are themselves
  a constraint: for two shells from the same pill stream, an orbit
  hypothesis pair must reproduce the recorded bytes exactly
  (`refine_pillbox_orbits_from_shell_lists`), pruning states pairwise along
  the chain.
- When the surviving states all agree on one pixel, the shell's **exact
  true position** in the underlying simulation is recovered
  (`pillbox_orbit_pixel_x/y`) — usually there is only one possibility —
  and interpolation, headings and birth segments use that instead of the
  quantised reconstruction.
- Even when several same-stream predecessors are possible, the shared
  pillbox provenance and the union of orbit states propagate forward
  without claiming any one shell-to-shell identity, so a later frame can
  narrow the orbit and resume interpolation.

History note: the first attempt at using the orbit data made the statistics
*worse* (see the `ad6a3b6` era in `docs/interpolation_tests.md`), because
the table was being applied to non-head list members as if their coordinates
were exact. Once the quantisation bound was modelled — and made one-sided —
the branch beat the pre-orbit baseline on every headline metric.

## Rendering

At draw time (`shell_position_at` etc.), a render tick is answered by
binary-searching the relevant track/snapshot, verifying the stored state
still corresponds to the packet-exact object (guarding against
death/respawn races), and lerping toward the matched successor or terminal.
Matched terminals also retime their explosion/splash effects to the shell's
inferred arrival rather than the packet's timestamp. Birth segments draw
shells from the muzzle before their first restatement.

## Measurement

`tools/report-interpolation-rates.cjs` scores an engine build against a
fixture (and `tools/corpus.cjs` against a corpus): fraction of shells
matched forward, fraction unlinked (appeared and vanished unexplained —
the clearest failure signal), fraction of terminals explained, and
attribution counts. `docs/interpolation_tests.md` tracks these across
commits; the current state matches ~98.0% of shells forward, leaves ~0.8%
unlinked, and explains ~85% of terminals on the reference fixture. Every
change to matching should be judged against those numbers, watching for
trades between shell continuity and terminal matching.

## Known limits and open ideas

- **Tank shots are harder, but now provably tractable.** They fire from a
  moving, interpolated origin at an unknown tick, so there is no finite
  table of absolute positions to prune against. But corpus measurement
  (`tools/measure-tank-shell-bradians.cjs`, results in
  `docs/tank_shell_bradians.md`) proves tank shells run the same
  sine-table simulation as pillboxes, at all 256 integer bradians
  (pillboxes use only the odd 128), with the same round-to-nearest
  direction-nibble mapping: 96–98% of matched tank-shell chains are
  reproduced exactly by one of the 256 known integer velocity vectors,
  and the alternative-table controls lose by ratios of hundreds to one.
  So displacements between restatements can be pruned against that table
  much as pill shells are pruned against orbits, with only the origin's
  fine position left free. Today none of this is exploited in the
  matcher: tank shells get only the heading-refinement and uncertainty
  treatment.
- **Cross-client identity is never inferred.** A simulation migration draws
  as pop-out/pop-in by design.
- **Matching is greedy and local** — pairs of consecutive snapshots, mutual
  best with margins. Issue #15 proposes the alternative: a *global maximum
  parsimony* analysis assigning every shot-creation event (5d/F4) to a
  shot-fate event (FB/FC/9n/An/7T) over the whole file, then fitting the
  observed shell restatements to those constructed paths. Counts nearly
  balance corpus-wide, so the assignment is plausibly recoverable; open
  questions are path validity (a straight source-to-death line may pass
  through blocking objects) and load-time cost.
- Collision inference against terrain/objects currently only enters through
  terminal events; the orbit tables could in principle also *predict* where
  an unterminated pillbox shell must stop, which is only partially
  exploited today.
