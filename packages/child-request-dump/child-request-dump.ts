/**
 * child-request-dump — structure-only record of every outbound provider request
 * in a CHILD session.
 *
 * A provider that validates tool-call pairing rejects a request when a message
 * with role "tool" answers a call that no preceding assistant message declares.
 * That condition is a property of the message sequence alone, so it is recordable
 * without any message content: the roles in order, the tool-call ids each
 * assistant message declares, and the id each result answers. One JSONL line per
 * request is written, so the last line of a run is the last request it built.
 *
 * Observation point. The row is built from the payload of this handler's turn.
 * Handlers run in extension order, and `orphan-repair.ts` rewrites
 * `payload.messages` later in that order, so a row here is the sequence pi's
 * converter produced, before any repair — which is the sequence that reaches the
 * provider when no repair is loaded.
 *
 * Content is NEVER recorded: no prompt text, no message text, no tool names, no
 * tool arguments. Roles, counts and opaque tool-call ids only.
 *
 * Scope. Nothing is registered unless the process is a child: `PI_SUBAGENT_CHILD=1`
 * for a session hosted by the async runner, `PI_SUBAGENT=1` for a launch through
 * the `pi-subagent` wrapper. Ambient loading into a parent session records
 * nothing. Children load this file through the settings route
 * `subagents.defaultExtensions`.
 *
 * Log: $XDG_STATE_HOME/pi/child-request-dump.jsonl (default
 *      ~/.local/state/pi/child-request-dump.jsonl), capped at 256 KiB with one
 *      rotated sibling (child-request-dump.1.jsonl). Override with
 *      PI_CHILD_REQUEST_DUMP.
 *
 * Every fault is swallowed: a recorder must never break a provider request, and
 * the append is asynchronous so no request waits on the file.
 */
import { appendFile, mkdirSync, rename, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CAP_BYTES = 256 * 1024;

function logPath(): string {
	if (process.env.PI_CHILD_REQUEST_DUMP) return process.env.PI_CHILD_REQUEST_DUMP;
	const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return join(state, "pi", "child-request-dump.jsonl");
}

/** The wire shapes differ by provider, so both spellings are read. */
interface WireMessage {
	role?: unknown;
	tool_call_id?: unknown;
	tool_calls?: unknown;
	toolCalls?: unknown;
	content?: unknown;
}

/** The tool-call ids an assistant message declares. */
function declaredIds(m: WireMessage): string[] {
	const ids: string[] = [];
	const push = (v: unknown): void => {
		if (typeof v === "string" && v !== "") ids.push(v);
	};
	if (Array.isArray(m.tool_calls)) {
		for (const tc of m.tool_calls) push((tc as { id?: unknown })?.id);
	}
	if (Array.isArray(m.toolCalls)) {
		for (const tc of m.toolCalls) push((tc as { id?: unknown })?.id);
	}
	if (Array.isArray(m.content)) {
		for (const part of m.content as Array<{
			type?: unknown;
			id?: unknown;
			toolCallId?: unknown;
			tool_use_id?: unknown;
		}>) {
			if (part?.type === "toolCall" || part?.type === "tool_use" || part?.type === "function") {
				push(part.id ?? part.toolCallId ?? part.tool_use_id);
			}
		}
	}
	return ids;
}

/** The tool-call id a result message answers, null when it carries none. */
function answeredId(m: WireMessage): string | null {
	if (typeof m.tool_call_id === "string") return m.tool_call_id;
	if (Array.isArray(m.content)) {
		for (const part of m.content as Array<{
			type?: unknown;
			toolCallId?: unknown;
			tool_use_id?: unknown;
		}>) {
			if (part?.type === "toolResult" || part?.type === "tool_result") {
				const id = part.toolCallId ?? part.tool_use_id;
				if (typeof id === "string") return id;
			}
		}
	}
	return null;
}

/** One row entry per message that carries a call or a result. */
interface Entry {
	i: number;
	r: string;
	/** assistant: how many calls it declares */
	tc?: number;
	/** assistant: the ids it declares */
	ids?: string[];
	/** assistant: indices of the results that answer it */
	paired?: number[];
	/** tool: the id it answers, null when it carries none */
	id?: string | null;
	/** tool: index of the assistant message it follows */
	after?: number;
	/** tool: whether the assistant message it follows declares the answered id */
	ok?: boolean;
	/** tool: whether any preceding assistant message declares the answered id */
	prev?: boolean;
}

interface Shape {
	roles: string[];
	entries: Entry[];
	orphans: Array<{ i: number; id: string | null }>;
	late: Array<{ i: number; id: string | null }>;
	calls: number;
	results: number;
}

/**
 * A result is paired when the assistant message it follows declares the id it
 * answers. The provider's rule is weaker — a result is valid when ANY preceding
 * assistant message declares the id — so two conditions are recorded apart:
 * `orphans` holds results no preceding assistant declares, which is the sequence
 * the provider rejects, and `late` holds results whose call belongs to an earlier
 * assistant than the one they follow, which is an order anomaly the provider
 * still accepts. `after` names the assistant a result follows, so a broken pair
 * also names the message that lost its calls.
 */
function scanShape(messages: unknown[]): Shape {
	const roles: string[] = [];
	const entries: Entry[] = [];
	const orphans: Array<{ i: number; id: string | null }> = [];
	const late: Array<{ i: number; id: string | null }> = [];
	const byAssistant = new Map<number, number[]>();
	const everDeclared = new Set<string>();
	let lastAssistant = -1;
	let lastIds = new Set<string>();
	let calls = 0;
	let results = 0;

	for (let i = 0; i < messages.length; i++) {
		const m = (messages[i] ?? {}) as WireMessage;
		const role = typeof m.role === "string" ? m.role : "?";
		roles.push(role);

		if (role === "assistant") {
			const ids = declaredIds(m);
			lastAssistant = i;
			lastIds = new Set(ids);
			calls += ids.length;
			for (const id of ids) everDeclared.add(id);
			if (ids.length > 0) {
				const paired: number[] = [];
				entries.push({ i, r: role, tc: ids.length, ids, paired });
				byAssistant.set(i, paired);
			}
			continue;
		}

		if (role === "tool") {
			results += 1;
			const id = answeredId(m);
			const declared = id !== null && everDeclared.has(id);
			const ok = declared && lastIds.has(id);
			entries.push({ i, r: role, id, after: lastAssistant, ok, prev: declared });
			if (!declared) orphans.push({ i, id });
			else if (!ok) late.push({ i, id });
			if (ok) byAssistant.get(lastAssistant)?.push(i);
		}
	}

	return { roles, entries, orphans, late, calls, results };
}

export default function (pi: ExtensionAPI): void {
	// Child sessions only: the async runner marks its hosted session with
	// PI_SUBAGENT_CHILD, the pi-subagent wrapper exports PI_SUBAGENT.
	if (process.env.PI_SUBAGENT_CHILD !== "1" && process.env.PI_SUBAGENT !== "1") return;

	const PATH = logPath();
	const ROTATED = `${PATH}.1`;

	try {
		mkdirSync(dirname(PATH), { recursive: true });
	} catch {
		/* best effort: the append below is guarded regardless */
	}

	let req = 0;
	let run = 0;
	let bytes = 0;
	let rotating = false;
	try {
		bytes = statSync(PATH).size;
	} catch {
		bytes = 0;
	}

	// Run-start identity, as recorded by cache-prefix-log: agent_start opens a run,
	// and before_agent_start fires only for a run started by the prompt path.
	let promptHookFired = false;
	let origin: "prompt" | "injected" | null = null;
	pi.on("before_agent_start", () => {
		promptHookFired = true;
	});
	pi.on("agent_start", () => {
		run += 1;
		origin = promptHookFired ? "prompt" : "injected";
		promptHookFired = false;
	});

	function schedule(line: string): void {
		const len = Buffer.byteLength(line);
		// Hard cap: at or over CAP the file is rotated once, and rows are dropped
		// until the rename lands, so PATH cannot exceed CAP_BYTES under a burst.
		if (bytes + len > CAP_BYTES) {
			if (!rotating) {
				rotating = true;
				bytes = CAP_BYTES;
				rename(PATH, ROTATED, () => {
					rotating = false;
					bytes = 0;
				});
			}
			return;
		}
		bytes += len;
		appendFile(PATH, line, () => {
			/* best effort: a recorder fault must never surface */
		});
	}

	pi.on("before_provider_request", (event, ctx) => {
		try {
			const payload = (event as { payload?: Record<string, unknown> })?.payload;
			const messages = Array.isArray(payload?.messages) ? (payload.messages as unknown[]) : null;
			if (!messages) return undefined;

			const shape = scanShape(messages);
			let sess = "";
			try {
				sess = String(ctx?.sessionManager?.getSessionId?.() ?? "").slice(0, 8);
			} catch {
				sess = "";
			}

			const row: Record<string, unknown> = {
				ts: new Date().toISOString(),
				pid: process.pid,
				sess,
				run,
				req: ++req,
				origin: origin ?? (promptHookFired ? "prompt" : "injected"),
				model: typeof payload?.model === "string" ? payload.model : null,
				n: messages.length,
				calls: shape.calls,
				results: shape.results,
				orphans: shape.orphans,
				late: shape.late,
				roles: shape.roles,
				msgs: shape.entries,
			};
			schedule(`${JSON.stringify(row)}\n`);
		} catch {
			/* a recorder fault must never be the reason a request fails */
		}
		return undefined;
	});
}
