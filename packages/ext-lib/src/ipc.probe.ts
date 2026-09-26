/**
 * ipc.probe — the executable probe for the session-to-session transport (`ipc.ts`).
 *
 * Run: `node --experimental-strip-types src/ipc.probe.ts` from `packages/ext-lib`.
 *
 * It runs in its own process and points `XDG_RUNTIME_DIR` at a scratch directory before the
 * transport module is evaluated, so every path the probe writes is under the scratch tree and
 * the machine's real `$XDG_RUNTIME_DIR/pi-ipc` is never touched.
 *
 * The liveness cases use real processes: a child that has been reaped gives a dead pid, and a
 * record whose pid is alive but whose start time disagrees is the pid-reuse case. The delivery
 * cases include the property the inbox write exists for — four writer processes deliver while
 * this process drains, and a reader must never see a partial envelope and never lose one.
 */
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, writerTarget, writerCount] = process.argv.slice(2);

// ---- writer child: one of the concurrent deliverers -------------------------------

if (mode === "--writer") {
	// XDG_RUNTIME_DIR is inherited from the parent probe process.
	const ipc = await import("./ipc.ts");
	const from = "probe-writer";
	let failed = 0;
	for (let i = 0; i < Number(writerCount); i += 1) {
		const written = ipc.deliver(writerTarget, {
			v: ipc.IPC_ENVELOPE_VERSION,
			id: `w${process.pid}-${i}`,
			ts: new Date().toISOString(),
			from,
			kind: "message",
			text: `message ${i} from ${process.pid}`,
		});
		if (!written.ok) {
			console.error(`writer ${process.pid}: ${written.reason}`);
			failed += 1;
		}
	}
	process.exit(failed > 0 ? 1 : 0);
}

// ---- probe ------------------------------------------------------------------------

const runtime = mkdtempSync(join(tmpdir(), "pi-ext-lib-ipc-probe-"));
process.env.XDG_RUNTIME_DIR = runtime;

const ipc = await import("./ipc.ts");
type IpcEnvelope = import("./ipc.ts").IpcEnvelope;
type IpcPresence = import("./ipc.ts").IpcPresence;

const SELF = "probe-self";
const OTHER = "probe-other";

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ""): void {
	checks += 1;
	if (condition) {
		console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name: string, detail: string): void {
	console.log(`  skip  ${name} — ${detail}`);
}

/** Did the call refuse, naming every fragment the caller expected? */
function refuses(result: { ok: boolean; reason?: string }, names: string[]): boolean {
	return result.ok === false && names.every((needle) => (result.reason ?? "").includes(needle));
}

/** The refusal a failed call carried, for a probe line's detail. */
function reasonOf(result: { ok: boolean; reason?: string }): string {
	return result.reason ?? "ok";
}

const envelope = (over: Partial<IpcEnvelope> = {}): IpcEnvelope => ({
	v: ipc.IPC_ENVELOPE_VERSION,
	id: "m-1",
	ts: new Date().toISOString(),
	from: SELF,
	kind: "message",
	text: "hello",
	...over,
});

const ownPresence = (over: Partial<IpcPresence> = {}): IpcPresence => ({
	id: SELF,
	cwd: "/tmp/probe-cwd",
	model: "probe-model",
	pid: process.pid,
	processStartTicks: ipc.processStartTicks(process.pid) ?? 0,
	namespaces: ["canon"],
	startedAt: new Date().toISOString(),
	...over,
});

// ---- the rendezvous path ----------------------------------------------------------

console.log("the rendezvous path");
{
	const saved = process.env.XDG_RUNTIME_DIR;
	delete process.env.XDG_RUNTIME_DIR;
	const unset = ipc.ipcRoot();
	check(
		"an unset XDG_RUNTIME_DIR is refused by name",
		refuses(unset, ["XDG_RUNTIME_DIR"]),
		reasonOf(unset),
	);

	const notADir = join(runtime, "a-file");
	writeFileSync(notADir, "not a directory\n");
	process.env.XDG_RUNTIME_DIR = notADir;
	const fileRoot = ipc.ipcRoot();
	check(
		"a non-directory XDG_RUNTIME_DIR is refused by name",
		refuses(fileRoot, ["not a directory"]),
		reasonOf(fileRoot),
	);

	if (process.geteuid?.() === 0) {
		skip("a foreign-owned runtime directory", "this probe is running as root");
		void saved;
	} else {
		process.env.XDG_RUNTIME_DIR = "/proc/1";
		const foreign = ipc.ipcRoot();
		check(
			"another user's runtime directory is refused by name",
			refuses(foreign, ["belongs to uid"]),
			reasonOf(foreign),
		);
	}

	process.env.XDG_RUNTIME_DIR = runtime;
	const root = ipc.ipcRoot();
	check(
		"the root is $XDG_RUNTIME_DIR/pi-ipc and resolves at call time",
		root.ok && root.path === join(runtime, "pi-ipc"),
		root.ok ? root.path : root.reason,
	);
	check(
		"resolving the path creates nothing",
		!existsSync(join(runtime, "pi-ipc")),
		"the tree is created by ensureRoot, not by the accessor",
	);
}

// ---- the tree and its modes -------------------------------------------------------

console.log("the tree");
{
	const ensured = ipc.ensureRoot();
	check("ensureRoot creates the tree", ensured.ok, ensured.ok ? ensured.path : ensured.reason);
	const rootMode = ensured.ok ? statSync(ensured.path).mode & 0o777 : 0;
	check("the root is 0700", rootMode === 0o700, rootMode.toString(8));
	const peers = ipc.readPeers();
	check("an empty tree reads as no peers", peers.ok && peers.peers.length === 0);
}

// ---- the wire limits and contract strings -----------------------------------------

console.log("the contract strings");
{
	check(
		"the register event name is byte-identical",
		ipc.IPC_REGISTER_EVENT === "intercom:extension-register",
		ipc.IPC_REGISTER_EVENT,
	);
	check(
		"the registry-ready event name is byte-identical",
		ipc.IPC_REGISTRY_READY_EVENT === "intercom:extension-registry-ready",
		ipc.IPC_REGISTRY_READY_EVENT,
	);
	check(
		"the namespace pattern is the loader's own rule",
		ipc.IPC_NAMESPACE_PATTERN.source === "^[a-z0-9][a-z0-9._/-]{0,63}$",
		ipc.IPC_NAMESPACE_PATTERN.source,
	);
	check(
		"the audiences are the loader's two",
		ipc.IPC_AUDIENCES.join("|") === "owner|capable",
		ipc.IPC_AUDIENCES.join("|"),
	);
	check(
		"the channel methods are the two consumers call",
		ipc.IPC_CHANNEL_METHODS.join("|") === "publish|listSessions",
		ipc.IPC_CHANNEL_METHODS.join("|"),
	);
	check("the text cap is 32 KiB", ipc.IPC_TEXT_CAP === 32768, String(ipc.IPC_TEXT_CAP));
	const source = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
	const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
	check(
		"the transport imports node builtins only",
		specifiers.length > 0 && specifiers.every((specifier) => specifier.startsWith("node:")),
		specifiers.join(", "),
	);
}

// ---- envelope validation ----------------------------------------------------------

console.log("envelope validation");
{
	const good = ipc.parseEnvelope(
		envelope({
			to: OTHER,
			kind: "answer",
			answerTo: "m-0",
			namespace: "canon",
			audience: "capable",
		}),
	);
	check("a complete envelope parses", good.ok, good.ok ? good.envelope.id : good.reason);

	check("an envelope must be an object", refuses(ipc.parseEnvelope("x"), ["JSON object"]));
	check(
		"a foreign version is refused by name",
		refuses(ipc.parseEnvelope(envelope({ v: 2 })), ["envelope.v"]),
	);
	check(
		"a traversing message id is refused by name",
		refuses(ipc.parseEnvelope(envelope({ id: "../../etc/passwd" })), ["envelope.id"]),
	);
	check(
		"a non-timestamp is refused by name",
		refuses(ipc.parseEnvelope(envelope({ ts: "yesterday" })), ["envelope.ts"]),
	);
	check(
		"an unknown kind is refused by name",
		refuses(ipc.parseEnvelope(envelope({ kind: "shout" as never })), ["envelope.kind"]),
	);
	check(
		"a bus envelope without a namespace is refused by name",
		refuses(ipc.parseEnvelope(envelope({ kind: "bus" })), ["envelope.namespace"]),
	);
	check(
		"a namespace outside the pattern is refused by name",
		refuses(ipc.parseEnvelope(envelope({ kind: "bus", namespace: "Not A Namespace" })), [
			"envelope.namespace",
		]),
	);
	check(
		"an unknown audience is refused by name",
		refuses(ipc.parseEnvelope(envelope({ audience: "everyone" as never })), ["envelope.audience"]),
	);
	check(
		"an answer without answerTo is refused by name",
		refuses(ipc.parseEnvelope(envelope({ kind: "answer" })), ["envelope.answerTo"]),
	);
	check(
		"a non-string text is refused by name",
		refuses(ipc.parseEnvelope(envelope({ text: 42 as never })), ["envelope.text"]),
	);
	check(
		"text exactly at the cap passes",
		ipc.parseEnvelope(envelope({ text: "a".repeat(ipc.IPC_TEXT_CAP) })).ok,
	);
	const over = ipc.parseEnvelope(envelope({ text: "a".repeat(ipc.IPC_TEXT_CAP + 1) }));
	check(
		"one byte over the cap is refused by name",
		refuses(over, ["cap"]),
		over.ok ? "" : over.reason,
	);
	const multibyte = ipc.parseEnvelope(envelope({ text: "é".repeat(ipc.IPC_TEXT_CAP / 2 + 1) }));
	check(
		"the cap counts bytes, not characters",
		refuses(multibyte, ["cap"]),
		`${ipc.IPC_TEXT_CAP / 2 + 1} characters`,
	);
}

// ---- presence validation ----------------------------------------------------------

console.log("presence validation");
check("a complete record parses", ipc.parsePresence(ownPresence()).ok);
check("a record must be an object", refuses(ipc.parsePresence([]), ["JSON object"]));
check(
	"a missing cwd is refused by name",
	refuses(ipc.parsePresence({ ...ownPresence(), cwd: undefined }), ["presence.cwd"]),
);
check(
	"a non-numeric pid is refused by name",
	refuses(ipc.parsePresence({ ...ownPresence(), pid: "self" }), ["presence.pid"]),
);
check(
	"missing process start ticks are refused by name",
	refuses(ipc.parsePresence({ ...ownPresence(), processStartTicks: undefined }), [
		"presence.processStartTicks",
	]),
);
check(
	"an invalid namespace entry is refused by name",
	refuses(ipc.parsePresence({ ...ownPresence(), namespaces: ["CANON"] }), ["presence.namespaces"]),
);

// ---- liveness ---------------------------------------------------------------------

console.log("liveness");
{
	check(
		"this process has a start time",
		(ipc.processStartTicks(process.pid) ?? 0) > 0,
		String(ipc.processStartTicks(process.pid)),
	);
	const reaped = spawnSync(process.execPath, ["-e", ""]);
	const deadPid = reaped.pid ?? 0;
	check(
		"a reaped pid has no start time",
		deadPid > 0 && ipc.processStartTicks(deadPid) === null,
		`pid ${deadPid}`,
	);
	check("pid 0 is not a process", ipc.processStartTicks(0) === null);
	check("a negative pid is not a process", ipc.processStartTicks(-1) === null);

	const mine = ownPresence();
	check("this session's record is written", ipc.writePresence(mine).ok);
	const read = ipc.readPeers();
	check(
		"the record reads back as a live peer",
		read.ok && read.peers.length === 1 && read.peers[0]?.id === SELF,
		read.ok ? `${read.peers.length} peer(s)` : read.reason,
	);

	// A pid the kernel has reused: alive, but not with the start time the record names.
	const reused = ownPresence({ id: "probe-reused", processStartTicks: mine.processStartTicks + 1 });
	check("a reused pid's record is written", ipc.writePresence(reused).ok);
	const afterReuse = ipc.readPeers();
	check(
		"a reused pid is not a peer",
		afterReuse.ok && afterReuse.peers.every((peer) => peer.id !== "probe-reused"),
		afterReuse.ok ? `${afterReuse.peers.length} peer(s)` : afterReuse.reason,
	);

	const dead = ownPresence({ id: "probe-dead", pid: deadPid });
	check("a dead pid's record is written", ipc.writePresence(dead).ok);
	const sweeps = ipc.sweepStale();
	check(
		"sweepStale removes only the records whose process is gone",
		sweeps.ok &&
			sweeps.removed.includes("probe-reused.json") &&
			sweeps.removed.includes("probe-dead.json") &&
			!sweeps.removed.includes(`${SELF}.json`),
		sweeps.ok ? sweeps.removed.join(", ") : sweeps.reason,
	);
	const afterSweep = ipc.readPeers();
	check(
		"the live record survives the sweep",
		afterSweep.ok && afterSweep.peers.length === 1 && afterSweep.peers[0]?.id === SELF,
		afterSweep.ok ? `${afterSweep.peers.length} peer(s)` : afterSweep.reason,
	);

	check(
		"a second session's record is written",
		ipc.writePresence(ownPresence({ id: OTHER, namespaces: ["broadcast"] })).ok,
	);
	const canonPeers = ipc.peersWithNamespace("canon");
	check(
		"a namespace filter keeps only the sessions serving it",
		canonPeers.ok && canonPeers.peers.length === 1 && canonPeers.peers[0]?.id === SELF,
		canonPeers.ok ? canonPeers.peers.map((peer) => peer.id).join(", ") : canonPeers.reason,
	);
	check(
		"an invalid namespace is refused by name",
		refuses(ipc.peersWithNamespace("Canon"), ["namespace"]),
	);
}

// ---- delivery ---------------------------------------------------------------------

console.log("delivery");
{
	const first = ipc.deliver(SELF, envelope({ id: "m-a", text: "first" }));
	check("a message is delivered", first.ok, first.ok ? "" : first.reason);
	check(
		"a second message is delivered",
		ipc.deliver(SELF, envelope({ id: "m-b", text: "second" })).ok,
	);
	check(
		"a third message is delivered",
		ipc.deliver(SELF, envelope({ id: "m-c", text: "third" })).ok,
	);

	const drained = ipc.drain(SELF);
	check(
		"drain answers the messages in delivery order",
		drained.ok && drained.envelopes.map((item) => item.id).join(",") === "m-a,m-b,m-c",
		drained.ok ? drained.envelopes.map((item) => item.id).join(",") : drained.reason,
	);
	check(
		"drain names no refused file for well-formed messages",
		drained.ok && drained.refused.length === 0,
		drained.ok ? String(drained.refused.length) : drained.reason,
	);
	const empty = ipc.drain(SELF);
	check("a second drain finds nothing", empty.ok && empty.envelopes.length === 0);

	const delivered = ipc.deliver(SELF, envelope({ id: "m-mode" }));
	if (delivered.ok) {
		const inbox = join(runtime, "pi-ipc", "inbox", SELF);
		const files = readdirSync(inbox);
		const mode = files.length === 1 ? statSync(join(inbox, files[0] ?? "")).mode & 0o777 : 0;
		check(
			"a message file is 0600",
			mode === 0o600,
			`${files.length} file(s), mode ${mode.toString(8)}`,
		);
		ipc.drain(SELF);
	} else {
		check("a message file is 0600", false, delivered.reason);
	}

	check(
		"a traversing target is refused by name",
		refuses(ipc.deliver("../escape", envelope()), ["delivery target"]),
	);
	check(
		"a traversing drain target is refused by name",
		refuses(ipc.drain("../escape"), ["drain target"]),
	);
	check(
		"an envelope addressed to another session is refused by name",
		refuses(ipc.deliver(OTHER, envelope({ to: SELF })), ["delivered to"]),
	);

	const unknown = ipc.drain("probe-never-written");
	check(
		"draining an unknown session answers nothing",
		unknown.ok && unknown.envelopes.length === 0,
	);
	check(
		"draining an unknown session creates nothing",
		!existsSync(join(runtime, "pi-ipc", "inbox", "probe-never-written")),
		"the inbox is created by deliver, not by drain",
	);
}

// ---- an unreadable message cannot wedge the inbox ---------------------------------

console.log("an unreadable message");
{
	const inbox = join(runtime, "pi-ipc", "inbox", SELF);
	const broken = join(inbox, "0000000000000001-broken.json");
	writeFileSync(broken, '{ "v": 1, "id": "broken", "ts": ');
	const partial = join(inbox, ".tmp-9999-1");
	writeFileSync(partial, '{ "v": 1, "id": "partial"');

	const drained = ipc.drain(SELF);
	check(
		"a file that does not parse is named in refused",
		drained.ok &&
			drained.refused.length === 1 &&
			drained.refused[0]?.file === "0000000000000001-broken.json",
		drained.ok ? JSON.stringify(drained.refused) : drained.reason,
	);
	check(
		"it is removed rather than left to fail again",
		!readdirSync(inbox).includes("0000000000000001-broken.json"),
		"the next drain admits no refusal for it",
	);
	const again = ipc.drain(SELF);
	check(
		"a half-written temp file is invisible to a reader",
		again.ok && again.refused.length === 0 && again.envelopes.length === 0,
		again.ok ? JSON.stringify(again.refused) : again.reason,
	);
	check(
		"the temp file is left for its writer",
		readdirSync(inbox).includes(".tmp-9999-1"),
		readdirSync(inbox).join(", "),
	);
	rmSync(partial, { force: true });
}

// ---- concurrent delivery: the atomic property -------------------------------------

console.log("concurrent delivery");
{
	const writers = 4;
	const perWriter = 50;
	const children = Array.from({ length: writers }, () =>
		spawn(process.execPath, [
			"--experimental-strip-types",
			fileURLToPath(import.meta.url),
			"--writer",
			OTHER,
			String(perWriter),
		]),
	);

	const seen = new Set<string>();
	let refusedFiles = 0;
	const deadline = Date.now() + 30_000;
	let exited = 0;
	for (const child of children) child.on("exit", () => (exited += 1));

	while (exited < writers && Date.now() < deadline) {
		const drained = ipc.drain(OTHER);
		if (!drained.ok) {
			refusedFiles += 1;
			break;
		}
		for (const item of drained.envelopes) seen.add(item.id);
		refusedFiles += drained.refused.length;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	for (const child of children) {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
	const tail = ipc.drain(OTHER);
	if (tail.ok) {
		for (const item of tail.envelopes) seen.add(item.id);
		refusedFiles += tail.refused.length;
	}

	check(
		"every writer process exited cleanly",
		children.every((child) => child.exitCode === 0),
		children.map((child) => child.exitCode).join(", "),
	);
	check(
		"a reader never saw a partial envelope",
		refusedFiles === 0,
		`${refusedFiles} unreadable file(s) across every drain`,
	);
	check(
		"every delivered message arrived exactly once",
		seen.size === writers * perWriter,
		`${seen.size} unique id(s) of ${writers * perWriter}`,
	);
}

// ---- session hygiene --------------------------------------------------------------

console.log("hygiene");
{
	const root = ipc.ipcRoot();
	check(
		"every path this probe used is under the scratch runtime directory",
		root.ok && root.path.startsWith(runtime),
		root.ok ? root.path : root.reason,
	);
	const state = readdirSync(join(runtime, "pi-ipc", "presence"));
	check(
		"the presence directory holds only this probe's records",
		[SELF, OTHER].every((id) => state.includes(`${id}.json`)),
		state.join(", "),
	);
}

rmSync(runtime, { recursive: true, force: true });
check("the scratch runtime directory was removed", !existsSync(runtime));
console.log("");

if (failures > 0) {
	console.error(`ipc probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`ipc probe passed: ${checks} checks`);
