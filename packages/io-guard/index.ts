/**
 * io-guard — per-worker coordination for a crew sharing one tree.
 *
 * Worker side (hooks only, no tools): records what this worker read, and guards
 * what it writes. Foreman side (the same file, one tool): inspection and the
 * atomic reclaim of a claim.
 *
 * A write is allowed only when all of the following hold:
 *   - the path is inside the worker's CURRENT claim (read from the claim record,
 *     not from the hire-time binding, which a resume leaves stale);
 *   - the claim has not been reclaimed underneath it (generation check);
 *   - a TRUSTED version of the path was recorded, and the file still hashes to it,
 *     so the worker is not overwriting changes it never saw;
 *   - the per-write lock is free, giving this processor exclusive access for the
 *     duration of the write.
 * A write refused because the lock is held is PARKED, not dropped: the proposal
 * and the version it was based on are stored, and the holder's release merges it.
 *
 * Every refusal fails CLOSED. An unreadable claim, an untrusted or missing
 * version record, a guard error: all refuse rather than allow.
 */
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hookLog } from "@tinoy/pi-ext-lib";
import { Type } from "typebox";
import { ioRoot, readClaim, reclaimClaim } from "./claims.ts";
import { identityFromBindings, identityHolder } from "./identity.ts";
import {
	type HeldLock,
	readHolder,
	release,
	releaseAll,
	tryAcquire,
	tryAcquireWithGrace,
} from "./locks.ts";
import {
	bumpAttempts,
	dropPending,
	listAllPending,
	listPending,
	park,
	readPendingContent,
} from "./pend.ts";
import {
	absoluteGlobs,
	canonicalPath,
	isAlwaysAllowed,
	isFullRead,
	pathInScope,
	wasTruncated,
} from "./predicates.ts";
import { reap } from "./reap.ts";
import {
	captureForVersion,
	readBody,
	SIZE_CAP,
	sameStamp,
	spoolBody,
	statStamp,
	VersionRegistry,
} from "./versions.ts";

const IO_ROOT = ioRoot();
const MAX_MERGE_ATTEMPTS = 3;

type ToolResult = { block?: boolean; reason?: string };

function refuse(reason: string): ToolResult {
	return { block: true, reason };
}

/** Apply an edit's anchors to the current content, refusing anything ambiguous. */
function applyEdits(
	content: string,
	input: Record<string, unknown>,
): { ok: true; text: string } | { ok: false; reason: string } {
	const raw = Array.isArray(input.edits)
		? (input.edits as Array<{ oldText?: unknown; newText?: unknown }>)
		: [];
	const list: Array<{ oldText: string; newText: string }> =
		raw.length > 0
			? raw
					.filter((e) => typeof e?.oldText === "string" && typeof e?.newText === "string")
					.map((e) => ({ oldText: e.oldText as string, newText: e.newText as string }))
			: typeof input.oldText === "string" && typeof input.newText === "string"
				? [{ oldText: input.oldText, newText: input.newText }]
				: [];
	if (list.length === 0) return { ok: false, reason: "the call carries no usable edit anchors" };
	let text = content;
	for (const e of list) {
		if (e.oldText === "") return { ok: false, reason: "an edit anchor is empty" };
		const occurrences = text.split(e.oldText).length - 1;
		if (occurrences === 0)
			return {
				ok: false,
				reason: "an edit anchor is no longer present in the file — re-read it and re-apply",
			};
		if (occurrences > 1)
			return {
				ok: false,
				reason: `an edit anchor matches ${occurrences} times, so the target is ambiguous — re-read it and name more context`,
			};
		text = text.replace(e.oldText, e.newText);
	}
	return { ok: true, text };
}

/** Replace a file with new content atomically. */
function atomicReplace(path: string, text: string): boolean {
	try {
		const tmp = `${path}.ioguard-${process.pid}`;
		writeFileSync(tmp, text);
		renameSync(tmp, path);
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI): void {
	const identity = identityHolder(IO_ROOT);
	const registry = new VersionRegistry();
	const preRead = new Map<string, { size: number; mtimeMs: number } | null>();
	const heldLocks = new Map<string, HeldLock>();
	let pinnedGeneration: number | null = null;

	// Identity is resolved EAGERLY, and a process that carries a crew worker's
	// binding without owning that identity is recorded here. An inert guard on a real
	// worker is the worst failure this system has: every write unguarded, and nothing
	// saying so. `envSaysCrew` makes that state refusable and visible.
	const envBinding = identityFromBindings(process.env.PI_SUBAGENT_EXTENSION_BINDINGS, process.pid);
	const envSaysCrew = process.env.PI_SUBAGENT_CHILD === "1" && envBinding !== null;
	const ownedIdentity = identity.get();
	if (envSaysCrew && !ownedIdentity) {
		hookLog("io-guard", "inert", {
			worker: envBinding?.worker,
			reason: "another process owns this worker identity",
		});
	}

	// ── read side ────────────────────────────────────────────────────────────
	pi.on("tool_call", (event: unknown) => {
		try {
			const ev = event as { toolName?: string; toolCallId?: string; input?: { path?: string } };
			if (ev.toolName !== "read") return;
			const path = ev.input?.path;
			if (!path) return;
			if (!identity.get()) return;
			const id = ev.toolCallId ?? "unknown";
			preRead.set(id, statStamp(canonicalPath(path, process.cwd())));
			if (preRead.size > 256) {
				const oldest = preRead.keys().next().value;
				if (oldest !== undefined) preRead.delete(oldest);
			}
			return;
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event: unknown) => {
		try {
			const ev = event as {
				toolName?: string;
				toolCallId?: string;
				isError?: boolean;
				details?: unknown;
				input?: { path?: string; offset?: number; limit?: number };
			};
			if (ev.toolName !== "read" || ev.isError) return;
			const me = identity.get();
			if (!me) return;
			const raw = ev.input?.path;
			if (!raw) return;
			const path = canonicalPath(raw, process.cwd());

			const id = ev.toolCallId ?? "unknown";
			const before = preRead.get(id) ?? null;
			preRead.delete(id);

			// Capture first: the read that produces the hash must sit inside the
			// bracket, with a stamp taken before the tool ran and one taken now.
			const got = captureForVersion(path, SIZE_CAP);
			if (!got) return;
			const after = statStamp(path);
			const trusted = sameStamp(before, got.facts) && sameStamp(got.facts, after);

			const claim = readClaim(IO_ROOT, me.worker);
			// Pin the generation at the FIRST sight of the claim, read or write. A claim
			// reclaimed before this worker ever wrote must still stop it; pinning only on a
			// write would let it adopt the reclaimed generation and write into a scope the
			// foreman had already withdrawn.
			if (claim && pinnedGeneration === null) pinnedGeneration = claim.generation;
			const globs = absoluteGlobs(claim?.owns ?? me.owns, process.cwd());
			const full = isFullRead(ev.input?.offset, ev.input?.limit) && !wasTruncated(ev.details);
			const inScope = pathInScope(path, globs);
			let spooled = false;
			if (trusted && full && inScope && got.body !== null)
				spooled = spoolBody(IO_ROOT, got.facts.hash, got.body);

			registry.record(path, got.facts, spooled, trusted);
			hookLog("io-guard", "version", {
				worker: me.worker,
				path,
				trusted,
				full,
				inScope,
				spooled,
				bytes: got.facts.size,
				hashPrefix: got.facts.hash.slice(0, 8),
			});
			return;
		} catch {
			return;
		}
	});

	// ── write side ───────────────────────────────────────────────────────────
	pi.on("tool_call", async (event: unknown) => {
		try {
			const ev = event as { toolName?: string; input?: Record<string, unknown> };
			if (ev.toolName !== "write" && ev.toolName !== "edit") return;
			const me = identity.get();
			if (!me) {
				if (envSaysCrew) {
					return refuse(
						`refused: this process carries crew worker '${envBinding?.worker}'s binding but does not own that identity (another process does), so the guard cannot check this write. Do not work around it — report to the foreman.`,
					);
				}
				return; // not a crew worker at all: not this guard's business
			}
			const rawPath = typeof ev.input?.path === "string" ? (ev.input.path as string) : "";
			if (!rawPath) return refuse("refused: the call carries no path to write.");
			const path = canonicalPath(rawPath, process.cwd());

			const claim = readClaim(IO_ROOT, me.worker);
			if (!claim) {
				// A worker with no claim record cannot be checked, and an unchecked write
				// is exactly what this guard exists to prevent.
				return refuse(
					`refused: no claim record for '${me.worker}' — the dispatcher owns claims, so this write cannot be authorised.`,
				);
			}
			if (pinnedGeneration === null) pinnedGeneration = claim.generation;
			else if (claim.generation !== pinnedGeneration) {
				return refuse(
					`refused: ${me.worker}'s claim was RECLAIMED (generation ${pinnedGeneration} → ${claim.generation}) — this process no longer owns that scope. Stop and report to the foreman.`,
				);
			}
			// Ownership is checked BEFORE the allowlist, so a reclaimed worker keeps no
			// write surface at all — not even its own handoff.
			if (
				!pathInScope(path, absoluteGlobs(claim.owns, process.cwd())) &&
				!isAlwaysAllowed(path, me.worker, homedir(), join(IO_ROOT, "tmp", me.worker))
			) {
				return refuse(
					`refused: ${path} is outside ${me.worker}'s claim (${claim.owns.join(", ") || "none"}).`,
				);
			}

			// Work out the content this call would write, before judging versions.
			const current = existsSync(path) ? readFileSync(path).toString("utf8") : null;
			let proposed: string;
			if (ev.toolName === "write") {
				if (typeof ev.input?.content !== "string")
					return refuse("refused: the call carries no content to write.");
				proposed = ev.input.content as string;
			} else {
				if (current === null)
					return refuse(`refused: ${path} does not exist, so there is nothing to edit.`);
				const applied = applyEdits(current, ev.input ?? {});
				if (!applied.ok) return refuse(`refused: ${applied.reason}`);
				proposed = applied.text;
			}

			// Version check. A whole-file write must be based on the exact version the
			// worker read. An ANCHORED edit needs no such thing: its anchors were just
			// checked against the CURRENT content, so two workers editing disjoint regions
			// of one file both succeed — which is the common case, and the reason anchors
			// exist rather than a plain overwrite.
			if (current !== null) {
				const rec = registry.get(path);
				if (!rec || !rec.trusted) {
					return refuse(
						`refused: no trusted version of ${path} recorded in this session — read it before writing so the guard can tell whether it moved.`,
					);
				}
				if (ev.toolName === "write") {
					const now = captureForVersion(path, SIZE_CAP);
					if (!now || now.facts.hash !== rec.hash) {
						return refuse(
							`refused: ${path} changed since you read it (version ${rec.hash.slice(0, 8)} → ${now ? now.facts.hash.slice(0, 8) : "unreadable"}). Re-read it and re-apply.`,
						);
					}
				}
			}

			// Per-write lock, held across execution.
			const got = await tryAcquire(IO_ROOT, path, { worker: me.worker, pid: process.pid });
			if (!got.ok) {
				const holder = got.holder ?? readHolder(IO_ROOT, path);
				const age = holder?.since
					? `${Math.round((Date.now() - holder.since) / 1000)}s`
					: "unknown";
				const rec = registry.get(path);
				const parked = park(IO_ROOT, {
					path,
					worker: me.worker,
					baseHash: rec?.trusted ? rec.hash : "",
					content: proposed,
				});
				hookLog("io-guard", "park", {
					worker: me.worker,
					path,
					holder: holder?.worker ?? "unknown",
					age,
					id: parked.id,
				});
				return refuse(
					`refused: ${path} is held by ${holder?.worker ?? "another worker"} for ${age}. Your change is PARKED (${parked.id}) and will be merged when the holder releases. Continue with other work, or report the block to the foreman — do not retry in a loop.`,
				);
			}
			heldLocks.set(path, got.lock);
			return;
		} catch (e) {
			// Fail closed: an error in the guard must never authorise a write.
			return refuse(
				`refused: the io guard could not verify this write (${String(e).slice(0, 120)}) — reporting rather than writing.`,
			);
		}
	});

	pi.on("tool_result", (event: unknown) => {
		try {
			const ev = event as { toolName?: string; input?: { path?: string } };
			if (ev.toolName !== "write" && ev.toolName !== "edit") return;
			const me = identity.get();
			if (!me) return;
			const rawPath = typeof ev.input?.path === "string" ? (ev.input.path as string) : "";
			if (!rawPath) return;
			const path = canonicalPath(rawPath, process.cwd());

			const ev2 = ev as { isError?: boolean };
			const lock = heldLocks.get(path);
			hookLog("io-guard", "write-done", {
				worker: me.worker,
				path,
				hadLock: !!lock,
				held: heldLocks.size,
			});
			if (lock) {
				release(lock);
				heldLocks.delete(path);
			}
			// Adopt the new content as this worker's baseline ONLY when the guard itself
			// allowed this write and the tool reported success. Recording after a failed or
			// aborted call would re-base the worker on content it never wrote, and its next
			// whole-file write would then silently clobber whatever landed in between.
			if (lock && ev2.isError !== true) {
				const got = captureForVersion(path, SIZE_CAP);
				if (got) {
					registry.record(
						path,
						got.facts,
						got.body !== null ? spoolBody(IO_ROOT, got.facts.hash, got.body) : false,
						true,
					);
				}
			}
			drainPending(me.worker, path).catch(() => {
				/* the drain is background work; a failure must not break the write */
			});
			return;
		} catch {
			return;
		}
	});

	// ── merge parked proposals after a release ───────────────────────────────
	// The drain is itself a WRITER, so it takes the same lock as any other write:
	// applying a merge under someone else's lock is exactly the interleaving the
	// lock exists to prevent. If the lock cannot be taken, the proposals stay parked.
	async function drainPending(worker: string, path: string): Promise<void> {
		const entries = listPending(IO_ROOT, path);
		if (entries.length === 0) return;
		const scratch = join(IO_ROOT, "scratch", worker, "merge");
		try {
			mkdirSync(scratch, { recursive: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.attempts >= MAX_MERGE_ATTEMPTS) {
				hookLog("io-guard", "park-escalated", {
					worker,
					path,
					id: entry.id,
					attempts: entry.attempts,
				});
				continue;
			}
			const acquired = await tryAcquireWithGrace(IO_ROOT, path, { worker, pid: process.pid });
			if (!acquired.ok) {
				hookLog("io-guard", "park-waiting", { worker, path, id: entry.id, writer: entry.worker });
				break; // someone else is writing this path; leave the proposals parked
			}
			try {
				const base = entry.baseHash ? readBody(IO_ROOT, entry.baseHash) : null;
				if (!base) {
					// Never merge against a base nobody read.
					bumpAttempts(IO_ROOT, entry);
					hookLog("io-guard", "park-no-base", { worker, path, id: entry.id, writer: entry.worker });
					continue;
				}
				const current = existsSync(path) ? readFileSync(path) : Buffer.from("");
				// A missing target is not mergeable context: diffing against an empty "ours"
				// reads as "we deleted everything", and a clean merge would then resurrect a
				// file that was deliberately removed.
				if (!existsSync(path)) {
					bumpAttempts(IO_ROOT, entry);
					hookLog("io-guard", "park-no-target", {
						worker,
						path,
						id: entry.id,
						writer: entry.worker,
					});
					continue;
				}
				const ours = join(scratch, `${entry.id}.ours`);
				const baseFile = join(scratch, `${entry.id}.base`);
				const theirs = join(scratch, `${entry.id}.theirs`);
				try {
					writeFileSync(ours, current);
					writeFileSync(baseFile, base);
					writeFileSync(theirs, readPendingContent(entry));
				} catch {
					bumpAttempts(IO_ROOT, entry);
					continue;
				}
				const r = spawnSync("git", ["merge-file", "-p", ours, baseFile, theirs], {
					encoding: "utf8",
					timeout: 15000,
				});
				// merge-file: 0 clean; >=1 the NUMBER of conflicts; <0 an error.
				if (r.status === 0 && typeof r.stdout === "string") {
					if (atomicReplace(path, r.stdout)) {
						dropPending(IO_ROOT, entry);
						const after = captureForVersion(path, SIZE_CAP);
						// Recorded as UNTRUSTED: this worker did not write the merged content and has
						// not seen it, so its next write to this path must re-read first rather than
						// overwrite a peer's merged change.
						if (after) registry.record(path, after.facts, false, false);
						hookLog("io-guard", "park-merged", {
							worker,
							path,
							id: entry.id,
							writer: entry.worker,
						});
					} else {
						bumpAttempts(IO_ROOT, entry);
					}
				} else if (r.status !== null && r.status > 0) {
					// A real conflict: keep the proposal and report it.
					bumpAttempts(IO_ROOT, entry);
					hookLog("io-guard", "park-conflict", {
						worker,
						path,
						id: entry.id,
						writer: entry.worker,
						conflicts: r.status,
					});
				} else {
					bumpAttempts(IO_ROOT, entry);
					hookLog("io-guard", "park-merge-error", {
						worker,
						path,
						id: entry.id,
						writer: entry.worker,
						status: r.status,
					});
				}
				for (const f of [ours, baseFile, theirs]) {
					try {
						unlinkSync(f);
					} catch {
						/* scratch is best effort */
					}
				}
			} finally {
				release(acquired.lock);
			}
		}
	}

	// ── residue: what changed without this worker seeing it ──────────────────
	pi.on("session_shutdown", () => {
		try {
			releaseAll();
			const me = identity.get();
			if (!me) return;
			const claim = readClaim(IO_ROOT, me.worker);
			const globs = absoluteGlobs(claim?.owns ?? me.owns, process.cwd());
			let unexplained = 0;
			for (const rec of registry.all()) {
				if (!pathInScope(rec.path, globs)) continue;
				const now = captureForVersion(rec.path, SIZE_CAP);
				if (!now) {
					if (!existsSync(rec.path)) {
						unexplained++;
						hookLog("io-guard", "residue-missing", { worker: me.worker, path: rec.path });
					}
					continue;
				}
				if (now.facts.hash !== rec.hash) {
					unexplained++;
					hookLog("io-guard", "residue-changed", {
						worker: me.worker,
						path: rec.path,
						was: rec.hash.slice(0, 8),
						now: now.facts.hash.slice(0, 8),
					});
				}
			}
			hookLog("io-guard", "residue-summary", {
				worker: me.worker,
				recorded: registry.size(),
				unexplained,
			});
		} catch {
			/* shutdown must not throw */
		}
	});

	// ── foreman side: inspection and the atomic reclaim ──────────────────────
	if (process.env.PI_SUBAGENT_CHILD !== "1") {
		pi.registerTool({
			name: "io_status",
			label: "IO status",
			description:
				"Inspect the crew's IO state: claims with their generations, current lock holders, and parked writes. Also performs the atomic reclaim of a claim, which withdraws the GUARD's side of it: the generation moves, so a process still running under that name has its next write refused. Reclaim is NOT an ownership release — the hire-time overlap check reads the roster, so paths owned by a worker whose run is gone become writable again through fleet (retire, or the pass that clears a run the reboot destroyed), not from here.",
			parameters: Type.Object({
				action: Type.Union([
					Type.Literal("inspect"),
					Type.Literal("reclaim"),
					Type.Literal("reap"),
				]),
				worker: Type.Optional(
					Type.String({
						description:
							"reclaim: the worker whose claim to withdraw. inspect: optional, to narrow the output.",
					}),
				),
				generation: Type.Optional(
					Type.Number({
						description:
							"reclaim: the generation you believe is current. The reclaim fails if it has moved.",
					}),
				),
				maxAgeHours: Type.Optional(
					Type.Number({
						description: "reap: reclaim state untouched for this many hours (default 168).",
					}),
				),
			}),
			async execute(_id: string, params: Record<string, unknown>) {
				const action = String(params.action);
				if (action === "reclaim") {
					const worker = typeof params.worker === "string" ? params.worker : "";
					if (!worker)
						return {
							content: [{ type: "text" as const, text: "reclaim needs a worker name." }],
							isError: true,
							details: {},
						};
					const gen =
						typeof params.generation === "number"
							? params.generation
							: readClaim(IO_ROOT, worker)?.generation;
					if (typeof gen !== "number")
						return {
							content: [{ type: "text" as const, text: `no claim record for '${worker}'.` }],
							isError: true,
							details: {},
						};
					const res = reclaimClaim(IO_ROOT, worker, gen);
					return {
						content: [
							{
								type: "text" as const,
								text: res.ok
									? `reclaimed '${worker}': generation ${gen} → ${res.generation}. Its next write will be refused. This did NOT release ownership — the overlap check reads the roster, so use fleet retire to free the paths.`
									: `reclaim refused: ${res.reason}. Re-run inspect to see the current generation.`,
							},
						],
						details: {},
					};
				}
				if (action === "reap") {
					const hours =
						typeof params.maxAgeHours === "number" && params.maxAgeHours > 0
							? params.maxAgeHours
							: 168;
					const r = reap(IO_ROOT, Math.round(hours * 3600 * 1000));
					return {
						content: [
							{
								type: "text" as const,
								text: `reaped state untouched for ${hours}h: ${r.spoolBodies} spool bodies, ${r.buildRoots} build roots, ${r.pendingEntries} parked proposals, ${r.scratchDirs} scratch dirs, ${(r.bytesFreed / 1048576).toFixed(1)} MB.`,
							},
						],
						details: {},
					};
				}
				const claimsDir = join(IO_ROOT, "claims");
				const claims: string[] = [];
				try {
					const { readdirSync } = await import("node:fs");
					for (const f of readdirSync(claimsDir)) {
						if (!f.endsWith(".json")) continue;
						const rec = readClaim(IO_ROOT, f.replace(/\.json$/, ""));
						if (rec)
							claims.push(
								`${rec.worker} gen=${rec.generation} scope=${rec.scope} owns=[${rec.owns.join(", ")}]${rec.reclaimedAt ? " RECLAIMED" : ""}`,
							);
					}
				} catch {
					/* no claims yet */
				}
				const pending = listAllPending(IO_ROOT).map(
					(e) => `${e.id} ${e.path} by ${e.worker} attempts=${e.attempts}`,
				);
				// Holders are read from their sidecars and judged alive or dead, because the
				// kernel lock is released by the holder's death while the sidecar lingers.
				const holders: string[] = [];
				try {
					const { readdirSync } = await import("node:fs");
					for (const f of readdirSync(join(IO_ROOT, "locks"))) {
						if (!f.endsWith(".json")) continue;
						try {
							const rec = JSON.parse(
								await import("node:fs").then((m) =>
									m.readFileSync(join(IO_ROOT, "locks", f), "utf8"),
								),
							) as {
								worker?: string;
								pid?: number;
								since?: number;
							};
							const alive = typeof rec.pid === "number" && existsSync(`/proc/${rec.pid}`);
							const age = rec.since ? `${Math.round((Date.now() - rec.since) / 1000)}s` : "unknown";
							holders.push(
								`${rec.worker ?? "?"} pid=${rec.pid ?? "?"} ${alive ? "ALIVE" : "dead (its lock is already free)"} held ${age}`,
							);
						} catch {
							/* unreadable sidecar: skip it */
						}
					}
				} catch {
					/* no locks yet */
				}
				const text = [
					`claims (${claims.length || "none"}):`,
					...claims.map((c) => `  ${c}`),
					`lock holders (${holders.length || "none"}):`,
					...holders.map((h) => `  ${h}`),
					`parked writes (${pending.length || "none"}):`,
					...pending.map((p) => `  ${p}`),
				].join("\n");
				return { content: [{ type: "text" as const, text }], details: {} };
			},
		});
	}
}
