# @tinoy/pi-cli-keys

Hydrate provider API keys into the session environment from a local cache.

```bash
pi install npm:@tinoy/pi-cli-keys
```

## What it needs at call time

The machine's own `cli-keys`-style script and its cache: hydration runs at session start, on the explicit command, and on a cache change, never at module evaluation. The script is found through `CLI_KEYS_SCRIPT` (default `~/.local/bin/cli-keys`), and it answers for its own cache path.

## Registers

no tool

## Caveats

No caveat rows declared: this unit's only soft dependency is machine capability, named above, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`) are peer dependencies with a `*` range and are never
bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
