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
 *   machine, which the corpus shows lasting up to the 30 s bound below,
 *   every player silent together.
 *
 *   RING: the time from his previous record to the last record from
 *   ANYONE before this one -- how long the ring was heard turning
 *   without him. During a stall it is zero: nobody is a ghost when
 *   nobody is heard. This is what the viewer keys its fade to.
 *
 * A gap is a LIVE SILENCE when its wall reading is under 30 s (the
 * absence bound network.js uses for a machine that is gone) and the
 * record ending it is not a quit; anything else is a real absence,
 * reported separately. (`T=7` records count like any other: a dead tank
 * sends them too, and the viewer takes them as proof of life just the
 * same.) A live silence is IDLE when the tank's position restatements
 * either side of it agree in square, pixel and direction, MOVING
 * otherwise.
 *
 * The output is the distribution of both readings, and for a row of
 * candidate thresholds, how many live silences each would fade under
 * each reading and in how many logs -- the false-fade count the
 * viewer's constant should drive to zero, or as near as the corpus
 * allows.
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
const BIN_SECONDS = 1;
const SHOW_LONGEST = 12;

let logs_scanned = 0;
let records_scanned = 0;
let silences = []; /* {wall, ring, idle} in ticks */
let absences = 0;
let longest = []; /* {file, player, wall, ring, idle, at} by ring */
let per_log_max_wall = new Map();
let per_log_max_ring = new Map();

function scan(file, recs) {
	logs_scanned++;
	records_scanned += recs.length;
	let label = replay_label(file);
	let last = new Array(16).fill(undefined);
	let last_pos = new Array(16).fill(undefined);
	let last_any = undefined; /* time of the latest record from anyone */
	let max_wall = 0, max_ring = 0;
	for (let rec of recs) {
		if (rec.tankStatus === 0x0f) {
			last_any = rec.time;
			continue;
		}
		let p = rec.player;
		let pos = rec.subpackets.find(s => s.type === "tank_position");
		let quit = rec.subpackets.some(s => s.type === "quit");
		if (last[p] !== undefined) {
			let wall = rec.time - last[p];
			let ring = last_any - last[p];
			if (wall >= ABSENCE_TICKS || quit) {
				absences++;
				last_pos[p] = undefined;
			} else if (wall > 0) {
				let idle = last_pos[p] !== undefined && pos !== undefined &&
					last_pos[p].x === pos.x && last_pos[p].y === pos.y &&
					last_pos[p].pixelX === pos.pixelX && last_pos[p].pixelY === pos.pixelY &&
					last_pos[p].direction === pos.direction;
				silences.push({ wall, ring, idle });
				if (wall > max_wall) max_wall = wall;
				if (ring > max_ring) max_ring = ring;
				if (longest.length < SHOW_LONGEST || ring > longest[longest.length - 1].ring) {
					longest.push({ file: label, player: p, wall, ring, idle, at: rec.time - recs[0].time });
					longest.sort((a, b) => b.ring - a.ring);
					if (longest.length > SHOW_LONGEST) longest.pop();
				}
			}
		}
		last[p] = rec.time;
		last_any = rec.time;
		if (pos) last_pos[p] = pos;
		if (quit) { last[p] = undefined; last_pos[p] = undefined; }
	}
	per_log_max_wall.set(label, max_wall);
	per_log_max_ring.set(label, max_ring);
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
console.log(`\n[gaps] between consecutive records of one player: ${silences.length} live silences, ${absences} absences (>= 30 s, or ended by a quit)`);
for (let [title, key] of [["wall clock", "wall"], ["ring heard turning", "ring"]]) {
	console.log(`  ${title}:`);
	console.log(summary("all live", silences.map(s => s[key])));
	console.log(summary("idle tank", silences.filter(s => s.idle).map(s => s[key])));
	console.log(summary("moving tank", silences.filter(s => !s.idle).map(s => s[key])));
}

histogram("histogram, wall clock", "wall");
histogram("histogram, ring", "ring");

console.log(`\n[thresholds] live silences a fade-after-N-seconds rule would fade (false fades), and the logs they occur in`);
console.log(`         wall clock                       ring`);
for (let t of THRESHOLDS) {
	let n_wall = silences.filter(s => s.wall > t * TPS).length;
	let n_ring = silences.filter(s => s.ring > t * TPS).length;
	let logs_wall = [...per_log_max_wall.values()].filter(m => m > t * TPS).length;
	let logs_ring = [...per_log_max_ring.values()].filter(m => m > t * TPS).length;
	console.log(`  ${String(t).padStart(3)} s  ${String(n_wall).padStart(7)} in ${String(logs_wall).padStart(4)} logs    ${String(n_ring).padStart(7)} in ${String(logs_ring).padStart(4)} logs   (of ${logs_scanned})`);
}

console.log(`\n[longest] live silences by the ring reading`);
for (let l of longest) {
	console.log(`  ring ${seconds(l.ring).padStart(5)} s  wall ${seconds(l.wall).padStart(5)} s  ${l.file}  player ${l.player}  ${l.idle ? "idle" : "moving"}  at ${seconds(l.at)} s into the log`);
}
