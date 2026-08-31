#!/usr/bin/env node
/* Do tank shells follow the same integer simulation as pillbox shells?
 *
 * Pillbox shells were proven to fly with a per-update velocity of
 * (SCALE(d,64), SCALE(d+192,64)) from the recovered truncated sine table,
 * one update per two ticks, positions rendered by >>4 — but pills only ever
 * use the odd bradians. Emulation now says tanks can shoot at all 256
 * integer bradians. If tank shells run through the same code path, every
 * chain of matched tank-shell restatements must be explainable as samples
 * of x0 + m*v for SOME bradian d, SOME sub-pixel origin x0, and per-record
 * update counts m close to elapsed_ticks/2.
 *
 * This tool extracts the matcher's non-pillbox shell chains and tests that
 * hypothesis exactly, against four velocity models:
 *
 *   recovered  (T+1)>>1 of the truncated sine table  (the pill model)
 *   round      round(64*sin)                          (control)
 *   trunc      trunc(64*sin)                          (control)
 *   halfstep   SCALE(d,32) every tick                 (cadence control)
 *
 * The controls differ from the recovered model in 58/256 velocity
 * components, so long chains discriminate between them. For each chain the
 * candidate bradians are gated to the union of both plausible
 * nibble-mappings, direction*16 + [-8..15]; which sub-range the surviving
 * unique bradians fall in then decides the real mapping (floor d>>4 vs
 * round (d+8)>>4). A subsample is also tested against all 256 bradians to
 * measure how often consistency is coincidental.
 *
 * "Slack" is per-observation jitter in the update count m against
 * floor/ceil(dt/2), covering record-time vs simulation-time skew; the
 * existing pill matcher tolerates the equivalent of slack 2 (8px).
 *
 * Usage:
 *   node tools/measure-tank-shell-bradians.cjs [replay-or-directory]
 *       [--workers=N] [--max-files=N]
 *
 * With no path the configured corpus root is used (corpus.json/BOLO_CORPUS),
 * falling back to the sample fixture. Output is key<TAB>value lines.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const DEFAULT_REPLAY = path.join(ROOT, "fixtures", "n20021018.2");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const MAX_CHAIN_OBSERVATIONS = 40;
const MAX_FAILURE_SAMPLES = 10;
const ALL_BRADIAN_SUBSAMPLE = 50;      /* every Nth chain */
const MAX_FAILURES_RETRIED_ALL = 200;  /* all-256 retries per file */

/* ---- velocity models ------------------------------------------------- */

const QUARTER_SINE = Array.from({ length: 65 }, (_, bradian) =>
	Math.trunc(128 * Math.sin(bradian * 2 * Math.PI / 256)));

function sine_value(bradian) {
	let direction = bradian & 0xff;
	let half = direction & 0x7f;
	let quarter = half <= 64 ? half : 128 - half;
	let magnitude = QUARTER_SINE[quarter];
	return direction < 128 ? magnitude : -magnitude;
}

function scale(bradian, distance) {
	return (sine_value(bradian) * distance + 64) >> 7;
}

/* Each model: velocities[d] = [vx, vy], plus the tick cadence of one
 * update. The y component is sin of the opposite angle, i.e. -cos. */
function build_models() {
	let models = {};
	for (let kind of ["recovered", "round", "trunc", "halfstep"]) {
		let velocities = [];
		for (let d = 0; d < 256; d++) {
			let opp = (d + 192) & 0xff;
			let vx, vy;
			if (kind === "recovered") {
				vx = scale(d, 64); vy = scale(opp, 64);
			} else if (kind === "halfstep") {
				vx = scale(d, 32); vy = scale(opp, 32);
			} else {
				let f = kind === "round" ? Math.round : Math.trunc;
				vx = f(64 * Math.sin(d * 2 * Math.PI / 256));
				vy = f(64 * Math.sin(opp * 2 * Math.PI / 256));
			}
			velocities.push([vx, vy]);
		}
		models[kind] = { velocities, cadence: kind === "halfstep" ? 1 : 2 };
	}
	return models;
}

const MODELS = build_models();

/* ---- the exact consistency test -------------------------------------- */

/* An observation is {t, x, y, u}: record tick, reconstructed whole-pixel
 * coordinate, and the one-sided shell-list quantisation bound (exact pixel
 * in [x, x+u]). The internal coordinate rendered as pixel e satisfies
 * 16e <= internal <= 16e+15. The first observation anchors m=0, so its
 * only effect is the candidate range of (x0, y0); each later observation
 * needs one shared update count m, inside its jitter window, putting BOTH
 * axes inside their pixel bounds. */
function chain_fits(obs, vx, vy, cadence, slack) {
	let o0 = obs[0];
	let windows = [];
	for (let i = 1; i < obs.length; i++) {
		let dt = obs[i].t - o0.t;
		let m_lo = (cadence === 1 ? dt : dt >> 1) - slack;
		let m_hi = (cadence === 1 ? dt : (dt + 1) >> 1) + slack;
		if (m_lo < 0) m_lo = 0;
		windows.push({
			m_lo, m_hi,
			x_lo: obs[i].x * 16, x_hi: (obs[i].x + obs[i].u) * 16 + 15,
			y_lo: obs[i].y * 16, y_hi: (obs[i].y + obs[i].u) * 16 + 15,
		});
	}
	let x0_hi = (o0.x + o0.u) * 16 + 15;
	let y0_hi = (o0.y + o0.u) * 16 + 15;
	for (let x0 = o0.x * 16; x0 <= x0_hi; x0++) {
		/* Feasible m per window on the x axis alone, as a bitmask. */
		let x_masks = [];
		let possible = true;
		for (let w of windows) {
			let mask = 0;
			for (let m = w.m_lo; m <= w.m_hi; m++) {
				let value = x0 + m * vx;
				if (value >= w.x_lo && value <= w.x_hi) mask |= 1 << (m - w.m_lo);
			}
			if (!mask) { possible = false; break; }
			x_masks.push(mask);
		}
		if (!possible) continue;
		for (let y0 = o0.y * 16; y0 <= y0_hi; y0++) {
			let all = true;
			for (let k = 0; k < windows.length; k++) {
				let w = windows[k];
				let found = false;
				for (let m = w.m_lo; m <= w.m_hi; m++) {
					if (!(x_masks[k] & (1 << (m - w.m_lo)))) continue;
					let value = y0 + m * vy;
					if (value >= w.y_lo && value <= w.y_hi) { found = true; break; }
				}
				if (!found) { all = false; break; }
			}
			if (all) return true;
		}
	}
	return false;
}

/* Candidate bradians for a chain: the union of the floor mapping
 * (d>>4 == nibble, offsets 0..15) and the round mapping
 * (((d+8)>>4)&15 == nibble, offsets -8..7). */
function gated_bradians(direction) {
	let list = [];
	for (let offset = -8; offset <= 15; offset++) {
		list.push({ bradian: (direction * 16 + offset) & 0xff, offset });
	}
	return list;
}

/* ---- chain extraction ------------------------------------------------ */

/* Rebuild the matcher's shell-to-shell links from what build_shell_positions
 * left behind: a non-terminal match records next_time/next_pixel on the old
 * shell and matched_from_previous on the new one. Pillbox-attributed shells
 * are excluded (they ARE the model; testing them is circular). */
function extract_chains(game_result) {
	let chains = [];
	let players = game_result.shell_positions || [];
	for (let player = 0; player < players.length; player++) {
		let snapshots = players[player];
		if (!Array.isArray(snapshots)) continue;
		let previous = null;
		let previous_chain_of = null;
		for (let snapshot of snapshots) {
			let chain_of = new Map();
			if (previous) {
				let claimed = new Set();
				for (let i = 0; i < previous.shells.length; i++) {
					let old_shell = previous.shells[i];
					if (old_shell.next_time === undefined || old_shell.next_terminal ||
						old_shell.next_time !== snapshot.time) continue;
					let chain = previous_chain_of.get(i);
					if (!chain) continue;
					for (let j = 0; j < snapshot.shells.length; j++) {
						if (claimed.has(j)) continue;
						let shell = snapshot.shells[j];
						if (!shell.matched_from_previous ||
							shell.direction !== old_shell.direction) continue;
						/* The recorded endpoint is the successor's raw pixel,
						 * or its recovered exact coordinate when the engine
						 * carries bradian tracking. */
						let raw = shell.pixel_x === old_shell.next_pixel_x &&
							shell.pixel_y === old_shell.next_pixel_y;
						let exact = shell.tank_exact_pixel_x !== undefined &&
							shell.tank_exact_pixel_x === old_shell.next_pixel_x &&
							shell.tank_exact_pixel_y === old_shell.next_pixel_y;
						if (!raw && !exact) continue;
						claimed.add(j);
						chain.pill = chain.pill || shell.pillbox_source_x !== undefined;
						if (chain.obs.length < MAX_CHAIN_OBSERVATIONS) {
							chain.obs.push({
								t: snapshot.time, x: shell.pixel_x, y: shell.pixel_y,
								u: Math.max(0, shell.position_uncertainty || 0),
							});
						}
						chain_of.set(j, chain);
						break;
					}
				}
			}
			for (let j = 0; j < snapshot.shells.length; j++) {
				if (chain_of.has(j)) continue;
				let shell = snapshot.shells[j];
				let chain = {
					player,
					direction: shell.direction,
					tank_origin: !!shell.starts_at_tank,
					pill: shell.pillbox_source_x !== undefined,
					obs: [{
						t: snapshot.time, x: shell.pixel_x, y: shell.pixel_y,
						u: Math.max(0, shell.position_uncertainty || 0),
					}],
				};
				chains.push(chain);
				chain_of.set(j, chain);
			}
			previous = snapshot;
			previous_chain_of = chain_of;
		}
	}
	return chains.filter(chain => !chain.pill);
}

/* ---- per-file analysis ----------------------------------------------- */

function empty_metrics() {
	return {
		files: 0,
		files_failed: 0,
		chains_total: 0,
		chains_len2: 0,
		chains_analyzed: 0,
		chains_tank_origin: 0,
		chains_unknown_origin: 0,

		recovered_s0: 0,
		recovered_s1: 0,
		recovered_s2: 0,
		round_s1: 0,
		trunc_s1: 0,
		halfstep_s1: 0,

		recovered_not_round: 0,
		round_not_recovered: 0,
		recovered_not_trunc: 0,
		trunc_not_recovered: 0,
		recovered_not_halfstep: 0,
		halfstep_not_recovered: 0,
		no_model_s1: 0,

		tank_origin_recovered_s1: 0,
		unknown_origin_recovered_s1: 0,

		by_length: {},               /* "len:N -> analyzed/consistent" pairs */
		candidate_count: {},         /* surviving bradians per chain, S1 */
		unique_offset: {},           /* d - 16*nibble for uniquely pinned */
		unique_even: 0,
		unique_odd: 0,
		unique_even_s0: 0,
		unique_odd_s0: 0,
		unique_offset_s0: {},
		unique_even_tank_origin: 0,
		unique_odd_tank_origin: 0,
		multi_all_even: 0,
		multi_all_odd: 0,
		multi_mixed: 0,

		subsample_chains: 0,
		subsample_outside_hits: 0,
		subsample_chains_with_outside_hit: 0,

		failures_retried_all256: 0,
		failures_recovered_all256: 0,
		recovered_outside_offset: {},

		failure_samples: [],
	};
}

function add_histogram(table, key, amount = 1) {
	table[key] = (table[key] || 0) + amount;
}

function length_bucket(count) {
	if (count <= 4) return String(count);
	if (count <= 6) return "5-6";
	if (count <= 9) return "7-9";
	return "10+";
}

function candidate_bucket(count) {
	if (count <= 4) return String(count);
	if (count <= 8) return "5-8";
	return "9+";
}

function analyze_file(file, engines, metrics) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let records = [...engines.log.records(bytes)];
	let game_result = engines.game.build(records);
	let chains = extract_chains(game_result);
	let recovered = MODELS.recovered;
	let failures_retried = 0;

	for (let index = 0; index < chains.length; index++) {
		let chain = chains[index];
		metrics.chains_total++;
		if (chain.obs.length === 2) metrics.chains_len2++;
		if (chain.obs.length < 3) continue;
		metrics.chains_analyzed++;
		if (chain.tank_origin) metrics.chains_tank_origin++;
		else metrics.chains_unknown_origin++;

		let gated = gated_bradians(chain.direction);
		let fits_s1 = [];
		for (let candidate of gated) {
			let [vx, vy] = recovered.velocities[candidate.bradian];
			if (chain_fits(chain.obs, vx, vy, recovered.cadence, 1)) {
				fits_s1.push(candidate);
			}
		}
		let ok_s1 = fits_s1.length > 0;
		/* S0 implies S1 implies S2, so only unresolved cases are retried. */
		let fits_s0 = !ok_s1 ? [] : fits_s1.filter(candidate => {
			let [vx, vy] = recovered.velocities[candidate.bradian];
			return chain_fits(chain.obs, vx, vy, recovered.cadence, 0);
		});
		let ok_s0 = fits_s0.length > 0;
		let ok_s2 = ok_s1 || gated.some(candidate => {
			let [vx, vy] = recovered.velocities[candidate.bradian];
			return chain_fits(chain.obs, vx, vy, recovered.cadence, 2);
		});
		if (ok_s0) metrics.recovered_s0++;
		if (ok_s1) metrics.recovered_s1++;
		if (ok_s2) metrics.recovered_s2++;
		if (ok_s1 && chain.tank_origin) metrics.tank_origin_recovered_s1++;
		if (ok_s1 && !chain.tank_origin) metrics.unknown_origin_recovered_s1++;

		let bucket = length_bucket(chain.obs.length);
		add_histogram(metrics.by_length, `len:${bucket}:analyzed`);
		if (ok_s1) add_histogram(metrics.by_length, `len:${bucket}:consistent`);

		let alternatives = {};
		for (let kind of ["round", "trunc", "halfstep"]) {
			let model = MODELS[kind];
			alternatives[kind] = gated.some(candidate => {
				let [vx, vy] = model.velocities[candidate.bradian];
				return chain_fits(chain.obs, vx, vy, model.cadence, 1);
			});
			if (alternatives[kind]) metrics[`${kind}_s1`]++;
		}
		if (ok_s1 && !alternatives.round) metrics.recovered_not_round++;
		if (!ok_s1 && alternatives.round) metrics.round_not_recovered++;
		if (ok_s1 && !alternatives.trunc) metrics.recovered_not_trunc++;
		if (!ok_s1 && alternatives.trunc) metrics.trunc_not_recovered++;
		if (ok_s1 && !alternatives.halfstep) metrics.recovered_not_halfstep++;
		if (!ok_s1 && alternatives.halfstep) metrics.halfstep_not_recovered++;
		let no_model = !ok_s2 && !alternatives.round && !alternatives.trunc &&
			!alternatives.halfstep;
		if (no_model) metrics.no_model_s1++;

		if (ok_s1) {
			add_histogram(metrics.candidate_count,
				candidate_bucket(fits_s1.length));
			if (fits_s1.length === 1) {
				let winner = fits_s1[0];
				add_histogram(metrics.unique_offset, String(winner.offset));
				let even = (winner.bradian & 1) === 0;
				metrics[even ? "unique_even" : "unique_odd"]++;
				if (chain.tank_origin) {
					metrics[even ? "unique_even_tank_origin"
						: "unique_odd_tank_origin"]++;
				}
			} else {
				let evens = fits_s1.filter(c => (c.bradian & 1) === 0).length;
				if (evens === fits_s1.length) metrics.multi_all_even++;
				else if (evens === 0) metrics.multi_all_odd++;
				else metrics.multi_mixed++;
			}
			/* Strictly pinned chains give the cleanest mapping and parity
			 * evidence: no jitter slack to let a neighbouring bradian in. */
			if (fits_s0.length === 1) {
				let winner = fits_s0[0];
				add_histogram(metrics.unique_offset_s0, String(winner.offset));
				metrics[(winner.bradian & 1) === 0
					? "unique_even_s0" : "unique_odd_s0"]++;
			}
		}

		/* Coincidence control: a subsample is tested against every bradian
		 * outside the gate; hits there measure accidental consistency. */
		if (index % ALL_BRADIAN_SUBSAMPLE === 0) {
			metrics.subsample_chains++;
			let gate_set = new Set(gated.map(c => c.bradian));
			let outside = 0;
			for (let d = 0; d < 256; d++) {
				if (gate_set.has(d)) continue;
				let [vx, vy] = recovered.velocities[d];
				if (chain_fits(chain.obs, vx, vy, recovered.cadence, 1)) outside++;
			}
			metrics.subsample_outside_hits += outside;
			if (outside) metrics.subsample_chains_with_outside_hit++;
		}

		/* Failed chains: does ANY bradian fit, i.e. is the gate wrong or the
		 * model? Recovered offsets say where the gate should have been. */
		if (!ok_s2 && failures_retried < MAX_FAILURES_RETRIED_ALL) {
			failures_retried++;
			metrics.failures_retried_all256++;
			let recovered_any = false;
			for (let d = 0; d < 256; d++) {
				let [vx, vy] = recovered.velocities[d];
				if (!chain_fits(chain.obs, vx, vy, recovered.cadence, 1)) continue;
				recovered_any = true;
				let offset = ((d - chain.direction * 16 + 128) & 0xff) - 128;
				add_histogram(metrics.recovered_outside_offset, String(offset));
			}
			if (recovered_any) metrics.failures_recovered_all256++;
			if (!recovered_any &&
				metrics.failure_samples.length < MAX_FAILURE_SAMPLES) {
				metrics.failure_samples.push({
					file: path.basename(file),
					player: chain.player,
					direction: chain.direction,
					tank_origin: chain.tank_origin,
					obs: chain.obs.map(o => `${o.t}:${o.x},${o.y}+${o.u}`).join(" "),
				});
			}
		}
	}
}

/* ---- orchestration --------------------------------------------------- */

function merge_metrics(target, source) {
	for (let [key, value] of Object.entries(source)) {
		if (typeof value === "number") {
			target[key] += value;
		} else if (Array.isArray(value)) {
			for (let item of value) {
				if (target[key].length < MAX_FAILURE_SAMPLES) target[key].push(item);
			}
		} else {
			for (let [item, count] of Object.entries(value)) {
				add_histogram(target[key], item, count);
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

function print_report(metrics, input) {
	let lines = [
		"# GENERATED - tank-shell bradian consistency; nothing written to disk.",
		`input\t${input}`,
	];
	let simple = [
		"files", "files_failed", "chains_total", "chains_len2",
		"chains_analyzed", "chains_tank_origin", "chains_unknown_origin",
		"recovered_s0", "recovered_s1", "recovered_s2",
		"round_s1", "trunc_s1", "halfstep_s1",
		"recovered_not_round", "round_not_recovered",
		"recovered_not_trunc", "trunc_not_recovered",
		"recovered_not_halfstep", "halfstep_not_recovered",
		"no_model_s1",
		"tank_origin_recovered_s1", "unknown_origin_recovered_s1",
		"unique_even", "unique_odd",
		"unique_even_s0", "unique_odd_s0",
		"unique_even_tank_origin", "unique_odd_tank_origin",
		"multi_all_even", "multi_all_odd", "multi_mixed",
		"subsample_chains", "subsample_outside_hits",
		"subsample_chains_with_outside_hit",
		"failures_retried_all256", "failures_recovered_all256",
	];
	for (let key of simple) lines.push(`${key}\t${metrics[key]}`);
	lines.push(`rate_recovered_s0\t${rate(metrics.recovered_s0, metrics.chains_analyzed)}`);
	lines.push(`rate_recovered_s1\t${rate(metrics.recovered_s1, metrics.chains_analyzed)}`);
	lines.push(`rate_recovered_s2\t${rate(metrics.recovered_s2, metrics.chains_analyzed)}`);
	lines.push(`rate_round_s1\t${rate(metrics.round_s1, metrics.chains_analyzed)}`);
	lines.push(`rate_trunc_s1\t${rate(metrics.trunc_s1, metrics.chains_analyzed)}`);
	lines.push(`rate_halfstep_s1\t${rate(metrics.halfstep_s1, metrics.chains_analyzed)}`);
	lines.push(`rate_tank_origin_recovered_s1\t` +
		`${rate(metrics.tank_origin_recovered_s1, metrics.chains_tank_origin)}`);
	lines.push(`rate_unknown_origin_recovered_s1\t` +
		`${rate(metrics.unknown_origin_recovered_s1, metrics.chains_unknown_origin)}`);
	for (let key of ["by_length", "candidate_count", "unique_offset",
		"unique_offset_s0", "recovered_outside_offset"]) {
		let table = metrics[key];
		let entries = Object.keys(table).sort((a, b) => {
			let na = parseFloat(a), nb = parseFloat(b);
			if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
			return a < b ? -1 : a > b ? 1 : 0;
		});
		for (let entry of entries) {
			lines.push(`${key}:${entry}\t${table[entry]}`);
		}
	}
	for (let sample of metrics.failure_samples) {
		lines.push(`# unexplained chain ${sample.file} player ${sample.player} ` +
			`direction ${sample.direction} tank_origin ${sample.tank_origin} ` +
			`obs ${sample.obs}`);
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

	let finish = () => {
		print_report(totals, path.relative(ROOT, options.target)
			.replace(/\\/g, "/") || options.target);
	};

	if (worker_count === 1) {
		let engines = load_engines();
		for (let file of files) {
			try {
				analyze_file(file, engines, totals);
				totals.files++;
			} catch (error) {
				totals.files_failed++;
				console.error(`warning: ${path.basename(file)}: ${error.message}`);
			}
			done++;
			if (done % 10 === 0) {
				console.error(`progress: ${done}/${files.length}`);
			}
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
