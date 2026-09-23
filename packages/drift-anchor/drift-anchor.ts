/**
 * drift-anchor: drift-anchoring extension for pi.
 *
 * RULE A (caveman reasoning): every reasoning block opens with the exact
 * literal line `Caveman mode.` then is terse/fragmentary. RULE B: the
 * user-facing reply stays clean explanatory prose (the OPPOSITE register).
 *
 * Why this exists: RULE A decays in long autonomous sessions. Root cause is
 * self-reinforcement — every model call re-reads its own prior reasoning
 * blocks, so one verbose unmarked block inverts the in-context prior and the
 * model imitates it. The system prompt is prompt-cache-frozen and must not be
 * mutated per-turn (that invalidates the cached prefix, doubling input cost).
 * The only cache-safe, per-generation-time lever is the `context` event,
 * which fires before EVERY LLM call and accepts a message mutation.
 *
 * Design (closed-loop, fail-open):
 *  - DETECT      (`message_end`, read-only): parse the finalized assistant
 *                message; compute { markerMissing, thinking/answer ratio }.
 *                Never blocks, never rewrites. Records drift state + a
 *                reasoning-token proxy for the USER surface.
 *  - RE-ANCHOR   (`context`): append a SINGLE line to the TAIL of the
 *                messages array. Tail-position is cache-safe (it sits in the
 *                uncached suffix, never the cached prefix). TWO anchor
 *                sources: the drift-responsive path (immediate on drift, with
 *                a 3→6→12 backoff ladder under persistent same-signal drift —
 *                MAJOR-1, Uma 2026-09-08) and a periodic maintenance dose on
 *                a quiet jittered cadence (~24±6 steps, deferred while drift
 *                anchoring is active). Canon + hook nudges share the same
 *                single-fire, priority-ranked per-step gate. Rotates phrasing
 *                so it never becomes wallpaper.
 *  - HARD RULE:  never inject the model's own drift verdict. Telling a model
 *                "you were verbose" triggers the self-referential prose loop
 *                (an apology about being verbose) and Goodharting (ritually
 *                emitting the marker atop a still-verbose block). Every
 *                injected line states the RULE, never the VERDICT.
 *  - COST        is surfaced to the USER only (/anchor status), never into
 *                model stream — the model cannot act on its own dollar cost.
//  - TRAFFIC LOG: every injection appends one line to the shared hook log
//                (~/.local/share/pi-hooks/log.jsonl: source "drift-anchor",
//                kind anchor|nudge|set-anchor, detail {label, turn}).
//                Injected lines live only in the outgoing message array, so
//                they never reach the session jsonl — this log is the only
//                way to audit anchor volume after the fact.
 *  - SET_ANCHOR  (v1 schema): a session CONFIGURES the anchor via the
 *                `set_anchor` tool: `phrase` (the realignment line — "the
 *                phrase is the API"; hooks adjust WHEN it fires, never WHAT
 *                it says). THE PHRASE MUST CARRY WHAT CANON DOES NOT: it
 *                joins a rotation whose other entries already vary the
 *                framing (register + one todo-board check), and the canon
 *                block is in the system prompt every turn — restating the
 *                caveman rule, verify-before-done or todo discipline spends
 *                the slot on information the model already has.
 *                plus an optional `hooks` map (Hank v1 keys: register /
 *                toolChurn / pressure / blockedToolRepeat; UNKNOWN KEYS ARE
 *                IGNORED SILENTLY so v2 can extend). REPEAT CALLS ARE
 *                ACCEPTED — a repeat is a REALIGNMENT: it REPLACES the
 *                phrase, replaces the hook keys it passes (a hook key it
 *                does not mention keeps its configured value) and restarts
 *                the line rotation plus both jittered cadences from the new
 *                set time, while the hook fire bookkeeping carries over so
 *                no capped hook gains a firing. The tool is meant for
 *                extremely rare use — once when work starts, and again only
 *                to realign behaviour late in a very long conversation — so
 *                NOTHING gates it (no counter, no minimum-turn threshold):
 *                the tool description is the only discouragement, and the
 *                tool result is the only place a repeat is acknowledged.
 *                Persisted via `pi.appendEntry` ("drift-anchor-config") and
 *                restored on `session_start`, so the anchor survives
 *                compaction and reloads.
 *
 * HOOKS (ship-first per Hank's catalog + one user-requested default):
 *  - register (O1, DEFAULT-ON)        — the original caveman register decay.
 *  - blockedToolRepeat (DEFAULT-ON in EVERY session) — counts blocked tool
 *                results (command-guard R1/R2 and RAW-INPUT redirects, context-mode
 *                confinement, security-policy denies) in a sliding window;
 *                ≈3 in 4 turns injects one gentle line: "Blocked tools
 *                repeating — switch to the redirect's tool now: read (not
 *                cat/sed -n/head/tail), <checker>, <search>." The two
 *                tool-naming clauses are built from the RECEIVING session's
 *                own menu (`pi.getActiveTools()`): `build` / `ctx_execute`
 *                are named ONLY where the session has them, otherwise the
 *                tool-free form of the same rule (a filtered checker run; a
 *                pipeline that prints only the derived result). A child
 *                session runs its own process on a smaller menu, so a line
 *                naming a tool it does not have is unfollowable and costs
 *                the retry it exists to prevent.
 *                Needs NO set_anchor call; stays on when set_anchor runs unless
 *                hooks.blockedToolRepeat.enabled === false.
 *  - toolChurn (P1, opt-in) — tool_execution_end count over a sliding turn
 *                window; the foreman "too much tool use" detector.
 *  - pressure (E1, opt-in)  — ctx.getContextUsage() ≥ warnAtPct; fires at
 *                most twice per session.
 *
 * Fail-open everywhere: a bug here must never crash pi or corrupt a turn.
 * Every handler is wrapped in try/catch and defaults to doing nothing.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { argText, clip, hookLog, safeToolHeader } from "@tinoy/pi-ext-lib";
import { Type } from "typebox";

// ── Constants (the contract) ────────────────────────────────────────────────
const MARKER_FALLBACKS = ["Caveman mode.", "Caveman mode", "caveman mode."];

// Drift heuristics
const RATIO_WARN = 6; // thinking chars / text chars above this = prose-like
const RATIO_HARD = 12; // above this = heavy prose (informational, not a gate)
const TEXT_MIN_FOR_RATIO = 20; // answer must be this many chars before ratio is meaningful
const DRIFT_WINDOW = 5; // count a turn as "drifted" if it fired within this many turns
const MIN_TURNS_SINCE_INJECT = 3; // re-anchor anti-habituation gap (also the BASE gap of the drift path)
// MAJOR-1 (Uma 2026-09-08): the drift path re-fired every 3 steps under
// persistent same-signal drift — 8× the periodic cadence (24±6), unbounded by
// the periodic retune. Her recommended fix, adopted verbatim: escalate the
// gap after each consecutive same-signal fire (3 → 6 → 12, capped). A NEW
// signal, or a fresh episode (last drift fire older than PERIODIC_EVERY),
// stays immediately responsive at the base gap. Bounded factor vs periodic:
// 24/12 = 2× at the ladder cap.
const DRIFT_BACKOFF_LADDER = [3, 6, 12];
const PERIODIC_EVERY = 48; // maintenance-dose cadence in trajectory steps (state.turn counts EVERY assistant message). Doubled from 24: a 71-injection sample showed ZERO periodic fires — the quiet gate suppressed every one because drift was firing throughout, so the longer interval costs nothing today and keeps the beat out of the way if a session ever does go quiet.
const PERIODIC_JITTER = 12; // jitters ±12 turns (→ 36-60, mean 48) — a fixed-interval beat is the most habituation-prone schedule and is anticipatable (R1)
const CANON_EVERY = 50; // separate canon cadence, doubled alongside the periodic one; anchored at set/restore time (R2 — no offset; the old offset CREATED a T+20 collision with periodic)
const nextPeriodicInterval = (): number =>
	PERIODIC_EVERY + Math.floor(Math.random() * (2 * PERIODIC_JITTER + 1)) - PERIODIC_JITTER;

// Hook defaults (Hank v1 catalog; set_anchor can override via the hooks map)
const CHURN_MAX_PER_WINDOW = 25;
const CHURN_WINDOW_TURNS = 8;
const PRESSURE_WARN_AT_PCT = 80;
const PRESSURE_MAX_PER_SESSION = 2;
const BLOCKED_THRESHOLD = 3; // ≈3 blocked results...
const BLOCKED_WINDOW_TURNS = 4; // ...within 4 turns → one gentle line
const ANCHOR_CONFIG_ENTRY = "drift-anchor-config";
const LEGACY_CONFIG_ENTRY = "whip-config"; // sessions persisted before the rename — read-only
const ANCHOR_SCHEMA_VERSION = 1;

// ── Config (~/.config/drift-anchor/config.json) — default ON ────────────────
const CONFIG_DIR = join(homedir(), ".config/drift-anchor");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
// Legacy read fallback: the config lived under ~/.config/pi-whip pre-rename.
const LEGACY_CONFIG_PATH = join(homedir(), ".config/pi-whip", "config.json");

interface AnchorConfig {
	enabled: boolean;
	ratioWarn: number;
	ratioHard: number;
	driftWindow: number;
	minTurnsSinceInject: number;
	rotate: boolean;
}

const DEFAULT_CONFIG: AnchorConfig = {
	enabled: true,
	ratioWarn: RATIO_WARN,
	ratioHard: RATIO_HARD,
	driftWindow: DRIFT_WINDOW,
	minTurnsSinceInject: MIN_TURNS_SINCE_INJECT,
	rotate: true,
};

let configCache: { mtimeMs: number; value: AnchorConfig } | null = null;

function readConfig(): AnchorConfig {
	try {
		if (!existsSync(CONFIG_PATH)) {
			if (existsSync(LEGACY_CONFIG_PATH)) {
				// one-time legacy read (pre-rename location); writes always go to the new path
				const st0 = statSync(LEGACY_CONFIG_PATH);
				if (configCache && configCache.mtimeMs === st0.mtimeMs) return configCache.value;
				const legacy = {
					...DEFAULT_CONFIG,
					...(JSON.parse(readFileSync(LEGACY_CONFIG_PATH, "utf8")) as Partial<AnchorConfig>),
				};
				configCache = { mtimeMs: st0.mtimeMs, value: legacy };
				return legacy;
			}
			return { ...DEFAULT_CONFIG };
		}
		const st = statSync(CONFIG_PATH);
		if (configCache && configCache.mtimeMs === st.mtimeMs) return configCache.value;
		const parsed = {
			...DEFAULT_CONFIG,
			...(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<AnchorConfig>),
		};
		configCache = { mtimeMs: st.mtimeMs, value: parsed };
		return parsed;
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function writeConfig(cfg: AnchorConfig): void {
	try {
		mkdirSync(CONFIG_DIR, { recursive: true });
		writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
		configCache = null;
	} catch {
		/* config write failure never crashes */
	}
}

// ── Rotating re-anchor lines (R7: framing diversity — rule / question /
// example / two-word trigger / todo-board check — semantic satiation ignores
// synonym swaps) ────
const REANCHOR_LINES = [
	// rule
	"Reasoning register: Caveman mode. Terse fragments, drop articles and hedges. The reply to the user stays clean prose.",
	// question
	"Still in Caveman mode for the reasoning? Terse fragments in — and the reply to the user stays full prose.",
	// example
	"Reasoning like: 'Caveman mode. Read file. Tests pass. Ship.' Reply to user: complete sentences.",
	// two-word trigger
	"Caveman mode — terse reasoning, prose reply.",
	// todo-board check: a nudge to RECONCILE the board, not a restatement of the
	// canon todo rule (which is in the system prompt every turn)
	"Todo board: one step in_progress, finished ones marked off, nothing stale — reconcile before the next move.",
];
// R9: a marker miss fires on the VERY NEXT context (window=1) with this short
// distinct line; the windowed paths (ratio, register drift) use the gentler
// rotation above.
const REANCHOR_IMMEDIATE_LINE =
	"Caveman mode. Restart the register now: terse fragments in reasoning, clean prose to the user.";

// Canon-attention rotation (R4): same semantics, three framings; "## Canon"
// is the heading the canon.ts injection actually uses.
const CANON_LINES = [
	"Canon block binds every turn — drift back to ## Canon before continuing.",
	"Check ## Canon: those rules outrank habit — glance back before continuing.",
	"## Canon applies right now — re-read the canon block before your next move.",
];

// blockedRepeatLine names a tool ONLY when the RECEIVING session has it, and
// otherwise states the same rule tool-free — a line naming an absent tool is
// unfollowable and costs the retry it exists to prevent.
type AnchorCaps = { ctxExecute: boolean; build: boolean };

function callerCaps(pi: ExtensionAPI): AnchorCaps | undefined {
	// The hook context carries no tool list (ExtensionContext exposes ui, mode,
	// cwd, sessionManager, model, … and the context event only `messages`), so
	// `pi.getActiveTools()` is the ONE capability signal: it reflects THIS pi
	// process. A child session runs its own process on a smaller menu — no
	// ctx_* family, and build.ts is not loaded — so the same call reports that
	// menu there. Returns undefined when the API or the call is unavailable;
	// callers then use wording that is true for every session shape.
	try {
		const get = (pi as { getActiveTools?: () => string[] }).getActiveTools;
		if (typeof get !== "function") return undefined;
		const tools = get.call(pi) ?? [];
		return { ctxExecute: tools.includes("ctx_execute"), build: tools.includes("build") };
	} catch {
		return undefined;
	}
}

function blockedRepeatLine(caps?: AnchorCaps): string {
	const search = caps?.ctxExecute
		? "ctx_execute (not bash grep/rg)"
		: "a pipeline that prints only the derived result (not bash grep/rg)";
	const checker = caps?.build
		? "build (not npx tsc/npm run)"
		: "a filtered checker run (not a bare npx tsc/npm run)";
	return `Blocked tools repeating — switch to the redirect's tool now: read (not cat/sed -n/head/tail), ${checker}, ${search}. The block already cost a turn; the next repeat costs another.`;
}

// Rule-not-verdict hook lines (Hank's golden rule: never "you did X wrong").
const CHURN_LINE =
	"Tools are piling up without landing anywhere. Name in one line what the last tool bought you, then either commit it somewhere durable or report.";
const PRESSURE_LINE =
	"Context is filling up. Land what you have — write the durable artifact now, then hand the rest off.";

// ── Drift state (module-lifetime; survives across turns of a session) ───────
interface DriftState {
	turn: number;
	lastMarkerMissTurn: number;
	lastRatioTurn: number;
	lastRegisterDriftTurn: number;
	lastInjectTurn: number;
	lastDriftInjectTurn: number; // R3: drift's own injection gate — hooks can never starve it
	lastDriftSignal: "marker" | "windowed" | null; // MAJOR-1 backoff: which drift signal fired last
	driftFireStreak: number; // MAJOR-1 backoff: consecutive same-signal fires
	rotatedIdx: number;
}

const state: DriftState = {
	turn: 0,
	lastMarkerMissTurn: -Infinity,
	lastRatioTurn: -Infinity,
	lastRegisterDriftTurn: -Infinity,
	lastInjectTurn: -Infinity,
	lastDriftInjectTurn: -Infinity,
	lastDriftSignal: null,
	driftFireStreak: 0,
	rotatedIdx: 0,
};

// Periodic maintenance dose: the due-in interval JITTERS around
// PERIODIC_EVERY (R1). Recomputed at set/restore time and at every periodic
// fire so no two consecutive intervals are equal.
let periodicJitterTurns = PERIODIC_EVERY;

// ── set_anchor state (v1 schema: phrase + hooks map; unknown keys ignored) ──
interface AnchorHooks {
	register?: { enabled?: boolean; ratioWarn?: number; message?: string };
	toolChurn?: { maxPerWindow?: number; windowTurns?: number; message?: string };
	pressure?: { warnAtPct?: number; message?: string };
	blockedToolRepeat?: {
		enabled?: boolean;
		threshold?: number;
		windowTurns?: number;
		message?: string;
	};
	[key: string]: unknown; // unknown hook keys are ignored silently (forward compat)
}
interface SessionAnchor {
	phrase: string;
	hooks: AnchorHooks;
	version: number;
	lastChurnInjectTurn: number;
	lastPressureInjectTurn: number;
	pressureFires: number;
	lastBlockedInjectTurn: number;
}
let sessionAnchor: SessionAnchor | null = null;
// Periodic-cadence anchor (turn at which set_anchor ran / anchor was
// restored). The DRIFT path stays responsive from -Infinity; only the
// jittered maintenance cadence is anchored, so a fresh set never fires on
// the very next context call.
let periodicAnchorTurn = -Infinity;
// Separate canon-cadence anchor, set at set_anchor/restore time (R2: no
// offset — the old offset collided canon with periodic at T+20; the shared
// anti-habituation gate is the only collision protection needed).
let canonAnchorTurn = -Infinity;

// blockedToolRepeat tracker — DEFAULT-ON, independent of set_anchor.
const blockedTurns: number[] = []; // turns in which a blocked tool result landed

// toolChurn tracker — per-turn tool_execution_end counts (windowed in handler).
const churnWindow: Array<{ turn: number; count: number }> = [];
let churnCountTurn = -1;

// User-facing only; never into model context.
const stats = {
	assistantMsgs: 0,
	markerMisses: 0,
	registerDrifts: 0,
	ratioBreaches: 0,
	hardBreaches: 0,
	reanchors: 0,
	hookInjections: 0,
	blockedRepeats: 0,
	churnFires: 0,
	pressureFires: 0,
	canonFires: 0,
	blockedEventsSeen: 0,
	outputTokens: 0,
	costUsd: 0,
	reasoningChars: 0,
	textChars: 0,
};

// ── Detector ────────────────────────────────────────────────────────────────
interface DriftResult {
	markerMissing: boolean;
	registerDrift: boolean;
	ratio: number;
	hasThinking: boolean;
	hasText: boolean;
	textHasBody: boolean;
}

function detectDrift(msg: {
	content?: Array<{ type?: string; text?: string; thinking?: string }>;
}): DriftResult | null {
	const content = msg.content;
	if (!Array.isArray(content) || content.length === 0) return null;

	const thinkBlocks = content.filter((c) => c.type === "thinking");
	const textBlocks = content.filter((c) => c.type === "text");

	const hasThinking = thinkBlocks.length > 0;
	const hasText = textBlocks.length > 0;

	// Marker check (R10): case- and punctuation-normalized — a lowercase
	// "caveman mode" without the period is a hit, not a false miss.
	let markerMissing = false;
	let registerDrift = false;
	if (hasThinking) {
		const norm = (s: string): string =>
			s
				.trim()
				.toLowerCase()
				.replace(/[.!,;:]+$/, "");
		const firstLine = norm((thinkBlocks[0]?.thinking ?? "").split("\n")[0] ?? "");
		markerMissing = !MARKER_FALLBACKS.some((m) => firstLine.startsWith(norm(m)));
		// Register signal (R8): independent of the marker — caveman reasoning is
		// short-sentenced and article/hedge-free; prose thinking is not. Only
		// evaluated when the marker is present (a miss is already the stronger
		// signal). ≥2 of 3 cheap heuristics = register drift; no ML involved.
		if (!markerMissing) {
			const thinking = thinkBlocks.map((b) => b?.thinking ?? "").join(" ");
			if (thinking.length >= 200) {
				const sentences = thinking.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0);
				const meanSentence = sentences.length > 0 ? thinking.length / sentences.length : 0;
				const longSentences = meanSentence > 120; // prose averages 100+ chars/sentence
				const fillers = (
					thinking.match(
						/\b(the|a|an|perhaps|arguably|generally|typically|essentially|basically|overall|likely|possibly)\b/gi,
					) ?? []
				).length;
				const dense = (fillers / thinking.length) * 100 > 2.5; // caveman drops articles/hedges
				const firstPerson = /\b(i will|i'll|let me|i'm going to|i should)\b/i.test(thinking);
				const signals = (longSentences ? 1 : 0) + (dense ? 1 : 0) + (firstPerson ? 1 : 0);
				registerDrift = signals >= 2;
			}
		}
	}

	// Verbosity ratio: thinking chars vs answer text chars (normalizes difficulty).
	// Only meaningful when the answer is substantial — a terse caveman block over a
	// trivial reply (e.g. "ok", "done.") is NOT prose; the degenerate denominator
	// would flag every short answer as verbose (false positive).
	const thinkChars = thinkBlocks.reduce((a, b) => a + (b?.thinking?.length ?? 0), 0);
	const textChars = textBlocks.reduce((a, b) => a + (b?.text?.length ?? 0), 0);
	const textHasBody = textChars >= TEXT_MIN_FOR_RATIO;
	const ratio = textChars > 0 ? thinkChars / textChars : 0;

	return { markerMissing, registerDrift, ratio, hasThinking, hasText, textHasBody };
}

// Block-result markers: the distinct texts our block layers emit
// (command-guard R1/R2 + RAW-INPUT redirects, context-mode #852 confinement,
// security denies).
const BLOCK_MARKERS = [
	"R1:", // command-guard redirect
	"R2:", // command-guard build-output redirect
	"RAW-INPUT:", // command-guard synthetic-input redirect
	"resolves outside the project root", // context-mode #852 confinement
	"blocked by security policy", // cc-safety-net / context-mode denies
	"blocked segment:", // command-guard reason suffix
	"File access blocked", // context-mode/safety-net file deny prefix
];

function resultText(result: unknown): string {
	try {
		const r = result as { content?: Array<{ type?: string; text?: string }>; text?: string };
		if (typeof r?.text === "string") return r.text;
		return (r?.content ?? []).map((c) => c?.text ?? "").join(" ");
	} catch {
		return "";
	}
}

function isBlockedResult(result: unknown): boolean {
	const text = resultText(result);
	return BLOCK_MARKERS.some((m) => text.includes(m));
}

// R5: every injected line carries a stable category tag ([anchor]/[nudge])
// so the model can never mistake it for a user instruction — the tag
// association strengthens salience over time instead of habituating.
// R6: action nudges (churn/pressure/blocked) land SECOND-TO-LAST,
// immediately before the real user turn, so the actual request stays the
// freshest user signal; register-class lines (canon) stay tail.
// Accounting fix: hook lines no longer inflate stats.reanchors.
// Injection log (~/.local/share/pi-anchor/log.jsonl). Injected lines live only
// in the outgoing message array — the context handler receives a deep copy — so
// they never reach the session jsonl and cannot be reconstructed after the
// fact. This append-only log is the only measure of anchor traffic; the monthly
// pi-tool-burn report reads it like the command-guard log. `kind` is the layer
// (anchor / nudge / set-anchor), `label` the specific line.
function logInjection(kind: string, label?: string): void {
	hookLog("drift-anchor", kind, {
		...(label ? { label: label.slice(0, 200) } : {}),
		turn: state.turn,
	});
}

function pushHookLine(
	messages: unknown[],
	line: string,
	position: "tail" | "second-to-last",
	label: string,
): void {
	const entry = { role: "user", content: [{ type: "text", text: `[nudge] ${line}` }] };
	// R6 holds only while the array TAIL is the real user turn: second-to-last
	// then means "immediately before the request", which is the whole point of
	// the position. The rule the splice must never break is "never insert inside a
	// run that still owes results": a request is issued only after a tool batch's
	// results have all landed, so a toolResult tail is a CLOSED run whose results
	// already sit behind the assistant that declared them — appending after it is
	// always legal, landing inside it never is:
	// … tool(A), user(nudge), tool(B) … A provider rejects any tool message that
	// is not part of the run answering the nearest preceding assistant
	// ("Messages with role 'tool' must be a response to a preceding message with
	// 'tool_calls'"), so the run dies on its next call. Requiring a user tail is
	// the cheap sufficient test for that rule; a tail that is neither a user turn
	// nor a tool result (an assistant message) also takes the tail path, one
	// message later than it used to.
	const tailMsg = messages[messages.length - 1] as { role?: unknown } | undefined;
	const tailIsUser = tailMsg?.role === "user";
	if (position === "second-to-last" && messages.length > 0 && tailIsUser) {
		messages.splice(messages.length - 1, 0, entry);
	} else {
		messages.push(entry);
	}
	state.lastInjectTurn = state.turn;
	stats.hookInjections++;
	logInjection("nudge", label);
}

// ── Extension ───────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI): void {
	// Persistence: restore the anchor on session start (compaction/reload-safe).
	pi.on("session_start", async (_event, ctx) => {
		try {
			let restored:
				| { phrase?: string; hooks?: AnchorHooks; version?: number; pressureFires?: number }
				| undefined;
			for (const entry of ctx.sessionManager.getEntries()) {
				const e = entry as { type?: string; customType?: string; data?: any };
				// LEGACY_CONFIG_ENTRY: sessions persisted before the rename.
				if (
					e.type === "custom" &&
					(e.customType === ANCHOR_CONFIG_ENTRY || e.customType === LEGACY_CONFIG_ENTRY) &&
					e.data?.phrase
				)
					restored = e.data;
			}
			if (restored) {
				sessionAnchor = {
					phrase: restored.phrase!,
					hooks: restored.hooks ?? {},
					version: restored.version ?? ANCHOR_SCHEMA_VERSION,
					lastChurnInjectTurn: -Infinity,
					lastPressureInjectTurn: -Infinity,
					// NIT-7 (partial): pressureFires is the only runtime counter that
					// survives a reload coherently — the turn-stamped windows gate on
					// state.turn, which is per-process and cannot be reconstructed.
					pressureFires: typeof restored.pressureFires === "number" ? restored.pressureFires : 0,
					lastBlockedInjectTurn: -Infinity,
				};
				// Anchor the periodic cadence from restore time — never inject on the
				// very first context call after a reload.
				periodicAnchorTurn = state.turn;
				periodicJitterTurns = nextPeriodicInterval();
				canonAnchorTurn = state.turn;
				state.lastInjectTurn = state.turn;
			}
			// The maintenance and canon cadences run in EVERY session, with or
			// without set_anchor: the phrase only joins the rotation and the hooks
			// stay opt-in. Anchoring both cadences here (not at -Infinity) keeps a
			// fresh session from firing on its very first context call.
			periodicAnchorTurn = state.turn;
			periodicJitterTurns = nextPeriodicInterval();
			canonAnchorTurn = state.turn;
		} catch {
			/* fail-open: a restore failure leaves the default anchor */
		}
	});

	// Detection: read-only, on the finalized assistant message. Never rewrite
	// the thinking block — message_end replacement relabels, it does not
	// re-generate, and a doctored chain-of-thought corrupts replay.
	pi.on("message_end", (event, ctx) => {
		try {
			if (!readConfig().enabled) return;
			const msg = event.message as {
				role?: string;
				content?: Array<{ type?: string; text?: string; thinking?: string }>;
				usage?: { output?: number; cost?: { total?: number } };
			};
			if (msg.role !== "assistant") return;

			state.turn++;
			stats.assistantMsgs++;
			if (msg.usage) {
				stats.outputTokens += msg.usage.output ?? 0;
				stats.costUsd += msg.usage.cost?.total ?? 0;
			}

			const res = detectDrift(msg);
			if (!res) return;

			// Track reasoning/text char totals for the user-facing proxy.
			const thinkChars = (msg.content ?? [])
				.filter((c) => c.type === "thinking")
				.reduce((a, b) => a + (b?.thinking?.length ?? 0), 0);
			const textChars = (msg.content ?? [])
				.filter((c) => c.type === "text")
				.reduce((a, b) => a + (b?.text?.length ?? 0), 0);
			stats.reasoningChars += thinkChars;
			stats.textChars += textChars;

			const cfg = readConfig();
			const registerEnabled = sessionAnchor
				? sessionAnchor.hooks.register?.enabled !== false
				: true;
			const ratioWarn = sessionAnchor?.hooks.register?.ratioWarn ?? cfg.ratioWarn;
			if (registerEnabled && res.markerMissing) {
				state.lastMarkerMissTurn = state.turn;
				stats.markerMisses++;
			}
			if (registerEnabled && res.registerDrift) {
				state.lastRegisterDriftTurn = state.turn;
				stats.registerDrifts++;
			}
			if (registerEnabled && res.ratio > ratioWarn && res.textHasBody) {
				state.lastRatioTurn = state.turn;
				stats.ratioBreaches++;
			}
			// NIT-6 (Uma 2026-09-08): hard must never sit below an overridden warn —
			// a session ratioWarn > cfg.ratioHard would invert the semantics.
			const ratioHard = Math.max(cfg.ratioHard, ratioWarn);
			if (registerEnabled && res.ratio >= ratioHard && res.textHasBody) {
				stats.hardBreaches++;
			}
			// Detection only — no replacement, no verdict injected.
		} catch {
			/* fail-open: detection never crashes */
		}
	});

	// Tool-result observers: toolChurn counts + blockedToolRepeat marker match.
	pi.on("tool_execution_end", (event, ctx) => {
		try {
			const ev = event as {
				toolCallId?: string;
				toolName?: string;
				result?: unknown;
				isError?: boolean;
			};

			// toolChurn window (counts every completed tool call, errored or not).
			if (churnCountTurn !== state.turn) {
				churnWindow.push({ turn: state.turn, count: 1 });
				if (churnWindow.length > 128) churnWindow.shift();
				churnCountTurn = state.turn;
			} else if (churnWindow.length > 0) {
				churnWindow[churnWindow.length - 1].count++;
			}

			// blockedToolRepeat (default-on): blocked results carry distinctive
			// block-layer texts — counted per turn for the sliding window.
			if (ev.isError && isBlockedResult(ev.result)) {
				blockedTurns.push(state.turn);
				if (blockedTurns.length > 64) blockedTurns.shift();
				stats.blockedEventsSeen++;
			}
		} catch {
			/* fail-open */
		}
	});

	// Re-anchor + hooks: append lines to the TAIL of the messages, cache-safe,
	// ephemeral (the context handler gets a deep copy). Lines state rules; they
	// NEVER state verdicts.
	pi.on("context", (event, ctx) => {
		try {
			const cfg = readConfig();
			if (!cfg.enabled) return;
			const messages = event.messages as unknown[];
			if (!Array.isArray(messages) || messages.length === 0 || state.turn === 0) return;

			const hooks = sessionAnchor?.hooks;

			// R3: per-turn cap of 1 injected line. Candidates are computed
			// READ-ONLY (state mutations live inside the fire() closures, so a
			// dropped lower-priority line leaves no side effects), then exactly
			// ONE fires, priority-ranked drift > canon > pressure > churn >
			// blocked. A confluence turn no longer stacks up to 4 user-role
			// nudges into a single LLM call, and a low-value hook can no longer
			// starve a higher-priority line for minTurnsSinceInject turns.
			type Candidate = { rank: number; fire: () => void };
			let chosen: Candidate | null = null;
			const consider = (rank: number, fire: () => void): void => {
				if (!chosen || rank < chosen.rank) chosen = { rank, fire };
			};

			// Re-anchor rotation (R7: the defaults vary FRAMING — rule / question /
			// example / trigger — not just synonyms): a set_anchor phrase JOINS the
			// rotating caveman lines as an additional entry (append-merge —
			// re-anchors alternate between the default lines and the custom one);
			// no set_anchor → default behaviour, unchanged.
			const pickRotation = (): string => {
				if (sessionAnchor) {
					const rotation = cfg.rotate
						? [...REANCHOR_LINES, sessionAnchor.phrase]
						: [REANCHOR_LINES[0], sessionAnchor.phrase];
					return rotation[state.rotatedIdx++ % rotation.length];
				}
				return cfg.rotate
					? REANCHOR_LINES[state.rotatedIdx++ % REANCHOR_LINES.length]
					: REANCHOR_LINES[0];
			};

			// Rank 0 — drift re-anchor. R9: a marker miss fires on the VERY NEXT
			// context (window=1) with the short immediate line — the root cause is
			// self-reinforcement (the model imitates its own drifted block), so the
			// anchor must land before a streak forms; the windowed paths (ratio,
			// register drift) keep the gentler rotation. R3: drift gates on its OWN
			// lastDriftInjectTurn — hooks can never starve it.
			const driftWindow = cfg.driftWindow;
			const markerMissImmediate = state.lastMarkerMissTurn >= state.turn - 1;
			const windowedDrift =
				state.lastRatioTurn >= state.turn - driftWindow ||
				state.lastRegisterDriftTurn >= state.turn - driftWindow;
			// MAJOR-1: persistent-drift backoff. A fire of the SAME signal within
			// the current episode escalates the gap through DRIFT_BACKOFF_LADDER
			// (3→6→12, capped); a new signal or a fresh episode stays at the base
			// gap. When both signals trip, marker wins the identity (it takes the
			// immediate-line path — the stronger signal).
			const driftSignal = markerMissImmediate ? "marker" : windowedDrift ? "windowed" : null;
			const sameEpisode =
				driftSignal !== null &&
				driftSignal === state.lastDriftSignal &&
				state.turn - state.lastDriftInjectTurn <= PERIODIC_EVERY;
			const driftGap = sameEpisode
				? DRIFT_BACKOFF_LADDER[Math.min(state.driftFireStreak, DRIFT_BACKOFF_LADDER.length - 1)]
				: cfg.minTurnsSinceInject;
			if (
				(markerMissImmediate || windowedDrift) &&
				state.turn - state.lastDriftInjectTurn >= driftGap
			) {
				consider(0, () => {
					const line = markerMissImmediate ? REANCHOR_IMMEDIATE_LINE : pickRotation();
					// Tail injection ([anchor], R5): positionally fresh, cache-safe.
					messages.push({ role: "user", content: [{ type: "text", text: `[anchor] ${line}` }] });
					logInjection("anchor", markerMissImmediate ? "drift-immediate" : "drift-rotation");
					state.lastInjectTurn = state.turn;
					state.lastDriftInjectTurn = state.turn;
					state.driftFireStreak = sameEpisode ? state.driftFireStreak + 1 : 0;
					state.lastDriftSignal = driftSignal;
					stats.reanchors++;
				});
			}

			// Rank 0 — periodic maintenance dose (R1): fires only in QUIET periods
			// (no drift anchor in ~PERIODIC_EVERY turns — a fixed-interval beat is
			// the most habituation-prone schedule and teaches the model to
			// outsource register to the reminder) on a jittered interval so the
			// beat is not anticipatable. Independent of set_anchor: the cadence is
			// the layer that works, so it must not depend on a configuration call.
			const driftRecentlyAnchored = state.lastDriftInjectTurn >= state.turn - PERIODIC_EVERY;
			const periodicDue =
				!driftRecentlyAnchored && state.turn - periodicAnchorTurn >= periodicJitterTurns;
			if (periodicDue) {
				consider(0, () => {
					const line = pickRotation();
					messages.push({ role: "user", content: [{ type: "text", text: `[anchor] ${line}` }] });
					logInjection("anchor", "periodic");
					periodicAnchorTurn = state.turn;
					periodicJitterTurns = nextPeriodicInterval();
					state.lastInjectTurn = state.turn;
					state.lastDriftInjectTurn = state.turn;
					stats.reanchors++;
				});
			}

			// Rank 1 — canon cadence (R2: anchored at set/restore time, NO offset —
			// the old offset made canon collide with periodic at T+20). Rotation
			// fights the fixed-text × fixed-interval habituation (R4).
			// Dedupe (2026-09-08): same-step stacking is already impossible (single
			// chosen/picked fire below — anchor rank 0 beats canon rank 1), but a
			// tool-loop user turn spans multiple LLM steps, so canon could fire on
			// the step right AFTER an anchor injection → stacked blocks in one user
			// turn. Canon now also defers while ANY drift-anchor injection landed
			// within the anti-habituation gap; it stays due and fires on the first
			// quiet step instead (anchor wins over nudge, across adjacent steps too).
			if (
				state.turn - canonAnchorTurn >= CANON_EVERY &&
				state.turn - state.lastInjectTurn >= cfg.minTurnsSinceInject
			) {
				consider(1, () => {
					const canonLine = CANON_LINES[stats.canonFires % CANON_LINES.length];
					canonAnchorTurn = state.turn;
					pushHookLine(messages, canonLine, "tail", "canon");
					stats.canonFires++;
				});
			}

			// Rank 2 — pressure (opt-in via set_anchor; at most
			// PRESSURE_MAX_PER_SESSION fires).
			const pressureCfg = hooks?.pressure;
			if (
				pressureCfg &&
				sessionAnchor!.pressureFires < PRESSURE_MAX_PER_SESSION &&
				state.turn - sessionAnchor!.lastPressureInjectTurn >= cfg.minTurnsSinceInject &&
				state.turn - state.lastInjectTurn >= cfg.minTurnsSinceInject // MAJOR-2: global one-injection gap (same as canon/blocked)
			) {
				try {
					const usage = (
						ctx as ExtensionContext & {
							getContextUsage?: () => { tokens?: number; window?: number } | undefined;
						}
					).getContextUsage?.();
					const pct =
						usage && usage.tokens && usage.window
							? Math.round((usage.tokens / usage.window) * 100)
							: undefined;
					const warnAt = pressureCfg.warnAtPct ?? PRESSURE_WARN_AT_PCT;
					if (pct !== undefined && pct >= warnAt) {
						const pressureDefault = `Context at ~${pct}%. Land what you have — write the durable artifact now, then hand the rest off.`;
						consider(2, () => {
							// Append-merge: a custom hook message rides AFTER the default line.
							pushHookLine(
								messages,
								pressureCfg.message ? `${pressureDefault} ${pressureCfg.message}` : pressureDefault,
								"second-to-last",
								"pressure",
							);
							sessionAnchor!.lastPressureInjectTurn = state.turn;
							sessionAnchor!.pressureFires++;
							stats.pressureFires++;
						});
					}
				} catch {
					/* getContextUsage unavailable → hook silently inert */
				}
			}

			// Rank 3 — toolChurn (opt-in via set_anchor).
			const churnCfg = hooks?.toolChurn;
			if (
				churnCfg &&
				state.turn - sessionAnchor!.lastChurnInjectTurn >= cfg.minTurnsSinceInject &&
				state.turn - state.lastInjectTurn >= cfg.minTurnsSinceInject // MAJOR-2: global one-injection gap (same as canon/blocked)
			) {
				const windowTurns = churnCfg.windowTurns ?? CHURN_WINDOW_TURNS;
				const max = churnCfg.maxPerWindow ?? CHURN_MAX_PER_WINDOW;
				// NIT-8 (Uma 2026-09-08): tool_execution_end labels a step's tool
				// calls with state.turn BEFORE message_end increments it (label =
				// step-1), so `>` dropped one step from the window. `>=` keeps labels
				// T-windowTurns..T-1 = exactly the last windowTurns completed steps.
				const total = churnWindow
					.filter((c) => c.turn >= state.turn - windowTurns)
					.reduce((a, b) => a + b.count, 0);
				if (total > max) {
					const churnDefault = `${total} tool calls in the last ${windowTurns} turns without landing anywhere. Name in one line what the last tool bought you, then either commit it somewhere durable or report.`;
					consider(3, () => {
						// Append-merge: a custom hook message rides AFTER the default line.
						pushHookLine(
							messages,
							churnCfg.message ? `${churnDefault} ${churnCfg.message}` : churnDefault,
							"second-to-last",
							"churn",
						);
						sessionAnchor!.lastChurnInjectTurn = state.turn;
						stats.churnFires++;
					});
				}
			}

			// Rank 4 — blockedToolRepeat (DEFAULT-ON in every session; opt-out only
			// via set_anchor hooks.blockedToolRepeat.enabled === false).
			const blockedCfg = hooks?.blockedToolRepeat;
			const blockedEnabled = blockedCfg ? blockedCfg.enabled !== false : true;
			if (blockedEnabled && state.turn - state.lastInjectTurn >= cfg.minTurnsSinceInject) {
				const windowTurns = blockedCfg?.windowTurns ?? BLOCKED_WINDOW_TURNS;
				const threshold = blockedCfg?.threshold ?? BLOCKED_THRESHOLD;
				// NIT-8: same label off-by-one as the churn window above.
				const recent = blockedTurns.filter((t) => t >= state.turn - windowTurns).length;
				if (recent >= threshold) {
					consider(4, () => {
						// Capability probe at fire time — only this closure runs on a win,
						// and the line must match the menu of the session that reads it.
						const line = blockedRepeatLine(callerCaps(pi));
						// Append-merge: a custom hook message rides AFTER the default line.
						pushHookLine(
							messages,
							blockedCfg?.message ? `${line} ${blockedCfg.message}` : line,
							"second-to-last",
							"blocked",
						);
						stats.blockedRepeats++;
					});
				}
			}

			const picked = chosen as Candidate | null;
			if (picked) picked.fire();
			return { messages };
		} catch {
			return; // fail-open: never crash on injection
		}
	});

	// set_anchor: session anchor configuration (v1 schema). A repeat call is a
	// realignment and is ACCEPTED by the tool body — nothing gates it, so this
	// extension registers no `tool_call` handler for it.
	pi.registerTool({
		name: "set_anchor",
		label: "Set Anchor",
		description:
			"Configure this session's drift anchor. Call it ONCE, early — once you have read your skill files and are ready to start working. Pass `phrase`: a short realignment line (imperative register, no self-verdicts) re-injected on drift and periodically. The phrase must name a risk THIS session carries and canon does not already state (e.g. 'One writer per file — re-read a shared module before every edit'); do NOT restate the caveman register or canon rules such as verify-before-done or todo discipline — those are injected every turn already, and the phrase only displaces one of the varied default lines. Optionally pass `hooks` to tune detectors: toolChurn {maxPerWindow, windowTurns} (foreman 'too much tool use'), pressure {warnAtPct} (context window), register {enabled, ratioWarn}, blockedToolRepeat {enabled, threshold, windowTurns}. Unknown hook keys are ignored. Calling it again is ACCEPTED but should be extremely rare: it exists to REALIGN behaviour late in a very long conversation, not for routine use or as a per-phase reset. A repeat replaces the phrase, applies the hook keys you pass (hooks you do not mention keep their configured values), and restarts the injection cadence from that call; frequent repeats turn the anchor into wallpaper and spend the slot it needs.",
		parameters: Type.Object({
			phrase: Type.String({
				description:
					"Short realignment line, imperative register, no self-verdicts. Name something canon does NOT cover — this session's specific failure risk, e.g. 'One writer per file — re-read a shared module before every edit.' Do NOT restate the caveman register or canon rules (verify-before-done, todo discipline): the canon block is in the system prompt every turn.",
			}),
			hooks: Type.Optional(
				Type.Object({
					register: Type.Optional(
						Type.Object({
							enabled: Type.Optional(
								Type.Boolean({ description: "Register-decay anchor on/off (default true)" }),
							),
							ratioWarn: Type.Optional(
								Type.Number({ description: "thinking:text ratio threshold (default 6)" }),
							),
							message: Type.Optional(
								Type.String({ description: "Custom register re-anchor line" }),
							),
						}),
					),
					toolChurn: Type.Optional(
						Type.Object({
							maxPerWindow: Type.Optional(
								Type.Number({ description: "Tool calls allowed per window (default 25)" }),
							),
							windowTurns: Type.Optional(
								Type.Number({ description: "Window size in turns (default 8)" }),
							),
							message: Type.Optional(Type.String({ description: "Custom churn line" })),
						}),
					),
					pressure: Type.Optional(
						Type.Object({
							warnAtPct: Type.Optional(
								Type.Number({ description: "Context-window % that fires the anchor (default 80)" }),
							),
							message: Type.Optional(Type.String({ description: "Custom pressure line" })),
						}),
					),
					blockedToolRepeat: Type.Optional(
						Type.Object({
							enabled: Type.Optional(
								Type.Boolean({ description: "Blocked-repeat anchor on/off (default true)" }),
							),
							threshold: Type.Optional(
								Type.Number({ description: "Blocked results within window that fire (default 3)" }),
							),
							windowTurns: Type.Optional(
								Type.Number({ description: "Window size in turns (default 4)" }),
							),
							message: Type.Optional(Type.String({ description: "Custom blocked-repeat line" })),
						}),
					),
				}),
				{ description: "Optional hook configuration; unknown keys are ignored" },
			),
		}),
		// Header only (display): the realignment phrase this session is anchored to.
		renderCall(args, theme) {
			return safeToolHeader(theme, "set_anchor", () => {
				const phrase = argText(args, "phrase");
				return phrase ? [["accent", ` ${clip(phrase, 100)}`]] : [];
			});
		},
		async execute(_toolCallId: string, params: { phrase: string; hooks?: AnchorHooks }) {
			// A repeat call is a realignment, not a second anchor: `previous` is the
			// anchor already configured this session (null on the first call).
			const previous = sessionAnchor;
			// Hook config merges per hook KEY: a key the caller passes is replaced by
			// the passed value, a key the caller omits keeps its configured value
			// (nothing configured → the detector defaults apply). Unknown hook keys
			// are dropped here — only the known v1 keys persist.
			const hooks: AnchorHooks = { ...(previous?.hooks ?? {}) };
			if (params.hooks) {
				if (params.hooks.register) hooks.register = params.hooks.register;
				if (params.hooks.toolChurn) hooks.toolChurn = params.hooks.toolChurn;
				if (params.hooks.pressure) hooks.pressure = params.hooks.pressure;
				if (params.hooks.blockedToolRepeat)
					hooks.blockedToolRepeat = params.hooks.blockedToolRepeat;
			}
			const anchor: SessionAnchor = {
				phrase: params.phrase,
				hooks,
				version: ANCHOR_SCHEMA_VERSION,
				// Hook fire bookkeeping CARRIES OVER a realignment: the phrase is what
				// a repeat changes, never how often the hooks fire — a reset here would
				// let a capped hook (pressure) spend its cap a second time.
				lastChurnInjectTurn: previous?.lastChurnInjectTurn ?? -Infinity,
				lastPressureInjectTurn: previous?.lastPressureInjectTurn ?? -Infinity,
				pressureFires: previous?.pressureFires ?? 0,
				lastBlockedInjectTurn: previous?.lastBlockedInjectTurn ?? -Infinity,
			};
			sessionAnchor = anchor;
			// Anchor the periodic cadence from set time — the tool result already
			// announces the phrase; the first periodic injection comes ~PERIODIC_EVERY
			// turns later (or earlier on drift, which stays immediately responsive).
			// A realignment restarts the line rotation and both cadences so the new
			// phrase starts its own cadence instead of inheriting the old one's phase.
			periodicAnchorTurn = state.turn;
			periodicJitterTurns = nextPeriodicInterval();
			canonAnchorTurn = state.turn;
			state.rotatedIdx = 0;
			logInjection("set-anchor", params.phrase);
			try {
				// Durable across compaction/reloads; restored on session_start.
				(pi as any).appendEntry?.(ANCHOR_CONFIG_ENTRY, {
					phrase: params.phrase,
					hooks,
					version: ANCHOR_SCHEMA_VERSION,
					pressureFires: anchor.pressureFires, // NIT-7: persisted so the 2-fire cap survives reloads
				});
			} catch {
				/* persistence failure never fails the tool */
			}
			const active = [
				"register (default)",
				"blockedToolRepeat (default-on)",
				...(hooks.toolChurn
					? [
							`toolChurn >${hooks.toolChurn.maxPerWindow ?? CHURN_MAX_PER_WINDOW}/${hooks.toolChurn.windowTurns ?? CHURN_WINDOW_TURNS}t`,
						]
					: []),
				...(hooks.pressure
					? [`pressure @${hooks.pressure.warnAtPct ?? PRESSURE_WARN_AT_PCT}%`]
					: []),
			];
			return {
				content: [
					{
						type: "text" as const,
						text: previous
							? `anchor updated. Re-anchor line is now "${params.phrase}" — the previous phrase is gone, the rotation and both jittered cadences restart from this call (~${PERIODIC_EVERY}±${PERIODIC_JITTER} turns, deferred while drift anchoring is active); separate canon cadence every ~${CANON_EVERY} turns. Hooks: ${active.join(", ")}. Realign again only if behaviour drifts late in a long conversation — frequent calls make the anchor wallpaper.`
							: `anchor set. Re-anchor line: "${params.phrase}" — joins the default re-anchor rotation (alternates with the default lines), injected immediately on drift and as a jittered maintenance dose every ~${PERIODIC_EVERY}±${PERIODIC_JITTER} turns (deferred while drift anchoring is active); separate canon cadence every ~${CANON_EVERY} turns. Hooks: ${active.join(", ")}.`,
					},
				],
				details: {
					phrase: params.phrase,
					hooks,
					version: ANCHOR_SCHEMA_VERSION,
					updated: previous != null,
				},
			};
		},
	});

	// Control surface: /anchor status | on | off
	pi.registerCommand("anchor", {
		description:
			"drift-anchor. Usage: /anchor status | on | off — re-anchors the 'Caveman mode.' reasoning register when drift is detected (plus jittered maintenance, canon, and hook lines), and surfaces reasoning-token cost to the USER.",
		handler: async (args, ctx) => {
			try {
				const arg = (args ?? "").trim().toLowerCase();
				const cfg = readConfig();

				if (arg === "on") {
					cfg.enabled = true;
					writeConfig(cfg);
					ctx.ui.notify("drift-anchor ON", "info");
					return;
				}
				if (arg === "off") {
					cfg.enabled = false;
					writeConfig(cfg);
					ctx.ui.notify("drift-anchor OFF", "info");
					return;
				}

				// status (default)
				const share =
					stats.textChars > 0
						? Math.round((stats.reasoningChars / (stats.reasoningChars + stats.textChars)) * 100)
						: 0;
				const msg = [
					`drift-anchor: ${cfg.enabled ? "ON" : "OFF"}`,
					`assistant msgs ${stats.assistantMsgs} · marker misses ${stats.markerMisses} · register drifts ${stats.registerDrifts} · re-anchors ${stats.reanchors} · hook injections ${stats.hookInjections}${sessionAnchor ? ` · set_anchor v${sessionAnchor.version} active` : ""}`,
					`blocked results seen ${stats.blockedEventsSeen} · blocked-repeat nudges ${stats.blockedRepeats} · churn fires ${stats.churnFires} · pressure fires ${stats.pressureFires} · canon fires ${stats.canonFires}`,
					`reasoning share ~${share}% of output chars · ${Math.round(stats.outputTokens / 1000)}k output tokens · $${stats.costUsd.toFixed(3)}`,
					`(char-based proxy — chars are not tokens, user-only)`,
				].join("\n");
				ctx.ui.notify(msg, "info");
			} catch {
				ctx.ui.notify("anchor: status unavailable", "warning");
			}
		},
	});
}
