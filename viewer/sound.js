/* Replay sound events and a bounded HTML audio pool. HTML audio also works
 * when the viewer is opened directly from disk. No network dependencies. */
"use strict";
(function () {

function event_for(state, rec, sub) {
	let kind, source = sub, player = null;
	let tank = state.tanks[rec.player];
	let under = state.grid[sub.y * 256 + sub.x];
	switch (sub.type) {
		case "shot_fired": kind = "shooting"; source = tank; player = rec.player; break;
		case "pillbox_fires": kind = "shooting"; source = state.pills[sub.pillbox]; break;
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

const SELF_RADIUS = 5; /* map tiles from the camera centre, independent of zoom */

function nearest_player(camera, positions) {
	let player = -1, closest = SELF_RADIUS;
	for (let p = 0; p < positions.length; p++) {
		let position = positions[p];
		if (!position) continue;
		let distance = Math.hypot(position.x - camera.x, position.y - camera.y);
		// Equal distances keep the lower player slot, for a stable tie break.
		if (distance <= SELF_RADIUS && (player < 0 || distance < closest)) {
			player = p;
			closest = distance;
		}
	}
	return player;
}

function variant(event, listener, player) {
	if (!listener) return null;
	if (player >= 0 && event.player === player && ["shooting", "hit_tank"].includes(event.kind)) return event.kind + "_self";
	// WinBolo's square distance bands: near <= 15 tiles, audible < 40.
	let gap = Math.max(Math.abs(event.x - listener.x), Math.abs(event.y - listener.y));
	if (gap >= 40) return null;
	let near = gap <= 15;
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

function create_player(make_audio = url => new Audio(url)) {
	let pools = new Map();
	let enabled = true;
	function stop() {
		for (let pool of pools.values()) for (let audio of pool) {
			audio.pause();
			audio.currentTime = 0;
		}
	}
	function play(name) {
		let pool = pools.get(name);
		if (!pool) { pool = []; pools.set(name, pool); }
		let audio = pool.find(a => a.paused || a.ended);
		if (!audio && pool.length < 4) {
			audio = make_audio("sounds/" + name + ".wav");
			pool.push(audio);
		}
		if (!audio) return;
		audio.currentTime = 0;
		// Browsers may refuse autoplay until the first user interaction.
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

let BoloSound = { SELF_RADIUS, nearest_player, event_for, variant, between, create_player };
if (typeof module !== "undefined" && module.exports) module.exports = BoloSound;
else window.BoloSound = BoloSound;
})();
