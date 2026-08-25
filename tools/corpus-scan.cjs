#!/usr/bin/env node
// Corpus scanner: walks a directory tree of Bolo logs and aggregates the
// format statistics we can't get from a couple of files — rare opcodes,
// parser warnings, versions, and ownership ground-truth checks against
// mid-game pill-list restatements.
//
//   node tools/corpus-scan.cjs [dir]
//
// Run from a checkout of this repo (it uses the repo's parser and engine).
// The output deliberately contains no log content (no names, hosts or
// chat) so results can be shared; file paths are relative to the root.
"use strict";

const fs = require("fs");
const path = require("path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const BoloGame = require(path.join(__dirname, "..", "viewer", "game.js"));

const ROOT = process.argv[2] || "C:/Users/Owner/__DOCS/Bolo Archives/Nemokrad's Bolo logs";
const SAMPLE_CAP = 12;

function* walk(dir) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) yield* walk(p);
		else if (e.isFile()) yield p;
	}
}

const S = {
	files: 0, notLogs: 0, unreadable: 0, corrupt: [],
	records: 0, bytes: 0,
	versions: {},               // header version hex -> file count
	warningFiles: 0, warnings: 0, warningSamples: [],
	truncatedFiles: 0,
	rollovers: [],              // files where the time tag wrapped
	defective: [],              // no game_info in the first 200 records
	// never-before-seen things
	b2Records: 0, b2Files: [],
	attachedLogs: 0, attachedFiles: [],
	missiles: 0, nops: 0, baseTows: 0, missileDrains: 0, oddFiles: [],
	historySubs: {},            // F1 sub byte -> count
	historySamples: [],         // non-boilerplate history blocks (hex)
	quitFieldLens: {},          // FFF0 field length -> count
	// ownership evidence
	hostileRepairs: [], neutralRepairs: 0, friendlyRepairs: 0,
	allianceLeaves: 0, leaveFiles: [],
	midGamePillLists: 0, oracleChecks: 0, oracleMismatches: [],
	longest: { records: 0, file: null },
};

const BOILER = "ffffffff000100000000000000000000000000000000000000000000000000000000000000000000";

function scanFile(file) {
	let buf;
	try { buf = new Uint8Array(fs.readFileSync(file)); } catch { S.unreadable++; return; }
	if (buf.length < 72 || buf[0] !== 0x42 || buf[1] !== 0x6f || buf[2] !== 0x6c || buf[3] !== 0x6f) { S.notLogs++; return; }
	const rel = path.relative(ROOT, file);
	S.files++;
	S.bytes += buf.length;

	const header = BoloLog.parseHeader(buf);
	S.versions[header.version] = (S.versions[header.version] || 0) + 1;

	const stats = {};
	const recs = [];
	try {
		for (const r of BoloLog.records(buf, stats)) recs.push(r);
	} catch (err) {
		S.corrupt.push(`${rel}: ${err.message} (after ${recs.length} records)`);
	}
	S.records += recs.length;
	if (stats.truncatedBytes) S.truncatedFiles++;
	if (recs.length > S.longest.records) S.longest = { records: recs.length, file: rel };

	let warned = 0, sawGameInfo = false, rolled = false, prevRaw = -1;
	for (let i = 0; i < recs.length; i++) {
		const r = recs[i];
		if (r.warning) {
			warned++;
			if (S.warningSamples.length < SAMPLE_CAP) S.warningSamples.push(`${rel} rec ${i}: ${r.warning}`);
		}
		if (r.status & 0x02) { S.b2Records++; if (!S.b2Files.includes(rel)) S.b2Files.push(rel); }
		if (r.tankStatus === 0x0f) { S.attachedLogs++; if (!S.attachedFiles.includes(rel)) S.attachedFiles.push(rel); }
		const raw = r.time % 0x100000000;
		if (prevRaw >= 0 && prevRaw - raw > 0x80000000) rolled = true;
		for (const sub of r.subpackets) {
			switch (sub.type) {
				case "game_info": if (i < 200) sawGameInfo = true; break;
				case "missile": S.missiles++; if (!S.oddFiles.includes(rel)) S.oddFiles.push(rel); break;
				case "nop": S.nops++; if (!S.oddFiles.includes(rel)) S.oddFiles.push(rel); break;
				case "base_tow_pickup": case "base_tow_drop": S.baseTows++; if (!S.oddFiles.includes(rel)) S.oddFiles.push(rel); break;
				case "history": {
					S.historySubs[sub.sub.toString(16)] = (S.historySubs[sub.sub.toString(16)] || 0) + 1;
					if (sub.raw !== BOILER && S.historySamples.length < SAMPLE_CAP) {
						S.historySamples.push(`${rel} sub=0x${sub.sub.toString(16)}: ${sub.raw}`);
					}
					break;
				}
				case "quit": {
					const len = sub.fields && sub.fields[0] !== undefined ? sub.fields[0].length / 2 : -1;
					S.quitFieldLens[len] = (S.quitFieldLens[len] || 0) + 1;
					break;
				}
			}
		}
	}
	if (warned) { S.warningFiles++; S.warnings += warned; }
	if (rolled) S.rollovers.push(rel);
	if (!sawGameInfo && recs.length >= 200) S.defective.push(rel);

	// --- engine pass: ownership evidence -------------------------------
	try {
		const seed = BoloGame.extract_initial_map(recs);
		const s = BoloGame.initial_state(seed);
		const allied = (a, b) => a === b || (!(s.alliances[a] & (1 << b)) && !(s.alliances[b] & (1 << a)));
		let listsSeen = 0;
		for (let i = 0; i < recs.length; i++) {
			const r = recs[i];
			for (const sub of r.subpackets) {
				if (["pill_repair_4", "pill_repair_8", "pill_repair_12", "pill_repair_full"].includes(sub.type)) {
					const p = s.pills[sub.pillbox];
					if (!p) continue;
					if (p.owner > 15) S.neutralRepairs++;
					else if (allied(r.player, p.owner)) S.friendlyRepairs++;
					else if (S.hostileRepairs.length < SAMPLE_CAP) {
						S.hostileRepairs.push(`${rel} rec ${i}: ${sub.type} of pill ${sub.pillbox} (owner p${p.owner}, armour ${p.armour}) by p${r.player}`);
					}
				}
				if (sub.type === "alliance_leave") { S.allianceLeaves++; if (!S.leaveFiles.includes(rel)) S.leaveFiles.push(rel); }
				if (sub.type === "pillbox_list") {
					listsSeen++;
					if (listsSeen > 1) {
						// mid-game restatement: ground truth vs engine belief
						S.midGamePillLists++;
						sub.items.forEach((it, idx) => {
							const p = s.pills[idx];
							if (!p) return;
							S.oracleChecks++;
							const listCarried = it.armour === 0xff;
							const engCarried = typeof p.inTank === "number" && p.inTank >= 0;
							const listOwner = it.owner > 15 ? 16 : it.owner;
							/* carried pills: the list's owner field is the carrier —
							 * check carrier identity, not just carried-ness */
							const ok = listCarried === engCarried &&
								(listCarried ? listOwner === p.inTank : listOwner === p.owner);
							if (!ok && S.oracleMismatches.length < SAMPLE_CAP * 2) {
								S.oracleMismatches.push(`${rel} rec ${i} pill ${idx}: list owner=${listOwner}${listCarried ? " (carried)" : ""} vs engine owner=${p.owner}${engCarried ? ` (in tank ${p.inTank})` : p.inTank === -2 ? " (GONE with quitter)" : ""}`);
							}
						});
					}
				}
			}
			BoloGame.apply_record(s, r, null, null);
		}
	} catch (err) {
		S.corrupt.push(`${rel}: engine pass failed: ${err.message}`);
	}
}

let n = 0;
for (const f of walk(ROOT)) {
	scanFile(f);
	if (++n % 200 === 0) console.error(`  ...${n} files examined`);
}

const list = (arr, cap = SAMPLE_CAP) => arr.length ? arr.slice(0, cap).map(x => "    " + x).join("\n") + (arr.length > cap ? `\n    ...and ${arr.length - cap} more` : "") : "    (none)";

console.log(`
==================== Bolo corpus scan ====================
root: ${ROOT}
log files: ${S.files} (${(S.bytes / 1048576).toFixed(1)} MiB, ${S.records.toLocaleString()} records) | non-logs skipped: ${S.notLogs} | unreadable: ${S.unreadable}
longest log: ${S.longest.records.toLocaleString()} records (${S.longest.file})
header versions: ${JSON.stringify(S.versions)}

--- parser health ---
files with warnings: ${S.warningFiles} (${S.warnings} warnings total)
${list(S.warningSamples)}
hard parse failures / engine failures:
${list(S.corrupt)}
truncated (cut mid-record): ${S.truncatedFiles} files
defective (no game_info near start): ${S.defective.length}
${list(S.defective, 6)}
time-tag rollovers: ${S.rollovers.length}
${list(S.rollovers, 6)}

--- never-before-seen opcodes ---
b=2 (towed base) records: ${S.b2Records} ${S.b2Files.length ? "in:\n" + list(S.b2Files, 6) : ""}
attached-log (T=F) records: ${S.attachedLogs} ${S.attachedFiles.length ? "in:\n" + list(S.attachedFiles, 6) : ""}
missiles: ${S.missiles} | FD/FE nops: ${S.nops} | base tows: ${S.baseTows}
${S.oddFiles.length ? "  odd-opcode files:\n" + list(S.oddFiles, 6) : ""}
F1 history subtypes seen: ${JSON.stringify(S.historySubs)}
non-boilerplate history blocks:
${list(S.historySamples)}
FFF0 quit field lengths: ${JSON.stringify(S.quitFieldLens)}

--- ownership evidence ---
repairs: friendly ${S.friendlyRepairs}, neutral ${S.neutralRepairs}, HOSTILE:
${list(S.hostileRepairs)}
alliance_leave events: ${S.allianceLeaves} ${S.leaveFiles.length ? "in:\n" + list(S.leaveFiles, 8) : ""}
mid-game pill-list restatements (ownership oracle): ${S.midGamePillLists} (${S.oracleChecks} pill checks)
oracle mismatches (engine ownership wrong):
${list(S.oracleMismatches, SAMPLE_CAP * 2)}
==========================================================
`);
