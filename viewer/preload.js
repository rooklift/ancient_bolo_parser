"use strict";
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
	open_log: () => ipcRenderer.invoke("open-log"),
	save_map: (name, data) => ipcRenderer.invoke("save-map", name, data),
	file_path: file => webUtils.getPathForFile(file),
	file_loaded: file_path => ipcRenderer.send("file-loaded", file_path),
	show_file: () => ipcRenderer.send("show-file"),
	on_load_log: cb => ipcRenderer.on("load-log", (e, payload) => cb(payload)),
	show_error: (title, message) => ipcRenderer.send("show-error", title, message),
	on_menu: cb => ipcRenderer.on("menu-cmd", (e, cmd) => cb(cmd)),
});
