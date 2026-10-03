/**
 * index.probe — the executable probe for the bounded build runner.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/build`.
 *
 * This tool exists so a build's output never lands in the conversation, so its whole
 * value is the summary it returns: the exit code, the line count, the log path, and the
 * error lines it chose to show with the caps that bound them. A silent change to the
 * caps or to the environment it hands the child either floods a context or hides the
 * one line that mattered, and no workspace gate reads either.
 *
 * It drives the registered tool entry, which spawns a real child: every command it runs
 * is `printf`/`sh` against no target, each with a short timeout of its own, and the log
 * file the tool writes is deleted in the same run. The environment case sets a marker
 * the tool is supposed to strip, so the child itself reports whether the strip happened.
 *
 * Cases: a clean run, a failing exit code, the extraction of error lines, the cap on how
 * many are shown, the tail shown when nothing matched, the roots line for a session with
 * no crew store, and the environment the child receives.
 */
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-build-probe-"));
process.env.HOME = scratch;
process.env.TMPDIR = scratch;
// The tool strips this prefix from the child's environment; the child reports it back.
process.env.PI_SUBAGENT = "1";

const { default: build } = await import("./index.ts");

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

type Tool = {
	name: string;
	execute: (
		id: string,
		params: { command: string; cwd?: string; timeoutMs?: number },
	) => Promise<{
		content: Array<{ type: string; text: string }>;
	}>;
};

let tool: Tool | undefined;
const api = {
	on: () => {},
	registerTool: (registered: unknown) => {
		tool = registered as Tool;
	},
	registerCommand: () => {},
	getActiveTools: () => [],
	setActiveTools: () => {},
	appendEntry: () => {},
	events: { on: () => {}, emit: () => {} },
};
build(api as never);
if (!tool) throw new Error("the extension registered no tool");
const buildTool: Tool = tool;

const logs: string[] = [];
/** The per-worker isolation root the first run reported, when it reported one. */
let isolatedRoot: string | undefined;

/** Run one command through the entry and return the summary text it produced. */
async function run(command: string): Promise<{ text: string; logPath: string }> {
	const result = await buildTool.execute("probe", { command, timeoutMs: 20_000 });
	const text = result.content.map((part) => part.text).join("\n");
	const logPath = /log=(\S+)/.exec(text)?.[1] ?? "";
	if (logPath) logs.push(logPath);
	if (isolatedRoot === undefined) isolatedRoot = /roots out=(\S+)/.exec(text)?.[1];
	return { text, logPath };
}

try {
	console.log("a clean run");
	const clean = await run("printf 'hello\\n'");
	check("the exit code is reported", clean.text.includes("exit=0"), clean.text.split("\n")[0]);
	check("the line count is reported", /lines=\d+/.test(clean.text), clean.text.split("\n")[0]);
	check("the duration is reported", /duration=[\d.]+s/.test(clean.text));
	check("the log path is reported", clean.logPath !== "", clean.logPath);
	check("and the log was written", existsSync(clean.logPath), clean.logPath);
	check(
		"a crew root, when one is reported, is one this probe owns",
		isolatedRoot === undefined || isolatedRoot.startsWith(scratch),
		clean.text.split("\n")[1] ?? "",
	);
	check(
		"the roots line says which shape it is",
		(clean.text.split("\n")[1] ?? "").startsWith("roots "),
		clean.text.split("\n")[1],
	);
	check(
		"a clean run shows the tail rather than nothing",
		clean.text.includes("no error/warning lines matched") && clean.text.includes("hello"),
		clean.text.split("\n").slice(-2).join(" | "),
	);

	console.log("a failing command");
	const failing = await run("printf 'done\\n'; exit 3");
	check(
		"the non-zero exit is reported",
		failing.text.includes("exit=3"),
		failing.text.split("\n")[0],
	);

	console.log("error lines, and the cap on them");
	const few = await run('for i in 1 2 3 4 5; do echo "error $i"; done; echo fine');
	check(
		"the matched lines are counted",
		few.text.includes("5 error/warning line(s), showing 5:"),
		few.text.split("\n").slice(-6)[0],
	);
	check("and shown", few.text.includes("error 5"));
	const many = await run('for i in $(seq 1 40); do echo "error $i"; done');
	check(
		"past the cap only the cap is shown",
		many.text.includes("40 error/warning line(s), showing 30:"),
		many.text.split("\n").slice(-31)[0],
	);
	check(
		"with the remainder counted",
		many.text.includes("(+10 matched lines"),
		many.text.split("\n").slice(-1)[0],
	);

	console.log("the environment the child receives");
	const env = await run("printenv PI_SUBAGENT || echo STRIPPED");
	check(
		"a subagent marker is stripped before the build",
		env.text.includes("STRIPPED"),
		env.text.split("\n").slice(-1)[0],
	);
	const session = await run("printenv PI_SESSION_ID || echo STRIPPED");
	check(
		"so is the session id",
		session.text.includes("STRIPPED"),
		session.text.split("\n").slice(-1)[0],
	);
	const kept = await run("printenv HOME");
	check(
		"the rest of the environment is kept",
		kept.text.includes(scratch),
		kept.text.split("\n").slice(-1)[0],
	);
} finally {
	for (const log of logs) {
		try {
			unlinkSync(log);
		} catch {
			/* already gone */
		}
	}
	rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
	console.error(`build probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`build probe passed: ${checks} checks`);
