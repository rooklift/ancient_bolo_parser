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
	let tank_births = game.shell_births.reduce((count, births) =>
		count + births.length, 0);
	check("fixture shell interpolation remains broadly effective", [
		shell_metrics.total,
		shell_metrics.matched >= 67000,
		shell_metrics.falls >= 8000,
		tank_births >= 8500,
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
	check("fixture pillbox burst stays fully interpolated",
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

	let ambiguous = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(112, [shell_list(4, [[183, 160], [185, 160]])]),
	]);
	check("ambiguous shell identity holds its packet position",
		rounded(position(ambiguous, 106).x), 10.5);

	let lag = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(100 + BoloGame.MAX_POSITION_INTERPOLATION_TICKS + 1,
			[shell_list(4, [[208, 160]])]),
	]);
	check("shell stops across lag", rounded(position(lag, 112).x), 10.5);

	let precise_impact = BoloGame.build([
		record(100, [shell_list(4, [[160, 160]])]),
		record(112, [shell_list(4, [[184, 166]])]),
		record(124, [{ type: "shell_falls", x: 13, y: 10, pixel: 0xc0 }]),
	]);
	check("shell interpolates to precise ground impact",
		[rounded(position(precise_impact, 118).x),
			rounded(position(precise_impact, 118).y)], [12.75, 11.0625]);

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
			shell_list(4, [[184, 160], [176, 160]]),
		]),
		record(112, [
			{ type: "pillbox_fires", pillbox: 0, direction: 4 },
			{ type: "pillbox_fires", pillbox: 0, direction: 4 },
			shell_list(4, [[200, 160], [176, 160], [168, 160]]),
			{ type: "explosion", code: 0, x: 13, y: 10 },
		]),
	]);
	check("pillbox source resolves a dense anonymous shell burst",
		[rounded(position(pillbox_burst, 106, 0, 0).x),
			rounded(position(pillbox_burst, 106, 0, 1).x)], [12.75, 12.25]);

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
