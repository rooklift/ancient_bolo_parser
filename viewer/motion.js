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
/* The widest receive-stamp gap across which a verbatim shell restatement
 * is read as the SAME statement re-sent rather than a different shell
 * (link_stale_restatements). The bound is what makes byte equality proof:
 * within it the same shell has provably moved (2 px/tick, and heads are
 * exact), and no stream-mate can have arrived — an angry pill fires at
 * most every 5-6 ticks, and an orbit never revisits a pixel. On the
 * corpus's normal ~12-tick restatement cadence the bound is never even
 * reached, so the pass only engages on fast-ring logs. */
const STALE_RESTATEMENT_MAX_TICKS = 4;
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
const TANK_SHELL_FLIGHT_LIMIT_TICKS = 72;
/* 8.5 tiles: the pill orbit range, and the assumed tank-shot range from
 * the shared simulation. */
const SHELL_RANGE_PIXELS = 136;
/* The longest drawable birth segment. A birth replays the flight from the
 * muzzle to the shell's first restatement, and no claiming path puts that
 * first sighting further out than a full shell range plus the residual
 * matcher's distance allowance (creation_start_match); the pairwise
 * tank-birth window sits well inside that. The birth sampler must scan at
 * least this far ahead of the clock, or a long-range claim pops in
 * mid-flight -- the corpus already carries a 57.7-tick span, right
 * against the 58-tick window this replaces. */
const MAX_SHELL_BIRTH_SPAN_TICKS = (SHELL_RANGE_PIXELS +
	SHELL_MATCH_ERROR_PIXELS * 2) / SHELL_SPEED_PIXELS_PER_TICK;
/* A lagging sender's record timestamps drift against its simulation by a
 * few updates in either direction, so an on-track restatement can sit
 * this far from where a uniform-time reading of the chain puts it. */
const MAX_SMOOTHING_DEVIATION_PIXELS = 24;
/* The deviation splits into two very different claims. CROSS-track (off
 * the chain's own ray) means the observation may not be the story the
 * chain tells -- the reason to refuse re-timing -- and keeps the bound
 * above. ALONG-track is only the stamp lying about when the shell was
 * seen at a point it provably occupied: shells fly straight, so an
 * on-ray point between the anchors is the shell at SOME time. Measured
 * over the corpus's laggiest replays, every chain the radial bound
 * refused sat within one pixel of its ray while lying up to 35.5px
 * along it -- a bad record backlog, not a doubtful identity -- and
 * refusing drew the lie raw as a crawl-and-sprint pair. Twice the
 * radial bound covers the worst observed lie with margin. */
const MAX_SMOOTHING_ALONG_TRACK_PIXELS = 48;
/* A chain head's first link may legitimately run a little long: the head
 * is a one-sided quantised reconstruction (up to ~7px behind the true
 * spot) and the stamps wander a tick or two. Only an excess beyond this
 * marks the head's record as received late and worth sliding. */
const CHAIN_HEAD_SLIDE_THRESHOLD_PIXELS = 8;
const ABSORB_LATERAL_TOLERANCE_PIXELS = 2;
/* An impact record normally trails the impact by well under a second. */
const MAX_FATE_EVENT_LAG_TICKS = 30;
/* Hang insurance for next_shell walks. Every pass that links shells does
 * so strictly forward in time, so a chain can never cycle and its length
 * is bounded by the restatements one shell can receive in its couple of
 * seconds of flight — a few dozen. The cap only exists so that a future
 * linking bug degrades a chain instead of hanging the viewer. */
const MAX_CHAIN_WALK = 500;
/* The resolver's cost-forced margin: an assignment is accepted when every
 * rival story carries at least this much extra geometric error, the same
 * ambiguity unit the pairwise matcher uses. */
const RESIDUAL_COST_MARGIN = SHELL_MATCH_MARGIN;
/* Dilated joins and dilated same-orbit continuations: a lagging sender's
 * timestamps can put a single hop far off the two-pixel-per-tick schedule
 * while the shell stays exactly on its ray (or, for a pill shot, exactly
 * on its orbit). The penalty keeps any ordinary-physics story preferred;
 * the catch-up allowance covers a sender flushing its backlog. */
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

/* Absorb receive-stamp jitter out of the drawn tank and LGM tracks, the
 * same knowing lie smooth_shell_chains tells for shells, told far more
 * cautiously because these objects genuinely accelerate and turn. On a
 * fast token ring the sender samples an object once per packet at a
 * near-constant cadence, but the recorder's stamps bunch (dt=1,3,1,3...
 * around a true 2), so the renderer's lerp oscillates between fractions
 * and multiples of the true speed about ten times a second; the same
 * regime re-states a moving object's position verbatim, drawn as a
 * freeze and a catch-up jump. Both artifacts displace an observation a
 * few pixels ALONG its own path -- a lying stamp shifts a point in
 * time, never off the trajectory.
 *
 * The trajectory itself is sacred: a tank only ever moves on one of
 * its 16 facings, so a drawn straight run that bends even a couple of
 * pixels off its heading reads as impossible motion to a player (an
 * earlier chord-projection version of this pass produced exactly that
 * -- a tank facing due east drifting gently south -- because near a
 * corner the chord rotates until off-axis drift counts as "along").
 * So a point is eligible only where the raw path through it is
 * STRAIGHT: its raw lateral deviation from the raw line between its
 * neighbours within a quantisation-sized tolerance. Corner points are
 * never touched, every correction slides a point along its own
 * observed line, and the correction is capped by what a lying stamp
 * can explain -- the local raw chord speed times the largest stamp lie
 * seen -- so a parked tank, whose local speed is ~0, cannot be dragged
 * toward its next journey. A verbatim re-send mid-run is collinear by
 * construction and slides back onto the uniform schedule, erasing the
 * freeze-and-jump beat.
 *
 * A few repetitions against the progressively smoothed values converge
 * further than one pass, since the neighbours are jittered too;
 * eligibility and the budget are always judged against the RAW
 * observations, so iterating cannot compound a correction past what
 * one pass was allowed. Corrections land in smooth_pixel_x/y, which
 * only the drawing accessor `interpolated_position` reads:
 * `track_pixel_at`, which matching uses for tank-hit boxes and birth
 * refinement, stays on the packet coordinates, so this cannot move a
 * matching decision. */
const TRACK_SMOOTHING_LATERAL_PIXELS = 1.5;
const TRACK_SMOOTHING_JITTER_TICKS = 3;
const TRACK_SMOOTHING_MAX_PIXELS = 6;
const TRACK_SMOOTHING_PASSES = 5;
/* The pass engages only between closely-spaced statements, for the same
 * reason STALE_RESTATEMENT_MAX_TICKS scopes the shell twin pass: the
 * stamp lie is one to three ticks whatever the cadence, so against the
 * corpus-normal ~12-tick restatement gap its speed effect is under ten
 * percent -- invisible, and the wobble there is mostly the tank's real
 * acceleration, which a one-point smoother cannot tell from jitter and
 * would flatten into stair-steps. Against fast-ring one-to-three-tick
 * gaps the lie dominates and real per-segment speed change is
 * negligible, so the ambiguity resolves. Normal-cadence replays are
 * left pixel-for-pixel untouched. */
const TRACK_SMOOTHING_MAX_GAP_TICKS = 6;

function smooth_track_positions(tracks) {
	for (let track of tracks) {
		for (let pass = 0; pass < TRACK_SMOOTHING_PASSES; pass++) {
			let proposals = [];
			for (let i = 1; i + 1 < track.length; i++) {
				let previous = track[i - 1], point = track[i], next = track[i + 1];
				if (!point.continuous || !next.continuous) continue;
				if (point.tank_entry) continue;
				let before = point.time - previous.time;
				let after = next.time - point.time;
				if (before < 0 || after < 0) continue;
				if (before > TRACK_SMOOTHING_MAX_GAP_TICKS ||
					after > TRACK_SMOOTHING_MAX_GAP_TICKS) continue;
				let total = before + after;
				if (total <= 0) continue;
				/* Straightness and the correction budget come from the raw
				 * observations alone. */
				let raw_chord_x = next.pixel_x - previous.pixel_x;
				let raw_chord_y = next.pixel_y - previous.pixel_y;
				let raw_chord = Math.hypot(raw_chord_x, raw_chord_y);
				if (raw_chord === 0) continue;
				let lateral = Math.abs(
					(point.pixel_x - previous.pixel_x) * raw_chord_y -
					(point.pixel_y - previous.pixel_y) * raw_chord_x) / raw_chord;
				if (lateral > TRACK_SMOOTHING_LATERAL_PIXELS) continue;
				let budget = Math.min(TRACK_SMOOTHING_MAX_PIXELS,
					TRACK_SMOOTHING_JITTER_TICKS * raw_chord / total);
				let previous_x = previous.smooth_pixel_x ?? previous.pixel_x;
				let previous_y = previous.smooth_pixel_y ?? previous.pixel_y;
				let next_x = next.smooth_pixel_x ?? next.pixel_x;
				let next_y = next.smooth_pixel_y ?? next.pixel_y;
				let amount = before / total;
				let chord_x = previous_x + (next_x - previous_x) * amount;
				let chord_y = previous_y + (next_y - previous_y) * amount;
				/* The correction is strictly a slide along the point's own
				 * raw chord direction -- the projection discards whatever
				 * lateral component iterated neighbours have accumulated, so
				 * off-axis drift is impossible by construction. */
				let unit_x = raw_chord_x / raw_chord;
				let unit_y = raw_chord_y / raw_chord;
				let along = (chord_x - point.pixel_x) * unit_x +
					(chord_y - point.pixel_y) * unit_y;
				if (Math.abs(along) > budget) continue;
				proposals.push([i, point.pixel_x + unit_x * along,
					point.pixel_y + unit_y * along]);
			}
			for (let [i, x, y] of proposals) {
				track[i].smooth_pixel_x = x;
				track[i].smooth_pixel_y = y;
			}
		}
	}
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
		let match = {
			cost,
			pillbox_orbit_states: orbit_states.map(state => ({
				bradian: state.bradian, step: state.step,
			})),
		};
		/* All-or-nothing by construction: dilated states are dropped
		 * whenever an ordinary state exists. */
		if (orbit_states[0].dilated) match.dilated = true;
		return match;
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

/* A statement's step is pinned when every surviving state agrees on it --
 * one bradian, or several bradians at one step, as near-muzzle states
 * are. */
function pinned_orbit_step(states) {
	if (!states || !states.length) return null;
	let step = states[0].step;
	for (let state of states) {
		if (state.step !== step) return null;
	}
	return step;
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
	/* Dilated fallback window, the widen-in-time-only principle
	 * `pill_states_reachable` uses: a lying record clock can put a
	 * restatement off the uniform-time schedule, but never off its orbit. */
	let step_window = Math.ceil(duration / TICKS_PER_SHELL_UPDATE) +
		DILATED_UPDATE_SLACK;
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
			let dilated = cost > SHELL_MATCH_ERROR_PIXELS;
			if (dilated) {
				if (step - previous_state.step > step_window) continue;
				cost += DILATED_JOIN_PENALTY_PIXELS;
			}
			let key = `${orbit.bradian}:${step}`;
			let existing = states_by_key.get(key);
			if (!existing || cost < existing.cost) {
				states_by_key.set(key,
					{ bradian: orbit.bradian, step, cost, dilated });
			}
		}
	}
	/* An on-schedule story always outranks a dilated one; dilated states
	 * survive only when no ordinary step explains the pair at all, so
	 * every previously possible match is returned unchanged. The penalty
	 * puts a surviving dilated candidate more than the match margin above
	 * any ordinary candidate, so it can never veto one as ambiguous — it
	 * only exists so the lockstep and margin passes can arbitrate instead
	 * of the shell freezing unmatched and its continuation being minted as
	 * a brand-new unseen shot. */
	let states = [...states_by_key.values()];
	if (states.some(state => !state.dilated)) {
		states = states.filter(state => !state.dilated);
	}
	return states;
}

function pillbox_shell_terminal_match(previous, terminal, duration, start_time,
	lead_pixels = 0) {
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
				let tolerance = terminal.event_type === "tank_hit"
					? SHELL_TANK_HIT_TOLERANCE_PIXELS : 0;
				let centre_x = pixel_x + 8;
				let centre_y = pixel_y + 8;
				let enters_box = (min_x, min_y) =>
					centre_x >= min_x - tolerance &&
					centre_x < min_x + 16 + tolerance &&
					centre_y >= min_y - tolerance &&
					centre_y < min_y + 16 + tolerance;
				enters_terminal = enters_box(terminal.min_x, terminal.min_y);
				/* A tank-hit packet gives the tank's eventual recorded box. The
				 * shell can reach it earlier while the tank is moving, so this
				 * exact orbit point is also tested against the tank track at its
				 * arrival time, and either box is accepted. The track is the
				 * recorder's interpolation, but the collision happened in the
				 * SENDER's simulation, whose picture of a remote tank is the last
				 * restatement it received -- at best the one the recorder logged
				 * a ring-round earlier, which is the packet box itself. A tank
				 * crossing the shell's path at full speed moves 7 px per round,
				 * so the interpolated box can slide out from under a corner graze
				 * the sender registered against its stale box (fredde_vs_oscar,
				 * tick 5264529: pill 10's bradian-233 shell passes tank 3's
				 * south-west corner 2 px outside the packet box but 3 px outside
				 * the track box, with the hit reported in the very next record and
				 * otherwise unexplained). The hitbox placed for the effect follows
				 * whichever box the shell entered, the track box when both. */
				if (terminal.event_type === "tank_hit" && terminal.tank_track) {
					let arrival_time = start_time +
						distance / SHELL_SPEED_PIXELS_PER_TICK;
					let tank_position = track_pixel_at(terminal.tank_track,
						arrival_time);
					hitbox_pixel_x = terminal.min_x;
					hitbox_pixel_y = terminal.min_y;
					if (tank_position) {
						let enters_track_box = enters_box(tank_position.pixel_x,
							tank_position.pixel_y);
						if (enters_track_box || !enters_terminal) {
							hitbox_pixel_x = tank_position.pixel_x;
							hitbox_pixel_y = tank_position.pixel_y;
							enters_terminal = enters_track_box;
						}
					}
				}
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
		/* Same rule as the ordinary branch below: a match only reachable
		 * through the lead allowance carries the dilated penalty, so an
		 * in-window story is always preferred. */
		if (match.distance > expected_distance + SHELL_MATCH_ERROR_PIXELS) {
			match.cost += DILATED_JOIN_PENALTY_PIXELS;
		}
	}
	matches = matches.filter(match =>
		match.distance <= expected_distance + SHELL_MATCH_ERROR_PIXELS +
			lead_pixels);
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

/* `lead_pixels` admits an event record that arrives BEFORE the shell's
 * receiver-clock arrival estimate: when the shell's own restatement was
 * delayed, the estimate overshoots by the delay, and the event seems to
 * demand impossibly fast flight. The residual pass passes the bound it
 * can justify from the record gap; ordinary matching passes nothing and
 * keeps the strict window. Lead matches carry the dilated penalty so an
 * in-window story is always preferred. */
function shell_terminal_match(previous, terminal, duration, start_time,
	lead_pixels = 0, pillbox_lead_pixels = lead_pixels) {
	if (terminal.direction !== null && terminal.direction !== previous.direction) return null;
	/* The caller's lead allowance extends to orbit-tracked shells too: their
	 * distances are discrete, but a chain end reached through a dilated link
	 * carries the very timestamp lie the lead exists to forgive, so its
	 * remaining flight is understated the same way. Pairwise matching passes
	 * no lead and keeps the strict window for both branches; the diagnostics
	 * still pass the two leads separately to relax one constraint at a time. */
	let pillbox_match = pillbox_shell_terminal_match(previous, terminal, duration,
		start_time, pillbox_lead_pixels);
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
			SHELL_MATCH_ERROR_PIXELS + lead_pixels) continue;
		let lead_penalty = endpoint.distance > expected_distance +
			SHELL_MATCH_ERROR_PIXELS ? DILATED_JOIN_PENALTY_PIXELS : 0;
		matches.push({
			cost: lead_penalty +
				Math.abs(endpoint.distance - expected_distance) +
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
function pillbox_source_terminal_entry(source, terminal) {
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
				if (best === null || distance < best.distance) {
					best = {
						distance, origin_x, origin_y,
						pixel_x: origin_x + position[0],
						pixel_y: origin_y + position[1],
					};
				}
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
			let entry = pillbox_source_terminal_entry(group, terminal);
			if (entry === null || entry.distance > maximum_distance) continue;
			candidates.push(group);
			candidates_by_group.get(group).push({ terminal, entry });
		}
		candidates_by_terminal.set(terminal, candidates);
	}

	for (let group of active_groups) {
		let remaining = group.capacity - group.assigned;
		let candidates = candidates_by_group.get(group).filter(candidate =>
			candidates_by_terminal.get(candidate.terminal).length === 1);
		if (!candidates.length) continue;
		let equivalent = candidates.every(candidate =>
			same_shell_terminal(candidates[0].terminal, candidate.terminal));
		if (!equivalent && candidates.length !== remaining) continue;
		let count = Math.min(remaining, candidates.length);
		for (let i = 0; i < count; i++) {
			let { terminal, entry } = candidates[i];
			terminal.unseen_pillbox_source = true;
			/* The entry's origin, not the group's: for a direction-0 F4 the
			 * orbit walk may only reach the impact from the alternate pill,
			 * the same evidence that reassigns observed shells. */
			terminal.pillbox_source_x = entry.origin_x;
			terminal.pillbox_source_y = entry.origin_y;
			terminal.pillbox_source_direction = group.direction;
			terminal.unseen_entry_x = entry.pixel_x;
			terminal.unseen_entry_y = entry.pixel_y;
		}
		group.assigned += count;
	}
}

function mark_new_pillbox_shells(previous, next) {
	let duration = next.time - previous.time;
	if (duration < 0 || duration > MAX_POSITION_INTERPOLATION_TICKS) return;
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
				/* A verbatim re-send already carries its identity; letting it
				 * consume fire capacity would attribute the shot twice. */
				if (shell.matched_from_previous) continue;
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
		/* A dilated candidate is a penalized fallback story; it must not
		 * veto or widen the provenance the on-schedule candidates agree
		 * on, and provenance claimed on dilated stories alone would be
		 * exactly the convincing false identity matching guards against. */
		let trusted = choices.filter(candidate => !candidate.dilated);
		if (!trusted.length) continue;
		let first_shell = previous_shells[trusted[0].previous_index];
		if (first_shell.pillbox_source_x === undefined ||
			trusted.some(candidate => !same_pillbox_stream(first_shell,
				previous_shells[candidate.previous_index]))) continue;

		let states_by_key = new Map();
		for (let candidate of trusted) {
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

/* ALL the live shells of one pillbox advance in lockstep -- the sender
 * moves every shell one orbit step in the same update pass, and the
 * corpus establishes that every shell list of one record is a single
 * sampling instant ([E:shell-list-skew]) -- so between two statements
 * of one sender, one common step advance explains the pill's entire
 * roster, whatever each shell's bradian or list. Step gaps between
 * stream-mates therefore never change while both are restated, the
 * earlier shot stays ahead until it falls, and (with the fixed 32-step
 * lifetime) birth order is fall order. Distance cost alone cannot see
 * this: a receiver interval compressed by record-time jitter makes the
 * leader's short hop into the trailer's true position look cheaper than
 * its own true continuation, and the two identities swap -- drawn as
 * the later shot overtaking the earlier one mid-air and falling first.
 * Enforce the lockstep instead: when the shells of one pill whose
 * current step is well-defined -- one bradian (its steps may still
 * span a quantisation bound), or several bradians agreeing on one
 * step, as near-muzzle states do -- have candidate successors in this
 * snapshot, one common step advance must explain a candidate of every
 * such shell; candidates no common advance supports are pruned. One
 * clean stream-mate anywhere in the volley thereby pins the advance
 * for every shell of the pill, including bradians holding a single
 * shell, which the per-bradian grouping this replaces could never
 * protect. When no common advance exists (a fall mid-interval, a
 * dropped restatement), nothing is pruned -- the rule only refuses
 * pairings that contradict every jointly consistent story, so it can
 * veto a physically impossible crossing but never invent a link.
 * Terminal candidates stay out of it entirely: dying is exactly how a
 * shell leaves the lockstep. */
function enforce_pillbox_lockstep_candidates(previous_shells, by_previous,
	by_next) {
	let groups = new Map();
	for (let index = 0; index < previous_shells.length; index++) {
		let shell = previous_shells[index];
		let states = shell.pillbox_orbit_states;
		if (shell.pillbox_source_x === undefined || !states ||
			!states.length) continue;
		let bradian = states[0].bradian;
		let step = states[0].step;
		if (states.some(state => state.bradian !== bradian) &&
			states.some(state => state.step !== step)) continue;
		let key = `${shell.pillbox_source_x}:${shell.pillbox_source_y}`;
		let group = groups.get(key);
		if (!group) groups.set(key, group = []);
		group.push({ index, steps: states.map(state => state.step) });
	}

	let changed = false;
	for (let group of groups.values()) {
		if (group.length < 2) continue;
		/* Every step advance some successor candidate of this shell could
		 * represent. Residual step uncertainty (several surviving states on
		 * the one bradian) widens the set; it never narrows wrongly. */
		let advance_sets = group.map(member => {
			let advances = new Set();
			for (let candidate of by_previous[member.index]) {
				if (candidate.target.terminal ||
					!candidate.pillbox_orbit_states) continue;
				for (let state of candidate.pillbox_orbit_states) {
					for (let step of member.steps) {
						if (state.step > step) advances.add(state.step - step);
					}
				}
			}
			return advances;
		});
		let constrained = advance_sets.filter(advances => advances.size);
		if (constrained.length < 2) continue;
		let allowed = new Set([...constrained[0]].filter(advance =>
			constrained.every(advances => advances.has(advance))));
		if (!allowed.size) continue;

		let removed = new Set();
		for (let i = 0; i < group.length; i++) {
			if (!advance_sets[i].size) continue;
			let member = group[i];
			for (let candidate of by_previous[member.index]) {
				if (candidate.target.terminal ||
					!candidate.pillbox_orbit_states) continue;
				let states = candidate.pillbox_orbit_states.filter(state =>
					member.steps.some(step => state.step > step &&
						allowed.has(state.step - step)));
				if (!states.length) removed.add(candidate);
				else if (states.length <
					candidate.pillbox_orbit_states.length) {
					candidate.pillbox_orbit_states = states;
					changed = true;
				}
			}
		}
		if (!removed.size) continue;
		changed = true;
		for (let member of group) {
			by_previous[member.index] = by_previous[member.index].filter(
				candidate => !removed.has(candidate));
		}
		for (let i = 0; i < by_next.length; i++) {
			by_next[i] = by_next[i].filter(candidate =>
				!removed.has(candidate));
		}
	}
	return changed;
}

/* The lockstep rule above arbitrates among a member's own candidates, so
 * it needs two mutually constraining members before it can prune, and it
 * can never defend a pill's landing spot from an outside shell -- a
 * stream-mate that lost its provenance (born before the log, or through a
 * dropped restatement) competes on bare distance cost, and a compressed
 * interval hands it the pill's own orbit point at a cost the real owner
 * cannot beat. The pill's statements themselves settle both: the pinned
 * steps its roster occupies in the two snapshots vote for one common
 * advance exactly as the stitching/residual reference does
 * ([E:shell-list-skew]), under the same score and margin gates.
 * Conservation differs by direction here: claimed newborns are already
 * marked and excluded from the target roster, but a shell's death is
 * undecided at match time, so dying shells stay in the source vote and
 * the margin gate makes an aliased ladder stand down instead of misvote.
 * A passing vote is applied twice. First, every pinned member's
 * surviving orbit continuation must sit at exactly its step plus the
 * advance -- pruning the crossings whose wrong half was a within-margin
 * pairwise link. Second, landing ownership: when exactly one pinned
 * member's step plus the advance equals the pinned step of exactly one
 * target, and that member holds a live candidate for it, every outside
 * candidate for that target is evicted -- the statements say whose orbit
 * point it is. A candidate another passing pill retained as its own
 * lockstep-consistent continuation is never evicted; two pills claiming
 * one point is a genuine conflict the margins must arbitrate. When no
 * vote passes, nothing changes -- the rule vetoes contradictions of a
 * dominant story, it never invents one. */
function enforce_roster_lockstep_candidates(previous_shells, target_groups,
	by_previous, by_next, duration, next = null) {
	let max_advance = Math.ceil(duration / TICKS_PER_SHELL_UPDATE) +
		DILATED_UPDATE_SLACK;
	/* Measurement only, and off unless a measuring caller switches it on
	 * (set_roster_vote_recording): every pill's election over this pair
	 * is recorded on the target snapshot, whatever its verdict, so a link
	 * the post-hoc vote later contradicts can be read against what the
	 * matcher saw at the time (score_pill_links attaches it; the rates
	 * tool's --describe-links prints it). Overwritten on each of the
	 * matcher's passes; the rosters do not change between them. The
	 * records are small but there are tens of thousands per replay --
	 * about a tenth again of a built game's heap -- which the viewer
	 * should not carry for a table it never reads. */
	let votes = next && record_roster_votes
		? (next.roster_votes ??= new Map()) : null;
	let pills = new Map();
	for (let index = 0; index < previous_shells.length; index++) {
		let shell = previous_shells[index];
		if (shell.pillbox_source_x === undefined) continue;
		let step = pinned_orbit_step(shell.pillbox_orbit_states);
		let key = `${shell.pillbox_source_x}:${shell.pillbox_source_y}`;
		let pill = pills.get(key);
		if (!pill) {
			pills.set(key, pill = {
				source_x: shell.pillbox_source_x,
				source_y: shell.pillbox_source_y,
				members: [], unpinned: 0,
			});
		}
		if (step === null) {
			pill.unpinned++;
			continue;
		}
		/* A member holding a terminal candidate over this pair may be
		 * dying; see the election below for what its vote is worth. */
		pill.members.push({ index, step, dying: by_previous[index].some(
			candidate => candidate.target.terminal) });
	}

	let changed = false;
	let removed = new Set();
	let retained = new Set();
	let claims = [];
	for (let pill of pills.values()) {
		let source_steps = new Set(pill.members.map(member => member.step));
		let record = verdict => {
			if (!votes) return;
			votes.set(`${pill.source_x}:${pill.source_y}`, {
				...verdict,
				sources: pill.members.map(member =>
					`${member.step}${member.dying ? "d" : ""}`).sort(
					(a, b) => parseInt(a, 10) - parseInt(b, 10)).join(","),
			});
		};
		if (source_steps.size < LOCKSTEP_REFERENCE_MIN_SCORE) {
			record({ verdict: "unvoted", landings: "",
				unpinned: pill.unpinned });
			continue;
		}
		/* The target roster is pinned from raw positions: targets carry no
		 * orbit states of their own yet, but an orbit point is an exact
		 * measured coordinate, so a raw position pins a step just as a
		 * propagated state set would. */
		let landings = new Map();
		for (let next_index = 0; next_index < target_groups.length;
			next_index++) {
			let target = target_groups[next_index].target;
			if (target.terminal || target.starts_at_pillbox) continue;
			let step = pinned_orbit_step(pillbox_orbit_states_at(
				target.direction, target.pixel_x - pill.source_x,
				target.pixel_y - pill.source_y, target.position_uncertainty));
			if (step === null) continue;
			let indices = landings.get(step);
			if (!indices) landings.set(step, indices = []);
			indices.push(next_index);
		}
		/* The election. A near-regular ladder maps onto its own future at
		 * the true advance minus the fire cadence too (the rung-shift
		 * alias), and the deciding vote between the two is often cast by
		 * a shell that in fact died over the pair: its position plus one
		 * cadence lands on a neighbour's true landing, and the alias
		 * comes within one of the truth, so the margin gate stands down
		 * and cost then links the ladder one rung short. A death is
		 * undecided at match time, but a member holding a terminal
		 * candidate over this pair is at least a doubtful voter, so the
		 * election is held twice, with and without the doubtful members,
		 * and passes when either vote clears the gates while the other
		 * still ranks the same advance first (ties allowed; a confident
		 * roster too small to vote does not object). Abstention can only
		 * lower scores, so an alias the full vote would not lead can
		 * never win through it; what it buys is the margin a dead
		 * shell's coincidence was denying. The first, one-way form of
		 * this rule required the confident vote itself to pass, and the
		 * corpus links run at `41bb718` found 84 scenes where three
		 * dying members' abstention had thinned the roster below the
		 * gates that the full vote cleared -- hence symmetric. */
		let elect = steps => {
			let scores = new Map();
			let best = null, best_score = 0, runner_up = 0;
			for (let advance = 1; advance <= max_advance; advance++) {
				let score = 0;
				for (let step of steps) {
					if (landings.has(step + advance)) score++;
				}
				scores.set(advance, score);
				if (score > best_score) {
					runner_up = best_score;
					best_score = score;
					best = advance;
				} else if (score > runner_up) {
					runner_up = score;
				}
			}
			return { best, best_score, runner_up, scores };
		};
		let confident_steps = new Set(pill.members
			.filter(member => !member.dying).map(member => member.step));
		let full = elect(source_steps);
		let confident = elect(confident_steps);
		/* An orphan landing: a pinned target at a step beyond the advance
		 * with no pinned source one advance behind it. A newborn sits at
		 * step <= advance, so under the TRUE advance an orphan can only be
		 * a source the matcher failed to pin; under the rung-shift alias
		 * they are structural -- the ladder's lowest landings are left
		 * without a source. So when the margin gate fails by one or a
		 * tie, an orphan-free leader whose every rival within one carries
		 * an orphan is the consistent story and takes the election. The
		 * corpus links run at `41bb718` measured this: of 140 pairwise
		 * stand-downs later contradicted by the post-hoc vote, the
		 * symmetric gates below rescue 84 and the tie-break 26 more, all
		 * 110 agreeing with the post-hoc vote, none disagreeing. */
		let orphans = advance => {
			let count = 0;
			for (let step of landings.keys()) {
				if (step > advance && !source_steps.has(step - advance)) count++;
			}
			return count;
		};
		let gates = election => election.best !== null &&
			election.best_score >= LOCKSTEP_REFERENCE_MIN_SCORE &&
			election.best_score >=
				election.runner_up + LOCKSTEP_REFERENCE_MIN_MARGIN;
		let tiebreak = election => election.best !== null &&
			election.best_score >= LOCKSTEP_REFERENCE_MIN_SCORE &&
			!orphans(election.best) &&
			[...election.scores].every(([advance, score]) =>
				advance === election.best ||
				score < election.best_score - 1 || orphans(advance) > 0);
		/* Symmetric: the confident vote may pass with the full roster
		 * leading the same advance, or the full vote may pass with the
		 * confident voters leading the same advance (or too few of them
		 * to speak). Either way the abstainers can veto an alias they
		 * would not themselves lead, and never manufacture a stand-down
		 * by their absence. */
		let full_leads = advance =>
			full.scores.get(advance) >= full.best_score;
		let confident_leads = advance =>
			confident_steps.size < LOCKSTEP_REFERENCE_MIN_SCORE ||
			confident.scores.get(advance) >= confident.best_score;
		let by = gates(confident) && full_leads(confident.best) ? "confident"
			: gates(full) && confident_leads(full.best) ? "full"
			: tiebreak(confident) && full_leads(confident.best)
				? "confident_tiebreak"
			: tiebreak(full) && confident_leads(full.best) ? "full_tiebreak"
			: null;
		let best = by === null ? null
			: by.startsWith("full") ? full.best : confident.best;
		record({
			verdict: by === null ? "stood_down" : "passed", by,
			advance: confident.best, score: confident.best_score,
			runner_up: confident.runner_up,
			full_advance: full.best, full_score: full.best_score,
			full_runner_up: full.runner_up,
			unpinned: pill.unpinned,
			landings: [...landings.keys()].sort((a, b) => a - b).join(","),
		});
		if (by === null) continue;

		for (let member of pill.members) {
			for (let candidate of by_previous[member.index]) {
				if (candidate.target.terminal ||
					!candidate.pillbox_orbit_states) continue;
				let states = candidate.pillbox_orbit_states.filter(state =>
					state.step === member.step + best);
				if (!states.length) {
					removed.add(candidate);
					continue;
				}
				retained.add(candidate);
				if (states.length < candidate.pillbox_orbit_states.length) {
					candidate.pillbox_orbit_states = states;
					changed = true;
				}
			}
		}
		for (let [step, indices] of landings) {
			if (indices.length !== 1) continue;
			let owners = pill.members.filter(member =>
				member.step + best === step);
			if (owners.length !== 1) continue;
			claims.push({ owner: owners[0], next_index: indices[0] });
		}
	}
	for (let claim of claims) {
		let owner_candidate = by_previous[claim.owner.index].find(candidate =>
			candidate.next_index === claim.next_index &&
			!candidate.target.terminal && !removed.has(candidate));
		if (!owner_candidate) continue;
		for (let candidate of by_next[claim.next_index]) {
			if (candidate === owner_candidate || retained.has(candidate)) {
				continue;
			}
			removed.add(candidate);
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

/* On a fast token ring the sender's packet rate outpaces its shell
 * resampling, so consecutive records routinely restate the previous
 * record's shell samples verbatim under a fresh receive stamp — over
 * half of all closely-spaced statements in the fast-ring logs that
 * motivated this. Zero displacement over positive time is impossible
 * physics for a live shell, so the pairwise matcher rightly refuses
 * such a continuation; without this pass each re-send seeds a parallel
 * chain that divides the true statement stream with the original and
 * later starves and pops mid-air. But the byte equality that breaks
 * the physics is itself proof of identity within
 * STALE_RESTATEMENT_MAX_TICKS (see the constant for the argument), so
 * a verbatim pair is linked as one statement re-sent: an identity
 * continuation with zero advance, every hypothesis state copied
 * verbatim rather than advanced. A member (index > 0) must repeat its
 * chained offset bytes as well as its reconstructed position, making
 * the equality bytewise for the whole list prefix. The re-send's stamp
 * still heads the ongoing chain, understating the next link's true
 * flight time by at most the gap — the same small clock lie ordinary
 * stamp jitter already inflicts, absorbed by the matcher's margins and
 * the smoothing pass. Runs before birth attribution and matching so a
 * re-send can neither consume a pill-fire's capacity nor compete as a
 * fresh identity. */
function link_stale_restatements(previous, next) {
	let duration = next.time - previous.time;
	if (duration < 0 || duration > STALE_RESTATEMENT_MAX_TICKS) return;
	let pairs = [];
	let twin_uses = new Map();
	for (let target of next.shells) {
		if (target.matched_from_previous) continue;
		let twin = null, ambiguous = false;
		for (let shell of previous.shells) {
			if (shell.next_time !== undefined) continue;
			if (shell.direction !== target.direction ||
				shell.pixel_x !== target.pixel_x ||
				shell.pixel_y !== target.pixel_y ||
				(shell.position_uncertainty || 0) !==
					(target.position_uncertainty || 0) ||
				shell.shell_offset_x !== target.shell_offset_x ||
				shell.shell_offset_y !== target.shell_offset_y) continue;
			if (twin) { ambiguous = true; break; }
			twin = shell;
		}
		if (!twin || ambiguous) continue;
		twin_uses.set(twin, (twin_uses.get(twin) || 0) + 1);
		pairs.push({ twin, target });
	}
	for (let { twin, target } of pairs) {
		/* Two byte-identical statements in ONE record would make the twin
		 * ambiguous the other way; stand down rather than guess. */
		if (twin_uses.get(twin) !== 1) continue;
		twin.next_time = next.time;
		twin.next_pixel_x = twin.pillbox_orbit_pixel_x ??
			twin.tank_exact_pixel_x ?? target.pixel_x;
		twin.next_pixel_y = twin.pillbox_orbit_pixel_y ??
			twin.tank_exact_pixel_y ?? target.pixel_y;
		twin.next_shell = target;
		target.matched_from_previous = true;
		target.stale_restatement = true;
		if (twin.pillbox_source_x !== undefined) {
			target.pillbox_source_x = twin.pillbox_source_x;
			target.pillbox_source_y = twin.pillbox_source_y;
			target.pillbox_source_distance = twin.pillbox_source_distance;
		}
		if (twin.birth_pixel_x !== undefined) {
			target.birth_time = twin.birth_time;
			target.birth_pixel_x = twin.birth_pixel_x;
			target.birth_pixel_y = twin.birth_pixel_y;
		}
		if (twin.pillbox_orbit_states) {
			set_pillbox_orbit_states(target, twin.pillbox_orbit_states);
		}
		if (twin.tank_bradian_states) {
			set_tank_bradian_states(target,
				twin.tank_bradian_states.map(state => ({ ...state })));
		}
		if (twin.heading_origin_x !== undefined) {
			target.heading_origin_x = twin.heading_origin_x;
			target.heading_origin_y = twin.heading_origin_y;
		}
		if (twin.heading_x !== undefined) {
			target.heading_x = twin.heading_x;
			target.heading_y = twin.heading_y;
		}
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
	/* A zero gap is real on a fast ring: two of the sender's packets can
	 * land inside one recorder tick, the second a step further along.
	 * Record order still orders the statements, and the cost machinery
	 * needs no time to arbitrate -- the orbit tables demand a forward
	 * step and exact geometry whatever the stamps claim -- so a tied
	 * stamp is matched rather than fragmenting every chain that crosses
	 * it. Negative durations stay refused. */
	if (duration < 0 || duration > MAX_SHELL_INTERPOLATION_TICKS) return;
	link_stale_restatements(previous, next);
	mark_new_pillbox_shells(previous, next);

	let target_groups = shell_target_groups(next);
	let by_previous = Array.from({ length: previous.shells.length }, () => []);
	let by_next = Array.from({ length: target_groups.length }, () => []);
	for (let previous_index = 0; previous_index < previous.shells.length; previous_index++) {
		/* Already continued by its verbatim re-send; its story goes on from
		 * the re-send's statement, not from here. */
		if (previous.shells[previous_index].next_time !== undefined) continue;
		for (let next_index = 0; next_index < target_groups.length; next_index++) {
			let target = target_groups[next_index].target;
			if (target.starts_at_pillbox || target.matched_from_previous) continue;
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
			/* `end_time` is the decision quantity — the arrival capped at
			 * the event's record time, as matching has always compared it —
			 * and stays so, keeping the equivalence rule's time gate
			 * independent of any drawing choice. `draw_end_time` is what the
			 * viewer renders: for a shell fall, whose splash has no coupled
			 * state change, the uncapped physics arrival even past the
			 * record (the fall segments draw the overhang); an object
			 * impact's flash belongs beside its authoritative state change,
			 * so everything else draws the capped value too. */
			match.end_time = target.terminal
				? Math.min(next.time,
					previous.time + match.distance / SHELL_SPEED_PIXELS_PER_TICK)
				: next.time;
			match.draw_end_time = target.terminal &&
				target.event_type === "shell_falls"
				? previous.time + match.distance / SHELL_SPEED_PIXELS_PER_TICK
				: match.end_time;
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
		if (enforce_pillbox_lockstep_candidates(previous.shells, by_previous,
			by_next)) changed = true;
		if (enforce_roster_lockstep_candidates(previous.shells, target_groups,
			by_previous, by_next, duration, next)) changed = true;
		if (!changed) break;
		for (let choices of by_previous) choices.sort((a, b) => a.cost - b.cost);
		for (let choices of by_next) choices.sort((a, b) => a.cost - b.cost);
	}
	prefer_ordered_shell_impacts(target_groups, by_previous, by_next,
		previous.shells);
	/* A dilated candidate's cost measures how badly the clock lied, not
	 * how likely the story is: every dilated rival is an exact orbit point
	 * ahead on the same track, so a margin between two of them is a coin
	 * flip dressed as evidence ("absorbing either alone is a guess"). A
	 * dilated candidate therefore never competes: it survives only as the
	 * lone remaining continuation on both of its sides, once the lockstep
	 * and constraint passes above have finished pruning. Anything still
	 * contested is left for the stitching and residual passes, whose
	 * discrete evidence can arbitrate. */
	let contested_dilated = new Set();
	for (let choices of by_previous) {
		for (let candidate of choices) {
			if (!candidate.dilated) continue;
			let lone_previous = choices.every(other =>
				other === candidate || other.target.terminal);
			let lone_target = by_next[candidate.next_index].length === 1;
			if (!lone_previous || !lone_target) contested_dilated.add(candidate);
		}
	}
	if (contested_dilated.size) {
		for (let i = 0; i < by_previous.length; i++) {
			by_previous[i] = by_previous[i].filter(candidate =>
				!contested_dilated.has(candidate));
		}
		for (let i = 0; i < by_next.length; i++) {
			by_next[i] = by_next[i].filter(candidate =>
				!contested_dilated.has(candidate));
		}
	}
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
			/* Everything persisted onto the shell, terminal, and effect is
			 * the drawn timeline; the decision-side end_time was consumed
			 * above and goes no further. */
			old_shell.next_time = best.draw_end_time;
			old_shell.next_pixel_x = exact_endpoint
				? exact_endpoint[0] : best.pixel_x;
			old_shell.next_pixel_y = exact_endpoint
				? exact_endpoint[1] : best.pixel_y;
			old_shell.next_terminal = best.target.terminal;
			if (best.target.terminal) {
				old_shell.next_terminal_type = best.target.type;
				let terminal = group.terminals[i];
				terminal.match_time = best.draw_end_time;
				old_shell.next_terminal_event_type = terminal.event_type;
				if (terminal.effect) {
					terminal.effect.time = best.draw_end_time;
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

/* The residual arm of the pill-wide lockstep ([E:shell-list-skew]).
 * Between two records of one sender, every live shell of one pillbox
 * advances by one common step count -- and the pill's own STATEMENTS
 * vote on what that count was, no matcher decision trusted: for each
 * pill and adjacent record pair, score every plausible advance by how
 * many step-pinned statements of the first record land exactly on a
 * step-pinned statement of the second, and accept the winner only when
 * it explains at least three shells and beats the runner-up by at
 * least two. Conservation keeps the vote honest against cadence
 * aliasing -- a pill fires every couple of steps, so the roster is a
 * near-regular ladder that maps onto its own future at the true
 * advance minus the cadence too, with dying shells and fresh shots
 * tipping the score toward the alias. So only survivors vote: a
 * source statement whose shell already has a matched terminal died
 * mid-pair and is out of the lockstep, and a destination statement
 * already claimed as a new shot is a birth, not anyone's landing
 * spot. Spans across skipped records compose adjacent winners, and
 * exist only when every hop has one.
 *
 * Trusting accepted links instead was tried and measurably backfired:
 * a single uncorroborated pairwise link -- the very crossing this rule
 * exists to kill, admitted while its shell was still a sourceless
 * orphan -- became a unanimous "reference" that then vetoed the three
 * correct joins beside it. Statements outvote links. */
const LOCKSTEP_REFERENCE_MIN_SCORE = 3;
const LOCKSTEP_REFERENCE_MIN_MARGIN = 2;

let record_roster_votes = false;
function set_roster_vote_recording(on) {
	record_roster_votes = !!on;
}

function build_pill_lockstep_reference(snapshots,
	key = (i, j) => `${snapshots[i].time}:${snapshots[j].time}`) {
	let roster = (snapshot, include) => {
		let by_pill = new Map();
		for (let shell of snapshot.shells) {
			if (shell.pillbox_source_x === undefined || !include(shell)) {
				continue;
			}
			let step = pinned_orbit_step(shell.pillbox_orbit_states);
			if (step === null) continue;
			let key = `${shell.pillbox_source_x}:${shell.pillbox_source_y}`;
			let steps = by_pill.get(key);
			if (!steps) by_pill.set(key, steps = new Set());
			steps.add(step);
		}
		return by_pill;
	};
	let sources = snapshots.map(snapshot =>
		roster(snapshot, shell => !shell.next_terminal));
	let targets = snapshots.map(snapshot =>
		roster(snapshot, shell => !shell.starts_at_pillbox &&
			!shell.starts_at_tank));
	let adjacent = snapshots.map(() => new Map());
	for (let i = 0; i + 1 < snapshots.length; i++) {
		let duration = snapshots[i + 1].time - snapshots[i].time;
		let max_advance = Math.ceil(duration / TICKS_PER_SHELL_UPDATE) +
			DILATED_UPDATE_SLACK;
		for (let [pill, steps_a] of sources[i]) {
			let steps_b = targets[i + 1].get(pill);
			if (!steps_b || steps_a.size < LOCKSTEP_REFERENCE_MIN_SCORE) continue;
			let best = null, best_score = 0, runner_up = 0;
			for (let advance = 1; advance <= max_advance; advance++) {
				let score = 0;
				for (let step of steps_a) {
					if (steps_b.has(step + advance)) score++;
				}
				if (score > best_score) {
					runner_up = best_score;
					best_score = score;
					best = advance;
				} else if (score > runner_up) {
					runner_up = score;
				}
			}
			if (best_score >= LOCKSTEP_REFERENCE_MIN_SCORE &&
				best_score >= runner_up + LOCKSTEP_REFERENCE_MIN_MARGIN) {
				adjacent[i].set(pill, best);
			}
		}
	}
	let reference = new Map();
	for (let i = 0; i + 1 < snapshots.length; i++) {
		for (let [pill, first] of adjacent[i]) {
			let advance = first;
			for (let j = i + 1; j < snapshots.length &&
				snapshots[j].time - snapshots[i].time <=
					MAX_STITCH_GAP_TICKS; j++) {
				reference.set(`${pill}:${key(i, j)}`, advance);
				let hop = adjacent[j].get(pill);
				if (hop === undefined) break;
				advance += hop;
			}
		}
	}
	return reference;
}

/* The advance the statement rosters establish for this end's pill over
 * (end.time, start.time), or null when no dominant reference exists --
 * in which case the joins fall back to their ordinary gates, exactly
 * as the matcher's lockstep stands down when no common advance
 * exists. The table is keyed by record time, as the ends and starts
 * are; on a fast ring two snapshots can share a time, and there the
 * one-hop and composed two-hop spans write the same key, last writer
 * winning -- a quirk left as measured (see score_pill_links, which
 * keys by index instead). */
function unanimous_lockstep_advance(reference, end, start) {
	if (!reference) return null;
	let end_shell = end.shell;
	if (end_shell.pillbox_source_x === undefined) return null;
	let states = end_shell.pillbox_orbit_states;
	if (!states || !states.length) return null;
	let advance = reference.get(`${end_shell.pillbox_source_x}:` +
		`${end_shell.pillbox_source_y}:${end.time}:${start.time}`);
	return advance === undefined ? null : advance;
}

/* Measurement only: score every settled pill link against the statement
 * roster vote, so the coverage rates gain a truth axis. The headline
 * rates count explanations, and a wrong link scores the same as a right
 * one; here each shell-to-shell link whose ends both pin an orbit step
 * is checked against the advance the pill's own statements elected over
 * that record pair. Vouched: the step gap equals the elected advance.
 * Contradicted: a vote passed and the link disagrees with it -- the
 * pairwise matcher already defers to this vote, so a contradiction can
 * only come from a stitch or residual join made under its own gates,
 * and the count is a regression alarm rather than a coverage figure.
 * Unvouched: no dominant vote over that pair, so the link stands on
 * cost margins alone. The vote is not independent of the link (its two
 * statements are among the voters), but the score and margin gates
 * mean no single link elects its own advance. Verbatim re-sends carry
 * zero advance by identity and visual joins claim no identity at all,
 * so both stay out of the scored population, as do links from
 * unsourced chains and links with an unpinned end -- the last being
 * exactness lost downstream of a stitch, reported so the debt is
 * visible. Reads final state; changes nothing. */
function score_pill_links(snapshots) {
	let score = {
		links: 0, visual: 0, no_pill_source: 0, restated: 0, unpinned: 0,
		vouched: 0, contradicted: 0, unvouched: 0, examples: [],
		/* How often the matcher's election was available at all: a pill
		 * with fewer than three pinned sources cannot vote, and a vote
		 * inside the margin stands down. */
		votes_unvoted: 0, votes_stood_down: 0, votes_passed: 0,
	};
	for (let snapshot of snapshots) {
		for (let vote of snapshot.roster_votes?.values() ?? []) {
			score[`votes_${vote.verdict}`]++;
		}
	}
	/* Keyed by snapshot index, not time: a fast ring lands two sender
	 * packets in one recorder tick, and time keys would hand a one-hop
	 * link the composed two-hop advance and call it a contradiction. */
	let reference = build_pill_lockstep_reference(snapshots,
		(i, j) => `${i}:${j}`);
	let index_of = new Map();
	snapshots.forEach((snapshot, index) => {
		for (let shell of snapshot.shells) index_of.set(shell, index);
	});
	for (let snapshot of snapshots) {
		for (let shell of snapshot.shells) {
			let next = shell.next_shell;
			if (!next) continue;
			score.links++;
			if (next.visual_join) { score.visual++; continue; }
			if (shell.pillbox_source_x === undefined) {
				score.no_pill_source++;
				continue;
			}
			if (next.stale_restatement) { score.restated++; continue; }
			let step_a = pinned_orbit_step(shell.pillbox_orbit_states);
			let step_b = pinned_orbit_step(next.pillbox_orbit_states);
			if (step_a === null || step_b === null) {
				score.unpinned++;
				continue;
			}
			let advance = reference.get(`${shell.pillbox_source_x}:` +
				`${shell.pillbox_source_y}:${index_of.get(shell)}:` +
				`${index_of.get(next)}`);
			if (advance === undefined) score.unvouched++;
			else if (step_b - step_a === advance) score.vouched++;
			else {
				score.contradicted++;
				/* Every contradiction is kept, not a sample: they are rare
				 * (hundreds corpus-wide) and each one is a scene worth
				 * opening, which is what the rates tool's --describe-links
				 * prints them for. */
				let i = index_of.get(shell), j = index_of.get(next);
				let key = `${shell.pillbox_source_x}:${shell.pillbox_source_y}`;
				let roster = snapshot => snapshot.shells
					.filter(other => `${other.pillbox_source_x}:` +
						`${other.pillbox_source_y}` === key)
					.map(other => pinned_orbit_step(other.pillbox_orbit_states))
					.filter(step => step !== null).sort((a, b) => a - b)
					.join(",");
				score.examples.push({
					time: snapshots[i].time, next_time: snapshots[j].time,
					pillbox_source_x: shell.pillbox_source_x,
					pillbox_source_y: shell.pillbox_source_y,
					step: step_a, next_step: step_b, advance,
					stitched: !!next.stitched,
					/* The matcher's own election over this pair, when the
					 * link is a pairwise one (a stitch spans snapshots the
					 * matcher never paired). */
					match_vote: j === i + 1
						? snapshots[j].roster_votes?.get(key) ?? null : null,
					final_sources: roster(snapshots[i]),
					final_landings: roster(snapshots[j]),
				});
			}
		}
	}
	return score;
}

/* A join the ordinary physics refused, admissible only because the
 * sender's record clock is known to lie: the start must sit forward on
 * the end's ray within stall-to-catch-up bounds, and be reachable on the
 * end's discrete track under the widened window. The penalty keeps every
 * ordinary story preferred, and the resolver's margins arbitrate what
 * remains. A unanimous lockstep reference for the span overrides the
 * widened window entirely: the pill's own statements say how far every
 * one of its shells advanced, so the start must sit at exactly that
 * step. */
function dilated_join_candidate(end, start, reference = null) {
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
	let advance = unanimous_lockstep_advance(reference, end, start);
	if (advance !== null) {
		let relative_x = shell.pixel_x - end_shell.pillbox_source_x;
		let relative_y = shell.pixel_y - end_shell.pillbox_source_y;
		let uncertainty = shell.position_uncertainty || 0;
		let consistent = end_shell.pillbox_orbit_states.some(state => {
			let orbit = PILLBOX_ORBITS_BY_BRADIAN.get(state.bradian);
			let step = state.step + advance;
			return step < orbit.positions.length &&
				pillbox_orbit_position_matches(orbit.positions[step],
					relative_x, relative_y, uncertainty);
		});
		if (!consistent) return null;
	}
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
	/* visual_join marks targets only (the report counts it per shell);
	 * sources carry their own flag so absorption can recognise a
	 * visually-claimed observation on either end of a join. */
	end_shell.visual_join_source = true;
}

/* Carry an origin down a chain: the linked observations are one shell, so
 * the origin belongs to every one of them. Links made by ordinary
 * matching and by stitches both record next_shell, so the walk is direct. */
function propagate_identity_down_chain(origin_shell, first_shell) {
	let hops = 0;
	for (let walk = first_shell; walk && hops < MAX_CHAIN_WALK;
		walk = walk.next_shell, hops++) {
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
function stitch_candidate(end, start, reference = null) {
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
	/* Dilated matches stay out of stitching: a stitch picks winners by
	 * cost margins, and margins between dilated stories are meaningless
	 * (the cost measures the clock's lie, not likelihood). Off-schedule
	 * joins remain dilated_join_candidate's, whose callers bound them. */
	if (match.dilated) return null;
	if (!match.pillbox_orbit_states && !match.tank_bradian_states &&
		duration > MAX_SHELL_INTERPOLATION_TICKS) return null;
	if (match.pillbox_orbit_states) {
		let advance = unanimous_lockstep_advance(reference, end, start);
		if (advance !== null) {
			let end_states = end.shell.pillbox_orbit_states;
			let allowed = new Set(end_states.map(state =>
				state.step + advance));
			let states = match.pillbox_orbit_states.filter(state =>
				allowed.has(state.step));
			if (!states.length) return null;
			match.pillbox_orbit_states = states;
		}
	}
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

/* Discrete evidence that an intermediate observation is the very shell a
 * stitch reconnects, for a pill shot whose orbit is known at both ends.
 * The observation must be an exact orbit point -- within its one-sided
 * quantisation bound -- on a bradian that survives at BOTH ends of the
 * stitch, at a step strictly between the two.
 *
 * This is the widen-in-time-only principle `pill_states_reachable` uses
 * for dilated joins. A lagging sender's record clock can put a
 * restatement far off the uniform-time schedule the geometric test below
 * demands, but no clock can move it off its orbit, so the discrete test
 * subsumes that test rather than relaxing it: the orbit is a straight
 * line at constant velocity, so a point strictly between two of its own
 * steps is on the segment by construction.
 *
 * `floor_step` keeps a run of absorbed observations strictly forward
 * along the orbit; pass -1 for the first.
 *
 * List index is irrelevant to any of this. A chained list member carries
 * a wider bound and so yields several states where a list head yields
 * one, but the shared-bradian and strictly-between tests still bite, and
 * a state set that agrees on one pixel recovers the exact coordinate the
 * quantised offsets lost.
 *
 * Three-way return: null when the discrete evidence is unavailable
 * (either end of the stitch lacks orbit states, or the end has no
 * source), leaving the decision to the geometric gate; an EMPTY array
 * when the evidence exists and rules the observation out -- it sits on
 * no surviving orbit point, or names another pill's stream, so it is
 * provably not this shell however well its geometry reads; otherwise
 * the surviving states. */
function pillbox_absorption_states(end_shell, target_shell, shell, floor_step) {
	let end_states = end_shell.pillbox_orbit_states;
	let target_states = target_shell && target_shell.pillbox_orbit_states;
	if (!end_states || !end_states.length ||
		!target_states || !target_states.length ||
		end_shell.pillbox_source_x === undefined) return null;
	/* A start already claimed by a different pill stream is not this
	 * shell, the same rule stitch_candidate applies to chain starts. */
	if (shell.pillbox_source_x !== undefined &&
		(shell.pillbox_source_x !== end_shell.pillbox_source_x ||
			shell.pillbox_source_y !== end_shell.pillbox_source_y)) return [];
	let relative_x = shell.pixel_x - end_shell.pillbox_source_x;
	let relative_y = shell.pixel_y - end_shell.pillbox_source_y;
	let uncertainty = shell.position_uncertainty || 0;
	let states = [];
	for (let target_state of target_states) {
		let orbit = PILLBOX_ORBITS_BY_BRADIAN.get(target_state.bradian);
		let last = Math.min(target_state.step - 1, orbit.positions.length - 1);
		for (let step = Math.max(floor_step + 1, 0); step <= last; step++) {
			if (!end_states.some(state =>
				state.bradian === target_state.bradian &&
				state.step < step)) continue;
			if (!pillbox_orbit_position_matches(orbit.positions[step],
				relative_x, relative_y, uncertainty)) continue;
			states.push({ bradian: target_state.bradian, step });
		}
	}
	return unique_pillbox_orbit_states(states);
}

/* A stitch may bridge over restatements of the very shell it reconnects:
 * a lagging sender's record timestamps drift against its simulation, so
 * an intermediate observation can fail every pairwise distance test while
 * lying exactly on the stitched path. Left out, it renders as a phantom
 * second shell. Claim every unmatched, origin-less observation between
 * the stitch's endpoints that sits on the segment (within its one-sided
 * quantisation bound), and thread it into the chain in time order.
 *
 * A forced terminal spans a gap the same way a stitch does -- the shell
 * flew from the chain end to the impact, and its restatements in between
 * are the same phantom-second-shell class -- so the caller may pass the
 * terminal's entry orbit states as `target_orbit_states` in place of the
 * far shell a stitch would supply, plus the stamped `terminal` and its
 * `event_time`, and the tail then preserves the terminal linkage
 * apply_forced_terminal recorded and re-times the arrival from the last
 * absorbed observation -- the best-known anchor -- under the same cap
 * rule, so the final drawn link is not compressed by the chain end's
 * lying timestamp. */
function absorb_intermediate_observations(snapshots, end, start,
	target_orbit_states, terminal, event_time) {
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

	let final_time = end_shell.next_time;
	let final_next_shell = end_shell.next_shell;
	let final_terminal = end_shell.next_terminal;
	let orbit_target = final_next_shell ?? (target_orbit_states
		? { pillbox_orbit_states: target_orbit_states } : null);
	let absorbed = [];
	let floor_step = -1;
	/* Snapshots are built in record order and so time-sorted, so the
	 * gap's slice starts at a binary-searched index rather than a scan
	 * from the replay's first record: this runs once per stitch and per
	 * forced terminal, and the scan made the pass quadratic in replay
	 * length. */
	for (let index = first_at_or_after(snapshots, end.time);
		index < snapshots.length; index++) {
		let snapshot = snapshots[index];
		if (snapshot.time <= end.time) continue;
		if (snapshot.time >= final_time) break;
		let candidates = [];
		let visually_claimed = 0;
		for (let shell of snapshot.shells) {
			/* A shell an earlier stitch visually joined was claimed
			 * without identity: it cannot be absorbed, but if it still
			 * fits this chain's window it is proof the snapshot is
			 * ambiguous -- without this, a later overlapping stitch
			 * would see a thinned census and "uniquely" absorb a
			 * stream-mate. */
			let joined = shell.visual_join || shell.visual_join_source;
			if (!joined && (shell.next_time !== undefined ||
				shell.matched_from_previous ||
				shell.starts_at_tank || shell.starts_at_pillbox)) continue;
			if (shell.direction !== end_shell.direction) continue;
			/* The orbit table rules first when it can, in both
			 * directions: an exact point strictly between the stitch's
			 * own two steps is a candidate however far the sender's
			 * clock has drifted, and an observation the surviving orbits
			 * rule out is not this shell however well its geometry
			 * reads. */
			let orbit_states = pillbox_absorption_states(end_shell,
				orbit_target, shell, floor_step);
			if (orbit_states !== null) {
				if (orbit_states.length) {
					if (joined) visually_claimed++;
					else candidates.push({ shell, time: snapshot.time,
						orbit_states });
				} else {
					/* Diagnostic breadcrumb, read by the audit tool: some
					 * stitch's surviving orbits ruled this observation out. */
					shell.absorption_contradicted = true;
				}
				continue;
			}
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
			if (joined) visually_claimed++;
			else candidates.push({ shell, time: snapshot.time });
		}
		/* An angry pillbox fires every five or six ticks, so stream-mates
		 * ride only two or three orbit steps apart and a fragmented
		 * stream can drop several of them, each individually consistent,
		 * into one snapshot of the gap. The chain's own restatement is
		 * among them, but nothing in the snapshot says which it is, and
		 * absorbing more than one would thread same-time restatements
		 * into the chain as a zero-duration link. When the candidate is
		 * not unique, none is absorbed: an unmatched pop is safer than a
		 * smooth but invented path. */
		if (visually_claimed || candidates.length !== 1) {
			/* Diagnostic breadcrumb, read by the audit tool: qualified for
			 * some stitch's gap but was refused as ambiguous. */
			for (let candidate of candidates) {
				candidate.shell.absorption_refused = true;
			}
			continue;
		}
		let candidate = candidates[0];
		if (candidate.orbit_states) {
			floor_step = Math.min(...candidate.orbit_states.map(state =>
				state.step));
		}
		absorbed.push(candidate);
	}
	if (!absorbed.length) return;
	absorbed.sort((a, b) => a.time - b.time);

	let previous = end_shell;
	for (let observation of absorbed) {
		observation.shell.matched_from_previous = true;
		observation.shell.stitched = true;
		/* Identity first: the exact pixel is measured from the pill. */
		propagate_identity_down_chain(end_shell, observation.shell);
		if (observation.orbit_states) {
			set_pillbox_orbit_states(observation.shell, observation.orbit_states);
		}
		previous.next_time = observation.time;
		previous.next_pixel_x = observation.shell.pillbox_orbit_pixel_x ??
			observation.shell.pixel_x;
		previous.next_pixel_y = observation.shell.pillbox_orbit_pixel_y ??
			observation.shell.pixel_y;
		previous.next_terminal = false;
		previous.next_shell = observation.shell;
		previous = observation.shell;
	}
	if (final_terminal && terminal) {
		let last = absorbed[absorbed.length - 1];
		let anchor2_x = last.shell.pillbox_orbit_pixel_x ?? last.shell.pixel_x;
		let anchor2_y = last.shell.pillbox_orbit_pixel_y ?? last.shell.pixel_y;
		let arrival = last.time + Math.hypot(target_x - anchor2_x,
			target_y - anchor2_y) / SHELL_SPEED_PIXELS_PER_TICK;
		final_time = terminal.event_type === "shell_falls" ? arrival
			: Math.min(event_time, arrival);
		terminal.match_time = final_time;
		if (terminal.effect) terminal.effect.time = final_time;
	}
	previous.next_time = final_time;
	previous.next_pixel_x = target_x;
	previous.next_pixel_y = target_y;
	previous.next_terminal = final_terminal;
	if (final_terminal) {
		previous.next_terminal_type = end_shell.next_terminal_type;
		previous.next_terminal_event_type = end_shell.next_terminal_event_type;
		if (previous !== end_shell) {
			end_shell.next_terminal = false;
			delete end_shell.next_terminal_type;
			delete end_shell.next_terminal_event_type;
		}
	}
	previous.next_shell = final_next_shell;
}

/* Births claimed from orbit membership alone, for shells whose firing
 * record never arrived. The corpus's backwards-pop anatomy showed the
 * cost of a lost F4: the shell's first restatement pops in one fire
 * interval behind its dead stream leader, never claimed by anything.
 * But a pill's orbit table is a complete list of every pixel its shells
 * can ever occupy, so origin needs no F4 when geometry is decisive: an
 * origin-less chain whose every observation lies on ONE live pill's
 * orbit, at strictly increasing steps within each observation's
 * one-sided quantisation bound, is that pill's shot. Mirrors
 * mark_unseen_pillbox_terminals, which claims impacts the same way.
 *
 * Confidence rules, against coincidental alignment (a passing shell can
 * sit on an orbit point by chance): a chain of two or more corroborated
 * observations is decisive -- consecutive exact hits on one anchored
 * discrete track do not happen by accident -- while a single sighting
 * is claimed only exact (list head) and fresh from the muzzle. If more
 * than one pill's story survives, none is claimed. Liveness is read at
 * the sighting, not the (unknown) firing tick: a pill destroyed with
 * shells still in flight loses those claims, a conservative miss.
 *
 * Runs after matching, stitching and residual resolution, so every
 * F4-backed and forced explanation has had first refusal. Claims add no
 * links: they name a source, which draws the birth segment from the
 * muzzle and carries attribution down the chain. */
const UNSEEN_BIRTH_MUZZLE_STEP = 4;

function pill_roster_at(pill_states, tick) {
	let lo = 0, hi = pill_states.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (pill_states[mid].time <= tick) lo = mid + 1;
		else hi = mid;
	}
	return lo > 0 ? pill_states[lo - 1].roster : [];
}

/* The head states (bradian and first-sighting step) of every story in
 * which the chain is a shot from the given source; empty when there is
 * none. */
function unseen_birth_head_states(source_x, source_y, chain) {
	let head = chain[0];
	let head_x = head.pixel_x - source_x;
	let head_y = head.pixel_y - source_y;
	if (Math.abs(head_x) > SHELL_RANGE_PIXELS + 4 ||
		Math.abs(head_y) > SHELL_RANGE_PIXELS + 4) return [];
	let states = pillbox_orbit_states_at(head.direction, head_x, head_y,
		head.position_uncertainty).map(state => ({ head: state, step: state.step }));
	for (let i = 1; i < chain.length && states.length; i++) {
		let relative_x = chain[i].pixel_x - source_x;
		let relative_y = chain[i].pixel_y - source_y;
		let advanced = [];
		let seen = new Set();
		for (let state of states) {
			let orbit = PILLBOX_ORBITS_BY_BRADIAN.get(state.head.bradian);
			for (let step = state.step + 1; step < orbit.positions.length; step++) {
				if (!pillbox_orbit_position_matches(orbit.positions[step],
					relative_x, relative_y,
					chain[i].position_uncertainty)) continue;
				let key = `${state.head.bradian}:${state.head.step}:${step}`;
				if (seen.has(key)) continue;
				seen.add(key);
				advanced.push({ head: state.head, step });
			}
		}
		states = advanced;
	}
	let unique = new Map();
	for (let state of states) {
		unique.set(`${state.head.bradian}:${state.head.step}`, state.head);
	}
	return [...unique.values()];
}

function claim_unseen_pillbox_births(snapshots, pill_states) {
	if (!pill_states.length) return;
	for (let snapshot of snapshots) {
		for (let shell of snapshot.shells) {
			if (shell.matched_from_previous || shell.starts_at_tank ||
				shell.starts_at_pillbox) continue;
			if (shell.pillbox_source_x !== undefined) {
				/* Ambiguity propagation already named this head's pill and
				 * orbit states without claiming which stream-mate it is
				 * (propagate_ambiguous_pillbox_orbits) -- the only path
				 * that stores a source on an unclaimed head. Which slot it
				 * holds does not matter for its birth: in every candidate
				 * story it flew here from that muzzle, so claim the drawn
				 * birth rather than leaving the sprite to pop in
				 * mid-flight. */
				if (shell.pillbox_orbit_states &&
					shell.pillbox_orbit_states.length) {
					shell.starts_at_pillbox = true;
					shell.stream_birth = true;
				}
				continue;
			}
			let chain = [shell];
			for (let walk = shell; walk.next_shell && !walk.next_terminal &&
				chain.length < MAX_CHAIN_WALK; walk = walk.next_shell) {
				chain.push(walk.next_shell);
			}
			let claims = [];
			for (let pill of pill_roster_at(pill_states, snapshot.time)) {
				if (!pill) continue;
				let states = unseen_birth_head_states(pill.pixel_x,
					pill.pixel_y, chain);
				if (!states.length) continue;
				if (chain.length < 2 &&
					!(shell.position_uncertainty === 0 &&
						states.every(state =>
							state.step <= UNSEEN_BIRTH_MUZZLE_STEP))) continue;
				claims.push({ pill, states });
			}
			if (claims.length !== 1) continue;
			let claim = claims[0];
			shell.starts_at_pillbox = true;
			shell.unseen_pillbox_shot = true;
			shell.pillbox_source_x = claim.pill.pixel_x;
			shell.pillbox_source_y = claim.pill.pixel_y;
			shell.heading_origin_x = claim.pill.pixel_x;
			shell.heading_origin_y = claim.pill.pixel_y;
			set_pillbox_orbit_states(shell, claim.states);
			let target_x = shell.pillbox_orbit_pixel_x ?? shell.pixel_x;
			let target_y = shell.pillbox_orbit_pixel_y ?? shell.pixel_y;
			let delta_x = target_x - claim.pill.pixel_x;
			let delta_y = target_y - claim.pill.pixel_y;
			let distance = Math.hypot(delta_x, delta_y);
			shell.pillbox_source_distance = distance;
			if (distance > 0) {
				shell.heading_x = delta_x / distance;
				shell.heading_y = delta_y / distance;
			}
			propagate_identity_down_chain(shell, shell.next_shell);
		}
	}
}

/* First index in a time-sorted array whose entry is at or after `time`.
 * The stitching and residual passes pair items across snapshots, but
 * every pairing predicate rejects a gap outside the stitch window, so
 * each item need only scan that time slice instead of the whole replay.
 * The lists involved are built in snapshot order and therefore already
 * sorted. */
function first_at_or_after(items, time, time_of = item => item.time) {
	let lo = 0, hi = items.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (time_of(items[mid]) < time) lo = mid + 1;
		else hi = mid;
	}
	return lo;
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
	let reference = build_pill_lockstep_reference(snapshots);
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
		for (let i = first_at_or_after(starts, end.time);
			i < starts.length &&
			starts[i].time - end.time <= MAX_STITCH_GAP_TICKS; i++) {
			let start = starts[i];
			let candidate = stitch_candidate(end, start, reference);
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
	/* Hang insurance only. Capacities are integers, so every augmentation
	 * moves at least one whole unit and the total left capacity bounds the
	 * round count; a shortest path visits each node at most once. Neither
	 * bound can bind unless float error ever left a negative residual
	 * cycle behind, in which case the partial flow is still safe: the
	 * forcing tests only get more conservative on an under-augmented
	 * solution. */
	let rounds = left_caps.reduce((sum, cap) => sum + cap, 0);
	while (rounds-- > 0) {
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
		let path = [];
		for (let node = sink; node !== source && path.length <= node_count;) {
			path.push(via[node]);
			node = arcs[via[node]].from;
		}
		if (path.length > node_count) break;
		let bottleneck = Infinity;
		for (let index of path) {
			bottleneck = Math.min(bottleneck, arcs[index].cap - arcs[index].flow);
		}
		for (let index of path) {
			arcs[index].flow += bottleneck;
			arcs[index ^ 1].flow -= bottleneck;
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

/* Sizes of what forced_bipartite_assignments actually solves, so a
 * corpus run can say whether the pathological-component cap below ever
 * fires in practice (#28). Accumulates across calls until reset; the
 * report tool resets per file. over_cap_details carries one entry per
 * capped component -- its edge count and the tick span of its nodes --
 * so tools/find-flow-cap-components.cjs can locate the scene; it is
 * only ever appended to in the rare capped case. */
let flow_component_stats = { components: 0, edges_max: 0, over_cap: 0,
	over_cap_details: [] };

function reset_flow_component_stats() {
	flow_component_stats = { components: 0, edges_max: 0, over_cap: 0,
		over_cap_details: [] };
}

/* Both graphs' nodes wrap their subject -- a chain end or start, a
 * creation group, a fate -- with the time it was seen at, under one of
 * a few field names. */
function flow_node_time(node) {
	return node.time ?? node.creation?.time ?? node.fate?.time ??
		node.start?.time ?? node.end?.time;
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
		flow_component_stats.components++;
		flow_component_stats.edges_max = Math.max(
			flow_component_stats.edges_max, edge_indices.length);
		/* A pathological component is left unresolved rather than solved
		 * slowly; corpus-measured components almost always stay well
		 * under this (largest seen: 501 edges, twice in 138757). */
		if (edge_indices.length > 400) {
			let min_time, max_time;
			for (let i of edge_indices) {
				for (let node of [lefts[edges[i].left],
					rights[edges[i].right]]) {
					let time = flow_node_time(node);
					if (time === undefined) continue;
					if (min_time === undefined || time < min_time) min_time = time;
					if (max_time === undefined || time > max_time) max_time = time;
				}
			}
			flow_component_stats.over_cap++;
			flow_component_stats.over_cap_details.push(
				{ edges: edge_indices.length, min_time, max_time });
			continue;
		}
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

/* Can this unconsumed shot have flown, unobserved, into this impact?
 * `extra_flight_ticks` widens the flight-time window for a fire event
 * whose true moment predates its record: a shot and its impact reported
 * in the SAME record (duration zero) is the normal case for point-blank
 * flights shorter than one record gap, and the fire then happened up to
 * that gap before the shared timestamp. The expected flight is an
 * interval, [duration, duration + extra], and cost measures the distance
 * outside it; extra = 0 reproduces the exact original behaviour. */
function creation_fate_match(creation, fate, extra_flight_ticks = 0) {
	let terminal = fate.terminals[0];
	let duration = fate.time - creation.time;
	if (duration < 0 || duration + extra_flight_ticks <= 0 ||
		duration > MAX_STITCH_GAP_TICKS) return null;
	if (terminal.direction !== null && terminal.direction !== undefined &&
		terminal.direction !== creation.direction) return null;
	let reach = Math.min(
		(duration + extra_flight_ticks) * SHELL_SPEED_PIXELS_PER_TICK,
		SHELL_RANGE_PIXELS) + SHELL_MATCH_ERROR_PIXELS;
	let flight_cost = distance => {
		let low = duration * SHELL_SPEED_PIXELS_PER_TICK;
		let high = (duration + extra_flight_ticks) *
			SHELL_SPEED_PIXELS_PER_TICK;
		return (distance < low ? low - distance
			: distance > high ? distance - high : 0) / 2;
	};
	if (creation.kind === "pill") {
		let entry = pillbox_source_terminal_entry(creation, terminal);
		if (entry === null || entry.distance > reach) return null;
		if (duration - entry.distance / SHELL_SPEED_PIXELS_PER_TICK >
			MAX_FATE_EVENT_LAG_TICKS) return null;
		return { distance: entry.distance, entry,
			cost: flight_cost(entry.distance) };
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
	/* Sprite coordinates for the drawn segment: a tank shot has no orbit
	 * table, so the entry is simply the aim point the cost was measured
	 * against, converted from centre to sprite coordinates. */
	return { distance, cost: flight_cost(distance),
		entry: { distance, origin_x: creation.pixel_x,
			origin_y: creation.pixel_y,
			pixel_x: target_x - 8, pixel_y: target_y - 8 } };
}

function apply_forced_terminal(end, fate, match) {
	let terminal = fate.terminals.find(item => item.match_time === undefined);
	if (!terminal) return null;
	/* Same draw rule as the pairwise matcher: only a shell fall, whose
	 * splash is purely cosmetic, keeps a physics arrival later than the
	 * record that reported it. No decision/draw split is needed here —
	 * the flow solver has already made every decision by the time an
	 * assignment is applied, so this value only ever reaches drawing. */
	let arrival = end.time + match.distance / SHELL_SPEED_PIXELS_PER_TICK;
	let end_time = terminal.event_type === "shell_falls" ? arrival
		: Math.min(fate.time, arrival);
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
	return terminal;
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
 * it stops being an open question without claiming a drawn shell. The
 * match's entry carries the origin the geometry actually reached from
 * (a direction-0 F4 may only work from the alternate pill) and the
 * impact-side point, for any later drawing of the unseen flight. */
function apply_forced_unseen(creation, fate, units, match) {
	let applied = 0;
	let entry = match && match.entry;
	for (let terminal of fate.terminals) {
		if (applied >= units) break;
		if (terminal.match_time !== undefined) continue;
		/* One terminal is one shell's impact: a terminal already given an
		 * unseen source of EITHER kind is spoken for, and stamping it
		 * again would waste this claim on it while an identical sibling
		 * stays unexplained. */
		if (terminal.unseen_pillbox_source || terminal.unseen_tank_source) {
			continue;
		}
		if (creation.kind === "pill") {
			terminal.unseen_pillbox_source = true;
			terminal.pillbox_source_x = entry ? entry.origin_x : creation.pixel_x;
			terminal.pillbox_source_y = entry ? entry.origin_y : creation.pixel_y;
			terminal.pillbox_source_direction = creation.direction;
		} else {
			terminal.unseen_tank_source = true;
			terminal.tank_source_x = creation.pixel_x;
			terminal.tank_source_y = creation.pixel_y;
			terminal.tank_source_direction = creation.direction;
		}
		if (entry) {
			terminal.unseen_entry_x = entry.pixel_x;
			terminal.unseen_entry_y = entry.pixel_y;
		}
		applied++;
	}
}

function resolve_residual_shell_fates(snapshots) {
	let reference = build_pill_lockstep_reference(snapshots);
	let ends = [];
	let starts = [];
	let fate_groups = [];
	let creation_groups = [];
	let fate_run_time = null;
	let fate_run_start = 0;
	for (let index = 0; index < snapshots.length; index++) {
		let snapshot = snapshots[index];
		let final = index === snapshots.length - 1;
		/* The gap back to the sender's previous record bounds how late
		 * this record's timestamps can be: how far an event may lead an
		 * end's receiver-clock arrival estimate, and how long before its
		 * record a same-record shot can have been fired. */
		let gap = index > 0 ? snapshot.time - snapshots[index - 1].time : 0;
		for (let shell of snapshot.shells) {
			if (shell.next_time === undefined && !final) {
				ends.push({ shell, time: snapshot.time, gap });
			}
			if (index > 0 && !shell.matched_from_previous &&
				!shell.starts_at_tank && !shell.starts_at_pillbox) {
				starts.push({ shell, time: snapshot.time });
			}
		}
		/* Snapshot times never decrease, so every group sharing this
		 * snapshot's time sits in the contiguous tail run; only that run
		 * can satisfy the find's time test. */
		if (fate_run_time !== snapshot.time) {
			fate_run_time = snapshot.time;
			fate_run_start = fate_groups.length;
		}
		for (let terminal of snapshot.terminals) {
			if (terminal.match_time !== undefined ||
				terminal.unseen_pillbox_source) continue;
			let group = fate_groups.slice(fate_run_start).find(item =>
				same_shell_terminal(item.terminals[0], terminal));
			if (group) group.terminals.push(terminal);
			else fate_groups.push({ time: snapshot.time, terminals: [terminal] });
		}
		let pill_sources = snapshot.unclaimed_pillbox_sources ??
			group_shot_sources(snapshot.pillbox_sources);
		for (let source of pill_sources) {
			creation_groups.push({ kind: "pill", time: snapshot.time, gap,
				...source });
		}
		let tank_sources = snapshot.unclaimed_tank_sources ??
			group_shot_sources(snapshot.tank_sources);
		for (let source of tank_sources) {
			creation_groups.push({ kind: "tank", time: snapshot.time, gap,
				...source });
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

	/* `rights` is two time-sorted runs (starts, then fate groups), and no
	 * edge kind accepts a right behind its left or beyond the stitch gap
	 * ahead, so each left scans only those windows. Scanning each run in
	 * index order keeps the edge list identical, entry for entry, to the
	 * all-pairs construction. */
	let edges = [];
	for (let li = 0; li < lefts.length; li++) {
		let left = lefts[li];
		let left_time = left.kind === "end" ? left.end.time
			: left.creation.time;
		let window = [];
		for (let [items, first_ri] of [[starts, 0],
			[fate_groups, starts.length]]) {
			for (let i = first_at_or_after(items, left_time);
				i < items.length &&
				items[i].time - left_time <= MAX_STITCH_GAP_TICKS; i++) {
				window.push(first_ri + i);
			}
		}
		for (let ri of window) {
			let right = rights[ri];
			if (left.kind === "end" && right.kind === "start") {
				let candidate = stitch_candidate(left.end, right.start,
					reference) ||
					dilated_join_candidate(left.end, right.start, reference);
				if (candidate) {
					edges.push({ left: li, right: ri, candidate,
						cost: candidate.cost });
				}
			} else if (left.kind === "end") {
				let duration = right.fate.time - left.end.time;
				if (duration <= 0 ||
					duration > MAX_SHELL_INTERPOLATION_TICKS) continue;
				/* The event may also LEAD the inferred arrival when the
				 * end's own restatement was delayed: the shell was further
				 * along than its timestamp implies. The lead is bounded by
				 * how late that record can be, which is at most the gap
				 * back to the sender's previous record. */
				let lead_pixels = Math.min(left.end.gap,
					MAX_POSITION_INTERPOLATION_TICKS) *
					SHELL_SPEED_PIXELS_PER_TICK;
				let match = shell_terminal_match(left.end.shell,
					right.fate.terminals[0], duration, left.end.time,
					lead_pixels);
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

	/* A restatement on the way to an impact is part of the impact's own
	 * story, not a rival for it. When one end holds both a fate edge and a
	 * join edge to a lone orphan start that is provably an intermediate of
	 * that fate's flight -- an exact orbit point (within its quantisation
	 * bound) on a bradian surviving at the end, strictly between the end's
	 * step and the fate's entry step -- the join is subsumed: kept out of
	 * the flow so it cannot cost the fate its forcing, and the observation
	 * is absorbed into the terminal segment when the fate is applied.
	 * Without this the two halves of one true story veto each other --
	 * the join and the fate land within the margin of each other, neither
	 * is forced, and the shell pops mid-air with its impact unexplained.
	 * The subsumed edge stays visible to the visual-join pass below, so a
	 * fate the flow ends up not applying still leaves the pop rescuable. */
	let edges_by_left = new Map();
	for (let edge of edges) {
		if (lefts[edge.left].kind !== "end") continue;
		if (!edges_by_left.has(edge.left)) edges_by_left.set(edge.left, []);
		edges_by_left.get(edge.left).push(edge);
	}
	for (let left_edges of edges_by_left.values()) {
		let fates = left_edges.filter(edge =>
			rights[edge.right].kind === "fate" && edge.match &&
			edge.match.pillbox_orbit_states);
		if (!fates.length) continue;
		for (let edge of left_edges) {
			let right = rights[edge.right];
			if (right.kind !== "start") continue;
			if (right.start.shell.next_time !== undefined) continue;
			let end_shell = lefts[edge.left].end.shell;
			if (fates.some(fate =>
				right.start.time < rights[fate.right].fate.time &&
				(pillbox_absorption_states(end_shell,
					{ pillbox_orbit_states: fate.match.pillbox_orbit_states },
					right.start.shell, -1) || []).length)) {
				edge.subsumed = true;
			}
		}
	}

	let assignments = forced_bipartite_assignments(lefts, rights,
		edges.filter(edge => !edge.subsumed));
	/* Observed shells claim terminals before unseen shots mark leftovers. */
	assignments.sort((a, b) =>
		(lefts[a.edge.left].kind === "creation") -
		(lefts[b.edge.left].kind === "creation"));
	let creation_spent = new Map();
	for (let { edge, units } of assignments) {
		let left = lefts[edge.left];
		let right = rights[edge.right];
		if (left.kind === "creation") {
			creation_spent.set(left.creation,
				(creation_spent.get(left.creation) || 0) + units);
		}
		if (left.kind === "end" && right.kind === "start") {
			if (left.end.shell.next_time !== undefined ||
				right.start.shell.matched_from_previous) continue;
			apply_stitch(edge.candidate);
			absorb_intermediate_observations(snapshots, left.end, right.start);
		} else if (left.kind === "end") {
			if (left.end.shell.next_time !== undefined) continue;
			let terminal = apply_forced_terminal(left.end, right.fate,
				edge.match);
			/* The flight to a forced terminal spans a gap the way a stitch
			 * does: restatements inside it -- subsumed-join orphans among
			 * them -- are this shell's, under the same census. */
			if (terminal) {
				absorb_intermediate_observations(snapshots, left.end, null,
					edge.match.pillbox_orbit_states, terminal,
					right.fate.time);
			}
		} else if (right.kind === "start") {
			if (right.start.shell.matched_from_previous ||
				right.start.shell.starts_at_tank ||
				right.start.shell.starts_at_pillbox) continue;
			apply_forced_origin(left.creation, right.start, edge.match);
		} else {
			apply_forced_unseen(left.creation, right.fate, units, edge.match);
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

	/* Die-at-impact: the drawn-side twin of the visual join, for chain
	 * ends the flow left with nothing. A shell that vanishes mid-air with
	 * an unexplained impact inside its physics window is the audit's
	 * pop-out class; when every story within the forcing margin for that
	 * end is a death at ONE place -- no continuation candidate survives
	 * inside the margin, and every within-margin open fate shares one
	 * geometry -- the stories differ only in which identical event it
	 * was, so the end takes the cheapest still-open one and the vanish
	 * becomes a death at the wall. This pass re-probes CURRENT shell
	 * state rather than reusing the graph's edges: the flow's own
	 * forced-origin assignments give chains headings after the edges were
	 * built, and a box terminal needs that ray. It runs before the
	 * unseen-shot phases so an observed shell outranks an invisible
	 * sibling for the same impact; ends are served cheapest-first and
	 * re-checked so capacity is never exceeded. */
	let terminal_open = terminal => terminal.match_time === undefined &&
		!terminal.unseen_pillbox_source && !terminal.unseen_tank_source;
	let deaths = [];
	for (let index = 0; index + 1 < snapshots.length; index++) {
		let snapshot = snapshots[index];
		let gap = index > 0 ? snapshot.time - snapshots[index - 1].time : 0;
		let lead_pixels = Math.min(gap, MAX_POSITION_INTERPOLATION_TICKS) *
			SHELL_SPEED_PIXELS_PER_TICK;
		for (let shell of snapshot.shells) {
			if (shell.next_time !== undefined) continue;
			let end = { shell, time: snapshot.time, gap };
			let fates = [];
			let continuation_cost = Infinity;
			for (let j = index + 1; j < snapshots.length; j++) {
				let duration = snapshots[j].time - snapshot.time;
				if (duration <= 0) continue;
				if (duration > MAX_STITCH_GAP_TICKS) break;
				for (let other of snapshots[j].shells) {
					if (other.matched_from_previous || other.starts_at_tank ||
						other.starts_at_pillbox) continue;
					let start = { shell: other, time: snapshots[j].time };
					let candidate = stitch_candidate(end, start, reference) ||
						dilated_join_candidate(end, start, reference);
					if (candidate) {
						continuation_cost = Math.min(continuation_cost,
							candidate.cost);
					}
				}
				if (duration > MAX_SHELL_INTERPOLATION_TICKS) continue;
				for (let terminal of snapshots[j].terminals) {
					if (!terminal_open(terminal)) continue;
					let match = shell_terminal_match(shell, terminal,
						duration, snapshot.time, lead_pixels);
					if (!match || duration -
						match.distance / SHELL_SPEED_PIXELS_PER_TICK >
							MAX_FATE_EVENT_LAG_TICKS) continue;
					fates.push({ terminal, match, cost: match.cost,
						time: snapshots[j].time,
						geometry: terminal.type === "point"
							? `p${terminal.pixel_x},${terminal.pixel_y}`
							: `b${terminal.min_x},${terminal.min_y}` });
				}
			}
			if (!fates.length) continue;
			let best = Math.min(...fates.map(fate => fate.cost));
			if (continuation_cost < best + RESIDUAL_COST_MARGIN) continue;
			let within = fates.filter(fate =>
				fate.cost < best + RESIDUAL_COST_MARGIN);
			if (new Set(within.map(fate => fate.geometry)).size !== 1) {
				continue;
			}
			within.sort((a, b) => a.cost - b.cost);
			deaths.push({ end, within, best });
		}
	}
	deaths.sort((a, b) => a.best - b.best);
	for (let { end, within } of deaths) {
		if (end.shell.next_time !== undefined) continue;
		for (let { terminal, match, time } of within) {
			if (!terminal_open(terminal)) continue;
			apply_forced_terminal(end, { time, terminals: [terminal] },
				match);
			break;
		}
	}

	/* Phase two: same-record shots onto the fates that remain. A shell
	 * fired and dead inside one record gap has its shot and its impact
	 * reported in the same record -- duration zero, which the graph above
	 * never admits -- and that is the NORMAL case for point-blank flights
	 * (adjacent-pill crossfire, ramming duels). These edges compete only
	 * with each other, never with observed shells: phase one is already
	 * applied, so nothing it explained can degrade, and capacity it spent
	 * is honoured. Forced winners get the same unseen-source marking as
	 * phase-one leftovers. */
	let open_fates = () => {
		let leftover = [];
		for (let fate of fate_groups) {
			let open = fate.terminals.filter(terminal =>
				terminal.match_time === undefined &&
				!terminal.unseen_pillbox_source &&
				!terminal.unseen_tank_source).length;
			if (open) leftover.push({ fate, count: open });
		}
		return leftover;
	};
	let leftover_fates = open_fates();
	let leftover_creations = creation_groups
		.map(creation => ({ creation, count:
			creation.count - (creation_spent.get(creation) || 0) }))
		.filter(item => item.count > 0 && item.creation.gap > 0);
	if (leftover_fates.length && leftover_creations.length) {
		let second_edges = [];
		for (let li = 0; li < leftover_creations.length; li++) {
			let creation = leftover_creations[li].creation;
			/* These edges are same-record by definition, so only the
			 * equal-time run of the (time-sorted) leftover fates applies. */
			for (let ri = first_at_or_after(leftover_fates, creation.time,
				item => item.fate.time);
				ri < leftover_fates.length &&
				leftover_fates[ri].fate.time === creation.time; ri++) {
				let fate = leftover_fates[ri].fate;
				let match = creation_fate_match(creation, fate, creation.gap);
				if (match) {
					second_edges.push({ left: li, right: ri, match,
						cost: match.cost });
				}
			}
		}
		for (let { edge, units } of forced_bipartite_assignments(
			leftover_creations, leftover_fates, second_edges)) {
			let creation = leftover_creations[edge.left].creation;
			apply_forced_unseen(creation,
				leftover_fates[edge.right].fate, units, edge.match);
			creation_spent.set(creation,
				(creation_spent.get(creation) || 0) + units);
		}
	}

	/* Phase three: equivalence-forced attributions. Interchangeable
	 * parallel stories defeat per-edge forcing -- two identical shots
	 * from one muzzle explaining two identical impacts leave no single
	 * edge forced even though the SOURCE is certain in every story, the
	 * same argument stream-provenance births rest on. For each fate
	 * still open, gather every creation story left (same-record ones
	 * with their gap widening), keep those within the forcing margin of
	 * the cheapest, and attribute only when they all name one source
	 * identity AND no live shell story competes inside that margin (a
	 * costlier shell story was already beaten by phase-one cost-forcing
	 * standards; a competing one keeps the fate open). Claims draw down
	 * a shared per-identity capacity pool, cheapest fate first, so a
	 * muzzle never explains more impacts than it has unspent shots. */
	let identity_of = creation => `${creation.kind}:${creation.pixel_x},` +
		`${creation.pixel_y},${creation.direction}`;
	let live_end_cost = new Map();
	for (let edge of edges) {
		let left = lefts[edge.left];
		let right = rights[edge.right];
		if (left.kind !== "end" || right.kind !== "fate") continue;
		if (left.end.shell.next_time !== undefined) continue;
		let best = live_end_cost.get(right.fate);
		if (best === undefined || edge.cost < best) {
			live_end_cost.set(right.fate, edge.cost);
		}
	}
	let pool = new Map();
	for (let creation of creation_groups) {
		let unspent = creation.count - (creation_spent.get(creation) || 0);
		if (unspent <= 0) continue;
		let identity = identity_of(creation);
		pool.set(identity, (pool.get(identity) || 0) + unspent);
	}
	let eligible = [];
	for (let { fate, count } of open_fates()) {
		let candidates = [];
		/* A shot explains a fate only from behind it and within the
		 * stitch gap, so only that slice of the (time-sorted) creation
		 * groups can produce a story. */
		for (let ci = first_at_or_after(creation_groups,
			fate.time - MAX_STITCH_GAP_TICKS);
			ci < creation_groups.length &&
			creation_groups[ci].time <= fate.time; ci++) {
			let creation = creation_groups[ci];
			if (creation.count <= (creation_spent.get(creation) || 0)) continue;
			let extra = fate.time === creation.time ? creation.gap : 0;
			let match = creation_fate_match(creation, fate, extra);
			if (match) candidates.push({ creation, cost: match.cost, match });
		}
		if (!candidates.length) continue;
		let best = Math.min(...candidates.map(candidate => candidate.cost));
		let end_cost = live_end_cost.get(fate);
		if (end_cost !== undefined &&
			end_cost < best + RESIDUAL_COST_MARGIN) continue;
		let within = candidates.filter(candidate =>
			candidate.cost < best + RESIDUAL_COST_MARGIN);
		let identities = new Set(within.map(candidate =>
			identity_of(candidate.creation)));
		if (identities.size !== 1) continue;
		eligible.push({ fate, count, best,
			identity: [...identities][0],
			creation: within[0].creation,
			match: within[0].match });
	}
	eligible.sort((a, b) => a.best - b.best);
	let members_by_identity = new Map();
	for (let creation of creation_groups) {
		let identity = identity_of(creation);
		if (!members_by_identity.has(identity)) {
			members_by_identity.set(identity, []);
		}
		members_by_identity.get(identity).push(creation);
	}
	for (let { fate, count, identity, creation, match } of eligible) {
		let capacity = pool.get(identity) || 0;
		if (capacity <= 0) continue;
		let units = Math.min(count, capacity);
		apply_forced_unseen(creation, fate, units, match);
		pool.set(identity, capacity - units);
		/* Charge the spend across the identity's members greedily; the
		 * pool never exceeds their remaining counts, so it always fits. */
		let owed = units;
		for (let member of members_by_identity.get(identity)) {
			if (owed <= 0) break;
			let unspent = member.count - (creation_spent.get(member) || 0);
			if (unspent <= 0) continue;
			let charge = Math.min(unspent, owed);
			creation_spent.set(member,
				(creation_spent.get(member) || 0) + charge);
			owed -= charge;
		}
	}

	/* Write the pass's own spending back to the snapshots, so downstream
	 * readers (today the terminal-failure diagnostics; any later pass
	 * tomorrow) see the capacity that actually remains. A shot the
	 * resolver claimed for an origin or an impact is not available to
	 * explain anything else, and counting it again would dress exhausted
	 * sources up as open stories. */
	let creations_by_time = new Map();
	for (let creation of creation_groups) {
		let run = creations_by_time.get(creation.time);
		if (!run) creations_by_time.set(creation.time, run = []);
		run.push(creation);
	}
	for (let snapshot of snapshots) {
		for (let [key, kind] of [
			["unclaimed_pillbox_sources", "pill"],
			["unclaimed_tank_sources", "tank"],
		]) {
			if (!snapshot[key]) continue;
			/* Indexed by time rather than filtered per snapshot: the
			 * filter walked every creation group for every snapshot,
			 * quadratic in replay length and the pass's largest cost. */
			let remaining = [];
			for (let creation of creations_by_time.get(snapshot.time) || []) {
				if (creation.kind !== kind) continue;
				let count = creation.count -
					(creation_spent.get(creation) || 0);
				if (count > 0) remaining.push({ ...creation, count });
			}
			snapshot[key] = remaining;
		}
	}
}

/* Terminal-failure diagnostics: why is each still-unexplained terminal
 * unexplained? Post-hoc and read-only. For every terminal that finished
 * the pipeline with no matched shell and no unseen-source attribution,
 * probe the nearby shell observations and unclaimed shots with the same
 * predicates the residual pass used, relaxing one constraint at a time,
 * and name the constraint that killed the nearest-to-viable story. This
 * is measurement, not reconstruction: nothing here writes to shells or
 * terminals, and the classes feed the report tool's tally, which is the
 * starting data for terminal-matching work. Failure reasons in rank
 * order, nearest-to-explained first; a terminal takes the best rank any
 * candidate achieves. */
const TERMINAL_FAILURE_RANK = new Map([
	"edge_unforced",          /* a legal edge existed; the flow declined it */
	"end_continued",          /* a matching shell was continued past it */
	"end_claimed_other_fate", /* a matching shell took a different terminal */
	"creation_unforced",      /* an unclaimed shot reaches it; not forced */
	"timing_lag",             /* geometry fine; event trails arrival too far */
	"timing_lead",            /* geometry fine; event leads beyond the gap */
	"window_expired",         /* geometry fine; end older than the edge window */
	"orbit_miss",             /* orbit-tracked ends nearby; no orbit enters */
	"ray_miss",               /* ordinary ends nearby; every ray misses */
	"direction",              /* only wrong-direction ends nearby */
	"no_candidate",           /* nothing at all to probe */
].map((reason, rank) => [reason, rank]));

/* The shared geometric/timing predicate both diagnostic directions use:
 * would this (observation, terminal) pair have made a residual edge, and
 * if not, which single constraint killed it? Returns "edge" on success
 * or the failure reason. */
function terminal_candidate_geometry(shell, end_time, gap, terminal,
	terminal_time) {
	let duration = terminal_time - end_time;
	if (terminal.direction !== null && terminal.direction !== undefined &&
		terminal.direction !== shell.direction) {
		return "direction";
	}
	let lead_pixels = Math.min(gap, MAX_POSITION_INTERPOLATION_TICKS) *
		SHELL_SPEED_PIXELS_PER_TICK;
	let match = shell_terminal_match(shell, terminal, duration, end_time,
		lead_pixels);
	if (!match) {
		/* Unreachable under the pass's own bounds. Re-test with the lead
		 * widened to the shell's whole flight range, purely to separate a
		 * timing failure from a geometric one. */
		match = shell_terminal_match(shell, terminal, duration, end_time,
			SHELL_RANGE_PIXELS, SHELL_RANGE_PIXELS);
		if (match && match.distance <=
			SHELL_RANGE_PIXELS + SHELL_MATCH_ERROR_PIXELS) {
			return duration > MAX_SHELL_INTERPOLATION_TICKS
				? "window_expired" : "timing_lead";
		}
		return shell.pillbox_orbit_states ? "orbit_miss" : "ray_miss";
	}
	if (duration > MAX_SHELL_INTERPOLATION_TICKS) return "window_expired";
	if (duration - match.distance / SHELL_SPEED_PIXELS_PER_TICK >
		MAX_FATE_EVENT_LAG_TICKS) return "timing_lag";
	return "edge";
}

function classify_terminal_candidate(shell, end_time, gap, terminal,
	terminal_time) {
	let reason = terminal_candidate_geometry(shell, end_time, gap, terminal,
		terminal_time);
	if (reason !== "edge") return reason;
	if (shell.next_time !== undefined) {
		return shell.next_terminal ? "end_claimed_other_fate" : "end_continued";
	}
	return "edge_unforced";
}

function terminal_candidate_kind(shell) {
	if (shell.pillbox_source_x !== undefined ||
		shell.pillbox_orbit_states) return "P";
	if (shell.starts_at_tank || shell.birth_time !== undefined) return "T";
	return "?";
}

function describe_terminal_failure(snapshots, index, terminal) {
	let time = snapshots[index].time;
	let best = null;
	let consider = (reason, kind, candidate) => {
		let rank = TERMINAL_FAILURE_RANK.get(reason);
		if (!best || rank < best.rank) best = { reason, rank, kind, candidate };
	};
	for (let j = index; j >= 0; j--) {
		let snapshot = snapshots[j];
		let duration = time - snapshot.time;
		if (duration > MAX_STITCH_GAP_TICKS) break;
		if (duration < 0) continue;
		let gap = j > 0 ? snapshot.time - snapshots[j - 1].time : 0;
		for (let shell of duration > 0 ? snapshot.shells : []) {
			let reason = classify_terminal_candidate(shell, snapshot.time, gap,
				terminal, time);
			consider(reason, terminal_candidate_kind(shell), {
				time: snapshot.time, pixel_x: shell.pixel_x,
				pixel_y: shell.pixel_y, direction: shell.direction, shell,
			});
		}
		/* Unclaimed shots are the residual pass's other explainer,
		 * including a same-record shot probed with the fire-time window
		 * the pass's second phase grants it. The unclaimed lists predate
		 * that pass's own consumption, so a source it forced elsewhere
		 * can still appear here; the class is read as "a fired shot could
		 * reach it", not "one remains unspent". */
		for (let [kind, sources, creation_kind] of [
			["P", snapshot.unclaimed_pillbox_sources, "pill"],
			["T", snapshot.unclaimed_tank_sources, "tank"],
		]) {
			for (let source of sources || []) {
				let creation = { kind: creation_kind, time: snapshot.time,
					...source };
				if (creation_fate_match(creation, { time,
					terminals: [terminal] }, duration > 0 ? 0 : gap)) {
					consider("creation_unforced", kind, {
						time: snapshot.time, pixel_x: source.pixel_x,
						pixel_y: source.pixel_y, direction: source.direction,
					});
				}
			}
		}
	}
	return {
		time,
		event_type: terminal.event_type || "unknown",
		terminal_type: terminal.type,
		pixel_x: terminal.type === "point" ? terminal.pixel_x : terminal.min_x,
		pixel_y: terminal.type === "point" ? terminal.pixel_y : terminal.min_y,
		direction: terminal.direction,
		reason: best ? best.reason : "no_candidate",
		detail: best && best.reason === "end_continued"
			? end_continued_detail(best.candidate.shell, terminal) : "",
		kind: best ? best.kind : "-",
		candidate: best ? best.candidate : null,
	};
}

/* Subclassify an end_continued failure -- the dial the roadmap's
 * continue-vs-die question will turn, measured before it is designed:
 * ".thru"  the chosen continuation is drawn PAST the impact point (the
 *          visible fly-through artifact);
 * ".short" the continuation falls short of it (the chain is still
 *          approaching; the impact belongs to its volley, ahead of it);
 * "+clps"  the chain later claims a terminal of the same event type in
 *          the same box -- one chain riding a stream that caused several
 *          identical impacts and can only pay for one;
 * "+reb"   pill chains only: the orphaned continuation sits on the same
 *          source's orbits, so a split here could rebirth it as a
 *          stream-mate rather than leaving a naked pop. */
function end_continued_detail(shell, terminal) {
	let heading_x = shell.heading_x, heading_y = shell.heading_y;
	if (heading_x === undefined) {
		let angle = shell.direction * Math.PI / 8;
		heading_x = Math.sin(angle);
		heading_y = -Math.cos(angle);
	}
	let target_x = (terminal.type === "point"
		? terminal.pixel_x : terminal.min_x) + 8;
	let target_y = (terminal.type === "point"
		? terminal.pixel_y : terminal.min_y) + 8;
	let impact_proj = (target_x - (shell.pixel_x + 8)) * heading_x +
		(target_y - (shell.pixel_y + 8)) * heading_y;
	let next_proj = (shell.next_pixel_x - shell.pixel_x) * heading_x +
		(shell.next_pixel_y - shell.pixel_y) * heading_y;
	let detail = next_proj > impact_proj + 8 ? ".thru" : ".short";
	let walk = shell;
	for (let hops = 0; walk.next_shell && !walk.next_terminal &&
		hops < MAX_CHAIN_WALK; hops++) {
		walk = walk.next_shell;
	}
	if (walk.next_terminal &&
		walk.next_terminal_event_type === terminal.event_type &&
		terminal.type === "box" &&
		walk.next_pixel_x + 8 >= terminal.min_x - 2 &&
		walk.next_pixel_x + 8 < terminal.max_x + 2 &&
		walk.next_pixel_y + 8 >= terminal.min_y - 2 &&
		walk.next_pixel_y + 8 < terminal.max_y + 2) {
		detail += "+clps";
	}
	if (shell.pillbox_source_x !== undefined && shell.next_shell) {
		let follower = shell.next_shell;
		let states = pillbox_orbit_states_at(
			follower.direction ?? shell.direction,
			follower.pixel_x - shell.pillbox_source_x,
			follower.pixel_y - shell.pillbox_source_y,
			follower.position_uncertainty || 0);
		if (states.length) detail += "+reb";
	}
	return detail;
}

function describe_unmatched_terminals(snapshots) {
	let described = [];
	for (let index = 0; index < snapshots.length; index++) {
		let snapshot = snapshots[index];
		for (let terminal of snapshot.terminals) {
			if (terminal.match_time !== undefined ||
				terminal.unseen_pillbox_source ||
				terminal.unseen_tank_source) continue;
			described.push(describe_terminal_failure(snapshots, index,
				terminal));
		}
	}
	return described;
}

/* The end-side mirror of the terminal census: for every chain end with
 * no forward story (the engine population behind the audit's drawn
 * pop-outs -- final-snapshot ends excluded, the game simply stopped),
 * what fate was available and what blocked it? Reasons in rank order,
 * nearest-to-a-death first:
 *   fate_open     a valid edge to a STILL-unexplained impact exists --
 *                 pure ambiguity, the die-at-impact dial's target;
 *   fate_unseen   a valid edge to an impact that was attributed to an
 *                 unseen shot instead -- an observed shell's death may
 *                 have been given away to an invisible sibling;
 *   fate_taken    a valid edge to an impact another shell claimed;
 *   timing/geometry/direction as in the terminal census;
 *   no_candidate  nothing to probe.
 * Read-only, like the terminal census. */
const END_FATE_RANK = new Map([
	"fate_open", "fate_unseen", "fate_taken",
	"timing_lag", "timing_lead", "window_expired",
	"orbit_miss", "ray_miss", "direction", "no_candidate",
].map((reason, rank) => [reason, rank]));

function describe_end_failure(snapshots, index, shell, gap) {
	let end_time = snapshots[index].time;
	let best = null;
	let consider = (reason, event_type, candidate) => {
		let rank = END_FATE_RANK.get(reason);
		if (!best || rank < best.rank) {
			best = { reason, rank, event_type, candidate };
		}
	};
	for (let j = index + 1; j < snapshots.length; j++) {
		let duration = snapshots[j].time - end_time;
		if (duration <= 0) continue;
		if (duration > MAX_STITCH_GAP_TICKS) break;
		for (let terminal of snapshots[j].terminals) {
			let reason = terminal_candidate_geometry(shell, end_time, gap,
				terminal, snapshots[j].time);
			if (reason === "edge") {
				reason = terminal.match_time !== undefined ? "fate_taken"
					: terminal.unseen_pillbox_source ||
						terminal.unseen_tank_source ? "fate_unseen"
					: "fate_open";
			}
			consider(reason, terminal.event_type || "unknown", {
				time: snapshots[j].time,
				pixel_x: terminal.type === "point"
					? terminal.pixel_x : terminal.min_x,
				pixel_y: terminal.type === "point"
					? terminal.pixel_y : terminal.min_y,
			});
		}
	}
	return {
		time: end_time,
		pixel_x: shell.pixel_x,
		pixel_y: shell.pixel_y,
		direction: shell.direction,
		kind: terminal_candidate_kind(shell),
		reason: best ? best.reason : "no_candidate",
		event_type: best ? best.event_type : "-",
		candidate: best ? best.candidate : null,
	};
}

function describe_unfated_ends(snapshots) {
	let described = [];
	for (let index = 0; index + 1 < snapshots.length; index++) {
		let snapshot = snapshots[index];
		let gap = index > 0 ? snapshot.time - snapshots[index - 1].time : 0;
		for (let shell of snapshot.shells) {
			if (shell.next_time !== undefined) continue;
			described.push(describe_end_failure(snapshots, index, shell,
				gap));
		}
	}
	return described;
}

/* The chain tail is the smoothing pass's other fixed time anchor, with
 * the head's disease mirrored: an end whose last restatement was
 * received stale sits well behind the shell's true position, and when
 * an honest impact record then arrives, the terminal link must cover
 * the missing flight inside the stamp window -- the audit's
 * rushed-terminal class, its largest fast-drawing class by far (a 3x
 * sprint into a pillbox in 110702.1), with the chain behind it dragged
 * slow by the same stale anchor. The terminal link's drawn length is
 * itself the sender's clock, so when it exceeds the stamp window by
 * more than the one-sided quantisation bound explains, slide the end's
 * drawn position forward along the link to where the shell truly was
 * at its stamped time, leaving exactly the window's worth of flight to
 * the impact. Runs before smoothing, whose final anchor prefers the
 * slid position, so the chain re-times onto the honest anchor and the
 * crawl and the sprint cancel together. Shell falls never qualify:
 * their drawn end is the uncapped physics arrival, already at true
 * speed, so their excess is zero by construction. Drawing only:
 * packet-exact state, matching and the impact's own timing are
 * untouched. */
function slide_compressed_chain_tails(snapshots) {
	for (let snapshot of snapshots) {
		for (let shell of snapshot.shells) {
			if (!shell.next_terminal || shell.next_time === undefined) continue;
			let window = shell.next_time - snapshot.time;
			if (!(window >= 0)) continue;
			let from_x = shell.pillbox_orbit_pixel_x ??
				shell.tank_exact_pixel_x ?? shell.pixel_x;
			let from_y = shell.pillbox_orbit_pixel_y ??
				shell.tank_exact_pixel_y ?? shell.pixel_y;
			let distance = Math.hypot(shell.next_pixel_x - from_x,
				shell.next_pixel_y - from_y);
			let excess = distance - window * SHELL_SPEED_PIXELS_PER_TICK;
			if (excess <= CHAIN_HEAD_SLIDE_THRESHOLD_PIXELS) continue;
			let amount = Math.min(excess / distance, 1);
			shell.smooth_pixel_x = from_x + (shell.next_pixel_x - from_x) * amount;
			shell.smooth_pixel_y = from_y + (shell.next_pixel_y - from_y) * amount;
		}
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
 * as observed. The final anchor prefers a slid tail's drawn position:
 * the slide has already established the stamped time's honest place on
 * the ray, and re-timing onto the stale packet coordinate would undo
 * it. */
function smooth_shell_chains(snapshots) {
	for (let snapshot of snapshots) {
		for (let shell of snapshot.shells) {
			if (shell.matched_from_previous) continue;
			let entries = [{ shell, time: snapshot.time }];
			let walk = shell;
			while (walk.next_shell && !walk.next_terminal &&
				entries.length < MAX_CHAIN_WALK) {
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
			let final_x = last.smooth_pixel_x ?? last.pillbox_orbit_pixel_x ??
				last.tank_exact_pixel_x ?? last.pixel_x;
			let final_y = last.smooth_pixel_y ?? last.pillbox_orbit_pixel_y ??
				last.tank_exact_pixel_y ?? last.pixel_y;
			let total = entries[entries.length - 1].time - entries[0].time;
			if (total <= 0) continue;
			let chord = Math.hypot(final_x - anchor_x, final_y - anchor_y);
			let unit_x = chord > 0 ? (final_x - anchor_x) / chord : 0;
			let unit_y = chord > 0 ? (final_y - anchor_y) / chord : 0;

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
				let delta_x = observed_x - smooth_x;
				let delta_y = observed_y - smooth_y;
				let along = chord > 0
					? Math.abs(delta_x * unit_x + delta_y * unit_y)
					: Math.hypot(delta_x, delta_y);
				let cross = chord > 0
					? Math.abs(delta_x * unit_y - delta_y * unit_x)
					: 0;
				if (cross > MAX_SMOOTHING_DEVIATION_PIXELS ||
					along > MAX_SMOOTHING_ALONG_TRACK_PIXELS) {
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

/* Close the seams the pipeline can leave at handoffs. Several passes
 * store a link's endpoint at the moment they create it -- a stitch's
 * exact orbit pixel, a visual join's packet coordinate -- and later
 * passes can refine where the successor actually draws (an orbit
 * recovery moving a quantised member a few pixels, say), leaving the
 * link flying to where its successor used to be and the sprite
 * teleporting for one frame at the handoff. Drawing only: aim every
 * unsmoothed non-terminal link at its successor's final draw source;
 * smoothed links already aim at the successor's smoothed position by
 * construction. Runs after smoothing and before head sliding, which
 * measures its sprint from the corrected endpoint. */
function reconcile_link_targets(snapshots) {
	for (let snapshot of snapshots) {
		for (let shell of snapshot.shells) {
			if (!shell.next_shell || shell.next_terminal ||
				shell.smooth_next_pixel_x !== undefined) continue;
			let next = shell.next_shell;
			shell.next_pixel_x = next.smooth_pixel_x ??
				next.pillbox_orbit_pixel_x ?? next.tank_exact_pixel_x ??
				next.pixel_x;
			shell.next_pixel_y = next.smooth_pixel_y ??
				next.pillbox_orbit_pixel_y ?? next.tank_exact_pixel_y ??
				next.pixel_y;
		}
	}
}

/* A chain head is a time anchor the smoothing pass never moves, so a head
 * whose record was received late poisons its first link: the sender kept
 * simulating while the record sat in transit, and the next, punctually
 * received restatement then sits far further along the flight than the
 * receiver-stamp gap can carry at shell speed, drawing a sprint. The
 * distance between the two drawn positions is itself the sender's clock
 * (shells fly at exactly SHELL_SPEED_PIXELS_PER_TICK), so when it exceeds
 * the stamp window by more than quantisation explains, slide the head's
 * drawn position forward along the link to where the shell truly was at
 * the stamped time, leaving exactly the window's worth of flight. The
 * birth segment builder re-derives its span from the slid position, so
 * the pre-record flight stays seamless at true speed. Drawing only:
 * packet-exact state, matching and terminal timing are untouched. */
function slide_compressed_chain_heads(snapshots) {
	for (let snapshot of snapshots) {
		for (let shell of snapshot.shells) {
			if (shell.matched_from_previous || !shell.next_shell) continue;
			let window = shell.next_time - snapshot.time;
			if (!(window >= 0)) continue;
			let from_x = shell.smooth_pixel_x ?? shell.pillbox_orbit_pixel_x ??
				shell.tank_exact_pixel_x ?? shell.pixel_x;
			let from_y = shell.smooth_pixel_y ?? shell.pillbox_orbit_pixel_y ??
				shell.tank_exact_pixel_y ?? shell.pixel_y;
			let to_x = shell.smooth_next_pixel_x ?? shell.next_pixel_x;
			let to_y = shell.smooth_next_pixel_y ?? shell.next_pixel_y;
			let distance = Math.hypot(to_x - from_x, to_y - from_y);
			let excess = distance - window * SHELL_SPEED_PIXELS_PER_TICK;
			if (excess <= CHAIN_HEAD_SLIDE_THRESHOLD_PIXELS) continue;
			let amount = Math.min(excess / distance, 1);
			shell.smooth_pixel_x = from_x + (to_x - from_x) * amount;
			shell.smooth_pixel_y = from_y + (to_y - from_y) * amount;
		}
	}
}

/* Per-client shell restatements used only for drawing. Keeping separate
 * client tracks is intentional: chains never cross clients. The idea that
 * a shell's ownership could migrate between machines in flight is
 * regarded as highly suspicious -- Bolo has no orchestration that could
 * do it, and corpus measurement found no scene that needed it -- and
 * joining across clients would create especially convincing false
 * identities. Whatever a cross-client coincidence really is, it renders
 * conservatively as one shell disappearing and another appearing. */
function build_shell_positions(records, terminals, pillbox_sources_by_record,
	tank_sources_by_record, tank_positions = null, pill_states = []) {
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
	for (let client_snapshots of snapshots) {
		stitch_shell_chains(client_snapshots);
		resolve_residual_shell_fates(client_snapshots);
		claim_unseen_pillbox_births(client_snapshots, pill_states);
		slide_compressed_chain_tails(client_snapshots);
		smooth_shell_chains(client_snapshots);
		reconcile_link_targets(client_snapshots);
		slide_compressed_chain_heads(client_snapshots);
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
					/* Keep the synthetic segment continuous with the drawn
					 * position: a slid head first, else an exact orbit position
					 * recovered from a quantised shell-list member. */
					let target_pixel_x = shell.smooth_pixel_x ??
						shell.pillbox_orbit_pixel_x ?? shell.pixel_x;
					let target_pixel_y = shell.smooth_pixel_y ??
						shell.pillbox_orbit_pixel_y ?? shell.pixel_y;
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
				} else if (shell.smooth_pixel_x !== undefined) {
					/* A slid tank head: re-derive the span from the muzzle to
					 * the drawn position, mirroring the pillbox branch, so the
					 * handoff stays seamless. */
					let delta_x = shell.smooth_pixel_x - pixel_x;
					let delta_y = shell.smooth_pixel_y - pixel_y;
					let distance = Math.hypot(delta_x, delta_y);
					start_time = snapshot.time - distance /
						SHELL_SPEED_PIXELS_PER_TICK;
					if (distance > 0) {
						heading_x = delta_x / distance;
						heading_y = delta_y / distance;
					}
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

/* The mirror of the birth segments, at the other end of a shell's life. A
 * shell fall keeps its physics arrival even when that is later than the
 * record reporting it (the sender's restatement clock was lying), but the
 * renderer draws packet-state shells only, and the fall record drops the
 * shell from state — so without help the sprite would vanish mid-flight,
 * short of its own splash. Each segment is the tail of the drawn link,
 * from the moment state loses the shell to the retimed splash, replaying
 * exactly the lerp `shell_position_at` was drawing so the handoff is
 * seamless. */
function build_shell_fall_segments(shell_positions) {
	return shell_positions.map(snapshots => {
		let segments = [];
		for (let index = 0; index + 1 < snapshots.length; index++) {
			let snapshot = snapshots[index];
			let drop_time = snapshots[index + 1].time;
			for (let shell of snapshot.shells) {
				if (!shell.next_terminal ||
					shell.next_terminal_event_type !== "shell_falls" ||
					!(shell.next_time > drop_time)) continue;
				segments.push({
					start_time: drop_time,
					end_time: shell.next_time,
					link_time: snapshot.time,
					from_x: shell.smooth_pixel_x ?? shell.pillbox_orbit_pixel_x ??
						shell.tank_exact_pixel_x ?? shell.pixel_x,
					from_y: shell.smooth_pixel_y ?? shell.pillbox_orbit_pixel_y ??
						shell.tank_exact_pixel_y ?? shell.pixel_y,
					to_x: shell.smooth_next_pixel_x ?? shell.next_pixel_x,
					to_y: shell.smooth_next_pixel_y ?? shell.next_pixel_y,
					direction: shell.direction,
				});
			}
		}
		segments.sort((a, b) => a.end_time - b.end_time);
		return segments;
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
	/* Identity verified on the packet coordinates above; drawing itself
	 * prefers the jitter-smoothed position (smooth_track_positions). */
	pixel_x = current.smooth_pixel_x ?? pixel_x;
	pixel_y = current.smooth_pixel_y ?? pixel_y;

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
		pixel_x += ((next.smooth_pixel_x ?? next.pixel_x) - pixel_x) * amount;
		pixel_y += ((next.smooth_pixel_y ?? next.pixel_y) - pixel_y) * amount;
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
	let latest_end = tick + MAX_SHELL_BIRTH_SPAN_TICKS;
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

function shell_fall_positions_at(game, player, tick) {
	let segments = game.shell_fall_segments && game.shell_fall_segments[player];
	if (!segments || !segments.length) return [];
	let lo = 0, hi = segments.length;
	while (lo < hi) {
		let mid = (lo + hi) >> 1;
		if (segments[mid].end_time <= tick) lo = mid + 1;
		else hi = mid;
	}
	/* Sorted by end_time; a segment's span is bounded by the lead
	 * allowance, so anything starting at or before `tick` ends soon. */
	let latest_end = tick + MAX_POSITION_INTERPOLATION_TICKS * 2;
	let positions = [];
	for (let i = lo; i < segments.length &&
		segments[i].end_time <= latest_end; i++) {
		let segment = segments[i];
		if (segment.start_time > tick) continue;
		let amount = (tick - segment.link_time) /
			(segment.end_time - segment.link_time);
		positions.push({
			x: (segment.from_x + (segment.to_x - segment.from_x) * amount) /
				16 + 0.5,
			y: (segment.from_y + (segment.to_y - segment.from_y) * amount) /
				16 + 0.5,
			direction: segment.direction,
		});
	}
	return positions;
}

const BoloMotion = {
	TICKS_PER_SECOND, MAX_POSITION_INTERPOLATION_TICKS,
	MAX_SHELL_INTERPOLATION_TICKS, MAX_DIRECTION_INTERPOLATION_TICKS,
	append_shell_list, add_shell_point_terminal, add_shell_box_terminal,
	build_tank_positions, build_tank_directions, build_lgm_positions, track_pixel_at,
	smooth_track_positions,
	build_shell_positions, build_shell_births, build_shell_fall_segments,
	tank_position_at, tank_direction_at, lgm_position_at, shell_position_at,
	shell_birth_positions_at, shell_fall_positions_at,
	describe_unmatched_terminals, describe_unfated_ends, score_pill_links,
	set_roster_vote_recording, reset_flow_component_stats,
	flow_component_stats: () => flow_component_stats,
};

if (typeof module !== "undefined" && module.exports) {
	module.exports = BoloMotion;
} else {
	window.BoloMotion = BoloMotion;
}

})();
