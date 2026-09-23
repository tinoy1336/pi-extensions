# @tinoy/pi-sudo-approve

Run root commands with a user-approved password prompt; audit every batch.

```bash
pi install npm:@tinoy/pi-sudo-approve
```

## What it needs at call time

The desktop approval window (`promptd`) for the primary path, else the TUI/yad fallback; the refusal names which one is missing first. The window is reached through the request router the environment names: `SUDO_APPROVE_ROUTE` when it carries the router's own path, else `TINSHELL_HOME` joined with `common/shell/tinshell-route.sh` inside that checkout. A machine that sets neither gets the refusal by name, never an approval through the fallback.

## Deploying it

The file pi loads at `~/.pi/agent/extensions/sudo-approve.ts` is not this package and carries its own router resolution. A deploy that replaces it with this package's version must also put `SUDO_APPROVE_ROUTE` (or `TINSHELL_HOME`) in the session environment at the same time, or the primary approval path refuses by name instead of drawing a dialog.

## Registers

`sudo_approve`

## Caveats

No caveat rows declared: this unit's only soft dependency is machine capability, named above, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies with a `*` range and are never
bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
