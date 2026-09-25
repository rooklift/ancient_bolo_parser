#!/usr/bin/env node
/* How many of one tank's shells can be in flight at once, and how long does
 * one fly?
 *
 * Every record restates all the shells its sender simulates [E:shell-restate],
 * so the number aloft is simply the shell count of one record. The catch is
 * that the lists mix the sender's own tank shells with the shells of every
 * pill whose target it is [E:pill-target]. Rather than lean on the viewer's
 * attribution, this tool reads only records that no pill shell can be in:
 * the record's time is more than PILL_QUIET_TICKS after the last `F4` from
 * any sender in the replay, and a pill shell lives 32 updates, 64 ticks. A
 * pill fire lost with its record would slip through, so each count is also
 * checked against the sender's own `5d` fires over the preceding
 * FIRE_WINDOW_TICKS: a record listing more shells than its sender fired in
 * that window is set aside as unexplained rather than counted.
 *
 * The lifetime half follows lone shells: a run of one sender's pill-quiet
 * records listing exactly one shell, opened by that sender's `5d` (in the
 * run's first record or within LONE_FIRE_LEAD_TICKS before it), closed by
 * a record listing none, with no other `5d` inside and no record gap over
 * LONE_MAX_GAP_TICKS, so neither a second shot nor a stalled ring can
 * stretch it. Its lifetime is the time from the `5d` record to the last
 * listing, its range the distance from the tank's centre at the shot to
 * the last listed position. Most lone shells hit something; the upper tail
 * is the ones that flew their full range.
 *
 * Usage:
 *   node tools/measure-tank-shells-aloft.cjs [<file or directory> ...]
 *       (no arguments: the whole corpus, via BOLO_CORPUS/corpus.json)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const { corpus_root, replay_label } = require("./corpus.cjs");

const PILL_QUIET_TICKS = 80;
const FIRE_WINDOW_TICKS = 90;
const LONE_FIRE_LEAD_TICKS = 10;
const LONE_MAX_GAP_TICKS = 4;
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;

let raw_counts = new Map();
let explained_counts = new Map();
let unexplained = 0;
let top = [];
let lone_ticks = new Map();
let lone_pixels = new Map();
let files_read = 0;

function bump(map, key) {
	map.set(key, (map.get(key) || 0) + 1);
}

function centre(x, y, pixel_x, pixel_y) {
	return [x * 16 + pixel_x + 8, y * 16 + pixel_y + 8];
}

function tally(file) {
	let records;
	try {
		records = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch (error) {
		return;
	}
	files_read++;
	let last_pill_fire = -Infinity;
	let fires = Array.from({ length: 16 }, () => []);
	let senders = Array.from({ length: 16 }, () => ({
		tank: null, last_fire: -Infinity, last_fire_tank: null,
		previous_count: 0, run: null,
	}));
	for (let rec of records) {
		let shells = 0, head = null, fired = false;
		let sender = senders[rec.player];
		for (let sub of rec.subpackets) {
			if (sub.type === "pillbox_fires") last_pill_fire = rec.time;
			else if (sub.type === "shot_fired") {
				fired = true;
				fires[rec.player].push(rec.time);
			} else if (sub.type === "tank_position") sender.tank = centre(sub.x, sub.y, sub.pixelX, sub.pixelY);
			else if (sub.type === "shells") {
				shells += sub.count;
				let first = sub.shells[0];
				head = centre(first.x, first.y, first.pixel & 0x0f, first.pixel >> 4);
			}
		}
		let quiet = rec.time - last_pill_fire > PILL_QUIET_TICKS;
		follow_lone_shell(sender, rec.time, quiet, shells, head, fired);
		if (fired) {
			sender.last_fire = rec.time;
			sender.last_fire_tank = sender.tank;
		}
		sender.previous_count = shells;
		if (!quiet) continue;
		bump(raw_counts, shells);
		let own = fires[rec.player];
		while (own.length && rec.time - own[0] > FIRE_WINDOW_TICKS) own.shift();
		if (shells > own.length) {
			unexplained++;
			continue;
		}
		bump(explained_counts, shells);
		if (shells >= 5) {
			top.push({ file: replay_label(file), player: rec.player, time: rec.time,
				shells, recent_fires: own.map(t => rec.time - t) });
		}
	}
}

function follow_lone_shell(sender, time, quiet, shells, head, fired) {
	let run = sender.run;
	if (quiet && shells === 1) {
		if (!run) {
			let recent = time - sender.last_fire <= LONE_FIRE_LEAD_TICKS;
			let tank = fired ? sender.tank : sender.last_fire_tank;
			if (sender.previous_count === 0 && (fired || recent) && tank) {
				sender.run = { fire: fired ? time : sender.last_fire, origin: tank,
					last: head, last_time: time, spoiled: false };
			}
			return;
		}
		if (fired || time - run.last_time > LONE_MAX_GAP_TICKS) run.spoiled = true;
		run.last = head;
		run.last_time = time;
		return;
	}
	if (run && quiet && shells === 0 && !fired && !run.spoiled &&
		time - run.last_time <= LONE_MAX_GAP_TICKS) {
		bump(lone_ticks, run.last_time - run.fire);
		bump(lone_pixels, Math.round(Math.hypot(run.last[0] - run.origin[0],
			run.last[1] - run.origin[1])));
	}
	sender.run = null;
}

function histogram(map, from = -Infinity) {
	return [...map.entries()].filter(([key]) => key >= from)
		.sort((a, b) => a[0] - b[0])
		.map(([key, n]) => `${key}:${n}`).join(" ");
}

function quantile(map, fraction) {
	let entries = [...map.entries()].sort((a, b) => a[0] - b[0]);
	let total = entries.reduce((sum, [, n]) => sum + n, 0);
	let seen = 0;
	for (let [key, n] of entries) {
		seen += n;
		if (seen >= fraction * total) return key;
	}
	return "-";
}

function main() {
	let targets = process.argv.slice(2);
	if (!targets.length) targets = [corpus_root()];
	let files = [];
	let walk = target => {
		if (fs.statSync(target).isDirectory()) {
			for (let name of fs.readdirSync(target)) walk(path.join(target, name));
		} else if (!SKIPPED_EXTENSIONS.test(target)) {
			files.push(target);
		}
	};
	targets.forEach(walk);
	for (let file of files) tally(file);
	console.log(`files\t${files_read}`);
	console.log(`pill-quiet records, shells listed\t${histogram(raw_counts)}`);
	console.log(`  of which more shells than recent 5d\t${unexplained}`);
	console.log(`explained by own recent fires\t${histogram(explained_counts)}`);
	top.sort((a, b) => b.shells - a.shells);
	let max = top.length ? top[0].shells : 0;
	console.log(`records at 5 or more shells\t${top.length}`);
	for (let row of top.filter(r => r.shells >= Math.max(5, max - 1)).slice(0, 40)) {
		console.log(`  ${row.shells}\t${row.file}\tplayer ${row.player}\tt ${row.time}` +
			`\tfires ago ${row.recent_fires.reverse().join(",")}`);
	}
	let lone = [...lone_ticks.values()].reduce((sum, n) => sum + n, 0);
	console.log(`lone shells\t${lone}`);
	for (let [name, map, from] of [["ticks, 5d to last listing", lone_ticks, 36],
		["px, tank centre at 5d to last listing", lone_pixels, 72]]) {
		console.log(`  ${name}\tp50 ${quantile(map, 0.5)}\tp90 ${quantile(map, 0.9)}` +
			`\tp99 ${quantile(map, 0.99)}\tp99.9 ${quantile(map, 0.999)}` +
			`\tmax ${Math.max(...map.keys())}`);
		console.log(`    tail from ${from}\t${histogram(map, from)}`);
	}
}

main();
