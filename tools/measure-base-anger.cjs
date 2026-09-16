#!/usr/bin/env node
/* Does shooting a base anger the pillboxes allied to it, and from how far?
 *
 * The log has no anger field, but a pill's fire rate is its anger: a rested
 * pill fires every ~100 ticks and each hit halves the delay (GAMEPLAY.md,
 * Anger). So the question is whether a pill's fire gaps shorten after a
 * shell lands on an allied base, and how that depends on the distance
 * between the pill's square and the base's.
 *
 * Every `An` (base hit) opens an episode for each grounded live pill in the
 * log, keyed by pill and base; further hits on the same base inside the
 * window join the episode. The pill must be at rest beforehand: no `9n` on
 * it and no hit on any base allied to it in the previous QUIET ticks. Its
 * `F4` fires are then read for WINDOW ticks, per sending machine (two
 * machines simulating one pill would otherwise interleave into false short
 * gaps), ending early at the first `9n` on the pill or the first hit on a
 * different allied base. The smallest gap in the window, counting the gap
 * that spans the hit, classifies the pill: ANGRY_GAP or less means
 * something angered it.
 *
 * Cases are tabulated by the pill's relation to the base (same owner,
 * allied owner, hostile, neutral) and by the squared distance in squares,
 * which is where the edge of the circle shows. Hostile pills near the same
 * hits are the noise control.
 *
 * --relaxed drops the rest requirement (QUIET 0, WINDOW 1000). Pills already
 * angry from the fight then read angry at every distance, but the slow
 * readers are the proof that an offset lies outside the circle: nothing
 * holds a pill at 100 ticks while it is being provoked. The relaxed run
 * lists the clearest such cases for the offsets just outside a radius of 7.
 *
 * Usage: node tools/measure-base-anger.cjs [--relaxed] [--samples] [file | directory ...]
 * With no target the corpus root from corpus.json / BOLO_CORPUS is read.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const {corpus_root, replay_label} = require("./corpus.cjs");

const RELAXED = process.argv.includes("--relaxed");
const SAMPLES = process.argv.includes("--samples");
const NEUTRAL = 16;
const RANGE_PX = 136;                    /* 8.5 tiles: a pill shell's full flight */
const ALIVE_TICKS = 250;                 /* a tank unheard of for 5 s is not a target */
const QUIET = RELAXED ? 0 : 6000;        /* 120 s of no pill hit and no allied-base hit before an episode */
const WINDOW = RELAXED ? 1000 : 500;     /* fires read after the first base hit */
const LOOKBACK = 110;                    /* a fire this far before the hit starts the spanning gap */
const ANGRY_GAP = 70;                    /* rested gaps are 97-107, one halving gives 48-60 */
const REST_GAP = 90;                     /* a gap this long is a rested pill */
const RADIUS_SQ = 49;                    /* the circle under test: strictly inside d² < 49 */
const SAMPLE_CASES = 12;

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

function allied(state, a, b) {
	if (a === b) return true;
	if (a === NEUTRAL || b === NEUTRAL || a === BoloGame.DEPARTED || b === BoloGame.DEPARTED) return false;
	return (state.alliances[a] & (1 << b)) === 0;
}

function hostile(state, pill, player) {
	if (pill.owner === NEUTRAL || pill.owner === BoloGame.DEPARTED) return true;
	return !allied(state, pill.owner, player);
}

function relation(state, pill, base) {
	if (pill.owner === NEUTRAL || pill.owner === BoloGame.DEPARTED) return "pill neutral/departed";
	if (base.owner === NEUTRAL || base.owner === BoloGame.DEPARTED) return "base neutral/departed";
	if (pill.owner === base.owner) return "same owner";
	if (allied(state, pill.owner, base.owner)) return "allied owners";
	return "hostile";
}

function is_allied_rel(rel) {
	return rel === "same owner" || rel === "allied owners";
}

function tank_centre(t) {
	return {x: t.x * 16 + t.px + 8, y: t.y * 16 + t.py + 8};
}

/* One open episode per (pill, base). */
class Episode {
	constructor(log, t0, pill_index, base_index, rel, dx, dy, shooter) {
		this.log = log;
		this.t0 = t0;
		this.pill = pill_index;
		this.base = base_index;
		this.rel = rel;
		this.dx = dx;
		this.dy = dy;
		this.shooter = shooter;
		this.end = t0 + WINDOW;
		this.ended_by = "window";
		this.fires = [];        /* [ticks after t0, sender] */
		this.gaps = [];         /* per-sender gaps whose later fire is after t0 */
		this.base_hits = 1;
	}
	d2() { return this.dx * this.dx + this.dy * this.dy; }
	min_gap() { return this.gaps.length ? Math.min(...this.gaps) : null; }
	verdict() {
		if (!this.gaps.length) return "unobserved";
		return this.min_gap() <= ANGRY_GAP ? "angry" : "calm";
	}
	slow_fires() { return this.gaps.filter(g => g >= REST_GAP).length; }
}

const rows = [];
let logs = 0, base_hits = 0;

function scan(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		return;
	}
	if (!recs.length) return;
	logs++;
	let label = replay_label(file);
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));
	let last_fire = Array.from({length: 16}, () => new Array(16).fill(-Infinity));   /* [pill][sender] */
	let last_pill_hit = new Array(16).fill(-Infinity);
	let last_allied_base_hit = new Array(16).fill(-Infinity);                         /* per pill */
	let open = new Map();
	let last_time = -Infinity;

	function close(key) {
		rows.push(open.get(key));
		open.delete(key);
	}

	for (let rec of recs) {
		let now = rec.time;
		if (now < last_time - 50) open.clear();   /* clock went backwards: trust nothing open */
		last_time = now;
		for (let [key, e] of open) if (now > e.end) close(key);

		/* events are read against the state BEFORE the record is applied */
		for (let sub of rec.subpackets) {
			if (sub.type === "pillbox_damage") {
				let k = sub.pillbox;
				last_pill_hit[k] = now;
				for (let e of open.values()) {
					if (e.pill === k && now <= e.end) { e.end = now; e.ended_by = "pill hit"; }
				}
			} else if (sub.type === "pillbox_fires") {
				let sender = rec.player;
				let pill = state.pills[sub.pillbox];
				let me = state.tanks[sender];
				let mc = me && tank_centre(me);
				if (sub.direction === 0 && (sub.pillbox & 1)) {
					/* the direction-0 index fault ([E:pill-fire-index]) */
					let lower = state.pills[sub.pillbox - 1];
					let fits = p => p && p.inTank === null && mc && hostile(state, p, sender) &&
						Math.hypot(p.x * 16 + 8 - mc.x, p.y * 16 + 8 - mc.y) <= RANGE_PX;
					if (fits(lower) && !fits(pill)) pill = lower;
					else if (!fits(lower) && !fits(pill)) pill = null;
				}
				if (!pill || pill.inTank !== null || pill.armour === 0) continue;
				let k = state.pills.indexOf(pill);
				let prev = last_fire[k][sender];
				let gap = now - prev;
				last_fire[k][sender] = now;
				for (let e of open.values()) {
					if (e.pill !== k || now > e.end) continue;
					e.fires.push([now - e.t0, sender]);
					if (Number.isFinite(gap) && gap >= 0 && prev >= e.t0 - LOOKBACK) e.gaps.push(gap);
				}
			} else if (sub.type === "base_damage") {
				let base = state.bases[sub.base];
				if (!base) continue;
				base_hits++;
				let shooter = rec.player;
				for (let k = 0; k < state.pills.length; k++) {
					let pill = state.pills[k];
					let rel = relation(state, pill, base);
					let quiet = now - last_pill_hit[k] >= QUIET && now - last_allied_base_hit[k] >= QUIET;
					if (is_allied_rel(rel)) {
						for (let oe of open.values()) {
							if (oe.pill === k && oe.base !== sub.base && now <= oe.end) { oe.end = now; oe.ended_by = "other base hit"; }
						}
						last_allied_base_hit[k] = now;
					}
					if (pill.inTank !== null || pill.armour === 0) continue;
					let key = `${k}:${sub.base}`;
					let e = open.get(key);
					if (e && now <= e.end) { e.base_hits++; continue; }
					if (e) close(key);
					if (!quiet) continue;
					open.set(key, new Episode(label, now, k, sub.base, rel, pill.x - base.x, pill.y - base.y, shooter));
				}
			}
		}
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
	}
	for (let key of [...open.keys()]) close(key);
}

let args = process.argv.slice(2).filter(a => !a.startsWith("--"));
let targets = args.length ? args : [corpus_root()];
for (let target of targets) for (let file of walk(target)) scan(file);

/* ---- report ---- */

function pct(a, b) {
	return b ? (100 * a / b).toFixed(1).padStart(5) + "%" : "    -";
}

function describe(e) {
	return `${e.log} t${e.t0} pill ${e.pill} base ${e.base} offset (${e.dx},${e.dy}) base hits ${e.base_hits} ` +
		`shooter p${e.shooter} fires ${e.fires.map(f => `+${f[0]}/p${f[1]}`).join(" ")} gaps ${e.gaps.join(",")} ended by ${e.ended_by}`;
}

let observed = rows.filter(e => e.verdict() !== "unobserved");
let ally = observed.filter(e => is_allied_rel(e.rel));
let ctl = observed.filter(e => e.rel === "hostile");

console.log(`${RELAXED ? "RELAXED (no rest requirement, window 1000)" : `rest required (quiet ${QUIET} ticks, window ${WINDOW})`}`);
console.log(`logs ${logs}, base hits ${base_hits}, episodes ${rows.length}, observed ${observed.length} ` +
	`(the pill fired at least twice in the window, or once within ${LOOKBACK} ticks of an earlier fire)`);

console.log("\n=== by the pill's relation to the hit base ===");
for (let rel of ["same owner", "allied owners", "hostile", "pill neutral/departed", "base neutral/departed"]) {
	let set = observed.filter(e => e.rel === rel);
	let angry = set.filter(e => e.verdict() === "angry").length;
	console.log(`${rel.padEnd(24)} observed ${String(set.length).padStart(6)}  angry ${String(angry).padStart(6)}  ${pct(angry, set.length)}`);
}

console.log("\n=== allied pills by squared distance to the base (squares²), hostile pills alongside as the control ===");
console.log("  d²      d   observed  angry   frac   | hostile observed angry   frac");
let seen = new Set(ally.map(e => e.d2()).concat(ctl.map(e => e.d2())));
let buckets = [...seen].filter(q => q <= 100).sort((a, b) => a - b);
function row(name, d, set, c) {
	let a = set.filter(e => e.verdict() === "angry").length;
	let ca = c.filter(e => e.verdict() === "angry").length;
	console.log(`${name.padStart(4)}  ${d.padStart(5)}  ${String(set.length).padStart(8)}  ${String(a).padStart(5)}  ${pct(a, set.length)}  | ` +
		`${String(c.length).padStart(8)} ${String(ca).padStart(5)}  ${pct(ca, c.length)}`);
}
for (let q of buckets) row(String(q), Math.sqrt(q).toFixed(2), ally.filter(e => e.d2() === q), ctl.filter(e => e.d2() === q));
row(">100", "", ally.filter(e => e.d2() > 100), ctl.filter(e => e.d2() > 100));

console.log("\n=== allied pills, |dx| across and |dy| down: angry/observed ===");
console.log("     " + Array.from({length: 11}, (_, x) => String(x).padStart(8)).join(""));
for (let y = 0; y <= 10; y++) {
	let line = String(y).padStart(4) + " ";
	for (let x = 0; x <= 10; x++) {
		let s = ally.filter(e => Math.abs(e.dx) === x && Math.abs(e.dy) === y);
		let a = s.filter(e => e.verdict() === "angry").length;
		line += s.length ? `${a}/${s.length}`.padStart(8) : "       .";
	}
	console.log(line);
}

let inside = ally.filter(e => e.d2() < RADIUS_SQ);
let outside = ally.filter(e => e.d2() >= RADIUS_SQ);
console.log(`\n=== the circle d² < ${RADIUS_SQ}: inside ${inside.filter(e => e.verdict() === "angry").length}/${inside.length} angry, ` +
	`outside ${outside.filter(e => e.verdict() === "angry").length}/${outside.length} ===`);

console.log("\n=== inside the circle: smallest fire gap after the hit, by base hits in the episode ===");
for (let n of [1, 2, 3]) {
	let gaps = inside.filter(e => e.base_hits === n).map(e => e.min_gap()).sort((a, b) => a - b);
	let mid = gaps.length ? gaps[Math.floor(gaps.length / 2)] : "-";
	console.log(`${n} hit${n > 1 ? "s" : ""}: ${gaps.length} cases, median ${mid}; ${gaps.join(" ")}`);
}

console.log("\n=== how episodes ended (allied, observed) ===");
for (let why of ["window", "pill hit", "other base hit"]) {
	let s = ally.filter(e => e.ended_by === why);
	console.log(`${why.padEnd(16)} ${s.length} observed, ${s.filter(e => e.verdict() === "angry").length} angry`);
}

/* The offsets just outside a radius of 7, and the nearest inside: the
 * slow readers at each are the proof that the offset lies outside. */
console.log("\n=== the edge: clearest slow readers at the offsets nearest a radius of 7 ===");
for (let [name, test] of [
	["(6,3) d 6.71, inside", e => e.d2() === 45],
	["(7,0) d 7.00", e => e.d2() === 49],
	["(5,5) d 7.07", e => Math.abs(e.dx) === 5 && Math.abs(e.dy) === 5],
	["(7,1) d 7.07", e => e.d2() === 50 && Math.abs(e.dx) !== 5],
	["(6,4) d 7.21", e => e.d2() === 52],
]) {
	let set = ally.filter(test);
	let angry = set.filter(e => e.verdict() === "angry").length;
	let slow = set.filter(e => e.slow_fires() >= 2 && e.verdict() === "calm")
		.sort((a, b) => (b.slow_fires() * 20 + b.base_hits) - (a.slow_fires() * 20 + a.base_hits));
	console.log(`\n${name}: observed ${set.length}, angry ${angry}, calm with two or more rested gaps ${slow.length}`);
	for (let e of slow.slice(0, SAMPLES ? SAMPLE_CASES : 4)) console.log(`  ${describe(e)}`);
}

if (SAMPLES) {
	console.log("\n=== samples: allied, inside the circle, read calm ===");
	for (let e of inside.filter(e => e.verdict() === "calm").slice(0, SAMPLE_CASES)) console.log(`  ${describe(e)}`);
	console.log("\n=== samples: allied, outside the circle, read angry ===");
	for (let e of outside.filter(e => e.verdict() === "angry").slice(0, SAMPLE_CASES)) console.log(`  ${describe(e)}`);
}
