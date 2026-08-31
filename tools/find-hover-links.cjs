#!/usr/bin/env node
/* Locate the worst hover links so a human can watch them.
 *
 * audit-drawn-motion.cjs counts hover links -- links drawn below
 * 1 px/tick, half the true shell speed, mostly dilated joins drawn at
 * the sender's stretched clock. This tool reports WHERE they are: the
 * file, the record index (the viewer's record counter), the coordinates
 * in pixels and map tiles, the drawn speed and duration, sorted slowest
 * first.
 *
 * Usage:
 *   node tools/find-hover-links.cjs [replay-or-directory]
 *       [--workers=N] [--max-files=N] [--top=N]
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const DEFAULT_REPLAY = path.join(ROOT, "fixtures", "n20021018.2");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;

const HOVER_SPEED = 1.0;

function draw_source(shell) {
	return [
		shell.smooth_pixel_x ?? shell.pillbox_orbit_pixel_x ??
			shell.tank_exact_pixel_x ?? shell.pixel_x,
		shell.smooth_pixel_y ?? shell.pillbox_orbit_pixel_y ??
			shell.tank_exact_pixel_y ?? shell.pixel_y,
	];
}

function draw_target(shell) {
	return [
		shell.smooth_next_pixel_x ?? shell.next_pixel_x,
		shell.smooth_next_pixel_y ?? shell.next_pixel_y,
	];
}

/* The viewer's record counter is the index into the full record list.
 * Snapshots don't carry it, but every snapshot that contains shells came
 * from a record with a shell-list subpacket, so (player, time) resolves
 * against those records -- almost always uniquely. */
function build_record_index(records) {
	let map = new Map();
	for (let i = 0; i < records.length; i++) {
		let rec = records[i];
		if (!rec.subpackets || !rec.subpackets.some(s => s.type === "shells")) {
			continue;
		}
		let key = `${rec.player}:${rec.time}`;
		let list = map.get(key);
		if (!list) map.set(key, list = []);
		list.push(i);
	}
	return map;
}

function record_label(index_map, player, time) {
	let list = index_map.get(`${player}:${time}`);
	return list ? list.join("/") : "?";
}

function analyze_file(file, engines, out) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let records = [...engines.log.records(bytes)];
	let game = engines.game.build(records);
	let index_map = build_record_index(records);

	let clients = game.shell_positions || [];
	for (let player = 0; player < clients.length; player++) {
		let snapshots = clients[player];
		if (!Array.isArray(snapshots)) continue;
		for (let snapshot of snapshots) {
			for (let shell of snapshot.shells) {
				if (shell.next_time === undefined || shell.next_terminal) continue;
				let duration = shell.next_time - snapshot.time;
				if (duration <= 0) continue;
				let [source_x, source_y] = draw_source(shell);
				let [target_x, target_y] = draw_target(shell);
				let distance = Math.hypot(target_x - source_x,
					target_y - source_y);
				let speed = distance / duration;
				if (speed >= HOVER_SPEED) continue;
				out.hovers.push({
					file,
					player,
					speed,
					duration,
					distance,
					direction: shell.direction,
					from_time: snapshot.time,
					from_record: record_label(index_map, player, snapshot.time),
					at_time: shell.next_time,
					at_record: record_label(index_map, player, shell.next_time),
					source_x, source_y,
					target_x, target_y,
					stitched: shell.next_shell?.stitched === true,
					visual_join: shell.next_shell?.visual_join === true,
				});
			}
		}
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
	return {
		log: require(path.join(ROOT, "viewer", "logparse.js")),
		game: require(path.join(ROOT, "viewer", "game.js")),
	};
}

function tile(pixel) {
	return (pixel / 16).toFixed(2);
}

function print_report(hovers, files, files_failed, top, target) {
	hovers.sort((a, b) => a.speed - b.speed);
	let lines = [
		"# GENERATED - slowest hover links located; nothing written to disk.",
		`input\t${target}`,
		`files\t${files}`,
		`files_failed\t${files_failed}`,
		`hover_links\t${hovers.length}`,
	];
	for (let i = 0; i < Math.min(top, hovers.length); i++) {
		let h = hovers[i];
		lines.push("");
		lines.push(`#${i + 1}\t${h.speed.toFixed(2)} px/tick over ` +
			`${h.duration} ticks (${h.distance.toFixed(1)} px)\t` +
			`${path.relative(target, h.file).replace(/\\/g, "/") ||
				path.basename(h.file)}`);
		lines.push(`\tplayer ${h.player}, direction ${h.direction}, ` +
			`record ${h.from_record} -> record ${h.at_record} ` +
			`(tick ${h.from_time} -> ${h.at_time})`);
		lines.push(`\tfrom (${h.source_x.toFixed(1)}, ` +
			`${h.source_y.toFixed(1)}) [tile ${tile(h.source_x)}, ` +
			`${tile(h.source_y)}] to (${h.target_x.toFixed(1)}, ` +
			`${h.target_y.toFixed(1)}) [tile ${tile(h.target_x)}, ` +
			`${tile(h.target_y)}]` +
			`${h.stitched ? ", stitched" : ""}` +
			`${h.visual_join ? ", visual_join" : ""}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function parse_args(argv) {
	let options = { target: null, workers: null, max_files: Infinity, top: 10 };
	for (let arg of argv) {
		let workers = arg.match(/^--workers=(\d+)$/);
		let max_files = arg.match(/^--max-files=(\d+)$/);
		let top = arg.match(/^--top=(\d+)$/);
		if (workers) options.workers = Math.max(1, parseInt(workers[1], 10));
		else if (max_files) options.max_files = parseInt(max_files[1], 10);
		else if (top) options.top = Math.max(1, parseInt(top[1], 10));
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
		let out = { hovers: [] };
		let failed = null;
		try {
			analyze_file(file, engines, out);
		} catch (error) {
			failed = error.message;
		}
		parentPort.postMessage({ file, hovers: out.hovers, failed });
	});
}

function main() {
	let options = parse_args(process.argv.slice(2));
	let files = [...walk(options.target)].slice(0, options.max_files);
	if (!files.length) {
		console.error(`error: no replay files found at ${options.target}`);
		process.exit(2);
	}
	let hovers = [];
	let files_done = 0;
	let files_failed = 0;
	let worker_count = Math.min(files.length,
		options.workers || Math.max(1, Math.floor(os.cpus().length / 2)));
	let queue = files.slice();
	let done = 0;
	let active = 0;

	let finish = () => {
		print_report(hovers, files_done, files_failed, options.top,
			options.target);
	};

	if (worker_count === 1) {
		let engines = load_engines();
		for (let file of files) {
			try {
				let out = { hovers: [] };
				analyze_file(file, engines, out);
				hovers.push(...out.hovers);
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
				hovers.push(...result.hovers);
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
