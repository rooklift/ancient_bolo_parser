// Regression test for the viewer's replay engine (viewer/game.js), run
// headless against the sample log.

const fs = require("node:fs");
const path = require("node:path");
const BoloLog = require("../viewer/logparse.js");
const BoloGame = require("../viewer/game.js");

const root = path.join(__dirname, "..");
const log1 = path.join(root, "fixtures", "n20021018.2");

let failures = 0;
function check(what, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (wanted ${JSON.stringify(want)})`}`);
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
		position(100, 10),
		{ time: 105, seq: 105, status: 0, player: 0, tankStatus: 0,
			tankDir: 0, subpackets: [] },
		position(112, 11),
	]);
	check("LGM does not interpolate across tank entry", centre_x(tank_entry, 104), 10.5);

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

process.exit(failures ? 1 : 0);
