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
 * depends on; byte stability across two renders and across two sessions; and an
 * empty store.
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

/**
 * One session: the three markers are cleared first, so a session cannot inherit
 * another's audience, then the extension is handed a recorder. The driver awaits the
 * handler, which is async, and returns the appended block without its base.
 */
function session(env: Record<string, string>): Render {
	for (const key of ["PI_SUBAGENT", "PI_SUBAGENT_CHILD", "PI_FOREMAN", "PI_MODEL"]) {
		delete process.env[key];
	}
	for (const [key, value] of Object.entries(env)) process.env[key] = value;

	const handlers = new Map<string, Handler>();
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: () => {},
		registerCommand: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		appendEntry: () => {},
		events: { on: () => {}, emit: () => {} },
	};
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
