// The paired-reconstruction audit must bin two forward stories the way
// its report reads them, and must run whole over a committed pair.

const path = require("node:path");
const audit_tool = require("../tools/audit-paired-reconstruction.cjs");
const compare_tool = require("../tools/compare-recordings.cjs");
const BoloLog = require("../viewer/logparse.js");

let failures = 0;
function check(what, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${ok ? "" : `: ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`}`);
}

// ---- binning

const classify = audit_tool.classify_outcomes;
check("both silent agree", classify("none", "none"), "agree_none");
check("the same successor agrees", classify("snapshot:12:1:", "snapshot:12:1:"), "agree_assigned");
check("the same terminal agrees", classify("terminal:40:0:tank_hit", "terminal:40:0:tank_hit"), "agree_assigned");
check("a story on B only is A abstaining", classify("none", "snapshot:12:1:"), "abstain_a");
check("a story on A only is B abstaining", classify("terminal:40:0:tank_hit", "none"), "abstain_b");
check("different successors conflict", classify("snapshot:12:1:", "snapshot:12:2:"), "conflict");
check("a terminal against a successor conflicts", classify("terminal:40:0:explosion", "snapshot:40:0:"), "conflict");
check("a target outside the shared stretch is not compared", classify(null, "none"), "unalignable");
check("a forward story with no reference is not compared", classify("forward", "none"), "unreferenced");

const attribute = audit_tool.classify_attribute;
check("neither attributed", attribute("-", "-"), "none");
check("the same weapon agrees", attribute("pill 2048:2096", "pill 2048:2096"), "agree");
check("a weapon on A only", attribute("tank", "-"), "a_only");
check("a weapon on B only", attribute("-", "tank"), "b_only");
check("different weapons conflict", attribute("tank", "pill 2048:2096"), "conflict");

// ---- a committed pair, end to end

{
	const pair = path.join(__dirname, "..", "fixtures", "pairs", "c0a81701b7a359c9");
	let a = compare_tool.load_log(BoloLog, pair + "-A"), b = compare_tool.load_log(BoloLog, pair + "-B");
	let out = audit_tool.audit(a, b);
	let c = out.counts;
	check("the pair is one game over one stretch", [out.same_game, out.same_stretch], [true, true]);
	check("snapshots were compared", c.snapshots > 1000, true);
	check("every observation was binned once",
		c.observations, Object.values(c.forward).reduce((s, n) => s + n, 0));
	check("every compared observation has a cause",
		Object.values(c.by_cause).reduce((s, bin) => s + Object.values(bin).reduce((t, n) => t + n, 0), 0),
		c.observations - c.forward.unalignable - c.forward.unreferenced);
	check("every forward story carries a reference", c.forward.unreferenced, 0);
	check("links across a stall are binned as such",
		Object.values(c.by_cause.stall).reduce((s, n) => s + n, 0) > 0, true);
	check("the two builds mostly agree",
		(c.forward.agree_none + c.forward.agree_assigned) / c.observations > 0.95, true);
	check("a scene is listed for every disagreement",
		out.scenes.length, c.forward.abstain_a + c.forward.abstain_b + c.forward.conflict);
	check("the birth and weapon bins cover every observation",
		[Object.values(c.birth).reduce((s, n) => s + n, 0), Object.values(c.source).reduce((s, n) => s + n, 0)],
		[c.observations, c.observations]);
	check("roster elections were compared", c.votes.compared > 100, true);
	check("a scene is listed for every election that differs", out.vote_scenes.length, c.votes.differ);
}

if (failures) {
	console.log(`${failures} failure${failures === 1 ? "" : "s"}`);
	process.exit(1);
}
console.log("all ok");
