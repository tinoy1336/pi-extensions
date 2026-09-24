/**
 * fleet/retire — the retirement signal: is replacing a warm worker worth it?
 *
 * The comparison is keep-the-warm-worker against replace-with-a-fresh-one. Every
 * request re-sends a worker's whole context, so the warm worker pays the
 * discounted READ price on a large number while a replacement pays the miss
 * price once on a small one and the read price on that smaller number afterwards:
 *
 *   X    = (B − F0) + q·m + eta·(r·B + q·obar)   one-time cost of replacing,
 *                                                in input-token equivalents
 *   MULT = (1 − r)/r                             from the price table, at runtime
 *   K*   = ceil(MARGIN · MULT · X / (W − B))     break-even future requests
 *
 * with r = cacheRead/input, W the warm worker's current context, B the baseline
 * working set a fresh worker converges to, m the handoff length in tokens, q the
 * price table's output:input ratio, and eta the extra requests a replacement
 * needs to re-bootstrap. The signal fires when the projected remaining requests
 * K̂ EXCEED K*.
 *
 * Nothing here retires a worker: an assessment is advisory, and the crew's own
 * `retire` action remains the only thing that clocks one out.
 *
 * The arithmetic — `replacementCost`, `breakEvenRequests`,
 * `projectRemainingRequests`, `assessRetirement` — is pure and takes every number
 * as an argument. Only `readPrice`, `loadReuseWindowMs` and `appendRetireLog`
 * touch the filesystem, and only `checkRetirement` drives all three.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOUSE_TARIFF_MODELS, loadTariff, ratios } from "@tinoy/pi-tariff";
import { AGENT_DIR, FLEET_DIR, human } from "./status.ts";

/** The price table: one owner for every rate this model uses, read from the agent
 *  directory in use (status.AGENT_DIR — `PI_CODING_AGENT_DIR` when pi was pointed at
 *  one, HOME's default otherwise), because pi resolves its own models.json the same
 *  way. A table that cannot be read there stays a refusal, never a substituted
 *  default. */
export const MODELS_PATH = join(AGENT_DIR, "models.json");

/** One JSON line per assessment, so the rule can be scored rather than believed. */
export const RETIRE_LOG_PATH = join(
	process.env.HOME ?? "/root",
	".local/pi/foreman/retire-log.jsonl",
);

const HOUR_MS = 60 * 60 * 1000;

/**
 * The provider cache floor: idling longer than this voids a worker's context, so
 * a handoff written after it re-sends all of W at miss price — the cold surcharge
 * below prices exactly that. It is a CONFIGURED floor, not a vendor fact: no
 * authoritative idle TTL is published anywhere. Inside it, the model treats the
 * context as warm, and the failure mode of a true window SHORTER than the floor
 * is a re-read of W on the retire path — a bounded cost, paid rather than argued
 * away. A shorter window must therefore degrade to that re-read; it must never be
 * resolved by asserting a different window, which would take the decision on an
 * unverified warm assumption.
 */
export const PROVIDER_CACHE_FLOOR_MS = 2 * HOUR_MS;

/** Guess: the extra requests a replacement needs to re-bootstrap before it is
 *  producing at the rate the handoff describes. Measured by counting the
 *  replacement's requests up to its first completed item, from its own run
 *  record, for every retirement the log records. */
export const ETA_BOOTSTRAP_REQUESTS = 3;

/** Guess: the future requests projected for a worker are capped here, so no
 *  history, however hot, can manufacture a large K̂. Measured by scoring K̂
 *  against the requests the worker actually went on to serve. */
export const K_HORIZON_REQUESTS = 120;

/** Guess: the break-even count is scaled by this before it is compared, so the
 *  rule demands a margin of saving rather than a bare crossing. Measured by
 *  scoring K-actual against K̂ at every firing in the log. */
export const BREAK_EVEN_MARGIN = 1.5;

/** Guess: below this much stale context the absolute saving is too small to
 *  cover the quality risk a handoff carries, whatever the ratio says. Measured
 *  by the (W − B) and the outcome of the retirements the log records. */
export const STAKES_FLOOR_TOKENS = 20_000;

/** Guess: at most one signal per worker per this period. Measured by how often
 *  the guard, rather than the economy, decides the answer. */
export const SIGNAL_COOLDOWN_MS = HOUR_MS;

/** Guess: fleet-wide cap and its window — a fleet that retires together is a
 *  policy failure, not a coincidence. Measured by retirements per completed
 *  item across the fleet. */
export const FLEET_RETIREMENT_CAP = 3;
export const FLEET_CAP_WINDOW_MS = HOUR_MS;

/** Guess: a handoff chain deeper than this on one scope repeats an optimistic K̂
 *  down a serial line of workers, so the answer becomes redistribute or discard
 *  rather than another handoff. Measured by the outcome of the items each
 *  generation delivers. */
export const MAX_HANDOFF_LINEAGE = 3;

/** Guess: how many recent completed items the trailing run rate is taken from. */
export const TRAILING_ITEMS = 5;

/** Guess: the quantile of the trailing per-item request counts — a LOWER one, so
 *  the one long item in the history cannot set the forecast. Measured by the
 *  distribution of per-item request counts in the item ledger. */
export const K_RATE_QUANTILE = 0.25;

/** Guess: the projection is scaled by this before it is compared, so the
 *  forecast is deliberately low rather than central. Measured by scoring K̂
 *  against the requests actually served. */
export const K_SAFETY_MARGIN = 0.75;

/** Guess: requests per pending item when the per-item history is too thin to
 *  give a rate. Measured by the item ledger's own requests-per-item. */
export const LEDGER_RUNS_PER_ITEM = 1.5;

/** Guess: completed items a worker must have behind it before a rate exists at
 *  all. Measured by the item ledger once it records requests per item. */
export const MIN_ITEMS_SINCE_HIRE = 3;

/** A context that lost this fraction of its peak was just compacted.
 *  Compaction has the same cost shape as a retirement with no working-set
 *  re-bootstrap, so it dominates wherever it is quality-equivalent and the
 *  retirement signal is suppressed. */
export const COMPACTION_GUARD_FRACTION = 0.2;

/** Correctness backstop: at this fraction of the model's context
 *  limit a reset is forced at the next step boundary. No economics are involved
 *  — the cap exists because a context that cannot hold the next step is a
 *  correctness failure, not an expense. */
export const CORRECTNESS_CAP_FRACTION = 0.75;

/** Deep-in-the-money backstop: at this much stale context a reset is
 *  forced at the next step boundary regardless of K̂. */
export const DEEP_IN_THE_MONEY_TOKENS = 250_000;

/** Budget alarm, from configuration. Its unit is cumulative spend, not
 *  context size, so it fires on the volume of work done and lags the decision it
 *  was meant to inform: it ALARMS and never triggers a retirement. */
export const BUDGET_ALARM_TOKENS = 900_000;

// ── I/O: the price table ──

export interface PriceFacts {
	modelId: string;
	/** Which table the numbers came from, so a refusal or an odd ratio can be
	 *  traced to its source instead of to the formula. */
	source: "house-tariff" | "model-registry";
	input: number;
	cacheRead: number;
	/** cacheRead / input — the read price as a fraction of the miss price. */
	r: number;
	/** (1 − r)/r — the input-token equivalents one read-priced token is worth. */
	mult: number;
	/** output / input — the ratio the handoff cost term is scaled by. */
	outputPerInput: number;
}

/**
 * The cache-read ratio for the model actually in use, read from the price table
 * at the moment of the assessment. No ratio, exchange factor or output multiple
 * is a literal anywhere in this module, and a table that cannot be read or does
 * not carry the model produces a refusal: a guessed price would move every
 * number downstream of it. The house tariff's own table is a configured file
 * (lib/tariff.ts), so a machine with no such file refuses here too rather than
 * price from the module's example rates.
 */
export function readPrice(
	modelId: string | null | undefined,
	path: string = MODELS_PATH,
): { ok: true; price: PriceFacts } | { ok: false; reason: string } {
	if (typeof modelId !== "string" || modelId.trim() === "") {
		return {
			ok: false,
			reason:
				"no model id was given: the cache-read ratio belongs to the model in use, and only the caller knows which model that is.",
		};
	}
	// The HOUSE TARIFF first. The registry's rows for this model are zeroed on
	// purpose (see @tinoy/pi-tariff): pi fills its own cost notice from that metadata,
	// and the zeros are what keep pi's flat `$` figure from competing with the house
	// tariff. Looking this model up in the registry would therefore refuse a model
	// that is perfectly well priced.
	const want = modelId.trim();
	if (HOUSE_TARIFF_MODELS.includes(want)) {
		// The house tariff refuses when this machine has no configured table: a price
		// derived from its example rates would move every number downstream.
		const tariff = loadTariff();
		if (!tariff.ok) return { ok: false, reason: tariff.reason };
		const { r, mult, outputPerInput } = ratios(tariff.table);
		return {
			ok: true,
			price: {
				modelId: want,
				source: "house-tariff",
				// The USD valley column: the comparable unit for a dollar-denominated
				// decision. The RATIOS are the same in every column and window.
				input: tariff.table.usd.valley.cacheMiss,
				cacheRead: tariff.table.usd.valley.cacheHit,
				r,
				mult,
				outputPerInput,
			},
		};
	}
	let table: unknown;
	try {
		table = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		return {
			ok: false,
			reason: `the price table ${path} could not be read (${e instanceof Error ? e.message : String(e)}) — this module refuses rather than guess a cache-read ratio.`,
		};
	}
	const providers = (
		table as {
			providers?: Record<
				string,
				{
					models?: Array<{
						id?: unknown;
						cost?: { input?: unknown; cacheRead?: unknown; output?: unknown };
					}>;
				}
			>;
		}
	).providers;
	const rows: Array<{ input: number; cacheRead: number; output: number }> = [];
	for (const [providerId, provider] of Object.entries(providers ?? {})) {
		for (const model of provider?.models ?? []) {
			if (model?.id !== want && `${providerId}/${String(model?.id)}` !== want) continue;
			const cost = model.cost ?? {};
			const num = (v: unknown): number =>
				typeof v === "number" && Number.isFinite(v) ? v : Number.NaN;
			rows.push({
				input: num(cost.input),
				cacheRead: num(cost.cacheRead),
				output: num(cost.output),
			});
		}
	}
	if (rows.length === 0)
		return { ok: false, reason: `no price row for model '${want}' in ${path}.` };
	if (rows.length > 1)
		return {
			ok: false,
			reason: `${rows.length} price rows in ${path} match model '${want}' — refusing to pick one.`,
		};
	const { input, cacheRead, output } = rows[0];
	// A row with a zero input price, a zero read price, or a read at or above the
	// input price has no ratio in it (the providers' free rows are exactly this).
	if (!(input > 0) || !(cacheRead > 0) || !(output > 0) || cacheRead >= input) {
		return {
			ok: false,
			reason: `model '${want}' carries no usable price row in ${path} (input ${input}, cacheRead ${cacheRead}, output ${output}): no ratio can be derived from it.`,
		};
	}
	const r = cacheRead / input;
	return {
		ok: true,
		price: {
			modelId: want,
			source: "model-registry",
			input,
			cacheRead,
			r,
			mult: (1 - r) / r,
			outputPerInput: output / input,
		},
	};
}

/**
 * The crew's reuse window, from its single owner (`config.json`). It is a
 * different clock from the provider cache floor above: inside the window a
 * worker can be assigned, and past it the only cheap moment to clock one out is
 * while its context is still cache-warm. Returns null — never a substitute — when
 * the file or the field is unusable, because a default window would move the
 * boundary this module reports against.
 */
export function loadReuseWindowMs(dir: string = FLEET_DIR): number | null {
	try {
		const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
			reuseWindowSeconds?: unknown;
		};
		const seconds = cfg?.reuseWindowSeconds;
		return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
			? seconds * 1000
			: null;
	} catch {
		return null;
	}
}

// ── I/O: the log ──

export type RetireDecision = "reset" | "retire" | "keep";

export interface RetireLogRow {
	at: number;
	worker: string;
	decision: RetireDecision | "refusal";
	reason: string;
	W?: number;
	B?: number;
	m?: number;
	kHat?: number;
	/** Null when no break-even exists (nothing stale): JSON has no infinity. */
	kStar?: number | null;
	x?: number;
	stale?: number;
	r?: number;
	mult?: number;
	alarms?: string[];
}

/** One JSON line, appended. Never throws: a log failure must not reach the
 *  caller, and the assessment stands whether or not it was recorded. */
export function appendRetireLog(row: RetireLogRow, path: string = RETIRE_LOG_PATH): boolean {
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify(row)}\n`);
		return true;
	} catch {
		return false;
	}
}

// ── Pure: the measurements the caller cannot take here ──

/**
 * B: the baseline working set a fresh worker converges to, as the smallest of
 * the per-run windows measured just after each run's FIRST completed item.
 * Callers must supply those windows and never a fresh session's first window:
 * a first window is a LOWER bound on B, and substituting it inflates (W − B),
 * which shrinks K* and makes the rule fire far too readily. Null when nothing
 * has been measured — a missing B is not a zero.
 */
export function baselineWindow(samplesAfterFirstItem: number[]): number | null {
	const usable = samplesAfterFirstItem.filter((s) => Number.isFinite(s) && s > 0);
	return usable.length > 0 ? Math.min(...usable) : null;
}

/**
 * m: the handoff length in tokens, as the MEDIAN of recent handoffs' output
 * tokens — the median so one enormous handoff cannot set the price of every
 * retirement. Null when no handoff has been measured.
 */
export function handoffTokens(outputTokens: number[]): number | null {
	const usable = outputTokens.filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
	if (usable.length === 0) return null;
	const mid = Math.floor(usable.length / 2);
	return usable.length % 2 === 1 ? usable[mid] : Math.round((usable[mid - 1] + usable[mid]) / 2);
}

// ── Pure: the projection ──

export interface KhatInput {
	/** Requests each of the worker's completed items took, oldest first. */
	perItemRequests: number[];
	pendingItems: number;
}

export interface Khat {
	kHat: number;
	basis: "run-rate" | "ledger" | "none";
	runRate: number | null;
}

/**
 * K̂: the remaining requests, forecast PESSIMISTICALLY — the smaller of a
 * trailing run-rate projection and a ledger projection, at a lower quantile
 * rather than the mean, scaled down by a safety margin and capped by a bounded
 * horizon. A zero here is a real answer: with no pending work, or no per-item
 * rate to project from, cost-based retirement buys nothing.
 */
export function projectRemainingRequests(i: KhatInput): Khat {
	const pending = Number.isFinite(i.pendingItems) && i.pendingItems > 0 ? i.pendingItems : 0;
	const trailing = i.perItemRequests
		.filter((n) => Number.isFinite(n) && n > 0)
		.slice(-TRAILING_ITEMS);
	if (pending === 0 || trailing.length === 0) return { kHat: 0, basis: "none", runRate: null };
	const sorted = [...trailing].sort((a, b) => a - b);
	const runRate = sorted[Math.floor(K_RATE_QUANTILE * (sorted.length - 1))];
	const runProjection = runRate * pending;
	const ledgerProjection = LEDGER_RUNS_PER_ITEM * pending;
	const smaller = Math.min(runProjection, ledgerProjection);
	return {
		kHat: Math.min(K_HORIZON_REQUESTS, Math.floor(smaller * K_SAFETY_MARGIN)),
		basis: runProjection <= ledgerProjection ? "run-rate" : "ledger",
		runRate,
	};
}

// ── Pure: the cost of replacing ──

export interface ReplacementCostInput {
	/** The warm worker's current context, in tokens. */
	W: number;
	/** The baseline working set a fresh worker converges to. */
	B: number;
	/** The fixed system-and-tools prefix, which is byte-identical across the
	 *  fleet and therefore already hot. Zero when unmeasured, which leaves X at
	 *  its largest and is the pessimistic direction. */
	F0: number;
	/** The handoff length in tokens. */
	m: number;
	/** Mean output tokens per request. */
	obar: number;
	/** cacheRead/input, from the price table. */
	r: number;
	/** Extra requests a replacement needs to re-bootstrap. */
	eta: number;
	/** output/input, from the price table. */
	outputPerInput: number;
	/** How long the worker has been idle. */
	idleMs: number;
}

export interface ReplacementCost {
	/** W − B: the context the warm worker carries beyond a fresh one. */
	stale: number;
	coldHandoff: boolean;
	/** The re-read a handoff written from a cache-expired context costs. */
	coldSurcharge: number;
	/** X at a warm context. */
	oneTimeWarm: number;
	/** X: the one-time cost of replacing, in input-token equivalents. */
	oneTime: number;
}

export function replacementCost(i: ReplacementCostInput): ReplacementCost {
	const stale = i.W - i.B;
	// The handoff is authored FROM this context, so a context past the cache
	// floor pays the miss price on all of W instead of the read price.
	const coldHandoff = i.idleMs >= PROVIDER_CACHE_FLOOR_MS;
	const coldSurcharge = coldHandoff ? (1 - i.r) * i.W : 0;
	const oneTimeWarm =
		Math.max(0, i.B - i.F0) +
		i.outputPerInput * i.m +
		i.eta * (i.r * i.B + i.outputPerInput * i.obar);
	return { stale, coldHandoff, coldSurcharge, oneTimeWarm, oneTime: oneTimeWarm + coldSurcharge };
}

/** K*: the future requests a replacement needs in order to recoup its own cost.
 *  Infinite when nothing is stale, because the warm worker then saves nothing per
 *  request and no number of future requests breaks even. */
export function breakEvenRequests(oneTime: number, stale: number, mult: number): number {
	if (!(stale > 0)) return Number.POSITIVE_INFINITY;
	return Math.ceil((BREAK_EVEN_MARGIN * mult * oneTime) / stale);
}

// ── Pure: the assessment ──

export type Backstop = "correctness" | "deep-in-the-money";
export type IdleState = "warm" | "past-window" | "cold";

export interface AssessmentInput {
	/** The roster name, for the log line. */
	worker: string;
	nowMs: number;
	// measured
	W: number;
	B: number;
	F0: number;
	m: number;
	obar: number;
	contextLimit: number;
	windowPeak: number | null;
	lifetimeTokens: number;
	idleMs: number;
	reuseWindowMs: number;
	// from the price table
	r: number;
	mult: number;
	outputPerInput: number;
	// the forecast's evidence
	perItemRequests: number[];
	pendingItems: number;
	// guard state, read from the roster, the ledger and the worker's own record
	midStep: boolean;
	familyShift: boolean;
	handoffCurrent: boolean;
	itemsSinceHire: number;
	/** NULL means the caller cannot tell — see WorkerFacts. */
	nonHandoffableState: boolean | null;
	lastSignalAtMs: number | null;
	fleetRetirementTimesMs: number[];
	lineageDepth: number | null;
}

export interface Assessment {
	worker: string;
	at: number;
	decision: RetireDecision;
	/** True when the economy alone would fire, whether or not a guard suppressed
	 *  it — the log needs the model's own answer to be scoreable. */
	economical: boolean;
	backstop: Backstop | null;
	alarms: string[];
	reasons: string[];
	kHat: number;
	kStar: number;
	projection: Khat;
	cost: ReplacementCost;
	idleState: IdleState;
	reuseWindowMs: number;
	W: number;
	B: number;
	m: number;
	/** The price facts this assessment was taken with, for the log line. */
	r: number;
	mult: number;
}

/**
 * The decision. Backstops are settled first and independently of every economic
 * guard: a context that cannot hold the next step, or one so far in the money
 * that replacement is already overdue, forces a reset at the next step boundary
 * whatever the projection says. Otherwise the economy decides, and any one guard
 * suppresses it — the asymmetry is deliberate: a false positive saves nothing and
 * wastes a handoff and a replacement, while a bad handoff costs a deliverable.
 */
export function assessRetirement(i: AssessmentInput): Assessment {
	// eta is this module's own guess constant, not a caller measurement: see
	// ETA_BOOTSTRAP_REQUESTS. Everything else is measured.
	const cost = replacementCost({
		W: i.W,
		B: i.B,
		F0: i.F0,
		m: i.m,
		obar: i.obar,
		r: i.r,
		eta: ETA_BOOTSTRAP_REQUESTS,
		outputPerInput: i.outputPerInput,
		idleMs: i.idleMs,
	});
	const projection = projectRemainingRequests({
		perItemRequests: i.perItemRequests,
		pendingItems: i.pendingItems,
	});
	const kHat = projection.kHat;
	const kStar = breakEvenRequests(cost.oneTime, cost.stale, i.mult);
	const idleState: IdleState =
		i.idleMs >= PROVIDER_CACHE_FLOOR_MS
			? "cold"
			: i.idleMs > i.reuseWindowMs
				? "past-window"
				: "warm";

	const alarms: string[] = [];
	if (i.lifetimeTokens >= BUDGET_ALARM_TOKENS) {
		alarms.push(
			`budget alarm: lifetime ${i.lifetimeTokens} tokens is at or above ${BUDGET_ALARM_TOKENS} — cumulative spend, so this alarms and does not retire`,
		);
	}

	let backstop: Backstop | null = null;
	if (i.contextLimit > 0 && i.W >= CORRECTNESS_CAP_FRACTION * i.contextLimit)
		backstop = "correctness";
	else if (cost.stale >= DEEP_IN_THE_MONEY_TOKENS) backstop = "deep-in-the-money";

	const economical = kHat > kStar;
	// Nothing stale means no break-even exists to compare against, and that is a
	// quantity rather than a failure: it prints as a word, never as a digit.
	const kStarText = Number.isFinite(kStar)
		? `K* ${kStar}`
		: "K* none (W ≤ B, so the warm worker saves nothing per request)";
	const basis =
		`K̂ ${kHat} (${projection.basis}${projection.runRate === null ? "" : `, ${projection.runRate} requests/item`}) vs ${kStarText}: ` +
		`W ${i.W} − B ${i.B} = ${cost.stale} stale, X ${Math.round(cost.oneTime)} input-token equivalents, MULT ${i.mult.toFixed(3)} from r ${i.r.toFixed(5)}`;
	const common = {
		worker: i.worker,
		at: i.nowMs,
		economical,
		backstop,
		alarms,
		kHat,
		kStar,
		projection,
		cost,
		idleState,
		reuseWindowMs: i.reuseWindowMs,
		W: i.W,
		B: i.B,
		m: i.m,
		r: i.r,
		mult: i.mult,
	};

	if (backstop !== null) {
		const reasons = [
			backstop === "correctness"
				? `correctness cap: W ${i.W} is at or above ${CORRECTNESS_CAP_FRACTION} of the ${i.contextLimit}-token context limit — reset at the next step boundary`
				: `deep in the money: W − B ${cost.stale} is at or above ${DEEP_IN_THE_MONEY_TOKENS} — reset at the next step boundary regardless of K̂`,
		];
		if (economical) reasons.push(`the economy agrees: ${basis}`);
		else reasons.push(basis);
		return { ...common, decision: "reset", reasons };
	}

	const guards: string[] = [];
	if (i.midStep)
		guards.push(
			"mid-step: a wind-down would land inside a step, so the retire waits for a step boundary",
		);
	if (i.familyShift)
		guards.push(
			"family shift: the next items are a new kind of work — retire by DISCARD instead, which needs no handoff and no replacement",
		);
	if (!i.handoffCurrent)
		guards.push(
			"the handoff is not current: retiring now would pay a stale handoff, the expensive failure this rule exists to avoid",
		);
	if (
		i.windowPeak !== null &&
		i.windowPeak > 0 &&
		i.windowPeak - i.W >= COMPACTION_GUARD_FRACTION * i.windowPeak
	) {
		guards.push(
			`just compacted: the context is ${i.windowPeak - i.W} tokens below its peak of ${i.windowPeak}, and compaction dominates a retirement wherever it is quality-equivalent`,
		);
	}
	if (cost.stale < STAKES_FLOOR_TOKENS)
		guards.push(`stakes floor: W − B ${cost.stale} is below ${STAKES_FLOOR_TOKENS}`);
	if (i.itemsSinceHire < MIN_ITEMS_SINCE_HIRE)
		guards.push(
			`too early: ${i.itemsSinceHire} completed items since hire, below ${MIN_ITEMS_SINCE_HIRE}`,
		);
	if (i.nonHandoffableState === null) {
		guards.push(
			"cannot check whether this worker holds uncommitted work or a running subprocess, so the economic path stays silent: a handoff that lost that state would cost a deliverable, which no saving in cents can offset",
		);
	} else if (i.nonHandoffableState) {
		guards.push(
			"non-handoff-able state is held (a running subprocess, uncommitted work): a handoff would lose it",
		);
	}
	if (i.lastSignalAtMs !== null && i.nowMs - i.lastSignalAtMs < SIGNAL_COOLDOWN_MS) {
		guards.push(
			`cooldown: ${human(i.nowMs - i.lastSignalAtMs)} since the last signal for this worker`,
		);
	}
	const recentRetirements = i.fleetRetirementTimesMs.filter(
		(t) => Number.isFinite(t) && i.nowMs - t < FLEET_CAP_WINDOW_MS,
	).length;
	if (recentRetirements >= FLEET_RETIREMENT_CAP) {
		guards.push(
			`fleet rate cap: ${recentRetirements} retirements in the last ${human(FLEET_CAP_WINDOW_MS)}`,
		);
	}
	if (i.lineageDepth === null) {
		guards.push(
			"the handoff lineage depth is not tracked, so the economic path stays silent rather than risking a chain of handoffs on an optimistic forecast",
		);
	} else if (i.lineageDepth >= MAX_HANDOFF_LINEAGE) {
		guards.push(
			`handoff lineage ${i.lineageDepth} is at the cap of ${MAX_HANDOFF_LINEAGE}: another handoff on this scope repeats the same forecast — redistribute or discard instead`,
		);
	}

	const reasons = [...guards];
	if (kHat === 0) {
		reasons.push(
			i.pendingItems > 0
				? `K̂ is zero: no per-item rate to project from yet, and cost-based retirement buys nothing without a forecast`
				: "K̂ is zero: nothing is pending, and cost-based retirement buys nothing for an idle worker",
		);
	} else if (economical && guards.length === 0) {
		reasons.push(basis);
		if (idleState === "past-window") {
			reasons.push(
				`past the crew's reuse window of ${human(i.reuseWindowMs)} (idle ${human(i.idleMs)}): the worker can no longer be assigned, so the choice is this retirement or a cold resume`,
			);
		}
		if (idleState === "cold") {
			reasons.push(
				`past the provider cache floor: a handoff now pays a re-read of ${Math.round(cost.coldSurcharge)} tokens, which the cost of replacing above already carries`,
			);
		}
	} else {
		reasons.push(basis);
	}

	const decision: RetireDecision =
		economical && guards.length === 0 && kHat > 0 ? "retire" : "keep";
	return { ...common, decision, reasons };
}

/** The log line for an assessment: the quantities that make the rule scoreable. */
export function retireLogRow(a: Assessment): RetireLogRow {
	return {
		at: a.at,
		worker: a.worker,
		decision: a.decision,
		reason: a.reasons.join("; "),
		W: a.W,
		B: a.B,
		m: a.m,
		kHat: a.kHat,
		kStar: Number.isFinite(a.kStar) ? a.kStar : null,
		x: Math.round(a.cost.oneTime),
		stale: a.cost.stale,
		r: a.r,
		mult: a.mult,
		alarms: a.alarms,
	};
}

// ── I/O: the whole assessment ──

export interface WorkerFacts {
	worker: string;
	/** The worker's CURRENT context window — `status.workerUsage().window`, read
	 *  from the run's own record. Never the high-water mark: W − B drives the whole
	 *  comparison, and a peak can only overstate what the worker carries now. */
	W: number;
	B: number;
	F0: number;
	m: number;
	obar: number;
	contextLimit: number;
	/** The highest window the worker's runs reached — `status.workerUsage().windowPeak`
	 *  — used ONLY by the compaction guard, where a recent drop from the peak is
	 *  the evidence that a compaction just happened. */
	windowPeak: number | null;
	lifetimeTokens: number;
	idleMs: number;
	perItemRequests: number[];
	pendingItems: number;
	midStep: boolean;
	familyShift: boolean;
	handoffCurrent: boolean;
	itemsSinceHire: number;
	nonHandoffableState: boolean | null;
	lastSignalAtMs: number | null;
	fleetRetirementTimesMs: number[];
	lineageDepth: number | null;
}

export type RetireCheck = { ok: true; assessment: Assessment } | { ok: false; reason: string };

/**
 * The fleet-wide rate cap's input: how recently this crew retired anyone, read from
 * the assessment log this module already writes. A cap assumed to be empty is not a
 * cap — it would let the rule clock out the whole crew inside one window.
 */
export function recentRetirementTimesMs(logPath: string = RETIRE_LOG_PATH, rows = 200): number[] {
	try {
		const lines = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).slice(-rows);
		const times: number[] = [];
		for (const line of lines) {
			const row = JSON.parse(line) as { at?: unknown; decision?: unknown };
			if (row.decision === "retire" && typeof row.at === "number") times.push(row.at);
		}
		return times;
	} catch {
		return [];
	}
}

/**
 * The model's context window — the ONE field `models.json` still carries for a
 * tariff-priced model, because only the COST fields were zeroed. The correctness
 * cap is the backstop that needs it, and a zero means "unknown", which disables
 * that cap rather than inventing a limit.
 */
export function contextWindowOf(
	modelId: string | null | undefined,
	path: string = MODELS_PATH,
): number {
	if (typeof modelId !== "string" || modelId.trim() === "") return 0;
	try {
		const table = JSON.parse(readFileSync(path, "utf8")) as {
			providers?: Record<
				string,
				{ models?: Array<{ id?: unknown; contextWindow?: unknown; maxTokens?: unknown }> }
			>;
		};
		const want = modelId.trim();
		for (const [providerId, provider] of Object.entries(table.providers ?? {})) {
			for (const model of provider?.models ?? []) {
				if (model?.id !== want && `${providerId}/${String(model?.id)}` !== want) continue;
				if (typeof model.contextWindow === "number" && model.contextWindow > 0)
					return model.contextWindow;
				return typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : 0;
			}
		}
	} catch {
		/* unknown is zero, never a guess */
	}
	return 0;
}

/** Where the house cache-prefix log lives, mirroring its owner in the cache-prefix-log package. */
export function prefixLogPath(): string {
	if (process.env.PI_CACHE_PREFIX_LOG) return process.env.PI_CACHE_PREFIX_LOG;
	const state = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/root", ".local", "state");
	return join(state, "pi", "cache-prefix-log.jsonl");
}

/**
 * F0: the fixed system-and-tools prefix, in tokens — byte-identical across the
 * fleet, so it is usually already hot and enters X as a subtraction. Measured from
 * the house cache log, which records both sizes for every request, converted at
 * four characters per token. That conversion is an ESTIMATE and is labelled as
 * one: overestimating F0 would understate the cost of replacing a worker and tilt
 * the rule toward retiring. The median of recent rows, so one outsized tool schema
 * cannot set it.
 */
export function readPrefixTokens(path: string = prefixLogPath(), rows = 50): number | null {
	try {
		const lines = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).slice(-rows);
		const samples: number[] = [];
		for (const line of lines) {
			const row = JSON.parse(line) as { sysChars?: unknown; toolsChars?: unknown };
			const chars =
				(typeof row.sysChars === "number" ? row.sysChars : 0) +
				(typeof row.toolsChars === "number" ? row.toolsChars : 0);
			if (chars > 0) samples.push(chars);
		}
		if (samples.length === 0) return null;
		samples.sort((a, b) => a - b);
		const mid = Math.floor(samples.length / 2);
		const median =
			samples.length % 2 === 1 ? samples[mid] : Math.round((samples[mid - 1] + samples[mid]) / 2);
		return Math.max(1, Math.round(median / 4));
	} catch {
		return null;
	}
}

/**
 * The one entry point that touches the filesystem: read the price table for the
 * model in use, read the crew's reuse window from its single owner, assess, and
 * record the assessment. A missing price table, price row or config file is a
 * refusal — logged as its own line, never papered over with a default.
 */
export function checkRetirement(
	facts: WorkerFacts,
	opts: {
		modelId?: string | null;
		nowMs?: number;
		modelsPath?: string;
		fleetDir?: string;
		logPath?: string;
	} = {},
): RetireCheck {
	const nowMs = opts.nowMs ?? Date.now();
	const price = readPrice(opts.modelId, opts.modelsPath ?? MODELS_PATH);
	if (!price.ok) {
		appendRetireLog(
			{ at: nowMs, worker: facts.worker, decision: "refusal", reason: price.reason },
			opts.logPath,
		);
		return { ok: false, reason: price.reason };
	}
	const fleetDir = opts.fleetDir ?? FLEET_DIR;
	const reuseWindowMs = loadReuseWindowMs(fleetDir);
	if (reuseWindowMs === null) {
		const reason = `the crew's reuse window could not be read from config.json in ${fleetDir} — this module never substitutes a window of its own.`;
		appendRetireLog({ at: nowMs, worker: facts.worker, decision: "refusal", reason }, opts.logPath);
		return { ok: false, reason };
	}
	const assessment = assessRetirement({
		...facts,
		nowMs,
		reuseWindowMs,
		// The window the registry still carries, when the caller could not source it.
		contextLimit:
			facts.contextLimit > 0
				? facts.contextLimit
				: contextWindowOf(opts.modelId, opts.modelsPath ?? MODELS_PATH),
		r: price.price.r,
		mult: price.price.mult,
		outputPerInput: price.price.outputPerInput,
	});
	appendRetireLog(retireLogRow(assessment), opts.logPath);
	return { ok: true, assessment };
}
