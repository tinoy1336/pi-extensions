# @tinoy/pi-command-guard

Block destructive shell commands before they run, and name the safe alternative in the block reason.

```bash
pi install npm:@tinoy/pi-command-guard
```

## What it needs at call time

nothing. The rule tables are data, and every check is a pure function over the tool call's
own text, so the guard works in any session shape. Its block reasons name tools (the grep
tool, the build tool) only when `getActiveTools()` says the calling session has them, and
always carry a shell form that satisfies the rule on its own.

## Registers

no tool — a `tool_call` hook.

## Caveats

No caveat rows declared: this unit has no soft dependency on another package in this repository. It reads the calling session's own tool list, never another package's API, so no neighbour changes what it can do.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`) are peer dependencies with a `*` range and are
never bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
