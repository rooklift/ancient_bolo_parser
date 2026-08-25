// Generates viewer/logparse.js (classic-script/CJS build) from src/parse.js
// (the ESM reference parser), inlining the XOR mask. Run after editing
// src/parse.js:
//
//   node tools/build-viewer-parser.mjs
//
// test/test-robustness.cjs fails if the committed build is stale.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function build() {
	// Normalize CRLF (a Windows checkout with core.autocrlf) so the regexes
	// below match and the output is byte-identical on every platform.
	const mask = readFileSync(join(root, "src", "mask.js"), "utf8").replace(/\r\n/g, "\n");
	const maskLiteral = mask.match(/Uint8Array\.from\(\[[\s\S]*?\]\)/)[0];

	let src = readFileSync(join(root, "src", "parse.js"), "utf8").replace(/\r\n/g, "\n");
	src = src.replace(/import \{ MASK \} from "\.\/mask\.js";\n/, `const MASK = ${maskLiteral};\n`);
	src = src.replace(/^export /gm, "");

	return `/* GENERATED FILE - do not edit. Built from src/parse.js (plus the mask
 * from src/mask.js) by tools/build-viewer-parser.mjs, as a classic
 * script / CJS module for the viewer. Edit src/parse.js and rebuild. */
"use strict";
(function () {

${src.trimEnd()}

const BoloLog = { TICKS_PER_SECOND, macRoman, parseHeader, rawRecords, parseRecord, records, parseLog };

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloLog;
} else {
	window.BoloLog = BoloLog;
}

})();
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	writeFileSync(join(root, "viewer", "logparse.js"), build());
	console.log("wrote viewer/logparse.js");
}
