/* Network conditions: rates how a game's networking held up (good / fair /
 * bad / awful) from the record stream alone. No DOM use — also loadable in
 * node for tests. */
"use strict";
(function () {

const TICKS_PER_SECOND = 50;

/* One verdict on how the game's networking held up, for the header.
 *
 * Two readings of the record stream rate it, taken from what the log
 * cannot help recording -- when packets arrived -- and a third is
 * reported alongside them without a say in the verdict:
 *
 *   STALL. The share of elapsed time spent in gaps where nothing at all
 *   arrived for over half a second AND THE RING DID NOT TURN -- a freeze
 *   the viewer shows whatever the player count. The second half of that
 *   qualifier is not decoration; see THE SILENCE THAT IS NOT A FREEZE
 *   below.
 *
 *   CYCLE. How long the ring takes to go round: the 90th percentile of
 *   the gap between one record from a player and the next record from
 *   the same player. A token ring turns at the speed of its slowest
 *   link, so this is the log's latency reading -- and it is invisible
 *   to the other two. A laggy ring drops nothing (the sequence numbers
 *   march by 1) and need never freeze for the half second STALL wants;
 *   it just delivers everything slowly.
 *
 *   QUIET SLOTS, computed but neither rated nor shown. The payload's
 *   sequence number is a ring slot counter, stepped once by every node
 *   as the packet passes, so consecutive records normally step by 1. A
 *   step of n means n-1 nodes took their turn and logged nothing: a
 *   parked tank between restatements, a dead one, the recorder itself
 *   as readily as anyone.
 *   It is not a lost packet: over ten games logged on two machines at
 *   once, none of 38,318 missing slots was a record the other machine
 *   had; over a thousand logs, 16 of 1.6 million fall on a moving tank,
 *   all of them crawling (a tank under way restates every cycle, and
 *   none of the sixteen was fast); and the ring turns through a hole at
 *   full pace (tools/compare-recordings.cjs, tools/measure-seq-holes.cjs)
 *   [E:seq-loss]. A step of 0 is a duplicate. The figure was rated as
 *   packet loss until that was established; it measures how idle the
 *   game was, rising with player count because more players means more
 *   of them parked or dead at any moment, and its correlation with what
 *   the viewer can make of the stream is player count in disguise (see
 *   below). It is kept in the result for the measurement tools.
 *
 * THE SILENCE THAT IS NOT A FREEZE. A gap in the log means the logging
 * machine wrote nothing for a while, and that has two quite different
 * causes: the ring stopped, or the ring turned and nobody had anything to
 * say. The stall reading was built on the first and charged for both, and
 * the slot counter tells them apart outright. A stopped ring cannot step
 * the counter -- the game needs its packet back to go on, so a held-up
 * packet costs a wait and whatever repairs it leaves the counter unbroken
 * -- while a ring that turned through the silence steps it once per node
 * per lap. So a silence is a freeze only when the counter advanced by no
 * more than one ring's worth of slots: the ring did not get round even
 * once. Over the twenty-two committed fixtures the two populations do not
 * touch: of the 327 silences on their four-, five- and six-player rings 326
 * step the counter by 3 or less, and the five silences in all the fixtures
 * that step past 3 step 9 or higher. Twenty-one of the twenty-two keep
 * their stall figure to the hundredth of a point, so the gate takes nothing
 * away from a log that really did freeze [E:idle-stall].
 *
 * What it does take away is the parked game. A two-player log from April
 * 2001 on "chew toy 2000" (the holder's corpus, not the fixtures) rated
 * "awful" on a 44.8% stall while its ring turned at 6 ticks, the corpus
 * floor: both players parked their tanks 21 minutes in and came back 43
 * minutes later, and with only two nodes in the ring there was no third
 * voice to fill the silence. The counter ran on unbroken through all
 * 1,634 of that log's silences, stepping 6 to 59 where a freeze steps 1;
 * both machines' 1000-tick base timers fired 126 times in the 126,000
 * ticks of the long one, not a beat missed; and both tanks restate one
 * pixel apiece, 658 times each, byte for byte. Nothing was frozen and
 * nothing was paused -- Bolo has no pause -- the players simply went away.
 * Gated, that log reads 0.0% stall and rates "good" on its cycle.
 *
 * The gate can only ever clear a silence, never convict one. The counter
 * is 7 bits, so a silence longer than 128 slots can wrap and alias its
 * step down into the frozen range; that misreads an idle stretch as a
 * freeze, which is what the reading did for every silence before the gate,
 * and it cannot go the other way, since a stopped ring has no large step
 * to alias from.
 *
 * All three are read only over the stretch of SETTLED PLAY, and that
 * qualifier carries most of the accuracy here. While the game is still
 * gathering -- the map being handed to joiners, nodes arriving -- the ring
 * turns at full speed but the logging machine records only a fraction of
 * it, so the sequence number races ahead and every slot it skips reads as
 * quiet. The join ramp therefore reads as catastrophic without a single
 * packet having gone astray. It is short in absolute terms (a median 56 s
 * of a 22-minute log) but so extreme that averaging it in dominates
 * everything else: over the corpus, the share of a log spent gathering
 * predicts its untrimmed quiet figure at r = 0.83, and once that stretch is
 * excluded the relationship vanishes entirely (r = -0.03). The tail after
 * the first quit is cut for the same reason, though it matters far less.
 *
 * The first BASE CAPTURE marks the start. It is a fact about the game
 * rather than about the log -- somebody drove a man into a base and took
 * it, which cannot happen until the map is distributed and everyone is
 * playing -- and it beats inferring the moment from the record rate, which
 * was the first thing tried here. Rate inference misfires badly on a
 * minority of logs, declaring the plateau reached at the very first block
 * of a game that had not started; those logs kept their artefact and landed
 * among the worst in the corpus. Switching to the capture marker cuts the
 * worst quiet figure from 69.8% to 49.5% and the 99th percentile from 46.9%
 * to 28.5%, and it measures no less consistently for the change: half-to-
 * half disagreement falls (p90 of |A-B| from 3.13 to 2.76 points) even as
 * the raw split-half correlation falls with it, that correlation having
 * been inflated by the very spread the marker removes. Rate inference
 * survives only as the fallback for a game nobody ever captured a base in
 * -- there is no such log in the 445-log corpus, so the path is untravelled
 * in practice but cheap to keep.
 *
 * What survives the correction: the quiet share still rises with player
 * count (median 5.2% at two, 6.6% at four, 7.4% at six), which is what
 * settled its reading as idleness rather than loss; and stall and cycle
 * disagree often enough to be worth keeping both -- a game can be laggy
 * without ever freezing, or freeze on a ring that otherwise turns fast --
 * so the verdict is the worse of the two. What does NOT survive: the
 * apparent year-on-year improvement from 2001 to 2005 was almost entirely
 * faster map transfers shortening the gathering phase; in settled play
 * the median barely moves (6.6% to 5.7%) [E:seq-loss].
 *
 * The cycle reading earns its place by predicting what the viewer can
 * actually make of the stream. Over both collections (1,020 logs), the
 * share of tank track segments the motion code cannot bridge tracks
 * cycle p90 at rho = 0.91, and shells it fails to chain forward at 0.76;
 * with stall partialled out those hold at 0.89 and 0.70, while stall
 * with cycle held keeps only 0.32 and 0.36, and the quiet share never
 * rises above 0.25 -- its correlation is player count in disguise, and
 * held to four-player logs it collapses to 0.02. A slow ring
 * undersamples every shell in flight, and no amount of counting quiet
 * slots will see it; the poster child is a log with 2.7% quiet whose
 * ring turned every 0.3 s, giving the corpus's worst shell interpolation
 * on nearly its cleanest quiet figure. That is why the quiet share was
 * dropped from the verdict: at its old bands (6 / 11 / 22%) it moved
 * about half the corpus off "good" on a figure that says how many tanks
 * were parked. All of it reproduces with
 * tools/measure-network-agreement.cjs
 * (docs/corpus_runs/9596cdc-agreement.txt).
 *
 * WHERE THE BANDS ARE CUT, and on what basis. The two readings are cut
 * on different grounds, and neither is a natural break: the pipeline's
 * failure rates rise smoothly with the ring cycle, about half a point of
 * unbridged track segments per tick from 6 to 30, with no knee anywhere.
 *
 *   The CYCLE cuts are severity levels on that continuous reading,
 *   placed so the bands stage the outcomes and spread the corpus. The
 *   ring's floor is 6 ticks (a two-player game on a fast link); by 10
 *   ticks the unbridged share has risen by half, by 15 it has doubled,
 *   by 21 tripled. Rated on cycle alone the bands run 0.15 / 0.33 / 0.62
 *   / 2.15% of shells unchained and 3.5 / 4.9 / 7.0 / 10.9% of segments
 *   unbridged. The cuts were first set at 14 / 19 / 26, which put 70% of
 *   Nemokrad's logs in "good" -- a range from a LAN-speed ring to one
 *   turning twice as slowly, across which the failure rate doubles --
 *   and left the word saying little. Since there is no external standard
 *   for a good 2003 connection, the words can only rank games against
 *   each other, and the cuts should spread them.
 *
 *   The STALL cuts are felt-time levels, chosen by judgement: 2 / 4 / 8%
 *   is roughly one, two and five seconds frozen per minute, the freezes
 *   counted being silences of over half a second each. They cannot be
 *   anchored to the pipeline, which barely notices a stall once the
 *   cycle is held: among rings under 14 ticks the median shell-unchained
 *   rate is flat (0.19% to 0.43%) from no stall to over 25%. A frozen
 *   game is plain to a viewer whether or not the shells chain, which is
 *   the reading's justification. The upper two were first set at 7 and
 *   18, four and eleven seconds a minute, far out in a reading whose
 *   corpus quartiles are 0.1 / 0.7 / 2.9%: a game frozen a tenth of the
 *   time was not yet "awful". Lowering them moves 10% of the corpus's
 *   verdicts, 50 logs into "bad" and 52 into "awful", and the share of
 *   verdicts the stall reading sets over the cycle's rises from 12.5%
 *   to 16.2%. The logs moved read, by the pipeline, like the band they
 *   leave (median 4.7% of segments unbridged among those moved into
 *   "bad" against 4.9% for those staying "fair"; 5.6% among those
 *   moved into "awful" against 7.3% for those staying "bad"), which is
 *   the reading doing its job -- flagging a freeze the pipeline cannot
 *   see -- at a price on the other two measures: the band's rank
 *   correlation with segments unbridged falls from 0.82 to 0.78, the
 *   per-band medians still staging in order down every column, and
 *   half-to-half agreement on the band gives up 1.6 points (94.1% to
 *   92.5%) to a cut nearer the reading's bulk.
 *
 * Both cuts are in ticks and percent, not corpus quantiles, so they stay
 * put as the corpus grows; Palp's logs shifted every percentile of
 * Nemokrad's when they were added.
 *
 * Scoring interleaved half-minute blocks as if they were separate games
 * gives r = 0.90 on the quiet share, 0.92 on stall and 0.99 on cycle
 * time, so this is a property of a session rather than of the moment
 * sampled, and fair to state once for a whole game. The bands place both
 * collections at 32% good, 34% fair, 20% bad, 13% awful (Nemokrad's alone
 * 46 / 31 / 16 / 7), the two halves of a log agreeing on the band 92.5%
 * of the time, and the band's rank correlation with segments unbridged
 * is 0.78 (0.82 at stall cuts of 2 / 7 / 18, 0.67 at cycle cuts of
 * 14 / 19 / 26). All of it reproduces with
 * tools/measure-network-conditions.cjs.
 *
 * EVERY CORPUS FIGURE QUOTED ABOVE FOR THE STALL READING -- its quartiles,
 * the band splits, the half-to-half agreement, the rank correlations, and
 * the counts of logs the lowered cuts moved -- was measured before the
 * ring-turned gate, when a parked game read as a frozen one. The gate
 * moves no fixture's rating and the worst-hit of them by 0.12 stall
 * points, so the corpus figures are unlikely to move far, but they are
 * unverified until the
 * corpus holder reruns them; tools/measure-ring-stalls.cjs reports what
 * the gate takes off each log, and the cuts should be reconsidered on the
 * rerun rather than assumed. The cycle reading is untouched. */

const STALL_GAP_TICKS = TICKS_PER_SECOND / 2;  /* silence long enough to be a freeze */
const SEQ_TRUST_TICKS = 250;    /* 5s: past this a step is a rejoin, not quiet */
const ABSENCE_TICKS = 1500;     /* 30s: nobody home, not a stalled network */
const SETTLE_BLOCK_TICKS = 500; /* 10s: the grain the join ramp is found on */
const SETTLE_SHARE = 0.7;       /* of a typical block, to count as up to speed */
const MIN_SETTLED_RECORDS = 500;
const STALL_BANDS = [2, 4, 8];          /* percent of elapsed time frozen */
const CYCLE_BANDS = [10, 15, 21];       /* ticks per ring cycle, at p90 */
const CYCLE_QUANTILE = 0.9;
const CONDITION_NAMES = ["good", "fair", "bad", "awful"];

function band_of(value, bands) {
	let band = 0;
	while (band < bands.length && value >= bands[band]) band++;
	return band;
}

function first_time_with(records, type, after) {
	for (const rec of records) {
		if (rec.time <= after) continue;
		if (rec.subpackets.some(s => s.type === type)) return rec.time;
	}
	return null;
}

/* Fallback start for a game in which no base was ever captured: the point
 * the log's own record rate reaches the plateau it holds thereafter. Reads
 * the log rather than the game, and misjudges a minority of them, so it is
 * only ever consulted when the capture marker is missing. */
function rate_plateau(records) {
	let t0 = records[0].time;
	let blocks = [];
	for (const rec of records) {
		let b = Math.floor((rec.time - t0) / SETTLE_BLOCK_TICKS);
		blocks[b] = (blocks[b] || 0) + 1;
	}
	let live = [];
	for (const count of blocks) if (count) live.push(count);
	if (live.length < 6) return t0;

	live.sort((a, b) => a - b);
	let typical = live[live.length >> 1];
	for (let b = 0; b < blocks.length; b++) {
		let here = blocks[b] || 0;
		let next = b + 1 < blocks.length ? (blocks[b + 1] || 0) : here;
		/* two blocks running, so one busy moment inside the ramp cannot
		 * be mistaken for the plateau */
		if (here >= typical * SETTLE_SHARE && next >= typical * SETTLE_SHARE) {
			return t0 + b * SETTLE_BLOCK_TICKS;
		}
	}
	return t0;
}

/* The stretch over which the ring was settled and playing: from the first
 * base capture to the first quit. Falls back to everything when the log is
 * too short or too odd to leave a usable span, which costs nothing -- an
 * untrimmable log is one with no gathering phase to trim. */
function settled_span(records) {
	let t0 = records[0].time;
	let start = first_time_with(records, "base_capture", t0 - 1);
	if (start === null) start = rate_plateau(records);
	let end = first_time_with(records, "quit", start);
	if (end === null) end = records[records.length - 1].time;

	let span = records.filter(rec => rec.time >= start && rec.time <= end);
	return span.length >= MIN_SETTLED_RECORDS ? span : records;
}

/* WHO RECORDED THE LOG. The recording machine never names itself, but it
 * identifies itself twice over in the shape of the stream:
 *
 *   BURST POSITION. Records land in same-tick bursts, one per ring cycle:
 *   a record can only be written when the circulating ring packet is at
 *   the logging machine, so a whole cycle's worth of foreign records
 *   arrives at once, the recorder's own record is written as it sends,
 *   and the file then goes quiet while the packet makes its way round.
 *   The recorder is therefore the player whose records immediately
 *   precede the inter-cycle gap -- 92-99% of them in the logs checked,
 *   against 0-9% for everyone else, and the verdict is stable in every
 *   five-minute block.
 *
 *   THE TERMINAL QUIT. Logging stops the moment the recording player
 *   leaves, so anyone else's quit is followed by more records while the
 *   recorder's own quit can be the last record of the file.
 *
 * Both signals were verified on a log whose recorder is independently
 * known (and was not in slot 0); each alone picks the right player, so a
 * disagreement means something is off and no verdict is returned. Two
 * plausible-looking signals do NOT work and are not consulted: the
 * log_bootinfo burst stamps sender 0 whoever is recording, and the
 * recorder's own slot has sequence holes like anyone's -- its own quiet
 * cycles, a parked or dead tank logging nothing, at the ring's highest
 * rate in one sample log and its lowest in the other [E:seq-loss].
 *
 * A pair of logs of one game written on two machines confirmed the burst
 * rule by an independent route: the recorder stamps its own record as it
 * sends and everyone else's as the packet arrives, so subtracting the two
 * logs' stamps sender by sender leaves one sender a whole ring cycle
 * apart from the rest, and it is the sender the burst rule names
 * (tools/compare-recordings.cjs) [E:two-recorders]. */

const BURST_GAP_TICKS = 6;      /* quiet after a record: the packet has left */
const BURST_MIN_VOTES = 20;     /* below this the log is too short to say */
const BURST_MARGIN = 3;         /* winner must lead the runner-up this much */

function burst_final_player(records) {
	/* Read over settled play, like the network readings and for the same
	 * reason: while the log is racing to catch up with the ring, burst
	 * structure means nothing. BoloViewer's attached-log pseudo-records
	 * are inserts by the viewer, not ring traffic, so they get no vote. */
	let span = settled_span(records).filter(rec => rec.tankStatus !== 0x0f);
	let votes = new Array(16).fill(0);
	for (let i = 0; i < span.length - 1; i++) {
		if (span[i + 1].time - span[i].time >= BURST_GAP_TICKS) {
			votes[span[i].player & 0x0f]++;
		}
	}
	let order = votes.map((count, player) => [count, player])
		.sort((a, b) => b[0] - a[0]);
	if (order[0][0] < BURST_MIN_VOTES) return null;
	if (order[0][0] < BURST_MARGIN * order[1][0]) return null;
	return order[0][1];
}

function terminal_quit_player(records) {
	for (let i = records.length - 1; i >= 0; i--) {
		if (records[i].tankStatus === 0x0f) continue;  /* viewer insert */
		return records[i].subpackets.some(sub => sub.type === "quit")
			? records[i].player & 0x0f : null;
	}
	return null;
}

/* The player slot the log was recorded by, or null when the log does not
 * say decisively. Either signal alone is trusted; both present and
 * disagreeing is a contradiction, not a majority of one. */
function recorder(records) {
	if (!records || records.length < 2) return null;
	let burst = burst_final_player(records);
	let quit = terminal_quit_player(records);
	if (burst !== null && quit !== null && burst !== quit) return null;
	return burst !== null ? burst : quit;
}

/* The band a pair of readings falls in, exposed so that measurement tools
 * can rate a stretch of records without going back through the trimmer. */
function network_rating(stall, cycle = 0) {
	return CONDITION_NAMES[Math.max(band_of(stall, STALL_BANDS),
		band_of(cycle, CYCLE_BANDS))];
}

/* Ring cycle time over a stretch of records: for each player slot, the
 * gap from one of its records to the next, pooled and read at the p90.
 * Viewer-inserted pseudo-records are not ring traffic and holes past
 * ABSENCE_TICKS are a machine gone, not a slow ring; both stay out. */
function ring_cycle_ticks(span) {
	let last_by_player = new Array(16).fill(-1);
	let gaps = [];
	for (const rec of span) {
		if (rec.tankStatus === 0x0f) continue;  /* viewer insert */
		let player = rec.player & 0x0f;
		if (last_by_player[player] >= 0) {
			let gap = rec.time - last_by_player[player];
			if (gap <= ABSENCE_TICKS) gaps.push(gap);
		}
		last_by_player[player] = rec.time;
	}
	if (!gaps.length) return 0;
	gaps.sort((a, b) => a - b);
	return gaps[Math.floor(CYCLE_QUANTILE * (gaps.length - 1))];
}

/* How many machines are in the ring over a stretch of records: the distinct
 * player slots heard from. Viewer inserts carry no player and are not ring
 * traffic. Never less than one, so the freeze gate below always has a
 * ring's worth of slots to allow. */
function ring_size(span) {
	let seen = new Set();
	for (const rec of span) {
		if (rec.tankStatus === 0x0f) continue;  /* viewer insert */
		seen.add(rec.player & 0x0f);
	}
	return Math.max(1, seen.size);
}

/* Did the ring stop during a silence? The slot counter answers it: a
 * stopped ring cannot step it, since the game needs its packet back to go
 * on, so a held-up packet costs a wait and whatever repairs it leaves the
 * counter unbroken. A silence is therefore a freeze only when the counter
 * moved by no more than one ring's worth of slots -- the ring did not get
 * round even once. The allowance is a whole ring rather than a single slot
 * because the nodes that take the next turns as it resumes may have nothing
 * to log, and a quiet slot steps the counter just the same.
 *
 * The test can only clear a silence, never convict one: the counter is 7
 * bits, so a silence past 128 slots can wrap and alias a large step down
 * into this range, misreading an idle stretch as a freeze -- which is what
 * the reading did for every silence before the gate. A stopped ring has no
 * large step to alias from, so a real freeze is never cleared. */
function ring_stopped(step, players) {
	return step <= players;
}

function network_conditions(records) {
	if (records.length < 2) return null;
	let span = settled_span(records);
	if (span.length < 2) return null;
	let elapsed = span[span.length - 1].time - span[0].time;
	if (elapsed <= 0) return null;

	let missing = 0;     /* ring slots on which a node logged nothing */
	let slots = 0;       /* ring slots accounted for either way */
	let frozen = 0;      /* ticks spent with the ring stopped */
	let players = ring_size(span);

	for (let i = 1; i < span.length; i++) {
		let gap = span[i].time - span[i - 1].time;
		let step = (span[i].seq - span[i - 1].seq) & 0x7f;
		if (gap > STALL_GAP_TICKS && gap <= ABSENCE_TICKS &&
			ring_stopped(step, players)) frozen += gap;
		if (step === 0 || gap > SEQ_TRUST_TICKS) {
			/* a duplicate, or a hole long enough that the 7-bit counter may
			 * have wrapped right round it -- one slot, none of it quiet */
			slots++;
			continue;
		}
		missing += step - 1;
		slots += step;
	}

	let quiet = 100 * missing / Math.max(1, slots);
	let stall = 100 * frozen / elapsed;
	let cycle = ring_cycle_ticks(span);
	return {
		rating: network_rating(stall, cycle), quiet, stall, cycle,
		from: span[0].time, to: span[span.length - 1].time,
	};
}

const BoloNetwork = { network_conditions, network_rating, recorder,
	ring_size, ring_stopped };

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloNetwork;
} else {
	window.BoloNetwork = BoloNetwork;
}

})();
