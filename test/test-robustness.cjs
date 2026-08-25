// Malformed-input and encoding tests for the CJS parser build, plus a
// parity check that both parser builds decode the sample log identically.

const fs = require("node:fs");
const path = require("node:path");
const BoloLog = require("../viewer/logparse.js");

let failures = 0;
function check(what, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`}`);
}
function throws(what, fn) {
	try { fn(); failures++; console.log(`FAIL ${what}: did not throw`); }
	catch { console.log(`ok   ${what}`); }
}

// --- MacRoman: full-range fixture against the encoding standard ---
const fixture = Uint8Array.from([0x8e, 0xca, 0xf0, 0xff, 0xa5, 0xd5]);
check("macRoman fixture", BoloLog.macRoman(fixture), "é ˇ•’");
check("macRoman table is 128 entries",
	BoloLog.macRoman(Uint8Array.from(Array.from({ length: 128 }, (_, i) => i + 0x80))).length, 128);

// --- malformed inputs ---
const MASK0 = 0x83; // first mask byte
throws("empty buffer rejected", () => BoloLog.parseHeader(new Uint8Array(0)));
throws("wrong signature rejected", () => BoloLog.parseHeader(new Uint8Array(72)));

function header() {
	const h = new Uint8Array(72);
	h.set([0x42, 0x6f, 0x6c, 0x6f, 0x00, 0x99, 0x07, 0x00]);
	return h;
}

// header-only file: zero records, no throw
check("header-only file yields no records", [...BoloLog.records(header())].length, 0);

// zero record length throws (encrypted zero = MASK[0])
{
	const buf = new Uint8Array(72 + 5);
	buf.set(header());
	buf[76] = 0 ^ MASK0;
	throws("zero record length throws", () => [...BoloLog.records(buf)]);
}

// truncated final record is dropped and reported
{
	const buf = new Uint8Array(72 + 5);
	buf.set(header());
	buf[76] = 100 ^ MASK0; // claims 100 bytes, file ends
	const stats = {};
	check("truncated record dropped", [...BoloLog.records(buf, stats)].length, 0);
	check("truncation reported", stats.truncatedBytes, 5);
}

// --- truncated subpackets must warn, not silently half-decode ---
{
	const MASK = [0x83, 0xb6, 0x59, 0xe3, 0xee, 0x59, 0x10, 0x27, 0xa8];
	function makeRecord(payload) {
		// payload = decrypted record bytes after the length byte
		const buf = new Uint8Array(72 + 4 + 1 + payload.length);
		buf.set([0x42, 0x6f, 0x6c, 0x6f, 0x00, 0x99, 0x07, 0x00]);
		buf[76] = (payload.length + 1) ^ MASK[0];
		for (let i = 0; i < payload.length; i++) buf[77 + i] = payload[i] ^ MASK[(i + 1) % MASK.length];
		return buf;
	}
	// bare F8 with no string bytes
	let recs = [...BoloLog.records(makeRecord([0x00, 0x00, 0x00, 0xf8]))];
	check("bare F8 warns", !!recs[0].warning, true);
	// bare F3 with no run bytes
	recs = [...BoloLog.records(makeRecord([0x00, 0x00, 0x00, 0xf3]))];
	check("bare F3 warns", !!recs[0].warning, true);
	// F1 02 claiming 255 pillboxes in a 3-byte tail
	recs = [...BoloLog.records(makeRecord([0x00, 0x00, 0x00, 0xf1, 0x02, 0xff]))];
	check("absurd list count warns", !!recs[0].warning, true);
	check("absurd list count allocates nothing", recs[0].subpackets.filter(s => s.type === "pillbox_list").length, 0);
	// record length above the format cap throws
	const bad = makeRecord([0x00, 0x00, 0x00]);
	bad[76] = 200 ^ MASK[0];
	throws("record length above 127 throws", () => [...BoloLog.records(bad)]);
	// records() on a non-Bolo buffer with plausible bytes now throws
	throws("records() rejects wrong signature", () => [...BoloLog.records(new Uint8Array(128).fill(0x11))]);
}

// --- towed-base bit (b=2): never seen in real logs, but the position
// extension must be consumed (bolorama skips senderFlags & 0xE0) ---
{
	const MASK = [0x83, 0xb6, 0x59, 0xe3, 0xee, 0x59, 0x10, 0x27, 0xa8, 0x64];
	function rec(payload) {
		const buf = new Uint8Array(72 + 4 + 1 + payload.length);
		buf.set([0x42, 0x6f, 0x6c, 0x6f, 0x00, 0x99, 0x07, 0x00]);
		buf[76] = (payload.length + 1) ^ MASK[0];
		for (let i = 0; i < payload.length; i++) buf[77 + i] = payload[i] ^ MASK[(i + 1) % MASK.length];
		return [...BoloLog.records(buf)][0];
	}
	// b=2, no tank position: 3-byte extension then a shot_fired opcode
	let r = rec([0x00, 0x20, 0x00, 0x40, 0x41, 0x00, 0x54]);
	check("b=2 record parses cleanly", r.warning === undefined, true);
	check("b=2 extension type", r.subpackets[0].type, "towed_base_position");
	check("b=2 following opcode intact", r.subpackets[1].type, "shot_fired");
	// b=a (LGM out + towed bit): single extension, reads as LGM
	r = rec([0x00, 0xa0, 0x00, 0x40, 0x41, 0x00, 0x54]);
	check("b=a record parses cleanly", r.warning === undefined, true);
	check("b=a extension type", r.subpackets[0].type, "lgm_position");
}

// One awaited main for the async checks: two detached IIFEs could race,
// with the later one exiting before the earlier finished.
(async () => {
	// --- the generated viewer parser must match the committed file ---
	const { build } = await import("../tools/build-viewer-parser.mjs");
	// CRLF-normalize so a core.autocrlf checkout compares content, not line endings
	const committed = fs.readFileSync(path.join(__dirname, "..", "viewer", "logparse.js"), "utf8").replace(/\r\n/g, "\n");
	check("viewer/logparse.js is freshly generated from src/parse.js", build() === committed, true);

	// --- parity: both parser builds must agree on the whole sample log ---
	const esm = await import("../src/parse.js");
	const log1 = path.join(__dirname, "..", "fixtures", "n20021018.2");
	if (fs.existsSync(log1)) {
		const buf = new Uint8Array(fs.readFileSync(log1));
		const a = [...esm.records(buf)];
		const b = [...BoloLog.records(buf)];
		check("parity: record counts", a.length, b.length);
		check("parity: parseLog truncatedBytes", esm.parseLog(buf).truncatedBytes, BoloLog.parseLog(buf).truncatedBytes);
		let diverged = -1;
		for (let i = 0; i < a.length; i++) {
			if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) { diverged = i; break; }
		}
		check("parity: all records identical (first divergence)", diverged, -1);
	} else {
		console.log("skip: fixtures/n20021018.2 not present; parity test skipped");
	}
	process.exitCode = failures ? 1 : 0;
})();
