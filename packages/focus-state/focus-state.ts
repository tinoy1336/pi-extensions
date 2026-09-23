/**
 * The focus-mode state file, owned here: `$XDG_RUNTIME_DIR/pi-focus.json`
 * (tmpfs, so it resets to `off` on reboot — no stale-focus trap). Read fresh
 * on every call: the file IS the contract between the session that toggles it
 * and every consumer — the gate that blocks desktop intrusion and the
 * notifier that would otherwise ping straight through it. Fail-open: an
 * unreadable or corrupt file reads as `off`, so a bug here can never mute a
 * session silently.
 *
 * TWO states only: `on` gates desktop intrusion, `off` does not. The earlier
 * quiet/locked split enforced the same deny-list — the only difference was the
 * wording of the instruction to the model — so it was collapsed. Files written
 * under those names still read correctly: quiet and locked both meant "gated",
 * full meant "not gated".
 *
 * The LEDGERS are per session process (see `focusLedgerPathFor`), and the
 * all-at-once release clear lives here too, so this module owns every path
 * convention a session needs: the mode file, a session's own ledger, the set
 * of ledgers in the runtime dir, and their removal.
 *
 * This module is a STATE CONTRACT and nothing else: it reads no configuration,
 * registers nothing with pi, and carries no policy about what a gated session
 * may do. A consumer that wants focus mode to mean something imports the state
 * and decides; a consumer that only needs the notifier's suppression imports
 * `readFocusState`.
 */
import { existsSync, type FSWatcher, readdirSync, readFileSync, unlinkSync, watch } from "node:fs";
import { basename, dirname, join } from "node:path";

export type FocusMode = "on" | "off";

/** Legacy names accepted from a state file written by an older extension. */
const LEGACY: Record<string, FocusMode> = {
	on: "on",
	off: "off",
	quiet: "on",
	locked: "on",
	full: "off",
};

export interface FocusState {
	mode: FocusMode;
	since?: string;
}

const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || "/tmp";

export const FOCUS_STATE_PATH = join(RUNTIME_DIR, "pi-focus.json");

/** Ledger naming: one file per session process. */
const LEDGER_PREFIX = "pi-focus.";
const LEDGER_SUFFIX = ".ledger.jsonl";

export function readFocusState(): FocusState {
	try {
		if (!existsSync(FOCUS_STATE_PATH)) return { mode: "off" };
		const raw = JSON.parse(readFileSync(FOCUS_STATE_PATH, "utf8")) as {
			mode?: string;
			since?: string;
		};
		const mode = raw.mode ? LEGACY[raw.mode] : undefined;
		if (!mode) return { mode: "off" };
		return { mode, since: raw.since };
	} catch {
		return { mode: "off" }; // fail-open
	}
}

/** True while desktop intrusion is gated. */
export function focusActive(state: FocusState = readFocusState()): boolean {
	return state.mode === "on";
}

/**
 * The ledger THIS session process appends to, reads and reports: one file per
 * session, so a session is responsible for — and aware of — only its own
 * blocked attempts.
 *
 * Named `<session id>-<pid>`. The session id is the session's identity; the pid
 * is what keeps two processes apart when one inherits the other's
 * PI_SESSION_ID (a pi launched from inside a pi session keeps the parent's id —
 * the same inheritance that makes the id unusable as process identity
 * elsewhere). Two sessions therefore cannot collide on one file. A session that
 * has no id yet falls back to its pid alone.
 */
export function focusLedgerPathFor(owner?: string | null): string {
	const sid = (owner ?? "").replace(/[^A-Za-z0-9_-]/g, "");
	return join(RUNTIME_DIR, `${LEDGER_PREFIX}${sid || "nosid"}-${process.pid}${LEDGER_SUFFIX}`);
}

/** True for any focus ledger, whoever wrote it — the clear-all's matcher. */
function isFocusLedgerName(name: string): boolean {
	return name.startsWith(LEDGER_PREFIX) && name.endsWith(LEDGER_SUFFIX);
}

/**
 * Every focus ledger in the runtime dir, this session's included. The release
 * clear must also remove what a session that has already exited left behind, so
 * it enumerates the directory rather than walking a known session list.
 */
export function focusLedgerFiles(): string[] {
	try {
		return readdirSync(RUNTIME_DIR)
			.filter(isFocusLedgerName)
			.map((name) => join(RUNTIME_DIR, name));
	} catch {
		return [];
	}
}

/**
 * The all-at-once release clear: EVERY session's ledger, not only the toggling
 * session's, so no session is left rendering a stale count — an idle session
 * reads zero the next time it renders its footer. Files are removed rather than
 * truncated: a live session recreates its own on its next blocked call
 * (`appendFileSync` creates it), and a dead session's file is cleaned up
 * instead of being left behind forever. Returns how many were removed.
 */
export function clearFocusLedgers(): number {
	let cleared = 0;
	for (const file of focusLedgerFiles()) {
		try {
			unlinkSync(file);
			cleared++;
		} catch {
			/* a file that vanished under us is already cleared */
		}
	}
	return cleared;
}

/**
 * Call `onChange` whenever the state file changes, in THIS process.
 *
 * The gate reads the state fresh on every tool call, so a toggle already
 * applies machine-wide; what a session only learns on its next turn is that a
 * toggle happened at all. This is the file-side half of that: the caller
 * re-syncs its footer and queues a passive notice the moment the file moves.
 *
 * The DIRECTORY is watched, not the file: the state is written by rewriting the
 * file, and watching the watched file's inode would go deaf on a
 * temp-file-plus-rename replace. Every event is re-read through
 * `readFocusState()`, so the event type is never interpreted — an in-place
 * rewrite and a replace are the same thing here — and an event for any other
 * entry of the runtime dir is ignored by name. Events are coalesced by a short
 * timer so two quick writes cost one re-read.
 *
 * Returns a disposer; it is always safe to call, including after a watch that
 * never started. A missing runtime dir or a failed watch returns a no-op
 * disposer — the caller's per-turn re-sync stays the fallback.
 */
export function watchFocusState(onChange: () => void, debounceMs = 50): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let watcher: FSWatcher | null = null;
	try {
		watcher = watch(dirname(FOCUS_STATE_PATH), { persistent: false }, (_event, filename) => {
			// Some platforms report no name; an unidentified event re-reads anyway.
			if (typeof filename === "string" && filename !== basename(FOCUS_STATE_PATH)) return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				try {
					onChange();
				} catch {
					/* the consumer's own failure must not kill the watch */
				}
			}, debounceMs);
		});
		// A watcher error (runtime dir removed under us) leaves the last known
		// mode in place; the per-turn re-sync still picks the real one up.
		watcher.on("error", () => {});
	} catch {
		return () => {};
	}
	return () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		try {
			watcher?.close();
		} catch {
			/* closing an already-dead watcher is not a failure */
		}
		watcher = null;
	};
}
