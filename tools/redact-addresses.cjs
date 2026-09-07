#!/usr/bin/env node
/* Replace the IPv4 addresses in a log.
 *
 * A log holds addresses in two places: the host's, in the `F1 01` game
 * info (the first four bytes of the game id), and three `IP:port` pairs
 * in every `FF F0` quit record, the quitter's upstream neighbour, the
 * quitter, and the downstream neighbour. Between them they name most
 * of the players' machines. This tool swaps each for a made-up address
 * from a mapping file, the same real address always becoming the same
 * made-up one, so the ring the quit records describe stays consistent
 * across every log of a game and every game of a corpus.
 *
 * An address is four bytes before and after, so the swap is patched in
 * place under the XOR mask like tools/redact-names.cjs and no other
 * byte moves; the ports are left alone. The game id changes with the
 * host address, since it is that address followed by the start time,
 * so a file named after its game id wants renaming afterwards.
 *
 * `--list` prints every distinct address in the given logs, one per
 * line, for building the mapping. The mapping file is lines of
 * `real made-up`, whitespace-separated; every address in a log must be
 * mapped or the tool stops and lists the ones that are not.
 *
 * Usage:
 *   node tools/redact-addresses.cjs --list <log> [<log> ...]
 *   node tools/redact-addresses.cjs <mapping.txt> <in-log> <out-log>
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const BoloLog = require(path.join(ROOT, "viewer", "logparse.js"));

const GAMEINFO_LEN = 90;   /* F1 01 + 56-byte struct + 16 alliance words */
const GAMEINFO_IP = 2 + 36;   /* host address within the subpacket */

function parse_ip(str) {
	let m = str.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) throw new Error(`not an IPv4 address: ${JSON.stringify(str)}`);
	let bytes = m.slice(1).map(Number);
	if (bytes.some(b => b > 255)) throw new Error(`not an IPv4 address: ${JSON.stringify(str)}`);
	return Uint8Array.from(bytes);
}

const format_ip = bytes => Array.from(bytes).join(".");

function read_mapping(file) {
	let map = new Map();
	for (let line of fs.readFileSync(file, "utf8").split("\n")) {
		let fields = line.trim().split(/\s+/);
		if (!fields[0] || fields[0].startsWith("#")) continue;
		if (fields.length !== 2) throw new Error(`mapping line is not two addresses: ${JSON.stringify(line)}`);
		let [from, to] = fields;
		parse_ip(from);
		parse_ip(to);
		if (map.has(from) && map.get(from) !== to) throw new Error(`${from} is mapped twice`);
		map.set(from, to);
	}
	return map;
}

/* Every address in a log, with the file offset of its four bytes. The
 * subpackets are located by their own bytes: the game info by `F1 01`
 * followed by the game id the parser read, a quit by `FF F0`, the
 * field length and the fields the parser read. */
function addresses(bytes) {
	let out = [];
	for (let raw of BoloLog.rawRecords(bytes)) {
		let rec = BoloLog.parseRecord(raw);
		let data = raw.data;
		let base = raw.offset + 5;
		for (let sub of rec.subpackets) {
			if (sub.type === "game_info") {
				let id = Buffer.from(sub.gameId, "hex");
				let at = -1;
				for (let i = 3; i + GAMEINFO_LEN <= data.length; i++) {
					if (data[i] !== 0xf1 || data[i + 1] !== 0x01) continue;
					if (Buffer.from(data.subarray(i + GAMEINFO_IP, i + GAMEINFO_IP + 8)).equals(id)) { at = i; break; }
				}
				if (at < 0) throw new Error(`cannot locate the game info at record offset ${raw.offset}`);
				out.push({ kind: "host", at: base + at + GAMEINFO_IP, ip: format_ip(data.subarray(at + GAMEINFO_IP, at + GAMEINFO_IP + 4)) });
			} else if (sub.type === "quit") {
				let len = sub.fields[0].length / 2;
				let fields = Buffer.from(sub.fields.join(""), "hex");
				let at = -1;
				for (let i = 3; i + 3 + fields.length <= data.length; i++) {
					if (data[i] !== 0xff || data[i + 1] !== 0xf0 || data[i + 2] !== len) continue;
					if (Buffer.from(data.subarray(i + 3, i + 3 + fields.length)).equals(fields)) { at = i; break; }
				}
				if (at < 0) throw new Error(`cannot locate the quit record at record offset ${raw.offset}`);
				if (len < 4) throw new Error(`quit record with ${len}-byte fields at record offset ${raw.offset}`);
				for (let k = 0; k < 3; k++) {
					let field_at = at + 3 + k * len;
					out.push({ kind: ["upstream", "quitter", "downstream"][k], at: base + field_at, ip: format_ip(data.subarray(field_at, field_at + 4)) });
				}
			}
		}
	}
	return out;
}

function redact(bytes, mapping) {
	let found = addresses(bytes);
	let unmapped = new Set(found.map(a => a.ip).filter(ip => !mapping.has(ip)));
	if (unmapped.size) throw new Error("no replacement for: " + [...unmapped].sort().join(", "));
	let out = Uint8Array.from(bytes);
	for (let a of found) {
		let old_bytes = parse_ip(a.ip), new_bytes = parse_ip(mapping.get(a.ip));
		for (let i = 0; i < 4; i++) out[a.at + i] = bytes[a.at + i] ^ old_bytes[i] ^ new_bytes[i];
	}
	/* read back: every address is now a made-up one, at the same places */
	let check = addresses(out);
	let expected = new Set(mapping.values());
	if (check.length !== found.length) throw new Error("after patching, the address count changed");
	check.forEach((a, i) => {
		if (a.at !== found[i].at || a.ip !== mapping.get(found[i].ip)) throw new Error(`after patching, an unexpected address at ${a.at}: ${a.ip}`);
		if (!expected.has(a.ip)) throw new Error(`after patching, ${a.ip} is not a made-up address`);
	});
	return { out, found };
}

function main() {
	let args = process.argv.slice(2);
	if (args[0] === "--list" && args.length >= 2) {
		let seen = new Map();
		for (let file of args.slice(1)) {
			for (let a of addresses(new Uint8Array(fs.readFileSync(file)))) seen.set(a.ip, (seen.get(a.ip) || 0) + 1);
		}
		for (let ip of [...seen.keys()].sort((p, q) => Buffer.compare(parse_ip(p), parse_ip(q)))) console.log(ip);
		return;
	}
	if (args.length !== 3) {
		console.error("usage: node tools/redact-addresses.cjs --list <log> [<log> ...]\n" +
			"       node tools/redact-addresses.cjs <mapping.txt> <in-log> <out-log>");
		process.exit(2);
	}
	let [mapping_file, in_file, out_file] = args;
	let mapping = read_mapping(mapping_file);
	let { out, found } = redact(new Uint8Array(fs.readFileSync(in_file)), mapping);
	fs.writeFileSync(out_file, out);
	let distinct = new Set(found.map(a => a.ip)).size;
	console.log(`${path.basename(in_file)} -> ${path.basename(out_file)}: ${found.length} addresses patched, ${distinct} distinct`);
}

module.exports = { addresses, redact, read_mapping };

if (require.main === module) main();
