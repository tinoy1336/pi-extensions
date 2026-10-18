# AGENTS.md — pi-extensions

An npm workspace of pi extensions plus the small libraries they build on. Every package
under `packages/` is published to npm and installed on its own; nothing in a package may
assume another package of this workspace is present, with the exception of the three
libraries (`@tinoy/pi-ext-lib`, `@tinoy/pi-focus-state`, `@tinoy/pi-tariff`), which are
declared dependencies and are installed by npm.

Sources are shipped raw: no package has a build step, `main`/`exports` point at the
TypeScript file, and `engines.node` is `>=22` throughout. `tsconfig.base.json` is the
compiler contract: strict, `noEmit`, `moduleResolution: Bundler`, `verbatimModuleSyntax`,
`allowImportingTsExtensions` — so relative imports carry the `.ts` extension.

## Commands

The `check` job of `.github/workflows/ci.yml` is these five, in this order:

```bash
npm ci                # workspace links: @tinoy/* packages and the pi libraries
npm run typecheck     # tsc --noEmit -p tsconfig.json over every package
npm run lint          # biome check .
npm run check:pack    # the exact published file list of each package
npm run check:caveats # the README caveat rows a package declares
npm run check:probes  # scripts/check-probes.sh: every package probe, one timeout each
```

Three further jobs run surfaces the workspace gates do not read:

```bash
bash test-rigs/canon-prefix/ci.sh        # 5 harnesses over the system-prompt seam
bash packages/deepseek-cost/rig/run.sh   # the footer label helpers, 44 checks
npm run smoke                            # stranger install in a container (needs docker)
npm run smoke:local                      # the same harness against the same tarballs, no container
npm run smoke:matrix                     # the subset matrix, container; --local, --case ID
```

A check step's status must be read from its exit code, not from a pipe: the probes and
rigs stream their own output.

## Package anatomy

| File | Contract |
| --- | --- |
| `index.ts` | the entry pi loads; `package.json` `main` and `pi.extensions` name it |
| `index.probe.ts` | the executable check that lives beside it — see below |
| `package.json` | `files` is the published list and `check:pack` compares it exactly, so a new source file must be added there; pi-supplied imports (`@earendil-works/pi-coding-agent`, `typebox`, `@juicesharp/rpiv-todo`) are peer dependencies with a `*` range; `@tinoy/*` dependencies use `*` too |
| `README.md` | carries `## What it needs at call time`, `## Registers`, `## Works better with` (when a caveat exists), `## Caveats`, `## Dependencies`, `## Licence`; `check:caveats` enforces the `## Works better with` table's shape and that every backticked `@tinoy/pi-*` neighbour resolves in this workspace |
| `LICENSE` | MIT, identical in every package |

The libraries (`ext-lib`, `focus-state`, `tariff`) expose their modules from `src/` or a
sibling `.ts` file and set `pi.extensions: []`; an extension package sets
`pi.extensions: ["./index.ts"]`.

## The check surfaces

`scripts/check-probes.sh` holds the list of probes and runs each with
`node --experimental-strip-types` under `PROBE_TIMEOUT` (default 120 s). A probe:

- sets `XDG_RUNTIME_DIR` and `HOME` into a scratch directory **before importing** its
  module, because paths are computed at import — no probe reads or writes the machine's
  own agent tree, runtime directory or diagnostics log;
- drives the extension the way pi does (a recorder registered through the API, the
  captured handler invoked), so the module under test is the real one;
- exits non-zero on any failed check, and the runner reports a timeout as its own row.

A new probe must be added to the `PROBES` array; the runner aborts if the list and the
tree disagree. Packages with no probe are named in that script's header with what they
would need: `sudo-approve` (a live promptd window and root), `todo-parent` (a parent
session and the rpiv-todo reducer); `deepseek-cost` has a rig instead.

The rigs follow the same exit-code discipline: `0` pass, `1` a failed check, `2` a
precondition was unmet (no node, no module under test) — `2` must never be read as a
pass. `test-rigs/canon-prefix/run.sh` accepts `RIG_MUTATE=<name>` to run a harness
unmuted-but-broken; a mutated run must exit non-zero.

## Adding a package

1. `packages/<name>/` with `index.ts`, `README.md`, `LICENSE`, `package.json`; the
   `workspaces: ["packages/*"]` glob links it without an edit to the root manifest.
2. A probe beside the entry, added to `PROBES` in `scripts/check-probes.sh`.
3. `release/<name>.mjs`, copied from a sibling (semantic-release configuration, one file
   per package); `RELEASING.md` describes the flow.
4. A row in the root `README.md` Install table.
5. A matrix case in `docker/matrix.json` when the package should be covered by the
   subset matrix; a case is judged on five clauses (load errors, entries loaded, tool
   sets, declared absences, registration failures) and the file's `$comment` states them.

## Gotchas

- `check:pack` compares `files` against what actually lands in the tarball: a source file
  that is not listed is silently absent from the published package, and CI fails.
- `.probe-prefix/` is a probe scratch prefix that carries symlinks out of the repository;
  it is gitignored so neither git nor biome follows them.
- `npm run prepare` sets `core.hooksPath` to `.githooks`, and `.githooks/commit-msg` runs
  the workspace-local commitlint, so commits must be Conventional Commits. Commit bodies
  are limited to 100 characters per line.
- The matrix pins `piVersion` and the versions in `requiresInstall`, so a dependent
  release cannot move its verdicts; bump them deliberately.
- Release tags and changelogs are per package (see `RELEASING.md`); the root manifest is
  private and never published.
