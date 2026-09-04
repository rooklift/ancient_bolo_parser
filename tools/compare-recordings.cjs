#!/usr/bin/env node
/* Two recordings of one game, laid side by side.
 *
 * Every machine in a Bolo ring can log, so one game can leave several
 * logs, each written on a different machine at a different position in
 * the ring, each with its own clock. Such a pair is the only experiment
 * a log format offers for free: the same packets, seen twice. It
 * answers questions a single log cannot:
 *
 *   -- whether the record stream is the same everywhere. It is, byte
 *      for byte, sequence byte included: every ring record one machine
 *      wrote, the other wrote too, and in the same order. A log is the
 *      ring's transcript, not one machine's view of it [E:two-recorders].
 *   -- what a sequence-number hole is. The holes are identical in both
 *      logs, and not one of the missing slots turns up as a record in
 *      the other -- so nothing was lost on the way to either machine.
 *      A hole is a slot in which that node sent nothing worth logging
 *      (tools/measure-seq-holes.cjs takes that further) [E:seq-loss].
 *   -- who recorded each log. A record from the recorder's own slot is
 *      stamped as it is SENT; everybody else's is stamped as the ring
 *      packet ARRIVES, one cycle later at the far end of the ring. So
 *      when the two logs' stamps are subtracted sender by sender, one
 *      sender stands a whole ring cycle apart from the rest: the
 *      recorder of the log in which that sender's records are earliest.
 *      That is an independent check on viewer/network.js's burst rule.
 *   -- how far the two clocks drift apart, and how much the arrival
 *      stamps jitter from one machine to the other.
 *
 * The start-of-log burst (F8 ids, game info, lists, map runs) is local
 * to each machine and sent to nobody, so it is set aside before the
 * alignment and compared separately: where the two logs began at
 * different moments, the map rows that changed in between differ.
 *
 * Usage:
 *   node tools/compare-recordings.cjs <logA> <logB> [--verbose]
 *   node tools/compare-recordings.cjs --scan [corpus-root ...] [--verbose]
 *
 * --scan walks the given directories (or the configured corpus, see
 * tools/corpus.cjs), groups logs by the game id in their `F1 01` game
 * info (host address + start time, unique to one game), and compares
 * every pair in every group. --verbose lists every record found in only
 * one log inside the shared stretch, which is the list expected to be
 * empty.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const MAX_EDITS = 20000;   /* records by which two streams may differ and still be aligned */

/* ---------- alignment ---------- */

/* Longest common subsequence of two arrays of strings, as a list of
 * matched index pairs, by Myers' O((N+M)D) diff. The streams differ in a
 * few hundred records out of tens of thousands, which is the case the
 * algorithm is built for. */
function align(a, b, max_edits = Infinity) {
	let n = a.length, m = b.length, max = Math.min(n + m, max_edits);
	let v = new Map([[1, 0]]);
	let trace = [];
	let done = false;
	for (let d = 0; d <= max && !done; d++) {
		trace.push(new Map(v));
		for (let k = -d; k <= d; k += 2) {
			let x;
			if (k === -d || (k !== d && v.get(k - 1) < v.get(k + 1))) x = v.get(k + 1);
			else x = v.get(k - 1) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) { x++; y++; }
			v.set(k, x);
			if (x >= n && y >= m) { done = true; break; }
		}
	}
	if (!done) return null;   /* further apart than max_edits: not worth aligning */
	let pairs = [];
	let x = n, y = m;
	for (let d = trace.length - 1; d > 0; d--) {
		let vd = trace[d];
		let k = x - y;
		let prev_k = (k === -d || (k !== d && vd.get(k - 1) < vd.get(k + 1))) ? k + 1 : k - 1;
		let px = vd.get(prev_k), py = px - prev_k;
		while (x > px && y > py) { x--; y--; pairs.push([x, y]); }
		x = px; y = py;
	}
	while (x > 0 && y > 0) { x--; y--; pairs.push([x, y]); }
	pairs.reverse();
	for (let [i, j] of pairs) {
		if (a[i] !== b[j]) throw new Error("alignment matched unequal records");
	}
	return pairs;
}

/* ---------- loading ---------- */

function load_log(BoloLog, file) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let recs = [];
	try {
		for (let raw of BoloLog.rawRecords(bytes)) {
			let rec = BoloLog.parseRecord(raw);
			rec.hex = Buffer.from(raw.data).toString("hex");
			recs.push(rec);
		}
	} catch { /* keep whatever decoded before the damage */ }
	return recs;
}

/* The start-of-log burst is the leading run of seq-0, T=7 records: the
 * F8 ids, game info, lists, history and map runs Bolo writes locally when
 * logging starts. Nothing in it went round the ring. */
function split_boot(recs) {
	let i = 0;
	while (i < recs.length && recs[i].seq === 0 && recs[i].tankStatus === 7) i++;
	return {
		boot: recs.slice(0, i),
		ring: recs.slice(i).filter(rec => rec.tankStatus !== 0x0f),
	};
}

function game_info(recs) {
	for (let rec of recs) {
		for (let sub of rec.subpackets) if (sub.type === "game_info") return sub;
	}
	return null;
}

function player_names(recs) {
	let names = new Map();
	for (let rec of recs) {
		for (let sub of rec.subpackets) {
			if (sub.type === "node_id" && !names.has(rec.player)) names.set(rec.player, sub.name);
		}
	}
	return names;
}

/* ---------- statistics ---------- */

function median(values) {
	if (!values.length) return null;
	let v = values.slice().sort((p, q) => p - q);
	return v[v.length >> 1];
}

function quantile(values, p) {
	if (!values.length) return null;
	let v = values.slice().sort((x, y) => x - y);
	return v[Math.floor(p * (v.length - 1))];
}

function slope(xs, ys) {
	let n = xs.length;
	if (n < 2) return 0;
	let mx = xs.reduce((s, x) => s + x, 0) / n;
	let my = ys.reduce((s, y) => s + y, 0) / n;
	let sxy = 0, sxx = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
	}
	return sxx ? sxy / sxx : 0;
}

/* Median gap from one record of a player to the next, pooled over players:
 * the ring's cycle time as one log sees it. */
function ring_cycle(recs) {
	let last = new Map();
	let gaps = [];
	for (let rec of recs) {
		if (last.has(rec.player)) {
			let gap = rec.time - last.get(rec.player);
			if (gap <= 1500) gaps.push(gap);
		}
		last.set(rec.player, rec.time);
	}
	return median(gaps);
}

/* Sequence holes over a stretch of records: a step above 1 across a gap
 * short enough to trust. Returns one entry per hole with the index of the
 * record that closed it. */
function seq_holes(recs) {
	let holes = [];
	for (let i = 1; i < recs.length; i++) {
		let step = (recs[i].seq - recs[i - 1].seq) & 0x7f;
		let gap = recs[i].time - recs[i - 1].time;
		if (step > 1 && gap <= 250) holes.push({ index: i, missing: step - 1 });
	}
	return holes;
}

/* ---------- the comparison ---------- */

function describe(rec) {
	let parts = rec.subpackets.map(sub => sub.type);
	return `t=${rec.time} seq=${rec.seq} p=${rec.player} b=${rec.status.toString(16)} ` +
		`T=${rec.tankStatus.toString(16)} ${parts.join(",") || "(header only)"}`;
}

/* Compares two loaded logs. Returns the findings as an object and, unless
 * quiet, prints the report. */
function compare(a_recs, b_recs, options = {}) {
	let BoloNetwork = options.network || require(path.join(ROOT, "viewer", "network.js"));
	let a = split_boot(a_recs), b = split_boot(b_recs);
	let info_a = game_info(a_recs), info_b = game_info(b_recs);
	let out = {
		same_game: !!(info_a && info_b && info_a.gameId === info_b.gameId),
		game_id: info_a ? info_a.gameId : null,
	};

	/* Two different games share nothing but the odd idle restatement, and
	 * the diff would grind through the whole edit distance to say so; the
	 * bound also keeps a damaged pair from running for hours. */
	let pairs = out.same_game
		? align(a.ring.map(rec => rec.hex), b.ring.map(rec => rec.hex), MAX_EDITS)
		: null;
	if (!pairs) {
		out.aligned = false;
		if (!options.quiet) {
			console.log(`game id ${out.game_id || "?"}: ${out.same_game
				? "the same game, but the streams differ in more than " + MAX_EDITS + " records and were not aligned"
				: "NOT the same game (" + (info_b ? info_b.gameId : "?") + " in B) -- nothing to compare"}`);
		}
		return out;
	}
	out.aligned = true;
	let a_to_b = new Int32Array(a.ring.length).fill(-1);
	let b_to_a = new Int32Array(b.ring.length).fill(-1);
	for (let [i, j] of pairs) { a_to_b[i] = j; b_to_a[j] = i; }
	out.shared = pairs.length;
	out.a_ring = a.ring.length;
	out.b_ring = b.ring.length;

	/* Records found in one log only, placed against the shared stretch. */
	let first = pairs.length ? pairs[0] : [a.ring.length, b.ring.length];
	let last = pairs.length ? pairs[pairs.length - 1] : [-1, -1];
	function only(ring, map, lo, hi) {
		let before = [], inside = [], after = [];
		for (let i = 0; i < ring.length; i++) {
			if (map[i] >= 0) continue;
			(i < lo ? before : i > hi ? after : inside).push(ring[i]);
		}
		return { before, inside, after };
	}
	out.a_only = only(a.ring, a_to_b, first[0], last[0]);
	out.b_only = only(b.ring, b_to_a, first[1], last[1]);

	/* Holes: the same in both? A hole in one log whose missing slots are
	 * records in the other would be a packet lost on the way to the first
	 * machine but not the second. */
	function holes_against(ring, map, other_ring) {
		let holes = seq_holes(ring);
		let missing = 0, found = 0, comparable = 0;
		for (let hole of holes) {
			let i = hole.index;
			if (map[i] < 0 || map[i - 1] < 0) continue;
			comparable++;
			missing += hole.missing;
			found += map[i] - map[i - 1] - 1;
		}
		return { holes: holes.length, comparable, missing, found_in_other: found };
	}
	out.a_holes = holes_against(a.ring, a_to_b, b.ring);
	out.b_holes = holes_against(b.ring, b_to_a, a.ring);

	/* Clocks and recorders. For every matched pair, B's stamp minus A's,
	 * grouped by sender. */
	let by_sender = new Map();
	for (let [i, j] of pairs) {
		let rec_a = a.ring[i], rec_b = b.ring[j];
		if (!by_sender.has(rec_a.player)) by_sender.set(rec_a.player, []);
		by_sender.get(rec_a.player).push(rec_b.time - rec_a.time);
	}
	let senders = [...by_sender.keys()].sort((p, q) => p - q);
	let medians = new Map(senders.map(p => [p, median(by_sender.get(p))]));
	/* drift: the offset's trend over the game, each sender measured
	 * against its own median so the recorder's cycle-wide step does not
	 * tilt the fit */
	let xs = [], ys = [];
	for (let [i, j] of pairs) {
		let rec_a = a.ring[i], rec_b = b.ring[j];
		xs.push(rec_a.time - a.ring[0].time);
		ys.push(rec_b.time - rec_a.time - medians.get(rec_a.player));
	}
	let base = median([...medians.values()]);
	let cycle_a = ring_cycle(a.ring), cycle_b = ring_cycle(b.ring);
	let cycle = cycle_a === null ? cycle_b : cycle_b === null ? cycle_a : Math.max(cycle_a, cycle_b);
	/* the sender whose records A stamps a whole cycle earlier than B does
	 * relative to everyone else is A's own slot, and vice versa */
	let recorder_a = null, recorder_b = null;
	for (let p of senders) {
		let d = medians.get(p) - base;
		if (cycle && d >= cycle / 2 && d <= 2 * cycle) recorder_a = recorder_a === null ? p : -1;
		if (cycle && -d >= cycle / 2 && -d <= 2 * cycle) recorder_b = recorder_b === null ? p : -1;
	}
	out.clock = {
		offset: base, cycle_a, cycle_b,
		drift_ppm: slope(xs, ys) * 1e6,
		span_ticks: xs.length ? xs[xs.length - 1] : 0,
		by_sender: senders.map(p => ({
			player: p, n: by_sender.get(p).length, median: medians.get(p),
			p1: quantile(by_sender.get(p), 0.01), p99: quantile(by_sender.get(p), 0.99),
			min: quantile(by_sender.get(p), 0), max: quantile(by_sender.get(p), 1),
		})),
	};
	out.recorder = {
		a_by_offset: recorder_a === -1 ? null : recorder_a,
		b_by_offset: recorder_b === -1 ? null : recorder_b,
		a_by_bursts: BoloNetwork.recorder(a_recs),
		b_by_bursts: BoloNetwork.recorder(b_recs),
	};

	/* The boot bursts, compared as sets: a map run present in one and not
	 * the other is a row that changed between the two logs' starts. */
	let boot_a = new Set(a.boot.map(rec => rec.hex)), boot_b = new Set(b.boot.map(rec => rec.hex));
	let boot_diff = { a_only: 0, b_only: 0, a: a.boot.length, b: b.boot.length };
	for (let h of boot_a) if (!boot_b.has(h)) boot_diff.a_only++;
	for (let h of boot_b) if (!boot_a.has(h)) boot_diff.b_only++;
	out.boot = boot_diff;

	if (!options.quiet) print_report(out, a, b, options);
	return out;
}

function print_report(out, a, b, options) {
	let names_a = player_names(a.boot.concat(a.ring)), names_b = player_names(b.boot.concat(b.ring));
	let name = (names, p) => p === null ? "undecided" : `${p} (${(names.get(p) || "?").split("@")[0]})`;
	console.log(`game id ${out.game_id || "?"}: the same game in both logs`);
	console.log(`ring records: A ${out.a_ring}, B ${out.b_ring}, shared ${out.shared}`);
	let only = (label, o) => console.log(`  ${label} only: ${o.before.length} before the shared stretch, ` +
		`${o.inside.length} inside it, ${o.after.length} after`);
	only("A", out.a_only);
	only("B", out.b_only);
	if (options.verbose) {
		for (let rec of out.a_only.inside) console.log(`    A only: ${describe(rec)}`);
		for (let rec of out.b_only.inside) console.log(`    B only: ${describe(rec)}`);
	}
	let holes = (label, h) => console.log(`  ${label}'s sequence holes: ${h.holes}, ${h.comparable} inside the shared stretch ` +
		`missing ${h.missing} slots, of which ${h.found_in_other} are records in the other log`);
	holes("A", out.a_holes);
	holes("B", out.b_holes);
	let c = out.clock;
	console.log(`clocks: B - A = ${c.offset} ticks; ring cycle (median) A ${c.cycle_a} B ${c.cycle_b}; ` +
		`drift ${c.drift_ppm.toFixed(1)} ppm over ${(c.span_ticks / 50).toFixed(0)} s ` +
		`(${(c.drift_ppm * 1e-6 * c.span_ticks).toFixed(2)} ticks end to end)`);
	for (let s of c.by_sender) {
		console.log(`  sender ${s.player}: n=${s.n} median ${s.median} (${s.median - c.offset >= 0 ? "+" : ""}${s.median - c.offset}) ` +
			`min ${s.min} p1 ${s.p1} p99 ${s.p99} max ${s.max}`);
	}
	let r = out.recorder;
	console.log(`recorder of A: by stamp offsets ${name(names_a, r.a_by_offset)}, by burst position ${name(names_a, r.a_by_bursts)}`);
	console.log(`recorder of B: by stamp offsets ${name(names_b, r.b_by_offset)}, by burst position ${name(names_b, r.b_by_bursts)}`);
	console.log(`start-of-log bursts: A ${out.boot.a} records, B ${out.boot.b}; differing A ${out.boot.a_only}, B ${out.boot.b_only}`);
}

/* ---------- scanning a corpus ---------- */

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (let entry of entries) {
		let item = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(item);
		else if (entry.isFile() && !SKIPPED_EXTENSIONS.test(entry.name)) yield item;
	}
}

/* The game id of a log, read from the start-of-log burst without decoding
 * the rest of the file. */
function quick_game_id(BoloLog, file) {
	let bytes;
	try {
		bytes = new Uint8Array(fs.readFileSync(file));
	} catch {
		return null;
	}
	if (bytes.length < 200 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "Bolo") return null;
	try {
		let seen = 0;
		for (let raw of BoloLog.rawRecords(bytes)) {
			let rec = BoloLog.parseRecord(raw);
			for (let sub of rec.subpackets) if (sub.type === "game_info") return sub.gameId;
			if (++seen > 200) break;
		}
	} catch { /* damaged */ }
	return null;
}

function scan(roots, options) {
	const BoloLog = require(path.join(ROOT, "viewer", "logparse.js"));
	const { replay_label } = require(path.join(ROOT, "tools", "corpus.cjs"));
	let groups = new Map();
	let logs = 0;
	for (let root of roots) {
		for (let file of walk(root)) {
			let id = quick_game_id(BoloLog, file);
			if (!id) continue;
			logs++;
			if (!groups.has(id)) groups.set(id, []);
			groups.get(id).push(file);
		}
	}
	let shared = [...groups.values()].filter(files => files.length > 1);
	console.log(`${logs} logs with a game id, ${groups.size} distinct games, ${shared.length} recorded more than once`);
	for (let files of shared) {
		console.log(`\n=== game ${quick_game_id(BoloLog, files[0])}: ${files.map(replay_label).join(", ")}`);
		let loaded = files.map(file => load_log(BoloLog, file));
		for (let i = 0; i < files.length; i++) {
			for (let j = i + 1; j < files.length; j++) {
				console.log(`--- A = ${replay_label(files[i])}, B = ${replay_label(files[j])}`);
				compare(loaded[i], loaded[j], options);
			}
		}
	}
}

function main() {
	let args = process.argv.slice(2);
	let options = { verbose: args.includes("--verbose") };
	let positional = args.filter(arg => !arg.startsWith("--"));
	if (args.includes("--scan")) {
		let roots = positional.length ? positional : [require(path.join(ROOT, "tools", "corpus.cjs")).corpus_root()];
		scan(roots, options);
		return;
	}
	if (positional.length !== 2) {
		console.error("usage: node tools/compare-recordings.cjs <logA> <logB> [--verbose]\n" +
			"       node tools/compare-recordings.cjs --scan [corpus-root ...] [--verbose]");
		process.exit(2);
	}
	const BoloLog = require(path.join(ROOT, "viewer", "logparse.js"));
	compare(load_log(BoloLog, positional[0]), load_log(BoloLog, positional[1]), options);
}

module.exports = { align, split_boot, seq_holes, compare };

if (require.main === module) main();
