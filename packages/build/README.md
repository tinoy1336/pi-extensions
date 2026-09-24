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
`node_modules` or a bundle output tree. The store that holds those roots belongs to the
io-guard package (`@tinoy/pi-io-guard` — `ioRoot()` in `claims.ts`, `identityHolder()` in
`identity.ts`), and this package reaches it through a guarded dynamic import resolved on the
first build call — never at load.

Without that package the tool still works: the build runs with the session's own environment and
its log goes to `/tmp/pi-build-logs`, and the absence is reported once by name on the diagnostics
log, with the install hint. `@tinoy/pi-io-guard` is declared as an optional peer, so npm never
installs it for you and never fails because it is missing.

## Works better with

| Neighbour | You gain | You lose without it | Install |
| --- | --- | --- | --- |
| `@tinoy/pi-io-guard` | a crew worker's build runs against its own output, cache and temp tree, which no other worker shares | every build runs in the shared session environment and its log lands under `/tmp/pi-build-logs` | `pi install npm:@tinoy/pi-io-guard` |

## Caveats

One soft neighbour: `@tinoy/pi-io-guard`, described under "Crew isolation" above and declared
in the table.

## Dependencies

pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`) are peer dependencies with a `*` range and are
never bundled. `@tinoy/pi-io-guard` is an optional peer. Plain dependencies: `@tinoy/pi-ext-lib`.

## Licence

MIT — see the repository [LICENSE](../../LICENSE).
