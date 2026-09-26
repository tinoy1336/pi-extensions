> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-read-staleness

Elide a repeat full-file read: the body of an unchanged file's second read is replaced by a one-line stub.

```bash
pi install npm:@tinoy/pi-read-staleness
```

## What it needs at call time

Nothing: the hook observes results and fails open.

## Registers

no tool

## Caveats

No caveat rows declared: this unit has no soft dependency on another package in this repository. What it needs beyond its declared dependencies is machine capability, named below, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent` or "none") are peer dependencies with a `*` range and are
never bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
