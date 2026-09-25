#!/usr/bin/env node
/* How many pillbox shells can one machine have in flight at once, and how
 * often is that ceiling reached?
 *
 * Pill shells ride in the lists of the machine simulating the pill, which
 * is the pill's target [E:pill-shell-migration] [E:pill-target], and every
 * record restates every shell its sender simulates [E:shell-restate], so the
 * number a machine holds is a count over one record. The lists mix those
 * shells with the sender's own tank shells (at most four,
 * [E:tank-shell-range]), and this tool separates them with the viewer's own
 * attribution: each replay is built with BoloGame.build, and each shell of
 * each sender's snapshots is counted as a pill's, a tank's, or unlabelled
 * by BoloMotion.shell_origin. Unlabelled shells are reported alongside, so
 * a reader can see how far they could move the ceiling.
 *
 * With the ceiling in hand (CAP, checked by the histogram, not assumed by
 * it) the tool reads what happens at it:
 *
 *   - the `F4` fires carried by a sender's next record, by the number of
 *     pill shells its current record holds: does a pill still fire at a
 *     machine that is full?
 *   - runs of consecutive records at the cap, and their length in ticks
 *     from the first record at the cap to the first below it (so a ring
 *     stall stretches a run);
 *   - how many distinct pills own the shells of a record at the cap;
 *   - how many replays and client streams ever reach it.
 *
 * Usage:
 *   node tools/measure-pill-shell-cap.cjs [--workers=N] [<file or directory>]
 *       (no path: the whole corpus, via BOLO_CORPUS/corpus.json)
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const CAP = 12;
const TOP_REPLAYS = 12;
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;

function empty_metrics() {
	return {
		files: 0,
		files_failed: 0,
		records: 0,
		pill: {},              /* pill shells per record */
		pill_or_unlabelled: {},
		tank: {},
		unlabelled_shells: 0,
		labelled_shells: 0,
		next_fires: {},        /* pill shells now -> [records, F4 in the next record] */
		clients: 0,
		clients_at_cap: 0,
		files_at_cap: 0,
		records_at_cap: 0,
		records_over_cap: 0,
		records_with_pill_shells: 0,
		run_ticks: {},
		cap_sources: {},       /* distinct pills behind a record at the cap */
		replays: [],
	};
}

function bump(table, key, n = 1) {
	table[key] = (table[key] || 0) + n;
}

function analyze_file(file, engines, metrics) {
	let { log, game: game_engine, motion, replay_label } = engines;
	let parsed = log.parseLog(new Uint8Array(fs.readFileSync(file)));
	let game = game_engine.build(parsed.records);
	let replay = { file: replay_label(file), at_cap: 0, runs: 0,
		minutes: (game.t1 - game.t0) / (log.TICKS_PER_SECOND * 60) };
	for (let player = 0; player < 16; player++) {
		let snapshots = game.shell_positions[player];
		if (!snapshots.length) continue;
		metrics.clients++;
		let previous_pill = null, run_start = null, reached = false;
		for (let snapshot of snapshots) {
			let pill = 0, tank = 0, unlabelled = 0;
			let sources = new Set();
			for (let shell of snapshot.shells) {
				let origin = motion.shell_origin(shell);
				if (origin === "pillbox") {
					pill++;
					sources.add(`${shell.pillbox_source_x},${shell.pillbox_source_y}`);
				} else if (origin === "tank") {
					tank++;
				} else {
					unlabelled++;
				}
			}
			metrics.records++;
			metrics.labelled_shells += pill + tank;
			metrics.unlabelled_shells += unlabelled;
			bump(metrics.pill, pill);
			bump(metrics.pill_or_unlabelled, pill + unlabelled);
			bump(metrics.tank, tank);
			if (pill) metrics.records_with_pill_shells++;

			let fires = 0;
			for (let sub of game.records[snapshot.record_index].subpackets) {
				if (sub.type === "pillbox_fires") fires++;
			}
			if (previous_pill !== null) {
				let row = metrics.next_fires[previous_pill] ||= [0, 0];
				row[0]++;
				row[1] += fires;
			}
			previous_pill = pill;

			if (pill > CAP) metrics.records_over_cap++;
			if (pill >= CAP) {
				metrics.records_at_cap++;
				replay.at_cap++;
				reached = true;
				bump(metrics.cap_sources, sources.size);
				if (run_start === null) {
					run_start = snapshot.time;
					replay.runs++;
				}
			} else if (run_start !== null) {
				bump(metrics.run_ticks, snapshot.time - run_start);
				run_start = null;
			}
		}
		if (reached) metrics.clients_at_cap++;
	}
	if (replay.at_cap) {
		metrics.files_at_cap++;
		metrics.replays.push(replay);
	}
}

function merge_metrics(target, source) {
	for (let [key, value] of Object.entries(source)) {
		if (typeof value === "number") {
			target[key] += value;
		} else if (Array.isArray(value)) {
			target[key].push(...value);
		} else {
			for (let [item, entry] of Object.entries(value)) {
				if (Array.isArray(entry)) {
					let row = target[key][item] ||= entry.map(() => 0);
					entry.forEach((n, i) => row[i] += n);
				} else {
					bump(target[key], item, entry);
				}
			}
		}
	}
}

function histogram(table) {
	return Object.keys(table).map(Number).sort((a, b) => a - b)
		.map(key => `${key}:${table[key]}`).join(" ");
}

function quantile(table, fraction) {
	let keys = Object.keys(table).map(Number).sort((a, b) => a - b);
	let total = keys.reduce((sum, key) => sum + table[key], 0);
	let seen = 0;
	for (let key of keys) {
		seen += table[key];
		if (seen >= fraction * total) return key;
	}
	return "-";
}

function share(part, whole) {
	return whole ? `${(100 * part / whole).toFixed(3)}%` : "-";
}

function print_report(metrics) {
	let runs = Object.values(metrics.run_ticks).reduce((sum, n) => sum + n, 0);
	let run_total = Object.entries(metrics.run_ticks)
		.reduce((sum, [ticks, n]) => sum + ticks * n, 0);
	let lines = [
		"# GENERATED - pill shells one machine holds at once; nothing written to disk.",
		`files\t${metrics.files}`,
		`files_failed\t${metrics.files_failed}`,
		`records\t${metrics.records}`,
		`shells labelled / unlabelled\t${metrics.labelled_shells} / ${metrics.unlabelled_shells}`,
		`pill shells per record\t${histogram(metrics.pill)}`,
		`pill + unlabelled per record\t${histogram(metrics.pill_or_unlabelled)}`,
		`tank shells per record\t${histogram(metrics.tank)}`,
		`records over ${CAP} pill shells\t${metrics.records_over_cap}`,
		`records at ${CAP}\t${metrics.records_at_cap}\t` +
			`${share(metrics.records_at_cap, metrics.records)} of records, ` +
			`${share(metrics.records_at_cap, metrics.records_with_pill_shells)} ` +
			"of records holding any pill shell",
		`files reaching ${CAP}\t${metrics.files_at_cap} of ${metrics.files}`,
		`client streams reaching ${CAP}\t${metrics.clients_at_cap} of ${metrics.clients}`,
		"pill shells now -> records, F4 per next record",
	];
	for (let key of Object.keys(metrics.next_fires).map(Number).sort((a, b) => a - b)) {
		let [records, fires] = metrics.next_fires[key];
		lines.push(`  ${key}\t${records}\t${(fires / records).toFixed(3)}\t(${fires} fires)`);
	}
	lines.push(`runs at ${CAP}\t${runs}\tticks total ${run_total}` +
		`\tp50 ${quantile(metrics.run_ticks, 0.5)}\tp90 ${quantile(metrics.run_ticks, 0.9)}` +
		`\tp99 ${quantile(metrics.run_ticks, 0.99)}` +
		`\tmax ${Math.max(0, ...Object.keys(metrics.run_ticks).map(Number))}`);
	lines.push(`distinct pills behind a record at ${CAP}\t${histogram(metrics.cap_sources)}`);
	metrics.replays.sort((a, b) => b.at_cap - a.at_cap);
	lines.push(`replays most often at ${CAP} (records, runs, minutes)`);
	for (let replay of metrics.replays.slice(0, TOP_REPLAYS)) {
		lines.push(`  ${replay.file}\t${replay.at_cap}\t${replay.runs}\t${replay.minutes.toFixed(0)}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function load_engines() {
	return {
		log: require(path.join(ROOT, "viewer", "logparse.js")),
		game: require(path.join(ROOT, "viewer", "game.js")),
		motion: require(path.join(ROOT, "viewer", "motion.js")),
		replay_label: require(path.join(ROOT, "tools", "corpus.cjs")).replay_label,
	};
}

/* Bolo logs only: anything else in the corpus tree is skipped unread. */
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
	let entries = fs.readdirSync(item, { withFileTypes: true });
	entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	for (let entry of entries) {
		if (entry.name === ".git") continue;
		yield* walk(path.join(item, entry.name));
	}
}

function is_bolo_log(file) {
	let handle = fs.openSync(file, "r");
	try {
		let head = Buffer.alloc(4);
		return fs.readSync(handle, head, 0, 4, 0) === 4 && head.toString("latin1") === "Bolo";
	} finally {
		fs.closeSync(handle);
	}
}

function parse_args(argv) {
	let options = { target: null, workers: null };
	for (let arg of argv) {
		let workers = arg.match(/^--workers=(\d+)$/);
		if (workers) options.workers = Math.max(1, parseInt(workers[1], 10));
		else if (arg.startsWith("--")) {
			console.error(`error: unknown option ${arg}`);
			process.exit(2);
		} else if (options.target === null) options.target = path.resolve(arg);
		else {
			console.error("error: more than one path given");
			process.exit(2);
		}
	}
	if (options.target === null) {
		options.target = require(path.join(ROOT, "tools", "corpus.cjs")).corpus_root();
	}
	return options;
}

function run_worker() {
	let engines = load_engines();
	parentPort.on("message", file => {
		let metrics = empty_metrics();
		let failed = null;
		try {
			analyze_file(file, engines, metrics);
			metrics.files = 1;
		} catch (error) {
			metrics.files_failed = 1;
			failed = error.message;
		}
		parentPort.postMessage({ file, metrics, failed });
	});
}

function main() {
	let options = parse_args(process.argv.slice(2));
	let files = [...walk(options.target)].filter(is_bolo_log);
	if (!files.length) {
		console.error(`error: no replay files found at ${options.target}`);
		process.exit(2);
	}
	let totals = empty_metrics();
	let worker_count = Math.min(files.length,
		options.workers || Math.max(1, os.cpus().length));
	let queue = files.slice();
	let done = 0;

	let report_failure = (file, message) => {
		console.error(`warning: ${path.basename(file)}: ${message}`);
	};

	if (worker_count === 1) {
		let engines = load_engines();
		for (let file of files) {
			try {
				analyze_file(file, engines, totals);
				totals.files++;
			} catch (error) {
				totals.files_failed++;
				report_failure(file, error.message);
			}
		}
		print_report(totals);
		return;
	}

	for (let i = 0; i < worker_count; i++) {
		let worker = new Worker(__filename);
		let feed = () => {
			if (queue.length) worker.postMessage(queue.shift());
			else worker.terminate();
		};
		worker.on("message", ({ file, metrics, failed }) => {
			merge_metrics(totals, metrics);
			if (failed) report_failure(file, failed);
			done++;
			if (done % 50 === 0) console.error(`progress: ${done}/${files.length}`);
			if (done === files.length) print_report(totals);
			feed();
		});
		worker.on("error", error => {
			console.error(`error: worker failed: ${error.message}`);
			process.exit(1);
		});
		feed();
	}
}

if (isMainThread) main();
else run_worker();
