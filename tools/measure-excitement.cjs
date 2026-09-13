#!/usr/bin/env node
/* Rank replays by how much happened in them.
 *
 * "Excitement" here is a weighted count of the events that resolve a
 * fight or swing the map, divided by PLAYER-MINUTES rather than wall
 * minutes, so a six-player game does not outrank a duel just by having
 * more tanks firing. The events and their weights:
 *
 *   tank_death       5   an `F9`; a second code within a few seconds of
 *                        the first from the same slot (F901 then F902
 *                        mid-animation) is the same death
 *   pill_pickup      4   the capture event (`FF 0n`); repairs and plants
 *                        change nothing and are not counted
 *   base_capture     3   from an owner; 1 from neutral, since grabbing
 *                        empty bases at the start is a race, not a fight.
 *                        Owners come from the `F1 03` list and follow
 *                        each capture. Alliances are ignored, so a base
 *                        taken over from an ally scores as hostile
 *   lgm_death        3   `F5`, or `FF 51` when the man died carrying a
 *                        pill (no `F5` is sent then)
 *   alliance_leave   3   a betrayal, or a team falling apart
 *   tank_hit         1   `FC`, one shell striking one tank
 *   pillbox_damage   0.25 `9n`, one shell on a pill: a siege
 *
 * Shots fired (`5d`) and chat lines are counted and printed but carry no
 * weight: players plink at trees and shoot pills from safety, so the
 * shot count says little about drama, and chat is shown for a human to
 * read alongside the numbers.
 *
 * ACTIVE PLAYER TIME: a slot is active for the ACTIVE_HOLD seconds after
 * each live (not dying) tank position it sends. Idle tanks restate only
 * every few seconds, so a short hold would count a parked player as
 * absent; a long one would pay for ring-split ghosts. Player-minutes is
 * the sum over slots of the seconds so covered.
 *
 * Two scores per log. RATE is the whole game's weighted total per
 * player-minute. PEAK is the same figure over the best sliding window of
 * WINDOW seconds (with at least one player-minute in it), with the
 * window's start printed as mm:ss from the first record, for seeking to
 * in the viewer.
 *
 * Logs shorter than MIN_GAME_MINUTES of game time, with fewer than
 * MIN_PLAYER_MINUTES of player time, or never showing two live tanks
 * at once are scanned but not ranked. Two recordings of one game (the
 * pairs the corpus is known to hold) share a game id, host IP plus
 * start time from `F1 01`, and only the longer recording is ranked.
 *
 * Usage: node tools/measure-excitement.cjs [file | directory ...]
 *          [--top=N] [--sort=rate|peak|total] [--window=SECONDS] [--names]
 * With no target the corpus root from corpus.json / BOLO_CORPUS is read.
 * Logs print by their hashed label (tools/corpus.cjs); --names prints
 * the file basenames instead, for the corpus holder.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { corpus_root, replay_label } = require("./corpus.cjs");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));

const TPS = BoloLog.TICKS_PER_SECOND;
const ACTIVE_HOLD = 10;       /* seconds a live position keeps a slot active */
const DEATH_MERGE = 5 * TPS;  /* ticks within which two F9s are one death */
const MIN_GAME_MINUTES = 3;
const MIN_PLAYER_MINUTES = 5;

const WEIGHTS = {
	tank_death: 5,
	pill_pickup: 4,
	base_capture_hostile: 3,
	base_capture_neutral: 1,
	lgm_death: 3,
	alliance_leave: 3,
	tank_hit: 1,
	pillbox_damage: 0.25,
};

let opts = { top: 10, sort: "rate", window: 60, names: false };
let targets = [];
for (let arg of process.argv.slice(2)) {
	let m = arg.match(/^--([a-z]+)(?:=(.*))?$/);
	if (!m) { targets.push(arg); continue; }
	if (m[1] === "names") opts.names = true;
	else if (m[1] === "top") opts.top = parseInt(m[2], 10) || 10;
	else if (m[1] === "sort") opts.sort = m[2];
	else if (m[1] === "window") opts.window = parseInt(m[2], 10) || 60;
	else { console.error(`unknown option ${arg}`); process.exit(2); }
}
if (!["rate", "peak", "total"].includes(opts.sort)) {
	console.error("--sort must be rate, peak or total");
	process.exit(2);
}
if (!targets.length) targets = [corpus_root()];

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
		entries = fs.readdirSync(target, { withFileTypes: true });
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

function scan(file, recs) {
	let t0 = recs[0].time;
	let span = recs[recs.length - 1].time - t0;
	let seconds = Math.floor(span / TPS) + 1;
	let counts = { tank_death: 0, pill_pickup: 0, base_capture_hostile: 0, base_capture_neutral: 0,
		lgm_death: 0, alliance_leave: 0, tank_hit: 0, pillbox_damage: 0, shot_fired: 0, message: 0 };
	let weight_by_second = new Float64Array(seconds);
	let active = Array.from({ length: 16 }, () => new Uint8Array(seconds));
	let last_death = new Array(16).fill(-Infinity);
	let base_owner = new Array(16).fill(0xff);
	let map_name = "", game_id = "";

	function event(kind, t) {
		counts[kind]++;
		let w = WEIGHTS[kind] || 0;
		if (w) weight_by_second[Math.floor((t - t0) / TPS)] += w;
	}

	for (let rec of recs) {
		if (rec.tankStatus === 0x0f) continue;
		let p = rec.player;
		for (let sub of rec.subpackets) {
			switch (sub.type) {
			case "game_info":
				if (!game_id) { game_id = sub.gameId; map_name = sub.mapName; }
				break;
			case "base_list":
				sub.items.forEach((b, i) => { if (i < 16) base_owner[i] = b.owner; });
				break;
			case "tank_position":
				if (!sub.dying) {
					let s = Math.floor((rec.time - t0) / TPS);
					for (let i = s; i < Math.min(seconds, s + ACTIVE_HOLD); i++) active[p][i] = 1;
				}
				break;
			case "tank_death":
				if (rec.time - last_death[p] > DEATH_MERGE) event("tank_death", rec.time);
				last_death[p] = rec.time;
				break;
			case "base_capture": {
				let owner = base_owner[sub.base];
				event(owner < 16 && owner !== p ? "base_capture_hostile" : "base_capture_neutral", rec.time);
				base_owner[sub.base] = p;
				break;
			}
			case "pill_dumped_by_dead_lgm":
				event("lgm_death", rec.time);
				break;
			case "pill_pickup": case "lgm_death": case "alliance_leave":
			case "tank_hit": case "pillbox_damage": case "shot_fired": case "message":
				event(sub.type, rec.time);
				break;
			}
		}
	}

	/* Player-seconds per second bin, then a sliding window over both. */
	let players_by_second = new Uint8Array(seconds);
	let slots_seen = 0, peak_players = 0;
	for (let p = 0; p < 16; p++) {
		let any = false;
		for (let i = 0; i < seconds; i++) if (active[p][i]) { players_by_second[i]++; any = true; }
		if (any) slots_seen++;
	}
	let player_seconds = 0;
	for (let i = 0; i < seconds; i++) {
		player_seconds += players_by_second[i];
		if (players_by_second[i] > peak_players) peak_players = players_by_second[i];
	}
	let total = 0;
	for (let i = 0; i < seconds; i++) total += weight_by_second[i];

	let win = Math.min(opts.window, seconds);
	let w_sum = 0, ps_sum = 0, peak = 0, peak_at = 0;
	for (let i = 0; i < seconds; i++) {
		w_sum += weight_by_second[i];
		ps_sum += players_by_second[i];
		if (i >= win) {
			w_sum -= weight_by_second[i - win];
			ps_sum -= players_by_second[i - win];
		}
		if (i >= win - 1 && ps_sum >= 60) {
			let r = w_sum / (ps_sum / 60);
			if (r > peak) { peak = r; peak_at = i - win + 1; }
		}
	}

	return {
		file, label: opts.names ? path.basename(file) : replay_label(file),
		map: map_name, game_id, records: recs.length,
		minutes: span / TPS / 60, player_minutes: player_seconds / 60,
		slots: slots_seen, peak_players, counts, total,
		rate: player_seconds ? total / (player_seconds / 60) : 0,
		peak, peak_at,
	};
}

let results = [];
let unparsed = 0;
for (let target of targets) {
	for (let file of walk(target)) {
		let recs;
		try {
			recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
		} catch {
			unparsed++;
			continue;
		}
		if (recs.length < 2) { unparsed++; continue; }
		results.push(scan(file, recs));
	}
}
if (!results.length) {
	console.error("no logs found");
	process.exit(1);
}

/* One recording per game: the longer of any two sharing a game id. */
let by_game = new Map();
let duplicates = 0;
for (let r of results) {
	let key = r.game_id || `nogameinfo:${r.file}`;
	let held = by_game.get(key);
	if (!held) by_game.set(key, r);
	else { duplicates++; if (r.records > held.records) by_game.set(key, r); }
}
let ranked = [...by_game.values()].filter(r =>
	r.minutes >= MIN_GAME_MINUTES && r.player_minutes >= MIN_PLAYER_MINUTES && r.peak_players >= 2);
let unranked = by_game.size - ranked.length;
ranked.sort((a, b) => b[opts.sort] - a[opts.sort]);

function mmss(s) {
	return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

console.log(`logs ${results.length}  unparsed ${unparsed}  duplicate recordings ${duplicates}  ranked ${ranked.length}  too short or lonely ${unranked}`);
console.log(`weights: ${Object.entries(WEIGHTS).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`sorted by ${opts.sort}; rate and peak are weighted events per player-minute, peak over a ${opts.window} s window\n`);

let shown = ranked.slice(0, opts.top);
let name_width = Math.max(5, ...shown.map(r => r.label.length));
let map_width = Math.min(24, Math.max(3, ...shown.map(r => r.map.length)));
let head = ["#".padStart(3), "log".padEnd(name_width), "map".padEnd(map_width), "min".padStart(5), "ply".padStart(3), "p-min".padStart(6),
	"death".padStart(5), "hit".padStart(5), "pill".padStart(4), "base".padStart(5), "lgm".padStart(4), "leave".padStart(5),
	"shot".padStart(6), "chat".padStart(4), "total".padStart(7), "rate".padStart(6), "peak".padStart(6), "peak@".padStart(6)];
console.log(head.join("  "));
shown.forEach((r, i) => {
	let c = r.counts;
	let row = [String(i + 1).padStart(3), r.label.padEnd(name_width), r.map.slice(0, map_width).padEnd(map_width),
		r.minutes.toFixed(1).padStart(5), String(r.peak_players).padStart(3), r.player_minutes.toFixed(0).padStart(6),
		String(c.tank_death).padStart(5), String(c.tank_hit).padStart(5), String(c.pill_pickup).padStart(4),
		`${c.base_capture_hostile}+${c.base_capture_neutral}`.padStart(5), String(c.lgm_death).padStart(4),
		String(c.alliance_leave).padStart(5), String(c.shot_fired).padStart(6), String(c.message).padStart(4),
		r.total.toFixed(1).padStart(7), r.rate.toFixed(2).padStart(6), r.peak.toFixed(1).padStart(6), mmss(r.peak_at).padStart(6)];
	console.log(row.join("  "));
});
console.log("\nbase = hostile+neutral captures; ply = most tanks alive at once; peak@ = window start, mm:ss from the first record");
