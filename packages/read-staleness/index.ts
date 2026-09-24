/**
 * read-staleness: `tool_result` hook that elides a REPEAT full-file read.
 *
 * Re-reading an unchanged file re-sends bytes the session already carries —
 * the single largest repeat-read cost in the monthly burn report. This hook
 * replaces the body of a repeat FULL read with a one-line stub while leaving
 * every other read untouched:
 *   - only `read` results, never errors;
 *   - only FULL reads (no offset/limit) — a slice request is always answered;
 *   - only when the same path was already read in this session;
 *   - only when size AND mtime are unchanged (any edit → full body);
 *   - only above MIN_BYTES (a small file saves nothing and only confuses);
 *   - at most MAX_STUBS_PER_PATH per session, so a deliberate re-read of the
 *     whole file always succeeds — the hook can never lock a file away.
 *
 * It OBSERVES results; it does not wrap, replace or patch the read tool
 * (no facade over another owner's API — canon: no monkey-patching).
 *
 * State resets on session_start and on compaction: after compaction the
 * earlier body may no longer be in context, so the stub would be a lie.
 * Every stub is appended to the shared hook log
 * (~/.local/share/pi-hooks/log.jsonl, source "read-staleness") so the monthly
 * burn report can measure whether it fires and what it saves.
 *
 * Fail-open everywhere: any throw returns undefined and the original result
 * reaches the model unmodified.
 */

import { statSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { hookLog } from "@tinoy/pi-ext-lib";

const MIN_BYTES = 4000; // below this a stub saves nothing worth the confusion
const MAX_TRACKED = 64; // LRU bound: oldest entry drops out
const MAX_STUBS_PER_PATH = 2; // then the file is always returned in full
interface Seen {
	size: number;
	mtimeMs: number;
	at: number;
	stubs: number;
}

const seen = new Map<string, Seen>();

export default function (pi: ExtensionAPI): void {
	// Compaction (or a new session) can drop the earlier read from context — a
	// stub from that point on would withhold content the model no longer has.
	pi.on("session_start", () => seen.clear());
	pi.on("session_compact", () => seen.clear());

	pi.on("tool_result", (event: unknown) => {
		try {
			const ev = event as {
				toolName?: string;
				input?: { path?: string; offset?: number; limit?: number };
				content?: Array<{ type?: string; text?: string }>;
				isError?: boolean;
			};
			if (ev.toolName !== "read" || ev.isError) return;
			const path = ev.input?.path;
			if (!path) return;

			let st: { size: number; mtimeMs: number };
			try {
				const s = statSync(path);
				st = { size: s.size, mtimeMs: s.mtimeMs };
			} catch {
				return; // unreadable path → not our business
			}

			const full = ev.input?.offset === undefined && ev.input?.limit === undefined;
			const chars = (ev.content ?? []).reduce((a, c) => a + (c?.text?.length ?? 0), 0);
			const prev = seen.get(path);

			if (
				full &&
				chars >= MIN_BYTES &&
				prev &&
				prev.size === st.size &&
				prev.mtimeMs === st.mtimeMs &&
				prev.stubs < MAX_STUBS_PER_PATH
			) {
				const ageMin = Math.max(0, Math.round((Date.now() - prev.at) / 60000));
				seen.set(path, { ...prev, stubs: prev.stubs + 1 });
				hookLog("read-staleness", "stub", { path, bytes: chars, ageMin, size: st.size });
				return {
					content: [
						{
							type: "text" as const,
							text: `unchanged — identical to the read of this file already in this session (${st.size} bytes, ${ageMin === 0 ? "moments" : ageMin + " min"} ago, mtime ${new Date(st.mtimeMs).toISOString()}). Body omitted. Request offset/limit for a specific region if you need the text again.`,
						},
					],
				};
			}

			if (full) {
				seen.set(path, {
					size: st.size,
					mtimeMs: st.mtimeMs,
					at: Date.now(),
					stubs: prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs ? prev.stubs : 0,
				});
				if (seen.size > MAX_TRACKED) {
					const oldest = seen.keys().next().value;
					if (oldest !== undefined) seen.delete(oldest);
				}
			}
			return;
		} catch {
			return; // fail-open
		}
	});
}
