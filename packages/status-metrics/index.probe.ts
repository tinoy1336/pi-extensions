/**
 * index.probe — the executable probe for the footer counters.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/status-metrics`.
 *
 * The counters are the only place a session's blocked calls, nudges and saved bytes
 * are visible, and they are built by draining a shared log whose rows come from every
 * other extension in the process. A wrong drain either reports another process's
 * activity as this session's or counts a diagnostic as a block, which is the failure
 * the kind filter exists for; neither shows up in any other check.
 *
 * `HOME` and `XDG_RUNTIME_DIR` point at a scratch directory before the module is
 * imported, so the machine's own diagnostics log and focus ledgers are never read and
 * never written. The ledger path is asked for from its owner (`@tinoy/pi-focus-state`)
 * rather than spelled out here.
 *
 * Cases: no rows at all, a block row from this process against one from another, a
 * diagnostic row under the same source, a nudge against the row that is not one, the
 * byte formatting, the ledger a session has queued, the incremental drain (a second
 * render must not re-count what it already read), the order the parts are joined in,
 * and the reset a session start performs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { focusLedgerPathFor } from "@tinoy/pi-focus-state";

const scratch = mkdtempSync(join(tmpdir(), "pi-status-metrics-probe-"));
process.env.HOME = scratch;
process.env.XDG_RUNTIME_DIR = scratch;

const logDir = join(scratch, ".local", "share", "pi-hooks");
const logPath = join(logDir, "log.jsonl");
mkdirSync(logDir, { recursive: true });
writeFileSync(logPath, "");

const SID = "probe-session";
const { default: statusMetrics } = await import("./index.ts");

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

type Handler = (event: unknown, ctx: unknown) => unknown;

let lastStatus: string | undefined;

const handlers = new Map<string, Handler>();
const api = {
	on: (name: string, handler: Handler) => handlers.set(name, handler),
	registerTool: () => {},
	registerCommand: () => {},
	getActiveTools: () => [],
	setActiveTools: () => {},
	appendEntry: () => {},
	events: {
		on: (name: string, handler: Handler) => handlers.set(`event:${name}`, handler),
		emit: () => {},
	},
};
statusMetrics(api as never);

const onSessionStart = handlers.get("session_start");
const onToolResult = handlers.get("tool_result");
const onMessageEnd = handlers.get("message_end");
if (!onSessionStart || !onToolResult || !onMessageEnd)
	throw new Error("the extension did not register its render hooks");
const start: Handler = onSessionStart;
const toolResult: Handler = onToolResult;
const messageEnd: Handler = onMessageEnd;

const ctx = {
	ui: {
		setStatus: (_key: string, value: string | undefined) => {
			lastStatus = value;
		},
	},
	sessionManager: { getSessionId: () => SID },
};

/** A diagnostics row in the shared envelope's shape. */
function row(
	source: string,
	kind: string,
	detail: Record<string, unknown> = {},
	proc = process.pid,
): string {
	return `${JSON.stringify({ ts: new Date().toISOString(), proc, sid: SID, source, kind, detail })}\n`;
}

function append(...lines: string[]): void {
	writeFileSync(logPath, lines.join(""), { flag: "a" });
}

/** The parts of the rendered field, and their numbers. */
function parts(): string[] {
	return (lastStatus ?? "").split(" ").filter(Boolean);
}
function count(index: number): number {
	const part = parts()[index] ?? "";
	return Number(part.slice(1).replace(/[^\d.]/g, ""));
}
function glyphs(): string[] {
	return parts().map((part) => part.slice(0, 1));
}

console.log("nothing to report");
start({}, ctx);
check("an empty log renders no field at all", lastStatus === undefined, String(lastStatus));

console.log("what is counted, and what is not");
append(
	row("command-guard", "block"),
	row("focus-gate", "block"),
	row("command-guard", "block", {}, process.pid + 1),
	row("command-guard", "state-change"),
);
toolResult({}, ctx);
check("both blocking sources count", count(0) === 2, `got ${count(0)}`);
check("another process's row does not", count(0) === 2, `got ${count(0)}`);
check("a diagnostic under the same source does not", count(0) === 2, `got ${count(0)}`);
check("the block glyph leads its number", /^\D\d+$/.test(parts()[0] ?? ""), parts()[0]);

append(row("drift-anchor", "anchor"), row("drift-anchor", "set-anchor"));
messageEnd({}, ctx);
check("a nudge counts", count(1) === 1, `got ${count(1)}`);
check("the configuration call does not", count(1) === 1, `got ${count(1)}`);
check("the counters are joined in their own order", parts().length === 2, parts().join(" | "));

console.log("the bytes a stub kept out of context");
const savedBytes = 525_312;
append(row("read-staleness", "stub", { bytes: savedBytes }));
toolResult({}, ctx);
const expectedSaved =
	savedBytes >= 1_048_576
		? `${(savedBytes / 1_048_576).toFixed(1)}M`
		: `${Math.round(savedBytes / 1024)}k`;
check(
	"the byte counter is rendered in the compact form",
	parts()[2]?.slice(1) === expectedSaved,
	`${parts()[2]} vs ${expectedSaved}`,
);
check(
	"the three counters keep their order",
	parts().length === 3 && glyphs().every((g) => /[^\x20-\x7e]/.test(g)),
	glyphs().join(""),
);

console.log("the ledger a session queued");
const ledger = focusLedgerPathFor(SID);
mkdirSync(join(ledger, ".."), { recursive: true });
writeFileSync(ledger, `${JSON.stringify({ at: Date.now(), action: "blocked" })}\n`.repeat(3));
toolResult({}, ctx);
check("the queued counter counts the ledger's rows", count(3) === 3, `got ${count(3)}`);
check("beside the other three", parts().length === 4, parts().join(" | "));

console.log("the drain is incremental");
const beforeDrain = count(0);
toolResult({}, ctx);
check(
	"a render with no new rows counts nothing again",
	count(0) === beforeDrain,
	`${beforeDrain} then ${count(0)}`,
);
append(row("command-guard", "block"));
toolResult({}, ctx);
check(
	"and a new row counts exactly once",
	count(0) === beforeDrain + 1,
	`${beforeDrain} then ${count(0)}`,
);

console.log("a session start resets the read");
const blockRows = readFileSync(logPath, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line) as { proc?: number; source?: string; kind?: string })
	.filter(
		(r) =>
			r.proc === process.pid &&
			(r.source === "command-guard" || r.source === "focus-gate") &&
			r.kind === "block",
	).length;
start({}, ctx);
check(
	"the whole log is read again from the start",
	count(0) === blockRows,
	`${count(0)} vs ${blockRows} block rows in the log`,
);
check("and the ledger is counted again too", count(3) === 3, `got ${count(3)}`);

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`status-metrics probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`status-metrics probe passed: ${checks} checks`);
