/**
 * poller — the drain/expire loop and the ask bookkeeping.
 *
 * The entry file wires the transport to pi; this module owns the two things that need a clock:
 * reading this session's inbox, and settling the asks that have run out of time. Push, never
 * poll: nothing here is a surface the model can call.
 *
 * Nothing runs at module scope (CONTRACT.md R1): the loop starts when the session starts, its
 * interval is unref'd so it can never hold the process open, and `stop()` ends it. A callback
 * that throws is caught here and reported, because one unreadable envelope must not stop the
 * drain or the asks queued behind it.
 */
import { drain, type IpcEnvelope, sweepStale } from "@tinoy/pi-ext-lib";

/** How often the inbox is drained and outstanding asks are checked. */
const POLL_INTERVAL_MS = 500;

/** An ask this session received and has not answered yet. */
export interface InboundAsk {
	/** The handle its sender is blocked on: an answer names it back through `answerTo`. */
	id: string;
	from: string;
	at: string;
	text: string;
}

/** What a blocked `ask` returns: the peer's text, or the named reason it never arrived. */
export type AskOutcome = { ok: true; text: string } | { ok: false; reason: string };

/** The asks this session is waiting on, and the asks it owes an answer to. */
export interface AskLedger {
	/** A fresh message id, unique across processes and safe as a file name. */
	newId(prefix: string): string;
	/** Remember an inbound ask, so its handle can be named at the end of every turn. */
	noteInbound(envelope: IpcEnvelope): void;
	/** Drop the inbound ask an answer names; `null` when the handle is stale. */
	resolveInbound(askId: string): InboundAsk | null;
	/** Every inbound ask still unanswered, oldest first. */
	outstandingInbound(): InboundAsk[];
	/** Wait for the answer to `askId`, or for its deadline or the tool call's abort. */
	awaitAnswer(askId: string, timeoutMs: number, signal?: AbortSignal): Promise<AskOutcome>;
	/** Complete the waiting ask an answer names; false when no ask is waiting on it. */
	settle(answerTo: string, text: string): boolean;
	/** Stop waiting on an ask that can no longer be answered (a failed delivery). */
	abandon(askId: string, reason: string): void;
	/** Refuse every ask whose deadline has passed. */
	expire(now: number): void;
}

export function createAskLedger(): AskLedger {
	const inbound = new Map<string, InboundAsk>();
	const outbound = new Map<
		string,
		{ deadline: number; timeoutMs: number; settle: (outcome: AskOutcome) => void }
	>();
	let counter = 0;

	return {
		newId(prefix) {
			counter += 1;
			return `${prefix}-${process.pid.toString(36)}-${Date.now().toString(36)}-${counter.toString(36)}`;
		},

		noteInbound(envelope) {
			if (envelope.kind !== "ask") return;
			inbound.set(envelope.id, {
				id: envelope.id,
				from: envelope.from,
				at: envelope.ts,
				text: envelope.text,
			});
		},

		resolveInbound(askId) {
			const found = inbound.get(askId) ?? null;
			if (found) inbound.delete(askId);
			return found;
		},

		outstandingInbound() {
			return [...inbound.values()].sort((left, right) => left.at.localeCompare(right.at));
		},

		awaitAnswer(askId, timeoutMs, signal) {
			return new Promise<AskOutcome>((resolve) => {
				let settled = false;
				function finish(outcome: AskOutcome): void {
					if (settled) return;
					settled = true;
					outbound.delete(askId);
					signal?.removeEventListener("abort", onAbort);
					resolve(outcome);
				}
				function onAbort(): void {
					finish({
						ok: false,
						reason: "this ask was abandoned: the tool call was aborted before the peer answered",
					});
				}
				outbound.set(askId, { deadline: Date.now() + timeoutMs, timeoutMs, settle: finish });
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		},

		settle(answerTo, text) {
			const pending = outbound.get(answerTo);
			if (!pending) return false;
			pending.settle({ ok: true, text });
			return true;
		},

		abandon(askId, reason) {
			outbound.get(askId)?.settle({ ok: false, reason });
		},

		expire(now) {
			for (const [id, pending] of [...outbound]) {
				if (pending.deadline > now) continue;
				pending.settle({
					ok: false,
					reason: `the ask was not answered within ${pending.timeoutMs} ms — the peer is busy, gone, or answered without naming the handle "answerTo": "${id}"`,
				});
			}
		},
	};
}

/** What the loop tells its caller about work it could not finish. */
export interface DrainReport {
	kind: "drain-failed" | "message-refused" | "handler-failed";
	detail: string;
}

export interface DrainOptions {
	/** This session's id, or `null` before the session has one. */
	sessionId(): string | null;
	/** What to do with one inbound envelope. */
	onEnvelope(envelope: IpcEnvelope): void;
	/** What to do with a failure the model never sees. */
	report(event: DrainReport): void;
	/** Refuse the asks whose time is up. */
	expire(now: number): void;
	/** The drain cadence, for a probe that cannot wait half a second per check. */
	intervalMs?: number;
}

export interface DrainLoop {
	stop(): void;
}

/**
 * Start the loop: read this session's inbox, hand each envelope to the caller, refuse the asks
 * that have run out of time, and drop the presence records of processes that are gone.
 */
export function startDrain(options: DrainOptions): DrainLoop {
	let timer: ReturnType<typeof setInterval> | null = null;

	function tick(): void {
		const id = options.sessionId();
		if (id === null) return;
		const drained = drain(id);
		if (drained.ok) {
			for (const envelope of drained.envelopes) {
				try {
					options.onEnvelope(envelope);
				} catch (error) {
					options.report({
						kind: "handler-failed",
						detail: `${envelope.id}: ${error instanceof Error ? error.message : String(error)}`,
					});
				}
			}
			for (const refused of drained.refused) {
				options.report({ kind: "message-refused", detail: `${refused.file}: ${refused.reason}` });
			}
		} else {
			options.report({ kind: "drain-failed", detail: drained.reason });
		}
		// A session that is gone must not stay on the list of who can be reached, and nothing
		// depends on its record surviving one more tick.
		sweepStale();
		options.expire(Date.now());
	}

	timer = setInterval(tick, options.intervalMs ?? POLL_INTERVAL_MS);
	timer.unref();
	return {
		stop() {
			if (timer) clearInterval(timer);
			timer = null;
		},
	};
}
