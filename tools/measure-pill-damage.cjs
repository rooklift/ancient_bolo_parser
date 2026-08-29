#!/usr/bin/env node
/* How much armour does a blast take off a pillbox?
 *
 * The `7D` superboom's pill damage is EVENTLESS -- no `9n` is sent -- so
 * the amount has never been measured, only bounded.  [E:superboom-pill]
 * rests on one pill at armour 8 that was picked up after four `9n`s, and
 * pickup needs armour 0; that says the blast did AT LEAST 4, and nothing
 * more.  WinBolo's `TK_DAMAGE` is 5 on the same 0-15 scale, so the number
 * in the docs is a lower bound wearing the costume of a measurement.
 *
 * TWO CONSTRAINTS make it measurable.  Pill armour is reconstructible from
 * events (`F1 02` initial list, -1 per `9n`, +4/+8/+12 or full per
 * `FF 1n`-`4n`), and the log then contradicts itself if the damage figure
 * is wrong, in two opposite directions:
 *
 *   a PICKUP (`FF 0n`) of a pill we think still has armour
 *       => our damage figure is too SMALL  (a lower bound)
 *   a pill FIRING (`F4 nd`) that we think is dead
 *       => our damage figure is too LARGE  (an upper bound)
 *
 * WinBolo confirms both gates: `pillsGetPos` takes a pill only at
 * `armour == 0`, and `pillsUpdate` fires one only while `armour > 0`.
 * The two constraints are independent -- different events, opposite
 * directions -- so they are counted and reported separately.  If they
 * bracket the same value, that value is the answer.
 *
 * TWO EXPERIMENTS, run side by side and never mixed.  The same machinery
 * measures a second unknown: whether the single crater `7 3` damages a
 * pill on its square at all (WinBolo's small explosion does not touch
 * pills, unlike its superboom).  An interval counts towards the superboom
 * experiment only if it contains superbooms and NO single craters, and
 * towards the crater experiment only if the reverse, so neither can
 * borrow the other's evidence.
 *
 * ONE NUISANCE PARAMETER.  A planted pill's armour (`FF 50`) is not in the
 * log either, and our viewer assumes 15.  Since a wrong value there would
 * forge exactly the same contradictions, it is swept as a second axis
 * rather than assumed, and the intervals that contain neither a boom nor a
 * crater measure it on its own.
 *
 * A pill in a tank sits at armour 0 (pickup requires it), so being carried
 * needs no special handling and where a dumped pill lands does not matter
 * here.  Positions come from viewer/game.js, whose placement model is
 * evidenced separately; only the armour arithmetic is redone here, so this
 * measurement does not inherit the engine's damage assumptions.
 *
 * Usage: node tools/measure-pill-damage.cjs [corpus-root]
 */
const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const ROOT = args[0] || require("./corpus.cjs").corpus_root();

const MAX_ARMOUR = 15;
const PLANT_VALUES = 16;        /* planted-pill armour P, 0..15 */
const DAMAGE_VALUES = 16;       /* blast damage d, 0..15 */
const CELLS = PLANT_VALUES * DAMAGE_VALUES;
const cell_index = (p, d) => p * DAMAGE_VALUES + d;

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

/* One family = one experiment: its own armour arithmetic, its own counters.
 * `blast` names the event whose damage it sweeps. */
function new_family(blast) {
	return {
		blast,
		/* contradictions[cell] for each constraint */
		pickup_live: new Float64Array(CELLS),
		dead_fired: new Float64Array(CELLS),
		events: 0,                      /* constraint events it could judge */
	};
}

const boom_family = new_family("7D superboom");
const crater_family = new_family("7 3 single crater");
/* intervals with neither blast: these measure the planted-pill armour and
 * the noise floor of the reconstruction, and do not depend on d */
const baseline = {pickup_live: new Float64Array(PLANT_VALUES), dead_fired: new Float64Array(PLANT_VALUES), events: 0};
const totals = {logs: 0, records: 0, unreadable: 0, pickups: 0, fires: 0, booms_on_pill: 0, craters_on_pill: 0};

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
	let count = 16;                        /* MAX_PILLS; nothing known yet */

	/* our own armour, one value per (P, d) cell, per family, per pill */
	let armour = {
		[boom_family.blast]: [],
		[crater_family.blast]: [],
	};
	let known = new Array(count).fill(false);
	let booms = new Int32Array(count);      /* blasts since the last anchor */
	let craters = new Int32Array(count);
	for (let i = 0; i < count; i++) {
		armour[boom_family.blast].push(new Uint8Array(CELLS));
		armour[crater_family.blast].push(new Uint8Array(CELLS));
	}

	const anchor = (i, value_of_cell) => {
		for (let p = 0; p < PLANT_VALUES; p++)
			for (let d = 0; d < DAMAGE_VALUES; d++) {
				let c = cell_index(p, d);
				let v = value_of_cell(p);
				armour[boom_family.blast][i][c] = v;
				armour[crater_family.blast][i][c] = v;
			}
		known[i] = true;
		booms[i] = 0;
		craters[i] = 0;
	};
	const adjust = (i, family, delta_of_cell) => {
		let a = armour[family.blast][i];
		for (let p = 0; p < PLANT_VALUES; p++)
			for (let d = 0; d < DAMAGE_VALUES; d++) {
				let c = cell_index(p, d);
				let v = a[c] + delta_of_cell(d);
				a[c] = v < 0 ? 0 : (v > MAX_ARMOUR ? MAX_ARMOUR : v);
			}
	};
	const both = (i, delta) => {
		adjust(i, boom_family, () => delta);
		adjust(i, crater_family, () => delta);
	};

	/* Nothing is anchored until the log's own `F1 02` list arrives, below.
	 * The map seed cannot serve: it rewrites the 0xff carried-pill sentinel
	 * as armour 15, an assumption this tool must not inherit. */

	/* Judge one constraint event. `alive` is what the event proves. */
	const judge = (i, alive) => {
		if (!known[i]) return;
		let family = null;
		if (booms[i] > 0 && craters[i] === 0) family = boom_family;
		else if (craters[i] > 0 && booms[i] === 0) family = crater_family;
		else if (booms[i] === 0 && craters[i] === 0) family = null;
		else return;                              /* mixed: no clean reading */

		if (family === null) {
			baseline.events++;
			for (let p = 0; p < PLANT_VALUES; p++) {
				let a = armour[boom_family.blast][i][cell_index(p, 0)];
				if (alive && a === 0) baseline.dead_fired[p]++;
				if (!alive && a > 0) baseline.pickup_live[p]++;
			}
			return;
		}
		family.events++;
		let a = armour[family.blast][i];
		for (let c = 0; c < CELLS; c++) {
			if (alive && a[c] === 0) family.dead_fired[c]++;
			if (!alive && a[c] > 0) family.pickup_live[c]++;
		}
	};

	for (let rec of records) {
		/* blasts first: a pill hit this record is already damaged when the
		 * record's own constraint events are read */
		for (let sub of rec.subpackets) {
			if (sub.type !== "explosion") continue;
			if (sub.code === 0x0d) {
				for (let [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
					let i = state.pills.findIndex(p => p.inTank === null && p.x === sub.x + dx && p.y === sub.y + dy);
					if (i < 0) continue;
					totals.booms_on_pill++;
					booms[i]++;
					adjust(i, boom_family, d => -d);
				}
			} else if (sub.code === 3) {
				let i = state.pills.findIndex(p => p.inTank === null && p.x === sub.x && p.y === sub.y);
				if (i < 0) continue;
				totals.craters_on_pill++;
				craters[i]++;
				adjust(i, crater_family, d => -d);
			}
		}

		for (let sub of rec.subpackets) {
			switch (sub.type) {
			case "pillbox_list":                   /* F1 02: the real anchor */
				sub.items.forEach((item, i) => {
					if (i >= count) return;
					/* 0xff = carried when logging started; the list gives no
					 * armour for those, so they stay unknown until an anchor */
					if (item.armour === 0xff) { known[i] = false; return; }
					anchor(i, () => Math.min(MAX_ARMOUR, item.armour));
				});
				break;
			case "pillbox_damage":                 /* 9n: one shell */
				both(sub.pillbox, -1);
				break;
			case "pill_repair_4":
				both(sub.pillbox, +4);
				break;
			case "pill_repair_8":
				both(sub.pillbox, +8);
				break;
			case "pill_repair_12":
				both(sub.pillbox, +12);
				break;
			case "pill_repair_full":               /* known value: an anchor */
				anchor(sub.pillbox, () => MAX_ARMOUR);
				break;
			case "pillbox_fires":                  /* F4: proves armour > 0 */
				totals.fires++;
				judge(sub.pillbox, true);
				break;
			case "pill_pickup":                    /* FF 0n: proves armour 0 */
				totals.pickups++;
				judge(sub.pillbox, false);
				anchor(sub.pillbox, () => 0);
				break;
			case "pill_plant": {                   /* armour unknown: sweep P */
				let i = state.pills.findIndex(p => p.inTank === rec.player);
				if (i >= 0) anchor(i, p => p);
				break;
			}
			case "pill_dumped_by_dead_lgm": {      /* carried, so still 0 */
				let i = state.pills.findIndex(p => p.inTank === rec.player);
				if (i >= 0) anchor(i, () => 0);
				break;
			}
			}
		}

		BoloGame.apply_record(state, rec, null, null);
	}
}

let files = [...walk(ROOT)];
if (!files.length) {
	console.log(`no logs found under ${ROOT}`);
	process.exit(1);
}
for (let file of files) scan(file);

/* ------------------------------------------------------------------ */

console.log("======================================================================");
console.log(`${totals.logs} logs, ${totals.records.toLocaleString()} records, ${totals.unreadable} unreadable`);
console.log(`pickups ${totals.pickups.toLocaleString()}, pill fires ${totals.fires.toLocaleString()}, ` +
	`superboom-on-pill ${totals.booms_on_pill}, crater-on-pill ${totals.craters_on_pill}`);
console.log();
console.log("A pickup of a pill we still think has armour means the damage figure is");
console.log("too SMALL; a pill firing while we think it dead means it is too LARGE.");
console.log();

console.log(`Planted-pill armour P, from the ${baseline.events.toLocaleString()} constraint events in intervals`);
console.log("containing neither blast (these also set the noise floor):");
console.log();
console.log(`    ${"P".padStart(3)}  ${"pickup of live".padStart(15)}  ${"dead pill fired".padStart(16)}  total`);
let best_p = 0, best_p_score = Infinity;
for (let p = 0; p < PLANT_VALUES; p++) {
	let total = baseline.pickup_live[p] + baseline.dead_fired[p];
	if (total < best_p_score) { best_p_score = total; best_p = p; }
}
for (let p = 0; p < PLANT_VALUES; p++) {
	let total = baseline.pickup_live[p] + baseline.dead_fired[p];
	let mark = p === best_p ? "  <-- fewest contradictions" : "";
	console.log(`    ${String(p).padStart(3)}  ${String(baseline.pickup_live[p]).padStart(15)}  ` +
		`${String(baseline.dead_fired[p]).padStart(16)}  ${String(total).padStart(6)}${mark}`);
}

for (let family of [boom_family, crater_family]) {
	console.log();
	console.log(`${family.blast}: damage d, judged on ${family.events.toLocaleString()} constraint events`);
	console.log(`in intervals containing this blast and not the other (P = ${best_p}):`);
	console.log();
	console.log(`    ${"d".padStart(3)}  ${"pickup of live".padStart(15)}  ${"dead pill fired".padStart(16)}  total`);
	for (let d = 0; d < DAMAGE_VALUES; d++) {
		let c = cell_index(best_p, d);
		let total = family.pickup_live[c] + family.dead_fired[c];
		console.log(`    ${String(d).padStart(3)}  ${String(family.pickup_live[c]).padStart(15)}  ` +
			`${String(family.dead_fired[c]).padStart(16)}  ${String(total).padStart(6)}`);
	}
	/* Report the whole band of d that survives, not one argmin: ties are
	 * the normal case and a single number would hide the width. */
	const band = p => {
		let score = Infinity, best = [];
		for (let d = 0; d < DAMAGE_VALUES; d++) {
			let total = family.pickup_live[cell_index(p, d)] + family.dead_fired[cell_index(p, d)];
			if (total < score) { score = total; best = [d]; }
			else if (total === score) best.push(d);
		}
		return {score, best};
	};
	let here = band(best_p);
	console.log(`    fewest contradictions (${here.score}) at d = ${here.best.join(", ")}`);
	/* the answer should not depend on the nuisance parameter */
	let agree = [];
	for (let p = 0; p < PLANT_VALUES; p++) agree.push(band(p).best.join("/"));
	console.log(`    surviving d for each P 0..15: ${agree.join("  ")}`);
}
console.log("======================================================================");
