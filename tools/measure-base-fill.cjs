#!/usr/bin/env node
/* Does a base go on paying out once the tank on it is full?
 *
 * The owner checked this on the real game: a full tank parked on a
 * friendly base takes nothing from it, the base's shell and mine counts
 * hold still. This tool asks the logs the companion question: does the
 * game go on LOGGING `Bn`/`Cn` drains at a full tank, or does the stream
 * simply stop?
 *
 * Every stint of a tank sitting on a base square is found from tank
 * positions alone (a stint ends when the tank moves off the square, dies,
 * or falls silent for 15 s), and for each stint the drains of that base
 * are counted against the tank's shots and mines laid. Two signatures:
 *
 *   drains keep coming at a full tank => in a long stint the last drain
 *       sits near the END, and shell drains minus shots runs far past 40
 *       (a base holds 90, and every player's tick adds more);
 *   drains stop at a full tank => the last drain sits EARLY, within the
 *       ~21 s an empty tank takes to fill, and drains minus shots never
 *       exceeds 40, the tank's capacity.
 *
 * Usage:
 *   node tools/measure-base-fill.cjs [corpus-dir]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const {corpus_root, replay_label} = require("./corpus.cjs");

const ROOT = process.argv[2] || corpus_root();
const LONG_STINT = 50 * 60;        // 60 s, three times the empty-to-full time
const SILENCE = 50 * 15;           // a player silent for 15 s ends the stint

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

let stints = [];
let logs = 0;

function scan(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		return;
	}
	if (!recs.length) return;
	logs++;

	let bases = null;
	for (let rec of recs) {
		for (let sub of rec.subpackets) {
			if (sub.type === "base_list") {
				bases = sub.items;
				break;
			}
		}
		if (bases) break;
	}
	if (!bases) return;
	let base_at = new Map();
	bases.forEach((b, i) => base_at.set(b.x * 256 + b.y, i));

	let current = new Array(16).fill(null);
	let square = new Array(16).fill(-1);
	let last_seen = new Array(16).fill(-1);
	let t_prev = null;
	let t_offset = 0;

	function close(p, t_end, why) {
		let s = current[p];
		current[p] = null;
		if (!s) return;
		s.t_end = t_end;
		s.why = why;
		if (s.shells.length || s.mines.length) stints.push(s);
	}

	for (let rec of recs) {
		let t = rec.time;
		if (t_prev !== null && t < t_prev - 0x40000000) t_offset += 0x100000000;
		t_prev = t;
		t += t_offset;
		let p = rec.player;
		if (last_seen[p] >= 0 && t - last_seen[p] > SILENCE) close(p, last_seen[p], "silence");
		last_seen[p] = t;

		let pos = null;
		for (let sub of rec.subpackets) {
			if (sub.type === "tank_position") {
				pos = sub;
				break;
			}
		}
		if (pos) {
			let key = pos.x * 256 + pos.y;
			if (pos.dying) {
				close(p, t, "death");
				square[p] = -1;
			} else if (key !== square[p]) {
				close(p, t, "moved");
				square[p] = key;
				if (base_at.has(key)) {
					current[p] = {
						file, player: p, base: base_at.get(key), t_start: t,
						shells: [], mines: [], shots: 0, mines_laid: 0, man_plants: 0,
					};
				}
			}
		}

		let s = current[p];
		if (!s) continue;
		for (let sub of rec.subpackets) {
			if (sub.type === "base_drain" && sub.base === s.base) {
				if (sub.resource === "shells") s.shells.push(t);
				else if (sub.resource === "mines") s.mines.push(t);
			} else if (sub.type === "shot_fired") {
				s.shots++;
			} else if (sub.type === "lay_mine") {
				s.mines_laid++;
			} else if (sub.type === "explosion" && sub.code === 0x0c) {
				s.man_plants++;      // the man plants a mine (`7C`), from the tank's stock
			} else if (sub.type === "tank_death") {
				close(p, t, "death");
				break;
			}
		}
	}
	for (let p = 0; p < 16; p++) close(p, last_seen[p], "eof");
}

for (let file of walk(ROOT)) scan(file);

let rows = stints.map(s => ({
	...s,
	dur: (s.t_end - s.t_start) / 50,
	net_shells: s.shells.length - s.shots,
	net_mines: s.mines.length - s.mines_laid - s.man_plants,
	tail_shells: s.shells.length ? (s.t_end - s.shells[s.shells.length - 1]) / 50 : null,
	tail_mines: s.mines.length ? (s.t_end - s.mines[s.mines.length - 1]) / 50 : null,
}));
let long = rows.filter(r => r.dur * 50 >= LONG_STINT);

console.log(`${logs} logs; ${rows.length} stints on a base with a shell or mine drain, ${long.length} of them 60 s or longer`);
console.log();

/* bands is a list of [label, lo, hi] with hi exclusive */
function histogram(title, values, bands) {
	console.log(title);
	for (let [label, lo, hi] of bands) {
		let n = values.filter(v => v !== null && v >= lo && v < hi).length;
		console.log(`    ${label.padEnd(10)} ${String(n).padStart(5)}`);
	}
	console.log();
}

const NET_BANDS = [["<= 0", -Infinity, 1], ["1-20", 1, 21], ["21-40", 21, 41], ["41-60", 41, 61], ["61-100", 61, 101], ["101+", 101, Infinity]];
const TAIL_BANDS = [["0-5", 0, 5], ["5-15", 5, 15], ["15-30", 15, 30], ["30-60", 30, 60], ["60-120", 60, 120], ["120+", 120, Infinity]];

console.log("--- the ceiling: drains minus spends per stint, every stint ---");
console.log("A base holds 90 of each and the ticks add more, so a stream that");
console.log("ignored the tank would run these well past 40.");
console.log();
histogram("shell drains minus shots:", rows.map(r => r.net_shells), NET_BANDS);
histogram("mine drains minus mines laid (by the tank or by the man):", rows.map(r => r.net_mines), NET_BANDS);
console.log(`max shell drains minus shots: ${Math.max(...rows.map(r => r.net_shells))}`);
console.log(`max mine drains minus mines laid: ${Math.max(...rows.map(r => r.net_mines))}`);
console.log();

console.log("--- the tail: seconds from the last shell drain to the end of a 60 s+ stint ---");
console.log("A stream that ran on at a full tank would end near 0.");
console.log();
histogram("tail, shells:", long.map(r => r.tail_shells), TAIL_BANDS);
histogram("tail, mines:", long.map(r => r.tail_mines), TAIL_BANDS);

console.log("--- every stint of 60 s or more ---");
console.log("  dur is seconds on the square; lastSh/lastMi are seconds from the last");
console.log("  shell/mine drain to the end of the stint; why is how the stint ended.");
console.log();
console.log("    dur  base  shells shots  net  mines  laid  man  net  lastSh lastMi  why      replay");
let f = (v, w) => String(v === null ? "-" : Number.isInteger(v) ? v : v.toFixed(0)).padStart(w);
for (let r of long.sort((a, b) => b.dur - a.dur)) {
	console.log(`  ${f(r.dur, 5)} ${f(r.base, 5)} ${f(r.shells.length, 7)} ${f(r.shots, 5)} ${f(r.net_shells, 4)} ${f(r.mines.length, 6)} ${f(r.mines_laid, 5)} ${f(r.man_plants, 4)} ${f(r.net_mines, 4)} ${f(r.tail_shells, 7)} ${f(r.tail_mines, 6)}  ${r.why.padEnd(8)} ${replay_label(r.file)}`);
}
