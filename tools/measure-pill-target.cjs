#!/usr/bin/env node
/* Which machine simulates a pillbox's shot, and why that one?
 *
 * Pill shells ride in the shell lists of the machine simulating the pill
 * ([E:pill-shell-migration]), and the `F4 nd` naming the fire rides in
 * that machine's record. The reading tested here: every machine checks
 * whether ITS OWN tank is the pill's target, and simulates the shots the
 * pill fires at it. Bolo's pill targets the nearest hostile tank in range,
 * so two things must hold for a fire reported by sender S:
 *
 *   1. S's tank is the nearest hostile tank to the pill, whenever more
 *      than one hostile tank is in range (the contested cases are the
 *      test; a lone tank in range says nothing).
 *   2. The fire's direction nibble points at S's tank, not at anyone
 *      else's.
 *
 * Distances are pixel distances from the pill's centre to each tank's
 * centre, using each player's latest restated position. A rival that
 * beats S by less than a tile or so may simply be a stale position, so
 * the losses are bucketed by margin. Hostile means the pill is neutral,
 * or its owner is not allied with the tank's player. The parity rule for
 * direction-0 fires ([E:pill-fire-index]) resolves the named pill.
 *
 * Usage: node tools/measure-pill-target.cjs [file | directory]
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
const RANGE_PX = 136;       /* 8.5 tiles: a pill shell's full flight */
const ALIVE_TICKS = 250;    /* a tank unheard of for 5 s is not a target */
const MARGIN_BUCKETS = [8, 16, 32, 64];
const RECENT_TICKS = 100;   /* a hit or an ownership change this recent may explain a fire at an ally */
const TOUCH_PX = 24;        /* tank centre to pill centre when the tank is against the pill */
const SAMPLE_CASES = 24;    /* allied-sender fires listed for reading */

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

function tank_centre(t) {
	return {x: t.x * 16 + t.px + 8, y: t.y * 16 + t.py + 8};
}

/* 0 = north, clockwise, 16 coarse sectors, round-to-nearest like the
 * direction nibble itself ([E:pill-fire-index]). */
function coarse_bearing(from_x, from_y, to_x, to_y) {
	let angle = Math.atan2(to_x - from_x, -(to_y - from_y));
	let bradian = Math.round(angle * 128 / Math.PI) & 0xff;
	return ((bradian + 8) >> 4) & 15;
}

function sector_gap(a, b) {
	let d = Math.abs(a - b) & 15;
	return Math.min(d, 16 - d);
}

function hostile(state, pill, player) {
	if (pill.owner === NEUTRAL) return true;
	if (pill.owner === BoloGame.DEPARTED) return true;
	if (pill.owner === player) return false;
	return (state.alliances[pill.owner] & (1 << player)) !== 0;
}

/* The lowest slot the quitter's alliance names, counting the model's
 * alliance word and the quitter's last standing request alike, and
 * whether that slot's player had already quit. Two replays in which a
 * quitter's pills fired at the live heir the viewer picked both had such
 * a slot: a game that hands property to the lowest allied slot without
 * asking whether anyone is there would leave those pills nobody's. */
function lowest_named_slot(state, quitter, request_mask) {
	for (let j = 0; j < 16; j++) {
		if (j === quitter) continue;
		let in_word = state.names[j] !== null && !(state.alliances[quitter] & (1 << j));
		let in_request = (request_mask & (1 << j)) !== 0;
		if (!in_word && !in_request) continue;
		return {slot: j, source: in_word ? "word" : "request",
			departed: state.quit[j] || state.names[j] === null};
	}
	return null;
}

const totals = {
	logs: 0, fires: 0, resolved_to_lower: 0, pair_ambiguous: 0,
	pill_unresolved: 0, pill_dead: 0,
	sender_no_tank: 0, sender_not_hostile: 0, sender_out_of_range: 0,
	lone: 0, contested: 0, sender_nearest: 0, sender_nearest_visible: 0,
	not_hostile_parity_shaped: 0, not_hostile_own_pill: 0,
	not_hostile_hit_by_sender: 0, not_hostile_owner_changed: 0,
	sender_hidden: 0, sender_is_target: 0,
	not_hostile_orphaned: 0, orphan_fires: 0, orphan_at_old_ally: 0, orphan_at_old_enemy: 0, orphan_at_newcomer: 0,
	/* would handing a quitter's pills to an ally (as alliance-leave does) cover it? */
	quits_with_pills: 0, quits_with_heir: 0, quits_owner_returned: 0,
	orphan_fires_heir: 0, orphan_fires_no_heir_returned: 0, orphan_fires_no_heir_gone: 0,
	not_hostile_orphan_heir: 0,
	/* was the quitter's tank dead (T=7) at the quit? a dead quit may not hand over */
	quits_dead: 0, quits_alive: 0,
	/* was the heir (the lowest-index remaining ally) alive, with a tank, at
	 * the hand-over? a dead ally may not be able to receive */
	quits_heir_alive: 0, quits_heir_dead: 0,
	orphan_fires_heir_alive: 0, orphan_fires_heir_dead: 0,
	orphan_at_old_ally_heir_alive: 0, orphan_at_old_ally_heir_dead: 0,
	/* the viewer's own correction: pills the model made nobody's because
	 * they fired at a player it held friendly (counted from the state
	 * change, so it is the rule's real trigger count, not the tool's) */
	rule_triggers: 0, rule_trigger_sample: [],
	/* the sender's tank beyond a shell's flight of the pill: how far, how
	 * stale its position, and whether a nearer hostile pill fits the nibble */
	out_of_range_by_distance: [0, 0, 0, 0],   /* 137-160, 161-200, 201-300, over 300 px */
	out_of_range_stale: 0, out_of_range_other_pill: 0, out_of_range_sample: [],
	/* a pill that measures range per axis (in squares) fires into the corners
	 * of a box the circle rejects: the larger axis distance of each such fire */
	out_of_range_axis: [0, 0, 0, 0],   /* max(|dx|,|dy|) <= 136, <= 152, <= 168, over */
	orphan_at_old_ally_dead_quit: 0, orphan_at_old_ally_alive_quit: 0,
	/* one entry per quit that left grounded pills: who the pills fired at
	 * afterwards, against several candidate heirs (see the report) */
	windows: [],
	/* one entry per alliance leave that handed grounded pills to the
	 * lowest mutual ally: who those pills fired at afterwards */
	leave_windows: [],
	orphan_fires_dead_quit: 0, orphan_fires_alive_quit: 0,
	not_hostile_initial_ally: 0, not_hostile_direct_ally: 0, not_hostile_clique_ally: 0,
	touching: 0, touching_facing: 0, apart_facing: 0, aim_neither_touching_facing: 0,
	sample: [],
	trace: null,          /* alliance events of the replay with the most allied-sender fires */
	/* deflection: signed nibble deviation from the bearing to the sender,
	 * by whether the sender's tank is moving and which way across the line */
	lead: {still: [0, 0, 0, 0], toward: [0, 0, 0, 0], against: [0, 0, 0, 0]},
	lost_by_bucket: MARGIN_BUCKETS.map(() => 0).concat([0]),
	lost_to_hidden: 0, lost_to_staler: 0,
	random_expectation: 0,
	aim_at_sender: 0, aim_at_sender_pm1: 0, aim_at_rival: 0, aim_neither: 0,
	aim_cases: 0,
};

function scan(file) {
	let recs;
	try {
		recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(file)))];
	} catch {
		return;
	}
	if (!recs.length) return;
	totals.logs++;
	/* the viewer's join classification: a slot re-entered by a T=7 roster
	 * burst is a new player who inherits none of the old occupant's
	 * alliances; without it a stale alliance survives a netsplit and the
	 * clique merge later spreads it to everyone */
	let node_joins = BoloGame.classify_node_joins(recs);
	let state = BoloGame.initial_state(BoloGame.extract_initial_map(recs, node_joins));
	/* [sender][pill] -> time of the last 9n the sender's own records carried
	 * for that pill; [pill] -> time the model last changed its owner */
	let last_hit = Array.from({length: 16}, () => new Array(16).fill(-Infinity));
	let last_owner_change = new Array(16).fill(-Infinity);
	/* a pill whose owner slot has quit since the pill got that owner. The
	 * model keeps the stale slot as owner; the game keeps the pill with
	 * the owner's alliance, which can only be followed across a slot
	 * shuffle by player NAME, so the names of the owner's allies (and the
	 * owner) as of the quit are frozen here and compared, never printed */
	let orphaned = new Array(16).fill(null);
	/* a pill the model handed from an alliance leaver to the lowest
	 * mutual ally, until it next changes hands */
	let left = new Array(16).fill(null);
	let file_windows = [];
	/* how the model came to hold two players allied: from the game-info
	 * words, from an accept event between the two, or only by the clique
	 * merge an accept with a third party implies */
	let initial_ally = Array.from({length: 16}, () => new Array(16).fill(false));
	let direct_ally = Array.from({length: 16}, () => new Array(16).fill(false));
	let label = replay_label(file);
	/* each player's previous restated position, for a velocity estimate */
	let prev_position = new Array(16).fill(null);
	let alliance_events = [];
	let sampled_here = 0;
	let last_alliance_event = -Infinity;   /* tick of the last request, accept or leave */
	/* each slot's last alliance request still standing: cleared by its
	 * leave, its quit, or a join installing a new person in the slot */
	let last_request = new Array(16).fill(0);

	for (let rec of recs) {
		for (let sub of rec.subpackets) {
			if (sub.type === "pillbox_damage") last_hit[rec.player][sub.pillbox] = rec.time;
			if (sub.type === "game_info") {
				for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
					initial_ally[a][b] = a !== b && !(sub.alliances[a] & (1 << b));
				}
			}
			if (sub.type === "alliance_accept") {
				for (let i = 0; i < 16; i++) {
					if (i !== rec.player && (sub.tanks & (1 << i))) {
						direct_ally[rec.player][i] = direct_ally[i][rec.player] = true;
					}
				}
			}
			if (sub.type === "game_info") {
				alliance_events.push(`rec ${recs.indexOf(rec)} t${rec.time} game info alliance words: ` +
					sub.alliances.map((w, i) => `${i}:${(w & 0xffff).toString(16).padStart(4, "0")}`).join(" "));
			}
			if (sub.type === "quit" || (sub.type === "node_id" && (node_joins.has(rec) || state.quit[rec.player]))) {
				alliance_events.push(`rec ${recs.indexOf(rec)} t${rec.time} p${rec.player} ${sub.type === "quit" ? "quit" : "join"}` +
					` (T=${rec.tankStatus.toString(16)}) model-before: ` +
					[...Array(16).keys()].filter(i => state.present[i] || state.names[i] !== null)
						.map(i => `${i}=${(state.alliances[i] & 0xffff).toString(16).padStart(4, "0")}`).join(" ") +
					`; pill owners ${state.pills.map(p => p.owner).join(",")}`);
			}
			if (sub.type === "node_id" && rec.tankStatus === 0x07 && !node_joins.has(rec) && !state.quit[rec.player]) {
				alliance_events.push(`rec ${recs.indexOf(rec)} t${rec.time} p${rec.player} T=7 node_id NOT classified as a join`);
			}
			if (sub.type === "alliance_request") last_request[rec.player] = sub.tanks;
			if (sub.type === "alliance_leave") {
				/* the viewer's leave rule: grounded pills to the lowest
				 * mutual ally still in the game, tank or no tank */
				let leaver = rec.player;
				let heir = -1;
				for (let j = 0; j < 16 && heir < 0; j++) {
					let mutual = j !== leaver && !(state.alliances[leaver] & (1 << j)) && !(state.alliances[j] & (1 << leaver));
					if (mutual && !state.quit[j] && (state.present[j] || state.names[j] !== null)) heir = j;
				}
				let pills = [];
				state.pills.forEach((p, k) => { if (p.owner === leaver && p.inTank === null) pills.push(k); });
				if (heir >= 0 && pills.length) {
					let allies = new Set(), others = new Set();
					for (let j = 0; j < 16; j++) {
						if (state.names[j] === null) continue;
						if (j === leaver || !(state.alliances[leaver] & (1 << j))) allies.add(state.names[j]);
						else others.add(state.names[j]);
					}
					let window = {heir_name: state.names[heir], named: lowest_named_slot(state, leaver, last_request[leaver]),
						allies, others, fires: {}};
					totals.leave_windows.push(window);
					for (let k of pills) left[k] = {window, since: rec};
				}
				last_request[rec.player] = 0;
			}
			if (sub.type === "node_id" && node_joins.has(rec)) last_request[rec.player] = 0;
			if (sub.type === "alliance_request" || sub.type === "alliance_accept" || sub.type === "alliance_leave") {
				last_alliance_event = rec.time;
				alliance_events.push(`rec ${recs.indexOf(rec)} t${rec.time} p${rec.player} ${sub.type}` +
					(sub.tanks !== undefined ? ` bits ${sub.tanks.toString(16).padStart(4, "0")} [${
						[...Array(16).keys()].filter(i => sub.tanks & (1 << i)).join(",")}]` : "") +
					` model-before: ` + [...Array(16).keys()].filter(i => state.present[i] || state.names[i] !== null)
						.map(i => `${i}=${(state.alliances[i] & 0xffff).toString(16).padStart(4, "0")}`).join(" "));
			}
			if (sub.type === "alliance_leave") {
				for (let i = 0; i < 16; i++) {
					direct_ally[rec.player][i] = direct_ally[i][rec.player] = false;
					initial_ally[rec.player][i] = initial_ally[i][rec.player] = false;
				}
			}
		}
		for (let sub of rec.subpackets) {
			if (sub.type !== "pillbox_fires") continue;
			totals.fires++;
			let sender = rec.player;

			let tanks = [];
			for (let i = 0; i < 16; i++) {
				let t = state.tanks[i];
				if (!t || state.quit[i] || t.dead || t.dying) continue;
				if (rec.time - t.lastSeen > ALIVE_TICKS) continue;
				let c = tank_centre(t);
				tanks.push({player: i, x: c.x, y: c.y, hidden: !!t.hidden,
					position_time: t.position_time});
			}
			let me = tanks.find(t => t.player === sender);

			/* Which pill fired. An odd index at direction 0 may be one too
			 * high ([E:pill-fire-index]); the firer must be grounded, hostile
			 * to the sender and within a shell's flight of the sender's tank,
			 * which almost always singles out one of the pair. */
			let pill = state.pills[sub.pillbox];
			if (sub.direction === 0 && (sub.pillbox & 1)) {
				let lower = state.pills[sub.pillbox - 1];
				let fits = p => p && p.inTank === null && me && hostile(state, p, sender) &&
					Math.hypot(p.x * 16 + 8 - me.x, p.y * 16 + 8 - me.y) <= RANGE_PX;
				let named_fits = fits(pill), lower_fits = fits(lower);
				if (lower_fits && !named_fits) {
					pill = lower;
					totals.resolved_to_lower++;
				} else if (lower_fits && named_fits) {
					totals.pair_ambiguous++;
				} else if (!pill || pill.inTank !== null) {
					if (lower && lower.inTank === null) pill = lower;
				}
			}
			if (!pill || pill.inTank !== null) {
				totals.pill_unresolved++;
				continue;
			}
			if (pill.armour === 0) {
				totals.pill_dead++;
				continue;
			}
			let pill_x = pill.x * 16 + 8;
			let pill_y = pill.y * 16 + 8;
			for (let t of tanks) {
				t.distance = Math.hypot(t.x - pill_x, t.y - pill_y);
				t.hostile = hostile(state, pill, t.player);
			}
			if (!me) {
				totals.sender_no_tank++;
				continue;
			}
			{
				let pill_index = state.pills.indexOf(pill);
				let frozen = orphaned[pill_index];
				if (frozen && pill.owner !== NEUTRAL && me.distance <= RANGE_PX) {
					totals.orphan_fires++;
					let name = state.names[sender];
					frozen.window.fires[name] = (frozen.window.fires[name] || 0) + 1;
					if (frozen.allies.has(name)) totals.orphan_at_old_ally++;
					else if (frozen.others.has(name)) totals.orphan_at_old_enemy++;
					else totals.orphan_at_newcomer++;
					if (frozen.dead_quit) totals.orphan_fires_dead_quit++; else totals.orphan_fires_alive_quit++;
					if (frozen.heir) {
						if (frozen.heir_alive) totals.orphan_fires_heir_alive++; else totals.orphan_fires_heir_dead++;
						if (frozen.allies.has(name)) {
							if (frozen.heir_alive) totals.orphan_at_old_ally_heir_alive++; else totals.orphan_at_old_ally_heir_dead++;
						}
					}
					if (frozen.allies.has(name)) {
						if (frozen.dead_quit) totals.orphan_at_old_ally_dead_quit++; else totals.orphan_at_old_ally_alive_quit++;
					}
					if (frozen.heir) totals.orphan_fires_heir++;
					else if (frozen.returned) totals.orphan_fires_no_heir_returned++;
					else totals.orphan_fires_no_heir_gone++;
				}
			}
			{
				let l = left[state.pills.indexOf(pill)];
				if (l && pill.owner !== NEUTRAL && me.distance <= RANGE_PX) {
					let name = state.names[sender];
					l.window.fires[name] = (l.window.fires[name] || 0) + 1;
				}
			}
			if (!me.hostile) {
				totals.sender_not_hostile++;
				if (sub.direction === 0 && (sub.pillbox & 1)) totals.not_hostile_parity_shaped++;
				if (pill.owner === sender) totals.not_hostile_own_pill++;
				let pill_index = state.pills.indexOf(pill);
				if (rec.time - last_hit[sender][pill_index] <= RECENT_TICKS) totals.not_hostile_hit_by_sender++;
				if (rec.time - last_owner_change[pill_index] <= RECENT_TICKS) totals.not_hostile_owner_changed++;
				if (orphaned[pill_index]) { totals.not_hostile_orphaned++; if (orphaned[pill_index].heir) totals.not_hostile_orphan_heir++; }
				let provenance = orphaned[pill_index] ? "orphan" : pill.owner === sender ? "own"
					: pill.owner > 15 ? "departed"
					: initial_ally[sender][pill.owner] ? "initial"
					: direct_ally[sender][pill.owner] ? "direct" : "clique";
				if (provenance === "initial") totals.not_hostile_initial_ally++;
				else if (provenance === "direct") totals.not_hostile_direct_ally++;
				else if (provenance === "clique") totals.not_hostile_clique_ally++;
				sampled_here++;
				if (totals.sample.length < SAMPLE_CASES) {
					/* two readings for a case that is not the index fault
					 * and not an orphan: an alliance event just before it
					 * (model timing), or a hostile grounded pill in range
					 * lying along the direction nibble (a misnamed index) */
					let along = [];
					state.pills.forEach((q, k) => {
						if (k === pill_index || q.inTank !== null || q.armour === 0 || !hostile(state, q, sender)) return;
						let qx = q.x * 16 + 8, qy = q.y * 16 + 8;
						if (Math.hypot(qx - me.x, qy - me.y) > RANGE_PX) return;
						if (sector_gap(sub.direction, coarse_bearing(qx, qy, me.x, me.y)) <= 1) along.push(k);
					});
					totals.sample.push(`${label} rec ${recs.indexOf(rec)} t${rec.time} sender ${sender} pill ${pill_index} owner ${pill.owner} ` +
						`ally:${provenance} dir ${sub.direction} facing ${rec.tankDir} dist ${me.distance.toFixed(0)}px ` +
						`hit-by-sender ${rec.time - last_hit[sender][pill_index] <= RECENT_TICKS ? "yes" : "no"}` +
						` last-alliance-event ${Number.isFinite(last_alliance_event) ? `${rec.time - last_alliance_event} ticks ago` : "never"}` +
						` hostile-pills-along-nibble [${along.join(",")}]`);
				}
				continue;
			}
			if (me.distance > RANGE_PX) {
				totals.sender_out_of_range++;
				let d = me.distance;
				totals.out_of_range_by_distance[d <= 160 ? 0 : d <= 200 ? 1 : d <= 300 ? 2 : 3]++;
				let stale = rec.time - me.position_time;
				if (stale > 50) totals.out_of_range_stale++;
				let axis = Math.max(Math.abs(me.x - pill_x), Math.abs(me.y - pill_y));
				totals.out_of_range_axis[axis <= 136 ? 0 : axis <= 152 ? 1 : axis <= 168 ? 2 : 3]++;
				let others = [];
				state.pills.forEach((q, k) => {
					if (q === pill || q.inTank !== null || q.armour === 0 || !hostile(state, q, sender)) return;
					let qx = q.x * 16 + 8, qy = q.y * 16 + 8;
					if (Math.hypot(qx - me.x, qy - me.y) > RANGE_PX) return;
					if (sector_gap(sub.direction, coarse_bearing(qx, qy, me.x, me.y)) <= 1) others.push(k);
				});
				if (others.length) totals.out_of_range_other_pill++;
				if (totals.out_of_range_sample.length < 12) {
					totals.out_of_range_sample.push(`${label} rec ${recs.indexOf(rec)} t${rec.time} sender ${sender} pill ${state.pills.indexOf(pill)} ` +
						`dir ${sub.direction} dist ${d.toFixed(0)}px axis ${axis.toFixed(0)}px position ${stale} ticks old hostile-pills-in-range-along-nibble [${others.join(",")}]`);
				}
				continue;
			}

			let rivals = tanks.filter(t => t.hostile && t.player !== sender &&
				t.distance <= RANGE_PX);
			/* from here the sender is taken to be the target; if a pill
			 * cannot target a tank hidden in forest, it is never hidden here */
			totals.sender_is_target++;
			if (me.hidden) totals.sender_hidden++;
			/* deflection shooting: does the nibble lead a moving target? The
			 * bearing is from the pill to the tank; the deviation's sign is
			 * compared with the sign of the tank's velocity across that line */
			{
				let tank = state.tanks[sender];
				let prev = prev_position[sender];
				let bearing_bradian = Math.atan2(me.x - pill_x, -(me.y - pill_y)) * 128 / Math.PI;
				let deviation = ((sub.direction * 16 - Math.round(bearing_bradian)) + 128 & 0xff) - 128;
				/* sectors, signed: positive = clockwise of the bearing */
				let sectors = Math.max(-8, Math.min(7, Math.round(deviation / 16)));
				let magnitude = Math.min(3, Math.abs(sectors));
				let moving = prev && tank.position_time > prev.time &&
					(prev.x !== me.x || prev.y !== me.y);
				if (!moving) totals.lead.still[magnitude]++;
				else if (sectors === 0) { totals.lead.toward[0]++; }
				else {
					/* cross product of the bearing and the velocity: positive
					 * when the tank moves clockwise around the pill */
					let bx = me.x - pill_x, by = me.y - pill_y;
					let vx = me.x - prev.x, vy = me.y - prev.y;
					let cross = bx * vy - by * vx;
					if (cross === 0) totals.lead.still[magnitude]++;
					else if ((cross > 0) === (sectors > 0)) totals.lead.toward[magnitude]++;
					else totals.lead.against[magnitude]++;
				}
			}
			/* "massaging": a tank against a hostile pill, creeping along its
			 * edge, makes the pill fire in the tank's own facing direction */
			let touching = me.distance <= TOUCH_PX;
			let facing = sub.direction === rec.tankDir;
			if (touching) totals.touching++;
			if (touching && facing) totals.touching_facing++;
			else if (!touching && facing) totals.apart_facing++;
			if (!rivals.length) {
				totals.lone++;
				continue;
			}
			totals.contested++;
			totals.random_expectation += 1 / (rivals.length + 1);
			let nearest_rival = rivals.reduce((a, b) => a.distance < b.distance ? a : b);
			/* a tank hidden in forest may be no target at all: rank the
			 * sender among the visible rivals too */
			if (rivals.every(t => t.hidden || me.distance <= t.distance)) {
				totals.sender_nearest_visible++;
			}
			if (me.distance <= nearest_rival.distance) {
				totals.sender_nearest++;
			} else {
				let margin = me.distance - nearest_rival.distance;
				let bucket = MARGIN_BUCKETS.findIndex(limit => margin <= limit);
				totals.lost_by_bucket[bucket < 0 ? MARGIN_BUCKETS.length : bucket]++;
				if (nearest_rival.hidden) totals.lost_to_hidden++;
				if (nearest_rival.position_time < me.position_time) totals.lost_to_staler++;
			}

			/* aim: whose tank does the direction nibble point at? */
			let at_me = sector_gap(sub.direction, coarse_bearing(pill_x, pill_y, me.x, me.y));
			let at_rival = sector_gap(sub.direction,
				coarse_bearing(pill_x, pill_y, nearest_rival.x, nearest_rival.y));
			totals.aim_cases++;
			if (at_me === 0) totals.aim_at_sender++;
			else if (at_me === 1 && at_rival > 1) totals.aim_at_sender_pm1++;
			else if (at_rival <= 1 && at_me > 1) totals.aim_at_rival++;
			else {
				totals.aim_neither++;
				if (touching && facing) totals.aim_neither_touching_facing++;
			}
		}
		if (sampled_here && (!totals.trace || totals.trace.label === label || sampled_here > totals.trace.count)) {
			totals.trace = {label, events: alliance_events, last_record: recs.indexOf(rec), count: sampled_here};
		}
		let owners_before = state.pills.map(p => p.owner);
		let has_fire = rec.subpackets.some(s => s.type === "pillbox_fires");
		let quit_before = state.quit.slice();
		let position_before = state.tanks[rec.player] && state.tanks[rec.player].position_time;
		BoloGame.apply_record(state, rec, null, null, null, node_joins);
		for (let sub of rec.subpackets) {
			if (sub.type === "node_id" && (node_joins.has(rec) || quit_before[rec.player])) {
				for (let k = 0; k < state.pills.length; k++) {
					let o = orphaned[k];
					if (o && !o.returned && o.owner_name === sub.name) { o.returned = true; totals.quits_owner_returned++; }
				}
				for (let w of file_windows) {
					if (w.slot === rec.player && w.candidates.slot_taker === null && sub.name !== w.owner_name) w.candidates.slot_taker = sub.name;
				}
			}
		}
		for (let i = 0; i < 16; i++) {
			if (state.quit[i] && !quit_before[i]) {
				let allies = new Set(), others = new Set();
				let heir = false, heir_alive = null;
				for (let j = 0; j < 16; j++) {
					if (state.names[j] === null) continue;
					if (j === i || !(state.alliances[i] & (1 << j))) allies.add(state.names[j]);
					else others.add(state.names[j]);
					/* an ally still in the game at the quit: the lowest-index
					 * remaining mutual ally the leave rule would pick */
					if (!heir && j !== i && !state.quit[j] && !(state.alliances[i] & (1 << j)) && !(state.alliances[j] & (1 << i))) {
						heir = true;
						let t = state.tanks[j];
						heir_alive = !!(t && !t.dead && !t.dying && rec.time - t.lastSeen <= ALIVE_TICKS);
					}
				}
				let dead_quit = rec.player === i && rec.tankStatus === 0x07;
				/* candidate heirs for the "who really gets them" question:
				 * the next mutual ally with a live tank (the viewer's pick),
				 * the lowest-index live tank on the other side, the
				 * lowest-index live tank of anyone, the lowest-index player
				 * present at all, and whoever next takes the quitter's slot */
				let live = j => { let t = state.tanks[j]; return !!(t && !t.dead && !t.dying && rec.time - t.lastSeen <= ALIVE_TICKS); };
				let candidates = {next_live_ally: null, lowest_live_enemy: null, lowest_live_any: null, lowest_present_any: null, slot_taker: null};
				for (let j = 0; j < 16; j++) {
					if (j === i || state.names[j] === null || state.quit[j]) continue;
					let mutual = !(state.alliances[i] & (1 << j)) && !(state.alliances[j] & (1 << i));
					if (candidates.lowest_present_any === null) candidates.lowest_present_any = state.names[j];
					if (!live(j)) continue;
					if (candidates.lowest_live_any === null) candidates.lowest_live_any = state.names[j];
					if (mutual && candidates.next_live_ally === null) candidates.next_live_ally = state.names[j];
					if (!mutual && candidates.lowest_live_enemy === null) candidates.lowest_live_enemy = state.names[j];
				}
				let heir_state = heir && heir_alive ? "lowest ally live" : candidates.next_live_ally !== null ? "another ally live" : "no ally live";
				let named = lowest_named_slot(state, i, last_request[i]);
				last_request[i] = 0;
				let window = {slot: i, owner_name: state.names[i], heir_state, candidates, allies, others, fires: {}, named};
				if (state.pills.some((p, k) => owners_before[k] === i && p.inTank === null)) {
					file_windows.push(window);
					totals.windows.push(window);
					totals.quits_with_pills++;
					if (heir) totals.quits_with_heir++;
					if (heir) { if (heir_alive) totals.quits_heir_alive++; else totals.quits_heir_dead++; }
					if (dead_quit) totals.quits_dead++; else totals.quits_alive++;
				}
				for (let k = 0; k < state.pills.length; k++) {
					if (owners_before[k] === i && !orphaned[k]) orphaned[k] = {allies, others, owner_name: state.names[i], heir, heir_alive, returned: false, since: rec, dead_quit, window};
				}
			}
		}
		let after = state.tanks[rec.player];
		if (after && after.position_time !== position_before) {
			let c = tank_centre(after);
			if (!prev_position[rec.player] || prev_position[rec.player].time !== position_before) {
				prev_position[rec.player] = prev_position[rec.player] && position_before !== undefined
					? {x: prev_position[rec.player].next_x, y: prev_position[rec.player].next_y, time: position_before,
						next_x: c.x, next_y: c.y}
					: {x: c.x, y: c.y, time: after.position_time, next_x: c.x, next_y: c.y};
			}
		}
		if (has_fire) {
			for (let i = 0; i < state.pills.length; i++) {
				if (state.pills[i].owner === BoloGame.DEPARTED && owners_before[i] !== BoloGame.DEPARTED &&
					!rec.subpackets.some(s => s.type === "quit")) {
					totals.rule_triggers++;
					if (totals.rule_trigger_sample.length < 12) {
						totals.rule_trigger_sample.push(`${label} rec ${recs.indexOf(rec)} t${rec.time} sender ${rec.player} pill ${i} was owner ${owners_before[i]}`);
					}
				}
			}
		}
		for (let i = 0; i < state.pills.length; i++) {
			if (state.pills[i].owner !== owners_before[i]) {
				last_owner_change[i] = rec.time;
				if (!orphaned[i] || orphaned[i].since !== rec) orphaned[i] = null;
				if (!left[i] || left[i].since !== rec) left[i] = null;
			}
		}
	}
}

for (let file of walk(ROOT)) scan(file);

const pc = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
const n = v => v.toLocaleString();
console.log("======================================================================");
console.log(`${totals.logs} logs, ${n(totals.fires)} pill fires`);
console.log();
console.log("Direction-0 odd-index fires resolved to pill n-1 by hostility and range:");
console.log(`    ${n(totals.resolved_to_lower).padStart(9)}   (both pills fit in ${n(totals.pair_ambiguous)}; the named one is kept there)`);
console.log();
console.log("Fires set aside:");
console.log(`    pill unresolved (missing or carried)   ${n(totals.pill_unresolved).padStart(9)}`);
console.log(`    pill dead                              ${n(totals.pill_dead).padStart(9)}`);
console.log(`    sender has no live tank                ${n(totals.sender_no_tank).padStart(9)}`);
console.log(`    sender not hostile to the pill         ${n(totals.sender_not_hostile).padStart(9)}   (must be ~0; ${n(totals.not_hostile_parity_shaped)} of them direction 0 with an odd index)`);
console.log(`        of those: the sender's own pill ${n(totals.not_hostile_own_pill)}; the sender's own records carried a 9n for`);
console.log(`        that pill within ${RECENT_TICKS} ticks ${n(totals.not_hostile_hit_by_sender)}; the pill changed owner within ${RECENT_TICKS} ticks ${n(totals.not_hostile_owner_changed)}`);
console.log(`        the pill's owner slot had quit since the pill got that owner ("orphaned") in ${n(totals.not_hostile_orphaned)}`);
console.log(`        how the model holds them allied: from game info ${n(totals.not_hostile_initial_ally)}, an accept between the two ${n(totals.not_hostile_direct_ally)},`);
console.log(`        only the clique merge of a third party's accept ${n(totals.not_hostile_clique_ally)}`);
console.log(`    sender's tank out of range             ${n(totals.sender_out_of_range).padStart(9)}`);
console.log(`        by distance: 137-160 px ${n(totals.out_of_range_by_distance[0])}, 161-200 ${n(totals.out_of_range_by_distance[1])}, 201-300 ${n(totals.out_of_range_by_distance[2])}, over 300 ${n(totals.out_of_range_by_distance[3])};`);
console.log(`        sender's position over a second old ${n(totals.out_of_range_stale)}; a nearer hostile pill along the nibble ${n(totals.out_of_range_other_pill)}`);
console.log(`        by the larger axis distance: <= 136 px ${n(totals.out_of_range_axis[0])}, <= 152 ${n(totals.out_of_range_axis[1])}, <= 168 ${n(totals.out_of_range_axis[2])}, over ${n(totals.out_of_range_axis[3])}`);
console.log(`        (a box would put nearly all of them in the first bucket; a circle seen through stale positions spreads them)`);
console.log(`    sender the only hostile tank in range  ${n(totals.lone).padStart(9)}   (uninformative)`);
console.log();
console.log(`The viewer's fire rule (a pill firing at a player the model holds friendly becomes nobody's) triggered ${n(totals.rule_triggers)} times.`);
for (let line of totals.rule_trigger_sample) console.log(`    ${line}`);
console.log();
console.log(`Orphaned pills (owner slot quit since they got that owner) fired ${n(totals.orphan_fires)} times, by the target's NAME as of the quit:`);
console.log(`at a member of the owner's alliance then ${n(totals.orphan_at_old_ally)}, at anyone else present then ${n(totals.orphan_at_old_enemy)}, at a name not present then ${n(totals.orphan_at_newcomer)}.`);
console.log("(a pill that stays with its alliance never fires at the first group)");
console.log(`Quits leaving grounded pills: ${n(totals.quits_with_pills)}, with an ally still in the game to hand them to ${n(totals.quits_with_heir)};`);
console.log(`of those quits the tank was dead (T=7) at ${n(totals.quits_dead)} and alive at ${n(totals.quits_alive)}. Orphaned-pill fires after a dead quit ${n(totals.orphan_fires_dead_quit)},`);
console.log(`of which at a member of the owner's alliance ${n(totals.orphan_at_old_ally_dead_quit)}; after an alive quit ${n(totals.orphan_fires_alive_quit)}, at an ally ${n(totals.orphan_at_old_ally_alive_quit)}.`);
console.log(`Of the quits with an heir, the heir had a live tank at ${n(totals.quits_heir_alive)} and was dead or tankless at ${n(totals.quits_heir_dead)}. Orphaned-pill fires`);
console.log(`after a hand-over to a live heir ${n(totals.orphan_fires_heir_alive)}, at an ally ${n(totals.orphan_at_old_ally_heir_alive)}; to a dead heir ${n(totals.orphan_fires_heir_dead)}, at an ally ${n(totals.orphan_at_old_ally_heir_dead)}.`);
console.log(`the quitter's name rejoined later for ${n(totals.quits_owner_returned)} pills. Orphaned-pill fires by that: heir available ${n(totals.orphan_fires_heir)},`);
console.log(`no heir but owner returned ${n(totals.orphan_fires_no_heir_returned)}, no heir and owner gone ${n(totals.orphan_fires_no_heir_gone)};`);
console.log(`of the allied-sender fires from orphans, ${n(totals.not_hostile_orphan_heir)} had an heir available (a hand-over at quit would have caught those).`);
console.log();
{
	/* Who really inherits? For each quit that left grounded pills, the
	 * fires those pills made afterwards (until they changed hands again)
	 * are tallied by target name and set against candidate heirs. A
	 * candidate who really owns the pills is never fired at; a candidate
	 * who is fired at as often as anyone else does not own them. */
	const CANDIDATES = [
		["next_live_ally", "next mutual ally with a live tank"],
		["lowest_live_enemy", "lowest-index live tank, other side"],
		["lowest_live_any", "lowest-index live tank, any side"],
		["lowest_present_any", "lowest-index player present"],
		["slot_taker", "next name to take the quitter's slot"],
	];
	console.log("Who inherits a quitter's grounded pills? Their later fires (until the pills changed hands");
	console.log("again) by target, per quit, against candidate heirs. Columns: quits where the candidate");
	console.log("exists / of those, quits whose pills fired at anyone / fires in those quits / fires at the");
	console.log("candidate / quits in which the candidate was fired at. A true heir scores 0 in the last two.");
	for (let group of ["lowest ally live", "another ally live", "no ally live"]) {
		let ws = totals.windows.filter(w => w.heir_state === group);
		let side = {ally: 0, enemy: 0, newcomer: 0};
		for (let w of ws) for (let [name, c] of Object.entries(w.fires)) {
			if (w.allies.has(name)) side.ally += c; else if (w.others.has(name)) side.enemy += c; else side.newcomer += c;
		}
		console.log(`  ${group}: ${n(ws.length)} quits; fires at an old ally ${n(side.ally)}, at an old enemy ${n(side.enemy)}, at a newcomer ${n(side.newcomer)}`);
		for (let [key, title] of CANDIDATES) {
			let have = ws.filter(w => w.candidates[key] !== null);
			let fired = have.filter(w => Object.keys(w.fires).length);
			let fires = 0, at = 0, at_windows = 0;
			for (let w of fired) {
				for (let c of Object.values(w.fires)) fires += c;
				let hit = w.fires[w.candidates[key]] || 0;
				at += hit;
				if (hit) at_windows++;
			}
			console.log(`    ${title.padEnd(38)} ${[have.length, fired.length, fires, at, at_windows].map(v => n(v).padStart(7)).join("")}`);
		}
		/* a pill owned by one enemy never shoots every enemy */
		let fired = ws.filter(w => Object.keys(w.fires).length && w.others.size);
		let all_enemies = fired.filter(w => [...w.others].every(name => w.fires[name]));
		let two_enemies = fired.filter(w => [...w.others].filter(name => w.fires[name]).length >= 2);
		console.log(`    of the ${n(fired.length)} quits with fires and an enemy present, the pills shot every enemy present at the quit in ${n(all_enemies.length)}, two or more in ${n(two_enemies.length)}`);
	}
	console.log();
	/* The lowest slot the departing player's alliance named: two replays
	 * in which a live heir was fired at both had a departed player there
	 * (one in the alliance word, one only in the quitter's request). If
	 * the game hands to that slot regardless, fires at the heir should
	 * all sit in the first row and the second row should stay at zero. */
	let print_named_split = (heading, windows, heir_of) => {
		console.log(heading);
		console.log("Columns: quits or leaves (of them, slot named by the word / only by a request) /");
		console.log("fires / fires at the heir / hand-overs in which the heir was fired at / fires at any old ally.");
		for (let [title, pick] of [
			["that slot had quit", w => w.named !== null && w.named.departed],
			["that slot present", w => w.named !== null && !w.named.departed],
			["no slot named", w => w.named === null],
		]) {
			let ws = windows.filter(pick);
			let by_word = ws.filter(w => w.named && w.named.source === "word").length;
			let by_request = ws.filter(w => w.named && w.named.source === "request").length;
			let fires = 0, at_heir = 0, heir_windows = 0, at_ally = 0;
			for (let w of ws) {
				for (let [name, c] of Object.entries(w.fires)) {
					fires += c;
					if (w.allies.has(name)) at_ally += c;
				}
				let hit = w.fires[heir_of(w)] || 0;
				at_heir += hit;
				if (hit) heir_windows++;
			}
			console.log(`    ${title.padEnd(22)} ${n(ws.length).padStart(7)} (${n(by_word)} / ${n(by_request)})` +
				`${[fires, at_heir, heir_windows, at_ally].map(v => n(v).padStart(8)).join("")}`);
		}
		console.log();
	};
	print_named_split("Live-heir quits split by the lowest slot the quitter's alliance named -- in the model's\n" +
		"alliance word, or in the quitter's last standing request -- and whether that slot's\n" +
		"player had already quit.",
		totals.windows.filter(w => w.heir_state === "lowest ally live"), w => w.candidates.next_live_ally);
	print_named_split("Alliance leaves that handed grounded pills to the lowest mutual ally, the same split\n" +
		"(the fires counted until the pills next changed hands):",
		totals.leave_windows, w => w.heir_name);
}
console.log(`Fires where the sender is taken as the target: ${n(totals.sender_is_target)}; sender's tank hidden in forest`);
console.log(`at the time in ${n(totals.sender_hidden)} (${pc(totals.sender_hidden, totals.sender_is_target)}) -- ~0 if a pill cannot target a hidden tank.`);
console.log();
console.log(`Massaging: of those ${n(totals.sender_is_target)} fires the sender's tank is against the pill (within ${TOUCH_PX} px) in ${n(totals.touching)},`);
console.log(`and the fire direction equals the tank's facing in ${n(totals.touching_facing)} of them (${pc(totals.touching_facing, totals.touching)});`);
console.log(`apart from the pill the two coincide in ${n(totals.apart_facing)} of ${n(totals.sender_is_target - totals.touching)} (${pc(totals.apart_facing, totals.sender_is_target - totals.touching)}; 1 in 16 by chance).`);
console.log();
{
	let row = (name, a) => `    ${name.padEnd(28)} ${a.map(v => n(v).padStart(9)).join("")}`;
	console.log("Deflection: the direction nibble against the bearing to the sender's tank, in sectors,");
	console.log("split by the tank's motion across the pill's line of sight (from its last two positions):");
	console.log(`    ${"".padEnd(28)} ${["exact", "1 off", "2 off", "3+ off"].map(h => h.padStart(9)).join("")}`);
	console.log(row("tank still or unknown", totals.lead.still));
	console.log(row("moving, nibble leads it", totals.lead.toward));
	console.log(row("moving, nibble trails it", totals.lead.against));
	console.log("    (a leading pill puts the moving rows' misses in the first of the two, not the second)");
	console.log();
}
console.log(`Contested fires (two or more hostile tanks in range): ${n(totals.contested)}`);
console.log(`    sender is the nearest hostile tank     ${n(totals.sender_nearest).padStart(9)}   ${pc(totals.sender_nearest, totals.contested)}`);
console.log(`    expected if the simulator were random  ${n(Math.round(totals.random_expectation)).padStart(9)}   ${pc(totals.random_expectation, totals.contested)}`);
console.log(`    sender nearest among VISIBLE hostiles  ${n(totals.sender_nearest_visible).padStart(9)}   ${pc(totals.sender_nearest_visible, totals.contested)}   (rivals hidden in forest excluded)`);
console.log("    sender beaten by a nearer hostile tank, by margin:");
let lower = 0;
for (let i = 0; i <= MARGIN_BUCKETS.length; i++) {
	let label = i < MARGIN_BUCKETS.length ? `${lower + 1}-${MARGIN_BUCKETS[i]} px` : `over ${lower} px`;
	console.log(`        ${label.padEnd(12)} ${n(totals.lost_by_bucket[i]).padStart(9)}   ${pc(totals.lost_by_bucket[i], totals.contested)}`);
	if (i < MARGIN_BUCKETS.length) lower = MARGIN_BUCKETS[i];
}
let lost = totals.contested - totals.sender_nearest;
console.log(`        of the ${n(lost)} losses, the nearer tank was hidden in forest in ${n(totals.lost_to_hidden)}, and`);
console.log(`        restated less recently than the sender's in ${n(totals.lost_to_staler)}`);
console.log();
console.log(`Aim, on the same contested fires (${n(totals.aim_cases)}): the direction nibble against`);
console.log("the bearing from the pill to each tank, in 16 coarse sectors:");
console.log(`    exactly at the sender's tank           ${n(totals.aim_at_sender).padStart(9)}   ${pc(totals.aim_at_sender, totals.aim_cases)}`);
console.log(`    one sector off the sender, not rival   ${n(totals.aim_at_sender_pm1).padStart(9)}   ${pc(totals.aim_at_sender_pm1, totals.aim_cases)}`);
console.log(`    at the nearest rival, not the sender   ${n(totals.aim_at_rival).padStart(9)}   ${pc(totals.aim_at_rival, totals.aim_cases)}`);
console.log(`    ambiguous or neither                   ${n(totals.aim_neither).padStart(9)}   ${pc(totals.aim_neither, totals.aim_cases)}   (${n(totals.aim_neither_touching_facing)} of them massage-shaped: touching, fired along the facing)`);
if (totals.sample.length) {
	console.log();
	console.log(`Allied-sender fires, the first ${totals.sample.length} (replay names redacted):`);
	for (let line of totals.sample) console.log(`    ${line}`);
}
if (totals.out_of_range_sample.length) {
	console.log();
	console.log(`Out-of-range fires, the first ${totals.out_of_range_sample.length}:`);
	for (let line of totals.out_of_range_sample) console.log(`    ${line}`);
}
if (totals.trace) {
	console.log();
	console.log(`Alliance events, quits and joins in ${totals.trace.label} up to record ${totals.trace.last_record} (the replay with the most allied-sender fires, ${n(totals.trace.count)}),`);
	console.log("with the model's alliance masks as the event arrived (bit set = NOT allied):");
	let shown = 0;
	for (let line of totals.trace.events) {
		if (parseInt(line.slice(4)) > totals.trace.last_record) break;
		console.log(`    ${line}`);
		if (++shown >= 60) { console.log("    ..."); break; }
	}
}
console.log("======================================================================");
