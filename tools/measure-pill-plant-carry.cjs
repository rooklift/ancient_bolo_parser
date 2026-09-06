#!/usr/bin/env node
/* Can a tank plant a pill it was never logged picking up?
 *
 * Carl Osterwald's notes describe a tank driving over a dead pill with no
 * `FF 0n` pickup in the log, then planting it, "but there is no way to
 * determine which one because it isn't carrying any pills". This tool
 * runs the viewer's own state model (`viewer/game.js`, including the
 * carried-at-start sentinels of the `F1 02` list, the death and quit
 * dumps, and the man-out-carrying exception) over every replay and
 * counts the `FF 50` plants by a player the model holds as carrying
 * nothing. For each it lists the dead grounded pills whose square the
 * planter's tank had visited since its carry state last changed, and
 * looks for later evidence -- a pickup on the planted square of a pill
 * the model holds elsewhere, or a pill list naming the square -- that a
 * pill really was planted there.
 *
 * The model itself is checked against every pickup on the way: the
 * picker's tank square against the model's square for that pill, and
 * pickups of a pill the model holds as carried, which is what a missed
 * pickup would leave behind.
 *
 * Usage:
 *   node tools/measure-pill-plant-carry.cjs [replay-or-directory]
 *       (no arguments: the whole corpus, via BOLO_CORPUS/corpus.json,
 *       falling back to the committed fixtures when neither is set)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_TARGET = path.join(ROOT, "fixtures");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const CARRY_EVENTS = new Set(["pill_pickup", "pill_plant",
	"pill_dumped_by_dead_lgm", "tank_death", "quit"]);

function collect_files(target) {
	let stat = fs.statSync(target);
	if (!stat.isDirectory()) return [target];
	let files = [];
	for (let entry of fs.readdirSync(target, { withFileTypes: true })) {
		let full = path.join(target, entry.name);
		if (entry.isDirectory()) files.push(...collect_files(full));
		else if (!SKIPPED_EXTENSIONS.test(entry.name)) files.push(full);
	}
	return files.sort();
}

function empty_tally() {
	return {
		plants: 0,
		pickups: 0,
		plants_nothing_carried: 0,
		plants_nothing_carried_with_visited_dead_pill: 0,
		plants_confirmed_by_later_pickup_on_square: 0,
		plants_confirmed_by_later_pill_list: 0,
		pickup_on_model_square: 0,
		pickup_adjacent_to_model_square: 0,
		pickup_far_from_model_square: 0,
		pickup_of_pill_model_holds_carried: 0,
		pickup_no_tank_position: 0,
		pickup_unknown_pill: 0,
	};
}

function measure_file(recs, BoloGame, tally, examples, label) {
	let node_joins = BoloGame.classify_node_joins(recs);
	let seed = BoloGame.extract_initial_map(recs, node_joins);
	let state = BoloGame.initial_state(seed);
	let visited = Array.from({ length: 16 }, () => new Set());
	let anomalies = [];
	for (let rec of recs) {
		if (rec.tankStatus === 0x0f) continue;
		let pl = rec.player;
		/* the square a tank occupies is the one holding its centre, +8 px
		 * from the logged top-left corner [E:centre-square] */
		let position = rec.subpackets.find(sub => sub.type === "tank_position");
		let tank = position ? {
			x: (position.x * 16 + position.pixelX + 8) >> 4,
			y: (position.y * 16 + position.pixelY + 8) >> 4,
		} : null;
		if (tank) visited[pl].add(tank.y * 256 + tank.x);
		for (let sub of rec.subpackets) {
			if (sub.type === "pill_pickup") {
				tally.pickups++;
				let pill = state.pills[sub.pillbox];
				if (!pill) tally.pickup_unknown_pill++;
				else if (pill.inTank !== null) tally.pickup_of_pill_model_holds_carried++;
				else if (!tank) tally.pickup_no_tank_position++;
				else {
					let d = Math.max(Math.abs(tank.x - pill.x), Math.abs(tank.y - pill.y));
					if (d === 0) tally.pickup_on_model_square++;
					else if (d === 1) tally.pickup_adjacent_to_model_square++;
					else tally.pickup_far_from_model_square++;
				}
				for (let anomaly of anomalies) {
					if (anomaly.confirmed || !tank || !pill || pill.inTank !== null) continue;
					if (tank.x === anomaly.x && tank.y === anomaly.y &&
						(pill.x !== anomaly.x || pill.y !== anomaly.y)) {
						anomaly.confirmed = true;
						tally.plants_confirmed_by_later_pickup_on_square++;
					}
				}
			} else if (sub.type === "pillbox_list") {
				for (let anomaly of anomalies) {
					if (anomaly.listed) continue;
					if (sub.items.some(item => item.x === anomaly.x && item.y === anomaly.y)) {
						anomaly.listed = true;
						tally.plants_confirmed_by_later_pill_list++;
					}
				}
			} else if (sub.type === "pill_plant") {
				tally.plants++;
				if (state.pills.some(pill => pill.inTank === pl)) continue;
				tally.plants_nothing_carried++;
				let candidates = [];
				state.pills.forEach((pill, n) => {
					if (pill.inTank === null && pill.armour === 0 &&
						visited[pl].has(pill.y * 256 + pill.x)) {
						candidates.push(`${n}@${pill.x},${pill.y}`);
					}
				});
				if (candidates.length) tally.plants_nothing_carried_with_visited_dead_pill++;
				anomalies.push({ x: sub.x, y: sub.y });
				if (examples.length < 40) {
					examples.push(`plant_example\t${label} t=${rec.time} pl=${pl} ` +
						`square=${sub.x},${sub.y} visited_dead_pills=[${candidates}]`);
				}
			}
		}
		if (rec.subpackets.some(sub => CARRY_EVENTS.has(sub.type))) {
			visited[pl] = new Set();
		}
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
	}
}

function repo_commit() {
	const { execSync } = require("node:child_process");
	const run = (command) => execSync(command,
		{ cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	try {
		let hash = run("git rev-parse --short HEAD");
		return run("git status --porcelain -uno") ? `${hash}-dirty` : hash;
	} catch {
		return "unknown";
	}
}

function main() {
	const BoloLog = require(path.join(ROOT, "viewer", "logparse.js"));
	const BoloGame = require(path.join(ROOT, "viewer", "game.js"));
	const corpus = require(path.join(ROOT, "tools", "corpus.cjs"));
	let target;
	if (process.argv[2]) {
		target = path.resolve(process.argv[2]);
	} else {
		let root = null;
		try {
			root = corpus.resolve_corpus_root();
		} catch (error) {
			root = null;
		}
		target = root && fs.existsSync(root) ? root : DEFAULT_TARGET;
	}
	let files = collect_files(target);
	let tally = empty_tally();
	let examples = [];
	let failed = 0;
	for (let file of files) {
		let recs;
		try {
			recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
		} catch (error) {
			failed++;
			continue;
		}
		measure_file(recs, BoloGame, tally, examples, corpus.replay_label(file));
	}
	let lines = [
		"# GENERATED - pill plants against the carry model; nothing written to disk.",
		`commit\t${repo_commit()}`,
		`files\t${files.length}`,
		`files_failed\t${failed}`,
	];
	for (let [key, value] of Object.entries(tally)) lines.push(`${key}\t${value}`);
	lines.push(...examples);
	console.log(lines.join("\n"));
}

main();
