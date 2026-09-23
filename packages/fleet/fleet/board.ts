/**
 * fleet/board — the fleet's ONE write to the crew's todo board: closing the open
 * rows a retirement leaves behind.
 *
 * The board belongs to the workers, and a worker that has been retired can no
 * longer close its own rows. An open row left behind is not harmless: the board is
 * the at-a-glance state of the crew, so a row that stays pending for ever makes it
 * lie. Retirement therefore closes them — marked SUPERSEDED where another crew
 * member completed the same scope, and closed as an abandoned row otherwise,
 * because "someone else did it" and "it was dropped" are different facts.
 *
 * The write uses the SAME channel the crew already uses, never a second one. A
 * worker's mutation reaches this board through `todo_parent`, which records it by
 * appending a replay-compatible `todo` toolResult to the foreman session's branch
 * and emitting `rpiv-todo:external-refresh`; the package's own `replayFromBranch`
 * is the authority for what the board holds. So: replay the branch, apply the
 * closure through the package's own PURE reducer, append the result in the same
 * row shape, emit the same refresh event. Nothing here invents a state format, and
 * every row appended this way survives replay exactly as a worker's own row does.
 *
 * In the OTHER direction the same rules answer the retire GUARD: a retirement is
 * refused while the worker still owns open rows, because closing them is exactly
 * what would hide the fact that the worker stopped with work unfinished. The guard
 * is a READ (`openRowsFor`) and runs before any reconciliation, so a refusal leaves
 * the board, the roster and the claim exactly as it found them.
 *
 * The rules are pure (`rowWorker`, `sameScope`, `openRowsOf`, `planClosures`,
 * `closedSubject`, `closedDescription`) and take every input as an argument; only
 * `openRowsFor` and `closeRetiredWorkerRows` touch the session manager.
 */

import { optionalNeighbour } from "@tinoy/pi-ext-lib";
import { globOverlap } from "./predicates.ts";

/** The board's optional neighbour: its PURE reducer and its branch replay. */
const RPIV = "@juicesharp/rpiv-todo";
type RpivReplay = (input: { sessionManager: unknown }) => { tasks?: unknown };
type RpivApply = (
	state: unknown,
	op: string,
	patch: Record<string, unknown>,
) => { op: { kind: string; message?: string }; state: unknown };
interface RpivBoard {
	replayFromBranch: RpivReplay;
	applyTaskMutation: RpivApply;
}
let board: RpivBoard | null = null;
let warming: Promise<boolean> | null = null;

/**
 * Resolve the board's neighbour once, at CALL time. A static import would stop pi-fleet
 * loading at all on a machine without @juicesharp/rpiv-todo, and resolving at module scope
 * would put the work in the load path (R1). Both modules come from ONE guarded resolution,
 * so an absent package produces exactly one report rather than one per module.
 */
export function warmBoard(): Promise<boolean> {
	warming ??= (async () => {
		const rpiv = await optionalNeighbour(
			RPIV,
			async () => {
				const [replay, reducer] = await Promise.all([
					import("@juicesharp/rpiv-todo/state/replay.js"),
					import("@juicesharp/rpiv-todo/state/state-reducer.js"),
				]);
				return {
					replayFromBranch: replay.replayFromBranch,
					applyTaskMutation: reducer.applyTaskMutation,
				};
			},
			{
				source: "fleet",
				effect: "the board cannot be read or written, so the crew's row closures stay unapplied",
				hint: "pi install npm:@juicesharp/rpiv-todo",
			},
		);
		if (rpiv) {
			board = {
				replayFromBranch: rpiv.replayFromBranch as RpivReplay,
				applyTaskMutation: rpiv.applyTaskMutation as RpivApply,
			};
		}
		return board !== null;
	})();
	return warming;
}

/** A board row as the branch holds it — the package's own task shape, read back
 *  through `replayFromBranch`. */
export interface BoardRow {
	id: number;
	subject: string;
	status: string;
	description?: string;
}

/** The statuses a row is still OPEN in — the same two the package counts as
 *  active, so "open" means one thing on this board. `deleted` is terminal there
 *  and is not reached from here. */
export const OPEN_STATUSES: readonly string[] = ["pending", "in_progress"];

/** The closure markers. They live in the SUBJECT because that is what the compact
 *  board view renders, so the fact is legible without opening the row. */
export const SUPERSEDED_MARK = "[superseded by ";
export const ABANDONED_MARK = "[abandoned: ";

/** The refresh channel `todo_parent` emits on after every branch write. */
export const REFRESH_CHANNEL = "rpiv-todo:external-refresh";

/** What a row can be attributed to, and what a scope match compares. `authored`
 *  is the fleet's own record of the scope and paths a worker declared. */
export interface CrewPeer {
	name: string;
	scope: string;
	authored: string[];
}

// ── Pure: attribution ──

/**
 * The worker a row's subject attributes it to. The crew's convention is
 * `<name>: <imperative subject>` and NOTHING else counts as an attribution: a
 * subject without that prefix belongs to no worker with confidence, and guessing
 * would write a false owner onto the board the user reads.
 */
export function rowWorker(subject: unknown): string | null {
	if (typeof subject !== "string") return null;
	const found = /^([a-z][a-z0-9-]*):/.exec(subject.trim());
	return found === null ? null : found[1];
}

/** True when the row already carries a closure marker, so a row reopened by hand
 *  never collects a second one. */
export function markedClosed(subject: string): boolean {
	return subject.includes(SUPERSEDED_MARK) || subject.includes(ABANDONED_MARK);
}

/** A row that is still open and attributable to one worker — what the retire
 *  guard refuses on. */
export interface OpenRow {
	id: number;
	subject: string;
	status: string;
}

/**
 * The rows one worker still owns open. Both halves are the rules above: OPEN means
 * the same two statuses the package counts as active, and attribution is the same
 * `<name>:` subject prefix the closure uses, so the guard and the closure can never
 * disagree about which rows are whose.
 *
 * A row this cannot attribute — no prefix, or a prefix naming somebody else — is
 * NOT this worker's row and never blocks its retirement: refusing on a row the
 * board does not attribute would block a legitimate retirement, and the board's
 * own convention (`<name>: <imperative subject>`, written by the worker when it
 * creates the row) is what makes the read sound.
 */
export function openRowsOf(rows: BoardRow[], worker: string): OpenRow[] {
	return rows
		.filter((row) => OPEN_STATUSES.includes(row.status) && rowWorker(row.subject) === worker)
		.map((row) => ({ id: row.id, subject: row.subject, status: row.status }));
}

/**
 * The retire guard's read: this session's board, and the open rows one worker still
 * owns on it. Read-only — it replays the branch and writes nothing, neither to the
 * board nor anywhere else, so a refusal leaves the session exactly as it found it.
 */
export function openRowsFor(session: BoardSession, worker: string): OpenRow[] {
	const api = board;
	if (!api) {
		// The neighbour is resolved on first use: this call reports it (once, by name) and the
		// next one has it. An unreadable board means no rows are visible, never a throw.
		void warmBoard();
		return [];
	}
	const state = api.replayFromBranch({ sessionManager: session });
	return openRowsOf((state.tasks ?? []) as BoardRow[], worker);
}

// ── Pure: the scope match ──

/**
 * Two crew members cover the same scope when their declared slice is the same
 * one: the scope strings are identical, or a declared claim of one overlaps a
 * declared claim of the other under the SAME overlap rule the claim guards use
 * (`predicates.globOverlap`) — the replacement hired for a retired worker's heap
 * carries that worker's scope, and a scope declared as a path family is the same
 * slice whether or not the words match.
 *
 * An empty declaration matches nothing. A worker that declared no scope supplies
 * no evidence, and supersession is a claim about who did what: it is never made
 * on an empty comparison.
 */
export function sameScope(a: CrewPeer, b: CrewPeer): boolean {
	const left = a.scope.trim();
	const right = b.scope.trim();
	if (left !== "" && left === right) return true;
	for (const x of a.authored) {
		for (const y of b.authored) {
			const p = x.trim();
			const q = y.trim();
			if (p !== "" && q !== "" && globOverlap(p, q)) return true;
		}
	}
	return false;
}

// ── Pure: the plan ──

export type RowOutcome = "superseded" | "abandoned";

export interface RowPlan {
	id: number;
	subject: string;
	outcome: RowOutcome;
	/** The crew member who completed the same scope; null on an abandoned row. */
	by: string | null;
	/** The completed row the supersession rests on. */
	evidence: { id: number; subject: string } | null;
	/** Why this outcome, in the report's own words. */
	why: string;
}

export interface RowSkip {
	id: number;
	subject: string;
	why: string;
}

export interface BoardPlan {
	close: RowPlan[];
	skip: RowSkip[];
}

/**
 * Which of the board's rows this retirement closes, and how. Only the RETIRING
 * worker's own open rows are eligible: a completed row is never touched, and a row
 * that belongs to another worker is never touched. Attribution is by the crew's
 * own `<name>:` prefix, so a row that carries no prefix, or one that names
 * something which is not a crew member of this session, is left alone and logged
 * rather than guessed at.
 */
export function planClosures(rows: BoardRow[], retiring: CrewPeer, crew: CrewPeer[]): BoardPlan {
	const close: RowPlan[] = [];
	const skip: RowSkip[] = [];
	const peers = crew.filter((c) => c.name !== retiring.name);
	// Which crew member covers this scope is a fact about the CREW, so it is
	// settled once, not per row. More than one candidate is ambiguity, and
	// ambiguity closes the row without claiming supersession: a wrong
	// "superseded" is a false statement about who did what.
	const candidates = peers.filter((p) => sameScope(retiring, p));
	const by = candidates.length === 1 ? candidates[0] : null;
	const ambiguous = candidates.length > 1 ? candidates.map((p) => p.name).join(", ") : null;

	for (const row of rows) {
		const owner = rowWorker(row.subject);
		if (!OPEN_STATUSES.includes(row.status)) {
			skip.push({
				id: row.id,
				subject: row.subject,
				why: `already ${row.status} — a closed row is never touched`,
			});
			continue;
		}
		if (owner === null) {
			skip.push({
				id: row.id,
				subject: row.subject,
				why: "no `<name>:` prefix in the subject, so the row cannot be attributed to a worker",
			});
			continue;
		}
		if (owner !== retiring.name) {
			skip.push({
				id: row.id,
				subject: row.subject,
				why: crew.some((c) => c.name === owner)
					? `belongs to ${owner}, who is not the retiring worker`
					: `names '${owner}', which is not a crew member of this session — attribution would be a guess`,
			});
			continue;
		}
		if (markedClosed(row.subject)) {
			skip.push({ id: row.id, subject: row.subject, why: "already carries a closure marker" });
			continue;
		}
		if (by === null) {
			close.push({
				id: row.id,
				subject: row.subject,
				outcome: "abandoned",
				by: null,
				evidence: null,
				why:
					ambiguous === null
						? `no other crew member covers ${retiring.name}'s scope, so no one is recorded as having done it`
						: `more than one crew member covers this scope (${ambiguous}), so which of them did it cannot be said`,
			});
			continue;
		}
		const evidence =
			rows
				.filter((r) => r.status === "completed" && rowWorker(r.subject) === by.name)
				.sort((a, b) => a.id - b.id)[0] ?? null;
		if (evidence === null) {
			close.push({
				id: row.id,
				subject: row.subject,
				outcome: "abandoned",
				by: null,
				evidence: null,
				why: `${by.name} covers the same scope but has completed no board row, so nothing says this work was done`,
			});
			continue;
		}
		close.push({
			id: row.id,
			subject: row.subject,
			outcome: "superseded",
			by: by.name,
			evidence: { id: evidence.id, subject: evidence.subject },
			why: `${by.name} covers ${retiring.name}'s scope and completed row #${evidence.id}`,
		});
	}
	return { close, skip };
}

/** The subject a closed row carries. */
export function closedSubject(row: BoardRow, plan: RowPlan, retiring: CrewPeer): string {
	return plan.outcome === "superseded"
		? `${row.subject} ${SUPERSEDED_MARK}${plan.by}]`
		: `${row.subject} ${ABANDONED_MARK}${retiring.name} retired]`;
}

/** The row's description with the closure note appended. The worker's own note is
 *  kept, never replaced: the row is closed, not rewritten. */
export function closedDescription(row: BoardRow, plan: RowPlan, retiring: CrewPeer): string {
	const note =
		plan.outcome === "superseded"
			? `closed when ${retiring.name} was retired: ${plan.by} had already completed the same scope (row #${plan.evidence?.id} "${plan.evidence?.subject}").`
			: `closed when ${retiring.name} was retired: no other crew member completed this scope, so the row closed without being done.`;
	const existing = typeof row.description === "string" ? row.description.trim() : "";
	return existing === "" ? note : `${existing}\n${note}`;
}

// ── I/O: the branch write ──

/** The session-manager surface this module needs, and no more: the same two
 *  methods `todo_parent` writes the board with. */
export interface BoardSession {
	getBranch(): Iterable<unknown>;
	appendMessage?(message: unknown): void;
}

export interface BoardCtx {
	session: BoardSession;
	/** The session whose board this is — the refresh event names it, so a peer
	 *  process's board is never moved. */
	sid: string;
	/** The whole crew, as declared. */
	crew: CrewPeer[];
	emit?: (channel: string, payload: unknown) => void;
}

export interface BoardReport {
	closed: Array<{
		id: number;
		subject: string;
		outcome: RowOutcome;
		by: string | null;
		why: string;
	}>;
	untouched: RowSkip[];
	/** Rows the reducer refused, left open. */
	refused: string[];
	appended: boolean;
	refreshed: boolean;
}

/**
 * Close the retiring worker's open rows on this session's board — durable on the
 * branch first, then the live-view refresh. A row that the reducer refuses stays
 * open and is reported; nothing is ever silently dropped, and a failed append
 * leaves the report saying the rows are still open.
 */
export function closeRetiredWorkerRows(retiring: CrewPeer, ctx: BoardCtx): BoardReport {
	const api = board;
	if (!api) {
		void warmBoard();
		return {
			closed: [],
			untouched: [],
			refused: [
				`the board needs ${RPIV}, which is not installed: ${retiring.name}'s rows stay open`,
			],
			appended: false,
			refreshed: false,
		};
	}
	const state = api.replayFromBranch({ sessionManager: ctx.session });
	const rows = (state.tasks ?? []) as BoardRow[];
	const plan = planClosures(rows, retiring, ctx.crew);
	const report: BoardReport = {
		closed: [],
		untouched: plan.skip,
		refused: [],
		appended: false,
		refreshed: false,
	};
	if (plan.close.length === 0) return report;

	let next = state;
	for (const item of plan.close) {
		const row = rows.find((r) => r.id === item.id);
		if (row === undefined) continue;
		const result = api.applyTaskMutation(next, "update", {
			id: item.id,
			status: "completed",
			subject: closedSubject(row, item, retiring),
			description: closedDescription(row, item, retiring),
		});
		if (result.op.kind === "error") {
			report.refused.push(`#${item.id} left open: ${result.op.message}`);
			continue;
		}
		next = result.state;
		report.closed.push({
			id: item.id,
			subject: item.subject,
			outcome: item.outcome,
			by: item.by,
			why: item.why,
		});
	}
	if (report.closed.length === 0) return report;

	// The durable record: one replay-compatible `todo` toolResult carrying the
	// accumulated board, exactly the shape the crew's own proxy appends. One row
	// per retirement, so the live view moves once.
	const details = {
		action: "update",
		params: { ids: report.closed.map((c) => c.id), status: "completed", by: "fleet retirement" },
		tasks: next.tasks,
		nextId: next.nextId,
	};
	try {
		ctx.session.appendMessage?.({
			role: "toolResult",
			toolCallId: `fleet-board-${Date.now()}-${process.pid}`,
			toolName: "todo",
			content: [{ type: "text", text: "fleet retirement closed the retiring worker's board rows" }],
			details,
			isError: false,
			timestamp: Date.now(),
		});
		report.appended = true;
	} catch {
		/* the report says whether the durable write landed */
	}
	if (report.appended) {
		try {
			ctx.emit?.(REFRESH_CHANNEL, { sid: ctx.sid });
			report.refreshed = true;
		} catch {
			/* a refresh fault must never fail a retirement */
		}
	}
	return report;
}

/** The report as a tool result carries it: one bounded line per row. */
export function render(report: BoardReport): Record<string, unknown> {
	const capped = (lines: string[], what: string): string[] =>
		lines.length <= 8 ? lines : [...lines.slice(0, 8), `…(+${lines.length - 8} more ${what})`];
	return {
		closed: report.closed.map((c) =>
			c.outcome === "superseded"
				? `#${c.id} "${c.subject}" — SUPERSEDED by ${c.by} (${c.why})`
				: `#${c.id} "${c.subject}" — closed, not done (${c.why})`,
		),
		untouched: capped(
			report.untouched.map((s) => `#${s.id} "${s.subject}" left as-is: ${s.why}`),
			"left as-is",
		),
		...(report.refused.length ? { refused: report.refused } : {}),
		board:
			report.closed.length === 0
				? "nothing to close"
				: report.appended
					? report.refreshed
						? "closed on the session branch and the live board was refreshed"
						: "closed on the session branch; the live-view refresh could not be emitted"
					: "NOT closed: the branch append failed, so these rows are still open",
	};
}
