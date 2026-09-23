/**
 * The pause state file, owned here: `$XDG_RUNTIME_DIR/pi-pause.json` (tmpfs,
 * so a pause never survives a reboot — no stale-pause trap). Read fresh on
 * every use: the file IS the contract between the session that sets the pause
 * and every process that parks on it. Fail-open: an unreadable or corrupt file
 * reads as not paused, so a bug here can never strand a live session.
 *
 * SHAPE — one record, rewritten whole by an atomic temp-file-plus-rename:
 *
 *   { paused, until, since, rev, by }
 *
 * `paused` false means "no pause"; `until` is the ISO deadline, or null for an
 * INDEFINITE pause (no deadline at all — released only by an explicit resume).
 * `since` is when the pause was set, `by` who set it (human-readable, for the
 * operator reading the file). `rev` is a monotonic write counter: a reader
 * compares revisions to tell a REWRITE (a new intent, obey it) from the arrival
 * of its own deadline (a timed pause ending), including when the two land in
 * the same instant.
 *
 * PATH: derived from `XDG_RUNTIME_DIR` so a scratch runtime dir gives a test
 * full isolation from the live sessions; `PI_PAUSE_STATE` overrides the whole
 * path for a caller that needs a named file. The path is resolved per call, not
 * frozen at import, so an override applies to the process it was launched with.
 */
import {
	existsSync,
	type FSWatcher,
	mkdirSync,
	readFileSync,
	renameSync,
	watch,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface PauseState {
	/** True while a pause is set. */
	paused: boolean;
	/** ISO deadline, or null for an indefinite pause. */
	until: string | null;
	/** ISO timestamp of the write that set the pause. */
	since: string | null;
	/** Monotonic write counter; a rewrite always increments it. */
	rev: number;
	/** Who set the pause, for the operator reading the file. */
	by: string | null;
}

/** The state a session with no pause reads: fail-open, no pause is active. */
export const NOT_PAUSED: PauseState = { paused: false, until: null, since: null, rev: 0, by: null };

const STATE_BASENAME = "pi-pause.json";

export function pauseStatePath(): string {
	const override = process.env.PI_PAUSE_STATE;
	if (override && override.trim().length > 0) return override;
	return join(process.env.XDG_RUNTIME_DIR || "/tmp", STATE_BASENAME);
}

/** Milliseconds per unit of a duration argument. A bare number is minutes. */
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/**
 * Parse a `/pause` duration argument: a bare number is MINUTES (`30`), a
 * suffixed form names its unit (`90s`, `5m`, `2h`), and suffixed segments
 * compound (`1h30m`, `1h30` — a trailing bare number after a unit segment is
 * minutes). The whole argument must be segments of digits plus an optional
 * unit; anything else returns null, which the caller reports as a usage error
 * rather than guessing a duration.
 */
export function parseDurationMs(text: string): number | null {
	const t = text.trim().toLowerCase().replace(/\s+/g, "");
	if (t.length === 0) return null;
	if (/^\d+(?:\.\d+)?$/.test(t)) return Math.round(Number(t) * UNIT_MS.m);
	let total = 0;
	let index = 0;
	let segments = 0;
	const re = /(\d+(?:\.\d+)?)([smh]?)/y;
	while (index < t.length) {
		re.lastIndex = index;
		const match = re.exec(t);
		if (!match || match.index !== index) return null;
		const unit = match[2];
		total += Number(match[1]) * (unit.length > 0 ? UNIT_MS[unit] : UNIT_MS.m);
		index = re.lastIndex;
		segments++;
	}
	return segments > 0 ? Math.round(total) : null;
}

/** The deadline in epoch milliseconds, or null for an indefinite pause. */
export function pauseDeadlineMs(state: PauseState): number | null {
	if (!state.until) return null;
	const ms = Date.parse(state.until);
	return Number.isFinite(ms) ? ms : null;
}

/** True while a pause blocks a turn: paused, and either indefinite or unexpired. */
export function isPauseActive(state: PauseState): boolean {
	if (!state.paused) return false;
	const deadline = pauseDeadlineMs(state);
	return deadline === null || deadline > Date.now();
}

export function readPauseState(): PauseState {
	try {
		const path = pauseStatePath();
		if (!existsSync(path)) return NOT_PAUSED;
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PauseState>;
		if (raw.paused !== true) return NOT_PAUSED;
		return {
			paused: true,
			until: typeof raw.until === "string" ? raw.until : null,
			since: typeof raw.since === "string" ? raw.since : null,
			rev: typeof raw.rev === "number" && Number.isFinite(raw.rev) ? raw.rev : 0,
			by: typeof raw.by === "string" ? raw.by : null,
		};
	} catch {
		return NOT_PAUSED; // fail-open: a broken file never blocks a session
	}
}

/**
 * Write one record. Atomic (temp file plus rename in the same directory) so a
 * reader in another process sees either the previous record or this one, never
 * a half-written file — the race a rewrite of an expiring deadline depends on.
 * Returns the record written; a write failure returns it unchanged and leaves
 * the file alone, so a failed write cannot invent a pause.
 */
function write(state: PauseState): PauseState {
	const path = pauseStatePath();
	const current = readPauseState();
	const next: PauseState = { ...state, rev: current.rev + 1 };
	try {
		mkdirSync(dirname(path), { recursive: true });
		const temp = `${path}.tmp-${process.pid}`;
		writeFileSync(temp, JSON.stringify(next, null, 2) + "\n");
		renameSync(temp, path);
	} catch {
		/* a failed write leaves the previous record in place */
	}
	return next;
}

/** Set or replace the pause. `untilMs` null means indefinite. */
export function setPause(untilMs: number | null, by: string): PauseState {
	return write({
		paused: true,
		until: untilMs === null ? null : new Date(untilMs).toISOString(),
		since: new Date().toISOString(),
		rev: 0,
		by,
	});
}

/** Release the pause: every process's next read sees it. */
export function clearPause(by: string): PauseState {
	return write({ paused: false, until: null, since: null, rev: 0, by });
}

/** A duration in the compact form the footer and the notices print. */
export function formatDuration(ms: number): string {
	if (ms >= UNIT_MS.h) {
		const hours = Math.floor(ms / UNIT_MS.h);
		const minutes = Math.round((ms % UNIT_MS.h) / UNIT_MS.m);
		return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
	}
	if (ms >= UNIT_MS.m) return `${Math.round(ms / UNIT_MS.m)}m`;
	return `${Math.round(ms / UNIT_MS.s)}s`;
}

/** The footer/notice label for the current pause: remaining time, or indefinite. */
export function pauseRemainingLabel(state: PauseState, now = Date.now()): string {
	const deadline = pauseDeadlineMs(state);
	if (deadline === null) return "no deadline";
	return formatDuration(Math.max(0, deadline - now));
}

/**
 * Call `onChange` whenever the state file changes, in THIS process.
 *
 * Every parked handler also re-reads the file on its own wake-up timer, so a
 * watch that cannot start costs latency only — it can never lose the flip. The
 * DIRECTORY is watched, not the file: the state is written by a rename onto the
 * path, so watching the file's inode would go deaf on the first rewrite. Every
 * event is re-read through `readPauseState()` by the consumer, which never
 * interprets the event type, and an event for another entry of the runtime dir
 * is ignored by name. Events are coalesced by a short timer.
 *
 * Returns a disposer, always safe to call, including after a watch that never
 * started.
 */
export function watchPauseState(onChange: () => void, debounceMs = 50): () => void {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let watcher: FSWatcher | null = null;
	try {
		watcher = watch(dirname(pauseStatePath()), { persistent: false }, (_event, filename) => {
			// Some platforms report no name; an unidentified event re-reads anyway.
			if (typeof filename === "string" && filename !== basename(pauseStatePath())) return;
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
		// state in place; the wake-up re-read still picks the real one up.
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
