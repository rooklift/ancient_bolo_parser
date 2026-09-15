"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Sound = require("../viewer/sound.js");
const Game = require("../viewer/game.js");

let listener = { x: 50.5, y: 50.5 };
let shot = { time: 10, kind: "shooting", player: 2, ...listener };
assert.equal(Sound.nearest_player(listener, []), -1);
assert.equal(Sound.nearest_player(listener, [null, { x: 55.5, y: 50.5 }]), 1, "5 tiles is close enough for self");
assert.equal(Sound.nearest_player(listener, [{ x: 55.6, y: 50.5 }]), -1, "beyond 5 tiles has no self");
assert.equal(Sound.nearest_player(listener, [{ x: 54.5, y: 54.5 }]), -1, "self uses a circular radius");
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
assert.equal(Sound.variant(shot, { x: 65.5, y: 50.5 }, 1), "shooting_near", "15 tiles is near");
assert.equal(Sound.variant(shot, { x: 59.5, y: 62.5 }, 1), "shooting_near", "diagonal at radius 15 is near");
assert.equal(Sound.variant(shot, { x: 65.5, y: 65.5 }, 1), "shooting_far", "square corner lies outside near radius");
assert.equal(Sound.variant(shot, { x: 74.5, y: 82.5 }, 1), null, "diagonal at radius 40 is silent");
assert.equal(Sound.variant(shot, { x: 74.5, y: 81.5 }, 1), "shooting_far", "just inside audible radius is far");
assert.equal(Sound.variant(shot, { x: 80.5, y: 80.5 }, 1), null, "square corner lies outside audible radius");
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

// Pan follows horizontal camera-relative distance, including self sounds.
assert.equal(Sound.stereo_pan(shot, listener), 0);
assert.equal(Sound.stereo_pan({ ...shot, y: 80 }, listener), 0);
assert.equal(Sound.stereo_pan({ ...shot, x: 43 }, listener), -0.5);
assert.equal(Sound.stereo_pan({ ...shot, x: 58 }, listener), 0.5);
assert.equal(Sound.stereo_pan({ ...shot, x: 10 }, listener), -1);
assert.equal(Sound.stereo_pan({ ...shot, x: 90 }, listener), 1);
{
	let voices = [], panners = [], routes = [], context_count = 0;
	let ctx = {
		state: "suspended", destination: {},
		resume() { this.state = "running"; return Promise.resolve(); },
		createMediaElementSource(audio) {
			return { connect(node) { routes.push([audio, node]); } };
		},
		createStereoPanner() {
			let panner = { pan: { value: 0 }, connect(node) { assert.equal(node, ctx.destination); } };
			panners.push(panner);
			return panner;
		},
	};
	let pitches = [0, 1, 0.5];
	let stereo = Sound.create_player(() => {
		let audio = { paused: true, currentTime: 0,
			play() { this.paused = false; return Promise.resolve(); },
			pause() { this.paused = true; },
		};
		voices.push(audio);
		return audio;
	}, () => { context_count++; return ctx; }, () => pitches.shift());
	let pair = [{ ...shot, x: 40.5 }, { ...shot, x: 60.5 }];
	stereo.advance(pair, 0, 10, 1, -1, () => listener);
	assert.equal(voices.length, 0, "suspended audio drops events instead of queueing them");
	stereo.unlock();
	stereo.advance(pair, 10, 11, 1, -1, () => listener);
	assert.equal(voices.length, 0, "unlock does not replay missed sounds");
	stereo.advance(pair, 0, 10, 1, -1, () => listener);
	assert.deepEqual(panners.map(p => p.pan.value), [-2 / 3, 2 / 3], "overlapping sounds have independent pan");
	assert.ok(voices.every(a => a.volume === 0.5), "stereo keeps half volume");
	assert.deepEqual(voices.map(a => a.playbackRate), [0.97, 1.03], "each sound gets its own bounded pitch variation");
	assert.ok(voices.every(a => a.preservesPitch === false), "rate variation changes pitch");
	assert.equal(routes.length, 2);
	stereo.stop();
	assert.ok(voices.every(a => a.paused));
	stereo.advance([{ ...shot, x: 65.5 }], 0, 10, 1, -1, () => listener);
	assert.equal(panners.length, 2, "pooled audio reuses its existing route");
	assert.equal(panners[0].pan.value, 1, "a reused voice gets the new sound's pan");
	assert.equal(voices[0].playbackRate, 1, "a reused voice gets a fresh pitch");
	assert.equal(context_count, 1, "one shared context");
	stereo.set_enabled(false);
	assert.ok(voices.every(a => a.paused));
}

// Exercise collection inside the replay engine, including the pre-change
// terrain, victim identity, and repeated death notifications.
let state = Game.initial_state();
state.tanks[2] = { x: 50, y: 50, px: 0, py: 0 };
let mine_sound = Sound.event_for(state, { player: 2, time: 9 }, { type: "lay_mine" });
assert.deepEqual(mine_sound, { time: 9, kind: "man_lay_mine", player: null, x: 50.5, y: 50.5 });
assert.equal(Sound.variant(mine_sound, listener, 2), "man_lay_mine_near");
assert.equal(Sound.variant(mine_sound, { x: 70.5, y: 50.5 }, 2), null, "tank mine-laying has no far variant");
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
