/**
 * tariff.probe — the executable probe for the price table's contract.
 *
 * Run: `node --experimental-strip-types tariff.probe.ts` from `packages/tariff`.
 *
 * It drives the REAL loader, not a copy of its rules: each case runs as a child
 * process with `PI_TARIFF_CONFIG` pointed at a scratch file and `HOME` pointed at
 * a scratch directory, both set BEFORE the module is evaluated. Two reasons for
 * the child process. The table is memoized once per process, so one process can
 * only ever load one table; and a refusal writes a diagnostics line, so the
 * probe's own HOME keeps that line out of the machine's real hook log. Nothing
 * here reads the machine's configured table.
 *
 * Cases: valid (the configured file is what prices — proven by a figure the
 * example ladder does not carry — and the example ladder is never substituted),
 * read-at-miss (a cacheHit at or above its cacheMiss is refused by name, because
 * no saving can be derived from it), unknown-key (an unknown key is refused by
 * name rather than ignored), missing (no file is a refusal carrying the shape to
 * write, never a price). Plus the pure ratio derivation, whose column and window
 * are the caller's choice.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHILD = "--child";

const scratch = mkdtempSync(join(tmpdir(), "pi-tariff-probe-"));
process.env.HOME = scratch;
process.env.XDG_STATE_HOME = join(scratch, "state");
process.env.XDG_RUNTIME_DIR = join(scratch, "run");

type Load =
	| { ok: true; table: TariffShaped; path: string }
	| { ok: false; reason: string; path: string };

/** Only the fields the probe reads; the loader's own type is not re-declared here. */
type TariffShaped = {
	usd: { valley: { cacheHit: number; cacheMiss: number; output: number } };
};

if (process.argv[2] === CHILD) {
	const { loadTariff } = await import("./tariff.ts");
	process.stdout.write(JSON.stringify(loadTariff()));
	process.exit(0);
}

function loadCase(configPath: string): Load {
	const stdout = execFileSync(
		process.execPath,
		["--experimental-strip-types", fileURLToPath(import.meta.url), CHILD],
		{
			env: {
				...process.env,
				PI_TARIFF_CONFIG: configPath,
				PI_SESSION_ID: "",
				NODE_NO_WARNINGS: "1",
			},
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	return JSON.parse(stdout) as Load;
}

const { EXAMPLE_TARIFF, WINDOWS, ratios } = await import("./tariff.ts");

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ""): void {
	checks += 1;
	if (condition) {
		console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Ratios are divisions of the table's own numbers, so they carry binary
 *  floating point: 0.7 / 7 is 0.10000000000000002, not 0.1. */
function close(value: number, expected: number): boolean {
	return Math.abs(value - expected) < 1e-9;
}

try {
	// A table whose windows and columns differ from each other, so that reading
	// the wrong one cannot pass: valley 1/10 (r = 0.1), peak 5/10 (r = 0.5),
	// cny valley 2/10 (r = 0.2).
	const valid = {
		cny: {
			valley: { cacheHit: 2, cacheMiss: 10, output: 100 },
			peak: { cacheHit: 10, cacheMiss: 20, output: 200 },
		},
		usd: {
			valley: { cacheHit: 1, cacheMiss: 10, output: 100 },
			peak: { cacheHit: 5, cacheMiss: 10, output: 100 },
		},
	};
	const validPath = join(scratch, "valid.json");
	writeFileSync(validPath, JSON.stringify(valid));

	const readAtMissPath = join(scratch, "read-at-miss.json");
	writeFileSync(
		readAtMissPath,
		JSON.stringify({
			...valid,
			usd: { ...valid.usd, valley: { cacheHit: 10, cacheMiss: 10, output: 100 } },
		}),
	);

	const unknownKeyPath = join(scratch, "unknown-key.json");
	writeFileSync(unknownKeyPath, JSON.stringify({ ...valid, peakHours: true }));

	const missingPath = join(scratch, "not-written.json");

	console.log("a configured table prices");
	const loaded = loadCase(validPath);
	check("the load succeeds", loaded.ok === true, loaded.ok ? "" : loaded.reason);
	check(
		"the configured file is the one that priced, never the example ladder",
		loaded.ok && loaded.table.usd.valley.cacheMiss === 10,
		loaded.ok ? `usd.valley.cacheMiss ${loaded.table.usd.valley.cacheMiss}` : "refused",
	);
	check("the refusal path names the file it read", loaded.path === validPath, loaded.path);

	console.log("a read at or above the miss price is refused");
	const readAtMiss = loadCase(readAtMissPath);
	check("the load refuses", readAtMiss.ok === false);
	check(
		"the reason names the pair it cannot derive a ratio from",
		!readAtMiss.ok && readAtMiss.reason.includes("is not below its cacheMiss"),
		readAtMiss.ok ? "accepted" : readAtMiss.reason.slice(0, 90),
	);

	console.log("an unknown key is refused");
	const unknownKey = loadCase(unknownKeyPath);
	check("the load refuses", unknownKey.ok === false);
	check(
		"the reason names the key",
		!unknownKey.ok && unknownKey.reason.includes("unknown key 'peakHours'"),
		unknownKey.ok ? "accepted" : unknownKey.reason.slice(0, 90),
	);

	console.log("no configured file is a refusal, never a price");
	const missing = loadCase(missingPath);
	check("the load refuses", missing.ok === false);
	check(
		"the reason says nothing is configured and carries the shape",
		!missing.ok &&
			missing.reason.includes("no tariff table is configured") &&
			missing.reason.includes("cacheHit"),
		missing.ok ? "priced" : missing.reason.slice(0, 90),
	);
	check("a refusal carries no table", !("table" in missing));

	console.log("the ratios are derived, and the caller picks the window and column");
	const example = ratios(EXAMPLE_TARIFF);
	check("r is cacheHit over cacheMiss", close(example.r, 0.1), String(example.r));
	check(
		"mult is the input-token worth of a read-priced token",
		close(example.mult, 9),
		String(example.mult),
	);
	check(
		"outputPerInput scales the context transfer",
		close(example.outputPerInput, 10),
		String(example.outputPerInput),
	);
	check("the valley window is the default", close(ratios(valid).r, 0.1), String(ratios(valid).r));
	check(
		"the peak window is read from the table",
		close(ratios(valid, "usd", "peak").r, 0.5),
		String(ratios(valid, "usd", "peak").r),
	);
	check(
		"the cny column is read from the table",
		close(ratios(valid, "cny", "valley").r, 0.2),
		String(ratios(valid, "cny", "valley").r),
	);
	check(
		"the window order validation and iteration share is fixed",
		WINDOWS.length === 2 && WINDOWS[0] === "valley" && WINDOWS[1] === "peak",
		WINDOWS.join(","),
	);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
	console.error(`tariff probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`tariff probe passed: ${checks} checks`);
