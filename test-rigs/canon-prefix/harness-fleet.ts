/**
 * harness-fleet.ts — the foreman tool-set invariant.
 *
 * pi renders one `- <tool>: <snippet>` bullet per SELECTED tool into the system
 * prompt, and the tools array precedes the messages in the cached prefix. Foreman
 * mode restricts a session to FOREMAN_TOOLS, while another extension re-adds its
 * loader (a `*_enable` tool) at the start of every run. If fleet's drift handler
 * sweeps that loader away, the set the NEXT run renders from no longer matches what
 * the previous run sent, the head of the system prompt moves, and everything behind
 * it re-bills.
 *
 * The harness drives the REAL fleet package from the source rig.ts selects, against
 * a fake pi whose tool set is real (getAllTools/getActiveTools/setActiveTools over one
 * array), and models the two run shapes pi actually has:
 *
 *   typed — before_agent_start runs; an extension that edited the run's
 *           `systemPromptOptions.selectedTools` wins over the live set;
 *   wake  — no before_agent_start (an injected message), so the live set renders.
 *
 * Both must render the same tools section.
 *
 * RIG_MUTATE=loader-name renames the stub loader to a name WITHOUT the `_enable`
 * suffix, which is exactly the coupling of this exemption: the loader is swept again
 * and the wake renders one bullet fewer. A default run must be green; a mutated run
 * must be red.
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

const MUTATE = process.env.RIG_MUTATE ?? "";
if (MUTATE !== "" && MUTATE !== "loader-name") {
	console.error(`\nRIG ABORT: unknown RIG_MUTATE ${JSON.stringify(MUTATE)} for harness-fleet.`);
	process.exit(2);
}
const LOADER = MUTATE === "loader-name" ? "probe_tools" : "probe_enable";
const LOADER_SNIPPET = `pi-subagents is installed. ${"x".repeat(200)}`;
// The second loader is the OTHER shape a real one arrives in: pi-web-access never touches
// the run's selection, it only re-adds itself to the live set in `before_agent_start`, and
// pi then copies `getActiveToolNames()` into `selectedTools` because no handler edited it.
const LOADER2 = "probe2_enable";
const LOADER2_SNIPPET = `pi-web-access is configured. ${"y".repeat(120)}`;

const mode = await loadFleetMode();
const fleet = await loadFleet();
const FOREMAN_TOOLS: string[] = [...(mode.FOREMAN_TOOLS as readonly string[])];

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
for (const name of FOREMAN_TOOLS) register(name, `Operate ${name}.`);
register(LOADER, LOADER_SNIPPET);
register(LOADER2, LOADER2_SNIPPET);
// A non-loader stray: the sweep must still remove it. Without this the arm cannot tell
// "the exemption works" from "the sweep stopped removing anything", which is the same
// class of defect in the other direction — a stray left selected adds its own bullet.
const STRAY = "ctx_probe";
register(STRAY, `Operate ${STRAY}.`);

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
		// not either: the stubs below guard their own adds the way the real extensions do.
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
// The loader's owning extension, mirroring pi-subagents' real handler: it adds the
// loader to the ACTIVE set AND pushes it into the RUN's selection (its `setSelection`
// does both). Only doing the selectedTools half would test a tool the live set never
// held, which is not the defect this arm exists to catch.
handlers.before_agent_start ??= [];
handlers.before_agent_start.push((event: any) => {
	if (!active.includes(LOADER)) api.setActiveTools([...active, LOADER]);
	const names: string[] = event?.systemPromptOptions?.selectedTools ?? [];
	if (!names.includes(LOADER)) names.push(LOADER);
	return undefined;
});
// The pi-web-access shape: live set only, no selection edit — and the same guard its real
// handler uses before re-adding itself.
handlers.before_agent_start.push(() => {
	if (!active.includes(LOADER2)) api.setActiveTools([...active, LOADER2]);
	return undefined;
});

const { check, count } = createChecker();

/** pi's own rendering rule: one bullet per selected tool that carries a snippet. */
const renderTools = (names: readonly string[]): string =>
	names
		.filter((n) => registry.get(n)?.promptSnippet)
		.map((n) => `- ${n}: ${registry.get(n)?.promptSnippet}`)
		.join("\n");

// ── 1. activation ───────────────────────────────────────────────────────────────
await emit("session_start", {});
check(
	"foreman activation applied the frozen set",
	FOREMAN_TOOLS.every((n) => active.includes(n)),
	`active=${active.length} of ${FOREMAN_TOOLS.length}${active.includes(LOADER) ? " + loader" : ""}`,
);
if (MUTATE !== "loader-name") {
	// The owning extension adds its loader from `session_start` too, and a session whose
	// first run does not carry it renders one prompt while the next renders another. The
	// exempt name must therefore be active BEFORE any run starts — admitted by activation,
	// not by the stub below.
	check(
		"the loader is active before the first run, without the owning extension's help",
		active.includes(LOADER),
	);
}
check(
	"a live-set-only loader is admitted too (the pi-web-access shape)",
	active.includes(LOADER2),
	`${LOADER2} present=${active.includes(LOADER2)}`,
);
check(
	"activation wrote its state under the scratch HOME, never the real store",
	existsSync(runPath("home/.local/pi/foreman/roster")) &&
		readdirSync(runPath("home/.local/pi/foreman/roster")).some((f) => f.startsWith("mode-")),
	`home=${SCRATCH_HOME}`,
);

// ── 2. typed run: the extension's selection edit wins over the live set ─────────
const baseSelected = [...active];
const options = { selectedTools: [...baseSelected] };
await emit("before_agent_start", { systemPrompt: "RIG-BASE", systemPromptOptions: options });
// pi's own rule (agent-session.js): an explicit handler edit wins, otherwise the live set is
// copied in. Modelling both is what lets one run cover both loader shapes.
const edited =
	options.selectedTools.length !== baseSelected.length ||
	options.selectedTools.some((n, i) => n !== baseSelected[i]);
const typedSelection = edited ? options.selectedTools : [...active];
const typedSection = renderTools(typedSelection);
check("typed run carries the loader bullet", typedSelection.includes(LOADER));
check(
	"the typed run's selection already equals the live set (nothing to re-add)",
	typedSelection.join(",") === [...active].join(","),
	`typed=${typedSelection.length} live=${active.length}`,
);

// ── 3. the run makes a tool call: the drift handler runs ────────────────────────
api.setActiveTools([...active, STRAY]);
check("the stray is present before the sweep", active.includes(STRAY));
await emit("tool_call", { toolName: FOREMAN_TOOLS[0], input: {} }, ctx);
check(
	"a tool call leaves the loader selected",
	active.includes(LOADER),
	`loader present=${active.includes(LOADER)}`,
);
check(
	"a tool call still removes a non-loader stray",
	!active.includes(STRAY),
	`stray present=${active.includes(STRAY)}`,
);
check(
	"a tool call leaves the live-set-only loader selected too",
	active.includes(LOADER2),
	`${LOADER2} present=${active.includes(LOADER2)}`,
);

// ── 4. wake run: no before_agent_start, so the live set renders ─────────────────
const wakeSelection = [...active];
const wakeSection = renderTools(wakeSelection);
const delta = typedSection.length - wakeSection.length;
check(
	"typed and wake render the same tools section",
	delta === 0,
	`delta=${delta}${delta !== 0 ? ` (first divergence: ${JSON.stringify(wakeSection.slice(0, 60))})` : ""}`,
);
if (delta !== 0) {
	const bullet = `- ${LOADER}: ${LOADER_SNIPPET}`;
	check(
		"the divergence is exactly the loader bullet",
		typedSection.includes(bullet) && !wakeSection.includes(bullet) && delta === bullet.length + 1,
		`bullet=${bullet.length + 1} delta=${delta}`,
	);
}

// ── 5. the payload filter still keeps the loader off the wire ───────────────────
const payload = {
	model: "deepseek-flash",
	messages: [{ role: "system", content: "RIG-BASE" }],
	tools: [...typedSelection].map((name) => ({ type: "function", function: { name } })),
};
await emit("before_provider_request", { payload }, ctx);
const wire = (payload.tools as { function: { name: string } }[]).map((t) => t.function.name);
check(
	"wire tools are the frozen set, loaders excluded",
	wire.length === FOREMAN_TOOLS.length && !wire.includes(LOADER) && !wire.includes(LOADER2),
	`wire=${wire.length}`,
);

console.log(
	`\nloader=${LOADER} mutate=${MUTATE || "(none)"} typed=${typedSection.length} wake=${wakeSection.length}`,
);
finish("FLEET", count());
