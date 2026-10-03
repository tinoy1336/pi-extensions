/**
 * index.probe — the executable probe for the focus gate.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/focus-gate`.
 *
 * The gate decides whether a session may touch the desktop while the operator is
 * away, and its matcher is not exported, so the probe drives the extension the way
 * pi does: a recorder stands in for the API, the extension is handed it, and the
 * captured `tool_call` handler is invoked with a tool name and an input.
 *
 * `XDG_RUNTIME_DIR` points at a scratch directory before the module is imported —
 * the state file's path is computed at import — and the probe writes the mode into
 * that scratch state itself. The machine's own focus state is never read and never
 * changed, and the ledger a block writes lands in the scratch directory.
 *
 * Cases: every pattern family the table carries (compositor state, screenshots,
 * input takeover in both its raw and wrapper forms, app spawns, terminal emulators
 * at command position, the build-only exemption), the work the gate must leave
 * alone, the three routes a gated action can arrive through besides bash, and the
 * off mode that makes the whole gate a no-op. Plus the ledger a block leaves.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtime = mkdtempSync(join(tmpdir(), "pi-focus-probe-"));
process.env.XDG_RUNTIME_DIR = runtime;
// The diagnostics envelope resolves its path from HOME at import, and a block writes
// a row to it: pointing HOME at the scratch directory keeps the machine's own hook
// log out of this.
process.env.HOME = runtime;
const statePath = join(runtime, "pi-focus.json");

function setMode(mode: "on" | "off"): void {
	mkdirSync(runtime, { recursive: true });
	writeFileSync(statePath, JSON.stringify({ mode, since: "probe" }));
}

setMode("on");

const { default: focusGate } = await import("./index.ts");

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

type Handler = (event: unknown, ctx: unknown) => unknown;
type Call = (toolName: string, input: unknown) => Promise<string | undefined>;

/** The gate, as pi calls it: fresh state read per tool call, refusal or nothing. */
function gate(): Call {
	const handlers = new Map<string, Handler>();
	const api = {
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		registerTool: () => {},
		registerCommand: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		appendEntry: () => {},
		events: { on: () => {}, emit: () => {} },
		ui: { setStatus: () => {}, notify: () => {} },
	};
	focusGate(api as never);

	const handler = handlers.get("tool_call");
	if (!handler) throw new Error("the extension registered no tool_call handler");

	return async (toolName: string, input: unknown): Promise<string | undefined> => {
		const result = (await handler({ toolName, input }, {})) as
			| { block?: boolean; reason?: string }
			| undefined;
		return result?.block === true ? result.reason : undefined;
	};
}

const call = gate();

async function blocked(
	name: string,
	toolName: string,
	input: unknown,
	fragment?: string,
): Promise<void> {
	const reason = await call(toolName, input);
	const named = fragment === undefined ? true : (reason ?? "").includes(fragment);
	check(
		name,
		typeof reason === "string" && named,
		reason === undefined ? "allowed" : reason.slice(0, 60) || "empty",
	);
}

async function allowed(name: string, toolName: string, input: unknown): Promise<void> {
	const reason = await call(toolName, input);
	check(name, reason === undefined, reason?.slice(0, 60));
}

console.log("FOCUS MODE ON — the gate refuses a desktop action");
await blocked(
	"a compositor dispatch",
	"bash",
	{ command: "hyprctl dispatch 'hl.dsp.focus({workspace=1})'" },
	"Hyprland",
);
await blocked(
	"a compositor keyword write",
	"bash",
	{ command: "hyprctl keyword general:gaps_out 5" },
	"Hyprland",
);
await blocked("a screenshot", "bash", { command: "grim -o - " }, "grim");
await blocked("another screenshot tool", "bash", { command: "grimblast copy area" }, "grim");
await blocked("raw input takeover", "bash", { command: "ydotool click 40" }, "inject");
await blocked(
	"input takeover through the wrapper",
	"bash",
	{ command: "inject click left --at 640 240" },
	"inject",
);
await blocked(
	"an app spawn through gtk-launch",
	"bash",
	{ command: "gtk-launch foo" },
	"gtk-launch",
);
await blocked(
	"a terminal emulator at command position",
	"bash",
	{ command: "kitty -e htop" },
	"terminal emulator",
);
await blocked(
	"a terminal emulator behind a wrapper",
	"bash",
	{ command: "timeout 120 kitty" },
	"terminal emulator",
);
await blocked(
	"an app launch through the shell runner",
	"bash",
	{ command: "common/shell/run.sh files" },
	"AGS",
);
await blocked("an app launch through ags run", "bash", { command: "ags run foo" }, "AGS");
await blocked(
	"an app open through the route script",
	"bash",
	{ command: "ags-route.sh open files" },
	"AGS",
);
const refusal = await call("bash", { command: "grim -" });
check(
	"the refusal names the mode",
	(refusal ?? "").includes("FOCUS MODE (ON) ACTIVE"),
	refusal?.slice(0, 40),
);
check("and tells the reader not to retry", (refusal ?? "").includes("Do NOT retry"));
check("and names the ledger it queued the action to", (refusal ?? "").includes(runtime));

console.log("FOCUS MODE ON — the work the gate leaves alone");
await allowed("a listing", "bash", { command: "ls -la" });
await allowed("a notification", "bash", { command: 'notify-send -u normal "heads up" "text"' });
await allowed("a user-service restart", "bash", {
	command: "systemctl --user restart wireplumber",
});
await allowed("a search", "bash", { command: "rg -n x packages" });
await allowed("a checker run", "bash", { command: "npm run lint" });
await allowed("a terminal named in a read-only position", "bash", {
	command: "find kitty -type f && ls",
});
await allowed("a build-only bundle form", "bash", {
	command: "AGS_BUNDLE_WARM=1 common/shell/run.sh files",
});

console.log("FOCUS MODE ON — the other routes to a desktop action");
await blocked(
	"sandboxed code is inspected",
	"ctx_execute",
	{ code: "await ctx_execute('hyprctl dispatch x')" },
	"Hyprland",
);
await blocked(
	"every batch command is inspected",
	"ctx_batch_execute",
	{ commands: [{ command: "ls" }, { command: "grim -" }] },
	"grim",
);
await blocked(
	"a probe reaches the compositor too",
	"probe",
	{ hyprctl: true, target: "dispatch x" },
	"Hyprland",
);
await allowed("a read-only probe target passes", "probe", { hyprctl: true, target: "clients" });
await allowed("a probe without the compositor flag passes", "probe", { unit: "wireplumber" });

console.log("the ledger a block leaves");
const ledgerPath = (refusal ?? "").match(/queued to (.+?)\. /)?.[1];
check(
	"the refusal names the ledger the action was queued to, inside the runtime directory",
	typeof ledgerPath === "string" && ledgerPath.startsWith(runtime),
	String(ledgerPath),
);
if (ledgerPath === undefined) {
	console.error("focus-gate probe cannot continue without the ledger path the refusal named");
	process.exit(1);
}
const rows = (): number => readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length;
const rowsBefore = rows();
await call("bash", { command: "grim -" });
check(
	"a blocked call appends exactly one ledger row",
	rows() === rowsBefore + 1,
	`${rowsBefore} then ${rows()}`,
);
check("every earlier block left its row too", rowsBefore > 5, `${rowsBefore} rows`);

console.log("FOCUS MODE OFF — the gate is a no-op");
setMode("off");
await allowed("a screenshot passes", "bash", { command: "grim -" });
await allowed("a compositor dispatch passes", "bash", { command: "hyprctl dispatch x" });
await allowed("input takeover passes", "bash", { command: "inject click left" });

rmSync(runtime, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`focus-gate probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`focus-gate probe passed: ${checks} checks`);
