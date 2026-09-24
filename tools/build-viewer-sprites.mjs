// Generates viewer/sprite_data.js from the PNGs in sprites/ (and its
// subfolders), each stored base64 under its path without ".png", e.g.
// "grass" or "objects/tank_good_00". The viewer builds its images from
// that one file rather than fetching each PNG. Run after changing a sprite:
//
//   node tools/build-viewer-sprites.mjs
//
// test/test-robustness.cjs fails if the committed build is stale.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sprite_dir = join(root, "sprites");

function png_names(dir, prefix = "") {
	let names = [];
	for (let entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			names.push(...png_names(join(dir, entry.name), prefix + entry.name + "/"));
		} else if (entry.name.endsWith(".png")) {
			names.push(prefix + entry.name.slice(0, -4));
		}
	}
	return names;
}

export function build() {
	/* Sorted by code unit, not locale, so every platform writes the same file. */
	let names = png_names(sprite_dir).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
	let lines = names.map(name => {
		let b64 = readFileSync(join(sprite_dir, name + ".png")).toString("base64");
		return `\t${JSON.stringify(name)}: "${b64}",`;
	});
	return `/* GENERATED FILE - do not edit. Built from the PNGs in sprites/ by
 * tools/build-viewer-sprites.mjs: each sprite's file, base64, under its path
 * without ".png". Change the PNGs and rebuild. */
"use strict";
(function () {

const BoloSpriteData = {
${lines.join("\n")}
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloSpriteData;
} else {
	window.BoloSpriteData = BoloSpriteData;
}

})();
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	writeFileSync(join(root, "viewer", "sprite_data.js"), build());
	console.log("wrote viewer/sprite_data.js");
}
