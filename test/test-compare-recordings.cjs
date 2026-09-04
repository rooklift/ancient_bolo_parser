// The two-recording aligner must match records as a longest common
// subsequence and place the unmatched ones; the hole reader must hand
// every missing slot to the right player and class him correctly.

const path = require("node:path");
const compare_tool = require("../tools/compare-recordings.cjs");
const holes_tool = require("../tools/measure-seq-holes.cjs");

let failures = 0;
function check(what, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`}`);
}

// ---- alignment

check("identical streams match throughout", compare_tool.align(["a", "b", "c"], ["a", "b", "c"]), [[0, 0], [1, 1], [2, 2]]);
check("an insertion in B is skipped", compare_tool.align(["a", "b", "c"], ["a", "x", "b", "c"]), [[0, 0], [1, 2], [2, 3]]);
check("a deletion from A is skipped", compare_tool.align(["a", "x", "b", "c"], ["a", "b", "c"]), [[0, 0], [2, 1], [3, 2]]);
check("a leading run in B only", compare_tool.align(["b", "c"], ["p", "q", "b", "c"]), [[0, 2], [1, 3]]);
check("a trailing run in A only", compare_tool.align(["b", "c", "z"], ["b", "c"]), [[0, 0], [1, 1]]);
check("repeats align in order", compare_tool.align(["a", "a", "b", "a"], ["a", "b", "a", "a"]).length, 3);
check("nothing in common", compare_tool.align(["a", "b"], ["c", "d"]), []);
check("empty streams", compare_tool.align([], []), []);
{
	/* two long streams of one game covering different stretches: linear
	 * work, no heap blow-up, and the overlap still found */
	let a = [], b = [];
	for (let i = 0; i < 60000; i++) a.push("a" + i);
	for (let i = 50000; i < 110000; i++) b.push("a" + i);
	let pairs = compare_tool.align(a, b);
	check("a long offset overlap is found whole", [pairs.length, pairs[0], pairs[pairs.length - 1]], [10000, [50000, 0], [59999, 9999]]);
	let stats = { unaligned_a: 0, unaligned_b: 0 };
	let c = new Array(3000).fill("same"), d = new Array(3000).fill("same");
	check("an anchorless stretch too long to diff is left unmatched", [compare_tool.align(c, d, stats).length, stats], [0, { unaligned_a: 3000, unaligned_b: 3000 }]);
	check("a short anchorless stretch goes to Myers", compare_tool.align(["x", "x", "y"], ["x", "y", "y"]).length, 2);
}

// ---- boot burst and holes

const boot = (player, type) => ({ seq: 0, player, status: 0, tankStatus: 7, tankDir: 0, time: 1, subpackets: [{ type }], hex: `boot${type}${player}` });
{
	let recs = [boot(0, "node_id"), boot(1, "node_id"), boot(0, "game_info"), boot(0, "map_run"),
		{ seq: 5, player: 1, status: 0, tankStatus: 8, tankDir: 0, time: 9, subpackets: [], hex: "r1" },
		{ seq: 0, player: 2, status: 0, tankStatus: 7, tankDir: 0, time: 40, subpackets: [{ type: "node_id" }], hex: "join" },
		{ seq: 7, player: 1, status: 0, tankStatus: 0x0f, tankDir: 0, time: 41, subpackets: [{ type: "attached_log" }], hex: "insert" }];
	let split = compare_tool.split_boot(recs);
	check("boot burst is the leading seq-0 T=7 run", split.boot.length, 4);
	check("a later T=7 join stays ring traffic", split.ring.map(r => r.hex), ["r1", "join"]);
}
{
	const rec = (seq, time) => ({ seq, time });
	check("a step of 2 is one missing slot", compare_tool.seq_holes([rec(1, 0), rec(3, 5)]), [{ index: 1, missing: 1 }]);
	check("wrap-around counts", compare_tool.seq_holes([rec(126, 0), rec(1, 5)]), [{ index: 1, missing: 2 }]);
	check("a long gap is not trusted", compare_tool.seq_holes([rec(1, 0), rec(3, 300)]), []);
	check("a duplicate is not a hole", compare_tool.seq_holes([rec(1, 0), rec(1, 0), rec(2, 1)]), []);
}

// ---- a synthetic pair: a four-player ring, order 0 -> 2 -> 3 -> 1, recorded
// by slot 2 (log A) and slot 0 (log B), with a hop costing 2 ticks

const ORDER = [0, 2, 3, 1];
const HOP = 2;
function ring_stream(recorder, clock0, cycles, options = {}) {
	let names = { 0: "host@a", 1: "one@b", 2: "two@c", 3: "three@d" };
	let out = [0, 1, 2, 3].map(p => ({ ...boot(p, "node_id"), subpackets: [{ type: "node_id", name: names[p] }] }));
	out.push({ ...boot(0, "game_info"), subpackets: [{ type: "game_info", gameId: options.game || "g1" }], hex: `info${clock0}` });
	/* one global sequence of turns, the same for every recorder; each
	 * record is stamped when the packet reaches the recorder -- at once
	 * for its own turn, a hop per slot in between for the others */
	let hops_to = slot => (ORDER.indexOf(recorder) - ORDER.indexOf(slot) + ORDER.length) % ORDER.length;
	let turns = [];
	let seq = 1;
	for (let c = 0; c < cycles; c++) {
		for (let k = 0; k < ORDER.length; k++) {
			let slot = ORDER[k];
			let turn = c * ORDER.length + k;
			let quiet = options.quiet && options.quiet(slot, c);
			if (!quiet) {
				turns.push({ seq: seq & 0x7f, player: slot, status: 0, tankStatus: 8, tankDir: 0,
					time: clock0 + HOP * (turn + hops_to(slot)), turn, hex: `c${c}s${slot}`,
					subpackets: [{ type: "tank_position", x: c, y: slot, px: 0, py: 0, speed: 10 }] });
			}
			seq++;
		}
	}
	turns.sort((p, q) => p.time - q.time || p.turn - q.turn);
	for (let t of turns) delete t.turn;
	return out.concat(turns);
}
{
	let quiet = (slot, c) => slot === 3 && c % 3 === 1;   /* slot 3 sits out every third cycle */
	let a = ring_stream(2, 1000, 60, { quiet });
	let b = ring_stream(0, 5000, 60, { quiet });
	let out = compare_tool.compare(a, b, { quiet: true, network: { recorder: () => null } });
	check("same game", out.same_game, true);
	check("aligned", out.aligned, true);
	check("every ring record shared", [out.a_ring, out.b_ring, out.shared], [220, 220, 220]);
	check("no record in one log only", out.a_only.inside.length + out.b_only.inside.length, 0);
	check("holes seen alike", [out.a_holes.holes, out.b_holes.holes, out.a_holes.found_in_other], [20, 20, 0]);
	let by = Object.fromEntries(out.clock.by_sender.map(s => [s.player, s.median - out.clock.offset]));
	check("A's recorder stands a cycle apart from the rest", by, { 0: 0, 1: 0, 2: HOP * ORDER.length, 3: 0 });
	check("recorder of A read from the offsets", out.recorder.a_by_offset, 2);
	check("recorder of B read from the offsets and the ring order", out.recorder.b_by_offset, 0);
	check("ring order recovered", [...out.ring_order.entries()], [[0, 2], [2, 3], [3, 1], [1, 0]]);
	check("no run of records in one log only", [out.a_runs.length, out.b_runs.length], [0, 0]);
	check("no drift between steady clocks", Math.abs(out.clock.drift_ppm) < 1e-3, true);
}
{
	/* A's machine cut off from the ring for cycles 20-59: B keeps every
	 * record, A has none, and its clock shows the absence */
	let a = ring_stream(2, 1000, 100).filter(r => !/^c[2-5]\ds/.test(r.hex));
	let b = ring_stream(0, 5000, 100);
	let out = compare_tool.compare(a, b, { quiet: true, network: { recorder: () => null } });
	check("the absence is one run of B-only records", out.b_runs.length, 1);
	check("with every sender in it", out.b_runs[0].senders, [0, 1, 2, 3]);
	check("of the records A never got", out.b_runs[0].records.length, 160);
	check("across a gap in A longer than a hole", out.b_runs[0].other_gap > 250, true);
	check("a hole in A that is records in B", out.a_holes.found_in_other, 0);
	check("recorders still read", [out.recorder.a_by_offset, out.recorder.b_by_offset], [2, 0]);
}
{
	/* one packet that reached B and not A: a hole in A, a record in B */
	let a = ring_stream(2, 1000, 60).filter(r => r.hex !== "c30s1");
	let b = ring_stream(0, 5000, 60);
	let out = compare_tool.compare(a, b, { quiet: true, network: { recorder: () => null } });
	check("a single lost record is a hole in A filled by B", [out.a_holes.found_in_other, out.b_runs.length, out.b_runs[0].other_gap <= 250], [1, 1, true]);
}
{
	/* a packet held up for 400 ticks between B and A: A stamps it that
	 * much later than usual, at the end of a wait of the same length --
	 * a delayed delivery, matched, not a record in one log only */
	let a = ring_stream(2, 1000, 60), b = ring_stream(0, 5000, 60);
	/* the whole ring waits: B stamped the packet before the stall and
	 * everything after it 400 ticks later; A gets the packet itself late */
	let held_a = a.findIndex(r => r.hex === "c30s0"), held_b = b.findIndex(r => r.hex === "c30s0");
	for (let i = held_a; i < a.length; i++) a[i].time += 400;
	for (let i = held_b + 1; i < b.length; i++) b[i].time += 400;
	let out = compare_tool.compare(a, b, { quiet: true, network: { recorder: () => null } });
	check("a late delivery is still matched", [out.shared, out.a_only.inside.length, out.b_only.inside.length], [240, 0, 0]);
	check("and reported as delayed at A", [out.delayed.length, out.delayed[0].late_at, out.delayed[0].by], [1, "A", 400]);
	/* a stamp a cycle off, mid-traffic, is jitter */
	a = ring_stream(2, 1000, 60); b = ring_stream(0, 5000, 60);
	a.find(r => r.hex === "c30s0").time += HOP;
	out = compare_tool.compare(a, b, { quiet: true, network: { recorder: () => null } });
	check("a small deviation is jitter", [out.shared, out.delayed.length, out.rejected.length], [240, 0, 0]);
}
{
	/* the same recorder logging two different stretches */
	let a = ring_stream(0, 1000, 300).filter(r => r.tankStatus === 7 || r.hex < "c150s");
	let b = ring_stream(0, 1000, 300).filter(r => r.tankStatus === 7 || r.hex >= "c150s");
	let out = compare_tool.compare(a, b, { quiet: true, network: { recorder: () => null } });
	check("different stretches of one game are not one stretch", out.same_stretch, false);
}
{
	let a = ring_stream(2, 1000, 30);
	let b = ring_stream(0, 5000, 30, { game: "g2" });
	let out = compare_tool.compare(a, b, { quiet: true, network: { recorder: () => null } });
	check("different games are not aligned", [out.same_game, out.aligned], [false, false]);
}

// ---- hole reading

{
	const rec = (seq, player) => ({ seq, player, time: 0, tankStatus: 8, subpackets: [] });
	let order = holes_tool.ring_order([rec(1, 0), rec(2, 2), rec(3, 3), rec(4, 1), rec(5, 0), rec(6, 2), rec(8, 1)]);
	check("ring order from unit steps", [...order.entries()], [[0, 2], [2, 3], [3, 1], [1, 0]]);
}
{
	const at = (time, pos, tankStatus = 8) => ({ time, tankStatus, subpackets: pos ? [{ type: "tank_position", ...pos }] : [] });
	let here = { x: 5, y: 5, px: 3, py: 3, speed: 0 };
	let moving_a = { x: 5, y: 5, px: 3, py: 3, speed: 12 }, moving_b = { x: 5, y: 5, px: 9, py: 3, speed: 12 };
	check("parked tank", holes_tool.classify(at(0, here), at(30, here)), "still");
	check("no position either side", holes_tool.classify(at(0, null), at(30, null)), "still");
	check("moving tank", holes_tool.classify(at(0, moving_a), at(12, moving_b)), "moving");
	check("moving but neighbours too far apart", holes_tool.classify(at(0, moving_a), at(100, moving_b)), "changing");
	check("stopped on one side", holes_tool.classify(at(0, moving_a), at(12, { ...moving_b, speed: 0 })), "changing");
	check("position on one side only", holes_tool.classify(at(0, here), at(30, null)), "changing");
	check("dead tank", holes_tool.classify(at(0, null, 7), at(30, here)), "dead");
	check("dying bit", holes_tool.classify(at(0, here, 0x0c), at(30, here)), "dead");
	check("no record on one side", holes_tool.classify(null, at(30, here)), "edge");
}
{
	/* a settled span long enough to measure: slot 3 parks for three
	 * cycles in every ten, and slot 1 is dead for a stretch */
	let quiet = (slot, c) => (slot === 3 && c % 10 < 3) || (slot === 1 && c >= 200 && c < 220);
	let recs = ring_stream(0, 1000, 700, { quiet }).filter(r => r.tankStatus !== 7);
	/* the parked tank restates the same pixel, the dead one sends T=7 */
	for (let r of recs) {
		if (r.player === 3) r.subpackets[0] = { type: "tank_position", x: 1, y: 1, px: 0, py: 0, speed: 0 };
		if (r.player === 1 && r.hex >= "c195" && r.hex < "c225") { r.tankStatus = 7; r.subpackets = []; }
	}
	recs[0].subpackets.push({ type: "base_capture", base: 0 });
	let tally = holes_tool.empty_tally();
	let samples = [];
	let row = holes_tool.measure_file(recs, tally, samples, "synthetic");
	check("four players seen", row.players, 4);
	check("missing slots counted", tally.missing, 210 + 20);
	check("all of them attributed", [tally.attributed, tally.unattributed, tally.whole_cycle_slots, tally.beyond_cycle_slots], [230, 0, 0, 0]);
	check("every chain closes on the next sender", [tally.chain_ok, tally.chain_bad], [tally.holes, 0]);
	check("parked slots read as still", [tally.classes.still, tally.classes.edge], [207, 3]);
	check("dead slots read as dead", tally.classes.dead, 20);
	check("nothing read as moving", [tally.classes.moving, samples.length], [0, 0]);
	check("no whole-cycle hole", tally.whole_cycle, 0);
}
{
	/* slot 3 leaves the ring at cycle 400: three players from then on,
	 * and the holes after it must not be charged to the departed slot */
	let recs = ring_stream(0, 1000, 800).filter(r => r.tankStatus !== 7);
	let out = [], seq = 1;
	for (let r of recs) {
		let c = +r.hex.match(/^c(\d+)s/)[1];
		if (c >= 400 && r.player === 3) continue;
		r.seq = seq++ & 0x7f;
		out.push(r);
	}
	/* slot 1 parks for one cycle in ten throughout */
	recs = out.filter(r => !(r.player === 1 && +r.hex.match(/^c(\d+)s/)[1] % 10 === 5));
	recs.forEach(r => { if (r.player === 1 && r.subpackets[0]) r.subpackets[0] = { type: "tank_position", x: 1, y: 1, px: 0, py: 0, speed: 0 }; });
	recs[0].subpackets.push({ type: "base_capture", base: 0 });
	let tally = holes_tool.empty_tally();
	holes_tool.measure_file(recs, tally, [], "synthetic");
	/* a window straddling the departure has two players on one residue
	 * and is set aside; every other hole is the parked tank's */
	check("every hole either attributed or set aside", [tally.attributed + tally.unattributed, tally.classes.moving], [80, 0]);
	check("all attributed ones the parked tank", tally.classes.still, tally.attributed);
	check("only the windows across the departure unclassed", tally.unattributed <= 4, true);
	check("both ring sizes seen", Object.keys(tally.by_players).sort(), ["3", "4"]);
}
{
	/* a dead member who speaks once in minutes still owns his residue */
	let recs = ring_stream(0, 1000, 800).filter(r => r.tankStatus !== 7);
	recs = recs.filter(r => r.player !== 3 || +r.hex.match(/^c(\d+)s/)[1] % 300 === 0);
	for (let r of recs) if (r.player === 3) { r.tankStatus = 7; r.subpackets = []; }
	recs[0].subpackets.push({ type: "base_capture", base: 0 });
	let tally = holes_tool.empty_tally();
	holes_tool.measure_file(recs, tally, [], "synthetic");
	check("the silent member's turns are his", [tally.unattributed, tally.classes.moving], [0, 0]);
	check("read as silent far from his records, dead near them, edge after his last", tally.classes.silent + tally.classes.dead + tally.classes.edge, tally.attributed);
	check("mostly silent", tally.classes.silent > tally.classes.dead, true);
}

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
