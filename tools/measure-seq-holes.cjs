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
 * The records tell, because the ring is in the counter: every missing
 * count can be handed to the player whose turn it was (how, below), and
 * classed by what he was doing, read from his nearest records either
 * side:
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
 *   SILENT    no record in the window either side of the hole came
 *             from that slot: a member silent for many cycles, which a
 *             moving tank cannot be.
 *
 * Which slot a missing count belongs to is read from the counter
 * itself, unwrapped: a tank that restates every cycle steps it by
 * exactly the ring size, and every slot owns one residue of it, so a
 * window of records round the hole gives the size, the residues and
 * their owners (see attribute_hole). The ring's membership changes
 * inside a game -- a player joins, a split drops one -- and a window
 * straddling such a change has two players on one residue; its holes go
 * unclassed. Only holes shorter than a cycle are handed to owners. A hole of a whole cycle or more has every
 * slot in it, and the widest -- dozens of slots inside a few seconds --
 * are the counter jumping when a split ring rejoins; they are counted
 * apart. Alongside the classes: the step histogram against the player
 * count, and the pace of the ring
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
const SAMPLES_PER_LOG = 3;       /* moving holes listed per log, so one log cannot fill the list */
const SAMPLES_TOTAL = 60;
const CLASSES = ["moving", "still", "dead", "changing", "edge", "silent"];

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

/* WHO OWNS A MISSING SLOT. The ring's membership changes inside a game
 * and a quiet member -- a dead tank that speaks once in minutes -- is
 * invisible to any reading of who was heard lately, but the counter
 * itself carries the ring: unwrapped, it steps by exactly the ring size
 * between two consecutive records of a tank that restates every cycle,
 * and every slot then owns one residue of it. So each hole is read in a
 * window of nearby records: the ring size is the smallest step any one
 * player's counter makes there, each residue is the player heard on it,
 * and a missing count goes to the player owning its residue -- or to
 * nobody, a SILENT member no record in the window came from, which a
 * moving tank cannot be. A window in which two players share a residue
 * straddles a membership change, and its holes go unclassed. */
const WINDOW = 64;   /* records either side of a hole */

function attribute_hole(span, unwrapped, index) {
	let lo = Math.max(0, index - WINDOW), hi = Math.min(span.length - 1, index + WINDOW);
	let last = new Map(), size = Infinity;
	for (let k = lo; k <= hi; k++) {
		let p = span[k].player;
		if (last.has(p)) {
			let d = unwrapped[k] - last.get(p);
			if (d > 0 && d < size) size = d;
		}
		last.set(p, unwrapped[k]);
	}
	if (!isFinite(size) || size < 2) return null;
	let owner = new Map();
	for (let k = lo; k <= hi; k++) {
		let r = unwrapped[k] % size;
		if (owner.has(r) && owner.get(r) !== span[k].player) return null;
		owner.set(r, span[k].player);
	}
	let slots = [];
	for (let u = unwrapped[index - 1] + 1; u < unwrapped[index]; u++) {
		let p = owner.get(u % size);
		slots.push(p === undefined ? -1 : p);
	}
	return { size, slots };
}

function empty_tally() {
	let tally = { logs: 0, records: 0, slots: 0, holes: 0, missing: 0, chain_ok: 0, chain_bad: 0,
		own: 0, own_class: {}, classes: {}, steps: {}, whole_cycle: 0, beyond_cycle: 0,
		whole_cycle_slots: 0, beyond_cycle_slots: 0, unattributed: 0, attributed: 0,
		holes_in_burst: 0, unpaced_logs: 0, gap_at_hole: [], gap_at_step: [], by_players: {} };
	for (let c of CLASSES) { tally.classes[c] = 0; tally.own_class[c] = 0; }
	return tally;
}

function measure_file(recs, tally, samples, label) {
	let span = settled(recs.filter(rec => rec.tankStatus !== 0x0f));
	if (span.length < MIN_RECORDS) return null;
	/* the counter unwrapped: every step read as network.js reads it */
	let unwrapped = new Int32Array(span.length);
	for (let i = 1; i < span.length; i++) unwrapped[i] = unwrapped[i - 1] + ((span[i].seq - span[i - 1].seq) & 0x7f);
	let sizes = new Map();
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

	let info = null;
	for (let rec of recs) { info = rec.subpackets.find(s => s.type === "game_info"); if (info) break; }
	let file = { label, game: info ? info.gameId : "?", players: 0, recorder, records: span.length, slots: 0, missing: 0, holes: 0, moving: 0, own: 0 };
	let file_samples = 0;
	tally.logs++;
	tally.records += span.length;
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
		let read = attribute_hole(span, unwrapped, i);
		if (!read) { tally.chain_bad++; tally.unattributed += step - 1; continue; }
		let players = read.size;
		sizes.set(players, (sizes.get(players) || 0) + 1);
		let per = tally.by_players[players] = tally.by_players[players] || { logs: new Set(), slots: 0, missing: 0, whole_cycle: 0, holes: 0 };
		per.logs.add(label);
		per.holes++;
		per.missing += step - 1;
		/* a hole of a whole cycle or more is not one node's quiet turn:
		 * every slot is in it, and the widest are the counter jumping
		 * when a split ring rejoins. They are counted apart, and only
		 * the partial-cycle holes are handed to their owners. */
		if (step === players + 1) { tally.whole_cycle++; per.whole_cycle++; tally.whole_cycle_slots += step - 1; continue; }
		if (step > players + 1) { tally.beyond_cycle++; tally.beyond_cycle_slots += step - 1; continue; }
		tally.chain_ok++;
		for (let slot of read.slots) {
			let cls, prev = null, after = null;
			if (slot < 0) cls = "silent";
			else {
				[prev, after] = neighbours(slot, i);
				cls = classify(prev, after);
			}
			tally.classes[cls]++;
			tally.attributed++;
			if (slot === recorder) { tally.own++; tally.own_class[cls]++; file.own++; }
			if (cls === "moving") {
				file.moving++;
				if (file_samples < SAMPLES_PER_LOG && samples.length < SAMPLES_TOTAL) {
					file_samples++;
					samples.push({ label, owner: slot, step, prev, after, before_hole: span[i - 1], after_hole: span[i] });
				}
			}
		}
	}
	tally.slots += file.slots;
	tally.missing += file.missing;
	tally.holes += file.holes;
	let mode = 0, best = 0;
	for (let [size, n] of sizes) if (n > best) { best = n; mode = size; }
	file.players = mode;
	if (tally.by_players[mode]) tally.by_players[mode].slots += file.slots;
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
	console.log(`  of the missing slots: ${tally.attributed} in partial-cycle holes handed to their owners below, ` +
		`${tally.unattributed} in holes read where the ring's membership was changing (unclassed), ` +
		`${tally.whole_cycle_slots} in whole-cycle holes, ${tally.beyond_cycle_slots} in holes wider than a cycle`);
	console.log(`${tally.chain_ok} partial-cycle holes read; ${tally.chain_bad} holes fell in a window where the ring's membership was changing and are set aside`);
	console.log("\nattributed slots by what the owner was doing:");
	for (let c of CLASSES) {
		console.log(`  ${c.padEnd(9)} ${String(tally.classes[c]).padStart(8)}  ${pct(tally.classes[c], tally.attributed).padStart(7)}` +
			`   of which the recorder's own slot: ${tally.own_class[c]}`);
	}
	console.log(`  recorder's own slot altogether: ${tally.own} (${pct(tally.own, tally.attributed)} of attributed slots)`);
	let steps = Object.keys(tally.steps).map(Number).sort((a, b) => a - b);
	console.log(`\nstep histogram: ${steps.map(s => `${s}:${tally.steps[s]}`).join("  ")}`);
	console.log(`holes spanning a whole cycle (step = players + 1): ${tally.whole_cycle}; wider: ${tally.beyond_cycle}`);
	for (let [players, per] of Object.entries(tally.by_players).sort((a, b) => a[0] - b[0])) {
		console.log(`  ring of ${players}: ${per.logs.size} logs, ${per.missing} missing slots in ${per.holes} holes, ` +
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
		console.log("\nlogs with MOVING holes (the only candidates for loss; tools/find-replay.cjs finds a label, tools/find-same-game-replays.cjs a game id):");
		for (let f of worst) console.log(`  ${f.label} (game ${f.game}): ${f.moving} of ${f.missing} missing slots, ${f.players} players`);
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

module.exports = { empty_tally, measure_file, ring_order, attribute_hole, classify, settled };

if (require.main === module) main();
