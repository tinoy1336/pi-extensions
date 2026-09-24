/**
 * Verification harness for the canon prompt-cache fix (offline, no provider).
 *
 * Drives the REAL modules — never a copy — from the source rig.ts selects
 * (`RIG_SOURCE`, this checkout's `packages/*` by default):
 *   - the canon PACKAGE, imported at run time (its value import of the pi SDK is
 *     resolve-shimmed by rig.ts; every helper asserted here is the shipped text);
 *   - the shared seam package (`canonicalSystemPrompt`, `systemPromptSlot`,
 *     `PROMPT_APPEND_SEP`), which is where those three live now;
 *   - the cache-prefix-log package, imported as-is.
 *
 * The fixture block is DERIVED from the canon store at run time through the
 * real `before_agent_start` hook (rig.deriveBlock): there is no recorded block to
 * age, so a store edit can never silently desync the harness from the extension
 * — if the store cannot render a block, the rig aborts naming the store.
 *
 * It replays the logged miss structure: a typed turn whose system prompt carries
 * the canon block, then wake-routed turns (no before_agent_start) whose payload
 * arrives WITHOUT it — once with the fix applied in the payload chain, once
 * without (the pre-fix behaviour the guard must name).
 */
import { readFileSync } from "node:fs";
import {
	canonCtx,
	createChecker,
	deriveBlock,
	emitEvent,
	type FakePi,
	fakePi,
	finish,
	loadCanon,
	loadLogger,
	loadSeam,
	runPath,
	setSessionShape,
	tick,
} from "./rig.ts";

// The session shape is declared, never inherited from the launching shell: this
// rig covers the plain session, so a run from a crew worker shell (which exports
// PI_SUBAGENT_CHILD=1) renders and checks the same block a plain shell does.
setSessionShape("parent");

const LOG = runPath("log.jsonl");
process.env.PI_CACHE_PREFIX_LOG = LOG;

const canon = await loadCanon();
const seam = await loadSeam();
const loggerFactory = await loadLogger();
const { systemPromptSlot } = seam;
// RIG_MUTATE=no-append disables the repair, so the alarm must fire (red).
const MUTATE = process.env.RIG_MUTATE ?? "";
const canonicalSystemPrompt =
	MUTATE === "no-append"
		? (s: string) => ({ text: s, hadBlock: s.includes("## Canon") })
		: (seam.canonicalSystemPrompt as (s: string, b: string) => { text: string; hadBlock: boolean });

// The base body is not reconstructable from disk (the jsonl stores messages, not
// request payloads); byte-identity is a property of the transform, so the base is
// a stand-in string. The block appended to it is the LIVE render.
const base = `BASE-SYSTEM-PROMPT\n${"x".repeat(71949 - 200)}`;
const block = await deriveBlock(canon, { model: "deepseek-flash" });
const sep = seam.PROMPT_APPEND_SEP as string;
const typedText = base + sep + block;

const { check, count } = createChecker();
const TOOLS = [
	{
		type: "function",
		function: { name: "read", description: "read a file", parameters: { type: "object" } },
	},
	{
		type: "function",
		function: { name: "fleet", description: "crew", parameters: { type: "object" } },
	},
];

// ── 1. pure canonicalization ────────────────────────────────────────────────
const typed = canonicalSystemPrompt(typedText, block);
const wake = canonicalSystemPrompt(base, block);
const twice = canonicalSystemPrompt(typed.text, block);
// must be canon-SHAPED (header line = the marker), like a block inherited from a
// fork rendered for another model/audience — not arbitrary text.
const staleBlock = `${block.slice(0, block.indexOf("\n"))}\n\nActive model: glm-5.3-flash (this session: parent)`;
const stale = canonicalSystemPrompt(`${base}${sep}${staleBlock}${sep}${block}`, block);
const doubled = canonicalSystemPrompt(`${base}${sep}${block}${sep}${block}`, block);
check("typed path unchanged", typed.text === typedText && typed.hadBlock);
check("wake path gains the block", wake.text === typedText && !wake.hadBlock);
check("paths byte-identical", typed.text === wake.text);
check("idempotent (never appends twice)", twice.text === typed.text && twice.hadBlock);
check("re-applied to a doubled block -> one block", doubled.text === typedText);
check(
	"stale/foreign block replaced in place",
	stale.text === typedText,
	`hadBlock=${stale.hadBlock} tail-identical=${stale.text.endsWith(block)}`,
);
check(
	"append size = separator + block",
	typed.text.length - base.length === sep.length + block.length,
	`+${typed.text.length - base.length} chars`,
);

// ── 2. payload shapes ───────────────────────────────────────────────────────
const shapes: Array<[string, Record<string, unknown>, string]> = [
	["openai-completions system msg", { messages: [{ role: "system", content: base }] }, "content"],
	["reasoning developer msg", { messages: [{ role: "developer", content: base }] }, "content"],
	["top-level system", { system: base }, "system"],
	["responses instructions", { instructions: base }, "instructions"],
	[
		"anthropic system block",
		{ system: [{ type: "text", text: base, cache_control: { type: "ephemeral" } }] },
		"block",
	],
];
for (const [name, payload, kind] of shapes) {
	const slot = systemPromptSlot(payload);
	if (!slot) {
		check(`slot: ${name}`, false, "no slot found");
		continue;
	}
	const { text } = canonicalSystemPrompt(slot.get(), block);
	slot.set(text);
	const after =
		kind === "block"
			? (payload.system as Array<{ text: string }>)[0].text
			: kind === "content"
				? (payload.messages as Array<{ content: string }>)[0].content
				: (payload[kind] as string);
	check(`slot: ${name} canonicalized`, after === typedText);
}
check("slot: foreign shape returns null", systemPromptSlot({ foo: 1 }) === null);

// ── 3. cache-prefix-log through the real logger hook ────────────────────────
const loggerChain: FakePi = fakePi();
const loggerCtx = canonCtx();
const emit = (ev: string, event: unknown) => emitEvent(loggerChain.handlers, ev, event, loggerCtx);
const rows = (): Array<Record<string, unknown>> =>
	readFileSync(LOG, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

loggerFactory.default(loggerChain.api);

// typed run: before_agent_start fires, then agent_start, then the request.
await emit("before_agent_start", { systemPrompt: base });
await emit("agent_start", {});
await emit("before_provider_request", {
	payload: {
		model: "deepseek-flash",
		messages: [{ role: "system", content: typedText }],
		tools: TOOLS,
	},
});
await tick();
const afterTyped = rows();
check("baseline row written", afterTyped.length === 1, JSON.stringify(afterTyped[0]?.changed));
check("typed run attributed to the prompt path", afterTyped[0]?.origin === "prompt");
const typedSysHash = afterTyped[0]?.sys as string;
const typedSysChars = afterTyped[0]?.sysChars as number;

// wake run WITH the fix. Worst-case chain order: the logger's handler runs first
// (extension order is the unsorted readdir order), canon repairs in place after.
await emit("agent_start", {}); // no before_agent_start: an injected wake
const wakePayload = {
	model: "deepseek-flash",
	messages: [{ role: "system", content: base }],
	tools: TOOLS,
};
await emit("before_provider_request", { payload: wakePayload });
const wakeSlot = systemPromptSlot(wakePayload);
if (!wakeSlot) throw new Error("wake payload has no system slot");
wakeSlot.set(canonicalSystemPrompt(wakeSlot.get(), block).text);
await tick();
const afterFixedWake = rows();
check(
	"FIX: wake turn writes NO new row (prefix identical to the typed turn)",
	afterFixedWake.length === 1,
	`rows=${afterFixedWake.length}`,
);
check("FIX: wake turn hash == typed turn hash", afterFixedWake[0]?.sys === typedSysHash);

// wake run WITHOUT the fix: same run-start path, payload left base-only.
await emit("agent_start", {});
await emit("before_provider_request", {
	payload: { model: "deepseek-flash", messages: [{ role: "system", content: base }], tools: TOOLS },
});
await tick();
const afterUnfixed = rows();
const row = afterUnfixed[afterUnfixed.length - 1];
check(
	"GUARD: unfixed wake turn writes a row",
	afterUnfixed.length === 2,
	`rows=${afterUnfixed.length}`,
);
check(
	"GUARD: row names the injected run-start path",
	row?.origin === "injected",
	String(row?.origin),
);
check(
	"GUARD: row carries the prefix delta",
	row?.sysDeltaChars === -(sep.length + block.length),
	`sysDeltaChars=${row?.sysDeltaChars} (=-${sep.length + block.length})`,
);
const changed = (row?.changed as string[] | undefined) ?? [];
check("GUARD: row says the system prompt moved", changed.includes("sys"));
check("GUARD: tools untouched", changed.includes("tools") === false);
check(
	"GUARD: delta explains the logged bill",
	typedSysChars - (row?.sysChars as number) === sep.length + block.length,
);

console.log(
	`\nfixture: block derived live from the canon store (${block.length} chars; ` +
		`typed sysChars=${typedSysChars}). Base is a ${base.length}-char stand-in.`,
);
finish("CANON", count());
