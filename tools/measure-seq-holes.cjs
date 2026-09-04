#!/usr/bin/env node
/* What is a hole in the sequence numbers?
 *
 * The payload's first byte steps by 1 from one record to the next, and a
 * step of n was read as n-1 packets that never reached the logging
 * machine -- the LOSS reading of viewer/network.js. A pair of logs of one
 * game written on two machines says otherwise: their holes are identical,
 * and not one missing slot is a record in the other log (see
 * tools/compare-recordings.cjs). So what does a hole mark?
 *
 * The records tell, because the ring order is in them. Over settled
 * play, records that step by exactly 1 name each slot's successor
 * (0->2, 2->3, 3->1, 1->0 in a four-player log), so every missing slot
 * can be handed to the player whose turn it was, and the chain checked:
 * the last attributed slot's successor must be the player who actually
 * closed the hole. It is, at every hole of every log measured. Then each
 * missing slot is classed by what its owner was doing, read from his
 * nearest records either side:
 *
 *   OWN       the slot belongs to the recording machine itself (also
 *             counted in the class below). The recorder cannot lose its
 *             own packet on the way to itself.
 *   MOVING    both neighbours carry a live tank position with nonzero
 *             speed, at different pixels, within 40 ticks of each other.
 *             A moving tank restates every cycle, so this and only this
 *             is a dropped restatement -- loss, if any hole is.
 *   STILL     both neighbours carry the same position, or neither
 *             carries one and the tank is not dead: the tank was parked,
 *             and a parked tank restates only every few seconds.
 *   DEAD      a neighbour is a dead or joining record (`T=7`, or the
 *             dying bit set).
 *   CHANGING  anything else: a position on one side only, a stop or a
 *             start, neighbours further apart than a couple of cycles.
 *   EDGE      no record from the owner on one side of the hole.
 *
 * Alongside the classes: the step histogram against the player count
 * (a whole packet lost would take every slot of a cycle with it, step
 * = players + 1; in four-player logs such steps do not occur, and in
 * two-player ones they are both tanks parked), and the pace of the ring
 * at holes: how many holes sit INSIDE a same-tick burst, which a lost
 * packet never could, and for the single-slot holes among the rest the
 * gap between the records either side, in ring cycles, against the gap
 * of an ordinary step across a burst boundary (logs whose ring turns in
 * under 4 ticks are left out of that line: the stamps cannot resolve
 * their cycle). A ring waiting on a lost packet slows; a ring skipping
 * a quiet node does not.
 *
 * The answer, on every log to hand: a hole is a node that had nothing
 * to log that cycle -- a parked tank between restatements, a dead one,
 * the recorder itself as readily as anyone -- and the ring turns through
 * it at full pace. The LOSS reading is the share of quiet slots
 * [E:seq-loss].
 *
 * Usage: node tools/measure-seq-holes.cjs [corpus-root | log ...] [--samples]
 *        (defaults to the fixtures and the configured corpus, if any)
 *
 * --samples lists the MOVING holes, since those are the only ones that
 * could still be loss and every one deserves a look.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { replay_label } = require("./corpus.cjs");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloNetwork = require(path.join(__dirname, "..", "viewer", "network.js"));

const ROOT = path.join(__dirname, "..");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const SEQ_TRUST_TICKS = 250;     /* as network.js: past this a step may have wrapped */
const MOVING_WINDOW = 40;        /* ticks: neighbours this close bracket one skipped cycle */
const MIN_RECORDS = 2000;
const PACE_MIN_CYCLE = 4;        /* ticks: below this the stamps cannot resolve a cycle */
const CLASSES = ["moving", "still", "dead", "changing", "edge"];

/* ---------- one log ---------- */

/* The stretch network.js reads its verdict from: first base capture to
 * first quit. Outside it the ring is gathering or dissolving and the
 * steps mean less. */
function settled(recs) {
	let start = null, end = null;
	for (let rec of recs) {
		if (start === null && rec.subpackets.some(s => s.type === "base_capture")) start = rec.time;
		else if (start !== null && rec.subpackets.some(s => s.type === "quit")) { end = rec.time; break; }
	}
	if (start === null) return [];
	if (end === null) end = recs[recs.length - 1].time;
	return recs.filter(rec => rec.time >= start && rec.time <= end);
}

/* Each slot's successor in the ring, from the records that step by
 * exactly 1. */
function ring_order(recs) {
	let counts = new Map();
	for (let i = 1; i < recs.length; i++) {
		if (((recs[i].seq - recs[i - 1].seq) & 0x7f) !== 1) continue;
		let key = recs[i - 1].player * 16 + recs[i].player;
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	let next = new Map();
	let best = new Map();
	for (let [key, n] of counts) {
		let from = key >> 4, to = key & 15;
		if (!best.has(from) || n > best.get(from)) { best.set(from, n); next.set(from, to); }
	}
	return next;
}

function position_of(rec) {
	return rec.subpackets.find(s => s.type === "tank_position") || null;
}

function same_pixel(p, q) {
	return p.x === q.x && p.y === q.y && p.px === q.px && p.py === q.py;
}

function classify(prev, next) {
	if (!prev || !next) return "edge";
	if (prev.tankStatus === 7 || next.tankStatus === 7 || (prev.tankStatus & 4) || (next.tankStatus & 4)) return "dead";
	let p = position_of(prev), q = position_of(next);
	if (p && q) {
		if (same_pixel(p, q)) return "still";
		if (p.speed > 0 && q.speed > 0 && next.time - prev.time <= MOVING_WINDOW) return "moving";
		return "changing";
	}
	if (!p && !q) return "still";
	return "changing";
}

function empty_tally() {
	let tally = { logs: 0, records: 0, slots: 0, holes: 0, missing: 0, chain_ok: 0, chain_bad: 0,
		own: 0, own_class: {}, classes: {}, steps: {}, whole_cycle: 0, beyond_cycle: 0,
		holes_in_burst: 0, unpaced_logs: 0, gap_at_hole: [], gap_at_step: [], by_players: {} };
	for (let c of CLASSES) { tally.classes[c] = 0; tally.own_class[c] = 0; }
	return tally;
}

function measure_file(recs, tally, samples, label) {
	let span = settled(recs.filter(rec => rec.tankStatus !== 0x0f));
	if (span.length < MIN_RECORDS) return null;
	let next = ring_order(span);
	let players = next.size;
	let recorder = BoloNetwork.recorder(recs);
	/* per-player record indices, for the neighbour lookups */
	let by_player = new Map();
	span.forEach((rec, i) => {
		if (!by_player.has(rec.player)) by_player.set(rec.player, []);
		by_player.get(rec.player).push(i);
	});
	let neighbours = (player, i) => {
		let list = by_player.get(player);
		if (!list) return [null, null];
		let lo = 0, hi = list.length;
		while (lo < hi) { let mid = (lo + hi) >> 1; if (list[mid] < i) lo = mid + 1; else hi = mid; }
		return [lo > 0 ? span[list[lo - 1]] : null, lo < list.length ? span[list[lo]] : null];
	};

	/* the log's own ring cycle, so gaps from fast and slow rings pool */
	let last_seen = new Map(), cycle_gaps = [];
	for (let rec of span) {
		if (last_seen.has(rec.player)) {
			let gap = rec.time - last_seen.get(rec.player);
			if (gap <= 1500) cycle_gaps.push(gap);
		}
		last_seen.set(rec.player, rec.time);
	}
	cycle_gaps.sort((a, b) => a - b);
	let cycle = Math.max(1, cycle_gaps[cycle_gaps.length >> 1] || 1);
	/* a ring turning in under 4 ticks is faster than the stamps resolve,
	 * so its gaps say nothing about pace */
	let paced = cycle >= PACE_MIN_CYCLE;
	if (!paced) tally.unpaced_logs++;

	let file = { label, players, recorder, records: span.length, slots: 0, missing: 0, holes: 0, moving: 0, own: 0 };
	tally.logs++;
	tally.records += span.length;
	let per = tally.by_players[players] = tally.by_players[players] || { logs: 0, slots: 0, missing: 0, whole_cycle: 0, holes: 0 };
	per.logs++;
	for (let i = 1; i < span.length; i++) {
		let step = (span[i].seq - span[i - 1].seq) & 0x7f;
		let gap = span[i].time - span[i - 1].time;
		if (step === 0 || gap > SEQ_TRUST_TICKS) { file.slots++; continue; }
		file.slots += step;
		if (step === 1) { if (gap > 0 && paced) tally.gap_at_step.push(gap / cycle); continue; }
		if (gap === 0) tally.holes_in_burst++;
		else if (step === 2 && paced) tally.gap_at_hole.push(gap / cycle);   /* one slot: spans at most one cycle */
		file.holes++;
		file.missing += step - 1;
		tally.steps[step] = (tally.steps[step] || 0) + 1;
		if (step === players + 1) { tally.whole_cycle++; per.whole_cycle++; }
		if (step > players + 1) tally.beyond_cycle++;
		let owner = span[i - 1].player;
		for (let m = 1; m < step; m++) {
			owner = next.get(owner);
			if (owner === undefined) break;
			let [prev, after] = neighbours(owner, i);
			let cls = classify(prev, after);
			tally.classes[cls]++;
			if (owner === recorder) { tally.own++; tally.own_class[cls]++; file.own++; }
			if (cls === "moving") {
				file.moving++;
				if (samples.length < 40) samples.push({ label, owner, step, prev, after, before_hole: span[i - 1], after_hole: span[i] });
			}
		}
		if (owner !== undefined && next.get(owner) === span[i].player) tally.chain_ok++;
		else tally.chain_bad++;
	}
	tally.slots += file.slots;
	tally.missing += file.missing;
	tally.holes += file.holes;
	per.slots += file.slots;
	per.missing += file.missing;
	per.holes += file.holes;
	return file;
}

/* ---------- reporting ---------- */

function quantile(sorted, p) {
	return sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : null;
}

function describe(rec) {
	let pos = position_of(rec);
	return `t=${rec.time} seq=${rec.seq} p=${rec.player} T=${rec.tankStatus.toString(16)}` +
		(pos ? ` at (${pos.x},${pos.y}) px ${pos.px},${pos.py} speed ${pos.speed}` : "") +
		` [${rec.subpackets.map(s => s.type).join(",") || "header only"}]`;
}

function report(tally, files, samples, show_samples) {
	let pct = (n, d) => d ? (100 * n / d).toFixed(2) + "%" : "-";
	console.log(`${tally.logs} logs, ${tally.records} settled records, ${tally.slots} ring slots, ` +
		`${tally.missing} missing (${pct(tally.missing, tally.slots)}) in ${tally.holes} holes`);
	console.log(`ring order chain closes on the actual next sender at ${tally.chain_ok} holes, fails at ${tally.chain_bad}`);
	console.log("\nmissing slots by what the owner was doing:");
	for (let c of CLASSES) {
		console.log(`  ${c.padEnd(9)} ${String(tally.classes[c]).padStart(8)}  ${pct(tally.classes[c], tally.missing).padStart(7)}` +
			`   of which the recorder's own slot: ${tally.own_class[c]}`);
	}
	console.log(`  recorder's own slot altogether: ${tally.own} (${pct(tally.own, tally.missing)} of missing slots)`);
	let steps = Object.keys(tally.steps).map(Number).sort((a, b) => a - b);
	console.log(`\nstep histogram: ${steps.map(s => `${s}:${tally.steps[s]}`).join("  ")}`);
	console.log(`holes spanning a whole cycle (step = players + 1): ${tally.whole_cycle}; wider: ${tally.beyond_cycle}`);
	for (let [players, per] of Object.entries(tally.by_players).sort((a, b) => a[0] - b[0])) {
		console.log(`  ${players} players: ${per.logs} logs, ${per.missing} missing of ${per.slots} slots (${pct(per.missing, per.slots)}), ` +
			`${per.whole_cycle} whole-cycle holes`);
	}
	let at_hole = tally.gap_at_hole.slice().sort((a, b) => a - b);
	let at_step = tally.gap_at_step.slice().sort((a, b) => a - b);
	let cycles = (sorted, p) => quantile(sorted, p) === null ? "-" : quantile(sorted, p).toFixed(2);
	console.log(`\nring pace: ${tally.holes_in_burst} holes sit inside a same-tick burst (${pct(tally.holes_in_burst, tally.holes)}); ` +
		`for the single-slot holes among the rest, the gap between the records either side in ring cycles: ` +
		`p50 ${cycles(at_hole, 0.5)} p90 ${cycles(at_hole, 0.9)} p99 ${cycles(at_hole, 0.99)}, ` +
		`against an ordinary step across a burst boundary p50 ${cycles(at_step, 0.5)} p90 ${cycles(at_step, 0.9)} p99 ${cycles(at_step, 0.99)}` +
		(tally.unpaced_logs ? ` (${tally.unpaced_logs} logs whose ring turns in under ${PACE_MIN_CYCLE} ticks left out of this line)` : ""));
	let worst = files.filter(f => f.moving).sort((a, b) => b.moving - a.moving).slice(0, 10);
	if (worst.length) {
		console.log("\nlogs with MOVING holes (the only candidates for loss):");
		for (let f of worst) console.log(`  ${f.label}: ${f.moving} of ${f.missing} missing slots, ${f.players} players`);
	} else {
		console.log("\nno MOVING hole anywhere: no moving tank ever missed a restatement");
	}
	if (show_samples && samples.length) {
		console.log("\nMOVING holes:");
		for (let s of samples) {
			console.log(`  ${s.label}: slot ${s.owner}, step ${s.step}`);
			console.log(`    owner before: ${describe(s.prev)}`);
			console.log(`    owner after:  ${describe(s.after)}`);
			console.log(`    hole between: ${describe(s.before_hole)}`);
			console.log(`             and: ${describe(s.after_hole)}`);
		}
	}
}

/* ---------- files ---------- */

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

function collect(targets) {
	let files = [];
	for (let target of targets) {
		let stat;
		try {
			stat = fs.statSync(target);
		} catch {
			continue;
		}
		if (stat.isDirectory()) files.push(...walk(target));
		else files.push(target);
	}
	return files;
}

function main() {
	let args = process.argv.slice(2);
	let show_samples = args.includes("--samples");
	let targets = args.filter(arg => !arg.startsWith("--"));
	if (!targets.length) {
		targets = [path.join(ROOT, "fixtures")];
		let corpus = null;
		try {
			corpus = require("./corpus.cjs").resolve_corpus_root();
		} catch {
			corpus = null;
		}
		if (corpus && fs.existsSync(corpus)) targets.push(corpus);
	}
	let tally = empty_tally();
	let files = [], samples = [];
	for (let file of collect(targets)) {
		let bytes;
		try {
			bytes = new Uint8Array(fs.readFileSync(file));
		} catch {
			continue;
		}
		if (bytes.length < 200 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "Bolo") continue;
		let recs = [];
		try {
			for (let rec of BoloLog.records(bytes)) recs.push(rec);
		} catch { /* keep whatever decoded before the damage */ }
		let row = measure_file(recs, tally, samples, replay_label(file));
		if (row) files.push(row);
	}
	report(tally, files, samples, show_samples);
}

module.exports = { empty_tally, measure_file, ring_order, classify, settled };

if (require.main === module) main();
