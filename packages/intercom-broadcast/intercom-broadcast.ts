/**
 * Intercom Broadcast Extension
 *
 * Adds a "broadcast" tool that sends a message to EVERY connected
 * pi-intercom session on this machine in one call (skips the current
 * session). Delivered via pi-intercom's extension bus (namespace
 * "broadcast"); each recipient session with this extension loaded injects
 * the message into its own stream through pi.sendMessage — the same
 * delivery path intercom sends use.
 *
 * Requires: pi-intercom installed and the broker running
 * (intercom({ action: "status" }) ok). Session must (re)start after
 * installing this file. User-level install: as a pi package entry.
 * (all sessions on this machine pick it up on next start).
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { argText, clip, type HeaderPart, hookLog, safeToolHeader } from "@tinoy/pi-ext-lib";

const NAMESPACE = "broadcast";

interface BroadcastPayload {
	type: "broadcast";
	message: string;
	senderName?: string;
}

interface BroadcastChannel {
	// pi-intercom 0.12.1's channel publish is SYNCHRONOUS: it ships the
	// extension_publish frame and returns nothing, and it throws
	// "Intercom is not connected" when the broker client is down. A void return
	// has no .catch, so chaining .catch on the result is a TypeError — that is
	// the crash canon's notices hit. Call it behind try/catch; the `await` at
	// the call site is safe either way (awaiting a non-promise is a no-op) and
	// also covers a build that returns a promise.
	publish(payload: unknown, options?: { audience?: "owner" | "capable" }): void;
	listSessions(): Promise<Array<{ id: string; name?: string }>>;
}

interface BroadcastRegistration {
	namespace: string;
	ownerEligible: boolean;
	onEvent(event: { type: string; fromSessionId?: string; payload?: unknown }): void;
	onReady(channel: BroadcastChannel): void;
}

export default function (pi: ExtensionAPI) {
	let channel: BroadcastChannel | null = null;
	let mySessionId: string | null = null;

	const registration: BroadcastRegistration = {
		namespace: NAMESPACE,
		ownerEligible: false,
		onEvent(event: { type: string; fromSessionId?: string; payload?: unknown }): void {
			if (event.type !== "message" || typeof event.fromSessionId !== "string") return;
			// Never echo our own broadcast back into our own stream.
			if (mySessionId !== null && event.fromSessionId === mySessionId) return;
			const payload = event.payload as Partial<BroadcastPayload> | null;
			if (!payload || payload.type !== "broadcast" || typeof payload.message !== "string") return;
			const sender = payload.senderName?.trim() || event.fromSessionId.slice(0, 8);
			// A failed inbound broadcast must not escape into the intercom event
			// bus as an uncaught throw — that turns a peer's failed broadcast into
			// a failed turn on this side.
			try {
				pi.sendMessage(
					{
						customType: "intercom_broadcast",
						content: `**📨 Broadcast from ${sender}**\n\n${payload.message.trim()}`,
						display: true,
						details: { fromSessionId: event.fromSessionId },
					},
					{ triggerTurn: true },
				);
			} catch (err) {
				hookLog("intercom-broadcast", "inject-failed", {
					fromSessionId: event.fromSessionId,
					reason: err instanceof Error ? err.message : String(err),
				});
			}
		},
		onReady(readyChannel: BroadcastChannel): void {
			channel = readyChannel;
		},
	};

	function register() {
		pi.events.emit("intercom:extension-register", registration);
	}

	// pi-intercom may load after this extension (extension load order is not
	// guaranteed), which would drop the first registration. Re-emit once its
	// registry is reported ready; the first successful registration wins
	// (a duplicate namespace is rejected, not thrown at us).
	pi.events.on("intercom:extension-registry-ready", () => {
		if (!channel) register();
	});
	register();

	const broadcastTool = defineTool({
		name: "broadcast",
		label: "Broadcast (intercom)",
		description:
			'Send a message to EVERY connected pi-intercom session on this machine in one call (skips the current session). Use for announcements that must reach all peer sessions: CONTEXT.md changes, shared-service restarts, global file claims, coordination policy updates. Do not use for targeted messages — use intercom({ action: "send", to: ... }) for those.',
		parameters: Type.Object({
			message: Type.String({ description: "Message to broadcast to all sessions" }),
		}),
		renderCall(args, theme) {
			return safeToolHeader(theme, "broadcast", () => {
				const message = argText(args, "message");
				return message
					? [
							["muted", " — "],
							["dim", clip(message)],
						]
					: [];
			});
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			mySessionId = ctx.sessionManager.getSessionId();
			if (!channel) {
				hookLog("intercom-broadcast", "channel-not-ready", {});
				return {
					content: [
						{
							type: "text",
							text: 'Broadcast unavailable: pi-intercom extension channel is not ready. Check intercom({ action: "status" }) and that the broker is running.',
						},
					],
					details: { delivered: false, reason: "channel-not-ready" },
				};
			}
			let sessions: Array<{ id: string; name?: string }> = [];
			try {
				sessions = await channel.listSessions();
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				hookLog("intercom-broadcast", "list-sessions-failed", { reason });
				return {
					content: [
						{
							type: "text",
							text: `Broadcast failed: could not list sessions: ${reason}`,
						},
					],
					details: { delivered: false, reason },
				};
			}
			const others = sessions.filter((s) => s.id !== mySessionId);
			const payload: BroadcastPayload = {
				type: "broadcast",
				message: params.message,
				senderName: pi.getSessionName() || undefined,
			};
			try {
				await channel.publish(payload, { audience: "capable" });
			} catch (err) {
				// Sync throw ("Intercom is not connected") or a rejected promise: the
				// broadcast is lost, the turn keeps its clear result.
				const reason = err instanceof Error ? err.message : String(err);
				hookLog("intercom-broadcast", "publish-failed", { reason, recipients: others.length });
				return {
					content: [
						{
							type: "text",
							text: `Broadcast failed: ${reason}`,
						},
					],
					details: { delivered: false, reason },
				};
			}
			const names = others.map((s) => s.name?.trim() || s.id.slice(0, 8));
			return {
				content: [
					{
						type: "text",
						text: `Broadcast sent to ${others.length} session(s): ${names.join(", ") || "(none)"}`,
					},
				],
				details: { delivered: true, recipients: others.map((s) => s.id) },
			};
		},
	});

	pi.registerTool(broadcastTool);
}
