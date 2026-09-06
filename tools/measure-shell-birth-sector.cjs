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
 * LAG. How long before the shot the list's facing was sampled is bounded
 * by the rate: among fresh shells fired in records where the sender's
 * header facing changed, the share listed a sector off is tallied by the
 * record gap and by how many sectors the facing moved. A facing sampled
 * a fixed L ticks before the shot puts the boundary inside that window
 * for about L/gap of the shots, so the share should fall as the gap
 * grows; a facing from the previous packet would hold near 100%.
 *
 * PIN (--pin; runs the viewer's full build per replay, so about three
 * times the cost). Is the fault deterministic? The engine pins most tank
 * shells to an exact bradian, and the tank turns at a known rate, so a
 * shell's bradian distance `e` (0..15) into the NIBBLE's sector from the
 * boundary the turn entered by says how long before the shot the facing
 * crossed. For every fresh shell fired in a record whose header facing
 * moved one sector, with a chain the engine pins to one bradian, the
 * share labelled a sector off is tallied by `e`, split by whether the
 * sender's facing was still changing in its next record (the tank was
 * certainly mid-turn at the shot) and by the record gap (a tank that
 * halted its turn just past a boundary has a facing inside the window
 * but nothing stale to sample, and a longer gap gives it more time to
 * have halted). An always-stale label puts the mid-turn cell near 100%
 * and every `e` beyond the window at zero.
 *
 * Usage:
 *   node tools/measure-shell-birth-sector.cjs [--pin] [replay-or-directory]
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
		turning_fresh: 0,
		turning_one_sector_cases: 0,
		turning_gap_1_4_fresh: 0, turning_gap_1_4_cases: 0,
		turning_gap_5_8_fresh: 0, turning_gap_5_8_cases: 0,
		turning_gap_9_16_fresh: 0, turning_gap_9_16_cases: 0,
		turning_gap_17_up_fresh: 0, turning_gap_17_up_cases: 0,
		turning_by_1_sector_fresh: 0, turning_by_1_sector_cases: 0,
		turning_by_2_sectors_fresh: 0, turning_by_2_sectors_cases: 0,
		turning_by_3_up_fresh: 0, turning_by_3_up_cases: 0,
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

function empty_pin_tally() {
	let cell = () => ({ n: 0, stale: 0 });
	return {
		pin_candidates: 0,
		pin_pinned: 0,
		pin_steady: cell(),
		pin_by_e: Array.from({ length: 16 }, cell),
		pin_turning_e0_1: cell(),
		pin_turning_e2_3: cell(),
		pin_stopped_gap_1_4_e0_1: cell(),
		pin_stopped_gap_5_8_e0_1: cell(),
		pin_stopped_gap_9_up_e0_1: cell(),
		pin_e4_up: cell(),
	};
}

/* The fresh shells of one replay fired in a one-sector turn (or on a
 * steady heading, as a control), for the pin phase. Mirrors the census
 * predicates; bursts are kept off the case side. */
function pin_candidates(recs) {
	let out = [];
	let streams = new Map();
	for (let rec of recs) {
		if (rec.tankStatus === 0x0f) continue;
		let stream = streams.get(rec.player);
		if (!stream) streams.set(rec.player, stream = []);
		stream.push(rec);
	}
	for (let stream of streams.values()) {
		for (let i = 1; i < stream.length; i++) {
			let rec = stream[i], prev = stream[i - 1], next = stream[i + 1] || null;
			let tank = rec.subpackets.find(sub => sub.type === "tank_position");
			if (!tank) continue;
			let nibbles_same = nibbles_of(rec);
			if (!nibbles_same.length) continue;
			let nibbles_adjacent = [...nibbles_of(prev), ...nibbles_of(next)];
			let tx = tank.x * 16 + tank.pixelX, ty = tank.y * 16 + tank.pixelY;
			let back = 2 * Math.max(0, rec.time - prev.time);
			let prev_shells = shells_of(prev);
			let turn = (rec.tankDir - prev.tankDir + 16) % 16;
			let continues = next !== null &&
				((next.tankDir - rec.tankDir + 16) % 16) === turn;
			for (let shell of shells_of(rec)) {
				let dx = shell.px - tx, dy = shell.py - ty;
				let distance = Math.hypot(dx, dy);
				if (distance > MUZZLE || distance === 0) continue;
				let [hx, hy] = heading(shell.direction);
				if ((dx * hx + dy * hy) / distance <= 0.5) continue;
				let was_x = shell.px - hx * back, was_y = shell.py - hy * back;
				if (prev_shells.some(other => other.direction === shell.direction &&
					Math.hypot(other.px - was_x, other.py - was_y) <=
						FRESH_PIXELS + back * FRESH_SLOPE)) continue;
				let exact = nibbles_same.includes(shell.direction);
				if (!exact && nibbles_adjacent.includes(shell.direction)) continue;
				let nibble = exact ? shell.direction
					: nibbles_same.find(n => circular_distance(n, shell.direction) === 1);
				if (nibble === undefined) continue;
				if (!exact && nibbles_same.length > 1) continue;
				out.push({ player: rec.player, time: rec.time, px: shell.px,
					py: shell.py, direction: shell.direction, nibble,
					stale: !exact, turn, continues, gap: rec.time - prev.time });
			}
		}
	}
	return out;
}

function measure_pins(recs, BoloGame, tally) {
	let wanted = pin_candidates(recs);
	if (!wanted.length) return;
	tally.pin_candidates += wanted.length;
	let game = BoloGame.build(recs);
	let index = new Map();
	for (let player = 0; player < game.shell_positions.length; player++) {
		for (let snapshot of game.shell_positions[player] || []) {
			for (let shell of snapshot.shells) {
				let key = `${player}:${snapshot.time}:${shell.pixel_x}:` +
					`${shell.pixel_y}:${shell.direction}`;
				if (!index.has(key)) index.set(key, shell);
			}
		}
	}
	for (let w of wanted) {
		let shell = index.get(`${w.player}:${w.time}:${w.px}:${w.py}:${w.direction}`);
		if (!shell) continue;
		/* the chain's last bradian set; pinned when one bradian survives */
		let node = shell, states = shell.tank_bradian_states, hops = 0;
		while (node.next_shell && hops++ < 10000) {
			node = node.next_shell;
			if (node.tank_bradian_states) states = node.tank_bradian_states;
		}
		if (!states || !states.length) continue;
		let bradians = new Set(states.map(state => state.bradian));
		if (bradians.size !== 1) continue;
		let bradian = [...bradians][0];
		/* 0..15 within the nibble's sector, 0 at its low boundary */
		let q = ((bradian - 16 * w.nibble + 8) % 256 + 256) % 256;
		if (q > 15) continue;
		tally.pin_pinned++;
		let count = (cell) => { cell.n++; if (w.stale) cell.stale++; };
		if (w.turn === 0) { count(tally.pin_steady); continue; }
		if (w.turn !== 1 && w.turn !== 15) continue;
		let e = w.turn === 1 ? q : 15 - q;
		count(tally.pin_by_e[e]);
		if (e >= 4) count(tally.pin_e4_up);
		else if (w.continues) count(e <= 1 ? tally.pin_turning_e0_1 : tally.pin_turning_e2_3);
		else if (e <= 1) {
			count(w.gap <= 4 ? tally.pin_stopped_gap_1_4_e0_1
				: w.gap <= 8 ? tally.pin_stopped_gap_5_8_e0_1
				: tally.pin_stopped_gap_9_up_e0_1);
		}
	}
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
			let turning = rec.tankDir !== prev.tankDir;
			let gap = rec.time - prev.time;
			let turn = circular_distance(rec.tankDir, prev.tankDir);
			let gap_key = gap <= 4 ? "1_4" : gap <= 8 ? "5_8"
				: gap <= 16 ? "9_16" : "17_up";
			let turn_key = turn <= 1 ? "1_sector" : turn === 2 ? "2_sectors"
				: "3_up";
			let count_turning = (is_case) => {
				if (!turning) return;
				tally.turning_fresh++;
				tally[`turning_gap_${gap_key}_fresh`]++;
				tally[`turning_by_${turn_key}_fresh`]++;
				if (!is_case) return;
				tally.turning_one_sector_cases++;
				tally[`turning_gap_${gap_key}_cases`]++;
				tally[`turning_by_${turn_key}_cases`]++;
			};
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
					count_turning(false);
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
					count_turning(false);
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
				count_turning(true);
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
	let args = process.argv.slice(2);
	let pin = args.includes("--pin");
	args = args.filter(arg => arg !== "--pin");
	const BoloGame = pin ? require(path.join(ROOT, "viewer", "game.js")) : null;
	let pin_tally = pin ? empty_pin_tally() : null;
	let target;
	if (args[0]) {
		target = path.resolve(args[0]);
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
		if (pin) measure_pins(recs, BoloGame, pin_tally);
	}
	let lines = [
		"# GENERATED - fresh tank shells against their 5d nibble; nothing written to disk.",
		`commit\t${repo_commit()}`,
		`files\t${files.length}`,
		`files_failed\t${failed}`,
	];
	for (let [key, value] of Object.entries(tally)) lines.push(`${key}\t${value}`);
	lines.push(`logs_with_one_sector_cases\t${logs.size}`);
	if (pin) {
		let cell = (key, value) => lines.push(`${key}_n\t${value.n}`, `${key}_stale\t${value.stale}`);
		lines.push(`pin_candidates\t${pin_tally.pin_candidates}`,
			`pin_pinned\t${pin_tally.pin_pinned}`);
		cell("pin_steady", pin_tally.pin_steady);
		for (let e = 0; e < 16; e++) cell(`pin_e${e}`, pin_tally.pin_by_e[e]);
		for (let key of ["pin_turning_e0_1", "pin_turning_e2_3",
			"pin_stopped_gap_1_4_e0_1", "pin_stopped_gap_5_8_e0_1",
			"pin_stopped_gap_9_up_e0_1", "pin_e4_up"]) {
			cell(key, pin_tally[key]);
		}
	}
	console.log(lines.join("\n"));
}

main();
