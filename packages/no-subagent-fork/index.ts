/**
 * no-subagent-fork: makes `context: "fork"` impossible for subagent spawns.
 *
 * Two layers, because a fork can be requested two ways:
 *
 *   1. IMPLICIT — no `context` on the call, so the resolved policy comes from
 *      `defaultSubagentContext`. Left unset, pi-subagents falls back to fork
 *      whenever the parent session is persisted and leaf-capable. Killed at the
 *      source by the subagent settings route (`"fresh"`).
 *
 *   2. EXPLICIT — `context: "fork"` on the call, or inside a `workflowScript`
 *      body. Rewritten to `"fresh"` here: `event.input` is mutable, so the
 *      spawn still succeeds and no fork ever happens. A `workflowScriptPath` is
 *      handled by reading the file (never mutating it) and blocking, since the
 *      caller's source is not ours to edit.
 *
 * Rewrites and blocks are appended to ~/.local/share/pi-no-subagent-fork/log.jsonl
 * for audit; nothing is ever blocked that could have been rewritten.
 *
 * NOT covered: `action: "resume"` replays a stored run's own context, so a run
 * created while forking was allowed still continues its fork. New runs cannot.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

const LOG_DIR = join(homedir(), ".local/share/pi-no-subagent-fork");

/** `context: "fork"` / `context:'fork'` / `context : "fork"`, quote-agnostic. */
const FORK_RE = /context\s*:\s*(["'])fork\1/g;

function log(kind: string, detail: string): void {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		appendFileSync(
			join(LOG_DIR, "log.jsonl"),
			`${JSON.stringify({ ts: new Date().toISOString(), kind, detail: detail.slice(0, 400) })}\n`,
		);
	} catch {
		/* never break a tool call over logging */
	}
}

/** Rewrite every `context: "fork"` occurrence in a workflow script body. */
export function deforkSource(src: string): string {
	return src.replace(FORK_RE, 'context: "fresh"');
}

/** Does a script body or file request fork context anywhere? */
export function requestsFork(src: string): boolean {
	return new RegExp(FORK_RE.source).test(src);
}

export default function (pi: ExtensionAPI): void {
	pi.on("tool_call", (event, ctx) => {
		if (!isToolCallEventType("subagent", event)) return;

		// Loose on purpose: the subagent tool belongs to another extension, so its
		// input shape is not importable here.
		const input = event.input as Record<string, unknown>;
		const notes: string[] = [];

		if (input.context === "fork") {
			input.context = "fresh";
			notes.push("call-level context: fork -> fresh");
		}

		if (typeof input.workflowScript === "string") {
			const src = input.workflowScript;
			if (requestsFork(src)) {
				input.workflowScript = deforkSource(src);
				notes.push("workflowScript context: fork -> fresh");
			}
		}

		if (typeof input.workflowScriptPath === "string") {
			const raw = input.workflowScriptPath;
			const file = isAbsolute(raw) ? raw : resolve(ctx.cwd ?? process.cwd(), raw);
			try {
				if (existsSync(file) && requestsFork(readFileSync(file, "utf8"))) {
					log("blocked", `workflowScriptPath ${file}`);
					return {
						block: true,
						reason: `workflowScriptPath '${raw}' requests context: "fork", which is never allowed. Edit it to context: "fresh" (or pass an inline workflowScript, which this hook rewrites automatically).`,
					};
				}
			} catch {
				/* unreadable file: let the tool report its own error */
			}
		}

		if (notes.length > 0)
			log("rewrote", `${notes.join("; ")} | ${JSON.stringify(input).slice(0, 200)}`);
	});
}
