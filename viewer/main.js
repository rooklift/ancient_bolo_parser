"use strict";
/* Electron main process for the Ancient Bolo Log Viewer. Window/menu/dialog plumbing
 * duplicated from the lgm map editor and trimmed to viewer needs. */
const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");

let win = null;

const LOG_FILTERS = [
	{ name: "Bolo logs", extensions: ["*"] },
];

/* Logs are a few MB for a long game (a 12-hour 16-player marathon might
 * reach a few tens of MB); refuse absurdities before reading them. */
const MAX_LOG_BYTES = 64 << 20;

function send(cmd) {
	if (win) win.webContents.send("menu-cmd", cmd);
}

function build_menu() {
	let template = [
		{
			label: "&File",
			submenu: [
				{ label: "Open log…", accelerator: "CmdOrCtrl+O", click: () => send("open") },
				{ label: "Save initial map…", accelerator: "CmdOrCtrl+S", click: () => send("save-map") },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "&Playback",
			submenu: [
				{ label: "Play / Pause", accelerator: "Space", click: () => send("play-pause") },
				{ label: "Restart", accelerator: "CmdOrCtrl+R", click: () => send("restart") },
			],
		},
		{
			label: "&View",
			submenu: [
				{ label: "Zoom in", accelerator: "CmdOrCtrl+=", click: () => send("zoom-in") },
				{ label: "Zoom out", accelerator: "CmdOrCtrl+-", click: () => send("zoom-out") },
				{ label: "Fit map", accelerator: "CmdOrCtrl+0", click: () => send("zoom-fit") },
				{ label: "Object sprites", accelerator: "CmdOrCtrl+G", click: () => send("toggle-obj-sprites") },
				{ type: "separator" },
				{ label: "Toggle dev tools", role: "toggleDevTools" },
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function find_cli_log() {
	for (let arg of process.argv.slice(1)) {
		if (arg.startsWith("-")) continue;
		try {
			if (fs.statSync(arg).isFile()) return path.resolve(arg);
		} catch { /* not a path */ }
	}
	return null;
}

function create_window() {
	win = new BrowserWindow({
		width: 1280,
		height: 860,
		backgroundColor: "#10131a",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.loadFile("index.html");

	let cli_log = find_cli_log();
	if (cli_log) {
		win.webContents.once("did-finish-load", () => {
			try {
				let size = fs.statSync(cli_log).size;
				if (size > MAX_LOG_BYTES) throw new Error(`${cli_log} is ${size} bytes; not a Bolo log.`);
				win.webContents.send("load-log", { path: cli_log, data: new Uint8Array(fs.readFileSync(cli_log)) });
			} catch (err) {
				dialog.showErrorBox("Could not open log", String(err));
			}
		});
	}
	win.on("closed", () => { win = null; });
}

ipcMain.handle("open-log", async () => {
	let res = await dialog.showOpenDialog(win, {
		filters: LOG_FILTERS,
		properties: ["openFile"],
	});
	if (res.canceled || res.filePaths.length === 0) return { canceled: true };
	let p = res.filePaths[0];
	try {
		let size = fs.statSync(p).size;
		if (size > MAX_LOG_BYTES) {
			return { canceled: true, error: `${p} is ${size} bytes; not a Bolo log.` };
		}
		return { canceled: false, path: p, data: new Uint8Array(fs.readFileSync(p)) };
	} catch (err) {
		return { canceled: true, error: String(err) };
	}
});

ipcMain.handle("save-map", async (e, defaultName, data) => {
	let res = await dialog.showSaveDialog(win, {
		defaultPath: defaultName,
		filters: [{ name: "Bolo maps", extensions: ["map", "bmap"] }],
	});
	if (res.canceled || !res.filePath) return { canceled: true };
	try {
		fs.writeFileSync(res.filePath, Buffer.from(data));
		return { canceled: false, path: res.filePath };
	} catch (err) {
		return { canceled: true, error: String(err) };
	}
});

ipcMain.on("show-error", (e, title, message) => {
	dialog.showErrorBox(title, message);
});

app.whenReady().then(() => {
	build_menu();
	create_window();
});
app.on("window-all-closed", () => app.quit());
