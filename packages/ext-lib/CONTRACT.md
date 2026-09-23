# Degradation contract

What every package in this monorepo must do so that a consumer can install ANY SUBSET
and get no fatal error from what they did NOT install. Working extensions are documented
as caveats (see "Declaring a caveat"); a missing extension is never a hard dependency, a
thrown error, or a silent no-op.

This file is normative. It refines the planning document's contract section in two
places, both recorded here so the lanes implement one shape:

- the neighbour cache is keyed by `(source, neighbour)` — a resolution per reporting
  package and neighbour, not one slot per module, so one package's absent neighbour can
  never mask another's present one;
- a caveat is a **table row with four fixed columns** ("Declaring a caveat"), not free
  prose, so the checker can enforce it.

Check your package against it with:

```bash
node --experimental-strip-types packages/ext-lib/src/neighbour.probe.ts   # the helper's own probe
node scripts/check-caveats.mjs                                            # caveat declarations
```

## R1 — A module body does no work and cannot throw

No I/O, no spawning, no network, no environment mutation at module scope. Constants,
types and function declarations only; every side effect happens inside the extension
factory, in `try/catch`, once.

```ts
// module scope: declarations only
const TOOL_NAME = "example";
const REFUSAL = "example: unavailable"; // a string, not a computation

// the factory does the work
export default function (pi: ExtensionAPI): void {
	try {
		register(pi);
	} catch (error) {
		hookLog("example", "register-failed", { reason: messageOf(error) });
	}
}
```

A read at load is permitted only when it cannot be deferred behind an accessor, and even then
always behind a `try` that produces a refusal value, never a throw. Prefer the accessor: the
read runs on its first call and is memoized to one read per process, so importing the package
performs no I/O and a consumer that never uses the value never touches the store —
`loadTariff()` in `@tinoy/pi-tariff` reads the configured table on its first call and answers
`{ ok: false, reason }` when the file is missing or shaped wrong, while the module body stays
declarations only.

## R2 — Static imports only for what is guaranteed

Guaranteed, and therefore imported statically: node builtins, the package's own modules,
`@tinoy/pi-ext-lib`, `@tinoy/pi-focus-state` / `@tinoy/pi-tariff` where used, and the
pi-supplied packages declared as `"*"` peers.

Optional, and therefore resolved with `optionalNeighbour`: any third-party pi package,
any external binary, any store that may not exist.

```ts
import { optionalNeighbour } from "@tinoy/pi-ext-lib";

const rpiv = await optionalNeighbour(
	"@juicesharp/rpiv-todo",
	() => import("@juicesharp/rpiv-todo/state/state-reducer.js"),
	{
		source: "todo-parent",
		effect: "the child-to-parent todo relay cannot apply a mutation",
		hint: "pi install npm:@juicesharp/rpiv-todo",
	},
);
if (!rpiv) return refusal("todo_parent: the rpiv-todo state reducer is not installed");
```

`optionalNeighbour(neighbour, load, report)` never throws, resolves each
`(source, neighbour)` pair once per process, and emits exactly one `neighbour-absent`
line per absent pair. `report.source` is the reporting package as it appears in the
diagnostics log; `report.effect` is what is lost, in one clause; `report.hint` is the
install command or setting that restores it.

Declare the neighbour in `package.json` as an optional peer:

```json
{
	"peerDependencies": { "@juicesharp/rpiv-todo": "*" },
	"peerDependenciesMeta": { "@juicesharp/rpiv-todo": { "optional": true } }
}
```

Do not bundle it: a bundled copy would ship a second extension registration, and the
subset rule needs absence to be survivable rather than impossible.

## R3 — A missing neighbour is reported by name; it is never thrown

One line per distinct condition per process, on the shared diagnostics envelope:

```ts
hookLog("fleet", "neighbour-absent", {
	neighbour: "@tinoy/pi-canon",
	effect: "the foreman discipline section is not appended to the system prompt",
	hint: "pi install npm:@tinoy/pi-canon",
});
```

`optionalNeighbour` emits that line for you; call `hookLog` directly only for a condition
the helper cannot see (a capability probed at call time, an unavailable service).

A surface the model can call says the same thing in prose and marks failure explicitly —
it never returns an empty success and never a bare `null`:

```ts
return {
	content: [{ type: "text", text: `${TOOL_NAME}: unavailable — ${reason}` }],
	details: { ok: false },
};
```

Silent-by-design cases are only these: an extension that is inert without its marker
(a child-only extension in a parent session), and a pure enrichment listener that
subscribes to an event a package may never emit.

## R4 — Register only tool names you own

A duplicate tool name is a loader error row for the later registrant, and the first owner
keeps the name. Therefore:

- register no name another package could own (audit the suite's names before adding one);
- when a feature cannot work without an absent neighbour, register **nothing** for it and
  answer its refusal at call time — preferred — or register the tool and refuse; never
  register a name that shadows a neighbour's;
- if two packages must legitimately offer the same name, the pairing is documented as a
  conflict caveat in both READMEs, because installing both is a user error the loader
  reports.

## R5 — Touch the active tool set only through your own name

```ts
const active = pi.getActiveTools();
if (!active.includes(TOOL_NAME)) return; // nothing to do
pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
```

Never `setActiveTools([...fixedList])`: a foreign list reaches the provider, activates
names no extension registered, and changes the cached prompt prefix. A session-level tool
set that genuinely must be narrowed is filtered against the registered set first, and
every dropped name is reported once by name.

## R6 — Shared state, locks and claims have ONE owner that exports the paths

Paths under a shared store (claims, locks, rosters, ledgers) are computed only inside the
package that owns the store, and exported as a helper. Consumers import the helper, never
a path literal, so relocating the store is one edit.

Absence of the store means "this process is not a member": report it and skip the write.
Never create the tree, never fall back to a second location, never take a lock you cannot
name. A declared degraded location chosen by the owner and logged is acceptable; an
implicit one is not.

## R7 — Event and hook seams are one-way and order-free

- Publishers never require a subscriber: emitting an event no package listens to changes
  nothing.
- Subscribers are idempotent and tolerate a publisher that never appears.
- Where ordering could change bytes, mutate the payload in place and return `undefined`:
  two handlers that each strip and re-append produce order-dependent prompt bytes.
- Cross-extension handoff crosses the event bus, never a module import. Extensions are
  evaluated in separate module instances, so an imported registry would be a second,
  empty instance with no error and no log.

## R8 — Machine-bound capability is a call-time refusal, always by name

A capability that depends on this machine (a desktop bus, a vault, a notification daemon,
a systemd unit, an external binary, a dataset) is probed when it is used, never at load,
and its absence answers a refusal carrying the reason and the fix.

```ts
const capability = probeCapability();
if (!capability.ok) return refusal(`${TOOL_NAME}: ${capability.reason}`);
```

Nothing refuses at load time: a missing capability costs the one action, not the
extension.

## R9 — Declaring a caveat

A caveat is a neighbour that makes a package better without being required. Two carriers,
one source of truth.

**README, mandatory when the package has any caveat.** A `## Works better with` section
holding exactly one table with these four columns, in this order and spelling:

```markdown
## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `@tinoy/pi-command-guard` | the blocked-call counter in the footer | the counter stays at zero and no row is rendered | `pi install npm:@tinoy/pi-command-guard` |
```

One row per caveat; the neighbour cell names exactly one package; the gain and loss cells
are non-empty; the install cell is a `pi install npm:<name>` command or the literal
`not a package` when the neighbour is a setting rather than a package. A package with no
caveat states none — no empty table, no section.

**Machine-readable mirror, gated.** A `caveats` array inside the `pi` object
(`[{ "neighbour": "@tinoy/pi-canon", "gains": "the discipline section reaches the system
prompt" }]`) may be declared only once an unknown key inside `pi` is known to be ignored
by the loader rather than rejected (matrix case M10). Until then `scripts/check-caveats.mjs`
validates the README half only and reports the gated half as pending.

## Checking a package before it lands

```bash
npm run typecheck                                    # the workspace program
npm run lint                                         # biome
node scripts/check-caveats.mjs                       # the caveat declarations
node --experimental-strip-types packages/ext-lib/src/neighbour.probe.ts
```

Load the package through pi's own loader in a scratch prefix (no install, no session):
point `PI_CODING_AGENT_DIR` at a scratch directory and pass the package's `pi.extensions`
entry to `DefaultResourceLoader` — the shape `docker/smoke.mjs` uses. A clean package
loads with zero loader errors, and a missing neighbour appears only as a
`neighbour-absent` line.
