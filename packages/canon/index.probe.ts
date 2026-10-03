/**
 * index.probe — the executable probe for the canon selection and rendering.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/canon`.
 *
 * This is the logic that decides which rules reach which session, and the bytes it
 * produces sit in every request's system prompt. It is not exported, so the probe
 * drives the extension the way pi does: a recorder stands in for the API, the
 * extension is handed it, and the captured `before_agent_start` handler is invoked
 * with a base prompt. The store it reads lives in a scratch agent directory
 * (`PI_CODING_AGENT_DIR`), so the machine's own canon store is never opened.
 *
 * A session is one call to the extension's default export: the audience set and the
 * memoised block are per-invocation, which is what lets one process hold a parent, a
 * foreman and a subagent at once — and what lets the probe re-render in a fresh
 * session to prove the block is reproducible.
 *
 * Cases: the selection for a parent session, a foreman session, a subagent session
 * (both child markers) and an unknown model; the model-scope exclusion; the provider
 * prefix in a model id; the group order the renderer emits, which the prompt cache
 * depends on; byte stability across two renders and across two sessions; an empty
 * store; and the /canon-dump filter surface — the values the completion offers and the
 * prefixes it answers, what a filter it never offered gets instead of an empty dump,
 * and the closed audience list the tools declare.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-canon-probe-"));
const storeDir = join(scratch, "canon");
const storePath = join(storeDir, "canon.json");
process.env.PI_CODING_AGENT_DIR = scratch;

/** Scrambled on purpose: the render order is the module's, never the file's. */
const ENTRIES = [
	{ id: "a-parent", text: "A-PARENT", model: "model-a", audience: "parent" },
	{ id: "g-sub", text: "G-SUBAGENT", model: "global", audience: "subagent" },
	{ id: "a-all", text: "A-ALL", model: "model-a", audience: "all" },
	{ id: "g-fore", text: "G-FOREMAN", model: "global", audience: "foreman" },
	{ id: "b-all", text: "B-ALL", model: "model-b", audience: "all" },
	{ id: "g-all", text: "G-ALL", model: "global", audience: "all" },
	{ id: "a-fore", text: "A-FOREMAN", model: "model-a", audience: "foreman" },
	{ id: "g-parent", text: "G-PARENT", model: "global", audience: "parent" },
	{ id: "a-sub", text: "A-SUBAGENT", model: "model-a", audience: "subagent" },
];

function writeStore(entries: unknown[]): void {
	mkdirSync(storeDir, { recursive: true });
	writeFileSync(storePath, JSON.stringify({ entries, categories: [] }));
}

writeStore(ENTRIES);

const { default: canon } = await import("./index.ts");

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
type Render = (modelId?: string) => Promise<string>;

type CommandSurface = {
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => unknown;
	handler: (args: string, ctx: unknown) => Promise<void>;
};
type ToolSurface = { name: string; parameters: unknown };

type Recorder = {
	api: unknown;
	handlers: Map<string, Handler>;
	commands: Map<string, CommandSurface>;
	tools: Map<string, ToolSurface>;
	sent: Array<{ content: string }>;
};

/** The recorder the extension is handed in place of the API: everything it registers,
 *  sends or hooks is captured, so a check can drive the dump command and read the tool
 *  schemas the model receives. */
function recorder(): Recorder {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, CommandSurface>();
	const tools = new Map<string, ToolSurface>();
	const sent: Array<{ content: string }> = [];
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: ToolSurface) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: CommandSurface) => commands.set(name, options),
		sendMessage: (message: { content?: string }) => sent.push({ content: message.content ?? "" }),
		getActiveTools: () => [],
		setActiveTools: () => {},
		appendEntry: () => {},
		events: { on: () => {}, emit: () => {} },
	};
	return { api, handlers, commands, tools, sent };
}

/** The markers a session starts with: cleared first, so a session cannot inherit
 *  another's audience. */
function applyEnv(env: Record<string, string>): void {
	for (const key of ["PI_SUBAGENT", "PI_SUBAGENT_CHILD", "PI_FOREMAN", "PI_MODEL"]) {
		delete process.env[key];
	}
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

/** A session that exposes its recorder instead of a render. */
function surfaces(env: Record<string, string>): Recorder {
	applyEnv(env);
	const rec = recorder();
	canon(rec.api as never);
	return rec;
}

/**
 * One session: the three markers are cleared first, so a session cannot inherit
 * another's audience, then the extension is handed a recorder. The driver awaits the
 * handler, which is async, and returns the appended block without its base.
 */
function session(env: Record<string, string>): Render {
	applyEnv(env);

	const { api, handlers } = recorder();
	canon(api as never);

	const handler = handlers.get("before_agent_start");
	if (!handler) throw new Error("the extension registered no before_agent_start handler");

	return async (modelId?: string): Promise<string> => {
		const ctx = modelId === undefined ? {} : { model: { id: modelId } };
		const result = (await handler({ systemPrompt: "BASE" }, ctx)) as { systemPrompt?: string };
		const text = result?.systemPrompt ?? "";
		return text.startsWith("BASE\n\n") ? text.slice("BASE\n\n".length) : text;
	};
}

/** The group headings a block carries, in the order they were emitted. */
function headings(block: string): string[] {
	return block
		.split("\n")
		.filter((line) => line.startsWith("### "))
		.map((line) => line.slice(4));
}

function has(block: string, id: string): boolean {
	return block.includes(`[${id}]`);
}

console.log("a parent session");
const parent = session({});
const parentBlock = await parent("model-a");
check("a global entry for every session is selected", has(parentBlock, "g-all"));
check("a global parent entry is selected", has(parentBlock, "g-parent"));
check("a model entry for this model is selected", has(parentBlock, "a-all"));
check("a model parent entry for this model is selected", has(parentBlock, "a-parent"));
check("a foreman entry is not", !has(parentBlock, "g-fore"));
check("a subagent entry is not", !has(parentBlock, "g-sub"));
check("another model's entry is not", !has(parentBlock, "b-all"));
check("another model's audience entry is not", !has(parentBlock, "a-fore"));
check("the block says which session it is for", parentBlock.includes("this session: parent"));
check("and which model", parentBlock.includes("Active model: model-a"));
check(
	"the rules open with the standing-instructions heading",
	parentBlock.startsWith("## Canon — binding system-prompt rules"),
);

console.log("a foreman session");
const foreman = session({ PI_FOREMAN: "1" });
const foremanBlock = await foreman("model-a");
check(
	"it receives everything a parent session does",
	has(foremanBlock, "g-parent") && has(foremanBlock, "a-parent"),
);
check("and the parent-wide entries", has(foremanBlock, "g-all") && has(foremanBlock, "a-all"));
check("and the foreman entries", has(foremanBlock, "g-fore") && has(foremanBlock, "a-fore"));
check("but not the subagent entries", !has(foremanBlock, "g-sub") && !has(foremanBlock, "a-sub"));
check("the label names both audiences", foremanBlock.includes("this session: parent, foreman"));

console.log("a subagent session");
const subagent = session({ PI_SUBAGENT: "1" });
const subagentBlock = await subagent("model-a");
check("it receives the global entries", has(subagentBlock, "g-all") && has(subagentBlock, "g-sub"));
check("and its model's entries", has(subagentBlock, "a-all") && has(subagentBlock, "a-sub"));
check("but no parent entry", !has(subagentBlock, "g-parent") && !has(subagentBlock, "a-parent"));
check("and no foreman entry", !has(subagentBlock, "g-fore") && !has(subagentBlock, "a-fore"));
check(
	"the child marker alone is enough",
	(await session({ PI_SUBAGENT_CHILD: "1" })("model-a")).includes("this session: subagent"),
);

console.log("the model scope");
check(
	"a provider prefix in the session's model id is stripped before matching",
	(await session({})("openrouter/model-a")) === parentBlock,
);
const otherModel = await session({})("model-z");
check(
	"an unmatched model falls back to the global entries only",
	!has(otherModel, "a-all") && has(otherModel, "g-all"),
);
check("and the block still names the model it read", otherModel.includes("Active model: model-z"));

console.log("the group order the renderer emits");
const order = headings(foremanBlock);
check(
	"global groups precede model groups, and audiences follow their own order",
	JSON.stringify(order) ===
		JSON.stringify([
			"All models",
			"All models — parent only",
			"All models — foreman only",
			"This model (model-a)",
			"This model (model-a) — parent only",
			"This model (model-a) — foreman only",
		]),
	JSON.stringify(order),
);
check(
	"the global group is not re-sorted with the model groups",
	order.indexOf("All models") < order.indexOf("This model (model-a)"),
);

console.log("byte stability");
check("rendering twice in one session is identical", (await foreman("model-a")) === foremanBlock);
check(
	"a fresh session renders the same bytes",
	(await session({ PI_FOREMAN: "1" })("model-a")) === foremanBlock,
);
check(
	"and the parent block is stable the same way",
	(await session({})("model-a")) === parentBlock,
);

console.log("the /canon-dump filter values");
const dump = surfaces({});
const dumpCommand = dump.commands.get("canon-dump");
type Item = { value: string; label: string; description?: string };
const offered = (prefix: string): Item[] =>
	(dumpCommand?.getArgumentCompletions?.(prefix) as Item[] | null) ?? [];
check(
	"the dump command registers an argument-completion callback",
	typeof dumpCommand?.getArgumentCompletions === "function",
);
check(
	"an empty prefix offers the audience words first, then the models the store holds",
	JSON.stringify(offered("").map((i) => i.value)) ===
		JSON.stringify(["all", "parent", "foreman", "subagent", "model-a", "global", "model-b"]),
	JSON.stringify(offered("").map((i) => i.value)),
);
check(
	"every offered value carries its own description",
	offered("").every((i) => (i.description ?? "").length > 0),
);
check(
	"and its value is its label",
	offered("").every((i) => i.label === i.value),
);
check(
	"a prefix narrows the list",
	JSON.stringify(offered("mo").map((i) => i.value)) === JSON.stringify(["model-a", "model-b"]),
);
check(
	"a prefix matching one word offers that one",
	JSON.stringify(offered("sub").map((i) => i.value)) === JSON.stringify(["subagent"]),
);
check(
	"a prefix nothing matches offers nothing",
	dumpCommand?.getArgumentCompletions?.("zz") === null,
);

console.log("a filter the completion never offered");
const notices: Array<{ text: string; level?: string }> = [];
const commandCtx = {
	ui: { notify: (text: string, level?: string) => notices.push({ text, level }) },
};
await dumpCommand?.handler("nope", commandCtx);
check("no dump is sent", dump.sent.length === 0);
check(
	"the answer names the values that do exist",
	notices.length === 1 &&
		notices[0].text.includes("subagent") &&
		notices[0].text.includes("model-a"),
	notices[0]?.text,
);
check(
	"and names the filter it refused",
	notices.length === 1 && notices[0].text.includes('"nope"'),
);
check("as an error, not as a notice", notices.length === 1 && notices[0].level === "error");

console.log("a filter the completion does offer");
await dumpCommand?.handler("model-b", commandCtx);
check(
	"the model filter dumps that model alone",
	dump.sent.length === 1 &&
		dump.sent[0].content.includes("B-ALL") &&
		!dump.sent[0].content.includes("A-ALL"),
);
await dumpCommand?.handler("foreman", commandCtx);
check(
	"the audience filter dumps that audience alone",
	dump.sent[1].content.includes("G-FOREMAN") && !dump.sent[1].content.includes("G-PARENT"),
);
await dumpCommand?.handler("provider/model-b", commandCtx);
check(
	"a provider prefix resolves the way the model branch does",
	dump.sent[2].content.includes("B-ALL"),
);
await dumpCommand?.handler("", commandCtx);
check(
	"no filter dumps the whole store",
	dump.sent[3].content.includes("A-ALL") && dump.sent[3].content.includes("B-ALL"),
);

console.log("the audience list the tools declare");
const property = (tool: string, name: string): unknown => {
	const parameters = dump.tools.get(tool)?.parameters as
		| { properties?: Record<string, unknown> }
		| undefined;
	return parameters?.properties?.[name];
};
/** Every `const` value a schema declares — what a union of literals compiles to. */
function literals(schema: unknown): string[] {
	const found: string[] = [];
	const walk = (node: unknown): void => {
		if (!node || typeof node !== "object") return;
		for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
			if (key === "const" && typeof value === "string") found.push(value);
			else walk(value);
		}
	};
	walk(schema);
	return found.sort();
}
const CLOSED_AUDIENCE = ["all", "foreman", "parent", "subagent"];
check(
	"canon_add's audience is the closed list of audience words",
	JSON.stringify(literals(property("canon_add", "audience"))) === JSON.stringify(CLOSED_AUDIENCE),
	JSON.stringify(literals(property("canon_add", "audience"))),
);
check(
	"canon_edit's audience is the same closed list",
	JSON.stringify(literals(property("canon_edit", "audience"))) === JSON.stringify(CLOSED_AUDIENCE),
);
check(
	"canon_add's audience is required",
	(
		(dump.tools.get("canon_add")?.parameters as { required?: string[] } | undefined)?.required ?? []
	).includes("audience"),
);
check(
	"the closed list keeps its description",
	JSON.stringify(property("canon_add", "audience")).includes("Audience"),
);
check(
	"canon_add's model is NOT closed — the model registry owns that space, so a model is not refusable by the schema",
	literals(property("canon_add", "model")).length === 0,
	JSON.stringify(literals(property("canon_add", "model"))),
);

console.log("an empty store");
writeStore([]);
const empty = await session({})("model-a");
check("no entry means no group heading", headings(empty).length === 0);
check(
	"the block still renders its header",
	empty.startsWith("## Canon — binding system-prompt rules"),
);
check("and no entry line", !empty.includes("["));

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`canon probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`canon probe passed: ${checks} checks`);
