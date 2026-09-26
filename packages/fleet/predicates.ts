/**
 * fleet/predicates — the pure rules (no I/O): name/handle shapes, claim overlap,
 * review eligibility, timeout range, task serialization and every refusal string.
 * Unit-testable by construction; the I/O lives in status.ts / launch.ts / roster.ts.
 */
import { escapeRe, globOverlap } from "@tinoy/pi-ext-lib";

/**
 * A worker name: lowercase letters, digits, '-' — never an id shape. A name is an
 * identifier other layers key on (reviews, steering, claims, the board) AND a
 * filename component (`<handoff dir>/<name>.md`), so this is also the rule for what
 * may become a path segment — enforced where a name is ACCEPTED, not only where one
 * is resolved.
 */
export function isNameLike(s: string): boolean {
	return /^[a-z][a-z0-9-]{0,31}$/.test(s);
}

/**
 * The refusal for a caller-supplied name that is not an id and still cannot be a
 * name. The shape is refused, never silently replaced, and the message carries the
 * rule itself so the caller does not have to find the predicate to learn it.
 */
export function notANameMessage(name: string): string {
	return `fleet addresses workers by NAME: a name is lowercase letters, digits and '-' (at most 32 characters, starting with a letter) — ${JSON.stringify(name)} is not one, and a name is also the handoff filename, so it has to be a filename component. Give the worker a name of its own: the caller supplies every name, and there is no default pool.`;
}

/** A raw id the model must never pass: uuid, or a 12+ char hex/dash run. */
export function isIdLike(s: string): boolean {
	return (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
		/^[0-9a-f]{12,}$/i.test(s)
	);
}

export interface Claim {
	path: string;
	owner: string;
	since: number;
}

/** The first existing claim that collides with `want`, or null. */
export function claimConflict(existing: Claim[], want: string[]): Claim | null {
	for (const w of want) for (const c of existing) if (globOverlap(w, c.path)) return c;
	return null;
}

/** The declared "no claim" sentinel — the same word in BOTH `owns` and
 *  `exclusive`, meaning "this task writes/holds nothing". It is never a claim. */
export const NO_CLAIM = "none";

/** The sentinel may stand alone; a mixed list is refused (one shape for both fields). */
function normalizeNoClaimField(
	field: string,
	v: string[],
): { ok: true; tokens: string[] } | { ok: false; message: string } {
	const real = v.filter((t) => t.trim() !== "");
	if (real.includes(NO_CLAIM) && real.length > 1) {
		return {
			ok: false,
			message: `${field}:["none"] is a sentinel — it cannot be combined with real tokens (${real.filter((t) => t !== NO_CLAIM).join(", ")}). Pass either the sentinel alone or the real tokens.`,
		};
	}
	// A node_modules path is never a claim. That tree is npm-managed, and `npm install`
	// both prunes an undeclared link there and DELETES what the link points at — so a
	// worker told it owns that path is pointed at a directory that can vanish under it
	// mid-task. The source path the link points at is the thing to claim.
	const managed = real.filter((t) => t !== NO_CLAIM && /(^|\/)node_modules(\/|$)/.test(t));
	if (managed.length > 0) {
		return {
			ok: false,
			message: `${field}: "${managed[0]}" is inside node_modules, which npm manages — an install there prunes undeclared links and deletes their targets. Claim the SOURCE path the link points at instead.`,
		};
	}
	return { ok: true, tokens: real.filter((t) => t !== NO_CLAIM) };
}

/** `owns` normalisation: `["none"]` means "writes nothing" (never a real path). */
export function normalizeOwns(
	v: string[],
): { ok: true; tokens: string[] } | { ok: false; message: string } {
	return normalizeNoClaimField("owns", v);
}

/** `exclusive` normalisation: the same sentinel rule as `owns`. */
export function normalizeExclusive(
	v: string[],
): { ok: true; tokens: string[] } | { ok: false; message: string } {
	return normalizeNoClaimField("exclusive", v);
}

export function clampTimeout(ms: number | undefined): string | null {
	if (ms === undefined) return null;
	if (!Number.isFinite(ms)) return "timeoutMs must be a number.";
	if (ms < 600_000)
		return "timeoutMs 300000 is below the 10m floor (a mid-work kill loses the run).".replace(
			"300000",
			String(ms),
		);
	if (ms > 86_400_000) return `timeoutMs ${ms} is above the 24h ceiling.`;
	return null;
}

/**
 * Task text → one string. Arrays of lines are joined; a bare STRING is accepted
 * as one line. The string branch is deliberate: pi coerces a bare string into a
 * one-element array at the tool boundary (measured — an array-typed parameter
 * receives `["…"]`), so a bare string is a legitimate call shape and refusing it
 * would be a claim the tool can never act on. Empty text and empty/non-string
 * lines are still refused.
 */
export function serializeTask(
	task: unknown,
): { ok: true; text: string } | { ok: false; message: string } {
	const lines: unknown[] | null = Array.isArray(task)
		? task
		: typeof task === "string"
			? [task]
			: null;
	if (lines === null) {
		return {
			ok: false,
			message:
				"task must be text: an array of strings (one per line), or a bare string for a one-line task.",
		};
	}
	if (lines.length === 0) {
		return {
			ok: false,
			message:
				"task is empty: pass the task text as an array of lines, or a bare string for a one-line task.",
		};
	}
	const bad = lines.findIndex((l) => typeof l !== "string" || (l as string).trim() === "");
	if (bad >= 0) {
		return {
			ok: false,
			message: `task line ${bad + 1} is empty or not a string: every line must carry text.`,
		};
	}
	return { ok: true, text: (lines as string[]).join("\n") };
}

/** States in which a run is already OVER — no clock-out steer can land. */
const FINISHED = new Set(["complete", "completed", "failed", "stopped", "not-resumable"]);

/**
 * Steer refusals that mean the RUN IS GONE rather than busy: pi-subagents has no
 * async run under that id any more. `No async run found for '<id>'.` is what a
 * reboot leaves behind — the detached run died with the machine and pi-subagents that
 * would steer it came back with no memory of it — so it settles the worker exactly
 * like an already-finished run: there is no process to clock out, and no handoff
 * is coming either.
 */
const RUN_GONE =
	/not running or queued|cannot be steered|no persisted session|not resumable|no async run found|no async run status/i;

/**
 * How a retire settles. A FINISHED run — pi-subagents' row is terminal, or the
 * owner refuses the steer because it is not steerable — retires as a plain
 * transition: a dead run cannot write a handoff, and leaving the worker
 * `retiring` is a limbo nothing can clear. A delivered steer leaves it
 * `retiring` (the worker writes the handoff and reports CLOCKED OUT); a
 * transient steer fault also stays `retiring` and another retire retries it.
 */
export function retireDisposition(
	workerState: string,
	rowState: string | undefined,
	steer: { ok: true } | { ok: false; message: string },
): { state: "retired" | "retiring"; finished: boolean; detail: string } {
	const row = (rowState ?? "").toLowerCase();
	if (FINISHED.has(workerState) || FINISHED.has(row)) {
		return {
			state: "retired",
			finished: true,
			detail: FINISHED.has(row) ? `run ${row}` : `worker ${workerState}`,
		};
	}
	if (!steer.ok && RUN_GONE.test(steer.message)) {
		return {
			state: "retired",
			finished: true,
			detail: "the run is not steerable (already finished, or gone with its process)",
		};
	}
	return { state: "retiring", finished: false, detail: steer.ok ? "steer sent" : steer.message };
}

/**
 * The evidence that a worker's run is PROVABLY GONE — the shape a reboot leaves.
 *
 * A detached crew is killed with the machine: its process is gone, the run record
 * died with the temp root it lived in, and pi-subagents answers `No async run found`
 * to every steer. Such a worker holds its claim for nobody, and no other route can
 * settle it — the run-row reconcile has no row to read, and a clock-out steer has
 * nothing to land in.
 *
 * Every fact must point the same way, or the worker is left ALONE for the ordinary
 * paths: a run id the roster cannot vouch for (`handleUnverified`), a run id still
 * known to pi-subagents or surviving as a record, or a process still holding the
 * worker's identity, each answers false.
 */
export function runProvablyGone(facts: {
	handleUnverified: boolean;
	/** Every async run id the worker's handle lineage has used. */
	lineage: string[];
	/** Run ids pi-subagents' snapshot or a surviving run record still knows. */
	knownRunIds: string[];
	/** True while a process holds the worker's identity claim. */
	ownerAlive: boolean;
}): boolean {
	if (facts.handleUnverified || facts.ownerAlive) return false;
	return !facts.lineage.some((id) => facts.knownRunIds.includes(id));
}

/**
 * The refusal for a retirement blocked by the retiree's own OPEN board rows. The
 * rows are named so the caller can deal with them: the board is the crew's
 * at-a-glance state, and a worker clocked out with a pending row leaves the board
 * saying work is outstanding that nobody owns.
 *
 * There is no override. The escape is the board write itself — the foreman closes or
 * completes the row it judges dead — which is loud and leaves evidence, unlike a flag
 * that would let a dirty board past in silence.
 */
export function openBoardRowsMessage(
	worker: string,
	rows: Array<{ id: number; subject: string; status: string }>,
): string {
	const shown = rows.slice(0, 8).map((r) => `#${r.id} "${r.subject}" (${r.status})`);
	if (rows.length > shown.length) shown.push(`…(+${rows.length - shown.length} more)`);
	return (
		`${worker} still owns ${rows.length} open board ${rows.length === 1 ? "row" : "rows"}: ${shown.join(", ")}. ` +
		`Retiring now would close them as abandoned or superseded, which is exactly the dirty-board state this guard exists to surface. ` +
		`Complete them first — steer the worker, or close a row yourself when its work was dropped — then retire ${worker}.`
	);
}

/** Review eligibility: available state and no authorship of the target.
 *  Authorship is decided by the declared scope/owns AND by the target naming the
 *  worker — a prose target (report title, "author: alice") must not smuggle the
 *  author past the non-author rule just because it is not a path. */
export function reviewEligible(
	w: { name: string; state: string; authored: string[] },
	target: string,
): { ok: true } | { ok: false; reason: "author" | "unavailable" } {
	if (w.state === "retiring" || w.state === "retired" || w.state === "not-resumable")
		return { ok: false, reason: "unavailable" };
	if (targetNamesWorker(w.name, target)) return { ok: false, reason: "author" };
	if (w.authored.some((a) => a === target || globOverlap(a, target)))
		return { ok: false, reason: "author" };
	return { ok: true };
}

/** True when the target string names the worker as a whole word: `alice`,
 *  `author: alice`, `alice's fix` — but not `alice2` or `alice-x`. */
export function targetNamesWorker(name: string, target: string): boolean {
	if (!name) return false;
	return new RegExp(`(^|[^a-z0-9-])${escapeRe(name)}([^a-z0-9-]|$)`, "i").test(target);
}
