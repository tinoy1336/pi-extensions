> [!WARNING]
> **Do not install anything here yet.**
>
> This is a fast-moving prototype: the interfaces change without notice, and nothing here
> is stable. Every package in this project is headed for a stable 1.0, but that is still
> some way off. Install one only if you intend to follow the code and expect breakage.

# @tinoy/pi-cli-keys

Hydrate provider API keys into the session environment from a local cache.

```bash
pi install npm:@tinoy/pi-cli-keys
```

## What it needs at call time

The machine's own `cli-keys`-style script and its cache: hydration runs at session start, on the explicit command, and on a cache change, never at module evaluation. The script is found through `CLI_KEYS_SCRIPT` (default `~/.local/bin/cli-keys`), and it answers for its own cache path.

## Registers

no tool

## Behaviour

On a cache change the watch reports the cache's own DIRECTORY rather than the file, because the
fetch commits a new generation by renaming a temp file over the cache and an event on the replaced
inode ends the watch. The process then re-reads the generation it finds there without running a
fetch of its own, so a rotation another writer made reaches a running session.

The watch is unreferenced: it reports events for as long as the process runs, and it is never the
reason a process keeps running. A scripted run that has printed its answer therefore exits instead
of waiting inside the watcher. `index.probe.ts` asserts both halves in a real child process — the
new generation arrives, and the child drains on its own.

## Caveats

No caveat rows declared: this unit's only soft dependency is machine capability, named above, and it refuses by name rather than failing to load.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`) are peer dependencies with a `*` range and are never
bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
