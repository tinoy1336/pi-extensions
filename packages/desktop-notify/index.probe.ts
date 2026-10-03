/**
 * index.probe — the executable probe for the desktop-notify popup contract.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/desktop-notify`.
 *
 * Every rule this package carries is invisible until a popup appears on someone's
 * screen: the message is the ONLY text (the summary positional stays empty and a
 * caller's `title` is discarded), the message is capped, urgency picks both the expiry
 * and the icon, and the automatic pings stay silent for a subagent, for a run with no
 * user watching, and for a settled run that already notified or was interrupted. A
 * silent change here either puts a heading on the popup, leaves a sticky notification
 * on the screen, or pings the user on every fan-out.
 *
 * Nothing is sent: `pi.exec` is a recorder that returns the exit status the probe
 * chooses, so no notification daemon is reached and no window is opened. The focus
 * state is read through a scratch `XDG_RUNTIME_DIR`, so the machine's own mode is never
 * consulted.
 *
 * Cases: the argument vector for a manual call, the message cap, an ignored title, the
 * per-urgency expiry and icon, an explicit timeout, an empty message, a failing
 * `notify-send`, the ask-user-question ping, and each settle path that must stay silent.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-desktop-notify-probe-"));
process.env.XDG_RUNTIME_DIR = scratch;
// A subagent flag the settle path must honour; cleared for the cases that must ping.
delete process.env.PI_SUBAGENT;
delete process.env.PI_SUBAGENT_CHILD;

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
};

const handlers = new Map<string, Handler[]>();
const tools = new Map<string, Tool>();
/** Every `notify-send` invocation the extension made, in order. */
const sent: Array<{ command: string; args: string[] }> = [];
/** The exit status the recorder answers with; the failing case overrides it. */
let execStatus = { code: 0, stdout: "", stderr: "" };

const api = {
	on: (event: string, handler: Handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerTool: (tool: Tool) => tools.set(tool.name, tool),
	exec: async (command: string, args: string[]) => {
		sent.push({ command, args });
		return { ...execStatus };
	},
};

const { default: desktopNotify } = await import("./index.ts");
desktopNotify(api as never);

const tool = tools.get("desktop_notify");
if (!tool) throw new Error("the extension registered no desktop_notify tool");

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

function fire(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
	return Promise.all(
		(handlers.get(event) ?? []).map((handler) => Promise.resolve(handler(payload, ctx))),
	);
}

/** The argument vector of the last notification, or an empty one when nothing was sent. */
function lastArgs(): string[] {
	return sent.at(-1)?.args ?? [];
}

/** What sits in the summary positional (the second-to-last argument). */
function summary(): string | undefined {
	return lastArgs().at(-2);
}

console.log("a manual call");
const long = "x".repeat(400);
const result = await tool.execute("probe", {
	message: long,
	title: "Pi — should not render",
	urgency: "critical",
});
check(
	"the command is notify-send",
	sent.at(-1)?.command === "notify-send",
	sent.at(-1)?.command ?? "none",
);
check("the summary positional is empty", summary() === "", JSON.stringify(summary()));
check(
	"the message is the last argument and is capped",
	lastArgs().at(-1)?.length === 300,
	`len ${lastArgs().at(-1)?.length}`,
);
check(
	"critical persists",
	lastArgs().includes("0") && lastArgs()[lastArgs().indexOf("--expire-time") + 1] === "0",
);
check(
	"critical carries the error icon",
	lastArgs()[lastArgs().indexOf("--icon") + 1] === "dialog-error",
	lastArgs()[lastArgs().indexOf("--icon") + 1] ?? "none",
);
check(
	"the caller's title is reported as ignored",
	result.content[0].text.includes("Title ignored"),
);
check("and is not sent anywhere", !lastArgs().includes("Pi — should not render"));
check(
	"the capped message is what the result records",
	result.details.message === long.slice(0, 300),
);

console.log("urgency defaults");
await tool.execute("probe", { message: "heads-up", urgency: "low" });
check("low expires after 5s", lastArgs()[lastArgs().indexOf("--expire-time") + 1] === "5000");
check(
	"low uses the information icon",
	lastArgs()[lastArgs().indexOf("--icon") + 1] === "dialog-information",
);
await tool.execute("probe", { message: "heads-up" });
check(
	"an absent urgency is normal at 8s",
	lastArgs()[lastArgs().indexOf("--expire-time") + 1] === "8000",
);
await tool.execute("probe", { message: "heads-up", timeoutMs: 1234 });
check("an explicit timeout wins", lastArgs()[lastArgs().indexOf("--expire-time") + 1] === "1234");

console.log("what is refused");
const before = sent.length;
const empty = await tool.execute("probe", { message: "   " });
check("an empty message sends nothing", sent.length === before);
check(
	"and is refused by name",
	empty.content[0].text.includes("message is required"),
	empty.content[0].text,
);
check("with no notification reported", empty.details.sent === false);

execStatus = { code: 1, stdout: "", stderr: "no daemon" };
const failed = await tool.execute("probe", { message: "hello" });
check(
	"a failing notify-send is reported",
	failed.content[0].text.includes("no daemon"),
	failed.content[0].text,
);
check(
	"and names the daemon as the suspect",
	failed.content[0].text.includes("notification daemon"),
);
check("with no notification reported", failed.details.sent === false);
execStatus = { code: 0, stdout: "", stderr: "" };

console.log("the question ping");
const ctx = {
	hasUI: true,
	isIdle: () => true,
	sessionManager: { getBranch: () => branch("done") },
};
sent.length = 0;
await fire(
	"tool_call",
	{ toolName: "ask_user_question", input: { questions: [{ question: "Are\n you  there?" }] } },
	ctx,
);
check("a question pings", sent.length === 1, `${sent.length} notification(s)`);
check(
	"with the whitespace collapsed",
	lastArgs().at(-1) === "Are you there?",
	lastArgs().at(-1) ?? "none",
);
check("at normal urgency", lastArgs()[lastArgs().indexOf("--urgency") + 1] === "normal");

console.log("the settle ping, and when it stays silent");
await fire("agent_start", {}, ctx);
sent.length = 0;
await fire("agent_settled", {}, ctx);
check("a finished response pings", sent.length === 1);
check("with the answer's text", lastArgs().at(-1) === "done", lastArgs().at(-1) ?? "none");
check("at low urgency", lastArgs()[lastArgs().indexOf("--urgency") + 1] === "low");

await fire("agent_start", {}, ctx);
await fire("tool_call", { toolName: "desktop_notify", input: {} }, ctx);
sent.length = 0;
await fire("agent_settled", {}, ctx);
check("a run that already notified is silent", sent.length === 0);

await fire("agent_start", {}, ctx);
sent.length = 0;
await fire("agent_settled", {}, { ...ctx, hasUI: false });
check("a run with no user watching is silent", sent.length === 0);

await fire("agent_start", {}, ctx);
await fire("input", { streamingBehavior: "steer" }, ctx);
sent.length = 0;
await fire("agent_settled", {}, ctx);
check("a steered (cancelled) run is silent", sent.length === 0);

await fire("agent_start", {}, ctx);
sent.length = 0;
await fire(
	"agent_settled",
	{},
	{ ...ctx, sessionManager: { getBranch: () => branch("done", "aborted") } },
);
check("an Esc-aborted run is silent", sent.length === 0);

await fire("agent_start", {}, ctx);
sent.length = 0;
await fire("agent_settled", {}, { ...ctx, isIdle: () => false });
check("a run with another queued is silent", sent.length === 0);

process.env.PI_SUBAGENT = "1";
await fire("agent_start", {}, ctx);
sent.length = 0;
await fire("agent_settled", {}, ctx);
check("a subagent session is silent", sent.length === 0);
delete process.env.PI_SUBAGENT;

writeFileSync(join(scratch, "pi-focus.json"), JSON.stringify({ mode: "on" }));
await fire("agent_start", {}, ctx);
sent.length = 0;
await fire("agent_settled", {}, ctx);
check("a settle while focus mode is on is silent", sent.length === 0);
await fire("tool_call", { toolName: "ask_user_question", input: {} }, ctx);
check("but a question still pings in focus mode", sent.length === 1);
writeFileSync(join(scratch, "pi-focus.json"), JSON.stringify({ mode: "off" }));

/** A branch carrying one finalized assistant message, as the settle path reads it. */
function branch(text: string, stopReason = "stop"): unknown[] {
	return [
		{
			type: "message",
			message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
		},
	];
}

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`desktop-notify probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`desktop-notify probe passed: ${checks} checks`);
