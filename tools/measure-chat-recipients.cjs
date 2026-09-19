#!/usr/bin/env node
/* Who do non-broadcast chat messages go to?
 *
 * Bolo's chat dialog offers four targets the owner has seen in the
 * emulator: everyone, allies, nearby tanks, and any single player. The
 * log carries only the `FA` recipient bitmask, `FFFF` for everyone, so
 * the other three have to be told apart by the shape of the set. The
 * corpus (`docs/corpus_runs/`, chat-recipients) settled the shapes:
 *
 *   - every message the dialog sends carries the SENDER'S OWN BIT. An
 *     address without it is not from the dialog: those are brains (AI
 *     players), which address their allies and single peers by explicit
 *     mask, thousands of protocol messages ("/mytype aIndy 31",
 *     "Received: doGetBaseTargetInfo") in a handful of logs;
 *   - "allies" is the sender plus every ally still heard from: a player
 *     the ring has dropped is left out, so the set is compared with the
 *     model's alliance word restricted to players heard inside STALE;
 *   - a single-player message is the sender plus the one target, ally or
 *     not, wherever the target is;
 *   - "nearby" is the sender plus every tank inside some radius, and with
 *     nobody in range it is the sender's bit ALONE, which no other option
 *     produces. The self-only messages bound the radius from above (their
 *     nearest excluded tank), and a message to one close tank with the
 *     next tank just outside bounds it from both sides -- but a message
 *     to one tank is also what a single-player message looks like, so
 *     only the self-only rows are unambiguous.
 *
 * For every non-broadcast message the tool takes the sender's last tank
 * position and every other live player's, ranks them by distance (both
 * Euclidean and per-axis, in case the radius is a box), classes the
 * address, and prints per class what bounds the nearby radius.
 *
 * Usage:
 *   node tools/measure-chat-recipients.cjs [corpus-dir|log ...]   (default: fixtures/)
 *   --samples   list every non-broadcast message with its class and ranking
 *   --other     list every message that is not an alliance or brain message
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const {replay_label} = require("./corpus.cjs");

const STALE = 50 * 30;             // a player unheard of for 30 s is neither ranked nor an ally the dialog would count
const FIXTURES = path.join(__dirname, "..", "fixtures") + path.sep;

let args = process.argv.slice(2);
let samples = args.includes("--samples");
let other_only = args.includes("--other");
let targets = args.filter(a => a !== "--samples" && a !== "--other");
if (!targets.length) targets = [path.join(__dirname, "..", "fixtures")];

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

function popcount(v) {
	let n = 0;
	for (; v; v &= v - 1) n++;
	return n;
}

/* The set the "allies" option would build: the sender plus every player
 * its own alliance word marks allied (a zero bit) and heard from inside
 * STALE. */
function alliance_set(state, pl, last_seen, now) {
	let set = 1 << pl;
	for (let q = 0; q < 16; q++) {
		if (q !== pl && state.present[q] && now - last_seen[q] <= STALE && !(state.alliances[pl] & (1 << q))) set |= 1 << q;
	}
	return set;
}

let logs = 0, total = 0, non_broadcast = 0;
let classes = {brain: 0, allies: 0, nearby_empty: 0, single: 0, multi: 0};
let brain_logs = new Map();          // label -> count of brain-addressed messages
let brain_shaped = 0;                // brain-addressed messages whose text is protocol-shaped
let single_ally = 0, single_cut = 0, single_close = [];   // single: to an ally; the target nearest; {target distance, next excluded}
let multi_cut = 0, multi_mixed = 0;
let empty_bounds = [];               // nearby_empty: nearest excluded tank, {euclid, chebyshev}
let multi_far = [], multi_near = [];
let rows = [];

function scan(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		return;
	}
	if (!recs.length) return;
	logs++;
	let label = file.startsWith(FIXTURES) ? path.basename(file) : replay_label(file);
	let pos = Array(16).fill(null);
	let present = Array(16).fill(false);
	let last_seen = Array(16).fill(-Infinity);
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));
	for (let rec of recs) {
		let pl = rec.player;
		present[pl] = true;
		last_seen[pl] = rec.time;
		let allies_before = alliance_set(state, pl, last_seen, rec.time);
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
		let allies_after = alliance_set(state, pl, last_seen, rec.time);
		for (let sub of rec.subpackets) {
			if (sub.type === "tank_position") {
				pos[pl] = {x: sub.x * 16 + sub.pixelX + 8, y: sub.y * 16 + sub.pixelY + 8};
				continue;
			}
			if (sub.type === "quit") {
				present[pl] = false;
				pos[pl] = null;
				continue;
			}
			if (sub.type !== "message") continue;
			total++;
			if (sub.address === 0xffff) continue;
			non_broadcast++;
			let address = sub.address;
			let others = [];
			if (pos[pl]) {
				for (let q = 0; q < 16; q++) {
					if (q === pl || !present[q] || !pos[q] || rec.time - last_seen[q] > STALE) continue;
					let dx = Math.abs(pos[q].x - pos[pl].x) / 16, dy = Math.abs(pos[q].y - pos[pl].y) / 16;
					others.push({q, d: Math.hypot(dx, dy), c: Math.max(dx, dy), r: (address & (1 << q)) !== 0});
				}
			}
			others.sort((a, b) => a.d - b.d);
			let recips = others.filter(o => o.r), excluded = others.filter(o => !o.r);
			let named = popcount(address & ~(1 << pl));
			let cls, note = "";
			if (!(address & (1 << pl))) {
				cls = "brain";
				brain_logs.set(label, (brain_logs.get(label) || 0) + 1);
				if (/^\s*(\/|Received:)/.test(sub.text)) brain_shaped++;
			} else if (address === allies_before || address === allies_after) {
				cls = "allies";
			} else if (named === 0) {
				cls = "nearby_empty";
				if (excluded.length) {
					empty_bounds.push({d: excluded[0].d, c: Math.min(...excluded.map(o => o.c))});
					note = `nearest excluded ${excluded[0].d.toFixed(1)} (box ${Math.min(...excluded.map(o => o.c)).toFixed(1)})`;
				}
			} else if (named === 1) {
				cls = "single";
				if (allies_after & address & ~(1 << pl)) single_ally++;
				if (recips.length && excluded.length) {
					if (recips[0].d < excluded[0].d) {
						single_cut++;
						single_close.push({d: recips[0].d, next: excluded[0].d, c: recips[0].c, next_c: Math.min(...excluded.map(o => o.c))});
						note = `target ${recips[0].d.toFixed(1)}, next ${excluded[0].d.toFixed(1)}`;
					}
				}
			} else {
				cls = "multi";
				if (recips.length && excluded.length) {
					let far = recips[recips.length - 1].d, near = excluded[0].d;
					if (far < near) {
						multi_cut++;
						multi_far.push(far);
						multi_near.push(near);
						note = `cut: farthest ${far.toFixed(1)}, nearest excluded ${near.toFixed(1)}`;
					} else {
						multi_mixed++;
						note = "mixed";
					}
				}
			}
			classes[cls]++;
			if (samples || (other_only && cls !== "allies" && cls !== "brain")) {
				rows.push(`${label} t${rec.time} p${pl} ${address.toString(16).padStart(4, "0")} ${cls.padEnd(12)} (allies ${allies_after.toString(16).padStart(4, "0")}) ${note.padEnd(34)} | ` +
					others.map(o => `${o.q}${o.r ? "*" : ""}@${o.d.toFixed(1)}`).join(" ") + ` | ${JSON.stringify(sub.text.slice(0, 40))}`);
			}
		}
	}
}

for (let target of targets) {
	for (let file of walk(target)) scan(file);
}

console.log(`logs ${logs}, messages ${total}, non-broadcast ${non_broadcast}`);
console.log(`\n=== by class ===`);
console.log(`brain-addressed (no sender bit)      ${classes.brain}  in ${brain_logs.size} logs; text protocol-shaped in ${brain_shaped}`);
console.log(`allies (sender + allies heard from)  ${classes.allies}`);
console.log(`nearby, nobody in range (self only)  ${classes.nearby_empty}`);
console.log(`sender + one player                  ${classes.single}  to an ally ${single_ally}; target the nearest tank ${single_cut}`);
console.log(`sender + several, not the allies     ${classes.multi}  a distance cut ${multi_cut}, mixed ${multi_mixed}`);
if (brain_logs.size) {
	console.log(`\n=== brain-addressed messages by log ===`);
	for (let [label, n] of [...brain_logs].sort((a, b) => b[1] - a[1])) console.log(`${label.padEnd(16)} ${n}`);
}
console.log(`\n=== the nearby radius ===`);
if (empty_bounds.length) {
	let d = empty_bounds.map(b => b.d).sort((a, b) => a - b), c = empty_bounds.map(b => b.c).sort((a, b) => a - b);
	console.log(`self-only messages bound it from above: nearest excluded tank ${d.map(v => v.toFixed(1)).join(" ")} squares (per-axis box ${c.map(v => v.toFixed(1)).join(" ")}); so the radius is under ${d[0].toFixed(1)} (box under ${c[0].toFixed(1)})`);
} else {
	console.log(`no self-only message with a ranked tank, so no upper bound`);
}
if (single_close.length) {
	single_close.sort((a, b) => a.d - b.d);
	console.log(`sender + the nearest tank, which a nearby message with one in range or a single-player message both produce; target distance then next excluded, ascending:`);
	console.log(`  ${single_close.map(s => `${s.d.toFixed(1)}/${s.next.toFixed(1)}`).join("  ")}`);
	console.log(`  per-axis box: ${single_close.map(s => `${s.c.toFixed(1)}/${s.next_c.toFixed(1)}`).join("  ")}`);
}
if (multi_far.length) {
	let far = multi_far.slice().sort((a, b) => a - b), near = multi_near.slice().sort((a, b) => a - b);
	console.log(`sender + several as a distance cut: farthest recipient ${far[0].toFixed(1)} to ${far[far.length - 1].toFixed(1)}, nearest excluded ${near[0].toFixed(1)} to ${near[near.length - 1].toFixed(1)}`);
}
if (samples || other_only) {
	console.log(`\n=== ${other_only ? "messages that are neither alliance nor brain" : "every non-broadcast message"}: recipients starred, distances in squares ===`);
	for (let row of rows) console.log(row);
}
