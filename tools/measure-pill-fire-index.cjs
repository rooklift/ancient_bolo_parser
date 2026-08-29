#!/usr/bin/env node
/* Is the pill index in an `F4` trustworthy?
 *
 * `F4 nd` says pillbox n fired in direction d.  The index is not used by
 * anything that matters -- the shell itself is restated in the shell lists,
 * damage arrives as `9n`, ownership at pickup -- so a wrong one costs a
 * viewer only a misplaced muzzle flash.  It is wrong surprisingly often,
 * and only in one direction.
 *
 * MEASUREMENT ONE: where did the shot really come from?  A pill's shot can
 * be identified without begging the question if the moment is quiet enough:
 * take an `F4` from a sender that was simulating NO shells in its previous
 * restatement, whose next restatement carries EXACTLY ONE, with nothing
 * else in between that could spawn a shell.  That shell is the pill's by
 * elimination.  Then ask which pill it sits on -- the one named, or its
 * lower neighbour.  Split by direction, because that is where the effect
 * lives.
 *
 * MEASUREMENT TWO: an independent check needing no shells at all.  A pill
 * inside a tank cannot fire, so an `F4` naming a carried pill is impossible
 * on its face.  If those impossibilities share the same direction, and the
 * lower neighbour was on the ground each time, they are the same fault seen
 * from another angle.
 *
 * Usage: node tools/measure-pill-fire-index.cjs [corpus-root]
 */
const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const ROOT = args[0] || require("./corpus.cjs").corpus_root();
const WINDOW = 25;      /* ticks to wait for the shot to be restated */
const NEAR = 48;        /* px: close enough to call the shot that pill's */

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

/* absolute positions of every shell a record restates, offsets chained.
 * [E:shell-centre]: the stored XX YY yx needs the half-tile centring. */
function shells_in(rec) {
	let out = [];
	for (let sub of rec.subpackets) {
		if (sub.type !== "shells") continue;
		let prev = null;
		for (let i = 0; i < sub.shells.length; i++) {
			let sh = sub.shells[i];
			let wx = i === 0 ? sh.x * 16 + (sh.pixel & 0x0f) : prev.wx + sh.offsetX;
			let wy = i === 0 ? sh.y * 16 + (sh.pixel >> 4) : prev.wy + sh.offsetY;
			out.push({wx: wx + 8, wy: wy + 8});
			prev = {wx, wy};
		}
	}
	return out;
}

const shot = Array.from({length: 16}, () => ({n: 0, on_named: 0, on_lower: 0, neither: 0}));
const carried = Array.from({length: 16}, () => ({fires: 0, while_carried: 0, lower_grounded: 0}));
const totals = {logs: 0, fires: 0};

function scan(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		return;
	}
	if (!recs.length) return;
	totals.logs++;

	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs));
	let per_record = recs.map(shells_in);
	let had_shells = new Array(16).fill(false);
	let spoke = new Array(16).fill(false);

	for (let i = 0; i < recs.length; i++) {
		let rec = recs[i];
		let fires = rec.subpackets.filter(s => s.type === "pillbox_fires");
		let shots = rec.subpackets.filter(s => s.type === "shot_fired");

		for (let sub of fires) {
			totals.fires++;
			let named = state.pills[sub.pillbox];
			let lower = state.pills[(sub.pillbox + 15) % 16];
			let c = carried[sub.direction];
			c.fires++;
			if (named && named.inTank !== null) {
				c.while_carried++;
				if (lower && lower.inTank === null) c.lower_grounded++;
			}
		}

		/* the quiet-moment identification */
		if (spoke[rec.player] && !had_shells[rec.player] && fires.length === 1 && !shots.length) {
			let sub = fires[0];
			let named = state.pills[sub.pillbox];
			let lower = state.pills[(sub.pillbox + 15) % 16];
			if (named && lower && named.inTank === null && lower.inTank === null) {
				let found = null;
				for (let j = i; j < recs.length && recs[j].time <= rec.time + WINDOW; j++) {
					if (recs[j].player !== rec.player) continue;
					if (j > i && recs[j].subpackets.some(s =>
						s.type === "shot_fired" || s.type === "pillbox_fires")) break;
					if (!per_record[j].length) continue;
					if (per_record[j].length === 1) found = per_record[j][0];
					break;
				}
				if (found) {
					let dist = p => Math.hypot(found.wx - (p.x * 16 + 8), found.wy - (p.y * 16 + 8));
					let dn = dist(named), dl = dist(lower);
					let s = shot[sub.direction];
					s.n++;
					if (dn <= NEAR && dn <= dl) s.on_named++;
					else if (dl <= NEAR) s.on_lower++;
					else s.neither++;
				}
			}
		}

		if (per_record[i].length || spoke[rec.player]) had_shells[rec.player] = per_record[i].length > 0;
		spoke[rec.player] = true;
		BoloGame.apply_record(state, rec, null, null);
	}
}

for (let file of walk(ROOT)) scan(file);

const pc = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
console.log("======================================================================");
console.log(`${totals.logs} logs, ${totals.fires.toLocaleString()} pill fires`);
console.log();
console.log("Where the shot really came from, in moments quiet enough to identify it");
console.log("by elimination:");
console.log();
console.log(`    ${"dir".padStart(3)} ${"n".padStart(7)} ${"on the named pill".padStart(20)} ${"on pill n-1".padStart(16)} ${"neither".padStart(12)}`);
for (let d = 0; d < 16; d++) {
	let s = shot[d];
	if (!s.n) continue;
	console.log(`    ${String(d).padStart(3)} ${String(s.n).padStart(7)} ` +
		`${`${s.on_named} (${pc(s.on_named, s.n)})`.padStart(20)} ` +
		`${`${s.on_lower} (${pc(s.on_lower, s.n)})`.padStart(16)} ` +
		`${`${s.neither} (${pc(s.neither, s.n)})`.padStart(12)}`);
}
console.log();
console.log("Impossible fires -- an F4 naming a pill our model holds in a tank -- and");
console.log("whether the lower-numbered pill was on the ground at the time:");
console.log();
console.log(`    ${"dir".padStart(3)} ${"fires".padStart(9)} ${"while carried".padStart(15)} ${"rate".padStart(8)} ${"n-1 was grounded".padStart(18)}`);
for (let d = 0; d < 16; d++) {
	let c = carried[d];
	if (!c.fires) continue;
	console.log(`    ${String(d).padStart(3)} ${String(c.fires).padStart(9)} ${String(c.while_carried).padStart(15)} ` +
		`${pc(c.while_carried, c.fires).padStart(8)} ${String(c.lower_grounded).padStart(18)}`);
}
console.log("======================================================================");
