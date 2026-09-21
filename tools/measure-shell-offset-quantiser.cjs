#!/usr/bin/env node
/* Re-count the evidence for the shell-list offset quantiser.
 *
 * A shell list gives the head's pixel outright and each later member as
 * two signed bytes of offset from the previous member. The claim under
 * test ([E:shell-offset-quantisation] in FORMAT.notes.md) is that Bolo
 * forms each byte from its own 1/16-pixel internal coordinates,
 *
 *     byte = (next_internal - previous_internal) >> 4
 *
 * with a signed arithmetic shift, rather than by subtracting the two
 * rendered pixels. The recovered pillbox simulation supplies exact
 * internal coordinates for any pill shell whose orbit state (bradian and
 * step) is known, so for every adjacent pair of same-pill list members
 * the matcher resolved to a single state each, the byte pair the rule
 * predicts can be compared with the byte pair actually logged.
 *
 * Three rules are scored side by side, because they agree on most pairs
 * and only the pairs where they part company are evidence:
 *
 *   shift     (d >> 4) on the internal difference       -- the claim
 *   trunc     trunc(d / 16) on the internal difference  -- C division
 *   rendered  (next >> 4) - (previous >> 4)             -- pixel subtraction
 *
 * The viewer normally applies the shift rule itself as a pruning
 * constraint on orbit hypotheses (refine_pillbox_orbits_from_shell_lists
 * in viewer/motion.js), which would make the count circular. The tool
 * builds with that pruning switched off, so every state it conditions on
 * was reached by position, timing and lockstep evidence alone. Pairs the
 * matcher left ambiguous contribute nothing, so this is a floor on the
 * pair count, not on the agreement rate.
 *
 * Usage:
 *   node tools/measure-shell-offset-quantiser.cjs -f <replay> [-f <replay> ...]
 *   node tools/measure-shell-offset-quantiser.cjs [--workers=N] [--show=N] [<directory>]
 *       (no arguments: the whole corpus, via BOLO_CORPUS/corpus.json,
 *       falling back to the committed fixtures when neither is set)
 *
 * --show=N prints up to N pairs the shift rule fails to reproduce
 * (default 20). Multi-file runs fan the builds out over a worker pool;
 * the tallies are additive, so the totals are identical whatever the
 * pool size, though which contradictions are shown may differ.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const BoloMotion = require(path.join(__dirname, "..", "viewer", "motion.js"));
const Orbits = require(path.join(__dirname, "..", "viewer",
	"pillbox_shell_orbits.js"));

const ROOT = path.join(__dirname, "..");
const DEFAULT_TARGET = path.join(ROOT, "fixtures");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;
const RULES = ["shift", "trunc", "rendered"];
const MAX_MEMBER_INDEX = 3;

function empty_tally() {
	let tally = {
		files: 0,
		pairs: 0,
		negative_components: 0,
		agree: Object.fromEntries(RULES.map(rule => [rule, 0])),
		/* pairs by member index (1..3), and the shift rule's agreement on each */
		by_index: Array.from({ length: MAX_MEMBER_INDEX + 1 }, () => ({
			pairs: 0, shift: 0,
		})),
		/* the decisive pairs: where two rules predict different bytes, which
		 * one the log sides with */
		shift_vs_rendered: { pairs: 0, shift: 0, rendered: 0, neither: 0 },
		shift_vs_trunc: { pairs: 0, shift: 0, trunc: 0, neither: 0 },
		contradictions: [],
	};
	return tally;
}

function add_tally(into, from) {
	into.files += from.files;
	into.pairs += from.pairs;
	into.negative_components += from.negative_components;
	for (let rule of RULES) into.agree[rule] += from.agree[rule];
	for (let i = 0; i <= MAX_MEMBER_INDEX; i++) {
		into.by_index[i].pairs += from.by_index[i].pairs;
		into.by_index[i].shift += from.by_index[i].shift;
	}
	for (let key of ["shift_vs_rendered", "shift_vs_trunc"]) {
		for (let field of Object.keys(into[key])) {
			into[key][field] += from[key][field];
		}
	}
	into.contradictions.push(...from.contradictions);
}

function predict(previous_state, next_state) {
	let previous = Orbits.internal_position_at(previous_state.bradian,
		previous_state.step);
	let next = Orbits.internal_position_at(next_state.bradian, next_state.step);
	let dx = next[0] - previous[0];
	let dy = next[1] - previous[1];
	return {
		shift: [dx >> 4, dy >> 4],
		trunc: [Math.trunc(dx / 16), Math.trunc(dy / 16)],
		rendered: [(next[0] >> 4) - (previous[0] >> 4),
			(next[1] >> 4) - (previous[1] >> 4)],
	};
}

function same_bytes(a, b) {
	return a[0] === b[0] && a[1] === b[1];
}

function side(tally_row, logged, first_name, first, second_name, second) {
	if (same_bytes(first, second)) return;
	tally_row.pairs++;
	if (same_bytes(logged, first)) tally_row[first_name]++;
	else if (same_bytes(logged, second)) tally_row[second_name]++;
	else tally_row.neither++;
}

function tally_file(file, tally, show) {
	let game;
	BoloMotion.set_shell_offset_pruning(false);
	try {
		game = BoloGame.build([...BoloLog.records(
			new Uint8Array(fs.readFileSync(file)))]);
	} catch (error) {
		return false;
	} finally {
		BoloMotion.set_shell_offset_pruning(true);
	}
	for (let player = 0; player < 16; player++) {
		for (let snapshot of game.shell_positions[player] || []) {
			let shells = snapshot.shells;
			for (let index = 1; index < shells.length; index++) {
				let next = shells[index];
				let previous = shells[index - 1];
				if (next.shell_list_index === 0 ||
					next.shell_offset_x === undefined ||
					next.shell_list_start !== previous.shell_list_start ||
					next.shell_list_index !== previous.shell_list_index + 1) {
					continue;
				}
				if (previous.pillbox_source_x === undefined ||
					previous.pillbox_source_x !== next.pillbox_source_x ||
					previous.pillbox_source_y !== next.pillbox_source_y) {
					continue;
				}
				let from = previous.pillbox_orbit_states;
				let to = next.pillbox_orbit_states;
				if (!from || from.length !== 1 || !to || to.length !== 1) continue;

				let logged = [next.shell_offset_x, next.shell_offset_y];
				let predicted = predict(from[0], to[0]);
				let member = Math.min(next.shell_list_index, MAX_MEMBER_INDEX);
				tally.pairs++;
				tally.by_index[member].pairs++;
				if (logged[0] < 0) tally.negative_components++;
				if (logged[1] < 0) tally.negative_components++;
				for (let rule of RULES) {
					if (same_bytes(logged, predicted[rule])) tally.agree[rule]++;
				}
				if (same_bytes(logged, predicted.shift)) {
					tally.by_index[member].shift++;
				} else if (tally.contradictions.length < show) {
					tally.contradictions.push({
						file: path.basename(file),
						player,
						time: snapshot.time,
						source: `${previous.pillbox_source_x},${previous.pillbox_source_y}`,
						direction: next.direction,
						member: next.shell_list_index,
						previous: `${from[0].bradian}:${from[0].step}`,
						next: `${to[0].bradian}:${to[0].step}`,
						logged,
						predicted: predicted.shift,
					});
				}
				side(tally.shift_vs_rendered, logged, "shift", predicted.shift,
					"rendered", predicted.rendered);
				side(tally.shift_vs_trunc, logged, "shift", predicted.shift,
					"trunc", predicted.trunc);
			}
		}
	}
	tally.files++;
	return true;
}

function repo_commit() {
	const { execSync } = require("node:child_process");
	let run = command => execSync(command,
		{ cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	try {
		let hash = run("git rev-parse --short HEAD");
		return run("git status --porcelain -uno") ? `${hash}-dirty` : hash;
	} catch {
		return "unknown";
	}
}

function rate(numerator, denominator) {
	return denominator > 0 ? (numerator / denominator).toFixed(6) : "-";
}

function print_report(tally, show) {
	console.log("# GENERATED - shell-list offset quantiser tally; " +
		"nothing written to disk.");
	console.log("# orbit states resolved with the list-offset pruning OFF");
	console.log(`commit\t${repo_commit()}`);
	console.log(`files\t${tally.files}`);
	console.log(`pairs\t${tally.pairs}`);
	console.log(`negative_components\t${tally.negative_components}`);
	for (let rule of RULES) {
		console.log(`agree_${rule}\t${tally.agree[rule]}\t` +
			`${rate(tally.agree[rule], tally.pairs)}`);
	}
	for (let i = 1; i <= MAX_MEMBER_INDEX; i++) {
		let row = tally.by_index[i];
		console.log(`member_${i}${i === MAX_MEMBER_INDEX ? "+" : ""}\t` +
			`pairs ${row.pairs}\tshift ${row.shift}\t${rate(row.shift, row.pairs)}`);
	}
	for (let [key, other] of [["shift_vs_rendered", "rendered"],
		["shift_vs_trunc", "trunc"]]) {
		let row = tally[key];
		console.log(`${key}\tpairs ${row.pairs}\tshift ${row.shift}\t` +
			`${other} ${row[other]}\tneither ${row.neither}`);
	}
	if (tally.contradictions.length) {
		console.log(`# pairs the shift rule does not reproduce ` +
			`(first ${Math.min(show, tally.contradictions.length)}):`);
		console.log("# file\tplayer\ttime\tsource\tdir\tmember\tprevious\tnext\t" +
			"logged\tpredicted");
		for (let c of tally.contradictions.slice(0, show)) {
			console.log([c.file, c.player, c.time, c.source, c.direction, c.member,
				c.previous, c.next, c.logged.join(","), c.predicted.join(",")]
				.join("\t"));
		}
	}
}

function parse_args() {
	let options = { workers: null, show: 20, files: [], root: null };
	let args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		let arg = args[i];
		let match;
		if ((match = arg.match(/^--workers=(\d+)$/))) {
			options.workers = Math.max(1, parseInt(match[1], 10));
		} else if ((match = arg.match(/^--show=(\d+)$/))) {
			options.show = parseInt(match[1], 10);
		} else if (arg === "-f") {
			options.files.push(args[++i]);
		} else {
			options.root = arg;
		}
	}
	return options;
}

function run_worker() {
	parentPort.on("message", ({ file, show }) => {
		let tally = empty_tally();
		let parsed = tally_file(file, tally, show);
		parentPort.postMessage({ file, parsed, tally });
	});
}

function main() {
	let options = parse_args();
	let files = options.files;
	if (!files.length) {
		let root = options.root;
		if (!root) {
			root = require("./corpus.cjs").resolve_corpus_root();
			if (!root || !fs.existsSync(root)) root = DEFAULT_TARGET;
		}
		let walk = directory => {
			for (let name of fs.readdirSync(directory)) {
				let full = path.join(directory, name);
				if (fs.statSync(full).isDirectory()) walk(full);
				else if (!SKIPPED_EXTENSIONS.test(name)) files.push(full);
			}
		};
		walk(root);
	}
	let total = empty_tally();
	let worker_count = Math.min(files.length,
		options.workers || Math.max(1, Math.floor(os.cpus().length / 2)));
	if (worker_count <= 1) {
		for (let file of files) tally_file(file, total, options.show);
		print_report(total, options.show);
		return;
	}
	let queue = files.slice();
	let done = 0;
	let active = 0;
	for (let i = 0; i < worker_count; i++) {
		let worker = new Worker(__filename);
		let dispatch = () => {
			let file = queue.shift();
			if (file === undefined) {
				worker.terminate();
				if (active === 0 && done === files.length) {
					print_report(total, options.show);
				}
				return;
			}
			active++;
			worker.postMessage({ file, show: options.show });
		};
		worker.on("message", result => {
			active--;
			done++;
			add_tally(total, result.tally);
			if (done % 10 === 0) console.error(`progress: ${done}/${files.length}`);
			dispatch();
		});
		worker.on("error", error => {
			console.error(`error: worker failed: ${error.message}`);
			process.exit(1);
		});
		dispatch();
	}
}

if (isMainThread) main();
else run_worker();
