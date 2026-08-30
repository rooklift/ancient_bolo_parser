"use strict";
/* Video export: renders the replay offline into a WebM file. Playback is a
 * pure function of the clock, so instead of capturing the live window the
 * export steps the clock by exact per-frame increments and draws each frame
 * to a fixed 1920x1080 canvas — deterministic output at any speed, immune
 * to window size and dropped frames. Frames go through a WebCodecs encoder
 * into the hand-rolled muxer (webm.js) and stream to disk over IPC.
 *
 * The export reuses the live draw path by swapping the renderer's globals
 * (ctx, view, clock, cur) for its own for the duration; `exporting` blocks
 * every input route that could touch them (see renderer.js). The user's
 * current framing carries over: same zoom, same world centre, player lock
 * and viewpoint as chosen, and the current playback speed becomes the
 * video's time compression. The sidebar (game info, players, message wire)
 * is painted onto the canvas from the same content the DOM panels use,
 * with the clock in place of the live record count. */

const EXPORT_FPS = 60;
const EXPORT_W = 1920;
const EXPORT_H = 1080;
const EXPORT_SIDEBAR_W = 322;                     /* matches #sidebar in style.css */
const EXPORT_WORLD_W = EXPORT_W - EXPORT_SIDEBAR_W;
const EXPORT_BITRATE = 8_000_000;                 /* generous for flat 1080p60 art */
const EXPORT_KEYFRAME_EVERY = 120;                /* frames; one cluster per 2s */
const EXPORT_QUEUE_LIMIT = 8;                     /* encoder frames in flight */
const EXPORT_WRITE_CHUNK = 1 << 20;               /* buffered bytes per IPC write */
const EX_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

let export_overlay = document.getElementById("exportOverlay");
let export_label = document.getElementById("exportLabel");
let export_bar_fill = document.getElementById("exportBarFill");
let export_cancel_btn = document.getElementById("exportCancel");

let export_cancel_requested = false;
let export_error = null;
let export_chat_cache = null; /* chat index -> wrapped lines, fixed per export */
let ex_write_queue = [];
let ex_write_bytes = 0;

export_cancel_btn.addEventListener("click", () => cancel_video_export());

function cancel_video_export() {
	if (exporting) export_cancel_requested = true;
}

async function export_video(start_tick) {
	if (!game || exporting) return;
	if (!window.api) {
		show_error("Cannot export video", "video export needs the desktop app");
		return;
	}
	if (typeof VideoEncoder === "undefined") {
		show_error("Cannot export video", "this build has no WebCodecs video encoder");
		return;
	}
	set_playing(false);

	/* Each output frame advances the clock by a fixed tick step, so the
	 * current playback speed is baked in as the video's time compression. */
	let step = TPS * speed / EXPORT_FPS;
	let total = Math.max(1, Math.floor((game.t1 - start_tick) / step) + 1);
	let duration_ms = total * 1000 / EXPORT_FPS;

	let picked = await ex_pick_config();
	if (!picked) {
		show_error("Cannot export video", "no supported VP9/VP8 encoder found");
		return;
	}

	let gi = game.final.gameInfo;
	let default_name = ((gi && gi.mapName) || "replay").replace(/[\/\\:]/g, "_") + ".webm";
	let begin = await window.api.video_begin(default_name);
	if (begin.canceled || begin.error) {
		if (begin.error) show_error("Could not export video", begin.error);
		return;
	}

	/* ---- take over the viewer until restored in the finally below ---- */
	exporting = true;
	export_cancel_requested = false;
	export_error = null;
	export_chat_cache = new Map();
	ex_write_queue = [];
	ex_write_bytes = 0;
	export_overlay.classList.remove("hidden");

	let saved = { clock, view, ctx };
	/* keep the live framing: same zoom, same world centre, recentred for
	 * the export's world viewport (player lock re-centres per frame) */
	let live = { w: canvas.clientWidth, h: canvas.clientHeight };
	view = {
		zoom: view.zoom,
		ox: view.ox + (live.w - EXPORT_WORLD_W) / (2 * view.zoom),
		oy: view.oy + (live.h - EXPORT_H) / (2 * view.zoom),
	};
	let export_canvas = document.createElement("canvas");
	export_canvas.width = EXPORT_W;
	export_canvas.height = EXPORT_H;
	ctx = export_canvas.getContext("2d", { alpha: false });
	export_target = { w: EXPORT_WORLD_W, h: EXPORT_H };

	let at = BoloGame.state_at(game, start_tick);
	cur = at.state;
	cursor = at.index;
	clock = start_tick;
	effect_lo = lower_bound_effect(start_tick - EFFECT_TICKS);
	off_version = -1;
	display_grid_version = -1;
	display_grid_cache = null;

	let muxer = BoloWebM.create_muxer({
		width: EXPORT_W, height: EXPORT_H, codec_id: picked.codec_id,
	});
	ex_queue(muxer.header(duration_ms));

	let encoder = new VideoEncoder({
		output: chunk => {
			let data = new Uint8Array(chunk.byteLength);
			chunk.copyTo(data);
			ex_queue(muxer.add_block(data,
				Math.round(chunk.timestamp / 1000), chunk.type === "key"));
		},
		error: err => { if (!export_error) export_error = err; },
	});
	encoder.configure(picked.config);

	let ok = false;
	try {
		ex_progress(0, total);
		for (let i = 0; i < total; i++) {
			if (export_cancel_requested) break;
			if (export_error) throw export_error;
			clock = Math.min(game.t1, start_tick + i * step);
			while (cursor < game.records.length && game.records[cursor].time <= clock) {
				BoloGame.apply_record(cur, game.records[cursor], null, null, null, game.node_joins);
				cursor++;
			}
			draw();
			draw_export_sidebar();
			let frame = new VideoFrame(export_canvas, {
				timestamp: Math.round(i * 1e6 / EXPORT_FPS),
				duration: Math.round(1e6 / EXPORT_FPS),
			});
			encoder.encode(frame, { keyFrame: i % EXPORT_KEYFRAME_EVERY === 0 });
			frame.close();
			await ex_backpressure(encoder);
			await ex_flush_writes(false);
			if (i % 15 === 0) {
				ex_progress(i, total);
				await ex_yield();
			}
		}
		if (!export_cancel_requested) {
			ex_progress(total, total);
			await encoder.flush();
			if (export_error) throw export_error;
			let fin = muxer.finalize(duration_ms);
			ex_queue(fin.tail);
			await ex_flush_writes(true);
			for (let patch of fin.patches) {
				let res = await window.api.video_patch(patch.offset, patch.bytes);
				if (res && res.error) throw new Error(res.error);
			}
			let end = await window.api.video_end();
			if (end && end.error) throw new Error(end.error);
			ok = true;
		}
	} catch (err) {
		show_error("Could not export video", String((err && err.message) || err));
	} finally {
		try { encoder.close(); } catch { /* already closed */ }
		if (!ok) await window.api.video_abort(); /* cancelled or failed: no partial file */
		ex_write_queue = [];
		ex_write_bytes = 0;
		export_chat_cache = null;
		export_target = null;
		ctx = saved.ctx;
		view = saved.view;
		exporting = false;
		export_overlay.classList.add("hidden");
		set_clock(saved.clock, true); /* hard seek restores state and caches */
	}
}

/* VP9 with a VP8 fallback: both are WebM-native and need no codec private
 * data, which is what keeps the muxer small. */
async function ex_pick_config() {
	let base = {
		width: EXPORT_W, height: EXPORT_H,
		bitrate: EXPORT_BITRATE, framerate: EXPORT_FPS,
	};
	for (let choice of [
		{ codec: "vp09.00.10.08", codec_id: "V_VP9" },
		{ codec: "vp8", codec_id: "V_VP8" },
	]) {
		try {
			let support = await VideoEncoder.isConfigSupported({ ...base, codec: choice.codec });
			if (support.supported) {
				return { config: { ...base, codec: choice.codec }, codec_id: choice.codec_id };
			}
		} catch { /* codec string not recognised: try the next */ }
	}
	return null;
}

function ex_progress(done, total) {
	export_bar_fill.style.width = `${Math.floor((done / total) * 100)}%`;
	export_label.textContent = done >= total ? "Writing file…"
		: `Frame ${done.toLocaleString()} of ${total.toLocaleString()}`;
}

function ex_queue(bytes) {
	if (bytes.length === 0) return;
	ex_write_queue.push(bytes);
	ex_write_bytes += bytes.length;
}

async function ex_flush_writes(all) {
	if (!all && ex_write_bytes < EXPORT_WRITE_CHUNK) return;
	while (ex_write_bytes > 0) {
		let parts = ex_write_queue;
		let buf = new Uint8Array(ex_write_bytes);
		ex_write_queue = [];
		ex_write_bytes = 0;
		let n = 0;
		for (let p of parts) { buf.set(p, n); n += p.length; }
		let res = await window.api.video_write(buf);
		if (res && res.error) throw new Error(res.error);
		if (!all) break;
	}
}

/* A task break that lets the overlay repaint without using a timer:
 * backgrounded windows throttle setTimeout to a second or worse, which
 * would slow the export to a crawl the moment the app loses focus, but
 * MessageChannel tasks are never throttled. */
function ex_yield() {
	return new Promise(resolve => {
		let channel = new MessageChannel();
		channel.port1.onmessage = () => resolve();
		channel.port2.postMessage(null);
	});
}

/* Wait for the encoder to drain below the queue limit. Driven by the
 * encoder's own dequeue events for the same reason as ex_yield — a timer
 * here would throttle the whole export in a backgrounded window — with a
 * slow timer as the safety net (and the whole mechanism, for encoders
 * predating the dequeue event). */
function ex_backpressure(encoder) {
	if (encoder.encodeQueueSize <= EXPORT_QUEUE_LIMIT) return Promise.resolve();
	return new Promise(resolve => {
		let timer = null;
		let check = () => {
			if (encoder.encodeQueueSize <= EXPORT_QUEUE_LIMIT ||
				export_error || export_cancel_requested) {
				encoder.removeEventListener("dequeue", check);
				clearTimeout(timer);
				resolve();
			} else {
				clearTimeout(timer);
				timer = setTimeout(check, 250);
			}
		};
		encoder.addEventListener("dequeue", check);
		timer = setTimeout(check, 250);
	});
}

/* ---------- the canvas-painted sidebar ----------
 * A hand-painted copy of the DOM sidebar, sized and coloured from
 * style.css. Content comes from the same builders the DOM panels use
 * (player_rows, chat_line_parts), so only the painting is duplicated. */

function draw_export_sidebar() {
	let x0 = EXPORT_WORLD_W;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.fillStyle = "#141925";
	ctx.fillRect(x0, 0, EXPORT_SIDEBAR_W, EXPORT_H);
	ctx.fillStyle = "#262d3d"; /* border-left */
	ctx.fillRect(x0, 0, 1, EXPORT_H);
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
	let cx = x0 + 1 + 12; /* panel padding */
	let cw = EXPORT_SIDEBAR_W - 1 - 24;

	let y = ex_game_panel(x0, cx, cw, 0);
	y = ex_players_panel(x0, cx, cw, y);
	ex_chat_panel(x0, cx, cw, y);
}

function ex_h2(cx, cw, y, text) {
	ctx.font = `bold 12px ${EX_FONT}`;
	ctx.letterSpacing = "0.96px"; /* 0.08em of 12px */
	ctx.fillStyle = "#8b96ad";
	ctx.fillText(ex_truncate(text.toUpperCase(), cw), cx, y + 13);
	ctx.letterSpacing = "0px";
	return y + 17 + 6; /* line height + margin below */
}

function ex_panel_border(x0, y) {
	ctx.fillStyle = "#232939";
	ctx.fillRect(x0 + 1, y, EXPORT_SIDEBAR_W - 1, 1);
	return y + 1;
}

function ex_truncate(text, max_w) {
	if (ctx.measureText(text).width <= max_w) return text;
	while (text.length > 0 && ctx.measureText(text + "…").width > max_w) {
		text = text.slice(0, -1);
	}
	return text + "…";
}

function ex_game_panel(x0, cx, cw, y) {
	y += 10;
	y = ex_h2(cx, cw, y, map_name_el.textContent);
	ctx.font = `12px ${EX_FONT}`;
	ctx.fillStyle = "#8b96ad";
	/* the clock stands in for the live record count */
	let meta = [`${fmt_time(clock)} / ${fmt_time(game.t1)}`, game_type_label()]
		.filter(Boolean).join(" · ");
	ctx.fillText(ex_truncate(meta, cw), cx, y + 13);
	y += 17;
	let net = network_meta_el.textContent;
	if (net) {
		ctx.fillText(ex_truncate(net, cw), cx, y + 13);
		y += 17;
	}
	return ex_panel_border(x0, y + 10);
}

function ex_players_panel(x0, cx, cw, y) {
	y += 10;
	y = ex_h2(cx, cw, y, "Players");
	for (let row of player_rows()) {
		let mid = y + 11;
		ctx.fillStyle = row.color;
		ctx.strokeStyle = "rgba(255,255,255,0.35)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.roundRect(cx + 0.5, mid - 4.5, 10, 10, 2);
		ctx.fill();
		ctx.stroke();
		let tx = cx + 10 + 8;
		ctx.font = `13px ${EX_FONT}`;
		ctx.fillStyle = row.gone ? "#667" : "#cfd6e4";
		let handle = ex_truncate(row.handle, cx + cw - tx);
		ctx.fillText(handle, tx, mid + 4);
		let end = tx + ctx.measureText(handle).width;
		if (row.host && end + 8 < cx + cw) {
			ctx.font = `11px ${EX_FONT}`;
			ctx.fillStyle = "#8b96ad";
			let host = ex_truncate(row.host, cx + cw - end - 8);
			ctx.fillText(host, end + 8, mid + 4);
			end += 8 + ctx.measureText(host).width;
		}
		if (row.gone) {
			ctx.fillStyle = "#667";
			ctx.fillRect(tx, mid, end - tx, 1);
		}
		y += 23;
	}
	return ex_panel_border(x0, y + 10);
}

function ex_chat_panel(x0, cx, cw, y) {
	y += 10;
	y = ex_h2(cx, cw, y, "Message wire");
	let top = y;
	let bottom = EXPORT_H - 10;
	/* like the DOM wire scrolled to its end: newest messages fill upward,
	 * clipping the oldest visible one at the panel's top edge */
	let count = ex_chat_count_at(clock);
	let heights = 0;
	let first = count;
	while (first > 0 && heights < bottom - top) {
		heights += ex_chat_lines(first - 1, cw).length * 20 + 2;
		first--;
	}
	ctx.save();
	ctx.beginPath();
	ctx.rect(x0 + 1, top, EXPORT_SIDEBAR_W - 1, bottom - top);
	ctx.clip();
	let yy = heights > bottom - top ? bottom - heights : top;
	for (let i = first; i < count; i++) {
		yy += 1; /* message padding */
		for (let line of ex_chat_lines(i, cw)) {
			for (let piece of line) {
				ctx.font = piece.font;
				ctx.fillStyle = piece.color;
				ctx.fillText(piece.text, cx + piece.x, yy + 15);
			}
			yy += 20;
		}
		yy += 1;
	}
	ctx.restore();
}

function ex_chat_count_at(tick) {
	let lo = 0, hi = game.chat.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (game.chat[mid].time <= tick) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/* Wrapped layout for one chat message: lines of positioned text pieces.
 * Messages and the panel width never change during an export, so the
 * layout is computed once per message. */
function ex_chat_lines(index, max_w) {
	let cached = export_chat_cache.get(index);
	if (cached) return cached;
	let parts = chat_line_parts(game.chat[index]);
	let base_font = parts.sys ? `italic 14px ${EX_FONT}` : `14px ${EX_FONT}`;
	let base_color = parts.sys ? "#8b96ad" : "#cfd6e4";
	let frags = [{ text: fmt_time(parts.time) + " ", font: base_font, color: "#667a99" }];
	for (let s of parts.segments) {
		frags.push({
			text: s.text,
			font: s.who ? `600 14px ${EX_FONT}` : base_font,
			color: s.who ? s.color : base_color,
		});
	}
	let lines = ex_wrap(frags, max_w);
	export_chat_cache.set(index, lines);
	return lines;
}

function ex_wrap(frags, max_w) {
	let lines = [];
	let line = [];
	let x = 0;
	let flush = () => { lines.push(line); line = []; x = 0; };
	for (let f of frags) {
		ctx.font = f.font;
		for (let token of f.text.split(/(\s+)/)) {
			if (token === "") continue;
			let blank = /^\s+$/.test(token);
			let w = ctx.measureText(token).width;
			if (x > 0 && x + w > max_w) {
				flush();
				if (blank) continue; /* the line break eats the space */
			}
			if (!blank && w > max_w) {
				/* a single word wider than the panel breaks anywhere */
				for (let chr of token) {
					let cw = ctx.measureText(chr).width;
					if (x > 0 && x + cw > max_w) flush();
					line.push({ text: chr, x, font: f.font, color: f.color });
					x += cw;
				}
				continue;
			}
			if (blank && x === 0) continue;
			line.push({ text: token, x, font: f.font, color: f.color });
			x += w;
		}
	}
	if (line.length > 0) lines.push(line);
	if (lines.length === 0) lines.push([]);
	return lines;
}
