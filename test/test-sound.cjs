"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Sound = require("../viewer/sound.js");
const Game = require("../viewer/game.js");

let listener = { x: 50.5, y: 50.5 };
let shot = { time: 10, kind: "shooting", player: 2, ...listener };
assert.equal(Sound.nearest_player(listener, []), -1);
assert.equal(Sound.nearest_player(listener, [null, { x: 58.5, y: 50.5 }]), 1, "8 tiles is close enough for self");
assert.equal(Sound.nearest_player(listener, [{ x: 58.6, y: 50.5 }]), -1, "beyond 8 tiles has no self");
assert.equal(Sound.nearest_player(listener, [{ x: 57.5, y: 57.5 }]), -1, "self uses a circular radius");
let positions = [{ x: 56.5, y: 50.5 }, null, { x: 53.5, y: 50.5 }];
assert.equal(Sound.nearest_player(listener, positions), 2, "closest tank wins");
assert.equal(Sound.nearest_player({ x: 56.5, y: 50.5 }, positions), 0, "panning switches the self tank");
assert.equal(Sound.nearest_player(listener, [listener, listener]), 0, "ties are stable");
assert.equal(Sound.variant(shot, listener, -1), "shooting_near", "no nearby tank still allows near sounds");
assert.equal(Sound.variant(shot, { x: 70.5, y: 50.5 }, -1), "shooting_far", "far is measured from the camera without a self tank");
assert.equal(Sound.variant(shot, { x: 90.5, y: 50.5 }, -1), null);
assert.equal(Sound.variant(shot, listener, 2), "shooting_self");
assert.equal(Sound.variant(shot, listener, 1), "shooting_near");
assert.equal(Sound.variant({ ...shot, player: null }, listener, 2), "shooting_near");
assert.equal(Sound.variant(shot, { x: 65.5, y: 65.5 }, 1), "shooting_near");
assert.equal(Sound.variant(shot, { x: 66.5, y: 50.5 }, 1), "shooting_far");
assert.equal(Sound.variant(shot, { x: 90.5, y: 50.5 }, 1), null);
assert.equal(Sound.variant(shot, null, 2), null);
assert.equal(Sound.variant({ ...shot, kind: "hit_tank" }, listener, 2), "hit_tank_self");
for (let kind of ["bubbles", "man_lay_mine"]) {
	assert.equal(Sound.variant({ ...shot, kind }, { x: 66.5, y: 50.5 }, 1), null);
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
player.advance(Array.from({ length: 50 }, () => shot), 0, 10, 1, 2, () => listener);
assert.ok(audios.length <= 5, "simultaneous copies of each sound are bounded");
player.stop();
assert.ok(audios.every(a => a.paused));

// Exercise collection inside the replay engine, including the pre-change
// terrain, victim identity, and repeated death notifications.
let state = Game.initial_state();
state.tanks[2] = { x: 50, y: 50, px: 0, py: 0 };
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
assert.deepEqual(sounds.map(s => s.kind), ["shooting", "hit_tank", "shot_tree"]);
assert.equal(sounds[1].player, 3, "self hit means the victim, not the sender");
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

let kinds = ["shooting", "hit_tank", "shot_tree", "shot_building", "mine_explosion",
	"big_explosion", "tank_sinking", "farming_tree", "man_building", "man_dying", "bubbles", "man_lay_mine"];
for (let kind of kinds) for (let viewpoint of [1, 2]) for (let x of [50.5, 70.5]) {
	let name = Sound.variant({ ...shot, kind }, { x, y: 50.5 }, viewpoint);
	if (name) assert.ok(fs.existsSync(path.join(__dirname, "../viewer/sounds", name + ".wav")), name);
}
assert.ok(fs.readdirSync(path.join(__dirname, "../viewer/sounds")).every(name => !name.startsWith("lobby_")));
console.log("all sound checks passed");
