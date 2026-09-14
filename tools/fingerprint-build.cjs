#!/usr/bin/env node
"use strict";

/* Fingerprint the viewer's build of each fixture, so a change meant to
 * leave the reconstruction alone can be checked for doing so, byte for
 * byte, rather than trusted.
 *
 *   node tools/fingerprint-build.cjs                   print the digests
 *   node tools/fingerprint-build.cjs --save FILE       print and save them
 *   node tools/fingerprint-build.cjs --check FILE      compare against a save
 *   node tools/fingerprint-build.cjs [...] LOG...      these logs instead of
 *                                                      the committed fixtures
 *
 * Six digests per log, each a SHA-256 over the JSON of one part of the
 * built game with its keys sorted, floats rounded to nine places and the
 * cyclic references left out: the shell snapshots (every chain, orbit
 * and bradian state, terminal match and heading), the shell births, the
 * gap segments, the effects, the three tracks, and the final game state.
 * A digest that changes names the part that moved; --check exits 1 on
 * any difference. The build times printed are for orientation only.
 *
 * The digests cover the whole build, so they also move when a change is
 * MEANT to change the reconstruction; the corpus tools measure whether
 * such a change is an improvement, this one only whether it is a change.
 * The save format is the printed lines, timings dropped. */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const BoloLog = require("../viewer/logparse.js");
const BoloGame = require("../viewer/game.js");

const ROOT = path.join(__dirname, "..");

/* the fields that point back into the structure, or at the records */
const SKIP = new Set(["next_shell", "track", "tank_track", "record", "records",
	"terminals"]);

function plain(value, depth = 0) {
	if (value === null || typeof value !== "object") {
		return typeof value === "number" && !Number.isInteger(value)
			? +value.toFixed(9) : value;
	}
	if (depth > 6) return "[deep]";
	if (Array.isArray(value)) return value.map(item => plain(item, depth + 1));
	let out = {};
	for (let key of Object.keys(value).sort()) {
		if (SKIP.has(key)) continue;
		out[key] = plain(value[key], depth + 1);
	}
	return out;
}

function digest(value) {
	return crypto.createHash("sha256")
		.update(JSON.stringify(plain(value)))
		.digest("hex").slice(0, 16);
}

function fingerprint(file) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let records = [...BoloLog.records(bytes)];
	let start = performance.now();
	let game = BoloGame.build(records);
	let ms = performance.now() - start;
	let parts = {
		shells: digest(game.shell_positions),
		births: digest(game.shell_births),
		gaps: digest(game.shell_gap_segments),
		effects: digest(game.effects),
		tracks: digest([game.tank_positions, game.tank_directions,
			game.lgm_positions]),
		final: digest(game.final),
	};
	let line = path.basename(file).padEnd(14) + " " +
		Object.entries(parts).map(([key, value]) => `${key}=${value}`).join(" ");
	return { line, ms };
}

function committed_fixtures() {
	let fixtures = path.join(ROOT, "fixtures");
	let standalone = fs.readdirSync(fixtures)
		.filter(name => fs.statSync(path.join(fixtures, name)).isFile())
		.map(name => path.join(fixtures, name));
	let pairs = path.join(fixtures, "pairs");
	let paired = fs.existsSync(pairs)
		? fs.readdirSync(pairs).map(name => path.join(pairs, name)) : [];
	return [...standalone, ...paired].sort();
}

function parse_args(argv) {
	let options = { save: null, check: null, logs: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--save" || argv[i] === "--check") {
			let file = argv[++i];
			if (!file) {
				console.error(`error: ${argv[i - 1]} needs a file`);
				process.exit(2);
			}
			options[argv[i - 1].slice(2)] = path.resolve(file);
		} else if (argv[i].startsWith("--")) {
			console.error(`error: unknown option ${argv[i]}`);
			process.exit(2);
		} else {
			options.logs.push(path.resolve(argv[i]));
		}
	}
	if (options.save && options.check) {
		console.error("error: --save and --check are exclusive");
		process.exit(2);
	}
	if (!options.logs.length) options.logs = committed_fixtures();
	return options;
}

function main() {
	let options = parse_args(process.argv.slice(2));
	let lines = [];
	let total = 0;
	for (let file of options.logs) {
		let { line, ms } = fingerprint(file);
		lines.push(line);
		total += ms;
		console.log(`${line} ${ms.toFixed(0)}ms`);
	}
	console.error(`built ${lines.length} logs in ${(total / 1000).toFixed(1)} s`);
	if (options.save) {
		fs.writeFileSync(options.save, lines.join("\n") + "\n");
		console.error(`saved to ${options.save}`);
	}
	if (options.check) {
		/* by log name, so the order of the save does not matter */
		let by_name = list => new Map(list.map(line =>
			[line.slice(0, line.indexOf(" ")), line]));
		let saved = by_name(fs.readFileSync(options.check, "utf8").split("\n")
			.filter(line => line.length));
		let now = by_name(lines);
		let differing = [];
		for (let name of new Set([...saved.keys(), ...now.keys()])) {
			if (saved.get(name) !== now.get(name)) {
				differing.push(`  saved: ${saved.get(name) ?? `${name} (none)`}\n` +
					`  now:   ${now.get(name) ?? `${name} (none)`}`);
			}
		}
		if (differing.length) {
			console.error(`FINGERPRINTS DIFFER from ${options.check}:\n${differing.join("\n")}`);
			process.exit(1);
		}
		console.error(`FINGERPRINTS IDENTICAL to ${options.check}`);
	}
}

main();
