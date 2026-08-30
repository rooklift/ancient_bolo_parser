#!/usr/bin/env node
/* Endpoint-only shot pairing experiment.
 *
 * Question: ignoring every shell restatement (the whole interpolation
 * machinery), how many shot CREATION events (5d tank fire, F4 pill fire,
 * each with its gross 4-bit direction) can be paired with shot TERMINAL
 * events (FB fall, FC tank hit, 9n pill damage, An base damage,
 * shot-attributable 7T explosion) on physics alone: 2 px/tick flight,
 * 8.5-tile range, direction sector, and record-time consistency?
 *
 * Method: build the bipartite feasibility graph creation x terminal, then
 * model it as a unit-capacity flow and classify with the residual-graph
 * SCC decomposition:
 *   - maximum matching size      = how many CAN be paired at all
 *   - forced pairs               = pairs present in EVERY maximum matching
 *   - class-determined creations = matched in every maximum matching, and
 *     every possible partner across maximum matchings is the same KIND of
 *     fate at the same place (interchangeable terminal events)
 * plus the simpler mutually-unique and mutual-best-greedy counts for
 * comparison with the app matcher's philosophy.
 *
 * This is a measurement probe, not app code. --verify additionally runs
 * the viewer's full engine and scores how often the endpoint pairing
 * agrees with the reconstruction that used all the shell restatements.
 *
 * Usage:
 *   node tools/probe-endpoint-pairing.mjs [replay] [--verify]
 *       [--early=N] [--late=N] [--cone=DEG] [--margin=N]
 */
"use strict";

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const DEFAULT_REPLAY = path.join(ROOT, "fixtures", "n20021018.2");

const SPEED_PIXELS_PER_TICK = 2;
/* 8.5 tiles from the muzzle; origins here are source centres, so allow the
 * muzzle offset on top. */
const RANGE_PIXELS = 136 + 8;
const DISTANCE_TOLERANCE = 24;
/* Track interpolation trust window, matching the viewer's position rule. */
const TRACK_LERP_GAP = 30;
const TRACK_NEAREST_GAP = 25;

const options = {
	target: DEFAULT_REPLAY,
	verify: false,
	/* Terminal record may precede the computed arrival by this much
	 * (creation-record lag makes the flight look shorter than it was). */
	early: 20,
	/* Terminal record may trail the computed arrival by this much
	 * (network lag on the impact record). */
	late: 60,
	cone: 17,          /* degrees half-angle around the sector centre */
	margin: 6,         /* greedy mutual-best margin, in cost units */
};
for (const arg of process.argv.slice(2)) {
	let m;
	if (arg === "--verify") options.verify = true;
	else if ((m = arg.match(/^--early=(\d+)$/))) options.early = +m[1];
	else if ((m = arg.match(/^--late=(\d+)$/))) options.late = +m[1];
	else if ((m = arg.match(/^--cone=(\d+)$/))) options.cone = +m[1];
	else if ((m = arg.match(/^--margin=(\d+)$/))) options.margin = +m[1];
	else if (arg.startsWith("--")) {
		console.error(`unknown option ${arg}`);
		process.exit(2);
	} else options.target = path.resolve(arg);
}
const CONE_HALF_ANGLE = options.cone * Math.PI / 180;

const { records } = await import(url.pathToFileURL(
	path.join(ROOT, "src", "parse.js")));

/* ---- event collection ------------------------------------------------- */

/* Everything below works in object-centre pixel coordinates. */

function track_position_at(track, time) {
	if (!track || !track.length) return null;
	let lo = 0, hi = track.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (track[mid].time <= time) lo = mid + 1;
		else hi = mid;
	}
	const before = lo > 0 ? track[lo - 1] : null;
	const after = lo < track.length ? track[lo] : null;
	if (before && after && !after.break_before) {
		const moved = Math.hypot(after.x - before.x, after.y - before.y);
		/* Restatements pause while a tank sits still; identical bracketing
		 * samples are trustworthy across any gap. */
		if (moved <= 2) {
			return { x: (before.x + after.x) / 2,
				y: (before.y + after.y) / 2, slack: 4 };
		}
		if (after.time - before.time <= TRACK_LERP_GAP) {
			const f = after.time === before.time ? 0 :
				(time - before.time) / (after.time - before.time);
			return { x: before.x + (after.x - before.x) * f,
				y: before.y + (after.y - before.y) * f, slack: 2 };
		}
		/* A short unseen hop: take the midpoint, widened by the hop. */
		if (moved <= 24) {
			return { x: (before.x + after.x) / 2,
				y: (before.y + after.y) / 2, slack: moved / 2 + 8 };
		}
	}
	for (const sample of [before, after]) {
		if (sample && Math.abs(sample.time - time) <= TRACK_NEAREST_GAP) {
			return { x: sample.x, y: sample.y, slack: 8 };
		}
	}
	return null;
}

function collect_events(recs) {
	/* First pass: complete tank tracks, so events later in the stream can
	 * interpolate between restatements on BOTH sides of their time. */
	const tank_tracks = Array.from({ length: 16 }, () => []);
	for (const rec of recs) {
		for (const sub of rec.subpackets) {
			if (sub.type === "tank_position") {
				const track = tank_tracks[rec.player];
				track.push({
					time: rec.time,
					x: sub.x * 16 + sub.pixelX + 8,
					y: sub.y * 16 + sub.pixelY + 8,
					break_before: sub.dying ||
						(track.length > 0 && track[track.length - 1].dying),
					dying: sub.dying,
				});
			} else if (sub.type === "tank_death" || sub.type === "quit") {
				const track = tank_tracks[rec.player];
				if (track.length) track[track.length - 1].dying = true;
			}
		}
	}

	/* Second pass: replay pill/base state and emit events. */
	let pills = [];
	let bases = [];
	const creations = [];
	const terminals = [];
	const skipped = { creations_unplaced: 0, terminals_unplaced: 0 };

	const lowest_carried = player => {
		for (const pill of pills) if (pill.inTank === player) return pill;
		return null;
	};
	const drop_carried_pills = rec => {
		/* Carried pills drop eventlessly near the wreck (serpentine
		 * search); place them at the death square with wide slack. */
		const position = track_position_at(tank_tracks[rec.player], rec.time);
		for (const pill of pills) {
			if (pill.inTank === rec.player) {
				pill.inTank = null;
				if (position) {
					pill.cx = position.x;
					pill.cy = position.y;
					pill.slack = 64;
				} else {
					pill.cx = undefined;
				}
			}
		}
	};

	for (const rec of recs) {
		for (const sub of rec.subpackets) {
			switch (sub.type) {
			case "tank_death":
			case "quit":
				drop_carried_pills(rec);
				break;
			case "pillbox_list":
				pills = sub.items.map(item => ({
					cx: item.x * 16 + 8, cy: item.y * 16 + 8,
					inTank: null, slack: 0,
				}));
				break;
			case "base_list":
				bases = sub.items.map(item => ({
					cx: item.x * 16 + 8, cy: item.y * 16 + 8,
				}));
				break;
			case "pill_pickup": {
				const pill = pills[sub.pillbox];
				if (pill) pill.inTank = rec.player;
				break;
			}
			case "pill_plant":
			case "pill_dumped_by_dead_lgm": {
				const pill = lowest_carried(rec.player);
				if (pill) {
					pill.inTank = null;
					pill.cx = sub.x * 16 + 8;
					pill.cy = sub.y * 16 + 8;
					pill.slack = 0;
				}
				break;
			}
			case "shot_fired": {
				const position = track_position_at(tank_tracks[rec.player],
					rec.time);
				if (!position) {
					skipped.creations_unplaced++;
					break;
				}
				creations.push({
					kind: "tank", time: rec.time, player: rec.player,
					direction: sub.direction,
					origins: [{ x: position.x, y: position.y,
						slack: position.slack }],
					class_key: `tank:${rec.player}:${sub.direction}`,
				});
				break;
			}
			case "pillbox_fires": {
				const origins = [];
				const named = pills[sub.pillbox];
				if (named && named.inTank === null && named.cx !== undefined) {
					origins.push({ x: named.cx, y: named.cy,
						slack: named.slack });
				}
				/* Direction-0 F4s mis-name the pill ~25% of the time; the
				 * true firer is then n-1 [E:pill-fire-index]. */
				if (sub.direction === 0 && sub.pillbox > 0) {
					const alt = pills[sub.pillbox - 1];
					if (alt && alt.inTank === null && alt.cx !== undefined) {
						origins.push({ x: alt.cx, y: alt.cy,
							slack: alt.slack });
					}
				}
				if (!origins.length) {
					skipped.creations_unplaced++;
					break;
				}
				creations.push({
					kind: "pill", time: rec.time, player: rec.player,
					direction: sub.direction,
					origins,
					class_key: `pill:${origins[0].x},${origins[0].y}` +
						`:${sub.direction}`,
				});
				break;
			}
			case "shell_falls":
				terminals.push({
					event_type: "shell_falls", time: rec.time,
					cx: sub.x * 16 + (sub.pixel & 0x0f) + 8,
					cy: sub.y * 16 + (sub.pixel >> 4) + 8,
					halfw: 2, direction: null,
					class_key: `fb:${sub.x * 16 + (sub.pixel & 0x0f)}` +
						`,${sub.y * 16 + (sub.pixel >> 4)}`,
				});
				break;
			case "tank_hit": {
				const position = track_position_at(tank_tracks[sub.tank],
					rec.time);
				if (!position) {
					skipped.terminals_unplaced++;
					break;
				}
				terminals.push({
					event_type: "tank_hit", time: rec.time,
					cx: position.x, cy: position.y,
					halfw: 8 + position.slack, direction: sub.direction,
					class_key: `fc:${sub.tank}:${sub.direction}`,
				});
				break;
			}
			case "pillbox_damage": {
				const pill = pills[sub.pillbox];
				if (!pill || pill.inTank !== null || pill.cx === undefined) {
					skipped.terminals_unplaced++;
					break;
				}
				terminals.push({
					event_type: "pillbox_damage", time: rec.time,
					cx: pill.cx, cy: pill.cy,
					halfw: 8 + pill.slack, direction: null,
					class_key: `pd:${sub.pillbox}`,
				});
				break;
			}
			case "base_damage": {
				const base = bases[sub.base];
				if (!base) {
					skipped.terminals_unplaced++;
					break;
				}
				terminals.push({
					event_type: "base_damage", time: rec.time,
					cx: base.cx, cy: base.cy,
					halfw: 8, direction: null,
					class_key: `bd:${sub.base}`,
				});
				break;
			}
			case "explosion":
				/* C = LGM mine plant, D = tank superboom: not shell impacts.
				 * Everything else names the struck tile (same population the
				 * viewer treats as terminals). */
				if (sub.code === 0x0c || sub.code === 0x0d) break;
				terminals.push({
					event_type: "explosion", time: rec.time,
					cx: sub.x * 16 + 8, cy: sub.y * 16 + 8,
					halfw: 8, direction: null,
					class_key: `ex:${sub.x},${sub.y}`,
				});
				break;
			}
		}
	}
	return { creations, terminals, skipped };
}

/* ---- feasibility edges ------------------------------------------------ */

function edge_cost(creation, terminal) {
	const dt = terminal.time - creation.time;
	if (dt < -options.early || dt > 100) return null;
	if (terminal.direction !== null &&
		terminal.direction !== creation.direction) return null;
	let best = null;
	for (const origin of creation.origins) {
		const dx = terminal.cx - origin.x;
		const dy = terminal.cy - origin.y;
		const dist = Math.hypot(dx, dy);
		const slack = terminal.halfw + origin.slack;
		if (dist > RANGE_PIXELS + DISTANCE_TOLERANCE + slack) continue;
		const flight = dist / SPEED_PIXELS_PER_TICK;
		if (dt < flight - options.early - slack / SPEED_PIXELS_PER_TICK) continue;
		if (dt > flight + options.late) continue;
		/* Direction sector: nibble 0 = north, clockwise 22.5deg steps. */
		if (dist > slack) {
			const angle = creation.direction * Math.PI / 8;
			const forward = dx * Math.sin(angle) - dy * Math.cos(angle);
			if (forward <= 0) continue;
			const lateral = Math.abs(dx * Math.cos(angle) +
				dy * Math.sin(angle));
			if (Math.atan2(lateral, forward) >
				CONE_HALF_ANGLE + Math.atan2(slack + 8, dist)) continue;
			const cost = Math.abs(dt - flight) + lateral / 4;
			if (best === null || cost < best) best = cost;
		} else {
			const cost = Math.abs(dt - flight);
			if (best === null || cost < best) best = cost;
		}
	}
	return best;
}

function build_edges(creations, terminals) {
	const order = terminals.map((_, i) => i)
		.sort((a, b) => terminals[a].time - terminals[b].time);
	const times = order.map(i => terminals[i].time);
	const first_at = time => {
		let lo = 0, hi = times.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (times[mid] < time) lo = mid + 1;
			else hi = mid;
		}
		return lo;
	};
	/* edges[c] = [{ t, cost }] */
	const edges = creations.map(() => []);
	const reverse = terminals.map(() => []);
	for (let c = 0; c < creations.length; c++) {
		const creation = creations[c];
		for (let k = first_at(creation.time - options.early);
			k < order.length && times[k] <= creation.time + 100; k++) {
			const t = order[k];
			const cost = edge_cost(creation, terminals[t]);
			if (cost !== null) {
				edges[c].push({ t, cost });
				reverse[t].push({ c, cost });
			}
		}
	}
	return { edges, reverse };
}

/* ---- maximum matching (Hopcroft-Karp) --------------------------------- */

function maximum_matching(edges, terminal_count) {
	const C = edges.length;
	const match_c = new Int32Array(C).fill(-1);
	const match_t = new Int32Array(terminal_count).fill(-1);
	const dist = new Int32Array(C);
	const INF = 0x7fffffff;
	const queue = new Int32Array(C);

	const bfs = () => {
		let head = 0, tail = 0;
		for (let c = 0; c < C; c++) {
			if (match_c[c] < 0) { dist[c] = 0; queue[tail++] = c; }
			else dist[c] = INF;
		}
		let found = false;
		while (head < tail) {
			const c = queue[head++];
			for (const { t } of edges[c]) {
				const next = match_t[t];
				if (next < 0) found = true;
				else if (dist[next] === INF) {
					dist[next] = dist[c] + 1;
					queue[tail++] = next;
				}
			}
		}
		return found;
	};
	const dfs = c => {
		for (const { t } of edges[c]) {
			const next = match_t[t];
			if (next < 0 || (dist[next] === dist[c] + 1 && dfs(next))) {
				match_c[c] = t;
				match_t[t] = c;
				return true;
			}
		}
		dist[c] = INF;
		return false;
	};
	let size = 0;
	while (bfs()) {
		for (let c = 0; c < C; c++) {
			if (match_c[c] < 0 && dfs(c)) size++;
		}
	}
	return { match_c, match_t, size };
}

/* ---- residual-graph SCCs ---------------------------------------------- */

/* Flow view: S -> creation -> terminal -> T, all unit capacities, with the
 * maximum matching as a maximum flow. In the residual digraph:
 *   - a matched pair is in EVERY maximum matching iff its two nodes are in
 *     different SCCs (no rerouting cycle through the reverse arc);
 *   - an unmatched feasible edge is in SOME maximum matching iff its two
 *     nodes share an SCC;
 *   - a creation is matched in every maximum matching iff it is matched
 *     and not in S's SCC; a terminal is explained in every maximum
 *     matching iff matched and not in T's SCC.
 */
function residual_sccs(edges, match_c, match_t) {
	const C = match_c.length, T = match_t.length;
	const S = C + T, TN = C + T + 1, N = C + T + 2;
	const out = Array.from({ length: N }, () => []);
	for (let c = 0; c < C; c++) {
		for (const { t } of edges[c]) {
			if (match_c[c] === t) out[C + t].push(c);
			else out[c].push(C + t);
		}
		if (match_c[c] < 0) out[S].push(c);
		else out[c].push(S);
	}
	for (let t = 0; t < T; t++) {
		if (match_t[t] < 0) out[C + t].push(TN);
		else out[TN].push(C + t);
	}
	/* Iterative Tarjan. */
	const index = new Int32Array(N).fill(-1);
	const low = new Int32Array(N);
	const on_stack = new Uint8Array(N);
	const scc = new Int32Array(N).fill(-1);
	const stack = [];
	let counter = 0, components = 0;
	for (let start = 0; start < N; start++) {
		if (index[start] >= 0) continue;
		const work = [[start, 0]];
		while (work.length) {
			const frame = work[work.length - 1];
			const node = frame[0];
			if (frame[1] === 0) {
				index[node] = low[node] = counter++;
				stack.push(node);
				on_stack[node] = 1;
			}
			let advanced = false;
			while (frame[1] < out[node].length) {
				const next = out[node][frame[1]++];
				if (index[next] < 0) {
					work.push([next, 0]);
					advanced = true;
					break;
				}
				if (on_stack[next] && index[next] < low[node]) {
					low[node] = index[next];
				}
			}
			if (advanced) continue;
			if (low[node] === index[node]) {
				for (;;) {
					const member = stack.pop();
					on_stack[member] = 0;
					scc[member] = components;
					if (member === node) break;
				}
				components++;
			}
			work.pop();
			if (work.length) {
				const parent = work[work.length - 1][0];
				if (low[node] < low[parent]) low[parent] = low[node];
			}
		}
	}
	return { scc, S, TN, creation_node: c => c, terminal_node: t => C + t };
}

/* ---- greedy mutual-best with margin ----------------------------------- */

function greedy_mutual_best(edges, reverse) {
	const pairs = new Map();
	const best_for_terminal = new Map();
	for (let t = 0; t < reverse.length; t++) {
		const list = reverse[t];
		if (!list.length) continue;
		const sorted = [...list].sort((a, b) => a.cost - b.cost);
		const runner = sorted.length > 1 ? sorted[1].cost : Infinity;
		best_for_terminal.set(t, { c: sorted[0].c,
			ok: runner - sorted[0].cost >= options.margin ||
				sorted.length === 1 });
	}
	for (let c = 0; c < edges.length; c++) {
		const list = edges[c];
		if (!list.length) continue;
		const sorted = [...list].sort((a, b) => a.cost - b.cost);
		const runner = sorted.length > 1 ? sorted[1].cost : Infinity;
		const ok = runner - sorted[0].cost >= options.margin ||
			sorted.length === 1;
		if (!ok) continue;
		const t = sorted[0].t;
		const mutual = best_for_terminal.get(t);
		if (mutual && mutual.c === c && mutual.ok) pairs.set(c, t);
	}
	return pairs;
}

/* Cheapest-edge-first global assignment: the "best guess for everything"
 * counterpart to the conservative mutual-best tier. */
function greedy_global(edges) {
	const all = [];
	for (let c = 0; c < edges.length; c++) {
		for (const { t, cost } of edges[c]) all.push({ c, t, cost });
	}
	all.sort((a, b) => a.cost - b.cost);
	const pairs = new Map();
	const taken_terminals = new Set();
	for (const { c, t } of all) {
		if (pairs.has(c) || taken_terminals.has(t)) continue;
		pairs.set(c, t);
		taken_terminals.add(t);
	}
	return pairs;
}

/* ---- components ------------------------------------------------------- */

function component_histogram(edges, creation_count, terminal_count) {
	const N = creation_count + terminal_count;
	const parents = new Int32Array(N);
	for (let i = 0; i < N; i++) parents[i] = i;
	const find = node => {
		while (parents[node] !== node) {
			parents[node] = parents[parents[node]];
			node = parents[node];
		}
		return node;
	};
	for (let c = 0; c < creation_count; c++) {
		for (const { t } of edges[c]) {
			const a = find(c), b = find(creation_count + t);
			if (a !== b) parents[a] = b;
		}
	}
	const sizes = new Map();
	for (let i = 0; i < N; i++) {
		const root = find(i);
		sizes.set(root, (sizes.get(root) || 0) + 1);
	}
	const histogram = {};
	let largest = 0;
	for (const size of sizes.values()) {
		if (size > largest) largest = size;
		const bucket = size === 1 ? "1" : size === 2 ? "2" :
			size <= 5 ? "3-5" : size <= 10 ? "6-10" : size <= 20 ? "11-20" :
			size <= 50 ? "21-50" : size <= 100 ? "51-100" : "100+";
		histogram[bucket] = (histogram[bucket] || 0) + 1;
	}
	return { histogram, largest };
}

/* ---- verification against the full engine ----------------------------- */

/* The viewer's matcher consumed the same creation and terminal events while
 * building shell chains from the restatements. Recover its opinion of
 * creation -> terminal pairings and score agreement with the endpoint
 * pairing. Chain extraction and creation-claiming mirror
 * tools/probe-shot-fate-parsimony.cjs, except the claim returns identity.
 */
function engine_pairs(bytes, my_creations, my_terminals) {
	const require = createRequire(import.meta.url);
	const engines = {
		log: require(path.join(ROOT, "viewer", "logparse.js")),
		game: require(path.join(ROOT, "viewer", "game.js")),
		motion: require(path.join(ROOT, "viewer", "motion.js")),
	};
	const recs = [...engines.log.records(bytes)];
	const game_result = engines.game.build(recs);

	/* Chains over matched restatements (identical to the parsimony probe). */
	const chains = [];
	const players = game_result.shell_positions || [];
	for (let player = 0; player < players.length; player++) {
		const snapshots = players[player];
		if (!Array.isArray(snapshots)) continue;
		let previous = null;
		let previous_chain_of = null;
		for (let index = 0; index < snapshots.length; index++) {
			const snapshot = snapshots[index];
			const chain_of = new Map();
			if (previous) {
				const claimed = new Set();
				for (let i = 0; i < previous.shells.length; i++) {
					const old_shell = previous.shells[i];
					if (old_shell.next_time === undefined ||
						old_shell.next_terminal ||
						old_shell.next_time !== snapshot.time) continue;
					const chain = previous_chain_of.get(i);
					if (!chain) continue;
					for (let j = 0; j < snapshot.shells.length; j++) {
						if (claimed.has(j)) continue;
						const shell = snapshot.shells[j];
						if (!shell.matched_from_previous ||
							shell.direction !== old_shell.direction) continue;
						const candidates = [
							[shell.pixel_x, shell.pixel_y],
							[shell.tank_exact_pixel_x, shell.tank_exact_pixel_y],
							[shell.pillbox_orbit_pixel_x, shell.pillbox_orbit_pixel_y],
						];
						if (!candidates.some(([x, y]) => x !== undefined &&
							x === old_shell.next_pixel_x &&
							y === old_shell.next_pixel_y)) continue;
						claimed.add(j);
						chain.last = shell;
						chain_of.set(j, chain);
						break;
					}
				}
			}
			for (let j = 0; j < snapshot.shells.length; j++) {
				if (chain_of.has(j)) continue;
				const shell = snapshot.shells[j];
				const chain = {
					player, direction: shell.direction,
					head: shell, last: shell, start_time: snapshot.time,
				};
				chains.push(chain);
				chain_of.set(j, chain);
			}
			previous = snapshot;
			previous_chain_of = chain_of;
		}
	}

	/* Claim creations for chain origins / unseen-source terminals, keeping
	 * identity. Uses this probe's own creation list: engine shells carry
	 * enough source data to name the claim keys. */
	const free = my_creations.map(() => true);
	const pools = new Map();
	for (let i = 0; i < my_creations.length; i++) {
		const creation = my_creations[i];
		const key = `${creation.kind}:${creation.direction}`;
		if (!pools.has(key)) pools.set(key, []);
		pools.get(key).push(i);
	}
	const claim = (kind, direction, time, filter) => {
		const pool = pools.get(`${kind}:${direction}`);
		if (!pool) return -1;
		let best = -1, best_gap = Infinity;
		for (const i of pool) {
			const creation = my_creations[i];
			if (creation.time < time - 60) continue;
			if (creation.time > time + 60) break;
			if (!free[i]) continue;
			const gap = Math.abs(creation.time - time);
			if (gap >= best_gap || !filter(creation)) continue;
			best = i;
			best_gap = gap;
		}
		if (best >= 0) free[best] = false;
		return best;
	};
	const near = (origin, x, y, tolerance) =>
		Math.hypot(origin.x - (x + 8), origin.y - (y + 8)) <= tolerance;

	/* The same terminal object is distributed into every client's snapshot
	 * stream; deduplicate by identity before mapping. */
	const terminal_set = new Set();
	for (const snapshots of game_result.shell_positions) {
		for (const snapshot of snapshots) {
			for (const terminal of snapshot.terminals) {
				terminal_set.add(terminal);
			}
		}
	}
	const terminals_flat = [...terminal_set];

	/* A matched shell keeps only next_terminal_event_type and next_time;
	 * the terminal object itself carries match_time equal to that
	 * next_time. Join on (event_type, time), nearest position first. */
	const matched_buckets = new Map();
	for (const terminal of terminals_flat) {
		if (terminal.match_time === undefined) continue;
		const key = `${terminal.event_type}:${terminal.match_time}`;
		if (!matched_buckets.has(key)) matched_buckets.set(key, []);
		matched_buckets.get(key).push(terminal);
	}
	const terminal_centre = terminal => terminal.type === "point"
		? [terminal.pixel_x + 8, terminal.pixel_y + 8]
		: [(terminal.min_x + terminal.max_x) / 2,
			(terminal.min_y + terminal.max_y) / 2];
	const take_fate = last => {
		const bucket = matched_buckets.get(
			`${last.next_terminal_event_type}:${last.next_time}`);
		if (!bucket || !bucket.length) return null;
		let best = 0, best_distance = Infinity;
		for (let i = 0; i < bucket.length; i++) {
			const [cx, cy] = terminal_centre(bucket[i]);
			const distance = Math.hypot(cx - (last.next_pixel_x + 8),
				cy - (last.next_pixel_y + 8));
			if (distance < best_distance) {
				best = i;
				best_distance = distance;
			}
		}
		return bucket.splice(best, 1)[0];
	};

	const pairs = new Map();   /* creation index -> engine terminal object */
	let chains_with_fate = 0, chains_with_origin = 0;
	for (const chain of chains) {
		const head = chain.head;
		let creation = -1;
		if (head.starts_at_tank) {
			creation = claim("tank", chain.direction,
				head.birth_time ?? chain.start_time,
				c => c.player === chain.player);
		} else if (head.pillbox_source_x !== undefined) {
			const fire_time = chain.start_time -
				(head.pillbox_source_distance || 0) / SPEED_PIXELS_PER_TICK;
			creation = claim("pill", chain.direction, fire_time,
				c => c.origins.some(origin => near(origin,
					head.pillbox_source_x, head.pillbox_source_y, 4)));
		}
		if (creation >= 0) chains_with_origin++;
		const fate = chain.last.next_terminal ? take_fate(chain.last) : null;
		if (chain.last.next_terminal) chains_with_fate++;
		if (creation >= 0 && fate) pairs.set(creation, fate);
	}
	for (const terminal of terminals_flat) {
		if (terminal.unseen_pillbox_source) {
			const creation = claim("pill", terminal.pillbox_source_direction,
				terminal.record.time, c => c.origins.some(origin =>
					near(origin, terminal.pillbox_source_x,
						terminal.pillbox_source_y, 4)));
			if (creation >= 0) pairs.set(creation, terminal);
		}
	}

	/* Map engine terminal objects to this probe's terminal indices via
	 * per-(record time, event type) queues, both sides in record order. */
	const my_queue = new Map();
	for (let t = 0; t < my_terminals.length; t++) {
		const terminal = my_terminals[t];
		const key = `${terminal.time}:${terminal.event_type}`;
		if (!my_queue.has(key)) my_queue.set(key, []);
		my_queue.get(key).push(t);
	}
	const engine_sorted = terminals_flat
		.slice().sort((a, b) => a.record.time - b.record.time);
	const engine_to_mine = new Map();
	for (const terminal of engine_sorted) {
		const key = `${terminal.record.time}:${terminal.event_type}`;
		const queue = my_queue.get(key);
		if (queue && queue.length) engine_to_mine.set(terminal, queue.shift());
	}

	const opinion = new Map();  /* creation index -> my terminal index */
	for (const [creation, terminal] of pairs) {
		const mine = engine_to_mine.get(terminal);
		if (mine !== undefined) opinion.set(creation, mine);
	}
	return { opinion, chains_with_origin, chains_with_fate,
		engine_pairs_total: pairs.size };
}

/* ---- main ------------------------------------------------------------- */

const bytes = new Uint8Array(fs.readFileSync(options.target));
const started = Date.now();
const recs = [...records(bytes)];
const { creations, terminals, skipped } = collect_events(recs);
const { edges, reverse } = build_edges(creations, terminals);

const degree_histogram = list => {
	const histogram = { "0": 0, "1": 0, "2": 0, "3-5": 0, "6-10": 0, "11+": 0 };
	for (const entry of list) {
		const d = entry.length;
		histogram[d === 0 ? "0" : d === 1 ? "1" : d === 2 ? "2" :
			d <= 5 ? "3-5" : d <= 10 ? "6-10" : "11+"]++;
	}
	return histogram;
};

const { match_c, match_t, size } = maximum_matching(edges, terminals.length);
const { scc, S, TN, creation_node, terminal_node } =
	residual_sccs(edges, match_c, match_t);

let forced_pairs = 0;
let essential_creations = 0;
let class_determined = 0;
const class_determined_flags = new Uint8Array(creations.length);
const forced_by_kind = { tank: 0, pill: 0 };
const class_by_kind = { tank: 0, pill: 0 };
for (let c = 0; c < creations.length; c++) {
	if (match_c[c] < 0) continue;
	const essential = scc[creation_node(c)] !== scc[S];
	if (essential) essential_creations++;
	const forced = scc[creation_node(c)] !== scc[terminal_node(match_c[c])];
	if (forced) {
		forced_pairs++;
		forced_by_kind[creations[c].kind]++;
	}
	if (!essential) continue;
	const target_class = terminals[match_c[c]].class_key;
	let same = true;
	for (const { t } of edges[c]) {
		if (t === match_c[c]) continue;
		if (scc[creation_node(c)] === scc[terminal_node(t)] &&
			terminals[t].class_key !== target_class) {
			same = false;
			break;
		}
	}
	if (same) {
		class_determined++;
		class_determined_flags[c] = 1;
		class_by_kind[creations[c].kind]++;
	}
}
let essential_terminals = 0;
let terminal_class_determined = 0;
for (let t = 0; t < terminals.length; t++) {
	if (match_t[t] < 0) continue;
	if (scc[terminal_node(t)] === scc[TN]) continue;
	essential_terminals++;
	const target_class = creations[match_t[t]].class_key;
	let same = true;
	for (const { c } of reverse[t]) {
		if (c === match_t[t]) continue;
		if (scc[terminal_node(t)] === scc[creation_node(c)] &&
			creations[c].class_key !== target_class) {
			same = false;
			break;
		}
	}
	if (same) terminal_class_determined++;
}

let mutually_unique = 0;
for (let c = 0; c < creations.length; c++) {
	if (edges[c].length === 1 && reverse[edges[c][0].t].length === 1) {
		mutually_unique++;
	}
}
const greedy_pairs = greedy_mutual_best(edges, reverse);
const global_pairs = greedy_global(edges);
const components = component_histogram(edges, creations.length,
	terminals.length);

const terminal_counts = {};
for (const terminal of terminals) {
	terminal_counts[terminal.event_type] =
		(terminal_counts[terminal.event_type] || 0) + 1;
}
const creation_counts = { tank: 0, pill: 0 };
for (const creation of creations) creation_counts[creation.kind]++;
let edge_total = 0;
for (const list of edges) edge_total += list.length;

const pct = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : "-";
const lines = [
	"# GENERATED - endpoint-only shot pairing probe; nothing written to disk.",
	`input\t${path.relative(ROOT, options.target) || options.target}`,
	`options\tearly=${options.early} late=${options.late} ` +
		`cone=${options.cone} margin=${options.margin}`,
	`creations\t${creations.length} (tank ${creation_counts.tank}, ` +
		`pill ${creation_counts.pill}; unplaced ${skipped.creations_unplaced})`,
	`terminals\t${terminals.length} (${Object.entries(terminal_counts)
		.map(([key, count]) => `${key} ${count}`).join(", ")}; ` +
		`unplaced ${skipped.terminals_unplaced})`,
	`edges\t${edge_total}`,
	`creation_degrees\t${JSON.stringify(degree_histogram(edges))}`,
	`terminal_degrees\t${JSON.stringify(degree_histogram(reverse))}`,
	`component_sizes\t${JSON.stringify(components.histogram)} ` +
		`largest=${components.largest}`,
	`max_matching\t${size} ` +
		`(${pct(size, creations.length)} of creations, ` +
		`${pct(size, terminals.length)} of terminals)`,
	`essential_creations\t${essential_creations} ` +
		`(${pct(essential_creations, creations.length)}) ` +
		`- matched in every maximum matching`,
	`essential_terminals\t${essential_terminals} ` +
		`(${pct(essential_terminals, terminals.length)})`,
	`forced_pairs\t${forced_pairs} (${pct(forced_pairs, creations.length)} ` +
		`of creations; tank ${forced_by_kind.tank}, pill ${forced_by_kind.pill}) ` +
		`- exact pair in every maximum matching`,
	`class_determined_creations\t${class_determined} ` +
		`(${pct(class_determined, creations.length)}; ` +
		`tank ${class_by_kind.tank} of ${creation_counts.tank} = ` +
		`${pct(class_by_kind.tank, creation_counts.tank)}, ` +
		`pill ${class_by_kind.pill} of ${creation_counts.pill} = ` +
		`${pct(class_by_kind.pill, creation_counts.pill)}) ` +
		`- fate kind+place determined in every maximum matching`,
	`class_determined_terminals\t${terminal_class_determined} ` +
		`(${pct(terminal_class_determined, terminals.length)}) ` +
		`- shooter+direction determined in every maximum matching`,
	`mutually_unique_pairs\t${mutually_unique} ` +
		`(${pct(mutually_unique, creations.length)})`,
	`greedy_mutual_best_pairs\t${greedy_pairs.size} ` +
		`(${pct(greedy_pairs.size, creations.length)})`,
	`greedy_global_pairs\t${global_pairs.size} ` +
		`(${pct(global_pairs.size, creations.length)}) ` +
		`- cheapest-edge-first best guess`,
	`probe_ms\t${Date.now() - started}`,
];

if (options.verify) {
	const verify_start = Date.now();
	const engine = engine_pairs(bytes, creations, terminals);
	let both = 0, agree_exact = 0, agree_class = 0;
	let both_determined = 0, determined_agree_class = 0;
	const confusion = new Map();
	for (const [c, t] of engine.opinion) {
		if (match_c[c] < 0) continue;
		both++;
		if (match_c[c] === t) agree_exact++;
		if (terminals[match_c[c]].class_key === terminals[t].class_key) {
			agree_class++;
		}
		if (class_determined_flags[c]) {
			both_determined++;
			if (terminals[match_c[c]].class_key === terminals[t].class_key) {
				determined_agree_class++;
			} else {
				const key = `${terminals[match_c[c]].event_type}` +
					`->${terminals[t].event_type}`;
				confusion.set(key, (confusion.get(key) || 0) + 1);
			}
		}
	}
	const confusion_summary = [...confusion.entries()]
		.sort((a, b) => b[1] - a[1]).slice(0, 8)
		.map(([key, count]) => `${key} ${count}`).join(", ");
	const score_pairs = pair_map => {
		let overlap = 0, exact = 0, same_class = 0;
		for (const [c, t] of engine.opinion) {
			const mine = pair_map.get(c);
			if (mine === undefined) continue;
			overlap++;
			if (mine === t) exact++;
			if (terminals[mine].class_key === terminals[t].class_key) {
				same_class++;
			}
		}
		return { overlap, exact, same_class };
	};
	const greedy_score = score_pairs(greedy_pairs);
	const global_score = score_pairs(global_pairs);
	lines.push(
		`verify_engine_pairs\t${engine.engine_pairs_total} ` +
			`creation->terminal opinions from the full engine ` +
			`(chains with origin ${engine.chains_with_origin}, ` +
			`with fate ${engine.chains_with_fate})`,
		`verify_overlap\t${both} creations paired by both systems`,
		`verify_agree_exact\t${agree_exact} (${pct(agree_exact, both)}) ` +
			`- same terminal event`,
		`verify_agree_class\t${agree_class} (${pct(agree_class, both)}) ` +
			`- same fate kind+place`,
		`verify_class_determined\t${determined_agree_class} of ` +
			`${both_determined} class-determined endpoint pairs agree ` +
			`with the engine (${pct(determined_agree_class, both_determined)})`,
		`verify_determined_disagreements\tendpoint->engine: ` +
			`${confusion_summary || "none"}`,
		`verify_greedy_mutual_best\t${greedy_score.same_class} of ` +
			`${greedy_score.overlap} agree on fate kind+place ` +
			`(${pct(greedy_score.same_class, greedy_score.overlap)}; ` +
			`exact ${pct(greedy_score.exact, greedy_score.overlap)})`,
		`verify_greedy_global\t${global_score.same_class} of ` +
			`${global_score.overlap} agree on fate kind+place ` +
			`(${pct(global_score.same_class, global_score.overlap)}; ` +
			`exact ${pct(global_score.exact, global_score.overlap)})`,
		`verify_ms\t${Date.now() - verify_start}`,
	);
}

process.stdout.write(`${lines.join("\n")}\n`);
