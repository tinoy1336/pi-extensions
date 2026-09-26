> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-todo-parent

Give a child session a todo tool whose mutations are applied to the spawning session's todo list, without waking its model.

```bash
pi install npm:@tinoy/pi-todo-parent
```

## What it needs at call time

`@juicesharp/rpiv-todo` (its pure state reducer and branch replay) when a mutation is applied in
the spawning session, and the pi-subagents supervisor-channel layout for the child-to-parent
transport. That package is an OPTIONAL peer: it is reached through a guarded dynamic import, so a
session without it still loads this extension, and the parent side answers a refusal naming the
package and its install line instead of failing. The absence is reported once on the diagnostics
log when this extension loads.

## Registers

`todo_parent`, in a CHILD session (the marker `PI_SUBAGENT_CHILD=1`). The spawning session
registers no tool: it runs the watcher that applies the requests.

## Behaviour

A `todo_parent` call writes a request file into the supervisor channel directory and polls for the
reply, so it is synchronous and bounded by a 15 s timeout. The spawning session appends a
replay-compatible `todo` toolResult row to its own session branch — durable and replay-derivable —
and then emits `rpiv-todo:external-refresh`.

The mutation is on the branch, not in the parent's live store: the installed `rpiv-todo` keeps its
per-session state in a module-private map that no other extension can reach, so the parent's live
`todo` tool and overlay see the entry at their next session start/compact/tree. A parent-side
`todo` write before that appends a row from the stale cached view, which wins the replay and drops
the child's entry. Every reply carries that note.

## Caveats

No caveat rows declared: the neighbour this extension needs is not a nicety, so it is stated under
"What it needs at call time" instead of a "works better with" row.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies with a `*` range and are
never bundled. `@juicesharp/rpiv-todo` is an optional peer. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
