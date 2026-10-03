/**
 * wire.ts — the two questions asked of a provider payload's messages.
 *
 * A tool result must answer a call that a preceding assistant declared, and providers
 * spell both ends differently: a snake_case `tool_call_id` or a `toolResult` /
 * `tool_result` content part on the result, and `tool_calls`, `toolCalls` or a
 * `toolCall` / `tool_use` / `function` content part on the assistant. Two packages asked
 * these questions with their own copies, and the copies disagreed about which shapes they
 * read — the silent difference this module removes, because a result one copy recognised
 * and the other did not is a result that was dropped, kept or repaired depending on which
 * extension happened to load.
 */

/** A message as it reaches the provider seam: the fields both ends may use. */
export interface WireMessage {
	role?: unknown;
	tool_call_id?: unknown;
	tool_calls?: unknown;
	toolCalls?: unknown;
	content?: unknown;
}

/** The tool-call ids an assistant message declares, across the shapes providers use.
 *  An empty string is not an id, so it is not declared. */
export function declaredIds(message: WireMessage): string[] {
	const ids: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value === "string" && value !== "") ids.push(value);
	};
	if (Array.isArray(message.tool_calls)) {
		for (const call of message.tool_calls) push((call as { id?: unknown })?.id);
	}
	if (Array.isArray(message.toolCalls)) {
		for (const call of message.toolCalls) push((call as { id?: unknown })?.id);
	}
	if (Array.isArray(message.content)) {
		for (const part of message.content as Array<{
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

/** The tool-call id a result message answers, or null when it carries none. */
export function answeredId(message: WireMessage): string | null {
	if (typeof message.tool_call_id === "string") return message.tool_call_id;
	if (Array.isArray(message.content)) {
		for (const part of message.content as Array<{
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
