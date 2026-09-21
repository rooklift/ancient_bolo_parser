#!/usr/bin/env node
/* Re-derive the figures in docs/pillbox_shell_algorithm.md, "Why it must be
 * this", against docs/pillbox-shell-orbits-compact.json, so that none of them
 * has to be quoted from memory again. Prints: the reproduction check, the
 * per-entry uniqueness of the recovered sine table, the tallies for the
 * round(64*sin) and trunc(64*sin) velocity tables in every counting that
 * has been used, and the best single amplitude + phase + uniform rounding
 * fit, counted both by orbit and by axis component.
 *
 * Usage:
 *   node tools/measure-pillbox-orbit-alternatives.cjs
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DATA = JSON.parse(fs.readFileSync(
	path.join(ROOT, "docs", "pillbox-shell-orbits-compact.json"), "utf8"));
const BY_BRADIAN = new Map(DATA.map(orbit => [orbit.bradian, orbit]));
const TWO_PI = 2 * Math.PI;

function make_table(peak) {
	let table = [];
	for (let i = 0; i < 256; i++) {
		let half = i & 0x7f;
		let quarter = half <= 64 ? half : 128 - half;
		let magnitude = Math.min(peak, Math.trunc(128 * Math.sin(quarter * TWO_PI / 256)));
		table.push(i < 128 ? magnitude : -magnitude);
	}
	return table;
}

function simulate(table, bradian) {
	let scale = (direction, distance) => (table[direction & 0xff] * distance + 64) >> 7;
	let opposite = (bradian + 192) & 0xff;
	let x = scale(bradian, 128);
	let y = scale(opposite, 128);
	let velocity_x = scale(bradian, 64);
	let velocity_y = scale(opposite, 64);
	let positions = [];
	for (let step = 0; step < 32; step++) {
		positions.push([x >> 4, y >> 4]);
		x += velocity_x;
		y += velocity_y;
	}
	return {
		bradian,
		coarse_direction: ((bradian + 8) >> 4) & 0x0f,
		terminal: [x >> 4, y >> 4],
		positions,
	};
}

function same_orbit(a, b) {
	if (a.bradian !== b.bradian || a.coarse_direction !== b.coarse_direction) return false;
	if (a.terminal[0] !== b.terminal[0] || a.terminal[1] !== b.terminal[1]) return false;
	if (a.positions.length !== b.positions.length) return false;
	for (let i = 0; i < a.positions.length; i++) {
		if (a.positions[i][0] !== b.positions[i][0] || a.positions[i][1] !== b.positions[i][1]) return false;
	}
	return true;
}

function reproduces(table) {
	return DATA.every(orbit => same_orbit(simulate(table, orbit.bradian), orbit));
}

const TABLE = make_table(127);
let velocity = entry => (TABLE[entry] + 1) >> 1;

// 1. Reproduction, under both candidate peaks (the file reads odd entries only).
for (let peak of [128, 127]) {
	console.log(`reproduction with peak ${peak}: ${reproduces(make_table(peak)) ? "all 128 orbits bit-exact" : "MISMATCH"}`);
}

// 2. The "sum" sentence, and the real per-entry uniqueness argument.
console.log(`bradian 1: SIN = ${TABLE[1]}, velocity = ${velocity(1)}, sum = ${TABLE[1] + velocity(1)} (not SIN)`);
let unique = 0;
let exceptions = [];
for (let entry = 1; entry < 256; entry += 2) {
	// SIN[entry] is read as the X lookup of bradian `entry` and as the Y lookup
	// of the bradian whose (bradian + 192) & 255 is `entry`.
	let readers = [entry, (entry + 64) & 0xff];
	let fits = [];
	for (let value = -128; value <= 127; value++) {
		let table = TABLE.slice();
		table[entry] = value;
		if (readers.every(bradian => same_orbit(simulate(table, bradian), BY_BRADIAN.get(bradian)))) {
			fits.push(value);
		}
	}
	if (fits.length === 1 && fits[0] === TABLE[entry]) unique++;
	else exceptions.push({ entry, fits });
}
console.log(`odd entries pinned to a single value, equal to trunc(128 * sin): ${unique} of 128` +
	(exceptions.length ? `; exceptions ${JSON.stringify(exceptions)}` : ""));

// 3. Tallies for alternative velocity tables. Each odd entry feeds two
// components (one orbit's vx, another's vy), so "components wrong" is twice
// "odd entries wrong". The whole-table count includes the even entries the
// file never reads, and depends on the peak through SIN[64] and SIN[192].
const ROUNDINGS = {
	round: Math.round,
	trunc: Math.trunc,
	floor: Math.floor,
	ceil: Math.ceil,
};
for (let name of ["round", "trunc"]) {
	let rule = ROUNDINGS[name];
	let odd_wrong = 0;
	for (let entry = 1; entry < 256; entry += 2) {
		if (rule(64 * Math.sin(entry * TWO_PI / 256)) !== velocity(entry)) odd_wrong++;
	}
	let whole = {};
	for (let peak of [127, 128]) {
		let table = make_table(peak);
		let wrong = 0;
		for (let entry = 0; entry < 256; entry++) {
			if (rule(64 * Math.sin(entry * TWO_PI / 256)) !== ((table[entry] + 1) >> 1)) wrong++;
		}
		whole[peak] = wrong;
	}
	console.log(`${name}(64 * sin) velocity table: ${odd_wrong} of 128 odd entries wrong, ` +
		`${odd_wrong * 2} of 256 components wrong; over the whole 256-entry table ` +
		`${whole[128]} entries differ with peak 128, ${whole[127]} with peak 127`);
}

// 4. One amplitude, one phase, one uniform rounding rule for both components.
// Scored two ways: orbits with both components right (of 128), and axis
// components right (of 256, and per axis of 128).
const PHASES = [];
for (let phase = -1; phase <= 1.0001; phase += 0.02) PHASES.push(+phase.toFixed(2));
for (let [name, rule] of Object.entries(ROUNDINGS)) {
	let best_orbits = { orbits: -1 };
	let best_components = { components: -1 };
	for (let phase of PHASES) {
		let sines = [];
		let cosines = [];
		for (let bradian = 1; bradian < 256; bradian += 2) {
			let theta = (bradian + phase) * TWO_PI / 256;
			sines.push(Math.sin(theta));
			cosines.push(Math.cos(theta));
		}
		for (let amplitude = 56; amplitude <= 72.0001; amplitude += 0.01) {
			let orbits = 0;
			let x_right = 0;
			let y_right = 0;
			for (let i = 0; i < 128; i++) {
				let bradian = 2 * i + 1;
				let vx_ok = rule(amplitude * sines[i]) === velocity(bradian);
				let vy_ok = rule(-amplitude * cosines[i]) === velocity((bradian + 192) & 0xff);
				if (vx_ok) x_right++;
				if (vy_ok) y_right++;
				if (vx_ok && vy_ok) orbits++;
			}
			let components = x_right + y_right;
			if (orbits > best_orbits.orbits) {
				best_orbits = { orbits, amplitude: +amplitude.toFixed(2), phase };
			}
			if (components > best_components.components) {
				best_components = { components, x_right, y_right, amplitude: +amplitude.toFixed(2), phase };
			}
		}
	}
	console.log(`uniform ${name}: best by orbit ${JSON.stringify(best_orbits)}; ` +
		`best by component ${JSON.stringify(best_components)}`);
}

// 5. The bradian-63 argument: which rules can give vx = 64 and vy = -1 at once.
{
	let theta = 63 * TWO_PI / 256;
	for (let [name, rule] of Object.entries(ROUNDINGS)) {
		let amplitudes = [];
		for (let amplitude = 40; amplitude <= 80.0001; amplitude += 0.01) {
			if (rule(amplitude * Math.sin(theta)) === 64 && rule(-amplitude * Math.cos(theta)) === -1) {
				amplitudes.push(amplitude);
			}
		}
		let range = amplitudes.length ?
			`amplitudes ${amplitudes[0].toFixed(2)}..${amplitudes[amplitudes.length - 1].toFixed(2)}` :
			"no amplitude";
		console.log(`bradian 63 (vx 64, vy -1) under uniform ${name}: ${range}`);
	}
}
