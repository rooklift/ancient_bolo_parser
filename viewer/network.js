/* Network conditions: rates how a game's networking held up (good / fair /
 * bad / awful) from the record stream alone. No DOM use — also loadable in
 * node for tests. */
"use strict";
(function () {

const TICKS_PER_SECOND = 50;

/* One verdict on how the game's networking held up, for the header.
 *
 * Two readings of the record stream, taken from what the log cannot help
 * recording -- when packets arrived, and how many the machine never saw:
 *
 *   LOSS. The payload's sequence number is bumped by every node a packet
 *   passes, so consecutive records normally step by 1. A step of n means
 *   n-1 packets never reached the logging machine; a step of 0 is a
 *   duplicate, not a loss.
 *
 *   STALL. The share of elapsed time spent in gaps where nothing at all
 *   arrived for over half a second -- a freeze the viewer shows whatever
 *   the player count, since no ring cycles that slowly.
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
 * and the two readings still agree at r = 0.69 while disagreeing often
 * enough to be worth keeping both -- a game can be steadily choppy without
 * ever freezing -- so the verdict is the worse of them. What does NOT
 * survive: the apparent year-on-year improvement from 2001 to 2005 was
 * almost entirely faster map transfers shortening the gathering phase; in
 * settled play the median barely moves (6.6% to 5.7%) [E:seq-loss].
 *
 * Scoring interleaved half-minute blocks as if they were separate games
 * gives r = 0.88 on loss and 0.94 on stall, so this is a property of a
 * session rather than of the moment sampled, and fair to state once for a
 * whole game. The thresholds below place the corpus at roughly 43% good,
 * 42% fair, 11% bad, 4% awful. All of it reproduces with
 * tools/measure-network-conditions.cjs. */

const STALL_GAP_TICKS = TICKS_PER_SECOND / 2;  /* silence that reads as a freeze */
const SEQ_TRUST_TICKS = 250;    /* 5s: past this a step is a rejoin, not loss */
const ABSENCE_TICKS = 1500;     /* 30s: nobody home, not a stalled network */
const SETTLE_BLOCK_TICKS = 500; /* 10s: the grain the join ramp is found on */
const SETTLE_SHARE = 0.7;       /* of a typical block, to count as up to speed */
const MIN_SETTLED_RECORDS = 500;
const LOSS_BANDS = [6, 11, 22];         /* percent of ring slots missing */
const STALL_BANDS = [2, 7, 18];         /* percent of elapsed time frozen */
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

/* The band a pair of readings falls in, exposed so that measurement tools
 * can rate a stretch of records without going back through the trimmer. */
function network_rating(loss, stall) {
	return CONDITION_NAMES[Math.max(band_of(loss, LOSS_BANDS), band_of(stall, STALL_BANDS))];
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
	return {
		rating: network_rating(loss, stall), loss, stall,
		from: span[0].time, to: span[span.length - 1].time,
	};
}

const BoloNetwork = { network_conditions, network_rating };

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloNetwork;
} else {
	window.BoloNetwork = BoloNetwork;
}

})();
