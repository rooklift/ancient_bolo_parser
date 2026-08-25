#!/usr/bin/env node
// Are terminal death craters always evented? For every death sequence:
// find the wreck's final centre square, check for crater/superboom events
// near it, and — for deaths with NO crater event that ended beside water —
// check whether the square later floods. A flood there would betray an
// unlogged (eventless) crater, since crater flooding is evented and fast.
//
//   node tools/validate-death-craters.cjs [dir]
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const ROOT = process.argv[2] || "C:/Users/Owner/__DOCS/Bolo Archives/Nemokrad's Bolo logs";

function* walk(dir) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else if (e.isFile()) yield p;
	}
}

let deaths = 0, evented = 0, noCrater = 0, nearWater = 0, flooded = 0;
const terrHist = {};
const floodSamples = [];
let files = 0;

for (const file of walk(ROOT)) {
	let buf;
	try { buf = new Uint8Array(fs.readFileSync(file)); } catch { continue; }
	if (buf.length < 72 || buf[0] !== 0x42 || buf[1] !== 0x6f || buf[2] !== 0x6c || buf[3] !== 0x6f) continue;
	files++;
	try {
		const recs = [...BoloLog.records(buf)];
		const s = BoloGame.initial_state(BoloGame.extract_initial_map(recs));
		const dying = {};
		const deathEnds = [], craterEvents = [], waterEvents = [];
		for (const r of recs) {
			for (const sub of r.subpackets) {
				if (sub.type === "tank_death") dying[r.player] = { lastSq: null, lastT: r.time, code: sub.code };
				if (sub.type === "tank_position") {
					if (sub.dying && dying[r.player]) {
						const sq = { x: (sub.x * 16 + sub.pixelX + 8) >> 4, y: (sub.y * 16 + sub.pixelY + 8) >> 4 };
						dying[r.player].lastSq = sq;
						dying[r.player].lastT = r.time;
						dying[r.player].terr = s.grid[sq.y * 256 + sq.x];
						/* water adjacency judged at death time, not log end */
						dying[r.player].adjWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
							const t2 = s.grid[(sq.y + dy) * 256 + (sq.x + dx)];
							return t2 === 1 || t2 === 9 || t2 === 255;
						});
					} else if (!sub.dying && dying[r.player]) {
						if (dying[r.player].lastSq && dying[r.player].code !== 3) deathEnds.push(dying[r.player]);
						delete dying[r.player];
					}
				}
				if ((sub.type === "terrain_change" && sub.terrain === 3) || (sub.type === "explosion" && (sub.code === 3 || sub.code === 0x0d)))
					craterEvents.push({ t: r.time, x: sub.x, y: sub.y, sup: sub.code === 0x0d });
				if (sub.type === "terrain_change" && (sub.terrain === 1 || sub.terrain === 9))
					waterEvents.push({ t: r.time, x: sub.x, y: sub.y });
			}
			BoloGame.apply_record(s, r, null, null);
		}
		for (const d of deathEnds) {
			deaths++;
			const hasEvent = craterEvents.some(c => Math.abs(c.t - d.lastT) <= 300 &&
				((c.sup && d.lastSq.x >= c.x && d.lastSq.x <= c.x + 1 && d.lastSq.y >= c.y && d.lastSq.y <= c.y + 1) ||
				(!c.sup && Math.abs(c.x - d.lastSq.x) <= 1 && Math.abs(c.y - d.lastSq.y) <= 1)));
			if (hasEvent) { evented++; continue; }
			noCrater++;
			terrHist[d.terr] = (terrHist[d.terr] || 0) + 1;
			if (!d.adjWater) continue;
			nearWater++;
			if (waterEvents.some(w => w.x === d.lastSq.x && w.y === d.lastSq.y && w.t > d.lastT && w.t - d.lastT <= 500)) {
				flooded++;
				if (floodSamples.length < 8) floodSamples.push(path.relative(ROOT, file) + " at tick " + d.lastT);
			}
		}
	} catch { /* skip corrupt */ }
	if (files % 100 === 0) console.error("  ..." + files + " logs");
}

console.log("logs:", files, "| death sequences (non-sunk, with wreck square):", deaths);
console.log("crater/superboom EVENT near final square:", evented, "(" + (100 * evented / deaths).toFixed(1) + "%)");
console.log("no crater event:", noCrater, "- terrain histogram:", JSON.stringify(terrHist));
console.log("no-crater deaths adjacent to water:", nearWater);
console.log("...that FLOODED afterwards (would betray an unlogged crater):", flooded);
if (floodSamples.length) floodSamples.forEach(x => console.log("  FLOODED:", x));
else console.log("  (zero floods = no eventless cratering exists)");
