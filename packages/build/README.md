# @tinoy/pi-build

Run a build, compile, lint or typecheck command with bounded output, and report the exit code, the error lines and the log path.

```bash
pi install npm:@tinoy/pi-build
```

## What it needs at call time

a shell and the toolchain the command itself uses. Nothing is probed at load, and an unknown
command is the command's own failure, reported with its exit code.

## Registers

`build`

## Crew isolation

A crew worker's build runs against that worker's own output, cache and temporary directories,
exported into the spawned environment so two workers never contend on `target/`,
`node_modules` or a bundle output tree. The store that holds those roots belongs to the fleet
package (`@tinoy/pi-fleet`, its `ioRoot()` and `identityHolder()`), and this package reaches it
through a guarded dynamic import resolved on the first build call — never at load.

Without that package the tool still works: the build runs with the session's own environment and
its log goes to `/tmp/pi-build-logs`, and the absence is reported once by name on the diagnostics
log, with the install hint. `@tinoy/pi-fleet` is declared as an optional peer, so npm never
installs it for you and never fails because it is missing.

When the fleet package ships in this repository, this relationship moves into a
`## Works better with` row like every other soft neighbour.

## Caveats

No caveat rows declared in table form yet: the one soft neighbour this package has is
`@tinoy/pi-fleet`, described under "Crew isolation" above, and its row joins the four-column table
when that package lands in this repository (`scripts/check-caveats.mjs` requires a
`@tinoy/pi-*` caveat neighbour to exist as a workspace package).

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies with a `*` range and are
never bundled. `@tinoy/pi-fleet` is an optional peer. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
