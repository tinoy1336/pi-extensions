/**
 * The house price table's contract: ONE owner, read by both consumers — the cost
 * footer prices from it, and the fleet's retirement economics derive the cache-read
 * ratio from it. A second copy of these numbers anywhere would let one consumer
 * decide against last month's table while the other reported this month's.
 *
 * NO RATE IS IN THIS FILE, and none is compiled into it. The table is DATA, read
 * from the configured file (`PI_TARIFF_CONFIG`, else `tariff.json` in the agent
 * directory beside `models.json`). It is THIS MACHINE'S PRIVATE TABLE: the packages
 * that read it are publishable, so that file is never part of a published payload —
 * with `PI_TARIFF_CONFIG` it can live anywhere the pack does not reach. The file is
 * read once when this module is first imported, so an edit is live in the NEXT
 * session, never in the running one.
 *
 * WHAT AN UNCONFIGURED MACHINE GETS: a REFUSAL, never a price. `TARIFF.ok` is
 * false and `TARIFF.reason` names the file to write and the shape to write in it,
 * because a rate that is not the one this machine is billed at is worse than no
 * figure at all. `EXAMPLE_TARIFF` documents that shape in code and supplies the
 * example inside the refusal; it holds a synthetic 1 : 10 : 100 ladder that is no
 * vendor's tariff, and nothing prices from it. Each consumer decides how a refusal
 * surfaces: the cost footer registers no pricing at all and leaves its figure
 * empty, while the fleet's retirement check returns its own typed refusal naming
 * the same file — the shape it already used for a model whose registry row carries
 * no ratio.
 *
 * Why not the model registry: `~/.pi/agent/models.json` deliberately carries a
 * ZEROED cost row for the Flash model — pi fills its own cost notice from that
 * metadata, and the zeros are what stop pi's flat `$` figure from competing with
 * the house tariff. The registry's real numbers sit on the V4 Pro row, which is a
 * different model's price. Reading the registry for the running model therefore
 * yields no ratio at all, which is exactly why this module exists.
 *
 * Peak and valley are the two windows of the vendor's own schedule; the clock that
 * selects between them belongs to the consumer that needs one. The RATIOS below are
 * DERIVED from the configured table, and are identical in both windows and both
 * currency columns for a table with that property, so a retirement decision does
 * not depend on the time of day.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookLog } from "@tinoy/pi-ext-lib";

/** A price window. Which one applies at a given moment is the consumer's clock. */
export type Window = "valley" | "peak";

/** The windows in a fixed order, so validation and iteration never disagree. */
export const WINDOWS: readonly Window[] = ["valley", "peak"];

/** One window's rates, per 1M tokens. */
export interface TariffRow {
	/** Tokens served from the provider's prompt cache. */
	cacheHit: number;
	/** Tokens sent uncached. DeepSeek bills a cache WRITE at this same rate. */
	cacheMiss: number;
	output: number;
}

/** One currency column of the table: a row per window. */
export type TariffTable = Record<Window, TariffRow>;

/** The whole table: the vendor's two currency columns. */
export interface TariffConfig {
	cny: TariffTable;
	usd: TariffTable;
}

/**
 * Where the table is read from: `PI_TARIFF_CONFIG` when set, else `tariff.json` in
 * the agent directory (`$PI_CODING_AGENT_DIR`, default `~/.pi/agent`) — machine
 * private space, which is what keeps the operator's own rates out of every
 * published payload.
 */
export const TARIFF_CONFIG_PATH: string = (() => {
	const override = process.env.PI_TARIFF_CONFIG?.trim();
	if (override && override !== "") return override;
	const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
	return join(
		agentDir && agentDir !== "" ? agentDir : join(homedir(), ".pi", "agent"),
		"tariff.json",
	);
})();

/**
 * THE EXAMPLE TABLE — a synthetic 1 : 10 : 100 ladder (0.7 / 7 / 70 per unit),
 * deliberately not any vendor's rates and sharing no figure with this machine's
 * own table. It exists so the file's shape is documented in code and so the
 * refusal below can print the exact shape it wants; NO consumer prices from it,
 * and a machine with no configured table prices nothing at all.
 */
export const EXAMPLE_TARIFF: TariffConfig = {
	cny: {
		valley: { cacheHit: 0.7, cacheMiss: 7, output: 70 },
		peak: { cacheHit: 1.4, cacheMiss: 14, output: 140 },
	},
	usd: {
		valley: { cacheHit: 0.07, cacheMiss: 0.7, output: 7 },
		peak: { cacheHit: 0.14, cacheMiss: 1.4, output: 14 },
	},
};

/** A JSON value that is a plain object: not null, not an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The keys a config object may carry at its own level; `$comment` is carried
 *  through the file for a reader and ignored here (JSON has no comments). */
const TOP_KEYS: readonly string[] = ["$comment", "cny", "usd"];

/** One rate: a finite number above zero. Nothing else has a meaning as a price. */
function rate(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** One window's row, or the reason it cannot be used. */
function rowOf(value: unknown, where: string): TariffRow | string {
	if (!isRecord(value)) return `${where} is not an object`;
	const unknown = Object.keys(value).find(
		(k) => k !== "cacheHit" && k !== "cacheMiss" && k !== "output",
	);
	if (unknown !== undefined) return `${where} carries an unknown key '${unknown}'`;
	const cacheHit = rate(value.cacheHit);
	const cacheMiss = rate(value.cacheMiss);
	const output = rate(value.output);
	if (cacheHit === null) return `${where}.cacheHit is not a finite number above zero`;
	if (cacheMiss === null) return `${where}.cacheMiss is not a finite number above zero`;
	if (output === null) return `${where}.output is not a finite number above zero`;
	// A read at or above the miss price has no ratio in it: `r` would reach 1 and
	// `mult` would come out zero or negative, which the retirement economics reads
	// as a saving that does not exist.
	if (cacheHit >= cacheMiss) {
		return `${where}.cacheHit (${cacheHit}) is not below its cacheMiss (${cacheMiss}): no cache-read ratio can be derived from it`;
	}
	return Object.freeze({ cacheHit, cacheMiss, output });
}

/** One currency column, or the reason it cannot be used. */
function columnOf(value: unknown, name: string): TariffTable | string {
	if (!isRecord(value)) return `'${name}' is not an object`;
	const unknown = Object.keys(value).find((k) => !WINDOWS.includes(k as Window));
	if (unknown !== undefined) return `'${name}' carries an unknown window '${unknown}'`;
	const rows: Record<string, TariffRow> = {};
	for (const window of WINDOWS) {
		const row = rowOf(value[window], `${name}.${window}`);
		if (typeof row === "string") return row;
		rows[window] = row;
	}
	return Object.freeze(rows) as TariffTable;
}

/** The table a config text describes, or the reason it cannot be used. Every
 *  column and window is required: a partly-specified table would silently mix the
 *  configured rates with something else, which is the drift this module exists to
 *  prevent. */
function parseTariff(text: string, path: string): TariffConfig | string {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		return `${path} is not valid JSON (${e instanceof Error ? e.message : String(e)})`;
	}
	if (!isRecord(raw)) return `${path} does not hold a JSON object`;
	const unknown = Object.keys(raw).find((k) => !TOP_KEYS.includes(k));
	if (unknown !== undefined) return `${path} carries an unknown key '${unknown}'`;
	const cny = columnOf(raw.cny, "cny");
	if (typeof cny === "string") return `${path}: ${cny}`;
	const usd = columnOf(raw.usd, "usd");
	if (typeof usd === "string") return `${path}: ${usd}`;
	return Object.freeze({ cny, usd });
}

/**
 * The refusal: the file to write and the shape to write in it, taken from
 * EXAMPLE_TARIFF so the text cannot drift from the shape the validator accepts.
 * The numbers printed are the synthetic ladder, never a rate this machine is
 * billed at.
 */
const SHAPE_HINT = `write ${TARIFF_CONFIG_PATH} with this machine's own rates, per 1M tokens, in this shape: ${JSON.stringify(EXAMPLE_TARIFF)} — both currencies and both windows are required`;

/** What the table is, or why there is none. */
export type TariffLoad =
	| { ok: true; table: TariffConfig; path: string }
	| { ok: false; reason: string; path: string };

/** The live table: the configured file's rates, or a refusal. */
export const TARIFF: TariffLoad = (() => {
	let text: string;
	try {
		text = readFileSync(TARIFF_CONFIG_PATH, "utf8");
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		return {
			ok: false,
			path: TARIFF_CONFIG_PATH,
			reason: `no tariff table is configured: ${SHAPE_HINT} (reading ${TARIFF_CONFIG_PATH} failed: ${message})`,
		};
	}
	const parsed = parseTariff(text, TARIFF_CONFIG_PATH);
	return typeof parsed === "string"
		? {
				ok: false,
				path: TARIFF_CONFIG_PATH,
				reason: `the tariff table is unusable: ${parsed} — ${SHAPE_HINT}`,
			}
		: { ok: true, table: parsed, path: TARIFF_CONFIG_PATH };
})();

/**
 * The configured table, or a throw carrying the refusal reason — the ONE gate a
 * pricer goes through, so a machine with no table cannot produce a figure derived
 * from the example ladder or from any substituted default.
 */
export function liveTariff(): TariffConfig {
	if (!TARIFF.ok) throw new Error(TARIFF.reason);
	return TARIFF.table;
}

// One line, once per process, naming the file to write: a session must not have to
// infer from an empty figure that no table was configured. The read above and this
// line are the module's whole load-time work, and both are inside the refusal
// contract: neither can throw.
if (!TARIFF.ok) hookLog("tariff", "no-table", { path: TARIFF.path, reason: TARIFF.reason });

/**
 * The model ids billed at this tariff. Their registry rows are the zeroed ones
 * described above, so a consumer that finds no usable row for one of these is
 * looking in the wrong place rather than at an unpriced model.
 */
export const HOUSE_TARIFF_MODELS: readonly string[] = ["deepseek-flash"];

export interface Ratios {
	/** cache-read / cache-miss — a read costs this fraction of a re-sent token. */
	r: number;
	/** (1 − r)/r — input-token equivalents one read-priced token is worth. */
	mult: number;
	/** output / cache-miss — the multiple the handoff term is scaled by. */
	outputPerInput: number;
}

/**
 * The ratios a retirement decision needs, DERIVED from the given table rather than
 * written as literals: r comes out of cacheHit/cacheMiss and q out of
 * output/cacheMiss. The table is a parameter — this function reads nothing global
 * and so cannot price from a table the caller did not choose.
 *
 * The ratios are identical across the two windows and the two currency columns for
 * the vendor's table, which is why the callers take one window; if a table ever
 * breaks that equality, this function is the single place that has to decide which
 * window applies, and the callers do not change.
 */
export function ratios(
	table: TariffConfig,
	column: "usd" | "cny" = "usd",
	window: Window = "valley",
): Ratios {
	const row = (column === "usd" ? table.usd : table.cny)[window];
	const r = row.cacheHit / row.cacheMiss;
	return { r, mult: (1 - r) / r, outputPerInput: row.output / row.cacheMiss };
}
