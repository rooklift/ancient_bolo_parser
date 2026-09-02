#!/usr/bin/env node
/* Which machine simulates a pillbox's shot, and why that one?
 *
 * Pill shells ride in the shell lists of the machine simulating the pill
 * ([E:pill-shell-migration]), and the `F4 nd` naming the fire rides in
 * that machine's record. The reading tested here: every machine checks
 * whether ITS OWN tank is the pill's target, and simulates the shots the
 * pill fires at it. Bolo's pill targets the nearest hostile tank in range,
 * so two things must hold for a fire reported by sender S:
 *
 *   1. S's tank is the nearest hostile tank to the pill, whenever more
 *      than one hostile tank is in range (the contested cases are the
 *      test; a lone tank in range says nothing).
 *   2. The fire's direction nibble points at S's tank, not at anyone
 *      else's.
 *
 * Distances are pixel distances from the pill's centre to each tank's
 * centre, using each player's latest restated position. A rival that
 * beats S by less than a tile or so may simply be a stale position, so
 * the losses are bucketed by margin. Hostile means the pill is neutral,
 * or its owner is not allied with the tank's player. The parity rule for
 * direction-0 fires ([E:pill-fire-index]) resolves the named pill.
 *
 * Usage: node tools/measure-pill-target.cjs [file | directory]
 * With no argument the corpus root from corpus.json / BOLO_CORPUS is read.
 */
const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const ROOT = args[0] || require("./corpus.cjs").corpus_root();
const NEUTRAL = 16;
const RANGE_PX = 136;       /* 8.5 tiles: a pill shell's full flight */
const ALIVE_TICKS = 250;    /* a tank unheard of for 5 s is not a target */
const MARGIN_BUCKETS = [8, 16, 32, 64];

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

function tank_centre(t) {
	return {x: t.x * 16 + t.px + 8, y: t.y * 16 + t.py + 8};
}

/* 0 = north, clockwise, 16 coarse sectors, round-to-nearest like the
 * direction nibble itself ([E:pill-fire-index]). */
function coarse_bearing(from_x, from_y, to_x, to_y) {
	let angle = Math.atan2(to_x - from_x, -(to_y - from_y));
	let bradian = Math.round(angle * 128 / Math.PI) & 0xff;
	return ((bradian + 8) >> 4) & 15;
}

function sector_gap(a, b) {
	let d = Math.abs(a - b) & 15;
	return Math.min(d, 16 - d);
}

function hostile(state, pill, player) {
	if (pill.owner === NEUTRAL) return true;
	if (pill.owner === player) return false;
	return (state.alliances[pill.owner] & (1 << player)) !== 0;
}

const totals = {
	logs: 0, fires: 0, resolved_to_lower: 0, pair_ambiguous: 0,
	pill_unresolved: 0, pill_dead: 0,
	sender_no_tank: 0, sender_not_hostile: 0, sender_out_of_range: 0,
	lone: 0, contested: 0, sender_nearest: 0,
	lost_by_bucket: MARGIN_BUCKETS.map(() => 0).concat([0]),
	lost_to_hidden: 0, lost_to_staler: 0,
	random_expectation: 0,
	aim_at_sender: 0, aim_at_sender_pm1: 0, aim_at_rival: 0, aim_neither: 0,
	aim_cases: 0,
};

function scan(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		return;
	}
	if (!recs.length) return;
	totals.logs++;
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs));

	for (let rec of recs) {
		for (let sub of rec.subpackets) {
			if (sub.type !== "pillbox_fires") continue;
			totals.fires++;
			let sender = rec.player;

			let tanks = [];
			for (let i = 0; i < 16; i++) {
				let t = state.tanks[i];
				if (!t || state.quit[i] || t.dead || t.dying) continue;
				if (rec.time - t.lastSeen > ALIVE_TICKS) continue;
				let c = tank_centre(t);
				tanks.push({player: i, x: c.x, y: c.y, hidden: !!t.hidden,
					position_time: t.position_time});
			}
			let me = tanks.find(t => t.player === sender);

			/* Which pill fired. An odd index at direction 0 may be one too
			 * high ([E:pill-fire-index]); the firer must be grounded, hostile
			 * to the sender and within a shell's flight of the sender's tank,
			 * which almost always singles out one of the pair. */
			let pill = state.pills[sub.pillbox];
			if (sub.direction === 0 && (sub.pillbox & 1)) {
				let lower = state.pills[sub.pillbox - 1];
				let fits = p => p && p.inTank === null && me && hostile(state, p, sender) &&
					Math.hypot(p.x * 16 + 8 - me.x, p.y * 16 + 8 - me.y) <= RANGE_PX;
				let named_fits = fits(pill), lower_fits = fits(lower);
				if (lower_fits && !named_fits) {
					pill = lower;
					totals.resolved_to_lower++;
				} else if (lower_fits && named_fits) {
					totals.pair_ambiguous++;
				} else if (!pill || pill.inTank !== null) {
					if (lower && lower.inTank === null) pill = lower;
				}
			}
			if (!pill || pill.inTank !== null) {
				totals.pill_unresolved++;
				continue;
			}
			if (pill.armour === 0) {
				totals.pill_dead++;
				continue;
			}
			let pill_x = pill.x * 16 + 8;
			let pill_y = pill.y * 16 + 8;
			for (let t of tanks) {
				t.distance = Math.hypot(t.x - pill_x, t.y - pill_y);
				t.hostile = hostile(state, pill, t.player);
			}
			if (!me) {
				totals.sender_no_tank++;
				continue;
			}
			if (!me.hostile) {
				totals.sender_not_hostile++;
				continue;
			}
			if (me.distance > RANGE_PX) {
				totals.sender_out_of_range++;
				continue;
			}
			let rivals = tanks.filter(t => t.hostile && t.player !== sender &&
				t.distance <= RANGE_PX);
			if (!rivals.length) {
				totals.lone++;
				continue;
			}
			totals.contested++;
			totals.random_expectation += 1 / (rivals.length + 1);
			let nearest_rival = rivals.reduce((a, b) => a.distance < b.distance ? a : b);
			if (me.distance <= nearest_rival.distance) {
				totals.sender_nearest++;
			} else {
				let margin = me.distance - nearest_rival.distance;
				let bucket = MARGIN_BUCKETS.findIndex(limit => margin <= limit);
				totals.lost_by_bucket[bucket < 0 ? MARGIN_BUCKETS.length : bucket]++;
				if (nearest_rival.hidden) totals.lost_to_hidden++;
				if (nearest_rival.position_time < me.position_time) totals.lost_to_staler++;
			}

			/* aim: whose tank does the direction nibble point at? */
			let at_me = sector_gap(sub.direction, coarse_bearing(pill_x, pill_y, me.x, me.y));
			let at_rival = sector_gap(sub.direction,
				coarse_bearing(pill_x, pill_y, nearest_rival.x, nearest_rival.y));
			totals.aim_cases++;
			if (at_me === 0) totals.aim_at_sender++;
			else if (at_me === 1 && at_rival > 1) totals.aim_at_sender_pm1++;
			else if (at_rival <= 1 && at_me > 1) totals.aim_at_rival++;
			else totals.aim_neither++;
		}
		BoloGame.apply_record(state, rec, null, null);
	}
}

for (let file of walk(ROOT)) scan(file);

const pc = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
const n = v => v.toLocaleString();
console.log("======================================================================");
console.log(`${totals.logs} logs, ${n(totals.fires)} pill fires`);
console.log();
console.log("Direction-0 odd-index fires resolved to pill n-1 by hostility and range:");
console.log(`    ${n(totals.resolved_to_lower).padStart(9)}   (both pills fit in ${n(totals.pair_ambiguous)}; the named one is kept there)`);
console.log();
console.log("Fires set aside:");
console.log(`    pill unresolved (missing or carried)   ${n(totals.pill_unresolved).padStart(9)}`);
console.log(`    pill dead                              ${n(totals.pill_dead).padStart(9)}`);
console.log(`    sender has no live tank                ${n(totals.sender_no_tank).padStart(9)}`);
console.log(`    sender not hostile to the pill         ${n(totals.sender_not_hostile).padStart(9)}   (must be ~0)`);
console.log(`    sender's tank out of range             ${n(totals.sender_out_of_range).padStart(9)}`);
console.log(`    sender the only hostile tank in range  ${n(totals.lone).padStart(9)}   (uninformative)`);
console.log();
console.log(`Contested fires (two or more hostile tanks in range): ${n(totals.contested)}`);
console.log(`    sender is the nearest hostile tank     ${n(totals.sender_nearest).padStart(9)}   ${pc(totals.sender_nearest, totals.contested)}`);
console.log(`    expected if the simulator were random  ${n(Math.round(totals.random_expectation)).padStart(9)}   ${pc(totals.random_expectation, totals.contested)}`);
console.log("    sender beaten by a nearer hostile tank, by margin:");
let lower = 0;
for (let i = 0; i <= MARGIN_BUCKETS.length; i++) {
	let label = i < MARGIN_BUCKETS.length ? `${lower + 1}-${MARGIN_BUCKETS[i]} px` : `over ${lower} px`;
	console.log(`        ${label.padEnd(12)} ${n(totals.lost_by_bucket[i]).padStart(9)}   ${pc(totals.lost_by_bucket[i], totals.contested)}`);
	if (i < MARGIN_BUCKETS.length) lower = MARGIN_BUCKETS[i];
}
let lost = totals.contested - totals.sender_nearest;
console.log(`        of the ${n(lost)} losses, the nearer tank was hidden in forest in ${n(totals.lost_to_hidden)}, and`);
console.log(`        restated less recently than the sender's in ${n(totals.lost_to_staler)}`);
console.log();
console.log(`Aim, on the same contested fires (${n(totals.aim_cases)}): the direction nibble against`);
console.log("the bearing from the pill to each tank, in 16 coarse sectors:");
console.log(`    exactly at the sender's tank           ${n(totals.aim_at_sender).padStart(9)}   ${pc(totals.aim_at_sender, totals.aim_cases)}`);
console.log(`    one sector off the sender, not rival   ${n(totals.aim_at_sender_pm1).padStart(9)}   ${pc(totals.aim_at_sender_pm1, totals.aim_cases)}`);
console.log(`    at the nearest rival, not the sender   ${n(totals.aim_at_rival).padStart(9)}   ${pc(totals.aim_at_rival, totals.aim_cases)}`);
console.log(`    ambiguous or neither                   ${n(totals.aim_neither).padStart(9)}   ${pc(totals.aim_neither, totals.aim_cases)}`);
console.log("======================================================================");
