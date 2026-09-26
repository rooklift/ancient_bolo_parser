// The address redactor must rewrite only the parsed game-info, quit and
// join fields. A map run whose bytes spell a quit record (FF F0, field
// length, the three fields) ahead of the real quit in the same record
// must be left alone.

const BoloLog = require("../viewer/logparse.js");
const tool = require("../tools/redact-addresses.cjs");
const { build_log, str, changed_bytes } = require("./synthetic-log.cjs");

let failures = 0;
function check(what, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`}`);
}

// Game info: F1 01, then 88 bytes with the host address at 36.
let info = new Array(88).fill(0);
info.splice(36, 4, 10, 0, 0, 1);
const game_info = [0, 0x00, 0x70, 0xf1, 0x01, ...info];
// Quit fields: three 6-byte IP:port pairs.
const fields = [10, 0, 0, 1, 0x1f, 0x90, 10, 0, 0, 2, 0x1f, 0x90, 10, 0, 0, 3, 0x1f, 0x90];
const decoy = [fields.length + 4, 0xff, 0xf0, 0x06, ...fields];
const quit = [1, 0x02, 0x70, 0xf3, 0x00, 0x00, ...decoy, 0xff, 0xf0, 0x06, ...fields];
// nuBolo's join: the joiner's F8 node id, then FF F7 in the quit's layout.
const join_fields = [10, 0, 0, 2, 0x1f, 0x90, 10, 0, 0, 4, 0xc3, 0x50, 10, 0, 0, 3, 0x1f, 0x90];
const join = [2, 0x03, 0x70, 0xf8, ...str("new@node"), 0xff, 0xf7, 0x06, ...join_fields];

const log = build_log([game_info, quit, join]);
const parsed = [...BoloLog.rawRecords(log)].map(raw => BoloLog.parseRecord(raw));
check("no record is malformed", parsed.map(r => r.warning || null), [null, null, null]);
check("the join parses", parsed[2].subpackets.map(sub => sub.type), ["node_id", "join"]);
check("the map run keeps the decoy bytes", parsed[1].subpackets[0].run, decoy);
check("the quit sits after the map run", parsed[1].subpackets[1].at, 3 + 3 + decoy.length);

const found = tool.addresses(log);
check("seven addresses, host then the quit's three and the join's", found.map(a => [a.kind, a.ip]),
	[["host", "10.0.0.1"], ["upstream", "10.0.0.1"], ["quitter", "10.0.0.2"], ["downstream", "10.0.0.3"],
		["upstream", "10.0.0.2"], ["joiner", "10.0.0.4"], ["downstream", "10.0.0.3"]]);
check("the quit addresses are in the quit, not the decoy", found.slice(1, 4).map(a => a.at - parsed[1].offset - 5), [0, 6, 12].map(k => 3 + 3 + decoy.length + 3 + k));
check("the join addresses are in the join", found.slice(4).map(a => a.at - parsed[2].offset - 5), [0, 6, 12].map(k => 3 + 1 + str("new@node").length + 3 + k));

const mapping = new Map([["10.0.0.1", "192.168.1.1"], ["10.0.0.2", "192.168.1.2"], ["10.0.0.3", "192.168.1.3"], ["10.0.0.4", "192.168.1.4"]]);
const { out } = tool.redact(log, mapping);
const after = [...BoloLog.rawRecords(out)].map(raw => BoloLog.parseRecord(raw));
check("the map run is untouched", after[1].subpackets[0].run, decoy);
check("the quit fields are replaced", after[1].subpackets[1].fields, ["c0a801011f90", "c0a801021f90", "c0a801031f90"]);
check("the join fields are replaced, ports kept", after[2].subpackets[1].fields, ["c0a801021f90", "c0a80104c350", "c0a801031f90"]);
check("the join's node id is untouched", after[2].subpackets[0].name, "new@node");
check("the host address is replaced", tool.addresses(out).map(a => a.ip),
	["192.168.1.1", "192.168.1.1", "192.168.1.2", "192.168.1.3", "192.168.1.2", "192.168.1.4", "192.168.1.3"]);
// Each replacement keeps its last octet, so three bytes of each differ.
check("only address bytes changed", changed_bytes(log, out), found.flatMap(a => [0, 1, 2].map(k => a.at + k)));

if (failures) {
	console.log(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all redact-addresses checks passed");
