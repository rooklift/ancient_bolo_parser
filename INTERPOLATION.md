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

Drawing gets the same jitter treatment shells get, told far more
cautiously (`smooth_track_positions`). On a fast token ring the sender
samples an object once per packet at near-constant cadence, but the
receive stamps bunch (dt=1,3,1,3... around a true 2), so the raw lerp
oscillates between fractions and multiples of the true speed about ten
times a second — and the same regime re-states a moving object's
position verbatim, drawn as a freeze and a catch-up jump. A lying
stamp shifts an observation in *time*, which displaces it strictly
*along* its own path — and the path is sacred: a tank only ever moves
on one of its 16 facings, so a drawn straight run that bends even a
couple of pixels off its heading reads as impossible motion to a
player (an early chord-projection version of this pass produced
exactly that — a tank facing due east drifting gently south). So a
point is eligible only where the raw path through it is straight
within quantisation, every correction is a pure slide along the
point's own raw chord direction (added lateral deviation is zero by
construction, machine-checked), and the slide is capped by the local
raw speed times the largest stamp lie seen, so a parked tank cannot
creep toward its next journey. The pass engages only between
closely-spaced statements (gaps of a few ticks): at the corpus-normal
~12-tick cadence the stamp lie is under ten percent of a segment and
the residual wobble is mostly the tank's genuine acceleration — which
a one-point smoother cannot tell from jitter and would flatten into
stair-steps — so normal-cadence replays are left pixel-for-pixel
untouched, the same scoping that keeps the shell twin pass inert off
fast rings. Corrections land in fields only the drawing accessor
reads — matching's view of the tracks (tank-hit boxes, birth
refinement) stays on packet coordinates.
`tools/audit-track-motion.cjs` measures the result: on the fast-ring
fixture the pass removes over 90% of frozen-then-jump beats and cuts
drawn-speed wobble roughly in half, and it touches nothing at all on
the normal-cadence fixture.

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

Before any of that competition, verbatim re-sends are taken off the
table (`link_stale_restatements`). On a fast token ring (a two-player
low-latency game circulates the token every 2–4 ticks, against the
corpus-normal ~12) the sender's packet rate outpaces its shell
resampling, and over half of all closely-spaced statements restate the
previous record's samples byte-for-byte under a fresh receive stamp.
Zero displacement over positive time is impossible physics for a live
shell, so the pairwise matcher rightly refuses it — but left there, each
re-send seeds a parallel chain that divides the true statement stream
with the original and later starves and pops mid-air. The byte equality
that breaks the physics is itself proof of identity within a few ticks
(heads are exact; the same shell has provably moved, no stream-mate can
have arrived, and an orbit never revisits a pixel), so a verbatim pair —
members must repeat their chained offset bytes too — is linked as one
statement re-sent: identity, zero advance, hypothesis states copied
verbatim. The same fast-ring regime lands two sender packets inside one
recorder tick, so a zero-duration snapshot pair is matched rather than
skipped: record order still orders the statements, and the orbit tables
arbitrate without needing the clock.

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
The mirror case — a shell seen but its F4 lost to packet loss — is claimed
from orbit membership alone (`claim_unseen_pillbox_births`, after all
F4-backed and forced explanations have had first refusal): an origin-less
chain whose every observation lies on ONE live pill's orbit at strictly
increasing steps is that pill's shot. Two corroborated observations on an
anchored discrete track don't happen by accident; a single sighting is
claimed only exact and fresh from the muzzle, and if more than one pill's
story survives, none is claimed. The same pass claims births for heads
whose pill was already named by ambiguity propagation — which stream-mate
they are is unknown, but in every candidate story they flew from that
muzzle. The corpus's backwards-pop anatomy
motivated this: these were the shells popping in one fire interval behind
their dead stream leaders.

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
- Two live shells from one pill on one fine direction advance in lockstep
  — the sender moves every shell one step in the same update pass — so
  their step gap never changes while both are restated, the earlier shot
  stays ahead until it falls, and (every pill shell living exactly 32
  steps) birth order is fall order. Distance cost alone cannot see this:
  an interval compressed by record-time jitter makes the leader's short
  hop into the trailer's true position the cheapest candidate, and the
  two identities swap — drawn as the later shot overtaking the earlier
  one mid-air and falling first. The matcher therefore requires one
  common step advance to explain a candidate of every same-stream shell
  narrowed to the same single bradian
  (`enforce_pillbox_lockstep_candidates`), pruning candidates no jointly
  consistent story supports; when no common advance exists (a fall
  mid-interval, a dropped restatement) it stands down rather than guess.
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
shells from the muzzle before their first restatement. An arrival is
normally capped at the event record's time — an object impact's flash
belongs beside its authoritative state change, and the record drops the
shell from packet state — but a *shell fall* has no coupled state, so its
arrival stays on the 2 px/tick schedule even past the record: the splash
moves with it, and fall segments (the mirror of birth segments) carry the
sprite from the moment state loses it to the retimed splash. This is what
keeps early-record falls from drawing as rushed final links. Note the
retime is a knowing lie about the splash's time, not a recovery of it —
the sender-side fall happened before its record arrived — accepted
because the drawn timeline is already built from the restatement clock,
and a splash coinciding with the drawn shell beats a splash the shell
visibly hasn't reached.

Between matching and drawing there is a smoothing pass: jittered on-path
restatements are *absorbed* into their chain (with a temporal gate so a
trailing shell on the same segment is never claimed), and each chain is
drawn at constant velocity between its best-known anchors
(`smooth_shell_chains`) — sender timestamp jitter otherwise visibly
wobbles a large fraction of drawn links. A chain *head* is one of those
anchors, so a head whose record was received late escapes the smoothing
and draws its first link as a sprint: the punctual next restatement sits
far further along the flight than the stamp window carries at 2 px/tick.
The link's own drawn length is the sender's clock, so when it exceeds
the window by more than quantisation explains, the head's drawn position
slides forward along the link to where the shell truly was at the
stamped time (`slide_compressed_chain_heads`), and the birth segment
re-derives its span from the slid position so the pre-record flight
stays seamless. Drawing only — state, matching and terminal timing are
untouched. That temporal gate assumes the
sender's clock lags by at most a dozen ticks, and a worse spike used to
strand the restatement outside the chain that flies straight through it —
drawn as a jump backwards, a hover and a rush. For a pill shot the orbit
table overrules the clock in both directions
(`pillbox_absorption_states`, the same widen-in-time-only principle as
`pill_states_reachable`): an observation that is an exact orbit point, on
a bradian surviving at both ends of the stitch, at a step strictly
between their two, is a candidate whatever its timestamp claims — and one
the surviving orbits rule out is refused however well its geometry reads,
since with the orbit known it is provably some other shell, and the
temporal gate is never consulted. What the discrete evidence cannot
settle is which of two stream-mates is which: an angry pillbox fires
every five or six ticks, putting same-ray neighbours only two or three
steps apart, so a fragmented stream can drop several of them, each
individually consistent, into one snapshot of the gap. When more than one
observation in a snapshot qualifies, none is absorbed — the chain's own
restatement is among them, but nothing says which, and an unmatched pop
is safer than a smooth but invented path. (A rank-pairing rescue for
refused groups on consecutive snapshots was tried and measured a
corpus-wide null — consecutive stale records match each other into
fragments, so the configuration never arises — and was reverted; the
measurement docs carry the account.) A visually-joined observation
keeps counting toward a stitch's ambiguity, so a later overlapping
chain cannot mistake the thinned census for uniqueness. All of this holds for chained
list members as well as list heads — a wider quantisation bound just
admits several candidate bradians, which the shared-bradian and
strictly-between tests then narrow, usually to one, recovering the exact
pixel the offsets had lost.
Where identity is genuinely ambiguous but every candidate story draws the
same line (dense same-ray pill streams), a *visual join* draws the
continuation without believing it: the sprite flies on, but no identity,
birth, or fate propagates across the link.

## Measurement

`tools/report-interpolation-rates.cjs` scores an engine build against a
fixture (and `tools/corpus.cjs` against a corpus): fraction of shells
matched forward, fraction unlinked (appeared and vanished unexplained —
the clearest failure signal), fraction of terminals explained, and
attribution counts. `docs/interpolation_tests.md` tracks these across
commits; the current state matches ~99.4% of shells forward, leaves
~0.25% unlinked, and explains ~85.6% of terminals on the reference
fixture (~92% of corpus impacts counting unseen-source attributions).
Every change to matching should be judged against those numbers,
watching for trades between shell continuity and terminal matching.

The match rates also count explanations, not correct ones: a wrong link
scores the same as a right one. `score_pill_links` supplies the missing
truth axis for pill chains, scoring every link whose ends both pin an
orbit step against the advance the pill's own statements elected over
that record pair (the same roster vote the matchers consult): vouched
when the step gap equals it, contradicted when a vote passed and the
link disagrees, unvouched when no vote passed. The rates tool reports
the bins as `links_*` lines and `rate_links_pill_vouched` /
`rate_links_pill_contradicted`; contradicted is a regression alarm
(the pairwise matcher defers to the vote, so a contradiction can only
come from a link made under other gates or a vote that failed at match
time), and its fixture counts are pinned in the test suite.

The match rates count explanations, not what the viewer draws, and the
two can move in opposite directions. `tools/audit-drawn-motion.cjs` is
the second measurement axis: it samples the drawn link structure
directly — link speeds (a perfect engine draws everything at 2 px/tick),
hover and rush links, seam jumps at handoffs (an invariant), pop-outs
and pop-ins, and backwards pops. Every matching change is judged on both
axes; `docs/interpolation_tests_corpus.md` carries the corpus history of
both.

## Known limits and open ideas

- **Tank shots now get discrete-simulation treatment too.** Corpus
  measurement (`tools/measure-tank-shell-bradians.cjs`, results in
  `docs/tank_shell_bradians.md`) proved tank shells run the same
  sine-table simulation as pillboxes, at all 256 integer bradians
  (pillboxes use only the odd 128), with the same round-to-nearest
  direction-nibble mapping: 96–98% of matched tank-shell chains are
  reproduced exactly by one of the 256 known integer velocity vectors,
  and the alternative-table controls lose by ratios of hundreds to one.
  The matcher exploits this: a tank-born shell carries per-bradian
  hypothesis states bounding its exact internal coordinate (the firing
  tick and the tank's sub-pixel position are unknown, so unlike pill
  orbits there is no absolute track — the boxes narrow as the chain
  grows). Impossible continuations are vetoed outright, converging boxes
  recover exact coordinates from quantised chained offsets, and a
  uniquely surviving bradian yields an exact heading. Adopting this took
  all three headline metrics to new records at once.
- **Cross-client identity is never inferred.** A simulation migration draws
  as pop-out/pop-in by design.
- **Matching is greedy and local, with a global backstop.** The primary
  matcher works on pairs of consecutive snapshots, mutual best with
  margins. What it leaves behind now goes through the safe core of issue
  #15's *maximum parsimony* idea: a stitching pass reconnects chain
  fragments (the residue's largest cause — margin failures and lag gaps,
  not cross-client migration, which measurement found essentially never
  happens), and a per-component maximum-flow pass
  (`resolve_residual_shell_fates`) makes every *forced* assignment among
  unaccounted chain ends, unconsumed shots, origin-less starts, and
  unexplained impacts — an assignment is applied when every maximum
  assignment agrees on it, or (cost-forcing) when every rival costs more
  than the matcher's own three-pixel ambiguity margin. Impacts whose
  shell was never observed get their firing pill or tank named
  (`unseen_*_source`), the beginnings of shooter attribution. Chains
  fragmented by sender clock *dilation* are additionally reconnected
  under time-only widened windows at a penalty cost (dilated joins) —
  the spatial physics is never relaxed. The same clock lie runs the
  other way for impacts: a chain end whose restatement arrived late
  understates its remaining flight, so an impact record can *lead* the
  receiver-clock arrival estimate. The residual pass admits such an
  edge at the dilated penalty, with the lead bounded by the gap back to
  the sender's previous record — the most that timestamp can be lying
  by. That lead extends to orbit-tracked ends too: their distances are
  discrete, but an end reached through a dilated link carries the very
  timestamp lie the lead exists to forgive. And because a restatement on
  the way to an impact is part of the impact's own story rather than a
  rival for it, an end holding both a fate edge and a join edge to a
  lone orphan start that is provably an intermediate of that fate's
  flight — an exact orbit point on a surviving bradian, strictly between
  the end's step and the fate's entry step — has the join *subsumed*:
  kept out of the flow so the two halves of one true story cannot veto
  each other's forcing, with the orphan absorbed into the terminal
  segment afterwards (under absorption's usual census) and the arrival
  re-timed from it. Without this, the join and the fate land within the
  margin of each other, neither is forced, and the shell pops mid-air
  with its impact unexplained. A shell that fires *and* dies inside one record gap has its shot
  and its impact reported in the same record — duration zero, the normal
  case for point-blank flights such as adjacent-pill crossfire — so a
  second, strictly additive phase force-assigns same-record shots onto
  whatever fates the main flow left unexplained, with the fire-time
  window widened by that same record gap; these edges compete only with
  each other, never with observed shells. What remains genuinely ambiguous
  is left unexplained by design, though where every ambiguous story
  draws the same line it is drawn without being believed (visual joins).
- Collision inference against terrain/objects currently only enters through
  terminal events; the orbit tables could in principle also *predict* where
  an unterminated pillbox shell must stop, which is only partially
  exploited today.
