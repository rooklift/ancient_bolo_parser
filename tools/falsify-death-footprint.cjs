#!/usr/bin/env node
/* Attempt to FALSIFY the death-moment footprint hypothesis:
 *
 *   When a tank dies, the initial explosion eventlessly clears the forest
 *   under every square its 16px character overlaps at the FIRST dying-bit
 *   position (up to 4 squares).  The subsequent dying positions (the
 *   sliding, burning wreck) clear only their centre square, as the engine
 *   already models.
 *
 * Three models run side by side over every log:
 *
 *   centre     the shipped rule (centre square of every dying position) —
 *              the baseline;
 *   candidate  centre + the death-moment footprint;
 *   control    footprint at EVERY dying position — known-bad (the 2003-notes
 *              era corpus run rejected it); it is here as a positive control:
 *              if the corpus does NOT convict it, the detectors are broken
 *              and none of the other numbers can be trusted.
 *
 * Falsifiers, in order of strength:
 *
 * 1. OVER-CLEARING — the candidate cleared a tree that was really still
 *    standing.  Since the candidate's clears are a superset of the
 *    baseline's, every count is reported per origin ("slide-centre" squares
 *    are shared with the baseline; "death-footprint" squares are the new
 *    claim).  Evidence the tree still stood:
 *      - a later explicit tree-fell (6T terrain change or 7T explosion to
 *        grass/mined grass) with no regrowth in between.  Farming is the
 *        sharpest form: an LGM cannot farm a tree that is not there;
 *      - a later LIVE tank reporting the hidden-in-trees bit with its
 *        centre on the cleared square.
 *    The hypothesis is FALSE if death-footprint squares accumulate
 *    contradictions beyond the sub-second event-ordering noise the baseline
 *    itself shows (delays >1s, and especially >5s, are the real signal).
 *
 * 2. UNDER-CLEARING — phantom trees the candidate still fails to clear,
 *    i.e. the mechanism is wrong or incomplete:
 *      - a pill PLANTED on a square the model believes is forest (plants on
 *        forest are impossible; ~90 plants per log land on anything but);
 *      - shells restated in flight THROUGH a model-forest square (forest
 *        blocks shells; squares crossed >=3 times are near-certain phantom
 *        trees, 1-2 crossings can be offset-decode noise).
 *    The hypothesis is INCOMPLETE if these persist at death sites, and
 *    WRONG if the candidate's numbers are no better than the baseline's.
 *
 * Shell falls (FB) on forest are NOT counted: an end-of-range shell falls
 * harmlessly on a forest square without felling the tree (verified: falls
 * land on squares whose trees are only felled by explicit events much
 * later), so they are not evidence either way.
 *
 * Usage:
 *   node tools/falsify-death-footprint.cjs [corpus-dir] [--fast]
 *
 * --fast skips the shell-crossing analysis (the expensive part).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => a !== "--fast");
const FAST = process.argv.includes("--fast");
const ROOT = args[0] || "C:/Users/Owner/__DOCS/Bolo Archives/Nemokrad's Bolo logs";

const MAP_SIZE = 256;
const DEEP_SEA = 255;
const FOREST = 5;
const GRASS = 7;
const MINED_FOREST = 13;
const MINED_GRASS = 15;
const SAMPLE_CAP = 25;
const CROSSING_PHANTOM_THRESHOLD = 3;

function is_forest(terrain) {
	return terrain === FOREST || terrain === MINED_FOREST;
}

function cleared_terrain(terrain) {
	return terrain === MINED_FOREST ? MINED_GRASS : GRASS;
}

function centre_squares(sub) {
	return [[
		(sub.x * 16 + sub.pixelX + 8) >> 4,
		(sub.y * 16 + sub.pixelY + 8) >> 4,
	]];
}

function footprint_squares(sub) {
	let wx = sub.x * 16 + sub.pixelX;
	let wy = sub.y * 16 + sub.pixelY;
	let squares = [];
	for (let x of new Set([wx >> 4, (wx + 15) >> 4])) {
		for (let y of new Set([wy >> 4, (wy + 15) >> 4]))
			squares.push([x, y]);
	}
	return squares;
}

/* Each rule maps (dying position, is_death_moment) to squares to clear,
 * tagged with an origin label so contradictions can be attributed. */
const RULES = {
	centre: (sub, death_moment) =>
		[["slide-centre", centre_squares(sub)]],
	candidate: (sub, death_moment) => death_moment ?
		[["death-footprint", footprint_squares(sub)]] :
		[["slide-centre", centre_squares(sub)]],
	control: (sub, death_moment) =>
		[["footprint-every", footprint_squares(sub)]],
};

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, {withFileTypes: true});
	} catch {
		return;
	}
	for (let entry of entries) {
		let item = path.join(dir, entry.name);
		if (entry.isDirectory())
			yield* walk(item);
		else if (entry.isFile())
			yield item;
	}
}

function is_log(bytes) {
	return bytes.length >= 72 && bytes[0] === 0x42 && bytes[1] === 0x6f &&
		bytes[2] === 0x6c && bytes[3] === 0x6f;
}

function square_key(x, y) {
	return y * MAP_SIZE + x;
}

/* Set per file so sample timestamps read as minutes into the log rather
 * than the Mac's raw TickCount-derived tags. */
let time_base = 0;

function format_time(ticks) {
	let hundredths = Math.round(Math.max(0, ticks - time_base) * 2);
	let minutes = Math.floor(hundredths / 6000);
	let seconds = Math.floor(hundredths / 100) % 60;
	let fraction = hundredths % 100;
	return `${minutes}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function new_stats() {
	return {
		clearances: 0,
		clearances_by_origin: {},
		regrowth: 0,
		contradictions: 0,
		contradictions_by_origin: {},
		contradictions_delay_le_1s: 0,
		contradictions_delay_1_to_5s: 0,
		contradictions_delay_5_to_60s: 0,
		contradictions_delay_gt_60s: 0,
		hidden_tank_evidence: 0,
		hidden_by_origin: {},
		other_mutations: 0,
		plants_on_forest: 0,
		crossings: 0,
		phantom_squares: 0, /* squares crossed >= CROSSING_PHANTOM_THRESHOLD times */
		contradiction_samples: [],
		hidden_tank_samples: [],
		plant_samples: [],
		phantom_samples: [],
	};
}

function add_sample(list, value) {
	if (list.length < SAMPLE_CAP)
		list.push(value);
}

function bump(table, key) {
	table[key] = (table[key] || 0) + 1;
}

function new_model(seed) {
	return {
		grid: BoloGame.initial_state(seed).grid,
		pending: new Map(), /* key -> {time, origin, hidden_reported} */
		cross_counts: new Map(),
		stats: new_stats(),
	};
}

function set_terrain(model, x, y, terrain, evidence) {
	if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE)
		return;
	let key = square_key(x, y);
	let pending = model.pending.get(key);
	if (pending && evidence) {
		if (is_forest(terrain)) {
			model.stats.regrowth++;
		} else if (terrain === GRASS || terrain === MINED_GRASS) {
			let delay = evidence.time - pending.time;
			if (delay > 0) {
				model.stats.contradictions++;
				bump(model.stats.contradictions_by_origin, pending.origin);
				if (delay <= 50)
					model.stats.contradictions_delay_le_1s++;
				else if (delay <= 250)
					model.stats.contradictions_delay_1_to_5s++;
				else if (delay <= 3000)
					model.stats.contradictions_delay_5_to_60s++;
				else
					model.stats.contradictions_delay_gt_60s++;
				add_sample(model.stats.contradiction_samples,
					`${evidence.file} ${format_time(evidence.time)} (${x},${y}) ` +
					`${pending.origin}@${format_time(pending.time)} via ${evidence.source}`);
			}
		} else {
			model.stats.other_mutations++;
		}
		model.pending.delete(key);
	}
	model.grid[key] = terrain;
}

function mine_square(model, x, y) {
	let terrain = model.grid[square_key(x, y)];
	if (terrain >= 2 && terrain <= 7)
		model.grid[square_key(x, y)] = terrain + 8;
}

function apply_explicit_event(model, seed, sub, evidence) {
	if (sub.type === "terrain_change") {
		set_terrain(model, sub.x, sub.y, sub.terrain, evidence);
		return;
	}
	if (sub.code === 0x0b)
		return;
	if (sub.code === 0x0c) {
		mine_square(model, sub.x, sub.y);
		return;
	}
	if (sub.code === 0x0d) {
		for (let [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
			let x = sub.x + dx;
			let y = sub.y + dy;
			if (x >= MAP_SIZE || y >= MAP_SIZE)
				continue;
			let terrain = model.grid[square_key(x, y)];
			if (terrain !== DEEP_SEA && terrain !== 1 && terrain !== 9 &&
					!seed.bases.some(base => base.x === x && base.y === y))
				set_terrain(model, x, y, 3, evidence);
		}
		return;
	}
	set_terrain(model, sub.x, sub.y, sub.code, evidence);
}

/* Shell crossings: the engine restates every in-flight shell a few times a
 * second.  Match each shell to its predecessor in the sender's previous
 * restatement (same direction, closest, within 8 squares) and walk the
 * segment; an intermediate model-forest square means the shell flew through
 * a tree the model believes in. */
function check_crossings(model, file, time, prev, now) {
	for (let sh of now) {
		let px = sh.x * 16 + sh.px;
		let py = sh.y * 16 + sh.py;
		let best = null;
		let best_distance = Infinity;
		for (let p of prev) {
			if (p.direction !== sh.direction)
				continue;
			let qx = p.x * 16 + p.px;
			let qy = p.y * 16 + p.py;
			let distance = Math.hypot(px - qx, py - qy);
			if (distance > 0 && distance < 128 && distance < best_distance) {
				best = {qx, qy};
				best_distance = distance;
			}
		}
		if (!best)
			continue;
		let steps = Math.ceil(best_distance / 4);
		for (let i = 1; i < steps; i++) {
			let ix = Math.round(best.qx + (px - best.qx) * i / steps);
			let iy = Math.round(best.qy + (py - best.qy) * i / steps);
			let sx = ix >> 4;
			let sy = iy >> 4;
			if ((sx === (px >> 4) && sy === (py >> 4)) ||
					(sx === (best.qx >> 4) && sy === (best.qy >> 4)))
				continue;
			if (is_forest(model.grid[square_key(sx, sy)])) {
				model.stats.crossings++;
				let key = `${sx},${sy}`;
				let count = (model.cross_counts.get(key) || 0) + 1;
				model.cross_counts.set(key, count);
				if (count === CROSSING_PHANTOM_THRESHOLD) {
					model.stats.phantom_squares++;
					add_sample(model.stats.phantom_samples,
						`${file} ~${format_time(time)} (${key}) crossed x${CROSSING_PHANTOM_THRESHOLD}+`);
				}
				break;
			}
		}
	}
}

function scan_file(file, totals) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	if (!is_log(bytes))
		return false;
	let records = [...BoloLog.records(bytes, {})];
	time_base = records.length ? records[0].time : 0;
	let seed = BoloGame.extract_initial_map(records);
	let models = Object.fromEntries(Object.keys(RULES).map(name => [name, new_model(seed)]));
	let relative_file = path.relative(ROOT, file) || path.basename(file);

	/* One engine state, shared by all models, purely to decode the chained
	 * shell lists; terrain truth lives in the per-model grids above. */
	let engine = BoloGame.initial_state(seed);
	let previous_shells = Array.from({length: 16}, () => []);
	let in_death_sequence = Array.from({length: 16}, () => false);

	for (let record of records) {
		for (let sub of record.subpackets) {
			if (sub.type === "tank_position") {
				if (sub.dying) {
					let death_moment = !in_death_sequence[record.player];
					in_death_sequence[record.player] = true;
					for (let [name, rule] of Object.entries(RULES)) {
						let model = models[name];
						for (let [origin, squares] of rule(sub, death_moment)) {
							for (let [x, y] of squares) {
								if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE)
									continue;
								let key = square_key(x, y);
								let terrain = model.grid[key];
								if (!is_forest(terrain))
									continue;
								model.grid[key] = cleared_terrain(terrain);
								model.stats.clearances++;
								bump(model.stats.clearances_by_origin, origin);
								if (!model.pending.has(key))
									model.pending.set(key, {time: record.time, origin});
							}
						}
					}
				} else {
					in_death_sequence[record.player] = false;
					if (sub.hidden) {
						let [[x, y]] = centre_squares(sub);
						let key = square_key(x, y);
						for (let model of Object.values(models)) {
							let pending = model.pending.get(key);
							if (pending && !pending.hidden_reported && record.time > pending.time) {
								pending.hidden_reported = true;
								model.stats.hidden_tank_evidence++;
								bump(model.stats.hidden_by_origin, pending.origin);
								add_sample(model.stats.hidden_tank_samples,
									`${relative_file} ${format_time(record.time)} (${x},${y}) ` +
									`hidden tank on ${pending.origin}@${format_time(pending.time)}`);
							}
						}
					}
				}
			} else if (sub.type === "terrain_change" || sub.type === "explosion") {
				let evidence = {
					file: relative_file,
					time: record.time,
					source: sub.type === "terrain_change" ?
						`6${sub.terrain.toString(16).toUpperCase()}` :
						`7${sub.code.toString(16).toUpperCase()}`,
				};
				for (let model of Object.values(models))
					apply_explicit_event(model, seed, sub, evidence);
			} else if (sub.type === "lay_mine" || sub.type === "board_boat") {
				let tank = engine.tanks[record.player];
				if (tank) {
					let x = (tank.x * 16 + tank.px + 8) >> 4;
					let y = (tank.y * 16 + tank.py + 8) >> 4;
					for (let model of Object.values(models)) {
						if (sub.type === "lay_mine")
							mine_square(model, x, y);
						else if (model.grid[square_key(x, y)] === 9)
							model.grid[square_key(x, y)] = 1;
					}
				}
			} else if (sub.type === "pill_plant") {
				for (let model of Object.values(models)) {
					if (is_forest(model.grid[square_key(sub.x, sub.y)])) {
						model.stats.plants_on_forest++;
						add_sample(model.stats.plant_samples,
							`${relative_file} ${format_time(record.time)} plant on model-forest (${sub.x},${sub.y})`);
					}
				}
			}
		}

		BoloGame.apply_record(engine, record, null, null);

		if (!FAST) {
			let now = engine.shells[record.player] || [];
			let prev = previous_shells[record.player];
			if (now.length && prev.length) {
				for (let model of Object.values(models))
					check_crossings(model, relative_file, record.time, prev, now);
			}
			previous_shells[record.player] = now;
		}
	}

	for (let [name, model] of Object.entries(models)) {
		for (let key of Object.keys(totals[name])) {
			if (key.endsWith("_samples")) {
				for (let sample of model.stats[key])
					add_sample(totals[name][key], sample);
			} else if (key.endsWith("_by_origin")) {
				for (let [origin, n] of Object.entries(model.stats[key]))
					totals[name][key][origin] = (totals[name][key][origin] || 0) + n;
			} else {
				totals[name][key] += model.stats[key];
			}
		}
	}
	return true;
}

let totals = Object.fromEntries(Object.keys(RULES).map(name => [name, new_stats()]));
let files = 0;
for (let file of walk(ROOT)) {
	try {
		if (scan_file(file, totals))
			files++;
	} catch (error) {
		console.error(`${path.relative(ROOT, file)}: ${error.message}`);
	}
}

console.log(`Death-moment footprint falsification scan: ${files} log files`);
console.log(`Root: ${ROOT}${FAST ? "  (--fast: shell crossings skipped)" : ""}`);
for (let [name, stats] of Object.entries(totals)) {
	console.log(`\n${name}:`);
	console.log(`  forest clearances: ${stats.clearances}  ${JSON.stringify(stats.clearances_by_origin)}`);
	console.log(`  regrowth on cleared squares: ${stats.regrowth}`);
	console.log(`  OVER-CLEARING`);
	console.log(`    later tree-fell without regrowth (contradictions): ${stats.contradictions}  ${JSON.stringify(stats.contradictions_by_origin)}`);
	console.log(`      delay <=1s / 1-5s / 5-60s / >60s: ` +
		`${stats.contradictions_delay_le_1s} / ${stats.contradictions_delay_1_to_5s} / ` +
		`${stats.contradictions_delay_5_to_60s} / ${stats.contradictions_delay_gt_60s}`);
	console.log(`    live hidden tank on a cleared square: ${stats.hidden_tank_evidence}  ${JSON.stringify(stats.hidden_by_origin)}`);
	console.log(`  UNDER-CLEARING`);
	console.log(`    pill plants on model-forest: ${stats.plants_on_forest}`);
	if (!FAST) {
		console.log(`    shell flights through model-forest: ${stats.crossings}` +
			`  (squares crossed >=${CROSSING_PHANTOM_THRESHOLD}x: ${stats.phantom_squares})`);
	}
	console.log(`  other legitimate mutations on cleared squares: ${stats.other_mutations}`);
	for (let [label, list] of [
			["contradiction samples", stats.contradiction_samples],
			["hidden-tank samples", stats.hidden_tank_samples],
			["plant-on-forest samples", stats.plant_samples],
			["phantom-square samples", stats.phantom_samples]]) {
		if (list.length) {
			console.log(`  ${label}:`);
			for (let sample of list)
				console.log(`    ${sample}`);
		}
	}
}

console.log(`
Reading the verdict:
  - "control" must show clearly more contradictions and hidden-tank hits than
    "centre"; if it does not, the detectors are broken - trust nothing else.
  - The hypothesis is FALSIFIED if "candidate" attributes contradictions or
    hidden-tank evidence to origin "death-footprint" beyond sub-second
    (event-ordering) noise - delays over 1s, hidden tanks especially.
  - The hypothesis is WRONG-OR-INCOMPLETE if "candidate" does not clearly
    reduce plants-on-forest and >=${CROSSING_PHANTOM_THRESHOLD}x-crossed phantom squares versus "centre".`);
