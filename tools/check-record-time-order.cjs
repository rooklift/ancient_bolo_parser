#!/usr/bin/env node
/* Do a sender's record timestamps ever run backwards?
 *
 * The motion engine assumes they never do. Its per-client snapshot lists
 * are built in record order and then searched by time: the stitching and
 * residual passes binary-search their chain ends, starts, fate groups and
 * creation groups (first_at_or_after in viewer/motion.js), and the
 * absorption pass binary-searches the snapshots themselves. A receive
 * stamp that steps backwards would not crash any of that, but it would
 * silently shrink a search window and drop matches. This tool asserts the
 * assumption over a corpus rather than trusting it.
 *
 * Per file and per player slot, every adjacent record pair is classed by
 * the sign of its time step. Two populations are counted: every record
 * the parser yields, and only the records that produce a motion snapshot
 * (the same filter build_shell_positions applies -- a record with no
 * shell list from a dead slot or carrying only map/node subpackets makes
 * none). Whole-file order across all senders is counted too, since the
 * game state and effect timelines walk records in that order.
 *
 * Every metric is a "key<TAB>value" line. Each backwards step is also
 * printed as a dip_example line (file label, player, record index, the
 * two times) so a scene can be found; the exit status is 1 when any
 * backwards step exists in the snapshot population, so the tool doubles
 * as an assertion.
 *
 * Usage:
 *   node tools/check-record-time-order.cjs [replay-or-directory]
 *       (no arguments: the whole corpus, via BOLO_CORPUS/corpus.json,
 *       falling back to the committed fixtures when neither is set)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_TARGET = path.join(ROOT, "fixtures");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const EXAMPLES_PER_FILE = 5;

/* Mirrors MAP_NODE_TYPES and the snapshot filter in viewer/motion.js. */
const MAP_NODE_TYPES = new Set([
	"node_id", "map_run", "map_terrain_request", "map_header_request",
	"game_info", "pillbox_list", "base_list", "start_list", "history",
	"attached_log",
]);

function makes_snapshot(rec) {
	let map_node_only = rec.subpackets.length > 0 &&
		rec.subpackets.every(sub => MAP_NODE_TYPES.has(sub.type));
	let has_shells = rec.subpackets.some(sub => sub.type === "shells");
	return has_shells || !(rec.tankStatus === 0x0f || map_node_only);
}

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

function empty_steps() {
	return { pairs: 0, forward: 0, zero: 0, backward: 0, backward_max: 0,
		forward_max: 0 };
}

function count_step(steps, delta) {
	steps.pairs++;
	if (delta > 0) {
		steps.forward++;
		if (delta > steps.forward_max) steps.forward_max = delta;
	} else if (delta === 0) {
		steps.zero++;
	} else {
		steps.backward++;
		if (-delta > steps.backward_max) steps.backward_max = -delta;
	}
}

function empty_tally() {
	return {
		records: 0,
		snapshot_records: 0,
		per_sender_all: empty_steps(),
		per_sender_snapshots: empty_steps(),
		whole_file: empty_steps(),
		files_with_dips: 0,
		files_with_snapshot_dips: 0,
	};
}

function measure_file(recs, tally, examples, label) {
	let last_all = new Map();
	let last_snapshot = new Map();
	let last_any = null;
	let dips = 0, snapshot_dips = 0;
	for (let index = 0; index < recs.length; index++) {
		let rec = recs[index];
		tally.records++;
		if (last_any !== null) count_step(tally.whole_file, rec.time - last_any);
		last_any = rec.time;

		let previous = last_all.get(rec.player);
		if (previous !== undefined) {
			let delta = rec.time - previous.time;
			count_step(tally.per_sender_all, delta);
			if (delta < 0) dips++;
		}
		last_all.set(rec.player, { time: rec.time, index });

		if (!makes_snapshot(rec)) continue;
		tally.snapshot_records++;
		previous = last_snapshot.get(rec.player);
		if (previous !== undefined) {
			let delta = rec.time - previous.time;
			count_step(tally.per_sender_snapshots, delta);
			if (delta < 0) {
				snapshot_dips++;
				if (snapshot_dips <= EXAMPLES_PER_FILE) {
					examples.push(`dip_example\t${label}\tplayer=${rec.player}` +
						`\trecord=${index}\tfrom=${previous.time}\tto=${rec.time}`);
				}
			}
		}
		last_snapshot.set(rec.player, { time: rec.time, index });
	}
	if (dips) tally.files_with_dips++;
	if (snapshot_dips) tally.files_with_snapshot_dips++;
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
	const { replay_label } = require(path.join(ROOT, "tools", "corpus.cjs"));
	let target;
	if (process.argv[2]) {
		target = path.resolve(process.argv[2]);
	} else {
		let corpus = null;
		try {
			corpus = require(path.join(ROOT, "tools", "corpus.cjs"))
				.resolve_corpus_root();
		} catch (error) {
			corpus = null;
		}
		target = corpus && fs.existsSync(corpus) ? corpus : DEFAULT_TARGET;
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
		measure_file(recs, tally, examples, replay_label(file));
	}
	let lines = [
		"# GENERATED - record timestamp order per sender; nothing written to disk.",
		`commit\t${repo_commit()}`,
		`files\t${files.length}`,
		`files_failed\t${failed}`,
	];
	for (let [key, value] of Object.entries(tally)) {
		if (typeof value === "number") {
			lines.push(`${key}\t${value}`);
		} else {
			for (let [cls, n] of Object.entries(value)) {
				lines.push(`${key}_${cls}\t${n}`);
			}
		}
	}
	lines.push(...examples);
	let verdict = tally.per_sender_snapshots.backward === 0 ? "monotonic"
		: "BACKWARDS_STEPS_FOUND";
	lines.push(`verdict\t${verdict}`);
	console.log(lines.join("\n"));
	process.exitCode = verdict === "monotonic" ? 0 : 1;
}

if (require.main === module) main();
module.exports = { measure_file, empty_tally, makes_snapshot };
