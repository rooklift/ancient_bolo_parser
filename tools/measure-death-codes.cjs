#!/usr/bin/env node
/* What do the three `F9` codes mean?
 *
 * FORMAT.md has long read them as 1 = explosion, 2 = crater, 3 = sunk.
 * Work on another Bolo project suggests instead:
 *
 *   1  a new death on land
 *   2  the wreck of a tank ALREADY dead (the sliding, burning trail of dying
 *      positions after an `F901`) sinking
 *   3  a new death by sinking
 *
 * Each claim is tested here against the log.  A death is OPEN from its first
 * `F9` until the player's next position without the dying bit (the respawn);
 * tank positions precede events within a record, so a record carrying a
 * respawn and a new `F9` closes the old death before opening the new one.  A
 * tank that respawns and sits still logs no position, so a death still open
 * RESPAWN_MIN ticks on is taken to have ended when the next non-2 code comes.
 *
 *   code 2  should only ever follow an `F901` in a death still open, and the
 *           wreck should be on (or, since the trail is logged only every 5-15
 *           ticks, about to reach) deep sea when it arrives.  The last two
 *           dying positions are extrapolated to the `F902`'s tick for that.
 *           A wreck that sinks should get no terminal crater (`7 3` / `7D`
 *           from the dying player within CRATER_WINDOW ticks of the opening
 *           `F9`): cratering spares open water [E:crater-water].  The trail
 *           should stop at the `F902`.
 *   control F901 deaths WITHOUT an `F902` whose trail nonetheless reaches
 *           deep sea are counterexamples; so are trails that end in river
 *           only, if river turns out to sink wrecks too.
 *   code 1  should open a death, with the tank on land.
 *   code 3  should open a death, never follow one, with the tank last seen
 *           on or beside deep sea (in a boat, or driven off a shore), or in
 *           the map's mined border band [E:dump-terrain].
 *
 * Counts are per recording: a game recorded twice (fixtures/pairs) counts
 * twice.
 *
 * Usage: node tools/measure-death-codes.cjs [--examples=N] [root ...]
 * With no path the corpus root from corpus.json / BOLO_CORPUS is read.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const {corpus_root, replay_label} = require("./corpus.cjs");

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const ROOTS = args.length ? args : [corpus_root()];
const examples_arg = process.argv.find(a => a.startsWith("--examples="));
const MAX_EXAMPLES = examples_arg ? Number(examples_arg.slice(11)) : 12;

const MAP_SIZE = BoloGame.MAP_SIZE;
const DEEP_SEA = BoloGame.DEEP_SEA;
const RIVER = 1, BOAT = 9;
const CRATER_WINDOW = 60;     /* ticks after the opening F9: the terminal crater arrives at 48-50 [E:death-tiers] */
const EXTRAPOLATE_MAX = 30;   /* ticks a wreck is projected past its last logged position */
const RESPAWN_MIN = 250;      /* ticks: no respawn comes sooner [E:respawn-gap] */
const EDGE = 10;              /* the mined border: the outermost ten rows and columns [E:dump-terrain] */
const TERRAIN_NAMES = ["building", "river", "swamp", "crater", "road", "forest", "rubble", "grass",
	"shot building", "boat", "mined swamp", "mined crater", "mined road", "mined forest", "mined rubble", "mined grass"];

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, {withFileTypes: true});
	} catch {
		if (fs.existsSync(dir) && fs.statSync(dir).isFile()) yield dir;
		return;
	}
	for (let entry of entries) {
		let item = path.join(dir, entry.name);
		if (entry.isDirectory())
			yield* walk(item);
		else if (entry.isFile() && !/\.(txt|md|json|zip|sit|hqx|png|jpg|gif|py|cjs|js)$/i.test(entry.name))
			yield item;
	}
}

/* ---- accumulators ---- */

let totals = {logs: 0, unreadable: 0, records: 0};
let tallies = new Map();       /* section -> Map(key -> n) */
let spans = new Map();         /* section -> [numbers] */
let examples = new Map();      /* kind -> [lines] */

function bump(section, key) {
	if (!tallies.has(section)) tallies.set(section, new Map());
	let m = tallies.get(section);
	m.set(key, (m.get(key) || 0) + 1);
}

function note(section, value) {
	if (!spans.has(section)) spans.set(section, []);
	spans.get(section).push(value);
}

function example(kind, line) {
	if (!examples.has(kind)) examples.set(kind, {n: 0, lines: []});
	let e = examples.get(kind);
	e.n++;
	if (e.lines.length < MAX_EXAMPLES) e.lines.push(line);
}

/* ---- terrain helpers ---- */

function terrain(grid, sx, sy) {
	if (sx < 0 || sy < 0 || sx >= MAP_SIZE || sy >= MAP_SIZE) return DEEP_SEA;
	return grid[sy * MAP_SIZE + sx];
}

function terrain_name(t) {
	if (t === DEEP_SEA) return "deep sea";
	return TERRAIN_NAMES[t] || `terrain ${t}`;
}

/* land / river / boat / deep sea: the classes the question turns on */
function terrain_class(t) {
	if (t === DEEP_SEA) return "deep sea";
	if (t === RIVER) return "river";
	if (t === BOAT) return "boat";
	return "land";
}

function deep_sea_within(grid, sx, sy, r) {
	for (let dy = -r; dy <= r; dy++)
		for (let dx = -r; dx <= r; dx++)
			if (terrain(grid, sx + dx, sy + dy) === DEEP_SEA) return true;
	return false;
}

function in_edge_band(sx, sy) {
	return sx < EDGE || sy < EDGE || sx >= MAP_SIZE - EDGE || sy >= MAP_SIZE - EDGE;
}

function centre(sub) {
	return {x: sub.x * 16 + sub.pixelX + 8, y: sub.y * 16 + sub.pixelY + 8};
}

/* ---- per-log scan ---- */

function scan(file) {
	let buf;
	let records;
	try {
		buf = fs.readFileSync(file);
		records = [...BoloLog.records(new Uint8Array(buf))];
	} catch {
		totals.unreadable++;
		return;
	}
	if (!records.length) return;
	totals.logs++;
	totals.records += records.length;
	let label = replay_label(file);

	let node_joins = BoloGame.classify_node_joins(records);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(records, node_joins));
	let grid = state.grid;
	let open = new Array(16).fill(null);          /* the death in progress, per player */
	let last_live = new Array(16).fill(null);     /* last position without the dying bit */

	let where = (rec, index) => `${label} record ${index} tick ${rec.time} player ${rec.player}`;

	let close = (pl) => {
		let d = open[pl];
		open[pl] = null;
		if (!d) return;
		let crater = d.crater ? "terminal crater" : "no crater";
		let codes = d.codes.join("+");
		/* the trail: where the wreck went, by the class of square under its centre */
		let classes = new Set(d.trail.map(p => p.cls));
		let reached = classes.has("deep sea") ? "trail reaches deep sea"
			: classes.has("river") || classes.has("boat") ? "trail reaches river/boat, not deep sea"
			: d.trail.some(p => p.near_sea) ? "trail within 1 square of deep sea"
			: d.trail.length ? "trail on land only" : "no trail logged";
		bump("deaths", `${codes.padEnd(12)} | ${crater.padEnd(15)} | ${reached}`);
		if (d.codes[0] === 1 && !d.codes.includes(2) && classes.has("deep sea"))
			example("F901 whose wreck reached deep sea, with no F902", `${d.where}; trail ${d.trail.map(p => `${p.t - d.t0}:${p.name}(${p.sx},${p.sy})`).join(" ")}`);
		if (d.codes.includes(2) && d.crater)
			example("F902 death that still got a terminal crater", d.where);
		if (d.codes[0] === 3 && d.trail.length)
			bump("code 3 trail", `dying positions logged after it: ${d.trail.length > 3 ? "4+" : d.trail.length}`);
		else if (d.codes[0] === 3)
			bump("code 3 trail", "dying positions logged after it: none");
	};

	for (let index = 0; index < records.length; index++) {
		let rec = records[index];
		let pl = rec.player;

		for (let sub of rec.subpackets) {
			if (sub.type === "tank_position") {
				let c = centre(sub);
				let sx = c.x >> 4, sy = c.y >> 4;
				let t = terrain(grid, sx, sy);
				if (!sub.dying) {
					close(pl);
					last_live[pl] = {t: rec.time, sx, sy, terrain: t, in_boat: sub.inBoat, x: c.x, y: c.y};
					continue;
				}
				let d = open[pl];
				if (!d) continue;
				if (d.sunk_at !== null) {
					d.after_sink++;
					if (d.after_sink === 1)
						example("dying position logged after an F902", `${where(rec, index)} +${rec.time - d.sunk_at}t on ${terrain_name(t)}`);
					continue;
				}
				d.trail.push({t: rec.time, x: c.x, y: c.y, sx, sy, cls: terrain_class(t), name: terrain_name(t),
					near_sea: deep_sea_within(grid, sx, sy, 1)});
			} else if (sub.type === "tank_death") {
				bump("codes", `code ${sub.code}`);
				let d = open[pl];
				let unlogged_respawn = false;
				if (sub.code !== 2 && d && rec.time - d.t0 >= RESPAWN_MIN) {
					close(pl);
					d = null;
					unlogged_respawn = true;
				}
				if (sub.code !== 2) {
					if (d) {
						bump(`code ${sub.code}`, `follows an open death (codes so far ${d.codes.join("+")})`);
						example(`code ${sub.code} arriving in a death already open`, `${where(rec, index)} +${rec.time - d.t0}t after F90${d.codes[0]}`);
						d.codes.push(sub.code);
						continue;
					}
					bump(`code ${sub.code}`, unlogged_respawn ? "opens a death (the last one's respawn went unlogged)" : "opens a death");
					open[pl] = d = {t0: rec.time, codes: [sub.code], trail: [], crater: false, sunk_at: null, after_sink: 0,
						where: where(rec, index)};
					/* the tank as last seen: this record's own position, else the last live one */
					let own = rec.subpackets.find(s => s.type === "tank_position");
					let seen;
					if (own) {
						let c = centre(own);
						seen = {sx: c.x >> 4, sy: c.y >> 4, in_boat: own.inBoat, age: 0};
						if (own.dying) d.trail.push({t: rec.time, x: c.x, y: c.y, sx: seen.sx, sy: seen.sy,
							cls: terrain_class(terrain(grid, seen.sx, seen.sy)), name: terrain_name(terrain(grid, seen.sx, seen.sy)),
							near_sea: deep_sea_within(grid, seen.sx, seen.sy, 1)});
					} else if (last_live[pl]) {
						let l = last_live[pl];
						seen = {sx: l.sx, sy: l.sy, in_boat: l.in_boat, age: rec.time - l.t};
					}
					let section = `code ${sub.code} opener`;
					if (!seen) {
						bump(section, "tank never seen alive before it");
						continue;
					}
					let t = terrain(grid, seen.sx, seen.sy);
					let setting = in_edge_band(seen.sx, seen.sy) ? "in the mined border band"
						: t === DEEP_SEA ? "on deep sea"
						: deep_sea_within(grid, seen.sx, seen.sy, 1) ? `on ${terrain_class(t)}, deep sea within 1 square`
						: `on ${terrain_class(t)}, no deep sea within 1 square`;
					bump(section, `${seen.in_boat ? "in boat " : "on foot "} | ${setting}`);
					note(`${section} position age`, seen.age);
					if (sub.code === 3 && !in_edge_band(seen.sx, seen.sy) && !deep_sea_within(grid, seen.sx, seen.sy, 2))
						example("code 3 with no deep sea within 2 squares of the tank's last position",
							`${where(rec, index)} last seen ${seen.age}t earlier ${seen.in_boat ? "in a boat " : ""}on ${terrain_name(t)} (${seen.sx},${seen.sy})`);
					if (sub.code === 1 && seen.age <= 20 && t === DEEP_SEA)
						example("code 1 with the tank on deep sea", `${where(rec, index)} ${seen.in_boat ? "in a boat" : "not in a boat"} (${seen.sx},${seen.sy})`);
					continue;
				}

				/* code 2 */
				if (!d) {
					bump("code 2", "no death open (follows a respawn, or opens the log's view of the player)");
					example("code 2 with no death open", where(rec, index));
					continue;
				}
				bump("code 2", `follows an open death opened by code ${d.codes[0]}${d.codes.length > 1 ? ` (codes so far ${d.codes.join("+")})` : ""}`);
				note("code 2 delay", rec.time - d.t0);
				if (rec.time - d.t0 >= RESPAWN_MIN)
					example("code 2 arriving after the earliest respawn time", `${where(rec, index)} +${rec.time - d.t0}t after F90${d.codes[0]}`);
				if (d.codes.includes(2)) example("second code 2 in one death", where(rec, index));
				d.codes.push(2);
				d.sunk_at = rec.time;
				/* where is the wreck now?  extrapolate the last two trail points */
				let n = d.trail.length;
				if (!n) {
					bump("code 2 wreck", "no trail position to place it");
					continue;
				}
				let last = d.trail[n - 1];
				let x = last.x, y = last.y;
				let age = rec.time - last.t;
				if (n >= 2 && age > 0) {
					let prev = d.trail[n - 2];
					let dt = Math.max(1, last.t - prev.t);
					let ahead = Math.min(age, EXTRAPOLATE_MAX);
					x = last.x + (last.x - prev.x) / dt * ahead;
					y = last.y + (last.y - prev.y) / dt * ahead;
				}
				let sx = Math.floor(x) >> 4, sy = Math.floor(y) >> 4;
				let t = terrain(grid, sx, sy);
				let near = deep_sea_within(grid, sx, sy, 1);
				bump("code 2 wreck", `projected square: ${terrain_class(t).padEnd(8)} | deep sea within 1 square: ${near ? "yes" : "no"}`);
				bump("code 2 last logged", `last logged trail square: ${last.cls.padEnd(8)} | deep sea within 1 square: ${last.near_sea ? "yes" : "no"}`);
				note("code 2 last position age", age);
				if (!near)
					example("code 2 with no deep sea within 1 square of the projected wreck",
						`${where(rec, index)} +${rec.time - d.t0}t; trail ${d.trail.map(p => `${p.t - d.t0}:${p.name}(${p.sx},${p.sy})`).join(" ")}; projected ${terrain_name(t)}(${sx},${sy})`);
			} else if (sub.type === "explosion" && (sub.code === 3 || sub.code === 0x0d)) {
				let d = open[pl];
				if (d && rec.time - d.t0 <= CRATER_WINDOW) d.crater = true;
			}
		}

		BoloGame.apply_record(state, rec, null, null, null, node_joins);
	}
	for (let pl = 0; pl < 16; pl++) close(pl);
}

/* ---- run and report ---- */

let files = [];
for (let root of ROOTS) files.push(...walk(root));
if (!files.length) {
	console.log(`no logs found under ${ROOTS.join(", ")}`);
	process.exit(1);
}
for (let file of files) scan(file);

function print_section(section, title) {
	let m = tallies.get(section);
	console.log(`\n[${title}]`);
	if (!m) { console.log("  none"); return; }
	let total = [...m.values()].reduce((a, b) => a + b, 0);
	for (let [k, n] of [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)))
		console.log(`  ${String(n).padStart(7)} ${(100 * n / total).toFixed(1).padStart(5)}%  ${k}`);
}

function print_span(section, title) {
	let v = (spans.get(section) || []).slice().sort((a, b) => a - b);
	if (!v.length) return;
	let at = p => v[Math.min(v.length - 1, Math.floor((v.length - 1) * p))];
	console.log(`  ${title}: n ${v.length}, min ${v[0]}, 10% ${at(0.1)}, median ${at(0.5)}, 90% ${at(0.9)}, max ${v[v.length - 1]} ticks`);
}

console.log("======================================================================");
console.log(`${totals.logs} logs (${totals.unreadable} unreadable), ${totals.records} records`);

print_section("codes", "F9 codes seen");

print_section("code 1", "code 1: does it open a death?");
print_section("code 3", "code 3: does it open a death?");
print_section("code 2", "code 2: does it follow an open death?");
print_span("code 2 delay", "ticks from the opening F9 to the F902");

print_section("code 2 wreck", "code 2: the wreck, projected to the F902's tick from the last two trail positions");
print_section("code 2 last logged", "code 2: the last trail position actually logged");
print_span("code 2 last position age", "age of that position at the F902");

print_section("code 1 opener", "code 1: the tank when it died (this record's position, else its last live one)");
print_span("code 1 opener position age", "age of that position");
print_section("code 3 opener", "code 3: the tank when it died (this record's position, else its last live one)");
print_span("code 3 opener position age", "age of that position");
print_section("code 3 trail", "code 3: the wreck's trail");

print_section("deaths", `every death: its codes | a 7 3 / 7D from the dying player within ${CRATER_WINDOW} ticks | where the wreck's trail went`);

console.log("\n[counterexamples and oddities]");
if (!examples.size) console.log("  none");
for (let [kind, e] of examples) {
	console.log(`  ${kind}: ${e.n}`);
	for (let line of e.lines) console.log(`    ${line}`);
	if (e.n > e.lines.length) console.log(`    ... ${e.n - e.lines.length} more`);
}
console.log("======================================================================");
