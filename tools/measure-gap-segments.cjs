#!/usr/bin/env node
/* The links the gap segments draw: links that outlive the sender's next
 * record.
 *
 * The renderer draws packet state. A shell is drawn from the sender's
 * latest record, lerping toward its link target, and the sender's next
 * record replaces that list. A link whose target lies beyond that next
 * record -- a shell fall retimed to its physics arrival, a stitch or a
 * residual join across a dropped or refused restatement, a forced
 * terminal reached a record or two on -- has nothing to draw it from the
 * moment the list is replaced. viewer/motion.js's gap segments
 * (build_shell_gap_segments) carry such links to their end; this tool
 * counts them, so the class is on the record and a change to the matcher
 * that grows it is seen.
 *
 * The drawn-motion audit cannot see this class: it reads every link as
 * drawn end to end, which the segments make true. Everything here is
 * read off the same link structure the audit reads, so the tool is a
 * census of what the segments carry, not a measure of how well.
 *
 *   links                 every forward link (a shell with a next_time)
 *   links_past_record     those whose target lies past the sender's next
 *                         record, shell falls excluded
 *   links_past_record_falls
 *                         the falls, carried by the segments since before
 *                         the generalisation
 *   ticks_past_record     summed ticks the non-fall links would have gone
 *                         undrawn for without the segments
 *   longest_past_record   the longest such gap, in ticks
 *   kind:<k>              the non-fall links by what the link reaches:
 *                         stitch (a continuation), visual (a visual join),
 *                         terminal:<event type>
 *   speed:<bucket>        the non-fall links by drawn speed, px/tick, the
 *                         audit's buckets: hover (<1), slow (1-1.8), steady
 *                         (1.8-2.2), fast (2.2-3), rush (>3)
 *   files_with_any        logs with at least one non-fall link past its
 *                         record
 *   example               the five logs with most, as "label count links
 *                         ticks"
 *
 * Usage: node tools/measure-gap-segments.cjs [replay-or-directory ...]
 *        [--workers=N]
 * With no path the configured corpus is read (BOLO_CORPUS or corpus.json;
 * see tools/corpus.cjs). Output is key<TAB>value, stamped with the
 * measuring commit; multi-file runs fan out over a worker pool and merge
 * in path order, so the output is the same whatever the pool size. */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } =
	require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;

function* walk(target) {
	let stat = fs.statSync(target);
	if (stat.isFile()) {
		if (!SKIPPED_EXTENSIONS.test(target)) yield target;
		return;
	}
	for (let entry of fs.readdirSync(target, { withFileTypes: true }).sort(
		(a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
		yield* walk(path.join(target, entry.name));
	}
}

function repo_commit() {
	const { execSync } = require("node:child_process");
	const run = command => execSync(command,
		{ cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	try {
		let hash = run("git rev-parse --short HEAD");
		return run("git status --porcelain -uno") ? `${hash}-dirty` : hash;
	} catch {
		return "unknown";
	}
}

function speed_bucket(speed) {
	return speed < 1 ? "hover" : speed < 1.8 ? "slow" : speed <= 2.2 ? "steady"
		: speed <= 3 ? "fast" : "rush";
}

function measure_file(file) {
	const BoloLog = require(path.join(ROOT, "viewer/logparse.js"));
	const BoloGame = require(path.join(ROOT, "viewer/game.js"));
	let result = { links: 0, past: 0, past_falls: 0, ticks: 0, longest: 0,
		kinds: {}, speeds: {} };
	let records = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	let game = BoloGame.build(records);
	for (let snapshots of game.shell_positions) {
		for (let index = 0; index + 1 < snapshots.length; index++) {
			let snapshot = snapshots[index];
			let drop_time = snapshots[index + 1].time;
			for (let shell of snapshot.shells) {
				if (shell.next_time === undefined) continue;
				result.links++;
				if (!(shell.next_time > drop_time)) continue;
				if (shell.next_terminal_event_type === "shell_falls") {
					result.past_falls++;
					continue;
				}
				result.past++;
				result.ticks += shell.next_time - drop_time;
				result.longest = Math.max(result.longest,
					shell.next_time - drop_time);
				let kind = shell.next_terminal
					? `terminal:${shell.next_terminal_event_type}`
					: shell.visual_join_source ? "visual" : "stitch";
				result.kinds[kind] = (result.kinds[kind] || 0) + 1;
				let from_x = shell.smooth_pixel_x ?? shell.pillbox_orbit_pixel_x ??
					shell.tank_exact_pixel_x ?? shell.pixel_x;
				let from_y = shell.smooth_pixel_y ?? shell.pillbox_orbit_pixel_y ??
					shell.tank_exact_pixel_y ?? shell.pixel_y;
				let to_x = shell.smooth_next_pixel_x ?? shell.next_pixel_x;
				let to_y = shell.smooth_next_pixel_y ?? shell.next_pixel_y;
				let duration = shell.next_time - snapshot.time;
				let speed = duration > 0
					? Math.hypot(to_x - from_x, to_y - from_y) / duration : Infinity;
				let bucket = speed_bucket(speed);
				result.speeds[bucket] = (result.speeds[bucket] || 0) + 1;
			}
		}
	}
	return result;
}

if (!isMainThread) {
	let results = [];
	for (let file of workerData.files) {
		try {
			results.push({ file, result: measure_file(file) });
		} catch (error) {
			results.push({ file, error: String(error.message || error) });
		}
	}
	parentPort.postMessage(results);
	return;
}

let args = process.argv.slice(2);
let workers = Math.max(1, Math.floor(os.cpus().length / 2));
let targets = [];
for (let arg of args) {
	if (arg.startsWith("--workers=")) workers = Math.max(1, parseInt(arg.slice(10), 10) || 1);
	else targets.push(arg);
}
if (!targets.length) targets.push(require("./corpus.cjs").corpus_root());
let files = [];
for (let target of targets) files.push(...walk(target));

async function main() {
	let shards = Array.from({ length: Math.min(workers, files.length) }, () => []);
	files.forEach((file, i) => shards[i % shards.length].push(file));
	let by_file = new Map();
	await Promise.all(shards.map(shard => new Promise((resolve, reject) => {
		let worker = new Worker(__filename, { workerData: { files: shard } });
		worker.on("message", results => {
			for (let item of results) by_file.set(item.file, item);
		});
		worker.on("error", reject);
		worker.on("exit", resolve);
	})));

	const { replay_label } = require("./corpus.cjs");
	let totals = { links: 0, past: 0, past_falls: 0, ticks: 0, longest: 0,
		kinds: {}, speeds: {}, with_any: 0, failed: 0 };
	let per_file = [];
	for (let file of files) {
		let item = by_file.get(file);
		if (!item || item.error) {
			totals.failed++;
			if (item) console.error(`${replay_label(file)}: ${item.error}`);
			continue;
		}
		let r = item.result;
		totals.links += r.links;
		totals.past += r.past;
		totals.past_falls += r.past_falls;
		totals.ticks += r.ticks;
		totals.longest = Math.max(totals.longest, r.longest);
		if (r.past) totals.with_any++;
		for (let k in r.kinds) totals.kinds[k] = (totals.kinds[k] || 0) + r.kinds[k];
		for (let k in r.speeds) totals.speeds[k] = (totals.speeds[k] || 0) + r.speeds[k];
		per_file.push({ label: replay_label(file), ...r });
	}
	let lines = [
		"# GENERATED - links the gap segments draw, for one repo state; nothing written to disk.",
		`commit\t${repo_commit()}`,
		`files\t${files.length}`,
		`files_failed\t${totals.failed}`,
		`links\t${totals.links}`,
		`links_past_record\t${totals.past}`,
		`links_past_record_falls\t${totals.past_falls}`,
		`ticks_past_record\t${totals.ticks.toFixed(1)}`,
		`longest_past_record\t${totals.longest.toFixed(1)}`,
		`rate_links_past_record\t${(totals.past / Math.max(1, totals.links)).toFixed(6)}`,
		`files_with_any\t${totals.with_any}`,
	];
	for (let kind of Object.keys(totals.kinds).sort()) {
		lines.push(`kind:${kind}\t${totals.kinds[kind]}`);
	}
	for (let bucket of ["hover", "slow", "steady", "fast", "rush"]) {
		lines.push(`speed:${bucket}\t${totals.speeds[bucket] || 0}`);
	}
	per_file.sort((a, b) => b.past - a.past || (a.label < b.label ? -1 : 1));
	for (let item of per_file.slice(0, 5)) {
		if (!item.past) break;
		lines.push(`example\t${item.label} ${item.past} ${item.links} ${item.ticks.toFixed(0)}`);
	}
	console.log(lines.join("\n"));
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
