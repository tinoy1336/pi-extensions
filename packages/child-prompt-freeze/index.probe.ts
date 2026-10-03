/**
 * index.probe — the executable probe for the child prompt freeze.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/child-prompt-freeze`.
 *
 * A child session's system prompt is rewritten by the launch path, and a run started
 * by an injected message carries the base prompt instead — inside the cached prefix,
 * so the whole conversation is re-billed. The extension pins the bytes it observed on
 * a prompt-path run and restores them, and its own guarantee is that restoring an
 * already-canonical prompt is a no-op. That is the property this probe pins: it counts
 * WRITES to the payload's own slot through a proxy, so "changed nothing" is asserted as
 * zero assignments rather than as an equal string.
 *
 * `HOME` points at a scratch directory before the module is imported, because a repair
 * writes a diagnostics row. Cases: a parent session registering nothing, the adoption
 * of the prompt-path bytes, the restore of an injected run, the second pass changing
 * nothing, a wake-first child that has adopted nothing yet, and the restore through the
 * second payload shape the seam covers.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-child-freeze-probe-"));
process.env.HOME = scratch;
process.env.PI_SUBAGENT_CHILD = "1";

const { default: childPromptFreeze } = await import("./index.ts");

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

/** One extension instance, with the handlers it registered and its own state. */
function instance(env: Record<string, string>): {
	start?: Handler;
	request?: Handler;
	writes: string[];
	payload: (text: string) => { payload: unknown; text: () => string };
} {
	for (const key of ["PI_SUBAGENT", "PI_SUBAGENT_CHILD"]) delete process.env[key];
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
	childPromptFreeze(api as never);

	const writes: string[] = [];
	/** The openai-completions shape, with the first message's writes recorded. */
	const payload = (text: string) => {
		const first = new Proxy(
			{ role: "system", content: text },
			{
				set(target, property, value) {
					if (property === "content") writes.push(String(value));
					(target as Record<string, unknown>)[property as string] = value;
					return true;
				},
			},
		);
		const envelope = { messages: [first] };
		return { payload: envelope, text: () => first.content as string };
	};

	return {
		start: handlers.get("before_agent_start"),
		request: handlers.get("before_provider_request"),
		writes,
		payload,
	};
}

console.log("a parent session");
const parent = instance({});
check("registers no handler at all", parent.start === undefined && parent.request === undefined);

console.log("a child session");
const child = instance({ PI_SUBAGENT_CHILD: "1" });
if (!child.start || !child.request) throw new Error("a child registered no handlers");
const start: Handler = child.start;
const request: Handler = child.request;

const adopted = child.payload("REWRITTEN-BUILD");
start({});
request({ payload: adopted.payload });
check(
	"a prompt-path run adopts the bytes it produced",
	child.writes.length === 0,
	child.writes.join(" | "),
);
check("and the text is untouched", adopted.text() === "REWRITTEN-BUILD");

const injected = child.payload("BASE-PROMPT");
request({ payload: injected.payload });
check(
	"an injected run is restored to the adopted bytes",
	injected.text() === "REWRITTEN-BUILD",
	injected.text(),
);
check("which took exactly one write", child.writes.length === 1, `${child.writes.length} writes`);

const again = child.payload("REWRITTEN-BUILD");
request({ payload: again.payload });
check(
	"a second pass over canonical bytes writes nothing",
	child.writes.length === 1,
	`${child.writes.length} writes`,
);
request({ payload: again.payload });
check(
	"and a third writes nothing either",
	child.writes.length === 1,
	`${child.writes.length} writes`,
);

const adoptedAgain = child.payload("REWRITTEN-BUILD");
start({});
request({ payload: adoptedAgain.payload });
check(
	"the prompt path re-adopting identical bytes changes nothing",
	child.writes.length === 1,
	`${child.writes.length} writes`,
);

const refreshed = child.payload("REWRITTEN-AGAIN");
start({});
request({ payload: refreshed.payload });
check(
	"a prompt-path run adopting NEW bytes does not write either",
	child.writes.length === 1,
	`${child.writes.length} writes`,
);
const afterRefresh = child.payload("BASE-PROMPT");
request({ payload: afterRefresh.payload });
check(
	"and the newest bytes are the ones restored afterwards",
	afterRefresh.text() === "REWRITTEN-AGAIN",
	afterRefresh.text(),
);

console.log("a wake-first child");
const woken = instance({ PI_SUBAGENT: "1" });
if (!woken.request) throw new Error("a child registered no request handler");
const wokenRequest: Handler = woken.request;
const firstRequest = woken.payload("WHATEVER-ARRIVED");
wokenRequest({ payload: firstRequest.payload });
check("nothing is pinned yet, so nothing is rewritten", firstRequest.text() === "WHATEVER-ARRIVED");
check("and nothing was written", woken.writes.length === 0, woken.writes.join(" | "));

console.log("the other payload shape");
const topLevel = { system: "BASE-PROMPT" };
request({ payload: topLevel });
check(
	"a top-level system string is restored too",
	topLevel.system === "REWRITTEN-AGAIN",
	topLevel.system,
);

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`child-prompt-freeze probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`child-prompt-freeze probe passed: ${checks} checks`);
