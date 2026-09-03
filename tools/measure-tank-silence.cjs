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
 * For every record a player sends (attached-log records, `T=F`, carry no
 * player and are ignored) the gap since his previous record is taken.
 * A gap is a LIVE SILENCE when it is shorter than 30 s (the absence
 * bound network.js uses for a machine that is gone) and the record
 * ending it is not a quit. Anything else is a real absence, reported
 * separately. (`T=7` records are counted like any other: a dead tank
 * sends them too, and the viewer takes them as proof of life just the
 * same.) A live silence is IDLE
 * when the tank's position restatements either side of it agree in
 * square, pixel and direction, MOVING otherwise.
 *
 * The output is the distribution of live silences, and for a row of
 * candidate thresholds, how many live silences each would fade and in
 * how many logs -- the false-fade count the viewer's constant should
 * drive to zero, or as near as the corpus allows.
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
let idle = [];    /* ticks */
let moving = [];  /* ticks */
let absences = 0;
let longest = []; /* {file, player, gap, idle, at} */
let per_log_max = new Map();

function scan(file, recs) {
	logs_scanned++;
	records_scanned += recs.length;
	let label = replay_label(file);
	let last = new Array(16).fill(undefined);
	let last_pos = new Array(16).fill(undefined);
	let log_max = 0;
	for (let rec of recs) {
		if (rec.tankStatus === 0x0f) continue;
		let p = rec.player;
		let pos = rec.subpackets.find(s => s.type === "tank_position");
		let quit = rec.subpackets.some(s => s.type === "quit");
		if (last[p] !== undefined) {
			let gap = rec.time - last[p];
			if (gap >= ABSENCE_TICKS || quit) {
				absences++;
				last_pos[p] = undefined;
			} else if (gap > 0) {
				let still = last_pos[p] !== undefined && pos !== undefined &&
					last_pos[p].x === pos.x && last_pos[p].y === pos.y &&
					last_pos[p].pixelX === pos.pixelX && last_pos[p].pixelY === pos.pixelY &&
					last_pos[p].direction === pos.direction;
				(still ? idle : moving).push(gap);
				if (gap > log_max) log_max = gap;
				if (longest.length < SHOW_LONGEST || gap > longest[longest.length - 1].gap) {
					longest.push({ file: label, player: p, gap, idle: still, at: rec.time - recs[0].time });
					longest.sort((a, b) => b.gap - a.gap);
					if (longest.length > SHOW_LONGEST) longest.pop();
				}
			}
		}
		last[p] = rec.time;
		if (pos) last_pos[p] = pos;
		if (quit) { last[p] = undefined; last_pos[p] = undefined; }
	}
	per_log_max.set(label, log_max);
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

idle.sort((a, b) => a - b);
moving.sort((a, b) => a - b);
let live = idle.concat(moving).sort((a, b) => a - b);

console.log(`${logs_scanned} log${logs_scanned === 1 ? "" : "s"}, ${records_scanned} records`);
console.log(`\n[gaps] between consecutive records of one player: ${live.length} live silences, ${absences} absences (>= 30 s, or ended by a quit)`);
for (let [name, a] of [["all live", live], ["idle tank", idle], ["moving tank", moving]]) {
	console.log(`  ${name.padEnd(12)} n=${String(a.length).padStart(8)}  p50 ${seconds(quantile(a, 0.5))} s  p90 ${seconds(quantile(a, 0.9))} s  p99 ${seconds(quantile(a, 0.99))} s  p99.9 ${seconds(quantile(a, 0.999))} s  max ${seconds(quantile(a, 1))} s`);
}

console.log(`\n[histogram] live silences over 2 s, ${BIN_SECONDS} s bins (idle / moving)`);
let bins = new Map();
for (let g of idle) if (g > 2 * TPS) { let b = Math.floor(g / TPS / BIN_SECONDS); bins.set(b, (bins.get(b) || [0, 0])); bins.get(b)[0]++; }
for (let g of moving) if (g > 2 * TPS) { let b = Math.floor(g / TPS / BIN_SECONDS); bins.set(b, (bins.get(b) || [0, 0])); bins.get(b)[1]++; }
for (let [b, [i, m]] of [...bins.entries()].sort((x, y) => x[0] - y[0])) {
	console.log(`  ${String(b * BIN_SECONDS).padStart(3)}-${String((b + 1) * BIN_SECONDS).padEnd(3)} s  ${String(i).padStart(7)} / ${String(m).padStart(7)}`);
}

console.log(`\n[thresholds] live silences a fade-after-N-seconds rule would fade (false fades), and the logs they occur in`);
for (let t of THRESHOLDS) {
	let n = live.filter(g => g > t * TPS).length;
	let logs = [...per_log_max.values()].filter(m => m > t * TPS).length;
	console.log(`  ${String(t).padStart(3)} s  ${String(n).padStart(7)} silences in ${String(logs).padStart(4)} of ${logs_scanned} logs`);
}

console.log(`\n[longest] live silences`);
for (let l of longest) {
	console.log(`  ${seconds(l.gap).padStart(5)} s  ${l.file}  player ${l.player}  ${l.idle ? "idle" : "moving"}  at ${seconds(l.at)} s into the log`);
}
