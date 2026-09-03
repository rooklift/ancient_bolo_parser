#!/usr/bin/env node
/* Who owns a base — the slot that captured it, or the person?
 *
 * The log has no base-ownership events beyond `5F` capture, but it has two
 * signals that police any ownership model:
 *
 *   1. A base DRAIN (`Bn`/`Cn`/`Dn`) rides in the refuelling tank's own
 *      record, and only a friendly base (own or allied) refuels a tank —
 *      so a drain by a player the model holds hostile to the base is
 *      proof the model's owner is wrong.
 *   2. A base CAPTURE (`5F`) is only possible on a neutral or hostile
 *      base — so a capture by a player the model holds friendly to the
 *      base (the owner himself included) is the same proof the other
 *      way round.
 *
 * Earlier runs settled two things: an alliance-LEAVER's bases pass to the
 * remaining allies (a leaver is seen capturing his own bases back under
 * every keep-owner reading), and every slot-keyed reading of the quit
 * rules fails somewhere. Dissecting the worst replay showed why: a
 * netsplit shuffles PEOPLE across slots, sometimes with no quit event at
 * all, and afterwards each team's bases are drained exclusively by the
 * same PERSONS from their new slots — including allies who joined the
 * owner's alliance only after the storm — while bases taken from a team
 * before the split have to be captured back from it after. Ownership
 * follows names, not slots, exactly as [E:pill-target] concluded for
 * pills. The readings scored here:
 *
 *   A  bases keep their capturing SLOT through both leave and quit (the
 *      v1.1.2 viewer, as a baseline);
 *   C  the current viewer rule, slot-keyed: a quitter's bases go to the
 *      lowest-index mutual ally with a live tank, else DEPARTED
 *      (nobody's, hostile to all, reclaimed by the owner's name at his
 *      next node_id join); a leaver's to the lowest mutual ally;
 *   E  as C, but with no live-tank heir the bases keep the quitter's
 *      slot rather than going DEPARTED (the best slot-keyed reading of
 *      the earlier runs);
 *   H  person-keyed: ownership AND alliances belong to NAMES, and slots
 *      only carry them. A capture is owned by the capturer's name; a
 *      leave or quit by the owner hands his bases to the heir's name
 *      (lowest-slot name-ally, live-tank on a quit); with no heir the
 *      name keeps them, hostile to all while absent, his again on his
 *      return with no reclaim machinery. Alliance events resolve their
 *      slots to names when they happen and the links then belong to the
 *      persons: a quit does not sever them and a same-name join is a
 *      RECONNECT that keeps links and property alike (the log cannot
 *      distinguish Join from Rejoin by the same name; Rejoin, the one
 *      players told each other to use, is assumed). A join under a NEW
 *      name is a new person with no links, and the name it displaces
 *      suffers an IMPLICIT QUIT — property to its heir, since the log
 *      announces only some disconnects. A RENAME (non-join node_id name
 *      change) carries property and links to the new string, and a
 *      quit-flagged slot still sending records past the straggler second
 *      (a netsplit ghost) counts as carrying its name.
 *
 * Two censuses accompany the score: every departed-bucket drain under C
 * is tagged by who the drainer was (the owner's old slot / the owner's
 * name elsewhere / a stranger, ghosts flagged); and the violations wrong
 * under EVERY reading — the floor — are tagged and sampled, since with H
 * in the table anything left on the floor is unexplained by slot AND name
 * models alike.
 *
 * As with the pill fire rule ([E:pill-target]), an event within a second
 * of an alliance event may have been simulated before the news arrived
 * and is bucketed apart. Drain violations are counted both raw and as
 * distinct log:base:drainer pairs, since one tank camped on one base logs
 * a drain every few ticks. In H's columns the "departed" bucket counts
 * absent-name owners. Player names are compared throughout but never
 * printed; samples show H's owner as the slot its name resolves to, or
 * "absent".
 *
 * Usage: node tools/measure-base-owner.cjs [file | directory]
 * With no argument the corpus root from corpus.json / BOLO_CORPUS is read.
 */
const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
const {corpus_root, replay_label} = require("./corpus.cjs");
const ROOT = args[0] || corpus_root();
const NEUTRAL = 16;
const DEPARTED = BoloGame.DEPARTED;
const TPS = BoloGame.TICKS_PER_SECOND;
const SAMPLE_CASES = 40;
const SAMPLE_PER_LOG = 4;

/* the slot-keyed readings; H is name-keyed and handled apart */
const SLOT_RULES = {
	A: { leave_hand: false, quit: "keep" },
	C: { leave_hand: true, quit: "live" },
	E: { leave_hand: true, quit: "live_else_keep" },
};
const SLOT_MODELS = Object.keys(SLOT_RULES);
/* V is the live viewer itself: game.js's state.bases, scored as played */
const MODELS = SLOT_MODELS.concat(["H", "V"]);

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

function has_live_tank(state, i) {
	let t = state.tanks[i];
	return !!(t && !t.dead && !t.dying);
}

/* The viewer's heir rule, on the pre-event state. */
function lowest_remaining_ally(state, pl, live_only) {
	for (let i = 0; i < 16; i++) {
		let mutual = i !== pl && !(state.alliances[pl] & (1 << i)) && !(state.alliances[i] & (1 << pl));
		if (mutual && !state.quit[i] && (state.present[i] || state.names[i] !== null) &&
			(!live_only || has_live_tank(state, i))) return i;
	}
	return -1;
}

function mutual_ally(state, a, b) {
	return !(state.alliances[a] & (1 << b)) && !(state.alliances[b] & (1 << a));
}

/* Slot-keyed friendliness. */
function friendly(state, owner, player) {
	if (owner === NEUTRAL || owner === DEPARTED) return false;
	if (owner === player) return true;
	return mutual_ally(state, owner, player);
}

/* The person-keyed alliance store: name -> Set of allied names, links
 * always mutual. A quit does not touch it; a leave severs the leaver;
 * a rename carries a person's links to the new string. */
function make_name_allies() {
	let map = new Map();
	let set_of = (n) => {
		if (!map.has(n)) map.set(n, new Set());
		return map.get(n);
	};
	return {
		allied: (a, b) => a !== null && b !== null && map.has(a) && map.get(a).has(b),
		ally: (a, b) => {
			if (a === null || b === null || a === b) return;
			set_of(a).add(b);
			set_of(b).add(a);
		},
		unally: (a, b) => {
			if (map.has(a)) map.get(a).delete(b);
			if (map.has(b)) map.get(b).delete(a);
		},
		sever: (n) => {
			if (n === null || !map.has(n)) return;
			for (let other of map.get(n)) map.get(other).delete(n);
			map.get(n).clear();
		},
		allies_of: (n) => (n !== null && map.has(n)) ? [...map.get(n)] : [],
		rename: (from, to) => {
			if (from === null || to === null || !map.has(from)) return;
			let links = map.get(from);
			map.delete(from);
			for (let other of links) {
				map.get(other).delete(from);
				map.get(other).add(to);
			}
			let dest = set_of(to);
			for (let other of links) dest.add(other);
		},
	};
}

const totals = {
	logs: 0, drains: 0, captures: 0,
	leaves: 0, leaves_by_base_owner: 0, quits_by_base_owner: 0,
	contested_drains: 0, contested_captures: 0, contested_logs: new Set(),
	violations: {},
	samples: [],
	/* who drains a base the viewer's rule (C) holds DEPARTED (non-graced) */
	cdep: { total: 0, owner_slot: 0, owner_name_elsewhere: 0, stranger: 0, while_slot_quit: 0 },
	/* drains and captures wrong under EVERY reading */
	floor: { drains: 0, captures: 0, pairs: new Set(), samples: [] },
};
for (let m of MODELS) {
	totals.violations[m] = {
		drain: 0, drain_graced: 0,
		drain_departed: 0, drain_quit_slot: 0, drain_live: 0,
		drain_pairs: new Set(),
		capture: 0, capture_graced: 0, capture_of_own: 0,
	};
}

function scan(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		return;
	}
	if (!recs.length) return;
	totals.logs++;
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));
	let label = replay_label(file);
	let last_alliance_event = -Infinity;
	let sampled_here = 0;
	let floor_sampled_here = 0;

	/* slot-keyed shadows: owner index (or NEUTRAL/DEPARTED) and, for a
	 * DEPARTED base, the departed owner's name and old slot; name-keyed
	 * shadow: the owning name, or NEUTRAL */
	let owners = {};
	let departed = {};
	let departed_slot = {};
	let h_owner = [];
	let reset_shadows = (owner_list) => {
		for (let m of SLOT_MODELS) {
			owners[m] = owner_list.slice();
			departed[m] = owner_list.map(() => null);
			departed_slot[m] = owner_list.map(() => -1);
		}
		h_owner = owner_list.map(o => o === NEUTRAL ? NEUTRAL : (state.names[o] !== null ? state.names[o] : NEUTRAL));
	};
	reset_shadows(state.bases.map(b => b.owner));

	/* ghost bookkeeping: a quit-flagged slot that resumes sending records
	 * (past the straggler second) is a netsplit ghost, present in all but
	 * the quit flag */
	let quit_time = new Array(16).fill(-Infinity);
	let ghost_active = new Array(16).fill(false);

	/* H's person-keyed state and helpers */
	let na = make_name_allies();
	let name_slot = (name) => {
		if (name === null || name === NEUTRAL) return -1;
		for (let i = 0; i < 16; i++) {
			if ((!state.quit[i] || ghost_active[i]) && state.names[i] === name) return i;
		}
		return -1;
	};
	let friendly_h = (owner_name, player) => {
		if (owner_name === NEUTRAL) return false;
		let s = name_slot(owner_name);
		if (s < 0) return false;
		if (s === player) return true;
		return na.allied(owner_name, state.names[player]);
	};
	/* the heir of a name: the lowest-slot present name-ally, holding a
	 * live tank when the hand-over is a quit */
	let heir_name = (owner_name, live_only) => {
		if (owner_name === null) return null;
		for (let i = 0; i < 16; i++) {
			if (state.quit[i] && !ghost_active[i]) continue;
			let n = state.names[i];
			if (n === null || n === owner_name || !na.allied(owner_name, n)) continue;
			if (live_only && !has_live_tank(state, i)) continue;
			return n;
		}
		return null;
	};
	let hand_over_h = (owner_name, heir) => {
		if (owner_name === null || heir === null) return;
		for (let i = 0; i < h_owner.length; i++) {
			if (h_owner[i] === owner_name) h_owner[i] = heir;
		}
	};

	for (let rec of recs) {
		let pl = rec.player;
		if (state.quit[pl] && rec.time - quit_time[pl] >= TPS) ghost_active[pl] = true;
		for (let sub of rec.subpackets) {
			switch (sub.type) {
			case "base_list":
				reset_shadows(sub.items.map(b => b.owner > 15 ? NEUTRAL : b.owner));
				break;
			case "game_info":
				/* the restated alliance words bind the present NAMES
				 * pairwise; names not in the game keep their links */
				for (let i = 0; i < 16; i++) {
					for (let j = i + 1; j < 16; j++) {
						if (state.names[i] === null || state.names[j] === null) continue;
						let mutual = !(sub.alliances[i] & (1 << j)) && !(sub.alliances[j] & (1 << i));
						if (mutual) na.ally(state.names[i], state.names[j]);
						else na.unally(state.names[i], state.names[j]);
					}
				}
				break;
			case "alliance_request":
				last_alliance_event = rec.time;
				break;
			case "alliance_accept": {
				last_alliance_event = rec.time;
				/* the game model's clique merge, on names */
				let p_name = state.names[pl];
				for (let i = 0; i < 16; i++) {
					if (i !== pl && (sub.tanks & (1 << i)) && p_name !== null && state.names[i] !== null) {
						let group = new Set([p_name, state.names[i]]);
						for (let seed of [p_name, state.names[i]]) {
							for (let other of na.allies_of(seed)) group.add(other);
						}
						let list = [...group];
						for (let a of list) {
							for (let b of list) {
								if (a !== b) na.ally(a, b);
							}
						}
					}
				}
				break;
			}
			case "alliance_leave": {
				last_alliance_event = rec.time;
				let heir = lowest_remaining_ally(state, pl, false);
				if (owners.C.some(o => o === pl)) totals.leaves_by_base_owner++;
				totals.leaves++;
				if (heir >= 0) {
					for (let m of SLOT_MODELS) {
						if (!SLOT_RULES[m].leave_hand) continue;
						for (let i = 0; i < owners[m].length; i++) {
							if (owners[m][i] === pl) {
								owners[m][i] = heir;
								departed[m][i] = null;
								departed_slot[m][i] = -1;
							}
						}
					}
				}
				hand_over_h(state.names[pl], heir_name(state.names[pl], false));
				na.sever(state.names[pl]);
				break;
			}
			case "quit": {
				let live_heir = lowest_remaining_ally(state, pl, true);
				if (owners.A.some(o => o === pl)) totals.quits_by_base_owner++;
				quit_time[pl] = rec.time;
				ghost_active[pl] = false;
				for (let m of SLOT_MODELS) {
					let rule = SLOT_RULES[m].quit;
					if (rule === "keep") continue;
					for (let i = 0; i < owners[m].length; i++) {
						if (owners[m][i] !== pl) continue;
						if (live_heir >= 0) {
							owners[m][i] = live_heir;
							departed[m][i] = null;
							departed_slot[m][i] = -1;
						} else if (rule !== "live_else_keep") {
							owners[m][i] = DEPARTED;
							departed[m][i] = state.names[pl];
							departed_slot[m][i] = pl;
						}
					}
				}
				hand_over_h(state.names[pl], heir_name(state.names[pl], true));
				break;
			}
			case "node_id": {
				ghost_active[pl] = false;   /* the slot formally re-identifies */
				let joining = state.quit[pl] || (node_joins && node_joins.has(rec));
				if (!joining) {
					/* a RENAME: the same person under a new string (F8 is
					 * join, rename, and re-identification alike), so
					 * person-keyed ownership and links follow it */
					if (state.names[pl] !== null && state.names[pl] !== sub.name) {
						for (let i = 0; i < h_owner.length; i++) {
							if (h_owner[i] === state.names[pl]) h_owner[i] = sub.name;
						}
						na.rename(state.names[pl], sub.name);
					}
					break;
				}
				/* a join under a NEW name displaces the slot's old name,
				 * which suffers an implicit quit -- the log announces only
				 * some disconnects. A join under the SAME name is a
				 * reconnect: the person keeps property and links (Rejoin
				 * assumed; the log cannot see the button). */
				if (state.names[pl] !== null && state.names[pl] !== sub.name) {
					hand_over_h(state.names[pl], heir_name(state.names[pl], true));
				}
				for (let m of SLOT_MODELS) {
					for (let i = 0; i < owners[m].length; i++) {
						if (owners[m][i] === DEPARTED && departed[m][i] !== null &&
							departed[m][i] === sub.name) {
							owners[m][i] = pl;
							departed[m][i] = null;
							departed_slot[m][i] = -1;
						}
					}
				}
				break;
			}
			case "base_drain":
			case "base_capture": {
				let b = sub.base;
				if (b >= owners.A.length) break;
				let is_drain = sub.type === "base_drain";
				if (is_drain) totals.drains++; else totals.captures++;
				let graced = rec.time - last_alliance_event <= TPS;
				let h_slot = h_owner[b] === NEUTRAL ? NEUTRAL : name_slot(h_owner[b]);
				let contested = SLOT_MODELS.some(m => owners[m][b] !== owners.A[b]) ||
					(h_owner[b] === NEUTRAL ? owners.A[b] !== NEUTRAL : h_slot !== owners.A[b]);
				if (contested) {
					if (is_drain) totals.contested_drains++; else totals.contested_captures++;
					totals.contested_logs.add(label);
				}
				let bad_models = [];
				for (let m of MODELS) {
					let fr, of_own, kind;
					if (m === "H") {
						fr = friendly_h(h_owner[b], pl);
						of_own = h_slot === pl;
						kind = h_owner[b] === NEUTRAL ? "live" : h_slot < 0 ? "departed"
							: state.quit[h_slot] ? "quit_slot" : "live";
					} else if (m === "V") {
						let o = state.bases[b] ? state.bases[b].owner : NEUTRAL;
						fr = friendly(state, o, pl);
						of_own = o === pl;
						kind = o === DEPARTED ? "departed" : (o < 16 && state.quit[o]) ? "quit_slot" : "live";
					} else {
						let o = owners[m][b];
						fr = friendly(state, o, pl);
						of_own = o === pl;
						kind = o === DEPARTED ? "departed" : (o < 16 && state.quit[o]) ? "quit_slot" : "live";
					}
					let v = totals.violations[m];
					if (is_drain ? !fr : fr) {
						bad_models.push(m);
						if (is_drain) {
							if (graced) v.drain_graced++;
							else {
								v.drain++;
								if (kind === "departed") v.drain_departed++;
								else if (kind === "quit_slot") v.drain_quit_slot++;
								else v.drain_live++;
							}
							v.drain_pairs.add(`${label}:${b}:${pl}`);
						} else {
							graced ? v.capture_graced++ : v.capture++;
							if (of_own) v.capture_of_own++;
						}
					}
				}
				/* census: who drains a base the viewer's rule (C) holds
				 * DEPARTED? */
				if (is_drain && !graced && bad_models.includes("C") && owners.C[b] === DEPARTED) {
					totals.cdep.total++;
					if (departed_slot.C[b] === pl) totals.cdep.owner_slot++;
					else if (departed.C[b] !== null && state.names[pl] === departed.C[b]) totals.cdep.owner_name_elsewhere++;
					else totals.cdep.stranger++;
					if (state.quit[pl]) totals.cdep.while_slot_quit++;
				}
				let describe = (m) => {
					if (m === "H") return h_owner[b] === NEUTRAL ? "neutral" : h_slot < 0 ? "absent" : `@${h_slot}`;
					let o = m === "V" ? (state.bases[b] ? state.bases[b].owner : NEUTRAL) : owners[m][b];
					return o === NEUTRAL ? "neutral" : o === DEPARTED ? "departed" : String(o);
				};
				/* census: the shared floor, wrong under every reading */
				if (bad_models.length === MODELS.length) {
					if (is_drain && !graced) {
						totals.floor.drains++;
						totals.floor.pairs.add(`${label}:${b}:${pl}`);
					} else if (!is_drain) {
						totals.floor.captures++;
					}
					if (totals.floor.samples.length < SAMPLE_CASES && floor_sampled_here < SAMPLE_PER_LOG) {
						floor_sampled_here++;
						totals.floor.samples.push(`${label} t${rec.time} ${sub.type} base ${b} by p${pl}` +
							`${graced ? " (graced)" : ""}: owners ${MODELS.join("/")} = ` +
							MODELS.map(describe).join("/"));
					}
				} else if (bad_models.length && totals.samples.length < SAMPLE_CASES &&
					sampled_here < SAMPLE_PER_LOG) {
					sampled_here++;
					totals.samples.push(`${label} t${rec.time} ${sub.type} base ${b} by p${pl}` +
						`${graced ? " (graced)" : ""}: owners ${MODELS.join("/")} = ` +
						MODELS.map(describe).join("/") +
						`, wrong under ${bad_models.join(",")}`);
				}
				if (!is_drain) {
					for (let m of SLOT_MODELS) {
						owners[m][b] = pl;
						departed[m][b] = null;
						departed_slot[m][b] = -1;
					}
					h_owner[b] = state.names[pl] !== null ? state.names[pl] : NEUTRAL;
				}
				break;
			}
			}
		}
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
	}
}

for (let file of walk(ROOT)) scan(file);

console.log("======================================================================");
console.log(`${totals.logs} logs, ${totals.drains.toLocaleString()} base drains, ` +
	`${totals.captures.toLocaleString()} base captures`);
console.log(`${totals.leaves} alliance leaves, ${totals.leaves_by_base_owner} by a base owner; ` +
	`${totals.quits_by_base_owner} quits by a base owner`);
console.log(`events on a contested base (readings disagree): ` +
	`${totals.contested_drains} drains, ${totals.contested_captures} captures, ` +
	`across ${totals.contested_logs.size} logs`);
console.log();
console.log("Violations per reading (should be ~0 for the correct one):");
console.log("  drain-from-hostile = a refuel the model says the base refuses,");
console.log("  broken down by what the model thinks the owner is (departed --");
console.log("  for H, an absent name -- / a slot that has quit / a live");
console.log("  player), and as distinct log:base:drainer pairs;");
console.log("  capture-of-friendly = a capture the model says is impossible");
console.log("  (of-own: the model says the capturer already owned it);");
console.log("  graced = within a second of an alliance event, counted apart.");
console.log();
console.log(`    ${"model".padStart(5)} ${"drains".padStart(8)} ${"departed".padStart(9)} ` +
	`${"quit-slot".padStart(10)} ${"live".padStart(6)} ${"pairs".padStart(6)} ${"graced".padStart(7)} ` +
	`${"captures".padStart(9)} ${"of-own".padStart(7)} ${"graced".padStart(7)}`);
for (let m of MODELS) {
	let v = totals.violations[m];
	console.log(`    ${m.padStart(5)} ${String(v.drain).padStart(8)} ${String(v.drain_departed).padStart(9)} ` +
		`${String(v.drain_quit_slot).padStart(10)} ${String(v.drain_live).padStart(6)} ` +
		`${String(v.drain_pairs.size).padStart(6)} ${String(v.drain_graced).padStart(7)} ` +
		`${String(v.capture).padStart(9)} ${String(v.capture_of_own).padStart(7)} ${String(v.capture_graced).padStart(7)}`);
}
console.log();
console.log("Who drains a base the viewer's rule (C) holds DEPARTED:");
console.log(`    total ${totals.cdep.total}: by the owner's old slot ${totals.cdep.owner_slot} ` +
	`(${totals.cdep.while_slot_quit} while still quit-flagged, i.e. ghosts), ` +
	`by the owner's name in another slot ${totals.cdep.owner_name_elsewhere}, ` +
	`by anyone else ${totals.cdep.stranger}`);
console.log();
console.log("The shared floor -- wrong under EVERY reading above:");
console.log(`    ${totals.floor.drains} drains in ${totals.floor.pairs.size} log:base:drainer pairs, ` +
	`${totals.floor.captures} captures`);
if (totals.floor.samples.length) {
	console.log();
	console.log("    Floor cases (capped; H's owner shown as @slot or absent):");
	for (let line of totals.floor.samples) console.log(`    ${line}`);
}
if (totals.samples.length) {
	console.log();
	console.log("Cases separating the readings (capped):");
	for (let line of totals.samples) console.log(`    ${line}`);
}
console.log("======================================================================");
