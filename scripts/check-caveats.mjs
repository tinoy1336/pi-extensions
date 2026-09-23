#!/usr/bin/env node
// Assert the caveat declarations of every workspace package.
//
// A caveat is a neighbour that makes a package better without being required. It is
// documentation, never enforcement: no dependency, no runtime check, no thrown error. The
// failure this checker exists for is a caveat documented in one carrier only — a README
// row with no manifest entry once the manifest form lands, or a neighbour that no package
// in this workspace ships (a reader's install line that cannot work).
//
// SETTLED (enforced now): the `## Works better with` section, its single table, the four
// fixed columns, one backticked neighbour per row, non-empty gain and loss cells, an
// install cell that is a `pi install npm:` command or the literal `not a package`, and
// every `@tinoy/pi-*` neighbour resolving to a package in this workspace.
//
// M10-GATED (reported, not required): the machine-readable mirror inside the `pi` object
// may be declared only once an unknown key inside `pi` is known to be ignored by pi's
// loader rather than rejected (matrix case M10). When a package declares it, this checker
// compares it against the README rows; when none does, it says so and passes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PACKAGES = path.join(ROOT, "packages");
const HEADING = "## Works better with";
const DOC_COLUMNS = ["neighbour", "you gain", "you lose without it", "install"];
const NOT_A_PACKAGE = "not a package";

const failures = [];
const notes = [];

function fail(message) {
	failures.push(message);
}

/** The table rows directly under `## Works better with`, or null when the section is absent. */
function readCaveatTable(readme, where) {
	const lines = readme.split("\n");
	const heading = lines.findIndex((line) => line.trim() === HEADING);
	if (heading === -1) return null;

	const table = [];
	for (let i = heading + 1; i < lines.length; i += 1) {
		const line = lines[i].trim();
		if (line === "") continue;
		if (!line.startsWith("|")) break;
		table.push(line);
	}
	if (table.length < 3) {
		fail(
			`${where}: the section holds no table (a header row, a separator and one row per caveat are required)`,
		);
		return [];
	}

	const cells = (line) =>
		line
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((cell) => cell.trim());

	const header = cells(table[0]).map((cell) => cell.toLowerCase());
	if (
		header.length !== DOC_COLUMNS.length ||
		header.some((cell, index) => cell !== DOC_COLUMNS[index])
	) {
		fail(
			`${where}: the table columns are "${header.join(" | ")}", expected "${DOC_COLUMNS.join(" | ")}" in that order`,
		);
		return [];
	}
	if (!/^\|[\s:-]+\|/.test(table[1].replace(/ /g, ""))) {
		fail(`${where}: the second table line is not the markdown separator`);
	}

	const rows = [];
	for (const line of table.slice(2)) {
		const row = cells(line);
		if (row.length !== DOC_COLUMNS.length) {
			fail(`${where}: a row has ${row.length} cells, expected ${DOC_COLUMNS.length} — "${line}"`);
			continue;
		}
		const [neighbour, gain, loss, install] = row;
		const named = [...neighbour.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
		if (named.length !== 1) {
			fail(
				`${where}: the neighbour cell must name exactly one package in backticks — "${neighbour}"`,
			);
			continue;
		}
		if (gain === "" || loss === "") {
			fail(`${where}: ${named[0]} has an empty gain or loss cell — the row must say what changes`);
		}
		if (!/^`?pi install npm:/.test(install) && install !== NOT_A_PACKAGE) {
			fail(
				`${where}: ${named[0]} has install cell "${install}", expected a pi install command or "${NOT_A_PACKAGE}"`,
			);
		}
		rows.push({ neighbour: named[0], gain, loss, install });
	}
	return rows;
}

const directories = readdirSync(PACKAGES, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name);

if (directories.length === 0) fail(`no packages found under ${PACKAGES}`);

const packageNames = new Set();
const manifests = new Map();
for (const name of directories) {
	const manifestPath = path.join(PACKAGES, name, "package.json");
	if (!existsSync(manifestPath)) {
		fail(`${name}: no package.json`);
		continue;
	}
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (!manifest.name) fail(`${name}: package.json has no name`);
	packageNames.add(manifest.name);
	manifests.set(name, manifest);
}

let declared = 0;
let gated = 0;
for (const name of directories) {
	const manifest = manifests.get(name);
	if (!manifest) continue;
	const readmePath = path.join(PACKAGES, name, "README.md");
	if (!existsSync(readmePath)) {
		fail(`${manifest.name}: no README.md — the caveat carrier is missing`);
		continue;
	}
	const rows = readCaveatTable(readFileSync(readmePath, "utf8"), manifest.name);
	if (rows === null) {
		console.log(`${manifest.name}: no caveats declared`);
		continue;
	}
	declared += rows.length;
	for (const row of rows) {
		if (row.neighbour.startsWith("@tinoy/pi-") && !packageNames.has(row.neighbour)) {
			fail(
				`${manifest.name}: caveat names ${row.neighbour}, which no package in this workspace provides`,
			);
		}
	}
	console.log(`${manifest.name}: ${rows.length} caveat row(s)`);

	const mirrored = manifest.pi?.caveats;
	if (mirrored === undefined) continue;
	gated += 1;
	if (!Array.isArray(mirrored)) {
		fail(`${manifest.name}: pi.caveats is not an array`);
		continue;
	}
	const readmeNeighbours = [...rows.map((row) => row.neighbour)].sort();
	const manifestNeighbours = mirrored
		.map((entry) => entry?.neighbour)
		.filter((entry) => typeof entry === "string")
		.sort();
	if (mirrored.length !== manifestNeighbours.length) {
		fail(`${manifest.name}: a pi.caveats entry has no neighbour name`);
	}
	if (readmeNeighbours.join("|") !== manifestNeighbours.join("|")) {
		fail(
			`${manifest.name}: pi.caveats names [${manifestNeighbours.join(", ")}] while the README rows name [${readmeNeighbours.join(", ")}]`,
		);
	}
	for (const entry of mirrored) {
		if (typeof entry?.gains !== "string" || entry.gains.trim() === "") {
			fail(`${manifest.name}: the pi.caveats entry for ${entry?.neighbour} has no gains text`);
		}
	}
	notes.push(
		`${manifest.name}: the machine-readable mirror is compared (its presence is gated on the loader ignoring an unknown pi key)`,
	);
}

console.log("");
for (const note of notes) console.log(`note: ${note}`);
if (gated === 0) {
	console.log(
		"note: no package declares the machine-readable mirror; that half is gated on the loader accepting an unknown key inside the pi object",
	);
}
if (failures.length > 0) {
	console.error(`caveat check failed:\n  ${failures.join("\n  ")}`);
	process.exit(1);
}
console.log(
	`caveat check passed: ${directories.length} package(s), ${declared} caveat row(s) declared`,
);
