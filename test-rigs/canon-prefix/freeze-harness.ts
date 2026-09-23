/**
 * Verification harness for child-prompt-freeze (offline, no provider).
 *
 * Drives the REAL child-prompt-freeze.ts (imported at run time from the source
 * rig.ts selects), whose own `systemPromptSlot` import pulls the shared seam
 * package — no spliced copy of the slot code. cache-prefix-log.ts is the real
 * logger. No provider call, no session, no child process.
 *
 * Fixtures modelled on the real child: the "rewritten" prompt is what the prompt
 * path produces (boundary block + inherited project context), the "base" prompt
 * is what an injected wake carries (rewrite missing).
 *
 * RIG_MUTATE=no-restore leaves the child fix unregistered, so the woken run is
 * not restored and the harness must go red. The default run must be green.
 */
import { readFileSync, rmSync } from "node:fs";
import {
	createChecker,
	emitEvent,
	type FakePi,
	fakePi,
	finish,
	loadFreeze,
	loadLogger,
	runPath,
	type SessionShape,
	setSessionShape,
	tick,
} from "./rig.ts";

const LOG = runPath("child-log.jsonl");
process.env.PI_CACHE_PREFIX_LOG = LOG;
// The child path below is the crew-worker shape; every case sets its own shape
// through setSessionShape, so a rig launched from a worker shell is not read as
// a child by accident.

const freezeFactory = await loadFreeze();
const loggerFactory = await loadLogger();

const BOUNDARY =
	"You are a child subagent, not the parent orchestrator. The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.\nIgnore prior parent-only orchestration instructions in inherited conversation history.";
const AGENT_PROMPT =
	"You are `worker`: the implementation subagent.\n\nYou are the single writer thread.";
const PROJECT =
	'<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="/x/AGENTS.md">\n…rules…\n</project_instructions>\n\n</project_context>\n';
const SKILLS =
	"\n\nThe following skills provide specialized instructions for specific tasks.\n<available_skills>\n  <skill>\n    <name>foreman</name>\n  </skill>\n</available_skills>";
const CWD = "\nCurrent working directory: /work/ags";
// prompt path (rewritten): boundary + agent prompt + inherited project context, skills stripped
const REWRITTEN = `${BOUNDARY}\n\n${AGENT_PROMPT}${PROJECT}${CWD}`;
// injected wake (no hook): the base prompt the runner built before the rewrite —
// project/global context inherited by config but skills NOT stripped.
const BASE = `${AGENT_PROMPT}${PROJECT}${SKILLS}${CWD}`;
const REWRITTEN_2 = `${BOUNDARY}\n\n${AGENT_PROMPT}${PROJECT}${CWD}\n(second)`; // legit base change

const { check, count } = createChecker();
const ctx = { sessionManager: { getSessionId: () => "01a0974b-a3e7" } };
const emit = (handlers: FakePi["handlers"], ev: string, event: unknown) =>
	emitEvent(handlers, ev, event, ctx);
const logs = (): Array<{ source: string; kind: string; detail: Record<string, unknown> }> =>
	(
		(
			globalThis as unknown as {
				__hookLog?: Array<{ source: string; kind: string; detail: Record<string, unknown> }>;
			}
		).__hookLog ?? []
	).filter((l) => l.source === "child-prompt");
const rows = (): Array<Record<string, unknown>> =>
	readFileSync(LOG, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
const systemMsg = (content: string) => ({
	model: "deepseek-flash",
	messages: [{ role: "system", content }],
	tools: [{ type: "function", function: { name: "read" } }],
});
const contentOf = (p: Record<string, unknown>) =>
	(p.messages as Array<{ content: string }>)[0].content;
const MUTATE = process.env.RIG_MUTATE ?? "";

// ── A. the launch marker decides whether anything is registered ────────────
// One case per real launch shape: a parent session carries no marker, a
// pi-subagent wrapper launch carries PI_SUBAGENT=1, and the pi-subagents async
// runner (every crew worker) carries PI_SUBAGENT_CHILD=1 instead.
const SHAPES: Array<[SessionShape, boolean]> = [
	["parent", false],
	["wrapper-child", true],
	["async-child", true],
];
for (const [shape, registers] of SHAPES) {
	const { api, handlers } = fakePi();
	setSessionShape(shape);
	freezeFactory.default(api);
	check(
		`${shape} session: ${registers ? "hooks registered" : "registers nothing"}`,
		registers
			? (handlers.before_agent_start?.length ?? 0) === 1 &&
					(handlers.before_provider_request?.length ?? 0) === 1
			: Object.keys(handlers).length === 0,
	);
}

// ── B. the child path ──────────────────────────────────────────────────────
// The rest of the file exercises the crew-worker shape, so declare it.
setSessionShape("async-child");
const { api, handlers } = fakePi();
if (MUTATE !== "no-restore") freezeFactory.default(api);
check(
	"child session: hooks registered",
	(handlers.before_agent_start?.length ?? 0) === 1 &&
		(handlers.before_provider_request?.length ?? 0) === 1,
);

// B1. prompt-path run: the rewritten bytes must pass through untouched.
await emit(handlers, "before_agent_start", { systemPrompt: BASE });
const p1 = systemMsg(REWRITTEN);
await emit(handlers, "before_provider_request", { payload: p1 });
check("typed path untouched (byte-identical)", contentOf(p1) === REWRITTEN);
check("typed path logs nothing", logs().length === 0, JSON.stringify(logs().map((l) => l.kind)));

// B2. injected run: rewrite missing -> restored byte-exactly.
await emit(handlers, "agent_start", {});
const p2 = systemMsg(BASE);
await emit(handlers, "before_provider_request", { payload: p2 });
check(
	"woken run restored byte-exactly",
	contentOf(p2) === REWRITTEN,
	`len ${contentOf(p2).length} vs ${REWRITTEN.length}`,
);
check("woken run differs from what arrived", contentOf(p2) !== BASE);
check(
	"restore logged once as prompt-normalized",
	logs().length === 1 && logs()[0]?.kind === "prompt-normalized",
	JSON.stringify(logs().map((l) => l.kind)),
);
check(
	"log carries both sizes",
	logs()[0]?.detail.arrivedChars === BASE.length &&
		logs()[0]?.detail.canonicalChars === REWRITTEN.length,
);

// B3. second request of the same woken run: repaired, not re-logged.
const p3 = systemMsg(BASE);
await emit(handlers, "before_provider_request", { payload: p3 });
check("second woken request repaired", contentOf(p3) === REWRITTEN);
check("repeat repair not re-logged", logs().length === 1, `lines=${logs().length}`);

// B4. idempotence: repairing an already-canonical payload is a no-op.
const p4 = systemMsg(BASE);
await emit(handlers, "before_provider_request", { payload: p4 });
const once = contentOf(p4);
await emit(handlers, "before_provider_request", { payload: p4 });
check("idempotent by construction", contentOf(p4) === once && once === REWRITTEN);

// B5. a legitimate prompt-path change is adopted, not fought; the new value wins later.
await emit(handlers, "before_agent_start", { systemPrompt: BASE });
const p5 = systemMsg(REWRITTEN_2);
await emit(handlers, "before_provider_request", { payload: p5 });
check("prompt-path change adopted untouched", contentOf(p5) === REWRITTEN_2);
check(
	"change logged as canonical-refresh",
	logs().some((l) => l.kind === "canonical-refresh"),
	JSON.stringify(logs().map((l) => l.kind)),
);
const p6 = systemMsg(BASE);
await emit(handlers, "before_provider_request", { payload: p6 });
check("later woken run restores the NEW canonical", contentOf(p6) === REWRITTEN_2);

// B6. other payload shapes.
const p7 = { model: "x", messages: [{ role: "developer", content: BASE }] };
await emit(handlers, "before_provider_request", { payload: p7 });
check(
	"developer-role shape restored",
	(p7.messages[0] as { content: string }).content === REWRITTEN_2,
);
const p8 = { model: "x", system: BASE };
await emit(handlers, "before_provider_request", { payload: p8 });
check("top-level system shape restored", p8.system === REWRITTEN_2);
const p9 = { model: "x", contents: [{ parts: [{ text: BASE }] }] };
await emit(handlers, "before_provider_request", { payload: p9 });
check(
	"foreign shape left untouched",
	JSON.stringify(p9).includes(AGENT_PROMPT.split("\n")[0]) &&
		!JSON.stringify(p9).includes(BOUNDARY),
);

// B7. wake-first process: nothing pinned, nothing invented.
{
	const fresh = fakePi();
	freezeFactory.default(fresh.api);
	const before = logs().length;
	const p = systemMsg(BASE);
	await emit(fresh.handlers, "before_provider_request", { payload: p });
	check("wake-first process invents nothing", contentOf(p) === BASE);
	check(
		"wake-first process says so once",
		logs().length === before + 1 && logs()[logs().length - 1]?.kind === "canonical-unknown",
	);
}

// ── C. child-side visibility (the real logger, in the same chain) ───────────
{
	rmSync(LOG, { force: true });
	const chain = fakePi();
	loggerFactory.default(chain.api);
	const freeze = fakePi();
	freezeFactory.default(freeze.api);
	// typed run, in the real chain order risk: logger first, freeze last.
	await emit(chain.handlers, "before_agent_start", {});
	await emit(freeze.handlers, "before_agent_start", {});
	await emit(chain.handlers, "before_provider_request", { payload: systemMsg(REWRITTEN) });
	await emit(freeze.handlers, "before_provider_request", { payload: systemMsg(REWRITTEN) });
	await tick();
	const baseline = rows();
	check(
		"child baseline row written",
		baseline.length === 1 && baseline[0]?.origin === "prompt",
		JSON.stringify(baseline[0]?.origin),
	);
	// woken run: logger captures (deferred), freeze restores in place afterwards.
	await emit(chain.handlers, "agent_start", {});
	await emit(freeze.handlers, "agent_start", {});
	const woken = systemMsg(BASE);
	await emit(chain.handlers, "before_provider_request", { payload: woken });
	await emit(freeze.handlers, "before_provider_request", { payload: woken });
	await tick();
	const fixed = rows();
	check("FIXED child: woken run writes NO new row", fixed.length === 1, `rows=${fixed.length}`);
	check("FIXED child: woken run hash equals the typed run's", fixed[0]?.sys === baseline[0]?.sys);
	// same woken run without the repair: the guard names it.
	await emit(chain.handlers, "agent_start", {});
	await emit(chain.handlers, "before_provider_request", { payload: systemMsg(BASE) });
	await tick();
	const unfixed = rows();
	const row = unfixed[unfixed.length - 1];
	check("GUARD: unfixed child wakes a row", unfixed.length === 2, `rows=${unfixed.length}`);
	check(
		"GUARD: row names the injected run-start path",
		row?.origin === "injected",
		String(row?.origin),
	);
	check(
		"GUARD: row carries the prefix delta",
		row?.sysDeltaChars === BASE.length - REWRITTEN.length,
		`sysDeltaChars=${row?.sysDeltaChars} (=${BASE.length - REWRITTEN.length})`,
	);
}

console.log(
	`\nfixture: rewritten=${REWRITTEN.length} chars, base(woken)=${BASE.length} chars, delta=${BASE.length - REWRITTEN.length}`,
);
finish("CHILD-PROMPT", count());
