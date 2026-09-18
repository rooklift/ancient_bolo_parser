# How Bolo is played

FORMAT.md explains what the bytes of a log mean, and its closing section
lists the game logic a player of logs must supply itself. Neither says how
Bolo is actually played, so a reader arriving at this repository has to infer
the game from packet semantics. This document fills that gap. It is written
for people and language models who know the log format and need the rules of
the game the log records.

Almost everything here is the owner's knowledge of the game, gathered
through the questionnaire archived as `docs/gameplay_questionnaire.txt`, and
should be weighed as such. Each statement carries one of three tags:

- **(owner)** — stated from the owner's knowledge of Bolo, without hedging.
- **(owner, unsure)** — stated with a caveat, or inferred from WinBolo, John
  Morrison's independent reimplementation, which is close to Bolo but is not
  Bolo. Treat as probable.
- **(corpus)** — measured in the replay corpus; FORMAT.md or FORMAT.notes.md
  carries the evidence, cited as `[E:foo]`.
- **(measured)** — measured by `tools/measure-gameplay.cjs`, first on the
  two fixture logs and one further replay (`docs/corpus_runs/47a58d7-gameplay.txt`)
  and then over the 443-log corpus (`docs/corpus_runs/7d633c0-gameplay.txt`);
  the numbers below are the corpus ones, and the evidence is in
  FORMAT.notes.md under [E:gameplay] and [E:base-capture].
- **(fixtures)** — measured on the two fixture logs only, not yet over the
  corpus; FORMAT.notes.md carries the evidence, cited as `[E:foo]`.
- **(emulator log)** — measured on `fixtures/emulator_solo`, a
  single-player game the owner recorded in a Macintosh emulator in 2026 as
  a set of controlled trials, with the ground truth typed into the chat;
  `tools/measure-emulator-log.cjs` prints every reading, and the account is
  in FORMAT.notes.md under [E:emulator-log]. One machine and one tank, so
  nothing needs attributing and no record is lost or late.

Where a WinBolo constant agrees with a measurement it is named, since the
two reimplementations agreeing on a number is worth more than either alone.
What remains unmeasured is collected at the end.

## The pieces

A game is played on a 256×256 map of 16-pixel squares by up to 16 players,
each driving one **tank**. Every tank carries one **man** (the LGM, "little
green man") who can be sent out on foot to build and repair. The map holds up
to 16 **pillboxes** (pills), automatic guns that fire at hostile tanks, and up
to 16 **bases**, which refuel friendly tanks. Players may form **alliances**;
ownership of pills and bases belongs to a player and, through them, to their
alliance (see FORMAT.md, ownership follows the person). There is no such
thing as a neutral *player*: every player is hostile to every other unless
allied. Pills and bases, by contrast, can be neutral, owned by nobody
**(owner)**.

## Tanks

- **Armour.** A tank holds 9 armour and dies on the ninth net hit
  **(owner; measured)**: replaying every life at 9, minus 1 per `FC` hit,
  plus 1 per `Dn` drain capped at 9, ends 12,375 of 15,443 shell deaths at
  exactly 0, where 8 ends them at −1; the rest below 0 are largely hits that
  reached a tank already dead, credited to its next life (not double logging:
  no hit is reported twice, [E:hit-reporter]), and the 7% with armour to spare are
  the size mine damage would leave. The game displays 8 bars and the tank dies when
  hit at 0, which is the same count **(owner)**. Driving over a mine removes
  3, unless 3 would kill the tank, in which case it removes 2: in
  display bars 8 → 5, 3 → 0, 2 → 0, and 1 or 0 → lost; in the 9-scale
  9 → 6, 4 → 1, 3 → 1, and 2 or 1 → lost **(owner, in an emulator; measured
  twice over: the corpus sweep puts the most mine-involved deaths at
  exactly 0 with a loss of 3 and its only 23 "impossible" survivors are the
  tanks at 3 and 2 that the reduced loss spares, and read directly off survivors'
  later deaths the loss is 3 in every row from 5 to 9, 3 at 4 and 2 at 3,
  with runs of two and three mines showing the reduction again; WinBolo uses 2
  with no reduction)**. So a mine never delivers the killing blow to a tank
  at 3 or above; only a tank already at 2 or 1 is lost to it. One armour
  drain restores 1 to the tank and costs the base 5 **(measured, WinBolo
  `BASE_ARMOUR_GIVE`)**. The log carries no armour field, so a tank's health
  is integrated from hits, drains and deaths, as ammo already is
  [E:death-tiers].
- **Ammunition.** A tank holds at most 40 shells and 40 mines **(corpus,
  [E:ammo-clamp])**. What it respawns with depends on the game type: **open**
  40 shells, 40 mines, full armour; **strict** 0 shells, 0 mines, full armour;
  **tournament** a variable number of shells, no mines, full armour
  **(owner)**. That is the only difference between the game types **(owner)**.
  Start delay and time limit change nothing visible in play **(owner,
  unsure)**.
- **Speed.** The speed byte in the tank position subpacket is pixels per
  tick × 64 **(measured)**: byte 64 moves 1.00 px/tick, 48 moves 0.75, 24
  moves 0.375. Top speed by terrain: road and boat 64 (1 px/tick, about 3
  squares a second), grass 48, forest 24, river, swamp, crater and rubble
  12 **(owner as the ratio 16:12:6:3; measured)**. Boats are travelled *in*,
  not *over*.
- **Turning.** Turning slows with the terrain **(owner; measured)**. One
  sixteenth of a circle takes about 8 ticks on road, grass and boat (2.5 s
  for the full circle), 16–17 in forest (about 5 s) and 24–28 on crater,
  rubble, swamp and river (about 8 s); WinBolo has 2.61 s, 5.17 s and
  10.29 s. The corpus medians for open ground read 11 because a coarse
  record cadence can only round the interval up; the fine-cadence logs give
  8. A first pass that read rough terrain as fast was tanks sitting on bases
  whose map terrain is crater.
- **Firing.** A tank can fire while moving and while turning **(owner)**. The
  reload is a quarter of a second, 13.2 ticks: a stationary tank holding
  fire shot 81 times in 1,059 ticks, the gaps reading 12 and 14 in a
  repeating 12-14-12-14-14 pattern because the machine wrote a record every
  2 ticks **(owner; emulator log; WinBolo 260 ms)**. Whether the fraction
  is Bolo's own frame clock or the emulator's is not known. The corpus
  distribution is broader: a quarter of the gaps are 7–11 ticks, the floor
  is 5–6, and 2.4% of firing records carry two shots **(measured)**. Those
  short gaps are the stamps, not the reload: the first shot of a burst
  goes into a record the sender was already late with, so the second
  follows it by as little as 8 ticks, and a ring that spaces records 6 or
  more ticks apart makes that shape everywhere **(emulator log)**. Tank shells run the same integer physics as pill shells
  at all 256 bradians, at 2 px per tick, with a flight of about 8.5 tiles
  **(corpus, `docs/tank_shell_bradians.md`)**.
- **Hiding.** A tank is hidden in trees when no non-forest square comes
  within 9 px (Chebyshev) of the tank centre: the whole 16 px box plus a
  one-pixel margin must be forest **(owner: "the entire box, maybe
  stricter"; measured: hidden at clearance ≥ 9 in 319,754 of 320,198
  restatements, shown at 1–8 in 288,719 of 288,775)**. A hidden tank is invisible on
  enemy screens and is not targeted by pillboxes **(owner; the pill half
  also corpus, [E:pill-target])**.
- **Water.** A tank can cross river slowly, and doing so drains its shells
  and mines, one of each at a time **(owner; emulator log: a full tank
  fording six river squares in 393 ticks came out with 18 of each and
  refilled 22 shells and 22 mines, and one square in 68 ticks cost 2 of
  each)**. This means `5d` and `F7` are not the only ammo sinks, which any
  ammo-integration model should allow for; whether the loss runs per tick or
  per pixel, two crossings cannot say. Deep sea is
  instant death for a tank not in a boat and harmless in a boat **(owner)**;
  the log reports it as `F9` code 3.
- **Obstacles.** Building and shot building block a tank; every other
  terrain can be driven onto, water included, river slowly and deep sea
  fatally **(corpus, [E:terrain-hits]: of 8.8 million live tank centre
  squares, 43 are a building or shot building, the model a record behind,
  while every other terrain occurs in bulk)**. The death dump's search
  refuses exactly building, shot building and boat, and no other terrain,
  plus the map's mined border **(corpus, [E:dump-terrain])**.
- **The mined border.** The outermost ten rows and columns of the map
  (x or y of 0 to 9, and 246 to 255) carry indestructible sea mines
  **(owner)**. Every tank that reached the tenth square from any edge died
  within two seconds, 9 of 9, all in boats, and boats sit on the eleventh
  square unharmed; the death is logged as `F9` code 3, the same as sinking
  **(corpus, [E:dump-terrain])**.
- **Bases as obstacles.** A hostile base is impassable to an enemy tank
  until its armour is down to 9 or less, at which point driving on captures
  it **(owner; measured, see Bases)**. Terrain is not the only obstacle:
  a live hostile base blocks too.
- **Death and respawn.** The wreck's explosion tiers, forest clearance and
  pill dump are corpus-established (FORMAT.md), and the tier boundary is
  confirmed by controlled deaths: 60 shells + mines aboard craters, 61
  superbooms, a single shell craters, and the crater or superboom comes
  48–50 ticks after the `F9` **(emulator log)**. The respawn follows 5.0–6.8 s
  later **(corpus, [E:respawn-gap])**, at a square of the start list that is
  not always the player's original one; the choice rule is not known
  **(owner)**, and neither the nearest start nor the farthest from enemies
  explains the choices seen **(measured)**.

## Shells

- A shell damages any tank it hits, allied tanks included **(owner)**.
- A shell kills the man in one hit, but only if it falls very near him or
  hits a forest square he is standing in; otherwise it flies over him
  harmlessly **(owner)**. The exception is the moment of building: while he
  plants or repairs a pillbox, or builds a building or a boat, he is briefly
  inside the thing, and a shell that hits it then kills him **(owner)**.
- A **live pillbox stops a shell; a dead pillbox does not** **(owner)**.
  This settles FORMAT.md's [E:shell-passthrough], which had reached the same
  conclusion tentatively: the apparent pass-throughs were shell identity
  errors.
- Friendly and neutral bases do not block shells **(owner)**. A hostile base
  blocks them while its armour is 5 or more and lets them over below that
  **(measured: hits logged at every armour from 5 to 90 and at 0–4 in
  only 74 of some 150,000; WinBolo `BASE_MIN_CAN_HIT 4`)**.
- A shell detonates a mine it lands on **(owner)**. The explosion is evented
  (`7T`).
- A shell destroys a boat, whether or not a tank is in it **(owner)**. The
  square reverts to river **(corpus: 3,381 boat-to-river impacts,
  [E:terrain-hits])**.
- A tank sailing in a boat over a boat square destroys that boat, keeping
  its own; the square reverts to river, evented as `7 1` by the sailing
  tank's owner **(owner; fixtures, [E:boat-over-boat]: 150 of 179
  boat-to-river events have the sender in a boat on or beside the
  square)**.
- **What a shell flies over, and what stops it.** A shell passes over
  river, swamp, crater, road, rubble and grass, mined or not, and over deep
  sea; it is stopped by, and damages, building, shot building, forest and
  boat **(corpus, [E:terrain-hits]: 613,281 shell falls end on the open
  terrains, all but 37, and every impact that changes the ground to
  something other than a crater is a felling, a shot building, a rubble or
  a sunk boat, a few dozen stale-model cases aside)**. A tank, a live
  pillbox and a hostile base with armour to spare stop a shell too, as
  above. The opening frame of a shot does not fell the tree under the firer
  **(corpus, [E:muzzle])**.

## Pillboxes

- **Armour** is 15 at full **(viewer, from the map format)**; each shell hit
  removes 1, logged as `9n`; a superboom removes 4 without an event
  **(corpus, [E:superboom-pill])**.
- **Anger.** A pill's fire rate rises when it is hit and decays back to rest
  **(owner)**. The delay between shots runs from 100 ticks at rest to 6 ticks
  fully angry **(owner from WinBolo; measured)**: fires within 5 s of a hit
  come every 6–7 ticks, and by time since the last hit the gap is about 20
  ticks at 5–15 s, 38 at 15–30 s, 66 at 30–60 s and 100 beyond a minute, so
  the delay grows roughly 1.5 ticks per quiet second. Each hit halves the
  delay, floored at 6, and it relaxes back toward 100 between hits: from
  rest, one hit gives fire gaps of 48–60 ticks, two 24–31, three 14–19,
  four 6–10 and five or more 4–8, the gaps creeping up between hits (48,
  55, 55, 59 after one); a pill left alone for two minutes after its first
  hit answered its next two as if from rest **(emulator log)**. Four quick
  hits leave a pill a shade off the floor; the fifth reaches it. The
  "speed" byte in the `F1 02` pill list is this delay:
  it reads 100 for a pill at rest and, in logs started mid-fight, the live
  value (18–98 seen) **(owner; measured)**. A value of 255 also occurs and
  is unexplained. The shell
  matcher's working bound of "an angry pill fires at most every 5 or 6
  ticks" in `viewer/motion.js` agrees.
- **A shell on a base angers its pills.** A shell hitting a base counts as
  one hit on every live grounded pill allied to the base (the base's owner
  or an ally of theirs) whose square lies **strictly within 7 squares** of
  the base's, centre to centre: one base shell halves the pill's delay from
  100 to about 50 exactly as a direct hit does, a second to about 25, and a
  grind of eighteen puts the pill on the floor. The range is a circle, not a
  box: a pill at offset (6,3), distance 6.71, is angered every time, while
  pills at (7,0), (5,5), (7,1) and (6,4), distances 7.00 to 7.21, go on
  firing at the rested pace through the whole grind. Neutral pills are not
  angered, and hostile pills near the hit base only at the background rate
  of a fight; neutral bases are never hit, since shells pass through them
  **(corpus, [E:base-anger])**.
- **Targeting.** A pill fires at the nearest hostile tank within about 8.5
  tiles that is not hidden in forest, leading a moving target by a sector or
  two, and simulated by the target's own machine **(corpus,
  [E:pill-target])**. It does not fire at the man; it does fire at a tank in
  a boat **(owner)**. A tank touching the pill can make it fire along the
  tank's facing instead, the "massaging" bug **(corpus, [E:massaging])**.
- **Capture and repair.** A pill must be dead (armour 0) to be picked up, and
  anyone may pick it up, its owner included; pickup captures it **(owner;
  corpus, [E:pill-capture], [E:owner-signals])**. Repairing never changes
  ownership and is open to anyone **(owner; corpus)**. Repairs cost wood: one
  harvested tree is exactly enough to fully repair a pill, or to plant a dead
  one at full health **(owner)**. The partial repairs (`FF 1n`–`FF 3n`, by 4,
  8 or 12) probably happen when the tank has less than a full unit of wood to
  spend **(owner, unsure)**.
- **Planting** brings a pill up at full armour; dumping (death, quit, killed
  man) drops it dead, still owned by the same player **(owner; corpus,
  FORMAT.md)**.

## Bases

- **Stocks.** A base holds up to 90 each of shells, mines and armour, and
  every player's 1000-tick timer adds 1 to every base's three stocks
  **(corpus, [E:base-tick])**. A shell hit removes 5 armour (`An`); a shell
  or mine refuel removes 1 of that stock and an armour refuel removes 5
  **(measured, [E:base-capture])**. Only a tank shell damages a base: a
  pillbox shot never produces an `An` **(owner)**, and the interpolation
  engine refuses a base hit as the fate of any shell it has put at a pill
  (INTERPOLATION.md).
- **Capture.** A neutral base is captured by driving over it, at any armour
  **(owner; measured: 6,973 of 6,975 neutral captures at 90)**. A hostile
  base must first be shot down to armour 9 or less **(owner: "near zero";
  measured: 11,927 of 11,945 hostile captures at 0–9, 2,414 of them at 5–9,
  the 18 others netsplit ownership noise; WinBolo `MIN_ARMOUR_CAPTURE 9`)**.
  A base whose owner has left with no heir (the viewer's DEPARTED) is
  captured at any armour, so for capture the game treats it as neutral
  **(measured, 90 cases)**. Only a neutral or hostile base can be captured
  **(corpus, [E:owner-signals])**. **Capturing a base from an owner zeroes
  its armour, shells and mines** **(measured for armour, WinBolo for all
  three; the logs permit the stock half and do not prove it)**. The log
  does not say so, and a viewer that keeps the old stocks shows recaptures
  at armour its own rule forbids [E:base-capture].
- **Refuelling.** A base refuels its owner's tank and any ally's **(owner;
  corpus)**. The tank need not be stopped, only stay on the square; slow
  motion is fine **(owner)**. Transfer runs one shell per 7–9 ticks, one
  mine per 6–8 and one armour per 50–54, one resource at a time and almost
  never interleaved (1.2% of drains) **(measured; WinBolo 7.5, 7.5 and
  46; on one machine with no ring the modes are 8, 8 and 50, emulator
  log)**, so empty to full takes about 1,050 ticks, 21 s **(measured;
  owner's WinBolo figure about 20 s)**. On a
  slow ring the shell and mine transfer is capped at one unit per packet the
  tank sends **(measured)**. WinBolo refuels only while the base has more
  than 10 armour; untested here. Each unit transferred is logged as a `Bn`,
  `Cn` or `Dn` drain. A full tank takes nothing: the base's stock holds
  still **(owner, on the game)** and no drain is logged, so over 40,618
  stints on a base the drains never outrun the tank's spends by more than
  40 **(corpus, [E:base-fill])**.
- A base does nothing hostile to an enemy tank beyond blocking its path while
  it has armour **(owner)**.
- A base's square behaves as road whatever the map says beneath it
  **(corpus, [E:base-road])**.

## The man (LGM)

- **What he does.** Harvest a tree (forest becomes grass, yielding wood),
  build a road, build a building (wall), build a boat (river only), build or
  repair a pillbox, plant a mine **(owner)**. The mine he plants comes out
  of the tank's stock **(owner; corpus, [E:base-fill])**. Costs in wood: pillbox 1, road
  about 0.5, building 0.5, boat about 5 **(owner, unsure; the building
  from the emulator)**. The
  action itself is fast **(owner)**: from the man reaching the square to the
  event, plant pill 9 ticks, repairs 9, boat 8, building 10, mine 11,
  harvest 14, road 25 **(measured medians)**.
- **Movement.** He is blocked by everything that blocks a tank, is slowed by
  swamp and crater, and cannot cross river; he cannot swim **(owner)**. He
  walks across a boat square as passable terrain **(owner, in the
  emulator)**. He
  walks 1.0 px/tick on road and grass, the same as a tank on road, 0.46 in
  forest and 0.25 on crater, rubble and swamp **(measured)**.
- **Pathing.** He walks a straight line toward the target. On meeting an
  obstacle on one axis he drops that axis and keeps the other; if both axes
  are blocked he gives up **(owner)**. For example, heading south-east at
  (3,3) and blocked to the east he continues at (0,3); blocked to the south
  as well he stops.
- **Death.** Shells that fall near him or hit his forest square, and
  explosions on him, kill him, as does a shell hitting the pillbox,
  building or boat he is briefly inside while planting, repairing or
  building it **(owner)**. A shell that ends against a **tank** he is
  standing beside kills him too, his own tank as readily as an enemy's
  (he has just climbed out, or is about to climb back in), and so does a
  shell hitting a **base** on his square; in the two fixture logs every
  one of 86 deaths has a shell arriving at the man's position within 30
  ticks, ending on open ground, a pillbox, a building, a tree, a tank or
  a base **(fixtures, [E:lgm-killers])**. He does not detonate a mine by
  walking on it **(owner, unsure)**; harvesting a tree over a hidden mine
  might kill him, but practically no game allowed hidden mines **(owner)**.
  His death is logged as `F5`, or as `FF 51` if he was carrying a pill, which
  then lies dead on the ground, still the same player's **(owner; corpus)**.
  Either event is sent by the man's owner and names only the square; the
  man is always the sender's own **(fixtures, [E:lgm-killers])**.
- **Replacement.** A new man parachutes to where the tank was at the moment
  of the death **(owner; measured: landing 3–11 px from it)**. The parachute
  sets out from one of the map's start squares (`F1 04`), the same list the
  tanks respawn from **(owner; measured: 6,505 of 6,507 runs)**; which one
  is not the nearest (6% of runs, below chance), not the player's own, and
  looks random, as in WinBolo. It drifts at 0.12 px/tick, so the tank is
  without a man for a median 86 s and up to six minutes, depending on the
  draw **(measured)**. The parachute rides the `b=4`
  position subpacket for the whole flight.
- **Sending him from a boat.** A mine cannot be laid by a tank in a boat,
  but the man can be sent ashore from a boat adjacent to land to plant one
  **(owner)**.

## Terrain

- **What a shell does to the ground.** One hit fells a tree, forest to
  grass; one hit turns a building into a shot building; four more hits
  turn the shot building to rubble **(owner; corpus, [E:terrain-hits]:
  93,355 fellings, 25,442 shot buildings and 24,503 rubbles; of 17,894
  shot buildings followed from creation to rubble, 13,866 fell on the
  fourth further hit and none earlier, and 93% of those hit one shell a
  record did, while the rest logged more unchanged hits, up to seventeen,
  mostly from an angry pillbox logging two or three hits a record)**. A
  building absorbs a hit unchanged once in 25,443. A second shell arriving
  a record behind the first can be announced as shooting the building
  again, and that restarts the count: the wall takes three more unchanged
  hits from there **(corpus, 28 decisive lives, [E:terrain-hits])**.
  With one tank as the only shooter, 13 of 14 walls followed from first
  shot to rubble took exactly 3 unchanged hits between, one shell each, so
  the count is 5 real hits from building to rubble **(emulator log)**. The
  fourteenth took 5, and it is the one wall the tank never shot: every hit
  was the neighbouring pillbox's own shell, three at the rested pace, then
  twelve minutes later four more, the last three 8 ticks apart from the
  pill made angry, and it fell on the seventh. Whether the two early hits
  were dropped over the gap (twenty other squares shot and six tank
  deaths in between) or the angry fire was miscounted, the corpus's own
  excess shape, one case cannot say; the other wall to fall under angry
  fire counted normally but logged its rubble twice, 1 tick apart, from a
  double fire **(emulator log)**. The repeat
  announcements happen on one machine too: a tank shell and a pillbox
  shell reaching a wall 2 ticks apart both logged `7 8`, and two reaching
  a shot building 1 tick apart both logged the rubble **(emulator log)**.
  A shell also sets
  off a mine it lands on, cratering the square, but a crater event alone
  does not say whether a shell, a tank or a dying tank made it. A shell
  fired from a boat at the shore turns the grass it lands on into swamp
  **(owner; corpus: 5 grass-to-swamp impacts, the one on the fixtures
  from a tank in a boat, [E:terrain-hits])**.
- **Mines** can lie on swamp, crater, road, forest, rubble and grass
  **(corpus, the mined codes of FORMAT.md's terrain table)**. A tank
  driving onto one takes 3 armour, or 2 when 3 would kill it, as described
  under Tanks;
  the square craters (7,187 of 7,348
  corpus detonations) or, rarely, is left as grass **(measured)**. A mine
  going off sets off the mines on its four neighbouring squares about 8
  ticks later, and each of those its own neighbours in turn, so a field
  goes up as a wave, one square per 7–9 ticks, every square evented as its
  own `7 3`: a wreck sliding into a field of 19 laid mines set off 18 of
  them in 56 ticks **(emulator log)**. A chained neighbour does not hurt
  the tank: two adjacent mines, one driven onto, cost three armour, not six
  **(owner, in the emulator)**. A tank sits on the mine it has just laid
  unharmed, and shells hitting the tank there do not set the mine off, since
  a shell that reaches a tank stops at the tank **(emulator log: five hits
  on a tank parked on three of its own mines, none detonated)**. What a
  mine chained under a standing tank does to it is the one case not yet
  seen; the corpus has 517 tanks that stood on a detonating square and
  drove on, and their armour afterwards was not isolated. Almost all games disallowed hidden mines;
  who sees a mine when they are allowed, allies included, is not known
  **(owner)**.
- **Forest regrowth** prefers grass but is not limited to it: trees grow
  back on most land squares except impassable ones **(owner)**; measured,
  60,009 of 60,905 regrowths were on grass, 840 on road, 41 on crater, 10
  on swamp and 4 on rubble, and 99.8% had a forest neighbour, most of them
  four or more of eight. Each client simulates its own growth **(owner,
  unsure; measured: the events split across senders in proportion to their
  time present)**, so the rate scales with player count as base stocks do:
  about 0.76 regrowths per forest-touching grass square per player-hour. Regrowth is
  evented as `6 5`, and a mine beneath survives it **(corpus,
  [E:mine-persists])**.
- **Craters** can be filled by building a road on them, and flood to river
  when next to water **(owner; corpus, [E:crater-water])**.
- **Boats.** A tank driving onto a boat consumes it, with no event
  **(corpus, [E:boat])**. A tank driving off a boat onto land leaves the boat
  behind on the water square **(owner)**, which is the `6 9` terrain event.
- Rivers block the man and slow tanks; swamps and craters slow both
  **(owner)**.

## Alliances and players

- **What allies share.** Their pills do not fire at each other and their
  bases refuel each other **(corpus)**. A player can switch their view to the
  area around any friendly pillbox instead of their own tank **(owner)**.
  Messages can be addressed to everyone, to allies, to nearby tanks, or
  to any single player **(owner, in the emulator)**; the `FA` recipient
  bitmask carries the set, and the log does not say which option built
  it, but the shape does **(corpus, [E:chat-address])**. Every option
  sets the sender's own bit. "Allies" is the sender plus the allies
  still in the ring, reused all game: 8,467 of the corpus's 8,515
  player-sent non-broadcast messages. A single-player message is the
  sender plus the target, ally or enemy, anywhere on the map: 42, the
  privacy marked by hand ("[private]", "pvt:"), since Bolo marks
  nothing. "Nearby" is the sender plus every tank inside a radius under
  8 squares, and with nobody in range the sender's bit alone, which the
  allies option gives only once every ally has left the ring: five such
  with an ally or enemy still heard, one reading "fuck all nearby
  tanks!", and five more to a single tank 1.5–3.7 squares off that could
  be either option. So the nearby option saw about ten uses in 1,030
  logs, and its radius, under 8 and perhaps 4–5 squares, is not pinned
  **(corpus, `tools/measure-chat-recipients.cjs`)**. The fixtures hold
  235 alliance messages and one single-player message
  **(`docs/corpus_runs/` chat-recipients run)**. Allied shells still do damage
  **(owner)**.
- **Leaving, quitting, disconnecting.** A leaver's planted pills and bases
  stay with the alliance; a quitter's do too; a disconnection is treated the
  same as a quit **(owner, unsure on the last)**. Which member holds them is
  invisible in the log; the viewer's rules are in FORMAT.md, and the owner
  defers to them.
- **Join and Rejoin.** Join restored nothing; Rejoin restored the returning
  player's things **(owner, unsure)**. The log does not say which was
  pressed, and playback assumes Rejoin **(corpus, [E:pill-target])**.
- **Brains** (AI players) did send chat messages and moved according to
  their own code **(owner, unsure)**. The messages mark them: a brain
  addresses its allies, or one peer, by a bitmask **without the sender's
  own bit**, which the chat dialog always sets, and the text is protocol
  ("/mytype aIndy 31", "Received: doGetBaseTargetInfo"): 6,344 such
  messages in fewer than ten corpus logs, none in the fixtures
  **(corpus, [E:chat-address])**. Nothing else in the log marks a brain.
- The player@node **history string** in the `F1 Cn` groups remains
  unexplained **(owner: don't know; corpus: murky, [E:history])**.

## Open measurements

What the corpus run left unsettled. The emulator log settled the mine
chain, the reload, the anger ladder and the wall count (the tags above);
what it left, and what it raised, is here.

1. What a mine chained under a standing tank does to it. A shell cannot
   set off the mine under a tank, and a chained neighbour does no harm,
   but a tank parked on one mine while the next square's goes off has not
   been tried. The corpus run of `tools/measure-mine-damage.cjs` has 517
   tanks that stood on a detonating square and drove on, unattributed.
2. The fording drain: one shell and one mine together, 22 pairs over 393
   ticks and six squares, 2 over 68 ticks and one square. Per tick, per
   pixel, or by chance, and whether speed matters, wants more crossings of
   known length.
3. What a pillbox `speed` byte of 255 means.
4. Whether shells and mines reset on capture (the logs permit it), and
   whether refuelling needs the base above 10 armour.
5. The respawn and parachute start choice: neither nearest nor farthest from
   enemies; WinBolo draws at random.
6. The pill and base history string in `F1 Cn` [E:history].
7. The wall that took seven pillbox shells. Hit only by the pill beside
   it, three at the rested pace, then twelve minutes later four at the
   angry pace, it fell two hits late. The two readings are confounded: a
   reset of the hidden damage over the gap (a time-out, a bounded table
   of damaged squares, or the tank's deaths in between), or angry pillbox
   fire miscounted, which is where the corpus's tails of up to seventeen
   unchanged hits come from. The other wall to fall under angry fire
   counted normally and double-logged its rubble, so the second reading
   is not simply "every angry hit". A wall hit twice by the tank, left
   for a minute, and finished by the tank would separate them; so would
   one finished by an angry pill with no gap.
8. Whether the 13.2-tick reload is Bolo's or the emulator's clock: a
   second recording with a different emulator speed setting would tell.
9. The "nearby" chat option's radius: under 8 squares, and 4–5 if the
   five single-tank messages at 1.5–3.7 squares were nearby messages
   rather than single-player ones, which the log cannot tell. A circle
   or a box is also open; `tools/measure-chat-recipients.cjs --other`
   prints per-axis distances beside the Euclidean ones. The emulator
   would settle both in a minute: two tanks, a nearby message at
   several separations along an axis and along a diagonal.
