/* Render-only motion reconstruction and sampling for Bolo replays.
 * No DOM use — also loadable in node for tests. */
"use strict";
(function () {

const PillboxShellOrbits = typeof module !== "undefined" && module.exports
	? require("./pillbox_shell_orbits.js") : window.PillboxShellOrbits;

/* Each pass over the records comes in two forms: build_x(), the plain
 * synchronous function, and build_x_steps(), the generator it drains,
 * which reports progress so the viewer can draw a loading bar. See
 * progress.js. */
const { PROGRESS_CHUNK, drain, sub_progress } = typeof module !== "undefined" && module.exports
	? require("./progress.js") : window.BoloProgress;

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
/* Facing gets a longer window than position for the same reason shells do:
 * a turn rate is bounded, so the intermediate angles are constrained in a way
 * an unseen path across open ground is not. Corpus-wide, gaps of 26 to 50
 * ticks imply at worst 6.75 ticks per sixteenth of a circle, still slower
 * than turns seen inside the trusted window; beyond 50 ticks the changes
 * start clustering at seven or eight sixteenths, where the shorter way round
 * stops being a safe guess. */
const MAX_DIRECTION_INTERPOLATION_TICKS = TICKS_PER_SECOND;
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

/* Tank shells run the same integer simulation as pillbox shells, at all 256
 * bradians (docs/tank_shell_bradians.md): one velocity-table step every two
 * ticks, positions rendered by an arithmetic >>4. Unlike a pillbox, the
 * firing tank's sub-pixel position and exact firing tick are unknown, so a
 * tank-born shell carries no absolute track. Instead it carries hypothesis
 * states, one per candidate bradian, each bounding the shell's exact
 * 1/16-pixel coordinate at its latest restatement; a continuation must
 * shift some state by a whole number of velocity steps into the observed
 * pixel's bounds, and the boxes narrow as the chain grows. */
const TANK_SHELL_VELOCITIES = Array.from({ length: 256 }, (_, bradian) => [
	PillboxShellOrbits.scale(bradian, 64),
	PillboxShellOrbits.scale((bradian + 192) & 0xff, 64),
]);
/* Corpus-measured gate: the true bradian sits in the direction nibble's
 * round-to-nearest window, plus up to four steps of skew either side from
 * the nibble and the bradian being sampled a tick or two apart on a
 * turning tank. */
const TANK_BRADIAN_MIN_OFFSET = -12;
const TANK_BRADIAN_MAX_OFFSET = 11;
/* Update-count tolerance per link. Each link re-anchors at the previous
 * restatement, so a sender whose whole simulation lags stays inside the
 * window; only jitter within one link has to fit. Two updates equals the
 * matcher's existing eight-pixel distance tolerance, and measured best on
 * the fixture: one update vetoed a handful of real, merely-laggy links. */
const TANK_BRADIAN_UPDATE_JITTER = 2;
const TICKS_PER_SHELL_UPDATE = 2;
/* Chain stitching bounds. A fragment gap can exceed the ordinary shell
 * interpolation window when the sender lagged, but never the shell's own
 * lifetime: 32 updates on the pill orbits, and the same distance for a
 * tank shot measured from its birth. Fuzzy joins with no discrete
 * evidence keep the ordinary window. */
const MAX_STITCH_GAP_TICKS = 100;
/* Share of shell reconstruction spent matching snapshots rather than
 * working on the chains that matching produced (2.4 s against 1.0 s on the
 * sample log). Only the loading bar cares, and only about the proportion. */
const SHELL_MATCH_SHARE = 0.7;
const TANK_SHELL_FLIGHT_LIMIT_TICKS = 72;
/* 8.5 tiles: the pill orbit range, and the assumed tank-shot range from
 * the shared simulation. */
const SHELL_RANGE_PIXELS = 136;
/* A lagging sender's record timestamps drift against its simulation by a
 * few updates in either direction, so an on-track restatement can sit
 * this far from where a uniform-time reading of the chain puts it. */
const MAX_SMOOTHING_DEVIATION_PIXELS = 24;
const ABSORB_LATERAL_TOLERANCE_PIXELS = 2;
/* An impact record normally trails the impact by well under a second. */
const MAX_FATE_EVENT_LAG_TICKS = 30;
/* The resolver's cost-forced margin: an assignment is accepted when every
 * rival story carries at least this much extra geometric error, the same
 * ambiguity unit the pairwise matcher uses. */
const RESIDUAL_COST_MARGIN = SHELL_MATCH_MARGIN;
/* Dilated joins: a lagging sender's timestamps can put a single hop far
 * off the two-pixel-per-tick schedule while the shell stays exactly on
 * its ray. The penalty keeps any ordinary-physics story preferred; the
 * catch-up allowance covers a sender flushing its backlog. */
const DILATED_JOIN_PENALTY_PIXELS = 8;
const DILATED_CATCHUP_PIXELS = 16;
const DILATED_UPDATE_SLACK = 8;

/* Standalone map/node records carry no player state or motion. */
const MAP_NODE_TYPES = new Set([
	"node_id", "map_run", "map_terrain_request", "map_header_request",
	"game_info", "pillbox_list", "base_list", "start_list", "history",
	"attached_log",
]);

/* Append one shell-list subpacket as reconstructed absolute positions.
 * Only the head has an absolute pixel coordinate. Later coordinates add
 * quantised offsets derived from finer internal positions, so each chained
 * link can lose one pixel per axis. `position_uncertainty` records the
 * resulting orbit-matching bound; it is zero for the exact list head.
 * The direction nibble in the list header applies to EVERY shell.
 * position_time lets render-only interpolation verify that a reconstructed
 * state still belongs to the expected snapshot. */
function append_shell_list(shells, sub, position_time) {
	let direction = sub.direction ?? sub.shells[0].direction;
	let previous = null;
	let shell_list_start = shells.length;
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
			direction, position_time, position_uncertainty: i,
			shell_list_start, shell_list_index: i,
			shell_offset_x: i > 0 ? shell.offsetX : undefined,
			shell_offset_y: i > 0 ? shell.offsetY : undefined,
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
	return drain(build_tank_positions_steps(records));
}

function* build_tank_positions_steps(records) {
	let tracks = Array.from({ length: 16 }, () => []);
	let active = Array.from({ length: 16 }, () => false);

	for (let i = 0; i < records.length; i++) {
		if (i % PROGRESS_CHUNK === 0) yield { fraction: i / records.length };
		let rec = records[i];
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
	return drain(build_tank_directions_steps(records));
}

function* build_tank_directions_steps(records) {
	let tracks = Array.from({ length: 16 }, () => []);
	let active = Array.from({ length: 16 }, () => false);

	for (let i = 0; i < records.length; i++) {
		if (i % PROGRESS_CHUNK === 0) yield { fraction: i / records.length };
		let rec = records[i];
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
	return drain(build_lgm_positions_steps(records));
}

function* build_lgm_positions_steps(records) {
	let tracks = Array.from({ length: 16 }, () => []);
	let active = Array.from({ length: 16 }, () => false);
	let parachuting = Array.from({ length: 16 }, () => false);
	let tanks = Array.from({ length: 16 }, () => null);

	for (let i = 0; i < records.length; i++) {
		if (i % PROGRESS_CHUNK === 0) yield { fraction: i / records.length };
		let rec = records[i];
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
	let orbit_states = pillbox_shell_successor_states(previous, next, duration);
	if (orbit_states && !orbit_states.length) return null;
	if (orbit_states) {
		let cost = Math.min(...orbit_states.map(state => state.cost));
		return {
			cost,
			pillbox_orbit_states: orbit_states.map(state => ({
				bradian: state.bradian, step: state.step,
			})),
		};
	}

	let tank_states = tank_shell_successor_states(previous, next, duration);
	if (tank_states && !tank_states.length) return null;

	let previous_pixel_x = previous.tank_exact_pixel_x ?? previous.pixel_x;
	let previous_pixel_y = previous.tank_exact_pixel_y ?? previous.pixel_y;
	let delta_x = next.pixel_x - previous_pixel_x;
	let delta_y = next.pixel_y - previous_pixel_y;
	let distance = Math.hypot(delta_x, delta_y);
	let expected_distance = duration * SHELL_SPEED_PIXELS_PER_TICK;
	let distance_error = Math.abs(distance - expected_distance);
	if (distance_error > SHELL_MATCH_ERROR_PIXELS || distance === 0) return null;
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
		tank_bradian_states: tank_states,
	};
}

/* A pill shell's exact whole-pixel coordinate is one of the measured orbit
 * points. A list head supplies that coordinate directly; later members only
 * bound it because their chained offsets were quantised independently. An
 * arithmetic shift rounds every offset down, so the exact coordinate is
 * between the reconstructed coordinate and that coordinate plus the member
 * index; it can never be below the reconstruction.
 * Near the muzzle several fine directions also share or overlap a bound, so
 * retain every compatible state and let later restatements narrow the set.
 * `undefined` means this shell predates orbit-backed identification; an
 * empty array means a proposed continuation is physically impossible. */
function pillbox_orbit_position_matches(position, pixel_x, pixel_y,
	position_uncertainty = 0) {
	return position[0] >= pixel_x &&
		position[0] <= pixel_x + position_uncertainty &&
		position[1] >= pixel_y &&
		position[1] <= pixel_y + position_uncertainty;
}

function pillbox_orbit_states_at(direction, pixel_x, pixel_y,
	position_uncertainty = 0) {
	let states = [];
	for (let orbit of PILLBOX_ORBITS_BY_DIRECTION[direction]) {
		for (let step = 0; step < orbit.positions.length; step++) {
			let position = orbit.positions[step];
			if (pillbox_orbit_position_matches(position, pixel_x, pixel_y,
				position_uncertainty)) {
				states.push({ bradian: orbit.bradian, step });
			}
		}
	}
	return states;
}

function pillbox_orbit_position(orbit, step) {
	return step < orbit.positions.length ? orbit.positions[step] : orbit.terminal;
}

function unique_pillbox_orbit_states(states) {
	let states_by_key = new Map();
	for (let state of states) {
		let key = `${state.bradian}:${state.step}`;
		if (!states_by_key.has(key)) {
			states_by_key.set(key, {
				bradian: state.bradian,
				step: state.step,
			});
		}
	}
	return [...states_by_key.values()];
}

function common_pillbox_orbit_pixel(source_x, source_y, states) {
	if (!states.length || source_x === undefined) return null;
	let exact_position = null;
	for (let state of states) {
		let orbit = PILLBOX_ORBITS_BY_BRADIAN.get(state.bradian);
		let position = pillbox_orbit_position(orbit, state.step);
		let pixel_x = source_x + position[0];
		let pixel_y = source_y + position[1];
		if (!exact_position) exact_position = [pixel_x, pixel_y];
		else if (exact_position[0] !== pixel_x || exact_position[1] !== pixel_y) {
			return null;
		}
	}
	return exact_position;
}

function set_pillbox_orbit_states(shell, states) {
	states = unique_pillbox_orbit_states(states);
	shell.pillbox_orbit_states = states;
	delete shell.pillbox_orbit_pixel_x;
	delete shell.pillbox_orbit_pixel_y;
	let exact_position = common_pillbox_orbit_pixel(shell.pillbox_source_x,
		shell.pillbox_source_y, states);
	if (!exact_position) return;
	shell.pillbox_orbit_pixel_x = exact_position[0];
	shell.pillbox_orbit_pixel_y = exact_position[1];
	shell.pillbox_source_distance = Math.hypot(
		exact_position[0] - shell.pillbox_source_x,
		exact_position[1] - shell.pillbox_source_y);
}

/* Inclusive internal-coordinate bounds for a reconstructed shell pixel:
 * the exact pixel lies in [pixel, pixel + uncertainty] (the one-sided
 * chained-offset bound), and each pixel spans sixteen internal units. */
function shell_internal_bounds(pixel, uncertainty) {
	return [pixel * 16, (pixel + uncertainty) * 16 + 15];
}

function initial_tank_bradian_states(direction, pixel_x, pixel_y,
	uncertainty) {
	let [lo_x, hi_x] = shell_internal_bounds(pixel_x, uncertainty);
	let [lo_y, hi_y] = shell_internal_bounds(pixel_y, uncertainty);
	let states = [];
	for (let offset = TANK_BRADIAN_MIN_OFFSET;
		offset <= TANK_BRADIAN_MAX_OFFSET; offset++) {
		states.push({
			bradian: (direction * 16 + offset) & 0xff,
			lo_x, hi_x, lo_y, hi_y,
		});
	}
	return states;
}

/* One axis of the advance: the union over plausible update counts of the
 * intersection between the shifted hypothesis interval and the observed
 * bounds, a sound over-approximation. Null when no count reaches. */
function advance_bradian_axis(lo, hi, velocity, obs_lo, obs_hi, m_lo, m_hi) {
	let out_lo = Infinity, out_hi = -Infinity;
	for (let m = m_lo; m <= m_hi; m++) {
		let step_lo = Math.max(lo + m * velocity, obs_lo);
		let step_hi = Math.min(hi + m * velocity, obs_hi);
		if (step_lo > step_hi) continue;
		out_lo = Math.min(out_lo, step_lo);
		out_hi = Math.max(out_hi, step_hi);
	}
	return out_lo <= out_hi ? [out_lo, out_hi] : null;
}

/* Advance each hypothesis and keep those reaching the observed bounds.
 * The axes are advanced independently: in the simulation they share one
 * update count, but real logs contain single-pixel sampling anomalies
 * where the axes disagree by one update (a documented corpus shot in the
 * tests is one), so demanding the shared count would break real chains
 * for a marginal gain in pruning. `undefined` means the shell predates
 * bradian tracking; an empty array proves the proposed continuation
 * physically impossible. */
function tank_shell_successor_states(previous, next, duration) {
	if (!previous.tank_bradian_states) return undefined;
	let uncertainty = next.position_uncertainty || 0;
	let [obs_lo_x, obs_hi_x] = shell_internal_bounds(next.pixel_x, uncertainty);
	let [obs_lo_y, obs_hi_y] = shell_internal_bounds(next.pixel_y, uncertainty);
	let m_lo = Math.max(0, Math.floor(duration / TICKS_PER_SHELL_UPDATE) -
		TANK_BRADIAN_UPDATE_JITTER);
	let m_hi = Math.ceil(duration / TICKS_PER_SHELL_UPDATE) +
		TANK_BRADIAN_UPDATE_JITTER;
	let states = [];
	for (let state of previous.tank_bradian_states) {
		let [vx, vy] = TANK_SHELL_VELOCITIES[state.bradian];
		let box_x = advance_bradian_axis(state.lo_x, state.hi_x, vx,
			obs_lo_x, obs_hi_x, m_lo, m_hi);
		if (!box_x) continue;
		let box_y = advance_bradian_axis(state.lo_y, state.hi_y, vy,
			obs_lo_y, obs_hi_y, m_lo, m_hi);
		if (!box_y) continue;
		states.push({
			bradian: state.bradian,
			lo_x: box_x[0], hi_x: box_x[1],
			lo_y: box_y[0], hi_y: box_y[1],
		});
	}
	return states;
}

/* When every surviving hypothesis renders to one and the same pixel, the
 * shell's exact coordinate is recovered despite chained-offset
 * quantisation, exactly as pill orbits recover theirs. */
function tank_states_exact_pixel(states) {
	if (!states || !states.length) return null;
	let exact = null;
	for (let state of states) {
		if ((state.lo_x >> 4) !== (state.hi_x >> 4) ||
			(state.lo_y >> 4) !== (state.hi_y >> 4)) return null;
		let pixel_x = state.lo_x >> 4, pixel_y = state.lo_y >> 4;
		if (!exact) exact = [pixel_x, pixel_y];
		else if (exact[0] !== pixel_x || exact[1] !== pixel_y) return null;
	}
	return exact;
}

function set_tank_bradian_states(shell, states) {
	shell.tank_bradian_states = states;
	let exact = tank_states_exact_pixel(states);
	if (exact) {
		shell.tank_exact_pixel_x = exact[0];
		shell.tank_exact_pixel_y = exact[1];
	}
}

/* A uniquely surviving bradian is a better heading than any fit through
 * quantised restatements. Applied after refine_shell_heading so the fitted
 * estimate remains the fallback while several bradians survive. */
function apply_tank_bradian_heading(shell) {
	let states = shell.tank_bradian_states;
	if (!states || !states.length ||
		states.some(state => state.bradian !== states[0].bradian)) return;
	let [vx, vy] = TANK_SHELL_VELOCITIES[states[0].bradian];
	let length = Math.hypot(vx, vy);
	if (length > 0) {
		shell.heading_x = vx / length;
		shell.heading_y = vy / length;
	}
}

function pillbox_orbit_internal_position(shell, state) {
	let relative = PillboxShellOrbits.internal_position_at(state.bradian,
		state.step);
	return [
		shell.pillbox_source_x * 16 + relative[0],
		shell.pillbox_source_y * 16 + relative[1],
	];
}

function pillbox_states_encode_offset(previous, previous_state, next,
	next_state) {
	let previous_position = pillbox_orbit_internal_position(previous,
		previous_state);
	let next_position = pillbox_orbit_internal_position(next, next_state);
	return ((next_position[0] - previous_position[0]) >> 4) ===
			next.shell_offset_x &&
		((next_position[1] - previous_position[1]) >> 4) ===
			next.shell_offset_y;
}

/* The signed bytes for a non-head member are the high pixel portion of the
 * difference between two exact internal shell coordinates. Once adjacent
 * members have orbit hypotheses, validate the raw byte pair directly. A
 * list is a chain, so repeated pairwise pruning is sufficient to remove
 * every state which participates in no complete assignment. */
function refine_pillbox_orbits_from_shell_lists(snapshot) {
	let changed = false;
	let keep_pruning = true;
	while (keep_pruning) {
		keep_pruning = false;
		for (let next_index = 0; next_index < snapshot.shells.length;
			next_index++) {
			let next = snapshot.shells[next_index];
			if (next.shell_list_index === 0 ||
				next.shell_offset_x === undefined ||
				!next.pillbox_orbit_states) continue;
			let previous = snapshot.shells[next_index - 1];
			if (!previous || previous.shell_list_start !== next.shell_list_start ||
				!previous.pillbox_orbit_states ||
				previous.pillbox_source_x === undefined ||
				next.pillbox_source_x === undefined ||
				!same_pillbox_stream(previous, next) ||
				(previous.pillbox_orbit_states.length !== 1 &&
					next.pillbox_orbit_states.length !== 1)) continue;

			let previous_states = new Set();
			let next_states = new Set();
			for (let previous_state of previous.pillbox_orbit_states) {
				for (let next_state of next.pillbox_orbit_states) {
					if (!pillbox_states_encode_offset(previous, previous_state,
						next, next_state)) continue;
					previous_states.add(previous_state);
					next_states.add(next_state);
				}
			}
			/* A contradiction can mean one provisional source attribution is
			 * wrong. Leave that for identity matching rather than deleting both
			 * state sets and turning a strong constraint into false certainty. */
			if (!previous_states.size || !next_states.size) continue;
			if (previous_states.size < previous.pillbox_orbit_states.length) {
				set_pillbox_orbit_states(previous, [...previous_states]);
				keep_pruning = true;
				changed = true;
			}
			if (next_states.size < next.pillbox_orbit_states.length) {
				set_pillbox_orbit_states(next, [...next_states]);
				keep_pruning = true;
				changed = true;
			}
		}
	}
	return changed;
}

function pillbox_shell_successor_states(previous, next, duration) {
	if (!previous.pillbox_orbit_states) return undefined;
	let relative_x = next.pixel_x - previous.pillbox_source_x;
	let relative_y = next.pixel_y - previous.pillbox_source_y;
	let expected_distance = duration * SHELL_SPEED_PIXELS_PER_TICK;
	let states_by_key = new Map();
	for (let previous_state of previous.pillbox_orbit_states) {
		let orbit = PILLBOX_ORBITS_BY_BRADIAN.get(previous_state.bradian);
		let previous_position = pillbox_orbit_position(orbit,
			previous_state.step);
		for (let step = previous_state.step + 1;
			step < orbit.positions.length; step++) {
			let position = orbit.positions[step];
			if (!pillbox_orbit_position_matches(position, relative_x, relative_y,
				next.position_uncertainty)) continue;
			let distance = Math.hypot(position[0] - previous_position[0],
				position[1] - previous_position[1]);
			let cost = Math.abs(distance - expected_distance);
			if (cost > SHELL_MATCH_ERROR_PIXELS) continue;
			let key = `${orbit.bradian}:${step}`;
			let existing = states_by_key.get(key);
			if (!existing || cost < existing.cost) {
				states_by_key.set(key, { bradian: orbit.bradian, step, cost });
			}
		}
	}
	return [...states_by_key.values()];
}

function pillbox_shell_terminal_match(previous, terminal, duration, start_time) {
	if (!previous.pillbox_orbit_states) return undefined;
	let matches = [];
	for (let previous_state of previous.pillbox_orbit_states) {
		let orbit = PILLBOX_ORBITS_BY_BRADIAN.get(previous_state.bradian);
		let previous_position = pillbox_orbit_position(orbit,
			previous_state.step);
		if (terminal.event_type === "shell_falls") {
			if (previous.pillbox_source_x + orbit.terminal[0] === terminal.pixel_x &&
				previous.pillbox_source_y + orbit.terminal[1] === terminal.pixel_y) {
				matches.push({
					bradian: orbit.bradian,
					step: orbit.positions.length,
					position: orbit.terminal,
					distance: Math.hypot(
						orbit.terminal[0] - previous_position[0],
						orbit.terminal[1] - previous_position[1]),
				});
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
			let distance = Math.hypot(position[0] - previous_position[0],
				position[1] - previous_position[1]);
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
function shell_ray_box_endpoint(shell, box,
	graze_tolerance = SHELL_BOX_GRAZE_TOLERANCE_PIXELS) {
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
	if (!closest || closest.graze_distance > graze_tolerance + 1e-9) {
		return null;
	}
	return closest;
}

/* A non-head shell-list member is reconstructed by adding independently
 * truncated offsets. Its reported coordinate is therefore a one-sided lower
 * bound, not an exact point. Pillbox shells resolve that bound against their
 * discrete orbits above; for a tracked tank shell, retain every integer point
 * in the small bound and derive the corresponding heading from the fixed tank
 * origin. This is used only when testing an authoritative terminal, where
 * treating the lower bound as exact can turn a real corner hit into a miss. */
function ordinary_shell_position_variants(shell) {
	let uncertainty = shell.birth_time === undefined ? 0 :
		Math.max(0, Math.floor(shell.position_uncertainty || 0));
	let base_pixel_x = shell.pixel_x;
	let base_pixel_y = shell.pixel_y;
	/* Bradian tracking may have recovered the exact coordinate already;
	 * the bound then needs no enumeration. */
	if (shell.tank_exact_pixel_x !== undefined) {
		base_pixel_x = shell.tank_exact_pixel_x;
		base_pixel_y = shell.tank_exact_pixel_y;
		uncertainty = 0;
	}
	let variants = [];
	for (let offset_x = 0; offset_x <= uncertainty; offset_x++) {
		for (let offset_y = 0; offset_y <= uncertainty; offset_y++) {
			let variant = {
				pixel_x: base_pixel_x + offset_x,
				pixel_y: base_pixel_y + offset_y,
				heading_x: shell.heading_x,
				heading_y: shell.heading_y,
				bounded_position: uncertainty > 0,
			};
			if (shell.heading_origin_x !== undefined) {
				let delta_x = variant.pixel_x - shell.heading_origin_x;
				let delta_y = variant.pixel_y - shell.heading_origin_y;
				let distance = Math.hypot(delta_x, delta_y);
				if (distance > 0) {
					variant.heading_x = delta_x / distance;
					variant.heading_y = delta_y / distance;
				}
			}
			variants.push(variant);
		}
	}
	return variants;
}

function shell_terminal_match(previous, terminal, duration, start_time) {
	if (terminal.direction !== null && terminal.direction !== previous.direction) return null;
	let pillbox_match = pillbox_shell_terminal_match(previous, terminal, duration,
		start_time);
	if (pillbox_match !== undefined) return pillbox_match;
	let expected_distance = duration * SHELL_SPEED_PIXELS_PER_TICK;
	/* A recovered exact trajectory can miss an authoritative object hit by
	 * about a pixel and a half, the same phenomenon SHELL_TANK_HIT_TOLERANCE
	 * covers where an exact pill orbit meets a reconstructed tank: the tile
	 * box is not quite the original collision shape. Only exact coordinates
	 * earn the wider graze; bounded ones already enumerate their slack. */
	let graze_tolerance = previous.tank_exact_pixel_x !== undefined
		? SHELL_TANK_HIT_TOLERANCE_PIXELS : SHELL_BOX_GRAZE_TOLERANCE_PIXELS;
	let matches = [];
	for (let variant of ordinary_shell_position_variants(previous)) {
		let endpoint, angle_error = 0;
		if (terminal.type === "box") {
			/* A tile/object event supplies timing and bounds, not an aim point.
			 * Without an already learned fine heading, centring the 4-bit sector
			 * would merely disguise a guess as smooth motion. */
			endpoint = shell_ray_box_endpoint(variant, terminal, graze_tolerance);
			if (!endpoint) continue;
		} else {
			let delta_x = terminal.pixel_x - variant.pixel_x;
			let delta_y = terminal.pixel_y - variant.pixel_y;
			let distance = Math.hypot(delta_x, delta_y);
			if (distance === 0) continue;
			let heading_x = variant.heading_x;
			let heading_y = variant.heading_y;
			if (heading_x === undefined) {
				let angle = previous.direction * Math.PI / 8;
				heading_x = Math.sin(angle);
				heading_y = -Math.cos(angle);
			}
			let forward = delta_x * heading_x + delta_y * heading_y;
			let lateral = Math.abs(delta_x * heading_y - delta_y * heading_x);
			if (forward <= 0) continue;
			angle_error = Math.atan2(lateral, forward);
			if (angle_error > SHELL_DIRECTION_TOLERANCE) continue;
			endpoint = {
				pixel_x: terminal.pixel_x, pixel_y: terminal.pixel_y, distance,
			};
		}
		if (endpoint.distance > expected_distance +
			SHELL_MATCH_ERROR_PIXELS) continue;
		matches.push({
			cost: Math.abs(endpoint.distance - expected_distance) +
				angle_error * expected_distance +
				(endpoint.graze_distance || 0),
			pixel_x: endpoint.pixel_x,
			pixel_y: endpoint.pixel_y,
			distance: endpoint.distance,
			graze_distance: endpoint.graze_distance || 0,
			bounded_position: variant.bounded_position,
		});
	}
	if (!matches.length) return null;
	matches.sort((first, second) => first.cost - second.cost);
	return matches[0];
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
		group.assigned += count;
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
					delta_x, delta_y, shell.position_uncertainty);
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
		set_pillbox_orbit_states(candidate.shell, candidate.orbit_states);
		if (candidate.distance > 0) {
			candidate.shell.heading_x = candidate.delta_x / candidate.distance;
			candidate.shell.heading_y = candidate.delta_y / candidate.distance;
		}
	}
	mark_unseen_pillbox_terminals(source_groups, next.terminals,
		maximum_distance);
	next.unclaimed_pillbox_sources = source_groups
		.filter(group => group.capacity > group.assigned)
		.map(group => ({ ...group, count: group.capacity - group.assigned }));
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
		set_tank_bradian_states(candidate.shell, initial_tank_bradian_states(
			candidate.group.direction, candidate.shell.pixel_x,
			candidate.shell.pixel_y,
			candidate.shell.position_uncertainty || 0));
	}
	next.unclaimed_tank_sources = source_groups
		.filter(group => group.capacity > group.assigned)
		.map(group => ({ ...group, count: group.capacity - group.assigned }));
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

	let next_pixel_x = next.pillbox_orbit_pixel_x ?? next.tank_exact_pixel_x ??
		next.pixel_x;
	let next_pixel_y = next.pillbox_orbit_pixel_y ?? next.tank_exact_pixel_y ??
		next.pixel_y;
	let delta_x = next_pixel_x - origin_x;
	let delta_y = next_pixel_y - origin_y;
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

/* Exact orbit uncertainty can leave several same-stream predecessors for a
 * shell restatement even though its pillbox source and surviving orbit
 * states are unambiguous. Preserve that shared provenance without claiming
 * any one shell-to-shell identity; a later frame can then narrow the orbit
 * and resume interpolation. */
function propagate_ambiguous_pillbox_orbits(target_groups, by_next,
	previous_shells) {
	let changed = false;
	for (let next_index = 0; next_index < target_groups.length; next_index++) {
		let target = target_groups[next_index].target;
		if (target.terminal || target.starts_at_pillbox) continue;
		let choices = by_next[next_index];
		if (!choices.length || choices.some(candidate =>
			!candidate.pillbox_orbit_states)) continue;
		let first_shell = previous_shells[choices[0].previous_index];
		if (first_shell.pillbox_source_x === undefined ||
			choices.some(candidate => !same_pillbox_stream(first_shell,
				previous_shells[candidate.previous_index]))) continue;

		let states_by_key = new Map();
		for (let candidate of choices) {
			for (let state of candidate.pillbox_orbit_states) {
				states_by_key.set(`${state.bradian}:${state.step}`, state);
			}
		}
		let old_source_x = target.pillbox_source_x;
		let old_source_y = target.pillbox_source_y;
		let old_states = target.pillbox_orbit_states
			? new Set(target.pillbox_orbit_states.map(state =>
				`${state.bradian}:${state.step}`)) : new Set();
		target.pillbox_source_x = first_shell.pillbox_source_x;
		target.pillbox_source_y = first_shell.pillbox_source_y;
		target.pillbox_source_distance = Math.hypot(
			target.pixel_x - first_shell.pillbox_source_x,
			target.pixel_y - first_shell.pillbox_source_y);
		set_pillbox_orbit_states(target, [...states_by_key.values()]);
		let new_states = target.pillbox_orbit_states;
		if (old_source_x !== target.pillbox_source_x ||
			old_source_y !== target.pillbox_source_y ||
			old_states.size !== new_states.length ||
			new_states.some(state =>
				!old_states.has(`${state.bradian}:${state.step}`))) changed = true;
	}
	return changed;
}

function constrain_pillbox_candidates_to_targets(by_previous, by_next) {
	let removed = new Set();
	let changed = false;
	for (let choices of by_next) {
		for (let candidate of choices) {
			let target_states = candidate.target.pillbox_orbit_states;
			if (candidate.target.terminal || !target_states ||
				!candidate.pillbox_orbit_states) continue;
			let allowed = new Set(target_states.map(state =>
				`${state.bradian}:${state.step}`));
			let states = candidate.pillbox_orbit_states.filter(state =>
				allowed.has(`${state.bradian}:${state.step}`));
			if (!states.length) removed.add(candidate);
			else if (states.length < candidate.pillbox_orbit_states.length) {
				candidate.pillbox_orbit_states = states;
				changed = true;
			}
		}
	}
	if (!removed.size) return changed;
	for (let i = 0; i < by_previous.length; i++) {
		by_previous[i] = by_previous[i].filter(candidate =>
			!removed.has(candidate));
	}
	for (let i = 0; i < by_next.length; i++) {
		by_next[i] = by_next[i].filter(candidate => !removed.has(candidate));
	}
	return true;
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
			if (!(candidate.graze_distance > 0) ||
				candidate.bounded_position) continue;
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
	for (let pass = 0; pass < 4; pass++) {
		let changed = propagate_ambiguous_pillbox_orbits(target_groups, by_next,
			previous.shells);
		if (refine_pillbox_orbits_from_shell_lists(next)) changed = true;
		if (constrain_pillbox_candidates_to_targets(by_previous, by_next)) {
			changed = true;
		}
		if (!changed) break;
		for (let choices of by_previous) choices.sort((a, b) => a.cost - b.cost);
		for (let choices of by_next) choices.sort((a, b) => a.cost - b.cost);
	}
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
		/* A mutually best real restatement is stronger evidence than a
		 * directionless impact for every known weapon stream. This was
		 * historically needed for dense pill bursts; bounded tank coordinates
		 * expose the same ambiguity when a shot passes close to an adjacent
		 * object before hitting the next one. */
		let previous_shell = previous.shells[previous_index];
		let bounded_tank_terminal = previous_shell.birth_time !== undefined &&
			choices.some(candidate => candidate.target.terminal &&
				candidate.bounded_position);
		let trusted_successor = choices.find(candidate =>
			!candidate.target.terminal &&
			(previous_shell.pillbox_source_x !== undefined ||
				bounded_tank_terminal) &&
			unambiguous_shell_successor(candidate,
				by_next[candidate.next_index], by_previous, previous.shells));
		let cheapest = trusted_successor || choices[0];
		let equivalents = choices.filter(candidate =>
			equivalent_shell_candidates(cheapest, candidate));
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
			let exact_endpoint = best.target.terminal ? null :
				common_pillbox_orbit_pixel(old_shell.pillbox_source_x,
					old_shell.pillbox_source_y,
					best.pillbox_orbit_states || []) ||
				tank_states_exact_pixel(best.tank_bradian_states);
			old_shell.next_time = best.end_time;
			old_shell.next_pixel_x = exact_endpoint
				? exact_endpoint[0] : best.pixel_x;
			old_shell.next_pixel_y = exact_endpoint
				? exact_endpoint[1] : best.pixel_y;
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
					set_pillbox_orbit_states(new_shell,
						best.pillbox_orbit_states);
				}
			}
			if (old_shell.birth_pixel_x !== undefined) {
				new_shell.birth_time = old_shell.birth_time;
				new_shell.birth_pixel_x = old_shell.birth_pixel_x;
				new_shell.birth_pixel_y = old_shell.birth_pixel_y;
			}
			if (best.tank_bradian_states) {
				set_tank_bradian_states(new_shell, best.tank_bradian_states);
			}
			old_shell.next_shell = new_shell;
			refine_shell_heading(old_shell, new_shell);
			apply_tank_bradian_heading(new_shell);
		}
	}
}

/* Ray reachability under a widened update window, for joins whose timing
 * the sender's clock has mangled. The windows and boxes are opened wide;
 * the test claims only that the position lies ahead on the shell's own
 * discrete track, not that the timing fits. */
function tank_states_reachable(end_shell, shell, duration) {
	let states = end_shell.tank_bradian_states;
	if (!states) return true;
	let uncertainty = shell.position_uncertainty || 0;
	let [obs_lo_x, obs_hi_x] = shell_internal_bounds(shell.pixel_x, uncertainty);
	let [obs_lo_y, obs_hi_y] = shell_internal_bounds(shell.pixel_y, uncertainty);
	let m_hi = Math.ceil(duration / TICKS_PER_SHELL_UPDATE) +
		DILATED_UPDATE_SLACK;
	let slack = 32;
	for (let state of states) {
		let [vx, vy] = TANK_SHELL_VELOCITIES[state.bradian];
		for (let m = 0; m <= m_hi; m++) {
			if (state.lo_x + m * vx <= obs_hi_x + slack &&
				state.hi_x + m * vx >= obs_lo_x - slack &&
				state.lo_y + m * vy <= obs_hi_y + slack &&
				state.hi_y + m * vy >= obs_lo_y - slack) return true;
		}
	}
	return false;
}

function pill_states_reachable(end_shell, shell, duration) {
	let states = end_shell.pillbox_orbit_states;
	if (!states || end_shell.pillbox_source_x === undefined) return true;
	let m_hi = Math.ceil(duration / TICKS_PER_SHELL_UPDATE) +
		DILATED_UPDATE_SLACK;
	let relative_x = shell.pixel_x - end_shell.pillbox_source_x;
	let relative_y = shell.pixel_y - end_shell.pillbox_source_y;
	let uncertainty = shell.position_uncertainty || 0;
	for (let state of states) {
		let orbit = PILLBOX_ORBITS_BY_BRADIAN.get(state.bradian);
		let last = Math.min(orbit.positions.length - 1, state.step + m_hi);
		for (let step = state.step; step <= last; step++) {
			/* The widening is in time only: a pill shell's position must
			 * still be EXACTLY an orbit point within its quantisation
			 * bound, or the orbit table's power is thrown away. */
			if (pillbox_orbit_position_matches(orbit.positions[step],
				relative_x, relative_y, uncertainty)) return true;
		}
	}
	return false;
}

/* A join the ordinary physics refused, admissible only because the
 * sender's record clock is known to lie: the start must sit forward on
 * the end's ray within stall-to-catch-up bounds, and be reachable on the
 * end's discrete track under the widened window. The penalty keeps every
 * ordinary story preferred, and the resolver's margins arbitrate what
 * remains. */
function dilated_join_candidate(end, start) {
	let duration = start.time - end.time;
	if (duration <= 0 || duration > MAX_SHELL_INTERPOLATION_TICKS) return null;
	let end_shell = end.shell;
	let shell = start.shell;
	if (shell.direction !== end_shell.direction) return null;
	if (shell.pillbox_source_x !== undefined &&
		(shell.pillbox_source_x !== end_shell.pillbox_source_x ||
			shell.pillbox_source_y !== end_shell.pillbox_source_y)) return null;
	if (end_shell.birth_time !== undefined &&
		start.time - end_shell.birth_time > TANK_SHELL_FLIGHT_LIMIT_TICKS) {
		return null;
	}
	let heading_x = end_shell.heading_x;
	let heading_y = end_shell.heading_y;
	if (heading_x === undefined) {
		let angle = end_shell.direction * Math.PI / 8;
		heading_x = Math.sin(angle);
		heading_y = -Math.cos(angle);
	}
	let delta_x = shell.pixel_x - end_shell.pixel_x;
	let delta_y = shell.pixel_y - end_shell.pixel_y;
	let along = delta_x * heading_x + delta_y * heading_y;
	let lateral = Math.abs(delta_x * heading_y - delta_y * heading_x);
	if (lateral > ABSORB_LATERAL_TOLERANCE_PIXELS +
		(shell.position_uncertainty || 0) +
		(end_shell.position_uncertainty || 0)) return null;
	let expected = duration * SHELL_SPEED_PIXELS_PER_TICK;
	if (along < -1 || along > expected + DILATED_CATCHUP_PIXELS) return null;
	if (!tank_states_reachable(end_shell, shell, duration) ||
		!pill_states_reachable(end_shell, shell, duration)) return null;
	return {
		end, start, duration, dilated: true, heading_x, heading_y,
		cost: DILATED_JOIN_PENALTY_PIXELS + lateral +
			Math.abs(along - expected) / 4,
	};
}

/* A draw-only continuation: the sprite carries on, but no identity is
 * claimed and no origin propagates, because several same-ray stories
 * remain inside the margin and all of them draw this way. Better one of
 * the near-identical stories than a vanish-and-reappear that matches
 * none of them. */
function apply_visual_join(candidate) {
	let end_shell = candidate.end.shell;
	let start_shell = candidate.start.shell;
	end_shell.next_time = candidate.start.time;
	end_shell.next_pixel_x = start_shell.pixel_x;
	end_shell.next_pixel_y = start_shell.pixel_y;
	end_shell.next_terminal = false;
	end_shell.next_shell = start_shell;
	start_shell.matched_from_previous = true;
	start_shell.stitched = true;
	start_shell.visual_join = true;
}

/* Carry an origin down a chain: the linked observations are one shell, so
 * the origin belongs to every one of them. Links made by ordinary
 * matching and by stitches both record next_shell, so the walk is direct. */
function propagate_identity_down_chain(origin_shell, first_shell) {
	for (let walk = first_shell; walk; walk = walk.next_shell) {
		if (origin_shell.pillbox_source_x !== undefined &&
			walk.pillbox_source_x === undefined) {
			walk.pillbox_source_x = origin_shell.pillbox_source_x;
			walk.pillbox_source_y = origin_shell.pillbox_source_y;
			walk.pillbox_source_distance = Math.hypot(
				walk.pixel_x - walk.pillbox_source_x,
				walk.pixel_y - walk.pillbox_source_y);
		}
		if (origin_shell.birth_pixel_x !== undefined &&
			walk.birth_time === undefined) {
			walk.birth_time = origin_shell.birth_time;
			walk.birth_pixel_x = origin_shell.birth_pixel_x;
			walk.birth_pixel_y = origin_shell.birth_pixel_y;
		}
	}
}

/* One end-to-start continuation candidate, or null. Shared between the
 * margin-based stitching pass and the forced-assignment residual pass. */
function stitch_candidate(end, start) {
	let duration = start.time - end.time;
	if (duration <= 0 || duration > MAX_STITCH_GAP_TICKS) return null;
	if (end.shell.birth_time !== undefined &&
		start.time - end.shell.birth_time >
			TANK_SHELL_FLIGHT_LIMIT_TICKS) return null;
	/* A start already claimed by a different pill stream through
	 * ambiguity propagation is not this shell's continuation. */
	if (start.shell.pillbox_source_x !== undefined &&
		(start.shell.pillbox_source_x !== end.shell.pillbox_source_x ||
			start.shell.pillbox_source_y !== end.shell.pillbox_source_y)) {
		return null;
	}
	let match = shell_match_cost(end.shell, start.shell, duration);
	if (!match) return null;
	if (!match.pillbox_orbit_states && !match.tank_bradian_states &&
		duration > MAX_SHELL_INTERPOLATION_TICKS) return null;
	return { end, start, duration, ...match };
}

function apply_stitch(candidate) {
	let end_shell = candidate.end.shell;
	let start_shell = candidate.start.shell;
	let exact = null;
	if (candidate.pillbox_orbit_states &&
		end_shell.pillbox_source_x !== undefined) {
		exact = common_pillbox_orbit_pixel(end_shell.pillbox_source_x,
			end_shell.pillbox_source_y, candidate.pillbox_orbit_states);
	}
	if (!exact) exact = tank_states_exact_pixel(candidate.tank_bradian_states);
	end_shell.next_time = candidate.start.time;
	end_shell.next_pixel_x = exact ? exact[0] : start_shell.pixel_x;
	end_shell.next_pixel_y = exact ? exact[1] : start_shell.pixel_y;
	end_shell.next_terminal = false;
	end_shell.next_shell = start_shell;
	start_shell.matched_from_previous = true;
	start_shell.stitched = true;
	propagate_identity_down_chain(end_shell, start_shell);
	if (candidate.pillbox_orbit_states) {
		set_pillbox_orbit_states(start_shell, candidate.pillbox_orbit_states);
	} else if (candidate.tank_bradian_states) {
		set_tank_bradian_states(start_shell, candidate.tank_bradian_states);
	}
	refine_shell_heading(end_shell, start_shell);
	apply_tank_bradian_heading(start_shell);
}

/* A stitch may bridge over restatements of the very shell it reconnects:
 * a lagging sender's record timestamps drift against its simulation, so
 * an intermediate observation can fail every pairwise distance test while
 * lying exactly on the stitched path. Left out, it renders as a phantom
 * second shell. Claim every unmatched, origin-less observation between
 * the stitch's endpoints that sits on the segment (within its one-sided
 * quantisation bound), and thread it into the chain in time order. */
function absorb_intermediate_observations(snapshots, end, start) {
	let end_shell = end.shell;
	let anchor_x = end_shell.pillbox_orbit_pixel_x ??
		end_shell.tank_exact_pixel_x ?? end_shell.pixel_x;
	let anchor_y = end_shell.pillbox_orbit_pixel_y ??
		end_shell.tank_exact_pixel_y ?? end_shell.pixel_y;
	let target_x = end_shell.next_pixel_x;
	let target_y = end_shell.next_pixel_y;
	let segment_x = target_x - anchor_x;
	let segment_y = target_y - anchor_y;
	let length = Math.hypot(segment_x, segment_y);
	if (length <= 1e-9) return;

	let absorbed = [];
	for (let snapshot of snapshots) {
		if (snapshot.time <= end.time) continue;
		if (snapshot.time >= end_shell.next_time) break;
		for (let shell of snapshot.shells) {
			if (shell.next_time !== undefined || shell.matched_from_previous ||
				shell.starts_at_tank || shell.starts_at_pillbox ||
				shell.direction !== end_shell.direction) continue;
			let relative_x = shell.pixel_x - anchor_x;
			let relative_y = shell.pixel_y - anchor_y;
			let along = (relative_x * segment_x + relative_y * segment_y) / length;
			if (along < -4 || along > length + 4) continue;
			let lateral = Math.abs(relative_x * segment_y -
				relative_y * segment_x) / length;
			if (lateral > ABSORB_LATERAL_TOLERANCE_PIXELS +
				(shell.position_uncertainty || 0)) continue;
			/* Being on the segment is not enough: a dense pill stream lays
			 * trailing shells exactly on a leading shell's path. The same
			 * shell must also be roughly where uniform time puts it. */
			let expected_along = (snapshot.time - end.time) *
				SHELL_SPEED_PIXELS_PER_TICK;
			if (Math.abs(along - expected_along) >
				MAX_SMOOTHING_DEVIATION_PIXELS) continue;
			absorbed.push({ shell, time: snapshot.time });
		}
	}
	if (!absorbed.length) return;
	absorbed.sort((a, b) => a.time - b.time);

	let final_time = end_shell.next_time;
	let final_next_shell = end_shell.next_shell;
	let previous = end_shell;
	for (let observation of absorbed) {
		previous.next_time = observation.time;
		previous.next_pixel_x = observation.shell.pixel_x;
		previous.next_pixel_y = observation.shell.pixel_y;
		previous.next_terminal = false;
		previous.next_shell = observation.shell;
		observation.shell.matched_from_previous = true;
		observation.shell.stitched = true;
		propagate_identity_down_chain(end_shell, observation.shell);
		previous = observation.shell;
	}
	previous.next_time = final_time;
	previous.next_pixel_x = target_x;
	previous.next_pixel_y = target_y;
	previous.next_terminal = false;
	previous.next_shell = final_next_shell;
}

/* Second pass over one client's snapshots: reconnect chain fragments the
 * pairwise matcher left apart. Fragments arise when a link failed on a
 * margin ambiguity that later assignments have since resolved, and when
 * packet lag stretched a restatement gap past the pairwise window, which
 * splits every in-flight shell of that sender at once. Only chain ends
 * and origin-less chain starts participate: a start with its own birth is
 * a new shot, not a continuation. Physics decides compatibility through
 * the ordinary match cost (orbit states, bradian states, or geometry);
 * a fragment's true continuation is its next appearance, so each end
 * considers only its earliest reachable starts, with the usual margin
 * against same-time contenders and against rival ends. */
function stitch_shell_chains(snapshots) {
	let ends = [];
	let starts = [];
	for (let index = 0; index < snapshots.length; index++) {
		let snapshot = snapshots[index];
		let final = index === snapshots.length - 1;
		for (let shell of snapshot.shells) {
			if (shell.next_time === undefined && !final) {
				ends.push({ shell, time: snapshot.time });
			}
			if (index > 0 && !shell.matched_from_previous &&
				!shell.starts_at_tank && !shell.starts_at_pillbox) {
				starts.push({ shell, time: snapshot.time });
			}
		}
	}
	if (!ends.length || !starts.length) return;
	ends.sort((a, b) => a.time - b.time);

	let by_end = new Map();
	let by_start = new Map();
	for (let end of ends) {
		for (let start of starts) {
			let candidate = stitch_candidate(end, start);
			if (!candidate) continue;
			if (!by_end.has(end)) by_end.set(end, []);
			by_end.get(end).push(candidate);
			if (!by_start.has(start)) by_start.set(start, []);
			by_start.get(start).push(candidate);
		}
	}

	let used_ends = new Set();
	let used_starts = new Set();
	let changed = true;
	while (changed) {
		changed = false;
		for (let end of ends) {
			if (used_ends.has(end)) continue;
			/* Absorption may have consumed this end or a start already. */
			if (end.shell.next_time !== undefined) {
				used_ends.add(end);
				continue;
			}
			let open = (by_end.get(end) || []).filter(candidate =>
				!used_starts.has(candidate.start) &&
				!candidate.start.shell.matched_from_previous);
			if (!open.length) continue;
			/* The shell's true continuation is its next appearance; later
			 * valid starts along the same track are the same shell again,
			 * not competitors. */
			let earliest = Math.min(...open.map(candidate => candidate.start.time));
			let contenders = open.filter(candidate =>
				candidate.start.time === earliest);
			contenders.sort((a, b) => a.cost - b.cost);
			let best = contenders[0];
			if (contenders[1] &&
				contenders[1].cost - best.cost < SHELL_MATCH_MARGIN) continue;
			let rivals = by_start.get(best.start).filter(candidate =>
				candidate.end !== end && !used_ends.has(candidate.end) &&
				candidate.end.shell.next_time === undefined);
			if (rivals.some(rival =>
				rival.cost - best.cost < SHELL_MATCH_MARGIN)) continue;
			apply_stitch(best);
			absorb_intermediate_observations(snapshots, end, best.start);
			used_ends.add(end);
			used_starts.add(best.start);
			changed = true;
		}
	}
}

/* ---- residual resolution: forced assignments over what is left -------
 *
 * After matching and stitching, one client's leftovers form a bipartite
 * problem: SUPPLIERS of a shell identity (chain ends whose shell went
 * unaccounted, and fired shots no shell was matched to) against CONSUMERS
 * of one (origin-less chain starts, and unexplained impact events, since
 * every observed start and every impact was *some* shell). An assignment
 * is accepted only when it is FORCED: present in every maximum
 * assignment, tested by whether deleting the edge reduces the maximum
 * flow. This is the safe core of the issue #15 parsimony idea -- what is
 * ambiguous stays unexplained, but what has only one consistent story
 * gets that story, including conclusions the pairwise margins could not
 * reach because they cannot see that a rival candidate is itself needed
 * elsewhere. */

/* Minimum-cost maximum flow on one small component, by successive
 * shortest augmenting paths (Bellman-Ford over the residual graph; the
 * components are tiny, so no potentials are needed). Nodes are the left
 * groups, the right groups, a source and a sink; costs sit on the
 * left-to-right edges only. `skip` zeroes one edge's capacity for the
 * counterfactual tests. */
function component_min_cost_flow(left_caps, right_caps, edges, skip) {
	let left_count = left_caps.length;
	let node_count = left_count + right_caps.length + 2;
	let source = node_count - 2;
	let sink = node_count - 1;
	let arcs = [];
	let add_arc = (from, to, cap, cost) => {
		arcs.push({ from, to, cap, cost, flow: 0 });
		arcs.push({ from: to, to: from, cap: 0, cost: -cost, flow: 0 });
	};
	for (let l = 0; l < left_count; l++) add_arc(source, l, left_caps[l], 0);
	for (let r = 0; r < right_caps.length; r++) {
		add_arc(left_count + r, sink, right_caps[r], 0);
	}
	let middle = [];
	for (let i = 0; i < edges.length; i++) {
		middle.push(arcs.length);
		add_arc(edges[i].left, left_count + edges[i].right,
			i === skip ? 0 : Math.min(left_caps[edges[i].left],
				right_caps[edges[i].right]),
			edges[i].cost || 0);
	}

	let value = 0;
	let total_cost = 0;
	for (;;) {
		let dist = new Array(node_count).fill(Infinity);
		let via = new Array(node_count).fill(-1);
		dist[source] = 0;
		for (let iteration = 0; iteration < node_count; iteration++) {
			let changed = false;
			for (let a = 0; a < arcs.length; a++) {
				let arc = arcs[a];
				if (arc.cap - arc.flow <= 0 || dist[arc.from] === Infinity) {
					continue;
				}
				if (dist[arc.from] + arc.cost < dist[arc.to] - 1e-9) {
					dist[arc.to] = dist[arc.from] + arc.cost;
					via[arc.to] = a;
					changed = true;
				}
			}
			if (!changed) break;
		}
		if (via[sink] < 0) break;
		let bottleneck = Infinity;
		for (let node = sink; node !== source;) {
			let arc = arcs[via[node]];
			bottleneck = Math.min(bottleneck, arc.cap - arc.flow);
			node = arc.from;
		}
		for (let node = sink; node !== source;) {
			let index = via[node];
			arcs[index].flow += bottleneck;
			arcs[index ^ 1].flow -= bottleneck;
			node = arcs[index].from;
		}
		value += bottleneck;
		total_cost += dist[sink] * bottleneck;
	}
	return {
		value,
		cost: total_cost,
		edge_flow: middle.map(a => arcs[a].flow),
	};
}

/* Split the graph into connected components and, per component, keep the
 * assignments every good story agrees on: an edge is accepted when
 * removing it reduces the maximum number of explanations (forced), or
 * when the best assignment without it costs more than the margin extra
 * (cost-forced -- the rival stories are all strictly worse). What
 * remains genuinely close stays unexplained. */
function forced_bipartite_assignments(lefts, rights, edges) {
	if (!edges.length) return [];
	let parent = Array.from({ length: lefts.length + rights.length },
		(_, i) => i);
	let find = node => {
		while (parent[node] !== node) {
			parent[node] = parent[parent[node]];
			node = parent[node];
		}
		return node;
	};
	for (let edge of edges) {
		let a = find(edge.left);
		let b = find(lefts.length + edge.right);
		if (a !== b) parent[a] = b;
	}
	let components = new Map();
	for (let i = 0; i < edges.length; i++) {
		let root = find(edges[i].left);
		if (!components.has(root)) components.set(root, []);
		components.get(root).push(i);
	}

	let results = [];
	for (let edge_indices of components.values()) {
		/* A pathological component is left unresolved rather than solved
		 * slowly; measured components stay well under this. */
		if (edge_indices.length > 400) continue;
		let left_ids = [...new Set(edge_indices.map(i => edges[i].left))];
		let right_ids = [...new Set(edge_indices.map(i => edges[i].right))];
		let left_map = new Map(left_ids.map((id, i) => [id, i]));
		let right_map = new Map(right_ids.map((id, i) => [id, i]));
		let local_edges = edge_indices.map(i => ({
			left: left_map.get(edges[i].left),
			right: right_map.get(edges[i].right),
			cost: edges[i].cost || 0,
		}));
		let left_caps = left_ids.map(id => lefts[id].count);
		let right_caps = right_ids.map(id => rights[id].count);
		let full = component_min_cost_flow(left_caps, right_caps,
			local_edges, -1);
		for (let i = 0; i < local_edges.length; i++) {
			if (full.edge_flow[i] <= 0) continue;
			let reduced = component_min_cost_flow(left_caps, right_caps,
				local_edges, i);
			if (reduced.value < full.value) {
				results.push({
					edge: edges[edge_indices[i]],
					units: full.value - reduced.value,
				});
			} else if (reduced.cost - full.cost > RESIDUAL_COST_MARGIN) {
				results.push({
					edge: edges[edge_indices[i]],
					units: full.edge_flow[i],
				});
			}
		}
	}
	return results;
}

function group_shot_sources(sources) {
	let groups = [];
	for (let source of sources || []) {
		let group = groups.find(item => item.pixel_x === source.pixel_x &&
			item.pixel_y === source.pixel_y &&
			item.direction === source.direction);
		if (group) group.count++;
		else groups.push({ ...source, count: 1 });
	}
	return groups;
}

/* Can this unconsumed shot explain an origin-less chain start? Exact
 * orbit membership decides for a pill; sector geometry for a tank. */
function creation_start_match(creation, start) {
	let duration = start.time - creation.time;
	if (duration < 0 || duration > MAX_STITCH_GAP_TICKS) return null;
	let shell = start.shell;
	if (shell.direction !== creation.direction) return null;
	let origins = [[creation.pixel_x, creation.pixel_y]];
	if (creation.alternate_pixel_x !== undefined) {
		origins.push([creation.alternate_pixel_x, creation.alternate_pixel_y]);
	}
	for (let [origin_x, origin_y] of origins) {
		let delta_x = shell.pixel_x - origin_x;
		let delta_y = shell.pixel_y - origin_y;
		let distance = Math.hypot(delta_x, delta_y);
		if (distance <= 1e-9 ||
			distance > SHELL_RANGE_PIXELS + SHELL_MATCH_ERROR_PIXELS ||
			Math.abs(distance - duration * SHELL_SPEED_PIXELS_PER_TICK) >
				SHELL_MATCH_ERROR_PIXELS * 2) continue;
		let cost = Math.abs(distance -
			duration * SHELL_SPEED_PIXELS_PER_TICK);
		if (creation.kind === "pill") {
			let states = pillbox_orbit_states_at(creation.direction,
				delta_x, delta_y, shell.position_uncertainty || 0);
			if (!states.length) continue;
			return { origin_x, origin_y, distance, delta_x, delta_y, states,
				cost };
		}
		let angle = creation.direction * Math.PI / 8;
		let forward = delta_x * Math.sin(angle) - delta_y * Math.cos(angle);
		let lateral = Math.abs(delta_x * Math.cos(angle) +
			delta_y * Math.sin(angle));
		if (forward <= 0 ||
			Math.atan2(lateral, forward) > SHELL_DIRECTION_TOLERANCE) continue;
		return { origin_x, origin_y, distance, delta_x, delta_y, cost };
	}
	return null;
}

/* Can this unconsumed shot have flown, unobserved, into this impact? */
function creation_fate_match(creation, fate) {
	let terminal = fate.terminals[0];
	let duration = fate.time - creation.time;
	if (duration <= 0 || duration > MAX_STITCH_GAP_TICKS) return null;
	if (terminal.direction !== null && terminal.direction !== undefined &&
		terminal.direction !== creation.direction) return null;
	let reach = Math.min(duration * SHELL_SPEED_PIXELS_PER_TICK,
		SHELL_RANGE_PIXELS) + SHELL_MATCH_ERROR_PIXELS;
	if (creation.kind === "pill") {
		let distance = pillbox_source_terminal_distance(creation, terminal);
		if (distance === null || distance > reach) return null;
		if (duration - distance / SHELL_SPEED_PIXELS_PER_TICK >
			MAX_FATE_EVENT_LAG_TICKS) return null;
		return { distance, cost: Math.abs(distance -
			duration * SHELL_SPEED_PIXELS_PER_TICK) / 2 };
	}
	let target_x, target_y, slack;
	if (terminal.type === "point") {
		target_x = terminal.pixel_x + 8;
		target_y = terminal.pixel_y + 8;
		slack = 4;
	} else {
		target_x = (terminal.min_x + terminal.max_x) / 2;
		target_y = (terminal.min_y + terminal.max_y) / 2;
		slack = 12;
	}
	let delta_x = target_x - (creation.pixel_x + 8);
	let delta_y = target_y - (creation.pixel_y + 8);
	let distance = Math.hypot(delta_x, delta_y);
	if (distance > reach + slack) return null;
	if (duration - distance / SHELL_SPEED_PIXELS_PER_TICK >
		MAX_FATE_EVENT_LAG_TICKS) return null;
	if (distance > slack) {
		let angle = creation.direction * Math.PI / 8;
		let forward = delta_x * Math.sin(angle) - delta_y * Math.cos(angle);
		let lateral = Math.abs(delta_x * Math.cos(angle) +
			delta_y * Math.sin(angle));
		if (forward <= 0 || Math.atan2(lateral, forward) >
			SHELL_DIRECTION_TOLERANCE + Math.atan2(slack, distance)) return null;
	}
	return { distance, cost: Math.abs(distance -
		duration * SHELL_SPEED_PIXELS_PER_TICK) / 2 };
}

function apply_forced_terminal(end, fate, match) {
	let terminal = fate.terminals.find(item => item.match_time === undefined);
	if (!terminal) return;
	let end_time = Math.min(fate.time,
		end.time + match.distance / SHELL_SPEED_PIXELS_PER_TICK);
	let shell = end.shell;
	shell.next_time = end_time;
	shell.next_pixel_x = match.pixel_x;
	shell.next_pixel_y = match.pixel_y;
	shell.next_terminal = true;
	shell.next_terminal_type = terminal.type;
	shell.next_terminal_event_type = terminal.event_type;
	terminal.match_time = end_time;
	if (terminal.effect) {
		terminal.effect.time = end_time;
		if (match.hitbox_pixel_x !== undefined) {
			terminal.effect.x = Math.floor(match.hitbox_pixel_x / 16);
			terminal.effect.y = Math.floor(match.hitbox_pixel_y / 16);
			terminal.effect.px = match.hitbox_pixel_x - terminal.effect.x * 16;
			terminal.effect.py = match.hitbox_pixel_y - terminal.effect.y * 16;
		}
	}
}

function apply_forced_origin(creation, start, match) {
	let shell = start.shell;
	if (match.distance > 0) {
		shell.heading_x = match.delta_x / match.distance;
		shell.heading_y = match.delta_y / match.distance;
	}
	shell.heading_origin_x = match.origin_x;
	shell.heading_origin_y = match.origin_y;
	if (creation.kind === "pill") {
		shell.starts_at_pillbox = true;
		shell.pillbox_source_x = match.origin_x;
		shell.pillbox_source_y = match.origin_y;
		shell.pillbox_source_distance = match.distance;
		set_pillbox_orbit_states(shell, match.states);
	} else {
		shell.starts_at_tank = true;
		shell.birth_time = start.time -
			match.distance / SHELL_SPEED_PIXELS_PER_TICK;
		shell.birth_pixel_x = match.origin_x;
		shell.birth_pixel_y = match.origin_y;
		set_tank_bradian_states(shell, initial_tank_bradian_states(
			creation.direction, shell.pixel_x, shell.pixel_y,
			shell.position_uncertainty || 0));
	}
	propagate_identity_down_chain(shell, shell.next_shell);
}

/* An impact with no observed shell, forced onto a fired shot: mark the
 * terminal's source the way count-forced pill terminals already are, so
 * it stops being an open question without claiming a drawn shell. */
function apply_forced_unseen(creation, fate, units) {
	let applied = 0;
	for (let terminal of fate.terminals) {
		if (applied >= units) break;
		if (terminal.match_time !== undefined) continue;
		if (creation.kind === "pill") {
			if (terminal.unseen_pillbox_source) continue;
			terminal.unseen_pillbox_source = true;
			terminal.pillbox_source_x = creation.pixel_x;
			terminal.pillbox_source_y = creation.pixel_y;
			terminal.pillbox_source_direction = creation.direction;
		} else {
			if (terminal.unseen_tank_source) continue;
			terminal.unseen_tank_source = true;
			terminal.tank_source_x = creation.pixel_x;
			terminal.tank_source_y = creation.pixel_y;
			terminal.tank_source_direction = creation.direction;
		}
		applied++;
	}
}

function resolve_residual_shell_fates(snapshots) {
	let ends = [];
	let starts = [];
	let fate_groups = [];
	let creation_groups = [];
	for (let index = 0; index < snapshots.length; index++) {
		let snapshot = snapshots[index];
		let final = index === snapshots.length - 1;
		for (let shell of snapshot.shells) {
			if (shell.next_time === undefined && !final) {
				ends.push({ shell, time: snapshot.time });
			}
			if (index > 0 && !shell.matched_from_previous &&
				!shell.starts_at_tank && !shell.starts_at_pillbox) {
				starts.push({ shell, time: snapshot.time });
			}
		}
		for (let terminal of snapshot.terminals) {
			if (terminal.match_time !== undefined ||
				terminal.unseen_pillbox_source) continue;
			let group = fate_groups.find(item => item.time === snapshot.time &&
				same_shell_terminal(item.terminals[0], terminal));
			if (group) group.terminals.push(terminal);
			else fate_groups.push({ time: snapshot.time, terminals: [terminal] });
		}
		let pill_sources = snapshot.unclaimed_pillbox_sources ??
			group_shot_sources(snapshot.pillbox_sources);
		for (let source of pill_sources) {
			creation_groups.push({ kind: "pill", time: snapshot.time, ...source });
		}
		let tank_sources = snapshot.unclaimed_tank_sources ??
			group_shot_sources(snapshot.tank_sources);
		for (let source of tank_sources) {
			creation_groups.push({ kind: "tank", time: snapshot.time, ...source });
		}
	}
	if ((!ends.length && !creation_groups.length) ||
		(!starts.length && !fate_groups.length)) return;

	let lefts = [];
	let rights = [];
	for (let end of ends) lefts.push({ kind: "end", end, count: 1 });
	for (let creation of creation_groups) {
		lefts.push({ kind: "creation", creation, count: creation.count });
	}
	for (let start of starts) rights.push({ kind: "start", start, count: 1 });
	for (let fate of fate_groups) {
		rights.push({ kind: "fate", fate, count: fate.terminals.length });
	}

	let edges = [];
	for (let li = 0; li < lefts.length; li++) {
		let left = lefts[li];
		for (let ri = 0; ri < rights.length; ri++) {
			let right = rights[ri];
			if (left.kind === "end" && right.kind === "start") {
				let candidate = stitch_candidate(left.end, right.start) ||
					dilated_join_candidate(left.end, right.start);
				if (candidate) {
					edges.push({ left: li, right: ri, candidate,
						cost: candidate.cost });
				}
			} else if (left.kind === "end") {
				let duration = right.fate.time - left.end.time;
				if (duration <= 0 ||
					duration > MAX_SHELL_INTERPOLATION_TICKS) continue;
				let match = shell_terminal_match(left.end.shell,
					right.fate.terminals[0], duration, left.end.time);
				/* The event may trail the inferred arrival, but not by more
				 * than ordinary event lag: a distant late event is more
				 * likely another shell's than a record delayed this long. */
				if (match && duration -
					match.distance / SHELL_SPEED_PIXELS_PER_TICK <=
						MAX_FATE_EVENT_LAG_TICKS) {
					edges.push({ left: li, right: ri, match, cost: match.cost });
				}
			} else if (right.kind === "start") {
				let match = creation_start_match(left.creation, right.start);
				if (match) {
					edges.push({ left: li, right: ri, match, cost: match.cost });
				}
			} else {
				let match = creation_fate_match(left.creation, right.fate);
				if (match) {
					edges.push({ left: li, right: ri, match, cost: match.cost });
				}
			}
		}
	}

	let assignments = forced_bipartite_assignments(lefts, rights, edges);
	/* Observed shells claim terminals before unseen shots mark leftovers. */
	assignments.sort((a, b) =>
		(lefts[a.edge.left].kind === "creation") -
		(lefts[b.edge.left].kind === "creation"));
	for (let { edge, units } of assignments) {
		let left = lefts[edge.left];
		let right = rights[edge.right];
		if (left.kind === "end" && right.kind === "start") {
			if (left.end.shell.next_time !== undefined ||
				right.start.shell.matched_from_previous) continue;
			apply_stitch(edge.candidate);
			absorb_intermediate_observations(snapshots, left.end, right.start);
		} else if (left.kind === "end") {
			if (left.end.shell.next_time !== undefined) continue;
			apply_forced_terminal(left.end, right.fate, edge.match);
		} else if (right.kind === "start") {
			if (right.start.shell.matched_from_previous ||
				right.start.shell.starts_at_tank ||
				right.start.shell.starts_at_pillbox) continue;
			apply_forced_origin(left.creation, right.start, edge.match);
		} else {
			apply_forced_unseen(left.creation, right.fate, units);
		}
	}

	/* Visual joins over whatever margins refused. When every remaining
	 * story for an appearance is a same-ray continuation of some vanished
	 * shell -- no fired shot could explain it, and no still-open impact
	 * competes for its cheapest predecessor -- link the cheapest pair for
	 * drawing only. Rival same-ray stories draw the same; a rival on a
	 * genuinely different ray, a plausible creation, or a nearby fate
	 * story keeps the pop instead. */
	let joins_by_start = new Map();
	let creation_cost_by_start = new Map();
	let fate_cost_by_end = new Map();
	for (let edge of edges) {
		let left = lefts[edge.left];
		let right = rights[edge.right];
		if (left.kind === "end" && right.kind === "start") {
			if (!joins_by_start.has(right.start)) {
				joins_by_start.set(right.start, []);
			}
			joins_by_start.get(right.start).push(edge);
		} else if (left.kind === "creation" && right.kind === "start") {
			let best = creation_cost_by_start.get(right.start);
			if (best === undefined || edge.cost < best) {
				creation_cost_by_start.set(right.start, edge.cost);
			}
		} else if (left.kind === "end" && right.kind === "fate") {
			if (!right.fate.terminals.some(terminal =>
				terminal.match_time === undefined &&
				!terminal.unseen_pillbox_source &&
				!terminal.unseen_tank_source)) continue;
			let best = fate_cost_by_end.get(left.end);
			if (best === undefined || edge.cost < best) {
				fate_cost_by_end.set(left.end, edge.cost);
			}
		}
	}
	for (let [start, joins] of joins_by_start) {
		if (start.shell.matched_from_previous) continue;
		let open = joins.filter(edge =>
			lefts[edge.left].end.shell.next_time === undefined);
		if (!open.length) continue;
		open.sort((a, b) => a.cost - b.cost);
		let best = open[0];
		let creation_cost = creation_cost_by_start.get(start);
		if (creation_cost !== undefined &&
			creation_cost < best.cost + RESIDUAL_COST_MARGIN) continue;
		let best_end = lefts[best.left].end;
		let fate_cost = fate_cost_by_end.get(best_end);
		if (fate_cost !== undefined &&
			fate_cost < best.cost + RESIDUAL_COST_MARGIN) continue;
		/* Same-ray check on the rivals inside the margin: their ends'
		 * headings must agree with the winner's, or the stories genuinely
		 * diverge and the pop stands. */
		let best_candidate = best.candidate;
		let heading_x = best_candidate.heading_x ??
			best_end.shell.heading_x;
		let heading_y = best_candidate.heading_y ??
			best_end.shell.heading_y;
		let divergent = open.some(edge => {
			if (edge === best ||
				edge.cost - best.cost >= RESIDUAL_COST_MARGIN) return false;
			let rival = lefts[edge.left].end.shell;
			if (rival.heading_x === undefined ||
				heading_x === undefined) return false;
			return rival.heading_x * heading_x +
				rival.heading_y * heading_y < 0.9986;
		});
		if (divergent) continue;
		apply_visual_join(best_candidate);
	}
}

/* Shells fly at exactly one speed, so any unevenness along a chain is
 * timestamp jitter or pixel quantisation, not motion. For drawing only,
 * re-time each chain of three or more restatements to constant velocity
 * between its end anchors: interior observations get a smoothed position
 * on the anchor line at their timestamp, and each link aims at the
 * successor's smoothed position. Packet-exact state, matcher artifacts
 * and terminal endpoints are untouched; a chain whose interior strays
 * further from the uniform reading than record lag explains is left
 * as observed. */
function smooth_shell_chains(snapshots) {
	for (let snapshot of snapshots) {
		for (let shell of snapshot.shells) {
			if (shell.matched_from_previous) continue;
			let entries = [{ shell, time: snapshot.time }];
			let walk = shell;
			while (walk.next_shell && !walk.next_terminal) {
				entries.push({ shell: walk.next_shell, time: walk.next_time });
				walk = walk.next_shell;
			}
			if (entries.length < 3) continue;
			let first = entries[0].shell;
			let last = entries[entries.length - 1].shell;
			let anchor_x = first.pillbox_orbit_pixel_x ??
				first.tank_exact_pixel_x ?? first.pixel_x;
			let anchor_y = first.pillbox_orbit_pixel_y ??
				first.tank_exact_pixel_y ?? first.pixel_y;
			let final_x = last.pillbox_orbit_pixel_x ??
				last.tank_exact_pixel_x ?? last.pixel_x;
			let final_y = last.pillbox_orbit_pixel_y ??
				last.tank_exact_pixel_y ?? last.pixel_y;
			let total = entries[entries.length - 1].time - entries[0].time;
			if (total <= 0) continue;

			let smoothed = [];
			let plausible = true;
			for (let i = 1; i < entries.length - 1; i++) {
				let amount = (entries[i].time - entries[0].time) / total;
				let smooth_x = anchor_x + (final_x - anchor_x) * amount;
				let smooth_y = anchor_y + (final_y - anchor_y) * amount;
				let observed = entries[i].shell;
				let observed_x = observed.pillbox_orbit_pixel_x ??
					observed.tank_exact_pixel_x ?? observed.pixel_x;
				let observed_y = observed.pillbox_orbit_pixel_y ??
					observed.tank_exact_pixel_y ?? observed.pixel_y;
				if (Math.hypot(smooth_x - observed_x, smooth_y - observed_y) >
					MAX_SMOOTHING_DEVIATION_PIXELS) {
					plausible = false;
					break;
				}
				smoothed.push([smooth_x, smooth_y]);
			}
			if (!plausible) continue;
			for (let i = 1; i < entries.length - 1; i++) {
				entries[i].shell.smooth_pixel_x = smoothed[i - 1][0];
				entries[i].shell.smooth_pixel_y = smoothed[i - 1][1];
				entries[i - 1].shell.smooth_next_pixel_x = smoothed[i - 1][0];
				entries[i - 1].shell.smooth_next_pixel_y = smoothed[i - 1][1];
			}
			entries[entries.length - 2].shell.smooth_next_pixel_x = final_x;
			entries[entries.length - 2].shell.smooth_next_pixel_y = final_y;
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
	return drain(build_shell_positions_steps(records, terminals,
		pillbox_sources_by_record, tank_sources_by_record, tank_positions));
}

/* Much the slowest pass of a load — four fifths of it — so it reports its
 * two halves separately: matching each snapshot against the last, then the
 * per-player chain work over the matches. */
function* build_shell_positions_steps(records, terminals, pillbox_sources_by_record,
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
	for (let i = 0; i < records.length; i++) {
		if (i % PROGRESS_CHUNK === 0) {
			yield { fraction: SHELL_MATCH_SHARE * i / records.length, label: "Matching shells" };
		}
		let rec = records[i];
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
				position_uncertainty: shell.position_uncertainty,
				shell_list_start: shell.shell_list_start,
				shell_list_index: shell.shell_list_index,
				shell_offset_x: shell.shell_offset_x,
				shell_offset_y: shell.shell_offset_y,
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
	for (let player = 0; player < snapshots.length; player++) {
		yield {
			fraction: SHELL_MATCH_SHARE + (1 - SHELL_MATCH_SHARE) * player / snapshots.length,
			label: "Joining up shell paths",
		};
		let client_snapshots = snapshots[player];
		stitch_shell_chains(client_snapshots);
		resolve_residual_shell_fates(client_snapshots);
		smooth_shell_chains(client_snapshots);
	}
	return snapshots;
}

function build_shell_births(shell_positions) {
	return shell_positions.map(snapshots => {
		let births = [];
		for (let snapshot of snapshots) {
			for (let shell of snapshot.shells) {
				let start_time = shell.birth_time;
				let pixel_x = shell.birth_pixel_x;
				let pixel_y = shell.birth_pixel_y;
				let heading_x = shell.heading_x;
				let heading_y = shell.heading_y;
				if (shell.starts_at_pillbox) {
					pixel_x = shell.pillbox_source_x;
					pixel_y = shell.pillbox_source_y;
					/* Keep the synthetic segment continuous with an exact orbit
					 * position recovered from a quantised shell-list member. */
					let target_pixel_x = shell.pillbox_orbit_pixel_x ??
						shell.pixel_x;
					let target_pixel_y = shell.pillbox_orbit_pixel_y ??
						shell.pixel_y;
					let delta_x = target_pixel_x - pixel_x;
					let delta_y = target_pixel_y - pixel_y;
					let distance = Math.hypot(delta_x, delta_y);
					start_time = snapshot.time - distance /
						SHELL_SPEED_PIXELS_PER_TICK;
					if (distance > 0) {
						heading_x = delta_x / distance;
						heading_y = delta_y / distance;
					}
				} else if (!shell.starts_at_tank) {
					continue;
				}
				if (start_time >= snapshot.time || heading_x === undefined) continue;
				births.push({
					start_time,
					end_time: snapshot.time,
					pixel_x,
					pixel_y,
					heading_x,
					heading_y,
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
		duration > MAX_DIRECTION_INTERPOLATION_TICKS) return fallback;

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
	let packet_position = () => ({
		x: pixel_x / 16 + 0.5,
		y: pixel_y / 16 + 0.5,
	});
	let snapshots = game.shell_positions && game.shell_positions[player];
	if (!snapshots || shell.position_time === undefined) return packet_position();

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
		position.direction !== shell.direction) {
		return packet_position();
	}
	pixel_x = position.smooth_pixel_x ?? position.pillbox_orbit_pixel_x ??
		position.tank_exact_pixel_x ?? pixel_x;
	pixel_y = position.smooth_pixel_y ?? position.pillbox_orbit_pixel_y ??
		position.tank_exact_pixel_y ?? pixel_y;
	let exact_position = () => ({
		x: pixel_x / 16 + 0.5,
		y: pixel_y / 16 + 0.5,
	});
	if (position.next_time === undefined) return exact_position();
	if (tick >= position.next_time) {
		return position.next_terminal ? null : exact_position();
	}

	let amount = (tick - snapshot.time) / (position.next_time - snapshot.time);
	let target_x = position.smooth_next_pixel_x ?? position.next_pixel_x;
	let target_y = position.smooth_next_pixel_y ?? position.next_pixel_y;
	pixel_x += (target_x - pixel_x) * amount;
	pixel_y += (target_y - pixel_y) * amount;
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
	MAX_SHELL_INTERPOLATION_TICKS, MAX_DIRECTION_INTERPOLATION_TICKS,
	append_shell_list, add_shell_point_terminal, add_shell_box_terminal,
	build_tank_positions, build_tank_directions, build_lgm_positions, track_pixel_at,
	build_shell_positions, build_shell_births,
	build_tank_positions_steps, build_tank_directions_steps,
	build_lgm_positions_steps, build_shell_positions_steps,
	tank_position_at, tank_direction_at, lgm_position_at, shell_position_at,
	shell_birth_positions_at,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloMotion;
} else {
	window.BoloMotion = BoloMotion;
}

})();
