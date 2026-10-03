/**
 * command-guard.probe — the executable probe for the redirect classifier.
 *
 * Run: `node --experimental-strip-types command-guard.probe.ts` from `packages/command-guard`.
 *
 * This is the gate that decides whether a bash call is blocked, so a silent change
 * to any rule either lets a raw dump into the context or blocks a sanctioned
 * pipeline. Every function it exercises is pure — a command string in, a reason or
 * `null` out — so the probe is a table of commands rather than a session.
 *
 * Cases: `segments` (the split the gate iterates), the R1 file-read family and its
 * exemptions, the grep/rg branch (listing mode, content-free output, stdin, an
 * explicit path, recursion, a restricting stage versus a reshaping one, globs), the
 * R2 build family and the two exemptions that keep its output out of the context,
 * the wrapper prefix handling, the capability-dependent wording, the RAW-INPUT
 * invocation match with its marker, and `callTexts` for every tool that can reach
 * the binary.
 */
import { callTexts, type GuardCaps, inspect, inspectInjection, segments } from "./index.ts";

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

/** A blocked segment, shown by the rule it was blocked under. */
function rule(seg: string, caps?: GuardCaps): string {
	const reason = inspect(seg, caps);
	return reason === null ? "allowed" : reason.slice(0, reason.indexOf(":")) || reason.slice(0, 12);
}

console.log("segments");
check(
	"the gate iterates every && || ; and newline segment",
	JSON.stringify(segments("a && b || c; d\ne")) === JSON.stringify(["a", "b", "c", "d", "e"]),
	JSON.stringify(segments("a && b || c; d\ne")),
);
check(
	"segments are trimmed and empty ones dropped",
	JSON.stringify(segments("  ls  ||  ")) === JSON.stringify(["ls"]),
);
check("an empty command has no segments", segments("").length === 0);

console.log("R1 — file content read through bash");
check("cat with an operand is blocked", rule("cat file") === "R1", rule("cat file"));
check("cat with no operand passes", rule("cat") === "allowed", rule("cat"));
check("head with an operand is blocked", rule("head -5 file") === "R1", rule("head -5 file"));
check("tail with an operand is blocked", rule("tail -5 file") === "R1", rule("tail -5 file"));
check("tail -f passes", rule("tail -f log") === "allowed", rule("tail -f log"));
check(
	"sed -n with a line range is blocked",
	rule("sed -n '1,5p' file") === "R1",
	rule("sed -n '1,5p' file"),
);
check(
	"sed with a substitution passes",
	rule("sed 's/a/b/' file") === "allowed",
	rule("sed 's/a/b/' file"),
);
check(
	"a transforming stage after cat passes",
	rule("cat file | sort") === "allowed",
	rule("cat file | sort"),
);
check(
	"a redirect into /tmp does not exempt an R1 read",
	rule("cat file > /tmp/out") === "R1",
	rule("cat file > /tmp/out"),
);
check("a variable operand passes", rule("cat $FILE") === "allowed", rule("cat $FILE"));
check("an input redirect passes", rule("grep x < file") === "allowed", rule("grep x < file"));

console.log("R1 — grep and rg");
check(
	"rg --files is listing mode and passes",
	rule("rg --files") === "allowed",
	rule("rg --files"),
);
check(
	"grep -c passes (content-free output)",
	rule("grep -c x file") === "allowed",
	rule("grep -c x file"),
);
check(
	"grep -l passes (file names only)",
	rule("grep -l x file") === "allowed",
	rule("grep -l x file"),
);
check("grep with no path reads stdin and passes", rule("grep x") === "allowed", rule("grep x"));
check(
	"a recursive grep with no path is blocked",
	rule("grep -rn x .") === "R1",
	rule("grep -rn x ."),
);
check(
	"rg over an explicit path is blocked",
	rule("rg -n x packages") === "R1",
	rule("rg -n x packages"),
);
check(
	"a glob operand does not exempt grep",
	rule("grep -rn x *.ts") === "R1",
	rule("grep -rn x *.ts"),
);
check(
	"a restricting stage (head) exempts grep",
	rule("rg -n x packages | head -20") === "allowed",
	rule("rg -n x packages | head -20"),
);
check(
	"a reshaping stage (sort) does not exempt grep",
	rule("rg -n x packages | sort") === "R1",
	rule("rg -n x packages | sort"),
);
check("a glob operand exempts a plain read", rule("cat *.ts") === "allowed", rule("cat *.ts"));

console.log("R2 — raw build and checker output");
check("npx tsc is blocked", rule("npx tsc") === "R2", rule("npx tsc"));
check("npm run build is blocked", rule("npm run build") === "R2", rule("npm run build"));
check("makepkg is blocked", rule("makepkg -si") === "R2", rule("makepkg -si"));
check("go build is blocked", rule("go build ./...") === "R2", rule("go build ./..."));
check("npx eslint is blocked", rule("npx eslint .") === "R2", rule("npx eslint ."));
check(
	"a filtering stage exempts the build output",
	rule("npx tsc 2>&1 | grep -E 'error TS' | head -20") === "allowed",
	rule("npx tsc 2>&1 | grep -E 'error TS' | head -20"),
);
check(
	"a /tmp redirect exempts the build output",
	rule("npx tsc > /tmp/out.txt") === "allowed",
	rule("npx tsc > /tmp/out.txt"),
);
check(
	"a wrapper and its duration are skipped before the command",
	rule("timeout 300 npx tsc") === "R2",
	rule("timeout 300 npx tsc"),
);
check(
	"an env assignment is skipped before the command",
	rule("env FOO=1 npx tsc") === "R2",
	rule("env FOO=1 npx tsc"),
);
check(
	"a sudo prefix still inspects the command it runs",
	rule("sudo cat file") === "R1",
	rule("sudo cat file"),
);
check(
	"sudo with its own options is unclassifiable and passes",
	rule("sudo -u user cat file") === "allowed",
	rule("sudo -u user cat file"),
);

console.log("the wording follows the calling session's own tools");
const generic = inspect("rg -n x packages");
const noGrep = inspect("rg -n x packages", { grep: false, build: false });
check(
	"both shapes state the R1 rule",
	(generic ?? "").startsWith("R1") && (noGrep ?? "").startsWith("R1"),
);
check("the two shapes differ", generic !== noGrep);
check(
	"a session with no grep tool is not told to use one",
	!(noGrep ?? "").includes("use the grep tool"),
);
check("a session with grep is told to use it", (generic ?? "").includes("grep tool"));
check(
	"the build reason names the build tool only when the session has it",
	!(inspect("npx tsc") ?? "").includes("build tool"),
);
check(
	"and does name it when it does",
	(inspect("npx tsc", { grep: true, build: true }) ?? "").includes("use the build tool"),
);

console.log("RAW-INPUT");
check("a raw binary invocation is blocked", inspectInjection("ydotool click 0x40") !== null);
check("a sudo-prefixed invocation is blocked", inspectInjection("sudo ydotool key 29") !== null);
check(
	"an absolute path invocation is blocked",
	inspectInjection("/usr/bin/ydotool type hi") !== null,
);
check(
	"an invocation after a separator is blocked",
	inspectInjection("echo x ; ydotool click 0x40") !== null,
);
check(
	"sandboxed code is inspected too",
	inspectInjection("execSync('ydotool click 0x40')") !== null,
);
check(
	"the marker escapes a deliberate invocation",
	inspectInjection("ydotool click 0x40 raw-ydotool-ok") === null,
);
check("only the name, not an invocation, passes", inspectInjection("command -v ydotool") === null);
check("a stop signal naming the binary passes", inspectInjection("pkill -f ydotool") === null);
check("the daemon's longer token never matches", inspectInjection("ydotoold click") === null);

console.log("callTexts");
check(
	"bash yields its command",
	JSON.stringify(callTexts("bash", { command: "ls" })) === JSON.stringify(["ls"]),
);
check("bash with no command yields nothing", callTexts("bash", {}).length === 0);
check(
	"bash with a non-string command yields nothing",
	callTexts("bash", { command: 7 }).length === 0,
);
check(
	"ctx_execute yields its code",
	JSON.stringify(callTexts("ctx_execute", { code: "x" })) === JSON.stringify(["x"]),
);
check(
	"ctx_batch_execute yields every command and the code",
	JSON.stringify(
		callTexts("ctx_batch_execute", { commands: [{ command: "a" }, { command: "b" }], code: "c" }),
	) === JSON.stringify(["a", "b", "c"]),
);
check(
	"ctx_execute_file yields its code",
	JSON.stringify(callTexts("ctx_execute_file", { code: "x" })) === JSON.stringify(["x"]),
);
check(
	"a tool that cannot reach a shell yields nothing",
	callTexts("read", { command: "ls" }).length === 0,
);

console.log("");
if (failures > 0) {
	console.error(`command-guard probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`command-guard probe passed: ${checks} checks`);
