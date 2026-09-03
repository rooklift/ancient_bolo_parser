#!/usr/bin/env node
/* Settle the gameplay questions a replay can answer.
 *
 * docs/GAMEPLAY.md lists the rules of the game as the owner remembers them,
 * and closes with the "open measurements": numbers the owner said a replay
 * could supply. This tool measures them, from the record stream alone and
 * the viewer's game model for terrain and stocks:
 *
 *   reload     ticks between a tank's consecutive `5d` fires
 *   turn       ticks per sixteenth of a circle, by terrain under the tank
 *   speed      pixels per tick against the position packet's speed byte
 *   pill       pillbox fire cadence against recent damage, and the F1 02
 *              speed byte
 *   armour     shell hits taken per life at death, with armour drains,
 *              under a 9-hit and an 8-hit hypothesis
 *   man        the man's walking speed by terrain, his dwell on a square
 *              before each build event, and the parachute's duration
 *   regrowth   forest regrowth: prior terrain, senders, rate per
 *              player-second
 *   refuel     ticks between consecutive drains of one resource
 *   base       base armour at each shell hit (the blocking threshold) and
 *              at each capture
 *   hidden     the hidden-in-trees bit against the tank's box in forest
 *
 * Positions are read from each restatement, so every rate is a lower bound
 * on the true one by up to a restatement interval; medians and low
 * percentiles are printed rather than extremes where staleness would
 * dominate.
 *
 * Usage: node tools/measure-gameplay.cjs <logfile> [more logfiles]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const TERRAIN_NAMES = ["building", "river", "swamp", "crater", "road", "forest",
	"rubble", "grass", "shot building", "boat"];

function terrain_name(t) {
	if (t === BoloGame.DEEP_SEA) return "deep sea";
	if (t >= 10 && t <= 15) return TERRAIN_NAMES[t - 8];
	return TERRAIN_NAMES[t] || `t${t}`;
}

function base_terrain(t) {
	return (t >= 10 && t <= 15) ? t - 8 : t;
}

function centre(sub) {
	return { cx: sub.x * 16 + sub.pixelX + 8, cy: sub.y * 16 + sub.pixelY + 8 };
}

function square_of(sub) {
	let { cx, cy } = centre(sub);
	return { x: cx >> 4, y: cy >> 4 };
}

function grid_at(state, x, y) {
	if (x < 0 || y < 0 || x >= 256 || y >= 256) return BoloGame.DEEP_SEA;
	if (state.bases.some(b => b.x === x && b.y === y)) return 4; /* a base square is road */
	return state.grid[y * 256 + x];
}

function percentile(sorted, p) {
	if (!sorted.length) return NaN;
	let i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
	return sorted[i];
}

function stats(values) {
	let s = values.slice().sort((a, b) => a - b);
	return {
		n: s.length,
		min: s[0],
		p5: percentile(s, 0.05),
		p25: percentile(s, 0.25),
		median: percentile(s, 0.5),
		p75: percentile(s, 0.75),
		max: s[s.length - 1],
	};
}

function fmt(v, digits = 2) {
	return Number.isFinite(v) ? v.toFixed(digits) : "-";
}

function histogram_line(values, lo, hi) {
	let counts = new Map();
	for (let v of values) {
		if (v < lo || v > hi) continue;
		counts.set(v, (counts.get(v) || 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => a[0] - b[0])
		.map(([k, n]) => `${k}:${n}`).join(" ");
}

function print_stats_table(title, groups, unit) {
	console.log(`  ${title}`);
	console.log(`    ${"group".padEnd(14)} ${"n".padStart(6)} ${"min".padStart(7)} ${"p5".padStart(7)} ${"p25".padStart(7)} ${"median".padStart(7)} ${"p75".padStart(7)} ${"max".padStart(7)}  ${unit}`);
	for (let [name, values] of groups) {
		if (!values.length) continue;
		let s = stats(values);
		console.log(`    ${name.padEnd(14)} ${String(s.n).padStart(6)} ${fmt(s.min).padStart(7)} ${fmt(s.p5).padStart(7)} ${fmt(s.p25).padStart(7)} ${fmt(s.median).padStart(7)} ${fmt(s.p75).padStart(7)} ${fmt(s.max).padStart(7)}`);
	}
}

function group_push(map, key, value) {
	if (!map.has(key)) map.set(key, []);
	map.get(key).push(value);
}

function scan(file) {
	let recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));

	/* per-player trackers */
	let last_fire = new Array(16).fill(null);
	let last_record = new Array(16).fill(null);
	let last_tank = new Array(16).fill(null);       /* last tank_position sub + time */
	let last_man = new Array(16).fill(null);        /* last lgm_position sub + time */
	let man_square_since = new Array(16).fill(null); /* {x, y, since} the man's current square */
	let parachute_start = new Array(16).fill(null);  /* {time, sub, moved} */
	let parachute_runs = [];
	let life = new Array(16).fill(null);            /* {hits, drains, start, first, log: [+1|-1 ...]} */
	let last_drain = Array.from({ length: 16 }, () => ({}));
	let pill_last_fire = new Array(16).fill(null);
	let pill_hits = Array.from({ length: 16 }, () => []);
	let pill_last_hit = new Array(16).fill(-Infinity);
	let pill_fires_this_record = new Map();

	/* results */
	let reload_gaps = [];
	let fires_per_record = new Map();
	let record_gaps = [];
	let turn = new Map();
	let turn_runs = new Map();   /* sustained turns: total ticks / total sixteenths, by terrain at the start */
	let turning = new Array(16).fill(null); /* {sense, sixteenths, start_time, last_time, terrain} */
	let speed_by_byte = new Map();
	let speed_byte_by_terrain = new Map();
	let pill_gaps_by_hits = new Map();
	let pill_gaps_by_quiet = new Map();
	let pill_fires_per_record = new Map();
	let pill_gaps_all = [];
	let pill_speed_bytes = [];
	let lives = [];
	let hit_senders = { self: 0, other: 0, duplicate: 0 };
	let last_hit_on = new Array(16).fill(null); /* {time, sender} */
	let man_speed = new Map();
	let man_square_terrain = new Map();
	let dwell = new Map();
	let parachutes = [];
	let regrowth_prior = new Map();
	let regrowth_senders = new Map();
	let regrowth_count = 0;
	let regrowth_forest_neighbours = [];
	let grass_samples = [];
	let grass_neighbour_samples = [];
	let present_player_ticks = 0;
	let refuel_gaps = new Map();
	let refuel_interleaved = { with_other: 0, alone: 0 };
	let last_any_drain = new Array(16).fill(null);
	let base_armour_at_hit = [];
	let base_armour_at_capture = [];
	let capture_by_owner = new Map();
	let hidden = { total: 0, centre_forest: 0, box16: 0, box14: 0, nbr3x3: 0 };
	let clearance_hidden = [], clearance_shown = [];
	let unhidden_forest = { total: 0, box16: 0, box14: 0, nbr3x3: 0 };

	let prev_time = recs.length ? recs[0].time : 0;

	for (let rec of recs) {
		let pl = rec.player;
		let dt_global = rec.time - prev_time;
		if (dt_global > 0) {
			let present = state.present.filter((p, i) => p && !state.quit[i]).length;
			present_player_ticks += dt_global * present;
		}
		prev_time = rec.time;

		let tank_sub = rec.subpackets.find(s => s.type === "tank_position");
		let man_sub = rec.subpackets.find(s => s.type === "lgm_position");
		let parachute_sub = rec.subpackets.find(s => s.type === "parachute_position");

		/* ---- record cadence ---- */
		if (last_record[pl] !== null) record_gaps.push(rec.time - last_record[pl]);
		last_record[pl] = rec.time;

		/* ---- tank position: turn, speed, hidden ---- */
		if (tank_sub && !tank_sub.dying) {
			let sq = square_of(tank_sub);
			let terrain = tank_sub.inBoat ? "boat" : terrain_name(base_terrain(grid_at(state, sq.x, sq.y)));
			let prev = last_tank[pl];
			if (prev && !prev.sub.dying && prev.sub.inBoat === tank_sub.inBoat) {
				let dt = rec.time - prev.time;
				if (dt > 0 && dt <= 50) {
					let delta = ((tank_sub.direction - prev.sub.direction) + 16) % 16;
					if (delta > 8) delta = 16 - delta;
					if (delta >= 2) group_push(turn, prev.terrain, dt / delta);
					let signed = ((tank_sub.direction - prev.sub.direction) + 24) % 16 - 8; /* -8..7 */
					let run = turning[pl];
					if (signed !== 0 && Math.abs(signed) <= 4) {
						let sense = Math.sign(signed);
						if (run && run.sense === sense && rec.time - run.last_time <= 50) {
							run.sixteenths += Math.abs(signed);
							run.last_time = rec.time;
						} else {
							if (run && run.sixteenths >= 6) group_push(turn_runs, run.terrain, (run.last_time - run.start_time) / run.sixteenths);
							turning[pl] = { sense, sixteenths: Math.abs(signed), start_time: prev.time, last_time: rec.time, terrain: prev.terrain };
						}
					} else if (run) {
						if (run.sixteenths >= 6) group_push(turn_runs, run.terrain, (run.last_time - run.start_time) / run.sixteenths);
						turning[pl] = null;
					}
					if (delta === 0 && dt <= 25 && prev.sub.speed === tank_sub.speed) {
						let a = centre(prev.sub), b = centre(tank_sub);
						let dist = Math.hypot(b.cx - a.cx, b.cy - a.cy);
						group_push(speed_by_byte, tank_sub.speed, dist / dt);
					}
				}
			}
			group_push(speed_byte_by_terrain, terrain, tank_sub.speed);
			last_tank[pl] = { sub: tank_sub, time: rec.time, terrain };

			/* hidden rule: how much of the tank's box is forest */
			let { cx, cy } = centre(tank_sub);
			let box_forest = (half) => {
				for (let dy of [-half, half - 1]) for (let dx of [-half, half - 1]) {
					if (base_terrain(grid_at(state, (cx + dx) >> 4, (cy + dy) >> 4)) !== 5) return false;
				}
				return true;
			};
			let nbr_forest = () => {
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					if (base_terrain(grid_at(state, sq.x + dx, sq.y + dy)) !== 5) return false;
				}
				return true;
			};
			let centre_forest = base_terrain(grid_at(state, sq.x, sq.y)) === 5;
			/* Chebyshev distance from the tank centre to the nearest pixel of the nearest non-forest square */
			let clearance = Infinity;
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
				let sx = sq.x + dx, sy = sq.y + dy;
				if (base_terrain(grid_at(state, sx, sy)) === 5) continue;
				let ddx = Math.max(sx * 16 - cx, cx - (sx * 16 + 15), 0);
				let ddy = Math.max(sy * 16 - cy, cy - (sy * 16 + 15), 0);
				clearance = Math.min(clearance, Math.max(ddx, ddy));
			}
			if (centre_forest && !tank_sub.inBoat && clearance !== Infinity) (tank_sub.hidden ? clearance_hidden : clearance_shown).push(clearance);
			if (tank_sub.hidden) {
				hidden.total++;
				if (centre_forest) hidden.centre_forest++;
				if (box_forest(8)) hidden.box16++;
				if (box_forest(7)) hidden.box14++;
				if (nbr_forest()) hidden.nbr3x3++;
			} else if (centre_forest && !tank_sub.inBoat) {
				unhidden_forest.total++;
				if (box_forest(8)) unhidden_forest.box16++;
				if (box_forest(7)) unhidden_forest.box14++;
				if (nbr_forest()) unhidden_forest.nbr3x3++;
			}
		}

		/* ---- lives: respawn and death ---- */
		if (tank_sub) {
			if (tank_sub.dying) {
				/* nothing: the death event closes the life */
			} else if (life[pl] === null) {
				life[pl] = { hits: 0, drains: 0, start: rec.time, first: !lives.some(l => l.player === pl), log: [] };
			}
		}

		/* ---- man: walking speed, dwell, parachute ---- */
		if (man_sub) {
			let sq = square_of(man_sub);
			let terrain = terrain_name(base_terrain(grid_at(state, sq.x, sq.y)));
			group_push(man_square_terrain, `centre ${terrain}`, 1);
			group_push(man_square_terrain, `topleft ${terrain_name(base_terrain(grid_at(state, man_sub.x, man_sub.y)))}`, 1);
			let prev = last_man[pl];
			if (prev) {
				let dt = rec.time - prev.time;
				if (dt > 0 && dt <= 25) {
					let a = centre(prev.sub), b = centre(man_sub);
					let dist = Math.hypot(b.cx - a.cx, b.cy - a.cy);
					if (dist > 0) group_push(man_speed, prev.terrain, dist / dt);
				}
			}
			last_man[pl] = { sub: man_sub, time: rec.time, terrain };
			let cur = man_square_since[pl];
			if (!cur || cur.x !== sq.x || cur.y !== sq.y) man_square_since[pl] = { x: sq.x, y: sq.y, since: rec.time };
		} else {
			last_man[pl] = null;
			if (!parachute_sub) man_square_since[pl] = null;
		}
		if (parachute_sub) {
			if (parachute_start[pl] === null) parachute_start[pl] = { time: rec.time, sub: parachute_sub, last: parachute_sub, moved: 0, tank_at_start: last_tank[pl] ? centre(last_tank[pl].sub) : null };
			else {
				let a = centre(parachute_start[pl].last), b = centre(parachute_sub);
				parachute_start[pl].moved += Math.hypot(b.cx - a.cx, b.cy - a.cy);
				parachute_start[pl].last = parachute_sub;
			}
		} else if (parachute_start[pl] !== null) {
			let run = parachute_start[pl];
			let ticks = rec.time - run.time;
			parachutes.push(ticks);
			let a = centre(run.sub), b = centre(run.last);
			let tank = last_tank[pl] ? centre(last_tank[pl].sub) : null;
			let t0 = run.tank_at_start;
			parachute_runs.push({ ticks, moved: run.moved, straight: Math.hypot(b.cx - a.cx, b.cy - a.cy), to_tank: tank ? Math.hypot(tank.cx - b.cx, tank.cy - b.cy) : NaN, man_after: !!man_sub,
				start_to_death_tank: t0 ? Math.hypot(t0.cx - a.cx, t0.cy - a.cy) : NaN, end_to_death_tank: t0 ? Math.hypot(t0.cx - b.cx, t0.cy - b.cy) : NaN,
				start_edge: Math.min(a.cx, a.cy, 4095 - a.cx, 4095 - a.cy), start: [a.cx >> 4, a.cy >> 4], end: [b.cx >> 4, b.cy >> 4] });
			parachute_start[pl] = null;
		}

		/* ---- events ---- */
		let fires_here = 0;
		for (let sub of rec.subpackets) {
			switch (sub.type) {
				case "shot_fired": {
					fires_here++;
					if (last_fire[pl] !== null) reload_gaps.push(rec.time - last_fire[pl]);
					last_fire[pl] = rec.time;
					break;
				}
				case "pillbox_fires": {
					let n = sub.pillbox;
					let p = state.pills[n];
					if (pill_last_fire[n] !== null) {
						let gap = rec.time - pill_last_fire[n];
						if (gap <= 400) {
							pill_gaps_all.push(gap);
							let recent = pill_hits[n].filter(t => rec.time - t <= 250).length;
							let bucket = recent >= 6 ? "6+ hits/5s" : `${recent} hits/5s`;
							group_push(pill_gaps_by_hits, bucket, gap);
							let quiet = (rec.time - pill_last_hit[n]) / 50;
							let qb = quiet < 5 ? "a <5 s" : quiet < 15 ? "b 5-15 s" : quiet < 30 ? "c 15-30 s" : quiet < 60 ? "d 30-60 s" : quiet < 120 ? "e 60-120 s" : "f >120 s";
							group_push(pill_gaps_by_quiet, qb, gap);
						}
					}
					pill_last_fire[n] = rec.time;
					pill_fires_this_record.set(n, (pill_fires_this_record.get(n) || 0) + 1);
					if (p && p.speed !== undefined) pill_speed_bytes.push(p.speed);
					break;
				}
				case "pillbox_damage": {
					pill_hits[sub.pillbox].push(rec.time);
					pill_last_hit[sub.pillbox] = rec.time;
					if (pill_hits[sub.pillbox].length > 64) pill_hits[sub.pillbox].shift();
					break;
				}
				case "tank_hit": {
					if (sub.tank === pl) hit_senders.self++; else hit_senders.other++;
					let lh = last_hit_on[sub.tank];
					if (lh && rec.time - lh.time <= 2 && lh.sender !== pl) hit_senders.duplicate++;
					last_hit_on[sub.tank] = { time: rec.time, sender: pl };
					if (life[sub.tank]) { life[sub.tank].hits++; life[sub.tank].log.push(-1); }
					break;
				}
				case "base_drain": {
					if (life[pl] && sub.resource === "armor") { life[pl].drains++; life[pl].log.push(1); }
					let key = sub.resource;
					let lad = last_any_drain[pl];
					if (lad && rec.time - lad.time <= 20 && lad.resource !== key) refuel_interleaved.with_other++; else refuel_interleaved.alone++;
					last_any_drain[pl] = { time: rec.time, resource: key };
					let prev = last_drain[pl][key];
					if (prev !== undefined && prev.base === sub.base) {
						let gap = rec.time - prev.time;
						if (gap <= 200) group_push(refuel_gaps, key, gap);
					}
					last_drain[pl][key] = { base: sub.base, time: rec.time };
					break;
				}
				case "tank_death": {
					let l = life[pl];
					if (l) {
						lives.push({ player: pl, code: sub.code, hits: l.hits, drains: l.drains, first: l.first, length: rec.time - l.start, log: l.log });
						life[pl] = null;
					}
					break;
				}
				case "base_damage": {
					let b = state.bases[sub.base];
					if (b) base_armour_at_hit.push(b.armour);
					break;
				}
				case "base_capture": {
					let b = state.bases[sub.base];
					if (b) {
						base_armour_at_capture.push(b.armour);
						let owner = b.owner === BoloGame.NEUTRAL ? "neutral" : b.owner === BoloGame.DEPARTED ? "departed" : b.owner === pl ? "own" : (state.alliances[pl] & (1 << b.owner)) ? "hostile" : "allied";
						group_push(capture_by_owner, owner, b.armour);
					}
					break;
				}
				case "terrain_change": {
					let before = state.grid[sub.y * 256 + sub.x];
					if (sub.terrain === 5 && base_terrain(before) !== 5) {
						regrowth_count++;
						let fn = 0;
						for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
							if ((dx || dy) && base_terrain(grid_at(state, sub.x + dx, sub.y + dy)) === 5) fn++;
						}
						regrowth_forest_neighbours.push(fn);
						group_push(regrowth_prior, terrain_name(before), 1);
						group_push(regrowth_senders, `player ${pl}`, 1);
					}
					/* a build: the man's dwell on that square before the event */
					let cur = man_square_since[pl];
					if (cur && cur.x === sub.x && cur.y === sub.y && sub.terrain !== 5) {
						let kind = `build ${terrain_name(sub.terrain)}` + (base_terrain(before) === 5 && sub.terrain === 7 ? " (harvest)" : "");
						group_push(dwell, kind, rec.time - cur.since);
					}
					break;
				}
				case "explosion": {
					if (sub.code === 0x0c) {
						let cur = man_square_since[pl];
						if (cur && cur.x === sub.x && cur.y === sub.y) group_push(dwell, "man plants mine", rec.time - cur.since);
					}
					break;
				}
				case "pill_plant": {
					let cur = man_square_since[pl];
					if (cur && cur.x === sub.x && cur.y === sub.y) group_push(dwell, "plant pill", rec.time - cur.since);
					break;
				}
				case "pill_repair_4": case "pill_repair_8": case "pill_repair_12": case "pill_repair_full": {
					let p = state.pills[sub.pillbox];
					let cur = man_square_since[pl];
					if (p && cur && cur.x === p.x && cur.y === p.y) group_push(dwell, sub.type.replace("_", " "), rec.time - cur.since);
					break;
				}
			}
		}
		if (fires_here) fires_per_record.set(fires_here, (fires_per_record.get(fires_here) || 0) + 1);
		for (let [n, k] of pill_fires_this_record) {
			let quiet = (rec.time - pill_last_hit[n]) / 50;
			let key = quiet < 5 ? "hit <5 s ago" : "quiet >=5 s";
			group_push(pill_fires_per_record, key, k);
		}
		pill_fires_this_record.clear();

		BoloGame.apply_record(state, rec, null, null, null, node_joins);
		if (grass_samples.length * 2000 < recs.indexOf(rec) + 1 || grass_samples.length === 0) {
			/* every ~2000 records: how many grass squares exist, and how many of them touch forest */
			let n = 0, touching = 0;
			for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
				if (base_terrain(state.grid[y * 256 + x]) !== 7) continue;
				n++;
				let t = false;
				for (let dy = -1; dy <= 1 && !t; dy++) for (let dx = -1; dx <= 1; dx++) {
					if ((dx || dy) && base_terrain(grid_at(state, x + dx, y + dy)) === 5) { t = true; break; }
				}
				if (t) touching++;
			}
			grass_samples.push(n);
			grass_neighbour_samples.push(touching);
		}
	}

	/* ---- report ---- */
	let players = state.names.filter(n => n !== null).length;
	console.log(`\n${path.basename(file)}: ${recs.length} records, ${((recs[recs.length - 1].time - recs[0].time) / 50 / 60).toFixed(1)} min, game type ${state.gameInfo ? state.gameInfo.gameType : "?"}, ${players} names`);

	console.log("\n[reload] ticks between a tank's consecutive fires (histogram 1..40)");
	console.log(`  ${histogram_line(reload_gaps, 1, 40)}`);
	let rs = stats(reload_gaps.filter(g => g <= 100));
	console.log(`  gaps <= 100 ticks: n ${rs.n}, min ${rs.min}, p5 ${rs.p5}, median ${rs.median}`);
	console.log(`  fires per record: ${[...fires_per_record.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join(" ")}`);
	let cs = stats(record_gaps.filter(g => g <= 100));
	console.log(`  sender record cadence for comparison: min ${cs.min}, p5 ${cs.p5}, median ${cs.median}, p75 ${cs.p75} ticks`);

	console.log("\n[turn] ticks per sixteenth of a circle, consecutive restatements <= 50 ticks apart, |delta| >= 2, by terrain at the start");
	print_stats_table("(pairwise: biased by record cadence when the cadence is coarse)", [...turn.entries()].sort(), "ticks/sixteenth");
	print_stats_table("sustained turns of 6+ sixteenths, ticks / sixteenths (full circle = 16 x median)", [...turn_runs.entries()].sort(), "ticks/sixteenth");

	console.log("\n[speed] pixels per tick between restatements <= 25 ticks apart at constant heading and speed byte, by speed byte");
	print_stats_table("", [...speed_by_byte.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [`byte ${k}`, v]), "px/tick");
	console.log("  speed byte by terrain under the tank centre (max, p75, median):");
	for (let [t, v] of [...speed_byte_by_terrain.entries()].sort()) {
		let s = stats(v);
		console.log(`    ${t.padEnd(14)} n ${String(s.n).padStart(6)}  max ${String(s.max).padStart(3)}  p75 ${String(s.p75).padStart(3)}  median ${String(s.median).padStart(3)}`);
	}

	console.log("\n[pill] ticks between one pillbox's consecutive fires (<= 400), by hits it took in the previous 5 s");
	print_stats_table("", [...pill_gaps_by_hits.entries()].sort(), "ticks");
	console.log(`  all gaps histogram 1..40: ${histogram_line(pill_gaps_all, 1, 40)}`);
	print_stats_table("by time since the pill was last hit", [...pill_gaps_by_quiet.entries()].sort(), "ticks");
	console.log("  fires by one pill within one record (the record cadence is ~13 ticks):");
	for (let [k, v] of [...pill_fires_per_record.entries()].sort()) console.log(`    ${k.padEnd(14)} ${histogram_line(v, 1, 10)}`);
	console.log(`  F1 02 speed byte of firing pills (model): ${histogram_line(pill_speed_bytes, 0, 255)}`);

	console.log("\n[armour] shell hits per life, at death; first life of each player excluded (unknown start)");
	let usable = lives.filter(l => !l.first);
	console.log(`  lives ${lives.length}, usable ${usable.length}; tank_hit sender is the hit tank itself ${hit_senders.self}, another player ${hit_senders.other}; same tank hit again within 2 ticks by a different sender ${hit_senders.duplicate}`);
	for (let code of [1, 2, 3]) {
		let ls = usable.filter(l => l.code === code);
		if (!ls.length) continue;
		console.log(`  death code ${code}: n ${ls.length}`);
		console.log(`    hits histogram:            ${histogram_line(ls.map(l => l.hits), 0, 60)}`);
		console.log(`    hits, lives with 0 drains: ${histogram_line(ls.filter(l => l.drains === 0).map(l => l.hits), 0, 60)}`);
		for (let max of [8, 9, 10]) {
			/* replay the life: armour starts at max, +1 per drain capped at max, -1 per hit; where is it at death?
			 * A correct max puts the death exactly at 0 (the killing hit), a too-low max below 0, a too-high one above. */
			let dist = new Map();
			let exact = 0;
			for (let l of ls) {
				let a = max;
				for (let d of l.log) a = d > 0 ? Math.min(max, a + 1) : a - 1;
				let key = a > 0 ? ">0" : String(a);
				dist.set(key, (dist.get(key) || 0) + 1);
				if (a === 0) exact++;
			}
			console.log(`    max ${max}, drains capped: armour at death ${[...dist.entries()].sort().map(([k, n]) => `${k}:${n}`).join(" ")}  (exactly 0 in ${exact}/${ls.length})`);
		}
	}

	console.log("\n[man] walking speed by terrain under the man, restatements <= 25 ticks apart");
	print_stats_table("", [...man_speed.entries()].sort(), "px/tick");
	console.log(`  terrain under the man, centre convention: ${[...man_square_terrain.entries()].filter(([k]) => k.startsWith("centre")).sort().map(([k, v]) => `${k.slice(7)}:${v.length}`).join(" ")}`);
	console.log(`  terrain under the man, top-left convention: ${[...man_square_terrain.entries()].filter(([k]) => k.startsWith("topleft")).sort().map(([k, v]) => `${k.slice(8)}:${v.length}`).join(" ")}`);
	console.log("  dwell on the square before each build event (ticks since the man entered it)");
	print_stats_table("", [...dwell.entries()].sort(), "ticks");
	let ps = stats(parachutes);
	console.log(`  parachute runs (consecutive status-4 records): n ${ps.n}, min ${ps.min}, p25 ${ps.p25}, median ${ps.median}, p75 ${ps.p75}, max ${ps.max} ticks`);
	console.log(`  parachute histogram in seconds: ${histogram_line(parachutes.map(t => Math.round(t / 50)), 0, 600)}`);
	if (parachute_runs.length) {
		let moved = stats(parachute_runs.map(r => r.moved)), straight = stats(parachute_runs.map(r => r.straight)), to_tank = stats(parachute_runs.filter(r => Number.isFinite(r.to_tank)).map(r => r.to_tank));
		console.log(`  parachute path: total movement px median ${fmt(moved.median, 0)} (max ${fmt(moved.max, 0)}), start-to-end px median ${fmt(straight.median, 0)} (max ${fmt(straight.max, 0)}), end-to-tank px median ${fmt(to_tank.median, 0)}; run ends with the man walking in ${parachute_runs.filter(r => r.man_after).length}/${parachute_runs.length}`);
		let sd = stats(parachute_runs.filter(r => Number.isFinite(r.start_to_death_tank)).map(r => r.start_to_death_tank));
		let ed = stats(parachute_runs.filter(r => Number.isFinite(r.end_to_death_tank)).map(r => r.end_to_death_tank));
		let edge = stats(parachute_runs.map(r => r.start_edge));
		console.log(`  parachute start to the tank's position at the death: px median ${fmt(sd.median, 0)} (p25 ${fmt(sd.p25, 0)}, p75 ${fmt(sd.p75, 0)}); end to that position: median ${fmt(ed.median, 0)} (p25 ${fmt(ed.p25, 0)}, p75 ${fmt(ed.p75, 0)})`);
		console.log(`  parachute start's distance from the nearest map edge: px median ${fmt(edge.median, 0)}, min ${fmt(edge.min, 0)}, max ${fmt(edge.max, 0)}`);
		console.log(`  first five runs, start square -> end square: ${parachute_runs.slice(0, 5).map(r => `(${r.start}) -> (${r.end})`).join(", ")}`);
		let speeds = parachute_runs.filter(r => r.straight > 32).map(r => r.straight / r.ticks);
		if (speeds.length) console.log(`  parachute speed over runs moving >32 px: median ${fmt(stats(speeds).median, 3)} px/tick, n ${speeds.length}`);
	}

	console.log("\n[regrowth] forest appearing where it was not");
	console.log(`  events ${regrowth_count}; prior terrain: ${[...regrowth_prior.entries()].map(([k, v]) => `${k}:${v.length}`).join(" ")}`);
	console.log(`  senders: ${[...regrowth_senders.entries()].sort().map(([k, v]) => `${k}:${v.length}`).join(" ")}`);
	console.log(`  rate: ${(regrowth_count / (present_player_ticks / 50) * 60).toFixed(3)} per player-minute (${(present_player_ticks / 50 / 60).toFixed(0)} player-minutes present)`);
	let mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
	let grass_mean = mean(grass_samples), touching_mean = mean(grass_neighbour_samples);
	console.log(`  grass squares on the map: mean ${grass_mean.toFixed(0)}, of which touching forest ${touching_mean.toFixed(0)} (${(100 * touching_mean / grass_mean).toFixed(1)}%)`);
	console.log(`  regrowth squares with N forest neighbours (of 8): ${histogram_line(regrowth_forest_neighbours, 0, 8)}; with >= 1: ${regrowth_forest_neighbours.filter(n => n > 0).length}/${regrowth_forest_neighbours.length}`);
	console.log(`  rate per grass square: ${(regrowth_count / grass_mean / (present_player_ticks / 50) * 3600).toFixed(4)} per player-hour; per forest-touching grass square: ${(regrowth_count / touching_mean / (present_player_ticks / 50) * 3600).toFixed(4)} per player-hour`);

	console.log("\n[refuel] ticks between consecutive drains of one resource from one base by one tank (<= 200)");
	print_stats_table("", [...refuel_gaps.entries()].sort(), "ticks");
	for (let [k, v] of [...refuel_gaps.entries()].sort()) {
		console.log(`  ${k} histogram 0..40: ${histogram_line(v, 0, 40)}`);
	}
	console.log(`  drains within 20 ticks of a drain of a different resource by the same tank: ${refuel_interleaved.with_other}, others ${refuel_interleaved.alone}`);

	console.log("\n[base] base armour (model) just before each shell hit, and at each capture");
	console.log(`  at hit:     ${histogram_line(base_armour_at_hit, 0, 90)}`);
	console.log(`  at capture: ${histogram_line(base_armour_at_capture, 0, 90)}`);
	for (let [k, v] of [...capture_by_owner.entries()].sort()) console.log(`    captured from ${k.padEnd(9)} n ${String(v.length).padStart(4)}: ${histogram_line(v, 0, 90)}`);

	console.log("\n[hidden] the hidden bit against forest under the tank's box");
	console.log(`  hidden set: n ${hidden.total}; centre square forest ${hidden.centre_forest}; whole 16px box in forest ${hidden.box16}; 14px box ${hidden.box14}; all 3x3 squares ${hidden.nbr3x3}`);
	console.log(`  hidden clear, centre square forest: n ${unhidden_forest.total}; whole 16px box in forest ${unhidden_forest.box16}; 14px box ${unhidden_forest.box14}; all 3x3 squares ${unhidden_forest.nbr3x3}`);
	console.log("  Chebyshev px from tank centre to the nearest non-forest square (centre in forest, within 2 squares):");
	console.log(`    hidden: ${histogram_line(clearance_hidden, 0, 40)}`);
	console.log(`    shown:  ${histogram_line(clearance_shown, 0, 40)}`);
}

let files = process.argv.slice(2);
if (!files.length) {
	console.error("usage: node tools/measure-gameplay.cjs <logfile> [more]");
	process.exit(2);
}
for (let f of files) scan(f);
