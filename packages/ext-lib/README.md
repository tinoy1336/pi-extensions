> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-ext-lib

Shared helpers for pi extensions. This package registers nothing with pi — it has
no `pi` manifest and no extension entry — and is consumed as a dependency by
extension packages.

```bash
pi install npm:@tinoy/pi-ext-lib   # installs it; nothing is registered with pi
```

An extension package depends on it through npm:

```json
{ "dependencies": { "@tinoy/pi-ext-lib": "^0.1.0" } }
```

## API

| Export | Module | Purpose |
| --- | --- | --- |
| `hookLog(source, kind, detail?)` | `hook-log.ts` | the one diagnostics envelope: `{ts, proc, sid, source, kind, detail}` per line, JSONL in `~/.local/share/pi-hooks/log.jsonl`. Fail-open — a logging failure never breaks the call that emitted it |
| `HOOK_LOG_PATH` | `hook-log.ts` | that file's path |
| `globOverlap(a, b)` | `glob.ts` | do two path patterns address the same tree: exact match, either side a directory prefix of the other, or a `*` wildcard anywhere in either side |
| `escapeRe(s)` | `glob.ts` | escape every RegExp metacharacter in `s`, so it can be embedded in a pattern |
| `clip(text, max?)` | `tool-header.ts` | flatten whitespace and clip to `max` characters with an ellipsis |
| `argText(args, key)` / `argNumber(args, key)` | `tool-header.ts` | a non-empty trimmed string argument / a finite numeric argument, else `undefined` |
| `renderToolHeader(theme, name, parts?)` | `tool-header.ts` | the duck-typed one-line header component (`render(width)` + `invalidate()`) a tool's `renderCall` returns |
| `safeToolHeader(theme, name, build)` | `tool-header.ts` | `renderToolHeader` behind a guard: a throwing `build` degrades to the name alone |
| `HeaderTheme`, `HeaderComponent`, `HeaderPart` | `tool-header.ts` | the header types |
| `PROMPT_APPEND_SEP` | `system-prompt.ts` | the separator between a base system prompt and an appended block |
| `canonicalSystemPrompt(systemPrompt, block)` | `system-prompt.ts` | the one canonical form of the system prompt — base + separator + block, appended exactly once at the end, whatever run-start path built it |
| `systemPromptSlot(payload)` | `system-prompt.ts` | read/write access to a provider payload's system-prompt slot, or `null` for a payload shape that carries none |
| `optionalNeighbour(neighbour, load, report)` | `neighbour.ts` | resolve an optional neighbour with a guarded dynamic import: never throws, resolves each `(source, neighbour)` pair once per process, and emits one `neighbour-absent` line per absent pair |
| `NeighbourReport` | `neighbour.ts` | what that line carries: the reporting `source`, the lost `effect`, and an install `hint` |
| `ipcRoot()` / `ensureRoot()` | `ipc.ts` | the transport's one rendezvous path, `$XDG_RUNTIME_DIR/pi-ipc`: resolved at call time and refused by name when the runtime directory is unset, is not a directory, or belongs to another user — never a second location. `ensureRoot()` creates the tree 0700 |
| `parsePresence(value)` / `parseEnvelope(value)` | `ipc.ts` | validate a presence record or an envelope, refusing a malformed one by name: envelope version, ISO-8601 timestamps, file-name-safe ids, the namespace pattern, the audience values, and the 32 KiB text cap |
| `writePresence(record)` / `readPeers()` / `sweepStale()` / `peersWithNamespace(ns)` | `ipc.ts` | the presence half: write this session's record, read every peer whose pid is still alive with the start time it wrote, remove the records whose process is gone, and filter by bus namespace |
| `deliver(toId, envelope)` / `drain(id)` | `ipc.ts` | the inbox half: a message lands in a dot-prefixed temp file and is renamed into the target's inbox, so a concurrent drain sees nothing or the whole envelope; `drain` reads and removes what is waiting, oldest first, and names any file it could not parse instead of wedging on it |
| `processStartTicks(pid)` | `ipc.ts` | a process's start time in clock ticks from `/proc/<pid>/stat`, or `null` when no such process runs — the liveness fact a presence record carries, and what makes a reused pid read as dead |
| `IPC_REGISTER_EVENT`, `IPC_REGISTRY_READY_EVENT`, `IPC_NAMESPACE_PATTERN`, `IPC_AUDIENCES`, `IPC_CHANNEL_METHODS`, `IPC_KINDS`, `IPC_TEXT_CAP`, `IPC_ENVELOPE_VERSION` | `ipc.ts` | the bus contract strings and wire limits, spelled once here so an implementation and its consumers cannot drift; plain values, no pi import |
| `IpcPresence`, `IpcEnvelope`, `IpcKind`, `IpcAudience`, `IpcRefusal`, `IpcDone`, `IpcDrainRefusal` | `ipc.ts` | the two record shapes and the result shapes they are read through |

## Degradation contract

[CONTRACT.md](CONTRACT.md) is the normative text every package in this repository
implements: no work and no throw at module scope, optional neighbours resolved through
`optionalNeighbour`, a named `neighbour-absent` line instead of an error, tool names owned
outright, the active tool set touched only through a package's own name, one owner per
shared path, order-free event seams, machine-bound capability refused at call time, and
caveats declared as a README table row (machine-readable mirror gated on the loader
ignoring an unknown `pi` key). Check a package with `node scripts/check-caveats.mjs` and
`node --experimental-strip-types packages/ext-lib/src/neighbour.probe.ts`.

## What is deliberately not here

Anything that carries one extension's policy stays in that extension. From the
prompt seam in `packages/canon`, the tail-section registry (`setTailSection`,
`registeredSectionIds`) was left out: it owns canon's `canon:section` /
`canon:sections` event contract, logs under the `canon` source, and its 16 KiB
section cap is canon's. `canonicalSystemPrompt`, `systemPromptSlot`,
`PROMPT_APPEND_SEP` are policy-free and live here.

The transport in `ipc.ts` is here for the same reason, from the other direction: two
halves of the machine's traffic need one wire — the extension bus and the messages a
model sends by name — so the records, the rendezvous path and the contract strings are
shared, while the tool, its schema, its timers and its refusal texts stay in the
package that offers it. `ipc.ts` therefore holds no pi import, no tool name and no
knowledge of the package on top, and a session with none of those packages installed
still loads every other extension: `ipcRoot()` refuses by name rather than reaching for
a second location.

## Dependencies

Node builtins only (`node:fs`, `node:os`, `node:path`). No pi package is
imported, so this package declares no peer dependency.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
