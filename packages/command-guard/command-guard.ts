/**
 * command-guard: tool_call hook enforcing the command rules mechanically.
 *
 * Two rule families:
 *   RAW-INPUT (bash + the ctx_* execution tools, every session shape): raw
 *     synthetic-input binaries are blocked and redirected to the `inject`
 *     wrapper. A leaked press (`ydotool click 0x40` with no release of the
 *     button) leaves BTN_LEFT held on the virtual device, so the seat believes
 *     button 1 is already down and every real left click on the machine is
 *     ignored until the release lands. The check covers
 *     ctx_execute/ctx_execute_file/ctx_batch_execute because an execSync inside
 *     sandboxed code reaches the same binary and never passes through bash.
 *   R1/R2 (bash only): blocks bash calls that bypass the dedicated tools, with
 *     one-line redirect guidance in the block reason:
 *   - file-content reads via bash:  cat / sed -n 'a,bp' / head -n / tail -n /
 *     grep <path> / rg <pattern> <path> (incl. cwd-recursive rg|grep -r)
 *     → "use read (offset/limit)"; for search the redirect names the tool
 *     the SESSION actually has (see callerCaps) and ALWAYS names the
 *     tool-free shell form — a pipeline whose later stage restricts grep's
 *     output (`| head -20`, `| wc -l`, `| grep -v x`, `| cut -c1-110`) or a
 *     redirect into /tmp. Both forms satisfy the rule in any session shape
 *     (a pi subagent runs its own process on a much smaller menu — no
 *     ctx_* tools at all — so a redirect naming ctx_execute is unfollowable
 *     and costs a retry)
 *   - truncation-only pipelines:    cat X | head -120 (no transforming stage)
 *     → "use read (offset/limit)"
 *   - raw build/checker output:     tsc / makepkg / npm run|test|build /
 *     ags bundle / go build / cargo build / make — blocked ONLY when the
 *     output is unfiltered; a pipe into a filter/limiter (grep/rg/awk/sed/
 *     head/tail with a pattern or count, `| wc -l`) or a redirect into a
 *     /tmp log passes → "filter it, log it under /tmp", plus "or use the
 *     build tool" only when that tool is in the session's menu
 *
 * Conservative by design (false positives are worse than misses):
 *   - a pipeline whose later stages TRANSFORM (grep, awk, jq, sort, uniq, cut,
 *     tr, sed, node, python, perl …) is the sanctioned extraction exception
 *     (canon R1); mere truncation (head/tail/wc) is NOT a transform.
 *     EXCEPTION TO THE EXCEPTION: grep/rg with an explicit path or -r are
 *     checked BEFORE the transform gate, because the harm here is grep's own
 *     output, not a later stage: a RESTRICTING stage (re-filter, limiter,
 *     count, field projection, or a /tmp log redirect) makes the output
 *     derived and passes; a bare dump and a merely reshaping stage
 *     (`grep -rn x . | sort`, `| tee out`) still block.
 *   - skips segments containing $ variables or regex-$ anchors, heredocs, or
 *     file output redirects (writes, not reads); glob chars are skipped EXCEPT
 *     for grep/rg, whose quoted-glob dump shapes are checked explicitly
 *   - allows tail -f / tail with -f, cat with no operands, sudo-prefixed
 *     commands (own flow), rg --files (listing mode), stdin-reading grep, and
 *     content-free grep output (-c/--count, -l/-L/--files-with-matches),
 *     which prints a number or file names, never file content
 *
 * Every block is appended to the shared hook log
 * (~/.local/share/pi-hooks/log.jsonl, {ts, source, kind, detail}) which the
 * monthly pi-tool-burn report reads. Rows carry source "command-guard"; the
 * RAW-INPUT family was added to the extension formerly named bash-guard, and
 * "bash-guard" rows read the same way in the footer's counter.
 */

import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { hookLog } from "@tinoy/pi-ext-lib";

const BUILD_FIRST = new Set(["tsc", "makepkg", "cmake", "meson"]);
const BUILD_PAIRS: Record<string, RegExp> = {
	npm: /^(run|test)$/,
	npx: /^(tsc|eslint|prettier|biome)$/,
	ags: /^(bundle)$/,
	go: /^(build|test|vet)$/,
	cargo: /^(build|check|test|clippy)$/,
	make: /^(.*)$/,
};

// pipeline stages after the first that count as sanctioned extraction
const TRANSFORM = new Set([
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ripgrep",
	"awk",
	"gawk",
	"jq",
	"sed",
	"sort",
	"uniq",
	"cut",
	"tr",
	"python",
	"python3",
	"node",
	"perl",
	"ruby",
	"xargs",
	"tee",
]);

// R2 exemption: a later pipeline stage that filters or limits the build output
// (grep/rg/awk/sed with a pattern, head/tail with a count, `| wc -l`) leaves the
// caller only that slice — the shape the rule asks for. A bare `npx tsc` /
// `npm run …` / `makepkg` dump stays blocked.
const OUTPUT_FILTER = new Set([
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ripgrep",
	"awk",
	"gawk",
	"sed",
	"jq",
	"cut",
	"sort",
	"uniq",
	"tr",
	"head",
	"tail",
	"wc",
]);
// Filters that only shape output when given a pattern/program argument.
const FILTER_NEEDS_OPERAND = new Set([
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ripgrep",
	"awk",
	"gawk",
	"sed",
	"jq",
	"cut",
	"tr",
]);

// Stages that RESTRICT what grep/rg would otherwise print: a re-filter with a
// pattern/program (grep/rg/awk/sed/jq), a limiter (head/tail), a count (wc) or a
// field projection (cut). Reshaping stages (sort/uniq/tr/tee) leave a repo-wide
// match dump intact in the caller's context and do NOT qualify.
const OUTPUT_RESTRICT = new Set([
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ripgrep",
	"awk",
	"gawk",
	"sed",
	"jq",
	"head",
	"tail",
	"wc",
	"cut",
]);

/** A redirect into a /tmp log: nothing reaches the model directly, the caller
 *  reads the slice back with `read`. */
const TMP_LOG = /(?:^|\s)[0-9]?>{1,2}\s*\/tmp\//;

/** True when a later pipeline stage reduces grep/rg's own output to a derived
 *  slice — the shape canon R1 asks for ("print only the derived result"). */
function restrictsOutput(seg: string): boolean {
	return pipeStages(seg)
		.slice(1)
		.some((s) => {
			const words = stripRedirects(s).split(/\s+/).filter(Boolean);
			if (!OUTPUT_RESTRICT.has(words[0])) return false;
			if (!FILTER_NEEDS_OPERAND.has(words[0])) return true;
			// `cut -c1-110` / `cut -f2` carry the field/char spec inside the flag token
			if (words[0] === "cut" && words.slice(1).some((a) => /^-[a-zA-Z]*[cf][0-9]/.test(a)))
				return true;
			return words.slice(1).some((a) => !a.startsWith("-"));
		});
}

/** True when this segment pipes its output into a filter/limiter, or redirects
 *  it into a log file under /tmp (then nothing reaches the model directly). */
function filtersOutput(seg: string): boolean {
	const stages = pipeStages(seg);
	const filtered = stages.slice(1).some((s) => {
		const words = stripRedirects(s).split(/\s+/).filter(Boolean);
		if (!OUTPUT_FILTER.has(words[0])) return false;
		if (!FILTER_NEEDS_OPERAND.has(words[0])) return true;
		return words.slice(1).some((a) => !a.startsWith("-"));
	});
	if (filtered) return true;
	return TMP_LOG.test(seg);
}

function log(command: string, rule: string): void {
	hookLog("command-guard", "block", { rule, command: command.slice(0, 200) });
}

/** Read the calling session's active tool names so a block names only tools it
 *  has. The hook context carries no tool list (ExtensionContext exposes ui,
 *  mode, cwd, sessionManager, model, … and the tool_call event only toolName/
 *  input/toolCallId), so `pi.getActiveTools()` is the ONE capability signal; it
 *  reflects THIS pi process, and a pi-subagent child runs its own process on a
 *  much smaller menu.
 *  Returns undefined when the API or the call is unavailable — callers then
 *  fall back to wording that is true for every session shape. */
function callerCaps(pi: ExtensionAPI): GuardCaps | undefined {
	try {
		const get = (pi as { getActiveTools?: () => string[] }).getActiveTools;
		if (typeof get !== "function") return undefined;
		const tools = get.call(pi) ?? [];
		return { grep: tools.includes("grep"), build: tools.includes("build") };
	} catch {
		return undefined;
	}
}

export function segments(command: string): string[] {
	return command
		.split(/&&|\|\||;|\n/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function pipeStages(seg: string): string[] {
	return seg
		.split("|")
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Drop file-output/input redirect tokens (2>/dev/null, > out.log, < in) from a stage. */
function stripRedirects(stage: string): string {
	return stage.replace(/[0-9]?[<>]{1,2}\s*\S+/g, " ");
}

function firstWord(stage: string): string {
	return stripRedirects(stage).split(/\s+/).filter(Boolean)[0] || "";
}

const R2_REASON = (caps?: GuardCaps): string =>
	`R2: raw build/checker output — pipe it into a filter (\`2>&1 | grep -E 'error TS' | head -20\`), or write it under /tmp and read the slice${caps?.build ? ", or use the build tool" : ""}.`;

/** What the CALLING SESSION can actually call. Interactive parent sessions may
 *  carry tools a child never loads; subagent children run on a smaller menu
 *  (`build` is registered by the build package, which subagent sets do not
 *  load, and the ctx_* family is often absent). Undefined = unknown (the
 *  message then stays true for both shapes — it leads with the tool-free
 *  shell form). */
export type GuardCaps = { grep: boolean; build: boolean };

/** grep/rg via bash dumps raw file content into the context. Every variant
 *  states that rule, names the tool ONLY when this session has it, and always
 *  gives the shell form that satisfies the rule on its own — a pipeline whose
 *  later stage prints only the derived result, which any session shape can run. */
const R1_PATHS = (caps?: GuardCaps): string =>
	caps?.grep
		? "R1: grep/rg over an explicit path dumps raw file content — use the grep tool (path-unrestricted), or rerun it as a pipeline that prints only the derived result (`grep -rn <pat> <path> | head -20`, `| wc -l`)."
		: caps
			? "R1: grep/rg over an explicit path dumps raw file content — no grep tool in this session: rerun it as a pipeline that prints only the derived result (`grep -rn <pat> <path> | head -20`, `| wc -l`), or `read` with offset/limit."
			: "R1: grep/rg over an explicit path dumps raw file content — rerun it as a pipeline that prints only the derived result (`grep -rn <pat> <path> | head -20`, `| wc -l`), or use the grep tool where the session has one.";

const R1_RECURSIVE = (caps?: GuardCaps): string =>
	caps?.grep
		? "R1: cwd-recursive grep/rg dumps raw file content — use the grep tool (path-unrestricted; scope it with a path or glob pattern), or rerun it as a pipeline that prints only the derived result (`grep -rn <pat> . | head -20`)."
		: caps
			? "R1: cwd-recursive grep/rg dumps raw file content — no grep tool in this session: scope it with a path and rerun it as a pipeline that prints only the derived result (`grep -rn <pat> <path> | head -20`), or `read` the file with offset/limit."
			: "R1: cwd-recursive grep/rg dumps raw file content — scope it with a path and rerun it as a pipeline that prints only the derived result (`grep -rn <pat> <path> | head -20`), or use the grep tool where the session has one.";

/** Returns a redirect reason if this segment is a banned bypass, else null. */
export function inspect(seg: string, caps?: GuardCaps): string | null {
	if (/[$<]/.test(seg)) return null; // vars/regex-$ anchors, heredoc/input-redirect → sanctioned
	const stages = pipeStages(seg);
	const base = stripRedirects(stages[0]);
	const w = base.split(/\s+/).filter(Boolean);
	if (w.length === 0) return null;
	// Prefix wrappers: skip the wrapper AND its own operands, or the operand
	// becomes the command name. `timeout 300 npx tsc` read as cmd "300" and
	// `env FOO=1 npx tsc` as cmd "FOO=1", so every rule below missed both.
	// `timeout [OPTIONS] DURATION COMMAND`:
	if (w[0] === "timeout") {
		w.shift();
		while (w.length > 0 && (/^-/.test(w[0]) || /^[0-9]+(\.[0-9]+)?[smhd]?$/.test(w[0]))) w.shift();
	} else if (w[0] === "env") {
		// `env [OPTIONS] [NAME=VALUE]... COMMAND`:
		w.shift();
		while (w.length > 0 && (/^-/.test(w[0]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) w.shift();
	} else if (w[0] === "sudo") {
		// sudo's own option operands (e.g. `sudo -u user cmd`) are NOT skipped here.
		w.shift();
	}
	if (w.length === 0) return null;
	const cmd = w[0];
	const rest = w.slice(1);
	const hasTransform = stages.slice(1).some((s) => TRANSFORM.has(firstWord(s)));

	// grep/rg: checked BEFORE the glob skip — quoted glob patterns ('*.ts') and
	// abs/relative path operands are exactly the big repo-dump shapes
	if (cmd === "grep" || cmd === "egrep" || cmd === "fgrep" || cmd === "rg" || cmd === "ripgrep") {
		// Listing mode returns file NAMES, not file content — allowed, as documented.
		if (rest.includes("--files")) return null;
		// Content-free grep output prints no file content: -c/--count answers a
		// number, -l/-L/--files-with-matches answer file names. The R1 harm (raw
		// content in the context) is absent, so these pass.
		const contentFree = rest.some(
			(a) =>
				(!a.startsWith("--") && /^-[a-zA-Z]*[clL][a-zA-Z]*$/.test(a)) ||
				a === "--count" ||
				a === "--files-with-matches" ||
				a === "--files-without-match",
		);
		if (contentFree) return null;
		const ops = rest.filter((a) => !a.startsWith("-"));
		if (ops.length > 0) {
			const paths = ops.slice(1); // ops[0] is the pattern (or a path list for rg --files)
			const recursive =
				paths.length === 0 && (cmd !== "grep" || rest.some((a) => /^-[a-zA-Z]*[rR]/.test(a)));
			if (paths.length > 0 || recursive) {
				// grep's own output is the harm, later stage or not: a restricting
				// pipeline prints a derived result, a /tmp redirect keeps it out of the
				// context entirely — both pass. Bare dumps and reshaping stages block.
				if (!restrictsOutput(seg) && !TMP_LOG.test(seg))
					return paths.length > 0 ? R1_PATHS(caps) : R1_RECURSIVE(caps);
			}
			// plain `grep pat` with no path reads stdin → harmless
		}
	}

	if (/\*/.test(seg)) return null; // unquoted glob operands → sanctioned dynamic use

	// R2: raw build/checker output — a bare invocation dumps everything; a
	// pipeline into a filter/limiter (or a redirect into /tmp) passes.
	if (!filtersOutput(seg)) {
		if (BUILD_FIRST.has(cmd)) return R2_REASON(caps);
		if (BUILD_PAIRS[cmd]) {
			const re = BUILD_PAIRS[cmd];
			if (cmd === "make" ? true : rest.some((a) => re.test(a.replace(/^['"]|['"]$/g, ""))))
				return R2_REASON(caps);
		}
	}

	// R1 file-content reads — only when no transforming stage follows
	if (!hasTransform) {
		if (cmd === "cat" && rest.length > 0) return "R1: file content via bash — use the read tool.";
		if (
			/^sed$/.test(cmd) &&
			rest.some(
				(a, i) => a === "-n" && rest[i + 1] && /^\d+[,']/.test(rest[i + 1].replace(/['"]/g, "")),
			)
		)
			return "R1: line-range print via sed — use read with offset/limit.";
		if (cmd === "head" && rest.length > 0 && !rest.includes("-f"))
			return "R1: head via bash — use read with limit.";
		if (cmd === "tail" && rest.length > 0 && !rest.includes("-f"))
			return "R1: tail via bash — use read with offset/limit.";
	}
	return null;
}

// ── RAW-INPUT: synthetic input goes through the `inject` wrapper ────────────
//
// The harm is a HELD button/key, not the injection itself: `ydotool click 0x40`
// presses BTN_LEFT with no release, and the device keeps reporting it pressed,
// so every real left click is swallowed machine-wide until the release is sent.
// The wrapper pairs every press with its release (preflight repair of an
// existing leak, paired presses, release from an EXIT/INT/TERM trap), so raw
// invocations are blocked in every tool that can reach the binary.
//
// Match = an INVOCATION, not the name: `ydotool` in a command position followed
// by one of its subcommands. `command -v ydotool`, `pkill -f ydotool` and prose
// that merely names the binary therefore pass, while `… ; ydotool click 0x40`
// and `execSync('ydotool click 0x40')` block. An optional path prefix covers
// /usr/bin/ydotool; `ydotoold` never matches (its token continues with `d`).
const RAW_INPUT_SUBCOMMANDS = new Set(["click", "mousemove", "type", "key", "debug", "bakers"]);
const RAW_INPUT_INVOKE =
	/(?:^|[\s'"`;&|()$=])(?:[^\s'"`;&|()$=]*\/)?ydotool\s+([A-Za-z][A-Za-z-]*)/g;

/** Escape hatch for a deliberate raw invocation: the marker must be present in
 *  the inspected text, so the bypass is visible in the transcript and the log. */
const RAW_INPUT_ESCAPE = "raw-ydotool-ok";

const RAW_INPUT_REASON =
	"RAW-INPUT: raw `ydotool` is blocked — a leaked press (`click 0x40` with no release) leaves the button held on the virtual device and kills every real left click machine-wide until it is released. Use the `inject` wrapper: `inject status` (read-only probe), `inject click left [--at X Y] [--count N]`, `inject drag X1 Y1 X2 Y2`, `inject move X Y`, `inject scroll N`, `inject type TEXT`, `inject key CODE...`, `inject release` (clear a leak). It pre-checks the device, pairs every press with its release and releases from an EXIT/INT/TERM trap. Deliberate raw use: put the marker `raw-ydotool-ok` in the command.";

/** Every text a tool call can reach the input binary through. The ctx_* family
 *  carries the command inside sandboxed code (execSync/spawn), which a
 *  bash-only scan never sees. */
export function callTexts(toolName: string, input: unknown): string[] {
	const i = (input ?? {}) as { command?: unknown; code?: unknown; commands?: unknown };
	if (toolName === "bash") return typeof i.command === "string" ? [i.command] : [];
	if (toolName === "ctx_execute" || toolName === "ctx_execute_file") {
		return typeof i.code === "string" ? [i.code] : [];
	}
	if (toolName === "ctx_batch_execute") {
		const out: string[] = [];
		if (Array.isArray(i.commands)) {
			for (const c of i.commands) {
				const cmd = (c as { command?: unknown })?.command;
				if (typeof cmd === "string") out.push(cmd);
			}
		}
		if (typeof i.code === "string") out.push(i.code);
		return out;
	}
	return [];
}

/** Returns the RAW-INPUT block reason when a text invokes the raw binary. */
export function inspectInjection(text: string): string | null {
	if (text.includes(RAW_INPUT_ESCAPE)) return null;
	RAW_INPUT_INVOKE.lastIndex = 0;
	let m = RAW_INPUT_INVOKE.exec(text);
	while (m !== null) {
		if (RAW_INPUT_SUBCOMMANDS.has(m[1])) return RAW_INPUT_REASON;
		m = RAW_INPUT_INVOKE.exec(text);
	}
	return null;
}

function register(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		const toolName = String((event as { toolName?: unknown }).toolName ?? "");
		const input = (event as { input?: unknown }).input;

		for (const text of callTexts(toolName, input)) {
			const injected = inspectInjection(text);
			if (injected) {
				log(text, "RAW-INPUT");
				return { block: true, reason: injected };
			}
		}

		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command || "";
		const caps = callerCaps(pi);
		for (const seg of segments(command)) {
			const reason = inspect(seg, caps);
			if (reason) {
				log(command, reason.slice(0, 3));
				return { block: true, reason: `${reason} (blocked segment: "${seg.slice(0, 80)}")` };
			}
		}
	});
}

export default function (pi: ExtensionAPI): void {
	try {
		register(pi);
	} catch (error) {
		hookLog("command-guard", "register-failed", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}
