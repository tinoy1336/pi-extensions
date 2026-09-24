/**
 * fleet/adopt — the handoff sheet and the successor's adoption verb.
 *
 * The crew roster is per-session by design (`roster.ts`: another session's crew is
 * "unaddressable, not adoptable"), so a handoff has to PUBLISH the crew rather than
 * let a successor read the predecessor's roster. The outgoing foreman therefore
 * writes one sheet per handoff under `adopt/`, a directory `prune()` and
 * `cleanupForeign()` never walk, and a `current.json` pointer names the handoff in
 * flight so a successor cannot adopt a stale crew by accident.
 *
 * The sheet is evidence, not authority: adoption re-reads every run's own record and
 * refuses when the run cannot be resolved, and it refuses outright while the
 * predecessor is demonstrably alive. Because a successor is normally opened while the
 * predecessor is finishing its last reply, that refusal comes after a BOUNDED wait
 * (`WAIT_CEILING_MS`) for the predecessor to exit — a wait that only re-reads the
 * liveness proof, with every mutation of the lifecycle still after the verdict.
 *
 * The `current.json` pointer is deleted by the adoption that CONSUMED the sheet it
 * names, and by nothing else: the handoff branch is re-runnable, so a pointer written
 * after this adoption began belongs to whoever it names and must survive.
 *
 * This module is the ONE writer of a run record, and it writes exactly one field:
 * `sessionId`, the parent session FILE PATH that pi-subagents stamps at launch and
 * compares on every control surface (resume, steer, stop, status). Re-stamping it is
 * a deliberate verb — `fleet adopt` — never a loosened guard, so a genuine
 * cross-session mistake still gets the honest refusal. Writes are atomic
 * (temp + rename) and only ever apply to a record that still carries the predecessor
 * identity the sheet recorded.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { prefixRows, type RunOutcome, type RunRecord, readRunRecord } from "./status.ts";

export const ADOPT_DIR = join(process.env.HOME ?? "/root", ".local/pi/foreman/adopt");
/** The pointer file names the handoff in flight; it is deleted last, so a crash
 *  mid-adoption is re-runnable and never double-claims. */
export const POINTER_NAME = "current.json";
const SHEET_VERSION = 1;

/** The prefix fingerprint recorded at handoff: the bytes the worker's own process
 *  was sending, from the house cache log. It is what makes the reuse decision a
 *  CHECK later instead of a guess. */
export interface PrefixFingerprint {
	sys: string | null;
	tools: string | null;
	nTools: number | null;
	prefixChars: number | null;
	ts: string | null;
}

export interface SheetWorker {
	name: string;
	scope: string;
	state: string;
	asyncRunId: string | null;
	runIds: string[];
	childIndex: number;
	owns: string[];
	exclusive: string[];
	hiredAt: number | null;
	lastActivityAt: number | null;
	reportPath: string | null;
	authored: string[];
	failure: { at: number; status: string; reason: string } | null;
	/** The child's own session record, and the run record's path — both on disk, so
	 *  the successor can verify a pointer instead of trusting this sheet. */
	sessionFile: string | null;
	statusPath: string | null;
	prefix: PrefixFingerprint | null;
	/** What the worker's LAST run had left behind when the sheet was written: its
	 *  state, end time and artifact locations, as the run's own record reported them.
	 *  Recorded evidence, kept for a reader of the archived sheet — adoption reports
	 *  the field from the LIVE record it re-reads, and refuses a worker whose record
	 *  is gone. Null for a worker whose run record carried no such fields, and for a
	 *  worker with no run at all. */
	outcome: RunOutcome | null;
}

export interface PredecessorIdentity {
	sessionId: string;
	/** The string pi-subagents compares: the predecessor's session FILE path when it
	 *  had one, its session id otherwise (`resolveCurrentSessionId`). */
	sessionFile: string | null;
	pid: number;
	processStartIdentity: string;
	hostname: string;
}

export interface Sheet {
	version: number;
	writtenAt: number;
	predecessor: PredecessorIdentity;
	crew: SheetWorker[];
	/** Stamped back by the successor that consumed the sheet. */
	adoptedAt?: number;
	adoptedBy?: string;
}

/**
 * A process's kernel start identity — the ticks field of `/proc/<pid>/stat`, the
 * same proof `pi-subagents`' session lease uses, so a recycled pid cannot pass for
 * the predecessor. Null when the process is gone or /proc is unreadable.
 */
export function processStartIdentity(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const tail = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trim()
			.split(/\s+/);
		const ticks = tail[19]; // field 22 overall, field 1 of the tail is field 3 (state)
		return ticks ? `linux:${ticks}` : null;
	} catch {
		return null;
	}
}

export function sheetFileName(predecessorSessionId: string, at = Date.now()): string {
	return `${new Date(at).toISOString().replace(/[:.]/g, "-")}-${predecessorSessionId}.json`;
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(ADOPT_DIR, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

export function writeSheet(sheet: Sheet): string {
	const path = join(ADOPT_DIR, sheetFileName(sheet.predecessor.sessionId, sheet.writtenAt));
	writeJsonAtomic(path, sheet);
	return path;
}

export function writePointer(file: string, sessionId: string, crew: number): void {
	writeJsonAtomic(join(ADOPT_DIR, POINTER_NAME), { file, sessionId, crew, writtenAt: Date.now() });
}

export function readPointer(): {
	file: string;
	sessionId: string;
	crew: number;
	writtenAt: number;
} | null {
	try {
		const raw = JSON.parse(readFileSync(join(ADOPT_DIR, POINTER_NAME), "utf8")) as {
			file?: unknown;
			sessionId?: unknown;
			crew?: unknown;
			writtenAt?: unknown;
		};
		if (typeof raw?.file !== "string" || !raw.file) return null;
		return {
			file: raw.file,
			sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
			crew: typeof raw.crew === "number" ? raw.crew : 0,
			writtenAt: typeof raw.writtenAt === "number" ? raw.writtenAt : 0,
		};
	} catch {
		return null;
	}
}

/**
 * Drop the pointer, but ONLY when it still names the sheet the caller consumed.
 * The handoff branch is re-runnable and a predecessor can re-publish while a
 * successor waits (or two successors can wait on one handoff), so an unconditional
 * unlink would delete a NEWER pointer this adoption never read — and with it the
 * only name of the handoff still in flight. The result is returned so the caller can
 * say what happened. This is the ONLY deletion of the pointer: the sheets themselves
 * are never removed by the fleet.
 */
export function clearPointer(consumedFile: string): { cleared: boolean; reason: string } {
	const pointer = readPointer();
	if (!pointer)
		return {
			cleared: false,
			reason: "the pointer was already gone (an earlier adoption removed it)",
		};
	if (pointer.file !== consumedFile) {
		return {
			cleared: false,
			reason: `the pointer now names ${pointer.file}, not the sheet this adoption consumed (${consumedFile}) — left in place for its own successor`,
		};
	}
	try {
		unlinkSync(join(ADOPT_DIR, POINTER_NAME));
		return { cleared: true, reason: `removed (it named ${consumedFile})` };
	} catch (e) {
		return { cleared: false, reason: `could not remove the pointer: ${String(e)}` };
	}
}

/** Every sheet on disk, newest first. */
export function listSheets(limit = 10): string[] {
	try {
		return readdirSync(ADOPT_DIR)
			.filter((f) => f.endsWith(".json") && f !== POINTER_NAME)
			.sort()
			.reverse()
			.slice(0, limit);
	} catch {
		return [];
	}
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function strArray(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A worker's recorded run outcome, structurally validated like every other field
 *  adoption reads. Absent fields stay null rather than becoming an empty string. */
function outcomeOf(v: unknown): RunOutcome | null {
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	const runId = str(o.runId);
	if (!runId) return null;
	return {
		runId,
		state: str(o.state),
		endedAt: typeof o.endedAt === "number" ? o.endedAt : null,
		endedAtIso: str(o.endedAtIso),
		outputFile: str(o.outputFile),
		artifactsDir: str(o.artifactsDir),
		artifactNote: typeof o.artifactNote === "string" ? o.artifactNote : "",
	};
}

/**
 * Structural validation. A sheet is read from disk and may be truncated, older than
 * this code, or edited by hand, so every field adoption turns on is checked here: an
 * unchecked field would become a wrong identity comparison or a silent `undefined`
 * in a path.
 */
export function parseSheet(raw: unknown): Sheet | null {
	if (!raw || typeof raw !== "object") return null;
	const r = raw as Record<string, unknown>;
	const p = r.predecessor as Record<string, unknown> | undefined;
	if (!p || typeof p !== "object") return null;
	const sessionId = str(p.sessionId);
	if (!sessionId) return null;
	if (
		p.pid !== undefined &&
		p.pid !== null &&
		(typeof p.pid !== "number" || !Number.isInteger(p.pid))
	)
		return null;
	if (!Array.isArray(r.crew)) return null;
	const crew: SheetWorker[] = [];
	for (const item of r.crew as unknown[]) {
		if (!item || typeof item !== "object") continue;
		const w = item as Record<string, unknown>;
		const name = str(w.name);
		if (!name) continue;
		const prefixRaw = w.prefix as Record<string, unknown> | undefined;
		crew.push({
			name,
			scope: typeof w.scope === "string" ? w.scope : "",
			state: typeof w.state === "string" ? w.state : "unknown",
			asyncRunId: str(w.asyncRunId),
			runIds: strArray(w.runIds),
			childIndex: typeof w.childIndex === "number" ? w.childIndex : 0,
			owns: strArray(w.owns),
			exclusive: strArray(w.exclusive),
			hiredAt: typeof w.hiredAt === "number" ? w.hiredAt : null,
			lastActivityAt: typeof w.lastActivityAt === "number" ? w.lastActivityAt : null,
			reportPath: str(w.reportPath),
			authored: strArray(w.authored),
			failure:
				w.failure && typeof w.failure === "object"
					? (w.failure as { at: number; status: string; reason: string })
					: null,
			sessionFile: str(w.sessionFile),
			statusPath: str(w.statusPath),
			outcome: outcomeOf(w.outcome),
			prefix: prefixRaw
				? {
						sys: str(prefixRaw.sys),
						tools: str(prefixRaw.tools),
						nTools: typeof prefixRaw.nTools === "number" ? prefixRaw.nTools : null,
						prefixChars: typeof prefixRaw.prefixChars === "number" ? prefixRaw.prefixChars : null,
						ts: str(prefixRaw.ts),
					}
				: null,
		});
	}
	return {
		version: typeof r.version === "number" ? r.version : 0,
		writtenAt: typeof r.writtenAt === "number" ? r.writtenAt : 0,
		predecessor: {
			sessionId,
			sessionFile: str(p.sessionFile),
			pid: typeof p.pid === "number" ? p.pid : 0,
			processStartIdentity:
				typeof p.processStartIdentity === "string" ? p.processStartIdentity : "",
			hostname: typeof p.hostname === "string" ? p.hostname : "",
		},
		crew,
		...(typeof r.adoptedAt === "number" ? { adoptedAt: r.adoptedAt } : {}),
		...(str(r.adoptedBy) ? { adoptedBy: str(r.adoptedBy) as string } : {}),
	};
}

/** Resolve which sheet an adopt call means, by pointer file or by predecessor id. */
export function resolveSheetFile(from: string | undefined): { path: string } | { error: string } {
	const want = (from ?? "").trim();
	if (!want || want === "current") {
		const pointer = readPointer();
		if (!pointer) {
			const available = listSheets();
			return {
				error: `no handoff is in flight: ${join(ADOPT_DIR, POINTER_NAME)} names none. Sheets on disk: ${available.join(", ") || "(none)"}. Pass from:"<predecessor session id>" to adopt an archived one.`,
			};
		}
		return { path: join(ADOPT_DIR, pointer.file) };
	}
	const files = listSheets(200);
	const exact = files.find((f) => f === want);
	if (exact) return { path: join(ADOPT_DIR, exact) };
	const byId = files.filter((f) => f.includes(want));
	if (byId.length === 1) return { path: join(ADOPT_DIR, byId[0]) };
	if (byId.length > 1)
		return {
			error: `'${want}' matches ${byId.length} sheets: ${byId.join(", ")}. Pass the full session id.`,
		};
	return {
		error: `no adoption sheet for '${want}'. Sheets on disk: ${files.join(", ") || "(none)"}.`,
	};
}

export function readSheetAt(path: string): { sheet: Sheet } | { error: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		return { error: `cannot read the adoption sheet ${path}: ${String(e)}` };
	}
	const sheet = parseSheet(raw);
	if (!sheet)
		return {
			error: `the adoption sheet ${path} is not a well-formed sheet (version, predecessor.sessionId and crew are required).`,
		};
	if (sheet.version !== SHEET_VERSION) {
		return {
			error: `the adoption sheet ${path} carries version ${sheet.version}; this fleet writes and reads version ${SHEET_VERSION}.`,
		};
	}
	return { sheet };
}

/**
 * When a crew was published, read from the sheet a session adopted it from.
 * The roster's `adoptedFrom` names the sheet FILE, never the time, so the comparison
 * a successor makes on every roster pass ("what landed since I took over?") is a read
 * rather than a stamp taken once at adoption — which is what makes it still true for a
 * worker that settles later. Null when the sheet cannot be read or carries no stamp:
 * an unknown publish time is reported as unknown, never as zero.
 */
export function publishedAt(sheetFile: string): number | null {
	const read = readSheetAt(join(ADOPT_DIR, sheetFile));
	if ("error" in read) return null;
	return read.sheet.writtenAt > 0 ? read.sheet.writtenAt : null;
}

/** Stamp the consuming successor into the sheet, so the archived sheet says who took
 *  the crew and when. Best-effort: a failed stamp never fails an adoption. */
export function stampSheetAdopted(path: string, sheet: Sheet, successorSessionId: string): void {
	try {
		writeJsonAtomic(path, { ...sheet, adoptedAt: Date.now(), adoptedBy: successorSessionId });
	} catch {
		/* evidence only */
	}
}

export type PredecessorVerdict =
	| { verdict: "alive"; detail: string }
	| { verdict: "gone"; detail: string }
	| { verdict: "unknown"; detail: string };

/**
 * How long `adopt` waits for a predecessor that is still alive, at a first
 * interval of 1 s and a 1.5× backoff capped at 8 s. A successor is usually opened
 * while the predecessor is finishing its last reply, so the choice is between
 * parking briefly and refusing for the successor to hand-retry; the ceiling bounds
 * the parking. It is deliberately far below the predecessor's own run timeouts: the
 * wait exists to make an early arrival productive, not to outlast a working
 * foreman.
 */
export const WAIT_CEILING_MS = 105_000;
const WAIT_FIRST_MS = 1_000;
const WAIT_MAX_MS = 8_000;
/** A second bound, on the number of reads: the ceiling is wall-clock, so a sleep that
 *  resolves instantly (an injected one, or a clock that does not advance) would
 *  otherwise spin against the clock instead of parking. Reaching 105 s at this
 *  backoff takes ~20 reads, so the cap is slack for the real path and hard for a
 *  pathological one. */
const WAIT_MAX_POLLS = 200;

export interface PredecessorWait {
	verdict: PredecessorVerdict;
	/** Liveness reads made after the first. */
	polls: number;
	waitedMs: number;
}

/**
 * Poll the predecessor's liveness until it is proved gone or the ceiling expires.
 *
 * Safe to park here because the liveness test is one `/proc/<pid>/stat` read and
 * everything that mutates the adoption lifecycle — the sheet stamp, the roster write,
 * the claim re-bind, the pointer deletion — happens AFTER the verdict. This function
 * therefore writes nothing, signals nothing, restarts nothing and resumes nothing: it
 * only re-reads. The verdict it returns may still be `alive` (the caller then refuses
 * exactly as it would have without waiting) or `unknown` (fails closed).
 */
export async function waitForPredecessor(
	sheet: Sheet,
	opts: {
		ceilingMs?: number;
		firstMs?: number;
		maxMs?: number;
		maxPolls?: number;
		sleep?: (ms: number) => Promise<void>;
		verdict?: (sheet: Sheet) => PredecessorVerdict;
	} = {},
): Promise<PredecessorWait> {
	const ceilingMs = opts.ceilingMs ?? WAIT_CEILING_MS;
	const maxMs = opts.maxMs ?? WAIT_MAX_MS;
	const maxPolls = opts.maxPolls ?? WAIT_MAX_POLLS;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
	const verdict = opts.verdict ?? predecessorVerdict;
	const started = Date.now();
	let waitMs = opts.firstMs ?? WAIT_FIRST_MS;
	let polls = 0;
	let v = verdict(sheet);
	while (v.verdict === "alive" && polls < maxPolls && Date.now() - started < ceilingMs) {
		await sleep(waitMs);
		polls += 1;
		v = verdict(sheet);
		waitMs = Math.min(maxMs, Math.round(waitMs * 1.5));
	}
	return { verdict: v, polls, waitedMs: Date.now() - started };
}

/**
 * Is the session that wrote this sheet demonstrably gone? Two proofs are required and
 * both are the ones the session lease uses: the same host, and a pid that either no
 * longer exists or now belongs to a different process. A stopped-but-present pid is
 * ALIVE — the successor must not race a live foreman for the crew.
 */
export function predecessorVerdict(sheet: Sheet, thisHost = hostname()): PredecessorVerdict {
	const p = sheet.predecessor;
	if (!p.hostname || p.hostname !== thisHost) {
		return {
			verdict: "unknown",
			detail: `the sheet was written on host '${p.hostname || "unknown"}' and this session runs on '${thisHost}', so its pid cannot be checked from here`,
		};
	}
	if (!p.pid || !p.processStartIdentity) {
		return {
			verdict: "unknown",
			detail: "the sheet carries no pid / start identity, so the predecessor cannot be proved gone",
		};
	}
	const identity = processStartIdentity(p.pid);
	if (identity === null) return { verdict: "gone", detail: `pid ${p.pid} is gone` };
	if (identity !== p.processStartIdentity) {
		return {
			verdict: "gone",
			detail: `pid ${p.pid} now belongs to a different process (start identity ${identity} ≠ sheet's ${p.processStartIdentity})`,
		};
	}
	return {
		verdict: "alive",
		detail: `pid ${p.pid} is alive with the same start identity (${identity})`,
	};
}

export type RestampResult =
	| {
			ok: true;
			changed: boolean;
			written: string[];
			skipped: string[];
			before: string;
			after: string;
	  }
	| { ok: false; reason: string };

/**
 * Re-stamp ONE settled run's parent-session identity from the predecessor's string to
 * the successor's. `expect` is the sheet's recorded predecessor identity: a record
 * that no longer carries it was re-stamped by someone else (or never belonged here),
 * and the refusal is what keeps this verb from becoming a blanket rewrite.
 */
export function restampParentSession(
	record: RunRecord,
	expect: string,
	next: string,
): RestampResult {
	if (!record.sessionId)
		return { ok: false, reason: `${record.statusPath} carries no sessionId to re-stamp` };
	if (record.sessionId !== expect) {
		return {
			ok: false,
			reason: `run ${record.runId} is stamped '${record.sessionId}', not the predecessor identity the sheet records ('${expect}') — refusing to re-stamp a record that does not belong to this handoff`,
		};
	}
	if (record.sessionId === next)
		return { ok: true, changed: false, written: [], skipped: [], before: expect, after: next };
	const written: string[] = [];
	const skipped: string[] = [];
	for (const path of [record.statusPath, record.resultPath, record.runIndexPath]) {
		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		} catch {
			skipped.push(path);
			continue;
		}
		if (raw.sessionId === undefined) {
			skipped.push(path);
			continue;
		}
		if (raw.sessionId !== expect) {
			return {
				ok: false,
				reason: `${path} is stamped '${String(raw.sessionId)}', not the predecessor identity ('${expect}') — refusing a partial re-stamp`,
			};
		}
		try {
			writeJsonAtomic(path, { ...raw, sessionId: next });
			written.push(path);
		} catch (e) {
			return { ok: false, reason: `could not write ${path}: ${String(e)}` };
		}
	}
	return { ok: true, changed: written.length > 0, written, skipped, before: expect, after: next };
}

/** The reason a settled run's re-stamp is durable while a live one's is not. */
export function restampDurability(state: string | null): { durable: boolean; note: string } {
	const st = (state ?? "").toLowerCase();
	if (st === "running" || st === "queued" || st === "pending") {
		return {
			durable: false,
			note: "the run is live and owns its own status record: it rewrites that file as it works, so a native re-stamp now would be transient — and a live worker is adopted by pointer, never resumed, so nothing needs the stamp yet",
		};
	}
	return { durable: true, note: "the run has settled and no longer writes its record" };
}

/**
 * What the prefix fingerprint on the sheet can still be checked against: the cache
 * log's own baseline row for a DIFFERENT run of the same worker — i.e. evidence from a
 * resume that has already happened. The sheet's own run cannot witness itself, so that
 * case is `unmeasured` rather than a match.
 *
 * The point of the check is cost, not curiosity: a resume starts a new child process
 * and rebuilds its system prompt, so a differing `sys` hash means the whole
 * conversation behind it re-bills. That is a named cold resume, which is what the
 * foreman has to be told before it reuses an idle worker for the prefix's sake.
 */
export interface FingerprintEvidence {
	decision: "match" | "mismatch" | "unmeasured";
	detail: string;
	sheet: PrefixFingerprint | null;
	observed: {
		runId: string;
		sys: string | null;
		tools: string | null;
		nTools: number | null;
		prefixChars: number | null;
		ts: string | null;
	} | null;
}

export function fingerprintEvidence(worker: SheetWorker): FingerprintEvidence {
	const sheetFp = worker.prefix;
	let newest: {
		runId: string;
		row: ReturnType<typeof prefixRows>[number];
		ownRun: boolean;
	} | null = null;
	for (const runId of worker.runIds.length
		? worker.runIds
		: worker.asyncRunId
			? [worker.asyncRunId]
			: []) {
		const rec = readRunRecord(runId);
		if (!rec) continue;
		const rows = prefixRows(rec.sessionFile, rec.pid, 2);
		const row = rows[rows.length - 1];
		if (!row) continue;
		const ownRun = runId === worker.asyncRunId;
		// A row from a resumed run always beats the sheet's own baseline; between two
		// resumed runs the newest record wins.
		if (!newest || (newest.ownRun && !ownRun)) newest = { runId, row, ownRun };
	}
	if (!newest) {
		return {
			decision: "unmeasured",
			detail:
				"the house cache log carries no baseline row for any of this worker's runs, so no prefix fingerprint can be checked",
			sheet: sheetFp,
			observed: null,
		};
	}
	const observed = {
		runId: newest.runId,
		sys: newest.row.sys,
		tools: newest.row.tools,
		nTools: newest.row.nTools,
		prefixChars: newest.row.prefixChars,
		ts: newest.row.ts,
	};
	if (newest.ownRun) {
		return {
			decision: "unmeasured",
			detail:
				"the only logged baseline for this worker is its own current run, which cannot witness its own resume: whether a resume rebuilds the same bytes is not knowable before it happens",
			sheet: sheetFp,
			observed,
		};
	}
	if (!sheetFp || !sheetFp.sys || !sheetFp.tools || !observed.sys || !observed.tools) {
		return {
			decision: "unmeasured",
			detail:
				"a resumed run is on record but one of the two fingerprints is incomplete (the log stores hashes only), so no comparison can be made",
			sheet: sheetFp,
			observed,
		};
	}
	if (sheetFp.sys === observed.sys && sheetFp.tools === observed.tools) {
		return {
			decision: "match",
			detail: `the resumed run ${newest.runId.slice(0, 8)} logged the same system and tools bytes as this worker's own run (sys ${observed.sys}, tools ${observed.tools})`,
			sheet: sheetFp,
			observed,
		};
	}
	const moved = sheetFp.sys === observed.sys ? "tools" : "sys";
	return {
		decision: "mismatch",
		detail: `the resumed run ${newest.runId.slice(0, 8)} sent DIFFERENT bytes: ${moved} ${moved === "sys" ? `${sheetFp.sys} -> ${observed.sys}` : `${sheetFp.tools} -> ${observed.tools}`}, prefixChars ${sheetFp.prefixChars} -> ${observed.prefixChars}, nTools ${sheetFp.nTools} -> ${observed.nTools} — a resume of this worker rebuilds the cached prefix, so an idle resume is COLD`,
		sheet: sheetFp,
		observed,
	};
}

/** The reuse window verdict for a settled worker, measured from its own activity
 *  stamp. `windowMs` comes from `fleet/config.json` — the single owner; null when the
 *  stamp is missing, because an unmeasured idle time cannot be called warm. */
export function windowVerdict(
	lastActivityAt: number | null,
	windowMs: number,
	now = Date.now(),
): { decision: "warm" | "past-window" | "unmeasured"; measuredMs: number | null } {
	if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt) || windowMs <= 0) {
		return { decision: "unmeasured", measuredMs: null };
	}
	const measuredMs = Math.max(0, now - lastActivityAt);
	return { decision: measuredMs <= windowMs ? "warm" : "past-window", measuredMs };
}
