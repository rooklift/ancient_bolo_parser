#!/usr/bin/env node
/* Does a `5d` shot_fired nibble carry the tank's direction at FIRE time or
 * at PACKET time?
 *
 * Issues #17/#24 inferred packet-time from one turning-tank case (a d14
 * shell whose record's only shot_fired read d13), and the engine's birth
 * matchers require exact equality between a shell and its shot_fired on
 * that reading.  The two hypotheses separate cleanly because every record
 * header restates the sender's own packet-time direction (`tankDir`):
 *
 *   - packet time: the nibble equals the same record's tankDir, always,
 *     mid-turn included;
 *   - fire time: in records where tankDir just changed, the nibble lands
 *     wherever the tank pointed when the shot happened -- the previous
 *     heading, the new one, or a step crossed in between.
 *
 * MEASUREMENT ONE tallies shot_fired against the record's own tankDir and
 * the sender's previous tankDir, split by whether the sender was mid-turn
 * (tankDir changed since its previous record).  For nibbles matching
 * neither, it checks whether they at least lie on the short arc between
 * the two headings, as a fire mid-way through a multi-step turn would.
 *
 * MEASUREMENT TWO asks where the shot's shell is.  Under fire-time
 * semantics the shell exists at packet time and should ride the same
 * record's shell lists; a fire racing the packet build would surface in
 * the sender's NEXT restatement instead.  Tallied per direction-match
 * class, coarsely -- "a shell list of direction d exists", which a
 * same-direction pillbox shell can satisfy, so read the split, not the
 * absolute rate.  Point-blank shots that die before any restatement land
 * in "unseen".
 *
 * Usage:
 *   node tools/measure-shot-direction.cjs [replay-or-directory]
 *       (no arguments: the whole corpus, via BOLO_CORPUS/corpus.json,
 *       falling back to the committed fixtures when neither is set)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_TARGET = path.join(ROOT, "fixtures");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;

function circular_distance(a, b) {
	let d = Math.abs(a - b) % 16;
	return Math.min(d, 16 - d);
}

/* Is c on the short arc from a to b (endpoints excluded)? */
function between(a, b, c) {
	let span = circular_distance(a, b);
	return span > 1 &&
		circular_distance(a, c) < span && circular_distance(c, b) < span;
}

function collect_files(target) {
	let stat = fs.statSync(target);
	if (!stat.isDirectory()) return [target];
	let files = [];
	for (let entry of fs.readdirSync(target, { withFileTypes: true })) {
		let full = path.join(target, entry.name);
		if (entry.isDirectory()) files.push(...collect_files(full));
		else if (!SKIPPED_EXTENSIONS.test(entry.name)) files.push(full);
	}
	return files.sort();
}

function empty_tally() {
	return {
		shot_fired_total: 0,
		eq_packet_dir: 0,			/* nibble == this record's tankDir */
		eq_prev_dir: 0,				/* == previous record's tankDir only */
		eq_neither: 0,
		neither_between: 0,			/* ...but on the short arc prev->current */
		neither_dist_1: 0,			/* one coarse step from packet dir */
		turning_total: 0,			/* fires in records where tankDir changed */
		turning_eq_packet: 0,
		turning_eq_prev: 0,
		turning_eq_neither: 0,
		steady_eq_prev: 0,			/* impossible by construction; sanity 0 */
		steady_eq_neither: 0,
		shell_same_record: { eq_packet: 0, eq_prev: 0, neither: 0 },
		shell_next_record_only: { eq_packet: 0, eq_prev: 0, neither: 0 },
		shell_unseen: { eq_packet: 0, eq_prev: 0, neither: 0 },
	};
}

function measure_file(recs, tally) {
	/* Per-sender record streams; the header nibbles are per sender. */
	let streams = new Map();
	for (let rec of recs) {
		if (rec.tankStatus === 0x0f) continue;	/* attached-log pseudo-record */
		let stream = streams.get(rec.player);
		if (!stream) streams.set(rec.player, stream = []);
		stream.push(rec);
	}
	for (let stream of streams.values()) {
		for (let i = 0; i < stream.length; i++) {
			let rec = stream[i];
			let prev = i > 0 ? stream[i - 1] : null;
			let next = i + 1 < stream.length ? stream[i + 1] : null;
			let turning = prev !== null && prev.tankDir !== rec.tankDir;
			for (let sub of rec.subpackets) {
				if (sub.type !== "shot_fired") continue;
				let d = sub.direction;
				tally.shot_fired_total++;
				if (turning) tally.turning_total++;
				let cls;
				if (d === rec.tankDir) {
					cls = "eq_packet";
					tally.eq_packet_dir++;
					if (turning) tally.turning_eq_packet++;
				} else if (prev !== null && d === prev.tankDir) {
					cls = "eq_prev";
					tally.eq_prev_dir++;
					if (turning) tally.turning_eq_prev++;
					else tally.steady_eq_prev++;
				} else {
					cls = "neither";
					tally.eq_neither++;
					if (turning) {
						tally.turning_eq_neither++;
						if (between(prev.tankDir, rec.tankDir, d)) {
							tally.neither_between++;
						}
					} else {
						tally.steady_eq_neither++;
					}
					if (circular_distance(d, rec.tankDir) === 1) {
						tally.neither_dist_1++;
					}
				}
				let same = rec.subpackets.some(
					s => s.type === "shells" && s.direction === d);
				let in_next = next !== null && next.subpackets.some(
					s => s.type === "shells" && s.direction === d);
				let where = same ? "shell_same_record"
					: in_next ? "shell_next_record_only"
					: "shell_unseen";
				tally[where][cls]++;
			}
		}
	}
}

function repo_commit() {
	const { execSync } = require("node:child_process");
	const run = (command) => execSync(command,
		{ cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	try {
		let hash = run("git rev-parse --short HEAD");
		return run("git status --porcelain -uno") ? `${hash}-dirty` : hash;
	} catch {
		return "unknown";
	}
}

function main() {
	const BoloLog = require(path.join(ROOT, "viewer", "logparse.js"));
	let target;
	if (process.argv[2]) {
		target = path.resolve(process.argv[2]);
	} else {
		let corpus = null;
		try {
			corpus = require(path.join(ROOT, "tools", "corpus.cjs"))
				.resolve_corpus_root();
		} catch (error) {
			corpus = null;
		}
		target = corpus && fs.existsSync(corpus) ? corpus : DEFAULT_TARGET;
	}
	let files = collect_files(target);
	let tally = empty_tally();
	let failed = 0;
	for (let file of files) {
		let recs;
		try {
			recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
		} catch (error) {
			failed++;
			continue;
		}
		measure_file(recs, tally);
	}
	let lines = [
		"# GENERATED - shot_fired direction semantics; nothing written to disk.",
		`commit\t${repo_commit()}`,
		`files\t${files.length}`,
		`files_failed\t${failed}`,
	];
	for (let [key, value] of Object.entries(tally)) {
		if (typeof value === "number") {
			lines.push(`${key}\t${value}`);
		} else {
			for (let [cls, n] of Object.entries(value)) {
				lines.push(`${key}_${cls}\t${n}`);
			}
		}
	}
	console.log(lines.join("\n"));
}

main();
