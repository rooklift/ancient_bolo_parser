"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Sound = require("../viewer/sound.js");
const Game = require("../viewer/game.js");

// The listener is the visible area: a view w by h tiles centred on (x, y).
let view_at = (x, y, w = 24, h = 16) => ({ left: x - w / 2, top: y - h / 2, right: x + w / 2, bottom: y + h / 2 });
let listener = view_at(50.5, 50.5);
let shot = { time: 10, kind: "shooting", player: 2, x: 50.5, y: 50.5 };
assert.equal(Sound.variant(shot, listener, -1), "shooting_near", "a free camera hears its own tank's shot as near, never self");
assert.equal(Sound.variant(shot, view_at(70.5, 50.5), -1), "shooting_far", "far is measured from the camera without a self tank");
assert.equal(Sound.variant(shot, view_at(90.5, 50.5), -1), "shooting_far", "off screen is far at any distance");
assert.equal(Sound.variant(shot, listener, 2), "shooting_self", "the locked player's shot is self");
assert.equal(Sound.variant(shot, listener, 1), "shooting_near");
assert.equal(Sound.variant({ ...shot, player: null }, listener, 2), "shooting_near");
assert.equal(Sound.variant(shot, view_at(62.5, 50.5), 1), "shooting_near", "on the left edge of the view is on screen");
assert.equal(Sound.variant(shot, view_at(62.6, 50.5), 1), "shooting_far", "just beyond the left edge is far");
assert.equal(Sound.variant(shot, view_at(38.6, 50.5), 1), "shooting_near", "just inside the right edge is near");
assert.equal(Sound.variant(shot, view_at(38.5, 50.5), 1), "shooting_far", "on the right edge is off screen, so far");
assert.equal(Sound.variant(shot, view_at(50.5, 58.5), 1), "shooting_near", "on the top edge is on screen");
assert.equal(Sound.variant(shot, view_at(50.5, 58.6), 1), "shooting_far", "just beyond the top edge is far");
assert.equal(Sound.variant(shot, view_at(50.5, 42.6), 1), "shooting_near", "just inside the bottom edge is near");
assert.equal(Sound.variant(shot, view_at(50.5, 42.5), 1), "shooting_far", "on the bottom edge is off screen, so far");
assert.equal(Sound.variant(shot, view_at(61.5, 57.5), 1), "shooting_near", "a screen corner is near");
assert.equal(Sound.variant(shot, view_at(63.5, 59.5), 1), "shooting_far", "just past a screen corner is far");
assert.equal(Sound.variant(shot, view_at(50.5, 50.5, 100, 100), 1), "shooting_near", "near depends on the view, not a fixed radius");
assert.equal(Sound.variant(shot, view_at(95.5, 50.5, 100, 100), 1), "shooting_near", "on screen is near even beyond 40 tiles");
assert.equal(Sound.variant(shot, view_at(66.5, 50.5), 1), "shooting_far");
assert.equal(Sound.variant(shot, view_at(240.5, 240.5), 1), "shooting_far", "the far side of the map is still far, not silent");
assert.equal(Sound.variant(shot, null, 2), null);
assert.equal(Sound.variant({ ...shot, kind: "hit_tank" }, listener, 2), "hit_tank_self");
for (let kind of ["bubbles", "man_lay_mine"]) {
	assert.equal(Sound.variant({ ...shot, kind }, view_at(66.5, 50.5), 1), null, kind + " has no far variant");
}

let played = [], audios = [];
let player = Sound.create_player(url => {
	let audio = { paused: true, currentTime: 0,
		play() { this.paused = false; played.push(url); return Promise.resolve(); },
		pause() { this.paused = true; },
	};
	audios.push(audio);
	return audio;
});
let events = [shot, { ...shot, time: 20 }];
let advance = (from, to, speed = 1, viewpoint = 2) => player.advance(events, from, to, speed, viewpoint, () => listener);
advance(0, 10);
advance(10, 11);
assert.equal(played.length, 1, "an event on a frame boundary only plays once");
advance(11, 20, 2);
assert.equal(played.length, 1, "fast playback is silent");
assert.ok(audios.every(a => a.paused), "fast playback stops existing sounds");
advance(20, 21);
assert.equal(played.length, 1, "returning to normal speed does not replay skipped sounds");
advance(20, 0);
assert.equal(played.length, 1, "backward movement is silent");
advance(0, 10, 0.5, 1);
assert.equal(played.at(-1), "sounds/shooting_near.wav", "slow playback uses the new viewpoint");
player.set_enabled(false);
advance(10, 20);
assert.equal(played.length, 2);
assert.ok(audios.every(a => a.paused));
player.set_enabled(true);
let before = played.length;
player.advance(Array.from({ length: 50 }, () => shot), 0, 10, 1, 2, () => listener);
assert.ok(audios.length <= 5, "simultaneous copies of each sound are bounded");
assert.equal(played.length - before, 50, "a full pool restarts a voice rather than dropping the trigger");
player.stop();
assert.ok(audios.every(a => a.paused));

// Each trigger gets its own bounded pitch variation, pooled voices included.
{
	let voices = [];
	let pitches = [0, 1, 0.5];
	let pitched = Sound.create_player(() => {
		let audio = { paused: true, currentTime: 0,
			play() { this.paused = false; return Promise.resolve(); },
			pause() { this.paused = true; },
		};
		voices.push(audio);
		return audio;
	}, () => pitches.shift());
	let pair = [{ ...shot, x: 40.5 }, { ...shot, x: 60.5 }];
	pitched.advance(pair, 0, 10, 1, -1, () => listener);
	assert.equal(voices.length, 2);
	assert.ok(voices.every(a => a.volume === 0.5), "half volume");
	assert.deepEqual(voices.map(a => a.playbackRate), [0.97, 1.03], "each sound gets its own bounded pitch variation");
	assert.ok(voices.every(a => a.preservesPitch === false), "rate variation changes pitch");
	pitched.stop();
	assert.ok(voices.every(a => a.paused));
	pitched.advance([{ ...shot, x: 60.5 }], 0, 10, 1, -1, () => listener);
	assert.equal(voices.length, 2, "a stopped voice is reused");
	assert.equal(voices[0].playbackRate, 1, "a reused voice gets a fresh pitch");
	pitched.set_enabled(false);
	assert.ok(voices.every(a => a.paused));
	// With every voice busy, each new trigger restarts the one that has
	// played longest, in rotation.
	pitched.set_enabled(true);
	pitches.push(...Array(8).fill(0.5));
	let restarts = () => voices.map(a => a.restarts);
	for (let audio of voices) audio.restarts = 0;
	let counting = (audio) => { let play = audio.play; audio.play = function () { this.restarts++; return play.call(this); }; };
	for (let audio of voices) counting(audio);
	let burst = Array.from({ length: 4 }, (_, i) => ({ ...shot, x: 50.5 + i }));
	pitched.advance(burst, 0, 10, 1, -1, () => listener);
	assert.equal(voices.length, 4, "the pool grows to four");
	for (let audio of voices.slice(2)) { audio.restarts = 0; counting(audio); }
	assert.deepEqual(restarts(), [1, 1, 0, 0]);
	pitched.advance(burst.slice(0, 1), 0, 10, 1, -1, () => listener);
	assert.deepEqual(restarts(), [2, 1, 0, 0], "the fifth trigger restarts the oldest voice");
	pitched.advance(burst.slice(0, 2), 0, 10, 1, -1, () => listener);
	assert.deepEqual(restarts(), [2, 2, 1, 0], "then the next oldest, in turn");
	assert.ok(voices.every(a => a.currentTime === 0 && !a.paused));
}

// Exercise collection inside the replay engine, including the pre-change
// terrain, victim identity, and repeated death notifications.
let state = Game.initial_state();
state.tanks[2] = { x: 50, y: 50, px: 0, py: 0 };
let mine_sound = Sound.event_for(state, { player: 2, time: 9 }, { type: "lay_mine" });
assert.deepEqual(mine_sound, { time: 9, kind: "man_lay_mine", player: null, x: 50.5, y: 50.5 });
assert.equal(Sound.variant(mine_sound, listener, 2), "man_lay_mine_near");
assert.equal(Sound.variant(mine_sound, view_at(70.5, 50.5), 2), null, "tank mine-laying has no far variant");
assert.equal(Sound.event_for(state, { player: 1, time: 9 }, { type: "lay_mine" }), null, "unknown tank position stays silent");
assert.equal(Sound.event_for(state, { player: 2, time: 9 }, { type: "explosion", code: 12, x: 50, y: 50 }).kind,
	mine_sound.kind, "tank and builder mine-laying share the sample");
state.tanks[3] = { x: 51, y: 50, px: 0, py: 0 };
state.grid[50 * 256 + 52] = 5;
let sounds = [];
Game.apply_record(state, { time: 10, player: 2, tankStatus: 0, status: 0, tankDir: 0,
	subpackets: [
		{ type: "shot_fired" },
		{ type: "shell_falls", x: 52, y: 50, pixel: 0 },
		{ type: "tank_hit", tank: 3, direction: 0 },
		{ type: "explosion", x: 52, y: 50, code: 7 },
		{ type: "tank_death", code: 1 },
		{ type: "tank_death", code: 2 },
	],
}, null, null, null, null, sounds);
assert.deepEqual(sounds.map(s => s.kind), ["hit_tank", "shot_tree"], "gunfire is not read from the fire event");
assert.equal(sounds[0].player, 3, "self hit means the victim, not the sender");
assert.equal(Sound.event_for(state, { player: 2, time: 10 }, { type: "pillbox_fires", pillbox: 0, direction: 0 }), null);
assert.equal(state.grid[50 * 256 + 52], 7);
// A death without ammunition is silent. Small explosions and superbooms
// sound only when their separate events arrive, even after the tank died.
for (let code of [1, 2, 3, 13]) {
	let death_state = Game.initial_state();
	death_state.tanks[2] = { x: 50, y: 50, px: 0, py: 0 };
	let death_sounds = [];
	let subpackets = code <= 3
		? [{ type: "tank_death", code }, { type: "tank_death", code }]
		: [{ type: "tank_death", code: 1 }];
	Game.apply_record(death_state, { time: 10, player: 2, tankStatus: 0, status: 0, tankDir: 0, subpackets },
		null, null, null, null, death_sounds);
	assert.deepEqual(death_sounds.map(s => s.kind), code === 3 ? ["tank_sinking"] : []);
	if (code === 2 || code === 13) {
		Game.apply_record(death_state, { time: 55, player: 2, tankStatus: 7, status: 0, tankDir: 0,
			subpackets: [{ type: "explosion", code: code === 2 ? 3 : 13, x: 50, y: 50 }],
		}, null, null, null, null, death_sounds);
		assert.deepEqual(death_sounds.map(s => [s.time, s.kind]),
			[[55, code === 2 ? "mine_explosion" : "big_explosion"]]);
	}
}
for (let terrain of [1, 7, 255]) {
	state.grid[50 * 256 + 52] = terrain;
	assert.equal(Sound.event_for(state, { player: 2, time: 11 },
		{ type: "shell_falls", x: 52, y: 50, pixel: 0 }), null,
		"shell falls never trigger tank-in-water audio, regardless of terrain");
}
assert.equal(Sound.event_for(state, { player: 2, time: 11 }, { type: "terrain_change", x: 52, y: 50, terrain: 5 }), null, "tree growth is silent");

// Gunfire comes from the matcher's shell births: one sound per traced shell,
// at its muzzle time, named for the firing player unless a pill fired it.
{
	let births = [
		[],
		[{ start_time: 100.25, end_time: 110, pixel_x: 808, pixel_y: 400, heading_x: 1, heading_y: 0, direction: 4, pillbox: false },
		 { start_time: 120, end_time: 130, pixel_x: 1608, pixel_y: 1608, heading_x: 0, heading_y: 1, direction: 8, pillbox: true }],
	];
	assert.deepEqual(Sound.birth_sounds(births), [
		{ time: 100.25, kind: "shooting", player: 1, x: 51, y: 25.5 },
		{ time: 120, kind: "shooting", player: null, x: 101, y: 101 },
	]);
	assert.equal(Sound.variant(Sound.birth_sounds(births)[0], view_at(51, 25.5), 1), "shooting_self");
	assert.equal(Sound.variant(Sound.birth_sounds(births)[1], view_at(101, 101), 1), "shooting_near", "a pill's shell is never self");
}
// In a built game every gunfire sound is a drawn birth and vice versa, on the
// births' own clock, and the sound list stays sorted.
{
	let BoloLog = require("../viewer/logparse.js");
	let file = path.join(__dirname, "../fixtures/emulator_solo");
	let game = Game.build([...BoloLog.records(new Uint8Array(fs.readFileSync(file)))]);
	let fires = game.sounds.filter(s => s.kind === "shooting");
	let births = game.shell_births.flatMap((bs, p) => bs.map(b => [b.start_time, b.pillbox ? null : p, b.pixel_x / 16 + 0.5, b.pixel_y / 16 + 0.5]));
	assert.ok(births.length > 0);
	assert.deepEqual(fires.map(s => [s.time, s.player, s.x, s.y]).sort(), births.sort(), "gunfire sounds are the shell births");
	for (let i = 1; i < game.sounds.length; i++) assert.ok(game.sounds[i - 1].time <= game.sounds[i].time, "sorted");
	let fire_events = 0;
	for (let rec of game.records) for (let sub of rec.subpackets) if (sub.type === "shot_fired" || sub.type === "pillbox_fires") fire_events++;
	assert.notEqual(fires.length, fire_events, "gunfire is not one sound per fire event");
}

let kinds = ["shooting", "hit_tank", "shot_tree", "shot_building", "mine_explosion",
	"big_explosion", "tank_sinking", "farming_tree", "man_building", "man_dying", "bubbles", "man_lay_mine"];
for (let kind of kinds) for (let viewpoint of [1, 2]) for (let x of [50.5, 70.5]) {
	let name = Sound.variant({ ...shot, kind }, view_at(x, 50.5), viewpoint);
	if (name) assert.ok(fs.existsSync(path.join(__dirname, "../viewer/sounds", name + ".wav")), name);
}
assert.ok(fs.readdirSync(path.join(__dirname, "../viewer/sounds")).every(name => !name.startsWith("lobby_")));
console.log("all sound checks passed");
