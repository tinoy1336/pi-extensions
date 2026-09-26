> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-child-prompt-freeze

Pin a child session's rewritten system prompt and restore it on any request that arrives without it.

```bash
pi install npm:@tinoy/pi-child-prompt-freeze
```

## What it needs at call time

A child session (a launch marker); inert in a parent.

## Registers

no tool

## Caveats

No caveat rows declared: this unit has no soft dependency on another package in this repository. What it needs beyond its declared dependencies is machine capability, named below, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent` or "none") are peer dependencies with a `*` range and are
never bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
