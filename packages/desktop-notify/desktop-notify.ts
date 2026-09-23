/**
 * Desktop Notify - pi extension
 *
 * 1. Registers the `desktop_notify` tool the agent can invoke for manual
 *    notifications (pre-intrusive-action heads-ups, mid-turn failures).
 * 2. AUTO-NOTIFIES: sends a desktop notification when a
 *    response settles (agent_settled) and when ask_user_question is invoked
 *    (tool_call), so the agent no longer needs to call the tool at the end of
 *    every round. Skipped when the agent already sent a manual notify during
 *    the run (no double pings), in subagent/headless sessions, and when
 *    another run is queued behind the settled one.
 *
 * BODY-ONLY (user policy): every notification carries the MESSAGE alone — no
 * title, no `Pi — ` prefix, and the manual tool never passes one. `notify-send`
 * takes its summary as the first positional, so an EMPTY summary is sent: that
 * is the only form that renders no title line, while dropping the position and
 * letting the message fill the summary slot makes the daemon render the message
 * as an ellipsized heading instead of as the body.
 *
 * INTERRUPT SUPPRESSION: a manual mid-stream interrupt
 * (steer input / Esc) settles the run WITHOUT a real response — no "response
 * ready" ping for that (the next real response notifies as usual).
 *
 * URGENCY POLICY: critical is RARE — only for things demanding the user's
 * actual immediate action (approval window, broken system, data loss).
 * Routine completions = low; input requests = normal.
 *
 * FOCUS MODE: notifications are NOT gated by focus-gate —
 * the ask_user_question ping and manual desktop_notify keep working, because
 * the user still wants to hear when the agent needs their eyes or has finished
 * every deliverable. Only the routine per-response ping is suppressed while
 * focus is active (the user is away; one ping per turn is noise).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { argText, clip, type HeaderPart, safeToolHeader } from "@tinoy/pi-ext-lib";

import { focusActive, readFocusState } from "@tinoy/pi-focus-state";
import { Type } from "typebox";

const MAX_MESSAGE_LENGTH = 300;

function defaultExpireMs(urgency: string): number {
	switch (urgency) {
		case "critical":
			return 0; // persist until dismissed
		case "low":
			return 5000;
		default:
			return 8000;
	}
}

function defaultIcon(urgency: string): string {
	return urgency === "critical" ? "dialog-error" : "dialog-information";
}

export default function (pi: ExtensionAPI) {
	// ── auto-notification plumbing ──

	/** True once the agent manually called desktop_notify during this run —
	 *  the settled hook then stays silent (no double notification). */
	let manualNotifyThisRun = false;

	/** True when the user typed mid-stream (steer input). Kept as a secondary
	 *  signal — the primary interrupt detection now reads stopReason "aborted"
	 *  off the final assistant message at settle time (Esc emits NO input
	 *  event, so a flag from `input` alone misses Esc aborts entirely —
	 *  that was the bug: Esc-interrupted runs still pinged). */
	let steerInterrupted = false;

	pi.on("agent_start", () => {
		manualNotifyThisRun = false;
		steerInterrupted = false;
	});

	// Mid-stream steering (typing while the agent streams, RPC ln:"steer")
	// aborts the current run — if no new run follows, the settle is a cancel.
	pi.on("input", (event) => {
		if (event.streamingBehavior === "steer") steerInterrupted = true;
	});

	/** stopReason of the most recent assistant message on the branch —
	 *  "aborted" marks an interrupted run (Esc emits no input event). */
	function lastStopReason(ctx: any): string | undefined {
		try {
			for (const entry of ctx.sessionManager.getBranch().toReversed()) {
				if (entry.type === "message" && entry.message?.role === "assistant") {
					return entry.message.stopReason;
				}
			}
		} catch {}
		return undefined;
	}

	/** Fire the popup for the MESSAGE alone: the summary positional is empty
	 *  (see the header note) — the message is the only text that renders. */
	function fire(urgency: "low" | "normal" | "critical", message: string): void {
		const args = [
			"--app-name",
			"Pi",
			"--urgency",
			urgency,
			"--expire-time",
			String(defaultExpireMs(urgency)),
			"--icon",
			defaultIcon(urgency),
			"",
			message.slice(0, MAX_MESSAGE_LENGTH),
		];
		void pi.exec("notify-send", args, { timeout: 5000 }).catch(() => {
			// No notification daemon or spawn failure — never fatal, never logged
			// to the chat (the agent is not the sender here).
		});
	}

	pi.on("tool_call", (event) => {
		if (event.toolName === "desktop_notify") {
			manualNotifyThisRun = true;
			return;
		}
		if (event.toolName === "ask_user_question") {
			const input = event.input as { questions?: Array<{ question?: string }> } | undefined;
			const first = input?.questions?.[0]?.question?.trim();
			// Fires in focus mode too: a question IS the agent needing the user's
			// eyes, which is exactly when a ping is wanted.
			fire("normal", first ? first.replace(/\s+/g, " ") : "Pi asked a question");
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Subagent sessions report to their parent — desktop pings would spam
		// every fan-out. TWO launch paths mark a child: PI_SUBAGENT=1, exported by
		// ~/.local/bin/pi-subagent, and PI_SUBAGENT_CHILD=1, set in process.env by
		// the pi-subagents async runner itself. Print/JSON mode (`pi -p` probes)
		// has no user watching a terminal either.
		const dbg = (m: string) => {
			try {
				require("node:fs").appendFileSync("/tmp/pi-notify-debug.log", m + "\n");
			} catch {}
		};
		dbg(
			`settled: hasUI=${ctx.hasUI} idle=${ctx.isIdle()} manual=${manualNotifyThisRun} steer=${steerInterrupted} lastStop=${lastStopReason(ctx)} sub=${process.env.PI_SUBAGENT ?? "-"} child=${process.env.PI_SUBAGENT_CHILD ?? "-"}`,
		);
		if (process.env.PI_SUBAGENT === "1" || process.env.PI_SUBAGENT_CHILD === "1" || !ctx.hasUI)
			return;
		// Focus mode: the user is away, so the per-response ping is noise. Only
		// THIS ping is suppressed — the question ping above and manual
		// desktop_notify stay available (see the header note).
		const focus = readFocusState();
		if (focusActive(focus)) {
			dbg(`settled: ping suppressed (focus=${focus.mode})`);
			return;
		}
		// Another run is queued/retrying — the final settle notifies instead.
		if (!ctx.isIdle()) return;
		if (manualNotifyThisRun) return;
		// Interrupted run (Esc abort / steer-cancel): the final assistant message
		// carries stopReason "aborted" — nothing worth pinging.
		if (lastStopReason(ctx) === "aborted") return;
		if (steerInterrupted) return;

		// Snippet: last assistant text on the branch (single line, ~200 chars).
		let snippet = "";
		for (const entry of ctx.sessionManager.getBranch().toReversed()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const content = entry.message.content;
			const text = (Array.isArray(content) ? content : [])
				.map((block: { type?: string; text?: string }) =>
					block?.type === "text" ? (block.text ?? "") : "",
				)
				.join(" ")
				.replace(/\s+/g, " ")
				.trim();
			if (text) snippet = text;
			break;
		}
		fire("low", snippet || "Pi finished responding");
	});

	pi.registerTool({
		name: "desktop_notify",
		label: "Desktop Notify",
		description:
			"Send a desktop notification through the system notification daemon (notify-send / libnotify). " +
			"AUTOMATED: response-finish and ask_user_question notifications are sent by the extension — do NOT call " +
			"this tool for task completion. Manual use is for: heads-up BEFORE an intrusive action (input takeover, " +
			"opening a window, restarting a shared service — a fresh notify right before EACH one), mid-turn failures " +
			"needing the user, and background/async completions. BODY-ONLY: the notification renders the message alone — " +
			"never pass a title, and never author one like `Pi — …`; the `title` parameter is accepted but ignored. " +
			"Message is truncated to 300 characters.",
		promptSnippet:
			"Manual desktop notification for pre-intrusive-action heads-ups and mid-turn failures (completion + question pings are automatic)",
		promptGuidelines: [
			"AUTOMATION: the extension already sends a notification when the response finishes and when ask_user_question is invoked — NEVER call desktop_notify for task completion or to accompany a question.",
			"DO call desktop_notify as a heads-up BEFORE every intrusive/live action: input takeover (ydotool/wtype/adb), opening or spawning a window/UI, restarting a shared service, any live test — a FRESH notify immediately before EACH one; a stale heads-up from an earlier action does not cover a new one.",
			"DO call desktop_notify for mid-turn failures/errors the user must eventually act on, and for background/async work (subagent runs, detached jobs) that completes.",
			"URGENCY — critical is RARE: reserve it for things demanding the user's ACTUAL immediate action (approval window, broken system, data loss). Routine completions = low; heads-ups and input = normal (or low). Never critical for a finished task or an informational ping.",
			"BODY-ONLY: the popup shows the MESSAGE alone — never pass a `title` and never author one like `Pi — …` (a title is ignored); everything the user needs goes in the message.",
			"Keep the message short and specific: what is about to happen, what failed, or what finished.",
			"Never call desktop_notify when the current response is only an intercom ack or internal coordination; the notification belongs with the user-facing response and must not be re-sent for the same work when re-prompted by intercom traffic.",
		],
		parameters: Type.Object({
			message: Type.String({
				description: "Notification body text — the ONLY text rendered (truncated to 300 chars)",
			}),
			title: Type.Optional(
				Type.String({
					description:
						"IGNORED — notifications are body-only: the message alone renders, with no title line. Accepted only so existing callers do not fail; any value here is discarded. Never pass a title like `Pi — …`.",
				}),
			),
			urgency: Type.Optional(StringEnum(["low", "normal", "critical"] as const)),
			timeoutMs: Type.Optional(
				Type.Integer({
					minimum: 1000,
					description:
						"Auto-dismiss delay in milliseconds (default: 5000 low, 8000 normal; critical persists until dismissed)",
				}),
			),
			icon: Type.Optional(
				Type.String({
					description:
						"Icon name, e.g. dialog-information, dialog-warning, dialog-error (default depends on urgency)",
				}),
			),
		}),
		renderCall(args, theme) {
			return safeToolHeader(theme, "desktop_notify", () => {
				const urgency = argText(args, "urgency") ?? "normal";
				const message = argText(args, "message");
				const body = message ? clip(message, 90) : "";
				const parts: HeaderPart[] = [["accent", ` ${urgency}`]];
				if (body) parts.push(["muted", " — "], ["dim", body]);
				return parts;
			});
		},
		async execute(_toolCallId, params, signal, _onUpdate) {
			const message = params.message.trim().slice(0, MAX_MESSAGE_LENGTH);
			if (!message) {
				return {
					content: [
						{
							type: "text",
							text: "desktop_notify failed: message is required and must not be empty.",
						},
					],
					details: { sent: false, error: "empty message" },
				};
			}

			const urgency = params.urgency ?? "normal";
			// BODY-ONLY: the summary positional stays empty; a caller-supplied
			// `title` is discarded (say so in the result, never silently).
			const titleIgnored =
				typeof params.title === "string" && params.title.trim() !== "" ? params.title : undefined;

			const args = [
				"--app-name",
				"Pi",
				"--urgency",
				urgency,
				"--expire-time",
				String(params.timeoutMs ?? defaultExpireMs(urgency)),
				"--icon",
				params.icon ?? defaultIcon(urgency),
				"",
				message,
			];

			try {
				const result = await pi.exec("notify-send", args, {
					signal,
					timeout: 5000,
				});
				if (result.code === 0) {
					return {
						content: [
							{
								type: "text",
								text:
									`Sent desktop notification (urgency ${urgency}).` +
									(titleIgnored ? " Title ignored — notifications are body-only." : ""),
							},
						],
						details: {
							sent: true,
							urgency,
							message,
							...(titleIgnored ? { titleIgnored } : {}),
						},
					};
				}
				const error = result.stderr.trim() || `exit code ${result.code}`;
				return {
					content: [
						{
							type: "text",
							text: `desktop_notify failed: ${error}. Is a notification daemon (swaync, dunst, mako) running, and is notify-send on PATH?`,
						},
					],
					details: { sent: false, error },
				};
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `desktop_notify failed: ${detail}` }],
					details: { sent: false, error: detail },
				};
			}
		},
	});
}
