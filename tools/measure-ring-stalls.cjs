#!/usr/bin/env node
/* A silence in the log is not a freeze.  Which of them are?
 *
 * The stall reading of viewer/network.js charges the share of settled play
 * spent in gaps where nothing at all arrived for over half a second.  That
 * conflates two things the log keeps apart:
 *
 *   THE RING STOPPED.  A packet held up on its way round, which every
 *   machine in the game feels as a freeze.  This is the thing worth rating.
 *
 *   THE RING TURNED AND NOBODY SPOKE.  A record is written only when a node
 *   has something to say, so a game whose players have all parked their
 *   tanks goes quiet while the ring turns at full speed.  A stationary tank
 *   restates only every 4 to 8 s [E:idle-silence] -- eight to sixteen times
 *   the half second the stall reading calls a freeze -- so an idle game
 *   books almost all of its elapsed time as frozen.  It is worst in a
 *   two-player game, where the two tanks are the only voices there are and
 *   nothing else can fill the silence.
 *
 * THE SLOT COUNTER TELLS THEM APART.  The game's ring needs its packet back
 * to go on, so a stopped ring cannot step the counter, and whatever repairs
 * a held-up packet leaves the counter unbroken [E:seq-loss].  A ring that
 * turned through the silence steps it once per node per lap.  So a silence
 * is a freeze only when the counter advanced by no more than one ring's
 * worth of slots: the ring did not get round even once.  The allowance is a
 * whole ring rather than a single slot because the nodes taking the next
 * turns as it resumes may have nothing to log, and a quiet slot steps the
 * counter just the same.
 *
 * The test can only clear a silence, never convict one.  The counter is 7
 * bits, so a silence past 128 slots can wrap and alias a large step down
 * into the frozen range -- which misreads an idle stretch as a freeze, what
 * the reading did for every silence before the gate.  A stopped ring has no
 * large step to alias from, so a real freeze is never cleared.
 *
 * This script reports, per log and over a corpus:
 *   -- the stall figure before and after the gate, and the rating each
 *      gives, so the cost of the gate to logs that really did freeze is on
 *      the record next to what it takes off the ones that did not;
 *   -- THE STEP CENSUS: every silence over half a second, bucketed by how
 *      far the counter moved.  This is the claim the gate rests on, and it
 *      is falsifiable: if the two populations overlap, the gate is wrong;
 *   -- THE PARKED GAMES: the longest run of consecutive silences the gate
 *      clears in each log, with how many distinct positions each tank
 *      states across those silences.  A run of minutes over which every
 *      tank states one or two is players who got up and left, not a
 *      network.
 *
 * Usage: node tools/measure-ring-stalls.cjs [corpus-root | logfile ...]
 *        node tools/measure-ring-stalls.cjs --samples [...]   per-log detail
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { replay_label } = require("./corpus.cjs");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloNetwork = require(path.join(__dirname, "..", "viewer", "network.js"));

const SAMPLES = process.argv.includes("--samples");
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const TICKS_PER_SECOND = 50;
const STALL_GAP_TICKS = TICKS_PER_SECOND / 2;
const ABSENCE_TICKS = 1500;
const RUN_JOIN_TICKS = 500;     /* silences this close belong to one parked run */
const MIN_RECORDS = 2000;
const NAMES = ["good", "fair", "bad", "awful"];

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, {withFileTypes: true});
	} catch {
		return;
	}
	for (let entry of entries) {
		let item = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(item);
		else if (entry.isFile() && !/\.(txt|md|json|zip|sit|hqx|png|jpg|gif)$/i.test(entry.name))
			yield item;
	}
}

function* inputs() {
	let roots = args.length ? args : [require("./corpus.cjs").corpus_root()];
	for (let root of roots) {
		if (fs.existsSync(root) && fs.statSync(root).isDirectory()) yield* walk(root);
		else yield root;
	}
}

function mmss(ticks) {
	return `${Math.floor(ticks / (60 * TICKS_PER_SECOND))}:` +
		`${String(Math.floor(ticks / TICKS_PER_SECOND) % 60).padStart(2, "0")}`;
}

/* Every distinct tank position a slot states across a set of records, as
 * square + pixel + direction. One apiece is a tank that did not move. */
function tank_states(records) {
	let states = new Map();
	for (const rec of records) {
		for (const sub of rec.subpackets) {
			if (sub.type !== "tank_position") continue;
			let player = rec.player & 0x0f;
			if (!states.has(player)) states.set(player, new Set());
			states.get(player).add(`${sub.x},${sub.y},${sub.pixelX},${sub.pixelY},${sub.direction}`);
		}
	}
	return states;
}

function read_log(file) {
	let bytes;
	try {
		bytes = new Uint8Array(fs.readFileSync(file));
	} catch {
		return null;
	}
	if (bytes.length < 200) return null;
	if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "Bolo") return null;
	let recs = [];
	try {
		for (let rec of BoloLog.records(bytes)) recs.push(rec);
	} catch { /* keep whatever decoded before the damage */ }
	if (recs.length < MIN_RECORDS) return null;

	let whole = BoloNetwork.network_conditions(recs);
	if (!whole) return null;
	let span = recs.filter(rec => rec.time >= whole.from && rec.time <= whole.to);
	let players = BoloNetwork.ring_size(span);
	let elapsed = whole.to - whole.from;

	/* every silence over half a second, with what the counter did across it */
	let silences = [];
	for (let i = 1; i < span.length; i++) {
		let gap = span[i].time - span[i - 1].time;
		if (gap <= STALL_GAP_TICKS || gap > ABSENCE_TICKS) continue;
		let step = (span[i].seq - span[i - 1].seq) & 0x7f;
		silences.push({
			at: span[i - 1].time, index: i, gap, step,
			froze: BoloNetwork.ring_stopped(step, players),
		});
	}
	let froze = silences.filter(s => s.froze).reduce((a, s) => a + s.gap, 0);
	let cleared = silences.filter(s => !s.froze).reduce((a, s) => a + s.gap, 0);

	/* the longest run of consecutive cleared silences: the parked stretch */
	let runs = [], current = null;
	for (const silence of silences) {
		if (silence.froze) continue;
		if (current && silence.at - current.to <= RUN_JOIN_TICKS) {
			current.to = silence.at + silence.gap;
		} else {
			if (current) runs.push(current);
			current = {from: silence.at, to: silence.at + silence.gap, edges: []};
		}
		/* the records either side of the silence, which is where a tank that
		 * moved across it would say so */
		current.edges.push(span[silence.index - 1], span[silence.index]);
	}
	if (current) runs.push(current);
	runs.sort((a, b) => (b.to - b.from) - (a.to - a.from));
	let parked = runs[0] || null;
	if (parked) {
		/* Read off the silences' own edges rather than every record of the
		 * run: a run can swallow a burst of play between two silences, and
		 * the question here is whether the tanks moved ACROSS the quiet. */
		let states = tank_states(parked.edges);
		parked.slots = states.size;
		parked.states = [...states.values()].map(set => set.size).sort((a, b) => b - a);
	}

	return {
		file: replay_label(file), players, elapsed, whole, silences,
		before: 100 * (froze + cleared) / elapsed,
		after: 100 * froze / elapsed,
		before_rating: BoloNetwork.network_rating(100 * (froze + cleared) / elapsed, whole.cycle),
		after_rating: whole.rating,
		parked, runs: runs.length,
	};
}

/* ---------- the corpus ---------- */

let rows = [];
for (let file of inputs()) {
	let row = read_log(file);
	if (row) rows.push(row);
}
if (rows.length === 0) {
	console.log("no scoreable logs");
	process.exit(1);
}
console.log(`${rows.length} logs scored\n`);

/* THE STEP CENSUS -- the gate's whole case, laid out to be falsified. */
console.log("step census: every silence over half a second, by how far the");
console.log("slot counter moved across it (a stopped ring cannot move it past");
console.log("one ring's worth of slots, which the ring column gives):\n");
console.log("  ring   step 0-1   2-3    4-6   7-15  16-31    32+   |  ring stopped");
let by_ring = new Map();
for (let row of rows) {
	if (!by_ring.has(row.players)) by_ring.set(row.players, {buckets: new Array(6).fill(0), froze: 0});
	let entry = by_ring.get(row.players);
	for (const silence of row.silences) {
		let b = silence.step <= 1 ? 0 : silence.step <= 3 ? 1 : silence.step <= 6 ? 2
			: silence.step <= 15 ? 3 : silence.step <= 31 ? 4 : 5;
		entry.buckets[b]++;
		if (silence.froze) entry.froze++;
	}
}
for (let n of [...by_ring.keys()].sort((a, b) => a - b)) {
	let entry = by_ring.get(n);
	console.log(`  ${String(n).padStart(4)}  ` +
		entry.buckets.map(c => String(c).padStart(6)).join(" ") +
		`   |  ${String(entry.froze).padStart(6)}`);
}

/* What the gate costs and what it buys. */
let moved = rows.filter(r => r.before_rating !== r.after_rating);
let touched = rows.filter(r => r.before - r.after > 0.05);
console.log(`\nthe gate clears silence in ${touched.length} of ${rows.length} logs ` +
	`and moves the rating of ${moved.length}:`);
let deltas = rows.map(r => r.before - r.after).sort((a, b) => b - a);
console.log(`  stall points cleared: max=${deltas[0].toFixed(1)} ` +
	`p90=${deltas[Math.floor(0.1 * (deltas.length - 1))].toFixed(1)} ` +
	`p50=${deltas[deltas.length >> 1].toFixed(1)}`);
let bands = new Map(NAMES.map(n => [n, [0, 0]]));
for (let row of rows) {
	bands.get(row.before_rating)[0]++;
	bands.get(row.after_rating)[1]++;
}
for (let name of NAMES) {
	let [was, now] = bands.get(name);
	console.log(`  ${name.padEnd(6)} ${String(was).padStart(4)} -> ${String(now).padStart(4)}`);
}

/* THE PARKED GAMES -- the silences the gate clears, and whether the tanks
 * moved a pixel across them. */
console.log("\nthe longest cleared run in each log, worst first:");
let parked = rows.filter(r => r.parked).sort((a, b) =>
	(b.parked.to - b.parked.from) - (a.parked.to - a.parked.from));
for (let row of parked.slice(0, 20)) {
	let run = row.parked;
	let length = (run.to - run.from) / TICKS_PER_SECOND / 60;
	console.log(`  ${row.file.padEnd(16)} ${mmss(run.from - row.whole.from)} -> ` +
		`${mmss(run.to - row.whole.from)}  ${length.toFixed(1).padStart(5)} min  ` +
		`${row.players}p cycle=${String(row.whole.cycle).padStart(2)}  ` +
		`positions/tank ${run.states.join(",") || "-"}  ` +
		`stall ${row.before.toFixed(1)}% -> ${row.after.toFixed(1)}% ` +
		`(${row.before_rating} -> ${row.after_rating})`);
}

if (SAMPLES) {
	console.log("\nper log:");
	for (let row of rows.sort((a, b) => (b.before - b.after) - (a.before - a.after))) {
		console.log(`  ${row.file.padEnd(16)} ${row.players}p ` +
			`silences=${String(row.silences.length).padStart(5)} ` +
			`(${String(row.silences.filter(s => s.froze).length).padStart(4)} froze) ` +
			`stall ${row.before.toFixed(2).padStart(6)}% -> ${row.after.toFixed(2).padStart(6)}%  ` +
			`${row.before_rating.padEnd(6)} -> ${row.after_rating}`);
	}
}
