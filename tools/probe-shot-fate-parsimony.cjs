#!/usr/bin/env node
/* Feasibility probe for issue #15's global shot-fate parsimony.
 *
 * The proposal: assign every shot-creation event (5d tank fire, F4 pill
 * fire) to a shot-ending event (FB fall, FC tank hit, 9n pill damage,
 * An base damage, attributable 7T explosion) over the whole file. The
 * worry: cost. This probe does NOT solve the assignment; it builds the
 * residual candidate graph the solver would face and measures its shape:
 *
 *   - residual creations: shots the matcher never tied to a shell chain
 *   - residual chains: matched shell chains missing an origin, a fate,
 *     or both (a vanished chain still needs its fate assigned; an
 *     unknown-origin chain still needs its creation)
 *   - residual fates: terminals no shell was found to explain
 *
 * Edges are hard-constraint pruned (time window, range, direction cone)
 * and deliberately permissive: an over-approximated graph over-states
 * the solver's cost, so the feasibility verdict is conservative. The
 * output is the connected-component histogram — the real solver runs
 * per component — plus timing for the probe pass itself.
 *
 * Usage:
 *   node tools/probe-shot-fate-parsimony.cjs [replay-or-directory]
 *       [--workers=N] [--max-files=N]
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { replay_label } = require("./corpus.cjs");
const { Worker, isMainThread, parentPort } = require("node:worker_threads");

const ROOT = path.join(__dirname, "..");
const DEFAULT_REPLAY = path.join(ROOT, "fixtures", "n20021018.2");
const SKIPPED_EXTENSIONS = /\.(txt|md|json|zip|sit|hqx|png|jpg|gif|bmp|py)$/i;

/* Shell range is 8.5 tiles (136px); impact records can trail the impact,
 * and pairing across the maximum flight plus that lag must stay possible. */
const SHELL_RANGE_PIXELS = 136;
const MAX_PAIR_TICKS = 100;
const DISTANCE_TOLERANCE_PIXELS = 24;
const SPEED_PIXELS_PER_TICK = 2;
/* The direction nibble's corpus-measured bradian gate spans about +-17
 * degrees; box-sized fates add their own angular slack with distance. */
const CONE_HALF_ANGLE = 17 * Math.PI / 180;
const BOX_SLACK_PIXELS = 12;
const CONSUME_WINDOW_TICKS = 60;

/* ---- chain extraction (same linking as measure-tank-shell-bradians) -- */

function extract_chains(game_result) {
	let chains = [];
	let players = game_result.shell_positions || [];
	for (let player = 0; player < players.length; player++) {
		let snapshots = players[player];
		if (!Array.isArray(snapshots)) continue;
		let previous = null;
		let previous_chain_of = null;
		for (let index = 0; index < snapshots.length; index++) {
			let snapshot = snapshots[index];
			let chain_of = new Map();
			if (previous) {
				let claimed = new Set();
				for (let i = 0; i < previous.shells.length; i++) {
					let old_shell = previous.shells[i];
					if (old_shell.next_time === undefined || old_shell.next_terminal ||
						old_shell.next_time !== snapshot.time) continue;
					let chain = previous_chain_of.get(i);
					if (!chain) continue;
					for (let j = 0; j < snapshot.shells.length; j++) {
						if (claimed.has(j)) continue;
						let shell = snapshot.shells[j];
						if (!shell.matched_from_previous ||
							shell.direction !== old_shell.direction) continue;
						let candidates = [
							[shell.pixel_x, shell.pixel_y],
							[shell.tank_exact_pixel_x, shell.tank_exact_pixel_y],
							[shell.pillbox_orbit_pixel_x, shell.pillbox_orbit_pixel_y],
						];
						if (!candidates.some(([x, y]) => x !== undefined &&
							x === old_shell.next_pixel_x &&
							y === old_shell.next_pixel_y)) continue;
						claimed.add(j);
						chain.last = shell;
						chain.end_time = snapshot.time;
						chain.final_snapshot = index === snapshots.length - 1;
						chain_of.set(j, chain);
						break;
					}
				}
			}
			for (let j = 0; j < snapshot.shells.length; j++) {
				if (chain_of.has(j)) continue;
				let shell = snapshot.shells[j];
				let chain = {
					player,
					direction: shell.direction,
					head: shell,
					last: shell,
					start_time: snapshot.time,
					end_time: snapshot.time,
					final_snapshot: index === snapshots.length - 1,
				};
				chains.push(chain);
				chain_of.set(j, chain);
			}
			previous = snapshot;
			previous_chain_of = chain_of;
		}
	}
	return chains;
}

/* ---- creations ------------------------------------------------------- */

/* Pill positions are replayed just enough to place F4 events: the seed
 * list, pickups, and plants. Repairs and damage do not move pills. */
function collect_creations(game_result, BoloMotion) {
	let creations = [];
	let pills = (game_result.keyframes[0].state.pills || [])
		.map(pill => ({ x: pill.x, y: pill.y, inTank: pill.inTank }));
	let lowest_carried = player => {
		for (let i = 0; i < pills.length; i++) {
			if (pills[i].inTank === player) return pills[i];
		}
		return null;
	};

	for (let rec of game_result.records) {
		for (let sub of rec.subpackets) {
			if (sub.type === "pillbox_list") {
				pills = sub.items.map(item =>
					({ x: item.x, y: item.y, inTank: null }));
			} else if (sub.type === "pill_pickup") {
				let pill = pills[sub.pillbox];
				if (pill) pill.inTank = rec.player;
			} else if (sub.type === "pill_plant" ||
				sub.type === "pill_dumped_by_dead_lgm") {
				let pill = lowest_carried(rec.player);
				if (pill) {
					pill.inTank = null;
					pill.x = sub.x;
					pill.y = sub.y;
				}
			} else if (sub.type === "pillbox_fires") {
				let pill = pills[sub.pillbox];
				let alternate = sub.direction === 0 && sub.pillbox > 0
					? pills[sub.pillbox - 1] : null;
				let source = pill && pill.inTank === null ? pill
					: alternate && alternate.inTank === null ? alternate : null;
				if (!source) continue;
				creations.push({
					kind: "pill", time: rec.time, direction: sub.direction,
					pixel_x: source.x * 16, pixel_y: source.y * 16,
					player: rec.player,
				});
			} else if (sub.type === "shot_fired") {
				let track = game_result.tank_positions[rec.player];
				let position = BoloMotion.track_pixel_at(track, rec.time);
				if (!position) continue;
				creations.push({
					kind: "tank", time: rec.time, direction: sub.direction,
					pixel_x: position.pixel_x, pixel_y: position.pixel_y,
					player: rec.player,
				});
			}
		}
	}
	return creations;
}

/* Chains and unseen-source terminals consumed creations inside the
 * matcher; replay that consumption greedily so the residue is what the
 * matcher genuinely left unexplained. Tank births live in the firer's own
 * restatements; pill shells ride in whichever machine simulates the pill,
 * so pill consumption ignores player. */
function consume_creations(creations, chains, terminals) {
	let free = creations.map(() => true);
	let pools = new Map();
	for (let i = 0; i < creations.length; i++) {
		let creation = creations[i];
		let key = `${creation.kind}:${creation.direction}`;
		if (!pools.has(key)) pools.set(key, []);
		pools.get(key).push(i);
	}
	/* Creations were collected in record order, so pools stay time-sorted. */
	let claim = (kind, direction, time, filter) => {
		let pool = pools.get(`${kind}:${direction}`);
		if (!pool) return false;
		let lo = 0, hi = pool.length;
		while (lo < hi) {
			let mid = (lo + hi) >> 1;
			if (creations[pool[mid]].time < time - CONSUME_WINDOW_TICKS) lo = mid + 1;
			else hi = mid;
		}
		let best = -1, best_gap = Infinity;
		for (let k = lo; k < pool.length; k++) {
			let i = pool[k];
			let creation = creations[i];
			if (creation.time > time + CONSUME_WINDOW_TICKS) break;
			if (!free[i]) continue;
			let gap = Math.abs(creation.time - time);
			if (gap >= best_gap || !filter(creation)) continue;
			best = i;
			best_gap = gap;
		}
		if (best >= 0) free[best] = false;
		return best >= 0;
	};

	for (let chain of chains) {
		let head = chain.head;
		if (head.starts_at_tank) {
			chain.has_origin = claim("tank", chain.direction,
				head.birth_time ?? chain.start_time,
				creation => creation.player === chain.player);
		} else if (head.starts_at_pillbox ||
			head.pillbox_source_x !== undefined) {
			/* The first sighting lags the F4 by the flight so far. */
			let fire_time = chain.start_time -
				(head.pillbox_source_distance || 0) / SPEED_PIXELS_PER_TICK;
			chain.has_origin = claim("pill", chain.direction, fire_time,
				creation => creation.pixel_x === head.pillbox_source_x &&
					creation.pixel_y === head.pillbox_source_y);
		} else {
			chain.has_origin = false;
		}
	}
	for (let terminal of terminals) {
		if (!terminal.unseen_pillbox_source) continue;
		claim("pill", terminal.pillbox_source_direction, terminal.record.time,
			creation => creation.pixel_x === terminal.pillbox_source_x &&
				creation.pixel_y === terminal.pillbox_source_y);
	}
	return creations.filter((_, i) => free[i]);
}

/* ---- edge tests ------------------------------------------------------ */

function fate_point(terminal) {
	if (terminal.type === "point") {
		return [terminal.pixel_x + 8, terminal.pixel_y + 8, 2];
	}
	return [(terminal.min_x + terminal.max_x) / 2,
		(terminal.min_y + terminal.max_y) / 2, BOX_SLACK_PIXELS];
}

function within_cone(direction, delta_x, delta_y, distance, slack_pixels) {
	if (distance <= slack_pixels) return true;
	let angle = direction * Math.PI / 8;
	let forward = delta_x * Math.sin(angle) - delta_y * Math.cos(angle);
	if (forward <= 0) return false;
	let lateral = Math.abs(delta_x * Math.cos(angle) + delta_y * Math.sin(angle));
	return Math.atan2(lateral, forward) <=
		CONE_HALF_ANGLE + Math.atan2(slack_pixels, distance);
}

function reaches(pixel_x, pixel_y, direction, start_time, terminal) {
	let dt = terminal.record.time - start_time;
	if (dt <= 0 || dt > MAX_PAIR_TICKS) return false;
	if (terminal.direction !== null && terminal.direction !== undefined &&
		terminal.direction !== direction) return false;
	let [target_x, target_y, slack] = fate_point(terminal);
	let delta_x = target_x - (pixel_x + 8);
	let delta_y = target_y - (pixel_y + 8);
	let distance = Math.hypot(delta_x, delta_y);
	let reach = Math.min(dt * SPEED_PIXELS_PER_TICK, SHELL_RANGE_PIXELS) +
		DISTANCE_TOLERANCE_PIXELS + slack;
	if (distance > reach) return false;
	return within_cone(direction, delta_x, delta_y, distance, slack + 8);
}

function feeds_chain(creation, chain) {
	let dt = chain.start_time - creation.time;
	if (dt < 0 || dt > MAX_PAIR_TICKS) return false;
	if (creation.direction !== chain.direction) return false;
	let delta_x = chain.head.pixel_x - creation.pixel_x;
	let delta_y = chain.head.pixel_y - creation.pixel_y;
	let distance = Math.hypot(delta_x, delta_y);
	if (distance > dt * SPEED_PIXELS_PER_TICK + DISTANCE_TOLERANCE_PIXELS ||
		distance > SHELL_RANGE_PIXELS + DISTANCE_TOLERANCE_PIXELS) return false;
	return within_cone(creation.direction, delta_x, delta_y, distance, 20);
}

/* ---- component analysis ---------------------------------------------- */

function find_root(parents, node) {
	while (parents[node] !== node) {
		parents[node] = parents[parents[node]];
		node = parents[node];
	}
	return node;
}

function analyze_file(file, engines, metrics) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let build_start = Date.now();
	let records = [...engines.log.records(bytes)];
	let game_result = engines.game.build(records);
	metrics.build_ms += Date.now() - build_start;
	let probe_start = Date.now();

	let chains = extract_chains(game_result);
	let terminals = [];
	for (let snapshots of game_result.shell_positions) {
		for (let snapshot of snapshots) {
			for (let terminal of snapshot.terminals) terminals.push(terminal);
		}
	}
	let creations = collect_creations(game_result, engines.motion);
	metrics.creations_tank += creations.filter(c => c.kind === "tank").length;
	metrics.creations_pill += creations.filter(c => c.kind === "pill").length;
	let residual_creations = consume_creations(creations, chains, terminals);

	/* A chain ending in a matched terminal has its fate; a chain reaching
	 * its client's final snapshot is censored, not unexplained. */
	let residual_chains = chains.filter(chain => {
		chain.needs_fate = chain.last.next_time === undefined &&
			!chain.final_snapshot;
		return chain.needs_fate || !chain.has_origin;
	});
	let residual_fates = terminals.filter(terminal =>
		terminal.match_time === undefined && !terminal.unseen_pillbox_source &&
		!terminal.unseen_tank_source);

	metrics.files_creations_residual += residual_creations.length;
	metrics.chains_total += chains.length;
	metrics.chains_residual += residual_chains.length;
	metrics.chains_missing_origin +=
		residual_chains.filter(chain => !chain.has_origin).length;
	metrics.chains_missing_fate +=
		residual_chains.filter(chain => chain.needs_fate).length;
	metrics.fates_residual += residual_fates.length;
	for (let terminal of residual_fates) {
		let key = terminal.event_type || "unknown";
		metrics.fates_by_type[key] = (metrics.fates_by_type[key] || 0) + 1;
	}

	/* Nodes: creations, then chains, then fates. */
	let creation_base = 0;
	let chain_base = residual_creations.length;
	let fate_base = chain_base + residual_chains.length;
	let node_count = fate_base + residual_fates.length;
	let parents = Array.from({ length: node_count }, (_, i) => i);
	let edge_count = Array.from({ length: node_count }, () => 0);
	let unite = (a, b) => {
		edge_count[a]++;
		edge_count[b]++;
		let root_a = find_root(parents, a), root_b = find_root(parents, b);
		if (root_a !== root_b) parents[root_a] = root_b;
	};

	/* Sort fates by time for windowed scans. */
	let fates_sorted = residual_fates.map((terminal, i) => ({ terminal, i }))
		.sort((a, b) => a.terminal.record.time - b.terminal.record.time);
	let fate_times = fates_sorted.map(entry => entry.terminal.record.time);
	let first_fate_after = time => {
		let lo = 0, hi = fate_times.length;
		while (lo < hi) {
			let mid = (lo + hi) >> 1;
			if (fate_times[mid] < time) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};

	let edges = { creation_fate: 0, creation_chain: 0, chain_fate: 0, chain_chain: 0 };
	for (let i = 0; i < residual_creations.length; i++) {
		let creation = residual_creations[i];
		for (let k = first_fate_after(creation.time);
			k < fates_sorted.length &&
			fate_times[k] <= creation.time + MAX_PAIR_TICKS; k++) {
			if (reaches(creation.pixel_x, creation.pixel_y, creation.direction,
				creation.time, fates_sorted[k].terminal)) {
				edges.creation_fate++;
				unite(creation_base + i, fate_base + fates_sorted[k].i);
			}
		}
		for (let j = 0; j < residual_chains.length; j++) {
			let chain = residual_chains[j];
			if (!chain.has_origin && feeds_chain(creation, chain)) {
				edges.creation_chain++;
				unite(creation_base + i, chain_base + j);
			}
		}
	}
	for (let j = 0; j < residual_chains.length; j++) {
		let chain = residual_chains[j];
		if (!chain.needs_fate) continue;
		let last = chain.last;
		let pixel_x = last.pillbox_orbit_pixel_x ?? last.tank_exact_pixel_x ??
			last.pixel_x;
		let pixel_y = last.pillbox_orbit_pixel_y ?? last.tank_exact_pixel_y ??
			last.pixel_y;
		for (let k = first_fate_after(chain.end_time);
			k < fates_sorted.length &&
			fate_times[k] <= chain.end_time + MAX_PAIR_TICKS; k++) {
			if (reaches(pixel_x, pixel_y, chain.direction, chain.end_time,
				fates_sorted[k].terminal)) {
				edges.chain_fate++;
				unite(chain_base + j, fate_base + fates_sorted[k].i);
			}
		}
		/* "Migration continuation", kept as a control: the hypothesis that a
		 * shell's simulation moved to another machine, vanishing from one
		 * client's restatements and appearing mid-flight and originless in
		 * another's. The idea is regarded as highly suspicious (Bolo has no
		 * orchestration for it, and the corpus has never needed it); this
		 * edge class exists to keep measuring how rarely the geometry even
		 * admits it. Restatement timing interleaves, so the new stream can
		 * begin before or after the old one's last record; project the
		 * candidate's head along its flight to the vanished chain's end time
		 * and compare positions there. */
		for (let m = 0; m < residual_chains.length; m++) {
			let next_chain = residual_chains[m];
			if (m === j || next_chain.has_origin ||
				next_chain.direction !== chain.direction) continue;
			let dt = next_chain.start_time - chain.end_time;
			if (dt < -50 || dt > MAX_PAIR_TICKS) continue;
			let heading_x = next_chain.head.heading_x;
			let heading_y = next_chain.head.heading_y;
			if (heading_x === undefined) {
				let angle = next_chain.direction * Math.PI / 8;
				heading_x = Math.sin(angle);
				heading_y = -Math.cos(angle);
			}
			let travel = dt * SPEED_PIXELS_PER_TICK;
			let delta_x = next_chain.head.pixel_x - heading_x * travel - pixel_x;
			let delta_y = next_chain.head.pixel_y - heading_y * travel - pixel_y;
			if (Math.hypot(delta_x, delta_y) >
				DISTANCE_TOLERANCE_PIXELS * 2) continue;
			edges.chain_chain++;
			unite(chain_base + j, chain_base + m);
		}
	}
	metrics.edges_creation_fate += edges.creation_fate;
	metrics.edges_creation_chain += edges.creation_chain;
	metrics.edges_chain_fate += edges.chain_fate;
	metrics.edges_chain_chain += edges.chain_chain;

	/* Component histogram. */
	let members = new Map();
	for (let node = 0; node < node_count; node++) {
		let root = find_root(parents, node);
		if (!members.has(root)) members.set(root, []);
		members.get(root).push(node);
	}
	for (let component of members.values()) {
		let nodes = component.length;
		let component_edges = component.reduce(
			(total, node) => total + edge_count[node], 0) / 2;
		if (nodes === 1) {
			let node = component[0];
			let kind = node < chain_base ? "creation"
				: node < fate_base ? "chain" : "fate";
			metrics[`orphan_${kind}s`]++;
			continue;
		}
		metrics.components++;
		let bucket = nodes <= 2 ? "2" : nodes <= 5 ? "3-5" : nodes <= 10 ? "6-10"
			: nodes <= 20 ? "11-20" : nodes <= 50 ? "21-50"
			: nodes <= 100 ? "51-100" : "100+";
		metrics.component_sizes[bucket] =
			(metrics.component_sizes[bucket] || 0) + 1;
		if (metrics.largest.length < 5 ||
			nodes > metrics.largest[metrics.largest.length - 1].nodes) {
			metrics.largest.push({
				nodes, edges: component_edges, file: replay_label(file),
			});
			metrics.largest.sort((a, b) => b.nodes - a.nodes);
			metrics.largest = metrics.largest.slice(0, 5);
		}
	}
	metrics.probe_ms += Date.now() - probe_start;
}

/* ---- orchestration --------------------------------------------------- */

function empty_metrics() {
	return {
		files: 0,
		files_failed: 0,
		build_ms: 0,
		probe_ms: 0,
		creations_tank: 0,
		creations_pill: 0,
		files_creations_residual: 0,
		chains_total: 0,
		chains_residual: 0,
		chains_missing_origin: 0,
		chains_missing_fate: 0,
		fates_residual: 0,
		fates_by_type: {},
		edges_creation_fate: 0,
		edges_chain_chain: 0,
		edges_creation_chain: 0,
		edges_chain_fate: 0,
		components: 0,
		component_sizes: {},
		orphan_creations: 0,
		orphan_chains: 0,
		orphan_fates: 0,
		largest: [],
	};
}

function merge_metrics(target, source) {
	for (let [key, value] of Object.entries(source)) {
		if (typeof value === "number") {
			target[key] += value;
		} else if (Array.isArray(value)) {
			target[key] = target[key].concat(value)
				.sort((a, b) => b.nodes - a.nodes).slice(0, 5);
		} else {
			for (let [item, count] of Object.entries(value)) {
				target[key][item] = (target[key][item] || 0) + count;
			}
		}
	}
}

function* walk(item) {
	let stat;
	try {
		stat = fs.statSync(item);
	} catch {
		return;
	}
	if (stat.isFile()) {
		if (!SKIPPED_EXTENSIONS.test(item)) yield item;
		return;
	}
	if (!stat.isDirectory()) return;
	let entries = fs.readdirSync(item, { withFileTypes: true });
	entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	for (let entry of entries) yield* walk(path.join(item, entry.name));
}

function load_engines() {
	return {
		log: require(path.join(ROOT, "viewer", "logparse.js")),
		game: require(path.join(ROOT, "viewer", "game.js")),
		motion: require(path.join(ROOT, "viewer", "motion.js")),
	};
}

/* The corpus directory is private and may embed a player's handle (see
 * corpus.json), so it is never written to a report verbatim -- hash it
 * instead. Duplicated in audit-drawn-motion.cjs, report-interpolation-rates.cjs,
 * find-seam-jumps.cjs, find-hover-links.cjs, and
 * measure-tank-shell-bradians.cjs for the same single-file reason as
 * repo_commit (see audit-drawn-motion.cjs). */
function hash_input(target) {
	const { createHash } = require("node:crypto");
	return `sha256:${createHash("sha256")
		.update(path.resolve(target)).digest("hex")}`;
}

function print_report(metrics, input) {
	let lines = [
		"# GENERATED - shot-fate parsimony feasibility; nothing written to disk.",
		`input\t${input}`,
	];
	for (let key of ["files", "files_failed", "build_ms", "probe_ms",
		"creations_tank", "creations_pill", "files_creations_residual",
		"chains_total", "chains_residual", "chains_missing_origin",
		"chains_missing_fate", "fates_residual",
		"edges_creation_fate", "edges_creation_chain", "edges_chain_fate",
		"edges_chain_chain",
		"components", "orphan_creations", "orphan_chains", "orphan_fates"]) {
		lines.push(`${key}\t${metrics[key]}`);
	}
	for (let key of ["fates_by_type", "component_sizes"]) {
		let table = metrics[key];
		for (let item of Object.keys(table).sort()) {
			lines.push(`${key}:${item}\t${table[item]}`);
		}
	}
	for (let entry of metrics.largest) {
		lines.push(`# largest component: ${entry.nodes} nodes, ` +
			`${entry.edges} edges, in ${entry.file}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

function parse_args(argv) {
	let options = { target: null, workers: null, max_files: Infinity };
	for (let arg of argv) {
		let workers = arg.match(/^--workers=(\d+)$/);
		let max_files = arg.match(/^--max-files=(\d+)$/);
		if (workers) options.workers = Math.max(1, parseInt(workers[1], 10));
		else if (max_files) options.max_files = parseInt(max_files[1], 10);
		else if (arg.startsWith("--")) {
			console.error(`error: unknown option ${arg}`);
			process.exit(2);
		} else if (options.target === null) options.target = path.resolve(arg);
		else {
			console.error("error: more than one path given");
			process.exit(2);
		}
	}
	if (options.target === null) {
		let corpus = null;
		try {
			corpus = require(path.join(ROOT, "tools", "corpus.cjs"))
				.resolve_corpus_root();
		} catch {
			corpus = null;
		}
		options.target = corpus && fs.existsSync(corpus) ? corpus : DEFAULT_REPLAY;
	}
	return options;
}

function run_worker() {
	let engines = load_engines();
	parentPort.on("message", file => {
		let metrics = empty_metrics();
		let failed = null;
		try {
			analyze_file(file, engines, metrics);
			metrics.files = 1;
		} catch (error) {
			metrics.files_failed = 1;
			failed = error.message;
		}
		parentPort.postMessage({ file, metrics, failed });
	});
}

function main() {
	let options = parse_args(process.argv.slice(2));
	let files = [...walk(options.target)].slice(0, options.max_files);
	if (!files.length) {
		console.error(`error: no replay files found at ${options.target}`);
		process.exit(2);
	}
	let totals = empty_metrics();
	let worker_count = Math.min(files.length,
		options.workers || Math.max(1, Math.floor(os.cpus().length / 2)));
	let queue = files.slice();
	let done = 0;
	let active = 0;

	let finish = () => {
		print_report(totals, hash_input(options.target));
	};

	if (worker_count === 1) {
		let engines = load_engines();
		for (let file of files) {
			try {
				analyze_file(file, engines, totals);
				totals.files++;
			} catch (error) {
				totals.files_failed++;
				console.error(`warning: ${path.basename(file)}: ${error.message}`);
			}
			done++;
			if (done % 10 === 0) console.error(`progress: ${done}/${files.length}`);
		}
		finish();
		return;
	}

	for (let i = 0; i < worker_count; i++) {
		let worker = new Worker(__filename);
		let dispatch = () => {
			let file = queue.shift();
			if (file === undefined) {
				worker.terminate();
				if (active === 0 && done === files.length) finish();
				return;
			}
			active++;
			worker.postMessage(file);
		};
		worker.on("message", result => {
			active--;
			done++;
			merge_metrics(totals, result.metrics);
			if (result.failed) {
				console.error(`warning: ${path.basename(result.file)}: ${result.failed}`);
			}
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
