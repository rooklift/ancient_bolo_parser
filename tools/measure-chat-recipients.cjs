#!/usr/bin/env node
/* Who do non-broadcast chat messages go to?
 *
 * Bolo's chat dialog offers three targets the owner has seen in the
 * emulator: everyone, allies, and nearby tanks. The log carries only the
 * `FA` recipient bitmask, `FFFF` for everyone, so an alliance message and
 * a nearby message look alike on the wire and have to be told apart by
 * the shape of the set. An alliance set is persistent: the same sender
 * uses the same address for message after message, and it includes
 * players wherever they are. A nearby set is a distance cut computed at
 * send time: every recipient is closer to the sender than every
 * non-recipient, and the address changes from one message to the next as
 * tanks move.
 *
 * For every non-broadcast message this tool runs the viewer's game model
 * alongside and compares the address with the sender's alliance set as
 * the model holds it (the sender's own alliance word, the players it
 * marks allied plus the sender, restricted to those present) -- the set
 * the "allies" option would build. An address equal to that set, in the
 * state before or after the record, is an alliance message. Anything
 * else is OTHER: a nearby message, a hand-picked set, or the model's
 * alliance picture being wrong (a netsplit, an accept not yet round the
 * ring). For every message it also takes the sender's last tank position
 * and every other live player's, ranks them by distance, and asks
 * whether the recipients are exactly the nearest k, a distance cut. A
 * nearby message is an OTHER address that is a cut; and if the option
 * uses one fixed radius, the farthest recipient of every such message
 * lies below the nearest excluded player of every other, so the tool
 * brackets the radius from both sides and says whether a single one
 * fits. It also counts how many times each sender reused each address,
 * and whether the sender's own bit is in the set.
 *
 * Usage:
 *   node tools/measure-chat-recipients.cjs [corpus-dir|log ...]   (default: fixtures/)
 *   --samples   list every non-broadcast message with its distance ranking
 *   --other     list only the OTHER messages
 */
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));
const {replay_label} = require("./corpus.cjs");

const STALE = 50 * 30;             // a player unheard of for 30 s is not ranked
const FIXTURES = path.join(__dirname, "..", "fixtures") + path.sep;

let args = process.argv.slice(2);
let samples = args.includes("--samples");
let other_only = args.includes("--other");
let targets = args.filter(a => a !== "--samples" && a !== "--other");
if (!targets.length) targets = [path.join(__dirname, "..", "fixtures")];

function* walk(target) {
	let stat;
	try {
		stat = fs.statSync(target);
	} catch {
		return;
	}
	if (stat.isFile()) {
		yield target;
		return;
	}
	let entries;
	try {
		entries = fs.readdirSync(target, {withFileTypes: true});
	} catch {
		return;
	}
	for (let entry of entries) {
		let item = path.join(target, entry.name);
		if (entry.isDirectory())
			yield* walk(item);
		else if (entry.isFile() && !/\.(txt|md|json|zip|sit|hqx|png|jpg|gif)$/i.test(entry.name))
			yield item;
	}
}

let logs = 0, total = 0, non_broadcast = 0, with_self = 0, ranked = 0;
let cut = 0, cut_one_off = 0, one_off = 0;
let farthest_recipient = 0, nearest_excluded = Infinity;
let alliance_msgs = 0, other_msgs = 0, other_self = 0, other_ranked = 0, other_cut = 0, other_one_off = 0;
let other_cut_far = [], other_cut_near = [];   // per OTHER cut message: farthest recipient, nearest excluded
let other_mixed = 0;
let address_uses = [];               // {log, sender, address, uses}
let rows = [];

/* The sender's alliance set as the model holds it: the sender plus every
 * present player its own alliance word marks allied (a zero bit). */
function alliance_set(state, pl) {
	let set = 0;
	for (let q = 0; q < 16; q++) {
		if (q === pl || (state.present[q] && !(state.alliances[pl] & (1 << q)))) set |= 1 << q;
	}
	return set;
}

function scan(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		return;
	}
	if (!recs.length) return;
	logs++;
	let label = file.startsWith(FIXTURES) ? path.basename(file) : replay_label(file);
	let pos = Array(16).fill(null);
	let present = Array(16).fill(false);
	let last_seen = Array(16).fill(-Infinity);
	let uses = new Map();
	let messages = [];
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));
	for (let rec of recs) {
		let pl = rec.player;
		present[pl] = true;
		last_seen[pl] = rec.time;
		let allies_before = alliance_set(state, pl);
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
		let allies_after = alliance_set(state, pl);
		for (let sub of rec.subpackets) {
			if (sub.type === "tank_position") {
				pos[pl] = {x: sub.x * 16 + sub.pixelX + 8, y: sub.y * 16 + sub.pixelY + 8};
			} else if (sub.type === "quit") {
				present[pl] = false;
				pos[pl] = null;
			} else if (sub.type === "message") {
				total++;
				if (sub.address === 0xffff) continue;
				non_broadcast++;
				let key = `${pl}:${sub.address}`;
				uses.set(key, (uses.get(key) || 0) + 1);
				if (sub.address & (1 << pl)) with_self++;
				let others = [];
				if (pos[pl]) {
					for (let q = 0; q < 16; q++) {
						if (q === pl || !present[q] || !pos[q] || rec.time - last_seen[q] > STALE) continue;
						let d = Math.hypot(pos[q].x - pos[pl].x, pos[q].y - pos[pl].y) / 16;
						others.push({q, d, r: (sub.address & (1 << q)) !== 0});
					}
				}
				others.sort((a, b) => a.d - b.d);
				let is_alliance = sub.address === allies_before || sub.address === allies_after;
				messages.push({time: rec.time, pl, address: sub.address, key, others, text: sub.text, is_alliance, allies: allies_after});
			}
		}
	}
	for (let m of messages) {
		let n = uses.get(m.key);
		if (n === 1) one_off++;
		let recips = m.others.filter(o => o.r), excluded = m.others.filter(o => !o.r);
		let verdict = "-";
		if (m.is_alliance) alliance_msgs++;
		else {
			other_msgs++;
			if (m.address & (1 << m.pl)) other_self++;
			if (n === 1) other_one_off++;
		}
		if (recips.length && excluded.length) {
			ranked++;
			if (!m.is_alliance) other_ranked++;
			let far = recips[recips.length - 1].d, near = excluded[0].d;
			farthest_recipient = Math.max(farthest_recipient, far);
			nearest_excluded = Math.min(nearest_excluded, near);
			if (far < near) {
				cut++;
				if (n === 1) cut_one_off++;
				if (!m.is_alliance) {
					other_cut++;
					other_cut_far.push(far);
					other_cut_near.push(near);
				}
				verdict = "cut";
			} else {
				if (!m.is_alliance) other_mixed++;
				verdict = "mixed";
			}
		}
		if (samples || (other_only && !m.is_alliance)) {
			rows.push(`${label} t${m.time} p${m.pl} ${m.address.toString(16).padStart(4, "0")} ${m.is_alliance ? "allies" : "OTHER "} (allies ${m.allies.toString(16).padStart(4, "0")}) uses ${n} ${verdict.padEnd(5)} | ` +
				m.others.map(o => `${o.q}${o.r ? "*" : ""}@${o.d.toFixed(1)}`).join(" ") + ` | ${JSON.stringify(m.text.slice(0, 40))}`);
		}
	}
	for (let [key, n] of uses) {
		let [sender, address] = key.split(":").map(Number);
		address_uses.push({label, sender, address, uses: n});
	}
}

for (let target of targets) {
	for (let file of walk(target)) scan(file);
}

console.log(`logs ${logs}, messages ${total}, non-broadcast ${non_broadcast}, of which include the sender's own bit ${with_self}`);
console.log(`distinct sender:address pairs ${address_uses.length}; messages on an address the sender used only once ${one_off}`);
console.log(`messages with a recipient and a non-recipient both ranked ${ranked}: recipients are exactly the nearest k in ${cut} (${ranked ? (100 * cut / ranked).toFixed(1) : "-"}%), ${cut_one_off} of those on a one-off address`);
if (ranked) {
	console.log(`farthest recipient ${farthest_recipient.toFixed(1)} squares; nearest excluded player ${nearest_excluded.toFixed(1)} squares`);
}
console.log(`\n=== against the model's alliance set for the sender ===`);
console.log(`alliance messages (address is the sender's alliance set, before or after the record) ${alliance_msgs}`);
console.log(`OTHER messages ${other_msgs}: include the sender's own bit ${other_self}, on a one-off address ${other_one_off}, ranked ${other_ranked}, of which a distance cut ${other_cut} and mixed ${other_mixed}`);
if (other_cut) {
	let far = other_cut_far.slice().sort((a, b) => a - b), near = other_cut_near.slice().sort((a, b) => a - b);
	let max_far = far[far.length - 1], min_near = near[0];
	console.log(`OTHER cut messages: farthest recipient runs ${far[0].toFixed(1)} to ${max_far.toFixed(1)} squares, nearest excluded ${min_near.toFixed(1)} to ${near[near.length - 1].toFixed(1)}`);
	if (max_far < min_near) {
		console.log(`a single radius fits every one of them: between ${max_far.toFixed(1)} and ${min_near.toFixed(1)} squares`);
	} else {
		let fits = 0;
		for (let r = 1; r <= 64; r++) {
			let ok = 0;
			for (let i = 0; i < far.length; i++) if (other_cut_far[i] < r && r <= other_cut_near[i]) ok++;
			if (ok > fits) fits = ok;
		}
		console.log(`no single radius fits them all; the best integer radius fits ${fits} of ${other_cut}`);
	}
}
if (!other_only) console.log(`\n=== addresses per sender (set bits), by log ===`);
for (let a of other_only ? [] : address_uses) {
	let members = [];
	for (let q = 0; q < 16; q++) if (a.address & (1 << q)) members.push(q);
	console.log(`${a.label.padEnd(14)} p${a.sender} -> {${members.join(",")}}${members.includes(a.sender) ? "" : " (sender not in set)"} x${a.uses}`);
}
if (samples || other_only) {
	console.log(`\n=== ${other_only ? "OTHER" : "every non-broadcast"} message: recipients starred, distances in squares, the model's alliance set alongside ===`);
	for (let row of rows) console.log(row);
}
