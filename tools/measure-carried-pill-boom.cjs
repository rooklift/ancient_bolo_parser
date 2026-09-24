#!/usr/bin/env node
/* Does a carried pillbox still sit on the ground, internally?
 *
 * The claim under test: a pill that is picked up keeps its old map
 * position in the engine's pill list, so a superboom at that old square
 * still damages it and angers it while it is in the tank, and the pill
 * then fires fast when planted.
 *
 * The log has no anger field, but a pill's fire rate is its anger: a
 * rested pill fires every ~100 ticks and each hit halves the delay
 * (GAMEPLAY.md, Anger). So every pickup is followed: the square the pill
 * left, what landed on that square while the pill was carried (a `7D`
 * superboom covering it, a `7 3` crater on it, a `9n` on the pill's index,
 * a shell on a base allied to the carrier strictly within 7 squares of it,
 * the base-anger circle of [E:base-anger]), and then, at the plant, the
 * pill's `F4` fire gaps per sending machine for WINDOW ticks, ending early
 * at the first `9n` on the pill or the first allied-base hit inside the
 * circle around the NEW square. Carries with nothing on the old square are
 * the control, and the control is also binned by carry length, which is
 * the prior question: does any anger survive pickup and plant at all?
 *
 * Two side read-outs check the "still on the ground" part directly:
 *   - a grounded pill spares its square from cratering, read from whether
 *     a crater beside water floods ([E:crater-pill]); the same test on the
 *     vacated square of a carried pill;
 *   - Bolo refuses a build on a square holding a pill; builds on the
 *     vacated square during the carry are counted.
 *
 * Usage: node tools/measure-carried-pill-boom.cjs [--samples] [file | directory ...]
 * With no target the corpus root from corpus.json / BOLO_CORPUS is read.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const {corpus_root, replay_label} = require("./corpus.cjs");

const SAMPLES = process.argv.includes("--samples");
const NEUTRAL = 16;
const MAP_SIZE = BoloGame.MAP_SIZE;
const DEEP_SEA = BoloGame.DEEP_SEA;
const RANGE_PX = 136;          /* 8.5 tiles: a pill shell's full flight */
const WINDOW = 500;            /* fires read after the plant */
const ANGRY_GAP = 70;          /* rested gaps are 97-107, one halving gives 48-60 */
const RADIUS_SQ = 49;          /* base-anger circle: strictly inside d² < 49 */
const HIT_LOOKBACK = 600;      /* 9n hits counted this far before the pickup */
const REST_TICKS = 6000;       /* a pill unhit for 120 s is at rest */
const FLOOD_WINDOW = 150;      /* 3 s; the flood rule fires in ~0.6 */
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BUILD_TERRAIN = new Set([9, 4, 0, 5]);   /* boat, road, building, tree */
const is_water = t => t === 1 || t === 9 || t === DEEP_SEA;

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

function tank_centre(t) {
	return {x: t.x * 16 + t.px + 8, y: t.y * 16 + t.py + 8};
}

function d2(ax, ay, bx, by) {
	return (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
}

/* One carry: from a pickup on the record to the plant, if any. */
class Carry {
	constructor(log, t0, k, ox, oy, picker, hits_before, last_hit_before, last_ground_boom_before) {
		this.log = log;
		this.kind = "carry";
		this.last_ground_boom_before = last_ground_boom_before;   /* ticks from the last 7D on the grounded pill to the pickup, or null */
		this.t0 = t0;
		this.pill = k;
		this.ox = ox;
		this.oy = oy;
		this.picker = picker;
		this.hits_before = hits_before;             /* 9n on the pill in the HIT_LOOKBACK before pickup */
		this.last_hit_before = last_hit_before;     /* ticks from the last 9n to the pickup */
		this.booms = [];                            /* ticks after t0 of each 7D covering the old square */
		this.craters = [];                          /* 7 3 on the old square */
		this.hits_while = [];                       /* 9n on the pill's index while carried */
		this.base_hits = [];                        /* allied base hits inside the circle around the old square */
		this.fires_while = 0;                       /* F4 naming this pill while carried */
		this.builds = [];                           /* builds on the old square while carried */
		this.plant = null;                          /* tick */
		this.nx = this.ny = null;
		this.end = null;
		this.ended_by = "window";
		this.fires = [];
		this.gaps = [];
		this.life_hits = 0;                         /* 9n after the plant until the next pickup */
		this.life_end = null;                       /* "pickup", "dump", "repair", "boom", "log end" */
	}
	rested_at_pickup() { return this.last_hit_before === null || this.last_hit_before >= REST_TICKS; }
	elapsed() { return this.last_hit_before === null ? null : this.last_hit_before + this.carry_ticks(); }   /* ticks from the last 9n to the plant */
	ground_boom_after_last_hit() { return this.last_ground_boom_before !== null && this.last_hit_before !== null && this.last_ground_boom_before < this.last_hit_before; }
	carry_ticks() { return this.plant - this.t0; }
	min_gap() { return this.gaps.length ? Math.min(...this.gaps) : null; }
	verdict() {
		if (!this.gaps.length) return "unobserved";
		return this.min_gap() <= ANGRY_GAP ? "angry" : "calm";
	}
	last_boom_to_plant() { return this.booms.length ? this.plant - this.t0 - this.booms[this.booms.length - 1] : null; }
	last_base_hit_to_plant() { return this.base_hits.length ? this.plant - this.t0 - this.base_hits[this.base_hits.length - 1] : null; }
	provoked() { return this.booms.length || this.hits_while.length || this.base_hits.length; }
}

/* A superboom covering a grounded pill; fires read from the boom exactly as
 * a carry's are read from its plant. */
class GroundBoom {
	constructor(log, t0, k, x, y, live, quiet) {
		this.log = log;
		this.kind = "ground";
		this.t0 = t0;
		this.plant = t0;
		this.pill = k;
		this.nx = x;
		this.ny = y;
		this.live = live;
		this.quiet = quiet;              /* ticks since the pill's last 9n, or null */
		this.end = t0 + WINDOW;
		this.ended_by = "window";
		this.fires = [];
		this.gaps = [];
	}
	min_gap() { return this.gaps.length ? Math.min(...this.gaps) : null; }
	verdict() {
		if (!this.gaps.length) return "unobserved";
		return this.min_gap() <= ANGRY_GAP ? "angry" : "calm";
	}
}

const carries = [];        /* every carry that ended in a plant */
const ground_booms = [];   /* every superboom covering a grounded pill */
const floods = [];         /* crater on a vacated square beside water: {kind, flooded} */
let logs = 0, pickups = 0, plants = 0, carried_at_start = 0, unplanted = 0;

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
	let hit_times = Array.from({length: 16}, () => []);
	let ground_boom_times = Array.from({length: 16}, () => []);
	let open = new Array(16).fill(null);       /* carry in progress per pill index */
	let reading = [];                          /* carries planted, still in their fire window */
	let living = new Array(16).fill(null);     /* planted carry whose life is being counted, per pill index */
	let flood_open = [];                       /* {x, y, time, entry} waiting for a 6 1 */
	let last_time = -Infinity;

	for (let rec of recs) {
		let now = rec.time;
		if (now < last_time - 50) { open.fill(null); reading = []; flood_open = []; living.fill(null); }
		last_time = now;
		reading = reading.filter(c => now <= c.end);
		flood_open = flood_open.filter(f => now - f.time <= FLOOD_WINDOW);

		/* events are read against the state BEFORE the record is applied */
		for (let sub of rec.subpackets) {
			if (sub.type === "pillbox_damage") {
				let k = sub.pillbox;
				hit_times[k].push(now);
				if (open[k]) open[k].hits_while.push(now - open[k].t0);
				if (living[k]) living[k].life_hits++;
				for (let c of reading) if (c.pill === k) { c.end = now; c.ended_by = "pill hit"; }
			} else if (sub.type === "pillbox_fires") {
				let sender = rec.player;
				let pill = state.pills[sub.pillbox];
				let me = state.tanks[sender];
				let mc = me && tank_centre(me);
				if (sub.direction === 0 && (sub.pillbox & 1)) {
					let lower = state.pills[sub.pillbox - 1];
					let fits = p => p && p.inTank === null && mc && hostile(state, p, sender) &&
						Math.hypot(p.x * 16 + 8 - mc.x, p.y * 16 + 8 - mc.y) <= RANGE_PX;
					if (fits(lower) && !fits(pill)) pill = lower;
					else if (!fits(lower) && !fits(pill)) pill = null;
				}
				if (!pill) continue;
				let k = state.pills.indexOf(pill);
				if (pill.inTank !== null) { if (open[k]) open[k].fires_while++; continue; }
				if (pill.armour === 0) continue;
				let prev = last_fire[k][sender];
				let gap = now - prev;
				last_fire[k][sender] = now;
				for (let c of reading) {
					if (c.pill !== k) continue;
					c.fires.push([now - c.plant, sender]);
					if (Number.isFinite(gap) && gap >= 0 && prev >= c.plant) c.gaps.push(gap);
				}
			} else if (sub.type === "base_damage") {
				let base = state.bases[sub.base];
				if (!base) continue;
				for (let c of open) {
					if (!c) continue;
					let pill = state.pills[c.pill];
					if (!allied(state, pill.owner, base.owner)) continue;
					if (d2(c.ox, c.oy, base.x, base.y) < RADIUS_SQ) c.base_hits.push(now - c.t0);
				}
				for (let c of reading) {
					let pill = state.pills[c.pill];
					if (!allied(state, pill.owner, base.owner)) continue;
					if (d2(c.nx, c.ny, base.x, base.y) < RADIUS_SQ) { c.end = now; c.ended_by = "allied base hit"; }
				}
			} else if (sub.type === "explosion" && (sub.code === 0x0d || sub.code === 3)) {
				let squares = sub.code === 0x0d
					? [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => [sub.x + dx, sub.y + dy])
					: [[sub.x, sub.y]];
				if (sub.code === 0x0d) for (let k = 0; k < state.pills.length; k++) {
					let c = living[k];
					if (c && squares.some(([x, y]) => x === c.nx && y === c.ny)) { c.life_end = "boom"; living[k] = null; }
					let p = state.pills[k];
					if (p.inTank !== null || !squares.some(([x, y]) => x === p.x && y === p.y)) continue;
					ground_boom_times[k].push(now);
					let quiet = hit_times[k].length ? now - hit_times[k][hit_times[k].length - 1] : null;
					let g = new GroundBoom(label, now, k, p.x, p.y, p.armour > 0, quiet);
					ground_booms.push(g);
					reading.push(g);
				}
				for (let c of open) {
					if (!c) continue;
					let on = squares.some(([x, y]) => x === c.ox && y === c.oy);
					if (!on) continue;
					(sub.code === 0x0d ? c.booms : c.craters).push(now - c.t0);
					/* flood read-out: the vacated square, if it can report */
					let under = state.grid[c.oy * MAP_SIZE + c.ox];
					if (is_water(under) || under === 3) continue;
					if (state.bases.some(b => b.x === c.ox && b.y === c.oy)) continue;
					if (state.pills.some(p => p.inTank === null && p.x === c.ox && p.y === c.oy)) continue;
					if (!NEIGHBOURS.some(([dx, dy]) => is_water(state.grid[(c.oy + dy) * MAP_SIZE + c.ox + dx]))) continue;
					let entry = {log: label, t: now, kind: sub.code === 0x0d ? "7D" : "7 3", x: c.ox, y: c.oy, flooded: false, delay: null};
					floods.push(entry);
					flood_open.push({x: c.ox, y: c.oy, time: now, entry});
				}
			} else if (sub.type.startsWith("pill_repair")) {
				let k = sub.pillbox;
				if (living[k]) { living[k].life_end = "repair"; living[k] = null; }
			} else if (sub.type === "terrain_change") {
				if (sub.terrain === 1) {
					for (let f of flood_open) if (f.x === sub.x && f.y === sub.y && !f.entry.flooded) {
						f.entry.flooded = true;
						f.entry.delay = now - f.time;
					}
				}
				if (BUILD_TERRAIN.has(sub.terrain)) {
					for (let c of open) if (c && c.ox === sub.x && c.oy === sub.y) c.builds.push([now - c.t0, sub.terrain]);
				}
			}
		}

		/* pickups and plants, read before the record moves the pills */
		let pl = rec.player;
		for (let sub of rec.subpackets) {
			if (sub.type === "pill_pickup") {
				let k = sub.pillbox;
				let p = state.pills[k];
				if (!p) continue;
				pickups++;
				if (living[k]) { living[k].life_end = "pickup"; living[k] = null; }
				if (p.inTank !== null) { open[k] = null; continue; }   /* a pill the model held carried: no old square */
				let recent = hit_times[k].filter(t => now - t <= HIT_LOOKBACK).length;
				let last = hit_times[k].length ? now - hit_times[k][hit_times[k].length - 1] : null;
				let last_boom = ground_boom_times[k].length ? now - ground_boom_times[k][ground_boom_times[k].length - 1] : null;
				open[k] = new Carry(label, now, k, p.x, p.y, pl, recent, last, last_boom);
			} else if (sub.type === "pill_plant") {
				let k = state.pills.findIndex(p => p.inTank === pl);
				if (k < 0) continue;
				plants++;
				let c = open[k];
				if (!c) { carried_at_start++; continue; }
				open[k] = null;
				c.plant = now;
				c.nx = sub.x;
				c.ny = sub.y;
				c.end = now + WINDOW;
				carries.push(c);
				reading.push(c);
				living[k] = c;
			} else if (sub.type === "pill_dumped_by_dead_lgm") {
				let k = state.pills.findIndex(p => p.inTank === pl);
				if (k >= 0 && open[k]) { unplanted++; open[k] = null; }
			}
		}
		let carried_before = state.pills.map(p => p.inTank);
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
		/* death, quit and netsplit dumps end a carry without a plant */
		state.pills.forEach((p, k) => {
			if (open[k] && carried_before[k] !== null && p.inTank !== carried_before[k]) { unplanted++; open[k] = null; }
			if (living[k] && (p.inTank !== null || p.x !== living[k].nx || p.y !== living[k].ny)) { living[k].life_end = "dump"; living[k] = null; }
		});
	}
}

let args = process.argv.slice(2).filter(a => !a.startsWith("--"));
let targets = args.length ? args : [corpus_root()];
for (let target of targets) for (let file of walk(target)) scan(file);

/* ---- report ---- */

function pct(a, b) {
	return b ? (100 * a / b).toFixed(1).padStart(5) + "%" : "    -";
}

function median(xs) {
	if (!xs.length) return "-";
	let s = xs.slice().sort((a, b) => a - b);
	return String(s[s.length >> 1]);
}

function describe(c) {
	return `${c.log} pill ${c.pill} picked t${c.t0} at ${c.ox},${c.oy} by p${c.picker} (last 9n ${c.last_hit_before === null ? "never" : c.last_hit_before + " ticks"} before), ` +
		`planted t${c.plant} at ${c.nx},${c.ny} after ${c.carry_ticks()} ticks; ` +
		`booms +${c.booms.join(",+")} 9n-while ${c.hits_while.length} base-hits ${c.base_hits.length}; ` +
		`fires ${c.fires.map(f => `+${f[0]}/p${f[1]}`).join(" ")} gaps ${c.gaps.join(",")} ended by ${c.ended_by}; ` +
		`life ${c.life_hits} hits then ${c.life_end || "log end"}`;
}

function row(name, set) {
	let obs = set.filter(c => c.verdict() !== "unobserved");
	let angry = obs.filter(c => c.verdict() === "angry").length;
	let gaps = obs.map(c => c.min_gap());
	console.log(`${name.padEnd(46)} carries ${String(set.length).padStart(6)}  observed ${String(obs.length).padStart(5)}  ` +
		`angry ${String(angry).padStart(5)}  ${pct(angry, obs.length)}  median min gap ${median(gaps).padStart(4)}`);
}

console.log(`logs ${logs}, pickups ${pickups}, plants ${plants} (${carried_at_start} of a pill carried since the log began, no old square), ` +
	`carries followed to a plant ${carries.length}, carries ended by a dump ${unplanted}`);

let boomed = carries.filter(c => c.booms.length);
let hit_while = carries.filter(c => c.hits_while.length);
let base_hit = carries.filter(c => c.base_hits.length && !c.booms.length && !c.hits_while.length);
let control = carries.filter(c => !c.provoked());
let cratered = carries.filter(c => c.craters.length);

console.log(`\nwhat landed on the vacated square during the carry: superboom ${boomed.length} carries (${boomed.reduce((a, c) => a + c.booms.length, 0)} booms), ` +
	`single crater ${cratered.length}, 9n on the carried pill's index ${hit_while.length} carries (${hit_while.reduce((a, c) => a + c.hits_while.length, 0)} hits), ` +
	`allied base hit inside the circle ${carries.filter(c => c.base_hits.length).length} carries (${carries.reduce((a, c) => a + c.base_hits.length, 0)} hits), ` +
	`F4 naming a carried pill ${carries.reduce((a, c) => a + c.fires_while, 0)}`);

console.log("\n=== fire gaps after the plant: the smallest per-sender gap inside the window classifies the pill ===");
row("control: nothing on the old square", control);
row("superboom on the old square", boomed);
row("  ...last boom within 500 ticks of the plant", boomed.filter(c => c.last_boom_to_plant() <= 500));
row("  ...last boom within 1500 ticks of the plant", boomed.filter(c => c.last_boom_to_plant() <= 1500));
row("  ...last boom more than 1500 ticks before", boomed.filter(c => c.last_boom_to_plant() > 1500));
row("allied base hit inside the circle (no boom)", base_hit);
row("  ...last hit within 500 ticks of the plant", base_hit.filter(c => c.last_base_hit_to_plant() <= 500));
row("  ...two or more hits, last within 500 ticks", base_hit.filter(c => c.base_hits.length >= 2 && c.last_base_hit_to_plant() <= 500));
row("  ...last hit more than 1500 ticks before", base_hit.filter(c => c.last_base_hit_to_plant() > 1500));
row("9n on the pill's index while carried", hit_while);

console.log("\n=== the prior question: does any anger survive pickup and plant? control carries by carry length ===");
console.log("(a pill just killed by shells was at or near the 6-tick floor when it died)");
for (let [name, lo, hi] of [["under 5 s", 0, 250], ["5-15 s", 250, 750], ["15-30 s", 750, 1500], ["30-60 s", 1500, 3000], ["1-3 min", 3000, 9000], ["over 3 min", 9000, Infinity]]) {
	row(`carried ${name}`, control.filter(c => c.carry_ticks() >= lo && c.carry_ticks() < hi));
}
row("carried under 15 s, 5+ hits in the 12 s before pickup", control.filter(c => c.carry_ticks() < 750 && c.hits_before >= 5));
row("carried under 15 s, last hit under 5 s before pickup", control.filter(c => c.carry_ticks() < 750 && c.last_hit_before !== null && c.last_hit_before < 250));

console.log("\n=== control carries under 15 s, by how long before the pickup the pill was last hit (does a dead pill relax on the ground?) ===");
let short_ctl = control.filter(c => c.carry_ticks() < 750);
for (let [name, lo, hi] of [["under 5 s", 0, 250], ["5-30 s", 250, 1500], ["30-60 s", 1500, 3000], ["1-2 min", 3000, 6000], ["2-5 min", 6000, 15000], ["over 5 min", 15000, Infinity]]) {
	row(`last hit ${name} before pickup`, short_ctl.filter(c => c.last_hit_before !== null && c.last_hit_before >= lo && c.last_hit_before < hi));
}
row("never hit on the record (dead when the log began)", short_ctl.filter(c => c.last_hit_before === null));

console.log(`\n=== the test: pills at rest at pickup (unhit for ${REST_TICKS} ticks or never), planted soon after the provocation ===`);
let rested = carries.filter(c => c.rested_at_pickup());
row("control, at rest, carried under 30 s", rested.filter(c => !c.provoked() && c.carry_ticks() < 1500));
row("control, at rest, carried 30-60 s", rested.filter(c => !c.provoked() && c.carry_ticks() >= 1500 && c.carry_ticks() < 3000));
row("superboom on old square, rest, boom <=1500 before plant", rested.filter(c => c.booms.length && c.last_boom_to_plant() <= 1500));
row("superboom on old square, rest, any", rested.filter(c => c.booms.length));
row("base hit in circle, rest, last hit <=500 before plant", rested.filter(c => c.base_hits.length && !c.booms.length && c.last_base_hit_to_plant() <= 500));
row("base hit in circle, rest, 2+ hits, last <=500 before", rested.filter(c => c.base_hits.length >= 2 && !c.booms.length && c.last_base_hit_to_plant() <= 500));
row("base hit in circle, rest, 5+ hits, last <=500 before", rested.filter(c => c.base_hits.length >= 5 && !c.booms.length && c.last_base_hit_to_plant() <= 500));
row("base hit in circle, rest, last hit >1500 before plant", rested.filter(c => c.base_hits.length && !c.booms.length && c.last_base_hit_to_plant() > 1500));

/* Matched comparison: a carry's post-plant gap against control carries at
 * the same elapsed time since the pill's last 9n. Anger relaxes with that
 * time, so a provoked pill should sit low in its bin. */
const ELAPSED_BINS = [0, 100, 200, 400, 800, 1600, 3200, 6400, Infinity];
function bin_of(e) { return ELAPSED_BINS.findIndex((b, i) => e >= b && e < ELAPSED_BINS[i + 1]); }
let control_obs = control.filter(c => c.verdict() !== "unobserved" && c.elapsed() !== null);
let control_bins = ELAPSED_BINS.slice(0, -1).map((_, i) => control_obs.filter(c => bin_of(c.elapsed()) === i).map(c => c.min_gap()).sort((a, b) => a - b));

function matched(name, set) {
	let obs = set.filter(c => c.verdict() !== "unobserved" && c.elapsed() !== null);
	console.log(`\n--- ${name}: ${obs.length} observed ---`);
	console.log("  each case: ticks since the last 9n at the plant, its smallest gap, the control's median at that elapsed time, and the fraction of the control at or below the case");
	let fracs = [];
	for (let c of obs) {
		let i = bin_of(c.elapsed());
		let ctl = control_bins[i];
		if (!ctl.length) continue;
		let at_or_below = ctl.filter(g => g <= c.min_gap()).length / ctl.length;
		fracs.push(at_or_below);
		console.log(`  ${c.log.padEnd(18)} pill ${String(c.pill).padStart(2)} elapsed ${String(c.elapsed()).padStart(6)}  gap ${String(c.min_gap()).padStart(4)}  ` +
			`control [${ELAPSED_BINS[i]}, ${ELAPSED_BINS[i + 1]}) n ${String(ctl.length).padStart(5)} median ${String(ctl[ctl.length >> 1]).padStart(4)}  ` +
			`frac at/below ${at_or_below.toFixed(2)}${c.booms.length ? `  boom ${c.last_boom_to_plant()} before plant` : ""}` +
			`${c.base_hits.length ? `  base hits ${c.base_hits.length}, last ${c.last_base_hit_to_plant()} before plant` : ""}` +
			`${c.ground_boom_after_last_hit() ? `  ground boom ${c.last_ground_boom_before} before pickup` : ""}`);
	}
	if (fracs.length) {
		let mean = fracs.reduce((a, b) => a + b, 0) / fracs.length;
		let below = fracs.filter(f => f < 0.5).length;
		console.log(`  mean fraction ${mean.toFixed(2)} (0.50 if the provocation did nothing), ${below} of ${fracs.length} below the control median`);
	}
}

console.log("\n=== matched against the control at the same elapsed time since the pill's last hit ===");
console.log("control bins: " + control_bins.map((b, i) => `[${ELAPSED_BINS[i]},${ELAPSED_BINS[i + 1]}) n ${b.length} median ${b.length ? b[b.length >> 1] : "-"}`).join("; "));
matched("superboom on the vacated square, within 1500 ticks of the plant", boomed.filter(c => c.last_boom_to_plant() <= 1500));
matched("superboom on the pill while it lay dead on the ground, after its last hit, then carried under 30 s", carries.filter(c => c.ground_boom_after_last_hit() && !c.provoked() && c.carry_ticks() < 1500));
matched("allied base hit inside the circle of the vacated square, last within 500 ticks of the plant", base_hit.filter(c => c.last_base_hit_to_plant() <= 500));

console.log("\n=== superboom on a grounded pill: fire gaps in the 500 ticks after the boom ===");
function ground_row(name, set) {
	let obs = set.filter(g => g.verdict() !== "unobserved");
	let angry = obs.filter(g => g.verdict() === "angry").length;
	console.log(`${name.padEnd(56)} booms ${String(set.length).padStart(5)}  observed ${String(obs.length).padStart(4)}  angry ${String(angry).padStart(4)}  ${pct(angry, obs.length)}  median min gap ${median(obs.map(g => g.min_gap())).padStart(4)}`);
}
let live_booms = ground_booms.filter(g => g.live);
ground_row("live pill, any", live_booms);
ground_row("live pill, unhit for 3000 ticks before the boom", live_booms.filter(g => g.quiet === null || g.quiet >= 3000));
ground_row("live pill, unhit for 1500 ticks before the boom", live_booms.filter(g => g.quiet === null || g.quiet >= 1500));
ground_row("live pill, hit within 500 ticks before the boom", live_booms.filter(g => g.quiet !== null && g.quiet < 500));
ground_row("dead pill (fires only if repaired in the window)", ground_booms.filter(g => !g.live));
console.log("  every live-pill boom with the pill unhit for 1500 ticks:");
for (let g of live_booms.filter(g => (g.quiet === null || g.quiet >= 1500) && g.verdict() !== "unobserved"))
	console.log(`    ${g.log} t${g.t0} pill ${g.pill} at ${g.nx},${g.ny} quiet ${g.quiet === null ? "never hit" : g.quiet} fires ${g.fires.map(f => `+${f[0]}/p${f[1]}`).join(" ")} gaps ${g.gaps.join(",")} ended by ${g.ended_by}`);

console.log("\n=== armour: 9n hits taken after the plant before the pill was next picked up dead (a plant at full armour takes 15; a boomed pill would take 11) ===");
function life_row(name, set) {
	let done = set.filter(c => c.life_end === "pickup");
	let bins = {};
	for (let c of done) bins[c.life_hits] = (bins[c.life_hits] || 0) + 1;
	console.log(`${name.padEnd(46)} lives ended by pickup ${String(done.length).padStart(5)}: ` +
		Object.keys(bins).map(Number).sort((a, b) => a - b).map(h => `${h}:${bins[h]}`).join(" "));
}
life_row("control", control);
life_row("superboom on the old square during the carry", boomed);
life_row("base hits in the circle during the carry", base_hit);

console.log("\n=== crater on the vacated square beside water: each case ===");
for (let f of floods) console.log(`  ${f.log} t${f.t} ${f.kind} at ${f.x},${f.y} ${f.flooded ? `flooded after ${f.delay} ticks` : "no flood"}`);

console.log("\n=== distribution of the smallest gap after the plant (observed carries) ===");
for (let [name, set] of [["control", control], ["superboomed", boomed], ["base-hit", base_hit]]) {
	let obs = set.filter(c => c.verdict() !== "unobserved");
	let bins = {"<=10": 0, "11-30": 0, "31-70": 0, "71-90": 0, "91-110": 0, ">110": 0};
	for (let c of obs) {
		let g = c.min_gap();
		bins[g <= 10 ? "<=10" : g <= 30 ? "11-30" : g <= 70 ? "31-70" : g <= 90 ? "71-90" : g <= 110 ? "91-110" : ">110"]++;
	}
	console.log(`${name.padEnd(12)} ${Object.entries(bins).map(([k, v]) => `${k}: ${v}`).join("  ")}`);
}

console.log("\n=== the ground: a crater on the vacated square beside water, does it flood? (bare ground floods 97-100%, a pill square never) ===");
for (let kind of ["7D", "7 3"]) {
	let set = floods.filter(f => f.kind === kind);
	let fl = set.filter(f => f.flooded);
	console.log(`${kind.padEnd(4)} n ${set.length}  flooded ${fl.length}  ${pct(fl.length, set.length)}  median delay ${median(fl.map(f => f.delay))} ticks`);
}

let built = carries.filter(c => c.builds.length);
console.log(`\n=== builds on the vacated square while the pill was carried: ${built.length} carries, ${built.reduce((a, c) => a + c.builds.length, 0)} builds ` +
	`(Bolo refuses a build on a square holding a grounded pill) ===`);

console.log("\n=== every superboomed carry ===");
for (let c of boomed) console.log(`  ${describe(c)}`);

if (SAMPLES) {
	console.log("\n=== samples: control carries under 5 s reading angry ===");
	for (let c of control.filter(c => c.carry_ticks() < 250 && c.verdict() === "angry").slice(0, 12)) console.log(`  ${describe(c)}`);
	console.log("\n=== samples: control carries under 5 s reading calm ===");
	for (let c of control.filter(c => c.carry_ticks() < 250 && c.verdict() === "calm").slice(0, 12)) console.log(`  ${describe(c)}`);
	console.log("\n=== samples: base-hit carries, last hit within 500 ticks, reading angry ===");
	for (let c of base_hit.filter(c => c.last_base_hit_to_plant() <= 500 && c.verdict() === "angry").slice(0, 12)) console.log(`  ${describe(c)}`);
}
