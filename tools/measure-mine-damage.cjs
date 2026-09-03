#!/usr/bin/env node
/* How much armour does a mine take off a tank?
 *
 * The log has no tank-armour field and no "mine hit tank" event. What it has
 * is enough to bracket the number:
 *
 *   - a tank holds 9 armour, loses 1 per `FC` hit and regains 1 per `Dn`
 *     armour drain, capped at 9 (GAMEPLAY.md, [E:gameplay]); a life that
 *     begins at an observed respawn can be integrated forwards, as the
 *     ammo and armour measurements already do;
 *   - a mine going off under a tank is a `7T` explosion on a square the
 *     model holds MINED, with a tank's centre on that square.
 *
 * Then every detonation the tank SURVIVED says the damage was less than the
 * armour it had (an upper bound), every detonation that KILLED it says the
 * damage was at least the armour it had (a lower bound), and a sweep over
 * candidate values counts, for each, how many shell-and-mine deaths land at
 * exactly 0 and how many survived detonations would have been fatal.
 *
 * A detonation is credited to a tank when the explosion square is the
 * centre square of the tank's latest restatement, no more than a second
 * old, and the explosion code is not `C` (the man planting) or `D` (a
 * superboom). A shell can also set a mine off; with the tank standing on
 * the square the damage is the same question, so no attempt is made to
 * separate them. A tank killed by the detonation is one whose `F9` follows
 * within a second.
 *
 * The first life seen for each player is discarded (unknown start), and
 * a life whose integrated armour goes below 0 before its death or above
 * 9 is flagged rather than trusted: hits logged twice by two senders
 * ([E:gameplay]) are the known cause, and such lives are excluded from the
 * sweep.
 *
 * Usage: node tools/measure-mine-damage.cjs [file | directory ...]
 * With no argument the corpus root from corpus.json / BOLO_CORPUS is read.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const {corpus_root, replay_label} = require("./corpus.cjs");

const MAX_ARMOUR = 9;
const TICKS_PER_SECOND = 50;
const CANDIDATES = [1, 2, 3, 4, 5, 6];

/* accumulators over every log */
let detonation_codes = new Map();      /* explosion code -> count, for mined squares */
let detonations = 0, under_tank = 0, fatal = 0, survived = 0;
let survived_armour_before = [];        /* integrated armour when a survived detonation went off */
let fatal_armour_before = [];           /* the same for detonations followed by a death */
let sweep = CANDIDATES.map(d => ({ d, deaths_exact: 0, deaths_below: 0, deaths_above: 0, survived_violations: 0 }));
let lives_with_mines = 0, lives_excluded = 0, lives_total = 0;
/* the focused test: what a single mine took, read off the rest of the life.
 * A tank that drove on from its one mine at integrated armour A and later
 * fell to shells after k more hits and d more drains lost A + d - k to the
 * mine. Keyed by A; the working theory says 3 for A >= 5 and A - 1 for
 * A of 3 or 4 (left at 1). */
let implied_loss = new Map();
/* clean losses: one mine in the life's last second, no shell hit within
 * 2 s of it, no other mined-square explosion within 2 squares in the
 * previous 2 s. The theory says every one of these is at armour <= 2. */
let clean_loss_armour = [];
let clean_loss_examples = [];
let recent_mine_explosions = [];   /* {time, x, y} for the nearby-mine check */
let examples = [];
let logs_scanned = 0, records_scanned = 0;

function group_push(map, key, value) {
	if (!map.has(key)) map.set(key, []);
	map.get(key).push(value);
}

function histogram_line(values, lo, hi) {
	let counts = new Map();
	for (let v of values) {
		if (v < lo || v > hi) continue;
		counts.set(v, (counts.get(v) || 0) + 1);
	}
	return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join(" ") || "-";
}

function scan(file, recs) {
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));
	let label = replay_label(file);
	let t0 = recs[0].time;

	/* per player: latest tank position (centre square) and the current life */
	let last_tank = new Array(16).fill(null);   /* {sx, sy, time, dying} */
	let life = new Array(16).fill(null);        /* {events: [{kind, time}], first} */
	let seen_death = new Array(16).fill(false);

	let finish_life = (pl, code, time) => {
		let l = life[pl];
		life[pl] = null;
		if (!l) return;
		lives_total++;
		if (l.first) return;
		let mines = l.events.filter(e => e.kind === "mine");
		if (!mines.length) return;
		lives_with_mines++;
		/* integrate under each candidate; also check the shells-only integration for double hits */
		let armour_shells_only = MAX_ARMOUR;
		let bad = false;
		for (let e of l.events) {
			if (e.kind === "hit") armour_shells_only--;
			else if (e.kind === "drain") armour_shells_only = Math.min(MAX_ARMOUR, armour_shells_only + 1);
			if (armour_shells_only < 0) bad = true;
		}
		if (bad) { lives_excluded++; return; }
		if (mines.length === 1 && code !== 3) {
			let m = mines[0];
			let idx = l.events.indexOf(m);
			let before = MAX_ARMOUR;
			for (let e of l.events.slice(0, idx)) {
				if (e.kind === "hit") before--;
				else if (e.kind === "drain") before = Math.min(MAX_ARMOUR, before + 1);
			}
			let after = l.events.slice(idx + 1);
			let hits_after = after.filter(e => e.kind === "hit").length;
			let drains_after = after.filter(e => e.kind === "drain").length;
			let hit_near = l.events.some(e => e.kind === "hit" && Math.abs(e.time - m.time) <= 2 * TICKS_PER_SECOND);
			if (!m.fatal && hits_after > 0) {
				/* the drains after the mine may have been capped at 9; only trust lives whose armour never
				 * approached the cap, i.e. before - loss + drains stays below 9 for every candidate loss >= 1 */
				if (before - 1 + drains_after <= MAX_ARMOUR) {
					let loss = before + drains_after - hits_after;
					group_push(implied_loss, before, loss);
				}
			}
			if (m.fatal && !hit_near && !m.nearby_other) {
				clean_loss_armour.push(before);
				if (before >= 3 && clean_loss_examples.length < 10) clean_loss_examples.push(`${label} t=${((time - t0) / 50).toFixed(1)}s player ${pl}: armour ${before}, ${l.events.filter(e => e.kind === "hit").length} hits and ${l.events.filter(e => e.kind === "drain").length} drains in the life, lost ${((time - m.time) / 50).toFixed(2)}s after the hit`);
			}
		}
		for (let s of sweep) {
			let a = MAX_ARMOUR;
			let violated = false;
			for (let i = 0; i < l.events.length; i++) {
				let e = l.events[i];
				if (e.kind === "hit") a--;
				else if (e.kind === "drain") a = Math.min(MAX_ARMOUR, a + 1);
				else if (e.kind === "mine") {
					a -= s.d;
					/* a detonation that was survived (not within a second of the death) must leave armour */
					if (!e.fatal && a <= 0) violated = true;
				}
			}
			if (violated) s.survived_violations++;
			if (code !== 3) {
				if (a === 0) s.deaths_exact++;
				else if (a < 0) s.deaths_below++;
				else s.deaths_above++;
			}
		}
	};

	for (let rec of recs) {
		let pl = rec.player;
		let tank_sub = rec.subpackets.find(s => s.type === "tank_position");
		if (tank_sub) {
			let cx = tank_sub.x * 16 + tank_sub.pixelX + 8, cy = tank_sub.y * 16 + tank_sub.pixelY + 8;
			last_tank[pl] = { sx: cx >> 4, sy: cy >> 4, time: rec.time, dying: tank_sub.dying };
			if (!tank_sub.dying && life[pl] === null) {
				life[pl] = { events: [], first: !seen_death[pl], start: rec.time };
			}
		}
		for (let sub of rec.subpackets) {
			switch (sub.type) {
				case "tank_hit":
					if (life[sub.tank]) life[sub.tank].events.push({ kind: "hit", time: rec.time });
					break;
				case "base_drain":
					if (sub.resource === "armor" && life[pl]) life[pl].events.push({ kind: "drain", time: rec.time });
					break;
				case "explosion": {
					let before = state.grid[sub.y * 256 + sub.x];
					let mined = before >= 10 && before <= 15;
					if (!mined || sub.code === 0x0c || sub.code === 0x0d) break;
					detonations++;
					detonation_codes.set(sub.code, (detonation_codes.get(sub.code) || 0) + 1);
					let nearby_other = recent_mine_explosions.some(e => rec.time - e.time <= 2 * TICKS_PER_SECOND && e.time <= rec.time && Math.abs(e.x - sub.x) <= 2 && Math.abs(e.y - sub.y) <= 2 && (e.x !== sub.x || e.y !== sub.y));
					recent_mine_explosions.push({ time: rec.time, x: sub.x, y: sub.y });
					if (recent_mine_explosions.length > 64) recent_mine_explosions.shift();
					for (let i = 0; i < 16; i++) {
						let t = last_tank[i];
						if (!t || t.dying || rec.time - t.time > TICKS_PER_SECOND) continue;
						if (t.sx !== sub.x || t.sy !== sub.y) continue;
						under_tank++;
						if (life[i]) {
							let e = { kind: "mine", time: rec.time, fatal: false, sender: pl, tank: i, nearby_other };
							life[i].events.push(e);
						}
					}
					break;
				}
				case "tank_death": {
					let l = life[pl];
					if (l) {
						/* a detonation within the last second killed this tank */
						let armour = MAX_ARMOUR;
						for (let e of l.events) {
							if (e.kind === "hit") armour--;
							else if (e.kind === "drain") armour = Math.min(MAX_ARMOUR, armour + 1);
							else if (e.kind === "mine") {
								if (rec.time - e.time <= TICKS_PER_SECOND) {
									e.fatal = true;
									fatal++;
									if (!l.first) fatal_armour_before.push(armour);
									if (examples.length < 12 && !l.first) examples.push(`${label} t=${((rec.time - t0) / 50).toFixed(1)}s player ${pl}: mine at armour ${armour}, death code ${sub.code} ${((rec.time - e.time) / 50).toFixed(2)}s later`);
								} else {
									survived++;
									if (!l.first) survived_armour_before.push(armour);
								}
								e.armour_before = armour;
							}
						}
					}
					seen_death[pl] = true;
					finish_life(pl, sub.code, rec.time);
					break;
				}
			}
		}
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
	}
	/* lives still open at the end: their detonations were all survived */
	for (let i = 0; i < 16; i++) {
		let l = life[i];
		if (!l || l.first) continue;
		let armour = MAX_ARMOUR;
		for (let e of l.events) {
			if (e.kind === "hit") armour--;
			else if (e.kind === "drain") armour = Math.min(MAX_ARMOUR, armour + 1);
			else if (e.kind === "mine") { survived++; survived_armour_before.push(armour); }
		}
	}
	logs_scanned++;
	records_scanned += recs.length;
	console.log(`${label}: ${recs.length} records`);
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

console.log(`\n${logs_scanned} log${logs_scanned === 1 ? "" : "s"}, ${records_scanned} records`);
console.log(`\n[mine hits] explosions on a square the model holds mined (codes C and D excluded): ${detonations}`);
console.log(`  by explosion code (new terrain nibble): ${[...detonation_codes.entries()].sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k.toString(16)}:${n}`).join(" ")}`);
console.log(`  with a tank centred on the square (latest restatement <= 1 s old): ${under_tank}; tank lost within 1 s: ${fatal}; tank kept going: ${survived}`);
console.log(`\n[bounds] integrated armour (9, -1 per hit, +1 per drain) at the moment of the detonation, first lives excluded`);
console.log(`  tank kept going, armour before:  ${histogram_line(survived_armour_before, -5, 9)}  (the loss is LESS than every one of these)`);
console.log(`  tank lost, armour before:        ${histogram_line(fatal_armour_before, -5, 9)}  (the loss is AT LEAST every one of these)`);
console.log(`\n[sweep] lives with a mine hit: ${lives_with_mines} (of ${lives_total} lives; ${lives_excluded} excluded for shell hits alone driving armour below 0)`);
console.log(`  ${"damage".padEnd(8)} ${"deaths at 0".padStart(12)} ${"below 0".padStart(9)} ${"above 0".padStart(9)} ${"kept-going-but-lost".padStart(20)}`);
for (let s of sweep) {
	console.log(`  ${String(s.d).padEnd(8)} ${String(s.deaths_exact).padStart(12)} ${String(s.deaths_below).padStart(9)} ${String(s.deaths_above).padStart(9)} ${String(s.survived_violations).padStart(20)}`);
}
console.log(`  (deaths exclude drownings, code 3; "kept-going-but-lost" counts lives where a hit the tank drove on from would have taken it to 0 or below under that loss)`);
console.log(`\n[implied loss] single-mine lives that drove on and later fell to shells: loss = armour before + drains after - hits after, by armour before`);
console.log(`  theory: 3 wherever armour before >= 5; armour before - 1 at 3 and 4 (the tank left at 1)`);
for (let [a, v] of [...implied_loss.entries()].sort((x, y) => x[0] - y[0])) {
	console.log(`  armour ${a}: n ${String(v.length).padStart(4)}  loss ${histogram_line(v, -9, 9)}`);
}
console.log(`\n[clean losses] one mine, no shell hit within 2 s, no other mined-square explosion within 2 squares in the prior 2 s: armour before ${histogram_line(clean_loss_armour, 0, 9)}`);
console.log(`  theory: all at 2 or below`);
for (let e of clean_loss_examples) console.log(`  above 2: ${e}`);
if (examples.length) {
	console.log("\n[examples] tanks lost to a mine hit");
	for (let e of examples) console.log(`  ${e}`);
}
