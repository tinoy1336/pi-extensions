/**
 * pause-state.probe — the executable probe for the pause clock.
 *
 * Run: `node --experimental-strip-types pause-state.probe.ts` from `packages/pause`.
 *
 * The expiry arithmetic decides whether a session is parked, and it is the one
 * thing every parked handler consults, so a silent change either parks a session
 * that should be working or releases one that should be waiting. The probe drives
 * the real functions against a scratch state file: `PI_PAUSE_STATE` and
 * `XDG_RUNTIME_DIR` are pointed at a temporary directory first, so the machine's
 * own pause state is never read, never written and never disturbed.
 *
 * Cases: the duration parser (bare number, suffixed unit, compound segments, the
 * refusals), the deadline reader, the active decision including the two edges a
 * corrupt record produces, the label formats, and the state file's round trip —
 * set, replace, clear, and the revision counter a rewrite is meant to advance.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearPause,
	formatDuration,
	isPauseActive,
	NOT_PAUSED,
	type PauseState,
	parseDurationMs,
	pauseDeadlineMs,
	pauseRemainingLabel,
	pauseStatePath,
	readPauseState,
	setPause,
} from "./pause-state.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-pause-probe-"));
const statePath = join(scratch, "pi-pause.json");
process.env.PI_PAUSE_STATE = statePath;
process.env.XDG_RUNTIME_DIR = scratch;

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

const MINUTE = 60_000;
const HOUR = 3_600_000;

console.log("parseDurationMs");
check(
	"a bare number is minutes",
	parseDurationMs("30") === 30 * MINUTE,
	String(parseDurationMs("30")),
);
check(
	"a bare decimal is minutes",
	parseDurationMs("1.5") === 90_000,
	String(parseDurationMs("1.5")),
);
check(
	"a suffixed number names its unit",
	parseDurationMs("90s") === 90_000,
	String(parseDurationMs("90s")),
);
check("minutes", parseDurationMs("5m") === 5 * MINUTE);
check("hours", parseDurationMs("2h") === 2 * HOUR);
check(
	"segments compound",
	parseDurationMs("1h30m") === 90 * MINUTE,
	String(parseDurationMs("1h30m")),
);
check(
	"a trailing bare segment after a unit is minutes",
	parseDurationMs("1h30") === 90 * MINUTE,
	String(parseDurationMs("1h30")),
);
check(
	"spacing and case are removed",
	parseDurationMs(" 2 H ") === 2 * HOUR,
	String(parseDurationMs(" 2 H ")),
);
check("an inner space is removed", parseDurationMs("1h 30m") === 90 * MINUTE);
check("zero is a duration", parseDurationMs("0") === 0);
check("an empty argument is refused", parseDurationMs("") === null);
check("no digits is refused", parseDurationMs("soon") === null);
check("an unknown unit is refused", parseDurationMs("5x") === null);
check("a negative duration is refused", parseDurationMs("-5") === null);
check("a bad trailing segment is refused", parseDurationMs("1h2x") === null);

console.log("pauseDeadlineMs");
const stamp = new Date(Date.now() + HOUR).toISOString();
check(
	"an ISO deadline is parsed",
	pauseDeadlineMs({ ...NOT_PAUSED, paused: true, until: stamp }) === Date.parse(stamp),
);
check(
	"no deadline is null",
	pauseDeadlineMs({ ...NOT_PAUSED, paused: true, until: null }) === null,
);
check(
	"an unparseable deadline is null",
	pauseDeadlineMs({ ...NOT_PAUSED, paused: true, until: "later" }) === null,
);

console.log("isPauseActive");
check("a session with no pause is not parked", isPauseActive(NOT_PAUSED) === false);
check(
	"a pause with no deadline never expires",
	isPauseActive({ ...NOT_PAUSED, paused: true, until: null }) === true,
);
check(
	"a pause before its deadline is active",
	isPauseActive({
		...NOT_PAUSED,
		paused: true,
		until: new Date(Date.now() + HOUR).toISOString(),
	}) === true,
);
check(
	"a pause past its deadline is not active",
	isPauseActive({
		...NOT_PAUSED,
		paused: true,
		until: new Date(Date.now() - HOUR).toISOString(),
	}) === false,
);
check(
	"a corrupt deadline reads as an indefinite pause, the fail-safe direction",
	isPauseActive({ ...NOT_PAUSED, paused: true, until: "later" }) === true,
);

console.log("formatDuration and the label");
check("under a minute is seconds", formatDuration(45_000) === "45s", formatDuration(45_000));
check(
	"a minute and a half rounds to minutes",
	formatDuration(90_000) === "2m",
	formatDuration(90_000),
);
check("a whole hour has no minutes part", formatDuration(HOUR) === "1h", formatDuration(HOUR));
check(
	"an hour and a half carries both",
	formatDuration(90 * MINUTE) === "1h30m",
	formatDuration(90 * MINUTE),
);
check("zero is zero seconds", formatDuration(0) === "0s", formatDuration(0));
check(
	"no deadline reads as no deadline",
	pauseRemainingLabel({ ...NOT_PAUSED, paused: true, until: null }) === "no deadline",
);
check(
	"the label is the time remaining at the given clock",
	pauseRemainingLabel(
		{ ...NOT_PAUSED, paused: true, until: new Date(1_000_000 + 90_000).toISOString() },
		1_000_000,
	) === "2m",
	pauseRemainingLabel(
		{ ...NOT_PAUSED, paused: true, until: new Date(1_000_000 + 90_000).toISOString() },
		1_000_000,
	),
);
check(
	"an expired deadline reads as zero rather than negative",
	pauseRemainingLabel(
		{ ...NOT_PAUSED, paused: true, until: new Date(1_000_000).toISOString() },
		1_000_000 + 5 * HOUR,
	) === "0s",
);

console.log("the state file");
check("the override names the file", pauseStatePath() === statePath, pauseStatePath());
check("a session with no file reads as not paused", readPauseState().paused === false);

const indefinite: PauseState = setPause(null, "probe");
check(
	"setting an indefinite pause reports it",
	indefinite.paused === true && indefinite.until === null,
);
check("and it is active", isPauseActive(readPauseState()) === true);
check("the reader sees who set it", readPauseState().by === "probe", String(readPauseState().by));

const deadline = Date.now() + HOUR;
const timed = setPause(deadline, "probe");
check(
	"a timed pause records its deadline",
	readPauseState().paused === true && readPauseState().until === new Date(deadline).toISOString(),
);
check(
	"the revision advances on a rewrite",
	timed.rev === indefinite.rev + 1,
	`${indefinite.rev} then ${timed.rev}`,
);

clearPause("probe");
check("clearing releases the pause", readPauseState().paused === false);
check("and the state reads as not paused", isPauseActive(readPauseState()) === false);

const saved = process.env.PI_PAUSE_STATE;
delete process.env.PI_PAUSE_STATE;
check(
	"without the override the runtime directory holds the file",
	pauseStatePath() === join(scratch, "pi-pause.json"),
	pauseStatePath(),
);
if (saved !== undefined) process.env.PI_PAUSE_STATE = saved;

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`pause-state probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`pause-state probe passed: ${checks} checks`);
