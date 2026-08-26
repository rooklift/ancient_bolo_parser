#!/usr/bin/env node
/* Measure how much ammo a tank is carrying when it dies, and cross-tabulate
 * that against the terminal-explosion tier.
 *
 * FORMAT.md (F9) asserts the three tiers are "ammo-gated", with the
 * superboom at "roughly shells + mines >= 60 aboard".  That number was
 * never measured: the logs carry no ammo-aboard field, so round 2 (which
 * introduced the tiers) classified deaths purely by which explosion event
 * fired and never looked at ammo at all.  This script reconstructs the
 * missing quantity instead of assuming it.
 *
 * RECONSTRUCTION.  In a strict game (`gametype` 3, 442 of the 446-log
 * corpus) a tank respawns with NO ammo, so a life that begins at an
 * observed respawn has a known origin and can be integrated forwards:
 *
 *   +1 shell   per `Bn`  (base drained of 1 shell)
 *   +1 mine    per `Cn`  (base drained of 1 mine)
 *   -1 shell   per `5d`  (shot fired from tank)
 *   -1 mine    per `F7`  (tank lays mine)
 *
 * The first life seen for each player is discarded: the log starts
 * mid-game, so its ammo at that point is unknown.
 *
 * SELF-VALIDATION.  Brain.h gives the caps exactly -- `BYTE shells; //
 * Range 0-40` and `BYTE mines; // Range 0-40` -- so the reconstruction is
 * bracketed on both sides and convicts itself before it is allowed to say
 * anything about tiers:
 *
 *   a count going NEGATIVE  => we are missing a source of ammo (or
 *                              mis-attributing a spend);
 *   a count exceeding 40    => we are missing a spend (or drains fire at
 *                              a full tank and are silently discarded).
 *
 * Lives that violate either bound are excluded from the tier tables and
 * reported separately.  If violations are rife the whole measurement is
 * void, and the printed rates say so; only a reconstruction that mostly
 * stays inside [0, 40] across thousands of lives earns the tier answer.
 *
 * TWO MODELS, because one spend is uncertain.  A `7C` explosion is an LGM
 * planting a mine, which plausibly draws from the tank's stock, but that
 * is not documented anywhere we can check.  Both readings run side by
 * side and the bracket adjudicates: whichever keeps more lives inside
 * [0, 40] is the true rule.
 *
 *   tank_only   only `F7` spends mines
 *   with_lgm    `F7` and `7C` both spend mines
 *   clamped     as tank_only, but a drain into a full tank is wasted
 *               rather than counted -- the corpus argues for this: every
 *               violation the unclamped models produce is an OVERFLOW and
 *               not one is a negative, exactly the signature of drains
 *               continuing to be logged at a tank that cannot accept them
 *
 * A negative count would mean a missing source of ammo and would sink the
 * whole method; none occurs, so the only question is where the ceiling is
 * enforced.
 *
 * KNOWN LEAK.  A tank crossing water without a boat loses ammo, with no
 * event.  Lives in which the tank was ever on water un-boated are flagged
 * and reported apart, rather than waved away -- if their violation rate is
 * much worse than the dry lives', the leak is real and the exclusion is
 * doing work.
 *
 * Usage:
 *   node tools/measure-death-ammo.cjs [corpus-dir] [--all-gametypes]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const ALL_GAMETYPES = process.argv.includes("--all-gametypes");
const ROOT = args[0] || "C:/Users/Owner/__DOCS/Bolo Archives/Nemokrad's Bolo logs";

const MAP_SIZE = 256;
const MAX_SHELLS = 40;          /* Brain.h: BYTE shells; // Range 0-40 */
const MAX_MINES = 40;           /* Brain.h: BYTE mines;  // Range 0-40 */
const TIER_DISTANCE = 6;        /* same window as round 2, so tiers match */
const TIER_LOOKBACK_TICKS = 60;
const MODELS = ["tank_only", "with_lgm", "clamped"];

/* terrain codes that are water for the un-boated-leak check */
const WATER = new Set([0, 1, 9, 255]);

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, {withFileTypes: true});
	} catch {
		return;
	}
	for (let entry of entries) {
		let item = path.join(dir, entry.name);
		if (entry.isDirectory())
			yield* walk(item);
		else if (entry.isFile())
			yield item;
	}
}

function footprint_squares(sub) {
	let wx = sub.x * 16 + sub.pixelX;
	let wy = sub.y * 16 + sub.pixelY;
	let squares = [];
	for (let x of new Set([wx >> 4, (wx + 15) >> 4]))
		for (let y of new Set([wy >> 4, (wy + 15) >> 4]))
			squares.push([x, y]);
	return squares;
}

function centre_square(sub) {
	return [(sub.x * 16 + sub.pixelX + 8) >> 4, (sub.y * 16 + sub.pixelY + 8) >> 4];
}

/* ------------------------------------------------------------------ */
/* Pass 1: every death, with its terminal-explosion tier.  Deliberately
 * the same rule as falsify-death-footprint-2.cjs so the tiers here are
 * the tiers that script reported. */

function find_deaths(records) {
	let deaths = [];
	let by_key = new Map();
	let active = Array.from({length: 16}, () => null);
	let in_sequence = Array.from({length: 16}, () => false);
	let recent_booms = [];

	const near = (death, x, y) =>
		death.fp.some(([fx, fy]) => Math.max(Math.abs(fx - x), Math.abs(fy - y)) <= TIER_DISTANCE);

	for (let i = 0; i < records.length; i++) {
		let record = records[i];
		for (let sub of record.subpackets) {
			if (sub.type === "tank_position") {
				if (sub.dying) {
					if (!in_sequence[record.player]) {
						let death = {
							index: i,
							time: record.time,
							player: record.player,
							fp: footprint_squares(sub),
							tier: "none",
							code: 0,
						};
						for (let boom of recent_booms) {
							if (boom.player === record.player &&
									record.time - boom.time <= TIER_LOOKBACK_TICKS &&
									near(death, boom.x, boom.y))
								death.tier = boom.code === 0x0d ? "superboom" : "crater";
						}
						deaths.push(death);
						by_key.set(`${i}:${record.player}`, death);
						active[record.player] = death;
						in_sequence[record.player] = true;
					}
				} else {
					in_sequence[record.player] = false;
					active[record.player] = null;
				}
			} else if (sub.type === "tank_death") {
				if (active[record.player] && !active[record.player].code)
					active[record.player].code = sub.code;
			} else if (sub.type === "explosion" && (sub.code === 3 || sub.code === 0x0d)) {
				recent_booms.push({time: record.time, player: record.player, x: sub.x, y: sub.y, code: sub.code});
				if (recent_booms.length > 64)
					recent_booms.shift();
				let death = active[record.player];
				if (death && near(death, sub.x, sub.y)) {
					if (sub.code === 0x0d)
						death.tier = "superboom";
					else if (death.tier === "none")
						death.tier = "crater";
				}
			}
		}
	}
	return {deaths, by_key};
}

/* ------------------------------------------------------------------ */
/* Pass 2: integrate ammo forwards from each observed respawn. */

function new_life() {
	return {
		valid: false,          /* began at an observed respawn */
		shells: 0,
		mines: 0,
		lgm_mines: 0,          /* 7C plants, charged only in the with_lgm model */
		c_shells: 0,           /* clamped model: a drain into a full tank is lost */
		c_mines: 0,
		wet: false,            /* ever on water without a boat */
		broke: {tank_only: null, with_lgm: null, clamped: null},
	};
}

function shell_count(life, model) {
	return model === "clamped" ? life.c_shells : life.shells;
}

function mine_count(life, model) {
	if (model === "with_lgm") return life.mines - life.lgm_mines;
	if (model === "clamped") return life.c_mines;
	return life.mines;
}

function check_bounds(life) {
	for (let model of MODELS) {
		if (life.broke[model])
			continue;
		let sh = shell_count(life, model);
		let m = mine_count(life, model);
		if (sh < 0) life.broke[model] = "shells<0";
		else if (sh > MAX_SHELLS) life.broke[model] = "shells>40";
		else if (m < 0) life.broke[model] = "mines<0";
		else if (m > MAX_MINES) life.broke[model] = "mines>40";
	}
}

const stats = {
	files: 0, skipped_gametype: 0,
	lives_started: 0, lives_discarded_unknown_start: 0,
	deaths_seen: 0, deaths_sunk: 0, deaths_unknown_start: 0,
	violations: {}, wet_lives: 0, wet_violations: {},
	samples: {},           /* model -> tier -> [combined ammo] */
	shell_samples: {},     /* model -> tier -> [shells] */
	mine_samples: {},      /* model -> tier -> [mines] */
	dry_used: {},
};
for (let model of MODELS) {
	stats.violations[model] = {};
	stats.wet_violations[model] = {};
	stats.samples[model] = {};
	stats.shell_samples[model] = {};
	stats.mine_samples[model] = {};
	stats.dry_used[model] = 0;
}

function bump(obj, key) {
	obj[key] = (obj[key] || 0) + 1;
}

function scan(file) {
	let buf;
	try {
		buf = new Uint8Array(fs.readFileSync(file));
	} catch {
		return;
	}
	if (buf.length < 72 || buf[0] !== 0x42 || buf[1] !== 0x6f || buf[2] !== 0x6c || buf[3] !== 0x6f)
		return;

	let records;
	try {
		records = [...BoloLog.records(buf)];
	} catch {
		return;
	}

	if (!ALL_GAMETYPES) {
		let info = null;
		for (let i = 0; i < Math.min(records.length, 300) && !info; i++)
			info = records[i].subpackets.find(s => s.type === "game_info") || null;
		if (!info || info.gameType !== 3) {
			stats.skipped_gametype++;
			return;
		}
	}
	stats.files++;

	let {by_key} = find_deaths(records);
	let engine;
	try {
		engine = BoloGame.initial_state(BoloGame.extract_initial_map(records));
	} catch {
		return;
	}

	let lives = Array.from({length: 16}, () => new_life());
	let in_sequence = Array.from({length: 16}, () => false);

	for (let i = 0; i < records.length; i++) {
		let record = records[i];
		let pl = record.player;
		let life = lives[pl];

		for (let sub of record.subpackets) {
			switch (sub.type) {
			case "base_drain":
				if (sub.resource === "shells") {
					life.shells++;
					life.c_shells = Math.min(MAX_SHELLS, life.c_shells + 1);
				} else if (sub.resource === "mines") {
					life.mines++;
					life.c_mines = Math.min(MAX_MINES, life.c_mines + 1);
				}
				check_bounds(life);
				break;
			case "shot_fired":
				life.shells--;
				life.c_shells--;
				check_bounds(life);
				break;
			case "lay_mine":
				life.mines--;
				life.c_mines--;
				check_bounds(life);
				break;
			case "explosion":
				if (sub.code === 0x0c) {
					life.lgm_mines++;
					check_bounds(life);
				}
				break;
			case "tank_position":
				if (sub.dying) {
					if (!in_sequence[pl]) {
						in_sequence[pl] = true;
						stats.deaths_seen++;
						let death = by_key.get(`${i}:${pl}`);
						record_death(life, death);
					}
				} else {
					if (in_sequence[pl]) {
						/* respawn: strict games start empty, so from here
						 * on the count has a known origin */
						lives[pl] = new_life();
						lives[pl].valid = true;
						life = lives[pl];
						stats.lives_started++;
					} else if (!life.valid) {
						/* still the pre-respawn life of unknown ammo */
					}
					in_sequence[pl] = false;
					/* un-boated water crossing leaks ammo with no event */
					if (!sub.inBoat) {
						let [cx, cy] = centre_square(sub);
						if (cx >= 0 && cy >= 0 && cx < MAP_SIZE && cy < MAP_SIZE &&
								WATER.has(engine.grid[cy * MAP_SIZE + cx]))
							life.wet = true;
					}
				}
				break;
			}
		}

		try {
			BoloGame.apply_record(engine, record, null, null);
		} catch {
			return;
		}
	}
}

function record_death(life, death) {
	if (!death) return;
	if (death.code === 3) {            /* sunk in deep sea */
		stats.deaths_sunk++;
		return;
	}
	if (!life.valid) {
		stats.deaths_unknown_start++;
		stats.lives_discarded_unknown_start++;
		return;
	}
	if (life.wet) stats.wet_lives++;

	for (let model of MODELS) {
		let bucket = life.wet ? stats.wet_violations[model] : stats.violations[model];
		if (life.broke[model]) {
			bump(bucket, life.broke[model]);
			continue;
		}
		bump(bucket, "ok");
		if (life.wet) continue;        /* dry lives only in the tier tables */
		let shells = shell_count(life, model);
		let mines = mine_count(life, model);
		let tier = death.tier;
		(stats.samples[model][tier] = stats.samples[model][tier] || []).push(shells + mines);
		(stats.shell_samples[model][tier] = stats.shell_samples[model][tier] || []).push(shells);
		(stats.mine_samples[model][tier] = stats.mine_samples[model][tier] || []).push(mines);
		stats.dry_used[model]++;
	}
}

/* ------------------------------------------------------------------ */

function quantile(sorted, q) {
	if (!sorted.length) return NaN;
	let idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
	return sorted[idx];
}

function describe(values) {
	if (!values.length) return "         (none)";
	let s = [...values].sort((a, b) => a - b);
	let mean = s.reduce((a, b) => a + b, 0) / s.length;
	return `n=${String(s.length).padStart(5)}  min=${String(s[0]).padStart(3)}` +
		`  p25=${String(quantile(s, 0.25)).padStart(3)}` +
		`  med=${String(quantile(s, 0.5)).padStart(3)}` +
		`  p75=${String(quantile(s, 0.75)).padStart(3)}` +
		`  max=${String(s[s.length - 1]).padStart(3)}  mean=${mean.toFixed(1)}`;
}

let seen = 0;
for (let file of walk(ROOT)) {
	scan(file);
	if (++seen % 100 === 0)
		console.error(`  ...${seen} files`);
}

const TIERS = ["none", "crater", "superboom"];

console.log(`
==================== death ammo vs explosion tier ====================
corpus: ${ROOT}
logs used: ${stats.files}${ALL_GAMETYPES ? " (all game types)" : ` (strict only; ${stats.skipped_gametype} skipped)`}
lives beginning at an observed respawn: ${stats.lives_started}
deaths seen: ${stats.deaths_seen}  (sunk, excluded: ${stats.deaths_sunk};
  in a life of unknown starting ammo, excluded: ${stats.deaths_unknown_start})
deaths in lives flagged wet (un-boated water, ammo leaks eventlessly): ${stats.wet_lives}
`);

console.log("--- reconstruction health (Brain.h caps: shells 0-40, mines 0-40) ---");
console.log("the bracket convicts the model before it may speak about tiers.\n");
for (let model of MODELS) {
	let dry = stats.violations[model];
	let wet = stats.wet_violations[model];
	const total = o => Object.values(o).reduce((a, b) => a + b, 0);
	const rate = o => {
		let t = total(o);
		return t ? `${(100 * (t - (o.ok || 0)) / t).toFixed(1)}%` : "n/a";
	};
	console.log(`  ${model.padEnd(10)} dry lives: ${JSON.stringify(dry)}`);
	console.log(`  ${" ".repeat(10)}   violation rate ${rate(dry)} of ${total(dry)}`);
	console.log(`  ${" ".repeat(10)} wet lives: ${JSON.stringify(wet)}`);
	console.log(`  ${" ".repeat(10)}   violation rate ${rate(wet)} of ${total(wet)}\n`);
}

for (let model of MODELS) {
	console.log(`--- ammo at death, model "${model}" (dry, in-bounds lives only) ---`);
	for (let label of [["shells + mines", stats.samples], ["shells", stats.shell_samples], ["mines", stats.mine_samples]]) {
		console.log(`  ${label[0]}:`);
		for (let tier of TIERS)
			console.log(`    ${tier.padEnd(10)} ${describe(label[1][model][tier] || [])}`);
	}
	console.log();
}

console.log("--- the discriminator: tier mix per combined-ammo band ---");
console.log("a clean ammo gate shows tiers segregating into bands; a smear means");
console.log("ammo is not what selects the tier.\n");
for (let model of MODELS) {
	console.log(`  model "${model}"`);
	console.log(`    ${"band".padEnd(10)} ${"n".padStart(6)}  none   crater  superboom`);
	let bands = [];
	for (let lo = 0; lo < 80; lo += 10) bands.push([lo, lo + 9]);
	for (let [lo, hi] of bands) {
		let counts = {none: 0, crater: 0, superboom: 0};
		for (let tier of TIERS)
			for (let v of stats.samples[model][tier] || [])
				if (v >= lo && v <= hi) counts[tier]++;
		let n = counts.none + counts.crater + counts.superboom;
		if (!n) continue;
		const pct = c => `${(100 * c / n).toFixed(0)}%`.padStart(5);
		console.log(`    ${`${lo}-${hi}`.padEnd(10)} ${String(n).padStart(6)}  ${pct(counts.none)}  ${pct(counts.crater)}  ${pct(counts.superboom)}`);
	}
	console.log();
}
console.log("--- boundaries, per single unit of combined ammo ---");
console.log("model \"clamped\"; the crater boundary at the bottom, the superboom");
console.log("boundary at the top. A gate shows a step, not a ramp.");
console.log();
{
	let model = "clamped";
	const row = (lo, hi) => {
		let counts = {none: 0, crater: 0, superboom: 0};
		for (let tier of TIERS)
			for (let v of stats.samples[model][tier] || [])
				if (v >= lo && v <= hi) counts[tier]++;
		let n = counts.none + counts.crater + counts.superboom;
		if (!n) return;
		const pct = c => `${(100 * c / n).toFixed(0)}%`.padStart(5);
		console.log(`    ${(lo === hi ? String(lo) : `${lo}-${hi}`).padEnd(8)} ${String(n).padStart(6)}  ${pct(counts.none)}  ${pct(counts.crater)}  ${pct(counts.superboom)}`);
	};
	console.log(`    ${"ammo".padEnd(8)} ${"n".padStart(6)}  none   crater  superboom`);
	console.log("    -- bottom end --");
	for (let v = 0; v <= 14; v++) row(v, v);
	console.log("    -- superboom boundary --");
	for (let v = 55; v <= 70; v++) row(v, v);
	console.log();
}
console.log("======================================================================");
