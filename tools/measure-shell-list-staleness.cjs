#!/usr/bin/env node
/* Measure per-shell-list sampling skew within single records.
 *
 * One record can carry several concatenated shell lists. If every list
 * were sampled at the same simulation instant, any two shells of one
 * pillbox would advance by the SAME number of orbit steps between two
 * records of their sender -- the sender moves every shell one step in
 * the same update pass. This tool measures how true that is: for every
 * pair of same-pill matched shells whose orbit step is unambiguous at
 * both ends of one snapshot transition, the difference of their step
 * advances, bucketed by whether the pair shared a shell list at the
 * source and at the destination statement.
 *
 * The tally conditions on chains the matcher linked with a single
 * surviving orbit state at both ends, so it UNDERCOUNTS skew: a badly
 * skewed statement is exactly the one whose chain tends to break, and
 * broken chains contribute no pairs. Read the nonzero fractions as a
 * floor. Backs [E:shell-list-skew] in FORMAT.md.
 *
 * Usage:
 *   node tools/measure-shell-list-staleness.cjs -f <replay>
 *   node tools/measure-shell-list-staleness.cjs [--workers=N] [<directory>]
 *       (no arguments: the whole corpus, via BOLO_CORPUS/corpus.json)
 *
 * Multi-file runs fan the builds out over a worker pool (default half
 * the machine's cores); the buckets are additive, so the output is
 * identical whatever the pool size.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const Orbits = require(path.join(__dirname, "..", "viewer",
	"pillbox_shell_orbits.js"));

/* A shell near the end of its ~32-step life cannot show a large advance
 * -- the orbit table simply ends -- so near-expiry links would read as
 * spurious "slow" members. Exclude any member whose source step plus
 * the wall-clock window plus the dilated slack reaches the end of its
 * orbit. */
const ORBIT_LENGTH = new Map(Orbits.orbits.map(orbit =>
	[orbit.bradian, orbit.positions.length]));
const EXPIRY_SLACK_STEPS = 8;

const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const BUCKET_KEYS = ["same-list/same-list", "same-list/cross-list",
	"cross-list/same-list", "cross-list/cross-list"];
const buckets = new Map(BUCKET_KEYS.map(key => [key, new Map()]));
let pairs = 0;

function tally(file) {
	let game;
	try {
		game = BoloGame.build([...BoloLog.records(
			new Uint8Array(fs.readFileSync(file)))]);
	} catch (error) {
		return false;
	}
	for (let player = 0; player < 16; player++) {
		for (const snapshot of game.shell_positions[player]) {
			const members = [];
			for (const shell of snapshot.shells) {
				if (shell.pillbox_source_x === undefined || shell.next_terminal ||
					!shell.next_shell) continue;
				const from = shell.pillbox_orbit_states;
				const to = shell.next_shell.pillbox_orbit_states;
				if (!from || from.length !== 1 || !to || to.length !== 1) continue;
				if (shell.next_shell.pillbox_source_x !== shell.pillbox_source_x ||
					shell.next_shell.pillbox_source_y !== shell.pillbox_source_y) {
					continue;
				}
				const window_steps = Math.ceil((shell.next_time - snapshot.time) /
					2) + EXPIRY_SLACK_STEPS;
				if (from[0].step + window_steps >=
					ORBIT_LENGTH.get(from[0].bradian)) continue;
				members.push({
					source: `${shell.pillbox_source_x}:${shell.pillbox_source_y}`,
					advance: to[0].step - from[0].step,
					prev_list: shell.shell_list_start,
					next_list: shell.next_shell.shell_list_start,
					next_time: shell.next_time,
				});
			}
			for (let i = 0; i < members.length; i++) {
				for (let j = i + 1; j < members.length; j++) {
					const a = members[i], b = members[j];
					if (a.source !== b.source || a.next_time !== b.next_time) continue;
					const key = (a.prev_list === b.prev_list ? "same-list" : "cross-list") +
						"/" + (a.next_list === b.next_list ? "same-list" : "cross-list");
					const diff = Math.abs(a.advance - b.advance);
					const bucket = buckets.get(key);
					bucket.set(diff, (bucket.get(diff) || 0) + 1);
					pairs++;
				}
			}
		}
	}
	return true;
}

function print_report(parsed) {
	console.log("# GENERATED - per-list sampling skew tally; nothing written to disk.");
	console.log(`files\t${parsed}`);
	console.log(`pairs\t${pairs}`);
	for (const key of BUCKET_KEYS) {
		const bucket = buckets.get(key);
		const total = [...bucket.values()].reduce((sum, n) => sum + n, 0);
		const zero = bucket.get(0) || 0;
		const histogram = [...bucket.entries()].sort((a, b) => a[0] - b[0])
			.map(([diff, n]) => `${diff}:${n}`).join(" ");
		console.log(`${key}\ttotal ${total}\tzero ${zero}\t${histogram}`);
	}
	/* One list is one snapshot by encoding, so same-list disagreement is
	 * reconstruction error by construction: the rate below is the tally's
	 * own noise floor, and cross-list rates are only evidence of genuine
	 * skew to the extent they exceed it. */
	const same = buckets.get("same-list/same-list");
	const same_total = [...same.values()].reduce((sum, n) => sum + n, 0);
	const same_zero = same.get(0) || 0;
	console.log(`error_floor\t${same_total > 0
		? ((same_total - same_zero) / same_total).toFixed(6) : "-"}`);
}

function run_worker() {
	parentPort.on("message", file => {
		for (const bucket of buckets.values()) bucket.clear();
		pairs = 0;
		const parsed = tally(file);
		parentPort.postMessage({ file, parsed, pairs,
			buckets: BUCKET_KEYS.map(key => [...buckets.get(key).entries()]) });
	});
}

function main() {
	let worker_option = null;
	const args = process.argv.slice(2).filter(arg => {
		const match = arg.match(/^--workers=(\d+)$/);
		if (match) {
			worker_option = Math.max(1, parseInt(match[1], 10));
			return false;
		}
		return true;
	});
	let files = [];
	if (args[0] === "-f") {
		files = [args[1]];
	} else {
		const root = args[0] || require("./corpus.cjs").corpus_root();
		const walk = directory => {
			for (const name of fs.readdirSync(directory)) {
				const full = path.join(directory, name);
				if (fs.statSync(full).isDirectory()) walk(full);
				else if (!SKIPPED_EXTENSIONS.test(name)) files.push(full);
			}
		};
		walk(root);
	}
	let parsed = 0;
	const worker_count = Math.min(files.length,
		worker_option || Math.max(1, Math.floor(os.cpus().length / 2)));
	if (worker_count <= 1) {
		for (const file of files) if (tally(file)) parsed++;
		print_report(parsed);
		return;
	}
	const queue = files.slice();
	let done = 0;
	let active = 0;
	for (let i = 0; i < worker_count; i++) {
		const worker = new Worker(__filename);
		const dispatch = () => {
			const file = queue.shift();
			if (file === undefined) {
				worker.terminate();
				if (active === 0 && done === files.length) print_report(parsed);
				return;
			}
			active++;
			worker.postMessage(file);
		};
		worker.on("message", result => {
			active--;
			done++;
			if (result.parsed) parsed++;
			pairs += result.pairs;
			for (let k = 0; k < BUCKET_KEYS.length; k++) {
				const bucket = buckets.get(BUCKET_KEYS[k]);
				for (const [diff, count] of result.buckets[k]) {
					bucket.set(diff, (bucket.get(diff) || 0) + count);
				}
			}
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
