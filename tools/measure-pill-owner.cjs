#!/usr/bin/env node
/* Do pillboxes follow the person-keyed ownership that bases do?
 *
 * The base study (measure-base-owner.cjs) ended with ownership and
 * alliances keyed by NAME: slots only carry them, a same-name join is a
 * reconnect keeping links and property (Rejoin assumed), a new-name join
 * implicitly quits the name it displaces, renames carry everything
 * along, and a netsplit ghost counts as present. [E:pill-target] already
 * concluded pills are followed "by name across slot shuffles"; this tool
 * asks whether the same person-keyed model beats the viewer's slot-keyed
 * pill rules on the log's own signals:
 *
 *   1. `F4` FIRES police "wrongly friendly": a pill never fires at its
 *      own side, so a fire at a player the model holds friendly to the
 *      pill is proof the model is wrong. Exemptions as in the viewer:
 *      an odd index at direction 0 [E:pill-fire-index], and a fire
 *      within a second of an alliance event.
 *   2. PICKUPS of a live pill would police "wrongly hostile" the way
 *      base drains did — but the corpus contains none: every one of its
 *      35,123 pickups is of a dead pill, so a pill must be DEAD to be
 *      taken and pickups discriminate nothing about ownership. The
 *      count is kept as an invariant check: a live pickup ever
 *      appearing would be news.
 *
 * REPAIRS are counted only as context, and hostile-pill repairs as a
 * census, never as violations: on the owner's word, repairing a pill —
 * dead or alive — never captures it and is not restricted to one's own
 * side; players repair NEUTRAL pills deliberately to deny the enemy a
 * capture (a pill must be dead to be taken), and enemy pills by
 * misclick. The corpus's hostile-repair census (175 events in 162
 * log:pill:actor pairs, identical under both models) is exactly that
 * denial play and those misclicks.
 *
 * Two models are scored:
 *
 *   V  the viewer as it stands (game.js): slot-keyed owner with the
 *      DEPARTED state, name reclaim at node_id, live-tank heirs, and
 *      the fire-rule self-correction. Its fire violations are exactly
 *      the times that correction triggers.
 *   N  person-keyed, the base study's model verbatim: a pickup or plant
 *      is owned by the actor's NAME; a quit (announced or implicit) or
 *      leave by the owner hands his GROUNDED pills to the heir's name
 *      (lowest-slot name-ally, live tank on a quit, none on a leave;
 *      carried pills stay his); with no heir the name keeps them,
 *      hostile to all while absent. No self-correction: if the model is
 *      right, none is needed.
 *
 * Drenched-in-fire pills log dozens of events, so violations are counted
 * both raw and as distinct log:pill:actor pairs. Names are compared but
 * never printed; samples show N's owner as the slot its name resolves
 * to, or "absent".
 *
 * Usage: node tools/measure-pill-owner.cjs [file | directory]
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
const MODELS = ["V", "N"];

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

function mutual_ally(state, a, b) {
	return !(state.alliances[a] & (1 << b)) && !(state.alliances[b] & (1 << a));
}

/* The person-keyed alliance store, as in measure-base-owner.cjs. */
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
	logs: 0, fires: 0, pickups: 0, repairs: 0,
	pickups_dead: 0, repairs_dead: 0,
	violations: {},
	samples: [],
};
for (let m of MODELS) {
	totals.violations[m] = {
		fire: 0, fire_graced: 0, fire_pairs: new Set(),
		pickup: 0, repair: 0, mend_pairs: new Set(),
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

	/* N's shadow: each pill's owning name, or NEUTRAL; carried state and
	 * armour are the viewer's, shared ground truth */
	let n_owner = [];
	let reset_shadow = (items) => {
		n_owner = items.map(p => {
			let slot = p.armour === 0xff ? (p.owner & 0x0f) : p.owner;
			if (slot > 15) return NEUTRAL;
			return state.names[slot] !== null ? state.names[slot] : NEUTRAL;
		});
	};
	reset_shadow(state.pills.map(p => ({ owner: p.inTank !== null ? p.inTank : p.owner, armour: p.inTank !== null ? 0xff : p.armour })));

	let quit_time = new Array(16).fill(-Infinity);
	let ghost_active = new Array(16).fill(false);
	let na = make_name_allies();
	let name_slot = (name) => {
		if (name === null || name === NEUTRAL) return -1;
		for (let i = 0; i < 16; i++) {
			if ((!state.quit[i] || ghost_active[i]) && state.names[i] === name) return i;
		}
		return -1;
	};
	let friendly_n = (owner_name, player) => {
		if (owner_name === NEUTRAL) return false;
		let s = name_slot(owner_name);
		if (s < 0) return false;
		if (s === player) return true;
		return na.allied(owner_name, state.names[player]);
	};
	let friendly_v = (owner, player) => {
		if (owner === NEUTRAL || owner === DEPARTED) return false;
		if (owner === player) return true;
		return mutual_ally(state, owner, player);
	};
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
	/* hand over the name's GROUNDED pills; carried ones stay his */
	let hand_over_n = (owner_name, heir) => {
		if (owner_name === null || heir === null) return;
		for (let i = 0; i < n_owner.length; i++) {
			if (n_owner[i] === owner_name && state.pills[i] && state.pills[i].inTank === null)
				n_owner[i] = heir;
		}
	};

	for (let rec of recs) {
		let pl = rec.player;
		if (state.quit[pl] && rec.time - quit_time[pl] >= TPS) ghost_active[pl] = true;
		for (let sub of rec.subpackets) {
			switch (sub.type) {
			case "pillbox_list":
				reset_shadow(sub.items);
				break;
			case "game_info":
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
			case "alliance_leave":
				last_alliance_event = rec.time;
				hand_over_n(state.names[pl], heir_name(state.names[pl], false));
				na.sever(state.names[pl]);
				break;
			case "quit":
				quit_time[pl] = rec.time;
				ghost_active[pl] = false;
				hand_over_n(state.names[pl], heir_name(state.names[pl], true));
				break;
			case "node_id": {
				ghost_active[pl] = false;
				let joining = state.quit[pl] || (node_joins && node_joins.has(rec));
				if (!joining) {
					if (state.names[pl] !== null && state.names[pl] !== sub.name) {
						for (let i = 0; i < n_owner.length; i++) {
							if (n_owner[i] === state.names[pl]) n_owner[i] = sub.name;
						}
						na.rename(state.names[pl], sub.name);
					}
					break;
				}
				if (state.names[pl] !== null && state.names[pl] !== sub.name) {
					hand_over_n(state.names[pl], heir_name(state.names[pl], true));
				}
				break;
			}
			case "pill_pickup":
			case "pill_repair_4":
			case "pill_repair_8":
			case "pill_repair_12":
			case "pill_repair_full":
			case "pillbox_fires": {
				let b = sub.pillbox;
				let p = state.pills[b];
				if (!p || p.inTank !== null) {
					if (sub.type === "pill_pickup" && b < n_owner.length) n_owner[b] = state.names[pl] !== null ? state.names[pl] : NEUTRAL;
					break;
				}
				let is_fire = sub.type === "pillbox_fires";
				let is_pickup = sub.type === "pill_pickup";
				let dead = p.armour === 0;
				if (is_fire) totals.fires++;
				else if (is_pickup) { totals.pickups++; if (dead) totals.pickups_dead++; }
				else { totals.repairs++; if (dead) totals.repairs_dead++; }
				let graced = rec.time - last_alliance_event <= TPS;
				let skip_fire = is_fire && sub.direction === 0 && (b & 1);
				let n_slot = n_owner[b] === NEUTRAL ? -2 : name_slot(n_owner[b]);
				let bad_models = [];
				for (let m of MODELS) {
					let fr = m === "V" ? friendly_v(p.owner, pl) : friendly_n(n_owner[b], pl);
					let v = totals.violations[m];
					if (is_fire) {
						if (fr && !skip_fire) {
							bad_models.push(m);
							graced ? v.fire_graced++ : v.fire++;
							v.fire_pairs.add(`${label}:${b}:${pl}`);
						}
					} else if (!fr && !dead) {
						if (is_pickup) {
							/* a live pill fetched by a stranger: never
							 * seen, kept as an invariant check */
							bad_models.push(m);
							v.pickup++;
						} else {
							/* census only: hostile-pill repairs are
							 * denial play and misclicks, not evidence */
							v.repair++;
						}
						v.mend_pairs.add(`${label}:${b}:${pl}`);
					}
				}
				if (bad_models.length && bad_models.length < MODELS.length &&
					totals.samples.length < SAMPLE_CASES && sampled_here < SAMPLE_PER_LOG) {
					sampled_here++;
					let vo = p.owner === NEUTRAL ? "neutral" : p.owner === DEPARTED ? "departed" : String(p.owner);
					let no = n_owner[b] === NEUTRAL ? "neutral" : n_slot < 0 ? "absent" : `@${n_slot}`;
					totals.samples.push(`${label} t${rec.time} ${sub.type} pill ${b} by p${pl}` +
						`${graced ? " (graced)" : ""}${dead ? " (dead)" : ""}: owners V/N = ${vo}/${no}` +
						`, wrong under ${bad_models.join(",")}`);
				}
				if (is_pickup && b < n_owner.length) {
					n_owner[b] = state.names[pl] !== null ? state.names[pl] : NEUTRAL;
				}
				break;
			}
			case "pill_plant": {
				/* the plant consumes the actor's lowest carried pill; under
				 * N it comes up owned by his name */
				for (let i = 0; i < state.pills.length; i++) {
					if (state.pills[i].inTank === pl) {
						n_owner[i] = state.names[pl] !== null ? state.names[pl] : NEUTRAL;
						break;
					}
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
console.log(`${totals.logs} logs, ${totals.fires.toLocaleString()} grounded-pill fires, ` +
	`${totals.pickups.toLocaleString()} pickups (${totals.pickups_dead.toLocaleString()} of dead pills), ` +
	`${totals.repairs.toLocaleString()} repairs (${totals.repairs_dead.toLocaleString()} of dead pills)`);
console.log();
console.log("Per model: fire-at-friendly and live-pickup are VIOLATIONS (~0 for");
console.log("  the correct model; V's fire count is exactly its self-correction");
console.log("  rule's trigger count, and no live pickup has ever been seen);");
console.log("  graced = within a second of an alliance event. hostile-repairs is");
console.log("  a CENSUS, not evidence: repairing never captures and is not");
console.log("  restricted to one's own side (neutral pills are repaired to deny");
console.log("  the enemy a capture, enemy pills by misclick). pairs = distinct");
console.log("  log:pill:actor.");
console.log();
console.log(`    ${"model".padStart(5)} ${"fires".padStart(7)} ${"graced".padStart(7)} ${"pairs".padStart(6)} ` +
	`${"live-pickups".padStart(13)} ${"hostile-repairs".padStart(16)} ${"pairs".padStart(6)}`);
for (let m of MODELS) {
	let v = totals.violations[m];
	console.log(`    ${m.padStart(5)} ${String(v.fire).padStart(7)} ${String(v.fire_graced).padStart(7)} ` +
		`${String(v.fire_pairs.size).padStart(6)} ${String(v.pickup).padStart(13)} ` +
		`${String(v.repair).padStart(16)} ${String(v.mend_pairs.size).padStart(6)}`);
}
if (totals.samples.length) {
	console.log();
	console.log("Cases separating the models (capped; N's owner shown as @slot or absent):");
	for (let line of totals.samples) console.log(`    ${line}`);
}
console.log("======================================================================");
