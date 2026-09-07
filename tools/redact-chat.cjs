#!/usr/bin/env node
/* Replace the chat in a game's logs with invented dialogue.
 *
 * The `FA` messages are the one part of a log that is prose, and prose
 * written by real people: it names them, quotes them, and is theirs. To
 * publish a log the chat is replaced wholesale with fiction, written by
 * whoever (or whatever) is asked to, against a template that gives the
 * shape of the conversation and nothing of its content.
 *
 * Two logs of one game share their ring records byte for byte, the chat
 * included, so the replacement is made per game, not per log: every log
 * of the game gets the same line in the same record. The template is
 * built from all the logs at once, their message streams merged (the
 * same longest-common-subsequence alignment tools/compare-recordings.cjs
 * uses, on the sender, sequence byte and text of each message), so a
 * message one machine logged before the other started, or after it
 * stopped, is in the list once, in order.
 *
 * `--template` writes two files:
 *   <name>.json         for the writer: [[player, chars], ...] in game
 *                       order, the sender's slot number and the length
 *                       of the message in characters
 *   <name>.index.json   for `--apply`: the same entries with the record
 *                       offset of each message in each log
 *
 * `--apply` takes the index, a JSON array of the invented lines (a
 * string per entry, in the template's order; an entry may also be
 * [player, string], the player being checked) and rewrites every log
 * the index names, patching each message's text in place under the
 * XOR mask (see tools/redact-names.cjs). A line must have exactly the
 * template's number of characters, MacRoman-representable, so no
 * record changes length; every other byte of every log stays as it
 * was.
 *
 * Usage:
 *   node tools/redact-chat.cjs --template <name> <log> [<log> ...]
 *   node tools/redact-chat.cjs --apply <name>.index.json <lines.json> <out-dir>
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BoloLog = require(path.join(ROOT, "viewer", "logparse.js"));
const { align } = require(path.join(ROOT, "tools", "compare-recordings.cjs"));

/* ---------- MacRoman ---------- */

const MACROMAN_HIGH = (() => {
	let out = [];
	for (let b = 0x80; b < 0x100; b++) out.push(BoloLog.macRoman([b]));
	return out;
})();

function to_mac_roman(str) {
	let bytes = [];
	for (let ch of str) {
		let code = ch.codePointAt(0);
		if (code < 0x80) {
			bytes.push(code);
			continue;
		}
		let i = MACROMAN_HIGH.indexOf(ch);
		if (i < 0) throw new Error(`not representable in MacRoman: ${JSON.stringify(ch)} in ${JSON.stringify(str)}`);
		bytes.push(0x80 + i);
	}
	return Uint8Array.from(bytes);
}

/* ---------- the messages of a log ---------- */

/* Every FA message in a log, with where its text sits in the file: the
 * Pascal string's length byte is at `text_at` - 1, its characters from
 * `text_at`, both file offsets. A record carries its subpackets in
 * order, so the message is found by walking the decoded payload the way
 * the parser does. */
function messages(file) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let out = [];
	for (let raw of BoloLog.rawRecords(bytes)) {
		let rec = BoloLog.parseRecord(raw);
		let texts = rec.subpackets.filter(sub => sub.type === "message");
		if (!texts.length) continue;
		/* locate each FA's string in the payload: FA, 2 address bytes,
		 * length, text -- searched for in order so repeated texts in one
		 * record are told apart */
		let pos = 3;
		for (let sub of texts) {
			let needle = to_mac_roman(sub.text);
			let at = -1;
			for (let i = pos; i + 4 + needle.length <= raw.data.length; i++) {
				if (raw.data[i] !== 0xfa) continue;
				if ((raw.data[i + 1] | (raw.data[i + 2] << 8)) !== sub.address) continue;
				if (raw.data[i + 3] !== needle.length) continue;
				let j = 0;
				while (j < needle.length && raw.data[i + 4 + j] === needle[j]) j++;
				if (j === needle.length) { at = i; break; }
			}
			if (at < 0) throw new Error(`${file}: cannot locate a message's bytes at record offset ${raw.offset}`);
			pos = at + 4 + needle.length;
			out.push({
				player: rec.player,
				seq: raw.data[0],
				address: sub.address,
				text: sub.text,
				chars: needle.length,
				text_at: raw.offset + 5 + at + 4,
			});
		}
	}
	return { bytes, out };
}

const key = m => `${m.player}|${m.seq}|${m.address}|${m.text}`;

/* ---------- template ---------- */

function build_template(files) {
	let logs = files.map(file => ({ file, ...messages(file) }));
	let ids = logs.map(log => {
		for (let raw of BoloLog.rawRecords(log.bytes)) {
			for (let sub of BoloLog.parseRecord(raw).subpackets) if (sub.type === "game_info") return sub.gameId;
		}
		return null;
	});
	if (new Set(ids).size !== 1) throw new Error(`the logs are not of one game: ${ids.join(", ")}`);
	/* union, in order: start from the first log and merge each next one in */
	let union = logs[0].out.map((m, i) => ({ player: m.player, seq: m.seq, address: m.address, text: m.text, chars: m.chars, at: { [logs[0].file]: m.text_at } }));
	for (let log of logs.slice(1)) {
		let pairs = align(union.map(key), log.out.map(key));
		let merged = [];
		let iu = 0, il = 0;
		let take = (i, j) => {
			while (iu < i) merged.push(union[iu++]);
			while (il < j) { let m = log.out[il++]; merged.push({ player: m.player, seq: m.seq, address: m.address, text: m.text, chars: m.chars, at: { [log.file]: m.text_at } }); }
		};
		for (let [i, j] of pairs) {
			take(i, j);
			union[i].at[log.file] = log.out[j].text_at;
			merged.push(union[i]);
			iu = i + 1;
			il = j + 1;
		}
		take(union.length, log.out.length);
		union = merged;
	}
	return {
		game: ids[0],
		logs: files,
		entries: union.map(m => ({ player: m.player, chars: m.chars, address: m.address, at: m.at })),
	};
}

/* ---------- apply ---------- */

function apply(index, lines, out_dir) {
	if (!Array.isArray(lines) || lines.length !== index.entries.length) {
		throw new Error(`the template has ${index.entries.length} messages, the lines file ${Array.isArray(lines) ? lines.length : "no"}`);
	}
	let texts = index.entries.map((entry, i) => {
		let line = lines[i];
		let player = null;
		if (Array.isArray(line)) [player, line] = line;
		if (typeof line !== "string") throw new Error(`line ${i}: not a string`);
		if (player !== null && player !== entry.player) throw new Error(`line ${i}: player ${player}, the template says ${entry.player}`);
		let bytes = to_mac_roman(line);
		if (bytes.length !== entry.chars) throw new Error(`line ${i}: ${bytes.length} characters, the template wants ${entry.chars}: ${JSON.stringify(line)}`);
		return bytes;
	});
	fs.mkdirSync(out_dir, { recursive: true });
	for (let file of index.logs) {
		let { bytes, out: found } = messages(file);
		let patched = Uint8Array.from(bytes);
		let n = 0;
		index.entries.forEach((entry, i) => {
			let at = entry.at[file];
			if (at === undefined) return;
			let old_bytes = to_mac_roman(found.find(m => m.text_at === at).text);
			if (old_bytes.length !== entry.chars) throw new Error(`${file}: the message at ${at} is not the template's`);
			for (let k = 0; k < old_bytes.length; k++) patched[at + k] = bytes[at + k] ^ old_bytes[k] ^ texts[i][k];
			n++;
		});
		let out_file = path.join(out_dir, path.basename(file));
		fs.writeFileSync(out_file, patched);
		/* read back: every message is now one of the invented lines */
		let check = messages(out_file).out;
		if (check.length !== found.length) throw new Error(`${out_file}: message count changed`);
		for (let m of check) {
			let entry = index.entries.find(e => e.at[file] === m.text_at);
			if (!entry || m.text !== BoloLog.macRoman(texts[index.entries.indexOf(entry)])) throw new Error(`${out_file}: unexpected message at ${m.text_at}`);
		}
		console.log(`${path.basename(file)}: ${n} messages replaced -> ${out_file}`);
	}
}

/* ---------- main ---------- */

function main() {
	let args = process.argv.slice(2);
	if (args[0] === "--template" && args.length >= 3) {
		let [name, ...files] = args.slice(1);
		let template = build_template(files);
		fs.writeFileSync(`${name}.json`, JSON.stringify(template.entries.map(e => [e.player, e.chars])) + "\n");
		fs.writeFileSync(`${name}.index.json`, JSON.stringify(template, null, "\t") + "\n");
		let per_log = files.map(file => template.entries.filter(e => file in e.at).length);
		console.log(`${name}: game ${template.game}, ${template.entries.length} messages (${per_log.join(" / ")} per log)`);
		return;
	}
	if (args[0] === "--apply" && args.length === 4) {
		let [index_file, lines_file, out_dir] = args.slice(1);
		let index = JSON.parse(fs.readFileSync(index_file, "utf8"));
		let lines = JSON.parse(fs.readFileSync(lines_file, "utf8"));
		apply(index, lines, out_dir);
		return;
	}
	console.error("usage: node tools/redact-chat.cjs --template <name> <log> [<log> ...]\n" +
		"       node tools/redact-chat.cjs --apply <name>.index.json <lines.json> <out-dir>");
	process.exit(2);
}

module.exports = { messages, build_template, apply };

if (require.main === module) main();
