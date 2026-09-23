/**
 * neighbour — the guarded, cached dynamic import for anything a user may not
 * have installed.
 *
 * An extension that needs a package the user did not install must not fail to
 * load: a static import of an absent module is a loader error row, the whole
 * extension is dropped, and every feature it carried goes with it. Resolving the
 * neighbour here keeps the extension loaded, reports the absence once by name,
 * and lets the caller refuse only the capability that needed it.
 *
 * Guarantees, in the order they matter:
 *   - it never throws: a rejected import and a throw inside `load` both answer
 *     null;
 *   - each `(source, neighbour)` pair resolves ONCE per process, so a hot path
 *     cannot re-attempt an absent import on every call;
 *   - exactly one `neighbour-absent` diagnostics line is emitted per absent pair
 *     per process, carrying the neighbour, the lost capability and the fix.
 *
 * The cache is keyed by reporting package AND neighbour. One extension's absent
 * neighbour therefore never masks another's present one, two packages reaching
 * the same absent neighbour each report it under their own source (their effects
 * differ), and a second call site in one package reuses the first resolution.
 */
import { hookLog } from "./hook-log.ts";

/** What a call site states so an absence is actionable rather than merely visible. */
export interface NeighbourReport {
	/** The reporting package, as it appears in the diagnostics log. */
	source: string;
	/** What is lost while the neighbour is absent, in one clause. */
	effect: string;
	/** The install command or setting that restores the capability. */
	hint?: string;
}

/** One resolution per reporting package and neighbour, per process. */
const resolutions = new Map<string, Promise<unknown>>();

/** One report per absent pair, per process: repeated calls never repeat the line. */
const reported = new Set<string>();

function keyOf(source: string, neighbour: string): string {
	return `${source}\u0000${neighbour}`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve an optional neighbour, or answer null when it cannot be loaded.
 *
 * ```ts
 * const rpiv = await optionalNeighbour(
 *   "@juicesharp/rpiv-todo",
 *   () => import("@juicesharp/rpiv-todo/state/state-reducer.js"),
 *   {
 *     source: "todo-parent",
 *     effect: "the child-to-parent todo relay cannot apply a mutation",
 *     hint: "pi install npm:@juicesharp/rpiv-todo",
 *   },
 * );
 * if (!rpiv) return refusal("todo_parent: the rpiv-todo state reducer is not installed");
 * ```
 */
export function optionalNeighbour<T>(
	neighbour: string,
	load: () => Promise<T>,
	report: NeighbourReport,
): Promise<T | null> {
	const key = keyOf(report.source, neighbour);
	const cached = resolutions.get(key);
	if (cached) return cached as Promise<T | null>;
	// Promise.resolve().then(load) also catches a `load` that throws synchronously.
	const pending: Promise<T | null> = Promise.resolve()
		.then(load)
		.catch((error: unknown) => {
			if (!reported.has(key)) {
				reported.add(key);
				hookLog(report.source, "neighbour-absent", {
					neighbour,
					effect: report.effect,
					...(report.hint ? { hint: report.hint } : {}),
					reason: messageOf(error),
				});
			}
			return null;
		});
	resolutions.set(key, pending);
	return pending;
}
