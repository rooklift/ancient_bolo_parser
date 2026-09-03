#!/usr/bin/env node
/* How long can a live player go without sending anything?
 *
 * The viewer fades a tank whose sender has been silent for a while,
 * meaning ring-split ghosts and machines that vanished without a quit
 * record. The fade rides on the gap since the sender's LAST RECORD OF
 * ANY KIND (game.js keeps `lastSeen` from every record, since a
 * stationary tank restates its position far less often than a moving
 * one). The threshold has to clear the silences a player who is simply
 * sitting still produces, or idle tanks fade for no reason -- which is
 * what happened at 5 s: a stationary tank restates its position only
 * every few seconds, and during the gathering phase, before anyone is
 * shooting or draining a base, nothing else from him fills the gap.
 *
 * Two silences are measured for every record a player sends (attached-
 * log records, `T=F`, carry no player and are ignored):
 *
 *   WALL: the time since his previous record. This is what a fade
 *   keyed to the playback clock sees, and it cannot tell a ghost from a
 *   STALL -- a stretch in which nothing from anyone reached the logging
 *   machine.
 *
 *   RING: the time from his previous record to the latest record from
 *   anyone stamped strictly earlier than his next one -- how long the
 *   ring was heard turning without him. Through a stall it stays put;
 *   and a burst of records at one tick, the usual end of a stall, does
 *   not count against the players in the burst, which is how the viewer
 *   sees it too (it applies every record at a tick before drawing).
 *
 *   CYCLES: the most records heard from any one other player across
 *   the silence -- how many times the ring went round without him. A
 *   CRAWL, the ring freezing for everyone, reads long by time but one
 *   or two by cycles (the corpus has 29 s stretches with every player
 *   heard exactly once); a split reads sixty and more, one voice heard
 *   over and over.
 *
 * The viewer's fade reads the playback clock, the WALL column, at 15 s.
 * The other two are the readings a subtler rule would use, measured so
 * the difference is on record: they buy a few dozen events corpus-wide,
 * not enough for the state they would need.
 *
 * A gap is a LIVE SILENCE when its wall reading is under 30 s (the
 * absence bound network.js uses for a machine that is gone) and the
 * record ending it is not a quit; anything else is a real absence,
 * reported separately. (`T=7` records count like any other: a dead tank
 * sends them too, and the viewer takes them as proof of life just the
 * same.) A live silence is IDLE when the tank's position restatements
 * either side of it agree in square, pixel and direction, MOVING
 * otherwise. The idle ones are the fade's false positives beyond
 * doubt; a long silence from a tank that moved meanwhile may be a
 * split the log really did see, so the longest are listed with WHO WAS
 * HEARD during them -- one voice alone, over and over, is the logging
 * machine talking to itself across a split, one record from everyone
 * is a crawl.
 *
 * ABSENCES are not dropped on the floor: each is classed by what ended
 * it (a quit; a `T=7` joining record, the slot being re-admitted; an
 * ordinary record) and by where the tank came back (the same square and
 * pixel it left, elsewhere, or with no position at all). The class to
 * watch is SAME SPOT / ORDINARY: a player who sat still through more
 * than 30 s of silence and then simply carried on, which is the one
 * thing that would mean an idle connected machine can stop sending.
 *
 * Usage: node tools/measure-tank-silence.cjs [file | directory ...]
 * With no argument the corpus root from corpus.json / BOLO_CORPUS is read.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { corpus_root, replay_label } = require("./corpus.cjs");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));

const TPS = BoloLog.TICKS_PER_SECOND;
const ABSENCE_TICKS = 30 * TPS;
const THRESHOLDS = [3, 5, 8, 10, 12, 15, 20, 25];
const CYCLES = 5; /* ring cycles heard, for the combined column */
const BIN_SECONDS = 1;
const SHOW_LONGEST = 16;

let logs_scanned = 0;
let records_scanned = 0;
let silences = []; /* {wall, ring, cycles, idle}, times in ticks */
let absences = []; /* {file, player, wall, cycles, end, where, at} */
let longest = []; /* {file, player, wall, ring, cycles, idle, at, heard} by ring */
let per_log_max = { wall: new Map(), ring: new Map(), both: new Map() };

function scan(file, recs) {
	logs_scanned++;
	records_scanned += recs.length;
	let label = replay_label(file);
	let last = new Array(16).fill(undefined);
	let last_pos = new Array(16).fill(undefined);
	let heard = Array.from({ length: 16 }, () => new Array(16).fill(0));
	let tick_now = -Infinity;    /* the latest record time */
	let tick_before = -Infinity; /* the latest record time strictly before it */
	let max_wall = 0, max_ring = 0, max_both = 0;
	for (let rec of recs) {
		if (rec.time > tick_now) {
			tick_before = tick_now;
			tick_now = rec.time;
		}
		if (rec.tankStatus === 0x0f) continue;
		let p = rec.player;
		let pos = rec.subpackets.find(s => s.type === "tank_position");
		let quit = rec.subpackets.some(s => s.type === "quit");
		if (last[p] !== undefined) {
			let wall = rec.time - last[p];
			let ring = Math.max(0, tick_before - last[p]);
			if (wall >= ABSENCE_TICKS || quit) {
				let end = quit ? "quit" : rec.tankStatus === 0x07 ? "join" : "ordinary";
				let where = !pos ? "no position" : last_pos[p] === undefined ? "no position before" :
					(last_pos[p].x === pos.x && last_pos[p].y === pos.y &&
					last_pos[p].pixelX === pos.pixelX && last_pos[p].pixelY === pos.pixelY) ? "same spot" : "moved";
				absences.push({ file: label, player: p, wall, cycles: Math.max(...heard[p]), end, where, at: rec.time - recs[0].time });
				last_pos[p] = undefined;
			} else if (wall > 0) {
				let idle = last_pos[p] !== undefined && pos !== undefined &&
					last_pos[p].x === pos.x && last_pos[p].y === pos.y &&
					last_pos[p].pixelX === pos.pixelX && last_pos[p].pixelY === pos.pixelY &&
					last_pos[p].direction === pos.direction;
				let cycles = Math.max(...heard[p]);
				silences.push({ wall, ring, cycles, idle });
				if (wall > max_wall) max_wall = wall;
				if (ring > max_ring) max_ring = ring;
				if (cycles >= CYCLES && ring > max_both) max_both = ring;
				if (longest.length < SHOW_LONGEST || ring > longest[longest.length - 1].ring) {
					let voices = heard[p].map((n, q) => n ? `p${q}:${n}` : null).filter(Boolean).join(" ");
					longest.push({ file: label, player: p, wall, ring, cycles, idle, at: rec.time - recs[0].time, heard: voices || "nobody" });
					longest.sort((a, b) => b.ring - a.ring);
					if (longest.length > SHOW_LONGEST) longest.pop();
				}
			}
		}
		last[p] = rec.time;
		heard[p].fill(0);
		for (let q = 0; q < 16; q++) if (q !== p) heard[q][p]++;
		if (pos) last_pos[p] = pos;
		if (quit) { last[p] = undefined; last_pos[p] = undefined; }
	}
	per_log_max.wall.set(label, max_wall);
	per_log_max.ring.set(label, max_ring);
	per_log_max.both.set(label, max_both);
}

function* walk(target) {
	let stat;
	try {
		stat = fs.statSync(target);
	} catch {
		return;
	}
	if (stat.isFile()) {
		yield target;
		return;
	}
	let entries;
	try {
		entries = fs.readdirSync(target, {withFileTypes: true});
	} catch {
		return;
	}
	for (let entry of entries) {
		let item = path.join(target, entry.name);
		if (entry.isDirectory())
			yield* walk(item);
		else if (entry.isFile() && !/\.(txt|md|json|zip|sit|hqx|png|jpg|gif)$/i.test(entry.name))
			yield item;
	}
}

function quantile(sorted, q) {
	if (!sorted.length) return 0;
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

function seconds(ticks) {
	return (ticks / TPS).toFixed(1);
}

function summary(name, values) {
	let a = values.slice().sort((x, y) => x - y);
	return `  ${name.padEnd(12)} n=${String(a.length).padStart(9)}  p50 ${seconds(quantile(a, 0.5))} s  p90 ${seconds(quantile(a, 0.9))} s  p99 ${seconds(quantile(a, 0.99))} s  p99.9 ${seconds(quantile(a, 0.999))} s  max ${seconds(quantile(a, 1))} s`;
}

function histogram(title, key) {
	console.log(`\n[${title}] live silences over 2 s, ${BIN_SECONDS} s bins (idle / moving)`);
	let bins = new Map();
	for (let s of silences) {
		if (s[key] <= 2 * TPS) continue;
		let b = Math.floor(s[key] / TPS / BIN_SECONDS);
		if (!bins.has(b)) bins.set(b, [0, 0]);
		bins.get(b)[s.idle ? 0 : 1]++;
	}
	for (let [b, [i, m]] of [...bins.entries()].sort((x, y) => x[0] - y[0])) {
		console.log(`  ${String(b * BIN_SECONDS).padStart(3)}-${String((b + 1) * BIN_SECONDS).padEnd(3)} s  ${String(i).padStart(7)} / ${String(m).padStart(7)}`);
	}
}

let args = process.argv.slice(2).filter(a => !a.startsWith("--"));
let targets = args.length ? args : [corpus_root()];
for (let target of targets) {
	for (let file of walk(target)) {
		let recs;
		try {
			recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
		} catch {
			continue;
		}
		if (recs.length < 2) continue;
		scan(file, recs);
	}
}
if (!logs_scanned) {
	console.error("no logs found");
	process.exit(2);
}

console.log(`${logs_scanned} log${logs_scanned === 1 ? "" : "s"}, ${records_scanned} records`);
console.log(`\n[gaps] between consecutive records of one player: ${silences.length} live silences, ${absences.length} absences (>= 30 s, or ended by a quit)`);
for (let [title, key] of [["wall clock", "wall"], ["ring heard turning", "ring"]]) {
	console.log(`  ${title}:`);
	console.log(summary("all live", silences.map(s => s[key])));
	console.log(summary("idle tank", silences.filter(s => s.idle).map(s => s[key])));
	console.log(summary("moving tank", silences.filter(s => !s.idle).map(s => s[key])));
}

histogram("histogram, wall clock", "wall");
histogram("histogram, ring", "ring");

console.log(`\n[thresholds] live silences a fade-after-N-seconds rule would fade, idle / moving, and the logs any occur in (of ${logs_scanned})`);
console.log(`         wall clock                          ring                                ring, and ${CYCLES}+ cycles heard`);
for (let t of THRESHOLDS) {
	let row = [];
	for (let key of ["wall", "ring", "both"]) {
		let hit = s => (key === "both" ? s.ring > t * TPS && s.cycles >= CYCLES : s[key] > t * TPS);
		let idle = silences.filter(s => s.idle && hit(s)).length;
		let moving = silences.filter(s => !s.idle && hit(s)).length;
		let logs = [...per_log_max[key].values()].filter(m => m > t * TPS).length;
		row.push(`${String(idle).padStart(6)} / ${String(moving).padStart(6)} in ${String(logs).padStart(4)} logs`);
	}
	console.log(`  ${String(t).padStart(3)} s  ${row.join("     ")}`);
}

console.log(`\n[absences] silences of 30 s and more, by what ended them and where the tank came back`);
{
	let table = new Map();
	for (let a of absences) {
		let key = `${a.end.padEnd(9)} / ${a.where}`;
		table.set(key, (table.get(key) || 0) + 1);
	}
	for (let [key, n] of [...table.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${key.padEnd(32)} ${String(n).padStart(6)}`);
	let watch = absences.filter(a => a.end === "ordinary" && a.where === "same spot").sort((x, y) => x.wall - y.wall);
	console.log(`  same spot / ordinary, by length: ${[[30, 45], [45, 60], [60, 120], [120, 300], [300, Infinity]].map(([lo, hi]) =>
		`${lo}-${hi === Infinity ? "" : hi} s: ${watch.filter(a => a.wall >= lo * TPS && a.wall < hi * TPS).length}`).join("  ")}`);
	console.log(`  the shortest of them, with the ring cycles heard meanwhile:`);
	for (let a of watch.slice(0, SHOW_LONGEST)) {
		console.log(`    ${seconds(a.wall).padStart(6)} s  ${String(a.cycles).padStart(5)} cycles  ${a.file}  player ${a.player}  at ${seconds(a.at)} s`);
	}
}

console.log(`\n[longest] live silences by the ring reading, with the records heard from others meanwhile`);
for (let l of longest) {
	console.log(`  ring ${seconds(l.ring).padStart(5)} s  wall ${seconds(l.wall).padStart(5)} s  ${String(l.cycles).padStart(4)} cycles  ${l.file}  player ${l.player}  ${l.idle ? "idle  " : "moving"}  at ${seconds(l.at)} s  heard: ${l.heard}`);
}
