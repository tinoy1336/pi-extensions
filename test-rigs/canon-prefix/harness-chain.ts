/**
 * harness-chain.ts — the COMPOSED offline test the rig was missing: canon's REAL
 * `before_provider_request` hook and cache-prefix-log's REAL logger registered on
 * ONE fake pi chain, over the REAL modules from the source rig.ts selects, with
 * the fixture block derived from the store.
 *
 * It pins the property the live legs were the only ones covering: after canon
 * normalizes an injected wake in place, the logger's recorded fingerprint must
 * equal the typed run's — so the fix is proven at the seam where it reaches the
 * provider, not only by applying the pure helper by hand. It runs the chain in
 * BOTH registration orders, because before_provider_request handlers run in the
 * unsorted extension-directory order and the logger defers its read one macrotask
 * precisely to survive that.
 *
 * The negative control (logger only) proves the harness still turns red when the
 * repair is absent. RIG_MUTATE=no-canon drops canon from the chain, so the
 * composed property must fail and the run must exit non-zero.
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

const canon = await loadCanon();
const seam = await loadSeam();
const loggerFactory = await loadLogger();
const { PROMPT_APPEND_SEP: sep } = seam;
const block = await deriveBlock(canon, { model: "deepseek-flash" });
const base = "CHAIN-BASE-SYSTEM-PROMPT";
const typedText = base + sep + block;
const TOOLS = [{ type: "function", function: { name: "read" } }];
const MUTATE = process.env.RIG_MUTATE ?? "";

const { check, count } = createChecker();

type Chain = {
	handlers: FakePi["handlers"];
	emit: (ev: string, event: unknown) => Promise<unknown>;
	logFile: string;
};
function buildChain(order: Array<"canon" | "logger">, name: string): Chain {
	const logFile = runPath(name);
	process.env.PI_CACHE_PREFIX_LOG = logFile;
	const { api, handlers } = fakePi();
	const ctx = canonCtx("deepseek-flash");
	for (const key of order) {
		if (key === "canon") canon.default(api);
		else loggerFactory.default(api);
	}
	return { handlers, emit: (ev, event) => emitEvent(handlers, ev, event, ctx), logFile };
}
const rows = (file: string): Array<Record<string, unknown>> => {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
};
const payload = (content: string) => ({
	model: "deepseek-flash",
	messages: [{ role: "system", content }],
	tools: TOOLS,
});
const contentOf = (p: Record<string, unknown>) =>
	(p.messages as Array<{ content: string }>)[0].content;

// ── the composed property, in both chain orders ─────────────────────────────
for (const order of [
	["canon", "logger"],
	["logger", "canon"],
] as const) {
	const label = order.join("->");
	const canonRegistered = MUTATE !== "no-canon" && order.includes("canon");
	const activeOrder = canonRegistered ? order : (["logger"] as const);
	const chain = buildChain([...activeOrder], `chain-${label}-${MUTATE || "base"}.jsonl`);

	// typed run: the canonical prompt comes from canon's real hook over the store.
	await chain.emit("before_agent_start", { systemPrompt: base });
	await chain.emit("agent_start", {});
	const typed = payload(typedText);
	await chain.emit("before_provider_request", { payload: typed });
	await tick();
	const baseline = rows(chain.logFile);
	check(
		`[${label}] baseline row written`,
		baseline.length === 1,
		JSON.stringify(baseline[0]?.changed),
	);
	check(`[${label}] typed run attributed to the prompt path`, baseline[0]?.origin === "prompt");
	// the composed proof: the logger's fingerprint is of the bytes canon produced.
	check(
		`[${label}] logger fingerprint == the prompt canon produced`,
		baseline[0]?.sysChars === typedText.length,
		`sysChars=${baseline[0]?.sysChars} vs ${typedText.length}`,
	);

	// injected wake: canon must normalize it in place, so the prefix never moves.
	await chain.emit("agent_start", {});
	const woken = payload(base);
	await chain.emit("before_provider_request", { payload: woken });
	await tick();
	const afterWake = rows(chain.logFile);
	check(`[${label}] woken payload IS the typed prompt`, contentOf(woken) === typedText);
	check(
		`[${label}] FIX: woken run writes NO new row`,
		afterWake.length === 1,
		`rows=${afterWake.length}`,
	);
	check(
		`[${label}] FIX: woken run fingerprint stays the typed run's`,
		afterWake[0]?.sys === baseline[0]?.sys,
	);
}

// ── negative control: no repair -> the guard names the moving prefix ─────────
{
	const chain = buildChain(["logger"], "chain-negative-control.jsonl");
	await chain.emit("before_agent_start", { systemPrompt: base });
	await chain.emit("agent_start", {});
	await chain.emit("before_provider_request", { payload: payload(typedText) });
	await tick();
	check("GUARD: control baseline written", rows(chain.logFile).length === 1);
	await chain.emit("agent_start", {});
	await chain.emit("before_provider_request", { payload: payload(base) });
	await tick();
	const control = rows(chain.logFile);
	const row = control[control.length - 1];
	check("GUARD: unrepaired wake writes a row", control.length === 2, `rows=${control.length}`);
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
	check("GUARD: row says the system prompt moved", (row?.changed as string[])?.includes("sys"));
}

console.log(`\nfixture: block ${block.length} chars; composed chains run in both orders.`);
finish("CHAIN", count());
