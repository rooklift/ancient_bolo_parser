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
  two fixture logs and one further replay (`docs/corpus_runs/d8d7483-gameplay.txt`)
  and then over the 443-log corpus (`docs/corpus_runs/0c4e116-gameplay.txt`);
  the numbers below are the corpus ones, and the evidence is in
  FORMAT.notes.md under [E:gameplay] and [E:base-capture].

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
  exactly 0, where 8 ends them at −1; most of the rest are hits logged twice
  by two senders, and the 7% with armour to spare are the size mine damage
  would leave. The game displays 8 bars and the tank dies when
  hit at 0, which is the same count **(owner)**. Driving over a mine removes
  2 in WinBolo, probably the same in Bolo **(owner, unsure)**. One armour
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
  interval between shots is typically 12–13 ticks, a quarter of a second
  **(owner; WinBolo 260 ms)**, but the corpus distribution is broad: a
  quarter of the gaps are 7–11 ticks, the floor is 5–6, and 2.4% of firing
  records carry two shots **(measured)**. Whether the reload varies with
  something, or the stamps merely jitter, is open. Tank shells run the same integer physics as pill shells
  at all 256 bradians, at 2 px per tick, with a flight of about 8.5 tiles
  **(corpus, `docs/tank_shell_bradians.md`)**.
- **Hiding.** A tank is hidden in trees when no non-forest square comes
  within 9 px (Chebyshev) of the tank centre: the whole 16 px box plus a
  one-pixel margin must be forest **(owner: "the entire box, maybe
  stricter"; measured: hidden at clearance ≥ 9 in 319,754 of 320,198
  restatements, shown at 1–8 in 288,719 of 288,775)**. A hidden tank is invisible on
  enemy screens and is not targeted by pillboxes **(owner; the pill half
  also corpus, [E:pill-target])**.
- **Water.** A tank can cross river slowly, and doing so slowly drains its
  shells and mines **(owner)**. This means `5d` and `F7` are not the only
  ammo sinks, which any ammo-integration model should allow for. Deep sea is
  instant death for a tank not in a boat and harmless in a boat **(owner)**;
  the log reports it as `F9` code 3.
- **Bases as obstacles.** A hostile base is impassable to an enemy tank
  until its armour is down to 9 or less, at which point driving on captures
  it **(owner; measured, see Bases)**. FORMAT.md's "tank movement is blocked
  by building and shot building" is about terrain; live hostile bases block
  too.
- **Death and respawn.** The wreck's explosion tiers, forest clearance and
  pill dump are corpus-established (FORMAT.md). The respawn follows 5.0–6.8 s
  later **(corpus, [E:respawn-gap])**, at a square of the start list that is
  not always the player's original one; the choice rule is not known
  **(owner)**, and neither the nearest start nor the farthest from enemies
  explains the choices seen **(measured)**.

## Shells

- A shell damages any tank it hits, allied tanks included **(owner)**.
- A shell kills the man in one hit, but only if it falls very near him or
  hits a forest square he is standing in; otherwise it flies over him
  harmlessly **(owner)**.
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
  square reverts to river.
- Shells are blocked by, and damage, building, forest and shot building
  **(corpus, FORMAT.md Terrain)**. The opening frame of a shot does not fell
  the tree under the firer **(corpus, [E:muzzle])**.

## Pillboxes

- **Armour** is 15 at full **(viewer, from the map format)**; each shell hit
  removes 1, logged as `9n`; a superboom removes 4 without an event
  **(corpus, [E:superboom-pill])**.
- **Anger.** A pill's fire rate rises when it is hit and decays back to rest
  **(owner)**. The delay between shots runs from 100 ticks at rest to 6 ticks
  fully angry **(owner from WinBolo; measured)**: fires within 5 s of a hit
  come every 6–7 ticks, and by time since the last hit the gap is about 20
  ticks at 5–15 s, 38 at 15–30 s, 66 at 30–60 s and 100 beyond a minute, so
  the delay grows roughly 1.5 ticks per quiet second. Whether it doubles per
  hit is untested. The "speed" byte in the `F1 02` pill list is this delay:
  it reads 100 for a pill at rest and, in logs started mid-fight, the live
  value (18–98 seen) **(owner; measured)**. A value of 255 also occurs and
  is unexplained. The shell
  matcher's working bound of "an angry pill fires at most every 5 or 6
  ticks" in `viewer/motion.js` agrees.
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
  **(measured, [E:base-capture])**.
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
  46)**, so empty to full takes about 1,050 ticks, 21 s **(measured;
  owner's WinBolo figure about 20 s)**. On a
  slow ring the shell and mine transfer is capped at one unit per packet the
  tank sends **(measured)**. WinBolo refuels only while the base has more
  than 10 armour; untested here. Each unit transferred is logged as a `Bn`,
  `Cn` or `Dn` drain, even into a full tank **(corpus, [E:ammo-clamp])**.
- A base does nothing hostile to an enemy tank beyond blocking its path while
  it has armour **(owner)**.
- A base's square behaves as road whatever the map says beneath it
  **(corpus, [E:base-road])**.

## The man (LGM)

- **What he does.** Harvest a tree (forest becomes grass, yielding wood),
  build a road, build a building (wall), build a boat (river only), build or
  repair a pillbox, plant a mine **(owner)**. Costs in wood: pillbox 1, road
  about 0.5, boat about 5, building not known **(owner, unsure)**. The
  action itself is fast **(owner)**: from the man reaching the square to the
  event, plant pill 9 ticks, repairs 9, boat 8, building 10, mine 11,
  harvest 14, road 25 **(measured medians)**.
- **Movement.** He is blocked by everything that blocks a tank, is slowed by
  swamp and crater, and cannot cross river; he cannot swim **(owner)**. He
  may be able to enter a boat but cannot use it **(owner, unsure)**. He
  walks 1.0 px/tick on road and grass, the same as a tank on road, 0.46 in
  forest and 0.25 on crater, rubble and swamp **(measured)**.
- **Pathing.** He walks a straight line toward the target. On meeting an
  obstacle on one axis he drops that axis and keeps the other; if both axes
  are blocked he gives up **(owner)**. For example, heading south-east at
  (3,3) and blocked to the east he continues at (0,3); blocked to the south
  as well he stops.
- **Death.** Shells that fall near him or hit his forest square, and
  explosions on him, kill him **(owner)**. He does not detonate a mine by
  walking on it **(owner, unsure)**; harvesting a tree over a hidden mine
  might kill him, but practically no game allowed hidden mines **(owner)**.
  His death is logged as `F5`, or as `FF 51` if he was carrying a pill, which
  then lies dead on the ground, still the same player's **(owner; corpus)**.
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

- **Mines** can lie on swamp, crater, road, forest, rubble and grass
  **(corpus, FORMAT.md Terrain)**. Almost all games disallowed hidden mines;
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
  Messages can be addressed to allies only **(owner)**; the `FA` recipient
  bitmask carries the set. The owner knows of no "nearby" recipient option,
  so any bitmask that is neither everyone nor an alliance is a hand-picked
  set. Allied shells still do damage **(owner)**.
- **Leaving, quitting, disconnecting.** A leaver's planted pills and bases
  stay with the alliance; a quitter's do too; a disconnection is treated the
  same as a quit **(owner, unsure on the last)**. Which member holds them is
  invisible in the log; the viewer's rules are in FORMAT.md, and the owner
  defers to them.
- **Join and Rejoin.** Join restored nothing; Rejoin restored the returning
  player's things **(owner, unsure)**. The log does not say which was
  pressed, and playback assumes Rejoin **(corpus, [E:pill-target])**.
- **Brains** (AI players) did send chat messages and moved according to
  their own code **(owner, unsure)**; nothing in the log marks a brain.
- The player@node **history string** in the `F1 Cn` groups remains
  unexplained **(owner: don't know; corpus: murky, [E:history])**.

## Open measurements

What the corpus run left unsettled.

1. Mine damage to a tank (WinBolo 2): needs deaths with a mine explosion at
   the tank's square and the armour integration of [E:gameplay].
2. The tank reload: typically 12–13 ticks, but a quarter of gaps are 7–11
   and 2.4% of firing records carry two shots. Jitter in the stamps, or a
   variable reload?
3. Whether pillbox anger doubles per hit, from the first fire gap after a hit
   on a rested pill; and what a `speed` byte of 255 means.
4. Whether shells and mines reset on capture (the logs permit it), and
   whether refuelling needs the base above 10 armour.
5. The respawn and parachute start choice: neither nearest nor farthest from
   enemies; WinBolo draws at random.
6. The pill and base history string in `F1 Cn` [E:history].
