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
			// Growth and crater flooding are silent. Construction and harvesting
			// are inferred from terrain transitions; the log has no audio opcode.
			if ((under === 5 || under === 13) && sub.terrain === 7) kind = "farming_tree";
			else if (under !== sub.terrain && [0, 4, 9].includes(sub.terrain)) kind = "man_building";
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
		if (!voice && pool.length < 4) {
			let audio = make_audio("sounds/" + name + ".wav");
			audio.volume = 0.5;
			voice = { audio, started: 0 };
			pool.push(voice);
		}
		// Four copies of a sound at once is plenty: past that, the newest
		// trigger restarts the copy that has played longest, so a burst of
		// gunfire keeps its latest shots rather than losing them.
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

let BoloSound = { event_for, birth_sounds, variant, between, create_player };
if (typeof module !== "undefined" && module.exports) module.exports = BoloSound;
else window.BoloSound = BoloSound;
})();
