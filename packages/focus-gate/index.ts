/**
 * focus-gate: machine-global focus mode for pi.
 *
 * When focus is active, agent sessions keep working (read-only work, file
 * edits, reasoning, reports) but CANNOT intrude on the user's desktop:
 * no screenshots, no workspace swaps/focus changes, no window spawns, no
 * input takeover. NOTIFICATIONS ARE NOT GATED — the user
 * still wants to hear when the agent needs their eyes or has finished every
 * deliverable; only the routine per-response auto-ping is suppressed (in
 * the desktop-notify extension). Blocked attempts are queued to a
 * JSONL ledger surfaced when focus is disabled. NO auto-resume/replay of
 * queued actions — the user decides (deferred items live in the agents'
 * own reports).
 *
 * Design (per the approved plan):
 *  - STATE FILE (machine-global): $XDG_RUNTIME_DIR/pi-focus.json —
 *    { mode: "on"|"off", since, ledger }. tmpfs → resets to off on reboot; no
 *    stale-focus traps. Files written by the earlier three-mode build still
 *    read correctly (quiet/locked meant gated, full meant not gated).
 *  - STATELESS reads: the tool_call gate, the context-event notice and every
 *    consumer read the state file FRESH, so a toggle gates every pi session
 *    from its next tool call. Sessions already streaming finish their
 *    preflighted batch (one minor, documented race).
 *  - PROPAGATION: the file alone carries the MODE. The two things a session
 *    SHOWS — footer indicator and toggle notice — were written by the toggling
 *    session only, so every session process also WATCHES the state file
 *    (`watchFocusState` in lib/focus-state.ts): the moment it moves, that
 *    session re-syncs its own footer from it and ALERTS itself with the toggle
 *    notice, which WAKES an idle session — the flip is known when it happens,
 *    not at the next prompt. The `ipc` "focus" broadcast stays as the
 *    cross-process notice path, and the per-turn `context` re-sync stays the
 *    fallback — the watcher does not depend on the transport being up.
 *  - GATE (hard layer): tool_call blocks the bash content deny-list while
 *    focus is on. Notifications are deliberately absent from it: a
 *    desktop_notify call is never what makes focus mode useful.
 *  - PRE-COMPLIANCE (soft layer): the focus notice is re-stated as ONE TERSE
 *    LINE in a TAIL MESSAGE on the context event while focus is on (one in
 *    flight, stacking guarded) — the mode, that desktop actions are blocked, and
 *    the instruction not to retry or work around them. The long form lives in
 *    the toggle notice, which fires once per toggle. PARENT SESSIONS ONLY: a
 *    child process is hard-gated by this same extension and the refusal its
 *    blocked call returns already names the rule, so a per-turn tail there is
 *    context spent in every child of every lane for nothing (either launch
 *    marker — PI_SUBAGENT, PI_SUBAGENT_CHILD — means a child). It is
 *    deliberately NOT written into the system prompt: replacing the system
 *    prompt re-encodes the cached prefix from its first token on every turn,
 *    which breaks the frozen-prompt guarantee the rest of the session relies
 *    on. A tail line sits in the uncached suffix instead.
 *  - UX: /focus command (no args = toggle; on|off|status — quiet and locked
 *    are accepted as legacy aliases for on), footer status via
 *    ctx.ui.setStatus (re-synced from the file by the watcher and on every
 *    turn, not only at session start), and a toggle notice that ALERTS every
 *    open session at the moment of the toggle: `sendMessage` with
 *    `triggerTurn: true` (an IDLE session starts a turn on the notice) and
 *    `deliverAs: "followUp"` (a streaming session takes it on the agent's
 *    follow-up queue, never the steering queue the user's own typing
 *    occupies). Both directions alert, and both roads (the state-file watch
 *    and the `ipc` channel) announce through ONE `<mode>|<since>` key, so
 *    one toggle is one notice per session however it arrived. Cost, accepted:
 *    one turn per open session per toggle.
 *  - RELEASE: /focus off clears the footer, stops the injection, no-ops the
 *    gate, prints a release summary of THIS session's blocked attempts (entry
 *    count + grouped tool names + its own ledger path) and only THEN clears the
 *    ledgers — every session's, all at once (`clearFocusLedgers`), so no session
 *    is left rendering a stale queued count and a session that already exited
 *    leaves nothing behind.
 *  - No per-command escape hatch (user decision) — ledger + toggle-off is
 *    the only recovery path. No Hyprland keybind (user decision).
 *
 * Fail-open everywhere: an unreadable/corrupt state file = mode full (gate
 * no-op); a handler error = return undefined. A bug here must never crash
 * pi or corrupt a turn.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { hookLog } from "@tinoy/pi-ext-lib";

import {
	clearFocusLedgers,
	FOCUS_STATE_PATH,
	type FocusMode,
	type FocusState,
	focusLedgerPathFor,
	readFocusState,
	watchFocusState,
} from "@tinoy/pi-focus-state";

// ── State (the contract) — the state file, its reader and every ledger path
// convention are owned by focus-state.ts, shared with the notifier and the
// footer's counter.
const MODES: FocusMode[] = ["off", "on"];

// ── Cross-session channel (the ipc transport) ───────────────────────────────
const NAMESPACE = "focus";

interface FocusNotice {
	type: "focus";
	mode: FocusMode;
	since?: string;
	senderName?: string;
}

interface FocusChannel {
	// The channel's publish may throw SYNCHRONOUSLY: it ships the frame and
	// returns void, so there is no promise to catch when the transport is down.
	// A void return has no .catch, so the result must be guarded, never chained
	// blindly.
	publish(payload: unknown, options?: { audience?: "owner" | "capable" }): void;
}

interface FocusRegistration {
	namespace: string;
	ownerEligible: boolean;
	onEvent(event: { type: string; fromSessionId?: string; payload?: unknown }): void;
	onReady(readyChannel: FocusChannel): void;
}

interface WrittenFocusState {
	mode: FocusMode;
	since: string;
}

function writeState(mode: FocusMode): WrittenFocusState {
	const state: WrittenFocusState = {
		mode,
		since: mode === "off" ? "" : new Date().toISOString(),
	};
	try {
		writeFileSync(FOCUS_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		/* state write failure: the footer/notice still reflect the intent */
	}
	return state;
}

// ── The gate (hard layer) — the deny-list, active while focus is on ────────
// Content regexes (case-insensitive), tested against EVERY text a gated tool
// can carry a desktop action in — see commandTexts.
// Notifications (desktop_notify, notify-send, hyprctl notify) are NOT here:
// the user wants to be told when the agent needs their eyes or is done.
// NOTE (honest bypass): these are text-based — a determined agent could spell a
// command so the patterns miss it. Mitigation = the pre-compliance injection;
// the gate prevents ACCIDENTAL intrusion, not malice.
interface GatePattern {
	re: RegExp;
	label: string;
	/** The match is ignored when this also matches (build-only command forms). */
	unless?: RegExp;
}

const BASH_PATTERNS: GatePattern[] = [
	// Compositor state changes. `hyprctl dispatch` is blocked wholesale because
	// the working 0.56 form is Lua (`hyprctl dispatch 'hl.dsp.focus({...})'`) — a
	// quote follows `dispatch`, so matching argument shapes (workspace/focus/…)
	// gated almost nothing.
	{ re: /hyprctl\s+dispatch\b/i, label: "Hyprland: hyprctl dispatch (compositor state change)" },
	{ re: /hyprctl\s+keyword/i, label: "Hyprland: hyprctl keyword" },
	// Screenshots
	{
		re: /\b(grim|grimblast|hyprshot|spectacle|scrot|maim|flameshot)\b/i,
		label: "grim: desktop screenshot (grimblast, hyprshot, spectacle, scrot, maim, flameshot)",
	},
	// Input takeover — the raw tools AND the `inject` wrapper, which is the
	// sanctioned front end and therefore the likelier call shape.
	{
		re: /\b(ydotool|wtype|dotool|xdotool|kdotool)\b/i,
		label: "inject: input takeover, raw form (ydotool, wtype, dotool, xdotool, kdotool)",
	},
	{
		re: /(?:^|[;&|(]\s*)(?:[\w./-]*\/)?inject\s+(?:click|drag|move|scroll|type|key|release)\b/i,
		label: "inject: input takeover (the sanctioned wrapper)",
	},
	// Window/app spawns
	{ re: /\bgtk-launch\b/i, label: "gtk-launch: app spawn" },
	// Terminal emulators, matched at COMMAND POSITION only: a `&`-anywhere
	// heuristic also caught read-only commands (`find kitty -type f && …`).
	{
		re: /(?:^|[;&|(]\s*|\b(?:nohup|setsid|exec|timeout\s+\S+)\s+)(?:[\w./-]*\/)?(kitty|alacritty|foot|wezterm|ghostty)\b/i,
		label: "terminal emulator: app spawn (kitty, alacritty, foot, wezterm, ghostty)",
	},
	// App spawns. `AGS_BUNDLE_WARM=1` makes run.sh build-only (it never execs the
	// app), so that form stays allowed while a launching call is gated.
	{
		re: /\brun\.sh\s+[^\s|&;]+/i,
		unless: /AGS_BUNDLE_WARM/,
		label: "AGS: app spawn (shell run.sh)",
	},
	{ re: /\bags\s+run\b/i, label: "AGS: app spawn (ags run)" },
	{ re: /\bags(-route)?\.sh\b.*\b(open|toggle)\b/i, label: "AGS: app open/toggle" },
	{ re: /ags\s+-i\s+\S+\s+request\s+".*\b(open|toggle)\b/i, label: "AGS: app open/toggle" },
];

function inputDigest(toolName: string, input: unknown): string {
	try {
		const raw =
			toolName === "bash" && typeof (input as { command?: string })?.command === "string"
				? (input as { command: string }).command
				: (JSON.stringify(input) ?? "");
		return raw.slice(0, 120);
	} catch {
		return "";
	}
}

/**
 * Every text in a gated tool's input that could carry a desktop action.
 * Reading a single `command` property gated neither sandbox route: `ctx_execute`
 * carries its script in `code`, and `ctx_batch_execute` in `commands[].command`
 * (there is no top-level `command`), so both passed anything through. `probe`
 * shells out to a binary itself and needs its own case.
 */
function commandTexts(toolName: string, input: unknown): string[] {
	const obj = (input ?? {}) as Record<string, unknown>;
	const out: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === "string" && value.length > 0) out.push(value);
	};
	if (toolName === "bash") {
		push(obj.command);
	} else if (toolName === "ctx_execute" || toolName === "ctx_execute_file") {
		push(obj.code);
	} else if (toolName === "ctx_batch_execute") {
		if (Array.isArray(obj.commands)) {
			for (const entry of obj.commands) push((entry as { command?: unknown })?.command);
		}
	} else if (toolName === "probe" && obj.hyprctl === true) {
		push(`hyprctl ${typeof obj.target === "string" ? obj.target : ""}`);
	}
	return out;
}

/** Returns { pattern } when the call matches the deny-list, else null. */
function matchDeny(toolName: string, input: unknown): { pattern: string } | null {
	for (const text of commandTexts(toolName, input)) {
		for (const p of BASH_PATTERNS) {
			if (!p.re.test(text)) continue;
			if (p.unless?.test(text)) continue;
			return { pattern: p.label };
		}
	}
	return null;
}

function appendLedger(
	ledger: string,
	mode: FocusMode,
	toolName: string,
	pattern: string,
	digest: string,
): void {
	try {
		const row = {
			ts: new Date().toISOString(),
			mode,
			tool: toolName,
			pattern,
			inputDigest: digest,
		};
		appendFileSync(ledger, `${JSON.stringify(row)}\n`);
	} catch {
		/* ledger failure must never turn a block into an execution */
	}
}

/**
 * The refusal a blocked call carries. R8: it names the capability that was refused
 * FIRST — the rule label already leads with the binary or service (AGS, Hyprland,
 * grim, the inject wrapper) — so the model reads WHAT it may not do before the
 * instructions about what to do instead.
 */
function blockReason(state: FocusState, ledger: string, refused: string): string {
	return (
		`focus-gate: FOCUS MODE (${state.mode.toUpperCase()}) ACTIVE — user is away. ` +
		`BLOCKED: ${refused}. ` +
		`This action is queued to ${ledger}. ` +
		`Do NOT retry or work around it; continue your task without it and note the deferral in your report.`
	);
}

// ── Pre-compliance (soft layer) — per-turn injection text ───────────────────
const FOCUS_RULE_TEXT =
	"Desktop intrusion is gated: no screenshots, workspace switches, window spawns, or input — attempts are hard-blocked and ledgered. Notifications are NOT gated: ping the user when you need their eyes to proceed, or when every deliverable is done.";

function injectionText(state: FocusState): string {
	return `FOCUS MODE ON (since ${state.since ?? "unknown"}): desktop actions (screenshots, workspace/window/input) are blocked and ledgered — do not retry or work around them.`;
}

/**
 * Is this process a subagent child? TWO launch paths mark one: PI_SUBAGENT=1
 * from the pi-subagent wrapper, PI_SUBAGENT_CHILD=1 from the pi-subagents async
 * runner. Either marker means a child, so both are tested.
 */
function isChildProcess(): boolean {
	return process.env.PI_SUBAGENT === "1" || process.env.PI_SUBAGENT_CHILD === "1";
}

/**
 * The toggle notice, in both directions. Both ALERT the receiving session (see
 * `sendFocusNotice`), so the text opens by naming itself a mode change: a
 * waking message that read like user work would be answered as one. The ON
 * text carries the full rule set because it also satisfies the tail
 * injection's "mode already stated" guard, so a toggle turn states the mode
 * once instead of twice.
 */
function focusNoticeText(mode: FocusMode, trigger: string): string {
	const by = trigger.length > 0 ? ` (${trigger})` : "";
	if (mode === "on") {
		return `[focus] MODE CHANGE, not user work — no reply needed${by}. FOCUS MODE ON: ${FOCUS_RULE_TEXT}`;
	}
	return `[focus] MODE CHANGE, not user work — no reply needed${by}. Focus mode is now OFF — desktop actions are allowed again. Queued actions are NOT auto-replayed; the user decides what to resume.`;
}

/** This process's own focus-mode event, emitted when the state file changes. */
const FOCUS_STATE_CHANGED = "focus:state-changed";

// ── Message text + the mode-aware injection guard ───────────────────────────
/** The statements that mean "the CURRENT mode has already been stated". */
const ON_STATED = ["FOCUS MODE ON", "mode is now ON"];

function messageText(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as Array<{ text?: string }>).map((part) => part.text ?? "").join(" ");
	}
	return "";
}

// ── Footer (at-a-glance) ────────────────────────────────────────────────────
/** One footer write, tolerant of a UI-less context (print/RPC modes). */
function syncFooter(ui: ExtensionUIContext | undefined, mode: FocusMode): void {
	try {
		ui?.setStatus?.("focus", footerText(mode, ui.theme));
	} catch {
		/* footer is cosmetic */
	}
}

const FOCUS_ON_GLYPH = "\uf256"; // fa-hand

/**
 * Footer segment text for a mode, or `undefined` to CLEAR the segment.
 *
 * ON renders the one glyph; OFF returns `undefined`, which is what
 * `setStatus` treats as a clear. Never an empty string: that keeps the segment
 * registered and renders a gap in the footer.
 */
function footerText(
	mode: FocusMode,
	theme: ExtensionUIContext["theme"] | undefined,
): string | undefined {
	if (mode !== "on") return undefined;
	return theme ? theme.fg("accent", FOCUS_ON_GLYPH) : FOCUS_ON_GLYPH;
}

// ── Ledger summary (release) ────────────────────────────────────────────────
function ledgerSummary(path: string): string {
	try {
		if (!existsSync(path))
			return `focus off. This session's ledger is empty (no deferred actions). Ledger: ${path}`;
		const rows = readFileSync(path, "utf8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => {
				try {
					return JSON.parse(l) as { tool?: string };
				} catch {
					return { tool: "(unparsable)" };
				}
			});
		const counts = new Map<string, number>();
		for (const r of rows) {
			const t = r.tool ?? "(unknown)";
			counts.set(t, (counts.get(t) ?? 0) + 1);
		}
		const grouped = [...counts.entries()].map(([t, n]) => `${t} ×${n}`).join(", ");
		return `focus off. ${rows.length} queued action(s) this session: ${grouped}. Ledger: ${path} — review it; nothing is auto-replayed.`;
	} catch {
		return `focus off. Ledger summary unavailable (read failed). Ledger: ${path}`;
	}
}

// ── Extension ───────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI): void {
	let channel: FocusChannel | null = null;
	let mySessionId: string | null = null;

	/** THIS session's ledger: what it appends to, reads back and reports. */
	function sessionLedger(): string {
		return focusLedgerPathFor(mySessionId);
	}

	// ── Live sync: this process watches the state file ────────────────────────
	// The gate reads the state fresh per call, so a toggle already applies
	// machine-wide — but the footer write and the toggle notice were written by
	// the toggling session only, so a peer window kept a stale indicator and
	// learned nothing until it was prompted. Every session process now watches
	// the file itself (one watcher per process, closed at shutdown) and re-syncs
	// both from it, with no dependency on the transport; the per-turn
	// `context` re-sync stays the fallback when a watch cannot start.
	let lastUi: ExtensionUIContext | undefined;
	let seenMode: FocusMode | null = null;
	let stopWatch: (() => void) | null = null;

	/**
	 * Deliver a toggle notice so it ALERTS the session it reaches.
	 *
	 * `triggerTurn: true` is the waking half: with the session idle it appends
	 * the message and runs a new turn, so the flip is known at the moment it
	 * happens. The previous shape, `deliverAs: "nextTurn"`, only ever queued the
	 * message for the next prompt, which left an idle session unalerted until
	 * the user typed.
	 *
	 * `deliverAs: "followUp"` is the non-commandeering half: while the session
	 * is streaming the message joins the agent's follow-up queue. The default
	 * deliverAs ("steer") would push it onto the STEERING queue — the queue the
	 * user's own typed message occupies, which is the behaviour the user
	 * objected to.
	 */
	function sendFocusNotice(content: string, details: Record<string, unknown>): void {
		try {
			const result = pi.sendMessage(
				{ customType: "focus_notice", content, display: true, details },
				{ triggerTurn: true, deliverAs: "followUp" },
			) as unknown as Promise<unknown> | undefined;
			result?.catch?.((err: unknown) =>
				hookLog("focus-gate", "notice-failed", {
					reason: err instanceof Error ? err.message : String(err),
					...details,
				}),
			);
		} catch (err) {
			hookLog("focus-gate", "notice-failed", {
				reason: err instanceof Error ? err.message : String(err),
				...details,
			});
		}
	}

	/** `<mode>|<since>` of the last notice this session delivered. */
	let announcedKey: string | null = null;

	/**
	 * The ONE announce path, whatever carried the news — the state-file watcher,
	 * the `ipc` channel or this session's own `/focus`. The key IS the flip
	 * (`<mode>|<since>`), so the two roads that can both observe one toggle cost
	 * one notice, and a watch that fires twice costs none.
	 */
	function announceMode(mode: FocusMode, since: string | undefined, trigger: string): void {
		const key = `${mode}|${since ?? ""}`;
		if (key === announcedKey) return;
		announcedKey = key;
		sendFocusNotice(focusNoticeText(mode, trigger), { mode, since, trigger });
	}

	/**
	 * A state-file change observed by THIS process: re-sync the footer and tell
	 * the model. The mode is diffed here rather than in the watcher, because the
	 * toggling session must be able to claim the flip it just wrote (`seenMode`)
	 * and stay quiet — it has already synced its own footer and sent its own
	 * notice.
	 */
	function applyObservedMode(state: FocusState, origin: string): void {
		if (state.mode === seenMode) return;
		const previous = seenMode;
		seenMode = state.mode;
		if (lastUi) syncFooter(lastUi, state.mode);
		pi.events.emit(FOCUS_STATE_CHANGED, { mode: state.mode, previous, origin });
		hookLog("focus-gate", "state-change", { mode: state.mode, previous, origin });
		// Both directions alert this session. The watcher fires only for a flip
		// this session did not claim, so the trigger names the other session.
		announceMode(state.mode, state.since, "toggled in another session");
	}

	function startStateWatch(): void {
		if (stopWatch) return;
		stopWatch = watchFocusState(() => {
			try {
				applyObservedMode(readFocusState(), "state-watch");
			} catch {
				/* fail-open: the per-turn re-sync still tracks the file */
			}
		});
	}

	// The file carries the MODE to every session; this channel carries the NEWS
	// when the watcher cannot — a broker failure costs only the peer notice.
	function broadcastToggle(mode: FocusMode, since: string): void {
		if (!channel) {
			hookLog("focus-gate", "broadcast-skipped", { mode, reason: "channel-not-ready" });
			return;
		}
		const payload: FocusNotice = {
			type: "focus",
			mode,
			since,
			senderName: pi.getSessionName() || undefined,
		};
		try {
			const result = channel.publish(payload, { audience: "capable" }) as unknown as
				| Promise<unknown>
				| undefined;
			result?.catch?.((err: unknown) =>
				hookLog("focus-gate", "broadcast-failed", {
					mode,
					reason: err instanceof Error ? err.message : String(err),
				}),
			);
		} catch (err) {
			// Sync throw (broker client down): the toggle still gates every session
			// through the file — only the peer notice is lost.
			hookLog("focus-gate", "broadcast-failed", {
				mode,
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	}

	const registration: FocusRegistration = {
		namespace: NAMESPACE,
		ownerEligible: false,
		onEvent(event) {
			if (event.type !== "message" || typeof event.fromSessionId !== "string") return;
			// Never echo our own toggle back into our own stream.
			if (mySessionId !== null && event.fromSessionId === mySessionId) return;
			const payload = event.payload as Partial<FocusNotice> | null;
			if (!payload || payload.type !== "focus") return;
			const { mode } = payload;
			if (mode !== "on" && mode !== "off") return;
			const sender = payload.senderName?.trim() || event.fromSessionId.slice(0, 8);
			// The same announce path as the watcher's, deduped on `<mode>|<since>`:
			// when both roads carry one flip, the session is alerted once.
			announceMode(mode, payload.since, `toggled in another session by ${sender}`);
		},
		onReady(readyChannel) {
			channel = readyChannel;
		},
	};

	function register(): void {
		pi.events.emit("intercom:extension-register", registration);
	}

	// The registrar may load after this extension, which would drop the first
	// registration. Re-emit once its registry reports ready; the first successful
	// registration wins (a duplicate namespace is rejected, not thrown).
	pi.events.on("intercom:extension-registry-ready", () => {
		if (!channel) register();
	});
	register();

	// Footer on session start: a mid-session pi launch shows the current mode,
	// and the state-file watch starts here (every session process, by design).
	pi.on("session_start", async (_event, ctx) => {
		try {
			mySessionId = ctx.sessionManager?.getSessionId() ?? mySessionId;
			lastUi = ctx.ui;
			seenMode = readFocusState().mode;
			syncFooter(ctx.ui, seenMode);
			startStateWatch();
		} catch {
			/* fail-open */
		}
	});

	// Footer cleanup on shutdown; the watcher dies with the session.
	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			stopWatch?.();
			stopWatch = null;
			ctx.ui.setStatus("focus", undefined);
		} catch {
			/* fail-open */
		}
	});

	// The gate: stateless fresh read on EVERY tool call. Off = no-op.
	pi.on("tool_call", async (event) => {
		try {
			const state = readFocusState();
			if (state.mode === "off") return; // no-op
			const hit = matchDeny(event.toolName, event.input);
			if (!hit) return; // read-only work unaffected
			const ledger = sessionLedger();
			appendLedger(
				ledger,
				state.mode,
				event.toolName,
				hit.pattern,
				inputDigest(event.toolName, event.input),
			);
			hookLog("focus-gate", "block", { tool: event.toolName, pattern: hit.pattern });
			return { block: true, reason: blockReason(state, ledger, hit.pattern) };
		} catch {
			return; // fail-open: a gate bug must not crash the session
		}
	});

	// Pre-compliance: the notice rides the MESSAGE TAIL, never the system prompt.
	// Editing the system prompt rewrites the cached prefix from its first token
	// on every turn (the exact frozen-prompt guarantee the session depends on);
	// a tail line lands in the uncached suffix, the same cache-safe shape
	// drift-anchor uses. The six-message guard keeps one notice in flight rather
	// than one per tool step.
	pi.on("context", (event, ctx) => {
		try {
			const state = readFocusState();
			lastUi = ctx.ui;
			// Footer re-sync: the mode is machine-global, but setStatus runs only in
			// the session that toggled it, so every other live session would show a
			// stale indicator until it restarted. This is the FALLBACK — the
			// state-file watch re-syncs the moment the mode moves, without waiting
			// for a turn. One UI write per request, no prompt bytes.
			syncFooter(ctx.ui, state.mode);
			if (state.mode === "off") return; // no injection noise by default
			// Parent sessions only. A child is hard-gated by this extension too, and
			// its blocked call already returns the refusal telling it not to retry, so
			// the per-turn tail would cost context in every child of every lane for a
			// rule the gate already carries.
			if (isChildProcess()) return;
			const messages = event.messages;
			if (!Array.isArray(messages) || messages.length === 0) return;
			// Mode-aware guard: only a statement of the CURRENT mode suppresses the
			// notice. A bare "[focus]" test let a stale OFF statement (an earlier
			// notice or injection) silence the ON notice — exactly the off→on flip
			// that matters.
			const alreadyStated = messages.slice(-6).some((m) => {
				const text = messageText(m);
				return ON_STATED.some((marker) => text.includes(marker));
			});
			if (alreadyStated) return;
			messages.push({
				role: "user",
				content: [{ type: "text", text: `[focus] ${injectionText(state)}` }],
				timestamp: Date.now(),
			});
			return { messages };
		} catch {
			return; // fail-open
		}
	});

	// /focus — no args toggles; on|off|status (quiet/locked are legacy aliases).
	pi.registerCommand("focus", {
		description:
			"Focus mode: on gates desktop intrusion (screenshots, workspace/window/input actions); notifications stay available. Usage: /focus [on|off|status]; no args toggles.",
		getArgumentCompletions: (prefix) => {
			const opts = ["on", "off", "status"];
			const filtered = opts.filter((o) => o.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
		},
		handler: async (args, ctx) => {
			try {
				const arg = (args ?? "").trim().toLowerCase();
				const current = readFocusState().mode;

				let next: FocusMode;
				if (arg === "" || arg === "cycle") {
					next = MODES[(MODES.indexOf(current) + 1) % MODES.length];
				} else if (arg === "on" || arg === "quiet" || arg === "locked") {
					next = "on"; // quiet/locked are legacy names for the gated state
				} else if (arg === "off" || arg === "full") {
					next = "off";
				} else if (arg === "status") {
					const state = readFocusState();
					const ledger = sessionLedger();
					let count = 0;
					try {
						if (existsSync(ledger)) {
							count = readFileSync(ledger, "utf8")
								.split("\n")
								.filter((l) => l.trim().length > 0).length;
						}
					} catch {
						/* count best-effort */
					}
					ctx.ui.notify(
						`focus: ${state.mode}${state.since ? ` (since ${state.since})` : ""} — ${count} queued action(s) this session in ${ledger}`,
						"info",
					);
					return;
				} else {
					ctx.ui.notify(
						`focus: unknown argument "${arg}" — use on|off|status (no args = toggle)`,
						"warning",
					);
					return;
				}

				const written = writeState(next);

				// Claim the flip this session just wrote, so its own state-file watch sees
				// no change and stays quiet (this session syncs its own footer and sends its
				// own notice below). Re-read rather than assume: a failed write leaves the
				// file on the old mode, and the claim has to match reality.
				seenMode = readFocusState().mode;

				// Footer: the ON glyph, or a clear when the mode is off.
				syncFooter(ctx.ui, next);

				// Every other live session is told over the `ipc` bus. The file is what
				// actually gates them; this is what makes the toggle visible there.
				broadcastToggle(next, written.since);

				// Toggle-time notice, BOTH directions: the session that ran the command
				// is an open session too, and the flip alerts it the same way. This
				// session has already claimed the flip (`seenMode`), so its own watch
				// stays quiet and the key here is what keeps the toggle to one notice.
				announceMode(next, written.since, "toggled in this session");

				// User confirmation (+ release summary when leaving focus). The summary is
				// the ONLY place the blocked attempts are surfaced, it reports THIS
				// session's own attempts, and it is read out before anything is cleared.
				if (next === "off") {
					const own = sessionLedger();
					ctx.ui.notify(ledgerSummary(own), "info");
					// All-at-once release: EVERY session's ledger goes, so no session is
					// left rendering a stale count and a session that already exited
					// leaves nothing behind.
					const cleared = clearFocusLedgers();
					hookLog("focus-gate", "ledgers-cleared", { files: cleared, own });
				} else {
					ctx.ui.notify(
						`focus: ON — desktop intrusion is now gated (ledger: ${sessionLedger()})`,
						"info",
					);
				}

				// Last, so a consumer that re-renders on this event sees the FINAL state
				// (the emptied ledger included). This session's own watch stays quiet —
				// it already claimed the flip — so the toggle is where the event comes
				// from locally; peers get it from their own watch.
				pi.events.emit(FOCUS_STATE_CHANGED, { mode: next, previous: current, origin: "toggle" });
			} catch (e) {
				ctx.ui.notify(
					`focus: command failed: ${e instanceof Error ? e.message : String(e)}`,
					"error",
				);
			}
		},
	});
}
