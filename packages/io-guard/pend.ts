/**
 * io-guard/pend — a write that could not take the lock is PARKED, not lost and not
 * blocked on.
 *
 * A parked entry holds the whole proposed content plus the base it was written
 * against: the hash of the version the worker had read. Parking rather than waiting
 * keeps the worker's turn alive — nothing in this design ever blocks on another
 * worker — and it keeps the proposal recoverable when the holder releases.
 *
 * The base is a hash, and the body itself lives in the content-addressed spool, so
 * a parked entry is small and several proposals for one path stay cheap. An entry
 * without a spooled base can never be merged automatically and is reported instead;
 * merging against a base nobody read is the one outcome this must never produce.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { lockKey } from "./locks.ts";

export interface PendingEntry {
	id: string;
	path: string;
	worker: string;
	at: number;
	/** Hash of the version this proposal was written against, or "" when unknown. */
	baseHash: string;
	/** The proposed file content, base64 so binary-safe. */
	contentB64: string;
	attempts: number;
}

export function pendingDir(root: string, path: string): string {
	return join(root, "pending", lockKey(path));
}

export function pendingPath(root: string, path: string, id: string): string {
	return join(pendingDir(root, path), `${id}.json`);
}

/** Park a proposal. The id carries the worker and the time so entries sort and a
 *  refusal can name the proposal it created. */
export function park(
	root: string,
	entry: { path: string; worker: string; baseHash: string; content: string },
): PendingEntry {
	const id = `${entry.worker}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	const rec: PendingEntry = {
		id,
		path: entry.path,
		worker: entry.worker,
		at: Date.now(),
		baseHash: entry.baseHash,
		contentB64: Buffer.from(entry.content, "utf8").toString("base64"),
		attempts: 0,
	};
	const dir = pendingDir(root, entry.path);
	mkdirSync(dir, { recursive: true });
	const dest = pendingPath(root, entry.path, id);
	const tmp = `${dest}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(rec)}\n`);
	renameSync(tmp, dest);
	return rec;
}

export function listPending(root: string, path: string): PendingEntry[] {
	try {
		const dir = pendingDir(root, path);
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				try {
					return JSON.parse(readFileSync(join(dir, f), "utf8")) as PendingEntry;
				} catch {
					return null;
				}
			})
			.filter((e): e is PendingEntry => !!e)
			.sort((a, b) => a.at - b.at);
	} catch {
		return [];
	}
}

export function readPendingContent(entry: PendingEntry): string {
	return Buffer.from(entry.contentB64, "base64").toString("utf8");
}

export function dropPending(root: string, entry: PendingEntry): void {
	try {
		unlinkSync(pendingPath(root, entry.path, entry.id));
	} catch {
		/* already applied or swept */
	}
}

/** Bump the attempt count so a proposal that keeps failing to merge is visible
 *  rather than retried forever. */
export function bumpAttempts(root: string, entry: PendingEntry): PendingEntry {
	const next = { ...entry, attempts: entry.attempts + 1 };
	try {
		const dest = pendingPath(root, entry.path, entry.id);
		const tmp = `${dest}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(next)}\n`);
		renameSync(tmp, dest);
	} catch {
		/* best effort */
	}
	return next;
}

/** Every pending entry under the root, for inspection. */
export function listAllPending(root: string): PendingEntry[] {
	const out: PendingEntry[] = [];
	try {
		const base = join(root, "pending");
		for (const dir of readdirSync(base)) {
			try {
				for (const f of readdirSync(join(base, dir))) {
					if (!f.endsWith(".json")) continue;
					try {
						out.push(JSON.parse(readFileSync(join(base, dir, f), "utf8")) as PendingEntry);
					} catch {
						/* skip debris */
					}
				}
			} catch {
				/* skip unreadable directory */
			}
		}
	} catch {
		/* nothing pending */
	}
	return out.sort((a, b) => a.at - b.at);
}
