// Regression test for the viewer's replay engine (viewer/game.js), run
// headless against the sample log.

const fs = require("node:fs");
const path = require("node:path");
const BoloLog = require("../viewer/logparse.js");
const BoloGame = require("../viewer/game.js");
const BoloNetwork = require("../viewer/network.js");

const root = path.join(__dirname, "..");
const log1 = path.join(root, "fixtures", "n20021018.2");

let failures = 0;
function check(what, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (wanted ${JSON.stringify(want)})`}`);
}

// Change stepping skips duplicate record times and chooses the adjacent
// timestamp on either side of the playback clock.
{
	let records = [{ time: 100 }, { time: 110 }, { time: 110 }, { time: 125 }];
	check("next change from exact timestamp", BoloGame.adjacent_change_time(records, 100, 1), 110);
	check("previous change from exact timestamp", BoloGame.adjacent_change_time(records, 110, -1), 100);
	check("next change between timestamps", BoloGame.adjacent_change_time(records, 111, 1), 125);
	check("previous change between timestamps", BoloGame.adjacent_change_time(records, 111, -1), 110);
	check("next change clamps at end", BoloGame.adjacent_change_time(records, 125, 1), 125);
	check("previous change clamps at start", BoloGame.adjacent_change_time(records, 100, -1), 100);
}

if (!fs.existsSync(log1)) {
	console.log("skip: fixtures/n20021018.2 not present; log-based engine tests skipped");
} else {
	const buf = new Uint8Array(fs.readFileSync(log1));
	const recs = [...BoloLog.records(buf)];
	check("records parsed (CJS parser)", recs.length, 120840);

	const game = BoloGame.build(recs);
	check("map name", game.final.gameInfo.mapName, "Fly Swatter IV");
	check("pills", game.final.pills.length, 16);
	check("bases", game.final.bases.length, 16);
	check("starts", game.final.starts.length, 8);
	check("chat entries", game.chat.length > 100, true);
	check("network conditions rating", game.network.rating, "fair");
	check("network conditions loss %", game.network.loss.toFixed(2), "6.84");
	check("network conditions stall %", game.network.stall.toFixed(2), "0.04");
	// The verdict is read from settled play, so the ramp at the start is
	// outside the measured span.
	check("network conditions skips the join ramp", game.network.from > game.t0, true);

	let shell_metrics = { total: 0, matched: 0, falls: 0 };
	let matched_effect_terminals = new Set();
	for (let snapshots of game.shell_positions) {
		for (let snapshot of snapshots) {
			for (let terminal of snapshot.terminals) {
				if (terminal.match_time !== undefined && terminal.effect) {
					matched_effect_terminals.add(terminal);
				}
			}
			for (let shell of snapshot.shells) {
				shell_metrics.total++;
				if (shell.next_time !== undefined) shell_metrics.matched++;
				if (shell.next_terminal_type === "point") shell_metrics.falls++;
			}
		}
	}
	let synthetic_births = game.shell_births.reduce((count, births) =>
		count + births.length, 0);
	check("fixture shell interpolation remains broadly effective", [
		shell_metrics.total,
		shell_metrics.matched >= 67000,
		shell_metrics.falls >= 8000,
		synthetic_births >= 8500,
	], [73753, true, true, true]);
	check("fixture impact effects follow matched shell arrival", [
		matched_effect_terminals.size >= 18000,
		[...matched_effect_terminals].every(terminal =>
			terminal.effect.time === terminal.match_time),
		[...matched_effect_terminals].some(terminal =>
			terminal.effect.time < terminal.record.time),
		game.effects.every((effect, i) => i === 0 ||
			game.effects[i - 1].time <= effect.time),
	], [true, true, true, true]);
	/* Birth claims that need no firing record: unseen shots recovered
	 * from orbit membership, and stream-provenance heads (a pill named by
	 * ambiguity propagation) claimed where they stand. Every claim must
	 * carry the full origin story it draws from. */
	let orbit_births = { unseen: 0, stream: 0, sound: true };
	for (let snapshots of game.shell_positions) {
		for (let snapshot of snapshots) {
			for (let shell of snapshot.shells) {
				if (!shell.unseen_pillbox_shot && !shell.stream_birth) continue;
				if (shell.unseen_pillbox_shot) orbit_births.unseen++;
				if (shell.stream_birth) orbit_births.stream++;
				if (!shell.starts_at_pillbox ||
					shell.pillbox_source_x === undefined ||
					!shell.pillbox_orbit_states ||
					!shell.pillbox_orbit_states.length) {
					orbit_births.sound = false;
				}
			}
		}
	}
	check("fixture orbit-membership and stream-provenance birth claims",
		[orbit_births.unseen, orbit_births.stream, orbit_births.sound],
		[26, 6, true]);

	/* Terminal-failure diagnostics: read-only classification of every
	 * terminal that ends the pipeline with no matched shell and no
	 * unseen-source attribution. The census must reconcile exactly with
	 * the report's unmatched counts, every reason must come from the
	 * known set, and the fixture's two headline classes are frozen.
	 * The unseen-source counters lock the same-record phase of the fate
	 * resolver: a shot and its impact reported in one record (the normal
	 * case for point-blank flights, e.g. adjacent-pill crossfire) is
	 * claimed as an unseen shot when count-forcing allows, and every
	 * previously matched terminal stays matched. */
	{
		const BoloMotion = require("../viewer/motion.js");
		let known_reasons = new Set(["edge_unforced", "end_continued",
			"end_claimed_other_fate", "creation_unforced", "timing_lag",
			"timing_lead", "window_expired", "orbit_miss", "ray_miss",
			"direction", "no_candidate"]);
		let unexplained = 0;
		let matched = 0;
		let unseen = { pill: 0, tank: 0 };
		let described = 0;
		let classes = new Map();
		let reasons_sound = true;
		for (let snapshots of game.shell_positions) {
			for (let snapshot of snapshots) {
				for (let terminal of snapshot.terminals) {
					if (terminal.match_time !== undefined) matched++;
					if (terminal.unseen_pillbox_source) unseen.pill++;
					if (terminal.unseen_tank_source) unseen.tank++;
					if (terminal.match_time === undefined &&
						!terminal.unseen_pillbox_source &&
						!terminal.unseen_tank_source) unexplained++;
				}
			}
			for (let record of BoloMotion.describe_unmatched_terminals(
				snapshots)) {
				described++;
				if (!known_reasons.has(record.reason)) reasons_sound = false;
				let signature =
					`${record.event_type}:${record.reason}:${record.kind}`;
				classes.set(signature, (classes.get(signature) || 0) + 1);
			}
		}
		check("fixture terminal-failure census reconciles", [
			described, described === unexplained, reasons_sound,
			classes.get("explosion:no_candidate:-"),
			classes.get("pillbox_damage:end_continued:T"),
		], [1035, true, true, 240, 89]);
		check("fixture same-record unseen shots claimed without cost", [
			matched, unseen.pill, unseen.tank,
		], [20692, 1222, 1126]);

		/* The end-side mirror: every chain end with no forward story gets
		 * a class; the census must equal the unmatched-forward count less
		 * final-snapshot ends, and the fate_open class (a valid edge to a
		 * still-unexplained impact -- the die-at-impact target) is
		 * frozen. */
		let end_known = new Set(["fate_open", "fate_unseen", "fate_taken",
			"timing_lag", "timing_lead", "window_expired", "orbit_miss",
			"ray_miss", "direction", "no_candidate"]);
		let unfated = 0;
		let ends_described = 0;
		let end_reasons_sound = true;
		let fate_open = 0;
		for (let snapshots of game.shell_positions) {
			for (let index = 0; index + 1 < snapshots.length; index++) {
				for (let shell of snapshots[index].shells) {
					if (shell.next_time === undefined) unfated++;
				}
			}
			for (let record of BoloMotion.describe_unfated_ends(snapshots)) {
				ends_described++;
				if (!end_known.has(record.reason)) end_reasons_sound = false;
				if (record.reason === "fate_open") fate_open++;
			}
		}
		check("fixture end-side census reconciles", [
			ends_described, ends_described === unfated, end_reasons_sound,
			fate_open,
		], [322, true, true, 21]);
	}

	let pill_burst = { total: 0, matched: 0 };
	for (let snapshot of game.shell_positions[1]) {
		let seconds = (snapshot.time - game.t0) / BoloLog.TICKS_PER_SECOND;
		if (seconds < 1627.8 || seconds > 1629.7) continue;
		for (let shell of snapshot.shells) {
			if (shell.direction !== 5) continue;
			pill_burst.total++;
			if (shell.next_time !== undefined) pill_burst.matched++;
		}
	}
	/* Non-head coordinates in this dense stream are reconstructed from lossy
	 * chained offsets. Their bounded orbit positions recover all six links
	 * which a strict comparison incorrectly rejected. */
	check("fixture pillbox burst accepts quantised orbit positions",
		[pill_burst.total, pill_burst.matched], [25, 25]);

	// Mid-game teams: the 2v2 seen in the chat (players 0+1 vs 2+3).
	const mid = BoloGame.state_at(game, Math.floor((game.t0 + game.t1) / 2)).state;
	check("mid-game teams", [0, 1, 2, 3].map(p => BoloGame.team_of(mid, p)), [0, 0, 2, 2]);

	// Determinism: seeking to the end must reproduce the linear pass exactly.
	const end = BoloGame.state_at(game, game.t1).state;
	check("seek-to-end grid matches final", end.state === undefined && end.grid.every((v, i) => v === game.final.grid[i]), true);
	check("seek-to-end base owners match", end.bases.map(b => b.owner), game.final.bases.map(b => b.owner));
	check("seek-to-end pill armour match", end.pills.map(p => p.armour), game.final.pills.map(p => p.armour));

	// Final base stocks under the validated replenishment model (every player's
	// 1000-tick bit feeds every base; the owner-only alternative is refuted by
	// 6,112 drains that would come from empty bases).
	check("final base shells", game.final.bases.map(b => b.shells),
		[90, 90, 68, 80, 86, 90, 90, 90, 75, 90, 90, 81, 90, 90, 90, 90]);
	check("final base armour", game.final.bases.map(b => b.armour),
		[54, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 90, 15, 90, 90, 90]);

	// Initial-map extraction: the pristine pre-battle map, recoverable and
	// roundtrippable through the BMAPBOLO serializer.
	{
		const BoloMap = require("../viewer/format.js");
		const map = BoloGame.extract_initial_map(recs);
		let covered = 0, craters = 0;
		for (let i = 0; i < map.grid.length; i++) {
			if (map.grid[i] !== 255) covered++;
			if (map.grid[i] === 3) craters++;
		}
		check("initial map coverage", covered, 3029);
		check("initial map has no battle craters", craters, 0);
		check("initial map objects", [map.pills.length, map.bases.length, map.starts.length], [16, 16, 8]);
		const back = BoloMap.parse_map(BoloMap.serialize_map(map));
		let same = true;
		for (let y = 21; y < 236; y++) {
			for (let x = 21; x < 236; x++) {
				if (back.grid[y * 256 + x] !== map.grid[y * 256 + x]) same = false;
			}
		}
		check("initial map BMAP roundtrip", same, true);
	}
}

// Dying positions clear an open radius-8 circle around the tank centre.
// Axial distance 7 is included, the (7,7) corner is not, and a later wreck
// position applies the full circle again rather than only its centre square.
{
	const st = BoloGame.initial_state();
	const terrain = (x, y) => st.grid[y * 256 + x];
	const die_at = (time, pixel_x) => BoloGame.apply_record(st, {
		time, seq: 0, status: 0, player: 0, tankStatus: 0x0c, tankDir: 0,
		subpackets: [{
			type: "tank_position", x: 10, y: 10, pixelX: pixel_x, pixelY: 1,
			direction: 0, inBoat: false, hidden: false, dying: true, speed: 0,
		}],
	}, null, null);
	st.grid[10 * 256 + 10] = 5;
	st.grid[10 * 256 + 11] = 5;
	st.grid[11 * 256 + 10] = 13;
	st.grid[11 * 256 + 11] = 5;
	die_at(100, 1); /* centre (169,169): nearest distances 7, 7 and (7,7) */
	check("death box includes axial radius 7",
		[terrain(10, 10), terrain(11, 10), terrain(10, 11)], [7, 7, 15]);
	/* the clearance is Chebyshev, so the (7,7) diagonal goes too: the
	 * corpus finds tree regrowth on exactly these corner squares, which
	 * can only happen if they were cleared (FORMAT.md [E:forest-circle]) */
	check("death box includes diagonal (7,7)", terrain(11, 11), 7);
	st.grid[11 * 256 + 11] = 5; /* a tree grows back on that corner */
	die_at(101, 7);
	check("later wreck position reapplies the death box", terrain(11, 11), 7);
}

// A pillbox masks the terrain beneath it from eventless wreck clearing --
// and from explicit craters too. A superboom damages the pill but leaves its
// ground alone, while its unoccupied squares still crater; the single-crater
// path spares a pill square the same way (FORMAT.md [E:crater-pill]).
{
	const st = BoloGame.initial_state();
	st.grid[10 * 256 + 11] = 13;
	st.grid[10 * 256 + 12] = 7; /* grass, no pill on it: this one must crater */
	st.pills = [{ x: 11, y: 10, owner: 0, armour: 8, speed: 50, inTank: null }];
	BoloGame.apply_record(st, {
		time: 100, seq: 0, status: 0, player: 0, tankStatus: 0x0c, tankDir: 0,
		subpackets: [{
			type: "tank_position", x: 10, y: 10, pixelX: 1, pixelY: 1,
			direction: 0, inBoat: false, hidden: false, dying: true, speed: 0,
		}],
	}, null, null);
	check("pill masks forest from death box", st.grid[10 * 256 + 11], 13);
	BoloGame.apply_record(st, {
		time: 101, seq: 1, status: 0, player: 0, tankStatus: 0, tankDir: 0,
		subpackets: [{ type: "explosion", code: 0x0d, x: 11, y: 10 }],
	}, null, null);
	check("pill masks its ground from explicit superboom", st.grid[10 * 256 + 11], 13);
	check("superboom still craters its unoccupied squares", st.grid[10 * 256 + 12], 3);
	check("explicit superboom damages pill", st.pills[0].armour, 4);
	/* the single crater is spared too, and the pill here is dead */
	st.pills[0].armour = 0;
	BoloGame.apply_record(st, {
		time: 102, seq: 2, status: 0, player: 0, tankStatus: 0, tankDir: 0,
		subpackets: [{ type: "explosion", code: 3, x: 11, y: 10 }],
	}, null, null);
	check("pill masks its ground from a single crater", st.grid[10 * 256 + 11], 13);
}

// Pill-fire events are always retained so the renderer can toggle their
// flashes without rebuilding an already-loaded replay.
{
	let st = BoloGame.initial_state();
	let effects = [];
	st.pills = [{ x: 11, y: 12, owner: 0, armour: 8, speed: 50, inTank: null }];
	BoloGame.apply_record(st, {
		time: 123, seq: 0, status: 0, player: 0, tankStatus: 0, tankDir: 0,
		subpackets: [{ type: "pillbox_fires", pillbox: 0, direction: 3 }],
	}, effects, null);
	check("pill fire creates a toggleable flash effect", effects,
		[{ time: 123, type: "pill_fire", x: 11, y: 12 }]);
}

// Tree growth incorrectly reports plain forest when it grows on mined grass.
// Preserve the mine only for that transition; other forest changes are used
// exactly as reported.
{
	const st = BoloGame.initial_state();
	const change_to_forest = (x, old_terrain) => {
		st.grid[10 * 256 + x] = old_terrain;
		BoloGame.apply_record(st, {
			time: 123, seq: x, status: 0, player: 0, tankStatus: 0, tankDir: 0,
			subpackets: [{ type: "terrain_change", terrain: 5, x, y: 10 }],
		}, null, null);
		return st.grid[10 * 256 + x];
	};
	check("tree growth preserves a mine under grass", change_to_forest(10, 15), 13);
	check("tree growth on grass remains plain forest", change_to_forest(11, 7), 5);
	check("other transitions to forest remain authoritative", change_to_forest(12, 11), 5);
}

// Alliance transitivity: accepting one member of an alliance joins you to
// all of it, but the log only events the pairwise link. Reproduces the
// pattern from a real 3v3 (B accepts C; C accepts A; no direct A-B event).
{
	const st = BoloGame.initial_state();
	const ev = (player, tanks) => BoloGame.apply_record(st, {
		time: 0, seq: 0, status: 0, player, tankStatus: 0, tankDir: 0,
		subpackets: [{ type: "alliance_accept", tanks }],
	}, null, null);
	for (let p = 0; p < 3; p++) st.present[p] = true;
	ev(1, 1 << 2); // p1 accepts p2
	ev(2, 1 << 0); // p2 accepts p0
	check("alliance transitivity", [0, 1, 2].map(p => BoloGame.team_of(st, p)), [0, 0, 0]);
	// the bitmasks themselves must form the full clique
	check("clique materialised",
		[0, 1, 2].every(a => [0, 1, 2].every(b => a === b ||
			(!(st.alliances[a] & (1 << b)) && !(st.alliances[b] & (1 << a))))), true);
}

// A T=7 F8 followed by established players restating their unchanged ids is
// a slot admission. It resets alliances even when an invisible ring split
// prevented the old occupant's quit from reaching the logger.
{
	let node_record = (time, player, tank_status, name) => ({
		time, seq: time & 0x7f, status: 0, player, tankStatus: tank_status, tankDir: 0,
		subpackets: [{ type: "node_id", name }],
	});
	let records = [
		node_record(0, 0, 0, "player0@node0"),
		node_record(1, 1, 0, "player1@node1"),
		node_record(2, 2, 0, "player2@node2"),
		node_record(3, 3, 0, "player3@node3"),
		node_record(4, 4, 0, "player3@node3"),
		node_record(100, 4, 7, "player4@node4"),
		node_record(120, 0, 0, "player0@node0"),
		node_record(130, 1, 0, "player1@node1"),
	];
	let joins = BoloGame.classify_node_joins(records);
	check("T=7 roster burst identifies a slot admission", joins.has(records[5]), true);

	let isolated = node_record(200, 4, 7, "renamed@node4");
	check("isolated T=7 rename is not a slot admission",
		BoloGame.classify_node_joins(records.slice(0, 5).concat(isolated)).has(isolated), false);

	let st = BoloGame.initial_state();
	for (let i = 0; i < 5; i++) BoloGame.apply_record(st, records[i], null, null);
	let ally = (a, b) => {
		st.alliances[a] &= ~(1 << b);
		st.alliances[b] &= ~(1 << a);
	};
	ally(0, 3);
	ally(0, 4);
	ally(3, 4);
	ally(1, 2);
	BoloGame.apply_record(st, records[5], null, null, null, joins);
	BoloGame.apply_record(st, {
		time: 200, seq: 0, status: 0, player: 0, tankStatus: 0, tankDir: 0,
		subpackets: [{ type: "alliance_accept", tanks: 1 << 3 }],
	}, null, null);
	BoloGame.apply_record(st, {
		time: 201, seq: 1, status: 0, player: 2, tankStatus: 0, tankDir: 0,
		subpackets: [{ type: "alliance_accept", tanks: 1 << 4 }],
	}, null, null);
	check("admitted slot does not merge its old and new teams",
		[0, 1, 2, 3, 4].map(player => BoloGame.team_of(st, player)), [0, 1, 1, 0, 1]);
}

// Quitting takes carried pills out of the game, and a new player reusing
// the slot inherits neither the cargo nor the alliances.
{
	const st = BoloGame.initial_state();
	for (let p = 0; p < 3; p++) { st.present[p] = true; st.names[p] = "p" + p; }
	st.alliances[0] &= ~(1 << 1); st.alliances[1] &= ~(1 << 0); /* 0 and 1 allied */
	st.pills = [{ x: 5, y: 5, owner: 0, armour: 0, speed: 50, inTank: 0 }];
	const ev = subpackets => BoloGame.apply_record(st, { time: 0, seq: 0, status: 0, player: 0, tankStatus: 7, tankDir: 0, subpackets }, null, null);
	ev([{ type: "quit", fields: [] }]);
	check("carried pill leaves with tankless quitter", st.pills[0].inTank < 0, true);
	ev([{ type: "node_id", name: "newguy@somewhere" }]);
	check("slot reuse resets alliances", (st.alliances[0] & (1 << 1)) !== 0 && (st.alliances[1] & (1 << 0)) !== 0, true);
	check("slot reuse does not revive cargo", st.pills[0].inTank < 0, true);
}

// A quitter WITH a known tank position dumps carried pills on the ground
// around it, tank-death style.
{
	const st = BoloGame.initial_state();
	st.present[0] = true; st.names[0] = "p0";
	st.grid.fill(7, 0, 256 * 20); /* grass rows 0-19 */
	st.tanks[0] = { x: 10, y: 10, px: 0, py: 0, dir: 0, inBoat: false, hidden: false, dying: false, speed: 0, lastSeen: 0, dead: false };
	st.pills = [{ x: 0, y: 0, owner: 0, armour: 15, speed: 50, inTank: 0 }];
	BoloGame.apply_record(st, { time: 0, seq: 0, status: 0, player: 0, tankStatus: 7, tankDir: 0, subpackets: [{ type: "quit", fields: [] }] }, null, null);
	const p = st.pills[0];
	check("quitter's pill dumped on the ground", p.inTank, null);
	check("dumped dead near the tank", p.armour === 0 && Math.abs(p.x - 10) <= 1 && Math.abs(p.y - 10) <= 1, true);
}

// A tank dying in a river dumps its pills into the water: the search
// refuses buildings, shot buildings and boats, NOT water. Verified by
// pickups: a tank that died fording dropped pills on the death square and
// the square north of it, both river, lowest pill index first, and the
// collector's tank centre entered each square exactly at its pickup
// record [E:dump-terrain].
{
	const st = BoloGame.initial_state();
	st.present[0] = true; st.names[0] = "p0";
	st.grid.fill(1, 0, 256 * 20); /* river rows 0-19 */
	st.grid[9 * 256 + 10] = 0; /* a building one square north of the tank */
	st.tanks[0] = { x: 10, y: 10, px: 0, py: 0, dir: 0, inBoat: false, hidden: false, dying: false, speed: 0, lastSeen: 0, dead: false };
	st.pills = [
		{ x: 0, y: 0, owner: 0, armour: 15, speed: 50, inTank: 0 },
		{ x: 0, y: 0, owner: 0, armour: 15, speed: 50, inTank: 0 },
	];
	BoloGame.apply_record(st, { time: 0, seq: 0, status: 0, player: 0, tankStatus: 7, tankDir: 0, subpackets: [{ type: "tank_death", code: 1 }] }, null, null);
	check("first pill dumped on the river death square", [st.pills[0].x, st.pills[0].y], [10, 10]);
	check("second pill skips the building, takes the next river square", [st.pills[1].x, st.pills[1].y], [11, 9]);
}

// Shell-list offsets are CHAINED (each relative to the previous shell),
// not relative to the list's first shell.
{
	const st = BoloGame.initial_state();
	BoloGame.apply_record(st, {
		time: 0, seq: 0, status: 0, player: 0, tankStatus: 0, tankDir: 0,
		subpackets: [{ type: "shells", count: 3, shells: [
			{ direction: 4, x: 100, y: 100, pixel: 0 },
			{ offsetX: 16, offsetY: 0 },
			{ offsetX: 16, offsetY: 0 },
		] }],
	}, null, null);
	check("chained shell offsets", st.shells[0].map(sh => sh.x), [100, 101, 102]);
	check("shell-list direction applies to every shell", st.shells[0].map(sh => sh.direction), [4, 4, 4]);
	check("chained shell offsets accumulate positional uncertainty",
		st.shells[0].map(sh => sh.position_uncertainty), [0, 1, 2]);
}

// Shell identities are inferred conservatively between one client's adjacent
// restatements. The direction nibble is authoritative for every list member;
// positions recover the finer heading within that 4-bit sector.
{
	let shell_list = (direction, points) => ({
		type: "shells", count: points.length, direction,
		shells: points.map((point, index) => index === 0 ? {
			direction,
			x: point[0] >> 4,
			y: point[1] >> 4,
			pixel: (point[1] & 0x0f) * 16 + (point[0] & 0x0f),
		} : {
			offsetX: point[0] - points[index - 1][0],
			offsetY: point[1] - points[index - 1][1],
		}),
	});
	let record = (time, lists, player = 0) => ({
		time, seq: time, status: 0, player, tankStatus: 0, tankDir: 0,
		subpackets: lists,
	});
	let position = (game, tick, player = 0, index = 0) => {
		let state = BoloGame.state_at(game, tick).state;
		return BoloGame.shell_position_at(game, player,
			state.shells[player][index], index, tick);
	};
	let rounded = value => Math.round(value * 10000) / 10000;

	let smooth = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(112, [shell_list(4, [[184, 166]])]),
	]);
	check("shell movement interpolates inside its direction sector",
		[rounded(position(smooth, 106).x), rounded(position(smooth, 106).y)],
		[11.25, 10.6875]);

	let refined_track = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(112, [shell_list(4, [[184, 164]])]),
		record(124, [shell_list(4, [[208, 160]])]),
	]);
	let refined_track_shell = refined_track.shell_positions[0][2].shells[0];
	check("later restatements refine heading from the first track point",
		[rounded(refined_track_shell.heading_x),
			rounded(refined_track_shell.heading_y),
			refined_track_shell.heading_origin_x,
			refined_track_shell.heading_origin_y], [1, 0, 160, 160]);

	let new_head = BoloGame.build([
		record(100, [shell_list(4, [[160, 160], [200, 160]])]),
		record(112, [shell_list(4, [[160, 160], [184, 160], [224, 160]])]),
	]);
	check("all directed list members survive a new shell head",
		[rounded(position(new_head, 106, 0, 0).x),
			rounded(position(new_head, 106, 0, 1).x)], [11.25, 13.75]);

	let changed_direction = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(112, [shell_list(5, [[184, 160]])]),
	]);
	check("different shell directions never match",
		rounded(position(changed_direction, 106).x), 10.5);

	/* Two same-ray successors a pixel either side of schedule: no identity
	 * is claimed (the margin refuses, and no origin propagates), but the
	 * sprite continues along the shared ray as a draw-only visual join --
	 * every candidate story draws this way, and a freeze-and-vanish
	 * matches none of them. */
	let ambiguous = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(112, [shell_list(4, [[183, 160], [185, 160]])]),
	]);
	check("ambiguous same-ray identity continues as a draw-only join",
		[rounded(position(ambiguous, 106).x),
			!!ambiguous.shell_positions[0][1].shells[0].visual_join,
			ambiguous.shell_positions[0][1].shells[0].birth_time === undefined],
		[11.2188, true, true]);

	let recoverable_lag = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(100 + BoloGame.MAX_SHELL_INTERPOLATION_TICKS,
			[shell_list(4, [[260, 160]])]),
	]);
	check("shell interpolates across recoverable lag",
		rounded(position(recoverable_lag, 125).x), 13.625);

	let excessive_lag = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(100 + BoloGame.MAX_SHELL_INTERPOLATION_TICKS + 1,
			[shell_list(4, [[262, 160]])]),
	]);
	check("shell stops beyond its lag window",
		rounded(position(excessive_lag, 125).x), 10.5);

	let delayed_impact = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(140, [{ type: "shell_falls", x: 11, y: 10, pixel: 0 }]),
	]);
	check("shell does not infer an early impact across long lag",
		rounded(position(delayed_impact, 125).x), 10.5);

	let precise_impact = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(112, [shell_list(4, [[184, 166]])]),
		record(124, [{ type: "shell_falls", x: 13, y: 10, pixel: 0xc0 }]),
	]);
	/* The fall record arrives a fraction of a tick before the shell's
	 * 2 px/tick arrival. A splash has no coupled state change, so a fall's
	 * arrival is not capped at its record: the link draws at true speed,
	 * the splash is retimed to the arrival, and a fall segment carries the
	 * sprite past the record that drops it from packet state. */
	check("shell interpolates to precise ground impact at true speed",
		[rounded(position(precise_impact, 118).x),
			rounded(position(precise_impact, 118).y)], [12.7276, 11.0569]);
	check("splash effect is retimed to the shell's arrival",
		rounded(precise_impact.effects.find(e => e.type === "splash").time),
		124.3693);
	let fall_positions = BoloGame.shell_fall_positions_at(precise_impact, 0, 124.2);
	check("fall segment carries the shell past the fall record",
		[fall_positions.length, rounded(fall_positions[0].x),
			rounded(fall_positions[0].y)], [1, 13.4795, 11.2449]);
	check("fall segment ends at the splash",
		BoloGame.shell_fall_positions_at(precise_impact, 0, 124.4).length, 0);

	let tile_impact = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(112, [shell_list(4, [[184, 166]])]),
		record(124, [{ type: "explosion", code: 0, x: 13, y: 11 }]),
	]);
	check("tile impact follows learned ray to tile boundary",
		[rounded(position(tile_impact, 118).x),
			rounded(position(tile_impact, 118).y)], [12.7276, 11.0569]);
	check("shell disappears upon reaching tile impact",
		position(tile_impact, 121), null);

	let corner_graze = BoloGame.build([
		record(100, [shell_list(12, [[2110, 1812]])]),
		record(120, [shell_list(12, [[2071, 1814]])]),
		record(132, [{ type: "explosion", code: 0, x: 128, y: 114 }]),
	]);
	let corner_graze_shell = corner_graze.shell_positions[0][1].shells[0];
	check("subpixel corner graze matches a box impact",
		[corner_graze_shell.next_terminal,
			rounded(Math.hypot(corner_graze_shell.next_pixel_x + 8 - 2048,
				corner_graze_shell.next_pixel_y + 8 - 1824))], [true, 0.4097]);

	let wide_corner_miss = BoloGame.build([
		record(100, [shell_list(12, [[2110, 1811]])]),
		record(120, [shell_list(12, [[2071, 1813]])]),
		record(132, [{ type: "explosion", code: 0, x: 128, y: 114 }]),
	]);
	check("corner miss outside one pixel remains unmatched",
		wide_corner_miss.shell_positions[0][1].shells[0].next_time, undefined);

	/* A tank shell at a chained list position has a one-sided coordinate
	 * bound just like a pill shell. This is the first failing shot from
	 * corpus replay md5 72c58f0271542b3787da70278dfba4b5, reduced to its
	 * player-zero restatements: the
	 * reconstructed ray misses the pill by 1.45px, while y + 1 is both inside
	 * the member's two-pixel bound and a valid impact. */
	let quantised_tank_impact = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 133, y: 127, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, [{
			type: "tank_position", x: 125, y: 126,
			pixelX: 12, pixelY: 2, direction: 4,
			inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}]),
		record(100, [
			{ type: "shot_fired", direction: 4 },
			shell_list(4, [[2037, 2020]]),
		]),
		record(111, [shell_list(4, [[2057, 2020]])]),
		record(121, [shell_list(4, [[2077, 2021]])]),
		record(133, [shell_list(4, [[2101, 2021]])]),
		record(144, [shell_list(4, [
			[2073, 2021], [2049, 2019], [2121, 2022],
		])]),
		record(156, [{ type: "pillbox_damage", pillbox: 0 }]),
	]);
	let quantised_tank_shell = quantised_tank_impact
		.shell_positions[0][5].shells[2];
	check("chained tank-shell uncertainty recovers a pill impact",
		[quantised_tank_shell.position_uncertainty,
			quantised_tank_shell.next_terminal_event_type],
		[2, "pillbox_damage"]);

	/* The restatements follow the recovered integer simulation exactly
	 * (bradian 66: velocity 64,3 per update from internal 32725,32332), so
	 * bradian tracking cannot veto the chain; the chained member's
	 * reconstructed coordinate sits one below its exact position on each
	 * axis, per the one-sided quantisation bound. */
	let bounded_tank_successor = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 132, y: 127, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, [{
			type: "tank_position", x: 126, y: 126,
			pixelX: 1, pixelY: 2, direction: 4,
			inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}]),
		record(100, [
			{ type: "shot_fired", direction: 4 },
			shell_list(4, [[2045, 2020]]),
		]),
		record(112, [shell_list(4, [[2069, 2021]])]),
		record(123, [shell_list(4, [[2040, 2018], [2088, 2021]])]),
		record(134, [
			{ type: "pillbox_damage", pillbox: 0 },
			shell_list(4, [[2113, 2023]]),
		]),
	]);
	let bounded_successor_shell = bounded_tank_successor
		.shell_positions[0][3].shells[1];
	check("real tank successor wins over a bounded adjacent impact",
		[!!bounded_successor_shell.next_terminal,
			bounded_successor_shell.next_pixel_x,
			bounded_successor_shell.next_pixel_y],
		[false, 2113, 2023]);

	/* Packet lag can stretch a restatement gap past the pairwise window,
	 * splitting the shell into two fragments. The stitching pass must
	 * rejoin them on bradian evidence (the path follows bradian 66 from
	 * internal 32725,32332) and carry the birth across the join. */
	let lag_gap_stitch = BoloGame.build([
		record(90, [{
			type: "tank_position", x: 126, y: 126,
			pixelX: 1, pixelY: 2, direction: 4,
			inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}]),
		record(100, [
			{ type: "shot_fired", direction: 4 },
			shell_list(4, [[2045, 2020]]),
		]),
		record(156, [shell_list(4, [[2157, 2026]])]),
	]);
	let stitch_end = lag_gap_stitch.shell_positions[0][1].shells[0];
	let stitch_start = lag_gap_stitch.shell_positions[0][2].shells[0];
	check("lag-split shell fragments are stitched on bradian evidence",
		[stitch_end.next_time, stitch_end.next_pixel_x, stitch_end.next_pixel_y,
			!!stitch_start.stitched, stitch_start.birth_time !== undefined],
		[156, 2157, 2026, true, true]);

	/* A vanished chain and an unexplained impact past the pairwise terminal
	 * window: the forced-assignment pass must pair them when no other
	 * story exists, timing the impact at the shell's inferred arrival. */
	let forced_late_impact = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 133, y: 126, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, [{
			type: "tank_position", x: 126, y: 126,
			pixelX: 1, pixelY: 2, direction: 4,
			inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}]),
		record(100, [
			{ type: "shot_fired", direction: 4 },
			shell_list(4, [[2045, 2020]]),
		]),
		record(112, [shell_list(4, [[2069, 2021]])]),
		record(147, [{ type: "pillbox_damage", pillbox: 0 }]),
	]);
	let late_impact_shell = forced_late_impact.shell_positions[0][2].shells[0];
	check("forced assignment recovers an impact past the pairwise window",
		[!!late_impact_shell.next_terminal,
			late_impact_shell.next_terminal_event_type],
		[true, "pillbox_damage"]);

	/* A shot with no observed shell at all, and an impact nothing else can
	 * explain: the forced pass attributes the impact to the firing tank. */
	let forced_unseen_tank = BoloGame.build([
		record(90, [{
			type: "tank_position", x: 126, y: 126,
			pixelX: 1, pixelY: 2, direction: 4,
			inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}]),
		record(100, [{ type: "shot_fired", direction: 4 }]),
		record(118, [{ type: "explosion", code: 0, x: 129, y: 126 }]),
	]);
	let unseen_terminal = forced_unseen_tank.shell_positions[0][2].terminals[0];
	check("an impact with no seen shell is attributed to the firing tank",
		[!!unseen_terminal.unseen_tank_source,
			unseen_terminal.tank_source_direction],
		[true, 4]);

	/* From replay 122903.4: a lagging sender whose record timestamps drift
	 * against its simulation by several updates. Per-hop speeds read 1.4,
	 * 2.8, 2.0, 0.7 and 3.6 px/tick while the shell flies at exactly 2.
	 * The stitcher must bridge the failing hops, absorb the on-path
	 * observations it skips (once drawn as phantom second shells), and
	 * smoothing must re-time the chain to constant drawn velocity. */
	let jittered_sender = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 66, y: 156, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 7 },
			shell_list(7, [[1059, 2503]]),
		]),
		record(114, [shell_list(7, [[1068, 2520]])]),
		record(124, [shell_list(7, [[1081, 2545]])]),
		record(134, [shell_list(7, [[1090, 2563]])]),
		record(146, [shell_list(7, [[1094, 2570]])]),
		record(156, [shell_list(7, [[1110, 2602]])]),
		record(167, [{ type: "explosion", code: 7, x: 70, y: 164 }]),
	]);
	let absorbed_observation = jittered_sender.shell_positions[0][4].shells[0];
	check("jittered on-path observations are absorbed into the chain",
		[!!absorbed_observation.matched_from_previous,
			!!absorbed_observation.stitched],
		[true, true]);
	check("a jittered chain draws at constant velocity",
		[rounded(position(jittered_sender, 146).x),
			rounded(position(jittered_sender, 146).y)],
		[69.3058, 162.0201]);

	/* From replay 101202.10, pillbox 3 firing coarse direction 9 around
	 * record 305. The sender's packet at the third restatement carried
	 * simulation state twelve ticks stale, so the shell advanced four
	 * orbit steps across a twenty-tick record gap and ten across the next
	 * ten-tick one. Every restatement is an exact point on one orbit
	 * (bradian 145, steps 5, 10, 14, 24, 29), but the timing put the
	 * middle one 24.37px off the uniform-time schedule -- past the 24px
	 * geometric gate by a third of a pixel -- and it drew as a backwards
	 * jump, a ten-tick hover and a forty-pixel rush. The orbit is
	 * authoritative over the clock: a point strictly between the stitch's
	 * own two steps is the shell. A shell-less record precedes the shot so
	 * that birth attribution has a predecessor snapshot to work from. */
	let idle_tank = {
		type: "tank_position", x: 100, y: 100, pixelX: 0, pixelY: 0,
		direction: 0, inBoat: false, hidden: false, dying: false,
		speed: 0, motion: 0,
	};
	let dilated_pill_stream = BoloGame.build([
		record(60, [{ type: "pillbox_list", items: [{
			x: 140, y: 133, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(80, [idle_tank]),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 9 },
			shell_list(9, [[2229, 2153]]),
		]),
		record(109, [shell_list(9, [[2221, 2172]])]),
		record(129, [shell_list(9, [[2214, 2186]])]),
		record(139, [shell_list(9, [[2199, 2223]])]),
		record(149, [shell_list(9, [[2191, 2242]])]),
	]);
	let dilated_observation = dilated_pill_stream.shell_positions[0][3].shells[0];
	check("an orbit point between a stitch's steps is absorbed however " +
		"badly the sender's clock lies",
		[!!dilated_observation.matched_from_previous,
			!!dilated_observation.stitched,
			dilated_observation.pillbox_orbit_states],
		[true, true, [{ bradian: 145, step: 14 }]]);
	/* The whole flight, not just the absorbed link: min and max drawn
	 * speed are equal, so nothing hovers and nothing rushes. */
	let dilated_speeds = [];
	for (let tick = 101; tick <= 149; tick++) {
		let from = position(dilated_pill_stream, tick - 1);
		let to = position(dilated_pill_stream, tick);
		dilated_speeds.push(rounded(Math.hypot(to.x - from.x, to.y - from.y) * 16));
	}
	check("the absorbed chain draws at one constant speed end to end",
		[Math.min(...dilated_speeds), Math.max(...dilated_speeds)],
		[1.975, 1.975]);

	/* The orbit test is not restricted to list heads. A chained member's
	 * coordinate is only bounded -- the exact point lies between the
	 * reconstruction and the reconstruction plus the member's index -- so
	 * it starts with several candidate bradians and narrows. Here the
	 * tracked shell rides at index 1 behind a decoy from another pill,
	 * and its middle offset quantised one pixel short on both axes: it is
	 * still absorbed, its bradian is pinned, and the exact orbit pixel is
	 * recovered a pixel away from where the offsets put it. */
	let chained_member = BoloGame.build([
		record(60, [{ type: "pillbox_list", items: [
			{ x: 140, y: 133, owner: 1, armour: 15, speed: 100 },
			{ x: 120, y: 133, owner: 1, armour: 15, speed: 100 },
		] }]),
		record(80, [idle_tank]),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 9 },
			{ type: "pillbox_fires", pillbox: 1, direction: 9 },
			shell_list(9, [[1909, 2153], [2229, 2153]]),
		]),
		record(109, [shell_list(9, [[1901, 2172], [2221, 2172]])]),
		record(129, [shell_list(9, [[1894, 2186], [2213, 2185]])]),
		record(139, [shell_list(9, [[1879, 2223], [2199, 2223]])]),
		record(149, [shell_list(9, [[1871, 2242], [2191, 2242]])]),
	]);
	check("a chained list member starts with several candidate bradians",
		chained_member.shell_positions[0][1].shells[1].pillbox_orbit_states,
		[{ bradian: 143, step: 5 }, { bradian: 145, step: 5 }]);
	let chained_observation = chained_member.shell_positions[0][3].shells[1];
	check("a chained member is absorbed too, its bradian pinned and its " +
		"exact pixel recovered from the quantisation bound",
		[chained_observation.position_uncertainty,
			!!chained_observation.matched_from_previous,
			chained_observation.pillbox_orbit_states,
			[chained_observation.pixel_x, chained_observation.pixel_y],
			[chained_observation.pillbox_orbit_pixel_x,
				chained_observation.pillbox_orbit_pixel_y]],
		[1, true, [{ bradian: 145, step: 14 }], [2213, 2185], [2214, 2186]]);

	/* The limit of the orbit evidence: it cannot say WHICH stream-mate an
	 * observation is. An angry pillbox fires every five or six ticks, so
	 * same-ray neighbours ride two or three orbit steps apart, and a
	 * fragmented stream can drop two of them -- here exact points at
	 * steps 12 and 14, both strictly between the stitch's steps 10 and
	 * 24 -- into one snapshot of the gap. Absorbing both would thread two
	 * same-time restatements into the chain as a zero-duration link;
	 * absorbing either alone is a guess. Neither is absorbed: the stitch
	 * keeps its direct link and both observations stay unexplained. */
	let ambiguous_pair = BoloGame.build([
		record(60, [{ type: "pillbox_list", items: [{
			x: 140, y: 133, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(80, [idle_tank]),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 9 },
			shell_list(9, [[2229, 2153]]),
		]),
		record(110, [shell_list(9, [[2221, 2172]])]),
		record(125, [shell_list(9, [[2218, 2179], [2214, 2186]])]),
		record(140, [shell_list(9, [[2199, 2223]])]),
	]);
	let ambiguous_end = ambiguous_pair.shell_positions[0][2].shells[0];
	check("two qualifying stream-mates in one snapshot absorb neither",
		[ambiguous_end.next_time,
			ambiguous_pair.shell_positions[0][3].shells.map(shell =>
				!!shell.matched_from_previous)],
		[140, [false, false]]);

	/* The orbit evidence also cuts the other way. This observation sits
	 * on the stitch's segment and near its uniform-time schedule -- the
	 * geometric gate alone would absorb it -- but its relative position
	 * (-24,54) is one pixel off step 13's (-24,55) at list-head
	 * precision, on no surviving orbit point at all. With orbit states at
	 * both ends of the stitch that is proof of some other shell, so the
	 * geometric gate is never consulted and the chain keeps its direct
	 * link. */
	let orbit_contradiction = BoloGame.build([
		record(60, [{ type: "pillbox_list", items: [{
			x: 140, y: 133, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(80, [idle_tank]),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 9 },
			shell_list(9, [[2229, 2153]]),
		]),
		record(110, [shell_list(9, [[2221, 2172]])]),
		record(125, [shell_list(9, [[2216, 2182]])]),
		record(140, [shell_list(9, [[2199, 2223]])]),
	]);
	let contradiction_end = orbit_contradiction.shell_positions[0][2].shells[0];
	check("an observation the surviving orbits rule out is never absorbed",
		[contradiction_end.next_time,
			!!orbit_contradiction.shell_positions[0][3].shells[0]
				.matched_from_previous],
		[140, false]);

	/* The two halves of one true story must not veto each other. From the
	 * 031403.1 replay, pill 12 firing at a stationary tank: the shell's
	 * last restatement arrived with the sender's clock lying by several
	 * ticks (four orbit steps across a fourteen-tick record gap), so the
	 * pairwise matcher refused the hop, and the impact followed. In the
	 * residual flow the dilated join to that orphan restatement and the
	 * fate edge to the impact then land within the margin of each other:
	 * neither is forced, and the shell pops mid-air with its impact
	 * unexplained -- though together they describe one flight. The orphan
	 * is a provable intermediate of the fate's story (an exact orbit
	 * point on a surviving bradian, strictly between the end's step and
	 * the fate's entry step), so the join is subsumed, the fate is
	 * forced, and the observation is absorbed into the terminal segment
	 * with the arrival re-timed from it. */
	let subsumed_intermediate = BoloGame.build([
		record(60, [{ type: "pillbox_list", items: [
			{ x: 140, y: 133, owner: 1, armour: 15, speed: 100 },
			{ x: 138, y: 139, owner: 1, armour: 15, speed: 100 },
		] }]),
		record(80, [idle_tank]),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 9 },
			shell_list(9, [[2229, 2153]]),
		]),
		record(110, [shell_list(9, [[2221, 2172]])]),
		record(124, [shell_list(9, [[2214, 2186]])]),
		record(139, [{ type: "pillbox_damage", pillbox: 1 }]),
	]);
	let subsumed_observation =
		subsumed_intermediate.shell_positions[0][3].shells[0];
	let subsumed_terminal =
		subsumed_intermediate.shell_positions[0][4].terminals[0];
	check("a restatement on the way to an impact joins the impact's own story",
		[!!subsumed_observation.matched_from_previous,
			subsumed_observation.pillbox_orbit_states,
			!!subsumed_observation.next_terminal,
			subsumed_observation.next_terminal_event_type,
			subsumed_terminal.match_time],
		[true, [{ bradian: 145, step: 14 }], true, "pillbox_damage", 139]);

	/* Unseen-shot births: a shell whose F4 was lost to packet loss used
	 * to stay origin-less forever -- the corpus's backwards-pop anatomy
	 * found these popping in one fire interval behind their dead stream
	 * leaders. The orbit table is a complete list of every pixel a
	 * pill's shells can occupy, so origin needs no F4 when geometry is
	 * decisive: this chain (no pillbox_fires anywhere) lies on pill
	 * (140,133)'s bradian-145 orbit at steps 5, 10, 15, and is claimed
	 * as its shot -- source named, exact pixel recovered, and the birth
	 * segment drawn from the muzzle. */
	let no_f4_pill = (armour) => ({ type: "pillbox_list", items: [{
		x: 140, y: 133, owner: 1, armour, speed: 100,
	}] });
	let unseen_birth = BoloGame.build([
		record(60, [no_f4_pill(15)]),
		record(80, [idle_tank]),
		record(100, [shell_list(9, [[2229, 2153]])]),
		record(110, [shell_list(9, [[2221, 2172]])]),
		record(120, [shell_list(9, [[2213, 2190]])]),
	]);
	let unseen_head = unseen_birth.shell_positions[0][1].shells[0];
	check("an origin-less chain on one live pill's orbit is claimed as " +
		"its unseen shot",
		[!!unseen_head.starts_at_pillbox, !!unseen_head.unseen_pillbox_shot,
			[unseen_head.pillbox_source_x, unseen_head.pillbox_source_y],
			unseen_head.pillbox_orbit_states,
			unseen_birth.shell_positions[0][3].shells[0].pillbox_source_x],
		[true, true, [2240, 2128], [{ bradian: 145, step: 5 }], 2240]);
	check("the unseen shot draws its birth segment from the muzzle",
		[unseen_birth.shell_births[0].length,
			unseen_birth.shell_births[0][0].pixel_x,
			unseen_birth.shell_births[0][0].pixel_y],
		[1, 2240, 2128]);

	/* A dead pill cannot fire: the same chain past an armour-0 pill
	 * stays origin-less. */
	let dead_pill_birth = BoloGame.build([
		record(60, [no_f4_pill(0)]),
		record(80, [idle_tank]),
		record(100, [shell_list(9, [[2229, 2153]])]),
		record(110, [shell_list(9, [[2221, 2172]])]),
		record(120, [shell_list(9, [[2213, 2190]])]),
	]);
	check("a dead pill claims no unseen shots",
		!!dead_pill_birth.shell_positions[0][1].shells[0].starts_at_pillbox,
		false);

	/* Off the orbit by a few pixels -- a plausible-looking chain that is
	 * provably not this pill's -- stays origin-less too. */
	let off_orbit_birth = BoloGame.build([
		record(60, [no_f4_pill(15)]),
		record(80, [idle_tank]),
		record(100, [shell_list(9, [[2226, 2150]])]),
		record(110, [shell_list(9, [[2225, 2169]])]),
		record(120, [shell_list(9, [[2217, 2188]])]),
	]);
	check("a chain off every orbit point is not claimed",
		!!off_orbit_birth.shell_positions[0][1].shells[0].starts_at_pillbox,
		false);

	/* A single sighting is claimable only exact and fresh from the
	 * muzzle (step 2 here); one seen once in mid-flight (step 10) could
	 * be anything and stays a pop. */
	let single_muzzle = BoloGame.build([
		record(60, [no_f4_pill(15)]),
		record(80, [idle_tank]),
		record(100, [shell_list(9, [[2233, 2142]])]),
		record(110, [idle_tank]),
	]);
	let single_far = BoloGame.build([
		record(60, [no_f4_pill(15)]),
		record(80, [idle_tank]),
		record(100, [shell_list(9, [[2221, 2172]])]),
		record(110, [idle_tank]),
	]);
	check("a single sighting is claimed at the muzzle and refused mid-flight",
		[!!single_muzzle.shell_positions[0][1].shells[0].unseen_pillbox_shot,
			single_muzzle.shell_positions[0][1].shells[0].pillbox_orbit_states,
			!!single_far.shell_positions[0][1].shells[0].starts_at_pillbox],
		[true, [{ bradian: 145, step: 2 }], false]);

	let graze_with_successor = BoloGame.build([
		record(100, [shell_list(12, [[2110, 1812]])]),
		record(120, [shell_list(12, [[2071, 1814]])]),
		record(132, [
			shell_list(12, [[2047, 1815]]),
			{ type: "explosion", code: 0, x: 128, y: 114 },
		]),
	]);
	let successor_shell = graze_with_successor.shell_positions[0][1].shells[0];
	check("exact successor wins over graze fallback",
		[!!successor_shell.next_terminal, successor_shell.next_pixel_x,
			successor_shell.next_pixel_y], [false, 2047, 1815]);

	let object_impact = BoloGame.build([
		{
			time: 90, seq: 90, status: 0, player: 1, tankStatus: 8, tankDir: 0,
			subpackets: [{
				type: "tank_position", x: 13, y: 11, pixelX: 0, pixelY: 0,
				direction: 0, inBoat: false, hidden: false, dying: false,
				speed: 0, motion: 0,
			}],
		},
		record(100, [shell_list(4, [[160, 160]])]),
		record(112, [shell_list(4, [[184, 166]])]),
		record(124, [{ type: "tank_hit", direction: 4, tank: 1 }]),
	]);
	check("object impact follows learned ray to object boundary",
		[rounded(position(object_impact, 118).x),
			rounded(position(object_impact, 118).y)], [12.7276, 11.0569]);
	check("shell disappears upon reaching object impact",
		position(object_impact, 121), null);

	let duplicate_impacts = BoloGame.build([
		record(100, [shell_list(4, [[160, 156], [160, 164]])]),
		record(112, [shell_list(4, [[184, 156], [184, 164]])]),
		record(124, [
			{ type: "explosion", code: 0, x: 13, y: 10 },
			{ type: "explosion", code: 0, x: 13, y: 10 },
		]),
	]);
	check("duplicate impacts preserve their terminal multiplicity",
		[rounded(position(duplicate_impacts, 118, 0, 0).x),
			rounded(position(duplicate_impacts, 118, 0, 1).x)], [12.75, 12.75]);
	check("both shells disappear at duplicate impacts",
		[position(duplicate_impacts, 121, 0, 0),
			position(duplicate_impacts, 121, 0, 1)], [null, null]);

	let boundary_impact = BoloGame.build([
		record(100, [shell_list(13, [[1972, 1794]])]),
		record(112, [shell_list(13, [[1951, 1784]])]),
		record(124, [{ type: "explosion", code: 0, x: 122, y: 111 }]),
	]);
	check("shell already at impact boundary disappears immediately",
		position(boundary_impact, 112), null);

	let equivalent_impact = BoloGame.build([
		record(100, [shell_list(13, [[1993, 1804]])]),
		record(112, [shell_list(13, [[1972, 1794]])]),
		record(124, [
			shell_list(13, [[1951, 1784]]),
			{ type: "explosion", code: 0, x: 122, y: 111 },
		]),
		record(136, [{ type: "explosion", code: 0, x: 121, y: 111 }]),
	]);
	check("equivalent successor wins without losing the learned heading",
		position(equivalent_impact, 130), null);

	let pillbox_burst = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 4 },
			{ type: "pillbox_fires", pillbox: 0, direction: 4 },
			shell_list(4, [[183, 160], [175, 160]]),
		]),
		record(112, [
			{ type: "pillbox_fires", pillbox: 0, direction: 4 },
			{ type: "pillbox_fires", pillbox: 0, direction: 4 },
			shell_list(4, [[207, 161], [199, 161], [175, 160]]),
			{ type: "explosion", code: 0, x: 13, y: 10 },
		]),
	]);
	check("pillbox source resolves a dense anonymous shell burst",
		[rounded(position(pillbox_burst, 106, 0, 0).x),
			rounded(position(pillbox_burst, 106, 0, 1).x)], [12.6875, 12.3125]);

	/* A pill shot can fire and hit terrain entirely between restatements. Its
	 * F4 and explosion remain in the record, but it never has a shell-list
	 * position. That directionless explosion must not steal an opposing
	 * tank shell's otherwise unambiguous successor. */
	let unseen_pill_impact = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 117, y: 138, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(88, [shell_list(4, [[1794, 2220]])]),
		record(100, [shell_list(4, [[1818, 2218]])]),
		record(112, [
			{ type: "pillbox_fires", pillbox: 0, direction: 12 },
			{ type: "pillbox_fires", pillbox: 0, direction: 12 },
			shell_list(4, [[1846, 2217]]),
			shell_list(12, [[1852, 2208]]),
			{ type: "explosion", code: 0, x: 115, y: 138 },
		]),
	]);
	let opposing_shell = unseen_pill_impact.shell_positions[0][1].shells[0];
	check("unseen pill impact does not steal opposing shell successor",
		[!!opposing_shell.next_terminal, opposing_shell.next_pixel_x,
			unseen_pill_impact.shell_positions[0][2].shells[0].matched_from_previous],
		[false, 1846, true]);

	let unseen_with_duplicate_impact = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 117, y: 138, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(88, [shell_list(4, [[1794, 2220]])]),
		record(100, [shell_list(4, [[1818, 2218]])]),
		record(112, [
			{ type: "pillbox_fires", pillbox: 0, direction: 12 },
			{ type: "pillbox_fires", pillbox: 0, direction: 12 },
			shell_list(12, [[1852, 2208]]),
			{ type: "explosion", code: 0, x: 115, y: 138 },
			{ type: "explosion", code: 0, x: 115, y: 138 },
		]),
	]);
	let duplicate_terminals = unseen_with_duplicate_impact
		.shell_positions[0][2].terminals;
	check("unseen pill impact consumes only its terminal multiplicity",
		[duplicate_terminals.filter(terminal =>
			terminal.unseen_pillbox_source).length,
			duplicate_terminals.filter(terminal =>
				terminal.match_time !== undefined).length,
			!!unseen_with_duplicate_impact.shell_positions[0][1]
				.shells[0].next_terminal], [1, 1, true]);

	/* When a tracked pill stream reaches several identical impacts, its
	 * leading shells terminate and a younger shell with a real successor must
	 * keep that successor. Pure cost matching gets this backwards because an
	 * event can be logged well after the leading shell reached the tile. */
	let ordered_pill_impacts = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 117, y: 138, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(88, [shell_list(4, [[1786, 2220]])]),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 12 },
			{ type: "pillbox_fires", pillbox: 0, direction: 12 },
			{ type: "pillbox_fires", pillbox: 0, direction: 12 },
			shell_list(4, [[1810, 2218]]),
			shell_list(12, [[1840, 2211], [1852, 2210], [1860, 2209]]),
		]),
		record(112, [
			shell_list(4, [[1834, 2217]]),
			shell_list(12, [[1836, 2212]]),
			{ type: "explosion", code: 0, x: 114, y: 138 },
			{ type: "explosion", code: 0, x: 114, y: 138 },
		]),
	]);
	let ordered_previous = ordered_pill_impacts.shell_positions[0][1].shells;
	check("ordered pill impacts leave opposing successor intact",
		[!!ordered_previous[0].next_terminal, ordered_previous[0].next_pixel_x,
			ordered_previous.slice(1).map(shell =>
				shell.next_terminal ? "terminal" :
					shell.next_time === 112 ? "snapshot" : "unmatched")],
		[false, 1834, ["terminal", "terminal", "snapshot"]]);

	let ordered_tank_impacts = BoloGame.build([
		record(60, [{ type: "pillbox_list", items: [{
			x: 117, y: 138, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(64, [{
			type: "tank_position", x: 111, y: 138,
			pixelX: 0, pixelY: 8, direction: 4,
			inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}]),
		record(76, [
			{ type: "shot_fired", direction: 4 },
			shell_list(4, [[1814, 2216]]),
		]),
		record(88, [
			{ type: "shot_fired", direction: 4 },
			shell_list(4, [[1838, 2216], [1814, 2216]]),
		]),
		record(100, [shell_list(4, [[1862, 2216], [1838, 2216]])]),
		record(112, [
			{ type: "pillbox_damage", pillbox: 0 },
			shell_list(4, [[1862, 2216]]),
		]),
	]);
	let tank_stream = ordered_tank_impacts.shell_positions[0][3].shells;
	check("ordered tank impact leaves younger successor intact",
		[tank_stream[0].next_terminal,
			!!tank_stream[1].next_terminal,
			tank_stream[1].next_pixel_x], [true, false, 1862]);

	let pillbox_direction_zero = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [
			{ x: 10, y: 10, owner: 1, armour: 15, speed: 100 },
			{ x: 30, y: 30, owner: 1, armour: 15, speed: 100 },
		] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 1, direction: 0 },
			shell_list(0, [[160, 152]]),
		]),
	]);
	let direction_zero_shell = pillbox_direction_zero.shell_positions[0][1].shells[0];
	check("direction-zero pill fire falls back to the preceding pill",
		[direction_zero_shell.pillbox_source_x,
			direction_zero_shell.pillbox_source_y], [160, 160]);

	let pillbox_refinement = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 4 },
			shell_list(4, [[167, 160]]),
		]),
		record(112, [shell_list(4, [[191, 160]])]),
	]);
	let refined_pillbox_shell = pillbox_refinement.shell_positions[0][2].shells[0];
	check("pillbox heading keeps refining from its source",
		[rounded(refined_pillbox_shell.heading_x),
			rounded(refined_pillbox_shell.heading_y),
			refined_pillbox_shell.heading_origin_x,
			refined_pillbox_shell.heading_origin_y], [1, 0, 160, 160]);

	let overlapping_pill_orbits = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 0 },
			shell_list(0, [[160, 152]]),
		]),
		record(122, [shell_list(0, [[164, 108]])]),
	]);
	let overlapping_start = overlapping_pill_orbits.shell_positions[0][1].shells[0];
	let narrowed_orbit = overlapping_pill_orbits.shell_positions[0][2].shells[0];
	check("overlapping muzzle positions retain every possible pill orbit",
		overlapping_start.pillbox_orbit_states.map(state => state.bradian),
		[1, 3, 5]);
	check("later pill position narrows the exact fine direction",
		[narrowed_orbit.matched_from_previous,
			narrowed_orbit.pillbox_orbit_states],
		[true, [{ bradian: 3, step: 11 }]]);

	let viable_pill_orbit = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 5 },
			shell_list(5, [[173, 167]]),
		]),
		record(108, [shell_list(5, [[187, 175]])]),
	]);
	check("pill shell matches an exact later orbit position",
		viable_pill_orbit.shell_positions[0][1].shells[0].next_time, 108);

	let impossible_pill_orbit = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 5 },
			shell_list(5, [[173, 167]]),
		]),
		record(108, [shell_list(5, [[186, 175]])]),
	]);
	check("pill shell rejects a nearby point absent from every surviving orbit",
		impossible_pill_orbit.shell_positions[0][1].shells[0].next_time,
		undefined);

	let offset_constrained_orbits = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 13 },
			{ type: "pillbox_fires", pillbox: 0, direction: 13 },
			shell_list(13, [[152, 158], [148, 157]]),
		]),
	]);
	check("raw chained offset narrows overlapping orbit positions",
		offset_constrained_orbits.shell_positions[0][1].shells.map(shell =>
			shell.pillbox_orbit_states), [
			[{ bradian: 201, step: 0 }],
			[{ bradian: 201, step: 1 }],
		]);

	let wrong_sign_pill_orbit = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 13 },
			{ type: "pillbox_fires", pillbox: 0, direction: 13 },
			shell_list(13, [[152, 158], [149, 158]]),
		]),
	]);
	check("chained uncertainty rejects an orbit below its reconstruction",
		wrong_sign_pill_orbit.shell_positions[0][1].shells.map(shell =>
			!!shell.starts_at_pillbox), [true, false]);

	/* Only a shell list's head has an absolute pixel coordinate. Later
	 * members are reconstructed from quantised, chained offsets, so the nth
	 * member can differ from its exact orbit point by up to n pixels per
	 * axis. These two streams are bradians 209 and 207 respectively; the
	 * second is deliberately one pixel off at every restatement. */
	let quantised_pill_orbits = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 13 },
			{ type: "pillbox_fires", pillbox: 0, direction: 13 },
			shell_list(13, [[145, 153], [144, 153]]),
		]),
		record(110, [shell_list(13, [[127, 145], [125, 146]])]),
		record(120, [shell_list(13, [[109, 138], [107, 138]])]),
		record(130, [shell_list(13, [[91, 130], [88, 131]])]),
		record(140, [shell_list(13, [[72, 122], [70, 124]])]),
		record(150, [shell_list(13, [[54, 114], [52, 117]])]),
		record(160, [shell_list(13, [[40, 108], [37, 111]])]),
		record(162, [
			{ type: "shell_falls", x: 2, y: 6, pixel: 0xa4 },
			{ type: "shell_falls", x: 2, y: 6, pixel: 0xf2 },
		]),
	]);
	let quantised_streams = quantised_pill_orbits.shell_positions[0][7].shells;
	check("quantised chained pill positions retain their exact orbits",
		quantised_streams.map(shell => shell.pillbox_orbit_states), [
			[{ bradian: 209, step: 31 }],
			[{ bradian: 207, step: 31 }],
		]);
	check("unique pill orbits recover exact pixels from quantised members",
		quantised_streams.map(shell => [shell.pixel_x, shell.pixel_y,
			shell.pillbox_orbit_pixel_x, shell.pillbox_orbit_pixel_y]), [
			[40, 108, 40, 108],
			[37, 111, 38, 112],
		]);
	check("known exact pill position replaces its lossy rendered coordinate",
		[rounded(position(quantised_pill_orbits, 160, 0, 1).x),
			rounded(position(quantised_pill_orbits, 160, 0, 1).y)],
		[2.875, 7.5]);
	check("quantised pill streams reach their distinct range expiries",
		quantised_streams.map(shell => [shell.next_terminal,
			shell.next_pixel_x, shell.next_pixel_y]), [
			[true, 36, 106],
			[true, 34, 111],
		]);

	let viable_pill_terminal = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 5 },
			shell_list(5, [[173, 167]]),
		]),
		record(124, [shell_list(5, [[215, 191]])]),
		record(148, [shell_list(5, [[257, 215]])]),
		record(160, [{ type: "shell_falls", x: 17, y: 14, pixel: 0x36 }]),
	]);
	check("pill shell accepts its exact range-expiry coordinate",
		viable_pill_terminal.shell_positions[0][3].shells[0]
			.next_terminal_type, "point");

	let impossible_pill_terminal = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 5 },
			shell_list(5, [[173, 167]]),
		]),
		record(124, [shell_list(5, [[215, 191]])]),
		record(148, [shell_list(5, [[257, 215]])]),
		record(158, [{ type: "shell_falls", x: 17, y: 14, pixel: 0x13 }]),
	]);
	check("pill shell rejects FB at a pre-expiry orbit position",
		impossible_pill_terminal.shell_positions[0][3].shells[0].next_time,
		undefined);

	let viable_pill_box = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 5 },
			shell_list(5, [[187, 175]]),
		]),
		record(125, [{ type: "explosion", code: 0, x: 15, y: 13 }]),
	]);
	check("pill shell accepts a tile entered by its discrete orbit",
		viable_pill_box.shell_positions[0][1].shells[0].next_terminal_type,
		"box");

	let impossible_pill_box = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 5 },
			shell_list(5, [[187, 175]]),
		]),
		record(125, [{ type: "explosion", code: 0, x: 15, y: 12 }]),
	]);
	check("pill shell rejects a tile its continuous ray only grazes",
		impossible_pill_box.shell_positions[0][1].shells[0].next_time,
		undefined);

	let moving_tank_hit = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 137, y: 116, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 13 },
			shell_list(13, [[2185, 1851]]),
		]),
		record(110, [shell_list(13, [[2168, 1841]])]),
		record(120, [shell_list(13, [[2151, 1830]])]),
		record(130, [shell_list(13, [[2134, 1819]])]),
		record(138, [{
			type: "tank_position", x: 131, y: 112, pixelX: 10, pixelY: 8,
			direction: 0, inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}, shell_list(13, [[2121, 1811]])]),
		record(159, [{
			type: "tank_position", x: 130, y: 112, pixelX: 8, pixelY: 13,
			direction: 0, inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}, { type: "tank_hit", direction: 13, tank: 0 }]),
	]);
	let moving_tank_shell = moving_tank_hit.shell_positions[0][5].shells[0];
	check("pill shell hits the tank's interpolated square",
		moving_tank_shell.next_terminal_event_type, "tank_hit");
	check("moving tank impact is backdated to the orbit collision",
		rounded(moving_tank_shell.next_time), 143.831);
	let moving_tank_effect = moving_tank_hit.effects.find(effect =>
		effect.type === "tank_hit");
	let hitbox_x = moving_tank_effect.x * 16 + moving_tank_effect.px;
	let hitbox_y = moving_tank_effect.y * 16 + moving_tank_effect.py;
	check("tank-hit effect follows the interpolated tank position", [
		moving_tank_shell.next_pixel_x + 8 >= hitbox_x - 2 &&
			moving_tank_shell.next_pixel_x + 8 < hitbox_x + 18,
		moving_tank_shell.next_pixel_y + 8 >= hitbox_y - 2 &&
			moving_tank_shell.next_pixel_y + 8 < hitbox_y + 18,
	], [true, true]);

	let near_corner_tank_hit = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 116, y: 122, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(100, []),
		record(110, [
			{ type: "pillbox_fires", pillbox: 0, direction: 2 },
			shell_list(2, [[1869, 1937]]),
		]),
		record(128, [shell_list(2, [[1892, 1910]])]),
		record(146, [{
			type: "tank_position", x: 119, y: 116, pixelX: 14, pixelY: 11,
			direction: 1, inBoat: false, hidden: false, dying: false,
			speed: 64, motion: 0,
		}, shell_list(2, [[1916, 1883]])]),
		record(165, [{
			type: "tank_position", x: 120, y: 115, pixelX: 5, pixelY: 11,
			direction: 1, inBoat: false, hidden: false, dying: false,
			speed: 64, motion: 0,
		}, { type: "tank_hit", direction: 2, tank: 0 }]),
	]);
	let near_corner_shell = near_corner_tank_hit.shell_positions[0][3].shells[0];
	check("two-pixel tank-hit tolerance recovers a near-corner orbit hit",
		[near_corner_shell.next_terminal_event_type,
			near_corner_shell.next_pixel_x, near_corner_shell.next_pixel_y],
		["tank_hit", 1929, 1868]);

	let pill_orbit_overrules_ray = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 0 },
			shell_list(0, [[162, 140]]),
		]),
		record(124, [{ type: "explosion", code: 0, x: 11, y: 6 }]),
	]);
	check("exact pill orbit is not vetoed by its learned continuous ray",
		pill_orbit_overrules_ray.shell_positions[0][1].shells[0]
			.next_terminal_type, "box");

	let tank_muzzle = BoloGame.build([
		record(90, [{
			type: "tank_position", x: 10, y: 10, pixelX: 0, pixelY: 0,
			direction: 4, inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}]),
		record(100, [
			{ type: "shot_fired", direction: 4 },
			shell_list(4, [[168, 160]]),
		]),
	]);
	check("tank shot starts at the muzzle before its first restatement",
		BoloGame.shell_birth_positions_at(tank_muzzle, 0, 98).map(shell =>
			[rounded(shell.x), rounded(shell.y), shell.direction]),
		[[10.75, 10.5, 4]]);
	check("synthetic muzzle segment hands off at the real restatement",
		BoloGame.shell_birth_positions_at(tank_muzzle, 0, 100), []);

	let pillbox_muzzle = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 4 },
			shell_list(4, [[167, 160]]),
		]),
	]);
	check("pillbox shot starts at its source before its first restatement",
		BoloGame.shell_birth_positions_at(pillbox_muzzle, 0, 98).map(shell =>
			[rounded(shell.x), rounded(shell.y), shell.direction]),
		[[10.6875, 10.5, 4]]);
	check("synthetic pillbox segment hands off at the real restatement",
		BoloGame.shell_birth_positions_at(pillbox_muzzle, 0, 100), []);

	let quantised_pillbox_muzzle = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(90, []),
		record(100, [
			{ type: "pillbox_fires", pillbox: 0, direction: 13 },
			{ type: "pillbox_fires", pillbox: 0, direction: 13 },
			shell_list(13, [[145, 153], [144, 153]]),
		]),
	]);
	check("quantised pillbox muzzle segment reaches exact orbit positions",
		BoloGame.shell_birth_positions_at(quantised_pillbox_muzzle, 0,
			99.999999).map(shell => [rounded(shell.x), rounded(shell.y)]), [
			[9.5625, 10.0625],
			[9.5625, 10.125],
		]);

	/* A shot whose first restatement arrives a whole flight later: the
	 * residual pass claims it to the unclaimed F4 (131px on an exact
	 * direction-4 orbit point, a 65.5-tick birth span). The sampler's
	 * forward scan must cover such long spans, or the shell is invisible
	 * for the early part of its drawn flight and pops in mid-air. */
	let late_first_restatement = BoloGame.build([
		record(80, [{ type: "pillbox_list", items: [{
			x: 10, y: 10, owner: 1, armour: 15, speed: 100,
		}] }]),
		record(100, [{ type: "pillbox_fires", pillbox: 0, direction: 4 }]),
		record(166, [shell_list(4, [[291, 157]])]),
	]);
	check("long-span birth segment is drawn right from the muzzle",
		BoloGame.shell_birth_positions_at(late_first_restatement, 0, 102)
			.map(shell => [rounded(shell.x), rounded(shell.y), shell.direction]),
		[[10.6896, 10.4957, 4]]);
	check("long-span birth segment hands off at the real restatement",
		BoloGame.shell_birth_positions_at(late_first_restatement, 0, 166), []);

	let tank_refinement = BoloGame.build([
		record(90, [{
			type: "tank_position", x: 10, y: 10, pixelX: 0, pixelY: 0,
			direction: 4, inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}]),
		record(100, [
			{ type: "shot_fired", direction: 4 },
			shell_list(4, [[168, 162]]),
		]),
		record(112, [shell_list(4, [[192, 160]])]),
	]);
	let refined_tank_shell = tank_refinement.shell_positions[0][2].shells[0];
	check("tank heading keeps refining from its preserved birth origin",
		[rounded(refined_tank_shell.heading_x),
			rounded(refined_tank_shell.heading_y),
			refined_tank_shell.birth_pixel_x,
			refined_tank_shell.birth_pixel_y], [1, 0, 160, 160]);

	let moving_tank_muzzle = BoloGame.build([
		record(90, [{
			type: "tank_position", x: 10, y: 8, pixelX: 0, pixelY: 12,
			direction: 4, inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}]),
		record(100, [{
			type: "tank_position", x: 10, y: 10, pixelX: 0, pixelY: 0,
			direction: 4, inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}, {
			type: "shot_fired", direction: 4,
		}, shell_list(4, [[168, 160]])]),
	]);
	let refined_shell = moving_tank_muzzle.shell_positions[0][1].shells[0];
	check("moving-tank muzzle refinement stays inside its direction sector",
		[rounded(refined_shell.heading_x), rounded(refined_shell.heading_y)], [1, 0]);

	let early_tank_hit = BoloGame.build([
		record(90, [shell_list(4, [[120, 160]])], 0),
		record(100, [{
			type: "tank_position", x: 10, y: 10, pixelX: 0, pixelY: 0,
			direction: 4, inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}], 1),
		record(100, [shell_list(4, [[144, 160]])], 0),
		record(110, [{ type: "tank_hit", direction: 4, tank: 1 }], 0),
	]);
	let hit_effect = early_tank_hit.effects.find(effect =>
		effect.type === "tank_hit");
	check("matched impact effect starts at shell arrival",
		hit_effect.time, 104);

	let coarse_only_impact = BoloGame.build([
		record(112, [shell_list(4, [[184, 166]])]),
		record(124, [{ type: "explosion", code: 0, x: 13, y: 11 }]),
	]);
	check("tile impact without fine heading stays at final frame",
		[rounded(position(coarse_only_impact, 118).x),
			rounded(position(coarse_only_impact, 118).y)], [12, 10.875]);

	let separate_clients = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])], 0),
		record(112, [shell_list(4, [[184, 160]])], 1),
	]);
	check("shell identities do not migrate between clients",
		rounded(position(separate_clients, 106).x), 10.5);
}

// Tank positions interpolate between nearby restatements. A long lag, or a
// discontinuity such as death, leaves the tank at its last known position.
{
	const position = (time, x, pixel_x = 0) => ({
		time, seq: time, status: 0, player: 0, tankStatus: 8, tankDir: 4,
		subpackets: [{
			type: "tank_position", x, y: 10, pixelX: pixel_x, pixelY: 0,
			direction: 4, inBoat: false, hidden: false, dying: false,
			speed: 100, motion: 0,
		}],
	});
	const centre_x = (game, tick) => {
		const state = BoloGame.state_at(game, tick).state;
		return BoloGame.tank_position_at(game, state, 0, tick).x;
	};

	let smooth = BoloGame.build([position(100, 10), position(112, 10, 12)]);
	check("tank movement interpolates", centre_x(smooth, 106), 10.875);

	let lag = BoloGame.build([
		position(100, 10),
		position(100 + BoloGame.MAX_POSITION_INTERPOLATION_TICKS + 1, 12),
	]);
	check("tank stops across lag", centre_x(lag, 110), 10.5);

	let death = BoloGame.build([
		position(100, 10),
		{ time: 105, seq: 105, status: 0, player: 0, tankStatus: 7, tankDir: 4,
			subpackets: [{ type: "tank_death", code: 1 }] },
		position(112, 11),
	]);
	check("tank does not interpolate across death", centre_x(death, 104), 10.5);
}

// Tank headings interpolate through the 16 actual sprite directions. The
// direction track includes position-less updates and wraps by the short arc.
{
	let position = (time, direction) => ({
		time, seq: time, status: 0, player: 0, tankStatus: 8, tankDir: direction,
		subpackets: [{
			type: "tank_position", x: 10, y: 10, pixelX: 0, pixelY: 0,
			direction, inBoat: false, hidden: false, dying: false,
			speed: 0, motion: 0,
		}],
	});
	let direction_at = (game, tick) => {
		let state = BoloGame.state_at(game, tick).state;
		return BoloGame.tank_position_at(game, state, 0, tick).direction;
	};

	let turning = BoloGame.build([
		position(100, 0),
		{ time: 112, seq: 112, status: 0, player: 0, tankStatus: 0,
			tankDir: 4, subpackets: [] },
	]);
	check("tank direction interpolates position-less updates",
		[direction_at(turning, 103), direction_at(turning, 106),
			direction_at(turning, 109), direction_at(turning, 112)],
		[1, 2, 3, 4]);

	let clockwise_wrap = BoloGame.build([position(100, 15), position(112, 1)]);
	check("tank direction interpolates clockwise across north",
		direction_at(clockwise_wrap, 106), 0);

	let anticlockwise_wrap = BoloGame.build([position(100, 1), position(112, 15)]);
	check("tank direction interpolates anticlockwise across north",
		direction_at(anticlockwise_wrap, 106), 0);

	/* Facing has a longer window than position: a tank silent for more than
	 * half a second was still turning at a bounded rate, so the intermediate
	 * angles remain a safe reconstruction where an unseen path is not. */
	let long_turn = BoloGame.build([position(100, 0), position(140, 12)]);
	check("tank direction interpolates past the position window",
		[direction_at(long_turn, 110), direction_at(long_turn, 130)], [15, 13]);

	let lag = BoloGame.build([
		position(100, 0),
		position(100 + BoloGame.MAX_DIRECTION_INTERPOLATION_TICKS + 1, 4),
	]);
	check("tank direction stops across lag", direction_at(lag, 110), 0);
}

// LGMs use the same conservative interpolation window, but walking and
// parachuting are distinct paths and entering the tank ends a path.
{
	const position = (time, x, pixel_x = 0, parachute = false) => ({
		time, seq: time, status: parachute ? 4 : 8, player: 0,
		tankStatus: 0, tankDir: 0,
		subpackets: [{
			type: parachute ? "parachute_position" : "lgm_position",
			x, y: 10, pixelX: pixel_x, pixelY: 0, carryingPill: false,
		}],
	});
	const centre_x = (game, tick) => {
		const state = BoloGame.state_at(game, tick).state;
		return BoloGame.lgm_position_at(game, state, 0, tick).x;
	};

	let smooth = BoloGame.build([position(100, 10), position(112, 10, 12)]);
	check("LGM movement interpolates", centre_x(smooth, 106), 10.875);

	let lag = BoloGame.build([
		position(100, 10),
		position(100 + BoloGame.MAX_POSITION_INTERPOLATION_TICKS + 1, 12),
	]);
	check("LGM stops across lag", centre_x(lag, 110), 10.5);

	let tank_entry = BoloGame.build([
		{ time: 90, seq: 90, status: 0, player: 0, tankStatus: 8, tankDir: 0,
			subpackets: [{
				type: "tank_position", x: 10, y: 10, pixelX: 0, pixelY: 0,
				direction: 0, inBoat: false, hidden: false, dying: false,
				speed: 0, motion: 0,
			}] },
		position(100, 10),
		{ time: 112, seq: 112, status: 0, player: 0, tankStatus: 8,
			tankDir: 0, subpackets: [{
				type: "tank_position", x: 11, y: 10, pixelX: 0, pixelY: 0,
				direction: 0, inBoat: false, hidden: false, dying: false,
				speed: 0, motion: 0,
			}] },
	]);
	check("LGM interpolates to tank on entry", centre_x(tank_entry, 106), 11);
	check("LGM disappears at tank entry",
		BoloGame.lgm_position_at(tank_entry,
			BoloGame.state_at(tank_entry, 111).state, 0, 112), null);

	let delayed_entry = BoloGame.build([
		{ time: 90, seq: 90, status: 0, player: 0, tankStatus: 8, tankDir: 0,
			subpackets: [{
				type: "tank_position", x: 11, y: 10, pixelX: 0, pixelY: 0,
				direction: 0, inBoat: false, hidden: false, dying: false,
				speed: 0, motion: 0,
			}] },
		position(100, 10),
		{ time: 150, seq: 150, status: 0, player: 0, tankStatus: 0,
			tankDir: 0, subpackets: [] },
	]);
	check("delayed tank entry caps final LGM interpolation",
		BoloGame.lgm_position_at(delayed_entry,
			BoloGame.state_at(delayed_entry, 126).state, 0, 126), null);

	let touchdown = BoloGame.build([
		position(100, 10, 0, true),
		position(112, 11),
	]);
	check("LGM does not interpolate across touchdown", centre_x(touchdown, 106), 10.5);
}

// Every pill_plant must find a carried pill: a tank death while the man is
// out carrying (status C) must not dump the pill in the man's hands.
if (fs.existsSync(path.join(__dirname, "..", "fixtures", "n20021018.2"))) {
	const recs = [...BoloLog.records(new Uint8Array(fs.readFileSync(path.join(__dirname, "..", "fixtures", "n20021018.2"))))];
	const st = BoloGame.initial_state(BoloGame.extract_initial_map(recs));
	let noop = 0;
	for (const r of recs) {
		for (const sub of r.subpackets) {
			if (sub.type === "pill_plant" && !st.pills.some(p => p.inTank === r.player)) noop++;
		}
		BoloGame.apply_record(st, r, null, null);
	}
	check("no pill_plant is a no-op (man keeps his pill through tank death)", noop, 0);
}

// Standalone map/node records carry no player state: they must not clear
// the sender's man (nor shells), but any record still proves liveness.
{
	const st = BoloGame.initial_state();
	st.tanks[0] = { x: 100, y: 100, px: 0, py: 0, dir: 0, inBoat: false, hidden: false, dying: false, speed: 0, lastSeen: 0, dead: false };
	st.men[0] = { x: 101, y: 100, px: 0, py: 0, parachute: false, carryingPill: false, lastSeen: 0 };
	BoloGame.apply_record(st, {
		time: 500, seq: 0, status: 0, player: 0, tankStatus: 7, tankDir: 0,
		subpackets: [{ type: "map_run", mapKnown: 0, run: [4, 0, 0, 0] }],
	}, null, null);
	check("map-run record leaves the man alone", st.men[0] !== null, true);
	check("map-run record still proves liveness", st.tanks[0].lastSeen, 500);
}

// Leaving an alliance: planted pills remain with the alliance (manual:
// "any active ones on the map remain with the members"), carried pills
// leave with the player.
{
	const st = BoloGame.initial_state();
	for (let p = 0; p < 3; p++) { st.present[p] = true; st.names[p] = "p" + p; }
	/* allies: 1 and 2 (mutual zero bits) */
	st.alliances[1] &= ~(1 << 2);
	st.alliances[2] &= ~(1 << 1);
	st.pills = [
		{ x: 10, y: 10, owner: 1, armour: 15, speed: 50, inTank: null }, /* planted, leaver's */
		{ x: 0, y: 0, owner: 1, armour: 15, speed: 50, inTank: 1 },      /* carried by leaver */
		{ x: 20, y: 20, owner: 2, armour: 15, speed: 50, inTank: null }, /* the ally's own */
	];
	BoloGame.apply_record(st, {
		time: 0, seq: 0, status: 0, player: 1, tankStatus: 0, tankDir: 0,
		subpackets: [{ type: "alliance_leave" }],
	}, null, null);
	check("planted pill stays with the alliance", st.pills[0].owner, 2);
	check("carried pill leaves with the player", st.pills[1].owner, 1);
	check("ally's own pill untouched", st.pills[2].owner, 2);
}

// A map run whose final nibble is a repeat code (its terrain nibble
// truncated off) must stop without writing pad/undefined squares (which a
// Uint8Array would store as 0 = building), and flag the run.
{
	const recs = [{
		time: 0, player: 0, status: 0, tankStatus: 0, subpackets: [
			{ type: "map_run", mapKnown: 0, run: [6, 50, 10, 20, 0x11, 0x19] },
		],
	}];
	const seed = BoloGame.extract_initial_map(recs);
	const row = [];
	for (let x = 10; x < 20; x++) row.push(seed.grid[50 * 256 + x]);
	check("truncated repeat writes only its complete pairs", row, [1, 1, 255, 255, 255, 255, 255, 255, 255, 255]);
	check("truncated run flagged", seed.badRuns, 1);
}

// Network conditions: a sequence step of n leaves n-1 packets unaccounted
// for, gaps over half a second count as freezes, and the verdict is the
// worse of the two readings.
{
	// A clean ring: every step 1, every gap 2 ticks.
	let clean = [];
	for (let i = 0; i < 2000; i++) clean.push({ time: 1000 + i * 2, seq: i & 0x7f, subpackets: [] });
	let net = BoloNetwork.network_conditions(clean);
	check("clean ring loses nothing", net.loss, 0);
	check("clean ring never freezes", net.stall, 0);
	check("clean ring rates good", net.rating, "good");

	// Every other packet missed: half the ring's slots are holes.
	let lossy = [];
	for (let i = 0; i < 2000; i++) lossy.push({ time: 1000 + i * 4, seq: (i * 2) & 0x7f, subpackets: [] });
	check("every other packet missed reads as 50% loss",
		Math.round(BoloNetwork.network_conditions(lossy).loss), 50);
	check("50% loss rates awful", BoloNetwork.network_conditions(lossy).rating, "awful");

	// Loss alone can damn a log the freeze reading would pass: these arrive
	// steadily, 2 ticks apart, so nothing is ever silent for half a second.
	check("steady choppiness never stalls", BoloNetwork.network_conditions(lossy).stall, 0);

	// Freezes alone can damn one the loss reading would pass. Steps stay at
	// 1 throughout; a third of the time is spent waiting.
	let frozen = [];
	for (let i = 0, t = 1000; i < 2000; i++) {
		frozen.push({ time: t, seq: i & 0x7f, subpackets: [] });
		t += i % 10 === 9 ? 60 : 2;   /* a 1.2 s freeze every tenth packet */
	}
	let net2 = BoloNetwork.network_conditions(frozen);
	check("freezes with no loss still lose nothing", net2.loss, 0);
	check("freezes are counted as lost time", net2.stall > 25, true);
	check("freezes alone can rate awful", net2.rating, "awful");

	// A duplicate (step 0) is not a loss, and a step across a long silence
	// is a rejoin whose 7-bit counter may have wrapped: neither is charged.
	check("a duplicate is not a loss", BoloNetwork.network_conditions([
		{ time: 1000, seq: 5, subpackets: [] }, { time: 1002, seq: 5, subpackets: [] },
		{ time: 1004, seq: 6, subpackets: [] },
	]).loss, 0);
	check("a step across a long silence is not a loss", BoloNetwork.network_conditions([
		{ time: 1000, seq: 5, subpackets: [] }, { time: 9000, seq: 40, subpackets: [] },
		{ time: 9002, seq: 41, subpackets: [] },
	]).loss, 0);

	// Too little to say anything about.
	check("no records, no verdict", BoloNetwork.network_conditions([]), null);
	check("one record, no verdict", BoloNetwork.network_conditions([{ time: 1, seq: 0, subpackets: [] }]), null);
	check("no elapsed time, no verdict", BoloNetwork.network_conditions([
		{ time: 5, seq: 0, subpackets: [] }, { time: 5, seq: 1, subpackets: [] },
	]), null);

	// The gathering phase -- the ring at full speed while the logger catches
	// only a fraction of it -- must not be charged as loss. Two minutes of
	// one-in-five recorded, then a clean ring; the first base capture marks
	// where the game proper begins.
	function gathering(mark_capture) {
		let recs = [];
		for (let i = 0, seq = 0; i < 1200; i++, seq += 5)
			recs.push({ time: 1000 + i * 5, seq: seq & 0x7f, subpackets: [] });
		let after = recs[recs.length - 1].time;
		for (let i = 1; i <= 12000; i++)
			recs.push({ time: after + i * 2, seq: i & 0x7f, subpackets: [] });
		if (mark_capture) recs[1200].subpackets = [{ type: "base_capture" }];
		return recs;
	}
	let capped = gathering(true);
	let ramp = BoloNetwork.network_conditions(capped);
	check("gathering is not charged as loss", ramp.loss, 0);
	check("the span starts at the first base capture", ramp.from, capped[1200].time);
	check("a slow-starting log still rates on its settled play", ramp.rating, "good");

	// With no base capture anywhere, the record rate has to stand in for it.
	let uncapped = BoloNetwork.network_conditions(gathering(false));
	check("no capture: the rate plateau stands in", uncapped.loss, 0);
	check("no capture: gathering still left outside the span",
		uncapped.from > gathering(false)[0].time, true);

	// A capture is only a start marker -- it must not shorten the span of a
	// game that was already up and running when the log begins.
	let running = [];
	for (let i = 0; i < 3000; i++)
		running.push({ time: 1000 + i * 2, seq: i & 0x7f, subpackets: [] });
	running[2000].subpackets = [{ type: "base_capture" }];
	check("a late capture still marks the start",
		BoloNetwork.network_conditions(running).from, running[2000].time);

	// The first quit ends the measured span: the ring is dissolving after
	// it, not failing.
	let quitting = [];
	for (let i = 0; i < 3000; i++)
		quitting.push({ time: 1000 + i * 2, seq: i & 0x7f, subpackets: [] });
	let quitAt = quitting[quitting.length - 1].time;
	quitting[quitting.length - 1].subpackets = [{ type: "quit" }];
	for (let i = 1; i <= 600; i++)
		quitting.push({ time: quitAt + i * 20, seq: (i * 9) & 0x7f, subpackets: [] });
	let ending = BoloNetwork.network_conditions(quitting);
	check("the span ends at the first quit", ending.to, quitAt);
	check("the exodus after it is not charged as loss", ending.loss, 0);
}

process.exit(failures ? 1 : 0);
