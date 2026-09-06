#!/usr/bin/env node
/* Does a fresh tank shell's list direction always equal its `5d` nibble?
 *
 * Carl Osterwald's notes say a shell can sit in a shell list "with a 0-15
 * direction that is not equal to the direction reported in the 5d
 * subpacket", and call it a possible Bolo bug. This tool measures the
 * claim, and then asks which of the two the shell actually flies.
 *
 * CENSUS. Per sender stream, every shell listed within MUZZLE px of the
 * sender's tank, outbound along its own heading (a shell inbound on the
 * tank is a pill's, which the sender simulates as the target), and fresh:
 * no shell of the same list direction sat where a 2 px/tick flight would
 * have put it one record earlier. Each is compared with the sender's
 * shot_fired nibbles in this record and its neighbours. A shell whose
 * label matches a nibble is a control; one whose label is one sector from
 * a nibble, with no nibble equal to its own label, is a case. The
 * relation to the header facing says when it happens: `shell=prevDir,
 * nib=tankDir` is the previous record's facing on the shell and the
 * current one on the nibble.
 *
 * FLIGHT. For each case, the shell is re-found one and two records on
 * under each heading hypothesis (list direction or nibble, 2 px/tick) and
 * the residuals compared; the controls are scored the same way against
 * their own sector and its neighbour, to show the test separates one
 * sector. `still_listed_under_stale_dir` counts cases re-found later
 * under the list direction they were born with.
 *
 * Usage:
 *   node tools/measure-shell-birth-sector.cjs [replay-or-directory]
 *       (no arguments: the whole corpus, via BOLO_CORPUS/corpus.json,
 *       falling back to the committed fixtures when neither is set)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_TARGET = path.join(ROOT, "fixtures");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const MUZZLE = 10;
const FRESH_PIXELS = 4;
const FRESH_SLOPE = 0.15;
const REFOUND_PIXELS = 12;
const TIE_PIXELS = 3;

function circular_distance(a, b) {
	let d = Math.abs(a - b) % 16;
	return Math.min(d, 16 - d);
}

function heading(direction) {
	let angle = direction * Math.PI / 8;
	return [Math.sin(angle), -Math.cos(angle)];
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

/* Every shell of a record as a top-left pixel, chained offsets resolved. */
function shells_of(rec) {
	let out = [];
	for (let sub of rec.subpackets) {
		if (sub.type !== "shells") continue;
		let px = 0, py = 0;
		for (let shell of sub.shells) {
			if (shell.x !== undefined) {
				px = shell.x * 16 + (shell.pixel & 0x0f);
				py = shell.y * 16 + (shell.pixel >> 4);
			} else {
				px += shell.offsetX;
				py += shell.offsetY;
			}
			out.push({ direction: sub.direction, px, py });
		}
	}
	return out;
}

function nibbles_of(rec) {
	return rec ? rec.subpackets.filter(sub => sub.type === "shot_fired")
		.map(sub => sub.direction) : [];
}

/* Smallest distance from the point predicted under `hypothesis` to any
 * shell in `later` listed under `list_direction`. */
function residual(shell, later, elapsed, hypothesis, list_direction) {
	let [hx, hy] = heading(hypothesis);
	let px = shell.px + hx * 2 * elapsed, py = shell.py + hy * 2 * elapsed;
	let best = Infinity;
	for (let other of later) {
		if (other.direction !== list_direction) continue;
		best = Math.min(best, Math.hypot(other.px - px, other.py - py));
	}
	return best;
}

function empty_tally() {
	return {
		records_with_tank: 0,
		muzzle_shells: 0,
		muzzle_inbound_skipped: 0,
		muzzle_fresh: 0,
		fresh_nibble_exact_same_record: 0,
		fresh_nibble_exact_adjacent_record: 0,
		fresh_no_nibble_any_record: 0,
		fresh_nibble_differs: 0,
		differs_by_one_sector: 0,
		differs_while_turning: 0,
		differs_shell_prev_dir_nibble_tank_dir: 0,
		differs_sign_plus: 0,
		differs_sign_minus: 0,
		flight_decided: 0,
		flight_follows_list_dir: 0,
		flight_follows_nibble: 0,
		still_listed_under_stale_dir: 0,
		relisted_under_nibble_dir: 0,
		control_decided: 0,
		control_follows_list_dir: 0,
		control_follows_neighbour: 0,
	};
}

function measure_file(recs, tally, logs, label) {
	let streams = new Map();
	for (let rec of recs) {
		if (rec.tankStatus === 0x0f) continue;
		let stream = streams.get(rec.player);
		if (!stream) streams.set(rec.player, stream = []);
		stream.push(rec);
	}
	for (let stream of streams.values()) {
		for (let i = 1; i < stream.length; i++) {
			let rec = stream[i], prev = stream[i - 1];
			let next = stream[i + 1] || null, after = stream[i + 2] || null;
			let tank = rec.subpackets.find(sub => sub.type === "tank_position");
			if (!tank) continue;
			tally.records_with_tank++;
			let tx = tank.x * 16 + tank.pixelX, ty = tank.y * 16 + tank.pixelY;
			let back = 2 * Math.max(0, rec.time - prev.time);
			let prev_shells = shells_of(prev);
			let nibbles_same = nibbles_of(rec);
			let nibbles_adjacent = [...nibbles_of(prev), ...nibbles_of(next)];
			let later1 = next ? shells_of(next) : null;
			let later2 = after ? shells_of(after) : null;
			let e1 = next ? next.time - rec.time : 0;
			let e2 = after ? after.time - rec.time : 0;
			let can_follow = later1 && later2 && e1 > 0 && e1 <= 40 && e2 <= 80;
			let score = (shell, list_direction, alternative) => {
				if (!can_follow) return null;
				let a = residual(shell, later1, e1, shell.direction, list_direction) +
					residual(shell, later2, e2, shell.direction, list_direction);
				let b = residual(shell, later1, e1, alternative, list_direction) +
					residual(shell, later2, e2, alternative, list_direction);
				if (Math.min(a, b) > REFOUND_PIXELS) return null;
				if (Math.abs(a - b) < TIE_PIXELS) return null;
				return a < b ? "list" : "alternative";
			};
			for (let shell of shells_of(rec)) {
				let dx = shell.px - tx, dy = shell.py - ty;
				let distance = Math.hypot(dx, dy);
				if (distance > MUZZLE || distance === 0) continue;
				tally.muzzle_shells++;
				let [hx, hy] = heading(shell.direction);
				if ((dx * hx + dy * hy) / distance <= 0.5) {
					tally.muzzle_inbound_skipped++;
					continue;
				}
				let was_x = shell.px - hx * back, was_y = shell.py - hy * back;
				if (prev_shells.some(other => other.direction === shell.direction &&
					Math.hypot(other.px - was_x, other.py - was_y) <=
						FRESH_PIXELS + back * FRESH_SLOPE)) continue;
				tally.muzzle_fresh++;
				if (nibbles_same.includes(shell.direction)) {
					tally.fresh_nibble_exact_same_record++;
					let verdict = score(shell, shell.direction, (shell.direction + 1) % 16);
					if (verdict) {
						tally.control_decided++;
						if (verdict === "list") tally.control_follows_list_dir++;
						else tally.control_follows_neighbour++;
					}
					continue;
				}
				if (nibbles_adjacent.includes(shell.direction)) {
					tally.fresh_nibble_exact_adjacent_record++;
					continue;
				}
				let all = [...nibbles_same, ...nibbles_adjacent];
				if (!all.length) {
					tally.fresh_no_nibble_any_record++;
					continue;
				}
				tally.fresh_nibble_differs++;
				let nibble = nibbles_same.length ? nibbles_same[0] : all[0];
				if (circular_distance(nibble, shell.direction) !== 1) continue;
				tally.differs_by_one_sector++;
				logs.set(label, (logs.get(label) || 0) + 1);
				let turning = rec.tankDir !== prev.tankDir;
				if (turning) tally.differs_while_turning++;
				if (turning && shell.direction === prev.tankDir &&
					nibble === rec.tankDir) {
					tally.differs_shell_prev_dir_nibble_tank_dir++;
				}
				if ((shell.direction - nibble + 16) % 16 === 1) tally.differs_sign_plus++;
				else tally.differs_sign_minus++;
				let verdict = score(shell, shell.direction, nibble);
				if (verdict) {
					tally.flight_decided++;
					if (verdict === "list") tally.flight_follows_list_dir++;
					else tally.flight_follows_nibble++;
				}
				if (!can_follow) continue;
				let stale = residual(shell, later1, e1, nibble, shell.direction) <= 6 ||
					residual(shell, later2, e2, nibble, shell.direction) <= 6;
				let relisted = residual(shell, later1, e1, nibble, nibble) <= 6 ||
					residual(shell, later2, e2, nibble, nibble) <= 6;
				if (stale) tally.still_listed_under_stale_dir++;
				else if (relisted) tally.relisted_under_nibble_dir++;
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
	const corpus = require(path.join(ROOT, "tools", "corpus.cjs"));
	let target;
	if (process.argv[2]) {
		target = path.resolve(process.argv[2]);
	} else {
		let root = null;
		try {
			root = corpus.resolve_corpus_root();
		} catch (error) {
			root = null;
		}
		target = root && fs.existsSync(root) ? root : DEFAULT_TARGET;
	}
	let files = collect_files(target);
	let tally = empty_tally();
	let logs = new Map();
	let failed = 0;
	for (let file of files) {
		let recs;
		try {
			recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
		} catch (error) {
			failed++;
			continue;
		}
		measure_file(recs, tally, logs, corpus.replay_label(file));
	}
	let lines = [
		"# GENERATED - fresh tank shells against their 5d nibble; nothing written to disk.",
		`commit\t${repo_commit()}`,
		`files\t${files.length}`,
		`files_failed\t${failed}`,
	];
	for (let [key, value] of Object.entries(tally)) lines.push(`${key}\t${value}`);
	lines.push(`logs_with_one_sector_cases\t${logs.size}`);
	console.log(lines.join("\n"));
}

main();
