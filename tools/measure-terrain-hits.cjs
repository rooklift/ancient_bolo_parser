#!/usr/bin/env node
/* What a shell does to the ground it ends on.
 *
 * FORMAT.md's Terrain section carried, untagged, the rules that shells pass
 * over open ground, are stopped by building, forest, shot building and
 * boat, and convert forest to grass and building to shot building in one
 * hit and shot building to rubble in four more. This tool reads those
 * rules off the logs so GAMEPLAY.md can carry them with a measurement:
 *
 *   transitions   every `7T` impact that names a new terrain other than a
 *                 crater, tallied as (terrain before -> terrain after), mines
 *                 ignored: these are shells ending against something
 *   craters       the `7 3` events by the terrain under them, mine bit
 *                 kept, and apart because they are not simply shell impacts:
 *                 on a mined square a mine going off, under a tank or a
 *                 shell; on an unmined one a dying tank's terminal crater
 *   no-change     every `7B` impact (explosion, terrain unchanged), tallied
 *                 by the terrain under it
 *   shot building the number of `7B` impacts a shot building takes between
 *                 the hit that made it and the hit that turns it to rubble,
 *                 split by whether every record carried one hit on the
 *                 square or some carried several (an angry pillbox's fire,
 *                 simulated and logged by the pill's target); and, for the
 *                 lives where a second `7 8` arrived on the already shot
 *                 building (a shell landing before its client had applied
 *                 the first), the hits taken before and after that repeat:
 *                 if the repeat restarts the count the hits after it sit at
 *                 three whatever came before, and if not the two add to three
 *   tanks         the terrain under every live tank's centre square: the
 *                 ground a tank can drive on
 *   shell falls   the terrain under every `FB` shell fall, the terminal
 *                 point of a shell that reached its full range: the ground
 *                 a shell flies over rather than into
 *
 * Squares holding a base are excluded from every tally, since a base's
 * square behaves as road whatever the map says [E:base-road].
 *
 * Usage: node tools/measure-terrain-hits.cjs [file | directory ...]
 * With no argument the corpus root from corpus.json / BOLO_CORPUS is read.
 * Every log scanned feeds one set of tables.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const {corpus_root} = require("./corpus.cjs");

const TERRAIN_NAMES = ["building", "river", "swamp", "crater", "road", "forest",
	"rubble", "grass", "shot building", "boat"];

function base_terrain(t) {
	return (t >= 10 && t <= 15) ? t - 8 : t;
}

function terrain_name(t) {
	if (t === BoloGame.DEEP_SEA) return "deep sea";
	return TERRAIN_NAMES[base_terrain(t)] || `t${t}`;
}

function mined_terrain_name(t) {
	return (t >= 10 && t <= 15 ? "mined " : "") + terrain_name(t);
}

function bump(map, key, by = 1) {
	map.set(key, (map.get(key) || 0) + by);
}

let transitions = new Map();      /* "before -> after" -> count, craters apart */
let craters = new Map();          /* terrain under a `7 3` -> count */
let no_change = new Map();        /* terrain under a `7B` -> count */
let falls = new Map();            /* terrain under an `FB` -> count */
let shot_building_hits = new Map(); /* hits between creation and rubble -> count */
let shot_building_hits_single = new Map(); /* the same, lives hit one shell per record */
let shot_building_hits_burst = new Map();  /* the same, some record carrying several */
let shot_building_repeats = 0;             /* lives that saw a second `7 8` */
let shot_building_hits_around_repeat = new Map(); /* "before/after the last repeat" -> count */
let shot_buildings_unfinished = 0;  /* shot buildings never seen to become rubble */
let under_tanks = new Map();        /* terrain under a live tank's centre square -> count */
let logs_scanned = 0;

function scan(file, recs) {
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));
	let base_here = (x, y) => state.bases.some(b => b.x === x && b.y === y);
	let terrain_at = (x, y) => state.grid[y * 256 + x];
	/* square index -> the `7B` hits taken since it became a shot building;
	 * only squares whose creation as a shot building was seen are tracked,
	 * so a square shot before logging began does not shorten the count */
	let shot_building_since = new Map();

	for (const rec of recs) {
		for (const sub of rec.subpackets) {
			if (sub.type === "tank_position") {
				if (rec.tankStatus & 0x4) continue; /* dead or dying */
				let x = (sub.x * 16 + sub.pixelX + 8) >> 4;
				let y = (sub.y * 16 + sub.pixelY + 8) >> 4;
				if (x < 0 || y < 0 || x > 255 || y > 255 || base_here(x, y)) continue;
				bump(under_tanks, terrain_name(terrain_at(x, y)));
			} else if (sub.type === "explosion") {
				if (sub.code === 0x0c || sub.code === 0x0d) continue;
				if (base_here(sub.x, sub.y)) continue;
				let before = terrain_at(sub.x, sub.y);
				let i = sub.y * 256 + sub.x;
				if (sub.code === 0x0b) {
					bump(no_change, terrain_name(before));
					let life = shot_building_since.get(i);
					if (life) {
						life.hits++;
						life.since_repeat++;
						life.this_record = life.record === rec ? life.this_record + 1 : 1;
						life.record = rec;
						life.burst = life.burst || life.this_record > 1;
					}
					continue;
				}
				if (sub.code === 3) bump(craters, mined_terrain_name(before));
				else bump(transitions, `${terrain_name(before)} -> ${terrain_name(sub.code)}`);
				if (sub.code === 8 && base_terrain(before) === 0) {
					shot_building_since.set(i, { hits: 0, since_repeat: 0, repeats: 0, record: null, this_record: 0, burst: false });
				} else if (sub.code === 8 && base_terrain(before) === 8 && shot_building_since.has(i)) {
					let life = shot_building_since.get(i);
					life.repeats++;
					life.since_repeat = 0;
				} else if (sub.code === 6 && base_terrain(before) === 8 && shot_building_since.has(i)) {
					let life = shot_building_since.get(i);
					bump(shot_building_hits, life.hits);
					bump(life.burst ? shot_building_hits_burst : shot_building_hits_single, life.hits);
					if (life.repeats) {
						shot_building_repeats++;
						bump(shot_building_hits_around_repeat, `${life.hits - life.since_repeat}/${life.since_repeat}`);
					}
					shot_building_since.delete(i);
				}
			} else if (sub.type === "terrain_change") {
				/* a build or a regrowth on a tracked shot building ends its
				 * life without a rubble hit; drop it rather than count it */
				let i = sub.y * 256 + sub.x;
				if (shot_building_since.has(i) && sub.terrain !== 8) shot_building_since.delete(i);
			} else if (sub.type === "shell_falls") {
				/* the terminal point needs the usual half-tile centring */
				let x = (sub.x * 16 + (sub.pixel & 0x0f) + 8) >> 4;
				let y = (sub.y * 16 + (sub.pixel >> 4) + 8) >> 4;
				if (x < 0 || y < 0 || x > 255 || y > 255 || base_here(x, y)) continue;
				bump(falls, terrain_name(terrain_at(x, y)));
			}
		}
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
	}
	shot_buildings_unfinished += shot_building_since.size;
	logs_scanned++;
}

function print_table(title, map, order) {
	console.log(`\n${title}`);
	let rows = [...map.entries()];
	rows.sort(order || ((a, b) => b[1] - a[1]));
	let width = Math.max(...rows.map(r => String(r[0]).length), 0);
	for (const [k, v] of rows) console.log(`  ${String(k).padEnd(width)}  ${v}`);
}

function report() {
	console.log(`\n${logs_scanned} log(s)`);
	print_table("shell impacts that change terrain (before -> after)", transitions);
	print_table("cratering events (`7 3`), by terrain under them: on a mined square a mine going off under a tank or a shell, on an unmined one a dying tank's crater", craters);
	print_table("shell impacts with no terrain change (`7B`), by terrain under them", no_change);
	print_table("`7B` hits a shot building took between its creation and its turning to rubble", shot_building_hits,
		(a, b) => a[0] - b[0]);
	print_table("  of which lives whose every record carried one hit on the square", shot_building_hits_single,
		(a, b) => a[0] - b[0]);
	print_table("  of which lives where some record carried several", shot_building_hits_burst,
		(a, b) => a[0] - b[0]);
	console.log(`  (${shot_buildings_unfinished} shot building(s) created but not seen turned to rubble)`);
	print_table(`  of which lives with a repeated \`7 8\` on the shot building (${shot_building_repeats}): \`7B\` hits before/after the last repeat`,
		shot_building_hits_around_repeat, (a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : b[1] - a[1]);
	print_table("terrain under `FB` shell falls (the ground a shell flies over)", falls);
	print_table("terrain under live tanks' centre squares (the ground a tank drives on)", under_tanks);
}

function* walk(target) {
	let st = fs.statSync(target);
	if (st.isFile()) { yield target; return; }
	for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
		let item = path.join(target, entry.name);
		if (entry.isDirectory()) yield* walk(item);
		else if (entry.isFile() && !/\.(txt|md|json|zip|sit|hqx|png|jpg|gif)$/i.test(entry.name))
			yield item;
	}
}

let args = process.argv.slice(2).filter(a => !a.startsWith("--"));
let targets = args.length ? args : [corpus_root()];
for (let target of targets) {
	for (let file of walk(target)) {
		let recs;
		try {
			recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
		} catch {
			continue;
		}
		if (recs.length < 2) continue;
		scan(file, recs);
	}
}
if (!logs_scanned) {
	console.error("no logs found");
	process.exit(2);
}
report();
