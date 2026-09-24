/**
 * cache-prefix-log — permanent prompt-cache prefix logger.
 *
 * Records one compact JSONL row per SESSION BASELINE and per PREFIX CHANGE
 * (systemHash / toolsHash delta) on the `before_provider_request` hook, so the
 * next real cache miss can be NAMED (which fixed-prefix part moved, how many
 * chars it moved, which run-start path built the request, and which tool names
 * entered or left the provider `tools` array) without a payload dump.
 *
 * The fingerprint describes the bytes that are SENT. It is computed one
 * macrotask after the hook, because before_provider_request handlers run in the
 * (unsorted) extension-directory order and another handler may canonicalize the
 * system prompt in place — reading the payload inside this handler could record
 * bytes that never left the process. A row therefore always matches the request
 * it names.
 *
 * `origin` is the run-start path attribution: `prompt` = the interactive
 * prompt() path, which is the only path that fires before_agent_start;
 * `injected` = a run started any other way (pi.sendMessage with triggerTurn
 * while idle — async subagent completion, intercom delivery, a delivered
 * answer). A row with `origin:"injected"` and a non-zero `sysDeltaChars` is
 * the signature of a system prompt that only some run-start paths carry.
 *
 * Contract: observation-only. It registers NO tool and NEVER calls
 * setActiveTools — a logger that moved the tool set would cause the very misses
 * it exists to explain. It stores hashes and sizes, never message or schema
 * content. All work is wrapped so a fault can never break a provider request,
 * and the append is asynchronous (no blocking I/O on the request path).
 *
 * Scope — PREFIX questions only, NEVER token questions. A row is written on
 * `before_provider_request`, where only the outgoing payload exists
 * (`after_provider_response` carries status and headers, no usage either), so no
 * request's token or cache accounting is reachable at this seam: do not widen a
 * row with a number it cannot observe. Those figures live at `message_end`
 * (`message.usage` — the seam a cost footer reads `input`/`cacheRead` from),
 * which is the only place a usage row could be written.
 *
 * `sess` is the FULL session id, never a prefix of it: a session id starts with
 * the high 32 bits of its millisecond timestamp, so a truncated key is shared by
 * every session started inside the same ~65 s window and a row could not be
 * attributed to exactly one session.
 *
 * Log: $XDG_STATE_HOME/pi/cache-prefix-log.jsonl (default
 *      ~/.local/state/pi/cache-prefix-log.jsonl), capped at 256 KiB with one
 *      rotated sibling (cache-prefix-log.1.jsonl). Override with
 *      PI_CACHE_PREFIX_LOG (test/debug only).
 */

import { createHash } from "node:crypto";
import { appendFile, mkdirSync, rename, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CAP_BYTES = 256 * 1024;

function logPath(): string {
	if (process.env.PI_CACHE_PREFIX_LOG) return process.env.PI_CACHE_PREFIX_LOG;
	const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return join(state, "pi", "cache-prefix-log.jsonl");
}

function sha(s: string): string {
	return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "",
		)
		.join("\n");
}

function toolName(t: unknown): string {
	const o = t as { function?: { name?: string }; name?: string };
	return o?.function?.name ?? o?.name ?? "?";
}

interface Prefix {
	/** The full session id the request was sent under (see the scope note above). */
	session: string;
	sysHash: string;
	sysChars: number;
	toolsHash: string;
	toolsChars: number;
	nTools: number;
	names: string[];
}

export default function (pi: ExtensionAPI) {
	const PATH = logPath();
	const ROTATED = `${PATH}.1`;

	/**
	 * The tail sections canon reports as registered, kept from its own
	 * announcements. Presence is NOT inferable from the bytes: a section that never
	 * renders leaves the prefix exactly as stable as a correct one, so a live check
	 * that only asserts `sysDeltaChars: 0` cannot tell "frozen and injected" from
	 * "frozen and absent". Recording the set makes every row answer it.
	 */
	let sectionIds: string[] = [];
	pi.events.on("canon:sections", (payload: unknown) => {
		try {
			// canon announces the EFFECTIVE set, so a section it refused is not recorded
			// here as present. Tracking the request instead would make this field report
			// a section that never reached the prompt.
			const ids = (payload as { ids?: unknown } | null)?.ids;
			if (!Array.isArray(ids)) return;
			sectionIds = ids.filter((i): i is string => typeof i === "string").sort();
		} catch {
			/* observation must never break anything */
		}
	});

	// The state dir may not exist yet (fresh machine). Create it once at load —
	// never on the request path — so the first append is not a silent ENOENT.
	try {
		mkdirSync(dirname(PATH), { recursive: true });
	} catch {
		/* best effort: appendFile below is guarded regardless */
	}

	let req = 0; // monotonic request index within this process
	let bytes = 0; // tracked size of PATH (seeded once at load)
	let rotating = false;

	try {
		bytes = statSync(PATH).size;
	} catch {
		bytes = 0; // file absent — starts at 0
	}

	// Previous emitted prefix. Kept as the last state we WROTE, so a change in any
	// request (whether or not the intervening requests were hits) is detected.
	let last: Prefix | null = null;
	let lastTs = 0;
	// System-prompt size of the immediately previous request (any status), so a
	// row can state how far the prefix moved, not only that it moved.
	let prevSysChars: number | null = null;

	// ── run-start attribution ──
	// agent_start opens a run. before_agent_start fires only for runs started by
	// the interactive prompt path; for every other run-start path (an injected
	// triggerTurn message, i.e. _runAgentPrompt -> agent.prompt()) the run opens
	// with no before_agent_start at all. That asymmetry is exactly what makes a
	// system prompt differ between requests of one session.
	let run = 0;
	let promptHookFired = false;
	let runOrigin: "prompt" | "injected" | null = null;
	pi.on("before_agent_start", () => {
		promptHookFired = true;
	});
	pi.on("agent_start", () => {
		run += 1;
		runOrigin = promptHookFired ? "prompt" : "injected";
		promptHookFired = false;
	});

	function schedule(line: string): void {
		const len = Buffer.byteLength(line);
		// Hard cap: once at/over CAP, rotate (async, single-flight) and DROP rows
		// until the rename completes, so PATH can never exceed CAP_BYTES even under
		// a burst. bytes is pinned at CAP while rotating so the drop holds until the
		// callback resets it.
		if (bytes + len > CAP_BYTES) {
			if (!rotating) {
				rotating = true;
				bytes = CAP_BYTES;
				rename(PATH, ROTATED, () => {
					rotating = false;
					bytes = 0; // next row recreates PATH
				});
			}
			return;
		}
		bytes += len;
		appendFile(PATH, line, () => {
			/* best effort: a logger fault must never surface */
		});
	}

	function readPrefix(payload: Record<string, unknown>, sessionId: string | null): Prefix {
		const messages = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : [];
		const parts: string[] = [];
		if (typeof payload.system === "string") parts.push(payload.system);
		else if (payload.system != null) parts.push(JSON.stringify(payload.system));
		for (const m of messages) {
			const mm = m as { role?: string; content?: unknown };
			// "developer" is the openai-completions role a reasoning model gets for
			// the system prompt; without it a provider using it would look prefix-less.
			if (mm?.role === "system" || mm?.role === "developer") parts.push(textOf(mm.content));
		}
		const system = parts.join("\n\u0000\n");

		const tools = Array.isArray(payload.tools) ? (payload.tools as unknown[]) : [];
		const names = tools.map(toolName);
		const toolsJson = JSON.stringify(tools);

		return {
			session: sessionId ?? "",
			sysHash: sha(system),
			sysChars: system.length,
			toolsHash: sha(toolsJson),
			toolsChars: toolsJson.length,
			nTools: tools.length,
			names,
		};
	}

	/** One captured request, fingerprinted a macrotask later (see the header). */
	interface Captured {
		payload: Record<string, unknown>;
		req: number;
		at: number;
		sessionId: string | null;
	}
	const captured: Captured[] = [];
	let flushQueued = false;

	function writeRow(item: Captured): void {
		try {
			const p = readPrefix(item.payload, item.sessionId);
			const origin = runOrigin ?? (promptHookFired ? "prompt" : "injected");
			const sysDeltaChars = prevSysChars === null ? undefined : p.sysChars - prevSysChars;
			prevSysChars = p.sysChars;
			// The full id: a truncated one attributes a row to several sessions at once.
			const sess = p.session;

			const first = last === null || last.session !== p.session;
			const sysChanged = last !== null && last.sysHash !== p.sysHash;
			const toolsChanged = last !== null && last.toolsHash !== p.toolsHash;
			if (!first && !sysChanged && !toolsChanged) return; // common case: no row

			const messages = Array.isArray(item.payload.messages)
				? (item.payload.messages as unknown[])
				: [];
			const msgChars = JSON.stringify(
				messages.filter((m) => (m as { role?: string })?.role !== "system"),
			).length;

			const changed: string[] = [];
			if (first) changed.push("baseline");
			else {
				if (sysChanged) changed.push("sys");
				if (toolsChanged) changed.push("tools");
			}

			const prevNames = new Set(last?.names ?? []);
			const nowNames = new Set(p.names);
			const added = first ? undefined : p.names.filter((n) => !prevNames.has(n));
			const removed = first ? undefined : (last?.names ?? []).filter((n) => !nowNames.has(n));

			const row: Record<string, unknown> = {
				ts: new Date(item.at).toISOString(),
				req: item.req,
				sess,
				pid: process.pid,
				run,
				origin,
				why: first ? "baseline" : "prefix",
				sys: p.sysHash,
				tools: p.toolsHash,
				sysChars: p.sysChars,
				toolsChars: p.toolsChars,
				nTools: p.nTools,
				prefixChars: p.sysChars + p.toolsChars,
				msgChars,
				sections: sectionIds.join(","),
				changed,
			};
			if (sysDeltaChars !== undefined) row.sysDeltaChars = sysDeltaChars;
			if (first) row.toolNames = p.names;
			else {
				row.added = added;
				row.removed = removed;
				if (lastTs) row.msSincePrev = item.at - lastTs;
			}

			last = p;
			lastTs = item.at;
			schedule(`${JSON.stringify(row)}\n`);
		} catch {
			/* observation must never break the request */
		}
	}

	function flushCaptured(): void {
		flushQueued = false;
		const batch = captured.splice(0, captured.length);
		for (const item of batch) writeRow(item);
	}

	pi.on("before_provider_request", (event, ctx) => {
		try {
			let sessionId: string | null = null;
			try {
				sessionId = ctx?.sessionManager?.getSessionId?.() ?? null;
			} catch {
				sessionId = null;
			}
			captured.push({
				payload: (event?.payload ?? {}) as Record<string, unknown>,
				req: ++req,
				at: Date.now(),
				sessionId,
			});
			if (!flushQueued) {
				flushQueued = true;
				setTimeout(flushCaptured, 0);
			}
		} catch {
			/* observation must never break the request */
		}
		return undefined;
	});
}
