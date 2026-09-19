/* Minimal WebM muxer for the video export: wraps WebCodecs VP8/VP9 chunks,
 * and optionally Opus chunks, in just enough Matroska to make a file every
 * player accepts. One video track, at most one audio track, no cues
 * (players seek unindexed WebM fine at these durations). No DOM use — also
 * loadable in node for tests.
 *
 * Streaming shape: header() first, then add_block() per encoded chunk, in
 * presentation order within each track; each call returns bytes to append
 * to the file (often empty — clusters are buffered until closed). The two
 * encoders deliver their chunks at their own pace, so with an audio track
 * the blocks are interleaved here: a block is written only once every
 * track has delivered up to its timestamp. finalize() returns the last
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
const ID_CODECPRIVATE = Uint8Array.of(0x63, 0xa2);
const ID_CODECDELAY = Uint8Array.of(0x56, 0xaa);
const ID_SEEKPREROLL = Uint8Array.of(0x56, 0xbb);
const ID_AUDIO = Uint8Array.of(0xe1);
const ID_SAMPLINGFREQUENCY = Uint8Array.of(0xb5);
const ID_CHANNELS = Uint8Array.of(0x9f);
const ID_CLUSTER = Uint8Array.of(0x1f, 0x43, 0xb6, 0x75);
const ID_CLUSTERTIMESTAMP = Uint8Array.of(0xe7);
const ID_SIMPLEBLOCK = Uint8Array.of(0xa3);

const EMPTY = new Uint8Array(0);
const APP_NAME = "Ancient Bolo Log Viewer";

/* A cluster's block timestamps are signed 16-bit ms relative to the cluster;
 * stay well inside that. New clusters also start on every keyframe, which is
 * what makes the file seekable without cues. */
const MAX_CLUSTER_MS = 30000;

const VIDEO_TRACK = 1;
const AUDIO_TRACK = 2;

/* codec_id: "V_VP9" or "V_VP8" (matching the WebCodecs codec in use).
 * audio, when given, adds an Opus track: { codec_private } is the OpusHead
 * the encoder reported, { sample_rate, channels } its format, and
 * { codec_delay_ns } the pre-skip the decoder must drop (Opus files also
 * declare an 80 ms seek pre-roll). Timestamps are in milliseconds
 * throughout. */
function create_muxer({ width, height, codec_id, audio = null }) {
	let offset = 0;             /* bytes handed out so far */
	let segment_start = 0;      /* file offset of the segment payload */
	let segment_size_offset = 0;
	let duration_offset = 0;    /* file offset of the Duration double */
	let cluster = null;         /* { base, blocks } — buffered until closed */
	/* per track: blocks delivered but not yet written, and the latest
	 * timestamp delivered, which bounds what the other track can release */
	let tracks = audio ? [VIDEO_TRACK, AUDIO_TRACK] : [VIDEO_TRACK];
	let pending = new Map(tracks.map(t => [t, []]));
	let latest = new Map(tracks.map(t => [t, -1]));

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
			/* CodecDelay and SeekPreRoll are Matroska version 4 elements,
			 * so a file with the audio track declares that version (as
			 * libwebm does); readers of version 2 still play it */
			element(ID_DOCTYPEVERSION, be_uint(audio ? 4 : 2, 1)),
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

		let entries = [element(ID_TRACKENTRY, concat([
			element(ID_TRACKNUMBER, be_uint(VIDEO_TRACK, 1)),
			element(ID_TRACKUID, be_uint(VIDEO_TRACK, 1)),
			element(ID_TRACKTYPE, be_uint(1, 1)), /* video */
			element(ID_FLAGLACING, be_uint(0, 1)),
			element(ID_CODECID, ascii(codec_id)),
			element(ID_VIDEO, concat([
				element(ID_PIXELWIDTH, be_uint(width, 2)),
				element(ID_PIXELHEIGHT, be_uint(height, 2)),
			])),
		]))];
		if (audio) {
			entries.push(element(ID_TRACKENTRY, concat([
				element(ID_TRACKNUMBER, be_uint(AUDIO_TRACK, 1)),
				element(ID_TRACKUID, be_uint(AUDIO_TRACK, 1)),
				element(ID_TRACKTYPE, be_uint(2, 1)), /* audio */
				element(ID_FLAGLACING, be_uint(0, 1)),
				element(ID_CODECID, ascii("A_OPUS")),
				element(ID_CODECPRIVATE, audio.codec_private),
				element(ID_CODECDELAY, be_uint(audio.codec_delay_ns, 4)),
				element(ID_SEEKPREROLL, be_uint(80000000, 4)),
				element(ID_AUDIO, concat([
					element(ID_SAMPLINGFREQUENCY, be_double(audio.sample_rate)),
					element(ID_CHANNELS, be_uint(audio.channels, 1)),
				])),
			])));
		}
		push(element(ID_TRACKS, concat(entries)));

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

	/* Write one block into the cluster stream. Only a video keyframe opens a
	 * new cluster (audio blocks are all independently decodable, and would
	 * otherwise fragment the file into 20 ms clusters). */
	function write_block({ data, ms, key, track }) {
		let emitted = EMPTY;
		if (cluster === null || (key && track === VIDEO_TRACK && cluster.blocks.length > 0) ||
			ms - cluster.base > MAX_CLUSTER_MS) {
			if (cluster !== null) emitted = close_cluster();
			cluster = { base: ms, blocks: [] };
		}
		let rel = ms - cluster.base;
		let head = Uint8Array.of(0x80 + track, Math.floor(rel / 256), rel % 256, key ? 0x80 : 0);
		cluster.blocks.push(element(ID_SIMPLEBLOCK, concat([head, data])));
		return emitted;
	}

	/* Write every pending block that is safe to order: with `all`, every
	 * block; otherwise those no later than the earliest timestamp all
	 * tracks have reached, since each track delivers in order. Ties go to
	 * the lower track number, the video. */
	function release(all) {
		let limit = all ? Infinity : Math.min(...latest.values());
		let out = [];
		for (;;) {
			let best = null;
			for (let track of tracks) {
				let head = pending.get(track)[0];
				if (head && (best === null || head.ms < best.ms)) best = head;
			}
			if (best === null || best.ms > limit) break;
			pending.get(best.track).shift();
			let bytes = write_block(best);
			if (bytes.length) out.push(bytes);
		}
		return out.length === 1 ? out[0] : concat(out);
	}

	function add_block(data, timestamp_ms, key, track = VIDEO_TRACK) {
		pending.get(track).push({ data, ms: timestamp_ms, key, track });
		latest.set(track, timestamp_ms);
		return release(false);
	}

	function finalize(duration_ms) {
		let flushed = release(true);
		let tail = cluster !== null ? close_cluster() : EMPTY;
		return {
			tail: flushed.length ? concat([flushed, tail]) : tail,
			patches: [
				{ offset: segment_size_offset, bytes: vint8(offset - segment_start) },
				{ offset: duration_offset, bytes: be_double(duration_ms) },
			],
		};
	}

	function be_uint_length(value) {
		let length = 1;
		while (value >= Math.pow(2, 8 * length)) length++;
		return length;
	}

	return { header, add_block, finalize };
}

const BoloWebM = { create_muxer, VIDEO_TRACK, AUDIO_TRACK };

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloWebM;
} else {
	window.BoloWebM = BoloWebM;
}

})();
