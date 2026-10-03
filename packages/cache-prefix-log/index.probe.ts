/**
 * index.probe — the executable probe for the prompt-cache prefix log.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/cache-prefix-log`.
 *
 * The log exists so the next cache miss can be NAMED without a payload dump, so what it
 * records, when it stays quiet, and what it must never contain are all contract. A
 * logger that wrote a row per request would flood the file; one that missed the
 * baseline would have nothing to diff against; one that leaked message text would put
 * the conversation on disk; and the run-start attribution (`origin`) is the whole
 * reason an injected-turn miss is legible at all. No workspace gate reads any of it.
 *
 * `PI_CACHE_PREFIX_LOG` points at a scratch file and `XDG_STATE_HOME` at a scratch
 * directory before the module is imported, so the machine's own log is never appended.
 *
 * Cases: the baseline row and its counts, a repeat that writes nothing, a system-prompt
 * change with its delta, a tools-array change with the names that entered, the
 * prompt-versus-injected attribution, the announced canon sections, and the absence of
 * any system or message content in what is written.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-cache-prefix-probe-"));
process.env.XDG_STATE_HOME = scratch;
const logPath = join(scratch, "prefix.jsonl");
process.env.PI_CACHE_PREFIX_LOG = logPath;

const SESSION = "01a0d1d3-1111-2222-3333-444444444444";
const SECRET = "PROMPT-TEXT-THAT-MUST-NOT-BE-LOGGED";

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
const bus = new Map<string, Array<(payload: unknown) => void>>();
const api = {
	on: (event: string, handler: Handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	events: {
		on: (channel: string, handler: (payload: unknown) => void) => {
			const list = bus.get(channel) ?? [];
			list.push(handler);
			bus.set(channel, list);
		},
	},
};

const { default: cachePrefixLog } = await import("./index.ts");
cachePrefixLog(api as never);

const ctx = { sessionManager: { getSessionId: () => SESSION } };

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

/** Rows written so far; the file is absent until the first append lands. */
function rows(): Array<Record<string, unknown>> {
	try {
		return readFileSync(logPath, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

/** One request through the extension's own hook, then the macrotask it writes on. */
async function request(payload: Record<string, unknown>): Promise<void> {
	for (const handler of handlers.get("before_provider_request") ?? []) handler({ payload }, ctx);
	await new Promise((resolve) => setTimeout(resolve, 60));
}

function fire(event: string): void {
	for (const handler of handlers.get(event) ?? []) handler({}, ctx);
}

const tools = (names: string[]): unknown[] => names.map((name) => ({ function: { name } }));
const payload = (system: string, names: string[]): Record<string, unknown> => ({
	system,
	messages: [{ role: "user", content: "hi" }],
	tools: tools(names),
});

console.log("the baseline");
await request(payload(SECRET, ["read", "bash"]));
const first = rows()[0];
check("a first request writes one row", rows().length === 1, `${rows().length} row(s)`);
check(
	"it is the baseline",
	first?.why === "baseline" &&
		Array.isArray(first?.changed) &&
		(first.changed as string[]).includes("baseline"),
);
check("with the full session id", first?.sess === SESSION, String(first?.sess));
check("the system-prompt size it saw", first?.sysChars === SECRET.length, String(first?.sysChars));
check(
	"the tool names it saw",
	JSON.stringify(first?.toolNames) === JSON.stringify(["read", "bash"]),
	JSON.stringify(first?.toolNames),
);
check(
	"and the prefix size is system plus tools",
	first?.prefixChars === (first?.sysChars as number) + (first?.toolsChars as number),
	`${first?.sysChars}+${first?.toolsChars} != ${first?.prefixChars}`,
);
check("with the emitting pid", first?.pid === process.pid);
check(
	"and no system or message text in the row",
	!JSON.stringify(first).includes(SECRET) && !JSON.stringify(first).includes('"hi"'),
	JSON.stringify(first).slice(0, 80),
);

console.log("the quiet case and the two changes");
await request(payload(SECRET, ["read", "bash"]));
check("an unchanged prefix writes nothing", rows().length === 1, `${rows().length} row(s)`);

await request(payload(`${SECRET} (moved)`, ["read", "bash"]));
const sysRow = rows()[1];
check("a moved system prompt writes a row", rows().length === 2, `${rows().length} row(s)`);
check(
	"naming sys as what changed",
	JSON.stringify(sysRow?.changed) === JSON.stringify(["sys"]),
	JSON.stringify(sysRow?.changed),
);
check(
	"and how far it moved",
	sysRow?.sysDeltaChars === " (moved)".length,
	String(sysRow?.sysDeltaChars),
);

await request(payload(`${SECRET} (moved)`, ["read", "bash", "grep"]));
const toolsRow = rows()[2];
check("a changed tools array writes a row", rows().length === 3, `${rows().length} row(s)`);
check(
	"naming tools as what changed",
	JSON.stringify(toolsRow?.changed) === JSON.stringify(["tools"]),
	JSON.stringify(toolsRow?.changed),
);
check(
	"and the name that entered",
	JSON.stringify(toolsRow?.added) === JSON.stringify(["grep"]),
	JSON.stringify(toolsRow?.added),
);
check(
	"with nothing reported as removed",
	JSON.stringify(toolsRow?.removed) === JSON.stringify([]),
	JSON.stringify(toolsRow?.removed),
);

console.log("the run-start attribution");
await request(payload(`${SECRET} (moved) two`, ["read", "bash", "grep"]));
fire("before_agent_start");
fire("agent_start");
await request(payload(`${SECRET} (moved) three`, ["read", "bash", "grep"]));
check(
	"a typed run is attributed to the prompt path",
	rows().at(-1)?.origin === "prompt",
	String(rows().at(-1)?.origin),
);
fire("agent_start");
await request(payload(`${SECRET} (moved) four`, ["read", "bash", "grep"]));
check(
	"a run that skipped that hook is attributed to injection",
	rows().at(-1)?.origin === "injected",
	String(rows().at(-1)?.origin),
);

console.log("the announced sections");
for (const handler of bus.get("canon:sections") ?? []) handler({ ids: ["tools", "canon"] });
await request(payload(`${SECRET} (moved) five`, ["read", "bash", "grep"]));
check(
	"the announced ids are recorded",
	rows().at(-1)?.sections === "canon,tools",
	String(rows().at(-1)?.sections),
);

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`cache-prefix-log probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`cache-prefix-log probe passed: ${checks} checks`);
