"use strict";
/* Video export: renders the replay offline into a WebM file. Playback is a
 * pure function of the clock, so instead of capturing the live window the
 * export steps the clock by exact per-frame increments and draws each frame
 * to a fixed-size canvas — deterministic output at any speed, immune to
 * window size and dropped frames. Frames go through a WebCodecs encoder
 * into the hand-rolled muxer (webm.js) and stream to disk over IPC.
 *
 * A setup dialog fronts the export: canvas size (the world is rendered at
 * the live zoom, so a larger canvas shows more of the map), speed (the
 * video's time compression — the dialog's own setting, independent of the
 * viewer's playback speed), frame rate, constant quality vs a target size,
 * and whether the sidebar is painted into the frame. Choices persist in
 * localStorage, so a repeat export is Enter, Enter. The dialog also states
 * where the export starts and how long the video comes out.
 *
 * The export reuses the live draw path by swapping the renderer's globals
 * (ctx, view, clock, cur) for its own for the duration; `exporting` blocks
 * every input route that could touch them (see renderer.js). The user's
 * current framing carries over: same zoom, same world centre, player lock
 * and viewpoint as chosen. The sidebar (game info, players, message wire)
 * is painted onto the canvas from the same content the DOM panels use,
 * with the clock in place of the live record count. */

const EXPORT_RESOLUTIONS = {
	"1280x720": [1280, 720],
	"1920x1080": [1920, 1080],
	"2560x1440": [2560, 1440],
};
/* Constant-quality presets: VP9 quantizer, 0-63, lower = better + bigger. */
const EXPORT_QP = { standard: 32, high: 24, max: 16 };
const EXPORT_BASE_BITRATE = 8_000_000;            /* bitrate-mode reference at 1080p60 */
const EXPORT_KEYFRAME_SECONDS = 10;               /* also the cluster/seek granularity */
const EXPORT_QUEUE_LIMIT = 8;                     /* encoder frames in flight */
const EXPORT_WRITE_CHUNK = 1 << 20;               /* buffered bytes per IPC write */
const EX_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/* The sidebar is laid out in a fixed design space (322px wide, matching
 * #sidebar in style.css, against a 1080px-tall frame) and scaled to the
 * output height, so text keeps its proportions at every resolution. */
const EX_SIDEBAR_W = 322;
const EX_DESIGN_H = 1080;

/* matches the transport's speed menu, but the choice is the dialog's own */
const EXPORT_SPEEDS = [0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

const EXPORT_OPTIONS_KEY = "bolo_export_options";
const EXPORT_DEFAULTS = {
	res: "1920x1080", speed: 1, fps: 60, mode: "quality", quality: "high",
	mb_per_min: 60, sidebar: true,
};

let export_overlay = document.getElementById("exportOverlay");
let export_label = document.getElementById("exportLabel");
let export_bar_fill = document.getElementById("exportBarFill");
let export_cancel_btn = document.getElementById("exportCancel");

let export_setup_el = document.getElementById("exportSetup");
let export_setup_summary = document.getElementById("exportSetupSummary");
let export_res_el = document.getElementById("exportRes");
let export_speed_el = document.getElementById("exportSpeed");
let export_fps_el = document.getElementById("exportFps");
let export_mode_quality_el = document.getElementById("exportModeQuality");
let export_mode_size_el = document.getElementById("exportModeSize");
let export_quality_el = document.getElementById("exportQuality");
let export_mb_el = document.getElementById("exportMbMin");
let export_sidebar_el = document.getElementById("exportSidebar");
let export_estimate_el = document.getElementById("exportSetupEstimate");
let export_warning_el = document.getElementById("exportSetupWarning");
let export_setup_cancel_btn = document.getElementById("exportSetupCancel");
let export_setup_ok_btn = document.getElementById("exportSetupOk");

let export_cancel_requested = false;
let export_error = null;
let export_chat_cache = null; /* chat index -> wrapped lines, fixed per export */
let export_setup_resolve = null; /* pending setup dialog, resolves to options */
let export_setup_start = 0;      /* the pending export's start tick */
let export_setup_seconds = 0;    /* output duration, for the size estimate */
let EX = null; /* the running export's parameters, set from the dialog */
let ex_write_queue = [];
let ex_write_bytes = 0;
let ex_bytes_muxed = 0;  /* all bytes queued this export, for the size estimate */
let ex_frames_muxed = 0;

export_cancel_btn.addEventListener("click", () => cancel_video_export());
export_setup_cancel_btn.addEventListener("click", () => ex_setup_close(null));
export_setup_ok_btn.addEventListener("click", () => ex_setup_confirm());
for (let el of [export_res_el, export_speed_el, export_fps_el,
	export_mode_quality_el, export_mode_size_el, export_quality_el,
	export_mb_el, export_sidebar_el]) {
	el.addEventListener("change", () => ex_setup_refresh());
	el.addEventListener("input", () => ex_setup_refresh());
}
/* Picking within a mode's own control is also a vote for that mode. */
export_quality_el.addEventListener("change", () => {
	export_mode_quality_el.checked = true;
	ex_setup_refresh();
});
export_mb_el.addEventListener("input", () => {
	export_mode_size_el.checked = true;
	ex_setup_refresh();
});

/* The renderer's global key handler ignores everything but Escape while
 * `exporting` (which is claimed before the dialog opens), so the dialog's
 * keys live here. Escape routes through cancel_video_export below. */
window.addEventListener("keydown", e => {
	if (!export_setup_resolve) return;
	if (e.code === "Enter" || e.code === "NumpadEnter") {
		/* a focused button keeps its own meaning */
		if (e.target instanceof HTMLButtonElement) return;
		e.preventDefault();
		ex_setup_confirm();
	}
});

function cancel_video_export() {
	if (export_setup_resolve) ex_setup_close(null);
	else if (exporting) export_cancel_requested = true;
}

/* ---------- the setup dialog ---------- */

function ex_setup(start_tick) {
	ex_setup_apply(ex_setup_stored());
	export_setup_start = start_tick;
	ex_setup_refresh();
	export_setup_el.classList.remove("hidden");
	export_setup_ok_btn.focus();
	return new Promise(resolve => { export_setup_resolve = resolve; });
}

function ex_setup_close(options) {
	if (!export_setup_resolve) return;
	export_setup_el.classList.add("hidden");
	let resolve = export_setup_resolve;
	export_setup_resolve = null;
	resolve(options);
}

function ex_setup_confirm() {
	let options = ex_setup_read();
	try {
		localStorage.setItem(EXPORT_OPTIONS_KEY, JSON.stringify({
			res: options.res, speed: options.speed, fps: options.fps,
			mode: options.mode, quality: options.quality,
			mb_per_min: options.mb_per_min, sidebar: options.sidebar,
		}));
	} catch { /* a full or blocked store just loses the memory */ }
	ex_setup_close(options);
}

function ex_setup_stored() {
	let stored = {};
	try {
		stored = JSON.parse(localStorage.getItem(EXPORT_OPTIONS_KEY)) || {};
	} catch { /* absent or corrupt: defaults */ }
	let o = { ...EXPORT_DEFAULTS, ...stored };
	if (!EXPORT_RESOLUTIONS[o.res]) o.res = EXPORT_DEFAULTS.res;
	if (!EXPORT_SPEEDS.includes(o.speed)) o.speed = EXPORT_DEFAULTS.speed;
	if (o.fps !== 30 && o.fps !== 60) o.fps = EXPORT_DEFAULTS.fps;
	if (o.mode !== "quality" && o.mode !== "size") o.mode = EXPORT_DEFAULTS.mode;
	if (!(o.quality in EXPORT_QP)) o.quality = EXPORT_DEFAULTS.quality;
	o.mb_per_min = ex_clamp_mb(o.mb_per_min);
	o.sidebar = Boolean(o.sidebar);
	return o;
}

function ex_setup_apply(o) {
	export_res_el.value = o.res;
	export_speed_el.value = String(o.speed);
	export_fps_el.value = String(o.fps);
	export_mode_quality_el.checked = o.mode === "quality";
	export_mode_size_el.checked = o.mode === "size";
	export_quality_el.value = o.quality;
	export_mb_el.value = String(o.mb_per_min);
	export_sidebar_el.checked = o.sidebar;
}

function ex_setup_read() {
	let res = EXPORT_RESOLUTIONS[export_res_el.value] ? export_res_el.value
		: EXPORT_DEFAULTS.res;
	let [w, h] = EXPORT_RESOLUTIONS[res];
	return {
		res, w, h,
		speed: ex_speed_value(),
		fps: export_fps_el.value === "30" ? 30 : 60,
		mode: export_mode_size_el.checked ? "size" : "quality",
		quality: export_quality_el.value in EXPORT_QP ? export_quality_el.value
			: EXPORT_DEFAULTS.quality,
		mb_per_min: ex_clamp_mb(parseFloat(export_mb_el.value)),
		sidebar: export_sidebar_el.checked,
	};
}

function ex_clamp_mb(value) {
	if (!Number.isFinite(value)) return EXPORT_DEFAULTS.mb_per_min;
	return Math.min(1000, Math.max(1, Math.round(value)));
}

function ex_speed_value() {
	let value = parseFloat(export_speed_el.value);
	return EXPORT_SPEEDS.includes(value) ? value : EXPORT_DEFAULTS.speed;
}

function ex_setup_refresh() {
	export_setup_seconds =
		Math.max(0, (game.t1 - export_setup_start) / (TPS * ex_speed_value()));
	export_setup_summary.textContent =
		`From ${fmt_time(export_setup_start)} — ` +
		`${ex_fmt_duration(export_setup_seconds)} of video`;
	let size_mode = export_mode_size_el.checked;
	export_quality_el.disabled = size_mode;
	export_mb_el.disabled = !size_mode;
	export_estimate_el.textContent = size_mode
		? `About ${ex_fmt_size(ex_clamp_mb(parseFloat(export_mb_el.value))
			* 1e6 * export_setup_seconds / 60)}`
		: "File size follows the on-screen action";
	/* A locked camera scrolls the whole world view every frame — the worst
	 * case for constant quality, where motion costs bytes. (In size mode
	 * the cost is paid in quality instead, so no warning there.) */
	export_warning_el.classList.toggle("hidden", size_mode || !player_locked);
}

function ex_fmt_duration(seconds) {
	let s = Math.round(seconds);
	let m = Math.floor(s / 60);
	let h = Math.floor(m / 60);
	s %= 60;
	m %= 60;
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
		: `${m}:${String(s).padStart(2, "0")}`;
}

/* ---------- the export itself ---------- */

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

	/* Claim the export before the first await: the application menu stays
	 * live while the setup and save dialogs are open, so a second export
	 * command must bounce off the guard above rather than race this one. */
	exporting = true;

	let options = await ex_setup(start_tick);
	if (!options) {
		exporting = false;
		return;
	}

	let picked = await ex_pick_config(options);
	if (!picked) {
		exporting = false;
		show_error("Cannot export video", "no supported VP9/VP8 encoder found");
		return;
	}

	let sidebar_scale = options.h / EX_DESIGN_H;
	let sidebar_w = options.sidebar ? Math.round(EX_SIDEBAR_W * sidebar_scale) : 0;
	EX = {
		w: options.w, h: options.h, fps: options.fps,
		sidebar_w, sidebar_scale,
		world_w: options.w - sidebar_w,
		keyframe_every: options.fps * EXPORT_KEYFRAME_SECONDS,
		quantizer: picked.quantizer,
	};

	/* Each output frame advances the clock by a fixed tick step, so the
	 * dialog's speed choice is baked in as the video's time compression. */
	let step = TPS * options.speed / EX.fps;
	let total = Math.max(1, Math.floor((game.t1 - start_tick) / step) + 1);
	let duration_ms = total * 1000 / EX.fps;

	let gi = game.final.gameInfo;
	let default_name = ((gi && gi.mapName) || "replay").replace(/[\/\\:]/g, "_") + ".webm";
	let begin = await window.api.video_begin(default_name);
	if (begin.canceled || begin.error) {
		exporting = false;
		EX = null;
		if (begin.error) show_error("Could not export video", begin.error);
		return;
	}

	/* ---- take over the viewer until restored in the finally below ---- */
	export_cancel_requested = false;
	export_error = null;
	export_chat_cache = new Map();
	ex_write_queue = [];
	ex_write_bytes = 0;
	ex_bytes_muxed = 0;
	ex_frames_muxed = 0;
	export_overlay.classList.remove("hidden");

	let saved = { clock, view, ctx };
	let encoder = null;
	let ok = false;
	try {
		/* keep the live framing: same zoom, same world centre, recentred for
		 * the export's world viewport (player lock re-centres per frame) */
		let live = { w: canvas.clientWidth, h: canvas.clientHeight };
		view = {
			zoom: view.zoom,
			ox: view.ox + (live.w - EX.world_w) / (2 * view.zoom),
			oy: view.oy + (live.h - EX.h) / (2 * view.zoom),
		};
		let export_canvas = document.createElement("canvas");
		export_canvas.width = EX.w;
		export_canvas.height = EX.h;
		ctx = export_canvas.getContext("2d", { alpha: false });
		export_target = { w: EX.world_w, h: EX.h };

		let at = BoloGame.state_at(game, start_tick);
		cur = at.state;
		cursor = at.index;
		clock = start_tick;
		effect_lo = lower_bound_effect(start_tick - EFFECT_TICKS);
		off_version = -1;
		display_grid_version = -1;
		display_grid_cache = null;

		let muxer = BoloWebM.create_muxer({
			width: EX.w, height: EX.h, codec_id: picked.codec_id,
		});
		ex_queue(muxer.header(duration_ms));

		encoder = new VideoEncoder({
			output: chunk => {
				let data = new Uint8Array(chunk.byteLength);
				chunk.copyTo(data);
				ex_queue(muxer.add_block(data,
					Math.round(chunk.timestamp / 1000), chunk.type === "key"));
				ex_frames_muxed++;
			},
			error: err => { if (!export_error) export_error = err; },
		});
		encoder.configure(picked.config);

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
				timestamp: Math.round(i * 1e6 / EX.fps),
				duration: Math.round(1e6 / EX.fps),
			});
			let opts = { keyFrame: i % EX.keyframe_every === 0 };
			if (EX.quantizer !== null) opts.vp9 = { quantizer: EX.quantizer };
			encoder.encode(frame, opts);
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
		}
		/* the writing phase awaits repeatedly too: keep honouring a cancel
		 * clicked while the overlay shows "Writing file…" */
		if (!export_cancel_requested) {
			let fin = muxer.finalize(duration_ms);
			ex_queue(fin.tail);
			await ex_flush_writes(true);
			for (let patch of fin.patches) {
				if (export_cancel_requested) break;
				let res = await window.api.video_patch(patch.offset, patch.bytes);
				if (res && res.error) throw new Error(res.error);
			}
		}
		if (!export_cancel_requested) {
			let end = await window.api.video_end();
			if (end && end.error) throw new Error(end.error);
			ok = true;
		}
	} catch (err) {
		show_error("Could not export video", String((err && err.message) || err));
	} finally {
		if (encoder) {
			try { encoder.close(); } catch { /* already closed */ }
		}
		if (!ok) await window.api.video_abort(); /* cancelled or failed: no partial file */
		ex_write_queue = [];
		ex_write_bytes = 0;
		export_chat_cache = null;
		export_target = null;
		EX = null;
		ctx = saved.ctx;
		view = saved.view;
		exporting = false;
		export_overlay.classList.add("hidden");
		set_clock(saved.clock, true); /* hard seek restores state and caches */
	}
}

/* VP9 with a VP8 fallback: both are WebM-native and need no codec private
 * data, which is what keeps the muxer small.
 *
 * In quality mode, constant-quality (quantizer) VP9 is tried first: an
 * offline export has no realtime bandwidth budget, and a rate controller
 * given a fixed bitrate starves the forced keyframes, encoding one visibly
 * blurry frame at every keyframe interval. A fixed per-frame quantizer
 * encodes key and delta frames at the same quality, at a file size that
 * floats with the on-screen action instead. Bitrate mode remains the
 * fallback (always for VP8, whose WebCodecs registration has no per-frame
 * quantizer option), with the 1080p60 reference bitrate scaled by pixel
 * rate. In size mode the user's MB-per-minute is the bitrate and the
 * quantizer config is never offered. */
async function ex_pick_config(options) {
	let base = { width: options.w, height: options.h, framerate: options.fps };
	let bitrate = options.mode === "size"
		? Math.round(options.mb_per_min * 8e6 / 60)
		: Math.round(EXPORT_BASE_BITRATE *
			(options.w * options.h * options.fps) / (1920 * 1080 * 60));
	const VP9 = "vp09.00.10.08";
	let choices = [];
	if (options.mode === "quality") {
		choices.push({ config: { ...base, codec: VP9, bitrateMode: "quantizer" },
			codec_id: "V_VP9", quantizer: EXPORT_QP[options.quality] });
	}
	choices.push({ config: { ...base, codec: VP9, bitrate },
		codec_id: "V_VP9", quantizer: null });
	choices.push({ config: { ...base, codec: "vp8", bitrate },
		codec_id: "V_VP8", quantizer: null });
	for (let choice of choices) {
		try {
			let support = await VideoEncoder.isConfigSupported(choice.config);
			if (support.supported) return choice;
		} catch { /* config not recognised: try the next */ }
	}
	return null;
}

function ex_progress(done, total) {
	export_bar_fill.style.width = `${Math.floor((done / total) * 100)}%`;
	/* Extrapolate the final file size from the frames actually muxed so far,
	 * so the user can bail on an export that is heading somewhere huge. Held
	 * back until one full keyframe group is in, else the estimate whipsaws
	 * with the key/delta frame mix. Under quantizer-mode encoding bytes per
	 * frame track scene complexity, so this stays a rough figure. */
	let size = "";
	if (ex_frames_muxed >= Math.min(EX.keyframe_every, total)) {
		size = ` — about ${ex_fmt_size(ex_bytes_muxed / ex_frames_muxed * total)}`;
	}
	export_label.textContent = done >= total ? `Writing file…${size}`
		: `Frame ${done.toLocaleString()} of ${total.toLocaleString()}${size}`;
}

function ex_fmt_size(bytes) {
	let mb = bytes / 1e6;
	if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`;
	if (mb >= 10) return `${Math.round(mb)} MB`;
	return `${mb.toFixed(1)} MB`;
}

function ex_queue(bytes) {
	if (bytes.length === 0) return;
	ex_write_queue.push(bytes);
	ex_write_bytes += bytes.length;
	ex_bytes_muxed += bytes.length;
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
 * (player_rows, chat_line_parts), so only the painting is duplicated.
 * Everything below works in the fixed design space (EX_SIDEBAR_W wide,
 * EX_DESIGN_H tall); draw_export_sidebar's transform places and scales
 * it to the output frame. */

function draw_export_sidebar() {
	if (EX.sidebar_w === 0) return;
	ctx.setTransform(EX.sidebar_scale, 0, 0, EX.sidebar_scale, EX.world_w, 0);
	ctx.fillStyle = "#141925";
	ctx.fillRect(0, 0, EX_SIDEBAR_W, EX_DESIGN_H);
	ctx.fillStyle = "#262d3d"; /* border-left */
	ctx.fillRect(0, 0, 1, EX_DESIGN_H);
	ctx.textAlign = "left";
	ctx.textBaseline = "alphabetic";
	let cx = 1 + 12; /* panel padding */
	let cw = EX_SIDEBAR_W - 1 - 24;

	let y = ex_game_panel(cx, cw, 0);
	y = ex_players_panel(cx, cw, y);
	ex_chat_panel(cx, cw, y);
	ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function ex_h2(cx, cw, y, text) {
	ctx.font = `bold 12px ${EX_FONT}`;
	ctx.letterSpacing = "0.96px"; /* 0.08em of 12px */
	ctx.fillStyle = "#8b96ad";
	ctx.fillText(ex_truncate(text.toUpperCase(), cw), cx, y + 13);
	ctx.letterSpacing = "0px";
	return y + 17 + 6; /* line height + margin below */
}

function ex_panel_border(y) {
	ctx.fillStyle = "#232939";
	ctx.fillRect(1, y, EX_SIDEBAR_W - 1, 1);
	return y + 1;
}

function ex_truncate(text, max_w) {
	if (ctx.measureText(text).width <= max_w) return text;
	while (text.length > 0 && ctx.measureText(text + "…").width > max_w) {
		text = text.slice(0, -1);
	}
	return text + "…";
}

function ex_game_panel(cx, cw, y) {
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
	return ex_panel_border(y + 10);
}

function ex_players_panel(cx, cw, y) {
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
	return ex_panel_border(y + 10);
}

function ex_chat_panel(cx, cw, y) {
	y += 10;
	y = ex_h2(cx, cw, y, "Message wire");
	let top = y;
	let bottom = EX_DESIGN_H - 10;
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
	ctx.rect(1, top, EX_SIDEBAR_W - 1, bottom - top);
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
