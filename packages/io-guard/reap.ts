/**
 * io-guard/reap — reclaiming the disk this system accumulates.
 *
 * Three kinds of leftover, each aged by LAST USE rather than by age of content:
 *
 *   - spooled read bodies under `base/`, whose timestamps are refreshed whenever
 *     the same content is read again, so a body still in play survives;
 *   - per-worker build roots under `build/<worker>/`, which exist to keep a
 *     worker's builds warm across resumes and are therefore only reclaimed when
 *     the worker has not used them for a long time;
 *   - parked proposals under `pending/`, which are proposals rather than data and
 *     are useless once their context is gone.
 *
 * A root or body is NEVER reclaimed because a worker is merely idle: warm reuse is
 * the reason per-worker roots exist. Only age decides, and the caller chooses how
 * old is old.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ReapReport {
	spoolBodies: number;
	buildRoots: number;
	pendingEntries: number;
	scratchDirs: number;
	bytesFreed: number;
}

const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SCRATCH_MAX_AGE_MS = 3600 * 1000;

function ageMs(path: string): number | null {
	try {
		return Date.now() - statSync(path).mtimeMs;
	} catch {
		return null;
	}
}

/**
 * The newest mtime anywhere in a subtree. A build root's OWN mtime is set when it
 * is created and never updated afterwards, so ageing a root by it would delete a
 * warm root that is in constant use the first time it passed the threshold. What
 * matters is whether anything inside has been touched recently.
 */
function newestMtime(path: string): number {
	let newest = 0;
	try {
		const st = statSync(path);
		newest = st.mtimeMs;
		if (st.isDirectory()) {
			for (const entry of readdirSync(path))
				newest = Math.max(newest, newestMtime(join(path, entry)));
		}
	} catch {
		/* vanishes mid-walk: treat as ancient */
	}
	return newest;
}

function dirSize(path: string): number {
	let total = 0;
	try {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const p = join(path, entry.name);
			if (entry.isDirectory()) total += dirSize(p);
			else {
				try {
					total += statSync(p).size;
				} catch {
					/* vanished mid-walk */
				}
			}
		}
	} catch {
		/* unreadable: count nothing */
	}
	return total;
}

/** Reclaim what has not been touched within `maxAgeMs`. Best effort throughout. */
export function reap(root: string, maxAgeMs = DEFAULT_MAX_AGE_MS): ReapReport {
	const report: ReapReport = {
		spoolBodies: 0,
		buildRoots: 0,
		pendingEntries: 0,
		scratchDirs: 0,
		bytesFreed: 0,
	};

	const sweep = (dir: string, kind: keyof ReapReport, limit: number, byNewest = false) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const p = join(dir, name);
			const age = byNewest ? Date.now() - newestMtime(p) : ageMs(p);
			if (age === null || age < limit) continue;
			const size = dirSize(p);
			try {
				rmSync(p, { recursive: true, force: true });
				report[kind] += 1;
				report.bytesFreed += size;
			} catch {
				/* locked or already gone */
			}
		}
	};

	sweep(join(root, "base"), "spoolBodies", maxAgeMs);
	sweep(join(root, "build"), "buildRoots", maxAgeMs, true);
	sweep(join(root, "scratch"), "scratchDirs", SCRATCH_MAX_AGE_MS);

	// Pending entries live one level deeper, under a per-path directory.
	try {
		for (const pathDir of readdirSync(join(root, "pending"))) {
			const dir = join(root, "pending", pathDir);
			let entries: string[];
			try {
				entries = readdirSync(dir);
			} catch {
				continue;
			}
			for (const name of entries) {
				const p = join(dir, name);
				const age = ageMs(p);
				if (age === null || age < maxAgeMs) continue;
				try {
					rmSync(p, { force: true });
					report.pendingEntries += 1;
				} catch {
					/* already gone */
				}
			}
			// An empty per-path directory is debris too.
			try {
				if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
			} catch {
				/* leave it */
			}
		}
	} catch {
		/* nothing pending */
	}

	return report;
}
