> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-drift-anchor

Detect reasoning-register drift and re-anchor it with a tail line.

```bash
pi install npm:@tinoy/pi-drift-anchor
```

## What it needs at call time

Nothing: `~/.config/drift-anchor` is read lazily and an absent config means the defaults.

## Registers

`set_anchor`

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `@tinoy/pi-canon` | the anchor texts reference the canon block by name | the anchors still fire, but they name a section that is not in the prompt | `pi install npm:@tinoy/pi-canon` |

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies with a `*` range and are never
bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
