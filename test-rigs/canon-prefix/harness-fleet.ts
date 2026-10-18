/**
 * harness-fleet.ts — the foreman tool-set invariant.
 *
 * Foreman mode restricts a session to FOREMAN_TOOLS. The tools array precedes the
 * messages in the cached prefix, so the set has to be the SAME set on every request:
 * one tool too few or too many rewrites the head of the payload and re-bills the
 * conversation behind it. Three things can move it, and one arm each:
 *
 *   activation — the set applied at `session_start` is exactly FOREMAN_TOOLS;
 *   strays     — a tool outside the definition is swept at the next tool call, and a
 *                member of the definition that registers LATE is kept, because the
 *                definition is frozen rather than the activation snapshot
 *                (`subagent_supervisor` registers after activation in a real process);
 *   the wire   — `before_provider_request` sends the definition and nothing else, so a
 *                stray that is briefly in the active set never reaches the model.
 *
 * The harness drives the REAL fleet package from the source rig.ts selects, against
 * a fake pi whose tool set is real (getAllTools/getActiveTools/setActiveTools over one
 * array). There is no mutation arm: the invariant has one shape, and every arm below
 * fails if the set drifts.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import {
	createChecker,
	emitEvent,
	finish,
	loadFleet,
	loadFleetMode,
	runPath,
	setSessionShape,
} from "./rig.ts";

setSessionShape("parent");
// The launcher's own activation contract, and the shape every crew worker runs in.
process.env.PI_FOREMAN = "1";
// fleet keeps its roster, mode file and ledgers under $HOME/.local/pi/foreman. Point
// HOME at this run's own dir BEFORE the package loads, so a rig run can never read or
// write the real store.
const SCRATCH_HOME = runPath("home");
process.env.HOME = SCRATCH_HOME;
mkdirSync(SCRATCH_HOME, { recursive: true });

const mode = await loadFleetMode();
const fleet = await loadFleet();
const FOREMAN_TOOLS: string[] = [...(mode.FOREMAN_TOOLS as readonly string[])];

// The member withheld from the registry until after activation. A real process does this
// to at least one of the fourteen: the tool's own extension registers it from a handler
// that runs after `session_start`, and the definition rather than the snapshot is what
// keeps it admissible.
const LATE = FOREMAN_TOOLS.includes("subagent_supervisor")
	? "subagent_supervisor"
	: FOREMAN_TOOLS[FOREMAN_TOOLS.length - 1];
// Registered from the start, and outside the definition: the sweep must remove it.
const STRAY = "ctx_probe";
const STRAY_SNIPPET = `Operate ${STRAY}.`;
// Registered from the start and inside the definition: it must never be swept. Without a
// member in this arm, the sweep could pass by removing nothing at all.
const MEMBER = FOREMAN_TOOLS.find((n) => n !== LATE) as string;

// ── a fake pi whose tool set is real ────────────────────────────────────────────
type FakeTool = { name: string; description: string; parameters: unknown; promptSnippet?: string };
const registry = new Map<string, FakeTool>();
const active: string[] = [];
const handlers: Record<string, Array<(event: any, ctx: any) => unknown>> = {};
const register = (name: string, promptSnippet?: string): void => {
	registry.set(name, {
		name,
		description: `${name} tool`,
		parameters: {},
		...(promptSnippet ? { promptSnippet } : {}),
	});
};
for (const name of FOREMAN_TOOLS) {
	if (name !== LATE) register(name, `Operate ${name}.`);
}
register(STRAY, STRAY_SNIPPET);

const api = {
	on(ev: string, h: (event: any, ctx: any) => unknown): void {
		if (!handlers[ev]) handlers[ev] = [];
		handlers[ev].push(h);
	},
	registerTool(tool: FakeTool): void {
		registry.set(tool.name, tool);
	},
	registerCommand(): void {},
	events: { on(): void {}, emit(): void {} },
	getSessionName: () => "rig",
	sendMessage(): void {},
	appendEntry(): void {},
	getActiveTools: () => [...active],
	setActiveTools(names: string[]): void {
		// pi keeps exactly the order it is handed and does not de-duplicate, so the fake must
		// not either.
		active.length = 0;
		for (const n of names) if (registry.has(n)) active.push(n);
	},
	getAllTools: () => [...registry.values()].map((t) => ({ name: t.name })),
	exec: async () => ({ stdout: "", stderr: "", code: 0 }),
};
const ctx = {
	model: { id: "deepseek-flash" },
	cwd: process.cwd(),
	sessionManager: {
		getSessionId: () => "01a0972c-c592-73c0",
		getSessionFile: () => undefined,
		buildContextEntries: () => [],
	},
	ui: { notify(): void {} },
};
const emit = (ev: string, event: unknown) => emitEvent(handlers, ev, event, ctx);

fleet.default(api);

const { check, count } = createChecker();

/** pi's own rendering rule: one bullet per selected tool that carries a snippet. */
const renderTools = (names: readonly string[]): string =>
	names
		.filter((n) => registry.get(n)?.promptSnippet)
		.map((n) => `- ${n}: ${registry.get(n)?.promptSnippet}`)
		.join("\n");

// ── 1. activation applies the definition ────────────────────────────────────────
await emit("session_start", {});
const expectedAtActivation = FOREMAN_TOOLS.filter((n) => n !== LATE);
check(
	"activation applied every member registered at the time",
	expectedAtActivation.every((n) => active.includes(n)),
	`active=${active.length} of ${expectedAtActivation.length}`,
);
check(
	"activation applied nothing outside the definition",
	active.every((n) => FOREMAN_TOOLS.includes(n)),
	`outside=${active.filter((n) => !FOREMAN_TOOLS.includes(n)).join(",") || "(none)"}`,
);
check(
	"activation wrote its state under the scratch HOME, never the real store",
	existsSync(runPath("home/.local/pi/foreman/roster")) &&
		readdirSync(runPath("home/.local/pi/foreman/roster")).some((f) => f.startsWith("mode-")),
	`home=${SCRATCH_HOME}`,
);

// ── 2. a member that registers late is not swept ────────────────────────────────
register(LATE, `Operate ${LATE}.`);
api.setActiveTools([...active, LATE]);
await emit("tool_call", { toolName: MEMBER, input: {} }, ctx);
check(
	"a member that registered after activation survives the sweep",
	active.includes(LATE),
	`${LATE} present=${active.includes(LATE)}`,
);

// ── 3. a stray is swept, and a member is not ────────────────────────────────────
const sectionBeforeStray = renderTools(active.filter((n) => n !== STRAY));
api.setActiveTools([...active, STRAY]);
check("the stray is present before the sweep", active.includes(STRAY));
await emit("tool_call", { toolName: MEMBER, input: {} }, ctx);
check(
	"a stray is swept at the next tool call",
	!active.includes(STRAY),
	`stray present=${active.includes(STRAY)}`,
);
check("a member is not swept with it", active.includes(MEMBER), `member=${MEMBER}`);
check(
	"the sweep does not change the rendered tools section",
	renderTools(active) === sectionBeforeStray,
	`typed=${sectionBeforeStray.length} after=${renderTools(active).length}`,
);

// ── 4. the wire carries the definition and nothing else ─────────────────────────
const payload = {
	model: "deepseek-flash",
	messages: [{ role: "system", content: "RIG-BASE" }],
	// Deliberately wider than the active set: a stray that arrived and was swept between
	// two requests must not ride out on the payload of the first one.
	tools: [...active, STRAY].map((name) => ({ type: "function", function: { name } })),
};
await emit("before_provider_request", { payload }, ctx);
const wire = (payload.tools as { function: { name: string } }[]).map((t) => t.function.name);
check("the wire drops the stray", !wire.includes(STRAY), `wire=${wire.length}`);
check(
	"the wire keeps every member",
	wire.includes(MEMBER) && wire.includes(LATE),
	`wire=${wire.length}`,
);
check(
	"the wire keeps the definition's order",
	wire.join(",") === active.filter((n) => FOREMAN_TOOLS.includes(n)).join(","),
	`wire=${wire.length} active=${active.length}`,
);

console.log(`\nlate=${LATE} stray=${STRAY} active=${active.length} wire=${wire.length}`);
finish("FLEET", count());
