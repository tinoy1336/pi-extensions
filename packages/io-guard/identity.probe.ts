/**
 * identity.probe — the executable probe for the worker claim.
 *
 * Run: `node --experimental-strip-types identity.probe.ts` from `packages/io-guard`.
 *
 * Two decisions live here and both are load-bearing. A binding is read into an
 * identity only when exactly one fleet-namespace key is present, and the claim file
 * decides which process may act as that worker: a live holder is honoured, a
 * provably dead one is taken over, and an unreadable record is reclaimed only once
 * it is old enough to be wreckage. A silent break in either direction is the
 * dangerous kind — two processes writing as one worker, or a resumed worker locked
 * out by a predecessor that will never run again.
 *
 * Everything runs against a scratch root passed to `claimProcessIdentity`, so no
 * real claim tree is touched. Cases: the binding reader (one key, no key, two keys,
 * a non-fleet key, a blank worker, the list filters), the resolution gate, the
 * kernel start-time reader, the claim itself (free name, re-entrant claim, a live
 * holder, a dead holder, fresh debris, stale debris) and the liveness read.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimProcessIdentity,
	identityClaimLive,
	identityFromBindings,
	procStartTime,
	resolveIdentity,
	type WorkerIdentity,
} from "./identity.ts";

const root = mkdtempSync(join(tmpdir(), "pi-io-guard-probe-"));
const runtime = join(root, "runtime");

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

function mine(worker: string): WorkerIdentity {
	return {
		worker,
		scope: "",
		owns: [],
		exclusive: [],
		pid: process.pid,
		procStart: procStartTime(process.pid),
		resolvedAt: Date.now(),
	};
}

/** Pre-place a claim record so the next claim meets a holder it did not create. */
function placeClaim(worker: string, record: unknown | string): void {
	mkdirSync(runtime, { recursive: true });
	const file = join(runtime, `${worker}.json`);
	writeFileSync(file, typeof record === "string" ? record : JSON.stringify(record));
}

console.log("identityFromBindings");
const valid = identityFromBindings(
	JSON.stringify({ "fleet/1": { worker: "w", scope: "s", owns: ["a", "b"], exclusive: ["c"] } }),
	4242,
);
check("one fleet binding yields the worker", valid?.worker === "w", String(valid?.worker));
check("the scope is carried", valid?.scope === "s");
check("owns is carried", JSON.stringify(valid?.owns) === JSON.stringify(["a", "b"]));
check("exclusive is carried", JSON.stringify(valid?.exclusive) === JSON.stringify(["c"]));
check("the pid is carried", valid?.pid === 4242);
check("no bindings is no identity", identityFromBindings(undefined, 1) === null);
check("unparseable bindings are refused", identityFromBindings("{", 1) === null);
check(
	"a binding in another namespace identifies nothing",
	identityFromBindings(JSON.stringify({ other: { worker: "w" } }), 1) === null,
);
check(
	"two fleet bindings are ambiguous and refused",
	identityFromBindings(
		JSON.stringify({ "fleet/1": { worker: "a" }, "fleet/2": { worker: "b" } }),
		1,
	) === null,
);
check(
	"fleet/0 is not a fleet namespace",
	identityFromBindings(JSON.stringify({ "fleet/0": { worker: "w" } }), 1) === null,
);
check(
	"a blank worker is refused",
	identityFromBindings(JSON.stringify({ "fleet/1": { worker: "  " } }), 1) === null,
);
check(
	"a missing worker is refused",
	identityFromBindings(JSON.stringify({ "fleet/1": { scope: "s" } }), 1) === null,
);
const filtered = identityFromBindings(
	JSON.stringify({ "fleet/1": { worker: "w", owns: [1, "a"], exclusive: "c", scope: 7 } }),
	1,
);
check(
	"only string entries survive the list filters",
	JSON.stringify(filtered?.owns) === JSON.stringify(["a"]),
);
check(
	"a non-list exclusive becomes empty",
	JSON.stringify(filtered?.exclusive) === JSON.stringify([]),
);
check("a non-string scope becomes empty", filtered?.scope === "");

console.log("resolveIdentity");
check("a process without the child marker has no identity", resolveIdentity({}) === null);
check(
	"a process without the bindings has no identity",
	resolveIdentity({ PI_SUBAGENT_CHILD: "1" }) === null,
);
const resolved = resolveIdentity({
	PI_SUBAGENT_CHILD: "1",
	PI_SUBAGENT_EXTENSION_BINDINGS: JSON.stringify({ "fleet/1": { worker: "w" } }),
});
check("the marker plus one binding resolves", resolved?.worker === "w", String(resolved?.worker));
check("resolution uses this process's pid", resolved?.pid === process.pid);
check(
	"a malformed binding under the marker resolves to nothing",
	resolveIdentity({ PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_EXTENSION_BINDINGS: "nope" }) === null,
);

console.log("the kernel start time");
check(
	"a live pid has one",
	typeof procStartTime(process.pid) === "string",
	String(procStartTime(process.pid)),
);
check("an unused pid has none", procStartTime(4_000_000) === null);

console.log("the claim");
check("a free worker name is claimed", claimProcessIdentity(root, mine("probe-free")) === true);
check(
	"the claim lands as this worker's runtime record",
	existsSync(join(runtime, "probe-free.json")),
);
claimProcessIdentity(root, mine("probe-reentrant"));
check(
	"re-claiming as the same process is still mine",
	claimProcessIdentity(root, mine("probe-reentrant")) === true,
);

placeClaim("probe-live", { pid: 1, procStart: procStartTime(1), at: Date.now() });
check("a live holder is honoured", claimProcessIdentity(root, mine("probe-live")) === false);

placeClaim("probe-dead", { pid: 4_000_000, procStart: null, at: Date.now() });
check("a dead holder is taken over", claimProcessIdentity(root, mine("probe-dead")) === true);

placeClaim("probe-fresh-debris", "{ not json");
check(
	"fresh unreadable debris is not reclaimed",
	claimProcessIdentity(root, mine("probe-fresh-debris")) === false,
);

placeClaim("probe-stale-debris", "{ not json");
const stale = join(runtime, "probe-stale-debris.json");
const old = Date.now() / 1000 - 120;
utimesSync(stale, old, old);
check(
	"stale unreadable debris is reclaimed",
	claimProcessIdentity(root, mine("probe-stale-debris")) === true,
);

console.log("identityClaimLive");
check("an absent record is not live", identityClaimLive(root, "probe-absent") === false);
check("this process's record is live", identityClaimLive(root, "probe-free") === true);
placeClaim("probe-live-check", { pid: 4_000_000, procStart: null, at: Date.now() });
check("a dead pid's record is not live", identityClaimLive(root, "probe-live-check") === false);
placeClaim("probe-ownerless", { procStart: null, at: Date.now() });
check("a record with no pid is not live", identityClaimLive(root, "probe-ownerless") === false);

rmSync(root, { recursive: true, force: true });

console.log("");
if (failures > 0) {
	console.error(`identity probe failed: ${failures} of ${checks} checks`);
	process.exit(1);
}
console.log(`identity probe passed: ${checks} checks`);
