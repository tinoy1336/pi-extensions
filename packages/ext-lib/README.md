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
| `clip(text, max?)` | `tool-header.ts` | flatten whitespace and clip to `max` characters with an ellipsis |
| `argText(args, key)` / `argNumber(args, key)` | `tool-header.ts` | a non-empty trimmed string argument / a finite numeric argument, else `undefined` |
| `renderToolHeader(theme, name, parts?)` | `tool-header.ts` | the duck-typed one-line header component (`render(width)` + `invalidate()`) a tool's `renderCall` returns |
| `safeToolHeader(theme, name, build)` | `tool-header.ts` | `renderToolHeader` behind a guard: a throwing `build` degrades to the name alone |
| `HeaderTheme`, `HeaderComponent`, `HeaderPart` | `tool-header.ts` | the header types |
| `PROMPT_APPEND_SEP` | `system-prompt.ts` | the separator between a base system prompt and an appended block |
| `canonicalSystemPrompt(systemPrompt, block)` | `system-prompt.ts` | the one canonical form of the system prompt — base + separator + block, appended exactly once at the end, whatever run-start path built it |
| `systemPromptSlot(payload)` | `system-prompt.ts` | read/write access to a provider payload's system-prompt slot, or `null` for a payload shape that carries none |

## What is deliberately not here

Anything that carries one extension's policy stays in that extension. From the
prompt seam in `packages/canon`, the tail-section registry (`setTailSection`,
`registeredSectionIds`) was left out: it owns canon's `canon:section` /
`canon:sections` event contract, logs under the `canon` source, and its 16 KiB
section cap is canon's. `canonicalSystemPrompt`, `systemPromptSlot`,
`PROMPT_APPEND_SEP` are policy-free and live here.

## Dependencies

Node builtins only (`node:fs`, `node:os`, `node:path`). No pi package is
imported, so this package declares no peer dependency.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
