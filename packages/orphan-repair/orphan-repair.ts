/**
 * orphan-repair — drop an orphaned tool result from the outbound request.
 *
 * The defect it repairs, established by replaying dead run histories through pi's own
 * converter: the stored history is
 * CLEAN (0 orphans in 23/23), yet the provider rejects some requests with
 * `400: Messages with role 'tool' must be a response to a preceding message with
 * 'tool_calls'`. So the orphan is introduced while the request is assembled, in an
 * upstream path that can append a tool result unconditionally while its assistant
 * message loses the matching call. Nothing on this machine stores the outbound body,
 * so the repair has to happen at the last point where we can see — and change — it.
 *
 * Repair, not a rewrite: an orphaned result is DROPPED and one line is logged. A
 * dangling result that duplicates an answer already sitting inside the run REPLACES
 * that answer in place, so the repair never trades a real tool result for the
 * placeholder pi synthesised for it. Dropping costs one stale result from the replay;
 * the alternative costs the entire run,
 * in that flight. A dropped orphan cannot break the pairing contract, because a message
 * that is not sent cannot be orphaned.
 *
 * The upstream path is REPRODUCED now, not merely suspected. pi-ai's
 * `transformMessages` (dist/api/transform-messages.js:152-166) drops any assistant
 * message whose `stopReason` is `"error"` or `"aborted"` — taking its tool calls with
 * it — while the `toolResult` branch appends results unconditionally. Fed the same
 * history with each stop reason it emits `[user, assistant, toolResult, user]` for a
 * normal stop and `[user, toolResult, user]` for the other two: a result with no call,
 * which is exactly the provider's complaint. Any run where an errored or aborted
 * assistant turn contained tool calls corrupts the request that follows it. Two
 * further latent sites are named in the investigation report; none can get past this
 * guard, which is why the repair is worth having even with the cause known.
 *
 * Two shapes reach the provider, and both are repaired here. (a) A result whose
 * id no assistant declares — the `transformMessages` asymmetry below. (b) A
 * result that IS declared but no longer sits in the run answering that
 * assistant, because something was appended or spliced between the calls and
 * their results: `[assistant(A,B), tool(A), tool(B), user, tool(B)]`. Shape (b)
 * is why the predicate tests RUN ADJACENCY (the message before a result is its
 * declaring assistant or another result of that same run) rather than id
 * membership against the nearest preceding assistant — the latter passes the
 * dangling tail result of the sequence above, which is the exact request the
 * provider rejected with `role 'tool' must be a response to a preceding message
 * with 'tool_calls'`.
 *
 * Every fault here is swallowed: a repair must never be the reason a request fails.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hookLog } from "@tinoy/pi-ext-lib";

interface WireMessage {
	role?: unknown;
	/** The wire field is snake_case at the provider seam; the camelCase alias is
	 *  accepted too, because reading only one of them made EVERY result look orphaned
	 *  and the guard would have stripped the whole history. */
	tool_call_id?: unknown;
	tool_calls?: unknown;
	toolCalls?: unknown;
	content?: unknown;
}

/** The tool-call ids an assistant message declares, across the shapes providers use. */
function callsOf(m: WireMessage): Set<string> {
	const ids = new Set<string>();
	const push = (v: unknown): void => {
		if (typeof v === "string") ids.add(v);
	};
	if (Array.isArray(m.tool_calls))
		for (const tc of m.tool_calls) push((tc as { id?: unknown })?.id);
	if (Array.isArray(m.toolCalls)) for (const tc of m.toolCalls) push((tc as { id?: unknown })?.id);
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

/** The tool-call id a result answers, across the shapes providers use. */
function resultIdOf(m: WireMessage): string | null {
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

export default function (pi: ExtensionAPI): void {
	pi.on("before_provider_request", (event) => {
		try {
			const payload = (event as { payload?: { messages?: unknown } })?.payload;
			if (!payload || !Array.isArray(payload.messages)) return undefined;
			const messages = payload.messages as WireMessage[];
			// The contract is RUN ADJACENCY, not id membership. A `role:"tool"`
			// message is legal only inside the run of results that answers the nearest
			// preceding assistant: the run opens at an assistant message and ends at
			// any other role. A result that follows a user (or system) message is an
			// orphan even when some earlier assistant declared its id — that is the
			// shape a message spliced between an assistant's tool calls and their
			// results leaves behind: [assistant(A,B), tool(A), tool(B), user,
			// tool(B)], where plain id membership passes the dangling tail result.
			let runIds = new Set<string>();
			// id → index in `kept` of the result that answers it. Deliberately NOT reset
			// when a run closes: the copy this has to repair is exactly the one left
			// behind on the far side of the message that closed the run. A dangling
			// duplicate REPLACES its earlier copy instead of being dropped beside it
			// (see the replacement note below).
			const keptAt = new Map<string, number>();
			const kept: WireMessage[] = [];
			let dropped = 0;
			let replaced = 0;
			for (const m of messages) {
				if (m?.role === "assistant") {
					runIds = callsOf(m);
					kept.push(m);
					continue;
				}
				if (m?.role === "tool") {
					const id = resultIdOf(m);
					// No readable id: not validatable either way, so the previous tolerance
					// stands inside an open run. This carve-out is a KNOWN FALSE NEGATIVE —
					// a tool message that carries no id is rejected by the provider however
					// the run state looks.
					if (id === null) {
						if (runIds.size === 0) {
							dropped++;
							hookLog("orphan-repair", "dropped", { toolCallId: null, index: messages.indexOf(m) });
							continue;
						}
						kept.push(m);
						continue;
					}
					// Adjacency is tested FIRST: a call the open run declares is answered by
					// this message, whatever earlier message carries the same id, so a second
					// run declaring an id must never overwrite the first run's answer — that
					// would leave its own declared call unanswered. A dangling duplicate is
					// never adjacent to an open run, so this order preserves the replacement
					// below exactly where it is needed.
					if (runIds.has(id)) {
						keptAt.set(id, kept.length);
						kept.push(m);
						continue;
					}
					const earlier = keptAt.get(id);
					if (earlier !== undefined) {
						// Not adjacent to any open run, but an earlier message already answers this
						// id. A legal body answers each declared call exactly once, so that earlier
						// copy is pi's placeholder for a result that had not landed when its run was
						// interrupted (`transformMessages` synthesises "No result provided" at that
						// point). THIS copy is the real output: replacing in place keeps the run
						// contiguous AND keeps the result the model needs, where dropping this copy
						// would leave the placeholder as the only answer.
						kept[earlier] = m;
						replaced++;
						hookLog("orphan-repair", "replaced", { toolCallId: id, index: messages.indexOf(m) });
						continue;
					}
					dropped++;
					hookLog("orphan-repair", "dropped", { toolCallId: id, index: messages.indexOf(m) });
					continue;
				}
				// Any other role closes the tool run: the next result cannot belong to it.
				runIds = new Set<string>();
				kept.push(m);
			}
			if (dropped > 0 || replaced > 0) payload.messages = kept;
		} catch {
			/* a repair fault must never be the reason a request fails */
		}
		return undefined;
	});
}
