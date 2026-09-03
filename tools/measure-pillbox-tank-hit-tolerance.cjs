#!/usr/bin/env node
/* Compare the current pillbox tank-hit tolerance with the same matcher at 0px.
 *
 * Usage:
 *   node tools/measure-pillbox-tank-hit-tolerance.cjs [replay-or-directory]
 *       [--workers=4]
 */
"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { replay_label } = require("./corpus.cjs");
const { Worker, isMainThread, parentPort, workerData } =
	require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const DEFAULT_REPLAY = path.join(ROOT, "fixtures", "n20021018.2");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const TOLERANCE_DECLARATION =
	"const SHELL_TANK_HIT_TOLERANCE_PIXELS = 2;";

function empty_metrics() {
	return {
		files: 0,
		affected_files: 0,
		tank_hit_terminals: 0,
		zero_matched: 0,
		tolerant_matched: 0,
		preserved_same_time: 0,
		newly_matched: 0,
		newly_matched_orbit: 0,
		lost: 0,
		lost_orbit: 0,
		retimed_earlier: 0,
		retimed_later: 0,
		changed_shell_endpoint: 0,
		new_match_misses: [],
		retiming_ticks: [],
		examples: [],
	};
}

function merge_metrics(target, source) {
	for (let key of Object.keys(target)) {
		if (Array.isArray(target[key])) target[key].push(...source[key]);
		else target[key] += source[key];
	}
}

function* walk(item) {
	let stat;
	try {
		stat = fs.statSync(item);
	} catch {
		return;
	}
	if (stat.isFile()) {
		if (!SKIPPED_EXTENSIONS.test(item)) yield item;
		return;
	}
	if (!stat.isDirectory()) return;
	for (let entry of fs.readdirSync(item, { withFileTypes: true })) {
		yield* walk(path.join(item, entry.name));
	}
}

function compile_module(filename, source) {
	let loaded = new Module(filename, module);
	loaded.filename = filename;
	loaded.paths = Module._nodeModulePaths(path.dirname(filename));
	loaded._compile(source, filename);
	return loaded.exports;
}

function load_engines() {
	let log = require(path.join(ROOT, "viewer", "logparse.js"));
	let game_path = require.resolve(path.join(ROOT, "viewer", "game.js"));
	let motion_path = require.resolve(path.join(ROOT, "viewer", "motion.js"));
	delete require.cache[game_path];
	let tolerant_game = require(game_path);

	let tolerant_source = fs.readFileSync(motion_path, "utf8");
	if (!tolerant_source.includes(TOLERANCE_DECLARATION)) {
		throw new Error("current motion.js has an unexpected tolerance declaration");
	}
	let zero_source = tolerant_source.replace(TOLERANCE_DECLARATION,
		"const SHELL_TANK_HIT_TOLERANCE_PIXELS = 0;");
	let zero_motion = compile_module(motion_path, zero_source);
	let saved_motion = require.cache[motion_path];
	let injected = new Module(motion_path, module);
	injected.filename = motion_path;
	injected.exports = zero_motion;
	require.cache[motion_path] = injected;
	delete require.cache[game_path];
	let zero_game = require(game_path);
	if (saved_motion) require.cache[motion_path] = saved_motion;
	else delete require.cache[motion_path];
	delete require.cache[game_path];

	return { log, tolerant_game, zero_game };
}

function matched_shell(snapshots, snapshot_index, terminal) {
	if (terminal.match_time === undefined || snapshot_index === 0) return null;
	let candidates = snapshots[snapshot_index - 1].shells.filter(shell =>
		shell.next_terminal_event_type === "tank_hit" &&
		shell.direction === terminal.direction &&
		shell.next_time === terminal.match_time);
	let orbit_candidate = candidates.find(shell => shell.pillbox_orbit_states);
	return orbit_candidate || candidates[0] || null;
}

function terminal_hitbox(terminal) {
	if (!terminal.effect || terminal.effect.px === undefined) return null;
	return {
		min_x: terminal.effect.x * 16 + terminal.effect.px,
		min_y: terminal.effect.y * 16 + terminal.effect.py,
	};
}

function nominal_box_miss(shell, terminal) {
	let box = terminal_hitbox(terminal);
	if (!shell || !box) return null;
	let centre_x = shell.next_pixel_x + 8;
	let centre_y = shell.next_pixel_y + 8;
	let miss_x = Math.max(box.min_x - centre_x,
		centre_x - (box.min_x + 16), 0);
	let miss_y = Math.max(box.min_y - centre_y,
		centre_y - (box.min_y + 16), 0);
	return {
		miss_x,
		miss_y,
		chebyshev: Math.max(miss_x, miss_y),
		euclidean: Math.hypot(miss_x, miss_y),
	};
}

function same_endpoint(first, second) {
	if (!first || !second) return first === second;
	return first.next_pixel_x === second.next_pixel_x &&
		first.next_pixel_y === second.next_pixel_y;
}

function compare_games(file, records, tolerant, zero) {
	let metrics = empty_metrics();
	metrics.files = 1;
	let affected = false;
	let record_counts = new Map(records.map((record, index) => [record, index + 1]));
	for (let player = 0; player < tolerant.shell_positions.length; player++) {
		let tolerant_snapshots = tolerant.shell_positions[player];
		let zero_snapshots = zero.shell_positions[player];
		if (tolerant_snapshots.length !== zero_snapshots.length) {
			throw new Error(`snapshot count differs for player ${player}`);
		}
		for (let snapshot_index = 0;
			snapshot_index < tolerant_snapshots.length; snapshot_index++) {
			let tolerant_terminals = tolerant_snapshots[snapshot_index].terminals;
			let zero_terminals = zero_snapshots[snapshot_index].terminals;
			if (tolerant_terminals.length !== zero_terminals.length) {
				throw new Error(`terminal count differs for player ${player}`);
			}
			for (let terminal_index = 0;
				terminal_index < tolerant_terminals.length; terminal_index++) {
				let now = tolerant_terminals[terminal_index];
				let before = zero_terminals[terminal_index];
				if (now.event_type !== "tank_hit") continue;
				metrics.tank_hit_terminals++;
				let now_matched = now.match_time !== undefined;
				let before_matched = before.match_time !== undefined;
				if (now_matched) metrics.tolerant_matched++;
				if (before_matched) metrics.zero_matched++;
				let now_shell = matched_shell(tolerant_snapshots, snapshot_index, now);
				let before_shell = matched_shell(zero_snapshots, snapshot_index, before);

				if (!before_matched && now_matched) {
					affected = true;
					metrics.newly_matched++;
					if (now_shell && now_shell.pillbox_orbit_states) {
						metrics.newly_matched_orbit++;
					}
					let miss = nominal_box_miss(now_shell, now);
					if (miss) metrics.new_match_misses.push(miss);
					if (metrics.examples.length < 8) {
						metrics.examples.push({
							file: replay_label(file),
							record_count: record_counts.get(now.record),
							record_time: now.record.time,
							player,
							target: now.target_tank,
							direction: now.direction,
							match_time: now.match_time,
							endpoint: now_shell
								? [now_shell.next_pixel_x, now_shell.next_pixel_y] : null,
							miss,
						});
					}
				} else if (before_matched && !now_matched) {
					affected = true;
					metrics.lost++;
					if (before_shell && before_shell.pillbox_orbit_states) {
						metrics.lost_orbit++;
					}
				} else if (before_matched && now_matched) {
					if (now.match_time < before.match_time) {
						affected = true;
						metrics.retimed_earlier++;
						metrics.retiming_ticks.push(before.match_time - now.match_time);
					} else if (now.match_time > before.match_time) {
						affected = true;
						metrics.retimed_later++;
						metrics.retiming_ticks.push(before.match_time - now.match_time);
					} else {
						metrics.preserved_same_time++;
					}
					if (!same_endpoint(now_shell, before_shell)) {
						affected = true;
						metrics.changed_shell_endpoint++;
					}
				}
			}
		}
	}
	if (affected) metrics.affected_files++;
	return metrics;
}

function process_files(files) {
	let engines = load_engines();
	let metrics = empty_metrics();
	for (let file of files) {
		try {
			let bytes = new Uint8Array(fs.readFileSync(file));
			let records = [...engines.log.records(bytes)];
			let tolerant = engines.tolerant_game.build(records);
			let zero = engines.zero_game.build(records);
			merge_metrics(metrics, compare_games(file, records, tolerant, zero));
		} catch (error) {
			throw new Error(`${file}: ${error.message}`);
		}
	}
	return metrics;
}

function percentile(values, fraction) {
	if (!values.length) return null;
	let sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function summary(values) {
	if (!values.length) return null;
	return {
		min: Math.min(...values),
		median: percentile(values, 0.5),
		p90: percentile(values, 0.9),
		max: Math.max(...values),
	};
}

function miss_buckets(misses) {
	let values = misses.map(miss => miss.chebyshev);
	return {
		boundary: values.filter(value => value === 0).length,
		up_to_0_5: values.filter(value => value > 0 && value <= 0.5).length,
		up_to_1: values.filter(value => value > 0.5 && value <= 1).length,
		up_to_1_5: values.filter(value => value > 1 && value <= 1.5).length,
		up_to_2: values.filter(value => value > 1.5 && value <= 2).length,
	};
}

function print_metrics(metrics) {
	let percent = (part, whole) => whole
		? `${(part * 100 / whole).toFixed(3)}%` : "0.000%";
	console.log("comparison: 0px versus 2px pillbox tank-hit tolerance");
	console.log(`files: ${metrics.files.toLocaleString()}`);
	console.log(`affected files: ${metrics.affected_files.toLocaleString()}`);
	console.log(`tank-hit terminals: ${metrics.tank_hit_terminals.toLocaleString()}`);
	console.log(`matched at 0px: ${metrics.zero_matched.toLocaleString()} ` +
		`(${percent(metrics.zero_matched, metrics.tank_hit_terminals)})`);
	console.log(`matched at 2px: ${metrics.tolerant_matched.toLocaleString()} ` +
		`(${percent(metrics.tolerant_matched, metrics.tank_hit_terminals)})`);
	console.log(`newly matched: ${metrics.newly_matched.toLocaleString()}`);
	console.log(`newly matched by an orbit-backed shell: ` +
		metrics.newly_matched_orbit.toLocaleString());
	console.log(`lost matches: ${metrics.lost.toLocaleString()}`);
	console.log(`lost orbit-backed matches: ${metrics.lost_orbit.toLocaleString()}`);
	console.log(`preserved at same time: ${metrics.preserved_same_time.toLocaleString()}`);
	console.log(`retimed earlier: ${metrics.retimed_earlier.toLocaleString()}`);
	console.log(`retimed later: ${metrics.retimed_later.toLocaleString()}`);
	console.log(`changed shell endpoints: ` +
		metrics.changed_shell_endpoint.toLocaleString());
	console.log(`new-match Chebyshev miss (px): ` +
		JSON.stringify(summary(metrics.new_match_misses.map(miss => miss.chebyshev))));
	console.log(`new-match Euclidean miss (px): ` +
		JSON.stringify(summary(metrics.new_match_misses.map(miss => miss.euclidean))));
	console.log(`new-match Chebyshev buckets: ` +
		JSON.stringify(miss_buckets(metrics.new_match_misses)));
	console.log(`earlier retiming (ticks): ` +
		JSON.stringify(summary(metrics.retiming_ticks.filter(value => value > 0))));
	console.log("examples:");
	for (let example of metrics.examples.slice(0, 8)) {
		console.log(JSON.stringify(example));
	}
}

if (!isMainThread) {
	parentPort.postMessage(process_files(workerData.files));
} else {
	let args = process.argv.slice(2);
	let worker_count = Math.min(4, os.availableParallelism());
	let requested_path = DEFAULT_REPLAY;
	for (let arg of args) {
		if (arg.startsWith("--workers=")) worker_count = Number(arg.slice(10));
		else requested_path = path.resolve(arg);
	}
	let files = [...walk(requested_path)];
	if (!files.length) throw new Error(`no replay files found at ${requested_path}`);
	worker_count = Math.max(1, Math.min(worker_count, files.length));
	if (worker_count === 1) {
		print_metrics(process_files(files));
	} else {
		let chunks = Array.from({ length: worker_count }, () => []);
		for (let i = 0; i < files.length; i++) chunks[i % worker_count].push(files[i]);
		let workers = chunks.map(chunk => new Promise((resolve, reject) => {
			let worker = new Worker(__filename, { workerData: { files: chunk } });
			worker.once("message", resolve);
			worker.once("error", reject);
			worker.once("exit", code => {
				if (code !== 0) reject(new Error(`worker exited with code ${code}`));
			});
		}));
		Promise.all(workers).then(results => {
			let metrics = empty_metrics();
			for (let result of results) merge_metrics(metrics, result);
			print_metrics(metrics);
		}).catch(error => {
			console.error(error.stack || error.message);
			process.exitCode = 1;
		});
	}
}
