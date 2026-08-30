"use strict";
/* Bolo log viewer renderer: canvas world view + playback transport.
 * View handling (zoom steps, wheel-to-cursor, pan, flat-colour underlay with
 * sprite overlay) is duplicated from the lgm map editor's renderer. */

const { MAP_SIZE, DEEP_SEA } = BoloMap;
const TPS = BoloLog.TICKS_PER_SECOND;

const TERRAIN_COLORS = {
	0:  "#785e41",  /* building */
	1:  "#008391",  /* river */
	2:  "#003933",  /* swamp */
	3:  "#292911",  /* crater */
	4:  "#000000",  /* road */
	5:  "#045311",  /* forest */
	6:  "#303819",  /* rubble */
	7:  "#002806",  /* grass */
	8:  "#56422c",  /* shot building */
	9:  "#61848b",  /* boat on river */
	255: "#008a9e", /* deep sea */
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
const OBJ_NATIVE_TILE = 16;
const LGM_ANIMATION_FPS = 20;
const LGM_ANIMATION = ["lgm_frame0", "lgm_frame1", "lgm_frame0", "lgm_frame2"];

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
let use_lgm_sprites = true;
let use_big_shots = false;
let use_simple_terrain = false;
let coordinate_debug_enabled = false;
let pillbox_ids_enabled = false;
let pill_fire_flashes_enabled = false;
let raw_shells_enabled = false;
let obj_imgs = new Map();

function load_obj_sprites() {
	let names = ["base_good", "base_evil", "base_neutral", "lgm_helicopter",
		"lgm_frame0", "lgm_frame1", "lgm_frame2"];
	for (let i = 0; i < 16; i++) {
		let n = String(i).padStart(2, "0");
		names.push(`tank_good_${n}`, `tank_evil_${n}`, `tank_goodboat_${n}`, `tank_evilboat_${n}`,
			`pillbox_good_${n}`, `pillbox_evil_${n}`, `shell_${n}`);
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

function lgm_sprite() {
	if (!use_lgm_sprites || view.zoom < BoloSprites.MIN_ZOOM) return undefined;
	let frame = Math.floor(clock * LGM_ANIMATION_FPS / TPS) % LGM_ANIMATION.length;
	return obj_imgs.get(LGM_ANIMATION[frame]);
}

/* Object sprites are the same 16px art as the terrain, so at non-integer
 * device-pixel scales (zoom 24 on a 1× display) they need the same
 * sharp-bilinear treatment as the terrain atlas: nearest-prescale to the
 * next integer multiple, cached per image, then draw with smoothing on. */
let obj_scaled = new WeakMap(); /* img -> Map(factor -> prescaled canvas) */

function draw_obj_at_size(img, x, y, w, h) {
	let factor = BoloSprites.prescale_factor(view.zoom, render_dpr());
	let src = img;
	if (factor > 1) {
		let per = obj_scaled.get(img);
		if (!per) obj_scaled.set(img, per = new Map());
		src = per.get(factor);
		if (!src) {
			src = document.createElement("canvas");
			src.width = img.width * factor;
			src.height = img.height * factor;
			let sctx = src.getContext("2d");
			sctx.imageSmoothingEnabled = false;
			sctx.drawImage(img, 0, 0, src.width, src.height);
			per.set(factor, src);
		}
	}
	ctx.imageSmoothingEnabled = factor > 1;
	ctx.drawImage(src, x, y, w, h);
	ctx.imageSmoothingEnabled = false;
}

function draw_obj(img, x, y) {
	draw_obj_at_size(img, x, y, view.zoom, view.zoom);
}

/* LGM and shell sprites are tightly cropped art rather than full 16x16
 * tiles. Draw each source pixel at the same scale as a pixel in the other
 * object art. */
function draw_cropped_obj(img, cx, cy) {
	let scale = view.zoom / OBJ_NATIVE_TILE;
	let w = img.width * scale, h = img.height * scale;
	draw_obj_at_size(img, cx - w / 2, cy - h / 2, w, h);
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
let player_locked = false;
let effect_lo = 0;       /* rolling window start into game.effects */
let chat_shown = 0;
let last_frame = null;
let last_viewpoint_html = null;

/* Video export (video.js) runs the same draw path offline: it swaps ctx,
 * view, clock and cur for its own, points css_size at the fixed output
 * frame via export_target, and sets exporting so live inputs and queued
 * draws leave the swapped state alone until it is restored. */
let exporting = false;
let export_target = null; /* { w, h } of the export's world viewport */

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
let coordinate_debug_el = document.getElementById("coordinateDebug");
let coordinate_tile_el = document.getElementById("coordinateTile");
let coordinate_pixel_el = document.getElementById("coordinatePixel");
let drop_hint = document.getElementById("dropHint");
let map_name_el = document.getElementById("mapName");
let game_meta_el = document.getElementById("gameMeta");
let network_meta_el = document.getElementById("networkMeta");
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
	if (export_target) return { w: export_target.w, h: export_target.h };
	return { w: canvas.clientWidth, h: canvas.clientHeight };
}

/* The export canvas is exact output pixels; only the live canvas draws at
 * the display's device-pixel scale. */
function render_dpr() {
	return export_target ? 1 : devicePixelRatio;
}
function tile_to_screen_x(tx) { return (tx - view.ox) * view.zoom; }
function tile_to_screen_y(ty) { return (ty - view.oy) * view.zoom; }

let hover_point = null;
let pointer_buttons = 0;

function hover_point_from_event(e) {
	if (e.offsetX < 0 || e.offsetY < 0 ||
		e.offsetX >= canvas.clientWidth || e.offsetY >= canvas.clientHeight) return null;
	return { x: e.offsetX, y: e.offsetY };
}

function update_coordinate_debug() {
	if (!coordinate_debug_enabled || !cur || !hover_point || pointer_buttons !== 0) {
		coordinate_debug_el.hidden = true;
		return;
	}
	let pixel_x = Math.floor((view.ox + hover_point.x / view.zoom) * OBJ_NATIVE_TILE);
	let pixel_y = Math.floor((view.oy + hover_point.y / view.zoom) * OBJ_NATIVE_TILE);
	let max_pixel = MAP_SIZE * OBJ_NATIVE_TILE;
	if (pixel_x < 0 || pixel_y < 0 || pixel_x >= max_pixel || pixel_y >= max_pixel) {
		coordinate_debug_el.hidden = true;
		return;
	}
	coordinate_tile_el.textContent = `${Math.floor(pixel_x / OBJ_NATIVE_TILE)}, ${Math.floor(pixel_y / OBJ_NATIVE_TILE)}`;
	coordinate_pixel_el.textContent = `${pixel_x}, ${pixel_y}`;
	coordinate_debug_el.hidden = false;
}

function centre_locked_player() {
	if (!player_locked || !game || !cur || viewpoint < 0) return false;
	let position = BoloGame.tank_position_at(game, cur, viewpoint, clock);
	if (!position) return false;
	let { w, h } = css_size();
	view.ox = position.x - w / (2 * view.zoom);
	view.oy = position.y - h / (2 * view.zoom);
	return true;
}

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
		display_grid_version = -1; /* gridVersion restarts per game: a fresh
		    log's version 0 must not revive the previous log's cache */
		display_grid_cache = null;
		effect_lo = lower_bound_effect(tick - EFFECT_TICKS);
		rebuild_chat(tick);
	} else {
		while (cursor < game.records.length && game.records[cursor].time <= tick) {
			BoloGame.apply_record(cur, game.records[cursor], null, null, null, game.node_joins);
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

function step_change(direction) {
	if (!game) return;
	set_playing(false);
	let tick = BoloGame.adjacent_change_time(game.records, clock, direction);
	set_clock(tick, direction < 0);
}

function go_to_boundary(at_end) {
	if (!game) return;
	set_playing(false);
	set_clock(at_end ? game.t1 : game.t0, !at_end);
}

function fmt_time(ticks) {
	let s = Math.max(0, Math.floor((ticks - game.t0) / TPS));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function update_transport() {
	if (!game) return;
	time_label.textContent = `${fmt_time(clock)} / ${fmt_time(game.t1)}`;
	let bits = [
		`${cursor.toLocaleString()} / ${game.records.length.toLocaleString()} records`,
		game_type_label(),
	];
	game_meta_el.textContent = bits.filter(Boolean).join(" · ");
	let span = Math.max(1, game.t1 - game.t0);
	seek_el.value = Math.round(((clock - game.t0) / span) * 1000);
	update_viewpoint_options();
	update_players();
	update_chat();
}

function game_type_label() {
	let gi = game.final.gameInfo;
	if (!gi) return "";
	return ["", "open game", "tournament", "strict"][gi.gameType] ||
		`type ${gi.gameType}`;
}

/* ---------- sidebar ---------- */

/* Names belong to player slots and can change when a vacated slot is reused.
 * Follow the state at the playback clock rather than leaking the final names
 * backwards through the whole replay. Names deliberately survive quits, so a
 * departed player remains selectable until another node id takes their slot. */
function update_viewpoint_options() {
	let html = "";
	let first = -1;
	for (let p = 0; p < 16; p++) {
		if (!cur.names[p]) continue;
		if (first < 0) first = p;
		html += `<option value="${p}">${esc(pretty(cur.names[p].split("@")[0]))}</option>`;
	}
	if (last_viewpoint_html === html) return;

	last_viewpoint_html = html;
	viewpoint_el.innerHTML = html;
	if (viewpoint < 0 || !cur.names[viewpoint]) viewpoint = first;
	if (viewpoint >= 0) viewpoint_el.value = String(viewpoint);
}

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

/* The players panel's content, shared between the DOM panel and the video
 * export's canvas-painted sidebar. */
function player_rows() {
	let rows = [];
	for (let p = 0; p < 16; p++) {
		if (cur.names[p] === null && !cur.present[p]) continue;
		let name = pretty(cur.names[p] || `player ${p}`);
		let at = name.indexOf("@");
		rows.push({
			color: player_color(p),
			handle: at >= 0 ? name.slice(0, at) : name,
			host: at >= 0 ? name.slice(at + 1) : "",
			gone: !!cur.quit[p],
		});
	}
	return rows;
}

function update_players() {
	let html = "";
	for (let row of player_rows()) {
		html += `<div class="player${row.gone ? " gone" : ""}">` +
			`<span class="chip" style="background:${row.color}"></span>` +
			`<span>${esc(row.handle)}</span> <span class="host">${esc(row.host)}</span></div>`;
	}
	/* compare against our own last string, not innerHTML: the serializer
	 * re-encodes entities (e.g. U+00A0 as &nbsp;) so innerHTML never
	 * matches for some names and the panel would rebuild every frame */
	if (last_players_html !== html) { last_players_html = html; players_el.innerHTML = html; }
}
let last_players_html = null;

/* HTML-escape for text content. Quotes are NOT escaped — never interpolate
 * the result into an attribute value. */
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

/* One chat line's content as styled segments, shared between the DOM wire
 * and the video export's canvas-painted one. A segment with `who` set is
 * the speaker's coloured name; everything else inherits the line style. */
function chat_line_parts(m) {
	/* events carry a snapshot of name/team as of the event, so a seek
	 * rebuilds the same history a continuous watch produced */
	let who = pretty((m.name || cur.names[m.player] || `player ${m.player}`).split("@")[0]);
	let color = NAME_COLORS[m.team !== undefined ? m.team : BoloGame.team_of(cur, m.player)];
	if (m.join) return { time: m.time, sys: true, segments: [
		{ text: `⚑ ${pretty(m.text.split("@")[0])}` }] };
	if (m.rename) return { time: m.time, sys: true, segments: [
		{ text: `⇄ ${pretty((m.from || "").split("@")[0])} is now ${pretty(m.text.split("@")[0])}` }] };
	if (m.quit) return { time: m.time, sys: true, segments: [
		{ text: `✝ ${who} left the game` }] };
	let scope = m.address === 0xffff ? "" : " (to some)";
	return { time: m.time, sys: false, segments: [
		{ text: who, who: true, color },
		{ text: `${scope}: ${pretty(m.text)}` },
	] };
}

function chat_line(m) {
	let parts = chat_line_parts(m);
	let inner = parts.segments.map(s => s.who
		? `<span class="who" style="color:${s.color}">${esc(s.text)}</span>`
		: esc(s.text)).join("");
	return `<div class="msg${parts.sys ? " sys" : ""}">` +
		`<span class="t">${fmt_time(parts.time)}</span> ${inner}</div>`;
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
	if (exporting) return; /* the export drives draw() itself, synchronously */
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
	centre_locked_player();
	let { w, h } = css_size();
	let z = view.zoom;

	if (off_version !== cur.gridVersion) rebuild_offscreen();

	let dpr = render_dpr();
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.fillStyle = "#0a0e16";
	ctx.fillRect(0, 0, w, h);
	ctx.imageSmoothingEnabled = false;
	ctx.drawImage(off, view.ox, view.oy, w / z, h / z, 0, 0, w, h);

	/* Mines are hidden with the other fine detail below the sprite threshold.
	 * Above it, their atlas sprites draw even when simple terrain is forced. */
	if (z >= BoloSprites.MIN_ZOOM) {
		BoloSprites.draw_view(ctx, display_grid(), view, w, h, !use_simple_terrain, dpr);
	}

	draw_bases();
	draw_pills(true);
	draw_shells();
	draw_pills(false);
	draw_pillbox_labels();
	draw_effects();
	draw_men();
	draw_tanks();
	update_coordinate_debug();
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
			draw_obj(img, tile_to_screen_x(b.x), tile_to_screen_y(b.y));
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

function draw_pills(dead) {
	let z = view.zoom;
	let r = Math.max(2, z * 0.36);
	let good = good_team();
	for (let p of cur.pills) {
		if (p.inTank !== null || (p.armour === 0) !== dead) continue;
		let cx = tile_to_screen_x(p.x) + z / 2;
		let cy = tile_to_screen_y(p.y) + z / 2;
		/* the art shows neutral pills as hostile; armour state 0 is the dead look */
		let side = p.owner !== BoloGame.NEUTRAL && BoloGame.team_of(cur, p.owner) === good ? "good" : "evil";
		let img = obj_sprite(`pillbox_${side}_${String(Math.min(15, p.armour)).padStart(2, "0")}`);
		if (img) {
			draw_obj(img, tile_to_screen_x(p.x), tile_to_screen_y(p.y));
			continue;
		}
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

function draw_pillbox_labels() {
	if (!pillbox_ids_enabled) return;
	let z = view.zoom;
	let r = Math.max(3, z * 0.45);
	for (let pillbox = 0; pillbox < cur.pills.length; pillbox++) {
		let p = cur.pills[pillbox];
		if (p.inTank !== null) continue;
		let cx = tile_to_screen_x(p.x) + z / 2;
		let cy = tile_to_screen_y(p.y) + z / 2;
		draw_object_label(`#${pillbox}`, cx, cy, r);
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
		let position = BoloGame.tank_position_at(game, cur, p, clock);
		if (!position) continue; /* can't happen for tank tracks today, but
		    the helper's contract allows null (see the LGM tank-entry case) */
		let cx = tile_to_screen_x(position.x);
		let cy = tile_to_screen_y(position.y);
		ctx.save();
		/* tanks hidden in trees draw normally — replay watchers see all;
		 * only ghost tanks (ring splits, long unheard-from) fade */
		ctx.globalAlpha = stale ? 0.25 : 1;
		/* sprite indices match the log: 0 = north, clockwise (4 = east) */
		let direction = position.direction;
		let img = obj_sprite(`tank_${side_of(p)}${t.inBoat ? "boat" : ""}_${String(direction).padStart(2, "0")}`);
		if (img) {
			draw_obj(img, cx - z / 2, cy - z / 2);
			ctx.restore();
			draw_tank_label(p, cx, cy, r);
			continue;
		}
		ctx.translate(cx, cy);
		ctx.rotate((direction / 16) * Math.PI * 2); /* 0 = north, clockwise */
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
	let name = pretty((cur.names[p] || `p${p}`).split("@")[0]);
	draw_object_label(name, cx, cy, r);
}

function draw_object_label(label, cx, cy, r) {
	let z = view.zoom;
	if (z < 8) return;
	ctx.font = `${Math.max(9, z * 0.55)}px system-ui`;
	ctx.textAlign = "center";
	ctx.textBaseline = "bottom";
	ctx.fillStyle = "rgba(0,0,0,0.7)";
	ctx.fillText(label, cx + 1, cy - r - 2);
	ctx.fillStyle = "#fff";
	ctx.fillText(label, cx, cy - r - 3);
}

function draw_men() {
	let z = view.zoom;
	for (let p = 0; p < 16; p++) {
		let m = cur.men[p];
		if (!m || cur.quit[p]) continue;
		if (clock - m.lastSeen > TPS * 3) continue;
		let position = BoloGame.lgm_position_at(game, cur, p, clock);
		if (!position) continue;
		let cx = tile_to_screen_x(position.x);
		let cy = tile_to_screen_y(position.y);
		if (m.parachute) {
			let img = obj_sprite("lgm_helicopter");
			if (img) {
				draw_obj(img, cx - z / 2, cy - z / 2);
				continue;
			}
			ctx.strokeStyle = "#fff";
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.arc(cx, cy - z * 0.15, Math.max(2.5, z * 0.3), Math.PI, 0);
			ctx.stroke();
		}
		let img = lgm_sprite();
		if (img) {
			draw_cropped_obj(img, cx, cy);
			continue;
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
	ctx.fillStyle = use_big_shots ? "#ffe678" : "#fff";
	let radius = Math.max(1, z * 0.12);
	let small_size = Math.max(1, z / 8);
	let draw_shell = (position, direction) => {
		let cx = tile_to_screen_x(position.x);
		let cy = tile_to_screen_y(position.y);
		/* Big shots deliberately override the classic direction sprites.
		 * obj_sprite adds the other two gates: object graphics on and zoom
		 * at or above the shared sprite threshold. */
		let img = !use_big_shots
			? obj_sprite(`shell_${String(direction).padStart(2, "0")}`)
			: undefined;
		if (img) {
			draw_cropped_obj(img, cx, cy);
			return;
		}
		if (!use_big_shots) {
			ctx.fillRect(cx - small_size / 2, cy - small_size / 2,
				small_size, small_size);
			return;
		}
		ctx.beginPath();
		ctx.arc(cx, cy, radius, 0, Math.PI * 2);
		ctx.fill();
	};
	for (let p = 0; p < 16; p++) {
		for (let i = 0; i < cur.shells[p].length; i++) {
			let sh = cur.shells[p][i];
			/* same half-tile centring as every other positioned object;
			 * verified against 3k muzzle samples (shell vs firing tank) */
			let position = BoloGame.shell_position_at(game, p, sh, i, clock);
			if (!position) continue;
			draw_shell(position, sh.direction);
		}
		for (let birth of BoloGame.shell_birth_positions_at(game, p, clock)) {
			draw_shell(birth, birth.direction);
		}
		for (let fall of BoloGame.shell_fall_positions_at(game, p, clock)) {
			draw_shell(fall, fall.direction);
		}
	}
	if (raw_shells_enabled) draw_raw_shells();
}

/* Debug overlay: the raw packet-stated shell positions, drawn as red
 * dots over the reconstructed sprites. The dot is the sender's last
 * claim (delayed, quantised, jittered); the sprite is the reconstruction
 * flying between restatements. The gap between them is exactly how far
 * the interpolation departs from the literal log. */
function draw_raw_shells() {
	let z = view.zoom;
	let radius = Math.max(1, z * 0.09);
	ctx.fillStyle = "#f22";
	for (let p = 0; p < 16; p++) {
		for (let sh of cur.shells[p]) {
			/* same pixel-to-tile centring as shell_position_at */
			let cx = tile_to_screen_x((sh.x * 16 + sh.px) / 16 + 0.5);
			let cy = tile_to_screen_y((sh.y * 16 + sh.py) / 16 + 0.5);
			ctx.beginPath();
			ctx.arc(cx, cy, radius, 0, Math.PI * 2);
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
		/* effects with pixel offsets position like any world object;
		 * tile-only effects centre on their square */
		let cx = e.px !== undefined ? tile_to_screen_x(world_x(e)) : tile_to_screen_x(e.x) + z / 2;
		let cy = e.py !== undefined ? tile_to_screen_y(world_y(e)) : tile_to_screen_y(e.y) + z / 2;
		switch (e.type) {
			case "boom":
			case "pill_hit":
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
				/* a superboom craters the 2x2 block whose NW square is (x,y),
				 * so its ring centres on the block's middle corner; a tank
				 * death centres on its single square */
				let off = e.type === "superboom" ? z / 2 : 0;
				ctx.strokeStyle = `rgba(255,120,40,${1 - age})`;
				ctx.lineWidth = Math.max(1.5, z * 0.2);
				ctx.beginPath();
				ctx.arc(cx + off, cy + off, (0.4 + age * 1.6) * z, 0, Math.PI * 2);
				ctx.stroke();
				break;
			}
			case "flame": {
				/* burning wreck: small fireball at the flame position */
				let r = Math.max(1.5, (0.38 - age * 0.15) * z);
				ctx.fillStyle = `rgba(255,90,30,${0.8 * (1 - age)})`;
				ctx.beginPath();
				ctx.arc(cx, cy, r, 0, Math.PI * 2);
				ctx.fill();
				ctx.fillStyle = `rgba(255,220,90,${0.9 * (1 - age)})`;
				ctx.beginPath();
				ctx.arc(cx, cy, Math.max(1, r * 0.55), 0, Math.PI * 2);
				ctx.fill();
				break;
			}
			case "pill_fire": {
				if (!pill_fire_flashes_enabled) break;
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

function loading_stage(label, progress) {
	return new Promise(resolve => requestAnimationFrame(() => {
		let { w, h } = css_size();
		let bar_width = Math.min(600, w * 0.75), bar_height = 56;
		let x = (w - bar_width) / 2, y = (h - bar_height) / 2;
		ctx.save();
		ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
		ctx.fillStyle = "#161b26";
		ctx.fillRect(x, y, bar_width, bar_height);
		ctx.fillStyle = "#5b8def";
		ctx.fillRect(x, y, bar_width * progress, bar_height);
		ctx.strokeStyle = "#000000";
		ctx.lineWidth = 2;
		ctx.strokeRect(x, y, bar_width, bar_height);
		ctx.fillStyle = "#ffffff";
		ctx.font = "600 17px system-ui, sans-serif";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(label, w / 2, h / 2);
		ctx.restore();
		requestAnimationFrame(resolve);
	}));
}

async function load_log(bytes, name) {
	if (exporting) return; /* the export owns the viewer state until done */
	/* Parse fully before touching viewer state, so a malformed file leaves
	 * any currently loaded replay running. */
	let was_playing = playing;
	let had_drop_hint = !drop_hint.classList.contains("hidden");
	let recs, new_game;
	set_playing(false);
	drop_hint.classList.add("hidden");
	try {
		await loading_stage("Parsing log…", 1 / 3);
		if (bytes.length > MAX_LOG_BYTES) {
			throw new Error(`${bytes.length} bytes; not a Bolo log`);
		}
		BoloLog.parseHeader(bytes);
		recs = [];
		for (const rec of BoloLog.records(bytes)) {
			if (recs.length >= MAX_RECORDS) {
				throw new Error(`more than ${MAX_RECORDS} records; refusing`);
			}
			recs.push(rec);
		}
		if (recs.length === 0) {
			throw new Error("no valid records in file");
		}
		await loading_stage("Reconstructing game…", 2 / 3);
		new_game = BoloGame.build(recs);
		await loading_stage("Opening replay…", 1);
	} catch (err) {
		if (cur) draw();
		else {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, canvas.width, canvas.height);
		}
		if (had_drop_hint) drop_hint.classList.remove("hidden");
		set_playing(was_playing);
		show_error("Could not load log", String(err.message || err));
		return;
	}
	game = new_game;
	player_locked = false;
	update_lock_indicator();
	viewpoint = -1;
	last_viewpoint_html = null;
	clock = game.t0;
	cur = BoloGame.clone_state(game.keyframes[0].state);
	cursor = 0;
	effect_lo = 0;
	set_clock(game.t0, true);

	drop_hint.classList.add("hidden");
	/* keep the source path/filename: shown in the window title and
	 * available as ABV.filename in the dev console */
	loaded_name = name || null;
	document.title = (name ? name.split(/[\\/]/).pop() + " — " : "") + "Ancient Bolo Log Viewer";
	let gi = game.final.gameInfo;
	map_name_el.textContent = gi ? gi.mapName : (name || "Bolo log");

	/* One verdict for the whole log, so it is set here and not in
	 * update_transport: the network was what it was, and a figure that
	 * crept about as the clock moved would only invite reading it as live. */
	let net = game.network;
	network_meta_el.textContent = net ? `Network conditions: ${net.rating}` : "";
	network_meta_el.title = net ?
		`${net.loss.toFixed(1)}% of packets lost, ` +
		`${net.stall.toFixed(1)}% of the time spent frozen; ` +
		`measured over settled play, ${fmt_time(net.from)} to ${fmt_time(net.to)}` : "";

	rebuild_chat(game.t0);
	zoom_to_action();
	set_playing(true);
	if (window.api && name) window.api.file_loaded(name);
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

function toggle_lgm_sprites() {
	use_lgm_sprites = !use_lgm_sprites;
	request_draw();
}

function toggle_big_shots() {
	use_big_shots = !use_big_shots;
	request_draw();
}

function toggle_simple_terrain() {
	use_simple_terrain = !use_simple_terrain;
	request_draw();
}

function toggle_coordinate_debug() {
	coordinate_debug_enabled = !coordinate_debug_enabled;
	update_coordinate_debug();
}

function toggle_pillbox_ids() {
	pillbox_ids_enabled = !pillbox_ids_enabled;
	request_draw();
}

function toggle_raw_shells() {
	raw_shells_enabled = !raw_shells_enabled;
	request_draw();
}

function toggle_pill_fire_flashes() {
	pill_fire_flashes_enabled = !pill_fire_flashes_enabled;
	request_draw();
}

function toggle_player_lock() {
	if (!game || viewpoint < 0) return;
	player_locked = !player_locked;
	update_lock_indicator();
	centre_locked_player();
	request_draw();
}

/* The lock's only always-on indicator: the player selector goes friendly
 * green while the view is locked to its player. Called wherever
 * player_locked changes (the toggle, panning away, loading a log). */
function update_lock_indicator() {
	viewpoint_el.classList.toggle("locked", player_locked);
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
	centre_locked_player();
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
	if (exporting) {
		/* the overlay blocks the pointer; keys are blocked here, with Escape
		 * as the keyboard route to the overlay's cancel button */
		if (e.code === "Escape") {
			e.preventDefault();
			cancel_video_export();
		}
		return;
	}
	if (e.code === "Escape" && window.api) {
		e.preventDefault();
		window.api.exit_fullscreen();
		return;
	}
	if (e.code === "KeyO" && (e.ctrlKey || e.metaKey) && e.shiftKey && window.api) {
		e.preventDefault();
		window.api.show_file();
		return;
	}
	if (e.code === "KeyD" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		toggle_coordinate_debug();
		return;
	}
	if (e.code === "KeyI" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
		e.preventDefault();
		toggle_pillbox_ids();
		return;
	}
	if (e.code === "KeyF" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		toggle_pill_fire_flashes();
		return;
	}
	if (!game) return;
	if (e.code === "KeyS" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault(); /* it's our save now, not the browser's */
		save_initial_map();
		return;
	}
	if (/^F[1-8]$/.test(e.code)) {
		e.preventDefault();
		speed_el.selectedIndex = parseInt(e.code.slice(1), 10) - 1;
		speed = parseFloat(speed_el.value);
		speed_el.blur();
	} else if (e.code === "Space") {
		e.preventDefault();
		set_playing(!playing);
	} else if (e.code === "ArrowDown") {
		e.preventDefault();
		step_change(1);
	} else if (e.code === "ArrowUp") {
		e.preventDefault();
		step_change(-1);
	} else if (e.code === "Home") {
		e.preventDefault();
		go_to_boundary(false);
	} else if (e.code === "End") {
		e.preventDefault();
		go_to_boundary(true);
	} else if (e.code === "ArrowLeft") {
		set_clock(clock - TPS * (e.shiftKey ? 60 : 10), true);
	} else if (e.code === "ArrowRight") {
		set_clock(clock + TPS * (e.shiftKey ? 60 : 10));
	} else if (e.code === "KeyL" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		toggle_player_lock();
	} else if (e.code === "KeyG" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		toggle_obj_sprites();
	} else if (e.code === "KeyM" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		toggle_lgm_sprites();
	} else if (e.code === "KeyB" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		toggle_big_shots();
	} else if (e.code === "KeyR" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		toggle_raw_shells();
	} else if (e.code === "KeyT" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		toggle_simple_terrain();
	}
});

let panning = false, pan_start = null;
canvas.addEventListener("pointerdown", e => {
	pointer_buttons = e.buttons;
	hover_point = hover_point_from_event(e);
	update_coordinate_debug();
	panning = true;
	pan_start = { mx: e.offsetX, my: e.offsetY, ox: view.ox, oy: view.oy };
	canvas.setPointerCapture(e.pointerId);
	canvas.style.cursor = "grabbing";
});
canvas.addEventListener("pointermove", e => {
	pointer_buttons = e.buttons;
	hover_point = hover_point_from_event(e);
	if (panning && pan_start) {
		if (e.offsetX !== pan_start.mx || e.offsetY !== pan_start.my) {
			player_locked = false;
			update_lock_indicator();
		}
		view.ox = pan_start.ox - (e.offsetX - pan_start.mx) / view.zoom;
		view.oy = pan_start.oy - (e.offsetY - pan_start.my) / view.zoom;
		clamp_view();
		request_draw();
	}
	update_coordinate_debug();
});
function end_pan(e) {
	panning = false;
	pan_start = null;
	pointer_buttons = e.buttons;
	if (e.type === "pointercancel") hover_point = null;
	else hover_point = hover_point_from_event(e);
	canvas.style.cursor = "grab";
	update_coordinate_debug();
}
canvas.addEventListener("pointerup", end_pan);
canvas.addEventListener("pointercancel", end_pan);
canvas.addEventListener("pointerleave", () => {
	hover_point = null;
	update_coordinate_debug();
});
canvas.addEventListener("pointerenter", e => {
	pointer_buttons = e.buttons;
	hover_point = hover_point_from_event(e);
	update_coordinate_debug();
});

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
	if (!f || exporting) return;
	if (f.size > MAX_LOG_BYTES) {
		show_error("Could not load log", `${f.name} is ${f.size} bytes; not a Bolo log`);
		return;
	}
	let file_path = window.api ? window.api.file_path(f) : f.name;
	f.arrayBuffer().then(
		ab => load_log(new Uint8Array(ab), file_path),
		err => show_error("Could not read file", String(err)));
}

if (window.api) {
	window.api.on_load_log(payload => load_log(payload.data, payload.path));
	window.api.on_menu(cmd => {
		if (exporting) return;
		switch (cmd) {
			case "open": window.api.open_log().then(res => {
				if (!res.canceled && res.data) load_log(res.data, res.path);
				else if (res.error) show_error("Could not open log", res.error);
			}); break;
			case "play-pause": set_playing(!playing); break;
			case "previous-change": step_change(-1); break;
			case "next-change": step_change(1); break;
			case "go-to-beginning": go_to_boundary(false); break;
			case "go-to-end": go_to_boundary(true); break;
			case "zoom-in": zoom_step(1); break;
			case "zoom-out": zoom_step(-1); break;
			case "zoom-fit": zoom_to_action(); break;
			case "toggle-player-lock": toggle_player_lock(); break;
			case "toggle-obj-sprites": toggle_obj_sprites(); break;
			case "toggle-lgm-sprites": toggle_lgm_sprites(); break;
			case "toggle-big-shots": toggle_big_shots(); break;
			case "toggle-simple-terrain": toggle_simple_terrain(); break;
			case "toggle-coordinate-debug": toggle_coordinate_debug(); break;
			case "toggle-pillbox-ids": toggle_pillbox_ids(); break;
			case "toggle-pill-fire-flashes": toggle_pill_fire_flashes(); break;
			case "toggle-raw-shells": toggle_raw_shells(); break;
			case "save-map": save_initial_map(); break;
			case "save-video-all": if (game) export_video(game.t0); break;
			case "save-video-here": if (game) export_video(clock); break;
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

let loaded_name = null;

/* tiny hooks for headless tests: centre the view on a tank or a square */
window.ABV = {
	get filename() { return loaded_name; },
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
