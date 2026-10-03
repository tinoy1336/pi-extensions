/**
 * index.probe — the executable probe for the child request record.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/child-request-dump`.
 *
 * This package exists to record ONE property of a request — whether every result
 * answers a call the preceding assistant declared — so the record is only as good as
 * the scan behind it. A wrong scan reports an orphan where the sequence is legal (a
 * false defect that reads like a provider bug) or misses the one that is illegal.
 * Nothing is exported, so the probe drives the extension the way pi does: a recorder
 * captures the `before_provider_request` handler, which is handed a payload and writes
 * its row asynchronously.
 *
 * `PI_CHILD_REQUEST_DUMP` points at a scratch file, so the machine's own record is
 * never appended to, and the child markers are set before the factory runs because
 * nothing is registered without them.
 *
 * Cases: a clean run, the two conditions the record separates (an orphan, and a
 * result whose call belongs to an earlier assistant), two calls answered in one run,
 * a result carrying no id, the promise that no content is recorded, a payload that is
 * not a message list, and a parent process that registers nothing.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-child-dump-probe-"));
process.env.HOME = scratch;
process.env.XDG_STATE_HOME = join(scratch, "state");
const dumpPath = join(scratch, "child-request-dump.jsonl");
process.env.PI_CHILD_REQUEST_DUMP = dumpPath;
process.env.PI_SUBAGENT_CHILD = "1";

const { default: childRequestDump } = await import("./index.ts");

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
type Message = Record<string, unknown>;

const assistant = (...ids: string[]): Message => ({
	role: "assistant",
	tool_calls: ids.map((id) => ({ id })),
});
const result = (id: string | null): Message =>
	id === null
		? { role: "tool", content: [{ type: "toolResult" }] }
		: { role: "tool", tool_call_id: id };

/** A recorder, and the handler it captured. */
function recorder(): Handler | undefined {
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
	childRequestDump(api as never);
	return handlers.get("before_provider_request");
}

const registered = recorder();
if (!registered) throw new Error("the extension registered no before_provider_request handler");
const onRequest: Handler = registered;

/** Rows already on disk, so each case can read only what it wrote. */
function rows(): Record<string, unknown>[] {
	if (!existsSync(dumpPath)) return [];
	return readFileSync(dumpPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Drive one request and wait for its row, which is written asynchronously. */
async function dump(
	messages: Message[],
	model = "probe-model",
): Promise<Record<string, unknown> | null> {
	const before = rows().length;
	onRequest(
		{ payload: { messages, model } },
		{ sessionManager: { getSessionId: () => "probe-session" } },
	);
	for (let waited = 0; waited < 2_000; waited += 25) {
		const all = rows();
		if (all.length > before) return all[all.length - 1] ?? null;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return null;
}

type Entry = {
	i: number;
	r: string;
	tc?: number;
	ids?: string[];
	paired?: number[];
	id?: string | null;
	after?: number;
	ok?: boolean;
	prev?: boolean;
};

const entries = (row: Record<string, unknown> | null): Entry[] => (row?.msgs as Entry[]) ?? [];
/** The entry for the message at `i`: only assistant and tool messages get one. */
const at = (row: Record<string, unknown> | null, i: number): Entry | undefined =>
	entries(row).find((entry) => entry.i === i);

console.log("a run the provider accepts");
const clean = await dump([assistant("A"), result("A")]);
check("a row is written", clean !== null);
check("the request's message count is recorded", clean?.n === 2, String(clean?.n));
check(
	"one call and one result",
	clean?.calls === 1 && clean?.results === 1,
	`${clean?.calls}/${clean?.results}`,
);
check(
	"it reports no orphans",
	JSON.stringify(clean?.orphans) === "[]",
	JSON.stringify(clean?.orphans),
);
check("and nothing late", JSON.stringify(clean?.late) === "[]", JSON.stringify(clean?.late));
check(
	"the roles are in order",
	JSON.stringify(clean?.roles) === JSON.stringify(["assistant", "tool"]),
);
check(
	"the result is paired with the run above it",
	at(clean, 1)?.ok === true && at(clean, 1)?.prev === true,
);
check(
	"the assistant's entry lists the result that answers it",
	JSON.stringify(at(clean, 0)?.paired) === "[1]",
);
check("the result names the assistant it follows", at(clean, 1)?.after === 0);
check("the model is recorded", clean?.model === "probe-model");
check(
	"the origin is one of the two states",
	clean?.origin === "prompt" || clean?.origin === "injected",
);

console.log("a result no preceding assistant declares");
const orphan = await dump([{ role: "user", content: "hello" }, result("X")]);
check(
	"it is reported as an orphan",
	JSON.stringify(orphan?.orphans) === JSON.stringify([{ i: 1, id: "X" }]),
	JSON.stringify(orphan?.orphans),
);
check("and not as late", JSON.stringify(orphan?.late) === "[]");
check(
	"its entry is unpaired on both counts",
	at(orphan, 1)?.ok === false && at(orphan, 1)?.prev === false,
);
check("a result before any assistant follows none", at(orphan, 1)?.after === -1);

console.log("a result whose call belongs to an earlier assistant");
const late = await dump([assistant("A"), result("A"), assistant("B"), result("A")]);
check(
	"it is reported as late, not as an orphan",
	JSON.stringify(late?.late) === JSON.stringify([{ i: 3, id: "A" }]),
	JSON.stringify(late?.late),
);
check("because a preceding assistant does declare it", at(late, 3)?.prev === true);
check("but the assistant directly above it does not", at(late, 3)?.ok === false);
check("the run it belongs to is named", at(late, 3)?.after === 2);

console.log("two calls answered in one run");
const two = await dump([assistant("A", "B"), result("A"), result("B")]);
check("both calls are counted", two?.calls === 2);
check("and both results", two?.results === 2);
check("the assistant declares how many it carries", at(two, 0)?.tc === 2);
check("and lists both answers", JSON.stringify(at(two, 0)?.paired) === "[1,2]");
check("nothing is orphaned", JSON.stringify(two?.orphans) === "[]");

console.log("a result carrying no id");
const noId = await dump([assistant("A"), result(null)]);
check(
	"it is an orphan with a null id",
	JSON.stringify(noId?.orphans) === JSON.stringify([{ i: 1, id: null }]),
	JSON.stringify(noId?.orphans),
);
check("its entry carries a null id too", at(noId, 1)?.id === null);

console.log("no content is recorded");
const SENTINEL = "PROMPT-TEXT-MUST-NEVER-BE-RECORDED";
const secretive = await dump([
	{ role: "user", content: SENTINEL },
	assistant("A"),
	{ role: "tool", tool_call_id: "A", content: [{ type: "toolResult", text: SENTINEL }] },
]);
const raw = readFileSync(dumpPath, "utf8");
check("the request text never reaches the record", !raw.includes(SENTINEL));
check(
	"no message content key is written",
	secretive !== null && !Object.hasOwn(secretive, "content") && !Object.hasOwn(secretive, "text"),
);
const documented = [
	"ts",
	"pid",
	"sess",
	"run",
	"req",
	"origin",
	"model",
	"n",
	"calls",
	"results",
	"orphans",
	"late",
	"roles",
	"msgs",
];
check(
	"the record holds exactly the documented keys",
	Object.keys(secretive ?? {})
		.sort()
		.join(",") === [...documented].sort().join(","),
	Object.keys(secretive ?? {})
		.sort()
		.join(","),
);

console.log("a payload that is not a message list");
const before = rows().length;
onRequest({ payload: { model: "probe-model" } }, {});
await new Promise((resolve) => setTimeout(resolve, 100));
check("nothing is recorded for it", rows().length === before, `${rows().length} rows`);

console.log("a parent session");
for (const key of ["PI_SUBAGENT_CHILD", "PI_SUBAGENT"]) delete process.env[key];
const parentHandler = recorder();
check("a parent process registers no handler at all", parentHandler === undefined);

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`child-request-dump probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`child-request-dump probe passed: ${checks} checks`);
