/**
 * pause: park pi's agent loop until a deadline (or an explicit resume).
 *
 * A paused session issues NO provider request: the run is held at a boundary
 * hook rather than refused, so a wake that arrives while the pause is active
 * waits instead of being lost, and resumes with its own context when the pause
 * ends. State lives in ONE machine-global file (`$XDG_RUNTIME_DIR/pi-pause.json`,
 * see `pause-state.ts`), so every process — every full session, every child
 * — reads the same pause and a flip in one reaches the others.
 *
 * BOUNDARY. Two hooks, both awaited by the agent loop with no timeout:
 *  - `turn_start` — the first hook of EVERY turn and every wake source
 *    (interactive typing, `sendUserMessage`, and a custom `triggerTurn` wake
 *    such as an intercom delivery, which bypasses `input` entirely). Parking
 *    here holds the turn before any request is built, and the wake message is
 *    already persisted in the transcript by then, so resume is lossless.
 *  - `before_provider_request` — the last gate: a pause set while a turn is
 *    in flight (a flip observed by the file watcher mid-turn) still cannot
 *    emit a request, because the request is built and then held here.
 * Nothing is parked mid-batch, mid-tool-result or mid-stream.
 *
 * THE TWO CLOCKS (parkIfPaused):
 *  - TIMED — the requested deadline governs. The park wait ends at that
 *    deadline however long it is; the safety ceiling below never shortens it.
 *  - INDEFINITE — there is no deadline to wait for, so the CEILING governs:
 *    each wait chunk is bounded by it and re-armed, which re-reads the file and
 *    logs why. The ceiling therefore never ends an indefinite pause by itself;
 *    it makes the park announce itself periodically and re-evaluate, so a park
 *    can only outlive its intent if the file itself still says paused.
 * Both clocks wake early on every state-file change (one watcher per process),
 * so a rewrite is obeyed immediately and a release applies at once.
 *
 * REWRITE. `/pause <duration>` while a pause is active REPLACES the deadline in
 * both directions. A parked handler does not resume and re-park for that: it
 * re-reads the file at every wake-up, so the new deadline lands on the same
 * wait loop. The release decision is made from a FRESH read only, never from
 * the event that woke the handler, and there is exactly one release point per
 * park — a rewrite therefore cannot double-release, and the old deadline
 * expiring in the same instant as a rewrite is settled by revision: a newer
 * write wins and the park continues.
 *
 * EXPIRY. A timed pause ends at its deadline with nothing sent to the session:
 * the parked handler re-reads the file, sees the deadline passed, and lets its
 * turn continue. An idle session needs nothing at all — its next wake parks at
 * `turn_start`, finds no active pause, and proceeds.
 *
 * EXIT BEHAVIOUR (measured on the installed build, pi 0.87.1 — a parked handler
 * promise is not abortable by any signal). `/quit`, Ctrl+D, stdin EOF, SIGTERM
 * and `ctx.shutdown()` all release a parked run in about a second and emit
 * `session_shutdown`, so a parked session is still killable. Escape, Ctrl+C and
 * RPC `abort` DO NOT release a park — they wait for the run to become idle,
 * which a parked run never does — so the escape hatch for a stuck park is
 * `/quit` or a signal, never the interrupt key. The wait chunk is a real timer,
 * so a park also holds a headless (`-p`) process open; the probe that measured
 * the exit paths parked on a bare promise and drained the event loop instead.
 *
 * Fail-open everywhere: an unreadable state file reads as not paused, and a
 * thrown handler returns undefined — a bug here must never strand a session.
 *
 * REACH — what this extension can and cannot stop, and the check for it.
 *
 * The unit of reach is the SESSION INIT, not the process. An interactive pi
 * process runs extension discovery again at every session init, so a session
 * started after this file existed is reachable even inside a process that began
 * before it. An async child is different: it is launched with an explicit
 * `--extension` argv and its resolved list is fixed at launch and recorded, so a
 * child launched before this file existed can never gain it.
 *
 * To ask whether a GIVEN process is gated, read that process's own pause lines
 * (the pid must be the live one) — an `armed` line is written at every session
 * init, and any park/set/cleared line proves reach too:
 *
 *   python3 -c 'import json,os,sys;pid=sys.argv[1];p=os.path.expanduser("~/.local/share/pi-hooks/log.jsonl");hits=[json.loads(l) for l in open(p) if ("\"proc\":%s,"%pid) in l and "\"source\":\"pause\"" in l];print("pid",pid,"— no pause-hook evidence in",p) if not hits else [print(" ",h["ts"],h["kind"],h["detail"]) for h in hits[-4:]]' <pid>
 *
 * A line is proof of reach; silence is proof only for a process that started
 * after the `armed` line existed. Two authorities override it:
 *  - an async child run records what it was launched with — the ids in
 *    `launchResolvedExtensions.configured` of its own `status.json` (run dir
 *    under `/tmp/pi-subagents-<uid>/async-subagent-runs/`) must contain
 *    `sha256:700f8aaf9eae4b43` (this file's id: the first 16 hex of the sha256
 *    of its normalised path);
 *  - an interactive session answers for itself: `/pause status` replies only
 *    where this extension loaded.
 *
 * The limits, each with the consequence that follows from it:
 *  - Only a session that loaded this file is reachable — one whose init predates
 *    it, and any child launched before it (a warm-resumed run keeps its launch
 *    plan), never reads the state file. The operator's remedy is a NEW SESSION
 *    in that process, or a fresh child: no form of `/pause` can enter it.
 *  - The pause acts at the NEXT boundary (`turn_start`, or immediately before a
 *    provider request), never instantly — a turn already streaming and a tool
 *    call already dispatched run to completion, so /pause is not a stop button
 *    for work in flight.
 *  - It cannot cancel a tool call or a provider request already in flight; that
 *    call completes and its result is written.
 *  - The safety ceiling bounds ONE wait of an INDEFINITE park only; a timed
 *    park waits out its full deadline, which the ceiling neither shortens nor
 *    extends.
 *  - A park lives in the process, not in the file: the process dying, being
 *    restarted or `/quit` ends it, so a pause holds RUNNING sessions rather
 *    than locking the machine against future ones.
 *  - Escape and Ctrl+C cannot release a park (the hatch is `/quit` or a
 *    signal), so a parked session is ended, never interrupted.
 */
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { hookLog } from "@tinoy/pi-ext-lib";

import {
	clearPause,
	formatDuration,
	isPauseActive,
	type PauseState,
	parseDurationMs,
	pauseDeadlineMs,
	pauseStatePath,
	readPauseState,
	setPause,
	watchPauseState,
} from "./pause-state.ts";

/** The indefinite clock's chunk length: how long one wait runs before re-arming. */
const DEFAULT_CEILING_MS = 30 * 60_000;

/**
 * Grace added when a timed park's deadline is reached, before the park is
 * released: a rewrite landing in the same instant as the old expiry must win,
 * and a file written a moment ago is visible by the end of this window.
 */
const EXPIRY_SETTLE_MS = 150;

/** The ceiling in force for this process: `PI_PAUSE_CEILING_MS` overrides. */
function ceilingMs(): number {
	const raw = Number(process.env.PI_PAUSE_CEILING_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CEILING_MS;
}

const PAUSE_GLYPH = "\uf04c"; // fa-pause

export default function (pi: ExtensionAPI): void {
	let stopWatch: (() => void) | null = null;
	let lastUi: ExtensionUIContext | undefined;

	/** Waiters of the current park waits; resolving one makes it re-read the file. */
	const wakeups = new Set<() => void>();

	/**
	 * Release every pending wait in THIS process so each re-reads the state
	 * file. It wakes the wait; it never decides the outcome — that is always the
	 * fresh read — which is what keeps a rewrite indistinguishable from a
	 * release at this layer.
	 */
	function wakeWaiters(): void {
		const pending = [...wakeups];
		wakeups.clear();
		for (const wake of pending) wake();
	}

	/** Sleep that a state-file change can cut short. */
	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				wakeups.delete(finish);
				resolve();
			};
			const timer = setTimeout(finish, ms);
			wakeups.add(finish);
		});
	}

	function writerName(): string {
		try {
			return pi.getSessionName() || String(process.pid);
		} catch {
			return String(process.pid);
		}
	}

	// ── Footer ────────────────────────────────────────────────────────────────
	/** One footer write, tolerant of a UI-less context (print/RPC modes). */
	function syncFooter(ui: ExtensionUIContext | undefined, state: PauseState): void {
		try {
			if (!ui) return;
			if (!isPauseActive(state)) {
				ui.setStatus?.("pause", undefined);
				return;
			}
			const label = state.until ? `until ${state.until.slice(11, 16)}Z` : "until resume";
			const text = `${PAUSE_GLYPH} ${label}`;
			ui.setStatus?.("pause", ui.theme ? ui.theme.fg("warning", text) : text);
		} catch {
			/* footer is cosmetic */
		}
	}

	/**
	 * Did a NEWER write land while this park waited out its deadline? Called only
	 * after the deadline has passed, so a pause still active here is a rewrite
	 * (a new deadline, or a switch to indefinite) and the park continues. Settled
	 * by a fresh read, so a rewrite and an expiry in the same instant converge on
	 * the file's current content rather than on which event arrived first.
	 */
	async function newerWriteLanded(revAtDeadline: number): Promise<boolean> {
		await sleep(EXPIRY_SETTLE_MS);
		const after = readPauseState();
		if (!isPauseActive(after)) return false; // released, or still the same expired deadline
		if (after.rev === revAtDeadline) return false;
		const deadline = pauseDeadlineMs(after);
		return deadline === null || deadline > Date.now();
	}

	/**
	 * Hold this turn while a pause is active. Returns as soon as the file says
	 * the pause is over — released, or a timed deadline that has passed.
	 */
	async function parkIfPaused(boundary: string): Promise<void> {
		let parkedAt: number | null = null;
		let parkedRev = -1;

		const finish = (reason: string): void => {
			if (parkedAt === null) return;
			hookLog("pause", "release", {
				boundary,
				reason,
				heldMs: Date.now() - parkedAt,
				rev: parkedRev,
			});
		};

		for (;;) {
			const state = readPauseState();
			if (!state.paused) {
				// An explicit release: no deadline to wait for, nothing to settle.
				finish("cleared");
				return;
			}
			const deadline = pauseDeadlineMs(state);
			const remaining = deadline === null ? null : deadline - Date.now();

			if (remaining !== null && remaining <= 0) {
				// TIMED clock: the requested deadline governs and has arrived. A
				// rewrite landing in the same instant must still win, so the release
				// is settled against a fresh read before the turn continues.
				if (await newerWriteLanded(state.rev)) continue;
				finish("deadline");
				return;
			}

			if (parkedAt === null) {
				parkedAt = Date.now();
				hookLog("pause", "park", {
					boundary,
					rev: state.rev,
					until: state.until,
					indefinite: remaining === null,
				});
			}
			parkedRev = state.rev;

			// TIMED waits run straight to the deadline, however long it is; the
			// INDEFINITE wait is bounded by the ceiling, which re-arms below.
			await sleep(remaining === null ? ceilingMs() : remaining);

			if (remaining === null) {
				const after = readPauseState();
				if (after.paused && pauseDeadlineMs(after) === null) {
					hookLog("pause", "ceiling-rearm", { boundary, ceilingMs: ceilingMs() });
				}
			}
		}
	}

	// ── Live sync: one watcher per process ───────────────────────────────────
	/**
	 * The file carries the pause to every process; the watch only shortens the
	 * latency of noticing it. A destroyed watch costs latency, never the flip:
	 * every park wait re-reads the file on its own timer and every turn
	 * re-reads it at `turn_start`.
	 */
	function startStateWatch(): void {
		if (stopWatch) return;
		stopWatch = watchPauseState(() => {
			try {
				const state = readPauseState();
				syncFooter(lastUi, state);
				wakeWaiters();
			} catch {
				/* fail-open: the park's own timer still re-reads the file */
			}
		});
	}

	// ── Commands ──────────────────────────────────────────────────────────────
	/**
	 * Set the pause and tell the processes. Writing the file is the whole
	 * cross-process act (every process's watcher wakes its parks); `wakeWaiters`
	 * is the same wake-up for the parks in THIS process, which would otherwise
	 * wait for the watcher's debounce.
	 */
	function applyPause(untilMs: number | null, ui: ExtensionUIContext): void {
		const written = setPause(untilMs, writerName());
		syncFooter(ui, written);
		wakeWaiters();
		hookLog("pause", "set", { until: written.until, rev: written.rev, by: written.by });
	}

	function applyRelease(ui: ExtensionUIContext, reason: string): void {
		const written = clearPause(writerName());
		syncFooter(ui, written);
		wakeWaiters();
		hookLog("pause", "cleared", { rev: written.rev, reason, by: written.by });
	}

	function statusLine(): string {
		const state = readPauseState();
		if (!isPauseActive(state)) return `pause: none (${pauseStatePath()})`;
		const remaining = state.until
			? `${formatDuration(Math.max(0, (pauseDeadlineMs(state) ?? 0) - Date.now()))} left`
			: "until an explicit resume";
		return `pause: active, ${remaining} (until ${state.until ?? "resume"}, set by ${state.by ?? "unknown"} at ${state.since ?? "unknown"}) — file ${pauseStatePath()}`;
	}

	pi.registerCommand("pause", {
		description:
			"Pause this session's agent loop: no provider request until the deadline. Usage: /pause (until an explicit resume) | /pause 45m (a bare number is minutes; s/m/h suffixes compound, e.g. 90s, 1h30m) | /pause status | /pause off. Accepted release forms: /unpause, /pause off, /pause resume, /pause on. /resume is deliberately NOT the release verb — pi owns that name for its session switcher, so a release command there would be dead.",
		getArgumentCompletions: (prefix) => {
			const options = ["off", "status", "5m", "30m", "1h", "resume", "on"];
			const filtered = options.filter((o) => o.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			try {
				const arg = (args ?? "").trim().toLowerCase();
				if (arg === "status") {
					ctx.ui.notify(statusLine(), "info");
					return;
				}
				if (
					arg === "off" ||
					arg === "clear" ||
					arg === "none" ||
					arg === "resume" ||
					arg === "on"
				) {
					applyRelease(ctx.ui, "command");
					ctx.ui.notify("pause: off — parked turns continue.", "info");
					return;
				}
				if (arg === "") {
					applyPause(null, ctx.ui);
					ctx.ui.notify("pause: active until an explicit resume (/pause off).", "info");
					return;
				}
				const ms = parseDurationMs(arg);
				if (ms === null) {
					ctx.ui.notify(
						`pause: cannot read "${arg}" as a duration — use a bare number of minutes (30), a suffixed form (90s, 5m, 2h), a compound form (1h30m), or off|resume|on|status.`,
						"warning",
					);
					return;
				}
				if (ms <= 0) {
					applyRelease(ctx.ui, "zero-duration");
					ctx.ui.notify("pause: off — a zero duration clears the pause.", "info");
					return;
				}
				const previous = readPauseState();
				applyPause(Date.now() + ms, ctx.ui);
				const verb = previous.paused && isPauseActive(previous) ? "rewritten to" : "active for";
				ctx.ui.notify(
					`pause: ${verb} ${formatDuration(ms)} (until ${new Date(Date.now() + ms).toISOString()}).`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`pause: command failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// The release verb under its own name: pi's built-in `/resume` is claimed by
	// the session switcher, so a release command cannot live there.
	pi.registerCommand("unpause", {
		description: "Release the pause: parked turns continue immediately.",
		handler: async (_args, ctx) => {
			try {
				applyRelease(ctx.ui, "unpause");
				ctx.ui.notify("pause: off — parked turns continue.", "info");
			} catch (err) {
				ctx.ui.notify(
					`unpause failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// ── Lifecycle ─────────────────────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		try {
			lastUi = ctx.ui;
			syncFooter(ctx.ui, readPauseState());
			startStateWatch();
			// Proof of reach for THIS process, keyed by pid: the operator asking
			// whether a live process is gated reads its own pause lines, and a
			// process that has this extension always has at least this one.
			hookLog("pause", "armed", {
				stateFile: pauseStatePath(),
				paused: isPauseActive(readPauseState()),
			});
		} catch {
			/* fail-open */
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			stopWatch?.();
			stopWatch = null;
			// Release every pending wait so an orderly shutdown never waits on a
			// park; the exit paths do not await a handler promise either way.
			wakeups.clear();
			ctx.ui.setStatus("pause", undefined);
		} catch {
			/* fail-open */
		}
	});

	// The two park boundaries. Ordered cheapest-first: `turn_start` holds a turn
	// before any request is built, `before_provider_request` catches a pause set
	// while a turn was already in flight.
	pi.on("turn_start", async () => {
		try {
			await parkIfPaused("turn_start");
		} catch {
			/* fail-open: a bug here must never block a turn */
		}
	});

	pi.on("before_provider_request", async () => {
		try {
			await parkIfPaused("before_provider_request");
		} catch {
			/* fail-open */
		}
	});

	// Per-turn re-read: the fallback that tracks the file when the watch cannot
	// start, and the footer re-sync for a flip this process never watched.
	pi.on("context", (_event, ctx) => {
		try {
			lastUi = ctx.ui;
			syncFooter(ctx.ui, readPauseState());
		} catch {
			/* fail-open */
		}
	});
}
