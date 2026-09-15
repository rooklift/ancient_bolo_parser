#!/usr/bin/env node
/* Read a single-player experiment log -- one tank on one machine, recorded
 * in an emulator -- and print what its controlled trials show.
 *
 * A solo log is the one kind of replay in which the ground truth is known:
 * the owner typed what the tank was carrying into the chat, every record
 * is the same machine's, there is no ring to lose or delay a record, and
 * every shell in the air belongs to the tank or to a pillbox the tank is
 * the target of.  So the readings below need none of the attribution the
 * corpus tools spend their effort on, and each one is a direct test of a
 * rule the corpus could only fit.  The first such log is
 * `fixtures/emulator_solo` (17.7 minutes, strict game, one player); the
 * sections and what they settle:
 *
 *   lives     ammo aboard at each death, integrated as measure-death-ammo
 *             does (+1 per Bn/Cn, -1 per 5d/F7/7C, held at 40, from an
 *             empty respawn), against the terminal-explosion tier, with
 *             the owner's chat as the check on the integration
 *   reload    the interval between a stationary tank's shots, and how the
 *             record cadence quantises it
 *   pills     each pill's fire gap after every hit it takes -- the anger
 *             ladder -- and the gap ladder by number of hits taken
 *   mines     every mine laid, every crater on a laid square, and which
 *             craters were set off by a neighbouring crater rather than by
 *             the tank (the chain reaction), plus the squares the tank sat
 *             on while shells hit it and no mine went off
 *   fording   every stint of the tank on water without a boat, and the
 *             refill the next base gave, which is what the water took
 *   walls     each building's hit sequence from first shot to rubble
 *   refuel    drain cadence per resource, and the base stock timer
 *
 * Usage:
 *   node tools/measure-emulator-log.cjs <log>       (default fixtures/emulator_solo)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const MAP_SIZE = 256;
const MAX_SHELLS = 40;
const MAX_MINES = 40;
const MAX_ARMOUR = 9;
const TIER_WINDOW = 60;          /* ticks after F9 in which the terminal crater arrives (seen: 48-50) */
const BURST_BREAK = 100;         /* a shot this long after the last starts a new burst */
const CHAIN_MIN = 4, CHAIN_MAX = 12; /* ticks between a crater and the neighbour it sets off (seen: 7-9) */
const WATER = new Set([1, 255]); /* river, deep sea */

let file = process.argv[2] || path.join(__dirname, "..", "fixtures", "emulator_solo");
let recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
let game = BoloGame.build(recs);
let t0 = recs[0].time;

function stamp(t) {
	let d = t - t0;
	let m = Math.floor(d / 3000), s = ((d % 3000) / 50).toFixed(1).padStart(4, "0");
	return `${m}:${s}`;
}

/* Centre square of a tank position: the pixel needs the half-tile
 * centring [E:centring], so the square is the one holding pixel + 8. */
function centre_square(pos) {
	return [Math.floor((pos.x * 16 + pos.pixelX + 8) / 16), Math.floor((pos.y * 16 + pos.pixelY + 8) / 16)];
}

function median(values) {
	if (!values.length) return null;
	let sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/* One flat list of subpackets with their record's time, the record's own
 * tank position, and the last tank position seen. */
let events = [];
let last_pos = null;
for (let i = 0; i < recs.length; i++) {
	let rec = recs[i];
	let pos = rec.subpackets.find(s => s.type === "tank_position") || null;
	if (pos) last_pos = pos;
	for (let sub of rec.subpackets) events.push({ t: rec.time, index: i, pos, last_pos, ...sub });
}

let players = new Set(recs.map(r => r.player));
console.log(`log: ${path.basename(file)}  records ${recs.length}  ${((recs[recs.length - 1].time - t0) / 3000).toFixed(1)} min  game type ${game.final.gameInfo.gameType}  players ${players.size}`);
if (players.size !== 1) console.log("WARNING: not a solo log; the readings below assume one sender");

/* ---------------------------------------------------------------- lives */
console.log("\n=== lives: ammo aboard at death vs terminal tier ===");
console.log("integration: +1 shell per Bn, +1 mine per Cn, +1 armour per Dn (held at 40 / 40 / 9);");
console.log("-1 shell per 5d, -1 mine per F7 and per 7C, -1 armour per FC; from an empty respawn (strict game)\n");
let lives = [];
let life = null, alive = true, last_death = null;
function new_life(t) {
	life = { start: t, shells: 0, mines: 0, armour: MAX_ARMOUR, drains: { shells: 0, mines: 0, armor: 0 },
		shots: 0, laid: 0, planted: 0, hits: 0, chat: [] };
	lives.push(life);
}
new_life(t0);
for (let e of events) {
	if (e.type === "tank_position" && !e.dying && !alive) {
		alive = true;
		new_life(e.t);
		life.respawn_gap = e.t - last_death;
		life.respawn_square = centre_square(e);
	}
	if (!alive) continue;
	switch (e.type) {
		case "base_drain":
			life.drains[e.resource]++;
			if (e.resource === "shells") life.shells = Math.min(MAX_SHELLS, life.shells + 1);
			else if (e.resource === "mines") life.mines = Math.min(MAX_MINES, life.mines + 1);
			else life.armour = Math.min(MAX_ARMOUR, life.armour + 1);
			break;
		case "shot_fired": life.shots++; life.shells--; break;
		case "lay_mine": life.laid++; life.mines--; break;
		case "explosion": if (e.code === 12) { life.planted++; life.mines--; } break;
		case "tank_hit": life.hits++; life.armour--; break;
		case "message": life.chat.push({ t: e.t, text: e.text, shells: life.shells, mines: life.mines, armour: life.armour }); break;
		case "tank_death": {
			alive = false;
			last_death = e.t;
			life.death = e.t;
			life.death_code = e.code;
			life.death_square = e.pos ? centre_square(e.pos) : null;
			/* the tier: a 7D, or else a 7 3, inside the window after the F9.
			 * The wreck can slide into a minefield, so a crater on a square
			 * the tank mined, or one set off by a neighbouring crater, is
			 * passed over when another is on offer. */
			let laid_so_far = new Set(events.filter(l => l.type === "lay_mine" && l.t < e.t && l.pos).map(l => centre_square(l.pos).join(",")));
			let window = events.filter(f => f.type === "explosion" && f.t > e.t && f.t - e.t <= TIER_WINDOW && (f.code === 3 || f.code === 13));
			let chained = f => window.some(p => p.t < f.t && f.t - p.t >= CHAIN_MIN && f.t - p.t <= CHAIN_MAX && Math.abs(p.x - f.x) + Math.abs(p.y - f.y) === 1);
			let pick = window.find(f => f.code === 13) || window.find(f => !laid_so_far.has(`${f.x},${f.y}`) && !chained(f)) || window[0] || null;
			life.tier = pick === null ? "none" : pick.code === 13 ? "superboom" : "crater";
			life.tier_at = pick === null ? null : pick.t - e.t;
			break;
		}
	}
}
for (let [n, l] of lives.entries()) {
	let head = l.respawn_gap === undefined ? `life ${n + 1}: log start` : `life ${n + 1}: respawn at ${stamp(l.start)} (${l.respawn_gap} ticks after the death) at (${l.respawn_square})`;
	console.log(head);
	for (let c of l.chat) console.log(`    ${stamp(c.t)} chat "${c.text}"  [integration: ${c.shells} shells, ${c.mines} mines, armour ${c.armour}]`);
	if (l.death === undefined) { console.log("    alive at log end"); continue; }
	console.log(`    drains B ${l.drains.shells} C ${l.drains.mines} D ${l.drains.armor}; shots ${l.shots}, mines laid ${l.laid}, man-planted ${l.planted}; hits ${l.hits}`);
	console.log(`    death ${stamp(l.death)} code ${l.death_code} at (${l.death_square}) with ${l.shells} shells + ${l.mines} mines = ${l.shells + l.mines}, armour ${l.armour}: ${l.tier}${l.tier_at === null ? "" : ` at +${l.tier_at}`}`);
}
console.log("\nsum of shells + mines -> tier:");
let by_sum = lives.filter(l => l.death !== undefined).sort((a, b) => (a.shells + a.mines) - (b.shells + b.mines));
console.log("  " + by_sum.map(l => `${l.shells + l.mines} (${l.shells}+${l.mines}) ${l.tier}`).join("\n  "));

/* --------------------------------------------------------------- reload */
console.log("\n=== reload: gaps between a tank's shots ===");
let shots = events.filter(e => e.type === "shot_fired");
let steady = [], first_of_burst = [], second_of_burst = [];
for (let k = 1; k < shots.length; k++) {
	let gap = shots[k].t - shots[k - 1].t;
	let prev_gap = k > 1 ? shots[k - 1].t - shots[k - 2].t : Infinity;
	let record_gap_before_prev = recs[shots[k - 1].index].time - recs[shots[k - 1].index - 1].time;
	if (gap > BURST_BREAK) continue;
	if (prev_gap > BURST_BREAK) second_of_burst.push({ gap, record_gap_before_prev });
	else steady.push({ gap, speed: shots[k].last_pos ? shots[k].last_pos.speed : null });
}
const RELOAD_REGIME = 20;    /* a gap past this is a pause in the burst, not a reload */
let hist = {};
for (let s of steady) hist[s.gap] = (hist[s.gap] || 0) + 1;
let reloads = steady.filter(s => s.gap <= RELOAD_REGIME).map(s => s.gap);
let still = steady.filter(s => s.gap <= RELOAD_REGIME && s.speed === 0).map(s => s.gap);
let mean = a => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(2);
console.log(`shots ${shots.length}; records carrying two shots: ${recs.filter(r => r.subpackets.filter(s => s.type === "shot_fired").length > 1).length}`);
console.log(`gaps within a burst, after the second shot: n ${steady.length}`);
console.log("  histogram: " + Object.entries(hist).sort((a, b) => a[0] - b[0]).map(([g, n]) => `${g}:${n}`).join(" "));
console.log(`  gaps up to ${RELOAD_REGIME} ticks (the reload itself): n ${reloads.length}, mean ${mean(reloads)}, median ${median(reloads)}`);
console.log(`  of those, with the tank stationary (last speed byte 0): n ${still.length}, mean ${mean(still)}`);
let longest = null, run = [];
for (let s of steady) { if (s.gap <= RELOAD_REGIME) run.push(s.gap); else run = []; if (run.length > (longest ? longest.length : 0)) longest = run.slice(); }
if (longest) console.log(`  longest unbroken run: ${longest.length} gaps, ${longest.reduce((a, b) => a + b, 0)} ticks, ${mean(longest)} per shot: ${longest.join(" ")}`);
console.log("second shot of a burst, gap / record interval that ended at the first shot's record:");
console.log("  " + second_of_burst.map(s => `${s.gap}/${s.record_gap_before_prev}`).join(" "));
let record_gaps = {};
for (let i = 1; i < recs.length; i++) { let d = recs[i].time - recs[i - 1].time; if (d <= 8) record_gaps[d] = (record_gaps[d] || 0) + 1; }
console.log("record intervals up to 8 ticks: " + Object.entries(record_gaps).map(([g, n]) => `${g}:${n}`).join(" "));

/* ---------------------------------------------------------------- pills */
console.log("\n=== pillbox anger: fire gaps after each hit ===");
let pills = new Map();
for (let e of events) {
	if (e.type === "pillbox_damage") { if (!pills.has(e.pillbox)) pills.set(e.pillbox, []); pills.get(e.pillbox).push({ t: e.t, kind: "hit" }); }
	if (e.type === "pillbox_fires") { if (!pills.has(e.pillbox)) pills.set(e.pillbox, []); pills.get(e.pillbox).push({ t: e.t, kind: "fire" }); }
}
let ladder = new Map(); /* hits taken -> clean gaps (no hit between the two fires) */
let initial = game.keyframes[0].state;
for (let [pill, list] of [...pills.entries()].sort((a, b) => a[0] - b[0])) {
	list.sort((a, b) => a.t - b.t);
	let hits = 0, last_fire = null, hit_since_fire = false, line = [];
	for (let e of list) {
		if (e.kind === "hit") { hits++; hit_since_fire = true; line.push(`HIT${hits}@${stamp(e.t)}`); continue; }
		if (last_fire !== null) {
			let gap = e.t - last_fire;
			line.push(hit_since_fire ? `+${gap}*` : `+${gap}`);
			if (!hit_since_fire) { if (!ladder.has(hits)) ladder.set(hits, []); ladder.get(hits).push(gap); }
		} else line.push(`fire@${stamp(e.t)}`);
		last_fire = e.t;
		hit_since_fire = false;
	}
	let speed = initial.pills && initial.pills[pill] ? initial.pills[pill].speed : "?";
	console.log(`pill ${pill} (listed speed ${speed}): ${list.filter(e => e.kind === "hit").length} hits, ${list.filter(e => e.kind === "fire").length} fires`);
	console.log("    " + line.join(" "));
}
console.log("(* marks a gap with a hit inside it; those are left out of the ladder)");
console.log("ladder: hits taken -> clean fire gaps (median, n, range), gaps over 400 ticks dropped as idle:");
for (let [hits, gaps] of [...ladder.entries()].sort((a, b) => a[0] - b[0])) {
	let g = gaps.filter(x => x <= 400);
	if (!g.length) continue;
	console.log(`  ${hits} hits: median ${median(g)}, n ${g.length}, ${Math.min(...g)}-${Math.max(...g)}`);
}

/* ---------------------------------------------------------------- mines */
console.log("\n=== mines: laid, detonated, chained ===");
let laid = events.filter(e => e.type === "lay_mine").map(e => ({ t: e.t, square: e.pos ? centre_square(e.pos) : null }));
console.log(`mines laid by the tank (F7): ${laid.length}, of which ${laid.filter(l => l.square).length} in a record with a tank position`);
console.log("  " + laid.map(l => `${stamp(l.t)}${l.square ? ` (${l.square})` : ""}`).join(", "));
let craters = events.filter(e => e.type === "explosion" && e.code === 3);
let deaths = events.filter(e => e.type === "tank_death");
let chained = 0, wreck_or_tank = 0, terminal = 0;
for (let c of craters) {
	let pred = craters.find(p => p.t < c.t && c.t - p.t >= CHAIN_MIN && c.t - p.t <= CHAIN_MAX && Math.abs(p.x - c.x) + Math.abs(p.y - c.y) === 1);
	let death = deaths.find(d => d.t < c.t && c.t - d.t <= TIER_WINDOW);
	let sq = c.last_pos ? centre_square(c.last_pos) : null;
	let on_laid = laid.some(l => l.square && l.square[0] === c.x && l.square[1] === c.y);
	let kind;
	if (pred) { kind = `chained from (${pred.x},${pred.y}) ${c.t - pred.t} ticks earlier`; chained++; }
	else if (death && !on_laid) { kind = `terminal crater, +${c.t - death.t} after the death`; terminal++; }
	else { kind = `set off by the ${death ? "wreck" : "tank"}, last at (${sq})`; wreck_or_tank++; }
	console.log(`  ${stamp(c.t)} crater at (${c.x},${c.y})${on_laid ? " [laid square]" : ""}: ${kind}`);
}
console.log(`craters ${craters.length}: ${terminal} terminal, ${wreck_or_tank} first of a field, ${chained} chained (4-neighbour, ${CHAIN_MIN}-${CHAIN_MAX} ticks)`);
let chain_gaps = craters.map(c => { let p = craters.find(p => p.t < c.t && c.t - p.t >= CHAIN_MIN && c.t - p.t <= CHAIN_MAX && Math.abs(p.x - c.x) + Math.abs(p.y - c.y) === 1); return p ? c.t - p.t : null; }).filter(x => x !== null);
if (chain_gaps.length) console.log(`chain hop: median ${median(chain_gaps)} ticks, ${Math.min(...chain_gaps)}-${Math.max(...chain_gaps)}`);
/* hits on the tank while it sat on a laid square that never cratered */
let laid_squares = new Set(laid.filter(l => l.square).map(l => l.square.join(",")));
let hits_on_mine = new Map();
for (let e of events) {
	if (e.type !== "tank_hit" || !e.last_pos) continue;
	let sq = centre_square(e.last_pos).join(",");
	if (!laid_squares.has(sq)) continue;
	let cratered = craters.some(c => `${c.x},${c.y}` === sq);
	hits_on_mine.set(sq, (hits_on_mine.get(sq) || 0) + 1);
	hits_on_mine.set(sq + " cratered", cratered);
}
for (let [sq, n] of hits_on_mine) if (!sq.endsWith("cratered")) console.log(`shell hits on the tank while its centre sat on laid square (${sq}): ${n}; square ever cratered: ${hits_on_mine.get(sq + " cratered")}`);

/* -------------------------------------------------------------- fording */
console.log("\n=== fording: stints on water without a boat, and the refill after ===");
let grid = game.keyframes[0].state.grid.slice();
let stints = [];
let stint = null;
let shells_now = 0, mines_now = 0;
alive = true;
for (let e of events) {
	if (e.type === "terrain_change") grid[e.y * MAP_SIZE + e.x] = e.terrain;
	if (e.type === "explosion" && e.code <= 9) grid[e.y * MAP_SIZE + e.x] = e.code;
	if (e.type === "tank_position" && !e.dying && !alive) { alive = true; shells_now = 0; mines_now = 0; }
	if (e.type === "tank_death") alive = false;
	if (e.type === "base_drain") { if (e.resource === "shells") shells_now = Math.min(MAX_SHELLS, shells_now + 1); if (e.resource === "mines") mines_now = Math.min(MAX_MINES, mines_now + 1); }
	if (e.type === "shot_fired") shells_now--;
	if (e.type === "lay_mine") mines_now--;
	if (e.type === "explosion" && e.code === 12) mines_now--;
	if (e.type !== "tank_position" || e.dying) continue;
	let [x, y] = centre_square(e);
	let wet = WATER.has(grid[y * MAP_SIZE + x]) && !e.inBoat;
	if (wet && !stint) { stint = { start: e.t, squares: 0, last_square: null, shells_before: shells_now, mines_before: mines_now, speeds: [] }; stints.push(stint); }
	if (stint) {
		if (wet) {
			let k = `${x},${y}`;
			if (k !== stint.last_square) { stint.squares++; stint.last_square = k; }
			stint.speeds.push(e.speed);
			stint.end = e.t;
		} else stint = null;
	}
}
for (let s of stints) {
	/* the next refill: the drains that follow, until a gap of 100 ticks */
	let refill = { shells: 0, mines: 0 }, last_drain = null, refill_start = null;
	for (let e of events) {
		if (e.t <= s.end || e.type !== "base_drain") continue;
		if (last_drain !== null && e.t - last_drain > 100) break;
		if (refill_start === null) refill_start = e.t;
		refill[e.resource] = (refill[e.resource] || 0) + 1;
		last_drain = e.t;
	}
	console.log(`${stamp(s.start)}-${stamp(s.end)}: ${s.end - s.start} ticks on water, ${s.squares} squares, speed byte median ${median(s.speeds)}; aboard before (integrated): ${s.shells_before} shells, ${s.mines_before} mines`);
	if (refill_start !== null) console.log(`    next refill from ${stamp(refill_start)}: ${refill.shells} shells, ${refill.mines} mines, then the stream stopped`);
}
if (!stints.length) console.log("none");

/* ---------------------------------------------------------------- walls */
console.log("\n=== walls: hit sequences per building square ===");
let squares = new Map();
for (let e of events) {
	if (e.type === "explosion" && [0, 6, 8, 11].includes(e.code) || e.type === "terrain_change" && [0, 8].includes(e.terrain)) {
		let k = `${e.x},${e.y}`;
		if (!squares.has(k)) squares.set(k, []);
		squares.get(k).push(e.type === "explosion" ? (e.code === 11 ? "unchanged" : e.code === 8 ? "SHOT" : e.code === 6 ? "RUBBLE" : "building") : (e.terrain === 0 ? "built" : "shot(6T)"));
	}
}
let complete = [];
for (let [k, seq] of squares) {
	let i = seq.indexOf("SHOT"), j = seq.indexOf("RUBBLE");
	let summary = seq.join(" ");
	if (i >= 0 && j > i) { let unchanged = seq.slice(i + 1, j).filter(s => s === "unchanged").length; complete.push(unchanged); summary += `   => ${unchanged} unchanged hits between shot and rubble`; }
	console.log(`  (${k}): ${summary}`);
}
if (complete.length) console.log(`walls followed from shot to rubble: ${complete.length}; unchanged hits between: ${complete.join(" ")}`);

/* --------------------------------------------------------------- refuel */
console.log("\n=== refuel cadence and base stock timer ===");
let last_drain = {}, cadence = {};
for (let e of events) {
	if (e.type === "tank_death") { last_drain = {}; continue; }
	if (e.type !== "base_drain") continue;
	if (last_drain[e.resource] !== undefined && e.t - last_drain[e.resource] <= 100) {
		let h = cadence[e.resource] || (cadence[e.resource] = {});
		h[e.t - last_drain[e.resource]] = (h[e.t - last_drain[e.resource]] || 0) + 1;
	}
	last_drain[e.resource] = e.t;
}
for (let [r, h] of Object.entries(cadence)) console.log(`  ${r}: ` + Object.entries(h).sort((a, b) => a[0] - b[0]).map(([g, n]) => `${g}:${n}`).join(" "));
let ticks = events.filter(e => e.type === "base_stock_tick").map(e => e.t);
let tick_gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
if (tick_gaps.length) console.log(`  base stock ticks: ${ticks.length}, gaps ${Math.min(...tick_gaps)}-${Math.max(...tick_gaps)}, median ${median(tick_gaps)}`);
let respawns = lives.filter(l => l.respawn_gap !== undefined).map(l => l.respawn_gap);
if (respawns.length) console.log(`  respawn gaps: ${respawns.join(" ")}`);
