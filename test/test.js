// Regression test: the sample log must parse completely, with no warnings,
// and yield the known ground-truth facts about the game.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHeader, records } from "../src/parse.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* fixtures/n20021018.2 is an ANONYMIZED log (names, hostnames, chat
 * mentions and IP addresses substituted same-length; replay bytes
 * otherwise identical) and is committed. Raw logs stay local-only in
 * samples/, which is gitignored. */
const log1 = join(root, "fixtures", "n20021018.2");
const log2 = join(root, "samples", "n20020306.1");
const buf = new Uint8Array(readFileSync(log1));

let failures = 0;
function check(what, got, want) {
	const ok = got === want;
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (wanted ${want})`}`);
}

const header = parseHeader(buf);
check("version", header.version, "00990700");
check("versionString", header.versionString, "0.99.7");

let count = 0;
let warned = 0;
let mapName = null;
let multi_shell_list = null;
const players = {};
for (const rec of records(buf)) {
	count++;
	if (rec.warning) warned++;
	for (const sub of rec.subpackets) {
		if (sub.type === "game_info") mapName = sub.mapName;
		if (sub.type === "node_id" && !(rec.player in players)) players[rec.player] = sub.name;
		if (sub.type === "shells" && sub.shells.length > 1 && multi_shell_list === null) multi_shell_list = sub;
	}
}

check("records", count, 120840);
check("records with warnings", warned, 0);
check("map name", mapName, "Fly Swatter IV");
check("player count", Object.keys(players).length, 4);
check("player 0", players[0], "Jarvis@wolf.step.uwu.com");
check("multi-shell list exposes its direction", multi_shell_list?.direction, multi_shell_list?.shells[0].direction);
check("list direction applies to every parsed shell", multi_shell_list?.shells.every(shell => shell.direction === multi_shell_list.direction), true);

// Second fixture: 4-player game on "Crankcase", 6 March 2002 — including a
// player literally named with the Apple logo (MacRoman 0xF0 = U+F8FF).
if (existsSync(log2)) {
	const buf2 = new Uint8Array(readFileSync(log2));
	let count2 = 0, warned2 = 0, map2 = null;
	const names2 = {};
	for (const rec of records(buf2)) {
		count2++;
		if (rec.warning) warned2++;
		for (const sub of rec.subpackets) {
			if (sub.type === "game_info" && !map2) map2 = sub.mapName;
			if (sub.type === "node_id" && !(rec.player in names2)) names2[rec.player] = sub.name;
		}
	}
	check("log2 records", count2, 10713);
	check("log2 warnings", warned2, 0);
	check("log2 map", map2, "Crankcase");
	check("log2 apple-logo player", names2[2], "\uf8ff@Unknown Machine Name");
}

process.exit(failures ? 1 : 0);
