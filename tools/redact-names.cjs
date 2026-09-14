#!/usr/bin/env node
/* Replace the player and machine names in a log.
 *
 * A log names its players in the `F8` node ids, `player@machine`, sent
 * when a player joins or renames and restated when logging starts; the
 * same form can sit in an `F1 Cx` history value and in a BoloViewer
 * attached-log pseudo-record. The machine half is the reverse-DNS name
 * of the player's host, so both halves identify somebody. This tool
 * swaps every such string for a made-up one from a mapping file, so a
 * log can be published.
 *
 * Nothing else about the log changes. Every replacement must have the
 * same MacRoman byte length as the original, so the record lengths, the
 * sequence bytes, the time tags and every other byte stay where they
 * were: the string is patched in place under the XOR mask (the mask
 * cancels out of `stored ^ old ^ new`), and a pair of logs of one game
 * stays byte-identical in every shared record after the swap. A
 * mapping that changes a length is refused.
 *
 * Only the name fields the parser identifies are patched, at the
 * offsets it reports; the bytes of a name are never searched for, so a
 * coordinate or a shell list that happens to spell a name is left as
 * recorded. A search is still made afterwards: an original name found
 * in bytes the parser could not read is a leak and stops the tool, and
 * one found inside parsed gameplay data is a coincidence, counted and
 * reported. (A real node id is twenty-odd bytes, so neither happens.)
 *
 * Chat (`FA`) is left alone. It may quote the names too, and wants a
 * reading rather than a substitution; the tool counts the messages
 * whose text contains an original name so that is not forgotten (a
 * loose count: a short handle such as "ok" matches ordinary words).
 *
 * The mapping file is blank-line-separated pairs of lines, the original
 * then the replacement, applied to each half of `player@machine`
 * separately (the split is at the last `@`); a whole node id may also
 * be listed as one entry. Every half of every node id in the log must be
 * mapped, or the tool stops and lists the ones that are not, so a name
 * cannot slip through unreplaced.
 *
 * Usage:
 *   node tools/redact-names.cjs <mapping.txt> <in-log> <out-log>
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BoloLog = require(path.join(ROOT, "viewer", "logparse.js"));

const HEADER_SIZE = 72;

/* ---------- MacRoman ---------- */

/* The decoder's table, read out of the parser so there is one copy. */
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

/* ---------- the mapping ---------- */

function read_mapping(file) {
	let text = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
	let map = new Map();
	for (let block of text.split(/\n[ \t]*\n/)) {
		let lines = block.split("\n").filter(line => line.length);
		if (!lines.length) continue;
		if (lines.length !== 2) throw new Error(`mapping entry is not two lines: ${JSON.stringify(block)}`);
		let [from, to] = lines;
		if (map.has(from) && map.get(from) !== to) throw new Error(`${JSON.stringify(from)} is mapped twice`);
		let a = to_mac_roman(from).length, b = to_mac_roman(to).length;
		if (a !== b) throw new Error(`replacement changes the byte length (${a} to ${b}): ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
		map.set(from, to);
	}
	return map;
}

/* The replacement for one node id, or the halves that have none. */
function map_node_id(map, name) {
	if (map.has(name)) return { to: map.get(name), missing: [] };
	let at = name.lastIndexOf("@");
	let halves = at < 0 ? [name] : [name.slice(0, at), name.slice(at + 1)];
	let missing = halves.filter(half => !map.has(half));
	if (missing.length) return { to: null, missing };
	return { to: halves.map(half => map.get(half)).join("@"), missing: [] };
}

/* ---------- the names in a log ---------- */

const NAMED = new Set(["node_id", "history", "attached_log"]);

/* Every name field in the log: the record it sits in, the offset of its
 * Pascal length byte within that record's payload, and the name. */
function collect_names(bytes) {
	let fields = [];
	let names = new Set();
	let messages = [];
	for (let raw of BoloLog.rawRecords(bytes)) {
		let rec = BoloLog.parseRecord(raw);
		for (let sub of rec.subpackets) {
			if (NAMED.has(sub.type) && sub.name) {
				fields.push({ offset: raw.offset, at: sub.at, name: sub.name });
				names.add(sub.name);
			}
			if (sub.type === "message") messages.push(sub.text);
		}
	}
	return { fields, names, messages };
}

/* ---------- patching ---------- */

/* Every position in `data` at which a Pascal string equal to `needle`
 * begins (its length byte first). */
function find_pascal(data, needle) {
	let hits = [];
	for (let i = 0; i + 1 + needle.length <= data.length; i++) {
		if (data[i] !== needle.length) continue;
		let j = 0;
		while (j < needle.length && data[i + 1 + j] === needle[j]) j++;
		if (j === needle.length) hits.push(i + 1);
	}
	return hits;
}

function redact(bytes, mapping) {
	let { fields, names, messages } = collect_names(bytes);
	let unmapped = new Set();
	let table = new Map();
	for (let name of names) {
		let { to, missing } = map_node_id(mapping, name);
		if (to === null) missing.forEach(half => unmapped.add(half));
		else table.set(name, to);
	}
	if (unmapped.size) {
		throw new Error("no replacement for: " + [...unmapped].sort().map(s => JSON.stringify(s)).join(", "));
	}
	let out = Uint8Array.from(bytes);
	let patched = 0;
	for (let { offset, at, name } of fields) {
		let old_bytes = to_mac_roman(name), new_bytes = to_mac_roman(table.get(name));
		/* The string's bytes start after the length byte; the payload
		 * starts after the 4-byte time tag and the length byte. */
		let base = offset + 5 + at + 1;
		for (let i = 0; i < old_bytes.length; i++) {
			out[base + i] = bytes[base + i] ^ old_bytes[i] ^ new_bytes[i];
		}
		patched++;
	}
	let quoted = 0;
	let halves = new Set();
	for (let name of names) {
		let at = name.lastIndexOf("@");
		(at < 0 ? [name] : [name.slice(0, at), name.slice(at + 1)]).forEach(half => halves.add(half));
	}
	halves.delete("Unknown Machine Name");
	halves.delete("Unknown Machine N");
	for (let text of messages) {
		if ([...halves].some(half => text.includes(half))) quoted++;
	}
	return { out, table, fields, patched, messages: messages.length, quoted };
}

/* The written file, read back: every name it now carries must be a
 * replacement, its name fields must be exactly where they were, and no
 * original may survive in bytes the parser could not read. Returns the
 * number of times an original's bytes occur inside parsed gameplay data,
 * where they are a coincidence and were rightly left alone. */
function verify(out, table, before) {
	let { fields, names } = collect_names(out);
	let expected = new Set(table.values());
	for (let name of names) {
		if (!expected.has(name)) throw new Error(`after patching, an unexpected name remains: ${JSON.stringify(name)}`);
	}
	if (before) {
		if (fields.length !== before.length) throw new Error(`after patching, ${fields.length} name fields where there were ${before.length}`);
		for (let i = 0; i < fields.length; i++) {
			let a = before[i], b = fields[i];
			if (a.offset !== b.offset || a.at !== b.at || table.get(a.name) !== b.name) {
				throw new Error(`after patching, the name field at offset ${a.offset} reads ${JSON.stringify(b.name)}, not ${JSON.stringify(table.get(a.name))}`);
			}
		}
	}
	let coincidences = 0;
	for (let raw of BoloLog.rawRecords(out)) {
		let rec = null;
		for (let from of table.keys()) {
			let needle = to_mac_roman(from);
			for (let at of find_pascal(raw.data, needle)) {
				if (rec === null) rec = BoloLog.parseRecord(raw);
				let unread = rec.unparsed ? raw.data.length - rec.unparsed.length / 2 : raw.data.length;
				if (at - 1 + 1 + needle.length > unread) {
					throw new Error(`after patching, ${JSON.stringify(from)} survives in unparsed bytes at offset ${raw.offset}`);
				}
				coincidences++;
			}
		}
	}
	return coincidences;
}

function main() {
	let args = process.argv.slice(2);
	if (args.length !== 3) {
		console.error("usage: node tools/redact-names.cjs <mapping.txt> <in-log> <out-log>");
		process.exit(2);
	}
	let [mapping_file, in_file, out_file] = args;
	let mapping = read_mapping(mapping_file);
	let bytes = new Uint8Array(fs.readFileSync(in_file));
	if (bytes.length < HEADER_SIZE || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "Bolo") {
		throw new Error(`${in_file}: not a Bolo log`);
	}
	let { out, table, fields, patched, messages, quoted } = redact(bytes, mapping);
	let coincidences = verify(out, table, fields);
	fs.writeFileSync(out_file, out);
	console.log(`${path.basename(in_file)} -> ${path.basename(out_file)}: ${table.size} node ids, ${patched} name fields patched, ` +
		`${messages} chat messages left as they are (${quoted} quoting an original name)`);
	if (coincidences) {
		console.log(`  ${coincidences} place(s) where gameplay data spells an original name by coincidence, left as recorded`);
	}
	for (let [from, to] of [...table].sort()) console.log(`  ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
}

module.exports = { read_mapping, map_node_id, redact, verify };

if (require.main === module) main();
