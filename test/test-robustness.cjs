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

// --- nuBolo: the host's clock picks the epoch and the text encoding ---
{
	const { build_log, str } = require("./synthetic-log.cjs");
	/* F1 01 game info whose start time is `seconds` */
	function game_info(seconds) {
		const g = new Array(88).fill(0);
		g[40] = seconds >>> 24; g[41] = (seconds >> 16) & 0xff; g[42] = (seconds >> 8) & 0xff; g[43] = seconds & 0xff;
		return [0, 0x00, 0x70, 0xf1, 0x01, ...g];
	}
	/* the node id comes ahead of the game info, as it does in real logs */
	const name = [0, 0x00, 0x70, 0xf8, ...str("\xc5sa@1")];
	const chat = [1, 0x00, 0x70, 0xfa, 0xff, 0xff, ...str("j\xe4vla")];
	const mac_chat = [2, 0x00, 0x70, 0xfa, 0xff, 0xff, ...str("\x8a\xe4")];
	function decoded(seconds) {
		const recs = [...BoloLog.records(build_log([name, game_info(seconds), chat, mac_chat]))];
		const subs = recs.flatMap(r => r.subpackets);
		const gi = subs.find(s => s.type === "game_info");
		return {
			nubolo: gi.nubolo,
			start: new Date(gi.startTime).toISOString().slice(0, 19),
			text: subs.filter(s => s.type === "node_id" || s.type === "message").map(s => s.name || s.text),
		};
	}
	check("nuBolo log: 2001 epoch, Latin-1 text, 80-9F kept MacRoman", decoded(191256632),
		{ nubolo: true, start: "2007-01-23T14:50:32", text: ["Åsa@1", "jävla", "ä‰"] });
	check("classic log: 1904 epoch, MacRoman text", decoded(3117823323),
		{ nubolo: false, start: "2002-10-18T22:02:03", text: ["≈sa@1", "j‰vla", "ä‰"] });
	check("no timestamp: no start time", BoloLog.gameStart(0), { nubolo: false, startTime: null });
}

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
	const MASK = [0x83, 0xb6, 0x59, 0xe3, 0xee, 0x59, 0x10, 0x27, 0xa8, 0x64, 0xff, 0x17, 0x8f, 0xcc, 0xec, 0x85];
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
	// a zero-length chat message ends the parse: the bytes Bolo packs after
	// one are buffer leavings, here spelling a terrain change in deep sea
	// (corpus 20021024.3, record 8617) [E:empty-chat]
	recs = [...BoloLog.records(makeRecord([0x00, 0x00, 0x00, 0xfa, 0xff, 0xff, 0x00, 0x68, 0x68, 0x20]))];
	check("zero-length message keeps its junk out of the parse", recs[0].subpackets.map(s => s.type), ["message"]);
	check("zero-length message flags the record", recs[0].warning, "junk after a zero-length chat message");
	check("zero-length message keeps the junk for inspection", recs[0].unparsed, "686820");
	// a real message followed by a shell list parses both
	recs = [...BoloLog.records(makeRecord([0x00, 0x00, 0x00, 0xfa, 0xff, 0xff, 0x02, 0x68, 0x69, 0x00, 0x64, 0x64, 0x00]))];
	check("shell list after a real message is parsed", recs[0].subpackets.map(s => s.type), ["message", "shells"]);
	check("shell list after a real message leaves no warning", recs[0].warning, undefined);
	// record length above the format cap throws
	const bad = makeRecord([0x00, 0x00, 0x00]);
	bad[76] = 200 ^ MASK[0];
	throws("record length above 127 throws", () => [...BoloLog.records(bad)]);
	// records() on a non-Bolo buffer with plausible bytes now throws
	throws("records() rejects wrong signature", () => [...BoloLog.records(new Uint8Array(128).fill(0x11))]);
}

// --- towed-base bit (b & 2): never seen in a real log, and nothing is
// known of the layout it implies, so the record is refused whole rather
// than parsed under a guessed one [E:ext-bit] ---
{
	const MASK = [0x83, 0xb6, 0x59, 0xe3, 0xee, 0x59, 0x10, 0x27, 0xa8, 0x64, 0xff, 0x17];
	function rec(payload) {
		const buf = new Uint8Array(72 + 4 + 1 + payload.length);
		buf.set([0x42, 0x6f, 0x6c, 0x6f, 0x00, 0x99, 0x07, 0x00]);
		buf[76] = (payload.length + 1) ^ MASK[0];
		for (let i = 0; i < payload.length; i++) buf[77 + i] = payload[i] ^ MASK[(i + 1) % MASK.length];
		return [...BoloLog.records(buf)][0];
	}
	// b=2 alone, payload shaped like a 3-byte block then a shot_fired
	let r = rec([0x00, 0x20, 0x00, 0x40, 0x41, 0x00, 0x54]);
	check("b=2 record warns", r.warning, "towed-base status bit set (b & 2): record layout unknown");
	check("b=2 record yields no subpackets", r.subpackets, []);
	check("b=2 record keeps its payload for inspection", r.unparsed, "40410054");
	check("b=2 header fields still read", [r.seq, r.player, r.status, r.tankStatus, r.tankDir], [0, 0, 2, 0, 0]);
	// b=a (LGM out + towed bit): the bit taints the whole record, even
	// the tank position, since the layout after it is the guess
	r = rec([0x00, 0xa0, 0x80, 0x40, 0x41, 0x00, 0x30, 0x00, 0x40, 0x41, 0x00, 0x54]);
	check("b=a record warns", !!r.warning, true);
	check("b=a record yields no subpackets", r.subpackets, []);
	// b=3 (tick + towed): the same
	r = rec([0x00, 0x30, 0x00, 0x54]);
	check("b=3 record warns", !!r.warning, true);
	check("b=3 record yields no subpackets", r.subpackets, []);
	// b=8 and b=4 still parse the 3-byte extension as before
	r = rec([0x00, 0x80, 0x00, 0x40, 0x41, 0x00, 0x54]);
	check("b=8 parses cleanly", r.warning, undefined);
	check("b=8 extension type", r.subpackets.map(s => s.type), ["lgm_position", "shot_fired"]);
	r = rec([0x00, 0x40, 0x00, 0x40, 0x41, 0x00, 0x54]);
	check("b=4 parses cleanly", r.warning, undefined);
	check("b=4 extension type", r.subpackets.map(s => s.type), ["parachute_position", "shot_fired"]);
}

// One awaited main for the async checks: two detached IIFEs could race,
// with the later one exiting before the earlier finished.
(async () => {
	// --- the generated viewer parser must match the committed file ---
	const { build } = await import("../tools/build-viewer-parser.mjs");
	// CRLF-normalize so a core.autocrlf checkout compares content, not line endings
	const committed = fs.readFileSync(path.join(__dirname, "..", "viewer", "logparse.js"), "utf8").replace(/\r\n/g, "\n");
	check("viewer/logparse.js is freshly generated from src/parse.js", build() === committed, true);

	// --- likewise the viewer's sprite data, from the PNGs in sprites/ ---
	const sprites = await import("../tools/build-viewer-sprites.mjs");
	const committed_sprites = fs.readFileSync(path.join(__dirname, "..", "viewer", "sprite_data.js"), "utf8").replace(/\r\n/g, "\n");
	check("viewer/sprite_data.js is freshly generated from sprites/", sprites.build() === committed_sprites, true);
	const sprite_data = require("../viewer/sprite_data.js");
	const missing = require("../viewer/sprites.js").NAMES.filter(name => !sprite_data[name]);
	check("every terrain sprite the viewer draws is in viewer/sprite_data.js", missing.join(), "");

	// --- parity: both parser builds must agree on the whole sample log ---
	const esm = await import("../src/parse.js");
	const log1 = path.join(__dirname, "..", "fixtures", "long_game");
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
		console.log("skip: fixtures/long_game not present; parity test skipped");
	}
	process.exitCode = failures ? 1 : 0;
})();
