#!/usr/bin/env node
/* How far does a pillbox shot fly when it hits nothing?
 *
 * Purely from the logs. `F4 nd` names the firing pill and the shell's sector;
 * `FB` gives a shell's terminal point [E:shell-fall-terminal]. The range is the
 * distance from the pill's centre to that point. No flight model is assumed:
 * the orbit file is read only at the very end, as a comparison.
 *
 * Two ways of tying an `FB` to its `F4`, neither of which looks at distance:
 *
 * LONE SHELLS, identified by elimination. A sender listing no shells, with no
 * `5d` or `F4` for FIRE_QUIET_TICKS, logs one `F4` and then lists at most one
 * shell until the shell goes, with no further `5d` or `F4`. Whatever ends the
 * run is that shell's fate, so this set also says how many shots end in an
 * `FB` and how many vanish with no event at all. A tank's lone `5d` goes
 * through the same code as a control, since its range is known independently.
 *
 * ALL FALLS, identified by bearing. Every `FB` from a sender with no `5d` for
 * TANK_QUIET_TICKS (longer than a tank shell lives) cannot be its own tank
 * shell, so it is paired with an unexpired `F4` of that sender whose sector
 * contains the bearing from the pill to the `FB`. Falls with candidates from
 * more than one pill are set aside as ambiguous.
 *
 * Reading the fates: "silent" is a shell gone with no event within
 * EXPLOSION_NEAR_PX of its last listing. Records can be 16 or more ticks apart,
 * so most of these are impacts further along the ray, which is why each is
 * tested for an explosion on the ray and for the first obstacle on it, with the
 * falling shells as the control. The lone set leaves out direction-0 fires from
 * an odd index [E:pill-fire-index], and so all of bradians 249-255, which are
 * only ever logged that way: four terminals are "not seen" for that reason.
 *
 * Usage:
 *   node tools/measure-pill-shell-range.cjs [--dump <file>] [<file or dir> ...]
 *       (no paths: the whole corpus, via BOLO_CORPUS/corpus.json)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const { corpus_root, replay_label } = require("./corpus.cjs");

const FIRE_QUIET_TICKS = 80;
const TANK_QUIET_TICKS = 60;
const FIRE_EXPIRY_TICKS = 110;
const SECTOR_TOLERANCE_DEGREES = 15;     /* half a sector is 11.25 */
const NEVER_LISTED_TICKS = 12;
const STRICT_GAP_TICKS = 4;
const EXPLOSION_NEAR_PX = 32;
const POINT_BLANK_PX = 48;
const OBSTACLE_SLACK_PX = 8;
const TANK_RADIUS_PX = 8;
const RAY_EXPLOSION_TICKS = 20;
const RAY_EXPLOSION_DEGREES = 20;
const AFTERMATH_TICKS = 80;
const RANGE_LOW_PX = 133.5;              /* the band every lone fall lands in */
const RANGE_HIGH_PX = 137;
const ORBIT_FILE = path.join(__dirname, "..", "docs", "pillbox-shell-orbits-compact.json");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const SKIPPED_DIRECTORIES = new Set(["repair details", ".git"]);
const TERRAIN_NAMES = ["building", "river", "swamp", "crater", "road", "forest", "rubble", "grass", "shot building", "boat"];

let lone = { pill: [], tank: [] };
let lone_fates = { pill: new Map(), tank: new Map() };
let lone_spoiled = { pill: new Map(), tank: new Map() };
let silent = { pill: [], tank: [] };
let never = { pill: [], tank: [] };
let range_checks = new Map();
let falls = [];
let fall_counts = new Map();
let files_read = 0, files_failed = 0;

function bump(map, key, by = 1) {
	map.set(key, (map.get(key) || 0) + by);
}

function terrain_name(t) {
	if (t === BoloGame.DEEP_SEA) return "deep sea";
	if (t === undefined) return "off map";
	let base = t >= 10 && t <= 15 ? t - 8 : t;
	return TERRAIN_NAMES[base] || `t${t}`;
}

function shell_centre(sub) {
	return [sub.x * 16 + (sub.pixel & 0x0f) + 8, sub.y * 16 + (sub.pixel >> 4) + 8];
}

/* Degrees between the sector `nibble` points along and the vector dx,dy, with
 * north (negative y) as zero and clockwise positive. */
function sector_error(nibble, dx, dy) {
	let bearing = Math.atan2(dx, -dy) * 180 / Math.PI;
	let error = (bearing - nibble * 22.5) % 360;
	if (error > 180) error -= 360;
	if (error < -180) error += 360;
	return error;
}

function read_record(rec) {
	let out = { fires: [], shots: 0, falls: [], tank_hits: [], pill_hits: 0, base_hits: 0,
		explosions: [], dead: false, shells: 0, head: null, tank: null };
	for (let sub of rec.subpackets) {
		switch (sub.type) {
			case "pillbox_fires": out.fires.push(sub); break;
			case "shot_fired": out.shots++; break;
			case "shell_falls": out.falls.push(sub); break;
			case "tank_hit": out.tank_hits.push(sub); break;
			case "pillbox_damage": out.pill_hits++; break;
			case "base_damage": out.base_hits++; break;
			case "explosion": out.explosions.push(sub); break;
			case "tank_death": out.dead = true; break;
			case "tank_position":
				out.tank = [sub.x * 16 + sub.pixelX + 8, sub.y * 16 + sub.pixelY + 8];
				break;
			case "shells":
				out.shells += sub.count;
				out.head = shell_centre(sub.shells[0]);
				break;
		}
	}
	return out;
}

/* What became of a shell its sender stopped listing with no event: did the
 * sender report anything later, list it again, or did another machine list a
 * shell on the same ray? */
function aftermath(run, ctx) {
	let { recs, rec } = ctx;
	let out = { later_hit: false, later_list: false, elsewhere: false };
	let until = run.fire + AFTERMATH_TICKS;
	for (let j = run.open_index; j < recs.length && recs[j].time <= until; j++) {
		let other = recs[j];
		if (other.player === rec.player) {
			if (j <= ctx.index) continue;
			for (let sub of other.subpackets) {
				if (sub.type === "tank_hit" || sub.type === "pillbox_damage" || sub.type === "base_damage") out.later_hit = true;
				if (sub.type === "shells" && sub.direction === run.nibble) out.later_list = true;
			}
			continue;
		}
		for (let sub of other.subpackets) {
			if (sub.type !== "shells" || sub.direction !== run.nibble) continue;
			let [x, y] = shell_centre(sub.shells[0]);
			let dx = x - run.origin[0], dy = y - run.origin[1];
			if (Math.hypot(dx, dy) <= 140 && Math.abs(sector_error(run.nibble, dx, dy)) <= SECTOR_TOLERANCE_DEGREES) out.elsewhere = true;
		}
	}
	return out;
}

/* The first thing that could stop a shell on its ray, from its last listing to
 * as far as it can have got by the closing record. Falls go through this too,
 * as the control: they have to report nothing, or the scan is seeing things. */
function first_obstacle(run, ctx) {
	if (!run.last) return "not listed";
	let { state, senders, rec } = ctx;
	let dx = run.last[0] - run.origin[0], dy = run.last[1] - run.origin[1];
	let from = Math.hypot(dx, dy);
	if (from < 1) return "too short to tell";
	let reach = Math.min(RANGE_HIGH_PX, from + 2 * run.closing_gap + OBSTACLE_SLACK_PX);
	for (let d = from; d <= reach; d++) {
		let x = run.origin[0] + dx / from * d, y = run.origin[1] + dy / from * d;
		let tile_x = Math.floor(x / 16), tile_y = Math.floor(y / 16);
		if (senders.some(t => t.tank && Math.hypot(t.tank[0] - x, t.tank[1] - y) <= TANK_RADIUS_PX)) return "a tank";
		if (state.bases.some(b => b.x === tile_x && b.y === tile_y)) return "a base";
		let pill = state.pills.findIndex(p => p.inTank === null && p.x === tile_x && p.y === tile_y);
		if (pill >= 0 && pill !== run.pill) return state.pills[pill].armour > 0 ? "a live pill" : "a dead pill";
		let terrain = terrain_name(state.grid[tile_y * 256 + tile_x]);
		if (["building", "shot building", "forest", "boat"].includes(terrain)) return "a " + terrain;
	}
	return "nothing";
}

function explosion_on_ray(run, ctx) {
	let { recs, index, rec } = ctx;
	for (let j = index; j < recs.length && recs[j].time <= rec.time + RAY_EXPLOSION_TICKS; j++) {
		if (recs[j].player !== rec.player) continue;
		for (let sub of recs[j].subpackets) {
			if (sub.type !== "explosion") continue;
			let dx = sub.x * 16 + 8 - run.origin[0], dy = sub.y * 16 + 8 - run.origin[1];
			if (Math.hypot(dx, dy) <= RANGE_HIGH_PX + 12 && Math.abs(sector_error(run.nibble, dx, dy)) <= RAY_EXPLOSION_DEGREES) return true;
		}
	}
	return false;
}

function close_run(sender, kind_fate, read, rec, ctx) {
	let { state, tag: archive } = ctx;
	let run = sender.run;
	sender.run = null;
	bump(lone_fates[run.kind], kind_fate);
	let last = run.last ? Math.hypot(run.last[0] - run.origin[0], run.last[1] - run.origin[1]) : null;
	if (kind_fate === "fall") {
		let [x, y] = shell_centre(read.falls[0]);
		lone[run.kind].push({
			dist: Math.hypot(x - run.origin[0], y - run.origin[1]),
			dx: x - run.origin[0], dy: y - run.origin[1],
			dt: rec.time - run.fire, gap: run.max_gap, last,
			first: run.first ? Math.hypot(run.first[0] - run.origin[0], run.first[1] - run.origin[1]) : null,
			first_age: run.first_time === null ? null : run.first_time - run.fire,
			last_age: run.last_time - run.fire, closing_gap: run.closing_gap,
			obstacle: first_obstacle(run, ctx),
			nibble: run.nibble, archive, target: run.target,
			terrain: terrain_name(state.grid[(y >> 4) * 256 + (x >> 4)]),
		});
	} else if (kind_fate === "silent") {
		silent[run.kind].push({ last, age: run.last_time - run.fire, gap: run.max_gap,
			closing_gap: run.closing_gap, dead: read.dead, nibble: run.nibble, target: run.target,
			obstacle: first_obstacle(run, ctx), ray_explosion: explosion_on_ray(run, ctx),
			...aftermath(run, ctx) });
	} else if (kind_fate === "never listed") {
		never[run.kind].push({ target: run.target, first_gap: run.first_gap, closing_age: rec.time - run.fire,
			...aftermath(run, ctx) });
	}
}

function follow_run(sender, read, rec, ctx) {
	let run = sender.run;
	run.closing_gap = rec.time - run.prev_time;
	if (run.first_gap === null) run.first_gap = run.closing_gap;
	if (read.fires.length || read.shots) {
		bump(lone_spoiled[run.kind], "another shot");
		sender.run = null;
		return;
	}
	if (read.shells > 1) {
		bump(lone_spoiled[run.kind], "second shell listed");
		sender.run = null;
		return;
	}
	run.max_gap = Math.max(run.max_gap, rec.time - run.prev_time);
	run.prev_time = rec.time;
	let terminal_events = read.falls.length + read.tank_hits.length + read.pill_hits + read.base_hits;
	if (read.falls.length > 1) {
		bump(lone_spoiled[run.kind], "two falls");
		sender.run = null;
		return;
	}
	if (read.falls.length && terminal_events === 1) return close_run(sender, "fall", read, rec, ctx);
	if (read.tank_hits.length) return close_run(sender, "tank hit", read, rec, ctx);
	if (read.pill_hits) return close_run(sender, "pill hit", read, rec, ctx);
	if (read.base_hits) return close_run(sender, "base hit", read, rec, ctx);
	let reference = read.head || run.last || run.origin;
	let near = read.explosions.some(e => Math.hypot(e.x * 16 + 8 - reference[0], e.y * 16 + 8 - reference[1]) <= EXPLOSION_NEAR_PX);
	if (read.shells === 0 && near) return close_run(sender, "terrain explosion", read, rec, ctx);
	if (read.shells === 1) {
		if (!run.first) {
			run.first = read.head;
			run.first_time = rec.time;
		}
		run.last = read.head;
		run.last_time = rec.time;
		return;
	}
	if (run.last) return close_run(sender, "silent", read, rec, ctx);
	if (rec.time - run.fire > NEVER_LISTED_TICKS) close_run(sender, "never listed", read, rec, ctx);
}

function open_run(sender, read, rec, ctx) {
	let { state } = ctx;
	let quiet = sender.spoke && sender.previous_shells === 0 && rec.time - sender.last_any_fire > FIRE_QUIET_TICKS;
	if (!quiet) return;
	let kind = null, origin = null, nibble = 0, target = null, pill_index = -1;
	if (read.fires.length === 1 && !read.shots) {
		let fire = read.fires[0];
		let pill = state.pills[fire.pillbox];
		if (!pill || pill.inTank !== null) return;
		if (fire.direction === 0 && (fire.pillbox & 1)) return;     /* [E:pill-fire-index] */
		kind = "pill";
		pill_index = fire.pillbox;
		origin = [pill.x * 16 + 8, pill.y * 16 + 8];
		nibble = fire.direction;
		if (sender.tank) target = Math.hypot(sender.tank[0] - origin[0], sender.tank[1] - origin[1]);
	} else if (read.shots === 1 && !read.fires.length && sender.tank) {
		kind = "tank";
		origin = sender.tank;
		nibble = rec.subpackets.find(s => s.type === "shot_fired").direction;
	}
	if (!kind) return;
	if (read.shells > 1 || read.falls.length) return;
	sender.run = { kind, origin, nibble, target, pill: pill_index, fire: rec.time, prev_time: rec.time, max_gap: 0,
		open_index: ctx.index, first_gap: null, closing_gap: 0,
		first: read.shells === 1 ? read.head : null, first_time: read.shells === 1 ? rec.time : null,
		last: read.shells === 1 ? read.head : null, last_time: rec.time };
	/* a point-blank shell can end in the record that fired it */
	if (read.shells === 0) {
		if (read.tank_hits.length) return close_run(sender, "tank hit, fire record", read, rec, ctx);
		if (read.pill_hits) return close_run(sender, "pill hit, fire record", read, rec, ctx);
		if (read.base_hits) return close_run(sender, "base hit, fire record", read, rec, ctx);
		if (read.explosions.some(e => Math.hypot(e.x * 16 + 8 - origin[0], e.y * 16 + 8 - origin[1]) <= POINT_BLANK_PX)) {
			return close_run(sender, "terrain explosion, fire record", read, rec, ctx);
		}
	}
}

/* Is there any grounded pill at the established range from this point? The
 * caller repeats the test from a displaced point as the chance baseline. */
function pill_at_range(state, x, y) {
	return state.pills.some(p => {
		if (p.inTank !== null) return false;
		let d = Math.hypot(x - (p.x * 16 + 8), y - (p.y * 16 + 8));
		return d >= RANGE_LOW_PX && d <= RANGE_HIGH_PX;
	});
}

function check_range_explanation(group, state, x, y) {
	bump(range_checks, group + " | total");
	if (pill_at_range(state, x, y)) bump(range_checks, group + " | a pill at range");
	else if (state.pills.some(p => {
		let d = Math.hypot(x - (p.x * 16 + 8), y - (p.y * 16 + 8));
		return p.inTank !== null && d >= RANGE_LOW_PX && d <= RANGE_HIGH_PX;
	})) bump(range_checks, group + " | no grounded pill, a carried one's last square at range");
	if (pill_at_range(state, x + 37, y + 23)) bump(range_checks, group + " | baseline, point displaced");
}

function attribute_falls(sender, read, rec, ctx) {
	let { state, tag: archive } = ctx;
	sender.open_fires = sender.open_fires.filter(f => rec.time - f.time <= FIRE_EXPIRY_TICKS);
	for (let fall of read.falls) {
		if (read.shots || rec.time - sender.last_shot <= TANK_QUIET_TICKS) {
			bump(fall_counts, "tank shot too recent");
			continue;
		}
		let [x, y] = shell_centre(fall);
		let candidates = sender.open_fires.filter(f =>
			Math.abs(sector_error(f.nibble, x - f.origin[0], y - f.origin[1])) <= SECTOR_TOLERANCE_DEGREES);
		if (!candidates.length) {
			bump(fall_counts, "no fire on that bearing");
			check_range_explanation("no fire on that bearing", state, x, y);
			continue;
		}
		if (new Set(candidates.map(f => f.pill)).size > 1) {
			bump(fall_counts, "ambiguous between pills");
			check_range_explanation("ambiguous between pills", state, x, y);
			let any = candidates.some(f => {
				let d = Math.hypot(x - f.origin[0], y - f.origin[1]);
				return d >= RANGE_LOW_PX && d <= RANGE_HIGH_PX;
			});
			bump(range_checks, "ambiguous between pills | one of its candidates at range", any ? 1 : 0);
			continue;
		}
		let fire = candidates[0];
		sender.open_fires.splice(sender.open_fires.indexOf(fire), 1);
		bump(fall_counts, "paired");
		let paired_distance = Math.hypot(x - fire.origin[0], y - fire.origin[1]);
		if (paired_distance < RANGE_LOW_PX || paired_distance > RANGE_HIGH_PX) {
			check_range_explanation("paired, off the band", state, x, y);
		}
		falls.push({
			dist: Math.hypot(x - fire.origin[0], y - fire.origin[1]),
			dx: x - fire.origin[0], dy: y - fire.origin[1],
			dt: rec.time - fire.time, nibble: fire.nibble, archive, version: fire.version,
			target: fire.target, moved: fire.moved,
			terrain: terrain_name(state.grid[(y >> 4) * 256 + (x >> 4)]),
		});
	}
}

function tally(file, archive) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let version = BoloLog.parseHeader(bytes).versionString;
	let recs = [...BoloLog.records(bytes)];
	if (!recs.length) throw new Error("no records");
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));
	let moved = new Set();
	let senders = Array.from({ length: 16 }, () => ({ spoke: false, previous_shells: 0, tank: null,
		last_any_fire: -Infinity, last_shot: -Infinity, run: null, open_fires: [] }));
	let tag = archive + " " + (BoloLog.isNuBolo(bytes) ? "nuBolo" : version);
	for (let index = 0; index < recs.length; index++) {
		let rec = recs[index];
		let ctx = { recs, rec, index, state, tag, senders };
		let sender = senders[rec.player];
		let read = read_record(rec);
		for (let sub of rec.subpackets) if (sub.type === "pill_pickup") moved.add(sub.pillbox);
		if (read.tank) sender.tank = read.tank;
		if (sender.run) follow_run(sender, read, rec, ctx);
		else open_run(sender, read, rec, ctx);

		for (let fire of read.fires) {
			let pill = state.pills[fire.pillbox];
			if (!pill || pill.inTank !== null || (fire.direction === 0 && (fire.pillbox & 1))) continue;
			let origin = [pill.x * 16 + 8, pill.y * 16 + 8];
			sender.open_fires.push({ time: rec.time, pill: fire.pillbox, nibble: fire.direction, origin,
				version, moved: moved.has(fire.pillbox),
				target: sender.tank ? Math.hypot(sender.tank[0] - origin[0], sender.tank[1] - origin[1]) : null });
		}
		/* a shell that hit a tank names its sector, so it can leave the pool */
		for (let hit of read.tank_hits) {
			let at = sender.open_fires.findIndex(f => f.nibble === hit.direction);
			if (at >= 0) sender.open_fires.splice(at, 1);
		}
		attribute_falls(sender, read, rec, ctx);

		if (read.fires.length || read.shots) sender.last_any_fire = rec.time;
		if (read.shots) sender.last_shot = rec.time;
		sender.previous_shells = read.shells;
		sender.spoke = true;
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
	}
}

function histogram(values, round = Math.round) {
	let map = new Map();
	for (let v of values) bump(map, round(v));
	return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

function quantile(sorted, q) {
	return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : NaN;
}

function summary(values) {
	let sorted = values.slice().sort((a, b) => a - b);
	let mean = values.reduce((sum, v) => sum + v, 0) / (values.length || 1);
	return `n ${values.length}  min ${sorted[0]?.toFixed(1)}  p1 ${quantile(sorted, 0.01).toFixed(1)}  ` +
		`p10 ${quantile(sorted, 0.1).toFixed(1)}  median ${quantile(sorted, 0.5).toFixed(1)}  mean ${mean.toFixed(2)}  ` +
		`p90 ${quantile(sorted, 0.9).toFixed(1)}  p99 ${quantile(sorted, 0.99).toFixed(1)}  ` +
		`p99.9 ${quantile(sorted, 0.999).toFixed(1)}  max ${sorted[sorted.length - 1]?.toFixed(1)}`;
}

function print_hist(title, values, keep = 0.0002, round) {
	console.log(`  ${title}`);
	let total = values.length;
	let rows = histogram(values, round);
	let tail_low = 0, shown = [];
	for (let [key, n] of rows) {
		if (n / total < keep) tail_low += n;
		else shown.push([key, n]);
	}
	for (let [key, n] of shown) {
		console.log(`    ${String(key).padStart(5)} ${String(n).padStart(8)} ${(100 * n / total).toFixed(2).padStart(6)}%`);
	}
	console.log(`    (${tail_low} in bins each under ${(100 * keep).toFixed(2)}%)`);
}

function print_group(title, samples, key_of, order) {
	console.log(`  ${title}`);
	let groups = new Map();
	for (let s of samples) {
		let key = key_of(s);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(s.dist);
	}
	let keys = [...groups.keys()].sort(order || ((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
	for (let key of keys) console.log(`    ${String(key).padEnd(26)} ${summary(groups.get(key))}`);
}

function print_tally(title, values) {
	let map = new Map();
	for (let v of values) bump(map, v);
	let rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
	console.log(`    ${title}: ${rows.map(([k, n]) => `${k} ${n}`).join(", ")}`);
}

function print_flags(title, list) {
	console.log(`    ${title}: later hit by the sender ${list.filter(s => s.later_hit).length}, ` +
		`sender lists that sector again ${list.filter(s => s.later_list).length}, ` +
		`another machine lists a shell on the ray ${list.filter(s => s.elsewhere).length}, ` +
		`none of these ${list.filter(s => !s.later_hit && !s.later_list && !s.elsewhere).length}`);
}

function compare_orbits() {
	console.log("\n== OFFSETS, lone pill falls: pill centre -> FB ==");
	let orbits = JSON.parse(fs.readFileSync(ORBIT_FILE, "utf8"));
	let terminals = new Map(orbits.map(o => [o.terminal.join(","), o]));
	let seen = new Map();
	for (let s of lone.pill) bump(seen, `${s.dx},${s.dy}`);
	let rows = [...seen.entries()].sort((a, b) => b[1] - a[1]);
	console.log(`  distinct offsets ${rows.length} among ${lone.pill.length} falls; ` +
		`rarest offsets ${rows.slice(-5).map(r => r[1]).join(",")}, commonest ${rows.slice(0, 5).map(r => r[1]).join(",")}`);
	let exact = 0, sector_agrees = 0, near = 0;
	for (let s of lone.pill) {
		let orbit = terminals.get(`${s.dx},${s.dy}`);
		if (orbit) {
			exact++;
			if (orbit.coarse_direction === s.nibble) sector_agrees++;
		} else if (orbits.some(o => Math.abs(o.terminal[0] - s.dx) <= 1 && Math.abs(o.terminal[1] - s.dy) <= 1)) {
			near++;
		}
	}
	console.log(`  against the orbit file's ${orbits.length} terminals: exact ${exact} (sector agrees ${sector_agrees}), within 1 px ${near}, ` +
		`otherwise ${lone.pill.length - exact - near}`);
	console.log(`  terminals seen ${orbits.filter(o => seen.has(o.terminal.join(","))).length} of ${orbits.length}`);
	let unseen = orbits.filter(o => !seen.has(o.terminal.join(",")));
	console.log(`  terminals not seen: ${unseen.map(o => `bradian ${o.bradian} sector ${o.coarse_direction} at ${o.terminal.join(",")}`).join("; ")}`);
	let by_bradian = new Map(orbits.map(o => [o.bradian, seen.get(o.terminal.join(",")) || 0]));
	for (let o of unseen) {
		let around = [-4, -2, 2, 4].map(step => (o.bradian + step + 256) % 256);
		console.log(`    neighbours of bradian ${o.bradian}: ${around.map(b => `${b}: ${by_bradian.get(b)}`).join(", ")}`);
	}
	let off = rows.filter(([key]) => !terminals.has(key));
	console.log(`  offsets that are no terminal: ${off.length} ${off.slice(0, 12).map(([k, n]) => k + " x" + n).join("  ")}`);
	let distances = orbits.map(o => Math.hypot(o.terminal[0], o.terminal[1]));
	console.log(`  orbit file's terminal distances: ${summary(distances)}`);
	console.log("  per sector, lone falls");
	for (let nibble = 0; nibble < 16; nibble++) {
		console.log(`    ${String(nibble).padEnd(4)} ${summary(lone.pill.filter(s => s.nibble === nibble).map(s => s.dist))}`);
	}
	let means = Array.from({ length: 16 }, () => [0, 0, 0]);
	for (let s of lone.pill) {
		means[s.nibble][0] += s.dx;
		means[s.nibble][1] += s.dy;
		means[s.nibble][2]++;
	}
	let cx = 0, cy = 0;
	for (let [x, y, n] of means) {
		cx += x / (n || 1) / 16;
		cy += y / (n || 1) / 16;
	}
	console.log(`  centring check, mean of the sector means of (dx, dy): ${cx.toFixed(3)}, ${cy.toFixed(3)}`);
}

function report() {
	console.log(`files read ${files_read}, failed ${files_failed}`);

	console.log("\n== LONE SHELLS (by elimination) ==");
	for (let kind of ["pill", "tank"]) {
		console.log(`\n-- ${kind} --`);
		let total = [...lone_fates[kind].values()].reduce((sum, n) => sum + n, 0);
		console.log("  fates");
		for (let [fate, n] of [...lone_fates[kind].entries()].sort((a, b) => b[1] - a[1])) {
			console.log(`    ${fate.padEnd(20)} ${String(n).padStart(8)} ${(100 * n / total).toFixed(2).padStart(6)}%`);
		}
		console.log(`  spoiled ${JSON.stringify([...lone_spoiled[kind].entries()])}`);
		let list = lone[kind];
		console.log(`  distance origin -> FB   ${summary(list.map(s => s.dist))}`);
		print_hist("distance, px, rounded", list.map(s => s.dist));
		let strict = list.filter(s => s.gap <= STRICT_GAP_TICKS);
		console.log(`  gap-free (record gaps <= ${STRICT_GAP_TICKS}): ${strict.length}`);
		print_hist("ticks, fire record -> FB record, gap-free", strict.map(s => s.dt));
		let gone = silent[kind];
		console.log(`  silent runs: ${gone.length}, of which a death in the closing record ${gone.filter(s => s.dead).length}`);
		console.log(`    last listed distance   ${summary(gone.filter(s => s.last !== null).map(s => s.last))}`);
		console.log(`    age at last listing    ${summary(gone.map(s => s.age))}`);
		print_hist("silent, last listed distance, 16 px bins", gone.filter(s => s.last !== null).map(s => s.last), 0, v => Math.floor(v / 16) * 16);
		print_flags("silent, afterwards", gone);
		console.log(`    closing gap   ${summary(gone.map(s => s.closing_gap))}`);
		console.log(`    closing gap of a falling shell, the control   ${summary(list.map(s => s.closing_gap))}`);
		console.log(`    explosion on the ray in or just after the closing record: ${gone.filter(s => s.ray_explosion).length}`);
		print_tally("first thing on the ray, silent shells", gone.map(s => s.obstacle));
		print_tally("first thing on the ray, silent shells, no explosion on the ray", gone.filter(s => !s.ray_explosion).map(s => s.obstacle));
		print_tally("first thing on the ray, falling shells, the control", list.map(s => s.obstacle));
		let bare = gone.filter(s => !s.ray_explosion && s.obstacle === "nothing");
		console.log(`    silent with nothing on the ray and no explosion: ${bare.length}`);
		if (bare.length) {
			console.log(`      last listed distance   ${summary(bare.filter(s => s.last !== null).map(s => s.last))}`);
			console.log(`      closing gap            ${summary(bare.map(s => s.closing_gap))}`);
			console.log(`      how far it could have flown by the closing record ${summary(bare.map(s => s.last + 2 * s.closing_gap))}`);
			print_flags("afterwards", bare);
		}
		let unseen = never[kind];
		console.log(`  never listed: ${unseen.length}`);
		print_flags("never listed, afterwards", unseen);
		console.log(`    target distance at fire   ${summary(unseen.filter(s => s.target !== null).map(s => s.target))}`);
		console.log(`    gap to the next record    ${summary(unseen.map(s => s.first_gap))}`);
		console.log(`    age when given up         ${summary(unseen.map(s => s.closing_age))}`);
		console.log(`  last listing of a falling shell   ${summary(list.filter(s => s.last !== null).map(s => s.last))}`);
		console.log(`  first listing of a falling shell  ${summary(list.filter(s => s.first !== null).map(s => s.first))}`);
		let spans = list.filter(s => s.first !== null && s.gap <= 8 && s.last_age - s.first_age >= 30);
		console.log(`  px per tick, first to last listing ${summary(spans.map(s => (s.last - s.first) / (s.last_age - s.first_age)))}`);
		print_hist("ticks, fire record -> FB record, all", list.map(s => s.dt), 0.002);
		console.log(`  ticks, fire record -> FB record, all   ${summary(list.map(s => s.dt))}`);
		let aged = list.filter(s => s.first_age === 0);
		console.log(`  the same plus the age the shell already had in the fire record, (first listing - 8) / 2:  ` +
			`${summary(aged.map(s => s.dt + (s.first - 8) / 2))}`);
	}

	console.log("\n== ALL FALLS (by bearing) ==");
	console.log(`  ${JSON.stringify([...fall_counts.entries()])}`);
	console.log(`  distance   ${summary(falls.map(s => s.dist))}`);
	print_hist("distance, px, rounded", falls.map(s => s.dist));
	print_group("by sector", falls, s => s.nibble, (a, b) => a - b);
	print_group("by archive and version", falls, s => s.archive);
	print_group("by terrain under the fall", falls, s => s.terrain);
	print_group("by whether the pill was ever carried", falls, s => (s.moved ? "planted" : "start square"));
	print_group("by target distance at fire, 16 px bins", falls.filter(s => s.target !== null),
		s => Math.min(Math.floor(s.target / 16) * 16, 208), (a, b) => a - b);

	/* the centring check: opposite sectors should balance about the pill */
	let means = Array.from({ length: 16 }, () => [0, 0, 0]);
	for (let s of falls) {
		means[s.nibble][0] += s.dx;
		means[s.nibble][1] += s.dy;
		means[s.nibble][2]++;
	}
	let cx = 0, cy = 0;
	for (let [x, y, n] of means) {
		cx += x / (n || 1) / 16;
		cy += y / (n || 1) / 16;
	}
	console.log(`  mean of the 16 sector means of (dx, dy): ${cx.toFixed(3)}, ${cy.toFixed(3)}`);
	console.log("  falls off the band, and unpaired ones, tested for any grounded pill at range");
	for (let [key, n] of [...range_checks.entries()].sort()) console.log(`    ${key.padEnd(60)} ${n}`);
	compare_orbits();
}

function main() {
	let args = process.argv.slice(2);
	let dump = null;
	let at = args.indexOf("--dump");
	if (at >= 0) {
		dump = args[at + 1];
		args.splice(at, 2);
	}
	let targets = args.length ? args : [corpus_root()];
	let walk = (target, archive) => {
		if (fs.statSync(target).isDirectory()) {
			if (SKIPPED_DIRECTORIES.has(path.basename(target))) return;
			for (let name of fs.readdirSync(target)) walk(path.join(target, name), archive);
		} else if (!SKIPPED_EXTENSIONS.test(target)) {
			try {
				tally(target, archive);
				files_read++;
			} catch (error) {
				files_failed++;
				if (!/Not a Bolo log/.test(error.message)) console.error(`${replay_label(target)}: ${error.message}`);
			}
		}
	};
	targets.forEach((target, index) => walk(target, `archive ${index + 1}`));
	report();
	if (dump) fs.writeFileSync(dump, JSON.stringify({ lone, falls, silent, never }));
}

main();
