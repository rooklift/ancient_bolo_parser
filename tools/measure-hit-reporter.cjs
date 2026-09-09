#!/usr/bin/env node
/* Who sends the `FC dn` tank-hit packet: the tank's owner, or the machine
 * simulating the shell?  [E:hit-reporter]
 *
 * For every FC the sender is classed against the victim, and the shell is
 * looked for in the previous record of every machine: a shell heading `d`
 * within 48 px of the victim's last position names its simulator.  A hit
 * with no listed shell is put down to a point-blank shot when the sender
 * fired `d` (5d), or a pill fired `d` at the sender (F4), inside 20 ticks.
 * Cross-player hits are further split by the sender's last 150 ticks: a
 * tank shot in direction d, a pill fire in direction d at the sender (the
 * sender simulates that pill's shells, so this is a pill shell hitting a
 * tank other than its target), both, or neither.
 *
 * Same-victim same-direction hits from two senders within 2 ticks are the
 * only candidates for one hit logged twice; the victim's armour is replayed
 * over each such life (9 at spawn, -1 per FC, +1 per armour drain capped at
 * 9) and a life ending at exactly 0 means both hits were real.
 *
 * Usage: node tools/measure-hit-reporter.cjs [log-or-directory ...]
 * Defaults to the committed fixtures.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const bolo_log = require(path.join(__dirname, "..", "viewer", "logparse.js"));

const ROOT = path.join(__dirname, "..");
const SKIPPED = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const NEAR = 48, POINT_BLANK = 20, RECENT = 150, PAIR_TICKS = 2;

function* walk(item) {
	let stat;
	try { stat = fs.statSync(item); } catch { return; }
	if (stat.isFile()) { if (!SKIPPED.test(item)) yield item; return; }
	for (let entry of fs.readdirSync(item).sort()) yield* walk(path.join(item, entry));
}

function px(sub) {
	if (sub.pixel !== undefined) return { x: sub.x * 16 + (sub.pixel & 15), y: sub.y * 16 + (sub.pixel >> 4) };
	return { x: sub.x * 16 + sub.pixelX, y: sub.y * 16 + sub.pixelY };
}

function shells_of(rec) {
	let out = [];
	for (let sub of rec.subpackets) {
		if (sub.type !== "shells") continue;
		let cx = 0, cy = 0;
		sub.shells.forEach((s, i) => {
			if (i === 0) ({ x: cx, y: cy } = px(s));
			else { cx += s.offsetX; cy += s.offsetY; }
			out.push({ d: sub.direction, x: cx, y: cy });
		});
	}
	return out;
}

let sector_apart = (a, b) => Math.min((a - b + 16) % 16, (b - a + 16) % 16);

let T = {
	files: 0, hits: 0,
	self: 0, self_shell_in_own_lists: 0, self_point_blank_pill: 0, self_shell_in_own_lists_sector_off: 0, self_shell_in_other_lists: 0, self_unexplained: 0,
	other: 0, other_shell_in_sender_lists: 0, other_point_blank_shot: 0, other_shell_in_sender_lists_sector_off: 0, other_shell_in_victim_lists: 0, other_shell_in_third_lists: 0, other_unexplained: 0,
	other_tank_only: 0, other_pill_only: 0, other_both: 0, other_neither: 0, other_neither_one_sector_off: 0,
	pill_only_victim_also_reported: 0,
	two_sender_pairs: 0, pair_lives: 0, pair_life_armour_at_death: {},
};

function scan(file) {
	let recs = [...bolo_log.records(new Uint8Array(fs.readFileSync(file)))];
	T.files++;
	let last = {}, last_pos = {}, fires = {}, pill_fires = {}, hits = [];
	for (let rec of recs) {
		let p = rec.player;
		/* a shot or pill fire in the hit's own record counts: a point-blank shell lands before its first restatement */
		for (let sub of rec.subpackets) {
			if (sub.type === "shot_fired") (fires[p] ||= []).push({ time: rec.time, d: sub.direction });
			if (sub.type === "pillbox_fires") (pill_fires[p] ||= []).push({ time: rec.time, d: sub.direction });
		}
		for (let list of [fires, pill_fires]) if (list[p]) list[p] = list[p].filter(f => rec.time - f.time <= RECENT);
		for (let sub of rec.subpackets) {
			if (sub.type !== "tank_hit") continue;
			let v = sub.tank, d = sub.direction, vpos = last_pos[v];
			let near = (q, dd) => last[q] && vpos && shells_of(last[q]).some(s => s.d === dd && Math.abs(s.x - vpos.x) <= NEAR && Math.abs(s.y - vpos.y) <= NEAR);
			let sims = Object.keys(last).map(Number).filter(q => near(q, d));
			/* a shell born on a sector boundary is listed a sector off for life while FC carries the true sector [E:shell-birth-sector] */
			let sector_off = q => near(q, (d + 1) % 16) || near(q, (d + 15) % 16);
			let recent = (list, window) => (list[p] || []).filter(f => rec.time - f.time <= window);
			let shot_d = w => recent(fires, w).some(f => f.d === d), pill_d = w => recent(pill_fires, w).some(f => f.d === d);
			hits.push({ time: rec.time, sender: p, victim: v, d });
			T.hits++;
			if (p === v) {
				T.self++;
				if (sims.includes(v)) T.self_shell_in_own_lists++;
				else if (pill_d(POINT_BLANK)) T.self_point_blank_pill++;
				else if (sector_off(v)) T.self_shell_in_own_lists_sector_off++;
				else if (sims.length) T.self_shell_in_other_lists++;
				else T.self_unexplained++;
				continue;
			}
			T.other++;
			if (sims.includes(p)) T.other_shell_in_sender_lists++;
			else if (shot_d(POINT_BLANK)) T.other_point_blank_shot++;
			else if (sector_off(p)) T.other_shell_in_sender_lists_sector_off++;
			else if (sims.includes(v)) T.other_shell_in_victim_lists++;
			else if (sims.length) T.other_shell_in_third_lists++;
			else T.other_unexplained++;
			let tank = shot_d(RECENT), pill = pill_d(RECENT);
			if (tank && pill) T.other_both++;
			else if (tank) T.other_tank_only++;
			else if (pill) T.other_pill_only++;
			else {
				T.other_neither++;
				if (recent(fires, RECENT).concat(recent(pill_fires, RECENT)).some(f => sector_apart(f.d, d) === 1)) T.other_neither_one_sector_off++;
			}
			if (pill && !tank) {
				let victim_reports = r => r.player === v && r.subpackets.some(s => s.type === "tank_hit" && s.tank === v && s.direction === d);
				let i = recs.indexOf(rec);
				let window = recs.slice(Math.max(0, i - 30), i + 30).filter(r => Math.abs(r.time - rec.time) <= PAIR_TICKS);
				if (window.some(victim_reports)) T.pill_only_victim_also_reported++;
			}
		}
		for (let sub of rec.subpackets) if (sub.type === "tank_position") last_pos[p] = px(sub);
		last[p] = rec;
	}
	/* two-sender coincidences, and the armour replay of the lives that hold them */
	let pair_times = new Map();
	for (let i = 0; i < hits.length; i++) {
		for (let j = i + 1; j < hits.length && hits[j].time - hits[i].time <= PAIR_TICKS; j++) {
			if (hits[j].victim !== hits[i].victim || hits[j].d !== hits[i].d || hits[j].sender === hits[i].sender) continue;
			T.two_sender_pairs++;
			(pair_times.get(hits[i].victim) || pair_times.set(hits[i].victim, []).get(hits[i].victim)).push(hits[i].time);
		}
	}
	let life = {};
	for (let rec of recs) {
		let p = rec.player;
		for (let sub of rec.subpackets) {
			if (sub.type === "tank_hit") { let L = life[sub.tank] ||= { armour: 9, start: -Infinity, first: true }; L.armour--; }
			if (sub.type === "base_drain" && sub.resource === "armor") { let L = life[p] ||= { armour: 9, start: -Infinity, first: true }; if (L.armour < 9) L.armour++; }
			if (sub.type === "tank_death") {
				let L = life[p] ||= { armour: 9, start: -Infinity, first: true };
				if (!L.first && sub.code === 1 && (pair_times.get(p) || []).some(t => t > L.start && t <= rec.time)) {
					T.pair_lives++;
					T.pair_life_armour_at_death[L.armour] = (T.pair_life_armour_at_death[L.armour] || 0) + 1;
				}
				life[p] = { armour: 9, start: rec.time, first: false };
			}
		}
	}
}

let targets = process.argv.slice(2);
if (!targets.length) targets = [path.join(ROOT, "fixtures")];
for (let target of targets) for (let file of walk(target)) scan(file);

let pct = (n, of) => of ? ` (${(100 * n / of).toFixed(1)}%)` : "";
console.log(`FC tank-hit packets: ${T.hits} in ${T.files} logs\n`);
console.log(`sender is the victim: ${T.self}${pct(T.self, T.hits)}`);
console.log(`  shell heading d in the victim's own previous lists (a pill shell it simulates): ${T.self_shell_in_own_lists}`);
console.log(`  no listed shell, a pill fired d at the victim within ${POINT_BLANK} ticks (point-blank): ${T.self_point_blank_pill}`);
console.log(`  shell in the victim's own lists a sector off d (listed under its birth sector): ${T.self_shell_in_own_lists_sector_off}`);
console.log(`  shell heading d only in another machine's lists: ${T.self_shell_in_other_lists}`);
console.log(`  unexplained: ${T.self_unexplained}\n`);
console.log(`sender is another player: ${T.other}${pct(T.other, T.hits)}`);
console.log(`  shell heading d in the sender's own previous lists: ${T.other_shell_in_sender_lists}`);
console.log(`  no listed shell, sender fired d within ${POINT_BLANK} ticks (point-blank): ${T.other_point_blank_shot}`);
console.log(`  shell in the sender's own lists a sector off d (listed under its birth sector): ${T.other_shell_in_sender_lists_sector_off}`);
console.log(`  shell heading d only in the victim's lists: ${T.other_shell_in_victim_lists}`);
console.log(`  shell heading d only in a third machine's lists: ${T.other_shell_in_third_lists}`);
console.log(`  unexplained: ${T.other_unexplained}`);
console.log(`  by the sender's last ${RECENT} ticks in direction d: tank shot only ${T.other_tank_only}, pill fired at sender only ${T.other_pill_only} (a pill shell hitting a tank other than its target), both ${T.other_both}, neither ${T.other_neither} (${T.other_neither_one_sector_off} of them one sector off a shot or pill fire)`);
console.log(`  pill-only hits where the victim also reported d within ${PAIR_TICKS} ticks: ${T.pill_only_victim_also_reported}\n`);
console.log(`same victim, same d, two senders within ${PAIR_TICKS} ticks: ${T.two_sender_pairs} pairs in ${T.pair_lives} lives ending in a shell death`);
console.log(`  armour replayed at those deaths (0 = every hit real, -1 = one hit surplus): ${Object.entries(T.pair_life_armour_at_death).sort((a, b) => a[0] - b[0]).map(([k, n]) => `${k}:${n}`).join(" ")}`);
