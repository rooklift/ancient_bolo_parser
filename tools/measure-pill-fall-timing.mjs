/* Measure the F4 -> FB record-time gap on assumption-free pairs:
 * FB falls whose exact pixel matches exactly one live pill's orbit
 * terminal, where that pill fired in that sector exactly once within
 * +-300 ticks. No timing gate is applied, so the distribution is not
 * biased by the window being tested. */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createRequire } from "node:module";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const { records } = await import(url.pathToFileURL(path.join(ROOT, "src", "parse.js")));
const ORBITS = createRequire(import.meta.url)(path.join(ROOT, "viewer", "pillbox_shell_orbits.js")).orbits;

const target = process.argv[2] ?? path.join(ROOT, "fixtures", "n20021018.2");
const recs = [...records(new Uint8Array(fs.readFileSync(target)))];

let pills = [];
const f4s = [];          // {time, sender, pill_x, pill_y, direction}
const fbs = [];          // {time, sender, x, y, prev_gap}
const last_record_time = new Array(16).fill(null);

for (const rec of recs) {
	const prev = last_record_time[rec.player];
	const gap = prev === null ? null : rec.time - prev;
	last_record_time[rec.player] = rec.time;
	for (const sub of rec.subpackets) {
		if (sub.type === "pillbox_list") {
			pills = sub.items.map(item => ({ x: item.x, y: item.y, inTank: null }));
		} else if (sub.type === "pill_pickup") {
			if (pills[sub.pillbox]) pills[sub.pillbox].inTank = rec.player;
		} else if (sub.type === "pill_plant" || sub.type === "pill_dumped_by_dead_lgm") {
			for (const pill of pills) {
				if (pill.inTank === rec.player) {
					pill.inTank = null;
					pill.x = sub.x;
					pill.y = sub.y;
					break;
				}
			}
		} else if (sub.type === "tank_death" || sub.type === "quit") {
			for (const pill of pills) {
				if (pill.inTank === rec.player) pill.inTank = "lost";
			}
		} else if (sub.type === "pillbox_fires") {
			const pill = pills[sub.pillbox];
			if (pill && pill.inTank === null) {
				f4s.push({ time: rec.time, sender: rec.player,
					pill_x: pill.x, pill_y: pill.y, direction: sub.direction });
			}
		} else if (sub.type === "shell_falls") {
			fbs.push({ time: rec.time, sender: rec.player,
				x: sub.x * 16 + (sub.pixel & 0x0f),
				y: sub.y * 16 + (sub.pixel >> 4), prev_gap: gap });
		}
	}
}

/* Live-pill terminal lookup is time-dependent; pills rarely move, so do a
 * simple scan per FB (pills captured above are final state -- instead
 * track positions by replaying is overkill: use the F4 list itself as the
 * source of firing-pill positions). */
const samples = [];
let ambiguous = 0, no_pill = 0, no_f4 = 0, multi_f4 = 0;
for (const fb of fbs) {
	/* Which (pill position, sector) could terminate at this exact pixel?
	 * Use positions of pills seen firing within +-300 ticks. */
	const nearby = f4s.filter(f => Math.abs(f.time - fb.time) <= 300);
	const stories = new Map();   // "px,py,sector" -> candidate F4s
	for (const f of nearby) {
		for (const orbit of ORBITS) {
			if (orbit.coarse_direction !== f.direction) continue;
			if (f.pill_x * 16 + orbit.terminal[0] === fb.x &&
				f.pill_y * 16 + orbit.terminal[1] === fb.y) {
				const key = `${f.pill_x},${f.pill_y},${f.direction}`;
				if (!stories.has(key)) stories.set(key, []);
				stories.get(key).push(f);
				break;
			}
		}
	}
	if (stories.size === 0) { no_pill++; continue; }
	if (stories.size > 1) { ambiguous++; continue; }
	const candidates = [...stories.values()][0];
	if (candidates.length > 1) { multi_f4++; continue; }
	const f4 = candidates[0];
	samples.push({ dt: fb.time - f4.time, same_sender: fb.sender === f4.sender,
		prev_gap: fb.prev_gap });
}

samples.sort((a, b) => a.dt - b.dt);
const dts = samples.map(s => s.dt);
const q = p => dts[Math.min(dts.length - 1, Math.floor(p * dts.length))];
console.log(`falls ${fbs.length}, unique-story unique-F4 samples ${samples.length}`);
console.log(`(excluded: no pill story ${no_pill}, multiple stories ${ambiguous}, multiple F4 candidates ${multi_f4})`);
console.log(`same sender F4/FB: ${samples.filter(s => s.same_sender).length} of ${samples.length}`);
console.log(`dt percentiles: min ${dts[0]}  1% ${q(0.01)}  5% ${q(0.05)}  25% ${q(0.25)}  50% ${q(0.5)}  75% ${q(0.75)}  95% ${q(0.95)}  99% ${q(0.99)}  max ${dts[dts.length-1]}`);
const in_band = (lo, hi) => dts.filter(d => d >= lo && d <= hi).length;
console.log(`in [60,72]: ${in_band(60,72)} (${(100*in_band(60,72)/dts.length).toFixed(1)}%)  in [56,80]: ${in_band(56,80)} (${(100*in_band(56,80)/dts.length).toFixed(1)}%)  in [44,124]: ${in_band(44,124)} (${(100*in_band(44,124)/dts.length).toFixed(1)}%)`);
/* Histogram, 4-tick buckets around the interesting range. */
const hist = new Map();
for (const d of dts) {
	const bucket = d < 40 ? "<40" : d > 120 ? ">120" : `${Math.floor(d / 4) * 4}`;
	hist.set(bucket, (hist.get(bucket) || 0) + 1);
}
console.log([...hist.entries()].sort((a, b) => {
	const va = a[0] === "<40" ? -1 : a[0] === ">120" ? 999 : +a[0];
	const vb = b[0] === "<40" ? -1 : b[0] === ">120" ? 999 : +b[0];
	return va - vb;
}).map(([k, v]) => `${k}:${v}`).join(" "));
/* Does lag explain the tail? Compare dt vs the FB record's gap back to
 * the sender's previous record. */
const tail = samples.filter(s => s.dt > 80);
const tail_gappy = tail.filter(s => s.prev_gap !== null && s.dt - 64 <= s.prev_gap + 8);
console.log(`tail dt>80: ${tail.length}; of those, excess <= FB record's own prev-record gap (+8): ${tail_gappy.length}`);
