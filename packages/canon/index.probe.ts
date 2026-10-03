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
 * depends on; byte stability across two renders and across two sessions; the /canon
 * argument completions and the scopes it refuses; that the list verb prints this
 * session's block byte for byte and nothing beside it; the closed audience list the
 * tools declare against the model list that stays open; the shape of what a tool
 * writes to the store, and that a reason already stored is neither printed nor
 * written back; and an empty store.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
type ToolSurface = { name: string; parameters: unknown; execute?: (...args: unknown[]) => unknown };

type Recorder = {
	api: unknown;
	handlers: Map<string, Handler>;
	commands: Map<string, CommandSurface>;
	tools: Map<string, ToolSurface>;
};

/** The recorder the extension is handed in place of the API: everything it registers
 *  or hooks is captured, so a check can drive the command and the tools the way pi
 *  does, and read the schemas the model receives. */
function recorder(): Recorder {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, CommandSurface>();
	const tools = new Map<string, ToolSurface>();
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: (tool: ToolSurface) => tools.set(tool.name, tool),
		registerCommand: (name: string, options: CommandSurface) => commands.set(name, options),
		getActiveTools: () => [],
		setActiveTools: () => {},
		appendEntry: () => {},
		events: { on: () => {}, emit: () => {} },
	};
	return { api, handlers, commands, tools };
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

console.log("the /canon argument completions");
const rec = surfaces({ PI_MODEL: "model-a" });
const command = rec.commands.get("canon");
type Item = { value: string; label: string; description?: string };
const offered = (prefix: string): Item[] =>
	(command?.getArgumentCompletions?.(prefix) as Item[] | null) ?? [];
check(
	"the command registers an argument-completion callback",
	typeof command?.getArgumentCompletions === "function",
);
check(
	"an empty prefix offers the verbs",
	JSON.stringify(offered("").map((i) => i.label)) ===
		JSON.stringify(["list", "add", "remove", "edit", "category"]),
	JSON.stringify(offered("").map((i) => i.label)),
);
check(
	"every verb carries its own description",
	offered("").every((i) => (i.description ?? "").length > 0),
);
check(
	"a prefix narrows the verbs",
	JSON.stringify(offered("ca").map((i) => i.label)) === JSON.stringify(["category"]),
);
check(
	"after the list verb the scopes are offered, audience words first",
	JSON.stringify(offered("list ").map((i) => i.label)) ===
		JSON.stringify(["all", "parent", "foreman", "subagent", "model-a", "global", "model-b"]),
	JSON.stringify(offered("list ").map((i) => i.label)),
);
check(
	"a scope prefix narrows to the scopes it matches",
	JSON.stringify(offered("list m").map((i) => i.label)) === JSON.stringify(["model-a", "model-b"]),
);
check(
	"and the inserted value is the whole argument",
	offered("list m").every((i) => i.value === `list ${i.label}`),
	JSON.stringify(offered("list m").map((i) => i.value)),
);
check(
	"a verb whose argument is not a scope offers nothing",
	command?.getArgumentCompletions?.("add x") === null,
);
check("a prefix nothing matches offers nothing", command?.getArgumentCompletions?.("zz") === null);

console.log("the list verb prints the block, and nothing beside it");
const notices: Array<{ text: string; level?: string }> = [];
const commandCtx = {
	ui: { notify: (text: string, level?: string) => notices.push({ text, level }) },
};
/** The block the last run printed, or null when it printed no block — a refusal is
 *  answered with an error notice, which is not output. */
async function list(args: string): Promise<string | null> {
	notices.length = 0;
	await command?.handler(args, commandCtx);
	const first = notices[0];
	return first && first.level !== "error" ? (first.text ?? null) : null;
}
const defaultOutput = await list("list");
check("the default output is this session's block, byte for byte", defaultOutput === parentBlock);
check("and nothing is printed beside it", notices.length === 1);
check(
	"and no scope is echoed into the output",
	defaultOutput?.startsWith("## Canon — binding system-prompt rules") === true,
);
const modelBBlock = await list("list model-b");
check(
	"a model scope renders that model's block",
	modelBBlock?.includes("[b-all]") === true && modelBBlock?.includes("[a-all]") === false,
);
const foremanScope = await list("list foreman");
check(
	"an audience scope renders that audience's block",
	foremanScope?.includes("[a-fore]") === true && foremanScope?.includes("[a-parent]") === false,
);
const allScope = await list("list all");
check(
	"the all audience scope renders only all-session entries",
	allScope?.includes("[g-all]") === true && allScope?.includes("[g-parent]") === false,
);
const prefixed = await list("list provider/model-b");
check(
	"a provider prefix resolves the way the model branch does",
	prefixed?.includes("[b-all]") === true,
);
check("an unknown scope prints nothing", (await list("list nope")) === null);
check(
	"and is answered with the valid scopes",
	notices[0]?.text.includes("model-a") === true &&
		notices[0]?.text.includes("subagent") === true &&
		notices[0]?.text.includes('"nope"') === true,
	notices[0]?.text,
);
check("as an error, not as a notice", notices[0]?.level === "error");

console.log("the audience list the tools declare");
const property = (tool: string, name: string): unknown => {
	const parameters = rec.tools.get(tool)?.parameters as
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
		(rec.tools.get("canon_add")?.parameters as { required?: string[] } | undefined)?.required ?? []
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

console.log("the shape a tool writes to the store");
const toolCtx = { sessionManager: { getSessionId: () => "probe" } };
const properties = (tool: string): Record<string, unknown> =>
	(rec.tools.get(tool)?.parameters as { properties?: Record<string, unknown> } | undefined)
		?.properties ?? {};
check("canon_add declares no reason parameter", !("reason" in properties("canon_add")));
check("canon_edit declares no reason parameter", !("reason" in properties("canon_edit")));
check("canon_remove declares no reason parameter", !("reason" in properties("canon_remove")));
check(
	"canon_category declares no description parameter",
	!("description" in properties("canon_category")),
);
await rec.tools
	.get("canon_category")
	?.execute?.("probe-category", { op: "add", title: "PROBE-CAT" }, undefined, undefined, toolCtx);
const afterCategory = JSON.parse(readFileSync(storePath, "utf8")) as {
	categories: Array<Record<string, unknown>>;
};
const category = (afterCategory.categories.at(-1) ?? {}) as Record<string, unknown>;
check(
	"a stored category carries its id and its title and nothing else",
	JSON.stringify(Object.keys(category).sort()) === JSON.stringify(["id", "title"]),
	JSON.stringify(Object.keys(category)),
);
await rec.tools
	.get("canon_add")
	?.execute?.(
		"probe-add",
		{ text: "PROBE-LINE", model: "global", audience: "all", category: String(category.id) },
		undefined,
		undefined,
		toolCtx,
	);
const afterAdd = JSON.parse(readFileSync(storePath, "utf8")) as {
	entries: Array<Record<string, unknown>>;
};
const entry = (afterAdd.entries.at(-1) ?? {}) as Record<string, unknown>;
check(
	"a stored entry carries its id, text, scope and category and nothing else",
	JSON.stringify(Object.keys(entry).sort()) ===
		JSON.stringify(["audience", "category", "id", "model", "text"]),
	JSON.stringify(Object.keys(entry)),
);

console.log("a reason already in the store");
mkdirSync(storeDir, { recursive: true });
writeFileSync(
	storePath,
	JSON.stringify({
		entries: [
			...ENTRIES,
			{
				id: "r-retired",
				text: "RETIRED-SENTINEL",
				model: "global",
				audience: "all",
				reason: "REASON-SENTINEL",
				category: "sentinel-cat",
			},
		],
		categories: [
			{ id: "sentinel-cat", title: "SENTINEL-CAT", description: "DESCRIPTION-SENTINEL" },
		],
	}),
);
const withRetired = await list("list");
check("the entry itself is rendered", withRetired?.includes("RETIRED-SENTINEL") === true);
check("its stored reason is never printed", withRetired?.includes("REASON-SENTINEL") === false);
check(
	"and no category description is printed beside it",
	withRetired?.includes("DESCRIPTION-SENTINEL") === false,
);
await rec.tools
	.get("canon_add")
	?.execute?.(
		"probe-add-2",
		{ text: "PROBE-LINE-2", model: "global", audience: "all", category: "sentinel-cat" },
		undefined,
		undefined,
		toolCtx,
	);
const afterSave = readFileSync(storePath, "utf8");
check(
	"the next save writes the store without either retired field",
	!afterSave.includes("REASON-SENTINEL") && !afterSave.includes("DESCRIPTION-SENTINEL"),
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
