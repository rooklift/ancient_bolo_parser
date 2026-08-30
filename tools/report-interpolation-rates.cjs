#!/usr/bin/env node
/* Report how much of a replay the motion code manages to interpolate.
 *
 * The report is a self-contained account of one repo state: it reads replays,
 * counts what the current viewer/motion.js resolved, and prints the tally to
 * stdout. Nothing is written to disk, so the same command can be run against a
 * series of checked-out historical versions and the outputs compared.
 *
 * Usage (exactly one of):
 *   node tools/report-interpolation-rates.cjs                  (whole corpus)
 *   node tools/report-interpolation-rates.cjs -f <replay>
 *   node tools/report-interpolation-rates.cjs -d <directory>   (files within)
 *   node tools/report-interpolation-rates.cjs -r <directory>   (recursive)
 *
 * With no arguments the corpus is read recursively, found the same way the
 * other measurement tools find it (BOLO_CORPUS or corpus.json at the repo
 * root); unconfigured, the tool explains how to configure it rather than
 * silently measuring something smaller.
 *
 * Every metric is a "key<TAB>value" line. A value of "-" means this repo state
 * does not carry the data at all, which is not the same as a count of zero;
 * an older version without shell births reports "-", not "0". Rate lines are
 * fractions in [0, 1] to six decimal places.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp)$/i;
const REPORT_FORMAT = 1;

function usage(message) {
	if (message) console.error(`error: ${message}`);
	console.error("usage: node tools/report-interpolation-rates.cjs " +
		"[-f <replay> | -d <directory> | -r <directory>]  " +
		"(no arguments: the whole corpus)");
	process.exit(2);
}

function parse_args(argv) {
	let modes = { "-f": "file", "-d": "directory", "-r": "recursive" };
	if (argv.length === 0) {
		/* Corpus runs are the usual case. corpus_root() exits with advice
		 * when nothing is configured. */
		let { corpus_root } = require("./corpus.cjs");
		return { mode: "recursive", target: corpus_root() };
	}
	if (argv.length !== 2) usage("exactly one flag and one path are required");
	let mode = modes[argv[0]];
	if (!mode) usage(`unknown flag ${argv[0]}`);
	return { mode, target: path.resolve(argv[1]) };
}

/* Directory listings are sorted so a corpus is visited in the same order on
 * every version; the counts do not depend on order, but the stderr warnings
 * about unreadable files do. */
function replay_files(mode, target) {
	let stat;
	try {
		stat = fs.statSync(target);
	} catch {
		usage(`cannot read ${target}`);
	}
	if (mode === "file") {
		if (!stat.isFile()) usage(`${target} is not a file`);
		return [target];
	}
	if (!stat.isDirectory()) usage(`${target} is not a directory`);
	let files = [];
	let visit = dir => {
		let entries = fs.readdirSync(dir, { withFileTypes: true });
		entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
		for (let entry of entries) {
			let item = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (mode === "recursive") visit(item);
			} else if (entry.isFile() && !SKIPPED_EXTENSIONS.test(entry.name)) {
				files.push(item);
			}
		}
	};
	visit(target);
	return files;
}

function empty_totals() {
	return {
		files: 0,
		files_failed: 0,

		/* Shell observations: one per shell in one snapshot. */
		shells: null,
		shells_in_final_snapshot: null,
		shells_matched_forward: null,
		shells_matched_to_snapshot: null,
		shells_matched_to_terminal: null,
		shells_unmatched_forward: null,
		shells_matched_from_previous: null,
		shells_unlinked: null,
		shells_from_tank: null,
		shells_from_pillbox: null,
		shells_with_birth: null,
		shells_with_pillbox_source: null,

		/* Terminals: the impacts and explosions a shell should account for. */
		terminals: null,
		terminals_matched: null,
		terminals_unmatched: null,
		terminals_unseen_pillbox_source: null,
		terminals_unseen_tank_source: null,
		shells_visual_joins: null,
		shells_unseen_pillbox_birth: null,
		terminals_by_type: null,
		terminals_matched_by_type: null,

		/* Position tracks. A segment is the span between consecutive points;
		 * it is interpolated when the later point continues the earlier one
		 * and the gap is short enough for the motion code to bridge. */
		tank_points: null,
		tank_segments: null,
		tank_segments_interpolated: null,
		tank_segments_broken: null,
		tank_segments_overlong: null,
		tank_ticks: null,
		tank_ticks_interpolated: null,

		lgm_points: null,
		lgm_segments: null,
		lgm_segments_interpolated: null,
		lgm_segments_broken: null,
		lgm_segments_overlong: null,
		lgm_ticks: null,
		lgm_ticks_interpolated: null,

		/* Tank facing is a track of its own, with a gap limit of its own: a
		 * turn rate is bounded in a way a path across open ground is not. */
		tank_direction_points: null,
		tank_direction_segments: null,
		tank_direction_segments_interpolated: null,
		tank_direction_segments_broken: null,
		tank_direction_segments_overlong: null,
		tank_direction_ticks: null,
		tank_direction_ticks_interpolated: null,

		shell_births: null,
	};
}

/* A key stays null until some file actually supplies the data, so a repo state
 * that never had the field reports "-" rather than a misleading zero. */
function add(totals, key, amount) {
	totals[key] = (totals[key] === null ? 0 : totals[key]) + amount;
}

function add_by_type(totals, key, type, amount) {
	if (totals[key] === null) totals[key] = new Map();
	let map = totals[key];
	map.set(type, (map.get(type) || 0) + amount);
}

function count_tracks(totals, tracks, prefix, max_ticks) {
	if (!Array.isArray(tracks)) return;
	add(totals, `${prefix}_points`, 0);
	add(totals, `${prefix}_segments`, 0);
	add(totals, `${prefix}_segments_interpolated`, 0);
	add(totals, `${prefix}_segments_broken`, 0);
	add(totals, `${prefix}_segments_overlong`, 0);
	add(totals, `${prefix}_ticks`, 0);
	add(totals, `${prefix}_ticks_interpolated`, 0);
	for (let track of tracks) {
		if (!Array.isArray(track)) continue;
		add(totals, `${prefix}_points`, track.length);
		for (let i = 0; i + 1 < track.length; i++) {
			let duration = track[i + 1].time - track[i].time;
			if (!(duration > 0)) continue;
			add(totals, `${prefix}_segments`, 1);
			add(totals, `${prefix}_ticks`, duration);
			if (!track[i + 1].continuous) {
				add(totals, `${prefix}_segments_broken`, 1);
			} else if (max_ticks !== undefined && duration > max_ticks) {
				add(totals, `${prefix}_segments_overlong`, 1);
			} else {
				add(totals, `${prefix}_segments_interpolated`, 1);
				add(totals, `${prefix}_ticks_interpolated`, duration);
			}
		}
	}
}

function count_shells(totals, game) {
	let players = game.shell_positions;
	if (!Array.isArray(players)) return;
	for (let key of ["shells", "shells_in_final_snapshot",
		"shells_matched_forward", "shells_matched_to_snapshot",
		"shells_matched_to_terminal", "shells_unmatched_forward",
		"shells_matched_from_previous", "shells_unlinked", "shells_from_tank",
		"shells_from_pillbox", "shells_unseen_pillbox_birth",
		"shells_with_birth",
		"shells_with_pillbox_source", "terminals", "terminals_matched",
		"terminals_unmatched", "terminals_unseen_pillbox_source",
		"terminals_unseen_tank_source",
		"shells_visual_joins"]) {
		add(totals, key, 0);
	}
	for (let snapshots of players) {
		if (!Array.isArray(snapshots)) continue;
		for (let index = 0; index < snapshots.length; index++) {
			let snapshot = snapshots[index];
			let final = index === snapshots.length - 1;
			for (let shell of snapshot.shells || []) {
				add(totals, "shells", 1);
				if (final) add(totals, "shells_in_final_snapshot", 1);
				if (shell.next_time !== undefined) {
					add(totals, "shells_matched_forward", 1);
					add(totals, shell.next_terminal ? "shells_matched_to_terminal"
						: "shells_matched_to_snapshot", 1);
				} else {
					add(totals, "shells_unmatched_forward", 1);
					if (!shell.matched_from_previous) add(totals, "shells_unlinked", 1);
				}
				if (shell.matched_from_previous) {
					add(totals, "shells_matched_from_previous", 1);
				}
				if (shell.visual_join) add(totals, "shells_visual_joins", 1);
				if (shell.starts_at_tank) add(totals, "shells_from_tank", 1);
				if (shell.starts_at_pillbox) add(totals, "shells_from_pillbox", 1);
				if (shell.unseen_pillbox_shot) {
					add(totals, "shells_unseen_pillbox_birth", 1);
				}
				if (shell.birth_time !== undefined) add(totals, "shells_with_birth", 1);
				if (shell.pillbox_source_x !== undefined) {
					add(totals, "shells_with_pillbox_source", 1);
				}
			}
			for (let terminal of snapshot.terminals || []) {
				let type = terminal.event_type || "unknown";
				add(totals, "terminals", 1);
				add_by_type(totals, "terminals_by_type", type, 1);
				if (terminal.match_time !== undefined) {
					add(totals, "terminals_matched", 1);
					add_by_type(totals, "terminals_matched_by_type", type, 1);
				} else {
					add(totals, "terminals_unmatched", 1);
				}
				if (terminal.unseen_pillbox_source) {
					add(totals, "terminals_unseen_pillbox_source", 1);
				}
				if (terminal.unseen_tank_source) {
					add(totals, "terminals_unseen_tank_source", 1);
				}
			}
		}
	}
}

function count_file(totals, engines, file) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let records = [...engines.log.records(bytes)];
	let game = engines.game.build(records);
	let max_ticks = engines.game.MAX_POSITION_INTERPOLATION_TICKS;
	/* Repo states from before facing had a limit of its own bridged it with
	 * the position limit, so reporting that keeps their numbers honest. */
	let max_direction_ticks =
		engines.game.MAX_DIRECTION_INTERPOLATION_TICKS ?? max_ticks;
	count_shells(totals, game);
	count_tracks(totals, game.tank_positions, "tank", max_ticks);
	count_tracks(totals, game.lgm_positions, "lgm", max_ticks);
	count_tracks(totals, game.tank_directions, "tank_direction",
		max_direction_ticks);
	if (Array.isArray(game.shell_births)) {
		add(totals, "shell_births", 0);
		for (let births of game.shell_births) {
			add(totals, "shell_births", Array.isArray(births) ? births.length : 0);
		}
	}
}

function cell(value) {
	return value === null || value === undefined ? "-" : String(value);
}

function rate_line(lines, key, part, whole) {
	if (part === null || whole === null || !whole) {
		lines.push(`rate_${key}\t-`);
		return;
	}
	lines.push(`rate_${key}\t${(part / whole).toFixed(6)}`);
}


/* The commit the measuring engine was built from, for output provenance:
 * short hash, "-dirty" appended when tracked files carry uncommitted
 * changes (untracked files are ignored -- report outputs and corpus.json
 * live beside the tree), "unknown" outside a git checkout. Duplicated in
 * audit-drawn-motion.cjs so each tool stays a single file
 * droppable into historical worktrees for baseline re-runs. */
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

function build_report(totals, meta) {
	let lines = [
		"# GENERATED - interpolation coverage for one repo state; nothing written to disk.",
		`format\t${REPORT_FORMAT}`,
		`commit\t${repo_commit()}`,
		`mode\t${meta.mode}`,
		`input\t${meta.input}`,
		`max_position_interpolation_ticks\t${cell(meta.max_position_interpolation_ticks)}`,
		`max_shell_interpolation_ticks\t${cell(meta.max_shell_interpolation_ticks)}`,
		`max_direction_interpolation_ticks\t` +
			`${cell(meta.max_direction_interpolation_ticks)}`,
	];
	for (let key of Object.keys(totals)) {
		if (key.endsWith("_by_type")) continue;
		lines.push(`${key}\t${cell(totals[key])}`);
	}
	for (let key of ["terminals_by_type", "terminals_matched_by_type"]) {
		let map = totals[key];
		if (map === null) continue;
		for (let type of [...map.keys()].sort()) {
			lines.push(`${key.replace("_by_type", "")}:${type}\t${map.get(type)}`);
		}
	}

	rate_line(lines, "shells_matched_forward",
		totals.shells_matched_forward, totals.shells);
	rate_line(lines, "shells_matched_forward_excluding_final_snapshot",
		totals.shells_matched_forward, totals.shells === null ? null
			: totals.shells - totals.shells_in_final_snapshot);
	rate_line(lines, "shells_unlinked", totals.shells_unlinked, totals.shells);
	rate_line(lines, "terminals_matched", totals.terminals_matched,
		totals.terminals);
	for (let prefix of ["tank", "lgm", "tank_direction"]) {
		rate_line(lines, `${prefix}_segments_interpolated`,
			totals[`${prefix}_segments_interpolated`], totals[`${prefix}_segments`]);
		rate_line(lines, `${prefix}_ticks_interpolated`,
			totals[`${prefix}_ticks_interpolated`], totals[`${prefix}_ticks`]);
	}
	return `${lines.join("\n")}\n`;
}

function main() {
	let { mode, target } = parse_args(process.argv.slice(2));
	let engines;
	try {
		engines = {
			log: require(path.join(ROOT, "viewer", "logparse.js")),
			game: require(path.join(ROOT, "viewer", "game.js")),
		};
	} catch (error) {
		console.error(`error: this repo state has no loadable viewer engine: ${error.message}`);
		process.exit(3);
	}
	if (typeof engines.game.build !== "function" ||
		typeof engines.log.records !== "function") {
		console.error("error: this repo state has no viewer engine to report on");
		process.exit(3);
	}

	let files = replay_files(mode, target);
	if (!files.length) usage(`no replay files found at ${target}`);
	let totals = empty_totals();
	for (let file of files) {
		try {
			count_file(totals, engines, file);
			totals.files++;
		} catch (error) {
			totals.files_failed++;
			console.error(`warning: ${path.relative(ROOT, file)}: ${error.message}`);
		}
	}
	process.stdout.write(build_report(totals, {
		mode,
		input: path.relative(ROOT, target).replace(/\\/g, "/") || ".",
		max_position_interpolation_ticks: engines.game.MAX_POSITION_INTERPOLATION_TICKS,
		max_shell_interpolation_ticks: engines.game.MAX_SHELL_INTERPOLATION_TICKS,
		max_direction_interpolation_ticks:
			engines.game.MAX_DIRECTION_INTERPOLATION_TICKS,
	}));
}

main();
