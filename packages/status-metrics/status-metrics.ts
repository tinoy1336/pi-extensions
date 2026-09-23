/**
 * status-metrics: session counters in the pi footer.
 *
 * Rendered in pi's own footer idiom — symbol + value, space separated, no
 * labels (`↑128k ↓135k R20M $0.159`). Legend:
 *   \uf05e N  fa-ban      tool calls blocked (command-guard + focus-gate)
 *   \uf13d N  fa-anchor   drift-anchor injections this session
 *   \uf1b8 NK fa-recycle  bytes kept out of context by repeat-read elision
 *   \uf04c N  fa-pause    desktop actions focus mode has queued in THIS session
 *
 * Source: the shared hook log (`@tinoy/pi-ext-lib`'s hook-log), tailed
 * incrementally and filtered to THIS process (`proc` field) with no session-id
 * fallback — a pi launched from inside another pi inherits PI_SESSION_ID, so an
 * sid match would count the parent's events. Subagents and other pi windows
 * append to the same file, so an unfiltered count would be meaningless too.
 * Counters reset per session and render only when non-zero.
 *
 * The counted rows are selected by the SOURCE NAME each contributing extension
 * writes (`command-guard`, `focus-gate`, `drift-anchor`, `read-staleness`) and
 * the kinds it writes them with. Those are log identities, not package
 * identities: an extension that is not installed writes no rows, its counter
 * stays at zero, and nothing here reaches for a package that may not exist.
 *
 * The log path and the ledger path are both resolved at USE time, never at
 * load: a footed process may have neither file, and a counter that cannot read
 * its source is a counter at zero.
 *
 * Cosmetic by contract: every path is wrapped, and a footer failure must never
 * touch the session.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hookLog } from "@tinoy/pi-ext-lib";
import { focusLedgerPathFor } from "@tinoy/pi-focus-state";

const SELF_PID = process.pid; // identity of this pi process (see hook-log)

const counts = { blocks: 0, nudges: 0, savedBytes: 0 };
let offset = 0;
let queued = 0;

/** The shared diagnostics log every contributing extension appends to. */
function hookLogPath(): string {
	return join(homedir(), ".local/share/pi-hooks", "log.jsonl");
}

// Nerd Font (JetBrainsMono NF in kitty) — one glyph per counter, pi-footer style.
const GLYPH = {
	blocks: "\uf05e", // fa-ban
	nudges: "\uf13d", // fa-anchor
	saved: "\uf1b8", // fa-recycle
	queued: "\uf04c", // fa-pause
};

/** 49664 → "48k"; 1.4M+ → "1.4M" — matches pi's own `128k` / `1.0M` idiom. */
function shortBytes(b: number): string {
	return b >= 1048576 ? `${(b / 1048576).toFixed(1)}M` : `${Math.round(b / 1024)}k`;
}

/** Read only the bytes appended since the last call. */
function drain(): void {
	try {
		const logPath = hookLogPath();
		const size = statSync(logPath).size;
		if (size < offset) offset = 0; // rotated or truncated
		if (size === offset) return;
		const fd = openSync(logPath, "r");
		const buf = Buffer.alloc(size - offset);
		try {
			readSync(fd, buf, 0, buf.length, offset);
		} finally {
			closeSync(fd);
		}
		offset = size;
		for (const line of buf.toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			let j: {
				proc?: number;
				sid?: string;
				source?: string;
				kind?: string;
				detail?: { bytes?: number };
			};
			try {
				j = JSON.parse(line);
			} catch {
				continue; // a torn final line is retried on the next drain
			}
			// Count ONLY entries this process wrote. There is no sid fallback: a pi
			// launched from inside another pi inherits PI_SESSION_ID, so matching on
			// it would count the parent's entries too. Legacy pre-`proc` entries are
			// unattributable and therefore never counted.
			if (j.proc !== SELF_PID) continue;
			// `kind` matters as much as the source: these extensions log diagnostics
			// (broadcast-failed, notice-failed, state-change) under the same source as
			// their blocks, and counting those would tick the fa-ban counter on events
			// that blocked nothing — a focus toggle would read as a blocked call.
			if (
				(j.source === "command-guard" || j.source === "bash-guard" || j.source === "focus-gate") &&
				j.kind === "block"
			)
				counts.blocks++;
			else if (j.source === "drift-anchor" && j.kind !== "set-anchor") counts.nudges++;
			else if (j.source === "read-staleness") counts.savedBytes += j.detail?.bytes ?? 0;
		}
	} catch {
		/* log missing or unreadable — counters simply stay put */
	}
}

/**
 * THIS session's queued actions, from its own focus ledger. Ledgers are per
 * session (the naming lives in the focus-state package), so the footer counts
 * only the blocked attempts this session queued — never a peer's — and a release
 * clear made by any session empties this one too.
 */
function ledgerCount(owner: string | null): number {
	try {
		const fd = openSync(focusLedgerPathFor(owner), "r");
		const buf = Buffer.alloc(65536);
		const read = readSync(fd, buf, 0, buf.length, 0);
		closeSync(fd);
		return buf
			.toString("utf8", 0, read)
			.split("\n")
			.filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}

/** The slice of the extension context this renderer needs (interactive, RPC and print alike). */
interface RenderCtx {
	ui?: {
		setStatus?: (k: string, v: string | undefined) => void;
		theme?: { fg?: (c: string, s: string) => string };
	};
	sessionManager?: { getSessionId?: () => string };
}

/** Kept so a non-turn trigger (a focus-mode change) can re-render the footer. */
let lastCtx: RenderCtx | undefined;

/** This process's session id — the owner key of its own focus ledger. */
let sid: string | null = null;

function render(ctx: RenderCtx): void {
	try {
		lastCtx = ctx;
		sid = ctx.sessionManager?.getSessionId?.() ?? sid;
		drain();
		queued = ledgerCount(sid);
		const parts: string[] = [];
		if (counts.blocks > 0) parts.push(`${GLYPH.blocks}${counts.blocks}`);
		if (counts.nudges > 0) parts.push(`${GLYPH.nudges}${counts.nudges}`);
		if (counts.savedBytes > 0) parts.push(`${GLYPH.saved}${shortBytes(counts.savedBytes)}`);
		if (queued > 0) parts.push(`${GLYPH.queued}${queued}`);
		const text = parts.join(" ");
		const themed = text && ctx.ui?.theme?.fg ? ctx.ui.theme.fg("muted", text) : text;
		ctx.ui?.setStatus?.("metrics", themed || undefined);
	} catch {
		/* footer is cosmetic */
	}
}

function register(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		offset = 0;
		counts.blocks = 0;
		counts.nudges = 0;
		counts.savedBytes = 0;
		render(ctx as never);
	});

	pi.on("tool_result", (_event, ctx) => render(ctx as never));
	pi.on("message_end", (_event, ctx) => render(ctx as never));

	// A focus-mode change (the state file moved, or /focus off emptied the ledger)
	// re-renders at once: the queued counter reads the ledger, so without this it
	// would keep showing the pre-reset count until the next tool result or message
	// end. Emitted per process by focus-gate, the owner of the state file.
	pi.events.on("focus:state-changed", () => {
		if (lastCtx) render(lastCtx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			ctx.ui.setStatus("metrics", undefined);
		} catch {
			/* nothing to clean if the footer never rendered */
		}
	});
}

export default function (pi: ExtensionAPI): void {
	try {
		register(pi);
	} catch (error) {
		hookLog("status-metrics", "register-failed", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}
