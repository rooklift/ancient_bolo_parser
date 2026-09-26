#!/usr/bin/env node
/* Repair a Bolo log that went through a Mac-to-Unix line-ending conversion.
 *
 * Some logs in the wild were copied as text: every CR byte (0x0D) became
 * LF (0x0A), and every CR LF pair became a single LF. The tell is a file
 * with no 0x0D bytes at all -- an intact log of any size has hundreds,
 * about as many as it has 0x0A. Records are XOR-masked, so a CR turned LF
 * decodes as its true value XOR 7: the file still frames and parses, but
 * a map run starts 5 columns off, an explosion lands on deep sea, a tank
 * jumps a few squares. A collapsed pair also loses a byte, which breaks
 * the record framing from that point on.
 *
 * Every LF in a damaged file therefore stands for one of three originals:
 * LF, CR, or CR LF. The repair settles them in three stages.
 *
 * Framing. A shortest-path search over the damaged bytes decides where
 * pairs collapsed. Each record read from a position branches at every
 * LF (one byte, or a CR LF pair); a branch lives only while its length
 * bytes are valid and its time tags stay in order, so a wrong framing
 * dies within a record or two. Among the survivors the fewest restored
 * pairs win, with parse warnings as a tiebreak.
 *
 * Time tags. Records received on one tick share their damaged time bytes
 * and must move together, so these are settled over the whole log at
 * once (Viterbi): time never runs backwards, a record usually shares its
 * tick with a neighbour, and each sender's records come at a steady
 * cadence.
 *
 * Values. Each record holding an ambiguous payload byte is re-read under
 * every assignment of those bytes (LF or CR, and which LF a restored pair
 * belongs to, keeping the framing) and scored against its context: the
 * sender's seq chain, tank and man positions interpolated from the
 * sender's neighbouring records, shell tracks (2 px/tick in straight
 * lines), the live game state (pill and base positions, terrain, via the
 * viewer's own apply_record), the map-run chain and its RLE lengths,
 * names seen elsewhere in the log, and plain-text plausibility for chat.
 * The lowest penalty wins. A neighbour whose own reading of a field is
 * still in doubt is not consulted for that field, so two damaged records
 * cannot talk each other into the same wrong answer; three passes let
 * settled neighbours inform the rest. Where no evidence separates the
 * two readings, the byte stays LF and is reported as undecided.
 *
 * Over 31 intact logs damaged the same way, the framing comes back exact
 * every time and 96.5% of the ambiguous bytes are restored exactly (87-99%
 * per log); what remains is mostly a tank's speed or sub-square position
 * byte, a shell deep in a chained offset list, and a man's pixel byte.
 *
 * Usage:
 *   node tools/repair-crlf.mjs <log-or-directory>... [--out DIR] [--check] [--verbose]
 *
 *   --check    only report whether each file looks converted
 *   --out DIR  where repaired logs and their .repair.txt reports go
 *              (default: alongside each input, as <name>.repaired)
 *   --verbose  list every ambiguous byte in the report, not only the
 *              undecided and low-confidence ones
 *   --map FILE a .map file of the map these games were played on; for a
 *              log whose map name matches the file's name, the file's
 *              pill, base and start positions and its terrain count as
 *              evidence
 *
 * The library exports looks_converted, repair, and damage (the forward
 * conversion, for testing against intact logs).
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MASK } from "../src/mask.js";
import { parseRecord } from "../src/parse.js";

const require = createRequire(import.meta.url);
const BoloGame = require("../viewer/game.js");
const BoloMap = require("../viewer/format.js");

const HEADER_SIZE = 72;
const LF = 0x0a;
const CR = 0x0d;
const MAP_SIZE = 256;
const DEEP_SEA = 255;

/* kinds of reconstructed byte */
const VERBATIM = 0;
const HOLE = 1;     /* a damaged LF standing alone: LF or CR */
const PAIR_CR = 2;  /* the CR of a collapsed CR LF */
const PAIR_LF = 3;  /* the LF of a collapsed CR LF */

/* A framing may not skip more time than this between records; intact
 * logs never exceed a few hundred ticks. */
const MAX_GAP = 5000;

/* shells fly at 2 px/tick (SHELL_SPEED_PIXELS_PER_TICK in viewer/motion.js) */
const SHELL_SPEED = 2;

/* a reading that beats its best rival by less than this leaves the field
 * in doubt, and out of its neighbours' context */
const DOUBT_MARGIN = 2;

/* How often each terrain change (old terrain > new) and each explosion
 * (old terrain > code) happens, counted over four intact logs from
 * 2002-2007 against the viewer's reconstructed terrain. */
const TERRAIN_CHANGES = {
	"5>7": 1660, "7>5": 1027, "1>9": 297, "4>0": 162, "6>4": 139, "3>4": 99, "7>0": 71,
	"6>0": 31, "7>4": 23, "3>1": 18, "3>5": 3, "8>0": 3, "1>4": 2, "3>0": 2,
};
const EXPLOSIONS = {
	"8>11": 1403, "5>7": 730, "8>6": 492, "0>8": 458, "9>1": 190, "4>3": 85, "7>3": 82,
	"12>3": 80, "15>3": 22, "4>13": 14, "6>6": 13, "1>3": 12, "1>1": 12, "7>7": 11, "6>3": 11,
	"3>3": 7, "7>11": 6, "8>8": 4, "5>3": 4, "9>3": 4, "11>3": 4, "4>12": 3, "13>7": 3,
	"7>13": 2, "3>12": 2, "14>3": 1, "7>12": 1, "5>12": 1, "7>2": 1, "1>13": 1, "4>1": 1, "13>3": 1,
};

/* -ln P(outcome | old terrain) from one of the tables above */
function transition_penalty(table, old, outcome) {
	let total = 0;
	for (let [k, n] of Object.entries(table)) if (k.startsWith(`${old}>`)) total += n;
	if (!total) return 0;
	return -Math.log(((table[`${old}>${outcome}`] || 0) + 0.2) / (total + 3.2));
}

/* ------------------------------------------------------------------------
 * The damage itself, for tests and for spotting it. */

export function damage(buf) {
	let out = [];
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === CR) {
			out.push(LF);
			if (buf[i + 1] === LF) i++;
		} else {
			out.push(buf[i]);
		}
	}
	return Uint8Array.from(out);
}

export function looks_converted(buf) {
	let cr = 0, lf = 0;
	for (let b of buf) {
		if (b === CR) cr++;
		else if (b === LF) lf++;
	}
	/* an intact log has a CR about every 400 bytes, so a few thousand
	 * bytes with none at all is already telling */
	return { converted: cr === 0 && lf > 0 && buf.length > 4096, cr, lf };
}

/* ------------------------------------------------------------------------
 * Record bytes. */

function decrypt(bytes) {
	let data = new Uint8Array(bytes.length - 5);
	for (let i = 0; i < data.length; i++) data[i] = bytes[5 + i] ^ MASK[(i + 1) % MASK.length];
	return data;
}

function raw_time(bytes) {
	return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

function parse_bytes(bytes, offset) {
	return parseRecord({ offset, time: raw_time(bytes), data: decrypt(bytes) });
}

/* Every way the damaged bytes from d on can expand into one whole record:
 * each LF is one byte (a hole) or a restored CR LF pair, whose LF may
 * spill into the next record (pend_out). pend says this record opens
 * with such a spilled LF. */
function record_expansions(buf, d, pend, limit) {
	let list = [];
	let bytes = [], kinds = [];
	let truncated = false;
	function step(d, pend, inserts) {
		if (list.length >= limit) return;
		if (bytes.length === 5) {
			let len = bytes[4] ^ MASK[0];
			if (len < 4 || len > 127) return;
		}
		let need = bytes.length >= 5 ? 4 + (bytes[4] ^ MASK[0]) : 5;
		if (bytes.length === need) {
			list.push({
				bytes: Uint8Array.from(bytes), kinds: Uint8Array.from(kinds),
				d_end: d, pend_out: pend, inserts,
			});
			return;
		}
		if (pend) {
			bytes.push(LF); kinds.push(PAIR_LF);
			step(d, false, inserts);
			bytes.pop(); kinds.pop();
			return;
		}
		if (d >= buf.length) {
			truncated = true;
			return;
		}
		let b = buf[d];
		if (b !== LF) {
			bytes.push(b); kinds.push(VERBATIM);
			step(d + 1, false, inserts);
			bytes.pop(); kinds.pop();
			return;
		}
		bytes.push(LF); kinds.push(HOLE);
		step(d + 1, false, inserts);
		bytes.pop(); kinds.pop();
		bytes.push(CR); kinds.push(PAIR_CR);
		step(d + 1, true, inserts + 1);
		bytes.pop(); kinds.pop();
	}
	step(d, pend, 0);
	return { list, truncated };
}

/* The time tags a record's first four bytes can stand for. */
function time_candidates(bytes, kinds) {
	let holes = [];
	for (let i = 0; i < 4; i++) if (kinds[i] === HOLE) holes.push(i);
	let out = [];
	for (let m = 0; m < 1 << holes.length; m++) {
		let b = bytes.slice(0, 4);
		holes.forEach((h, j) => { if (m >> j & 1) b[h] = CR; });
		out.push({ t: raw_time(b), b });
	}
	return out;
}

/* ------------------------------------------------------------------------
 * Stage 1: framing. */

class MinHeap {
	constructor() { this.a = []; }
	get size() { return this.a.length; }
	push(v) {
		let a = this.a;
		a.push(v);
		let i = a.length - 1;
		while (i > 0) {
			let p = (i - 1) >> 1;
			if (a[p] <= a[i]) break;
			[a[p], a[i]] = [a[i], a[p]];
			i = p;
		}
	}
	pop() {
		let a = this.a;
		let top = a[0], last = a.pop();
		if (a.length) {
			a[0] = last;
			let i = 0;
			for (;;) {
				let l = 2 * i + 1, r = l + 1, m = i;
				if (l < a.length && a[l] < a[m]) m = l;
				if (r < a.length && a[r] < a[m]) m = r;
				if (m === i) break;
				[a[m], a[i]] = [a[i], a[m]];
				i = m;
			}
		}
		return top;
	}
}

/* States are record boundaries, keyed by damaged position and whether a
 * spilled LF is owed; every record read from one lands strictly further
 * on, so taking keys in increasing order settles each before it is
 * expanded. */
function frame(buf) {
	let n = buf.length;
	let best = new Map();
	let heap = new MinHeap();
	let key_of = (d, pend) => d * 2 + (pend ? 1 : 0);
	best.set(key_of(HEADER_SIZE, false), { d: HEADER_SIZE, pend: false, cost: 0, time: null, parent: null, rec: null });
	heap.push(key_of(HEADER_SIZE, false));
	let finals = [];
	let done = new Set();

	while (heap.size) {
		let key = heap.pop();
		if (done.has(key)) continue;
		done.add(key);
		let st = best.get(key);
		if (st.d >= n && !st.pend) {
			finals.push({ st, tail: 0, cost: st.cost });
			continue;
		}
		let { list, truncated } = record_expansions(buf, st.d, st.pend, 4096);
		if (truncated && !st.pend) finals.push({ st, tail: n - st.d, cost: st.cost + 1 });
		for (let e of list) {
			let t = null;
			for (let { t: c } of time_candidates(e.bytes, e.kinds)) {
				if (st.time === null) {
					if (t === null || c < t) t = c;
					continue;
				}
				let gap = (c - st.time) >>> 0;
				if (gap <= MAX_GAP && (t === null || gap < ((t - st.time) >>> 0))) t = c;
			}
			if (t === null) continue;
			let cost = st.cost + e.inserts;
			if (st.time !== null) cost += ((t - st.time) >>> 0) / 20000;
			if (parse_bytes(e.bytes, 0).warning) cost += 2;
			let key2 = key_of(e.d_end, e.pend_out);
			let old = best.get(key2);
			if (!old || cost < old.cost) {
				best.set(key2, { d: e.d_end, pend: e.pend_out, cost, time: t, parent: st, rec: e, d0: st.d, pend_in: st.pend });
				heap.push(key2);
			}
		}
	}
	if (!finals.length) throw new Error("no framing of the damaged file survives");
	finals.sort((a, b) => a.cost - b.cost || a.tail - b.tail);
	let fin = finals[0];
	let records = [];
	for (let st = fin.st; st.parent; st = st.parent) {
		records.push({
			d0: st.d0, pend_in: st.pend_in, d_end: st.d, pend_out: st.pend,
			bytes: st.rec.bytes, kinds: st.rec.kinds,
		});
	}
	records.reverse();
	return { records, tail: buf.subarray(n - fin.tail) };
}

/* ------------------------------------------------------------------------
 * Stage 2: time tags. Viterbi over the record sequence, run twice so the
 * cadence can lean on the first run's answers. */

function solve_times(recs, players) {
	let cands = recs.map(r => time_candidates(r.bytes, r.kinds));
	let chosen = cands.map(() => 0);
	let margins = cands.map(() => Infinity);
	let by_player = Array.from({ length: 16 }, () => []);
	recs.forEach((r, i) => by_player[players[i]].push(i));
	let pos_in_player = new Int32Array(recs.length);
	for (let list of by_player) list.forEach((i, k) => { pos_in_player[i] = k; });
	let n = recs.length;

	for (let round = 0; round < 2; round++) {
		let settled = i => cands[i].length === 1 || round > 0;
		let time_of = i => cands[i][chosen[i]].t;
		/* distance from the midpoint of the sender's settled neighbours */
		let local = cands.map((c, i) => {
			let list = by_player[players[i]];
			let k = pos_in_player[i];
			let j = k - 1, l = k + 1;
			while (j >= 0 && !settled(list[j])) j--;
			while (l < list.length && !settled(list[l])) l++;
			return c.map(({ t }) => {
				if (j < 0 || l >= list.length) return 0;
				let tj = time_of(list[j]), tl = time_of(list[l]);
				let mid = tj + (tl - tj) * (k - j) / (l - j);
				return Math.abs(t - mid) * 0.7;
			});
		});
		/* order may not run backwards; sharing a tick is the norm */
		let trans = (a, b) => b < a ? Infinity : b === a ? 0 : 0.6;
		let fwd = [], back = [];
		for (let i = 0; i < n; i++) {
			back.push([]);
			fwd.push(cands[i].map((c, x) => {
				if (i === 0) return local[i][x];
				let best = Infinity, arg = 0;
				cands[i - 1].forEach((p, y) => {
					let v = fwd[i - 1][y] + trans(p.t, c.t);
					if (v < best) { best = v; arg = y; }
				});
				back[i][x] = arg;
				return best + local[i][x];
			}));
		}
		let bwd = new Array(n);
		for (let i = n - 1; i >= 0; i--) {
			bwd[i] = cands[i].map(c => {
				if (i === n - 1) return 0;
				let best = Infinity;
				cands[i + 1].forEach((q, y) => {
					best = Math.min(best, trans(c.t, q.t) + local[i + 1][y] + bwd[i + 1][y]);
				});
				return best;
			});
		}
		let last = fwd[n - 1];
		let x = last.indexOf(Math.min(...last));
		for (let i = n - 1; i >= 0; i--) {
			chosen[i] = x;
			if (i > 0) x = back[i][x];
		}
		for (let i = 0; i < n; i++) {
			if (cands[i].length === 1) continue;
			let totals = cands[i].map((c, y) => fwd[i][y] + bwd[i][y]);
			let win = totals[chosen[i]];
			margins[i] = Math.min(...totals.filter((v, y) => y !== chosen[i])) - win;
		}
	}
	return { cands, chosen, margins };
}

/* ------------------------------------------------------------------------
 * Stage 3: values. */

/* The field two readings of a record disagree on, as "type:key" for a
 * subpacket field; also the unit of doubt. */
function describe_field(a, b) {
	if (a.time !== b.time) return "time tag";
	if (a.seq !== b.seq) return "seq";
	if (a.player !== b.player) return "player";
	if (a.status !== b.status) return "status";
	if (a.tankDir !== b.tankDir || a.tankStatus !== b.tankStatus) return "tank status/direction";
	let sa = a.subpackets, sb = b.subpackets;
	for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
		let x = sa[i], y = sb[i];
		if (!x || !y || x.type !== y.type) return `${(x || y).type}:structure`;
		for (let key of Object.keys(x)) {
			if (JSON.stringify(x[key]) !== JSON.stringify(y[key])) return `${x.type}:${key}`;
		}
	}
	return "structure";
}

const TANK_POSITION = ["tank_position:x", "tank_position:y", "tank_position:pixelX", "tank_position:pixelY", "tank_position:structure"];
const MAN_POSITION = ["lgm_position:", "parachute_position:"];
const SHELLS = ["shells:"];

function tank_px(sub) {
	return [sub.x * 16 + sub.pixelX, sub.y * 16 + sub.pixelY];
}

function shell_points(rec) {
	let pts = [];
	for (let sub of rec.subpackets) {
		if (sub.type !== "shells") continue;
		let first = sub.shells[0];
		let x = first.x * 16 + (first.pixel & 15), y = first.y * 16 + (first.pixel >> 4);
		pts.push([x, y, sub.direction]);
		for (let s of sub.shells.slice(1)) {
			x += s.offsetX;
			y += s.offsetY;
			pts.push([x, y, sub.direction]);
		}
	}
	return pts;
}

/* how many elements of a sorted list are below i */
function rank(list, i) {
	let lo = 0, hi = list.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (list[mid] < i) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/* Is record idx's reading of these fields settled? A field ending in ":"
 * stands for every key of that subpacket type. */
function trusted(ctx, idx, fields) {
	let doubt = ctx.doubt[idx];
	if (!doubt.size) return true;
	if (doubt.has("player")) return false;
	for (let f of fields) {
		if (f.endsWith(":")) {
			for (let d of doubt) if (d.startsWith(f)) return false;
		} else if (doubt.has(f)) {
			return false;
		}
	}
	return true;
}

/* The nearest records before and after i in a sorted list whose reading
 * of the given fields is settled. */
function neighbours(ctx, list, i, fields) {
	let lo = rank(list, i);
	let prev = null, next = null;
	for (let k = lo - 1; k >= 0 && k >= lo - 64; k--) {
		if (trusted(ctx, list[k], fields)) { prev = list[k]; break; }
	}
	let start = lo < list.length && list[lo] === i ? lo + 1 : lo;
	for (let k = start; k < list.length && k < start + 64; k++) {
		if (trusted(ctx, list[k], fields)) { next = list[k]; break; }
	}
	return [prev, next];
}

function build_context(parsed, doubt) {
	let per = Array.from({ length: 16 }, () => ({ all: [], tank: [], man: [], shells: [] }));
	let names = new Map();
	let named = new Set();
	let runs = [];
	for (let i = 0; i < parsed.length; i++) {
		let rec = parsed[i];
		let pp = per[rec.player];
		pp.all.push(i);
		let has = type => rec.subpackets.some(sub => sub.type === type);
		if (has("tank_position")) pp.tank.push(i);
		if (has("lgm_position") || has("parachute_position")) pp.man.push(i);
		if (has("shells")) pp.shells.push(i);
		if (has("map_run")) runs.push(i);
		if (doubt[i].size) continue;
		for (let sub of rec.subpackets) {
			if (sub.type === "node_id" || sub.type === "history") {
				if (sub.name) names.set(sub.name, (names.get(sub.name) || 0) + 1);
				if (sub.type === "node_id") named.add(rec.player);
			}
		}
	}
	/* a player is real if named, or too busy to be a misread nibble */
	let players = new Set();
	for (let p = 0; p < 16; p++) if (named.has(p) || per[p].all.length >= 50) players.add(p);
	/* seq step per sender: the commonest low-7-bit difference */
	let step = per.map(pp => {
		let tally = new Map();
		for (let k = 1; k < pp.all.length; k++) {
			let d = (parsed[pp.all[k]].seq - parsed[pp.all[k - 1]].seq) & 0x7f;
			tally.set(d, (tally.get(d) || 0) + 1);
		}
		let bestd = 2, bestn = -1;
		for (let [d, c] of tally) if (c > bestn) { bestd = d; bestn = c; }
		return bestd;
	});
	/* For checking the object lists at the top of the log:
	 * - where each pill was first visited: a tank picks a pill up by
	 *   driving over it, a man repairs one standing on it;
	 * - where a tank first sat to capture or drain each base;
	 * - until a pill is first picked up, the lines its shots flew along.
	 *   A pill's shell is first seen anything from 7 to 28 px along its
	 *   heading, but within 3 px of the line through the pill. */
	let pill_visits = new Map(), base_visits = new Map(), pill_shots = new Map();
	let moved = new Set();
	for (let i = 0; i < parsed.length; i++) {
		let rec = parsed[i];
		let man = rec.subpackets.find(s => s.type === "lgm_position");
		let tank = rec.subpackets.find(s => s.type === "tank_position");
		for (let sub of rec.subpackets) {
			let visitor = sub.type === "pill_pickup" ? tank : /^pill_repair/.test(sub.type) ? man : null;
			if (visitor && !pill_visits.has(sub.pillbox)) pill_visits.set(sub.pillbox, tank_px(visitor));
			if (sub.type === "pill_pickup") moved.add(sub.pillbox);
			if ((sub.type === "base_capture" || sub.type === "base_drain") && tank && !base_visits.has(sub.base)) {
				base_visits.set(sub.base, tank_px(tank));
			}
			if (sub.type === "pillbox_fires" && !moved.has(sub.pillbox)) {
				/* the sender's first shell list on the pill's heading,
				 * flown back to the moment of firing */
				let list = per[rec.player].shells;
				let k = list[rank(list, i)];
				if (k === undefined || parsed[k].time - rec.time > 30) continue;
				let rays = shell_points(parsed[k]).filter(q => q[2] === sub.direction);
				if (!rays.length) continue;
				if (!pill_shots.has(sub.pillbox)) pill_shots.set(sub.pillbox, []);
				pill_shots.get(sub.pillbox).push(rays);
			}
		}
	}
	return { parsed, doubt, per, names, players, step, runs, pill_visits, base_visits, pill_shots };
}

/* how English-like a short text is: a rank penalty per character, and
 * another for a character unlike both its neighbours (a digit in a run
 * of question marks) */
const COMMON = " etaoinshrdlcumwfgypbvkjxqz";
function char_class(ch) {
	if (/[a-z]/i.test(ch)) return "letter";
	if (/[0-9]/.test(ch)) return "digit";
	if (ch === " ") return "space";
	return ch;
}
function text_penalty(str) {
	let pen = 0;
	let chars = [...str];
	chars.forEach((ch, i) => {
		let c = ch.charCodeAt(0);
		let lower = ch.toLowerCase();
		let r = COMMON.indexOf(lower);
		if (c < 0x20 || c === 0x7f) pen += 20;
		else if (r >= 0) pen += r / 6 + (ch !== lower ? 0.5 : 0);
		else if (c >= 0x30 && c <= 0x39) pen += 2;
		else if (".,!?'-:;()".includes(ch)) pen += 2.5;
		else pen += 4;
		if (i > 0 && i + 1 < chars.length) {
			let a = char_class(chars[i - 1]), b = char_class(ch), z = char_class(chars[i + 1]);
			if (a === z && b !== a) pen += 1.5;
		}
	});
	return pen;
}

function circ_diff(a, b) {
	let d = Math.abs(a - b) & 15;
	return Math.min(d, 16 - d);
}

function popcount(v) {
	let n = 0;
	while (v) { n += v & 1; v >>= 1; }
	return n;
}

function dist(a, b) {
	return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/* Penalty for a position against the sender's settled neighbouring
 * positions of the same kind: the smaller one-sided overshoot of what the
 * object could have travelled, plus the miss from the straight line
 * between them when they are close enough in time to join by one. */
function motion_penalty(ctx, list, fields, i, time, pos, type, vmax, span) {
	let [j, k] = neighbours(ctx, list, i, fields);
	let pj = null, pk = null, tj = 0, tk = 0, vj = vmax, vk = vmax;
	let find = idx => ctx.parsed[idx].subpackets.find(s => s.type === type);
	let speed_of = q => typeof vmax === "function" ? vmax(q) : vmax;
	if (j !== null) { let s = find(j); if (s) { pj = tank_px(s); tj = ctx.parsed[j].time; vj = speed_of(s); } }
	if (k !== null) { let s = find(k); if (s) { pk = tank_px(s); tk = ctx.parsed[k].time; vk = speed_of(s); } }
	let sides = [], moved = [];
	if (pj) {
		moved.push(dist(pos, pj));
		sides.push(Math.max(0, dist(pos, pj) - vj * Math.abs(time - tj) - 1));
	}
	if (pk) {
		moved.push(dist(pos, pk));
		sides.push(Math.max(0, dist(pos, pk) - vk * Math.abs(tk - time) - 1));
	}
	if (!sides.length) return 0;
	/* overshoot, and a slight preference for moving less */
	let pen = Math.min(...sides) / 4 + Math.min(...moved) * 0.01;
	vmax = Math.max(vj, vk);
	if (pj && pk && tk > tj && tk - tj <= span && dist(pj, pk) <= vmax * (tk - tj) + 8) {
		let f = Math.min(1, Math.max(0, (time - tj) / (tk - tj)));
		let pred = [pj[0] + (pk[0] - pj[0]) * f, pj[1] + (pk[1] - pj[1]) * f];
		pen += dist(pos, pred) / 3;
	}
	return Math.min(pen, 40);
}

function tank_state_px(t) {
	return t ? [t.x * 16 + t.px, t.y * 16 + t.py] : null;
}

/* a shell point [x, y, direction] flown on for dt ticks */
function fly(b, dt) {
	let th = b[2] * Math.PI / 8;
	return [b[0] + Math.sin(th) * SHELL_SPEED * dt, b[1] - Math.cos(th) * SHELL_SPEED * dt, b[2]];
}

/* where the sender's things are, in pixels: its tank, its man, and its
 * shells in this record and, flown on to now, the one before */
function sender_points(ctx, rec, i, s) {
	let pts = [];
	for (let sub of rec.subpackets) {
		if (sub.type === "tank_position" || sub.type === "lgm_position" || sub.type === "parachute_position") pts.push(tank_px(sub));
	}
	let t = tank_state_px(s.tanks[rec.player]);
	if (t) pts.push(t);
	let m = tank_state_px(s.men[rec.player]);
	if (m) pts.push(m);
	for (let p of shell_points(rec)) pts.push(p);
	let [j] = neighbours(ctx, ctx.per[rec.player].shells, i, SHELLS);
	if (j !== null) for (let p of shell_points(ctx.parsed[j])) pts.push(p, fly(p, rec.time - ctx.parsed[j].time));
	return pts;
}

/* squares beyond `free` from the nearest point, times weight */
function near_penalty(pts, square, free, weight) {
	if (!pts.length) return 0;
	let c = [square[0] * 16 + 8, square[1] * 16 + 8];
	let d = Math.min(...pts.map(p => dist(p, c))) / 16;
	return Math.max(0, d - free) * weight;
}

function terrain_at(s, x, y) {
	return s.grid[y * MAP_SIZE + x];
}

function decode_run(run) {
	let y = run[1], x = run[2], endx = run[3];
	let nibs = [];
	for (let i = 4; i < run.length; i++) nibs.push(run[i] >> 4, run[i] & 15);
	let squares = [];
	let i = 0;
	while (x < endx && i < nibs.length) {
		let code = nibs[i++];
		if (code >= 8) {
			if (i >= nibs.length) break;
			let t = nibs[i++];
			for (let k = 0; k < code - 6; k++) squares.push([x++, t]);
		} else {
			for (let k = 0; k <= code && i < nibs.length; k++) squares.push([x++, nibs[i++]]);
		}
	}
	return { y, squares, ok: x === endx };
}

/* The penalty for one reading of record i: lower is more plausible. s is
 * the game state before the record; explain, when given, collects the
 * contributions by name. */
function score(rec, i, ctx, s, seed_grid, explain) {
	let pen = 0;
	let add = (label, v) => {
		if (!v) return;
		pen += v;
		if (explain) explain.push([label, +v.toFixed(3)]);
	};
	if (rec.warning) add("parse warning", 30);

	let p = rec.player;
	let pp = ctx.per[p];
	if (!ctx.players.has(p)) add("unknown player", 25);

	/* the sender's seq steps by a fixed amount per record; the nearest
	 * settled neighbours may be several of its records away */
	let [j, k] = neighbours(ctx, pp.all, i, ["seq"]);
	let step = ctx.step[p] || 2;
	let seq_pen = (d, gap) => {
		let want = (step * gap) & 0x7f;
		if (d === want) return 0;
		return d % step === 0 && d > want && d <= want + 3 * step ? 1 : 6;
	};
	let at = rank(pp.all, i), here = pp.all[at] === i ? 1 : 0;
	if (j !== null) add("seq", seq_pen((rec.seq - ctx.parsed[j].seq) & 0x7f, at - rank(pp.all, j)));
	if (k !== null) add("seq", seq_pen((ctx.parsed[k].seq - rec.seq) & 0x7f, rank(pp.all, k) - at - here + 1));
	if (rec.tankStatus & 0x08) {
		let near = neighbours(ctx, pp.tank, i, ["tank status/direction"]).filter(x => x !== null);
		if (near.length) add("direction", Math.min(...near.map(x => circ_diff(rec.tankDir, ctx.parsed[x].tankDir))) * 0.7);
	}

	for (let sub of rec.subpackets) {
		switch (sub.type) {
			case "tank_position": {
				/* a tank covers about speed/64 px a tick, never over 1.7 */
				let reach = q => Math.min(1.7, Math.max(q.speed, sub.speed) / 64 * 1.3 + 0.05);
				add("tank motion", motion_penalty(ctx, pp.tank, TANK_POSITION, i, rec.time, tank_px(sub), "tank_position", reach, 150));
				let get = idx => ({ q: ctx.parsed[idx].subpackets.find(q => q.type === "tank_position"), t: ctx.parsed[idx].time });
				/* speed never passes 64, and moves 1 a tick while the
				 * accelerate or decelerate bit is set: each neighbour's
				 * bits predict the speed across the gap */
				if (sub.speed > 64) add("speed over 64", 15);
				let [sj, sk] = neighbours(ctx, pp.tank, i, ["tank_position:speed", "tank_position:motion"]);
				/* from speed a at one record to b at a later one, dt ticks
				 * on: b may rise by up to dt if either end's bits say
				 * accelerate, fall likewise for decelerate, give or take
				 * a couple of ticks of receive jitter; and when both ends
				 * show the same bits, they held throughout */
				let gap_penalty = (a, a_motion, b, b_motion, dt) => {
					let bits = a_motion | b_motion;
					let lo = bits & 2 ? Math.max(0, a - dt) : a, hi = bits & 1 ? Math.min(64, a + dt) : a;
					let exact = a_motion & 1 ? Math.min(64, a + dt) : a_motion & 2 ? Math.max(0, a - dt) : a;
					let steady = ((a_motion ^ b_motion) & 3) === 0;
					return Math.min(12, Math.max(0, lo - 2 - b, b - hi - 2)) / 2 +
						Math.min(12, Math.abs(b - exact)) * (steady ? 0.25 : 0.03);
				};
				if (sj !== null && !sub.dying) {
					let e = get(sj);
					if (e.q && !e.q.dying) add("speed", gap_penalty(e.q.speed, e.q.motion, sub.speed, sub.motion, rec.time - e.t));
				}
				if (sk !== null && !sub.dying) {
					let e = get(sk);
					if (e.q && !e.q.dying) add("speed", gap_penalty(sub.speed, sub.motion, e.q.speed, e.q.motion, e.t - rec.time));
				}
				let mo = neighbours(ctx, pp.tank, i, ["tank_position:motion"]).filter(x => x !== null).map(get);
				if (mo.length) add("motion bits", Math.min(...mo.map(e => popcount(e.q.motion ^ sub.motion))) * 0.3);
				break;
			}
			case "lgm_position":
				/* the man walks at under 1 px/tick */
				add("man motion", motion_penalty(ctx, pp.man, MAN_POSITION, i, rec.time, tank_px(sub), "lgm_position", 1.0, 150));
				{
					/* a man just out of the tank, or about to get back in,
					 * is at the tank */
					let tank = rec.subpackets.find(q => q.type === "tank_position");
					let at_all = rank(pp.all, i);
					let aj = at_all > 0 ? pp.all[at_all - 1] : null;
					let ak = pp.all[at_all + here] ?? null;
					let out = idx => idx !== null && (ctx.parsed[idx].status & 0x08);
					if (tank && (!out(aj) || !out(ak))) add("man leaving tank", Math.max(0, dist(tank_px(sub), tank_px(tank)) - 24) / 4);
				}
				break;
			case "parachute_position":
				/* the parachute drifts in a straight line at about 0.1 px/tick */
				add("parachute motion", motion_penalty(ctx, pp.man, MAN_POSITION, i, rec.time, tank_px(sub), "parachute_position", 0.15, 2000));
				break;
			case "shell_falls": {
				/* where one of the sender's last shells has flown to */
				let [sj] = neighbours(ctx, pp.shells, i, SHELLS);
				let at_px = [sub.x * 16 + (sub.pixel & 15), sub.y * 16 + (sub.pixel >> 4)];
				if (sj !== null) {
					let dt = rec.time - ctx.parsed[sj].time;
					let pts = shell_points(ctx.parsed[sj]).map(b => fly(b, dt));
					if (pts.length) add("shell falls", Math.min(20, Math.max(0, Math.min(...pts.map(q => dist(q, at_px))) - 2 - 0.4 * dt) / 3));
				}
				break;
			}
			case "shot_fired":
				/* a tank fires the way it faces */
				add("shot direction", circ_diff(sub.direction, rec.tankDir) * 1.5);
				break;
			case "terrain_change":
			case "explosion": {
				let old_terrain = terrain_at(s, sub.x, sub.y);
				let sets_terrain = sub.type === "terrain_change" || sub.code <= 9 || sub.code === 0x0d;
				if (sets_terrain && old_terrain === DEEP_SEA) add("terrain on deep sea", 15);
				if (sub.x < 10 || sub.y < 10 || sub.x > 245 || sub.y > 245) add("off the map", 10);
				let pts = sender_points(ctx, rec, i, s);
				add("far from sender", Math.min(15, near_penalty(pts, [sub.x, sub.y], 10, 1)));
				add("off the sender's track", Math.min(4, near_penalty(pts, [sub.x, sub.y], 1.5, 0.5)));
				if (sub.type === "explosion") add("unusual explosion", transition_penalty(EXPLOSIONS, old_terrain, sub.code) * 0.7);
				else add("unusual terrain change", transition_penalty(TERRAIN_CHANGES, old_terrain, sub.terrain) * 0.7);
				break;
			}
			case "pillbox_damage":
			case "pillbox_fires": {
				let pill = s.pills[sub.pillbox];
				if (!pill) { add("no such pill", 20); break; }
				if (pill.inTank !== null && pill.inTank !== undefined) add("pill not on the ground", 10);
				if (sub.type === "pillbox_damage") {
					/* hits come in runs on one pill (94% of them share a
					 * target with the sender's neighbouring records), and
					 * a dead pill is hardly ever hit */
					if (pill.armour === 0) add("hit on a dead pill", 4);
					let at_all = rank(pp.all, i), run = false;
					for (let k = Math.max(0, at_all - 8); k <= Math.min(pp.all.length - 1, at_all + 8) && !run; k++) {
						let idx = pp.all[k];
						if (idx === i || !trusted(ctx, idx, ["pillbox_damage:pillbox"])) continue;
						run = ctx.parsed[idx].subpackets.some(q => q.type === "pillbox_damage" && q.pillbox === sub.pillbox);
					}
					if (!run) add("hit breaks the sender's run", 3);
				}
				add("pill far from sender", Math.min(15, near_penalty(sender_points(ctx, rec, i, s), [pill.x, pill.y], 10, 1)));
				/* a pill fires at the sender's tank */
				let t = rec.subpackets.find(q => q.type === "tank_position");
				let tp = t ? tank_px(t) : tank_state_px(s.tanks[p]);
				if (sub.type === "pillbox_fires" && tp) {
					let bearing = Math.round(Math.atan2(tp[0] - (pill.x * 16 + 8), (pill.y * 16 + 8) - tp[1]) / (Math.PI / 8)) & 15;
					add("pill aim", Math.min(4, circ_diff(sub.direction, bearing)));
				}
				break;
			}
			case "pill_pickup":
			case "pill_repair_4":
			case "pill_repair_8":
			case "pill_repair_12":
			case "pill_repair_full": {
				/* a tank picks a pill up by driving over it; a man repairs
				 * it standing on it */
				let pill = s.pills[sub.pillbox];
				if (!pill) { add("no such pill", 20); break; }
				if (sub.type === "pill_pickup" && pill.inTank !== null && pill.inTank !== undefined) add("pill not on the ground", 10);
				let who = sub.type === "pill_pickup" ? ["tank_position"] : ["lgm_position"];
				let pts = rec.subpackets.filter(q => who.includes(q.type)).map(tank_px);
				let held = tank_state_px(sub.type === "pill_pickup" ? s.tanks[p] : s.men[p]);
				if (held) pts.push(held);
				add("pill far from its visitor", Math.min(15, near_penalty(pts, [pill.x, pill.y], 1, 2)));
				break;
			}
			case "base_damage":
			case "base_drain":
			case "base_capture":
			case "base_tow_pickup": {
				let base = s.bases[sub.base];
				if (!base) { add("no such base", 20); break; }
				let free = sub.type === "base_damage" ? 10 : 1.5;
				let pts = rec.subpackets.filter(q => q.type === "tank_position").map(tank_px);
				let t = tank_state_px(s.tanks[p]);
				if (t) pts.push(t);
				add("base far from tank", Math.min(15, near_penalty(pts, [base.x, base.y], free, 2)));
				break;
			}
			case "pill_plant":
			case "pill_dumped_by_dead_lgm":
			case "base_tow_drop": {
				let t = terrain_at(s, sub.x, sub.y);
				if (t === DEEP_SEA || t === 0 || t === 8) add("placed on impossible terrain", 10);
				/* the man plants a pill where he stands; a towed base is
				 * dropped by the tank */
				let who = sub.type === "base_tow_drop" ? "tank_position" : "lgm_position";
				let pts = rec.subpackets.filter(q => q.type === who).map(tank_px);
				let held = tank_state_px(who === "tank_position" ? s.tanks[p] : s.men[p]);
				if (held) pts.push(held);
				if (!pts.length) pts = sender_points(ctx, rec, i, s);
				add("placed far from its placer", Math.min(15, near_penalty(pts, [sub.x, sub.y], 1, 3)));
				break;
			}
			case "tank_hit":
				if (!ctx.players.has(sub.tank)) add("hit on unknown tank", 20);
				break;
			case "tank_death":
				if (sub.code < 1 || sub.code > 3) add("unknown death code", 20);
				break;
			case "message": {
				add("chat text", text_penalty(sub.text) * 0.5);
				let bad = 0;
				for (let b = 0; b < 16; b++) if ((sub.address >> b & 1) && !ctx.players.has(b)) bad++;
				if (sub.address !== 0xffff) add("chat to unknown players", bad * 0.5);
				break;
			}
			case "node_id":
			case "history":
				if (sub.name) {
					if ((ctx.names.get(sub.name) || 0) < 2) add("name not seen elsewhere", 6);
					add("name text", text_penalty(sub.name) * 0.1);
				}
				break;
			case "game_info":
				add("map name text", text_penalty(sub.mapName) * 0.3);
				break;
			case "map_run": {
				let run = decode_run(sub.run);
				if (!run.ok) add("run length mismatch", 50);
				let rj = null, rk = null;
				let at_run = rank(ctx.runs, i);
				if (at_run > 0) rj = ctx.runs[at_run - 1];
				let after = ctx.runs[at_run] === i ? at_run + 1 : at_run;
				if (after < ctx.runs.length) rk = ctx.runs[after];
				let prev_run = rj !== null ? ctx.parsed[rj].subpackets.find(q => q.type === "map_run") : null;
				let want = prev_run ? (prev_run.run[1] << 8) | prev_run.run[3] : 0;
				if (sub.mapKnown !== want) add("mapknown chain", 20);
				let next_run = rk !== null ? ctx.parsed[rk].subpackets.find(q => q.type === "map_run") : null;
				if (next_run && next_run.mapKnown !== ((sub.run[1] << 8) | sub.run[3])) add("mapknown chain", 20);
				if (prev_run && sub.run[1] < prev_run.run[1]) add("rows out of order", 20);
				/* terrain agreeing with the rows above and below */
				if (ctx.map_hint) {
					let differ = 0;
					for (let [x, t] of run.squares) if (x < MAP_SIZE && ctx.map_hint.grid[run.y * MAP_SIZE + x] !== t) differ++;
					add("differs from the map file", differ * 2);
				}
				if (seed_grid) {
					let differ = 0;
					for (let [x, t] of run.squares) {
						for (let dy of [-1, 1]) {
							let yy = run.y + dy;
							if (yy < 0 || yy >= MAP_SIZE || x >= MAP_SIZE) continue;
							if (seed_grid[yy * MAP_SIZE + x] !== t) differ++;
						}
					}
					add("terrain unlike rows above and below", differ * 0.3);
				}
				break;
			}
			case "pillbox_list":
			case "base_list":
			case "start_list":
				sub.items.forEach((item, n) => {
					let from_file = ctx.map_hint && ctx.map_hint[{ pillbox_list: "pills", base_list: "bases", start_list: "starts" }[sub.type]][n];
					if (from_file && (from_file.x !== item.x || from_file.y !== item.y)) add("differs from the map file", 20);
					if (item.x <= 20 || item.x >= 236 || item.y <= 20 || item.y >= 236) add("object in the mined border", 10);
					if (item.owner !== undefined && item.owner > 15 && item.owner !== 0xff) add("object owner", 5);
					if (sub.type === "start_list") {
						if (item.direction > 15) add("start direction", 5);
						return;
					}
					if (seed_grid && seed_grid[item.y * MAP_SIZE + item.x] === DEEP_SEA) add("object on deep sea", 8);
					if (sub.type === "pillbox_list") {
						if (item.armour > 15 && item.armour !== 0xff) add("pill armour", 5);
						let v = ctx.pill_visits.get(n);
						if (v) add("pill far from its first visit", Math.min(15, near_penalty([v], [item.x, item.y], 1.5, 2)));
						let shots = ctx.pill_shots.get(n);
						if (shots && shots.length >= 5) {
							/* mean distance from the lines its shots flew
							 * along (shell coordinates name a cell's
							 * top-left corner, as the pill's square does) */
							let c = [item.x * 16, item.y * 16], total = 0;
							for (let rays of shots) {
								total += Math.min(...rays.map(q => {
									let th = q[2] * Math.PI / 8;
									return Math.min(16, Math.abs((c[0] - q[0]) * -Math.cos(th) - (c[1] - q[1]) * Math.sin(th)));
								}));
							}
							add("pill off its shots' lines", Math.min(10, total / shots.length / 2));
						}
					} else {
						for (let f of ["armour", "shells", "mines"]) if (item[f] > 90) add("base stock", 5);
						let v = ctx.base_visits.get(n);
						if (v) add("base far from its first visit", Math.min(15, near_penalty([v], [item.x, item.y], 1.5, 2)));
					}
				});
				break;
		}
	}

	/* shells: each should lie on the straight line between a shell of the
	 * sender's previous shell list and one of its next, or failing that
	 * continue one of them along its heading, or be leaving the tank */
	let pts = shell_points(rec);
	if (pts.length) {
		let [sj, sk] = neighbours(ctx, pp.shells, i, SHELLS);
		let tank = rec.subpackets.find(q => q.type === "tank_position");
		let origin = tank ? tank_px(tank) : tank_state_px(s.tanks[p]);
		let before = sj !== null ? shell_points(ctx.parsed[sj]) : [], tb = sj !== null ? ctx.parsed[sj].time : 0;
		let after = sk !== null ? shell_points(ctx.parsed[sk]) : [], ta = sk !== null ? ctx.parsed[sk].time : 0;
		for (let a of pts) {
			let best = 40;
			for (let b of before) {
				for (let c of after) {
					if (b[2] !== a[2] || c[2] !== a[2] || ta <= tb) continue;
					if (Math.abs(dist(b, c) - SHELL_SPEED * (ta - tb)) > 6) continue;
					let f = (rec.time - tb) / (ta - tb);
					let pred = [b[0] + (c[0] - b[0]) * f, b[1] + (c[1] - b[1]) * f];
					best = Math.min(best, dist(a, pred) / 2);
				}
			}
			for (let [list, t] of [[before, tb], [after, ta]]) {
				for (let b of list) {
					let dt = rec.time - t;
					let pred = fly(b, dt);
					let slack = 2 + Math.abs(dt) * 0.4;
					best = Math.min(best, 1 + Math.max(0, dist(a, pred) - slack) / 3 + (b[2] === a[2] ? 0 : 3));
				}
			}
			if (origin) best = Math.min(best, 4 + Math.max(0, dist(a, origin) - 24) / 4);
			add("shell track", best);
		}
		/* shells fired in a burst fly in formation: the offset from one to
		 * the next barely changes between records */
		let offsets_of = idx => idx === null ? [] : ctx.parsed[idx].subpackets
			.filter(q => q.type === "shells")
			.flatMap(q => q.shells.slice(1).map(o => [o.offsetX, o.offsetY, q.direction]));
		let known = [...offsets_of(sj), ...offsets_of(sk)];
		if (known.length) {
			for (let q of rec.subpackets) {
				if (q.type !== "shells") continue;
				for (let o of q.shells.slice(1)) {
					let near = known.filter(k => k[2] === q.direction).map(k => dist(k, [o.offsetX, o.offsetY]));
					if (near.length) add("shell formation", Math.min(8, ...near) / 4);
				}
			}
		}
	}
	return pen;
}

/* Every reading of a framed record's ambiguous bytes that keeps its
 * framing and the time tag already settled for it. */
function candidates(buf, r, time_bytes, limit) {
	let { list } = record_expansions(buf, r.d0, r.pend_in, 4096);
	list = list.filter(e => e.d_end === r.d_end && e.pend_out === r.pend_out);
	if (!list.length) list = [{ bytes: r.bytes, kinds: r.kinds }];
	let out = [];
	for (let e of list) {
		let base = e.bytes.slice();
		for (let h = 0; h < 4; h++) if (e.kinds[h] === HOLE) base[h] = time_bytes[h];
		if (base.subarray(0, 4).some((v, h) => v !== time_bytes[h])) continue;
		let holes = [];
		for (let i = 4; i < e.kinds.length; i++) if (e.kinds[i] === HOLE) holes.push(i);
		if (holes.length > 12) {
			out.push({ bytes: base, kinds: e.kinds, holes, greedy: true });
			continue;
		}
		for (let m = 0; m < 1 << holes.length; m++) {
			let b = base.slice();
			holes.forEach((h, jj) => { if (m >> jj & 1) b[h] = CR; });
			/* a lone CR right before an LF would have collapsed with it */
			let legal = true;
			for (let h = 0; h + 1 < b.length; h++) {
				if (e.kinds[h] === HOLE && b[h] === CR && b[h + 1] === LF && e.kinds[h + 1] !== PAIR_LF) legal = false;
			}
			if (legal) out.push({ bytes: b, kinds: e.kinds, holes });
			if (out.length > limit) return out;
		}
	}
	if (!out.length) out.push({ bytes: r.bytes, kinds: r.kinds, holes: [] });
	return out;
}

export function repair(buf, options = {}) {
	let passes = options.passes || 3;
	let framed = frame(buf);
	let recs = framed.records;
	let offsets = [];
	let off = HEADER_SIZE;
	for (let r of recs) { offsets.push(off); off += r.bytes.length; }
	let decisions = [];

	let players = recs.map(r => parse_bytes(r.bytes, 0).player);
	let times = solve_times(recs, players);
	let time_bytes = recs.map((r, i) => times.cands[i][times.chosen[i]].b);
	recs = recs.map((r, i) => {
		let b = r.bytes.slice();
		b.set(time_bytes[i], 0);
		return { ...r, bytes: b };
	});

	let parsed = recs.map((r, i) => parse_bytes(r.bytes, offsets[i]));
	let payload_ambiguous = recs.map(r => r.kinds.some((k, x) => x >= 4 && k !== VERBATIM));
	/* to begin with, every field holding an ambiguous byte is in doubt */
	let doubt = recs.map((r, i) => {
		let d = new Set();
		for (let x = 4; x < r.kinds.length; x++) {
			if (r.kinds[x] !== HOLE) continue;
			let alt = r.bytes.slice();
			alt[x] = CR;
			d.add(describe_field(parsed[i], parse_bytes(alt, offsets[i])));
		}
		return d;
	});

	for (let pass = 0; pass < passes; pass++) {
		let last = pass === passes - 1;
		let ctx = build_context(parsed, doubt);
		ctx.map_hint = options.map_hint || null;
		let node_joins = BoloGame.classify_node_joins(parsed);
		let seed = BoloGame.extract_initial_map(parsed, node_joins);
		let s = BoloGame.initial_state(seed);
		let next_doubt = doubt.slice();
		let score_of = (bytes, i) => score(parse_bytes(bytes, offsets[i]), i, ctx, s, seed.grid);
		for (let i = 0; i < recs.length; i++) {
			if (payload_ambiguous[i]) {
				let scored = [];
				for (let c of candidates(buf, recs[i], time_bytes[i], 20000)) {
					if (c.greedy) {
						/* too many holes to enumerate: settle them one at a time */
						let b = c.bytes.slice();
						for (let h of c.holes) {
							let alt = b.slice();
							alt[h] = CR;
							if (score_of(alt, i) < score_of(b, i)) b = alt;
						}
						scored.push({ c: { ...c, bytes: b }, pen: score_of(b, i) });
					} else {
						scored.push({ c, pen: score_of(c.bytes, i) });
					}
				}
				/* ties keep the file's own bytes: fewest CRs, then the
				 * framing stage's own placement of restored pairs */
				let crs = b => b.reduce((n, v) => n + (v === CR), 0);
				let same_kinds = c => c.kinds.every((k, x) => k === recs[i].kinds[x]);
				scored.sort((a, b) => a.pen - b.pen || crs(a.c.bytes) - crs(b.c.bytes) || same_kinds(b.c) - same_kinds(a.c));
				let win = scored[0];
				if (last && options.explain === i) {
					for (let o of scored.slice(0, 4)) {
						let ex = [];
						let rec = parse_bytes(o.c.bytes, offsets[i]);
						score(rec, i, ctx, s, seed.grid, ex);
						console.log(`penalty ${o.pen.toFixed(2)}: ${JSON.stringify(rec.subpackets)}`);
						console.log(`  ${ex.map(([l, v]) => `${l} ${v}`).join(", ")}`);
					}
				}
				recs[i] = { ...recs[i], bytes: win.c.bytes, kinds: win.c.kinds };
				parsed[i] = parse_bytes(win.c.bytes, offsets[i]);
				ctx.parsed[i] = parsed[i];
				/* per ambiguous byte: how much worse the best reading that
				 * disagrees with the winner there scored */
				let d = new Set();
				for (let x = 4; x < win.c.bytes.length; x++) {
					if (win.c.kinds[x] === VERBATIM || win.c.kinds[x] === PAIR_LF) continue;
					let rival = scored.find(o => o !== win && (o.c.bytes[x] !== win.c.bytes[x] || o.c.kinds[x] !== win.c.kinds[x]));
					let margin = rival ? rival.pen - win.pen : Infinity;
					let field = rival ? describe_field(parsed[i], parse_bytes(rival.c.bytes, offsets[i])) : "";
					if (margin < DOUBT_MARGIN) d.add(field);
					if (last) {
						decisions.push({
							record: i, time: parsed[i].time, player: parsed[i].player, byte: x,
							kind: win.c.kinds[x], value: win.c.bytes[x], margin, field,
						});
					}
				}
				next_doubt[i] = d;
			}
			BoloGame.apply_record(s, parsed[i], null, null, null, node_joins);
		}
		doubt = next_doubt;
	}

	/* the time tag decisions, reported alongside */
	recs.forEach((r, i) => {
		for (let x = 0; x < 4; x++) {
			if (r.kinds[x] === VERBATIM || r.kinds[x] === PAIR_LF) continue;
			decisions.push({
				record: i, time: parsed[i].time, player: parsed[i].player, byte: x,
				kind: r.kinds[x], value: r.bytes[x],
				margin: r.kinds[x] === HOLE ? times.margins[i] : Infinity, field: "time tag",
			});
		}
	});
	decisions.sort((a, b) => a.record - b.record || a.byte - b.byte);

	let parts = [buf.subarray(0, HEADER_SIZE), ...recs.map(r => r.bytes), framed.tail];
	let out = new Uint8Array(parts.reduce((n, a) => n + a.length, 0));
	let at = 0;
	for (let a of parts) { out.set(a, at); at += a.length; }
	return { bytes: out, records: parsed, offsets, decisions, tail: framed.tail.length, map_note: options.map_note };
}

/* ------------------------------------------------------------------------
 * CLI */

/* Does a log's map name match a .map file's name? The name is compared
 * with punctuation and case dropped, and may end the file's name, since
 * files are often saved as "Chew_Toy_3.map" or with a prefix. */
function map_name_matches(map_name, file) {
	let norm = t => t.toLowerCase().replace(/[^a-z0-9]/g, "");
	let want = norm(map_name);
	return want.length > 0 && norm(path.basename(file).replace(/\.map$/i, "")).endsWith(want);
}

/* the map name a damaged log names in its game info (never ambiguous in
 * practice: checked by the caller against the repaired reading) */
function log_map_name(bytes) {
	for (let rec of repair_free_records(bytes)) {
		let info = rec.subpackets.find(s => s.type === "game_info");
		if (info) return info.mapName;
	}
	return null;
}

function* repair_free_records(bytes) {
	let pos = HEADER_SIZE;
	while (pos + 5 <= bytes.length) {
		let len = bytes[pos + 4] ^ MASK[0];
		if (len < 4 || len > 127 || pos + 4 + len > bytes.length) return;
		yield parse_bytes(bytes.subarray(pos, pos + 4 + len), pos);
		pos += 4 + len;
	}
}

function fmt_time(ticks, t0) {
	let s = (ticks - t0) / 50;
	let m = Math.floor(s / 60);
	return `${m}:${(s - m * 60).toFixed(2).padStart(5, "0")}`;
}

export function report_text(name, buf, result, verbose) {
	let d = result.decisions.filter(x => x.kind !== PAIR_LF);
	let count = f => d.filter(f).length;
	let t0 = result.records.length ? result.records[0].time : 0;
	let lines = [];
	lines.push(name);
	lines.push(`damaged size ${buf.length}, repaired size ${result.bytes.length}, records ${result.records.length}`);
	lines.push(`LF bytes read: ${d.length}`);
	lines.push(`  restored as CR LF pairs: ${count(x => x.kind === PAIR_CR)}`);
	lines.push(`  read as CR:              ${count(x => x.kind === HOLE && x.value === CR)}`);
	lines.push(`  kept as LF:              ${count(x => x.kind === HOLE && x.value === LF)}`);
	lines.push(`  undecided (no evidence either way, left as LF): ${count(x => x.margin === 0)}`);
	lines.push(`  low confidence (won by under 1):                ${count(x => x.margin > 0 && x.margin < 1)}`);
	lines.push(`records with parse warnings after repair: ${result.records.filter(r => r.warning).length}`);
	if (result.tail) lines.push(`truncated final record: ${result.tail} byte(s) kept as found`);
	if (result.map_note) lines.push(result.map_note);
	let by_field = new Map();
	for (let x of d) {
		let key = x.field || "(no alternative)";
		let e = by_field.get(key) || { n: 0, cr: 0, undecided: 0, low: 0 };
		e.n++;
		if (x.value === CR) e.cr++;
		if (x.margin === 0) e.undecided++;
		else if (x.margin < 1) e.low++;
		by_field.set(key, e);
	}
	lines.push("");
	lines.push(`${"by field".padEnd(32)} ${"bytes".padStart(6)} ${"as CR".padStart(6)} ${"undec.".padStart(6)} ${"low".padStart(6)}`);
	for (let [k, e] of [...by_field].sort((a, b) => b[1].n - a[1].n)) {
		lines.push(`  ${k.padEnd(30)} ${String(e.n).padStart(6)} ${String(e.cr).padStart(6)} ${String(e.undecided).padStart(6)} ${String(e.low).padStart(6)}`);
	}
	lines.push("");
	lines.push(verbose ? "every decision:" : "undecided and low-confidence decisions:");
	lines.push(`  ${"time".padStart(8)}  pl  ${"field".padEnd(30)} ${"choice".padEnd(6)} margin`);
	for (let x of d) {
		if (!verbose && x.margin >= 1) continue;
		let choice = x.kind === PAIR_CR ? "CR LF" : x.value === CR ? "CR" : "LF";
		let margin = x.margin === Infinity ? "only reading" : x.margin.toFixed(2);
		lines.push(`  ${fmt_time(x.time, t0).padStart(8)}  ${String(x.player).padStart(2)}  ${(x.field || "-").padEnd(30)} ${choice.padEnd(6)} ${margin}`);
	}
	return lines.join("\n") + "\n";
}

function collect(target) {
	if (!fs.statSync(target).isDirectory()) return [target];
	let out = [];
	for (let e of fs.readdirSync(target, { withFileTypes: true })) {
		let p = path.join(target, e.name);
		if (e.isDirectory()) out.push(...collect(p));
		else if (!/\.(repaired|txt|md|zip|map)$/i.test(e.name) && !e.name.startsWith(".")) out.push(p);
	}
	return out.sort();
}

function main(argv) {
	let args = argv.slice(2);
	let out_dir = null, check = false, verbose = false, explain, map_file = null;
	let targets = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out") out_dir = args[++i];
		else if (args[i] === "--check") check = true;
		else if (args[i] === "--verbose") verbose = true;
		else if (args[i] === "--explain") explain = +args[++i];
		else if (args[i] === "--map") map_file = args[++i];
		else targets.push(args[i]);
	}
	if (!targets.length) {
		console.error("usage: node tools/repair-crlf.mjs <log-or-directory>... [--out DIR] [--check] [--verbose] [--map FILE]");
		process.exit(2);
	}
	let map = map_file ? BoloMap.parse_map(new Uint8Array(fs.readFileSync(map_file))) : null;
	for (let f of targets.flatMap(collect)) {
		let buf = new Uint8Array(fs.readFileSync(f));
		if (buf.length < HEADER_SIZE || String.fromCharCode(...buf.subarray(0, 4)) !== "Bolo") {
			console.log(`${f}: not a Bolo log, skipped`);
			continue;
		}
		let look = looks_converted(buf);
		if (check || !look.converted) {
			console.log(`${f}: ${look.converted ? "CONVERTED" : "intact"} (CR ${look.cr}, LF ${look.lf})`);
			continue;
		}
		let options = { explain };
		if (map) {
			let name = log_map_name(buf);
			if (name !== null && map_name_matches(name, map_file)) {
				options.map_hint = map;
				options.map_note = `map file ${path.basename(map_file)} used as evidence (log's map: "${name}")`;
			} else {
				options.map_note = `map file ${path.basename(map_file)} not used: this log's map is "${name}"`;
			}
		}
		let result = repair(buf, options);
		/* the name the hint was matched on must survive the repair */
		if (options.map_hint && log_map_name(result.bytes) !== log_map_name(buf)) {
			result = repair(buf, { explain, map_note: `map file ${path.basename(map_file)} not used: this log's map name was itself damaged` });
		}
		let base = path.basename(f);
		let dest = out_dir ? path.join(out_dir, base) : f + ".repaired";
		if (out_dir) fs.mkdirSync(out_dir, { recursive: true });
		fs.writeFileSync(dest, result.bytes);
		let text = report_text(base, buf, result, verbose);
		fs.writeFileSync(dest + ".repair.txt", text);
		console.log(text.split("\n").slice(0, 10).join("\n"));
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv);
}
