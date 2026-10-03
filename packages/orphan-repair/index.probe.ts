/**
 * index.probe — the executable probe for the orphan repair.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/orphan-repair`.
 *
 * This runs over every outbound request and rewrites the message body when the body
 * is one the provider would reject. A wrong decision in either direction is
 * expensive: keeping a dangling result fails the whole request, and dropping a live
 * one costs the model an answer it asked for. The logic is not exported, so the probe
 * drives the extension the way pi does — a recorder captures the
 * `before_provider_request` handler, which mutates the payload in place.
 *
 * `HOME` points at a scratch directory before the module is imported, because a
 * repaired body writes a diagnostics row and the machine's own log is not this
 * probe's business.
 *
 * Cases: a clean body of one and of two runs, the dangling tail result that closed a
 * run, a result before any run, a dangling duplicate replacing the placeholder rather
 * than being dropped beside it, adjacency beating an earlier copy of the same id, the
 * documented no-id carve-out in both run states, a message with no id and no run, a
 * body that is not a message list, and the two id shapes the wire uses.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-orphan-probe-"));
process.env.HOME = scratch;

const { default: orphanRepair } = await import("./index.ts");

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

type Handler = (event: unknown) => unknown;
type Message = Record<string, unknown>;

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
orphanRepair(api as never);

const registered = handlers.get("before_provider_request");
if (!registered) throw new Error("the extension registered no before_provider_request handler");
const handler: Handler = registered;

/** An assistant declaring its tool calls the way the wire does. */
const assistant = (...ids: string[]): Message => ({
	role: "assistant",
	tool_calls: ids.map((id) => ({ id, name: "x" })),
});
/** A result answering an id, or carrying none when the id is null. */
const result = (id: string | null): Message =>
	id === null
		? { role: "tool", content: [{ type: "toolResult", text: "no id" }] }
		: {
				role: "tool",
				tool_call_id: id,
				content: [{ type: "toolResult", toolCallId: id, text: `answer ${id}` }],
			};
const user = (text = "hello"): Message => ({ role: "user", content: text });

/** Send a body through the handler and read the body back. */
function run(messages: Message[]): { messages: Message[]; sameArray: boolean } {
	const original = messages;
	const payload: { messages: unknown } = { messages };
	handler({ payload });
	return { messages: payload.messages as Message[], sameArray: payload.messages === original };
}

console.log("a body the provider accepts is left alone");
const clean = run([assistant("A"), result("A")]);
check("nothing is dropped", clean.messages.length === 2, `${clean.messages.length} messages`);
check("the array is not even replaced", clean.sameArray);
const twoRuns = run([assistant("A"), result("A"), assistant("B"), result("B")]);
check(
	"two complete runs pass through",
	twoRuns.messages.length === 4,
	`${twoRuns.messages.length} messages`,
);

console.log("a result that cannot belong to the open run");
const dangling = run([assistant("A"), result("A"), user(), result("A")]);
check(
	"the dangling tail result is dropped",
	dangling.messages.length === 3,
	`${dangling.messages.length} messages`,
);
check("and the rest of the body survives in order", dangling.messages[2]?.role === "user");
const orphan = run([user(), result("A")]);
check(
	"a result before any run is dropped",
	orphan.messages.length === 1,
	`${orphan.messages.length} messages`,
);
const afterClosed = run([assistant("A"), result("A"), user(), result("B")]);
check("a result for an id nothing declared is dropped", afterClosed.messages.length === 3);

console.log("a dangling duplicate replaces the placeholder");
const placeholder = result("A");
const real = result("A");
const replaced = run([assistant("A"), placeholder, user(), real]);
check(
	"the body is not grown",
	replaced.messages.length === 3,
	`${replaced.messages.length} messages`,
);
check("the earlier copy is replaced in place", replaced.messages[1] === real);
check("the placeholder is gone", replaced.messages.includes(placeholder) === false);

console.log("adjacency beats an earlier copy of the same id");
const firstAnswer = result("A");
const secondAnswer = result("A");
const twoDeclarers = run([assistant("A"), firstAnswer, assistant("A"), secondAnswer]);
check(
	"both runs keep their own answer",
	twoDeclarers.messages.length === 4,
	`${twoDeclarers.messages.length} messages`,
);
check("the first run's answer is untouched", twoDeclarers.messages[1] === firstAnswer);
check("the second run's answer is appended", twoDeclarers.messages[3] === secondAnswer);

console.log("a result that carries no readable id");
check(
	"inside an open run the previous tolerance stands",
	run([assistant("A"), result(null)]).messages.length === 2,
);
check("with no open run it is dropped", run([user(), result(null)]).messages.length === 1);

console.log("a body that is not a message list");
const notAList = { messages: "nope" };
handler({ payload: notAList });
check("a non-array messages value is untouched", notAList.messages === "nope");
const empty = {};
handler({ payload: empty });
check("a payload with no messages is untouched", JSON.stringify(empty) === "{}");
const noPayload = run([assistant("A")]);
check("an assistant with no results passes through", noPayload.messages.length === 1);

console.log("the id shapes the wire uses");
const camel = run([
	{ role: "assistant", toolCalls: [{ id: "C" }] },
	{ role: "tool", content: [{ type: "tool_result", tool_use_id: "C" }] },
] as Message[]);
check("camelCase toolCalls with a tool_result part is kept", camel.messages.length === 2);
const contentPart = run([
	{ role: "assistant", content: [{ type: "toolCall", toolCallId: "D" }] },
	{ role: "tool", tool_call_id: "D" },
] as Message[]);
check(
	"a toolCall content part with a snake_case result is kept",
	contentPart.messages.length === 2,
);

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`orphan-repair probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`orphan-repair probe passed: ${checks} checks`);
