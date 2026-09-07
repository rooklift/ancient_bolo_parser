#!/usr/bin/env node
/* Where would two engines draw a game differently? Scenes to look at.
 *
 * The rates and the drawn-motion audit say how much changed between
 * two states of viewer/motion.js; this tool says where, so the two can
 * be compared by eye. Every replay is built twice, by the engine in
 * this checkout and by the one in --engine=DIR (a git worktree of an
 * older commit, say), and every shell observation is read for what
 * each build made of it going forward: nothing, a successor in a later
 * list, or a terminal. Where the two differ the observation is a
 * flip, of one of three kinds:
 *
 *   joined       the old engine left the shell without a story (drawn
 *                as a pop-out: the shell vanishes, and its continuation
 *                pops in later as a new one) and the new engine joins it
 *   dropped      the reverse: a story the old engine told, the new one
 *                does not
 *   retargeted   both tell a story, to different successors or fates
 *
 * Flips are clustered into scenes: a run of flips in one replay no more
 * than --window ticks apart. A scene with many flips of one kind in a
 * few seconds is the thing to watch -- a ring stall across which a whole
 * volley used to vanish and now continues, say. Scenes are ranked by
 * the count of the requested kind (--kind, default joined) and the top
 * --top are printed with everything needed to find them: the replay,
 * its record count, the record indices, the game clock as the viewer's
 * time label shows it (from the first record), the senders, the map
 * tiles the shells were on, whether a stall of the ring lies under
 * the flips, and how the new engine's links there draw (slow or
 * steady). --kind=dropped ranks the regressions instead, --kind=all
 * ranks by every flip.
 *
 * Usage:
 *   node tools/find-changed-scenes.cjs --engine=DIR [replay-or-directory]
 *       [--top=N] [--window=TICKS] [--kind=joined|dropped|retargeted|all]
 *       [--min-stall=TICKS] [--max-stall=TICKS] [--workers=N] [--max-files=N]
 *
 * --min-stall and --max-stall keep only scenes whose widest stall lies
 * in that range: --max-stall=50 asks for the one-burst hiccups inside
 * the interpolation window, where a shell used to flicker rather than
 * freeze; --min-stall=100 the freezes.
 *
 * With no path the configured corpus is read (see tools/corpus.cjs).
 * Snapshots are aligned by sender and order, which both engines build
 * the same way from one file, so the older engine need not carry the
 * record indices this checkout's snapshots do.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const { replay_label } = require("./corpus.cjs");

const ROOT = path.join(__dirname, "..");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const TICKS_PER_SECOND = 50;
const HOVER_SPEED = 1.0;
const STEADY = [1.8, 2.2];
const KINDS = ["joined", "dropped", "retargeted"];

/* ---------- reading one build ---------- */

/* Each shell's place in its client's snapshot list, and each snapshot's
 * place, so a successor can be named by (snapshot index, position)
 * under either engine. */
function index_game(game) {
	let where = new Map(), by_record = new Map();
	for (let snapshots of game.shell_positions || []) {
		if (!Array.isArray(snapshots)) continue;
		snapshots.forEach((snapshot, k) => {
			if (snapshot.record_index !== undefined) by_record.set(snapshot.record_index, snapshot);
			snapshot.shells.forEach((shell, n) => where.set(shell, { k, n, snapshot }));
		});
	}
	return { where, by_record };
}

/* What one build made of a shell, as a key the other build's reading
 * can be compared with. Terminals are named by event and end time,
 * since an older engine holds no reference to the terminal itself. */
function story(shell, where) {
	if (shell.next_time === undefined) return { key: "none", kind: "none" };
	if (shell.next_terminal) {
		return { key: `T:${shell.next_terminal_event_type || "?"}@${Math.round(shell.next_time)}`,
			kind: "terminal", event: shell.next_terminal_event_type || "?" };
	}
	if (shell.next_shell) {
		let at = where.get(shell.next_shell);
		if (at) return { key: `S:${at.k}/${at.n}`, kind: "snapshot", target: at };
	}
	return { key: `F@${Math.round(shell.next_time)}`, kind: "forward" };
}

function link_speed(shell, snapshot) {
	let duration = shell.next_time - snapshot.time;
	let tx = shell.smooth_next_pixel_x ?? shell.next_pixel_x, ty = shell.smooth_next_pixel_y ?? shell.next_pixel_y;
	let sx = shell.smooth_pixel_x ?? shell.pixel_x, sy = shell.smooth_pixel_y ?? shell.pixel_y;
	if (tx === undefined || duration <= 0) return null;
	return Math.hypot(tx - sx, ty - sy) / duration;
}

function clock(ticks) {
	let seconds = ticks / TICKS_PER_SECOND;
	let minutes = Math.floor(seconds / 60);
	return `${minutes}:${(seconds - minutes * 60).toFixed(1).padStart(4, "0")}`;
}

/* ---------- one replay under two engines ---------- */

function analyze_file(file, engines, options) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let builds = {};
	for (let name of ["old", "new"]) {
		let records = [...engines[name].log.records(bytes)];
		records.forEach((record, i) => { record.index = i; });
		builds[name] = { records, game: engines[name].game.build(records) };
	}
	let record_count = builds.new.records.length;
	let start_time = record_count ? builds.new.records[0].time : 0;
	let index = { old: index_game(builds.old.game), new: index_game(builds.new.game) };
	let flips = [];
	let old_players = builds.old.game.shell_positions || [], new_players = builds.new.game.shell_positions || [];
	for (let player = 0; player < new_players.length; player++) {
		let olds = old_players[player] || [], news = new_players[player] || [];
		if (olds.length !== news.length) {
			throw new Error(`sender ${player}: ${olds.length} snapshots under the old engine, ${news.length} under the new`);
		}
		for (let k = 0; k < news.length; k++) {
			let os_ = olds[k], ns = news[k];
			if (os_.shells.length !== ns.shells.length) {
				throw new Error(`sender ${player} snapshot ${k}: shell lists differ in length`);
			}
			for (let n = 0; n < ns.shells.length; n++) {
				let before = story(os_.shells[n], index.old.where), after = story(ns.shells[n], index.new.where);
				if (before.key === after.key) continue;
				let kind = before.kind === "none" ? "joined" : after.kind === "none" ? "dropped" : "retargeted";
				let shell = ns.shells[n];
				/* the stall under the new story: to the successor's snapshot,
				 * or to the record that reported the terminal */
				let end = after.kind === "snapshot" ? after.target.snapshot
					: after.kind === "terminal" && shell.next_terminal.record
						? index.new.by_record.get(shell.next_terminal.record.index) : null;
				let stall = end ? (end.stall_excess ?? 0) - (ns.stall_excess ?? 0) : 0;
				let speed = after.kind === "snapshot" ? link_speed(shell, ns) : null;
				flips.push({
					kind, player, k, n, record: ns.record_index, time: ns.time,
					tile: [Math.floor(shell.pixel_x / 16), Math.floor(shell.pixel_y / 16)],
					before: describe(before), after: describe(after), stall, speed,
				});
			}
		}
	}
	flips.sort((a, b) => a.time - b.time || a.record - b.record);
	/* cluster into scenes */
	let scenes = [];
	let scene = null;
	for (let flip of flips) {
		if (!scene || flip.time - scene.last > options.window) {
			scene = { file, record_count, start_time, flips: [], last: flip.time };
			scenes.push(scene);
		}
		scene.flips.push(flip);
		scene.last = flip.time;
	}
	for (let s of scenes) summarize(s, options);
	return scenes;
}

function describe(s) {
	if (s.kind === "none") return "none";
	if (s.kind === "terminal") return s.event;
	if (s.kind === "snapshot") return "successor";
	return "forward";
}

function summarize(scene, options) {
	let f = scene.flips;
	scene.counts = Object.fromEntries(KINDS.map(kind => [kind, f.filter(x => x.kind === kind).length]));
	scene.score = options.kind === "all" ? f.length : scene.counts[options.kind];
	scene.first = f[0], scene.final = f[f.length - 1];
	scene.senders = [...new Set(f.map(x => x.player))].sort((a, b) => a - b);
	scene.stall = Math.max(0, ...f.map(x => x.stall));
	let speeds = f.filter(x => x.speed !== null).map(x => x.speed);
	scene.slow = speeds.filter(v => v < HOVER_SPEED).length;
	scene.steady = speeds.filter(v => v >= STEADY[0] && v <= STEADY[1]).length;
	scene.linked = speeds.length;
	let tiles = new Map();
	for (let x of f) { let key = `${x.tile[0]},${x.tile[1]}`; tiles.set(key, (tiles.get(key) || 0) + 1); }
	scene.tiles = [...tiles].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key]) => `(${key})`);
	delete scene.last;
}

/* ---------- report ---------- */

function print_scenes(scenes, options) {
	scenes = scenes.filter(s => s.stall >= options.min_stall && s.stall <= options.max_stall);
	scenes.sort((a, b) => b.score - a.score || a.flips.length - b.flips.length || a.first.time - b.first.time);
	let shown = scenes.slice(0, options.top);
	console.log(`${scenes.length} scenes in ${options.files} replays (${options.failed} failed); ` +
		`ranked by ${options.kind === "all" ? "every flip" : options.kind + " shells"}, ${shown.length} shown`);
	for (let s of shown) {
		let c = s.counts;
		let span = s.final.record === s.first.record ? `#${s.first.record}` : `#${s.first.record}-#${s.final.record}`;
		console.log(`\n${replay_label(s.file)} (${s.record_count} records): records ${span}, ` +
			`clock ${clock(s.first.time - s.start_time)}${s.final.time !== s.first.time ? "-" + clock(s.final.time - s.start_time) : ""} ` +
			`(t=${s.first.time}), sender${s.senders.length === 1 ? "" : "s"} ${s.senders.join(",")}, tiles ${s.tiles.join(" ")}`);
		console.log(`  joined ${c.joined}, dropped ${c.dropped}, retargeted ${c.retargeted}; ` +
			(s.stall ? `a stall of ${s.stall} ticks under the flips; ` : "no stall under the flips; ") +
			`new links ${s.linked}: ${s.steady} steady, ${s.slow} slow`);
		for (let x of s.flips.slice(0, options.examples)) {
			console.log(`    ${x.kind} #${x.record} ${clock(x.time - s.start_time)} sender ${x.player} shell ${x.n} at (${x.tile[0]},${x.tile[1]}): ` +
				`${x.before} -> ${x.after}` + (x.speed !== null ? ` (${x.speed.toFixed(1)} px/tick)` : ""));
		}
		if (s.flips.length > options.examples) console.log(`    ... and ${s.flips.length - options.examples} more`);
	}
}

/* ---------- driving ---------- */

function* walk(item) {
	let stat;
	try { stat = fs.statSync(item); } catch { return; }
	if (stat.isFile()) { if (!SKIPPED_EXTENSIONS.test(item)) yield item; return; }
	let entries;
	try { entries = fs.readdirSync(item, { withFileTypes: true }); } catch { return; }
	for (let entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		yield* walk(path.join(item, entry.name));
	}
}

function load_engines(old_root) {
	let load = root => ({
		log: require(path.join(root, "viewer", "logparse.js")),
		game: require(path.join(root, "viewer", "game.js")),
	});
	return { old: load(old_root), new: load(ROOT) };
}

function parse_args(argv) {
	let options = { target: null, workers: null, max_files: Infinity, engine_root: null,
		top: 20, window: 100, kind: "joined", examples: 6, min_stall: 0, max_stall: Infinity };
	for (let arg of argv) {
		let m;
		if ((m = arg.match(/^--workers=(\d+)$/))) options.workers = Math.max(1, parseInt(m[1], 10));
		else if ((m = arg.match(/^--max-files=(\d+)$/))) options.max_files = parseInt(m[1], 10);
		else if ((m = arg.match(/^--engine=(.+)$/))) options.engine_root = path.resolve(m[1]);
		else if ((m = arg.match(/^--top=(\d+)$/))) options.top = parseInt(m[1], 10);
		else if ((m = arg.match(/^--window=(\d+)$/))) options.window = parseInt(m[1], 10);
		else if ((m = arg.match(/^--examples=(\d+)$/))) options.examples = parseInt(m[1], 10);
		else if ((m = arg.match(/^--min-stall=(\d+)$/))) options.min_stall = parseInt(m[1], 10);
		else if ((m = arg.match(/^--max-stall=(\d+)$/))) options.max_stall = parseInt(m[1], 10);
		else if ((m = arg.match(/^--kind=(joined|dropped|retargeted|all)$/))) options.kind = m[1];
		else if (arg.startsWith("--")) { console.error(`error: unknown option ${arg}`); process.exit(2); }
		else if (options.target === null) options.target = path.resolve(arg);
		else { console.error("error: more than one path given"); process.exit(2); }
	}
	if (!options.engine_root) {
		console.error("error: --engine=DIR names the older checkout to compare against (a git worktree, say)");
		process.exit(2);
	}
	if (!fs.existsSync(path.join(options.engine_root, "viewer", "motion.js"))) {
		console.error(`error: no viewer/motion.js under ${options.engine_root}`);
		process.exit(2);
	}
	if (options.target === null) {
		let corpus = null;
		try { corpus = require(path.join(ROOT, "tools", "corpus.cjs")).resolve_corpus_root(); } catch { corpus = null; }
		if (!corpus || !fs.existsSync(corpus)) {
			console.error("error: no replay given and no corpus configured (see tools/corpus.cjs)");
			process.exit(2);
		}
		options.target = corpus;
	}
	return options;
}

function run_worker() {
	let engines = load_engines(workerData.engine_root);
	parentPort.on("message", file => {
		try {
			parentPort.postMessage({ file, scenes: analyze_file(file, engines, workerData.options) });
		} catch (error) {
			parentPort.postMessage({ file, scenes: [], failed: error.message });
		}
	});
}

function main() {
	let options = parse_args(process.argv.slice(2));
	let files = [...walk(options.target)].slice(0, options.max_files);
	if (!files.length) { console.error(`error: no replay files found at ${options.target}`); process.exit(2); }
	let scenes = [];
	options.files = 0;
	options.failed = 0;
	let worker_count = Math.min(files.length, options.workers || Math.max(1, Math.floor(os.cpus().length / 2)));
	let done = 0;
	let note = result => {
		done++;
		if (result.failed) { options.failed++; console.error(`warning: ${path.basename(result.file)}: ${result.failed}`); }
		else options.files++;
		scenes.push(...result.scenes);
		if (done % 10 === 0) console.error(`progress: ${done}/${files.length}`);
	};
	if (worker_count === 1) {
		let engines = load_engines(options.engine_root);
		for (let file of files) {
			try { note({ file, scenes: analyze_file(file, engines, options) }); }
			catch (error) { note({ file, scenes: [], failed: error.message }); }
		}
		print_scenes(scenes, options);
		return;
	}
	let queue = files.slice();
	let active = 0;
	for (let i = 0; i < worker_count; i++) {
		let worker = new Worker(__filename, { workerData: { engine_root: options.engine_root, options } });
		let dispatch = () => {
			let file = queue.shift();
			if (file === undefined) {
				worker.terminate();
				if (active === 0 && done === files.length) print_scenes(scenes, options);
				return;
			}
			active++;
			worker.postMessage(file);
		};
		worker.on("message", result => { active--; note(result); dispatch(); });
		worker.on("error", error => { console.error(`error: worker failed: ${error.message}`); process.exit(1); });
		dispatch();
	}
}

if (isMainThread) main(); else run_worker();
