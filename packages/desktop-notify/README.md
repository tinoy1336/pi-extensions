# @tinoy/pi-desktop-notify

Send a desktop notification through the session notification daemon, and notify when a response settles.

```bash
pi install npm:@tinoy/pi-desktop-notify
```

## What it needs at call time

`notify-send` (libnotify) at call time; a session with no daemon gets a refusal naming it.

## Registers

`desktop_notify`

## Caveats

No caveat rows declared: this unit has no soft dependency on another package in this repository. What it needs beyond its declared dependencies is machine capability, named below, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `typebox` or "none") are peer dependencies with a `*` range and are
never bundled. Plain dependencies: `@tinoy/pi-ext-lib`, `@tinoy/pi-focus-state`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
