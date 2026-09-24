/**
 * fleet/status — the ONLY window + status reader.
 * The reuse window comes from config.json (single owner); the worker state and
 * last-activity come from the pi-subagents status snapshot, normalized here.
 * A queued/running run is LIVE and never a resume candidate; a row that cannot be
 * measured is treated as live (no resume), which is the fail-safe direction. A run
 * whose record is absent is NOT that case: absence is reported as absence, and the
 * caller may attempt a resume and let the run's owner answer.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hookLog } from "@tinoy/pi-ext-lib";

/**
 * The agent directory THIS process runs out of: `PI_CODING_AGENT_DIR` when pi was
 * pointed at one, HOME's default otherwise — the same resolution pi itself uses for
 * its agent paths (`config.js getAgentDir`). A session running out of a copied agent
 * directory therefore reads the fleet config that directory actually holds.
 */
export const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR || join(process.env.HOME ?? "/root", ".pi/agent");

/** The installed extension's own directory: `config.json` lives here. */
export const FLEET_DIR = join(AGENT_DIR, "extensions/fleet");

/** The pi-subagents temp root, reproduced exactly as it is scoped there. */
export const SUBAGENT_TEMP_ROOT = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim()
	? resolve(process.env.PI_SUBAGENTS_TEMP_ROOT.trim())
	: join(
			tmpdir(),
			`pi-subagents-${typeof process.getuid === "function" ? `uid-${process.getuid()}` : "user"}`,
		);

/** pi-subagents' run-record root. */
const SUBAGENT_ASYNC_DIR = join(SUBAGENT_TEMP_ROOT, "async-subagent-runs");

/** pi-subagents' staged result-record root, and the two index segment names it
 *  builds paths from (`runs/background/result-files.ts`). */
export const SUBAGENT_RESULTS_DIR = join(SUBAGENT_TEMP_ROOT, "async-subagent-results");
const RESULT_INDEX_DIR = "result-index";
const RUN_INDEX_DIR = "runs";

/**
 * One `asyncSnapshot.runs[]` row, as pi-subagents REALLY emits it:
 * `{id, kind, label, state, startedAt, updatedAt, activity:{lastActivityAt}, children:[…]}`
 * — the timestamp is NESTED under `activity`, and the row carries no tokens
 * (those live in the `fleet` DTO, which has no run ids to map onto).
 */
export interface RunRow {
	id?: string;
	index?: number;
	state?: string;
	startedAt?: number;
	updatedAt?: number;
	activity?: { lastActivityAt?: number };
	/** Some rows carry the stamp flat instead of nesting it under `activity`. */
	lastActivityAt?: number;
	tokens?: { input?: number; output?: number; total?: number };
	turns?: number;
	agent?: string;
	label?: string;
	reportPath?: string;
}

/** The row's last-activity stamp, wherever pi-subagents actually put it. */
export function rowLastActivity(row: RunRow): number | null {
	const v = row.activity?.lastActivityAt ?? row.lastActivityAt ?? row.updatedAt ?? row.startedAt;
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Tokens are OPTIONAL: the snapshot rows do not carry them, so a missing count
 *  is reported as unknown rather than as a lying zero. */
export function rowTokens(row: RunRow): number | null {
	const t = row.tokens;
	if (!t) return null;
	const total = t.total ?? (t.input ?? 0) + (t.output ?? 0);
	return typeof total === "number" && Number.isFinite(total) ? total : null;
}

/**
 * The run's OWN record — `async-subagent-runs/<runId>/status.json` — retains its
 * cumulative usage (`totalTokens{input,output,total,window,windowPeak}`). This is
 * the only per-run usage source: the status snapshot rows carry no token field,
 * and pi-subagents' `fleet` DTO entries are opaque-keyed ("never a run identifier")
 * and cover only ACTIVE runs, so they cannot be attributed to a named worker.
 * `tokens` is pi-subagents' own total convention (input+output); `windowPeak` is
 * the direct context-pressure signal. Returns null when the record is absent
 * (never launched, or pruned by retention).
 */
export interface RunUsage {
	tokens: number;
	windowPeak: number | null;
	/** The run's CURRENT context fill — the newest request's prompt size, read
	 *  from the run's own transcript (`input + cacheRead`, with the run record's
	 *  `window` as the fallback when the transcript was pruned). A high-water mark
	 *  cannot fall, so it can only ever overstate what the run is actually
	 *  carrying now; the retirement model needs the live number. Null when neither
	 *  source carries one. */
	window: number | null;
	/** The model window the run was launched with (`steps[].contextLimit`) — the
	 *  denominator the fill is a fraction of. */
	contextLimit: number | null;
}

/** Bound on the transcript tail the fill read parses: a child transcript reaches
 *  megabytes and only its last usage entry matters. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

function numberOrNull(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The run's own session file, from its record: the top-level `sessionFile`, else
 *  the first step's. A resumed run appends to its lineage's file, so several runs
 *  can name ONE transcript. */
function sessionFileOf(st: { sessionFile?: unknown; steps?: unknown }): string | null {
	if (typeof st.sessionFile === "string" && st.sessionFile.length > 0) return st.sessionFile;
	const steps = Array.isArray(st.steps) ? (st.steps as Array<Record<string, unknown>>) : [];
	const step = steps.find(
		(s) => typeof s?.sessionFile === "string" && (s.sessionFile as string).length > 0,
	)?.sessionFile;
	return typeof step === "string" && step.length > 0 ? step : null;
}

/** The last `maxBytes` of a file, split into lines, with the first (mid-line)
 *  fragment dropped when the read did not start at the file's own beginning. */
function tailLines(path: string, maxBytes: number): string[] {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const start = Math.max(0, size - maxBytes);
		const buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		const lines = buf.toString("utf8").split("\n");
		if (start > 0) lines.shift();
		return lines;
	} catch {
		return [];
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/**
 * The newest request's prompt size in a run's OWN transcript: `input + cacheRead`
 * of its last usage entry. That sum is the whole request — system prompt, tools
 * and the transcript up to that point — so it is the run's current context fill,
 * and it is read per run: a resumed run shares its lineage's file, so summing
 * these across runs would multiply one turn's usage by the number of runs.
 */
function lastPromptTokens(sessionFile: string): number | null {
	const lines = tailLines(sessionFile, TRANSCRIPT_TAIL_BYTES);
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] ?? "";
		if (!line.trim()) continue;
		let entry: { message?: { usage?: Record<string, unknown> } };
		try {
			entry = JSON.parse(line) as typeof entry;
		} catch {
			continue;
		}
		const u = entry.message?.usage;
		if (!u) continue;
		const input = numberOrNull(u.input ?? u.inputTokens);
		if (input === null) continue;
		return input + (numberOrNull(u.cacheRead ?? u.cacheReadTokens) ?? 0);
	}
	return null;
}

export function runUsage(runId: string | null | undefined): RunUsage | null {
	if (!runId) return null;
	try {
		const st = JSON.parse(readFileSync(join(SUBAGENT_ASYNC_DIR, runId, "status.json"), "utf8")) as {
			totalTokens?: {
				input?: number;
				output?: number;
				total?: number;
				window?: number;
				windowPeak?: number;
			};
			sessionFile?: unknown;
			steps?: unknown;
		};
		const t = st.totalTokens;
		if (!t) return null;
		const input = numberOrNull(t.input) ?? 0;
		const output = numberOrNull(t.output) ?? 0;
		const tokens = numberOrNull(t.total) ?? input + output;
		const recordWindow = numberOrNull(t.window);
		const peak = numberOrNull(t.windowPeak) ?? recordWindow;
		const sessionFile = sessionFileOf(st);
		const window = (sessionFile ? lastPromptTokens(sessionFile) : null) ?? recordWindow;
		const steps = Array.isArray(st.steps) ? (st.steps as Array<Record<string, unknown>>) : [];
		const contextLimit =
			steps.map((s) => numberOrNull(s?.contextLimit)).find((v) => v !== null && v > 0) ?? null;
		return { tokens, windowPeak: peak, window, contextLimit };
	} catch {
		return null;
	}
}

/**
 * A worker's figures UNIONED across every run it has used: lifetime input+output
 * SPEND, the highest context window any of its runs reached, and the CURRENT fill
 * plus the model window of the latest run that reports them. A resume creates a new
 * run id, so a single-run read under-measures a worker's real burn. Returns null
 * when no run record survives (retention prunes them).
 */
export function workerUsage(runIds: (string | null | undefined)[]): {
	tokens: number;
	windowPeak: number | null;
	window: number | null;
	contextLimit: number | null;
} | null {
	let tokens = 0;
	let peak: number | null = null;
	let window: number | null = null;
	let contextLimit: number | null = null;
	let seen = false;
	for (const id of runIds) {
		const u = runUsage(id);
		if (!u) continue;
		seen = true;
		tokens += u.tokens;
		if (u.windowPeak !== null) peak = Math.max(peak ?? 0, u.windowPeak);
		// `runIds` runs oldest → newest, so the last run that reports a window is
		// the worker's live context. A union-MAX here would be the high-water mark
		// again, which is the number this field exists to replace.
		if (u.window !== null) window = u.window;
		if (u.contextLimit !== null) contextLimit = u.contextLimit;
	}
	return seen ? { tokens, windowPeak: peak, window, contextLimit } : null;
}

/**
 * The context fill as text, in the shape the parent session's own header reads:
 * `277k/1.0M (27.7%)`. Null when either half is unknown — a fill without its
 * window is not a ratio, and `?/1.0M` invites reading as a zero.
 */
export function formatContext(
	fill: number | null | undefined,
	limit: number | null | undefined,
): string | null {
	if (typeof fill !== "number" || !Number.isFinite(fill)) return null;
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return null;
	return `${shortTokens(fill)}/${shortTokens(limit)} (${((fill / limit) * 100).toFixed(1)}%)`;
}

/** pi's own footer scale: `950`, `1.2k`, `277k`, `1.0M`, `12M`. */
function shortTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/**
 * The worker's own session record path, read from its run record. Used when a
 * completion payload does not carry the child session file (pi-subagents'
 * single-run payload puts it on `results[0].sessionFile`, not at top level).
 */
export function runSessionFile(runId: string | null | undefined): string | null {
	if (!runId) return null;
	try {
		const st = JSON.parse(readFileSync(join(SUBAGENT_ASYNC_DIR, runId, "status.json"), "utf8")) as {
			sessionFile?: unknown;
			steps?: unknown;
		};
		return sessionFileOf(st);
	} catch {
		return null;
	}
}

/**
 * A run's own record, as pi-subagents' control surfaces read it. `sessionId` is the
 * PARENT SESSION FILE PATH the run was launched under (pi-subagents
 * `resolveCurrentSessionId`), and every cross-session guard compares exactly that
 * field — which is why adoption re-stamps it and nothing else.
 */
export interface RunRecord {
	runId: string;
	statusPath: string;
	resultPath: string;
	runIndexPath: string;
	state: string | null;
	sessionId: string | null;
	sessionFile: string | null;
	pid: number | null;
	cwd: string | null;
	/** Usage stamps for the reuse decision, from the same record. */
	updatedAt: number | null;
	/** When the run settled. A settled run's record carries it; a FAILED run
	 *  carries an end stamp too, but no `outputFile` and no `artifactsDir` — those
	 *  three fields are therefore all nullable and every reader states an absence
	 *  instead of rendering an empty path. */
	endedAt: number | null;
	outputFile: string | null;
	artifactsDir: string | null;
	/** The run's own usage totals, from the same record. */
	totalTokens: number | null;
	turnCount: number | null;
}

function readJsonFile(p: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function runStatusPath(runId: string): string {
	return join(SUBAGENT_ASYNC_DIR, runId, "status.json");
}

export function runResultPath(runId: string): string {
	return join(SUBAGENT_RESULTS_DIR, `${runId}.json`);
}

export function runIndexPath(runId: string): string {
	return join(SUBAGENT_RESULTS_DIR, RESULT_INDEX_DIR, RUN_INDEX_DIR, `${runId}.json`);
}

/**
 * Read a run's record. Null when the run directory is absent — the caller then
 * reports "the fleet cannot resolve this run" instead of adopting a dead pointer,
 * because a run whose record is gone cannot be steered, resumed or verified.
 */
export function readRunRecord(runId: string | null | undefined): RunRecord | null {
	if (!runId) return null;
	const statusPath = runStatusPath(runId);
	const st = readJsonFile(statusPath);
	if (!st) return null;
	const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
	const num = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) ? v : null;
	const steps = Array.isArray(st.steps) ? (st.steps as Array<Record<string, unknown>>) : [];
	const stepFile = steps.find(
		(s) => typeof s?.sessionFile === "string" && (s.sessionFile as string).length > 0,
	)?.sessionFile;
	return {
		runId,
		statusPath,
		resultPath: runResultPath(runId),
		runIndexPath: runIndexPath(runId),
		state: str(st.state),
		sessionId: str(st.sessionId),
		sessionFile: str(st.sessionFile) ?? str(stepFile),
		pid: num(st.pid),
		cwd: str(st.cwd),
		updatedAt: num(st.updatedAt) ?? num(st.finishedAt) ?? num(st.startedAt),
		endedAt: num(st.endedAt) ?? num(st.finishedAt),
		outputFile: str(st.outputFile),
		artifactsDir: str(st.artifactsDir),
		totalTokens: num((st.totalTokens as { total?: unknown } | undefined)?.total),
		turnCount: num(st.turnCount),
	};
}

/**
 * Why a run has no row, when it has none — the distinction an `assign` turns on.
 * `missing` (no status file) is an ABSENCE: it is no evidence of a live run, so a
 * resume may be attempted and pi-subagents answers. `unreadable` (a status file that
 * exists and yielded no record) is an ambiguity about a run that was there, and
 * the caller refuses on it. A null run id answers `missing`; the caller refuses on
 * the identity itself before it asks this question.
 *
 * The read is repeated here rather than carried out of `readRunRecord` because
 * only this caller needs the difference between absent and unreadable.
 */
export type RecordPresence = "present" | "missing" | "unreadable";

export function runRecordPresence(runId: string | null | undefined): RecordPresence {
	if (!runId) return "missing";
	const statusPath = runStatusPath(runId);
	if (readJsonFile(statusPath) !== null) return "present";
	return existsSync(statusPath) ? "unreadable" : "missing";
}

/**
 * What one run left behind, in the shape every crew surface reports it: the run's
 * state, its end time, and the two locations its own record carries.
 *
 * `outputFile` is the run's OWN captured output (`async-subagent-runs/<runId>/
 * output-0.log`) and `artifactsDir` is the directory holding its composed output
 * artifact (`<runId>_worker_output.md`). Neither is a report the worker AUTHORED:
 * the path a worker names in its final message is carried by no record anywhere,
 * so it cannot be promised and is not reported here.
 *
 * Both paths are existence-checked at read time — a record kept after its artifact
 * directory was pruned must not hand a successor a path that opens nothing.
 */
export interface RunOutcome {
	runId: string;
	state: string | null;
	endedAt: number | null;
	endedAtIso: string | null;
	outputFile: string | null;
	artifactsDir: string | null;
	/** The sentence a reader gets in place of the paths: what they are when they
	 *  exist, and that nothing was recorded when they do not. */
	artifactNote: string;
}

export function runOutcome(rec: RunRecord): RunOutcome {
	const outputFile = rec.outputFile && existsSync(rec.outputFile) ? rec.outputFile : null;
	const artifactsDir = rec.artifactsDir && existsSync(rec.artifactsDir) ? rec.artifactsDir : null;
	return {
		runId: rec.runId,
		state: rec.state,
		endedAt: rec.endedAt,
		endedAtIso: rec.endedAt === null ? null : new Date(rec.endedAt).toISOString(),
		outputFile,
		artifactsDir,
		artifactNote:
			outputFile || artifactsDir
				? "the run's own output log and artifact directory, as its record names them — NOT the report the worker named in its final message: no record carries that path"
				: "no artifact recorded — this run's record carries neither an output file nor an artifact directory (a run that died before writing one carries neither)",
	};
}

/**
 * The worker's LAST run, in report shape: its current handle when that record
 * resolves, else the newest record among the runs it has used (the roster keeps
 * `runIds` oldest first). Null when none of them resolves — the caller then says so
 * rather than rendering a path nobody has.
 */
export function lastRunOutcome(runIds: (string | null | undefined)[]): RunOutcome | null {
	for (let i = runIds.length - 1; i >= 0; i--) {
		const rec = readRunRecord(runIds[i]);
		if (rec) return runOutcome(rec);
	}
	return null;
}

/**
 * The worker's runs that SETTLED after `since` — newest first — which is the answer
 * to "what landed since I took this crew over?". `since` is the publishing sheet's
 * `writtenAt` (see `adopt.publishedAt`).
 *
 * Null when `since` is null: an unknown publish time cannot be compared, and a zero
 * would read as "everything landed since the epoch". An empty array is the measured
 * answer "nothing landed".
 */
export function landingsSince(
	runIds: (string | null | undefined)[],
	since: number | null,
): RunOutcome[] | null {
	if (since === null) return null;
	const out: RunOutcome[] = [];
	for (const id of runIds) {
		const rec = readRunRecord(id);
		if (!rec || rec.endedAt === null || rec.endedAt <= since) continue;
		out.push(runOutcome(rec));
	}
	return out.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
}

/** One row of the child's own cache-prefix log — the prefix fingerprint the
 *  cache miss it names was measured from. */
export interface PrefixRow {
	sess: string | null;
	pid: number | null;
	sys: string | null;
	tools: string | null;
	nTools: number | null;
	prefixChars: number | null;
	why: string | null;
	ts: string | null;
}

/**
 * The child session id a run logged under: the `id` of the `session` header line in
 * the run's OWN transcript. Head only — a child transcript reaches megabytes and the
 * header is its first line.
 */
const TRANSCRIPT_HEAD_BYTES = 8 * 1024;

function childSessionId(sessionFile: string | null): string | null {
	if (!sessionFile) return null;
	let fd: number | null = null;
	try {
		fd = openSync(sessionFile, "r");
		const buf = Buffer.alloc(TRANSCRIPT_HEAD_BYTES);
		const read = readSync(fd, buf, 0, buf.length, 0);
		for (const line of buf.subarray(0, read).toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			let d: { type?: unknown; id?: unknown };
			try {
				d = JSON.parse(line) as typeof d;
			} catch {
				continue;
			}
			if (d.type === "session" && typeof d.id === "string" && d.id) return d.id;
		}
		return null;
	} catch {
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/**
 * The cache-prefix log's rows for one RUN, oldest first: matched by the run's own
 * child-session ID or by the run's pid, because the log attributes a row to the
 * process that sent the request and a run's rows carry both.
 *
 * The id comes from the run's transcript HEAD, never from its file name: a subagent
 * transcript is always `…/<childRunId>/run-0/session.jsonl`, so a name-derived key is
 * one constant for every run and attributes no row at all.
 *
 * A cached row is matched EXACTLY. Rows written before the log key was widened to the
 * full session id carry only its first 8 characters, and a session id's first 8 hex
 * characters are the high 32 bits of its millisecond timestamp — every session started
 * inside the same ~65 s window shares them — so a prefix match would attribute another
 * session's bytes to this run. Those rows stay readable through the pid arm.
 */
export function prefixRows(sessionFile: string | null, pid: number | null, limit = 2): PrefixRow[] {
	const sess = childSessionId(sessionFile);
	if (!sess && pid === null) return [];
	const state = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "/root", ".local", "state");
	const out: PrefixRow[] = [];
	try {
		const raw = readFileSync(join(state, "pi", "cache-prefix-log.jsonl"), "utf8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let d: Record<string, unknown>;
			try {
				d = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const rowSess = typeof d.sess === "string" ? d.sess : null;
			const rowPid = typeof d.pid === "number" ? d.pid : null;
			const matches = (sess !== null && rowSess === sess) || (pid !== null && rowPid === pid);
			if (!matches) continue;
			out.push({
				sess: rowSess,
				pid: rowPid,
				sys: typeof d.sys === "string" ? d.sys : null,
				tools: typeof d.tools === "string" ? d.tools : null,
				nTools: typeof d.nTools === "number" ? d.nTools : null,
				prefixChars: typeof d.prefixChars === "number" ? d.prefixChars : null,
				why: typeof d.why === "string" ? d.why : null,
				ts: typeof d.ts === "string" ? d.ts : null,
			});
		}
	} catch {
		return [];
	}
	return out.slice(-limit);
}

/** True when the pid exists. `kill(pid, 0)`-equivalent without signalling: an
 *  unreadable /proc entry for another user's process is not this machine's case,
 *  and a missing one is the answer this is asked for. */
export function isPidAlive(pid: number | null | undefined): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		return existsSync(`/proc/${pid}`);
	} catch {
		return false;
	}
}

/**
 * A run row built from the run's OWN record rather than from pi-subagents' status
 * snapshot. The snapshot covers only the runs THIS process started, so a crew adopted
 * from a handoff has no row in it at all; the record is the only source an adopted crew
 * has, and it is the same file pi-subagents' own resume path reconciles.
 *
 * Liveness is decided from the pid, never from the record's word: a record left saying
 * `running` by a process that has since died is read as settled, which is the direction
 * that keeps a resume possible.
 */
export function rowFromRunRecord(rec: RunRecord, childIndex: number): RunRow {
	const state = (rec.state ?? "").toLowerCase();
	const claimsLive = state === "running" || state === "queued" || state === "pending";
	const live = claimsLive && isPidAlive(rec.pid);
	const last = rec.updatedAt ?? undefined;
	return {
		id: rec.runId,
		index: childIndex,
		state: live ? state : claimsLive ? "complete" : state,
		...(last !== undefined ? { updatedAt: last, activity: { lastActivityAt: last } } : {}),
	};
}

/**
 * The reuse window, from `config.json` in the fleet directory.
 *
 * The failure path RETURNS 0, which is not a window any caller can act on: every
 * settled worker then measures as outside it, so a config that cannot be read turns
 * into a wrong verdict about the whole crew rather than an error anyone can see. It
 * is logged instead of swallowed — once per config path per process, because the
 * same unreadable file would otherwise re-log on every assign, review and roster.
 */
export function loadWindowMs(dir = FLEET_DIR): number {
	const path = join(dir, "config.json");
	try {
		const cfg = JSON.parse(readFileSync(path, "utf8")) as { reuseWindowSeconds?: unknown };
		const s = cfg.reuseWindowSeconds;
		if (typeof s === "number" && Number.isFinite(s) && s > 0) return s * 1000;
		windowFault(
			path,
			`reuseWindowSeconds is not a positive number of seconds: ${JSON.stringify(s)}`,
		);
	} catch (e) {
		windowFault(path, e instanceof Error ? e.message : String(e));
	}
	return 0;
}

const windowFaultsLogged = new Set<string>();

function windowFault(path: string, reason: string): void {
	if (windowFaultsLogged.has(path)) return;
	windowFaultsLogged.add(path);
	hookLog("fleet", "reuse-window-unreadable", { path, reason });
}

/** Normalize the RPC status reply into per-run rows (asyncSnapshot preferred). */
export function normalizeRuns(statusData: unknown): RunRow[] {
	const d = statusData as
		| { asyncSnapshot?: { runs?: RunRow[] }; fleet?: { runs?: RunRow[] } }
		| undefined;
	const runs = d?.asyncSnapshot?.runs ?? d?.fleet?.runs ?? [];
	return Array.isArray(runs) ? runs : [];
}

export type WarmVerdict =
	| { kind: "warm"; measuredMs: number }
	| { kind: "past-window"; measuredMs: number }
	| { kind: "live" }
	/** No row for the run in any source: its record is ABSENT — pruned, or never
	 *  written. That is not the same verdict as an unmeasurable one, because absence
	 *  is no evidence of liveness: a cold resume is the caller's next step. */
	| { kind: "no-record" }
	/** A row exists but carries no activity stamp, so nothing about the run can be
	 *  measured. Ambiguous, and the caller refuses on it. */
	| { kind: "no-activity" };

/** The reuse decision. `nowMs` is injectable for tests. */
export function warmCheck(
	row: RunRow | undefined,
	windowMs: number,
	nowMs: number = Date.now(),
): WarmVerdict {
	if (!row) return { kind: "no-record" };
	const state = (row.state ?? "").toLowerCase();
	if (state === "queued" || state === "running" || state === "pending") return { kind: "live" };
	const last = rowLastActivity(row);
	if (last === null) return { kind: "no-activity" };
	const measured = Math.max(0, nowMs - last);
	return measured <= windowMs
		? { kind: "warm", measuredMs: measured }
		: { kind: "past-window", measuredMs: measured };
}

/** A run row that can still take a steer: queued/running/pending. */
export function isLiveRow(row: RunRow): boolean {
	const st = (row.state ?? "").toLowerCase();
	return st === "queued" || st === "running" || st === "pending";
}

/**
 * The worker state a terminal status row implies. A failed or stopped run is
 * NOT "completed": the roster must speak the same word the tool's own message
 * does, or one session reports two different outcomes for one run.
 */
export function terminalWorkerState(
	rowState: string | undefined,
): "completed" | "failed" | "stopped" | null {
	const st = (rowState ?? "").toLowerCase();
	if (st === "complete" || st === "completed") return "completed";
	if (st === "failed" || st === "stopped") return st;
	return null;
}

/**
 * The cause a failed/stopped run's OWN session record retains, in priority
 * order: the provider error on the final assistant turn, then the run's last
 * error tool result, then its last tool call. Reads the record's tail only and
 * returns null when the record is missing/unreadable or carries no failure
 * signal — callers then say the cause was not retained instead of faking one.
 */
export function runFailureCause(sessionFile: string | null | undefined): string | null {
	if (!sessionFile) return null;
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf8");
	} catch {
		return null;
	}
	let errorMessage: string | null = null;
	let stopReason: string | null = null;
	let lastErrorTool: string | null = null;
	let lastTool: string | null = null;
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		let d: { message?: Record<string, unknown> };
		try {
			d = JSON.parse(line) as { message?: Record<string, unknown> };
		} catch {
			continue;
		}
		const m = d.message;
		if (!m) continue;
		const role = m.role;
		if (role === "toolResult") {
			if (typeof m.toolName === "string") lastTool = m.toolName;
			if (m.isError === true) {
				const text = Array.isArray(m.content)
					? m.content
							.map((c) =>
								c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string"
									? (c as { text: string }).text
									: "",
							)
							.join(" ")
					: "";
				lastErrorTool = `${m.toolName ?? "tool"}: ${text.trim().slice(0, 240)}`;
			}
		} else if (role === "assistant") {
			if (typeof m.stopReason === "string") stopReason = m.stopReason;
			if (typeof m.errorMessage === "string" && m.errorMessage.trim())
				errorMessage = m.errorMessage.trim();
			if (Array.isArray(m.content)) {
				for (const c of m.content) {
					if (
						c &&
						typeof c === "object" &&
						(c as { type?: unknown }).type === "toolCall" &&
						typeof (c as { name?: unknown }).name === "string"
					)
						lastTool = (c as { name: string }).name;
				}
			}
		}
	}
	const bits: string[] = [];
	if (errorMessage) bits.push(`error: ${errorMessage.slice(0, 300)}`);
	else if (stopReason === "error" || stopReason === "aborted")
		bits.push(`run ended with stopReason '${stopReason}' (no error text retained)`);
	if (lastErrorTool) bits.push(`last failed action: ${lastErrorTool}`);
	else if (lastTool && bits.length) bits.push(`last action: '${lastTool}'`);
	return bits.length ? bits.join("; ") : null;
}

/**
 * Ids a resume reply can be naming, PRE-resume id excluded. `details.asyncId`
 * leads because that is the revived run's id in pi-subagents' own receipt
 * (`subagent-executor.ts`: `const revivedId = result.details.asyncId ?? runId`);
 * ids harvested from the receipt text follow, since a bare text id may well be
 * the run the caller passed in rather than the new one.
 */
export function adoptionCandidates(
	replyData: unknown,
	prevId: string | null,
): { structured: string[]; fromText: string[] } {
	const structured: string[] = [];
	const fromText: string[] = [];
	const seen = new Set<unknown>();
	const idLike = /^[0-9a-f-]{8,}$/i;
	const push = (into: string[], v: unknown): void => {
		if (typeof v !== "string") return;
		const s = v.trim();
		if (!idLike.test(s) || s === prevId || structured.includes(s) || fromText.includes(s)) return;
		into.push(s);
	};
	const dig = (v: unknown, depth: number): void => {
		if (depth > 4 || v === null || typeof v !== "object" || seen.has(v)) return;
		seen.add(v);
		const rec = v as Record<string, unknown>;
		for (const k of ["asyncId", "asyncRunId", "runId", "id"]) push(structured, rec[k]);
		for (const val of Object.values(rec)) dig(val, depth + 1);
	};
	dig(replyData, 0);
	const text =
		typeof replyData === "object" && replyData !== null
			? String((replyData as { text?: unknown }).text ?? "")
			: "";
	for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi))
		push(fromText, m[0]);
	return { structured, fromText };
}

/** Live, id-bearing rows that are absent from `before` and not excluded. */
export function newLiveRows(
	rows: RunRow[],
	exclude: (string | null | undefined)[],
	before: RunRow[],
): RunRow[] {
	const ex = new Set(exclude.filter((x): x is string => typeof x === "string"));
	const old = new Set(before.map((b) => b.id).filter((x): x is string => typeof x === "string"));
	return rows.filter(
		(r) => typeof r.id === "string" && !ex.has(r.id) && !old.has(r.id) && isLiveRow(r),
	);
}

/**
 * Why a resume failed — the distinction a sticky verdict depends on. pi-subagents
 * refuses a resume of a RUNNING child ("is still running"), which is transient:
 * the run is resumable the moment it settles. Only a verdict about the run
 * itself (no persisted session to continue) may mark a worker `not-resumable`,
 * and an unrecognised error stays transient too, so an unknown failure can never
 * strand a healthy worker.
 */
export type ResumeFailure = "busy" | "no-session" | "transient";

export function resumeFailureKind(
	error: { code?: string; message?: string } | undefined,
): ResumeFailure {
	const m = (error?.message ?? "").toLowerCase();
	if (/still running|is running|still queued|pending|not running or queued|busy|in flight/.test(m))
		return "busy";
	if (
		/persisted session|no child session|cannot be resumed|not resumable|non-resumable|resume unavailable/.test(
			m,
		)
	)
		return "no-session";
	return "transient";
}

export function human(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m${String(s % 60).padStart(2, "0")}s`;
}
