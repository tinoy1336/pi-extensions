/**
 * hook-log-recorder.mjs — rig-local stand-in for the installed `lib/hook-log.ts`.
 *
 * The real module appends to `~/.local/share/pi-hooks/log.jsonl`. The offline
 * rig must not write there, so rig.ts resolve-hooks that specifier to this file.
 * Same call signature as the real one — `hookLog(source, kind, detail)` — the
 * lines land in `globalThis.__hookLog` for assertions and are mirrored to
 * `$RIG_HOOK_LOG` (this run's own stamped dir) for post-run inspection.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const HOOK_LOG_PATH = process.env.RIG_HOOK_LOG ?? "";

export function hookLog(source, kind, detail = {}) {
	const entry = { source, kind, detail };
	globalThis.__hookLog ??= [];
	globalThis.__hookLog.push(entry);
	if (HOOK_LOG_PATH) {
		try {
			mkdirSync(dirname(HOOK_LOG_PATH), { recursive: true });
			appendFileSync(HOOK_LOG_PATH, `${JSON.stringify(entry)}\n`);
		} catch {
			/* evidence only */
		}
	}
}
