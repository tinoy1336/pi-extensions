/**
 * index.probe — the executable probe for the no-fork rewrite and its block.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/no-subagent-fork`.
 *
 * The package's whole value is a decision about someone else's tool call: a `context:
 * "fork"` request must become `"fresh"` so the spawn still succeeds, and only a request
 * that cannot be rewritten — a `workflowScriptPath` naming a file, which is the
 * caller's to edit — may be blocked. A pattern that stops matching, a rewrite that
 * starts dropping the call instead, or a block that fires on a file that never asked
 * for a fork are all silent here and destructive in a session, and no workspace gate
 * reads any of them.
 *
 * `HOME` points at a scratch directory before the module is imported, so the audit log
 * this package appends lands in the probe's own tree and never in the machine's.
 *
 * Cases: the pattern against quoted, single-quoted and spaced forms, a word that only
 * looks like a fork, a call-level rewrite, an inline workflow script, a script file that
 * requests a fork (blocked, and left unedited), a file that does not, a missing file,
 * and a call to another tool.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-no-fork-probe-"));
process.env.HOME = scratch;

const { deforkSource, requestsFork, default: noSubagentFork } = await import("./index.ts");

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

console.log("the pattern");
check("a double-quoted fork is seen", requestsFork('{ context: "fork" }'));
check("a single-quoted fork is seen", requestsFork("{ context: 'fork' }"));
check("a spaced fork is seen", requestsFork("{ context : 'fork' }"));
check("fresh is not a fork", !requestsFork('{ context: "fresh" }'));
check("a word that only starts with fork is not a fork", !requestsFork('{ context: "forked" }'));
check("another key naming fork is not a fork", !requestsFork('{ contextMode: "fork" }'));
check(
	"the rewrite leaves the rest of the body alone",
	deforkSource('const a = 1;\nawait pi.subagent({ context: "fork", name: "x" });\n') ===
		'const a = 1;\nawait pi.subagent({ context: "fresh", name: "x" });\n',
);

// ── the handler, driven the way pi calls it ──────────────────────────────────────────
type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
const api = {
	on: (event: string, handler: Handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
};
noSubagentFork(api as never);

const ctx = { cwd: scratch };
function callTool(input: Record<string, unknown>, toolName = "subagent"): unknown {
	const event = { type: "tool_call", toolName, toolCallId: "probe", input };
	let result: unknown;
	for (const handler of handlers.get("tool_call") ?? []) result = handler(event, ctx);
	return result;
}

console.log("a call-level fork");
const call = { context: "fork", prompt: "hi" };
check("the call is not blocked", callTool(call) === undefined);
check("and its context is rewritten", call.context === "fresh", String(call.context));

console.log("an inline workflow script");
const inline = { workflowScript: 'run({ context: "fork" })' };
check("the script call is not blocked", callTool(inline) === undefined);
check(
	"and its body is rewritten",
	inline.workflowScript === 'run({ context: "fresh" })',
	inline.workflowScript,
);
const alreadyFresh = { workflowScript: 'run({ context: "fresh" })' };
callTool(alreadyFresh);
check(
	"a script that never forked is untouched",
	alreadyFresh.workflowScript === 'run({ context: "fresh" })',
);

console.log("a workflow script file");
const forking = join(scratch, "fork.js");
writeFileSync(forking, 'run({ context: "fork" })\n');
const blocked = callTool({ workflowScriptPath: forking }) as { block?: boolean; reason?: string };
check("a file that requests a fork is blocked", blocked?.block === true);
check("and the refusal names the file", blocked?.reason?.includes(forking) === true);
check(
	"and the file is left unedited",
	readFileSync(forking, "utf8") === 'run({ context: "fork" })\n',
);
const fresh = join(scratch, "fresh.js");
writeFileSync(fresh, 'run({ context: "fresh" })\n');
check(
	"a file that does not request a fork passes",
	callTool({ workflowScriptPath: fresh }) === undefined,
);
check(
	"a missing file passes — the tool reports its own error",
	callTool({ workflowScriptPath: join(scratch, "absent.js") }) === undefined,
);
check(
	"a relative path is resolved from the context",
	(() => {
		const rel = "rel-fork.js";
		writeFileSync(join(scratch, rel), 'run({ context: "fork" })\n');
		return (
			(callTool({ workflowScriptPath: rel }) as { block?: boolean } | undefined)?.block === true
		);
	})(),
);

console.log("a call to another tool");
const other = { context: "fork" };
check("is not rewritten and not blocked", callTool(other, "bash") === undefined);
check("and is left alone", other.context === "fork", String(other.context));

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`no-subagent-fork probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`no-subagent-fork probe passed: ${checks} checks`);
