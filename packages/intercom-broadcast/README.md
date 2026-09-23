# @tinoy/pi-intercom-broadcast

Send one message to every connected pi-intercom session.

```bash
pi install npm:@tinoy/pi-intercom-broadcast
```

## What it needs at call time

the `pi-intercom` package and its broker at call time; the tool refuses with a message when the channel is not ready.

## Registers

`broadcast`

## Caveats

No caveat rows declared: this unit has no soft dependency on another package in this repository. What it needs beyond its declared dependencies is machine capability, named below, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent` or "none") are peer dependencies with a `*` range and are
never bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
