#!/usr/bin/env node
/* Where does a log's clock start?
 *
 * The four-byte time tag on every record is the recording machine's
 * clock, and only differences within a log are meaningful. The tag a log
 * OPENS with still says something: it is that machine's clock at the
 * moment logging began, so across a corpus it is the distribution of
 * machine uptime, and across one recorder's evening it advances with the
 * wall clock. FORMAT.md once read the initial value as the Mac's
 * TickCount(), a 60/s counter; the rate is measured here instead.
 *
 * For every log: the first record's time tag, the last one's, the game
 * info's host address and start time. Then:
 *
 *   SPREAD    percentiles of the first tag, and a histogram of it read
 *             as uptime at 50 ticks per second.
 *   ORDER     for consecutive logs of one day (the leading digits of the
 *             file name), whether the tag went up or down: a recorder
 *             that stayed up all evening goes up every time.
 *   RATE      for same-day pairs whose game info names the same host
 *             an hour or more apart, the tag's advance divided by the
 *             start time's advance, in ticks per second. Logging starts
 *             some way into each game, so single pairs are noisy; the
 *             quartiles over many are not.
 *   WRAP      logs whose tag passes 2^32 inside the file.
 *
 * Usage: node tools/measure-first-tag.cjs [file | directory ...]
 * With no argument the corpus root from corpus.json / BOLO_CORPUS is
 * read. Each directory given is reported on its own, numbered in the
 * order given, then everything together. Log names print through
 * replay_label (tools/corpus.cjs), and directories are not named at
 * all, since a corpus holder's name is no more the repository's to
 * carry than a player's. */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const BoloLog = require(path.join(__dirname, "..", "viewer", "logparse.js"));
const { corpus_root, replay_label } = require("./corpus.cjs");

const TICKS_PER_SECOND = 50;
const TICKS_PER_HOUR = TICKS_PER_SECOND * 3600;

const BINS = [
	["under 30 min", 0.5], ["30 min to 1 h", 1], ["1 to 2 h", 2], ["2 to 4 h", 4],
	["4 to 8 h", 8], ["8 to 24 h", 24], ["1 to 3 days", 72], ["3 to 7 days", 168],
	["1 to 4 weeks", 720], ["over 4 weeks", Infinity],
];

function walk(target, out) {
	let stat = fs.statSync(target);
	if (stat.isDirectory()) {
		for (let name of fs.readdirSync(target).sort()) walk(path.join(target, name), out);
	} else if (!/\.(txt|md|json)$/i.test(target)) {
		out.push(target);
	}
	return out;
}

function read_log(file) {
	let bytes = new Uint8Array(fs.readFileSync(file));
	let first = null;
	let last = null;
	for (let raw of BoloLog.rawRecords(bytes)) {
		if (first === null) first = raw.time;
		last = raw.time;
	}
	if (first === null) return null;
	let info = null;
	for (let rec of BoloLog.records(bytes)) {
		info = rec.subpackets.find(s => s.type === "game_info");
		if (info) break;
	}
	let day = path.basename(file).match(/^\D*(\d{6,8})/);
	return {
		label: replay_label(file),
		name: path.basename(file),
		day: day ? day[1] : null,
		first,
		last,
		host: info ? info.hostIp : null,
		/* the start time is compared only between classic hosts, whose
		 * epoch is the same; a nuBolo host counts from 2001 */
		start: info && !info.nubolo ? info.startTimeMac : null,
	};
}

function percentile(sorted, p) {
	return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function hours(ticks) {
	let h = ticks / TICKS_PER_HOUR;
	return h < 1 ? h.toFixed(2) : h.toFixed(1);
}

function report(title, logs) {
	if (!logs.length) return;
	let firsts = logs.map(l => l.first).sort((a, b) => a - b);
	console.log(`\n== ${title}: ${logs.length} logs`);
	console.log(`first tag, ticks: min ${firsts[0]}  p5 ${percentile(firsts, 0.05)}  p25 ${percentile(firsts, 0.25)}  ` +
		`median ${percentile(firsts, 0.5)}  p75 ${percentile(firsts, 0.75)}  p95 ${percentile(firsts, 0.95)}  max ${firsts[firsts.length - 1]}`);
	console.log(`as uptime at ${TICKS_PER_SECOND}/s: min ${hours(firsts[0])} h  p25 ${hours(percentile(firsts, 0.25))} h  ` +
		`median ${hours(percentile(firsts, 0.5))} h  p75 ${hours(percentile(firsts, 0.75))} h  max ${hours(firsts[firsts.length - 1])} h`);

	let counts = BINS.map(() => 0);
	for (let t of firsts) {
		let h = t / TICKS_PER_HOUR;
		counts[BINS.findIndex(([, upper]) => h < upper)]++;
	}
	console.log("uptime histogram:");
	for (let i = 0; i < BINS.length; i++) {
		console.log(`  ${BINS[i][0].padEnd(14)} ${String(counts[i]).padStart(5)}`);
	}
	console.log(`lowest five: ${firsts.slice(0, 5).join(" ")}`);
	console.log(`tag wraps past 2^32 inside the log: ${logs.filter(l => l.last < l.first).length}`);

	/* consecutive logs of one day, in name order */
	let by_name = logs.slice().sort((a, b) => a.name.localeCompare(b.name));
	let up = 0;
	let down = 0;
	let rates = [];
	for (let i = 1; i < by_name.length; i++) {
		let a = by_name[i - 1];
		let b = by_name[i];
		if (!a.day || a.day !== b.day) continue;
		if (b.first > a.first) up++; else down++;
		if (a.start && b.start && a.host === b.host && b.start - a.start >= 3600 && b.first > a.first) {
			rates.push((b.first - a.first) / (b.start - a.start));
		}
	}
	console.log(`same-day consecutive logs: tag went up ${up}, down ${down}`);
	rates.sort((a, b) => a - b);
	if (rates.length) {
		console.log(`ticks per second between same-host logs an hour or more apart (${rates.length} pairs): ` +
			`p10 ${percentile(rates, 0.1).toFixed(1)}  p25 ${percentile(rates, 0.25).toFixed(1)}  ` +
			`median ${percentile(rates, 0.5).toFixed(1)}  p75 ${percentile(rates, 0.75).toFixed(1)}  p90 ${percentile(rates, 0.9).toFixed(1)}`);
	}
}

function main() {
	let targets = process.argv.slice(2);
	if (!targets.length) targets = [corpus_root()];
	let all = [];
	for (let [i, target] of targets.entries()) {
		let logs = [];
		for (let file of walk(path.resolve(target), [])) {
			try {
				let log = read_log(file);
				if (log) logs.push(log);
			} catch (error) {
				console.error(`skipping ${replay_label(file)}: ${error.message}`);
			}
		}
		if (targets.length > 1) report(`corpus ${i + 1}`, logs);
		all.push(...logs);
	}
	report(targets.length > 1 ? "all together" : "corpus", all);
}

main();
