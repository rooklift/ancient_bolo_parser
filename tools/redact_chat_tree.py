#!/usr/bin/env python3
"""Copy a directory tree of Bolo logs with every chat message redacted.

	python3 tools/redact_chat_tree.py <dir>

The tree is recreated at <dir>_redacted (refused if that exists). Every
regular file that is a well-formed Bolo 0.99.x log is copied there with
the text of each `FA` chat message replaced by random printable ASCII
(0x20-0x7e, never starting or ending with a space) of the same length,
patched in place under the XOR mask so no other byte changes. Files that
are not Bolo logs are left out; a Bolo log the parser cannot read to the
end is refused and listed, since bytes it cannot read could hide chat.

Messages are located by walking each record's subpackets, never by
searching for bytes, so map data that spells a message is left alone.

Self-contained: no dependency on the rest of this repository.
"""

import os
import secrets
import sys

HEADER_SIZE = 72

# The 128-byte XOR mask Bolo applies to every record, restarting at the
# record's length byte (src/mask.js).
MASK = bytes([
	0x83, 0xb6, 0x59, 0xe3, 0xee, 0x59, 0x10, 0x27,
	0xa8, 0x64, 0xff, 0x17, 0x8f, 0xcc, 0xec, 0x85,
	0x9d, 0x8b, 0x32, 0x77, 0x3d, 0x4d, 0xc9, 0x14,
	0x74, 0x4b, 0xaa, 0xbe, 0x40, 0x56, 0x8e, 0x6f,
	0x42, 0x9b, 0x80, 0x8f, 0x8c, 0x5f, 0x0b, 0x61,
	0xdc, 0xfc, 0x84, 0x1f, 0x45, 0xa8, 0x3a, 0x39,
	0xfd, 0x6f, 0xc9, 0xbe, 0x31, 0x7e, 0x0b, 0x39,
	0x28, 0xfb, 0xff, 0xaa, 0x7b, 0x58, 0x82, 0x65,
	0xd0, 0xd6, 0x0e, 0x15, 0x35, 0xd8, 0x64, 0x86,
	0x83, 0x0c, 0xe7, 0x59, 0xb5, 0xe3, 0xd8, 0x88,
	0x35, 0xb8, 0xcf, 0x4f, 0x81, 0xb1, 0xce, 0x92,
	0x86, 0x6f, 0xc8, 0xb1, 0x9f, 0xd5, 0x29, 0xc2,
	0x80, 0x24, 0xc6, 0xc4, 0x01, 0xc4, 0x4f, 0xf9,
	0x2a, 0xe3, 0x12, 0x11, 0xa4, 0x1e, 0x3d, 0x1c,
	0xf9, 0xd6, 0xdc, 0xcb, 0x2d, 0xf9, 0x74, 0x25,
	0xf8, 0xf1, 0xa1, 0x4c, 0x89, 0xff, 0x79, 0xdd,
])


class Unreadable(Exception):
	"""A record, or a file, the parser cannot read to the end."""


# ---------------------------------------------------------------------------
# Record framing (src/parse.js rawRecords)

def raw_records(buf):
	"""Yield (offset, payload) for every record, payload decrypted.

	The record at `offset` is a 4-byte time tag in the clear, a masked
	length byte at offset + 4 (length counts itself) and the masked
	payload from offset + 5. Raises Unreadable on a bad length or a
	file that ends mid-record."""
	if len(buf) < HEADER_SIZE or buf[:4] != b"Bolo":
		raise Unreadable("not a Bolo log")
	pos = HEADER_SIZE
	while pos + 5 <= len(buf):
		length = buf[pos + 4] ^ MASK[0]
		if length < 4 or length > 127:
			raise Unreadable(f"bad record length {length} at offset {pos}")
		end = pos + 4 + length
		if end > len(buf):
			raise Unreadable(f"truncated final record at offset {pos}")
		payload = bytes(buf[pos + 5 + i] ^ MASK[(i + 1) % 128] for i in range(length - 1))
		yield pos, payload
		pos = end
	if pos < len(buf):
		raise Unreadable(f"{len(buf) - pos} trailing bytes after the last record")


# ---------------------------------------------------------------------------
# Subpacket walk (src/parse.js parseRecord / parseIdSubpackets), reduced
# to what matters here: where the chat messages are, and whether every
# byte of the record was accounted for.

def ensure(data, pos, n):
	if pos + n > len(data):
		raise Unreadable("truncated subpacket")


def pascal_end(data, pos):
	ensure(data, pos, 1)
	ensure(data, pos, 1 + data[pos])
	return pos + 1 + data[pos]


def f1_length(data, pos):
	ensure(data, pos, 2)
	sub = data[pos + 1]
	if sub == 0x01:
		ensure(data, pos, 90)
		return 90
	if sub in (0x02, 0x03, 0x04):
		ensure(data, pos, 3)
		count = data[pos + 2]
		if count > 16:
			raise Unreadable(f"implausible object list count {count}")
		size = 3 + count * {2: 5, 3: 6, 4: 3}[sub]
		ensure(data, pos, size)
		return size
	if (sub & 0xf0) in (0x80, 0xc0):
		ensure(data, pos, 42)
		return 42
	raise Unreadable(f"unknown F1 subtype {sub:#04x}")


def ff_length(data, pos):
	ensure(data, pos, 2)
	code = data[pos + 1]
	hi = code >> 4
	if hi <= 0x04 or hi in (0x06, 0x07) or code in (0xf1, 0xf4, 0xf5, 0xf6):
		return 2
	if code in (0x50, 0x51, 0xf2, 0xf3) or hi == 0x08:
		ensure(data, pos, 4)
		return 4
	if code == 0xf0:
		ensure(data, pos, 3)
		size = 3 + data[pos + 2] * 3
		ensure(data, pos, size)
		return size
	raise Unreadable(f"unknown FF subpacket {code:#04x}")


def message_spans(data):
	"""The chat messages of one decrypted record payload, as a list of
	(player, seq, address, text_start, text_length), text_start being
	the offset of the first text byte within the payload. Raises
	Unreadable if any byte of the record cannot be read."""
	if len(data) < 3:
		raise Unreadable("record shorter than its header")
	seq = data[0]
	status = data[1] >> 4
	player = data[1] & 0x0f
	tank_status = data[2] >> 4
	pos = 3
	spans = []

	if tank_status == 0x0f:
		# BoloViewer "attached log" pseudo-record: F0 then a Pascal string.
		if pos >= len(data) or data[pos] != 0xf0:
			raise Unreadable("attached-log record without F0 marker")
		if pascal_end(data, pos + 1) != len(data):
			raise Unreadable("attached-log record with trailing bytes")
		return spans

	if status & 0x02:
		raise Unreadable("towed-base status bit set: record layout unknown")
	if tank_status & 0x08:
		ensure(data, pos, 5)
		pos += 5
	if status & 0x0c:
		ensure(data, pos, 3)
		pos += 3

	while pos < len(data):
		byte = data[pos]
		hi = byte >> 4
		if hi <= 0x03:
			size = 4 + hi * 2
		elif hi == 0x04:
			size = 4
		elif hi in (0x06, 0x07):
			size = 3
		elif hi <= 0x0e:
			size = 1
		elif byte in (0xf0, 0xf4, 0xf9, 0xfc):
			size = 2
		elif byte == 0xf1:
			size = f1_length(data, pos)
		elif byte in (0xf2, 0xf5):
			size = 3
		elif byte == 0xf3:
			ensure(data, pos, 4)
			run_length = data[pos + 3]
			if run_length < 4:
				raise Unreadable("map run shorter than its own header")
			size = 3 + run_length
		elif byte in (0xf6, 0xf7, 0xfd, 0xfe):
			size = 1
		elif byte == 0xf8:
			size = pascal_end(data, pos + 1) - pos
		elif byte == 0xfa:
			ensure(data, pos, 4)
			address = data[pos + 1] | (data[pos + 2] << 8)
			length = data[pos + 3]
			ensure(data, pos + 3, 1 + length)
			spans.append((player, seq, address, pos + 4, length))
			pos += 4 + length
			# A zero-length message is a sender-side fault and the bytes
			# after it are buffer leavings, not subpackets [E:empty-chat].
			# They are left as recorded, as the reference parser leaves
			# them. Shell lists after a real message are genuine.
			if length == 0:
				break
			continue
		elif byte == 0xfb:
			size = 4
		elif byte == 0xff:
			size = ff_length(data, pos)
		else:
			raise Unreadable(f"unknown subpacket id {byte:#04x}")
		ensure(data, pos, size)
		pos += size
	return spans


def find_messages(buf):
	"""Every chat message in a log: (identity, file offset of the first
	text byte, text length). Raises Unreadable on anything the parser
	cannot account for."""
	out = []
	for offset, payload in raw_records(buf):
		try:
			spans = message_spans(payload)
		except Unreadable as err:
			raise Unreadable(f"record at offset {offset}: {err}") from None
		for player, seq, address, start, length in spans:
			text = payload[start:start + length]
			out.append(((player, seq, address, text), offset + 5 + start, length))
	return out


# ---------------------------------------------------------------------------
# Redaction

def replacement(length):
	"""`length` random bytes of printable ASCII, 0x20-0x7e, not starting
	or ending with a space."""
	out = bytearray(0x20 + secrets.randbelow(95) for _ in range(length))
	for i in (0, length - 1):
		if length and out[i] == 0x20:
			out[i] = 0x21 + secrets.randbelow(94)
	return bytes(out)


def redact(buf):
	"""The log with every chat message replaced; the number of messages
	replaced. The patch is `stored ^ old ^ new`, so the mask cancels
	and only the text bytes change; the result is re-parsed to prove
	it."""
	found = find_messages(buf)
	out = bytearray(buf)
	patched = set()
	texts = []
	for identity, at, length in found:
		new = replacement(length)
		old = identity[3]
		for k in range(length):
			out[at + k] ^= old[k] ^ new[k]
			patched.add(at + k)
		texts.append(new)
	# Read back: the same messages at the same places, each now its
	# replacement, and no byte changed anywhere else.
	after = find_messages(bytes(out))
	if len(after) != len(found):
		raise Unreadable("after patching, the message count changed")
	for (identity, at, length), (identity2, at2, length2), new in zip(found, after, texts):
		if at != at2 or length != length2 or identity2[:3] != identity[:3]:
			raise Unreadable(f"after patching, the message at {at} moved")
		if identity2[3] != new:
			raise Unreadable(f"after patching, unexpected text at {at}")
	for k in range(len(buf)):
		if buf[k] != out[k] and k not in patched:
			raise Unreadable(f"after patching, byte {k} changed outside any message")
	return bytes(out), len(found)


# ---------------------------------------------------------------------------
# The tree

def main(argv):
	if len(argv) != 2:
		print(f"usage: {os.path.basename(argv[0])} <dir>", file=sys.stderr)
		return 2
	src = os.path.abspath(argv[1])
	if not os.path.isdir(src):
		print(f"error: not a directory: {src}", file=sys.stderr)
		return 2
	dst = src + "_redacted"
	if os.path.lexists(dst):
		print(f"error: already exists: {dst}", file=sys.stderr)
		return 2

	copied = messages = other = 0
	skipped_links = []
	refused = []

	os.mkdir(dst)
	# followlinks=False: a symlink to a directory is listed but never
	# entered, so a link back up the tree cannot recurse. Directories
	# cannot be hard-linked on Linux, so hard links only ever mean a
	# file copied twice. Symlinks of either kind are skipped and listed.
	for dirpath, dirnames, filenames in os.walk(src, followlinks=False):
		rel = os.path.relpath(dirpath, src)
		out_dir = dst if rel == "." else os.path.join(dst, rel)
		for name in sorted(dirnames):
			if os.path.islink(os.path.join(dirpath, name)):
				skipped_links.append(os.path.join(dirpath, name))
		dirnames[:] = sorted(d for d in dirnames if not os.path.islink(os.path.join(dirpath, d)))
		for name in dirnames:
			os.mkdir(os.path.join(out_dir, name))
		for name in sorted(filenames):
			path = os.path.join(dirpath, name)
			if os.path.islink(path) or not os.path.isfile(path):
				skipped_links.append(path)
				continue
			with open(path, "rb") as f:
				buf = f.read()
			if len(buf) < HEADER_SIZE or buf[:4] != b"Bolo":
				other += 1
				continue
			try:
				out, n = redact(buf)
			except Unreadable as err:
				refused.append((path, str(err)))
				continue
			with open(os.path.join(out_dir, name), "wb") as f:
				f.write(out)
			copied += 1
			messages += n

	print(f"{dst}: {copied} logs copied, {messages} messages redacted, {other} non-log files left out")
	for path in skipped_links:
		print(f"skipped (symlink or special file): {path}", file=sys.stderr)
	for path, why in refused:
		print(f"REFUSED (Bolo log not copied): {path}: {why}", file=sys.stderr)
	return 1 if refused else 0


if __name__ == "__main__":
	sys.exit(main(sys.argv))
