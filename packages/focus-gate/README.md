# @tinoy/pi-focus-gate

Machine-global focus mode: while it is on, sessions work but cannot touch the desktop.

```bash
pi install npm:@tinoy/pi-focus-gate
```

## What it needs at call time

`$XDG_RUNTIME_DIR` for the state file and the per-session ledgers; the rule table names AGS, Hyprland, `grim` and the `inject` wrapper, and each refusal names the tool it refused.

## Registers

no tool

## Caveats

No caveat rows declared: this unit's only soft dependency is machine capability, named above, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`) are peer dependencies with a `*` range and are never
bundled. Plain dependencies: `@tinoy/pi-ext-lib`, `@tinoy/pi-focus-state`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
