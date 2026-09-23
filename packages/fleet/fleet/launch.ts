/**
 * fleet/launch — the ONLY pi-subagents caller.
 * Talks to the installed owner through its documented in-process event-bus RPC
 * (subagents:rpc:v1:*). Every launch is async and context:"fresh" — the envelope
 * is built here and nowhere else, so no caller can express a fork.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface RpcReply {
	ok: boolean;
	data?: unknown;
	error?: { code?: string; message?: string };
}

export const FRESH = "fresh";

/** The crew facts a worker needs to identify itself and to know what it owns. */
export interface CrewBinding {
	worker: string;
	scope: string;
	owns: string[];
	exclusive: string[];
}

/** The namespace the io guard reads. A single key, because two would be
 *  ambiguous and the guard refuses ambiguity outright. */
export const BINDING_NAMESPACE = "fleet/1";

/** The fixed launch envelope: agent, fresh context, timeout, async, plus the
 *  crew display name the status row shows in place of the agent type and the
 *  binding the worker-side guard identifies itself from. */
export function spawnParams(
	task: string,
	timeoutMs: number,
	binding?: CrewBinding,
): Record<string, unknown> {
	return {
		agent: "worker",
		task,
		context: FRESH,
		async: true,
		timeoutMs,
		...(binding
			? {
					label: binding.worker,
					extensionBindings: {
						[BINDING_NAMESPACE]: {
							worker: binding.worker,
							scope: binding.scope,
							owns: binding.owns,
							exclusive: binding.exclusive,
						},
					},
				}
			: {}),
	};
}

/** Why a transport call failed — the three conditions a foreman must be able to
 *  tell apart: nobody listening, a listener that refused, a listener that hung. */
export type TransportFault = "ok" | "timeout" | "rejected";

/**
 * A client-side deadline cannot tell "nobody is listening" from "the owner is
 * listening but hung" — so it does not claim to. `timeout` says exactly that and
 * names both possibilities; only an ANSWERED request can be `rejected`.
 */
export function classify(r: RpcReply, timeoutMs: number): { kind: TransportFault; detail: string } {
	if (!r.ok && r.error?.code === "timeout") {
		return {
			kind: "timeout",
			detail: `no reply within ${Math.round(timeoutMs / 1000)}s — either no listener in THIS session (a leaf/child session, the package disabled, or inherited PI_SUBAGENT* markers) or an owner that is hung`,
		};
	}
	if (!r.ok)
		return {
			kind: "rejected",
			detail: `${r.error?.code ?? "error"}: ${r.error?.message ?? "unknown"}`,
		};
	return { kind: "ok", detail: "ok" };
}

/** A cheap round-trip probe: `ping` is answered by the bridge without touching a
 *  run. Used to VERIFY the transport before foreman mode removes `subagent`. */
export async function probeTransport(
	pi: ExtensionAPI,
	timeoutMs = 6_000,
): Promise<{ ok: boolean; detail: string; fault?: TransportFault }> {
	const r = await rpc(pi, "ping", {}, timeoutMs);
	if (!r.ok) {
		const c = classify(r, timeoutMs);
		return { ok: false, detail: `${c.kind}: ${c.detail}`, fault: c.kind };
	}
	const caps = r.data as
		| { version?: number; capabilities?: { asyncSpawn?: boolean; steer?: boolean } }
		| undefined;
	if (caps?.version !== 1)
		return { ok: false, detail: `unexpected ping payload: ${JSON.stringify(r.data).slice(0, 80)}` };
	return {
		ok: true,
		detail: `protocol v${caps.version} (asyncSpawn=${caps.capabilities?.asyncSpawn === true})`,
	};
}

export function rpc(
	pi: ExtensionAPI,
	method: string,
	params: unknown,
	timeoutMs = 20_000,
): Promise<RpcReply> {
	return new Promise((resolve) => {
		const events = (
			pi as unknown as {
				events?: {
					on: (e: string, cb: (p: unknown) => void) => void;
					emit: (e: string, p: unknown) => void;
				};
			}
		).events;
		if (!events) {
			resolve({ ok: false, error: { code: "no-event-bus", message: "pi.events unavailable" } });
			return;
		}
		const requestId = `fleet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		let settled = false;
		const done = (r: RpcReply): void => {
			if (settled) return;
			settled = true;
			resolve(r);
		};
		const timer = setTimeout(
			() =>
				done({
					ok: false,
					error: { code: "timeout", message: `rpc ${method} timed out after ${timeoutMs}ms` },
				}),
			timeoutMs,
		);
		try {
			events.on(`subagents:rpc:v1:reply:${requestId}`, (payload) => {
				clearTimeout(timer);
				const r = payload as {
					success?: boolean;
					data?: unknown;
					error?: { code?: string; message?: string };
				};
				done({ ok: r?.success === true, data: r?.data, error: r?.error });
			});
			events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
		} catch (e) {
			clearTimeout(timer);
			done({ ok: false, error: { code: "emit-failed", message: String(e) } });
		}
	});
}
