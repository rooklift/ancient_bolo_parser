"use strict";

let fs = require("node:fs");
let BoloLog = require("../viewer/logparse.js");

let bytes = new Uint8Array(fs.readFileSync("fixtures/n20021018.2"));
let records = [...BoloLog.records(bytes)];
let impact_codes = new Set([1, 2, 6, 7, 8, 11]);
let deaths = [];
let positions = Array.from({ length: 16 }, () => null);
let dying_positions = Array.from({ length: 16 }, () => []);

for (let [record_index, record] of records.entries()) {
	for (let subpacket of record.subpackets) {
		if (subpacket.type !== "tank_position") continue;
		positions[record.player] = subpacket;
		if (subpacket.dying) {
			dying_positions[record.player].push({
				time: record.time,
				x: subpacket.x,
				y: subpacket.y,
			});
		}
	}
	for (let subpacket of record.subpackets) {
		if (subpacket.type !== "tank_death") continue;
		deaths.push({
			record_index,
			time: record.time,
			player: record.player,
			position: positions[record.player],
			code: subpacket.code,
		});
	}
}

for (let death of deaths) {
	death.positions = dying_positions[death.player].filter(position =>
		Math.abs(position.time - death.time) <= 100);
	if (death.position) {
		death.positions.push({
			time: death.time,
			x: death.position.x,
			y: death.position.y,
		});
	}
}

let impacts = [];
let counts = new Map();
let death_record_summaries = [];
for (let [record_index, record] of records.entries()) {
	if (record.subpackets.some(subpacket => subpacket.type === "tank_death")) {
		death_record_summaries.push({
			record_index,
			time: record.time,
			player: record.player,
			subpackets: record.subpackets.filter(subpacket =>
				["tank_death", "tank_hit", "explosion", "shell_falls", "shells"]
					.includes(subpacket.type)),
		});
	}
	for (let subpacket of record.subpackets) {
		if (subpacket.type !== "explosion" || !impact_codes.has(subpacket.code)) {
			continue;
		}
		counts.set(subpacket.code, (counts.get(subpacket.code) ?? 0) + 1);
		let nearby_deaths = deaths.filter(death =>
			death.player === record.player &&
			Math.abs(record.time - death.time) <= 100 &&
			death.positions.some(position =>
				Math.max(Math.abs(position.x - subpacket.x),
					Math.abs(position.y - subpacket.y)) <= 1));
		if (nearby_deaths.length) {
			impacts.push({
				record_index,
				time: record.time,
				player: record.player,
				code: subpacket.code,
				x: subpacket.x,
				y: subpacket.y,
				deaths: nearby_deaths.map(death => ({
					delta: record.time - death.time,
					death_record_index: death.record_index,
					death_code: death.code,
				})),
			});
		}
	}
}

console.log(JSON.stringify({
	counts: Object.fromEntries(counts),
	death_count: deaths.length,
	death_records_with_impact_codes: death_record_summaries.filter(summary =>
		summary.subpackets.some(subpacket => subpacket.type === "explosion" &&
			impact_codes.has(subpacket.code))),
	nearby_death_impact_count: impacts.length,
	nearby_death_impacts: impacts,
}, null, "\t"));
