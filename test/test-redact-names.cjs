// The name redactor must rewrite only the parsed name fields. A record
// whose gameplay bytes happen to spell a name (here a tank at square
// 0x41,0x40 with pixel byte 0x42 after a byte of 0x03, which reads as
// the Pascal string "A@B") must keep those bytes as recorded.

const BoloLog = require("../viewer/logparse.js");
const redactor = require("../tools/redact-names.cjs");

let failures = 0;
function check(what, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`}`);
}

const { build_log, str, changed_bytes } = require("./synthetic-log.cjs");

// Each payload is seq, status/player, tankStatus/dir, then subpackets.
// Player 0 joins as "A@B": F8 and the name.
const join = [0, 0x00, 0x70, 0xf8, ...str("A@B")];
// A map run: F3, mapKnown (2 bytes), then a run whose first byte is its
// own length. The run bytes 03 41 40 42 spell Pascal "A@B".
const run = [1, 0x00, 0x70, 0xf3, 0x00, 0x00, 0x08, 0x03, 0x41, 0x40, 0x42, 0x00, 0x00, 0x00];
// A shell list: nibble byte 0x00 = one shell in direction 0, then x, y,
// pixel. Put x=0x03 y=0x41 pixel=0x40 and let the next subpacket byte be
// 0x42 (hi 4 = missile, 4 bytes) so the pattern spans two subpackets.
const shells = [2, 0x00, 0x70, 0x00, 0x03, 0x41, 0x40, 0x42, 0x00, 0x00, 0x00];
// A history block naming the same player, and an attached-log record.
const history = [3, 0x00, 0x70, 0xf1, 0xc0, 0x01, 0x00, 0x00, 0x00, ...str("A@B"), ...new Array(32).fill(0)];
const attached = [4, 0x00, 0xf0, 0xf0, ...str("A@B")];

const log = build_log([join, run, shells, history, attached]);

// Sanity: the parser reads the planted records the way the test assumes.
const parsed = [...BoloLog.rawRecords(log)].map(raw => BoloLog.parseRecord(raw));
check("five records parse", parsed.length, 5);
check("no record is malformed", parsed.map(r => r.warning || null), [null, null, null, null, null]);
check("the map run keeps its bytes", parsed[1].subpackets[0].run, [0x08, 0x03, 0x41, 0x40, 0x42, 0x00, 0x00, 0x00]);
check("the shell sits at 0x03,0x41", [parsed[2].subpackets[0].shells[0].x, parsed[2].subpackets[0].shells[0].y], [0x03, 0x41]);
check("name fields carry their offsets", parsed.flatMap(r => r.subpackets.filter(s => s.name).map(s => [s.type, s.at])),
	[["node_id", 4], ["history", 9], ["attached_log", 4]]);

const mapping = new Map([["A", "C"], ["B", "D"]]);
const { out, table, fields, patched } = redactor.redact(log, mapping);
check("three name fields patched", patched, 3);
check("the table maps the node id", [...table], [["A@B", "C@D"]]);
check("verify accepts the log and counts the two coincidences", redactor.verify(out, table, fields), 2);

const after = [...BoloLog.rawRecords(out)].map(raw => BoloLog.parseRecord(raw));
check("every name field now reads C@D", after.flatMap(r => r.subpackets.filter(s => s.name).map(s => s.name)), ["C@D", "C@D", "C@D"]);
check("the map run is untouched", after[1].subpackets[0].run, [0x08, 0x03, 0x41, 0x40, 0x42, 0x00, 0x00, 0x00]);
check("the shell position is untouched", [after[2].subpackets[0].shells[0].x, after[2].subpackets[0].shells[0].y, after[2].subpackets[0].shells[0].pixel], [0x03, 0x41, 0x40]);
check("the history bitmasks are untouched", [after[3].subpackets[0].pillMask, after[3].subpackets[0].baseMask], [1, 0]);

// Byte for byte: only the name bytes may differ, and the "@" of each
// name is the same in both, so six bytes change.
let changed = changed_bytes(log, out);
check("exactly six bytes changed", changed.length, 6);
const field_bytes = fields.flatMap(f => [0, 2].map(i => f.offset + 5 + f.at + 1 + i));
check("the changed bytes are the name fields", changed, field_bytes);

// verify() must reject a log whose name fields moved or were missed.
let tampered = Uint8Array.from(out);
tampered[fields[0].offset + 5 + fields[0].at + 1] ^= 0x01;   // C -> B, an unmapped name
let rejected = false;
try { redactor.verify(tampered, table, fields); } catch (e) { rejected = true; }
check("verify rejects a name field left unmapped", rejected, true);

// A name inside bytes the parser could not read is a leak, not a
// coincidence: F1 with an unknown subtype leaves the rest unparsed.
const leaky = build_log([join, [5, 0x00, 0x70, 0xf1, 0x20, ...str("A@B")]]);
const leaked = redactor.redact(leaky, mapping);
check("the unread tail is not a name field", leaked.patched, 1);
rejected = false;
try { redactor.verify(leaked.out, leaked.table, leaked.fields); } catch (e) { rejected = /unparsed/.test(e.message); }
check("verify rejects an original name in unparsed bytes", rejected, true);

if (failures) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all redact-names checks passed");
