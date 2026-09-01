#!/usr/bin/env node
/* Does the network-conditions verdict agree with what the motion code
 * actually managed to interpolate?
 *
 * The two read completely different things.  The verdict
 * (viewer/network.js) never looks at game content: it reads packet
 * sequence steps and arrival gaps.  The interpolation pipeline
 * (viewer/motion.js) never looks at sequence numbers: it succeeds or
 * fails on whether shell observations chain into stories and position
 * tracks bridge without breaks.  If the verdict measures anything real,
 * a log it calls "awful" should be one where the pipeline visibly
 * struggled -- more shells with no forward match, more terminals nothing
 * accounts for, more track segments too broken or too long-gapped to
 * bridge.  If the two do not track each other, one of them is wrong.
 *
 * For each log the script takes the shipped verdict, then reads the
 * pipeline's success rates over the SAME settled span the verdict was
 * read from (the gathering ramp would confound both sides the same way,
 * which is agreement of the spurious kind):
 *
 *   -- shell match rate: shells with a forward story, out of those that
 *      could have one (a track's final snapshot is excluded -- there is
 *      nothing after it to match to);
 *   -- terminal match rate: impacts and explosions some shell accounts
 *      for;
 *   -- tank bridge rate: track segments the motion code interpolates,
 *      i.e. neither marked discontinuous nor gapped past the limit.
 *
 * It reports, over a corpus: the correlation of each network signal
 * against each pipeline failure rate (Pearson and Spearman -- the
 * distributions are skewed, so ranks are the honest headline); the
 * pipeline medians inside each verdict band, which is the table a human
 * should sanity-check ("awful" games ought to read worse down every
 * column); a walk up the loss range; and the most discordant logs both
 * ways -- rated well but interpolating badly, and the reverse -- since
 * those are where either detector's next bug is hiding.
 *
 * Usage: node tools/measure-network-agreement.cjs [corpus-root]
 *        (--workers=N; default half the machine's cores)
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const MIN_RECORDS = 2000;   /* below this a log says too little to score */
const MIN_TICKS = 3000;     /* and likewise below a minute of play */
const MIN_SHELLS = 100;     /* rates over fewer shells are mostly noise */
const MIN_SEGMENTS = 100;   /* likewise for track segments */

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	for (let entry of entries) {
		let item = path.join(dir, entry.name);
		if (entry.isDirectory())
			yield* walk(item);
		else if (entry.isFile() && !SKIPPED_EXTENSIONS.test(entry.name))
			yield item;
	}
}

/* ---------- per-log measurement (runs in workers) ---------- */

function measure_file(engines, file) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	if (bytes.length < 200) return null;
	if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "Bolo") {
		return null;
	}
	let recs = [];
	try {
		for (let rec of engines.log.records(bytes)) recs.push(rec);
	} catch { /* keep whatever decoded before the damage */ }
	if (recs.length < MIN_RECORDS) return null;
	if (recs[recs.length - 1].time - recs[0].time < MIN_TICKS) return null;

	let net = engines.net.network_conditions(recs);
	if (!net) return null;

	let game = engines.game.build(recs);
	let in_span = time => time >= net.from && time <= net.to;

	/* Shells and terminals, counted only inside the verdict's span.  A
	 * shell in its track's final snapshot has nothing ahead of it to
	 * match, so it is no evidence of failure and stays out of the
	 * denominator, exactly as report-interpolation-rates.cjs excludes it. */
	let shells = 0, shells_matched = 0, terminals = 0, terminals_matched = 0;
	for (let snapshots of game.shell_positions || []) {
		if (!Array.isArray(snapshots)) continue;
		for (let index = 0; index < snapshots.length; index++) {
			let snapshot = snapshots[index];
			if (!in_span(snapshot.time)) continue;
			let final = index === snapshots.length - 1;
			for (let shell of snapshot.shells || []) {
				if (!final) {
					shells++;
					if (shell.next_time !== undefined) shells_matched++;
				}
			}
			for (let terminal of snapshot.terminals || []) {
				terminals++;
				if (terminal.match_time !== undefined) terminals_matched++;
			}
		}
	}

	/* Tank tracks: a segment counts when both endpoints sit in the span;
	 * it is bridged when the later point continues the earlier one and
	 * the gap is short enough for the motion code, the same test
	 * report-interpolation-rates.cjs applies. */
	let max_ticks = engines.game.MAX_POSITION_INTERPOLATION_TICKS;
	let segments = 0, bridged = 0;
	for (let track of game.tank_positions || []) {
		if (!Array.isArray(track)) continue;
		for (let i = 0; i + 1 < track.length; i++) {
			if (!in_span(track[i].time) || !in_span(track[i + 1].time)) continue;
			let duration = track[i + 1].time - track[i].time;
			if (!(duration > 0)) continue;
			segments++;
			if (track[i + 1].continuous &&
				!(max_ticks !== undefined && duration > max_ticks)) {
				bridged++;
			}
		}
	}

	if (shells < MIN_SHELLS || segments < MIN_SEGMENTS) return null;
	return {
		rating: net.rating, loss: net.loss, stall: net.stall,
		shell_unmatched: 100 * (shells - shells_matched) / shells,
		terminal_unmatched: terminals
			? 100 * (terminals - terminals_matched) / terminals : null,
		tank_unbridged: 100 * (segments - bridged) / segments,
		shells, terminals, segments,
		players: new Set(recs.map(r => r.player)).size,
	};
}

function load_engines() {
	return {
		log: require(path.join(ROOT, "viewer", "logparse.js")),
		game: require(path.join(ROOT, "viewer", "game.js")),
		net: require(path.join(ROOT, "viewer", "network.js")),
	};
}

/* ---------- statistics ---------- */

function quantile(sorted, p) {
	return sorted[Math.floor(p * (sorted.length - 1))];
}

function median(values) {
	let v = values.slice().sort((a, b) => a - b);
	return quantile(v, 0.5);
}

function pearson(xs, ys) {
	let n = xs.length;
	let mx = xs.reduce((a, b) => a + b, 0) / n;
	let my = ys.reduce((a, b) => a + b, 0) / n;
	let sxy = 0, sxx = 0, syy = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
		syy += (ys[i] - my) ** 2;
	}
	return sxy / Math.sqrt(sxx * syy);
}

/* ranks with ties averaged, so Spearman is Pearson over these */
function ranks(values) {
	let order = values.map((value, index) => [value, index])
		.sort((a, b) => a[0] - b[0]);
	let out = new Array(values.length);
	for (let i = 0; i < order.length;) {
		let j = i;
		while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
		let rank = (i + j) / 2;
		for (let k = i; k <= j; k++) out[order[k][1]] = rank;
		i = j + 1;
	}
	return out;
}

function spearman(xs, ys) {
	return pearson(ranks(xs), ranks(ys));
}

/* ---------- the pool ---------- */

function run_worker() {
	let engines = load_engines();
	parentPort.on("message", file => {
		let row = null, failed = null;
		try {
			row = measure_file(engines, file);
		} catch (error) {
			failed = error.message;
		}
		parentPort.postMessage({ file, row, failed });
	});
}

function main() {
	let workers = null;
	let args = process.argv.slice(2).filter(arg => {
		let match = arg.match(/^--workers=(\d+)$/);
		if (match) {
			workers = Math.max(1, parseInt(match[1], 10));
			return false;
		}
		return true;
	});
	let corpus = args[0] || require("./corpus.cjs").corpus_root();
	let files = [...walk(corpus)];
	if (!files.length) {
		console.error(`error: no files under ${corpus}`);
		process.exit(2);
	}

	let rows = [];
	let done = 0;
	let finish = () => report(rows, corpus);

	let worker_count = Math.min(files.length,
		workers || Math.max(1, Math.floor(os.cpus().length / 2)));
	let queue = files.slice();
	let active = 0;
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
				console.error(`warning: ` +
					`${path.relative(corpus, result.file)}: ${result.failed}`);
			}
			if (result.row) {
				result.row.file = path.relative(corpus, result.file);
				rows.push(result.row);
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

/* ---------- the report ---------- */

function report(rows, corpus) {
	if (rows.length === 0) {
		console.log(`no scoreable logs under ${corpus}`);
		process.exit(1);
	}
	/* worker completion order is nondeterministic; the stats are not
	 * order-sensitive but the printed examples should be */
	rows.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);

	console.log(`${rows.length} logs scored under ${corpus}\n`);

	const FAILURES = [
		["shell unmatched %", row => row.shell_unmatched],
		["terminal unmatched %", row => row.terminal_unmatched],
		["tank unbridged %", row => row.tank_unbridged],
	];
	const SIGNALS = [
		["loss", row => row.loss],
		["stall", row => row.stall],
	];

	console.log("network signal vs pipeline failure rate, across logs:");
	console.log(`  ${"".padEnd(22)}${SIGNALS.map(([name]) =>
		`${name} r / rho`.padStart(18)).join("")}`);
	for (let [label, failure] of FAILURES) {
		let cells = [];
		for (let [, signal] of SIGNALS) {
			let pairs = rows.filter(row => failure(row) !== null);
			let xs = pairs.map(signal);
			let ys = pairs.map(failure);
			cells.push(`${pearson(xs, ys).toFixed(3)} / ` +
				`${spearman(xs, ys).toFixed(3)}`);
		}
		console.log(`  ${label.padEnd(22)}${cells.map(c => c.padStart(18)).join("")}`);
	}

	console.log("\npipeline medians inside each verdict band (worse bands should");
	console.log("read worse down every column):");
	const NAMES = ["good", "fair", "bad", "awful"];
	console.log(`  ${"band".padEnd(7)}${"n".padStart(5)}` +
		FAILURES.map(([name]) => name.padStart(22)).join(""));
	for (let name of NAMES) {
		let group = rows.filter(row => row.rating === name);
		if (!group.length) {
			console.log(`  ${name.padEnd(7)}${"0".padStart(5)}`);
			continue;
		}
		let cells = FAILURES.map(([, failure]) => {
			let values = group.map(failure).filter(value => value !== null);
			return values.length
				? median(values).toFixed(2).padStart(22) : "-".padStart(22);
		});
		console.log(`  ${name.padEnd(7)}${String(group.length).padStart(5)}` +
			cells.join(""));
	}

	console.log("\na walk up the loss range:");
	let sorted = rows.slice().sort((a, b) => a.loss - b.loss);
	for (let i = 0; i < sorted.length; i += Math.ceil(sorted.length / 12)) {
		let row = sorted[i];
		console.log(`  ${row.rating.padEnd(6)} ` +
			`loss=${row.loss.toFixed(1).padStart(5)}% ` +
			`stall=${row.stall.toFixed(1).padStart(5)}%  ` +
			`shell=${row.shell_unmatched.toFixed(2).padStart(5)}% ` +
			`term=${row.terminal_unmatched === null ? "    -"
				: row.terminal_unmatched.toFixed(1).padStart(4) + "%"} ` +
			`tank=${row.tank_unbridged.toFixed(1).padStart(5)}%  ` +
			`${row.players}p  ${row.file}`);
	}

	/* Discordance: rank every log on the network's primary signal and on
	 * the pipeline's, and surface the widest disagreements both ways.
	 * These are the logs to open by hand -- either the verdict flattered
	 * a mess or the pipeline stumbled on a clean stream. */
	let loss_rank = ranks(rows.map(row => row.loss));
	let fail_rank = ranks(rows.map(row => row.shell_unmatched));
	let scored = rows.map((row, i) =>
		({ row, residual: (loss_rank[i] - fail_rank[i]) / rows.length }));
	let describe = ({ row, residual }) =>
		`  ${row.rating.padEnd(6)} loss=${row.loss.toFixed(1).padStart(5)}% ` +
		`shell unmatched=${row.shell_unmatched.toFixed(2)}% ` +
		`(rank gap ${(100 * residual).toFixed(0)})  ${row.file}`;
	scored.sort((a, b) => a.residual - b.residual);
	console.log("\nmost discordant -- network rated WORSE than the pipeline saw:");
	for (let entry of scored.slice(-5).reverse()) console.log(describe(entry));
	console.log("most discordant -- network rated BETTER than the pipeline saw:");
	for (let entry of scored.slice(0, 5)) console.log(describe(entry));
}

if (isMainThread) main();
else run_worker();
