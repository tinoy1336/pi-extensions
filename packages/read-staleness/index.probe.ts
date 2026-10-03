/**
 * index.probe — the executable probe for the repeat-read stub.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/read-staleness`.
 *
 * This decides whether a repeat full read is answered with a one-line stub instead
 * of the file body. Both errors are costly and quiet: stubbing a read whose body the
 * model no longer has costs it the file, and failing to stub a large repeat read
 * costs context on every turn. The decision is not exported, so the probe drives the
 * extension the way pi does — a recorder captures the `tool_result` handler, which
 * returns replacement content when it stubs and nothing when it does not.
 *
 * `HOME` points at a scratch directory before the module is imported, because a stub
 * writes a diagnostics row. Each case gets its OWN file: the memory is keyed by path
 * and one case's reads must not decide another's.
 *
 * Cases: the first read (never stubbed), then two stubs and a fourth read in full
 * again (the allowance the rule carries), the stub naming what it withheld, a partial
 * read, a file below the size floor, a file whose size changed, an error result,
 * another tool, a read with no path, and the session events that clear the memory so
 * a stub cannot outlive the context that justified it.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-read-staleness-probe-"));
process.env.HOME = scratch;

const { default: readStaleness } = await import("./index.ts");

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

type Handler = (event: unknown) => unknown;

const handlers = new Map<string, Handler>();
const api = {
	on: (name: string, handler: Handler) => handlers.set(name, handler),
	registerTool: () => {},
	registerCommand: () => {},
	getActiveTools: () => [],
	setActiveTools: () => {},
	appendEntry: () => {},
	events: { on: () => {}, emit: () => {} },
};
readStaleness(api as never);

const registeredResult = handlers.get("tool_result");
const registeredStart = handlers.get("session_start");
if (!registeredResult) throw new Error("the extension registered no tool_result handler");
if (!registeredStart) throw new Error("the extension registered no session_start handler");
const onResult: Handler = registeredResult;
const onStart: Handler = registeredStart;

let caseNumber = 0;
/** A fresh path per case: the memory is keyed by path. */
function file(chars: number): string {
	caseNumber += 1;
	const path = join(scratch, `case-${caseNumber}.txt`);
	writeFileSync(path, "x".repeat(chars));
	return path;
}

/** One read event; the body it carries matches the file's current size. */
function read(path: string, options: { partial?: boolean; isError?: boolean } = {}): unknown {
	return onResult({
		toolName: "read",
		input: options.partial === true ? { path, offset: 0, limit: 10 } : { path },
		content: [{ type: "text", text: "x".repeat(statSync(path).size) }],
		isError: options.isError === true,
	});
}

function stubbed(result: unknown): boolean {
	const content = (result as { content?: Array<{ text?: string }> } | undefined)?.content;
	return typeof content?.[0]?.text === "string" && content[0].text.startsWith("unchanged —");
}

console.log("the allowance the rule carries");
const counted = file(5000);
const first = read(counted);
check("the first full read is returned in full", !stubbed(first));
const second = read(counted);
check("the second is stubbed", stubbed(second));
check(
	"the stub names the size it withheld and tells the reader how to get the body",
	JSON.stringify(second ?? null).includes("5000 bytes") &&
		JSON.stringify(second).includes("offset/limit"),
	JSON.stringify(second ?? null).slice(0, 70),
);
check("the third is stubbed too", stubbed(read(counted)));
check("the fourth is returned in full again", !stubbed(read(counted)));

console.log("what is never stubbed");
const partial = file(5000);
check("a partial read is not stubbed", !stubbed(read(partial, { partial: true })));
check("and it is not remembered for the next full read", !stubbed(read(partial)));
const tiny = file(500);
check(
	"a file below the size floor is not stubbed twice running",
	!stubbed(read(tiny)) && !stubbed(read(tiny)),
);

const grown = file(5000);
check("a first read of a grown file is full", !stubbed(read(grown)));
writeFileSync(grown, "y".repeat(6000));
check("a file whose size changed is not stubbed", !stubbed(read(grown)));
check("and the memory now holds the new size", stubbed(read(grown)));

const failed = file(5000);
read(failed);
check("an error result is not stubbed", !stubbed(read(failed, { isError: true })));
check(
	"another tool is not stubbed",
	!stubbed(
		onResult({
			toolName: "grep",
			input: { path: failed },
			content: [{ type: "text", text: "x".repeat(5000) }],
		}),
	),
);
check(
	"a read with no path is not stubbed",
	!stubbed(
		onResult({ toolName: "read", input: {}, content: [{ type: "text", text: "x".repeat(5000) }] }),
	),
);

console.log("the memory is cleared when the context it describes is gone");
const cleared = file(5000);
read(cleared);
check("the repeat is stubbed before the clear", stubbed(read(cleared)));
onStart({});
check("a session start forgets the file", !stubbed(read(cleared)));

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`read-staleness probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`read-staleness probe passed: ${checks} checks`);
