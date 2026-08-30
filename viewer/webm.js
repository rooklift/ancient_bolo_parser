/* Minimal WebM muxer for the video export: wraps WebCodecs VP8/VP9 chunks
 * in just enough Matroska to make a file every player accepts. One video
 * track, no audio, no cues (players seek unindexed WebM fine at these
 * durations). No DOM use — also loadable in node for tests.
 *
 * Streaming shape: header() first, then add_block() per encoded chunk in
 * presentation order; each call returns bytes to append to the file (often
 * empty — clusters are buffered until closed). finalize() returns the last
 * cluster plus positional patches that back-fill the two values a streamed
 * file cannot know upfront (segment size, exact duration), so the finished
 * file has no unknown-size elements at all. */
"use strict";
(function () {

/* An EBML element is its id bytes, a length-marked size, then the payload.
 * Sizes can exceed 32 bits (the segment spans the whole file), so all the
 * byte-mangling here is float-safe: no bitwise ops on sizes. */

function be_uint(value, length) {
	let bytes = new Uint8Array(length);
	for (let i = length - 1; i >= 0; i--) {
		bytes[i] = value % 256;
		value = Math.floor(value / 256);
	}
	return bytes;
}

/* Shortest VINT encoding. The all-ones pattern of each length means
 * "unknown", so a value that would hit it takes the next length up. */
function vint(value) {
	let length = 1;
	while (length < 8 && value > Math.pow(2, 7 * length) - 2) length++;
	let bytes = be_uint(value, length);
	bytes[0] += Math.pow(2, 8 - length);
	return bytes;
}

/* Fixed 8-byte VINT, so the segment size can be patched in place later. */
function vint8(value) {
	let bytes = be_uint(value, 8);
	bytes[0] += 0x01;
	return bytes;
}

function be_double(value) {
	let bytes = new Uint8Array(8);
	new DataView(bytes.buffer).setFloat64(0, value);
	return bytes;
}

function ascii(s) {
	let bytes = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0x7f;
	return bytes;
}

function concat(parts) {
	let total = 0;
	for (let p of parts) total += p.length;
	let out = new Uint8Array(total);
	let n = 0;
	for (let p of parts) { out.set(p, n); n += p.length; }
	return out;
}

function element(id, payload) {
	return concat([id, vint(payload.length), payload]);
}

const ID_EBML = Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3);
const ID_EBMLVERSION = Uint8Array.of(0x42, 0x86);
const ID_EBMLREADVERSION = Uint8Array.of(0x42, 0xf7);
const ID_EBMLMAXIDLENGTH = Uint8Array.of(0x42, 0xf2);
const ID_EBMLMAXSIZELENGTH = Uint8Array.of(0x42, 0xf3);
const ID_DOCTYPE = Uint8Array.of(0x42, 0x82);
const ID_DOCTYPEVERSION = Uint8Array.of(0x42, 0x87);
const ID_DOCTYPEREADVERSION = Uint8Array.of(0x42, 0x85);
const ID_SEGMENT = Uint8Array.of(0x18, 0x53, 0x80, 0x67);
const ID_INFO = Uint8Array.of(0x15, 0x49, 0xa9, 0x66);
const ID_TIMESTAMPSCALE = Uint8Array.of(0x2a, 0xd7, 0xb1);
const ID_DURATION = Uint8Array.of(0x44, 0x89);
const ID_MUXINGAPP = Uint8Array.of(0x4d, 0x80);
const ID_WRITINGAPP = Uint8Array.of(0x57, 0x41);
const ID_TRACKS = Uint8Array.of(0x16, 0x54, 0xae, 0x6b);
const ID_TRACKENTRY = Uint8Array.of(0xae);
const ID_TRACKNUMBER = Uint8Array.of(0xd7);
const ID_TRACKUID = Uint8Array.of(0x73, 0xc5);
const ID_TRACKTYPE = Uint8Array.of(0x83);
const ID_FLAGLACING = Uint8Array.of(0x9c);
const ID_CODECID = Uint8Array.of(0x86);
const ID_VIDEO = Uint8Array.of(0xe0);
const ID_PIXELWIDTH = Uint8Array.of(0xb0);
const ID_PIXELHEIGHT = Uint8Array.of(0xba);
const ID_CLUSTER = Uint8Array.of(0x1f, 0x43, 0xb6, 0x75);
const ID_CLUSTERTIMESTAMP = Uint8Array.of(0xe7);
const ID_SIMPLEBLOCK = Uint8Array.of(0xa3);

const EMPTY = new Uint8Array(0);
const APP_NAME = "Ancient Bolo Log Viewer";

/* A cluster's block timestamps are signed 16-bit ms relative to the cluster;
 * stay well inside that. New clusters also start on every keyframe, which is
 * what makes the file seekable without cues. */
const MAX_CLUSTER_MS = 30000;

/* codec_id: "V_VP9" or "V_VP8" (matching the WebCodecs codec in use).
 * Timestamps are in milliseconds throughout. */
function create_muxer({ width, height, codec_id }) {
	let offset = 0;             /* bytes handed out so far */
	let segment_start = 0;      /* file offset of the segment payload */
	let segment_size_offset = 0;
	let duration_offset = 0;    /* file offset of the Duration double */
	let cluster = null;         /* { base, blocks } — buffered until closed */

	/* duration_ms_estimate makes the header self-consistent even if the
	 * finalize patch never lands (it is re-patched with the exact value). */
	function header(duration_ms_estimate) {
		let parts = [];
		let push = bytes => { parts.push(bytes); offset += bytes.length; };

		push(element(ID_EBML, concat([
			element(ID_EBMLVERSION, be_uint(1, 1)),
			element(ID_EBMLREADVERSION, be_uint(1, 1)),
			element(ID_EBMLMAXIDLENGTH, be_uint(4, 1)),
			element(ID_EBMLMAXSIZELENGTH, be_uint(8, 1)),
			element(ID_DOCTYPE, ascii("webm")),
			element(ID_DOCTYPEVERSION, be_uint(2, 1)),
			element(ID_DOCTYPEREADVERSION, be_uint(2, 1)),
		])));

		push(ID_SEGMENT);
		segment_size_offset = offset;
		push(vint8(0)); /* patched to the real segment size by finalize() */
		segment_start = offset;

		let scale = element(ID_TIMESTAMPSCALE, be_uint(1000000, 3)); /* 1ms ticks */
		let info_payload = concat([
			scale,
			element(ID_DURATION, be_double(duration_ms_estimate)),
			element(ID_MUXINGAPP, ascii(APP_NAME)),
			element(ID_WRITINGAPP, ascii(APP_NAME)),
		]);
		let info_size = vint(info_payload.length);
		duration_offset = offset + ID_INFO.length + info_size.length +
			scale.length + ID_DURATION.length + 1; /* 1: vint(8) is one byte */
		push(concat([ID_INFO, info_size, info_payload]));

		push(element(ID_TRACKS, element(ID_TRACKENTRY, concat([
			element(ID_TRACKNUMBER, be_uint(1, 1)),
			element(ID_TRACKUID, be_uint(1, 1)),
			element(ID_TRACKTYPE, be_uint(1, 1)), /* video */
			element(ID_FLAGLACING, be_uint(0, 1)),
			element(ID_CODECID, ascii(codec_id)),
			element(ID_VIDEO, concat([
				element(ID_PIXELWIDTH, be_uint(width, 2)),
				element(ID_PIXELHEIGHT, be_uint(height, 2)),
			])),
		]))));

		return concat(parts);
	}

	function close_cluster() {
		let payload = concat([
			element(ID_CLUSTERTIMESTAMP,
				be_uint(cluster.base, Math.max(1, be_uint_length(cluster.base)))),
			...cluster.blocks,
		]);
		cluster = null;
		let bytes = concat([ID_CLUSTER, vint(payload.length), payload]);
		offset += bytes.length;
		return bytes;
	}

	function be_uint_length(value) {
		let length = 1;
		while (value >= Math.pow(2, 8 * length)) length++;
		return length;
	}

	function add_block(data, timestamp_ms, key) {
		let emitted = EMPTY;
		if (cluster === null || (key && cluster.blocks.length > 0) ||
			timestamp_ms - cluster.base > MAX_CLUSTER_MS) {
			if (cluster !== null) emitted = close_cluster();
			cluster = { base: timestamp_ms, blocks: [] };
		}
		let rel = timestamp_ms - cluster.base;
		let head = Uint8Array.of(0x81, Math.floor(rel / 256), rel % 256, key ? 0x80 : 0);
		cluster.blocks.push(element(ID_SIMPLEBLOCK, concat([head, data])));
		return emitted;
	}

	function finalize(duration_ms) {
		let tail = cluster !== null ? close_cluster() : EMPTY;
		return {
			tail,
			patches: [
				{ offset: segment_size_offset, bytes: vint8(offset - segment_start) },
				{ offset: duration_offset, bytes: be_double(duration_ms) },
			],
		};
	}

	return { header, add_block, finalize };
}

const BoloWebM = { create_muxer };

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloWebM;
} else {
	window.BoloWebM = BoloWebM;
}

})();
