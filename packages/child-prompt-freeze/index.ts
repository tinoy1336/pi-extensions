/**
 * child-prompt-freeze — prompt-cache invariance for CHILD sessions.
 *
 * Why. A child's system prompt is produced by the prompt() path (the launch or
 * resume prompt), where pi-subagents' child runtime rewrites it
 * (`rewriteSubagentPrompt`: boundary instructions, project/global/skills
 * stripping, structured-output instructions). pi emits `before_agent_start`
 * from the prompt() path ONLY — `emitBeforeAgentStart` has a single call site —
 * so a run started by an injected message (`pi.sendMessage(msg,
 * { triggerTurn: true })` while idle, i.e. an intercom / supervisor / steer
 * delivery) carries the UNREWRITTEN base prompt. The provider prefix is
 * [system, tools, messages], so the block that moves inside the system prompt
 * re-bills every token after it — the tools array plus the whole conversation.
 *
 * What. The bytes a child process sends are whatever its prompt path produced:
 * this extension pins that value per process and restores it on any request that
 * arrives without it. It does NOT reimplement pi-subagents' rewrite — that would
 * drift the day the package changes it. The canonical bytes are simply the ones
 * observed on a request whose run fired `before_agent_start` (our own hook, no
 * package knowledge), so an npm update of pi-subagents cannot make this repair
 * wrong: the child replays the package's own output.
 *
 * Guarantees:
 *   - the prompt path is never modified (adopt-only), so a typed/resumed run
 *     sends exactly the bytes it built;
 *   - idempotent by construction (restoring an already-canonical prompt is a
 *     no-op), and the payload is mutated in place, so the bytes sent cannot
 *     depend on the before_provider_request handler order;
 *   - one memoized string per process, nothing recomputed per request;
 *   - a wake-first process (no prompt-path run yet) pins nothing and says so.
 *
 * Scope. Registers nothing in a parent session, so ambient loading there is a
 * no-op (the parent's invariant is canon's own before_provider_request repair):
 * a child is recognised by either launch marker — PI_SUBAGENT=1 from the
 * pi-subagent wrapper, PI_SUBAGENT_CHILD=1 from the pi-subagents async runner.
 * Children load this file through the settings route
 * `subagents.defaultExtensions`.
 *
 * Observability. Every restore is one `hookLog("child-prompt", …)` line, and
 * the cache-prefix-log extension — also on the child extension list — records the same
 * request's fingerprint with `origin` and `sysDeltaChars`, so a woken child that
 * loses the rewrite is visible instead of silent.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hookLog, systemPromptSlot } from "@tinoy/pi-ext-lib";

export default function (pi: ExtensionAPI): void {
	// Child sessions only. Either launch marker means a child process: PI_SUBAGENT
	// from the pi-subagent wrapper, PI_SUBAGENT_CHILD from the pi-subagents async
	// runner. A parent session has neither.
	if (process.env.PI_SUBAGENT !== "1" && process.env.PI_SUBAGENT_CHILD !== "1") return;

	/** Did a prompt-path run start since the previous provider request? Only a
	 *  run that fired our before_agent_start carries the package's rewrite. */
	let promptHookFired = false;
	/** The bytes every request of this process must carry; null until a
	 *  prompt-path run has produced them. */
	let canonical: string | null = null;
	/** One line per restored run, not per request of it. */
	let restoreLogged = false;
	let unknownLogged = false;

	pi.on("before_agent_start", () => {
		promptHookFired = true;
	});

	pi.on("before_provider_request", (event) => {
		try {
			const slot = systemPromptSlot((event as { payload?: unknown })?.payload);
			if (!slot) return undefined;
			const fired = promptHookFired;
			promptHookFired = false;
			const text = slot.get();
			if (fired) {
				// Prompt-path run: these are the bytes the rewrite produced. Adopt
				// them; identical bytes are the common case. A change here means the
				// base prompt itself changed (tool set, resources reload) and is
				// legitimate — it just has to be recorded.
				if (canonical !== null && canonical !== text) {
					hookLog("child-prompt", "canonical-refresh", {
						fromChars: canonical.length,
						toChars: text.length,
					});
				}
				canonical = text;
				restoreLogged = false;
				return undefined;
			}
			if (canonical === null) {
				if (!unknownLogged) {
					unknownLogged = true;
					hookLog("child-prompt", "canonical-unknown", { chars: text.length });
				}
				return undefined;
			}
			if (text === canonical) {
				restoreLogged = false;
				return undefined;
			}
			// Injected run: the prompt path never ran, so the rewrite is missing.
			slot.set(canonical);
			if (!restoreLogged) {
				restoreLogged = true;
				hookLog("child-prompt", "prompt-normalized", {
					arrivedChars: text.length,
					canonicalChars: canonical.length,
				});
			}
		} catch {
			/* a repair fault must never break a provider request */
		}
		return undefined;
	});
}
