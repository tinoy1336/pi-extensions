/**
 * index.probe — the executable probe for the bounded status probe's own bounding.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/probe`.
 *
 * This tool exists to keep raw output out of the conversation, so its contract is not
 * what it fetches but how much of it comes back: the target kind decides which command
 * runs, the `lines` parameter is clamped to the documented 1..40, and both process and
 * journal output are capped with a marker that says how much was dropped. A silent
 * change to the clamp or the cap either floods a context or hides the line that
 * mattered, and no workspace gate reads either.
 *
 * The commands are the real ones (`pgrep`, `systemctl`, `journalctl`), which are
 * read-only and present wherever this runs; a unit name that does not exist is used so
 * nothing depends on this machine's services. The hyprctl branch is deliberately NOT
 * exercised: it needs a running compositor, so the command is named in the runner
 * header as the one part of this package that cannot be checked here.
 *
 * Cases: the kind the target selects, the line clamp at its floor, its ceiling and a
 * value inside it, the empty-match wording, and the process cap against the same
 * command's raw output.
 */
import { spawnSync } from "node:child_process";

type Tool = {
	name: string;
	execute: (
		id: string,
		params: { target: string; lines?: number; hyprctl?: boolean },
	) => Promise<{ content: Array<{ text: string }> }>;
};

let tool: Tool | undefined;
const api = {
	on: () => {},
	registerTool: (registered: unknown) => {
		tool = registered as Tool;
	},
	registerCommand: () => {},
};
const { default: probe } = await import("./index.ts");
probe(api as never);
if (!tool) throw new Error("the extension registered no probe tool");
const probeTool: Tool = tool;

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

async function run(target: string, lines?: number): Promise<string> {
	const result = await probeTool.execute(
		"probe",
		lines === undefined ? { target } : { target, lines },
	);
	return result.content.map((part) => part.text).join("\n");
}

/** The same command the tool runs for a process target, so the cap can be compared. */
function rawProcessLines(pattern: string): string[] {
	const result = spawnSync("pgrep", ["-af", pattern], { encoding: "utf8" });
	return `${result.stdout ?? ""}`.trim() === "" ? [] : `${result.stdout}`.trim().split("\n");
}

console.log("the kind the target selects");
const processOut = await run("probe-no-such-process-xyz");
check(
	"a plain target is a process query",
	processOut.startsWith("pgrep -af probe-no-such-process-xyz (exit "),
	processOut.split("\n")[0] ?? "",
);
check(
	"and a target matching nothing stays one bounded line",
	processOut.split("\n").length === 2,
	`${processOut.split("\n").length - 1} body line(s)`,
);

const unit = await run("probe-no-such-unit.service");
check(
	"a unit target is a unit query",
	unit.startsWith("probe-no-such-unit.service: "),
	unit.split("\n")[0] ?? "",
);
check("with a process count", unit.includes("processes: "), unit.split("\n")[1] ?? "");
check("and a journal tail", unit.includes("last 10 journal lines:"), unit.split("\n")[2] ?? "");

console.log("the line clamp");
check("the default is ten", unit.includes("last 10 journal lines:"));
check(
	"a value inside the range is honoured",
	(await run("probe-no-such-unit.service", 5)).includes("last 5 journal lines:"),
);
check(
	"the ceiling is forty",
	(await run("probe-no-such-unit.service", 999)).includes("last 40 journal lines:"),
);
check(
	"the floor is one",
	(await run("probe-no-such-unit.service", 0)).includes("last 1 journal lines:"),
);
check(
	"and a negative value clamps to the floor too",
	(await run("probe-no-such-unit.service", -3)).includes("last 1 journal lines:"),
);

console.log("the process cap");
const raw = rawProcessLines(".");
const capped = await run(".");
const body = capped.split("\n").slice(1);
const marker = body.find((line) => line.startsWith("… (+"));
check(
	"the body never exceeds the cap",
	body.filter((line) => !line.startsWith("… (+")).length <= 20,
	`${body.length} lines`,
);
if (raw.length > 22) {
	check("a long list is marked as truncated", marker !== undefined, marker ?? "(no marker)");
	check(
		"and the marker counts what was dropped",
		marker === `… (+${raw.length - 20} lines)`,
		`${marker ?? "(none)"} for ${raw.length} raw lines`,
	);
} else {
	console.log(
		`  note  the machine lists only ${raw.length} processes; the truncation marker was not reachable`,
	);
}

console.log("");
if (failures > 0) {
	console.error(`probe probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`probe probe passed: ${checks} checks`);
