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

Statements with no numbers where numbers should be are open measurements;
they are collected at the end.

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

- **Armour.** A tank dies after 9 shell hits. The game displays 8 armour and
  the tank dies when hit at 0, which is the same thing as holding 9 and dying
  at 0 **(owner)**. One shell hit removes 1 **(owner)**. Driving over a mine
  removes 2 in WinBolo, probably the same in Bolo **(owner, unsure)**. One
  armour drain from a base (`Dn`) restores 1 **(owner, unsure: "strongly
  believe")**. The log carries no armour field, so a tank's health must be
  integrated from `FC` hits, `Dn` drains and deaths, as ammo already is
  [E:death-tiers].
- **Ammunition.** A tank holds at most 40 shells and 40 mines **(corpus,
  [E:ammo-clamp])**. What it respawns with depends on the game type: **open**
  40 shells, 40 mines, full armour; **strict** 0 shells, 0 mines, full armour;
  **tournament** a variable number of shells, no mines, full armour
  **(owner)**. That is the only difference between the game types **(owner)**.
  Start delay and time limit change nothing visible in play **(owner,
  unsure)**.
- **Speed.** Relative maximum speeds by terrain, in units whose scale is not
  known: road 16, grass 12, forest 6, swamp 3, crater 3, rubble 3, river 3. A
  tank in a boat moves at 16 **(owner)**. Boats are travelled *in*, not
  *over*. The meaning and range of the speed byte in the tank position
  subpacket is not known **(owner)**.
- **Turning.** WinBolo turns a full circle in 2.61 s on road, grass, base or
  boat, 5.17 s in forest, and 10.29 s on river, swamp, crater or rubble; Bolo
  is probably similar **(owner, unsure)**.
- **Firing.** A tank can fire while moving and while turning **(owner)**. The
  minimum interval between shots is about a quarter of a second; WinBolo uses
  260 ms **(owner, unsure)**. Tank shells run the same integer physics as
  pill shells at all 256 bradians, at 2 px per tick, with a flight of about
  8.5 tiles **(corpus, `docs/tank_shell_bradians.md`)**.
- **Hiding.** A tank is hidden in trees only when at least its whole box is
  inside forest, possibly under a stricter rule **(owner, unsure)**. A hidden
  tank is invisible on enemy screens and is not targeted by pillboxes
  **(owner; the pill half also corpus, [E:pill-target])**.
- **Water.** A tank can cross river slowly, and doing so slowly drains its
  shells and mines **(owner)**. This means `5d` and `F7` are not the only
  ammo sinks, which any ammo-integration model should allow for. Deep sea is
  instant death for a tank not in a boat and harmless in a boat **(owner)**;
  the log reports it as `F9` code 3.
- **Bases as obstacles.** A hostile base with armour is impassable to an
  enemy tank until it has been reduced far enough to capture **(owner)**.
  FORMAT.md's "tank movement is blocked by building and shot building" is
  about terrain; live hostile bases block too.
- **Death and respawn.** The wreck's explosion tiers, forest clearance and
  pill dump are corpus-established (FORMAT.md). The respawn follows 5.0–6.8 s
  later **(corpus, [E:respawn-gap])**, at a start square that is not always
  the player's original one; the choice rule is not known **(owner)**.

## Shells

- A shell damages any tank it hits, allied tanks included **(owner)**.
- A shell kills the man in one hit, but only if it falls very near him or
  hits a forest square he is standing in; otherwise it flies over him
  harmlessly **(owner)**.
- A **live pillbox stops a shell; a dead pillbox does not** **(owner)**.
  This settles FORMAT.md's [E:shell-passthrough], which had reached the same
  conclusion tentatively: the apparent pass-throughs were shell identity
  errors.
- Friendly and neutral bases do not block shells. A hostile base blocks them
  when its armour is above a threshold whose value is not known **(owner)**.
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
- **Anger.** A pill's fire rate rises when it is hit, roughly doubling per
  hit, and decays slowly back to normal **(owner, unsure)**. In WinBolo the
  delay between shots is 100 at rest and 6 when fully angry, in units that
  make 100 about two seconds, so the unit is very probably the 50 Hz tick
  and the angriest pill fires about 8 times a second **(owner, unsure)**.
  The "speed" byte in the `F1 02` pill list is this delay, normally 6–100
  **(owner)**. The shell matcher's working bound of "an angry pill fires at
  most every 5 or 6 ticks" in `viewer/motion.js` agrees.
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
  **(corpus, [E:base-tick])**. A shell hit removes 5 armour (`An`).
- **Capture.** A neutral base is captured by driving over it **(owner)**. A
  hostile base must first be shot down to near zero armour; whether it must
  be exactly zero is not known **(owner)**. Only a neutral or hostile base
  can be captured **(corpus, [E:owner-signals])**.
- **Refuelling.** A base refuels its owner's tank and any ally's **(owner;
  corpus)**. The tank need not be stopped, only stay on the square; slow
  motion is fine **(owner)**. In WinBolo a tank goes from empty to 40/40/full
  in about 20 seconds, probably close to Bolo **(owner, unsure)**. Each unit
  transferred is logged as a `Bn`, `Cn` or `Dn` drain, even into a full tank
  **(corpus, [E:ammo-clamp])**.
- A base does nothing hostile to an enemy tank beyond blocking its path while
  it has armour **(owner)**.
- A base's square behaves as road whatever the map says beneath it
  **(corpus, [E:base-road])**.

## The man (LGM)

- **What he does.** Harvest a tree (forest becomes grass, yielding wood),
  build a road, build a building (wall), build a boat (river only), build or
  repair a pillbox, plant a mine **(owner)**. Costs in wood: pillbox 1, road
  about 0.5, boat about 5, building not known **(owner, unsure)**. Once he
  is at the square the action itself is very fast **(owner)**; exact
  durations are an open measurement.
- **Movement.** He is blocked by everything that blocks a tank, is slowed by
  swamp and crater, and cannot cross river; he cannot swim **(owner)**. He
  may be able to enter a boat but cannot use it **(owner, unsure)**. His
  walking speed and terrain factors are an open measurement.
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
  of the death **(owner)**; the parachute rides the `b=4` position
  subpacket. How long it takes is an open measurement.
- **Sending him from a boat.** A mine cannot be laid by a tank in a boat,
  but the man can be sent ashore from a boat adjacent to land to plant one
  **(owner)**.

## Terrain

- **Mines** can lie on swamp, crater, road, forest, rubble and grass
  **(corpus, FORMAT.md Terrain)**. Almost all games disallowed hidden mines;
  who sees a mine when they are allowed, allies included, is not known
  **(owner)**.
- **Forest regrowth** is not limited to grass: trees grow back on most land
  squares except impassable ones **(owner)**. Each client probably simulates
  its own growth, so the rate would scale with player count as base stocks
  do **(owner, unsure)**; the rate is an open measurement. Regrowth is
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

Things the owner says a replay could settle, in the order they would help
the viewer most. Each is a candidate corpus tool in the style of
`tools/measure-*.cjs`.

1. Minimum interval between a tank's `5d` events (expected about 12–13
   ticks).
2. Tank turning rate by terrain, from consecutive direction nibbles.
3. The tank speed byte: its unit, its maximum, and its relation to the
   terrain ratios above.
4. Pill fire cadence versus recent damage, to confirm the 100-to-6 delay
   and its decay (the `speed` byte in `F1 02` gives the starting value).
5. Tank armour integration: count `FC` hits and `Dn` drains per life against
   `F9` deaths, allowing 2 per mine and a slow river drain of ammo.
6. Man walking speed by terrain, and the duration of each build action, from
   LGM position restatements against the terrain events they produce.
7. Parachute duration, from the `b=4` records to the man's first ordinary
   position.
8. Forest regrowth rate per player-tick, from `6 5` events.
9. Base refuel rate, from the spacing of drains while a tank sits on a base.
10. The armour threshold at which a hostile base blocks shells, from `An`
    hits versus shells passing over base squares.
11. The exact hidden-in-trees rule, from the hidden bit against the tank's
    pixel position within forest.
12. Whether a hostile base must be exactly 0 to capture, from base armour at
    each `FF 6n`.
