/**
 * io-guard/versions — what a worker read, so a later write can be refused when
 * the file moved underneath it, and so a blocked write has a base to merge
 * against.
 *
 * Load-bearing rules:
 *
 *   - a body and its hash come from ONE read of the file, so the bytes stored
 *     under a content-addressed key always hash to that key;
 *   - hashing never allocates the whole file: files above the cap are streamed
 *     in fixed chunks and their body is not kept;
 *   - a record is only TRUSTWORTHY when the file's size and mtime are unchanged
 *     from before the read to after it. The consuming version check must treat
 *     an untrusted or missing record as a refusal, never as a pass.
 *
 * Spooling is content-addressed, so re-reading unchanged content costs one entry
 * however often it is read.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Body spooling ceiling: a read larger than this yields a hash but no body. */
export const SIZE_CAP = 2 * 1024 * 1024;
const CHUNK = 1024 * 1024;

export interface VersionRecord {
	path: string;
	hash: string;
	size: number;
	mtimeMs: number;
	at: number;
	/** True when the body is in the spool and can serve as a merge base. */
	spooled: boolean;
	/**
	 * False when the file changed between the start and the end of the read, so
	 * this record may not represent what the worker saw. A version check must
	 * fail closed on an untrusted record.
	 */
	trusted: boolean;
}

export interface FileFacts {
	hash: string;
	size: number;
	mtimeMs: number;
}

export interface FileStamp {
	size: number;
	mtimeMs: number;
}

export function statStamp(path: string): FileStamp | null {
	try {
		const st = statSync(path);
		if (!st.isFile()) return null;
		return { size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return null;
	}
}

export function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
	return !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Hash a file without reading it into memory in one piece. */
export function streamHash(path: string): string | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const h = createHash("sha256");
		const buf = Buffer.allocUnsafe(CHUNK);
		for (;;) {
			const n = readSync(fd, buf, 0, buf.length, null);
			if (n <= 0) break;
			h.update(buf.subarray(0, n));
		}
		return h.digest("hex");
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/**
 * Capture a version in ONE pass: the hash and, when the file fits, the exact
 * bytes that were hashed. A large file is streamed and yields no body.
 */
export function captureForVersion(
	path: string,
	cap: number = SIZE_CAP,
): { facts: FileFacts; body: Buffer | null } | null {
	const st = statStamp(path);
	if (!st) return null;
	if (st.size <= cap) {
		let buf: Buffer;
		try {
			buf = readFileSync(path);
		} catch {
			return null;
		}
		return { facts: { hash: hashOf(buf), size: st.size, mtimeMs: st.mtimeMs }, body: buf };
	}
	const hash = streamHash(path);
	if (hash === null) return null;
	return { facts: { hash, size: st.size, mtimeMs: st.mtimeMs }, body: null };
}

export function hashOf(buf: Buffer | string): string {
	return createHash("sha256").update(buf).digest("hex");
}

/** Where a spooled body lives. Content-addressed, so identical bytes are one file. */
export function bodyPath(root: string, hash: string): string {
	return join(root, "base", hash);
}

/**
 * Write a body into the spool atomically and idempotently, stamped with the time
 * it was STORED rather than the source file's mtime — a last-use reaper must age
 * an entry by when it was last read, not by how old the content is.
 */
export function spoolBody(
	root: string,
	hash: string,
	body: Buffer,
	storedAt: number = Date.now(),
): boolean {
	if (hashOf(body) !== hash) return false; // never store bytes under the wrong key
	const dest = bodyPath(root, hash);
	const secs = storedAt / 1000;
	try {
		// Already present: identical bytes are one entry, but refresh the stamp so a
		// last-use reaper ages an entry by when it was last READ, not first stored.
		statSync(dest);
		utimesSync(dest, secs, secs);
		return true;
	} catch {
		/* not spooled yet */
	}
	try {
		mkdirSync(dirname(dest), { recursive: true });
		const tmp = `${dest}.tmp-${process.pid}-${storedAt}`;
		writeFileSync(tmp, body);
		renameSync(tmp, dest);
		utimesSync(dest, secs, secs);
		return true;
	} catch {
		return false;
	}
}

/** Read a spooled body, or null when absent. */
export function readBody(root: string, hash: string): Buffer | null {
	try {
		return readFileSync(bodyPath(root, hash));
	} catch {
		return null;
	}
}

/**
 * Version records for one session, bounded. A record EVICTED for space makes a
 * later version check find nothing, which must be treated as a refusal — hence
 * the explicit `get` returning undefined rather than a synthetic "unchanged".
 */
export class VersionRegistry {
	private byPath = new Map<string, VersionRecord>();
	private maxRecords: number;

	// Fields are declared explicitly rather than as constructor parameter
	// properties: the modules must stay erasable-only TypeScript so the offline
	// rig can load them with node's type stripping and no build step.
	constructor(maxRecords = 4096) {
		this.maxRecords = maxRecords;
	}

	get(path: string): VersionRecord | undefined {
		const rec = this.byPath.get(path);
		if (rec) {
			// refresh recency
			this.byPath.delete(path);
			this.byPath.set(path, rec);
		}
		return rec;
	}

	record(path: string, facts: FileFacts, spooled: boolean, trusted: boolean): VersionRecord {
		const rec: VersionRecord = {
			path,
			hash: facts.hash,
			size: facts.size,
			mtimeMs: facts.mtimeMs,
			at: Date.now(),
			spooled,
			trusted,
		};
		this.byPath.delete(path);
		this.byPath.set(path, rec);
		while (this.byPath.size > this.maxRecords) {
			const oldest = this.byPath.keys().next().value;
			if (oldest === undefined) break;
			this.byPath.delete(oldest);
		}
		return rec;
	}

	all(): VersionRecord[] {
		return [...this.byPath.values()];
	}

	size(): number {
		return this.byPath.size;
	}
}
