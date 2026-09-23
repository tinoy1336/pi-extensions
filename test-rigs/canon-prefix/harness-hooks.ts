/**
 * Verifies canon's REAL before_provider_request wiring (not only the pure
 * helpers) against the REAL canon package, imported at run time from the source
 * rig.ts selects (`RIG_SOURCE`, this checkout by default).
 * The separator is the shared seam package's (`PROMPT_APPEND_SEP`) — the name
 * canon imports now that the seam lives outside it.
 *
 * The canonical prompt the typed run must carry is produced by canon's own real
 * before_agent_start hook over the STORE — not a recorded fixture — so the bytes
 * under test are always the ones the extension renders today.
 *
 * RIG_MUTATE=stale-block simulates the aged-fixture defect: the "typed" payload
 * is built from a deliberately stale block, so canon re-normalizes it and the
 * harness must go red. The default run must be green.
 */
import {
	canonCtx,
	createChecker,
	emitEvent,
	fakePi,
	finish,
	loadCanon,
	loadSeam,
	setSessionShape,
} from "./rig.ts";

// The session shape is declared, never inherited from the launching shell: this
// rig covers the plain session, so a run from a crew worker shell (which exports
// PI_SUBAGENT_CHILD=1) renders and checks the same block a plain shell does.
setSessionShape("parent");

const canon = await loadCanon();
const seam = await loadSeam();
const { api, handlers } = fakePi();
canon.default(api);
const ctx = canonCtx("deepseek-flash");
const emit = (ev: string, event: unknown) => emitEvent(handlers, ev, event, ctx);

const sep = seam.PROMPT_APPEND_SEP as string;
const base = "BASE-SYSTEM-PROMPT";
// The typed run's prompt is whatever canon's real before_agent_start produced.
const produced = (await emit("before_agent_start", { systemPrompt: base })) as {
	systemPrompt: string;
};
const block = produced.systemPrompt.slice(base.length + sep.length);
// Mutation: an aged fixture would carry a stale block; the harness must catch it.
const MUTATE = process.env.RIG_MUTATE ?? "";
const typedText =
	MUTATE === "stale-block"
		? `${base}${sep}${block} // stale-fixture-artifact`
		: produced.systemPrompt;

const { check, count } = createChecker();
type HookLine = { source: string; kind: string; detail: Record<string, unknown> };
/**
 * The canon lines this harness asserts on: its PROMPT-REPAIR diagnostics. Canon
 * writes other diagnostics on the same source — `category-drift` once per process
 * on the first store load — and those are not part of the property under test, so
 * they are filtered out by KIND rather than by count. A kind outside this set is
 * reported instead of ignored, so a new canon diagnostic cannot slip past the
 * assertions by making them pass for the wrong reason.
 */
const REPAIR_KINDS = new Set([
	"prompt-normalized",
	"prompt-repair-after-hook",
	"prompt-unrepairable",
]);
const canonLines = (): HookLine[] =>
	((globalThis as unknown as { __hookLog?: HookLine[] }).__hookLog ?? []).filter(
		(l) => l.source === "canon",
	);
const logs = (): HookLine[] => canonLines().filter((l) => REPAIR_KINDS.has(l.kind));

// 1. typed run: before_agent_start fired, the request carries those bytes.
const typedPayload = {
	model: "deepseek-flash",
	messages: [{ role: "system", content: typedText }],
	tools: [{ type: "function", function: { name: "read" } }],
};
await emit("before_provider_request", { payload: typedPayload });
check(
	"typed request untouched (byte-identical)",
	(typedPayload.messages[0] as { content: string }).content === typedText,
);
check("typed request logs no repair", logs().length === 0, JSON.stringify(logs()));
check(
	"canon's other diagnostics stay out of the repair set",
	canonLines().every((l) => REPAIR_KINDS.has(l.kind) || l.kind === "category-drift"),
	JSON.stringify(canonLines().map((l) => l.kind)),
);

// 2. wake run: no before_agent_start; payload arrives base-only.
await emit("agent_start", {});
const wakePayload = {
	model: "deepseek-flash",
	messages: [{ role: "system", content: base }],
	tools: [{ type: "function", function: { name: "read" } }],
};
await emit("before_provider_request", { payload: wakePayload });
check(
	"wake request normalized in place",
	(wakePayload.messages[0] as { content: string }).content === typedText,
);
check(
	"wake request logged once as prompt-normalized",
	logs().length === 1 && logs()[0]?.kind === "prompt-normalized",
	JSON.stringify(logs()[0]?.kind),
);
check(
	"wake log carries sizes",
	typeof logs()[0]?.detail.baseChars === "number" &&
		typeof logs()[0]?.detail.canonicalChars === "number",
);

// 3. second request of the same wake run: repaired again, but not re-logged.
const wake2 = {
	model: "deepseek-flash",
	messages: [{ role: "system", content: base }],
	tools: [{ type: "function", function: { name: "read" } }],
};
await emit("before_provider_request", { payload: wake2 });
check(
	"second wake request normalized",
	(wake2.messages[0] as { content: string }).content === typedText,
);
check("repeat repair not re-logged", logs().length === 1, `lines=${logs().length}`);

// 4. anomaly: before_agent_start DID fire, yet the payload lacks the block.
await emit("before_agent_start", { systemPrompt: base });
const anomaly = {
	model: "deepseek-flash",
	messages: [{ role: "system", content: base }],
	tools: [{ type: "function", function: { name: "read" } }],
};
await emit("before_provider_request", { payload: anomaly });
check("anomaly repaired", (anomaly.messages[0] as { content: string }).content === typedText);
check(
	"anomaly logged as prompt-repair-after-hook (never silent)",
	logs().length === 2 && logs()[1]?.kind === "prompt-repair-after-hook",
	JSON.stringify(logs().map((l) => l.kind)),
);

// 5. unknown payload shape: untouched request + one guard line.
const foreign = { model: "x", contents: [{ parts: [{ text: base }] }] };
await emit("before_provider_request", { payload: foreign });
check(
	"foreign shape untouched",
	JSON.stringify(foreign).includes("BASE-SYSTEM-PROMPT") &&
		!JSON.stringify(foreign).includes("## Canon"),
);
check(
	"foreign shape logged once as prompt-unrepairable",
	logs().filter((l) => l.kind === "prompt-unrepairable").length === 1,
	JSON.stringify(logs().map((l) => l.kind)),
);

console.log(`\nfixture: block ${block.length} chars (from canon before_agent_start)`);
finish("HOOK", count());
