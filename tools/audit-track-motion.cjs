#!/usr/bin/env node
/* Audit the DRAWN tank and LGM motion, the way audit-drawn-motion.cjs
 * audits shells.
 *
 * Tank and LGM tracks have no identity problem -- positions are absolute
 * -- so nothing pops; what goes wrong is timing. The renderer lerps
 * between raw track points at their receive stamps, and on a fast token
 * ring those stamps lie by a tick or two against the sender's uniform
 * sampling cadence, so the drawn object oscillates between fractions and
 * multiples of its true speed about ten times a second. The same regime
 * also re-states a moving object's position verbatim (drawn as a hold
 * and a catch-up jump) and lands two points on one recorder tick.
 *
 * Everything the renderer draws between two track points is a straight
 * line, so drawn quality is characterised by consecutive-segment speeds:
 *
 *   - ALTERNATION: consecutive moving segments whose drawn speeds differ
 *     by more than 1.8x -- the wobble a lying stamp produces. A tank does
 *     accelerate, so the floor is not zero; the fixture's ~6% is the
 *     honest baseline, a fast-ring log shows ~35% before smoothing.
 *   - STALE SANDWICH: a zero-displacement segment between two moving
 *     ones -- a moving object drawn frozen for a beat.
 *   - ZERO-DURATION pairs: two points on one stamp (drawn as a snap).
 *
 * Speeds are measured on the smoothed coordinates when present
 * (smooth_pixel_x/y, raw otherwise), so the tool runs unchanged against
 * historical checkouts for calibration; smoothed_points says whether a
 * smoothing pass contributed at all.
 *
 * Usage:
 *   node tools/audit-track-motion.cjs [replay-or-directory]
 *       (no arguments: the whole corpus, via BOLO_CORPUS/corpus.json,
 *       falling back to the committed fixture when neither is set)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DEFAULT_REPLAY = path.join(ROOT, "fixtures", "n20021018.2");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;

const MAX_SEGMENT_TICKS = 25;
const ALTERNATION_RATIO = 1.8;
const MOVING_SPEED = 0.2;

function drawn(point) {
	return [point.smooth_pixel_x ?? point.pixel_x,
		point.smooth_pixel_y ?? point.pixel_y];
}

function empty_kind() {
	return {
		points: 0, smoothed_points: 0, segments: 0, zero_duration_pairs: 0,
		moving_pairs: 0, alternating_pairs: 0, stale_sandwiches: 0,
		speed_change_sum: 0,
	};
}

function audit_tracks(tracks, metrics) {
	for (let track of tracks) {
		let previous_speed = null;
		for (let i = 0; i < track.length; i++) {
			metrics.points++;
			if (track[i].smooth_pixel_x !== undefined) metrics.smoothed_points++;
			if (i === 0) continue;
			let a = track[i - 1], b = track[i];
			if (!b.continuous) { previous_speed = null; continue; }
			let dt = b.time - a.time;
			if (dt === 0) metrics.zero_duration_pairs++;
			if (dt <= 0 || dt > MAX_SEGMENT_TICKS) { previous_speed = null; continue; }
			metrics.segments++;
			let [ax, ay] = drawn(a);
			let [bx, by] = drawn(b);
			let distance = Math.hypot(bx - ax, by - ay);
			let speed = distance / dt;
			if (distance === 0 && i >= 2 && i + 1 < track.length &&
				track[i + 1].continuous) {
				let [px, py] = drawn(track[i - 2]);
				let [nx, ny] = drawn(track[i + 1]);
				if (Math.hypot(ax - px, ay - py) > 0 &&
					Math.hypot(nx - bx, ny - by) > 0) metrics.stale_sandwiches++;
			}
			if (previous_speed !== null && speed > MOVING_SPEED &&
				previous_speed > MOVING_SPEED) {
				metrics.moving_pairs++;
				let ratio = Math.max(speed, previous_speed) /
					Math.min(speed, previous_speed);
				metrics.speed_change_sum += ratio - 1;
				if (ratio > ALTERNATION_RATIO) metrics.alternating_pairs++;
			}
			previous_speed = speed;
		}
	}
}

/* Output provenance and the one-line result digest, duplicated from
 * audit-drawn-motion.cjs like every single-file tool here, so this file
 * stays droppable into historical worktrees for baseline re-runs. */
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

function content_hash_line(lines) {
	const { createHash } = require("node:crypto");
	let stable = lines.filter(line => {
		let key = line.split("\t")[0];
		return key !== "commit" && key !== "input" &&
			key !== "content_hash" && !key.endsWith("_ms");
	});
	return `content_hash\t${createHash("sha256")
		.update(`${stable.join("\n")}\n`).digest("hex")}`;
}

function hash_input(target) {
	const { createHash } = require("node:crypto");
	return `sha256:${createHash("sha256")
		.update(path.resolve(target)).digest("hex")}`;
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

function main() {
	const BoloLog = require(path.join(ROOT, "viewer", "logparse.js"));
	const BoloGame = require(path.join(ROOT, "viewer", "game.js"));
	let target;
	if (process.argv[2]) {
		target = path.resolve(process.argv[2]);
	} else {
		/* Bare invocation reads the whole corpus, the way the other audit
		 * tools do; without a configured corpus, the committed fixture. */
		let corpus = null;
		try {
			corpus = require(path.join(ROOT, "tools", "corpus.cjs"))
				.resolve_corpus_root();
		} catch (error) {
			corpus = null;
		}
		target = corpus && fs.existsSync(corpus) ? corpus : DEFAULT_REPLAY;
	}
	let files = collect_files(target);
	let kinds = { tank: empty_kind(), lgm: empty_kind() };
	let failed = 0;
	for (let file of files) {
		let game;
		try {
			game = BoloGame.build([...BoloLog.records(
				new Uint8Array(fs.readFileSync(file)))]);
		} catch (error) {
			failed++;
			continue;
		}
		audit_tracks(game.tank_positions || [], kinds.tank);
		audit_tracks(game.lgm_positions || [], kinds.lgm);
	}
	let lines = [
		"# GENERATED - drawn track motion audit; nothing written to disk.",
		`commit\t${repo_commit()}`,
		`input\t${hash_input(target)}`,
		`files\t${files.length}`,
		`files_failed\t${failed}`,
	];
	for (let [kind, m] of Object.entries(kinds)) {
		lines.push(`${kind}_points\t${m.points}`);
		lines.push(`${kind}_smoothed_points\t${m.smoothed_points}`);
		lines.push(`${kind}_segments\t${m.segments}`);
		lines.push(`${kind}_zero_duration_pairs\t${m.zero_duration_pairs}`);
		lines.push(`${kind}_stale_sandwiches\t${m.stale_sandwiches}`);
		lines.push(`${kind}_moving_pairs\t${m.moving_pairs}`);
		lines.push(`${kind}_alternating_pairs\t${m.alternating_pairs}`);
		lines.push(`rate_${kind}_alternation\t${m.moving_pairs
			? (m.alternating_pairs / m.moving_pairs).toFixed(6) : "0"}`);
		lines.push(`${kind}_mean_speed_change\t${m.moving_pairs
			? (m.speed_change_sum / m.moving_pairs).toFixed(6) : "0"}`);
	}
	lines.push(content_hash_line(lines));
	console.log(lines.join("\n"));
}

main();
