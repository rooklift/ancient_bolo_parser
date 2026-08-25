#!/usr/bin/env node
/* Validate the eventless forest clearing caused by a sliding tank wreck.
 *
 * For each candidate footprint rule, remember every forest square inferred
 * to have been cleared by a dying tank position.  The next explicit terrain
 * event on that square is evidence:
 *
 * - forest/mined forest: the tree naturally grew back, so later clearing is
 *   not a contradiction;
 * - grass/mined grass: the log tried to clear/farm a tree that our rule had
 *   already removed, which contradicts the candidate rule;
 * - anything else: a legitimate later mutation, such as road construction
 *   or an explosion crater.
 *
 * Same-record mutations are reported separately because they can be part of
 * the tank's original destruction rather than an independent later event.
 *
 * Usage:
 *   node tools/validate-wreck-forest.cjs [corpus-dir]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const ROOT = process.argv[2] || "C:/Users/Owner/__DOCS/Bolo Archives/Nemokrad's Bolo logs";
const MAP_SIZE = 256;
const DEEP_SEA = 255;
const FOREST = 5;
const GRASS = 7;
const MINED_FOREST = 13;
const MINED_GRASS = 15;
const SAMPLE_CAP = 20;

const RULES = {
	overlap: sub => {
		let wx = sub.x * 16 + sub.pixelX;
		let wy = sub.y * 16 + sub.pixelY;
		let squares = [];
		for (let x of new Set([wx >> 4, (wx + 15) >> 4])) {
			for (let y of new Set([wy >> 4, (wy + 15) >> 4]))
				squares.push([x, y]);
		}
		return squares;
	},
	centre: sub => [[
		(sub.x * 16 + sub.pixelX + 8) >> 4,
		(sub.y * 16 + sub.pixelY + 8) >> 4,
	]],
	anchor: sub => [[sub.x, sub.y]],
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

function is_forest(terrain) {
	return terrain === FOREST || terrain === MINED_FOREST;
}

function cleared_terrain(terrain) {
	return terrain === MINED_FOREST ? MINED_GRASS : GRASS;
}

function square_key(x, y) {
	return y * MAP_SIZE + x;
}

function format_time(ticks) {
	let hundredths = Math.round(ticks * 2);
	let minutes = Math.floor(hundredths / 6000);
	let seconds = Math.floor(hundredths / 100) % 60;
	let fraction = hundredths % 100;
	return `${minutes}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function new_stats() {
	return {
		clearances: 0,
		mined_forest_clearances: 0,
		unique_squares: 0,
		regrowth: 0,
		contradictions: 0,
		contradictions_terrain_change: 0,
		contradictions_explosion: 0,
		contradictions_delay_le_1s: 0,
		contradictions_delay_1_to_5s: 0,
		contradictions_delay_5_to_60s: 0,
		contradictions_delay_gt_60s: 0,
		hidden_tank_evidence: 0,
		coincident_grass: 0,
		other_mutations: 0,
		unresolved: 0,
		contradiction_samples: [],
		hidden_tank_samples: [],
		regrowth_samples: [],
	};
}

function add_sample(list, value) {
	if (list.length < SAMPLE_CAP)
		list.push(value);
}

function new_model(seed) {
	return {
		grid: BoloGame.initial_state(seed).grid,
		tanks: Array.from({length: 16}, () => null),
		pending: new Map(),
		seen_squares: new Set(),
		stats: new_stats(),
	};
}

function set_terrain(model, x, y, terrain, evidence) {
	if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE)
		return;
	let key = square_key(x, y);
	let before = model.grid[key];
	let pending = model.pending.get(key);
	if (pending && evidence) {
		let sample = `${evidence.file} ${format_time(evidence.time)} (${x},${y}) ` +
			`wreck@${format_time(pending.time)} ${before}->${terrain} via ${evidence.source}`;
		if (is_forest(terrain)) {
			model.stats.regrowth++;
			add_sample(model.stats.regrowth_samples, sample);
		} else if (terrain === cleared_terrain(pending.original_terrain)) {
			if (evidence.time === pending.time) {
				model.stats.coincident_grass++;
			} else {
				model.stats.contradictions++;
				if (evidence.source.startsWith("6"))
					model.stats.contradictions_terrain_change++;
				else
					model.stats.contradictions_explosion++;
				let delay = evidence.time - pending.time;
				if (delay <= 50)
					model.stats.contradictions_delay_le_1s++;
				else if (delay <= 250)
					model.stats.contradictions_delay_1_to_5s++;
				else if (delay <= 3000)
					model.stats.contradictions_delay_5_to_60s++;
				else
					model.stats.contradictions_delay_gt_60s++;
				add_sample(model.stats.contradiction_samples, sample);
			}
		} else {
			model.stats.other_mutations++;
		}
		model.pending.delete(key);
	}
	model.grid[key] = terrain;
}

function mine_square(model, x, y, evidence) {
	let terrain = model.grid[square_key(x, y)];
	if (terrain >= 2 && terrain <= 7)
		set_terrain(model, x, y, terrain + 8, evidence);
}

function has_base(seed, x, y) {
	return seed.bases.some(base => base.x === x && base.y === y);
}

function apply_explicit_event(model, seed, sub, evidence) {
	if (sub.type === "terrain_change") {
		set_terrain(model, sub.x, sub.y, sub.terrain, evidence);
		return;
	}
	if (sub.code === 0x0b)
		return;
	if (sub.code === 0x0c) {
		mine_square(model, sub.x, sub.y, evidence);
		return;
	}
	if (sub.code === 0x0d) {
		for (let [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
			let x = sub.x + dx;
			let y = sub.y + dy;
			if (x >= MAP_SIZE || y >= MAP_SIZE)
				continue;
			let terrain = model.grid[square_key(x, y)];
			if (terrain !== DEEP_SEA && terrain !== 1 && terrain !== 9 && !has_base(seed, x, y))
				set_terrain(model, x, y, 3, evidence);
		}
		return;
	}
	set_terrain(model, sub.x, sub.y, sub.code, evidence);
}

function apply_record(models, seed, record, relative_file) {
	for (let sub of record.subpackets) {
		if (sub.type === "tank_position") {
			if (sub.hidden && !sub.dying) {
				let x = (sub.x * 16 + sub.pixelX + 8) >> 4;
				let y = (sub.y * 16 + sub.pixelY + 8) >> 4;
				let key = square_key(x, y);
				for (let model of Object.values(models)) {
					let pending = model.pending.get(key);
					if (pending && !pending.hidden_reported && record.time > pending.time) {
						model.stats.hidden_tank_evidence++;
						pending.hidden_reported = true;
						add_sample(model.stats.hidden_tank_samples,
							`${relative_file} ${format_time(record.time)} (${x},${y}) ` +
							`hidden tank after wreck@${format_time(pending.time)}`);
					}
				}
			}
			for (let model of Object.values(models))
				model.tanks[record.player] = sub;
			if (sub.dying) {
				for (let [rule_name, rule] of Object.entries(RULES)) {
					let model = models[rule_name];
					for (let [x, y] of rule(sub)) {
						if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE)
							continue;
						let key = square_key(x, y);
						let terrain = model.grid[key];
						if (!is_forest(terrain))
							continue;
						model.grid[key] = cleared_terrain(terrain);
						model.stats.clearances++;
						if (terrain === MINED_FOREST)
							model.stats.mined_forest_clearances++;
						model.seen_squares.add(key);
						if (!model.pending.has(key)) {
							model.pending.set(key, {
								time: record.time,
								original_terrain: terrain,
							});
						}
					}
				}
			}
			continue;
		}

		for (let model of Object.values(models)) {
			if (sub.type === "terrain_change" || sub.type === "explosion") {
				let evidence = {
					file: relative_file,
					time: record.time,
					source: sub.type === "terrain_change" ? `6${sub.terrain.toString(16).toUpperCase()}` :
						`7${sub.code.toString(16).toUpperCase()}`,
				};
				apply_explicit_event(model, seed, sub, evidence);
			} else if (sub.type === "lay_mine") {
				let tank = model.tanks[record.player];
				if (tank) {
					let x = (tank.x * 16 + tank.pixelX + 8) >> 4;
					let y = (tank.y * 16 + tank.pixelY + 8) >> 4;
					mine_square(model, x, y, null);
				}
			} else if (sub.type === "board_boat") {
				let tank = model.tanks[record.player];
				if (tank) {
					let x = (tank.x * 16 + tank.pixelX + 8) >> 4;
					let y = (tank.y * 16 + tank.pixelY + 8) >> 4;
					if (model.grid[square_key(x, y)] === 9)
						set_terrain(model, x, y, 1, null);
				}
			}
		}
	}
}

function scan_file(file, totals) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	if (!is_log(bytes))
		return false;
	let records = [...BoloLog.records(bytes, {})];
	let seed = BoloGame.extract_initial_map(records);
	let models = Object.fromEntries(Object.keys(RULES).map(name => [name, new_model(seed)]));
	let relative_file = path.relative(ROOT, file);
	for (let record of records)
		apply_record(models, seed, record, relative_file);
	for (let [name, model] of Object.entries(models)) {
		model.stats.unique_squares = model.seen_squares.size;
		model.stats.unresolved = model.pending.size;
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

console.log(`Wreck/forest consistency scan: ${files} log files`);
console.log(`Root: ${ROOT}`);
for (let [name, stats] of Object.entries(totals)) {
	console.log(`\n${name}:`);
	console.log(`  inferred forest clearances: ${stats.clearances}`);
	console.log(`    mined forest: ${stats.mined_forest_clearances}`);
	console.log(`  unique cleared squares (summed per file): ${stats.unique_squares}`);
	console.log(`  next event was forest regrowth: ${stats.regrowth}`);
	console.log(`  later grass clear without regrowth (contradictions): ${stats.contradictions}`);
	console.log(`    terrain changes / explosions: ${stats.contradictions_terrain_change} / ${stats.contradictions_explosion}`);
	console.log(`    delay <=1s / 1-5s / 5-60s / >60s: ` +
		`${stats.contradictions_delay_le_1s} / ${stats.contradictions_delay_1_to_5s} / ` +
		`${stats.contradictions_delay_5_to_60s} / ${stats.contradictions_delay_gt_60s}`);
	console.log(`  later live tank hidden on an inferred-cleared square: ${stats.hidden_tank_evidence}`);
	console.log(`  same-record grass clear (coincident): ${stats.coincident_grass}`);
	console.log(`  next event was another legitimate mutation: ${stats.other_mutations}`);
	console.log(`  no later explicit mutation: ${stats.unresolved}`);
	if (stats.contradiction_samples.length) {
		console.log("  contradiction samples:");
		for (let sample of stats.contradiction_samples)
			console.log(`    ${sample}`);
	}
	if (stats.hidden_tank_samples.length) {
		console.log("  hidden-tank samples:");
		for (let sample of stats.hidden_tank_samples)
			console.log(`    ${sample}`);
	}
}
