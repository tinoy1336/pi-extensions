/**
 * io-guard/predicates — the pure rules. No I/O, no process state.
 *
 * Scope semantics are IMPORTED from the fleet's own predicates rather than
 * reimplemented: one owner decides what "this path is inside that claim" means,
 * so the guard and the dispatcher can never disagree about a glob.
 */
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { globOverlap } from "../fleet/predicates.ts";

/** The binding namespace the fleet dispatches under. A binding in any other
 *  namespace belongs to some other extension and identifies nothing. */
export function isFleetNamespace(key: string): boolean {
	return /^fleet\/[1-9]\d*$/.test(key);
}

/** True when `p` is `prefix` itself or sits underneath it. Compares on path
 *  segments so `/a/bc` is not treated as living under `/a/b`. */
export function within(p: string, prefix: string): boolean {
	const a = p.replace(/\/+$/, "");
	const b = prefix.replace(/\/+$/, "");
	return a === b || a.startsWith(`${b}/`);
}

/** True when the file's basename marks it as belonging to this worker. */
export function basenameOwnedBy(p: string, worker: string): boolean {
	const base = p.slice(p.lastIndexOf("/") + 1);
	return base === `${worker}.md` || base.startsWith(`${worker}-`) || base.startsWith(`${worker}.`);
}

/**
 * One canonical form per path, so a read logged as `src/a.ts` and a write
 * expressed as an absolute path are the SAME key. `~` is expanded and relative
 * paths resolve against the working directory.
 */
export function canonicalPath(p: string, cwd: string): string {
	let out = p;
	if (out === "~") out = homedir();
	else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
	if (!isAbsolute(out)) out = resolve(cwd, out);
	return normalize(out);
}

/** Claims are declared repo-relative; file paths arrive absolute. Resolve every
 *  glob against the worker's working directory before comparing. */
export function absoluteGlobs(globs: string[], cwd: string): string[] {
	return globs.map((g) => (isAbsolute(g) ? normalize(g) : join(cwd, g)));
}

/**
 * Paths a crew worker may write without holding a claim. Deliberately narrow:
 * its own handoff, its own report files, its own scratch directory, and its own
 * dedicated temporary directory.
 *
 * `tmpdir` must be the worker's OWN temp directory, never the ambient system temp:
 * allowlisting `/tmp` would exempt every path under it, which silently disables the
 * guard for anything a worker stages there. A peer's handoff, the roster, the mode
 * files and the io state are excluded too — those need a claim.
 */
export function isAlwaysAllowed(p: string, worker: string, home: string, tmpdir: string): boolean {
	const root = `${home}/.local/pi/foreman`;
	if (within(p, `${root}/handoffs`) && basenameOwnedBy(p, worker)) return true;
	if (within(p, `${root}/reports`) && basenameOwnedBy(p, worker)) return true;
	if (within(p, `${root}/io/scratch/${worker}`)) return true;
	if (tmpdir && within(p, tmpdir)) return true;
	return false;
}

/** True when `p` falls inside any of the worker's declared globs. */
export function pathInScope(p: string, globs: string[]): boolean {
	for (const g of globs) {
		if (g === "none") continue;
		if (globOverlap(g, p)) return true;
	}
	return false;
}

/** A read tool call asked for the whole file (no window), which is necessary but
 *  NOT sufficient: the tool also truncates large output, and a truncated read is
 *  not a whole-file read however it was requested. */
export function isFullRead(offset: unknown, limit: unknown): boolean {
	return offset === undefined && limit === undefined;
}

/** Did the read tool report truncation? A truncated read must never be treated
 *  as a merge base. */
export function wasTruncated(details: unknown): boolean {
	const d = details as { truncation?: { truncated?: unknown } } | undefined;
	return d?.truncation?.truncated === true;
}
