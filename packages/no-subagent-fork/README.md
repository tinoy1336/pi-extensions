# @tinoy/pi-no-subagent-fork

Rewrite a subagent spawn's `context: "fork"` to `"fresh"`.

```bash
pi install npm:@tinoy/pi-no-subagent-fork
```

## What it needs at call time

Nothing: with no subagent tool the hook is never reached.

## Registers

no tool

## Caveats

No caveat rows declared: this unit has no soft dependency on another package in this repository. What it needs beyond its declared dependencies is machine capability, named below, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent` or "none") are peer dependencies with a `*` range and are
never bundled. This package has no npm dependencies.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
