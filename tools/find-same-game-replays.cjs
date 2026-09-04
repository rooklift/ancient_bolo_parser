#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const BoloLog = require("../viewer/logparse.js");
const { corpus_root } = require("./corpus.cjs");

let args = process.argv.slice(2);
let copy = args.includes("--copy");
let game_id = args.find(arg => arg !== "--copy");
if (!game_id) process.exit(0);
let desktop = path.join(os.homedir(), "Desktop");

function* walk(dir) {
	for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
		let file = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(file);
		else if (entry.isFile()) yield file;
	}
}

for (let file of walk(corpus_root())) {
	let matches = false;
	try {
		let bytes = new Uint8Array(fs.readFileSync(file));
		let seen = 0;
		for (let raw of BoloLog.rawRecords(bytes)) {
			let record = BoloLog.parseRecord(raw);
			let info = record.subpackets.find(subpacket => subpacket.type === "game_info");
			if (info) {
				matches = info.gameId === game_id;
				break;
			}
			if (++seen >= 200) break;
		}
	} catch { /* Not a replay. */ }
	if (!matches) continue;
	console.log(file);
	if (copy) fs.copyFileSync(file, path.join(desktop, path.basename(file)));
}
