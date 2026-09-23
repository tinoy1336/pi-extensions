/**
 * neighbour.probe — the executable probe for `optionalNeighbour`.
 *
 * Run: `node --experimental-strip-types src/neighbour.probe.ts` from `packages/ext-lib`.
 *
 * It runs in its own process and points HOME at a scratch directory BEFORE the
 * diagnostics module is evaluated, so the probe's own `neighbour-absent` lines
 * land in the scratch log and the real `~/.local/share/pi-hooks/log.jsonl` is
 * never written. Each case uses its own neighbour name, which is also what makes
 * the three cases testable in one process: the cache is keyed by
 * `(source, neighbour)`, so no test-only reset API is needed.
 *
 * Cases: present (module returned, no line), absent (a real unresolved module
 * specifier: null, exactly one line, resolution attempted once), throwing (a
 * synchronous throw inside `load`: null, one line, nothing escapes).
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pi-ext-lib-neighbour-probe-"));
process.env.HOME = home;
process.env.XDG_STATE_HOME = join(home, "state");
process.env.XDG_RUNTIME_DIR = join(home, "run");

/** Held in a variable so the specifier stays unresolvable at build time and fails for real
 *  at run time: a literal import here would be a compile error instead of the case under
 *  test. */
const ABSENT_SPECIFIER = "pi-nonexistent-neighbour-fixture";

const { HOOK_LOG_PATH } = await import("./hook-log.ts");
const { optionalNeighbour } = await import("./neighbour.ts");

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

function logLines(): Record<string, unknown>[] {
	if (!existsSync(HOOK_LOG_PATH)) return [];
	return readFileSync(HOOK_LOG_PATH, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function absentLines(neighbour: string): Record<string, unknown>[] {
	return logLines().filter(
		(line) =>
			line.kind === "neighbour-absent" &&
			(line.detail as { neighbour?: string })?.neighbour === neighbour,
	);
}

// ---- present neighbour ----------------------------------------------------------

const present = await optionalNeighbour(
	"probe-present-fixture",
	() => Promise.resolve({ marker: "loaded" }),
	{
		source: "probe",
		effect: "nothing: this neighbour is present",
	},
);
check(
	"present neighbour resolves to the module",
	(present as { marker?: string } | null)?.marker === "loaded",
);
check("present neighbour logs no line", logLines().length === 0, `${logLines().length} line(s)`);

// ---- absent neighbour (a real unresolved import) ---------------------------------

let absentAttempts = 0;
const absent = await optionalNeighbour(
	"probe-absent-fixture",
	async () => {
		absentAttempts += 1;
		return await import(ABSENT_SPECIFIER);
	},
	{
		source: "probe",
		effect: "the fixture capability is unavailable",
		hint: "pi install npm:pi-nonexistent-neighbour-fixture",
	},
);
check("absent neighbour answers null", absent === null);
const absentAgain = await optionalNeighbour(
	"probe-absent-fixture",
	async () => {
		absentAttempts += 1;
		return await import(ABSENT_SPECIFIER);
	},
	{
		source: "probe",
		effect: "the fixture capability is unavailable",
		hint: "pi install npm:pi-nonexistent-neighbour-fixture",
	},
);
check(
	"absent neighbour is cached (a second call reuses the resolution)",
	absentAgain === null && absentAttempts === 1,
	`load() called ${absentAttempts}×`,
);
const absentLogged = absentLines("probe-absent-fixture");
check(
	"absent neighbour logs exactly one line",
	absentLogged.length === 1,
	`${absentLogged.length} line(s)`,
);
const absentLine = absentLogged[0];
check(
	"the line carries source, effect and hint",
	absentLine?.source === "probe" && absentLine?.detail !== undefined,
	JSON.stringify(absentLine?.detail ?? null),
);
const absentDetail = (absentLine?.detail ?? {}) as Record<string, unknown>;
check(
	"the line names the neighbour, the effect and the install hint",
	absentDetail.neighbour === "probe-absent-fixture" &&
		absentDetail.effect === "the fixture capability is unavailable" &&
		absentDetail.hint === "pi install npm:pi-nonexistent-neighbour-fixture",
	JSON.stringify(absentDetail),
);
check(
	"the line carries the loader's reason",
	typeof absentDetail.reason === "string" && absentDetail.reason.length > 0,
	String(absentDetail.reason ?? ""),
);
check(
	"the line keeps the shared envelope fields",
	typeof absentLine?.ts === "string" && typeof absentLine?.proc === "number",
	`ts=${String(absentLine?.ts ?? "")} proc=${String(absentLine?.proc ?? "")}`,
);

// ---- throwing neighbour --------------------------------------------------------

let throwAttempts = 0;
const thrown = await optionalNeighbour(
	"probe-throwing-fixture",
	() => {
		throwAttempts += 1;
		throw new Error("synchronous refusal from the fixture");
	},
	{ source: "probe", effect: "the throwing fixture capability is unavailable" },
);
check("a synchronous throw inside load answers null", thrown === null);
check("a synchronous throw is cached too", throwAttempts === 1, `load() called ${throwAttempts}×`);
const thrownLogged = absentLines("probe-throwing-fixture");
check(
	"a synchronous throw logs exactly one line",
	thrownLogged.length === 1,
	`${thrownLogged.length} line(s)`,
);
const thrownDetail = (thrownLogged[0]?.detail ?? {}) as Record<string, unknown>;
check("a hint is omitted when the call site gives none", thrownDetail.hint === undefined);
check(
	"the thrown reason is recorded",
	thrownDetail.reason === "synchronous refusal from the fixture",
	String(thrownDetail.reason ?? ""),
);

// ---- session hygiene ------------------------------------------------------------

check(
	"the probe wrote only its scratch log",
	HOOK_LOG_PATH.startsWith(home),
	`${HOOK_LOG_PATH} under HOME=${home}`,
);

console.log("");
if (failures > 0) {
	console.error(`neighbour probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`neighbour probe passed: ${checks} checks`);
