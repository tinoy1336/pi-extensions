/**
 * io-guard/locks — one writer per path, held for the duration of a single write.
 *
 * The lock is a kernel `flock` taken by a helper process whose stdin is a pipe
 * this process holds open:
 *
 *   - while the pipe is open the helper holds the lock, so a second acquirer is
 *     refused immediately (no waiting, no timeout to tune);
 *   - closing the pipe ends the helper and the kernel drops the lock, which is
 *     how a write is released deliberately;
 *   - if this process dies the pipe closes with it, so the lock is released with
 *     no cleanup pass, no stale-lock procedure and no liveness bookkeeping;
 *   - the helper also carries a hard TTL, so a lock leaked by a handler that
 *     never reaches its release still frees itself.
 *
 * Acquiring is ASYNCHRONOUS on purpose: `flock -n` fails fast, and telling its
 * fast failure from a successful hold means waiting for either its exit event or a
 * short grace period. A synchronous spin would block the loop that delivers the
 * exit event and would therefore read every blocked acquirer as the holder.
 *
 * The holder's identity is written to a sidecar file purely so a refusal can name
 * who holds the path and for how long.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hookLog } from "@tinoy/pi-ext-lib";

export interface LockHolder {
	worker?: string;
	pid?: number;
	since?: number;
}

export interface HeldLock {
	key: string;
	path: string;
	root: string;
	metaFile: string;
	child: ChildProcess;
	released: boolean;
}

const TTL_SECONDS = 120;
/** flock's conflict exit code, set explicitly with -E so it cannot be confused
 *  with a failure to exec the helper. */
const CONFLICT_CODE = 9;

const held = new Set<HeldLock>();

export function lockKey(path: string): string {
	return createHash("sha256").update(path).digest("hex");
}

export function lockPaths(root: string, path: string): { lockFile: string; metaFile: string } {
	const key = lockKey(path);
	const dir = join(root, "locks");
	return { lockFile: join(dir, `${key}.lock`), metaFile: join(dir, `${key}.json`) };
}

export function readHolder(root: string, path: string): LockHolder | null {
	try {
		return JSON.parse(readFileSync(lockPaths(root, path).metaFile, "utf8")) as LockHolder;
	} catch {
		return null;
	}
}

function writeHolder(metaFile: string, holder: LockHolder): void {
	try {
		mkdirSync(join(metaFile, ".."), { recursive: true });
		const tmp = `${metaFile}.tmp-${process.pid}`;
		writeFileSync(tmp, JSON.stringify(holder));
		renameSync(tmp, metaFile);
	} catch {
		/* the sidecar is diagnostics only */
	}
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Acquire, tolerating the window left by a release that has just happened.
 *
 * A release is asynchronous: closing the pipe ends the helper, and the kernel only
 * drops the lock when that process actually exits — a window of roughly a tenth of
 * a second. Anything that runs immediately after a release therefore races it.
 * A foreground write should NOT wait here (it parks instead, which keeps the worker
 * moving), but background work such as the merge drain can afford to, and must, or
 * it will always find the lock still held by the write that triggered it.
 */
export async function tryAcquireWithGrace(
	root: string,
	path: string,
	me: { worker: string; pid: number },
	attempts = 8,
	stepMs = 250,
): Promise<{ ok: true; lock: HeldLock } | { ok: false; holder: LockHolder | null }> {
	let last: { ok: false; holder: LockHolder | null } = { ok: false, holder: null };
	for (let i = 0; i < attempts; i++) {
		const got = await tryAcquire(root, path, me);
		if (got.ok) return got;
		last = got;
		await delay(stepMs);
	}
	return last;
}

/** Does a fresh probe find the lock HELD? True means someone holds it; the probe
 *  process acquires and exits, so it never leaves the lock behind. */
function probeHeld(lockFile: string): Promise<boolean> {
	return new Promise((resolve) => {
		const c = spawn("flock", ["-n", "-E", String(CONFLICT_CODE), lockFile, "-c", "true"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		c.on("exit", (code) => resolve(code === CONFLICT_CODE));
		c.on("error", () => resolve(false));
	});
}

/**
 * Acquire the lock for `path` without waiting. Returns the holder already in place
 * when it is taken, so the caller can say who has it.
 *
 * Success is decided by the helper SAYING SO — it prints `HELD` once flock has
 * granted the lock — and never by a timer. Deciding on a timer was wrong in a way
 * that mattered: under load the helper could still be starting when the timer
 * expired, so a REFUSED acquisition was recorded as a successful one, the caller
 * wrote a holder sidecar for a lock it did not hold, and two writers could both
 * believe they were exclusive.
 */
export async function tryAcquire(
	root: string,
	path: string,
	me: { worker: string; pid: number },
): Promise<{ ok: true; lock: HeldLock } | { ok: false; holder: LockHolder | null }> {
	const { lockFile, metaFile } = lockPaths(root, path);
	mkdirSync(join(root, "locks"), { recursive: true });
	const child = spawn(
		"flock",
		[
			"-n",
			"-E",
			String(CONFLICT_CODE),
			lockFile,
			"-c",
			`echo HELD; timeout ${TTL_SECONDS} cat >/dev/null`,
		],
		{ stdio: ["pipe", "pipe", "ignore"] },
	);
	const verdict = await new Promise<{ kind: "held" } | { kind: "exited"; code: number | null }>(
		(resolve) => {
			let buf = "";
			child.stdout?.on("data", (d: Buffer) => {
				buf += String(d);
				if (buf.includes("HELD")) resolve({ kind: "held" });
			});
			child.once("exit", (code) => resolve({ kind: "exited", code }));
			child.once("error", () => resolve({ kind: "exited", code: null }));
		},
	);
	if (verdict.kind === "exited") {
		// A conflict (9) or a failure to run the helper. Either way this process does
		// NOT hold the lock, and it must not claim that it does.
		hookLog("io-guard-lock", "refused", { worker: me.worker, path, lockFile, code: verdict.code });
		return { ok: false, holder: readHolder(root, path) };
	}
	const lock: HeldLock = { key: lockKey(path), path, root, metaFile, child, released: false };
	// Verify exclusivity instead of trusting the handshake. The helper can be gone
	// with the lock already free — its own TTL firing, or a failure in the tail of
	// its command — while this process still believes it is exclusive. A probe that
	// ACQUIRES proves the opposite, and an unverified hold is not a hold.
	if (!(await probeHeld(lockFile))) {
		hookLog("io-guard-lock", "verify-failed", { worker: me.worker, path, lockFile });
		try {
			child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
		return { ok: false, holder: readHolder(root, path) };
	}
	writeHolder(metaFile, { worker: me.worker, pid: me.pid, since: Date.now() });
	held.add(lock);
	hookLog("io-guard-lock", "acquired", { worker: me.worker, path, lockFile, held: held.size });
	return { ok: true, lock };
}

/** Release by closing the pipe: the helper sees EOF and the kernel drops the lock. */
export function release(lock: HeldLock): void {
	if (lock.released) return;
	lock.released = true;
	held.delete(lock);
	// A hold that had already expired is invisible otherwise: the caller believes it
	// was exclusive while the kernel had already let someone else in.
	if (lock.child.exitCode !== null) {
		hookLog("io-guard-lock", "expired-before-release", {
			path: lock.path,
			code: lock.child.exitCode,
		});
	}
	hookLog("io-guard-lock", "released", { path: lock.path, held: held.size });
	try {
		lock.child.stdin?.end();
	} catch {
		/* already closed */
	}
	const timer = setTimeout(() => {
		try {
			if (lock.child.exitCode === null) lock.child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}, 500);
	timer.unref?.();
	try {
		// Only clear the sidecar if it is still OURS: it is per-path, so a late release
		// for an expired hold would otherwise delete the current holder's record and
		// make the next refusal name the wrong worker.
		const cur = readHolder(lock.root, lock.path);
		if (!cur || cur.pid === process.pid) unlinkSync(lock.metaFile);
	} catch {
		/* sidecar cleanup is best effort */
	}
}

/** Release everything this process still holds, so a lock cannot outlive a run. */
export function releaseAll(): void {
	for (const lock of [...held]) release(lock);
}
