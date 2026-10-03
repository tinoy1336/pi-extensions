/**
 * index.probe — the executable probe for the drift anchor's injection decisions.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/drift-anchor`.
 *
 * This is the layer that decides when ONE line is appended to the outgoing message
 * array, and every rule in that decision is invisible until it misfires: a marker miss
 * must re-anchor on the very NEXT context, the anti-habituation gap must stop a second
 * line in the same window, a slow-ratio turn must take the gentler rotation rather than
 * the immediate line, a terse answer must never count as a ratio breach (the degenerate
 * denominator), a repeated blocked tool must get its nudge, and the config's `enabled:
 * false` must silence all of it. Nothing but this probe reads any of it.
 *
 * `HOME` and `XDG_STATE_HOME` point at a scratch directory before the module is
 * imported, so neither the machine's config nor its injection log is touched, and the
 * session is driven through the extension's own hooks with a recorder playing pi's role.
 * The turn stream is synthesized: each `message_end` is one assistant message and the
 * first thinking line is what the marker check reads.
 *
 * Cases: no turn at all, the terse-answer guard, the immediate re-anchor after a miss and
 * the gap that blocks a second one, the quiet turns that inject nothing, the rotation
 * line for a slow ratio, the blocked-tool nudge and where it lands, and the config switch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-drift-anchor-probe-"));
process.env.HOME = scratch;
process.env.XDG_STATE_HOME = join(scratch, "state");

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
let setAnchorTool: { execute: (id: string, params: unknown) => Promise<unknown> } | undefined;
const api = {
	on: (event: string, handler: Handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerTool: (tool: { name: string; execute: unknown }) => {
		if (tool.name === "set_anchor") setAnchorTool = tool as never;
	},
	registerCommand: () => {},
	events: { on: () => {}, emit: () => {} },
};

const { default: driftAnchor } = await import("./index.ts");
driftAnchor(api as never);

const ctx = {
	sessionManager: { getEntries: () => [] as unknown[], getBranch: () => [] as unknown[] },
	getContextUsage: () => undefined,
};

// The start hook anchors the jittered maintenance cadence at this turn; without it the
// cadence is due from the first turn and its own dose would mask every case below.
for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);

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

/** One assistant message: the first thinking line is what the marker check reads. */
function turn(thinking: string, text: string): void {
	for (const handler of handlers.get("message_end") ?? [])
		handler(
			{
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking },
						{ type: "text", text },
					],
				},
			},
			ctx,
		);
}

/** One outgoing request, and what the injection decision did to it. */
function outgoing(): Array<{ role?: string; content?: Array<{ text?: string }> }> {
	const messages: Array<{ role?: string; content?: Array<{ text?: string }> }> = [
		{ role: "user", content: [{ text: "the real user turn" }] },
	];
	for (const handler of handlers.get("context") ?? []) handler({ messages }, ctx);
	return messages;
}

/** The injected tail message, or undefined when the request came back untouched. */
function injected(
	messages: Array<{ role?: string; content?: Array<{ text?: string }> }>,
): string | undefined {
	return messages
		.map((message) => message.content?.[0]?.text ?? "")
		.find((text) => text.startsWith("[anchor]") || text.startsWith("[nudge]"));
}

/** A response that breaks no rule: the marker is present, the answer has a body, the ratio is small. */
const CLEAN = ["Caveman mode. ok.", "a plain answer body of forty chars ok"] as const;

console.log("before any turn");
check(
	"an empty request is untouched",
	(() => {
		const messages: unknown[] = [];
		for (const handler of handlers.get("context") ?? []) handler({ messages }, ctx);
		return messages.length === 0;
	})(),
);
check("a request with no turn behind it injects nothing", injected(outgoing()) === undefined);

console.log("the terse-answer guard");
// A long reasoning block over a ten-character answer: the ratio is large but the
// degeneracy guard says a terse reply is not prose, so nothing may fire here.
turn("Caveman mode. Fix bug. Run test. Ship. ".repeat(9), "ok, done.");
check("a long reasoning over a terse answer injects nothing", injected(outgoing()) === undefined);

console.log("the marker miss");
turn("no marker at the top of this reasoning", "a plain answer body of forty chars ok");
const afterMiss = outgoing();
check(
	"the very next request carries a line",
	injected(afterMiss) !== undefined,
	injected(afterMiss) ?? "(nothing)",
);
check(
	"it is the immediate line, not a rotation one",
	injected(afterMiss)?.includes("Restart the register now") === true,
	injected(afterMiss) ?? "",
);
check("it is tagged as the anchor", injected(afterMiss)?.startsWith("[anchor] ") === true);
check("and only one line was added", afterMiss.length === 2, `${afterMiss.length} message(s)`);
check("the gap stops a second line in the same window", injected(outgoing()) === undefined);

console.log("the quiet turns");
turn(...CLEAN);
turn(...CLEAN);
check("a compliant turn injects nothing", injected(outgoing()) === undefined);

console.log("the slow ratio");
// Prose-free caveman fragments over a substantial answer: the ratio breaches, the
// register heuristics do not — so the drift path takes the gentler rotation line.
turn("Caveman mode. Fix bug. Run test. Ship. ".repeat(9), "a plain answer body of forty chars ok");
const afterRatio = outgoing();
check(
	"an over-warn ratio carries a line",
	injected(afterRatio) !== undefined,
	injected(afterRatio) ?? "(nothing)",
);
check(
	"and it is a rotation line, never the immediate one",
	injected(afterRatio)?.includes("Restart the register now") === false,
	injected(afterRatio) ?? "",
);

console.log("the blocked-tool nudge");
for (let i = 0; i < 6; i += 1) turn(...CLEAN);
for (let i = 0; i < 3; i += 1) {
	for (const handler of handlers.get("tool_execution_end") ?? [])
		handler(
			{
				toolName: "bash",
				isError: true,
				result: { content: [{ type: "text", text: "R1: blocked segment: grep over a file" }] },
			},
			ctx,
		);
}
const afterBlocked = outgoing();
const nudge = injected(afterBlocked);
check(
	"a repeated blocked tool gets a line",
	nudge?.includes("Blocked tools repeating") === true,
	nudge ?? "(nothing)",
);
check("tagged as a nudge, not an anchor", nudge?.startsWith("[nudge] ") === true);
check(
	"and it lands second-to-last, before the real user turn",
	afterBlocked.at(-2)?.content?.[0]?.text === nudge &&
		afterBlocked.at(-1)?.content?.[0]?.text === "the real user turn",
	`tail: ${afterBlocked.at(-1)?.content?.[0]?.text ?? "(none)"}`,
);
check(
	"one blocked result alone is not a repeat",
	(() => {
		const messages: Array<{ role?: string; content?: Array<{ text?: string }> }> = [
			{ role: "user", content: [{ text: "the real user turn" }] },
		];
		for (const handler of handlers.get("context") ?? []) handler({ messages }, ctx);
		return injected(messages) === undefined;
	})(),
);

console.log("the anchor tool and the config switch");
check("the set_anchor tool is registered", setAnchorTool !== undefined);
const cfgDir = join(scratch, ".config", "drift-anchor");
mkdirSync(cfgDir, { recursive: true });
writeFileSync(join(cfgDir, "config.json"), `${JSON.stringify({ enabled: false })}\n`);
turn(...CLEAN);
turn("no marker at the top of this reasoning either", "a plain answer body of forty chars ok");
check("a disabled anchor injects nothing, even after a miss", injected(outgoing()) === undefined);

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`drift-anchor probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`drift-anchor probe passed: ${checks} checks`);
