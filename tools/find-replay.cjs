#!/usr/bin/env node
/* Which file is this label? The measurement tools name a replay by its
 * leading date digits plus six hex characters of the SHA-256 of its
 * basename (tools/corpus.cjs, replay_label), so the repository carries
 * no player handles. This walks the corpus and prints the files whose
 * labels match.
 *
 * Usage: node tools/find-replay.cjs <label> [label ...] [--root DIR]
 *        (the corpus root is the configured one unless --root is given)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { corpus_root, replay_label } = require("./corpus.cjs");

function* walk(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (let entry of entries) {
		let item = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(item);
		else if (entry.isFile()) yield item;
	}
}

let args = process.argv.slice(2);
let root = null;
let labels = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--root") root = args[++i];
	else labels.push(args[i]);
}
if (!labels.length) {
	console.error("usage: node tools/find-replay.cjs <label> [label ...] [--root DIR]");
	process.exit(2);
}
if (!root) root = corpus_root();
let wanted = new Set(labels);
let found = new Set();
for (let file of walk(root)) {
	let label = replay_label(file);
	if (wanted.has(label)) {
		console.log(`${label}\t${file}`);
		found.add(label);
	}
}
for (let label of labels) if (!found.has(label)) console.log(`${label}\t(not found under ${root})`);
