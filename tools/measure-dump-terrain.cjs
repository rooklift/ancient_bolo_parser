#!/usr/bin/env node
/* What terrain can a dying tank's carried pills be dumped onto?
 *
 * The serpentine death-dump is unevented, so playback needs a predicate for
 * which squares the search accepts, and until now that predicate was a
 * guess ("not a wall, not water").  A wrong guess does not merely offset a
 * pill: every skipped square shifts EVERY remaining pill further along the
 * path, so near water the whole dump slides sideways ([E:crater-pill]
 * already caught the smell of this — impossible boat builds on squares the
 * model believed held a pill).
 *
 * The log itself can settle it, model-independently.  A dumped pill's
 * true square shows up at its NEXT PICKUP: a `FF 0n` names the pill
 * outright, and the picker's own position rides the same record — the
 * tank's centre square ([E:centre-square]) or the LGM's (+8-centred,
 * [E:centring]).  Matching that square against the serpentine path from
 * the death square identifies the path position the pill really occupied.
 * With several pills dumped at once the observed positions must be
 * strictly increasing in pill-index order (shared iterator, lowest index
 * first) — a violation would falsify the ORDER, so it is reported loudly
 * rather than absorbed.
 *
 * Every path square BEFORE an observed position was then skipped by the
 * real game, and every observed position was accepted; tallying the
 * terrain of each (at dump time) yields the predicate directly, with no
 * candidate models to compare.  Squares skipped because something stood on
 * them (a pill or base) say nothing about terrain and are excluded; a
 * "pill" whose own position came from our dump model rather than an event
 * taints the inference and is excluded too.
 *
 * The engine still runs underneath to carry terrain and occupancy state,
 * but its own dump placements are never used as evidence.
 *
 * Usage: node tools/measure-dump-terrain.cjs [corpus-root-or-log ...] [--verbose]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const BoloLog = require(path.join(ROOT, "viewer", "logparse.js"));
const BoloGame = require(path.join(ROOT, "viewer", "game.js"));

const VERBOSE = process.argv.includes("--verbose");
const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const roots = args.length ? args : [require("./corpus.cjs").corpus_root()];

const MAP_SIZE = 256;
const PATH_LIMIT = 200;  /* path positions considered when matching a pickup */
const NAMES = {
	0: "building", 1: "river", 2: "swamp", 3: "crater", 4: "road",
	5: "forest", 6: "rubble", 7: "grass", 8: "shot building", 9: "boat",
	10: "mined swamp", 11: "mined crater", 12: "mined road",
	13: "mined forest", 14: "mined rubble", 15: "mined grass",
	255: "deep sea",
};

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (let entry of entries) {
		let item = path.join(dir, entry.name);
		if (entry.isDirectory())
			yield* walk(item);
		else if (entry.isFile() && !/\.(txt|md|json|zip|sit|hqx|png|jpg|gif)$/i.test(entry.name))
			yield item;
	}
}

/* Same serpentine as viewer/game.js dump_path, truncated. */
function path_squares(x0, y0) {
	const out = [[x0, y0]];
	outer: for (let r = 1; r < MAP_SIZE; r++) {
		for (let x = -(r - 1); x <= r; x++) { out.push([x0 + x, y0 - r]); if (out.length >= PATH_LIMIT) break outer; }
		for (let y = -(r - 1); y <= r; y++) { out.push([x0 + r, y0 + y]); if (out.length >= PATH_LIMIT) break outer; }
		for (let x = r - 1; x >= -r; x--) { out.push([x0 + x, y0 + r]); if (out.length >= PATH_LIMIT) break outer; }
		for (let y = r - 1; y >= -r; y--) { out.push([x0 - r, y0 + y]); if (out.length >= PATH_LIMIT) break outer; }
	}
	return out;
}

function centre_square(sub) {
	return [(sub.x * 16 + sub.pixelX + 8) >> 4, (sub.y * 16 + sub.pixelY + 8) >> 4];
}

const totals = {
	logs: 0, dumps: 0, dumped_pills: 0, observed: 0, ambiguous: 0,
	unobserved: 0, same_record: 0, order_violations: 0,
	used: {}, skipped: {}, skipped_occupied: 0, skipped_tainted: 0,
	skipped_offmap: 0,
};

function bump(table, terrain) {
	table[terrain] = (table[terrain] || 0) + 1;
}

function process_log(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		return;
	}
	if (!recs.length) return;
	totals.logs++;

	const state = BoloGame.initial_state(BoloGame.extract_initial_map(recs));

	/* positions our own dump model invented, per pill index; any evented
	 * position (plant, LGM dump, pickup) clears the flag */
	const modelled = new Array(64).fill(false);

	const dumps = []; /* {rec, player, path:[{x,y,terrain,pill,base,tainted}], pills:[ids]} */

	for (let i = 0; i < recs.length; i++) {
		const rec = recs[i];
		const before = state.pills.map(p => ({ inTank: p.inTank, x: p.x, y: p.y }));
		const gridSnap = rec.subpackets.some(s => s.type === "tank_death" || s.type === "quit")
			? state.grid.slice() : null;
		const tankSnap = state.tanks[rec.player]
			? { x: state.tanks[rec.player].x, y: state.tanks[rec.player].y, px: state.tanks[rec.player].px, py: state.tanks[rec.player].py }
			: null;
		const occSnap = gridSnap ? {
			pills: state.pills.map((p, k) => ({ x: p.x, y: p.y, ground: p.inTank === null, modelled: modelled[k] })),
			bases: state.bases.map(b => ({ x: b.x, y: b.y })),
		} : null;

		const effects = [];
		BoloGame.apply_record(state, rec, effects, null);

		/* evented placements this record — not serpentine dumps */
		const evented = rec.subpackets
			.filter(s => s.type === "pill_plant" || s.type === "pill_dumped_by_dead_lgm")
			.map(s => `${s.x},${s.y}`);

		for (const sub of rec.subpackets) {
			if (sub.type === "pill_pickup" && state.pills[sub.pillbox]) modelled[sub.pillbox] = false;
			if (sub.type === "pill_plant" || sub.type === "pill_dumped_by_dead_lgm") {
				/* whichever pill landed on the evented square is evented */
				state.pills.forEach((p, k) => {
					if (p.inTank === null && p.x === sub.x && p.y === sub.y) modelled[k] = false;
				});
			}
		}

		if (!gridSnap) continue;

		const ids = [];
		state.pills.forEach((p, k) => {
			if (before[k].inTank === rec.player && p.inTank === null &&
				!evented.includes(`${p.x},${p.y}`)) {
				ids.push(k);
				modelled[k] = true;
			}
		});
		if (!ids.length) continue;

		/* death square: the tank_death effect carries the engine's own
		 * computation; a quit dump falls back to the pre-record tank */
		let dsq = null;
		const deathEffect = effects.find(e => e.type === "tank_death" && e.player === rec.player);
		if (deathEffect) dsq = [deathEffect.x, deathEffect.y];
		else if (tankSnap) dsq = [(tankSnap.x * 16 + tankSnap.px + 8) >> 4, (tankSnap.y * 16 + tankSnap.py + 8) >> 4];
		if (!dsq) continue;

		const squares = path_squares(dsq[0], dsq[1]).map(([x, y]) => {
			if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE)
				return { x, y, offmap: true };
			const pill = occSnap.pills.find(p => p.ground && p.x === x && p.y === y);
			return {
				x, y,
				terrain: gridSnap[y * MAP_SIZE + x],
				pill: !!pill,
				tainted: !!(pill && pill.modelled),
				base: occSnap.bases.some(b => b.x === x && b.y === y),
			};
		});
		dumps.push({ file, rec: i, time: rec.time, player: rec.player, dsq, squares, pills: ids });
		totals.dumps++;
		totals.dumped_pills += ids.length;
	}

	/* Second pass: each dumped pill's next pickup gives its true square. */
	const pickups = []; /* per record index: [{pill, cands:[[x,y],...]}] */
	for (let i = 0; i < recs.length; i++) {
		const rec = recs[i];
		const pp = rec.subpackets.filter(s => s.type === "pill_pickup");
		if (!pp.length) continue;
		const cands = [];
		for (const s of rec.subpackets) {
			if (s.type === "tank_position" || s.type === "lgm_position") cands.push(centre_square(s));
		}
		pickups.push({ rec: i, pills: pp.map(s => s.pillbox), cands, multi: pp.length > 1 });
	}

	for (const dump of dumps) {
		const observed = []; /* per pill: path index, or null */
		for (const id of dump.pills) {
			const pk = pickups.find(p => p.rec > dump.rec && p.pills.includes(id));
			if (!pk) { observed.push({ id, index: null, why: "never picked up" }); totals.unobserved++; continue; }
			if (pk.multi) { observed.push({ id, index: null, why: "multi-pickup record" }); totals.same_record++; continue; }
			const matches = [];
			for (const [cx, cy] of pk.cands) {
				const idx = dump.squares.findIndex(sq => sq.x === cx && sq.y === cy);
				if (idx >= 0 && !matches.includes(idx)) matches.push(idx);
			}
			if (matches.length === 1) { observed.push({ id, index: matches[0] }); totals.observed++; }
			else if (matches.length > 1) { observed.push({ id, index: null, why: "ambiguous" }); totals.ambiguous++; }
			else { observed.push({ id, index: null, why: "picker off path" }); totals.unobserved++; }
		}

		/* order check: observed indices must increase with pill index */
		let last = -1, violated = false;
		for (const o of observed) {
			if (o.index === null) continue;
			if (o.index <= last) violated = true;
			last = o.index;
		}
		if (violated) {
			totals.order_violations++;
			console.log(`ORDER VIOLATION ${path.basename(dump.file)} rec ${dump.rec}: pills ${dump.pills} observed at path indices ${observed.map(o => o.index).join(",")}`);
			continue; /* cannot trust skip inference either */
		}

		/* tally: used squares, and skips below each observed position
		 * (a gap below an UNobserved pill proves nothing — that pill may
		 * occupy any square in it) */
		let floor = 0;
		for (const o of observed) {
			if (o.index === null) { floor = -1; continue; } /* gaps above are unusable */
			if (floor >= 0) {
				for (let k = floor; k < o.index; k++) {
					const sq = dump.squares[k];
					if (sq.offmap) { totals.skipped_offmap++; continue; }
					if (sq.tainted) { totals.skipped_tainted++; continue; }
					if (sq.pill || sq.base) { totals.skipped_occupied++; continue; }
					bump(totals.skipped, sq.terrain);
					if (VERBOSE) console.log(`  skip ${path.basename(dump.file)} rec ${dump.rec} path[${k}] (${sq.x},${sq.y}) ${NAMES[sq.terrain]}`);
				}
			}
			const sq = dump.squares[o.index];
			bump(totals.used, sq.terrain);
			if (VERBOSE) console.log(`  used ${path.basename(dump.file)} rec ${dump.rec} pill ${o.id} path[${o.index}] (${sq.x},${sq.y}) ${NAMES[sq.terrain]}`);
			floor = o.index + 1;
		}
	}
}

for (const root of roots) {
	const st = fs.statSync(root);
	if (st.isDirectory()) for (const f of walk(root)) process_log(f);
	else process_log(root);
}

console.log(`logs: ${totals.logs}   serpentine dumps: ${totals.dumps} (${totals.dumped_pills} pills)`);
console.log(`pill squares observed via pickup: ${totals.observed}` +
	`   (ambiguous ${totals.ambiguous}, multi-pickup ${totals.same_record}, unobservable ${totals.unobserved})`);
console.log(`order violations: ${totals.order_violations}`);
console.log(`skips excluded: ${totals.skipped_occupied} occupied, ${totals.skipped_tainted} tainted by modelled pills, ${totals.skipped_offmap} off-map`);
console.log("");
console.log("terrain            used   skipped");
const seen = new Set([...Object.keys(totals.used), ...Object.keys(totals.skipped)].map(Number));
for (const t of [...seen].sort((a, b) => a - b)) {
	console.log(`${(NAMES[t] || String(t)).padEnd(16)} ${String(totals.used[t] || 0).padStart(6)} ${String(totals.skipped[t] || 0).padStart(9)}`);
}
