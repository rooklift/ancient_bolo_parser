/* Replay engine: builds a playable world state timeline from parsed Bolo log
 * records. No DOM use — also loadable in node for tests. */
"use strict";
(function () {

const MAP_SIZE = 256;
const DEEP_SEA = 255;
const TICKS_PER_SECOND = 50;
const KEYFRAME_EVERY = 2000; /* records between state snapshots, for seeking */
/* Moving objects normally restate at about four packets per second. Beyond
 * half a second the path between two positions is no longer trustworthy:
 * hold the last known point instead of drawing a made-up line through lag. */
const MAX_POSITION_INTERPOLATION_TICKS = TICKS_PER_SECOND / 2;
const MAX_LGM_TANK_ENTRY_DISTANCE_PIXELS = 32;

const NEUTRAL = 16;
const GONE = -2; /* inTank value: pill left the game with a quitting carrier */

/* Subpacket types of map-transfer / node records, which appear alone and
 * carry no player state (see the shell-clearing rule in apply_record). */
const MAP_NODE_TYPES = new Set([
	"node_id", "map_run", "map_terrain_request", "map_header_request",
	"game_info", "pillbox_list", "base_list", "start_list", "history",
	"attached_log",
]);

/* Serpentine search path used when a dying tank's carried pills are dumped
 * around the death square (from Carl Osterwald's notes; first ring exact,
 * outer rings continue the same clockwise pattern until the map is
 * exhausted). Yields (dx, dy) offsets from the death square, in placement
 * order: each ring starts one square left of its NE-ward corner, runs the
 * top edge eastward, then clockwise round the other three edges. */
function* dump_path() {
	yield [0, 0];
	for (let r = 1; r < MAP_SIZE; r++) {
		for (let x = -(r - 1); x <= r; x++) yield [x, -r];
		for (let y = -(r - 1); y <= r; y++) yield [r, y];
		for (let x = r - 1; x >= -r; x--) yield [x, r];
		for (let y = r - 1; y >= -r; y--) yield [-r, y];
	}
}

/* Optionally seeded with extract_initial_map()'s result so the world has
 * full terrain from tick zero (the log's own map transfer trickles in over
 * the first seconds). */
function initial_state(seed) {
	let grid;
	if (seed) {
		grid = seed.grid.slice();
		/* A mine under a square where a pillbox starts the game does not
		 * exist in the game, even though the transferred map data carries
		 * it (observed in real replays): demine those squares. The seed
		 * itself is left untouched so "save initial map" keeps the mine. */
		for (const p of seed.pills) {
			const i = p.y * MAP_SIZE + p.x;
			if (grid[i] >= 10 && grid[i] <= 15) grid[i] -= 8;
		}
	} else {
		grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
		grid.fill(DEEP_SEA);
	}
	return {
		grid,
		gridVersion: 0,
		/* the F102/F103/F104 lists at the top of the log re-apply over
		 * these seeds with full fidelity (carried-pill sentinels etc.) */
		pills: seed ? seed.pills.map(p => ({ ...p, inTank: null })) : [],
		bases: seed ? seed.bases.map(b => ({ ...b })) : [],
		starts: seed ? seed.starts.map(st => ({ x: st.x, y: st.y, direction: st.dir })) : [],
		tanks: Array.from({ length: 16 }, () => null),
			/* {x, y, px, py, dir, inBoat, hidden, dying, speed, lastSeen, position_time} */
		men: Array.from({ length: 16 }, () => null),
			/* {x, y, px, py, parachute, carryingPill, lastSeen, position_time} */
		shells: Array.from({ length: 16 }, () => []),
			/* [{x, y, px, py, direction}] — full restatement per record */
		names: Array.from({ length: 16 }, () => null),
		alliances: Array.from({ length: 16 }, (_, i) => 0xffff & ~(1 << i)),
			/* bitmasks, 0 bit = allied (log convention) */
		present: Array.from({ length: 16 }, () => false),
		quit: Array.from({ length: 16 }, () => false),
		gameInfo: null,
	};
}

function clone_state(s) {
	return {
		grid: s.grid.slice(),
		gridVersion: s.gridVersion,
		pills: s.pills.map(p => ({ ...p })),
		bases: s.bases.map(b => ({ ...b })),
		starts: s.starts.map(st => ({ ...st })),
		tanks: s.tanks.map(t => t && { ...t }),
		men: s.men.map(m => m && { ...m }),
		shells: s.shells.map(list => list.map(sh => ({ ...sh }))),
		names: s.names.slice(),
		alliances: s.alliances.slice(),
		present: s.present.slice(),
		quit: s.quit.slice(),
		gameInfo: s.gameInfo,
	};
}

function set_terrain(s, x, y, t) {
	if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return;
	const i = y * MAP_SIZE + x;
	if (s.grid[i] !== t) {
		s.grid[i] = t;
		s.gridVersion++;
	}
}

/* Add a mine to a square (terrain codes 2-7 have mined variants at +8). */
function mine_square(s, x, y) {
	const t = s.grid[y * MAP_SIZE + x];
	if (t >= 2 && t <= 7) set_terrain(s, x, y, t + 8);
}

function base_at(s, x, y) {
	return s.bases.some(b => b.x === x && b.y === y);
}

function pill_at(s, x, y) {
	return s.pills.some(p => p.inTank === null && p.x === x && p.y === y);
}

/* The square a tank occupies for game purposes (laying mines, dumping
 * pills) is the one containing its centre — the record's (X, Y) is the
 * 16px character's top-left square, half a square away ~75% of the time.
 * Verified: every post-F7 terrain event lands on the centre square, none
 * on the character square. */
function tank_square(t) {
	return { x: (t.x * 16 + t.px + 8) >> 4, y: (t.y * 16 + t.py + 8) >> 4 };
}

/* Each dying-position update clears forest squares touched by a
 * 15x15 pixel box around the tank centre: a square is touched when its
 * nearest pixel lies within 7 pixels on BOTH axes. Chebyshev, not
 * Euclidean — the corners are cleared too, and they matter. Integer
 * comparisons only, no multiplication. See FORMAT.md [E:forest-circle]. */
function* death_clearance_squares(t) {
	const cx = t.x * 16 + t.pixelX + 8;
	const cy = t.y * 16 + t.pixelY + 8;
	for (let sy = (cy - 7) >> 4; sy <= (cy + 7) >> 4; sy++) {
		for (let sx = (cx - 7) >> 4; sx <= (cx + 7) >> 4; sx++) {
			const dx = Math.max(sx * 16 - cx, cx - (sx * 16 + 15), 0);
			const dy = Math.max(sy * 16 - cy, cy - (sy * 16 + 15), 0);
			if (dx <= 7 && dy <= 7) yield [sx, sy];
		}
	}
}

function superboom(s, x, y) {
	for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
		const sx = x + dx, sy = y + dy;
		if (sx >= MAP_SIZE || sy >= MAP_SIZE) continue;
		const t = s.grid[sy * MAP_SIZE + sx];
		/* Water, bases and pillbox squares keep their terrain; the pill
		 * damage below still lands. See FORMAT.md [E:crater-pill]. */
		if (t !== DEEP_SEA && t !== 1 && t !== 9 && !base_at(s, sx, sy) && !pill_at(s, sx, sy)) {
			set_terrain(s, sx, sy, 3); /* crater */
		}
		for (const p of s.pills) {
			if (p.inTank === null && p.x === sx && p.y === sy) {
				p.armour = Math.max(0, p.armour - 4);
			}
		}
	}
}

/* Terrain a dumped (dead) pill can sit on: not a wall, not water. */
function pill_dumpable(s, x, y) {
	if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return false;
	const t = s.grid[y * MAP_SIZE + x];
	if (t === DEEP_SEA || t === 0 || t === 1 || t === 8 || t === 9) return false;
	return !pill_at(s, x, y) && !base_at(s, x, y);
}

function dump_carried_pills(s, player, x, y) {
	let carried = s.pills.filter(p => p.inTank === player);
	/* A man out of the tank carrying a pill (status C) has it in his
	 * hands, not in the exploding tank: the lowest-index carried pill
	 * (the one a plant would use) stays with him. Verified: every
	 * engine no-op plant in the fixture followed a tank death with the
	 * man out carrying — the man went on to plant that pill. */
	if (s.men[player] && s.men[player].carryingPill && carried.length) {
		carried = carried.slice(1);
	}
	const path = dump_path(); /* shared iterator: the search never backtracks */
	for (const p of carried) {
		let placed = false;
		let it;
		/* not for...of: break would close the shared generator */
		while (!(it = path.next()).done) {
			const [dx, dy] = it.value;
			if (pill_dumpable(s, x + dx, y + dy)) {
				p.inTank = null;
				p.x = x + dx;
				p.y = y + dy;
				p.armour = 0; /* dumped pills are dead */
				placed = true;
				break;
			}
		}
		if (!placed) { /* every square on the map blocked: death square regardless */
			p.inTank = null;
			p.x = x;
			p.y = y;
			p.armour = 0;
		}
	}
}

/* Lowest-index pill carried by this player (Bolo's plant convention). */
function lowest_carried(s, player) {
	for (const p of s.pills) {
		if (p.inTank === player) return p;
	}
	return null;
}

/* Apply one parsed record to the state. `effects` and `chat`, when given,
 * collect transient events (for rendering) and messages. */
function apply_record(s, rec, effects, chat) {
	const pl = rec.player;
	let sawShells = false;
	let newShells = null;

	/* Standalone map/node records carry no player state at all — they must
	 * not clear the sender's man or shells, or feed status bits. */
	const mapNodeOnly = rec.subpackets.length > 0 && rec.subpackets.every(sub => MAP_NODE_TYPES.has(sub.type));

	/* The sender's tank as of the PREVIOUS record (tank_position replaces
	 * the object, so this snapshot survives): a quit record can restate a
	 * bogus far-away position, but its pills drop at the last genuine one. */
	const tankBefore = s.tanks[pl];

	/* ANY record from a player proves the player is alive — stationary
	 * tanks restate their position much less often, so liveness must not
	 * ride on position freshness alone. */
	if (rec.tankStatus !== 0x0f && s.tanks[pl]) {
		s.tanks[pl].lastSeen = rec.time;
	}

	/* Every record restates the sender's LGM state in the status nibble:
	 * bits clear means the man is in the tank, so remove him from the
	 * world (a man-position subpacket below re-adds him). */
	if (rec.tankStatus !== 0x0f && !mapNodeOnly && (rec.status & 0x0c) === 0) {
		s.men[pl] = null;
	}

	/* The tank-status nibble and direction are likewise live on every
	 * record, position or not: 99.8% of position-less flag changes and
	 * 99.3% of steady-course directions are confirmed by the sender's
	 * next position record. T=7 (joining/dead) and T=F (attached log)
	 * carry no tank state; a position subpacket below overwrites all of
	 * this anyway. */
	if (rec.tankStatus !== 0x0f && rec.tankStatus !== 0x07 && !(rec.tankStatus & 0x08) && s.tanks[pl]) {
		const t = s.tanks[pl];
		t.inBoat = !!(rec.tankStatus & 0x01);
		t.hidden = !!(rec.tankStatus & 0x02);
		t.dying = !!(rec.tankStatus & 0x04);
		t.dir = rec.tankDir;
	}

	for (const sub of rec.subpackets) {
		switch (sub.type) {
			case "tank_position":
				s.tanks[pl] = {
					x: sub.x, y: sub.y, px: sub.pixelX, py: sub.pixelY,
					dir: sub.direction, inBoat: sub.inBoat, hidden: sub.hidden,
					dying: sub.dying, speed: sub.speed, lastSeen: rec.time,
					position_time: rec.time,
					/* positions with the dying bit are death-animation flames,
					 * not a live tank; only a normal position is a respawn */
					dead: sub.dying ? (s.tanks[pl] ? s.tanks[pl].dead : false) : false,
				};
				s.present[pl] = true;
				if (sub.dying) {
					/* the dying-bit positions are the wreck's flames (the
					 * notes call the C packets "flameage"): draw them, so
					 * the sliding wreck is visible burning its way along */
					if (effects) effects.push({ time: rec.time, type: "flame", x: sub.x, y: sub.y, px: sub.pixelX, py: sub.pixelY });
					/* Forest clearing has no terrain event. Apply the same
					 * strict integer box at every wreck/flame position. */
					for (const [sx, sy] of death_clearance_squares(sub)) {
						if (sx < 0 || sy < 0 || sx >= MAP_SIZE || sy >= MAP_SIZE) continue;
						/* Bolo's terrain lookup appears to see the pillbox
						 * overlay rather than forest beneath it. This exception
						 * is only for the inferred, eventless wreck clearance;
						 * explicit terrain events still affect pill squares. */
						if (pill_at(s, sx, sy)) continue;
						const ter = s.grid[sy * MAP_SIZE + sx];
						if (ter === 5) set_terrain(s, sx, sy, 7);
						else if (ter === 13) set_terrain(s, sx, sy, 15);
					}
				}
				break;
			case "lgm_position":
			case "parachute_position":
				s.men[pl] = {
					x: sub.x, y: sub.y, px: sub.pixelX, py: sub.pixelY,
					parachute: sub.type === "parachute_position",
					carryingPill: sub.carryingPill, lastSeen: rec.time,
					position_time: rec.time,
				};
				break;
			case "shells": {
				/* A record can carry SEVERAL shell-list subpackets (up to 12
				 * seen in the sample log): the sender's own shells plus those
				 * of pillboxes it is currently simulating — Bolo hands a
				 * pill's simulation to the machine it is shooting at, which
				 * is why pill shells ride in the TARGET's restatements.
				 * Lists concatenate; each offset is chained from the previous
				 * shell in its own list. */
				sawShells = true;
				if (newShells === null) newShells = [];
				const list_direction = sub.direction ?? sub.shells[0].direction;
				for (let i = 0; i < sub.shells.length; i++) {
					const sh = sub.shells[i];
					if (i === 0) {
						newShells.push({
							x: sh.x, y: sh.y, px: sh.pixel & 0x0f, py: sh.pixel >> 4,
							direction: list_direction,
						});
					} else {
						/* additional shells: signed pixel offsets CHAINED
						 * from the PREVIOUS shell in the list, not the
						 * first (verified: when a pill's new shot becomes
						 * the list head, first-relative decoding conjures
						 * a phantom shell and loses the real one; chained
						 * decoding reconstructs both to the pixel). The list's
						 * direction nibble applies to every shell in it. */
						const prev = newShells[newShells.length - 1];
						const wx = prev.x * 16 + prev.px + sub.shells[i].offsetX;
						const wy = prev.y * 16 + prev.py + sub.shells[i].offsetY;
						newShells.push({
							x: (wx >> 4) & 0xff, y: (wy >> 4) & 0xff, px: wx & 0x0f, py: wy & 0x0f,
							direction: list_direction,
						});
					}
				}
				break;
			}
			case "shot_fired":
				/* no visual, same as pillbox_fires: the shell itself suffices */
				break;
			case "terrain_change": {
				/* Tree-growth events report plain forest even when the grass
				 * already contains a mine. Preserve that mine in this one
				 * transition; all other terrain changes remain authoritative. */
				let old_terrain = s.grid[sub.y * MAP_SIZE + sub.x];
				let terrain = old_terrain === 15 && sub.terrain === 5 ? 13 : sub.terrain;
				set_terrain(s, sub.x, sub.y, terrain);
				break;
			}
			case "explosion":
				if (sub.code === 0x0b) {
					if (effects) effects.push({ time: rec.time, type: "boom", x: sub.x, y: sub.y });
				} else if (sub.code === 0x0c) {
					mine_square(s, sub.x, sub.y);
				} else if (sub.code === 0x0d) {
					superboom(s, sub.x, sub.y);
					if (effects) effects.push({ time: rec.time, type: "superboom", x: sub.x, y: sub.y });
				} else {
					/* Bolo's single-crater primitive spares open water: a 7 3 on
					 * river or deep sea changes nothing, though a boat square does
					 * crater (and then floods). A dying tank's terminal crater is
					 * sent whatever lies under the wreck, so playback must apply
					 * the rule itself. See FORMAT.md [E:crater-water]. It spares a
					 * square holding a grounded pillbox too, dead or alive, exactly
					 * as the superboom does [E:crater-pill]. */
					const under = s.grid[sub.y * MAP_SIZE + sub.x];
					const spared = under === 1 || under === DEEP_SEA || pill_at(s, sub.x, sub.y);
					if (sub.code !== 3 || !spared) {
						set_terrain(s, sub.x, sub.y, sub.code);
					}
					if (effects) effects.push({ time: rec.time, type: "boom", x: sub.x, y: sub.y });
				}
				break;
			case "pillbox_damage": {
				const p = s.pills[sub.pillbox];
				if (p) {
					p.armour = Math.max(0, p.armour - 1);
					if (effects && p.inTank === null) effects.push({ time: rec.time, type: "pill_hit", x: p.x, y: p.y });
				}
				break;
			}
			case "base_damage": {
				const b = s.bases[sub.base];
				if (b) {
					b.armour = Math.max(0, b.armour - 5);
					if (effects) effects.push({ time: rec.time, type: "boom", x: b.x, y: b.y });
				}
				break;
			}
			case "base_drain": {
				const b = s.bases[sub.base];
				if (b) {
					if (sub.resource === "shells") b.shells = Math.max(0, b.shells - 1);
					else if (sub.resource === "mines") b.mines = Math.max(0, b.mines - 1);
					else if (sub.resource === "armor") b.armour = Math.max(0, b.armour - 1);
				}
				break;
			}
			case "base_stock_tick":
				for (const b of s.bases) {
					b.shells = Math.min(90, b.shells + 1);
					b.mines = Math.min(90, b.mines + 1);
					b.armour = Math.min(90, b.armour + 1);
				}
				break;
			case "pillbox_fires": {
				let p = s.pills[sub.pillbox];
				if (p && effects) effects.push({ time: rec.time, type: "pill_fire", x: p.x, y: p.y });
				break;
			}
			case "board_boat": {
				/* the sender's own T boat bit only catches up a few ticks
				 * later; flip it now so pausing on the event looks right.
				 * The consumed boat's square reverts to plain river — the
				 * log sends no terrain event for this (all 38 sample
				 * boardings sit on terrain 9 with no accompanying 6T) */
				const t = s.tanks[pl];
				if (t) {
					t.inBoat = true;
					const sq = tank_square(t);
					if (s.grid[sq.y * MAP_SIZE + sq.x] === 9) set_terrain(s, sq.x, sq.y, 1);
				}
				break;
			}
			case "pill_pickup": {
				/* Picking a pill up captures it THEN, not at the later
				 * plant: verified in a real game where a dead pill was
				 * picked up, dumped by the captor's dying tank, repaired
				 * in place by the captor's ally, and then fired on its
				 * former owner's team. */
				const p = s.pills[sub.pillbox];
				if (p) { p.inTank = pl; p.owner = pl; }
				break;
			}
			case "pill_plant": {
				const p = lowest_carried(s, pl);
				if (p) {
					p.inTank = null;
					p.x = sub.x;
					p.y = sub.y;
					p.owner = pl;
					p.armour = 15;
				}
				break;
			}
			case "pill_dumped_by_dead_lgm": {
				const p = lowest_carried(s, pl);
				if (p) {
					p.inTank = null;
					p.x = sub.x;
					p.y = sub.y;
					p.armour = 0;
				}
				/* no F5 is sent in this case, so the man dies here */
				if (s.men[pl] && !s.men[pl].parachute) s.men[pl] = null;
				if (effects) effects.push({ time: rec.time, type: "lgm_death", x: sub.x, y: sub.y, player: pl });
				break;
			}
			case "pill_repair_4":
			case "pill_repair_8":
			case "pill_repair_12":
			case "pill_repair_full": {
				const p = s.pills[sub.pillbox];
				if (p) {
					const add = { pill_repair_4: 4, pill_repair_8: 8, pill_repair_12: 12, pill_repair_full: 15 }[sub.type];
					p.armour = Math.min(15, p.armour + add);
					/* Repairs never change ownership — verified in a real
					 * game: a player full-repaired a dead ENEMY pill and it
					 * resumed firing at his own team. Capture happens at
					 * pickup (see pill_pickup). */
				}
				break;
			}
			case "base_capture": {
				const b = s.bases[sub.base];
				if (b) b.owner = pl;
				break;
			}
			case "tank_death": {
				const t = s.tanks[pl];
				if (t) {
					const sq = tank_square(t);
					if (effects) effects.push({ time: rec.time, type: "tank_death", x: sq.x, y: sq.y, code: sub.code, player: pl });
					dump_carried_pills(s, pl, sq.x, sq.y);
					t.dead = true; /* hidden until a non-dying position (respawn) */
				}
				s.shells[pl] = [];
				break;
			}
			case "tank_hit":
				if (effects && s.tanks[sub.tank]) {
					const t = s.tanks[sub.tank];
					effects.push({ time: rec.time, type: "tank_hit", x: t.x, y: t.y, px: t.px, py: t.py, player: sub.tank });
				}
				break;
			case "lgm_death":
				/* the same record restates the dying man's position (b=8,
				 * applied above), so clear him here; the replacement's
				 * parachute arrives in later records */
				if (s.men[pl] && !s.men[pl].parachute) s.men[pl] = null;
				if (effects) effects.push({ time: rec.time, type: "lgm_death", x: sub.x, y: sub.y, player: pl });
				break;
			case "shell_falls":
				if (effects) effects.push({ time: rec.time, type: "splash", x: sub.x, y: sub.y, px: sub.pixel & 0x0f, py: sub.pixel >> 4 });
				break;
			case "lay_mine": {
				const t = s.tanks[pl];
				if (t) {
					const sq = tank_square(t);
					mine_square(s, sq.x, sq.y);
				}
				break;
			}
			case "node_id": {
				/* F8 is join, rename, AND periodic re-identification (all
				 * players restate their ids when someone joins): only a
				 * genuinely new player is a join, only a changed name is a
				 * rename, restatements are silent. Chat events snapshot
				 * name/team as of the event, so seeking rebuilds an
				 * identical history. */
				const old = s.quit[pl] ? null : s.names[pl];
				if (s.quit[pl]) {
					/* slot reused by a new (or returning) player: they do
					 * not inherit the previous occupant's alliances */
					s.alliances[pl] = 0xffff & ~(1 << pl);
					for (let i = 0; i < 16; i++) {
						if (i !== pl) s.alliances[i] |= (1 << pl);
					}
				}
				s.names[pl] = sub.name;
				s.present[pl] = true;
				s.quit[pl] = false;
				if (chat && old === null) {
					chat.push({ time: rec.time, player: pl, join: true, text: sub.name });
				} else if (chat && old !== sub.name) {
					chat.push({ time: rec.time, player: pl, rename: true, from: old, text: sub.name, team: team_of(s, pl) });
				}
				break;
			}
			case "message":
				if (chat) chat.push({ time: rec.time, player: pl, address: sub.address, text: sub.text, name: s.names[pl], team: team_of(s, pl) });
				break;
			case "game_info":
				s.gameInfo = sub;
				for (let i = 0; i < 16; i++) s.alliances[i] = sub.alliances[i];
				break;
			case "pillbox_list":
				s.pills = sub.items.map(p => ({
					x: p.x, y: p.y,
					owner: p.owner > 15 ? NEUTRAL : p.owner,
					/* pills carried when logging started have armour 0xFF */
					armour: p.armour === 0xff ? 15 : Math.min(15, p.armour),
					speed: p.speed,
					inTank: p.armour === 0xff ? p.owner & 0x0f : null,
				}));
				break;
			case "base_list":
				s.bases = sub.items.map(b => ({
					x: b.x, y: b.y,
					owner: b.owner > 15 ? NEUTRAL : b.owner,
					armour: Math.min(90, b.armour), shells: Math.min(90, b.shells), mines: Math.min(90, b.mines),
				}));
				break;
			case "start_list":
				s.starts = sub.items.map(st => ({ x: st.x, y: st.y, direction: st.direction }));
				break;
			case "map_run":
				/* terrain is pre-seeded from extract_initial_map(); applying
				 * runs here could overwrite earlier in-game terrain changes
				 * with stale data (both at log start and on a rejoin's
				 * re-transfer), so they are deliberately ignored */
				break;
			case "quit":
				s.quit[pl] = true;
				s.men[pl] = null;
				s.shells[pl] = [];
				/* Pills a quitter carries are dumped on the ground around
				 * the last tank position, tank-death style, with no events
				 * (verified: in two mid-game quits-while-carrying, the
				 * pills were picked up later within a tile of the
				 * quitter's last tank centre — in one case both at once,
				 * lying together). With no known tank position they leave
				 * the game (GONE). Planted pills and alliance links stay:
				 * his pills keep their allegiance until the slot is
				 * reused. */
				{
					/* dump at the pre-record position: a ghost-split quit
					 * record was seen restating a position 50 tiles from
					 * where the pills verifiably dropped */
					const t = tankBefore || s.tanks[pl];
					if (t) {
						const sq = tank_square(t);
						dump_carried_pills(s, pl, sq.x, sq.y);
					}
				}
				for (const p of s.pills) {
					if (p.inTank === pl) p.inTank = GONE;
				}
				s.tanks[pl] = null;
				if (chat) chat.push({ time: rec.time, player: pl, quit: true, name: s.names[pl], team: team_of(s, pl) });
				break;
			case "alliance_request":
				break;
			case "alliance_accept":
				/* SET bits name the accepted party (verified empirically —
				 * the opposite convention from the game-info alliance words,
				 * where zero bits mark allies). Accepting one member of an
				 * alliance joins you to ALL of it, but the log only events
				 * the single pairwise link (verified: a real 3v3's only
				 * accepts were A↔B and B↔C on each side, with no direct A↔C
				 * event), so merge the two sides' existing alliance groups
				 * into a full clique. */
				for (let i = 0; i < 16; i++) {
					if (i !== pl && (sub.tanks & (1 << i))) {
						const group = new Set([pl, i]);
						for (const seedPlayer of [pl, i]) {
							for (let j = 0; j < 16; j++) {
								const mutual = !(s.alliances[seedPlayer] & (1 << j)) && !(s.alliances[j] & (1 << seedPlayer));
								if (mutual) group.add(j);
							}
						}
						for (const a of group) {
							for (const b of group) {
								if (a !== b) {
									s.alliances[a] &= ~(1 << b);
									s.alliances[b] &= ~(1 << a);
								}
							}
						}
					}
				}
				break;
			case "alliance_leave": {
				/* Manual: "Any pillboxes he is carrying at the time are his,
				 * but any active ones on the map remain with the members of
				 * the alliance." Reassign planted pills to the lowest-index
				 * remaining ally before severing the links. (Bases are not
				 * mentioned and keep their owner.) */
				let heir = -1;
				for (let i = 0; i < 16; i++) {
					const mutual = i !== pl && !(s.alliances[pl] & (1 << i)) && !(s.alliances[i] & (1 << pl));
					if (mutual && !s.quit[i] && (s.present[i] || s.names[i] !== null)) { heir = i; break; }
				}
				if (heir >= 0) {
					for (const p of s.pills) {
						if (p.owner === pl && p.inTank === null) p.owner = heir;
					}
				}
				s.alliances[pl] = 0xffff & ~(1 << pl);
				for (let i = 0; i < 16; i++) {
					if (i !== pl) s.alliances[i] |= (1 << pl);
				}
				break;
			}
		}
	}

	if (sawShells) {
		s.shells[pl] = newShells;
	} else if (rec.tankStatus !== 0x0f && !mapNodeOnly) {
		/* EVERY record restates all shells its sender simulates, whatever
		 * its shape — verified: of 743 in-flight shells crossing a
		 * list-less record of any kind, zero reappear afterwards — so no
		 * list means none in flight. Map/node records are excepted: they
		 * appear alone, never carry lists, and have never been seen while
		 * their sender had shells in flight. */
		s.shells[pl] = [];
	}
}

/* Reconstruct the map's earliest known state: each square's FIRST
 * run-supplied value, ignoring any square gameplay has already modified
 * (a rejoin's re-sent map data includes accumulated battle damage, so
 * later runs only fill squares never seen and never touched). Object
 * lists come from the first F102/F103/F104. Returns the shape
 * BoloMap.serialize_map expects. */
function extract_initial_map_pass(records, death_pill_squares) {
	const grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
	grid.fill(DEEP_SEA);
	const written = new Uint8Array(MAP_SIZE * MAP_SIZE);
	const tainted = new Uint8Array(MAP_SIZE * MAP_SIZE);
	let pills = null, bases = null, starts = null;
	let badRuns = 0;
	const tanks = {};

	const taint = (x, y) => {
		if (x >= 0 && y >= 0 && x < MAP_SIZE && y < MAP_SIZE) tainted[y * MAP_SIZE + x] = 1;
	};

	for (const rec of records) {
		for (const sub of rec.subpackets) {
			switch (sub.type) {
				case "pillbox_list":
					if (!pills) pills = sub.items;
					break;
				case "base_list":
					if (!bases) bases = sub.items;
					break;
				case "start_list":
					if (!starts) starts = sub.items;
					break;
				case "tank_position": {
					tanks[rec.player] = sub;
					if (sub.dying) {
						/* eventless forest clearing at tank death (see
						 * apply_record): every wreck position uses the same
						 * strict 15x15 integer box, except where a pill
						 * masks the underlying terrain */
						const masked = death_pill_squares && death_pill_squares.get(sub);
						for (const [sx, sy] of death_clearance_squares(sub)) {
							if (!masked || !masked.has(sy * MAP_SIZE + sx)) taint(sx, sy);
						}
					}
					break;
				}
				case "map_run": {
					const bytes = sub.run;
					const y = bytes[1], startx = bytes[2], endx = bytes[3];
					const nibs = [];
					for (let i = 4; i < bytes.length; i++) nibs.push(bytes[i] >> 4, bytes[i] & 0x0f);
					let x = startx, i = 0;
					const put = t => {
						const k = y * MAP_SIZE + x;
						if (x < MAP_SIZE && !written[k] && !tainted[k]) { grid[k] = t; written[k] = 1; }
						x++;
					};
					while (x < endx && i < nibs.length) {
						const code = nibs[i++];
						if (code >= 8) {
							if (i >= nibs.length) break; /* repeat code with its
							    terrain nibble truncated off: stop rather than
							    write pad/undefined (= building) squares */
							const t = nibs[i++];
							for (let k = 0; k < code - 6 && x < endx; k++) put(t);
						} else {
							for (let k = 0; k < code + 1 && i < nibs.length && x < endx; k++) put(nibs[i++]);
						}
					}
					/* a run whose payload ran out before endx claimed tiles
					 * it never supplied — count it rather than fail silently */
					if (x < endx) badRuns++;
					break;
				}
				case "terrain_change":
					taint(sub.x, sub.y);
					break;
				case "explosion":
					if (sub.code === 0x0d) {
						for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) taint(sub.x + dx, sub.y + dy);
					} else if (sub.code !== 0x0b) {
						taint(sub.x, sub.y);
					}
					break;
				case "lay_mine":
				case "board_boat": {
					/* both change the tank centre square's terrain without
					 * a 6T event (mine laid / boat consumed) */
					const t = tanks[rec.player];
					if (t) taint((t.x * 16 + t.pixelX + 8) >> 4, (t.y * 16 + t.pixelY + 8) >> 4);
					break;
				}
			}
		}
	}

	return {
		grid,
		badRuns,
		pills: (pills || []).map(p => ({
			x: p.x, y: p.y,
			owner: p.owner > 15 ? 16 : p.owner,
			armour: p.armour === 0xff ? 15 : Math.min(15, p.armour),
			speed: p.speed,
		})),
		bases: (bases || []).map(b => ({
			x: b.x, y: b.y,
			owner: b.owner > 15 ? 16 : b.owner,
			armour: Math.min(90, b.armour), shells: Math.min(90, b.shells), mines: Math.min(90, b.mines),
		})),
		starts: (starts || []).map(st => ({ x: st.x, y: st.y, dir: st.direction & 0x0f })),
	};
}

/* Pill dumps are eventless too, so reconstruct them once against a
 * provisional map and use their positions to refine the death-clearance
 * taint mask. Tank positions precede events within a record: pills dumped
 * by that record's F9 begin masking the following dying position. */
function extract_initial_map(records) {
	const provisional = extract_initial_map_pass(records, null);
	const state = initial_state(provisional);
	const death_pill_squares = new WeakMap();
	for (const rec of records) {
		for (const sub of rec.subpackets) {
			if (sub.type === "tank_position" && sub.dying) {
				const occupied = new Set();
				for (const pill of state.pills) {
					if (pill.inTank === null) occupied.add(pill.y * MAP_SIZE + pill.x);
				}
				death_pill_squares.set(sub, occupied);
			}
		}
		apply_record(state, rec, null, null);
	}
	return extract_initial_map_pass(records, death_pill_squares);
}

/* Build the position tracks used only for drawing. `continuous` describes
 * the path from the preceding entry to this one. A death/join state, a tank
 * death, or a quit makes the next position a new path; in particular this
 * prevents interpolation towards the bogus far-away positions sometimes
 * carried by ghost-split quit records. */
function build_tank_positions(records) {
	let tracks = Array.from({ length: 16 }, () => []);
	let active = Array.from({ length: 16 }, () => false);

	for (let rec of records) {
		let pl = rec.player;
		let map_node_only = rec.subpackets.length > 0 &&
			rec.subpackets.every(sub => MAP_NODE_TYPES.has(sub.type));
		let breaks_path = !map_node_only && (rec.tankStatus === 0x07 ||
			rec.subpackets.some(sub => sub.type === "tank_death" || sub.type === "quit"));

		for (let sub of rec.subpackets) {
			if (sub.type !== "tank_position") continue;
			tracks[pl].push({
				time: rec.time,
				pixel_x: sub.x * 16 + sub.pixelX,
				pixel_y: sub.y * 16 + sub.pixelY,
				continuous: active[pl] && !sub.dying && !breaks_path,
			});
			active[pl] = !sub.dying && !breaks_path;
		}
		if (breaks_path) active[pl] = false;
	}

	return tracks;
}

/* LGM paths end when the man enters the tank, dies, or quits. Parachuting
 * and walking are separate paths: interpolating across touchdown would
 * invent motion between two different object states. Unlike the anomalous
 * tank position on a quit record, an LGM death position is trustworthy, so
 * the final walking span may run right up to the death event. */
function build_lgm_positions(records) {
	let tracks = Array.from({ length: 16 }, () => []);
	let active = Array.from({ length: 16 }, () => false);
	let parachuting = Array.from({ length: 16 }, () => false);
	let tanks = Array.from({ length: 16 }, () => null);

	for (let rec of records) {
		let pl = rec.player;
		let map_node_only = rec.subpackets.length > 0 &&
			rec.subpackets.every(sub => MAP_NODE_TYPES.has(sub.type));
		let enters_tank = rec.tankStatus !== 0x0f && !map_node_only &&
			(rec.status & 0x0c) === 0;
		let quits = rec.subpackets.some(sub => sub.type === "quit");

		for (let sub of rec.subpackets) {
			if (sub.type !== "tank_position") continue;
			tanks[pl] = {
				pixel_x: sub.x * 16 + sub.pixelX,
				pixel_y: sub.y * 16 + sub.pixelY,
			};
		}

		/* A status change to "in tank" supplies the missing endpoint of the
		 * walking path. Logs consistently put the last man position within two
		 * squares of the tank, so animate to the tank instead of holding the man
		 * at his last restatement. Delayed status packets are visually capped by
		 * the normal half-second interpolation window below. */
		if (enters_tank && active[pl] && !parachuting[pl] && tanks[pl]) {
			let last = tracks[pl][tracks[pl].length - 1];
			let dx = tanks[pl].pixel_x - last.pixel_x;
			let dy = tanks[pl].pixel_y - last.pixel_y;
			if (dx * dx + dy * dy <= MAX_LGM_TANK_ENTRY_DISTANCE_PIXELS ** 2) {
				last.tank_entry = {
					time: rec.time,
					pixel_x: tanks[pl].pixel_x,
					pixel_y: tanks[pl].pixel_y,
				};
			}
		}
		if (enters_tank) active[pl] = false;

		for (let sub of rec.subpackets) {
			if (sub.type !== "lgm_position" && sub.type !== "parachute_position") continue;
			let is_parachute = sub.type === "parachute_position";
			tracks[pl].push({
				time: rec.time,
				pixel_x: sub.x * 16 + sub.pixelX,
				pixel_y: sub.y * 16 + sub.pixelY,
				parachute: is_parachute,
				continuous: active[pl] && parachuting[pl] === is_parachute && !quits,
			});
			active[pl] = !quits;
			parachuting[pl] = is_parachute;
		}

		let dies = rec.subpackets.some(sub =>
			sub.type === "lgm_death" || sub.type === "pill_dumped_by_dead_lgm");
		if (enters_tank || dies || quits) active[pl] = false;
	}

	return tracks;
}

/* Build a seekable game from parsed records. */
function build(records) {
	const effects = [];
	const chat = [];
	const keyframes = []; /* {index, state} — state BEFORE records[index] */
	const seed = extract_initial_map(records);
	const tank_positions = build_tank_positions(records);
	const lgm_positions = build_lgm_positions(records);
	let s = initial_state(seed);

	for (let i = 0; i < records.length; i++) {
		if (i % KEYFRAME_EVERY === 0) {
			keyframes.push({ index: i, state: clone_state(s) });
		}
		apply_record(s, records[i], effects, chat);
	}

	return {
		records,
		effects,
		chat,
		keyframes,
		tank_positions,
		lgm_positions,
		badMapRuns: seed.badRuns,
		network: network_conditions(records),
		final: s,
		t0: records.length ? records[0].time : 0,
		t1: records.length ? records[records.length - 1].time : 0,
	};
}

/* Centre position of an object at a possibly fractional replay tick. State
 * reconstruction deliberately remains packet-exact; only this rendering
 * helper looks ahead to the next trustworthy restatement. */
function interpolated_position(track, object, tick) {
	if (!object) return null;

	let pixel_x = object.x * 16 + object.px;
	let pixel_y = object.y * 16 + object.py;
	if (!track || object.position_time === undefined) {
		return { x: pixel_x / 16 + 0.5, y: pixel_y / 16 + 0.5 };
	}

	let lo = 0, hi = track.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (track[mid].time <= tick) lo = mid + 1;
		else hi = mid;
	}
	let index = lo - 1;
	let current = track[index];
	/* The state may have crossed a death/quit without receiving another
	 * position, or may come from a caller-built game. In either case its
	 * packet-exact position is the only safe answer. */
	if (!current || current.time !== object.position_time ||
		current.pixel_x !== pixel_x || current.pixel_y !== pixel_y ||
		(current.parachute !== undefined && current.parachute !== object.parachute)) {
		return { x: pixel_x / 16 + 0.5, y: pixel_y / 16 + 0.5 };
	}

	let next = track[index + 1];
	/* A confirmed tank entry is the LGM path's true final position. Usually
	 * it arrives within the ordinary interpolation window. If its status
	 * packet was delayed, finish the approach within half a second and stop
	 * drawing the already-boarded man instead of leaving him stalled. */
	if (current.tank_entry) {
		let terminal_time = Math.min(current.tank_entry.time,
			current.time + MAX_POSITION_INTERPOLATION_TICKS);
		if (tick >= terminal_time) return null;
		next = {
			time: terminal_time,
			pixel_x: current.tank_entry.pixel_x,
			pixel_y: current.tank_entry.pixel_y,
			continuous: true,
		};
	}
	let duration = next ? next.time - current.time : 0;
	if (next && next.continuous && tick < next.time && duration > 0 &&
		duration <= MAX_POSITION_INTERPOLATION_TICKS) {
		let amount = (tick - current.time) / duration;
		pixel_x += (next.pixel_x - current.pixel_x) * amount;
		pixel_y += (next.pixel_y - current.pixel_y) * amount;
	}

	return { x: pixel_x / 16 + 0.5, y: pixel_y / 16 + 0.5 };
}

function tank_position_at(game, state, player, tick) {
	let track = game.tank_positions && game.tank_positions[player];
	return interpolated_position(track, state.tanks[player], tick);
}

function lgm_position_at(game, state, player, tick) {
	let track = game.lgm_positions && game.lgm_positions[player];
	return interpolated_position(track, state.men[player], tick);
}

/* State at a given tick: nearest keyframe at or before it, replayed forward.
 * Returns { state, index } where index is the first unapplied record. */
function state_at(game, tick) {
	let kf = game.keyframes[0];
	for (const k of game.keyframes) {
		if (k.index < game.records.length && game.records[k.index].time <= tick) kf = k;
		else break;
	}
	const s = clone_state(kf.state);
	let i = kf.index;
	while (i < game.records.length && game.records[i].time <= tick) {
		apply_record(s, game.records[i], null, null);
		i++;
	}
	return { state: s, index: i };
}

/* Find the adjacent moment at which records arrived. Multiple records with
 * the same timestamp form one change, rather than separate playback steps. */
function adjacent_change_time(records, tick, direction) {
	if (records.length === 0) return tick;
	let lo = 0, hi = records.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		let before_boundary = direction < 0 ?
			records[mid].time < tick : records[mid].time <= tick;
		if (before_boundary) lo = mid + 1;
		else hi = mid;
	}
	if (direction < 0) return lo > 0 ? records[lo - 1].time : records[0].time;
	return lo < records.length ? records[lo].time : records[records.length - 1].time;
}

/* ---------- network conditions ---------- */

/* One verdict on how the game's networking held up, for the header.
 *
 * Two readings of the record stream, taken from what the log cannot help
 * recording -- when packets arrived, and how many the machine never saw:
 *
 *   LOSS. The payload's sequence number is bumped by every node a packet
 *   passes, so consecutive records normally step by 1. A step of n means
 *   n-1 packets never reached the logging machine; a step of 0 is a
 *   duplicate, not a loss.
 *
 *   STALL. The share of elapsed time spent in gaps where nothing at all
 *   arrived for over half a second -- a freeze the viewer shows whatever
 *   the player count, since no ring cycles that slowly.
 *
 * Both are read only over the stretch of SETTLED PLAY, and that qualifier
 * carries most of the accuracy here. While the game is still gathering --
 * the map being handed to joiners, nodes arriving -- the ring turns at full
 * speed but the logging machine records only a fraction of it, so the
 * sequence number races ahead and every packet it skips is counted as lost.
 * The join ramp therefore reads as catastrophic loss without a single
 * packet having gone astray. It is short in absolute terms (a median 50 s
 * of a 22-minute log) but so extreme that averaging it in dominates
 * everything else: over the corpus, the share of a log spent ramping
 * predicts its untrimmed loss figure at r = 0.74, and once the ramp is
 * excluded that relationship vanishes entirely (r = -0.02). The tail after
 * the first quit is cut for the same reason, though it matters far less.
 *
 * What survives the correction: loss still rises with player count, a ring
 * gaining a hop per player (median 5.2% at two, 6.6% at four, 8.0% at six),
 * and the two readings still agree at r = 0.80 while disagreeing often
 * enough to be worth keeping both -- a game can be steadily choppy without
 * ever freezing -- so the verdict is the worse of them. What does NOT
 * survive: the apparent year-on-year improvement from 2001 to 2005 was
 * almost entirely faster map transfers shortening the ramp; in settled play
 * the median barely moves (6.7% to 6.0%) [E:seq-loss].
 *
 * Scoring interleaved half-minute blocks as if they were separate games
 * gives r = 0.95 on loss and 0.91 on stall, so this is a property of a
 * session rather than of the moment sampled, and fair to state once for a
 * whole game. The thresholds below place the corpus at roughly 41% good,
 * 42% fair, 10% bad, 6% awful. All of it reproduces with
 * tools/measure-network-conditions.cjs. */

const STALL_GAP_TICKS = TICKS_PER_SECOND / 2;  /* silence that reads as a freeze */
const SEQ_TRUST_TICKS = 250;    /* 5s: past this a step is a rejoin, not loss */
const ABSENCE_TICKS = 1500;     /* 30s: nobody home, not a stalled network */
const SETTLE_BLOCK_TICKS = 500; /* 10s: the grain the join ramp is found on */
const SETTLE_SHARE = 0.7;       /* of a typical block, to count as up to speed */
const MIN_SETTLED_RECORDS = 500;
const LOSS_BANDS = [6, 11, 22];         /* percent of ring slots missing */
const STALL_BANDS = [2, 7, 18];         /* percent of elapsed time frozen */
const CONDITION_NAMES = ["good", "fair", "bad", "awful"];

function band_of(value, bands) {
	let band = 0;
	while (band < bands.length && value >= bands[band]) band++;
	return band;
}

/* The stretch over which the ring was settled and playing: from the point
 * the log's own record rate reaches the plateau it holds for the rest of
 * the game, to the first quit. Falls back to everything when the log is too
 * short or too odd to tell, which costs nothing -- an untrimmable log is
 * one with no ramp to trim. */
function settled_span(records) {
	let t0 = records[0].time;
	let blocks = [];
	for (const rec of records) {
		let b = Math.floor((rec.time - t0) / SETTLE_BLOCK_TICKS);
		blocks[b] = (blocks[b] || 0) + 1;
	}
	let live = [];
	for (const count of blocks) if (count) live.push(count);
	if (live.length < 6) return records;

	live.sort((a, b) => a - b);
	let typical = live[live.length >> 1];
	let start = t0;
	for (let b = 0; b < blocks.length; b++) {
		let here = blocks[b] || 0;
		let next = b + 1 < blocks.length ? (blocks[b + 1] || 0) : here;
		/* two blocks running, so one busy moment inside the ramp cannot
		 * be mistaken for the plateau */
		if (here >= typical * SETTLE_SHARE && next >= typical * SETTLE_SHARE) {
			start = t0 + b * SETTLE_BLOCK_TICKS;
			break;
		}
	}

	let end = records[records.length - 1].time;
	for (const rec of records) {
		if (rec.time <= start) continue;
		if (rec.subpackets.some(s => s.type === "quit")) { end = rec.time; break; }
	}

	let span = records.filter(rec => rec.time >= start && rec.time <= end);
	return span.length >= MIN_SETTLED_RECORDS ? span : records;
}

/* The band a pair of readings falls in, exposed so that measurement tools
 * can rate a stretch of records without going back through the trimmer. */
function network_rating(loss, stall) {
	return CONDITION_NAMES[Math.max(band_of(loss, LOSS_BANDS), band_of(stall, STALL_BANDS))];
}

function network_conditions(records) {
	if (records.length < 2) return null;
	let span = settled_span(records);
	if (span.length < 2) return null;
	let elapsed = span[span.length - 1].time - span[0].time;
	if (elapsed <= 0) return null;

	let missing = 0;     /* ring slots whose packet never arrived */
	let slots = 0;       /* ring slots accounted for either way */
	let frozen = 0;      /* ticks spent hearing nothing at all */

	for (let i = 1; i < span.length; i++) {
		let gap = span[i].time - span[i - 1].time;
		let step = (span[i].seq - span[i - 1].seq) & 0x7f;
		if (gap > STALL_GAP_TICKS && gap <= ABSENCE_TICKS) frozen += gap;
		if (step === 0 || gap > SEQ_TRUST_TICKS) {
			/* a duplicate, or a hole long enough that the 7-bit counter may
			 * have wrapped right round it -- one slot, no loss claimed */
			slots++;
			continue;
		}
		missing += step - 1;
		slots += step;
	}

	let loss = 100 * missing / Math.max(1, slots);
	let stall = 100 * frozen / elapsed;
	return {
		rating: network_rating(loss, stall), loss, stall,
		from: span[0].time, to: span[span.length - 1].time,
	};
}

/* Alliance team id for colouring: lowest player index in the mutual group. */
function team_of(s, player) {
	for (let i = 0; i < 16; i++) {
		if (i === player) return player;
		const mutual = !(s.alliances[player] & (1 << i)) && !(s.alliances[i] & (1 << player));
		if (mutual && (s.present[i] || s.names[i] !== null)) return i;
	}
	return player;
}

const BoloGame = {
	MAP_SIZE, DEEP_SEA, TICKS_PER_SECOND, NEUTRAL, KEYFRAME_EVERY,
	MAX_POSITION_INTERPOLATION_TICKS,
	initial_state, clone_state, apply_record, build, state_at, team_of,
	adjacent_change_time, network_conditions, network_rating,
	tank_position_at, lgm_position_at,
	extract_initial_map,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloGame;
} else {
	window.BoloGame = BoloGame;
}

})();
