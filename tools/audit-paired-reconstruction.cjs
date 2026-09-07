#!/usr/bin/env node
/* Two reconstructions of one game, compared shell by shell.
 *
 * Ten games in fixtures/pairs were logged on two machines at once, and
 * the two logs of each carry the same ring records byte for byte
 * (tools/compare-recordings.cjs, [E:two-recorders]). The only thing
 * that differs is the timestamp: each machine stamps a record on its
 * own clock, as the packet arrives. So a pair is a controlled
 * experiment on viewer/motion.js: the same packets go in twice, under
 * two sets of stamps, and wherever the two builds tell a shell a
 * different story, the story was decided by the stamps rather than by
 * the packets. The stamps differ in three distinct ways, and every
 * disagreement is classed by which one it sat on:
 *
 *   -- JITTER. Within one sender's stream the two machines' stamps
 *      differ by a constant plus a tick or two of delivery jitter. The
 *      matcher reads time as a tolerance, never a truth
 *      (docs/INTERPOLATION.md, "Two clocks"), so a decision that flips
 *      here was balanced on the tolerance: a marginal scene.
 *   -- CROSS-SENDER. A sender's packet reaches whichever recorder comes
 *      first on its way round, so between the two logs the senders fall
 *      into two groups a whole ring cycle apart. A shell's chain lives
 *      in the shooter's stream but its fate can be a terminal in some
 *      other sender's record (the victim's tank_hit, a pill's damage),
 *      and that interval shifts by up to a cycle depending on which
 *      machine logged. Every log in the corpus carries this, with no
 *      way to know which arc a sender was on, so a decision that
 *      depends on it is a property of the matcher, not of the pair.
 *   -- DELAY. A packet held up on its way round for longer than the
 *      matcher's tolerance but still within its window: the link is
 *      joinable on both sides, under timing that genuinely differs.
 *   -- STALL. Held up for longer than the window, so one side could
 *      not join across the gap at all. The reconstructions ought to
 *      diverge here; these are counted apart.
 *
 * The comparison aligns the two logs record by record (the compare
 * tool's alignment), takes every shell observation inside the shared
 * stretch and clear of its edges, and reads off what each build made
 * of it: its successor (the same shell in a later list, or a terminal),
 * whether it was given a birth, and which weapon it was attributed to.
 * A successor is named in the OTHER log's record numbering before the
 * two are compared, so "the same successor" means the same record and
 * the same list position, not the same time. Forward stories are then
 * binned: agree (both none, or both the same), one side abstaining
 * (a story on one side, nothing on the other), or a conflict (two
 * different stories). Agreement proves nothing -- both builds read
 * near-identical input -- but a conflict or an abstention names a
 * scene where a few ticks of stamp changed the matcher's mind, which
 * is independent of every measure the matcher takes of itself,
 * including the roster vote. The roster elections themselves are
 * compared too: the vote is meant to be keyed by snapshot rather than
 * time, so its verdicts should not move between the two logs at all.
 *
 * The cause is read from the stamps of the link itself (the two logs'
 * durations from the observation to each target). A decision the flow
 * solver or the stitcher took over a wider component can turn on stamps
 * elsewhere in it, so a "jitter" scene whose own stamps differ by
 * nothing was decided by a neighbour's; it is still a marginal scene.
 * Over the committed pairs no terminal ever sits in another sender's
 * record -- the shooter's machine reports its own shells' impacts -- so
 * the cross-sender bin stays empty; it is kept because nothing in the
 * format rules it out.
 *
 * Usage:
 *   node tools/audit-paired-reconstruction.cjs <logA> <logB> [--verbose]
 *   node tools/audit-paired-reconstruction.cjs [--pairs <dir>] [--verbose]
 *
 * The second form runs every <id>-A / <id>-B pair in the directory
 * (default fixtures/pairs) and totals the results. Every disagreement
 * is listed up to a cap per pair; --verbose lists them all, plus the
 * weapon-attribution conflicts and the roster elections that differ.
 *
 * --gaps asks whether a delayed link can be seen from one log alone.
 * Ring records arrive in bursts, one per cycle, so the widest gap
 * between consecutive records of ANY sender inside a link's span is
 * normally about one ring cycle. For every link it takes the log whose
 * stamped duration is the longer (the late log), measures that widest
 * gap there and in the other log, in ring cycles, and tabulates them
 * by bin, with which side of a disagreement abstained and what each
 * side of a delayed conflict chose.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BoloLog = require(path.join(ROOT, "viewer", "logparse.js"));
const BoloGame = require(path.join(ROOT, "viewer", "game.js"));
const BoloMotion = require(path.join(ROOT, "viewer", "motion.js"));
const { split_boot, compare, load_log } = require("./compare-recordings.cjs");
const { replay_label } = require("./corpus.cjs");

/* An observation this close (in ticks) to either end of the shared
 * stretch is left out: a chain reaching past the end of one log has a
 * different story there for reasons that have nothing to do with the
 * stamps. Twice the widest gap the matcher joins across. */
const EDGE_MARGIN = 2 * BoloMotion.MAX_SHELL_INTERPOLATION_TICKS;
/* How far the two logs' stamped durations of one link may differ and
 * still count as jitter: the matcher's own tolerance, two shell updates
 * of two ticks (viewer/motion.js, TICKS_PER_SHELL_UPDATE). Beyond that
 * and up to the interpolation window the link was delivered late at
 * one machine (DELAY); beyond the window one side could not link at
 * all (STALL). */
const JITTER_TICKS = 4;
const WINDOW_TICKS = BoloMotion.MAX_SHELL_INTERPOLATION_TICKS;
const SCENES_SHOWN = 20;
const CAUSES = ["jitter", "cross-sender", "delay", "stall"];
const CLASSES = ["agree_none", "agree_assigned", "abstain_a", "abstain_b", "conflict"];

/* ---------- reading one build ---------- */

function build_game(recs) {
	BoloMotion.set_roster_vote_recording(true);
	try {
		return BoloGame.build(recs);
	} finally {
		BoloMotion.set_roster_vote_recording(false);
	}
}

/* Every snapshot by the record it came from, and every shell and
 * terminal by where it sits, so a successor reference can be named by
 * record and list position. */
function index_snapshots(game) {
	let by_record = new Map(), where = new Map(), terminal_at = new Map();
	for (let snapshots of game.shell_positions) {
		for (let snapshot of snapshots) {
			by_record.set(snapshot.record_index, snapshot);
			snapshot.shells.forEach((shell, position) => where.set(shell, { snapshot, position }));
			snapshot.terminals.forEach((terminal, position) => terminal_at.set(terminal, { snapshot, position }));
		}
	}
	return { by_record, where, terminal_at };
}

/* What one build made of one shell observation, going forward. */
function outcome(shell, index) {
	if (shell.next_terminal) {
		let terminal = shell.next_terminal;
		let at = index.terminal_at.get(terminal);
		return { kind: "terminal", record: terminal.record.index, position: at ? at.position : -1,
			event: terminal.event_type || "?" };
	}
	if (shell.next_shell) {
		let at = index.where.get(shell.next_shell);
		if (at) return { kind: "snapshot", record: at.snapshot.record_index, position: at.position };
	}
	if (shell.next_time !== undefined) return { kind: "forward", time: shell.next_time };
	return { kind: "none" };
}

/* The outcome named in the other log's record numbering: null when the
 * target record has no counterpart there. */
function signature(o, map) {
	if (o.kind === "none" || o.kind === "forward") return o.kind;
	let record = map ? map[o.record] : o.record;
	if (record < 0) return null;
	return `${o.kind}:${record}:${o.position}:${o.event || ""}`;
}

function source_signature(shell) {
	if (shell.starts_at_tank) return "tank";
	if (shell.pillbox_source_x !== undefined) return `pill ${shell.pillbox_source_x}:${shell.pillbox_source_y}`;
	return "-";
}

/* An election by what it elected: the verdict and, when it passed, the
 * advance it settled on (the confident table's or the full table's,
 * whichever the verdict names). The mechanism it passed by is shown
 * beside a differing scene but does not make one. */
function elected(vote) {
	if (vote.verdict !== "passed") return vote.verdict;
	let advance = vote.by && vote.by.startsWith("full") ? vote.full_advance : vote.advance;
	return `${vote.verdict} ${advance}`;
}

/* ---------- classification ---------- */

/* Bin two forward signatures, each already in one numbering. */
function classify_outcomes(sig_a, sig_b) {
	if (sig_a === null || sig_b === null) return "unalignable";
	if (sig_a === "forward" || sig_b === "forward") return "unreferenced";
	if (sig_a === "none" && sig_b === "none") return "agree_none";
	if (sig_a === "none") return "abstain_a";
	if (sig_b === "none") return "abstain_b";
	return sig_a === sig_b ? "agree_assigned" : "conflict";
}

/* One of the same/one-side/conflict bins for an attribute with a "-"
 * meaning unassigned. */
function classify_attribute(a, b) {
	if (a === "-" && b === "-") return "none";
	if (a === "-") return "b_only";
	if (b === "-") return "a_only";
	return a === b ? "agree" : "conflict";
}

/* ---------- the audit ---------- */

function zero(keys) {
	return Object.fromEntries(keys.map(key => [key, 0]));
}

function new_counts() {
	let by_cause = {};
	for (let cause of CAUSES) by_cause[cause] = zero(CLASSES);
	return {
		pairs: 0,
		snapshots: 0, snapshots_unaligned: 0, snapshots_at_edge: 0, snapshots_missing: 0,
		observations: 0,
		forward: zero([...CLASSES, "unalignable", "unreferenced"]),
		by_cause,
		birth: zero(["none", "agree", "a_only", "b_only"]),
		source: zero(["none", "agree", "a_only", "b_only", "conflict"]),
		votes: zero(["compared", "agree", "differ", "one_side"]),
	};
}

function add_counts(total, part) {
	for (let key of Object.keys(part)) {
		if (typeof part[key] === "number") total[key] += part[key];
		else add_counts(total[key], part[key]);
	}
}

/* options.links: also return every classified observation as a link
 * record (out.links), for a measurement over the agreed ones too. */
function audit(a_recs, b_recs, options = {}) {
	let cmp = compare(a_recs, b_recs, { quiet: true });
	let out = { game_id: cmp.game_id, same_game: cmp.same_game, same_stretch: !!cmp.same_stretch, counts: null,
		scenes: [], source_scenes: [], vote_scenes: [], clock: cmp.clock || null, recorder: cmp.recorder,
		links: options.links ? [] : null, a_to_b: null, b_to_a: null };
	if (!cmp.same_game || !cmp.same_stretch) return out;

	let a = split_boot(a_recs), b = split_boot(b_recs);
	let a_to_b = new Int32Array(a_recs.length).fill(-1);
	let b_to_a = new Int32Array(b_recs.length).fill(-1);
	for (let [i, j] of cmp.pairs) {
		a_to_b[a.ring[i].index] = b.ring[j].index;
		b_to_a[b.ring[j].index] = a.ring[i].index;
	}
	out.a_to_b = a_to_b;
	out.b_to_a = b_to_a;
	let first = cmp.pairs[0], last = cmp.pairs[cmp.pairs.length - 1];
	let lo_a = a.ring[first[0]].time + EDGE_MARGIN, hi_a = a.ring[last[0]].time - EDGE_MARGIN;
	let lo_b = b.ring[first[1]].time + EDGE_MARGIN, hi_b = b.ring[last[1]].time - EDGE_MARGIN;

	let game_a = build_game(a_recs), game_b = build_game(b_recs);
	let ia = index_snapshots(game_a), ib = index_snapshots(game_b);
	let counts = new_counts();
	counts.pairs = 1;
	out.counts = counts;

	/* How a forward story's timing differs between the logs: the widest
	 * change in stamped duration over the targets involved, and whether
	 * any target sits in another sender's record. */
	function cause_of(ra, rb, outcomes) {
		let delta = 0, cross = false;
		for (let [o, own, other, map] of outcomes) {
			if (o.kind !== "snapshot" && o.kind !== "terminal") continue;
			let mapped = map[o.record];
			if (mapped < 0) continue;
			let own_obs = own === a_recs ? ra : rb, other_obs = own === a_recs ? rb : ra;
			let d_own = own[o.record].time - own[own_obs].time;
			let d_other = other[mapped].time - other[other_obs].time;
			delta = Math.max(delta, Math.abs(d_own - d_other));
			if (own[o.record].player !== own[own_obs].player) cross = true;
		}
		let cause = delta > WINDOW_TICKS ? "stall" : cross ? "cross-sender" : delta > JITTER_TICKS ? "delay" : "jitter";
		return { cause, delta };
	}

	/* The late log of a link (the longer stamped duration, over the
	 * target with the widest difference) and the widest whole-stream
	 * gap inside the link's span on each side. */
	function link_timing(ra, rb, oa, ob, cls, cause, delta) {
		let best = null;
		for (let [o, own, other, map, own_obs, other_obs] of [[oa, a_recs, b_recs, a_to_b, ra, rb], [ob, b_recs, a_recs, b_to_a, rb, ra]]) {
			if (o.kind !== "snapshot" && o.kind !== "terminal") continue;
			let mapped = map[o.record];
			if (mapped < 0) continue;
			let d_own = own[o.record].time - own[own_obs].time;
			let d_other = other[mapped].time - other[other_obs].time;
			let d = Math.abs(d_own - d_other);
			if (best && d <= best.delta) continue;
			let own_late = d_own >= d_other;
			best = { delta: d,
				late: own_late ? [own, own_obs, o.record] : [other, other_obs, mapped],
				early: own_late ? [other, other_obs, mapped] : [own, own_obs, o.record],
				late_side: own_late === (own === a_recs) ? "A" : "B" };
		}
		let widest = ([recs, lo, hi]) => {
			let w = 0;
			for (let i = lo + 1; i <= hi; i++) w = Math.max(w, recs[i].time - recs[i - 1].time);
			return w;
		};
		return { ra, rb, sender: a_recs[ra].player, cls, cause, delta, a: oa, b: ob,
			late_side: best ? best.late_side : null,
			gap_late: best ? widest(best.late) : null, gap_early: best ? widest(best.early) : null };
	}
	let records_a = [...ia.by_record.keys()].sort((p, q) => p - q);
	for (let ra of records_a) {
		let sa = ia.by_record.get(ra);
		let rb = a_to_b[ra];
		if (rb < 0) { counts.snapshots_unaligned++; continue; }
		if (a_recs[ra].time < lo_a || a_recs[ra].time > hi_a || b_recs[rb].time < lo_b || b_recs[rb].time > hi_b) {
			counts.snapshots_at_edge++;
			continue;
		}
		let sb = ib.by_record.get(rb);
		if (!sb) { counts.snapshots_missing++; continue; }
		if (sa.shells.length !== sb.shells.length) {
			throw new Error(`record ${ra}/${rb}: ${sa.shells.length} shells in A, ${sb.shells.length} in B, from identical bytes`);
		}
		counts.snapshots++;
		for (let n = 0; n < sa.shells.length; n++) {
			let shell_a = sa.shells[n], shell_b = sb.shells[n];
			counts.observations++;
			let oa = outcome(shell_a, ia), ob = outcome(shell_b, ib);
			let cls = classify_outcomes(signature(oa, a_to_b), signature(ob, null));
			counts.forward[cls]++;
			if (CLASSES.includes(cls)) {
				let { cause, delta } = cause_of(ra, rb, [[oa, a_recs, b_recs, a_to_b], [ob, b_recs, a_recs, b_to_a]]);
				counts.by_cause[cause][cls]++;
				if (out.links) out.links.push({ ...link_timing(ra, rb, oa, ob, cls, cause, delta), position: n });
				if (cls !== "agree_none" && cls !== "agree_assigned") {
					out.scenes.push({ ra, rb, sender: a_recs[ra].player, position: n, cls, cause, delta,
						shell: shell_a, a: oa, b: ob, stitched_a: !!shell_a.stitched, stitched_b: !!shell_b.stitched });
				}
			}
			let birth_a = shell_a.birth_time !== undefined ? "born" : "-";
			let birth_b = shell_b.birth_time !== undefined ? "born" : "-";
			counts.birth[classify_attribute(birth_a, birth_b)]++;
			let src_a = source_signature(shell_a), src_b = source_signature(shell_b);
			let src_cls = classify_attribute(src_a, src_b);
			counts.source[src_cls]++;
			if (src_cls === "conflict") {
				out.source_scenes.push({ ra, rb, sender: a_recs[ra].player, position: n, shell: shell_a, src_a, src_b });
			}
		}
		/* the roster elections over the pair ending at this snapshot */
		let keys = new Set([...(sa.roster_votes?.keys() ?? []), ...(sb.roster_votes?.keys() ?? [])]);
		for (let key of keys) {
			let va = sa.roster_votes?.get(key), vb = sb.roster_votes?.get(key);
			if (!va || !vb) { counts.votes.one_side++; continue; }
			counts.votes.compared++;
			let siga = elected(va), sigb = elected(vb);
			if (siga === sigb) counts.votes.agree++;
			else {
				counts.votes.differ++;
				out.vote_scenes.push({ ra, rb, sender: a_recs[ra].player, pill: key,
					a: `${siga}${va.by ? " by " + va.by : ""}`, b: `${sigb}${vb.by ? " by " + vb.by : ""}`,
					sources_a: va.sources, sources_b: vb.sources });
			}
		}
	}
	return out;
}

/* ---------- the report ---------- */

function describe_outcome(o, recs, obs, stitched) {
	if (o.kind === "none") return "none";
	if (o.kind === "forward") return `forward to t=${o.time} (no reference)`;
	let tail = stitched ? ", stitched" : "";
	let dur = recs[o.record].time - recs[obs].time;
	if (o.kind === "terminal") return `${o.event} #${o.record} +${dur}${tail}`;
	return `shell #${o.record}/${o.position} +${dur}${tail}`;
}

function print_pair(out, a_recs, b_recs, labels, options) {
	console.log(`=== game ${out.game_id || "?"}: A = ${labels[0]}, B = ${labels[1]}`);
	if (!out.same_game) { console.log("  not the same game -- nothing to compare"); return; }
	if (!out.same_stretch) { console.log("  the two logs cover different stretches -- nothing to compare"); return; }
	let c = out.counts;
	let r = out.recorder;
	console.log(`  recorders: A slot ${r.a_by_offset ?? "?"}, B slot ${r.b_by_offset ?? "?"}; ring cycle ${out.clock.cycle_a} ticks`);
	console.log(`  snapshots compared ${c.snapshots} (${c.snapshots_unaligned} unaligned, ${c.snapshots_at_edge} within ${EDGE_MARGIN} ticks of the shared stretch's ends` +
		(c.snapshots_missing ? `, ${c.snapshots_missing} with no counterpart` : "") + `); shell observations ${c.observations}`);
	print_counts(c, "  ");
	let scenes = out.scenes;
	if (scenes.length) {
		console.log(`  forward disagreements${options.verbose || scenes.length <= SCENES_SHOWN ? "" : ` (first ${SCENES_SHOWN} of ${scenes.length})`}:`);
		for (let s of (options.verbose ? scenes : scenes.slice(0, SCENES_SHOWN))) {
			console.log(`    ${s.cls} [${s.cause}, stamps differ by ${s.delta}] sender ${s.sender} shell ${s.position} at (${s.shell.pixel_x},${s.shell.pixel_y}) dir ${s.shell.direction}: ` +
				`A #${s.ra} t=${a_recs[s.ra].time} -> ${describe_outcome(s.a, a_recs, s.ra, s.stitched_a)} | ` +
				`B #${s.rb} t=${b_recs[s.rb].time} -> ${describe_outcome(s.b, b_recs, s.rb, s.stitched_b)}`);
		}
	}
	if (options.verbose) {
		for (let s of out.source_scenes) {
			console.log(`    source conflict: sender ${s.sender} shell ${s.position} at (${s.shell.pixel_x},${s.shell.pixel_y}) A #${s.ra}: ${s.src_a} | B #${s.rb}: ${s.src_b}`);
		}
		for (let s of out.vote_scenes) {
			console.log(`    election differs: sender ${s.sender} pill ${s.pill} A #${s.ra}: ${s.a} (sources ${s.sources_a}) | B #${s.rb}: ${s.b} (sources ${s.sources_b})`);
		}
	}
}

function print_counts(c, indent) {
	let f = c.forward;
	console.log(`${indent}forward: agree ${f.agree_none + f.agree_assigned} (none ${f.agree_none}, assigned ${f.agree_assigned}); ` +
		`A abstains ${f.abstain_a}; B abstains ${f.abstain_b}; conflict ${f.conflict}` +
		(f.unalignable ? `; ${f.unalignable} with a target outside the shared stretch` : "") +
		(f.unreferenced ? `; ${f.unreferenced} forward with no reference` : ""));
	for (let cause of CAUSES) {
		let b = c.by_cause[cause];
		let total = CLASSES.reduce((s, k) => s + b[k], 0);
		if (!total) continue;
		console.log(`${indent}  ${cause}: ${total} (assigned and agreed ${b.agree_assigned}, A abstains ${b.abstain_a}, B abstains ${b.abstain_b}, conflict ${b.conflict})`);
	}
	console.log(`${indent}birth: agree ${c.birth.agree}, A only ${c.birth.a_only}, B only ${c.birth.b_only}, neither ${c.birth.none}`);
	console.log(`${indent}weapon: agree ${c.source.agree}, A only ${c.source.a_only}, B only ${c.source.b_only}, conflict ${c.source.conflict}, neither ${c.source.none}`);
	console.log(`${indent}roster elections: ${c.votes.compared} compared, ${c.votes.differ} differ (${c.votes.one_side} taken on one side only)`);
}

/* ---------- the gap table (--gaps) ---------- */

function print_gaps(links, cycles) {
	let dis = r => r.cls !== "agree_none" && r.cls !== "agree_assigned";
	let half = (ticks, cycle) => Math.round(2 * ticks / cycle) / 2;
	let hist = values => {
		let h = new Map();
		for (let v of values) h.set(v, (h.get(v) || 0) + 1);
		return [...h].sort((p, q) => p[0] - q[0]).map(([k, v]) => `${k}:${v}`).join(" ") || "-";
	};
	let timed = links.filter(r => r.late_side !== null);
	console.log("whole-stream gaps, in ring cycles (histogram over links, cycles:links):");
	for (let cause of CAUSES) {
		for (let [label, pick] of [["agreed", r => !dis(r)], ["disagreed", dis]]) {
			let sel = timed.filter(r => r.cause === cause && pick(r));
			if (!sel.length) continue;
			console.log(`  ${cause} ${label} (${sel.length} links)`);
			console.log(`    stamp difference ${hist(sel.map(r => half(r.delta, cycles.get(r.game))))}`);
			console.log(`    widest gap, late log ${hist(sel.map(r => half(r.gap_late, cycles.get(r.game))))}`);
			console.log(`    widest gap, early log ${hist(sel.map(r => half(r.gap_early, cycles.get(r.game))))}`);
		}
	}
	console.log("a stall detector from one log (widest gap in the late log at least this many cycles), links it fires on:");
	for (let threshold of [1.5, 2, 2.5, 3]) {
		let parts = [];
		for (let cause of ["jitter", "delay"]) for (let [label, pick] of [["agreed", r => !dis(r)], ["disagreed", dis]]) {
			let sel = timed.filter(r => r.cause === cause && pick(r));
			if (!sel.length) continue;
			let fired = sel.filter(r => r.gap_late >= threshold * cycles.get(r.game)).length;
			parts.push(`${cause}/${label} ${fired}/${sel.length}`);
		}
		console.log(`  ${threshold} cycles: ${parts.join("; ")}`);
	}
	console.log("which side of a disagreement abstained:");
	for (let cause of CAUSES) {
		let ab = timed.filter(r => r.cause === cause && (r.cls === "abstain_a" || r.cls === "abstain_b"));
		if (!ab.length) continue;
		let late = ab.filter(r => (r.cls === "abstain_a") === (r.late_side === "A")).length;
		console.log(`  ${cause}: ${ab.length} abstentions, ${late} by the late side, ${ab.length - late} by the early side`);
	}
	let conflicts = timed.filter(r => r.cause === "delay" && r.cls === "conflict");
	console.log(`delayed conflicts, what the late side chose | what the early side chose: ` +
		hist(conflicts.map(r => r.late_side === "A" ? `${r.a.kind}|${r.b.kind}` : `${r.b.kind}|${r.a.kind}`)));
}

/* ---------- driving ---------- */

function find_pairs(dir) {
	let files = fs.readdirSync(dir).filter(name => /-A$/.test(name)).sort();
	return files.map(name => [path.join(dir, name), path.join(dir, name.replace(/-A$/, "-B"))])
		.filter(([, b]) => fs.existsSync(b));
}

function run_pair(file_a, file_b, options, total, gaps) {
	let a_recs = load_log(BoloLog, file_a), b_recs = load_log(BoloLog, file_b);
	let out = audit(a_recs, b_recs, { links: !!gaps });
	print_pair(out, a_recs, b_recs, [replay_label(file_a), replay_label(file_b)], options);
	if (out.counts && total) add_counts(total, out.counts);
	if (gaps && out.links) {
		let game = replay_label(file_a);
		gaps.cycles.set(game, out.clock.cycle_a);
		for (let link of out.links) { link.game = game; gaps.links.push(link); }
	}
	return out;
}

function main() {
	let args = process.argv.slice(2);
	let options = { verbose: args.includes("--verbose") };
	let gaps = args.includes("--gaps") ? { links: [], cycles: new Map() } : null;
	let dir = null;
	let positional = [];
	for (let n = 0; n < args.length; n++) {
		if (args[n] === "--pairs") dir = args[++n];
		else if (!args[n].startsWith("--")) positional.push(args[n]);
	}
	if (positional.length === 2) {
		run_pair(positional[0], positional[1], options, null, gaps);
		if (gaps) print_gaps(gaps.links, gaps.cycles);
		return;
	}
	if (positional.length) {
		console.error("usage: node tools/audit-paired-reconstruction.cjs <logA> <logB> [--verbose] [--gaps]\n" +
			"       node tools/audit-paired-reconstruction.cjs [--pairs <dir>] [--verbose] [--gaps]");
		process.exit(2);
	}
	let pairs = find_pairs(dir || path.join(ROOT, "fixtures", "pairs"));
	let total = new_counts();
	for (let [file_a, file_b] of pairs) {
		run_pair(file_a, file_b, options, total, gaps);
		console.log("");
	}
	console.log(`=== all ${total.pairs} pairs: ${total.snapshots} snapshots, ${total.observations} shell observations`);
	print_counts(total, "  ");
	if (gaps) print_gaps(gaps.links, gaps.cycles);
}

module.exports = { audit, classify_outcomes, classify_attribute, EDGE_MARGIN, JITTER_TICKS };

if (require.main === module) main();
