#!/usr/bin/env node
/* How big is the forest clearance around a dying tank?
 *
 * A dying tank fells trees with no terrain event at all: the dying-bit
 * positions are the only trace in the log, and playback has to infer the
 * rest.  Two things about that clearance are settled and are NOT
 * re-litigated here:
 *
 *   - nothing special happens at the FIRST dying position.  Earlier work
 *     tested a bigger blast at the moment of death with a centre-only
 *     trail afterwards; the corpus rejected it.  Every wreck position,
 *     first or last, clears the same shape;
 *   - ammo aboard does not affect it.  Ammo gates only the terminal
 *     explosion (see tools/measure-death-ammo.cjs); it has no bearing on
 *     the trees.
 *
 * What remains, and all this script measures, is the SIZE.  Each rule
 * below clears a different shape at every dying position, and the corpus
 * scores them against each other.
 *
 *   centre        just the square under the tank's centre — the baseline
 *                 a naive viewer implements, certainly too small
 *   radius_6      open pixel circle, dx^2 + dy^2 < 36
 *   radius_7      open pixel circle, dx^2 + dy^2 < 49
 *   radius_8      open pixel circle, dx^2 + dy^2 < 64
 *   radius_8_pm   radius_8, but forest under a grounded pillbox is spared
 *   box_7         Chebyshev box, dx <= 7 && dy <= 7 — a strict superset
 *                 of radius_8, adding only the corners
 *   box_7_pm      box_7 with the pillbox exemption — the shipped rule
 *   box_8         one pixel wider; a control
 *   radius_8_closed   dx^2 + dy^2 <= 64, one ring wider; a control
 *   footprint     every square the 16px character overlaps; a control
 *
 * The two controls are expected to LOSE.  They are here so that a corpus
 * which fails to convict them would prove the detectors blind rather than
 * the rules right.
 *
 * FALSIFIERS.  A rule can be wrong in two opposite directions, and each
 * has its own detector:
 *
 * 1. OVER-CLEARING — it felled a tree that demonstrably still stood:
 *      - a later explicit tree-fell (`6T` to grass, or a `7T` explosion
 *        resolving to grass/mined grass) with no regrowth in between.
 *        Sub-second cases are event-ordering noise; the real signal is
 *        the delayed ones;
 *      - a later LIVE tank reporting the hidden-in-trees bit with its
 *        centre on a square the rule had already cleared.
 *
 * 2. UNDER-CLEARING — a phantom tree the rule failed to fell:
 *      - a pillbox PLANTED on a square the rule still believes is forest.
 *        Plants on forest are impossible, so this is categorical: a single
 *        occurrence convicts the rule.
 *
 * A rule that is too small accumulates plants; one that is too large
 * accumulates contradictions and hidden-tank hits.  The right size is the
 * one that holds both down at once.
 *
 * Shell falls (`FB`) onto forest are NOT counted either way: an
 * end-of-range shell lands harmlessly on a forest square without felling
 * the tree.
 *
 * REMOVED DETECTOR, and why.  Earlier rounds also counted shells seen in
 * a model-forest square, reasoning that forest stops shells.  That count
 * was junk: it read a shell's position as `x * 16 + px`, but a shell's
 * stored coordinate is a top-left like a tank's, and the game point is
 * half a tile further on (see FORMAT.md, `0d`-`3d`).  Centring the shell
 * collapses shells-inside-forest from 83,626 to 7,055 across the corpus,
 * a sharp minimum at exactly +8px, and what remains is consistent with
 * ordinary frames just before impact.  There is no phantom-tree
 * population; there was an off-by-half-a-tile.  Any future attempt at
 * this detector must centre the shell first.
 *
 * Usage:
 *   node tools/measure-tree-clearance.cjs [corpus-dir] [--samples]
 *
 * --samples prints example sites for each kind of evidence.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const SAMPLES = process.argv.includes("--samples");
const ROOT = args[0] || "C:/Users/Owner/__DOCS/Bolo Archives/Nemokrad's Bolo logs";

const MAP_SIZE = 256;
const DEEP_SEA = 255;
const FOREST = 5;
const GRASS = 7;
const MINED_FOREST = 13;
const MINED_GRASS = 15;
const SAMPLE_CAP = 25;

function is_forest(terrain) {
	return terrain === FOREST || terrain === MINED_FOREST;
}

function cleared_terrain(terrain) {
	return terrain === MINED_FOREST ? MINED_GRASS : GRASS;
}

function centre_square(sub) {
	return [(sub.x * 16 + sub.pixelX + 8) >> 4, (sub.y * 16 + sub.pixelY + 8) >> 4];
}

/* Squares whose nearest pixel lies within `limit` of the tank's centre
 * pixel, by squared integer distance — no square root, no floating point,
 * which is how Bolo itself would have to do it. */
function disc_squares(sub, limit, closed) {
	let cx = sub.x * 16 + sub.pixelX + 8;
	let cy = sub.y * 16 + sub.pixelY + 8;
	let reach = Math.ceil(Math.sqrt(limit));
	let squares = [];
	for (let y = (cy - reach) >> 4; y <= (cy + reach) >> 4; y++) {
		for (let x = (cx - reach) >> 4; x <= (cx + reach) >> 4; x++) {
			let dx = Math.max(x * 16 - cx, cx - (x * 16 + 15), 0);
			let dy = Math.max(y * 16 - cy, cy - (y * 16 + 15), 0);
			let d2 = dx * dx + dy * dy;
			if (closed ? d2 <= limit : d2 < limit)
				squares.push([x, y]);
		}
	}
	return squares;
}

/* Squares within a bounding box of the given half-width -- Chebyshev
 * rather than Euclidean.  Cheaper than the circle (no multiplies), which
 * is the sort of thing 1990s code does, and it reaches `half` on the axes
 * but half*sqrt(2) into the corners. */
function box_squares(sub, half) {
	let cx = sub.x * 16 + sub.pixelX + 8;
	let cy = sub.y * 16 + sub.pixelY + 8;
	let squares = [];
	for (let y = (cy - half) >> 4; y <= (cy + half) >> 4; y++) {
		for (let x = (cx - half) >> 4; x <= (cx + half) >> 4; x++) {
			let dx = Math.max(x * 16 - cx, cx - (x * 16 + 15), 0);
			let dy = Math.max(y * 16 - cy, cy - (y * 16 + 15), 0);
			if (dx <= half && dy <= half)
				squares.push([x, y]);
		}
	}
	return squares;
}

/* Every square the tank's 16x16 character overlaps (up to 4). */
function footprint_squares(sub) {
	let wx = sub.x * 16 + sub.pixelX;
	let wy = sub.y * 16 + sub.pixelY;
	let squares = [];
	for (let x of new Set([wx >> 4, (wx + 15) >> 4]))
		for (let y of new Set([wy >> 4, (wy + 15) >> 4]))
			squares.push([x, y]);
	return squares;
}

/* Each rule maps a dying tank position to the squares it fells.  There is
 * deliberately no "is this the first position" parameter: that question is
 * closed. */
const RULES = {
	centre: sub => [centre_square(sub)],
	radius_6: sub => disc_squares(sub, 36, false),
	radius_7: sub => disc_squares(sub, 49, false),
	radius_8: sub => disc_squares(sub, 64, false),
	radius_8_pm: sub => disc_squares(sub, 64, false),
	radius_8_closed: sub => disc_squares(sub, 64, true),
	box_7: sub => box_squares(sub, 7),
	box_7_pm: sub => box_squares(sub, 7),
	box_8: sub => box_squares(sub, 8),
	footprint: sub => footprint_squares(sub),
};

/* Only this rule spares forest beneath a grounded pillbox. */
const PILL_MASKED = new Set(["radius_8_pm", "box_7_pm"]);

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
		dying_sequences: 0,
		clearances: 0,
		regrowth: 0,
		contradictions: 0,
		contradictions_le_1s: 0,
		contradictions_gt_1s: 0,
		hidden_tank_evidence: 0,
		other_mutations: 0,
		plants_on_forest: 0,
		contradiction_samples: [],
		hidden_tank_samples: [],
		plant_samples: [],
	};
}

function add_sample(list, value) {
	if (list.length < SAMPLE_CAP)
		list.push(value);
}

function new_model(seed) {
	return {
		grid: BoloGame.initial_state(seed).grid,
		pending: new Map(),
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
				if (delay <= 50)
					model.stats.contradictions_le_1s++;
				else
					model.stats.contradictions_gt_1s++;
				add_sample(model.stats.contradiction_samples,
					`${evidence.file} ${format_time(evidence.time)} (${x},${y}) ` +
					`cleared @${format_time(pending.time)} via ${evidence.source}`);
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

function scan_file(file, totals) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	if (!is_log(bytes))
		return false;
	let records = [...BoloLog.records(bytes, {})];
	time_base = records.length ? records[0].time : 0;
	let seed = BoloGame.extract_initial_map(records);
	let models = Object.fromEntries(Object.keys(RULES).map(name => [name, new_model(seed)]));
	let relative_file = path.relative(ROOT, file) || path.basename(file);

	/* One engine state shared by every model, purely to decode the chained
	 * shell lists and locate grounded pills; terrain truth lives in the
	 * per-model grids. */
	let engine = BoloGame.initial_state(seed);
	let in_death_sequence = Array.from({length: 16}, () => false);

	for (let record of records) {
		for (let sub of record.subpackets) {
			if (sub.type === "tank_position") {
				if (sub.dying) {
					if (!in_death_sequence[record.player]) {
						in_death_sequence[record.player] = true;
						for (let model of Object.values(models))
							model.stats.dying_sequences++;
					}
					for (let [name, rule] of Object.entries(RULES)) {
						let model = models[name];
						for (let [x, y] of rule(sub)) {
							if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE)
								continue;
							if (PILL_MASKED.has(name) && engine.pills.some(pill =>
								pill.inTank === null && pill.x === x && pill.y === y))
								continue;
							let key = square_key(x, y);
							let terrain = model.grid[key];
							if (!is_forest(terrain))
								continue;
							model.grid[key] = cleared_terrain(terrain);
							model.stats.clearances++;
							if (!model.pending.has(key))
								model.pending.set(key, {time: record.time});
						}
					}
				} else {
					in_death_sequence[record.player] = false;
					if (sub.hidden) {
						let [x, y] = centre_square(sub);
						let key = square_key(x, y);
						for (let model of Object.values(models)) {
							let pending = model.pending.get(key);
							if (pending && !pending.hidden_reported && record.time > pending.time) {
								pending.hidden_reported = true;
								model.stats.hidden_tank_evidence++;
								add_sample(model.stats.hidden_tank_samples,
									`${relative_file} ${format_time(record.time)} (${x},${y}) ` +
									`hidden tank on square cleared @${format_time(pending.time)}`);
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
	}

	for (let [name, model] of Object.entries(models)) {
		for (let key of Object.keys(totals[name])) {
			if (key.endsWith("_samples")) {
				for (let sample of model.stats[key])
					add_sample(totals[name][key], sample);
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

console.log(`
================ forest clearance around a dying tank ================
logs: ${files}
root: ${ROOT}
dying sequences: ${totals.centre.dying_sequences}

Over-clearing is measured by contradictions (a tree provably still
standing) and hidden-tank hits.  Under-clearing is measured by pillbox
plants on model-forest, which is categorical: planting on forest is
impossible, so a single one convicts the rule.  The right size holds
both sides down at once.
`);

const COLUMNS = [
	["rule", 16],
	["cleared", 9],
	["contra>1s", 10],
	["contra<=1s", 11],
	["hidden", 7],
	["plants", 7],
];
console.log("  " + COLUMNS.map(([h, w]) => h.padStart(w)).join(""));
for (let [name, s] of Object.entries(totals)) {
	let row = [
		name,
		s.clearances,
		s.contradictions_gt_1s,
		s.contradictions_le_1s,
		s.hidden_tank_evidence,
		s.plants_on_forest,
	];
	console.log("  " + row.map((v, i) => String(v).padStart(COLUMNS[i][1])).join(""));
}

console.log(`
Reading the table: "centre" is far too small — it leaves 53 impossible
pill plants.  Widening drives that to zero by radius 8.  But box_7
dominates radius_8: every square the circle clears has dx, dy <= 7, so
the box is a strict superset, and it clears ~500 more squares with the
same delayed contradictions, the same hidden-tank hits and the same zero
plants.  box_8 fixes the size by over-clearing catastrophically.  So the
boundary is Chebyshev at 7.  box_7_pm is the shipped rule; sparing forest
under a grounded pillbox takes the delayed contradictions from 14 to
zero.  The corners are confirmed independently by tree regrowth — see
FORMAT.md [E:forest-circle].
`);

if (SAMPLES) {
	for (let [name, s] of Object.entries(totals)) {
		console.log(`--- ${name} ---`);
		for (let [label, list] of [
			["contradictions", s.contradiction_samples],
			["hidden-tank", s.hidden_tank_samples],
			["plants on forest", s.plant_samples],
		]) {
			if (!list.length)
				continue;
			console.log(`  ${label}:`);
			for (let sample of list)
				console.log(`    ${sample}`);
		}
	}
}
console.log("======================================================================");
