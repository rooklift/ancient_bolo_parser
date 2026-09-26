#!/usr/bin/env node
/* Does a superboom (`7D`) catch a parked boat?
 *
 * The four-square superboom of a dying tank spares open water, and WinBolo's
 * big explosion spares BOAT as well.  A single `7 3` crater does NOT spare a
 * boat: it craters and then floods [E:crater-water].  Which way does the
 * superboom go?  Find every `7D` whose four squares include a square the
 * model believes holds a boat, then read what happens to that square next:
 *
 *   a `6 1` within ~1 s   =>  the boat was cratered and the crater flooded
 *   a later `7 1`, a boarding, or a tank in a boat sitting there
 *                         =>  the boat survived
 *
 * Usage: node tools/measure-superboom-boat.cjs [root ...]
 */
const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const ROOTS = args.length ? args : [require("./corpus.cjs").corpus_root()];

const MAP_SIZE = BoloGame.MAP_SIZE;
const WINDOW = 500;   /* 10 s of follow-up */

const tank_square = t => ({x: (t.x * 16 + t.px + 8) >> 4, y: (t.y * 16 + t.py + 8) >> 4});

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
		else if (entry.isFile() && !/\.(txt|md|json|zip|sit|hqx|png|jpg|gif|py|cjs|js)$/i.test(entry.name))
			yield item;
	}
}

const totals = {logs: 0, unreadable: 0, superbooms: 0, squares: 0, boat_squares: 0, river_squares: 0};
const cases = [];
/* control: every superboom square by what lay under it, and whether a 6 1
 * followed within 60 ticks */
const control = new Map();
function control_cell(key) {
	if (!control.has(key)) control.set(key, {n: 0, flooded: 0, delays: []});
	return control.get(key);
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

	let state = BoloGame.initial_state(BoloGame.extract_initial_map(records));
	let open = [];
	let ctrl = [];
	let all_ctrl = [];

	for (let i = 0; i < records.length; i++) {
		let rec = records[i];

		/* follow-ups on open cases, before this record is applied */
		for (let c of open) {
			if (rec.time - c.time > WINDOW) { c.done = true; continue; }
			for (let sub of rec.subpackets) {
				if ((sub.type === "terrain_change" || sub.type === "explosion") && sub.x === c.x && sub.y === c.y) {
					let code = sub.type === "terrain_change" ? `6 ${sub.terrain.toString(16)}` : `7 ${sub.code.toString(16)}`;
					c.after.push(`${code} @+${rec.time - c.time}t (sender ${rec.player})`);
				}
				if (sub.type === "board_boat") {
					let t = state.tanks[rec.player];
					if (t) {
						let sq = tank_square(t);
						if (sq.x === c.x && sq.y === c.y) c.after.push(`F6 boarding @+${rec.time - c.time}t (player ${rec.player})`);
					}
				}
			}
			/* a tank in a boat sitting on the square */
			for (let [pl, t] of Object.entries(state.tanks)) {
				if (!t || t.dying || !t.inBoat) continue;
				let sq = tank_square(t);
				if (sq.x === c.x && sq.y === c.y && !c.sat.has(pl)) {
					c.sat.add(pl);
					c.after.push(`tank ${pl} in boat on square @+${rec.time - c.time}t`);
				}
			}
		}
		open = open.filter(c => !c.done);
		for (let k of ctrl) {
			if (rec.time - k.time > 60) { k.done = true; continue; }
			for (let sub of rec.subpackets)
				if (sub.type === "terrain_change" && sub.terrain === 1 && sub.x === k.x && sub.y === k.y && k.flood === null)
					k.flood = rec.time - k.time;
		}
		ctrl = ctrl.filter(k => !k.done);

		for (let sub of rec.subpackets) {
			if (sub.type !== "explosion" || sub.code !== 0x0d) continue;
			totals.superbooms++;
			for (let [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
				let x = sub.x + dx, y = sub.y + dy;
				if (x >= MAP_SIZE || y >= MAP_SIZE) continue;
				totals.squares++;
				let under = state.grid[y * MAP_SIZE + x];
				if (under === 1) totals.river_squares++;
				let neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([nx, ny]) => {
					let t = state.grid[(y + ny) * MAP_SIZE + x + nx];
					return t === BoloGame.DEEP_SEA ? "sea" : t;
				});
				let beside_water = neighbours.some(t => t === "sea" || t === 1 || t === 9);
				let cls = under === 9 ? "boat" : under === 1 ? "river" : under === BoloGame.DEEP_SEA ? "deep sea"
					: under === 3 ? "crater already"
					: state.pills.some(p => p.inTank === null && p.x === x && p.y === y) ? "pill square"
					: state.bases.some(b => b.x === x && b.y === y) ? "base square"
					: beside_water ? "land beside water" : "land inland";
				let k = {key: cls, x, y, time: rec.time, flood: null, done: false};
				ctrl.push(k);
				all_ctrl.push(k);
				if (under !== 9) continue;
				totals.boat_squares++;
				let c = {
					file: path.relative(path.join(__dirname, "..", ".."), file), index: i, time: rec.time,
					sender: rec.player, boom: [sub.x, sub.y], offset: [dx, dy], x, y,
					neighbours, after: [], sat: new Set(), done: false,
				};
				cases.push(c);
				open.push(c);
			}
		}

		BoloGame.apply_record(state, rec, null, null);
	}
	for (let k of ctrl) k.done = true;
	for (let k of all_ctrl) {
		let cell = control_cell(k.key);
		cell.n++;
		if (k.flood !== null) { cell.flooded++; cell.delays.push(k.flood); }
	}
}

let files = [];
for (let root of ROOTS) files.push(...walk(root));
if (!files.length) {
	console.log(`no logs found under ${ROOTS.join(", ")}`);
	process.exit(1);
}
for (let file of files) scan(file);

console.log("======================================================================");
console.log(`${totals.logs} logs (${totals.unreadable} unreadable), ${totals.superbooms} superbooms, ${totals.squares} squares`);
console.log(`squares under a superboom that the model calls river: ${totals.river_squares}`);
console.log(`squares under a superboom that the model calls BOAT:  ${totals.boat_squares}`);
console.log();
console.log("Control: every superboom square by what the model says lay under it, and");
console.log("whether an explicit 6 1 (flood) landed on it within 60 ticks.");
console.log();
for (let [key, v] of [...control.entries()].sort((a, b) => b[1].n - a[1].n)) {
	let d = v.delays.slice().sort((a, b) => a - b);
	let range = d.length ? `${d[0]}-${d[d.length - 1]}t` : "-";
	console.log(`    ${key.padEnd(20)} ${String(v.n).padStart(6)}  flooded ${String(v.flooded).padStart(5)}  ${(100 * v.flooded / v.n).toFixed(0).padStart(4)}%  ${range}`);
}
console.log();
for (let c of cases) {
	console.log(`${c.file}`);
	console.log(`    record ${c.index}, tick ${c.time}, 7D at ${c.boom.join(",")} by player ${c.sender}; boat at ${c.x},${c.y} (offset ${c.offset.join(",")})`);
	console.log(`    orthogonal neighbours (E W S N): ${c.neighbours.join(" ")}`);
	if (!c.after.length) console.log(`    nothing on that square in the next ${WINDOW / 50} s`);
	for (let a of c.after) console.log(`    ${a}`);
}
console.log("======================================================================");
