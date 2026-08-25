/* Replay engine: builds a playable world state timeline from parsed Bolo log
 * records. No DOM use — also loadable in node for tests. */
"use strict";
(function () {

const MAP_SIZE = 256;
const DEEP_SEA = 255;
const TICKS_PER_SECOND = 50;
const KEYFRAME_EVERY = 2000; /* records between state snapshots, for seeking */

const NEUTRAL = 16;

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
			/* {x, y, px, py, dir, inBoat, hidden, dying, speed, lastSeen} */
		men: Array.from({ length: 16 }, () => null),
			/* {x, y, px, py, parachute, carryingPill, lastSeen} */
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
	if (x >= MAP_SIZE || y >= MAP_SIZE) return;
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

/* The square a tank occupies for game purposes (laying mines, dumping
 * pills) is the one containing its centre — the record's (X, Y) is the
 * 16px character's top-left square, half a square away ~75% of the time.
 * Verified: every post-F7 terrain event lands on the centre square, none
 * on the character square. */
function tank_square(t) {
	return { x: (t.x * 16 + t.px + 8) >> 4, y: (t.y * 16 + t.py + 8) >> 4 };
}

function superboom(s, x, y) {
	for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
		const sx = x + dx, sy = y + dy;
		if (sx >= MAP_SIZE || sy >= MAP_SIZE) continue;
		const t = s.grid[sy * MAP_SIZE + sx];
		if (t !== DEEP_SEA && t !== 1 && t !== 9 && !base_at(s, sx, sy)) {
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
	return !s.pills.some(p => p.inTank === null && p.x === x && p.y === y) && !base_at(s, x, y);
}

function dump_carried_pills(s, player, x, y) {
	const carried = s.pills.filter(p => p.inTank === player);
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

	/* Every record restates the sender's LGM state in the status nibble:
	 * bits clear means the man is in the tank, so remove him from the
	 * world (a man-position subpacket below re-adds him). */
	if (rec.tankStatus !== 0x0f && (rec.status & 0x0c) === 0) {
		s.men[pl] = null;
	}

	for (const sub of rec.subpackets) {
		switch (sub.type) {
			case "tank_position":
				s.tanks[pl] = {
					x: sub.x, y: sub.y, px: sub.pixelX, py: sub.pixelY,
					dir: sub.direction, inBoat: sub.inBoat, hidden: sub.hidden,
					dying: sub.dying, speed: sub.speed, lastSeen: rec.time,
					/* positions with the dying bit are death-animation flames,
					 * not a live tank; only a normal position is a respawn */
					dead: sub.dying ? (s.tanks[pl] ? s.tanks[pl].dead : false) : false,
				};
				s.present[pl] = true;
				break;
			case "lgm_position":
			case "parachute_position":
				s.men[pl] = {
					x: sub.x, y: sub.y, px: sub.pixelX, py: sub.pixelY,
					parachute: sub.type === "parachute_position",
					carryingPill: sub.carryingPill, lastSeen: rec.time,
				};
				break;
			case "shells": {
				/* A record can carry SEVERAL shell-list subpackets (up to 12
				 * seen in the sample log): the sender's own shells plus those
				 * of pillboxes it is currently simulating — Bolo hands a
				 * pill's simulation to the machine it is shooting at, which
				 * is why pill shells ride in the TARGET's restatements.
				 * Lists concatenate; each list's offset shells are relative
				 * to that list's own first shell. */
				sawShells = true;
				if (newShells === null) newShells = [];
				const base = newShells.length;
				for (let i = 0; i < sub.shells.length; i++) {
					const sh = sub.shells[i];
					if (i === 0) {
						newShells.push({
							x: sh.x, y: sh.y, px: sh.pixel & 0x0f, py: sh.pixel >> 4,
							direction: sh.direction,
						});
					} else {
						/* additional shells: signed pixel offsets from this
						 * list's first shell */
						const first = newShells[base];
						const wx = first.x * 16 + first.px + ((sub.shells[i].offsetX << 24) >> 24);
						const wy = first.y * 16 + first.py + ((sub.shells[i].offsetY << 24) >> 24);
						newShells.push({
							x: (wx >> 4) & 0xff, y: (wy >> 4) & 0xff, px: wx & 0x0f, py: wy & 0x0f,
							direction: sh.direction ?? first.direction,
						});
					}
				}
				break;
			}
			case "shot_fired":
				/* no visual, same as pillbox_fires: the shell itself suffices */
				break;
			case "terrain_change":
				set_terrain(s, sub.x, sub.y, sub.terrain);
				break;
			case "explosion":
				if (sub.code === 0x0b) {
					if (effects) effects.push({ time: rec.time, type: "boom", x: sub.x, y: sub.y });
				} else if (sub.code === 0x0c) {
					mine_square(s, sub.x, sub.y);
				} else if (sub.code === 0x0d) {
					superboom(s, sub.x, sub.y);
					if (effects) effects.push({ time: rec.time, type: "superboom", x: sub.x, y: sub.y });
				} else {
					set_terrain(s, sub.x, sub.y, sub.code);
					if (effects) effects.push({ time: rec.time, type: "boom", x: sub.x, y: sub.y });
				}
				break;
			case "pillbox_damage": {
				const p = s.pills[sub.pillbox];
				if (p) p.armour = Math.max(0, p.armour - 1);
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
			case "pillbox_fires":
				break;		// no visual: a flash here reads as the pill being hit
			case "board_boat":
				/* the sender's own T boat bit only catches up a few ticks
				 * later; flip it now so pausing on the event looks right */
				if (s.tanks[pl]) s.tanks[pl].inBoat = true;
				break;
			case "pill_pickup": {
				const p = s.pills[sub.pillbox];
				if (p) p.inTank = pl;
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
					if (sub.type !== "pill_repair_full" || p.owner === NEUTRAL) p.owner = pl;
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
			case "node_id":
				s.names[pl] = sub.name;
				s.present[pl] = true;
				s.quit[pl] = false;
				/* chat events snapshot the sender's name and team as of the
				 * event, so seeking rebuilds an identical history even
				 * across renames and alliance changes */
				if (chat) chat.push({ time: rec.time, player: pl, join: true, text: sub.name });
				break;
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
				s.tanks[pl] = null;
				s.men[pl] = null;
				s.shells[pl] = [];
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
			case "alliance_leave":
				s.alliances[pl] = 0xffff & ~(1 << pl);
				for (let i = 0; i < 16; i++) {
					if (i !== pl) s.alliances[i] |= (1 << pl);
				}
				break;
		}
	}

	if (sawShells) {
		s.shells[pl] = newShells;
	} else if (rec.tankStatus !== 0x0f &&
			!(rec.subpackets.length && rec.subpackets.every(sub => MAP_NODE_TYPES.has(sub.type)))) {
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
function extract_initial_map(records) {
	const grid = new Uint8Array(MAP_SIZE * MAP_SIZE);
	grid.fill(DEEP_SEA);
	const written = new Uint8Array(MAP_SIZE * MAP_SIZE);
	const tainted = new Uint8Array(MAP_SIZE * MAP_SIZE);
	let pills = null, bases = null, starts = null;
	let badRuns = 0;
	const tanks = {};

	const taint = (x, y) => {
		if (x < MAP_SIZE && y < MAP_SIZE) tainted[y * MAP_SIZE + x] = 1;
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
				case "tank_position":
					tanks[rec.player] = sub;
					break;
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
				case "lay_mine": {
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

/* Build a seekable game from parsed records. */
function build(records) {
	const effects = [];
	const chat = [];
	const keyframes = []; /* {index, state} — state BEFORE records[index] */
	const seed = extract_initial_map(records);
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
		badMapRuns: seed.badRuns,
		final: s,
		t0: records.length ? records[0].time : 0,
		t1: records.length ? records[records.length - 1].time : 0,
	};
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
	initial_state, clone_state, apply_record, build, state_at, team_of,
	extract_initial_map,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloGame;
} else {
	window.BoloGame = BoloGame;
}

})();
