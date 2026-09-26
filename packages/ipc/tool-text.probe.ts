/**
 * tool-text.probe — the standing-text budget and tool-surface probe for `ipc`.
 *
 * Run: `node --experimental-strip-types tool-text.probe.ts` from `packages/ipc`.
 *
 * A tool's standing text is paid by every request of every session that loads the package, so
 * the surface is budgeted rather than reviewed: description + prompt snippet + parameter
 * descriptions ≤ 1,500 literal characters, against the 4,262 the surface it replaces carried.
 * The probe measures the tool the entry actually registers — it runs the factory against a
 * recorder and reads what came back — so the number cannot drift while the file it measures
 * changes shape around it. It also pins the surface itself: exactly one tool, four actions, four
 * parameters, no polling action, and no prompt guidelines (they would add standing text outside
 * the budget).
 *
 * `XDG_RUNTIME_DIR` is pointed at a scratch directory before the factory runs, so nothing the
 * entry touches can reach the machine's real transport, and no session start is fired: the
 * entry registers its tool and installs its bus registry, and nothing writes a presence record.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** The budget: description + snippet + parameter descriptions, in literal characters. */
const BUDGET = 1500;

/** What the surface this package replaces was measured at, for the report line. */
const REPLACED_SURFACE = 4262;

/** The four actions the plan keeps, and nothing else. */
const ACTIONS = ["ask", "broadcast", "list", "send"];

/** The four parameters, and nothing else. */
const PARAMETERS = ["action", "answerTo", "message", "to"];

interface RecordedTool {
	name?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: unknown[];
	parameters?: { properties?: Record<string, { description?: string }>; required?: string[] };
}

const runtime = mkdtempSync(join(tmpdir(), "pi-ipc-probe-"));
process.env.XDG_RUNTIME_DIR = runtime;

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

const registered: RecordedTool[] = [];
const emitted: Array<{ channel: string; data: unknown }> = [];
const sent: unknown[] = [];
const events: string[] = [];

const recorder = {
	registerTool: (tool: RecordedTool) => registered.push(tool),
	events: {
		on: (channel: string) => events.push(`on:${channel}`),
		emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
	},
	sendMessage: (...args: unknown[]) => sent.push(args),
	getSessionName: () => "ipc-probe",
	on: (event: string) => events.push(`pi.on:${event}`),
};

const entry = (await import("./index.ts")).default;
entry(recorder as unknown as ExtensionAPI);

console.log("the registered surface");
check("exactly one tool is registered", registered.length === 1, `${registered.length} tool(s)`);
const tool = registered[0];
check("the tool is named ipc", tool?.name === "ipc", String(tool?.name));

const properties = tool?.parameters?.properties ?? {};
const names = Object.keys(properties).sort();
check(
	"the parameters are action, answerTo, message and to",
	names.join("|") === [...PARAMETERS].sort().join("|"),
	names.join(", "),
);
check(
	"action is the only required parameter",
	(tool?.parameters?.required ?? []).join("|") === "action",
	(tool?.parameters?.required ?? []).join(", "),
);

const actionSchema = (properties.action ?? {}) as { anyOf?: unknown[]; enum?: unknown[] };
const actionValues = (actionSchema.anyOf ?? actionSchema.enum ?? [])
	.map((entryValue) =>
		typeof entryValue === "object" && entryValue !== null && "const" in entryValue
			? (entryValue as { const: unknown }).const
			: entryValue,
	)
	.sort();
check(
	"the actions are ask, broadcast, list and send — no polling action",
	actionValues.join("|") === ACTIONS.join("|"),
	actionValues.join(", "),
);
check(
	"no prompt guidelines add text outside the budget",
	(tool?.promptGuidelines ?? []).length === 0,
);

console.log("the registration handshake");
check(
	"the bus register channel is listened for under the contract name",
	events.includes("on:intercom:extension-register"),
	events.filter((event) => event.startsWith("on:")).join(", "),
);
check(
	"the registry-ready channel is emitted under the contract name",
	emitted.some((entryValue) => entryValue.channel === "intercom:extension-registry-ready"),
	emitted.map((entryValue) => entryValue.channel).join(", "),
);
check(
	"the extension registers no other tool and sends nothing at load",
	sent.length === 0,
	`${sent.length} message(s)`,
);

console.log("the standing text");
const description = tool?.description ?? "";
const snippet = tool?.promptSnippet ?? "";
const parameterText = Object.values(properties).map((property) => property.description ?? "");
const parameterTotal = parameterText.reduce((total, text) => total + text.length, 0);
const total = description.length + snippet.length + parameterTotal;

check("the tool has a description", description.length > 0, `${description.length} chars`);
check("the tool has a prompt snippet", snippet.length > 0, `${snippet.length} chars`);
check(
	"every parameter carries a description",
	parameterText.every((text) => text.length > 0),
	parameterText.map((text) => text.length).join(", "),
);
console.log(
	`  measured: description ${description.length} + snippet ${snippet.length} + parameters ${parameterTotal} = ${total} literal characters`,
);
console.log(`  budget: ${BUDGET}; the replaced surface: ${REPLACED_SURFACE}`);
check(`the standing text is within ${BUDGET} characters`, total <= BUDGET, String(total));

rmSync(runtime, { recursive: true, force: true });
console.log("");

if (failures > 0) {
	console.error(`tool-text probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`tool-text probe passed: ${checks} checks, ${total} of ${BUDGET} characters`);
