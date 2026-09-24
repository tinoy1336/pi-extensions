/**
 * glob.ts — path/glob overlap, the predicate the fleet and its claim guard must agree on.
 *
 * `globOverlap` answers "do these two path patterns address the same tree": an exact
 * match, either side a directory prefix of the other, or a `*` wildcard anywhere in
 * either side. It lives here because both extension packages that ask the question
 * need the same answer, and a shared library is a cheaper owner than a dependency
 * between the two packages.
 */

/** Glob/path overlap: exact, directory prefix, or '*' anywhere in either side. */
export function globOverlap(a: string, b: string): boolean {
	const x = a.replace(/\/+$/, "");
	const y = b.replace(/\/+$/, "");
	if (x === y) return true;
	if (x.includes("*")) return new RegExp(`^${x.split("*").map(escapeRe).join(".*")}$`).test(y);
	if (y.includes("*")) return new RegExp(`^${y.split("*").map(escapeRe).join(".*")}$`).test(x);
	return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Escape every RegExp metacharacter in `s`, so it can be embedded in a pattern. */
export function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
