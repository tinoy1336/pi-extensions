/**
 * index.probe — the executable probe for the cli-keys cache watcher and hydration.
 *
 * Run: `node --experimental-strip-types index.probe.ts` from `packages/cli-keys`.
 *
 * Two properties this package owns and no workspace gate read. First, hydration: a
 * generation on disk reaches the process environment, and a generation committed by
 * ANOTHER writer reaches it too — that is what the cache watch is for, and it is the
 * only reason the watch exists. Second, the process it runs in must still be able to
 * EXIT: a ref'd directory watch keeps the event loop alive, so a scripted run that had
 * already printed its answer sat in the kernel on that watch and never returned.
 *
 * Both are asserted here against a real child process, because only a real process
 * proves the second one: the child loads the extension's own startup path, hydrates,
 * commits a second generation and reports whether the watch delivered it, then returns
 * and must drain. The parent bounds the wait and reads the exit — a child that had to
 * be killed is a failure, and one that never armed the watch fails the delivery check,
 * so neither disabling the feature nor leaving the handle ref'd passes.
 *
 * No model call, no network and no vault: `CLI_KEYS_SCRIPT` points at a scratch stub
 * that answers `cache-path` and `ensure --json` itself, and every path the child
 * touches (the cache, the diagnostics log, the agent directory) is under the scratch
 * directory, so the machine's own cache is never read and never written.
 *
 * Cases: the cache the script names, the first generation hydrated into the
 * environment, the watch delivering a second generation committed while the process
 * runs, and the process exiting on its own once the run is over.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SELF = fileURLToPath(import.meta.url);

/** How long a child run may take before it is killed and reported as a hang. */
const CHILD_BOUND_MS = 30_000;

/** The environment name the fixture's cache carries; identifier-shaped, as hydration requires. */
const KEY_NAME = "PROBE_CLI_KEY";

// ── the child: the extension's own startup, driven against a recorder ─────────────────

/**
 * One run of the extension the way a session starts it: the factory against a recorder
 * playing pi's role, then the start hook. The watch is armed by the factory, so the
 * second generation below is committed AFTER it exists — which is the only order that
 * proves the watch is live rather than merely present.
 */
async function startup(cachePath: string): Promise<void> {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const api = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: () => {},
	};
	const ctx = { ui: { notify: () => {} }, sessionManager: { getSessionId: () => "probe-session" } };

	const mod = await import("./index.ts");
	mod.default(api as unknown as ExtensionAPI);

	console.log(`cache ${mod.CACHE_PATH}`);
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	console.log(`hydrated ${KEY_NAME}=${process.env[KEY_NAME] ?? "(nothing)"}`);

	// A generation committed by another writer: the watcher is the only thing that can
	// bring it into this process, and hydration of it never runs the fetch.
	writeFileSync(
		cachePath,
		JSON.stringify({ expires_epoch: 4_000_000_000, keys: { [KEY_NAME]: "second" } }),
	);
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && process.env[KEY_NAME] !== "second") {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	console.log(`changed ${KEY_NAME}=${process.env[KEY_NAME] ?? "(nothing)"}`);
	console.log("child done");
}

// ── the parent: one bounded child run, then the exit it produced ──────────────────────

async function driver(): Promise<void> {
	const scratch = mkdtempSync(join(tmpdir(), "pi-cli-keys-probe-"));
	const home = join(scratch, "home");
	const cachePath = join(scratch, "state", "cli-keys.json");
	const stub = join(scratch, "cli-keys");
	mkdirSync(join(scratch, "state"), { recursive: true });
	mkdirSync(home, { recursive: true });
	// The stub owns the cache path and answers both calls the extension makes; nothing
	// here reaches the machine's script, cache or vault.
	writeFileSync(
		stub,
		`#!/bin/sh\ncase "$1" in\n  cache-path) echo "${cachePath}" ;;\n  ensure) echo '{"outcome":"fresh"}' ;;\nesac\nexit 0\n`,
	);
	chmodSync(stub, 0o755);
	writeFileSync(
		cachePath,
		JSON.stringify({ expires_epoch: 4_000_000_000, keys: { [KEY_NAME]: "first" } }),
	);

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

	const child = spawnSync(
		process.execPath,
		["--experimental-strip-types", SELF, "startup", cachePath],
		{
			env: {
				...process.env,
				CLI_KEYS_SCRIPT: stub,
				HOME: home,
				PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
				XDG_STATE_HOME: join(scratch, "state"),
			},
			// No inherited stdin: a child that asked for input would wait forever.
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			timeout: CHILD_BOUND_MS,
		},
	);
	const out = child.stdout ?? "";
	const timedOut = child.error !== undefined && child.signal === "SIGTERM";

	console.log("the extension's own startup path");
	check(
		"the script's cache path is the one the extension uses",
		out.includes(`cache ${cachePath}`),
		out.trim().split("\n")[0] ?? "",
	);
	check("the first generation reached the environment", out.includes(`hydrated ${KEY_NAME}=first`));

	console.log("the watch, while the process runs");
	check(
		"a generation committed by another writer reached the process",
		out.includes(`changed ${KEY_NAME}=second`),
		(out.match(/changed .*/) ?? ["(no line)"])[0],
	);

	console.log("the process the extension runs in");
	check(
		"the child ran to its own end",
		child.status === 0 && out.includes("child done"),
		`exit=${child.status} signal=${child.signal ?? "none"}`,
	);
	check(
		"and the process exited without being killed",
		!timedOut,
		timedOut ? `still alive after ${CHILD_BOUND_MS} ms` : "exited on its own",
	);

	rmSync(scratch, { recursive: true, force: true });

	console.log("");
	if (failures > 0) {
		console.error(`cli-keys probe failed: ${failures} of ${checks} checks`);
		process.exit(1);
	}
	console.log(`cli-keys probe passed: ${checks} checks`);
}

if (process.argv[2] === "startup") {
	await startup(process.argv[3] ?? "");
} else {
	await driver();
}
