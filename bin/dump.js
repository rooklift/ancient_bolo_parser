#!/usr/bin/env node
// CLI for inspecting classic Mac Bolo log files.
//
//   node bin/dump.js <logfile>            summary
//   node bin/dump.js <logfile> --events   human-readable event stream
//   node bin/dump.js <logfile> --json     one JSON record per line
//   node bin/dump.js <logfile> --raw N    hex-dump first N decrypted records

import { readFileSync } from "node:fs";
import { parseHeader, rawRecords, records, TICKS_PER_SECOND } from "../src/parse.js";

const args = process.argv.slice(2);
/* the numeric token after --raw is its count, not the filename */
const rawIdx = args.indexOf("--raw");
const rawCountArg = rawIdx >= 0 && /^\d+$/.test(args[rawIdx + 1] ?? "") ? args[rawIdx + 1] : null;
const file = args.find((a, i) => !a.startsWith("--") && !(i === rawIdx + 1 && rawCountArg !== null));
if (!file) {
	console.error("usage: dump.js <logfile> [--events | --json | --raw N]");
	process.exit(1);
}
const buf = new Uint8Array(readFileSync(file));
const header = parseHeader(buf);

function warnTruncation(stats) {
	if (stats.truncatedBytes) {
		console.error(`NOTE: log truncated mid-record (${stats.truncatedBytes} trailing bytes dropped)`);
	}
}

function clock(ticks, t0) {
	const s = Math.max(0, ticks - t0) / TICKS_PER_SECOND;
	const m = Math.floor(s / 60);
	return `${String(m).padStart(3)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

if (rawIdx >= 0) {
	const n = rawCountArg !== null ? parseInt(rawCountArg, 10) : 10;
	let i = 0;
	for (const raw of rawRecords(buf)) {
		const hex = Array.from(raw.data).map(b => b.toString(16).padStart(2, "0")).join(" ");
		console.log(`${raw.time.toString(16).padStart(8, "0")} len=${raw.data.length + 1} ${hex}`);
		if (++i >= n) break;
	}
	process.exit(0);
}

if (args.includes("--json")) {
	const stats = {};
	for (const rec of records(buf, stats)) {
		console.log(JSON.stringify(rec));
	}
	warnTruncation(stats);
	process.exit(0);
}

if (args.includes("--events")) {
	let t0 = null;
	const names = {};
	const stats = {};
	for (const rec of records(buf, stats)) {
		if (t0 === null) t0 = rec.time;
		const who = () => names[rec.player] ?? `player ${rec.player}`;
		for (const sub of rec.subpackets) {
			const at = clock(rec.time, t0);
			switch (sub.type) {
				case "node_id":
					names[rec.player] = sub.name.split("@")[0];
					console.log(`${at}  join/rename: player ${rec.player} = "${sub.name}"`);
					break;
				case "game_info":
					console.log(`${at}  game info: map "${sub.mapName}", host ${sub.hostIp}, type ${sub.gameType}`);
					break;
				case "message":
					console.log(`${at}  <${who()}> [${sub.address.toString(16)}] ${sub.text}`);
					break;
				case "tank_death":
					console.log(`${at}  tank death: ${who()} (code ${sub.code})`);
					break;
				case "tank_hit":
					console.log(`${at}  shell from ${who()} hits tank ${sub.tank}`);
					break;
				case "base_capture":
					console.log(`${at}  ${who()} captures base ${sub.base}`);
					break;
				case "pill_plant":
					console.log(`${at}  ${who()} plants pill at ${sub.x},${sub.y}`);
					break;
				case "pill_pickup":
					console.log(`${at}  ${who()} picks up pill ${sub.pillbox}`);
					break;
				case "lgm_death":
					console.log(`${at}  ${who()}'s man dies at ${sub.x},${sub.y}`);
					break;
				case "alliance_request":
				case "alliance_accept":
				case "alliance_leave":
					console.log(`${at}  ${who()}: ${sub.type} ${sub.tanks !== undefined ? sub.tanks.toString(2) : ""}`);
					break;
				case "quit":
					console.log(`${at}  quit: ${who()}`);
					break;
			}
		}
		if (rec.warning) {
			console.log(`      ! offset ${rec.offset} p${rec.player} b=${rec.status.toString(16)} T=${rec.tankStatus.toString(16)}: ${rec.warning} [${rec.unparsed ?? ""}]`);
		}
	}
	warnTruncation(stats);
	process.exit(0);
}

// Default: summary.
const stats = {};
let count = 0;
let warned = 0;
let first = null;
let last = null;
const byType = {};
const players = {};
const byStatus = {};
const warnByStatus = {};
let gameInfo = null;

for (const rec of records(buf, stats)) {
	count++;
	if (first === null) first = rec.time;
	last = rec.time;
	const key = `b=${rec.status.toString(16)} T=${rec.tankStatus.toString(16)}`;
	byStatus[key] = (byStatus[key] || 0) + 1;
	if (rec.warning) {
		warned++;
		warnByStatus[key] = (warnByStatus[key] || 0) + 1;
	}
	for (const sub of rec.subpackets) {
		byType[sub.type] = (byType[sub.type] || 0) + 1;
		if (sub.type === "node_id") players[rec.player] = sub.name;
		if (sub.type === "game_info" && !gameInfo) gameInfo = sub;
	}
}

console.log(`Bolo log, version ${header.version}`);
console.log(`records: ${count} (${warned} with parse warnings)`);
if (stats.truncatedBytes) {
	console.log(`NOTE: file is truncated — ${stats.truncatedBytes} trailing bytes dropped`);
}
if (first !== null) {
	console.log(`duration: ${((last - first) / TICKS_PER_SECOND / 60).toFixed(1)} minutes of game time`);
}
if (gameInfo) {
	console.log(`map: "${gameInfo.mapName}"  host: ${gameInfo.hostIp}  game type: ${gameInfo.gameType}`);
}
console.log(`players:`);
for (const [num, name] of Object.entries(players)) {
	console.log(`  ${num}: ${name}`);
}
console.log(`subpacket counts:`);
for (const [type, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
	console.log(`  ${String(n).padStart(8)}  ${type}`);
}
console.log(`records by status nibbles (warnings):`);
for (const [key, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
	console.log(`  ${String(n).padStart(8)}  ${key}  (${warnByStatus[key] || 0} warned)`);
}
