/* Resolve the log corpus directory without recording its location anywhere in
 * the repository.
 *
 * The corpus is private and lives outside the tree, so its path is configured
 * locally rather than committed. Resolution order:
 *
 *   1. an explicit path argument, handled by the calling tool
 *   2. the BOLO_CORPUS environment variable
 *   3. the "root" field of corpus.json at the repo root
 *
 * corpus.json is gitignored. Copy corpus.example.json to corpus.json and set
 * its "root" to wherever the logs live.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const CONFIG = path.join(ROOT, "corpus.json");

const ADVICE =
	"no corpus directory configured -- pass one as an argument, set " +
	"BOLO_CORPUS, or copy corpus.example.json to corpus.json and set its " +
	"\"root\" field";

/* Returns the configured corpus directory. On any failure it explains what to
 * do and exits, since every caller is a command-line measurement tool with
 * nothing useful to do without a corpus. */
function corpus_root() {
	let found = null;
	try {
		found = resolve_corpus_root();
	} catch (error) {
		console.error(`error: ${error.message}`);
		process.exit(2);
	}
	if (!found) {
		console.error(`error: ${ADVICE}`);
		process.exit(2);
	}
	if (!fs.existsSync(found)) {
		console.error(`error: configured corpus directory does not exist: ${found}`);
		process.exit(2);
	}
	return found;
}

/* The same lookup, but reporting rather than exiting: returns null when
 * nothing is configured and throws when what is configured is malformed. */
function resolve_corpus_root() {
	let from_env = process.env.BOLO_CORPUS;
	if (from_env) return from_env;
	if (!fs.existsSync(CONFIG)) return null;
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
	} catch (error) {
		throw new Error(`corpus.json is not valid JSON: ${error.message}`);
	}
	if (!parsed || typeof parsed.root !== "string" || !parsed.root) {
		throw new Error("corpus.json has no \"root\" string");
	}
	return parsed.root;
}

module.exports = { corpus_root, resolve_corpus_root, CONFIG };
