#!/usr/bin/env node
/* What kills a man?  The log carries no cause with an LGM death (`F5`, or
 * `FF 51` when he carried a pill), only his square; and the same record
 * restates his position just ahead of the event, pixel-precise.  This
 * classifies each death by what the log shows arriving at that position in
 * the preceding 30 ticks, so the owner's list of killers in GAMEPLAY.md can
 * be checked against replays.  In priority order:
 *
 *   pill hit      -- a `9n` on a grounded pill on his square
 *   square hit    -- an explosion on his square that leaves a shot building,
 *                    fells forest, or changes nothing (a building took it)
 *   base hit      -- an `An` on a base on his square
 *   shell fall    -- an `FB` whose terminal point is within 12 px of him;
 *                    "open ground" when nothing sits on his square, and
 *                    "on a structure square" when a pill, building or forest
 *                    does, since either could have taken the shell
 *   tank hit      -- an `FC` on a tank (his own or anyone's) whose centre is
 *                    within 20 px of him, the shell having ended against it
 *   crater nearby -- a crater or superboom on or beside his square
 *   nothing       -- none of the above
 *
 * Events repeat across records for reliability and senders lag each other
 * by a ring cycle, so the window is generous and a killer is often logged
 * a cycle before the death.  `node tools/measure-lgm-killers.cjs [root]`,
 * with --samples listing the tank-hit, base-hit and unexplained deaths. */
const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const { replay_label } = require("./corpus.cjs");

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const SAMPLES = process.argv.includes("--samples");
const ROOT = args[0] || require("./corpus.cjs").corpus_root();

const BEFORE = 30, AFTER = 5;
const FALL_PX = 12, TANK_PX = 20;
const MAP_SIZE = BoloGame.MAP_SIZE;
const CLASSES = [
	"pillbox on his square hit",
	"building or forest on his square hit",
	"base on his square hit",
	"shell fall on open ground",
	"shell fall, on a structure square",
	"shell hit his own tank beside him",
	"shell hit another tank beside him",
	"crater or superboom on or beside his square",
	"nothing found",
];

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

const fmt = t => `${Math.floor(t / 3000)}:${((t % 3000) / 50).toFixed(1).padStart(4, "0")}`;
const totals = { logs: 0, unreadable: 0, deaths: 0, no_restatement: 0 };
const tally = Object.fromEntries(CLASSES.map(c => [c, 0]));
const samples = [];

function classify(recs, game, i, rec, sub) {
	let man = rec.subpackets.find(s => s.type === "lgm_position");
	if (!man) return null;
	let mx = man.x * 16 + man.pixelX + 8, my = man.y * 16 + man.pixelY + 8;
	let st = BoloGame.state_at(game, rec.time - 1).state;
	let ter = st.grid[sub.y * MAP_SIZE + sub.x];
	let pill = st.pills.find(p => p.inTank === null && p.x === sub.x && p.y === sub.y);
	let base = st.bases.findIndex(b => b.x === sub.x && b.y === sub.y);
	let structure = pill || ter === 0 || ter === 8 || ter === 5 || ter === 13;
	let T = rec.time;
	let best_fall = Infinity, pill_hit = false, sq_hit = false, base_hit = false, boom = false;
	let hits = [];
	for (let j = i; j >= 0 && recs[j].time >= T - BEFORE; j--) look(recs[j]);
	for (let j = i + 1; j < recs.length && recs[j].time <= T + AFTER; j++) look(recs[j]);
	function look(r) {
		let dt = r.time - T;
		for (let s of r.subpackets) {
			if (s.type === "shell_falls") {
				let d = Math.hypot(s.x * 16 + (s.pixel & 15) + 8 - mx, s.y * 16 + (s.pixel >> 4) + 8 - my);
				best_fall = Math.min(best_fall, d);
			} else if (s.type === "pillbox_damage") {
				if (pill && st.pills[s.pillbox] === pill) pill_hit = true;
			} else if (s.type === "base_damage") {
				if (s.base === base) base_hit = true;
			} else if (s.type === "explosion") {
				let d = Math.max(Math.abs(s.x - sub.x), Math.abs(s.y - sub.y));
				if (d === 0 && (s.code === 7 || s.code === 8 || s.code === 0xb)) sq_hit = true;
				if (d <= 1 && (s.code === 3 || s.code === 0xd)) boom = true;
			} else if (s.type === "tank_hit") {
				let t = BoloGame.state_at(game, r.time).state.tanks[s.tank];
				if (!t) continue;
				let d = Math.hypot(t.x * 16 + t.px + 8 - mx, t.y * 16 + t.py + 8 - my);
				if (d <= TANK_PX) hits.push({ dt, tank: s.tank, d });
			}
		}
	}
	let cls;
	if (pill_hit) cls = CLASSES[0];
	else if (sq_hit) cls = CLASSES[1];
	else if (base_hit) cls = CLASSES[2];
	else if (best_fall <= FALL_PX) cls = structure ? CLASSES[4] : CLASSES[3];
	else if (hits.length) cls = hits.some(h => h.tank === rec.player) ? CLASSES[5] : CLASSES[6];
	else if (boom) cls = CLASSES[7];
	else cls = CLASSES[8];
	let detail = hits.map(h => `tank ${h.tank} ${h.d.toFixed(1)} px at ${h.dt}t`).join("; ");
	if (base_hit) detail = `base ${base} hit`;
	return { cls, detail, terrain: ter, pill: !!pill };
}

function scan(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		totals.unreadable++;
		return;
	}
	if (!recs.length) { totals.unreadable++; return; }
	let game;
	try {
		game = BoloGame.build(recs);
	} catch {
		totals.unreadable++;
		return;
	}
	totals.logs++;
	let t0 = recs[0].time;
	for (let i = 0; i < recs.length; i++) {
		let rec = recs[i];
		for (let sub of rec.subpackets) {
			if (sub.type !== "lgm_death" && sub.type !== "pill_dumped_by_dead_lgm") continue;
			totals.deaths++;
			let r = classify(recs, game, i, rec, sub);
			if (!r) { totals.no_restatement++; continue; }
			tally[r.cls]++;
			if (SAMPLES && (r.cls === CLASSES[2] || r.cls === CLASSES[5] || r.cls === CLASSES[6] || r.cls === CLASSES[8])) {
				samples.push(`${replay_label(file)} ${fmt(rec.time - t0)} p${rec.player} ${sub.type === "lgm_death" ? "F5" : "FF51"} at ${sub.x},${sub.y}: ${r.cls}${r.detail ? " [" + r.detail + "]" : ""}`);
			}
		}
	}
}

let files = [...walk(ROOT)];
if (!files.length) {
	console.log(`no logs found under ${ROOT}`);
	process.exit(1);
}
for (let file of files) scan(file);

console.log("======================================================================");
console.log(`${totals.logs} logs, ${totals.unreadable} unreadable`);
console.log(`LGM deaths: ${totals.deaths}, ${totals.no_restatement} without the man's position in the same record`);
console.log();
console.log(`Killer found within ${BEFORE} ticks before the death (shell fall within ${FALL_PX} px, tank hit within ${TANK_PX} px):`);
console.log();
for (let c of CLASSES) console.log(`${String(tally[c]).padStart(6)}  ${c}`);
if (SAMPLES && samples.length) {
	console.log();
	console.log("Samples:");
	for (let s of samples) console.log("    " + s);
}
