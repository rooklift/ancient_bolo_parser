#!/usr/bin/env node
/* How far does a shell hit shove a tank, and does the shove depend on the
 * tank's armour?
 *
 * A tank at rest that takes an `FC` hit slides away from the shell and
 * restates its position in every record while it slides, at speed 0 with
 * no motion bits, so the slide is read directly off the victim's own
 * restatements: the resting position before the hit, and the position
 * where the restatements come to rest again afterwards.
 *
 * The log carries no armour field, so armour is integrated per life as the
 * other tools do: 9 at respawn, -1 per `FC` hit, +1 per `Dn` armour drain
 * capped at 9, and a mine detonation under the tank -3, or down to 1 from
 * 4 or 3 (GAMEPLAY.md). A life is TRUSTED only when it ends in a shell
 * death (`F9`, code other than 3) that the integration puts at exactly 0;
 * the armour before each hit in such a life is then known. Hits in other
 * lives (the first life seen for a player, a life cut off by the end of
 * the log, a drowning, or an integration that misses 0) are kept in a
 * separate "armour unknown" pool.
 *
 * A knockback can be cut short by whatever is in the way -- a building,
 * deep sea, a live pillbox, another tank -- so each one is also classed as
 * CLEAR or not: clear when the 16 px tank box, swept from the resting
 * position 48 px along the shell's direction, touches no building, deep
 * sea or live pill, and no other tank's latest restatement lies near that
 * sweep. Only clear knockbacks with a settled endpoint go into the main
 * table; the blocked ones are shown alongside as a check.
 *
 * Candidate: the victim's last restatement at or before the hit is at
 * rest (speed 0, motion bits 0, not dying, not in a boat, not older than
 * 8 s), no other hit on the victim within 3 s before or during the slide, and the restatements after the hit stay at speed 0
 * with no motion bits until the slide has run its course: the endpoint is
 * the last such restatement, and it must be at least SETTLE ticks after
 * the hit (the slide's tail is long: the profile section measures it).
 *
 * Usage: node tools/measure-knockback.cjs [--profile] [--trace] [--settle=N] [file | directory ...]
 * With no path the corpus root from corpus.json / BOLO_CORPUS is read.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const {corpus_root, replay_label} = require("./corpus.cjs");

const MAX_ARMOUR = 9;
const TICKS_PER_SECOND = 50;
let settle_arg = process.argv.find(a => a.startsWith("--settle="));
const SETTLE = settle_arg ? Number(settle_arg.slice(9)) : 40;   /* ticks after the hit before an endpoint is trusted: the profile puts the slide's end at 40-49 */
const PROFILE_MIN = 100;       /* slides at rest at least this long feed the profile */
const STALE = 8 * TICKS_PER_SECOND;
const QUIET = 3 * TICKS_PER_SECOND;   /* no other hit on the victim this close before */
const SWEEP = 48;              /* px swept along the shell direction for the clear test */
const HALF_BOX = 7;            /* the tank box is 16 px; its centre +-7 stays inside */
const DEEP_SEA = BoloGame.DEEP_SEA;

/* direction nibble d: 0 = north, clockwise by 22.5 degrees; screen y runs down */
function unit(d) {
	let a = d * Math.PI / 8;
	return [Math.sin(a), -Math.cos(a)];
}

/* accumulators */
let logs_scanned = 0, records_scanned = 0, hits_seen = 0;
let reasons = new Map();
let by_armour = new Map();      /* armour before -> {clear: [], blocked: []} of samples */
let unknown = {clear: [], blocked: []};
let profile = new Map();        /* dt bucket -> [px from the resting position] */
let profile_hits = 0;
let angle_off = [];             /* degrees between displacement and shell direction, clear samples */
let self_vs_other = {self: [], other: []};
let examples = [];

function count(reason) {
	reasons.set(reason, (reasons.get(reason) || 0) + 1);
}

function group(map, key) {
	if (!map.has(key)) map.set(key, {clear: [], blocked: []});
	return map.get(key);
}

function median(v) {
	if (!v.length) return NaN;
	let s = [...v].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

function histogram_line(values, lo, hi, step = 1) {
	let counts = new Map();
	for (let v of values) {
		let b = Math.round(v / step) * step;
		if (b < lo || b > hi) continue;
		counts.set(b, (counts.get(b) || 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join(" ") || "-";
}

function scan(file, recs) {
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));
	let label = replay_label(file);
	let t0 = recs[0].time;

	/* per player: every restatement in record order, and the current life */
	let positions = Array.from({length: 16}, () => []);
	let life = new Array(16).fill(null);
	let seen_death = new Array(16).fill(false);
	let last_tank = new Array(16).fill(null);
	let candidates = [];          /* {index, time, dir, victim, sender, hit, obstacles} */
	let hits_by_victim = Array.from({length: 16}, () => []);   /* record times of every hit */

	let finish_life = (pl, code) => {
		let l = life[pl];
		life[pl] = null;
		if (!l) return;
		let armour = MAX_ARMOUR;
		for (let e of l.events) {
			if (e.kind === "hit") { e.armour_before = armour; armour--; }
			else if (e.kind === "drain") armour = Math.min(MAX_ARMOUR, armour + 1);
			else if (e.kind === "mine") armour = armour >= 5 ? armour - 3 : (armour >= 3 ? 1 : armour - 3);
		}
		l.trusted = !l.first && code !== null && code !== 3 && armour === 0;
	};

	recs.forEach((rec, index) => {
		let pl = rec.player;
		let tank_sub = rec.subpackets.find(s => s.type === "tank_position");
		if (tank_sub) {
			let cx = tank_sub.x * 16 + tank_sub.pixelX + 8, cy = tank_sub.y * 16 + tank_sub.pixelY + 8;
			positions[pl].push({ index, time: rec.time, x: cx, y: cy, speed: tank_sub.speed, motion: tank_sub.motion,
				dying: tank_sub.dying, in_boat: tank_sub.inBoat });
			last_tank[pl] = { sx: cx >> 4, sy: cy >> 4, x: cx, y: cy, time: rec.time, dying: tank_sub.dying };
			if (!tank_sub.dying && life[pl] === null) life[pl] = { events: [], first: !seen_death[pl], trusted: false };
		}
		for (let sub of rec.subpackets) {
			switch (sub.type) {
				case "tank_hit": {
					hits_seen++;
					let hit = { kind: "hit", time: rec.time, armour_before: null, life: life[sub.tank] };
					if (life[sub.tank]) life[sub.tank].events.push(hit);
					hits_by_victim[sub.tank].push(rec.time);
					/* a snapshot of everything that might be in the way, taken now */
					let others = [];
					for (let i = 0; i < 16; i++) {
						let t = last_tank[i];
						if (i === sub.tank || !t || t.dying || rec.time - t.time > 5 * TICKS_PER_SECOND) continue;
						others.push({x: t.x, y: t.y});
					}
					let victim = last_tank[sub.tank];
					let obstacles = null;
					if (victim) obstacles = swept_obstacles(state, victim.x, victim.y, sub.direction, others);
					candidates.push({ index, time: rec.time, dir: sub.direction, victim: sub.tank, sender: pl, hit, obstacles });
					break;
				}
				case "base_drain":
					if (sub.resource === "armor" && life[pl]) life[pl].events.push({ kind: "drain", time: rec.time });
					break;
				case "explosion": {
					let before = state.grid[sub.y * 256 + sub.x];
					let mined = before >= 10 && before <= 15;
					if (!mined || sub.code === 0x0c || sub.code === 0x0d) break;
					for (let i = 0; i < 16; i++) {
						let t = last_tank[i];
						if (!t || t.dying || rec.time - t.time > TICKS_PER_SECOND) continue;
						if (t.sx === sub.x && t.sy === sub.y && life[i]) life[i].events.push({ kind: "mine", time: rec.time });
					}
					break;
				}
				case "tank_death":
					seen_death[pl] = true;
					finish_life(pl, sub.code);
					break;
			}
		}
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
	});
	for (let i = 0; i < 16; i++) finish_life(i, null);

	for (let c of candidates) evaluate(c, positions[c.victim], hits_by_victim[c.victim], label, t0);
	logs_scanned++;
	records_scanned += recs.length;
	console.log(`${label}: ${recs.length} records, ${candidates.length} hits`);
}

/* What lies in the tank box swept SWEEP px along direction d from (x, y):
 * a list of the things found, empty when the way is clear. */
function swept_obstacles(state, x, y, d, others) {
	let [ux, uy] = unit(d);
	let found = new Set();
	for (let s = 0; s <= SWEEP; s += 4) {
		let cx = x + ux * s, cy = y + uy * s;
		for (let dx of [-HALF_BOX, HALF_BOX]) {
			for (let dy of [-HALF_BOX, HALF_BOX]) {
				let sx = Math.floor((cx + dx) / 16), sy = Math.floor((cy + dy) / 16);
				if (sx < 0 || sy < 0 || sx > 255 || sy > 255) { found.add("edge"); continue; }
				let t = state.grid[sy * 256 + sx];
				if (t === 0) found.add("building");
				else if (t === DEEP_SEA) found.add("sea");
				if (state.pills.some(p => p.inTank === null && p.armour > 0 && p.x === sx && p.y === sy)) found.add("pill");
			}
		}
	}
	let ex = x + ux * SWEEP, ey = y + uy * SWEEP;
	let vx = ex - x, vy = ey - y;
	for (let o of others) {
		/* distance from the other tank to the swept segment */
		let t = ((o.x - x) * vx + (o.y - y) * vy) / (vx * vx + vy * vy);
		t = Math.max(0, Math.min(1, t));
		let px = x + vx * t, py = y + vy * t;
		if (Math.hypot(o.x - px, o.y - py) < 2 * HALF_BOX + 2 + 16) found.add("tank");
	}
	return [...found];
}

function evaluate(c, P, hit_times, label, t0) {
	/* the resting restatement: last one at or before the hit's record */
	let k = -1;
	for (let i = P.length - 1; i >= 0; i--) if (P[i].index <= c.index) { k = i; break; }
	if (k < 0) return count("no restatement before the hit");
	let rest = P[k];
	if (rest.dying) return count("victim dying");
	if (rest.in_boat) return count("victim in a boat");
	if (c.time - rest.time > STALE) return count("resting restatement stale");
	if (rest.speed !== 0 || rest.motion !== 0) return count("victim moving before the hit");
	if (hit_times.some(t => t < c.time && c.time - t <= QUIET)) return count("another hit on the victim just before");
	/* walk the slide */
	let end = null, stopped = null, next_hit = hit_times.find(t => t > c.time);
	for (let j = k + 1; j < P.length; j++) {
		let p = P[j];
		if (p.index <= c.index) continue;
		if (next_hit !== undefined && p.time >= next_hit) { stopped = "next hit"; break; }
		if (p.dying) { stopped = "died"; break; }
		if (p.in_boat || p.speed !== 0 || p.motion !== 0) { stopped = "drove off"; break; }
		if (p.time - c.time > 10 * TICKS_PER_SECOND) break;
		end = p;
	}
	if (!end) return count(`no rest restatement after the hit (${stopped || "none"})`);
	if (end.time - c.time < SETTLE) return count(`slide interrupted before ${SETTLE} ticks (${stopped || "log ends"})`);
	/* the profile: how the distance grows with time, against the endpoint */
	let final = Math.hypot(end.x - rest.x, end.y - rest.y);
	if (end.time - c.time >= PROFILE_MIN) {
		profile_hits++;
		let trace = [];
		for (let j = k + 1; j < P.length; j++) {
			let p = P[j];
			if (p.index <= c.index) continue;
			let dt = p.time - c.time;
			if (dt > PROFILE_MIN) break;
			trace.push({ dt, dist: Math.hypot(p.x - rest.x, p.y - rest.y), dx: p.x - rest.x, dy: p.y - rest.y });
		}
		let last = trace.length ? trace[trace.length - 1].dist : 0;
		for (let t of trace) {
			let b = Math.floor(t.dt / 10) * 10;
			if (!profile.has(b)) profile.set(b, []);
			profile.get(b).push({ px: t.dist, frac: last > 0 ? t.dist / last : 1 });
		}
		if (show_trace) console.log(`  trace ${label} t=${((c.time - t0) / 50).toFixed(1)}s tank ${c.victim} d${c.dir}: ${trace.map(t => `+${t.dt}:(${t.dx},${t.dy})`).join(" ")}`);
	}
	let [ux, uy] = unit(c.dir);
	let dx = end.x - rest.x, dy = end.y - rest.y;
	let along = dx * ux + dy * uy;
	let angle = final > 0 ? Math.acos(Math.max(-1, Math.min(1, along / final))) * 180 / Math.PI : 0;
	let sample = { dist: final, along, dx, dy, angle, dir: c.dir, self: c.sender === c.victim, obstacles: c.obstacles || ["unknown"],
		text: `${label} t=${((c.time - t0) / 50).toFixed(1)}s tank ${c.victim} hit d${c.dir}: (${rest.x},${rest.y}) -> (${end.x},${end.y}) ${final.toFixed(1)} px, endpoint ${end.time - c.time} ticks on` };
	let clear = sample.obstacles.length === 0;
	let armour = c.hit.life && c.hit.life.trusted ? c.hit.armour_before : null;
	let bucket = armour === null ? unknown : group(by_armour, armour);
	(clear ? bucket.clear : bucket.blocked).push(sample);
	if (clear) {
		angle_off.push(angle);
		(sample.self ? self_vs_other.self : self_vs_other.other).push(final);
		if (armour !== null && examples.length < 8) examples.push(`armour ${armour}: ${sample.text}`);
	}
	count("measured");
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

let show_profile = process.argv.includes("--profile");
let show_trace = process.argv.includes("--trace");
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

console.log(`\n${logs_scanned} log${logs_scanned === 1 ? "" : "s"}, ${records_scanned} records, ${hits_seen} hits`);
console.log(`\n[selection] why hits were kept or set aside`);
for (let [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(7)}  ${r}`);

if (show_profile) {
	console.log(`\n[profile] px from the resting position by ticks since the hit, over the ${profile_hits} slides still at rest ${PROFILE_MIN}+ ticks on (all paths, all lives)`);
	for (let [b, v] of [...profile.entries()].sort((a, b) => a[0] - b[0])) {
		console.log(`  ${String(b).padStart(4)}-${String(b + 9).padEnd(4)} n ${String(v.length).padStart(6)}  median px ${median(v.map(x => x.px)).toFixed(2)}  median share of the slide's distance at ${PROFILE_MIN} ${median(v.map(x => x.frac)).toFixed(2)}`);
	}
}

let describe = (name, samples) => {
	let d = samples.map(s => s.dist);
	console.log(`  ${name.padEnd(16)} n ${String(d.length).padStart(6)}  median ${String(median(d).toFixed(1)).padStart(5)}  px histogram ${histogram_line(d, 0, 40)}`);
};

console.log(`\n[knockback by armour before the hit] clear path, trusted lives (endpoint at least ${SETTLE} ticks after the hit)`);
console.log(`  the last row that can survive a hit is armour 2; a tank hit at 1 dies`);
for (let a = MAX_ARMOUR; a >= 1; a--) {
	let g = by_armour.get(a);
	if (!g) continue;
	describe(`armour ${a}`, g.clear);
}
describe("armour unknown", unknown.clear);
console.log(`\n[the same, blocked or crowded paths] a building, deep sea, a live pill or another tank within the swept box`);
for (let a = MAX_ARMOUR; a >= 1; a--) {
	let g = by_armour.get(a);
	if (!g) continue;
	describe(`armour ${a}`, g.blocked);
}
describe("armour unknown", unknown.blocked);
let obstacle_counts = new Map();
for (let g of [...by_armour.values(), unknown]) for (let s of g.blocked) for (let o of s.obstacles) obstacle_counts.set(o, (obstacle_counts.get(o) || 0) + 1);
console.log(`  obstacles: ${[...obstacle_counts.entries()].map(([k, n]) => `${k} ${n}`).join(", ") || "-"}`);

console.log(`\n[along the shell direction] clear, trusted: the displacement's component along d, by armour`);
for (let a = MAX_ARMOUR; a >= 1; a--) {
	let g = by_armour.get(a);
	if (!g || !g.clear.length) continue;
	let v = g.clear.map(s => s.along);
	console.log(`  armour ${a}: n ${String(v.length).padStart(5)}  median ${median(v).toFixed(1)}  histogram ${histogram_line(v, -10, 40)}`);
}
console.log(`\n[by direction] trusted clear samples: the distance's excess over the working theory 17 - armour (8 px at 9, one more per armour point missing), by shell direction nibble`);
{
	let by_dir = new Map();
	for (let [a, g] of by_armour) for (let s of g.clear) {
		if (!by_dir.has(s.dir)) by_dir.set(s.dir, []);
		by_dir.get(s.dir).push({ excess: s.dist - (17 - a), dx: s.dx, dy: s.dy });
	}
	for (let [d, v] of [...by_dir.entries()].sort((a, b) => a[0] - b[0])) {
		console.log(`  d${String(d).padEnd(2)} n ${String(v.length).padStart(4)}  excess median ${median(v.map(x => x.excess)).toFixed(1).padStart(5)}  histogram ${histogram_line(v.map(x => x.excess), -6, 6)}  median dx ${median(v.map(x => x.dx)).toFixed(1)} dy ${median(v.map(x => x.dy)).toFixed(1)}`);
	}
}
console.log(`\n[by quadrant] trusted clear samples by armour: shoved north-west-ward (d 12-15 and 0, both components toward the origin), south-east-ward (d 4-8, both away), or mixed (d 1-3, 9-11)`);
for (let a = MAX_ARMOUR; a >= 1; a--) {
	let g = by_armour.get(a);
	if (!g) continue;
	let parts = [];
	for (let [name, test] of [["NW", d => d === 0 || d >= 12], ["SE", d => d >= 4 && d <= 8], ["mixed", d => (d >= 1 && d <= 3) || (d >= 9 && d <= 11)]]) {
		let v = g.clear.filter(s => test(s.dir)).map(s => s.dist);
		parts.push(`${name} n ${String(v.length).padStart(3)} median ${(v.length ? median(v) : NaN).toFixed(1).padStart(5)} [${histogram_line(v, 0, 40)}]`);
	}
	console.log(`  armour ${a}: ${parts.join("  ")}`);
}
console.log(`\n[axis-aligned] trusted clear samples hit due north, east, south or west (d 0, 4, 8, 12): the whole-pixel shove along the axis, by armour and axis`);
for (let a = MAX_ARMOUR; a >= 1; a--) {
	let g = by_armour.get(a);
	if (!g) continue;
	let parts = [];
	for (let [d, name] of [[0, "N"], [4, "E"], [8, "S"], [12, "W"]]) {
		let v = g.clear.filter(s => s.dir === d).map(s => Math.round(s.along));
		if (v.length) parts.push(`${name} ${histogram_line(v, -5, 40)}`);
	}
	console.log(`  armour ${a}: ${parts.join(" | ") || "-"}`);
}
console.log(`\n[direction] angle between the displacement and the shell's direction nibble, clear samples: ${histogram_line(angle_off, 0, 180, 10)} (10-degree bins)`);
console.log(`[reporter] clear samples, distance when the victim reported its own hit: median ${median(self_vs_other.self).toFixed(1)} (n ${self_vs_other.self.length}); reported by another machine: median ${median(self_vs_other.other).toFixed(1)} (n ${self_vs_other.other.length})`);
console.log(`\n[examples]`);
for (let e of examples) console.log(`  ${e}`);
