"use strict";
/* Bolo log viewer renderer: canvas world view + playback transport.
 * View handling (zoom steps, wheel-to-cursor, pan, flat-colour underlay with
 * sprite overlay) is duplicated from the lgm map editor's renderer. */

const { MAP_SIZE, DEEP_SEA } = BoloMap;
const TPS = BoloLog.TICKS_PER_SECOND;

const TERRAIN_COLORS = {
	0:  "#8a6b4a",  /* building */
	1:  "#3f7fe0",  /* river */
	2:  "#6b7d3f",  /* swamp */
	3:  "#5a5a66",  /* crater */
	4:  "#3a3a3a",  /* road */
	5:  "#58a848",  /* forest */
	6:  "#857a6a",  /* rubble */
	7:  "#1e5c2e",  /* grass */
	8:  "#8c8c99",  /* shot building */
	9:  "#a8c4ee",  /* boat on river */
	255: "#123a6b", /* deep sea */
};
const RGB = {};
for (let t = 0; t <= 9; t++) {
	let c = parseInt(TERRAIN_COLORS[t].slice(1), 16);
	RGB[t] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}
for (let t = 10; t <= 15; t++) RGB[t] = RGB[t - 8];
{
	let c = parseInt(TERRAIN_COLORS[255].slice(1), 16);
	RGB[255] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
}

/* Shapes mode uses the same allegiance language as the sprite art:
 * friendly green, hostile red (neutral pillboxes count as hostile), with
 * only neutral bases keeping their own amber. */
const FRIENDLY_COLOR = "#58d858";
const HOSTILE_COLOR = "#ff5d5d";
const NEUTRAL_BASE = "#f0b429";

const EFFECT_TICKS = 30; /* how long a transient effect stays on screen */

/* ---------- object sprites (sprites/objects/) ----------
 * Classic Bolo object art, two-sided: "good" is the viewed player's team,
 * "evil" is everyone else — including neutral pillboxes, which the art
 * does not distinguish from hostile ones. Tank sprite indices match the
 * log's tank directions: 0 = north, clockwise. Pillbox
 * indices are armour states 0 (dead) to 15 (fresh). On by default;
 * Cmd/Ctrl+G switches to vector markers. Only used at zooms where the
 * terrain also draws with sprites — vector markers read better over the
 * flat-colour map. */
let use_obj_sprites = true;
let obj_imgs = new Map();

function load_obj_sprites() {
	let names = ["base_good", "base_evil", "base_neutral", "lgm_helicopter"];
	for (let i = 0; i < 16; i++) {
		let n = String(i).padStart(2, "0");
		names.push(`tank_good_${n}`, `tank_evil_${n}`, `tank_goodboat_${n}`, `tank_evilboat_${n}`,
			`pillbox_good_${n}`, `pillbox_evil_${n}`);
	}
	for (let name of names) {
		let img = new Image();
		img.addEventListener("load", () => {
			obj_imgs.set(name, img);
			request_draw();
		});
		img.src = "sprites/objects/" + name + ".png";
	}
}

function obj_sprite(name) {
	return (use_obj_sprites && view.zoom >= BoloSprites.MIN_ZOOM) ? obj_imgs.get(name) : undefined;
}

/* The team drawn as "good": the viewpoint player's, else the first present. */
function good_team() {
	if (viewpoint >= 0) return BoloGame.team_of(cur, viewpoint);
	for (let p = 0; p < 16; p++) {
		if (cur.present[p] || cur.names[p] !== null) return BoloGame.team_of(cur, p);
	}
	return 0;
}

function side_of(player) {
	return BoloGame.team_of(cur, player) === good_team() ? "good" : "evil";
}

/* ---------- state ---------- */
let game = null;         /* BoloGame.build() result */
let cur = null;          /* current world state */
let cursor = 0;          /* first unapplied record index */
let clock = 0;           /* current tick */
let playing = false;
let speed = 1;
let viewpoint = -1; /* player whose side draws as friendly; -1 = first player */
let effect_lo = 0;       /* rolling window start into game.effects */
let chat_shown = 0;
let last_frame = null;

const ZOOMS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];
let view = { zoom: 3, ox: 0, oy: 0 };

/* ---------- DOM ---------- */
let canvas = document.getElementById("view");
let ctx = canvas.getContext("2d");
let play_btn = document.getElementById("playBtn");
let time_label = document.getElementById("timeLabel");
let seek_el = document.getElementById("seek");
let speed_el = document.getElementById("speed");
let viewpoint_el = document.getElementById("viewpoint");
let zoom_label = document.getElementById("zoomLabel");
let drop_hint = document.getElementById("dropHint");
let map_name_el = document.getElementById("mapName");
let game_meta_el = document.getElementById("gameMeta");
let players_el = document.getElementById("players");
let chat_el = document.getElementById("chat");
let file_pick = document.getElementById("filePick");

/* Terrain as drawn: like the real game (and unlike the map editor), a
 * base square counts as road for tile-selection, so roads connect into
 * bases instead of dead-ending. The base art covers its own square. */
const ROAD = 4;
let display_grid_cache = null;
let display_grid_version = -1;

function display_grid() {
	if (display_grid_version !== cur.gridVersion || !display_grid_cache) {
		display_grid_cache = cur.grid.slice();
		for (const b of cur.bases) {
			display_grid_cache[b.y * MAP_SIZE + b.x] = ROAD;
		}
		display_grid_version = cur.gridVersion;
	}
	return display_grid_cache;
}

/* offscreen 1px-per-tile terrain image */
let off = document.createElement("canvas");
off.width = off.height = MAP_SIZE;
let off_ctx = off.getContext("2d");
let off_img = off_ctx.createImageData(MAP_SIZE, MAP_SIZE);
let off_version = -1;

function rebuild_offscreen() {
	let d = off_img.data;
	let grid = display_grid();
	for (let i = 0; i < MAP_SIZE * MAP_SIZE; i++) {
		let [r, g, b] = RGB[grid[i]] || RGB[255];
		d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
	}
	off_ctx.putImageData(off_img, 0, 0);
	off_version = cur.gridVersion;
}

/* ---------- view helpers (from lgm) ---------- */
function css_size() {
	return { w: canvas.clientWidth, h: canvas.clientHeight };
}
function tile_to_screen_x(tx) { return (tx - view.ox) * view.zoom; }
function tile_to_screen_y(ty) { return (ty - view.oy) * view.zoom; }

function clamp_view() {
	let { w, h } = css_size();
	let tw = w / view.zoom, th = h / view.zoom;
	let margin = 16;
	view.ox = Math.max(-tw + margin, Math.min(MAP_SIZE - margin, view.ox));
	view.oy = Math.max(-th + margin, Math.min(MAP_SIZE - margin, view.oy));
}

function zoom_to(z, mx, my) {
	if (z === view.zoom) return;
	let { w, h } = css_size();
	if (mx === undefined) { mx = w / 2; my = h / 2; }
	let tx = view.ox + mx / view.zoom;
	let ty = view.oy + my / view.zoom;
	view.zoom = z;
	view.ox = tx - mx / z;
	view.oy = ty - my / z;
	clamp_view();
	zoom_label.textContent = `zoom ${z}×`;
	request_draw();
}
function zoom_step(delta) {
	let idx = ZOOMS.indexOf(view.zoom);
	zoom_to(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, idx + delta))]);
}
function zoom_fit() {
	let { w, h } = css_size();
	let z = ZOOMS[0];
	for (let c of ZOOMS) if (c * MAP_SIZE <= Math.min(w, h)) z = c;
	view.zoom = z;
	view.ox = 128 - w / (2 * z);
	view.oy = 128 - h / (2 * z);
	zoom_label.textContent = `zoom ${z}×`;
	request_draw();
}

/* Centre the view on the played area rather than the whole 256×256 sea. */
function zoom_to_action() {
	if (!cur) return zoom_fit();
	let minx = MAP_SIZE, miny = MAP_SIZE, maxx = 0, maxy = 0, any = false;
	for (let y = 0; y < MAP_SIZE; y++) {
		for (let x = 0; x < MAP_SIZE; x++) {
			if (cur.grid[y * MAP_SIZE + x] !== DEEP_SEA) {
				any = true;
				if (x < minx) minx = x;
				if (x > maxx) maxx = x;
				if (y < miny) miny = y;
				if (y > maxy) maxy = y;
			}
		}
	}
	if (!any) return zoom_fit();
	let { w, h } = css_size();
	let spanx = maxx - minx + 8, spany = maxy - miny + 8;
	let z = ZOOMS[0];
	for (let c of ZOOMS) if (c * spanx <= w && c * spany <= h) z = c;
	view.zoom = z;
	view.ox = (minx + maxx + 1) / 2 - w / (2 * z);
	view.oy = (miny + maxy + 1) / 2 - h / (2 * z);
	zoom_label.textContent = `zoom ${z}×`;
	request_draw();
}

/* ---------- playback ---------- */
function set_clock(tick, hard) {
	if (!game) return;
	tick = Math.max(game.t0, Math.min(game.t1, tick));
	if (hard || tick < clock) {
		/* backwards (or explicit reset): restore from nearest keyframe */
		let r = BoloGame.state_at(game, tick);
		cur = r.state;
		cursor = r.index;
		off_version = -1;
		effect_lo = lower_bound_effect(tick - EFFECT_TICKS);
		rebuild_chat(tick);
	} else {
		while (cursor < game.records.length && game.records[cursor].time <= tick) {
			BoloGame.apply_record(cur, game.records[cursor], null, null);
			cursor++;
		}
	}
	clock = tick;
	update_transport();
	request_draw();
}

function lower_bound_effect(t) {
	let lo = 0, hi = game.effects.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (game.effects[mid].time < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function frame(ts) {
	if (playing && game) {
		if (last_frame !== null) {
			let dt = Math.min(0.25, (ts - last_frame) / 1000);
			set_clock(clock + dt * TPS * speed);
			if (clock >= game.t1) set_playing(false);
		}
		last_frame = ts;
		request_draw();
		requestAnimationFrame(frame);
	} else {
		last_frame = null;
	}
}

function set_playing(p) {
	if (!game) p = false;
	if (p === playing) return;
	playing = p;
	play_btn.textContent = playing ? "❚❚" : "▶";
	if (playing) {
		if (clock >= game.t1) set_clock(game.t0, true);
		last_frame = null;
		requestAnimationFrame(frame);
	}
}

function fmt_time(ticks) {
	let s = Math.max(0, Math.round((ticks - game.t0) / TPS));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function update_transport() {
	if (!game) return;
	time_label.textContent = `${fmt_time(clock)} / ${fmt_time(game.t1)}`;
	let span = Math.max(1, game.t1 - game.t0);
	seek_el.value = Math.round(((clock - game.t0) / span) * 1000);
	update_players();
	update_chat();
}

/* ---------- sidebar ---------- */

/* Name colours for the players panel and message wire: team-indexed like
 * the map colours, but with no reds or greens, which the viewer already
 * uses to mean friendly/enemy. */
const NAME_COLORS = [
	"#4da3ff", "#f0b429", "#c77dff", "#4dd8d8",
	"#ff7ab8", "#ff9d3b", "#7d8bff", "#e066e0",
	"#8ad8ff", "#e0b08a", "#d8d84d", "#b0c4d8",
	"#f0e68c", "#c8a2c8", "#66c8e0", "#e8c468",
];

function player_color(p) {
	return NAME_COLORS[BoloGame.team_of(cur, p)];
}

function update_players() {
	let html = "";
	for (let p = 0; p < 16; p++) {
		if (cur.names[p] === null && !cur.present[p]) continue;
		let name = pretty(cur.names[p] || `player ${p}`);
		let at = name.indexOf("@");
		let handle = at >= 0 ? name.slice(0, at) : name;
		let host = at >= 0 ? name.slice(at + 1) : "";
		html += `<div class="player${cur.quit[p] ? " gone" : ""}">` +
			`<span class="chip" style="background:${player_color(p)}"></span>` +
			`<span>${esc(handle)}</span> <span class="host">${esc(host)}</span></div>`;
	}
	if (players_el.innerHTML !== html) players_el.innerHTML = html;
}

function esc(s) {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* U+F8FF is the Apple logo — a Private Use codepoint only Apple platforms
 * can draw (Mac players really did name themselves that). Substitute an
 * apple everyone has; the parsed data keeps the real codepoint. */
function pretty(s) {
	return s.replace(/\uf8ff/g, "\u{1f34e}")          /* the one PUA codepoint in MacRoman */
		.replace(/[\x00-\x1f\x7f]/g, "\u2400");       /* stray control bytes, shown as ␀ */
}

function chat_line(m) {
	let who = pretty((cur.names[m.player] || `player ${m.player}`).split("@")[0]);
	if (m.join) return `<div class="msg sys"><span class="t">${fmt_time(m.time)}</span> ⚑ ${esc(pretty(m.text))}</div>`;
	if (m.quit) return `<div class="msg sys"><span class="t">${fmt_time(m.time)}</span> ✝ ${esc(who)} left the game</div>`;
	let scope = m.address === 0xffff ? "" : " (to some)";
	return `<div class="msg"><span class="t">${fmt_time(m.time)}</span> ` +
		`<span class="who" style="color:${player_color(m.player)}">${esc(who)}</span>${scope}: ${esc(pretty(m.text))}</div>`;
}

function rebuild_chat(tick) {
	chat_shown = 0;
	chat_el.innerHTML = "";
	update_chat(tick);
}

function update_chat(tick = clock) {
	let added = false;
	while (chat_shown < game.chat.length && game.chat[chat_shown].time <= tick) {
		chat_el.insertAdjacentHTML("beforeend", chat_line(game.chat[chat_shown]));
		chat_shown++;
		added = true;
	}
	if (added) chat_el.scrollTop = chat_el.scrollHeight;
}

/* ---------- drawing ---------- */
let draw_queued = false;
function request_draw() {
	if (draw_queued) return;
	draw_queued = true;
	requestAnimationFrame(() => {
		draw_queued = false;
		draw();
	});
}

function world_x(o) { return o.x + (o.px ?? 0) / 16 + 0.5; }
function world_y(o) { return o.y + (o.py ?? 0) / 16 + 0.5; }

function draw() {
	if (!cur) return;
	let { w, h } = css_size();
	let z = view.zoom;

	if (off_version !== cur.gridVersion) rebuild_offscreen();

	ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
	ctx.fillStyle = "#0a0e16";
	ctx.fillRect(0, 0, w, h);
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(off, view.ox, view.oy, w / z, h / z, 0, 0, w, h);

	let sprites_drawn = false;
	if (z >= BoloSprites.MIN_ZOOM) {
		sprites_drawn = BoloSprites.draw_view(ctx, display_grid(), view, w, h);
	}

	let tx0 = Math.max(0, Math.floor(view.ox));
	let ty0 = Math.max(0, Math.floor(view.oy));
	let tx1 = Math.min(MAP_SIZE, Math.ceil(view.ox + w / z));
	let ty1 = Math.min(MAP_SIZE, Math.ceil(view.oy + h / z));

	/* mine dots at non-sprite zooms */
	if (!sprites_drawn) {
		let r = Math.max(0.5, z * 0.28);
		ctx.fillStyle = "#ff3b30";
		for (let ty = ty0; ty < ty1; ty++) {
			for (let tx = tx0; tx < tx1; tx++) {
				let t = cur.grid[ty * MAP_SIZE + tx];
				if (t >= 10 && t <= 15) {
					ctx.beginPath();
					ctx.arc(tile_to_screen_x(tx) + z / 2, tile_to_screen_y(ty) + z / 2, r, 0, Math.PI * 2);
					ctx.fill();
				}
			}
		}
	}

	draw_bases();
	draw_pills();
	draw_effects();
	draw_shells();
	draw_men();
	draw_tanks();
}

function side_color(player) {
	return side_of(player) === "good" ? FRIENDLY_COLOR : HOSTILE_COLOR;
}

function draw_bases() {
	let z = view.zoom;
	let r = Math.max(2.5, z * 0.42);
	let good = good_team();
	for (const b of cur.bases) {
		let img = obj_sprite(b.owner === BoloGame.NEUTRAL ? "base_neutral"
			: BoloGame.team_of(cur, b.owner) === good ? "base_good" : "base_evil");
		if (img) {
			ctx.drawImage(img, tile_to_screen_x(b.x), tile_to_screen_y(b.y), z, z);
			continue;
		}
		let cx = tile_to_screen_x(b.x) + z / 2, cy = tile_to_screen_y(b.y) + z / 2;
		ctx.fillStyle = b.owner === BoloGame.NEUTRAL ? NEUTRAL_BASE : side_color(b.owner);
		ctx.strokeStyle = "rgba(0,0,0,0.65)";
		ctx.lineWidth = 1.5;
		ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
		ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
	}
}

function draw_pills() {
	let z = view.zoom;
	let r = Math.max(2, z * 0.36);
	let good = good_team();
	for (const p of cur.pills) {
		if (p.inTank !== null) continue;
		/* the art shows neutral pills as hostile; armour state 0 is the dead look */
		let side = p.owner !== BoloGame.NEUTRAL && BoloGame.team_of(cur, p.owner) === good ? "good" : "evil";
		let img = obj_sprite(`pillbox_${side}_${String(Math.min(15, p.armour)).padStart(2, "0")}`);
		if (img) {
			ctx.drawImage(img, tile_to_screen_x(p.x), tile_to_screen_y(p.y), z, z);
			continue;
		}
		let cx = tile_to_screen_x(p.x) + z / 2, cy = tile_to_screen_y(p.y) + z / 2;
		let dead = p.armour === 0;
		ctx.fillStyle = dead ? "#555c6a"
			: p.owner === BoloGame.NEUTRAL ? HOSTILE_COLOR : side_color(p.owner);
		ctx.strokeStyle = "rgba(0,0,0,0.65)";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.arc(cx, cy, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		if (!dead) {
			/* damage pocks: 15-armour dark dots at fixed pseudo-random spots,
			 * accreting in order as the pill takes hits */
			let pocks = Math.min(PILL_POCKS.length, 15 - p.armour);
			if (pocks > 0) {
				ctx.fillStyle = "rgba(0,0,0,0.6)";
				let pr = Math.max(0.75, z * 0.055);
				for (let i = 0; i < pocks; i++) {
					ctx.beginPath();
					ctx.arc(cx + PILL_POCKS[i][0] * r * 0.72, cy + PILL_POCKS[i][1] * r * 0.72, pr, 0, Math.PI * 2);
					ctx.fill();
				}
			}
		}
	}
}

/* 14 well-spread fixed points in the unit circle (maximin-selected, seed 7)
 * so pillbox damage looks the same on every pill, every frame. */
const PILL_POCKS = [
	[-0.040, -0.649], [0.700, 0.023], [0.259, 0.954], [-0.203, 0.711],
	[0.682, -0.528], [-0.432, 0.193], [-0.470, -0.399], [-0.987, -0.115],
	[0.141, -0.019], [0.214, 0.470], [0.797, 0.559], [-0.898, 0.410],
	[-0.478, -0.873], [0.353, -0.903],
];

function draw_tanks() {
	let z = view.zoom;
	let r = Math.max(3, z * 0.45);
	for (let p = 0; p < 16; p++) {
		let t = cur.tanks[p];
		if (!t || t.dead || cur.quit[p]) continue;
		/* a tank not restated for a long while is a ghost (split) or dead */
		let stale = clock - t.lastSeen > TPS * 5;
		let cx = tile_to_screen_x(world_x(t));
		let cy = tile_to_screen_y(world_y(t));
		ctx.save();
		/* tanks hidden in trees draw normally — replay watchers see all;
		 * only ghost tanks (ring splits, long unheard-from) fade */
		ctx.globalAlpha = stale ? 0.25 : 1;
		/* sprite indices match the log: 0 = north, clockwise (4 = east) */
		let img = obj_sprite(`tank_${side_of(p)}${t.inBoat ? "boat" : ""}_${String(t.dir).padStart(2, "0")}`);
		if (img) {
			ctx.drawImage(img, cx - z / 2, cy - z / 2, z, z);
			ctx.restore();
			draw_tank_label(p, cx, cy, r);
			continue;
		}
		ctx.translate(cx, cy);
		ctx.rotate((t.dir / 16) * Math.PI * 2); /* 0 = north, clockwise */
		ctx.fillStyle = side_color(p);
		ctx.strokeStyle = "rgba(0,0,0,0.7)";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(0, -r * 1.2);
		ctx.lineTo(r * 0.85, r);
		ctx.lineTo(-r * 0.85, r);
		ctx.closePath();
		ctx.fill();
		ctx.stroke();
		ctx.restore();
		draw_tank_label(p, cx, cy, r);
	}
}

function draw_tank_label(p, cx, cy, r) {
	let z = view.zoom;
	if (z < 8) return;
	let name = pretty((cur.names[p] || `p${p}`).split("@")[0]);
	ctx.font = `${Math.max(9, z * 0.55)}px system-ui`;
	ctx.textAlign = "center";
	ctx.textBaseline = "bottom";
	ctx.fillStyle = "rgba(0,0,0,0.7)";
	ctx.fillText(name, cx + 1, cy - r - 2);
	ctx.fillStyle = "#fff";
	ctx.fillText(name, cx, cy - r - 3);
}

function draw_men() {
	let z = view.zoom;
	for (let p = 0; p < 16; p++) {
		let m = cur.men[p];
		if (!m || cur.quit[p]) continue;
		if (clock - m.lastSeen > TPS * 3) continue;
		let cx = tile_to_screen_x(world_x(m));
		let cy = tile_to_screen_y(world_y(m));
		if (m.parachute) {
			let img = obj_sprite("lgm_helicopter");
			if (img) {
				ctx.drawImage(img, cx - z / 2, cy - z / 2, z, z);
				continue;
			}
			ctx.strokeStyle = "#fff";
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.arc(cx, cy - z * 0.15, Math.max(2.5, z * 0.3), Math.PI, 0);
			ctx.stroke();
		}
		/* men colour by allegiance to the viewpoint: friendly green, enemy red */
		ctx.fillStyle = "#fff";
		ctx.strokeStyle = side_color(p);
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.arc(cx, cy, Math.max(1.5, z * 0.14), 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
	}
}

function draw_shells() {
	let z = view.zoom;
	ctx.fillStyle = "#ffe678";
	for (let p = 0; p < 16; p++) {
		for (const sh of cur.shells[p]) {
			/* same half-tile centring as every other positioned object;
			 * verified against 3k muzzle samples (shell vs firing tank) */
			let cx = tile_to_screen_x(world_x(sh));
			let cy = tile_to_screen_y(world_y(sh));
			ctx.beginPath();
			ctx.arc(cx, cy, Math.max(1, z * 0.12), 0, Math.PI * 2);
			ctx.fill();
		}
	}
}

function draw_effects() {
	if (!game) return;
	let z = view.zoom;
	while (effect_lo < game.effects.length && game.effects[effect_lo].time < clock - EFFECT_TICKS) effect_lo++;
	for (let i = effect_lo; i < game.effects.length && game.effects[i].time <= clock; i++) {
		let e = game.effects[i];
		let age = (clock - e.time) / EFFECT_TICKS; /* 0..1 */
		let cx = tile_to_screen_x(e.x) + z / 2, cy = tile_to_screen_y(e.y) + z / 2;
		switch (e.type) {
			case "boom":
			case "tank_hit": {
				ctx.strokeStyle = `rgba(255,${180 - age * 120 | 0},60,${1 - age})`;
				ctx.lineWidth = Math.max(1, z * 0.12);
				ctx.beginPath();
				ctx.arc(cx, cy, (0.2 + age * 0.5) * z, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
			case "superboom":
			case "tank_death": {
				ctx.strokeStyle = `rgba(255,120,40,${1 - age})`;
				ctx.lineWidth = Math.max(1.5, z * 0.2);
				ctx.beginPath();
				ctx.arc(cx + z / 2, cy + z / 2, (0.4 + age * 1.6) * z, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
			case "pill_fire":
			case "muzzle": {
				ctx.fillStyle = `rgba(255,255,180,${(1 - age) * 0.9})`;
				ctx.beginPath();
				ctx.arc(cx, cy, Math.max(1, (0.25 - age * 0.15) * z), 0, Math.PI * 2);
				ctx.fill();
				break;
			}
			case "splash": {
				ctx.strokeStyle = `rgba(150,200,255,${1 - age})`;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc(cx, cy, (0.15 + age * 0.3) * z, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
			case "lgm_death": {
				ctx.strokeStyle = `rgba(255,255,255,${1 - age})`;
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc(cx, cy, (0.2 + age * 0.4) * z, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
		}
	}
}

/* ---------- loading ---------- */
const MAX_LOG_BYTES = 64 << 20;   /* larger than any plausible real log */
const MAX_RECORDS = 2_000_000;    /* ~16x the 2h sample; caps memory */

function load_log(bytes, name) {
	/* Parse fully before touching viewer state, so a malformed file leaves
	 * any currently loaded replay running. */
	let header, recs, newGame;
	const stats = {};
	try {
		if (bytes.length > MAX_LOG_BYTES) {
			throw new Error(`${bytes.length} bytes; not a Bolo log`);
		}
		header = BoloLog.parseHeader(bytes);
		recs = [];
		for (const rec of BoloLog.records(bytes, stats)) {
			if (recs.length >= MAX_RECORDS) {
				throw new Error(`more than ${MAX_RECORDS} records; refusing`);
			}
			recs.push(rec);
		}
		if (recs.length === 0) {
			throw new Error("no valid records in file");
		}
		newGame = BoloGame.build(recs);
	} catch (err) {
		show_error("Could not load log", String(err.message || err));
		return;
	}
	game = newGame;
	clock = game.t0;
	cur = BoloGame.clone_state(game.keyframes[0].state);
	cursor = 0;
	effect_lo = 0;
	set_clock(game.t0, true);

	drop_hint.classList.add("hidden");
	let gi = game.final.gameInfo;
	map_name_el.textContent = gi ? gi.mapName : (name || "Bolo log");
	/* version hex "00990700" → "0.99.7" */
	let v = `${parseInt(header.version.slice(0, 2), 16)}.${header.version.slice(2, 4)}.${parseInt(header.version.slice(4, 6), 10)}`;
	let bits = [`Bolo ${v}`,
		`${recs.length.toLocaleString()} records`, `${fmt_time(game.t1)} long`];
	if (gi) {
		bits.push(`host ${gi.hostIp}`);
		bits.push(["", "open game", "tournament", "strict tournament"][gi.gameType] || `type ${gi.gameType}`);
	}
	const warned = recs.filter(r => r.warning).length;
	if (warned) bits.push(`⚠ ${warned} records with parse warnings`);
	if (stats.truncatedBytes) bits.push(`⚠ truncated (${stats.truncatedBytes} trailing bytes dropped)`);
	game_meta_el.textContent = bits.filter(Boolean).join(" · ");

	viewpoint_el.innerHTML = "";
	viewpoint = -1;
	for (let p = 0; p < 16; p++) {
		if (game.final.names[p]) {
			if (viewpoint < 0) viewpoint = p;
			viewpoint_el.insertAdjacentHTML("beforeend",
				`<option value="${p}">viewpoint: ${esc(pretty(game.final.names[p].split("@")[0]))}</option>`);
		}
	}
	if (viewpoint >= 0) viewpoint_el.value = String(viewpoint);

	rebuild_chat(game.t0);
	zoom_to_action();
	set_playing(true);
}

function show_error(title, message) {
	if (window.api) window.api.show_error(title, message);
	else alert(`${title}: ${message}`);
}

/* ---------- input ---------- */
function toggle_obj_sprites() {
	use_obj_sprites = !use_obj_sprites;
	request_draw();
}

/* Controls give focus back to the window once used, so they don't sit
 * highlighted and don't capture the global playback keys (space, arrows). */
play_btn.addEventListener("click", () => {
	set_playing(!playing);
	play_btn.blur();
});
speed_el.addEventListener("change", () => {
	speed = parseFloat(speed_el.value);
	speed_el.blur();
});
viewpoint_el.addEventListener("change", () => {
	viewpoint = parseInt(viewpoint_el.value, 10);
	viewpoint_el.blur();
	request_draw();
});
seek_el.addEventListener("input", () => {
	if (!game) return;
	let tick = game.t0 + (parseInt(seek_el.value, 10) / 1000) * (game.t1 - game.t0);
	set_clock(tick, tick < clock);
});
/* Blur on release, not on change: change never fires for a click-and-hold
 * that doesn't move the thumb, which would leave the slider focused. */
seek_el.addEventListener("pointerup", () => seek_el.blur());
seek_el.addEventListener("change", () => seek_el.blur());

/* Save the map's earliest known state as a standard BMAPBOLO file. */
function save_initial_map() {
	if (!game) return;
	let map = BoloGame.extract_initial_map(game.records);
	let bytes;
	try {
		bytes = BoloMap.serialize_map(map);
	} catch (err) {
		show_error("Could not build map", String(err.message || err));
		return;
	}
	let gi = game.final.gameInfo;
	let name = ((gi && gi.mapName) || "map").replace(/[\/\\:]/g, "_") + ".map";
	if (window.api) {
		window.api.save_map(name, bytes).then(res => {
			if (res.error) show_error("Could not save map", res.error);
		});
	} else {
		let a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
		a.download = name;
		a.click();
		URL.revokeObjectURL(a.href);
	}
}

window.addEventListener("keydown", e => {
	if (!game) return;
	if (e.code === "KeyS" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault(); /* it's our save now, not the browser's */
		save_initial_map();
		return;
	}
	if (e.code === "Space") {
		e.preventDefault();
		set_playing(!playing);
	} else if (e.code === "ArrowLeft") {
		set_clock(clock - TPS * (e.shiftKey ? 60 : 10), true);
	} else if (e.code === "ArrowRight") {
		set_clock(clock + TPS * (e.shiftKey ? 60 : 10));
	} else if (e.code === "KeyG" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		toggle_obj_sprites();
	}
});

let panning = false, pan_start = null;
canvas.addEventListener("pointerdown", e => {
	panning = true;
	pan_start = { mx: e.offsetX, my: e.offsetY, ox: view.ox, oy: view.oy };
	canvas.setPointerCapture(e.pointerId);
	canvas.style.cursor = "grabbing";
});
canvas.addEventListener("pointermove", e => {
	if (panning && pan_start) {
		view.ox = pan_start.ox - (e.offsetX - pan_start.mx) / view.zoom;
		view.oy = pan_start.oy - (e.offsetY - pan_start.my) / view.zoom;
		clamp_view();
		request_draw();
	}
});
function end_pan() {
	panning = false;
	pan_start = null;
	canvas.style.cursor = "grab";
}
canvas.addEventListener("pointerup", end_pan);
canvas.addEventListener("pointercancel", end_pan);

canvas.addEventListener("wheel", e => {
	e.preventDefault();
	let idx = ZOOMS.indexOf(view.zoom);
	let nidx = Math.max(0, Math.min(ZOOMS.length - 1, idx + (e.deltaY < 0 ? 1 : -1)));
	zoom_to(ZOOMS[nidx], e.offsetX, e.offsetY);
}, { passive: false });

/* file loading: Electron IPC when available, else drag-drop / file picker */
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => {
	e.preventDefault();
	take_file(e.dataTransfer.files[0]);
});
drop_hint.addEventListener("click", () => file_pick.click());
file_pick.addEventListener("change", () => {
	take_file(file_pick.files[0]);
});

/* Check the size before reading the file into memory at all. */
function take_file(f) {
	if (!f) return;
	if (f.size > MAX_LOG_BYTES) {
		show_error("Could not load log", `${f.name} is ${f.size} bytes; not a Bolo log`);
		return;
	}
	f.arrayBuffer().then(
		ab => load_log(new Uint8Array(ab), f.name),
		err => show_error("Could not read file", String(err)));
}

if (window.api) {
	window.api.on_load_log(payload => load_log(payload.data, payload.path));
	window.api.on_menu(cmd => {
		switch (cmd) {
			case "open": window.api.open_log().then(res => {
				if (!res.canceled && res.data) load_log(res.data, res.path);
				else if (res.error) show_error("Could not open log", res.error);
			}); break;
			case "play-pause": set_playing(!playing); break;
			case "restart": if (game) { set_clock(game.t0, true); } break;
			case "zoom-in": zoom_step(1); break;
			case "zoom-out": zoom_step(-1); break;
			case "zoom-fit": zoom_to_action(); break;
			case "toggle-obj-sprites": toggle_obj_sprites(); break;
			case "save-map": save_initial_map(); break;
		}
	});
}

/* ---------- canvas sizing ---------- */
function resize() {
	let w = canvas.clientWidth, h = canvas.clientHeight;
	canvas.width = Math.max(1, Math.round(w * devicePixelRatio));
	canvas.height = Math.max(1, Math.round(h * devicePixelRatio));
	request_draw();
}
new ResizeObserver(resize).observe(canvas);
window.addEventListener("resize", resize);

/* tiny hooks for headless tests: centre the view on a tank or a square */
window.ABV = {
	centre_on(p) {
		if (!cur || !cur.tanks[p]) return false;
		return this.centre_at(world_x(cur.tanks[p]), world_y(cur.tanks[p]));
	},
	centre_at(tx, ty) {
		let { w, h } = css_size();
		view.ox = tx - w / (2 * view.zoom);
		view.oy = ty - h / (2 * view.zoom);
		request_draw();
		return true;
	},
	pills() {
		return cur ? cur.pills.map(p => ({ x: p.x, y: p.y, armour: p.armour, inTank: p.inTank })) : [];
	},
};

BoloSprites.load(request_draw);
load_obj_sprites();
resize();
zoom_label.textContent = `zoom ${view.zoom}×`;
