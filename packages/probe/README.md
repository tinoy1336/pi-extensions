# @tinoy/pi-probe

One bounded status probe for a systemd unit, a process, or a hyprctl query.

```bash
pi install npm:@tinoy/pi-probe
```

## What it needs at call time

systemd `--user` and `journalctl` and `pgrep` at call time; `hyprctl` only for the opt-in branch, refused by name when absent.

## Registers

`probe`

## Caveats

No caveat rows declared: this unit has no soft dependency on another package in this repository. What it needs beyond its declared dependencies is machine capability, named below, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox` or "none") are peer dependencies with a `*` range and are
never bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
