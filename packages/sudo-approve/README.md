# @tinoy/pi-sudo-approve

Run root commands with a user-approved password prompt; audit every batch.

```bash
pi install npm:@tinoy/pi-sudo-approve
```

## What it needs at call time

The AGS promptd window for the primary path, else the TUI/yad fallback; the refusal names which one is missing first.

## Registers

`sudo_approve`

## Caveats

No caveat rows declared: this unit's only soft dependency is machine capability, named above, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies with a `*` range and are never
bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
