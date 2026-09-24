/**
 * build: bounded build/checker runner for pi (tool-burn reduction T3).
 *
 * Runs tsc / ags bundle / npm / makepkg style commands WITHOUT dumping raw
 * output into the conversation (one raw `tsc --noEmit` burned 122 KB; a
 * mkdir/build loop burned 579 KB — the R2 rule bans raw build output).
 *
 * Crew isolation. When the caller is a crew worker, the command runs against that
 * worker's OWN output root, cache directories and temporary directory, all of
 * which are created on demand and exported into the spawned environment. Two
 * workers therefore never contend on target/, node_modules or a bundle output
 * tree. The resolved roots are returned with every result, so "I set
 * CARGO_TARGET_DIR but the build used ./target" is visible instead of silent.
 *
 * The crew store is owned by the fleet package: its `ioRoot()` and
 * `identityHolder()` are reached through a guarded DYNAMIC import, resolved on
 * the first build call and never at load. A process without that package is not
 * a crew process: the build runs with the session's own environment and logs
 * under `LOG_FALLBACK_DIR`, and the absence is reported once by name.
 *
 * The environment handed to the build is FILTERED: the subagent and provider
 * variables are removed before the build's own children (postinstalls, package
 * scripts) can inherit them and leak worker identity into a log.
 *
 * Behavior:
 *   - Full stdout+stderr streamed to a log file under the worker's root (or
 *     /tmp/pi-build-logs for a non-crew caller, with the pid in the name so two
 *     concurrent builds cannot clobber each other's log).
 *   - Returns: exit code, the terminating SIGNAL when there was one (a killed
 *     build is not a failed build), duration, total line count, error/warning
 *     lines, the log path and the resolved roots.
 *   - Runs sequentially: one worker issuing two builds in one message must not
 *     race itself in its own output tree.
 *   - One line per build appended to <io root>/builds.jsonl when a crew store is
 *     present.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	argText,
	clip,
	type HeaderPart,
	hookLog,
	optionalNeighbour,
	safeToolHeader,
} from "@tinoy/pi-ext-lib";
import { Type } from "typebox";

const FALLBACK_LOG_DIR = "/tmp/pi-build-logs";
const ERR_RE = /(error|warning|fail|fatal|exception|✗|✖|cannot find|not found|E:\s)/i;
const ERR_LINE_CAP = 30;
const TAIL_CAP = 15;
/** Variables a build's own children must not inherit. */
const ENV_STRIP_PREFIXES = ["PI_SUBAGENT", "PI_SUBAGENTS", "PI_SESSION", "PI_INTERCOM"];
const ENV_STRIP_EXACT = [
	"PI_MODEL",
	"PI_PROVIDER",
	"PI_REASONING_LEVEL",
	"PI_CODING_AGENT",
	"PI_CACHE_RETENTION",
];

/**
 * The package that owns the io store's location and this process's identity:
 * `ioRoot()` lives in `claims.ts`, `identityHolder()` in `identity.ts`.
 */
const IO_GUARD_PACKAGE = "@tinoy/pi-io-guard";
const CLAIMS_MODULE = "@tinoy/pi-io-guard/claims.ts";
const IDENTITY_MODULE = "@tinoy/pi-io-guard/identity.ts";

export interface BuildRoots {
	output: string;
	cache: string;
	tmp: string;
	crew: boolean;
	worker?: string;
}

/** What a build runs against: the worker's roots, plus the store they live in. */
export interface BuildContext {
	roots: BuildRoots | null;
	ioRoot: string | null;
}

interface CrewClaims {
	ioRoot: () => string;
}
interface WorkerIdentityLike {
	worker: string;
}
interface CrewIdentity {
	identityHolder: (root: string) => { get: () => WorkerIdentityLike | null };
}

/**
 * The crew modules, or null when the package is not installed. One resolution
 * per process, one `neighbour-absent` line naming what is lost.
 */
let crewPromise: Promise<{ claims: CrewClaims; identity: CrewIdentity } | null> | undefined;

function loadCrew(): Promise<{ claims: CrewClaims; identity: CrewIdentity } | null> {
	crewPromise ??= optionalNeighbour(
		IO_GUARD_PACKAGE,
		() => Promise.all([import(CLAIMS_MODULE), import(IDENTITY_MODULE)]),
		{
			source: "build",
			effect:
				"builds run in the shared session environment and log under /tmp instead of this worker's own output, cache and temp tree",
			hint: `pi install npm:${IO_GUARD_PACKAGE}`,
		},
	).then((modules) => {
		if (!modules) return null;
		const [claims, identity] = modules as [CrewClaims, CrewIdentity];
		if (typeof claims?.ioRoot !== "function" || typeof identity?.identityHolder !== "function") {
			hookLog("build", "neighbour-absent", {
				neighbour: IO_GUARD_PACKAGE,
				effect: "the crew store is reachable but does not export ioRoot/identityHolder",
				hint: `reinstall ${IO_GUARD_PACKAGE}`,
			});
			return null;
		}
		return { claims, identity };
	});
	return crewPromise;
}

/** This worker's private build roots and store; both null for a non-crew caller. */
export async function resolveBuildContext(): Promise<BuildContext> {
	const crew = await loadCrew();
	if (!crew) return { roots: null, ioRoot: null };
	const ioRoot = crew.claims.ioRoot();
	const me = crew.identity.identityHolder(ioRoot).get();
	if (!me) return { roots: null, ioRoot };
	const base = join(ioRoot, "build", me.worker);
	const roots: BuildRoots = {
		output: join(base, "out"),
		cache: join(base, "cache"),
		tmp: join(base, "tmp"),
		crew: true,
		worker: me.worker,
	};
	for (const d of [roots.output, roots.cache, roots.tmp]) mkdirSync(d, { recursive: true });
	return { roots, ioRoot };
}

/** The environment a build runs with: filtered, plus the worker's own roots. */
export function buildEnvironment(
	roots: BuildRoots | null,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(base)) {
		if (ENV_STRIP_EXACT.includes(k)) continue;
		if (ENV_STRIP_PREFIXES.some((p) => k.startsWith(p))) continue;
		env[k] = v;
	}
	if (!roots) return env;
	return {
		...env,
		CARGO_TARGET_DIR: roots.output,
		npm_config_cache: join(roots.cache, "npm"),
		CCACHE_DIR: join(roots.cache, "ccache"),
		SCCACHE_DIR: join(roots.cache, "sccache"),
		XDG_CACHE_HOME: roots.cache,
		TMPDIR: roots.tmp,
	};
}

function run(
	cmd: string,
	cwd: string | undefined,
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
): Promise<{ code: number; signal: string | null; output: string }> {
	return new Promise((resolve) => {
		const child = spawn("bash", ["-c", cmd], { cwd, env });
		let output = "";
		const onData = (d: Buffer) => {
			output += d.toString();
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ code: code ?? 1, signal: signal ?? null, output });
		});
		child.on("error", () => {
			clearTimeout(timer);
			resolve({ code: 127, signal: null, output: `${output}\nbash: spawn failed` });
		});
	});
}

function slug(cmd: string): string {
	return (
		cmd
			.trim()
			.split(/\s+/)
			.slice(0, 3)
			.join("-")
			.replace(/[^a-zA-Z0-9._-]/g, "")
			.slice(0, 48) || "build"
	);
}

const buildTool = {
	name: "build",
	label: "Build",
	// One worker must not race itself in its own output tree.
	executionMode: "sequential" as const,
	description:
		"Run a build/compile/lint/typecheck command (tsc, ags bundle, npm, makepkg, npx) with bounded output. " +
		"Runs against this worker's own output, cache and temp directories and reports them. " +
		"Returns exit code + the terminating signal when there was one + error/warning lines + log path; " +
		"full output goes to a log file, never into the conversation. Use this instead of raw bash for any checker command.",
	parameters: Type.Object({
		command: Type.String({
			description: "Shell command to run, e.g. 'npx --no-install tsc --noEmit -p tsconfig.json'",
		}),
		cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
		timeoutMs: Type.Optional(
			Type.Number({ description: "Hard kill timeout (default 300000, max 900000)" }),
		),
	}),

	renderCall(args: Record<string, unknown>, theme: Parameters<typeof safeToolHeader>[0]) {
		return safeToolHeader(theme, "build", () => {
			const parts: HeaderPart[] = [
				["accent", ` ${clip(argText(args, "command") ?? "(no command)", 100)}`],
			];
			const cwd = argText(args, "cwd");
			if (cwd) parts.push(["dim", ` in ${clip(cwd, 50)}`]);
			return parts;
		});
	},

	async execute(
		_toolCallId: string,
		params: { command: string; cwd?: string; timeoutMs?: number },
	) {
		const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 300_000, 5_000), 900_000);
		const started = Date.now();
		const context = await resolveBuildContext();
		const roots = context.roots;
		const env = buildEnvironment(roots);
		const { code, signal, output } = await run(params.command, params.cwd, timeoutMs, env);
		const durS = ((Date.now() - started) / 1000).toFixed(1);

		const logDir = context.ioRoot ? join(context.ioRoot, "build", "logs") : FALLBACK_LOG_DIR;
		mkdirSync(logDir, { recursive: true });
		const logPath = join(logDir, `${Date.now()}-${process.pid}-${slug(params.command)}.log`);
		writeFileSync(logPath, output);

		if (context.ioRoot) {
			try {
				appendFileSync(
					join(context.ioRoot, "builds.jsonl"),
					`${JSON.stringify({
						ts: new Date().toISOString(),
						worker: roots?.worker ?? "session",
						command: params.command,
						cwd: params.cwd ?? process.cwd(),
						roots: roots ? { output: roots.output, cache: roots.cache, tmp: roots.tmp } : null,
						code,
						signal,
						ms: Date.now() - started,
						log: logPath,
					})}\n`,
				);
			} catch {
				/* the build record is diagnostics; a failure to log must not fail a build */
			}
		}

		const logLines = output.split("\n");
		const matched = logLines.filter((l) => ERR_RE.test(l));
		let excerpt: string;
		if (matched.length > 0) {
			const lines = matched.slice(0, ERR_LINE_CAP);
			excerpt = `${matched.length} error/warning line(s), showing ${lines.length}:\n${lines.join("\n")}`;
			if (matched.length > ERR_LINE_CAP)
				excerpt += `\n… (+${matched.length - ERR_LINE_CAP} matched lines, full log: ${logPath})`;
		} else {
			excerpt = `no error/warning lines matched; last ${Math.min(TAIL_CAP, logLines.length)} output line(s):\n${logLines.slice(-TAIL_CAP).join("\n")}`;
		}
		excerpt = excerpt.split("\n").slice(0, 60).join("\n").slice(0, 6000);

		const killed = signal !== null ? `signal=${signal}` : "";
		const rootsLine = roots
			? `roots out=${roots.output} cache=${roots.cache} tmp=${roots.tmp}`
			: "roots (this session, no per-worker isolation)";
		return {
			content: [
				{
					type: "text" as const,
					text: `exit=${code}${killed ? ` ${killed}` : ""} duration=${durS}s lines=${logLines.length}\n${rootsLine}\nlog=${logPath}\n\n${excerpt}`,
				},
			],
		};
	},
};

function register(pi: ExtensionAPI): void {
	pi.registerTool(buildTool as never);
}

export default function (pi: ExtensionAPI): void {
	try {
		register(pi);
	} catch (error) {
		hookLog("build", "register-failed", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}
