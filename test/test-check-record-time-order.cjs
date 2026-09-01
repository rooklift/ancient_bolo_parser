// The corpus time-order checker must count steps the way the motion
// engine's snapshot filter sees them, and must catch a backwards stamp.

const path = require("node:path");
const checker = require("../tools/check-record-time-order.cjs");

let failures = 0;
function check(what, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`}`);
}

const rec = (player, time, subpackets = [{ type: "tank_position" }], tankStatus = 0) =>
	({ player, time, tankStatus, subpackets });
const shells = { type: "shells", direction: 0, shells: [{ x: 1, y: 1, pixel: 0 }] };

// two senders interleaved, all forward, one zero gap
{
	let tally = checker.empty_tally();
	let examples = [];
	checker.measure_file([
		rec(0, 100), rec(1, 100), rec(0, 110), rec(1, 110), rec(0, 110), rec(1, 125),
	], tally, examples, "synthetic");
	check("per-sender pairs", tally.per_sender_snapshots.pairs, 4);
	check("per-sender forward", tally.per_sender_snapshots.forward, 3);
	check("per-sender zero", tally.per_sender_snapshots.zero, 1);
	check("per-sender backward", tally.per_sender_snapshots.backward, 0);
	check("whole-file zero steps", tally.whole_file.zero, 3);
	check("no examples", examples, []);
}

// a backwards stamp is counted, bounded and reported
{
	let tally = checker.empty_tally();
	let examples = [];
	checker.measure_file([
		rec(3, 100), rec(3, 130), rec(3, 90), rec(3, 200),
	], tally, examples, "synthetic");
	check("backward counted", tally.per_sender_snapshots.backward, 1);
	check("backward size", tally.per_sender_snapshots.backward_max, 40);
	check("forward max", tally.per_sender_snapshots.forward_max, 110);
	check("file flagged", tally.files_with_snapshot_dips, 1);
	check("example line", examples,
		["dip_example\tsynthetic\tplayer=3\trecord=2\tfrom=130\tto=90"]);
}

// the snapshot filter: a dead slot's shell-less record and a map-only
// record make no snapshot, so a dip that only they see is in the
// all-records population, not the snapshot one
{
	check("live record makes a snapshot", checker.makes_snapshot(rec(0, 1)), true);
	check("dead slot with shells makes a snapshot",
		checker.makes_snapshot(rec(0, 1, [shells], 0x0f)), true);
	check("dead slot without shells makes none",
		checker.makes_snapshot(rec(0, 1, [], 0x0f)), false);
	check("map-only record makes none",
		checker.makes_snapshot(rec(0, 1, [{ type: "map_run" }])), false);
	let tally = checker.empty_tally();
	let examples = [];
	checker.measure_file([
		rec(0, 100), rec(0, 50, [], 0x0f), rec(0, 120),
	], tally, examples, "synthetic");
	check("all-records population sees the dip", tally.per_sender_all.backward, 1);
	check("snapshot population does not", tally.per_sender_snapshots.backward, 0);
	check("only the all-records file count is flagged",
		[tally.files_with_dips, tally.files_with_snapshot_dips], [1, 0]);
}

process.exitCode = failures ? 1 : 0;
