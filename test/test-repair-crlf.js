// The line-ending repair must undo a Mac-to-Unix conversion of an intact
// log: the framing exactly (every collapsed CR LF pair found), the time
// tags, and most of the ambiguous payload bytes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rawRecords, records } from "../src/parse.js";
import { damage, looks_converted, repair } from "../tools/repair-crlf.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(what, got, want) {
	const ok = got === want;
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${got}${ok ? "" : ` (wanted ${want})`}`);
}

// the conversion itself: lone CR to LF, CR LF to LF, LF untouched
check("damage", Array.from(damage(Uint8Array.from([1, 0x0d, 2, 0x0d, 0x0a, 3, 0x0a, 0x0d]))).join(","), "1,10,2,10,3,10,10");

// fixtures/pairs/20030330.1-A holds two CR LF pairs, one of them in a time
// tag, so its damaged copy does not even frame
const orig = new Uint8Array(readFileSync(join(root, "fixtures", "pairs", "20030330.1-A")));
const dmg = damage(orig);
check("intact log not flagged", looks_converted(orig).converted, false);
check("damaged log flagged", looks_converted(dmg).converted, true);
let framed = true;
try {
	for (const rec of records(dmg)) void rec;
} catch {
	framed = false;
}
check("damaged log fails to frame", framed, false);

const res = repair(dmg);
const out = res.bytes;
check("repaired length", out.length, orig.length);

const want_times = [...rawRecords(orig)].map(r => r.time);
const got_times = [...rawRecords(out)].map(r => r.time);
check("record count", got_times.length, want_times.length);
// a tag whose low byte was hit can stay 3 ticks out, never more, and the
// order never runs backwards
check("time tags within 3 ticks", got_times.every((t, i) => Math.abs(t - want_times[i]) <= 3), true);
check("time order", got_times.every((t, i) => i === 0 || t >= got_times[i - 1]), true);
check("parse warnings", [...records(out)].filter(r => r.warning).length, 0);

let ambiguous = 0, right = 0;
for (const d of res.decisions) {
	if (d.kind === 3) continue; // the LF half of a restored pair
	ambiguous++;
	const pos = res.offsets[d.record] + d.byte;
	if (out[pos] === orig[pos]) right++;
}
check("ambiguous bytes", ambiguous, 1420);
check("at least 94% restored exactly", right / ambiguous >= 0.94, true);
let wrong = 0;
for (let i = 0; i < out.length; i++) if (out[i] !== orig[i]) wrong++;
check("every wrong byte is an ambiguous one", wrong, ambiguous - right);

if (failures) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all repair-crlf checks passed");
