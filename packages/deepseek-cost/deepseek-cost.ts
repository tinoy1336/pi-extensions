/**
 * deepseek-cost: a CNY session cost that stays true across peak and valley.
 *
 * pi prices a model with ONE flat `cost` object, so it cannot express either a
 * currency (its footer always prints `$`) or DeepSeek's peak/valley tariff. This
 * extension owns the authoritative number instead:
 *
 *   - every assistant message is priced at the tariff in force AT ITS OWN
 *     timestamp, so a session that runs across a window boundary — or across
 *     several — accumulates correctly; a RESUMED session is restored in full at
 *     session_start by pricing its own restored entries once, each at its own
 *     timestamp, so the footer figure survives a restart;
 *   - SUBAGENT sessions are included: pi-subagents persists each child's own
 *     session jsonl under `<parent session dir>/<childRunId>/run-<n>/`, and the
 *     child's assistant messages carry the same usage + timestamp shape as the
 *     parent's, so they are priced with the SAME tariff model and at the
 *     child's own timestamps, and summed into the SAME total: the footer figure
 *     is the whole account — this session plus every child it spawned — with no
 *     separate child figure and no marker to explain;
 *   - the running total is shown in the footer in BOTH currencies with the
 *     window it is currently in, next to pi's own `$` figure.
 *
 * The rates are not in this file: `@tinoy/pi-tariff` owns the table and reads it
 * from `tariff.json` in this directory, and the module compiles no rate of its
 * own — a machine with no such file prices NOTHING and gets a refusal naming the
 * file to write (see the header of `@tinoy/pi-tariff`). The footer then stays
 * empty, rather than showing a figure derived from the module's example table.
 * Peak = Beijing time, Monday–Friday 09:00–12:00 and 14:00–18:00; everything
 * else (including all weekend) is valley. V4 Pro is priced by its own entry in
 * models.json and is not handled here.
 *
 * Subagent sources and why they are not used: the async run receipts under
 * /tmp/pi-subagents-uid-1000/ (status.json, events.jsonl, recovery-descriptor)
 * carry a run TOTAL per child (input/output/cacheRead/cacheWrite) but no
 * per-request timestamps, so they cannot be priced at the tariff in force when
 * each request was made — and the child session jsonl they point at carries
 * exactly those messages, so a receipt is redundant. Only session files are
 * read; each file is priced once (incremental byte offset), so a child that has
 * both a session file and a receipt can never be counted twice.
 *
 * Cosmetic-by-contract at the edges: any failure leaves the footer untouched.
 */

import type { Dirent } from "node:fs";
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hookLog } from "@tinoy/pi-ext-lib";
import { liveTariff, loadTariff, type TariffTable, type Window } from "@tinoy/pi-tariff";

/** Rendered label per price window — SYMBOL ONLY; the internal names
 *  (`valley` = discounted/off-peak, `peak` = full price) stay for all logic.
 *  Both glyphs are single-cell in the terminal's Nerd Font (JetBrainsMono Nerd
 *  Font Mono: advance 1.00 em, verified), so the footer column never shifts.
 *  Swap the pair by editing this one line:
 *    \ue30d = nf-weather day-sunny (peak) · \ue390 = nf-weather thick crescent moon (off-peak)
 *  Alternatives: emoji "\u2600\ufe0f"/"\U0001f319" (double-width in kitty — shifts the column),
 *  or plain text arrows "\u2191"/"\u2193" (single-width, no Nerd Font needed). */
const WINDOW_GLYPH: Record<Window, string> = { peak: "\ue30d", valley: "\ue390" };

/** Peak windows in Beijing local time, as [startHour, endHour) pairs. */
const PEAK_WINDOWS: Array<[number, number]> = [
	[9, 12],
	[14, 18],
];

const BJT = new Intl.DateTimeFormat("en-US", {
	timeZone: "Asia/Shanghai",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit",
	hour12: false,
});

/** Which tariff applies at `at` (defaults to now). */
export function windowAt(at: Date = new Date()): Window {
	try {
		const parts = BJT.formatToParts(at);
		const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
		const day = get("weekday");
		if (day === "Sat" || day === "Sun") return "valley";
		const hour = Number(get("hour"));
		const minute = Number(get("minute"));
		if (Number.isNaN(hour)) return "valley";
		const h = hour + minute / 60;
		for (const [from, to] of PEAK_WINDOWS) if (h >= from && h < to) return "peak";
		return "valley";
	} catch {
		return "valley"; // fail low: never overstate a bill
	}
}

/**
 * Time remaining in the CURRENT window, from the SAME logic and timezone basis
 * the window label itself uses (no second definition): inside a peak window it
 * is the next peak boundary, inside valley it is the START of the next peak
 * window — weekend-aware, so a Friday-evening valley legitimately reads in days.
 * Rounded DOWN at every magnitude (a remainder never overstates), and rendered
 * as a fixed 3-character field beside the glyph so the footer never jitters.
 */
const BJT_OFFSET_MS = 8 * 3_600_000;

function bjtParts(at: Date): { y: number; mo: number; d: number; weekday: string; hour: number } {
	const p = BJT.formatToParts(at);
	const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
	return {
		y: Number(get("year")),
		mo: Number(get("month")),
		d: Number(get("day")),
		weekday: get("weekday"),
		hour: Number(get("hour")),
	};
}

/** A BJT wall-clock instant → epoch ms (Asia/Shanghai is a fixed UTC+8, no DST). */
function bjtWallToEpoch(y: number, mo: number, d: number, h: number): number {
	return Date.UTC(y, mo - 1, d, h, 0, 0, 0) - BJT_OFFSET_MS;
}

/** The instant the window in force at `at` ends. */
export function windowEndAt(at: Date = new Date()): Date {
	const now = at.getTime();
	const p = bjtParts(at);
	if (windowAt(at) === "peak")
		return new Date(bjtWallToEpoch(p.y, p.mo, p.d, p.hour < 12 ? 12 : 18));
	// Valley: the next weekday peak START (09:00 or 14:00 BJT), scanning up to a week.
	for (let k = 0; k <= 7; k++) {
		const day = new Date(bjtWallToEpoch(p.y, p.mo, p.d, 12) + k * 86_400_000);
		const dp = bjtParts(day);
		if (dp.weekday === "Sat" || dp.weekday === "Sun") continue;
		for (const h of [9, 14]) {
			const cand = bjtWallToEpoch(dp.y, dp.mo, dp.d, h);
			if (cand > now) return new Date(cand);
		}
	}
	return new Date(now);
}

/** The remaining time, floored: "2d" | "5h" | "47m" | "9s". */
export function remainingLabel(at: Date = new Date()): string {
	const s = Math.floor(Math.max(0, windowEndAt(at).getTime() - at.getTime()) / 1000);
	if (s >= 86_400) return `${Math.floor(s / 86_400)}d`;
	if (s >= 3_600) return `${Math.floor(s / 3_600)}h`;
	if (s >= 60) return `${Math.floor(s / 60)}m`;
	return `${s}s`;
}

/** The footer field: the glyph (1 cell) + a right-aligned 3-char remainder. */
export function windowLabel(w: Window, at: Date = new Date()): string {
	return `${WINDOW_GLYPH[w]} ${remainingLabel(at).padStart(3)}`;
}

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** Cost for one message's usage, at the tariff in force at `at`. A table passed
 *  in is used as given; otherwise the CONFIGURED table is used, and a machine
 *  with none gets `liveTariff()`'s refusal instead of a price. */
export function costOf(usage: Usage, at: Date = new Date(), table?: TariffTable): number {
	const r = (table ?? liveTariff().cny)[windowAt(at)];
	const per = (tokens: number | undefined, rate: number) => ((tokens ?? 0) / 1_000_000) * rate;
	// DeepSeek bills a cache write as cache-miss input; there is no separate rate.
	return (
		per(usage.input, r.cacheMiss) +
		per(usage.cacheWrite, r.cacheMiss) +
		per(usage.cacheRead, r.cacheHit) +
		per(usage.output, r.output)
	);
}

/** The same figure in USD. */
export function costOfUsd(usage: Usage, at: Date = new Date(), table?: TariffTable): number {
	return costOf(usage, at, table ?? liveTariff().usd);
}

const isDeepseekFlash = (model: unknown): boolean => {
	const id = typeof model === "string" ? model : ((model as { id?: string } | undefined)?.id ?? "");
	return /deepseek-flash/i.test(id);
};

/**
 * The child session files of a parent session.
 *
 * pi-subagents persists each child as
 * `<parent session file without .jsonl>/<childRunId>/run-<n>/session.jsonl`
 * (a resumed child appends a new `run-<n>` dir). Nested children would sit under
 * their own parent's session dir, so the walk descends a few levels.
 *
 * Unusable alternatives: the async run receipts under
 * /tmp/pi-subagents-uid-1000/async-subagent-runs/<runId>/ (status.json,
 * events.jsonl, recovery-descriptor.json, subagent-log) record a per-child run
 * TOTAL without per-request timestamps — no peak/valley window can be applied
 * to them — and ~/.local/pi/foreman/headless-runs.jsonl is a foreman-specific
 * ledger of launched processes with a session path and nothing priceable.
 */
function childSessionFiles(sessionFile: string): string[] {
	const dir = sessionFile.endsWith(".jsonl") ? sessionFile.slice(0, -".jsonl".length) : sessionFile;
	const found: string[] = [];
	const walk = (at: string, depth: number): void => {
		if (depth > CHILD_SCAN_DEPTH) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(at, { withFileTypes: true });
		} catch {
			return; // absent/unreadable dir = no children
		}
		for (const entry of entries) {
			const full = join(at, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.name === "session.jsonl") found.push(full);
		}
	};
	walk(dir, 0);
	return found;
}

/** How deep a child of a child's session dir is looked for. */
const CHILD_SCAN_DEPTH = 6;

/** How often the child sessions are re-priced while this session is open. */
const SUBAGENT_SCAN_MS = 2000;

/** Largest chunk priced from one child file per scan (a live child appends in
 *  small pieces; a huge backlog is spread over the following scans). */
const CHILD_READ_CHUNK = 4 * 1024 * 1024;

/** What one child session file has contributed to the totals so far. */
interface ChildFileState {
	/** Bytes already priced (a partial trailing line is left for the next scan). */
	offset: number;
	cny: number;
	usd: number;
	messages: number;
}

/** The footer UI surface (theme is optional so a bare ctx.ui still renders). */
interface FootUi {
	setStatus?: (key: string, value: string | undefined) => void;
	theme?: { fg?: (color: string, text: string) => string };
}

// ── Cache-miss notice ──
//
// pi itself renders a "Cache miss" transcript notice (core: addCacheMissNotice),
// but its cost comes from `missedCost`, derived from the message's `usage.cost` —
// which pi fills from the model's `cost` metadata. models.json's Flash entry has
// no cost fields (they were removed so pi's flat `$` figure would not compete
// with this extension's tariff), so that notice prints no cost at all.
//
// The notice here is the same signal, costed by THIS extension: the re-billed
// tokens are charged the cache-miss rate minus the cache-hit rate they would
// otherwise have cost, in BOTH currencies, at the tariff in force for the
// REQUEST'S OWN timestamp. It never reads model metadata.

/** pi's noise floor for counting a miss at all (core: NOISE_FLOOR_TOKENS). */
const MISS_NOISE_FLOOR_TOKENS = 1024;
/** pi's significance gate for showing a notice (core: missedTokens < 20000 &&
 *  missedCost < 0.1 returns early). The cost half is ours, in USD. */
const MISS_NOTICE_TOKENS = 20_000;
const MISS_NOTICE_COST_USD = 0.1;
/** pi's prompt-cache TTL (core: CACHE_TTL_MS) — the idle-miss label. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** One significant prompt-cache miss, priced by this extension. */
export interface CacheMiss {
	/** Prompt tokens that were re-billed instead of being cache hits. */
	tokens: number;
	usd: number;
	cny: number;
	window: Window;
	label: string;
	/** The message's own timestamp (ms). */
	at: number;
}

/** Compact token count, the same shape pi prints (`12k`, `1.1M`). */
export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1e4) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1e6) return `${Math.round(count / 1000)}k`;
	if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
	return `${Math.round(count / 1e6)}M`;
}

/** The inline alert line: same presentation rules as the footer (`$x.xxxx
 *  ¥x.xxxx window`), plus the token count pi reports. */
export function cacheMissNoticeText(m: CacheMiss): string {
	return `${m.label}: ${formatTokenCount(m.tokens)} tokens re-billed ~$${m.usd.toFixed(4)} ¥${m.cny.toFixed(4)} ${windowLabel(m.window, new Date(m.at))}`;
}

/**
 * SUPPRESSION OF PI CORE'S COST-LESS CACHE-MISS NOTICE — why this patch exists.
 *
 * Core renders its own "Cache miss: <N> tokens re-billed" line by appending a raw
 * Spacer + Text to the chat container (`addCacheMissNotice`). That is NOT a session entry, so
 * `pi.registerEntryRenderer` (custom entries only) cannot reach it, and
 * `registerMessageRenderer` / `registerMarkdownTransformer` see messages / markdown only —
 * `docs/extensions.md` documents no notice or chat-container surface at all. The ONE documented
 * gate is the shared `showCacheMissNotices` setting (docs/settings.md:35), which also silences
 * compaction/branch-summary usage notices and provider-recovery diagnostics — not a targeted
 * option. This extension already emits the same event WITH its cost (USD + CNY + window glyph +
 * remainder), so the duplicate is removed here by no-op'ing that single method.
 *
 * Deliberately narrow: one bounded lookup from the TUI handle the `setFooter` callback provides,
 * one assignment. FAIL SOFT — if the shape is not found (pi updated, renamed, no UI) nothing
 * happens and exactly one log line says so: a missing patch degrades to two notices, never to a
 * broken TUI. RE-CHECK after every pi upgrade; the log line is the tell. Written against
 * pi 0.85.1 (`pi --version`).
 */
export function suppressCoreCacheMissNotice(
	tui: unknown,
	report: (message: string) => void,
): { applied: boolean; reason: string } {
	try {
		const seen = new Set<unknown>();
		const queue: Array<{ node: unknown; depth: number }> = [{ node: tui, depth: 0 }];
		let visited = 0;
		while (queue.length > 0 && visited < 200) {
			const { node, depth } = queue.shift() as { node: unknown; depth: number };
			if (!node || typeof node !== "object" || seen.has(node)) continue;
			seen.add(node);
			visited++;
			const holder = node as Record<string, unknown>;
			if (typeof holder.addCacheMissNotice === "function") {
				// One assignment: an own property shadows the prototype method.
				holder.addCacheMissNotice = (): void => {};
				report(
					"[deepseek-cost] core cache-miss notice suppressed (no documented API covers it; see the comment above)",
				);
				return { applied: true, reason: "addCacheMissNotice found and no-op'ed" };
			}
			if (depth >= 3) continue;
			const children = holder.children;
			if (Array.isArray(children))
				for (const child of children) queue.push({ node: child, depth: depth + 1 });
		}
		report(
			"[deepseek-cost] cache-miss suppression NOT applied: no addCacheMissNotice in the TUI tree (pi version drift?) — two notice lines will show",
		);
		return { applied: false, reason: "addCacheMissNotice not found" };
	} catch (e) {
		report(
			`[deepseek-cost] cache-miss suppression NOT applied: ${String(e)} — two notice lines will show`,
		);
		return { applied: false, reason: String(e) };
	}
}

/** TUI-only: borrow the TUI object through the documented footer callback, then
 *  restore the built-in footer in the same tick so nothing user-visible changes. */
function attachCacheMissSuppression(ctx: { ui?: unknown; mode?: string }): void {
	if (ctx?.mode !== "tui") return;
	const ui = ctx.ui as { setFooter?: (cb?: unknown) => void } | undefined;
	if (typeof ui?.setFooter !== "function") return;
	let tui: unknown = null;
	try {
		ui.setFooter((handle: unknown) => {
			tui = handle;
			return { render: () => [], invalidate: () => {} };
		});
	} catch (e) {
		reportSuppression(
			`[deepseek-cost] cache-miss suppression NOT applied: setFooter failed (${String(e)})`,
		);
		return;
	} finally {
		try {
			ui.setFooter(undefined); // documented: restore the built-in footer
		} catch {
			/* the built-in footer stays if this fails; the patch below is cosmetic either way */
		}
	}
	if (!tui) {
		reportSuppression(
			"[deepseek-cost] cache-miss suppression NOT applied: no TUI handle from setFooter — two notice lines will show",
		);
		return;
	}
	suppressCoreCacheMissNotice(tui, reportSuppression);
}

/** One quiet log line is the whole contract of the fail-soft path. */
function reportSuppression(message: string): void {
	try {
		hookLog("deepseek-cost", "suppressed", { message });
	} catch {
		/* logging must never throw into the session */
	}
}

export default function (pi: ExtensionAPI): void {
	// No configured table, no pricing: this extension registers nothing at all
	// rather than show a footer figure derived from the module's example table, and
	// the one line it logs names the file to write. The read happens here, never in
	// the package's module body.
	const tariff = loadTariff();
	if (!tariff.ok) {
		reportSuppression(`[deepseek-cost] pricing disabled — ${tariff.reason}`);
		return;
	}
	const table = tariff.table;
	let totalCny = 0;
	let totalUsd = 0;
	let pricedMessages = 0;
	let lastWindow: Window | null = null;
	let lastPricedMs = 0;

	// ── subagent usage (child session files of this session) ──
	let subCny = 0;
	let subUsd = 0;
	let subMessages = 0;
	const childFiles = new Map<string, ChildFileState>();
	/** Timestamps the session_start seed has already billed — the boundary that
	 *  keeps a replayed restored message out of the live pricing path. */
	const seededMessages = new Set<number>();
	let sessionFile: string | null = null;
	let scanTimer: ReturnType<typeof setInterval> | null = null;
	let footUi: FootUi | null = null;
	/** The previous assistant request of THIS session — the baseline pi's own
	 *  cache-miss detector compares against (input+cacheRead+cacheWrite, the
	 *  model key, the timestamp and whether it reported any cache activity). */
	let prevRequest: {
		promptTokens: number;
		modelKey: string;
		timestamp: number;
		reportedCache: boolean;
	} | null = null;

	/** Price one significant cache miss and append it to the trajectory. Mirrors
	 *  pi's detectMiss thresholds so the alert appears exactly when pi's own
	 *  notice would; every number comes from this extension's tariff. */
	const noteCacheMiss = (msg: {
		usage?: Usage;
		model?: string;
		provider?: string;
		timestamp?: number;
	}): void => {
		const prev = prevRequest;
		const u = msg.usage;
		if (!prev || !u) return;
		const input = u.input ?? 0;
		const cacheRead = u.cacheRead ?? 0;
		const cacheWrite = u.cacheWrite ?? 0;
		const promptTokens = input + cacheRead + cacheWrite;
		if (promptTokens <= 0) return;
		if (cacheRead + cacheWrite === 0 && !prev.reportedCache) return;
		const tokens = Math.min(prev.promptTokens, promptTokens) - cacheRead;
		if (tokens <= MISS_NOISE_FLOOR_TOKENS) return;
		const at = msg.timestamp ? new Date(msg.timestamp) : new Date();
		const w = windowAt(at);
		// What the re-billed tokens cost ABOVE the cache-hit rate: both currencies,
		// at the tariff in force for this request's own timestamp.
		const usd = (tokens * (table.usd[w].cacheMiss - table.usd[w].cacheHit)) / 1_000_000;
		const cny = (tokens * (table.cny[w].cacheMiss - table.cny[w].cacheHit)) / 1_000_000;
		if (tokens < MISS_NOTICE_TOKENS && usd < MISS_NOTICE_COST_USD) return;
		const idleMs = Math.max(0, (msg.timestamp ?? 0) - prev.timestamp);
		const modelKey = `${msg.provider ?? ""}/${msg.model ?? ""}`;
		const label =
			modelKey !== prev.modelKey
				? "Cache miss after model switch"
				: idleMs >= CACHE_TTL_MS
					? `Cache miss after ${Math.round(idleMs / 60_000)}m idle`
					: "Cache miss";
		pi.appendEntry("deepseek-cost-miss", {
			tokens,
			usd,
			cny,
			window: w,
			label,
			at: msg.timestamp ?? 0,
		} satisfies CacheMiss);
	};

	// Register the ALWAYS-CHECKED editor. The renderer uses the theme passed to
	// it and returns a minimal text component (pi-tui is bundled inside pi and is
	// not importable from an extension), so a failure can only drop the line.
	pi.registerEntryRenderer("deepseek-cost-miss", ((
		entry: { data?: unknown },
		_opts: unknown,
		theme: { fg?: (c: string, s: string) => string },
	) => {
		const data = entry?.data as CacheMiss | undefined;
		if (!data) return undefined;
		const text = cacheMissNoticeText(data);
		const themed = theme?.fg ? theme.fg("warning", text) : text;
		return {
			render: (width: number) => [themed.slice(0, Math.max(1, width))],
			invalidate: () => {},
		};
	}) as never);

	/** The footer text, or undefined when nothing has been priced yet. */
	const renderText = (): string | undefined => {
		if (!pricedMessages && !subMessages) return undefined;
		const w = lastWindow ?? windowAt();
		// ONE total in both currencies: the child sessions are billed to the same
		// account, so they are summed in rather than shown as a second figure.
		const total = `$${(totalUsd + subUsd).toFixed(4)} ¥${(totalCny + subCny).toFixed(4)} ${windowLabel(w)}`;
		return total;
	};

	const renderWith = (ui: FootUi | null): void => {
		try {
			const text = renderText();
			if (text === undefined) {
				ui?.setStatus?.("cost-cny", undefined);
				return;
			}
			const themed = ui?.theme?.fg ? ui.theme.fg("muted", text) : text;
			ui?.setStatus?.("cost-cny", themed);
		} catch {
			/* footer is cosmetic */
		}
	};

	const render = (ctx: { ui?: FootUi }): void => {
		if (ctx?.ui) footUi = ctx.ui;
		renderWith(ctx?.ui ?? footUi);
	};

	/** Price the bytes one child session file has appended since the last scan.
	 *  A child is priced exactly once: the byte offset advances past every
	 *  complete line consumed, and a file that got shorter (rewritten) has its
	 *  already-counted contribution removed before it is read again. */
	const priceChildFile = (file: string): void => {
		let state = childFiles.get(file);
		if (!state) {
			state = { offset: 0, cny: 0, usd: 0, messages: 0 };
			childFiles.set(file, state);
		}
		const size = statSync(file).size;
		if (size < state.offset) {
			subCny -= state.cny;
			subUsd -= state.usd;
			subMessages -= state.messages;
			state.offset = 0;
			state.cny = 0;
			state.usd = 0;
			state.messages = 0;
		}
		if (size <= state.offset) return;
		const want = Math.min(size - state.offset, CHILD_READ_CHUNK);
		const buf = Buffer.allocUnsafe(want);
		const fd = openSync(file, "r");
		let read = 0;
		try {
			read = readSync(fd, buf, 0, want, state.offset);
		} finally {
			closeSync(fd);
		}
		if (read <= 0) return;
		const chunk = buf.subarray(0, read);
		// Only complete lines are consumed: a child mid-write leaves its last,
		// unterminated line for the next scan (it is re-read then, once).
		const lastNl = chunk.lastIndexOf(0x0a);
		if (lastNl < 0) return;
		for (const line of chunk.subarray(0, lastNl).toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			let entry: { type?: string; message?: unknown };
			try {
				entry = JSON.parse(line);
			} catch {
				continue; // a corrupt line is skipped, never fatal
			}
			if (entry?.type !== "message") continue;
			const msg = entry.message as
				| { role?: string; model?: string; timestamp?: number; usage?: Usage }
				| undefined;
			if (msg?.role !== "assistant" || !msg.usage) continue;
			// Price only the models this extension owns; a child running another
			// model (or one that declares none) is left to pi's own accounting.
			if (!isDeepseekFlash(msg.model)) continue;
			const at = msg.timestamp ? new Date(msg.timestamp) : new Date();
			const cny = costOf(msg.usage, at, table.cny);
			const usd = costOfUsd(msg.usage, at, table.usd);
			subCny += cny;
			subUsd += usd;
			subMessages++;
			state.cny += cny;
			state.usd += usd;
			state.messages++;
			if (at.getTime() >= lastPricedMs) {
				lastPricedMs = at.getTime();
				lastWindow = windowAt(at);
			}
		}
		state.offset += lastNl + 1;
	};

	/** Price every child session file that has new bytes. Never throws: a missing
	 *  or partial child file must not disturb the footer or the turn. */
	const scanSubagents = (): void => {
		try {
			if (!sessionFile) return;
			for (const file of childSessionFiles(sessionFile)) {
				try {
					priceChildFile(file);
				} catch {
					/* unreadable child file — skip it, keep the rest */
				}
			}
		} catch {
			/* scanning is cosmetic */
		}
	};

	pi.on("message_end", (event, ctx) => {
		try {
			const msg = event.message as {
				role?: string;
				model?: string;
				provider?: string;
				timestamp?: number;
				usage?: Usage;
			};
			if (msg?.role !== "assistant" || !msg.usage) return;
			// A restored message is never priced twice: every timestamp the
			// session_start seed billed is a boundary, not new work.
			if (msg.timestamp !== undefined && seededMessages.has(msg.timestamp)) return;
			// Cache-miss bookkeeping runs for EVERY assistant message (pi's own
			// detector compares against the previous request whatever its model),
			// then the baseline moves to this message.
			noteCacheMiss(msg);
			const input = msg.usage.input ?? 0;
			const cacheRead = msg.usage.cacheRead ?? 0;
			const cacheWrite = msg.usage.cacheWrite ?? 0;
			prevRequest = {
				promptTokens: input + cacheRead + cacheWrite,
				modelKey: `${msg.provider ?? ""}/${msg.model ?? ""}`,
				timestamp: msg.timestamp ?? 0,
				reportedCache: cacheRead + cacheWrite > 0,
			};
			const active = (ctx as { model?: { id?: string } }).model;
			// Price on the MESSAGE's own model when it declares one — a batch can
			// carry another model's message (subagent, mid-session switch) and the
			// session's active model must not be used to price it. The active model
			// is the fallback only when the message says nothing.
			const modelId = msg.model ?? active?.id ?? "";
			if (!isDeepseekFlash(modelId)) return;
			const at = msg.timestamp ? new Date(msg.timestamp) : new Date();
			const w = windowAt(at);
			totalCny += costOf(msg.usage, at, table.cny);
			totalUsd += costOfUsd(msg.usage, at, table.usd);
			if (at.getTime() >= lastPricedMs) lastPricedMs = at.getTime();
			lastWindow = w;
			pricedMessages++;
			scanSubagents();
			render(ctx as never);
		} catch {
			/* a pricing bug must never disturb the turn */
		}
	});

	pi.on("session_start", (_event, ctx) => {
		attachCacheMissSuppression(ctx as { ui?: unknown; mode?: string });
		totalCny = 0;
		totalUsd = 0;
		pricedMessages = 0;
		lastWindow = null;
		lastPricedMs = 0;
		subCny = 0;
		subUsd = 0;
		subMessages = 0;
		childFiles.clear();
		seededMessages.clear();
		if (ctx?.ui) footUi = ctx.ui as FootUi;
		const sm = (
			ctx as {
				sessionManager?: {
					getSessionFile?: () => string | null;
					getEntries?: () => Array<{
						type?: string;
						message?: {
							role?: string;
							model?: string;
							provider?: string;
							timestamp?: number;
							usage?: Usage;
						};
					}>;
				};
			}
		)?.sessionManager;
		sessionFile = sm?.getSessionFile?.() ?? null;
		// A resumed session reopens with its whole transcript, and pi restores its
		// own totals from the entries — so this extension's are restored the same
		// way: every restored assistant message is priced ONCE here, at its own
		// timestamp, and its timestamp is recorded as the boundary that keeps a
		// replay out of the live path. This is the ONLY place history is priced;
		// the tick and message_end price only what arrives after the seed. The same
		// walk seeds the cache-miss baseline (pi does the same when it rebuilds its
		// own miss list for a resumed session).
		prevRequest = null;
		try {
			for (const entry of sm?.getEntries?.() ?? []) {
				const m = entry?.message;
				if (entry?.type !== "message" || m?.role !== "assistant" || !m.usage) continue;
				const input = m.usage.input ?? 0;
				const cacheRead = m.usage.cacheRead ?? 0;
				const cacheWrite = m.usage.cacheWrite ?? 0;
				if (isDeepseekFlash(m.model)) {
					const at = m.timestamp ? new Date(m.timestamp) : new Date();
					totalCny += costOf(m.usage, at, table.cny);
					totalUsd += costOfUsd(m.usage, at, table.usd);
					pricedMessages++;
					if (at.getTime() >= lastPricedMs) {
						lastPricedMs = at.getTime();
						lastWindow = windowAt(at);
					}
					if (m.timestamp) seededMessages.add(m.timestamp);
				}
				prevRequest = {
					promptTokens: input + cacheRead + cacheWrite,
					modelKey: `${m.provider ?? ""}/${m.model ?? ""}`,
					timestamp: m.timestamp ?? 0,
					reportedCache: cacheRead + cacheWrite > 0,
				};
			}
		} catch {
			/* a session without a readable entry list starts empty, like a fresh one */
		}
		// A child can run for minutes while the parent waits: re-price on a slow
		// tick so its usage reaches the footer without a parent message.
		if (scanTimer) clearInterval(scanTimer);
		scanTimer = sessionFile
			? setInterval(() => {
					scanSubagents();
					renderWith(footUi);
				}, SUBAGENT_SCAN_MS)
			: null;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			if (scanTimer) clearInterval(scanTimer);
			scanTimer = null;
			const ui = ((ctx as { ui?: FootUi } | undefined)?.ui ?? footUi) as FootUi | null;
			ui?.setStatus?.("cost-cny", undefined);
		} catch {
			/* nothing to clean */
		}
	});
}
