#!/usr/bin/env node
/* Locate the worst seam jumps so a human can watch them.
 *
 * audit-drawn-motion.cjs counts seam jumps -- handoffs where a link's
 * drawn target disagrees with the successor's draw source, so the sprite
 * teleports for one frame. This tool reports WHERE they are: the file,
 * the record index (the viewer's record counter), the coordinates in
 * pixels and map tiles, and which position fields disagreed, sorted
 * worst first.
 *
 * Usage:
 *   node tools/find-seam-jumps.cjs [replay-or-directory]
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

const SEAM_TOLERANCE_PIXELS = 0.5;

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

function source_provenance(shell) {
	if (shell.smooth_pixel_x !== undefined) return "smooth";
	if (shell.pillbox_orbit_pixel_x !== undefined) return "orbit";
	if (shell.tank_exact_pixel_x !== undefined) return "tank_exact";
	return "raw";
}

function target_provenance(shell) {
	return shell.smooth_next_pixel_x !== undefined ? "smooth_next" : "next_pixel";
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
				if (!shell.next_shell) continue;
				let [target_x, target_y] = draw_target(shell);
				let successor = shell.next_shell;
				let [next_x, next_y] = draw_source(successor);
				let seam = Math.hypot(next_x - target_x, next_y - target_y);
				if (seam <= SEAM_TOLERANCE_PIXELS) continue;
				out.seams.push({
					file,
					player,
					seam,
					direction: shell.direction,
					from_time: snapshot.time,
					from_record: record_label(index_map, player, snapshot.time),
					at_time: shell.next_time,
					at_record: record_label(index_map, player, shell.next_time),
					target_x, target_y,
					source_x: next_x, source_y: next_y,
					target_from: target_provenance(shell),
					source_from: source_provenance(successor),
					visual_join: successor.visual_join === true,
					stitched: successor.stitched === true,
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

function print_report(seams, files, files_failed, top, target) {
	seams.sort((a, b) => b.seam - a.seam);
	let lines = [
		"# GENERATED - worst seam jumps located; nothing written to disk.",
		`input\t${target}`,
		`files\t${files}`,
		`files_failed\t${files_failed}`,
		`seam_jumps\t${seams.length}`,
	];
	for (let i = 0; i < Math.min(top, seams.length); i++) {
		let s = seams[i];
		lines.push("");
		lines.push(`#${i + 1}\t${s.seam.toFixed(2)} px\t` +
			`${path.relative(target, s.file).replace(/\\/g, "/") ||
				path.basename(s.file)}`);
		lines.push(`\tplayer ${s.player}, direction ${s.direction}, ` +
			`record ${s.from_record} -> record ${s.at_record} ` +
			`(tick ${s.from_time} -> ${s.at_time})`);
		lines.push(`\tlink flies to (${s.target_x.toFixed(1)}, ` +
			`${s.target_y.toFixed(1)}) [tile ${tile(s.target_x)}, ` +
			`${tile(s.target_y)}] from ${s.target_from}`);
		lines.push(`\tsuccessor drawn at (${s.source_x.toFixed(1)}, ` +
			`${s.source_y.toFixed(1)}) [tile ${tile(s.source_x)}, ` +
			`${tile(s.source_y)}] from ${s.source_from}` +
			`${s.visual_join ? ", visual_join" : ""}` +
			`${s.stitched ? ", stitched" : ""}`);
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
		let out = { seams: [] };
		let failed = null;
		try {
			analyze_file(file, engines, out);
		} catch (error) {
			failed = error.message;
		}
		parentPort.postMessage({ file, seams: out.seams, failed });
	});
}

function main() {
	let options = parse_args(process.argv.slice(2));
	let files = [...walk(options.target)].slice(0, options.max_files);
	if (!files.length) {
		console.error(`error: no replay files found at ${options.target}`);
		process.exit(2);
	}
	let seams = [];
	let files_done = 0;
	let files_failed = 0;
	let worker_count = Math.min(files.length,
		options.workers || Math.max(1, Math.floor(os.cpus().length / 2)));
	let queue = files.slice();
	let done = 0;
	let active = 0;

	let finish = () => {
		print_report(seams, files_done, files_failed, options.top,
			options.target);
	};

	if (worker_count === 1) {
		let engines = load_engines();
		for (let file of files) {
			try {
				let out = { seams: [] };
				analyze_file(file, engines, out);
				seams.push(...out.seams);
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
				seams.push(...result.seams);
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
