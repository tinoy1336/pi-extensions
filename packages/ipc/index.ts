/**
 * @tinoy/pi-ipc — the session-to-session transport, on pi's model-facing surface.
 *
 * One tool, `ipc`, with four actions: `list` names the live sessions, `send` delivers to one of
 * them, `ask` blocks until that peer answers, and `broadcast` delivers to every other live
 * session. The wire itself — the rendezvous path under `$XDG_RUNTIME_DIR`, the presence records,
 * the inbox, and the bus contract strings — belongs to `@tinoy/pi-ext-lib`, so a consumer that
 * speaks the bus (`@tinoy/pi-canon`, `@tinoy/pi-focus-gate`) works against this package or any
 * other implementation of that module without an edit.
 *
 * What this file owns: this session's presence record, the loop that drains its inbox, the
 * registry that installs a namespace another extension registers on the bus, and the
 * model-facing half of an envelope. A message or an ask arrives as its own turn; an answer
 * completes the blocked call that asked for it; a bus payload goes to its namespace's `onEvent`,
 * so a consumer that must stay passive still decides whether a notice wakes the session.
 *
 * There is no broker, no socket, no command line and no entry point outside a session: the
 * transport is reachable only from an extension running inside one. Liveness is the process
 * table, the state is runtime-scoped and dies with the login, and a session's own id and name
 * come from the session itself rather than from a launcher.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	argText,
	clip,
	deliver,
	type HeaderPart,
	hookLog,
	IPC_ENVELOPE_VERSION,
	IPC_NAMESPACE_PATTERN,
	IPC_REGISTER_EVENT,
	IPC_REGISTRY_READY_EVENT,
	type IpcEnvelope,
	type IpcPresence,
	peersWithNamespace,
	processStartTicks,
	readPeers,
	safeToolHeader,
	writePresence,
} from "@tinoy/pi-ext-lib";
import { Type } from "typebox";
import { createAskLedger, type DrainLoop, startDrain } from "./poller.ts";

/** The tool's name. Nothing else in this workspace registers it. */
const TOOL_NAME = "ipc";

/** The ask timeout knob and its default, the ceiling the escalation path was measured at. */
const ASK_TIMEOUT_ENV = "PI_IPC_ASK_TIMEOUT_MS";
const DEFAULT_ASK_TIMEOUT_MS = 600_000;

/** The shortest id prefix `send` and `ask` accept — shorter than this, a target is a guess. */
const MIN_PREFIX = 4;

/** The namespace marker a broadcast envelope carries, so a recipient can attribute it as one. */
const BROADCAST_NAMESPACE = "broadcast";

/**
 * The channel a registered namespace is handed. The method names and the audiences are the bus
 * contract's (`IPC_CHANNEL_METHODS`), which is what lets an existing consumer keep its call
 * sites: `publish` may throw synchronously, and every consumer already calls it behind a
 * try/catch.
 */
interface IpcChannel {
	publish(
		payload: unknown,
		options?: { audience?: "owner" | "capable"; ownerOnly?: boolean },
	): void;
	listSessions(): Promise<Array<{ id: string; name?: string }>>;
}

/** What another extension emits on the bus to be handed a channel. */
interface NamespaceRegistration {
	namespace: string;
	ownerEligible?: boolean;
	onEvent?: (event: { type: string; fromSessionId?: string; payload?: unknown }) => void;
	onReady?: (channel: IpcChannel) => void;
}

/** This session's own transport facts, read at session start. */
interface SessionFacts {
	id: string;
	cwd: string;
	model: string;
	startedAt: string;
}

/** Every result the tool returns: text for the model, and a machine-readable outcome. */
interface ToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: Record<string, unknown>;
}

/** A refusal names the fault and, where one exists, the fix — never an empty success. */
function refusal(text: string, details: Record<string, unknown> = {}): ToolResult {
	return {
		content: [{ type: "text", text: `${TOOL_NAME}: ${text}` }],
		details: { ok: false, ...details },
	};
}

/** The transport could not be reached: the one refusal whose fix is always the same. */
function transportRefusal(reason: string, details: Record<string, unknown> = {}): ToolResult {
	return refusal(
		`${reason} — the transport needs a writable $XDG_RUNTIME_DIR, which a login session provides`,
		{ reason: "transport-unavailable", ...details },
	);
}

export default function (pi: ExtensionAPI): void {
	try {
		wire(pi);
	} catch (error) {
		hookLog("ipc", "register-failed", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}

function wire(pi: ExtensionAPI): void {
	let self: SessionFacts | null = null;
	/** The bus namespaces this session serves, as each registrant named them. */
	const namespaces = new Map<string, NamespaceRegistration>();
	const ledger = createAskLedger();
	let loop: DrainLoop | null = null;
	const reported = new Set<string>();

	/**
	 * One diagnostics line per distinct condition per process (CONTRACT.md R3): the drain runs
	 * twice a second, so a condition that persists must not write a line twice a second.
	 */
	function report(kind: string, reason: string): void {
		const key = `${kind}\u0000${reason}`;
		if (reported.has(key)) return;
		reported.add(key);
		hookLog(TOOL_NAME, kind, { reason });
	}

	function messageOf(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	function sessionId(): string | null {
		return self?.id ?? null;
	}

	// ---------- presence ----------

	/** Rewrite this session's record; the namespaces it serves change as registrations land. */
	function refreshPresence(): void {
		if (!self) return;
		const ticks = processStartTicks(process.pid);
		if (ticks === null) {
			report("presence-failed", "this process has no start time in /proc/<pid>/stat");
			return;
		}
		const name = pi.getSessionName();
		const record: IpcPresence = {
			id: self.id,
			cwd: self.cwd,
			model: self.model,
			pid: process.pid,
			processStartTicks: ticks,
			namespaces: [...namespaces.keys()],
			startedAt: self.startedAt,
			...(name ? { name } : {}),
		};
		const written = writePresence(record);
		if (!written.ok) report("presence-failed", written.reason);
	}

	// ---------- the bus registry ----------

	/**
	 * The channel one namespace publishes through.
	 *
	 * A notice reaches the live sessions that registered the namespace, never the publisher and
	 * never a session that did not register it (R3). Zero recipients is a success — a machine
	 * with no peers is the normal quiet case — while a failed write is named, because a caller
	 * that logs a failed notice must be told the truth about it.
	 */
	function channelFor(namespace: string): IpcChannel {
		return {
			publish(payload, options) {
				const audience = options?.audience ?? "capable";
				if (audience === "owner") {
					throw new Error(
						'ipc: this transport elects no owner, so audience "owner" cannot be delivered — publish with audience "capable"',
					);
				}
				const from = sessionId();
				if (from === null) {
					throw new Error("ipc: this session has no id yet, so it cannot publish");
				}
				let text: string;
				try {
					text = JSON.stringify(payload) ?? "";
				} catch (error) {
					throw new Error(`ipc: the payload cannot be serialised: ${messageOf(error)}`);
				}
				const envelope: IpcEnvelope = {
					v: IPC_ENVELOPE_VERSION,
					id: ledger.newId("bus"),
					ts: new Date().toISOString(),
					from,
					kind: "bus",
					namespace,
					audience,
					text,
				};
				const peers = peersWithNamespace(namespace);
				if (!peers.ok) throw new Error(`ipc: ${peers.reason}`);
				const failed: string[] = [];
				for (const peer of peers.peers) {
					if (peer.id === from) continue;
					const sent = deliver(peer.id, envelope);
					if (!sent.ok) failed.push(`${peer.id.slice(0, 8)}: ${sent.reason}`);
				}
				if (failed.length > 0) {
					throw new Error(
						`ipc: the notice did not reach ${failed.length} session(s) — ${failed[0]}`,
					);
				}
			},
			async listSessions() {
				const peers = readPeers();
				if (!peers.ok) throw new Error(`ipc: ${peers.reason}`);
				return peers.peers.map((peer) => ({
					id: peer.id,
					...(peer.name === undefined ? {} : { name: peer.name }),
				}));
			},
		};
	}

	/** Install one registration, or refuse it by name. A duplicate namespace is refused, not thrown. */
	function install(payload: unknown): void {
		if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			report("register-refused", "a registration must be an object");
			return;
		}
		const candidate = payload as NamespaceRegistration;
		if (
			typeof candidate.namespace !== "string" ||
			!IPC_NAMESPACE_PATTERN.test(candidate.namespace)
		) {
			report(
				"register-refused",
				`the namespace ${JSON.stringify(candidate.namespace)} does not match ${IPC_NAMESPACE_PATTERN}`,
			);
			return;
		}
		if (namespaces.has(candidate.namespace)) {
			report("register-refused", `this session already serves "${candidate.namespace}"`);
			return;
		}
		if (candidate.onEvent !== undefined && typeof candidate.onEvent !== "function") {
			report("register-refused", `"${candidate.namespace}" has a non-function onEvent`);
			return;
		}
		if (candidate.onReady !== undefined && typeof candidate.onReady !== "function") {
			report("register-refused", `"${candidate.namespace}" has a non-function onReady`);
			return;
		}
		namespaces.set(candidate.namespace, candidate);
		refreshPresence();
		try {
			candidate.onReady?.(channelFor(candidate.namespace));
		} catch (error) {
			report("namespace-ready-failed", `${candidate.namespace}: ${messageOf(error)}`);
		}
	}

	pi.events.on(IPC_REGISTER_EVENT, install);
	// A consumer may load before this extension and lose its own emit to the missing listener;
	// this is the retry it waits for, so no load order can drop a registration.
	pi.events.emit(IPC_REGISTRY_READY_EVENT, {});

	// ---------- inbound envelopes ----------

	/** The label a peer is shown under: its session name, or the head of its id. */
	function senderLabel(id: string): string {
		const peers = readPeers();
		const peer = peers.ok ? peers.peers.find((candidate) => candidate.id === id) : undefined;
		return peer?.name?.trim() || id.slice(0, 8);
	}

	function deliverToNamespace(envelope: IpcEnvelope): void {
		const namespace = envelope.namespace ?? "";
		const registration = namespaces.get(namespace);
		if (!registration) {
			report("namespace-unknown", `no extension in this session serves "${namespace}"`);
			return;
		}
		if (typeof registration.onEvent !== "function") return;
		let payload: unknown;
		try {
			payload = JSON.parse(envelope.text);
		} catch {
			report("bus-unreadable", `the payload on "${namespace}" is not JSON`);
			return;
		}
		registration.onEvent({ type: "message", fromSessionId: envelope.from, payload });
	}

	/** An inbound message, ask or broadcast becomes a turn of its own, attributed to its sender. */
	function inject(envelope: IpcEnvelope): void {
		const from = senderLabel(envelope.from);
		const ask = envelope.kind === "ask";
		const broadcast = envelope.namespace === BROADCAST_NAMESPACE;
		const heading = ask ? "Ask" : broadcast ? "Broadcast" : "Message";
		const answerHint = ask
			? `\n\nAnswer it with ipc({ action: "send", to: "${envelope.from}", message: "<your answer>", answerTo: "${envelope.id}" }).`
			: "";
		pi.sendMessage(
			{
				customType: ask ? "ipc_ask" : broadcast ? "ipc_broadcast" : "ipc_message",
				content: `**${heading} from ${from}**\n\n${envelope.text}${answerHint}`,
				display: true,
				details: { from: envelope.from, id: envelope.id },
			},
			{ triggerTurn: true },
		);
	}

	function handleEnvelope(envelope: IpcEnvelope): void {
		try {
			if (envelope.kind === "bus") {
				deliverToNamespace(envelope);
				return;
			}
			if (envelope.kind === "answer") {
				const matched = ledger.settle(envelope.answerTo ?? "", envelope.text);
				if (!matched) {
					report("answer-unmatched", `no ask is waiting on "${envelope.answerTo ?? ""}"`);
				}
				return;
			}
			if (envelope.kind === "ask") ledger.noteInbound(envelope);
			inject(envelope);
		} catch (error) {
			report("inbound-failed", `${envelope.id}: ${messageOf(error)}`);
		}
	}

	// ---------- addressing ----------

	type Target = { ok: true; peer: IpcPresence } | { ok: false; reason: string };

	/** A full id, a unique id prefix, or an exact name — a target that is a guess is refused. */
	function resolveTarget(to: string, peers: IpcPresence[]): Target {
		const named = peers.filter((peer) => peer.name === to);
		if (named.length === 1) return { ok: true, peer: named[0] };
		if (named.length > 1) {
			return {
				ok: false,
				reason: `"${to}" is the name of ${named.length} live sessions — address one by its id: ${named.map((peer) => peer.id.slice(0, 8)).join(", ")}`,
			};
		}
		const exact = peers.find((peer) => peer.id === to);
		if (exact) return { ok: true, peer: exact };
		if (to.length < MIN_PREFIX) {
			return {
				ok: false,
				reason: `"${to}" is too short to be an id prefix — use ${MIN_PREFIX} characters or more, a full id, or an exact name`,
			};
		}
		const prefixed = peers.filter((peer) => peer.id.startsWith(to));
		if (prefixed.length === 1) return { ok: true, peer: prefixed[0] };
		if (prefixed.length > 1) {
			const candidates = prefixed
				.map((peer) => `${peer.id.slice(0, 8)}${peer.name ? ` (${peer.name})` : ""}`)
				.join(", ");
			return {
				ok: false,
				reason: `"${to}" matches ${prefixed.length} live sessions — use a longer prefix or an exact name: ${candidates}`,
			};
		}
		return {
			ok: false,
			reason: `no live session matches "${to}" — ipc({ action: "list" }) names the live set`,
		};
	}

	function rowOf(peer: IpcPresence, selfId: string): string {
		const name = peer.name?.trim() || "(unnamed)";
		const mine = peer.id === selfId ? "  (this session)" : "";
		return `  ${peer.id.slice(0, 8)}  ${name}  ${peer.cwd}${mine}`;
	}

	function listPeers(selfId: string): ToolResult {
		const peers = readPeers();
		if (!peers.ok) return transportRefusal(peers.reason);
		const others = peers.peers.filter((peer) => peer.id !== selfId);
		const addresses = `Address one by its full id, a unique id prefix of ${MIN_PREFIX} or more characters, or its exact name.`;
		const header =
			others.length === 0
				? `no other session is live on this machine. ${addresses}`
				: `${others.length} other session(s) live on this machine. ${addresses}`;
		const rows = peers.peers.map((peer) => rowOf(peer, selfId));
		if (!peers.peers.some((peer) => peer.id === selfId)) {
			rows.push("  (this session's own record is not on the transport, so no peer can address it)");
		}
		return {
			content: [{ type: "text", text: `${header}\n\n${rows.join("\n")}` }],
			details: {
				ok: true,
				sessions: peers.peers.map((peer) => ({
					id: peer.id,
					name: peer.name ?? null,
					cwd: peer.cwd,
					self: peer.id === selfId,
				})),
			},
		};
	}

	/** The ask timeout, read at call time; a value that is not a positive number is refused. */
	function askTimeout(): { ok: true; ms: number } | { ok: false; reason: string } {
		const raw = process.env[ASK_TIMEOUT_ENV];
		if (raw === undefined || raw.trim() === "") return { ok: true, ms: DEFAULT_ASK_TIMEOUT_MS };
		const parsed = Number(raw);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			return {
				ok: false,
				reason: `${ASK_TIMEOUT_ENV} is ${JSON.stringify(raw)}, which is not a positive number of milliseconds — unset it for the default ${DEFAULT_ASK_TIMEOUT_MS} ms`,
			};
		}
		return { ok: true, ms: parsed };
	}

	/** `send` and `ask` differ only in what the caller waits for. */
	async function exchange(
		selfId: string,
		action: "send" | "ask",
		params: { to?: string; message?: string; answerTo?: string },
		signal?: AbortSignal,
	): Promise<ToolResult> {
		const to = params.to?.trim() ?? "";
		if (to === "") {
			return refusal(
				`a "${action}" needs a target: pass to as a peer's id, a unique id prefix, or its exact name — ipc({ action: "list" }) names them`,
				{ reason: "no-target" },
			);
		}
		const message = params.message?.trim() ?? "";
		if (message === "") {
			return refusal(`a "${action}" needs a message body`, { reason: "no-message" });
		}
		if (action === "ask" && params.answerTo) {
			return refusal(
				'"ask" opens a new ask, so it takes no answerTo — answer an inbound ask with send',
				{ reason: "answer-to-on-ask" },
			);
		}
		const timeout = action === "ask" ? askTimeout() : null;
		if (timeout && !timeout.ok) return refusal(timeout.reason, { reason: "ask-timeout-config" });
		const peers = readPeers();
		if (!peers.ok) return transportRefusal(peers.reason);
		const target = resolveTarget(to, peers.peers);
		if (!target.ok) return refusal(target.reason, { reason: "no-target" });
		if (target.peer.id === selfId) {
			return refusal(
				"that target is this session — a message to yourself would arrive as your own turn",
				{ reason: "self-target" },
			);
		}

		const answerTo = action === "ask" ? undefined : params.answerTo?.trim() || undefined;
		const envelope: IpcEnvelope = {
			v: IPC_ENVELOPE_VERSION,
			id: ledger.newId(action === "ask" ? "ask" : answerTo ? "answer" : "m"),
			ts: new Date().toISOString(),
			from: selfId,
			to: target.peer.id,
			kind: action === "ask" ? "ask" : answerTo ? "answer" : "message",
			text: message,
			...(answerTo ? { answerTo } : {}),
		};
		const label = target.peer.name?.trim() || target.peer.id.slice(0, 8);

		// Registered before the delivery, so an answer that beats the next statement is not lost.
		const waiting =
			action === "ask" ? ledger.awaitAnswer(envelope.id, timeout?.ms ?? 0, signal) : null;
		const sent = deliver(target.peer.id, envelope);
		if (!sent.ok) {
			ledger.abandon(envelope.id, sent.reason);
			return refusal(sent.reason, { reason: "delivery-failed", to: target.peer.id });
		}
		if (waiting === null) {
			const answered = answerTo ? ledger.resolveInbound(answerTo) : null;
			const note = answerTo
				? answered
					? `, answering the ask from ${senderLabel(answered.from)}`
					: ` — but no inbound ask of this session carries the handle "${answerTo}", so its sender is still blocked (a stale handle still delivers)`
				: "";
			return {
				content: [{ type: "text", text: `sent to ${label}${note}` }],
				details: { ok: true, to: target.peer.id, ...(answerTo ? { answerTo } : {}) },
			};
		}
		const answer = await waiting;
		if (!answer.ok) {
			return refusal(answer.reason, {
				reason: "ask-unanswered",
				to: target.peer.id,
				answerTo: envelope.id,
			});
		}
		return {
			content: [{ type: "text", text: answer.text }],
			details: { ok: true, from: target.peer.id, answerTo: envelope.id },
		};
	}

	function broadcast(selfId: string, params: { to?: string; message?: string }): ToolResult {
		if (params.to?.trim()) {
			return refusal(
				'"broadcast" reaches every other live session, so it takes no target — use send for one peer',
				{ reason: "target-on-broadcast" },
			);
		}
		const message = params.message?.trim() ?? "";
		if (message === "") {
			return refusal(
				'a "broadcast" needs a message body — it is what every other session receives',
				{
					reason: "no-message",
				},
			);
		}
		const peers = readPeers();
		if (!peers.ok) return transportRefusal(peers.reason);
		const others = peers.peers.filter((peer) => peer.id !== selfId);
		if (others.length === 0) {
			return refusal(
				'no other session is live on this machine, so there is nothing to broadcast to — ipc({ action: "list" }) names the live set',
				{ reason: "no-peers" },
			);
		}
		const reached: string[] = [];
		const failed: Array<{ id: string; reason: string }> = [];
		for (const peer of others) {
			const envelope: IpcEnvelope = {
				v: IPC_ENVELOPE_VERSION,
				id: ledger.newId("b"),
				ts: new Date().toISOString(),
				from: selfId,
				to: peer.id,
				kind: "message",
				namespace: BROADCAST_NAMESPACE,
				text: message,
			};
			const sent = deliver(peer.id, envelope);
			if (sent.ok) reached.push(peer.name?.trim() || peer.id.slice(0, 8));
			else failed.push({ id: peer.id, reason: sent.reason });
		}
		if (reached.length === 0) {
			return refusal(
				`the broadcast reached no session — ${failed[0]?.reason ?? "delivery failed"}`,
				{
					reason: "broadcast-failed",
					failed,
				},
			);
		}
		const missed = failed.length > 0 ? ` (${failed.length} failed: ${failed[0]?.reason})` : "";
		return {
			content: [
				{
					type: "text",
					text: `broadcast delivered to ${reached.length} session(s): ${reached.join(", ")}${missed}`,
				},
			],
			details: { ok: true, delivered: reached.length, failed },
		};
	}

	// ---------- the tool ----------

	pi.registerTool({
		name: TOOL_NAME,
		label: "Session IPC",
		description:
			'Talk to other pi sessions on this machine. "list" names the live sessions with a short id, name and cwd; "send" delivers a message to one peer as its own turn; "ask" sends and blocks until that peer answers, or the ask times out; "broadcast" delivers to every other live session. An inbound message or ask arrives as its own turn. Pass answerTo to answer an inbound ask, naming the handle its notice printed verbatim.',
		promptSnippet:
			"Message other pi sessions: list peers, send, ask and block for the answer, broadcast to all",
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("send"),
					Type.Literal("ask"),
					Type.Literal("broadcast"),
				],
				{ description: 'The operation: "list", "send", "ask" or "broadcast".' },
			),
			to: Type.Optional(
				Type.String({
					description:
						'The peer a "send" or "ask" addresses: a full session id, a unique id prefix of 4+ characters, or an exact name.',
				}),
			),
			message: Type.Optional(
				Type.String({
					description: 'The body of a "send" or "ask", or the announcement a "broadcast" delivers.',
				}),
			),
			answerTo: Type.Optional(
				Type.String({
					description:
						"The ask handle an inbound ask printed. Answers that ask and completes its sender's blocked call; a stale handle still delivers, and the result says so.",
				}),
			),
		}),
		// Header only (display): the action and the target it addresses.
		renderCall(args, theme) {
			return safeToolHeader(theme, TOOL_NAME, () => {
				const action = argText(args, "action") ?? "action";
				const to = argText(args, "to");
				const message = argText(args, "message");
				const parts: HeaderPart[] = [["accent", ` ${action}`]];
				if (to) parts.push(["muted", " to "], ["dim", clip(to, 40)]);
				if (message) parts.push(["muted", " — "], ["dim", clip(message, 60)]);
				return parts;
			});
		},
		async execute(_toolCallId, params, signal): Promise<ToolResult> {
			const facts = self;
			if (!facts) {
				return refusal(
					"this session has no id yet, so the transport has nothing to send from — the id arrives at session start",
					{ reason: "no-session" },
				);
			}
			if (params.action === "list") return listPeers(facts.id);
			if (params.action === "broadcast") return broadcast(facts.id, params);
			if (params.action === "send" || params.action === "ask") {
				return exchange(facts.id, params.action, params, signal);
			}
			return refusal(
				`"${String(params.action)}" is not an action — the actions are list, send, ask and broadcast`,
				{ reason: "unknown-action" },
			);
		},
	});

	// ---------- the session ----------

	pi.on("session_start", (_event, ctx) => {
		try {
			const id = ctx.sessionManager?.getSessionId();
			if (!id) {
				report("session-unnamed", "this session has no id, so it cannot be addressed");
				return;
			}
			self = {
				id,
				cwd: ctx.cwd ?? "",
				model: ctx.model?.id ?? "unknown",
				startedAt: new Date().toISOString(),
			};
			refreshPresence();
			loop ??= startDrain({
				sessionId,
				onEnvelope: handleEnvelope,
				report: (event) => report(event.kind, event.detail),
				expire: (now) => ledger.expire(now),
			});
		} catch (error) {
			report("session-start-failed", messageOf(error));
		}
	});

	pi.on("session_shutdown", () => {
		loop?.stop();
		loop = null;
	});

	/**
	 * An unanswered inbound ask is named at the end of every turn, as one passive line: the next
	 * turn carries it, and this turn is not re-opened for it. Nothing can be polled for it — the
	 * `pending` action the old surface carried is gone.
	 */
	pi.on("turn_end", () => {
		try {
			const outstanding = ledger.outstandingInbound();
			if (outstanding.length === 0) return;
			const named = outstanding
				.map((ask) => `${ask.id} (from ${senderLabel(ask.from)})`)
				.join(", ");
			const plural = outstanding.length === 1 ? "ask is" : "asks are";
			pi.sendMessage(
				{
					customType: "ipc_pending_asks",
					content: `${outstanding.length} inbound ${plural} still unanswered: ${named} — answer one with ipc({ action: "send", to: "<their id>", message: "<your answer>", answerTo: "<the handle>" }).`,
					display: true,
					details: { asks: outstanding.map((ask) => ({ id: ask.id, from: ask.from })) },
				},
				{ deliverAs: "nextTurn" },
			);
		} catch (error) {
			report("turn-end-failed", messageOf(error));
		}
	});
}
