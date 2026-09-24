/**
 * io-guard/claims — the current claim for a worker, as the dispatcher last wrote
 * it.
 *
 * The binding a worker carries is a hire-time snapshot; the dispatcher updates a
 * worker's scope and owned paths on every assign, and a resumed worker keeps its
 * original binding. So the binding answers "who am I" and the claim record answers
 * "what may I write now" — the guard reads the record for every write.
 *
 * The record also carries a GENERATION. It is bumped only when a claim is
 * RECLAIMED (a worker believed dead whose name the foreman has taken back), never
 * by an ordinary assign. A worker caches the generation it first saw and refuses to
 * write when the record's generation has moved past it, which is how a reclaimed
 * claim stops a process that is still running from writing under an ownership the
 * foreman has withdrawn.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The io root, defined here because the claim record is what other modules need
 *  first: one owner for the path, so the guard and the dispatcher cannot disagree
 *  about where state lives. */
export function ioRoot(): string {
	return join(homedir(), ".local", "pi", "foreman", "io");
}

export interface ClaimRecord {
	worker: string;
	sessionId: string;
	scope: string;
	owns: string[];
	exclusive: string[];
	generation: number;
	updatedAt: number;
	reclaimedAt?: number;
}

export function claimDir(root: string): string {
	return join(root, "claims");
}

export function claimPath(root: string, worker: string): string {
	return join(claimDir(root), `${worker}.json`);
}

export function readClaim(root: string, worker: string): ClaimRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(claimPath(root, worker), "utf8")) as ClaimRecord;
		if (!parsed || typeof parsed.worker !== "string") return null;
		if (!Array.isArray(parsed.owns)) parsed.owns = [];
		if (!Array.isArray(parsed.exclusive)) parsed.exclusive = [];
		if (typeof parsed.generation !== "number") parsed.generation = 0;
		return parsed;
	} catch {
		return null;
	}
}

/** Write the claim atomically. `generation` is preserved unless the caller means
 *  to reclaim, so an ordinary assign never invalidates a running worker. */
export function writeClaim(
	root: string,
	claim: { worker: string; sessionId: string; scope: string; owns: string[]; exclusive: string[] },
	generation = 0,
): ClaimRecord {
	const rec: ClaimRecord = {
		worker: claim.worker,
		sessionId: claim.sessionId,
		scope: claim.scope,
		owns: claim.owns,
		exclusive: claim.exclusive,
		generation,
		updatedAt: Date.now(),
	};
	const dir = claimDir(root);
	mkdirSync(dir, { recursive: true });
	const dest = claimPath(root, claim.worker);
	const tmp = `${dest}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
	renameSync(tmp, dest);
	return rec;
}

/**
 * Reclaim a claim, but only from the generation the caller believes it is
 * reclaiming. A concurrent reclaim loses rather than clobbering the winner.
 */
export function reclaimClaim(
	root: string,
	worker: string,
	expectedGeneration: number,
): { ok: boolean; generation?: number; reason?: string } {
	const cur = readClaim(root, worker);
	if (!cur) return { ok: false, reason: "no claim record for this worker" };
	if (cur.generation !== expectedGeneration) {
		return {
			ok: false,
			reason: `generation moved (expected ${expectedGeneration}, found ${cur.generation})`,
		};
	}
	const rec: ClaimRecord = {
		...cur,
		generation: cur.generation + 1,
		reclaimedAt: Date.now(),
		updatedAt: Date.now(),
	};
	const dir = claimDir(root);
	mkdirSync(dir, { recursive: true });
	const dest = claimPath(root, worker);
	const tmp = `${dest}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
	renameSync(tmp, dest);
	return { ok: true, generation: rec.generation };
}

export function dropClaim(root: string, worker: string): void {
	try {
		unlinkSync(claimPath(root, worker));
	} catch {
		/* already gone */
	}
}
