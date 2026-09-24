/**
 * todo_parent — crew todo proxy.
 *
 * Subagent sessions carry NO local todo tool (agentOverrides tool allowlists
 * exclude it; `excludeTools` belt-and-suspenders). This extension gives children
 * a `todo_parent` tool whose mutations land in the PARENT session's rpiv-todo
 * list SILENTLY — the parent's model is NEVER woken, notified, or asked to do
 * anything.
 *
 *   child  — writes a request file into a supervisor channel dir under the same
 *            root the parent-side watcher polls (the inherited
 *            PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR when a pi-subagents release still
 *            exports it; otherwise a dir of its own under that root, which the
 *            parent's full-root scan finds) and polls for the reply file.
 *   parent — this same file, loaded in the spawning session, polls the
 *            pi-subagents supervisor-channels root for `todo.parent.*`
 *            requests and applies them via @juicesharp/rpiv-todo's PURE
 *            reducer + replay: authoritative state is reconstructed from the
 *            session branch (`replayFromBranch`), the mutation applied, and
 *            a replay-compatible `todo` toolResult is appended to the branch
 *            (durable + replay-re-derivable).
 *
 * The rpiv-todo reducer and replay are the ONE optional neighbour: they are
 * reached through a guarded dynamic import resolved once per process, never by a
 * static import, so a session that has not installed that package still loads
 * this extension. Absent, the parent-side apply answers a refusal naming the
 * package and its install line; the child's proxy tool keeps its own contract.
 *
 * WRITE TRANSPORT (durable only): this watcher appends a replay-compatible
 * `todo` toolResult row to the spawning session's BRANCH through the shared
 * SessionManager (one runner object per process), then emits
 * `pi.events.emit("rpiv-todo:external-refresh", { sid })`.
 *
 * LIVE-VIEW GAP: nothing subscribes to that event in the installed
 * `npm:@juicesharp/rpiv-todo` — the package reads state from a module-private
 * per-session Map (`state/store.ts` `sessions`), written only by its own
 * `replaceState`/`commitState` (index.ts session_start/session_compact/
 * session_tree, and its own tool execute). pi loads each extension through its
 * own jiti instance (`core/extensions/loader.js` → `moduleCache:false`), so
 * that Map is unreachable from here, and ExtensionAPI exposes no tool
 * invocation (`getAllTools()` returns ToolInfo = name/description/parameters
 * only). Consequence: the parent's live `todo` tool and overlay do NOT see a
 * child mutation until their next session_start/compact/tree, and a
 * parent-side `todo` write in between appends a row from that cached view
 * which, under replay's last-write-wins, REPLACES the child's row. The
 * `external-refresh` emit reaches only a patched/vendored rpiv-todo.
 *
 * Request files use type "todo.parent.request" so pi-subagents' own channel
 * poller (it only parses type "subagent.supervisor.request") ignores them;
 * their stale-channel cleanup also stays correct because we remove our files.
 *
 * The child's synchronous reply is computed deterministically from the branch
 * + pure reducer. NO prompts, NO steers, NO intercom to the parent's model.
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	argNumber,
	argText,
	clip,
	type HeaderPart,
	hookLog,
	optionalNeighbour,
	safeToolHeader,
} from "@tinoy/pi-ext-lib";
import { Type } from "typebox";

// NOTE: rpiv-todo's store.js is deliberately NOT reached. It holds the
// module-private `sessions` Map, and pi loads each extension into its own
// module instance — so an extension importing store.js gets a SEPARATE Map from
// the one the host `todo` tool uses. Instead the extension reconstructs
// authoritative state from the session BRANCH (the cross-instance durable
// contract) and persists by appending a replay-compatible `todo` toolResult
// record, exactly the mechanism the package's own replay uses.

const TOOL_NAME = "todo_parent";
const REQUEST_TYPE = "todo.parent.request";
const POLL_MS = 500;
const REPLY_TIMEOUT_MS = 15_000;
const REPLY_POLL_MS = 250;

/** The optional neighbour: its pure reducer and its branch replay. */
const RPIV_PACKAGE = "@juicesharp/rpiv-todo";
const RPIV_REDUCER_MODULE = "@juicesharp/rpiv-todo/state/state-reducer.js";
const RPIV_REPLAY_MODULE = "@juicesharp/rpiv-todo/state/replay.js";

interface TodoState {
	tasks: any[];
	nextId: number;
}

/** The two pure functions this extension needs from the neighbour. */
interface RpivTodo {
	applyTaskMutation(
		state: TodoState,
		action: string,
		params: unknown,
	): { state: TodoState; op: { kind: string; [key: string]: unknown } };
	replayFromBranch(input: { sessionManager: any }): TodoState;
}

/** The refusal the parent-side apply answers while the reducer is absent. */
const RPIV_REFUSAL = `${TOOL_NAME}: unavailable — the ${RPIV_PACKAGE} state reducer is not installed, so a mutation cannot be applied to the session branch. Install it with \`pi install npm:${RPIV_PACKAGE}\`.`;

/**
 * The neighbour, resolved once per process; null answers a refusal by name.
 * Absence is reported once on the diagnostics log, never thrown.
 */
let rpivPromise: Promise<RpivTodo | null> | undefined;

function loadRpiv(): Promise<RpivTodo | null> {
	rpivPromise ??= optionalNeighbour(
		RPIV_PACKAGE,
		() => Promise.all([import(RPIV_REDUCER_MODULE), import(RPIV_REPLAY_MODULE)]),
		{
			source: "todo-parent",
			effect: "a todo mutation cannot be applied to the parent session's branch",
			hint: `pi install npm:${RPIV_PACKAGE}`,
		},
	).then((modules) => {
		if (!modules) return null;
		const [reducer, replay] = modules as [
			{ applyTaskMutation?: RpivTodo["applyTaskMutation"] },
			{ replayFromBranch?: RpivTodo["replayFromBranch"] },
		];
		if (
			typeof reducer?.applyTaskMutation !== "function" ||
			typeof replay?.replayFromBranch !== "function"
		) {
			hookLog("todo-parent", "neighbour-absent", {
				neighbour: RPIV_PACKAGE,
				effect: "the installed package does not export the state reducer and branch replay",
				hint: `reinstall ${RPIV_PACKAGE}`,
			});
			return null;
		}
		return {
			applyTaskMutation: reducer.applyTaskMutation,
			replayFromBranch: replay.replayFromBranch,
		};
	});
	return rpivPromise;
}

/**
 * Appended to every reply: the row lands on the parent's BRANCH, not in the
 * parent's live rpiv-todo store. The divergence is real, so the caller must not
 * be handed a list that reads like the parent's live board (header note).
 */
const BRANCH_ONLY_NOTE =
	"note: recorded on the parent's session branch only — the parent's own todo tool reads a cached view that refreshes at its next session start/compact, and a parent-side todo write before that can drop this entry.";

/** Same layout pi-subagents uses: <root>/supervisor-channels/<run>/{requests,replies}. */
function supervisorChannelRoots(): string[] {
	const roots: string[] = [];
	const configured = process.env.PI_SUBAGENTS_TEMP_ROOT?.trim();
	if (configured) roots.push(join(configured, "supervisor-channels"));
	const uid = process.getuid?.() ?? 0;
	roots.push(join(tmpdir(), `pi-subagents-uid-${uid}`, "supervisor-channels"));
	return roots;
}

/** Channel dir names follow pi-subagents' `<runId>-<agent>-<childIndex>` shape. */
function channelSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_.-]+/g, "_");
}

/**
 * Child metadata. Detection keys off `PI_SUBAGENT_CHILD=1` — the marker
 * pi-subagents sets in EVERY child process
 * (src/runs/shared/child-runtime-config.ts) — NOT the per-run channel envs:
 * 0.66 no longer exports `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` / `_RUN_ID` /
 * `_CHILD_AGENT` / `_CHILD_INDEX` (0.52 did), so the channel dir is derived
 * under the same root the parent-side watcher polls. The parent scans EVERY dir
 * under that root, so an own-named dir is found; pi-subagents' janitor removes a
 * channel dir only when it is empty and >60s stale, which is exactly the state
 * this exchange leaves behind.
 */
function childMetadata():
	| {
			channelDir: string;
			runId: string;
			agent: string;
			childIndex: string;
			orchestratorSessionId?: string;
	  }
	| undefined {
	const inheritedChannelDir = process.env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR?.trim();
	if (process.env.PI_SUBAGENT_CHILD?.trim() !== "1" && !inheritedChannelDir) return undefined;
	const agent = process.env.PI_SUBAGENT_CHILD_AGENT?.trim() || "child";
	const childIndex = process.env.PI_SUBAGENT_CHILD_INDEX?.trim() || "0";
	const runId =
		process.env.PI_SUBAGENT_RUN_ID?.trim() ||
		`todo-parent-${process.pid}-${randomUUID().slice(0, 8)}`;
	const channelDir =
		inheritedChannelDir ||
		join(
			supervisorChannelRoots()[0],
			`${channelSegment(runId)}-${channelSegment(agent)}-${channelSegment(childIndex)}`,
		);
	mkdirSync(join(channelDir, "requests"), { recursive: true, mode: 0o700 });
	mkdirSync(join(channelDir, "replies"), { recursive: true, mode: 0o700 });
	// The parent's ownership check compares this against its own session id. A real
	// child always has PI_SUBAGENT_PARENT_SESSION set; the orchestrator id is not
	// exported on every path, so it is the fallback, not the primary.
	const orchestratorSessionId =
		process.env.PI_SUBAGENT_ORCHESTRATOR_SESSION_ID?.trim() ||
		process.env.PI_SUBAGENT_PARENT_SESSION?.trim() ||
		undefined;
	return { channelDir, runId, agent, childIndex, orchestratorSessionId };
}

function writeAtomicJson(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, "\t"));
	rmSync(file, { force: true });
	// rename is atomic on POSIX; the write fallback covers exotic filesystems
	try {
		renameSync(tmp, file);
	} catch {
		writeFileSync(file, JSON.stringify(value, null, "\t"));
		rmSync(tmp, { force: true });
	}
}

function expandTask(t: any): any {
	return {
		id: t.id,
		subject: t.subject,
		status: t.status,
		...(t.description ? { description: t.description } : {}),
		...(t.activeForm ? { activeForm: t.activeForm } : {}),
		...(t.blockedBy ? { blockedBy: t.blockedBy } : {}),
	};
}

/** Actions that actually mutate state; list/get are read-only and are not persisted. */
const MUTATING_ACTIONS = new Set(["create", "update", "delete", "clear"]);

/**
 * Apply a crew todo mutation to the parent's BRANCH — durably, with the
 * parent's model NEVER woken.
 *
 * Durable: a replay-compatible `todo` toolResult is appended via the SHARED
 * SessionManager (one runner object per process; the same branch the rpiv-todo
 * host replays). `replayFromBranch` decodes the LAST such row, so the append is
 * the authoritative record after the parent's next replay.
 *
 * Not live: the host's store Map is module-private to the rpiv-todo extension
 * (see the header note), so the parent's live `todo` tool and overlay keep
 * reading a cached view until their next session_start/compact/tree. A
 * parent-side `todo` write while the view is stale appends a row from that
 * stale view, which then WINS the replay (last-write-wins) and drops the crew
 * entry. The `rpiv-todo:external-refresh` emit is the seam a patched rpiv-todo
 * would use; the installed npm package subscribes to nothing on `pi.events`.
 */
function applyToParentSession(pi: any, rpiv: RpivTodo, sm: any, sessionId: string, params: any) {
	let state: TodoState;
	if (sm?.getBranch) {
		try {
			state = rpiv.replayFromBranch({ sessionManager: sm });
		} catch {
			state = { tasks: [], nextId: 1 };
		}
	} else {
		state = { tasks: [], nextId: 1 };
	}
	const result = rpiv.applyTaskMutation(state, params.action, params);
	if (MUTATING_ACTIONS.has(params.action)) {
		// (1) Durable + replay-derivable branch record via the SHARED SessionManager
		// (one runner object per process — the same branch the rpiv-todo host replays).
		try {
			sm?.appendMessage?.({
				role: "toolResult",
				toolCallId: `todo-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				toolName: "todo",
				content: [{ type: "text", text: "todo_parent mutation" }],
				details: {
					action: params.action,
					params,
					tasks: result.state.tasks,
					nextId: result.state.nextId,
				},
				isError: false,
				timestamp: Date.now(),
			});
		} catch {
			/* best-effort durability; child still gets a reply */
		}
		// (2) Refresh seam: `pi.events` is one shared bus per process, so a patched
		// rpiv-todo can replay the just-appended branch into its own store slot.
		// The installed npm package has no subscriber, so this emit is a no-op
		// today — it is kept as the handshake the package-side fix uses.
		try {
			pi?.events?.emit?.("rpiv-todo:external-refresh", { sid: sessionId });
		} catch {
			/* best-effort live refresh; the durable record above is guaranteed */
		}
	}
	return {
		ok: result.op.kind !== "error",
		...(result.op.kind === "error" ? { error: result.op.message } : { op: result.op }),
		tasks: result.state.tasks.map(expandTask),
	};
}

/** The child-side proxy tool: request file in, reply file out. */
function childTool(child: {
	channelDir: string;
	runId: string;
	agent: string;
	childIndex: string;
	orchestratorSessionId?: string;
}) {
	return {
		name: TOOL_NAME,
		label: "Todo (Parent)",
		description:
			"Mutations land in the spawning session's list, not a child-local one. Every call is SYNCHRONOUS and can take up to ~15 s when the parent is busy (500 ms poll, 15 s timeout), so use it for durable progress state only, never for chatter. The mutation is recorded on the parent's session BRANCH: the parent's own todo tool reads a cached view that refreshes at its next session start/compact, so the spawning session may not show the entry immediately.",
		parameters: Type.Object({
			action: Type.Union(
				["create", "update", "list", "get", "delete"].map((a) => Type.Literal(a)),
				{ description: "Todo action" },
			),
			id: Type.Optional(Type.Number({ description: "Task id (update/get/delete)" })),
			subject: Type.Optional(
				Type.String({ description: "Short imperative label (create/update)" }),
			),
			description: Type.Optional(Type.String({ description: "Long-form detail (create/update)" })),
			activeForm: Type.Optional(
				Type.String({ description: "Present-continuous label shown while in_progress" }),
			),
			status: Type.Optional(
				Type.Union(
					["pending", "in_progress", "completed"].map((s) => Type.Literal(s)),
					{
						description: "Target status (update)",
					},
				),
			),
			blockedBy: Type.Optional(
				Type.Array(Type.Number(), { description: "Dependency ids (create)" }),
			),
		}),
		// Header only (display): the action plus the field that identifies it.
		renderCall(args: Record<string, unknown>, theme: Parameters<typeof safeToolHeader>[0]) {
			return safeToolHeader(theme, "todo_parent", () => {
				const action = argText(args, "action") ?? "action";
				const parts: HeaderPart[] = [["accent", ` ${action}`]];
				if (action === "create") {
					const subject = argText(args, "subject");
					if (subject) parts.push(["accent", ` ${clip(subject, 70)}`]);
				} else if (action === "list") {
					const status = argText(args, "status");
					if (status) parts.push(["dim", ` ${status}`]);
				} else {
					const id = argNumber(args, "id");
					if (id !== undefined) parts.push(["accent", ` #${id}`]);
					const status = argText(args, "status");
					const subject = argText(args, "subject");
					const tail = status ? ` → ${status}` : subject ? ` ${clip(subject, 60)}` : "";
					if (tail) parts.push(["dim", tail]);
				}
				return parts;
			});
		},
		async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
			const id = `todo-parent-${Date.now()}-${randomUUID()}`;
			const requestsDir = join(child.channelDir, "requests");
			const repliesDir = join(child.channelDir, "replies");
			mkdirSync(requestsDir, { recursive: true });
			mkdirSync(repliesDir, { recursive: true });
			const requestFile = join(requestsDir, `${id}.json`);
			const replyFile = join(repliesDir, `${id}.reply.json`);
			writeAtomicJson(requestFile, {
				type: REQUEST_TYPE,
				id,
				runId: child.runId,
				agent: child.agent,
				childIndex: Number(child.childIndex) || 0,
				orchestratorSessionId: child.orchestratorSessionId,
				params,
				createdAt: new Date().toISOString(),
			});
			const deadline = Date.now() + REPLY_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (signal?.aborted) {
					rmSync(requestFile, { force: true });
					throw new Error("todo_parent aborted");
				}
				if (existsSync(replyFile)) {
					let reply: any;
					try {
						reply = JSON.parse(readFileSync(replyFile, "utf-8"));
					} catch {
						reply = undefined;
					}
					rmSync(replyFile, { force: true });
					if (!reply) continue; // half-written; poll again
					if (reply.ok === false)
						throw new Error(`todo_parent rejected: ${reply.error ?? "unknown error"}`);
					const tasks = (reply.tasks ?? []) as any[];
					const lines = tasks.map(
						(t) => `#${t.id} [${t.status}] ${t.subject}${t.activeForm ? ` (${t.activeForm})` : ""}`,
					);
					const head =
						reply.op?.kind === "create"
							? `Created #${reply.op.taskId} on the parent's todo branch.`
							: reply.op?.kind === "update"
								? `Updated #${reply.op.id} on the parent's todo branch${reply.op.changed === false ? " (no change)" : ""}.`
								: reply.op?.kind === "delete"
									? `Deleted #${reply.op.id} on the parent's todo branch.`
									: reply.op?.kind === "get"
										? `Task #${reply.op.task?.id}: ${reply.op.task?.subject} [${reply.op.task?.status}]`
										: "Parent todo list (durable branch record):";
					return {
						content: [
							{ type: "text" as const, text: [head, ...lines, "", BRANCH_ONLY_NOTE].join("\n") },
						],
						details: reply,
					};
				}
				await new Promise((r) => setTimeout(r, REPLY_POLL_MS));
			}
			rmSync(requestFile, { force: true });
			throw new Error(
				"todo_parent: no reply from the parent session within 15s (parent busy or not processing) — retry once, then proceed without the todo update",
			);
		},
	};
}

/** The parent-side watcher: apply every crew request it owns, reply by file. */
function startParentWatcher(pi: ExtensionAPI, rpiv: RpivTodo | null): void {
	// Session resolution: the watcher MUST write into the todo slot of the
	// session whose process it runs in.
	//   1. OWN session id, captured at THIS process's session_start — always
	//      wins. (An inherited PI_SUBAGENT_PARENT_SESSION env from an ancestor
	//      process must never divert the write.)
	//   2. LAST RESORT only: the PI_SUBAGENT_PARENT_SESSION env — used solely
	//      when session_start has not fired yet (headless -p runs where the
	//      watcher may poll before/without a captured id). Known risk: a leaked
	//      ancestor env still names the WRONG session here; accepted only
	//      because the alternative is dropping the mutation.
	let parentSessionId = "";
	let parentSessionManager: any;
	pi.on("session_start", async (_event, ctx) => {
		try {
			parentSessionManager = ctx?.sessionManager;
			parentSessionId = parentSessionManager?.getSessionId?.() ?? "";
		} catch {
			/* keep previous value */
		}
	});

	const seen = new Set<string>();
	const foreignSeen = new Set<string>();
	const poll = (): void => {
		for (const root of supervisorChannelRoots()) {
			let channels: string[];
			try {
				channels = readdirSync(root, { withFileTypes: true })
					.filter((e) => e.isDirectory())
					.map((e) => e.name);
			} catch {
				continue;
			}
			for (const channel of channels) {
				const requestsDir = join(root, channel, "requests");
				let files: string[];
				try {
					files = readdirSync(requestsDir).filter(
						(f) => f.startsWith("todo-parent-") && f.endsWith(".json"),
					);
				} catch {
					continue;
				}
				for (const file of files) {
					const requestFile = join(requestsDir, file);
					if (seen.has(requestFile)) continue;
					seen.add(requestFile);
					let request: any;
					try {
						request = JSON.parse(readFileSync(requestFile, "utf-8"));
					} catch {
						continue; // half-written; poll again
					}
					if (request?.type !== REQUEST_TYPE) continue;
					// Ownership match: when THIS watcher knows its own session id, a
					// request naming a DIFFERENT orchestrator session belongs to another
					// parent — skip it (another pi process's watcher will apply it).
					// Requests without orchestrator metadata (legacy) and watchers
					// without a captured id keep the legacy first-wins behaviour.
					if (
						parentSessionId &&
						request.orchestratorSessionId &&
						request.orchestratorSessionId !== parentSessionId
					) {
						if (!foreignSeen.has(requestFile)) foreignSeen.add(requestFile);
						continue;
					}
					// Resolution order (see the block comment above): own session_start
					// id ALWAYS wins; env is the documented last resort only.
					const sid = parentSessionId || process.env.PI_SUBAGENT_PARENT_SESSION?.trim() || "";
					let reply: Record<string, unknown>;
					if (!sid) {
						reply = { ok: false, error: "parent session id unknown (no session_start yet)" };
					} else if (!rpiv) {
						reply = { ok: false, error: RPIV_REFUSAL, sid };
					} else {
						try {
							reply = {
								...applyToParentSession(pi, rpiv, parentSessionManager, sid, request.params ?? {}),
								sid,
							};
						} catch (error) {
							// A malformed child request must answer an error: an uncaught throw here
							// runs inside the poll timer and would take the parent process down.
							reply = {
								ok: false,
								error: `todo_parent apply failed: ${error instanceof Error ? error.message : String(error)}`,
								sid,
							};
						}
					}
					const repliesDir = join(root, channel, "replies");
					try {
						mkdirSync(repliesDir, { recursive: true });
						writeAtomicJson(join(repliesDir, `${file.replace(/\.json$/, "")}.reply.json`), reply);
					} catch {
						/* child will time out and retry */
					}
					rmSync(requestFile, { force: true });
					seen.delete(requestFile);
				}
			}
		}
	};
	const timer = setInterval(poll, POLL_MS);
	timer.unref?.();
}

async function register(pi: ExtensionAPI): Promise<void> {
	// The neighbour is resolved once, before either side registers, so an absent
	// reducer is reported at load and the parent-side refusal is ready.
	const rpiv = await loadRpiv();
	const child = childMetadata();

	if (child) {
		// ---- child side: proxy tool ------------------------------------
		pi.registerTool(childTool(child) as never);
		return; // children never run the parent-side watcher
	}

	// ---- parent side: watch for crew todo requests ----------------------
	startParentWatcher(pi, rpiv);
}

export default async function (pi: ExtensionAPI): Promise<void> {
	try {
		await register(pi);
	} catch (error) {
		hookLog("todo-parent", "register-failed", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}
