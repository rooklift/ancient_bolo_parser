#!/usr/bin/env node
/* Attempt to FALSIFY hypotheses about the eventless forest clearing at a
 * tank's death.
 *
 * Round 1 (unconditional footprint) was falsified by the 446-log corpus:
 * clearing the forest under every square the tank's 16px character overlaps
 * at the FIRST dying-bit position fixed the known phantom-tree squares, but
 * accumulated 89 contradictions (41 with >60s delay) and 10 hidden-tank
 * hits on death-footprint squares — some death footprints demonstrably do
 * NOT clear.  One death (dec\012302 @5:28.92) left standing trees on two
 * different footprint squares.
 *
 * Round 2 tests the refinement suggested by the terminal-explosion tiers
 * (FORMAT.md, F9): ~64% of deaths end in an evented single crater (73),
 * ~7% in an evented superboom (7D) — the ammo aboard cooking off — and
 * ~29% in NO terminal explosion at all (the tank died near-empty).
 *
 *   HYPOTHESIS: only a death WITH a terminal explosion clears the forest
 *   under its death-moment footprint; an explosion-less death burns only
 *   the centre square of each dying position (the sliding wreck), as the
 *   engine already models for every death.
 *
 * A pre-pass classifies every death by tier (a 73/7D from the dying player
 * near the wreck, from ~1s before the death record to the end of the dying
 * sequence).  Then four models run side by side:
 *
 *   centre      the shipped rule (centre square of every dying position);
 *   candidate   centre + death-moment footprint on EVERY death (round 1,
 *               kept so its failures can be bucketed by tier and by
 *               footprint-overlap width);
 *   candidate2  centre + death-moment footprint on explosion-tier deaths
 *               only — the round-2 hypothesis;
 *   control     footprint at EVERY dying position — known-bad; a positive
 *               control: if the corpus does not convict it, the detectors
 *               are broken and nothing else can be trusted.
 *
 * Falsifiers:
 *
 * 1. OVER-CLEARING — the model cleared a tree that was really still
 *    standing:
 *      - a later explicit tree-fell (6T terrain change or 7T explosion to
 *        grass/mined grass) with no regrowth in between; delays over 1s
 *        are the real signal (sub-second cases are event-ordering noise);
 *      - a later LIVE tank reporting the hidden-in-trees bit with its
 *        centre on the cleared square.
 *    Round 2 is FALSIFIED if candidate2 still attributes these to
 *    death-footprint squares beyond the baseline's noise floor.  The
 *    candidate model's per-tier tables are the diagnosis: the hypothesis
 *    predicts its contradictions and hidden hits concentrate in tier
 *    "none", its phantom-square fixes in tiers "crater"/"superboom".  If
 *    they instead concentrate in the sliver overlap bucket whatever the
 *    tier, the truth is a blast RADIUS smaller than the full footprint,
 *    not an ammo gate.
 *
 * 2. UNDER-CLEARING — phantom trees the model still fails to clear:
 *      - a pill PLANTED on a square the model believes is forest (plants
 *        on forest are impossible);
 *      - shells restated in flight THROUGH a model-forest square (forest
 *        blocks shells; squares crossed >=3 times are near-certain phantom
 *        trees, 1-2 crossings can be offset-decode noise).
 *    Round 2 is WRONG-OR-INCOMPLETE if candidate2 gives back most of the
 *    candidate's coverage gains over the baseline.
 *
 * Note the corpus also shows a large population of phantom-tree squares
 * (~650+) that survive even the control's aggressive clearing — those come
 * from some OTHER eventless mechanism entirely and are outside every
 * hypothesis here; treat the models' RELATIVE numbers as the signal.
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
/* Terminal-explosion association: a 73/7D from the dying player within
 * this Chebyshev distance of the death footprint counts as that death's
 * terminal explosion.  Wrecks slide a few squares; craters land at the
 * rest square.  A mine-death's crater can precede the F9 by a beat, hence
 * the small look-back. */
const TIER_DISTANCE = 6;
const TIER_LOOKBACK_TICKS = 60;

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

/* Footprint squares with the per-axis pixel overlap between the 16px
 * character and each square, for the blast-radius alternative. */
function footprint_squares(sub) {
	let wx = sub.x * 16 + sub.pixelX;
	let wy = sub.y * 16 + sub.pixelY;
	let squares = [];
	for (let x of new Set([wx >> 4, (wx + 15) >> 4])) {
		for (let y of new Set([wy >> 4, (wy + 15) >> 4])) {
			let ox = Math.min(wx + 15, x * 16 + 15) - Math.max(wx, x * 16) + 1;
			let oy = Math.min(wy + 15, y * 16 + 15) - Math.max(wy, y * 16) + 1;
			squares.push([x, y, Math.min(ox, oy)]);
		}
	}
	return squares;
}

function overlap_bucket(overlap) {
	return overlap === undefined ? "n/a" :
		overlap <= 4 ? "sliver<=4px" :
		overlap <= 8 ? "mid5-8px" : "wide9-16px";
}

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
		clearances_by_tier: {},
		clearances_by_overlap: {},
		regrowth: 0,
		contradictions: 0,
		contradictions_by_origin: {},
		contradictions_by_tier: {},
		contradictions_by_overlap: {},
		contradictions_delay_le_1s: 0,
		contradictions_delay_1_to_5s: 0,
		contradictions_delay_5_to_60s: 0,
		contradictions_delay_gt_60s: 0,
		hidden_tank_evidence: 0,
		hidden_by_origin: {},
		hidden_by_tier: {},
		other_mutations: 0,
		plants_on_forest: 0,
		crossings: 0,
		phantom_squares: 0, /* squares crossed >= CROSSING_PHANTOM_THRESHOLD times */
		phantom_at_death_fp_by_tier: {}, /* phantom squares lying in some earlier death footprint */
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

/* ------------------------------------------------------------------ */
/* Pass 1: find every death (first dying position of a dying sequence)
 * and classify its terminal-explosion tier from the evented 73/7D. */

function find_deaths(records) {
	let deaths = [];
	let death_by_key = new Map(); /* `${recordIndex}:${player}` -> death */
	let active = Array.from({length: 16}, () => null);
	let in_sequence = Array.from({length: 16}, () => false);
	let recent_booms = []; /* {time, player, x, y, code} */

	const near_footprint = (death, x, y) =>
		death.fp.some(([fx, fy]) => Math.max(Math.abs(fx - x), Math.abs(fy - y)) <= TIER_DISTANCE);

	for (let i = 0; i < records.length; i++) {
		let record = records[i];
		for (let sub of record.subpackets) {
			if (sub.type === "tank_position") {
				if (sub.dying) {
					if (!in_sequence[record.player]) {
						let death = {
							time: record.time,
							player: record.player,
							fp: footprint_squares(sub),
							tier: "none",
							code: 0,
						};
						/* a mine-death's crater can be evented just before the F9 */
						for (let boom of recent_booms) {
							if (boom.player === record.player &&
									record.time - boom.time <= TIER_LOOKBACK_TICKS &&
									near_footprint(death, boom.x, boom.y))
								death.tier = boom.code === 0x0d ? "superboom" : "crater";
						}
						deaths.push(death);
						death_by_key.set(`${i}:${record.player}`, death);
						active[record.player] = death;
						in_sequence[record.player] = true;
					}
				} else {
					in_sequence[record.player] = false;
					active[record.player] = null;
				}
			} else if (sub.type === "tank_death") {
				if (active[record.player] && !active[record.player].code)
					active[record.player].code = sub.code;
			} else if (sub.type === "explosion" && (sub.code === 3 || sub.code === 0x0d)) {
				recent_booms.push({time: record.time, player: record.player, x: sub.x, y: sub.y, code: sub.code});
				if (recent_booms.length > 64)
					recent_booms.shift();
				let death = active[record.player];
				if (death && near_footprint(death, sub.x, sub.y)) {
					if (sub.code === 0x0d)
						death.tier = "superboom";
					else if (death.tier === "none")
						death.tier = "crater";
				}
			}
		}
	}
	return {deaths, death_by_key};
}

/* ------------------------------------------------------------------ */
/* Pass 2: the four terrain models. */

/* rule(sub, death-or-null) -> [origin, squares] lists; death is non-null
 * only at the death moment (the sequence's first dying position). */
const RULES = {
	centre: (sub, death) =>
		[["slide-centre", centre_squares(sub)]],
	candidate: (sub, death) => death ?
		[["death-footprint", death.fp]] :
		[["slide-centre", centre_squares(sub)]],
	candidate2: (sub, death) => death ?
		(death.tier === "none" ?
			[["slide-centre", centre_squares(sub)]] :
			[["death-footprint", death.fp]]) :
		[["slide-centre", centre_squares(sub)]],
	control: (sub, death) =>
		[["footprint-every", footprint_squares(sub)]],
};

function new_model(seed) {
	return {
		grid: BoloGame.initial_state(seed).grid,
		pending: new Map(), /* key -> {time, origin, tier, overlap, hidden_reported} */
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
				if (pending.origin === "death-footprint") {
					bump(model.stats.contradictions_by_tier, pending.tier);
					bump(model.stats.contradictions_by_overlap, overlap_bucket(pending.overlap));
				}
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
					`${pending.origin}[${pending.tier || "-"},${overlap_bucket(pending.overlap)}]` +
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
					/* if the square lies in some earlier death's footprint,
					 * bucket it by that death's tier: the round-2 hypothesis
					 * predicts crater/superboom here (they are the deaths
					 * that DO clear, which "centre" misses) */
					let source = death_fp_index.get(square_key(sx, sy));
					if (source && source.time <= time)
						bump(model.stats.phantom_at_death_fp_by_tier, source.tier);
					add_sample(model.stats.phantom_samples,
						`${file} ~${format_time(time)} (${key}) crossed x${CROSSING_PHANTOM_THRESHOLD}+` +
						(source && source.time <= time ? ` in death-fp[${source.tier}]@${format_time(source.time)}` : ""));
				}
				break;
			}
		}
	}
}

function scan_file(file, totals, death_totals) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	if (!is_log(bytes))
		return false;
	let records = [...BoloLog.records(bytes, {})];
	time_base = records.length ? records[0].time : 0;
	let seed = BoloGame.extract_initial_map(records);
	let models = Object.fromEntries(Object.keys(RULES).map(name => [name, new_model(seed)]));
	let relative_file = path.relative(ROOT, file) || path.basename(file);

	let {deaths, death_by_key} = find_deaths(records);
	death_totals.deaths += deaths.length;
	for (let death of deaths) {
		bump(death_totals.by_tier, death.tier);
		bump(death_totals.by_code, death.code);
	}
	/* last death whose footprint covered each square, for phantom bucketing */
	let death_fp_index = new Map();
	for (let death of deaths) {
		for (let [x, y] of death.fp)
			death_fp_index.set(square_key(x, y), death);
	}

	/* One engine state, shared by all models, purely to decode the chained
	 * shell lists; terrain truth lives in the per-model grids above. */
	let engine = BoloGame.initial_state(seed);
	let previous_shells = Array.from({length: 16}, () => []);
	let in_death_sequence = Array.from({length: 16}, () => false);

	for (let i = 0; i < records.length; i++) {
		let record = records[i];
		for (let sub of record.subpackets) {
			if (sub.type === "tank_position") {
				if (sub.dying) {
					let death = death_by_key.get(`${i}:${record.player}`) || null;
					in_death_sequence[record.player] = true;
					for (let [name, rule] of Object.entries(RULES)) {
						let model = models[name];
						for (let [origin, squares] of rule(sub, death)) {
							for (let [x, y, overlap] of squares) {
								if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE)
									continue;
								let key = square_key(x, y);
								let terrain = model.grid[key];
								if (!is_forest(terrain))
									continue;
								model.grid[key] = cleared_terrain(terrain);
								model.stats.clearances++;
								bump(model.stats.clearances_by_origin, origin);
								if (origin === "death-footprint") {
									bump(model.stats.clearances_by_tier, death.tier);
									bump(model.stats.clearances_by_overlap, overlap_bucket(overlap));
								}
								if (!model.pending.has(key)) {
									model.pending.set(key, {
										time: record.time,
										origin,
										tier: origin === "death-footprint" ? death.tier : null,
										overlap,
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
								if (pending.origin === "death-footprint")
									bump(model.stats.hidden_by_tier, pending.tier);
								add_sample(model.stats.hidden_tank_samples,
									`${relative_file} ${format_time(record.time)} (${x},${y}) hidden tank on ` +
									`${pending.origin}[${pending.tier || "-"},${overlap_bucket(pending.overlap)}]@${format_time(pending.time)}`);
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
			} else if (key.startsWith("clearances_by_") || key.startsWith("contradictions_by_") ||
					key.startsWith("hidden_by_") || key.startsWith("phantom_at_")) {
				for (let [k, n] of Object.entries(model.stats[key]))
					totals[name][key][k] = (totals[name][key][k] || 0) + n;
			} else {
				totals[name][key] += model.stats[key];
			}
		}
	}
	return true;
}

let totals = Object.fromEntries(Object.keys(RULES).map(name => [name, new_stats()]));
let death_totals = {deaths: 0, by_tier: {}, by_code: {}};
let files = 0;
for (let file of walk(ROOT)) {
	try {
		if (scan_file(file, totals, death_totals))
			files++;
	} catch (error) {
		console.error(`${path.relative(ROOT, file)}: ${error.message}`);
	}
}

console.log(`Death forest-clearing falsification scan (round 2): ${files} log files`);
console.log(`Root: ${ROOT}${FAST ? "  (--fast: shell crossings skipped)" : ""}`);
console.log(`deaths: ${death_totals.deaths}  by terminal tier: ${JSON.stringify(death_totals.by_tier)}` +
	`  by F9 code: ${JSON.stringify(death_totals.by_code)}`);
for (let [name, stats] of Object.entries(totals)) {
	console.log(`\n${name}:`);
	console.log(`  forest clearances: ${stats.clearances}  ${JSON.stringify(stats.clearances_by_origin)}`);
	if (Object.keys(stats.clearances_by_tier).length) {
		console.log(`    death-footprint clearances by tier: ${JSON.stringify(stats.clearances_by_tier)}`);
		console.log(`    death-footprint clearances by overlap: ${JSON.stringify(stats.clearances_by_overlap)}`);
	}
	console.log(`  regrowth on cleared squares: ${stats.regrowth}`);
	console.log(`  OVER-CLEARING`);
	console.log(`    later tree-fell without regrowth (contradictions): ${stats.contradictions}  ${JSON.stringify(stats.contradictions_by_origin)}`);
	if (Object.keys(stats.contradictions_by_tier).length) {
		console.log(`      death-footprint contradictions by tier: ${JSON.stringify(stats.contradictions_by_tier)}`);
		console.log(`      death-footprint contradictions by overlap: ${JSON.stringify(stats.contradictions_by_overlap)}`);
	}
	console.log(`      delay <=1s / 1-5s / 5-60s / >60s: ` +
		`${stats.contradictions_delay_le_1s} / ${stats.contradictions_delay_1_to_5s} / ` +
		`${stats.contradictions_delay_5_to_60s} / ${stats.contradictions_delay_gt_60s}`);
	console.log(`    live hidden tank on a cleared square: ${stats.hidden_tank_evidence}  ${JSON.stringify(stats.hidden_by_origin)}`);
	if (Object.keys(stats.hidden_by_tier).length)
		console.log(`      death-footprint hidden hits by tier: ${JSON.stringify(stats.hidden_by_tier)}`);
	console.log(`  UNDER-CLEARING`);
	console.log(`    pill plants on model-forest: ${stats.plants_on_forest}`);
	if (!FAST) {
		console.log(`    shell flights through model-forest: ${stats.crossings}` +
			`  (squares crossed >=${CROSSING_PHANTOM_THRESHOLD}x: ${stats.phantom_squares})`);
		console.log(`    phantom squares lying in an earlier death footprint, by tier: ` +
			JSON.stringify(stats.phantom_at_death_fp_by_tier));
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
  - "control" must be convicted (contradictions and hidden-tank hits well
    above "centre"); otherwise the detectors are broken - trust nothing.
  - Round-2 hypothesis SURVIVES if: "candidate"'s death-footprint
    contradictions and hidden hits concentrate in tier "none", its
    remaining phantom-in-death-footprint squares in "crater"/"superboom";
    AND "candidate2"'s over-clearing stays at "centre"'s noise floor while
    keeping most of "candidate"'s coverage gains (plants, phantom squares).
  - Round-2 is FALSIFIED if "candidate2" still over-clears (death-footprint
    contradictions with delays >1s, or any hidden-tank hits).
  - If "candidate"'s contradictions instead concentrate in the sliver<=4px
    overlap bucket regardless of tier, the mechanism is a blast radius
    smaller than the footprint, not an ammo-gated explosion.
  - Phantom squares outside any death footprint are a separate, unexplained
    mechanism - compare models relatively, not against zero.`);
