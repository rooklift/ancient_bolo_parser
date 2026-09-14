// A Bolo log built from record payloads, for the redaction tests: the
// 72-byte header opening "Bolo", then each record as a 4-byte time tag in
// the clear, the masked length byte and the masked payload.

const fs = require("node:fs");
const path = require("node:path");

const mask_source = fs.readFileSync(path.join(__dirname, "..", "src", "mask.js"), "utf8");
const MASK = Uint8Array.from(JSON.parse(mask_source.match(/Uint8Array\.from\((\[[\s\S]*?\])\)/)[1].replace(/0x([0-9a-f]+)/gi, (_, h) => parseInt(h, 16)).replace(/,\s*\]/, "]")));

function build_log(records) {
	let header = new Uint8Array(72);
	header.set([0x42, 0x6f, 0x6c, 0x6f]);
	let parts = [header];
	let time = 100;
	for (let payload of records) {
		let rec = new Uint8Array(5 + payload.length);
		rec[0] = time & 0xff; rec[1] = (time >> 8) & 0xff; rec[2] = 0; rec[3] = 0;
		rec[4] = (payload.length + 1) ^ MASK[0];
		for (let i = 0; i < payload.length; i++) rec[5 + i] = payload[i] ^ MASK[(i + 1) % MASK.length];
		parts.push(rec);
		time += 10;
	}
	let out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let pos = 0;
	for (let p of parts) { out.set(p, pos); pos += p.length; }
	return out;
}

/* A Pascal string's bytes, length byte first. */
const str = s => [s.length, ...Array.from(s, c => c.charCodeAt(0))];

/* The byte offsets at which two logs differ. */
function changed_bytes(a, b) {
	let out = [];
	for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
	return out;
}

module.exports = { MASK, build_log, str, changed_bytes };
