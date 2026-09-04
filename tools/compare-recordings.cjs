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
 *      logs: over ten such pairs, not one of tens of thousands of
 *      missing slots turns up as a record in the other log, so a hole
 *      is a slot in which that node sent nothing worth logging, not a
 *      packet one machine missed (tools/measure-seq-holes.cjs takes
 *      that further) [E:seq-loss].
 *      Every run of records found in one log only is listed with the
 *      gap the other log shows across it: a hole of a few ticks, or an
 *      absence of many seconds. A byte-identical record stamped seconds
 *      apart is either an idle restatement matched a lap out (the
 *      sequence byte comes round every 128 records) or the same packet
 *      delivered late through a stall; the late machine's own log tells
 *      which, since a real delay ends a wait of the same length there.
 *   -- who recorded each log. A record from the recorder's own slot is
 *      stamped as it is SENT; everybody else's is stamped as the ring
 *      packet ARRIVES. So when the two logs' stamps are subtracted
 *      sender by sender, the senders fall into two groups a whole ring
 *      cycle apart: those whose packet reaches A before B, the arc of
 *      the ring running forward from just after B's recorder up to and
 *      including A's, and those whose packet reaches B first, the arc
 *      from just after A's up to and including B's. The ring order
 *      (read from the sequence steps) says which slot ends each arc,
 *      and those are the two recorders -- an independent check on
 *      viewer/network.js's burst rule.
 *   -- how far the two clocks drift apart, and how much the arrival
 *      stamps jitter from one machine to the other.
 *
 * Two logs of one game with fewer than a hundred records in common are
 * not two views of one stretch but a log restarted (the same machine,
 * different stretches of the game), and are reported as such.
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

/* ---------- alignment ---------- */

/* Longest common subsequence of two arrays of strings, as a list of
 * matched index pairs. Patience diff: records whose payload occurs exactly
 * once on each side are anchors, the longest chain of anchors in order is
 * taken, and the stretches between anchors are aligned the same way
 * again, down to stretches small enough for Myers' diff. Almost every
 * record of a log is unique (an idle restatement repeats, little else),
 * so the anchors carry nearly the whole alignment and the memory stays
 * linear -- a plain Myers diff over two logs of one game that cover
 * different stretches keeps a frontier per edit step and runs out of
 * heap. Stretches with no anchor and too many records on both sides are
 * left unmatched rather than ground through; the report says how many. */
function align(a, b, stats = { unaligned_a: 0, unaligned_b: 0 }) {
	let pairs = [];
	align_range(a, 0, a.length, b, 0, b.length, pairs, stats);
	for (let [i, j] of pairs) {
		if (a[i] !== b[j]) throw new Error("alignment matched unequal records");
	}
	return pairs;
}

const MYERS_LIMIT = 1500;   /* records per side under which a stretch goes to Myers */

function align_range(a, a0, a1, b, b0, b1, pairs, stats) {
	if (a0 >= a1 || b0 >= b1) return;
	/* anchors: payloads seen once on each side of this stretch */
	let count_a = new Map(), count_b = new Map();
	for (let i = a0; i < a1; i++) count_a.set(a[i], (count_a.get(a[i]) || 0) + 1);
	for (let j = b0; j < b1; j++) count_b.set(b[j], (count_b.get(b[j]) || 0) + 1);
	let where_b = new Map();
	for (let j = b0; j < b1; j++) if (count_b.get(b[j]) === 1 && count_a.get(b[j]) === 1) where_b.set(b[j], j);
	let anchors = [];   /* [i, j] in order of i */
	for (let i = a0; i < a1; i++) {
		if (count_a.get(a[i]) === 1 && where_b.has(a[i])) anchors.push([i, where_b.get(a[i])]);
	}
	if (!anchors.length) {
		if (a1 - a0 <= MYERS_LIMIT && b1 - b0 <= MYERS_LIMIT) {
			for (let [i, j] of myers(a.slice(a0, a1), b.slice(b0, b1))) pairs.push([a0 + i, b0 + j]);
		} else {
			stats.unaligned_a += a1 - a0;
			stats.unaligned_b += b1 - b0;
		}
		return;
	}
	let chain = longest_increasing(anchors);
	let pa = a0, pb = b0;
	for (let [i, j] of chain) {
		align_range(a, pa, i, b, pb, j, pairs, stats);
		pairs.push([i, j]);
		pa = i + 1;
		pb = j + 1;
	}
	align_range(a, pa, a1, b, pb, b1, pairs, stats);
}

/* The longest chain of anchors whose B indices increase, the A indices
 * already being in order. Patience sorting, O(n log n). */
function longest_increasing(anchors) {
	let tails = [], tail_at = [], prev = new Array(anchors.length).fill(-1);
	for (let n = 0; n < anchors.length; n++) {
		let j = anchors[n][1];
		let lo = 0, hi = tails.length;
		while (lo < hi) { let mid = (lo + hi) >> 1; if (tails[mid] < j) lo = mid + 1; else hi = mid; }
		tails[lo] = j;
		tail_at[lo] = n;
		prev[n] = lo > 0 ? tail_at[lo - 1] : -1;
	}
	let chain = [];
	for (let n = tail_at[tails.length - 1]; n !== undefined && n >= 0; n = prev[n]) chain.push(anchors[n]);
	return chain.reverse();
}

/* Myers' O((N+M)D) diff on two short stretches, as matched index pairs. */
function myers(a, b) {
	let n = a.length, m = b.length, max = n + m;
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
	return pairs.reverse();
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

const OFFSET_JITTER = 25;       /* ticks: stamps this far off the sender's offset are ordinary delivery jitter */
const OFFSET_TOLERANCE = 250;   /* ticks: a gap in the other log longer than this is an absence, not a hole */
const RUNS_SHOWN = 20;          /* runs of one-log-only records listed before the rest are counted */
const MIN_SHARED = 100;         /* fewer records in common: not two views of one stretch */

function describe(rec) {
	let parts = rec.subpackets.map(sub => {
		if (sub.type !== "tank_position") return sub.type;
		return `pos(${sub.x},${sub.y} speed ${sub.speed})`;
	});
	return `t=${rec.time} seq=${rec.seq} p=${rec.player} b=${rec.status.toString(16)} ` +
		`T=${rec.tankStatus.toString(16)} ${parts.join(",") || "(header only)"}`;
}

/* Each slot's successor in the ring, from the records that step by
 * exactly 1 (as tools/measure-seq-holes.cjs reads it). */
function ring_order(recs) {
	let counts = new Map();
	for (let i = 1; i < recs.length; i++) {
		if (((recs[i].seq - recs[i - 1].seq) & 0x7f) !== 1) continue;
		let key = recs[i - 1].player * 16 + recs[i].player;
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	let next = new Map(), best = new Map();
	for (let [key, n] of counts) {
		let from = key >> 4, to = key & 15;
		if (!best.has(from) || n > best.get(from)) { best.set(from, n); next.set(from, to); }
	}
	return next;
}

/* Runs of consecutive records found in one log only, inside the shared
 * stretch, each with the gap the OTHER log shows across it: the other
 * machine heard nothing for that long, and if that is more than a few
 * seconds the run is an absence rather than a hole. */
function only_runs(ring, map, other, lo, hi) {
	let runs = [];
	let run = null;
	for (let i = lo; i <= hi; i++) {
		if (map[i] >= 0) { if (run) { runs.push(run); run = null; } continue; }
		if (!run) run = { from: i, to: i };
		run.to = i;
	}
	if (run) runs.push(run);
	for (let r of runs) {
		let before = r.from - 1, after = r.to + 1;
		while (before >= 0 && map[before] < 0) before--;
		while (after < ring.length && map[after] < 0) after++;
		r.records = ring.slice(r.from, r.to + 1);
		r.other_gap = (before >= 0 && after < ring.length) ? other[map[after]].time - other[map[before]].time : null;
		r.senders = [...new Set(r.records.map(rec => rec.player))].sort((p, q) => p - q);
		r.span = r.records[r.records.length - 1].time - r.records[0].time;
	}
	return runs;
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
		recorder: { a_by_bursts: BoloNetwork.recorder(a_recs), b_by_bursts: BoloNetwork.recorder(b_recs),
			a_by_offset: null, b_by_offset: null },
	};

	/* Two different games share nothing but the odd idle restatement, so
	 * there is nothing to align. */
	if (!out.same_game) {
		out.aligned = false;
		if (!options.quiet) {
			console.log(`game id ${out.game_id || "?"}: NOT the same game (${info_b ? info_b.gameId : "?"} in B) -- nothing to compare`);
		}
		return out;
	}
	let unaligned = { unaligned_a: 0, unaligned_b: 0 };
	let pairs = align(a.ring.map(rec => rec.hex), b.ring.map(rec => rec.hex), unaligned);
	out.aligned = true;
	out.unaligned = unaligned;

	/* An idle tank restates the same bytes for minutes, and after 128
	 * records the sequence byte comes round too, so a stretch with no
	 * unique record can be matched a lap out -- on a fast four-player ring
	 * a lap is under 200 ticks. But a packet can also arrive late for
	 * real: a ring stalls for seconds and the same record is stamped at
	 * the far machine when the stall clears. The two are told apart by
	 * the late machine's own log: a delivery that arrived N ticks late
	 * sits at the end of a gap of about N ticks in the log that stamped
	 * it late, while a lap-out match sits in ordinary traffic. */
	let by_sender = new Map();
	for (let [i, j] of pairs) {
		let p = a.ring[i].player;
		if (!by_sender.has(p)) by_sender.set(p, []);
		by_sender.get(p).push(b.ring[j].time - a.ring[i].time);
	}
	let medians = new Map([...by_sender].map(([p, offsets]) => [p, median(offsets)]));
	let kept = [], rejected = [], delayed = [];
	for (let [i, j] of pairs) {
		let d = b.ring[j].time - a.ring[i].time - medians.get(a.ring[i].player);
		if (Math.abs(d) <= OFFSET_JITTER) { kept.push([i, j]); continue; }
		/* the log that stamped it later must show the wait */
		let late_gap = d > 0
			? (j > 0 ? b.ring[j].time - b.ring[j - 1].time : 0)
			: (i > 0 ? a.ring[i].time - a.ring[i - 1].time : 0);
		if (late_gap >= Math.abs(d) - OFFSET_JITTER) {
			kept.push([i, j]);
			delayed.push({ a: a.ring[i], b: b.ring[j], late_at: d > 0 ? "B" : "A", by: Math.abs(d), gap: late_gap });
		} else {
			rejected.push([i, j]);
		}
	}
	pairs = kept;
	out.rejected = rejected.map(([i, j]) => ({ a: a.ring[i], b: b.ring[j] }));
	out.delayed = delayed;

	let a_to_b = new Int32Array(a.ring.length).fill(-1);
	let b_to_a = new Int32Array(b.ring.length).fill(-1);
	for (let [i, j] of pairs) { a_to_b[i] = j; b_to_a[j] = i; }
	out.shared = pairs.length;
	out.a_ring = a.ring.length;
	out.b_ring = b.ring.length;
	out.same_stretch = pairs.length >= MIN_SHARED;

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
	out.a_runs = pairs.length ? only_runs(a.ring, a_to_b, b.ring, first[0], last[0]) : [];
	out.b_runs = pairs.length ? only_runs(b.ring, b_to_a, a.ring, first[1], last[1]) : [];

	/* Holes: the same in both? A hole in one log whose missing slots are
	 * records in the other is a packet that reached the second machine
	 * and not the first. */
	function holes_against(ring, map) {
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
	out.a_holes = holes_against(a.ring, a_to_b);
	out.b_holes = holes_against(b.ring, b_to_a);

	if (!out.same_stretch) {
		if (!options.quiet) print_report(out, a, b, options);
		return out;
	}

	/* Clocks. Every sender's stamps are offset by the clock difference
	 * plus the time the packet takes between the two machines; the
	 * senders fall into two groups a whole ring cycle apart. */
	by_sender = new Map();
	for (let [i, j] of pairs) {
		let p = a.ring[i].player;
		if (!by_sender.has(p)) by_sender.set(p, []);
		by_sender.get(p).push(b.ring[j].time - a.ring[i].time);
	}
	let senders = [...by_sender.keys()].sort((p, q) => p - q);
	medians = new Map(senders.map(p => [p, median(by_sender.get(p))]));
	let cycle_a = ring_cycle(a.ring), cycle_b = ring_cycle(b.ring);
	let cycle = Math.max(cycle_a || 0, cycle_b || 0);
	let sorted = senders.map(p => medians.get(p)).sort((x, y) => x - y);
	let split_at = null, widest = 0;
	for (let n = 1; n < sorted.length; n++) {
		if (sorted[n] - sorted[n - 1] > widest) { widest = sorted[n] - sorted[n - 1]; split_at = sorted[n]; }
	}
	let high = new Set(), low = new Set();
	if (cycle && widest >= cycle / 2) {
		for (let p of senders) (medians.get(p) >= split_at ? high : low).add(p);
	}
	let base = low.size ? median([...low].map(p => medians.get(p))) : median(sorted);

	/* A sender's packet reaches whichever recorder comes first on its
	 * way round. The high group (B's stamp later) is every slot whose
	 * packet reaches A before B: the arc of the ring running forward
	 * from just after B's recorder up to and including A's, which
	 * stamps its own record as it sends. The low group is the arc from
	 * just after A's up to and including B's. The ring order says which
	 * slot ENDS each arc, and those are the two recorders. */
	let order = ring_order(a.ring);
	let tails = group => [...group].filter(p => order.has(p) && !group.has(order.get(p)));
	let arc_ok = group => group.size && tails(group).length === 1 &&
		[...group].every(p => order.has(p));
	if (high.size && low.size && arc_ok(high) && arc_ok(low)) {
		out.recorder.a_by_offset = tails(high)[0];
		out.recorder.b_by_offset = tails(low)[0];
	}
	out.ring_order = order;

	/* drift: the offset's trend over the game, each sender measured
	 * against its own median so the cycle-wide step does not tilt the
	 * fit */
	let xs = [], ys = [];
	for (let [i, j] of pairs) {
		xs.push(a.ring[i].time - a.ring[0].time);
		ys.push(b.ring[j].time - a.ring[i].time - medians.get(a.ring[i].player));
	}
	out.clock = {
		offset: base, cycle_a, cycle_b,
		drift_ppm: slope(xs, ys) * 1e6,
		span_ticks: xs.length ? xs[xs.length - 1] : 0,
		by_sender: senders.map(p => ({
			player: p, n: by_sender.get(p).length, median: medians.get(p),
			group: high.has(p) ? "+" : low.has(p) ? "-" : "?",
			p1: quantile(by_sender.get(p), 0.01), p99: quantile(by_sender.get(p), 0.99),
			min: quantile(by_sender.get(p), 0), max: quantile(by_sender.get(p), 1),
		})),
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
	let slot = p => p === null ? "undecided" : `slot ${p}`;
	let seconds = ticks => `${(ticks / 50).toFixed(1)} s`;
	console.log(`game id ${out.game_id || "?"}: the same game in both logs`);
	console.log(`ring records: A ${out.a_ring}, B ${out.b_ring}, shared ${out.shared}` +
		(out.rejected.length ? ` (${out.rejected.length} byte-identical matches rejected: stamped off the sender's offset with no wait in the late log to show for it)` : "") +
		(out.unaligned.unaligned_a || out.unaligned.unaligned_b
			? ` (${out.unaligned.unaligned_a} of A and ${out.unaligned.unaligned_b} of B in anchorless stretches too long to diff, left unmatched)` : ""));
	if (!out.same_stretch) {
		console.log(`  fewer than ${MIN_SHARED} records in common: the two logs cover different stretches of the game -- ` +
			`a log restarted, not two views of one stretch (recorder of A by burst position ${slot(out.recorder.a_by_bursts)}, ` +
			`of B ${slot(out.recorder.b_by_bursts)})`);
		return;
	}
	let only = (label, o) => console.log(`  ${label} only: ${o.before.length} before the shared stretch, ` +
		`${o.inside.length} inside it, ${o.after.length} after`);
	only("A", out.a_only);
	only("B", out.b_only);
	let runs = (label, other, list) => {
		if (!list.length) return;
		console.log(`  runs of records in ${label} only, inside the shared stretch, with the gap ${other} shows across each:`);
		for (let r of list.slice(0, RUNS_SHOWN)) {
			let kind = r.other_gap === null ? "at the edge" : r.other_gap <= OFFSET_TOLERANCE
				? `a hole of ${r.other_gap} ticks in ${other}` : `an absence: ${other} heard nothing for ${seconds(r.other_gap)}`;
			console.log(`    ${r.records.length} record${r.records.length === 1 ? "" : "s"} from sender${r.senders.length === 1 ? "" : "s"} ` +
				`${r.senders.join(",")} over ${seconds(r.span)} at t=${r.records[0].time} -- ${kind}`);
			if (options.verbose) for (let rec of r.records) console.log(`      ${describe(rec)}`);
		}
		if (list.length > RUNS_SHOWN) console.log(`    ... and ${list.length - RUNS_SHOWN} more runs`);
	};
	runs("A", "B", out.a_runs);
	runs("B", "A", out.b_runs);
	if (out.delayed.length) {
		console.log(`  delivered late: ${out.delayed.length} record${out.delayed.length === 1 ? "" : "s"} stamped at one machine well after the other, each at the end of a wait in that machine's log -- the same packet, held up on its way round:`);
		for (let r of out.delayed.slice(0, RUNS_SHOWN)) {
			console.log(`    ${seconds(r.by)} late at ${r.late_at}, after ${r.late_at} heard nothing for ${seconds(r.gap)}: ${describe(r.late_at === "A" ? r.a : r.b)}`);
		}
		if (out.delayed.length > RUNS_SHOWN) console.log(`    ... and ${out.delayed.length - RUNS_SHOWN} more`);
	}
	if (options.verbose && out.rejected.length) {
		console.log("  rejected matches (A record | B record):");
		for (let r of out.rejected.slice(0, RUNS_SHOWN)) console.log(`    ${describe(r.a)} | ${describe(r.b)}`);
	}
	let holes = (label, other, h) => console.log(`  ${label}'s sequence holes: ${h.holes}, ${h.comparable} inside the shared stretch ` +
		`missing ${h.missing} slots, of which ${h.found_in_other} are records in ${other}`);
	holes("A", "B", out.a_holes);
	holes("B", "A", out.b_holes);
	let c = out.clock;
	console.log(`clocks: B - A = ${c.offset} ticks; ring cycle (median) A ${c.cycle_a} B ${c.cycle_b}; ` +
		`drift ${c.drift_ppm.toFixed(1)} ppm over ${(c.span_ticks / 50).toFixed(0)} s ` +
		`(${(c.drift_ppm * 1e-6 * c.span_ticks).toFixed(2)} ticks end to end)`);
	for (let s of c.by_sender) {
		console.log(`  sender ${s.player}: n=${s.n} median ${s.median} (${s.median - c.offset >= 0 ? "+" : ""}${s.median - c.offset}, group ${s.group}) ` +
			`min ${s.min} p1 ${s.p1} p99 ${s.p99} max ${s.max}`);
	}
	let order = [];
	if (out.ring_order.size) {
		let p = Math.min(...out.ring_order.keys());
		for (let n = 0; n < out.ring_order.size && p !== undefined; n++) { order.push(p); p = out.ring_order.get(p); }
	}
	console.log(`ring order: ${order.join(" -> ")}`);
	let r = out.recorder;
	console.log(`recorder of A: by stamp offsets ${slot(r.a_by_offset)}, by burst position ${slot(r.a_by_bursts)}`);
	console.log(`recorder of B: by stamp offsets ${slot(r.b_by_offset)}, by burst position ${slot(r.b_by_bursts)}`);
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

module.exports = { align, split_boot, seq_holes, ring_order, compare };

if (require.main === module) main();
