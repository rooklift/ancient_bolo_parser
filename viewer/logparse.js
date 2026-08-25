/* GENERATED FILE - do not edit. Built from src/parse.js (plus the mask
 * from src/mask.js) by tools/build-viewer-parser.mjs, as a classic
 * script / CJS module for the viewer. Edit src/parse.js and rebuild. */
"use strict";
(function () {

// Parser for classic Mac Bolo (Stuart Cheshire, 0.99.x) game log files.
//
// Format knowledge is from Carl Osterwald's ("wharf rat", author of
// BoloViewer) reverse-engineering notes, cross-checked against the
// independently derived wire-protocol parser in astrospark/bolorama.
// See FORMAT.md for the write-up.

const MASK = Uint8Array.from([
	0x83, 0xb6, 0x59, 0xe3, 0xee, 0x59, 0x10, 0x27,
	0xa8, 0x64, 0xff, 0x17, 0x8f, 0xcc, 0xec, 0x85,
	0x9d, 0x8b, 0x32, 0x77, 0x3d, 0x4d, 0xc9, 0x14,
	0x74, 0x4b, 0xaa, 0xbe, 0x40, 0x56, 0x8e, 0x6f,
	0x42, 0x9b, 0x80, 0x8f, 0x8c, 0x5f, 0x0b, 0x61,
	0xdc, 0xfc, 0x84, 0x1f, 0x45, 0xa8, 0x3a, 0x39,
	0xfd, 0x6f, 0xc9, 0xbe, 0x31, 0x7e, 0x0b, 0x39,
	0x28, 0xfb, 0xff, 0xaa, 0x7b, 0x58, 0x82, 0x65,
	0xd0, 0xd6, 0x0e, 0x15, 0x35, 0xd8, 0x64, 0x86,
	0x83, 0x0c, 0xe7, 0x59, 0xb5, 0xe3, 0xd8, 0x88,
	0x35, 0xb8, 0xcf, 0x4f, 0x81, 0xb1, 0xce, 0x92,
	0x86, 0x6f, 0xc8, 0xb1, 0x9f, 0xd5, 0x29, 0xc2,
	0x80, 0x24, 0xc6, 0xc4, 0x01, 0xc4, 0x4f, 0xf9,
	0x2a, 0xe3, 0x12, 0x11, 0xa4, 0x1e, 0x3d, 0x1c,
	0xf9, 0xd6, 0xdc, 0xcb, 0x2d, 0xf9, 0x74, 0x25,
	0xf8, 0xf1, 0xa1, 0x4c, 0x89, 0xff, 0x79, 0xdd,
]);

const TICKS_PER_SECOND = 50;

const HEADER_SIZE = 72;

// ---------------------------------------------------------------------------
// MacRoman decoding, so player names and messages survive intact.

/* Mac Roman 0x80-0xFF, generated from the encoding table (do not edit
 * by hand - an earlier hand-transcribed version was missing 0xF0 and
 * mis-mapped everything after it). */
const MACROMAN_HIGH =
	"\u00c4\u00c5\u00c7\u00c9\u00d1\u00d6\u00dc\u00e1\u00e0\u00e2\u00e4\u00e3\u00e5\u00e7\u00e9\u00e8\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f1\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc" +
	"\u2020\u00b0\u00a2\u00a3\u00a7\u2022\u00b6\u00df\u00ae\u00a9\u2122\u00b4\u00a8\u2260\u00c6\u00d8\u221e\u00b1\u2264\u2265\u00a5\u00b5\u2202\u2211\u220f\u03c0\u222b\u00aa\u00ba\u03a9\u00e6\u00f8" +
	"\u00bf\u00a1\u00ac\u221a\u0192\u2248\u2206\u00ab\u00bb\u2026\u00a0\u00c0\u00c3\u00d5\u0152\u0153\u2013\u2014\u201c\u201d\u2018\u2019\u00f7\u25ca\u00ff\u0178\u2044\u20ac\u2039\u203a\ufb01\ufb02" +
	"\u2021\u00b7\u201a\u201e\u2030\u00c2\u00ca\u00c1\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc\u00d3\u00d4\uf8ff\u00d2\u00da\u00db\u00d9\u0131\u02c6\u02dc\u00af\u02d8\u02d9\u02da\u00b8\u02dd\u02db\u02c7";

function macRoman(bytes) {
	let out = "";
	for (const b of bytes) {
		out += b < 0x80 ? String.fromCharCode(b) : MACROMAN_HIGH[b - 0x80];
	}
	return out;
}

// ---------------------------------------------------------------------------
// Low level: header + record splitting + decryption.

function parseHeader(buf) {
	if (buf.length < HEADER_SIZE || macRoman(buf.subarray(0, 4)) !== "Bolo") {
		throw new Error("Not a Bolo log file (missing 'Bolo' signature)");
	}
	const version = Array.from(buf.subarray(4, 8))
		.map(b => b.toString(16).padStart(2, "0"))
		.join("");
	return {
		version,                               // "00990700" for Bolo 0.99.7
		flags: Array.from(buf.subarray(8, HEADER_SIZE)),
	};
}

// Yields { offset, time, data } with data already decrypted.
// The 4-byte little-endian time tag is stored in the clear; the XOR mask
// restarts at each record's length byte. Length includes the length byte
// itself, so payload is (length - 1) bytes.
// Pass a `stats` object to learn about trailing truncation:
// stats.truncatedBytes is set when the file ends mid-record.
function* rawRecords(buf, stats) {
	// Cheap signature check so raw buffers that aren't Bolo logs fail loudly
	// even when the caller skipped parseHeader().
	if (buf.length < HEADER_SIZE || buf[0] !== 0x42 || buf[1] !== 0x6f || buf[2] !== 0x6c || buf[3] !== 0x6f) {
		throw new Error("Not a Bolo log file (missing 'Bolo' signature)");
	}
	let pos = HEADER_SIZE;
	// The 32-bit time tag derives from the Mac's TickCount() and wraps after
	// ~2.7 years of uptime. Times are monotonic in file order (verified:
	// zero backward steps across all sample logs), so a huge backward jump
	// can only be a wrap: unwrap it so downstream timelines stay monotonic.
	let timeBase = 0;
	let lastRaw = -1;
	while (pos + 5 <= buf.length) {
		const raw = (buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24)) >>> 0;
		if (lastRaw >= 0 && lastRaw - raw > 0x80000000) {
			timeBase += 0x100000000;
		}
		lastRaw = raw;
		const length = buf[pos + 4] ^ MASK[0];
		// A record is length byte + 3-byte header at minimum, and the length
		// byte is capped at 127 by the format (the mask is 128 bytes).
		if (length < 4 || length > 127) {
			throw new Error(`Bad record length ${length} at offset ${pos} (valid range 4-127)`);
		}
		const end = pos + 4 + length;
		if (end > buf.length) {
			// Truncated final record (log cut off mid-write); drop it, but
			// report the fact via stats.
			if (stats) stats.truncatedBytes = buf.length - pos;
			return;
		}
		const data = new Uint8Array(length - 1);
		for (let i = 0; i < data.length; i++) {
			data[i] = buf[pos + 5 + i] ^ MASK[(i + 1) % MASK.length];
		}
		yield { offset: pos, time: timeBase + raw, data };
		pos = end;
	}
	if (stats && pos < buf.length) stats.truncatedBytes = buf.length - pos;
}

// ---------------------------------------------------------------------------
// Subpacket parsing.

// Throws on out-of-range reads so truncated subpackets become record
// warnings instead of silently decoding as empty/undefined values.
function ensure(data, pos, n) {
	if (pos + n > data.length) {
		throw new Error("truncated subpacket");
	}
}

function pascalString(data, pos) {
	ensure(data, pos, 1);
	const len = data[pos];
	ensure(data, pos, 1 + len);
	const str = macRoman(data.subarray(pos + 1, pos + 1 + len));
	return { str, next: pos + 1 + len };
}

// Map square + intra-square pixel offset (signed nibble style: 0x00 = centre).
function squarePos(x, y, pix) {
	return { x, y, pixelY: pix >> 4, pixelX: pix & 0x0f };
}

// Parse the ID-coded subpackets that follow any position subpackets.
// Appends to record.subpackets; on anything unrecognised, stores the raw
// remainder in record.unparsed and returns.
function parseIdSubpackets(rec, data, pos) {
	const subs = rec.subpackets;
	while (pos < data.length) {
		const start = pos;
		const byte = data[pos];
		const hi = byte >> 4;
		const lo = byte & 0x0f;
		try {
			if (hi <= 0x03) {              // 1-4 shells in flight from this player
				ensure(data, pos, 4 + hi * 2);
				const count = hi + 1;
				const shells = [{
					direction: lo,
					x: data[pos + 1],
					y: data[pos + 2],
					pixel: data[pos + 3],
				}];
				for (let i = 0; i < hi; i++) {
					shells.push({
						offsetX: data[pos + 4 + i * 2],
						offsetY: data[pos + 5 + i * 2],
					});
				}
				subs.push({ type: "shells", count, shells });
				pos += 4 + hi * 2;
			} else if (hi === 0x04) {      // unused (missile in flight)
				ensure(data, pos, 4);
				subs.push({ type: "missile", direction: lo, raw: hex(data, pos, 4) });
				pos += 4;
			} else if (hi === 0x05) {      // shot fired from tank
				subs.push({ type: "shot_fired", direction: lo });
				pos += 1;
			} else if (hi === 0x06) {      // terrain change
				ensure(data, pos, 3);
				subs.push({ type: "terrain_change", terrain: lo, x: data[pos + 1], y: data[pos + 2] });
				pos += 3;
			} else if (hi === 0x07) {      // explosion / sound (see FORMAT.md for lo codes)
				ensure(data, pos, 3);
				subs.push({ type: "explosion", code: lo, x: data[pos + 1], y: data[pos + 2] });
				pos += 3;
			} else if (hi === 0x08) {      // unused
				subs.push({ type: "unknown_8", nibble: lo });
				pos += 1;
			} else if (hi === 0x09) {      // 1 damage to pillbox #n
				subs.push({ type: "pillbox_damage", pillbox: lo });
				pos += 1;
			} else if (hi === 0x0a) {      // 5 damage (one shell) to base #n
				subs.push({ type: "base_damage", base: lo });
				pos += 1;
			} else if (hi >= 0x0b && hi <= 0x0e && byte !== 0xff) {
				const what = { 0xb: "shells", 0xc: "mines", 0xd: "armor", 0xe: "missiles" }[hi];
				subs.push({ type: "base_drain", base: lo, resource: what });
				pos += 1;
			} else if (byte === 0xf0) {    // rejoin / map header request
				ensure(data, pos, 2);
				subs.push({ type: "map_header_request", code: data[pos + 1] });
				pos += 2;
			} else if (byte === 0xf1) {    // map header info
				pos = parseF1(subs, data, pos);
			} else if (byte === 0xf2) {    // map terrain request
				ensure(data, pos, 3);
				subs.push({ type: "map_terrain_request", mapKnown: (data[pos + 1] << 8) | data[pos + 2] });
				pos += 3;
			} else if (byte === 0xf3) {    // map terrain run (map-file RLE)
				ensure(data, pos, 4);
				const runLen = data[pos + 3]; // includes its own 4-byte run header
				if (runLen < 4) {
					throw new Error("map run shorter than its own header");
				}
				ensure(data, pos, 3 + runLen);
				subs.push({
					type: "map_run",
					mapKnown: (data[pos + 1] << 8) | data[pos + 2],
					run: Array.from(data.subarray(pos + 3, pos + 3 + runLen)),
				});
				pos += 3 + runLen;
			} else if (byte === 0xf4) {    // pillbox #n fires, shell direction d
				ensure(data, pos, 2);
				subs.push({ type: "pillbox_fires", pillbox: data[pos + 1] >> 4, direction: data[pos + 1] & 0x0f });
				pos += 2;
			} else if (byte === 0xf5) {    // LGM death
				ensure(data, pos, 3);
				subs.push({ type: "lgm_death", x: data[pos + 1], y: data[pos + 2] });
				pos += 3;
			} else if (byte === 0xf6) {    // tank hops onto boat
				subs.push({ type: "board_boat" });
				pos += 1;
			} else if (byte === 0xf7) {    // tank lays mine
				subs.push({ type: "lay_mine" });
				pos += 1;
			} else if (byte === 0xf8) {    // node id / player name ("name@node")
				const { str, next } = pascalString(data, pos + 1);
				subs.push({ type: "node_id", name: str });
				pos = next;
			} else if (byte === 0xf9) {    // tank death (1 = explosion, 2 = crater, 3 = sunk)
				ensure(data, pos, 2);
				subs.push({ type: "tank_death", code: data[pos + 1] });
				pos += 2;
			} else if (byte === 0xfa) {    // chat message
				ensure(data, pos, 4);
				const address = data[pos + 1] | (data[pos + 2] << 8);
				const { str, next } = pascalString(data, pos + 3);
				subs.push({ type: "message", address, text: str });
				pos = next;
			} else if (byte === 0xfb) {    // shell falls to ground
				ensure(data, pos, 4);
				subs.push({ type: "shell_falls", x: data[pos + 1], y: data[pos + 2], pixel: data[pos + 3] });
				pos += 4;
			} else if (byte === 0xfc) {    // shell hits tank #n
				ensure(data, pos, 2);
				subs.push({ type: "tank_hit", direction: data[pos + 1] >> 4, tank: data[pos + 1] & 0x0f });
				pos += 2;
			} else if (byte === 0xfd || byte === 0xfe) {
				subs.push({ type: "nop", raw: byte });
				pos += 1;
			} else if (byte === 0xff) {
				pos = parseFF(subs, data, pos);
			} else {
				throw new Error(`unknown subpacket id 0x${byte.toString(16)}`);
			}
		} catch (err) {
			rec.unparsed = hex(data, start, data.length - start);
			rec.warning = String(err.message || err);
			return;
		}
		if (pos <= start) {
			rec.unparsed = hex(data, start, data.length - start);
			rec.warning = "subpacket consumed no bytes";
			return;
		}
	}
	if (pos > data.length) {
		rec.warning = `subpacket overran record by ${pos - data.length} byte(s)`;
	}
}

function parseF1(subs, data, pos) {
	ensure(data, pos, 2);
	const sub = data[pos + 1];
	if (sub === 0x01) {
		ensure(data, pos, 90);
		// 56-byte GAMEINFO (Brain.h) + 16 little-endian alliance words = 88 bytes.
		const g = data.subarray(pos + 2, pos + 90);
		const nameLen = Math.min(g[0], 35);
		const alliances = [];
		for (let i = 0; i < 16; i++) {
			alliances.push(g[56 + i * 2] | (g[57 + i * 2] << 8));
		}
		subs.push({
			type: "game_info",
			mapName: macRoman(g.subarray(1, 1 + nameLen)),
			gameId: hex(g, 36, 8),
			hostIp: `${g[36]}.${g[37]}.${g[38]}.${g[39]}`,
			startTimeMac: (g[40] << 24 | g[41] << 16 | g[42] << 8 | g[43]) >>> 0,
			gameType: g[44],
			minesFlag: g[45],
			allowAI: g[46],
			assistAI: g[47],
			startDelay: readU32LE(g, 48),
			timeLimit: readU32LE(g, 52),
			alliances,
		});
		return pos + 90;
	}
	if (sub === 0x02 || sub === 0x03 || sub === 0x04) {
		// Pill / base / start lists, same per-item layout as the .bmap format.
		ensure(data, pos, 3);
		const count = data[pos + 2];
		if (count > 16) {
			throw new Error(`implausible object list count ${count} (max 16)`);
		}
		const itemSize = { 2: 5, 3: 6, 4: 3 }[sub];
		ensure(data, pos, 3 + count * itemSize);
		const kind = { 2: "pillbox", 3: "base", 4: "start" }[sub];
		const items = [];
		for (let i = 0; i < count; i++) {
			const p = pos + 3 + i * itemSize;
			if (sub === 0x02) {
				items.push({ x: data[p], y: data[p + 1], owner: data[p + 2], armour: data[p + 3], speed: data[p + 4] });
			} else if (sub === 0x03) {
				items.push({ x: data[p], y: data[p + 1], owner: data[p + 2], armour: data[p + 3], shells: data[p + 4], mines: data[p + 5] });
			} else {
				items.push({ x: data[p], y: data[p + 1], direction: data[p + 2] });
			}
		}
		subs.push({ type: `${kind}_list`, items });
		return pos + 3 + count * itemSize;
	}
	// F18x / F1Cx pill or base "history": 4 bytes of bit fields + 36-byte block.
	ensure(data, pos, 42);
	subs.push({ type: "history", sub, raw: hex(data, pos + 2, 40) });
	return pos + 42;
}

function parseFF(subs, data, pos) {
	ensure(data, pos, 2);
	const code = data[pos + 1];
	const hi = code >> 4;
	const lo = code & 0x0f;
	if (hi <= 0x04) {
		const kind = ["pill_pickup", "pill_repair_4", "pill_repair_8", "pill_repair_12", "pill_repair_full"][hi];
		subs.push({ type: kind, pillbox: lo });
		return pos + 2;
	}
	if (code === 0x50 || code === 0x51) {
		ensure(data, pos, 4);
		subs.push({
			type: code === 0x50 ? "pill_plant" : "pill_dumped_by_dead_lgm",
			x: data[pos + 2],
			y: data[pos + 3],
		});
		return pos + 4;
	}
	if (hi === 0x06) {
		subs.push({ type: "base_capture", base: lo });
		return pos + 2;
	}
	if (hi === 0x07) {
		subs.push({ type: "base_tow_pickup", base: lo });
		return pos + 2;
	}
	if (hi === 0x08) {
		ensure(data, pos, 4);
		subs.push({ type: "base_tow_drop", base: lo, x: data[pos + 2], y: data[pos + 3] });
		return pos + 4;
	}
	if (code === 0xf0) {
		// Quit: length byte then three fields of that length (network addresses?).
		ensure(data, pos, 3);
		const fieldLen = data[pos + 2];
		ensure(data, pos, 3 + fieldLen * 3);
		subs.push({ type: "quit", fields: [0, 1, 2].map(i => hex(data, pos + 3 + i * fieldLen, fieldLen)) });
		return pos + 3 + fieldLen * 3;
	}
	if (code === 0xf1) {
		subs.push({ type: "map_save" });
		return pos + 2;
	}
	if (code === 0xf2 || code === 0xf3) {
		ensure(data, pos, 4);
		subs.push({
			type: code === 0xf2 ? "alliance_request" : "alliance_accept",
			tanks: data[pos + 2] | (data[pos + 3] << 8),
		});
		return pos + 4;
	}
	if (code === 0xf4) {
		subs.push({ type: "alliance_leave" });
		return pos + 2;
	}
	if (code === 0xf5 || code === 0xf6) {
		subs.push({ type: code === 0xf5 ? "player_unlocked" : "player_locked" });
		return pos + 2;
	}
	throw new Error(`unknown FF subpacket 0x${code.toString(16)}`);
}

function readU32LE(a, i) {
	return (a[i] | (a[i + 1] << 8) | (a[i + 2] << 16) | (a[i + 3] << 24)) >>> 0;
}

function hex(data, pos, len) {
	return Array.from(data.subarray(pos, pos + len))
		.map(b => b.toString(16).padStart(2, "0"))
		.join("");
}

// ---------------------------------------------------------------------------
// Record-level parsing.

// status bits: bit 0 = 1000-tick base-stock increment; bit 1 unused (towed
// bases); bits 2+3 coupled: 4 = LGM dead, 8 = LGM out of tank, C = LGM out
// carrying a pillbox. (So e.g. 9 = LGM out + tick, D = C + tick.)
// tank status bits: 1 = in boat, 2 = hidden, 4 = dead, 8 = has tank
// position; special values 7 = joining/dead, F = BoloViewer attached log.
function parseRecord(raw) {
	const data = raw.data;
	const rec = {
		offset: raw.offset,
		time: raw.time,
		seq: data[0],
		status: data[1] >> 4,
		player: data[1] & 0x0f,
		tankStatus: data[2] >> 4,
		tankDir: data[2] & 0x0f,
		subpackets: [],
	};
	let pos = 3;

	if (rec.tankStatus === 0x0f) {
		// BoloViewer "attached log" pseudo-record: F0 then a Pascal-string name.
		try {
			const { str } = pascalString(data, pos + 1);
			rec.subpackets.push({ type: "attached_log", name: str });
		} catch (err) {
			rec.warning = String(err.message || err);
		}
		return rec;
	}

	if (rec.tankStatus & 0x08) {
		// 5-byte tank position: XX YY yx SS ZA
		if (pos + 5 > data.length) {
			rec.warning = "truncated tank position";
			return rec;
		}
		rec.subpackets.push({
			type: "tank_position",
			...squarePos(data[pos], data[pos + 1], data[pos + 2]),
			speed: data[pos + 3],
			motion: data[pos + 4] & 0x0f,
			inBoat: (rec.tankStatus & 0x01) !== 0,
			hidden: (rec.tankStatus & 0x02) !== 0,
			dying: (rec.tankStatus & 0x04) !== 0,
			direction: rec.tankDir,
		});
		pos += 5;
	}

	if (rec.status & 0x0e) {
		if (pos + 3 > data.length) {
			rec.warning = "truncated position extension";
			return rec;
		}
		// A 3-byte position extension: XX YY yx. Status 8 = LGM walking,
		// C = LGM walking with a pillbox, 4 = LGM dead, so this is the
		// parachute bringing the replacement man. (Empirically verified
		// against all 131k records of both sample logs: a 3-byte position
		// is present iff these bits are set — this resolves the b=5/9/D
		// cases the 2003 notes left open, which are just the 1000-tick bit
		// riding along with 4/8/C.) Status 2 is the never-shipped towed-base
		// feature; bolorama's wire parser (rewriteGameStateBlock) skips the
		// extension for senderFlags & 0xE0, i.e. including that bit, so we
		// consume it too — semantics unknown, never observed in real logs.
		const type = (rec.status & 0x08) ? "lgm_position"
			: (rec.status & 0x04) ? "parachute_position"
			: "towed_base_position";
		rec.subpackets.push({
			type,
			...squarePos(data[pos], data[pos + 1], data[pos + 2]),
			carryingPill: (rec.status & 0x0c) === 0x0c,
		});
		pos += 3;
	}

	if (rec.status & 0x01) {
		rec.subpackets.push({ type: "base_stock_tick" });
	}

	parseIdSubpackets(rec, data, pos);
	return rec;
}

function* records(buf, stats) {
	for (const raw of rawRecords(buf, stats)) {
		yield parseRecord(raw);
	}
}

function parseLog(buf) {
	const header = parseHeader(buf);
	const stats = {};
	const recs = [];
	for (const rec of records(buf, stats)) {
		recs.push(rec);
	}
	return { header, records: recs, truncatedBytes: stats.truncatedBytes || 0 };
}

const BoloLog = { TICKS_PER_SECOND, macRoman, parseHeader, rawRecords, parseRecord, records, parseLog };

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloLog;
} else {
	window.BoloLog = BoloLog;
}

})();
