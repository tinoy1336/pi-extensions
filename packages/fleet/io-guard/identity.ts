/**
 * io-guard/identity — which crew worker THIS PROCESS is.
 *
 * Identity arrives as a namespaced binding in the child's environment, applied
 * before extensions load, and is then bound to a process:
 *
 *   - exactly ONE fleet-namespace binding may be present. Two would be
 *     ambiguous, so both are refused rather than picking a winner;
 *   - the binding is inherited by everything a worker spawns — build scripts,
 *     postinstalls, a bash-launched `pi`. Those processes carry the binding but
 *     are not the worker, so the identity is claimed by a single process at a
 *     time and a second process presenting the same binding resolves to NO
 *     identity. The claim is a pid plus the kernel's start time for that pid,
 *     so pid reuse cannot make a dead owner look alive.
 *
 * Resolution is lazy and memoised: nothing here depends on a startup event, and
 * the first answer computed is the answer kept.
 */
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFleetNamespace } from "./predicates.ts";

export interface WorkerIdentity {
	worker: string;
	scope: string;
	owns: string[];
	exclusive: string[];
	pid: number;
	procStart: string | null;
	resolvedAt: number;
}

/** The kernel's start time for a pid (/proc/<pid>/stat field 22). A bare pid is
 *  not an identity because pids are reused; the pair is. */
export function procStartTime(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return null;
		return stat.slice(close + 2).split(" ")[19] ?? null;
	} catch {
		return null;
	}
}

function isLive(pid: number, procStart: string | null): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	const now = procStartTime(pid);
	if (now !== null) {
		// /proc gave us a start time: pid reuse cannot masquerade as the owner.
		return procStart === null ? true : now === procStart;
	}
	// No /proc (non-Linux, or a restricted host): fall back to a signal probe.
	// Weaker than a start-time match — a reused pid reads as alive — but the safe
	// direction, since a false "alive" only makes a second claimant stand down.
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as { code?: string })?.code === "EPERM";
	}
}

interface BindingPayload {
	worker?: unknown;
	scope?: unknown;
	owns?: unknown;
	exclusive?: unknown;
}

/** The fleet's own payload, or null. Refuses ambiguity and malformed payloads. */
export function identityFromBindings(raw: string | undefined, pid: number): WorkerIdentity | null {
	if (!raw) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const fleetKeys = Object.keys(parsed as Record<string, unknown>).filter(isFleetNamespace);
	if (fleetKeys.length !== 1) return null; // none, or ambiguous
	const v = (parsed as Record<string, unknown>)[fleetKeys[0]!] as BindingPayload;
	if (!v || typeof v !== "object") return null;
	if (typeof v.worker !== "string" || v.worker.trim() === "") return null;
	const owns = Array.isArray(v.owns)
		? v.owns.filter((x): x is string => typeof x === "string")
		: [];
	const exclusive = Array.isArray(v.exclusive)
		? v.exclusive.filter((x): x is string => typeof x === "string")
		: [];
	return {
		worker: v.worker,
		scope: typeof v.scope === "string" ? v.scope : "",
		owns,
		exclusive,
		pid,
		procStart: procStartTime(pid),
		resolvedAt: Date.now(),
	};
}

export function resolveIdentity(env: NodeJS.ProcessEnv = process.env): WorkerIdentity | null {
	if (env.PI_SUBAGENT_CHILD !== "1") return null;
	return identityFromBindings(env.PI_SUBAGENT_EXTENSION_BINDINGS, process.pid);
}

interface ClaimRecord {
	pid?: number;
	procStart?: string | null;
	at?: number;
}

/** How long an unparseable claim record is honoured before it is treated as
 *  debris from a crashed writer rather than as a live owner. */
const CLAIM_GRACE_MS = 60_000;

function readClaim(file: string): ClaimRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as ClaimRecord;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Create the claim file only if it does not exist, atomically. A temp file is
 * written in full first and then hard-linked into place: `link` fails with
 * EEXIST rather than overwriting, so no claimant can ever observe a claim file
 * that exists but is still empty — the window that let two writers both believe
 * they owned the same worker.
 */
function linkClaim(dir: string, file: string, payload: string): "claimed" | "exists" | "error" {
	const tmp = join(dir, `.claim-${process.pid}-${Math.random().toString(36).slice(2)}`);
	let outcome: "claimed" | "exists" | "error" = "error";
	try {
		writeFileSync(tmp, payload);
		try {
			linkSync(tmp, file);
			outcome = "claimed";
		} catch (e) {
			outcome = (e as { code?: string })?.code === "EEXIST" ? "exists" : "error";
		}
	} catch {
		outcome = "error";
	} finally {
		try {
			unlinkSync(tmp);
		} catch {
			/* the link is what matters; the temp is gone or never existed */
		}
	}
	return outcome;
}

/**
 * Take the process claim for this worker, or refuse it.
 *
 * One writer per worker identity: the first process to create the runtime record
 * owns it. A later process presenting the same binding — a descendant inheriting
 * the environment — finds a LIVE owner and returns false, which is what keeps the
 * guard inert inside build scripts and bash-launched pi processes. An owner that
 * is provably dead, or a claim file so old it cannot be parsed, is taken over so a
 * resumed worker is not locked out by its predecessor.
 */
export function claimProcessIdentity(root: string, me: WorkerIdentity): boolean {
	const dir = join(root, "runtime");
	const file = join(dir, `${me.worker}.json`);
	const mine = JSON.stringify({ pid: me.pid, procStart: me.procStart, at: Date.now() });
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		return false;
	}

	const first = linkClaim(dir, file, mine);
	if (first === "claimed") return true;
	if (first !== "exists") return false;

	// Someone holds the name. Honour the holder while it is demonstrably alive.
	const rec = readClaim(file);
	if (rec && typeof rec.pid === "number") {
		if (rec.pid === me.pid && (rec.procStart ?? null) === me.procStart) return true;
		if (isLive(rec.pid, rec.procStart ?? null)) return false;
	} else {
		// Unparseable or mid-write by another process. Never unlink on sight: a
		// millisecond-old blank file is a live claimant, not debris. Only a record
		// old enough to be wreckage is reclaimed.
		try {
			if (Date.now() - statSync(file).mtimeMs < CLAIM_GRACE_MS) return false;
		} catch {
			return false; // vanished between checks: treat as contested
		}
	}

	try {
		unlinkSync(file);
	} catch {
		/* already gone: the link below decides */
	}
	return linkClaim(dir, file, mine) === "claimed";
}

/** A memoised resolver plus the one-time process claim. */
export function identityHolder(root: string, env: NodeJS.ProcessEnv = process.env) {
	let cached: WorkerIdentity | null | undefined;
	return {
		get(): WorkerIdentity | null {
			if (cached === undefined) {
				const resolved = resolveIdentity(env);
				cached = resolved && claimProcessIdentity(root, resolved) ? resolved : null;
			}
			return cached;
		},
	};
}

/**
 * Is a live process holding this worker's identity right now?
 *
 * The runtime record IS the identity claim (`claimProcessIdentity` writes it), so
 * this answers the same question a second claimant asks before standing down, with
 * the SAME liveness rule — the kernel start time for the pid, so a reused pid
 * cannot pass as the owner. Read fresh on every call: a caller deciding whether a
 * worker is gone must see the current answer, not a memo from an earlier moment.
 * An absent or unparseable record answers false — no process holds the identity
 * — which is the state a reboot leaves behind.
 */
export function identityClaimLive(root: string, worker: string): boolean {
	const rec = readClaim(join(root, "runtime", `${worker}.json`));
	if (!rec || typeof rec.pid !== "number") return false;
	return isLive(rec.pid, rec.procStart ?? null);
}
