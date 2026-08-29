/* Pillbox shell trajectories reconstructed from Bolo's integer simulation.
 * This module is deliberately independent of the viewer for now. */
"use strict";
(function () {

/* Magnitude-truncated values of 128 * sin(angle) for the first quadrant.
 * Reflections in sine_value preserve the signed lookup value before SCALE's
 * arithmetic shift, which is significant for negative components. */
const QUARTER_SINE = Array.from({ length: 65 }, (_, bradian) =>
	Math.trunc(128 * Math.sin(bradian * 2 * Math.PI / 256)));

function sine_value(bradian) {
	let direction = bradian & 0xff;
	let half = direction & 0x7f;
	let quarter = half <= 64 ? half : 128 - half;
	let magnitude = QUARTER_SINE[quarter];
	return direction < 128 ? magnitude : -magnitude;
}

function scale(bradian, distance) {
	/* JavaScript's >> is a signed arithmetic shift, matching the C algorithm.
	 * Division would truncate negative values toward zero and give a different
	 * result. These operands are also safely inside the signed 32-bit range. */
	return (sine_value(bradian) * distance + 64) >> 7;
}

function internal_position_at(bradian, step) {
	let opposite = (bradian + 192) & 0xff;
	return [
		scale(bradian, 128) + step * scale(bradian, 64),
		scale(opposite, 128) + step * scale(opposite, 64),
	];
}

function create_pillbox_shell_orbits() {
	let orbits = [];
	for (let bradian = 1; bradian < 256; bradian += 2) {
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

		orbits.push({
			bradian,
			coarse_direction: ((bradian + 8) >> 4) & 0x0f,
			terminal: [x >> 4, y >> 4],
			positions,
		});
	}
	return orbits;
}

const PillboxShellOrbits = {
	create_pillbox_shell_orbits,
	internal_position_at,
	orbits: create_pillbox_shell_orbits(),
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = PillboxShellOrbits;
} else {
	window.PillboxShellOrbits = PillboxShellOrbits;
}

})();
