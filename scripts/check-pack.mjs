#!/usr/bin/env node
// Assert the published payload of every workspace package.
//
// `npm pack --dry-run` reports the exact file list npm would upload, which is the
// only place a `files` list can be checked for the failure it cannot express: a file
// the package needs at runtime that the list omits — an extension entry, a module the
// entry imports — ships absent while the package still installs cleanly. The expected
// lists below are the contract; a diff means the payload changed on purpose or an
// omission crept in.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** Every published package: name -> the exact files npm must upload. */
const EXPECTED_FILES = {
	"@tinoy/pi-ext-lib": [
		"CONTRACT.md",
		"LICENSE",
		"README.md",
		"package.json",
		"src/hook-log.ts",
		"src/index.ts",
		"src/neighbour.ts",
		"src/system-prompt.ts",
		"src/tool-header.ts",
	],
	"@tinoy/pi-canon": ["LICENSE", "README.md", "canon.ts", "package.json"],
	"@tinoy/pi-focus-state": ["LICENSE", "README.md", "focus-state.ts", "package.json"],
	"@tinoy/pi-tariff": ["LICENSE", "README.md", "package.json", "tariff.ts"],
	"@tinoy/pi-cache-prefix-log": ["LICENSE", "README.md", "cache-prefix-log.ts", "package.json"],
	"@tinoy/pi-child-prompt-freeze": [
		"LICENSE",
		"README.md",
		"child-prompt-freeze.ts",
		"package.json",
	],
	"@tinoy/pi-child-request-dump": ["LICENSE", "README.md", "child-request-dump.ts", "package.json"],
	"@tinoy/pi-desktop-notify": ["LICENSE", "README.md", "desktop-notify.ts", "package.json"],
	"@tinoy/pi-intercom-broadcast": ["LICENSE", "README.md", "intercom-broadcast.ts", "package.json"],
	"@tinoy/pi-no-subagent-fork": ["LICENSE", "README.md", "no-subagent-fork.ts", "package.json"],
	"@tinoy/pi-orphan-repair": ["LICENSE", "README.md", "orphan-repair.ts", "package.json"],
	"@tinoy/pi-pause": ["LICENSE", "README.md", "package.json", "pause-state.ts", "pause.ts"],
	"@tinoy/pi-probe": ["LICENSE", "README.md", "package.json", "probe.ts"],
	"@tinoy/pi-read-staleness": ["LICENSE", "README.md", "package.json", "read-staleness.ts"],
	"@tinoy/pi-focus-gate": ["LICENSE", "README.md", "focus-gate.ts", "package.json"],
	"@tinoy/pi-drift-anchor": ["LICENSE", "README.md", "drift-anchor.ts", "package.json"],
	"@tinoy/pi-deepseek-cost": ["LICENSE", "README.md", "deepseek-cost.ts", "package.json"],
	"@tinoy/pi-cli-keys": ["LICENSE", "README.md", "cli-keys.ts", "package.json"],
	"@tinoy/pi-sudo-approve": ["LICENSE", "README.md", "package.json", "sudo-approve.ts"],
	"@tinoy/pi-fleet": [
		"LICENSE",
		"README.md",
		"fleet/adopt.ts",
		"fleet/board.ts",
		"fleet/index.ts",
		"fleet/items.ts",
		"fleet/launch.ts",
		"fleet/mode.ts",
		"fleet/predicates.ts",
		"fleet/release.ts",
		"fleet/retire.ts",
		"fleet/roster.ts",
		"fleet/section.ts",
		"fleet/status.ts",
		"io-guard/claims.ts",
		"io-guard/identity.ts",
		"io-guard/index.ts",
		"io-guard/locks.ts",
		"io-guard/pend.ts",
		"io-guard/predicates.ts",
		"io-guard/reap.ts",
		"io-guard/versions.ts",
		"package.json",
	],
	"@tinoy/pi-build": ["LICENSE", "README.md", "build.ts", "package.json"],
	"@tinoy/pi-command-guard": ["LICENSE", "README.md", "command-guard.ts", "package.json"],
	"@tinoy/pi-image-read": ["LICENSE", "README.md", "image-read.ts", "package.json"],
	"@tinoy/pi-nf": ["LICENSE", "README.md", "data/nf.json", "nf.ts", "package.json"],
	"@tinoy/pi-status-metrics": ["LICENSE", "README.md", "package.json", "status-metrics.ts"],
	"@tinoy/pi-todo-parent": ["LICENSE", "README.md", "package.json", "todo-parent.ts"],
};

/** Manifest fields a published package must carry. */
const REQUIRED_FIELDS = ["name", "version", "description", "license", "repository", "files"];

function packInfo(dir) {
	const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
	const parsed = JSON.parse(out);
	const info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
	if (!info?.files) throw new Error(`no file list from ${dir}`);
	return info;
}

const failures = [];
const packages = readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => path.join("packages", entry.name));

for (const rel of packages) {
	const dir = path.join(ROOT, rel);
	const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
	const expected = EXPECTED_FILES[pkg.name];
	if (!expected) {
		failures.push(
			`${rel}: ${pkg.name} has no expected file list — add one to scripts/check-pack.mjs`,
		);
		continue;
	}

	const info = packInfo(dir);
	const packed = info.files.map((file) => file.path).sort();
	const wanted = [...expected].sort();

	const missing = wanted.filter((file) => !packed.includes(file));
	const extra = packed.filter((file) => !wanted.includes(file));
	for (const field of REQUIRED_FIELDS) {
		if (!pkg[field]) failures.push(`${pkg.name}: package.json has no ${field}`);
	}
	for (const entry of pkg.pi?.extensions ?? []) {
		const file = entry.replace(/^\.\//, "");
		if (!packed.includes(file))
			failures.push(`${pkg.name}: pi.extensions names ${entry}, which the tarball omits`);
	}

	if (missing.length || extra.length) {
		failures.push(
			`${pkg.name}: pack contents differ (missing: ${missing.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`,
		);
	}

	console.log(`${pkg.name}@${pkg.version}: ${packed.length} files, ${info.size} B packed`);
	for (const file of packed) console.log(`  ${file}`);
}

if (failures.length > 0) {
	console.error(`\npack check failed:\n  ${failures.join("\n  ")}`);
	process.exit(1);
}
console.log(`\npack check passed: ${packages.length} package(s)`);
