/* Render-only motion reconstruction and sampling for Bolo replays.
 * No DOM use — also loadable in node for tests. */
"use strict";
(function () {

const PillboxShellOrbits = typeof module !== "undefined" && module.exports
	? require("./pillbox_shell_orbits.js") : window.PillboxShellOrbits;

const TICKS_PER_SECOND = 50;
/* Moving objects normally restate at about four packets per second. Beyond
 * half a second the path between two positions is no longer trustworthy:
 * hold the last known point instead of drawing a made-up line through lag. */
const MAX_POSITION_INTERPOLATION_TICKS = TICKS_PER_SECOND / 2;
/* Shell trajectories are simpler than tank and LGM motion, so trustworthy
 * restatements can be joined across a full second of packet lag. Impact
 * records remain capped at the ordinary interpolation window below: their
 * event time may legitimately follow the shell's inferred arrival. */
const MAX_SHELL_INTERPOLATION_TICKS = TICKS_PER_SECOND;
const MAX_LGM_TANK_ENTRY_DISTANCE_PIXELS = 32;
/* Shells travel at 2 px/tick. Their logged direction is only the 4-bit
 * version of a presumably finer internal heading, so it defines a sector,
 * not an exact vector. Packet timestamps and simulation updates can differ
 * by a few pixels; matching remains deliberately conservative. */
const SHELL_SPEED_PIXELS_PER_TICK = 2;
const SHELL_MATCH_ERROR_PIXELS = 8;
const SHELL_BOX_GRAZE_TOLERANCE_PIXELS = 1;
/* The exact pill orbit combined with our linearly reconstructed tank path
 * can miss an authoritative tank hit by 1.57px. Allow two pixels for integer
 * position quantisation and uncertainty in the tank's between-packet path;
 * this is not a claim about Bolo's original collision shape. */
const SHELL_TANK_HIT_TOLERANCE_PIXELS = 2;
const SHELL_DIRECTION_TOLERANCE = Math.PI / 8;
const SHELL_MATCH_MARGIN = 3;
const SHELL_EQUIVALENT_ENDPOINT_PIXELS = 2;
const SHELL_EQUIVALENT_TIME_TICKS = 1;
const SHELL_TANK_BIRTH_ERROR_PIXELS = 16;
const PILLBOX_ORBITS = PillboxShellOrbits.orbits;
const PILLBOX_ORBITS_BY_BRADIAN = new Map(PILLBOX_ORBITS.map(orbit =>
	[orbit.bradian, orbit]));
const PILLBOX_ORBITS_BY_DIRECTION = Array.from({ length: 16 }, () => []);
for (let orbit of PILLBOX_ORBITS) {
	PILLBOX_ORBITS_BY_DIRECTION[orbit.coarse_direction].push(orbit);
}

/* Standalone map/node records carry no player state or motion. */
const MAP_NODE_TYPES = new Set([
	"node_id", "map_run", "map_terrain_request", "map_header_request",
	"game_info", "pillbox_list", "base_list", "start_list", "history",
	"attached_log",
]);

/* Append one shell-list subpacket as absolute positions. Offsets are
 * chained, and the direction nibble in the list header applies to EVERY
 * shell in the list. position_time lets render-only interpolation verify
 * that a reconstructed state still belongs to the expected snapshot. */
function append_shell_list(shells, sub, position_time) {
	let direction = sub.direction ?? sub.shells[0].direction;
	let previous = null;
	for (let i = 0; i < sub.shells.length; i++) {
		let shell = sub.shells[i];
		let pixel_x, pixel_y;
		if (i === 0) {
			pixel_x = shell.x * 16 + (shell.pixel & 0x0f);
			pixel_y = shell.y * 16 + (shell.pixel >> 4);
		} else {
			pixel_x = previous.pixel_x + shell.offsetX;
			pixel_y = previous.pixel_y + shell.offsetY;
		}
		previous = { pixel_x, pixel_y };
		shells.push({
			x: (pixel_x >> 4) & 0xff, y: (pixel_y >> 4) & 0xff,
			px: pixel_x & 0x0f, py: pixel_y & 0x0f,
			direction, position_time,
		});
	}
}

function add_shell_point_terminal(terminals, rec, x, y, px, py,
	direction = null, details = null) {
	if (!terminals) return;
	let terminal = {
		record: rec, type: "point", pixel_x: x * 16 + px,
		pixel_y: y * 16 + py, direction, terminal: true,
	};
	if (details) Object.assign(terminal, details);
	terminals.push(terminal);
	return terminal;
}

/* A box is expressed in centred world coordinates. Positioned sprites use
 * their logged pixel coordinate as the top-left of a 16px box; fixed map
 * objects and terrain tiles use their tile's corresponding 16px box. */
function add_shell_box_terminal(terminals, rec, pixel_x, pixel_y,
	direction = null, details = null) {
	if (!terminals) return;
	let terminal = {
		record: rec, type: "box", min_x: pixel_x, min_y: pixel_y,
		max_x: pixel_x + 16, max_y: pixel_y + 16, direction,
		terminal: true,
	};
	if (details) Object.assign(terminal, details);
	terminals.push(terminal);
	return terminal;
}

/* Build the position tracks used only for drawing. `continuous` describes
 * the path from the preceding entry to this one. A death/join state, a tank
 * death, or a quit makes the next position a new path; in particular this
 * prevents interpolation towards the bogus far-away positions sometimes
 * carried by ghost-split quit records. */
function build_tank_positions(records) {
	let tracks = Array.from({ length: 16 }, () => []);
	let active = Array.from({ length: 16 }, () => false);

	for (let rec of records) {
		let pl = rec.player;
		let map_node_only = rec.subpackets.length > 0 &&
			rec.subpackets.every(sub => MAP_NODE_TYPES.has(sub.type));
		let breaks_path = !map_node_only && (rec.tankStatus === 0x07 ||
			rec.subpackets.some(sub => sub.type === "tank_death" || sub.type === "quit"));

		for (let sub of rec.subpackets) {
			if (sub.type !== "tank_position") continue;
			tracks[pl].push({
				time: rec.time,
				pixel_x: sub.x * 16 + sub.pixelX,
				pixel_y: sub.y * 16 + sub.pixelY,
				continuous: active[pl] && !sub.dying && !breaks_path,
			});
			active[pl] = !sub.dying && !breaks_path;
		}
		if (breaks_path) active[pl] = false;
	}

	return tracks;
}

/* Tank direction is live on records which do not contain a position too, so
 * it needs a track of its own. `continuous` has the same meaning as it does
 * for position tracks: it describes the span ending at this entry. */
function build_tank_directions(records) {
	let tracks = Array.from({ length: 16 }, () => []);
	let active = Array.from({ length: 16 }, () => false);

	for (let rec of records) {
		let player = rec.player;
		let map_node_only = rec.subpackets.length > 0 &&
			rec.subpackets.every(sub => MAP_NODE_TYPES.has(sub.type));
		let breaks_path = !map_node_only && (rec.tankStatus === 0x07 ||
			rec.subpackets.some(sub => sub.type === "tank_death" || sub.type === "quit"));
		let position = rec.subpackets.find(sub => sub.type === "tank_position");
		let direction = null;
		let dying = false;

		if (position) {
			direction = position.direction;
			dying = position.dying;
		} else if (active[player] && rec.tankStatus !== 0x0f &&
			rec.tankStatus !== 0x07 && !(rec.tankStatus & 0x08)) {
			direction = rec.tankDir;
		}

		if (direction !== null) {
			tracks[player].push({
				time: rec.time,
				direction,
				continuous: active[player] && !dying && !breaks_path,
			});
			active[player] = !dying && !breaks_path;
		}
		if (breaks_path) active[player] = false;
	}

	return tracks;
}

/* LGM paths end when the man enters the tank, dies, or quits. Parachuting
 * and walking are separate paths: interpolating across touchdown would
 * invent motion between two different object states. Unlike the anomalous
 * tank position on a quit record, an LGM death position is trustworthy, so
 * the final walking span may run right up to the death event. */
function build_lgm_positions(records) {
	let tracks = Array.from({ length: 16 }, () => []);
	let active = Array.from({ length: 16 }, () => false);
	let parachuting = Array.from({ length: 16 }, () => false);
	let tanks = Array.from({ length: 16 }, () => null);

	for (let rec of records) {
		let pl = rec.player;
		let map_node_only = rec.subpackets.length > 0 &&
			rec.subpackets.every(sub => MAP_NODE_TYPES.has(sub.type));
		let enters_tank = rec.tankStatus !== 0x0f && !map_node_only &&
			(rec.status & 0x0c) === 0;
		let quits = rec.subpackets.some(sub => sub.type === "quit");

		for (let sub of rec.subpackets) {
			if (sub.type !== "tank_position") continue;
			tanks[pl] = {
				pixel_x: sub.x * 16 + sub.pixelX,
				pixel_y: sub.y * 16 + sub.pixelY,
			};
		}

		/* A status change to "in tank" supplies the missing endpoint of the
		 * walking path. Logs consistently put the last man position within two
		 * squares of the tank, so animate to the tank instead of holding the man
		 * at his last restatement. Delayed status packets are visually capped by
		 * the normal half-second interpolation window below. */
		if (enters_tank && active[pl] && !parachuting[pl] && tanks[pl]) {
			let last = tracks[pl][tracks[pl].length - 1];
			let dx = tanks[pl].pixel_x - last.pixel_x;
			let dy = tanks[pl].pixel_y - last.pixel_y;
			if (dx * dx + dy * dy <= MAX_LGM_TANK_ENTRY_DISTANCE_PIXELS ** 2) {
				last.tank_entry = {
					time: rec.time,
					pixel_x: tanks[pl].pixel_x,
					pixel_y: tanks[pl].pixel_y,
				};
			}
		}
		if (enters_tank) active[pl] = false;

		for (let sub of rec.subpackets) {
			if (sub.type !== "lgm_position" && sub.type !== "parachute_position") continue;
			let is_parachute = sub.type === "parachute_position";
			tracks[pl].push({
				time: rec.time,
				pixel_x: sub.x * 16 + sub.pixelX,
				pixel_y: sub.y * 16 + sub.pixelY,
				parachute: is_parachute,
				continuous: active[pl] && parachuting[pl] === is_parachute && !quits,
			});
			active[pl] = !quits;
			parachuting[pl] = is_parachute;
		}

		let dies = rec.subpackets.some(sub =>
			sub.type === "lgm_death" || sub.type === "pill_dumped_by_dead_lgm");
		if (enters_tank || dies || quits) active[pl] = false;
	}

	return tracks;
}

function track_pixel_at(track, tick) {
	let lo = 0, hi = track.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (track[mid].time <= tick) lo = mid + 1;
		else hi = mid;
	}
	let current = track[lo - 1];
	if (!current) return null;
	let next = track[lo];
	let duration = next ? next.time - current.time : 0;
	if (!next || !next.continuous || duration <= 0 ||
		duration > MAX_POSITION_INTERPOLATION_TICKS) return current;
	let amount = (tick - current.time) / duration;
	return {
		pixel_x: current.pixel_x + (next.pixel_x - current.pixel_x) * amount,
		pixel_y: current.pixel_y + (next.pixel_y - current.pixel_y) * amount,
	};
}

function shell_match_cost(previous, next, duration) {
	if (previous.direction !== next.direction) return null;
	let orbit_states = pillbox_shell_successor_states(previous, next);
	if (orbit_states && !orbit_states.length) return null;

	let delta_x = next.pixel_x - previous.pixel_x;
	let delta_y = next.pixel_y - previous.pixel_y;
	let distance = Math.hypot(delta_x, delta_y);
	let expected_distance = duration * SHELL_SPEED_PIXELS_PER_TICK;
	let distance_error = Math.abs(distance - expected_distance);
	if (distance_error > SHELL_MATCH_ERROR_PIXELS || distance === 0) return null;
	if (orbit_states) {
		return { cost: distance_error, pillbox_orbit_states: orbit_states };
	}

	let heading_x = previous.heading_x;
	let heading_y = previous.heading_y;
	if (heading_x === undefined) {
		let angle = previous.direction * Math.PI / 8;
		heading_x = Math.sin(angle);
		heading_y = -Math.cos(angle);
	}
	let forward = delta_x * heading_x + delta_y * heading_y;
	let lateral = Math.abs(delta_x * heading_y - delta_y * heading_x);
	if (forward <= 0) return null;
	let angle_error = Math.atan2(lateral, forward);
	if (angle_error > SHELL_DIRECTION_TOLERANCE) return null;

	return {
		cost: distance_error + angle_error * expected_distance,
		pillbox_orbit_states: orbit_states,
	};
}

/* A pill shell's logged coordinate is one of the integer points in its
 * measured orbit. Near the muzzle several fine directions share a point,
 * so retain every compatible state and let later restatements narrow the
 * set. `undefined` means this shell predates orbit-backed identification;
 * an empty array means a proposed continuation is physically impossible. */
function pillbox_orbit_states_at(direction, pixel_x, pixel_y) {
	let states = [];
	for (let orbit of PILLBOX_ORBITS_BY_DIRECTION[direction]) {
		for (let step = 0; step < orbit.positions.length; step++) {
			let position = orbit.positions[step];
			if (position[0] === pixel_x && position[1] === pixel_y) {
				states.push({ bradian: orbit.bradian, step });
			}
		}
	}
	return states;
}

function pillbox_orbit_position(orbit, step) {
	return step < orbit.positions.length ? orbit.positions[step] : orbit.terminal;
}

function pillbox_shell_successor_states(previous, next) {
	if (!previous.pillbox_orbit_states) return undefined;
	let relative_x = next.pixel_x - previous.pillbox_source_x;
	let relative_y = next.pixel_y - previous.pillbox_source_y;
	let states = [];
	for (let previous_state of previous.pillbox_orbit_states) {
		let orbit = PILLBOX_ORBITS_BY_BRADIAN.get(previous_state.bradian);
		for (let step = previous_state.step + 1;
			step < orbit.positions.length; step++) {
			let position = orbit.positions[step];
			if (position[0] === relative_x && position[1] === relative_y) {
				states.push({ bradian: orbit.bradian, step });
			}
		}
	}
	return states;
}

function pillbox_shell_terminal_match(previous, terminal, duration, start_time) {
	if (!previous.pillbox_orbit_states) return undefined;
	let matches = [];
	for (let previous_state of previous.pillbox_orbit_states) {
		let orbit = PILLBOX_ORBITS_BY_BRADIAN.get(previous_state.bradian);
		if (terminal.event_type === "shell_falls") {
			if (previous.pillbox_source_x + orbit.terminal[0] === terminal.pixel_x &&
				previous.pillbox_source_y + orbit.terminal[1] === terminal.pixel_y) {
				matches.push({ bradian: orbit.bradian,
					step: orbit.positions.length, position: orbit.terminal });
			}
			continue;
		}
		/* A restatement can catch a shell already one frame inside the tile
		 * whose collision event follows. Other point terminals must be a later
		 * simulated coordinate. FB range expiry was handled separately above. */
		let first_step = previous_state.step + (terminal.type === "box" ? 0 : 1);
		for (let step = first_step;
			step <= orbit.positions.length; step++) {
			let position = pillbox_orbit_position(orbit, step);
			let pixel_x = previous.pillbox_source_x + position[0];
			let pixel_y = previous.pillbox_source_y + position[1];
			let distance = Math.hypot(pixel_x - previous.pixel_x,
				pixel_y - previous.pixel_y);
			let enters_terminal, hitbox_pixel_x, hitbox_pixel_y;
			if (terminal.type === "point") {
				enters_terminal = pixel_x === terminal.pixel_x &&
					pixel_y === terminal.pixel_y;
			} else {
				let min_x = terminal.min_x, min_y = terminal.min_y;
				/* A tank-hit packet gives the tank's eventual recorded box. The
				 * shell can reach it earlier while the tank is moving, so test this
				 * exact orbit point against the tank track at its arrival time. */
				if (terminal.event_type === "tank_hit" && terminal.tank_track) {
					let arrival_time = start_time +
						distance / SHELL_SPEED_PIXELS_PER_TICK;
					let tank_position = track_pixel_at(terminal.tank_track, arrival_time);
					if (tank_position) {
						min_x = tank_position.pixel_x;
						min_y = tank_position.pixel_y;
					}
					hitbox_pixel_x = min_x;
					hitbox_pixel_y = min_y;
				}
				let tolerance = terminal.event_type === "tank_hit"
					? SHELL_TANK_HIT_TOLERANCE_PIXELS : 0;
				let centre_x = pixel_x + 8;
				let centre_y = pixel_y + 8;
				enters_terminal = centre_x >= min_x - tolerance &&
					centre_x < min_x + 16 + tolerance &&
					centre_y >= min_y - tolerance &&
					centre_y < min_y + 16 + tolerance;
			}
			if (enters_terminal) {
				matches.push({
					bradian: orbit.bradian, step, position, distance,
					hitbox_pixel_x, hitbox_pixel_y,
				});
				break;
			}
		}
	}
	let expected_distance = duration * SHELL_SPEED_PIXELS_PER_TICK;
	for (let match of matches) {
		match.pixel_x = previous.pillbox_source_x + match.position[0];
		match.pixel_y = previous.pillbox_source_y + match.position[1];
		if (match.distance === undefined) {
			match.distance = Math.hypot(match.pixel_x - previous.pixel_x,
				match.pixel_y - previous.pixel_y);
		}
		match.cost = Math.abs(match.distance - expected_distance);
	}
	matches = matches.filter(match =>
		match.distance <= expected_distance + SHELL_MATCH_ERROR_PIXELS);
	if (!matches.length) return null;
	matches.sort((a, b) => a.cost - b.cost);
	let best = matches[0];
	return {
		cost: best.cost,
		pixel_x: best.pixel_x,
		pixel_y: best.pixel_y,
		distance: best.distance,
		graze_distance: 0,
		hitbox_pixel_x: best.hitbox_pixel_x,
		hitbox_pixel_y: best.hitbox_pixel_y,
		pillbox_orbit_states: matches.map(match => ({
			bradian: match.bradian, step: match.step,
		})),
	};
}

/* Intersect the shell centre's learned ray with a tile/object box, returning
 * a shell top-left coordinate. Quantised restatements can put an inferred
 * ray fractionally outside a corner which the authoritative event says it
 * hit, so accept a closest approach of at most one pixel without enlarging
 * the rendered box itself. If the final restatement is already inside the
 * box, use the forward exit rather than manufacturing a zero-length
 * terminal segment. */
function shell_ray_box_endpoint(shell, box) {
	if (shell.heading_x === undefined) return null;
	let origin_x = shell.pixel_x + 8;
	let origin_y = shell.pixel_y + 8;
	let heading_x = shell.heading_x;
	let heading_y = shell.heading_y;
	let heading_length_squared = heading_x * heading_x + heading_y * heading_y;
	if (heading_length_squared <= 1e-18) return null;
	let starts_inside = origin_x > box.min_x && origin_x < box.max_x &&
		origin_y > box.min_y && origin_y < box.max_y;
	let near = -Infinity, far = Infinity;
	let intersects = true;
	for (let axis of [
		[origin_x, heading_x, box.min_x, box.max_x],
		[origin_y, heading_y, box.min_y, box.max_y],
	]) {
		let [origin, heading, minimum, maximum] = axis;
		if (Math.abs(heading) < 1e-9) {
			if (origin < minimum || origin > maximum) intersects = false;
			continue;
		}
		let first = (minimum - origin) / heading;
		let second = (maximum - origin) / heading;
		if (first > second) [first, second] = [second, first];
		near = Math.max(near, first);
		far = Math.min(far, second);
		if (far < near) intersects = false;
	}
	if (intersects) {
		let distance = starts_inside ? far : near;
		if (distance < -1e-9) return null;
		distance = Math.max(0, distance);
		return {
			pixel_x: origin_x + heading_x * distance - 8,
			pixel_y: origin_y + heading_y * distance - 8,
			distance, graze_distance: 0,
		};
	}

	/* A miss is closest either at the ray origin, at a box-boundary crossing,
	 * or at the perpendicular projection of a corner onto the ray. Evaluate
	 * that small complete set and retain the real ray point, rather than an
	 * early intersection with an artificially padded box. */
	let distances = [0];
	for (let [origin, heading, minimum, maximum] of [
		[origin_x, heading_x, box.min_x, box.max_x],
		[origin_y, heading_y, box.min_y, box.max_y],
	]) {
		if (Math.abs(heading) < 1e-9) continue;
		for (let boundary of [minimum, maximum]) {
			let distance = (boundary - origin) / heading;
			if (distance > 0) distances.push(distance);
		}
	}
	for (let corner_x of [box.min_x, box.max_x]) {
		for (let corner_y of [box.min_y, box.max_y]) {
			let distance = (corner_x - origin_x) * heading_x +
				(corner_y - origin_y) * heading_y;
			distance /= heading_length_squared;
			if (distance > 0) distances.push(distance);
		}
	}

	let closest = null;
	for (let distance of distances) {
		let centre_x = origin_x + heading_x * distance;
		let centre_y = origin_y + heading_y * distance;
		let box_x = Math.max(box.min_x, Math.min(box.max_x, centre_x));
		let box_y = Math.max(box.min_y, Math.min(box.max_y, centre_y));
		let graze_distance = Math.hypot(centre_x - box_x, centre_y - box_y);
		if (!closest || graze_distance < closest.graze_distance) {
			closest = {
				pixel_x: centre_x - 8, pixel_y: centre_y - 8,
				distance: distance * Math.sqrt(heading_length_squared),
				graze_distance,
			};
		}
	}
	if (!closest || closest.graze_distance >
		SHELL_BOX_GRAZE_TOLERANCE_PIXELS + 1e-9) return null;
	return closest;
}

function shell_terminal_match(previous, terminal, duration, start_time) {
	if (terminal.direction !== null && terminal.direction !== previous.direction) return null;
	let pillbox_match = pillbox_shell_terminal_match(previous, terminal, duration,
		start_time);
	if (pillbox_match !== undefined) return pillbox_match;
	let expected_distance = duration * SHELL_SPEED_PIXELS_PER_TICK;
	let endpoint, angle_error = 0;
	if (terminal.type === "box") {
		/* A tile/object event supplies timing and bounds, not an aim point.
		 * Without an already learned fine heading, centring the 4-bit sector
		 * would merely disguise a guess as smooth motion. */
		endpoint = shell_ray_box_endpoint(previous, terminal);
		if (!endpoint) return null;
	} else {
		let delta_x = terminal.pixel_x - previous.pixel_x;
		let delta_y = terminal.pixel_y - previous.pixel_y;
		let distance = Math.hypot(delta_x, delta_y);
		if (distance === 0) return null;
		let heading_x = previous.heading_x;
		let heading_y = previous.heading_y;
		if (heading_x === undefined) {
			let angle = previous.direction * Math.PI / 8;
			heading_x = Math.sin(angle);
			heading_y = -Math.cos(angle);
		}
		let forward = delta_x * heading_x + delta_y * heading_y;
		let lateral = Math.abs(delta_x * heading_y - delta_y * heading_x);
		if (forward <= 0) return null;
		angle_error = Math.atan2(lateral, forward);
		if (angle_error > SHELL_DIRECTION_TOLERANCE) return null;
		endpoint = {
			pixel_x: terminal.pixel_x, pixel_y: terminal.pixel_y, distance,
		};
	}
	if (endpoint.distance > expected_distance + SHELL_MATCH_ERROR_PIXELS) return null;
	return {
		cost: Math.abs(endpoint.distance - expected_distance) +
			angle_error * expected_distance + (endpoint.graze_distance || 0),
		pixel_x: endpoint.pixel_x,
		pixel_y: endpoint.pixel_y,
		distance: endpoint.distance,
		graze_distance: endpoint.graze_distance || 0,
	};
}

function same_shell_terminal(first, second) {
	if (first.type !== second.type || first.direction !== second.direction) return false;
	if (first.type === "point") {
		return first.pixel_x === second.pixel_x && first.pixel_y === second.pixel_y;
	}
	return first.min_x === second.min_x && first.min_y === second.min_y &&
		first.max_x === second.max_x && first.max_y === second.max_y;
}

/* An F4 and its impact can both arrive in one restatement even though the
 * shell itself lived entirely between records. Test every fine orbit for an
 * exact point terminal or a discrete shell-centre entry into an object/tile
 * box. The exact firing tick is unknown, so the caller separately limits
 * the result to the interval's maximum travel distance. */
function pillbox_source_terminal_distance(source, terminal) {
	if (terminal.direction !== null && terminal.direction !== source.direction) {
		return null;
	}
	let best = null;
	let origins = [[source.pixel_x, source.pixel_y]];
	if (source.alternate_pixel_x !== undefined) {
		origins.push([source.alternate_pixel_x, source.alternate_pixel_y]);
	}

	for (let [origin_x, origin_y] of origins) {
		for (let orbit of PILLBOX_ORBITS_BY_DIRECTION[source.direction]) {
			for (let step = 0; step <= orbit.positions.length; step++) {
				let position = pillbox_orbit_position(orbit, step);
				let matches = terminal.type === "point"
					? origin_x + position[0] === terminal.pixel_x &&
						origin_y + position[1] === terminal.pixel_y
					: origin_x + position[0] + 8 >= terminal.min_x &&
						origin_x + position[0] + 8 < terminal.max_x &&
						origin_y + position[1] + 8 >= terminal.min_y &&
						origin_y + position[1] + 8 < terminal.max_y;
				if (!matches) continue;
				let distance = Math.hypot(position[0], position[1]);
				if (best === null || distance < best) best = distance;
				break;
			}
		}
	}
	return best;
}

/* Reserve only strict, count-forced impacts for pill shots which have an F4
 * but no shell-list position. Identical terminals are interchangeable, so
 * spare birth capacity may consume part of their multiplicity. Distinct
 * terminal locations are left alone unless their count exactly accounts for
 * the spare births. */
function mark_unseen_pillbox_terminals(source_groups, terminals,
	maximum_distance) {
	let active_groups = source_groups.filter(group =>
		group.capacity > group.assigned);
	let candidates_by_terminal = new Map();
	let candidates_by_group = new Map(active_groups.map(group => [group, []]));
	for (let terminal of terminals) {
		/* Terrain explosions are the directionless event implicated here.
		 * Direction-bearing tank hits already exclude opposing shells, while
		 * broadening this to every object impact needs separate evidence. */
		if (terminal.event_type !== "explosion") continue;
		let candidates = [];
		for (let group of active_groups) {
			let distance = pillbox_source_terminal_distance(group, terminal);
			if (distance === null || distance > maximum_distance) continue;
			candidates.push(group);
			candidates_by_group.get(group).push(terminal);
		}
		candidates_by_terminal.set(terminal, candidates);
	}

	for (let group of active_groups) {
		let remaining = group.capacity - group.assigned;
		let candidates = candidates_by_group.get(group).filter(terminal =>
			candidates_by_terminal.get(terminal).length === 1);
		if (!candidates.length) continue;
		let equivalent = candidates.every(terminal =>
			same_shell_terminal(candidates[0], terminal));
		if (!equivalent && candidates.length !== remaining) continue;
		let count = Math.min(remaining, candidates.length);
		for (let i = 0; i < count; i++) {
			candidates[i].unseen_pillbox_source = true;
			candidates[i].pillbox_source_x = group.pixel_x;
			candidates[i].pillbox_source_y = group.pixel_y;
			candidates[i].pillbox_source_direction = group.direction;
		}
	}
}

function mark_new_pillbox_shells(previous, next) {
	let duration = next.time - previous.time;
	if (duration <= 0 || duration > MAX_POSITION_INTERPOLATION_TICKS) return;
	let maximum_distance = duration * SHELL_SPEED_PIXELS_PER_TICK +
		SHELL_MATCH_ERROR_PIXELS * 2;
	let source_groups = [];
	for (let source of next.pillbox_sources) {
		let group = source_groups.find(item => item.pixel_x === source.pixel_x &&
			item.pixel_y === source.pixel_y && item.direction === source.direction);
		if (group) group.capacity++;
		else source_groups.push({ ...source, capacity: 1, assigned: 0 });
	}

	/* Pill-fire events accumulated in a restatement count newly created
	 * shells. Match them backwards to the firing pill, nearest first. This
	 * keeps older shells out of those anonymous list entries and recovers the
	 * full heading from the source-to-position line. A shot which has already
	 * hit something simply has no candidate and leaves capacity unused. */
	let candidates = [];
	for (let group of source_groups) {
		for (let origin of [{
			pixel_x: group.pixel_x, pixel_y: group.pixel_y, fallback: false,
		}, {
			pixel_x: group.alternate_pixel_x,
			pixel_y: group.alternate_pixel_y,
			fallback: true,
		}]) {
			if (origin.pixel_x === undefined) continue;
			for (let shell of next.shells) {
				if (shell.direction !== group.direction) continue;
				let delta_x = shell.pixel_x - origin.pixel_x;
				let delta_y = shell.pixel_y - origin.pixel_y;
				let distance = Math.hypot(delta_x, delta_y);
				if (distance > maximum_distance) continue;
				let orbit_states = pillbox_orbit_states_at(group.direction,
					delta_x, delta_y);
				if (!orbit_states.length) continue;
				candidates.push({
					group, shell, distance, delta_x, delta_y,
					pixel_x: origin.pixel_x, pixel_y: origin.pixel_y,
					fallback: origin.fallback, orbit_states,
				});
			}
		}
	}
	/* Direction-zero F4 has a known n/n-1 ambiguity. Prefer the named pill,
	 * but let the adjacent fallback fill capacity when its candidate fails. */
	candidates.sort((a, b) => a.fallback - b.fallback ||
		a.distance - b.distance);
	let assigned_shells = new Set();
	for (let candidate of candidates) {
		if (candidate.group.assigned >= candidate.group.capacity ||
			assigned_shells.has(candidate.shell)) continue;
		candidate.group.assigned++;
		assigned_shells.add(candidate.shell);
		candidate.shell.starts_at_pillbox = true;
		candidate.shell.pillbox_source_x = candidate.pixel_x;
		candidate.shell.pillbox_source_y = candidate.pixel_y;
		candidate.shell.pillbox_source_distance = candidate.distance;
		candidate.shell.heading_origin_x = candidate.pixel_x;
		candidate.shell.heading_origin_y = candidate.pixel_y;
		candidate.shell.pillbox_orbit_states = candidate.orbit_states;
		if (candidate.distance > 0) {
			candidate.shell.heading_x = candidate.delta_x / candidate.distance;
			candidate.shell.heading_y = candidate.delta_y / candidate.distance;
		}
	}
	mark_unseen_pillbox_terminals(source_groups, next.terminals,
		maximum_distance);
}

function mark_new_tank_shells(previous, next) {
	let duration = previous ? next.time - previous.time : 0;
	let maximum_distance = SHELL_TANK_BIRTH_ERROR_PIXELS;
	if (duration > 0 && duration <= MAX_POSITION_INTERPOLATION_TICKS) {
		maximum_distance += duration * SHELL_SPEED_PIXELS_PER_TICK;
	}
	let source_groups = [];
	for (let source of next.tank_sources) {
		let group = source_groups.find(item => item.pixel_x === source.pixel_x &&
			item.pixel_y === source.pixel_y && item.direction === source.direction);
		if (group) group.capacity++;
		else source_groups.push({ ...source, capacity: 1, assigned: 0 });
	}
	let candidates = [];
	for (let group of source_groups) {
		let angle = group.direction * Math.PI / 8;
		let coarse_x = Math.sin(angle);
		let coarse_y = -Math.cos(angle);
		for (let shell of next.shells) {
			if (shell.starts_at_pillbox || shell.matched_from_previous ||
				shell.direction !== group.direction) continue;
			let delta_x = shell.pixel_x - group.pixel_x;
			let delta_y = shell.pixel_y - group.pixel_y;
			let distance = Math.hypot(delta_x, delta_y);
			if (distance === 0 || distance > maximum_distance) continue;
			let forward = delta_x * coarse_x + delta_y * coarse_y;
			let lateral = Math.abs(delta_x * coarse_y - delta_y * coarse_x);
			if (forward <= 0 || Math.atan2(lateral, forward) >
				SHELL_DIRECTION_TOLERANCE) continue;
			candidates.push({ group, shell, distance, delta_x, delta_y });
		}
	}
	candidates.sort((a, b) => a.distance - b.distance);
	let assigned_shells = new Set();
	for (let candidate of candidates) {
		if (candidate.group.assigned >= candidate.group.capacity ||
			assigned_shells.has(candidate.shell)) continue;
		candidate.group.assigned++;
		assigned_shells.add(candidate.shell);
		let birth_pixel_x = candidate.group.pixel_x;
		let birth_pixel_y = candidate.group.pixel_y;
		let distance = candidate.distance;
		let birth_time = next.time - distance / SHELL_SPEED_PIXELS_PER_TICK;
		let original = {
			birth_pixel_x, birth_pixel_y, distance, birth_time,
			delta_x: candidate.delta_x, delta_y: candidate.delta_y,
		};
		/* The packet's tank position is at the end of this inferred segment.
		 * Refine against the interpolated tank track at the actual firing time,
		 * which matters when a moving tank fires between position packets. */
		for (let i = 0; i < 2 && candidate.group.track; i++) {
			let tank_position = track_pixel_at(candidate.group.track, birth_time);
			if (!tank_position) break;
			birth_pixel_x = tank_position.pixel_x;
			birth_pixel_y = tank_position.pixel_y;
			candidate.delta_x = candidate.shell.pixel_x - birth_pixel_x;
			candidate.delta_y = candidate.shell.pixel_y - birth_pixel_y;
			distance = Math.hypot(candidate.delta_x, candidate.delta_y);
			birth_time = next.time - distance / SHELL_SPEED_PIXELS_PER_TICK;
		}
		let angle = candidate.group.direction * Math.PI / 8;
		let coarse_x = Math.sin(angle), coarse_y = -Math.cos(angle);
		let forward = candidate.delta_x * coarse_x + candidate.delta_y * coarse_y;
		let lateral = Math.abs(candidate.delta_x * coarse_y -
			candidate.delta_y * coarse_x);
		if (!Number.isFinite(distance) || distance <= 1e-9 || forward <= 0 ||
			Math.atan2(lateral, forward) > SHELL_DIRECTION_TOLERANCE) {
			({ birth_pixel_x, birth_pixel_y, distance, birth_time } = original);
			candidate.delta_x = original.delta_x;
			candidate.delta_y = original.delta_y;
		}
		candidate.shell.starts_at_tank = true;
		candidate.shell.heading_x = candidate.delta_x / distance;
		candidate.shell.heading_y = candidate.delta_y / distance;
		candidate.shell.birth_time = birth_time;
		candidate.shell.birth_pixel_x = birth_pixel_x;
		candidate.shell.birth_pixel_y = birth_pixel_y;
		candidate.shell.heading_origin_x = birth_pixel_x;
		candidate.shell.heading_origin_y = birth_pixel_y;
	}
}

/* Refine a shell's fine heading over its whole trusted track instead of
 * preserving the noise in its first, often short, displacement. Known
 * weapon sources are the best origins; otherwise the first matched track
 * point becomes the fixed origin for every later restatement. */
function refine_shell_heading(previous, next) {
	let origin_x = previous.heading_origin_x;
	let origin_y = previous.heading_origin_y;
	if (origin_x === undefined) {
		if (previous.pillbox_source_x !== undefined) {
			origin_x = previous.pillbox_source_x;
			origin_y = previous.pillbox_source_y;
		} else if (previous.birth_pixel_x !== undefined) {
			origin_x = previous.birth_pixel_x;
			origin_y = previous.birth_pixel_y;
		} else {
			origin_x = previous.pixel_x;
			origin_y = previous.pixel_y;
		}
		previous.heading_origin_x = origin_x;
		previous.heading_origin_y = origin_y;
	}
	next.heading_origin_x = origin_x;
	next.heading_origin_y = origin_y;

	let delta_x = next.pixel_x - origin_x;
	let delta_y = next.pixel_y - origin_y;
	let distance = Math.hypot(delta_x, delta_y);
	if (distance > 0) {
		next.heading_x = delta_x / distance;
		next.heading_y = delta_y / distance;
	} else if (previous.heading_x !== undefined) {
		next.heading_x = previous.heading_x;
		next.heading_y = previous.heading_y;
	}
}

function same_pillbox_stream(first, second) {
	return first.pillbox_source_x !== undefined &&
		first.pillbox_source_x === second.pillbox_source_x &&
		first.pillbox_source_y === second.pillbox_source_y &&
		first.direction === second.direction;
}

function same_known_shell_stream(first, second) {
	if (same_pillbox_stream(first, second)) return true;
	return first.pillbox_source_x === undefined &&
		second.pillbox_source_x === undefined &&
		first.birth_time !== undefined && second.birth_time !== undefined &&
		first.direction === second.direction;
}

function compare_shell_stream_age(first, second) {
	if (first.pillbox_source_x !== undefined) {
		return second.pillbox_source_distance - first.pillbox_source_distance;
	}
	return first.birth_time - second.birth_time;
}

function ordered_pillbox_successor(candidate, target_choices,
	by_previous, previous_shells) {
	if (target_choices[0] !== candidate) return false;
	let close_alternatives = target_choices.slice(1).filter(alternative =>
		alternative.cost - candidate.cost < SHELL_MATCH_MARGIN);
	if (!close_alternatives.length) return false;
	let candidate_shell = previous_shells[candidate.previous_index];
	return close_alternatives.every(alternative => {
		let alternative_shell = previous_shells[alternative.previous_index];
		return same_pillbox_stream(candidate_shell, alternative_shell) &&
			candidate_shell.pillbox_source_distance <
				alternative_shell.pillbox_source_distance &&
			by_previous[alternative.previous_index].some(choice =>
				choice.target.terminal);
	});
}

function unambiguous_shell_successor(candidate, target_choices,
	by_previous, previous_shells) {
	if (target_choices[0] !== candidate) return false;
	return target_choices.length < 2 ||
		target_choices[1].cost - candidate.cost >= SHELL_MATCH_MARGIN ||
		ordered_pillbox_successor(candidate, target_choices,
			by_previous, previous_shells);
}

function shell_target_groups(next) {
	let groups = next.shells.map(target => ({ target, capacity: 1 }));
	for (let terminal of next.terminals) {
		if (terminal.unseen_pillbox_source) continue;
		let group = groups.find(item => item.target.terminal &&
			same_shell_terminal(item.target, terminal));
		if (group) {
			group.capacity++;
			group.terminals.push(terminal);
		} else {
			groups.push({ target: terminal, capacity: 1, terminals: [terminal] });
		}
	}
	return groups;
}

function equivalent_shell_candidates(first, second) {
	/* Two nearby shell restatements remain distinct identities. Equivalence
	 * only suppresses the artificial choice between a restatement and an
	 * impact which describe the same visual endpoint. */
	if (first.target.terminal === second.target.terminal) return first === second;
	return Math.hypot(first.pixel_x - second.pixel_x,
		first.pixel_y - second.pixel_y) <= SHELL_EQUIVALENT_ENDPOINT_PIXELS &&
		Math.abs(first.end_time - second.end_time) <= SHELL_EQUIVALENT_TIME_TICKS;
}

/* Impact records may arrive after a leading shell has already reached the
 * struck object. Pure distance cost then prefers a younger shell, even when
 * that younger shell has the stream's only trustworthy successor. If one
 * known weapon stream alone has enough successor-less shells to fill an
 * impact's multiplicity, reserve the impacts for its leading members. */
function prefer_ordered_shell_impacts(target_groups, by_previous, by_next,
	previous_shells) {
	let removed = new Set();
	for (let next_index = 0; next_index < target_groups.length; next_index++) {
		let target_group = target_groups[next_index];
		if (!target_group.target.terminal) continue;
		let streams = [];
		for (let candidate of by_next[next_index]) {
			let shell = previous_shells[candidate.previous_index];
			if (shell.pillbox_source_x === undefined &&
				shell.birth_time === undefined) continue;
			let has_successor = by_previous[candidate.previous_index]
				.some(successor => !successor.target.terminal &&
					unambiguous_shell_successor(successor,
						by_next[successor.next_index], by_previous,
						previous_shells));
			if (has_successor) continue;
			let stream = streams.find(item =>
				same_known_shell_stream(item.shell, shell));
			if (!stream) {
				stream = { shell, candidates: [] };
				streams.push(stream);
			}
			stream.candidates.push(candidate);
		}
		let eligible = streams.filter(stream =>
			stream.candidates.length >= target_group.capacity);
		if (eligible.length !== 1) continue;
		eligible[0].candidates.sort((a, b) =>
			compare_shell_stream_age(previous_shells[a.previous_index],
				previous_shells[b.previous_index]));
		let retained = new Set(eligible[0].candidates
			.slice(0, target_group.capacity));
		for (let candidate of by_next[next_index]) {
			if (!retained.has(candidate)) removed.add(candidate);
		}
	}
	if (!removed.size) return;
	for (let i = 0; i < by_previous.length; i++) {
		by_previous[i] = by_previous[i].filter(candidate =>
			!removed.has(candidate));
	}
	for (let i = 0; i < by_next.length; i++) {
		by_next[i] = by_next[i].filter(candidate => !removed.has(candidate));
	}
}

/* Match only mutually best candidates, and only when each wins by a useful
 * margin over its alternatives. Shell lists carry no IDs and may gain or
 * lose entries at any restatement, so an unmatched pop is safer than a
 * smooth but invented path. Exact direction and client ownership are hard
 * constraints; accepted displacements continuously refine a finer heading
 * from the track's first trusted point or weapon source. */
function match_shell_snapshots(previous, next) {
	let duration = next.time - previous.time;
	if (duration <= 0 || duration > MAX_SHELL_INTERPOLATION_TICKS) return;
	mark_new_pillbox_shells(previous, next);

	let target_groups = shell_target_groups(next);
	let by_previous = Array.from({ length: previous.shells.length }, () => []);
	let by_next = Array.from({ length: target_groups.length }, () => []);
	for (let previous_index = 0; previous_index < previous.shells.length; previous_index++) {
		for (let next_index = 0; next_index < target_groups.length; next_index++) {
			let target = target_groups[next_index].target;
			if (target.starts_at_pillbox) continue;
			let match;
			if (target.terminal) {
				if (duration > MAX_POSITION_INTERPOLATION_TICKS) continue;
				match = shell_terminal_match(previous.shells[previous_index], target,
					duration, previous.time);
			} else {
				match = shell_match_cost(previous.shells[previous_index], target, duration);
				if (match) {
					match.pixel_x = target.pixel_x;
					match.pixel_y = target.pixel_y;
				}
			}
			if (!match) continue;
			match.end_time = target.terminal
				? Math.min(next.time,
					previous.time + match.distance / SHELL_SPEED_PIXELS_PER_TICK)
				: next.time;
			let candidate = { previous_index, next_index, target, ...match };
			by_previous[previous_index].push(candidate);
			by_next[next_index].push(candidate);
		}
	}
	/* Grazes are a fallback for quantisation-sized gaps, never competitors
	 * with geometry the existing matcher already considers exact. This keeps
	 * a newly plausible corner from stealing a real successor or impact in a
	 * dense anonymous stream. */
	let rejected_grazes = new Set();
	for (let choices of by_previous) {
		for (let candidate of choices) {
			if (!(candidate.graze_distance > 0)) continue;
			let previous_has_exact = choices.some(alternative =>
				!(alternative.graze_distance > 0));
			let target_has_exact = by_next[candidate.next_index].some(alternative =>
				!(alternative.graze_distance > 0));
			if (previous_has_exact || target_has_exact) rejected_grazes.add(candidate);
		}
	}
	if (rejected_grazes.size) {
		for (let i = 0; i < by_previous.length; i++) {
			by_previous[i] = by_previous[i].filter(candidate =>
				!rejected_grazes.has(candidate));
		}
		for (let i = 0; i < by_next.length; i++) {
			by_next[i] = by_next[i].filter(candidate =>
				!rejected_grazes.has(candidate));
		}
	}
	for (let choices of by_previous) choices.sort((a, b) => a.cost - b.cost);
	for (let choices of by_next) choices.sort((a, b) => a.cost - b.cost);
	prefer_ordered_shell_impacts(target_groups, by_previous, by_next,
		previous.shells);
	for (let choices of by_previous) choices.sort((a, b) => a.cost - b.cost);
	for (let choices of by_next) choices.sort((a, b) => a.cost - b.cost);

	let selected = [];
	for (let previous_index = 0; previous_index < previous.shells.length; previous_index++) {
		/* A normal successor which this shell cannot win is not a genuine
		 * alternative to its impact. Dense pill streams often put the leading
		 * shell and the following shell near the same next endpoint; the latter
		 * is the mutually best successor while the former reaches the impact. */
		let choices = by_previous[previous_index].filter(candidate => {
			if (candidate.target.terminal) return true;
			return unambiguous_shell_successor(candidate,
				by_next[candidate.next_index], by_previous, previous.shells);
		});
		if (!choices.length) continue;
		let cheapest = choices[0];
		let equivalents = choices.filter(candidate =>
			equivalent_shell_candidates(cheapest, candidate));
		let trusted_successor = !cheapest.target.terminal &&
			previous.shells[previous_index].pillbox_source_x !== undefined &&
			unambiguous_shell_successor(cheapest, by_next[cheapest.next_index],
				by_previous, previous.shells);
		let previous_alternative = choices.find(candidate =>
			!equivalent_shell_candidates(cheapest, candidate) &&
			!(trusted_successor && candidate.target.terminal));
		let previous_margin = previous_alternative
			? previous_alternative.cost - cheapest.cost : Infinity;
		/* Keep both descriptions of an equivalent endpoint available. The
		 * real restatement is assigned first below, preserving its heading;
		 * if another older shell wins that anonymous entry, this shell can
		 * still consume the simultaneous impact instead of freezing. */
		if (previous_margin >= SHELL_MATCH_MARGIN) selected.push(...equivalents);
	}

	/* Capacity belongs to selected destinations, not every candidate. A shell
	 * which chose its real successor must not consume an equivalent impact and
	 * block another shell from terminating there. */
	let selected_by_next = Array.from({ length: target_groups.length }, () => []);
	for (let candidate of selected) selected_by_next[candidate.next_index].push(candidate);
	for (let choices of selected_by_next) choices.sort((a, b) => a.cost - b.cost);
	let assigned_previous = new Set();

	/* Shell restatements precede terminals in target_groups, so a real
	 * successor wins an equivalent endpoint whenever it remains available. */
	for (let next_index = 0; next_index < selected_by_next.length; next_index++) {
		let group = target_groups[next_index];
		let choices = selected_by_next[next_index].filter(candidate =>
			!assigned_previous.has(candidate.previous_index));
		let capacity = group.capacity;
		let next_alternative;
		if (group.target.terminal) {
			next_alternative = choices[capacity];
		} else {
			/* Keep ordinary shell-to-shell matching mutually best. The relaxed
			 * capacity accounting is specifically for impact multiplicity; it
			 * must not broaden unrelated anonymous-shell associations. */
			if (!choices.length || !unambiguous_shell_successor(choices[0],
				by_next[next_index], by_previous, previous.shells)) continue;
			next_alternative = by_next[next_index][1];
			if (next_alternative && same_pillbox_stream(
				previous.shells[choices[0].previous_index],
				previous.shells[next_alternative.previous_index]) &&
				by_previous[next_alternative.previous_index].some(candidate =>
					candidate.target.terminal)) next_alternative = null;
		}
		for (let i = 0; i < Math.min(capacity, choices.length); i++) {
			let best = choices[i];
			let next_margin = next_alternative
				? next_alternative.cost - best.cost : Infinity;
			if (next_margin < SHELL_MATCH_MARGIN) continue;
			if (assigned_previous.has(best.previous_index)) continue;
			assigned_previous.add(best.previous_index);

			let old_shell = previous.shells[best.previous_index];
			old_shell.next_time = best.end_time;
			old_shell.next_pixel_x = best.pixel_x;
			old_shell.next_pixel_y = best.pixel_y;
			old_shell.next_terminal = best.target.terminal;
			if (best.target.terminal) {
				old_shell.next_terminal_type = best.target.type;
				let terminal = group.terminals[i];
				terminal.match_time = best.end_time;
				old_shell.next_terminal_event_type = terminal.event_type;
				if (terminal.effect) {
					terminal.effect.time = best.end_time;
					if (best.hitbox_pixel_x !== undefined) {
						terminal.effect.x = Math.floor(best.hitbox_pixel_x / 16);
						terminal.effect.y = Math.floor(best.hitbox_pixel_y / 16);
						terminal.effect.px = best.hitbox_pixel_x - terminal.effect.x * 16;
						terminal.effect.py = best.hitbox_pixel_y - terminal.effect.y * 16;
					}
				}
			}
			if (best.target.terminal) continue;

			let new_shell = best.target;
			new_shell.matched_from_previous = true;
			if (old_shell.pillbox_source_x !== undefined) {
				new_shell.pillbox_source_x = old_shell.pillbox_source_x;
				new_shell.pillbox_source_y = old_shell.pillbox_source_y;
				new_shell.pillbox_source_distance = Math.hypot(
					new_shell.pixel_x - old_shell.pillbox_source_x,
					new_shell.pixel_y - old_shell.pillbox_source_y);
				if (best.pillbox_orbit_states) {
					new_shell.pillbox_orbit_states = best.pillbox_orbit_states;
				}
			}
			if (old_shell.birth_pixel_x !== undefined) {
				new_shell.birth_time = old_shell.birth_time;
				new_shell.birth_pixel_x = old_shell.birth_pixel_x;
				new_shell.birth_pixel_y = old_shell.birth_pixel_y;
			}
			refine_shell_heading(old_shell, new_shell);
		}
	}
}

/* Per-client shell restatements used only for drawing. Keeping separate
 * client tracks is intentional: there is no evidence that technical shell
 * ownership migrates in flight, and joining across clients would create
 * especially convincing false identities. A possible migration therefore
 * renders conservatively as one shell disappearing and another appearing. */
function build_shell_positions(records, terminals, pillbox_sources_by_record,
	tank_sources_by_record, tank_positions = null) {
	if (tank_positions) {
		for (let terminal of terminals) {
			if (terminal.event_type === "tank_hit" &&
				terminal.target_tank !== undefined) {
				terminal.tank_track = tank_positions[terminal.target_tank];
			}
		}
	}
	let snapshots = Array.from({ length: 16 }, () => []);
	let terminals_by_record = new Map();
	for (let terminal of terminals) {
		let record_terminals = terminals_by_record.get(terminal.record);
		if (!record_terminals) {
			record_terminals = [];
			terminals_by_record.set(terminal.record, record_terminals);
		}
		record_terminals.push(terminal);
	}
	for (let rec of records) {
		let map_node_only = rec.subpackets.length > 0 &&
			rec.subpackets.every(sub => MAP_NODE_TYPES.has(sub.type));
		let shell_lists = rec.subpackets.filter(sub => sub.type === "shells");
		if (!shell_lists.length && (rec.tankStatus === 0x0f || map_node_only)) continue;

		let shells = [];
		for (let sub of shell_lists) append_shell_list(shells, sub, rec.time);
		let snapshot = {
			time: rec.time,
			shells: shells.map(shell => ({
				pixel_x: shell.x * 16 + shell.px,
				pixel_y: shell.y * 16 + shell.py,
				direction: shell.direction,
			})),
			terminals: terminals_by_record.get(rec) || [],
			pillbox_sources: pillbox_sources_by_record.get(rec) || [],
			tank_sources: tank_sources_by_record.get(rec) || [],
		};
		let client_snapshots = snapshots[rec.player];
		let previous = client_snapshots[client_snapshots.length - 1];
		if (previous) match_shell_snapshots(previous, snapshot);
		mark_new_tank_shells(previous, snapshot);
		client_snapshots.push(snapshot);
	}
	return snapshots;
}

function build_shell_births(shell_positions) {
	return shell_positions.map(snapshots => {
		let births = [];
		for (let snapshot of snapshots) {
			for (let shell of snapshot.shells) {
				if (!shell.starts_at_tank || shell.birth_time >= snapshot.time) continue;
				births.push({
					start_time: shell.birth_time,
					end_time: snapshot.time,
					pixel_x: shell.birth_pixel_x,
					pixel_y: shell.birth_pixel_y,
					heading_x: shell.heading_x,
					heading_y: shell.heading_y,
					direction: shell.direction,
				});
			}
		}
		return births;
	});
}

/* Centre position of an object at a possibly fractional replay tick. State
 * reconstruction deliberately remains packet-exact; only this rendering
 * helper looks ahead to the next trustworthy restatement. */
function interpolated_position(track, object, tick) {
	if (!object) return null;

	let pixel_x = object.x * 16 + object.px;
	let pixel_y = object.y * 16 + object.py;
	if (!track || object.position_time === undefined) {
		return { x: pixel_x / 16 + 0.5, y: pixel_y / 16 + 0.5 };
	}

	let lo = 0, hi = track.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (track[mid].time <= tick) lo = mid + 1;
		else hi = mid;
	}
	let index = lo - 1;
	let current = track[index];
	/* The state may have crossed a death/quit without receiving another
	 * position, or may come from a caller-built game. In either case its
	 * packet-exact position is the only safe answer. */
	if (!current || current.time !== object.position_time ||
		current.pixel_x !== pixel_x || current.pixel_y !== pixel_y ||
		(current.parachute !== undefined && current.parachute !== object.parachute)) {
		return { x: pixel_x / 16 + 0.5, y: pixel_y / 16 + 0.5 };
	}

	let next = track[index + 1];
	/* A confirmed tank entry is the LGM path's true final position. Usually
	 * it arrives within the ordinary interpolation window. If its status
	 * packet was delayed, finish the approach within half a second and stop
	 * drawing the already-boarded man instead of leaving him stalled. */
	if (current.tank_entry) {
		let terminal_time = Math.min(current.tank_entry.time,
			current.time + MAX_POSITION_INTERPOLATION_TICKS);
		if (tick >= terminal_time) return null;
		next = {
			time: terminal_time,
			pixel_x: current.tank_entry.pixel_x,
			pixel_y: current.tank_entry.pixel_y,
			continuous: true,
		};
	}
	let duration = next ? next.time - current.time : 0;
	if (next && next.continuous && tick < next.time && duration > 0 &&
		duration <= MAX_POSITION_INTERPOLATION_TICKS) {
		let amount = (tick - current.time) / duration;
		pixel_x += (next.pixel_x - current.pixel_x) * amount;
		pixel_y += (next.pixel_y - current.pixel_y) * amount;
	}

	return { x: pixel_x / 16 + 0.5, y: pixel_y / 16 + 0.5 };
}

function tank_position_at(game, state, player, tick) {
	let track = game.tank_positions && game.tank_positions[player];
	let position = interpolated_position(track, state.tanks[player], tick);
	if (!position) return null;
	position.direction = tank_direction_at(game, state, player, tick);
	return position;
}

function tank_direction_at(game, state, player, tick) {
	let tank = state.tanks[player];
	if (!tank) return null;
	let fallback = tank.dir;
	let tracks = game.tank_directions;
	let track = tracks && tracks[player];
	if (!track || tank.direction_time === undefined) return fallback;

	let lo = 0, hi = track.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (track[mid].time <= tick) lo = mid + 1;
		else hi = mid;
	}
	let current = track[lo - 1];
	if (!current || current.time !== tank.direction_time ||
		current.direction !== tank.dir) return fallback;

	let next = track[lo];
	let duration = next ? next.time - current.time : 0;
	if (!next || !next.continuous || tick >= next.time || duration <= 0 ||
		duration > MAX_POSITION_INTERPOLATION_TICKS) return fallback;

	let amount = (tick - current.time) / duration;
	let delta = (next.direction - current.direction + 24) % 16 - 8;
	let step = Math.sign(delta) * Math.round(Math.abs(delta) * amount);
	return (current.direction + step + 16) % 16;
}

function lgm_position_at(game, state, player, tick) {
	let track = game.lgm_positions && game.lgm_positions[player];
	return interpolated_position(track, state.men[player], tick);
}

function shell_position_at(game, player, shell, index, tick) {
	if (!shell) return null;
	let pixel_x = shell.x * 16 + shell.px;
	let pixel_y = shell.y * 16 + shell.py;
	let fallback = () => ({ x: pixel_x / 16 + 0.5, y: pixel_y / 16 + 0.5 });
	let snapshots = game.shell_positions && game.shell_positions[player];
	if (!snapshots || shell.position_time === undefined) return fallback();

	let lo = 0, hi = snapshots.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (snapshots[mid].time <= tick) lo = mid + 1;
		else hi = mid;
	}
	let snapshot = snapshots[lo - 1];
	let position = snapshot && snapshot.shells[index];
	if (!position || snapshot.time !== shell.position_time ||
		position.pixel_x !== pixel_x || position.pixel_y !== pixel_y ||
		position.direction !== shell.direction || position.next_time === undefined) {
		return fallback();
	}
	if (tick >= position.next_time) {
		return position.next_terminal ? null : fallback();
	}

	let amount = (tick - snapshot.time) / (position.next_time - snapshot.time);
	pixel_x += (position.next_pixel_x - position.pixel_x) * amount;
	pixel_y += (position.next_pixel_y - position.pixel_y) * amount;
	return { x: pixel_x / 16 + 0.5, y: pixel_y / 16 + 0.5 };
}

function shell_birth_positions_at(game, player, tick) {
	let births = game.shell_births && game.shell_births[player];
	if (!births || !births.length) return [];
	let lo = 0, hi = births.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (births[mid].end_time <= tick) lo = mid + 1;
		else hi = mid;
	}
	let latest_end = tick + MAX_POSITION_INTERPOLATION_TICKS * 2 +
		SHELL_TANK_BIRTH_ERROR_PIXELS / SHELL_SPEED_PIXELS_PER_TICK;
	let positions = [];
	for (let i = lo; i < births.length && births[i].end_time <= latest_end; i++) {
		let birth = births[i];
		if (birth.start_time > tick) continue;
		let distance = (tick - birth.start_time) * SHELL_SPEED_PIXELS_PER_TICK;
		positions.push({
			x: (birth.pixel_x + birth.heading_x * distance) / 16 + 0.5,
			y: (birth.pixel_y + birth.heading_y * distance) / 16 + 0.5,
			direction: birth.direction,
		});
	}
	return positions;
}

const BoloMotion = {
	TICKS_PER_SECOND, MAX_POSITION_INTERPOLATION_TICKS,
	MAX_SHELL_INTERPOLATION_TICKS,
	append_shell_list, add_shell_point_terminal, add_shell_box_terminal,
	build_tank_positions, build_tank_directions, build_lgm_positions, track_pixel_at,
	build_shell_positions, build_shell_births,
	tank_position_at, tank_direction_at, lgm_position_at, shell_position_at,
	shell_birth_positions_at,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloMotion;
} else {
	window.BoloMotion = BoloMotion;
}

})();
