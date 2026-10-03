/**
 * focus-state.probe — the executable probe for the focus-mode state contract.
 *
 * Run: `node --experimental-strip-types focus-state.probe.ts` from `packages/focus-state`.
 *
 * Every consumer of focus mode reads this one file and this one ledger naming, so a
 * silent change here reaches the gate, the footer and the notifications at once. Two
 * properties matter and neither was checked: the older mode names a state file may
 * still carry must keep resolving to the current set (a session that reads `quiet` as
 * unknown would silently un-gate), and the release clear must remove every session's
 * ledger WITHOUT touching the mode itself.
 *
 * `XDG_RUNTIME_DIR` points at a scratch directory before the module is imported — the
 * state path is computed at import — so the machine's own focus state is never read,
 * never written and never cleared.
 *
 * Cases: the absent file, the current names, the three older names, an unknown name,
 * a state file that is not an object, a broken file, the `since` field, the ledger
 * naming (sanitised owner, a session with no id, the pid), which files the clear
 * matches, the clear's count and idempotence, and that the state file survives it.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "pi-focus-state-probe-"));
process.env.XDG_RUNTIME_DIR = scratch;

const {
	clearFocusLedgers,
	FOCUS_STATE_PATH,
	focusActive,
	focusLedgerFiles,
	focusLedgerPathFor,
	readFocusState,
} = await import("./focus-state.ts");

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

function writeState(body: string): void {
	writeFileSync(FOCUS_STATE_PATH, body);
}

console.log("the state the file describes");
check(
	"the state path is the scratch runtime directory",
	FOCUS_STATE_PATH.startsWith(scratch),
	FOCUS_STATE_PATH,
);
check("an absent file reads as off", readFocusState().mode === "off");
check("and is not active", focusActive(readFocusState()) === false);

writeState(JSON.stringify({ mode: "on", since: "probe" }));
check("the current name on is read", readFocusState().mode === "on");
check("and gates", focusActive(readFocusState()) === true);
check("the since field is carried", readFocusState().since === "probe");

console.log("the older names still resolve");
writeState(JSON.stringify({ mode: "quiet" }));
check("quiet means the gate is on", readFocusState().mode === "on");
check("and reports as active", focusActive() === true);
writeState(JSON.stringify({ mode: "locked" }));
check("locked means the gate is on", readFocusState().mode === "on");
writeState(JSON.stringify({ mode: "full" }));
check("full means the gate is off", readFocusState().mode === "off");
check("and does not report as active", focusActive() === false);
writeState(JSON.stringify({ mode: "off" }));
check("off is read", readFocusState().mode === "off");

console.log("what a bad file reads as");
writeState(JSON.stringify({ mode: "sideways" }));
check("an unknown name is off, never a new mode", readFocusState().mode === "off");
writeState("not json at all");
check("a broken file is off", readFocusState().mode === "off");
writeState(JSON.stringify({ since: "no mode field" }));
check("a file with no mode is off", readFocusState().mode === "off");
writeState(JSON.stringify({ mode: "on\x00" }));
check("a name with junk is off", readFocusState().mode === "off");

console.log("the ledger naming");
const mine = focusLedgerPathFor("probe-session");
check("the ledger is named for its owner", mine.includes("probe-session"), mine);
check("and carries this process's pid", mine.includes(String(process.pid)), mine);
check("it lives in the runtime directory", mine.startsWith(scratch));
check(
	"an owner with characters the name cannot hold is sanitised",
	focusLedgerPathFor("a/b c.d").includes("abcd"),
	focusLedgerPathFor("a/b c.d"),
);
check(
	"a session with no id falls back to its pid",
	focusLedgerPathFor(null).includes("nosid"),
	focusLedgerPathFor(null),
);

console.log("the release clear");
writeFileSync(mine, "row\n");
writeFileSync(focusLedgerPathFor("another-session"), "row\n");
writeFileSync(join(scratch, "unrelated.txt"), "not a ledger\n");
writeFileSync(FOCUS_STATE_PATH, JSON.stringify({ mode: "on", since: "probe" }));
const listed = focusLedgerFiles();
check(
	"every focus ledger in the directory is listed",
	listed.length === 2,
	`${listed.length} files`,
);
check(
	"and nothing else is",
	listed.every((file) => file.includes(".ledger.jsonl")),
	listed.join(","),
);
check("the clear removes both", clearFocusLedgers() === 2);
check("and leaves no ledger behind", focusLedgerFiles().length === 0);
check("a second clear has nothing to remove", clearFocusLedgers() === 0);
check("an unrelated file is untouched", existsSync(join(scratch, "unrelated.txt")));
check("and the mode itself survives the clear", existsSync(FOCUS_STATE_PATH));
check("still reading as on", JSON.parse(readFileSync(FOCUS_STATE_PATH, "utf8")).mode === "on");

rmSync(scratch, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`focus-state probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`focus-state probe passed: ${checks} checks`);
