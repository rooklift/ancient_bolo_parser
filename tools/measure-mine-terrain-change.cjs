#!/usr/bin/env node
/* Does a mine survive a `6T` terrain change, and does a pill planted on
 * a mined square come up live?
 *
 * A `6T` never carries a mined code ([E:mine-persists]), so a change
 * onto a mined square leaves the mine's fate unstated. The viewer keeps
 * the mine only when forest grows over mined grass and applies every
 * other change as sent. The log can separate the two readings after the
 * fact: a mine that survived the change shows itself when the square
 * later detonates (a `7 3` there with no mine laid on the square in
 * between), and a mine the change set off shows itself as a `7 3` on the
 * square within a second of the change. A square that does neither says
 * nothing.
 *
 * For every `6T` landing on a square the model holds mined, bucketed by
 * the terrain before and after:
 *
 *   soon   a `7 3` on the square within 100 ticks of the change -- the
 *          change set the mine off;
 *   later  the square's next `7 3` comes later than that, with no tank
 *          `F7` centred on the square and no `7C` there in between --
 *          the mine survived the change and killed something afterwards;
 *   relaid a later `7 3`, but a mine was laid on the square first, so it
 *          proves nothing;
 *   quiet  no `7 3` ever follows.
 *
 * Under a preserve-the-mine reading, `later` should be common and `soon`
 * rare for the changes that do not disturb the ground (forest growing,
 * a tree harvested); under an apply-as-sent reading `later` should be
 * empty, since the square would hold no mine to go off.
 *
 * The same test is run for `FF 50` plants on a mined square: a `7 3` on
 * the square within 100 ticks says the plant set the mine off, and an
 * `F5` or `FF 51` from the planter inside the same window says the
 * blast killed his man.
 *
 * Usage: node tools/measure-mine-terrain-change.cjs [file | directory]
 * With no argument the corpus root from corpus.json / BOLO_CORPUS is read.
 */
const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const {corpus_root, replay_label} = require("./corpus.cjs");

const SOON_TICKS = 100;
const SAMPLE_CASES = 30;
const NAMES = ["building", "river", "swamp", "crater", "road", "forest", "rubble", "grass",
	"shot building", "boat", "mined swamp", "mined crater", "mined road", "mined forest",
	"mined rubble", "mined grass"];

function name(t) {
	return NAMES[t] || `terrain ${t}`;
}

let buckets = new Map();   /* "from -> to" -> {count, soon, later, relaid, quiet} */
let plants = {count: 0, soon: 0, man_died: 0, quiet: 0};
let changes_total = 0;
let plants_total = 0;
let logs_scanned = 0;
let samples = [];
let plant_samples = [];

function bucket(key) {
	if (!buckets.has(key)) buckets.set(key, {count: 0, soon: 0, later: 0, relaid: 0, quiet: 0});
	return buckets.get(key);
}

function scan(file, recs) {
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));
	let label = replay_label(file);
	let candidates = [];   /* {time, x, y, from, to} */
	let plant_candidates = []; /* {time, x, y, player} */
	let craters = [];      /* {time, x, y} for every `7 3` */
	let mines_laid = [];   /* {time, x, y} for every `F7` (tank centre) and `7C` */
	let man_deaths = [];   /* {time, player} for every F5 / FF 51 */
	logs_scanned++;

	for (const rec of recs) {
		let tank = state.tanks[rec.player];
		for (const sub of rec.subpackets) {
			if (sub.type === "terrain_change") {
				changes_total++;
				let before = state.grid[sub.y * 256 + sub.x];
				if (before >= 10 && before <= 15) {
					candidates.push({time: rec.time, x: sub.x, y: sub.y, from: before, to: sub.terrain});
				}
			} else if (sub.type === "pill_plant") {
				plants_total++;
				let before = state.grid[sub.y * 256 + sub.x];
				if (before >= 10 && before <= 15) {
					plant_candidates.push({time: rec.time, x: sub.x, y: sub.y, player: rec.player, from: before});
				}
			} else if (sub.type === "explosion") {
				if (sub.code === 3) craters.push({time: rec.time, x: sub.x, y: sub.y});
				else if (sub.code === 0x0c) mines_laid.push({time: rec.time, x: sub.x, y: sub.y});
			} else if (sub.type === "lay_mine") {
				if (tank) {
					let x = (tank.x * 16 + tank.px + 8) >> 4;
					let y = (tank.y * 16 + tank.py + 8) >> 4;
					mines_laid.push({time: rec.time, x, y});
				}
			} else if (sub.type === "lgm_death" || sub.type === "pill_dumped_by_dead_lgm") {
				man_deaths.push({time: rec.time, player: rec.player});
			}
		}
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
	}

	for (const c of candidates) {
		let key = `${name(c.from)} -> ${name(c.to)}`;
		let b = bucket(key);
		b.count++;
		let next = craters.find(e => e.x === c.x && e.y === c.y && e.time > c.time);
		let verdict;
		if (!next) {
			b.quiet++;
			verdict = "quiet";
		} else if (next.time - c.time <= SOON_TICKS) {
			b.soon++;
			verdict = `soon (+${next.time - c.time})`;
		} else if (mines_laid.some(m => m.x === c.x && m.y === c.y && m.time > c.time && m.time < next.time)) {
			b.relaid++;
			verdict = "relaid";
		} else {
			b.later++;
			verdict = `later (+${next.time - c.time})`;
		}
		if (verdict !== "quiet" && verdict !== "relaid" && samples.length < SAMPLE_CASES) {
			samples.push(`${label} t${c.time} (${c.x},${c.y}) ${key}: ${verdict}`);
		}
	}

	for (const p of plant_candidates) {
		plants.count++;
		let next = craters.find(e => e.x === p.x && e.y === p.y && e.time > p.time && e.time - p.time <= SOON_TICKS);
		let died = man_deaths.find(d => d.player === p.player && d.time >= p.time && d.time - p.time <= SOON_TICKS);
		if (next) plants.soon++; else plants.quiet++;
		if (died) plants.man_died++;
		if (plant_samples.length < SAMPLE_CASES) {
			plant_samples.push(`${label} t${p.time} (${p.x},${p.y}) on ${name(p.from)}: ` +
				(next ? `7 3 at +${next.time - p.time}` : "no 7 3") +
				(died ? `, planter's man died at +${died.time - p.time}` : ""));
		}
	}
}

function report() {
	console.log("=".repeat(70));
	console.log(`${logs_scanned} logs, ${changes_total.toLocaleString()} terrain changes, ` +
		`${[...buckets.values()].reduce((a, b) => a + b.count, 0)} onto a mined square; ` +
		`${plants_total.toLocaleString()} pill plants, ${plants.count} onto a mined square`);
	console.log();
	console.log("Terrain changes onto a mined square, by the terrain before and after:");
	console.log("  soon = a `7 3` there within 100 ticks (the change set the mine off);");
	console.log("  later = the next `7 3` there came later, no mine laid on the square between");
	console.log("  (the mine survived the change); relaid = a mine was laid there first;");
	console.log("  quiet = no `7 3` ever followed.");
	console.log();
	console.log(`    ${"change".padEnd(32)} ${"count".padStart(6)} ${"soon".padStart(6)} ${"later".padStart(6)} ${"relaid".padStart(6)} ${"quiet".padStart(6)}`);
	let rows = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
	for (const [key, b] of rows) {
		console.log(`    ${key.padEnd(32)} ${String(b.count).padStart(6)} ${String(b.soon).padStart(6)} ` +
			`${String(b.later).padStart(6)} ${String(b.relaid).padStart(6)} ${String(b.quiet).padStart(6)}`);
	}
	console.log();
	console.log("Cases with a following `7 3` (capped):");
	for (const s of samples) console.log(`    ${s}`);
	console.log();
	console.log(`Pill plants onto a mined square: ${plants.count}; ` +
		`a \`7 3\` there within 100 ticks: ${plants.soon}; the planter's man died within 100 ticks: ${plants.man_died}; ` +
		`no \`7 3\`: ${plants.quiet}`);
	for (const s of plant_samples) console.log(`    ${s}`);
	console.log("=".repeat(70));
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
