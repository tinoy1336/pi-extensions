# @tinoy/pi-pause

Park pi's agent loop until a deadline (or an explicit resume): a paused session issues no
provider request, and a wake that arrives while the pause is active waits instead of being
lost.

```bash
pi install npm:@tinoy/pi-pause
```

## What it needs at call time

A writable runtime directory for the state file, and nothing else: no machine feature is
probed at load, and every failure is fail-open — an unreadable state file reads as not
paused, so a bug here can never strand a session.

## Registers

`/pause`, `/unpause`

`/pause` with no argument pauses until an explicit release. A duration follows the command
(`/pause 45m`): a bare number is minutes, `s`/`m`/`h` name a unit, and suffixed segments
compound (`90s`, `1h30m`). `/pause status` prints the state file and the remaining time;
`/pause off` releases, and `/pause resume`, `/pause on`, `/pause clear`, `/pause none` are
its accepted synonyms. A zero duration clears the pause. `/unpause` is the release verb
under its own name: pi's built-in `/resume` belongs to the session switcher, so a release
command cannot live there. `/pause <duration>` while a pause is active replaces the
deadline in both directions, indefinite included.

## Where the pause lives

`$XDG_RUNTIME_DIR/pi-pause.json` (tmpfs, so a pause never survives a reboot), one record
`{ paused, until, since, rev, by }` rewritten whole by an atomic temp-file-plus-rename.
`PI_PAUSE_STATE` overrides the path for a caller that needs a named file. Every process
that loaded this extension reads the same file and watches it, so a flip in one session
reaches the others and a release applies at once.

The pause is enforced at two boundaries, both awaited by the agent loop: `turn_start`, the
first hook of every turn and every wake source (including a `triggerTurn` wake such as an
intercom delivery, which bypasses `input` entirely), and `before_provider_request`, which
holds a pause set while a turn was already in flight. Nothing is parked mid-batch,
mid-tool-result or mid-stream. A timed pause ends at its deadline with nothing sent to the
session; an indefinite pause is re-evaluated on a ceiling-bounded wait chunk, so it can
only outlive its intent if the state file itself still says paused. `PI_PAUSE_CEILING_MS`
overrides that ceiling (30 minutes).

A park lives in the process, not in the file: `/quit`, Ctrl+D, stdin EOF, SIGTERM and
`ctx.shutdown()` release a parked run in about a second, while Escape and Ctrl+C do not —
the escape hatch for a stuck park is `/quit` or a signal. The footer carries the pause
(`\uf04c` fa-pause and the deadline) in every session that loaded this extension, and
`/pause status` answers in that session alone.

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `subagents.defaultExtensions` | a child session loads pause and parks on the same state file as its parent, instead of continuing to issue requests while the parent is parked | a child session keeps working through the pause — only an interactive session that discovered this extension is held | not a package |

## Caveats

No workspace package is a caveat for this one: nothing in this repository imports or
references the pause extension, and its only package dependency is `@tinoy/pi-ext-lib`.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`) are peer dependencies with a `*`
range and are never bundled. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
