"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
	open_log: () => ipcRenderer.invoke("open-log"),
	save_map: (name, data) => ipcRenderer.invoke("save-map", name, data),
	on_load_log: cb => ipcRenderer.on("load-log", (e, payload) => cb(payload)),
	show_error: (title, message) => ipcRenderer.send("show-error", title, message),
	on_menu: cb => ipcRenderer.on("menu-cmd", (e, cmd) => cb(cmd)),
});
