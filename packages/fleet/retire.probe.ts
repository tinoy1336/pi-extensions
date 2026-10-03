/**
 * retire.probe — the executable probe for the retirement economics.
 *
 * Run: `node --experimental-strip-types retire.probe.ts` from `packages/fleet`.
 *
 * This decides when a worker is replaced, so a silent change either spends money
 * replacing one that still had work left or keeps one that has become the expensive
 * option. Everything it drives is exported and pure except the two store readers, and
 * those are pointed at a directory the probe creates: the crew's real state, its
 * runtime directory and any live worker's records are never opened.
 *
 * No rule number is written twice. Every threshold, floor and margin comes from the
 * module's own export, and the three price ratios come from `@tinoy/pi-tariff`'s
 * `ratios()`, which is the single owner of that derivation — the probe asserts against
 * formulas built from those imports, so a changed constant moves both sides together
 * and only a changed RULE fails a check.
 *
 * Cases: the replacement cost and its cache-floor comparison, the break-even count
 * including the no-stale case, the projection the count is compared against, the three
 * idle states at their boundaries, both backstops at their thresholds, a clean
 * economical retirement against the guards that suppress it, the fleet rate cap read
 * from a scratch log, the crew's reuse window read from a scratch config, and the two
 * measurement helpers.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ratios } from "@tinoy/pi-tariff";
import {
	type AssessmentInput,
	appendRetireLog,
	assessRetirement,
	BREAK_EVEN_MARGIN,
	baselineWindow,
	breakEvenRequests,
	PROVIDER_CACHE_FLOOR_MS as CACHE_FLOOR,
	CORRECTNESS_CAP_FRACTION,
	DEEP_IN_THE_MONEY_TOKENS,
	ETA_BOOTSTRAP_REQUESTS,
	FLEET_CAP_WINDOW_MS,
	FLEET_RETIREMENT_CAP,
	handoffTokens,
	K_HORIZON_REQUESTS,
	K_RATE_QUANTILE,
	K_SAFETY_MARGIN,
	LEDGER_RUNS_PER_ITEM,
	loadReuseWindowMs,
	MIN_ITEMS_SINCE_HIRE,
	projectRemainingRequests,
	recentRetirementTimesMs,
	replacementCost,
	retireLogRow,
	SIGNAL_COOLDOWN_MS,
	STAKES_FLOOR_TOKENS,
	TRAILING_ITEMS,
} from "./retire.ts";

const scratch = mkdtempSync(join(tmpdir(), "pi-retire-probe-"));
mkdirSync(scratch, { recursive: true });

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

function near(name: string, actual: number, expected: number): void {
	check(name, actual === expected, `got ${actual}, want ${expected}`);
}

// ── The ratios come from their owner, not from a literal ─────────────────────
const prices = ratios(
	{
		usd: {
			valley: { cacheHit: 1, cacheMiss: 10, output: 100 },
			peak: { cacheHit: 2, cacheMiss: 10, output: 100 },
		},
		cny: {
			valley: { cacheHit: 1, cacheMiss: 10, output: 100 },
			peak: { cacheHit: 2, cacheMiss: 10, output: 100 },
		},
	},
	"usd",
	"valley",
);

// ── The reuse window comes from a scratch store ──────────────────────────────
const windowSeconds = 3600;
writeFileSync(join(scratch, "config.json"), JSON.stringify({ reuseWindowSeconds: windowSeconds }));
const reuseWindowMs = loadReuseWindowMs(scratch);
check(
	"the reuse window is read from the store's own field",
	reuseWindowMs === windowSeconds * 1000,
	String(reuseWindowMs),
);
mkdirSync(join(scratch, "bad"), { recursive: true });
writeFileSync(join(scratch, "bad", "config.json"), JSON.stringify({ reuseWindowSeconds: -1 }));
check(
	"an unusable window is null, never a substitute",
	loadReuseWindowMs(join(scratch, "bad")) === null,
);
check("a missing store is null", loadReuseWindowMs(join(scratch, "nowhere")) === null);
if (reuseWindowMs === null) throw new Error("the probe needs a readable reuse window");
// Bound to a number so the closure below sees it narrowed, not `number | null`.
const reuseWindow: number = reuseWindowMs;

// ── A measurement set the rules can decide on ────────────────────────────────
const NOW = 1_800_000_000_000;
const W = 60_000;
const B = 20_000;
const F0 = 1_000;
const m = 100;
const obar = 20;

function input(overrides: Partial<AssessmentInput> = {}): AssessmentInput {
	return {
		worker: "probe",
		nowMs: NOW,
		W,
		B,
		F0,
		m,
		obar,
		contextLimit: 1_000_000,
		windowPeak: null,
		lifetimeTokens: 0,
		idleMs: 0,
		reuseWindowMs: reuseWindow,
		r: prices.r,
		mult: prices.mult,
		outputPerInput: prices.outputPerInput,
		perItemRequests: [4, 5, 6, 4],
		pendingItems: 10,
		midStep: false,
		familyShift: false,
		handoffCurrent: true,
		itemsSinceHire: MIN_ITEMS_SINCE_HIRE,
		nonHandoffableState: false,
		lastSignalAtMs: null,
		fleetRetirementTimesMs: [],
		lineageDepth: 0,
		...overrides,
	};
}

console.log("the cost of replacing");
const warmCost = replacementCost({
	W,
	B,
	F0,
	m,
	obar,
	r: prices.r,
	eta: ETA_BOOTSTRAP_REQUESTS,
	outputPerInput: prices.outputPerInput,
	idleMs: CACHE_FLOOR - 1,
});
near("stale is W minus B", warmCost.stale, W - B);
check("just inside the cache floor is not a cold handoff", warmCost.coldHandoff === false);
check("and pays no surcharge", warmCost.coldSurcharge === 0);
near(
	"the warm one-time cost is the three terms the rule names",
	warmCost.oneTimeWarm,
	Math.max(0, B - F0) +
		prices.outputPerInput * m +
		ETA_BOOTSTRAP_REQUESTS * (prices.r * B + prices.outputPerInput * obar),
);
near(
	"with no surcharge the one-time cost is the warm cost",
	warmCost.oneTime,
	warmCost.oneTimeWarm,
);

const coldCost = replacementCost({
	W,
	B,
	F0,
	m,
	obar,
	r: prices.r,
	eta: ETA_BOOTSTRAP_REQUESTS,
	outputPerInput: prices.outputPerInput,
	idleMs: CACHE_FLOOR,
});
check("at the cache floor the handoff is cold", coldCost.coldHandoff === true);
near(
	"and pays the re-read of the whole context at the miss price",
	coldCost.coldSurcharge,
	(1 - prices.r) * W,
);
near(
	"which the one-time cost carries",
	coldCost.oneTime,
	coldCost.oneTimeWarm + coldCost.coldSurcharge,
);

console.log("the break-even count");
near(
	"K* is the margin over the multiple over the one-time cost, per stale token",
	breakEvenRequests(warmCost.oneTime, warmCost.stale, prices.mult),
	Math.ceil((BREAK_EVEN_MARGIN * prices.mult * warmCost.oneTime) / warmCost.stale),
);
check(
	"nothing stale has no break-even at all",
	breakEvenRequests(warmCost.oneTime, 0, prices.mult) === Number.POSITIVE_INFINITY,
);

console.log("the projection K* is compared against");
const none = projectRemainingRequests({ perItemRequests: [4, 5], pendingItems: 0 });
check(
	"nothing pending projects zero",
	none.kHat === 0 && none.basis === "none" && none.runRate === null,
);
const noRate = projectRemainingRequests({ perItemRequests: [], pendingItems: 5 });
check("no per-item rate projects zero too", noRate.kHat === 0 && noRate.basis === "none");
const projected = projectRemainingRequests({ perItemRequests: [4, 5, 6, 4], pendingItems: 10 });
const trailing = [4, 5, 6, 4].slice(-TRAILING_ITEMS).sort((a, b) => a - b);
const runRate = trailing[Math.floor(K_RATE_QUANTILE * (trailing.length - 1))];
const expectedKhat = Math.min(
	K_HORIZON_REQUESTS,
	Math.floor(Math.min(runRate * 10, LEDGER_RUNS_PER_ITEM * 10) * K_SAFETY_MARGIN),
);
near(
	"the projection is the smaller of the two, at the safety margin",
	projected.kHat,
	expectedKhat,
);
check(
	"and it names the projection that bound it",
	projected.basis === (runRate * 10 <= LEDGER_RUNS_PER_ITEM * 10 ? "run-rate" : "ledger"),
);
near("with the rate it used reported", projected.runRate ?? -1, runRate);

console.log("the three idle states at their boundaries");
check(
	"inside the reuse window reads warm",
	assessRetirement(input({ idleMs: reuseWindowMs })).idleState === "warm",
);
check(
	"just past it reads past-window",
	assessRetirement(input({ idleMs: reuseWindowMs + 1 })).idleState === "past-window",
);
check(
	"just inside the cache floor still reads past-window",
	assessRetirement(input({ idleMs: CACHE_FLOOR - 1 })).idleState === "past-window",
);
check(
	"at the cache floor reads cold",
	assessRetirement(input({ idleMs: CACHE_FLOOR })).idleState === "cold",
);

console.log("the backstops at their thresholds");
const atCorrectness = assessRetirement(
	input({ W: CORRECTNESS_CAP_FRACTION * 1_000_000, B: 1_000 }),
);
check(
	"W at the correctness fraction of the window resets",
	atCorrectness.backstop === "correctness",
);
check("and the decision is a reset, not a retirement", atCorrectness.decision === "reset");
const justBelowLimit = CORRECTNESS_CAP_FRACTION * 1_000_000 - 1;
const belowCorrectness = assessRetirement(
	input({ W: justBelowLimit, B: justBelowLimit - STAKES_FLOOR_TOKENS }),
);
check("one token below it is not the correctness backstop", belowCorrectness.backstop === null);
const deep = assessRetirement(input({ W: 400_000, B: 400_000 - DEEP_IN_THE_MONEY_TOKENS }));
check("stale at the deep-in-the-money floor resets", deep.backstop === "deep-in-the-money");
check("and that is a reset too", deep.decision === "reset");

console.log("the decision and the guards that suppress it");
const clean = assessRetirement(input());
check(
	"a clean economical case retires",
	clean.decision === "retire",
	clean.reasons.join(" | ").slice(0, 80),
);
check("its K* is finite and below K̂", clean.kHat > clean.kStar);
const idle = assessRetirement(input({ pendingItems: 0 }));
check("nothing pending keeps the worker", idle.decision === "keep");
const thin = assessRetirement(input({ B: W - (STAKES_FLOOR_TOKENS - 1) }));
check("below the stakes floor the worker is kept", thin.decision === "keep");
const cooldown = assessRetirement(input({ lastSignalAtMs: NOW - (SIGNAL_COOLDOWN_MS - 1) }));
check("inside the signal cooldown the worker is kept", cooldown.decision === "keep");
const pastCooldown = assessRetirement(input({ lastSignalAtMs: NOW - SIGNAL_COOLDOWN_MS }));
check(
	"at the cooldown boundary the economic path is open again",
	pastCooldown.decision === "retire",
);
const early = assessRetirement(input({ itemsSinceHire: MIN_ITEMS_SINCE_HIRE - 1 }));
check("before enough items the worker is kept", early.decision === "keep");
const unknownState = assessRetirement(input({ nonHandoffableState: null }));
check("an unknowable handoff-able state keeps the worker", unknownState.decision === "keep");
const carryingState = assessRetirement(input({ nonHandoffableState: true }));
check("a worker holding non-handoff-able state is kept", carryingState.decision === "keep");
const midStep = assessRetirement(input({ midStep: true }));
check("a mid-step decision waits", midStep.decision === "keep");
const stale = assessRetirement(input({ handoffCurrent: false }));
check("a stale handoff keeps the worker", stale.decision === "keep");
const lineage = assessRetirement(input({ lineageDepth: null }));
check("an unknown lineage keeps the economic path silent", lineage.decision === "keep");
const justCompacted = assessRetirement(input({ windowPeak: W + STAKES_FLOOR_TOKENS }));
check(
	"a context far below its peak keeps the worker",
	justCompacted.decision === "keep",
	justCompacted.reasons.join(" | ").slice(0, 70),
);

console.log("the fleet rate cap, from a scratch log");
const logPath = join(scratch, "retire.log");
const row = retireLogRow(clean);
check(
	"the log row carries the rounded one-time cost",
	row.x === Math.round(clean.cost.oneTime),
	String(row.x),
);
check("and the stale count the rule measured", row.stale === clean.cost.stale);
check("the log accepts the row", appendRetireLog(row, logPath) === true);
const recentRows = FLEET_RETIREMENT_CAP;
for (let n = 0; n < recentRows; n += 1) appendRetireLog({ ...row, at: NOW - n }, logPath);
appendRetireLog({ ...row, at: NOW - FLEET_CAP_WINDOW_MS }, logPath);
const times = recentRetirementTimesMs(logPath, 200);
check(
	"the scratch log's rows are all readable",
	times.length >= recentRows,
	`${times.length} rows`,
);
const capped = assessRetirement(input({ fleetRetirementTimesMs: times }));
check("at the cap the worker is kept", capped.decision === "keep");
check(
	"and the reason names the cap",
	capped.reasons.join(" | ").includes("fleet rate cap"),
	capped.reasons.join(" | ").slice(0, 70),
);
const underCap = assessRetirement(
	input({ fleetRetirementTimesMs: times.slice(0, FLEET_RETIREMENT_CAP - 1) }),
);
check("one fewer retirement inside the window still retires", underCap.decision === "retire");

console.log("the two measurement helpers");
check("the baseline is the smallest usable sample", baselineWindow([900, 400, 700]) === 400);
check(
	"samples that cannot be a baseline are ignored",
	baselineWindow([0, -5, Number.NaN, 300]) === 300,
);
check("no usable sample is null", baselineWindow([0, -1]) === null);
check("the handoff length is the median of an odd set", handoffTokens([10, 30, 20]) === 20);
check(
	"and the rounded middle of an even set",
	handoffTokens([10, 21, 30, 40]) === Math.round((21 + 30) / 2),
);
check("no handoff measured is null", handoffTokens([]) === null);

check("a quiet worker carries no alarms", clean.alarms.length === 0);

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`retire probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`retire probe passed: ${checks} checks`);
