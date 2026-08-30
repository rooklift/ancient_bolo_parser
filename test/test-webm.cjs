// Structural test for the video export's WebM muxer (viewer/webm.js): mux
// fake encoded chunks, then re-parse the finished file with an independent
// EBML walker and check every size, timestamp and payload survives.

const BoloWebM = require("../viewer/webm.js");

let failures = 0;
function check(what, got, want) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(got)}${ok ? "" : ` (wanted ${JSON.stringify(want)})`}`);
}

/* ---------- an independent EBML reader ---------- */

function read_vint(bytes, at, keep_marker) {
	let first = bytes[at];
	let length = 1;
	while (length <= 8 && !(first & (0x100 >> length))) length++;
	if (length > 8) throw new Error(`bad VINT marker at ${at}`);
	let value = keep_marker ? first : first & (0xff >> length);
	for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
	return { value, length };
}

/* Parse one level of elements in bytes[at, end). Sizes must be known and
 * land exactly on the region's end: any drift fails the walk. */
function parse_level(bytes, at, end) {
	let elements = [];
	while (at < end) {
		let id = read_vint(bytes, at, true);
		let size = read_vint(bytes, at + id.length, false);
		let start = at + id.length + size.length;
		if (size.value === Math.pow(2, 7 * size.length) - 1) {
			throw new Error(`unknown-size element at ${at}`);
		}
		if (start + size.value > end) throw new Error(`element overruns at ${at}`);
		elements.push({ id: id.value, start, size: size.value });
		at = start + size.value;
	}
	if (at !== end) throw new Error("elements do not tile the region");
	return elements;
}

function find(elements, id) {
	return elements.filter(e => e.id === id);
}

function uint_at(bytes, e) {
	let v = 0;
	for (let i = 0; i < e.size; i++) v = v * 256 + bytes[e.start + i];
	return v;
}

function string_at(bytes, e) {
	return String.fromCharCode(...bytes.slice(e.start, e.start + e.size));
}

function double_at(bytes, e) {
	return new DataView(bytes.buffer, bytes.byteOffset + e.start, 8).getFloat64(0);
}

/* ---------- build a file ---------- */

// Frame sizes straddle the 1-byte/2-byte VINT boundary (SimpleBlock payload
// = data + 4, size 127 needs a 2-byte VINT) so the reader proves the size
// encoding at the edge.
function fake_frame(i) {
	let size = [100, 121, 122, 123, 124, 300, 5000][i % 7];
	let data = new Uint8Array(size);
	for (let j = 0; j < size; j++) data[j] = (i + j) % 256;
	return data;
}

const FPS = 60;
const FRAMES = 300; /* 5 seconds: 3 keyframe clusters at one per 120 frames */
const muxer = BoloWebM.create_muxer({ width: 1920, height: 1080, codec_id: "V_VP9" });
const parts = [muxer.header(1234.5)];
const inputs = [];
for (let i = 0; i < FRAMES; i++) {
	let ms = Math.round(i * 1000 / FPS);
	let key = i % 120 === 0;
	inputs.push({ data: fake_frame(i), ms, key });
	parts.push(muxer.add_block(fake_frame(i), ms, key));
}
const fin = muxer.finalize(FRAMES * 1000 / FPS);
parts.push(fin.tail);

let total = parts.reduce((n, p) => n + p.length, 0);
const file = new Uint8Array(total);
{
	let n = 0;
	for (let p of parts) { file.set(p, n); n += p.length; }
}
for (const patch of fin.patches) file.set(patch.bytes, patch.offset);

/* ---------- walk it ---------- */

const top = parse_level(file, 0, file.length);
check("top level is EBML header then segment",
	top.map(e => e.id), [0x1a45dfa3, 0x18538067]);

const header = parse_level(file, top[0].start, top[0].start + top[0].size);
check("doctype", string_at(file, find(header, 0x4282)[0]), "webm");

const segment = top[1];
check("segment size patch covers the file exactly",
	segment.start + segment.size, file.length);

const seg = parse_level(file, segment.start, segment.start + segment.size);
const info = parse_level(file, find(seg, 0x1549a966)[0].start,
	find(seg, 0x1549a966)[0].start + find(seg, 0x1549a966)[0].size);
check("timestamp scale is 1ms", uint_at(file, find(info, 0x2ad7b1)[0]), 1000000);
check("duration patch", double_at(file, find(info, 0x4489)[0]), FRAMES * 1000 / FPS);

const tracks_el = find(seg, 0x1654ae6b)[0];
const entry = parse_level(file, tracks_el.start, tracks_el.start + tracks_el.size)[0];
const track = parse_level(file, entry.start, entry.start + entry.size);
check("track basics", [
	uint_at(file, find(track, 0xd7)[0]),
	uint_at(file, find(track, 0x83)[0]),
	string_at(file, find(track, 0x86)[0]),
], [1, 1, "V_VP9"]);
const video = parse_level(file, find(track, 0xe0)[0].start,
	find(track, 0xe0)[0].start + find(track, 0xe0)[0].size);
check("track dimensions", [
	uint_at(file, find(video, 0xb0)[0]),
	uint_at(file, find(video, 0xba)[0]),
], [1920, 1080]);

const clusters = find(seg, 0x1f43b675);
check("one cluster per keyframe", clusters.length, 3);
check("cluster base timestamps", clusters.map(c =>
	uint_at(file, find(parse_level(file, c.start, c.start + c.size), 0xe7)[0])),
	[0, 2000, 4000]);

let seen = 0, mismatches = 0, out_of_order = 0;
for (const c of clusters) {
	const level = parse_level(file, c.start, c.start + c.size);
	const base = uint_at(file, find(level, 0xe7)[0]);
	let prev = -1;
	for (const b of find(level, 0xa3)) {
		check_block: {
			const track_num = file[b.start];
			const rel = file[b.start + 1] * 256 + file[b.start + 2];
			const flags = file[b.start + 3];
			const data = file.slice(b.start + 4, b.start + b.size);
			const want = inputs[seen];
			if (track_num !== 0x81) { mismatches++; break check_block; }
			if (base + rel !== want.ms) { mismatches++; break check_block; }
			if ((flags === 0x80) !== want.key) { mismatches++; break check_block; }
			if (data.length !== want.data.length ||
				!data.every((v, i) => v === want.data[i])) { mismatches++; break check_block; }
			if (rel <= prev) out_of_order++;
			prev = rel;
		}
		seen++;
	}
}
check("every block roundtrips (count, mismatches, ordering)",
	[seen, mismatches, out_of_order], [FRAMES, 0, 0]);

// A long keyframe-less stretch still splits clusters before the relative
// timestamp leaves its signed 16-bit range.
{
	const m = BoloWebM.create_muxer({ width: 64, height: 64, codec_id: "V_VP8" });
	const p = [m.header(60000)];
	const one = new Uint8Array([1, 2, 3]);
	p.push(m.add_block(one, 0, true));
	for (let ms = 1000; ms <= 60000; ms += 1000) p.push(m.add_block(one, ms, false));
	const f = m.finalize(60000);
	p.push(f.tail);
	let bytes = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
	let n = 0;
	for (let x of p) { bytes.set(x, n); n += x.length; }
	for (const patch of f.patches) bytes.set(patch.bytes, patch.offset);
	const t = parse_level(bytes, 0, bytes.length);
	const s = parse_level(bytes, t[1].start, t[1].start + t[1].size);
	const cl = find(s, 0x1f43b675);
	const bases = cl.map(c =>
		uint_at(bytes, find(parse_level(bytes, c.start, c.start + c.size), 0xe7)[0]));
	check("keyframe-less stream splits within int16 ms", bases, [0, 31000]);
}

process.exit(failures ? 1 : 0);
