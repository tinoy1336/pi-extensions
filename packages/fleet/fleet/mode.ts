/**
 * fleet/mode — foreman-mode state and the tool-set transition.
 * One mode file per session (mode-<sessionId>.json) so a second pi session can
 * never disarm this one. Fail-safe ordering: activate = apply the foreman set,
 * then write the mode, with a rollback that puts the previous set back;
 * deactivate = restore the pre-activation set, then write OFF. Any throw leaves
 * the session on its previous tool set with the file saying OFF.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const MODE_DIR = join(process.env.HOME ?? "/root", ".local/pi/foreman/roster");

/**
 * The foreman tool set, applied at activation and frozen for the session's
 * lifetime. The tool array precedes the messages in the cached prefix, so any
 * later change re-bills the remaining tools AND the whole conversation — which
 * is why the set is computed once, here, and never recomputed per turn.
 *
 * `subagent` is absent by design (the crew replaces it) and so are `bash`,
 * `edit`, the `ctx_*` family, the web tools and `bg_wait`: the foreman routes
 * work rather than performing it, and a blocking call would stop it receiving
 * steers. `write` exists only for the foreman's own handoffs and writeoffs.
 * `read` and `image_read` are the two ingestion tools, and they sit adjacent:
 * `image_read` reads the image evidence a worker points at instead of spending
 * a worker run describing it.
 */
export const FOREMAN_TOOLS: readonly string[] = [
	"fleet",
	"read",
	"image_read",
	"todo",
	"io_status",
	"write",
	"preview_export",
	"ask_user_question",
	"set_anchor",
	"canon_add",
	"canon_remove",
	"canon_edit",
	"subagent_supervisor",
	"intercom",
];

export interface ToolSetApi {
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	/** Registered tools, needed to filter the foreman set to what exists here. */
	getAllTools?: () => { name: string }[];
}

function path(sessionId: string): string {
	return join(MODE_DIR, `mode-${sessionId}.json`);
}

function read(sessionId: string): { on?: boolean; sessionId?: string; restore?: string[] } | null {
	try {
		return JSON.parse(readFileSync(path(sessionId), "utf8")) as {
			on?: boolean;
			sessionId?: string;
			restore?: string[];
		};
	} catch {
		return null;
	}
}

export function isOn(sessionId: string): boolean {
	const m = read(sessionId);
	return m?.on === true && m?.sessionId === sessionId;
}

/**
 * The set that was active before activation, restored by `off`. Without it a
 * session that entered foreman mode would stay restricted to fourteen tools
 * forever, because nothing else records what activation displaced.
 */
export function restoreSet(sessionId: string): string[] | undefined {
	const m = read(sessionId);
	return m?.sessionId === sessionId ? m.restore : undefined;
}

function write(sessionId: string, on: boolean, restore?: string[]): void {
	mkdirSync(MODE_DIR, { recursive: true });
	const p = path(sessionId);
	const tmp = `${p}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify({ on, sessionId, since: Date.now(), restore }, null, 2)}\n`);
	renameSync(tmp, p);
}

function registered(api: ToolSetApi, fallback: string[]): Set<string> {
	const all = api.getAllTools?.();
	return new Set(
		(all && all.length ? all.map((t) => t.name) : fallback).filter(
			(n): n is string => typeof n === "string",
		),
	);
}

/**
 * ON — one transaction: apply the foreman set, then record the mode. If EITHER
 * step throws the swap is rolled back and the mode file is forced OFF, so the
 * session is always left with `subagent` present and mode OFF (fail-safe).
 *
 * The set is filtered to tools that are actually REGISTERED in this process: an
 * extension that is not loaded cannot supply its tool, and naming an absent tool
 * would make the array depend on load order rather than on this list.
 */
export function activate(
	api: ToolSetApi,
	sessionId: string,
): { ok: boolean; error?: string; applied: string[]; missing: string[] } {
	const before = api.getActiveTools();
	const known = registered(api, before);
	const applied = FOREMAN_TOOLS.filter((n) => known.has(n));
	const missing = FOREMAN_TOOLS.filter((n) => !known.has(n));
	// `fleet` is this extension's own tool. Its absence means the activation
	// would produce a foreman with no crew surface at all, so refuse instead.
	if (!applied.includes("fleet")) {
		return {
			ok: false,
			error: "the fleet tool is not registered in this process",
			applied,
			missing,
		};
	}
	try {
		api.setActiveTools([...applied]);
		write(sessionId, true, before);
	} catch (e) {
		try {
			api.setActiveTools(before); // rollback: subagent back, fleet out
			write(sessionId, false);
		} catch {
			/* nothing more we can do; the per-call read below keeps fleet inert */
		}
		return { ok: false, error: String(e), applied, missing };
	}
	return { ok: true, applied, missing };
}

/** OFF: restore the pre-activation set FIRST, then write OFF — a throw cannot strand the session. */
export function deactivate(api: ToolSetApi, sessionId: string): void {
	const saved = restoreSet(sessionId);
	// With no saved set there is nothing to restore TO. The registered set is a
	// superset this session never had, and the active set is the foreman fourteen,
	// so applying either would hand a deliberately restricted session a different
	// tool array and re-bill it. Write OFF and leave the set alone.
	if (!saved) {
		write(sessionId, false);
		return;
	}
	const known = registered(api, [...saved, ...api.getActiveTools()]);
	const base = saved.filter((n) => n !== "fleet" && known.has(n));
	api.setActiveTools([...new Set([...base, "subagent"])].filter((n) => known.has(n)));
	write(sessionId, false);
}

/**
 * Retention: delete mode files older than 7 days at process start. Never a
 * blanket delete — another live session's mode file must survive.
 */
export function pruneOld(maxAgeMs = 7 * 24 * 3600 * 1000): void {
	try {
		for (const f of readdirSync(MODE_DIR)) {
			if (!f.startsWith("mode-") || !f.endsWith(".json")) continue;
			const p = join(MODE_DIR, f);
			try {
				if (Date.now() - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p);
			} catch {
				/* leave it */
			}
		}
	} catch {
		/* nothing to prune */
	}
}
