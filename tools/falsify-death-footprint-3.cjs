#!/usr/bin/env node
/* Round 3: localize the death-blast tree-clearing boundary.
 *
 * Round 1 (446 logs) proved a tank's death clears forest beyond the wreck's
 * centre square — but not under its ENTIRE 16px footprint: 89
 * contradictions, 10 hidden-tank hits.  Round 2 falsified the ammo-gate
 * refinement (terminal-explosion tier): contradictions split evenly across
 * tiers, and tier-conditioned clearing both still over-cleared and missed
 * real phantoms.  What round 2 DID show is a massive overlap effect: 82 of
 * 89 contradictions sat in footprint squares the tank lapped into by <=4px
 * (5.0% contradiction rate), while squares overlapped >=5px sat at the
 * baseline noise floor (0.3-0.5%).
 *
 *   HYPOTHESIS: the death explosion clears trees out to a fixed pixel
 *   distance around the dying tank, smaller than the full footprint and
 *   independent of the terminal-explosion tier.
 *
 * This round measures WHERE the boundary is, per pixel, in two rival
 * formulations, so the corpus can also say which one is the real rule:
 *
 *   overlap   the per-axis pixel overlap between the 16px character and
 *             the square, min over axes (1..16; the known case (143,123)
 *             cleared at 3px overlap, so the cut lives at 1-2px if this is
 *             the rule);
 *   distance  Chebyshev distance in pixels from the tank's centre pixel to
 *             the square's nearest pixel (0 for the centre square, up to
 *             ~8 for a barely-lapped neighbour).
 *
 * The "candidate" model clears the full footprint unconditionally and
 * tags every cleared square with both measures.  Two per-pixel histograms
 * then bracket the boundary from opposite sides:
 *
 *   - contradictions/hidden per pixel  = squares that should NOT have been
 *     cleared (tree provably still stood) — expected to pile up beyond the
 *     blast reach;
 *   - the BASELINE model's phantom squares (shells flying through its
 *     forest) that lie in a death footprint, per pixel = squares that
 *     really WERE cleared but the centre rule missed — expected to pile up
 *     within the blast reach.
 *
 * The rule that shows a clean step (low-contradiction pixels holding all
 * the phantoms, high-contradiction pixels holding none) wins; the step
 * position is the radius.  If NEITHER table shows a step — contradictions
 * and phantoms mixed across the same pixel values — the radius story is
 * falsified too and the discriminator is something else entirely.
 *
 * Models: centre (baseline), candidate (full footprint, instrumented),
 * control (footprint at every dying position — positive control; if the
 * corpus does not convict it, the detectors are broken).
 *
 * Shell falls (FB) on forest are NOT counted (an end-of-range shell falls
 * harmlessly without felling the tree).  Phantom squares outside any death
 * footprint come from a separate, still-unexplained mechanism (~650 even
 * under the control) — compare models relatively, not against zero.
 *
 * Usage:
 *   node tools/falsify-death-footprint-3.cjs [corpus-dir] [--fast]
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

/* Footprint squares, each with the two boundary measures: min-axis pixel
 * overlap with the 16px character, and Chebyshev distance from the tank's
 * centre pixel to the square's nearest pixel. */
function footprint_squares(sub) {
	let wx = sub.x * 16 + sub.pixelX;
	let wy = sub.y * 16 + sub.pixelY;
	let cx = wx + 8;
	let cy = wy + 8;
	let squares = [];
	for (let x of new Set([wx >> 4, (wx + 15) >> 4])) {
		for (let y of new Set([wy >> 4, (wy + 15) >> 4])) {
			let ox = Math.min(wx + 15, x * 16 + 15) - Math.max(wx, x * 16) + 1;
			let oy = Math.min(wy + 15, y * 16 + 15) - Math.max(wy, y * 16) + 1;
			let dx = cx < x * 16 ? x * 16 - cx : cx > x * 16 + 15 ? cx - (x * 16 + 15) : 0;
			let dy = cy < y * 16 ? y * 16 - cy : cy > y * 16 + 15 ? cy - (y * 16 + 15) : 0;
			squares.push([x, y, {overlap: Math.min(ox, oy), distance: Math.max(dx, dy)}]);
		}
	}
	return squares;
}

/* rule(sub, is_death_moment) -> [origin, squares] lists. */
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
		clearances_by_overlap: {},
		clearances_by_distance: {},
		regrowth: 0,
		contradictions: 0,
		contradictions_by_origin: {},
		contradictions_by_overlap: {},
		contradictions_by_distance: {},
		contradictions_delay_le_1s: 0,
		contradictions_delay_1_to_5s: 0,
		contradictions_delay_5_to_60s: 0,
		contradictions_delay_gt_60s: 0,
		hidden_tank_evidence: 0,
		hidden_by_origin: {},
		hidden_by_overlap: {},
		hidden_by_distance: {},
		other_mutations: 0,
		plants_on_forest: 0,
		crossings: 0,
		phantom_squares: 0, /* squares crossed >= CROSSING_PHANTOM_THRESHOLD times */
		phantom_at_death_fp: 0,
		phantom_fp_by_overlap: {},
		phantom_fp_by_distance: {},
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
		pending: new Map(), /* key -> {time, origin, measures, hidden_reported} */
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
				if (pending.measures) {
					bump(model.stats.contradictions_by_overlap, pending.measures.overlap);
					bump(model.stats.contradictions_by_distance, pending.measures.distance);
				}
				if (delay <= 50)
					model.stats.contradictions_delay_le_1s++;
				else if (delay <= 250)
					model.stats.contradictions_delay_1_to_5s++;
				else if (delay <= 3000)
					model.stats.contradictions_delay_5_to_60s++;
				else
					model.stats.contradictions_delay_gt_60s++;
				let m = pending.measures;
				add_sample(model.stats.contradiction_samples,
					`${evidence.file} ${format_time(evidence.time)} (${x},${y}) ` +
					`${pending.origin}${m ? `[ov${m.overlap}px,d${m.distance}px]` : ""}` +
					`@${format_time(pending.time)} via ${evidence.source}`);
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

/* Death-footprint index: for every square any death's footprint covered,
 * the earliest such death's time and boundary measures — so a baseline
 * phantom square can report how deep in a footprint it sat. */
function index_death_footprints(records) {
	let index = new Map();
	let in_sequence = Array.from({length: 16}, () => false);
	for (let record of records) {
		for (let sub of record.subpackets) {
			if (sub.type !== "tank_position")
				continue;
			if (!sub.dying) {
				in_sequence[record.player] = false;
				continue;
			}
			if (!in_sequence[record.player]) {
				in_sequence[record.player] = true;
				for (let [x, y, measures] of footprint_squares(sub)) {
					let key = square_key(x, y);
					if (!index.has(key))
						index.set(key, {time: record.time, measures});
				}
			}
		}
	}
	return index;
}

/* Shell crossings: the engine restates every in-flight shell a few times a
 * second.  Match each shell to its predecessor in the sender's previous
 * restatement (same direction, closest, within 8 squares) and walk the
 * segment; an intermediate model-forest square means the shell flew through
 * a tree the model believes in. */
function check_crossings(model, file, time, prev, now, death_fp_index) {
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
					let source = death_fp_index.get(square_key(sx, sy));
					if (source && source.time <= time) {
						model.stats.phantom_at_death_fp++;
						bump(model.stats.phantom_fp_by_overlap, source.measures.overlap);
						bump(model.stats.phantom_fp_by_distance, source.measures.distance);
						add_sample(model.stats.phantom_samples,
							`${file} ~${format_time(time)} (${key}) crossed x${CROSSING_PHANTOM_THRESHOLD}+ ` +
							`in death-fp[ov${source.measures.overlap}px,d${source.measures.distance}px]@${format_time(source.time)}`);
					} else {
						add_sample(model.stats.phantom_samples,
							`${file} ~${format_time(time)} (${key}) crossed x${CROSSING_PHANTOM_THRESHOLD}+`);
					}
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
	let death_fp_index = index_death_footprints(records);

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
							for (let [x, y, measures] of squares) {
								if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE)
									continue;
								let key = square_key(x, y);
								let terrain = model.grid[key];
								if (!is_forest(terrain))
									continue;
								model.grid[key] = cleared_terrain(terrain);
								model.stats.clearances++;
								bump(model.stats.clearances_by_origin, origin);
								if (origin === "death-footprint" && measures) {
									bump(model.stats.clearances_by_overlap, measures.overlap);
									bump(model.stats.clearances_by_distance, measures.distance);
								}
								if (!model.pending.has(key)) {
									model.pending.set(key, {
										time: record.time,
										origin,
										measures: origin === "death-footprint" ? measures : null,
									});
								}
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
								if (pending.measures) {
									bump(model.stats.hidden_by_overlap, pending.measures.overlap);
									bump(model.stats.hidden_by_distance, pending.measures.distance);
								}
								let m = pending.measures;
								add_sample(model.stats.hidden_tank_samples,
									`${relative_file} ${format_time(record.time)} (${x},${y}) hidden tank on ` +
									`${pending.origin}${m ? `[ov${m.overlap}px,d${m.distance}px]` : ""}@${format_time(pending.time)}`);
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
					check_crossings(model, relative_file, record.time, prev, now, death_fp_index);
			}
			previous_shells[record.player] = now;
		}
	}

	for (let [name, model] of Object.entries(models)) {
		for (let key of Object.keys(totals[name])) {
			if (key.endsWith("_samples")) {
				for (let sample of model.stats[key])
					add_sample(totals[name][key], sample);
			} else if (typeof totals[name][key] === "object") {
				for (let [k, n] of Object.entries(model.stats[key]))
					totals[name][key][k] = (totals[name][key][k] || 0) + n;
			} else {
				totals[name][key] += model.stats[key];
			}
		}
	}
	return true;
}

function sorted_table(table) {
	let keys = Object.keys(table).map(Number).sort((a, b) => a - b);
	return "{" + keys.map(k => `${k}px:${table[k]}`).join(" ") + "}";
}

/* Side-by-side per-pixel table: how often clearing that pixel value was
 * WRONG (contradictions + hidden) vs how often skipping it would MISS a
 * real clear (baseline phantoms).  The step between the two locates the
 * blast boundary. */
function boundary_table(label, clear, contra, hidden, phantom) {
	let keys = new Set([...Object.keys(clear), ...Object.keys(contra), ...Object.keys(hidden), ...Object.keys(phantom)]);
	console.log(`  boundary by ${label}: px  cleared  wrong(contra+hidden)  missed-real(baseline phantoms)`);
	for (let k of [...keys].map(Number).sort((a, b) => a - b)) {
		let wrong = (contra[k] || 0) + (hidden[k] || 0);
		let rate = clear[k] ? ` (${(100 * wrong / clear[k]).toFixed(1)}%)` : "";
		console.log(`    ${String(k).padStart(2)}  ${String(clear[k] || 0).padStart(6)}  ` +
			`${String(wrong).padStart(4)}${rate.padEnd(8)}  ${phantom[k] || 0}`);
	}
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

console.log(`Death blast-boundary falsification scan (round 3): ${files} log files`);
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
			`  (squares crossed >=${CROSSING_PHANTOM_THRESHOLD}x: ${stats.phantom_squares}, ` +
			`of which in a death footprint: ${stats.phantom_at_death_fp})`);
	}
	console.log(`  other legitimate mutations on cleared squares: ${stats.other_mutations}`);
	if (name === "candidate") {
		console.log(`  death-footprint clearances by overlap: ${sorted_table(stats.clearances_by_overlap)}`);
		console.log(`  death-footprint clearances by distance: ${sorted_table(stats.clearances_by_distance)}`);
		boundary_table("min-axis OVERLAP", stats.clearances_by_overlap,
			stats.contradictions_by_overlap, stats.hidden_by_overlap,
			totals.centre.phantom_fp_by_overlap);
		boundary_table("centre DISTANCE", stats.clearances_by_distance,
			stats.contradictions_by_distance, stats.hidden_by_distance,
			totals.centre.phantom_fp_by_distance);
	}
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
Reading the verdict (the two "boundary by" tables under "candidate"):
  - "wrong" counts squares whose tree provably still stood after clearing
    (contradictions + hidden tanks); "missed-real" counts baseline phantom
    squares (trees the real game removed) at that pixel value.
  - The radius hypothesis SURVIVES if one table shows a clean step: pixel
    values on one side hold nearly all the "missed-real" and ~none of the
    "wrong" (clear those), the other side the reverse (do not).  The
    cleaner-stepping table names the real rule (overlap vs distance); the
    step position is the boundary.
  - It is FALSIFIED if "wrong" and "missed-real" mix across the same pixel
    values in BOTH tables - then neither formulation separates them and
    the discriminator is something else.
  - "control" must be convicted (contradictions/hidden far above baseline)
    or the detectors are broken - trust nothing.`);
