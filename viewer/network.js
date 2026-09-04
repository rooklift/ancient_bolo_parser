/* Network conditions: rates how a game's networking held up (good / fair /
 * bad / awful) from the record stream alone. No DOM use — also loadable in
 * node for tests. */
"use strict";
(function () {

const TICKS_PER_SECOND = 50;

/* One verdict on how the game's networking held up, for the header.
 *
 * Three readings of the record stream, taken from what the log cannot
 * help recording -- when packets arrived, and which turns of the ring
 * went by with nothing logged:
 *
 *   LOSS -- a name kept for the code, though what it counts is QUIET
 *   SLOTS. The payload's sequence number is a ring slot counter, stepped
 *   once by every node as the packet passes, so consecutive records
 *   normally step by 1. A step of n means n-1 nodes took their turn and
 *   logged nothing: a parked tank between restatements, a dead one, the
 *   recorder itself as readily as anyone. It is almost never a lost
 *   packet: over ten games logged on two machines at once, 12 of
 *   38,318 missing slots were records the other machine had; a moving
 *   tank never misses a restatement across a hole, and the ring turns
 *   through one at full pace (tools/compare-recordings.cjs,
 *   tools/measure-seq-holes.cjs) [E:seq-loss]. A step of 0 is a
 *   duplicate.
 *
 *   STALL. The share of elapsed time spent in gaps where nothing at all
 *   arrived for over half a second -- a freeze the viewer shows whatever
 *   the player count, since no ring cycles that slowly.
 *
 *   CYCLE. How long the ring takes to go round: the 90th percentile of
 *   the gap between one record from a player and the next record from
 *   the same player. A token ring turns at the speed of its slowest
 *   link, so this is the log's latency reading -- and it is invisible
 *   to the other two. A laggy ring drops nothing (the sequence numbers
 *   march by 1) and need never freeze for the half second STALL wants;
 *   it just delivers everything slowly.
 *
 * Both are read only over the stretch of SETTLED PLAY, and that qualifier
 * carries most of the accuracy here. While the game is still gathering --
 * the map being handed to joiners, nodes arriving -- the ring turns at full
 * speed but the logging machine records only a fraction of it, so the
 * sequence number races ahead and every packet it skips is counted as lost.
 * The join ramp therefore reads as catastrophic loss without a single
 * packet having gone astray. It is short in absolute terms (a median 56 s
 * of a 22-minute log) but so extreme that averaging it in dominates
 * everything else: over the corpus, the share of a log spent gathering
 * predicts its untrimmed loss figure at r = 0.83, and once that stretch is
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
 * worst loss figure from 69.8% to 49.5% and the 99th percentile from 46.9%
 * to 28.5%, and it measures no less consistently for the change: half-to-
 * half disagreement falls (p90 of |A-B| from 3.13 to 2.76 points) even as
 * the raw split-half correlation falls with it, that correlation having
 * been inflated by the very spread the marker removes. Rate inference
 * survives only as the fallback for a game nobody ever captured a base in
 * -- there is no such log in the 445-log corpus, so the path is untravelled
 * in practice but cheap to keep.
 *
 * What survives the correction: loss still rises with player count, a ring
 * gaining a hop per player (median 5.2% at two, 6.6% at four, 7.4% at six),
 * and the readings disagree often enough to be worth keeping all three
 * -- a game can be steadily choppy without ever freezing, or laggy
 * without dropping a thing -- so the verdict is the worst of them. What
 * does NOT survive: the apparent year-on-year improvement from 2001 to
 * 2005 was almost entirely faster map transfers shortening the gathering
 * phase; in settled play the median barely moves (6.6% to 5.7%)
 * [E:seq-loss].
 *
 * The cycle reading earns its place by predicting what the viewer can
 * actually make of the stream. Across the corpus, the share of shell
 * observations the motion code fails to chain forward tracks cycle p90
 * at rho = 0.76, against 0.41 for stall and 0.25 for loss -- and the
 * loss figure's correlation is mostly player count in disguise: held to
 * four-player logs it collapses to 0.02 while cycle keeps 0.71. A slow
 * ring undersamples every shell in flight, and no amount of counting
 * dropped packets will see it; the poster child is a log with 2.7% loss
 * whose ring turned every 0.3 s, giving the corpus's worst shell
 * interpolation on nearly its cleanest loss figure. The cycle bands
 * alone stage the corpus at median 0.2% / 0.7% / 2.4% / 7.4% of shells
 * unchained, which is the gradient neither other signal produces. All
 * of it reproduces with tools/measure-network-agreement.cjs.
 *
 * Scoring interleaved half-minute blocks as if they were separate games
 * gives r = 0.88 on loss, 0.94 on stall and 0.99 on cycle time, so this
 * is a property of a session rather than of the moment sampled, and fair
 * to state once for a whole game. The thresholds below place the corpus at roughly 38% good,
 * 46% fair, 13% bad, 4% awful. All of it reproduces with
 * tools/measure-network-conditions.cjs. */

const STALL_GAP_TICKS = TICKS_PER_SECOND / 2;  /* silence that reads as a freeze */
const SEQ_TRUST_TICKS = 250;    /* 5s: past this a step is a rejoin, not loss */
const ABSENCE_TICKS = 1500;     /* 30s: nobody home, not a stalled network */
const SETTLE_BLOCK_TICKS = 500; /* 10s: the grain the join ramp is found on */
const SETTLE_SHARE = 0.7;       /* of a typical block, to count as up to speed */
const MIN_SETTLED_RECORDS = 500;
const LOSS_BANDS = [6, 11, 22];         /* percent of ring slots missing */
const STALL_BANDS = [2, 7, 18];         /* percent of elapsed time frozen */
const CYCLE_BANDS = [14, 19, 26];       /* ticks per ring cycle, at p90 */
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
	/* Read over settled play, like the loss figure and for the same
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
function network_rating(loss, stall, cycle = 0) {
	return CONDITION_NAMES[Math.max(band_of(loss, LOSS_BANDS),
		band_of(stall, STALL_BANDS), band_of(cycle, CYCLE_BANDS))];
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

function network_conditions(records) {
	if (records.length < 2) return null;
	let span = settled_span(records);
	if (span.length < 2) return null;
	let elapsed = span[span.length - 1].time - span[0].time;
	if (elapsed <= 0) return null;

	let missing = 0;     /* ring slots whose packet never arrived */
	let slots = 0;       /* ring slots accounted for either way */
	let frozen = 0;      /* ticks spent hearing nothing at all */

	for (let i = 1; i < span.length; i++) {
		let gap = span[i].time - span[i - 1].time;
		let step = (span[i].seq - span[i - 1].seq) & 0x7f;
		if (gap > STALL_GAP_TICKS && gap <= ABSENCE_TICKS) frozen += gap;
		if (step === 0 || gap > SEQ_TRUST_TICKS) {
			/* a duplicate, or a hole long enough that the 7-bit counter may
			 * have wrapped right round it -- one slot, no loss claimed */
			slots++;
			continue;
		}
		missing += step - 1;
		slots += step;
	}

	let loss = 100 * missing / Math.max(1, slots);
	let stall = 100 * frozen / elapsed;
	let cycle = ring_cycle_ticks(span);
	return {
		rating: network_rating(loss, stall, cycle), loss, stall, cycle,
		from: span[0].time, to: span[span.length - 1].time,
	};
}

const BoloNetwork = { network_conditions, network_rating, recorder };

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloNetwork;
} else {
	window.BoloNetwork = BoloNetwork;
}

})();
