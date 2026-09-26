> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-status-metrics

Session counters in pi's footer: tool calls blocked, anchors injected, bytes kept out of context, actions queued by focus mode.

```bash
pi install npm:@tinoy/pi-status-metrics
```

## What it needs at call time

nothing at load. The counters are read from the shared hook log when the footer renders, and a
counter whose source extension is absent stays at zero — the log path and the focus-ledger path
are both resolved at use time, and an unreadable one is "no rows", never an error.

## Registers

no tool — a footer renderer on `session_start`, `tool_result` and `message_end`.

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `@tinoy/pi-command-guard` | the blocked-call counter (`fa-ban`) | the counter stays at zero and its row is never rendered | `pi install npm:@tinoy/pi-command-guard` |
| `@tinoy/pi-read-staleness` | the repeat-read elision counter (`fa-recycle`, in bytes kept out of context) | that counter stays at zero and its row is never rendered | `pi install npm:@tinoy/pi-read-staleness` |

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`) are peer dependencies with a `*` range and are
never bundled. Plain dependencies: `@tinoy/pi-ext-lib`, `@tinoy/pi-focus-state`.

Two further counters read rows written by other extensions of this suite (`focus-gate`, which owns
the focus state file and writes the queued-action ledger; `drift-anchor`, which writes the anchor
rows). Those rows are selected by the source name each extension writes, so an extension that is not
installed contributes nothing and its counter stays at zero.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
