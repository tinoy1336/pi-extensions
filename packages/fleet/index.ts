/**
 * fleet — the multi-worker fleet tool (foreman mode only).
 *
 * One action-style tool that REPLACES the raw `subagent` tool while foreman mode
 * is on: every crew action is addressed by WORKER NAME (the tool owns the
 * name -> async-run-id map), idle time is measured and the warm-reuse decision is
 * made HERE (never by the model), task text is serialized by the tool (no
 * template literals), ownership/exclusivity claims are checked, retirement is a
 * state transition, and reviews go to a warm non-author crew member.
 *
 * Every launch is async and `context: "fresh"` (launch.ts is the only caller and
 * carries no fork path). Activation is the `PI_FOREMAN=1` marker the launcher sets,
 * read at `session_start` — the `/foreman` activation command is retired — plus a
 * per-call mode read, fail-safe ordered: a failed activation leaves the previous
 * tool set in place and the mode OFF. A non-foreman session DOES have its tool set
 * touched: the tool is registered in every session, so `session_start` removes
 * `fleet` from the active set unless that session's own mode file says ON. Nothing
 * else in the set is touched, and a session whose mode file says ON, or whose
 * process carries the marker, arms the fixed foreman set. The one mode command left
 * is `/foreman-off`, the escape from a session that is already armed.
 */
import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { argText, clip, type HeaderPart, hookLog, safeToolHeader } from "@tinoy/pi-ext-lib";
import { ioRoot, readClaim, writeClaim } from "@tinoy/pi-io-guard/claims.ts";
import { identityClaimLive } from "@tinoy/pi-io-guard/identity.ts";
import { Type } from "typebox";
import * as adopt from "./adopt.ts";
import * as board from "./board.ts";
import * as items from "./items.ts";
import { classify, rpc, spawnParams } from "./launch.ts";
import * as mode from "./mode.ts";
import {
	claimConflict,
	clampTimeout,
	isIdLike,
	isNameLike,
	normalizeExclusive,
	normalizeOwns,
	notANameMessage,
	openBoardRowsMessage,
	retireDisposition,
	reviewEligible,
	runProvablyGone,
	serializeTask,
} from "./predicates.ts";
import { releaseClaim } from "./release.ts";
import * as retire from "./retire.ts";
import * as roster from "./roster.ts";
import { FOREMAN_SECTION } from "./section.ts";
import {
	adoptionCandidates,
	formatContext,
	human,
	isLiveRow,
	landingsSince,
	lastRunOutcome,
	loadWindowMs,
	newLiveRows,
	normalizeRuns,
	prefixRows,
	type RunOutcome,
	type RunRow,
	readRunRecord,
	resumeFailureKind,
	rowFromRunRecord,
	rowLastActivity,
	rowTokens,
	runFailureCause,
	runRecordPresence,
	runSessionFile,
	runStatusPath,
	runUsage,
	terminalWorkerState,
	warmCheck,
	workerUsage,
} from "./status.ts";

const FATIGUE_TOKENS = 800_000;

/** The clock-out steer text. The worker's OWN context figure is substituted, so
 *  the one fact the message exists to carry (how far in it is) is never a
 *  literal `<N>`. */
function clockOutMessage(contextK: number | null): string {
	const lead = contextK === null ? "context budget unknown" : `context at ${contextK}k`;
	return `${lead} — clock out now: read ~/.local/pi/foreman/clockout.md and follow it exactly`;
}

interface Ctx {
	sessionManager?: {
		getSessionId?: () => string;
		/** The session FILE path — the identity pi-subagents stamps on a run and
		 *  compares on every control surface. Adoption re-stamps to exactly this. */
		getSessionFile?: () => string | undefined;
		/** Context entries on the active branch — sizes the mid-session re-bill. */
		buildContextEntries?: () => unknown[];
	};
	ui?: {
		notify?: (message: string, level?: "info" | "warning" | "error") => void;
	};
	/** Present on a command context; absent when the harness does not supply it. */
	waitForIdle?: () => Promise<void>;
}

function json(o: unknown): string {
	return JSON.stringify(o, null, 2);
}

function ok(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

/** The tool's own session id + setActiveTools surface. */
/** Publish this worker's current ownership as the claim record the io guard
 *  enforces. The generation is preserved from the existing record, so an ordinary
 *  hire or assign never invalidates a worker that is already running; only an
 *  explicit reclaim bumps it. */
function syncClaim(
	session: string,
	name: string,
	scope: string,
	owns: string[],
	exclusive: string[],
): void {
	try {
		const prev = readClaim(ioRoot(), name);
		writeClaim(
			ioRoot(),
			{ worker: name, sessionId: session, scope, owns, exclusive },
			prev?.generation ?? 0,
		);
	} catch {
		/* the guard fails closed on a missing claim rather than the dispatcher failing here */
	}
}

function sid(ctx: Ctx): string {
	return ctx?.sessionManager?.getSessionId?.() ?? "unknown-session";
}

/**
 * The identity pi-subagents compares on every guard: the session FILE path when there
 * is one, the session id otherwise — the same expression as pi-subagents'
 * `resolveCurrentSessionId`. Adoption stamps exactly this value onto an adopted run,
 * so the successor's own control calls pass pi-subagents' check by construction.
 */
function sessionIdentity(ctx: Ctx): string {
	return ctx?.sessionManager?.getSessionFile?.() ?? sid(ctx);
}

export default function (pi: ExtensionAPI): void {
	roster.prune();
	mode.pruneOld();
	items.pruneOldLedgers();
	let turnId = 0;
	let lastActedTurn = -1;
	/** False between session_shutdown and the next session_start: late async
	 *  callbacks must never touch a stale extension ctx (V5). */
	let alive = true;
	let crewCtx: Ctx | undefined;
	/** The last status rows seen (for idle measurement + reconciliation). */
	let lastRows: RunRow[] = [];

	const toolSet = {
		getActiveTools: (): string[] =>
			(pi as unknown as { getActiveTools(): string[] }).getActiveTools(),
		setActiveTools: (n: string[]): void =>
			(pi as unknown as { setActiveTools(x: string[]): void }).setActiveTools(n),
		getAllTools: (): { name: string }[] =>
			(pi as unknown as { getAllTools?: () => { name: string }[] }).getAllTools?.() ?? [],
	};

	/**
	 * Tell canon, which owns the system-prompt tail, whether this session's discipline
	 * section belongs in it. It is not appended from here: two normalizers that each
	 * strip and append would emit order-dependent bytes, and one changed byte in the
	 * system prompt re-bills the tool array and the whole conversation after it.
	 *
	 * The handoff crosses the extension event bus because pi evaluates every extension
	 * in its own jiti instance (`moduleCache: false`), so importing canon's registry
	 * would write into a copy nothing renders from. The bus delivers a handler's
	 * synchronous part before `emit` returns, so a section set before the first prompt
	 * is composed is already in the request that follows it.
	 *
	 * Announced UNCONDITIONALLY, on every transition AND on every `session_start`:
	 * canon discards an unchanged section, so repeating is free, while remembering
	 * locally that "we already announced" would silently lose the section whenever
	 * canon's registry is rebuilt under a process that still claims to have spoken.
	 */
	function setForemanSection(on: boolean): void {
		(pi as unknown as { events?: { emit: (e: string, p: unknown) => void } }).events?.emit(
			"canon:section",
			{
				id: "foreman",
				text: on ? FOREMAN_SECTION : "",
			},
		);
	}

	/** The complete action vocabulary. ONE list, read by both the tool's schema and
	 *  the early guard, so an action cannot be accepted by one and rejected by the
	 *  other. */
	const ACTIONS = [
		"roster",
		"hire",
		"assign",
		"steer",
		"retire",
		"review",
		"items",
		"handoff",
		"adopt",
	] as const;

	/**
	 * The set activation actually applied (already filtered to what this process has
	 * registered). Kept so the frozen set can be ENFORCED later, not merely applied once.
	 */
	let appliedSet: string[] = [];

	/**
	 * THE FROZEN SET IS AN INVARIANT, NOT A STARTING STATE — enforced here, at the last
	 * point before the payload is sent.
	 *
	 * Activation applies the fourteen once, but another extension can register tools
	 * later in the session (context-mode does exactly that: lazily, from its own
	 * `before_agent_start` handler), and pi APPENDS a newly registered tool to the
	 * active set. That silently rewrites the tool array, which sits BEFORE the messages
	 * in the byte-compared prefix, so the whole conversation behind it re-bills.
	 * Measured on a live session: one such event re-sent 821k characters — about 205k
	 * tokens — for eleven ctx_* tools nobody asked the foreman to have.
	 *
	 * Filtering the payload, rather than only re-applying the set, is deliberate: the
	 * payload IS the bytes, so this holds even for a request already in flight, and the
	 * kept tools retain the order they already had, which is what makes the array
	 * byte-identical to the requests made before the intrusion.
	 */
	pi.on("before_provider_request", (event, ctx) => {
		try {
			if (appliedSet.length === 0) return undefined;
			if (!mode.isOn(sid(ctx))) return undefined;
			const payload = (event as { payload?: { tools?: unknown } })?.payload;
			if (!payload || !Array.isArray(payload.tools)) return undefined;
			const tools = payload.tools as Array<{ name?: unknown; function?: { name?: unknown } }>;
			const nameOf = (t: { name?: unknown; function?: { name?: unknown } }): string =>
				typeof t?.function?.name === "string"
					? t.function.name
					: typeof t?.name === "string"
						? t.name
						: "";
			// Allowed by DEFINITION, never by the activation snapshot. A tool that belongs
			// in the fourteen but only registered AFTER activation must be admitted, not
			// filtered away — `subagent_supervisor` does exactly that (observed live: a
			// re-armed session applied twelve tools and the foreman lost the reply channel
			// for its workers), and freezing the snapshot would have made that permanent.
			// What is frozen is the SET DEFINITION; only tools outside it are dropped, which
			// is what stops the lazily registered ctx_* family reappearing.
			const kept = tools.filter((t) =>
				(mode.FOREMAN_TOOLS as readonly string[]).includes(nameOf(t)),
			);
			if (kept.length !== tools.length) payload.tools = kept;
		} catch {
			/* an enforcement fault must never break a request */
		}
		return undefined;
	});

	/**
	 * And the harness's own view is pulled back into line whenever it has drifted, so the
	 * registry cannot keep re-growing the set behind the filter above.
	 */
	pi.on("tool_call", (_e: unknown, ctx: Ctx) => {
		try {
			if (appliedSet.length === 0) return undefined;
			const active = toolSet.getActiveTools();
			// Removes STRAYS only. It must never strip a legitimate member of the fourteen
			// that arrived late, nor force the exact activation snapshot back — that would
			// re-create the missing-tool hole the payload filter exists to avoid.
			//
			// Loader tools are the one exception, and the exception is the point. Another
			// extension re-adds its loader at the start of every run (the `*_enable` tools),
			// and pi renders one prompt bullet per selected tool. Removing a loader here
			// leaves the active set without it while the `tools` section recorded in the
			// transcript still has it, so the NEXT run's render disagrees with that record:
			// a typed run regains the bullet (the owning extension pushes the loader back
			// into the run's selection) and a wake, which fires no `before_agent_start`,
			// sends it missing. Either direction moves the head of the system prompt, and a
			// head that moves re-bills the whole conversation behind it. Loaders stay
			// selected; the filter, not this handler, is what keeps them uncallable.
			const allowedHere = (n: string): boolean =>
				(mode.FOREMAN_TOOLS as readonly string[]).includes(n) || n.endsWith("_enable");
			const strays = active.filter((n) => !allowedHere(n));
			if (strays.length > 0 && mode.isOn(sid(ctx))) {
				toolSet.setActiveTools(active.filter(allowedHere));
			}
		} catch {
			/* same: never break a call over bookkeeping */
		}
		return undefined;
	});

	const refuse = (action: string, message: string) =>
		ok(json({ ok: false, action, refused: true, message }), { ok: false, action, message });

	async function statusRows(): Promise<RunRow[]> {
		const r = await rpc(pi, "status", {});
		const rows = r.ok ? normalizeRuns(r.data) : [];
		// pi-subagents' snapshot is its own in-memory view and covers only the runs THIS
		// process started, so an adopted crew has no row in it — which used to leave every
		// adopted worker unverifiable (`warmCheck` reported no row, and no resume
		// followed). The
		// runs' own records are the second source: they are what pi-subagents' resume path
		// reconciles, and they are on disk under this machine's subagents temp root.
		const session = crewCtx?.sessionManager?.getSessionId?.();
		if (session) {
			const known = new Set(
				rows.map((x) => x.id).filter((x): x is string => typeof x === "string"),
			);
			for (const w of roster.load(session).crew) {
				if (!w.asyncRunId || known.has(w.asyncRunId)) continue;
				const rec = readRunRecord(w.asyncRunId);
				if (rec) rows.push(rowFromRunRecord(rec, w.childIndex));
			}
		}
		lastRows = rows;
		return rows;
	}

	function rowFor(w: roster.Worker): RunRow | undefined {
		return lastRows.find((r) => r.id === w.asyncRunId);
	}

	async function doAction(action: string, args: Record<string, unknown>, ctx: Ctx) {
		const session = sid(ctx);
		if (!mode.isOn(session)) {
			return refuse(
				action,
				"fleet is inactive — not a foreman session. Use subagent, or start a foreman with the pi-foreman launcher.",
			);
		}
		// Named before any worker resolution: an unknown action would otherwise be
		// answered by whichever guard happens to run first, and "nonsense needs name"
		// tells the caller nothing true about what went wrong.
		if (!(ACTIONS as readonly string[]).includes(action)) {
			return refuse(action, `unknown action '${action}'. Known actions: ${ACTIONS.join(", ")}.`);
		}
		if (lastActedTurn === turnId) {
			return refuse(
				action,
				`one fleet action per turn; ${action} is already in flight this turn (turn ${turnId}).`,
			);
		}
		lastActedTurn = turnId;

		const r = roster.load(session);
		const name = typeof args.name === "string" ? args.name : undefined;

		// ── roster ──
		if (action === "roster") {
			// A previous session's crew record is neither addressable nor reportable:
			// remove it silently (best-effort) before answering — a live foreman
			// session's own record is kept.
			roster.cleanupForeign(session);
			const rows = await statusRows();
			// Reconcile: a completed/failed/stopped run flips the worker's state
			// (`retiring` becomes `retired`), so retirement never waits on a steer.
			let changed = false;
			// Workers that settled as `retired` in this call: a retired worker can no
			// longer close its own board rows, so they are closed below.
			const boardRetirements: roster.Worker[] = [];
			// A worker whose post-resume handle could not be reconciled retries here:
			// the live row that no other crew member claims is its new run.
			for (const w of r.crew) {
				if (!w.handleUnverified) continue;
				const others = r.crew.filter((c) => c !== w).map((c) => c.asyncRunId);
				const born = newLiveRows(rows, [w.asyncRunId, ...others], []);
				if (born.length === 1 && typeof born[0].id === "string") {
					w.asyncRunId = born[0].id;
					w.childIndex = typeof born[0].index === "number" ? born[0].index : w.childIndex;
					w.handleUnverified = false;
					changed = true;
				}
			}
			for (const w of r.crew) {
				const row = rows.find((x) => x.id === w.asyncRunId);
				if (!row) continue;
				// A handed-off worker is the successor's now: no reconcile here may rewrite
				// its state, because this session no longer owns the handoff record.
				if (w.state === "handed-off") continue;
				if (typeof row.lastActivityAt === "number") w.lastActivityAt = row.lastActivityAt;
				const term = terminalWorkerState(row.state);
				if (term !== null && w.state === "retiring") {
					releaseClaim(ioRoot(), w);
					boardRetirements.push(w);
					changed = true;
				} else if (term !== null && (w.state === "live" || w.state === "idle")) {
					// The vocabulary matches the run's real outcome: a failed run is
					// reported as failed, never rounded up to `completed`.
					w.state = term;
					changed = true;
				} else if (isLiveRow(row)) {
					if (w.state !== "retiring") w.state = "live";
				}
				// A `not-resumable` verdict is cleared the moment a fresh reconcile can
				// see the run, unless pi-subagents' own reason was structural (nothing to
				// continue). A transient refusal is never recorded, and an unknown one
				// is not a death sentence: the state must not outlive its evidence.
				if (
					w.state === "not-resumable" &&
					resumeFailureKind({ message: w.notResumableReason ?? "" }) !== "no-session"
				) {
					w.state = term ?? (isLiveRow(row) ? "live" : "completed");
					w.notResumableReason = null;
					changed = true;
				}
			}
			// A worker whose run the machine destroyed holds its claim for nobody: no row,
			// no surviving record, no process. Release it before the rows are rendered, and
			// close the board rows the retirement leaves behind.
			const released = releaseGoneRuns(r, rows);
			if (released.length) {
				boardRetirements.push(...released);
				changed = true;
			}
			if (changed) roster.save(r);
			const boardOut = closeBoardRows(r, boardRetirements);
			const crewOut = r.crew.map((w) => {
				const row = rows.find((x) => x.id === w.asyncRunId);
				trackRun(w);
				// The worker's figures UNION across every run it has used, so a resume
				// never resets its fatigue evidence; the snapshot row never carries
				// tokens, so it is only a last-resort source.
				const usage = workerUsage(w.runIds);
				const tokens = usage?.tokens ?? (row ? rowTokens(row) : null);
				const contextFill = usage?.window ?? null;
				const contextLimit = usage?.contextLimit ?? null;
				const last = row ? rowLastActivity(row) : null;
				const landings = landingsReport(w);
				return {
					name: w.name,
					state: w.state,
					scope: w.scope,
					// Measured from the STATUS row when it is known (the roster's own
					// stamp is only "time since hire"); null = unknown, not zero.
					idleSeconds: last !== null ? Math.max(0, Math.round((Date.now() - last) / 1000)) : null,
					// Cumulative SPEND over every run this identity has used (uncached input
					// + output, cache reads excluded) — a burn figure, never a size, and it
					// never falls because a resume adds a run.
					spentTokens: tokens ?? null,
					// What the worker is carrying NOW: the newest request's prompt size
					// (`input + cacheRead`) over the model window its newest run was
					// launched with, in the parent header's own shape `277k/1.0M (27.7%)`.
					context: formatContext(contextFill, contextLimit),
					contextFill,
					contextLimit,
					// A HIGH-WATER MARK, not current usage: the largest single request any
					// of the worker's runs ever sent. It cannot fall, so a compacted worker
					// stays peaked — compare `context` above against the window instead.
					contextHighWater: usage?.windowPeak ?? null,
					// An unknown spent-token count cannot be called non-fatigued. The basis
					// is stated in the output so the flag is never read as a context rule:
					// fatigue keys on the SPEND figure, on the configured 800k rule (never
					// silently rescoped).
					fatigue: tokens === null ? null : tokens >= FATIGUE_TOKENS,
					fatigueBasis: `spentTokens >= ${FATIGUE_TOKENS}`,
					owns: w.owns,
					exclusive: w.exclusive,
					authored: w.authored,
					...(w.reportPath ? { reportPath: w.reportPath } : {}),
					// What the worker's LAST run left behind — state, end time and the two
					// locations its own record carries — plus what settled after the handoff
					// that published this crew, recomputed on every pass. Neither is a report
					// the worker authored: `lastRun.outputFile` is the run's own output log and
					// `artifactsDir` the directory holding its composed output artifact, and the
					// field says so.
					...lastRunField(w),
					...(landings ? { landedSincePublish: landings } : {}),
					...(tokens === null
						? {
								spentTokensUnavailable:
									"no run record survived for this worker (async-subagent-runs/<runId>/status.json absent or pruned); the status snapshot carries no spent-token counts",
							}
						: {}),
					...(w.notResumableReason ? { notResumableReason: w.notResumableReason } : {}),
					// A failed/stopped run must never surface as a bare word: the captured
					// cause when the completion event recorded one, else an explicit
					// "not captured" so the foreman knows the limit, not a fake reason.
					...(w.failure
						? { failure: w.failure }
						: w.state === "failed" || w.state === "stopped"
							? {
									failure: {
										status: w.state,
										reason:
											"cause not captured — the harness retained no completion record for this run",
									},
								}
							: {}),
					nextLegalActions: nextLegal(w),
				};
			});
			roster.save(r);
			return ok(
				json({
					ok: true,
					action,
					crew: crewOut,
					...(boardOut.length ? { board: boardOut } : {}),
					...(released.length ? { released: released.map((w) => w.name) } : {}),
					notice: crewOut.length ? undefined : "no crew yet; next legal action: hire",
				}),
				{ ok: true, action, crew: crewOut, ...(boardOut.length ? { board: boardOut } : {}) },
			);
		}

		// ── hire ──
		if (action === "hire") {
			const scope = typeof args.scope === "string" ? args.scope.trim() : "";
			if (!scope)
				return refuse(
					action,
					"hire needs scope — one coherent slice (subsystem, research domain, file family).",
				);
			const decl = declared(args);
			if (decl.error) return refuse(action, decl.error);
			const timeoutErr = clampTimeout(args.timeoutMs as number | undefined);
			if (timeoutErr) return refuse(action, timeoutErr);
			const artErr = artifactsOk(args.artifacts);
			if (artErr) return refuse(action, artErr);
			// The caller's name is honoured or refused, never silently replaced: an id is not
			// a worker name anywhere else in the tool, so it is not one here either.
			if (name && isIdLike(name)) {
				return refuse(
					action,
					"fleet addresses workers by NAME. That is an async run id — omit name to take the next unused pool name, or give the worker a name of its own.",
				);
			}
			// A name is not only an identifier the crew's layers key on — it is also the
			// worker's handoff filename component (`<handoff dir>/<name>.md`), so the shape
			// is refused where a name is ACCEPTED, before a roster entry or a claim exists
			// for it. An id is not a name, and neither is a slash, a space or an extension.
			if (name && !isNameLike(name)) return refuse(action, notANameMessage(name));
			// ONE name addresses ONE worker. The crew is what reviews, steering, claims and
			// the board all key on, and `roster.find` answers with whichever entry sits
			// first, so a second entry under a name in use leaves the other addressable
			// only by accident.
			const existing = name ? roster.find(r, name) : undefined;
			if (existing) {
				// A retired/handed-off record KEEPS its name, so "retire it and hire again"
				// would refuse a second time: only a different name reaches a fresh worker.
				const stillAssignable =
					existing.state !== "retired" &&
					existing.state !== "handed-off" &&
					existing.state !== "not-resumable";
				return refuse(
					action,
					`'${existing.name}' is already in this crew (${existing.state}, hired for '${existing.scope}') — one name addresses one worker. ` +
						(stillAssignable
							? `Assign ${existing.name} if the work belongs to its scope, or hire under a different name (omit name to take the next unused pool name).`
							: `Its record keeps the name, so hire under a different one: omit name to take the next unused pool name.`),
				);
			}
			const workerName = name ? name : roster.nextName(r);
			// V6: validate the CALLER's task shape first — prepending the protocol
			// line must never make an invalid shape valid.
			const callerTask = serializeTask(args.task);
			if (!callerTask.ok) return refuse(action, callerTask.message);
			const task = { ok: true as const, text: prependProtocol(args, workerName, callerTask.text) };
			// A claim held by a worker the reboot destroyed refuses this hire for ownership
			// nobody holds. Release those FIRST, so the overlap check below judges the
			// claims that are really live.
			const released = releaseGoneRuns(r, await statusRows());
			if (released.length) roster.save(r);
			const conflict = claimConflict(roster.claims(r), decl.owns);
			if (conflict) return refuse(action, overlapMessage(decl.owns, conflict));
			const xconf = claimConflict(
				roster.claims(r).filter((c) => c.path.startsWith("exclusive:")),
				decl.exclusive.map((t) => `exclusive:${t}`),
			);
			if (xconf)
				return refuse(
					action,
					`refused: '${xconf.path.replace("exclusive:", "")}' is held by ${xconf.owner} (claim age ${human(Date.now() - xconf.since)}).`,
				);

			const worker = roster.newWorker(workerName, scope);
			worker.owns = decl.owns;
			worker.exclusive = decl.exclusive;
			worker.exclusiveDeclared = true;
			worker.authored = [...new Set([scope, ...decl.owns])];
			// Publish ownership BEFORE the worker starts, so its very first write is
			// checked against the claim the dispatcher intended.
			syncClaim(session, workerName, scope, decl.owns, decl.exclusive);
			const reply = await rpc(
				pi,
				"spawn",
				spawnParams(task.text, (args.timeoutMs as number) ?? 43_200_000, {
					worker: workerName,
					scope,
					owns: decl.owns,
					exclusive: decl.exclusive,
				}),
				30_000,
			);
			if (!reply.ok) {
				const fault = classify(reply, 30_000);
				return ok(
					json({
						ok: false,
						action,
						fault: fault.kind,
						message: `spawn failed [${fault.kind}]: ${fault.detail}`,
					}),
					{ ok: false, action },
				);
			}
			const handle = runIdOf(reply.data);
			worker.asyncRunId = handle.id;
			worker.childIndex = childIndexOf(reply.data);
			trackRun(worker);
			if (!handle.id) {
				r.crew.push(worker);
				roster.save(r);
				return ok(
					json({
						ok: false,
						action,
						fault: "receipt-unparsed",
						worker: worker.name,
						message: `spawn answered but the run handle could not be parsed — the worker is recorded WITHOUT a handle and cannot be assigned. Raw receipt: ${handle.excerpt}`,
					}),
					{ ok: false, action },
				);
			}
			r.crew.push(worker);
			roster.save(r);
			return ok(
				json({
					ok: true,
					action,
					worker: worker.name,
					handle: { asyncRunId: worker.asyncRunId, childIndex: worker.childIndex },
					scope: worker.scope,
					reuse: { decision: "none" },
					claims: { owns: worker.owns, exclusive: worker.exclusive },
					nextLegalActions: nextLegal(worker),
				}),
				{ ok: true, action, worker: worker.name },
			);
		}

		// ── review ──
		if (action === "review") {
			const target = typeof args.target === "string" ? args.target.trim() : "";
			if (!target)
				return refuse(
					action,
					"review needs target:'<scope-or-path>' — the non-author check runs against it.",
				);
			// A reviewer passed by NAME is checked against authorship BEFORE any
			// resolve or resume: the author of the target is never a legal reviewer,
			// named or auto-resolved.
			if (name) {
				const named = roster.find(r, name);
				if (!named)
					return refuse(
						action,
						`unknown worker '${name}'. live crew: ${r.crew.map((c) => c.name).join(", ") || "(none)"}.`,
					);
				const own = reviewEligible(named, target);
				if (!own.ok) {
					return refuse(
						action,
						own.reason === "author"
							? `${name} authored '${target}' — the non-author rule forbids a worker reviewing its own work. Omit name to let the tool resolve a non-author reviewer, or hire a replacement worker.`
							: `${name} is ${named.state} — not an available reviewer.`,
					);
				}
			}
			await statusRows();
			const eligible = r.crew.filter((c) => reviewEligible(c, target).ok);
			const verdictFor = (c: roster.Worker) =>
				warmCheck(
					lastRows.find((x) => x.id === c.asyncRunId),
					loadWindowMs(),
				);
			let pick: roster.Worker | undefined;
			if (name) {
				// A caller-named, already-validated NON-author is authoritative: the
				// explicit choice beats the warm heuristic (auto-resolve is only the
				// fallback when no name is given). Only the settled guard applies — a
				// live run cannot be resumed, however it was named.
				pick = roster.find(r, name);
				if (pick && verdictFor(pick).kind === "live") {
					return refuse(
						action,
						`${name} is live (running/queued) — review needs a SETTLED reviewer. Its completion notice arrives on its own; re-run review when it lands. Its state is untouched by this refusal.`,
					);
				}
			} else {
				const scored = eligible.map((c) => ({ c, v: verdictFor(c) }));
				// The same live-state guard `assign` applies, for the same reason: the
				// owner refuses a resume of a RUNNING child, so a review must never treat
				// a live worker as a resume candidate (that refusal once marked a healthy
				// reviewer not-resumable). Only settled workers are candidates here.
				const settled = scored.filter((e) => e.v.kind !== "live");
				const warm = settled
					.filter((e) => e.v.kind === "warm")
					.sort(
						(a, b) =>
							(a.v as { measuredMs: number }).measuredMs -
							(b.v as { measuredMs: number }).measuredMs,
					);
				pick = warm[0]?.c ?? settled[0]?.c;
				if (!pick) {
					const live = scored.filter((e) => e.v.kind === "live").map((e) => e.c.name);
					if (live.length) {
						return refuse(
							action,
							`review needs a SETTLED reviewer: ${live.join(", ")} ${live.length === 1 ? "is" : "are"} live (running/queued). ${live.length === 1 ? "Its completion notice arrives" : "Their completion notices arrive"} on their own; re-run review then — a running worker is steered, never resumed, and its state is untouched by this refusal.`,
						);
					}
					return refuse(
						action,
						`no eligible reviewer: ${r.crew.map((c) => `${c.name} ${reviewEligible(c, target).ok ? "eligible" : (reviewEligible(c, target) as { reason: string }).reason}`).join("; ") || "no crew"}. Hire a replacement worker, then re-run review.`,
					);
				}
			}
			if (!pick)
				return refuse(
					action,
					`unknown worker '${name}'. live crew: ${r.crew.map((c) => c.name).join(", ") || "(none)"}.`,
				);
			const task = serializeTask([
				"Independent review pass — you did not author this.",
				`target: ${target}`,
				...(Array.isArray(args.task) ? (args.task as string[]) : []),
			]);
			if (!task.ok) return refuse(action, task.message);
			const verdict = verdictFor(pick);
			// Same resume envelope as assign: the reviewer keeps its crew name.
			const reply = await rpc(pi, "resume", {
				id: pick.asyncRunId,
				index: pick.childIndex,
				label: pick.name,
				message: `read ~/.local/pi/foreman/worker.md and follow it\n${task.text}`,
			});
			if (!reply.ok) {
				const kind = resumeFailureKind(reply.error);
				if (kind === "no-session") {
					pick.state = "not-resumable";
					pick.notResumableReason = reply.error?.message ?? "unknown";
					roster.save(r);
					return ok(
						json({
							ok: false,
							action,
							worker: pick.name,
							message: `review resume failed (${pick.name} marked not-resumable): ${pick.notResumableReason}`,
						}),
						{ ok: false, action },
					);
				}
				// busy/unknown: a refusal, NOT a verdict about the worker — its state
				// stays exactly as it was.
				return ok(
					json({
						ok: false,
						action,
						worker: pick.name,
						reuse: { decision: "refused", reason: kind },
						message: `review resume refused [${kind}]: ${reply.error?.message ?? "unknown"} — ${pick.name}'s state is unchanged; settle the run and re-run review.`,
					}),
					{ ok: false, action, worker: pick.name },
				);
			}
			const adopted = await adoptResumedHandle(pick, reply.data, lastRows);
			if (adopted) {
				pick.asyncRunId = adopted.id;
				pick.childIndex = adopted.index;
				pick.handleUnverified = false;
				trackRun(pick);
			} else {
				pick.handleUnverified = true;
			}
			pick.state = "live";
			pick.notResumableReason = null;
			pick.lastActivityAt = Date.now();
			roster.save(r);
			return ok(
				json({
					ok: true,
					action,
					worker: pick.name,
					target,
					reuse: {
						decision: verdict.kind === "warm" ? "warm-resume" : "cold-resume",
						measured:
							verdict.kind === "warm" || verdict.kind === "past-window"
								? human((verdict as { measuredMs: number }).measuredMs)
								: verdict.kind === "no-record"
									? "unmeasured (no status record for the run)"
									: "unmeasured (no activity stamp in the status row)",
					},
					handle: { asyncRunId: pick.asyncRunId, childIndex: pick.childIndex },
					handleAdopted: adopted ? adopted.source : "unverified",
					notice: "review never spawns a fresh worker.",
					nextLegalActions: nextLegal(pick),
				}),
				{ ok: true, action, worker: pick.name },
			);
		}

		// ── items (the foreman's own ledger) ──
		// The ledger is the foreman's working memory: it survives a compaction and a
		// resume, which the todo board does not, because the board belongs to the
		// workers and is rebuilt from the session branch. It is reached through THIS
		// tool rather than a new one because the foreman's tool array is frozen at
		// activation — adding a tool mid-session re-bills the whole conversation.
		if (action === "items") {
			const session = sid(ctx);
			const op = typeof args.op === "string" ? args.op.trim().toLowerCase() : "list";
			if (op === "list") {
				const want =
					typeof args.state === "string" ? (args.state.trim() as items.ItemState) : undefined;
				const rows = items.listItems(session, want);
				return ok(
					json({ ok: true, action, op, count: rows.length, items: rows.map(items.renderItem) }),
					{
						ok: true,
						action,
						count: rows.length,
					},
				);
			}
			if (op === "add") {
				const text = typeof args.itemText === "string" ? args.itemText.trim() : "";
				if (!text) return refuse(action, "items add needs itemText — one line naming the item.");
				const scope = typeof args.scope === "string" ? args.scope.trim() : "";
				if (!scope) return refuse(action, "items add needs scope — the slice the item belongs to.");
				// The claim rules come from the same predicates the crew uses, so the
				// ledger cannot record a claim the launch path would refuse.
				const owns = normalizeOwns(Array.isArray(args.owns) ? (args.owns as string[]) : []);
				if (!owns.ok) return refuse(action, owns.message);
				const exclusive = normalizeExclusive(
					Array.isArray(args.exclusive) ? (args.exclusive as string[]) : [],
				);
				if (!exclusive.ok) return refuse(action, exclusive.message);
				// An item with NO claim at all is not an item: a claim is part of
				// its definition, and this is the same helper hire/assign refuse through.
				const decl = declared(args);
				if (decl.error) return refuse(action, decl.error);
				const item = items.addItem(session, {
					text,
					scope,
					...(typeof args.name === "string" && args.name.trim()
						? { worker: args.name.trim() }
						: {}),
					...(typeof args.state === "string" && args.state.trim()
						? { state: args.state.trim() as items.ItemState }
						: {}),
					claims: (() => {
						const declaredNone =
							Array.isArray(args.exclusive) && (args.exclusive as string[]).includes("none");
						return {
							owns: owns.tokens,
							exclusive: exclusive.tokens,
							...(declaredNone ? { exclusiveDeclared: true } : {}),
						};
					})(),
					...(typeof args.provenance === "string" && args.provenance.trim()
						? { provenance: args.provenance.trim() }
						: {}),
					...(typeof args.artifact === "string" && args.artifact.trim()
						? { artifact: args.artifact.trim() }
						: {}),
				});
				return ok(json({ ok: true, action, op, item: items.renderItem(item) }), {
					ok: true,
					action,
					item: item.id,
				});
			}
			if (op === "update") {
				const id = typeof args.item === "string" ? args.item.trim() : "";
				if (!id) return refuse(action, "items update needs item — the ledger id, e.g. itm-19.");
				const patch: items.ItemPatch = {};
				if (typeof args.itemText === "string" && args.itemText.trim())
					patch.text = args.itemText.trim();
				if (typeof args.scope === "string" && args.scope.trim()) patch.scope = args.scope.trim();
				if (typeof args.state === "string" && args.state.trim())
					patch.state = args.state.trim() as items.ItemState;
				// An explicit empty string clears the field; leaving it out keeps it.
				if (typeof args.artifact === "string") patch.artifact = args.artifact.trim() || null;
				if (typeof args.name === "string") patch.worker = args.name.trim() || null;
				// Half-patched, never rebuilt: supplying one half of the claims must not
				// erase the other, which is what omission means everywhere else here.
				const claims: { owns?: string[]; exclusive?: string[]; exclusiveDeclared?: boolean } = {};
				if (Array.isArray(args.owns)) {
					const owns = normalizeOwns(args.owns as string[]);
					if (!owns.ok) return refuse(action, owns.message);
					claims.owns = owns.tokens;
				}
				if (Array.isArray(args.exclusive)) {
					const exclusive = normalizeExclusive(args.exclusive as string[]);
					if (!exclusive.ok) return refuse(action, exclusive.message);
					claims.exclusive = exclusive.tokens;
					if ((args.exclusive as string[]).includes("none")) claims.exclusiveDeclared = true;
				}
				if (claims.owns !== undefined || claims.exclusive !== undefined) patch.claims = claims;
				// An item that is live or done MUST name its owner. Every item has exactly
				// one worker, and the first flight left all thirteen marked `unassigned` — which
				// left a takeover with no way to go from an item to the run that produced the
				// evidence for it. The worker is the link, so it is required at the transition
				// rather than hoped for.
				const existingOwner = items.listItems(session).find((it) => it.id === id)?.worker;
				if (
					(patch.state === "live" || patch.state === "done") &&
					!(patch.worker ?? existingOwner)
				) {
					return refuse(
						action,
						`items update to '${patch.state}' needs name — the worker who owns it. An item with no owner cannot be traced to the run that did the work.`,
					);
				}
				// K-hat is built from the requests an item ACTUALLY took, so it is recorded
				// at the two transitions rather than inferred later: `live` stamps the
				// worker's turn count, `done` subtracts it. Unavailable turns leave the
				// field unset, which keeps K-hat zero instead of guessing a number.
				if (patch.state === "live" || patch.state === "done") {
					const before = items.listItems(session).find((it) => it.id === id);
					const owner =
						patch.worker ??
						(typeof args.name === "string" ? args.name : undefined) ??
						before?.worker;
					const w = owner ? roster.find(roster.load(session), owner) : undefined;
					const row = w ? (await statusRows()).find((x) => x.id === w.asyncRunId) : undefined;
					const turns = typeof row?.turns === "number" ? row.turns : undefined;
					if (turns !== undefined) {
						if (patch.state === "live") patch.startedTurns = turns;
						else if (typeof before?.startedTurns === "number" && turns >= before.startedTurns) {
							patch.requests = turns - before.startedTurns;
						}
					}
				}
				const updated = items.updateItem(session, id, patch);
				if (!updated)
					return refuse(action, `no ledger item '${id}'. List them with items op list.`);
				return ok(json({ ok: true, action, op, item: items.renderItem(updated) }), {
					ok: true,
					action,
					item: updated.id,
				});
			}
			return refuse(action, `unknown items op '${op}'. Use add, update or list.`);
		}

		// ── handoff — publish the crew so a successor can adopt it ──
		// The roster is per-session by design, so the crew crosses sessions as a
		// PUBLISHED sheet rather than as a readable roster. Nothing here signals,
		// resumes or restarts a worker: every worker keeps running in its own
		// detached session and the successor addresses the same run ids.
		if (action === "handoff") {
			if (r.crew.length === 0) {
				return refuse(
					action,
					"handoff publishes a crew and this session has none — there is nothing for a successor to adopt.",
				);
			}
			const rows = await statusRows();
			const identity = sessionIdentity(ctx);
			const pid = process.pid;
			const startIdentity = adopt.processStartIdentity(pid);
			const crewOut = r.crew.map((w) => {
				const row = rows.find((x) => x.id === w.asyncRunId);
				const rec = w.asyncRunId ? readRunRecord(w.asyncRunId) : null;
				const fp = rec ? prefixRows(rec.sessionFile, rec.pid, 1)[0] : undefined;
				const last = row ? rowLastActivity(row) : null;
				if (last !== null) w.lastActivityAt = last;
				return {
					name: w.name,
					scope: w.scope,
					state: w.state,
					asyncRunId: w.asyncRunId,
					runIds: [...w.runIds],
					childIndex: w.childIndex,
					owns: [...w.owns],
					exclusive: [...w.exclusive],
					hiredAt: w.hiredAt,
					lastActivityAt: w.lastActivityAt,
					reportPath: w.reportPath,
					authored: [...w.authored],
					failure: w.failure,
					sessionFile: rec?.sessionFile ?? runSessionFile(w.asyncRunId),
					statusPath: w.asyncRunId ? runStatusPath(w.asyncRunId) : null,
					// The fingerprint the successor checks a reuse decision against: the
					// bytes this worker's own process was sending, from the house cache log.
					prefix: fp
						? {
								sys: fp.sys,
								tools: fp.tools,
								nTools: fp.nTools,
								prefixChars: fp.prefixChars,
								ts: fp.ts,
							}
						: null,
					// The state, end time and artifact locations the worker's LAST run left
					// behind, copied from the run's own record so the archived sheet carries
					// them even after that record is pruned. They are the run's own output log
					// and artifact directory: no record anywhere carries the path a worker
					// names in its final message, so none is invented here.
					outcome: lastRunOutcome(w.runIds),
				};
			});
			const sheet: adopt.Sheet = {
				version: 1,
				writtenAt: Date.now(),
				predecessor: {
					sessionId: session,
					sessionFile: identity,
					pid,
					processStartIdentity: startIdentity ?? "",
					hostname: hostname(),
				},
				crew: crewOut,
			};
			const path = adopt.writeSheet(sheet);
			adopt.writePointer(basename(path), session, crewOut.length);
			// Withdrawn by publication, not by deletion: the workers are recorded as
			// handed off so this session cannot steer, assign or retire a crew that now
			// belongs to the successor, while the record of them stays readable here.
			for (const w of r.crew) {
				w.state = "handed-off";
				w.handedOffAt = sheet.writtenAt;
			}
			roster.save(r);
			if (!startIdentity) {
				return ok(
					json({
						ok: false,
						action,
						sheet: path,
						message: `${path} was written, but this process's own start identity could not be read from /proc, so a successor cannot prove this session left. Adopt will refuse with 'unknown' — NOT adopt this crew from another session until this process has exited.`,
					}),
					{ ok: false, action, sheet: path },
				);
			}
			return ok(
				json({
					ok: true,
					action,
					sheet: path,
					// Named with its lifecycle stated: a successful adopt DELETES this pointer
					// (the sheets stay), so its absence afterwards is the adoption working, not
					// a broken handoff.
					pointer: `${join(adopt.ADOPT_DIR, adopt.POINTER_NAME)} (adoption removes this pointer when it consumes the crew; the sheet above stays on disk)`,
					predecessor: {
						sessionId: session,
						sessionFile: identity,
						pid,
						processStartIdentity: startIdentity,
					},
					crew: crewOut.map((w) => ({
						name: w.name,
						stateAtHandoff: w.state,
						asyncRunId: w.asyncRunId,
						statusPath: w.statusPath,
						lastRun: w.outcome,
						fingerprint: w.prefix
							? { sys: w.prefix.sys, tools: w.prefix.tools, nTools: w.prefix.nTools }
							: null,
					})),
					notice:
						"published only — nothing was signalled, resumed or restarted. The successor takes the crew with fleet action 'adopt' (from:\"current\"); adoption refuses while THIS session is still alive (it waits for this session first), so clock out afterwards.",
				}),
				{ ok: true, action, sheet: path, crew: crewOut.length },
			);
		}

		// ── adopt — the successor takes the published crew over ──
		// Explicit, never implicit: this verb re-stamps the parent-session identity on
		// each adopted run, which is what makes a foreign crew addressable. It refuses
		// while the predecessor is demonstrably alive, adopts a LIVE worker by pointer
		// (never resumed, never restarted) and resumes nothing: an idle worker is
		// transferred with its reuse verdict stated, and the fleet's own reuse-window
		// rule decides whether it may be resumed later.
		if (action === "adopt") {
			const from = typeof args.from === "string" ? args.from : undefined;
			const resolved = adopt.resolveSheetFile(from);
			if ("error" in resolved) return refuse(action, resolved.error);
			const read = adopt.readSheetAt(resolved.path);
			if ("error" in read) return refuse(action, read.error);
			const sheet = read.sheet;
			const me = sessionIdentity(ctx);
			const expect = sheet.predecessor.sessionFile ?? sheet.predecessor.sessionId;
			if (
				me === expect ||
				me === sheet.predecessor.sessionId ||
				session === sheet.predecessor.sessionId
			) {
				return refuse(
					action,
					`this session IS the sheet's predecessor (${me}) — a session adopts a crew it did not publish. fleet handoff publishes a crew for a SUCCESSOR session.`,
				);
			}
			let verdict = adopt.predecessorVerdict(sheet);
			// A successor is normally opened while the predecessor is finishing its last
			// reply, so an early arrival WAITS (bounded, 105 s at 1 s→8 s backoff) instead
			// of hand-retrying. Safe to park here: the liveness proof is one /proc read and
			// every mutation of the adoption lifecycle — sheet stamp, roster write, claim
			// re-bind, pointer deletion — happens AFTER this verdict, so waiting writes
			// nothing, signals no worker, restarts nothing and resumes nothing.
			let waited: adopt.PredecessorWait | null = null;
			if (verdict.verdict === "alive") {
				waited = await adopt.waitForPredecessor(sheet);
				verdict = waited.verdict;
			}
			if (verdict.verdict === "alive") {
				return refuse(
					action,
					`refused: the predecessor session is still alive${waited ? ` after waiting ${human(waited.waitedMs)} (${waited.polls} liveness reads)` : ""} — ${verdict.detail}. Two foremen must not address one crew: let it clock out, then re-run adopt — the sheet and its pointer are untouched by this refusal, and nothing was signalled, restarted or resumed.`,
				);
			}
			if (verdict.verdict === "unknown") {
				return refuse(
					action,
					`refused: the predecessor cannot be proved gone — ${verdict.detail}. Adoption fails closed rather than risk two foremen on one crew.`,
				);
			}
			if (!sheet.crew.length)
				return refuse(action, `the sheet ${resolved.path} publishes no crew members to adopt.`);
			const windowMs = loadWindowMs();
			const taken: Array<Record<string, unknown>> = [];
			const refusedCrew: Array<{ name: string; asyncRunId: string | null; reason: string }> = [];
			const reuseReport: unknown[] = [];
			for (const sw of sheet.crew) {
				// A sheet is read from disk and may be hand-edited, and its name is the same
				// handoff filename component a hired name is, so it passes the same shape rule
				// before it can become a worker this session addresses.
				if (!isNameLike(sw.name)) {
					refusedCrew.push({
						name: sw.name,
						asyncRunId: sw.asyncRunId,
						reason: notANameMessage(sw.name),
					});
					continue;
				}
				if (roster.find(r, sw.name)) {
					refusedCrew.push({
						name: sw.name,
						asyncRunId: sw.asyncRunId,
						reason: `this session already has a worker named '${sw.name}' — adopting it would merge two identities into one name`,
					});
					continue;
				}
				if (!sw.asyncRunId) {
					refusedCrew.push({
						name: sw.name,
						asyncRunId: null,
						reason: "the sheet carries no run id for this worker, so there is nothing to point at",
					});
					continue;
				}
				const rec = readRunRecord(sw.asyncRunId);
				if (!rec) {
					refusedCrew.push({
						name: sw.name,
						asyncRunId: sw.asyncRunId,
						reason: `the fleet cannot resolve run ${sw.asyncRunId}: no run record at ${sw.statusPath ?? runStatusPath(sw.asyncRunId)} — the crew member cannot be steered, resumed or verified`,
					});
					continue;
				}
				const runState = (rec.state ?? "").toLowerCase();
				const live = runState === "running" || runState === "queued" || runState === "pending";
				const durability = adopt.restampDurability(rec.state);
				let stamp: adopt.RestampResult | null = null;
				if (live) {
					// A running worker is adopted by POINTER: it is not resumed, not
					// restarted and not duplicated, and its status record is left alone
					// because the process that is running owns that file.
					stamp = {
						ok: true,
						changed: false,
						written: [],
						skipped: [rec.statusPath],
						before: expect,
						after: me,
					};
				} else {
					stamp = adopt.restampParentSession(rec, expect, me);
					if (!stamp.ok) {
						refusedCrew.push({ name: sw.name, asyncRunId: sw.asyncRunId, reason: stamp.reason });
						continue;
					}
				}
				const w = roster.newWorker(sw.name, sw.scope);
				w.owns = [...sw.owns];
				w.exclusive = [...sw.exclusive];
				w.exclusiveDeclared = true;
				w.authored = sw.authored.length ? [...sw.authored] : [...sw.owns];
				w.asyncRunId = sw.asyncRunId;
				w.runIds = sw.runIds.length ? [...new Set([...sw.runIds, sw.asyncRunId])] : [sw.asyncRunId];
				w.childIndex = sw.childIndex;
				w.hiredAt = sw.hiredAt ?? Date.now();
				w.lastActivityAt = sw.lastActivityAt;
				w.reportPath = sw.reportPath;
				w.state = live
					? "live"
					: (terminalWorkerState(rec.state ?? undefined) ??
						(sw.state === "failed" || sw.state === "stopped" ? sw.state : "completed"));
				if (sw.failure && (sw.failure.status === "failed" || sw.failure.status === "stopped")) {
					w.failure = { at: sw.failure.at, status: sw.failure.status, reason: sw.failure.reason };
				} else {
					w.failure = null;
				}
				w.adoptedFrom = {
					sessionId: sheet.predecessor.sessionId,
					sheet: basename(resolved.path),
					at: Date.now(),
				};
				r.crew.push(w);
				// The claim record is the dispatcher side of the worker's own guard, so it
				// is re-published under this session: the worker's next write is checked
				// against the claim the successor actually holds.
				syncClaim(session, w.name, w.scope, w.owns, w.exclusive);
				// Both reads the roster makes, at adoption: what this worker's last run left
				// behind, and what settled after the sheet was published. Deliberately the
				// SAME reads, so the answer does not depend on when it is asked — a worker
				// can settle after this call, and its completion notice then reaches a
				// session that has already exited.
				const landed = landingsReport(w);
				taken.push({
					name: w.name,
					state: w.state,
					asyncRunId: w.asyncRunId,
					disposition: live ? "adopted-live" : "adopted-idle",
					...lastRunField(w),
					...(landed ? { landedSincePublish: landed } : {}),
				});
				if (!live) {
					const window = adopt.windowVerdict(sw.lastActivityAt, windowMs);
					const evidence = adopt.fingerprintEvidence(sw);
					reuseReport.push({
						name: w.name,
						reuseWindow: {
							decision: window.decision,
							measured:
								window.measuredMs === null
									? "unmeasured (no activity stamp in the sheet or the run record)"
									: human(window.measuredMs),
							window: human(windowMs),
						},
						fingerprint: {
							decision: evidence.decision,
							detail: evidence.detail,
							sheet: evidence.sheet,
							observed: evidence.observed,
						},
						resume:
							evidence.decision === "mismatch"
								? "REFUSED as cold: resuming this worker rebuilds the cached prefix, so nothing is warmed by it — read its report file instead, or re-hire for the scope"
								: window.decision === "past-window"
									? "not attempted: outside the fleet's reuse window — the same refusal assign would give"
									: evidence.decision === "match"
										? "available: inside the reuse window and a prior resume of this worker logged the same prefix bytes (assign may resume it)"
										: "not attempted, and NOT promised warm: a resume starts a second child process and rebuilds its system prompt, and those bytes are identical only while nothing the child inherits has changed — a context file, the extension list or the tool array moving is enough to re-bill the tools array and the whole conversation behind it. No resumed run of this worker has logged a fingerprint, so warmth stays a check (assign's own window rule), never a promise adopt can give.",
					});
				}
			}
			roster.save(r);
			let pointer: { cleared: boolean; reason: string } | null = null;
			if (taken.length) {
				adopt.stampSheetAdopted(resolved.path, sheet, session);
				// Deleted LAST, so a crash mid-adoption is re-runnable and never
				// double-claims: the sheets themselves stay on disk as the record of what
				// was handed over. Only a pointer that STILL names this sheet is removed —
				// the handoff branch is re-runnable, so a pointer the predecessor wrote
				// after this adoption began names a newer handoff with its own successor.
				pointer = adopt.clearPointer(basename(resolved.path));
			}
			return ok(
				json({
					ok: true,
					action,
					sheet: resolved.path,
					...(pointer
						? { pointer: { path: join(adopt.ADOPT_DIR, adopt.POINTER_NAME), ...pointer } }
						: {}),
					predecessor: {
						sessionId: sheet.predecessor.sessionId,
						sessionFile: expect,
						liveness: verdict.detail,
					},
					adopted: taken,
					successorIdentity: me,
					...(reuseReport.length ? { reuse: reuseReport } : {}),
					...(refusedCrew.length ? { unresolved: refusedCrew } : {}),
					notice: taken.length
						? "adopted by pointer: no worker was restarted, duplicated or signalled, and no resume was attempted. A live worker is steered; an idle one is resumed only by assign, inside the fleet's own reuse window. Each adopted worker carries its last run (state, end time, the artifact locations that run's own record holds — not a report the worker authored) and what settled after the sheet was published: the same reads roster reports, so ask it again later rather than trusting this snapshot."
						: "nothing was adopted; the sheet and its pointer are untouched.",
					nextLegalActions: ["roster", "steer", "assign", "retire", "hire"],
				}),
				{ ok: taken.length > 0, action, adopted: taken.length, refused: refusedCrew.length },
			);
		}

		// ── shared worker resolution ──
		if (!name) return refuse(action, `${action} needs name.`);
		if (isIdLike(name)) {
			return refuse(
				action,
				"fleet addresses workers by NAME. That is an async run id — call fleet.steer with name:'" +
					name.slice(0, 8) +
					"…'.",
			);
		}
		const w = roster.find(r, name);
		if (!w)
			return refuse(
				action,
				`unknown worker '${name}'. live crew: ${r.crew.map((c) => c.name).join(", ") || "(none)"}.`,
			);

		// ── steer ──
		if (action === "steer") {
			if (w.state === "handed-off") {
				return refuse(
					action,
					`${w.name} was published in an adoption sheet and belongs to the successor session now — this session must not steer it. The successor addresses the same run id (${w.asyncRunId ?? "none"}).`,
				);
			}
			if (w.handleUnverified) {
				return refuse(
					action,
					`${w.name}'s run handle could not be reconciled after its last resume — the stored id is not the live run, so a steer would land in the wrong run. Run fleet roster (it retries the reconcile), or hire a replacement worker.`,
				);
			}
			if (w.state === "retiring" || w.state === "retired")
				return refuse(
					action,
					`${w.name} is ${w.state} — no new tasks; its heap awaits a replacement.`,
				);
			if (w.state === "failed" || w.state === "stopped")
				return refuse(
					action,
					`${w.name} already ${w.state} — nothing to steer. Assign for a new task, or retire it.`,
				);
			const msg = typeof args.message === "string" ? args.message : undefined;
			if (!msg) return refuse(action, "steer needs message.");
			const rows = await statusRows();
			const row = rows.find((x) => x.id === w.asyncRunId);
			if (
				row &&
				["complete", "completed", "failed", "stopped"].includes((row.state ?? "").toLowerCase())
			) {
				w.state = "completed";
				roster.save(r);
				return refuse(
					action,
					`${w.name} already ${row.state} — nothing to steer. Assign for a new task, or retire it.`,
				);
			}
			const reply = await rpc(pi, "steer", {
				id: w.asyncRunId,
				index: w.childIndex,
				message: msg,
				mode: (args.delivery as string) ?? "auto",
			});
			roster.save(r);
			if (!reply.ok) {
				const fault = classify(reply, 20_000);
				return ok(
					json({
						ok: false,
						action,
						fault: fault.kind,
						message: `steer failed [${fault.kind}]: ${fault.detail}`,
					}),
					{ ok: false, action },
				);
			}
			// A live contact is proof the run is alive and resumable: any earlier
			// not-resumable verdict is stale by definition.
			if (w.state === "not-resumable") {
				w.state = "live";
				w.notResumableReason = null;
				roster.save(r);
			}
			return ok(
				json({
					ok: true,
					action,
					worker: w.name,
					handle: { asyncRunId: w.asyncRunId, childIndex: w.childIndex },
					receipt: reply.data,
					notice: "a queued steer is not a consumed one — confirm the effect on the next wake.",
					nextLegalActions: nextLegal(w),
				}),
				{ ok: true, action, worker: w.name },
			);
		}

		// ── retire ──
		if (action === "retire") {
			if (w.state === "handed-off") {
				return refuse(
					action,
					`${w.name} was published in an adoption sheet and belongs to the successor session now — a clock-out steer from here would race the successor's crew. No steer was sent.`,
				);
			}
			if (w.handleUnverified) {
				return refuse(
					action,
					`${w.name}'s run handle could not be reconciled after its last resume — a clock-out steer would land in the wrong run. Run fleet roster (it retries the reconcile) before retiring ${w.name}.`,
				);
			}
			if (w.state === "retired")
				return refuse(
					action,
					`${w.name} retired at ${new Date(w.hiredAt).toLocaleTimeString()} already.`,
				);
			// THE BOARD GUARD. A worker is not retirable while it still owns open rows:
			// the reconciliation below closes them (abandoned, or superseded), which would
			// erase the fact that it stopped with work outstanding — the board is the
			// crew's at-a-glance state, and that is the state the board shows. The read is
			// a read: it runs before the disposition, the state write, the claim release
			// and the closure, so a refusal leaves the board, the roster and the claim
			// exactly as they were. Rows belonging to other workers never block this
			// retirement — attribution is board.ts's own rule (the `<name>:` subject
			// prefix). Paths the guard cannot cover (the roster reconcile of an already
			// `retiring` worker, the gone-run pass over a worker a reboot destroyed) keep
			// closing rows: no caller can be refused there, and the worker that owns the
			// row no longer exists to close it.
			const boardSessionNow = boardSession();
			if (boardSessionNow === undefined) {
				// No session manager means the board cannot be read at all. Blocking every
				// retirement on a surface this process does not have would refuse work for a
				// reason that says nothing about the worker, so the guard stands down — and
				// says so, so a retirement that was never checked is visible rather than
				// silent.
				hookLog("fleet", "board-guard-unavailable", { worker: w.name, action });
			} else {
				const openRows = board.openRowsFor(boardSessionNow, w.name);
				if (openRows.length > 0) {
					return ok(
						json({
							ok: false,
							action,
							refused: true,
							worker: w.name,
							message: openBoardRowsMessage(w.name, openRows),
							openRows,
						}),
						{ ok: false, action, message: "open board rows", openRows },
					);
				}
			}
			// Reconcile the run FIRST: a run pi-subagents already finished needs no
			// clock-out steer, and steering a finished run is what dead-ended
			// retirement. A finished run retires as a plain transition (`retired`) —
			// a dead run cannot write a handoff.
			const retireRows = await statusRows();
			const rowState = retireRows.find((x) => x.id === w.asyncRunId)?.state;
			const pre = retireDisposition(w.state, rowState, { ok: true });
			if (pre.state === "retired") {
				releaseClaim(ioRoot(), w);
				roster.save(r);
				const boardOut = closeBoardRows(r, [w]);
				return ok(
					json({
						ok: true,
						action,
						worker: w.name,
						state: "retired",
						retired: `without a steer (${pre.detail})`,
						...(boardOut.length ? { board: boardOut } : {}),
						notice: "its heap is unassigned; hire a replacement.",
					}),
					{ ok: true, action, worker: w.name, ...(boardOut.length ? { board: boardOut } : {}) },
				);
			}
			w.state = "retiring";
			roster.save(r);
			const retireUsage = workerUsage(w.runIds);
			const contextK =
				retireUsage === null
					? null
					: Math.round((retireUsage.windowPeak ?? retireUsage.tokens) / 1000);
			const reply = await rpc(pi, "steer", {
				id: w.asyncRunId,
				index: w.childIndex,
				message: clockOutMessage(contextK),
				mode: "auto",
			});
			const post = retireDisposition(
				w.state,
				rowState,
				reply.ok ? { ok: true } : { ok: false, message: reply.error?.message ?? "unknown" },
			);
			// A settled retirement releases the claim in BOTH records (see release.ts).
			if (post.state === "retired") releaseClaim(ioRoot(), w);
			else w.state = post.state;
			roster.save(r);
			// Only a SETTLED retirement closes board rows: a worker still `retiring` has
			// not stopped, and the rows it holds may yet be finished by it.
			const boardOut = post.state === "retired" ? closeBoardRows(r, [w]) : [];
			return ok(
				json({
					ok: true,
					action,
					worker: w.name,
					state: post.state,
					...(boardOut.length ? { board: boardOut } : {}),
					steer: reply.ok ? reply.data : { failed: reply.error?.message ?? "unknown" },
					notice: post.finished
						? "the run had already finished and cannot be steered — retired without a clock-out (a finished run writes no handoff). Hire a replacement for its heap."
						: reply.ok
							? "clock-out steer sent; state flips to retired on CLOCKED OUT / asyncComplete / the next status reconcile."
							: "clock-out steer could not be delivered — the worker stays `retiring`; re-run retire (or wait for the status reconcile) to settle it.",
					nextLegalActions: nextLegal(w),
				}),
				{ ok: true, action, worker: w.name },
			);
		}

		// ── assign ──
		if (action === "assign") {
			if (w.state === "handed-off") {
				return refuse(
					action,
					`${w.name} was published in an adoption sheet and belongs to the successor session now — assigning here would put two foremen on one worker. The successor resumes it with its own assign.`,
				);
			}
			if (w.state === "retiring" || w.state === "retired")
				return refuse(
					action,
					`${w.name} is ${w.state} — no new tasks; its heap awaits a replacement.`,
				);
			if (w.state === "not-resumable") {
				return refuse(
					action,
					`${w.name} is not-resumable (its run cannot be continued)${w.notResumableReason ? `: ${w.notResumableReason}` : ""}; hire a replacement.`,
				);
			}
			const scope = typeof args.scope === "string" ? args.scope.trim() : "";
			if (!scope)
				return refuse(
					action,
					`assign needs scope — a worker is bound to the scope it was hired for ('${w.scope}').`,
				);
			if (scope !== w.scope)
				return refuse(
					action,
					`scope mismatch: '${scope}' is not ${w.name}'s scope ('${w.scope}'). Assign within a worker's scope, or hire for the new one.`,
				);
			const decl = declared(args);
			if (decl.error) return refuse(action, decl.error);
			const timeoutErr = clampTimeout(args.timeoutMs as number | undefined);
			if (timeoutErr) return refuse(action, timeoutErr);
			const artErr = artifactsOk(args.artifacts);
			if (artErr) return refuse(action, artErr);
			const task = serializeTask(args.task);
			if (!task.ok) return refuse(action, task.message);
			const rows = await statusRows();
			const released = releaseGoneRuns(r, rows);
			if (released.length) roster.save(r);
			const conflict = claimConflict(roster.claims(r, w.name), decl.owns);
			if (conflict) return refuse(action, overlapMessage(decl.owns, conflict));
			// A run id is what the reuse decision and the resume are both aimed through,
			// so an unresolvable one is a refusal that names the identity: a resume would
			// otherwise be handed a null id.
			if (!w.asyncRunId) {
				return refuse(
					action,
					`${w.name} has no run id recorded — its identity cannot be resolved, so no resume can be aimed at it. Hire a replacement for this scope, or run fleet roster to re-reconcile the handle.`,
				);
			}
			const verdict = warmCheck(
				rows.find((x) => x.id === w.asyncRunId),
				loadWindowMs(),
			);
			if (verdict.kind === "live")
				return refuse(
					action,
					`${w.name} is live (running/queued) — steer it instead of assigning: fleet.steer name:'${w.name}'.`,
				);
			if (verdict.kind === "no-activity") {
				return refuse(
					action,
					`cannot verify ${w.name}'s state (its status row carries no activity stamp) — treating it as live; no resume performed.`,
				);
			}
			// A run with no record and no row is not a live run: nothing about it can be
			// verified and nothing can be steered, and refusing here made every later task
			// on a scope cost a cold start under a new name. A resume is attempted instead
			// and the run's owner answers — a refusal that means the run cannot be continued
			// marks the worker `not-resumable` below. Only a record that EXISTS and cannot be
			// read stays a refusal: that is an ambiguity about a run that was there.
			if (verdict.kind === "no-record" && runRecordPresence(w.asyncRunId) === "unreadable") {
				return refuse(
					action,
					`cannot verify ${w.name}'s state (a run record exists at ${runStatusPath(w.asyncRunId)} but cannot be read) — treating it as live; no resume performed.`,
				);
			}
			if (verdict.kind === "past-window")
				return refuse(
					action,
					`${w.name} idle ${human(verdict.measuredMs)} — outside the reuse window; its context is no longer warm. Hire a new worker for this scope, or retire ${w.name}.`,
				);
			// Publish the scope this task will actually use, before the resume, so the
			// worker's guard checks against the new claim rather than a stale one.
			syncClaim(session, w.name, w.scope, decl.owns, decl.exclusive);
			// The RPC resume contract (pi-subagents/src/extension/rpc.ts:543) requires a
			// non-empty `message`; `task` is not a resume parameter. The label names the
			// resumed run from the worker record the roster already holds, so a resume
			// carries the same envelope a hire does; pi-subagents' resume normaliser does
			// not forward it, so the row keeps the crew name only once it does.
			const reply = await rpc(pi, "resume", {
				id: w.asyncRunId,
				index: w.childIndex,
				label: w.name,
				message: task.text,
			});
			// (a failed resume names its condition below)
			if (!reply.ok) {
				const fault = classify(reply, 30_000);
				const kind = resumeFailureKind(reply.error);
				if (kind === "no-session") {
					w.state = "not-resumable";
					w.notResumableReason = reply.error?.message ?? fault.detail;
					roster.save(r);
					return ok(
						json({
							ok: false,
							action,
							fault: fault.kind,
							message: `resume failed [${fault.kind}] (${w.name} marked not-resumable): ${fault.detail}`,
						}),
						{ ok: false, action },
					);
				}
				return ok(
					json({
						ok: false,
						action,
						fault: fault.kind,
						message: `resume failed [${fault.kind}] — a ${kind} refusal is not a verdict about the run; ${w.name}'s state is unchanged: ${fault.detail}`,
					}),
					{ ok: false, action },
				);
			}
			if (decl.owns.length) w.authored = [...new Set([...w.authored, scope, ...decl.owns])];
			// V9: the resume created a NEW async run; adopt it before anything else
			// can address the dead pre-resume id.
			const adopted = await adoptResumedHandle(w, reply.data, rows);
			if (adopted) {
				w.asyncRunId = adopted.id;
				w.childIndex = adopted.index;
				w.handleUnverified = false;
				trackRun(w);
			} else {
				w.handleUnverified = true;
			}
			w.state = "live";
			w.notResumableReason = null;
			w.owns = decl.owns;
			w.exclusive = decl.exclusive;
			w.exclusiveDeclared = true;
			w.lastActivityAt = Date.now();
			roster.save(r);
			return ok(
				json({
					ok: true,
					action,
					worker: w.name,
					handle: { asyncRunId: w.asyncRunId, childIndex: w.childIndex },
					handleAdopted: adopted ? adopted.source : "unverified",
					...(adopted
						? {}
						: {
								handleNotice:
									"the resumed run's id could not be reconciled from the reply or the status snapshot — steer/retire refuse until fleet roster resolves it (they are never aimed at the dead pre-resume run).",
							}),
					state: "live",
					reuse: {
						decision: verdict.kind === "warm" ? "warm-resume" : "cold-resume",
						measured:
							verdict.kind === "warm"
								? human(verdict.measuredMs)
								: "unmeasured (no status record for the run — the resume attempt decided)",
					},
					claims: { owns: w.owns, exclusive: w.exclusive },
					authored: w.authored,
					nextLegalActions: ["roster", "steer", "retire"],
				}),
				{ ok: true, action, worker: w.name },
			);
		}
		return refuse(action, `unknown action '${action}'.`);
	}

	pi.registerTool({
		name: "fleet",
		label: "Fleet",
		description:
			"Manage the named crew (foreman mode only). Replaces `subagent`: hire/assign/steer/retire/review/roster by WORKER NAME — the tool owns name→run-id, measures idle time, decides warm reuse itself, and enforces one-writer and non-author review rules. `handoff` publishes the crew for a successor session and `adopt` takes a published crew over. ONE crew action per assistant turn: a second fleet call in the same turn is refused.",
		promptSnippet:
			"Manage the named crew: hire, assign, steer, retire, review, roster, items, handoff, adopt (foreman mode).",
		promptGuidelines: [
			"Use fleet for every crew action; fleet reviews never spawn a fresh worker and fleet decides warm reuse itself.",
			"A crew crosses sessions only through fleet handoff (publish) then fleet adopt (take over) — adopt refuses while the predecessor session is alive.",
		],
		parameters: Type.Object(
			{
				action: Type.Union(
					ACTIONS.map((a) => Type.Literal(a)),
					{
						description:
							"`roster` carries each worker's state and `reportPath` plus `context` (the CURRENT fill, with contextFill/contextLimit/contextHighWater), `spentTokens` (cumulative spend over every run) and `fatigue` — a SPEND rule, stated in `fatigueBasis` as spentTokens >= 800000: decide warm-or-retire from `context`, never from `spentTokens` or the flag. `retire` releases the worker's claim and refuses while a board row of that worker is still open; a claim bound to a dead session refuses every write, so a run stranded that way is RETIRED and re-dispatched, never steered.",
					},
				),
				name: Type.Optional(
					Type.String({
						description:
							"Worker name. hire: optional (next unused pool name) — name every worker a person's first name (alice, bob), never a scope word or task label. roster/assign/steer/retire: required, exact match. review: OPTIONAL — when omitted the tool resolves the reviewer itself (warmest eligible non-author); when given it must be that worker or the call refuses. Name-shaped only: an async run id is refused.",
					}),
				),
				scope: Type.Optional(
					Type.String({
						description:
							"hire/assign — the work slice. On assign it must match the worker's hired scope (a different scope means hire instead).",
					}),
				),
				task: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Task text as LINES; the tool serializes them. Backticks/quotes are safe by construction (a bare string arrives as one line).",
					}),
				),
				artifacts: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Paths the worker must read first; each is stat-checked before launch and rendered as an explicit list.",
					}),
				),
				owns: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Files or globs this task will WRITE — list every path the brief tells the worker to write, its report file included, or the write is refused and the report never lands. Overlap with a live claim is refused. The claim set is FIXED AT HIRE: a steer cannot widen it, and assign is refused while the worker is live — a lane that turns out to need another file gets a second worker.",
					}),
				),
				exclusive: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Non-file tokens ('greeter-app','lockscreen','shell-restart'). Single-holder. Pass exactly [\"none\"] when the task touches no exclusive resource: it declares 'no exclusive resource' and is exclusive with nothing.",
					}),
				),
				message: Type.Optional(
					Type.String({
						description:
							"steer only — guidance text. A question or a further step is fine; it cannot widen the worker's `owns`.",
					}),
				),
				delivery: Type.Optional(
					Type.Union(
						["auto", "steer", "follow_up"].map((d) => Type.Literal(d)),
						{
							description:
								"steer only — delivery semantics (renamed from `mode` to avoid colliding with foreman mode).",
						},
					),
				),
				target: Type.Optional(
					Type.String({
						description:
							"review only — the artifact/scope under review (path or scope string). Required: non-authorship is checked against it.",
					}),
				),
				from: Type.Optional(
					Type.String({
						description:
							'adopt only — which handoff to take over: "current" (the handoff pointer, the default) or a predecessor session id / sheet file name from ~/.local/pi/foreman/adopt/.',
					}),
				),
				op: Type.Optional(
					Type.Union(
						["add", "update", "list"].map((o) => Type.Literal(o)),
						{
							description: "items — add a ledger entry, update one, or list the ledger.",
						},
					),
				),
				itemText: Type.Optional(
					Type.String({ description: "items add — one line describing the work item." }),
				),
				item: Type.Optional(
					Type.String({ description: "items update — the ledger id to change, e.g. itm-19." }),
				),
				state: Type.Optional(
					Type.Union(
						["queued", "live", "done", "failed"].map((s) => Type.Literal(s)),
						{
							description:
								"items — the item's state. Never pre-mark a queued item as live: `live` means work has actually started.",
						},
					),
				),
				artifact: Type.Optional(
					Type.String({ description: "items — the path the item's work produced." }),
				),
				provenance: Type.Optional(
					Type.String({
						description:
							"items add — which prompt or steer produced this item, for tracing it back.",
					}),
				),
				timeoutMs: Type.Optional(
					Type.Integer({
						description:
							"Run timeout; forwarded verbatim to the spawn. Below 10m or above 24h is refused.",
						default: 43_200_000,
						minimum: 600_000,
						maximum: 86_400_000,
					}),
				),
			},
			{ additionalProperties: false },
		),
		// Header only (display): the action, the worker it names, and the field
		// that makes the action readable — scope, steer text, or review target.
		renderCall(args: Record<string, unknown>, theme: Parameters<typeof safeToolHeader>[0]) {
			return safeToolHeader(theme, "fleet", () => {
				const action = argText(args, "action") ?? "action";
				const worker = argText(args, "name");
				const detail =
					action === "hire" || action === "assign"
						? argText(args, "scope")
						: action === "steer"
							? argText(args, "message")
							: action === "review"
								? argText(args, "target")
								: action === "items"
									? argText(args, "op")
									: action === "adopt"
										? (argText(args, "from") ?? "current")
										: undefined;
				const parts: HeaderPart[] = [["accent", ` ${action}`]];
				if (worker) parts.push(["accent", ` ${worker}`]);
				if (detail) parts.push(["muted", " — "], ["dim", clip(detail)]);
				return parts;
			});
		},

		async execute(
			_id: string,
			params: Record<string, unknown>,
			_signal: unknown,
			_onUpdate: unknown,
			ctx: Ctx,
		) {
			try {
				crewCtx = ctx;
				return await doAction(String(params.action), params, ctx);
			} catch (e) {
				return ok(
					json({ ok: false, action: params.action, message: `fleet internal error: ${String(e)}` }),
					{ ok: false },
				);
			}
		},
	} as never);

	// ── escape hatch ──
	/**
	 * The only mode command left, deliberately reserved and argument-free: it takes no
	 * argument and owns no activation half. A session whose mode file says ON re-arms on
	 * every `pi --continue`, so without this an aborted handoff would leave a session
	 * armed with no way out; nothing ARMS from a command any more, because the launcher's
	 * `PI_FOREMAN=1` marker does that at `session_start`.
	 */
	pi.registerCommand("foreman-off", {
		description:
			"Leave foreman mode: restore the pre-activation tool set. Foreman sessions are started with the pi-foreman launcher.",
		handler: (_args: string, ctx: Ctx) => {
			const session = sid(ctx);
			crewCtx = ctx;
			if (!mode.isOn(session)) {
				// Cleared here too: a section must never outlive the mode it describes.
				setForemanSection(false);
				ctx?.ui?.notify?.("foreman mode is already off.", "info");
				return;
			}
			const entries = ctx?.sessionManager?.buildContextEntries?.()?.length ?? 0;
			setForemanSection(false);
			mode.deactivate(toolSet, session);
			// Leaving changes the tool array too, so the same accounting applies.
			if (entries > 0) {
				ctx?.ui?.notify?.(
					`foreman mode off: the tool set changed back, so this session's ${entries} context entries re-bill once at full price.`,
					"warning",
				);
			}
		},
	} as never);

	pi.on("before_agent_start", (_e: unknown, ctx: Ctx) => {
		crewCtx = ctx;
	});

	// V2: the budget guards BATCHING — two fleet calls in one assistant message.
	// One assistant message = one model turn, and wake-delivered turns produce
	// their own message, so this counter advances exactly where the old
	// turn_start/turnIndex pairing failed to.
	pi.on("message_start", (e: { message?: { role?: string } }) => {
		if (e?.message?.role === "assistant") turnId++;
	});

	pi.on("session_start", (_e: unknown, ctx: Ctx) => {
		crewCtx = ctx;
		const session = sid(ctx);
		// Re-arm for a session whose own mode file says ON, and arm a session the
		// launcher marked with PI_FOREMAN=1. A session with neither is left untouched
		// (no file write, no tool-set change).
		//
		// The launcher's marker is the whole activation contract: the `/foreman`
		// command is retired, a fresh session has no mode file yet, and this handler
		// is the last point before the first request — so the arming happens HERE, in
		// the same synchronous transaction the re-arm uses. An awaited probe in this
		// branch would let the first request go out on the default tool set with no
		// section, re-billing the whole prefix once the set finally changed.
		//
		// The child clause is deliberate: the marker is inherited by everything a
		// foreman spawns, so without it a plain `pi` started from a worker's shell
		// would come up as a foreman.
		alive = true;
		if (
			mode.isOn(session) ||
			(process.env.PI_FOREMAN === "1" && process.env.PI_SUBAGENT_CHILD !== "1")
		) {
			// Announced from the RESULT, never ahead of it: a failed activation rewrites
			// the mode file OFF, so a section published first would leave the model
			// running a crew whose tool is not in its array.
			const act = mode.activate(toolSet, session);
			setForemanSection(act.ok);
			appliedSet = act.ok ? act.applied : [];
			if (act.ok && act.missing.length) {
				ctx?.ui?.notify?.(
					`foreman mode re-armed. Not registered at activation, so left out for now: ${act.missing.join(", ")}. A tool that registers later takes its place; one that never does stays absent.`,
					"warning",
				);
			}
		} else {
			setForemanSection(false);
			// Registered-but-inactive: our own tool is removed from the active
			// set unless foreman mode is ON for THIS session. Nothing else in
			// the set is touched.
			const active = toolSet.getActiveTools().filter((n) => n !== "fleet");
			if (active.length !== toolSet.getActiveTools().length) toolSet.setActiveTools(active);
		}
	});

	pi.on("session_shutdown", (_e: unknown, _ctx: Ctx) => {
		alive = false;
		// The mode file is deliberately NOT cleared here. `session_shutdown` fires on a
		// plain quit AND on `/reload`, and that file is exactly what makes the
		// `session_start` re-arm restore the foreman session after `--continue`: clear
		// it and the session resumes with the default tool array, re-billing the whole
		// conversation and silently dropping the mode. Retention is `mode.pruneOld`'s
		// job, and a mode file for a session that never returns is inert.
	});

	// Async completion: a failed/stopped crew run is made self-describing from the
	// run's OWN record, so the roster and the foreman's notice carry the cause
	// instead of a bare "failed". Subscribed on the same event pi-subagents notifies
	// on; runs that are not this session's crew are ignored.
	const events = (
		pi as unknown as { events?: { on: (e: string, cb: (p: unknown) => void) => void } }
	).events;
	events?.on("subagent:async-complete", (payload) => {
		void onAsyncComplete(payload);
	});
	// The retirement signal rides the same completion seam the run records do: the
	// extension already lives in the foreman's own process, so this is a local
	// append and needs no broker.
	events?.on("subagent:async-complete", (payload) => {
		void assessCompletion(payload);
	});

	/** Last signal per worker, for the cooldown the assessment takes as an input. */
	const lastSignalFor = new Map<string, number>();
	/** One refusal line per worker per reason: a refusal is evidence, a flood of
	 *  identical refusals is noise. */
	const refusalsLogged = new Set<string>();

	/**
	 * The retirement signal. ADVISORY: it never retires anything. It appends one line
	 * when replacing a warm worker would pay for itself, and — because a rule that
	 * cannot fire and says nothing is indistinguishable from a rule that finds
	 * nothing — it records a REFUSAL naming whichever input the comparison needed and
	 * could not measure.
	 *
	 * Delivery is appended without forcing a turn, so it rides the next
	 * wake, EXCEPT for the two hard backstops, which force one because that worker is
	 * about to be reset whatever the foreman decides.
	 */
	/** Where the workers leave their handoffs — the source for the handoff length. */
	const HANDOFF_DIR = `${process.env.HOME ?? "/root"}/.local/pi/foreman/handoffs`;

	/**
	 * m: the handoff length. The estimator lives in the module (the MEDIAN of recent
	 * handoffs); this side only supplies what it can measure — the worker's own
	 * handoff file, at the same four-characters-per-token estimate the F0 read
	 * declares. No handoff measures as zero, and a zero only SHRINKS X, so it can
	 * never make the rule fire on its own.
	 */
	function handoffTokensFor(worker: string): number {
		const samples: number[] = [];
		try {
			const bytes = statSync(`${HANDOFF_DIR}/${worker}.md`).size;
			if (bytes > 0) samples.push(Math.round(bytes / 4));
		} catch {
			/* the worker has not clocked out before */
		}
		return retire.handoffTokens(samples) ?? 0;
	}

	/**
	 * A handoff is current when it exists and is at least as new as the worker's last
	 * activity. A stale handoff is the expensive failure this rule exists to avoid,
	 * so an unreadable one is NOT current — the guard must fail closed.
	 */
	function handoffIsCurrent(worker: string, lastActivityAt?: number): boolean {
		try {
			const stamped = statSync(`${HANDOFF_DIR}/${worker}.md`).mtimeMs;
			return typeof lastActivityAt !== "number" || stamped >= lastActivityAt;
		} catch {
			return false;
		}
	}

	async function assessCompletion(payload: unknown): Promise<void> {
		try {
			if (!alive) return;
			const runId = (payload as { runId?: unknown } | null)?.runId;
			if (typeof runId !== "string") return;
			// In-process event, so this ctx is the right session identity; the payload's
			// session field is pi-subagents' session FILE path and matches no mode file.
			const session = crewCtx?.sessionManager?.getSessionId?.();
			if (!session || !mode.isOn(session)) return;
			const r = roster.load(session);
			const w = r.crew.find((c) => c.asyncRunId === runId);
			if (!w || w.state === "retired" || w.state === "retiring") return;
			// Not this session's crew any more: a handed-off worker's completion is the
			// successor's event to record.
			if (w.state === "handed-off") return;
			const usage = workerUsage(w.runIds);
			// Null when none of this worker's runs has a staged record. Guarded rather than
			// dereferenced: an unguarded null throws straight into this handler's own catch,
			// which is precisely the silent failure this mechanism exists to avoid.
			if (!usage) {
				refuseRetirement(w.name, "no usage record is staged for any of this worker's runs");
				return;
			}
			const W = usage.window;
			if (typeof W !== "number" || !(W > 0)) {
				refuseRetirement(
					w.name,
					"this worker's current context window is not staged in any run record",
				);
				return;
			}
			// B, measured the way the design defines it and never substituted: the
			// smallest window a run reached AFTER its first — a fresh worker's first run
			// is a LOWER bound on B, and using it inflates W − B, which makes the rule
			// fire far too readily.
			const runIds = (w.runIds ?? []).filter((x): x is string => typeof x === "string");
			const samples: number[] = [];
			for (const id of runIds.slice(1)) {
				const u = runUsage(id);
				if (typeof u?.window === "number" && u.window > 0) samples.push(u.window);
			}
			const B = retire.baselineWindow(samples);
			if (B === null) {
				refuseRetirement(
					w.name,
					`no baseline (B) yet: this worker has ${runIds.length} run(s) and a baseline needs a window from a run after its first`,
				);
				return;
			}
			const reuseWindowMs = loadWindowMs();
			const now = Date.now();
			const ledger = items.listItems(session);
			const queued = ledger.filter((it) => it.state === "queued");
			const doneItems = ledger.filter((it) => it.worker === w.name && it.state === "done");
			const row = lastRows.find((x) => x.id === runId);
			const turns = typeof row?.turns === "number" && row.turns > 0 ? row.turns : 0;
			const outTokens = typeof row?.tokens?.output === "number" ? row.tokens.output : 0;
			const idleMs = typeof w.lastActivityAt === "number" ? Math.max(0, now - w.lastActivityAt) : 0;
			const facts: retire.WorkerFacts = {
				worker: w.name,
				W,
				B,
				// F0 from the house cache log's recorded prefix sizes, zero when that log
				// has nothing to measure — zero is the pessimistic direction (X largest).
				F0: retire.readPrefixTokens() ?? 0,
				m: handoffTokensFor(w.name),
				obar: turns > 0 ? Math.round(outTokens / turns) : 0,
				// Left zero: checkRetirement fills it from the registry, which still
				// carries contextWindow for a tariff-priced model whose cost row is zeroed.
				contextLimit: 0,
				windowPeak: usage.windowPeak,
				lifetimeTokens: usage.tokens,
				idleMs,
				// The requests each completed item took, stamped by the ledger at its
				// `live` and `done` transitions. Empty until items carry them, which keeps
				// K-hat at zero rather than forecasting from a proxy.
				perItemRequests: doneItems
					.map((it) => it.requests)
					.filter((n): n is number => typeof n === "number" && n > 0),
				pendingItems: queued.length,
				// Read, never assumed: a live run means the wind-down would land inside a
				// step, and a stale or missing handoff is the failure this rule exists to
				// avoid.
				midStep: w.state === "live",
				familyShift: queued.length > 0 && queued.every((it) => it.scope !== w.scope),
				handoffCurrent: handoffIsCurrent(w.name, w.lastActivityAt ?? undefined),
				itemsSinceHire: doneItems.length,
				// The one part of "non-handoff-able state" this side cannot see: whether the
				// worker holds uncommitted work or a running subprocess. A live run is already
				// caught by midStep above; the rest has no source here, so it is reported as
				// UNKNOWN and the economic path stays silent rather than risking a handoff
				// that loses it. The hard backstops are unaffected — they return first.
				nonHandoffableState: null,
				lastSignalAtMs: lastSignalFor.get(w.name) ?? null,
				fleetRetirementTimesMs: retire.recentRetirementTimesMs(),
				// How many workers on this scope have already been retired: a chain of
				// handoffs repeats the same forecast, so the cap has to count them.
				lineageDepth: r.crew.filter((c) => c.scope === w.scope && c.state === "retired").length,
			};
			const verdict = retire.checkRetirement(facts, { modelId: crewModelId() });
			// checkRetirement logs EVERY outcome, refusals included, with its reason — so
			// this branch must not log a second line for the same event.
			if (!verdict.ok) return;
			const a = verdict.assessment;
			if (a.decision === "keep") return;
			lastSignalFor.set(w.name, now);
			const hard = a.decision === "reset";
			pi.sendMessage(
				{
					customType: "fleet-retirement",
					content: `Crew worker **${w.name}** is ready to clock out — ${a.decision}: ${a.reasons.join("; ")}`,
					display: true,
				},
				{ triggerTurn: hard },
			);
		} catch {
			/* an assessment must never throw into the event bus */
		}
	}

	function refuseRetirement(worker: string, reason: string): void {
		const key = `${worker}:${reason}`;
		if (refusalsLogged.has(key)) return;
		refusalsLogged.add(key);
		retire.appendRetireLog({ at: Date.now(), worker, decision: "refusal", reason });
	}

	/** The model the crew runs on. Only the caller knows it, and a missing id is a
	 *  refusal rather than a guess (see retire.readPrice) — but the fallback matters:
	 *  the completion seam has no `before_agent_start` context to inherit one from, so
	 *  without PI_MODEL every assessment would refuse for want of a model that the
	 *  session does in fact run. */
	function crewModelId(): string | null {
		const ctx = crewCtx as unknown as { model?: { id?: string } | string } | undefined;
		const m = ctx?.model;
		const id = typeof m === "string" ? m : m?.id;
		return id ?? (process.env.PI_MODEL?.trim() || null);
	}

	// ── helpers ──
	function declared(args: Record<string, unknown>): {
		owns: string[];
		exclusive: string[];
		error?: string;
	} {
		const rawOwns = Array.isArray(args.owns) ? (args.owns as string[]) : [];
		const rawEx = Array.isArray(args.exclusive) ? (args.exclusive as string[]) : [];
		// "none" is the SAME sentinel in both fields: a declaration that this task
		// writes/holds nothing. A sentinel-only list is a real declaration (not an
		// omission), and the sentinel itself never becomes a claim.
		const ownsGiven = rawOwns.some((t) => t.trim() !== "");
		const exGiven = rawEx.some((t) => t.trim() !== "");
		if (!ownsGiven && !exGiven) {
			return {
				owns: [],
				exclusive: [],
				error:
					'no declared ownership: pass owns:[...] for files this task writes, or exclusive:["none"] if it writes nothing.',
			};
		}
		const normOwns = normalizeOwns(rawOwns);
		if (!normOwns.ok) return { owns: [], exclusive: [], error: normOwns.message };
		const normEx = normalizeExclusive(rawEx);
		if (!normEx.ok) return { owns: [], exclusive: [], error: normEx.message };
		return { owns: normOwns.tokens, exclusive: normEx.tokens };
	}

	function overlapMessage(
		want: string[],
		c: { owner: string; path: string; since: number },
	): string {
		return `refused: '${want[0]}' overlaps ${c.owner}'s live claim '${c.path}' (since ${new Date(c.since).toLocaleTimeString()}).`;
	}

	/** The lines every hired worker reads first: the protocol document, its own
	 *  name and scope, and the form its board entries must carry. The name is
	 *  interpolated, so a worker never reads the literal agent type as its own. */
	function prependProtocol(args: Record<string, unknown>, name: string, taskText: string): string {
		const scopeArg = typeof args.scope === "string" ? args.scope : "";
		const first = `read ~/.local/pi/foreman/worker.md and follow it; your name is ${name}, your scope is ${scopeArg}`;
		const board = `your todo entries are written with your own name first — "${name}: <imperative subject>", e.g. "${name}: extract the shared divider into common/media"`;
		return `${first}\n${board}\n${taskText}`;
	}

	/**
	 * The completion payload pi-subagents emits (`runs/background/result-watcher.ts`).
	 * The single-run shape puts the child record on `results[0].sessionFile` — the
	 * top level has `{runId, agent, mode, state, success, results[]}`, and `results[]`
	 * entries carry NO `runId`, so neither lookup may be assumed.
	 */
	interface CompletionPayload {
		runId?: string;
		sessionId?: string;
		success?: boolean;
		state?: string;
		stopped?: boolean;
		processSignal?: string | null;
		exitCode?: number;
		summary?: string;
		sessionFile?: string;
		results?: Array<{
			runId?: string;
			agent?: string;
			sessionFile?: string;
			sessionPath?: string;
			exitCode?: number | null;
			processSignal?: string | null;
			status?: string;
			state?: string;
			success?: boolean;
		}>;
	}

	/** The terminal outcome a completion payload carries, or null when it completed. */
	function completionOutcome(p: CompletionPayload): "failed" | "stopped" | null {
		const st = (p.state ?? "").toLowerCase();
		if (
			p.stopped === true ||
			st === "stopped" ||
			(typeof p.processSignal === "string" && p.processSignal.length > 0)
		)
			return "stopped";
		if (p.success === false || st === "failed") return "failed";
		return null;
	}

	/**
	 * The completed child's own session record: `results[].runId` does not exist in
	 * the real payload, so a single-child run is `results[0]`; a multi-child run
	 * prefers the entry whose `runId` matches (pi-subagents only adds it for result
	 * children). Falls back to the run record's own `sessionFile`.
	 */
	function completionSessionFile(p: CompletionPayload, runId: string): string | null {
		const results = p.results ?? [];
		const child =
			results.find((r) => r.runId === runId) ??
			(results.length === 1 ? results[0] : undefined) ??
			results[0];
		return child?.sessionFile ?? child?.sessionPath ?? p.sessionFile ?? runSessionFile(runId);
	}

	/** The best cause the completion payload plus the run's own record retain. */
	function completionCause(
		p: CompletionPayload,
		runId: string,
		outcome: "failed" | "stopped",
	): string {
		const results = p.results ?? [];
		const child =
			results.find((r) => r.runId === runId) ??
			(results.length === 1 ? results[0] : undefined) ??
			results[0];
		const parts: string[] = [];
		const exit =
			typeof p.exitCode === "number"
				? p.exitCode
				: typeof child?.exitCode === "number"
					? child.exitCode
					: undefined;
		if (typeof exit === "number" && exit !== 0) parts.push(`exit code ${exit}`);
		const signal = p.processSignal ?? child?.processSignal;
		if (typeof signal === "string" && signal) parts.push(`process signal ${signal}`);
		const record = runFailureCause(completionSessionFile(p, runId));
		if (record) parts.push(record);
		else {
			const summary = typeof p.summary === "string" ? p.summary.trim() : "";
			if (summary && summary !== "(no output)") parts.push(`last output: ${summary.slice(0, 240)}`);
		}
		if (parts.length === 0)
			parts.push(
				`pi-subagents reported '${outcome}' but the run retained no cause (no record, no exit state)`,
			);
		return parts.join("; ");
	}

	/**
	 * Record a failed/stopped crew run's cause from its own record and surface it:
	 * the worker carries a `failure` the roster reports, and the foreman gets a
	 * notice carrying the cause pi-subagents' notice drops. Never throws.
	 */
	async function onAsyncComplete(payload: unknown): Promise<void> {
		try {
			if (!alive) return;
			const p = (payload ?? {}) as CompletionPayload;
			const runId = typeof p.runId === "string" ? p.runId : undefined;
			if (!runId) return;
			// The event is in-process, so the extension ctx is the right session
			// identity. `p.sessionId` is the PARENT SESSION FILE PATH in pi-subagents'
			// world, which `mode.isOn` (a UUID key) can never match — no fallback.
			const session = crewCtx?.sessionManager?.getSessionId?.();
			if (!session || !mode.isOn(session)) return;
			const outcome = completionOutcome(p);
			const r = roster.load(session);
			const w = r.crew.find((c) => c.asyncRunId === runId);
			if (!w) return;
			// A terminal worker is not resurrected: a `retiring` worker's clock-out is
			// its own transition (it becomes `retired`), and `retired` is final.
			if (w.state === "retired" || w.state === "retiring") return;
			// A published worker is not this session's to record any more.
			if (w.state === "handed-off") return;
			// A SUCCESSFUL completion must be recorded too, and it has to happen HERE, after the
			// worker is resolved. An earlier version of this branch sat above these two
			// declarations, referenced them, threw a ReferenceError, and was swallowed by this
			// handler's own catch — so it never ran even once. The roster is what the foreman
			// reads between calls, and a finished worker left marked live makes the crew view
			// lag reality (observed live: five finished workers all still reading live).
			if (!outcome) {
				if (w.state === "live") {
					w.state = "completed";
					w.lastActivityAt = Date.now();
					roster.save(r);
				}
				return;
			}
			trackRun(w);
			const reason = completionCause(p, runId, outcome);
			w.state = outcome;
			w.failure = { at: Date.now(), status: outcome, reason };
			w.lastActivityAt = Date.now();
			roster.save(r);
			const record = completionSessionFile(p, runId);
			// Parent-facing: the same event pi-subagents notices on, answered with the
			// cause it drops. No triggerTurn — pi-subagents already wakes the foreman on
			// a non-completed run, and calling prompt() from here would re-enter the
			// agent ("already processing a prompt") and abort the session.
			pi.sendMessage(
				{
					customType: "fleet-failure",
					content: `Crew worker **${w.name}** ${outcome} — ${reason}. Run \`fleet roster\` for the crew view; the run's record: ${record ?? "(not retained)"}.`,
					display: true,
				},
				{ triggerTurn: false },
			);
		} catch {
			/* a completion callback must never throw into the event bus */
		}
	}

	/**
	 * The RPC `spawn` reply body is the TOOL RESULT (`{text, details}`), not a
	 * `{id}` object (pi-subagents/src/extension/rpc.ts executeChecked →
	 * dataFromToolResult). The run handle therefore has to be dug out: first a
	 * structured field anywhere in `details`, then the first uuid in the receipt
	 * text. When neither yields, the tool reports `receipt-unparsed` with an
	 * excerpt instead of silently recording a worker with no handle.
	 */
	function runIdOf(data: unknown): { id: string | null; excerpt?: string } {
		const seen = new Set<unknown>();
		const dig = (v: unknown, depth: number): string | null => {
			if (depth > 4 || v === null || typeof v !== "object" || seen.has(v)) return null;
			seen.add(v);
			const rec = v as Record<string, unknown>;
			for (const k of ["asyncRunId", "runId", "asyncId", "id"]) {
				const cand = rec[k];
				if (typeof cand === "string" && cand.trim().length > 0) return cand;
			}
			for (const val of Object.values(rec)) {
				const found = dig(val, depth + 1);
				if (found) return found;
			}
			return null;
		};
		const structured = dig(data, 0);
		if (structured) return { id: structured };
		const text =
			typeof data === "object" && data !== null
				? String((data as { text?: unknown }).text ?? "")
				: "";
		const uuid =
			text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? null;
		return { id: uuid, excerpt: text.slice(0, 240) };
	}

	function childIndexOf(data: unknown): number {
		const d = data as Record<string, unknown> | undefined;
		const i = d?.childIndex ?? d?.index;
		return typeof i === "number" ? i : 0;
	}

	/**
	 * Adopt the LIVE handle a resume just created. `resume` revives into a NEW
	 * async run (verified live: handle 30815ebd → run da3f8457), so the
	 * pre-resume id is dead the moment the reply lands — keeping it made the next
	 * steer refuse with the OLD terminal state and made retire skip the clock-out.
	 *
	 * The new id is taken from the reply's own fields (`details.asyncId` is the
	 * revived run in pi-subagents' receipt), then from an id the status snapshot
	 * actually knows, then from the live row that newly appeared in the snapshot.
	 * A handle is only adopted when the snapshot confirms the id (or when it came
	 * from pi-subagents' structured receipt); when nothing can be confirmed the
	 * worker is flagged unverified rather than left pointed at a dead run.
	 */
	async function adoptResumedHandle(
		w: roster.Worker,
		replyData: unknown,
		before: RunRow[],
	): Promise<{ id: string; index: number; source: "reply" | "snapshot" } | null> {
		const prev = w.asyncRunId;
		const cands = adoptionCandidates(replyData, prev);
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) await new Promise((res) => setTimeout(res, 400));
			const rows = await statusRows();
			for (const c of cands.structured) {
				const row = rows.find((x) => x.id === c);
				if (row)
					return {
						id: c,
						index: typeof row.index === "number" ? row.index : w.childIndex,
						source: "reply",
					};
			}
			for (const c of cands.fromText) {
				const row = rows.find((x) => x.id === c);
				if (row && isLiveRow(row))
					return {
						id: c,
						index: typeof row.index === "number" ? row.index : w.childIndex,
						source: "reply",
					};
			}
			// pi-subagents documents `details.asyncId` as the revived run, so it is
			// adopted even if this snapshot has not caught up with it yet.
			if (attempt === 2 && cands.structured.length) {
				return { id: cands.structured[0], index: w.childIndex, source: "reply" };
			}
			const born = newLiveRows(rows, [prev], before);
			if (born.length) {
				born.sort((a, b) => (rowLastActivity(b) ?? 0) - (rowLastActivity(a) ?? 0));
				const pick = born[0];
				if (typeof pick.id === "string") {
					return {
						id: pick.id,
						index: typeof pick.index === "number" ? pick.index : w.childIndex,
						source: "snapshot",
					};
				}
			}
		}
		return null;
	}

	/**
	 * Release the claims of workers whose run is PROVABLY GONE — what a reboot
	 * leaves behind.
	 *
	 * A detached crew dies with the machine: the process is gone, the run record
	 * went with the temp root it lived in, and pi-subagents answers `No async run
	 * found` to every steer. Nothing else settles such a worker: the reconcile above
	 * needs a row and there is none, `retire` cannot deliver a clock-out, and
	 * `io_status reclaim` moves only the guard's generation — while the hire check
	 * reads the ROSTER, so the owned paths stay refused to every hire.
	 *
	 * The bar is `predicates.runProvablyGone`: a live row, a surviving run record, an
	 * unverified handle, or a process still holding the identity each leave the
	 * worker ALONE for the ordinary paths. Ambiguity is never released.
	 */
	function releaseGoneRuns(r: roster.Roster, rows: RunRow[]): roster.Worker[] {
		const known = rows.map((x) => x.id).filter((id): id is string => typeof id === "string");
		const released: roster.Worker[] = [];
		for (const w of r.crew) {
			if (!roster.holdsClaim(w)) continue;
			const lineage = [w.asyncRunId, ...w.runIds].filter(
				(id): id is string => typeof id === "string" && id.length > 0,
			);
			const gone = runProvablyGone({
				handleUnverified: w.handleUnverified,
				lineage,
				knownRunIds: known,
				ownerAlive: identityClaimLive(ioRoot(), w.name),
			});
			if (!gone) continue;
			releaseClaim(ioRoot(), w);
			released.push(w);
			hookLog("fleet", "claim-released-run-gone", {
				worker: w.name,
				owns: w.owns,
				lineage,
				evidence: "no run row, no surviving run record, no process holding the worker identity",
			});
		}
		return released;
	}

	function boardSession(): board.BoardSession | undefined {
		return crewCtx?.sessionManager as unknown as board.BoardSession | undefined;
	}

	/**
	 * Close the board rows a retirement leaves behind — a retired worker can no
	 * longer close its own. THE BOARD IS WRITTEN HERE AND NOWHERE ELSE, in the same
	 * replay-compatible record the crew's own todo proxy appends, so the closure is
	 * durable on this session's branch and the live view moves with it. A row
	 * another crew member completed on the same scope is marked SUPERSEDED rather
	 * than merely closed; the rules and the attribution live in board.ts, and a row
	 * the fleet cannot attribute with confidence is left alone and reported.
	 *
	 * The `retire` action reaches this with nothing to close except rows the worker
	 * opened after the guard passed (see the retire branch): the guard refuses while
	 * any of its rows is still open. The reconcile and the gone-run pass close the
	 * rows of workers no caller can be refused for.
	 */
	function closeBoardRows(r: roster.Roster, workers: roster.Worker[]): unknown[] {
		const session = boardSession();
		if (!session || workers.length === 0) return [];
		const sidNow = sid(crewCtx ?? {});
		const emit = (channel: string, payload: unknown): void =>
			(pi as unknown as { events?: { emit?: (c: string, p: unknown) => void } }).events?.emit?.(
				channel,
				payload,
			);
		const out: unknown[] = [];
		for (const w of workers) {
			const report = board.closeRetiredWorkerRows(
				{ name: w.name, scope: w.scope, authored: w.authored },
				{ session, sid: sidNow, crew: r.crew, emit },
			);
			if (report.closed.length || report.untouched.length || report.refused.length)
				out.push(board.render(report));
		}
		return out;
	}

	function nextLegal(w: roster.Worker): string[] {
		if (w.state === "retired") return ["roster", "hire"];
		// A handed-off worker is done HERE: the successor steers, assigns or retires it.
		if (w.state === "handed-off") return ["roster", "hire", "handoff"];
		// A `retiring` worker is NOT a dead end: re-running retire settles it (the
		// clock-out is re-sent, and a run that already finished flips to `retired`).
		if (w.state === "retiring") return ["retire", "roster", "hire"];
		// A `not-resumable` worker's run is dead (`predicates.FINISHED`), so retire
		// settles it as a plain transition and closes its rows: listing it without
		// `retire` would describe a worker no action could settle.
		if (w.state === "not-resumable") return ["retire", "roster", "hire"];
		if (w.state === "completed" || w.state === "failed" || w.state === "stopped")
			return ["retire", "roster"];
		return ["assign", "steer", "retire", "roster"];
	}

	/** Remember every async run id a worker has used, so its figures union across
	 *  resumes instead of resetting to the newest run. */
	function trackRun(w: roster.Worker): void {
		if (w.asyncRunId && !w.runIds.includes(w.asyncRunId)) w.runIds.push(w.asyncRunId);
	}

	/**
	 * The runs that settled AFTER this session's crew was published — the successor's
	 * answer to "what landed since I took over?".
	 *
	 * It is a re-runnable READ, never a step of `adopt`: a worker can settle minutes
	 * after an adoption, and its completion notice then reaches a session that has
	 * exited, so the answer must be recomputable on any later roster pass. The publish
	 * time comes from the sheet the worker's `adoptedFrom` names, so the comparison is
	 * against the handoff, not against when this session happened to take it over.
	 *
	 * Null for a worker hired by this session (no publish to compare against); the
	 * publish time alone is null when its sheet can no longer be read, and the report
	 * says so instead of comparing against a zero.
	 */
	function landingsReport(w: roster.Worker): Record<string, unknown> | null {
		if (!w.adoptedFrom) return null;
		const sheet = w.adoptedFrom.sheet;
		const publishedAt = adopt.publishedAt(sheet);
		if (publishedAt === null) {
			return {
				sheet,
				publishedAt: null,
				publishedAtIso: null,
				runs: [],
				note: `the sheet ${sheet} cannot be read, so the publish time is unknown and no comparison is possible`,
			};
		}
		const runs = landingsSince(w.runIds, publishedAt) ?? [];
		return {
			sheet,
			publishedAt,
			publishedAtIso: new Date(publishedAt).toISOString(),
			runs,
			...(runs.length
				? {}
				: {
						note: "nothing settled after the publish: every run of this worker that has a recorded end time ended at or before it",
					}),
		};
	}

	/** The worker's last run in report shape, or the sentence that says why there is
	 *  none. `lastRunOutcome` is the ONE producer of the shape, so a roster row, a
	 *  handoff sheet and an adoption entry cannot describe the same run differently. */
	function lastRunField(w: roster.Worker): Record<string, unknown> {
		const last: RunOutcome | null = lastRunOutcome(w.runIds);
		if (last) return { lastRun: last };
		return {
			lastRun: null,
			lastRunUnavailable:
				"no run record resolves for this worker (async-subagent-runs/<runId>/status.json absent or pruned), so its last run's state, end time and artifact locations cannot be reported",
		};
	}

	// Artifact stat-check helper (kept here so predicates stay pure).
	function artifactsOk(paths: unknown): string | null {
		if (!Array.isArray(paths)) return null;
		for (const p of paths as string[]) {
			try {
				if (!existsSync(p) || !statSync(p).isFile())
					return `artifacts: '${p}' does not exist — pass a real path or drop it.`;
			} catch {
				return `artifacts: '${p}' does not exist — pass a real path or drop it.`;
			}
		}
		return null;
	}
}
