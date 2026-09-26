/**
 * ipc — the inter-session transport, and the one owner of its rendezvous path.
 *
 * Two halves of this machine's traffic need one contract: the extension-to-extension bus
 * (canon notices, focus notices, broadcasts) and the peer messages a model sends by name.
 * The contract itself is small — a presence record per session, an inbox per session, and an
 * envelope between them — so it lives here rather than inside any one implementation, and a
 * package that swaps the tool-facing half still speaks the same wire.
 *
 * What this module owns:
 *   - the rendezvous path: `$XDG_RUNTIME_DIR/pi-ipc`, resolved and created here and nowhere
 *     else, so relocating the transport is one edit (CONTRACT.md R6);
 *   - the bus contract strings — the two event names, the namespace pattern, the publish
 *     audiences and the channel method names — so both sides spell the contract once. The
 *     names are byte-identical to the ones the installed consumers already use, which is what
 *     lets a consumer switch implementations without an edit;
 *   - the records and the delivery primitives: a validated presence record, a validated
 *     envelope, and an inbox a message is renamed into.
 *
 * What it deliberately does not own: no pi import, no peer dependency, no tool name, no timer,
 * no log source, no knowledge of the package on top. It imports node builtins only, so the
 * library keeps the "no pi package is imported" property of its README, and a refusal is
 * returned to the caller rather than logged here — the caller owns the diagnostics source
 * (R3: a refusal is a named reason, never an empty success).
 *
 * Liveness is read from the process table, never from a heartbeat: a presence record carries
 * the pid and that process's start time, and `/proc/<pid>/stat` answers whether the pid is
 * still that process. A pid reused by an unrelated process therefore reads as dead rather than
 * as a peer, and there is no pid file to go stale.
 *
 * Nothing here runs at module scope (R1): every path is resolved by an accessor at call time,
 * so importing this module performs no I/O and a process with no runtime directory simply gets
 * a refusal on its first call.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The transport's directory under `$XDG_RUNTIME_DIR`. Runtime-scoped: it dies with the login. */
const ROOT_NAME = "pi-ipc";
const PRESENCE_DIR = "presence";
const INBOX_DIR = "inbox";

/** The largest message text, in UTF-8 bytes. The largest observed message was 4,236 characters. */
export const IPC_TEXT_CAP = 32 * 1024;

/** The envelope's wire version. A different version is refused by name rather than guessed at. */
export const IPC_ENVELOPE_VERSION = 1;

/** The extension-bus event names. Byte-identical to the names the installed consumers emit. */
export const IPC_REGISTER_EVENT = "intercom:extension-register";
export const IPC_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";

/** A namespace an extension may register: the loader's own rule, spelled once. */
export const IPC_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,63}$/;

/** The publish audiences a bus envelope may carry. */
export const IPC_AUDIENCES = ["owner", "capable"] as const;

/** The channel methods a registered namespace may call. */
export const IPC_CHANNEL_METHODS = ["publish", "listSessions"] as const;

/** Every envelope kind: a peer message, a blocking ask, its answer, or a bus payload. */
export const IPC_KINDS = ["message", "ask", "answer", "bus"] as const;

export type IpcAudience = (typeof IPC_AUDIENCES)[number];
export type IpcKind = (typeof IPC_KINDS)[number];

/** One session's presence: who it is, where it runs, and which namespaces it serves. */
export interface IpcPresence {
	/** The session id, also this record's file name: file-name-safe, never a path segment. */
	id: string;
	name?: string;
	cwd: string;
	model: string;
	/** The process that wrote the record, and that process's start time from `/proc/<pid>/stat`. */
	pid: number;
	processStartTicks: number;
	/** The bus namespaces this session serves. */
	namespaces: string[];
	startedAt: string;
}

/** One message between sessions: the same shape on the bus and in an inbox. */
export interface IpcEnvelope {
	v: number;
	/** The message id, also this message's file name: file-name-safe, never a path segment. */
	id: string;
	ts: string;
	from: string;
	to?: string;
	kind: IpcKind;
	/** Required for `bus`, and checked against the pattern on any other kind. */
	namespace?: string;
	audience?: IpcAudience;
	/** The id of the ask this envelope answers. Required for `answer`. */
	answerTo?: string;
	text: string;
}

/** A refusal: what could not be done, by name. Never an empty success. */
export interface IpcRefusal {
	ok: false;
	reason: string;
}

/** A completed write. It carries no value, so a caller cannot mistake it for a result. */
export interface IpcDone {
	ok: true;
}

/** A message file `drain` could not read back, removed so it cannot wedge every later drain. */
export interface IpcDrainRefusal {
	file: string;
	reason: string;
}

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

function refusal(reason: string): IpcRefusal {
	return { ok: false, reason };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

/** An id is usable as a file name: bounded, no separator, and never a directory reference. */
function isId(value: unknown): value is string {
	return typeof value === "string" && ID_PATTERN.test(value) && value !== "." && value !== "..";
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isNamespace(value: unknown): value is string {
	return typeof value === "string" && IPC_NAMESPACE_PATTERN.test(value);
}

function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | null)?.code === code;
}

/**
 * The transport's root: `$XDG_RUNTIME_DIR/pi-ipc`.
 *
 * Refused by name when `$XDG_RUNTIME_DIR` is unset, is not a directory, or belongs to another
 * user — the path is never guessed at from a second location. A refusal costs the transport,
 * not the extension that asked for it.
 */
export function ipcRoot(): { ok: true; path: string } | IpcRefusal {
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (!isNonEmpty(runtime)) {
		return refusal(
			"XDG_RUNTIME_DIR is not set, so the transport has no runtime directory (it never falls back to a second location)",
		);
	}
	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(runtime);
	} catch (error) {
		return refusal(`XDG_RUNTIME_DIR (${runtime}) cannot be read: ${messageOf(error)}`);
	}
	if (!stat.isDirectory()) {
		return refusal(`XDG_RUNTIME_DIR (${runtime}) is not a directory`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		return refusal(
			`XDG_RUNTIME_DIR (${runtime}) belongs to uid ${stat.uid}, not to this process (uid ${uid})`,
		);
	}
	return { ok: true, path: join(runtime, ROOT_NAME) };
}

/** Create the transport tree, 0700, at call time. Never at module scope (R1). */
export function ensureRoot(): { ok: true; path: string } | IpcRefusal {
	const root = ipcRoot();
	if (!root.ok) return root;
	try {
		mkdirSync(join(root.path, PRESENCE_DIR), { recursive: true, mode: 0o700 });
		mkdirSync(join(root.path, INBOX_DIR), { recursive: true, mode: 0o700 });
	} catch (error) {
		return refusal(`the transport tree under ${root.path} cannot be created: ${messageOf(error)}`);
	}
	return { ok: true, path: root.path };
}

function presenceDir(): { ok: true; path: string } | IpcRefusal {
	const root = ipcRoot();
	if (!root.ok) return root;
	return { ok: true, path: join(root.path, PRESENCE_DIR) };
}

function inboxDir(id: string): { ok: true; path: string } | IpcRefusal {
	const root = ipcRoot();
	if (!root.ok) return root;
	return { ok: true, path: join(root.path, INBOX_DIR, id) };
}

/**
 * The start time of a process, in clock ticks since boot, or `null` when no such process is
 * running.
 *
 * `/proc/<pid>/stat` field 22 is the start time. Field 2 (`comm`) is parenthesised and may hold
 * spaces or a `)` of its own, so the split starts after the LAST `)` in the line rather than at
 * the first space. Comparing this value is what makes a pid meaningful over time: the pid alone
 * is reused, the pid plus its start time is not.
 */
export function processStartTicks(pid: number): number | null {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	let line: string;
	try {
		line = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const commEnd = line.lastIndexOf(")");
	if (commEnd < 0) return null;
	// After "pid (comm) " the remaining fields start at state (field 3), so starttime (field 22)
	// sits at index 19.
	const ticks = Number(line.slice(commEnd + 2).split(" ")[19]);
	return Number.isFinite(ticks) && ticks > 0 ? ticks : null;
}

/** Is this record's pid still the process that wrote it? */
function isLive(presence: IpcPresence): boolean {
	return processStartTicks(presence.pid) === presence.processStartTicks;
}

/** Validate a presence record, or answer what about it is wrong. */
export function parsePresence(value: unknown): { ok: true; presence: IpcPresence } | IpcRefusal {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return refusal("a presence record must be a JSON object");
	}
	const raw = value as Record<string, unknown>;
	const id = raw.id;
	if (!isId(id)) return refusal("presence.id must be a file-name-safe session id");
	const name = raw.name;
	if (name !== undefined && !isNonEmpty(name)) {
		return refusal("presence.name, when present, must be a non-empty string");
	}
	const cwd = raw.cwd;
	if (!isNonEmpty(cwd)) return refusal("presence.cwd must be a non-empty string");
	const model = raw.model;
	if (!isNonEmpty(model)) return refusal("presence.model must be a non-empty string");
	const pid = raw.pid;
	if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
		return refusal("presence.pid must be a positive integer");
	}
	const ticks = raw.processStartTicks;
	if (typeof ticks !== "number" || !Number.isFinite(ticks) || ticks <= 0) {
		return refusal("presence.processStartTicks must be a positive number from /proc/<pid>/stat");
	}
	const startedAt = raw.startedAt;
	if (!isTimestamp(startedAt)) {
		return refusal("presence.startedAt must be an ISO-8601 timestamp");
	}
	const listed = raw.namespaces;
	if (!Array.isArray(listed)) {
		return refusal("presence.namespaces must be an array of namespace strings");
	}
	const namespaces: string[] = [];
	for (const namespace of listed) {
		if (!isNamespace(namespace)) {
			return refusal(
				`presence.namespaces holds an invalid namespace: ${JSON.stringify(namespace)}`,
			);
		}
		namespaces.push(namespace);
	}
	return {
		ok: true,
		presence: {
			id,
			cwd,
			model,
			pid,
			processStartTicks: ticks,
			namespaces,
			startedAt,
			...(name === undefined ? {} : { name }),
		},
	};
}

/** Validate an envelope before it is written, or answer what about it is wrong. */
export function parseEnvelope(value: unknown): { ok: true; envelope: IpcEnvelope } | IpcRefusal {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return refusal("an envelope must be a JSON object");
	}
	const raw = value as Record<string, unknown>;
	if (raw.v !== IPC_ENVELOPE_VERSION) {
		return refusal(`envelope.v must be ${IPC_ENVELOPE_VERSION} (got ${JSON.stringify(raw.v)})`);
	}
	const id = raw.id;
	if (!isId(id)) return refusal("envelope.id must be a file-name-safe message id");
	const ts = raw.ts;
	if (!isTimestamp(ts)) return refusal("envelope.ts must be an ISO-8601 timestamp");
	const from = raw.from;
	if (!isId(from)) return refusal("envelope.from must be a file-name-safe session id");
	const to = raw.to;
	if (to !== undefined && !isId(to)) {
		return refusal("envelope.to, when present, must be a file-name-safe session id");
	}
	const kind = raw.kind;
	if (typeof kind !== "string" || !(IPC_KINDS as readonly string[]).includes(kind)) {
		return refusal(`envelope.kind must be one of ${IPC_KINDS.join(" | ")}`);
	}
	const namespace = raw.namespace;
	if (kind === "bus") {
		if (!isNamespace(namespace)) {
			return refusal(
				`envelope.namespace is required for a bus envelope and must match ${IPC_NAMESPACE_PATTERN}`,
			);
		}
	} else if (namespace !== undefined && !isNamespace(namespace)) {
		return refusal(`envelope.namespace must match ${IPC_NAMESPACE_PATTERN}`);
	}
	const audience = raw.audience;
	if (audience !== undefined && !(IPC_AUDIENCES as readonly unknown[]).includes(audience)) {
		return refusal(`envelope.audience, when present, must be one of ${IPC_AUDIENCES.join(" | ")}`);
	}
	const answerTo = raw.answerTo;
	if (kind === "answer") {
		if (!isId(answerTo)) return refusal("envelope.answerTo is required for an answer");
	} else if (answerTo !== undefined && !isId(answerTo)) {
		return refusal("envelope.answerTo, when present, must be a message id");
	}
	const text = raw.text;
	if (typeof text !== "string") return refusal("envelope.text must be a string");
	if (Buffer.byteLength(text, "utf8") > IPC_TEXT_CAP) {
		return refusal(`envelope.text exceeds the ${IPC_TEXT_CAP}-byte cap`);
	}
	return {
		ok: true,
		envelope: {
			v: IPC_ENVELOPE_VERSION,
			id,
			ts,
			from,
			kind: kind as IpcKind,
			text,
			...(to === undefined ? {} : { to }),
			...(typeof namespace === "string" ? { namespace } : {}),
			...(audience === undefined ? {} : { audience: audience as IpcAudience }),
			...(answerTo === undefined ? {} : { answerTo }),
		},
	};
}

/** Each delivery's file name: the epoch millisecond, zero-padded, so names sort by delivery. */
const SEQ_WIDTH = 16;

/** Temp-file names are dot-prefixed, which is what keeps a half-written file invisible. */
let tmpCounter = 0;

function tmpName(): string {
	tmpCounter += 1;
	return `.tmp-${process.pid}-${tmpCounter}`;
}

/**
 * Write a file into `dir` atomically: the body lands in a dot-prefixed temp file, then a
 * `rename` puts it at its final name. A reader either sees no file or the whole file, never a
 * partial one, which is what makes an inbox delivery safe to observe from another process.
 */
function writeAtomic(dir: string, name: string, body: string): IpcDone | IpcRefusal {
	const tmp = join(dir, tmpName());
	try {
		writeFileSync(tmp, body, { mode: 0o600 });
		renameSync(tmp, join(dir, name));
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* the temp file is invisible to a reader; a failed cleanup is not worth a throw */
		}
		return refusal(`writing ${name} into ${dir} failed: ${messageOf(error)}`);
	}
	return { ok: true };
}

/** Read one JSON file, or answer `null` for anything that is not readable JSON. */
function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return null;
	}
}

/**
 * Write this session's presence record, replacing any earlier record for the same id.
 *
 * The caller supplies the process facts: `pid`, and `processStartTicks` from
 * `processStartTicks(process.pid)`. A record that fails validation is refused by name rather
 * than written.
 */
export function writePresence(record: IpcPresence): IpcDone | IpcRefusal {
	const parsed = parsePresence(record);
	if (!parsed.ok) return parsed;
	const root = ensureRoot();
	if (!root.ok) return root;
	const dir = presenceDir();
	if (!dir.ok) return dir;
	return writeAtomic(
		dir.path,
		`${parsed.presence.id}.json`,
		`${JSON.stringify(parsed.presence)}\n`,
	);
}

/**
 * Every peer whose process is still running, including the caller's own record.
 *
 * A record is a peer when its pid is alive AND that pid's start time still matches, so a pid
 * the kernel has since reused reads as dead. A record that does not parse is not a peer: it is
 * skipped here and removed by `sweepStale`. An absent transport tree means nobody is a member,
 * so it answers an empty list rather than a refusal.
 */
export function readPeers(): { ok: true; peers: IpcPresence[] } | IpcRefusal {
	const dir = presenceDir();
	if (!dir.ok) return dir;
	let names: string[];
	try {
		names = readdirSync(dir.path);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return { ok: true, peers: [] };
		return refusal(`the presence directory ${dir.path} cannot be read: ${messageOf(error)}`);
	}
	const peers: IpcPresence[] = [];
	for (const name of names) {
		if (name.startsWith(".") || !name.endsWith(".json")) continue;
		const parsed = parsePresence(readJson(join(dir.path, name)));
		if (parsed.ok && isLive(parsed.presence)) peers.push(parsed.presence);
	}
	return { ok: true, peers };
}

/**
 * Remove presence records that no longer describe a running process — a dead pid, a reused
 * pid, or a file that does not parse. Removing the record is what makes the peer disappear from
 * every later read.
 */
export function sweepStale(): { ok: true; removed: string[] } | IpcRefusal {
	const dir = presenceDir();
	if (!dir.ok) return dir;
	let names: string[];
	try {
		names = readdirSync(dir.path);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return { ok: true, removed: [] };
		return refusal(`the presence directory ${dir.path} cannot be read: ${messageOf(error)}`);
	}
	const removed: string[] = [];
	for (const name of names) {
		if (name.startsWith(".") || !name.endsWith(".json")) continue;
		const path = join(dir.path, name);
		const parsed = parsePresence(readJson(path));
		if (parsed.ok && isLive(parsed.presence)) continue;
		try {
			unlinkSync(path);
			removed.push(name);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) {
				return refusal(`the stale record ${path} cannot be removed: ${messageOf(error)}`);
			}
		}
	}
	return { ok: true, removed };
}

/** The live peers serving one bus namespace. An invalid namespace is refused by name. */
export function peersWithNamespace(
	namespace: string,
): { ok: true; peers: IpcPresence[] } | IpcRefusal {
	if (!isNamespace(namespace)) {
		return refusal(
			`a namespace must match ${IPC_NAMESPACE_PATTERN} (got ${JSON.stringify(namespace)})`,
		);
	}
	const peers = readPeers();
	if (!peers.ok) return peers;
	return { ok: true, peers: peers.peers.filter((peer) => peer.namespaces.includes(namespace)) };
}

/**
 * Put one envelope in a session's inbox.
 *
 * The write is a temp file plus a `rename` inside the target's own inbox directory, so a
 * concurrent `drain` sees either nothing or the whole envelope. `deliver` does not decide who
 * may be addressed: whether the target is a live peer is the caller's check, and its refusal is
 * the caller's text.
 */
export function deliver(toId: string, envelope: IpcEnvelope): IpcDone | IpcRefusal {
	if (!isId(toId)) return refusal("the delivery target must be a file-name-safe session id");
	const parsed = parseEnvelope(envelope);
	if (!parsed.ok) return parsed;
	if (parsed.envelope.to !== undefined && parsed.envelope.to !== toId) {
		return refusal(`the envelope names ${parsed.envelope.to} but is being delivered to ${toId}`);
	}
	const root = ensureRoot();
	if (!root.ok) return root;
	const dir = inboxDir(toId);
	if (!dir.ok) return dir;
	try {
		mkdirSync(dir.path, { recursive: true, mode: 0o700 });
	} catch (error) {
		return refusal(`the inbox for ${toId} cannot be created: ${messageOf(error)}`);
	}
	const seq = String(Date.now()).padStart(SEQ_WIDTH, "0");
	return writeAtomic(
		dir.path,
		`${seq}-${parsed.envelope.id}.json`,
		`${JSON.stringify(parsed.envelope)}\n`,
	);
}

/**
 * Read and remove every envelope waiting for one session, oldest delivery first.
 *
 * A file that does not read back as an envelope is removed and named in `refused` — leaving it
 * would make every later drain fail the same way. A message is removed after it is read, so a
 * process that dies in that window redelivers that one message rather than losing it. Files
 * whose names start with a dot are skipped: they are another writer's temp files, which is why
 * a delivery is atomic from the reader's side.
 */
export function drain(
	id: string,
): { ok: true; envelopes: IpcEnvelope[]; refused: IpcDrainRefusal[] } | IpcRefusal {
	if (!isId(id)) return refusal("the drain target must be a file-name-safe session id");
	const dir = inboxDir(id);
	if (!dir.ok) return dir;
	let names: string[];
	try {
		names = readdirSync(dir.path);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return { ok: true, envelopes: [], refused: [] };
		return refusal(`the inbox ${dir.path} cannot be read: ${messageOf(error)}`);
	}
	const envelopes: IpcEnvelope[] = [];
	const refused: IpcDrainRefusal[] = [];
	for (const name of names.filter((entry) => !entry.startsWith(".")).sort()) {
		const path = join(dir.path, name);
		const parsed = parseEnvelope(readJson(path));
		try {
			unlinkSync(path);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) {
				return refusal(`the message ${path} cannot be removed: ${messageOf(error)}`);
			}
		}
		if (parsed.ok) envelopes.push(parsed.envelope);
		else refused.push({ file: name, reason: parsed.reason });
	}
	return { ok: true, envelopes, refused };
}
