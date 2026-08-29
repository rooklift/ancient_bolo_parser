#!/usr/bin/env node
/* Is a firing pillbox where we think it is?
 *
 * `F4 nd` names the pill and the shell's direction but no position, so our
 * position for pill n comes from the plant model, not from the log.  If two
 * pills' identities were swapped -- right IDs, wrong squares -- nothing in
 * the event stream would complain.  The shot itself can tell us, but only
 * if the shell is identified without using its position to pick it, which
 * would beg the question, and only against a control, because a shell's
 * restated position is NOT simply its firer's square.
 *
 * QUIET MOMENTS give the identification.  Take a fire from a sender that
 * was simulating NO shells in its previous restatement, whose next
 * restatement carries EXACTLY ONE, with nothing else in between that could
 * spawn a shell.  That shell is the firer's by elimination, not proximity.
 *
 * TANK SHOTS give the control.  A `5d` shot has the same geometry with a
 * KNOWN firer position, straight from the tank position subpacket, so its
 * spread is pure measurement jitter: a shell spawns a few pixels out and
 * then flies at 2 px/tick, and the log timestamps records rather than
 * shots, so firer-to-first-restatement varies by design.  Whatever that
 * spread is, a correctly-placed pill must match it; only the excess tail
 * can be called a position error.
 *
 * TWO EXCLUSIONS keep the pill side honest.  The first ten minutes are
 * dropped, since pills still on their start squares were placed by the
 * `F1 02` list rather than by the plant model and would pass for free, and
 * the figures are repeated for pills that have been picked up at some
 * point, the only population the plant model touches.
 *
 * Usage: node tools/measure-pill-position.cjs [corpus-root]
 */
const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const ROOT = args[0] || require("./corpus.cjs").corpus_root();
const WINDOW = 25;                 /* ticks to wait for the shot to be restated */
const SKIP_TICKS = 10 * 60 * 50;   /* the opening ten minutes */

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

const samples = {tank: [], pill: [], pill_moved: []};
const outliers = [];
const deltas = new Map();   /* index of the pill actually at the shot, minus the one that fired */
const totals = {logs: 0, fires: 0, clean: 0, spoiled: 0};

function scan(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		return;
	}
	if (!recs.length) return;
	totals.logs++;
	const t0 = recs[0].time;
	const clock = t => `${Math.floor((t - t0) / 50 / 60)}:${(((t - t0) / 50) % 60).toFixed(2).padStart(5, "0")}`;

	const state = BoloGame.initial_state(BoloGame.extract_initial_map(recs));
	const per_record = recs.map(shells_in);
	const had_shells = new Array(16).fill(false);
	const spoke = new Array(16).fill(false);
	const moved = new Array(16).fill(false);

	/* the sender's first restatement at or after i, if it is a lone shell and
	 * nothing else it sent in between could have spawned one */
	const lone_shot_after = (i) => {
		for (let j = i; j < recs.length && recs[j].time <= recs[i].time + WINDOW; j++) {
			if (recs[j].player !== recs[i].player) continue;
			if (j > i && recs[j].subpackets.some(s =>
				s.type === "shot_fired" || s.type === "pillbox_fires")) return null;
			const list = per_record[j];
			if (!list.length) continue;
			return list.length === 1 ? list[0] : null;
		}
		return null;
	};

	for (let i = 0; i < recs.length; i++) {
		const rec = recs[i];
		for (const sub of rec.subpackets)
			if (sub.type === "pill_pickup") moved[sub.pillbox] = true;

		const fires = rec.subpackets.filter(s => s.type === "pillbox_fires");
		const shots = rec.subpackets.filter(s => s.type === "shot_fired");
		const pos = rec.subpackets.find(s => s.type === "tank_position");
		const quiet = spoke[rec.player] && !had_shells[rec.player];

		/* CONTROL: the sender's own tank shot, firer position known */
		if (quiet && shots.length === 1 && !fires.length && pos) {
			const shot = lone_shot_after(i);
			if (shot) {
				const cx = pos.x * 16 + pos.pixelX + 8, cy = pos.y * 16 + pos.pixelY + 8;
				samples.tank.push(Math.hypot(shot.wx - cx, shot.wy - cy));
			}
		}

		/* TEST: a pill's shot, firer position modelled */
		if (quiet && fires.length === 1 && !shots.length && rec.time - t0 >= SKIP_TICKS) {
			const sub = fires[0];
			const pill = state.pills[sub.pillbox];
			totals.fires++;
			if (pill && pill.inTank === null) {
				const shot = lone_shot_after(i);
				if (!shot) {
					totals.spoiled++;
				} else {
					totals.clean++;
					const cx = pill.x * 16 + 8, cy = pill.y * 16 + 8;
					const d = Math.hypot(shot.wx - cx, shot.wy - cy);
					samples.pill.push(d);
					if (moved[sub.pillbox]) samples.pill_moved.push(d);
					if (d > 48) {
						const sx = shot.wx >> 4, sy = shot.wy >> 4;
						const other = state.pills.findIndex(p =>
							p.inTank === null && p !== pill && Math.abs(p.x - sx) <= 1 && Math.abs(p.y - sy) <= 1);
						/* which index does the shot actually belong to? */
						const delta = other < 0 ? "none" : String(other - sub.pillbox);
						deltas.set(delta, (deltas.get(delta) || 0) + 1);
						if (outliers.length < 12)
						outliers.push(`${path.relative(ROOT, file).split(path.sep).join("/")} ${clock(rec.time)}: ` +
							`pill #${sub.pillbox}, we place it at ${pill.x},${pill.y}, its shot is at ${sx},${sy} ` +
							`(${d.toFixed(0)} px away)${other >= 0 ? ` — beside the pill we call #${other}` : " — no pill near it"}`);
					}
				}
			}
		}

		if (per_record[i].length || spoke[rec.player]) had_shells[rec.player] = per_record[i].length > 0;
		spoke[rec.player] = true;
		BoloGame.apply_record(state, rec, null, null);
	}
}

for (const file of walk(ROOT)) scan(file);

const pct = (xs, p) => xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : NaN;
const line = (label, xs, cut) => {
	if (!xs.length) return;
	const over = cut === undefined ? null : xs.filter(v => v > cut).length;
	console.log(`    ${label.padEnd(30)} n=${String(xs.length).padStart(7)}  ` +
		`median ${pct(xs, 0.5).toFixed(1).padStart(5)}  p90 ${pct(xs, 0.9).toFixed(1).padStart(5)}  ` +
		`p99 ${pct(xs, 0.99).toFixed(1).padStart(5)}  max ${pct(xs, 1).toFixed(0).padStart(4)}` +
		(over === null ? "" : `   beyond control p99: ${over} (${(100 * over / xs.length).toFixed(2)}%)`));
};

console.log("======================================================================");
console.log(`${totals.logs} logs; quiet-moment pill fires examined: ${totals.fires.toLocaleString()}, ` +
	`usable: ${totals.clean.toLocaleString()} (${totals.spoiled.toLocaleString()} spoiled)`);
console.log();
console.log("distance from the firer to its own shell's first restatement (px):");
line("tank shots (position known)", samples.tank);
const cut = pct(samples.tank, 0.99);
line("pill shots (position modelled)", samples.pill, cut);
line("...pills that were planted", samples.pill_moved, cut);
console.log();
console.log("A tank's own shot is the same geometry with a known firer, so its spread is the");
console.log(`floor. Only pill shots beyond the tank p99 (${cut.toFixed(1)} px) are position-error candidates.`);
console.log();
console.log("for those outliers, the index of the pill our model places at the shot,");
console.log("minus the index that actually fired:");
for (const [k, v] of [...deltas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8))
	console.log(`    ${k.padStart(5)}  ${String(v).padStart(6)}`);
if (outliers.length) {
	console.log();
	for (const s of outliers) console.log("    " + s);
}
console.log("======================================================================");
