/**
 * state-log.ts — where a package's append-only record lives.
 *
 * Every recorder writes one JSONL file under the same state directory. Each of them used
 * to compute that path for itself: the same `$XDG_STATE_HOME` fallback into
 * `~/.local/state`, the same `pi/` subdirectory, a different file name, and a different
 * variable to override the whole path. One function keeps the layout in one place, so
 * relocating the state tree is one edit, and an override is honoured the same way in
 * every package — a variable that is set but empty is not an override.
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The directory every package's record lives in: `$XDG_STATE_HOME/pi`, or
 * `~/.local/state/pi` when that variable is unset.
 */
export function stateDir(): string {
	const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return join(state, "pi");
}

/**
 * One record's path: `override` when it is set and non-empty, otherwise `file` in the
 * state directory.
 */
export function stateLogPath(file: string, override?: string): string {
	return override ? override : join(stateDir(), file);
}
