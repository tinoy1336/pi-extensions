/**
 * system-prompt — the shared seam for appending a block to the system prompt of
 * every provider request.
 *
 * An extension that appends to the system prompt faces two pi behaviours this
 * module exists to absorb:
 *
 *   - `before_agent_start` fires ONLY from the interactive `prompt()` path. A run
 *     started by an injected message (`pi.sendMessage(msg, {triggerTurn:true})`
 *     while idle) calls `agent.prompt()` directly, so an append made there never
 *     lands on that request.
 *   - The provider prefix is `[system, tools, messages]`, so a system prompt that
 *     differs between two requests of one session re-bills every byte after it as
 *     a cache miss.
 *
 * The pair below is the fix for both: `before_agent_start` builds the text, and
 * `before_provider_request` re-normalizes the payload through
 * `canonicalSystemPrompt` so every request leaves with identical bytes whatever
 * path produced it.
 *
 * Nothing here is policy: the block's content, its scope rules and what happens
 * when the payload cannot be rewritten belong to the extension that calls this.
 */

/** Separator between the base system prompt and the appended block. */
export const PROMPT_APPEND_SEP = "\n\n";

/** The line that opens the appended block; also the strip marker. Derived from
 *  the block, never a second literal, so the strip/append rule cannot drift from
 *  the renderer that produced the block. */
function blockMarker(block: string): string {
	const nl = block.indexOf("\n");
	return `${PROMPT_APPEND_SEP}${nl === -1 ? block : block.slice(0, nl)}`;
}

/** The ONE canonical form of the system prompt: base + separator + block, the
 *  block appended exactly once at the end. Whatever arrives is mapped to it, so
 *  the bytes cannot depend on which run-start path built the request:
 *    - base only (a run that never fired before_agent_start) -> base + block;
 *    - base + block (the normal path) -> unchanged;
 *    - a fork that inherited a block rendered for another scope, or a request
 *      that was appended twice -> stripped back to base, then the ONE current
 *      block is appended.
 *  Stripping takes the FIRST marker: a duplicated block is delimited there. */
export function canonicalSystemPrompt(
	systemPrompt: string,
	block: string,
): { text: string; hadBlock: boolean } {
	const marker = blockMarker(block);
	const at = systemPrompt.indexOf(marker);
	const base = at === -1 ? systemPrompt : systemPrompt.slice(0, at);
	return { text: `${base}${PROMPT_APPEND_SEP}${block}`, hadBlock: at !== -1 };
}

/** The system-prompt slot of a provider payload, or null when the payload shape
 * carries none we can rewrite. Provider shapes covered: openai-completions /
 * openai-responses / codex (first message, role "system" or "developer"), a
 * top-level `system` string, OpenAI Responses `instructions`, and the
 * anthropic-messages `system` block list when it holds a single text block. */
export function systemPromptSlot(
	payload: unknown,
): { get: () => string; set: (text: string) => void } | null {
	if (!payload || typeof payload !== "object") return null;
	const p = payload as Record<string, unknown>;
	if (Array.isArray(p.messages) && p.messages.length > 0) {
		const first = p.messages[0] as { role?: unknown; content?: unknown };
		if (
			first &&
			typeof first === "object" &&
			(first.role === "system" || first.role === "developer") &&
			typeof first.content === "string"
		) {
			return {
				get: () => first.content as string,
				set: (text) => {
					first.content = text;
				},
			};
		}
	}
	if (typeof p.system === "string") {
		return {
			get: () => p.system as string,
			set: (text) => {
				p.system = text;
			},
		};
	}
	if (Array.isArray(p.system)) {
		const textBlocks = (p.system as Array<{ text?: unknown }>).filter(
			(b) => b && typeof b === "object" && typeof b.text === "string",
		);
		if (textBlocks.length === 1) {
			const block = textBlocks[0] as { text: string };
			return {
				get: () => block.text,
				set: (text) => {
					block.text = text;
				},
			};
		}
	}
	if (typeof p.instructions === "string") {
		return {
			get: () => p.instructions as string,
			set: (text) => {
				p.instructions = text;
			},
		};
	}
	return null;
}
