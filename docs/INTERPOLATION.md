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

## Two clocks

Every timing rule below serves one fact: a log carries two clocks that
disagree by a few ticks, differently at every record.

The sender's simulation clock is exact but invisible. It advances every
shell one velocity-table step every two ticks, all of a machine's shells
together, and the positions in a shell list are a snapshot of it. The
record's timestamp is a different clock: the tick at which the recording
machine took the packet in (the engine calls it the receive stamp), not the
tick at which the sender computed the positions inside. Between the two sit
the sender's packet build, the token ring and the recorder's own loop, so a
stamp can run early or late against its contents by a few updates.

Two shapes of disagreement matter. When the error wanders from record to
record the docs call it *jitter*: a per-hop speed read off two stamps can
come out anywhere from 0.7 to 3.6 px/tick around the true 2 (replay
`122903.4`). When a sender lags, its stamps keep counting while its
simulation falls behind, and its shells read as consistently slow; the
docs call that *dilation*. Stamps also collide: on a fast ring two
snapshots can land in one recorder tick, which is why the roster vote
table is keyed by snapshot index in the scorer and remains time-keyed in
the engine (ROADMAP item 12).

The rule the engine follows is that distance is the trustworthy quantity
and time the approximate one. Shells fly at exactly 2 px/tick and their
positions are exact or bounded, so a link's length says how many updates
elapsed better than its stamps do. In *matching*, time is therefore a
tolerance, never a truth: a link must fit within two updates of what its
stamps imply, each link re-anchoring at its own start so a lagging sender
never accumulates error; a verbatim re-send is recognised within 4 ticks
because in 4 ticks a real shell has moved; an impact record is an upper
bound on the arrival, up to 30 ticks late; and an absorbed restatement must
sit within 24 px of where uniform time puts it, so a trailing shell on the
same path is not claimed. In *drawing*, the stamps give way to the
distances: chains are re-timed to constant velocity, a late head or tail
slides along its ray, and an effect is placed at the physics arrival rather
than at its record. The sections below name each of these where its
mechanism lives.

What is measured and what is inferred. The jitter and dilation magnitudes,
the 4-tick re-send bound, the fire-time direction nibble and the 1.5% of
fires logged one record before their shell (FORMAT.notes
[E:shot-fire-time]), and the largest along-track stamp lie seen on the
corpus's laggiest replays (35.5 px) are corpus measurements. That the
stamp is the recorder's receive tick is the reading every pass is built on
and it has never contradicted a measurement, but it is not verified from
Bolo's code, and how the recorder stamps its *own* records has not been
examined separately. The three named sources of the offset are the obvious
candidates, not measured contributions. Dilation as "simulation stalls
while stamps count" is the explanation that fits the consistently-slow
chains; nothing rules out a different mechanism producing the same shape.

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
Matching runs per *client* (per player slot), and a chain never crosses
one. Early work entertained the idea that a shell's simulation could
migrate between machines mid-flight; that idea is now regarded as highly
suspicious. Bolo has no orchestration that could hand an in-flight shell
to another machine, and corpus measurement found no scene that needed
one. Joining across clients would in any case manufacture convincing
false identities, so whatever a cross-client coincidence really is, it
renders as one shell vanishing and another appearing.

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
   16 px boxes the shell centre must enter. The ordinary ray test uses
   a tank-hit box as the packet states it. A pill shell on a pinned
   orbit gets two walks (`pillbox_shell_terminal_match`): first against
   the *interpolated* tank track at the shell's arrival time, and only
   if that whole walk finds nothing, again against the packet box,
   starting one step on. The track box is right for a tank driving into
   the shell; the packet box is right for a tank driving away, because
   the collision happened in the sender's simulation, whose picture of
   a remote tank is the last restatement it received -- at best the one
   the recorder logged a ring-round earlier, which is the packet box.
   A tank crossing the shell's path at full speed moves 7 px per round,
   enough for the interpolated box to slide out from under a corner
   graze the sender registered against its stale box. The track keeps
   first refusal over the whole walk, and the fallback never starts at
   step zero, so a shell last seen where the tank is about to be cannot
   match as a zero-length link. Identical
   terminals are interchangeable and carry multiplicity (capacity), since
   two shells can die in one tile in one interval.

Before any of that competition, verbatim re-sends are taken off the
table (`link_stale_restatements`). On a fast token ring (a two-player
low-latency game circulates the token every 1–3 ticks, against the
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
  position, in the right sector. The range follows the record gap: a shot
  logged in a record was fired since the sender's previous one, so its
  shell may sit anywhere from the muzzle out to the gap's worth of flight,
  bounded by the shell's range (`mark_new_tank_shells`). The birth point
  is then refined against the interpolated tank track at the inferred
  firing time, which matters when a moving tank fires between position
  packets.
- **Pillbox shots** (`F4`): see below — these get the full orbit treatment.
  The same gap-following range applies (`mark_new_pillbox_shells`).
  The F4's pill index can be one too high when the direction nibble reads
  0 and the index is odd (a packing carry, FORMAT.md [E:pill-fire-index];
  ~25% of direction-0 fires), so odd-index direction-0 shots also try
  pill `n−1` as a fallback origin. An even index is always right.

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
helper, a muzzle offset of half a tile, a velocity of a quarter tile per
update with one update every two ticks (2 px/tick), and a lifetime of 32
updates, 64 ticks, for 8.5 tiles of range. `viewer/pillbox_shell_orbits.js`
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
  the chain. The test is only applied when at least one member of the
  pair is already pinned to a single state, so certainty propagates
  outward from pinned shells rather than two open sets pruning each
  other; and a pair with no consistent combination is left alone, since
  that usually means one provisional source attribution is wrong.
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
  whose current step is well-defined -- one bradian, or several bradians
  agreeing on one step, as near-muzzle states do
  (`enforce_pillbox_lockstep_candidates`), pruning candidates no jointly
  consistent story supports; when no common advance exists (a fall
  mid-interval, a dropped restatement) it stands down rather than guess.
  Terminal candidates are neither counted nor pruned: dying is exactly
  how a shell leaves the lockstep.
  The pill's own statements also vote on the advance
  (`enforce_roster_lockstep_candidates`): the step-pinned roster in one
  snapshot is scored against the pinned roster in the next for every
  plausible advance, and a winner explaining at least three shells by a
  margin of two prunes every member's off-lockstep continuation. A
  near-regular ladder maps onto its own future at the true advance
  minus the fire cadence too, and the deciding vote between the two is
  often cast by a shell that in fact died over the pair, so the
  election is held with and without the members holding a terminal
  candidate and passes when either vote clears the gates while the
  other still ranks the same advance first. And because a long
  near-regular ladder lets the alias score within one of the truth
  forever, a margin-one or tied election goes to an orphan-free leader
  when every rival within one leaves a high-step landing with no
  source one advance behind it -- structural under the alias,
  impossible under the truth unless a source went unpinned. The
  fixture doc's "doubtful voters" and "symmetric election" sections
  have the scenes and the corpus reading that motivated each.
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

A chain end with no forward story at all — no successor, no terminal —
draws at its last restatement and then vanishes, rather than hanging at
that point until the sender's next record replaces the list. A shell is
either flying at 2 px/tick or gone, so the hold drew something that never
happens; and the corpus census says most such ends are real deaths
(range-end falls whose event never arrived, impacts a volley sibling
claimed), for which the vanish is right and a coast along the heading
would be a fly-through. Where the engine genuinely lost a live shell the
result is vanish then pop-in instead of freeze then jump — still wrong,
but no longer a hovering shell.

Two things tame sender timestamp jitter. The first is part of matching:
when a stitch or a residual join bridges a gap, the jittered on-path
restatements inside it are *absorbed* into the chain as identity links
(`absorb_intermediate_observations`, run from `stitch_shell_chains` and
`resolve_residual_shell_fates`), with a temporal gate so a trailing
shell on the same segment is never claimed, at most one candidate per
snapshot, and orbit evidence allowed to override the clock both ways.
Whatever a stitch, a forced origin or an orbit-membership claim learns
about a chain's head is carried down the whole chain: the source and
birth (`propagate_identity_down_chain`) and, re-derived link by link
under each link's own duration with the same successor functions the
pairwise matcher runs, the orbit or bradian states
(`propagate_states_down_chain`), so the exact pixel, the orbit walk
and the lockstep pin reach every shell below the join rather than
stopping at it. Once every pin is in, the roster vote gets the last
word: a link whose step advance contradicts the advance the pill's own
statements elected over its record pair is undone
(`sweep_contradicted_links`) and the joining passes run once more over
the freed pieces, under the election.
The second is drawing-only, after every identity has been decided: each
chain of three or more restatements is re-timed to constant velocity
between its best-known anchors (`smooth_shell_chains`), since the jitter
otherwise visibly wobbles a large fraction of drawn links. A chain *head*
is one of those
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
fixture (`-f`) or, with `-r` or a configured corpus root from
`tools/corpus.cjs`, against a whole corpus: fraction of shells matched
forward, fraction unlinked (appeared and vanished unexplained — the
clearest failure signal), fraction of terminals explained, and
attribution counts. `docs/interpolation_tests.md` tracks these across
commits; at `30d5351` the engine matches 99.6% of shells forward, leaves
0.17% unlinked, and explains 86.0% of terminals on the reference fixture
(83.4% of corpus impacts, 96% counting unseen-source attributions).
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

Several of the passes above binary-search time-sorted lists (chain
ends and starts, fate and creation groups, and the snapshots themselves),
which rests on a sender's record stamps never running backwards.
`tools/check-record-time-order.cjs` asserts that over a corpus: it
counts every adjacent same-sender record pair by the sign of its time
step, prints each backwards step as a `dip_example`, and exits non-zero
if any exists among the records that produce snapshots.

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
- **Cross-client identity is never inferred.** Mid-flight migration of a
  shell between machines is not believed to happen (no mechanism, and
  none measured); a scene that looks like one draws as pop-out/pop-in by
  design rather than being explained by it.
- **Matching is greedy and local, with a global backstop.** The primary
  matcher works on pairs of consecutive snapshots, mutual best with
  margins. What it leaves behind now goes through the safe core of issue
  #15's *maximum parsimony* idea: a stitching pass reconnects chain
  fragments (the residue's largest cause — margin failures and lag gaps,
  not cross-client migration: measurement found essentially none, and
  the concept itself is regarded as highly suspicious, since nothing in
  Bolo could hand an in-flight shell to another machine), and a
  per-component maximum-flow pass
  (`resolve_residual_shell_fates`) makes every *forced* assignment among
  unaccounted chain ends, unconsumed shots, origin-less starts, and
  unexplained impacts — an assignment is applied when every maximum
  assignment agrees on it, or (cost-forcing) when every rival costs more
  than the matcher's own three-pixel ambiguity margin. Impacts whose
  shell was never observed get their firing pill or tank named
  (`unseen_*_source`), the beginnings of shooter attribution. Chains
  fragmented by sender clock *dilation* are additionally reconnected
  under time-only widened windows at a penalty cost (dilated joins) —
  the spatial physics is never relaxed, and the lie a join may assume
  is bounded by the largest along-track lie the corpus has shown, the
  measurement behind the smoothing bound: a join needing more is two
  shells, not a lagging sender. The same clock lie runs the
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
