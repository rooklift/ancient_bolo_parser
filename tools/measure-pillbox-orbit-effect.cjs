#!/usr/bin/env node
/* Compare the current shell matcher with a pre-orbit Git revision.
 *
 * Usage:
 *   node tools/measure-pillbox-orbit-effect.cjs [replay-or-directory]
 *       [--baseline=6777d35] [--workers=4]
 */
"use strict";

const child_process = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } =
	require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const DEFAULT_REPLAY = path.join(ROOT, "fixtures", "n20021018.2");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;

function empty_metrics() {
	return {
		files: 0,
		frames: 0,
		baseline_matched: 0,
		current_matched: 0,
		preserved: 0,
		newly_matched: 0,
		rejected: 0,
		changed: 0,
		baseline_pill_frames: 0,
		current_orbit_frames: 0,
		current_ambiguous_orbit_frames: 0,
		rejected_by_kind: {},
		newly_matched_by_kind: {},
		directly_disproved_births: 0,
		directly_disproved_successors: 0,
		directly_disproved_falls: 0,
	};
}

function add_count(table, key, amount = 1) {
	table[key] = (table[key] || 0) + amount;
}

function merge_metrics(target, source) {
	for (let [key, value] of Object.entries(source)) {
		if (typeof value === "number") target[key] += value;
		else for (let [item, count] of Object.entries(value)) {
			add_count(target[key], item, count);
		}
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

function load_engines(baseline_ref) {
	let log = require(path.join(ROOT, "viewer", "logparse.js"));
	let game_path = require.resolve(path.join(ROOT, "viewer", "game.js"));
	let motion_path = require.resolve(path.join(ROOT, "viewer", "motion.js"));
	delete require.cache[game_path];
	let current_game = require(game_path);

	let baseline_source = child_process.execFileSync("git", [
		"show", `${baseline_ref}:viewer/motion.js`,
	], { cwd: ROOT, encoding: "utf8" });
	let baseline_motion = compile_module(motion_path, baseline_source);
	let saved_motion = require.cache[motion_path];
	let injected = new Module(motion_path, module);
	injected.filename = motion_path;
	injected.exports = baseline_motion;
	require.cache[motion_path] = injected;
	delete require.cache[game_path];
	let baseline_game = require(game_path);
	if (saved_motion) require.cache[motion_path] = saved_motion;
	else delete require.cache[motion_path];
	delete require.cache[game_path];

	return { log, current_game, baseline_game };
}

function match_kind(shell) {
	if (shell.next_time === undefined) return "none";
	if (!shell.next_terminal) return "successor";
	return shell.next_terminal_event_type || shell.next_terminal_type || "terminal";
}

function same_match(first, second) {
	let first_kind = match_kind(first);
	let second_kind = match_kind(second);
	if (first_kind !== second_kind) return false;
	if (first_kind === "none") return true;
	if (first_kind !== "successor") return true;
	return first.next_time === second.next_time &&
		first.next_pixel_x === second.next_pixel_x &&
		first.next_pixel_y === second.next_pixel_y;
}

function orbit_position_matches(position, pixel_x, pixel_y,
	position_uncertainty = 0) {
	return position[0] >= pixel_x &&
		position[0] <= pixel_x + position_uncertainty &&
		position[1] >= pixel_y &&
		position[1] <= pixel_y + position_uncertainty;
}

function orbit_states_at(orbits, shell, position_uncertainty = 0) {
	if (shell.pillbox_source_x === undefined) return [];
	let relative_x = shell.pixel_x - shell.pillbox_source_x;
	let relative_y = shell.pixel_y - shell.pillbox_source_y;
	let states = [];
	for (let orbit of orbits) {
		if (orbit.coarse_direction !== shell.direction) continue;
		for (let step = 0; step < orbit.positions.length; step++) {
			let position = orbit.positions[step];
			if (orbit_position_matches(position, relative_x, relative_y,
				position_uncertainty)) {
				states.push({ orbit, step });
			}
		}
	}
	return states;
}

function baseline_link_is_disproved(orbits, shell, position_uncertainty,
	next_position_uncertainty = 0) {
	let states = orbit_states_at(orbits, shell, position_uncertainty);
	if (!states.length) return "birth";
	let kind = match_kind(shell);
	if (kind === "successor") {
		let relative_x = shell.next_pixel_x - shell.pillbox_source_x;
		let relative_y = shell.next_pixel_y - shell.pillbox_source_y;
		let viable = states.some(state => {
			for (let step = state.step + 1;
				step < state.orbit.positions.length; step++) {
				let position = state.orbit.positions[step];
				if (orbit_position_matches(position, relative_x, relative_y,
					next_position_uncertainty)) return true;
			}
			return false;
		});
		return viable ? null : "successor";
	}
	if (kind === "shell_falls") {
		let viable = states.some(state =>
			shell.pillbox_source_x + state.orbit.terminal[0] === shell.next_pixel_x &&
			shell.pillbox_source_y + state.orbit.terminal[1] === shell.next_pixel_y);
		return viable ? null : "fall";
	}
	return null;
}

function compare_games(current, baseline, orbits) {
	let metrics = empty_metrics();
	metrics.files = 1;
	for (let player = 0; player < current.shell_positions.length; player++) {
		let current_snapshots = current.shell_positions[player];
		let baseline_snapshots = baseline.shell_positions[player];
		if (current_snapshots.length !== baseline_snapshots.length) {
			throw new Error(`snapshot count differs for player ${player}`);
		}
		for (let snapshot_index = 0;
			snapshot_index < current_snapshots.length; snapshot_index++) {
			let current_shells = current_snapshots[snapshot_index].shells;
			let baseline_shells = baseline_snapshots[snapshot_index].shells;
			if (current_shells.length !== baseline_shells.length) {
				throw new Error(`shell count differs for player ${player}`);
			}
			for (let shell_index = 0; shell_index < current_shells.length;
				shell_index++) {
				let now = current_shells[shell_index];
				let before = baseline_shells[shell_index];
				metrics.frames++;
				if (before.next_time !== undefined) metrics.baseline_matched++;
				if (now.next_time !== undefined) metrics.current_matched++;
				if (before.pillbox_source_x !== undefined) {
					metrics.baseline_pill_frames++;
				}
				if (now.pillbox_orbit_states) {
					metrics.current_orbit_frames++;
					if (now.pillbox_orbit_states.length > 1) {
						metrics.current_ambiguous_orbit_frames++;
					}
				}

				let before_matched = before.next_time !== undefined;
				let now_matched = now.next_time !== undefined;
				if (before_matched && !now_matched) {
					metrics.rejected++;
					add_count(metrics.rejected_by_kind, match_kind(before));
					if (before.pillbox_source_x !== undefined) {
						let next_position_uncertainty = 0;
						if (match_kind(before) === "successor") {
							let next_snapshot = current_snapshots[snapshot_index + 1];
							let next_shells = next_snapshot ? next_snapshot.shells.filter(shell =>
								shell.pixel_x === before.next_pixel_x &&
								shell.pixel_y === before.next_pixel_y &&
								shell.direction === before.direction) : [];
							if (next_shells.length) {
								next_position_uncertainty = Math.max(...next_shells.map(shell =>
									shell.position_uncertainty));
							}
						}
						let reason = baseline_link_is_disproved(orbits, before,
							now.position_uncertainty, next_position_uncertainty);
						if (reason === "birth") metrics.directly_disproved_births++;
						else if (reason === "successor") {
							metrics.directly_disproved_successors++;
						} else if (reason === "fall") {
							metrics.directly_disproved_falls++;
						}
					}
				} else if (!before_matched && now_matched) {
					metrics.newly_matched++;
					add_count(metrics.newly_matched_by_kind, match_kind(now));
				} else if (before_matched && now_matched) {
					if (same_match(before, now)) metrics.preserved++;
					else metrics.changed++;
				}
			}
		}
	}
	return metrics;
}

function process_files(files, baseline_ref) {
	let engines = load_engines(baseline_ref);
	let orbits = require(path.join(ROOT, "viewer", "pillbox_shell_orbits.js")).orbits;
	let metrics = empty_metrics();
	for (let file of files) {
		try {
			let bytes = new Uint8Array(fs.readFileSync(file));
			let records = [...engines.log.records(bytes)];
			let current = engines.current_game.build(records);
			let baseline = engines.baseline_game.build(records);
			merge_metrics(metrics, compare_games(current, baseline, orbits));
		} catch (error) {
			throw new Error(`${file}: ${error.message}`);
		}
	}
	return metrics;
}

function print_metrics(metrics, baseline_ref) {
	let percent = (part, whole) => whole
		? `${(part * 100 / whole).toFixed(3)}%` : "0.000%";
	let proven = metrics.directly_disproved_births +
		metrics.directly_disproved_successors + metrics.directly_disproved_falls;
	console.log(`baseline: ${baseline_ref}`);
	console.log(`files: ${metrics.files.toLocaleString()}`);
	console.log(`shell frames: ${metrics.frames.toLocaleString()}`);
	console.log(`baseline matched: ${metrics.baseline_matched.toLocaleString()} ` +
		`(${percent(metrics.baseline_matched, metrics.frames)})`);
	console.log(`current matched: ${metrics.current_matched.toLocaleString()} ` +
		`(${percent(metrics.current_matched, metrics.frames)})`);
	let net_matches = metrics.current_matched - metrics.baseline_matched;
	console.log(`net match change: ${net_matches.toLocaleString()} ` +
		`(${(net_matches * 100 / metrics.frames).toFixed(3)} points)`);
	console.log(`preserved matches: ${metrics.preserved.toLocaleString()}`);
	console.log(`newly recovered: ${metrics.newly_matched.toLocaleString()} ` +
		JSON.stringify(metrics.newly_matched_by_kind));
	console.log(`rejected old matches: ${metrics.rejected.toLocaleString()} ` +
		JSON.stringify(metrics.rejected_by_kind));
	console.log(`changed destinations: ${metrics.changed.toLocaleString()}`);
	console.log(`orbit-backed frames: ${metrics.current_orbit_frames.toLocaleString()} ` +
		`(${percent(metrics.current_orbit_frames, metrics.frames)})`);
	console.log(`still-overlapping orbit states: ` +
		metrics.current_ambiguous_orbit_frames.toLocaleString());
	console.log(`rejections directly disproved by orbit data: ${proven.toLocaleString()} ` +
		`(${percent(proven, metrics.rejected)}) ` +
		JSON.stringify({
			birth: metrics.directly_disproved_births,
			successor: metrics.directly_disproved_successors,
			fall: metrics.directly_disproved_falls,
		}));
}

if (!isMainThread) {
	parentPort.postMessage(process_files(workerData.files, workerData.baseline_ref));
} else {
	let args = process.argv.slice(2);
	let baseline_ref = "6777d35";
	let worker_count = Math.min(4, os.availableParallelism());
	let requested_path = DEFAULT_REPLAY;
	for (let arg of args) {
		if (arg.startsWith("--baseline=")) baseline_ref = arg.slice(11);
		else if (arg.startsWith("--workers=")) worker_count = Number(arg.slice(10));
		else requested_path = path.resolve(arg);
	}
	let files = [...walk(requested_path)];
	if (!files.length) throw new Error(`no replay files found at ${requested_path}`);
	worker_count = Math.max(1, Math.min(worker_count, files.length));
	if (worker_count === 1) {
		print_metrics(process_files(files, baseline_ref), baseline_ref);
	} else {
		let chunks = Array.from({ length: worker_count }, () => []);
		for (let i = 0; i < files.length; i++) chunks[i % worker_count].push(files[i]);
		let workers = chunks.map(chunk => new Promise((resolve, reject) => {
			let worker = new Worker(__filename, {
				workerData: { files: chunk, baseline_ref },
			});
			worker.once("message", resolve);
			worker.once("error", reject);
			worker.once("exit", code => {
				if (code !== 0) reject(new Error(`worker exited with code ${code}`));
			});
		}));
		Promise.all(workers).then(results => {
			let metrics = empty_metrics();
			for (let result of results) merge_metrics(metrics, result);
			print_metrics(metrics, baseline_ref);
		}).catch(error => {
			console.error(error.stack || error.message);
			process.exitCode = 1;
		});
	}
}
