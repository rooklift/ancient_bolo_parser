// The chat redactor must rewrite only the parsed message fields, and
// must write nothing until every log has been patched and checked. A
// map run whose bytes spell a chat message (FA, address, length, text)
// ahead of the real message in the same record must be left alone.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const BoloLog = require("../viewer/logparse.js");
const chat = require("../tools/redact-chat.cjs");
const { build_log, str, changed_bytes } = require("./synthetic-log.cjs");

let failures = 0;
function check(what, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`}`);
}

// Game info (F1 01 + 88 bytes) so build_template can read a game id.
const game_info = [0, 0x00, 0x70, 0xf1, 0x01, ...new Array(88).fill(0)];
// A map run spelling the message "hi" from address 0, then the real one.
const decoy = [0x08, 0xfa, 0x00, 0x00, ...str("hi"), 0x00];
const chatter = [1, 0x01, 0x70, 0xf3, 0x00, 0x00, ...decoy, 0xfa, 0x00, 0x00, ...str("hi")];
// A second message, from another player, on its own.
const second = [2, 0x02, 0x70, 0xfa, 0x01, 0x00, ...str("yo")];

const log = build_log([game_info, chatter, second]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redact-chat-"));
const in_file = path.join(dir, "game-A");
fs.writeFileSync(in_file, log);

const parsed = [...BoloLog.rawRecords(log)].map(raw => BoloLog.parseRecord(raw));
check("no record is malformed", parsed.map(r => r.warning || null), [null, null, null]);
check("the map run keeps the decoy bytes", parsed[1].subpackets[0].run, decoy);
check("message fields carry their offsets", parsed.flatMap(r => r.subpackets.filter(s => s.type === "message").map(s => s.at)), [3 + 3 + decoy.length + 3, 6]);

const found = chat.messages(in_file).out;
check("two messages, at the parsed fields", found.map(m => [m.player, m.text, m.text_at - 5 - 1]),
	[[1, "hi", parsed[1].offset + 3 + 3 + decoy.length + 3], [2, "yo", parsed[2].offset + 6]]);

const index = chat.build_template([in_file]);
check("the template lists both messages", index.entries.map(e => [e.player, e.chars]), [[1, 2], [2, 2]]);

const out_dir = path.join(dir, "out");
chat.apply(index, ["ok", [2, "go"]], out_dir);
const out = new Uint8Array(fs.readFileSync(path.join(out_dir, "game-A")));
const after = [...BoloLog.rawRecords(out)].map(raw => BoloLog.parseRecord(raw));
check("both messages replaced", after.flatMap(r => r.subpackets.filter(s => s.type === "message").map(s => s.text)), ["ok", "go"]);
check("the map run is untouched", after[1].subpackets[0].run, decoy);
// "yo" -> "go" keeps its second letter, so three text bytes differ.
check("only text bytes changed", changed_bytes(log, out), [found[0].text_at, found[0].text_at + 1, found[1].text_at]);

// A line of the wrong length is refused before anything is written.
const bad_dir = path.join(dir, "bad");
let refused = false;
try { chat.apply(index, ["okay", "go"], bad_dir); } catch (e) { refused = /characters/.test(e.message); }
check("a wrong-length line is refused", refused, true);
check("and nothing was written", fs.existsSync(bad_dir), false);

// An index that is not this log's: the patch fails its own read-back,
// and no file is written.
const wrong = JSON.parse(JSON.stringify(index));
wrong.entries[0].at[in_file] = found[1].text_at;   // both entries point at the second message
refused = false;
try { chat.apply(wrong, ["ok", "go"], bad_dir); } catch (e) { refused = /after patching/.test(e.message); }
check("a patch that fails read-back is refused", refused, true);
check("and nothing was written", fs.existsSync(bad_dir), false);

fs.rmSync(dir, { recursive: true });
if (failures) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all redact-chat checks passed");
