#!/usr/bin/env node
/* Audit the DRAWN shell motion, not the match rates.
 *
 * The match-rate report counts explanations; it cannot see that a chain
 * draws a shell hovering for seventeen ticks and then rocketing, or that
 * an unlinked identity renders as a sprite vanishing and reappearing
 * behind itself. This tool measures what the renderer will actually do.
 *
 * Every discontinuity the shell renderer can produce happens at a record
 * boundary, and between boundaries each drawn shell moves linearly from
 * its draw source to its link target. So the drawn output is fully
 * characterised by the link structure the engine built:
 *
 *   - the SPEED of every drawn link (a perfect engine draws every link at
 *     2 px/tick; hovers and rushes are the jitter artifacts);
 *   - SEAM JUMPS: a link's target must equal its successor's draw source,
 *     or the sprite visibly jumps at the handoff (should be exactly zero);
 *   - POPS: shells with no forward link vanish, origin-less shells
 *     appear. A pop-in near a same-direction pop-out is one identity the
 *     engine failed to link, drawn as vanish-and-reappear; when the
 *     reappearance is BEHIND the vanish point, the eye sees a shell move
 *     backwards.
 *
 * Older engine states lack the smoothing and chain fields; every lookup
 * falls back, so the tool runs unchanged against historical checkouts
 * for calibration.
 *
 * Usage:
 *   node tools/audit-drawn-motion.cjs [replay-or-directory]
 *       [--workers=N] [--max-files=N] [--describe-backwards]
 *
 * --describe-backwards appends diagnostic lines for the backwards-pop
 * class: a tally of every backwards-paired pop by the state-flag
 * signature of the two shells involved (backwards_class lines), and a
 * few example events per file (backwards_example lines). Without the
 * flag the output is byte-identical to before the flag existed.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const DEFAULT_REPLAY = path.join(ROOT, "fixtures", "n20021018.2");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp)$/i;

const HOVER_SPEED = 1.0;
const RUSH_SPEED = 3.0;
const SEAM_TOLERANCE_PIXELS = 0.5;
const POP_PAIR_LATERAL_PIXELS = 12;
const POP_PAIR_SLACK_PIXELS = 16;
const BACKWARDS_TOLERANCE_PIXELS = 1;

const SPEED_BUCKETS = [
	[0.0, "0.0-0.5"], [0.5, "0.5-1.0"], [1.0, "1.0-1.5"], [1.5, "1.5-1.8"],
	[1.8, "1.8-2.2"], [2.2, "2.2-2.5"], [2.5, "2.5-3.0"], [3.0, "3.0+"],
];

function speed_bucket(speed) {
	for (let i = SPEED_BUCKETS.length - 1; i >= 0; i--) {
		if (speed >= SPEED_BUCKETS[i][0]) return SPEED_BUCKETS[i][1];
	}
	return SPEED_BUCKETS[0][1];
}

function draw_source(shell) {
	return [
		shell.smooth_pixel_x ?? shell.pillbox_orbit_pixel_x ??
			shell.tank_exact_pixel_x ?? shell.pixel_x,
		shell.smooth_pixel_y ?? shell.pillbox_orbit_pixel_y ??
			shell.tank_exact_pixel_y ?? shell.pixel_y,
	];
}

/* Compact state signature of one shell observation, for classifying pop
 * pairs: m matched_from_previous, s stitched, v visually joined (either
 * end), B/T pillbox/tank birth, P pillbox source known, k tank bradian
 * states, U unseen-shot birth claimed from orbit membership, R refused
 * by absorption as ambiguous, C ruled out by some
 * stitch's orbits, q chained list member. "-" when none apply (also the
 * shape older engine states produce). */
function shell_flags(shell) {
	let flags = "";
	if (shell.matched_from_previous) flags += "m";
	if (shell.stitched) flags += "s";
	if (shell.visual_join || shell.visual_join_source) flags += "v";
	if (shell.starts_at_pillbox) flags += "B";
	if (shell.unseen_pillbox_shot) flags += "U";
	if (shell.starts_at_tank) flags += "T";
	if (shell.pillbox_source_x !== undefined) flags += "P";
	if (shell.tank_bradian_states) flags += "k";
	if (shell.absorption_refused) flags += "R";
	if (shell.absorption_contradicted) flags += "C";
	if (shell.position_uncertainty > 0) flags += "q";
	return flags || "-";
}

function draw_target(shell) {
	return [
		shell.smooth_next_pixel_x ?? shell.next_pixel_x,
		shell.smooth_next_pixel_y ?? shell.next_pixel_y,
	];
}

function empty_metrics() {
	return {
		files: 0,
		files_failed: 0,
		build_ms: 0,
		audit_ms: 0,
		shell_observations: 0,
		links: 0,
		terminal_links: 0,
		terminal_links_rushed: 0,
		hover_links: 0,
		rush_links: 0,
		seam_jumps: 0,
		seam_jump_max: 0,
		pop_outs: 0,
		pop_ins: 0,
		backwards_classes: {},
		pops_paired_forward: 0,
		pops_paired_backwards: 0,
		link_speeds: {},
	};
}

const EXAMPLES_PER_FILE = 3;

function analyze_file(file, engines, metrics, examples = null) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let build_start = Date.now();
	let records = [...engines.log.records(bytes)];
	let game = engines.game.build(records);
	metrics.build_ms += Date.now() - build_start;
	let audit_start = Date.now();

	for (let snapshots of game.shell_positions || []) {
		if (!Array.isArray(snapshots)) continue;
		let previous_pop_outs = [];
		let previous_time = null;
		for (let index = 0; index < snapshots.length; index++) {
			let snapshot = snapshots[index];
			let final = index === snapshots.length - 1;
			let pop_outs = [];
			for (let shell of snapshot.shells) {
				metrics.shell_observations++;
				let [source_x, source_y] = draw_source(shell);

				if (shell.next_time !== undefined) {
					let duration = shell.next_time - snapshot.time;
					let [target_x, target_y] = draw_target(shell);
					let distance = Math.hypot(target_x - source_x,
						target_y - source_y);
					let speed = duration > 0 ? distance / duration : Infinity;
					if (shell.next_terminal) {
						metrics.terminal_links++;
						if (speed > RUSH_SPEED) metrics.terminal_links_rushed++;
					} else {
						metrics.links++;
						let bucket = speed_bucket(speed);
						metrics.link_speeds[bucket] =
							(metrics.link_speeds[bucket] || 0) + 1;
						if (speed < HOVER_SPEED) metrics.hover_links++;
						if (speed > RUSH_SPEED) metrics.rush_links++;
						/* The handoff invariant: the link's target must be the
						 * successor's draw source, or the sprite jumps. Old
						 * engine states do not record next_shell; skip there. */
						if (shell.next_shell) {
							let [next_x, next_y] = draw_source(shell.next_shell);
							let seam = Math.hypot(next_x - target_x,
								next_y - target_y);
							if (seam > SEAM_TOLERANCE_PIXELS) {
								metrics.seam_jumps++;
								if (seam > metrics.seam_jump_max) {
									metrics.seam_jump_max = seam;
								}
							}
						}
					}
				} else if (!final) {
					metrics.pop_outs++;
					pop_outs.push({
						x: source_x, y: source_y, direction: shell.direction,
						shell,
					});
				}

				/* A pop-in: an appearance with no predecessor and no known
				 * birth. Pair it against the previous record's pop-outs of
				 * the same direction to classify the visual event. */
				if (index > 0 && !shell.matched_from_previous &&
					!shell.starts_at_tank && !shell.starts_at_pillbox) {
					metrics.pop_ins++;
					if (previous_time !== null) {
						let dt = snapshot.time - previous_time;
						let angle = shell.direction * Math.PI / 8;
						let heading_x = Math.sin(angle);
						let heading_y = -Math.cos(angle);
						let best = null;
						for (let out of previous_pop_outs) {
							if (out.direction !== shell.direction) continue;
							let delta_x = source_x - out.x;
							let delta_y = source_y - out.y;
							let along = delta_x * heading_x + delta_y * heading_y;
							let lateral = Math.abs(delta_x * heading_y -
								delta_y * heading_x);
							if (lateral > POP_PAIR_LATERAL_PIXELS) continue;
							if (along > dt * 2 + POP_PAIR_SLACK_PIXELS) continue;
							if (!best || Math.abs(along) < Math.abs(best.along)) {
								best = { along, lateral, out };
							}
						}
						if (best) {
							if (best.along < -BACKWARDS_TOLERANCE_PIXELS) {
								metrics.pops_paired_backwards++;
								let signature = shell_flags(best.out.shell) +
									">" + shell_flags(shell);
								metrics.backwards_classes[signature] =
									(metrics.backwards_classes[signature] || 0) + 1;
								if (examples && examples.length < EXAMPLES_PER_FILE) {
									examples.push({
										file: path.basename(file),
										time: snapshot.time,
										direction: shell.direction,
										dt,
										along: +best.along.toFixed(2),
										lateral: +best.lateral.toFixed(2),
										out: [best.out.x, best.out.y,
											shell_flags(best.out.shell)],
										in: [source_x, source_y, shell_flags(shell)],
									});
								}
							} else {
								metrics.pops_paired_forward++;
							}
						}
					}
				}
			}
			previous_pop_outs = pop_outs;
			previous_time = snapshot.time;
		}
	}
	metrics.audit_ms += Date.now() - audit_start;
}

/* ---- orchestration (the usual worker-pool pattern) ------------------- */

function merge_metrics(target, source) {
	for (let [key, value] of Object.entries(source)) {
		if (key === "seam_jump_max") {
			target[key] = Math.max(target[key], value);
		} else if (typeof value === "number") {
			target[key] += value;
		} else {
			for (let [item, count] of Object.entries(value)) {
				target[key][item] = (target[key][item] || 0) + count;
			}
		}
	}
}

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

function rate(part, whole) {
	return whole ? (part / whole).toFixed(6) : "-";
}


/* The commit the measuring engine was built from, for output provenance:
 * short hash, "-dirty" appended when tracked files carry uncommitted
 * changes (untracked files are ignored -- report outputs and corpus.json
 * live beside the tree), "unknown" outside a git checkout. Duplicated in
 * report-interpolation-rates.cjs so each tool stays a single file
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

function print_report(metrics, input) {
	let lines = [
		"# GENERATED - drawn shell motion audit; nothing written to disk.",
		`commit\t${repo_commit()}`,
		`input\t${input}`,
	];
	for (let key of ["files", "files_failed", "build_ms", "audit_ms",
		"shell_observations", "links", "terminal_links",
		"terminal_links_rushed", "hover_links", "rush_links",
		"seam_jumps", "pop_outs", "pop_ins",
		"pops_paired_forward", "pops_paired_backwards"]) {
		lines.push(`${key}\t${metrics[key]}`);
	}
	lines.push(`seam_jump_max\t${metrics.seam_jump_max.toFixed(2)}`);
	for (let [, bucket] of SPEED_BUCKETS) {
		lines.push(`link_speed:${bucket}\t${metrics.link_speeds[bucket] || 0}`);
	}
	lines.push(`rate_links_steady\t` +
		`${rate(metrics.link_speeds["1.8-2.2"] || 0, metrics.links)}`);
	lines.push(`rate_hover_links\t${rate(metrics.hover_links, metrics.links)}`);
	lines.push(`rate_rush_links\t${rate(metrics.rush_links, metrics.links)}`);
	lines.push(`rate_pop_outs\t` +
		`${rate(metrics.pop_outs, metrics.shell_observations)}`);
	lines.push(`rate_backwards_pops\t` +
		`${rate(metrics.pops_paired_backwards, metrics.shell_observations)}`);
	process.stdout.write(`${lines.join("\n")}\n`);
}

function parse_args(argv) {
	let options = { target: null, workers: null, max_files: Infinity,
		describe_backwards: false };
	for (let arg of argv) {
		let workers = arg.match(/^--workers=(\d+)$/);
		let max_files = arg.match(/^--max-files=(\d+)$/);
		if (workers) options.workers = Math.max(1, parseInt(workers[1], 10));
		else if (max_files) options.max_files = parseInt(max_files[1], 10);
		else if (arg === "--describe-backwards") options.describe_backwards = true;
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
		let metrics = empty_metrics();
		let examples = [];
		let failed = null;
		try {
			analyze_file(file, engines, metrics, examples);
			metrics.files = 1;
		} catch (error) {
			metrics.files_failed = 1;
			failed = error.message;
		}
		parentPort.postMessage({ file, metrics, failed, examples });
	});
}

function main() {
	let options = parse_args(process.argv.slice(2));
	let files = [...walk(options.target)].slice(0, options.max_files);
	if (!files.length) {
		console.error(`error: no replay files found at ${options.target}`);
		process.exit(2);
	}
	let totals = empty_metrics();
	let worker_count = Math.min(files.length,
		options.workers || Math.max(1, Math.floor(os.cpus().length / 2)));
	let queue = files.slice();
	let done = 0;
	let active = 0;

	let all_examples = [];

	let finish = () => {
		print_report(totals, path.relative(ROOT, options.target)
			.replace(/\\/g, "/") || options.target);
		if (!options.describe_backwards) return;
		let classes = Object.entries(totals.backwards_classes)
			.sort((a, b) => b[1] - a[1]);
		for (let [signature, count] of classes) {
			console.log(`backwards_class\t${signature}\t${count}`);
		}
		for (let example of all_examples) {
			console.log(`backwards_example\t${example.file}` +
				`\tt=${example.time}\tdir=${example.direction}` +
				`\tdt=${example.dt}\talong=${example.along}` +
				`\tlateral=${example.lateral}` +
				`\tout=(${example.out[0]},${example.out[1]})${example.out[2]}` +
				`\tin=(${example.in[0]},${example.in[1]})${example.in[2]}`);
		}
	};

	if (worker_count === 1) {
		let engines = load_engines();
		for (let file of files) {
			try {
				analyze_file(file, engines, totals, all_examples);
				totals.files++;
			} catch (error) {
				totals.files_failed++;
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
			merge_metrics(totals, result.metrics);
			if (result.examples) all_examples.push(...result.examples);
			if (result.failed) {
				console.error(`warning: ${path.basename(result.file)}: ${result.failed}`);
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
