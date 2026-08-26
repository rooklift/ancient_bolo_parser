#!/usr/bin/env node
/* Does a crater event change the ground under a pillbox?
 *
 * The ground under a standing pill is unobservable -- the pill masks it --
 * so the question cannot be read off the terrain directly.  Flooding
 * supplies the read-out.  A crater beside water floods within a second and
 * the flood is EVENTED (see FORMAT.md [E:crater-water]), so for a crater
 * event landing on a square with a water neighbour:
 *
 *   a 6 1 there ~0.6 s later  =>  the ground really did become a crater
 *   nothing                   =>  the crater was never applied
 *
 * Run that test on squares holding a grounded pill, against the same test
 * on bare ground as a control.  WinBolo's big explosion damages a pill
 * INSTEAD of cratering its square (`tkExplosionBigExplosion` checks
 * `pillsExistPos` first), while its small explosion has no such check;
 * this measures whether Bolo agrees, and for which crater path.
 *
 * A second question rides along.  Only two of the corpus's water-adjacent
 * cases have a pill position that came from an EVENT (`F1 02` initial
 * list, `FF 50` plant, `FF 51` LGM dump); the rest come from our own
 * serpentine death-dump model.  Bolo refuses an LGM build on a square
 * holding a pill, so a build landing on a believed-pill square convicts
 * the placement.  Those are counted too, corpus-wide, to say how much
 * weight the modelled cases can carry.
 *
 * Usage: node tools/measure-crater-pill.cjs [corpus-root]
 */
const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const ROOT = args[0] || "C:/Users/Owner/__DOCS/Bolo Archives/Nemokrad's Bolo logs";

const MAP_SIZE = BoloGame.MAP_SIZE;
const DEEP_SEA = BoloGame.DEEP_SEA;
const FLOOD_WINDOW = 150;                    /* 3 s; the rule fires in ~0.6 */
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BUILD_TERRAIN = new Set([9, 4, 0, 5]); /* boat, road, building, tree */

const is_water = t => t === 1 || t === 9 || t === DEEP_SEA;
const is_mined = t => t >= 10 && t <= 15;

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, {withFileTypes: true});
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

/* Terrain-affecting events in one record, a superboom expanded to its four
 * squares. `terrain` is the code the square would take. */
function terrain_events(rec) {
	let out = [];
	for (let sub of rec.subpackets) {
		if (sub.type === "terrain_change") {
			out.push({x: sub.x, y: sub.y, kind: "6T", terrain: sub.terrain});
		} else if (sub.type === "explosion") {
			if (sub.code === 0x0d)
				for (let [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]])
					out.push({x: sub.x + dx, y: sub.y + dy, kind: "7D", terrain: 3});
			else if (sub.code <= 9)
				out.push({x: sub.x, y: sub.y, kind: "7 3", terrain: sub.code});
		}
	}
	return out;
}

const cells = new Map();       /* "occupant|terrain|kind" -> {n, flooded, delays} */
const totals = {
	logs: 0, records: 0, unreadable: 0,
	crater_on_pill: 0, beside_water: 0,
	builds: 0, builds_on_believed_pill: 0, bad_builds_on_cases: 0,
	placements: {}, bad_builds: {}, case_sources: {},
};

function cell(key) {
	if (!cells.has(key)) cells.set(key, {n: 0, flooded: 0, delays: []});
	return cells.get(key);
}

function scan(file) {
	let records;
	try {
		records = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		totals.unreadable++;
		return;
	}
	if (!records.length) return;
	totals.logs++;
	totals.records += records.length;

	let state = BoloGame.initial_state(BoloGame.extract_initial_map(records));
	let source = state.pills.map(() => "initial list");
	let candidates = [];
	let case_squares = new Set();   /* pill cases seen so far, for the build check */

	for (let i = 0; i < records.length; i++) {
		let rec = records[i];

		for (let ev of terrain_events(rec)) {
			if (ev.terrain !== 3 || ev.x >= MAP_SIZE || ev.y >= MAP_SIZE) continue;
			let under = state.grid[ev.y * MAP_SIZE + ev.x];
			let pill = state.pills.find(p => p.inTank === null && p.x === ev.x && p.y === ev.y);
			if (pill) totals.crater_on_pill++;
			/* a square that is already water or already a crater cannot
			 * report anything, and a base square is spared for its own
			 * reasons -- see [E:base-road] */
			if (is_water(under) || under === 3) continue;
			if (state.bases.some(b => b.x === ev.x && b.y === ev.y)) continue;
			if (!NEIGHBOURS.some(([dx, dy]) => is_water(state.grid[(ev.y + dy) * MAP_SIZE + ev.x + dx]))) continue;
			if (pill) {
				totals.beside_water++;
				case_squares.add(`${ev.x},${ev.y}`);
				let src = source[state.pills.indexOf(pill)];
				totals.case_sources[src] = (totals.case_sources[src] || 0) + 1;
			}
			candidates.push({
				index: i, time: rec.time, kind: ev.kind === "7D" ? "7D" : "7 3",
				x: ev.x, y: ev.y,
				occupant: !pill ? "no pill" : (pill.armour === 0 ? "dead pill" : "live pill"),
				ground: is_mined(under) ? "mined" : "plain",
				source: pill ? source[state.pills.indexOf(pill)] : null,
				flood: null,
			});
		}

		/* builds that land on a believed-pill square convict the placement */
		for (let sub of rec.subpackets) {
			if (sub.type !== "terrain_change" || !BUILD_TERRAIN.has(sub.terrain)) continue;
			totals.builds++;
			let k = state.pills.findIndex(p => p.inTank === null && p.x === sub.x && p.y === sub.y);
			if (k >= 0) {
				totals.builds_on_believed_pill++;
				totals.bad_builds[source[k]] = (totals.bad_builds[source[k]] || 0) + 1;
				if (case_squares.has(`${sub.x},${sub.y}`)) totals.bad_builds_on_cases++;
			}
		}

		/* provenance: what placed each pill that moved in this record */
		let before = state.pills.map(p => (p.inTank === null ? `${p.x},${p.y}` : "tank"));
		let plants = rec.subpackets.filter(s => s.type === "pill_plant" || s.type === "pill_dumped_by_dead_lgm");
		let death = rec.subpackets.some(s => s.type === "tank_death" || s.type === "player_quit");
		BoloGame.apply_record(state, rec, null, null);
		state.pills.forEach((p, k) => {
			let now = p.inTank === null ? `${p.x},${p.y}` : "tank";
			if (now === before[k] || now === "tank") return;
			source[k] = plants.some(s => s.x === p.x && s.y === p.y) ? "evented plant/dump"
				: (death ? "modelled death dump" : "other");
			totals.placements[source[k]] = (totals.placements[source[k]] || 0) + 1;
		});
	}

	if (!candidates.length) return;

	/* second pass: the flood, if any, inside the window */
	for (let i = 0; i < records.length; i++) {
		let open = candidates.filter(c => i > c.index && c.flood === null &&
			records[i].time - c.time <= FLOOD_WINDOW);
		if (open.length) {
			for (let ev of terrain_events(records[i])) {
				if (ev.terrain !== 1) continue;
				for (let c of open)
					if (c.x === ev.x && c.y === ev.y) c.flood = (records[i].time - c.time) / 50;
			}
		}
	}

	for (let c of candidates) {
		let entry = cell(`${c.occupant}|${c.ground}|${c.kind}`);
		entry.n++;
		if (c.flood !== null) {
			entry.flooded++;
			entry.delays.push(c.flood);
		}
	}
}

let files = [...walk(ROOT)];
if (!files.length) {
	console.log(`no logs found under ${ROOT}`);
	process.exit(1);
}
for (let file of files) scan(file);

const median = xs => xs.length ? xs.slice().sort((a, b) => a - b)[xs.length >> 1].toFixed(2) + "s" : "-";

console.log("======================================================================");
console.log(`${totals.logs} logs, ${totals.records.toLocaleString()} records, ${totals.unreadable} unreadable`);
console.log(`crater events landing on a grounded pill: ${totals.crater_on_pill}`);
console.log(`...of those, on a square beside water: ${totals.beside_water}`);
console.log();
console.log("Craters on a square that is neither water nor already a crater, with a");
console.log("water neighbour. A flood is a 6 1 on the square within 3 s.");
console.log();
console.log(`    ${"square".padEnd(18)} ${"kind".padEnd(5)} ${"n".padStart(5)}  ${"flooded".padStart(8)}  rate   median`);
const rank = ["no pill", "dead pill", "live pill"];
let rows = [...cells.entries()].sort((a, b) => {
	let [oa, ga, ka] = a[0].split("|"), [ob, gb, kb] = b[0].split("|");
	return rank.indexOf(oa) - rank.indexOf(ob) || ga.localeCompare(gb) || ka.localeCompare(kb);
});
for (let [key, v] of rows) {
	let [occupant, ground, kind] = key.split("|");
	console.log(`    ${(occupant + ", " + ground).padEnd(18)} ${kind.padEnd(5)} ${String(v.n).padStart(5)}  ` +
		`${String(v.flooded).padStart(8)}  ${(100 * v.flooded / v.n).toFixed(0).padStart(4)}%  ${median(v.delays)}`);
}
console.log();
console.log("How far the pill positions can be trusted: Bolo refuses an LGM build on a");
console.log("square holding a pill, so a build on one convicts our placement.");
console.log();
console.log(`    build events (boat/road/building/tree): ${totals.builds.toLocaleString()}`);
console.log(`    ...on a square where we believe a pill sits: ${totals.builds_on_believed_pill}` +
	` (${(100 * totals.builds_on_believed_pill / Math.max(1, totals.builds)).toFixed(3)}%)`);
for (let src of Object.keys(totals.placements).sort())
	console.log(`      ${src.padEnd(20)} ${String(totals.placements[src]).padStart(6)} placements, ` +
		`${totals.bad_builds[src] || 0} impossible builds`);
for (let src of Object.keys(totals.case_sources).sort())
	console.log(`      of the pill cases above, ${String(totals.case_sources[src]).padStart(3)} came from a ${src}`);
console.log(`    impossible builds landing on one of those very squares: ${totals.bad_builds_on_cases}`);
console.log("======================================================================");
