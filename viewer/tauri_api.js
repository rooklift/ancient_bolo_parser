"use strict";

/* The Tauri app's window.api: the same interface preload.js gives the
 * Electron app, so renderer.js and video.js need not know which desktop
 * shell they run in. Loaded before renderer.js; does nothing in Electron
 * (which already has window.api) or in a browser (no window.__TAURI__).
 *
 * Bytes cross the bridge raw in both directions: a Uint8Array argument
 * goes as the request body, a Rust Response comes back as an ArrayBuffer.
 * Rejections from the Rust side become the { error } results main.js
 * returned, so the page's error handling stays as it was. */

(function() {
	if (window.api || !window.__TAURI__) return;

	let invoke = window.__TAURI__.core.invoke;
	let listen = window.__TAURI__.event.listen;

	function error_of(err) {
		return String((err && err.message) || err);
	}

	function ok_or_error(promise) {
		return promise.then(() => ({}), err => ({ error: error_of(err) }));
	}

	function take_log_bytes() {
		return invoke("take_log_bytes").then(ab => new Uint8Array(ab));
	}

	window.api = {
		/* no menu accelerators here: the page owns Ctrl+O, the zoom keys and F11 too */
		page_shortcuts: true,

		open_log: () => invoke("open_log").then(async res => {
			if (res.canceled) return res;
			return { canceled: false, path: res.path, data: await take_log_bytes() };
		}, err => ({ canceled: true, error: error_of(err) })),

		save_map: (name, data) => invoke("save_map", data, { headers: { "x-name": encodeURIComponent(name) } })
			.catch(err => ({ canceled: true, error: error_of(err) })),

		video_begin: default_name => invoke("video_begin", { default_name })
			.catch(err => ({ canceled: true, error: error_of(err) })),
		video_write: data => ok_or_error(invoke("video_write", data)),
		video_patch: (offset, data) => ok_or_error(invoke("video_patch", data, { headers: { "x-offset": String(offset) } })),
		video_end: () => invoke("video_end").then(path => ({ path }), err => ({ error: error_of(err) })),
		video_abort: () => ok_or_error(invoke("video_abort")),

		/* files reach the page by the native drop below, never as File objects with a path */
		file_path: file => file.name,

		file_loaded: file_path => invoke("file_loaded", { path: file_path }),
		show_file: () => invoke("show_file"),
		exit_fullscreen: () => invoke("exit_fullscreen"),
		toggle_fullscreen: () => invoke("toggle_fullscreen"),

		/* logs the host read itself: one named on the command line (asked
		 * for at startup) and any dropped on the window later */
		on_load_log: cb => {
			listen("load-log", async e => cb({ path: e.payload.path, data: await take_log_bytes() }));
			invoke("pending_log_path").then(async path => {
				if (path) cb({ path, data: await take_log_bytes() });
			});
		},

		show_error: (title, message) => invoke("show_error", { title, message }),
		on_menu: cb => listen("menu-cmd", e => cb(e.payload)),
	};
})();
