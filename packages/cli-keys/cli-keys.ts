/**
 * cli-keys — hand pi's provider API keys to the environment, and say so when
 * none of them can be resolved.
 *
 * `~/.local/bin/cli-keys` fetches the provider keys from the Proton Pass vault
 * into a mode-600 cache under the XDG STATE directory, which survives a reboot —
 * `$XDG_RUNTIME_DIR` is a tmpfs, so a cache kept there is gone at every boot.
 * The path is not restated here: the script owns it and answers `cli-keys
 * cache-path`, because two readers of one credential file must not be able to
 * disagree about where it is. models.json names that
 * script in pi's COMMAND form — `"apiKey": "!<path>/cli-keys key <NAME>"` — and
 * that command is the guarantee that a provider resolves: pi counts a command
 * value as configured from the configuration alone, without running it
 * (dist/core/provider-composer.js:216). This hook is the optimisation on top: it
 * copies the cache into `process.env`, which is the command's first branch and
 * the environment every spawned tool child inherits.
 *
 * Hydration cannot decide a launch, and this hook must not claim to. pi creates
 * the model runtime and awaits its first availability pass BEFORE any extension
 * exists (dist/core/agent-session-services.js:57; extensions load at :69), and a
 * later availability pass can be dropped whole by the newer-pass guard
 * (dist/core/model-runtime.js:184), leaving the snapshot derived from the
 * pre-extension set of configured providers (…:166-171). Hydrating at module
 * evaluation therefore only warms a later refresh: it reaches no launch-time
 * decision. The command form, not this hook, is what keeps the providers listed
 * when hydration finds nothing.
 *
 * Because that command is never run to decide availability, an unsatisfiable
 * command — script gone, cache absent or stale with the vault unreachable,
 * environment stripped — still launches clean with the models listed, and the
 * failure would otherwise appear only as a hard error on the first request. So
 * this hook checks: when hydration writes no names it runs the commands
 * models.json configures, bounded, and when none of them can produce a value it
 * says so — a UI notice where there is a UI, one stderr line where there is not.
 * It prints no credential and no cache content.
 *
 * Hydration and `cli-keys-refresh.service` both drive that script: when the cache
 * is past the expiry it carries, hydration runs the fetch itself, bounded, before
 * copying anything, and the service reconciles on every NetworkManager
 * connectivity change so a machine that comes back online is refreshed without a
 * session. The script is idempotent — a fresh cache returns before touching the
 * vault — so the common path costs one file read and one process. The cache can
 * also be absent, and the expiry decides only WHEN TO REFRESH: an expired cache is
 * still served, because an hours-old credential resolves a request and no
 * credential does not. The expiry is written by the fetch script, which is the ONE
 * place the freshness window is defined.
 *
 * Two things drive that script from this process, and both end at ONE hydration
 * function. `/cli-keys refresh` runs it with the script's own `--force`, so an
 * operator can demand the fetch the freshness window would otherwise skip, and a
 * watch on the cache's directory re-reads the file whenever ANY writer commits a new
 * generation — the refresh service, a forced fetch in another process, an operator's
 * own `cli-keys`. The watch is what a fetch alone cannot do: the value hydrated at
 * load lives in `process.env` for the life of the session, so without it a rotated
 * credential reaches neither this process's environment nor the tool children that
 * inherit it. `--force` remains the script's flag to honour, so the command reports
 * whether a fetch actually landed instead of reporting the word `refreshed`.
 *
 * An absent, unreadable or malformed cache leaves the environment exactly as it
 * was: no partial write, no throw, and the fetch stays bounded. A launch that can
 * still resolve a key stays silent; the single case that speaks is the one where
 * nothing can resolve.
 */
import { spawnSync } from "node:child_process";
import { type FSWatcher, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hookLog } from "@tinoy/pi-ext-lib";

/**
 * The paths this hook resolves, each read from the environment with a TRUTHY
 * check, so an empty value falls back exactly as pi's own `getAgentDir`
 * (dist/config.js) falls back — an empty variable is not a setting. Exported so the
 * resolution itself is assertable in a rig, without importing a fetch side effect.
 */

/**
 * The fetch script, from the home directory pi and the rest of the tree resolve
 *  through `os.homedir()`. */
export const SCRIPT_PATH = `${process.env.HOME || homedir()}/.local/bin/cli-keys`;

/**
 * Bound on the script's own path answer, which is an echo and no network call.
 */
const PATH_TIMEOUT_MS = 5_000;

/**
 * The cache path, asked of the script that owns it: one definition, so a move of
 * the cache is a change in one file. An empty string means the script could not
 * answer (missing, not executable, not a cli-keys script), and hydration then has
 * nowhere to read from — which is reported, never guessed at with a literal.
 */
function resolveCachePath(): string {
	try {
		const result = spawnSync(SCRIPT_PATH, ["cache-path"], {
			timeout: PATH_TIMEOUT_MS,
			encoding: "utf8",
		});
		const answer = typeof result.stdout === "string" ? result.stdout.trim() : "";
		return result.status === 0 && answer.startsWith("/") ? answer : "";
	} catch {
		return "";
	}
}

export const CACHE_PATH = resolveCachePath();

/** The cache path for a message: the script's answer, or that it gave none. */
function cacheLocation(): string {
	return CACHE_PATH || `cli-keys cache-path (${SCRIPT_PATH} answered nothing)`;
}

/** Same path pi resolves models.json from (dist/config.js getAgentDir): the agent
 *  directory variable first, its home-directory default otherwise, both read with a
 *  truthy check — `PI_CODING_AGENT_DIR=""` is pi's "unset", not a directory whose
 *  name is the empty string. */
export const MODELS_PATH = `${process.env.PI_CODING_AGENT_DIR || `${process.env.HOME || homedir()}/.pi/agent`}/models.json`;

/**
 * Bound on the fetch. A cold fetch is a network round trip of a few seconds;
 * past this bound the hydration gives up on the cache and the session starts
 * unauthenticated instead of stalling startup.
 */
const FETCH_TIMEOUT_MS = 15_000;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Bound on one command probe, matching pi's own bound on a command value
 * (dist/core/resolve-config-value.js:159-169) so a working command is not
 * misjudged; PROBE_DEADLINE_MS bounds the phase so a failing launch cannot stall
 * on it, and MAX_PROBE_COMMANDS caps how many configured commands are run.
 */
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_DEADLINE_MS = 12_000;
const MAX_PROBE_COMMANDS = 4;

/**
 * pi's command form in models.json: the apiKey value is `!<command>` and pi hands
 * the rest of the string to /bin/sh verbatim (dist/core/resolve-config-value.js:66,
 * :159). Only the command is captured here, and a non-command value is ignored.
 */
const API_KEY_COMMAND_RE = /"apiKey"\s*:\s*"(![^"\\]*)"/g;

/** Which call site hydrated: extension load, a session start, the explicit command, or a cache write by another process. */
type HydrationPhase = "load" | "session_start" | "command" | "cache_change";

/**
 * Whether a hydration runs the script's fetch. `if-stale` is the load and session
 * start path and lets the cache's own expiry decide; `force` is the explicit command
 * and skips that window; `never` is the cache-change path, whose writer just produced
 * the generation being read, so a fetch there could only race it.
 */
type HydrationRefresh = "if-stale" | "force" | "never";

/** One refresh run's verdict: what the script answered, whether a new generation landed, and whether it knew the flag. */
interface RefreshResult {
	outcome?: string;
	refetched: boolean;
	forceIgnored: boolean;
}

/** One hydration's result: the names written, and the refresh run that preceded them when there was one. */
interface HydrationResult {
	names: string[];
	refresh?: RefreshResult;
}

/** A command models.json configures for a provider key, with the provider id when it is readable. */
interface ConfiguredCommand {
	provider?: string;
	command: string;
}

/** One configured command's verdict: whether it can produce a value, and why not. */
interface CommandProbe {
	provider?: string;
	command: string;
	reason: string;
	resolved: boolean;
}

export interface CliKeyCache {
	expires_epoch?: unknown;
	/** The epoch the generation was fetched at, which is how a refresh is seen to have landed. */
	fetched_epoch?: unknown;
	keys?: Record<string, unknown>;
}

/** The freshness rule for a REFRESH: only the cache's own expiry decides, and it must be future. */
export function isFresh(cache: CliKeyCache | undefined, nowSeconds: number): boolean {
	const expires = cache?.expires_epoch;
	return typeof expires === "number" && Number.isFinite(expires) && expires > nowSeconds;
}

/**
 * Copy every cached credential into `env`, returning the names written. The expiry is
 * deliberately NOT consulted: it decides when to refresh, never what may be handed
 * out, and the case that matters is the one where a refresh cannot happen — an
 * hours-old credential still resolves a request, an absent one does not. An empty
 * list means the cache was absent, unreadable or carried no usable value, and the
 * caller must leave the environment alone.
 */
export function hydrateFromCache(cache: CliKeyCache | undefined, env: NodeJS.ProcessEnv): string[] {
	const written: string[] = [];
	for (const [name, value] of usableEntries(cache)) {
		env[name] = value;
		written.push(name);
	}
	return written;
}

/**
 * The cache's usable pairs: an env-identifier name carrying a non-empty string. ONE
 * rule for what may be handed out, so the names a status report lists and the names
 * hydration writes cannot disagree.
 */
function usableEntries(cache: CliKeyCache | undefined): [string, string][] {
	const keys = cache?.keys;
	if (!keys || typeof keys !== "object") return [];
	const entries: [string, string][] = [];
	for (const [name, value] of Object.entries(keys)) {
		if (typeof value !== "string" || value === "" || !ENV_NAME_RE.test(name)) continue;
		entries.push([name, value]);
	}
	return entries;
}

function readCache(): CliKeyCache | undefined {
	if (!CACHE_PATH) return undefined;
	try {
		return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as CliKeyCache;
	} catch {
		return undefined;
	}
}

/**
 * Run the script's refresh and report its own verdict. `ensure --json` answers one
 * JSON document — `outcome: refreshed | fresh | offline | failed` — printed over
 * several lines, because the watcher's journal shows the same bytes. An exit status
 * alone cannot tell an offline skip from a fetch that ran, and reading one as the
 * other hid a day of an offline machine. The fetch itself never truncates a cache it
 * could not replace; this only reports.
 *
 * `force` is passed through as the script's own flag. It is the script's to honour,
 * so the verdict carries `forceIgnored`: a script that does not know the flag treats
 * the run as an ordinary one, answers `fresh` — which a forced run can never be — and
 * leaves `fetched_epoch` where it was. `refetched` reads that epoch across the run for
 * every other case.
 */
function refreshCache(force: boolean): RefreshResult {
	const before = readCache()?.fetched_epoch;
	const result = spawnSync(
		SCRIPT_PATH,
		force ? ["ensure", "--json", "--force"] : ["ensure", "--json"],
		{
			timeout: FETCH_TIMEOUT_MS,
			encoding: "utf8",
		},
	);
	const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
	let outcome: string | undefined;
	try {
		const parsed = JSON.parse(stdout) as { outcome?: unknown };
		if (typeof parsed.outcome === "string") outcome = parsed.outcome;
	} catch {
		/* the script answers JSON; anything else is reported as no outcome at all */
	}
	const after = readCache()?.fetched_epoch;
	const refetched = typeof after === "number" && after !== before;
	const forceIgnored = force && outcome === "fresh";
	hookLog("cli-keys", "refresh", {
		cache: cacheLocation(),
		outcome,
		force,
		refetched,
		forceIgnored,
		status: result.status,
		reason: result.error ? result.error.message : undefined,
	});
	return { outcome, refetched, forceIgnored };
}

/**
 * The ONE hydration path: refresh when the caller's mode allows it, read the cache,
 * copy it into `env`. Load, session start, the explicit command and a cache write by
 * another process all arrive here, so the serving rule cannot differ between them. The
 * refresh verdict travels back with the names written, because an operator is told the
 * outcome and a `force` the script did not honour must never be reported as a fetch.
 */
function hydrateAt(phase: HydrationPhase, refresh: HydrationRefresh = "if-stale"): HydrationResult {
	try {
		const now = Math.floor(Date.now() / 1000);
		let cache = readCache();
		let run: RefreshResult | undefined;
		if (refresh !== "never" && (refresh === "force" || !isFresh(cache, now))) {
			run = refreshCache(refresh === "force");
			cache = readCache();
		}
		const written = hydrateFromCache(cache, process.env);
		hookLog("cli-keys", written.length > 0 ? "hydrated" : "skipped", {
			cache: cacheLocation(),
			phase,
			refresh,
			names: written,
			outcome: run?.outcome,
			refetched: run?.refetched,
			forceIgnored: run?.forceIgnored,
			// Which generation was served, so an offline boot is legible after the fact.
			served: cache === undefined ? "none" : isFresh(cache, now) ? "fresh" : "stale",
		});
		// The watch follows the cache wherever it lives: a writer that creates the state
		// directory on its first fetch is when the watch can be armed at all.
		watchCache();
		return { names: written, refresh: run };
	} catch (err) {
		// Credential hydration must never break a session.
		hookLog("cli-keys", "error", {
			phase,
			reason: err instanceof Error ? err.message : String(err),
		});
		return { names: [] };
	}
}

let cacheWatch: FSWatcher | undefined;

/**
 * Re-read the cache whenever a writer commits a new generation. `process.env` holds
 * the generation this process started with, and a fetch by any OTHER writer — the
 * refresh service, an operator's own `cli-keys`, a forced refresh in another pi —
 * cannot reach it; without this, a rotated credential stays invisible to this process
 * and to every child spawned from it until the session is restarted.
 *
 * The watch is on the cache's DIRECTORY, never on the file: the fetch commits by
 * renaming a temp file over the cache, which ends a watch opened on the replaced
 * inode, while the directory keeps reporting the new entry. The cache-change path
 * never fetches — its writer just produced the generation being read. A directory that
 * does not exist yet (nothing has fetched) leaves the watch unarmed and the next
 * hydration retries it.
 */
function watchCache(): void {
	if (cacheWatch || !CACHE_PATH) return;
	try {
		cacheWatch = watch(dirname(CACHE_PATH), (_event, filename) => {
			if (filename && filename !== basename(CACHE_PATH)) return;
			hydrateAt("cache_change", "never");
		});
		cacheWatch.on("error", (err) => {
			hookLog("cli-keys", "watch-error", { cache: CACHE_PATH, reason: err.message });
		});
		hookLog("cli-keys", "watching", { cache: CACHE_PATH });
	} catch (err) {
		cacheWatch = undefined;
		hookLog("cli-keys", "watch-error", {
			cache: CACHE_PATH,
			reason: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * The command values models.json configures, in file order. The provider id
 * comes from the file when it parses as plain JSON, so a notice can name it;
 * models.json may also carry comments, so a file that does not parse falls back
 * to the command scan without provider ids.
 */
function configuredCommands(): ConfiguredCommand[] {
	let raw: string;
	try {
		raw = readFileSync(MODELS_PATH, "utf8");
	} catch {
		return [];
	}
	try {
		const parsed = JSON.parse(raw) as { providers?: Record<string, { apiKey?: unknown }> };
		const found: ConfiguredCommand[] = [];
		for (const [provider, config] of Object.entries(parsed.providers ?? {})) {
			const apiKey = config?.apiKey;
			if (typeof apiKey === "string" && apiKey.startsWith("!") && apiKey.length > 1) {
				found.push({ provider, command: apiKey.slice(1).trim() });
			}
		}
		if (found.length > 0) return found;
	} catch {
		/* comments are legal in models.json; fall through to the command scan */
	}
	const scanned: ConfiguredCommand[] = [];
	for (const match of raw.matchAll(API_KEY_COMMAND_RE)) {
		const command = (match[1] ?? "").slice(1).trim();
		if (command && !scanned.some((entry) => entry.command === command)) scanned.push({ command });
	}
	return scanned;
}

/**
 * A command reduced to what an operator needs: its program and its
 * identifier-shaped arguments (a key name). Anything else is dropped, so no
 * notice and no hook-log row can echo a value a command string happens to carry.
 */
function commandLabel(command: string): string {
	const tokens = command.split(/\s+/).filter(Boolean);
	const program = tokens[0] ?? command;
	return [program, ...tokens.slice(1).filter((token) => ENV_NAME_RE.test(token))].join(" ");
}

/**
 * Run one configured command the way pi runs it (through /bin/sh) and decide
 * whether it can produce a value. pi's rule is a non-empty stdout on a zero exit;
 * the value is measured and dropped, never logged and never written anywhere.
 */
function probeCommand(entry: ConfiguredCommand, timeoutMs: number): CommandProbe {
	const result = spawnSync("/bin/sh", ["-c", entry.command], {
		timeout: timeoutMs,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const resolved =
		result.status === 0 && typeof result.stdout === "string" && result.stdout.trim().length > 0;
	let reason = "resolved";
	if (!resolved) {
		if (result.error) reason = `cannot run (${result.error.message})`;
		else if (result.status === 0) reason = "empty output";
		else if (result.status === null) reason = "no exit status";
		else reason = `exit ${result.status}`;
	}
	return { provider: entry.provider, command: entry.command, reason, resolved };
}

/**
 * Say so when nothing can resolve a provider key. Reachable only when hydration
 * wrote no names AND no configured command produces a value, so a launch that
 * works never sees it: what the probes found is recorded in the hook log, and the
 * notice names the failing commands and the cache path and carries no value. With
 * a UI (interactive, RPC) it is a notice; a headless run has no UI context to
 * notify, so it is one stderr line, where a captured child shows it.
 */
function reportUnresolvable(ctx: ExtensionContext): void {
	const commands = configuredCommands();
	if (commands.length === 0) {
		hookLog("cli-keys", "probe-skipped", { models: MODELS_PATH, reason: "no command-form apiKey" });
		return;
	}
	const deadline = Date.now() + PROBE_DEADLINE_MS;
	const probes: CommandProbe[] = [];
	let truncated = false;
	for (const entry of commands) {
		if (probes.length >= MAX_PROBE_COMMANDS || Date.now() >= deadline) {
			truncated = true;
			break;
		}
		const probe = probeCommand(
			entry,
			Math.min(PROBE_TIMEOUT_MS, Math.max(1_000, deadline - Date.now())),
		);
		probes.push(probe);
		if (probe.resolved) break;
	}
	const resolved = probes.some((probe) => probe.resolved);
	hookLog("cli-keys", resolved ? "probe-ok" : truncated ? "probe-truncated" : "unresolvable", {
		models: MODELS_PATH,
		cache: cacheLocation(),
		commands: probes.map((probe) => `${commandLabel(probe.command)} → ${probe.reason}`),
	});
	// Truncated means unchecked, not unresolved: a notice on that evidence could
	// accuse a launch that works.
	if (resolved || truncated) return;
	const detail = probes
		.map(
			(probe) =>
				`${probe.provider ? `${probe.provider}: ` : ""}${commandLabel(probe.command)} (${probe.reason})`,
		)
		.join("; ");
	const notice =
		`cli-keys: no provider key can be resolved — ${detail}. ` +
		"pi counts a models.json command as configured without running it, so the providers stay listed and the first request will fail; " +
		`nothing hydrated either (no environment value, no usable credential at ${cacheLocation()}). ` +
		`Log the vault client in and run ${SCRIPT_PATH}, or export the variables — cli-keys-refresh.service retries on every connectivity change.`;
	if (ctx.hasUI) ctx.ui.notify(notice, "error");
	else process.stderr.write(`${notice}\n`);
}

// Hydration runs at session start, on the explicit command, and whenever another writer
// commits a new cache generation — never at module evaluation, which pi reaches before a
// session exists and where a shell-out has no tty to answer it.

/** What a hydration wrote, in the terms an operator needs: names, never values. */
function hydrationLine(result: HydrationResult): string {
	const names = result.names.length > 0 ? result.names.join(", ") : "none";
	return `${result.names.length} name(s) in this process's environment: ${names}`;
}

/** The reply to `/cli-keys refresh`: whether the fetch the operator asked for landed. */
function refreshLine(result: HydrationResult): string {
	const run = result.refresh;
	const fetch = run?.forceIgnored
		? "no fetch ran: this cli-keys script does not honour --force (it answered `fresh`), so the cache was only re-read"
		: run
			? `fetch outcome ${run.outcome ?? "unknown"}${run.refetched ? ", a new generation landed" : ", the cache was not replaced"}`
			: "no fetch was attempted";
	return `cli-keys: forced refresh — ${fetch}; ${hydrationLine(result)}. cache: ${cacheLocation()}`;
}

/** The reply to `/cli-keys status`: the generation on disk, and this process's copy of it. */
function statusLine(): string {
	const now = Math.floor(Date.now() / 1000);
	const cache = readCache();
	const entries = usableEntries(cache);
	if (cache === undefined) {
		return `cli-keys: no readable cache at ${cacheLocation()} — /cli-keys refresh runs the fetch, and the fetch must succeed before anything can hydrate`;
	}
	const expires = typeof cache.expires_epoch === "number" ? cache.expires_epoch : undefined;
	const state =
		expires === undefined
			? "no expiry recorded"
			: isFresh(cache, now)
				? `fresh, expires in ${expires - now}s`
				: `stale ${now - expires}s past its expiry, still served`;
	const diverged = entries.filter(
		([name, value]) => process.env[name] !== undefined && process.env[name] !== value,
	);
	const absent = entries.filter(([name]) => process.env[name] === undefined);
	const drift =
		entries.length === 0
			? "this process's environment carries none of them"
			: `${entries.length - diverged.length - absent.length}/${entries.length} current here, ${diverged.length} differing from the cache, ${absent.length} not set here`;
	const detail =
		diverged.length > 0 ? ` (differing: ${diverged.map(([name]) => name).join(", ")})` : "";
	return `cli-keys: cache ${state} — ${drift}${detail}. cache: ${cacheLocation()}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (hydrateAt("session_start").names.length > 0) return;
		try {
			reportUnresolvable(ctx);
		} catch (err) {
			// A launch-time notice must never break a session either.
			hookLog("cli-keys", "error", {
				phase: "session_start",
				reason: err instanceof Error ? err.message : String(err),
			});
		}
	});

	// /cli-keys — the operator's surface on a cache that otherwise refreshes on its own
	// schedule. `refresh` demands the fetch now (the script's --force), `status` reports
	// the generation on disk against this process's copy of it; the drift between the two
	// is the state no fetch alone can clear.
	pi.registerCommand("cli-keys", {
		description:
			"cli-keys: provider API-key cache. Usage: /cli-keys [refresh|status] — `refresh` forces a vault fetch now (skipping the cache's freshness window) and re-hydrates this process; `status` reports the cache state and whether this process's environment matches it. No args = status.",
		getArgumentCompletions: (prefix: string) => {
			const options = ["refresh", "status"];
			const matching = options.filter((option) => option.startsWith(prefix));
			return matching.length > 0 ? matching.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			const arg = (args ?? "").trim().toLowerCase();
			if (arg !== "" && arg !== "status" && arg !== "refresh") {
				ctx.ui.notify(
					`cli-keys: unknown argument "${arg}" — use refresh|status (no args = status)`,
					"warning",
				);
				return;
			}
			try {
				if (arg === "refresh") {
					const result = hydrateAt("command", "force");
					const outcome = result.refresh?.outcome;
					ctx.ui.notify(
						refreshLine(result),
						outcome === "failed" ? "error" : outcome === "offline" ? "warning" : "info",
					);
					return;
				}
				ctx.ui.notify(statusLine(), "info");
			} catch (err) {
				ctx.ui.notify(
					`cli-keys: command failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	watchCache();
}
