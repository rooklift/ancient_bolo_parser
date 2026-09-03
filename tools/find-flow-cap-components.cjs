#!/usr/bin/env node
/* Locate the residual-flow components that hit the pathological cap.
 *
 * report-interpolation-rates.cjs counts flow_components_over_cap -- the
 * components forced_bipartite_assignments in viewer/motion.js refuses
 * to solve because they exceed its edge cap, leaving their shells and
 * fates unresolved. This tool reports WHERE they are: the file, the
 * component's edge count, its tick span, and the record-index span the
 * ticks cover (the viewer's record counter), so a human can open the
 * scene.
 *
 * Usage:
 *   node tools/find-flow-cap-components.cjs [replay-or-directory]
 *       [--workers=N] [--max-files=N]
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { replay_label } = require("./corpus.cjs");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const DEFAULT_REPLAY = path.join(ROOT, "fixtures", "n20021018.2");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;

/* The record counter is the index into the full record list; a capped
 * component only knows its tick span, so report the indices of the
 * records inside that span. */
function record_span(records, min_time, max_time) {
	if (min_time === undefined) return { first: null, last: null };
	let first = null;
	let last = null;
	for (let i = 0; i < records.length; i++) {
		let time = records[i].time;
		if (time === undefined || time < min_time || time > max_time) continue;
		if (first === null) first = i;
		last = i;
	}
	return { first, last };
}

function analyze_file(file, engines, out) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let records = [...engines.log.records(bytes)];
	engines.motion.reset_flow_component_stats();
	engines.game.build(records);
	for (let detail of engines.motion.flow_component_stats().over_cap_details) {
		let { first, last } = record_span(records, detail.min_time,
			detail.max_time);
		out.capped.push({
			file,
			edges: detail.edges,
			min_time: detail.min_time,
			max_time: detail.max_time,
			first_record: first,
			last_record: last,
			records_total: records.length,
		});
	}
}

/* ---- orchestration (the usual worker-pool pattern) ------------------- */

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
	for (let entry of entries) yield* walk(path.join(item, entry.name));
}

function load_engines() {
	let engines = {
		log: require(path.join(ROOT, "viewer", "logparse.js")),
		game: require(path.join(ROOT, "viewer", "game.js")),
		motion: require(path.join(ROOT, "viewer", "motion.js")),
	};
	if (typeof engines.motion.reset_flow_component_stats !== "function" ||
		typeof engines.motion.flow_component_stats !== "function") {
		console.error("error: this repo state's viewer/motion.js does not " +
			"expose flow component stats");
		process.exit(3);
	}
	return engines;
}

/* The corpus directory is private and may embed a player's handle (see
 * corpus.json), so it is never written to a report verbatim -- hash it
 * instead. Duplicated in audit-drawn-motion.cjs, report-interpolation-rates.cjs,
 * find-seam-jumps.cjs, find-hover-links.cjs, probe-shot-fate-parsimony.cjs,
 * and measure-tank-shell-bradians.cjs for the same single-file reason as
 * repo_commit (see audit-drawn-motion.cjs). */
function hash_input(target) {
	const { createHash } = require("node:crypto");
	return `sha256:${createHash("sha256")
		.update(path.resolve(target)).digest("hex")}`;
}

function print_report(capped, files, files_failed, target) {
	capped.sort((a, b) => b.edges - a.edges);
	let lines = [
		"# GENERATED - over-cap flow components located; nothing written to disk.",
		`input\t${hash_input(target)}`,
		`files\t${files}`,
		`files_failed\t${files_failed}`,
		`components_over_cap\t${capped.length}`,
	];
	for (let i = 0; i < capped.length; i++) {
		let c = capped[i];
		lines.push("");
		lines.push(`#${i + 1}\t${c.edges} edges\t` +
			`${replay_label(c.file)}`);
		lines.push(`\tticks ${c.min_time ?? "?"}-${c.max_time ?? "?"}, ` +
			`records #${c.first_record ?? "?"}-#${c.last_record ?? "?"} ` +
			`of ${c.records_total}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function parse_args(argv) {
	let options = { target: null, workers: null, max_files: Infinity };
	for (let arg of argv) {
		let workers = arg.match(/^--workers=(\d+)$/);
		let max_files = arg.match(/^--max-files=(\d+)$/);
		if (workers) options.workers = Math.max(1, parseInt(workers[1], 10));
		else if (max_files) options.max_files = parseInt(max_files[1], 10);
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
		let corpus = null;
		try {
			corpus = require(path.join(ROOT, "tools", "corpus.cjs"))
				.resolve_corpus_root();
		} catch {
			corpus = null;
		}
		options.target = corpus && fs.existsSync(corpus) ? corpus : DEFAULT_REPLAY;
	}
	return options;
}

function run_worker() {
	let engines = load_engines();
	parentPort.on("message", file => {
		let out = { capped: [] };
		let failed = null;
		try {
			analyze_file(file, engines, out);
		} catch (error) {
			failed = error.message;
		}
		parentPort.postMessage({ file, capped: out.capped, failed });
	});
}

function main() {
	let options = parse_args(process.argv.slice(2));
	let files = [...walk(options.target)].slice(0, options.max_files);
	if (!files.length) {
		console.error(`error: no replay files found at ${options.target}`);
		process.exit(2);
	}
	let capped = [];
	let files_done = 0;
	let files_failed = 0;
	let worker_count = Math.min(files.length,
		options.workers || Math.max(1, Math.floor(os.cpus().length / 2)));
	let queue = files.slice();
	let done = 0;
	let active = 0;

	let finish = () => {
		print_report(capped, files_done, files_failed, options.target);
	};

	if (worker_count === 1) {
		let engines = load_engines();
		for (let file of files) {
			try {
				let out = { capped: [] };
				analyze_file(file, engines, out);
				capped.push(...out.capped);
				files_done++;
			} catch (error) {
				files_failed++;
				console.error(`warning: ${path.basename(file)}: ${error.message}`);
			}
			done++;
			if (done % 10 === 0) console.error(`progress: ${done}/${files.length}`);
		}
		finish();
		return;
	}

	for (let i = 0; i < worker_count; i++) {
		let worker = new Worker(__filename);
		let dispatch = () => {
			let file = queue.shift();
			if (file === undefined) {
				worker.terminate();
				if (active === 0 && done === files.length) finish();
				return;
			}
			active++;
			worker.postMessage(file);
		};
		worker.on("message", result => {
			active--;
			done++;
			if (result.failed) {
				files_failed++;
				console.error(`warning: ${path.basename(result.file)}: ` +
					`${result.failed}`);
			} else {
				files_done++;
				capped.push(...result.capped);
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
