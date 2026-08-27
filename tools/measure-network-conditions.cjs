#!/usr/bin/env node
/* What do Bolo logs say about the network the game was played on, and where
 * should "good / fair / bad / awful" be cut?
 *
 * Two signals, both free -- a log cannot help recording when packets arrived
 * and how many the machine never saw.
 *
 * LOSS: the payload's sequence number is bumped by every node a packet
 * passes, so consecutive records step by 1 when nothing is missed.  A step
 * of n means n-1 packets never reached the logging machine.  A step of 0 is
 * a duplicate.  Steps across a gap over 5 s are discarded: a rejoining node
 * can advance the 7-bit counter right round, and a wrapped step is a lie.
 *
 * STALL: the share of elapsed time in gaps where nothing at all arrived for
 * over half a second.  No ring cycles that slowly at any player count, so
 * this is a freeze regardless of how many were playing.
 *
 * THE GATHERING PHASE is the thing that has to be got right.  While a game
 * is still gathering, the ring turns at full speed but the logging machine
 * records only a fraction of it, so the sequence number races ahead and
 * every packet it skips is charged as loss -- a catastrophic reading with
 * no packet actually lost.  It is short but so extreme that averaging it in
 * swamps the rest of the game, which is why the shipped metric reads only
 * the settled span, from the first base capture to the first quit.  The
 * script measures the damage directly, by correlating each log's loss
 * figure against the share of it spent gathering, trimmed and untrimmed.
 *
 * The script reports, over a corpus:
 *   -- the distribution of each signal, trimmed and untrimmed;
 *   -- the gathering confound above;
 *   -- the split by player count and by year, the two external facts the
 *      signals ought to track if they measure anything real -- shown both
 *      ways, since trimming changes what they say;
 *   -- SPLIT-HALF RELIABILITY: each log diced into half-minute blocks and
 *      dealt alternately into two piles, each pile scored as if it were its
 *      own game.  This asks whether a single verdict for a whole game is
 *      honest, or whether it is just whichever minute got sampled.  It uses
 *      interleaved blocks, not first-half/second-half, so that a game which
 *      genuinely deteriorated is not counted as unreliable;
 *   -- how the chosen bands fall over the corpus, and how often the two
 *      halves of a log land in the same band.
 *
 * Usage: node tools/measure-network-conditions.cjs [corpus-root]
 */
const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const ROOT = args[0] || "C:/Users/Owner/__DOCS/Bolo Archives/Nemokrad's Bolo logs";
const BLOCK = 1500;             /* ticks per split-half block (30 s) */
const MIN_RECORDS = 2000;       /* below this a log says too little to score */
const MIN_TICKS = 3000;         /* and likewise below a minute of play */

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

/* ---------- statistics ---------- */

function quantile(sorted, p) {
	return sorted[Math.floor(p * (sorted.length - 1))];
}

function spread(label, values) {
	let v = values.slice().sort((a, b) => a - b);
	let q = p => quantile(v, p).toFixed(1).padStart(5);
	return `${label.padEnd(9)} min=${q(0)} p10=${q(.1)} p25=${q(.25)} ` +
		`p50=${q(.5)} p75=${q(.75)} p90=${q(.9)} p99=${q(.99)} max=${q(1)}`;
}

/* the readings as network_conditions takes them, but over whatever slice of
 * records it is handed -- used here for the untrimmed comparison */
function raw_readings(recs) {
	let elapsed = recs[recs.length - 1].time - recs[0].time;
	let missing = 0, slots = 0, frozen = 0;
	for (let i = 1; i < recs.length; i++) {
		let gap = recs[i].time - recs[i - 1].time;
		let step = (recs[i].seq - recs[i - 1].seq) & 0x7f;
		if (gap > 25 && gap <= 1500) frozen += gap;
		if (step === 0 || gap > 250) { slots++; continue; }
		missing += step - 1;
		slots += step;
	}
	return { loss: 100 * missing / Math.max(1, slots), stall: 100 * frozen / Math.max(1, elapsed) };
}

function correlation(xs, ys) {
	let n = xs.length;
	let mx = xs.reduce((a, b) => a + b, 0) / n;
	let my = ys.reduce((a, b) => a + b, 0) / n;
	let sxy = 0, sxx = 0, syy = 0;
	for (let i = 0; i < n; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
		syy += (ys[i] - my) ** 2;
	}
	return sxy / Math.sqrt(sxx * syy);
}

/* ---------- the corpus ---------- */

let rows = [];
for (let file of walk(ROOT)) {
	let bytes;
	try {
		bytes = new Uint8Array(fs.readFileSync(file));
	} catch {
		continue;
	}
	if (bytes.length < 200) continue;
	if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "Bolo") continue;

	let recs = [];
	try {
		for (let rec of BoloLog.records(bytes)) recs.push(rec);
	} catch { /* keep whatever decoded before the damage */ }
	if (recs.length < MIN_RECORDS) continue;
	if (recs[recs.length - 1].time - recs[0].time < MIN_TICKS) continue;

	let whole = BoloGame.network_conditions(recs);
	if (!whole) continue;

	/* Interleaved blocks, so a game that merely got worse as it went is not
	 * mistaken for a game whose measurement is unstable.  The split is made
	 * INSIDE the settled span and the halves are read raw: handing a pile of
	 * non-adjacent blocks back to network_conditions would have it hunt for
	 * a join ramp in a stream that no longer has one, and measure the
	 * trimmer rather than the network. */
	let span = recs.filter(rec => rec.time >= whole.from && rec.time <= whole.to);
	let piles = [[], []];
	for (let rec of span) piles[Math.floor((rec.time - whole.from) / BLOCK) % 2].push(rec);
	if (piles[0].length < 100 || piles[1].length < 100) continue;
	let a = raw_readings(piles[0]);
	let b = raw_readings(piles[1]);

	let captured = recs.some(rec => rec.subpackets.some(s => s.type === "base_capture"));
	let year = (path.relative(ROOT, file).match(/(?:19|20)\d\d/) || ["?"])[0];
	rows.push({
		file: path.relative(ROOT, file), year, whole, a, b,
		untrimmed: raw_readings(recs),
		/* what fraction of the log the verdict was NOT read from */
		trimmedShare: 100 * (1 - (whole.to - whole.from) /
			Math.max(1, recs[recs.length - 1].time - recs[0].time)),
		rampShare: 100 * (whole.from - recs[0].time) /
			Math.max(1, recs[recs.length - 1].time - recs[0].time),
		players: new Set(recs.map(r => r.player)).size,
		captured,
	});
}

if (rows.length === 0) {
	console.log(`no scoreable logs under ${ROOT}`);
	process.exit(1);
}

console.log(`${rows.length} logs scored under ${ROOT}\n`);

console.log(spread("loss %", rows.map(r => r.whole.loss)));
console.log(spread("stall %", rows.map(r => r.whole.stall)));
console.log("loss/stall correlation: r = " +
	correlation(rows.map(r => r.whole.loss), rows.map(r => r.whole.stall)).toFixed(3));

console.log("\nuntrimmed, for comparison -- the same logs read end to end:");
console.log(spread("loss %", rows.map(r => r.untrimmed.loss)));
console.log(spread("stall %", rows.map(r => r.untrimmed.stall)));
console.log(`trimmed away: median ${quantile(rows.map(r => r.trimmedShare).sort((a, b) => a - b), .5).toFixed(1)}% ` +
	`of a log, of which the gathering phase is ` +
	`${quantile(rows.map(r => r.rampShare).sort((a, b) => a - b), .5).toFixed(1)}%`);

/* The gathering confound: if the untrimmed figure is largely a measure of
 * how much of the log was spent gathering, it will track that share -- and
 * the trimmed figure, if the correction works, will not track it at all. */
console.log("\nthe gathering confound:");
console.log(`  untrimmed loss vs gathering share: r = ` +
	correlation(rows.map(r => r.rampShare), rows.map(r => r.untrimmed.loss)).toFixed(3));
console.log(`  settled   loss vs gathering share: r = ` +
	correlation(rows.map(r => r.rampShare), rows.map(r => r.whole.loss)).toFixed(3));

/* Do the signals track the two things outside the log that ought to move
 * them?  A ring gains a hop per player; and the world got broadband, which
 * is the claim the trimming turns out to refute. */
console.log("\nby player count (a longer ring should lose more):");
let by_players = new Map();
for (let row of rows) {
	if (!by_players.has(row.players)) by_players.set(row.players, []);
	by_players.get(row.players).push(row);
}
for (let n of [...by_players.keys()].sort((x, y) => x - y)) {
	let group = by_players.get(n);
	if (group.length < 8) continue;
	let loss = group.map(r => r.whole.loss).sort((x, y) => x - y);
	let raw = group.map(r => r.untrimmed.loss).sort((x, y) => x - y);
	let stall = group.map(r => r.whole.stall).sort((x, y) => x - y);
	console.log(`  ${n} players  n=${String(group.length).padStart(3)}  ` +
		`loss p50=${quantile(loss, .5).toFixed(1).padStart(5)}  ` +
		`stall p50=${quantile(stall, .5).toFixed(1).padStart(5)}` +
		`   (untrimmed loss p50=${quantile(raw, .5).toFixed(1).padStart(5)})`);
}

console.log("\nby year -- untrimmed this looks like dial-up giving way to");
console.log("broadband; in settled play the improvement mostly evaporates,");
console.log("so what got faster was the map transfer, not the game:");
let by_year = new Map();
for (let row of rows) {
	if (!by_year.has(row.year)) by_year.set(row.year, []);
	by_year.get(row.year).push(row);
}
for (let y of [...by_year.keys()].sort()) {
	let group = by_year.get(y);
	if (group.length < 8) continue;
	let loss = group.map(r => r.whole.loss).sort((a, b) => a - b);
	let raw = group.map(r => r.untrimmed.loss).sort((a, b) => a - b);
	console.log(`  ${y}  n=${String(group.length).padStart(3)}  ` +
		`untrimmed p50=${quantile(raw, .5).toFixed(1).padStart(5)}  ` +
		`->  settled p50=${quantile(loss, .5).toFixed(1).padStart(5)}`);
}

console.log("\nsplit-half reliability (is one verdict per game honest?):");
console.log(`  loss  r = ${correlation(rows.map(r => r.a.loss), rows.map(r => r.b.loss)).toFixed(3)}`);
console.log(`  stall r = ${correlation(rows.map(r => r.a.stall), rows.map(r => r.b.stall)).toFixed(3)}`);
let dl = rows.map(r => Math.abs(r.a.loss - r.b.loss)).sort((a, b) => a - b);
let ds = rows.map(r => Math.abs(r.a.stall - r.b.stall)).sort((a, b) => a - b);
console.log(`  |loss A - loss B|   p50=${quantile(dl, .5).toFixed(2)} p90=${quantile(dl, .9).toFixed(2)}`);
console.log(`  |stall A - stall B| p50=${quantile(ds, .5).toFixed(2)} p90=${quantile(ds, .9).toFixed(2)}`);

console.log("\nbands as shipped:");
const NAMES = ["good", "fair", "bad", "awful"];
let counts = new Map(NAMES.map(n => [n, 0]));
let same = 0;
for (let row of rows) {
	counts.set(row.whole.rating, counts.get(row.whole.rating) + 1);
	if (BoloGame.network_rating(row.a.loss, row.a.stall) ===
		BoloGame.network_rating(row.b.loss, row.b.stall)) same++;
}
for (let name of NAMES) {
	let c = counts.get(name);
	console.log(`  ${name.padEnd(6)} ${String(c).padStart(4)}  ${(100 * c / rows.length).toFixed(1)}%`);
}
console.log(`  the two halves of a log agree on the band ${(100 * same / rows.length).toFixed(1)}% of the time`);

console.log("\na walk up the range:");
let sorted = rows.slice().sort((a, b) => a.whole.loss - b.whole.loss);
for (let i = 0; i < sorted.length; i += Math.ceil(sorted.length / 12)) {
	let r = sorted[i];
	console.log(`  ${r.whole.rating.padEnd(6)} loss=${r.whole.loss.toFixed(1).padStart(5)}% ` +
		`stall=${r.whole.stall.toFixed(1).padStart(5)}% ${r.players}p  ${r.file}`);
}
