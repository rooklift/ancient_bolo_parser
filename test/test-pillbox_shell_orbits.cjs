// Regression test for the programmatically generated pillbox shell orbits.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const PillboxShellOrbits = require("../viewer/pillbox_shell_orbits.js");

const expected_path = path.join(__dirname, "..", "docs",
	"pillbox-shell-orbits-compact.json");
const expected = JSON.parse(fs.readFileSync(expected_path, "utf8"));

assert.deepStrictEqual(PillboxShellOrbits.orbits, expected);
assert.deepStrictEqual(PillboxShellOrbits.create_pillbox_shell_orbits(), expected);
console.log("ok   generated pillbox shell orbits match the JSON reference");
