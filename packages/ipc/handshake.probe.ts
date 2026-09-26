/**
 * handshake.probe — the two-process proof for the transport this package offers.
 *
 * Run: `node --experimental-strip-types handshake.probe.ts driver` from `packages/ipc`.
 *
 * The package's other probe measures the standing text; this one exercises the wire. It starts
 * three peer processes that each run this package's factory against a recorder playing pi's
 * role — a `pi.on` registry, an event bus, and a `sendMessage` sink — and drives them through
 * the bus handshake, addressing, `send`, the blocking `ask`, `broadcast`, and the turn-end
 * reminder. A fourth peer runs against a scratch runtime directory of its own, which is how the
 * no-peers refusals are reached.
 *
 * Registration and publish are proven across processes because that is the only place the
 * contract can be wrong: an in-process test would pass against a registry nobody else can reach.
 * `XDG_RUNTIME_DIR` is a scratch directory for every peer, so the machine's real transport is
 * never touched, and every peer is killed by pid at the end.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SELF = fileURLToPath(import.meta.url);
const NAMESPACE = "probe-ns";

/** What one record of `pi.sendMessage` carried. */
interface SentMessage {
	customType: string;
	content: string;
	options: { triggerTurn?: boolean; deliverAs?: string } | null;
}

/** The bus delivery one registered namespace received. */
interface BusDelivery {
	type: string;
	fromSessionId?: string;
	payload?: { probe?: string; n?: number };
}

/** One record of `pi.sendMessage`. */
interface SentRecord {
	customType: string;
	content: string;
	options: SentMessage["options"];
}

// ---- the peer: one session, played by pi's fake -------------------------------------

async function peer(): Promise<void> {
	const sessionId = process.argv[3] ?? "probe-session";
	const sessionName = process.argv[4] ?? "probe-name";

	const piHandlers = new Map<string, Array<(event: { type: string }, ctx: unknown) => void>>();
	const busHandlers = new Map<string, Array<(data: unknown) => void>>();
	const tools = new Map<string, ToolLike>();
	const sent: Array<{ message: MessageLike; options?: SentMessage["options"] }> = [];
	const busReceived: BusDelivery[] = [];
	const channels = new Map<string, ChannelLike>();

	const ctx = {
		sessionManager: { getSessionId: () => sessionId },
		cwd: `/tmp/probe-cwd/${sessionName}`,
		model: { id: "probe-model" },
	};

	function add<T>(map: Map<string, T[]>, key: string, value: T): void {
		const list = map.get(key) ?? [];
		list.push(value);
		map.set(key, list);
	}

	const recorder = {
		registerTool: (tool: ToolLike) => tools.set(tool.name, tool),
		registerCommand: () => {},
		getSessionName: () => sessionName,
		events: {
			on: (channel: string, handler: (data: unknown) => void) => add(busHandlers, channel, handler),
			emit: (channel: string, data: unknown) => {
				for (const handler of busHandlers.get(channel) ?? []) handler(data);
			},
		},
		sendMessage: (message: MessageLike, options?: SentMessage["options"]) =>
			sent.push({ message, options }),
		on: (event: string, handler: (event: { type: string }, ctx: unknown) => void) =>
			add(piHandlers, event, handler),
	};

	const entry = (await import("./index.ts")).default;
	entry(recorder as unknown as ExtensionAPI);

	function fire(event: string): void {
		for (const handler of piHandlers.get(event) ?? []) handler({ type: event }, ctx);
	}

	function channelOf(namespace: string): ChannelLike {
		const channel = channels.get(namespace);
		if (!channel) throw new Error(`no channel is held for ${namespace}`);
		return channel;
	}

	const ops: Record<string, (args: any) => unknown> = {
		start: () => {
			fire("session_start");
			return { started: true };
		},
		register: (namespace: string) => {
			const before = channels.size;
			recorder.events.emit("intercom:extension-register", {
				namespace,
				ownerEligible: false,
				onEvent: (event: BusDelivery) => busReceived.push(event),
				onReady: (channel: ChannelLike) => channels.set(namespace, channel),
			});
			return { installed: channels.size > before, channels: [...channels.keys()] };
		},
		publish: (args: { namespace: string; payload: unknown }) => {
			channelOf(args.namespace).publish(args.payload, { audience: "capable" });
			return { published: true };
		},
		listSessions: async (namespace: string) =>
			(await channelOf(namespace).listSessions()).map((session) => session.id),
		tool: async (params: Record<string, unknown>) => {
			const tool = tools.get("ipc");
			if (!tool) throw new Error("the ipc tool is not registered");
			const result = await tool.execute("probe-call", params, undefined, undefined, ctx);
			return {
				text: result.content.map((item) => item.text).join("\n"),
				details: (result.details ?? null) as Record<string, unknown> | null,
			};
		},
		received: () => ({
			sent: sent.map((entry) => ({
				customType: entry.message.customType,
				content: entry.message.content,
				options: entry.options ?? null,
			})),
			bus: busReceived,
		}),
		turnEnd: () => {
			fire("turn_end");
			return { fired: true };
		},
		state: () => ({
			sessionId,
			sessionName,
			channels: [...channels.keys()],
			tools: [...tools.keys()],
		}),
		shutdown: () => {
			fire("session_shutdown");
			return { stopped: true };
		},
	};

	const readline = createInterface({ input: process.stdin });
	readline.on("line", (line: string) => {
		void (async () => {
			let request: { id: number; op: string; args: any };
			try {
				request = JSON.parse(line);
			} catch {
				return;
			}
			try {
				const result = await ops[request.op]?.(request.args);
				process.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				process.stdout.write(`${JSON.stringify({ id: request.id, ok: false, error: reason })}\n`);
			}
		})();
	});
	process.stdout.write(`${JSON.stringify({ ready: true, sessionId })}\n`);
}

interface ToolLike {
	name: string;
	execute(
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown,
	): Promise<{ content: Array<{ text: string }>; details?: unknown }>;
}

interface MessageLike {
	customType: string;
	content: string;
}

interface ChannelLike {
	publish(payload: unknown, options?: { audience?: string }): void;
	listSessions(): Promise<Array<{ id: string; name?: string }>>;
}

// ---- the driver ----------------------------------------------------------------------

/** One peer process, driven over a line protocol: `{id, op, args}` in, `{id, ok, result}` out. */
class Peer {
	readonly sessionId: string;
	readonly ready: Promise<Peer>;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<
		number,
		{ resolve: (value: any) => void; reject: (error: Error) => void }
	>();
	private next = 1;

	constructor(sessionId: string, sessionName: string, runtime: string, home: string) {
		this.sessionId = sessionId;
		this.child = spawn(
			process.execPath,
			["--experimental-strip-types", SELF, "peer", sessionId, sessionName],
			{
				env: {
					...process.env,
					// Keep the diagnostics sink in the scratch tree, never the invoking user's log.
					HOME: home,
					XDG_RUNTIME_DIR: runtime,
					XDG_STATE_HOME: join(home, "state"),
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		this.child.stderr.on("data", () => {});
		this.ready = new Promise((resolve) => {
			const readline = createInterface({ input: this.child.stdout });
			readline.on("line", (line: string) => {
				const message = JSON.parse(line) as {
					ready?: boolean;
					id?: number;
					ok?: boolean;
					result?: unknown;
					error?: string;
				};
				if (message.ready) {
					resolve(this);
					return;
				}
				const entry = this.pending.get(message.id ?? -1);
				if (!entry) return;
				this.pending.delete(message.id ?? -1);
				if (message.ok) entry.resolve(message.result);
				else entry.reject(new Error(message.error ?? "peer failed"));
			});
		});
	}

	request<T = any>(op: string, args: unknown = {}, timeoutMs = 20000): Promise<T> {
		const id = this.next;
		this.next += 1;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`peer ${this.sessionId} did not answer "${op}" within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.child.stdin.write(`${JSON.stringify({ id, op, args })}\n`);
		});
	}

	kill(): void {
		this.child.kill("SIGKILL");
	}
}

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, condition: unknown, detail = ""): void {
	const ok = Boolean(condition);
	checks.push({ name, ok, detail });
	console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor<T>(
	label: string,
	look: () => Promise<T | null>,
	timeoutMs = 10000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await look();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

interface ToolAnswer {
	text: string;
	details: Record<string, unknown> | null;
}

async function driver(): Promise<void> {
	const runtime = mkdtempSync(join(tmpdir(), "pi-ipc-handshake-"));
	const lonely = mkdtempSync(join(tmpdir(), "pi-ipc-lonely-"));
	const home = mkdtempSync(join(tmpdir(), "pi-ipc-home-"));
	const peers: Peer[] = [];

	try {
		const a = await new Peer("aaaa-1111-0000", "peer-a", runtime, home).ready;
		const b = await new Peer("bbbb-2222-0000", "peer-b", runtime, home).ready;
		const c = await new Peer("aaaa-3333-0000", "peer-c", runtime, home).ready;
		const d = await new Peer("dddd-4444-0000", "peer-d", lonely, home).ready;
		peers.push(a, b, c, d);
		for (const peer of [a, b, c, d]) await peer.request("start");
		await new Promise((resolve) => setTimeout(resolve, 800));

		console.log("the tool surface");
		const state = await a.request<{ tools: string[]; channels: string[] }>("state");
		check(
			"the entry registers the one ipc tool",
			state.tools.join(",") === "ipc",
			state.tools.join(", "),
		);
		check(
			"the presence record lands in $XDG_RUNTIME_DIR/pi-ipc/presence",
			existsSync(join(runtime, "pi-ipc", "presence", `${a.sessionId}.json`)),
			join(runtime, "pi-ipc", "presence", `${a.sessionId}.json`),
		);

		console.log("the registration handshake");
		const first = await a.request<{ installed: boolean; channels: string[] }>(
			"register",
			NAMESPACE,
		);
		check(
			"a registration installs its namespace and hands back a channel",
			first.installed && first.channels.join(",") === NAMESPACE,
			first.channels.join(", "),
		);
		const second = await a.request<{ installed: boolean; channels: string[] }>(
			"register",
			NAMESPACE,
		);
		check(
			"a duplicate namespace is refused, not replaced",
			!second.installed && second.channels.length === 1,
			second.channels.join(", "),
		);
		const malformed = await a.request<{ installed: boolean }>("register", "Not A Namespace");
		check("a namespace outside the pattern is refused", !malformed.installed);
		await b.request("register", NAMESPACE);
		const serving = await b.request<string[]>("listSessions", NAMESPACE);
		check(
			"listSessions names every live session, this one and the busy peers alike",
			serving.length === 3 && serving.includes(a.sessionId) && serving.includes(b.sessionId),
			serving.join(", "),
		);

		console.log("the bus: a publish reaches the namespace, not the machine");
		await b.request("publish", { namespace: NAMESPACE, payload: { probe: "bus", n: 1 } });
		const arrived = await waitFor("the bus payload at peer a", async () => {
			const received = await a.request<{ bus: BusDelivery[] }>("received");
			return received.bus.length > 0 ? received.bus : null;
		});
		check(
			"the payload arrives with the sender's session id",
			arrived[0]?.type === "message" && arrived[0]?.fromSessionId === b.sessionId,
			JSON.stringify(arrived[0]),
		);
		check(
			"the payload is deserialised, not a string",
			arrived[0]?.payload?.probe === "bus" && arrived[0]?.payload?.n === 1,
			JSON.stringify(arrived[0]?.payload),
		);
		await new Promise((resolve) => setTimeout(resolve, 900));
		const untouched = await c.request<{ bus: BusDelivery[] }>("received");
		check(
			"a session that did not register the namespace receives nothing",
			untouched.bus.length === 0,
			`${untouched.bus.length} bus delivery(ies)`,
		);

		console.log("the tool: listing");
		const listed = await b.request<ToolAnswer>("tool", { action: "list" });
		check(
			"list names every live session, this one marked",
			listed.text.includes("2 other session(s)") &&
				listed.text.includes("peer-a") &&
				listed.text.includes("peer-c") &&
				listed.text.includes("(this session)"),
			`${(listed.details?.sessions as unknown[] | undefined)?.length ?? 0} row(s)`,
		);
		const alone = await d.request<ToolAnswer>("tool", { action: "list" });
		check(
			"a session with no peers says so",
			alone.text.includes("no other session is live"),
			alone.text.split("\n")[0] ?? "",
		);

		console.log("the tool: addressing");
		const ambiguous = await b.request<ToolAnswer>("tool", {
			action: "send",
			to: "aaaa",
			message: "hello",
		});
		check(
			"an ambiguous prefix is refused with the candidates",
			ambiguous.details?.ok === false &&
				ambiguous.text.includes("matches 2 live sessions") &&
				ambiguous.text.includes("peer-a") &&
				ambiguous.text.includes("peer-c"),
			ambiguous.text.split("\n")[0] ?? "",
		);
		const tooShort = await b.request<ToolAnswer>("tool", {
			action: "send",
			to: "aaa",
			message: "x",
		});
		check("a prefix shorter than 4 characters is refused", tooShort.details?.ok === false);
		const unknown = await b.request<ToolAnswer>("tool", {
			action: "send",
			to: "zzzz",
			message: "x",
		});
		check("a target no session matches is refused by name", unknown.details?.ok === false);
		const untargeted = await b.request<ToolAnswer>("tool", { action: "send", message: "x" });
		check(
			"a send with no target is refused",
			untargeted.details?.ok === false && untargeted.text.includes("needs a target"),
			untargeted.text.split("\n")[0] ?? "",
		);
		const aloneSend = await d.request<ToolAnswer>("tool", {
			action: "send",
			to: "peer-a",
			message: "x",
		});
		check(
			"a session with no peers refuses a send rather than reporting success",
			aloneSend.details?.ok === false,
			aloneSend.text.split("\n")[0] ?? "",
		);

		console.log("the tool: send");
		const sent = await b.request<ToolAnswer>("tool", {
			action: "send",
			to: "peer-a",
			message: "hello A",
		});
		check("a send to an exact name reports its target", sent.details?.ok === true, sent.text);
		const injected = await waitFor<SentRecord[]>("the message at peer a", async () => {
			const received = await a.request<{ sent: SentRecord[] }>("received");
			return received.sent.length > 0 ? received.sent : null;
		});
		check(
			"the message arrives as a turn of its own, attributed to its sender",
			injected[0]?.customType === "ipc_message" &&
				injected[0]?.options?.triggerTurn === true &&
				injected[0]?.content.includes("hello A") &&
				injected[0]?.content.includes("peer-b"),
			JSON.stringify(injected[0] ?? null),
		);

		console.log("the tool: the blocking ask");
		const asking = a.request<ToolAnswer>(
			"tool",
			{ action: "ask", to: "bbbb", message: "what is it?" },
			30000,
		);
		let answeredEarly: ToolAnswer | null = null;
		void asking
			.then((answer) => {
				answeredEarly = answer;
			})
			.catch(() => {});
		const asked = await waitFor<SentRecord | null>(
			"the ask at peer b",
			async () => {
				const received = await b.request<{ sent: SentRecord[] }>("received");
				return received.sent.find((entry) => entry.customType === "ipc_ask") ?? null;
			},
			8000,
		).catch(() => null);
		check(
			"the ask arrives at its target as a turn of its own",
			asked !== null,
			asked
				? `${asked.customType} carrying the handle`
				: answeredEarly
					? `peer a answered early: ${JSON.stringify(answeredEarly)}`
					: "no ask reached peer b",
		);
		if (!asked) throw new Error("the ask never reached its target");
		const handle = /answerTo: "([^"]+)"/.exec(asked.content)?.[1] ?? "";
		check("the ask prints the handle that answers it", handle.startsWith("ask-"), handle);
		check(
			"the ask names its sender so the answer can be addressed",
			asked.content.includes(a.sessionId),
			asked.content.split("\n")[0] ?? "",
		);
		await b.request("turnEnd");
		const reminder = (await b.request<{ sent: SentRecord[] }>("received")).sent.at(-1);
		check(
			"an unanswered ask is named in one passive line at turn end",
			reminder?.customType === "ipc_pending_asks" &&
				reminder?.options?.deliverAs === "nextTurn" &&
				!reminder.content.includes("\n") &&
				reminder.content.includes(handle),
			reminder?.content ?? "",
		);

		const stale = await b.request<ToolAnswer>("tool", {
			action: "send",
			to: a.sessionId,
			message: "late answer",
			answerTo: "ask-nowhere",
		});
		check(
			"a stale handle still delivers, and the result says so",
			stale.details?.ok === true && stale.text.includes("still blocked"),
			stale.text,
		);

		const answered = await b.request<ToolAnswer>("tool", {
			action: "send",
			to: a.sessionId,
			message: "the answer",
			answerTo: handle,
		});
		check(
			"the answer names the ask it completes",
			answered.details?.ok === true && answered.text.includes("answering the ask"),
			answered.text,
		);
		const result = await asking;
		check(
			"the blocked ask returns exactly the peer's text",
			result.text === "the answer",
			JSON.stringify(result.text),
		);
		check(
			"the ask reports the answering peer and the handle",
			result.details?.ok === true && result.details?.from === b.sessionId,
			JSON.stringify(result.details),
		);
		const beforeQuiet = (await b.request<{ sent: SentRecord[] }>("received")).sent.length;
		await b.request("turnEnd");
		const afterQuiet = (await b.request<{ sent: SentRecord[] }>("received")).sent;
		check(
			"the reminder stops once the ask is answered",
			afterQuiet.length === beforeQuiet &&
				afterQuiet.filter((entry) => entry.customType === "ipc_pending_asks").length === 1,
			`${beforeQuiet} message(s) before, ${afterQuiet.length} after, ` +
				`${afterQuiet.filter((entry) => entry.customType === "ipc_pending_asks").length} reminder(s)`,
		);

		console.log("the tool: broadcast");
		const broadcast = await b.request<ToolAnswer>("tool", {
			action: "broadcast",
			message: "all hands",
		});
		check(
			"a broadcast reports every other live session",
			broadcast.details?.ok === true &&
				broadcast.details?.delivered === 2 &&
				broadcast.text.includes("peer-a") &&
				broadcast.text.includes("peer-c"),
			broadcast.text,
		);
		const reached = await waitFor<SentRecord>("the broadcast at peer c", async () => {
			const received = await c.request<{ sent: SentRecord[] }>("received");
			return received.sent.find((entry) => entry.customType === "ipc_broadcast") ?? null;
		});
		check(
			"a session that registered no namespace still receives a broadcast",
			reached.content.includes("all hands") && reached.options?.triggerTurn === true,
			reached.content.split("\n")[0] ?? "",
		);
		const echo = (await b.request<{ sent: Array<{ customType: string }> }>("received")).sent.filter(
			(entry) => entry.customType === "ipc_broadcast",
		);
		check("the sender does not receive its own broadcast", echo.length === 0);
		const noOne = await d.request<ToolAnswer>("tool", { action: "broadcast", message: "anyone?" });
		check(
			"a broadcast with no other session is refused, never an empty success",
			noOne.details?.ok === false && noOne.text.includes("nothing to broadcast"),
			noOne.text.split("\n")[0] ?? "",
		);

		for (const peer of [a, b, c]) await peer.request("shutdown");
		await new Promise((resolve) => setTimeout(resolve, 300));

		console.log("the diagnostics the run wrote");
		const logPath = join(home, ".local/share/pi-hooks/log.jsonl");
		const lines = existsSync(logPath)
			? readFileSync(logPath, "utf8")
					.split("\n")
					.filter((line) => line.trim() !== "")
					.map((line) => JSON.parse(line) as { source: string; kind: string; detail?: unknown })
			: [];
		const ipcLines = lines.filter((line) => line.source === "ipc");
		const broken = ipcLines.filter((line) =>
			["register-failed", "handler-failed", "session-start-failed", "presence-failed"].includes(
				line.kind,
			),
		);
		check(
			"the run wrote no failure line of its own",
			broken.length === 0,
			broken.length > 0
				? JSON.stringify(broken)
				: `${ipcLines.length} ipc line(s): ${[...new Set(ipcLines.map((line) => line.kind))].join(", ")}`,
		);
	} finally {
		for (const peer of peers) peer.kill();
		await new Promise((resolve) => setTimeout(resolve, 200));
		rmSync(runtime, { recursive: true, force: true });
		rmSync(lonely, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	}
}

if (process.argv[2] === "peer") {
	await peer();
} else {
	await driver();
	const failed = checks.filter((entry) => !entry.ok);
	for (const entry of failed) console.error(`FAILED: ${entry.name} — ${entry.detail}`);
	console.log(
		`handshake proof: ${checks.length - failed.length} of ${checks.length} checks passed`,
	);
	process.exit(failed.length === 0 ? 0 : 1);
}
