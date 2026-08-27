/* Build the committed, human-diffable account of every interpolation choice
 * made for the sample replay. The report deliberately describes the resolved
 * tracks, rather than implementation steps, so refactors may change how a
 * choice is reached without changing the expected result.
 *
 * Regenerate after an intentional interpolation change with:
 *
 *   npm run build:interpolation-report
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const BoloGame = require("../viewer/game.js");
const BoloLog = require("../viewer/logparse.js");

const root = path.join(__dirname, "..");
const default_source = path.join(root, "fixtures", "n20021018.2");
const default_output = path.join(root, "test", "expected",
	"n20021018.2-interpolation.tsv");

function report_cell(value) {
	if (value === undefined || value === null) return "-";
	if (value === true) return "1";
	if (value === false) return "0";
	if (typeof value === "number" && Object.is(value, -0)) return "-0";
	return String(value)
		.replace(/\\/g, "\\\\")
		.replace(/\t/g, "\\t")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n");
}

function add_line(lines, ...cells) {
	lines.push(cells.map(report_cell).join("\t"));
}

function build_interpolation_report(game, metadata = {}) {
	let lines = [
		"# GENERATED FILE - do not edit. Regenerate with npm run build:interpolation-report",
		"# Resolved interpolation choices for the anonymized sample replay.",
		"format\t2",
	];
	add_line(lines, "source", metadata.source || "fixtures/n20021018.2");
	add_line(lines, "source_sha256", metadata.source_sha256);
	add_line(lines, "maximum_position_interpolation_ticks",
		BoloGame.MAX_POSITION_INTERPOLATION_TICKS);

	lines.push("# tank_point\tplayer\tpoint\ttime\tpixel_x\tpixel_y\tinterpolate_from_previous");
	for (let player = 0; player < game.tank_positions.length; player++) {
		let track = game.tank_positions[player];
		for (let point = 0; point < track.length; point++) {
			let position = track[point];
			add_line(lines, "tank_point", player, point, position.time,
				position.pixel_x, position.pixel_y, position.continuous);
		}
	}

	lines.push("# lgm_point\tplayer\tpoint\ttime\tpixel_x\tpixel_y\tparachute\tinterpolate_from_previous\ttank_entry_time\ttank_entry_pixel_x\ttank_entry_pixel_y");
	for (let player = 0; player < game.lgm_positions.length; player++) {
		let track = game.lgm_positions[player];
		for (let point = 0; point < track.length; point++) {
			let position = track[point];
			let tank_entry = position.tank_entry;
			add_line(lines, "lgm_point", player, point, position.time,
				position.pixel_x, position.pixel_y, position.parachute,
				position.continuous, tank_entry && tank_entry.time,
				tank_entry && tank_entry.pixel_x, tank_entry && tank_entry.pixel_y);
		}
	}

	lines.push("# shell\tplayer\tsnapshot\ttime\tshell\tpixel_x\tpixel_y\tdirection\toutcome\tnext_time\tnext_pixel_x\tnext_pixel_y\tterminal_type\tterminal_event_type\tmatched_from_previous\theading_x\theading_y\torigin\tpillbox_source_x\tpillbox_source_y\tpillbox_source_distance\tbirth_time\tbirth_pixel_x\tbirth_pixel_y");
	lines.push("# terminal\tplayer\tsnapshot\ttime\tterminal\ttype\tdirection\tpixel_x\tpixel_y\tmin_x\tmin_y\tmax_x\tmax_y\tevent_type\tmatch_time\teffect_time");
	lines.push("# unseen_pill_terminal\tplayer\tsnapshot\tterminal\tpillbox_source_x\tpillbox_source_y\tdirection");
	for (let player = 0; player < game.shell_positions.length; player++) {
		let snapshots = game.shell_positions[player];
		for (let snapshot_index = 0; snapshot_index < snapshots.length;
			snapshot_index++) {
			let snapshot = snapshots[snapshot_index];
			for (let shell_index = 0; shell_index < snapshot.shells.length;
				shell_index++) {
				let shell = snapshot.shells[shell_index];
				let outcome = "unmatched";
				if (shell.next_time !== undefined) {
					outcome = shell.next_terminal ? "terminal" : "snapshot";
				}
				let origin = shell.starts_at_tank ? "tank" :
					shell.starts_at_pillbox ? "pillbox" : null;
				add_line(lines, "shell", player, snapshot_index, snapshot.time,
					shell_index, shell.pixel_x, shell.pixel_y, shell.direction,
					outcome, shell.next_time, shell.next_pixel_x, shell.next_pixel_y,
					shell.next_terminal_type, shell.next_terminal_event_type,
					shell.matched_from_previous, shell.heading_x, shell.heading_y,
					origin, shell.pillbox_source_x, shell.pillbox_source_y,
					shell.pillbox_source_distance, shell.birth_time,
					shell.birth_pixel_x, shell.birth_pixel_y);
			}
			for (let terminal_index = 0; terminal_index < snapshot.terminals.length;
				terminal_index++) {
				let terminal = snapshot.terminals[terminal_index];
				add_line(lines, "terminal", player, snapshot_index, snapshot.time,
					terminal_index, terminal.type, terminal.direction,
					terminal.pixel_x, terminal.pixel_y, terminal.min_x, terminal.min_y,
					terminal.max_x, terminal.max_y, terminal.event_type,
					terminal.match_time, terminal.effect && terminal.effect.time);
				if (terminal.unseen_pillbox_source) {
					add_line(lines, "unseen_pill_terminal", player, snapshot_index,
						terminal_index, terminal.pillbox_source_x,
						terminal.pillbox_source_y,
						terminal.pillbox_source_direction);
				}
			}
		}
	}

	lines.push("# shell_birth\tplayer\tbirth\tstart_time\tend_time\tpixel_x\tpixel_y\theading_x\theading_y\tdirection");
	for (let player = 0; player < game.shell_births.length; player++) {
		let births = game.shell_births[player];
		for (let birth_index = 0; birth_index < births.length; birth_index++) {
			let birth = births[birth_index];
			add_line(lines, "shell_birth", player, birth_index, birth.start_time,
				birth.end_time, birth.pixel_x, birth.pixel_y, birth.heading_x,
				birth.heading_y, birth.direction);
		}
	}

	return `${lines.join("\n")}\n`;
}

function sha256(bytes) {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

if (require.main === module) {
	let source = process.argv[2] ? path.resolve(process.argv[2]) : default_source;
	let output = process.argv[3] ? path.resolve(process.argv[3]) : default_output;
	let bytes = fs.readFileSync(source);
	let records = [...BoloLog.records(new Uint8Array(bytes))];
	let game = BoloGame.build(records);
	let report = build_interpolation_report(game, {
		source: path.relative(root, source).replace(/\\/g, "/"),
		source_sha256: sha256(bytes),
	});
	fs.mkdirSync(path.dirname(output), { recursive: true });
	fs.writeFileSync(output, report, "utf8");
	console.log(`wrote ${path.relative(root, output)} (${Buffer.byteLength(report)} bytes)`);
}

module.exports = { build_interpolation_report, sha256 };
