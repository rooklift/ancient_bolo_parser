/* Replay sound events and a bounded HTML audio pool. HTML audio also works
 * when the viewer is opened directly from disk. No network dependencies. */
"use strict";
(function () {

function event_for(state, rec, sub) {
	let kind, source = sub, player = null;
	let tank = state.tanks[rec.player];
	let under = state.grid[sub.y * 256 + sub.x];
	switch (sub.type) {
		// Gunfire is not read from the fire events: a record is stamped when
		// its packet reached the recorder, so a busy pill's fires bunch into
		// whatever records the ring produced. The shell matcher dates each
		// traced shell back to its muzzle instead; see birth_sounds.
		case "shot_fired": case "pillbox_fires": break;
		// The mine-laying sample is shared by tanks and builders.
		case "lay_mine": kind = "man_lay_mine"; source = tank; break;
		case "tank_hit": kind = "hit_tank"; source = state.tanks[sub.tank]; player = sub.tank; break;
		case "pillbox_damage": kind = "shot_building"; source = state.pills[sub.pillbox]; break;
		case "base_damage": kind = "shot_building"; source = state.bases[sub.base]; break;
		case "tank_death":
			// Death itself is silent; any ammunition explosion has its own
			// explosion event. Only a sinking death has a sound here.
			if (sub.code === 3 && tank && !tank.dead) {
				kind = "tank_sinking";
				source = tank;
			}
			break;
		case "lgm_death":
		case "pill_dumped_by_dead_lgm": kind = "man_dying"; break;
		// Shells falling out of range are silent. WinBolo's bubbles sound
		// belongs to a tank losing ammunition in water, not shell splashes.
		case "shell_falls": break;
		case "explosion":
			if (sub.code === 12) kind = "man_lay_mine";
			else if (sub.code === 13) kind = "big_explosion";
			else if (sub.code === 3 || (under >= 10 && under <= 15)) kind = "mine_explosion";
			else if (under === 5) kind = "shot_tree";
			else kind = "shot_building";
			break;
		case "terrain_change":
			// Growth, crater flooding and boats are silent: a boat appears on
			// the river whenever a tank leaves one. Construction and harvesting
			// are inferred from terrain transitions; the log has no audio opcode.
			if ((under === 5 || under === 13) && sub.terrain === 7) kind = "farming_tree";
			else if (under !== sub.terrain && [0, 4].includes(sub.terrain)) kind = "man_building";
			break;
		case "pill_plant": kind = "man_building"; break;
		case "pill_repair_4": case "pill_repair_8":
		case "pill_repair_12": case "pill_repair_full":
			kind = "man_building"; source = state.pills[sub.pillbox]; break;
	}
	if (!kind || !source || source.inTank != null) return null;
	return { time: rec.time, kind, player,
		x: source.x + (source.px || 0) / 16 + 0.5,
		y: source.y + (source.py || 0) / 16 + 0.5 };
}

/* One gunfire sound per shell the matcher traced back to a muzzle, at the
 * moment the drawn shell leaves it: the same clock as the impact sounds, and
 * independent of when the ring delivered the fire event. A shell the matcher
 * could not place is not drawn from a muzzle and makes no sound either.
 * Births are per player; a pill's shell rides in its target's list, so only
 * a tank birth names a player, for the self variant. */
function birth_sounds(shell_births) {
	let sounds = [];
	shell_births.forEach((births, player) => {
		for (let birth of births) {
			sounds.push({ time: birth.start_time, kind: "shooting",
				player: birth.pillbox ? null : player,
				x: birth.pixel_x / 16 + 0.5,
				y: birth.pixel_y / 16 + 0.5 });
		}
	});
	return sounds;
}

/* player is the one the camera is locked to, or -1 with a free camera: only
 * a locked camera hears its player's own gunfire and hits as self sounds.
 * listener is the visible area in tiles (left, top, right, bottom). */
function variant(event, listener, player) {
	if (!listener) return null;
	if (player >= 0 && event.player === player && ["shooting", "hit_tank"].includes(event.kind)) return event.kind + "_self";
	// An event on screen is near; one off screen is far, however distant.
	let near = event.x >= listener.left && event.x < listener.right
		&& event.y >= listener.top && event.y < listener.bottom;
	if (event.kind === "bubbles") return near ? "bubbles" : null;
	if (event.kind === "man_lay_mine") return near ? "man_lay_mine_near" : null;
	return event.kind + (near ? "_near" : "_far");
}

function between(events, from, to) {
	let lo = 0, hi = events.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (events[mid].time <= from) lo = mid + 1;
		else hi = mid;
	}
	let end = lo;
	while (end < events.length && events[end].time <= to) end++;
	return events.slice(lo, end);
}

/* Copies of one sound that may play at once. The samples peak near -18 dBFS
 * and play at half volume, so even this many aligned peaks stay well short of
 * clipping; the cap bounds the number of audio elements, not the loudness. */
const MAX_VOICES = 4;

function create_player(make_audio = url => new Audio(url), random = Math.random) {
	let pools = new Map();
	let enabled = true;
	let triggers = 0;
	function stop() {
		for (let pool of pools.values()) for (let { audio } of pool) {
			audio.pause();
			audio.currentTime = 0;
		}
	}
	function play(name) {
		let pool = pools.get(name);
		if (!pool) { pool = []; pools.set(name, pool); }
		let voice = pool.find(v => v.audio.paused || v.audio.ended);
		if (!voice && pool.length < MAX_VOICES) {
			let audio = make_audio("sounds/" + name + ".wav");
			audio.volume = 0.5;
			voice = { audio, started: 0 };
			pool.push(voice);
		}
		// Past MAX_VOICES copies of a sound, the newest trigger restarts the
		// copy that has played longest, so a burst of gunfire keeps its
		// latest shots rather than losing them.
		if (!voice) voice = pool.reduce((oldest, v) => v.started < oldest.started ? v : oldest);
		let { audio } = voice;
		voice.started = ++triggers;
		// Vary each trigger, including pooled voices. Disable pitch correction
		// so the small rate change changes pitch as well as duration.
		audio.preservesPitch = false;
		audio.playbackRate = 0.97 + random() * 0.06;
		audio.currentTime = 0;
		// Browsers may refuse autoplay until the first user interaction; a
		// refused sound is simply dropped rather than queued.
		let pending = audio.play();
		if (pending) pending.catch(() => {});
	}
	return {
		stop,
		set_enabled(value) { enabled = value; if (!value) stop(); },
		advance(events, from, to, speed, player, listener_at) {
			if (!enabled || speed > 1 || speed <= 0 || to <= from) { stop(); return; }
			for (let event of between(events, from, to)) {
				let name = variant(event, listener_at(event.time), player);
				if (name) play(name);
			}
		},
	};
}

/* ---------- offline mixing, for the video export ----------
 * The export steps its clock deterministically and cannot use the audio
 * elements above, so it mixes the same events into a sample stream: the
 * same variant rule, the same base volume, the same pitch variation drawn
 * from a seeded generator so an export is repeatable. */

const BASE_VOLUME = 0.5;
const SAMPLE_NAMES = ["big_explosion_far", "big_explosion_near", "bubbles",
	"farming_tree_far", "farming_tree_near", "hit_tank_far", "hit_tank_near",
	"hit_tank_self", "man_building_far", "man_building_near", "man_dying_far",
	"man_dying_near", "man_lay_mine_near", "mine_explosion_far",
	"mine_explosion_near", "shooting_far", "shooting_near", "shooting_self",
	"shot_building_far", "shot_building_near", "shot_tree_far", "shot_tree_near",
	"tank_sinking_far", "tank_sinking_near"];

/* A RIFF WAVE with 8- or 16-bit integer PCM (WinBolo's are 16-bit mono at
 * the old Mac rate of 22254 Hz) to { sample_rate, samples } with samples a
 * Float32Array in [-1, 1] of the first channel. */
function decode_wav(bytes) {
	let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let tag = at => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
	if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
	let format = null, data = null;
	for (let at = 12; at + 8 <= bytes.length;) {
		let id = tag(at), size = view.getUint32(at + 4, true);
		let body = at + 8;
		if (id === "fmt ") {
			format = { code: view.getUint16(body, true), channels: view.getUint16(body + 2, true),
				sample_rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
		} else if (id === "data") {
			data = { start: body, end: Math.min(bytes.length, body + size) };
		}
		at = body + size + (size & 1); /* chunks are word-aligned */
	}
	if (!format || !data) throw new Error("WAV without fmt or data chunk");
	if (format.code !== 1 || (format.bits !== 8 && format.bits !== 16)) {
		throw new Error("WAV is not 8- or 16-bit PCM");
	}
	let frame_bytes = format.channels * format.bits / 8;
	let count = Math.floor((data.end - data.start) / frame_bytes);
	let samples = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		let at = data.start + i * frame_bytes;
		samples[i] = format.bits === 8 ? (bytes[at] - 128) / 128 : view.getInt16(at, true) / 32768;
	}
	return { sample_rate: format.sample_rate, samples };
}

/* Every sample the mixer may need, fetched relative to the page (the same
 * URLs the audio elements use) and decoded: a Map of name -> decoded. */
async function load_samples(fetch_bytes = async url => new Uint8Array(await (await fetch(url)).arrayBuffer())) {
	let samples = new Map();
	for (let name of SAMPLE_NAMES) {
		let bytes = await fetch_bytes("sounds/" + name + ".wav");
		samples.set(name, decode_wav(bytes));
	}
	return samples;
}

/* A small deterministic generator (Park-Miller), so the pitch variation of
 * an export is the same every time it is run. */
function seeded_random(seed = 1) {
	let state = seed % 2147483647 || 1;
	return () => {
		state = state * 48271 % 2147483647;
		return (state - 1) / 2147483646;
	};
}

/* Mixes events into an output stream of `sample_rate` mono samples, where
 * output time is replay time from `start_tick` compressed by `speed`, as
 * the video's is. Feed events with advance(), as the live player is fed
 * per frame, then take the output with render(): each call returns the
 * mix from the previous call's end up to `until` output samples in total,
 * so a caller can pull the audio frame by frame alongside the video.
 * Voices past their end are dropped; the sum is clamped to [-1, 1]. */
function create_mixer({ samples, sample_rate = 48000, start_tick, speed = 1, ticks_per_second = 50, random = seeded_random() }) {
	let voices = [];
	let rendered = 0; /* output samples handed out so far */
	let output_samples_per_tick = sample_rate / (ticks_per_second * speed);
	function advance(events, from, to, player, listener_at) {
		if (to <= from) return;
		for (let event of between(events, from, to)) {
			let name = variant(event, listener_at(event.time), player);
			if (!name) continue;
			let sample = samples.get(name);
			if (!sample) continue;
			/* source samples per output sample, with the live player's
			 * +/-3% rate variation baked in */
			let rate = (0.97 + random() * 0.06) * sample.sample_rate / sample_rate;
			voices.push({ sample, rate, start: (event.time - start_tick) * output_samples_per_tick });
		}
	}
	function render(until) {
		let count = Math.max(0, Math.floor(until) - rendered);
		let out = new Float32Array(count);
		let live = [];
		for (let voice of voices) {
			let { samples: data, rate, start } = { samples: voice.sample.samples, rate: voice.rate, start: voice.start };
			let first = Math.max(rendered, Math.ceil(start));
			let last_source = (data.length - 1) / rate; /* output offset of the final sample */
			let end = Math.min(rendered + count, Math.floor(start + last_source) + 1);
			for (let i = first; i < end; i++) {
				let position = (i - start) * rate;
				let index = Math.floor(position);
				let fraction = position - index;
				let value = data[index] + (index + 1 < data.length ? (data[index + 1] - data[index]) * fraction : 0);
				out[i - rendered] += value * BASE_VOLUME;
			}
			if (start + last_source > rendered + count) live.push(voice);
		}
		voices = live;
		for (let i = 0; i < count; i++) out[i] = Math.max(-1, Math.min(1, out[i]));
		rendered += count;
		return out;
	}
	return { advance, render, get rendered() { return rendered; } };
}

let BoloSound = { event_for, birth_sounds, variant, between, create_player,
	SAMPLE_NAMES, decode_wav, load_samples, seeded_random, create_mixer };
if (typeof module !== "undefined" && module.exports) module.exports = BoloSound;
else window.BoloSound = BoloSound;
})();
