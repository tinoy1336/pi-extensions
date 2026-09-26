> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-cache-prefix-log

One JSONL row per cache-prefix change, so a real cache miss can be named from the log.

```bash
pi install npm:@tinoy/pi-cache-prefix-log
```

## What it needs at call time

A writable state directory (`$XDG_STATE_HOME`, else `~/.local/state`).

## Registers

no tool

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `@tinoy/pi-canon` | the tail-section ids canon publishes are recorded with each row | the rows carry the prefix fingerprint without the section ids | `pi install npm:@tinoy/pi-canon` |

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent` or "none") are peer dependencies with a `*` range and are
never bundled. This package has no npm dependencies.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
