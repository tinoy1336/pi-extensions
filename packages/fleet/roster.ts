/**
 * fleet/roster — the per-session crew record.
 * One file per pi session under ~/.local/pi/foreman/roster/<sessionId>.json with
 * a sessionId stamp: a foreign-session file is ignored for reads (another
 * session's crew is unaddressable, not adoptable) and removed by cleanupForeign()
 * unless its session still holds foreman mode. Writes are atomic (temp + rename).
 * Retention: newest 20 files / 7 days, pruned at start.
 *
 * A crew crosses sessions through an adoption sheet (`adopt.ts`), never through this
 * file: a worker this session adopted is recorded here with `adoptedFrom` naming the
 * sheet it came from, and a worker this session published carries `handed-off`, a
 * state this session no longer acts on.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as mode from "./mode.ts";
import type { Claim } from "./predicates";

export const ROSTER_DIR = join(process.env.HOME ?? "/root", ".local/pi/foreman/roster");
const MAX_FILES = 20;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface Worker {
	name: string;
	// "failed"/"stopped" are terminal DISTINCT from "completed": the roster must
	// report the outcome the status row carries, not a rounded-up success word.
	state:
		| "live"
		| "idle"
		| "retiring"
		| "retired"
		| "completed"
		| "failed"
		| "stopped"
		| "not-resumable"
		| "handed-off";
	scope: string;
	asyncRunId: string | null;
	/** True when a resume succeeded but its NEW run id could not be reconciled:
	 *  the stored id is then known-dead and steer/retire refuse instead of aiming
	 *  at the pre-resume run. Cleared by the next successful reconcile. */
	handleUnverified: boolean;
	/** Why the worker was marked not-resumable, verbatim from the caller. The
	 *  reason is what makes the state clearable: only a structural verdict (no
	 *  persisted session) survives a reconcile; a transient refusal is never
	 *  recorded here at all. */
	notResumableReason: string | null;
	/** The captured cause of a failed/stopped run, read from the run's own record
	 *  at completion. Null while the run is healthy or the cause was never
	 *  captured — the roster then says so instead of faking a reason. */
	failure: { at: number; status: "failed" | "stopped"; reason: string } | null;
	/** Every async run id this worker has used — one per hire, one per resume. The
	 *  worker's token/context figures are the UNION across these runs, so a resume
	 *  never resets its fatigue evidence. */
	runIds: string[];
	childIndex: number;
	hiredAt: number;
	lastActivityAt: number | null;
	reportPath: string | null;
	owns: string[];
	exclusive: string[];
	exclusiveDeclared: boolean;
	authored: string[];
	protocolLineInjected: boolean;
	/** When this session published the worker in an adoption sheet. */
	handedOffAt?: number;
	/** Set on a worker this session ADOPTED from another session: the sheet it came
	 *  from and the session that published it. Absent for a worker hired here, which is
	 *  what tells a reader where the record's provenance lies. */
	adoptedFrom?: { sessionId: string; sheet: string; at: number };
}

export interface Roster {
	/** 2 carried a pool of default worker names; 3 does not, because the caller
	 *  supplies every name at hire. A 2 record still loads — the loader drops the
	 *  two fields that reader would look for. */
	version: 3;
	sessionId: string;
	startedAt: number;
	crew: Worker[];
}

function path(sessionId: string): string {
	return join(ROSTER_DIR, `${sessionId}.json`);
}

export function fresh(sessionId: string): Roster {
	return {
		version: 3,
		sessionId,
		startedAt: Date.now(),
		crew: [],
	};
}

export function load(sessionId: string): Roster {
	try {
		const raw = JSON.parse(readFileSync(path(sessionId), "utf8")) as Roster;
		if (raw?.sessionId !== sessionId) return fresh(sessionId); // foreign/stale: absent for reads
		// A record written before the name pool was removed still carries its two fields.
		// They are dropped on every read, so no later edit can find a pooled name in a
		// saved record and treat it as a fallback that exists.
		delete (raw as Roster & { namePool?: unknown; nextName?: unknown }).namePool;
		delete (raw as Roster & { namePool?: unknown; nextName?: unknown }).nextName;
		raw.crew = Array.isArray(raw.crew) ? raw.crew : [];
		for (const w of raw.crew) {
			if (typeof w.handleUnverified !== "boolean") w.handleUnverified = false;
			if (typeof w.notResumableReason !== "string") w.notResumableReason = null;
			if (!w.failure || typeof w.failure !== "object") w.failure = null;
			if (!Array.isArray(w.runIds))
				w.runIds = typeof w.asyncRunId === "string" && w.asyncRunId ? [w.asyncRunId] : [];
			// A roster written before the sentinel fix may carry the literal "none"
			// as an owned path; it is a no-claim marker and must never read as a claim.
			if (Array.isArray(w.owns)) w.owns = w.owns.filter((p) => p !== "none");
		}
		return raw;
	} catch {
		return fresh(sessionId);
	}
}

export function save(r: Roster): void {
	try {
		mkdirSync(ROSTER_DIR, { recursive: true });
		const p = path(r.sessionId);
		const tmp = `${p}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(r, null, 2)}\n`);
		renameSync(tmp, p);
	} catch {
		/* a failed roster write must never break a launch; the caller logs it */
	}
}

export function find(r: Roster, name: string): Worker | undefined {
	return r.crew.find((w) => w.name === name);
}

/**
 * True when this record still holds its claim. The states that do NOT are the ones
 * `claims` skips, and they live here so a reader deciding whether to release a
 * worker (the gone-run pass) uses the same rule the overlap check does — one
 * spelling of "this record owns its paths".
 */
export function holdsClaim(w: Worker): boolean {
	return !(
		w.state === "retired" ||
		w.state === "completed" ||
		w.state === "not-resumable" ||
		w.state === "handed-off"
	);
}

/** All live claims across the crew (claims release on report/retire, and on a
 *  handoff: publication is how the outgoing foreman withdraws its claim, so a
 *  successor is not blocked by a crew that no longer belongs to this session). */
export function claims(r: Roster, exceptName?: string): Claim[] {
	const out: Claim[] = [];
	for (const w of r.crew) {
		if (w.name === exceptName) continue;
		if (!holdsClaim(w)) continue;
		for (const p of w.owns) out.push({ path: p, owner: w.name, since: w.hiredAt });
		for (const t of w.exclusive)
			out.push({ path: `exclusive:${t}`, owner: w.name, since: w.hiredAt });
	}
	return out;
}

export function newWorker(name: string, scope: string): Worker {
	return {
		name,
		state: "live",
		scope,
		asyncRunId: null,
		handleUnverified: false,
		notResumableReason: null,
		failure: null,
		runIds: [],
		childIndex: 0,
		hiredAt: Date.now(),
		lastActivityAt: Date.now(),
		reportPath: null,
		owns: [],
		exclusive: [],
		exclusiveDeclared: false,
		authored: [],
		protocolLineInjected: true,
	};
}

/**
 * Remove crew files owned by other sessions. Ownership is decided by the
 * session stamp, never by "found on disk": a `<sid>.json` is foreign when its
 * stem is not the current session AND that session holds no active foreman mode
 * (`mode-<sid>.json` ON) — a live foreman session's crew record must survive.
 * Best-effort: a failure never reaches the caller.
 */
export function cleanupForeign(sessionId: string): void {
	try {
		mkdirSync(ROSTER_DIR, { recursive: true });
		for (const f of readdirSync(ROSTER_DIR)) {
			if (!f.endsWith(".json") || f.startsWith("mode-")) continue;
			const stem = f.slice(0, -".json".length);
			if (stem === sessionId || mode.isOn(stem)) continue;
			try {
				const p = join(ROSTER_DIR, f);
				const raw = JSON.parse(readFileSync(p, "utf8")) as { sessionId?: unknown };
				if (raw?.sessionId !== stem) continue; // not a well-formed per-session crew file
				unlinkSync(p);
			} catch {
				/* leave ambiguous or already-gone files */
			}
		}
	} catch {
		/* cleanup is best-effort */
	}
}

/** Prune old roster files (call once per process start). */
export function prune(): void {
	try {
		mkdirSync(ROSTER_DIR, { recursive: true });
		const files = readdirSync(ROSTER_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => ({ f, t: statSync(join(ROSTER_DIR, f)).mtimeMs }))
			.sort((a, b) => b.t - a.t);
		const now = Date.now();
		for (const { f, t } of files.slice(MAX_FILES)) unlinkSync(join(ROSTER_DIR, f));
		for (const { f, t } of files) if (now - t > MAX_AGE_MS) unlinkSync(join(ROSTER_DIR, f));
	} catch {
		/* pruning is best-effort */
	}
}
