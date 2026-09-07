#!/usr/bin/env node
/* Do the pills of one sender advance in lockstep with each other?
 *
 * The roster vote (build_pill_lockstep_reference and the matcher's
 * enforce_roster_lockstep_candidates in viewer/motion.js) elects one
 * orbit-step advance per PILL per sender record pair, and a pill with
 * fewer than three step-pinned shells in flight can never vote. But a
 * record's lists are one sampling instant ([E:shell-list-skew]), and
 * the sender moves every shell it simulates one step in the same update
 * pass, so the advance ought to be a property of the sender transition
 * rather than of the pill. If it is, a well-constrained pill could lend
 * its advance to a sparse one, and the votes of all a sender's pills
 * could be pooled. This tool measures whether it is ([E:sender-lockstep]),
 * reading the per-pill elections off final state under the vote's own
 * gates; nothing is changed. Acting on it was tried and reverted: the
 * corpus results file has the account.
 *
 * For each sender record pair carrying a pinned roster at both ends:
 *
 *   -- INDEPENDENT AGREEMENT: where two or more pills each pass their
 *      own election, do they elect the same advance? Every
 *      disagreement is printed as a scene, since it is either the
 *      invariant failing or a mislink to open.
 *   -- SPARSE LANDINGS: where one pill elected and another of the same
 *      sender could not (too few pinned sources, or a vote inside the
 *      margin), does each pinned source of the sparse pill land exactly
 *      on a pinned target at the elected advance? Sources close enough
 *      to orbit expiry to die over the pair are excluded, as in
 *      measure-shell-list-staleness. The control beside it is how many
 *      of those sources some OTHER advance in the window could land, so
 *      the landing rate can be read against chance.
 *   -- POOLED ELECTIONS: the per-advance scores summed over all the
 *      sender's pills, under the same score and margin gates: how many
 *      more pairs elect than any single pill could, and whether the
 *      pooled winner ever contradicts a per-pill winner.
 *
 * Usage:
 *   node tools/measure-cross-pill-agreement.cjs -f <replay>
 *   node tools/measure-cross-pill-agreement.cjs [--workers=N] [<directory>]
 *       (no arguments: the whole corpus, via BOLO_CORPUS/corpus.json)
 *
 * Multi-file runs fan the builds out over a worker pool (default half
 * the machine's cores); the counters are additive, so the output is
 * identical whatever the pool size, apart from the order of the scenes.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");
const { replay_label } = require("./corpus.cjs");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const Orbits = require(path.join(__dirname, "..", "viewer",
	"pillbox_shell_orbits.js"));

/* The vote's own gates and window, copied rather than imported so the
 * tool measures what the engine does today even if the engine moves. */
const LOCKSTEP_REFERENCE_MIN_SCORE = 3;
const LOCKSTEP_REFERENCE_MIN_MARGIN = 2;
const TICKS_PER_SHELL_UPDATE = 2;
const DILATED_UPDATE_SLACK = 8;

const ORBIT_LENGTH = new Map(Orbits.orbits.map(orbit =>
	[orbit.bradian, orbit.positions.length]));
const EXPIRY_SLACK_STEPS = 8;
const MAX_SCENES = 40;

const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;

const COUNTER_KEYS = [
	"pairs", "pairs_multi_pill",
	"pill_elections", "pairs_two_elect", "pairs_two_agree", "pairs_two_disagree",
	"sparse_rosters", "sparse_sources", "sparse_landing", "sparse_landing_other",
	"pooled_elections", "pooled_only", "pooled_agree", "pooled_disagree",
];

let counters = new Map();
let advance_histogram = new Map();
let scenes = [];

function reset() {
	counters = new Map(COUNTER_KEYS.map(key => [key, 0]));
	advance_histogram = new Map();
	scenes = [];
}
function count(key, n = 1) {
	counters.set(key, counters.get(key) + n);
}

function pinned_orbit_step(states) {
	if (!states || !states.length) return null;
	let step = states[0].step;
	for (let state of states) {
		if (state.step !== step) return null;
	}
	return step;
}

/* The pinned steps of each pill's shells in one snapshot, with the
 * bradian kept beside each step for the expiry test. */
function roster(snapshot, include) {
	let by_pill = new Map();
	for (let shell of snapshot.shells) {
		if (shell.pillbox_source_x === undefined || !include(shell)) continue;
		let step = pinned_orbit_step(shell.pillbox_orbit_states);
		if (step === null) continue;
		let key = `${shell.pillbox_source_x}:${shell.pillbox_source_y}`;
		let members = by_pill.get(key);
		if (!members) by_pill.set(key, members = new Map());
		members.set(step, shell.pillbox_orbit_states[0].bradian);
	}
	return by_pill;
}

function elect(scores) {
	let best = null, best_score = 0, runner_up = 0;
	for (let [advance, score] of scores) {
		if (score > best_score) {
			runner_up = best_score;
			best_score = score;
			best = advance;
		} else if (score > runner_up) {
			runner_up = score;
		}
	}
	let passed = best_score >= LOCKSTEP_REFERENCE_MIN_SCORE &&
		best_score >= runner_up + LOCKSTEP_REFERENCE_MIN_MARGIN;
	return { best, best_score, runner_up, passed };
}

function sorted_steps(members) {
	return [...members.keys()].sort((a, b) => a - b).join(",");
}

function tally_pair(file, player, a, b) {
	let sources = roster(a, shell => !shell.next_terminal);
	let targets = roster(b, shell => !shell.starts_at_pillbox &&
		!shell.starts_at_tank);
	let pills = [...sources.keys()].filter(pill => targets.has(pill));
	if (!pills.length) return;
	count("pairs");
	if (pills.length >= 2) count("pairs_multi_pill");
	let duration = b.time - a.time;
	let max_advance = Math.ceil(duration / TICKS_PER_SHELL_UPDATE) +
		DILATED_UPDATE_SLACK;
	let per_pill = new Map();
	let pooled = new Map();
	for (let pill of pills) {
		let steps_a = sources.get(pill), steps_b = targets.get(pill);
		let scores = new Map();
		for (let advance = 1; advance <= max_advance; advance++) {
			let score = 0;
			for (let step of steps_a.keys()) {
				if (steps_b.has(step + advance)) score++;
			}
			scores.set(advance, score);
			pooled.set(advance, (pooled.get(advance) || 0) + score);
		}
		let election = elect(scores);
		/* The engine's vote also wants three pinned sources before it
		 * scores at all; a score of three implies that, so the gate is
		 * the same one. */
		election.steps_a = steps_a;
		election.steps_b = steps_b;
		per_pill.set(pill, election);
	}
	let passed = [...per_pill.entries()].filter(([, e]) => e.passed);
	count("pill_elections", passed.length);
	for (let [, e] of passed) {
		advance_histogram.set(e.best, (advance_histogram.get(e.best) || 0) + 1);
	}
	if (passed.length >= 2) {
		count("pairs_two_elect");
		let advances = new Set(passed.map(([, e]) => e.best));
		if (advances.size === 1) {
			count("pairs_two_agree");
		} else {
			count("pairs_two_disagree");
			if (scenes.length < MAX_SCENES) {
				scenes.push({
					replay: replay_label(file), player, time: a.time,
					next_time: b.time,
					pills: passed.map(([pill, e]) => `pill ${pill} advance ${e.best} ` +
						`(${e.best_score} v ${e.runner_up}) ` +
						`sources [${sorted_steps(e.steps_a)}] ` +
						`landings [${sorted_steps(e.steps_b)}]`),
				});
			}
		}
	}
	if (passed.length >= 1) {
		let advance = passed[0][1].best;
		for (let [, e] of per_pill) {
			if (e.passed) continue;
			count("sparse_rosters");
			for (let [step, bradian] of e.steps_a) {
				if (step + Math.ceil(duration / TICKS_PER_SHELL_UPDATE) +
					EXPIRY_SLACK_STEPS >= ORBIT_LENGTH.get(bradian)) continue;
				count("sparse_sources");
				if (e.steps_b.has(step + advance)) count("sparse_landing");
				let other = false;
				for (let x = 1; x <= max_advance && !other; x++) {
					if (x !== advance && e.steps_b.has(step + x)) other = true;
				}
				if (other) count("sparse_landing_other");
			}
		}
	}
	let pooled_election = elect(pooled);
	if (pooled_election.passed) {
		count("pooled_elections");
		if (!passed.length) count("pooled_only");
		else if (passed.every(([, e]) => e.best === pooled_election.best)) {
			count("pooled_agree");
		} else {
			count("pooled_disagree");
		}
	}
}

function tally(file) {
	let game;
	try {
		game = BoloGame.build([...BoloLog.records(
			new Uint8Array(fs.readFileSync(file)))]);
	} catch (error) {
		return false;
	}
	for (let player = 0; player < 16; player++) {
		let snapshots = game.shell_positions[player];
		if (!snapshots) continue;
		for (let i = 0; i + 1 < snapshots.length; i++) {
			tally_pair(file, player, snapshots[i], snapshots[i + 1]);
		}
	}
	return true;
}

function rate(numerator, denominator) {
	return denominator > 0 ? (numerator / denominator).toFixed(6) : "-";
}

function print_report(parsed) {
	console.log("# GENERATED - cross-pill lockstep agreement tally; nothing written to disk.");
	console.log(`files\t${parsed}`);
	for (let key of COUNTER_KEYS) console.log(`${key}\t${counters.get(key)}`);
	let c = key => counters.get(key);
	console.log(`rate_two_agree\t${rate(c("pairs_two_agree"), c("pairs_two_elect"))}`);
	console.log(`rate_sparse_landing\t${rate(c("sparse_landing"), c("sparse_sources"))}`);
	console.log(`rate_sparse_landing_other\t${rate(c("sparse_landing_other"), c("sparse_sources"))}`);
	console.log(`rate_pooled_gain\t${rate(c("pooled_only"), c("pill_elections"))}`);
	let histogram = [...advance_histogram.entries()].sort((a, b) => a[0] - b[0])
		.map(([advance, n]) => `${advance}:${n}`).join(" ");
	console.log(`elected_advances\t${histogram}`);
	if (scenes.length) {
		console.log(`\n# disagreements (first ${MAX_SCENES}):`);
		for (let scene of scenes) {
			console.log(`${scene.replay}  player ${scene.player}  ` +
				`ticks ${scene.time} -> ${scene.next_time}`);
			for (let line of scene.pills) console.log(`    ${line}`);
		}
	}
}

function merge(result) {
	for (let [key, n] of result.counters) count(key, n);
	for (let [advance, n] of result.advance_histogram) {
		advance_histogram.set(advance, (advance_histogram.get(advance) || 0) + n);
	}
	for (let scene of result.scenes) {
		if (scenes.length < MAX_SCENES) scenes.push(scene);
	}
}

function run_worker() {
	parentPort.on("message", file => {
		reset();
		let parsed = tally(file);
		parentPort.postMessage({ file, parsed, counters: [...counters],
			advance_histogram: [...advance_histogram], scenes });
	});
}

function main() {
	reset();
	let worker_option = null;
	let args = process.argv.slice(2).filter(arg => {
		let match = arg.match(/^--workers=(\d+)$/);
		if (match) {
			worker_option = Math.max(1, parseInt(match[1], 10));
			return false;
		}
		return true;
	});
	let files = [];
	if (args[0] === "-f") {
		files = [args[1]];
	} else {
		let root = args[0] || require("./corpus.cjs").corpus_root();
		let walk = directory => {
			for (let name of fs.readdirSync(directory).sort()) {
				let full = path.join(directory, name);
				if (fs.statSync(full).isDirectory()) walk(full);
				else if (!SKIPPED_EXTENSIONS.test(name)) files.push(full);
			}
		};
		walk(root);
	}
	let parsed = 0;
	let worker_count = Math.min(files.length,
		worker_option || Math.max(1, Math.floor(os.cpus().length / 2)));
	if (worker_count <= 1) {
		for (let file of files) if (tally(file)) parsed++;
		print_report(parsed);
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
				if (active === 0 && done === files.length) print_report(parsed);
				return;
			}
			active++;
			worker.postMessage(file);
		};
		worker.on("message", result => {
			active--;
			done++;
			if (result.parsed) parsed++;
			merge(result);
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
