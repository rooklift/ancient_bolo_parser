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
 * Multi-file runs fan the per-replay builds out over a worker pool
 * (--workers=N; default half the machine's cores). Every total is
 * additive and the per-file diagnostics are merged back in directory
 * order, so the output is byte-identical to a sequential run --
 * content_hash included -- whatever the pool size.
 *
 * With no arguments the corpus is read recursively, found the same way the
 * other measurement tools find it (BOLO_CORPUS or corpus.json at the repo
 * root); unconfigured, the tool explains how to configure it rather than
 * silently measuring something smaller.
 *
 * --describe-terminals appends diagnostic lines for the terminals that end
 * the pipeline with no matched shell and no unseen-source attribution: a
 * tally over "event_type:reason:kind" signatures naming the constraint
 * that killed each terminal's nearest-to-viable story (terminal_class
 * lines; kind is P/T/? for the best candidate's origin, "-" when nothing
 * was near), and a few example terminals per file (terminal_example
 * lines). Reasons rank nearest-to-explained first; see
 * describe_unmatched_terminals in viewer/motion.js.
 *
 * --describe-ends is the mirror: for every chain end with no forward
 * story (the engine population behind the audit's drawn pop-outs), a
 * tally over "reason:event_type:kind" signatures saying what fate was
 * available and what blocked it (end_class / end_example lines); see
 * describe_unfated_ends in viewer/motion.js.
 *
 * --describe-links names the contradicted pill links -- links the
 * statement-roster vote, taken on final state, disagrees with (see
 * score_pill_links in viewer/motion.js): a tally over
 * "pairwise|stitched:<step gap minus elected advance>" signatures
 * (link_class lines; a negative delta is a ladder linked short, a
 * positive one linked long) and every contradiction as a link_example
 * line with its record times, pill, steps and elected advance, then
 * the matcher's own election over that pair as it saw it at the time
 * (verdict, advance, score against runner-up, the pinned source steps
 * with "d" on members that held a terminal candidate, the pinned
 * landings) and the two rosters as final state pins them -- enough to
 * read a scene without the log. The three flags can be combined.
 *
 * Every metric is a "key<TAB>value" line. A value of "-" means this repo state
 * does not carry the data at all, which is not the same as a count of zero;
 * an older version without shell births reports "-", not "0". Rate lines are
 * fractions in [0, 1] to six decimal places.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } =
	require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const REPORT_FORMAT = 1;

function usage(message) {
	if (message) console.error(`error: ${message}`);
	console.error("usage: node tools/report-interpolation-rates.cjs " +
		"[--describe-terminals] [--describe-ends] [--describe-links] " +
		"[--workers=N] " +
		"[-f <replay> | -d <directory> | -r <directory>]  " +
		"(no path arguments: the whole corpus)");
	process.exit(2);
}

function parse_args(argv) {
	let describe_terminals = false;
	let describe_ends = false;
	let describe_links = false;
	let workers = null;
	argv = argv.filter(arg => {
		if (arg === "--describe-terminals") {
			describe_terminals = true;
			return false;
		}
		if (arg === "--describe-ends") {
			describe_ends = true;
			return false;
		}
		if (arg === "--describe-links") {
			describe_links = true;
			return false;
		}
		let match = arg.match(/^--workers=(\d+)$/);
		if (match) {
			workers = Math.max(1, parseInt(match[1], 10));
			return false;
		}
		return true;
	});
	let modes = { "-f": "file", "-d": "directory", "-r": "recursive" };
	if (argv.length === 0) {
		/* Corpus runs are the usual case. corpus_root() exits with advice
		 * when nothing is configured. */
		let { corpus_root } = require("./corpus.cjs");
		return { mode: "recursive", target: corpus_root(),
			describe_terminals, describe_ends, describe_links, workers };
	}
	if (argv.length !== 2) usage("exactly one flag and one path are required");
	let mode = modes[argv[0]];
	if (!mode) usage(`unknown flag ${argv[0]}`);
	return { mode, target: path.resolve(argv[1]),
		describe_terminals, describe_ends, describe_links, workers };
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
		shells_stream_birth: null,
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

		/* Pill links scored against the statement-roster vote (see
		 * score_pill_links in viewer/motion.js): the coverage rates count
		 * explanations, these say how many of the pill ones the pill's own
		 * statements corroborate. Contradicted should stay near zero. */
		links_shell: null,
		links_visual: null,
		links_no_pill_source: null,
		links_pill_restated: null,
		links_pill_unpinned: null,
		links_pill_vouched: null,
		links_pill_contradicted: null,
		links_pill_unvouched: null,
		/* The matcher's roster elections: pills with under three pinned
		 * sources cannot vote; a vote inside the margin stands down. */
		roster_votes_unvoted: null,
		roster_votes_stood_down: null,
		roster_votes_passed: null,

		/* Residual-flow components: what forced_bipartite_assignments in
		 * viewer/motion.js actually solves, and whether its pathological-
		 * component cap ever fired. Keys ending in _max take the maximum
		 * when merged rather than the sum. */
		flow_components: null,
		flow_component_edges_max: null,
		flow_components_over_cap: null,
	};
}

/* A key stays null until some file actually supplies the data, so a repo state
 * that never had the field reports "-" rather than a misleading zero. */
function add(totals, key, amount) {
	totals[key] = (totals[key] === null ? 0 : totals[key]) + amount;
}

function add_max(totals, key, amount) {
	totals[key] = totals[key] === null ? amount
		: Math.max(totals[key], amount);
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

/* Per client, so the roster vote is taken over one sender's statements,
 * exactly as the engine takes it. Guarded like the other diagnostics so
 * older repo states report "-". */
function count_pill_links(totals, engines, game) {
	let scores = [];
	if (typeof engines.motion?.score_pill_links !== "function") return null;
	if (!Array.isArray(game.shell_positions)) return scores;
	for (let snapshots of game.shell_positions) {
		if (!Array.isArray(snapshots)) continue;
		let score = engines.motion.score_pill_links(snapshots);
		scores.push(score);
		add(totals, "links_shell", score.links);
		add(totals, "links_visual", score.visual);
		add(totals, "links_no_pill_source", score.no_pill_source);
		add(totals, "links_pill_restated", score.restated);
		add(totals, "links_pill_unpinned", score.unpinned);
		add(totals, "links_pill_vouched", score.vouched);
		add(totals, "links_pill_contradicted", score.contradicted);
		add(totals, "links_pill_unvouched", score.unvouched);
		if (score.votes_passed !== undefined) {
			add(totals, "roster_votes_unvoted", score.votes_unvoted);
			add(totals, "roster_votes_stood_down", score.votes_stood_down);
			add(totals, "roster_votes_passed", score.votes_passed);
		}
	}
	return scores;
}

/* Every contradiction, classified by how far the link disagrees with
 * the elected advance. Unlike the terminal and end diagnostics there
 * is no per-file example cap: contradictions are rare by construction
 * and each one is a scene. */
function describe_links(diagnostics, scores, file) {
	if (scores === null) {
		diagnostics.unsupported = true;
		return;
	}
	for (let score of scores) {
		for (let record of score.examples || []) {
			let delta = record.next_step - record.step - record.advance;
			let signature = `${record.stitched ? "stitched" : "pairwise"}:` +
				`${delta > 0 ? "+" : ""}${delta}`;
			diagnostics.classes.set(signature,
				(diagnostics.classes.get(signature) || 0) + 1);
			diagnostics.examples.push({ file, record });
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
		"shells_stream_birth",
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
				if (shell.stream_birth) add(totals, "shells_stream_birth", 1);
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

/* One tally entry per unexplained terminal, plus a few examples per file
 * so the classes stay attached to scenes a human can open. */
const TERMINAL_EXAMPLES_PER_FILE = 3;

function describe_terminals(diagnostics, engines, game, file) {
	if (typeof engines.motion?.describe_unmatched_terminals !== "function") {
		diagnostics.unsupported = true;
		return;
	}
	let examples = 0;
	for (let snapshots of game.shell_positions || []) {
		if (!Array.isArray(snapshots)) continue;
		for (let record of engines.motion.describe_unmatched_terminals(
			snapshots)) {
			let signature = `${record.event_type}:${record.reason}` +
				`${record.detail || ""}:${record.kind}`;
			diagnostics.classes.set(signature,
				(diagnostics.classes.get(signature) || 0) + 1);
			if (examples < TERMINAL_EXAMPLES_PER_FILE) {
				examples++;
				diagnostics.examples.push({ file, record });
			}
		}
	}
}

function describe_ends(diagnostics, engines, game, file) {
	if (typeof engines.motion?.describe_unfated_ends !== "function") {
		diagnostics.unsupported = true;
		return;
	}
	let examples = 0;
	for (let snapshots of game.shell_positions || []) {
		if (!Array.isArray(snapshots)) continue;
		for (let record of engines.motion.describe_unfated_ends(snapshots)) {
			let signature =
				`${record.reason}:${record.event_type}:${record.kind}`;
			diagnostics.classes.set(signature,
				(diagnostics.classes.get(signature) || 0) + 1);
			if (examples < TERMINAL_EXAMPLES_PER_FILE) {
				examples++;
				diagnostics.examples.push({ file, record });
			}
		}
	}
}

function count_file(totals, engines, file, diagnostics) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let records = [...engines.log.records(bytes)];
	/* The motion module's flow-component counters accumulate across
	 * builds; reset so the read after this build is this file's alone. */
	if (typeof engines.motion?.reset_flow_component_stats === "function") {
		engines.motion.reset_flow_component_stats();
	}
	let game = engines.game.build(records);
	if (typeof engines.motion?.flow_component_stats === "function") {
		let flow = engines.motion.flow_component_stats();
		add(totals, "flow_components", flow.components);
		add_max(totals, "flow_component_edges_max", flow.edges_max);
		add(totals, "flow_components_over_cap", flow.over_cap);
	}
	if (diagnostics?.terminals) {
		describe_terminals(diagnostics.terminals, engines, game, file);
	}
	if (diagnostics?.ends) describe_ends(diagnostics.ends, engines, game, file);
	let link_scores = null;
	let max_ticks = engines.game.MAX_POSITION_INTERPOLATION_TICKS;
	/* Repo states from before facing had a limit of its own bridged it with
	 * the position limit, so reporting that keeps their numbers honest. */
	let max_direction_ticks =
		engines.game.MAX_DIRECTION_INTERPOLATION_TICKS ?? max_ticks;
	count_shells(totals, game);
	link_scores = count_pill_links(totals, engines, game);
	if (diagnostics?.links) describe_links(diagnostics.links, link_scores, file);
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

/* One line summarising every result line above it, excluding provenance
 * and timing (commit, input, *_ms), so identical results hash identically
 * across checkouts, invocation paths, and machines: a re-run is declared
 * byte-identical by comparing this one line instead of diffing files.
 * Duplicated in audit-drawn-motion.cjs for the same single-file reason
 * as repo_commit. */
function content_hash_line(lines) {
	const { createHash } = require("node:crypto");
	let stable = lines.filter(line => {
		let key = line.split("\t")[0];
		return key !== "commit" && key !== "input" &&
			key !== "content_hash" && !key.endsWith("_ms");
	});
	return `content_hash\t${createHash("sha256")
		.update(`${stable.join("\n")}\n`).digest("hex")}`;
}

/* The corpus directory is private and may embed a player's handle (see
 * corpus.json), so it is never written to a report verbatim -- hash it
 * instead. Duplicated in audit-drawn-motion.cjs, find-seam-jumps.cjs,
 * find-hover-links.cjs, probe-shot-fate-parsimony.cjs, and
 * measure-tank-shell-bradians.cjs for the same single-file reason as
 * repo_commit. */
function hash_input(target) {
	const { createHash } = require("node:crypto");
	return `sha256:${createHash("sha256")
		.update(path.resolve(target)).digest("hex")}`;
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
	let scored = totals.links_pill_vouched === null ? null
		: totals.links_pill_vouched + totals.links_pill_contradicted +
			totals.links_pill_unvouched;
	rate_line(lines, "links_pill_vouched", totals.links_pill_vouched, scored);
	rate_line(lines, "links_pill_contradicted",
		totals.links_pill_contradicted, scored);
	for (let prefix of ["tank", "lgm", "tank_direction"]) {
		rate_line(lines, `${prefix}_segments_interpolated`,
			totals[`${prefix}_segments_interpolated`], totals[`${prefix}_segments`]);
		rate_line(lines, `${prefix}_ticks_interpolated`,
			totals[`${prefix}_ticks_interpolated`], totals[`${prefix}_ticks`]);
	}
	lines.push(content_hash_line(lines));
	return `${lines.join("\n")}\n`;
}

function terminal_class_report(diagnostics, label) {
	let lines = [];
	if (diagnostics.unsupported) {
		lines.push(`${label}_class\t-`);
		return lines;
	}
	let classes = [...diagnostics.classes.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	for (let [signature, count] of classes) {
		lines.push(`${label}_class\t${signature}\t${count}`);
	}
	for (let { file, record } of diagnostics.examples) {
		let candidate = record.candidate
			? `candidate=(${record.candidate.time},` +
				`${record.candidate.pixel_x},${record.candidate.pixel_y}` +
				`${record.candidate.direction !== undefined
					? `,d${record.candidate.direction}` : ""})`
			: "candidate=-";
		lines.push(`${label}_example\t${path.basename(file)}` +
			`\tt${record.time}\t${record.event_type}` +
			`${record.terminal_type ? `\t${record.terminal_type}` : ""}` +
			`\t(${record.pixel_x},${record.pixel_y})` +
			`\td${record.direction === null ? "-" : record.direction}` +
			`\t${record.reason}${record.detail || ""}:${record.kind}` +
			`\t${candidate}`);
	}
	return lines;
}

function link_class_report(diagnostics) {
	let lines = [];
	if (diagnostics.unsupported) {
		lines.push("link_class\t-");
		return lines;
	}
	let classes = [...diagnostics.classes.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	for (let [signature, count] of classes) {
		lines.push(`link_class\t${signature}\t${count}`);
	}
	for (let { file, record } of diagnostics.examples) {
		/* The matcher's election over the pair, as it saw it: verdict,
		 * elected advance with the confident vote's score against its
		 * runner-up (and the full roster's, when they differ), then the
		 * pinned source steps ("d" marks a member that held a terminal
		 * candidate, so abstained) and the pinned landings. "-" is a repo
		 * state that does not record votes. */
		let vote = record.match_vote;
		let vote_text = vote === null || vote === undefined ? "-"
			: vote.verdict === "unvoted" ? "unvoted"
			: `${vote.verdict}@${vote.advance}(${vote.score}v${vote.runner_up}` +
				`${vote.full_advance !== vote.advance ||
					vote.full_score !== vote.score ||
					vote.full_runner_up !== vote.runner_up
					? `;full@${vote.full_advance}(${vote.full_score}v` +
						`${vote.full_runner_up})` : ""})`;
		lines.push(`link_example\t${path.basename(file)}` +
			`\tt${record.time}->${record.next_time}` +
			`\tpill(${record.pillbox_source_x},${record.pillbox_source_y})` +
			`\tstep${record.step}->${record.next_step}` +
			`\tadvance${record.advance}` +
			`\t${record.stitched ? "stitched" : "pairwise"}` +
			`\tvote=${vote_text}` +
			`\tsrc=${vote ? vote.sources : "-"}` +
			`\tdst=${vote ? vote.landings : "-"}` +
			`\tfinal=${record.final_sources ?? "-"}` +
			`>${record.final_landings ?? "-"}`);
	}
	return lines;
}

function load_engines(with_motion) {
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
	if (with_motion) {
		/* Kept a separate, guarded require so the tool still measures the
		 * repo states from before the diagnostics existed. */
		try {
			engines.motion = require(path.join(ROOT, "viewer", "motion.js"));
		} catch {
			engines.motion = null;
		}
		/* The election record is off in the viewer (it costs heap the app
		 * never reads); a measuring process wants it. */
		if (typeof engines.motion?.set_roster_vote_recording === "function") {
			engines.motion.set_roster_vote_recording(true);
		}
	}
	if (typeof engines.game.build !== "function" ||
		typeof engines.log.records !== "function") {
		console.error("error: this repo state has no viewer engine to report on");
		process.exit(3);
	}
	return engines;
}

let empty_diagnostics = () =>
	({ classes: new Map(), examples: [], unsupported: false });

function make_diagnostics(describe_terminals, describe_ends, describe_links) {
	return describe_terminals || describe_ends || describe_links ? {
		terminals: describe_terminals ? empty_diagnostics() : null,
		ends: describe_ends ? empty_diagnostics() : null,
		links: describe_links ? empty_diagnostics() : null,
	} : null;
}

/* Fold one file's totals into the running totals, preserving the
 * null-until-supplied semantics of add(): a key no file supplied stays
 * "-" in the report. Addition is commutative, so pool completion order
 * cannot change the result. */
function merge_totals(totals, part) {
	for (let key of Object.keys(part)) {
		if (key.endsWith("_by_type")) {
			if (part[key] === null) continue;
			if (totals[key] === null) totals[key] = new Map();
			for (let [type, count] of part[key]) {
				totals[key].set(type, (totals[key].get(type) || 0) + count);
			}
		} else if (part[key] !== null) {
			if (key.endsWith("_max")) add_max(totals, key, part[key]);
			else totals[key] = (totals[key] === null ? 0 : totals[key]) + part[key];
		}
	}
}

function merge_diagnostics(diagnostics, part) {
	for (let side of ["terminals", "ends", "links"]) {
		if (!diagnostics?.[side] || !part?.[side]) continue;
		if (part[side].unsupported) diagnostics[side].unsupported = true;
		for (let [signature, count] of part[side].classes) {
			diagnostics[side].classes.set(signature,
				(diagnostics[side].classes.get(signature) || 0) + count);
		}
		diagnostics[side].examples.push(...part[side].examples);
	}
}

function run_worker() {
	let engines = load_engines(true);
	parentPort.on("message", file => {
		let totals = empty_totals();
		let diagnostics = make_diagnostics(workerData.describe_terminals,
			workerData.describe_ends, workerData.describe_links);
		let failed = null;
		try {
			count_file(totals, engines, file, diagnostics);
			totals.files = 1;
		} catch (error) {
			totals.files_failed = 1;
			failed = error.message;
		}
		parentPort.postMessage({ file, totals, diagnostics, failed });
	});
}

function main() {
	let { mode, target, describe_terminals, describe_ends, describe_links,
		workers } = parse_args(process.argv.slice(2));
	let engines = load_engines(true);
	let files = replay_files(mode, target);
	if (!files.length) usage(`no replay files found at ${target}`);
	let totals = empty_totals();
	let diagnostics = make_diagnostics(describe_terminals, describe_ends,
		describe_links);

	let finish = () => {
		process.stdout.write(build_report(totals, {
			mode,
			input: hash_input(target),
			max_position_interpolation_ticks: engines.game.MAX_POSITION_INTERPOLATION_TICKS,
			max_shell_interpolation_ticks: engines.game.MAX_SHELL_INTERPOLATION_TICKS,
			max_direction_interpolation_ticks:
				engines.game.MAX_DIRECTION_INTERPOLATION_TICKS,
		}));
		for (let [part, label] of [
			[diagnostics?.terminals, "terminal"],
			[diagnostics?.ends, "end"],
		]) {
			if (!part) continue;
			let lines = terminal_class_report(part, label);
			if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
		}
		if (diagnostics?.links) {
			let lines = link_class_report(diagnostics.links);
			if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
		}
	};

	let worker_count = Math.min(files.length,
		workers || Math.max(1, Math.floor(os.cpus().length / 2)));
	if (worker_count === 1) {
		let done = 0;
		for (let file of files) {
			try {
				count_file(totals, engines, file, diagnostics);
				totals.files++;
			} catch (error) {
				totals.files_failed++;
				console.error(`warning: ${path.relative(ROOT, file)}: ${error.message}`);
			}
			done++;
			if (done % 10 === 0) console.error(`progress: ${done}/${files.length}`);
		}
		finish();
		return;
	}

	/* Per-file results come back in completion order but are folded in
	 * directory order, so the diagnostics' example lines -- and the
	 * unreadable-file warnings -- keep the sequential run's order and
	 * the whole output stays byte-identical. */
	let results = new Array(files.length).fill(null);
	let index_of = new Map(files.map((file, index) => [file, index]));
	let queue = files.map((file, index) => index);
	let done = 0;
	let active = 0;
	let finish_parallel = () => {
		for (let result of results) {
			if (!result) continue;
			merge_totals(totals, result.totals);
			merge_diagnostics(diagnostics, result.diagnostics);
			if (result.failed) {
				console.error(`warning: ` +
					`${path.relative(ROOT, result.file)}: ${result.failed}`);
			}
		}
		finish();
	};
	for (let i = 0; i < worker_count; i++) {
		let worker = new Worker(__filename,
			{ workerData: { describe_terminals, describe_ends,
				describe_links } });
		let dispatch = () => {
			let index = queue.shift();
			if (index === undefined) {
				worker.terminate();
				if (active === 0 && done === files.length) finish_parallel();
				return;
			}
			active++;
			worker.postMessage(files[index]);
		};
		worker.on("message", result => {
			active--;
			done++;
			results[index_of.get(result.file)] = result;
			if (done % 10 === 0) console.error(`progress: ${done}/${files.length}`);
			dispatch();
		});
		worker.on("error", error => {
			console.error(`error: worker failed: ${error.message}`);
			process.exit(1);
		});
		dispatch();
	}
}

if (isMainThread) main();
else run_worker();
